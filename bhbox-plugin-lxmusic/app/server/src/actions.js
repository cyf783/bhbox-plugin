'use strict';
// Spider 五动作 → 宿主消费的 JSON 形状（对照 DsSpider 透传语义 / PlayContent 字段）
const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { loadScript } = require('./lx-runtime');
const catalog = require('./catalog');

const PLAY_FLAG = '洛雪音乐';
const QUALITY_TITLES = { '128k': '标准 128k', '320k': '高品 320k', 'flac': '无损 FLAC' };
const DEFAULT_QUALITIES = Object.keys(QUALITY_TITLES);
// 直链所需 UA（按平台透传，宿主播放器携带）
const PLATFORM_HEADERS = {
  kw: { 'User-Agent': 'kwplayer_ar_9.2.2.1_apk.urlinside.cn.apk' },
};

// ============ 路由态：route → 运行时（sourcesDir/<route>.js，mtime 变化自动重载） ============
const routes = new Map();

function getRuntime(route, sourcesDir) {
  const scriptPath = path.join(sourcesDir, route + '.js');
  const mtime = fs.statSync(scriptPath).mtimeMs;
  const cur = routes.get(route);
  if (cur && cur.scriptPath === scriptPath && cur.mtime === mtime) return cur.runtime;
  console.log('[route]', route, '加载脚本:', scriptPath);
  const runtime = loadScript(scriptPath);
  routes.set(route, { scriptPath, mtime, runtime });
  return runtime;
}

// ============ lx:// 载荷编码：base64url(JSON{platform, musicInfo, name, pic}) ============
function encodeId(song) {
  return Buffer.from(JSON.stringify({ platform: song.platform, musicInfo: song.musicInfo, name: song.name, pic: song.pic || '' }), 'utf8').toString('base64url');
}

function decodeId(id) {
  const raw = id.startsWith('lx://') ? id.slice(5) : id;
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
}

// ============ 五动作 ============

/** home：class = 音源平台（filters：榜单/歌单 + 歌单标签，标准 TVBox filter 形状）。标签限时 3s 加载（带缓存） */
async function home(route, body) {
  await Promise.race([
    Promise.all(catalog.CATALOGS.ids.map((id) => catalog.songListTags(id))),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  const filters = {};
  for (const id of catalog.CATALOGS.ids) {
    const kindFilter = {
      key: 'kind', name: '类型',
      value: [{ n: '榜单', v: 'board' }, { n: '歌单', v: 'songlist' }],
    };
    const tagFilter = {
      key: 'tag', name: '歌单标签',
      value: [{ n: '热门', v: '' }, ...catalog.CATALOGS.tags(id).map((t) => ({ n: t.name, v: t.id }))],
    };
    filters[id] = [kindFilter, tagFilter];
  }
  return {
    class: catalog.CATALOGS.ids.map((id) => ({ type_id: id, type_name: catalog.CATALOGS.names[id] })),
    filters,
    list: [], // 宿主 AbsJson 遍历 list，空推荐位也必须给空数组
  };
}

/** category：分类 tab（id=平台）→ 榜单/歌单卡片；extend.kind=board|songlist，extend.tag=歌单标签。
 *  封面走本服务 /cover/<platform>/<boardId>（302 到榜首歌曲封面，带缓存） */
async function category(route, body) {
  const page = Number(body.page) || 1;
  const platform = body.id || body.type_id || catalog.CATALOGS.ids[0];
  const extend = body.extend || {};
  const port = parseInt(process.env.LX_PORT, 10) || 9920;
  if (extend.kind === 'songlist') {
    const r = await catalog.songLists(platform, extend.tag || '', page);
    return {
      list: r.list.map((l) => ({
        vod_id: 'sl:' + platform + ':' + encodeURIComponent(l.name) + ':' + l.id,
        vod_name: l.name,
        vod_pic: l.pic,
        vod_remarks: l.author || catalog.CATALOGS.names[platform] + ' · 歌单',
      })),
      page, pagecount: r.total > r.list.length * page ? 999 : page, total: r.total, limit: 30,
    };
  }
  const boards = await catalog.boards(platform);
  return {
    list: boards.map((b) => ({
      vod_id: 'pl:' + platform + ':' + b.id,
      vod_name: b.name,
      vod_pic: `http://127.0.0.1:${port}/cover/${platform}/${encodeURIComponent(b.id)}`,
      vod_remarks: catalog.CATALOGS.names[platform] + ' · 榜单',
    })),
    page, pagecount: 1, total: boards.length, limit: 30,
  };
}

/** search：全平台并行搜索（musicSdk 七平台），结果交错混排 */
async function search(route, body) {
  const wd = body.wd || '';
  const page = Number(body.page) || 1;
  if (!wd) return { list: [], page, pagecount: 1, total: 0, limit: 30 };
  const merged = await catalog.searchAll(wd, page);
  return {
    list: merged.slice(0, 30).map((s) => ({
      vod_id: 'song:' + s.platform + ':' + encodeId(s),
      vod_name: s.musicInfo.name,
      vod_pic: s.pic,
      vod_remarks: catalog.CATALOGS.names[s.platform] + ' · ' + (s.musicInfo.singer || ''),
    })),
    page, pagecount: 1, total: merged.length, limit: 30,
  };
}

/** detail：song: 单曲；pl: 榜单；sl: 歌单（均展开为多集播放列表）。壳传 {id} 单数 */
async function detail(route, body) {
  const id = Array.isArray(body.ids) ? body.ids[0] : (body.ids || body.id);
  if (!id) return { list: [] };
  if (id.startsWith('pl:') || id.startsWith('sl:')) {
    const parts = id.split(':');
    const platform = parts[1];
    // sl: 卡片 id 编入了歌单名（parts[2]），歌单 id 从 parts[3] 起；pl: 无名，从 parts[2] 起
    const isBoard = id.startsWith('pl:');
    const nameSeg = !isBoard && parts.length > 3;
    const listId = (nameSeg ? parts.slice(3) : parts.slice(2)).join(':');
    const songs = isBoard
      ? await catalog.boardSongs(platform, listId, 1)
      : await catalog.songListSongs(platform, listId, 1);
    const name = isBoard
      ? await catalog.boardName(platform, listId)
      : (nameSeg ? decodeURIComponent(parts[2]) : '歌单');
    return {
      list: [{
        vod_id: id,
        vod_name: name,
        vod_pic: (songs[0] && (songs[0].img || songs[0].pic)) || '',
        vod_play_from: PLAY_FLAG,
        vod_play_url: songs.map((s) => s.name + '$lx://' + encodeId({ platform, name: s.name, pic: '', musicInfo: s })).join('#'),
      }],
      page: 1, pagecount: 1, total: 1, limit: 1,
    };
  }
  if (!id.startsWith('song:')) return { list: [] };
  const parts = id.split(':');
  const song = decodeId(parts.slice(2).join(':'));
  return {
    list: [{
      vod_id: id,
      vod_name: song.musicInfo.name,
      vod_pic: song.pic,
      vod_remarks: song.musicInfo.singer + (song.musicInfo.albumName ? ' · ' + song.musicInfo.albumName : ''),
      vod_play_from: PLAY_FLAG,
      vod_play_url: song.name + '$lx://' + encodeId(song),
    }],
    page: 1, pagecount: 1, total: 1, limit: 1,
  };
}

/** play：lx 脚本解析直链（画质位多音质数组）+ musicSdk 增强 pic/lrc（增强项限时，不拖住播放） */
async function play(route, body, sourcesDir) {
  const { flag, id } = body;
  const song = decodeId(id);
  // 切音质场景：flag 为画质名（onMusicQualityChanged 以画质名作 flag 重调）→ 只解析该音质
  const qualities = DEFAULT_QUALITIES.filter((q) => !flag || flag === PLAY_FLAG || flag === QUALITY_TITLES[q]);
  const runtime = getRuntime(route, sourcesDir);
  const t0 = Date.now();
  const ENHANCE_TIMEOUT = 5000;
  const timed = (label, p) => p.then(
    (v) => { console.log(`[play] ${label} ${Date.now() - t0}ms`); return v; },
    (e) => { console.log(`[play] ${label} 失败 ${Date.now() - t0}ms:`, e && e.message); return Promise.reject(e); }
  );
  const withTimeout = (label, p) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => { console.log(`[play] ${label} 超时(${ENHANCE_TIMEOUT}ms) 放弃`); resolve(''); }, ENHANCE_TIMEOUT)),
  ]);
  const [results, pic, lrc] = await Promise.all([
    Promise.allSettled(
      qualities.map(async (q) => ({ q, url: await timed('直链 ' + q, runtime.resolveMusicUrl(song.platform, song.musicInfo, q)) }))
    ),
    song.pic || song.musicInfo.img
      ? Promise.resolve(song.pic || song.musicInfo.img)
      : withTimeout('pic', catalog.getPic(song.platform, song.musicInfo)),
    withTimeout('lrc', catalog.getLyric(song.platform, song.musicInfo)),
  ]);
  const urls = [];
  for (const r of results) {
    if (r.status === 'fulfilled') urls.push(QUALITY_TITLES[r.value.q], r.value.url);
    else console.log('[play] 音质失败', r.reason && r.reason.message);
  }
  if (!urls.length) return { flag: PLAY_FLAG, parse: 0, jx: 0, url: '' };
  const out = { flag: flag || PLAY_FLAG, parse: 0, jx: 0, isMusic: true, url: urls };
  if (pic) out.pic = pic;
  if (lrc) out.lrc = lrc;
  if (PLATFORM_HEADERS[song.platform]) out.header = PLATFORM_HEADERS[song.platform];
  return out;
}

const ACTIONS = { home, category, search, detail, play };

async function dispatch(route, action, body, sourcesDir) {
  const fn = ACTIONS[action];
  if (!fn) throw new Error('未知动作: ' + action);
  return fn(route, body || {}, sourcesDir);
}

module.exports = { dispatch, getRuntime, PLAY_FLAG };
