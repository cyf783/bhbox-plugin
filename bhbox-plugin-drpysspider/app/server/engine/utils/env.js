// 精简版：原 utils/env.js 基于 env.json + lru-cache 的持久化环境变量
// 设备端无后台配置，回退为 process.env + 进程内覆盖（API 形状保持不变）
const mem = {};

export const ENV = {
    get(key, _value = '', isObject = 0) {
        if (!key) return Object.assign({}, process.env, mem);
        let value = Object.prototype.hasOwnProperty.call(mem, key) ? mem[key]
            : Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key]
            : _value;
        if (isObject && typeof value !== 'object') {
            try { value = JSON.parse(value); } catch (e) { value = {}; }
        }
        return value;
    },
    set(key, value = '', isObject = 0) {
        if (!key || typeof key !== 'string') throw new Error('Key must be a non-empty string.');
        if (isObject && typeof value !== 'object') {
            try { value = JSON.parse(value); } catch (e) { value = {}; }
        }
        mem[key] = value;
    },
    delete(key) { delete mem[key]; },
    clearCache() {},
};
