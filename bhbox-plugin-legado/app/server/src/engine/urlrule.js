// URL 规则解析：path,{'method':'POST','body':'...','headers':{...},'charset':'gbk'} options 尾巴
// legado 的 options 是宽松 JS 对象字面量（单引号/无引号键），用 vm 求值而非 JSON.parse
import vm from 'vm';

/**
 * 拆分 URL 规则与 options 尾巴。
 * "path,{...}" → { url: 'path', optionsText: '{...}' }；无尾巴则 optionsText 为空。
 * 花括号配对扫描，容忍 body/headers 内部的逗号与花括号。
 */
export function splitUrlRule(rule) {
  if (typeof rule !== 'string') return { url: String(rule ?? ''), optionsText: '' };
  const start = findOptionsStart(rule);
  if (start < 0) return { url: rule.trim(), optionsText: '' };
  const end = matchBrace(rule, start);
  if (end < 0) return { url: rule.trim(), optionsText: '' };
  return { url: rule.slice(0, start).trim(), optionsText: rule.slice(start + 1, end + 1) };
}

/** 找到「,{」形式的 options 起始位置（legado urlParamPattern：\s*,\s*(?=\{)） */
function findOptionsStart(rule) {
  const m = /\s*,\s*(?=\{)/.exec(rule);
  return m ? m.index : -1;
}

/** 从 '{' 起做配对扫描（忽略引号内内容），返回匹配 '}' 下标 */
function matchBrace(s, open) {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 解析 options 文本（JS 对象字面量，2s 超时）。
 * 返回 { method, body, headers, charset, webView } 规范化对象；解析失败返回 {}。
 */
export function parseOptions(text) {
  if (!text || !text.trim()) return {};
  try {
    const obj = vm.runInNewContext('(' + text + ')', {}, { timeout: 2000 });
    if (!obj || typeof obj !== 'object') return {};
    return {
      method: String(obj.method || 'GET').toUpperCase(),
      // body 为对象/数组时序列化为 JSON 文本（legado AnalyzeUrlCore postJson：Map/List body → JSON 请求体），
      // 否则 String() 会得到 "[object Object]" 垃圾请求体
      body: obj.body != null
        ? (typeof obj.body === 'object' ? JSON.stringify(obj.body) : String(obj.body))
        : undefined,
      headers: normalizeHeaders(obj.headers),
      charset: obj.charset ? String(obj.charset) : undefined,
      webView: !!(obj.useWebView || obj.webView),
      // legado UrlOption.js：解析完 url 参数后执行的 JS，结果赋值给 url（供 http 层执行）
      js: obj.js ? String(obj.js) : undefined,
      type: obj.type ? String(obj.type) : undefined,
      retry: Number.isFinite(obj.retry) ? Number(obj.retry) : undefined,
    };
  } catch (e) {
    console.warn(`options parse failed: ${e.message}`);
    return {};
  }
}

function normalizeHeaders(h) {
  if (!h || typeof h !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (v != null) out[String(k)] = String(v);
  }
  return out;
}

/**
 * 解析完整 URL 规则 → { url, options }（url 中的 {{}} 模板由调用方先行渲染）
 */
export function parseUrlRule(rule) {
  const { url, optionsText } = splitUrlRule(rule);
  return { url, options: parseOptions(optionsText) };
}
