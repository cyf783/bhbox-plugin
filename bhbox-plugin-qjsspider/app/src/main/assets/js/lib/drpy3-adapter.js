/**
 * drpy3 → TvBox Spider 适配层。
 *
 * 把 drpy3-qjs.bundle.js 的 drpy3Setup/Load/Call 入口包装成 JsSpider 期望的
 * globalThis.__JS_SPIDER__ 对象（init/home/homeVod/category/detail/search/play/
 * sniffer/isVideo/action/proxy），Java 侧无需感知 drpy3 的 JSON 桥协议。
 *
 * 调用链：Java call() → __JS_SPIDER__.xxx() → drpy3Call(key, stage, argsJson)
 *       → 返回 JSON 字符串/对象 → 还原成 Java 期望的类型。
 *
 * 生命周期：Java 侧在模块求值后调用 __drpy3bootstrap(code, key, path) 装载源码，
 * 之后 QjsSpiderPlugin.init(context, ext) 会触发 __JS_SPIDER__.init(extend)。
 */
import * as D3 from './drpy3-qjs.bundle.js'

const state = { key: '' };

function parse(raw) {
    const out = JSON.parse(raw);
    if (out && out.__drpy3_error) {
        const e = out.__drpy3_error;
        throw new Error('[drpy3] ' + (e.stage ? e.stage + ': ' : '') + (e.error || JSON.stringify(e)));
    }
    return out;
}

async function call(method, args) {
    return parse(await D3.drpy3Call(state.key, method, JSON.stringify(args || [])));
}

function asText(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '{}';
    return JSON.stringify(value);
}

globalThis.__drpy3bootstrap = async (code, key, path) => {
    await D3.drpy3Setup('{}');
    state.key = String(key);
    return parse(await D3.drpy3Load(String(code), String(key), path ? String(path) : '', '', ''));
};

globalThis.__JS_SPIDER__ = {
    async init(extend) {
        await call('init', [extend === undefined ? null : extend]);
        return '';
    },
    async home(filter) {
        return asText(await call('home', [filter === true ? 1 : 0]));
    },
    async homeVod() {
        return asText(await call('homeVod', []));
    },
    async category(tid, pg, filter, extend) {
        return asText(await call('category', [tid, pg || 1, filter === true ? 1 : 0, extend === undefined ? {} : extend]));
    },
    async detail(id) {
        return asText(await call('detail', [id]));
    },
    async search(wd, quick, pg) {
        return asText(await call('search', [wd, quick === true ? 1 : 0, pg || 1]));
    },
    async play(flag, id, flags) {
        return asText(await call('play', [flag, id, flags === undefined ? [] : flags]));
    },
    async live() {
        return '';
    },
    async sniffer() {
        const r = await call('sniffer', []);
        return r === true || r === 1;
    },
    async isVideo(url) {
        const r = await call('isVideo', [url]);
        return r === true || r === 1;
    },
    async action(action, value) {
        return asText(await call('action', [action, value === undefined ? null : value]));
    },
    async proxy(params) {
        return call('proxy', [params === undefined ? {} : params]);
    }
};
