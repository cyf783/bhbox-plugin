// 默认 jsoup 规则链 + @CSS:（cheerio 实现，对应 legado AnalyzeByJSoup / AnalyzeByCSS）
// 默认链: class.xxx.0@tag.a@text — 段间 @ 分隔，段类型 class/id/tag/children + [index]
// 索引: 0 起；-1 最后；0:3 范围；!0 排除；缺省取全部
// 取值后缀: text / ownText / textNodes / html / all / href / src / 其他属性名 / children
import * as cheerio from 'cheerio';

/** HTML 文本 → cheerio 根 */
export function loadHtml(text) {
  return cheerio.load(text || '');
}

/** 判断对象是否 cheerio 元素（有 tagName/attribs 特征） */
export function isElement(el) {
  return el && typeof el === 'object' && el.type === 'tag' && el.name;
}

/** 元素 → 单元素包装（$ 函数） */
function wrap($, el) {
  const fn = $(el);
  return fn;
}

/**
 * 默认规则链执行。
 * @param {object} el 上下文：{$, element|undefined}，$ 为 cheerio 实例，element 为当前根（可空=全文档）
 * @param {string} rule 规则串
 * @param {object} o { list: boolean } list=true 返回元素/字符串数组；false 返回拼接字符串
 */
export function analyzeJsoup(el, rule, { list = false, single = false } = {}) {
  const { $, root } = el;
  let current = root; // cheerio 选择结果集合

  // 拆段：@ 分隔（属性值不含 @；CSS 选择器类规则不走此入口）
  const segs = String(rule).split('@').map((s) => s.trim()).filter(Boolean);
  let getter = null;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    // 取值段必为末段（legado getString：前面段全走元素选择，仅最后一段做取值判断）。
    // list 模式（选元素列表，如 chapterList）不做取值判断——裸单词末段（如单段 a）在
    // legado getElements 中走 css 选择，若误判为属性 getter 会把选元素变成取属性。
    if (!list && i === segs.length - 1) {
      const g = getterOf(seg);
      if (g) { getter = g; break; }
    }
    const sel = parseSeg(seg);
    if (!sel) continue;
    current = applySeg($, current, sel);
    if (!current || current.length === 0) return list ? [] : '';
  }

  // 应用取值
  if (!getter) {
    if (list) {
      const out = [];
      current.each((_, e) => out.push(e));
      return out;
    }
    return current.length ? (current[0].type === 'text' ? current[0].data : $.html(current)).trim() : '';
  }
  return applyGetter($, current, getter, list, single);
}

/** 段是否为取值段（text/html/all/ownText/textNodes/属性名）
 *  legado getResultLast：text/textNodes/ownText/html/all 之外一律按 attr 处理
 *  （含 class/id/tag/children → attr 取值，无该属性则空） */
function getterOf(seg) {
  const s = seg.trim();
  if (s === 'text' || s === 'ownText' || s === 'textNodes' || s === 'html' || s === 'all') return { type: s };
  if (/^(data-[\w-]+|[a-zA-Z][\w-]*)$/.test(s)) return { type: 'attr', name: s };
  return null;
}

/** legado ElementsSingle.findIndexSet 头部分支：尾部 [index…] 方括号索引集（tag.a[-1:0]、tag.span[0:1]、children[0]）。
 *  区间两端可省略（[:3] start=0、[1:] end=末尾）；内容须为纯索引语法才剥离——css 属性选择器 [data-x]/[href^=/x] 原样保留 */
const IDX_TOKEN = "(?:last|-?\\d*)";
const INDEX_SET_RE = new RegExp(
  `^!?(?:${IDX_TOKEN}(?::${IDX_TOKEN}){0,2})(?:,(?:${IDX_TOKEN}(?::${IDX_TOKEN}){0,2}))*$`
);

/** 解析选择段：先剥离尾部方括号索引集，其余交给 parseSegInner */
function parseSeg(seg) {
  let set = '';
  const bm = /\[([^\[\]]+)\]$/.exec(seg);
  if (bm) {
    const body = bm[1].replace(/\s+/g, '');
    if (INDEX_SET_RE.test(body)) {
      set = body;
      seg = seg.slice(0, bm.index);
    }
  }
  // legado：索引集作独立段（head@[1]@text）时前置规则为空，效果与 children 相同
  if (!seg && set) return { kind: 'children', name: '', index: '', set };
  const sel = parseSegInner(seg);
  sel.set = set;
  return sel;
}

/** 解析选择段：class.NAME[idx] / id.NAME[idx] / tag.NAME[idx] / .NAME / #NAME / 裸标签 / children。
 *  含空格的组合选择器（.sumchapter a）→ legado css 回退（elements.select），支持尾部索引（.0:3 / !0） */
function parseSegInner(seg) {
  if (seg === 'children') return { kind: 'children' };
  // legado：索引作每段首规则等价 children（head@.1@text ≙ head@children[1]@text）
  let m0 = /^\.(\d+(?::-?\d+)*|!\d+(?::-?\d+)*)$/.exec(seg);
  if (m0) return { kind: 'children', index: m0[1] };
  if (/\s/.test(seg)) {
    const { css, index } = splitCssIndex(seg);
    return { kind: 'css', css, index };
  }
  // 简写：.class / #id
  let m = /^\.([\s\S]+)$/.exec(seg);
  if (m) return splitNameIndex('class', m[1]);
  m = /^#([\s\S]+)$/.exec(seg);
  if (m) return splitNameIndex('id', m[1]);
  m = /^(class|id|tag|text)\.([\s\S]+)$/.exec(seg);
  if (m) return splitNameIndex(m[1], m[2]);
  // 裸标签简写：tagname / tagname.0 / tagname.-1（纯标签名 + 索引）。
  // 无点尾缀排除（tr!0）为社区源常见宽松写法（legado 规范为 tr.!0），按排除索引处理；
  // 其余（a.title、div[data-x] 等含非数字点）→ legado 走 css select，交给 css 回退分支
  const bare = /^([a-zA-Z][\w-]*)(!(-?\d+(?::-?\d+)*|last))?$/.exec(seg);
  if (bare) return { kind: 'tag', name: bare[1], index: bare[2] || '' };
  if (/^[a-zA-Z][\w-]*(!?(-?\d+(?::-?\d+)*|last))?$/.test(seg)) return splitNameIndex('tag', seg);
  const { css, index } = splitCssIndex(seg);
  return { kind: 'css', css, index };
}

/** css 段尾部索引剥离：.face-info span.0:3 → css='.face-info span', index='0:3'；.newrap a.0 → index='0'（数字类名源罕见，牺牲保索引语义）。
 *  索引为传统离散写法：冒号分隔离散索引（0:2 = 第 0 与第 2 个）、支持负数、! 前缀排除（!0 或 !0:2） */
function splitCssIndex(css) {
  const m = /[.!](-?\d+(?::-?\d+)*|!-?\d+(?::-?\d+)*)$/.exec(css);
  if (!m) return { css, index: '' };
  return { css: css.slice(0, m.index), index: m[1] };
}

/** NAME.INDEX 拆分（类名含点兜底：多段合回索引位；无点尾缀 !N 归入排除索引，如 tag.tr!0） */
function splitNameIndex(kind, rest) {
  const parts = rest.split('.');
  const name = parts[0];
  let index = parts[1] || '';
  if (parts.length > 2) index = parts.slice(1).join('.');
  if (!index) {
    const bm = /^([\s\S]+)!(\d+|last|-?\d+(?::-?\d+)*)$/.exec(name);
    if (bm) return { kind, name: bm[1], index: '!' + bm[2] };
  }
  return { kind, name, index };
}

/** 应用选择段到当前集合（legado 语义：每元素内查找，索引作用于各自结果集） */
function applySeg($, current, sel) {
  const out = [];
  current.each((_, e) => {
    let pool = [];
    if (sel.kind === 'children') {
      if (e.children) for (const c of e.children) if (c.type === 'tag') pool.push(c);
    } else if (sel.kind === 'text') {
      // legado getElementsContainingOwnText：own text 含指定文本的元素（含自身与后代）
      if (ownTextOf(e).includes(sel.name)) pool.push(e);
      $(e).find('*').each((_, f) => { if (ownTextOf(f).includes(sel.name)) pool.push(f); });
    } else {
      const { kind, name } = sel;
      if (kind === 'css') {
        $(e).find(sel.css).each((_, f) => pool.push(f));
      } else if (kind === 'id') {
        if (e.attribs && e.attribs.id === name) pool.push(e);
        $(e).find(`#${cssEscape(name)}`).each((_, f) => pool.push(f));
      } else if (kind === 'class') {
        if (hasClass(e, name)) pool.push(e);
        $(e).find(`.${cssEscape(name)}`).each((_, f) => pool.push(f));
      } else {
        if (e.name === name) pool.push(e);
        $(e).find(cssEscape(name)).each((_, f) => pool.push(f));
      }
    }
    // 去重保持顺序，再按索引裁剪（0 起 / -1 尾 / 0:3 闭区间范围 / !0 排除 / 逗号多段）
    const seen = new Set();
    const uniq = [];
    for (const f of pool) if (!seen.has(f)) { seen.add(f); uniq.push(f); }
    out.push(...applyIndexSet(applyIndexTo(uniq, sel.index), sel.set));
  });
  return $(out);
}

function hasClass(el, name) {
  const cls = el.attribs && el.attribs.class;
  return cls ? cls.split(/\s+/).includes(name) : false;
}

/** 元素直接文本（不含后代元素内文本），对应 jsoup ownText */
function ownTextOf(e) {
  if (!e || !e.children) return '';
  return e.children.filter((c) => c.type === 'text').map((c) => c.data || '').join(' ').replace(/\s+/g, ' ').trim();
}

function cssEscape(s) {
  return String(s).replace(/([^\w-])/g, '\\$1');
}

/** 索引过滤（数组版，legado 传统写法 findIndexSet 尾分支）：
 *  ':' 分隔**离散**索引（如 0:2 = 第0与第2个，非区间；区间用 [] 方括号式）；
 *  负数倒数；!前缀 = 排除其后索引；逗号分隔多组 */
function applyIndexTo(all, indexSpec) {
  if (!indexSpec) return all;
  let out = all;
  for (const tk of String(indexSpec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const excl = tk.startsWith('!');
    const picks = [];
    for (const part of (excl ? tk.slice(1) : tk).split(':')) {
      if (!part) continue;
      const i = part === 'last' ? out.length - 1 : resolveIndex(out.length, part);
      if (i !== null) picks.push(i);
    }
    if (excl) {
      if (picks.length) out = out.filter((_, i) => !picks.includes(i));
    } else {
      out = picks.map((i) => out[i]);
    }
  }
  return out;
}

/** 方括号索引集（legado findIndexSet head 分支语义）：并集、保序、去重；
 *  `!` 开头为排除；区间 start:end[:step] 支持负数端点与倒序（[-1:0] 反转列表）；
 *  start 省略=0、end 省略=末尾（[:3]、[1:]） */
function applyIndexSet(all, spec) {
  if (!spec) return all;
  const len = all.length;
  const excl = spec.startsWith('!');
  const picked = [];
  const seen = new Set();
  const add = (i) => { if (i >= 0 && i < len && !seen.has(i)) { seen.add(i); picked.push(i); } };
  for (const tk of (excl ? spec.slice(1) : spec).split(',')) {
    const r = /^(-?\d*):(-?\d*)(?::(-?\d+))?$/.exec(tk);
    if (r && (r[1] !== '' || r[2] !== '')) {
      let s = r[1] === '' ? 0 : parseInt(r[1], 10);
      let e = r[2] === '' ? len - 1 : parseInt(r[2], 10);
      if (s < 0) s += len;
      if (e < 0) e += len;
      if ((s < 0 && e < 0) || (s >= len && e >= len)) continue;
      s = Math.max(0, Math.min(len - 1, s));
      e = Math.max(0, Math.min(len - 1, e));
      const step = Math.abs(parseInt(r[3] || '1', 10)) || 1;
      if (e >= s) for (let i = s; i <= e; i += step) add(i);
      else for (let i = s; i >= e; i -= step) add(i);
    } else if (tk === 'last') {
      add(len - 1);
    } else {
      const i = parseInt(tk, 10);
      if (!Number.isNaN(i)) add(i < 0 ? i + len : i);
    }
  }
  if (excl) return all.filter((_, i) => !seen.has(i));
  return picked.map((i) => all[i]);
}

/** 解析单个索引（0 起；负数从尾计）→ 下标或 null（无效） */
function resolveIndex(len, tk) {
  if (!/^-?\d+$/.test(tk)) return null;
  let i = parseInt(tk, 10);
  if (i < 0) i = len + i;
  if (i < 0 || i >= len) return null;
  return i;
}

/** 应用取值后缀
 *  single（legado getString0，isUrl=true 时 Default 方言专用）：取收集列表第一项而非 join */
function applyGetter($, current, getter, list, single = false) {
  const one = (e) => {
    const el = $(e);
    switch (getter.type) {
      case 'text': return el.text().replace(/\s+/g, ' ').trim();
      case 'ownText': return el.clone().children().remove().end().text().trim();
      case 'textNodes': {
        const parts = [];
        e.children && e.children.forEach((c) => { if (c.type === 'text' && c.data && c.data.trim()) parts.push(c.data.trim()); });
        return parts.join('\n');
      }
      case 'html': {
        // legado：html 取值移除 script/style 后取 outerHtml；all 不移除
        const clone = el.clone();
        clone.find('script,style').remove();
        return $.html(clone) || '';
      }
      case 'all': return $.html(el) || '';
      case 'attr': return el.attr(getter.name) || '';
      default: return '';
    }
  };
  let vals;
  if (getter.type === 'attr') {
    // legado attr 取值：跳过空白且跨元素去重
    const seen = new Set();
    vals = [];
    for (const e of current.toArray()) {
      const v = $(e).attr(getter.name) || '';
      if (!v.trim() || seen.has(v)) continue;
      seen.add(v);
      vals.push(v);
    }
  } else {
    vals = current.toArray().map(one).filter((v) => v !== null && v !== undefined && v !== '');
  }
  if (list) return vals;
  if (single) return vals[0] ?? '';
  return vals.join('\n');
}

/**
 * @CSS: 规则（cheerio 原生选择器 + @text/@html/@attr 尾缀）
 * "@css:div.a@text" → { selector: 'div.a', getter: 'text' }
 */
export function analyzeCss(el, rule, { list = false } = {}) {
  const { $, root } = el;
  let selector = rule;
  let getter = null;
  const at = rule.lastIndexOf('@');
  const tail = at > 0 ? rule.slice(at + 1).trim() : '';
  if (/^(text|ownText|textNodes|html|all)$/.test(tail) || /^(data-[\w-]+|[a-zA-Z][\w-]*)$/.test(tail)) {
    selector = rule.slice(0, at);
    getter = getterOf(tail);
  }
  const selected = selector.trim() ? root.find ? root.find(selector) : $(selector) : root;
  if (getter) return applyGetter($, selected, getter, list);
  if (list) return selected.toArray();
  return selected.length ? (selected[0].type === 'text' ? selected[0].data : $.html(selected)).trim() : '';
}
