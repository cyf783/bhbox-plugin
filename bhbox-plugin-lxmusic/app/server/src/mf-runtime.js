'use strict';
// MusicFree 插件协议运行时（musicfree-plugins 生态）：CJS 沙箱 + axios 最小适配
// 协议：exports.platform + search/getMediaSource/getTopLists/getMusicSheetInfo/getLyric 等（参考 qishui.js）
const fs = require('node:fs');
const vm = require('node:vm');
const { URLSearchParams } = require('node:url');
const { rawRequest } = require('./http');

/** axios 最小适配层：axios(config)/axios.get/post/put/delete + .default 同体 + interceptors/defaults 空壳。
 *  params 序列化进 query；data 对象 JSON 化；响应 {data, status, headers}（data 已 JSON 解析） */
function makeAxios() {
  const instance = async (config = {}) => {
    let url = config.url || '';
    if (!/^https?:/.test(url)) throw new Error('axios: url 非法: ' + url);
    if (config.params && typeof config.params === 'object') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(config.params)) qs.append(k, String(v));
      url += (url.includes('?') ? '&' : '?') + qs.toString();
    }
    const method = (config.method || 'GET').toUpperCase();
    const opt = {
      method,
      headers: { ...(config.headers || {}) },
      timeout: config.timeout ? config.timeout / 1000 : 15, // axios ms → rawRequest 秒
    };
    if (config.data != null && method !== 'GET') opt.body = config.data;
    const r = await rawRequest(url, opt);
    if (r.statusCode >= 400) {
      const err = new Error('Request failed with status code ' + r.statusCode);
      err.response = { status: r.statusCode, data: r.body, headers: r.headers };
      throw err;
    }
    return { data: r.body, status: r.statusCode, statusText: 'OK', headers: r.headers, config };
  };
  instance.request = (config) => instance(config);
  instance.get = (url, config = {}) => instance({ ...config, url, method: 'GET' });
  instance.post = (url, data, config = {}) => instance({ ...config, url, data, method: 'POST' });
  instance.put = (url, data, config = {}) => instance({ ...config, url, data, method: 'PUT' });
  instance.delete = (url, config = {}) => instance({ ...config, url, method: 'DELETE' });
  instance.default = instance;
  instance.interceptors = { request: { use() {} }, response: { use() {} } };
  instance.defaults = { headers: { common: {}, get: {}, post: {} }, timeout: 0 };
  return instance;
}

class MFRuntime {
  constructor() {
    this.type = 'mf';
    this.plugin = null;
    this.scriptInfo = null;
  }

  load(scriptPath) {
    const rawScript = fs.readFileSync(scriptPath, 'utf8');
    const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, TextEncoder, TextDecoder };
    const module = { exports: {} };
    sandbox.module = module;
    sandbox.exports = module.exports;
    sandbox.require = (name) => {
      if (name === 'axios') return makeAxios();
      throw new Error('MusicFree 插件暂不支持依赖: ' + name);
    };
    vm.createContext(sandbox);
    vm.runInContext(rawScript, sandbox, { filename: scriptPath });
    const p = module.exports;
    if (!p || typeof p.platform !== 'string' || !p.platform) {
      throw new Error('exports.platform 缺失，非 MusicFree 插件');
    }
    this.plugin = p;
    this.scriptInfo = { name: p.platform, version: p.version || '', author: p.author || '', rawScript };
    return this;
  }

  /** 插件函数安全调用：不存在/抛错统一返回 fallback */
  async call(fnName, ...args) {
    const fn = this.plugin[fnName];
    if (typeof fn !== 'function') throw new Error('插件未实现: ' + fnName);
    return fn(...args);
  }
}

function loadMFPlugin(scriptPath) {
  return new MFRuntime().load(scriptPath);
}

module.exports = { loadMFPlugin, makeAxios };
