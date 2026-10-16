// P1 验收：预置源依赖（assets/npm）按 Java 部署方式落地后，源内 require 裸包可用
// 用法：node scripts/test-deps.mjs
import {spawn} from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const bundle = path.resolve(serverDir, '../src/main/assets/ds-server.cjs');
const npmAssets = path.resolve(serverDir, '../src/main/assets/npm');
const sourceSrc = path.join(here, 'fixtures/deps-test.js');
const homeDir = path.join(serverDir, '.test-deps');
const PORT = 9941;

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// 1) 模拟 Java 部署：<pkg>.json -> <pkg>/package.json，三件套落到 node_modules/<pkg>/
fs.rmSync(homeDir, {recursive: true, force: true});
const nm = path.join(homeDir, 'node_modules');
fs.mkdirSync(nm, {recursive: true});
for (const f of fs.readdirSync(npmAssets)) {
    if (!f.endsWith('.json')) continue;
    const pkg = f.slice(0, -'.json'.length);
    const dir = path.join(nm, pkg);
    fs.mkdirSync(dir, {recursive: true});
    fs.copyFileSync(path.join(npmAssets, f), path.join(dir, 'package.json'));
    fs.copyFileSync(path.join(npmAssets, pkg + '.cjs'), path.join(dir, pkg + '.cjs'));
    fs.copyFileSync(path.join(npmAssets, pkg + '.mjs'), path.join(dir, pkg + '.mjs'));
}
fs.writeFileSync(path.join(nm, 'noop.js'), '');

// 2) 放置源（身份算法同 Java：md5(api + "\n" + ext)）
const route = md5(sourceSrc + '\n' + '');
const routeDir = path.join(homeDir, route);
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitReady() {
    for (let i = 0; i < 50; i++) {
        try {
            const res = await fetch(base + '/check');
            if (res.ok && (await res.json()).run) break;
        } catch (e) {}
        await sleep(300);
    }
}

try {
    await waitReady();
    const res = await fetch(`${base}/ds/${route}/category`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({id: 'test', page: 1}),
    });
    const json = await res.json();
    console.log('status:', res.status);
    console.log('list:', JSON.stringify(json.list || json));
    const list = json.list || [];
    if (list.length === 2 && list[0].vod_id === '/a' && list[0].vod_name === '甲') {
        console.log('PASS: cheerio 裸包 require + 解析正常');
    } else {
        console.error('FAIL: 结果不符预期');
        process.exitCode = 1;
    }
} catch (e) {
    console.error('[test] FAILED:', e);
    process.exitCode = 1;
} finally {
    proc.kill();
}
