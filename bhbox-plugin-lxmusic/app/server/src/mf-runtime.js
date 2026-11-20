'use strict';
// MusicFree 插件协议运行时（musicfree-plugins 生态）：CJS 沙箱 + axios 最小适配
// 协议：exports.platform + search/getMediaSource/getTopLists/getMusicSheetInfo/getLyric 等（参考 qishui.js）
// 两种源 api：单个插件 js（loadMFPlugin）或订阅 JSON {plugins:[{name,url,version}]}（loadMFBundle，多插件聚合站点）
// 内置依赖：axios（适配 rawRequest）、crypto-js（node:crypto 实现）、he（HTML 实体编解码）；cheerio 等 DOM 依赖暂不支持
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { URLSearchParams } = require('node:url');
const { rawRequest } = require('./http');

// MusicFree 插件生态的真实依赖（esbuild 静态打包进 bundle；cheerio/big-integer/dayjs 无 shim 可替代）
const REAL_DEPS = {
  'crypto-js': require('crypto-js'),
  'iconv-lite': require('iconv-lite'),
  'cheerio': require('cheerio'),
  'big-integer': require('big-integer'),
  'dayjs': require('dayjs'),
  'he': require('he'),
  'qs': require('qs'),
};

// ============ crypto-js 最小实现（WordArray 即 Buffer 包装；覆盖市场插件常用 MD5/AES/Base64） ============
function makeCryptoJs() {
  // WordArray：toString 默认 Base64（与 crypto-js 一致），.buf 为底层 Buffer
  class WA {
    constructor(buf) { this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); }
    toString(encObj) {
      if (encObj === CJS.enc.Hex) return this.buf.toString('hex');
      if (encObj === CJS.enc.Utf8) return this.buf.toString('utf8');
      if (encObj === CJS.enc.Latin1) return this.buf.toString('latin1');
      return this.buf.toString('base64');
    }
    toJSON() { return this.buf.toString('base64'); }
  }
  const toBuf = (v) => (v instanceof WA ? v.buf : (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v)));
  const hash = (alg) => (msg) => new WA(crypto.createHash(alg).update(toBuf(msg)).digest());
  const hmac = (alg) => (msg, key) => new WA(crypto.createHmac(alg, toBuf(key)).update(toBuf(msg)).digest());
  const mode = { ECB: { name: 'ecb' }, CBC: { name: 'cbc' }, CFB: { name: 'cfb' }, CTR: { name: 'ctr' }, OFB: { name: 'ofb' } };
  const pad = { Pkcs7: { name: 'pkcs7' }, NoPadding: { name: 'none' }, Iso10126: { name: 'pkcs7' }, AnsiX923: { name: 'pkcs7' } };
  function aesOpts(opts) {
    const o = opts || {};
    const m = (o.mode && o.mode.name) || 'cbc';
    const p = (o.padding && o.padding.name) || 'pkcs7';
    const iv = o.iv ? toBuf(o.iv).subarray(0, 16) : undefined;
    return { m, p, iv };
  }
  const CJS = {
    MD5: hash('md5'), SHA1: hash('sha1'), SHA256: hash('sha256'), SHA512: hash('sha512'), SHA3: hash('sha3-256'),
    HmacMD5: hmac('md5'), HmacSHA1: hmac('sha1'), HmacSHA256: hmac('sha256'), HmacSHA512: hmac('sha512'),
    AES: {
      encrypt(msg, key, opts) {
        const { m, p, iv } = aesOpts(opts);
        const alg = 'aes-128-' + m;
        const data = toBuf(msg);
        const autoPad = p === 'pkcs7';
        const cipher = crypto.createCipheriv(alg, toBuf(key).subarray(0, 16), m === 'ecb' ? null : iv || Buffer.alloc(16), { autoPad });
        const out = Buffer.concat([cipher.update(data), cipher.final()]);
        return { ciphertext: new WA(out), toString: (e) => (e === CJS.enc.Hex ? out.toString('hex') : out.toString('base64')) };
      },
      decrypt(cipherText, key, opts) {
        const { m, p, iv } = aesOpts(opts);
        const alg = 'aes-128-' + m;
        const ct = typeof cipherText === 'string'
          ? (cipherText.startsWith('Salted__') ? Buffer.from(cipherText, 'base64').subarray(16) : Buffer.from(cipherText, 'base64'))
          : toBuf(cipherText);
        const autoPad = p === 'pkcs7';
        const decipher = crypto.createDecipheriv(alg, toBuf(key).subarray(0, 16), m === 'ecb' ? null : iv || Buffer.alloc(16), { autoPad });
        const out = Buffer.concat([decipher.update(ct), decipher.final()]);
        return { toString: (e) => (e === CJS.enc.Hex ? out.toString('hex') : out.toString('utf8')), ciphertext: new WA(out) };
      },
    },
    enc: {
      Utf8: {}, Latin1: {}, Hex: {}, Base64: {},
    },
    lib: { WordArray: { create(buf) { return new WA(Buffer.from(buf)); } } },
    mode, pad,
    format: { OpenSSL: {} },
  };
  CJS.enc.Utf8.parse = (s) => new WA(Buffer.from(String(s), 'utf8'));
  CJS.enc.Utf8.stringify = (w) => w.buf.toString('utf8');
  CJS.enc.Hex.parse = (s) => new WA(Buffer.from(String(s), 'hex'));
  CJS.enc.Hex.stringify = (w) => w.buf.toString('hex');
  CJS.enc.Base64.parse = (s) => new WA(Buffer.from(String(s), 'base64'));
  CJS.enc.Base64.stringify = (w) => w.buf.toString('base64');
  CJS.enc.Latin1.parse = (s) => new WA(Buffer.from(String(s), 'latin1'));
  CJS.enc.Latin1.stringify = (w) => w.buf.toString('latin1');
  return CJS;
}

// ============ qs 最小实现（querystring 序列化/解析） ============
function makeQs() {
  const qs = {
    stringify(obj) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj || {})) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
        else p.append(k, String(v));
      }
      return p.toString();
    },
    parse(str) {
      const out = {};
      for (const [k, v] of new URLSearchParams(String(str || ''))) out[k] = v;
      return out;
    },
  };
  qs.encode = qs.stringify;
  qs.decode = qs.parse;
  return qs;
}

// ============ he 最小实现（HTML 实体编解码，覆盖搜索结果文本清洗） ============
function makeHe() {
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', mdash: '—', ndash: '–', hellip: '…', middot: '·', laquo: '«', raquo: '»', deg: '°', plusmn: '±', times: '×', divide: '÷' };
  return {
    decode(s) {
      if (typeof s !== 'string') return s;
      return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
        .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
        .replace(/&([a-z]+);/gi, (_, n) => NAMED[n.toLowerCase()] || '&');
    },
    encode(s) {
      if (typeof s !== 'string') return s;
      return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    },
    escape: function (s) { return makeHe().encode(s); },
  };
}


/** axios 最小适配层：axios(config)/axios.get/post/put/delete + .default 同体 + interceptors/defaults 空壳。
 *  params 序列化进 query；data 对象 JSON 化；响应 {data, status, headers}（data 已 JSON 解析） */
/** 插件依赖的第三方 api 改版后响应形状矫正（脚本不改动）：
 *  oiapi.net/Music_163 新版返回 {data:{items:[...]}}，旧版脚本期望 data 为数组 → items 数组化 */
function normalizeMfBody(url, body) {
  try {
    if (body && body.code === 0 && /oiapi\.net\/api\/Music_163/.test(url)
      && body.data && !Array.isArray(body.data) && Array.isArray(body.data.items)) {
      return { ...body, data: body.data.items };
    }
  } catch { /* 保持原样 */ }
  return body;
}

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
    return { data: normalizeMfBody(url, r.body), status: r.statusCode, statusText: 'OK', headers: r.headers, config };
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

  load(scriptPath, userVars = null) {
    const rawScript = fs.readFileSync(scriptPath, 'utf8');
    const userVariables = userVars || {};
    const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, TextEncoder, TextDecoder };
    const module = { exports: {} };
    sandbox.module = module;
    sandbox.exports = module.exports;
    // MusicFree env 全局（用户变量，如 SESSDATA；宿主站点 ext 字段经 body.ext 注入）
    sandbox.env = { getUserVariables: () => userVariables };
    sandbox.require = (name) => {
      if (name === 'axios') return makeAxios();
      // 真实依赖包优先（bundle 内置），缺失时用 node:crypto 实现的 shim 兜底
      if (REAL_DEPS[name]) return REAL_DEPS[name];
      if (name === 'crypto-js') return makeCryptoJs();
      if (name === 'he') return makeHe();
      if (name === 'qs') return makeQs();
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

function loadMFPlugin(scriptPath, userVars = null) {
  return new MFRuntime().load(scriptPath, userVars);
}

/** 订阅 JSON 加载器：{plugins:[{name,url,version}]} → 各插件 js 落盘缓存（<md5(url)>.js，mtime 热加载）→ 逐一加载。
 *  返回 {type:'mf-bundle', plugins:[{id, name, version, runtime}]} */
async function loadMFBundle(jsonPath, userVars = null) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const sub = JSON.parse(raw);
  const items = Array.isArray(sub && sub.plugins) ? sub.plugins : [];
  if (!items.length) throw new Error('订阅 JSON 无 plugins 列表');
  const cacheDir = path.dirname(jsonPath);
  const plugins = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !item.url) continue;
    const cachePath = path.join(cacheDir, require('node:crypto').createHash('md5').update(item.url).digest('hex') + '.js');
    try {
      const r = await rawRequest(item.url, { timeout: 20 });
      if (r.statusCode !== 200 || !r.raw.length) throw new Error('HTTP ' + r.statusCode);
      fs.writeFileSync(cachePath, r.raw);
    } catch (e) {
      if (!fs.existsSync(cachePath)) {
        console.log('[mf bundle]', item.name || item.url, '下载失败:', e.message);
        continue;
      } // 下载失败回退旧缓存
    }
    try {
      plugins.push({ id: String(plugins.length), name: item.name || ('插件' + (plugins.length + 1)), version: item.version || '', runtime: loadMFPlugin(cachePath, userVars) });
    } catch (e) {
      console.log('[mf bundle]', item.name || item.url, '加载失败:', e.message);
    }
  }
  if (!plugins.length) throw new Error('订阅内无可用插件');
  return { type: 'mf-bundle', plugins };
}

module.exports = { loadMFPlugin, makeAxios, loadMFBundle };
