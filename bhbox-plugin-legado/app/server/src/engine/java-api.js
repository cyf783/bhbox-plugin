// java.* API 子集（对齐 legado JsExtensions 常用面，@js 与 {{}} 模板的上下文注入）
import crypto from 'crypto';
import vm from 'vm';
import { execFileSync } from 'node:child_process';
import { render, runJs, bridgeCipherName } from './template.js';
import { parseUrlRule } from './urlrule.js';
import { decodeBuffer, charsetFromHeader, formEncode, applyPostBody, encodeUrlQuery } from './http.js';
import { analyzeStr, analyzeList, makeContent, elementProxy } from './analyzer.js';

/** 进程内缓存（legado cache.get/put 语义，timeout 为分钟）；经 ctx.cache 注入 JS 沙箱 */
const cacheStore = new Map();

/** 同步抓取子进程脚本：输出 { status, b64, ct, headers }（java.ajax/post 同步化用；POST 不跟随重定向以便读 Location）
 *  注：输出后必须 process.exit(0)——对端 keep-alive 时 undici 连接池 socket 撑住事件循环，进程不退出会拖到 execFileSync 超时 */
const FETCH_SYNC_SCRIPT = `
const [url, hdrs, method, body] = process.argv.slice(1);
fetch(url, {
  method: method || 'GET',
  headers: JSON.parse(hdrs || '{}'),
  body: body ? body : undefined,
  redirect: method === 'POST' ? 'manual' : 'follow',
})
  .then(async (r) => {
    const buf = Buffer.from(await r.arrayBuffer());
    // write 回调里退出：立即 process.exit 会截断未刷完的管道输出（大 payload）
    process.stdout.write(JSON.stringify({
      status: r.status,
      b64: buf.toString('base64'),
      ct: r.headers.get('content-type') || '',
      url: r.url || '',
      headers: Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])),
    }), () => process.exit(0));
  })
  .catch((e) => { process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }), () => process.exit(0)); });
`;

// ---- DES ECB 兼容层：OpenSSL 3 默认 provider 无单 DES（des-ecb/des-cbc 均在 legacy），
// 以 3DES EDE 密钥重合（K1=K2=K3）数学等价单 DES：E(D(E(P))) = E(P)，des-ede3 可用 ----
let _desEcbBlocked = null;
function isDesEcbBlocked(name) {
  if (name !== 'des-ecb') return false;
  if (_desEcbBlocked === null) {
    try { crypto.createCipheriv('des-ecb', Buffer.alloc(8), null); _desEcbBlocked = false; }
    catch { _desEcbBlocked = true; }
  }
  return _desEcbBlocked;
}

/** des-ede3（24 字节密钥三段重合）等价单 DES ECB；PKCS5 外层手动处理，autoPadding 关闭 */
function desEcbViaEde3(buf, key8, encrypt) {
  const k24 = Buffer.concat([key8, key8, key8]);
  const c = encrypt
    ? crypto.createCipheriv('des-ede3', k24, null)
    : crypto.createDecipheriv('des-ede3', k24, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]);
}

function pkcs5Pad(buf) {
  const pad = 8 - (buf.length % 8);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs5Unpad(buf) {
  if (!buf.length) return buf;
  const pad = buf[buf.length - 1];
  if (pad >= 1 && pad <= 8 && buf.length >= pad && buf.subarray(buf.length - pad).every((b) => b === pad)) {
    return buf.subarray(0, buf.length - pad);
  }
  return buf;
}

/** DES 密钥定长 8 字节（短补零、长截断——Java DESKeySpec 取前 8 字节语义） */
function normDesKey(name, keyBuf) {
  if (!name.startsWith('des-') || keyBuf.length === 8) return keyBuf;
  const out = Buffer.alloc(8);
  keyBuf.copy(out, 0, 0, Math.min(8, keyBuf.length));
  return out;
}

export const cache = {
  get(key) {
    const it = cacheStore.get(String(key));
    if (!it) return null;
    if (it.ttl && Date.now() > it.at + it.ttl * 60_000) { cacheStore.delete(String(key)); return null; }
    return it.v;
  },
  put(key, value, timeoutMinutes = 0) {
    cacheStore.set(String(key), { v: value == null ? '' : value, at: Date.now(), ttl: Number(timeoutMinutes) || 0 });
    return value == null ? '' : value;
  },
  putMemory(key, value, timeoutMinutes = 0) { return cache.put(key, value, timeoutMinutes); },
  getFromMemory(key) { return cache.get(key); },
  delete(key) { cacheStore.delete(String(key)); },
};

/** 清空 JS 沙箱缓存（书源 reload 时调用） */
export function clearCache() { cacheStore.clear(); }

/**
 * 创建 java 上下文对象。
 * @param {object} c { source, book, baseUrl, vars: Map 变量池, key, page, result, getApi() }
 *   getApi: 延迟取「当前请求视角」的 java 对象（模板在规则执行链中被复用时保持上下文一致）
 */
export function createJavaApi(c) {
  const vars = c.vars instanceof Map ? c.vars : new Map();

  // source 增强：legado BaseSource 方法/属性模拟——社区源 JS 高频
  // `source.key`（getKey 属性形态，如 u=source.key 拼 ajax）、source.name/tag/comment/loginUrl
  const source = c.source || {};
  if (source && typeof source === 'object' && !source.getKey) {
    try {
      source.getKey = () => source.bookSourceUrl || '';
      source.getTag = () => source.bookSourceName || source.bookSourceGroup || '';
      source.getComment = () => source.bookSourceComment || '';
      source.getLoginHeader = () => source.loginUi || '';
      source.key = source.bookSourceUrl || '';
      source.name = source.bookSourceName || '';
      source.tag = source.bookSourceName || source.bookSourceGroup || '';
      source.comment = source.bookSourceComment || '';
      source.loginUrl = source.loginUrl || '';
      source.loginHeader = '';
    } catch { /* 只读对象时忽略 */ }
  }

  const java = {
    // ---- 网络请求 ----
    // legado evalJS 同步阻塞，源脚本常见 java.ajax(url).match(...) 链式写法 → ajax 必须同步返回字符串。
    // Node 无同步 HTTP，经子进程 fetch（输出 base64）+ 父进程按 charset 解码；await 同步串仍合法。
    ajax(url) {
      const rendered = render(String(url), currentCtx());
      try {
        // URL 尾部 ,{...} options（JS 源拼的 headers/method/body）需拆出合并——如七猫
        // `java.ajax(url+','+java.get("headers"))` 的 App 签名头全在 options 里
        const { url: u, options } = parseUrlRule(rendered);
        const merged = { ...defaultHeaders(), ...(options.headers || {}) };
        // POST 走 legado configureRequest 同款三分支（form 编码/CT 补全），与 fetchText 一致
        const method = options.method || 'GET';
        const postBody = method === 'POST' ? applyPostBody('POST', options.body ?? '', merged, options.charset) : undefined;
        // legado encodeUrlParams isQuery=true：GET query 按 charset 编码（gbk 搜索关键字）
        const finalUrl = method === 'POST' ? u : encodeUrlQuery(u, options.charset);
        const out = execFileSync(process.execPath, ['-e', FETCH_SYNC_SCRIPT, finalUrl,
          JSON.stringify(merged), method, String(postBody ?? '')], { timeout: 30000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf-8' });
        const j = JSON.parse(out.trim());
        if (j.error) throw new Error(j.error);
        const buf = Buffer.from(j.b64, 'base64');
        if (j.status >= 400 && buf.length === 0) throw new Error('HTTP ' + j.status + ' for ' + u.slice(0, 100));
        return decodeBuffer(buf, options.charset || charsetFromHeader(j.ct));
      } catch (e) {
        console.warn(`java.ajax failed [${rendered.slice(0, 80)}]: ${e.message}`);
        return '';
      }
    },
    /** legado post(url, body, headers)：同步 POST，返回 StrResponse 形态（body()/header()/code()） */
    post(url, body, headers) {
      return syncFetch(render(String(url), currentCtx()), 'POST', body, headers);
    },
    /** 批量抓取 → StrResponse 数组（legado Array<StrResponse>：body()/code()/header()/url()，字符串拼接自动拆箱） */
    ajaxAll(...urls) {
      return urls.flat().map((u) => {
        const rendered = render(String(u), currentCtx());
        try {
          const { url: uu, options } = parseUrlRule(rendered);
          return syncFetch(uu, options.method || 'GET', options.body ?? '', options.headers || {});
        } catch (e) {
          console.warn(`java.ajaxAll failed [${rendered.slice(0, 80)}]: ${e.message}`);
          const carrier = new String('');
          return Object.assign(carrier, { code: () => 0, body: () => '', header: () => '', headers: {}, url: () => rendered });
        }
      });
    },
    /** 同 ajax，返回 { body } 形态（legado connect 语义简化） */
    connect(url) {
      return { body: java.ajax(url) };
    },

    // ---- 规则执行（legado AnalyzeRule.getString：JS 内对当前内容执行规则）----
    // legado 语义：getString 默认对根内容（AnalyzeRule setContent 的整页内容）求值，
    // 而非当前 result——JS 混排段执行时 result 是前段输出（如列表子树），社区源高频
    // `java.getString('$.data.xxx')` 从整页 JSON 取字段（如阿巴 chapterList JS 段取前缀）。
    // root 由 analyzer runJsRule 注入（本次规则求值的根 repr）；缺省回退 result（URL 构建
    // 等无 root 场景，行为不变）。
    getString(ruleStr, mContent) {
      const cc = currentCtx();
      const base = mContent != null ? mContent : (cc.root ?? cc.result ?? '');
      const repr = base && typeof base === 'object' && base.kind ? base : makeContent(base);
      return analyzeStr(repr, String(ruleStr || ''), cc);
    },
    getStringList(ruleStr, mContent) {
      const cc = currentCtx();
      const base = mContent != null ? mContent : (cc.root ?? cc.result ?? '');
      const repr = base && typeof base === 'object' && base.kind ? base : makeContent(base);
      const rule = String(ruleStr || '');
      // legado AnalyzeByXPath.getStringList：xpath 方言整条求值（属性节点 getNodeText 取
      // value，元素取 textContent），不走 JSoup 方言的 @ 切段——误拆 '/a/@href' 会留下
      // 孤立 '/' 报 XPath parse error（八叉书库 nextTocUrl）
      if (/^@xpath:/i.test(rule) || rule.startsWith('/')) {
        return String(analyzeStr(repr, rule, cc) || '').split('\n').filter((s) => s !== '');
      }
      // legado AnalyzeByJSoup.getStringList → getResultList：按 @ 切段，前段依次选元素、
      // 末段 getResultLast 取值（如 nextTocUrl 'id.next@href' 得 ['/toc/2']）。带取值尾巴的
      // 规则与 analyzeList 的「元素列表」语义不同——analyzeList 对取值尾巴返回空
      const at = /^@js:|^<js>/i.test(rule) ? -1 : rule.lastIndexOf('@');
      if (at > 0) {
        const els = analyzeList(repr, rule.slice(0, at), cc);
        const tail = rule.slice(at + 1);
        return els.map((el) => {
          const v = analyzeStr(el, tail, cc);
          return v == null ? '' : String(v);
        });
      }
      const out = analyzeList(repr, rule, cc);
      return out.map((repr) => {
        const v = repr && repr.kind === 'text' ? repr.text : (repr && repr.raw != null ? repr.raw : '');
        return v == null ? '' : String(v);
      });
    },
    /** legado JsExtensions.getElements(ruleStr)：对当前内容执行规则取元素列表（元素代理可续取 text/attr） */
    getElements(ruleStr, mContent) {
      const cc = currentCtx();
      const base = mContent != null ? mContent : (cc.root ?? cc.result ?? '');
      const repr = base && typeof base === 'object' && base.kind ? base : makeContent(base);
      return analyzeList(repr, String(ruleStr || ''), cc).map((r) => elementProxy(r, cc));
    },

    // ---- 变量池 ----
    // put 返回 value（legado AnalyzeUrlCore.put: String）：社区源依赖返回值拼 URL options
    // 尾巴（如七猫 `"," + java.put("headers", JSON...)` 生成 ,{...} 请求头段）
    put(key, value) { vars.set(String(key), value); return value; },
    /** 变量池 get；URL + headers 对象时走 legado JsExtensions.get（同步 HTTP GET → StrResponse） */
    get(keyOrUrl, def = '') {
      if (typeof keyOrUrl === 'string' && keyOrUrl.includes('://') && (def == null || typeof def === 'object')) {
        return syncFetch(render(String(keyOrUrl), currentCtx()), 'GET', '', def);
      }
      const v = vars.get(String(keyOrUrl));
      return v === undefined ? def : v;
    },

    // ---- 上下文 ----
    /** 当前请求 baseUrl */
    baseUrl() { return c.baseUrl || c.source?.bookSourceUrl || ''; },
    setContent(v, key) { vars.set('__content_' + (key || ''), v); },
    getContent(key) { return vars.get('__content_' + (key || '')) ?? null; },
    /** legado 元素对象无对应实现，返回原始内容文本 */
    getElement() { return c.result ?? null; },
    getSource() { return source; },
    getBook() { return c.book || {}; },

    // ---- 编码/格式化 ----
    /** legado encodeURI(str, enc)：全字符百分号编码（unreserved 保留，空格 → +），enc 支持指定字符集 */
    encodeURI(str, enc) {
      const s = String(str ?? '');
      const cs = enc ? String(enc).toLowerCase() : 'utf-8';
      try { return formEncode(s, cs); } catch { return encodeURIComponent(s); }
    },
    urlEncode(str, enc) { return java.encodeURI(str, enc); },
    urlDecode(str) { return java.utf8Decode(str); },
    timeFormatUTC(ms, fmt, sh = 0) {
      const t = new Date((ms ? Number(ms) : Date.now()) + (Number(sh) || 0) * 3600_000);
      const p = (n) => String(n).padStart(2, '0');
      const s = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
      if (!fmt) return s;
      return fmt
        .replace(/yyyy/g, t.getUTCFullYear())
        .replace(/MM/g, p(t.getUTCMonth() + 1))
        .replace(/dd/g, p(t.getUTCDate()))
        .replace(/HH/g, p(t.getUTCHours()))
        .replace(/mm/g, p(t.getUTCMinutes()))
        .replace(/ss/g, p(t.getUTCSeconds()));
    },

    // ---- 工具 ----
    // legado JsExtensionsCommon.log：打印后 return msg（社区源依赖 java.log(x) 的返回值
    // 作为 JS 规则结果出口，如八叉书库 ruleContent 的 java.log(content)）
    log(...args) {
      console.log('[java.log]', ...args);
      return args.length === 1 ? args[0] : args.map(String).join(' ');
    },
    /** 空实现：需要 WebView 的能力在本插件不可用 */
    toast() {},
    longToast() {},
    startBrowser() { return ''; },
    startBrowserAwait() { return { html: '', url: '' }; },

    timeFormat(ms, fmt) {
      const t = ms ? new Date(ms) : new Date();
      const p = (n) => String(n).padStart(2, '0');
      const s = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
      if (!fmt) return s;
      return fmt
        .replace(/yyyy/g, t.getFullYear())
        .replace(/MM/g, p(t.getMonth() + 1))
        .replace(/dd/g, p(t.getDate()))
        .replace(/HH/g, p(t.getHours()))
        .replace(/mm/g, p(t.getMinutes()))
        .replace(/ss/g, p(t.getSeconds()));
    },

    /** UTF-8 百分号解码 */
    utf8Decode(str) {
      if (!str) return '';
      try { return decodeURIComponent(String(str)); } catch { return String(str); }
    },

    /** hex↔字符串（legado JsExtensionsCommon：hexDecodeToString/hexEncodeToString）
     *  配合 data: URL 章节（响应体为 hex，正文 JS 解码还原 JSON 载荷） */
    hexDecodeToString(hex) {
      const s = String(hex ?? '').trim();
      if (!s || s.length % 2 || !/^[0-9a-fA-F]+$/.test(s)) return null;
      return Buffer.from(s, 'hex').toString('utf-8');
    },
    hexEncodeToString(utf8) { return Buffer.from(String(utf8 ?? ''), 'utf-8').toString('hex'); },

    // ---- 散列/对称加密（上游 legado JsExtensions 常用面，如阅友签名链）----
    /** HMacHex(data, algorithm, key)：散列消息鉴别码 → 小写 hex（algorithm 如 HmacMD5/HmacSHA256） */
    HMacHex(data, algorithm, key) {
      const alg = String(algorithm ?? '').toLowerCase().replace(/^hmac-?/, '');
      return crypto.createHmac(alg, String(key ?? '')).update(String(data ?? ''), 'utf-8').digest('hex');
    },
    HMacBase64(data, algorithm, key) {
      const alg = String(algorithm ?? '').toLowerCase().replace(/^hmac-?/, '');
      return crypto.createHmac(alg, String(key ?? '')).update(String(data ?? ''), 'utf-8').digest('base64');
    },
    randomUUID() { return crypto.randomUUID(); },
    /** desEncodeToBase64String(data, key, transformation, iv)：DES/AES 加密 → base64（上游 desEncodeToBase64String 语义） */
    desEncodeToBase64String(data, key, transformation, iv) {
      const keyBuf = Buffer.from(String(key ?? ''), 'utf-8');
      const name = bridgeCipherName(transformation, keyBuf.length * 8);
      const ivBuf = iv ? Buffer.from(String(iv), 'utf-8') : null;
      const src = Buffer.from(String(data ?? ''), 'utf-8');
      if (isDesEcbBlocked(name)) {
        return desEcbViaEde3(pkcs5Pad(src), normDesKey(name, keyBuf), true).toString('base64');
      }
      const c = crypto.createCipheriv(name, normDesKey(name, keyBuf), ivBuf);
      return Buffer.concat([c.update(src), c.final()]).toString('base64');
    },
    /** desDecodeToString(data, key, transformation, iv)：base64 密文解密 → utf-8 字符串 */
    desDecodeToString(data, key, transformation, iv) {
      const keyBuf = Buffer.from(String(key ?? ''), 'utf-8');
      const name = bridgeCipherName(transformation, keyBuf.length * 8);
      const ivBuf = iv ? Buffer.from(String(iv), 'utf-8') : null;
      const src = Buffer.from(String(data ?? ''), 'base64');
      const out = isDesEcbBlocked(name)
        ? desEcbViaEde3(src, normDesKey(name, keyBuf), false)
        : (() => {
            const d = crypto.createDecipheriv(name, normDesKey(name, keyBuf), ivBuf);
            return Buffer.concat([d.update(src), d.final()]);
          })();
      return pkcs5Unpad(out).toString('utf-8');
    },

    /** base64 编解码：无参=当前 result 编码；传参=编码入参 */
    base64(str) {
      const v = str === undefined ? (c.result ?? '') : str;
      return Buffer.from(String(v), 'utf-8').toString('base64');
    },
    base64Encode(str) { return java.base64(str); },
    base64Decode(str) {
      const v = str === undefined ? (c.result ?? '') : str;
      return Buffer.from(String(v), 'base64').toString('utf-8');
    },

    md5Encode(str) {
      const v = str === undefined ? (c.result ?? '') : str;
      return crypto.createHash('md5').update(String(v), 'utf-8').digest('hex');
    },
    md5Encode16(str) { return java.md5Encode(str).slice(8, 24); },

    /** legado StringUtils.stringToInt：整串整数解析优先，失败走中文数字（chineseNumToInt） */
    _stringToInt(str) {
      if (str == null) return -1;
      // fullToHalf：全角转半角
      let s = '';
      for (const ch of String(str)) {
        const code = ch.codePointAt(0);
        s += code === 12288 ? ' ' : (code >= 65281 && code <= 65374) ? String.fromCharCode(code - 65248) : ch;
      }
      s = s.replace(/\s+/g, '');
      if (/^-?\d+$/.test(s)) return parseInt(s, 10);
      return chineseNumToInt(s);
    },

    /** legado JsExtensions.toNumChapter：章节名「第X章」中文数字转阿拉伯数字（第一百二十三章 → 第123章；无匹配返回原文） */
    toNumChapter(s) {
      if (s == null) return null;
      // legado AppPattern.titleNumPattern = (第)(.+?)(章) 首个匹配
      const m = /第(.+?)章/.exec(String(s));
      if (!m) return s;
      return `第${java._stringToInt(m[1])}章`;
    },

    // ---- 加解密（crypto：AES/DES/RC4 常用组合）----
    aesBase64DecodeToString(cipher, password, transformation, iv) {
      return cryptoDecrypt(cipher, password, transformation, iv, true, false);
    },
    aesBase64Decode(cipher, password, transformation, iv) {
      return cryptoDecrypt(cipher, password, transformation, iv, true, true);
    },
    aesDecodeToString(cipher, password, transformation, iv) {
      return cryptoDecrypt(cipher, password, transformation, iv, false, false);
    },
    desBase64DecodeToString(cipher, password, transformation, iv) {
      return cryptoDecrypt(cipher, password, transformation, iv, true, false);
    },
  };

  // 模板/ajax 递归求值时使用最新上下文（c.getApi 由 analyzer 提供时动态切换视角）
  function currentCtx() {
    return c.getApi ? c.getApi().ctx : c;
  }

  /** legado StringUtils.chineseNumToInt：中文数字转整数（权值分段法；「一零二五」位值形式；
   *  含〇零一二两三四五六七八九十百千万亿与壹贰叁肆伍陆柒捌玖拾佰仟大写；无匹配字符返回 -1） */
  function chineseNumToInt(chNum) {
    const map = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
      '〇': 0, '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9, '拾': 10,
      '两': 2, '百': 100, '佰': 100, '千': 1000, '仟': 1000, '万': 10000, '亿': 100000000 };
    const cn = [...chNum];
    // 「一零二五」位值形式（legado：长度>1 且每位均为零到九字符）
    if (cn.length > 1 && cn.every((ch) => map[ch] != null && map[ch] <= 9)) {
      return parseInt(cn.map((ch) => map[ch]).join(''), 10);
    }
    try {
      let result = 0, tmp = 0, billion = 0;
      for (let i = 0; i < cn.length; i++) {
        const tmpNum = map[cn[i]];
        if (tmpNum == null) return -1; // legado ChnMap[cn[i]]!! NPE → runCatching getOrDefault(-1)
        if (tmpNum === 100000000) { result += tmp; result *= tmpNum; billion = billion * 100000000 + result; result = 0; tmp = 0; }
        else if (tmpNum === 10000) { result += tmp; result *= tmpNum; tmp = 0; }
        else if (tmpNum >= 10) { if (tmp === 0) tmp = 1; result += tmpNum * tmp; tmp = 0; }
        else {
          // 「一千二」省略位形式：末位数字 × 前一权值 / 10
          tmp = (i >= 2 && i === cn.length - 1 && map[cn[i - 1]] > 10) ? tmpNum * map[cn[i - 1]] / 10 : tmp * 10 + tmpNum;
        }
      }
      return result + tmp + billion;
    } catch { return -1; }
  }

  /** 同步 HTTP → StrResponse 形态（legado Connection.Response：code()/body()/header()/url()；post/get/ajaxAll 共用）。
   *  载体为 new String(body)：legado StrResponse 本质是 String，字符串拼接/match 自动拆箱 */
  function syncFetch(url, method = 'GET', body = '', headers = {}) {
    const empty = () => {
      const carrier = new String('');
      return Object.assign(carrier, { code: () => 0, body: () => '', header: () => '', headers: {}, url: () => url });
    };
    try {
      const merged = { ...defaultHeaders(), ...(headers || {}) };
      const out = execFileSync(process.execPath, ['-e', FETCH_SYNC_SCRIPT, url,
        JSON.stringify(merged), method, String(body ?? '')], { timeout: 30000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf-8' });
      const j = JSON.parse(out.trim());
      if (j.error) throw new Error(j.error);
      const buf = Buffer.from(j.b64, 'base64');
      const hs = j.headers || {};
      const bodyStr = decodeBuffer(buf, charsetFromHeader(hs['content-type']));
      const carrier = new String(bodyStr);
      return Object.assign(carrier, {
        code: () => j.status,
        body: () => bodyStr,
        header: (name) => {
          const k = String(name).toLowerCase();
          if (hs[k] !== undefined && hs[k] !== '') return hs[k];
          // 302 跟随后 location 头消失（Node fetch redirect:follow），社区源高频
          // `java.get(url).header('location')` 取跳转地址 → 以最终 URL 兜底
          if (k === 'location' && j.url && j.url !== url) return j.url;
          return '';
        },
        headers: hs,
        url: () => j.url || url,
      });
    } catch (e) {
      console.warn(`java.${String(method).toLowerCase()} failed [${url.slice(0, 80)}]: ${e.message}`);
      return empty();
    }
  }

  function defaultHeaders() {
    const h = parseSourceHeaders(c.source, c);
    return h;
  }

  return java;
}

/** 解析书源 header 字段 → 请求头对象。legado BaseSource.getHeaderMap（BaseSource.kt L148-192）：
 *  @js:/<js> 前缀先求值（baseUrl 绑书源地址，如 `{"Referer":baseUrl}`），产物再解析 JSON；
 *  纯文本容忍单引号宽松 JSON / UA 键值行；无 UA 补默认（L184-186） */
export function parseSourceHeaders(source, ctx = null) {
  const raw = source?.header;
  if (!raw) return {};
  const headers = {};
  const text = String(raw).trim();
  try {
    let obj = null;
    if (/^@js:/i.test(text) || /^<js>/i.test(text)) {
      const code = /^@js:/i.test(text)
        ? text.slice(4)
        : text.slice(4, text.lastIndexOf('<'));
      const jctx = ctx || { source, vars: new Map(), baseUrl: source.bookSourceUrl };
      if (!jctx.source) jctx.source = source;
      if (!jctx.java) jctx.java = createJavaApi(jctx);
      obj = JSON.parse(String(runJs(code, { ...jctx, result: text })));
    } else {
      try { obj = JSON.parse(text); } catch {
        obj = vm.runInNewContext('(' + text + ')', {}, { timeout: 1000 });
      }
    }
    if (obj && typeof obj === 'object') {
      // 空值头跳过：OkHttp 允许空值 header（legado 原样发送），undici 校验直接炸
      // （如全本小说 header 的 "Keep-Alive":"" → invalid keep-alive header）
      for (const [k, v] of Object.entries(obj)) if (v != null && String(v) !== '') headers[String(k)] = String(v);
    }
  } catch {
    const m = /["']?UA["']?\s*[:=]\s*["']([^"']+)["']/.exec(text);
    if (m) headers['User-Agent'] = m[1];
  }
  if (!headers['User-Agent']) {
    headers['User-Agent'] = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  }
  return headers;
}

// ESM 统一从文件头 import

/**
 * 通用解密：transformation 形如 "AES/CBC/PKCS5Padding"、"DES/ECB/PKCS5Padding"、"RC4"
 * base64Input: 密文是否 base64 编码；rawOutput: 输出是否保留二进制 latin1
 */
function cryptoDecrypt(cipherText, password, transformation = 'AES/CBC/PKCS5Padding', iv = '', base64Input = true, rawOutput = false) {
  try {
    const data = base64Input ? Buffer.from(String(cipherText), 'base64') : Buffer.from(String(cipherText), 'latin1');
    const t = String(transformation || '').toUpperCase().replace('PADPING', 'PADDING');
    if (t.startsWith('RC4')) {
      const out = rc4Crypt(Buffer.from(String(password), 'utf-8'), data);
      return rawOutput ? out.toString('latin1') : out.toString('utf-8');
    }
    const [algoRaw, mode = 'CBC', padding = 'PKCS5'] = t.split('/');
    const algo = algoRaw === 'DESEDE' ? 'TRIPLEDES' : algoRaw;
    const m = String(mode).toLowerCase();
    const isGcm = /GCM/.test(t);
    // 密钥长度（Java SecretKeySpec 常规用法）与分组块长（IV 截断）
    const keyLen = algo === 'DES' ? 8 : algo === 'TRIPLEDES' ? 24 : 16;
    const blockLen = algo === 'DES' || algo === 'TRIPLEDES' ? 8 : 16;
    // Node/OpenSSL cipher 名必须显式密钥长度（aes-cbc/aes-gcm/aes-ecb 均 Unknown cipher）：
    // AES → aes-128-<mode>；DES → des-<mode>；3DES → des-ede3[-<mode>]
    const algorithm = algo === 'AES' ? `aes-${keyLen * 8}-${isGcm ? 'gcm' : m}`
      : algo === 'DES' ? `des-${m}`
      : algo === 'TRIPLEDES' ? (m === 'ecb' ? 'des-ede3' : `des-ede3-${m}`)
      : `${algo.toLowerCase()}-${m}`;
    let key = Buffer.from(String(password), 'utf-8');
    if (key.length > keyLen) key = key.subarray(0, keyLen);
    if (key.length < keyLen) key = Buffer.concat([key, Buffer.alloc(keyLen - key.length)]);
    const pad = /NOPADDING/i.test(padding) ? undefined : 'pkcs7';
    const opts = isGcm ? undefined : pad;
    let ivBuf = iv ? Buffer.from(String(iv), 'utf-8') : null;
    if (ivBuf && ivBuf.length > blockLen) ivBuf = ivBuf.subarray(0, blockLen);
    if (isGcm && ivBuf) {
      const d = crypto.createDecipheriv(algorithm, key, ivBuf);
      // Java Cipher GCM 密文格式 = 密文 + 认证标签（16 字节），解密前拆出 setAuthTag
      const tag = data.length > 16 ? data.subarray(data.length - 16) : Buffer.alloc(0);
      d.setAuthTag(tag);
      const out = Buffer.concat([d.update(data.length > 16 ? data.subarray(0, data.length - 16) : Buffer.alloc(0)), d.final()]);
      return rawOutput ? out.toString('latin1') : out.toString('utf-8');
    }
    const d = crypto.createDecipheriv(algorithm, key, (m === 'ecb' || !ivBuf) ? null : ivBuf, opts);
    const out = Buffer.concat([d.update(data), d.final()]);
    return rawOutput ? out.toString('latin1') : out.toString('utf-8');
  } catch (e) {
    console.warn(`cryptoDecrypt failed (${transformation}): ${e.message}`);
    return '';
  }
}

/** RC4（KSA+PRGA） */
function rc4Crypt(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}
