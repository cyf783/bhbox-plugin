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

async function loadAll() {
    let files = [];
    try {
        files = readdirSync(sourcesDir).filter((f) => f.endsWith('.js')).sort();
    } catch (e) {
        console.error('readdir failed: ' + e.message);
    }
    for (const file of files) {
        try {
            await loadSource(file);
        } catch (e) {
            console.error(`load failed: ${file}: ${e.message}`);
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

// 热加载：运行中注册新源或重载已更新源文件（bust=true 穿透 ESM import 缓存）
app.post('/load', async (request, reply) => {
    const file = String(request.body?.file || '');
    if (!file.endsWith('.js') || file.includes('/') || file.includes('\\') || file.includes('..')) {
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
