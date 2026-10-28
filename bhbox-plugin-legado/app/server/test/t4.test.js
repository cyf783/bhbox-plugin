// T4 全链路测试：本地 fixture HTTP 服务模拟书站（默认链 / @XPath / @js / GBK / replaceRegex）
// 覆盖 home → list → detail → play 与 search → play
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { t4Home, t4List, t4Detail, t4Search, t4Play, dispatchT4 } from '../src/t4/index.js';

let fixture;
let base;

const pages = {
  // 搜索页（默认 jsoup 链书源）
  '/search': (q) => `<html><body><div class="result">
    <div class="item"><a class="title" href="/book/1">测试书一</a><span class="author">作者甲</span><span class="cat">玄幻</span><a class="cover" href="/cover/1.jpg">图</a></div>
    <div class="item"><a class="title" href="/book/2">测试书二</a><span class="author">作者乙</span><span class="cat">都市</span><a class="cover" href="/cover/2.jpg">图</a></div>
  </div></body></html>`,
  // 分类页（与搜索页同构）
  '/cat': () => pages['/search'](),
  // 书籍详情页
  '/book/1': () => `<html><body><h1 class="name">测试书一</h1><span class="author">作者甲</span>
    <div class="intro">这是简介</div><img class="pic" src="/cover/1.jpg">
    <a id="toc" href="/toc/1">查看目录</a></body></html>`,
  // 目录页第一页（含下一页）
  '/toc/1': () => `<html><body><div class="chapters">
    <a href="/content/1_1">第一章 起点</a><a href="/content/1_2">第二章 转折</a>
  </div><a id="next" href="/toc/2">下一页</a></body></html>`,
  // 目录页第二页
  '/toc/2': () => `<html><body><div class="chapters"><a href="/content/1_3">第三章 结局#上</a></div></body></html>`,
  // 正文页（含正文下一页）
  '/content/1_1': () => `<html><body><div id="content">第一段正文。<br>第二段正文。</div><a id="next" href="/content/1_1_2">下一页</a></body></html>`,
  '/content/1_1_2': () => `<html><body><div id="content">第三段续页。</div></body></html>`,
  '/content/1_2': () => `<html><body><div id="content">第二章正文。</div></body></html>`,
  '/content/1_3': () => `<html><body><div id="content">第三章正文，含<strong>加粗</strong>与广告：www.ad.com</div></body></html>`,
  // 音频源页面（search/book/toc 复用默认链结构）
  '/audio/search': () => `<html><body><div class="result">
    <div class="item"><a class="title" href="/audio/book/1">测试歌曲集</a></div>
  </div></body></html>`,
  '/audio/book/1': () => `<html><body><h1 class="name">测试歌曲集</h1><a id="toc" href="/audio/toc/1">目录</a></body></html>`,
  '/audio/toc/1': () => `<html><body><div class="chapters">
    <a href="/audio/media/1001.mp3">第一首歌</a><a href="/audio/song/1002">第二首歌</a>
  </div></body></html>`,
  '/audio/song/1001': () => `<html><body>song page 1001</body></html>`,
  '/audio/song/1002': () => `<html><body>song page 1002</body></html>`,
  '/audio/song': () => `<html><body>song page</body></html>`,
  '/audio/song/opts': () => `${base}/audio/media/1001.mp3,{"headers":{"User-Agent":"AudioUA"}}`,
  '/audio/media/1001.mp3': () => 'AUDIO',
  // GBK 搜索页（server 回调中按 GBK 字节返回）
};

before(async () => {
  fixture = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    if (path === '/gbk/search') {
      // GBK 编码的搜索页（中文转 GBK 字节）
      const html = `<html><body><div class="result"><div class="item"><a class="title" href="/book/1">GBK书</a><span class="author">GBK作者</span></div></div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(gbkEncode(html));
      return;
    }
    const render = pages[path] || (path.startsWith('/cat') ? pages['/cat'] : null);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(render ? render(u.searchParams) : 'not found');
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${fixture.address().port}`;
});
after(() => new Promise((r) => fixture.close(r)));

/** 极简 GBK 编码（仅覆盖 fixture 中文字符，手工拼 GBK 字节） */
function gbkEncode(html) {
  const gbkBook = Buffer.from([0x47, 0x42, 0x4b, 0xca, 0xe9]); // GBK书
  const gbkAuthor = Buffer.from([0x47, 0x42, 0x4b, 0xd7, 0xf7, 0xd5, 0xdf]); // GBK作者
  return Buffer.concat([
    Buffer.from(`<html><body><div class="result"><div class="item"><a class="title" href="/book/1">`, 'latin1'),
    gbkBook,
    Buffer.from(`</a><span class="author">`, 'latin1'),
    gbkAuthor,
    Buffer.from(`</span></div></div></body></html>`, 'latin1'),
  ]);
}

// ============ 书源 fixtures ============

const sourceDefault = () => ({
  bookSourceUrl: base,
  bookSourceName: '默认链测试源',
  enabled: true,
  searchUrl: '/search?q={{key}}',
  exploreUrl: `[{"title":"玄幻","url":"/cat/1-{{page}}"},{"title":"都市","url":"/cat/2-{{page}}"}]`,
  ruleSearch: {
    bookList: 'class.item',
    name: 'class.title.0@text',
    author: 'class.author.0@text',
    kind: 'class.cat.0@text',
    bookUrl: 'tag.a.0@href',
    coverUrl: 'class.cover.0@href',
  },
  ruleExplore: null, // 回退 ruleSearch
  ruleBookInfo: {
    name: 'class.name.0@text',
    author: 'class.author.0@text',
    intro: 'class.intro.0@text',
    coverUrl: 'class.pic.0@src',
    tocUrl: 'id.toc.0@href',
  },
  ruleToc: {
    chapterList: 'class.chapters.0@tag.a',
    chapterName: 'text',
    chapterUrl: 'href',
    nextTocUrl: 'id.next.0@href',
  },
  ruleContent: {
    content: 'id.content@textNodes',
    nextContentUrl: 'id.next.0@href',
  },
});

const sourceXpath = () => ({
  ...sourceDefault(),
  bookSourceName: 'XPath测试源',
  searchUrl: '/search?q={{key}}',
  ruleSearch: {
    bookList: '@XPath://div[@class="item"]',
    name: '@XPath:.//a[@class="title"]/text()',
    author: '@XPath:.//span[@class="author"]/text()',
    bookUrl: '@XPath:.//a[@class="title"]/@href',
  },
  ruleContent: { content: '@XPath://div[@id="content"]//text()' },
});

const sourceJs = () => ({
  ...sourceDefault(),
  bookSourceName: 'JS测试源',
  searchUrl: '@js:"/search?q=" + key',
  ruleContent: {
    content: 'id.content@textNodes',
    nextContentUrl: 'id.next.0@href',
    replaceRegex: '广告：www\\.ad\\.com##【已净化】',
  },
});

const sourceGbk = () => ({
  ...sourceDefault(),
  bookSourceName: 'GBK测试源',
  searchUrl: `/gbk/search?q={{key}},{'charset':'gbk'}`,
});

// replaceRegex 纯删除形态（##regex 开头省略空 match，社区源常见）
const sourceClean = () => ({
  ...sourceDefault(),
  bookSourceName: '纯删除净化源',
  ruleContent: {
    content: 'id.content@textNodes',
    nextContentUrl: 'id.next.0@href',
    replaceRegex: '##广告：www\\.ad\\.com',
  },
});

const q = (obj) => new URLSearchParams(obj);

// ============ 测试 ============

test('home：exploreUrl JSON 数组 → class', async () => {
  const r = await t4Home(sourceDefault());
  assert.equal(r.class.length, 2);
  assert.equal(r.class[0].type_name, '玄幻');
  const entry = JSON.parse(Buffer.from(r.class[0].type_id, 'base64url').toString('utf-8'));
  assert.equal(entry.u, '/cat/1-{{page}}');
});

test('home：exploreUrl 数组内嵌多行 @js URL（裸换行，legado Gson lenient 语义）', async () => {
  const s = sourceDefault();
  // 社区源常态：分类 url 值内嵌多行 JS（真换行），严格 JSON.parse 抛错——如全免小说
  s.exploreUrl = `[
{"title":"分组","url":"","style":{}},
{"title":"分类甲","url":"@js:
var u = 'http://x/list?page=' + page;
u;","style":{}},
{"title":"分类乙","url":"/cat/2-{{page}}","style":{}}
]`;
  const r = await t4Home(s);
  assert.equal(r.class.length, 2); // 空 url 的分组标题条目不入列
  assert.equal(r.class[0].type_name, '分类甲');
  const entry = JSON.parse(Buffer.from(r.class[0].type_id, 'base64url').toString('utf-8'));
  assert.match(entry.u, /^@js:/); // 保留原始 JS 规则供 t4List 求值
});

test('list：分类 → 书列表（ruleExplore 缺省回退 ruleSearch）', async () => {
  const s = sourceDefault();
  const home = await t4Home(s);
  const r = await t4List(s, home.class[0].type_id, 1);
  assert.equal(r.list.length, 2);
  assert.equal(r.list[0].vod_name, '测试书一');
  // vod_id 复合格式：url|base64url(书名)——详情阶段规则取空时继承搜索书名
  assert.equal(r.list[0].vod_id, `${base}/book/1|${Buffer.from('测试书一').toString('base64url')}`);
  assert.equal(r.list[0].vod_remarks, '');
  assert.equal(r.page, 1);
  assert.equal(r.pagecount, 2);
});

test('list：baseUrl 绑分类页 URL（legado BookList 语义，七猫 ruleExplore JS 从 baseUrl 提参数依赖）', async () => {
  const s = sourceDefault();
  // 模拟七猫套路：JS 从 baseUrl 提取分类参数决定字段值（baidu.com 伪装 URL 藏 gender/category_id）
  s.ruleExplore = {
    bookList: 'class.item',
    name: '<js>var m = baseUrl.match(/cat\\/(\\d+)/); m ? "分类" + m[1] + "书" : "NOBASE"</js>',
    bookUrl: 'tag.a.0@href',
  };
  const home = await t4Home(s);
  const r = await t4List(s, home.class[0].type_id, 1);
  // /cat/1-{{page}} 渲染后 cat/1-1 → baseUrl 提取 1；若未绑定分类 URL（仍是源 URL）则为 NOBASE
  assert.equal(r.list[0].vod_name, '分类1书');
});

test('detail：书级变量快照防串台（legado put 存 book 语义，阿巴 bid 套路）', async () => {
  const s = sourceDefault();
  s.bookSourceName = '书级变量源';
  // 搜索阶段每本书的 bookUrl 规则 put 不同 bid（旧源级池被列表最后一本覆盖 → 详情全串台）
  s.ruleSearch = { ...s.ruleSearch, bookUrl: `tag.a.0@href<js>java.put('bid',String(result).match(/(\\d+)/)[1]);result</js>` };
  // 详情 init 用 java.get('bid') 生成书名——取到的应是该书自己的 bid
  s.ruleBookInfo = { ...s.ruleBookInfo, init: `<js>JSON.stringify({nm:'书' + java.get('bid')})</js>`, name: '$.nm' };
  const sr = await t4Search(s, '测试');
  const dr = await t4Detail(s, sr.list[1].vod_id); // 第 2 本（bid=2）
  assert.equal(dr.list[0].vod_name, '书2');        // 串台则两本都返回同一 bid
});

test('search → detail → play 全链路（默认链，目录翻页 + 正文翻页 + #字符编码）', async () => {
  const s = sourceDefault();
  const sr = await t4Search(s, '测试');
  assert.equal(sr.list.length, 2);
  assert.equal(sr.list[0].vod_name, '测试书一');
  assert.equal(sr.list[0].vod_author, '作者甲');

  const dr = await t4Detail(s, sr.list[0].vod_id);
  assert.equal(dr.list.length, 1);
  const vod = dr.list[0];
  assert.equal(vod.vod_name, '测试书一');
  assert.equal(vod.vod_content, '这是简介');
  assert.equal(vod.vod_play_from, '正文');
  // 目录翻页合并：toc/1 两章 + toc/2 一章
  const eps = vod.vod_play_url.split('#');
  assert.equal(eps.length, 3);
  assert.equal(eps[0], `第一章 起点$${base}/content/1_1`);
  // 第三章 URL 不含 #（fixture 里 URL 干净，章名含 # 被替换为空格）
  assert.ok(eps[2].startsWith(`第三章 结局 上$${base}/content/1_3`));

  // play 第一章（正文翻页合并）
  const pr = await t4Play(s, `${base}/content/1_1`);
  assert.equal(pr.parse, 0);
  assert.ok(pr.url.startsWith('novel://'));
  const payload = JSON.parse(pr.url.slice(8));
  assert.equal(payload.title, '');
  assert.equal(payload.content, '第一段正文。\n第二段正文。\n第三段续页。');

  // dispatchT4 路由：?play=
  const pr2 = await dispatchT4(s, q({ play: `${base}/content/1_2`, flag: '正文' }));
  assert.ok(JSON.parse(pr2.url.slice(8)).content.includes('第二章正文'));
});

test('search：@XPath 源', async () => {
  const s = sourceXpath();
  const sr = await t4Search(s, '测试');
  assert.equal(sr.list.length, 2);
  assert.equal(sr.list[0].vod_name, '测试书一');
  assert.equal(sr.list[0].vod_author, '作者甲');
  const pr = await t4Play(s, `${base}/content/1_1`);
  const payload = JSON.parse(pr.url.slice(8));
  assert.ok(payload.content.includes('第一段正文。'));
});

test('search：@js searchUrl + replaceRegex 净化', async () => {
  const s = sourceJs();
  const sr = await t4Search(s, '测试');
  assert.equal(sr.list.length, 2);
  const pr = await t4Play(s, `${base}/content/1_3`);
  const payload = JSON.parse(pr.url.slice(8));
  assert.ok(payload.content.includes('【已净化】'));
  assert.ok(!payload.content.includes('www.ad.com'));
});

test('play：replaceRegex ##regex 纯删除形态', async () => {
  const s = sourceClean();
  const pr = await t4Play(s, `${base}/content/1_3`);
  const payload = JSON.parse(pr.url.slice(8));
  // 广告段整体删除，其余直接文本节点保留
  assert.ok(!payload.content.includes('广告'));
  assert.ok(!payload.content.includes('www.ad.com'));
  assert.ok(payload.content.includes('第三章正文'));
});

test('search：GBK 编码页解码', async () => {
  const s = sourceGbk();
  const sr = await t4Search(s, '测试');
  assert.equal(sr.list.length, 1);
  assert.equal(sr.list[0].vod_name, 'GBK书');
  assert.equal(sr.list[0].vod_author, 'GBK作者');
});

test('detail：异常 URL 返回空列表', async () => {
  const s = sourceDefault();
  const dr = await t4Detail(s, `${base}/not-exist`);
  assert.deepEqual(dr.list, []);
});

// ============ 音频源（bookSourceType 1 → 播放直链） ============

const sourceAudioEmpty = () => ({
  bookSourceUrl: base,
  bookSourceName: '音频直链源',
  bookSourceType: 1,
  enabled: true,
  searchUrl: '/audio/search?q={{key}}',
  ruleSearch: { bookList: 'class.item', name: 'class.title.0@text', bookUrl: 'class.title.0@href' },
  ruleBookInfo: { name: 'class.name@text', tocUrl: 'id.toc@href' },
  ruleToc: { chapterList: 'class.chapters.0@tag.a', chapterName: 'text', chapterUrl: 'href' },
  ruleContent: {},
});

test('音频源：ruleContent 空规则 → 章节链接即播放直链', async () => {
  // legado WebBook.getContentAwait：content 规则为空 → 直接返回章节链接
  const s = sourceAudioEmpty();
  const sr = await t4Search(s, '歌');
  assert.equal(sr.list.length, 1);
  const dr = await t4Detail(s, sr.list[0].vod_id);
  assert.equal(dr.list[0].vod_play_from, '音频');
  const chapterUrl = dr.list[0].vod_play_url.split('#')[0].split('$')[1];
  const pr = await t4Play(s, chapterUrl);
  assert.equal(pr.url, `${base}/audio/media/1001.mp3`);
  assert.equal(pr.flag, '音频');
  assert.equal(pr.parse, 0);
  assert.ok(!pr.url.startsWith('novel://'));
});

test('音频源：ruleContent JS 拼接直链（baseUrl 引用）', async () => {
  // 网易形态：章节页 URL 提 id 拼外链 mp3
  const s = { ...sourceAudioEmpty(), ruleContent: { content: `@js:'${base}/audio/media/'+baseUrl.match(/id=(\\d+)/)[1]+'.mp3'` } };
  const pr = await t4Play(s, `${base}/audio/song?id=1001`);
  assert.equal(pr.url, `${base}/audio/media/1001.mp3`);
  assert.equal(pr.flag, '音频');
});

test('音频源：直链 ,{options} 尾巴拆出播放 header', async () => {
  // text 内容规则按 legado 语义当正则 → 取原文用 @js:result
  const s = { ...sourceAudioEmpty(), ruleContent: { content: '@js:result' } };
  const pr = await t4Play(s, `${base}/audio/song/opts`);
  assert.equal(pr.url, `${base}/audio/media/1001.mp3`);
  assert.equal(pr.header['User-Agent'], 'AudioUA');
});

test('音频源：抓取失败返回空直链（不进 novel:// 阅读器）', async () => {
  const s = { ...sourceAudioEmpty(), ruleContent: { content: '@js:result' } };
  // 不可达端口（连接拒绝）走抓取失败分支；fixture 未知路径返回 200 不算失败
  const pr = await t4Play(s, 'http://127.0.0.1:9/audio/song/x');
  assert.equal(pr.url, '');
  assert.equal(pr.flag, '音频');
});
