'use strict';
// lx-server 入口：裸 http，端口 9920-9929 由 Java 壳探测传入
// 端点：GET /check 探活；POST /lx/<route>/<action> 五动作；GET /cover/<platform>/<boardId> 榜单封面（302 到首歌封面）
const http = require('node:http');
const { dispatch } = require('./actions');
const catalog = require('./catalog');

const PORT = parseInt(process.env.LX_PORT, 10) || parseInt(process.argv[2], 10) || 9920;
// 源脚本目录（Java 壳下载 lx 脚本后落盘为 <route>.js，node 按 route 定位并按 mtime 热加载）
const SOURCES_DIR = process.argv[2];
if (!SOURCES_DIR) {
  console.error('用法: LX_PORT=<port> node index.js <sourcesDir>');
  process.exit(1);
}
const BODY_LIMIT = 1024 * 1024;

// 脚本内的异常（如 lx-juhe 的 x(e) 在 promise 链中 throw）会形成未处理 rejection，不能让它杀掉服务进程
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message));

// 榜单封面缓存：platform:boardId → 首歌封面 URL（惰性拉取一次）
const coverCache = new Map();
async function boardCover(platform, boardId) {
  const key = platform + ':' + boardId;
  if (coverCache.has(key)) return coverCache.get(key);
  const songs = await catalog.boardSongs(platform, boardId, 1);
  const img = (songs[0] && (songs[0].img || songs[0].pic)) || '';
  coverCache.set(key, img);
  return img;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/check') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"code":200}');
    return;
  }
  const cm = url.pathname.match(/^\/cover\/(\w+)\/(.+)$/);
  if (req.method === 'GET' && cm) {
    boardCover(cm[1], cm[2]).then((img) => {
      if (img) { res.writeHead(302, { Location: img }); res.end(); }
      else { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(404); res.end(); });
    return;
  }
  const m = url.pathname.match(/^\/lx\/([^/]+)\/(\w+)$/);
  if (req.method !== 'POST' || !m) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > BODY_LIMIT) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    const started = Date.now();
    try {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const data = await dispatch(m[1], m[2], body, SOURCES_DIR);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      console.log('[req]', m[1] + '/' + m[2], Date.now() - started + 'ms');
    } catch (e) {
      console.error('[req]', m[1] + '/' + m[2], '失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log('lx-server listening on ' + PORT));
