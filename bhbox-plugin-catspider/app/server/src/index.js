import fastify from 'fastify';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { pathToFileURL } from 'url';
import { join, basename } from 'path';
// ===================================================================
// 统一版 server：一份 index.js 两头用（本地 dex 壳 / 在线 TVBox）
//   本地壳 -> /spider/:name/*  Java NodeSpider 写死该前缀（动作卡适配层）
//   在线壳 -> /api/:name?pwd=  spiderHandler（pwd 门 + auto-init + ext 下发）
//            /config/:id /index 站点下发；POST /api 注册/单key调用
// 配置走环境变量（本地壳由 NodeServerManager 传 PORT/SOURCES_DIR）：
//   PORT / SOURCES_DIR / CONFIG_PWD / EXT_CONFIG / PUBLIC_HOST / SPIDER_JAR
// ===================================================================
function loadEnvFile() {
  let txt;
  try { txt = readFileSync(join(process.cwd(), '.env'), 'utf-8'); } catch { return; }
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile();   // ← 必须在 app.listen 之前、最好在文件顶部就执行
const sourcesDir = process.argv[2] || process.env.SOURCES_DIR || join(process.cwd(), 'sources');
const app = fastify({
    logger: false,
    keepAliveTimeout: 65000,
    bodyLimit: 2 * 1024 * 1024,
});
// TVBox/okhttp 以表单发 extend=<base64>&filter=true，fastify 默认不解析该类型
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try {
        const params = new URLSearchParams(body || '');
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        done(null, obj);
    } catch (e) {
        done(e, {});
    }
});
const PREFIX = '/spider';
const sources = new Map();
// 每 route 上次已 init 的 ext 签名（auto-init 防重；切实例 ext 不同则重初始化）
const lastInitExt = new Map();

function collectRoutes(mod) {
    const routes = new Map();
    const reg = (method) => (path, handler) => routes.set(`${method} ${path}`, handler);
    const fake = {
        post: reg('POST'), get: reg('GET'), all: reg('ANY'), put: reg('PUT'),
        delete: reg('DELETE'), patch: reg('PATCH'), head: reg('HEAD'), options: reg('OPTIONS'),
        route: (opts, handler) => {
            const method = String(Array.isArray(opts?.method) ? opts.method[0] : opts?.method || 'POST').toUpperCase();
            routes.set(`${method} ${opts.url}`, handler);
        },
        // 注册期只允许收集路由；其余 fastify 方法（addHook/decorate 等）安全空实现
        addHook: () => {}, decorate: () => {}, decorateRequest: () => {},
        decorateReply: () => {}, register: () => {}, log: console,
    };
    return Promise.resolve(mod.default.api(fake)).then(() => routes);
}

async function loadSource(file, bust = false) {
    const route = basename(file, '.js');
    const url = pathToFileURL(join(sourcesDir, file)).href + (bust ? `?t=${Date.now()}` : '');
    const mod = await import(url);
    const meta = mod?.default?.meta;
    const api = mod?.default?.api;
    if (typeof api !== 'function' || !meta || !meta.key) {
        throw new Error('invalid source (meta.key + api required)');
    }
    const routes = await collectRoutes(mod);
    const cfg = mod?.default?.config ?? mod?.default?.ext ?? null;
    sources.set(route, { meta, routes, cfg });
    console.log(`register: ${PREFIX}/${route} (${meta.name || meta.key})`);
    return { ok: true, route };
}

// 双布局扫描：md5 嵌套（本地壳宿主维护）+ 平铺 *.js（在线/手放源）
async function loadAll() {
    let entries = [];
    try { entries = readdirSync(sourcesDir, { withFileTypes: true }); } catch (e) {
        console.error('readdir failed: ' + e.message);
    }
    const flatJs = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const f = `${entry.name}/${entry.name}.js`;
            try { await loadSource(f); } catch (e2) { console.error(`load failed: ${f}: ${e2.message}`); }
        } else if (entry.isFile() && entry.name.endsWith('.js')) flatJs.push(entry.name);
    }
    for (const f of flatJs.sort()) {
        try { await loadSource(f); } catch (e2) { console.error(`load failed: ${f}: ${e2.message}`); }
    }
}

// 懒加载 + mtime 失效缓存（/api /config 用；文件没变保住源内登录态，变了 bust 重 import）
const sourceCache = new Map();
const loadLocks = new Map();
async function resolveSource(name) {
    const file = name.endsWith('.js') ? name : name + '.js';
    if (file.includes('/') || file.includes('\\') || file.includes('..')) return null;
    const fullPath = join(sourcesDir, file);
    let mtime = 0;
    try { mtime = statSync(fullPath).mtimeMs; } catch (e) {}
    const cached = sourceCache.get(name);
    if (cached && cached.mtime === mtime) return cached.src;
    if (loadLocks.has(name)) return loadLocks.get(name);
    const p = (async () => {
        try {
            await loadSource(file, true);
            const s = sources.get(name.endsWith('.js') ? name.slice(0, -3) : name);
            sourceCache.set(name, { mtime, src: s });
            return s;
        } catch (e) {
            console.error(`resolve ${name} failed: ${e.message}`);
            const c = sourceCache.get(name);
            return c ? c.src : null;
        } finally { loadLocks.delete(name); }
    })();
    loadLocks.set(name, p);
    return p;
}

// TVBox/catvod 协议兼容：ac/t/ids 等字段标准化为 spider 能识别的 action + 参数。
// 筛选契约：extend=传参（站点配置），ext=筛选；ext 解出对象即挂 filter/filters，不与配置合并。
function standardizeSpiderArgs(query, body) {
    const q = query || {};
    const b = body || {};
    const merged = { ...q, ...b };
    const std = { ...merged };
    let tid = merged.tid != null ? merged.tid : merged.t;
    if (tid === '') tid = undefined;
    const pg = merged.pg != null ? merged.pg : merged.page;
    if (tid !== undefined) std.tid = tid;
    if (pg !== undefined) std.pg = pg;
    if (merged.ids !== undefined) std.ids = merged.ids;
    // 源里 detail/play 读单数 b.id，TVBox 下发的是 ids，补 id 映射防空 list
    const idv = merged.id != null ? merged.id : merged.ids;
    if (idv !== undefined) std.id = idv;
    // 站点配置：TVBox 可能用 ext 或 extend（均 base64(JSON)），extend > ext 优先级。
    // 解码对象写 std.ext；extend 回写归一化 base64（旧式源自行解码用）。
    const rawConf = merged.extend !== undefined ? merged.extend : merged.ext;
    if (rawConf !== undefined) {
        std.extend = rawConf;
        if (std.ext === undefined || typeof std.ext !== 'object') {
            try {
                const eObj = JSON.parse(Buffer.from(String(rawConf), 'base64').toString('utf-8'));
                if (eObj && typeof eObj === 'object') {
                    std.ext = eObj;
                    std.extend = Buffer.from(JSON.stringify(eObj)).toString('base64');
                }
            } catch (e2) { /* 非 base64 JSON（如站点URL）则忽略，f/query 兜底 */ }
        }
    }
    if (merged.filter !== undefined) std.filter = merged.filter;
    if (merged.filters !== undefined) std.filters = merged.filters;
    // play: TVBox 用 play=<URL>&flag=<源名>，源里 /play 读 b.url||b.id + b.flag
    if (merged.play !== undefined) { std.play = merged.play; std.url = merged.play; }
    if (merged.flag !== undefined) std.flag = merged.flag;
    if (merged.flags !== undefined) std.flags = merged.flags;
    // search: TVBox 用 wd=<关键词>&ac=detail/videolist，源读 b.wd||b.keyword + b.quick + b.pg||b.page
    if (merged.wd !== undefined) std.wd = merged.wd;
    if (merged.keyword !== undefined) std.keyword = merged.keyword;
    if (merged.quick !== undefined) std.quick = merged.quick;
    // 筛选契约：extend=传参（站点配置），ext=筛选，f=<b64JSON>=老协议筛选；不合并，取到即挂 filter/filters。
    const dec = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64').toString('utf-8')); } catch (e) { return null; } };
    let filtObj = merged.f !== undefined ? dec(merged.f) : null;
    if (Array.isArray(filtObj)) filtObj = filtObj[0] || null;
    if (filtObj !== null && typeof filtObj !== 'object') filtObj = null;
    if (!filtObj && merged.ext !== undefined && typeof merged.ext !== 'object') {
        const o = dec(merged.ext);
        if (o && !Array.isArray(o)) filtObj = o;
    }
    if (!filtObj) {
        const fe = {};
        for (const k of ['cateId', 'by', 'year', 'area', 'letter', 'class', 'lang', 'actor', 'director', 'tag', 'type']) if (merged[k] !== undefined) fe[k] = merged[k];
        filtObj = Object.keys(fe).length ? fe : null;
    }
    if (filtObj) { std.filter = filtObj; std.filters = filtObj; }
    return std;
}

function resolveSpiderAction(raw, std) {
    let action = String(raw || 'home').replace(/^\/+/, '');
    // TVBox 搜索：wd/keyword 必路由到 search；play 同理
    if (std.wd !== undefined || std.keyword !== undefined) {
        action = 'search';
    } else if (std.play !== undefined) {
        action = 'play';
    } else if (action === 'detail') {
        // TVBox: ac=detail&ids= 详情；ac=detail&t=分类(非空) 分类列表；ac=detail(无t无ids) 首页
        if (std.ids !== undefined) {
            action = 'detail';
        } else if (std.tid !== undefined) {
            action = 'category';
        } else {
            action = 'home';
        }
    } else if (action === 'videolist' || action === 'list') {
        action = 'category';
    } else if (action === 'play') {
        action = 'play';
    }
    return action;
}

// 在线单接口控制器：TVBox type4 源只认 /api/:name（jar 等效）
async function spiderHandler(request, reply) {
    const name = request.params.name;
    const cfgPwd = process.env.CONFIG_PWD;
    if (cfgPwd && String(request.query?.pwd || '') !== cfgPwd) {
        reply.code(401);
        return { error: 'invalid pwd' };
    }
    const src = await resolveSource(name);
    if (!src) {
        reply.code(404);
        return { error: `source not found: ${name}` };
    }
    const reqQuery = request.query ?? {};
    const reqBody = request.body?.body ?? request.body ?? {};
    const std = standardizeSpiderArgs(reqQuery, reqBody);
    const rawAction = request.body?.ac || request.body?.action || reqQuery.ac || reqQuery.action || 'home';
    const action = resolveSpiderAction(rawAction, std);
    // auto-init：catvod 客户端对远程 type4 源常不显式调 /init，而 App3q/AppProtoV5 等依赖
    // /init 把 host/key 写入模块级变量。分发前按 ext 签名自动跑一次 /init（同 ext 只跑一次）。
    const initSig = JSON.stringify(std.ext || {}) || '';
    const initRoute = src.routes.get('POST /init') || src.routes.get('ANY /init');
    const makeScoped = () => {
        const s = Object.create(request);
        s.body = std;
        s.params = request.body?.params ?? {};
        s.query = { ...reqQuery, ...std };
        Object.defineProperty(s, 'server', {
            value: Object.create(request.server, { prefix: { value: `/api/${name}`, enumerable: true } }),
        });
        return s;
    };
    if (initRoute) {
        if (action === 'init') {
            const r = await initRoute(makeScoped(), reply);
            lastInitExt.set(name, initSig);
            return r;
        }
        if (lastInitExt.get(name) !== initSig) {
            try { await initRoute(makeScoped(), reply); } catch (e) { console.log(`[auto-init] ${name} failed: ${e.message}`); }
            lastInitExt.set(name, initSig);
        }
    }
    // 衔接设计：spider jar 单端点一律 POST 发 action，源内路由也是 POST/ANY，以 POST 为主 ANY 兜底
    const method = 'POST';
    const rest = '/' + action;
    const handler = src.routes.get(`${method} ${rest}`) || src.routes.get(`ANY ${rest}`);
    if (!handler) {
        reply.code(404);
        return { error: `route not found: ${method} ${rest}`, routes: [...src.routes.keys()] };
    }
    return handler(makeScoped(), reply);
}
app.all('/api/:name', (req, rep) => spiderHandler(req, rep));

// ===== 在线配置下发（仿 mikesong/drpy-node 协议）=====
// 在线 ext 配置：源内 config 导出优先，json 目录通用兜底（cwd/json/*.json 任意文件名合并），EXT_CONFIG env 最后覆盖。
let _extCache = null;
let _extFingerprint = '';
function getExtConfig() {
    // json 目录 mtime 指纹：源增删改实例写盘后自动感知（不依赖源自查 /load），目录无变化直接吃缓存
    let fp = '';
    try { fp = readdirSync(join(process.cwd(), 'json')).sort().map((f) => { try { return f + ':' + statSync(join(process.cwd(), 'json', f)).mtimeMs; } catch (e) { return f + ':0'; } }).join('|'); } catch (e) {}
    if (_extCache && fp === _extFingerprint) return _extCache;
    let merged = {};
    try {
        for (const f of readdirSync(join(process.cwd(), 'json')).sort()) {
            if (!f.endsWith('.json')) continue;
            try { Object.assign(merged, JSON.parse(readFileSync(join(process.cwd(), 'json', f), 'utf-8'))); } catch (e) {}
        }
    } catch (e) {}
    if (process.env.EXT_CONFIG) {
        try { Object.assign(merged, JSON.parse(process.env.EXT_CONFIG)); } catch (e) {}
    }
    _extCache = merged;
    _extFingerprint = fp;
    return _extCache;
}
// json 顶层 key 统一 = 源文件名(route，即 meta.key)；源名可能带 [模板] 后缀，去后缀再查一次
function confKeyOf(route) {
    const cfg = getExtConfig();
    if (cfg[route] != null) return cfg[route];
    const clean = route.replace(/\[[^\]]*\]/g, '').trim();
    if (clean && clean !== route && cfg[clean] != null) return cfg[clean];
    return {};
}
// 实例字典(value 全对象→按实例拆) vs 单配置对象(value 多为标量→整体一个 site)
function isInstanceDict(d) {
    const vals = Object.values(d);
    if (!vals.length) return false;
    return vals.every((v) => v && typeof v === 'object' && !Array.isArray(v));
}
async function generateConfig(request) {
    const cfgPwd = process.env.CONFIG_PWD || '';
    const proto = request.headers['x-forwarded-proto'] || (request.server?.info?.protocol || 'http');
    const host = process.env.PUBLIC_HOST || request.headers['host'] || `localhost:${process.env.PORT || 3000}`;
    const base = `${proto}://${host}`;
    let files = [];
    try { files = readdirSync(sourcesDir).filter((f) => f.endsWith('.js')).sort(); } catch (e) { /* 目录空 */ }
    const sites = [];
    for (const file of files) {
        const route = basename(file, '.js');
        const src = await resolveSource(route);
        if (!src) continue;
        const meta = src.meta || {};
        const cleanRoute = route.replace(/\[[^\]]*\]/g, '').trim();
        const sc = sources.get(route)?.cfg;
        const extDict = (sc && typeof sc === 'object' && !Array.isArray(sc)) ? sc : confKeyOf(route);
        let instances;
        if (extDict && typeof extDict === 'object' && !Array.isArray(extDict) && isInstanceDict(extDict)) {
            const instKeys = Object.keys(extDict).filter((k) => k !== '示例');
            instances = instKeys.length
                ? instKeys.map((ik) => ({ name: ik, cfg: extDict[ik] }))
                : [{ name: meta.name || meta.key || route, cfg: null }];
        } else if (extDict && typeof extDict === 'object' && !Array.isArray(extDict)) {
            instances = [{ name: meta.name || meta.key || route, cfg: extDict }];
        } else {
            instances = [{ name: meta.name || meta.key || route, cfg: null }];
        }
        for (const inst of instances) {
            const cfgObj = inst.cfg;
            const hasCfg = cfgObj && typeof cfgObj === 'object' && !Array.isArray(cfgObj) && Object.keys(cfgObj).length > 0;
            const _ext = hasCfg ? Buffer.from(JSON.stringify(cfgObj)).toString('base64') : '';
            sites.push({
                key: hasCfg ? `${cleanRoute}_${inst.name}` : (meta.key || route),
                name: inst.name,
                type: 4,
                api: `${base}/api/${encodeURIComponent(route)}` + (cfgPwd ? `?pwd=${cfgPwd}` : ''),
                searchable: 1,
                filterable: 1,
                quickSearch: 0,
                ext: _ext,
            });
        }
    }
    return {
        sites_count: sites.length,
        spider: process.env.SPIDER_JAR || '',
        homepage: '', sniffer: {}, recommend: [], rating: [], doh: [],
        ijk: [], rules: [], ads: [], drives: [],
        sites,
    };
}
app.get('/config/:id', async (request, reply) => {
    const cfgPwd = process.env.CONFIG_PWD;
    if (cfgPwd && String(request.query?.pwd || '') !== cfgPwd) {
        reply.code(401); return { error: 'invalid pwd' };
    }
    return generateConfig(request);
});
app.get('/index', async (request, reply) => {
    const cfgPwd = process.env.CONFIG_PWD;
    if (cfgPwd && String(request.query?.pwd || '') !== cfgPwd) {
        reply.code(401); return { error: 'invalid pwd' };
    }
    return generateConfig(request);
});

// 统一 /check：本地壳与在线端共用，同时给出目录文件清单与已加载源
app.get('/check', async () => {
    let all = [];
    try { all = readdirSync(sourcesDir).filter((f) => f.endsWith('.js')).sort(); } catch (e) { /* 目录不存在返回空 */ }
    return { run: true, dir: sourcesDir, sources: all, loaded: [...sources.keys()] };
});
// ===== POST /api：在线统一 JSON 入口 =====
//   普通调用: { key, action, method, body, params, token? }
//   批量注册: { action:'register', sources:[{name, code|url}], token? }
function checkApiAuth(request, reply) {
    const token = process.env.API_TOKEN;
    if (!token) return true;
    const auth = request.headers['authorization'] || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const provided = m ? m[1] : request.body?.token || request.query?.token;
    if (provided !== token) {
        reply.code(401).header('www-authenticate', 'Bearer');
        return false;
    }
    return true;
}
async function handleRegister(list, reply) {
    if (!Array.isArray(list) || !list.length) {
        reply.code(400);
        return { ok: false, error: 'empty sources' };
    }
    const results = [];
    for (const item of list) {
        const raw = String(item?.name || '');
        const name = raw.replace(/[^a-zA-Z0-9_\-]/g, '');
        const file = name.endsWith('.js') ? name : name + '.js';
        if (!name || file.includes('/') || file.includes('\\') || file.includes('..')) {
            results.push({ ok: false, name: raw, error: 'invalid name' });
            continue;
        }
        try {
            let code = item?.code;
            if (!code && item?.url) {
                const res = await fetch(item.url);
                if (!res.ok) throw new Error('download failed: ' + res.status);
                code = await res.text();
            }
            if (!code || typeof code !== 'string') throw new Error('code or url required');
            writeFileSync(join(sourcesDir, file), code);
            const r = await loadSource(file, true);
            results.push({ ok: true, ...r });
        } catch (e) {
            results.push({ ok: false, name: file, error: e.message });
        }
    }
    return { ok: results.every((r) => r.ok), results };
}
app.post('/api', async (request, reply) => {
    if (!checkApiAuth(request, reply)) return;
    const b = request.body || {};
    const rawAction = b.action || 'home';
    if (rawAction === 'register' || rawAction === 'batch') {
        return handleRegister(b.sources, reply);
    }
    const key = String(b.key || '');
    if (!key) {
        reply.code(400);
        return { ok: false, error: 'missing key' };
    }
    const src = sources.get(key);
    if (!src) {
        reply.code(404);
        return { ok: false, error: `source not found: ${key}`, sources: [...sources.keys()] };
    }
    const bQuery = b.params ?? {};
    const bBody = b.body ?? b ?? {};
    const std = standardizeSpiderArgs(bQuery, bBody);
    const action = resolveSpiderAction(rawAction, std);
    const method = String(b.method || 'POST').toUpperCase();
    const rest = '/' + action;
    const handler = src.routes.get(`${method} ${rest}`) || src.routes.get(`ANY ${rest}`);
    if (!handler) {
        reply.code(404);
        return { ok: false, error: `route not found: ${method} ${rest}`, routes: [...src.routes.keys()] };
    }
    const scoped = Object.create(request);
    scoped.body = std;
    scoped.params = b.params ?? {};
    scoped.query = { ...std, ...(b.params ?? {}) };
    Object.defineProperty(scoped, 'server', {
        value: Object.create(request.server, { prefix: { value: `${PREFIX}/${key}`, enumerable: true } }),
    });
    return handler(scoped, reply);
});

// ===== 本地 dex 壳通道：/spider/:name/* 通配分发（真机实测通过，一字不动）=====
app.all(`${PREFIX}/:name/*`, async (request, reply) => {
    const name = request.params.name;
    const rest = '/' + request.params['*'];
    const src = sources.get(name);
    if (!src) {
        reply.code(404);
        return { error: `source not found: ${name}` };
    }
    const method = request.method.toUpperCase();
    const handler = src.routes.get(`${method} ${rest}`) || src.routes.get(`ANY ${rest}`);
    if (!handler) {
        reply.code(404);
        return { error: `route not found: ${method} ${rest}` };
    }
    // ==== 动作卡协议适配(壳→源, 本地 /spider 与 在线 /api 共用同一份逻辑) ====
    // 在线壳走标准协议(body 带 action 键)直接命中; 本地 dex 壳把 vod_id 原文整体 POST
    // (裸串或卡片 JSON, 无 action 键)→ 这里补齐 action 提取 + 首击回显 + 提交折叠。
    // 首击流: 卡片 JSON 带 input[]/input 型且无 value → 回显 {action:卡片JSON} 让壳渲染弹窗
    // 提交流: input[] 有非空值或已带 value → 折叠/归一化 value 透传源内入库。失败不影响原分发。
    try {
        const q = request.query || {};
        let ab = request.body;
        if (typeof ab === 'string') {
            try { ab = JSON.parse(ab); request.body = ab; } catch (e) {
                ab = null;
                if (rest === '/action' && String(request.body || '').trim() !== '') request.body = { action: request.body };
            }
        }
        if (rest === '/action' && ab && typeof ab === 'object' && !Array.isArray(ab)) {
            if (ab.action === undefined && ab.do === undefined) {
                let cand = ab.actionId !== undefined ? ab.actionId : (q.actionId !== undefined ? q.actionId : (q.do !== undefined ? q.do : (q.action !== undefined ? q.action : undefined)));
                if (cand === undefined) {
                    const ks = Object.keys(ab);
                    if (ks.length === 1 && ab[ks[0]] === '') cand = ks[0];
                }
                if (cand !== undefined) ab.action = String(cand);
            }
            if (ab.value !== undefined && ab.value !== null && typeof ab.value === 'object') ab.value = JSON.stringify(ab.value);
            if (ab.action !== undefined && ab.value === undefined && (Array.isArray(ab.input) || ab.type === 'multiInput' || ab.type === 'input' || ab.type === 'edit')) {
                if (Array.isArray(ab.input)) {
                    const vals = {};
                    let filled = false;
                    for (const it of ab.input) { if (it && it.id !== undefined) { const v = (it.value !== undefined && it.value !== null) ? it.value : ''; vals[it.id] = v; if (v !== '') filled = true; } }
                    if (filled) ab.value = JSON.stringify(vals);
                }
                if (ab.value === undefined) {
                    console.log('[action-echo] ' + name + rest + ' first-press echo');
                    return { action: ab };
                }
            }
        }
        console.log('[action] ' + name + rest + ' q=' + JSON.stringify(q) + ' b=' + JSON.stringify(request.body));
    } catch (e) { /* adapter failure never breaks dispatch */ }
    // scoped 注入：prefix 带正确源名（URL 编码，AliPlayer curl 严格模式不规范化路径）
    const scoped = Object.create(request);
    Object.defineProperty(scoped, 'server', {
        value: Object.create(request.server, { prefix: { value: `${PREFIX}/${encodeURIComponent(name)}`, enumerable: true } }),
    });
    return handler(scoped, reply);
});

// 热加载：运行中注册新源或重载已更新源文件（bust=true 穿透 ESM import 缓存）。
// 校验放宽为双布局：md5 嵌套 <md5>/<md5>.js（本地壳）或 平铺 <name>.js（在线/手放），均防路径逃逸。
app.post('/load', async (request, reply) => {
    const file = String(request.body?.file || '');
    const md5Layout = /^[0-9a-f]{32}\/[0-9a-f]{32}\.js$/.test(file);
    const flat = !file.includes('/') && !file.includes('\\') && !file.includes('..') && file.endsWith('.js') && file.length > 3;
    if (!md5Layout && !flat) {
        reply.code(400);
        return { ok: false, error: 'invalid file name' };
    }
    try {
        const r = await loadSource(file, request.body?.bust === true);
        try { _extCache = null; } catch (e2) {} // 配置实例增删改后立刻失效 ext 缓存，下次 /config 重扫 json/
        return r;
    } catch (e) {
        reply.code(500);
        return { ok: false, error: e.message };
    }
});
main().catch((e) => {
    console.error('startup failed: ' + e.message);
    process.exit(1);
});
async function main() {
    await loadAll();
    await app.listen({ port: Number(process.env.PORT || 0), host: '0.0.0.0' });
    console.log(`listening on 0.0.0.0:${app.server.address().port}`);
}
