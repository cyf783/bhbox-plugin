// @XPath 方言（@xmldom/xmldom + xpath）：@XPath: 前缀、// 或 @/ 开头
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseDocument } from 'htmlparser2';
import xpath from 'xpath';

/** 文本/属性序列化转义 */
function escText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

/** domhandler 节点树 → 规范 XML 字符串（标签强制闭合、属性去重加引号、文本转义、
 *  命名实体已由 htmlparser2 解码为字符，产物可直接喂 xmldom XML 模式） */
function serializeNode(node, out) {
  if (node.type === 'text') { out.push(escText(node.data)); return; }
  if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return; // 注释/doctype 丢弃
  const name = node.name;
  if (!name) return;
  let attrs = '';
  const seen = new Set();
  for (const a of node.attributes || []) {
    if (seen.has(a.name)) continue; // XML 不允许重复属性
    seen.add(a.name);
    attrs += ` ${a.name}="${escAttr(a.value ?? '')}"`;
  }
  if (node.children && node.children.length) {
    out.push(`<${name}${attrs}>`);
    for (const c of node.children) serializeNode(c, out);
    out.push(`</${name}>`);
  } else {
    out.push(`<${name}${attrs}/>`);
  }
}

/** HTML 文本 → XML 文档。真实页面是脏 HTML（未闭合 script/div、&nbsp; 等命名实体在
 *  XML 未定义、属性缺引号），xmldom 任何模式整篇抛错 → 用 htmlparser2 容错解析
 *  后序列化为规范 XML 再交给 xmldom+xpath（legado 用 Jsoup 同思路） */
export function loadXml(text) {
  try {
    const doc = parseDocument(String(text || ''), { decodeEntities: true });
    const out = [];
    for (const c of doc.children) serializeNode(c, out);
    return new DOMParser({ onError: () => {} }).parseFromString(out.join(''), 'application/xml');
  } catch (e) {
    return new DOMParser({ onError: () => {} }).parseFromString('<root/>', 'application/xml');
  }
}

/**
 * XPath 规则执行。
 * @param {object} el { doc: XML Document, node: 上下文节点（可空） }
 * @param {string} rule 如 //div[@class="a"]/text() 或 @XPath://a/@href
 * @param {object} o { list }
 */
export function analyzeXpath(el, rule, { list = false } = {}) {
  let expr = String(rule).trim();
  if (/^@xpath:/i.test(expr)) expr = expr.slice(7).trim();
  else if (expr.startsWith('@/')) expr = expr.slice(1); // @/xxx → /xxx
  let nodes = [];
  try {
    const ctx = el.node || el.doc;
    // legado JsoupXpath 语义：// 与 / 开头相对当前上下文节点（字段规则在条目元素内查找），
    // 标准 XPath 的 // 是文档绝对路径——元素上下文时补 . 前缀对齐（//x → .//x，/x → ./x），
    // 否则所有条目的字段都从整页求值，结果雷同被去重只剩一条
    if (ctx.nodeType === 1 && (expr.startsWith('//') || expr.startsWith('/'))) expr = '.' + expr;
    nodes = xpath.select(expr, ctx);
  } catch (e) {
    console.warn(`xpath failed: ${expr}: ${e.message}`);
    return list ? [] : '';
  }
  if (list) return nodes.filter((n) => n.nodeType === 1); // 列表模式保留元素节点（供字段规则继续在节点内查询）
  const strs = nodes.map(nodeValue).filter((v) => v !== null && v !== undefined && v !== '');
  return strs.join('\n');
}

/** 节点 → 字符串（属性节点取 value，文本节点取 data，元素取 textContent，其他序列化） */
function nodeValue(n) {
  if (n == null) return null;
  if (n.nodeType === 2) return n.value ?? '';       // attribute
  if (n.nodeType === 3) return n.data ?? '';        // text
  if (n.nodeType === 1) return n.textContent ?? ''; // element
  try { return new XMLSerializer().serializeToString(n); } catch { return null; }
}
