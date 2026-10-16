// bhbox-plugin-drpysspider 本机服务
// 用法：DS_PORT=<port> node ds-server.cjs <sourcesDir>
// 协议：内部 JSON（非 T4 CMS），Java 侧 DsSpider 按方法调用
import '../engine/bootstrap.js';
import process from 'process';

process.on('uncaughtException', (e) => {
    console.error('[ds-server] uncaughtException:', e && e.message);
});
process.on('unhandledRejection', (r) => {
    console.error('[ds-server] unhandledRejection:', r);
});

import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import '../engine/prelude.js';
import * as drpyS from '../engine/libs/drpyS.js';
import {bindServer} from '../engine/controllers/fastlogger.js';

const SOURCES_DIR = process.argv[2];
const PORT = Number(process.env.DS_PORT) || 0;
const ROUTE_RE = /^[0-9a-f]{32}$/;

if (!SOURCES_DIR || !fs.existsSync(SOURCES_DIR)) {
    console.error('[ds-server] sources dir missing: ' + SOURCES_DIR);
    process.exit(1);
}

const fastify = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
    keepAliveTimeout: 30000,
});

function sourceFile(route) {
    if (!ROUTE_RE.test(route)) return null;
    const file = path.join(SOURCES_DIR, route, route + '.js');
    return fs.existsSync(file) ? file : null;
}

function makeEnv(ext) {
    const host = '127.0.0.1:' + PORT;
    return {
        ext: ext || '',
        requestHost: host,
        hostUrl: 'http://' + host,
        fServer: undefined,
        getProxyUrl: () => '',
    };
}

async function handler(reply, route, body, run) {
    try {
        const file = sourceFile(route);
        if (!file) {
            reply.code(404);
            return {error: 'source not found: ' + route};
        }
        const env = makeEnv(body && body.ext);
        return await run(file, env);
    } catch (e) {
        console.error('[ds-server] ' + route + ' error:', e && e.stack || e);
        reply.code(500);
        return {error: String(e && e.message || e)};
    }
}

fastify.get('/check', async () => ({run: true}));

// 首页：官方 T4 行为为 home + homeVod 合并（homeVod 非空时覆盖 list）
fastify.post('/ds/:route/home', async (req, reply) => {
    return handler(reply, req.params.route, req.body, async (file, env) => {
        const filter = (req.body && req.body.filter) ? 1 : 0;
        const resultHome = await drpyS.home(file, env, filter) || {};
        const resultHomeVod = await drpyS.homeVod(file, env);
        if (Array.isArray(resultHomeVod) && resultHomeVod.length > 0) {
            resultHome.list = resultHomeVod;
        }
        // 宿主 AbsJson.toAbsXml 直接遍历 list，键缺失会 NPE，源无「推荐」时补空数组
        if (!Array.isArray(resultHome.list)) resultHome.list = [];
        return resultHome;
    });
});

fastify.post('/ds/:route/category', async (req, reply) => {
    return handler(reply, req.params.route, req.body, async (file, env) => {
        const b = req.body || {};
        return drpyS.category(file, env, b.id, Number(b.page) || 1, 1, b.extend || {});
    });
});

fastify.post('/ds/:route/detail', async (req, reply) => {
    return handler(reply, req.params.route, req.body, async (file, env) => {
        return drpyS.detail(file, env, [String((req.body || {}).id)]);
    });
});

fastify.post('/ds/:route/search', async (req, reply) => {
    return handler(reply, req.params.route, req.body, async (file, env) => {
        const b = req.body || {};
        return drpyS.search(file, env, b.wd || '', Number(b.quick) || 0, Number(b.page) || 1);
    });
});

fastify.post('/ds/:route/play', async (req, reply) => {
    return handler(reply, req.params.route, req.body, async (file, env) => {
        const b = req.body || {};
        return drpyS.play(file, env, b.flag || '', String(b.id || ''), b.flags || []);
    });
});

fastify.post('/ds/:route/action', async (req, reply) => {
    return handler(reply, req.params.route, req.body, async (file, env) => {
        const b = req.body || {};
        return drpyS.action(file, env, b.action || '', b.value || '');
    });
});

fastify.listen({port: PORT, host: '127.0.0.1'}, (err, address) => {
    if (err) {
        console.error('[ds-server] listen failed:', err);
        process.exit(1);
    }
    bindServer(fastify);
    const realPort = Number(address.split(':').pop());
    console.log('[ds-server] listening on port ' + realPort);
});
