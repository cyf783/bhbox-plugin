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

/** 提取 lx 脚本 inited 上报的音源 id 集合：官方数组 [{name,id,type,qualitys}] 或聚合脚本对象 map {kw:{...}}；未上报返回 null。
 *  inited 为脚本异步上报（拉远端配置），限时 3s 等待，超时按未声明兜底 */
async function scriptSourceIds(runtime) {
  try { await Promise.race([runtime && runtime.initedPromise, new Promise((r) => setTimeout(r, 3000))]); } catch {}
  const s = runtime && runtime.sources;
  if (Array.isArray(s)) return s.map((x) => x && (x.id || x.name)).filter(Boolean);
  if (s && typeof s === 'object') return Object.keys(s);
  return null;
}

/** 加载脚本运行时；加载失败返回 null（坏脚本站点一律按空站处理，绝不回退内置曲库伪装可用） */
function tryRuntime(route, sourcesDir) {
  try { return getRuntime(route, sourcesDir); } catch (e) {
    console.log('[route]', route, '脚本不可用:', e.message);
    return null;
  }
}

/** home：class = 音源平台（filters：榜单/歌单 + 歌单标签，标准 TVBox filter 形状）。标签限时 3s 加载（带缓存）。
 *  分类按脚本声明的 sources 求交集——不同 lx 脚本站点展示各自支持的平台；
 *  脚本加载失败 → 空站（宿主无分类可点）；加载成功但未声明 sources → 全量 */
async function home(route, body, sourcesDir) {
  const runtime = tryRuntime(route, sourcesDir);
  if (!runtime) return { class: [], filters: {}, list: [] };
  if (runtime.type === 'mf' || runtime.type === 'mf-bundle') return mfHome(route, body, sourcesDir);
  const declared = await scriptSourceIds(runtime);
  const ids = declared && declared.length
    ? catalog.CATALOGS.ids.filter((id) => declared.includes(id))
    : catalog.CATALOGS.ids;
  await Promise.race([
    Promise.all(ids.map((id) => catalog.songListTags(id))),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  const filters = {};
  for (const id of ids) {
    // 单筛选器：榜单打头，其余为歌单标签（v='' 热门歌单；v=tagId 对应标签；v='board' 榜单）
    filters[id] = [{
      key: 'type', name: '分类',
      value: [{ n: '榜单', v: 'board' }, { n: '热门歌单', v: '' }, ...catalog.CATALOGS.tags(id).map((t) => ({ n: t.name, v: t.id }))],
    }];
  }
  // 首页推荐位：第一个平台的榜单卡片（boards 为静态缓存数据，开销可忽略）
  let list = [];
  try { list = (await category(route, { id: ids[0], page: 1, extend: { type: 'board' } }, sourcesDir)).list || []; } catch {}
  return {
    class: ids.map((id) => ({ type_id: id, type_name: catalog.CATALOGS.names[id] })),
    filters,
    list,
  };
}

/** category：分类 tab（id=平台）→ 榜单/歌单卡片；extend.type='board' 榜单，'' 热门歌单，其余为歌单标签 id。
 *  封面走本服务 /cover/<platform>/<boardId>（302 到榜首歌曲封面，带缓存）。坏脚本站点返回空列表 */
async function category(route, body, sourcesDir) {
  const runtime = tryRuntime(route, sourcesDir);
  if (!runtime) return { list: [], page: 1, pagecount: 1, total: 0, limit: 30 };
  if (runtime.type === 'mf' || runtime.type === 'mf-bundle') return mfCategory(route, body, sourcesDir);
  const page = Number(body.page) || 1;
  const platform = body.id || body.type_id || catalog.CATALOGS.ids[0];
  const extend = body.extend || {};
  const type = extend.type !== undefined ? extend.type : 'board';
  const port = parseInt(process.env.LX_PORT, 10) || 9920;
  if (type !== 'board') {
    const r = await catalog.songLists(platform, type || '', page);
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

/** search：全平台并行搜索（musicSdk 七平台），结果交错混排。坏脚本站点返回空列表 */
async function search(route, body, sourcesDir) {
  const runtime = tryRuntime(route, sourcesDir);
  if (!runtime) return { list: [], page: 1, pagecount: 1, total: 0, limit: 30 };
  if (runtime.type === 'mf' || runtime.type === 'mf-bundle') return mfSearch(route, body, sourcesDir);
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

/** detail：song: 单曲；pl: 榜单；sl: 歌单（均展开为多集播放列表）。壳传 {id} 单数。坏脚本站点返回空列表 */
async function detail(route, body, sourcesDir) {
  if (!tryRuntime(route, sourcesDir)) return { list: [], page: 1, pagecount: 1, total: 0, limit: 1 };
  const id = Array.isArray(body.ids) ? body.ids[0] : (body.ids || body.id);
  if (!id) return { list: [] };
  if (/^(pl|sl|song):\d*:mf:/.test(id)) return mfDetail(route, id, sourcesDir);
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
  if (id && id.startsWith('mf://')) return mfPlay(route, body, sourcesDir);
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

// ============ MusicFree 插件协议分支（runtime.type==='mf' 单插件 / 'mf-bundle' 订阅多插件，见 mf-runtime.js）============
// id 约定（pid = 站点内插件序号，单插件恒为 '0'）：
// 分类 pid；榜单 'pl:<pid>:mf:<id>'；歌单 'sl:<pid>:mf:<name>:<id>'；单曲 'song:<pid>:mf:<b64url(musicItem)>'；点播 'mf://<pid>/<b64url>'

function mfEncode(item) {
  return Buffer.from(JSON.stringify(item), 'utf8').toString('base64url');
}

/** 统一插件列表：单插件 → [{id:'0'}]；订阅 bundle → 惰性 await 下载+加载结果（失败抛错 → 空站） */
async function mfEnsure(route, sourcesDir) {
  const runtime = tryRuntime(route, sourcesDir);
  if (!runtime) throw new Error('脚本不可用');
  if (runtime.type === 'mf') return [{ id: '0', name: (runtime.plugin && runtime.plugin.platform) || '插件', runtime }];
  if (runtime.type === 'mf-bundle') {
    if (!runtime.plugins) {
      const bundle = await runtime.promise.catch((e) => { throw new Error('订阅加载失败: ' + e.message); });
      runtime.plugins = bundle.plugins;
    }
    return runtime.plugins;
  }
  throw new Error('非 MusicFree 源');
}

function mfSongCard(item, pid) {
  return {
    vod_id: 'song:' + pid + ':mf:' + mfEncode(item),
    vod_name: item.title || item.name || String(item.id),
    vod_pic: item.artwork || item.coverImg || item.cover || '',
    vod_remarks: item.artist || item.singer || '',
  };
}

/** mf home：class = 各插件（订阅内多插件）；filter = 榜单 + 各插件歌单标签（2s 限时）；list = 第一个插件榜单 */
async function mfHome(route, body, sourcesDir) {
  const plugins = await mfEnsure(route, sourcesDir);
  const filters = {};
  await Promise.all(plugins.map(async (p) => {
    let vals = [{ n: '榜单', v: 'board' }];
    try {
      const tags = await Promise.race([p.runtime.call('getRecommendSheetTags'), new Promise((r) => setTimeout(r, 2000))]);
      vals = vals.concat(((tags && (tags.pinned || tags.data)) || []).map((t) => ({ n: t.title || t.name || String(t.id), v: 'tag:' + t.id })));
    } catch {}
    filters[p.id] = [{ key: 'type', name: '分类', value: vals }];
  }));
  let list = [];
  try { list = (await mfCategory(route, { id: plugins[0].id, page: 1, extend: { type: 'board' } }, sourcesDir)).list || []; } catch {}
  return { class: plugins.map((p) => ({ type_id: p.id, type_name: p.name })), filters, list };
}

/** mf category：body.id=插件序号；type='board' → getTopLists 拍平榜单卡片；否则 getRecommendSheetsByTag */
async function mfCategory(route, body, sourcesDir) {
  const page = Number(body.page) || 1;
  const plugins = await mfEnsure(route, sourcesDir);
  const pid = body.id !== undefined ? String(body.id) : '0';
  const plugin = plugins.find((p) => p.id === pid) || plugins[0];
  const runtime = plugin.runtime;
  const prefix = 'pl:' + plugin.id + ':mf:';
  const slPrefix = 'sl:' + plugin.id + ':mf:';
  const extend = body.extend || {};
  const type = extend.type !== undefined ? extend.type : 'board';
  if (type !== 'board') {
    const tagId = type.startsWith('tag:') ? type.slice(4) : '0';
    // 推荐 feed 无真实分页（插件忽略 page，内容随机重复）→ 只取第 1 页去重，后续页返回空；
    // discover/mix 无签名请求会被网关间歇性拒空，重试到拿到数据为止（上限 6 次）
    if (page > 1) return { list: [], page, pagecount: 1, total: 0, limit: 30 };
    let r = null;
    for (let i = 0; i < 6 && !(r && r.data && r.data.length); i++) {
      if (i) await new Promise((rs) => setTimeout(rs, 400));
      try {
        r = await runtime.call('getRecommendSheetsByTag', { id: tagId }, 1);
      } catch { r = null; }
    }
    const seen = new Set();
    const sheets = ((r && r.data) || []).filter((l) => {
      if (!l || !l.id || seen.has(String(l.id))) return false;
      seen.add(String(l.id));
      return true;
    });
    return {
      list: sheets.map((l) => ({
        vod_id: slPrefix + encodeURIComponent(l.title || l.name || '') + ':' + l.id,
        vod_name: l.title || l.name || String(l.id),
        vod_pic: l.artwork || l.coverImg || l.cover || '',
        vod_remarks: (l.description || '歌单').slice(0, 40),
      })),
      page: 1, pagecount: 1, total: sheets.length, limit: 30,
    };
  }
  const groups = await runtime.call('getTopLists');
  const boards = (groups || []).flatMap((g) => (g && g.data) || []);
  return {
    list: boards.map((b) => ({
      vod_id: prefix + b.id,
      vod_name: b.title || b.name || String(b.id),
      vod_pic: b.coverImg || b.artwork || '',
      vod_remarks: (b.description || '榜单').slice(0, 40),
    })),
    page, pagecount: 1, total: boards.length, limit: 30,
  };
}

/** mf search：全部插件并行搜索（8s 限时，各取 15 首）交错混排，remarks 前缀插件名便于区分来源 */
async function mfSearch(route, body, sourcesDir) {
  const wd = body.wd || '';
  const page = Number(body.page) || 1;
  if (!wd) return { list: [], page, pagecount: 1, total: 0, limit: 30 };
  const plugins = await mfEnsure(route, sourcesDir);
  const rs = await Promise.allSettled(plugins.map(async (p) => {
    const r = await Promise.race([
      p.runtime.call('search', wd, page, 'music'),
      new Promise((res) => setTimeout(() => res(null), 15000)),
    ]);
    const data = (r && r.data) || [];
    return data.slice(0, 15).map((s) => {
      const c = mfSongCard(s, p.id);
      c.vod_remarks = (s.artist || s.singer ? p.name + ' · ' + (s.artist || s.singer) : p.name);
      return c;
    });
  }));
  const lists = rs.filter((r) => r.status === 'fulfilled' && Array.isArray(r.value)).map((r) => r.value);
  rs.forEach((r, i) => { if (r.status === 'rejected') console.log('[mf search]', plugins[i] && plugins[i].name, '失败:', r.reason && (r.reason.message || r.reason)); });
  const merged = [];
  for (let i = 0; merged.length < 30; i++) {
    let added = false;
    for (const l of lists) if (i < l.length) { merged.push(l[i]); added = true; }
    if (!added) break;
  }
  return { list: merged, page, pagecount: 1, total: merged.length, limit: 30 };
}

/** mf detail：榜单/歌单/单曲均展开为播放列表（集=歌，画质位=音质在 play 层）；id 带 pid 路由到对应插件 */
async function mfDetail(route, id, sourcesDir) {
  const plugins = await mfEnsure(route, sourcesDir);
  let pid = '0', rest = id;
  const m = id.match(/^(pl|sl|song):(\d+):mf:(.+)$/);
  if (m) { pid = m[2]; rest = m[1] + ':mf:' + m[3]; }
  else if (!/^(pl|sl|song):mf:/.test(id)) return { list: [] };
  const plugin = plugins.find((p) => p.id === pid) || plugins[0];
  const runtime = plugin.runtime;
  const parts = rest.split(':');
  let name = '', pic = '', songs = [];
  if (rest.startsWith('pl:mf:')) {
    const r = await runtime.call('getTopListDetail', { id: parts.slice(2).join(':') });
    songs = (r && r.musicList) || [];
    name = (r && (r.title || r.name)) || '榜单';
    pic = (r && (r.coverImg || r.artwork)) || (songs[0] && (songs[0].artwork || songs[0].coverImg)) || '';
  } else if (rest.startsWith('sl:mf:')) {
    const r = await runtime.call('getMusicSheetInfo', { id: parts.slice(3).join(':') });
    songs = (r && r.musicList) || [];
    name = parts.length > 3 ? decodeURIComponent(parts[2]) : '歌单';
    pic = (songs[0] && (songs[0].artwork || songs[0].coverImg)) || '';
  } else if (rest.startsWith('song:mf:')) {
    const item = JSON.parse(Buffer.from(parts.slice(2).join(':'), 'base64url').toString('utf8'));
    songs = [item];
    name = item.title || item.name || String(item.id);
    pic = item.artwork || '';
  } else return { list: [] };
  const playUrl = songs
    .map((s) => `${s.title || s.name || s.id}${s.artist ? ' - ' + s.artist : ''}$mf://${plugin.id}/${mfEncode(s)}`)
    .join('#');
  return {
    list: [{ vod_id: id, vod_name: name, vod_pic: pic, vod_play_from: PLAY_FLAG, vod_play_url: playUrl }],
    page: 1, pagecount: 1, total: 1, limit: 1,
  };
}

/** mf play：按 pid 路由插件，并行解析 supportedQualities 直链（画质位数组）+ getLyric 歌词 */
async function mfPlay(route, body, sourcesDir) {
  const { flag, id } = body;
  let pid = '0', raw;
  if (id.startsWith('mf://')) {
    raw = id.slice(5);
    const s = raw.indexOf('/');
    if (s > -1) { pid = raw.slice(0, s); raw = raw.slice(s + 1); }
  } else {
    const m = id.match(/^song:(\d+):mf:(.+)$/);
    if (m) { pid = m[1]; raw = m[2]; } else raw = id.replace(/^song:mf:/, '');
  }
  const musicItem = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  const plugins = await mfEnsure(route, sourcesDir);
  const runtime = (plugins.find((p) => p.id === pid) || plugins[0]).runtime;
  const allQ = (runtime.plugin.supportedQualities || ['128k']);
  const qualities = allQ.filter((q) => !flag || flag === PLAY_FLAG || flag === (QUALITY_TITLES[q] || q));
  const results = await Promise.allSettled(qualities.map(async (q) => {
    const r = await runtime.call('getMediaSource', musicItem, q);
    const url = r && (typeof r === 'string' ? r : r.url);
    if (typeof url !== 'string' || !/^https?:/.test(url) || url.length > 2048) throw new Error('解析结果非法');
    return { q, url };
  }));
  const urls = [];
  for (const r of results) {
    if (r.status === 'fulfilled') urls.push(QUALITY_TITLES[r.value.q] || r.value.q, r.value.url);
    else console.log('[mf play] 音质失败', r.reason && r.reason.message);
  }
  if (!urls.length) return { flag: PLAY_FLAG, parse: 0, jx: 0, isMusic: true, url: '' };
  const out = { flag: flag || PLAY_FLAG, parse: 0, jx: 0, isMusic: true, url: urls };
  if (musicItem.artwork) out.pic = musicItem.artwork;
  try {
    const l = await runtime.call('getLyric', musicItem);
    const lrc = l && (l.rawLrc || l.krc || l.lrc);
    if (lrc) out.lrc = lrc;
  } catch {}
  return out;
}

const ACTIONS = { home, category, search, detail, play };
async function dispatch(route, action, body, sourcesDir) {
  const fn = ACTIONS[action];
  if (!fn) throw new Error('未知动作: ' + action);
  return fn(route, body || {}, sourcesDir);
}

module.exports = { dispatch, getRuntime, PLAY_FLAG };
