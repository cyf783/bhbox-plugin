// 规则执行总入口：方言分发 + ## 正则净化 + || && 组合 + 模板 + 纯正则
// 内容表示统一为 repr：
//   { kind:'html', $, root, raw } | { kind:'json', data, raw } | { kind:'xml', doc, node, raw } | { kind:'text', text, raw }
import * as cheerio from 'cheerio';
import { analyzeJsoup, analyzeCss, loadHtml } from './jsoup.js';
import { analyzeJson } from './json.js';
import { analyzeXpath, loadXml } from './xpath.js';
import { render, runJs } from './template.js';

/** 原始文本 → 内容 repr（嗅探 json/html/text） */
export function makeContent(raw, forceKind = null) {
  const text = raw == null ? '' : String(raw);
  if (forceKind === 'html') return { kind: 'html', $: loadHtml(text), root: null, raw: text };
  if (forceKind === 'json') {
    try { return { kind: 'json', data: JSON.parse(text), raw: text }; } catch { /* 落回嗅探 */ }
  }
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return { kind: 'json', data: JSON.parse(text), raw: text }; } catch { /* 保持嗅探 */ }
  }
  if (/<[a-z!][\s\S]*>/i.test(t)) return { kind: 'html', $: loadHtml(text), root: null, raw: text };
  return { kind: 'text', text, raw: text };
}

/** 元素 → repr（wrapItem 使用） */
export function elementRepr(el) {
  return wrapItem(el, null);
}

/**
 * 列表规则：返回 repr 数组（书单/章节列表）。
 * 空规则 → 单元素列表（整文档自身）。
 */
export function analyzeList(content, rule, ctx) {
  if (!rule || !rule.trim()) return [content];
  // legado getString/getElements 的 mContent 参数接受任意类型（String 各方言 parse）
  if (typeof content === 'string') content = makeContent(content);
  try {
    const out = dispatch(content, rule.trim(), ctx, true);
    const arr = Array.isArray(out) ? out : (out ? [out] : []);
    // 带 groups 的正则 AllInOne 条目已是 repr，直接透传
    return arr.map((el) => (el && el.kind === 'text' && el.groups ? el : wrapItem(el, content)));
  } catch (e) {
    console.warn(`analyzeList failed [${String(rule).slice(0, 60)}]: ${e.message}`);
    return [];
  }
}

/** 列表元素 → repr（html 元素复用父文档的 $ 实例） */
function wrapItem(el, parent) {
  if (el == null) return { kind: 'text', text: '', raw: '' };
  // cheerio 节点也有 nodeType（=1），必须先按 tag 特征识别
  if (el.type === 'tag' && el.name) {
    const $ = parent && parent.$ ? parent.$ : cheerio.load('');
    return { kind: 'html', $, root: $(el), raw: null };
  }
  if (el.nodeType) return { kind: 'xml', doc: el.ownerDocument ?? parent?.doc, node: el, raw: null };
  if (typeof el === 'string') return makeContent(el);
  if (typeof el === 'object') return { kind: 'json', data: el, raw: JSON.stringify(el) };
  return { kind: 'text', text: String(el), raw: String(el) };
}

/**
 * 字段规则：返回字符串。
 * legado 语义：单字段失败降级为空（详情/列表整体继续），不炸穿调用方。
 */
export function analyzeStr(content, rule, ctx, isUrl = false) {
  if (rule == null) return '';
  if (typeof content === 'string') content = makeContent(content);
  try {
    const out = dispatch(content, String(rule).trim(), ctx, false, isUrl);
    if (out == null) return '';
    // JSON 对象/数组值 → JSON 字符串（legado elementToString：对象取 JSON 串，
    // 如 init: "data.book" 以对象 JSON 重根内容；repr/String 包装不受影响）
    const s = typeof out === 'object' && out !== null && !out.kind && !(out instanceof String)
      ? JSON.stringify(out)
      : String(out);
    return unescapeHtml(s);
  } catch (e) {
    console.warn(`analyzeStr failed [${String(rule).slice(0, 60)}]: ${e.message}`);
    return '';
  }
}

/** 总分发：|| / && / %% 拆分 → 单条方言执行
 *  isUrl（legado getString isUrl=true）：Default 方言取收集列表第一项（getString0），
 *  仅 bookUrl/tocUrl 等单值 URL 字段使用；JS/Json/XPath/CSS/正则方言不受影响 */
function dispatch(content, rule, ctx, list, isUrl = false) {
  // 1) JS 混排（<js> 段或 @js: 前缀，legado JS_PATTERN 分段语义）
  if (/<js>[\w\W]*?<\/js>|@js:/i.test(rule)) {
    return runJsRule(content, rule, ctx, list, isUrl);
  }
  // 2) ## 正则净化拆分（后半段为 match/replace）
  const { body, replaces } = splitReplace(rule);
  // AllInOne 正则（: 开头）：&& 是 AnalyzeByRegex 内部链式拆分（前条 findAll 匹配拼接
  // 为下条输入），不是组合符——legado AnalyzeRuleCore.getElements splitSourceRule(allInOne=
  // true) 单 SourceRule → AnalyzeByRegex.getElements(res, rule.splitNotBlank("&&"))
  if (body.startsWith(':')) {
    return finalize(regexAllInOne(getRaw(content), body.slice(1), list), replaces, list, ctx);
  }
  // 3) || / && / %% 顶层组合（引号与 {{}} 内不拆，legado 取最先出现的分隔符）
  const combo = splitCombo(body);
  if (combo.parts.length > 1) {
    if (combo.op === '||') {
      for (const part of combo.parts) {
        const r = dispatch(content, part, ctx, list, isUrl);
        if (nonEmpty(r, list)) return finalize(r, replaces, list, ctx);
      }
      return finalize(list ? [] : '', replaces, list, ctx);
    }
    if (combo.op === '%%') {
      // legado RuleCombiner：交叉合并（各结果第 i 项依次拼接）
      // legado getStringList：空结果列表不入 combineResults（isNullOrEmpty 不 add），
      // %% 交叉合并以第一个**非空**列表长度为准
      const rows = combo.parts.map((part) => {
        const r = dispatch(content, part, ctx, list, isUrl);
        return Array.isArray(r) ? r : (r ? [r] : []);
      }).filter((r) => r.length > 0);
      if (!rows.length || rows.every((r) => r.length === 0)) return finalize(list ? [] : '', replaces, list, ctx);
      const merged = [];
      // legado RuleCombiner：%% 交叉合并以第一个结果列表长度为准（不是最长）
      for (let i = 0; i < rows[0].length; i++) {
        for (const r of rows) if (i < r.length) merged.push(list ? r[i] : String(r[i]));
      }
      return finalize(list ? merged : merged.join('\n'), replaces, list);
    }
    // &&：全部执行拼接
    const merged = list ? [] : [];
    for (const part of combo.parts) {
      const r = dispatch(content, part, ctx, list, isUrl);
      if (list) merged.push(...(Array.isArray(r) ? r : r ? [r] : []));
      else if (r) merged.push(String(r));
    }
    return finalize(list ? merged : merged.join('\n'), replaces, list, ctx);
  }
  // 4) 单条规则 → 方言执行
  //  空规则段（legado isNotBlank || replaceRegex.isEmpty()：规则为空但有 ## 时跳过求值，
  //  结果保留内容本体——元素 repr 经 stringify 取 outerHtml 供 ## 正则匹配，如 66书吧
  //  bookUrl `##href="..."##.../$1/###`）
  const r = body || !replaces.length ? dispatchSingle(content, body, ctx, list, isUrl) : content;
  return finalize(r, replaces, list, ctx);
}

/** 单条规则方言分发 */
function dispatchSingle(content, rule, ctx, list, isUrl = false) {
  if (!rule) return list ? [] : '';
  // legado SourceRule 前缀判定顺序：@@ → Default（去前缀）；@CSS:；@XPath:；@Json:；$./$[；/ 开头
  if (rule.startsWith('@@')) rule = rule.slice(2);
  // legado $N 组引用（SourceRule.splitRegex/makeUpRule）：内容为正则 AllInOne 条目
  // （携带捕获组列表，组 0 = 整个匹配）→ $1-$99 替换为组值；非 $N 内容保留字面量。
  // 规则含 $N 即整条 Mode.Regex：组值/字面量拼接即结果，不再走分派（组值 '/' 开头
  // 也不得误判 XPath）
  if (content.groups && /\$\d{1,2}/.test(rule)) {
    return rule.replace(/\$\d{1,2}/g, (m) => {
      const v = content.groups[parseInt(m.slice(1), 10)];
      return v == null ? '' : String(v);
    });
  }
  // legado @put 尾缀（AnalyzeRule put 变量）：rule@put:{key:subrule} —— 子规则求值写入
  // 变量池后剥离尾缀再求主规则（如 $.bookname@put:{bookid:$.bookid} 返回书名并存 bookid）
  const putIdx = rule.indexOf('@put:{');
  if (putIdx >= 0) {
    const open = putIdx + 5;
    const close = matchBrace(rule, open);
    if (close > 0) {
      const inner = rule.slice(open + 1, close);
      const sep = inner.indexOf(':');
      const key = sep > 0 ? inner.slice(0, sep).trim() : '';
      if (key && ctx.vars) {
        ctx.vars.set(key, jsValueToString(dispatch(content, inner.slice(sep + 1).trim(), ctx, false)));
      }
      rule = rule.slice(0, putIdx) + rule.slice(close + 1);
    }
  }
  // legado @get:{key} 变量引用（AnalyzeUrl/AnalyzeRule get）：替换为变量池值（缺失置空）
  if (rule.includes('@get:{')) {
    rule = rule.replace(/@get:\{([^{}]*)\}/g, (m, k) => {
      const v = ctx.vars && ctx.vars.get(String(k).trim());
      return v == null ? '' : String(v);
    });
  }
  // URL 常量规则原样返回（legado analyzeUrl 分流）；含 {{}} 或 {$.
  // 内嵌模板的不直通——legado 字段求值（getString）阶段 URL 串同样进方言：
  // isJSON 内容时无前缀规则一律 Mode.Json（AnalyzeRuleCore SourceRule init），
  // AnalyzeByJSonPath.getString 的 innerRule("{$.") 做内嵌替换（如
  // "http://x.com/b/{$.wapBookId}.html"）；含 {{}} 走模板渲染
  if (/^[a-z]+:\/\//i.test(rule) && !rule.includes('{{') && !rule.includes('{$.')) return rule;
  // @CSS:（JSON 内容时 legado AnalyzeByCSS 元素集为空返回空；转 HTML 选择后同样为空，且不抛异常）
  if (/^@css:/i.test(rule)) {
    if (content.kind !== 'html') {
      const raw = content.kind === 'text' ? content.text : (content.raw != null ? content.raw : getResult(content));
      content.kind = 'html';
      content.$ = loadHtml(String(raw ?? ''));
    }
    ensureHtmlRoot(content);
    return analyzeCss({ $: content.$, root: content.root || content.$(':root') }, rule.slice(5), { list });
  }
  // 模板（含 {{）优先——JSON 上下文时注入 data 供 {{$.path}} 求值；
  // evalRule 供 {{@rule}} / {{//xpath}} 内嵌子规则求值（legado makeUpRule isRule 语义）
  if (rule.includes('{{')) {
    const varsCtx = { ...ctx, result: getResult(content), evalRule: (r) => dispatch(content, r, ctx, false) };
    if (content.kind === 'json') varsCtx.data = content.data;
    return render(rule, varsCtx);
  }
  // @JSON / $. / $[ / JSON 内容裸键（legado：isJSON || $. || $[ → Json；前缀判定忽略大小写。
  // isJSON 内容时无前缀规则也走 Json——含 {$.[@] 的 URL 模板规则由此进入内嵌替换）
  if (/^@json:/i.test(rule) || rule.startsWith('$.') || rule.startsWith('$[') ||
      (content.kind === 'json' && !rule.startsWith(':') && (!rule.includes('@') || rule.includes('{$.')))) {
    let data = content.kind === 'json' ? content.data : tryParseJson(content.raw ?? content.text);
    if (data === undefined && content.kind === 'json') data = content.data;
    if (data !== undefined) return analyzeJson({ data }, rule, { list });
    return list ? [] : '';
  }
  // @XPath / //（legado：任何 / 开头均为 XPath；前缀忽略大小写）
  if (/^@xpath:/i.test(rule) || rule.startsWith('/')) {
    ensureXml(content);
    return analyzeXpath({ doc: content.doc, node: content.node }, rule, { list });
  }
  // 纯正则（: 开头，legado AllInOne——组合拆分前的早退路径已接 regexAllInOne，此处兜底）
  if (rule.startsWith(':')) {
    return regexAllInOne(getRaw(content), rule.slice(1), list);
  }
  // 默认链（legado Mode.Default：isUrl=true 走 getString0 只取收集列表第一项）
  if (content.kind === 'html') {
    ensureHtmlRoot(content);
    return analyzeJsoup({ $: content.$, root: content.root || content.$(':root') }, rule, { list, single: isUrl });
  }
  if (content.kind === 'json') {
    return analyzeJson({ data: content.data }, rule, { list });
  }
  // text 内容：规则当正则用
  return regexExtract(getRaw(content), rule, list);
}

/** JS 混排规则：legado splitSourceRule 分段语义——
 *  JS_PATTERN(<js>...</js> | @js:贪婪到尾) 把规则切段，循环执行：
 *  JS 段 evalJS(result=前段输出)；普通段以上段输出为新内容做方言解析（result 链式传递） */
function runJsRule(content, rule, ctx, list, isUrl = false) {
  ctx = ctx || {}; // 调用方可省 ctx（root 注入与 JS 沙箱展开均需对象）
  const segs = splitSourceRuleJs(rule);
  // 首段 result 绑定整页内容（legado bindings["result"]=content）：HTML 内容绑元素代理
  // （ksoup Element 方法面 parentNode()/text()…），同时保留字符串协议（match/replace/拼接）
  let result = makeElementResult(content);
  let cur = content; // 普通段执行上下文：首段 = 原始 repr（保留元素上下文），JS 段后重建
  let lastOut = null; // 末段原始输出（list 模式保留数组形态）
  for (const seg of segs) {
    if (seg.js) {
      // legado JS 段同样支持 ## 尾巴（makeUpRule 拆分后应用于 JS 结果）
      const { body, replaces } = splitReplace(seg.code);
      // 社区源在 JS 段内嵌 {{$.field}}（如七猫 params={'id':{{$.id}}}）——legado 里 Rhino
      // 直接语法错误（analyzeJs 先于 replaceKeyPageJs），此处超集支持：先渲染模板再执行，
      // JSON 条目上下文可取 $.field（HTML 内容 $. 求值为空）
      const pre = body.includes('{{') && body.includes('}}')
        ? render(body, { ...ctx, result: jsValueToString(result), data: content.data })
        : body;
      // root 挂到原始 ctx（java 闭包 currentCtx 同源可见）：java.getString 默认根内容，
      // legado AnalyzeRule.getString 对 setContent 整页内容求值而非前段 result——
      // 如阿巴 chapterList JS 段 java.getString('$.data.freeContUrlPrefix') 从整页取前缀
      ctx.root = content;
      let out = runJs(pre, { ...ctx, result, root: content }, 60000);
      lastOut = out;
      const text = applyReplaces(jsValueToString(out), replaces, ctx);
      cur = makeContent(text);
      result = text;
    } else {
      lastOut = dispatch(cur, seg.code, ctx, list, isUrl);
      result = list && Array.isArray(lastOut) ? lastOut.map(jsValueToString).join('\n') : jsValueToString(lastOut);
      cur = makeContent(String(result ?? ''));
    }
  }
  if (!list) return result;
  // list 模式：末段数组形态优先（元素列表），否则字符串按行拆
  if (Array.isArray(lastOut)) return lastOut;
  const parsed = tryJsonArray(result);
  return parsed || arrayOrSplit(result);
}

/** JSON 数组解析（成功返回数组，失败 null） */
function tryJsonArray(s) {
  const t = String(s ?? '').trim();
  if (!t.startsWith('[')) return null;
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** list 模式：字符串按行拆为数组（legado getStringList 结果回 List） */
function arrayOrSplit(v) {
  if (Array.isArray(v)) return v;
  const s = v == null ? '' : String(v);
  return s ? s.split('\n') : [];
}

/** JS 值 → 字符串（整数不带小数，对象/数组 JSON 序列化） */
function jsValueToString(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    // String 包装（单元素代理）与 Elements 集合数组：字符串化取 outerHTML，不能 JSON.stringify
    if (v instanceof String || (Array.isArray(v) && typeof v.text === 'function')) return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/** legado JS_PATTERN 分段：<js>...</js>（懒）| @js:...（贪婪到尾） */
function splitSourceRuleJs(rule) {
  const segs = [];
  const re = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
  let last = 0, m;
  while ((m = re.exec(rule)) !== null) {
    if (m.index > last) {
      const t = rule.slice(last, m.index).trim();
      if (t) segs.push({ js: false, code: t });
    }
    segs.push({ js: true, code: m[2] !== undefined ? m[2] : (m[1] ?? '') });
    last = re.lastIndex;
    if (m[2] !== undefined) break; // @js: 贪婪，到尾
  }
  if (last < rule.length) {
    const t = rule.slice(last).trim();
    if (t) segs.push({ js: false, code: t });
  }
  return segs;
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** ## 拆分：[rule, match, replace, first?]（legado：第 4 段存在 → 只取首个匹配替换；规则段 trim）。
 *  首个 ## 需顶层平衡感知（{{}}/引号/[]() 内不拆）——legado makeUpRule 先摘 {{}}/@get 段求值
 *  拼接后才 rule.split("##")（AnalyzeRuleCore.kt L799），{{@@a@href##.html}} 的 ## 属于
 *  内嵌子规则（全本小说 bookUrl），朴素拆会把 }} 一起截断；净化段内 ## 按朴素拆（同 legado） */
function splitReplace(rule) {
  const idx = topIndexOf(rule, '##');
  if (idx < 0) return { body: rule, replaces: [] };
  const rest = rule.slice(idx + 2).split('##');
  return {
    body: rule.slice(0, idx).trim(),
    replaces: [{ match: rest[0] || '', replace: rest[1] ?? '', first: rest.length > 2 }],
  };
}

/** 顶层组合拆分（引号/花括号内不拆）；legado 语义：最先出现的分隔符决定组合类型 */
function splitCombo(rule) {
  const seps = ['||', '&&', '%%'];
  let best = -1, op = null;
  for (const sep of seps) {
    const idx = topIndexOf(rule, sep);
    if (idx >= 0 && (best < 0 || idx < best)) { best = idx; op = sep; }
  }
  if (!op) return { op: null, parts: [rule] };
  return { op, parts: splitByAll(rule, op) };
}

/** 顶层（引号/花括号/[]()平衡组外）分隔符首次出现位置；-1 无
 *  legado RuleAnalyzer.splitRule：分隔符位于筛选器 [...]/(...) 平衡组内时不切分 */
function topIndexOf(rule, sep) {
  let quote = null, depth = 0, sq = 0, pa = 0;
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"') { quote = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (c === '[') { sq++; continue; }
    if (c === ']') { sq--; continue; }
    if (c === '(') { pa++; continue; }
    if (c === ')') { pa--; continue; }
    if (depth === 0 && sq === 0 && pa === 0 && rule.startsWith(sep, i)) return i;
  }
  return -1;
}

/** 按分隔符顶层拆分（跳过引号/花括号/[]()平衡组内部） */
function splitByAll(rule, sep) {
  const a = sep[0], b = sep[1];
  let quote = null, depth = 0, sq = 0, pa = 0;
  const parts = [];
  let buf = '';
  const flush = () => { parts.push(buf); buf = ''; };
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i];
    if (quote) {
      buf += c;
      if (c === '\\') { buf += rule[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"') { quote = c; buf += c; continue; }
    if (c === '{') { depth++; buf += c; continue; }
    if (c === '}') { depth--; buf += c; continue; }
    if (c === '[') { sq++; buf += c; continue; }
    if (c === ']') { sq--; buf += c; continue; }
    if (c === '(') { pa++; buf += c; continue; }
    if (c === ')') { pa--; buf += c; continue; }
    if (depth === 0 && sq === 0 && pa === 0 && c === a && rule[i + 1] === b) { flush(); i++; continue; }
    buf += c;
  }
  flush();
  return parts.map((s) => s.trim());
}

/** ## 正则净化应用 */
function finalize(result, replaces, list, ctx) {
  if (!replaces.length) return result;
  if (list) return (Array.isArray(result) ? result : [result]).map((v) => applyReplaces(stringify(v), replaces, ctx));
  return applyReplaces(stringify(result), replaces, ctx);
}

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.kind) return getResult(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** ## 段内 {{}}/@get:{} 预求值（legado makeUpRule：evalPattern 覆盖整条规则含 ## 后段，
 *  {{}} 以当前内容为 result 求值后替换，再做 ## 拆分——如正文净化 ##{{book.name+"正文卷"+title}}） */
function evalRuleSegment(seg, s, ctx) {
  let out = seg;
  if (out.includes('@get:')) {
    out = out.replace(/@get:\{([^{}]*)\}/g, (m, k) => {
      const v = ctx && ctx.vars ? ctx.vars.get(String(k).trim()) : undefined;
      return v == null ? '' : String(v);
    });
  }
  if (out.includes('{{') && out.includes('}}')) {
    try {
      out = render(out, { ...(ctx || {}), result: s });
    } catch { /* 求值失败保留原文 */ }
  }
  return out;
}

/** ## 正则净化应用（first=true：仅取首个匹配文本做替换，无匹配为空——legado replaceFirst 语义） */
function applyReplaces(s, replaces, ctx) {
  let out = s;
  for (const r of replaces) {
    try {
      const match = evalRuleSegment(r.match, s, ctx);
      const replace = evalRuleSegment(r.replace, s, ctx);
      if (r.first) {
        // fork 语义：返回值是首个匹配文本的替换结果（不是整串），无匹配 → 空
        const m = new RegExp(match).exec(out);
        out = m ? replace.replace(/\$(\d{1,2})/g, (_, d) => m[d] ?? '') : '';
      } else {
        out = out.replace(new RegExp(match, 'g'), replace ?? '');
      }
    } catch {
      out = out.split(r.match).join(r.replace ?? '');
    }
  }
  return out;
}

/** HTML 实体解码（legado getString：结果含 & 时 unescapeHtml） */
export function unescapeHtml(s) {
  if (!s || !s.includes('&')) return s;
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return named[body.toLowerCase()] ?? m;
  });
}

/** 纯正则提取：非 list 有捕获组取组 1，否则整个匹配；
 *  list 时全量匹配，每个匹配产出携带组列表的条目（组 0 = 整个匹配，供字段规则 $N 引用——legado AnalyzeByRegex.getElements） */
function regexExtract(text, pattern, list) {
  if (!pattern) return list ? [] : '';
  try {
    if (list) {
      const re = new RegExp(pattern, 'g');
      const out = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        const groups = [];
        for (let g = 0; g < m.length; g++) groups.push(m[g] ?? '');
        out.push({ kind: 'text', text: m[0] ?? '', raw: m[0] ?? '', groups });
        if (m[0] === '') re.lastIndex++;
      }
      return out;
    }
    const m = new RegExp(pattern).exec(text);
    if (!m) return '';
    return m[1] !== undefined ? m[1] : m[0];
  } catch (e) {
    console.warn(`regex failed: ${pattern}: ${e.message}`);
    return list ? [] : '';
  }
}

/** AllInOne 正则（legado AnalyzeByRegex）：&& 盲拆链式——非末条规则 findAll 匹配文本
 *  拼接为下一条输入；末条 list=true 全量匹配产出带组条目（组 0=整匹配，$N 引用），
 *  list=false 有捕获组取组 1、无组取整匹配（getElement 组列表语义由调用方按索引消费，
 *  引擎 analyzeStr 字符串化场景取组 1 更兼容） */
function regexAllInOne(text, pattern, list) {
  const regs = String(pattern).split('&&').map((s) => s.trim()).filter((s) => s !== '');
  if (!regs.length) return list ? [] : '';
  let cur = text;
  for (let i = 0; i < regs.length; i++) {
    const last = i === regs.length - 1;
    try {
      if (last) return list ? regexExtract(cur, regs[i], true) : regexExtract(cur, regs[i], false);
      const re = new RegExp(regs[i], 'g');
      let acc = '', m;
      while ((m = re.exec(cur)) !== null) {
        acc += m[0] ?? '';
        if (m[0] === '') re.lastIndex++;
      }
      cur = acc;
    } catch (e) {
      console.warn(`regex failed: ${regs[i]}: ${e.message}`);
      return list ? [] : [];
    }
  }
  return list ? [] : [];
}

function nonEmpty(r, list) {
  if (list) return Array.isArray(r) && r.length > 0;
  return r !== '' && r != null;
}

function ensureHtmlRoot(content) {
  if (content.kind !== 'html') return;
  if (!content.root) content.root = content.$(':root');
}

function ensureXml(content) {
  if (content.kind === 'xml') return;
  if (content.kind === 'html' && content.raw != null) {
    content.kind = 'xml';
    content.doc = loadXml(content.raw);
    content.node = content.doc;
  } else if (content.kind === 'text') {
    content.kind = 'xml';
    content.doc = loadXml(content.text);
    content.node = content.doc;
  }
}

/** repr → 可读文本（regex/模板/JS result 绑定基准；元素 repr 取自身 outerHtml） */
function getResult(content) {
  if (content.kind === 'text') return content.text ?? '';
  if (content.kind === 'json') return content.raw ?? JSON.stringify(content.data);
  if (content.kind === 'html') {
    if (content.raw != null) return content.raw;
    if (content.root) return content.root.prop('outerHTML') || '';
    return content.$('body').html() ?? '';
  }
  if (content.kind === 'xml') return content.raw ?? (content.node ? String(content.node) : '');
  return '';
}

function getRaw(content) {
  return content.raw ?? getResult(content);
}

/** repr → 字符串（java.getElements 等外部消费） */
export const reprToString = getResult;

/** html repr → 元素代理（java.getElements 返回 jsoup Elements 风格对象——text()/attr() 方法面） */
export const elementProxy = makeElementResult;

/** legado JS 绑定 result = ksoup Elements 对象：元素方法面 + 字符串协议合一。
 *  载体为 new String(outerHTML)：字符串原型方法（match/replace/length…）天然可用，
 *  自有属性挂元素方法表（ksoup Node/Element 面）。不使用 Proxy——vm 沙箱 contextify
 *  会按自有属性枚举复制 Proxy，方法拦截在沙箱内失效。 */
function makeElementResult(content) {
  // legado：JSON 内容条目的 JS result 绑定对象（JsonElement→NativeObject）——
  // JSON.stringify(result) 产出单层 JSON 字符串（潇社 music lastChapter
  // put('json',JSON.stringify(result)) 依赖）；绑 raw 字符串会双重编码，
  // get 回来退化成正则匹配键名。toString 对齐 kotlinx JsonElement 语义：
  // String(result) 产出 JSON 文本（喜马拉雅 nextTocUrl JSON.parse(String(result)) 依赖）
  if (content.kind === 'json') {
    const data = content.data;
    if (data && typeof data === 'object') {
      try { data.toString = () => JSON.stringify(data); } catch { /* 冻结对象忽略 */ }
    }
    return data;
  }
  if (content.kind !== 'html' || !content.root || !content.root.length) return getRaw(content);
  const $ = content.$;
  const el = content.root;
  const wrap = (e) => (e && e.length ? wrapElement($, e) : null);
  const out = new String(el.prop('outerHTML') || '');
  Object.assign(out, {
    parentNode: () => wrap(el.parent()),
    parent: () => wrap(el.parent()),
    text: () => el.text(),
    ownText: () => el.clone().children().remove().end().text().trim(),
    html: () => el.html() ?? '',
    outerHtml: () => el.prop('outerHTML') || '',
    attr: (n) => (n == null ? '' : (el.attr(String(n)) ?? '')),
    select: (css) => makeElementsResult($, el.find(String(css))),
    children: () => makeElementsResult($, el.children()),
  });
  return out;
}

/** ksoup Elements 集合代理：数组载体（索引/length/join 天然可用）+
 *  Elements 方法面（text/attr 对集合操作，jsoup Elements API 语义） */
function makeElementsResult($, els) {
  const arr = (els ? els.toArray() : []).map((c) => wrapElement($, $(c)));
  arr.text = () => (els ? els.text() : '');
  arr.ownText = () => (els && els.length ? els.first().clone().children().remove().end().text().trim() : '');
  arr.attr = (n) => (els && els.length ? (els.first().attr(String(n)) ?? '') : '');
  arr.select = (css) => makeElementsResult($, els ? els.find(String(css)) : null);
  arr.children = () => makeElementsResult($, els ? els.children() : null);
  arr.first = () => (arr.length ? arr[0] : null);
  arr.last = () => (arr.length ? arr[arr.length - 1] : null);
  arr.toString = () => arr.map((e) => String(e)).join('');
  return arr;
}

/** 单元素 → String 载体代理（makeElementResult 的元素入参形式，供集合复用） */
function wrapElement($, el) {
  return makeElementResult({ kind: 'html', $, root: el, raw: null });
}

/** 从 open（'{' 处）找配对 '}' 索引（引号内与嵌套深度不误判），未闭合返回 -1 */
function matchBrace(s, open) {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
