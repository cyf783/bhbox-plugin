// {{}} 模板渲染（URL 与规则通用）
// {{expr}} 内为 JS 表达式：变量（key/page/sourceKey/book/source）+ java.* 调用 + $.path（JSON 上下文）
import vm from 'vm';
import crypto from 'crypto';
import { load } from 'cheerio';
import { jsonLookup } from './json.js';

/**
 * 渲染模板字符串中的 {{expr}}。
 * @param {string} tpl 模板
 * @param {object} ctx { vars: Map 变量池, page, key, source, book, java, baseUrl, result }
 * @returns {string} 渲染结果（不可求值的 {{}} 段置空）
 */
export function render(tpl, ctx) {
  if (!tpl || typeof tpl !== 'string' || !tpl.includes('{{')) return tpl || '';
  // legado innerRule：引号感知的平衡扫描（{{}} 内 JS 对象字面量的 } 不误截断）
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf('{{', i);
    if (open < 0) { out += tpl.slice(i); break; }
    out += tpl.slice(i, open);
    const close = matchDoubleBrace(tpl, open + 2);
    if (close < 0) { out += tpl.slice(open); break; }
    const expr = tpl.slice(open + 2, close);
    try {
      const v = evalExpr(expr.trim(), ctx);
      out += v == null ? '' : String(v);
    } catch (e) {
      console.warn(`template render failed: ${expr}: ${e.message}`);
      // legado makeUpRule 语义：单段求值失败（null -> Unit）该段置空，整条规则继续，
      // 避免原样保留 {{...}} 被下游当 URL 反复抓取刷屏
      out += '';
    }
    i = close + 2;
  }
  return out;
}

/** 从 start 找配对 }}（引号内字符与 { 深度不参与；\ 转义感知——
 *  JSON.stringify 产物 {{java.get(\"id\")}} 中 quote 态外的 \ 必须跳过，否则
 *  引号状态错乱导致找不到配对 }}，模板段整体原样保留） */
function matchDoubleBrace(tpl, start) {
  let depth = 0, quote = null;
  for (let i = start; i < tpl.length - 1; i++) {
    const c = tpl[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      if (depth > 0) { depth--; continue; }
      if (tpl[i + 1] === '}') return i;
    }
  }
  return -1;
}

/** 求值单个 {{}} 表达式：$.path（JSON 上下文）/ 纯变量名查表，其余走 vm 沙箱 */
export function evalExpr(expr, ctx) {
  // JSON.stringify 产物残留：源 JS 拼的 options body 经 stringify 后 {{java.get(\"id\")}}
  // 的引号转义保留，JS 表达式/JSONPath 中裸 \" 无合法语义，还原为 "（阅友等加密源常态）
  if (expr.includes('\\"')) expr = expr.replace(/\\"/g, '"');
  // legado makeUpRule isRule 分支（AnalyzeRuleCore.kt L769-786/L812-817）：
  // $. / $[ 开头的 {{}} 段不进 JS 沙箱，而是作为 JSONPath 子规则对当前内容求值
  // （AnalyzeByJSonPath.parse：严格 JSON.parse，失败按无匹配返回空）
  if (expr.startsWith('$.') || expr.startsWith('$[')) {
    let data = ctx.data;
    if (data === undefined) {
      // JSON 上下文缺失时对 result 文本（当前内容）做严格 JSON.parse 尝试
      const t = typeof ctx.result === 'string' ? ctx.result.trim() : '';
      if (t.startsWith('{') || t.startsWith('[')) {
        try { data = JSON.parse(t); } catch { /* legado parseOrNull → 无匹配 */ }
      }
    }
    if (data !== undefined) return jsonLookup(data, expr);
    return null; // 无 JSON 上下文 → 段置空
  }
  // legado isRule：@（CSS/JSON 规则）与 /（XPath）开头为规则语法，按子规则对当前内容求值
  // （不进 JS 沙箱——如 {{@.book-cats@text}}），无 evalRule 上下文时同样段置空
  if (expr.startsWith('@') || expr.startsWith('/')) {
    return ctx.evalRule ? ctx.evalRule(expr) : null;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const vars = ctx.vars || new Map();
    if (expr === 'page') return ctx.page ?? 1;
    if (vars.has(expr)) return vars.get(expr);
    if (expr === 'key' || expr === 'searchKey') return ctx.key ?? '';
    if (expr === 'searchPage') return ctx.page ?? 1;
    if (expr === 'sourceKey') return ctx.source?.bookSourceUrl ?? '';
    if (expr === 'result') return ctx.result ?? '';
    // legado evalJS 绑定面（title=chapter?.title、src=当前内容）在纯变量名短路处同样可用
    if (expr === 'title') return ctx.title ?? (ctx.chapter ? ctx.chapter.title ?? '' : '');
    if (expr === 'src') return ctx.result ?? '';
    if (ctx.source && expr in ctx.source) return ctx.source[expr];
    // 未命中（含仅由 jsLib 定义的名字，如 66书吧 ho）→ 落 JS 沙箱求值：
    // jsLib 名字命中；真未定义名抛 ReferenceError，由 render 捕获置空（同 legado）。
    // {{}} 内可调 java.ajax 同步抓取（登录/签名），超时放宽（同 runJs 注释）
    return runJs(expr, ctx, 30000);
  }
  return runJs(expr, ctx, 30000);
}

/**
 * vm 沙箱执行 JS 片段（@js 规则与模板共用）。
 * 注入 java/source/book/result/baseUrl/chapter/title/src/page/key/cookie；默认超时 5s（模板 2s）。
 */
/** cookie 绑定（legado SourceNetworkProvider asBinding 方法面，本插件无持久 cookie → no-op） */
const defaultCookie = {
  getCookie() { return ''; },
  putCookie() {},
  removeCookie() {},
  replaceCookie() {},
  getLoginHeader() { return ''; },
};

/** Rhino 方言预处理：无括号解构箭头参数补括号（legado 魔改 Rhino 支持 [a,b]=>、{a}=>，
 *  V8 报 "Malformed arrow function parameter list"）。[...]=>/{...}=> 在合法 ES 中均为
 *  语法错误（数组/块后不得跟 =>），故转换恒安全。 */
function rhinoDialect(code) {
  if (!code.includes('=>')) return code;
  return code
    // Rhino 宽松方言：无括号解构箭头参数（[a,b]=> / {a,b}=>，容忍空格）→ V8 要求加括号
    .replace(/\[([^[\]]*)\]\s*=>/g, '([$1])=>')
    .replace(/\{([^{}]*)\}\s*=>/g, '({$1})=>');
}

// legado Rhino evalJS 5s 超时只计纯 JS（网络走 OkHttp 同步不占计时）；
// 我们 vm timeout 把 java.ajax 的同步子进程请求也计入（多请求串行必超 5s），
// 故放宽到 60s——纯 JS 死循环仍有界
const scriptCache = new Map();
const MAX_SCRIPT_CACHE = 300; // vm.Script 编译缓存上限（同规则高频复用，超限删最早）

export function runJs(code, ctx, timeout = 60000) {
  // legado SharedJsScope.getScope(jsLib)：源 jsLib 求值为所有 JS（@js/{{}}）的共享全局
  // 作用域（如 66书吧 searchUrl {{ho}} 依赖 jsLib 的 const ho）。vm context 每次新建
  // 无父作用域，以代码前置拼接等价（全库 20 个内联 jsLib 源，重编译开销可忽略）
  const lib = ctx.source?.jsLib;
  code = rhinoDialect((typeof lib === 'string' && lib.trim() ? lib + '\n;\n' : '') + String(code));
  const sandbox = {
    java: ctx.java || {},
    source: ctx.source || {},
    book: ctx.book || {},
    result: ctx.result ?? '',
    baseUrl: ctx.baseUrl || ctx.source?.bookSourceUrl || '',
    // legado evalJS 绑定：chapter 为章节对象、title 为 chapter?.title、src 为正文内容
    chapter: ctx.chapter ?? {},
    title: ctx.title ?? (ctx.chapter ? ctx.chapter.title ?? '' : ''),
    src: ctx.result ?? '',
    page: ctx.page ?? 1,
    key: ctx.key ?? '',
    searchKey: ctx.key ?? '',
    searchPage: ctx.page ?? 1,
    sourceKey: ctx.source?.bookSourceUrl ?? '',
    cookie: ctx.cookie || defaultCookie,
    cache: ctx.cache || {},
    ctx: ctx,
    ...rhinoBridge(),
    __getBytes,
  };
  // Rhino LiveConnect 语义：JS 字符串可直调 java.lang.String 方法（社区源高频
  // `String(key).getBytes()` 传 SecretKeySpec）。仅补 getBytes；上下文每次新建，
  // 原型补丁不外泄。prologue 单独执行，不污染源码首行（'use strict' 指令等）。
  const context = vm.createContext(sandbox);
  vm.runInContext(
    "if(!String.prototype.getBytes){Object.defineProperty(String.prototype,'getBytes',{value:function(cs){return __getBytes(String(this),cs);},writable:true,configurable:true});}",
    context);
  // 脚本编译缓存：同规则高频复用（米读 chapterUrl @js 每章执行，千章目录 1170 次重编译
  // 占 50MB+）。缓存 key = rhinoDialect 后的完整代码（含 jsLib 前置，源间互不串扰）
  let script = scriptCache.get(code);
  if (!script) {
    script = new vm.Script(code, { filename: 'legado-eval.js' });
    if (scriptCache.size >= MAX_SCRIPT_CACHE) scriptCache.delete(scriptCache.keys().next().value);
    scriptCache.set(code, script);
  }
  return script.runInContext(context, { timeout });
}

/** Java String.getBytes(charset) 语义：字符串 → 指定字符集字节（缺省 UTF-8） */
const __getBytes = (s, cs) => {
  try { return Buffer.from(s, cs ? String(cs).toLowerCase() : 'utf-8'); } catch { return Buffer.from(s, 'utf-8'); }
};

// ============ Rhino Java 桥超集（JavaImporter/Packages） ============
// 社区老源在 JS 规则里用 Rhino JavaImporter 调 java.base 类，高频套路是加密三件套
// （Base64/SecretKeySpec/IvParameterSpec/Cipher/Arrays）。V8 无 Java 类，此处以纯 JS
// 语义模拟该五个类（Java byte[] → Buffer；String(bytes) → utf-8），importPackage 空实现
// ——with(javaImport) 块内的类名直读实例属性（Annex B sloppy 函数声明 hoist 与 V8 一致）。

/** transformation → Node cipher 名（Node/OpenSSL 需显式密钥长度：aes-128-cbc；
 *  PKCS5Padding 即 Node CBC/ECB 默认填充，不能带 -pkcs7padding 后缀——Unknown cipher） */
export function bridgeCipherName(transformation, keyLen) {
  const t = String(transformation).toUpperCase();
  const mode = t.includes('GCM') ? 'gcm' : t.includes('CBC') ? 'cbc' : t.includes('CFB') ? 'cfb' : t.includes('OFB') ? 'ofb' : 'ecb';
  if (t.includes('DESEDE') || t.includes('TRIPLEDES')) return mode === 'ecb' ? 'des-ede3' : `des-ede3-${mode}`;
  if (t.includes('DES')) return `des-${mode}`;
  const klen = keyLen === 32 ? 256 : keyLen === 24 ? 192 : 128;
  return `aes-${klen}-${mode}`;
}

let _bridge = null;
function rhinoBridge() {
  if (_bridge) return _bridge;
  const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf-8'));
  const Packages = new Proxy(function () {}, { get: () => Packages, apply: () => Packages });
  const Base64 = {
    getDecoder: () => ({ decode: (s) => Buffer.from(String(s), 'base64') }),
    getEncoder: () => ({ encode: (b) => Buffer.from(b).toString('base64') }),
  };
  // 构造器同时支持 new 与直调（Rhino 允许 SecretKeySpec(...) 省略 new，ES class 不行）
  function SecretKeySpec(keyBytes) {
    if (!(this instanceof SecretKeySpec)) return new SecretKeySpec(keyBytes);
    this._bytes = toBuf(keyBytes);
  }
  function IvParameterSpec(iv) {
    if (!(this instanceof IvParameterSpec)) return new IvParameterSpec(iv);
    this._bytes = toBuf(iv);
  }
  class Arrays {
    static copyOfRange(buf, from, to) { return toBuf(buf).slice(from, to); }
    static copyOf(buf, len) { return toBuf(buf).subarray(0, len); }
  }
  class Cipher {
    constructor(t) { this._t = t; this._key = null; this._iv = null; }
    static getInstance(t) { return new Cipher(t); }
    init(_mode, key, iv) { this._key = key._bytes; this._iv = iv ? iv._bytes : null; }
    doFinal(data) {
      const buf = toBuf(data);
      const name = bridgeCipherName(this._t, this._key.length);
      const d = crypto.createDecipheriv(name, this._key, this._iv || null);
      const out = Buffer.concat([d.update(buf), d.final()]);
      // Java String(byte[]) 语义：明文按 utf-8 字符串返回（String(doFinal(...)) 直取）
      return out.toString('utf-8');
    }
  }
  class JavaImporter {
    constructor() { Object.assign(this, { Packages, Base64, SecretKeySpec, IvParameterSpec, Cipher, Arrays }); }
    importPackage() {}
    importClass() {}
  }
  _bridge = { JavaImporter, Packages, Base64, SecretKeySpec, IvParameterSpec, Cipher, Arrays, org: { jsoup: { Jsoup } } };
  return _bridge;
}

// ============ org.jsoup 桥（Rhino LiveConnect：org.jsoup.Jsoup.parse） ============
// 社区源 JS 规则高频 `var doc = org.jsoup.Jsoup.parse(result)` 做 HTML 提取
// （doc.select(css).first().attr(...)，以及 `X = doc.select(...); for(i) X[i].text()`——
// legado Elements 是 List<Element>，**索引访问**即得带方法元素，Rhino 场景高频）。
// 故包装为**数组实例**上挂方法：数字项 = 元素级包装（text/attr/select 可链），方法面同 legado。
function jsoupWrap(els, $, single = false) {
  const arr = els.toArray();
  if (single) {
    // 元素级包装（终止递归）：legado Element 方法面，select 再入列表包装
    const el = arr[0];
    return {
      select: (css) => jsoupWrap(els.find(String(css)), $),
      attr: (name) => el?.attribs?.[String(name)] ?? '',
      text: () => (el ? $(el).text() : ''),
      html: () => (el ? $.html(el) : ''),
      outerHtml: () => (el ? $.html(el) : ''),
      toString() { return this.text(); },
    };
  }
  const list = arr.map((e) => jsoupWrap($(e), $, true));
  const one = (e) => jsoupWrap(e ? $(e) : $(), $, true);
  list.select = (css) => jsoupWrap(els.find(String(css)), $);
  list.first = () => one(arr[0]);
  list.last = () => one(arr[arr.length - 1]);
  list.get = (i) => one(arr[i]);
  list.size = () => arr.length;
  list.isEmpty = () => arr.length === 0;
  list.attr = (name) => (arr[0] ? arr[0].attribs?.[String(name)] ?? '' : '');
  list.text = () => arr.map((e) => $(e).text()).join('\n');
  list.html = () => (arr[0] ? $.html(arr[0]) : '');
  list.outerHtml = () => (arr[0] ? $.html(arr[0]) : '');
  list.toString = () => list.text();
  return list;
}

const Jsoup = {
  parse(html, baseUri) {
    const $ = load(String(html ?? ''), baseUri ? { baseURI: String(baseUri) } : undefined);
    const doc = jsoupWrap($.root(), $);
    doc.body = () => jsoupWrap($('body'), $);
    return doc;
  },
};
