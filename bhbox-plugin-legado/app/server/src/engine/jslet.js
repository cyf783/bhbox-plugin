// @js 方言（vm 沙箱）：@js: 前缀整段执行；<js>...</js> 段与普通规则混排链式执行
import { runJs } from './template.js';

/**
 * JS 规则执行。
 * @param {object} ctx 执行上下文 { java, source, book, result, baseUrl, vars, page, key }
 * @param {string} rule 规则串
 * @param {object} o { list }
 * @returns {string|string[]}
 */
export function analyzeJs(ctx, rule, { list = false } = {}) {
  const out = execMixed(ctx, String(rule), ctx.result ?? '');
  if (list) {
    if (Array.isArray(out)) return out.map((v) => (v == null ? '' : String(v)));
    return out ? [String(out)] : [];
  }
  if (Array.isArray(out)) return out.map((v) => (v == null ? '' : String(v))).join('\n');
  return out == null ? '' : String(out);
}

/**
 * 混排执行：<js>..</js> 与普通文本交替。
 * - js 段在沙箱执行，result 变量承接上一轮结果，返回值成为新的 result
 * - 普通文本段作为「后续规则」标记（本入口不做 jsoup 解析——由 analyzer 混排后调用），此处仅串接为 result 传递
 * 兼容 legado 写法 "<js>...</js>" 与 "@js:..."
 */
export function execMixed(ctx, rule, initialResult, timeout = 60000) {
  let result = initialResult;
  const jsRe = /<js>([\s\S]*?)<\/js>/g;
  let rest = rule;
  let m;
  const segments = [];
  let lastIdx = 0;
  let hasJs = false;
  while ((m = jsRe.exec(rule)) !== null) {
    hasJs = true;
    if (m.index > lastIdx) segments.push({ js: false, code: rule.slice(lastIdx, m.index) });
    segments.push({ js: true, code: m[1] });
    lastIdx = jsRe.lastIndex;
  }
  if (lastIdx < rule.length) segments.push({ js: false, code: rule.slice(lastIdx) });

  if (!hasJs) {
    // 无 <js> 标记：支持 @js: 前缀整段
    let code = rule;
    if (code.startsWith('@js:')) code = code.slice(4);
    else if (code.startsWith('@JS:')) code = code.slice(4);
    else if (code.startsWith('js:')) code = code.slice(3);
    return runJs(code, { ...ctx, result }, timeout);
  }

  for (const seg of segments) {
    if (seg.js) {
      result = runJs(seg.code, { ...ctx, result }, timeout);
    } else {
      // legado analyzeJs useSegment：JS 段间/后的非空文本段覆盖 result
      const t = seg.code.trim();
      if (t) result = t;
    }
  }
  return result;
}
