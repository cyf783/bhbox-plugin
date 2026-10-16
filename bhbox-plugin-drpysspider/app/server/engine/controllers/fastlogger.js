// 精简版：drpy-node 的 controllers/fastlogger.js(pino) 替代品
// drpyS 需要 fastify.server.address().port 做自请求回环，由 src/index.js 在 listen 后 bindServer
export const fastify = {
    server: null,
    log: {
        info: (...a) => console.log(...a),
        warn: (...a) => console.warn(...a),
        error: (...a) => console.error(...a),
        debug() {},
    },
};

export function bindServer(instance) {
    fastify.server = instance && instance.server ? instance.server : instance;
}
