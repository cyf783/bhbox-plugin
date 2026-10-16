// P0 桌面验收：网易云源全链路（home → category 展开 → 搜索 → 详情 → 播放取流/歌词）
// 用法：node scripts/test-netease.mjs
import {spawn} from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const bundle = path.resolve(serverDir, '../src/main/assets/ds-server.cjs');
const sourceSrc = '/Users/swifly/FreeSpace/BHBox/docs/ds/网易云音乐(1).js';
const homeDir = path.join(serverDir, '.test-home');
const PORT = 9940;

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// 源身份 = md5(归一化 api + "\n" + ext)，与 Java 侧 DsSpider 的算法保持一致
const route = md5(sourceSrc + '\n' + '');
const routeDir = path.join(homeDir, route);
fs.rmSync(homeDir, {recursive: true, force: true});
fs.mkdirSync(routeDir, {recursive: true});
fs.copyFileSync(sourceSrc, path.join(routeDir, route + '.js'));
console.log('[test] route =', route);

const proc = spawn('node', [bundle, homeDir], {
    env: {...process.env, DS_PORT: String(PORT)},
    stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
proc.stderr.on('data', (d) => process.stderr.write('[srv!] ' + d));

const base = 'http://127.0.0.1:' + PORT;
async function api(method, url, body) {
    const res = await fetch(base + url, {
        method,
        headers: {'content-type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = text; }
    return {status: res.status, json};
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitReady() {
    for (let i = 0; i < 50; i++) {
        try {
            const r = await api('GET', '/check');
            if (r.status === 200 && r.json.run) return;
        } catch (e) {}
        await sleep(300);
    }
    throw new Error('server not ready');
}

const brief = (o) => {
    if (Array.isArray(o)) return `Array(${o.length}) ` + JSON.stringify(o.slice(0, 2));
    return JSON.stringify(o)?.slice(0, 600);
};

try {
    await waitReady();
    console.log('\n===== 1) home(filter=1) =====');
    const home = await api('POST', `/ds/${route}/home`, {filter: 1});
    console.log('status:', home.status);
    console.log('class:', brief(home.json.class));
    console.log('filters:', brief(home.json.filters));
    console.log('list:', brief(home.json.list));

    console.log('\n===== 2) category 排行榜榜单展开 =====');
    const cate = await api('POST', `/ds/${route}/category`, {id: 'toplist', page: 1});
    console.log('status:', cate.status, 'tid: toplist');
    console.log('result:', brief(cate.json.list || cate.json));
    const firstListId = (cate.json.list || [])[0]?.vod_id;

    console.log('\n===== 2b) category 歌单展开（榜单内容） =====');
    const cate2 = await api('POST', `/ds/${route}/category`, {id: firstListId, page: 1});
    console.log('status:', cate2.status, 'vod_id:', firstListId);
    console.log('result:', brief(cate2.json.list || cate2.json));

    console.log('\n===== 3) search 周杰伦 =====');
    const search = await api('POST', `/ds/${route}/search`, {wd: '周杰伦', page: 1});
    console.log('status:', search.status);
    console.log('result:', brief(search.json.list || search.json));

    console.log('\n===== 4) detail 榜单 =====');
    const detail = await api('POST', `/ds/${route}/detail`, {id: firstListId});
    console.log('status:', detail.status);
    const detailList = detail.json.list || [];
    console.log('detail count:', detailList.length, 'first:', brief(detailList[0]));
    const playUrl = detailList[0]?.vod_play_url?.split('$$$')[0] || '';
    const firstEp = playUrl.split('#')[0];

    console.log('\n===== 5) play 取流+歌词（极高） =====');
    if (firstEp) {
        const [epName, epId] = firstEp.split('$');
        const play = await api('POST', `/ds/${route}/play`, {flag: '极高', id: epId});
        console.log('status:', play.status);
        const r = play.json;
        console.log('play keys:', Object.keys(r));
        console.log('parse:', r.parse, '| url isArray:', Array.isArray(r.url), '| url[0]:', r.url?.[0]);
        console.log('url[1] head:', String(r.url?.[1]).slice(0, 80));
        console.log('header keys:', r.header && Object.keys(r.header));
        console.log('lrc length:', r.lrc ? r.lrc.length : r.lrc, '| lrc head:', String(r.lrc).slice(0, 40).replace(/\n/g, '\\n'));
        console.log('pic:', r.pic || r.cover);
    } else {
        console.log('skip: no episode');
    }

    console.log('\n===== ALL DONE =====');
} catch (e) {
    console.error('[test] FAILED:', e);
    process.exitCode = 1;
} finally {
    proc.kill();
}
