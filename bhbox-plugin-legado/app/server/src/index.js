// legado-server：阅读APP书源 → T4 小说服务（node:http 裸写，单进程单用途）
//
// 环境变量（Java 层 LegadoServerManager 注入）：
//   PORT           监听端口（9930-9939 由 Java 探测）
//   LEGADO_PARAMS  书源参数 JSON：{ remoteUrls, localFile }（见 sources.js）
//
// 端点：
//   GET  /            极简状态页（订阅地址展示、源概况、重载按钮；宿主插件页「打开网页」入口）
//   GET  /check       探活（Java 看护线程自愈探测用）
//   GET  /config      订阅 JSON：每个启用书源一个 type=4 站点（api 按请求 Host 动态构造）
//   GET  /status      书源加载概况（JSON）
//   POST /reload      重新拉取书源（本地文件重读 + 网络下载）
//   GET  /api/<md5>   T4 五动作（home/list/detail/search/play，M2 实现）
import { createServer } from 'http';
import { parseParams, loadSources, buildSites, md5 } from './sources.js';
import { dispatchT4, clearCaches } from './t4/index.js';

const port = Number(process.env.PORT || 9930);

// 进程级守护：legado 里单源引擎异常不会挂掉整个 App——T4 Node 服务同理。
// 未捕获异常/Promise 拒绝只记日志（含堆栈，供排查根因），不退出进程；
// 请求级错误已由 HTTP handler try-catch 隔离，此处兜异步逃逸与底层库异常
process.on('uncaughtException', (e) => console.error(`[guard] uncaughtException: ${e && e.stack || e}`));
process.on('unhandledRejection', (e) => console.error(`[guard] unhandledRejection: ${e && (e.stack || e.message) || e}`));

// 全局书源状态：启动时加载一次，POST /reload 刷新
let state = { list: [], report: { loaded: [], errors: [], skipped: [], incompatible: [] } };
let loading = false;
let loadedAt = null;
/** 当前加载任务：冷启动先监听后加载源，期间到达的源数据请求等待其完成（防宿主缓存站点请求被拒） */
let loadPromise = Promise.resolve();

async function loadAll() {
  const params = parseParams(process.env.LEGADO_PARAMS);
  loading = true;
  try {
    state = await loadSources(params);
    loadedAt = new Date().toISOString();
    console.log(`sources loaded: ${state.list.length} usable`
      + `, errors=${state.report.errors.length}`
      + `, skipped=${state.report.skipped.length}`
      + `, incompatible=${state.report.incompatible.length}`);
  } finally {
    loading = false;
  }
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

// 源数据端点等待当前加载完成：冷启动 node 先监听后加载源，宿主（缓存配置）的请求
// 到达时挂住至源就绪再处理，而非返回空数据。上限 25s（宿主 okhttp 默认 30s 超时内）。
async function awaitSources() {
  if (!loading) return;
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('sources still loading, retry later')), 25_000));
  await Promise.race([loadPromise, timeout]);
}

const html = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
};

// T4 站点请求入口：hash → 书源，五动作分发（home/list/detail/search/play）
async function handleApi(res, hash, query) {
  const src = state.list.find((s) => md5((s.bookSourceUrl || '').trim()) === hash);
  if (!src) return json(res, 404, { error: 'source not found: ' + hash });
  const result = await dispatchT4(src, query);
  return json(res, 200, result);
}

function statusPage(host) {
  const r = state.report;
  const rows = state.list.map((s) =>
    `<li>${esc(s.bookSourceName || s.bookSourceUrl)} — ${esc(s.bookSourceGroup || '')}</li>`).join('');
  const problems = [
    ...r.errors.map((e) => `<li>[加载失败] ${esc(e.from)}：${esc(e.error)}</li>`),
    ...r.incompatible.map((e) => `<li>[不兼容] ${esc(e.name)}：${esc(e.reason)}</li>`),
    ...r.skipped.map((e) => `<li>[跳过] ${esc(e.name)}：${esc(e.reason)}</li>`),
  ].join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Legado 书源服务</title></head><body>
<h2>Legado 书源 → T4 服务</h2>
<p>订阅地址（添加为线路配置）：<code>http://${esc(host)}/config</code></p>
<p>可用书源：${state.list.length}（加载于 ${esc(loadedAt || '-')}）</p>
<p><form method="post" action="/reload"><button>重载书源</button></form></p>
${problems ? `<h3>问题清单</h3><ul>${problems}</ul>` : ''}
<h3>可用源</h3><ul>${rows}</ul>
<p>小说阅读需在 Mobile 端使用（TV 端暂不支持 novel:// 协议）。</p>
</body></html>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const host = req.headers.host || `127.0.0.1:${port}`;
  try {
    if (req.method === 'GET' && url.pathname === '/check') {
      return json(res, 200, { run: true, sources: state.list.length });
    }
    if (req.method === 'GET' && url.pathname === '/config') {
      await awaitSources();
      return json(res, 200, { sites: buildSites(state.list, host) });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, {
        running: true, loading, loadedAt,
        usable: state.list.length, report: state.report,
        sources: state.list.map((s) => ({
          name: s.bookSourceName || s.bookSourceUrl,
          url: s.bookSourceUrl,
          group: s.bookSourceGroup || '',
        })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      clearCaches();
      await loadAll();
      return json(res, 200, { ok: true, usable: state.list.length, report: state.report });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
      await awaitSources();
      return await handleApi(res, url.pathname.slice(5), url.searchParams);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return html(res, statusPage(host));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`request failed: ${req.method} ${url.pathname}: ${e.message}`);
    try { json(res, 500, { error: e.message }); } catch { /* header 已发则忽略 */ }
  }
});

// 先监听后加载源：listening 信号即视为服务就绪（Java 探活不依赖源数据），
// 源数据请求经 awaitSources 等待加载完成（冷启动约数秒，远小于宿主 30s 超时）
server.listen(port, '0.0.0.0');
console.log(`listening on 0.0.0.0:${port}`);
loadPromise = loadAll()
  .catch((e) => console.error('sources load failed: ' + e.message));
