// 书源加载/合并/去重/兼容性标记（阅读APP 3.0 书源格式）
//
// 输入经环境变量 LEGADO_PARAMS 注入（Java 层打包）：
//   { "remoteUrls": "http://a/1.json\nhttp://b/2.json", "localFile": "/path/shuyuan.txt" }
// 加载顺序：本地文件 → 网络 URL 依次；同一 bookSourceUrl 首见胜出（本地优先，后到者不覆盖）。
// 收录过滤：enabled !== false；音频源（bookSourceType 1）play 返回直链由宿主播放器播放；
//          规则含 startBrowserAwait 等强 WebView 特征标记不兼容（不入订阅，/status 报告原因）。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

export const md5 = (s) => createHash('md5').update(String(s)).digest('hex');
export const siteKeyOf = (src) => 'legado_' + md5((src.bookSourceUrl || '').trim());

// 强 WebView 交互特征：书源规则依赖内置浏览器（验证码/登录），无 WebView 环境不可用
const INCOMPATIBLE_MARKERS = ['startBrowserAwait', 'startBrowser'];

// 规则/URL 字段（兼容性扫描范围，排除 comment 等说明文本）
const RULE_KEYS = [
  'searchUrl', 'exploreUrl', 'loginUrl', 'jsLib',
  'ruleSearch', 'ruleExplore', 'ruleBookInfo', 'ruleToc', 'ruleContent',
];

/** 解析 LEGADO_PARAMS JSON 字符串 → { remoteUrls: [], localFile: '' } */
export function parseParams(raw) {
  let p = {};
  try { p = JSON.parse(raw || '{}') || {}; } catch { p = {}; }
  const remoteUrls = String(p.remoteUrls || '')
    .split('\n').map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  return { remoteUrls, localFile: String(p.localFile || '').trim() };
}

/** 本地书源参数 → 可读路径：file:// URI（宿主文件选择器产物）转绝对路径，
 *  中文等非 ASCII 由 fileURLToPath 自动解码；已是绝对路径原样返回 */
export function toLocalPath(v) {
  const s = String(v || '').trim();
  if (!/^file:\/\//i.test(s)) return s;
  try { return fileURLToPath(s); } catch { return s.replace(/^file:\/\//i, ''); }
}

/** 解析一段书源 JSON 文本（数组 / 单对象）→ 数组；解析失败抛错 */
export function parseBookSources(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data.filter((s) => s && typeof s === 'object');
  if (data && typeof data === 'object') {
    if (Array.isArray(data.data)) return data.data; // 部分订阅包装 {data:[...]}
    return [data];
  }
  throw new Error('书源 JSON 需为数组或单对象');
}

/** 规则字段是否依赖 WebView（不兼容标记） */
export function isIncompatible(src) {
  for (const key of RULE_KEYS) {
    const v = src[key];
    if (v == null) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    for (const marker of INCOMPATIBLE_MARKERS) {
      if (text.includes(marker)) return marker;
    }
  }
  return null;
}

const fetchWithTimeout = (url, ms = 15000) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal, redirect: 'follow' }).finally(() => clearTimeout(timer));
};

/**
 * 按参数加载全部书源。
 * @returns {{ list: Array, report: { loaded: Array, errors: Array, skipped: Array, incompatible: Array } }}
 *   list: 已排序（customOrder 升序）的启用且兼容书源数组；report: 各环节概况
 */
export async function loadSources(params) {
  const merged = new Map(); // bookSourceUrl → source（首见胜出）
  const report = { loaded: [], errors: [], skipped: [], incompatible: [] };

  const mergeText = (text, from) => {
    try {
      const arr = parseBookSources(text);
      let fresh = 0;
      for (const src of arr) {
        const key = String(src.bookSourceUrl || '').trim();
        if (!key) continue;
        if (merged.has(key)) continue; // 后到者不覆盖（本地优先于网络，先载者优先于后载）
        merged.set(key, src);
        fresh++;
      }
      report.loaded.push({ from, count: arr.length, fresh });
      return null;
    } catch (e) {
      report.errors.push({ from, error: e.message });
      return e;
    }
  };

  // 1) 本地文件（优先级最高）。宿主文件选择器产出 file:// URI（中文路径含 %XX 编码），
  //    readFileSync 不认 scheme → 统一转绝对路径；畸形 URI 兜底粗剥 file:// 前缀
  if (params.localFile) {
    const path = toLocalPath(params.localFile);
    try {
      mergeText(readFileSync(path, 'utf-8'), 'local:' + path);
    } catch (e) {
      report.errors.push({ from: 'local:' + path, error: e.message });
    }
  }
  // 2) 网络 URL（依次下载，任一失败不影响其余）
  for (const url of params.remoteUrls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      mergeText(await res.text(), url);
    } catch (e) {
      report.errors.push({ from: url, error: e.message });
    }
  }

  // 3) 过滤 + 排序
  const list = [];
  for (const src of merged.values()) {
    const name = src.bookSourceName || src.bookSourceUrl;
    if (src.enabled === false) { report.skipped.push({ name, reason: '未启用' }); continue; }
    const marker = isIncompatible(src);
    if (marker) { report.incompatible.push({ name, reason: '依赖WebView:' + marker }); continue; }
    list.push(src);
  }
  list.sort((a, b) => (a.customOrder || 0) - (b.customOrder || 0));
  return { list, report };
}

/**
 * 书源列表 → T4 站点数组（/config 用）。
 * api 按请求 Host 动态构造：端口漂移随宿主刷新订阅自愈；局域网设备亦可直接订阅。
 */
export function buildSites(sources, host) {
  return sources.map((src) => {
    const hash = md5((src.bookSourceUrl || '').trim());
    return {
      key: 'legado_' + hash,
      name: src.bookSourceName || src.bookSourceUrl,
      type: 4,
      api: `http://${host}/api/${hash}`,
      searchable: src.searchUrl ? 1 : 0,
      quickSearch: 1,
      filterable: 0,
    };
  });
}
