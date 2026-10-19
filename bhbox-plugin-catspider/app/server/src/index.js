import fastify from 'fastify';
import { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { join, basename } from 'path';

// 用法: node cat-server.cjs <sourcesDir>
// 端口: 环境变量 PORT（Java 侧端口探测后传入，默认 0 由系统分配）
//
// 源路由采用「通配捕获 + 自行分发」：源注册时只收集 handler，
// 运行时按 /spider/<name>/<path> 分发，因此支持 POST /load 热加载新源/重载源文件，
// 无需重启进程（fastify listen 后不能再 register）。
const sourcesDir = process.argv[2];
const app = fastify({
    logger: false,
    keepAliveTimeout: 65000,
    bodyLimit: 2 * 1024 * 1024,
});

// 客户端（TVBox/okhttp）以 application/x-www-form-urlencoded 发送 extend=<base64>&filter=true 等表单，
// fastify 默认只解析 application/json，不解析该类型会导致 request.body 为空、extend 拿不到、源端没数据。
// 注册解析器把表单解码成对象，源端从 request.body 正常取参。
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    try {
        const params = new URLSearchParams(body || "");
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        done(null, obj);
    } catch (e) {
        done(e, {});
    }
});

const PREFIX = '/spider';
/** route 名（文件名去 .js）→ { meta, routes: Map('POST /home' → handler) } */
const sources = new Map();

function collectRoutes(mod) {
    const routes = new Map();
    const reg = (method) => (path, handler) => routes.set(`${method} ${path}`, handler);
    const fake = {
        post: reg('POST'),
        get: reg('GET'),
        all: reg('ANY'),
        put: reg('PUT'),
        delete: reg('DELETE'),
        patch: reg('PATCH'),
        head: reg('HEAD'),
        options: reg('OPTIONS'),
        route: (opts, handler) => {
            const method = String(Array.isArray(opts?.method) ? opts.method[0] : opts?.method || 'POST').toUpperCase();
            routes.set(`${method} ${opts.url}`, handler);
        },
        // 注册期只允许收集路由；其余 fastify 方法（addHook/decorate 等）安全空实现
        addHook: () => {},
        decorate: () => {},
        decorateRequest: () => {},
        decorateReply: () => {},
        register: () => {},
        log: console,
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
    sources.set(route, { meta, routes });
    console.log(`register: ${PREFIX}/${route} (${meta.name || meta.key})`);
    return { ok: true, route };
}

// 源固定布局：<sourcesDir>/<md5(源URL)>/<md5>.js（宿主 NodeSpider 维护，主文件与所在目录同名，
// 相对依赖落同目录下原相对路径，实现每源隔离）。路由名 = 文件名去 .js = md5。
async function loadAll() {
    let entries = [];
    try {
        entries = readdirSync(sourcesDir, { withFileTypes: true });
    } catch (e) {
        console.error('readdir failed: ' + e.message);
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = `${entry.name}/${entry.name}.js`;
        try {
            await loadSource(file);
        } catch (e2) {
            console.error(`load failed: ${file}: ${e2.message}`);
        }
    }
}

// 统一分发入口：POST/GET /spider/<name>/...
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
            if (ab.action !== undefined && ab.value === undefined && (Array.isArray(ab.input) || ab.type === 'multiInput' || ab.type === 'input')) {
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
    // 源依赖 request.server.prefix（如构造 /proxy 播放地址）与 request.server.inject（自检），
    // 通配分发下 request.server 是根实例（prefix=''），注入带正确前缀的 server 视图：
    // Object.create 继承根实例全部能力（inject 等），仅覆盖 prefix。
    // prefix 中的源名必须 URL 编码：播放地址会交给播放器直接请求，AliPlayer(curl) 不做
    // 路径规范化，原始中文/[] 会被 node llhttp 严格模式拒绝(400 Bad Request)；
    // 编码后 fastify 路由参数仍自动 decode，与源名映射一致。
    const scoped = Object.create(request);
    Object.defineProperty(scoped, 'server', {
        value: Object.create(request.server, { prefix: { value: `${PREFIX}/${encodeURIComponent(name)}`, enumerable: true } }),
    });
    return handler(scoped, reply);
});

app.get('/check', async () => ({ run: true, dir: sourcesDir, sources: [...sources.keys()] }));

// 热加载：运行中注册新源或重载已更新源文件（bust=true 穿透 ESM import 缓存）。
// 只接受 <md5>/<md5>.js 形式的一级相对路径（布局由宿主维护，严格校验防路径逃逸）。
app.post('/load', async (request, reply) => {
    const file = String(request.body?.file || '');
    if (!/^[0-9a-f]{32}\/[0-9a-f]{32}\.js$/.test(file)) {
        reply.code(400);
        return { ok: false, error: 'invalid file name' };
    }
    try {
        return await loadSource(file, request.body?.bust === true);
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
