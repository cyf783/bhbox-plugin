// HTTP 抓取封装（java.ajax 与 T4 动作共用）：options 尾巴 + charset 解码/编码 + 超时
// legado SSLHelper.unsafeTrustManager：默认信任所有证书（自签证书书源站社区常见），
// 进程级关闭 TLS 校验对齐（Node 每次连接时读取该环境变量）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import iconv from 'iconv-lite';
import { parseUrlRule } from './urlrule.js';
import { runJs } from './template.js';

const TEXTDecoder = TextDecoder;

/**
 * 抓取 URL/URL 规则 → 文本。
 * @param {string} input URL 或带 options 尾巴的 URL 规则（{{}} 模板由调用方先渲染）
 * @param {object} opts { headers, timeout, charset, method, body } — 与 options 尾巴合并（opts 优先）
 * @returns {Promise<string>}
 */
export async function fetchText(input, opts = {}) {
  let { url, options } = parseUrlRule(String(input));
  if (!/^https?:\/\//i.test(url)) throw new Error('not http url: ' + url.slice(0, 100));
  // legado UrlOption.js：解析完参数后执行，结果赋值给 url
  if (options.js) {
    try {
      const out = runJs(options.js, { result: url, baseUrl: url, java: opts.java || {} }, 3000);
      if (out != null && String(out)) url = String(out);
    } catch (e) { console.warn(`option.js failed: ${e.message}`); }
  }
  const headers = { ...(options.headers || {}), ...(opts.headers || {}) };
  const method = opts.method || options.method || 'GET';
  let body;
  if (method === 'POST') {
    body = applyPostBody('POST', opts.body ?? options.body ?? '', headers, opts.charset || options.charset);
  }
  const timeout = opts.timeout || 30000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  // legado analyzeUrl：GET query 段按 option.charset 编码（书源一 GBK searchkey 类）
  if (method !== 'POST') url = encodeUrlQuery(url, opts.charset || options.charset);
  try {
    const res = await fetch(url, {
      method, headers, body, redirect: 'follow',
      signal: ctl.signal,
    });
    const buf = await res.arrayBuffer();
    if (!res.ok && buf.byteLength === 0) throw new Error('HTTP ' + res.status + ' for ' + url.slice(0, 100));
    const charset = opts.charset || options.charset || charsetFromHeader(res.headers.get('content-type'));
    return decodeBuffer(buf, charset);
  } finally {
    clearTimeout(timer);
  }
}

/** GET query 段按 charset 编码（legado encodeUrlParams isQuery=true：整体已编码原样，
 *  否则非安全字符按 charset percent 编码，& = / 等结构符保留；utf-8 缺省时 fetch
 *  原生 UTF-8 编码等价，仅在 gbk 等显式 charset 时介入） */
export function encodeUrlQuery(url, charset) {
  if (!charset || /^utf-?8$/i.test(charset)) return url;
  const pos = url.indexOf('?');
  if (pos < 0) return url;
  const q = url.slice(pos + 1);
  let alreadyEncoded = true;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === '%' && /[0-9a-fA-F]{2}/.test(q.slice(i + 1, i + 3))) { i += 2; continue; }
    if (c.charCodeAt(0) < 256 && /[A-Za-z0-9*\-._!$&'()+,;=@:\/?~#[\]]/.test(c)) continue;
    alreadyEncoded = false;
    break;
  }
  if (alreadyEncoded) return url;
  return url.slice(0, pos + 1) + q.replace(/[\u0080-\uffff\s"<>{}|\\^`]/g, (ch) =>
    Array.from(iconv.encode(ch, charset)).map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));
}

export function charsetFromHeader(ct) {
  if (!ct) return null;
  const m = /charset=([\w-]+)/i.exec(ct);
  return m ? m[1] : null;
}

/** application/x-www-form-urlencoded 按 charset 编码：非安全字符 → charset 字节 → %XX，空格 → + */
export function formEncode(str, charset) {
  return str.replace(/[^A-Za-z0-9*.\-_]/g, (ch) => {
    if (ch === ' ') return '+';
    const bytes = iconv.encode(ch, charset);
    return Array.from(bytes).map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  });
}

/** body 首尾包络判定（legado StringExtensions.isJson/isXml） */
function isJsonLike(s) {
  const t = String(s).trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}
function isXmlLike(s) {
  const t = String(s).trim();
  return t.startsWith('<') && t.endsWith('>');
}

/** %XX 已编码形态判定（legado NetworkUtils.encodedForm）：白名单 0-9a-zA-Z*-._，
 *  合法 %XX（两位 hex）跳过，其余字符视为未编码 */
function encodedForm(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (str.charCodeAt(i) < 256 && /[A-Za-z0-9*\-._]/.test(c)) continue;
    if (c === '%' && i + 2 < str.length) {
      if (/[0-9A-Fa-f]/.test(str[i + 1]) && /[0-9A-Fa-f]/.test(str[i + 2])) { i += 2; continue; }
    }
    return false;
  }
  return true;
}

/** POST 表单体分段编码（legado encodeUrlParams isQuery=false）：去尾 &，按 & 拆段、
 *  首 '=' 拆 key/value 分别编码；无 charset 时已编码段原样保留（checkEncoded），
 *  charset="escape" 走 UTF-8 百分号编码近似 */
export function formEncodeParams(str, charset) {
  const cs = charset && charset !== 'escape' ? charset : 'utf-8';
  const checkEncoded = !charset;
  const enc = (v) => (checkEncoded && encodedForm(v) ? v : formEncode(v, cs));
  const segs = String(str).replace(/&$/, '').split('&');
  let start = 0;
  while (start < segs.length && segs[start] === '') start++;
  return segs.slice(start).map((seg) => {
    const eq = seg.indexOf('=');
    if (eq < 0) return enc(seg);
    return enc(seg.slice(0, eq)) + '=' + enc(seg.slice(eq + 1));
  }).join('&');
}

/** legado AnalyzeUrlCore POST 三分支（fetchText 与 java.ajax 共用；原地补 headers）：
 *   body 为空 → 空体 + 表单 CT（postForm）
 *   body 非 JSON/XML 且无 Content-Type → encodeUrlParams 分段 URL 编码 + 表单 CT（postForm）
 *     （中文/特殊字符编码：keyword=剑 → keyword=%E5%89%91；已编码 %XX 段原样保留）
 *   body 为 JSON/XML 或显式 Content-Type → 原样发送（无 CT 时 postJson 补 JSON CT） */
export function applyPostBody(method, raw, headers, charset) {
  if (method !== 'POST') return undefined;
  const ctKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  if (!raw) {
    if (!ctKey) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return '';
  }
  if (!ctKey && !isJsonLike(raw) && !isXmlLike(raw)) {
    if (!ctKey) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return formEncodeParams(raw, charset);
  }
  if (!ctKey) headers['Content-Type'] = 'application/json; charset=UTF-8';
  return raw;
}

/** 按字符集解码；未知/失败回退 utf-8 */
export function decodeBuffer(buf, charset) {
  if (charset) {
    try { return new TEXTDecoder(charset.toLowerCase()).decode(buf); }
    catch (e) { console.warn(`charset ${charset} unsupported, fallback utf-8`); }
  }
  return new TEXTDecoder('utf-8').decode(buf);
}
