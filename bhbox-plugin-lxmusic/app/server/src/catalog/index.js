'use strict';
// 曲库适配层：基于 vendor musicSdk（洛雪系全平台适配，源自 lxserver 同款实现）
// 每平台暴露 musicSearch / leaderboard / songList / getLyric / getPic / getMusicUrl
const musicSdk = require('../vendor/musicSdk').default;

const NAMES = { kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易云', mg: '咪咕', bd: '百度', xm: '小咪' };
// 有搜索能力才出现在分类里（xm 无 musicSearch）
const IDS = Object.keys(NAMES).filter((id) => musicSdk[id] && musicSdk[id].musicSearch);

/** 搜索单曲：musicSdk 歌曲对象即 LX musicInfo 形状，直接透传给 lx 脚本 */
async function search(platform, wd, page) {
  const mod = musicSdk[platform];
  if (!mod || !mod.musicSearch) return [];
  const result = await mod.musicSearch.search(wd, page, 20);
  return (result && result.list || []).filter((s) => s && s.songmid).map((s) => ({
    platform,
    name: s.name + ' - ' + (s.singer || ''),
    pic: s.img || '',
    musicInfo: s,
  }));
}

/** 全平台搜索，交错混排 */
async function searchAll(wd, page) {
  const settled = await Promise.allSettled(IDS.map(async (id) => ({ id, songs: await search(id, wd, page) })));
  const perPlatform = settled.map((s) => (s.status === 'fulfilled' ? s.value.songs : []));
  const merged = [];
  for (let i = 0; i < 20; i++) for (const songs of perPlatform) if (songs[i]) merged.push(songs[i]);
  return merged;
}

/** 解包 vendor 返回值：可能是直接值 / Promise / 带 .promise 的请求包装（async 方法外层还会再包一层 Promise） */
async function unwrapVendor(v, depth = 4) {
  for (let i = 0; i < depth; i++) {
    if (v && typeof v === 'object' && typeof v.then === 'function') { v = await v; continue; }
    if (v && typeof v === 'object' && typeof v.promise !== 'undefined') { v = await v.promise; continue; }
    break;
  }
  return v;
}

/** 封面（非阻塞增强，失败返回 ''）。各平台返回形状不一：URL 字符串 / {url} / 请求包装 */
async function getPic(platform, musicInfo) {
  try {
    const mod = musicSdk[platform];
    if (!mod || !mod.getPic) return '';
    const pic = await unwrapVendor(mod.getPic(musicInfo));
    if (typeof pic === 'string') return pic;
    return (pic && pic.url) || '';
  } catch { return ''; }
}

/** 歌词（非阻塞增强，失败返回 ''）。各平台 getLyric 返回带 .promise 的请求包装 */
async function getLyric(platform, musicInfo) {
  try {
    const mod = musicSdk[platform];
    if (!mod || !mod.getLyric) return '';
    const info = await unwrapVendor(mod.getLyric(musicInfo));
    return (info && info.lyric) || '';
  } catch { return ''; }
}

/** 榜单列表（分类页卡片）：{id, name}。getBoards 均为静态数据，按平台缓存 */
const boardsCache = new Map();
async function boards(platform) {
  if (boardsCache.has(platform)) return boardsCache.get(platform);
  try {
    const mod = musicSdk[platform];
    if (!mod || !mod.leaderboard || !mod.leaderboard.getBoards) return [];
    const r = await unwrapVendor(mod.leaderboard.getBoards());
    const list = (r && r.list) || [];
    boardsCache.set(platform, list);
    return list;
  } catch { return []; }
}

/** 榜单名称（详情页标题用） */
async function boardName(platform, boardId) {
  const list = await boards(platform);
  const b = list.find((x) => String(x.id) === String(boardId));
  return b ? b.name : '榜单';
}

/** 榜单内歌曲（LX musicInfo 形状）。榜单卡 id 形如 'wy__19723756'，各平台接口要求数字 bangid */
async function boardSongs(platform, boardId, page) {
  try {
    const mod = musicSdk[platform];
    if (!mod || !mod.leaderboard || !mod.leaderboard.getList) return [];
    const r = await unwrapVendor(mod.leaderboard.getList(String(boardId).replace(/^[a-z]+__/, ''), page));
    return ((r && r.list) || []).filter((s) => s && s.songmid);
  } catch { return []; }
}

/** 歌单标签（分类 filter 用）：kw 返回 {tags:[{name,list:[{id,name}]}]} 分组嵌套，其余为数组。拍平缓存，限 14 个 */
const tagsCache = new Map();
async function songListTags(platform) {
  if (tagsCache.has(platform)) return tagsCache.get(platform);
  try {
    const sl = musicSdk[platform] && musicSdk[platform].songList;
    if (!sl || !sl.getTags) return [];
    const raw = await unwrapVendor(sl.getTags());
    const arr = Array.isArray(raw) ? raw : ((raw && raw.tags) || []);
    const flat = [];
    for (const t of arr) {
      if (Array.isArray(t && t.list)) {
        for (const c of t.list) flat.push({ id: String(c.id), name: t.name + ' · ' + c.name });
      } else if (t && t.id) {
        flat.push({ id: String(t.id), name: t.name });
      }
    }
    const tags = flat.filter((t) => t.id && t.id !== 'undefined' && t.name).slice(0, 14);
    tagsCache.set(platform, tags);
    return tags;
  } catch { return []; }
}

/** 歌单列表（分类页卡片）：{id, name, pic, author}。kw 的 id 自带 digest- 前缀，透传 */
async function songLists(platform, tagId, page) {
  try {
    const sl = musicSdk[platform] && musicSdk[platform].songList;
    if (!sl || !sl.getList) return { list: [], total: 0 };
    const r = await unwrapVendor(sl.getList('', tagId || '', page));
    return {
      list: ((r && r.list) || []).filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: x.name || '', pic: x.img || '', author: x.author || '' })),
      total: (r && r.total) || 0,
    };
  } catch { return { list: [], total: 0 }; }
}

/** 歌单内歌曲（LX musicInfo 形状）。各平台 getListDetail(id, page) */
async function songListSongs(platform, listId, page) {
  try {
    const sl = musicSdk[platform] && musicSdk[platform].songList;
    if (!sl || !sl.getListDetail) return [];
    const r = await unwrapVendor(sl.getListDetail(String(listId), page));
    return ((r && r.list) || r || []).filter((s) => s && s.songmid);
  } catch { return []; }
}

/** 标签同步读缓存（home 用，未预热完则空，下次进入生效） */
function tags(platform) { return tagsCache.get(platform) || []; }

module.exports = { CATALOGS: { ids: IDS, names: NAMES, tags }, search, searchAll, getPic, getLyric, boards, boardName, boardSongs, songListTags, songLists, songListSongs, musicSdk };
