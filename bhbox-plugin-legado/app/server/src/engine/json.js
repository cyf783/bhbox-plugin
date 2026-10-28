/** @JSON 方言（jsonpath-plus）：@json: 前缀或 $. 开头；裸键名按相对路径处理 */
import { JSONPath } from 'jsonpath-plus';

/** 单值查询：{{$.path}} 模板用（legado getString 语义：多值 join('\n')；data 非对象返回空） */
export function jsonLookup(data, path) {
  if (data == null || typeof data !== 'object') return '';
  const values = JSONPath({ path: path.startsWith('$') ? path : '$.' + path, json: data, wrap: true });
  return (values || []).map(elementToString).join('\n');
}

/**
 * JSON 规则执行。
 * @param {object} el { data: 任意 JSON 值 }
 * @param {string} rule 如 $.data.list[*].name / @json:$.x / name
 * @param {object} o { list }
 */
export function analyzeJson(el, rule, { list = false } = {}) {
  let path = String(rule).trim();
  if (/^@json:/i.test(path)) path = path.slice(6).trim();
  // legado innerRule("{$.")：{$.rule} 内嵌模板替换优先；全部替换成功则直接返回模板串，
  // 无成功替换才走 JSONPath（内嵌求值为空时该段原样保留继续找下一处）
  if (path.includes('{$.')) {
    const t = innerTemplate(el, path);
    if (t !== null) return list ? [t] : t;
  }
  if (!path.startsWith('$')) path = '$.' + path;
  // legado：内容非 JSON 时 AnalyzeByJSonPath 不执行（isNullOrEmpty → 返回空，不炸不报错）
  if (el.data == null || typeof el.data !== 'object') return list ? [] : '';
  let values = [];
  try {
    values = JSONPath({ path, json: el.data, wrap: true });
  } catch (e) {
    console.warn(`jsonpath failed: ${path}: ${e.message}`);
    return list ? [] : '';
  }
  if (list) {
    // JSONPath 选中数组本身时展开为元素（如 bookList: $.data）
    if (values.length === 1 && Array.isArray(values[0])) return values[0];
    return values.map(toScalar).filter((v) => v !== null);
  }
  // legado AnalyzeByJSonPath.getString：多值 joinToString("\n")，含空值；
  // 数组单值展开元素（elementToString），对象取 JSON 文本
  return values.map(elementToString).join('\n');
}

/** legado elementToString：null→''、标量取字面值、数组展开元素 join('\n')（非原始项取 JSON 文本）、对象取 JSON 文本 */
function elementToString(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    return v.map((item) => (item === null || item === undefined ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item))).join('\n');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 对象数组元素→字符串时 JSON 压缩；标量直出 */
function toScalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** {$.rule} 内嵌模板替换（legado RuleAnalyzer.innerRule：引号感知平衡扫描，
 *  内嵌规则递归 analyzeJson，求值非空才替换；全部成功返回模板串，无成功替换返回 null） */
function innerTemplate(el, rule) {
  let out = '', last = 0, i = 0, replaced = false;
  while (true) {
    const open = rule.indexOf('{$.', i);
    if (open < 0) break;
    const close = matchBrace(rule, open);
    if (close < 0) break;
    const v = analyzeJson(el, rule.slice(open + 3, close), { list: false });
    if (v) {
      out += rule.slice(last, open) + v;
      last = close + 1;
      replaced = true;
      i = close + 1;
    } else {
      i = open + 3; // 该段未取到值，{$. 当普通文本继续找下一处
    }
  }
  if (!replaced) return null;
  return out + rule.slice(last);
}

/** 从 start（指向 {）找配对 }（引号内不参与，{} 计数平衡） */
function matchBrace(s, start) {
  let depth = 0, quote = null;
  for (let i = start; i < s.length; i++) {
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
