// 引擎单元测试（无网络，纯 fixture）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'crypto';
import { makeContent, analyzeList, analyzeStr } from '../src/engine/analyzer.js';
import { loadXml, analyzeXpath } from '../src/engine/xpath.js';
import { splitUrlRule, parseOptions } from '../src/engine/urlrule.js';
import { render, runJs } from '../src/engine/template.js';
import { createJavaApi, cache, clearCache, parseSourceHeaders } from '../src/engine/java-api.js';
import { parseParams, parseBookSources, isIncompatible, buildSites, md5, toLocalPath } from '../src/sources.js';
import { decodeBuffer, formEncode, applyPostBody, formEncodeParams } from '../src/engine/http.js';
const HTML = `<html><body>
<div class="list">
  <div class="item" data-id="1"><a class="title" href="/b/1">书一</a><span class="author">甲</span><img data-src="/c1.jpg"></div>
  <div class="item" data-id="2"><a class="title" href="/b/2">书二</a><span class="author">乙</span><img data-src="/c2.jpg"></div>
  <div class="item" data-id="3"><a class="title" href="/b/3">书三</a><span class="author">丙</span><img data-src="/c3.jpg"></div>
</div>
<div id="main"><p>段落一</p><p>段落二</p></div>
<table><tr>
  <td class="ccss"><a href="/ch/1">第一章 起点</a></td>
  <td class="ccss"><a href="/ch/2">第二章 转折</a></td>
</tr></table>
<div class="sumchapter"><a href="/c/1">第一卷</a><a href="/c/2">第二卷</a></div>
<div class="newrap"><a href="/n/1">新章一</a><a href="/n/2">新章二</a></div>
<div class="face-info"><span>字数一</span><span>字数二</span><span>字数三</span></div>
</body></html>`;

test('默认 jsoup 链：列表 + 字段', () => {
  const c = makeContent(HTML);
  const items = analyzeList(c, 'class.item', {});
  assert.equal(items.length, 3);
  const first = items[0];
  assert.equal(analyzeStr(first, 'class.title@text', {}), '书一');
  assert.equal(analyzeStr(first, 'class.title@href', {}), '/b/1');
  assert.equal(analyzeStr(first, 'tag.img.0@data-src', {}), '/c1.jpg');
  assert.equal(analyzeStr(first, 'class.author.0@text', {}), '甲');
});

test('默认 jsoup 链：索引与取值', () => {
  const c = makeContent(HTML);
  assert.equal(analyzeStr(c, 'class.item.0@class.title.0@text', {}), '书一');
  assert.equal(analyzeStr(c, 'class.item.-1@class.title.0@text', {}), '书三');
  assert.equal(analyzeStr(c, 'class.item.0:1@class.title.0@text', {}), '书一\n书二');
  assert.equal(analyzeStr(c, 'id.main.0@tag.p.0@text', {}), '段落一');
  // 简写：.class / #id / 裸 tag.索引
  assert.equal(analyzeStr(c, '.item.0@a.0@text', {}), '书一');
  assert.equal(analyzeStr(c, '#main@p.0@text', {}), '段落一');
  // textNodes 多文本节点拼接
  const main = analyzeList(c, 'id.main', {})[0];
  assert.equal(analyzeStr(main, 'id.main@tag.p@text', {}), '段落一\n段落二');
});

test('裸标签段不误判为属性 getter（仅末段做取值判断）', () => {
  const c = makeContent(HTML);
  // a 非末段 → 选 a 标签（此前误判为取 a 属性返回空）
  assert.equal(analyzeStr(c, '.ccss.0@a@text', {}), '第一章 起点');
  assert.equal(analyzeStr(c, '.ccss.0@a@href', {}), '/ch/1');
  // 单段裸标签在 list 模式（chapterList 场景）选元素而非取属性
  const links = analyzeList(c, 'a.title', {});
  assert.equal(links.length, 3);
  assert.equal(analyzeStr(links[0], 'text', {}), '书一');
  // children 非 legado 内建取值 → 按 attr 处理返回空（getResultLast else 分支）
  assert.equal(analyzeStr(c, 'id.main.0@children', {}), '');
});

test('css 回退段：含空格组合选择器 + 尾部索引', () => {
  const c = makeContent(HTML);
  // legado getElementsSingle：非 class./id./tag. 前缀段落整段走 css select
  assert.equal(analyzeStr(c, '.sumchapter a@text', {}), '第一卷\n第二卷');
  assert.equal(analyzeStr(c, '.newrap a.0@text', {}), '新章一');
  assert.equal(analyzeStr(c, '.newrap a.0@href', {}), '/n/1');
  // legado findIndexSet 传统写法：0:2 = 离散索引（第 0 与第 2 个），非闭区间
  assert.equal(analyzeStr(c, '.face-info span.0:2@text', {}), '字数一\n字数三');
  const items = analyzeList(c, '.sumchapter a', {});
  assert.equal(items.length, 2);
});

test('无点尾缀排除索引（社区源宽松写法 tr!0）', () => {
  const c = makeContent(HTML);
  // legado 规范写法 tr.!0；社区源常见 tr!0，按排除索引处理
  assert.equal(analyzeList(c, 'tag.table@tr', {}).length, 1);
  assert.equal(analyzeList(c, 'tag.table@tr!0', {}).length, 0);
  assert.equal(analyzeList(c, 'tag.table@tag.tr!0', {}).length, 0);
  assert.equal(analyzeList(c, 'tag.table@tr.0', {}).length, 1);
});

test('方括号索引集：区间/倒序/children[0]', () => {
  const c = makeContent(HTML);
  // 区间 [0:1]（tag.span[0:1] 阅友式写法）
  assert.equal(analyzeStr(c, '.face-info@tag.span[0:1]@text', {}), '字数一\n字数二');
  // 倒序区间 [-1:0]（id.catalog.0@tag.ul.0@tag.a[-1:0] 目录反转写法）
  const rev = analyzeList(c, '.sumchapter a[-1:0]', {});
  assert.equal(rev.length, 2);
  assert.equal(analyzeStr(rev[0], 'text', {}), '第二卷');
  assert.equal(analyzeStr(rev[1], 'text', {}), '第一卷');
  // children[0]（class.full_chapters@children[0]@tag.a 写法）
  assert.equal(analyzeStr(c, 'id.main@children[0]@text', {}), '段落一');
  // css 属性选择器 [data-x] 不被误剥离为索引
  assert.equal(analyzeStr(c, 'div[data-id="2"] a@text', {}), '书二');
});

test('GBK 表单编码 formEncode', () => {
  // "剑" GBK = 0xBD 0xA3；空格转 +；ASCII 保留
  assert.equal(formEncode('剑', 'gbk'), '%BD%A3');
  assert.equal(formEncode('a b=剑', 'gbk'), 'a+b%3D%BD%A3');
});

test('@CSS 方言', () => {
  const c = makeContent(HTML);
  assert.equal(analyzeStr(c, '@css:div.item:nth-child(1) a.title@text', {}), '书一');
  assert.equal(analyzeStr(c, '@css:#main@html', {}).includes('段落一'), true);
});

test('@JSON 方言', () => {
  const c = makeContent('{"data":{"list":[{"n":"a","u":"/1"},{"n":"b","u":"/2"}],"total":2}}');
  const items = analyzeList(c, '$.data.list[*]', {});
  assert.equal(items.length, 2);
  assert.equal(analyzeStr(items[0], '$.n', {}), 'a');
  assert.equal(analyzeStr(items[1], 'u', {}), '/2');
  assert.equal(analyzeStr(c, '@json:$.data.total', {}), '2');
  // {{$.path}} JSON 模板（酷我式 bookUrl 规则）
  assert.equal(analyzeStr(items[0], '/book{{$.u}}', {}), '/book/1');
  assert.equal(analyzeStr(items[1], '/book{{$.u}}', {}), '/book/2');
  // legado elementToString：数组值展开元素 join('\n')（非 JSON 序列化整串）
  const tc = makeContent('{"tags":["玄幻","都市"]}');
  assert.equal(analyzeStr(tc, '$.tags', {}), '玄幻\n都市');
  assert.equal(analyzeStr(tc, '{{$.tags}}', {}), '玄幻\n都市');
});

test('@XPath 方言', () => {
  const xml = `<html><body><div class="item"><a class="t" href="/1">甲</a></div><div class="item"><a class="t" href="/2">乙</a></div></body></html>`;
  const c = makeContent(xml);
  const items = analyzeList(c, '@XPath://div[@class="item"]', {});
  assert.equal(items.length, 2);
  assert.equal(analyzeStr(items[0], '@XPath:.//a/@href', {}), '/1');
  assert.equal(analyzeStr(c, '//a[@class="t"]/text()', {}), '甲\n乙');
});

test('loadXml 脏 HTML 规范化（未闭合标签/命名实体均不丢内容）', () => {
  // 未闭合 script + &nbsp; 命名实体：xmldom XML 模式整篇抛错，htmlparser2 规范化后必须可解析
  const doc = loadXml('<html><head><script>var a=1</script><title>T</title>'
    + '<body><div class="one-row"><div class="it x">甲&nbsp;乙</div><div class="it x">丙</div></div></body></html>');
  assert.ok(doc.getElementsByTagName('div').length >= 3, 'div 应全部保留');
  assert.ok(analyzeXpath({ doc }, '//div[@class="one-row"]/div[@class="it x"]', { list: true }).length === 2);
  // &nbsp; 解码为字符且结构不破坏
  assert.equal(analyzeXpath({ doc }, '//div[@class="one-row"]/div[1]/text()'), '甲\u00a0乙');
});

test('XPath 元素上下文相对语义（legado JsoupXpath // 相对条目）', () => {
  const doc = loadXml('<html><body>'
    + '<div class="row"><a class="u" href="/1">一</a><span class="n">N1</span></div>'
    + '<div class="row"><a class="u" href="/2">二</a><span class="n">N2</span></div></body></html>');
  const rows = analyzeXpath({ doc }, '//div[@class="row"]', { list: true });
  assert.equal(rows.length, 2);
  // 元素上下文里 //x 相对条目查找（标准 XPath // 是文档绝对路径，会两行同值）
  assert.equal(analyzeXpath({ doc: null, node: rows[0] }, '//span[@class="n"]/text()'), 'N1');
  assert.equal(analyzeXpath({ doc: null, node: rows[1] }, '//span[@class="n"]/text()'), 'N2');
});

test('org.jsoup 桥（Rhino LiveConnect：Jsoup.parse+select+first+attr）', () => {
  const ctx = { key: 'k', page: 1, vars: new Map() };
  const html = '<div><a href="/x?a=1">链接</a><a href="/y">二</a></div>';
  // result 绑定规则内容（legado AnalyzeRule.setContent 语义）
  assert.equal(analyzeStr(makeContent(html), '@js:var doc=org.jsoup.Jsoup.parse(result);var a=doc.select("a").first();a.attr("href")', ctx), '/x?a=1');
  assert.equal(analyzeStr(makeContent(html), '@js:org.jsoup.Jsoup.parse(result).select("a").size()', ctx), '2');
  // 空结果安全：first() 后 attr 返回空串不抛错
  assert.equal(analyzeStr(makeContent('<p>x</p>'), '@js:org.jsoup.Jsoup.parse(result).select("a").first().attr("href")', ctx), '');
});

test('@js 方言与变量注入', () => {
  const c = makeContent(HTML);
  const ctx = { key: '关键词', page: 2, vars: new Map([['x', '42']]), java: createJavaApi({ vars: new Map([['x', '42']]) }) };
  assert.equal(analyzeStr(c, '{{key}}-{{page}}', ctx), '关键词-2');
  assert.equal(analyzeStr(c, '{{page*2}}', ctx), '4');
  assert.equal(analyzeStr(c, '{{java.get("x")}}', ctx), '42');
  assert.equal(analyzeStr(c, '@js:"v=" + (1+2)', ctx), 'v=3');
  // Rhino 方言：无括号解构箭头（天天看书 exploreUrl 实例）补括号后正常执行
  assert.equal(analyzeStr(c, '@js:JSON.stringify([["连载","lz"],["玄幻","xh"]].map([title,id]=>({title,url:id+"|"+title})))', ctx),
    '[{"title":"连载","url":"lz|连载"},{"title":"玄幻","url":"xh|玄幻"}]');
  assert.equal(analyzeStr(c, '@js:(function(){ const f = {a}=>a*2; return String(f({a:21})); })()', ctx), '42');
  // result 绑定当前内容（legado bindings["result"]=content）
  assert.equal(analyzeStr(makeContent('abc'), '<js>result.toUpperCase()</js>', {}), 'ABC');
  // @js: 尾巴：规则结果作为 result 传入 JS
  assert.equal(analyzeStr(c, 'class.item.0@class.title.0@text@js:result + "!"'), '书一!');
  const jc = makeContent('{"status":50,"name":"甲"}');
  assert.equal(analyzeStr(jc, '{{$.name}},{{$.status}}@js:result.replace(/50/,"完结")'), '甲,完结');
});

test('## 正则净化与 || && 组合', () => {
  const c = makeContent(HTML);
  assert.equal(analyzeStr(c, 'class.item.0@class.title.0@text##书', {}), '一');
  assert.equal(analyzeStr(c, 'class.title.0@text##(书)##第一本$1', {}), '第一本书一');
  // ||：前段命中则用前段
  assert.equal(analyzeStr(c, 'class.author.0@text||class.title.0@text', {}), '甲');
  // ||：前段为空用后段
  assert.equal(analyzeStr(c, 'class.nothere.0@text||class.title.0@text', {}), '书一');
  // &&：拼接
  assert.equal(analyzeStr(c, 'class.author.0@text&&class.title.0@text', {}), '甲\n书一');
});

test('纯正则 : 前缀', () => {
  const c = makeContent('书名：《天下第一》作者：某某');
  assert.equal(analyzeStr(c, ':《(.+?)》', {}), '天下第一');
});

test('URL 规则 options 尾巴', () => {
  const { url, optionsText } = splitUrlRule(`/s?wd={{key}},{'method':'POST','body':'k={{key}}','headers':{'UA':'test/1.0'},'charset':'gbk'}`);
  assert.equal(url, '/s?wd={{key}}');
  assert.equal(optionsText.includes("'method':'POST'"), true);
  const o = parseOptions(optionsText);
  assert.equal(o.method, 'POST');
  assert.equal(o.body, 'k={{key}}');
  assert.equal(o.charset, 'gbk');
  assert.equal(o.headers.UA, 'test/1.0');
  const o2 = parseOptions('');
  assert.deepEqual(o2, {});
  // body 为对象/数组 → JSON 序列化（legado postJson 语义），非 "[object Object]"
  const o3 = parseOptions(`{'method':'POST','body':{'Scene':'chapter','List':[1,2]},'headers':{'Q-GUID':'x'}}`);
  assert.equal(o3.method, 'POST');
  assert.equal(o3.body, '{"Scene":"chapter","List":[1,2]}');
  assert.equal(o3.headers['Q-GUID'], 'x');
});

test('模板渲染与变量池', () => {
  const vars = new Map();
  const java = createJavaApi({ vars });
  java.put('a', 'A');
  const ctx = { vars, java, page: 3, key: 'K' };
  assert.equal(render('/s/{{key}}/{{page+1}}/{{a}}', ctx), '/s/K/4/A');
});

test('模板渲染：求值失败段置空（legado makeUpRule null->Unit）', () => {
  const ctx = { baseUrl: 'http://x/book/1' };
  // baseUrl 无 bookId 参数 → match 返回 null → [1] 抛错 → 该段置空，其余文本保留
  assert.equal(render('/b/{{baseUrl.match(/bookId=(\\d+)/)[1]}}/toc', ctx), '/b//toc');
  // 多段中仅失败段置空，成功段正常渲染（key 缺省为空串，不抛错）
  assert.equal(render('{{key}}|{{page}}', ctx), '|1');
});

test('模板渲染：$. 段走 JSONPath 子规则（legado makeUpRule isRule 分支）', () => {
  // JSON 上下文缺失时对 result 文本严格 JSON.parse（legado AnalyzeByJSonPath.parse 语义）
  const jsonText = '{"data":{"Content":[{"Content":"正文内容"}]}}';
  assert.equal(render('{{$.data.Content[0].Content}}', { result: jsonText }), '正文内容');
  // ctx.data 注入优先（dispatch 模板分支 kind=json 时注入）
  assert.equal(render('{{$.a}}', { data: { a: 1 }, result: 'ignored' }), '1');
  // 非 JSON 内容 → 段置空（不进 JS 沙箱，无 "$ is not defined"）
  assert.equal(render('A{{$.x}}B', { result: 'not json text' }), 'AB');
});

test('java API：base64 / md5 / 变量池', () => {
  const java = createJavaApi({ vars: new Map() });
  assert.equal(java.base64('hi'), 'aGk=');
  assert.equal(java.base64Decode('aGk='), 'hi');
  assert.equal(java.md5Encode('hi'), '49f68a5c8493ec2c0bf489821c21fc3b');
  java.put('k', 'v');
  assert.equal(java.get('k'), 'v');
  assert.equal(java.get('none', 'dft'), 'dft');
});

test('sources：参数解析 / 书源解析 / 兼容标记', async () => {
  const p = parseParams('{"remoteUrls":"http://a/1.json\\nhttp://b/2.json\\nftp://x","localFile":"/tmp/s.txt"}');
  assert.deepEqual(p.remoteUrls, ['http://a/1.json', 'http://b/2.json']);
  assert.equal(p.localFile, '/tmp/s.txt');

  const arr = parseBookSources('[{"bookSourceUrl":"http://x","bookSourceName":"X"}]');
  assert.equal(arr.length, 1);
  const single = parseBookSources('{"bookSourceUrl":"http://y"}');
  assert.equal(single.length, 1);
  assert.throws(() => parseBookSources('not json'));

  assert.equal(isIncompatible({ ruleSearch: { bookList: '@js:startBrowserAwait(u)' } }), 'startBrowserAwait');
  assert.equal(isIncompatible({ ruleSearch: { bookList: 'class.x' } }), null);
});

test('sources：buildSites 站点映射', () => {
  const src = { bookSourceUrl: 'https://example.com', bookSourceName: '例站', searchUrl: '/s' };
  const sites = buildSites([src], '127.0.0.1:9930');
  assert.equal(sites.length, 1);
  const s = sites[0];
  assert.equal(s.key, 'legado_' + md5('https://example.com'));
  assert.equal(s.name, '例站');
  assert.equal(s.type, 4);
  assert.equal(s.api, 'http://127.0.0.1:9930/api/' + md5('https://example.com'));
  assert.equal(s.searchable, 1);
  assert.equal(s.filterable, 0);
});

test('GBK 字节流解码', () => {
  // "中文" 的 GBK 编码字节
  const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBuffer(buf, 'gbk'), '中文');
});

// ---- legado 语义对齐新增用例 ----

test('%% 交叉合并（RuleCombiner 语义：各结果第 i 项依次）', () => {
  const c = makeContent(HTML);
  // title 属性缺失 → 空（attr 取值跳空白），结果全部来自第二支
  assert.equal(analyzeStr(c, 'class.item@a@title%%class.item@span@text', {}),
    '甲\n乙\n丙');
  const rows = analyzeList(c, 'tag.a.0%%tag.span.0', {});
  assert.deepEqual(rows.map((r) => analyzeStr(r, 'text', {})), ['书一', '甲']);
});

test('## 第 4 段 replaceFirst：返回匹配文本的替换结果（非整串），无匹配返回空', () => {
  const c = makeContent('<div>aa-bb-cc</div>');
  assert.equal(analyzeStr(c, 'tag.div@text##-##NEW##1'), 'NEW');
  assert.equal(analyzeStr(c, 'tag.div@text##(-)\\w+##[$1]##1'), '[-]');
  assert.equal(analyzeStr(c, 'tag.div@text##zzz##NEW##1'), '');
  // 无第 4 段：全量替换；两段形态为纯删除
  assert.equal(analyzeStr(c, 'tag.div@text##-##+'), 'aa+bb+cc');
  assert.equal(analyzeStr(c, 'tag.div@text##-'), 'aabbcc');
});

test('@@ 前缀剥离走默认链', () => {
  const c = makeContent(HTML);
  assert.equal(analyzeStr(c, '@@class.item.0@class.title.0@text', {}), '书一');
});

test('%% 交叉合并以第一个列表长度为准（legado RuleCombiner）', () => {
  const c = makeContent(HTML);
  // 第一支取 1 项，第二支取 3 项 → 只合并到第一支长度（maxLen 语义会多出 '乙'）
  assert.deepEqual(
    analyzeList(c, 'tag.a.0%%tag.span').map((r) => analyzeStr(r, 'text', {})),
    ['书一', '甲']);
});

test('组合分隔符不切 [ ]/( ) 平衡组（legado splitRule）', () => {
  const c = makeContent('{"list":[{"name":"甲","t":"x"},{"name":"乙","t":"y"}]}');
  // jsonpath 筛选器内的 && 不作为组合分隔符（误拆则筛选器被截断匹配失败）
  const rows = analyzeList(c, '$.list[?(@.name==\'甲\'&&@.t==\'x\')].name', {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text ?? rows[0], '甲');
});

test('{$.rule} 内嵌模板替换（legado AnalyzeByJSonPath.innerRule）', () => {
  const c = makeContent('{"title":"甲","none":"","list":[{"name":"甲"}]}');
  // 替换成功 → 模板串；部分失败段原样保留；全部失败 → 落回 JSONPath（非法选择器）→ 空
  assert.equal(analyzeStr(c, '{$.title}-完', {}), '甲-完');
  assert.equal(analyzeStr(c, '{$.none}A{$.title}B', {}), '{$.none}A甲B');
  assert.equal(analyzeStr(c, '{$.none}-完', {}), '');
});

test('html 取值移除 script/style（legado getResultLast）', () => {
  const c = makeContent('<div id="x"><script>var a=1;</script><style>.b{}</style><p>正文</p></div>');
  const s = analyzeStr(c, 'id.x@html', {});
  assert.ok(!s.includes('var a=1') && !s.includes('.b{}') && s.includes('正文'));
  // attr 跨元素去重 + 跳空白
  const d = makeContent('<ul><li data-t="a">1</li><li data-t="a">2</li><li data-t="  ">3</li><li data-t="b">4</li></ul>');
  assert.equal(analyzeStr(d, 'tag.li@data-t', {}), 'a\nb');
});

test('attr 之外一律按属性取值（class/id/tag 为属性时）', () => {
  const c = makeContent('<div class="k" id="v" tag="w">x</div>');
  assert.equal(analyzeStr(c, 'tag.div@class', {}), 'k');
  assert.equal(analyzeStr(c, 'tag.div@id', {}), 'v');
  assert.equal(analyzeStr(c, 'tag.div@tag', {}), 'w');
});

test('cache 绑定与 java.getString', () => {
  clearCache();
  assert.equal(cache.get('none'), null);
  cache.put('ck', 'cv', 5);
  assert.equal(cache.get('ck'), 'cv');

  const java = createJavaApi({ vars: new Map(), result: '书一' });
  // getString：默认对 result 内容求规则（text 内容走正则）
  assert.equal(java.getString('书.'), '书一');
  assert.equal(java.getString('{{result}}!'), '书一!');
  // source.getKey
  const j2 = createJavaApi({ vars: new Map(), source: { bookSourceUrl: 'https://s/' } });
  assert.equal(j2.getSource().getKey(), 'https://s/');
});

test('java.getString 默认根内容（legado AnalyzeRule 语义，阿巴章节前缀套路）', () => {
  const vars = new Map();
  const ctx = { key: 'k', page: 1, vars, cache: {} };
  ctx.java = createJavaApi(ctx);
  const content = makeContent('{"data":{"prefix":"http://pre/","list":[{"suf":"a.html"},{"suf":"b.html"}]}}');
  // chapterList 混排：普通段取列表子树 → JS 段 java.getString 从**根内容**取 prefix——
  // 若取前段 result（列表子树）则 $.data.prefix 为空（阿巴 freeUrlPre 同套路）
  const items = analyzeList(content, '$.data.list<js>java.put(\'pre\',java.getString(\'$.data.prefix\'));result</js>', ctx);
  assert.equal(items.length, 2);
  assert.equal(ctx.java.get('pre'), 'http://pre/');
  // 条目级 JS 规则：根内容 = 条目 repr，getString 取条目字段（阿巴 contUrlSuffix 同套路）
  const url = analyzeStr(items[0], '<js>java.get(\'pre\')+java.getString(\'$.suf\')</js>', ctx);
  assert.equal(url, 'http://pre/a.html');
});

test('JS 规则 result 元素代理（legado result=ksoup Elements 语义）', () => {
  const c = makeContent(HTML);
  const item = analyzeList(c, '.item', {})[0];
  // 元素方法面：parentNode 链 / attr / text（松鹤庭沐式 result.parentNode().parentNode() 规则）
  assert.equal(analyzeStr(item, '@js:String(result.parentNode().attr("class"))', {}), 'list');
  assert.equal(analyzeStr(item, '@js:String(result.attr("data-id"))', {}), '1');
  assert.equal(analyzeStr(item, '@js:result.text().trim()', {}), '书一甲');
  // 字符串协议保留：String 载体原型方法（match/replace/length/拼接）不受影响
  assert.equal(analyzeStr(item, '@js:String(result.match(/data-id="(\\d)"/)[1])', {}), '1');
  assert.equal(analyzeStr(item, '@js:result', {}), item.root.prop('outerHTML'));
});

test('模板内嵌规则 {{@rule}} / {{//xpath}}（legado makeUpRule isRule）', () => {
  const html = '<html><body><div class="book-cats"><span>分类A</span></div><div class="item"><a class="t" href="/b/1">书一</a></div></body></html>';
  const c = makeContent(html);
  const item = analyzeList(c, '.item', {})[0];
  // @ 开头：CSS/JSoup 规则语法，不进 JS 沙箱
  assert.equal(analyzeStr(c, '分类:{{@.book-cats@text}}', {}), '分类:分类A');
  // 集合 select：ksoup Elements 方法面（text/attr 对集合操作）+ 数组索引
  assert.equal(analyzeStr(item, '@js:result.select(".t").text()', {}), '书一');
  assert.equal(analyzeStr(item, '@js:String(result.select(".t").attr("href"))', {}), '/b/1');
  assert.equal(analyzeStr(item, '@js:String(result.select(".t")[0].attr("href"))', {}), '/b/1');
  assert.equal(analyzeStr(c, '{{@class.book-cats@text}}', {}), '分类A');
});

test('legado @put/@get 变量机制（话本小说源写法）', () => {
  const c = makeContent('{"bookname":"假千金","bookid":"1793095423"}');
  const ctx = { vars: new Map() };
  // @put：返回主规则值并把子规则结果写入变量池
  assert.equal(analyzeStr(c, '$.bookname@put:{bookid:$.bookid}', ctx), '假千金');
  assert.equal(ctx.vars.get('bookid'), '1793095423');
  // @get：URL/规则中的变量引用替换
  assert.equal(analyzeStr(c, 'https://x/cdn/chapters/@get:{bookid}/123', ctx), 'https://x/cdn/chapters/1793095423/123');
  // @get：缺失变量置空
  assert.equal(analyzeStr(c, 'https://x/@get:{nope}/123', ctx), 'https://x//123');
});

test('java.cryptoDecrypt：cipher 名标准化（Unknown cipher 修复）', () => {
  const java = createJavaApi({ vars: new Map() });
  const enc = (name, key, iv, text) => {
    const c = nodeCrypto.createCipheriv(name, key, iv);
    return Buffer.concat([c.update(Buffer.from(text, 'utf-8')), c.final()]).toString('base64');
  };
  // AES/CBC：源写法 AES/CBC/PKCS5Padding → aes-128-cbc
  const k16 = Buffer.alloc(16, 7); const iv16 = Buffer.alloc(16, 9);
  assert.equal(java.aesBase64DecodeToString(enc('aes-128-cbc', k16, iv16, '测试文本hello'), k16.toString('utf-8'), 'AES/CBC/PKCS5Padding', iv16.toString('utf-8')), '测试文本hello');
  // AES/GCM：Java 密文格式 = 密文 + 16 字节认证标签
  const c2 = nodeCrypto.createCipheriv('aes-128-gcm', k16, iv16);
  const gcmEnc = Buffer.concat([c2.update(Buffer.from('gcm内容', 'utf-8')), c2.final(), c2.getAuthTag()]).toString('base64');
  assert.equal(java.aesBase64DecodeToString(gcmEnc, k16.toString('utf-8'), 'AES/GCM/NoPadding', iv16.toString('utf-8')), 'gcm内容');
  // DES 系：OpenSSL 3 禁止单 DES 加密方向（des-cbc 名可解析、仅 encrypt 被禁），
  // 故以 3DES roundtrip 覆盖 DES 系的映射与 IV 块长截断路径
  const iv8 = Buffer.alloc(8, 5);
  // DESede/CBC（DESEDE → des-ede3-cbc）
  const k24 = Buffer.alloc(24, 1);
  const c3 = nodeCrypto.createCipheriv('des-ede3-cbc', k24, iv8);
  const e3 = Buffer.concat([c3.update(Buffer.from('ede3 ok', 'utf-8')), c3.final()]).toString('base64');
  assert.equal(java.desBase64DecodeToString(e3, k24.toString('utf-8'), 'DESEDE/CBC/PKCS5Padding', iv8.toString('utf-8')), 'ede3 ok');
});

test('java.put：返回 value 本身（legado AnalyzeUrlCore.put 语义，`"," + java.put(...)` 拼 options 尾巴依赖）', () => {
  const java = createJavaApi({ vars: new Map() });
  const h = JSON.stringify({ headers: { 'app-version': '51110' } });
  assert.equal(java.put('headers', h), h);
  assert.equal(java.get('headers'), h);
});

test('java.ajax：URL options 拆分合并（headers/method/body，七猫 App 签名头依赖）', async () => {
  // 注意：server 必须放 worker_threads——execFileSync 阻塞主进程事件循环，
  // 同进程 server 永远无法 accept，会死锁到 30s 超时
  const { Worker } = await import('node:worker_threads');
  const workerSrc = `
    const http = require('node:http');
    const { parentPort } = require('node:worker_threads');
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, xTest: req.headers['x-test'] ?? '', body });
        res.end('pong');
      });
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
    parentPort.on('message', (m) => {
      if (m === 'dump') parentPort.postMessage({ seen });
      if (m === 'close') process.exit(0);
    });
  `;
  const worker = new Worker(workerSrc, { eval: true });
  const { port } = await new Promise((r) => worker.once('message', r));
  try {
    const java = createJavaApi({ vars: new Map() });
    // GET + options headers
    assert.equal(await java.ajax(`http://127.0.0.1:${port}/a,{"headers":{"X-Test":"v1"}}`), 'pong');
    // POST + 对象 body（parseOptions JSON.stringify 语义）+ headers
    assert.equal(await java.ajax(`http://127.0.0.1:${port}/b,{"method":"POST","body":{"k":"v"},"headers":{"X-Test":"v2"}}`), 'pong');
    // 纯 URL（无 options）不受影响
    assert.equal(await java.ajax(`http://127.0.0.1:${port}/c`), 'pong');
    worker.postMessage('dump');
    const { seen } = await new Promise((r) => worker.once('message', r));
    assert.equal(seen.length, 3);
    assert.equal(seen[0].xTest, 'v1');
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].xTest, 'v2');
    assert.equal(seen[1].body, '{"k":"v"}');
    assert.equal(seen[2].xTest, '');
  } finally {
    worker.postMessage('close');
  }
});

test('Rhino Java 桥：JavaImporter/with 块 AES-CBC 解密（七猫 ruleContent decode 套路）', () => {
  // 模拟七猫 content：base64(iv(16字节) + AES-128-CBC 密文)
  const key = Buffer.from('242ccb8230d709e1', 'utf-8');
  const iv = Buffer.alloc(16, 3);
  const c = nodeCrypto.createCipheriv('aes-128-cbc', key, iv);
  const payload = Buffer.concat([iv, c.update(Buffer.from('桥接解密正文OK', 'utf-8')), c.final()]).toString('base64');

  const js = `@js:
var javaImport = new JavaImporter();
javaImport.importPackage(Packages.java.lang, Packages.javax.crypto.spec, Packages.javax.crypto, Packages.java.util);
with(javaImport) {
  function decode(content) {
    var ivEncData = Base64.getDecoder().decode(String(content));
    var key = SecretKeySpec(String("242ccb8230d709e1").getBytes(), "AES");
    var iv = IvParameterSpec(Arrays.copyOfRange(ivEncData, 0, 16));
    var cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
    cipher.init(2, key, iv);
    return String(cipher.doFinal(Arrays.copyOfRange(ivEncData, 16, ivEncData.length)));
  }
}
decode(String(result))`;
  // 覆盖点：with 块类名解析、String.getBytes、SecretKeySpec 省略 new、
  // Cipher 名转换（AES/CBC/PKCS5Padding → aes-128-cbc）、Arrays.copyOfRange、String(byte[])
  assert.equal(analyzeStr(makeContent(payload), js, { vars: new Map() }), '桥接解密正文OK');
});

// ============ r12 书源规则说明核对 ============

test('传统索引离散语义补遗（负数/排除列表/端点省略/.N children）', () => {
  const c = makeContent(HTML);
  // 负数：-1 尾
  assert.equal(analyzeStr(c, '.face-info@tag.span.-1@text', {}), '字数三');
  // 排除列表 !0:2（排除第 0 与第 2 个 → 仅剩第 1 个）
  assert.equal(analyzeStr(c, '.face-info@tag.span.!0:2@text', {}), '字数二');
  // 方括号端点省略：[1:] 从 1 到末尾；[:1] 开头到 1
  assert.equal(analyzeStr(c, '.face-info@tag.span[1:]@text', {}), '字数二\n字数三');
  assert.equal(analyzeStr(c, '.face-info@tag.span[:1]@text', {}), '字数一\n字数二');
  // 离散索引作首规则 = children（head@.1@text ≙ head@children[1]@text）
  assert.equal(analyzeStr(c, 'id.main@.0@text', {}), '段落一');
  assert.equal(analyzeStr(c, 'id.main@.1@text', {}), '段落二');
  // 空段 + 方括号索引 = children（head@[1]@text）
  assert.equal(analyzeStr(c, 'id.main@[1]@text', {}), '段落二');
});

test('AllInOne $N 组引用（正则列表条目 → 字段规则 $N 取组）', () => {
  const c = makeContent(HTML);
  const items = analyzeList(c, ':<div class="item" data-id="\\d+"><a class="title" href="([^"]+)">([^<]+)</a>', {});
  assert.equal(items.length, 3);
  // $1 = 组 1（href）、$2 = 组 2（书名）、$0 = 整个匹配
  assert.equal(analyzeStr(items[0], '$2', {}), '书一');
  assert.equal(analyzeStr(items[1], '$1', {}), '/b/2');
  assert.ok(analyzeStr(items[2], '$0', {}).includes('书三'));
});

test('## 替换段内 {{}} 与 @get:{} 净化（legado makeUpRule evalPattern）', () => {
  const c = makeContent('<p>第一章 起点</p><p>第二章 终点</p>');
  const ctx = { vars: new Map([['bk', '壹']]) };
  // 格式：主规则##match##replace；@get:{key} 段内预求值
  assert.equal(analyzeStr(c, 'tag.p@text##起点##@get:{bk}', ctx), '第一章 壹\n第二章 终点');
  // {{}} 以当前内容为 result 求值后替换（match 段与 replace 段均预渲染；$1 由 String.replace 组引用补齐）
  assert.equal(analyzeStr(c, 'tag.p@text##{{"起" + "点"}}##【净】', {}), '第一章 【净】\n第二章 终点');
  assert.equal(analyzeStr(c, 'tag.p@text##第(\\S+)章##{{"卷·" + "$1"}}', {}), '卷·一 起点\n卷·二 终点');
});

test('JS 沙箱绑定 chapter/title/src（legado evalJS）', () => {
  const c = makeContent('hello');
  const ctx = { vars: new Map(), chapter: { title: '第3章 风起' }, title: '第3章 风起', result: '正文内容' };
  assert.equal(analyzeStr(c, '@js:chapter.title', ctx), '第3章 风起');
  assert.equal(analyzeStr(c, '@js:title', ctx), '第3章 风起');
  // src 绑定当前内容（legado src=content，规则求值时 result 注入当前 repr 文本）
  assert.equal(analyzeStr(c, '@js:src', ctx), 'hello');
  // 无 chapter 时绑定空对象不抛错
  assert.equal(analyzeStr(c, '@js:typeof chapter === "object"', { vars: new Map() }), 'true');
});

test('模板 render 路径绑定 title/src（legado evalJS 变量面）', () => {
  assert.equal(render('{{title}}', { title: '第3章' }), '第3章');
  assert.equal(render('{{src}}', { result: '正文X' }), '正文X');
  assert.equal(render('{{chapter.title}}', { chapter: { title: '卷一' } }), '卷一');
});

test('java API 补齐：base64Encode / getElements / 变量池 get 不受影响', () => {
  const api = createJavaApi({ source: {}, vars: new Map(), result: 'hello', root: makeContent(HTML) });
  // base64Encode 别名（legado JsExtensions.base64Encode）
  assert.equal(api.base64Encode('abc'), Buffer.from('abc').toString('base64'));
  // getElements：对根内容执行默认链规则 → 元素代理数组（字符串协议可用）
  const els = api.getElements('class.item');
  assert.equal(els.length, 3);
  assert.ok(String(els[0]).includes('书一'));
  // 变量池 get 不受 URL 重载影响
  api.put('k', 'v1');
  assert.equal(api.get('k'), 'v1');
  assert.equal(api.get('missing', 'def'), 'def');
});

test('java.get HTTP 重载与 ajaxAll StrResponse 形态（legado JsExtensions.get / Array<StrResponse>）', () => {
  const api = createJavaApi({ source: {}, vars: new Map(), baseUrl: '' });
  // URL + headers 对象 → HTTP GET；不可达端口 → 空载体（code 0）
  const r = api.get('http://127.0.0.1:9/x', {});
  assert.equal(typeof r.body, 'function');
  assert.equal(r.code(), 0);
  assert.equal(r.body(), '');
  assert.equal(typeof r.header, 'function');
  // ajaxAll → StrResponse 载体数组（body()/code()/header()/url()，字符串拼接自动拆箱）
  const [a] = api.ajaxAll('http://127.0.0.1:9/y');
  assert.equal(a.code(), 0);
  assert.equal(a.body(), '');
  assert.equal(a.url(), 'http://127.0.0.1:9/y');
  assert.equal(String(a) + '!', '!');
});

test('r12.1 真实源审计回归：@css 对 JSON 内容返回空、toNumChapter、Rhino 无括号解构箭头', () => {
  // ① @css 规则对 JSON 内容：legado AnalyzeByCSS 元素集为空 → 空结果，不抛异常
  const jc = makeContent('{"data":{"name":"书名"}}');
  assert.equal(analyzeStr(jc, '@css:.a@text', {}), '');
  // ② java.toNumChapter（legado JsExtensions：第X章中文数字 → 阿拉伯数字）
  const api = createJavaApi({ source: {}, vars: new Map() });
  // legado 返回值即重组的「第X章」（后缀由外层 String.replace 回调保留）
  assert.equal(api.toNumChapter('第一百二十三章 风起'), '第123章');
  assert.equal(api.toNumChapter('第3章'), '第3章');
  assert.equal(api.toNumChapter('序章无匹配'), '序章无匹配');
  assert.equal(api.toNumChapter('第一千零二十五章'), '第1025章');
  assert.equal(api.toNumChapter('第两章'), '第2章');
  // ③ Rhino 无括号解构箭头（带空格）[title, Id] => —— 纵横/米读源 exploreUrl JS
  assert.equal(runJs('r=[]; [[\"a\",1],[\"b\",2]].map([t, n] => r.push(t + n)); r.join(\",\")', { vars: new Map() }), 'a1,b2');
});

test('POST body 三分支（legado AnalyzeUrlCore configureRequest：form 编码/postJson/原样）', () => {
  // ① 非 JSON body 且无 CT → 分段编码 + 表单 CT（中文 keyword=剑 → %E5%89%91，阅友搜索修复）
  const h1 = {};
  const b1 = applyPostBody('POST', 'psize=20&page=1&keyword=剑', h1);
  assert.equal(b1, 'psize=20&page=1&keyword=%E5%89%91');
  assert.equal(h1['Content-Type'], 'application/x-www-form-urlencoded');
  // ② 已编码段原样保留（checkEncoded：阅友 bookUrl body 的 %253F 双重编码形态）
  assert.equal(formEncodeParams('trace=33_33%253Ftype%253Dbook&bookId=233615'), 'trace=33_33%253Ftype%253Dbook&bookId=233615');
  // ③ JSON body → 原样 + JSON CT（postJson）
  const h3 = {};
  const b3 = applyPostBody('POST', '{"a":1}', h3);
  assert.equal(b3, '{"a":1}');
  assert.equal(h3['Content-Type'], 'application/json; charset=UTF-8');
  // ④ 显式 CT → body 原样不动头
  const h4 = { 'Content-Type': 'application/xml' };
  assert.equal(applyPostBody('POST', '<a>1</a>', h4), '<a>1</a>');
  assert.equal(h4['Content-Type'], 'application/xml');
  // ⑤ 空 body → 空串 + 表单 CT（postForm）
  const h5 = {};
  assert.equal(applyPostBody('POST', '', h5), '');
  assert.equal(h5['Content-Type'], 'application/x-www-form-urlencoded');
  // ⑥ GET → undefined（不处理）
  assert.equal(applyPostBody('GET', 'a=1', {}), undefined);
});

test('模板 {{}} stringify 转义残留（matchDoubleBrace 转义感知 + evalExpr 还原，阅友正文修复）', () => {
  const ctx = { java: { get: (k) => ({ id: '233615', chapterId: '999' }[k] || '') }, vars: new Map([['id', '233615']]) };
  // ① {{java.get(\"id\")}}：JSON.stringify 产物引号转义 → 提取不失效、求值还原成功
  const tpl = 'https://x.com/api?p=xxx,{"method":"POST","body":"readCount=2&bookId={{java.get(\\"id\\")}}&chapterId={{java.get(\\"chapterId\\")}}"}';
  assert.equal(
    render(tpl, ctx),
    'https://x.com/api?p=xxx,{"method":"POST","body":"readCount=2&bookId=233615&chapterId=999"}'
  );
  // ② JSONPath 带转义下标 {{$.data[\"list\"]}}（同款产物形态）
  assert.equal(render('{{$.data[\\"list\\"][0].id}}', { data: { data: { list: [{ id: 7 }] } } }), '7');
  // ③ 正常模板无回归（@js: 字符串内的 \" 合法转义不还原——只有 {{}} 表达式走还原）
  assert.equal(render('{{key}}-{{page}}', { key: '剑', page: 2 }), '剑-2');
  assert.equal(runJs('"a{\\"b\\"}c"', { vars: new Map() }), 'a{"b"}c');
});

test('本地书源 file:// URI 转路径（宿主文件选择器产物，中文路径 URI 编码）', () => {
  // ① file:// URI + 中文 %XX 编码 → fileURLToPath 解码为绝对路径
  assert.equal(
    toLocalPath('file:///storage/emulated/0/%E5%AE%9D%E7%9B%92/bookSource.json'),
    '/storage/emulated/0/宝盒/bookSource.json'
  );
  // ② 绝对路径原样返回
  assert.equal(toLocalPath('/sdcard/bookSource.json'), '/sdcard/bookSource.json');
  // ③ 畸形 file://（非合法 URI）兜底粗剥前缀
  assert.equal(toLocalPath('file://宝盒/bookSource.json'), '宝盒/bookSource.json');
  // ④ 空值原样
  assert.equal(toLocalPath(''), '');
});

test('全规则校验补例：$[ 前缀 JSON / AllInOne && 链式 / 大小写前缀 / GET query charset 编码', () => {
  // ① $[ 前缀走 JSON 方言（legado AnalyzeRuleCore：$. 与 $[ 同判）
  assert.equal(analyzeStr(makeContent('[10,20,30]'), '$[1]'), '20');
  // ② @Json: 大小写混合前缀（legado startsWith("@Json:", true)）
  assert.equal(analyzeStr(makeContent('{"data":{"name":"书名"}}'), '@Json:$.data.name'), '书名');
  assert.equal(analyzeStr(HTML, '@Css:.item@data-id'), '1\n2\n3');
  assert.equal(analyzeStr(HTML, '@Xpath://div[@class="item"]/a/@href'), '/b/1' + String.fromCharCode(10) + '/b/2' + String.fromCharCode(10) + '/b/3');
  // ③ AllInOne && 链式：非末条 findAll 拼接作下条输入（legado AnalyzeByRegex.getElements）
  const text = 'a1b2c3d4';
  // 第一条 \d 拼出 '1234'，第二条 (2)(3) 捕获组 2 → 条目组引用
  const list = analyzeList(text, ':\\d&&(2)(3)');
  assert.ok(Array.isArray(list) && list.length === 1);
  assert.equal(analyzeStr({ kind: 'text', text: '', raw: '', groups: ['', '2', '3'] }, '$1-$2'), '2-3'); // $N 组引用语义
  // ④ AllInOne 单条不回归（组 1 优先）
  assert.equal(analyzeStr('书名《天下第一》', ':《(.+?)》'), '天下第一');
});

test('java.log 返回 msg（legado JsExtensionsCommon：打印后 return msg，社区源以 log(x) 作规则出口）', async () => {
  const { createJavaApi } = await import('../src/engine/java-api.js');
  const java = createJavaApi({ vars: new Map() });
  assert.equal(java.log('正文内容'), '正文内容');
  assert.equal(java.log('未匹配到目标 JSON 字符串'), '未匹配到目标 JSON 字符串');
});

test('## 顶层拆分：{{}} 内嵌 ## 属于子规则不误拆（legado makeUpRule 先摘 {{}} 段后 split("##")，全本小说 bookUrl）', () => {
  const html = `<html><body><dl class="hot"><dd><h4><a href="/101/101948/5650499.html">书名</a></h4><a href="/other/">x</a></dd></dl></body></html>`;
  const c = makeContent(html);
  const item = analyzeList(c, '.hot@dd', {})[0];
  // {{@@a.0@href##.html}}/：内嵌净化删 .html，尾拼 /；外层无 ##
  assert.equal(analyzeStr(item, '{{@@a.0@href##.html}}/', {}), '/101/101948/5650499/');
  // 外层 ## + {{}} 混排：净化作用于最终结果
  assert.equal(analyzeStr(item, 'h4@a@text##名##氏', {}), '书氏');
  // 纯文本 {{}} + 外层 ##
  assert.equal(analyzeStr(item, 'h4@text##书##X', {}), 'X名');
});

test('@js: 书源 header 求值（legado BaseSource.getHeaderMap：@js: 先执行，baseUrl 绑书源地址；空值头跳过防 undici 炸）', () => {
  const src = { bookSourceUrl: 'https://www.qb5.io', header: '@js:JSON.stringify({"Referer":baseUrl,"Keep-Alive":""})' };
  const h = parseSourceHeaders(src);
  assert.equal(h['Referer'], 'https://www.qb5.io');
  assert.ok(!('Keep-Alive' in h), '空值头应跳过（OkHttp 允许空值 header，undici 校验直接炸）');
  assert.ok(h['User-Agent'], '无 UA 时补默认');
  // 纯 JSON header 不回归
  const h2 = parseSourceHeaders({ header: '{"Referer":"https://x.com"}' });
  assert.equal(h2['Referer'], 'https://x.com');
});
