'use strict';
// 洛雪自定义源脚本运行时 shim：globalThis.lx 注入面 + vm 沙箱
// 语义对齐 lx-music-desktop 官方实现（src/main/modules/userApi/renderer/preload.js，v2 API 面）
// 兼容移动端 v3 脚本（lx-juhe 等）——能力为两版协议的无害超集
const fs = require('node:fs');
const vm = require('node:vm');
const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { URLSearchParams } = require('node:url');
const { rawRequest } = require('./http');

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
const VERSION = '2.0.0'; // 官方为字符串版本号
const ENV = 'desktop';

// lx.request options.cache 语义的内存缓存实现（Map + 过期时间）
const respCache = new Map();

function cacheTtl(options) {
  const c = options && options.cache;
  if (!c || c.mode === 'default') return 0;
  if (c.mode === 'expire' && typeof c.expire === 'number') return c.expire * 1000;
  return 30 * 60 * 1000; // ip 等其它模式给保守默认 30min
}

/**
 * lx.request(url, options, callback) → callback(error, response, body)
 * response = {statusCode, headers, body(JSON 自动解析|字符串), raw(Buffer)}
 * options 支持 method/headers/body/form/formData/timeout(秒，cap 60)/cache
 */
function lxRequest(url, options = {}, callback) {
  const opt = { ...options };
  // form/formData 对象 → 字符串化（对齐官方 request() 的 needle 预处理）
  let data = opt.body;
  if (data == null && opt.form) {
    data = new URLSearchParams(opt.form).toString();
    opt.headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(opt.headers || {}) };
  } else if (data == null && opt.formData) {
    const boundary = '----lxserver' + Math.random().toString(16).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(opt.formData)) {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${val}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    data = Buffer.concat(parts);
    opt.headers = { 'Content-Type': 'multipart/form-data; boundary=' + boundary, ...(opt.headers || {}) };
  } else if (data != null && typeof data !== 'string' && !Buffer.isBuffer(data)) {
    data = JSON.stringify(data);
    if (!opt.headers || !opt.headers['Content-Type']) opt.headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
  }
  opt.timeout = Math.min(opt.timeout || 60, 60);

  const ttl = cacheTtl(opt);
  const key = ttl > 0 ? url + '|' + JSON.stringify(opt.headers || {}) : '';
  const done = (e, resp) => { if (callback) callback(e, resp, resp && resp.body); };
  if (ttl > 0 && respCache.has(key)) {
    const hit = respCache.get(key);
    if (hit.expire > Date.now()) {
      done(null, hit.resp);
      return { abort: () => {} };
    }
    respCache.delete(key);
  }
  const p = rawRequest(url, opt);
  if (ttl > 0) p.then((resp) => respCache.set(key, { expire: Date.now() + ttl, resp })).catch(() => {});
  p.then((r) => done(null, r), (e) => done(e));
  return { abort: () => {} };
}

/** 脚本头注释 → currentScriptInfo（对齐官方 parseScriptInfo） */
function parseScriptInfo(rawScript) {
  const info = { name: '', description: '', version: '', author: '', homepage: '' };
  const m = rawScript.match(/^\s*\/\*([\s\S]*?)\*\//);
  if (!m) return { ...info, rawScript };
  const lines = m[1].split('\n');
  for (const line of lines) {
    const kv = line.match(/^\s*@([\w\d]+)\s+(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key in info) info[key] = kv[2].trim();
  }
  return { ...info, rawScript };
}

class LxRuntime {
  constructor() {
    this.handlers = {};
    this.sources = null;
    this.inited = false;
    this.initedPromise = null;
    this.currentScriptInfo = null;
  }

  load(scriptPath) {
    const rawScript = fs.readFileSync(scriptPath, 'utf8');
    this.currentScriptInfo = parseScriptInfo(rawScript);
    let initedSent = false;
    const lx = {
      EVENT_NAMES,
      version: VERSION,
      env: ENV,
      currentScriptInfo: this.currentScriptInfo,
      on: (name, handler) => {
        if (name !== EVENT_NAMES.request) throw new Error('未知事件: ' + name);
        this.handlers[name] = handler;
        return Promise.resolve();
      },
      send: (name, data) => {
        if (name === EVENT_NAMES.inited) {
          if (initedSent) throw new Error('inited 事件只允许发送一次');
          initedSent = true;
          // 官方载荷 {status, openDevTools, sources}；聚合脚本转发后端 init.blob，做形状兜底
          this.sources = (data && data.sources) || (data && typeof data === 'object' && data.kw ? data : null);
          this.inited = true;
        } else if (name === EVENT_NAMES.updateAlert) {
          console.log('[lx updateAlert]', JSON.stringify(data).slice(0, 300));
        }
        return Promise.resolve();
      },
      request: lxRequest,
      utils: {
        buffer: {
          from: (...args) => Buffer.from(...args),
          bufToString: (buf, format) => Buffer.from(buf, 'binary').toString(format),
        },
        crypto: {
          md5: (str, hex) => crypto.createHash('md5').update(str).digest(hex || 'hex'),
          randomBytes: (len) => crypto.randomBytes(len),
          aesEncrypt: (buf, mode, key, iv) => {
            const c = crypto.createCipheriv(mode, key, iv);
            return Buffer.concat([c.update(buf), c.final()]);
          },
          aesDecrypt: (buf, mode, key, iv) => {
            const d = crypto.createDecipheriv(mode, key, iv);
            return Buffer.concat([d.update(buf), d.final()]);
          },
          // 官方 preload 同款语义：128 字节零填充 + RSA_NO_PADDING（key 由脚本传入）
          rsaEncrypt: (buffer, key) => {
            buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
            return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
          },
          rsaDecrypt: null,
        },
        zlib: {
          inflate: (buf) => new Promise((resolve, reject) => zlib.inflate(Buffer.from(buf), (e, r) => e ? reject(e) : resolve(r))),
          deflate: (buf) => new Promise((resolve, reject) => zlib.deflate(Buffer.from(buf), (e, r) => e ? reject(e) : resolve(r))),
          gzip: (buf) => new Promise((resolve, reject) => zlib.gzip(Buffer.from(buf), (e, r) => e ? reject(e) : resolve(r))),
          gunzip: (buf) => new Promise((resolve, reject) => zlib.gunzip(Buffer.from(buf), (e, r) => e ? reject(e) : resolve(r))),
        },
      },
    };
    const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, TextEncoder, TextDecoder };
    sandbox.lx = lx;
    vm.createContext(sandbox);
    vm.runInContext(rawScript, sandbox, { filename: scriptPath });
    // 脚本加载即拉初始化配置并 send('inited')；10s 超时降级继续（不阻塞服务）
    this.initedPromise = new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (this.inited || Date.now() - t0 > 10000) { clearInterval(timer); resolve(this.inited); }
      }, 100);
    });
    return this;
  }

  /** 触发脚本 on('request') handler：{action, source, info:{musicInfo, type}} → 直链/封面/歌词 */
  async callRequest(payload) {
    await this.initedPromise;
    const handler = this.handlers[EVENT_NAMES.request];
    if (!handler) throw new Error('脚本未注册 request handler');
    return handler(payload);
  }

  async resolveMusicUrl(platform, musicInfo, type) {
    const url = await this.callRequest({ action: 'musicUrl', source: platform, info: { musicInfo, type } });
    if (typeof url !== 'string' || !/^https?:/.test(url) || url.length > 2048) {
      throw new Error('解析结果非法: ' + JSON.stringify(url).slice(0, 200));
    }
    return url;
  }
}

function loadScript(scriptPath) {
  return new LxRuntime().load(scriptPath);
}

module.exports = { EVENT_NAMES, VERSION, loadScript };
