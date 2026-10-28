// T4 五动作：home / list / detail / search / play（legado 书源 → TVBox T4 JSON）
import { createHash } from 'crypto';
import { analyzeList, analyzeStr, makeContent } from '../engine/analyzer.js';
import { render } from '../engine/template.js';
import { execMixed } from '../engine/jslet.js';
import { fetchText } from '../engine/http.js';
import { splitUrlRule, parseUrlRule, parseOptions } from '../engine/urlrule.js';
import { createJavaApi, parseSourceHeaders, cache, clearCache } from '../engine/java-api.js';

const md5 = (s) => createHash('md5').update(String(s)).digest('hex');

// TOC 缓存：md5(bookUrl) → { at, chapters }（P0 最简 TTL 缓存，reload 时清空）
const tocCache = new Map();
const TOC_TTL = 30 * 60 * 1000;
const MAX_TOC_CACHE = 200;     // 目录缓存上限（千章大对象防内存膨胀，超限删最早）
const MAX_TOC_PAGES = 20;      // nextTocUrl 翻页上限（防死循环）
const MAX_CONTENT_PAGES = 10;  // nextContentUrl 翻页上限
export function clearCaches() { tocCache.clear(); bookVars.clear(); chapterCtxs.clear(); clearCache(); }

/** 源级持久变量池（legado variables 语义：java.put/get 与 @put/@get 跨请求共享，
 *  如七猫 searchUrl put 的 headers 变量在详情 tocUrl JS 里 java.get 复用） */
const sourceVars = new Map();

/** 书级变量快照：sk → Map(bookUrl → Map(key→val))。legado 里 put 变量存 book 实例
 *  （searchBook → 详情同一对象，变量随书走）；T4 请求无状态，以搜索阶段 bookItem
 *  执行前后的池 diff 作该书快照，详情阶段合并回放——否则多本书依次 put 同名变量
 *  （如阿巴 bid）在源级池互相覆盖，详情 java.get 串台 */
const bookVars = new Map();
const MAX_BOOK_VARS = 300; // 每源书籍快照上限（超限删最早）

/** 章节上下文缓存：md5(sk|chapterUrl) → { book, chapter:{title,index} }。play 阶段查回注入
 *  makeCtx——legado AnalyzeRule.chapter/book 绑定（正文规则 JS 的 chapter.title/title/book.name
 *  引用依赖此缓存）；T4 无状态，detail 目录阶段写入 */
const chapterCtxs = new Map();
const MAX_CHAPTER_CTXS = 5000; // 章节上下文上限（超限删最早）

/** 每请求上下文：变量池 + java API + cache（JS 沙箱注入） */
function makeCtx(source, { baseUrl, key, page, book, chapter, title, vars: bookSnap } = {}) {
  const sk = String(source.bookSourceUrl || '').trim();
  let vars = sourceVars.get(sk);
  if (!vars) { vars = new Map(); sourceVars.set(sk, vars); }
  // 书级快照合并视图：get 书级优先、源级兜底；put 双写两层（源级保持 play 等后续
  // 请求可见，与旧源级行为兼容；书级供同书再次详情复用）
  if (bookSnap) {
    const base = vars;
    const merged = new Map(bookSnap);
    const origGet = merged.get.bind(merged), origHas = merged.has.bind(merged), origSet = merged.set.bind(merged);
    merged.get = (k) => (origHas(k) ? origGet(k) : base.get(k));
    merged.has = (k) => origHas(k) || base.has(k);
    merged.set = (k, v) => { origSet(k, v); base.set(k, v); return merged; };
    vars = merged;
  }
  // java 闭包的 c 必须就是外层 ctx 本身：java.getString 的 currentCtx() 返回 c，
  // 规则链注入的 ctx.root（JS 段根内容）需经 c 可见——两对象分离时 root 不可见
  const ctx = { source, book: book || {}, chapter: chapter || null, title: title ?? '', baseUrl: baseUrl || source.bookSourceUrl, vars, key: key || '', page: page || 1, cache };
  ctx.java = createJavaApi(ctx);
  return ctx;
}

/** 带书源默认头的抓取 */
function fetchPage(ctx, url) {
  return fetchText(url, { headers: parseSourceHeaders(ctx.source, ctx) });
}

/** URL 绝对化（legado getAbsoluteURL：javascript: 丢弃） */
function absUrl(u, base) {
  if (!u) return '';
  const s = String(u).trim();
  if (!s || s.toLowerCase().startsWith('javascript')) return '';
  try { return new URL(s, base).toString(); } catch { return s; }
}

/** URL 规则绝对化：拆出 options 尾巴，仅对 URL 部分做 base 解析（避免 {} 被百分号编码） */
function absRule(rule, base) {
  const { url, optionsText } = splitUrlRule(String(rule || ''));
  const abs = absUrl(url, base);
  // optionsText 含首尾花括号，直接以逗号拼回
  return optionsText ? `${abs},${optionsText}` : abs;
}

/** legado WebBookRuleUtils.parseRulePrefix：列表规则首字符 - → reverse 标记并剥离，+ → 仅剥离。
 *  语义随调用方：书列表（BookList）reverse=true 时倒序；目录（BookChapterList）相反——
 *  无前缀/+ 时页面序经收集后双重 reverse 净化为页面序，- 前缀为页面倒序 */
function parseRulePrefix(ruleStr) {
  let rule = String(ruleStr || '');
  let reverse = false;
  if (rule.startsWith('-')) { reverse = true; rule = rule.slice(1); }
  else if (rule.startsWith('+')) { rule = rule.slice(1); }
  return { rule, reverse };
}

/** URL 模板渲染：普通 {{}} 与 @js://<js> 两种形态（legado analyzeJs：result 绑定整条规则原文，
 *  JS 段间非空文本段覆盖 result；JS 后再做 {{}} 替换） */
function renderUrl(ctx, tpl) {
  const s = String(tpl || '');
  if (/<js>[\w\W]*?<\/js>|@js:/i.test(s)) {
    let rendered;
    try {
      const out = execMixed({ ...ctx, result: s }, s, s, 30000); // URL 构建含同步抓取，放宽超时
      rendered = Array.isArray(out) ? String(out[0] ?? '') : String(out ?? '');
    } catch (e) {
      // 社区源伪 JS 写法（如 "URL,{options};result='';result;"）求值失败
      // → 回退剥离 JS 标签的原文，由 URL 解析（splitUrlRule 丢弃 options 后尾巴）
      console.warn(`renderUrl js failed, fallback raw: ${e.message}`);
      rendered = s.replace(/<\/?js>/gi, '').replace(/^@js:/i, '');
    }
    if (rendered.includes('{{') && rendered.includes('}}')) {
      rendered = render(rendered, { ...ctx, result: rendered });
    }
    return rendered;
  }
  return render(s, { ...ctx, result: s });
}

// ============ home ============
// exploreUrl → { class: [{type_id, type_name}], list: [] }
export async function t4Home(source) {
  const classes = [];
  const entries = parseExploreEntries(source);
  for (const e of entries) {
    classes.push({
      type_id: Buffer.from(JSON.stringify({ u: e.url, t: e.title })).toString('base64url'),
      type_name: e.title,
    });
  }
  return { class: classes, list: [] };
}

/** exploreUrl 解析（legado exploreKinds）：<js>/@js: 开头先执行 JS，结果按
 *  JSON 数组 [{title,url}] 或 `title::url`（&&/换行分隔）解析 */
export function parseExploreEntries(source, ctx = null) {
  const raw = source.exploreUrl;
  if (!raw) return [];
  const out = [];
  const push = (title, url) => {
    title = String(title || '').trim();
    url = String(url || '').trim();
    if (title && url) out.push({ title, url });
  };
  let text = String(raw).trim();
  // legado exploreKinds：<js>/@js: 开头 → 执行 JS（结果缓存语义略），产物再走规则解析
  if (/^<js>/i.test(text) || /^@js:/i.test(text)) {
    const code = /^@js:/i.test(text)
      ? text.slice(4)
      : text.slice(4, text.lastIndexOf('<'));
    try {
      const execCtx = ctx || makeCtx(source, {});
      const outJs = execMixed({ ...execCtx, result: text }, text, text);
      text = String(outJs ?? '').trim();
    } catch (e) {
      console.warn(`exploreUrl js failed: ${e.message}`);
      return out;
    }
  }
  if (text.startsWith('[')) {
    try {
      for (const item of parseJsonArrayLenient(text)) {
        if (item && typeof item === 'object') push(item.title, item.url);
      }
      return out;
    } catch { /* 落到行式解析 */ }
  }
  // legado：split("(&&|\n)+") → title::url
  for (const line of text.split(/(?:&&|\n)+/)) {
    const l = line.trim();
    if (!l) continue;
    const idx = l.indexOf('::');
    if (idx > 0) push(l.slice(0, idx), l.slice(idx + 2));
  }
  return out;
}

/** 宽松 JSON 数组解析（legado 用 Gson lenient）：字符串值内的裸控制字符（多行
 *  @js 分类 URL 是社区源常态，如全免小说）自动转义后重试 */
function parseJsonArrayLenient(text) {
  try { return JSON.parse(text); } catch { /* lenient 重试 */ }
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === '\\') {
      const n = text[i + 1];
      if (n === undefined) break;
      out += c + n;
      i++;
      continue;
    }
    if (c === '"') { inStr = false; out += c; }
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  return JSON.parse(out);
}

// ============ list（分类列表） ============
export async function t4List(source, tid, pg) {
  let entry;
  try { entry = JSON.parse(Buffer.from(String(tid), 'base64url').toString('utf-8')); } catch { entry = null; }
  if (!entry || !entry.u) return emptyList(pg);

  const page = Math.max(1, parseInt(pg, 10) || 1);
  const ctx = makeCtx(source, { page });
  const url = absRule(renderUrl(ctx, entry.u), ctx.baseUrl);
  // legado BookList 阶段：baseUrl 绑分类页地址（AnalyzeUrl baseUrl = explore 页 URL）——
  // ruleExplore JS 从 baseUrl 提取分类参数（如七猫 baidu.com 伪装 URL 藏 gender/category_id）
  ctx.baseUrl = url;
  let content;
  try { content = makeContent(await fetchPage(ctx, url)); } catch (e) { return emptyList(pg, e.message); }

  // ruleExplore 缺省整体回退 ruleSearch（列表与字段规则须同源，否则字段全空）
  const rule = source.ruleExplore && (source.ruleExplore.bookList || source.ruleExplore.name)
    ? source.ruleExplore : (source.ruleSearch || {});
  const { rule: listRule, reverse } = parseRulePrefix(rule.bookList || '');
  const items = analyzeList(content, listRule, ctx);
  const list = [];
  const seenUrls = new Set();
  for (const item of items) {
    try {
      const it = bookItem(source, ctx, item, rule);
      const bu = decodeBookId(it.vod_id).bookUrl;
      if (seenUrls.has(bu)) continue; // legado distinctBy bookUrl
      seenUrls.add(bu);
      list.push(it);
    } catch (e) { console.warn(`explore item failed: ${e.message}`); }
  }
  if (reverse) list.reverse(); // legado BookList：- 前缀倒序（去重后）
  return {
    list,
    page,
    pagecount: list.length > 0 ? page + 1 : page, // 有数据即可继续翻页（legado 无 pagecount 概念）
    total: 0,
    limit: 0,
  };
}

function emptyList(pg, err) {
  if (err) console.warn(`list failed: ${err}`);
  const page = Math.max(1, parseInt(pg, 10) || 1);
  return { list: [], page, pagecount: page, total: 0, limit: 0 };
}

/** 列表元素 → T4 vod 条目（ruleSearch/ruleExplore 字段族）。
 *  name 先于 bookUrl 求值（legado 字段顺序）：源用 name 规则 @put 写变量、bookUrl 规则 @get 读 */
function bookItem(source, ctx, item, rule) {
  const get = (field) => analyzeStr(item, rule[field] || '', ctx);
  // 快照池基线：本条目字段求值期间 put 的变量归该书（legado put 存 searchBook 实例语义）
  const pool = ctx.vars instanceof Map ? ctx.vars : null;
  const before = pool ? new Map(pool) : null;
  const name = get('name');
  // absRule 而非 absUrl：JS 生成的 bookUrl 常带 ,{...} options 尾巴（如七猫 java.get("headers")
  // 拼的请求头段），new URL 会把它编码成 %7B%22... 导致下游 parseOptions 解析不出。
  // bookUrl 传 isUrl=true（legado BookList: getString(ruleBookUrl, isUrl=true) → Default
  // 方言 getString0 只取收集列表第一项——.bookdesc@a@href 多 a 时仅首个为详情链接）
  const bookUrl = absRule(analyzeStr(item, rule.bookUrl || '', ctx, true), ctx.baseUrl);
  if (!bookUrl) throw new Error(`empty bookUrl [item kind=${item.kind}]`);
  // 池 diff → 书级快照（put 的对象/字符串值浅比较：同名变量未变则不记，覆盖/新增才记）
  if (pool && before) {
    const sk = String(source.bookSourceUrl || '').trim();
    let bv = bookVars.get(sk);
    if (!bv) { bv = new Map(); bookVars.set(sk, bv); }
    if (!bv.has(bookUrl) && bv.size >= MAX_BOOK_VARS) {
      bv.delete(bv.keys().next().value);
    }
    const rec = bv.get(bookUrl) || new Map();
    bv.set(bookUrl, rec);
    for (const [k, v] of pool) if (before.get(k) !== v) rec.set(k, v);
  }
  return {
    vod_id: encodeBookId(bookUrl, name),
    vod_name: name || '未知书名',
    vod_pic: absUrl(get('coverUrl'), ctx.baseUrl),
    vod_remarks: get('lastChapter') || get('wordCount') || '',
    vod_author: get('author') || '',
    vod_class: get('kind') || '',
    vod_content: get('intro') || '',
  };
}

/** vod_id 复合编码：`url|base64url(书名)` —— legado BookInfo 规则取空时继承搜索阶段
 *  书名（book.name 保留语义），T4 无状态故由搜索透传；旧格式（纯 URL）兼容 */
function encodeBookId(bookUrl, name) {
  return name ? `${bookUrl}|${Buffer.from(String(name)).toString('base64url')}` : bookUrl;
}
function decodeBookId(ids) {
  const s = String(ids || '');
  const i = s.indexOf('|');
  if (i < 0) return { bookUrl: s, name: '' };
  try { return { bookUrl: s.slice(0, i), name: Buffer.from(s.slice(i + 1), 'base64url').toString('utf-8') }; }
  catch { return { bookUrl: s.slice(0, i), name: '' }; }
}

// ============ detail（书籍信息 + 目录） ============
export async function t4Detail(source, ids) {
  const { bookUrl, name: listName } = decodeBookId(ids);
  if (!bookUrl) return emptyDetail();
  // legado BookInfo 阶段：baseUrl 绑 bookUrl（WebBook.analyzeBookInfo → baseUrl = book.bookUrl）；
  // 变量池回放该书搜索阶段快照（legado put 存 book 实例，详情 get 随书取——防多书同名变量串台）
  const snap = bookVars.get(String(source.bookSourceUrl || '').trim())?.get(bookUrl);
  // legado BookInfo 阶段 book 为搜索传入实例：T4 以搜索书名 + bookUrl 重建（ruleBookInfo JS 引用 book.name）
  const ctx = makeCtx(source, { baseUrl: bookUrl, vars: snap, book: { name: listName || '', bookUrl } });
  const info = source.ruleBookInfo || {};

  let content;
  try { content = makeContent(await fetchPage(ctx, bookUrl)); } catch (e) { return emptyDetail(e.message); }

  // legado ruleBookInfo.init（BookInfo.analyzeBookInfo）：init 规则先执行，
  // 结果 setContent 作为新内容供其余字段规则解析（如 JSON 包裹 $.data 先重根）
  if (info.init && info.init.trim()) {
    const initOut = analyzeStr(content, info.init, ctx);
    if (initOut) content = makeContent(initOut, content.kind === 'json' ? 'json' : null);
  }

  const get = (field) => analyzeStr(content, info[field] || '', ctx).trim();
  // 规则取空时继承搜索书名（legado analyzeBookInfo 非空才覆盖）
  const name = get('name') || listName;
  // 目录：tocUrl 可与 bookUrl 不同（部分源书籍页与目录页分离）；absRule 保留 options 尾巴。
  // isUrl=true（legado BookInfo: getString(infoRule.tocUrl, isUrl=true) → getString0 取第一项）
  const tocUrlRaw = info.tocUrl ? analyzeStr(content, info.tocUrl, ctx, true).trim() : '';
  const tocUrl = tocUrlRaw ? absRule(tocUrlRaw, bookUrl) : bookUrl;
  // book 上下文补全（legado BookInfo：详情字段写回 book 实例；ruleToc JS 引用 book.xxx 依赖）
  Object.assign(ctx.book, {
    name, author: get('author') || '', kind: get('kind') || '',
    coverUrl: absUrl(get('coverUrl'), bookUrl), intro: get('intro') || '',
    wordCount: get('wordCount') || '', lastChapter: get('lastChapter') || '',
  });
  const chapters = await loadToc(ctx, tocUrl, source.ruleToc || {});
  // 书名与目录双空 → 页面无效（404/验证码等），返回空列表
  if (!name && chapters.length === 0) return emptyDetail();
  const vod = {
    vod_id: ids,
    vod_name: name || '未知书名',
    vod_pic: absUrl(get('coverUrl'), bookUrl),
    vod_actor: get('author') || '',
    vod_class: get('kind') || '',
    vod_remarks: get('wordCount') || '',
    vod_content: get('intro') || get('lastChapter') || '',
    vod_play_from: (source.bookSourceType ?? 0) === 1 ? '音频' : '正文',
    vod_play_url: chapters
      .map((c) => `${c.name.replace(/[#＃$＄]/g, ' ')}$${encodeChapterUrl(c.url)}`)
      .join('#'),
  };
  return { list: [vod] };
}

function emptyDetail(err) {
  if (err) console.warn(`detail failed: ${err}`);
  return { list: [] };
}

/** 抓取目录（nextTocUrl 翻页合并 + TTL 缓存）。
 *  legado BookChapterList 语义：章节按 url 去重（distinctBy）；nextTocUrl 经 getStringList
 *  取列表——0 停止、1 顺链（visited 去重）、多个并发抓取按 URL 序合并（并发页不再递归）；
 *  列表前缀按 parseRulePrefix：- 前缀为页面倒序，无前缀/+ 为页面序 */
async function loadToc(ctx, tocUrl, rule) {
  const cacheKey = md5(ctx.source.bookSourceUrl + '|' + tocUrl);
  const cached = tocCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TOC_TTL) return cached.chapters;

  const sk = String(ctx.source.bookSourceUrl || '').trim();
  const nameRule = rule.chapterName || 'text';
  const urlRule = rule.chapterUrl || 'href';
  const { rule: listRule, reverse } = parseRulePrefix(rule.chapterList || '');
  const chapters = [];
  const seenUrls = new Set();
  const visited = [tocUrl];
  /** 追加章节（按 url 去重 + 章节上下文缓存供 play 查回） */
  const addChapter = (name, u) => {
    if (!name || seenUrls.has(u)) return;
    seenUrls.add(u);
    chapters.push({ name, url: u });
    const ck = md5(sk + '|' + u);
    chapterCtxs.set(ck, { book: ctx.book, chapter: { title: name, index: chapters.length - 1 } });
    if (chapterCtxs.size > MAX_CHAPTER_CTXS) chapterCtxs.delete(chapterCtxs.keys().next().value);
  };
  /** 解析单页章节；返回该页内容 repr（供 nextTocUrl 求值） */
  const parsePage = (pageUrl, body) => {
    const content = makeContent(body);
    const items = analyzeList(content, listRule, ctx);
    for (const item of items) {
      try {
        const name = analyzeStr(item, nameRule, ctx).trim();
        const cu = analyzeStr(item, urlRule, ctx).trim();
        // absRule 拆 options 尾巴后仅对 URL 部分做 base 解析（absUrl 的 new URL 会把 {} 的
        // options JSON 编码为 %7B%22...，导致 play 阶段 parseUrlRule 识别不出 options）
        // legado：章节 url 取空时用 baseUrl（目录页地址）替代——单页书（古籍站 outline
        // 页即正文）依赖此容错出目录
        addChapter(name, cu ? absRule(cu, pageUrl) : pageUrl);
      } catch { /* 单条失败隔离 */ }
    }
    return content;
  };
  /** 下一页 URL 列表（legado getStringList(nextTocUrl)：过滤当前页与已访问页） */
  const nextUrlsOf = (pageUrl, content) => {
    if (!rule.nextTocUrl) return [];
    try {
      return ctx.java.getStringList(rule.nextTocUrl, content)
        .map((s) => absUrl(String(s).trim(), pageUrl))
        .filter((u) => u && u !== tocUrl && !visited.includes(u));
    } catch { return []; }
  };

  // legado BookList 阶段：baseUrl 绑目录页地址（WebBook.getChapterList → baseUrl = book.tocUrl）
  ctx.baseUrl = tocUrl;
  let body = '';
  try { body = await fetchPage(ctx, tocUrl); } catch (e) { console.warn(`toc page failed: ${e.message}`); }
  if (body) {
    let content = parsePage(tocUrl, body);
    let nexts = nextUrlsOf(tocUrl, content);
    while (nexts.length === 1) {
      // 单链顺翻（legado while 循环：visited 去重防死循环）
      const nextUrl = nexts[0];
      visited.push(nextUrl);
      if (visited.length > MAX_TOC_PAGES) break;
      let nb;
      try { nb = await fetchPage(ctx, nextUrl); } catch (e) { console.warn(`toc page failed: ${e.message}`); break; }
      // 翻页后 baseUrl 对齐新页址（legado res.url 变更语义）
      ctx.baseUrl = nextUrl;
      content = parsePage(nextUrl, nb);
      nexts = nextUrlsOf(nextUrl, content);
    }
    if (nexts.length > 1) {
      // 多下一页并发抓取解析，按 URL 序合并；并发页不再继续翻页（legado getNextUrl=false）
      const parts = await Promise.all(nexts.map(async (u) => {
        try {
          const content = makeContent(await fetchPage(ctx, u));
          const items = analyzeList(content, listRule, ctx);
          const sub = [];
          for (const item of items) {
            try {
              const name = analyzeStr(item, nameRule, ctx).trim();
              const cu = analyzeStr(item, urlRule, ctx).trim();
              if (name) sub.push({ name, url: cu ? absRule(cu, u) : u });
            } catch { /* 单条失败隔离 */ }
          }
          return sub;
        } catch (e) { console.warn(`toc page failed: ${e.message}`); return []; }
      }));
      for (const sub of parts) for (const c of sub) addChapter(c.name, c.url);
    }
  }
  if (reverse) chapters.reverse(); // - 前缀：源目录页倒排，翻正
  if (chapters.length) {
    if (tocCache.size >= MAX_TOC_CACHE) tocCache.delete(tocCache.keys().next().value);
    tocCache.set(cacheKey, { at: Date.now(), chapters });
  }
  return chapters;
}

/** 章节 URL 含 #/$ 时整体百分号编码（宿主按 # $ 切分会截断），play 时还原 */
function encodeChapterUrl(u) {
  return /[#＃$＄]/.test(u) ? encodeURIComponent(u) : u;
}
function decodeChapterUrl(u) {
  if (/%23|%24/.test(u)) {
    try { return decodeURIComponent(u); } catch { return u; }
  }
  return u;
}

// ============ search ============
export async function t4Search(source, wd) {
  if (!source.searchUrl) return { list: [] };
  const key = String(wd || '').trim();
  if (!key) return { list: [] };
  const ctx = makeCtx(source, { key, page: 1 });
  const rendered = renderUrl(ctx, source.searchUrl);
  let content;
  try { content = makeContent(await fetchPage(ctx, absRule(rendered, ctx.baseUrl))); } catch (e) {
    console.warn(`search failed [${source.bookSourceName}]: ${e.message}`);
    return { list: [] };
  }
  const rule = source.ruleSearch || {};
  const { rule: listRule, reverse } = parseRulePrefix(rule.bookList || '');
  const items = analyzeList(content, listRule, ctx);
  const list = [];
  const seenUrls = new Set();
  for (const item of items) {
    try {
      const it = bookItem(source, ctx, item, rule);
      const bu = decodeBookId(it.vod_id).bookUrl;
      if (seenUrls.has(bu)) continue; // legado distinctBy bookUrl
      seenUrls.add(bu);
      list.push(it);
    } catch (e) { console.warn(`search item failed: ${e.message}`); }
  }
  if (reverse) list.reverse(); // legado BookList：- 前缀倒序（去重后）
  return { list };
}

// ============ play（正文 → novel:// / 音频直链） ============
export async function t4Play(source, playUrl) {
  const chapterUrl = decodeChapterUrl(String(playUrl || ''));
  const isAudio = (source.bookSourceType ?? 0) === 1;
  if (!chapterUrl) return isAudio ? audioResponse(source, '') : novelResponse('', '章节地址为空');
  // 章节上下文查回：detail/loadToc 缓存该书与章节对象（legado AnalyzeRule.chapter/book 绑定，
  // 正文规则 JS 的 chapter.title / title / book.name 引用依赖此缓存）
  const sk = String(source.bookSourceUrl || '').trim();
  const cctx = chapterCtxs.get(md5(sk + '|' + chapterUrl));
  const ctx = makeCtx(source, {
    baseUrl: chapterUrl,
    book: cctx?.book,
    chapter: cctx?.chapter,
    title: cctx?.chapter?.title,
  });
  const rule = source.ruleContent || {};
  // legado WebBook.getContentAwait：content 规则为空 → 章节链接即播放地址（音频源常态，
  // 如潇社音乐 tocUrl JS 返回的 JSON 里 url 字段就是音频直链）
  if (isAudio && !(rule.content || '').trim()) {
    return audioResponse(source, splitAudioUrl(ctx, chapterUrl));
  }

  const visited = [chapterUrl];
  /** 下一页 URL 列表（legado getStringList(nextContentUrl)：过滤当前页与已访问页） */
  const nextUrlsOf = (pageUrl, content) => {
    if (!rule.nextContentUrl) return [];
    try {
      return ctx.java.getStringList(rule.nextContentUrl, content)
        .map((s) => absUrl(String(s).trim(), pageUrl))
        .filter((u) => u && u !== chapterUrl && !visited.includes(u));
    } catch { return []; }
  };

  let text = '';
  let body = '';
  try {
    if (/^data:/i.test(chapterUrl.trim())) {
      // legado getByteArrayIfDataUri + StrResponse：data URL 剥 options 尾巴后 base64 解码
      // → hex 字符串作响应体（正文 JS 以 java.hexDecodeToString 还原载荷；options 的
      // JSON 字母是合法 base64 字符，必须先剥离防混入解码）
      const { url: du } = parseUrlRule(chapterUrl.trim());
      const m = /;base64,([\s\S]*)$/.exec(du);
      body = m ? Buffer.from(m[1], 'base64').toString('hex') : '';
    } else {
      body = await fetchPage(ctx, chapterUrl);
    }
  } catch (e) { return isAudio ? audioResponse(source, '') : novelResponse('', '抓取失败: ' + e.message); }
  {
    let content = makeContent(body);
    const read = (repr) => analyzeStr(repr, rule.content || '', ctx) || '';
    text = read(content);
    let nexts = nextUrlsOf(chapterUrl, content);
    while (nexts.length === 1) {
      // 单链顺翻（legado while 循环：visited 去重防死循环）
      const nextUrl = nexts[0];
      visited.push(nextUrl);
      if (visited.length > MAX_CONTENT_PAGES) break;
      let nb;
      try { nb = await fetchPage(ctx, nextUrl); } catch (e) { console.warn(`content page failed: ${e.message}`); break; }
      content = makeContent(nb);
      const part = read(content);
      if (part) text += (text ? '\n' : '') + part;
      nexts = nextUrlsOf(nextUrl, content);
    }
    if (nexts.length > 1) {
      // 多下一页并发抓取按序合并（legado mapAsync 保序；并发页不再递归翻页）
      const parts = await Promise.all(nexts.map(async (u) => {
        try { return read(makeContent(await fetchPage(ctx, u))); }
        catch (e) { console.warn(`content page failed: ${e.message}`); return ''; }
      }));
      for (const part of parts) if (part) text += (text ? '\n' : '') + part;
    }
  }

  // legado contentLoadFinish：正文即播放 URL——音频源 ruleContent.content 解析产物是音频直链
  // （如网易 `@js:'http://music.163.com/song/media/outer/url?id='+...+'.mp3'`、
  //  喜马拉雅 `@js:baseUrl`），交宿主播放器播放，不走 replaceRegex 正文净化
  if (isAudio) {
    return audioResponse(source, splitAudioUrl(ctx, text.trim()));
  }

  // replaceRegex 净化：格式 "正则##替换"（可多段）
  const cleaned = applyReplaceRegex(text, rule.replaceRegex);
  return novelResponse(cleaned, '');
}

/** 音频直链规范化：拆 `url,{options}` 尾巴（AnalyzeUrl 语义），URL 部分绝对化，返回 { url, headers } */
function splitAudioUrl(ctx, raw) {
  const { url: link, optionsText } = splitUrlRule(raw);
  if (!optionsText) return { url: absUrl(link, ctx.baseUrl), headers: null };
  const opts = parseOptions(optionsText);
  return { url: absUrl(link, ctx.baseUrl), headers: opts.headers || null };
}

/** 音频直链响应（宿主 PlayContent.header 支持防盗链 UA/Referer；flag 对齐 detail 的 vod_play_from） */
function audioResponse(source, urlOrObj) {
  const { url, headers } = typeof urlOrObj === 'string' ? { url: urlOrObj, headers: null } : urlOrObj;
  const out = { url: url || '', parse: 0, jx: 0, flag: '音频' };
  const merged = { ...parseSourceHeaders(source), ...(headers || {}) };
  if (Object.keys(merged).length) out.header = merged;
  return out;
}

/** legado replaceRegex：match##replace（replace 缺省删除；支持多组 ## 串联）。
 *  社区源常见 "##regex" 省略空 match 的纯删除形态，此时首段为正则。 */
function applyReplaceRegex(text, replaceRegex) {
  if (!replaceRegex || !text) return text;
  let out = text;
  const spec = String(replaceRegex).trim();
  try {
    const parts = spec.split('##');
    let match, replace;
    if (parts[0] === '' && parts.length >= 2) {
      match = parts[1];
      replace = parts.slice(2).join('##');
    } else {
      match = parts[0];
      replace = parts.slice(1).join('##');
    }
    if (!match) return text;
    out = out.replace(new RegExp(match, 'g'), replace);
  } catch (e) {
    console.warn(`replaceRegex failed: ${e.message}`);
  }
  return out;
}

/** novel:// 协议响应（对齐 PlayFragment.handleNovelContent） */
function novelResponse(content, err) {
  const payload = JSON.stringify({ title: '', content: err ? `【加载失败】${err}` : content });
  return {
    url: 'novel://' + payload,
    parse: 0,
    jx: 0,
    flag: '正文',
  };
}

// ============ 分发入口 ============
export async function dispatchT4(source, query) {
  const ac = query.get('ac') || '';
  const ids = query.get('ids');
  const wd = query.get('wd');
  const play = query.get('play');
  const t = query.get('t');
  const pg = query.get('pg');

  if (play !== null && play !== undefined && play !== '') return t4Play(source, play);
  if (wd) return t4Search(source, wd);
  if (ids) return t4Detail(source, ids);
  if (t) return t4List(source, t, pg || 1);
  if (ac === 'detail') return { list: [] }; // 无参 detail 视为空
  return t4Home(source);
}
