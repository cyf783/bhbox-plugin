"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/http.js
var require_http = __commonJS({
  "src/http.js"(exports2, module2) {
    "use strict";
    var { Buffer: Buffer2 } = require("node:buffer");
    function rawRequest(url, options = {}) {
      return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === "https:" ? require("node:https") : require("node:http");
        const method = (options.method || "GET").toUpperCase();
        const headers = Object.assign({}, options.headers);
        let data = options.body;
        if (data != null && typeof data !== "string" && !Buffer2.isBuffer(data)) {
          data = JSON.stringify(data);
          if (!headers["Content-Type"])
            headers["Content-Type"] = "application/json";
        }
        if (data != null && method !== "GET")
          headers["Content-Length"] = Buffer2.byteLength(data);
        const req = lib.request(u, { method, headers, timeout: (options.timeout || 15) * 1e3 }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer2.concat(chunks);
            const text = raw.toString("utf8").trim();
            let parsed = null;
            if (text.startsWith("{") || text.startsWith("[")) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = null;
              }
            }
            resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed != null ? parsed : raw.toString("utf8"), raw });
          });
        });
        req.on("timeout", () => req.destroy(new Error("request timeout")));
        req.on("error", reject);
        if (data != null && method !== "GET")
          req.write(data);
        req.end();
      });
    }
    module2.exports = { rawRequest };
  }
});

// src/lx-runtime.js
var require_lx_runtime = __commonJS({
  "src/lx-runtime.js"(exports2, module2) {
    "use strict";
    var fs = require("node:fs");
    var vm = require("node:vm");
    var { Buffer: Buffer2 } = require("node:buffer");
    var crypto = require("node:crypto");
    var zlib = require("node:zlib");
    var { URLSearchParams } = require("node:url");
    var { rawRequest } = require_http();
    var EVENT_NAMES = { request: "request", inited: "inited", updateAlert: "updateAlert" };
    var VERSION = "2.0.0";
    var ENV = "desktop";
    var respCache = /* @__PURE__ */ new Map();
    function cacheTtl(options) {
      const c = options && options.cache;
      if (!c || c.mode === "default")
        return 0;
      if (c.mode === "expire" && typeof c.expire === "number")
        return c.expire * 1e3;
      return 30 * 60 * 1e3;
    }
    function lxRequest(url, options = {}, callback) {
      const opt = { ...options };
      let data = opt.body;
      if (data == null && opt.form) {
        data = new URLSearchParams(opt.form).toString();
        opt.headers = { "Content-Type": "application/x-www-form-urlencoded", ...opt.headers || {} };
      } else if (data == null && opt.formData) {
        const boundary = "----lxserver" + Math.random().toString(16).slice(2);
        const parts = [];
        for (const [k, v] of Object.entries(opt.formData)) {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          parts.push(Buffer2.from(`--${boundary}\r
Content-Disposition: form-data; name="${k}"\r
\r
${val}\r
`));
        }
        parts.push(Buffer2.from(`--${boundary}--\r
`));
        data = Buffer2.concat(parts);
        opt.headers = { "Content-Type": "multipart/form-data; boundary=" + boundary, ...opt.headers || {} };
      } else if (data != null && typeof data !== "string" && !Buffer2.isBuffer(data)) {
        data = JSON.stringify(data);
        if (!opt.headers || !opt.headers["Content-Type"])
          opt.headers = { "Content-Type": "application/json", ...opt.headers || {} };
      }
      opt.timeout = Math.min(opt.timeout || 60, 60);
      const ttl = cacheTtl(opt);
      const key = ttl > 0 ? url + "|" + JSON.stringify(opt.headers || {}) : "";
      const done = (e, resp) => {
        if (callback)
          callback(e, resp, resp && resp.body);
      };
      if (ttl > 0 && respCache.has(key)) {
        const hit = respCache.get(key);
        if (hit.expire > Date.now()) {
          done(null, hit.resp);
          return { abort: () => {
          } };
        }
        respCache.delete(key);
      }
      const p = rawRequest(url, opt);
      if (ttl > 0)
        p.then((resp) => respCache.set(key, { expire: Date.now() + ttl, resp })).catch(() => {
        });
      p.then((r) => done(null, r), (e) => done(e));
      return { abort: () => {
      } };
    }
    function parseScriptInfo(rawScript) {
      const info = { name: "", description: "", version: "", author: "", homepage: "" };
      const m = rawScript.match(/^\s*\/\*([\s\S]*?)\*\//);
      if (!m)
        return { ...info, rawScript };
      const lines = m[1].split("\n");
      for (const line of lines) {
        const kv = line.match(/^\s*@([\w\d]+)\s+(.+?)\s*$/);
        if (!kv)
          continue;
        const key = kv[1].toLowerCase();
        if (key in info)
          info[key] = kv[2].trim();
      }
      return { ...info, rawScript };
    }
    var LxRuntime = class {
      constructor() {
        this.handlers = {};
        this.sources = null;
        this.inited = false;
        this.initedPromise = null;
        this.currentScriptInfo = null;
      }
      load(scriptPath) {
        const rawScript = fs.readFileSync(scriptPath, "utf8");
        this.currentScriptInfo = parseScriptInfo(rawScript);
        let initedSent = false;
        const lx = {
          EVENT_NAMES,
          version: VERSION,
          env: ENV,
          currentScriptInfo: this.currentScriptInfo,
          on: (name, handler) => {
            if (name !== EVENT_NAMES.request)
              throw new Error("未知事件: " + name);
            this.handlers[name] = handler;
            return Promise.resolve();
          },
          send: (name, data) => {
            if (name === EVENT_NAMES.inited) {
              if (initedSent)
                throw new Error("inited 事件只允许发送一次");
              initedSent = true;
              this.sources = data && data.sources || (data && typeof data === "object" && data.kw ? data : null);
              this.inited = true;
            } else if (name === EVENT_NAMES.updateAlert) {
              console.log("[lx updateAlert]", JSON.stringify(data).slice(0, 300));
            }
            return Promise.resolve();
          },
          request: lxRequest,
          utils: {
            buffer: {
              from: (...args) => Buffer2.from(...args),
              bufToString: (buf, format) => Buffer2.from(buf, "binary").toString(format)
            },
            crypto: {
              md5: (str, hex) => crypto.createHash("md5").update(str).digest(hex || "hex"),
              randomBytes: (len) => crypto.randomBytes(len),
              aesEncrypt: (buf, mode, key, iv) => {
                const c = crypto.createCipheriv(mode, key, iv);
                return Buffer2.concat([c.update(buf), c.final()]);
              },
              aesDecrypt: (buf, mode, key, iv) => {
                const d = crypto.createDecipheriv(mode, key, iv);
                return Buffer2.concat([d.update(buf), d.final()]);
              },
              // 官方 preload 同款语义：128 字节零填充 + RSA_NO_PADDING（key 由脚本传入）
              rsaEncrypt: (buffer, key) => {
                buffer = Buffer2.concat([Buffer2.alloc(128 - buffer.length), buffer]);
                return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
              },
              rsaDecrypt: null
            },
            zlib: {
              inflate: (buf) => new Promise((resolve, reject) => zlib.inflate(Buffer2.from(buf), (e, r) => e ? reject(e) : resolve(r))),
              deflate: (buf) => new Promise((resolve, reject) => zlib.deflate(Buffer2.from(buf), (e, r) => e ? reject(e) : resolve(r))),
              gzip: (buf) => new Promise((resolve, reject) => zlib.gzip(Buffer2.from(buf), (e, r) => e ? reject(e) : resolve(r))),
              gunzip: (buf) => new Promise((resolve, reject) => zlib.gunzip(Buffer2.from(buf), (e, r) => e ? reject(e) : resolve(r)))
            }
          }
        };
        const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer: Buffer2, URL, TextEncoder, TextDecoder };
        sandbox.lx = lx;
        vm.createContext(sandbox);
        vm.runInContext(rawScript, sandbox, { filename: scriptPath });
        this.initedPromise = new Promise((resolve) => {
          const t0 = Date.now();
          const timer = setInterval(() => {
            if (this.inited || Date.now() - t0 > 1e4) {
              clearInterval(timer);
              resolve(this.inited);
            }
          }, 100);
        });
        return this;
      }
      /** 触发脚本 on('request') handler：{action, source, info:{musicInfo, type}} → 直链/封面/歌词 */
      async callRequest(payload) {
        await this.initedPromise;
        const handler = this.handlers[EVENT_NAMES.request];
        if (!handler)
          throw new Error("脚本未注册 request handler");
        return handler(payload);
      }
      async resolveMusicUrl(platform, musicInfo, type) {
        const url = await this.callRequest({ action: "musicUrl", source: platform, info: { musicInfo, type } });
        if (typeof url !== "string" || !/^https?:/.test(url) || url.length > 2048) {
          throw new Error("解析结果非法: " + JSON.stringify(url).slice(0, 200));
        }
        return url;
      }
    };
    function loadScript(scriptPath) {
      return new LxRuntime().load(scriptPath);
    }
    module2.exports = { EVENT_NAMES, VERSION, loadScript };
  }
});

// src/vendor/shims/needle.js
var require_needle = __commonJS({
  "src/vendor/shims/needle.js"(exports2, module2) {
    "use strict";
    var http2 = require("node:http");
    var https = require("node:https");
    var { URLSearchParams } = require("node:url");
    function buildBody(data, options) {
      if (data == null)
        return { body: null, headers: {} };
      if (typeof data === "string" || Buffer.isBuffer(data))
        return { body: data, headers: {} };
      if (options.json)
        return { body: JSON.stringify(data), headers: { "Content-Type": "application/json" } };
      if (options.formData || data.content_type) {
        const boundary = "----lxserver" + Math.random().toString(16).slice(2);
        const parts = [];
        for (const [k, v] of Object.entries(data)) {
          if (k === "content_type")
            continue;
          const val = typeof v === "string" ? v : JSON.stringify(v);
          parts.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="${k}"\r
\r
${val}\r
`));
        }
        parts.push(Buffer.from(`--${boundary}--\r
`));
        return { body: Buffer.concat(parts), headers: { "Content-Type": "multipart/form-data; boundary=" + boundary } };
      }
      return { body: new URLSearchParams(data).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } };
    }
    function request(method, url, data, options = {}, callback) {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http2;
      const { body, headers: bodyHeaders } = buildBody(data, options);
      const headers = { ...bodyHeaders, ...options.headers || {} };
      if (body != null && headers["Content-Length"] == null)
        headers["Content-Length"] = Buffer.byteLength(body);
      const req = lib.request(u, {
        method: (options.method || method || "GET").toUpperCase(),
        headers,
        // request.js 传 rejectUnauthorized:false（忽略自签证书），缺省 true
        rejectUnauthorized: options.rejectUnauthorized !== false
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const resp = { statusCode: res.statusCode, headers: res.headers, raw, body: raw.toString() };
          callback(null, resp, resp.body);
        });
      });
      if (options.response_timeout) {
        let gotResponse = false;
        req.on("response", () => {
          gotResponse = true;
        });
        const timer = setTimeout(() => {
          if (!gotResponse) {
            const err = new Error("Response timeout");
            err.code = "ESOCKETTIMEDOUT";
            req.destroy(err);
          }
        }, options.response_timeout * 1e3);
        req.on("response", () => clearTimeout(timer));
        req.on("close", () => clearTimeout(timer));
      }
      req.on("error", (e) => callback(e));
      if (body != null)
        req.write(body);
      req.end();
      return { request: req };
    }
    module2.exports = { request, get: (u, o, cb) => request("GET", u, null, typeof o === "function" ? {} : o, typeof o === "function" ? o : cb) };
  }
});

// src/vendor/env.js
var require_env = __commonJS({
  "src/vendor/env.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.debugRequest = void 0;
    exports2.debugRequest = false;
  }
});

// src/vendor/message.js
var require_message = __commonJS({
  "src/vendor/message.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.requestMsg = void 0;
    exports2.requestMsg = {
      cancelRequest: "Cancel Request",
      unachievable: "Socket Hang Up",
      timeout: "Request Timeout",
      notConnectNetwork: "Network Error"
    };
  }
});

// src/vendor/musicSdk/options.js
var require_options = __commonJS({
  "src/vendor/musicSdk/options.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.timeout = exports2.headers = exports2.bHh = void 0;
    exports2.bHh = "624868746c";
    exports2.headers = {
      "User-Agent": "lx-music request",
      [exports2.bHh]: [exports2.bHh]
    };
    exports2.timeout = 15e3;
  }
});

// src/vendor/shims/proxies.js
var require_proxies = __commonJS({
  "src/vendor/shims/proxies.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      httpsOverHttp: () => void 0,
      httpOverHttp: () => void 0
    };
  }
});

// src/vendor/shims/socks-proxy-agent.js
var require_socks_proxy_agent = __commonJS({
  "src/vendor/shims/socks-proxy-agent.js"(exports2, module2) {
    "use strict";
    var SocksProxyAgent = class {
      constructor() {
        throw new Error("socks proxy not supported in lx-server");
      }
    };
    module2.exports = { SocksProxyAgent };
  }
});

// src/vendor/request.js
var require_request = __commonJS({
  "src/vendor/request.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0)
        k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0)
        k2 = k;
      o[k2] = m[k];
    });
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    } : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || /* @__PURE__ */ function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2)
            if (Object.prototype.hasOwnProperty.call(o2, k))
              ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule)
          return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++)
            if (k[i] !== "default")
              __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    }();
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.checkUrl = exports2.http_jsonp = exports2.httpPost = exports2.httpGet = exports2.http = exports2.cancelHttp = exports2.httpFetch = void 0;
    var needle_1 = __importDefault(require_needle());
    var env_1 = require_env();
    var message_1 = require_message();
    var options_1 = require_options();
    var zlib_1 = require("zlib");
    var tunnel = __importStar(require_proxies());
    var httpsRxp = /^https:/;
    var getRequestAgent = async (url) => {
      const config = global.lx?.config || {};
      const proxyEnabled = config["proxy.all.enabled"];
      const proxyAddress = config["proxy.all.address"];
      if (proxyEnabled && proxyAddress) {
        try {
          const proxyUrl = new URL(proxyAddress);
          if (proxyUrl.protocol === "http:" || proxyUrl.protocol === "https:") {
            const isHttps = httpsRxp.test(url);
            const tunnelOptions = {
              proxy: {
                host: proxyUrl.hostname,
                port: proxyUrl.port,
                proxyAuth: proxyUrl.username ? `${proxyUrl.username}:${proxyUrl.password}` : void 0
              }
            };
            return (isHttps ? tunnel.httpsOverHttp : tunnel.httpOverHttp)(tunnelOptions);
          } else if (proxyUrl.protocol.startsWith("socks")) {
            const { SocksProxyAgent } = await Promise.resolve().then(() => __toESM(require_socks_proxy_agent()));
            return new SocksProxyAgent(proxyAddress);
          }
        } catch (e) {
        }
      }
      if (process.env.HTTPS_PROXY) {
        try {
          const proxyUrl = new URL(process.env.HTTPS_PROXY);
          const tunnelOptions = {
            proxy: {
              host: proxyUrl.hostname,
              port: proxyUrl.port,
              proxyAuth: proxyUrl.username ? `${proxyUrl.username}:${proxyUrl.password}` : void 0
            }
          };
          return (httpsRxp.test(url) ? tunnel.httpsOverHttp : tunnel.httpOverHttp)(tunnelOptions);
        } catch (e) {
        }
      }
      return void 0;
    };
    var request = (url, options, callback) => {
      let data;
      if (options.body) {
        data = options.body;
      } else if (options.form) {
        data = options.form;
        options.json = false;
      } else if (options.formData) {
        data = options.formData;
        options.json = false;
      }
      options.response_timeout = options.timeout;
      return needle_1.default.request(options.method || "get", url, data, options, (err, resp, body) => {
        if (!err) {
          body = resp.body = resp.raw.toString();
          try {
            resp.body = JSON.parse(resp.body);
          } catch (_) {
          }
          body = resp.body;
        }
        callback(err, resp, body);
      }).request;
    };
    var defaultHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
    var buildHttpPromose = (url, options) => {
      let obj = {
        isCancelled: false,
        cancelHttp: () => {
          if (!obj.requestObj)
            return obj.isCancelled = true;
          (0, exports2.cancelHttp)(obj.requestObj);
          obj.requestObj = null;
          obj.promise = obj.cancelHttp = null;
          if (obj.cancelFn)
            obj.cancelFn(new Error(message_1.requestMsg.cancelRequest));
          obj.cancelFn = null;
        }
      };
      obj.promise = new Promise((resolve, reject) => {
        obj.cancelFn = reject;
        env_1.debugRequest && console.log(`
---send request------${url}------------`);
        fetchData(url, options.method, options, (err, resp, body) => {
          env_1.debugRequest && console.log(`
---response------${url}------------`);
          env_1.debugRequest && console.log(body);
          obj.requestObj = null;
          obj.cancelFn = null;
          if (err)
            return reject(err);
          resolve(resp);
        }).then((ro) => {
          obj.requestObj = ro;
          if (obj.isCancelled)
            obj.cancelHttp();
        });
      });
      return obj;
    };
    var httpFetch = (url, options = { method: "get" }) => {
      const requestObj = buildHttpPromose(url, options);
      requestObj.promise = requestObj.promise.catch((err) => {
        if (err.message === "socket hang up") {
          return Promise.reject(new Error(message_1.requestMsg.unachievable));
        }
        switch (err.code) {
          case "ETIMEDOUT":
          case "ESOCKETTIMEDOUT":
            return Promise.reject(new Error(message_1.requestMsg.timeout));
          case "ENOTFOUND":
            return Promise.reject(new Error(message_1.requestMsg.notConnectNetwork));
          default:
            return Promise.reject(err);
        }
      });
      return requestObj;
    };
    exports2.httpFetch = httpFetch;
    var cancelHttp = (requestObj) => {
      if (!requestObj)
        return;
      if (!requestObj.abort)
        return;
      requestObj.abort();
    };
    exports2.cancelHttp = cancelHttp;
    var http2 = (url, options, cb) => {
      if (typeof options === "function") {
        cb = options;
        options = {};
      }
      if (options.method == null)
        options.method = "get";
      env_1.debugRequest && console.log(`
---send request------${url}------------`);
      return fetchData(url, options.method, options, (err, resp, body) => {
        env_1.debugRequest && console.log(`
---response------${url}------------`);
        env_1.debugRequest && console.log(body);
        if (err) {
          env_1.debugRequest && console.log(JSON.stringify(err));
        }
        cb(err, resp, body);
      });
    };
    exports2.http = http2;
    var httpGet = (url, options, callback) => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      env_1.debugRequest && console.log(`
---send request-------${url}------------`);
      return fetchData(url, "get", options, function(err, resp, body) {
        env_1.debugRequest && console.log(`
---response------${url}------------`);
        env_1.debugRequest && console.log(body);
        if (err) {
          env_1.debugRequest && console.log(JSON.stringify(err));
        }
        callback(err, resp, body);
      });
    };
    exports2.httpGet = httpGet;
    var httpPost = (url, data, options, callback) => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      options.data = data;
      env_1.debugRequest && console.log(`
---send request-------${url}------------`);
      return fetchData(url, "post", options, function(err, resp, body) {
        env_1.debugRequest && console.log(`
---response------${url}------------`);
        env_1.debugRequest && console.log(body);
        if (err) {
          env_1.debugRequest && console.log(JSON.stringify(err));
        }
        callback(err, resp, body);
      });
    };
    exports2.httpPost = httpPost;
    var http_jsonp = (url, options, callback) => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      let jsonpCallback = "jsonpCallback";
      if (url.indexOf("?") < 0)
        url += "?";
      url += `&${options.jsonpCallback}=${jsonpCallback}`;
      options.format = "script";
      env_1.debugRequest && console.log(`
---send request-------${url}------------`);
      return fetchData(url, "get", options, function(err, resp, body) {
        env_1.debugRequest && console.log(`
---response------${url}------------`);
        env_1.debugRequest && console.log(body);
        if (err) {
          env_1.debugRequest && console.log(JSON.stringify(err));
        } else {
          try {
            body = JSON.parse(body.replace(new RegExp(`^${jsonpCallback}\\(({.*})\\)$`), "$1"));
          } catch (e) {
          }
        }
        callback(err, resp, body);
      });
    };
    exports2.http_jsonp = http_jsonp;
    var handleDeflateRaw = (data) => new Promise((resolve, reject) => {
      (0, zlib_1.deflateRaw)(data, (err, buf) => {
        if (err)
          return reject(err);
        resolve(buf);
      });
    });
    var regx = /(?:\d\w)+/g;
    var fetchData = async (url, method, { headers = {}, format = "json", timeout = 15e3, ...options }, callback) => {
      headers = Object.assign({}, headers);
      if (headers[options_1.bHh]) {
        const path = url.replace(/^https?:\/\/[\w.:]+\//, "/");
        let s = Buffer.from(options_1.bHh, "hex").toString();
        s = s.replace(s.substr(-1), "");
        s = Buffer.from(s, "base64").toString();
        const v1 = "2050201";
        const v2 = "10";
        let v = v1.split("-")[0].split(".").map((n) => n.length < 3 ? n.padStart(3, "0") : n).join("");
        headers[s] = !s || `${(await handleDeflateRaw(Buffer.from(JSON.stringify(`${path}${v}`.match(regx), null, 1).concat(v)).toString("base64"))).toString("hex")}&${parseInt(v)}${v2}`;
        delete headers[options_1.bHh];
      }
      return request(url, {
        ...options,
        method,
        headers: Object.assign({}, defaultHeaders, headers),
        timeout,
        agent: await getRequestAgent(url),
        json: format === "json",
        rejectUnauthorized: false
      }, (err, resp, body) => {
        if (err)
          return callback(err, null);
        callback(null, resp, body);
      });
    };
    var checkUrl = (url, options = {}) => {
      return new Promise((resolve, reject) => {
        fetchData(url, "head", options, (err, resp) => {
          if (err)
            return reject(err);
          if (resp.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(resp.statusCode));
          }
        });
      });
    };
    exports2.checkUrl = checkUrl;
  }
});

// src/vendor/musicSdk/kw/tipSearch.js
var require_tipSearch = __commonJS({
  "src/vendor/musicSdk/kw/tipSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      regExps: {
        relWord: /RELWORD=(.+)/
      },
      requestObj: null,
      async tipSearchBySong(str) {
        this.cancelTipSearch();
        this.requestObj = (0, request_1.httpFetch)(`https://tips.kuwo.cn/t.s?corp=kuwo&newver=3&p2p=1&notrace=0&c=mbox&w=${encodeURIComponent(str)}&encoding=utf8&rformat=json`, {
          Referer: "http://www.kuwo.cn/"
        });
        return this.requestObj.promise.then(({ body, statusCode }) => {
          if (statusCode != 200 || !body.WORDITEMS)
            return Promise.reject(new Error("请求失败"));
          return body.WORDITEMS;
        });
      },
      handleResult(rawData) {
        return rawData.map((item) => item.RELWORD);
      },
      cancelTipSearch() {
        if (this.requestObj && this.requestObj.cancelHttp)
          this.requestObj.cancelHttp();
      },
      async search(str) {
        return this.tipSearchBySong(str).then((result) => this.handleResult(result));
      }
    };
  }
});

// src/vendor/index.js
var require_vendor = __commonJS({
  "src/vendor/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.formatPlayCount = exports2.dateFormat2 = exports2.dateFormat = exports2.formatPlayTime = exports2.decodeName = exports2.sizeFormate = void 0;
    var sizeFormate = (size) => {
      if (!size)
        return "0 B";
      let units = ["B", "KB", "MB", "GB", "TB"];
      let number = Math.floor(Math.log(size) / Math.log(1024));
      return `${(size / Math.pow(1024, Math.floor(number))).toFixed(2)} ${units[number]}`;
    };
    exports2.sizeFormate = sizeFormate;
    var numFix = (n) => n < 10 ? `0${n}` : n.toString();
    var decodeName = (str) => {
      if (!str)
        return "";
      const entities = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&nbsp;": " "
      };
      return str.replace(/&[a-zA-Z]+;/g, (match) => entities[match] || match);
    };
    exports2.decodeName = decodeName;
    var formatPlayTime = (time) => {
      let m = Math.trunc(time / 60);
      let s = Math.trunc(time % 60);
      return m == 0 && s == 0 ? "--/--" : numFix(m) + ":" + numFix(s);
    };
    exports2.formatPlayTime = formatPlayTime;
    var dateFormat = (_date, format = "Y-M-D h:m:s") => {
      const date = new Date(_date);
      if (!date)
        return "";
      return format.replace("Y", date.getFullYear().toString()).replace("M", numFix(date.getMonth() + 1)).replace("D", numFix(date.getDate())).replace("h", numFix(date.getHours())).replace("m", numFix(date.getMinutes())).replace("s", numFix(date.getSeconds()));
    };
    exports2.dateFormat = dateFormat;
    var dateFormat2 = (time) => {
      let differ = Math.trunc((Date.now() - time) / 1e3);
      if (differ < 60) {
        return differ + "秒前";
      } else if (differ < 3600) {
        return Math.trunc(differ / 60) + "分钟前";
      } else if (differ < 86400) {
        return Math.trunc(differ / 3600) + "小时前";
      } else {
        return (0, exports2.dateFormat)(time);
      }
    };
    exports2.dateFormat2 = dateFormat2;
    var formatPlayCount = (num) => {
      if (num > 1e8)
        return parseInt(num / 1e7) / 10 + "亿";
      if (num > 1e4)
        return parseInt(num / 1e3) / 10 + "万";
      return num;
    };
    exports2.formatPlayCount = formatPlayCount;
  }
});

// src/vendor/musicSdk/utils.js
var require_utils = __commonJS({
  "src/vendor/musicSdk/utils.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.formatSingerName = exports2.dnsLookup = exports2.getHostIp = exports2.toMD5 = void 0;
    var crypto_1 = __importDefault(require("crypto"));
    var dns_1 = __importDefault(require("dns"));
    var utils_1 = require_vendor();
    var toMD5 = (str) => crypto_1.default.createHash("md5").update(str).digest("hex");
    exports2.toMD5 = toMD5;
    var ipMap = /* @__PURE__ */ new Map();
    var getHostIp = (hostname) => {
      const result = ipMap.get(hostname);
      if (typeof result === "object")
        return result;
      if (result === true)
        return;
      ipMap.set(hostname, true);
      dns_1.default.lookup(hostname, {
        // family: 4,
        all: false
      }, (err, address, family) => {
        if (err)
          return console.log(err);
        ipMap.set(hostname, { address, family });
      });
    };
    exports2.getHostIp = getHostIp;
    var dnsLookup = (hostname, options, callback) => {
      const result = (0, exports2.getHostIp)(hostname);
      if (result)
        return callback(null, result.address, result.family);
      dns_1.default.lookup(hostname, options, callback);
    };
    exports2.dnsLookup = dnsLookup;
    var formatSingerName = (singers, nameKey = "name", join = "、") => {
      if (Array.isArray(singers)) {
        const singer = [];
        singers.forEach((item) => {
          let name = item[nameKey];
          if (!name)
            return;
          singer.push(name);
        });
        return (0, utils_1.decodeName)(singer.join(join));
      }
      return (0, utils_1.decodeName)(String(singers ?? ""));
    };
    exports2.formatSingerName = formatSingerName;
  }
});

// node_modules/safer-buffer/safer.js
var require_safer = __commonJS({
  "node_modules/safer-buffer/safer.js"(exports2, module2) {
    "use strict";
    var buffer = require("buffer");
    var Buffer2 = buffer.Buffer;
    var safer = {};
    var key;
    for (key in buffer) {
      if (!buffer.hasOwnProperty(key))
        continue;
      if (key === "SlowBuffer" || key === "Buffer")
        continue;
      safer[key] = buffer[key];
    }
    var Safer = safer.Buffer = {};
    for (key in Buffer2) {
      if (!Buffer2.hasOwnProperty(key))
        continue;
      if (key === "allocUnsafe" || key === "allocUnsafeSlow")
        continue;
      Safer[key] = Buffer2[key];
    }
    safer.Buffer.prototype = Buffer2.prototype;
    if (!Safer.from || Safer.from === Uint8Array.from) {
      Safer.from = function(value, encodingOrOffset, length) {
        if (typeof value === "number") {
          throw new TypeError('The "value" argument must not be of type number. Received type ' + typeof value);
        }
        if (value && typeof value.length === "undefined") {
          throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
        }
        return Buffer2(value, encodingOrOffset, length);
      };
    }
    if (!Safer.alloc) {
      Safer.alloc = function(size, fill, encoding) {
        if (typeof size !== "number") {
          throw new TypeError('The "size" argument must be of type number. Received type ' + typeof size);
        }
        if (size < 0 || size >= 2 * (1 << 30)) {
          throw new RangeError('The value "' + size + '" is invalid for option "size"');
        }
        var buf = Buffer2(size);
        if (!fill || fill.length === 0) {
          buf.fill(0);
        } else if (typeof encoding === "string") {
          buf.fill(fill, encoding);
        } else {
          buf.fill(fill);
        }
        return buf;
      };
    }
    if (!safer.kStringMaxLength) {
      try {
        safer.kStringMaxLength = process.binding("buffer").kStringMaxLength;
      } catch (e) {
      }
    }
    if (!safer.constants) {
      safer.constants = {
        MAX_LENGTH: safer.kMaxLength
      };
      if (safer.kStringMaxLength) {
        safer.constants.MAX_STRING_LENGTH = safer.kStringMaxLength;
      }
    }
    module2.exports = safer;
  }
});

// node_modules/iconv-lite/lib/bom-handling.js
var require_bom_handling = __commonJS({
  "node_modules/iconv-lite/lib/bom-handling.js"(exports2) {
    "use strict";
    var BOMChar = "\uFEFF";
    exports2.PrependBOM = PrependBOMWrapper;
    function PrependBOMWrapper(encoder, options) {
      this.encoder = encoder;
      this.addBOM = true;
    }
    PrependBOMWrapper.prototype.write = function(str) {
      if (this.addBOM) {
        str = BOMChar + str;
        this.addBOM = false;
      }
      return this.encoder.write(str);
    };
    PrependBOMWrapper.prototype.end = function() {
      return this.encoder.end();
    };
    exports2.StripBOM = StripBOMWrapper;
    function StripBOMWrapper(decoder, options) {
      this.decoder = decoder;
      this.pass = false;
      this.options = options || {};
    }
    StripBOMWrapper.prototype.write = function(buf) {
      var res = this.decoder.write(buf);
      if (this.pass || !res) {
        return res;
      }
      if (res[0] === BOMChar) {
        res = res.slice(1);
        if (typeof this.options.stripBOM === "function") {
          this.options.stripBOM();
        }
      }
      this.pass = true;
      return res;
    };
    StripBOMWrapper.prototype.end = function() {
      return this.decoder.end();
    };
  }
});

// node_modules/iconv-lite/lib/helpers/merge-exports.js
var require_merge_exports = __commonJS({
  "node_modules/iconv-lite/lib/helpers/merge-exports.js"(exports2, module2) {
    "use strict";
    var hasOwn = typeof Object.hasOwn === "undefined" ? Function.call.bind(Object.prototype.hasOwnProperty) : Object.hasOwn;
    function mergeModules(target, module3) {
      for (var key in module3) {
        if (hasOwn(module3, key)) {
          target[key] = module3[key];
        }
      }
    }
    module2.exports = mergeModules;
  }
});

// node_modules/iconv-lite/encodings/internal.js
var require_internal = __commonJS({
  "node_modules/iconv-lite/encodings/internal.js"(exports2, module2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    module2.exports = {
      // Encodings
      utf8: { type: "_internal", bomAware: true },
      cesu8: { type: "_internal", bomAware: true },
      unicode11utf8: "utf8",
      ucs2: { type: "_internal", bomAware: true },
      utf16le: "ucs2",
      binary: { type: "_internal" },
      base64: { type: "_internal" },
      hex: { type: "_internal" },
      // Codec.
      _internal: InternalCodec
    };
    function InternalCodec(codecOptions, iconv) {
      this.enc = codecOptions.encodingName;
      this.bomAware = codecOptions.bomAware;
      if (this.enc === "base64") {
        this.encoder = InternalEncoderBase64;
      } else if (this.enc === "utf8") {
        this.encoder = InternalEncoderUtf8;
      } else if (this.enc === "cesu8") {
        this.enc = "utf8";
        this.encoder = InternalEncoderCesu8;
        if (Buffer2.from("eda0bdedb2a9", "hex").toString() !== "💩") {
          this.decoder = InternalDecoderCesu8;
          this.defaultCharUnicode = iconv.defaultCharUnicode;
        }
      }
    }
    InternalCodec.prototype.encoder = InternalEncoder;
    InternalCodec.prototype.decoder = InternalDecoder;
    var StringDecoder = require("string_decoder").StringDecoder;
    function InternalDecoder(options, codec) {
      this.decoder = new StringDecoder(codec.enc);
    }
    InternalDecoder.prototype.write = function(buf) {
      if (!Buffer2.isBuffer(buf)) {
        buf = Buffer2.from(buf);
      }
      return this.decoder.write(buf);
    };
    InternalDecoder.prototype.end = function() {
      return this.decoder.end();
    };
    function InternalEncoder(options, codec) {
      this.enc = codec.enc;
    }
    InternalEncoder.prototype.write = function(str) {
      return Buffer2.from(str, this.enc);
    };
    InternalEncoder.prototype.end = function() {
    };
    function InternalEncoderBase64(options, codec) {
      this.prevStr = "";
    }
    InternalEncoderBase64.prototype.write = function(str) {
      str = this.prevStr + str;
      var completeQuads = str.length - str.length % 4;
      this.prevStr = str.slice(completeQuads);
      str = str.slice(0, completeQuads);
      return Buffer2.from(str, "base64");
    };
    InternalEncoderBase64.prototype.end = function() {
      return Buffer2.from(this.prevStr, "base64");
    };
    function InternalEncoderCesu8(options, codec) {
    }
    InternalEncoderCesu8.prototype.write = function(str) {
      var buf = Buffer2.alloc(str.length * 3);
      var bufIdx = 0;
      for (var i = 0; i < str.length; i++) {
        var charCode = str.charCodeAt(i);
        if (charCode < 128) {
          buf[bufIdx++] = charCode;
        } else if (charCode < 2048) {
          buf[bufIdx++] = 192 + (charCode >>> 6);
          buf[bufIdx++] = 128 + (charCode & 63);
        } else {
          buf[bufIdx++] = 224 + (charCode >>> 12);
          buf[bufIdx++] = 128 + (charCode >>> 6 & 63);
          buf[bufIdx++] = 128 + (charCode & 63);
        }
      }
      return buf.slice(0, bufIdx);
    };
    InternalEncoderCesu8.prototype.end = function() {
    };
    function InternalDecoderCesu8(options, codec) {
      this.acc = 0;
      this.contBytes = 0;
      this.accBytes = 0;
      this.defaultCharUnicode = codec.defaultCharUnicode;
    }
    InternalDecoderCesu8.prototype.write = function(buf) {
      var acc = this.acc;
      var contBytes = this.contBytes;
      var accBytes = this.accBytes;
      var res = "";
      for (var i = 0; i < buf.length; i++) {
        var curByte = buf[i];
        if ((curByte & 192) !== 128) {
          if (contBytes > 0) {
            res += this.defaultCharUnicode;
            contBytes = 0;
          }
          if (curByte < 128) {
            res += String.fromCharCode(curByte);
          } else if (curByte < 224) {
            acc = curByte & 31;
            contBytes = 1;
            accBytes = 1;
          } else if (curByte < 240) {
            acc = curByte & 15;
            contBytes = 2;
            accBytes = 1;
          } else {
            res += this.defaultCharUnicode;
          }
        } else {
          if (contBytes > 0) {
            acc = acc << 6 | curByte & 63;
            contBytes--;
            accBytes++;
            if (contBytes === 0) {
              if (accBytes === 2 && acc < 128 && acc > 0) {
                res += this.defaultCharUnicode;
              } else if (accBytes === 3 && acc < 2048) {
                res += this.defaultCharUnicode;
              } else {
                res += String.fromCharCode(acc);
              }
            }
          } else {
            res += this.defaultCharUnicode;
          }
        }
      }
      this.acc = acc;
      this.contBytes = contBytes;
      this.accBytes = accBytes;
      return res;
    };
    InternalDecoderCesu8.prototype.end = function() {
      var res = 0;
      if (this.contBytes > 0) {
        res += this.defaultCharUnicode;
      }
      return res;
    };
    function InternalEncoderUtf8(options, codec) {
      this.highSurrogate = "";
    }
    InternalEncoderUtf8.prototype.write = function(str) {
      if (this.highSurrogate) {
        str = this.highSurrogate + str;
        this.highSurrogate = "";
      }
      if (str.length > 0) {
        var charCode = str.charCodeAt(str.length - 1);
        if (charCode >= 55296 && charCode < 56320) {
          this.highSurrogate = str[str.length - 1];
          str = str.slice(0, str.length - 1);
        }
      }
      return Buffer2.from(str, this.enc);
    };
    InternalEncoderUtf8.prototype.end = function() {
      if (this.highSurrogate) {
        var str = this.highSurrogate;
        this.highSurrogate = "";
        return Buffer2.from(str, this.enc);
      }
    };
  }
});

// node_modules/iconv-lite/encodings/utf32.js
var require_utf32 = __commonJS({
  "node_modules/iconv-lite/encodings/utf32.js"(exports2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    exports2._utf32 = Utf32Codec;
    function Utf32Codec(codecOptions, iconv) {
      this.iconv = iconv;
      this.bomAware = true;
      this.isLE = codecOptions.isLE;
    }
    exports2.utf32le = { type: "_utf32", isLE: true };
    exports2.utf32be = { type: "_utf32", isLE: false };
    exports2.ucs4le = "utf32le";
    exports2.ucs4be = "utf32be";
    Utf32Codec.prototype.encoder = Utf32Encoder;
    Utf32Codec.prototype.decoder = Utf32Decoder;
    function Utf32Encoder(options, codec) {
      this.isLE = codec.isLE;
      this.highSurrogate = 0;
    }
    Utf32Encoder.prototype.write = function(str) {
      var src = Buffer2.from(str, "ucs2");
      var dst = Buffer2.alloc(src.length * 2 + 4);
      var write32 = this.isLE ? dst.writeUInt32LE : dst.writeUInt32BE;
      var offset = 0;
      for (var i = 0; i < src.length; i += 2) {
        var code = src.readUInt16LE(i);
        var isHighSurrogate = code >= 55296 && code < 56320;
        var isLowSurrogate = code >= 56320 && code < 57344;
        if (this.highSurrogate) {
          if (isHighSurrogate || !isLowSurrogate) {
            write32.call(dst, this.highSurrogate, offset);
            offset += 4;
          } else {
            var codepoint = (this.highSurrogate - 55296 << 10 | code - 56320) + 65536;
            write32.call(dst, codepoint, offset);
            offset += 4;
            this.highSurrogate = 0;
            continue;
          }
        }
        if (isHighSurrogate) {
          this.highSurrogate = code;
        } else {
          write32.call(dst, code, offset);
          offset += 4;
          this.highSurrogate = 0;
        }
      }
      if (offset < dst.length) {
        dst = dst.slice(0, offset);
      }
      return dst;
    };
    Utf32Encoder.prototype.end = function() {
      if (!this.highSurrogate) {
        return;
      }
      var buf = Buffer2.alloc(4);
      if (this.isLE) {
        buf.writeUInt32LE(this.highSurrogate, 0);
      } else {
        buf.writeUInt32BE(this.highSurrogate, 0);
      }
      this.highSurrogate = 0;
      return buf;
    };
    function Utf32Decoder(options, codec) {
      this.isLE = codec.isLE;
      this.badChar = codec.iconv.defaultCharUnicode.charCodeAt(0);
      this.overflow = [];
    }
    Utf32Decoder.prototype.write = function(src) {
      if (src.length === 0) {
        return "";
      }
      var i = 0;
      var codepoint = 0;
      var dst = Buffer2.alloc(src.length + 4);
      var offset = 0;
      var isLE = this.isLE;
      var overflow = this.overflow;
      var badChar = this.badChar;
      if (overflow.length > 0) {
        for (; i < src.length && overflow.length < 4; i++) {
          overflow.push(src[i]);
        }
        if (overflow.length === 4) {
          if (isLE) {
            codepoint = overflow[0] | overflow[1] << 8 | overflow[2] << 16 | overflow[3] << 24;
          } else {
            codepoint = overflow[3] | overflow[2] << 8 | overflow[1] << 16 | overflow[0] << 24;
          }
          overflow.length = 0;
          offset = _writeCodepoint(dst, offset, codepoint, badChar);
        }
      }
      for (; i < src.length - 3; i += 4) {
        if (isLE) {
          codepoint = src[i] | src[i + 1] << 8 | src[i + 2] << 16 | src[i + 3] << 24;
        } else {
          codepoint = src[i + 3] | src[i + 2] << 8 | src[i + 1] << 16 | src[i] << 24;
        }
        offset = _writeCodepoint(dst, offset, codepoint, badChar);
      }
      for (; i < src.length; i++) {
        overflow.push(src[i]);
      }
      return dst.slice(0, offset).toString("ucs2");
    };
    function _writeCodepoint(dst, offset, codepoint, badChar) {
      if (codepoint < 0 || codepoint > 1114111) {
        codepoint = badChar;
      }
      if (codepoint >= 65536) {
        codepoint -= 65536;
        var high = 55296 | codepoint >> 10;
        dst[offset++] = high & 255;
        dst[offset++] = high >> 8;
        var codepoint = 56320 | codepoint & 1023;
      }
      dst[offset++] = codepoint & 255;
      dst[offset++] = codepoint >> 8;
      return offset;
    }
    Utf32Decoder.prototype.end = function() {
      if (this.overflow.length === 0) {
        return;
      }
      this.overflow.length = 0;
      return String.fromCharCode(this.badChar);
    };
    exports2.utf32 = Utf32AutoCodec;
    exports2.ucs4 = "utf32";
    function Utf32AutoCodec(options, iconv) {
      this.iconv = iconv;
    }
    Utf32AutoCodec.prototype.encoder = Utf32AutoEncoder;
    Utf32AutoCodec.prototype.decoder = Utf32AutoDecoder;
    function Utf32AutoEncoder(options, codec) {
      options = options || {};
      if (options.addBOM === void 0) {
        options.addBOM = true;
      }
      this.encoder = codec.iconv.getEncoder(options.defaultEncoding || "utf-32le", options);
    }
    Utf32AutoEncoder.prototype.write = function(str) {
      return this.encoder.write(str);
    };
    Utf32AutoEncoder.prototype.end = function() {
      return this.encoder.end();
    };
    function Utf32AutoDecoder(options, codec) {
      this.decoder = null;
      this.initialBufs = [];
      this.initialBufsLen = 0;
      this.options = options || {};
      this.iconv = codec.iconv;
    }
    Utf32AutoDecoder.prototype.write = function(buf) {
      if (!this.decoder) {
        this.initialBufs.push(buf);
        this.initialBufsLen += buf.length;
        if (this.initialBufsLen < 32) {
          return "";
        }
        var encoding = detectEncoding(this.initialBufs, this.options.defaultEncoding);
        this.decoder = this.iconv.getDecoder(encoding, this.options);
        var resStr = "";
        for (var i = 0; i < this.initialBufs.length; i++) {
          resStr += this.decoder.write(this.initialBufs[i]);
        }
        this.initialBufs.length = this.initialBufsLen = 0;
        return resStr;
      }
      return this.decoder.write(buf);
    };
    Utf32AutoDecoder.prototype.end = function() {
      if (!this.decoder) {
        var encoding = detectEncoding(this.initialBufs, this.options.defaultEncoding);
        this.decoder = this.iconv.getDecoder(encoding, this.options);
        var resStr = "";
        for (var i = 0; i < this.initialBufs.length; i++) {
          resStr += this.decoder.write(this.initialBufs[i]);
        }
        var trail = this.decoder.end();
        if (trail) {
          resStr += trail;
        }
        this.initialBufs.length = this.initialBufsLen = 0;
        return resStr;
      }
      return this.decoder.end();
    };
    function detectEncoding(bufs, defaultEncoding) {
      var b = [];
      var charsProcessed = 0;
      var invalidLE = 0;
      var invalidBE = 0;
      var bmpCharsLE = 0;
      var bmpCharsBE = 0;
      outerLoop:
        for (var i = 0; i < bufs.length; i++) {
          var buf = bufs[i];
          for (var j = 0; j < buf.length; j++) {
            b.push(buf[j]);
            if (b.length === 4) {
              if (charsProcessed === 0) {
                if (b[0] === 255 && b[1] === 254 && b[2] === 0 && b[3] === 0) {
                  return "utf-32le";
                }
                if (b[0] === 0 && b[1] === 0 && b[2] === 254 && b[3] === 255) {
                  return "utf-32be";
                }
              }
              if (b[0] !== 0 || b[1] > 16)
                invalidBE++;
              if (b[3] !== 0 || b[2] > 16)
                invalidLE++;
              if (b[0] === 0 && b[1] === 0 && (b[2] !== 0 || b[3] !== 0))
                bmpCharsBE++;
              if ((b[0] !== 0 || b[1] !== 0) && b[2] === 0 && b[3] === 0)
                bmpCharsLE++;
              b.length = 0;
              charsProcessed++;
              if (charsProcessed >= 100) {
                break outerLoop;
              }
            }
          }
        }
      if (bmpCharsBE - invalidBE > bmpCharsLE - invalidLE)
        return "utf-32be";
      if (bmpCharsBE - invalidBE < bmpCharsLE - invalidLE)
        return "utf-32le";
      return defaultEncoding || "utf-32le";
    }
  }
});

// node_modules/iconv-lite/encodings/utf16.js
var require_utf16 = __commonJS({
  "node_modules/iconv-lite/encodings/utf16.js"(exports2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    exports2.utf16be = Utf16BECodec;
    function Utf16BECodec() {
    }
    Utf16BECodec.prototype.encoder = Utf16BEEncoder;
    Utf16BECodec.prototype.decoder = Utf16BEDecoder;
    Utf16BECodec.prototype.bomAware = true;
    function Utf16BEEncoder() {
    }
    Utf16BEEncoder.prototype.write = function(str) {
      var buf = Buffer2.from(str, "ucs2");
      for (var i = 0; i < buf.length; i += 2) {
        var tmp = buf[i];
        buf[i] = buf[i + 1];
        buf[i + 1] = tmp;
      }
      return buf;
    };
    Utf16BEEncoder.prototype.end = function() {
    };
    function Utf16BEDecoder() {
      this.overflowByte = -1;
    }
    Utf16BEDecoder.prototype.write = function(buf) {
      if (buf.length == 0) {
        return "";
      }
      var buf2 = Buffer2.alloc(buf.length + 1);
      var i = 0;
      var j = 0;
      if (this.overflowByte !== -1) {
        buf2[0] = buf[0];
        buf2[1] = this.overflowByte;
        i = 1;
        j = 2;
      }
      for (; i < buf.length - 1; i += 2, j += 2) {
        buf2[j] = buf[i + 1];
        buf2[j + 1] = buf[i];
      }
      this.overflowByte = i == buf.length - 1 ? buf[buf.length - 1] : -1;
      return buf2.slice(0, j).toString("ucs2");
    };
    Utf16BEDecoder.prototype.end = function() {
      this.overflowByte = -1;
    };
    exports2.utf16 = Utf16Codec;
    function Utf16Codec(codecOptions, iconv) {
      this.iconv = iconv;
    }
    Utf16Codec.prototype.encoder = Utf16Encoder;
    Utf16Codec.prototype.decoder = Utf16Decoder;
    function Utf16Encoder(options, codec) {
      options = options || {};
      if (options.addBOM === void 0) {
        options.addBOM = true;
      }
      this.encoder = codec.iconv.getEncoder("utf-16le", options);
    }
    Utf16Encoder.prototype.write = function(str) {
      return this.encoder.write(str);
    };
    Utf16Encoder.prototype.end = function() {
      return this.encoder.end();
    };
    function Utf16Decoder(options, codec) {
      this.decoder = null;
      this.initialBufs = [];
      this.initialBufsLen = 0;
      this.options = options || {};
      this.iconv = codec.iconv;
    }
    Utf16Decoder.prototype.write = function(buf) {
      if (!this.decoder) {
        this.initialBufs.push(buf);
        this.initialBufsLen += buf.length;
        if (this.initialBufsLen < 16) {
          return "";
        }
        var encoding = detectEncoding(this.initialBufs, this.options.defaultEncoding);
        this.decoder = this.iconv.getDecoder(encoding, this.options);
        var resStr = "";
        for (var i = 0; i < this.initialBufs.length; i++) {
          resStr += this.decoder.write(this.initialBufs[i]);
        }
        this.initialBufs.length = this.initialBufsLen = 0;
        return resStr;
      }
      return this.decoder.write(buf);
    };
    Utf16Decoder.prototype.end = function() {
      if (!this.decoder) {
        var encoding = detectEncoding(this.initialBufs, this.options.defaultEncoding);
        this.decoder = this.iconv.getDecoder(encoding, this.options);
        var resStr = "";
        for (var i = 0; i < this.initialBufs.length; i++) {
          resStr += this.decoder.write(this.initialBufs[i]);
        }
        var trail = this.decoder.end();
        if (trail) {
          resStr += trail;
        }
        this.initialBufs.length = this.initialBufsLen = 0;
        return resStr;
      }
      return this.decoder.end();
    };
    function detectEncoding(bufs, defaultEncoding) {
      var b = [];
      var charsProcessed = 0;
      var asciiCharsLE = 0;
      var asciiCharsBE = 0;
      outerLoop:
        for (var i = 0; i < bufs.length; i++) {
          var buf = bufs[i];
          for (var j = 0; j < buf.length; j++) {
            b.push(buf[j]);
            if (b.length === 2) {
              if (charsProcessed === 0) {
                if (b[0] === 255 && b[1] === 254)
                  return "utf-16le";
                if (b[0] === 254 && b[1] === 255)
                  return "utf-16be";
              }
              if (b[0] === 0 && b[1] !== 0)
                asciiCharsBE++;
              if (b[0] !== 0 && b[1] === 0)
                asciiCharsLE++;
              b.length = 0;
              charsProcessed++;
              if (charsProcessed >= 100) {
                break outerLoop;
              }
            }
          }
        }
      if (asciiCharsBE > asciiCharsLE)
        return "utf-16be";
      if (asciiCharsBE < asciiCharsLE)
        return "utf-16le";
      return defaultEncoding || "utf-16le";
    }
  }
});

// node_modules/iconv-lite/encodings/utf7.js
var require_utf7 = __commonJS({
  "node_modules/iconv-lite/encodings/utf7.js"(exports2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    exports2.utf7 = Utf7Codec;
    exports2.unicode11utf7 = "utf7";
    function Utf7Codec(codecOptions, iconv) {
      this.iconv = iconv;
    }
    Utf7Codec.prototype.encoder = Utf7Encoder;
    Utf7Codec.prototype.decoder = Utf7Decoder;
    Utf7Codec.prototype.bomAware = true;
    var nonDirectChars = /[^A-Za-z0-9'\(\),-\.\/:\? \n\r\t]+/g;
    function Utf7Encoder(options, codec) {
      this.iconv = codec.iconv;
    }
    Utf7Encoder.prototype.write = function(str) {
      return Buffer2.from(str.replace(nonDirectChars, function(chunk) {
        return "+" + (chunk === "+" ? "" : this.iconv.encode(chunk, "utf16-be").toString("base64").replace(/=+$/, "")) + "-";
      }.bind(this)));
    };
    Utf7Encoder.prototype.end = function() {
    };
    function Utf7Decoder(options, codec) {
      this.iconv = codec.iconv;
      this.inBase64 = false;
      this.base64Accum = "";
    }
    var base64Regex = /[A-Za-z0-9\/+]/;
    var base64Chars = [];
    for (i = 0; i < 256; i++) {
      base64Chars[i] = base64Regex.test(String.fromCharCode(i));
    }
    var i;
    var plusChar = "+".charCodeAt(0);
    var minusChar = "-".charCodeAt(0);
    var andChar = "&".charCodeAt(0);
    Utf7Decoder.prototype.write = function(buf) {
      var res = "";
      var lastI = 0;
      var inBase64 = this.inBase64;
      var base64Accum = this.base64Accum;
      for (var i2 = 0; i2 < buf.length; i2++) {
        if (!inBase64) {
          if (buf[i2] == plusChar) {
            res += this.iconv.decode(buf.slice(lastI, i2), "ascii");
            lastI = i2 + 1;
            inBase64 = true;
          }
        } else {
          if (!base64Chars[buf[i2]]) {
            if (i2 == lastI && buf[i2] == minusChar) {
              res += "+";
            } else {
              var b64str = base64Accum + this.iconv.decode(buf.slice(lastI, i2), "ascii");
              res += this.iconv.decode(Buffer2.from(b64str, "base64"), "utf16-be");
            }
            if (buf[i2] != minusChar) {
              i2--;
            }
            lastI = i2 + 1;
            inBase64 = false;
            base64Accum = "";
          }
        }
      }
      if (!inBase64) {
        res += this.iconv.decode(buf.slice(lastI), "ascii");
      } else {
        var b64str = base64Accum + this.iconv.decode(buf.slice(lastI), "ascii");
        var canBeDecoded = b64str.length - b64str.length % 8;
        base64Accum = b64str.slice(canBeDecoded);
        b64str = b64str.slice(0, canBeDecoded);
        res += this.iconv.decode(Buffer2.from(b64str, "base64"), "utf16-be");
      }
      this.inBase64 = inBase64;
      this.base64Accum = base64Accum;
      return res;
    };
    Utf7Decoder.prototype.end = function() {
      var res = "";
      if (this.inBase64 && this.base64Accum.length > 0) {
        res = this.iconv.decode(Buffer2.from(this.base64Accum, "base64"), "utf16-be");
      }
      this.inBase64 = false;
      this.base64Accum = "";
      return res;
    };
    exports2.utf7imap = Utf7IMAPCodec;
    function Utf7IMAPCodec(codecOptions, iconv) {
      this.iconv = iconv;
    }
    Utf7IMAPCodec.prototype.encoder = Utf7IMAPEncoder;
    Utf7IMAPCodec.prototype.decoder = Utf7IMAPDecoder;
    Utf7IMAPCodec.prototype.bomAware = true;
    function Utf7IMAPEncoder(options, codec) {
      this.iconv = codec.iconv;
      this.inBase64 = false;
      this.base64Accum = Buffer2.alloc(6);
      this.base64AccumIdx = 0;
    }
    Utf7IMAPEncoder.prototype.write = function(str) {
      var inBase64 = this.inBase64;
      var base64Accum = this.base64Accum;
      var base64AccumIdx = this.base64AccumIdx;
      var buf = Buffer2.alloc(str.length * 5 + 10);
      var bufIdx = 0;
      for (var i2 = 0; i2 < str.length; i2++) {
        var uChar = str.charCodeAt(i2);
        if (uChar >= 32 && uChar <= 126) {
          if (inBase64) {
            if (base64AccumIdx > 0) {
              bufIdx += buf.write(base64Accum.slice(0, base64AccumIdx).toString("base64").replace(/\//g, ",").replace(/=+$/, ""), bufIdx);
              base64AccumIdx = 0;
            }
            buf[bufIdx++] = minusChar;
            inBase64 = false;
          }
          if (!inBase64) {
            buf[bufIdx++] = uChar;
            if (uChar === andChar) {
              buf[bufIdx++] = minusChar;
            }
          }
        } else {
          if (!inBase64) {
            buf[bufIdx++] = andChar;
            inBase64 = true;
          }
          if (inBase64) {
            base64Accum[base64AccumIdx++] = uChar >> 8;
            base64Accum[base64AccumIdx++] = uChar & 255;
            if (base64AccumIdx == base64Accum.length) {
              bufIdx += buf.write(base64Accum.toString("base64").replace(/\//g, ","), bufIdx);
              base64AccumIdx = 0;
            }
          }
        }
      }
      this.inBase64 = inBase64;
      this.base64AccumIdx = base64AccumIdx;
      return buf.slice(0, bufIdx);
    };
    Utf7IMAPEncoder.prototype.end = function() {
      var buf = Buffer2.alloc(10);
      var bufIdx = 0;
      if (this.inBase64) {
        if (this.base64AccumIdx > 0) {
          bufIdx += buf.write(this.base64Accum.slice(0, this.base64AccumIdx).toString("base64").replace(/\//g, ",").replace(/=+$/, ""), bufIdx);
          this.base64AccumIdx = 0;
        }
        buf[bufIdx++] = minusChar;
        this.inBase64 = false;
      }
      return buf.slice(0, bufIdx);
    };
    function Utf7IMAPDecoder(options, codec) {
      this.iconv = codec.iconv;
      this.inBase64 = false;
      this.base64Accum = "";
    }
    var base64IMAPChars = base64Chars.slice();
    base64IMAPChars[",".charCodeAt(0)] = true;
    Utf7IMAPDecoder.prototype.write = function(buf) {
      var res = "";
      var lastI = 0;
      var inBase64 = this.inBase64;
      var base64Accum = this.base64Accum;
      for (var i2 = 0; i2 < buf.length; i2++) {
        if (!inBase64) {
          if (buf[i2] == andChar) {
            res += this.iconv.decode(buf.slice(lastI, i2), "ascii");
            lastI = i2 + 1;
            inBase64 = true;
          }
        } else {
          if (!base64IMAPChars[buf[i2]]) {
            if (i2 == lastI && buf[i2] == minusChar) {
              res += "&";
            } else {
              var b64str = base64Accum + this.iconv.decode(buf.slice(lastI, i2), "ascii").replace(/,/g, "/");
              res += this.iconv.decode(Buffer2.from(b64str, "base64"), "utf16-be");
            }
            if (buf[i2] != minusChar) {
              i2--;
            }
            lastI = i2 + 1;
            inBase64 = false;
            base64Accum = "";
          }
        }
      }
      if (!inBase64) {
        res += this.iconv.decode(buf.slice(lastI), "ascii");
      } else {
        var b64str = base64Accum + this.iconv.decode(buf.slice(lastI), "ascii").replace(/,/g, "/");
        var canBeDecoded = b64str.length - b64str.length % 8;
        base64Accum = b64str.slice(canBeDecoded);
        b64str = b64str.slice(0, canBeDecoded);
        res += this.iconv.decode(Buffer2.from(b64str, "base64"), "utf16-be");
      }
      this.inBase64 = inBase64;
      this.base64Accum = base64Accum;
      return res;
    };
    Utf7IMAPDecoder.prototype.end = function() {
      var res = "";
      if (this.inBase64 && this.base64Accum.length > 0) {
        res = this.iconv.decode(Buffer2.from(this.base64Accum, "base64"), "utf16-be");
      }
      this.inBase64 = false;
      this.base64Accum = "";
      return res;
    };
  }
});

// node_modules/iconv-lite/encodings/sbcs-codec.js
var require_sbcs_codec = __commonJS({
  "node_modules/iconv-lite/encodings/sbcs-codec.js"(exports2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    exports2._sbcs = SBCSCodec;
    function SBCSCodec(codecOptions, iconv) {
      if (!codecOptions) {
        throw new Error("SBCS codec is called without the data.");
      }
      if (!codecOptions.chars || codecOptions.chars.length !== 128 && codecOptions.chars.length !== 256) {
        throw new Error("Encoding '" + codecOptions.type + "' has incorrect 'chars' (must be of len 128 or 256)");
      }
      if (codecOptions.chars.length === 128) {
        var asciiString = "";
        for (var i = 0; i < 128; i++) {
          asciiString += String.fromCharCode(i);
        }
        codecOptions.chars = asciiString + codecOptions.chars;
      }
      this.decodeBuf = Buffer2.from(codecOptions.chars, "ucs2");
      var encodeBuf = Buffer2.alloc(65536, iconv.defaultCharSingleByte.charCodeAt(0));
      for (var i = 0; i < codecOptions.chars.length; i++) {
        encodeBuf[codecOptions.chars.charCodeAt(i)] = i;
      }
      this.encodeBuf = encodeBuf;
    }
    SBCSCodec.prototype.encoder = SBCSEncoder;
    SBCSCodec.prototype.decoder = SBCSDecoder;
    function SBCSEncoder(options, codec) {
      this.encodeBuf = codec.encodeBuf;
    }
    SBCSEncoder.prototype.write = function(str) {
      var buf = Buffer2.alloc(str.length);
      for (var i = 0; i < str.length; i++) {
        buf[i] = this.encodeBuf[str.charCodeAt(i)];
      }
      return buf;
    };
    SBCSEncoder.prototype.end = function() {
    };
    function SBCSDecoder(options, codec) {
      this.decodeBuf = codec.decodeBuf;
    }
    SBCSDecoder.prototype.write = function(buf) {
      var decodeBuf = this.decodeBuf;
      var newBuf = Buffer2.alloc(buf.length * 2);
      var idx1 = 0;
      var idx2 = 0;
      for (var i = 0; i < buf.length; i++) {
        idx1 = buf[i] * 2;
        idx2 = i * 2;
        newBuf[idx2] = decodeBuf[idx1];
        newBuf[idx2 + 1] = decodeBuf[idx1 + 1];
      }
      return newBuf.toString("ucs2");
    };
    SBCSDecoder.prototype.end = function() {
    };
  }
});

// node_modules/iconv-lite/encodings/sbcs-data.js
var require_sbcs_data = __commonJS({
  "node_modules/iconv-lite/encodings/sbcs-data.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      // Not supported by iconv, not sure why.
      10029: "maccenteuro",
      maccenteuro: {
        type: "_sbcs",
        chars: "ÄĀāÉĄÖÜáąČäčĆćéŹźĎíďĒēĖóėôöõúĚěü†°Ę£§•¶ß®©™ę¨≠ģĮįĪ≤≥īĶ∂∑łĻļĽľĹĺŅņŃ¬√ńŇ∆«»… ňŐÕőŌ–—“”‘’÷◊ōŔŕŘ‹›řŖŗŠ‚„šŚśÁŤťÍŽžŪÓÔūŮÚůŰűŲųÝýķŻŁżĢˇ"
      },
      808: "cp808",
      ibm808: "cp808",
      cp808: {
        type: "_sbcs",
        chars: "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№€■ "
      },
      mik: {
        type: "_sbcs",
        chars: "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя└┴┬├─┼╣║╚╔╩╦╠═╬┐░▒▓│┤№§╗╝┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
      },
      cp720: {
        type: "_sbcs",
        chars: "éâàçêëèïîّْô¤ـûùءآأؤ£إئابةتثجحخدذرزسشص«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ضطظعغفµقكلمنهوىي≡ًٌٍَُِ≈°∙·√ⁿ²■ "
      },
      // Aliases of generated encodings.
      ascii8bit: "ascii",
      usascii: "ascii",
      ansix34: "ascii",
      ansix341968: "ascii",
      ansix341986: "ascii",
      csascii: "ascii",
      cp367: "ascii",
      ibm367: "ascii",
      isoir6: "ascii",
      iso646us: "ascii",
      iso646irv: "ascii",
      us: "ascii",
      latin1: "iso88591",
      latin2: "iso88592",
      latin3: "iso88593",
      latin4: "iso88594",
      latin5: "iso88599",
      latin6: "iso885910",
      latin7: "iso885913",
      latin8: "iso885914",
      latin9: "iso885915",
      latin10: "iso885916",
      csisolatin1: "iso88591",
      csisolatin2: "iso88592",
      csisolatin3: "iso88593",
      csisolatin4: "iso88594",
      csisolatincyrillic: "iso88595",
      csisolatinarabic: "iso88596",
      csisolatingreek: "iso88597",
      csisolatinhebrew: "iso88598",
      csisolatin5: "iso88599",
      csisolatin6: "iso885910",
      l1: "iso88591",
      l2: "iso88592",
      l3: "iso88593",
      l4: "iso88594",
      l5: "iso88599",
      l6: "iso885910",
      l7: "iso885913",
      l8: "iso885914",
      l9: "iso885915",
      l10: "iso885916",
      isoir14: "iso646jp",
      isoir57: "iso646cn",
      isoir100: "iso88591",
      isoir101: "iso88592",
      isoir109: "iso88593",
      isoir110: "iso88594",
      isoir144: "iso88595",
      isoir127: "iso88596",
      isoir126: "iso88597",
      isoir138: "iso88598",
      isoir148: "iso88599",
      isoir157: "iso885910",
      isoir166: "tis620",
      isoir179: "iso885913",
      isoir199: "iso885914",
      isoir203: "iso885915",
      isoir226: "iso885916",
      cp819: "iso88591",
      ibm819: "iso88591",
      cyrillic: "iso88595",
      arabic: "iso88596",
      arabic8: "iso88596",
      ecma114: "iso88596",
      asmo708: "iso88596",
      greek: "iso88597",
      greek8: "iso88597",
      ecma118: "iso88597",
      elot928: "iso88597",
      hebrew: "iso88598",
      hebrew8: "iso88598",
      iso88598i: "iso88598",
      iso88598e: "iso88598",
      turkish: "iso88599",
      turkish8: "iso88599",
      thai: "iso885911",
      thai8: "iso885911",
      celtic: "iso885914",
      celtic8: "iso885914",
      isoceltic: "iso885914",
      tis6200: "tis620",
      tis62025291: "tis620",
      tis62025330: "tis620",
      1e4: "macroman",
      10006: "macgreek",
      10007: "maccyrillic",
      10079: "maciceland",
      10081: "macturkish",
      cspc8codepage437: "cp437",
      cspc775baltic: "cp775",
      cspc850multilingual: "cp850",
      cspcp852: "cp852",
      cspc862latinhebrew: "cp862",
      cpgr: "cp869",
      msee: "cp1250",
      mscyrl: "cp1251",
      msansi: "cp1252",
      msgreek: "cp1253",
      msturk: "cp1254",
      mshebr: "cp1255",
      msarab: "cp1256",
      winbaltrim: "cp1257",
      cp20866: "koi8r",
      20866: "koi8r",
      ibm878: "koi8r",
      cskoi8r: "koi8r",
      cp21866: "koi8u",
      21866: "koi8u",
      ibm1168: "koi8u",
      strk10482002: "rk1048",
      tcvn5712: "tcvn",
      tcvn57121: "tcvn",
      gb198880: "iso646cn",
      cn: "iso646cn",
      csiso14jisc6220ro: "iso646jp",
      jisc62201969ro: "iso646jp",
      jp: "iso646jp",
      cshproman8: "hproman8",
      r8: "hproman8",
      roman8: "hproman8",
      xroman8: "hproman8",
      ibm1051: "hproman8",
      mac: "macintosh",
      csmacintosh: "macintosh"
    };
  }
});

// node_modules/iconv-lite/encodings/sbcs-data-generated.js
var require_sbcs_data_generated = __commonJS({
  "node_modules/iconv-lite/encodings/sbcs-data-generated.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      "437": "cp437",
      "737": "cp737",
      "775": "cp775",
      "850": "cp850",
      "852": "cp852",
      "855": "cp855",
      "856": "cp856",
      "857": "cp857",
      "858": "cp858",
      "860": "cp860",
      "861": "cp861",
      "862": "cp862",
      "863": "cp863",
      "864": "cp864",
      "865": "cp865",
      "866": "cp866",
      "869": "cp869",
      "874": "windows874",
      "922": "cp922",
      "1046": "cp1046",
      "1124": "cp1124",
      "1125": "cp1125",
      "1129": "cp1129",
      "1133": "cp1133",
      "1161": "cp1161",
      "1162": "cp1162",
      "1163": "cp1163",
      "1250": "windows1250",
      "1251": "windows1251",
      "1252": "windows1252",
      "1253": "windows1253",
      "1254": "windows1254",
      "1255": "windows1255",
      "1256": "windows1256",
      "1257": "windows1257",
      "1258": "windows1258",
      "28591": "iso88591",
      "28592": "iso88592",
      "28593": "iso88593",
      "28594": "iso88594",
      "28595": "iso88595",
      "28596": "iso88596",
      "28597": "iso88597",
      "28598": "iso88598",
      "28599": "iso88599",
      "28600": "iso885910",
      "28601": "iso885911",
      "28603": "iso885913",
      "28604": "iso885914",
      "28605": "iso885915",
      "28606": "iso885916",
      "windows874": {
        "type": "_sbcs",
        "chars": "€����…�����������‘’“”•–—�������� กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู����฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛����"
      },
      "win874": "windows874",
      "cp874": "windows874",
      "windows1250": {
        "type": "_sbcs",
        "chars": "€�‚�„…†‡�‰Š‹ŚŤŽŹ�‘’“”•–—�™š›śťžź ˇ˘Ł¤Ą¦§¨©Ş«¬­®Ż°±˛ł´µ¶·¸ąş»Ľ˝ľżŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙"
      },
      "win1250": "windows1250",
      "cp1250": "windows1250",
      "windows1251": {
        "type": "_sbcs",
        "chars": "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—�™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя"
      },
      "win1251": "windows1251",
      "cp1251": "windows1251",
      "windows1252": {
        "type": "_sbcs",
        "chars": "€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ"
      },
      "win1252": "windows1252",
      "cp1252": "windows1252",
      "windows1253": {
        "type": "_sbcs",
        "chars": "€�‚ƒ„…†‡�‰�‹�����‘’“”•–—�™�›���� ΅Ά£¤¥¦§¨©�«¬­®―°±²³΄µ¶·ΈΉΊ»Ό½ΎΏΐΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡ�ΣΤΥΦΧΨΩΪΫάέήίΰαβγδεζηθικλμνξοπρςστυφχψωϊϋόύώ�"
      },
      "win1253": "windows1253",
      "cp1253": "windows1253",
      "windows1254": {
        "type": "_sbcs",
        "chars": "€�‚ƒ„…†‡ˆ‰Š‹Œ����‘’“”•–—˜™š›œ��Ÿ ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏĞÑÒÓÔÕÖ×ØÙÚÛÜİŞßàáâãäåæçèéêëìíîïğñòóôõö÷øùúûüışÿ"
      },
      "win1254": "windows1254",
      "cp1254": "windows1254",
      "windows1255": {
        "type": "_sbcs",
        "chars": "€�‚ƒ„…†‡ˆ‰�‹�����‘’“”•–—˜™�›���� ¡¢£₪¥¦§¨©×«¬­®¯°±²³´µ¶·¸¹÷»¼½¾¿ְֱֲֳִֵֶַָֹֺֻּֽ־ֿ׀ׁׂ׃װױײ׳״�������אבגדהוזחטיךכלםמןנסעףפץצקרשת��‎‏�"
      },
      "win1255": "windows1255",
      "cp1255": "windows1255",
      "windows1256": {
        "type": "_sbcs",
        "chars": "€پ‚ƒ„…†‡ˆ‰ٹ‹Œچژڈگ‘’“”•–—ک™ڑ›œ‌‍ں ،¢£¤¥¦§¨©ھ«¬­®¯°±²³´µ¶·¸¹؛»¼½¾؟ہءآأؤإئابةتثجحخدذرزسشصض×طظعغـفقكàلâمنهوçèéêëىيîïًٌٍَôُِ÷ّùْûü‎‏ے"
      },
      "win1256": "windows1256",
      "cp1256": "windows1256",
      "windows1257": {
        "type": "_sbcs",
        "chars": "€�‚�„…†‡�‰�‹�¨ˇ¸�‘’“”•–—�™�›�¯˛� �¢£¤�¦§Ø©Ŗ«¬­®Æ°±²³´µ¶·ø¹ŗ»¼½¾æĄĮĀĆÄÅĘĒČÉŹĖĢĶĪĻŠŃŅÓŌÕÖ×ŲŁŚŪÜŻŽßąįāćäåęēčéźėģķīļšńņóōõö÷ųłśūüżž˙"
      },
      "win1257": "windows1257",
      "cp1257": "windows1257",
      "windows1258": {
        "type": "_sbcs",
        "chars": "€�‚ƒ„…†‡ˆ‰�‹Œ����‘’“”•–—˜™�›œ��Ÿ ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂĂÄÅÆÇÈÉÊË̀ÍÎÏĐÑ̉ÓÔƠÖ×ØÙÚÛÜỮßàáâăäåæçèéêë́íîïđṇ̃óôơö÷øùúûüư₫ÿ"
      },
      "win1258": "windows1258",
      "cp1258": "windows1258",
      "iso88591": {
        "type": "_sbcs",
        "chars": " ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ"
      },
      "cp28591": "iso88591",
      "iso88592": {
        "type": "_sbcs",
        "chars": " Ą˘Ł¤ĽŚ§¨ŠŞŤŹ­ŽŻ°ą˛ł´ľśˇ¸šşťź˝žżŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙"
      },
      "cp28592": "iso88592",
      "iso88593": {
        "type": "_sbcs",
        "chars": " Ħ˘£¤�Ĥ§¨İŞĞĴ­�Ż°ħ²³´µĥ·¸ışğĵ½�żÀÁÂ�ÄĊĈÇÈÉÊËÌÍÎÏ�ÑÒÓÔĠÖ×ĜÙÚÛÜŬŜßàáâ�äċĉçèéêëìíîï�ñòóôġö÷ĝùúûüŭŝ˙"
      },
      "cp28593": "iso88593",
      "iso88594": {
        "type": "_sbcs",
        "chars": " ĄĸŖ¤ĨĻ§¨ŠĒĢŦ­Ž¯°ą˛ŗ´ĩļˇ¸šēģŧŊžŋĀÁÂÃÄÅÆĮČÉĘËĖÍÎĪĐŅŌĶÔÕÖ×ØŲÚÛÜŨŪßāáâãäåæįčéęëėíîīđņōķôõö÷øųúûüũū˙"
      },
      "cp28594": "iso88594",
      "iso88595": {
        "type": "_sbcs",
        "chars": " ЁЂЃЄЅІЇЈЉЊЋЌ­ЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя№ёђѓєѕіїјљњћќ§ўџ"
      },
      "cp28595": "iso88595",
      "iso88596": {
        "type": "_sbcs",
        "chars": " ���¤�������،­�������������؛���؟�ءآأؤإئابةتثجحخدذرزسشصضطظعغ�����ـفقكلمنهوىيًٌٍَُِّْ�������������"
      },
      "cp28596": "iso88596",
      "iso88597": {
        "type": "_sbcs",
        "chars": " ‘’£€₯¦§¨©ͺ«¬­�―°±²³΄΅Ά·ΈΉΊ»Ό½ΎΏΐΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡ�ΣΤΥΦΧΨΩΪΫάέήίΰαβγδεζηθικλμνξοπρςστυφχψωϊϋόύώ�"
      },
      "cp28597": "iso88597",
      "iso88598": {
        "type": "_sbcs",
        "chars": " �¢£¤¥¦§¨©×«¬­®¯°±²³´µ¶·¸¹÷»¼½¾��������������������������������‗אבגדהוזחטיךכלםמןנסעףפץצקרשת��‎‏�"
      },
      "cp28598": "iso88598",
      "iso88599": {
        "type": "_sbcs",
        "chars": " ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏĞÑÒÓÔÕÖ×ØÙÚÛÜİŞßàáâãäåæçèéêëìíîïğñòóôõö÷øùúûüışÿ"
      },
      "cp28599": "iso88599",
      "iso885910": {
        "type": "_sbcs",
        "chars": " ĄĒĢĪĨĶ§ĻĐŠŦŽ­ŪŊ°ąēģīĩķ·ļđšŧž―ūŋĀÁÂÃÄÅÆĮČÉĘËĖÍÎÏÐŅŌÓÔÕÖŨØŲÚÛÜÝÞßāáâãäåæįčéęëėíîïðņōóôõöũøųúûüýþĸ"
      },
      "cp28600": "iso885910",
      "iso885911": {
        "type": "_sbcs",
        "chars": " กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู����฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛����"
      },
      "cp28601": "iso885911",
      "iso885913": {
        "type": "_sbcs",
        "chars": " ”¢£¤„¦§Ø©Ŗ«¬­®Æ°±²³“µ¶·ø¹ŗ»¼½¾æĄĮĀĆÄÅĘĒČÉŹĖĢĶĪĻŠŃŅÓŌÕÖ×ŲŁŚŪÜŻŽßąįāćäåęēčéźėģķīļšńņóōõö÷ųłśūüżž’"
      },
      "cp28603": "iso885913",
      "iso885914": {
        "type": "_sbcs",
        "chars": " Ḃḃ£ĊċḊ§Ẁ©ẂḋỲ­®ŸḞḟĠġṀṁ¶ṖẁṗẃṠỳẄẅṡÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏŴÑÒÓÔÕÖṪØÙÚÛÜÝŶßàáâãäåæçèéêëìíîïŵñòóôõöṫøùúûüýŷÿ"
      },
      "cp28604": "iso885914",
      "iso885915": {
        "type": "_sbcs",
        "chars": " ¡¢£€¥Š§š©ª«¬­®¯°±²³Žµ¶·ž¹º»ŒœŸ¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ"
      },
      "cp28605": "iso885915",
      "iso885916": {
        "type": "_sbcs",
        "chars": " ĄąŁ€„Š§š©Ș«Ź­źŻ°±ČłŽ”¶·žčș»ŒœŸżÀÁÂĂÄĆÆÇÈÉÊËÌÍÎÏĐŃÒÓÔŐÖŚŰÙÚÛÜĘȚßàáâăäćæçèéêëìíîïđńòóôőöśűùúûüęțÿ"
      },
      "cp28606": "iso885916",
      "cp437": {
        "type": "_sbcs",
        "chars": "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
      },
      "ibm437": "cp437",
      "csibm437": "cp437",
      "cp737": {
        "type": "_sbcs",
        "chars": "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψ░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ωάέήϊίόύϋώΆΈΉΊΌΎΏ±≥≤ΪΫ÷≈°∙·√ⁿ²■ "
      },
      "ibm737": "cp737",
      "csibm737": "cp737",
      "cp775": {
        "type": "_sbcs",
        "chars": "ĆüéāäģåćłēŖŗīŹÄÅÉæÆōöĢ¢ŚśÖÜø£Ø×¤ĀĪóŻżź”¦©®¬½¼Ł«»░▒▓│┤ĄČĘĖ╣║╗╝ĮŠ┐└┴┬├─┼ŲŪ╚╔╩╦╠═╬Žąčęėįšųūž┘┌█▄▌▐▀ÓßŌŃõÕµńĶķĻļņĒŅ’­±“¾¶§÷„°∙·¹³²■ "
      },
      "ibm775": "cp775",
      "csibm775": "cp775",
      "cp850": {
        "type": "_sbcs",
        "chars": "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ "
      },
      "ibm850": "cp850",
      "csibm850": "cp850",
      "cp852": {
        "type": "_sbcs",
        "chars": "ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´­˝˛ˇ˘§÷¸°¨˙űŘř■ "
      },
      "ibm852": "cp852",
      "csibm852": "cp852",
      "cp855": {
        "type": "_sbcs",
        "chars": "ђЂѓЃёЁєЄѕЅіІїЇјЈљЉњЊћЋќЌўЎџЏюЮъЪаАбБцЦдДеЕфФгГ«»░▒▓│┤хХиИ╣║╗╝йЙ┐└┴┬├─┼кК╚╔╩╦╠═╬¤лЛмМнНоОп┘┌█▄Пя▀ЯрРсСтТуУжЖвВьЬ№­ыЫзЗшШэЭщЩчЧ§■ "
      },
      "ibm855": "cp855",
      "csibm855": "cp855",
      "cp856": {
        "type": "_sbcs",
        "chars": "אבגדהוזחטיךכלםמןנסעףפץצקרשת�£�×����������®¬½¼�«»░▒▓│┤���©╣║╗╝¢¥┐└┴┬├─┼��╚╔╩╦╠═╬¤���������┘┌█▄¦�▀������µ�������¯´­±‗¾¶§÷¸°¨·¹³²■ "
      },
      "ibm856": "cp856",
      "csibm856": "cp856",
      "cp857": {
        "type": "_sbcs",
        "chars": "ÇüéâäàåçêëèïîıÄÅÉæÆôöòûùİÖÜø£ØŞşáíóúñÑĞğ¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ºªÊËÈ�ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµ�×ÚÛÙìÿ¯´­±�¾¶§÷¸°¨·¹³²■ "
      },
      "ibm857": "cp857",
      "csibm857": "cp857",
      "cp858": {
        "type": "_sbcs",
        "chars": "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ "
      },
      "ibm858": "cp858",
      "csibm858": "cp858",
      "cp860": {
        "type": "_sbcs",
        "chars": "ÇüéâãàÁçêÊèÍÔìÃÂÉÀÈôõòÚùÌÕÜ¢£Ù₧ÓáíóúñÑªº¿Ò¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
      },
      "ibm860": "cp860",
      "csibm860": "cp860",
      "cp861": {
        "type": "_sbcs",
        "chars": "ÇüéâäàåçêëèÐðÞÄÅÉæÆôöþûÝýÖÜø£Ø₧ƒáíóúÁÍÓÚ¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
      },
      "ibm861": "cp861",
      "csibm861": "cp861",
      "cp862": {
        "type": "_sbcs",
        "chars": "אבגדהוזחטיךכלםמןנסעףפץצקרשת¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
      },
      "ibm862": "cp862",
      "csibm862": "cp862",
      "cp863": {
        "type": "_sbcs",
        "chars": "ÇüéâÂà¶çêëèïî‗À§ÉÈÊôËÏûù¤ÔÜ¢£ÙÛƒ¦´óú¨¸³¯Î⌐¬½¼¾«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
      },
      "ibm863": "cp863",
      "csibm863": "cp863",
      "cp864": {
        "type": "_sbcs",
        "chars": "\0\x07\b	\n\v\f\r\x1B !\"#$٪&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~°·∙√▒─│┼┤┬├┴┐┌└┘β∞φ±½¼≈«»ﻷﻸ��ﻻﻼ� ­ﺂ£¤ﺄ��ﺎﺏﺕﺙ،ﺝﺡﺥ٠١٢٣٤٥٦٧٨٩ﻑ؛ﺱﺵﺹ؟¢ﺀﺁﺃﺅﻊﺋﺍﺑﺓﺗﺛﺟﺣﺧﺩﺫﺭﺯﺳﺷﺻﺿﻁﻅﻋﻏ¦¬÷×ﻉـﻓﻗﻛﻟﻣﻧﻫﻭﻯﻳﺽﻌﻎﻍﻡﹽّﻥﻩﻬﻰﻲﻐﻕﻵﻶﻝﻙﻱ■�"
      },
      "ibm864": "cp864",
      "csibm864": "cp864",
      "cp865": {
        "type": "_sbcs",
        "chars": "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø₧ƒáíóúñÑªº¿⌐¬½¼¡«¤░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
      },
      "ibm865": "cp865",
      "csibm865": "cp865",
      "cp866": {
        "type": "_sbcs",
        "chars": "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ "
      },
      "ibm866": "cp866",
      "csibm866": "cp866",
      "cp869": {
        "type": "_sbcs",
        "chars": "������Ά�·¬¦‘’Έ―ΉΊΪΌ��ΎΫ©Ώ²³ά£έήίϊΐόύΑΒΓΔΕΖΗ½ΘΙ«»░▒▓│┤ΚΛΜΝ╣║╗╝ΞΟ┐└┴┬├─┼ΠΡ╚╔╩╦╠═╬ΣΤΥΦΧΨΩαβγ┘┌█▄δε▀ζηθικλμνξοπρσςτ΄­±υφχ§ψ΅°¨ωϋΰώ■ "
      },
      "ibm869": "cp869",
      "csibm869": "cp869",
      "cp922": {
        "type": "_sbcs",
        "chars": " ¡¢£¤¥¦§¨©ª«¬­®‾°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏŠÑÒÓÔÕÖ×ØÙÚÛÜÝŽßàáâãäåæçèéêëìíîïšñòóôõö÷øùúûüýžÿ"
      },
      "ibm922": "cp922",
      "csibm922": "cp922",
      "cp1046": {
        "type": "_sbcs",
        "chars": "ﺈ×÷ﹱ■│─┐┌└┘ﹹﹻﹽﹿﹷﺊﻰﻳﻲﻎﻏﻐﻶﻸﻺﻼ ¤ﺋﺑﺗﺛﺟﺣ،­ﺧﺳ٠١٢٣٤٥٦٧٨٩ﺷ؛ﺻﺿﻊ؟ﻋءآأؤإئابةتثجحخدذرزسشصضطﻇعغﻌﺂﺄﺎﻓـفقكلمنهوىيًٌٍَُِّْﻗﻛﻟﻵﻷﻹﻻﻣﻧﻬﻩ�"
      },
      "ibm1046": "cp1046",
      "csibm1046": "cp1046",
      "cp1124": {
        "type": "_sbcs",
        "chars": " ЁЂҐЄЅІЇЈЉЊЋЌ­ЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя№ёђґєѕіїјљњћќ§ўџ"
      },
      "ibm1124": "cp1124",
      "csibm1124": "cp1124",
      "cp1125": {
        "type": "_sbcs",
        "chars": "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёҐґЄєІіЇї·√№¤■ "
      },
      "ibm1125": "cp1125",
      "csibm1125": "cp1125",
      "cp1129": {
        "type": "_sbcs",
        "chars": " ¡¢£¤¥¦§œ©ª«¬­®¯°±²³Ÿµ¶·Œ¹º»¼½¾¿ÀÁÂĂÄÅÆÇÈÉÊË̀ÍÎÏĐÑ̉ÓÔƠÖ×ØÙÚÛÜỮßàáâăäåæçèéêë́íîïđṇ̃óôơö÷øùúûüư₫ÿ"
      },
      "ibm1129": "cp1129",
      "csibm1129": "cp1129",
      "cp1133": {
        "type": "_sbcs",
        "chars": " ກຂຄງຈສຊຍດຕຖທນບປຜຝພຟມຢຣລວຫອຮ���ຯະາຳິີຶືຸູຼັົຽ���ເແໂໃໄ່້໊໋໌ໍໆ�ໜໝ₭����������������໐໑໒໓໔໕໖໗໘໙��¢¬¦�"
      },
      "ibm1133": "cp1133",
      "csibm1133": "cp1133",
      "cp1161": {
        "type": "_sbcs",
        "chars": "��������������������������������่กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู้๊๋€฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛¢¬¦ "
      },
      "ibm1161": "cp1161",
      "csibm1161": "cp1161",
      "cp1162": {
        "type": "_sbcs",
        "chars": "€…‘’“”•–— กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู����฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛����"
      },
      "ibm1162": "cp1162",
      "csibm1162": "cp1162",
      "cp1163": {
        "type": "_sbcs",
        "chars": " ¡¢£€¥¦§œ©ª«¬­®¯°±²³Ÿµ¶·Œ¹º»¼½¾¿ÀÁÂĂÄÅÆÇÈÉÊË̀ÍÎÏĐÑ̉ÓÔƠÖ×ØÙÚÛÜỮßàáâăäåæçèéêë́íîïđṇ̃óôơö÷øùúûüư₫ÿ"
      },
      "ibm1163": "cp1163",
      "csibm1163": "cp1163",
      "maccroatian": {
        "type": "_sbcs",
        "chars": "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®Š™´¨≠ŽØ∞±≤≥∆µ∂∑∏š∫ªºΩžø¿¡¬√ƒ≈Ć«Č… ÀÃÕŒœĐ—“”‘’÷◊�©⁄¤‹›Æ»–·‚„‰ÂćÁčÈÍÎÏÌÓÔđÒÚÛÙıˆ˜¯πË˚¸Êæˇ"
      },
      "maccyrillic": {
        "type": "_sbcs",
        "chars": "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ†°¢£§•¶І®©™Ђђ≠Ѓѓ∞±≤≥іµ∂ЈЄєЇїЉљЊњјЅ¬√ƒ≈∆«»… ЋћЌќѕ–—“”‘’÷„ЎўЏџ№Ёёяабвгдежзийклмнопрстуфхцчшщъыьэю¤"
      },
      "macgreek": {
        "type": "_sbcs",
        "chars": "Ä¹²É³ÖÜ΅àâä΄¨çéèêë£™îï•½‰ôö¦­ùûü†ΓΔΘΛΞΠß®©ΣΪ§≠°·Α±≤≥¥ΒΕΖΗΙΚΜΦΫΨΩάΝ¬ΟΡ≈Τ«»… ΥΧΆΈœ–―“”‘’÷ΉΊΌΎέήίόΏύαβψδεφγηιξκλμνοπώρστθωςχυζϊϋΐΰ�"
      },
      "maciceland": {
        "type": "_sbcs",
        "chars": "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûüÝ°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄¤ÐðÞþý·‚„‰ÂÊÁËÈÍÎÏÌÓÔ�ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ"
      },
      "macroman": {
        "type": "_sbcs",
        "chars": "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄¤‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ�ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ"
      },
      "macromania": {
        "type": "_sbcs",
        "chars": "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ĂŞ∞±≤≥¥µ∂∑∏π∫ªºΩăş¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄¤‹›Ţţ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ�ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ"
      },
      "macthai": {
        "type": "_sbcs",
        "chars": "«»…“”�•‘’� กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู\uFEFF​–—฿เแโใไๅๆ็่้๊๋์ํ™๏๐๑๒๓๔๕๖๗๘๙®©����"
      },
      "macturkish": {
        "type": "_sbcs",
        "chars": "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸĞğİıŞş‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ�ÒÚÛÙ�ˆ˜¯˘˙˚¸˝˛ˇ"
      },
      "macukraine": {
        "type": "_sbcs",
        "chars": "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ†°Ґ£§•¶І®©™Ђђ≠Ѓѓ∞±≤≥іµґЈЄєЇїЉљЊњјЅ¬√ƒ≈∆«»… ЋћЌќѕ–—“”‘’÷„ЎўЏџ№Ёёяабвгдежзийклмнопрстуфхцчшщъыьэю¤"
      },
      "koi8r": {
        "type": "_sbcs",
        "chars": "─│┌┐└┘├┤┬┴┼▀▄█▌▐░▒▓⌠■∙√≈≤≥ ⌡°²·÷═║╒ё╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡Ё╢╣╤╥╦╧╨╩╪╫╬©юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ"
      },
      "koi8u": {
        "type": "_sbcs",
        "chars": "─│┌┐└┘├┤┬┴┼▀▄█▌▐░▒▓⌠■∙√≈≤≥ ⌡°²·÷═║╒ёє╔ії╗╘╙╚╛ґ╝╞╟╠╡ЁЄ╣ІЇ╦╧╨╩╪Ґ╬©юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ"
      },
      "koi8ru": {
        "type": "_sbcs",
        "chars": "─│┌┐└┘├┤┬┴┼▀▄█▌▐░▒▓⌠■∙√≈≤≥ ⌡°²·÷═║╒ёє╔ії╗╘╙╚╛ґў╞╟╠╡ЁЄ╣ІЇ╦╧╨╩╪ҐЎ©юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ"
      },
      "koi8t": {
        "type": "_sbcs",
        "chars": "қғ‚Ғ„…†‡�‰ҳ‹ҲҷҶ�Қ‘’“”•–—�™�›�����ӯӮё¤ӣ¦§���«¬­®�°±²Ё�Ӣ¶·�№�»���©юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ"
      },
      "armscii8": {
        "type": "_sbcs",
        "chars": " �և։)(»«—.՝,-֊…՜՛՞ԱաԲբԳգԴդԵեԶզԷէԸըԹթԺժԻիԼլԽխԾծԿկՀհՁձՂղՃճՄմՅյՆնՇշՈոՉչՊպՋջՌռՍսՎվՏտՐրՑցՒւՓփՔքՕօՖֆ՚�"
      },
      "rk1048": {
        "type": "_sbcs",
        "chars": "ЂЃ‚ѓ„…†‡€‰Љ‹ЊҚҺЏђ‘’“”•–—�™љ›њқһџ ҰұӘ¤Ө¦§Ё©Ғ«¬­®Ү°±Ііөµ¶·ё№ғ»әҢңүАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя"
      },
      "tcvn": {
        "type": "_sbcs",
        "chars": "\0ÚỤỪỬỮ\x07\b	\n\v\f\rỨỰỲỶỸÝỴ\x1B !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ÀẢÃÁẠẶẬÈẺẼÉẸỆÌỈĨÍỊÒỎÕÓỌỘỜỞỠỚỢÙỦŨ ĂÂÊÔƠƯĐăâêôơưđẶ̀̀̉̃́àảãáạẲằẳẵắẴẮẦẨẪẤỀặầẩẫấậèỂẻẽéẹềểễếệìỉỄẾỒĩíịòỔỏõóọồổỗốộờởỡớợùỖủũúụừửữứựỳỷỹýỵỐ"
      },
      "georgianacademy": {
        "type": "_sbcs",
        "chars": "‚ƒ„…†‡ˆ‰Š‹Œ‘’“”•–—˜™š›œŸ ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰჱჲჳჴჵჶçèéêëìíîïðñòóôõö÷øùúûüýþÿ"
      },
      "georgianps": {
        "type": "_sbcs",
        "chars": "‚ƒ„…†‡ˆ‰Š‹Œ‘’“”•–—˜™š›œŸ ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿აბგდევზჱთიკლმნჲოპჟრსტჳუფქღყშჩცძწჭხჴჯჰჵæçèéêëìíîïðñòóôõö÷øùúûüýþÿ"
      },
      "pt154": {
        "type": "_sbcs",
        "chars": "ҖҒӮғ„…ҶҮҲүҠӢҢҚҺҸҗ‘’“”•–—ҳҷҡӣңқһҹ ЎўЈӨҘҰ§Ё©Ә«¬ӯ®Ҝ°ұІіҙө¶·ё№ә»јҪҫҝАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя"
      },
      "viscii": {
        "type": "_sbcs",
        "chars": "\0ẲẴẪ\x07\b	\n\v\f\rỶỸ\x1BỴ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ẠẮẰẶẤẦẨẬẼẸẾỀỂỄỆỐỒỔỖỘỢỚỜỞỊỎỌỈỦŨỤỲÕắằặấầẩậẽẹếềểễệốồổỗỠƠộờởịỰỨỪỬơớƯÀÁÂÃẢĂẳẵÈÉÊẺÌÍĨỳĐứÒÓÔạỷừửÙÚỹỵÝỡưàáâãảăữẫèéêẻìíĩỉđựòóôõỏọụùúũủýợỮ"
      },
      "iso646cn": {
        "type": "_sbcs",
        "chars": "\0\x07\b	\n\v\f\r\x1B !\"#¥%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}‾��������������������������������������������������������������������������������������������������������������������������������"
      },
      "iso646jp": {
        "type": "_sbcs",
        "chars": "\0\x07\b	\n\v\f\r\x1B !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[¥]^_`abcdefghijklmnopqrstuvwxyz{|}‾��������������������������������������������������������������������������������������������������������������������������������"
      },
      "hproman8": {
        "type": "_sbcs",
        "chars": " ÀÂÈÊËÎÏ´ˋˆ¨˜ÙÛ₤¯Ýý°ÇçÑñ¡¿¤£¥§ƒ¢âêôûáéóúàèòùäëöüÅîØÆåíøæÄìÖÜÉïßÔÁÃãÐðÍÌÓÒÕõŠšÚŸÿÞþ·µ¶¾—¼½ªº«■»±�"
      },
      "macintosh": {
        "type": "_sbcs",
        "chars": "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄¤‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ�ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ"
      },
      "ascii": {
        "type": "_sbcs",
        "chars": "��������������������������������������������������������������������������������������������������������������������������������"
      },
      "tis620": {
        "type": "_sbcs",
        "chars": "���������������������������������กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู����฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛����"
      }
    };
  }
});

// node_modules/iconv-lite/encodings/dbcs-codec.js
var require_dbcs_codec = __commonJS({
  "node_modules/iconv-lite/encodings/dbcs-codec.js"(exports2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    exports2._dbcs = DBCSCodec;
    var UNASSIGNED = -1;
    var GB18030_CODE = -2;
    var SEQ_START = -10;
    var NODE_START = -1e3;
    var UNASSIGNED_NODE = new Array(256);
    var DEF_CHAR = -1;
    for (i = 0; i < 256; i++) {
      UNASSIGNED_NODE[i] = UNASSIGNED;
    }
    var i;
    function DBCSCodec(codecOptions, iconv) {
      this.encodingName = codecOptions.encodingName;
      if (!codecOptions) {
        throw new Error("DBCS codec is called without the data.");
      }
      if (!codecOptions.table) {
        throw new Error("Encoding '" + this.encodingName + "' has no data.");
      }
      var mappingTable = codecOptions.table();
      this.decodeTables = [];
      this.decodeTables[0] = UNASSIGNED_NODE.slice(0);
      this.decodeTableSeq = [];
      for (var i2 = 0; i2 < mappingTable.length; i2++) {
        this._addDecodeChunk(mappingTable[i2]);
      }
      if (typeof codecOptions.gb18030 === "function") {
        this.gb18030 = codecOptions.gb18030();
        var commonThirdByteNodeIdx = this.decodeTables.length;
        this.decodeTables.push(UNASSIGNED_NODE.slice(0));
        var commonFourthByteNodeIdx = this.decodeTables.length;
        this.decodeTables.push(UNASSIGNED_NODE.slice(0));
        var firstByteNode = this.decodeTables[0];
        for (var i2 = 129; i2 <= 254; i2++) {
          var secondByteNode = this.decodeTables[NODE_START - firstByteNode[i2]];
          for (var j = 48; j <= 57; j++) {
            if (secondByteNode[j] === UNASSIGNED) {
              secondByteNode[j] = NODE_START - commonThirdByteNodeIdx;
            } else if (secondByteNode[j] > NODE_START) {
              throw new Error("gb18030 decode tables conflict at byte 2");
            }
            var thirdByteNode = this.decodeTables[NODE_START - secondByteNode[j]];
            for (var k = 129; k <= 254; k++) {
              if (thirdByteNode[k] === UNASSIGNED) {
                thirdByteNode[k] = NODE_START - commonFourthByteNodeIdx;
              } else if (thirdByteNode[k] === NODE_START - commonFourthByteNodeIdx) {
                continue;
              } else if (thirdByteNode[k] > NODE_START) {
                throw new Error("gb18030 decode tables conflict at byte 3");
              }
              var fourthByteNode = this.decodeTables[NODE_START - thirdByteNode[k]];
              for (var l = 48; l <= 57; l++) {
                if (fourthByteNode[l] === UNASSIGNED) {
                  fourthByteNode[l] = GB18030_CODE;
                }
              }
            }
          }
        }
      }
      this.defaultCharUnicode = iconv.defaultCharUnicode;
      this.encodeTable = [];
      this.encodeTableSeq = [];
      var skipEncodeChars = {};
      if (codecOptions.encodeSkipVals) {
        for (var i2 = 0; i2 < codecOptions.encodeSkipVals.length; i2++) {
          var val = codecOptions.encodeSkipVals[i2];
          if (typeof val === "number") {
            skipEncodeChars[val] = true;
          } else {
            for (var j = val.from; j <= val.to; j++) {
              skipEncodeChars[j] = true;
            }
          }
        }
      }
      this._fillEncodeTable(0, 0, skipEncodeChars);
      if (codecOptions.encodeAdd) {
        for (var uChar in codecOptions.encodeAdd) {
          if (Object.prototype.hasOwnProperty.call(codecOptions.encodeAdd, uChar)) {
            this._setEncodeChar(uChar.charCodeAt(0), codecOptions.encodeAdd[uChar]);
          }
        }
      }
      this.defCharSB = this.encodeTable[0][iconv.defaultCharSingleByte.charCodeAt(0)];
      if (this.defCharSB === UNASSIGNED)
        this.defCharSB = this.encodeTable[0]["?"];
      if (this.defCharSB === UNASSIGNED)
        this.defCharSB = "?".charCodeAt(0);
    }
    DBCSCodec.prototype.encoder = DBCSEncoder;
    DBCSCodec.prototype.decoder = DBCSDecoder;
    DBCSCodec.prototype._getDecodeTrieNode = function(addr) {
      var bytes = [];
      for (; addr > 0; addr >>>= 8) {
        bytes.push(addr & 255);
      }
      if (bytes.length == 0) {
        bytes.push(0);
      }
      var node = this.decodeTables[0];
      for (var i2 = bytes.length - 1; i2 > 0; i2--) {
        var val = node[bytes[i2]];
        if (val == UNASSIGNED) {
          node[bytes[i2]] = NODE_START - this.decodeTables.length;
          this.decodeTables.push(node = UNASSIGNED_NODE.slice(0));
        } else if (val <= NODE_START) {
          node = this.decodeTables[NODE_START - val];
        } else {
          throw new Error("Overwrite byte in " + this.encodingName + ", addr: " + addr.toString(16));
        }
      }
      return node;
    };
    DBCSCodec.prototype._addDecodeChunk = function(chunk) {
      var curAddr = parseInt(chunk[0], 16);
      var writeTable = this._getDecodeTrieNode(curAddr);
      curAddr = curAddr & 255;
      for (var k = 1; k < chunk.length; k++) {
        var part = chunk[k];
        if (typeof part === "string") {
          for (var l = 0; l < part.length; ) {
            var code = part.charCodeAt(l++);
            if (code >= 55296 && code < 56320) {
              var codeTrail = part.charCodeAt(l++);
              if (codeTrail >= 56320 && codeTrail < 57344) {
                writeTable[curAddr++] = 65536 + (code - 55296) * 1024 + (codeTrail - 56320);
              } else {
                throw new Error("Incorrect surrogate pair in " + this.encodingName + " at chunk " + chunk[0]);
              }
            } else if (code > 4080 && code <= 4095) {
              var len = 4095 - code + 2;
              var seq = [];
              for (var m = 0; m < len; m++) {
                seq.push(part.charCodeAt(l++));
              }
              writeTable[curAddr++] = SEQ_START - this.decodeTableSeq.length;
              this.decodeTableSeq.push(seq);
            } else {
              writeTable[curAddr++] = code;
            }
          }
        } else if (typeof part === "number") {
          var charCode = writeTable[curAddr - 1] + 1;
          for (var l = 0; l < part; l++) {
            writeTable[curAddr++] = charCode++;
          }
        } else {
          throw new Error("Incorrect type '" + typeof part + "' given in " + this.encodingName + " at chunk " + chunk[0]);
        }
      }
      if (curAddr > 255) {
        throw new Error("Incorrect chunk in " + this.encodingName + " at addr " + chunk[0] + ": too long" + curAddr);
      }
    };
    DBCSCodec.prototype._getEncodeBucket = function(uCode) {
      var high = uCode >> 8;
      if (this.encodeTable[high] === void 0) {
        this.encodeTable[high] = UNASSIGNED_NODE.slice(0);
      }
      return this.encodeTable[high];
    };
    DBCSCodec.prototype._setEncodeChar = function(uCode, dbcsCode) {
      var bucket = this._getEncodeBucket(uCode);
      var low = uCode & 255;
      if (bucket[low] <= SEQ_START) {
        this.encodeTableSeq[SEQ_START - bucket[low]][DEF_CHAR] = dbcsCode;
      } else if (bucket[low] == UNASSIGNED) {
        bucket[low] = dbcsCode;
      }
    };
    DBCSCodec.prototype._setEncodeSequence = function(seq, dbcsCode) {
      var uCode = seq[0];
      var bucket = this._getEncodeBucket(uCode);
      var low = uCode & 255;
      var node;
      if (bucket[low] <= SEQ_START) {
        node = this.encodeTableSeq[SEQ_START - bucket[low]];
      } else {
        node = {};
        if (bucket[low] !== UNASSIGNED)
          node[DEF_CHAR] = bucket[low];
        bucket[low] = SEQ_START - this.encodeTableSeq.length;
        this.encodeTableSeq.push(node);
      }
      for (var j = 1; j < seq.length - 1; j++) {
        var oldVal = node[uCode];
        if (typeof oldVal === "object") {
          node = oldVal;
        } else {
          node = node[uCode] = {};
          if (oldVal !== void 0) {
            node[DEF_CHAR] = oldVal;
          }
        }
      }
      uCode = seq[seq.length - 1];
      node[uCode] = dbcsCode;
    };
    DBCSCodec.prototype._fillEncodeTable = function(nodeIdx, prefix, skipEncodeChars) {
      var node = this.decodeTables[nodeIdx];
      var hasValues = false;
      var subNodeEmpty = {};
      for (var i2 = 0; i2 < 256; i2++) {
        var uCode = node[i2];
        var mbCode = prefix + i2;
        if (skipEncodeChars[mbCode]) {
          continue;
        }
        if (uCode >= 0) {
          this._setEncodeChar(uCode, mbCode);
          hasValues = true;
        } else if (uCode <= NODE_START) {
          var subNodeIdx = NODE_START - uCode;
          if (!subNodeEmpty[subNodeIdx]) {
            var newPrefix = mbCode << 8 >>> 0;
            if (this._fillEncodeTable(subNodeIdx, newPrefix, skipEncodeChars)) {
              hasValues = true;
            } else {
              subNodeEmpty[subNodeIdx] = true;
            }
          }
        } else if (uCode <= SEQ_START) {
          this._setEncodeSequence(this.decodeTableSeq[SEQ_START - uCode], mbCode);
          hasValues = true;
        }
      }
      return hasValues;
    };
    function DBCSEncoder(options, codec) {
      this.leadSurrogate = -1;
      this.seqObj = void 0;
      this.encodeTable = codec.encodeTable;
      this.encodeTableSeq = codec.encodeTableSeq;
      this.defaultCharSingleByte = codec.defCharSB;
      this.gb18030 = codec.gb18030;
    }
    DBCSEncoder.prototype.write = function(str) {
      var newBuf = Buffer2.alloc(str.length * (this.gb18030 ? 4 : 3));
      var leadSurrogate = this.leadSurrogate;
      var seqObj = this.seqObj;
      var nextChar = -1;
      var i2 = 0;
      var j = 0;
      while (true) {
        if (nextChar === -1) {
          if (i2 == str.length)
            break;
          var uCode = str.charCodeAt(i2++);
        } else {
          var uCode = nextChar;
          nextChar = -1;
        }
        if (uCode >= 55296 && uCode < 57344) {
          if (uCode < 56320) {
            if (leadSurrogate === -1) {
              leadSurrogate = uCode;
              continue;
            } else {
              leadSurrogate = uCode;
              uCode = UNASSIGNED;
            }
          } else {
            if (leadSurrogate !== -1) {
              uCode = 65536 + (leadSurrogate - 55296) * 1024 + (uCode - 56320);
              leadSurrogate = -1;
            } else {
              uCode = UNASSIGNED;
            }
          }
        } else if (leadSurrogate !== -1) {
          nextChar = uCode;
          uCode = UNASSIGNED;
          leadSurrogate = -1;
        }
        var dbcsCode = UNASSIGNED;
        if (seqObj !== void 0 && uCode != UNASSIGNED) {
          var resCode = seqObj[uCode];
          if (typeof resCode === "object") {
            seqObj = resCode;
            continue;
          } else if (typeof resCode === "number") {
            dbcsCode = resCode;
          } else if (resCode == void 0) {
            resCode = seqObj[DEF_CHAR];
            if (resCode !== void 0) {
              dbcsCode = resCode;
              nextChar = uCode;
            } else {
            }
          }
          seqObj = void 0;
        } else if (uCode >= 0) {
          var subtable = this.encodeTable[uCode >> 8];
          if (subtable !== void 0) {
            dbcsCode = subtable[uCode & 255];
          }
          if (dbcsCode <= SEQ_START) {
            seqObj = this.encodeTableSeq[SEQ_START - dbcsCode];
            continue;
          }
          if (dbcsCode == UNASSIGNED && this.gb18030) {
            var idx = findIdx(this.gb18030.uChars, uCode);
            if (idx != -1) {
              var dbcsCode = this.gb18030.gbChars[idx] + (uCode - this.gb18030.uChars[idx]);
              newBuf[j++] = 129 + Math.floor(dbcsCode / 12600);
              dbcsCode = dbcsCode % 12600;
              newBuf[j++] = 48 + Math.floor(dbcsCode / 1260);
              dbcsCode = dbcsCode % 1260;
              newBuf[j++] = 129 + Math.floor(dbcsCode / 10);
              dbcsCode = dbcsCode % 10;
              newBuf[j++] = 48 + dbcsCode;
              continue;
            }
          }
        }
        if (dbcsCode === UNASSIGNED) {
          dbcsCode = this.defaultCharSingleByte;
        }
        if (dbcsCode < 256) {
          newBuf[j++] = dbcsCode;
        } else if (dbcsCode < 65536) {
          newBuf[j++] = dbcsCode >> 8;
          newBuf[j++] = dbcsCode & 255;
        } else if (dbcsCode < 16777216) {
          newBuf[j++] = dbcsCode >> 16;
          newBuf[j++] = dbcsCode >> 8 & 255;
          newBuf[j++] = dbcsCode & 255;
        } else {
          newBuf[j++] = dbcsCode >>> 24;
          newBuf[j++] = dbcsCode >>> 16 & 255;
          newBuf[j++] = dbcsCode >>> 8 & 255;
          newBuf[j++] = dbcsCode & 255;
        }
      }
      this.seqObj = seqObj;
      this.leadSurrogate = leadSurrogate;
      return newBuf.slice(0, j);
    };
    DBCSEncoder.prototype.end = function() {
      if (this.leadSurrogate === -1 && this.seqObj === void 0) {
        return;
      }
      var newBuf = Buffer2.alloc(10);
      var j = 0;
      if (this.seqObj) {
        var dbcsCode = this.seqObj[DEF_CHAR];
        if (dbcsCode !== void 0) {
          if (dbcsCode < 256) {
            newBuf[j++] = dbcsCode;
          } else {
            newBuf[j++] = dbcsCode >> 8;
            newBuf[j++] = dbcsCode & 255;
          }
        } else {
        }
        this.seqObj = void 0;
      }
      if (this.leadSurrogate !== -1) {
        newBuf[j++] = this.defaultCharSingleByte;
        this.leadSurrogate = -1;
      }
      return newBuf.slice(0, j);
    };
    DBCSEncoder.prototype.findIdx = findIdx;
    function DBCSDecoder(options, codec) {
      this.nodeIdx = 0;
      this.prevBytes = [];
      this.decodeTables = codec.decodeTables;
      this.decodeTableSeq = codec.decodeTableSeq;
      this.defaultCharUnicode = codec.defaultCharUnicode;
      this.gb18030 = codec.gb18030;
    }
    DBCSDecoder.prototype.write = function(buf) {
      var newBuf = Buffer2.alloc(buf.length * 2);
      var nodeIdx = this.nodeIdx;
      var prevBytes = this.prevBytes;
      var prevOffset = this.prevBytes.length;
      var seqStart = -this.prevBytes.length;
      var uCode;
      for (var i2 = 0, j = 0; i2 < buf.length; i2++) {
        var curByte = i2 >= 0 ? buf[i2] : prevBytes[i2 + prevOffset];
        var uCode = this.decodeTables[nodeIdx][curByte];
        if (uCode >= 0) {
        } else if (uCode === UNASSIGNED) {
          uCode = this.defaultCharUnicode.charCodeAt(0);
          i2 = seqStart;
        } else if (uCode === GB18030_CODE) {
          if (i2 >= 3) {
            var ptr = (buf[i2 - 3] - 129) * 12600 + (buf[i2 - 2] - 48) * 1260 + (buf[i2 - 1] - 129) * 10 + (curByte - 48);
          } else {
            var ptr = (prevBytes[i2 - 3 + prevOffset] - 129) * 12600 + ((i2 - 2 >= 0 ? buf[i2 - 2] : prevBytes[i2 - 2 + prevOffset]) - 48) * 1260 + ((i2 - 1 >= 0 ? buf[i2 - 1] : prevBytes[i2 - 1 + prevOffset]) - 129) * 10 + (curByte - 48);
          }
          var idx = findIdx(this.gb18030.gbChars, ptr);
          uCode = this.gb18030.uChars[idx] + ptr - this.gb18030.gbChars[idx];
        } else if (uCode <= NODE_START) {
          nodeIdx = NODE_START - uCode;
          continue;
        } else if (uCode <= SEQ_START) {
          var seq = this.decodeTableSeq[SEQ_START - uCode];
          for (var k = 0; k < seq.length - 1; k++) {
            uCode = seq[k];
            newBuf[j++] = uCode & 255;
            newBuf[j++] = uCode >> 8;
          }
          uCode = seq[seq.length - 1];
        } else {
          throw new Error("iconv-lite internal error: invalid decoding table value " + uCode + " at " + nodeIdx + "/" + curByte);
        }
        if (uCode >= 65536) {
          uCode -= 65536;
          var uCodeLead = 55296 | uCode >> 10;
          newBuf[j++] = uCodeLead & 255;
          newBuf[j++] = uCodeLead >> 8;
          uCode = 56320 | uCode & 1023;
        }
        newBuf[j++] = uCode & 255;
        newBuf[j++] = uCode >> 8;
        nodeIdx = 0;
        seqStart = i2 + 1;
      }
      this.nodeIdx = nodeIdx;
      this.prevBytes = seqStart >= 0 ? Array.prototype.slice.call(buf, seqStart) : prevBytes.slice(seqStart + prevOffset).concat(Array.prototype.slice.call(buf));
      return newBuf.slice(0, j).toString("ucs2");
    };
    DBCSDecoder.prototype.end = function() {
      var ret = "";
      while (this.prevBytes.length > 0) {
        ret += this.defaultCharUnicode;
        var bytesArr = this.prevBytes.slice(1);
        this.prevBytes = [];
        this.nodeIdx = 0;
        if (bytesArr.length > 0) {
          ret += this.write(bytesArr);
        }
      }
      this.prevBytes = [];
      this.nodeIdx = 0;
      return ret;
    };
    function findIdx(table, val) {
      if (table[0] > val) {
        return -1;
      }
      var l = 0;
      var r = table.length;
      while (l < r - 1) {
        var mid = l + (r - l + 1 >> 1);
        if (table[mid] <= val) {
          l = mid;
        } else {
          r = mid;
        }
      }
      return l;
    }
  }
});

// node_modules/iconv-lite/encodings/tables/shiftjis.json
var require_shiftjis = __commonJS({
  "node_modules/iconv-lite/encodings/tables/shiftjis.json"(exports2, module2) {
    module2.exports = [
      ["0", "\0", 128],
      ["a1", "｡", 62],
      ["8140", "　、。，．・：；？！゛゜´｀¨＾￣＿ヽヾゝゞ〃仝々〆〇ー―‐／＼～∥｜…‥‘’“”（）〔〕［］｛｝〈", 9, "＋－±×"],
      ["8180", "÷＝≠＜＞≦≧∞∴♂♀°′″℃￥＄￠￡％＃＆＊＠§☆★○●◎◇◆□■△▲▽▼※〒→←↑↓〓"],
      ["81b8", "∈∋⊆⊇⊂⊃∪∩"],
      ["81c8", "∧∨￢⇒⇔∀∃"],
      ["81da", "∠⊥⌒∂∇≡≒≪≫√∽∝∵∫∬"],
      ["81f0", "Å‰♯♭♪†‡¶"],
      ["81fc", "◯"],
      ["824f", "０", 9],
      ["8260", "Ａ", 25],
      ["8281", "ａ", 25],
      ["829f", "ぁ", 82],
      ["8340", "ァ", 62],
      ["8380", "ム", 22],
      ["839f", "Α", 16, "Σ", 6],
      ["83bf", "α", 16, "σ", 6],
      ["8440", "А", 5, "ЁЖ", 25],
      ["8470", "а", 5, "ёж", 7],
      ["8480", "о", 17],
      ["849f", "─│┌┐┘└├┬┤┴┼━┃┏┓┛┗┣┳┫┻╋┠┯┨┷┿┝┰┥┸╂"],
      ["8740", "①", 19, "Ⅰ", 9],
      ["875f", "㍉㌔㌢㍍㌘㌧㌃㌶㍑㍗㌍㌦㌣㌫㍊㌻㎜㎝㎞㎎㎏㏄㎡"],
      ["877e", "㍻"],
      ["8780", "〝〟№㏍℡㊤", 4, "㈱㈲㈹㍾㍽㍼≒≡∫∮∑√⊥∠∟⊿∵∩∪"],
      ["889f", "亜唖娃阿哀愛挨姶逢葵茜穐悪握渥旭葦芦鯵梓圧斡扱宛姐虻飴絢綾鮎或粟袷安庵按暗案闇鞍杏以伊位依偉囲夷委威尉惟意慰易椅為畏異移維緯胃萎衣謂違遺医井亥域育郁磯一壱溢逸稲茨芋鰯允印咽員因姻引飲淫胤蔭"],
      ["8940", "院陰隠韻吋右宇烏羽迂雨卯鵜窺丑碓臼渦嘘唄欝蔚鰻姥厩浦瓜閏噂云運雲荏餌叡営嬰影映曳栄永泳洩瑛盈穎頴英衛詠鋭液疫益駅悦謁越閲榎厭円"],
      ["8980", "園堰奄宴延怨掩援沿演炎焔煙燕猿縁艶苑薗遠鉛鴛塩於汚甥凹央奥往応押旺横欧殴王翁襖鴬鴎黄岡沖荻億屋憶臆桶牡乙俺卸恩温穏音下化仮何伽価佳加可嘉夏嫁家寡科暇果架歌河火珂禍禾稼箇花苛茄荷華菓蝦課嘩貨迦過霞蚊俄峨我牙画臥芽蛾賀雅餓駕介会解回塊壊廻快怪悔恢懐戒拐改"],
      ["8a40", "魁晦械海灰界皆絵芥蟹開階貝凱劾外咳害崖慨概涯碍蓋街該鎧骸浬馨蛙垣柿蛎鈎劃嚇各廓拡撹格核殻獲確穫覚角赫較郭閣隔革学岳楽額顎掛笠樫"],
      ["8a80", "橿梶鰍潟割喝恰括活渇滑葛褐轄且鰹叶椛樺鞄株兜竃蒲釜鎌噛鴨栢茅萱粥刈苅瓦乾侃冠寒刊勘勧巻喚堪姦完官寛干幹患感慣憾換敢柑桓棺款歓汗漢澗潅環甘監看竿管簡緩缶翰肝艦莞観諌貫還鑑間閑関陥韓館舘丸含岸巌玩癌眼岩翫贋雁頑顔願企伎危喜器基奇嬉寄岐希幾忌揮机旗既期棋棄"],
      ["8b40", "機帰毅気汽畿祈季稀紀徽規記貴起軌輝飢騎鬼亀偽儀妓宜戯技擬欺犠疑祇義蟻誼議掬菊鞠吉吃喫桔橘詰砧杵黍却客脚虐逆丘久仇休及吸宮弓急救"],
      ["8b80", "朽求汲泣灸球究窮笈級糾給旧牛去居巨拒拠挙渠虚許距鋸漁禦魚亨享京供侠僑兇競共凶協匡卿叫喬境峡強彊怯恐恭挟教橋況狂狭矯胸脅興蕎郷鏡響饗驚仰凝尭暁業局曲極玉桐粁僅勤均巾錦斤欣欽琴禁禽筋緊芹菌衿襟謹近金吟銀九倶句区狗玖矩苦躯駆駈駒具愚虞喰空偶寓遇隅串櫛釧屑屈"],
      ["8c40", "掘窟沓靴轡窪熊隈粂栗繰桑鍬勲君薫訓群軍郡卦袈祁係傾刑兄啓圭珪型契形径恵慶慧憩掲携敬景桂渓畦稽系経継繋罫茎荊蛍計詣警軽頚鶏芸迎鯨"],
      ["8c80", "劇戟撃激隙桁傑欠決潔穴結血訣月件倹倦健兼券剣喧圏堅嫌建憲懸拳捲検権牽犬献研硯絹県肩見謙賢軒遣鍵険顕験鹸元原厳幻弦減源玄現絃舷言諺限乎個古呼固姑孤己庫弧戸故枯湖狐糊袴股胡菰虎誇跨鈷雇顧鼓五互伍午呉吾娯後御悟梧檎瑚碁語誤護醐乞鯉交佼侯候倖光公功効勾厚口向"],
      ["8d40", "后喉坑垢好孔孝宏工巧巷幸広庚康弘恒慌抗拘控攻昂晃更杭校梗構江洪浩港溝甲皇硬稿糠紅紘絞綱耕考肯肱腔膏航荒行衡講貢購郊酵鉱砿鋼閤降"],
      ["8d80", "項香高鴻剛劫号合壕拷濠豪轟麹克刻告国穀酷鵠黒獄漉腰甑忽惚骨狛込此頃今困坤墾婚恨懇昏昆根梱混痕紺艮魂些佐叉唆嵯左差査沙瑳砂詐鎖裟坐座挫債催再最哉塞妻宰彩才採栽歳済災采犀砕砦祭斎細菜裁載際剤在材罪財冴坂阪堺榊肴咲崎埼碕鷺作削咋搾昨朔柵窄策索錯桜鮭笹匙冊刷"],
      ["8e40", "察拶撮擦札殺薩雑皐鯖捌錆鮫皿晒三傘参山惨撒散桟燦珊産算纂蚕讃賛酸餐斬暫残仕仔伺使刺司史嗣四士始姉姿子屍市師志思指支孜斯施旨枝止"],
      ["8e80", "死氏獅祉私糸紙紫肢脂至視詞詩試誌諮資賜雌飼歯事似侍児字寺慈持時次滋治爾璽痔磁示而耳自蒔辞汐鹿式識鴫竺軸宍雫七叱執失嫉室悉湿漆疾質実蔀篠偲柴芝屡蕊縞舎写射捨赦斜煮社紗者謝車遮蛇邪借勺尺杓灼爵酌釈錫若寂弱惹主取守手朱殊狩珠種腫趣酒首儒受呪寿授樹綬需囚収周"],
      ["8f40", "宗就州修愁拾洲秀秋終繍習臭舟蒐衆襲讐蹴輯週酋酬集醜什住充十従戎柔汁渋獣縦重銃叔夙宿淑祝縮粛塾熟出術述俊峻春瞬竣舜駿准循旬楯殉淳"],
      ["8f80", "準潤盾純巡遵醇順処初所暑曙渚庶緒署書薯藷諸助叙女序徐恕鋤除傷償勝匠升召哨商唱嘗奨妾娼宵将小少尚庄床廠彰承抄招掌捷昇昌昭晶松梢樟樵沼消渉湘焼焦照症省硝礁祥称章笑粧紹肖菖蒋蕉衝裳訟証詔詳象賞醤鉦鍾鐘障鞘上丈丞乗冗剰城場壌嬢常情擾条杖浄状畳穣蒸譲醸錠嘱埴飾"],
      ["9040", "拭植殖燭織職色触食蝕辱尻伸信侵唇娠寝審心慎振新晋森榛浸深申疹真神秦紳臣芯薪親診身辛進針震人仁刃塵壬尋甚尽腎訊迅陣靭笥諏須酢図厨"],
      ["9080", "逗吹垂帥推水炊睡粋翠衰遂酔錐錘随瑞髄崇嵩数枢趨雛据杉椙菅頗雀裾澄摺寸世瀬畝是凄制勢姓征性成政整星晴棲栖正清牲生盛精聖声製西誠誓請逝醒青静斉税脆隻席惜戚斥昔析石積籍績脊責赤跡蹟碩切拙接摂折設窃節説雪絶舌蝉仙先千占宣専尖川戦扇撰栓栴泉浅洗染潜煎煽旋穿箭線"],
      ["9140", "繊羨腺舛船薦詮賎践選遷銭銑閃鮮前善漸然全禅繕膳糎噌塑岨措曾曽楚狙疏疎礎祖租粗素組蘇訴阻遡鼠僧創双叢倉喪壮奏爽宋層匝惣想捜掃挿掻"],
      ["9180", "操早曹巣槍槽漕燥争痩相窓糟総綜聡草荘葬蒼藻装走送遭鎗霜騒像増憎臓蔵贈造促側則即息捉束測足速俗属賊族続卒袖其揃存孫尊損村遜他多太汰詑唾堕妥惰打柁舵楕陀駄騨体堆対耐岱帯待怠態戴替泰滞胎腿苔袋貸退逮隊黛鯛代台大第醍題鷹滝瀧卓啄宅托択拓沢濯琢託鐸濁諾茸凧蛸只"],
      ["9240", "叩但達辰奪脱巽竪辿棚谷狸鱈樽誰丹単嘆坦担探旦歎淡湛炭短端箪綻耽胆蛋誕鍛団壇弾断暖檀段男談値知地弛恥智池痴稚置致蜘遅馳築畜竹筑蓄"],
      ["9280", "逐秩窒茶嫡着中仲宙忠抽昼柱注虫衷註酎鋳駐樗瀦猪苧著貯丁兆凋喋寵帖帳庁弔張彫徴懲挑暢朝潮牒町眺聴脹腸蝶調諜超跳銚長頂鳥勅捗直朕沈珍賃鎮陳津墜椎槌追鎚痛通塚栂掴槻佃漬柘辻蔦綴鍔椿潰坪壷嬬紬爪吊釣鶴亭低停偵剃貞呈堤定帝底庭廷弟悌抵挺提梯汀碇禎程締艇訂諦蹄逓"],
      ["9340", "邸鄭釘鼎泥摘擢敵滴的笛適鏑溺哲徹撤轍迭鉄典填天展店添纏甜貼転顛点伝殿澱田電兎吐堵塗妬屠徒斗杜渡登菟賭途都鍍砥砺努度土奴怒倒党冬"],
      ["9380", "凍刀唐塔塘套宕島嶋悼投搭東桃梼棟盗淘湯涛灯燈当痘祷等答筒糖統到董蕩藤討謄豆踏逃透鐙陶頭騰闘働動同堂導憧撞洞瞳童胴萄道銅峠鴇匿得徳涜特督禿篤毒独読栃橡凸突椴届鳶苫寅酉瀞噸屯惇敦沌豚遁頓呑曇鈍奈那内乍凪薙謎灘捺鍋楢馴縄畷南楠軟難汝二尼弐迩匂賑肉虹廿日乳入"],
      ["9440", "如尿韮任妊忍認濡禰祢寧葱猫熱年念捻撚燃粘乃廼之埜嚢悩濃納能脳膿農覗蚤巴把播覇杷波派琶破婆罵芭馬俳廃拝排敗杯盃牌背肺輩配倍培媒梅"],
      ["9480", "楳煤狽買売賠陪這蝿秤矧萩伯剥博拍柏泊白箔粕舶薄迫曝漠爆縛莫駁麦函箱硲箸肇筈櫨幡肌畑畠八鉢溌発醗髪伐罰抜筏閥鳩噺塙蛤隼伴判半反叛帆搬斑板氾汎版犯班畔繁般藩販範釆煩頒飯挽晩番盤磐蕃蛮匪卑否妃庇彼悲扉批披斐比泌疲皮碑秘緋罷肥被誹費避非飛樋簸備尾微枇毘琵眉美"],
      ["9540", "鼻柊稗匹疋髭彦膝菱肘弼必畢筆逼桧姫媛紐百謬俵彪標氷漂瓢票表評豹廟描病秒苗錨鋲蒜蛭鰭品彬斌浜瀕貧賓頻敏瓶不付埠夫婦富冨布府怖扶敷"],
      ["9580", "斧普浮父符腐膚芙譜負賦赴阜附侮撫武舞葡蕪部封楓風葺蕗伏副復幅服福腹複覆淵弗払沸仏物鮒分吻噴墳憤扮焚奮粉糞紛雰文聞丙併兵塀幣平弊柄並蔽閉陛米頁僻壁癖碧別瞥蔑箆偏変片篇編辺返遍便勉娩弁鞭保舗鋪圃捕歩甫補輔穂募墓慕戊暮母簿菩倣俸包呆報奉宝峰峯崩庖抱捧放方朋"],
      ["9640", "法泡烹砲縫胞芳萌蓬蜂褒訪豊邦鋒飽鳳鵬乏亡傍剖坊妨帽忘忙房暴望某棒冒紡肪膨謀貌貿鉾防吠頬北僕卜墨撲朴牧睦穆釦勃没殆堀幌奔本翻凡盆"],
      ["9680", "摩磨魔麻埋妹昧枚毎哩槙幕膜枕鮪柾鱒桝亦俣又抹末沫迄侭繭麿万慢満漫蔓味未魅巳箕岬密蜜湊蓑稔脈妙粍民眠務夢無牟矛霧鵡椋婿娘冥名命明盟迷銘鳴姪牝滅免棉綿緬面麺摸模茂妄孟毛猛盲網耗蒙儲木黙目杢勿餅尤戻籾貰問悶紋門匁也冶夜爺耶野弥矢厄役約薬訳躍靖柳薮鑓愉愈油癒"],
      ["9740", "諭輸唯佑優勇友宥幽悠憂揖有柚湧涌猶猷由祐裕誘遊邑郵雄融夕予余与誉輿預傭幼妖容庸揚揺擁曜楊様洋溶熔用窯羊耀葉蓉要謡踊遥陽養慾抑欲"],
      ["9780", "沃浴翌翼淀羅螺裸来莱頼雷洛絡落酪乱卵嵐欄濫藍蘭覧利吏履李梨理璃痢裏裡里離陸律率立葎掠略劉流溜琉留硫粒隆竜龍侶慮旅虜了亮僚両凌寮料梁涼猟療瞭稜糧良諒遼量陵領力緑倫厘林淋燐琳臨輪隣鱗麟瑠塁涙累類令伶例冷励嶺怜玲礼苓鈴隷零霊麗齢暦歴列劣烈裂廉恋憐漣煉簾練聯"],
      ["9840", "蓮連錬呂魯櫓炉賂路露労婁廊弄朗楼榔浪漏牢狼篭老聾蝋郎六麓禄肋録論倭和話歪賄脇惑枠鷲亙亘鰐詫藁蕨椀湾碗腕"],
      ["989f", "弌丐丕个丱丶丼丿乂乖乘亂亅豫亊舒弍于亞亟亠亢亰亳亶从仍仄仆仂仗仞仭仟价伉佚估佛佝佗佇佶侈侏侘佻佩佰侑佯來侖儘俔俟俎俘俛俑俚俐俤俥倚倨倔倪倥倅伜俶倡倩倬俾俯們倆偃假會偕偐偈做偖偬偸傀傚傅傴傲"],
      ["9940", "僉僊傳僂僖僞僥僭僣僮價僵儉儁儂儖儕儔儚儡儺儷儼儻儿兀兒兌兔兢竸兩兪兮冀冂囘册冉冏冑冓冕冖冤冦冢冩冪冫决冱冲冰况冽凅凉凛几處凩凭"],
      ["9980", "凰凵凾刄刋刔刎刧刪刮刳刹剏剄剋剌剞剔剪剴剩剳剿剽劍劔劒剱劈劑辨辧劬劭劼劵勁勍勗勞勣勦飭勠勳勵勸勹匆匈甸匍匐匏匕匚匣匯匱匳匸區卆卅丗卉卍凖卞卩卮夘卻卷厂厖厠厦厥厮厰厶參簒雙叟曼燮叮叨叭叺吁吽呀听吭吼吮吶吩吝呎咏呵咎呟呱呷呰咒呻咀呶咄咐咆哇咢咸咥咬哄哈咨"],
      ["9a40", "咫哂咤咾咼哘哥哦唏唔哽哮哭哺哢唹啀啣啌售啜啅啖啗唸唳啝喙喀咯喊喟啻啾喘喞單啼喃喩喇喨嗚嗅嗟嗄嗜嗤嗔嘔嗷嘖嗾嗽嘛嗹噎噐營嘴嘶嘲嘸"],
      ["9a80", "噫噤嘯噬噪嚆嚀嚊嚠嚔嚏嚥嚮嚶嚴囂嚼囁囃囀囈囎囑囓囗囮囹圀囿圄圉圈國圍圓團圖嗇圜圦圷圸坎圻址坏坩埀垈坡坿垉垓垠垳垤垪垰埃埆埔埒埓堊埖埣堋堙堝塲堡塢塋塰毀塒堽塹墅墹墟墫墺壞墻墸墮壅壓壑壗壙壘壥壜壤壟壯壺壹壻壼壽夂夊夐夛梦夥夬夭夲夸夾竒奕奐奎奚奘奢奠奧奬奩"],
      ["9b40", "奸妁妝佞侫妣妲姆姨姜妍姙姚娥娟娑娜娉娚婀婬婉娵娶婢婪媚媼媾嫋嫂媽嫣嫗嫦嫩嫖嫺嫻嬌嬋嬖嬲嫐嬪嬶嬾孃孅孀孑孕孚孛孥孩孰孳孵學斈孺宀"],
      ["9b80", "它宦宸寃寇寉寔寐寤實寢寞寥寫寰寶寳尅將專對尓尠尢尨尸尹屁屆屎屓屐屏孱屬屮乢屶屹岌岑岔妛岫岻岶岼岷峅岾峇峙峩峽峺峭嶌峪崋崕崗嵜崟崛崑崔崢崚崙崘嵌嵒嵎嵋嵬嵳嵶嶇嶄嶂嶢嶝嶬嶮嶽嶐嶷嶼巉巍巓巒巖巛巫已巵帋帚帙帑帛帶帷幄幃幀幎幗幔幟幢幤幇幵并幺麼广庠廁廂廈廐廏"],
      ["9c40", "廖廣廝廚廛廢廡廨廩廬廱廳廰廴廸廾弃弉彝彜弋弑弖弩弭弸彁彈彌彎弯彑彖彗彙彡彭彳彷徃徂彿徊很徑徇從徙徘徠徨徭徼忖忻忤忸忱忝悳忿怡恠"],
      ["9c80", "怙怐怩怎怱怛怕怫怦怏怺恚恁恪恷恟恊恆恍恣恃恤恂恬恫恙悁悍惧悃悚悄悛悖悗悒悧悋惡悸惠惓悴忰悽惆悵惘慍愕愆惶惷愀惴惺愃愡惻惱愍愎慇愾愨愧慊愿愼愬愴愽慂慄慳慷慘慙慚慫慴慯慥慱慟慝慓慵憙憖憇憬憔憚憊憑憫憮懌懊應懷懈懃懆憺懋罹懍懦懣懶懺懴懿懽懼懾戀戈戉戍戌戔戛"],
      ["9d40", "戞戡截戮戰戲戳扁扎扞扣扛扠扨扼抂抉找抒抓抖拔抃抔拗拑抻拏拿拆擔拈拜拌拊拂拇抛拉挌拮拱挧挂挈拯拵捐挾捍搜捏掖掎掀掫捶掣掏掉掟掵捫"],
      ["9d80", "捩掾揩揀揆揣揉插揶揄搖搴搆搓搦搶攝搗搨搏摧摯摶摎攪撕撓撥撩撈撼據擒擅擇撻擘擂擱擧舉擠擡抬擣擯攬擶擴擲擺攀擽攘攜攅攤攣攫攴攵攷收攸畋效敖敕敍敘敞敝敲數斂斃變斛斟斫斷旃旆旁旄旌旒旛旙无旡旱杲昊昃旻杳昵昶昴昜晏晄晉晁晞晝晤晧晨晟晢晰暃暈暎暉暄暘暝曁暹曉暾暼"],
      ["9e40", "曄暸曖曚曠昿曦曩曰曵曷朏朖朞朦朧霸朮朿朶杁朸朷杆杞杠杙杣杤枉杰枩杼杪枌枋枦枡枅枷柯枴柬枳柩枸柤柞柝柢柮枹柎柆柧檜栞框栩桀桍栲桎"],
      ["9e80", "梳栫桙档桷桿梟梏梭梔條梛梃檮梹桴梵梠梺椏梍桾椁棊椈棘椢椦棡椌棍棔棧棕椶椒椄棗棣椥棹棠棯椨椪椚椣椡棆楹楷楜楸楫楔楾楮椹楴椽楙椰楡楞楝榁楪榲榮槐榿槁槓榾槎寨槊槝榻槃榧樮榑榠榜榕榴槞槨樂樛槿權槹槲槧樅榱樞槭樔槫樊樒櫁樣樓橄樌橲樶橸橇橢橙橦橈樸樢檐檍檠檄檢檣"],
      ["9f40", "檗蘗檻櫃櫂檸檳檬櫞櫑櫟檪櫚櫪櫻欅蘖櫺欒欖鬱欟欸欷盜欹飮歇歃歉歐歙歔歛歟歡歸歹歿殀殄殃殍殘殕殞殤殪殫殯殲殱殳殷殼毆毋毓毟毬毫毳毯"],
      ["9f80", "麾氈氓气氛氤氣汞汕汢汪沂沍沚沁沛汾汨汳沒沐泄泱泓沽泗泅泝沮沱沾沺泛泯泙泪洟衍洶洫洽洸洙洵洳洒洌浣涓浤浚浹浙涎涕濤涅淹渕渊涵淇淦涸淆淬淞淌淨淒淅淺淙淤淕淪淮渭湮渮渙湲湟渾渣湫渫湶湍渟湃渺湎渤滿渝游溂溪溘滉溷滓溽溯滄溲滔滕溏溥滂溟潁漑灌滬滸滾漿滲漱滯漲滌"],
      ["e040", "漾漓滷澆潺潸澁澀潯潛濳潭澂潼潘澎澑濂潦澳澣澡澤澹濆澪濟濕濬濔濘濱濮濛瀉瀋濺瀑瀁瀏濾瀛瀚潴瀝瀘瀟瀰瀾瀲灑灣炙炒炯烱炬炸炳炮烟烋烝"],
      ["e080", "烙焉烽焜焙煥煕熈煦煢煌煖煬熏燻熄熕熨熬燗熹熾燒燉燔燎燠燬燧燵燼燹燿爍爐爛爨爭爬爰爲爻爼爿牀牆牋牘牴牾犂犁犇犒犖犢犧犹犲狃狆狄狎狒狢狠狡狹狷倏猗猊猜猖猝猴猯猩猥猾獎獏默獗獪獨獰獸獵獻獺珈玳珎玻珀珥珮珞璢琅瑯琥珸琲琺瑕琿瑟瑙瑁瑜瑩瑰瑣瑪瑶瑾璋璞璧瓊瓏瓔珱"],
      ["e140", "瓠瓣瓧瓩瓮瓲瓰瓱瓸瓷甄甃甅甌甎甍甕甓甞甦甬甼畄畍畊畉畛畆畚畩畤畧畫畭畸當疆疇畴疊疉疂疔疚疝疥疣痂疳痃疵疽疸疼疱痍痊痒痙痣痞痾痿"],
      ["e180", "痼瘁痰痺痲痳瘋瘍瘉瘟瘧瘠瘡瘢瘤瘴瘰瘻癇癈癆癜癘癡癢癨癩癪癧癬癰癲癶癸發皀皃皈皋皎皖皓皙皚皰皴皸皹皺盂盍盖盒盞盡盥盧盪蘯盻眈眇眄眩眤眞眥眦眛眷眸睇睚睨睫睛睥睿睾睹瞎瞋瞑瞠瞞瞰瞶瞹瞿瞼瞽瞻矇矍矗矚矜矣矮矼砌砒礦砠礪硅碎硴碆硼碚碌碣碵碪碯磑磆磋磔碾碼磅磊磬"],
      ["e240", "磧磚磽磴礇礒礑礙礬礫祀祠祗祟祚祕祓祺祿禊禝禧齋禪禮禳禹禺秉秕秧秬秡秣稈稍稘稙稠稟禀稱稻稾稷穃穗穉穡穢穩龝穰穹穽窈窗窕窘窖窩竈窰"],
      ["e280", "窶竅竄窿邃竇竊竍竏竕竓站竚竝竡竢竦竭竰笂笏笊笆笳笘笙笞笵笨笶筐筺笄筍笋筌筅筵筥筴筧筰筱筬筮箝箘箟箍箜箚箋箒箏筝箙篋篁篌篏箴篆篝篩簑簔篦篥籠簀簇簓篳篷簗簍篶簣簧簪簟簷簫簽籌籃籔籏籀籐籘籟籤籖籥籬籵粃粐粤粭粢粫粡粨粳粲粱粮粹粽糀糅糂糘糒糜糢鬻糯糲糴糶糺紆"],
      ["e340", "紂紜紕紊絅絋紮紲紿紵絆絳絖絎絲絨絮絏絣經綉絛綏絽綛綺綮綣綵緇綽綫總綢綯緜綸綟綰緘緝緤緞緻緲緡縅縊縣縡縒縱縟縉縋縢繆繦縻縵縹繃縷"],
      ["e380", "縲縺繧繝繖繞繙繚繹繪繩繼繻纃緕繽辮繿纈纉續纒纐纓纔纖纎纛纜缸缺罅罌罍罎罐网罕罔罘罟罠罨罩罧罸羂羆羃羈羇羌羔羞羝羚羣羯羲羹羮羶羸譱翅翆翊翕翔翡翦翩翳翹飜耆耄耋耒耘耙耜耡耨耿耻聊聆聒聘聚聟聢聨聳聲聰聶聹聽聿肄肆肅肛肓肚肭冐肬胛胥胙胝胄胚胖脉胯胱脛脩脣脯腋"],
      ["e440", "隋腆脾腓腑胼腱腮腥腦腴膃膈膊膀膂膠膕膤膣腟膓膩膰膵膾膸膽臀臂膺臉臍臑臙臘臈臚臟臠臧臺臻臾舁舂舅與舊舍舐舖舩舫舸舳艀艙艘艝艚艟艤"],
      ["e480", "艢艨艪艫舮艱艷艸艾芍芒芫芟芻芬苡苣苟苒苴苳苺莓范苻苹苞茆苜茉苙茵茴茖茲茱荀茹荐荅茯茫茗茘莅莚莪莟莢莖茣莎莇莊荼莵荳荵莠莉莨菴萓菫菎菽萃菘萋菁菷萇菠菲萍萢萠莽萸蔆菻葭萪萼蕚蒄葷葫蒭葮蒂葩葆萬葯葹萵蓊葢蒹蒿蒟蓙蓍蒻蓚蓐蓁蓆蓖蒡蔡蓿蓴蔗蔘蔬蔟蔕蔔蓼蕀蕣蕘蕈"],
      ["e540", "蕁蘂蕋蕕薀薤薈薑薊薨蕭薔薛藪薇薜蕷蕾薐藉薺藏薹藐藕藝藥藜藹蘊蘓蘋藾藺蘆蘢蘚蘰蘿虍乕虔號虧虱蚓蚣蚩蚪蚋蚌蚶蚯蛄蛆蚰蛉蠣蚫蛔蛞蛩蛬"],
      ["e580", "蛟蛛蛯蜒蜆蜈蜀蜃蛻蜑蜉蜍蛹蜊蜴蜿蜷蜻蜥蜩蜚蝠蝟蝸蝌蝎蝴蝗蝨蝮蝙蝓蝣蝪蠅螢螟螂螯蟋螽蟀蟐雖螫蟄螳蟇蟆螻蟯蟲蟠蠏蠍蟾蟶蟷蠎蟒蠑蠖蠕蠢蠡蠱蠶蠹蠧蠻衄衂衒衙衞衢衫袁衾袞衵衽袵衲袂袗袒袮袙袢袍袤袰袿袱裃裄裔裘裙裝裹褂裼裴裨裲褄褌褊褓襃褞褥褪褫襁襄褻褶褸襌褝襠襞"],
      ["e640", "襦襤襭襪襯襴襷襾覃覈覊覓覘覡覩覦覬覯覲覺覽覿觀觚觜觝觧觴觸訃訖訐訌訛訝訥訶詁詛詒詆詈詼詭詬詢誅誂誄誨誡誑誥誦誚誣諄諍諂諚諫諳諧"],
      ["e680", "諤諱謔諠諢諷諞諛謌謇謚諡謖謐謗謠謳鞫謦謫謾謨譁譌譏譎證譖譛譚譫譟譬譯譴譽讀讌讎讒讓讖讙讚谺豁谿豈豌豎豐豕豢豬豸豺貂貉貅貊貍貎貔豼貘戝貭貪貽貲貳貮貶賈賁賤賣賚賽賺賻贄贅贊贇贏贍贐齎贓賍贔贖赧赭赱赳趁趙跂趾趺跏跚跖跌跛跋跪跫跟跣跼踈踉跿踝踞踐踟蹂踵踰踴蹊"],
      ["e740", "蹇蹉蹌蹐蹈蹙蹤蹠踪蹣蹕蹶蹲蹼躁躇躅躄躋躊躓躑躔躙躪躡躬躰軆躱躾軅軈軋軛軣軼軻軫軾輊輅輕輒輙輓輜輟輛輌輦輳輻輹轅轂輾轌轉轆轎轗轜"],
      ["e780", "轢轣轤辜辟辣辭辯辷迚迥迢迪迯邇迴逅迹迺逑逕逡逍逞逖逋逧逶逵逹迸遏遐遑遒逎遉逾遖遘遞遨遯遶隨遲邂遽邁邀邊邉邏邨邯邱邵郢郤扈郛鄂鄒鄙鄲鄰酊酖酘酣酥酩酳酲醋醉醂醢醫醯醪醵醴醺釀釁釉釋釐釖釟釡釛釼釵釶鈞釿鈔鈬鈕鈑鉞鉗鉅鉉鉤鉈銕鈿鉋鉐銜銖銓銛鉚鋏銹銷鋩錏鋺鍄錮"],
      ["e840", "錙錢錚錣錺錵錻鍜鍠鍼鍮鍖鎰鎬鎭鎔鎹鏖鏗鏨鏥鏘鏃鏝鏐鏈鏤鐚鐔鐓鐃鐇鐐鐶鐫鐵鐡鐺鑁鑒鑄鑛鑠鑢鑞鑪鈩鑰鑵鑷鑽鑚鑼鑾钁鑿閂閇閊閔閖閘閙"],
      ["e880", "閠閨閧閭閼閻閹閾闊濶闃闍闌闕闔闖關闡闥闢阡阨阮阯陂陌陏陋陷陜陞陝陟陦陲陬隍隘隕隗險隧隱隲隰隴隶隸隹雎雋雉雍襍雜霍雕雹霄霆霈霓霎霑霏霖霙霤霪霰霹霽霾靄靆靈靂靉靜靠靤靦靨勒靫靱靹鞅靼鞁靺鞆鞋鞏鞐鞜鞨鞦鞣鞳鞴韃韆韈韋韜韭齏韲竟韶韵頏頌頸頤頡頷頽顆顏顋顫顯顰"],
      ["e940", "顱顴顳颪颯颱颶飄飃飆飩飫餃餉餒餔餘餡餝餞餤餠餬餮餽餾饂饉饅饐饋饑饒饌饕馗馘馥馭馮馼駟駛駝駘駑駭駮駱駲駻駸騁騏騅駢騙騫騷驅驂驀驃"],
      ["e980", "騾驕驍驛驗驟驢驥驤驩驫驪骭骰骼髀髏髑髓體髞髟髢髣髦髯髫髮髴髱髷髻鬆鬘鬚鬟鬢鬣鬥鬧鬨鬩鬪鬮鬯鬲魄魃魏魍魎魑魘魴鮓鮃鮑鮖鮗鮟鮠鮨鮴鯀鯊鮹鯆鯏鯑鯒鯣鯢鯤鯔鯡鰺鯲鯱鯰鰕鰔鰉鰓鰌鰆鰈鰒鰊鰄鰮鰛鰥鰤鰡鰰鱇鰲鱆鰾鱚鱠鱧鱶鱸鳧鳬鳰鴉鴈鳫鴃鴆鴪鴦鶯鴣鴟鵄鴕鴒鵁鴿鴾鵆鵈"],
      ["ea40", "鵝鵞鵤鵑鵐鵙鵲鶉鶇鶫鵯鵺鶚鶤鶩鶲鷄鷁鶻鶸鶺鷆鷏鷂鷙鷓鷸鷦鷭鷯鷽鸚鸛鸞鹵鹹鹽麁麈麋麌麒麕麑麝麥麩麸麪麭靡黌黎黏黐黔黜點黝黠黥黨黯"],
      ["ea80", "黴黶黷黹黻黼黽鼇鼈皷鼕鼡鼬鼾齊齒齔齣齟齠齡齦齧齬齪齷齲齶龕龜龠堯槇遙瑤凜熙"],
      ["ed40", "纊褜鍈銈蓜俉炻昱棈鋹曻彅丨仡仼伀伃伹佖侒侊侚侔俍偀倢俿倞偆偰偂傔僴僘兊兤冝冾凬刕劜劦勀勛匀匇匤卲厓厲叝﨎咜咊咩哿喆坙坥垬埈埇﨏"],
      ["ed80", "塚增墲夋奓奛奝奣妤妺孖寀甯寘寬尞岦岺峵崧嵓﨑嵂嵭嶸嶹巐弡弴彧德忞恝悅悊惞惕愠惲愑愷愰憘戓抦揵摠撝擎敎昀昕昻昉昮昞昤晥晗晙晴晳暙暠暲暿曺朎朗杦枻桒柀栁桄棏﨓楨﨔榘槢樰橫橆橳橾櫢櫤毖氿汜沆汯泚洄涇浯涖涬淏淸淲淼渹湜渧渼溿澈澵濵瀅瀇瀨炅炫焏焄煜煆煇凞燁燾犱"],
      ["ee40", "犾猤猪獷玽珉珖珣珒琇珵琦琪琩琮瑢璉璟甁畯皂皜皞皛皦益睆劯砡硎硤硺礰礼神祥禔福禛竑竧靖竫箞精絈絜綷綠緖繒罇羡羽茁荢荿菇菶葈蒴蕓蕙"],
      ["ee80", "蕫﨟薰蘒﨡蠇裵訒訷詹誧誾諟諸諶譓譿賰賴贒赶﨣軏﨤逸遧郞都鄕鄧釚釗釞釭釮釤釥鈆鈐鈊鈺鉀鈼鉎鉙鉑鈹鉧銧鉷鉸鋧鋗鋙鋐﨧鋕鋠鋓錥錡鋻﨨錞鋿錝錂鍰鍗鎤鏆鏞鏸鐱鑅鑈閒隆﨩隝隯霳霻靃靍靏靑靕顗顥飯飼餧館馞驎髙髜魵魲鮏鮱鮻鰀鵰鵫鶴鸙黑"],
      ["eeef", "ⅰ", 9, "￢￤＇＂"],
      ["f040", "", 62],
      ["f080", "", 124],
      ["f140", "", 62],
      ["f180", "", 124],
      ["f240", "", 62],
      ["f280", "", 124],
      ["f340", "", 62],
      ["f380", "", 124],
      ["f440", "", 62],
      ["f480", "", 124],
      ["f540", "", 62],
      ["f580", "", 124],
      ["f640", "", 62],
      ["f680", "", 124],
      ["f740", "", 62],
      ["f780", "", 124],
      ["f840", "", 62],
      ["f880", "", 124],
      ["f940", ""],
      ["fa40", "ⅰ", 9, "Ⅰ", 9, "￢￤＇＂㈱№℡∵纊褜鍈銈蓜俉炻昱棈鋹曻彅丨仡仼伀伃伹佖侒侊侚侔俍偀倢俿倞偆偰偂傔僴僘兊"],
      ["fa80", "兤冝冾凬刕劜劦勀勛匀匇匤卲厓厲叝﨎咜咊咩哿喆坙坥垬埈埇﨏塚增墲夋奓奛奝奣妤妺孖寀甯寘寬尞岦岺峵崧嵓﨑嵂嵭嶸嶹巐弡弴彧德忞恝悅悊惞惕愠惲愑愷愰憘戓抦揵摠撝擎敎昀昕昻昉昮昞昤晥晗晙晴晳暙暠暲暿曺朎朗杦枻桒柀栁桄棏﨓楨﨔榘槢樰橫橆橳橾櫢櫤毖氿汜沆汯泚洄涇浯"],
      ["fb40", "涖涬淏淸淲淼渹湜渧渼溿澈澵濵瀅瀇瀨炅炫焏焄煜煆煇凞燁燾犱犾猤猪獷玽珉珖珣珒琇珵琦琪琩琮瑢璉璟甁畯皂皜皞皛皦益睆劯砡硎硤硺礰礼神"],
      ["fb80", "祥禔福禛竑竧靖竫箞精絈絜綷綠緖繒罇羡羽茁荢荿菇菶葈蒴蕓蕙蕫﨟薰蘒﨡蠇裵訒訷詹誧誾諟諸諶譓譿賰賴贒赶﨣軏﨤逸遧郞都鄕鄧釚釗釞釭釮釤釥鈆鈐鈊鈺鉀鈼鉎鉙鉑鈹鉧銧鉷鉸鋧鋗鋙鋐﨧鋕鋠鋓錥錡鋻﨨錞鋿錝錂鍰鍗鎤鏆鏞鏸鐱鑅鑈閒隆﨩隝隯霳霻靃靍靏靑靕顗顥飯飼餧館馞驎髙"],
      ["fc40", "髜魵魲鮏鮱鮻鰀鵰鵫鶴鸙黑"]
    ];
  }
});

// node_modules/iconv-lite/encodings/tables/eucjp.json
var require_eucjp = __commonJS({
  "node_modules/iconv-lite/encodings/tables/eucjp.json"(exports2, module2) {
    module2.exports = [
      ["0", "\0", 127],
      ["8ea1", "｡", 62],
      ["a1a1", "　、。，．・：；？！゛゜´｀¨＾￣＿ヽヾゝゞ〃仝々〆〇ー―‐／＼～∥｜…‥‘’“”（）〔〕［］｛｝〈", 9, "＋－±×÷＝≠＜＞≦≧∞∴♂♀°′″℃￥＄￠￡％＃＆＊＠§☆★○●◎◇"],
      ["a2a1", "◆□■△▲▽▼※〒→←↑↓〓"],
      ["a2ba", "∈∋⊆⊇⊂⊃∪∩"],
      ["a2ca", "∧∨￢⇒⇔∀∃"],
      ["a2dc", "∠⊥⌒∂∇≡≒≪≫√∽∝∵∫∬"],
      ["a2f2", "Å‰♯♭♪†‡¶"],
      ["a2fe", "◯"],
      ["a3b0", "０", 9],
      ["a3c1", "Ａ", 25],
      ["a3e1", "ａ", 25],
      ["a4a1", "ぁ", 82],
      ["a5a1", "ァ", 85],
      ["a6a1", "Α", 16, "Σ", 6],
      ["a6c1", "α", 16, "σ", 6],
      ["a7a1", "А", 5, "ЁЖ", 25],
      ["a7d1", "а", 5, "ёж", 25],
      ["a8a1", "─│┌┐┘└├┬┤┴┼━┃┏┓┛┗┣┳┫┻╋┠┯┨┷┿┝┰┥┸╂"],
      ["ada1", "①", 19, "Ⅰ", 9],
      ["adc0", "㍉㌔㌢㍍㌘㌧㌃㌶㍑㍗㌍㌦㌣㌫㍊㌻㎜㎝㎞㎎㎏㏄㎡"],
      ["addf", "㍻〝〟№㏍℡㊤", 4, "㈱㈲㈹㍾㍽㍼≒≡∫∮∑√⊥∠∟⊿∵∩∪"],
      ["b0a1", "亜唖娃阿哀愛挨姶逢葵茜穐悪握渥旭葦芦鯵梓圧斡扱宛姐虻飴絢綾鮎或粟袷安庵按暗案闇鞍杏以伊位依偉囲夷委威尉惟意慰易椅為畏異移維緯胃萎衣謂違遺医井亥域育郁磯一壱溢逸稲茨芋鰯允印咽員因姻引飲淫胤蔭"],
      ["b1a1", "院陰隠韻吋右宇烏羽迂雨卯鵜窺丑碓臼渦嘘唄欝蔚鰻姥厩浦瓜閏噂云運雲荏餌叡営嬰影映曳栄永泳洩瑛盈穎頴英衛詠鋭液疫益駅悦謁越閲榎厭円園堰奄宴延怨掩援沿演炎焔煙燕猿縁艶苑薗遠鉛鴛塩於汚甥凹央奥往応"],
      ["b2a1", "押旺横欧殴王翁襖鴬鴎黄岡沖荻億屋憶臆桶牡乙俺卸恩温穏音下化仮何伽価佳加可嘉夏嫁家寡科暇果架歌河火珂禍禾稼箇花苛茄荷華菓蝦課嘩貨迦過霞蚊俄峨我牙画臥芽蛾賀雅餓駕介会解回塊壊廻快怪悔恢懐戒拐改"],
      ["b3a1", "魁晦械海灰界皆絵芥蟹開階貝凱劾外咳害崖慨概涯碍蓋街該鎧骸浬馨蛙垣柿蛎鈎劃嚇各廓拡撹格核殻獲確穫覚角赫較郭閣隔革学岳楽額顎掛笠樫橿梶鰍潟割喝恰括活渇滑葛褐轄且鰹叶椛樺鞄株兜竃蒲釜鎌噛鴨栢茅萱"],
      ["b4a1", "粥刈苅瓦乾侃冠寒刊勘勧巻喚堪姦完官寛干幹患感慣憾換敢柑桓棺款歓汗漢澗潅環甘監看竿管簡緩缶翰肝艦莞観諌貫還鑑間閑関陥韓館舘丸含岸巌玩癌眼岩翫贋雁頑顔願企伎危喜器基奇嬉寄岐希幾忌揮机旗既期棋棄"],
      ["b5a1", "機帰毅気汽畿祈季稀紀徽規記貴起軌輝飢騎鬼亀偽儀妓宜戯技擬欺犠疑祇義蟻誼議掬菊鞠吉吃喫桔橘詰砧杵黍却客脚虐逆丘久仇休及吸宮弓急救朽求汲泣灸球究窮笈級糾給旧牛去居巨拒拠挙渠虚許距鋸漁禦魚亨享京"],
      ["b6a1", "供侠僑兇競共凶協匡卿叫喬境峡強彊怯恐恭挟教橋況狂狭矯胸脅興蕎郷鏡響饗驚仰凝尭暁業局曲極玉桐粁僅勤均巾錦斤欣欽琴禁禽筋緊芹菌衿襟謹近金吟銀九倶句区狗玖矩苦躯駆駈駒具愚虞喰空偶寓遇隅串櫛釧屑屈"],
      ["b7a1", "掘窟沓靴轡窪熊隈粂栗繰桑鍬勲君薫訓群軍郡卦袈祁係傾刑兄啓圭珪型契形径恵慶慧憩掲携敬景桂渓畦稽系経継繋罫茎荊蛍計詣警軽頚鶏芸迎鯨劇戟撃激隙桁傑欠決潔穴結血訣月件倹倦健兼券剣喧圏堅嫌建憲懸拳捲"],
      ["b8a1", "検権牽犬献研硯絹県肩見謙賢軒遣鍵険顕験鹸元原厳幻弦減源玄現絃舷言諺限乎個古呼固姑孤己庫弧戸故枯湖狐糊袴股胡菰虎誇跨鈷雇顧鼓五互伍午呉吾娯後御悟梧檎瑚碁語誤護醐乞鯉交佼侯候倖光公功効勾厚口向"],
      ["b9a1", "后喉坑垢好孔孝宏工巧巷幸広庚康弘恒慌抗拘控攻昂晃更杭校梗構江洪浩港溝甲皇硬稿糠紅紘絞綱耕考肯肱腔膏航荒行衡講貢購郊酵鉱砿鋼閤降項香高鴻剛劫号合壕拷濠豪轟麹克刻告国穀酷鵠黒獄漉腰甑忽惚骨狛込"],
      ["baa1", "此頃今困坤墾婚恨懇昏昆根梱混痕紺艮魂些佐叉唆嵯左差査沙瑳砂詐鎖裟坐座挫債催再最哉塞妻宰彩才採栽歳済災采犀砕砦祭斎細菜裁載際剤在材罪財冴坂阪堺榊肴咲崎埼碕鷺作削咋搾昨朔柵窄策索錯桜鮭笹匙冊刷"],
      ["bba1", "察拶撮擦札殺薩雑皐鯖捌錆鮫皿晒三傘参山惨撒散桟燦珊産算纂蚕讃賛酸餐斬暫残仕仔伺使刺司史嗣四士始姉姿子屍市師志思指支孜斯施旨枝止死氏獅祉私糸紙紫肢脂至視詞詩試誌諮資賜雌飼歯事似侍児字寺慈持時"],
      ["bca1", "次滋治爾璽痔磁示而耳自蒔辞汐鹿式識鴫竺軸宍雫七叱執失嫉室悉湿漆疾質実蔀篠偲柴芝屡蕊縞舎写射捨赦斜煮社紗者謝車遮蛇邪借勺尺杓灼爵酌釈錫若寂弱惹主取守手朱殊狩珠種腫趣酒首儒受呪寿授樹綬需囚収周"],
      ["bda1", "宗就州修愁拾洲秀秋終繍習臭舟蒐衆襲讐蹴輯週酋酬集醜什住充十従戎柔汁渋獣縦重銃叔夙宿淑祝縮粛塾熟出術述俊峻春瞬竣舜駿准循旬楯殉淳準潤盾純巡遵醇順処初所暑曙渚庶緒署書薯藷諸助叙女序徐恕鋤除傷償"],
      ["bea1", "勝匠升召哨商唱嘗奨妾娼宵将小少尚庄床廠彰承抄招掌捷昇昌昭晶松梢樟樵沼消渉湘焼焦照症省硝礁祥称章笑粧紹肖菖蒋蕉衝裳訟証詔詳象賞醤鉦鍾鐘障鞘上丈丞乗冗剰城場壌嬢常情擾条杖浄状畳穣蒸譲醸錠嘱埴飾"],
      ["bfa1", "拭植殖燭織職色触食蝕辱尻伸信侵唇娠寝審心慎振新晋森榛浸深申疹真神秦紳臣芯薪親診身辛進針震人仁刃塵壬尋甚尽腎訊迅陣靭笥諏須酢図厨逗吹垂帥推水炊睡粋翠衰遂酔錐錘随瑞髄崇嵩数枢趨雛据杉椙菅頗雀裾"],
      ["c0a1", "澄摺寸世瀬畝是凄制勢姓征性成政整星晴棲栖正清牲生盛精聖声製西誠誓請逝醒青静斉税脆隻席惜戚斥昔析石積籍績脊責赤跡蹟碩切拙接摂折設窃節説雪絶舌蝉仙先千占宣専尖川戦扇撰栓栴泉浅洗染潜煎煽旋穿箭線"],
      ["c1a1", "繊羨腺舛船薦詮賎践選遷銭銑閃鮮前善漸然全禅繕膳糎噌塑岨措曾曽楚狙疏疎礎祖租粗素組蘇訴阻遡鼠僧創双叢倉喪壮奏爽宋層匝惣想捜掃挿掻操早曹巣槍槽漕燥争痩相窓糟総綜聡草荘葬蒼藻装走送遭鎗霜騒像増憎"],
      ["c2a1", "臓蔵贈造促側則即息捉束測足速俗属賊族続卒袖其揃存孫尊損村遜他多太汰詑唾堕妥惰打柁舵楕陀駄騨体堆対耐岱帯待怠態戴替泰滞胎腿苔袋貸退逮隊黛鯛代台大第醍題鷹滝瀧卓啄宅托択拓沢濯琢託鐸濁諾茸凧蛸只"],
      ["c3a1", "叩但達辰奪脱巽竪辿棚谷狸鱈樽誰丹単嘆坦担探旦歎淡湛炭短端箪綻耽胆蛋誕鍛団壇弾断暖檀段男談値知地弛恥智池痴稚置致蜘遅馳築畜竹筑蓄逐秩窒茶嫡着中仲宙忠抽昼柱注虫衷註酎鋳駐樗瀦猪苧著貯丁兆凋喋寵"],
      ["c4a1", "帖帳庁弔張彫徴懲挑暢朝潮牒町眺聴脹腸蝶調諜超跳銚長頂鳥勅捗直朕沈珍賃鎮陳津墜椎槌追鎚痛通塚栂掴槻佃漬柘辻蔦綴鍔椿潰坪壷嬬紬爪吊釣鶴亭低停偵剃貞呈堤定帝底庭廷弟悌抵挺提梯汀碇禎程締艇訂諦蹄逓"],
      ["c5a1", "邸鄭釘鼎泥摘擢敵滴的笛適鏑溺哲徹撤轍迭鉄典填天展店添纏甜貼転顛点伝殿澱田電兎吐堵塗妬屠徒斗杜渡登菟賭途都鍍砥砺努度土奴怒倒党冬凍刀唐塔塘套宕島嶋悼投搭東桃梼棟盗淘湯涛灯燈当痘祷等答筒糖統到"],
      ["c6a1", "董蕩藤討謄豆踏逃透鐙陶頭騰闘働動同堂導憧撞洞瞳童胴萄道銅峠鴇匿得徳涜特督禿篤毒独読栃橡凸突椴届鳶苫寅酉瀞噸屯惇敦沌豚遁頓呑曇鈍奈那内乍凪薙謎灘捺鍋楢馴縄畷南楠軟難汝二尼弐迩匂賑肉虹廿日乳入"],
      ["c7a1", "如尿韮任妊忍認濡禰祢寧葱猫熱年念捻撚燃粘乃廼之埜嚢悩濃納能脳膿農覗蚤巴把播覇杷波派琶破婆罵芭馬俳廃拝排敗杯盃牌背肺輩配倍培媒梅楳煤狽買売賠陪這蝿秤矧萩伯剥博拍柏泊白箔粕舶薄迫曝漠爆縛莫駁麦"],
      ["c8a1", "函箱硲箸肇筈櫨幡肌畑畠八鉢溌発醗髪伐罰抜筏閥鳩噺塙蛤隼伴判半反叛帆搬斑板氾汎版犯班畔繁般藩販範釆煩頒飯挽晩番盤磐蕃蛮匪卑否妃庇彼悲扉批披斐比泌疲皮碑秘緋罷肥被誹費避非飛樋簸備尾微枇毘琵眉美"],
      ["c9a1", "鼻柊稗匹疋髭彦膝菱肘弼必畢筆逼桧姫媛紐百謬俵彪標氷漂瓢票表評豹廟描病秒苗錨鋲蒜蛭鰭品彬斌浜瀕貧賓頻敏瓶不付埠夫婦富冨布府怖扶敷斧普浮父符腐膚芙譜負賦赴阜附侮撫武舞葡蕪部封楓風葺蕗伏副復幅服"],
      ["caa1", "福腹複覆淵弗払沸仏物鮒分吻噴墳憤扮焚奮粉糞紛雰文聞丙併兵塀幣平弊柄並蔽閉陛米頁僻壁癖碧別瞥蔑箆偏変片篇編辺返遍便勉娩弁鞭保舗鋪圃捕歩甫補輔穂募墓慕戊暮母簿菩倣俸包呆報奉宝峰峯崩庖抱捧放方朋"],
      ["cba1", "法泡烹砲縫胞芳萌蓬蜂褒訪豊邦鋒飽鳳鵬乏亡傍剖坊妨帽忘忙房暴望某棒冒紡肪膨謀貌貿鉾防吠頬北僕卜墨撲朴牧睦穆釦勃没殆堀幌奔本翻凡盆摩磨魔麻埋妹昧枚毎哩槙幕膜枕鮪柾鱒桝亦俣又抹末沫迄侭繭麿万慢満"],
      ["cca1", "漫蔓味未魅巳箕岬密蜜湊蓑稔脈妙粍民眠務夢無牟矛霧鵡椋婿娘冥名命明盟迷銘鳴姪牝滅免棉綿緬面麺摸模茂妄孟毛猛盲網耗蒙儲木黙目杢勿餅尤戻籾貰問悶紋門匁也冶夜爺耶野弥矢厄役約薬訳躍靖柳薮鑓愉愈油癒"],
      ["cda1", "諭輸唯佑優勇友宥幽悠憂揖有柚湧涌猶猷由祐裕誘遊邑郵雄融夕予余与誉輿預傭幼妖容庸揚揺擁曜楊様洋溶熔用窯羊耀葉蓉要謡踊遥陽養慾抑欲沃浴翌翼淀羅螺裸来莱頼雷洛絡落酪乱卵嵐欄濫藍蘭覧利吏履李梨理璃"],
      ["cea1", "痢裏裡里離陸律率立葎掠略劉流溜琉留硫粒隆竜龍侶慮旅虜了亮僚両凌寮料梁涼猟療瞭稜糧良諒遼量陵領力緑倫厘林淋燐琳臨輪隣鱗麟瑠塁涙累類令伶例冷励嶺怜玲礼苓鈴隷零霊麗齢暦歴列劣烈裂廉恋憐漣煉簾練聯"],
      ["cfa1", "蓮連錬呂魯櫓炉賂路露労婁廊弄朗楼榔浪漏牢狼篭老聾蝋郎六麓禄肋録論倭和話歪賄脇惑枠鷲亙亘鰐詫藁蕨椀湾碗腕"],
      ["d0a1", "弌丐丕个丱丶丼丿乂乖乘亂亅豫亊舒弍于亞亟亠亢亰亳亶从仍仄仆仂仗仞仭仟价伉佚估佛佝佗佇佶侈侏侘佻佩佰侑佯來侖儘俔俟俎俘俛俑俚俐俤俥倚倨倔倪倥倅伜俶倡倩倬俾俯們倆偃假會偕偐偈做偖偬偸傀傚傅傴傲"],
      ["d1a1", "僉僊傳僂僖僞僥僭僣僮價僵儉儁儂儖儕儔儚儡儺儷儼儻儿兀兒兌兔兢竸兩兪兮冀冂囘册冉冏冑冓冕冖冤冦冢冩冪冫决冱冲冰况冽凅凉凛几處凩凭凰凵凾刄刋刔刎刧刪刮刳刹剏剄剋剌剞剔剪剴剩剳剿剽劍劔劒剱劈劑辨"],
      ["d2a1", "辧劬劭劼劵勁勍勗勞勣勦飭勠勳勵勸勹匆匈甸匍匐匏匕匚匣匯匱匳匸區卆卅丗卉卍凖卞卩卮夘卻卷厂厖厠厦厥厮厰厶參簒雙叟曼燮叮叨叭叺吁吽呀听吭吼吮吶吩吝呎咏呵咎呟呱呷呰咒呻咀呶咄咐咆哇咢咸咥咬哄哈咨"],
      ["d3a1", "咫哂咤咾咼哘哥哦唏唔哽哮哭哺哢唹啀啣啌售啜啅啖啗唸唳啝喙喀咯喊喟啻啾喘喞單啼喃喩喇喨嗚嗅嗟嗄嗜嗤嗔嘔嗷嘖嗾嗽嘛嗹噎噐營嘴嘶嘲嘸噫噤嘯噬噪嚆嚀嚊嚠嚔嚏嚥嚮嚶嚴囂嚼囁囃囀囈囎囑囓囗囮囹圀囿圄圉"],
      ["d4a1", "圈國圍圓團圖嗇圜圦圷圸坎圻址坏坩埀垈坡坿垉垓垠垳垤垪垰埃埆埔埒埓堊埖埣堋堙堝塲堡塢塋塰毀塒堽塹墅墹墟墫墺壞墻墸墮壅壓壑壗壙壘壥壜壤壟壯壺壹壻壼壽夂夊夐夛梦夥夬夭夲夸夾竒奕奐奎奚奘奢奠奧奬奩"],
      ["d5a1", "奸妁妝佞侫妣妲姆姨姜妍姙姚娥娟娑娜娉娚婀婬婉娵娶婢婪媚媼媾嫋嫂媽嫣嫗嫦嫩嫖嫺嫻嬌嬋嬖嬲嫐嬪嬶嬾孃孅孀孑孕孚孛孥孩孰孳孵學斈孺宀它宦宸寃寇寉寔寐寤實寢寞寥寫寰寶寳尅將專對尓尠尢尨尸尹屁屆屎屓"],
      ["d6a1", "屐屏孱屬屮乢屶屹岌岑岔妛岫岻岶岼岷峅岾峇峙峩峽峺峭嶌峪崋崕崗嵜崟崛崑崔崢崚崙崘嵌嵒嵎嵋嵬嵳嵶嶇嶄嶂嶢嶝嶬嶮嶽嶐嶷嶼巉巍巓巒巖巛巫已巵帋帚帙帑帛帶帷幄幃幀幎幗幔幟幢幤幇幵并幺麼广庠廁廂廈廐廏"],
      ["d7a1", "廖廣廝廚廛廢廡廨廩廬廱廳廰廴廸廾弃弉彝彜弋弑弖弩弭弸彁彈彌彎弯彑彖彗彙彡彭彳彷徃徂彿徊很徑徇從徙徘徠徨徭徼忖忻忤忸忱忝悳忿怡恠怙怐怩怎怱怛怕怫怦怏怺恚恁恪恷恟恊恆恍恣恃恤恂恬恫恙悁悍惧悃悚"],
      ["d8a1", "悄悛悖悗悒悧悋惡悸惠惓悴忰悽惆悵惘慍愕愆惶惷愀惴惺愃愡惻惱愍愎慇愾愨愧慊愿愼愬愴愽慂慄慳慷慘慙慚慫慴慯慥慱慟慝慓慵憙憖憇憬憔憚憊憑憫憮懌懊應懷懈懃懆憺懋罹懍懦懣懶懺懴懿懽懼懾戀戈戉戍戌戔戛"],
      ["d9a1", "戞戡截戮戰戲戳扁扎扞扣扛扠扨扼抂抉找抒抓抖拔抃抔拗拑抻拏拿拆擔拈拜拌拊拂拇抛拉挌拮拱挧挂挈拯拵捐挾捍搜捏掖掎掀掫捶掣掏掉掟掵捫捩掾揩揀揆揣揉插揶揄搖搴搆搓搦搶攝搗搨搏摧摯摶摎攪撕撓撥撩撈撼"],
      ["daa1", "據擒擅擇撻擘擂擱擧舉擠擡抬擣擯攬擶擴擲擺攀擽攘攜攅攤攣攫攴攵攷收攸畋效敖敕敍敘敞敝敲數斂斃變斛斟斫斷旃旆旁旄旌旒旛旙无旡旱杲昊昃旻杳昵昶昴昜晏晄晉晁晞晝晤晧晨晟晢晰暃暈暎暉暄暘暝曁暹曉暾暼"],
      ["dba1", "曄暸曖曚曠昿曦曩曰曵曷朏朖朞朦朧霸朮朿朶杁朸朷杆杞杠杙杣杤枉杰枩杼杪枌枋枦枡枅枷柯枴柬枳柩枸柤柞柝柢柮枹柎柆柧檜栞框栩桀桍栲桎梳栫桙档桷桿梟梏梭梔條梛梃檮梹桴梵梠梺椏梍桾椁棊椈棘椢椦棡椌棍"],
      ["dca1", "棔棧棕椶椒椄棗棣椥棹棠棯椨椪椚椣椡棆楹楷楜楸楫楔楾楮椹楴椽楙椰楡楞楝榁楪榲榮槐榿槁槓榾槎寨槊槝榻槃榧樮榑榠榜榕榴槞槨樂樛槿權槹槲槧樅榱樞槭樔槫樊樒櫁樣樓橄樌橲樶橸橇橢橙橦橈樸樢檐檍檠檄檢檣"],
      ["dda1", "檗蘗檻櫃櫂檸檳檬櫞櫑櫟檪櫚櫪櫻欅蘖櫺欒欖鬱欟欸欷盜欹飮歇歃歉歐歙歔歛歟歡歸歹歿殀殄殃殍殘殕殞殤殪殫殯殲殱殳殷殼毆毋毓毟毬毫毳毯麾氈氓气氛氤氣汞汕汢汪沂沍沚沁沛汾汨汳沒沐泄泱泓沽泗泅泝沮沱沾"],
      ["dea1", "沺泛泯泙泪洟衍洶洫洽洸洙洵洳洒洌浣涓浤浚浹浙涎涕濤涅淹渕渊涵淇淦涸淆淬淞淌淨淒淅淺淙淤淕淪淮渭湮渮渙湲湟渾渣湫渫湶湍渟湃渺湎渤滿渝游溂溪溘滉溷滓溽溯滄溲滔滕溏溥滂溟潁漑灌滬滸滾漿滲漱滯漲滌"],
      ["dfa1", "漾漓滷澆潺潸澁澀潯潛濳潭澂潼潘澎澑濂潦澳澣澡澤澹濆澪濟濕濬濔濘濱濮濛瀉瀋濺瀑瀁瀏濾瀛瀚潴瀝瀘瀟瀰瀾瀲灑灣炙炒炯烱炬炸炳炮烟烋烝烙焉烽焜焙煥煕熈煦煢煌煖煬熏燻熄熕熨熬燗熹熾燒燉燔燎燠燬燧燵燼"],
      ["e0a1", "燹燿爍爐爛爨爭爬爰爲爻爼爿牀牆牋牘牴牾犂犁犇犒犖犢犧犹犲狃狆狄狎狒狢狠狡狹狷倏猗猊猜猖猝猴猯猩猥猾獎獏默獗獪獨獰獸獵獻獺珈玳珎玻珀珥珮珞璢琅瑯琥珸琲琺瑕琿瑟瑙瑁瑜瑩瑰瑣瑪瑶瑾璋璞璧瓊瓏瓔珱"],
      ["e1a1", "瓠瓣瓧瓩瓮瓲瓰瓱瓸瓷甄甃甅甌甎甍甕甓甞甦甬甼畄畍畊畉畛畆畚畩畤畧畫畭畸當疆疇畴疊疉疂疔疚疝疥疣痂疳痃疵疽疸疼疱痍痊痒痙痣痞痾痿痼瘁痰痺痲痳瘋瘍瘉瘟瘧瘠瘡瘢瘤瘴瘰瘻癇癈癆癜癘癡癢癨癩癪癧癬癰"],
      ["e2a1", "癲癶癸發皀皃皈皋皎皖皓皙皚皰皴皸皹皺盂盍盖盒盞盡盥盧盪蘯盻眈眇眄眩眤眞眥眦眛眷眸睇睚睨睫睛睥睿睾睹瞎瞋瞑瞠瞞瞰瞶瞹瞿瞼瞽瞻矇矍矗矚矜矣矮矼砌砒礦砠礪硅碎硴碆硼碚碌碣碵碪碯磑磆磋磔碾碼磅磊磬"],
      ["e3a1", "磧磚磽磴礇礒礑礙礬礫祀祠祗祟祚祕祓祺祿禊禝禧齋禪禮禳禹禺秉秕秧秬秡秣稈稍稘稙稠稟禀稱稻稾稷穃穗穉穡穢穩龝穰穹穽窈窗窕窘窖窩竈窰窶竅竄窿邃竇竊竍竏竕竓站竚竝竡竢竦竭竰笂笏笊笆笳笘笙笞笵笨笶筐"],
      ["e4a1", "筺笄筍笋筌筅筵筥筴筧筰筱筬筮箝箘箟箍箜箚箋箒箏筝箙篋篁篌篏箴篆篝篩簑簔篦篥籠簀簇簓篳篷簗簍篶簣簧簪簟簷簫簽籌籃籔籏籀籐籘籟籤籖籥籬籵粃粐粤粭粢粫粡粨粳粲粱粮粹粽糀糅糂糘糒糜糢鬻糯糲糴糶糺紆"],
      ["e5a1", "紂紜紕紊絅絋紮紲紿紵絆絳絖絎絲絨絮絏絣經綉絛綏絽綛綺綮綣綵緇綽綫總綢綯緜綸綟綰緘緝緤緞緻緲緡縅縊縣縡縒縱縟縉縋縢繆繦縻縵縹繃縷縲縺繧繝繖繞繙繚繹繪繩繼繻纃緕繽辮繿纈纉續纒纐纓纔纖纎纛纜缸缺"],
      ["e6a1", "罅罌罍罎罐网罕罔罘罟罠罨罩罧罸羂羆羃羈羇羌羔羞羝羚羣羯羲羹羮羶羸譱翅翆翊翕翔翡翦翩翳翹飜耆耄耋耒耘耙耜耡耨耿耻聊聆聒聘聚聟聢聨聳聲聰聶聹聽聿肄肆肅肛肓肚肭冐肬胛胥胙胝胄胚胖脉胯胱脛脩脣脯腋"],
      ["e7a1", "隋腆脾腓腑胼腱腮腥腦腴膃膈膊膀膂膠膕膤膣腟膓膩膰膵膾膸膽臀臂膺臉臍臑臙臘臈臚臟臠臧臺臻臾舁舂舅與舊舍舐舖舩舫舸舳艀艙艘艝艚艟艤艢艨艪艫舮艱艷艸艾芍芒芫芟芻芬苡苣苟苒苴苳苺莓范苻苹苞茆苜茉苙"],
      ["e8a1", "茵茴茖茲茱荀茹荐荅茯茫茗茘莅莚莪莟莢莖茣莎莇莊荼莵荳荵莠莉莨菴萓菫菎菽萃菘萋菁菷萇菠菲萍萢萠莽萸蔆菻葭萪萼蕚蒄葷葫蒭葮蒂葩葆萬葯葹萵蓊葢蒹蒿蒟蓙蓍蒻蓚蓐蓁蓆蓖蒡蔡蓿蓴蔗蔘蔬蔟蔕蔔蓼蕀蕣蕘蕈"],
      ["e9a1", "蕁蘂蕋蕕薀薤薈薑薊薨蕭薔薛藪薇薜蕷蕾薐藉薺藏薹藐藕藝藥藜藹蘊蘓蘋藾藺蘆蘢蘚蘰蘿虍乕虔號虧虱蚓蚣蚩蚪蚋蚌蚶蚯蛄蛆蚰蛉蠣蚫蛔蛞蛩蛬蛟蛛蛯蜒蜆蜈蜀蜃蛻蜑蜉蜍蛹蜊蜴蜿蜷蜻蜥蜩蜚蝠蝟蝸蝌蝎蝴蝗蝨蝮蝙"],
      ["eaa1", "蝓蝣蝪蠅螢螟螂螯蟋螽蟀蟐雖螫蟄螳蟇蟆螻蟯蟲蟠蠏蠍蟾蟶蟷蠎蟒蠑蠖蠕蠢蠡蠱蠶蠹蠧蠻衄衂衒衙衞衢衫袁衾袞衵衽袵衲袂袗袒袮袙袢袍袤袰袿袱裃裄裔裘裙裝裹褂裼裴裨裲褄褌褊褓襃褞褥褪褫襁襄褻褶褸襌褝襠襞"],
      ["eba1", "襦襤襭襪襯襴襷襾覃覈覊覓覘覡覩覦覬覯覲覺覽覿觀觚觜觝觧觴觸訃訖訐訌訛訝訥訶詁詛詒詆詈詼詭詬詢誅誂誄誨誡誑誥誦誚誣諄諍諂諚諫諳諧諤諱謔諠諢諷諞諛謌謇謚諡謖謐謗謠謳鞫謦謫謾謨譁譌譏譎證譖譛譚譫"],
      ["eca1", "譟譬譯譴譽讀讌讎讒讓讖讙讚谺豁谿豈豌豎豐豕豢豬豸豺貂貉貅貊貍貎貔豼貘戝貭貪貽貲貳貮貶賈賁賤賣賚賽賺賻贄贅贊贇贏贍贐齎贓賍贔贖赧赭赱赳趁趙跂趾趺跏跚跖跌跛跋跪跫跟跣跼踈踉跿踝踞踐踟蹂踵踰踴蹊"],
      ["eda1", "蹇蹉蹌蹐蹈蹙蹤蹠踪蹣蹕蹶蹲蹼躁躇躅躄躋躊躓躑躔躙躪躡躬躰軆躱躾軅軈軋軛軣軼軻軫軾輊輅輕輒輙輓輜輟輛輌輦輳輻輹轅轂輾轌轉轆轎轗轜轢轣轤辜辟辣辭辯辷迚迥迢迪迯邇迴逅迹迺逑逕逡逍逞逖逋逧逶逵逹迸"],
      ["eea1", "遏遐遑遒逎遉逾遖遘遞遨遯遶隨遲邂遽邁邀邊邉邏邨邯邱邵郢郤扈郛鄂鄒鄙鄲鄰酊酖酘酣酥酩酳酲醋醉醂醢醫醯醪醵醴醺釀釁釉釋釐釖釟釡釛釼釵釶鈞釿鈔鈬鈕鈑鉞鉗鉅鉉鉤鉈銕鈿鉋鉐銜銖銓銛鉚鋏銹銷鋩錏鋺鍄錮"],
      ["efa1", "錙錢錚錣錺錵錻鍜鍠鍼鍮鍖鎰鎬鎭鎔鎹鏖鏗鏨鏥鏘鏃鏝鏐鏈鏤鐚鐔鐓鐃鐇鐐鐶鐫鐵鐡鐺鑁鑒鑄鑛鑠鑢鑞鑪鈩鑰鑵鑷鑽鑚鑼鑾钁鑿閂閇閊閔閖閘閙閠閨閧閭閼閻閹閾闊濶闃闍闌闕闔闖關闡闥闢阡阨阮阯陂陌陏陋陷陜陞"],
      ["f0a1", "陝陟陦陲陬隍隘隕隗險隧隱隲隰隴隶隸隹雎雋雉雍襍雜霍雕雹霄霆霈霓霎霑霏霖霙霤霪霰霹霽霾靄靆靈靂靉靜靠靤靦靨勒靫靱靹鞅靼鞁靺鞆鞋鞏鞐鞜鞨鞦鞣鞳鞴韃韆韈韋韜韭齏韲竟韶韵頏頌頸頤頡頷頽顆顏顋顫顯顰"],
      ["f1a1", "顱顴顳颪颯颱颶飄飃飆飩飫餃餉餒餔餘餡餝餞餤餠餬餮餽餾饂饉饅饐饋饑饒饌饕馗馘馥馭馮馼駟駛駝駘駑駭駮駱駲駻駸騁騏騅駢騙騫騷驅驂驀驃騾驕驍驛驗驟驢驥驤驩驫驪骭骰骼髀髏髑髓體髞髟髢髣髦髯髫髮髴髱髷"],
      ["f2a1", "髻鬆鬘鬚鬟鬢鬣鬥鬧鬨鬩鬪鬮鬯鬲魄魃魏魍魎魑魘魴鮓鮃鮑鮖鮗鮟鮠鮨鮴鯀鯊鮹鯆鯏鯑鯒鯣鯢鯤鯔鯡鰺鯲鯱鯰鰕鰔鰉鰓鰌鰆鰈鰒鰊鰄鰮鰛鰥鰤鰡鰰鱇鰲鱆鰾鱚鱠鱧鱶鱸鳧鳬鳰鴉鴈鳫鴃鴆鴪鴦鶯鴣鴟鵄鴕鴒鵁鴿鴾鵆鵈"],
      ["f3a1", "鵝鵞鵤鵑鵐鵙鵲鶉鶇鶫鵯鵺鶚鶤鶩鶲鷄鷁鶻鶸鶺鷆鷏鷂鷙鷓鷸鷦鷭鷯鷽鸚鸛鸞鹵鹹鹽麁麈麋麌麒麕麑麝麥麩麸麪麭靡黌黎黏黐黔黜點黝黠黥黨黯黴黶黷黹黻黼黽鼇鼈皷鼕鼡鼬鼾齊齒齔齣齟齠齡齦齧齬齪齷齲齶龕龜龠"],
      ["f4a1", "堯槇遙瑤凜熙"],
      ["f9a1", "纊褜鍈銈蓜俉炻昱棈鋹曻彅丨仡仼伀伃伹佖侒侊侚侔俍偀倢俿倞偆偰偂傔僴僘兊兤冝冾凬刕劜劦勀勛匀匇匤卲厓厲叝﨎咜咊咩哿喆坙坥垬埈埇﨏塚增墲夋奓奛奝奣妤妺孖寀甯寘寬尞岦岺峵崧嵓﨑嵂嵭嶸嶹巐弡弴彧德"],
      ["faa1", "忞恝悅悊惞惕愠惲愑愷愰憘戓抦揵摠撝擎敎昀昕昻昉昮昞昤晥晗晙晴晳暙暠暲暿曺朎朗杦枻桒柀栁桄棏﨓楨﨔榘槢樰橫橆橳橾櫢櫤毖氿汜沆汯泚洄涇浯涖涬淏淸淲淼渹湜渧渼溿澈澵濵瀅瀇瀨炅炫焏焄煜煆煇凞燁燾犱"],
      ["fba1", "犾猤猪獷玽珉珖珣珒琇珵琦琪琩琮瑢璉璟甁畯皂皜皞皛皦益睆劯砡硎硤硺礰礼神祥禔福禛竑竧靖竫箞精絈絜綷綠緖繒罇羡羽茁荢荿菇菶葈蒴蕓蕙蕫﨟薰蘒﨡蠇裵訒訷詹誧誾諟諸諶譓譿賰賴贒赶﨣軏﨤逸遧郞都鄕鄧釚"],
      ["fca1", "釗釞釭釮釤釥鈆鈐鈊鈺鉀鈼鉎鉙鉑鈹鉧銧鉷鉸鋧鋗鋙鋐﨧鋕鋠鋓錥錡鋻﨨錞鋿錝錂鍰鍗鎤鏆鏞鏸鐱鑅鑈閒隆﨩隝隯霳霻靃靍靏靑靕顗顥飯飼餧館馞驎髙髜魵魲鮏鮱鮻鰀鵰鵫鶴鸙黑"],
      ["fcf1", "ⅰ", 9, "￢￤＇＂"],
      ["8fa2af", "˘ˇ¸˙˝¯˛˚～΄΅"],
      ["8fa2c2", "¡¦¿"],
      ["8fa2eb", "ºª©®™¤№"],
      ["8fa6e1", "ΆΈΉΊΪ"],
      ["8fa6e7", "Ό"],
      ["8fa6e9", "ΎΫ"],
      ["8fa6ec", "Ώ"],
      ["8fa6f1", "άέήίϊΐόςύϋΰώ"],
      ["8fa7c2", "Ђ", 10, "ЎЏ"],
      ["8fa7f2", "ђ", 10, "ўџ"],
      ["8fa9a1", "ÆĐ"],
      ["8fa9a4", "Ħ"],
      ["8fa9a6", "Ĳ"],
      ["8fa9a8", "ŁĿ"],
      ["8fa9ab", "ŊØŒ"],
      ["8fa9af", "ŦÞ"],
      ["8fa9c1", "æđðħıĳĸłŀŉŋøœßŧþ"],
      ["8faaa1", "ÁÀÄÂĂǍĀĄÅÃĆĈČÇĊĎÉÈËÊĚĖĒĘ"],
      ["8faaba", "ĜĞĢĠĤÍÌÏÎǏİĪĮĨĴĶĹĽĻŃŇŅÑÓÒÖÔǑŐŌÕŔŘŖŚŜŠŞŤŢÚÙÜÛŬǓŰŪŲŮŨǗǛǙǕŴÝŸŶŹŽŻ"],
      ["8faba1", "áàäâăǎāąåãćĉčçċďéèëêěėēęǵĝğ"],
      ["8fabbd", "ġĥíìïîǐ"],
      ["8fabc5", "īįĩĵķĺľļńňņñóòöôǒőōõŕřŗśŝšşťţúùüûŭǔűūųůũǘǜǚǖŵýÿŷźžż"],
      ["8fb0a1", "丂丄丅丌丒丟丣两丨丫丮丯丰丵乀乁乄乇乑乚乜乣乨乩乴乵乹乿亍亖亗亝亯亹仃仐仚仛仠仡仢仨仯仱仳仵份仾仿伀伂伃伈伋伌伒伕伖众伙伮伱你伳伵伷伹伻伾佀佂佈佉佋佌佒佔佖佘佟佣佪佬佮佱佷佸佹佺佽佾侁侂侄"],
      ["8fb1a1", "侅侉侊侌侎侐侒侓侔侗侙侚侞侟侲侷侹侻侼侽侾俀俁俅俆俈俉俋俌俍俏俒俜俠俢俰俲俼俽俿倀倁倄倇倊倌倎倐倓倗倘倛倜倝倞倢倧倮倰倲倳倵偀偁偂偅偆偊偌偎偑偒偓偗偙偟偠偢偣偦偧偪偭偰偱倻傁傃傄傆傊傎傏傐"],
      ["8fb2a1", "傒傓傔傖傛傜傞", 4, "傪傯傰傹傺傽僀僃僄僇僌僎僐僓僔僘僜僝僟僢僤僦僨僩僯僱僶僺僾儃儆儇儈儋儌儍儎僲儐儗儙儛儜儝儞儣儧儨儬儭儯儱儳儴儵儸儹兂兊兏兓兕兗兘兟兤兦兾冃冄冋冎冘冝冡冣冭冸冺冼冾冿凂"],
      ["8fb3a1", "凈减凑凒凓凕凘凞凢凥凮凲凳凴凷刁刂刅划刓刕刖刘刢刨刱刲刵刼剅剉剕剗剘剚剜剟剠剡剦剮剷剸剹劀劂劅劊劌劓劕劖劗劘劚劜劤劥劦劧劯劰劶劷劸劺劻劽勀勄勆勈勌勏勑勔勖勛勜勡勥勨勩勪勬勰勱勴勶勷匀匃匊匋"],
      ["8fb4a1", "匌匑匓匘匛匜匞匟匥匧匨匩匫匬匭匰匲匵匼匽匾卂卌卋卙卛卡卣卥卬卭卲卹卾厃厇厈厎厓厔厙厝厡厤厪厫厯厲厴厵厷厸厺厽叀叅叏叒叓叕叚叝叞叠另叧叵吂吓吚吡吧吨吪启吱吴吵呃呄呇呍呏呞呢呤呦呧呩呫呭呮呴呿"],
      ["8fb5a1", "咁咃咅咈咉咍咑咕咖咜咟咡咦咧咩咪咭咮咱咷咹咺咻咿哆哊响哎哠哪哬哯哶哼哾哿唀唁唅唈唉唌唍唎唕唪唫唲唵唶唻唼唽啁啇啉啊啍啐啑啘啚啛啞啠啡啤啦啿喁喂喆喈喎喏喑喒喓喔喗喣喤喭喲喿嗁嗃嗆嗉嗋嗌嗎嗑嗒"],
      ["8fb6a1", "嗓嗗嗘嗛嗞嗢嗩嗶嗿嘅嘈嘊嘍", 5, "嘙嘬嘰嘳嘵嘷嘹嘻嘼嘽嘿噀噁噃噄噆噉噋噍噏噔噞噠噡噢噣噦噩噭噯噱噲噵嚄嚅嚈嚋嚌嚕嚙嚚嚝嚞嚟嚦嚧嚨嚩嚫嚬嚭嚱嚳嚷嚾囅囉囊囋囏囐囌囍囙囜囝囟囡囤", 4, "囱囫园"],
      ["8fb7a1", "囶囷圁圂圇圊圌圑圕圚圛圝圠圢圣圤圥圩圪圬圮圯圳圴圽圾圿坅坆坌坍坒坢坥坧坨坫坭", 4, "坳坴坵坷坹坺坻坼坾垁垃垌垔垗垙垚垜垝垞垟垡垕垧垨垩垬垸垽埇埈埌埏埕埝埞埤埦埧埩埭埰埵埶埸埽埾埿堃堄堈堉埡"],
      ["8fb8a1", "堌堍堛堞堟堠堦堧堭堲堹堿塉塌塍塏塐塕塟塡塤塧塨塸塼塿墀墁墇墈墉墊墌墍墏墐墔墖墝墠墡墢墦墩墱墲壄墼壂壈壍壎壐壒壔壖壚壝壡壢壩壳夅夆夋夌夒夓夔虁夝夡夣夤夨夯夰夳夵夶夿奃奆奒奓奙奛奝奞奟奡奣奫奭"],
      ["8fb9a1", "奯奲奵奶她奻奼妋妌妎妒妕妗妟妤妧妭妮妯妰妳妷妺妼姁姃姄姈姊姍姒姝姞姟姣姤姧姮姯姱姲姴姷娀娄娌娍娎娒娓娞娣娤娧娨娪娭娰婄婅婇婈婌婐婕婞婣婥婧婭婷婺婻婾媋媐媓媖媙媜媞媟媠媢媧媬媱媲媳媵媸媺媻媿"],
      ["8fbaa1", "嫄嫆嫈嫏嫚嫜嫠嫥嫪嫮嫵嫶嫽嬀嬁嬈嬗嬴嬙嬛嬝嬡嬥嬭嬸孁孋孌孒孖孞孨孮孯孼孽孾孿宁宄宆宊宎宐宑宓宔宖宨宩宬宭宯宱宲宷宺宼寀寁寍寏寖", 4, "寠寯寱寴寽尌尗尞尟尣尦尩尫尬尮尰尲尵尶屙屚屜屢屣屧屨屩"],
      ["8fbba1", "屭屰屴屵屺屻屼屽岇岈岊岏岒岝岟岠岢岣岦岪岲岴岵岺峉峋峒峝峗峮峱峲峴崁崆崍崒崫崣崤崦崧崱崴崹崽崿嵂嵃嵆嵈嵕嵑嵙嵊嵟嵠嵡嵢嵤嵪嵭嵰嵹嵺嵾嵿嶁嶃嶈嶊嶒嶓嶔嶕嶙嶛嶟嶠嶧嶫嶰嶴嶸嶹巃巇巋巐巎巘巙巠巤"],
      ["8fbca1", "巩巸巹帀帇帍帒帔帕帘帟帠帮帨帲帵帾幋幐幉幑幖幘幛幜幞幨幪", 4, "幰庀庋庎庢庤庥庨庪庬庱庳庽庾庿廆廌廋廎廑廒廔廕廜廞廥廫异弆弇弈弎弙弜弝弡弢弣弤弨弫弬弮弰弴弶弻弽弿彀彄彅彇彍彐彔彘彛彠彣彤彧"],
      ["8fbda1", "彯彲彴彵彸彺彽彾徉徍徏徖徜徝徢徧徫徤徬徯徰徱徸忄忇忈忉忋忐", 4, "忞忡忢忨忩忪忬忭忮忯忲忳忶忺忼怇怊怍怓怔怗怘怚怟怤怭怳怵恀恇恈恉恌恑恔恖恗恝恡恧恱恾恿悂悆悈悊悎悑悓悕悘悝悞悢悤悥您悰悱悷"],
      ["8fbea1", "悻悾惂惄惈惉惊惋惎惏惔惕惙惛惝惞惢惥惲惵惸惼惽愂愇愊愌愐", 4, "愖愗愙愜愞愢愪愫愰愱愵愶愷愹慁慅慆慉慞慠慬慲慸慻慼慿憀憁憃憄憋憍憒憓憗憘憜憝憟憠憥憨憪憭憸憹憼懀懁懂懎懏懕懜懝懞懟懡懢懧懩懥"],
      ["8fbfa1", "懬懭懯戁戃戄戇戓戕戜戠戢戣戧戩戫戹戽扂扃扄扆扌扐扑扒扔扖扚扜扤扭扯扳扺扽抍抎抏抐抦抨抳抶抷抺抾抿拄拎拕拖拚拪拲拴拼拽挃挄挊挋挍挐挓挖挘挩挪挭挵挶挹挼捁捂捃捄捆捊捋捎捒捓捔捘捛捥捦捬捭捱捴捵"],
      ["8fc0a1", "捸捼捽捿掂掄掇掊掐掔掕掙掚掞掤掦掭掮掯掽揁揅揈揎揑揓揔揕揜揠揥揪揬揲揳揵揸揹搉搊搐搒搔搘搞搠搢搤搥搩搪搯搰搵搽搿摋摏摑摒摓摔摚摛摜摝摟摠摡摣摭摳摴摻摽撅撇撏撐撑撘撙撛撝撟撡撣撦撨撬撳撽撾撿"],
      ["8fc1a1", "擄擉擊擋擌擎擐擑擕擗擤擥擩擪擭擰擵擷擻擿攁攄攈攉攊攏攓攔攖攙攛攞攟攢攦攩攮攱攺攼攽敃敇敉敐敒敔敟敠敧敫敺敽斁斅斊斒斕斘斝斠斣斦斮斲斳斴斿旂旈旉旎旐旔旖旘旟旰旲旴旵旹旾旿昀昄昈昉昍昑昒昕昖昝"],
      ["8fc2a1", "昞昡昢昣昤昦昩昪昫昬昮昰昱昳昹昷晀晅晆晊晌晑晎晗晘晙晛晜晠晡曻晪晫晬晾晳晵晿晷晸晹晻暀晼暋暌暍暐暒暙暚暛暜暟暠暤暭暱暲暵暻暿曀曂曃曈曌曎曏曔曛曟曨曫曬曮曺朅朇朎朓朙朜朠朢朳朾杅杇杈杌杔杕杝"],
      ["8fc3a1", "杦杬杮杴杶杻极构枎枏枑枓枖枘枙枛枰枱枲枵枻枼枽柹柀柂柃柅柈柉柒柗柙柜柡柦柰柲柶柷桒栔栙栝栟栨栧栬栭栯栰栱栳栻栿桄桅桊桌桕桗桘桛桫桮", 4, "桵桹桺桻桼梂梄梆梈梖梘梚梜梡梣梥梩梪梮梲梻棅棈棌棏"],
      ["8fc4a1", "棐棑棓棖棙棜棝棥棨棪棫棬棭棰棱棵棶棻棼棽椆椉椊椐椑椓椖椗椱椳椵椸椻楂楅楉楎楗楛楣楤楥楦楨楩楬楰楱楲楺楻楿榀榍榒榖榘榡榥榦榨榫榭榯榷榸榺榼槅槈槑槖槗槢槥槮槯槱槳槵槾樀樁樃樏樑樕樚樝樠樤樨樰樲"],
      ["8fc5a1", "樴樷樻樾樿橅橆橉橊橎橐橑橒橕橖橛橤橧橪橱橳橾檁檃檆檇檉檋檑檛檝檞檟檥檫檯檰檱檴檽檾檿櫆櫉櫈櫌櫐櫔櫕櫖櫜櫝櫤櫧櫬櫰櫱櫲櫼櫽欂欃欆欇欉欏欐欑欗欛欞欤欨欫欬欯欵欶欻欿歆歊歍歒歖歘歝歠歧歫歮歰歵歽"],
      ["8fc6a1", "歾殂殅殗殛殟殠殢殣殨殩殬殭殮殰殸殹殽殾毃毄毉毌毖毚毡毣毦毧毮毱毷毹毿氂氄氅氉氍氎氐氒氙氟氦氧氨氬氮氳氵氶氺氻氿汊汋汍汏汒汔汙汛汜汫汭汯汴汶汸汹汻沅沆沇沉沔沕沗沘沜沟沰沲沴泂泆泍泏泐泑泒泔泖"],
      ["8fc7a1", "泚泜泠泧泩泫泬泮泲泴洄洇洊洎洏洑洓洚洦洧洨汧洮洯洱洹洼洿浗浞浟浡浥浧浯浰浼涂涇涑涒涔涖涗涘涪涬涴涷涹涽涿淄淈淊淎淏淖淛淝淟淠淢淥淩淯淰淴淶淼渀渄渞渢渧渲渶渹渻渼湄湅湈湉湋湏湑湒湓湔湗湜湝湞"],
      ["8fc8a1", "湢湣湨湳湻湽溍溓溙溠溧溭溮溱溳溻溿滀滁滃滇滈滊滍滎滏滫滭滮滹滻滽漄漈漊漌漍漖漘漚漛漦漩漪漯漰漳漶漻漼漭潏潑潒潓潗潙潚潝潞潡潢潨潬潽潾澃澇澈澋澌澍澐澒澓澔澖澚澟澠澥澦澧澨澮澯澰澵澶澼濅濇濈濊"],
      ["8fc9a1", "濚濞濨濩濰濵濹濼濽瀀瀅瀆瀇瀍瀗瀠瀣瀯瀴瀷瀹瀼灃灄灈灉灊灋灔灕灝灞灎灤灥灬灮灵灶灾炁炅炆炔", 4, "炛炤炫炰炱炴炷烊烑烓烔烕烖烘烜烤烺焃", 4, "焋焌焏焞焠焫焭焯焰焱焸煁煅煆煇煊煋煐煒煗煚煜煞煠"],
      ["8fcaa1", "煨煹熀熅熇熌熒熚熛熠熢熯熰熲熳熺熿燀燁燄燋燌燓燖燙燚燜燸燾爀爇爈爉爓爗爚爝爟爤爫爯爴爸爹牁牂牃牅牎牏牐牓牕牖牚牜牞牠牣牨牫牮牯牱牷牸牻牼牿犄犉犍犎犓犛犨犭犮犱犴犾狁狇狉狌狕狖狘狟狥狳狴狺狻"],
      ["8fcba1", "狾猂猄猅猇猋猍猒猓猘猙猞猢猤猧猨猬猱猲猵猺猻猽獃獍獐獒獖獘獝獞獟獠獦獧獩獫獬獮獯獱獷獹獼玀玁玃玅玆玎玐玓玕玗玘玜玞玟玠玢玥玦玪玫玭玵玷玹玼玽玿珅珆珉珋珌珏珒珓珖珙珝珡珣珦珧珩珴珵珷珹珺珻珽"],
      ["8fcca1", "珿琀琁琄琇琊琑琚琛琤琦琨", 9, "琹瑀瑃瑄瑆瑇瑋瑍瑑瑒瑗瑝瑢瑦瑧瑨瑫瑭瑮瑱瑲璀璁璅璆璇璉璏璐璑璒璘璙璚璜璟璠璡璣璦璨璩璪璫璮璯璱璲璵璹璻璿瓈瓉瓌瓐瓓瓘瓚瓛瓞瓟瓤瓨瓪瓫瓯瓴瓺瓻瓼瓿甆"],
      ["8fcda1", "甒甖甗甠甡甤甧甩甪甯甶甹甽甾甿畀畃畇畈畎畐畒畗畞畟畡畯畱畹", 5, "疁疅疐疒疓疕疙疜疢疤疴疺疿痀痁痄痆痌痎痏痗痜痟痠痡痤痧痬痮痯痱痹瘀瘂瘃瘄瘇瘈瘊瘌瘏瘒瘓瘕瘖瘙瘛瘜瘝瘞瘣瘥瘦瘩瘭瘲瘳瘵瘸瘹"],
      ["8fcea1", "瘺瘼癊癀癁癃癄癅癉癋癕癙癟癤癥癭癮癯癱癴皁皅皌皍皕皛皜皝皟皠皢", 6, "皪皭皽盁盅盉盋盌盎盔盙盠盦盨盬盰盱盶盹盼眀眆眊眎眒眔眕眗眙眚眜眢眨眭眮眯眴眵眶眹眽眾睂睅睆睊睍睎睏睒睖睗睜睞睟睠睢"],
      ["8fcfa1", "睤睧睪睬睰睲睳睴睺睽瞀瞄瞌瞍瞔瞕瞖瞚瞟瞢瞧瞪瞮瞯瞱瞵瞾矃矉矑矒矕矙矞矟矠矤矦矪矬矰矱矴矸矻砅砆砉砍砎砑砝砡砢砣砭砮砰砵砷硃硄硇硈硌硎硒硜硞硠硡硣硤硨硪确硺硾碊碏碔碘碡碝碞碟碤碨碬碭碰碱碲碳"],
      ["8fd0a1", "碻碽碿磇磈磉磌磎磒磓磕磖磤磛磟磠磡磦磪磲磳礀磶磷磺磻磿礆礌礐礚礜礞礟礠礥礧礩礭礱礴礵礻礽礿祄祅祆祊祋祏祑祔祘祛祜祧祩祫祲祹祻祼祾禋禌禑禓禔禕禖禘禛禜禡禨禩禫禯禱禴禸离秂秄秇秈秊秏秔秖秚秝秞"],
      ["8fd1a1", "秠秢秥秪秫秭秱秸秼稂稃稇稉稊稌稑稕稛稞稡稧稫稭稯稰稴稵稸稹稺穄穅穇穈穌穕穖穙穜穝穟穠穥穧穪穭穵穸穾窀窂窅窆窊窋窐窑窔窞窠窣窬窳窵窹窻窼竆竉竌竎竑竛竨竩竫竬竱竴竻竽竾笇笔笟笣笧笩笪笫笭笮笯笰"],
      ["8fd2a1", "笱笴笽笿筀筁筇筎筕筠筤筦筩筪筭筯筲筳筷箄箉箎箐箑箖箛箞箠箥箬箯箰箲箵箶箺箻箼箽篂篅篈篊篔篖篗篙篚篛篨篪篲篴篵篸篹篺篼篾簁簂簃簄簆簉簋簌簎簏簙簛簠簥簦簨簬簱簳簴簶簹簺籆籊籕籑籒籓籙", 5],
      ["8fd3a1", "籡籣籧籩籭籮籰籲籹籼籽粆粇粏粔粞粠粦粰粶粷粺粻粼粿糄糇糈糉糍糏糓糔糕糗糙糚糝糦糩糫糵紃紇紈紉紏紑紒紓紖紝紞紣紦紪紭紱紼紽紾絀絁絇絈絍絑絓絗絙絚絜絝絥絧絪絰絸絺絻絿綁綂綃綅綆綈綋綌綍綑綖綗綝"],
      ["8fd4a1", "綞綦綧綪綳綶綷綹緂", 4, "緌緍緎緗緙縀緢緥緦緪緫緭緱緵緶緹緺縈縐縑縕縗縜縝縠縧縨縬縭縯縳縶縿繄繅繇繎繐繒繘繟繡繢繥繫繮繯繳繸繾纁纆纇纊纍纑纕纘纚纝纞缼缻缽缾缿罃罄罇罏罒罓罛罜罝罡罣罤罥罦罭"],
      ["8fd5a1", "罱罽罾罿羀羋羍羏羐羑羖羗羜羡羢羦羪羭羴羼羿翀翃翈翎翏翛翟翣翥翨翬翮翯翲翺翽翾翿耇耈耊耍耎耏耑耓耔耖耝耞耟耠耤耦耬耮耰耴耵耷耹耺耼耾聀聄聠聤聦聭聱聵肁肈肎肜肞肦肧肫肸肹胈胍胏胒胔胕胗胘胠胭胮"],
      ["8fd6a1", "胰胲胳胶胹胺胾脃脋脖脗脘脜脞脠脤脧脬脰脵脺脼腅腇腊腌腒腗腠腡腧腨腩腭腯腷膁膐膄膅膆膋膎膖膘膛膞膢膮膲膴膻臋臃臅臊臎臏臕臗臛臝臞臡臤臫臬臰臱臲臵臶臸臹臽臿舀舃舏舓舔舙舚舝舡舢舨舲舴舺艃艄艅艆"],
      ["8fd7a1", "艋艎艏艑艖艜艠艣艧艭艴艻艽艿芀芁芃芄芇芉芊芎芑芔芖芘芚芛芠芡芣芤芧芨芩芪芮芰芲芴芷芺芼芾芿苆苐苕苚苠苢苤苨苪苭苯苶苷苽苾茀茁茇茈茊茋荔茛茝茞茟茡茢茬茭茮茰茳茷茺茼茽荂荃荄荇荍荎荑荕荖荗荰荸"],
      ["8fd8a1", "荽荿莀莂莄莆莍莒莔莕莘莙莛莜莝莦莧莩莬莾莿菀菇菉菏菐菑菔菝荓菨菪菶菸菹菼萁萆萊萏萑萕萙莭萯萹葅葇葈葊葍葏葑葒葖葘葙葚葜葠葤葥葧葪葰葳葴葶葸葼葽蒁蒅蒒蒓蒕蒞蒦蒨蒩蒪蒯蒱蒴蒺蒽蒾蓀蓂蓇蓈蓌蓏蓓"],
      ["8fd9a1", "蓜蓧蓪蓯蓰蓱蓲蓷蔲蓺蓻蓽蔂蔃蔇蔌蔎蔐蔜蔞蔢蔣蔤蔥蔧蔪蔫蔯蔳蔴蔶蔿蕆蕏", 4, "蕖蕙蕜", 6, "蕤蕫蕯蕹蕺蕻蕽蕿薁薅薆薉薋薌薏薓薘薝薟薠薢薥薧薴薶薷薸薼薽薾薿藂藇藊藋藎薭藘藚藟藠藦藨藭藳藶藼"],
      ["8fdaa1", "藿蘀蘄蘅蘍蘎蘐蘑蘒蘘蘙蘛蘞蘡蘧蘩蘶蘸蘺蘼蘽虀虂虆虒虓虖虗虘虙虝虠", 4, "虩虬虯虵虶虷虺蚍蚑蚖蚘蚚蚜蚡蚦蚧蚨蚭蚱蚳蚴蚵蚷蚸蚹蚿蛀蛁蛃蛅蛑蛒蛕蛗蛚蛜蛠蛣蛥蛧蚈蛺蛼蛽蜄蜅蜇蜋蜎蜏蜐蜓蜔蜙蜞蜟蜡蜣"],
      ["8fdba1", "蜨蜮蜯蜱蜲蜹蜺蜼蜽蜾蝀蝃蝅蝍蝘蝝蝡蝤蝥蝯蝱蝲蝻螃", 6, "螋螌螐螓螕螗螘螙螞螠螣螧螬螭螮螱螵螾螿蟁蟈蟉蟊蟎蟕蟖蟙蟚蟜蟟蟢蟣蟤蟪蟫蟭蟱蟳蟸蟺蟿蠁蠃蠆蠉蠊蠋蠐蠙蠒蠓蠔蠘蠚蠛蠜蠞蠟蠨蠭蠮蠰蠲蠵"],
      ["8fdca1", "蠺蠼衁衃衅衈衉衊衋衎衑衕衖衘衚衜衟衠衤衩衱衹衻袀袘袚袛袜袟袠袨袪袺袽袾裀裊", 4, "裑裒裓裛裞裧裯裰裱裵裷褁褆褍褎褏褕褖褘褙褚褜褠褦褧褨褰褱褲褵褹褺褾襀襂襅襆襉襏襒襗襚襛襜襡襢襣襫襮襰襳襵襺"],
      ["8fdda1", "襻襼襽覉覍覐覔覕覛覜覟覠覥覰覴覵覶覷覼觔", 4, "觥觩觫觭觱觳觶觹觽觿訄訅訇訏訑訒訔訕訞訠訢訤訦訫訬訯訵訷訽訾詀詃詅詇詉詍詎詓詖詗詘詜詝詡詥詧詵詶詷詹詺詻詾詿誀誃誆誋誏誐誒誖誗誙誟誧誩誮誯誳"],
      ["8fdea1", "誶誷誻誾諃諆諈諉諊諑諓諔諕諗諝諟諬諰諴諵諶諼諿謅謆謋謑謜謞謟謊謭謰謷謼譂", 4, "譈譒譓譔譙譍譞譣譭譶譸譹譼譾讁讄讅讋讍讏讔讕讜讞讟谸谹谽谾豅豇豉豋豏豑豓豔豗豘豛豝豙豣豤豦豨豩豭豳豵豶豻豾貆"],
      ["8fdfa1", "貇貋貐貒貓貙貛貜貤貹貺賅賆賉賋賏賖賕賙賝賡賨賬賯賰賲賵賷賸賾賿贁贃贉贒贗贛赥赩赬赮赿趂趄趈趍趐趑趕趞趟趠趦趫趬趯趲趵趷趹趻跀跅跆跇跈跊跎跑跔跕跗跙跤跥跧跬跰趼跱跲跴跽踁踄踅踆踋踑踔踖踠踡踢"],
      ["8fe0a1", "踣踦踧踱踳踶踷踸踹踽蹀蹁蹋蹍蹎蹏蹔蹛蹜蹝蹞蹡蹢蹩蹬蹭蹯蹰蹱蹹蹺蹻躂躃躉躐躒躕躚躛躝躞躢躧躩躭躮躳躵躺躻軀軁軃軄軇軏軑軔軜軨軮軰軱軷軹軺軭輀輂輇輈輏輐輖輗輘輞輠輡輣輥輧輨輬輭輮輴輵輶輷輺轀轁"],
      ["8fe1a1", "轃轇轏轑", 4, "轘轝轞轥辝辠辡辤辥辦辵辶辸达迀迁迆迊迋迍运迒迓迕迠迣迤迨迮迱迵迶迻迾适逄逈逌逘逛逨逩逯逪逬逭逳逴逷逿遃遄遌遛遝遢遦遧遬遰遴遹邅邈邋邌邎邐邕邗邘邙邛邠邡邢邥邰邲邳邴邶邽郌邾郃"],
      ["8fe2a1", "郄郅郇郈郕郗郘郙郜郝郟郥郒郶郫郯郰郴郾郿鄀鄄鄅鄆鄈鄍鄐鄔鄖鄗鄘鄚鄜鄞鄠鄥鄢鄣鄧鄩鄮鄯鄱鄴鄶鄷鄹鄺鄼鄽酃酇酈酏酓酗酙酚酛酡酤酧酭酴酹酺酻醁醃醅醆醊醎醑醓醔醕醘醞醡醦醨醬醭醮醰醱醲醳醶醻醼醽醿"],
      ["8fe3a1", "釂釃釅釓釔釗釙釚釞釤釥釩釪釬", 5, "釷釹釻釽鈀鈁鈄鈅鈆鈇鈉鈊鈌鈐鈒鈓鈖鈘鈜鈝鈣鈤鈥鈦鈨鈮鈯鈰鈳鈵鈶鈸鈹鈺鈼鈾鉀鉂鉃鉆鉇鉊鉍鉎鉏鉑鉘鉙鉜鉝鉠鉡鉥鉧鉨鉩鉮鉯鉰鉵", 4, "鉻鉼鉽鉿銈銉銊銍銎銒銗"],
      ["8fe4a1", "銙銟銠銤銥銧銨銫銯銲銶銸銺銻銼銽銿", 4, "鋅鋆鋇鋈鋋鋌鋍鋎鋐鋓鋕鋗鋘鋙鋜鋝鋟鋠鋡鋣鋥鋧鋨鋬鋮鋰鋹鋻鋿錀錂錈錍錑錔錕錜錝錞錟錡錤錥錧錩錪錳錴錶錷鍇鍈鍉鍐鍑鍒鍕鍗鍘鍚鍞鍤鍥鍧鍩鍪鍭鍯鍰鍱鍳鍴鍶"],
      ["8fe5a1", "鍺鍽鍿鎀鎁鎂鎈鎊鎋鎍鎏鎒鎕鎘鎛鎞鎡鎣鎤鎦鎨鎫鎴鎵鎶鎺鎩鏁鏄鏅鏆鏇鏉", 4, "鏓鏙鏜鏞鏟鏢鏦鏧鏹鏷鏸鏺鏻鏽鐁鐂鐄鐈鐉鐍鐎鐏鐕鐖鐗鐟鐮鐯鐱鐲鐳鐴鐻鐿鐽鑃鑅鑈鑊鑌鑕鑙鑜鑟鑡鑣鑨鑫鑭鑮鑯鑱鑲钄钃镸镹"],
      ["8fe6a1", "镾閄閈閌閍閎閝閞閟閡閦閩閫閬閴閶閺閽閿闆闈闉闋闐闑闒闓闙闚闝闞闟闠闤闦阝阞阢阤阥阦阬阱阳阷阸阹阺阼阽陁陒陔陖陗陘陡陮陴陻陼陾陿隁隂隃隄隉隑隖隚隝隟隤隥隦隩隮隯隳隺雊雒嶲雘雚雝雞雟雩雯雱雺霂"],
      ["8fe7a1", "霃霅霉霚霛霝霡霢霣霨霱霳靁靃靊靎靏靕靗靘靚靛靣靧靪靮靳靶靷靸靻靽靿鞀鞉鞕鞖鞗鞙鞚鞞鞟鞢鞬鞮鞱鞲鞵鞶鞸鞹鞺鞼鞾鞿韁韄韅韇韉韊韌韍韎韐韑韔韗韘韙韝韞韠韛韡韤韯韱韴韷韸韺頇頊頙頍頎頔頖頜頞頠頣頦"],
      ["8fe8a1", "頫頮頯頰頲頳頵頥頾顄顇顊顑顒顓顖顗顙顚顢顣顥顦顪顬颫颭颮颰颴颷颸颺颻颿飂飅飈飌飡飣飥飦飧飪飳飶餂餇餈餑餕餖餗餚餛餜餟餢餦餧餫餱", 4, "餹餺餻餼饀饁饆饇饈饍饎饔饘饙饛饜饞饟饠馛馝馟馦馰馱馲馵"],
      ["8fe9a1", "馹馺馽馿駃駉駓駔駙駚駜駞駧駪駫駬駰駴駵駹駽駾騂騃騄騋騌騐騑騖騞騠騢騣騤騧騭騮騳騵騶騸驇驁驄驊驋驌驎驑驔驖驝骪骬骮骯骲骴骵骶骹骻骾骿髁髃髆髈髎髐髒髕髖髗髛髜髠髤髥髧髩髬髲髳髵髹髺髽髿", 4],
      ["8feaa1", "鬄鬅鬈鬉鬋鬌鬍鬎鬐鬒鬖鬙鬛鬜鬠鬦鬫鬭鬳鬴鬵鬷鬹鬺鬽魈魋魌魕魖魗魛魞魡魣魥魦魨魪", 4, "魳魵魷魸魹魿鮀鮄鮅鮆鮇鮉鮊鮋鮍鮏鮐鮔鮚鮝鮞鮦鮧鮩鮬鮰鮱鮲鮷鮸鮻鮼鮾鮿鯁鯇鯈鯎鯐鯗鯘鯝鯟鯥鯧鯪鯫鯯鯳鯷鯸"],
      ["8feba1", "鯹鯺鯽鯿鰀鰂鰋鰏鰑鰖鰘鰙鰚鰜鰞鰢鰣鰦", 4, "鰱鰵鰶鰷鰽鱁鱃鱄鱅鱉鱊鱎鱏鱐鱓鱔鱖鱘鱛鱝鱞鱟鱣鱩鱪鱜鱫鱨鱮鱰鱲鱵鱷鱻鳦鳲鳷鳹鴋鴂鴑鴗鴘鴜鴝鴞鴯鴰鴲鴳鴴鴺鴼鵅鴽鵂鵃鵇鵊鵓鵔鵟鵣鵢鵥鵩鵪鵫鵰鵶鵷鵻"],
      ["8feca1", "鵼鵾鶃鶄鶆鶊鶍鶎鶒鶓鶕鶖鶗鶘鶡鶪鶬鶮鶱鶵鶹鶼鶿鷃鷇鷉鷊鷔鷕鷖鷗鷚鷞鷟鷠鷥鷧鷩鷫鷮鷰鷳鷴鷾鸊鸂鸇鸎鸐鸑鸒鸕鸖鸙鸜鸝鹺鹻鹼麀麂麃麄麅麇麎麏麖麘麛麞麤麨麬麮麯麰麳麴麵黆黈黋黕黟黤黧黬黭黮黰黱黲黵"],
      ["8feda1", "黸黿鼂鼃鼉鼏鼐鼑鼒鼔鼖鼗鼙鼚鼛鼟鼢鼦鼪鼫鼯鼱鼲鼴鼷鼹鼺鼼鼽鼿齁齃", 4, "齓齕齖齗齘齚齝齞齨齩齭", 4, "齳齵齺齽龏龐龑龒龔龖龗龞龡龢龣龥"]
    ];
  }
});

// node_modules/iconv-lite/encodings/tables/cp936.json
var require_cp936 = __commonJS({
  "node_modules/iconv-lite/encodings/tables/cp936.json"(exports2, module2) {
    module2.exports = [
      ["0", "\0", 127, "€"],
      ["8140", "丂丄丅丆丏丒丗丟丠両丣並丩丮丯丱丳丵丷丼乀乁乂乄乆乊乑乕乗乚乛乢乣乤乥乧乨乪", 5, "乲乴", 9, "乿", 6, "亇亊"],
      ["8180", "亐亖亗亙亜亝亞亣亪亯亰亱亴亶亷亸亹亼亽亾仈仌仏仐仒仚仛仜仠仢仦仧仩仭仮仯仱仴仸仹仺仼仾伀伂", 6, "伋伌伒", 4, "伜伝伡伣伨伩伬伭伮伱伳伵伷伹伻伾", 4, "佄佅佇", 5, "佒佔佖佡佢佦佨佪佫佭佮佱佲併佷佸佹佺佽侀侁侂侅來侇侊侌侎侐侒侓侕侖侘侙侚侜侞侟価侢"],
      ["8240", "侤侫侭侰", 4, "侶", 8, "俀俁係俆俇俈俉俋俌俍俒", 4, "俙俛俠俢俤俥俧俫俬俰俲俴俵俶俷俹俻俼俽俿", 11],
      ["8280", "個倎倐們倓倕倖倗倛倝倞倠倢倣値倧倫倯", 10, "倻倽倿偀偁偂偄偅偆偉偊偋偍偐", 4, "偖偗偘偙偛偝", 7, "偦", 5, "偭", 8, "偸偹偺偼偽傁傂傃傄傆傇傉傊傋傌傎", 20, "傤傦傪傫傭", 4, "傳", 6, "傼"],
      ["8340", "傽", 17, "僐", 5, "僗僘僙僛", 10, "僨僩僪僫僯僰僱僲僴僶", 4, "僼", 9, "儈"],
      ["8380", "儉儊儌", 5, "儓", 13, "儢", 28, "兂兇兊兌兎兏児兒兓兗兘兙兛兝", 4, "兣兤兦內兩兪兯兲兺兾兿冃冄円冇冊冋冎冏冐冑冓冔冘冚冝冞冟冡冣冦", 4, "冭冮冴冸冹冺冾冿凁凂凃凅凈凊凍凎凐凒", 5],
      ["8440", "凘凙凚凜凞凟凢凣凥", 5, "凬凮凱凲凴凷凾刄刅刉刋刌刏刐刓刔刕刜刞刟刡刢刣別刦刧刪刬刯刱刲刴刵刼刾剄", 5, "剋剎剏剒剓剕剗剘"],
      ["8480", "剙剚剛剝剟剠剢剣剤剦剨剫剬剭剮剰剱剳", 9, "剾劀劃", 4, "劉", 6, "劑劒劔", 6, "劜劤劥劦劧劮劯劰労", 9, "勀勁勂勄勅勆勈勊勌勍勎勏勑勓勔動勗務", 5, "勠勡勢勣勥", 10, "勱", 7, "勻勼勽匁匂匃匄匇匉匊匋匌匎"],
      ["8540", "匑匒匓匔匘匛匜匞匟匢匤匥匧匨匩匫匬匭匯", 9, "匼匽區卂卄卆卋卌卍卐協単卙卛卝卥卨卪卬卭卲卶卹卻卼卽卾厀厁厃厇厈厊厎厏"],
      ["8580", "厐", 4, "厖厗厙厛厜厞厠厡厤厧厪厫厬厭厯", 6, "厷厸厹厺厼厽厾叀參", 4, "収叏叐叒叓叕叚叜叝叞叡叢叧叴叺叾叿吀吂吅吇吋吔吘吙吚吜吢吤吥吪吰吳吶吷吺吽吿呁呂呄呅呇呉呌呍呎呏呑呚呝", 4, "呣呥呧呩", 7, "呴呹呺呾呿咁咃咅咇咈咉咊咍咑咓咗咘咜咞咟咠咡"],
      ["8640", "咢咥咮咰咲咵咶咷咹咺咼咾哃哅哊哋哖哘哛哠", 4, "哫哬哯哰哱哴", 5, "哻哾唀唂唃唄唅唈唊", 4, "唒唓唕", 5, "唜唝唞唟唡唥唦"],
      ["8680", "唨唩唫唭唲唴唵唶唸唹唺唻唽啀啂啅啇啈啋", 4, "啑啒啓啔啗", 4, "啝啞啟啠啢啣啨啩啫啯", 5, "啹啺啽啿喅喆喌喍喎喐喒喓喕喖喗喚喛喞喠", 6, "喨", 8, "喲喴営喸喺喼喿", 4, "嗆嗇嗈嗊嗋嗎嗏嗐嗕嗗", 4, "嗞嗠嗢嗧嗩嗭嗮嗰嗱嗴嗶嗸", 4, "嗿嘂嘃嘄嘅"],
      ["8740", "嘆嘇嘊嘋嘍嘐", 7, "嘙嘚嘜嘝嘠嘡嘢嘥嘦嘨嘩嘪嘫嘮嘯嘰嘳嘵嘷嘸嘺嘼嘽嘾噀", 11, "噏", 4, "噕噖噚噛噝", 4],
      ["8780", "噣噥噦噧噭噮噯噰噲噳噴噵噷噸噹噺噽", 7, "嚇", 6, "嚐嚑嚒嚔", 14, "嚤", 10, "嚰", 6, "嚸嚹嚺嚻嚽", 12, "囋", 8, "囕囖囘囙囜団囥", 5, "囬囮囯囲図囶囷囸囻囼圀圁圂圅圇國", 6],
      ["8840", "園", 9, "圝圞圠圡圢圤圥圦圧圫圱圲圴", 4, "圼圽圿坁坃坄坅坆坈坉坋坒", 4, "坘坙坢坣坥坧坬坮坰坱坲坴坵坸坹坺坽坾坿垀"],
      ["8880", "垁垇垈垉垊垍", 4, "垔", 6, "垜垝垞垟垥垨垪垬垯垰垱垳垵垶垷垹", 8, "埄", 6, "埌埍埐埑埓埖埗埛埜埞埡埢埣埥", 7, "埮埰埱埲埳埵埶執埻埼埾埿堁堃堄堅堈堉堊堌堎堏堐堒堓堔堖堗堘堚堛堜堝堟堢堣堥", 4, "堫", 4, "報堲堳場堶", 7],
      ["8940", "堾", 5, "塅", 6, "塎塏塐塒塓塕塖塗塙", 4, "塟", 5, "塦", 4, "塭", 16, "塿墂墄墆墇墈墊墋墌"],
      ["8980", "墍", 4, "墔", 4, "墛墜墝墠", 7, "墪", 17, "墽墾墿壀壂壃壄壆", 10, "壒壓壔壖", 13, "壥", 5, "壭壯壱売壴壵壷壸壺", 7, "夃夅夆夈", 4, "夎夐夑夒夓夗夘夛夝夞夠夡夢夣夦夨夬夰夲夳夵夶夻"],
      ["8a40", "夽夾夿奀奃奅奆奊奌奍奐奒奓奙奛", 4, "奡奣奤奦", 12, "奵奷奺奻奼奾奿妀妅妉妋妌妎妏妐妑妔妕妘妚妛妜妝妟妠妡妢妦"],
      ["8a80", "妧妬妭妰妱妳", 5, "妺妼妽妿", 6, "姇姈姉姌姍姎姏姕姖姙姛姞", 4, "姤姦姧姩姪姫姭", 11, "姺姼姽姾娀娂娊娋娍娎娏娐娒娔娕娖娗娙娚娛娝娞娡娢娤娦娧娨娪", 6, "娳娵娷", 4, "娽娾娿婁", 4, "婇婈婋", 9, "婖婗婘婙婛", 5],
      ["8b40", "婡婣婤婥婦婨婩婫", 8, "婸婹婻婼婽婾媀", 17, "媓", 6, "媜", 13, "媫媬"],
      ["8b80", "媭", 4, "媴媶媷媹", 4, "媿嫀嫃", 5, "嫊嫋嫍", 4, "嫓嫕嫗嫙嫚嫛嫝嫞嫟嫢嫤嫥嫧嫨嫪嫬", 4, "嫲", 22, "嬊", 11, "嬘", 25, "嬳嬵嬶嬸", 7, "孁", 6],
      ["8c40", "孈", 7, "孒孖孞孠孡孧孨孫孭孮孯孲孴孶孷學孹孻孼孾孿宂宆宊宍宎宐宑宒宔宖実宧宨宩宬宭宮宯宱宲宷宺宻宼寀寁寃寈寉寊寋寍寎寏"],
      ["8c80", "寑寔", 8, "寠寢寣實寧審", 4, "寯寱", 6, "寽対尀専尃尅將專尋尌對導尐尒尓尗尙尛尞尟尠尡尣尦尨尩尪尫尭尮尯尰尲尳尵尶尷屃屄屆屇屌屍屒屓屔屖屗屘屚屛屜屝屟屢層屧", 6, "屰屲", 6, "屻屼屽屾岀岃", 4, "岉岊岋岎岏岒岓岕岝", 4, "岤", 4],
      ["8d40", "岪岮岯岰岲岴岶岹岺岻岼岾峀峂峃峅", 5, "峌", 5, "峓", 5, "峚", 6, "峢峣峧峩峫峬峮峯峱", 9, "峼", 4],
      ["8d80", "崁崄崅崈", 5, "崏", 4, "崕崗崘崙崚崜崝崟", 4, "崥崨崪崫崬崯", 4, "崵", 7, "崿", 7, "嵈嵉嵍", 10, "嵙嵚嵜嵞", 10, "嵪嵭嵮嵰嵱嵲嵳嵵", 12, "嶃", 21, "嶚嶛嶜嶞嶟嶠"],
      ["8e40", "嶡", 21, "嶸", 12, "巆", 6, "巎", 12, "巜巟巠巣巤巪巬巭"],
      ["8e80", "巰巵巶巸", 4, "巿帀帄帇帉帊帋帍帎帒帓帗帞", 7, "帨", 4, "帯帰帲", 4, "帹帺帾帿幀幁幃幆", 5, "幍", 6, "幖", 4, "幜幝幟幠幣", 14, "幵幷幹幾庁庂広庅庈庉庌庍庎庒庘庛庝庡庢庣庤庨", 4, "庮", 4, "庴庺庻庼庽庿", 6],
      ["8f40", "廆廇廈廋", 5, "廔廕廗廘廙廚廜", 11, "廩廫", 8, "廵廸廹廻廼廽弅弆弇弉弌弍弎弐弒弔弖弙弚弜弝弞弡弢弣弤"],
      ["8f80", "弨弫弬弮弰弲", 6, "弻弽弾弿彁", 14, "彑彔彙彚彛彜彞彟彠彣彥彧彨彫彮彯彲彴彵彶彸彺彽彾彿徃徆徍徎徏徑従徔徖徚徛徝從徟徠徢", 5, "復徫徬徯", 5, "徶徸徹徺徻徾", 4, "忇忈忊忋忎忓忔忕忚忛応忞忟忢忣忥忦忨忩忬忯忰忲忳忴忶忷忹忺忼怇"],
      ["9040", "怈怉怋怌怐怑怓怗怘怚怞怟怢怣怤怬怭怮怰", 4, "怶", 4, "怽怾恀恄", 6, "恌恎恏恑恓恔恖恗恘恛恜恞恟恠恡恥恦恮恱恲恴恵恷恾悀"],
      ["9080", "悁悂悅悆悇悈悊悋悎悏悐悑悓悕悗悘悙悜悞悡悢悤悥悧悩悪悮悰悳悵悶悷悹悺悽", 7, "惇惈惉惌", 4, "惒惓惔惖惗惙惛惞惡", 4, "惪惱惲惵惷惸惻", 4, "愂愃愄愅愇愊愋愌愐", 4, "愖愗愘愙愛愜愝愞愡愢愥愨愩愪愬", 18, "慀", 6],
      ["9140", "慇慉態慍慏慐慒慓慔慖", 6, "慞慟慠慡慣慤慥慦慩", 6, "慱慲慳慴慶慸", 18, "憌憍憏", 4, "憕"],
      ["9180", "憖", 6, "憞", 8, "憪憫憭", 9, "憸", 5, "憿懀懁懃", 4, "應懌", 4, "懓懕", 16, "懧", 13, "懶", 8, "戀", 5, "戇戉戓戔戙戜戝戞戠戣戦戧戨戩戫戭戯戰戱戲戵戶戸", 4, "扂扄扅扆扊"],
      ["9240", "扏扐払扖扗扙扚扜", 6, "扤扥扨扱扲扴扵扷扸扺扻扽抁抂抃抅抆抇抈抋", 5, "抔抙抜抝択抣抦抧抩抪抭抮抯抰抲抳抴抶抷抸抺抾拀拁"],
      ["9280", "拃拋拏拑拕拝拞拠拡拤拪拫拰拲拵拸拹拺拻挀挃挄挅挆挊挋挌挍挏挐挒挓挔挕挗挘挙挜挦挧挩挬挭挮挰挱挳", 5, "挻挼挾挿捀捁捄捇捈捊捑捒捓捔捖", 7, "捠捤捥捦捨捪捫捬捯捰捲捳捴捵捸捹捼捽捾捿掁掃掄掅掆掋掍掑掓掔掕掗掙", 6, "採掤掦掫掯掱掲掵掶掹掻掽掿揀"],
      ["9340", "揁揂揃揅揇揈揊揋揌揑揓揔揕揗", 6, "揟揢揤", 4, "揫揬揮揯揰揱揳揵揷揹揺揻揼揾搃搄搆", 4, "損搎搑搒搕", 5, "搝搟搢搣搤"],
      ["9380", "搥搧搨搩搫搮", 5, "搵", 4, "搻搼搾摀摂摃摉摋", 6, "摓摕摖摗摙", 4, "摟", 7, "摨摪摫摬摮", 9, "摻", 6, "撃撆撈", 8, "撓撔撗撘撚撛撜撝撟", 4, "撥撦撧撨撪撫撯撱撲撳撴撶撹撻撽撾撿擁擃擄擆", 6, "擏擑擓擔擕擖擙據"],
      ["9440", "擛擜擝擟擠擡擣擥擧", 24, "攁", 7, "攊", 7, "攓", 4, "攙", 8],
      ["9480", "攢攣攤攦", 4, "攬攭攰攱攲攳攷攺攼攽敀", 4, "敆敇敊敋敍敎敐敒敓敔敗敘敚敜敟敠敡敤敥敧敨敩敪敭敮敯敱敳敵敶數", 14, "斈斉斊斍斎斏斒斔斕斖斘斚斝斞斠斢斣斦斨斪斬斮斱", 7, "斺斻斾斿旀旂旇旈旉旊旍旐旑旓旔旕旘", 7, "旡旣旤旪旫"],
      ["9540", "旲旳旴旵旸旹旻", 4, "昁昄昅昇昈昉昋昍昐昑昒昖昗昘昚昛昜昞昡昢昣昤昦昩昪昫昬昮昰昲昳昷", 4, "昽昿晀時晄", 6, "晍晎晐晑晘"],
      ["9580", "晙晛晜晝晞晠晢晣晥晧晩", 4, "晱晲晳晵晸晹晻晼晽晿暀暁暃暅暆暈暉暊暋暍暎暏暐暒暓暔暕暘", 4, "暞", 8, "暩", 4, "暯", 4, "暵暶暷暸暺暻暼暽暿", 25, "曚曞", 7, "曧曨曪", 5, "曱曵曶書曺曻曽朁朂會"],
      ["9640", "朄朅朆朇朌朎朏朑朒朓朖朘朙朚朜朞朠", 5, "朧朩朮朰朲朳朶朷朸朹朻朼朾朿杁杄杅杇杊杋杍杒杔杕杗", 4, "杝杢杣杤杦杧杫杬杮東杴杶"],
      ["9680", "杸杹杺杻杽枀枂枃枅枆枈枊枌枍枎枏枑枒枓枔枖枙枛枟枠枡枤枦枩枬枮枱枲枴枹", 7, "柂柅", 9, "柕柖柗柛柟柡柣柤柦柧柨柪柫柭柮柲柵", 7, "柾栁栂栃栄栆栍栐栒栔栕栘", 4, "栞栟栠栢", 6, "栫", 6, "栴栵栶栺栻栿桇桋桍桏桒桖", 5],
      ["9740", "桜桝桞桟桪桬", 7, "桵桸", 8, "梂梄梇", 7, "梐梑梒梔梕梖梘", 9, "梣梤梥梩梪梫梬梮梱梲梴梶梷梸"],
      ["9780", "梹", 6, "棁棃", 5, "棊棌棎棏棐棑棓棔棖棗棙棛", 4, "棡棢棤", 9, "棯棲棳棴棶棷棸棻棽棾棿椀椂椃椄椆", 4, "椌椏椑椓", 11, "椡椢椣椥", 7, "椮椯椱椲椳椵椶椷椸椺椻椼椾楀楁楃", 16, "楕楖楘楙楛楜楟"],
      ["9840", "楡楢楤楥楧楨楩楪楬業楯楰楲", 4, "楺楻楽楾楿榁榃榅榊榋榌榎", 5, "榖榗榙榚榝", 9, "榩榪榬榮榯榰榲榳榵榶榸榹榺榼榽"],
      ["9880", "榾榿槀槂", 7, "構槍槏槑槒槓槕", 5, "槜槝槞槡", 11, "槮槯槰槱槳", 9, "槾樀", 9, "樋", 11, "標", 5, "樠樢", 5, "権樫樬樭樮樰樲樳樴樶", 6, "樿", 4, "橅橆橈", 7, "橑", 6, "橚"],
      ["9940", "橜", 4, "橢橣橤橦", 10, "橲", 6, "橺橻橽橾橿檁檂檃檅", 8, "檏檒", 4, "檘", 7, "檡", 5],
      ["9980", "檧檨檪檭", 114, "欥欦欨", 6],
      ["9a40", "欯欰欱欳欴欵欶欸欻欼欽欿歀歁歂歄歅歈歊歋歍", 11, "歚", 7, "歨歩歫", 13, "歺歽歾歿殀殅殈"],
      ["9a80", "殌殎殏殐殑殔殕殗殘殙殜", 4, "殢", 7, "殫", 7, "殶殸", 6, "毀毃毄毆", 4, "毌毎毐毑毘毚毜", 4, "毢", 7, "毬毭毮毰毱毲毴毶毷毸毺毻毼毾", 6, "氈", 4, "氎氒気氜氝氞氠氣氥氫氬氭氱氳氶氷氹氺氻氼氾氿汃汄汅汈汋", 4, "汑汒汓汖汘"],
      ["9b40", "汙汚汢汣汥汦汧汫", 4, "汱汳汵汷汸決汻汼汿沀沄沇沊沋沍沎沑沒沕沖沗沘沚沜沝沞沠沢沨沬沯沰沴沵沶沷沺泀況泂泃泆泇泈泋泍泎泏泑泒泘"],
      ["9b80", "泙泚泜泝泟泤泦泧泩泬泭泲泴泹泿洀洂洃洅洆洈洉洊洍洏洐洑洓洔洕洖洘洜洝洟", 5, "洦洨洩洬洭洯洰洴洶洷洸洺洿浀浂浄浉浌浐浕浖浗浘浛浝浟浡浢浤浥浧浨浫浬浭浰浱浲浳浵浶浹浺浻浽", 4, "涃涄涆涇涊涋涍涏涐涒涖", 4, "涜涢涥涬涭涰涱涳涴涶涷涹", 5, "淁淂淃淈淉淊"],
      ["9c40", "淍淎淏淐淒淓淔淕淗淚淛淜淟淢淣淥淧淨淩淪淭淯淰淲淴淵淶淸淺淽", 7, "渆渇済渉渋渏渒渓渕渘渙減渜渞渟渢渦渧渨渪測渮渰渱渳渵"],
      ["9c80", "渶渷渹渻", 7, "湅", 7, "湏湐湑湒湕湗湙湚湜湝湞湠", 10, "湬湭湯", 14, "満溁溂溄溇溈溊", 4, "溑", 6, "溙溚溛溝溞溠溡溣溤溦溨溩溫溬溭溮溰溳溵溸溹溼溾溿滀滃滄滅滆滈滉滊滌滍滎滐滒滖滘滙滛滜滝滣滧滪", 5],
      ["9d40", "滰滱滲滳滵滶滷滸滺", 7, "漃漄漅漇漈漊", 4, "漐漑漒漖", 9, "漡漢漣漥漦漧漨漬漮漰漲漴漵漷", 6, "漿潀潁潂"],
      ["9d80", "潃潄潅潈潉潊潌潎", 9, "潙潚潛潝潟潠潡潣潤潥潧", 5, "潯潰潱潳潵潶潷潹潻潽", 6, "澅澆澇澊澋澏", 12, "澝澞澟澠澢", 4, "澨", 10, "澴澵澷澸澺", 5, "濁濃", 5, "濊", 6, "濓", 10, "濟濢濣濤濥"],
      ["9e40", "濦", 7, "濰", 32, "瀒", 7, "瀜", 6, "瀤", 6],
      ["9e80", "瀫", 9, "瀶瀷瀸瀺", 17, "灍灎灐", 13, "灟", 11, "灮灱灲灳灴灷灹灺灻災炁炂炃炄炆炇炈炋炌炍炏炐炑炓炗炘炚炛炞", 12, "炰炲炴炵炶為炾炿烄烅烆烇烉烋", 12, "烚"],
      ["9f40", "烜烝烞烠烡烢烣烥烪烮烰", 6, "烸烺烻烼烾", 10, "焋", 4, "焑焒焔焗焛", 10, "焧", 7, "焲焳焴"],
      ["9f80", "焵焷", 13, "煆煇煈煉煋煍煏", 12, "煝煟", 4, "煥煩", 4, "煯煰煱煴煵煶煷煹煻煼煾", 5, "熅", 4, "熋熌熍熎熐熑熒熓熕熖熗熚", 4, "熡", 6, "熩熪熫熭", 5, "熴熶熷熸熺", 8, "燄", 9, "燏", 4],
      ["a040", "燖", 9, "燡燢燣燤燦燨", 5, "燯", 9, "燺", 11, "爇", 19],
      ["a080", "爛爜爞", 9, "爩爫爭爮爯爲爳爴爺爼爾牀", 6, "牉牊牋牎牏牐牑牓牔牕牗牘牚牜牞牠牣牤牥牨牪牫牬牭牰牱牳牴牶牷牸牻牼牽犂犃犅", 4, "犌犎犐犑犓", 11, "犠", 11, "犮犱犲犳犵犺", 6, "狅狆狇狉狊狋狌狏狑狓狔狕狖狘狚狛"],
      ["a1a1", "　、。·ˉˇ¨〃々—～‖…‘’“”〔〕〈", 7, "〖〗【】±×÷∶∧∨∑∏∪∩∈∷√⊥∥∠⌒⊙∫∮≡≌≈∽∝≠≮≯≤≥∞∵∴♂♀°′″℃＄¤￠￡‰§№☆★○●◎◇◆□■△▲※→←↑↓〓"],
      ["a2a1", "ⅰ", 9],
      ["a2b1", "⒈", 19, "⑴", 19, "①", 9],
      ["a2e5", "㈠", 9],
      ["a2f1", "Ⅰ", 11],
      ["a3a1", "！＂＃￥％", 88, "￣"],
      ["a4a1", "ぁ", 82],
      ["a5a1", "ァ", 85],
      ["a6a1", "Α", 16, "Σ", 6],
      ["a6c1", "α", 16, "σ", 6],
      ["a6e0", "︵︶︹︺︿﹀︽︾﹁﹂﹃﹄"],
      ["a6ee", "︻︼︷︸︱"],
      ["a6f4", "︳︴"],
      ["a7a1", "А", 5, "ЁЖ", 25],
      ["a7d1", "а", 5, "ёж", 25],
      ["a840", "ˊˋ˙–―‥‵℅℉↖↗↘↙∕∟∣≒≦≧⊿═", 35, "▁", 6],
      ["a880", "█", 7, "▓▔▕▼▽◢◣◤◥☉⊕〒〝〞"],
      ["a8a1", "āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüêɑ"],
      ["a8bd", "ńň"],
      ["a8c0", "ɡ"],
      ["a8c5", "ㄅ", 36],
      ["a940", "〡", 8, "㊣㎎㎏㎜㎝㎞㎡㏄㏎㏑㏒㏕︰￢￤"],
      ["a959", "℡㈱"],
      ["a95c", "‐"],
      ["a960", "ー゛゜ヽヾ〆ゝゞ﹉", 9, "﹔﹕﹖﹗﹙", 8],
      ["a980", "﹢", 4, "﹨﹩﹪﹫"],
      ["a996", "〇"],
      ["a9a4", "─", 75],
      ["aa40", "狜狝狟狢", 5, "狪狫狵狶狹狽狾狿猀猂猄", 5, "猋猌猍猏猐猑猒猔猘猙猚猟猠猣猤猦猧猨猭猯猰猲猳猵猶猺猻猼猽獀", 8],
      ["aa80", "獉獊獋獌獎獏獑獓獔獕獖獘", 7, "獡", 10, "獮獰獱"],
      ["ab40", "獲", 11, "獿", 4, "玅玆玈玊玌玍玏玐玒玓玔玕玗玘玙玚玜玝玞玠玡玣", 5, "玪玬玭玱玴玵玶玸玹玼玽玾玿珁珃", 4],
      ["ab80", "珋珌珎珒", 6, "珚珛珜珝珟珡珢珣珤珦珨珪珫珬珮珯珰珱珳", 4],
      ["ac40", "珸", 10, "琄琇琈琋琌琍琎琑", 8, "琜", 5, "琣琤琧琩琫琭琯琱琲琷", 4, "琽琾琿瑀瑂", 11],
      ["ac80", "瑎", 6, "瑖瑘瑝瑠", 12, "瑮瑯瑱", 4, "瑸瑹瑺"],
      ["ad40", "瑻瑼瑽瑿璂璄璅璆璈璉璊璌璍璏璑", 10, "璝璟", 7, "璪", 15, "璻", 12],
      ["ad80", "瓈", 9, "瓓", 8, "瓝瓟瓡瓥瓧", 6, "瓰瓱瓲"],
      ["ae40", "瓳瓵瓸", 6, "甀甁甂甃甅", 7, "甎甐甒甔甕甖甗甛甝甞甠", 4, "甦甧甪甮甴甶甹甼甽甿畁畂畃畄畆畇畉畊畍畐畑畒畓畕畖畗畘"],
      ["ae80", "畝", 7, "畧畨畩畫", 6, "畳畵當畷畺", 4, "疀疁疂疄疅疇"],
      ["af40", "疈疉疊疌疍疎疐疓疕疘疛疜疞疢疦", 4, "疭疶疷疺疻疿痀痁痆痋痌痎痏痐痑痓痗痙痚痜痝痟痠痡痥痩痬痭痮痯痲痳痵痶痷痸痺痻痽痾瘂瘄瘆瘇"],
      ["af80", "瘈瘉瘋瘍瘎瘏瘑瘒瘓瘔瘖瘚瘜瘝瘞瘡瘣瘧瘨瘬瘮瘯瘱瘲瘶瘷瘹瘺瘻瘽癁療癄"],
      ["b040", "癅", 6, "癎", 5, "癕癗", 4, "癝癟癠癡癢癤", 6, "癬癭癮癰", 7, "癹発發癿皀皁皃皅皉皊皌皍皏皐皒皔皕皗皘皚皛"],
      ["b080", "皜", 7, "皥", 8, "皯皰皳皵", 9, "盀盁盃啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭吧笆八疤巴拔跋靶把耙坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆榜膀绑棒磅蚌镑傍谤苞胞包褒剥"],
      ["b140", "盄盇盉盋盌盓盕盙盚盜盝盞盠", 4, "盦", 7, "盰盳盵盶盷盺盻盽盿眀眂眃眅眆眊県眎", 10, "眛眜眝眞眡眣眤眥眧眪眫"],
      ["b180", "眬眮眰", 4, "眹眻眽眾眿睂睄睅睆睈", 7, "睒", 7, "睜薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛鞭边编贬扁便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳"],
      ["b240", "睝睞睟睠睤睧睩睪睭", 11, "睺睻睼瞁瞂瞃瞆", 5, "瞏瞐瞓", 11, "瞡瞣瞤瞦瞨瞫瞭瞮瞯瞱瞲瞴瞶", 4],
      ["b280", "瞼瞾矀", 12, "矎", 8, "矘矙矚矝", 4, "矤病并玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤昌猖"],
      ["b340", "矦矨矪矯矰矱矲矴矵矷矹矺矻矼砃", 5, "砊砋砎砏砐砓砕砙砛砞砠砡砢砤砨砪砫砮砯砱砲砳砵砶砽砿硁硂硃硄硆硈硉硊硋硍硏硑硓硔硘硙硚"],
      ["b380", "硛硜硞", 11, "硯", 7, "硸硹硺硻硽", 6, "场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚"],
      ["b440", "碄碅碆碈碊碋碏碐碒碔碕碖碙碝碞碠碢碤碦碨", 7, "碵碶碷碸確碻碼碽碿磀磂磃磄磆磇磈磌磍磎磏磑磒磓磖磗磘磚", 9],
      ["b480", "磤磥磦磧磩磪磫磭", 4, "磳磵磶磸磹磻", 5, "礂礃礄礆", 6, "础储矗搐触处揣川穿椽传船喘串疮窗幢床闯创吹炊捶锤垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆瘁粹淬翠村存寸磋撮搓措挫错搭达答瘩打大呆歹傣戴带殆代贷袋待逮"],
      ["b540", "礍", 5, "礔", 9, "礟", 4, "礥", 14, "礵", 4, "礽礿祂祃祄祅祇祊", 8, "祔祕祘祙祡祣"],
      ["b580", "祤祦祩祪祫祬祮祰", 6, "祹祻", 4, "禂禃禆禇禈禉禋禌禍禎禐禑禒怠耽担丹单郸掸胆旦氮但惮淡诞弹蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄涤翟嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓调跌爹碟蝶迭谍叠"],
      ["b640", "禓", 6, "禛", 11, "禨", 10, "禴", 4, "禼禿秂秄秅秇秈秊秌秎秏秐秓秔秖秗秙", 5, "秠秡秢秥秨秪"],
      ["b680", "秬秮秱", 6, "秹秺秼秾秿稁稄稅稇稈稉稊稌稏", 4, "稕稖稘稙稛稜丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿囤钝盾遁掇哆多夺垛躲朵跺舵剁惰堕蛾峨鹅俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二"],
      ["b740", "稝稟稡稢稤", 14, "稴稵稶稸稺稾穀", 5, "穇", 9, "穒", 4, "穘", 16],
      ["b780", "穩", 6, "穱穲穳穵穻穼穽穾窂窅窇窉窊窋窌窎窏窐窓窔窙窚窛窞窡窢贰发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服"],
      ["b840", "窣窤窧窩窪窫窮", 4, "窴", 10, "竀", 10, "竌", 9, "竗竘竚竛竜竝竡竢竤竧", 5, "竮竰竱竲竳"],
      ["b880", "竴", 4, "竻竼竾笀笁笂笅笇笉笌笍笎笐笒笓笖笗笘笚笜笝笟笡笢笣笧笩笭浮涪福袱弗甫抚辅俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐噶嘎该改概钙盖溉干甘杆柑竿肝赶感秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞镐稿告哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各给根跟耕更庚羹"],
      ["b940", "笯笰笲笴笵笶笷笹笻笽笿", 5, "筆筈筊筍筎筓筕筗筙筜筞筟筡筣", 10, "筯筰筳筴筶筸筺筼筽筿箁箂箃箄箆", 6, "箎箏"],
      ["b980", "箑箒箓箖箘箙箚箛箞箟箠箣箤箥箮箯箰箲箳箵箶箷箹", 7, "篂篃範埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过哈"],
      ["ba40", "篅篈築篊篋篍篎篏篐篒篔", 4, "篛篜篞篟篠篢篣篤篧篨篩篫篬篭篯篰篲", 4, "篸篹篺篻篽篿", 7, "簈簉簊簍簎簐", 5, "簗簘簙"],
      ["ba80", "簚", 4, "簠", 5, "簨簩簫", 12, "簹", 5, "籂骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺嘿黑痕很狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖"],
      ["bb40", "籃", 9, "籎", 36, "籵", 5, "籾", 9],
      ["bb80", "粈粊", 6, "粓粔粖粙粚粛粠粡粣粦粧粨粩粫粬粭粯粰粴", 4, "粺粻弧虎唬护互沪户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸击圾基机畸稽积箕"],
      ["bc40", "粿糀糂糃糄糆糉糋糎", 6, "糘糚糛糝糞糡", 6, "糩", 5, "糰", 7, "糹糺糼", 13, "紋", 5],
      ["bc80", "紑", 14, "紡紣紤紥紦紨紩紪紬紭紮細", 6, "肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件"],
      ["bd40", "紷", 54, "絯", 7],
      ["bd80", "絸", 32, "健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸"],
      ["be40", "継", 12, "綧", 6, "綯", 42],
      ["be80", "線", 32, "尽劲荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎就疚鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵觉决诀绝均菌钧军君峻"],
      ["bf40", "緻", 62],
      ["bf80", "縺縼", 4, "繂", 4, "繈", 21, "俊竣浚郡骏喀咖卡咯开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤靠坷苛柯棵磕颗科壳咳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀"],
      ["c040", "繞", 35, "纃", 23, "纜纝纞"],
      ["c080", "纮纴纻纼绖绤绬绹缊缐缞缷缹缻", 6, "罃罆", 9, "罒罓馈愧溃坤昆捆困括扩廓阔垃拉喇蜡腊辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐"],
      ["c140", "罖罙罛罜罝罞罠罣", 4, "罫罬罭罯罰罳罵罶罷罸罺罻罼罽罿羀羂", 7, "羋羍羏", 4, "羕", 4, "羛羜羠羢羣羥羦羨", 6, "羱"],
      ["c180", "羳", 4, "羺羻羾翀翂翃翄翆翇翈翉翋翍翏", 4, "翖翗翙", 5, "翢翣痢立粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫馏留刘瘤流柳六龙聋咙笼窿"],
      ["c240", "翤翧翨翪翫翬翭翯翲翴", 6, "翽翾翿耂耇耈耉耊耎耏耑耓耚耛耝耞耟耡耣耤耫", 5, "耲耴耹耺耼耾聀聁聄聅聇聈聉聎聏聐聑聓聕聖聗"],
      ["c280", "聙聛", 13, "聫", 5, "聲", 11, "隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落洛骆络妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫"],
      ["c340", "聾肁肂肅肈肊肍", 5, "肔肕肗肙肞肣肦肧肨肬肰肳肵肶肸肹肻胅胇", 4, "胏", 6, "胘胟胠胢胣胦胮胵胷胹胻胾胿脀脁脃脄脅脇脈脋"],
      ["c380", "脌脕脗脙脛脜脝脟", 12, "脭脮脰脳脴脵脷脹", 4, "脿谩芒茫盲氓忙莽猫茅锚毛矛铆卯茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸"],
      ["c440", "腀", 5, "腇腉腍腎腏腒腖腗腘腛", 4, "腡腢腣腤腦腨腪腫腬腯腲腳腵腶腷腸膁膃", 4, "膉膋膌膍膎膐膒", 5, "膙膚膞", 4, "膤膥"],
      ["c480", "膧膩膫", 7, "膴", 5, "膼膽膾膿臄臅臇臈臉臋臍", 6, "摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆拿哪呐钠那娜纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿鸟尿捏聂孽啮镊镍涅您柠狞凝宁"],
      ["c540", "臔", 14, "臤臥臦臨臩臫臮", 4, "臵", 5, "臽臿舃與", 4, "舎舏舑舓舕", 5, "舝舠舤舥舦舧舩舮舲舺舼舽舿"],
      ["c580", "艀艁艂艃艅艆艈艊艌艍艎艐", 7, "艙艛艜艝艞艠", 7, "艩拧泞牛扭钮纽脓浓农弄奴努怒女暖虐疟挪懦糯诺哦欧鸥殴藕呕偶沤啪趴爬帕怕琶拍排牌徘湃派攀潘盘磐盼畔判叛乓庞旁耪胖抛咆刨炮袍跑泡呸胚培裴赔陪配佩沛喷盆砰抨烹澎彭蓬棚硼篷膨朋鹏捧碰坯砒霹批披劈琵毗"],
      ["c640", "艪艫艬艭艱艵艶艷艸艻艼芀芁芃芅芆芇芉芌芐芓芔芕芖芚芛芞芠芢芣芧芲芵芶芺芻芼芿苀苂苃苅苆苉苐苖苙苚苝苢苧苨苩苪苬苭苮苰苲苳苵苶苸"],
      ["c680", "苺苼", 4, "茊茋茍茐茒茓茖茘茙茝", 9, "茩茪茮茰茲茷茻茽啤脾疲皮匹痞僻屁譬篇偏片骗飘漂瓢票撇瞥拼频贫品聘乒坪苹萍平凭瓶评屏坡泼颇婆破魄迫粕剖扑铺仆莆葡菩蒲埔朴圃普浦谱曝瀑期欺栖戚妻七凄漆柒沏其棋奇歧畦崎脐齐旗祈祁骑起岂乞企启契砌器气迄弃汽泣讫掐"],
      ["c740", "茾茿荁荂荄荅荈荊", 4, "荓荕", 4, "荝荢荰", 6, "荹荺荾", 6, "莇莈莊莋莌莍莏莐莑莔莕莖莗莙莚莝莟莡", 6, "莬莭莮"],
      ["c780", "莯莵莻莾莿菂菃菄菆菈菉菋菍菎菐菑菒菓菕菗菙菚菛菞菢菣菤菦菧菨菫菬菭恰洽牵扦钎铅千迁签仟谦乾黔钱钳前潜遣浅谴堑嵌欠歉枪呛腔羌墙蔷强抢橇锹敲悄桥瞧乔侨巧鞘撬翘峭俏窍切茄且怯窃钦侵亲秦琴勤芹擒禽寝沁青轻氢倾卿清擎晴氰情顷请庆琼穷秋丘邱球求囚酋泅趋区蛆曲躯屈驱渠"],
      ["c840", "菮華菳", 4, "菺菻菼菾菿萀萂萅萇萈萉萊萐萒", 5, "萙萚萛萞", 5, "萩", 7, "萲", 5, "萹萺萻萾", 7, "葇葈葉"],
      ["c880", "葊", 6, "葒", 4, "葘葝葞葟葠葢葤", 4, "葪葮葯葰葲葴葷葹葻葼取娶龋趣去圈颧权醛泉全痊拳犬券劝缺炔瘸却鹊榷确雀裙群然燃冉染瓤壤攘嚷让饶扰绕惹热壬仁人忍韧任认刃妊纫扔仍日戎茸蓉荣融熔溶容绒冗揉柔肉茹蠕儒孺如辱乳汝入褥软阮蕊瑞锐闰润若弱撒洒萨腮鳃塞赛三叁"],
      ["c940", "葽", 4, "蒃蒄蒅蒆蒊蒍蒏", 7, "蒘蒚蒛蒝蒞蒟蒠蒢", 12, "蒰蒱蒳蒵蒶蒷蒻蒼蒾蓀蓂蓃蓅蓆蓇蓈蓋蓌蓎蓏蓒蓔蓕蓗"],
      ["c980", "蓘", 4, "蓞蓡蓢蓤蓧", 4, "蓭蓮蓯蓱", 10, "蓽蓾蔀蔁蔂伞散桑嗓丧搔骚扫嫂瑟色涩森僧莎砂杀刹沙纱傻啥煞筛晒珊苫杉山删煽衫闪陕擅赡膳善汕扇缮墒伤商赏晌上尚裳梢捎稍烧芍勺韶少哨邵绍奢赊蛇舌舍赦摄射慑涉社设砷申呻伸身深娠绅神沈审婶甚肾慎渗声生甥牲升绳"],
      ["ca40", "蔃", 8, "蔍蔎蔏蔐蔒蔔蔕蔖蔘蔙蔛蔜蔝蔞蔠蔢", 8, "蔭", 9, "蔾", 4, "蕄蕅蕆蕇蕋", 10],
      ["ca80", "蕗蕘蕚蕛蕜蕝蕟", 4, "蕥蕦蕧蕩", 8, "蕳蕵蕶蕷蕸蕼蕽蕿薀薁省盛剩胜圣师失狮施湿诗尸虱十石拾时什食蚀实识史矢使屎驶始式示士世柿事拭誓逝势是嗜噬适仕侍释饰氏市恃室视试收手首守寿授售受瘦兽蔬枢梳殊抒输叔舒淑疏书赎孰熟薯暑曙署蜀黍鼠属术述树束戍竖墅庶数漱"],
      ["cb40", "薂薃薆薈", 6, "薐", 10, "薝", 6, "薥薦薧薩薫薬薭薱", 5, "薸薺", 6, "藂", 6, "藊", 4, "藑藒"],
      ["cb80", "藔藖", 5, "藝", 6, "藥藦藧藨藪", 14, "恕刷耍摔衰甩帅栓拴霜双爽谁水睡税吮瞬顺舜说硕朔烁斯撕嘶思私司丝死肆寺嗣四伺似饲巳松耸怂颂送宋讼诵搜艘擞嗽苏酥俗素速粟僳塑溯宿诉肃酸蒜算虽隋随绥髓碎岁穗遂隧祟孙损笋蓑梭唆缩琐索锁所塌他它她塔"],
      ["cc40", "藹藺藼藽藾蘀", 4, "蘆", 10, "蘒蘓蘔蘕蘗", 15, "蘨蘪", 13, "蘹蘺蘻蘽蘾蘿虀"],
      ["cc80", "虁", 11, "虒虓處", 4, "虛虜虝號虠虡虣", 7, "獭挞蹋踏胎苔抬台泰酞太态汰坍摊贪瘫滩坛檀痰潭谭谈坦毯袒碳探叹炭汤塘搪堂棠膛唐糖倘躺淌趟烫掏涛滔绦萄桃逃淘陶讨套特藤腾疼誊梯剔踢锑提题蹄啼体替嚏惕涕剃屉天添填田甜恬舔腆挑条迢眺跳贴铁帖厅听烃"],
      ["cd40", "虭虯虰虲", 6, "蚃", 6, "蚎", 4, "蚔蚖", 5, "蚞", 4, "蚥蚦蚫蚭蚮蚲蚳蚷蚸蚹蚻", 4, "蛁蛂蛃蛅蛈蛌蛍蛒蛓蛕蛖蛗蛚蛜"],
      ["cd80", "蛝蛠蛡蛢蛣蛥蛦蛧蛨蛪蛫蛬蛯蛵蛶蛷蛺蛻蛼蛽蛿蜁蜄蜅蜆蜋蜌蜎蜏蜐蜑蜔蜖汀廷停亭庭挺艇通桐酮瞳同铜彤童桶捅筒统痛偷投头透凸秃突图徒途涂屠土吐兔湍团推颓腿蜕褪退吞屯臀拖托脱鸵陀驮驼椭妥拓唾挖哇蛙洼娃瓦袜歪外豌弯湾玩顽丸烷完碗挽晚皖惋宛婉万腕汪王亡枉网往旺望忘妄威"],
      ["ce40", "蜙蜛蜝蜟蜠蜤蜦蜧蜨蜪蜫蜬蜭蜯蜰蜲蜳蜵蜶蜸蜹蜺蜼蜽蝀", 6, "蝊蝋蝍蝏蝐蝑蝒蝔蝕蝖蝘蝚", 5, "蝡蝢蝦", 7, "蝯蝱蝲蝳蝵"],
      ["ce80", "蝷蝸蝹蝺蝿螀螁螄螆螇螉螊螌螎", 4, "螔螕螖螘", 6, "螠", 4, "巍微危韦违桅围唯惟为潍维苇萎委伟伪尾纬未蔚味畏胃喂魏位渭谓尉慰卫瘟温蚊文闻纹吻稳紊问嗡翁瓮挝蜗涡窝我斡卧握沃巫呜钨乌污诬屋无芜梧吾吴毋武五捂午舞伍侮坞戊雾晤物勿务悟误昔熙析西硒矽晰嘻吸锡牺"],
      ["cf40", "螥螦螧螩螪螮螰螱螲螴螶螷螸螹螻螼螾螿蟁", 4, "蟇蟈蟉蟌", 4, "蟔", 6, "蟜蟝蟞蟟蟡蟢蟣蟤蟦蟧蟨蟩蟫蟬蟭蟯", 9],
      ["cf80", "蟺蟻蟼蟽蟿蠀蠁蠂蠄", 5, "蠋", 7, "蠔蠗蠘蠙蠚蠜", 4, "蠣稀息希悉膝夕惜熄烯溪汐犀檄袭席习媳喜铣洗系隙戏细瞎虾匣霞辖暇峡侠狭下厦夏吓掀锨先仙鲜纤咸贤衔舷闲涎弦嫌显险现献县腺馅羡宪陷限线相厢镶香箱襄湘乡翔祥详想响享项巷橡像向象萧硝霄削哮嚣销消宵淆晓"],
      ["d040", "蠤", 13, "蠳", 5, "蠺蠻蠽蠾蠿衁衂衃衆", 5, "衎", 5, "衕衖衘衚", 6, "衦衧衪衭衯衱衳衴衵衶衸衹衺"],
      ["d080", "衻衼袀袃袆袇袉袊袌袎袏袐袑袓袔袕袗", 4, "袝", 4, "袣袥", 5, "小孝校肖啸笑效楔些歇蝎鞋协挟携邪斜胁谐写械卸蟹懈泄泻谢屑薪芯锌欣辛新忻心信衅星腥猩惺兴刑型形邢行醒幸杏性姓兄凶胸匈汹雄熊休修羞朽嗅锈秀袖绣墟戌需虚嘘须徐许蓄酗叙旭序畜恤絮婿绪续轩喧宣悬旋玄"],
      ["d140", "袬袮袯袰袲", 4, "袸袹袺袻袽袾袿裀裃裄裇裈裊裋裌裍裏裐裑裓裖裗裚", 4, "裠裡裦裧裩", 6, "裲裵裶裷裺裻製裿褀褁褃", 5],
      ["d180", "褉褋", 4, "褑褔", 4, "褜", 4, "褢褣褤褦褧褨褩褬褭褮褯褱褲褳褵褷选癣眩绚靴薛学穴雪血勋熏循旬询寻驯巡殉汛训讯逊迅压押鸦鸭呀丫芽牙蚜崖衙涯雅哑亚讶焉咽阉烟淹盐严研蜒岩延言颜阎炎沿奄掩眼衍演艳堰燕厌砚雁唁彦焰宴谚验殃央鸯秧杨扬佯疡羊洋阳氧仰痒养样漾邀腰妖瑶"],
      ["d240", "褸", 8, "襂襃襅", 24, "襠", 5, "襧", 19, "襼"],
      ["d280", "襽襾覀覂覄覅覇", 26, "摇尧遥窑谣姚咬舀药要耀椰噎耶爷野冶也页掖业叶曳腋夜液一壹医揖铱依伊衣颐夷遗移仪胰疑沂宜姨彝椅蚁倚已乙矣以艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎茵荫因殷音阴姻吟银淫寅饮尹引隐"],
      ["d340", "覢", 30, "觃觍觓觔觕觗觘觙觛觝觟觠觡觢觤觧觨觩觪觬觭觮觰觱觲觴", 6],
      ["d380", "觻", 4, "訁", 5, "計", 21, "印英樱婴鹰应缨莹萤营荧蝇迎赢盈影颖硬映哟拥佣臃痈庸雍踊蛹咏泳涌永恿勇用幽优悠忧尤由邮铀犹油游酉有友右佑釉诱又幼迂淤于盂榆虞愚舆余俞逾鱼愉渝渔隅予娱雨与屿禹宇语羽玉域芋郁吁遇喻峪御愈欲狱育誉"],
      ["d440", "訞", 31, "訿", 8, "詉", 21],
      ["d480", "詟", 25, "詺", 6, "浴寓裕预豫驭鸳渊冤元垣袁原援辕园员圆猿源缘远苑愿怨院曰约越跃钥岳粤月悦阅耘云郧匀陨允运蕴酝晕韵孕匝砸杂栽哉灾宰载再在咱攒暂赞赃脏葬遭糟凿藻枣早澡蚤躁噪造皂灶燥责择则泽贼怎增憎曾赠扎喳渣札轧"],
      ["d540", "誁", 7, "誋", 7, "誔", 46],
      ["d580", "諃", 32, "铡闸眨栅榨咋乍炸诈摘斋宅窄债寨瞻毡詹粘沾盏斩辗崭展蘸栈占战站湛绽樟章彰漳张掌涨杖丈帐账仗胀瘴障招昭找沼赵照罩兆肇召遮折哲蛰辙者锗蔗这浙珍斟真甄砧臻贞针侦枕疹诊震振镇阵蒸挣睁征狰争怔整拯正政"],
      ["d640", "諤", 34, "謈", 27],
      ["d680", "謤謥謧", 30, "帧症郑证芝枝支吱蜘知肢脂汁之织职直植殖执值侄址指止趾只旨纸志挚掷至致置帜峙制智秩稚质炙痔滞治窒中盅忠钟衷终种肿重仲众舟周州洲诌粥轴肘帚咒皱宙昼骤珠株蛛朱猪诸诛逐竹烛煮拄瞩嘱主著柱助蛀贮铸筑"],
      ["d740", "譆", 31, "譧", 4, "譭", 25],
      ["d780", "讇", 24, "讬讱讻诇诐诪谉谞住注祝驻抓爪拽专砖转撰赚篆桩庄装妆撞壮状椎锥追赘坠缀谆准捉拙卓桌琢茁酌啄着灼浊兹咨资姿滋淄孜紫仔籽滓子自渍字鬃棕踪宗综总纵邹走奏揍租足卒族祖诅阻组钻纂嘴醉最罪尊遵昨左佐柞做作坐座"],
      ["d840", "谸", 8, "豂豃豄豅豈豊豋豍", 7, "豖豗豘豙豛", 5, "豣", 6, "豬", 6, "豴豵豶豷豻", 6, "貃貄貆貇"],
      ["d880", "貈貋貍", 6, "貕貖貗貙", 20, "亍丌兀丐廿卅丕亘丞鬲孬噩丨禺丿匕乇夭爻卮氐囟胤馗毓睾鼗丶亟鼐乜乩亓芈孛啬嘏仄厍厝厣厥厮靥赝匚叵匦匮匾赜卦卣刂刈刎刭刳刿剀剌剞剡剜蒯剽劂劁劐劓冂罔亻仃仉仂仨仡仫仞伛仳伢佤仵伥伧伉伫佞佧攸佚佝"],
      ["d940", "貮", 62],
      ["d980", "賭", 32, "佟佗伲伽佶佴侑侉侃侏佾佻侪佼侬侔俦俨俪俅俚俣俜俑俟俸倩偌俳倬倏倮倭俾倜倌倥倨偾偃偕偈偎偬偻傥傧傩傺僖儆僭僬僦僮儇儋仝氽佘佥俎龠汆籴兮巽黉馘冁夔勹匍訇匐凫夙兕亠兖亳衮袤亵脔裒禀嬴蠃羸冫冱冽冼"],
      ["da40", "贎", 14, "贠赑赒赗赟赥赨赩赪赬赮赯赱赲赸", 8, "趂趃趆趇趈趉趌", 4, "趒趓趕", 9, "趠趡"],
      ["da80", "趢趤", 12, "趲趶趷趹趻趽跀跁跂跅跇跈跉跊跍跐跒跓跔凇冖冢冥讠讦讧讪讴讵讷诂诃诋诏诎诒诓诔诖诘诙诜诟诠诤诨诩诮诰诳诶诹诼诿谀谂谄谇谌谏谑谒谔谕谖谙谛谘谝谟谠谡谥谧谪谫谮谯谲谳谵谶卩卺阝阢阡阱阪阽阼陂陉陔陟陧陬陲陴隈隍隗隰邗邛邝邙邬邡邴邳邶邺"],
      ["db40", "跕跘跙跜跠跡跢跥跦跧跩跭跮跰跱跲跴跶跼跾", 6, "踆踇踈踋踍踎踐踑踒踓踕", 7, "踠踡踤", 4, "踫踭踰踲踳踴踶踷踸踻踼踾"],
      ["db80", "踿蹃蹅蹆蹌", 4, "蹓", 5, "蹚", 11, "蹧蹨蹪蹫蹮蹱邸邰郏郅邾郐郄郇郓郦郢郜郗郛郫郯郾鄄鄢鄞鄣鄱鄯鄹酃酆刍奂劢劬劭劾哿勐勖勰叟燮矍廴凵凼鬯厶弁畚巯坌垩垡塾墼壅壑圩圬圪圳圹圮圯坜圻坂坩垅坫垆坼坻坨坭坶坳垭垤垌垲埏垧垴垓垠埕埘埚埙埒垸埴埯埸埤埝"],
      ["dc40", "蹳蹵蹷", 4, "蹽蹾躀躂躃躄躆躈", 6, "躑躒躓躕", 6, "躝躟", 11, "躭躮躰躱躳", 6, "躻", 7],
      ["dc80", "軃", 10, "軏", 21, "堋堍埽埭堀堞堙塄堠塥塬墁墉墚墀馨鼙懿艹艽艿芏芊芨芄芎芑芗芙芫芸芾芰苈苊苣芘芷芮苋苌苁芩芴芡芪芟苄苎芤苡茉苷苤茏茇苜苴苒苘茌苻苓茑茚茆茔茕苠苕茜荑荛荜茈莒茼茴茱莛荞茯荏荇荃荟荀茗荠茭茺茳荦荥"],
      ["dd40", "軥", 62],
      ["dd80", "輤", 32, "荨茛荩荬荪荭荮莰荸莳莴莠莪莓莜莅荼莶莩荽莸荻莘莞莨莺莼菁萁菥菘堇萘萋菝菽菖萜萸萑萆菔菟萏萃菸菹菪菅菀萦菰菡葜葑葚葙葳蒇蒈葺蒉葸萼葆葩葶蒌蒎萱葭蓁蓍蓐蓦蒽蓓蓊蒿蒺蓠蒡蒹蒴蒗蓥蓣蔌甍蔸蓰蔹蔟蔺"],
      ["de40", "轅", 32, "轪辀辌辒辝辠辡辢辤辥辦辧辪辬辭辮辯農辳辴辵辷辸辺辻込辿迀迃迆"],
      ["de80", "迉", 4, "迏迒迖迗迚迠迡迣迧迬迯迱迲迴迵迶迺迻迼迾迿逇逈逌逎逓逕逘蕖蔻蓿蓼蕙蕈蕨蕤蕞蕺瞢蕃蕲蕻薤薨薇薏蕹薮薜薅薹薷薰藓藁藜藿蘧蘅蘩蘖蘼廾弈夼奁耷奕奚奘匏尢尥尬尴扌扪抟抻拊拚拗拮挢拶挹捋捃掭揶捱捺掎掴捭掬掊捩掮掼揲揸揠揿揄揞揎摒揆掾摅摁搋搛搠搌搦搡摞撄摭撖"],
      ["df40", "這逜連逤逥逧", 5, "逰", 4, "逷逹逺逽逿遀遃遅遆遈", 4, "過達違遖遙遚遜", 5, "遤遦遧適遪遫遬遯", 4, "遶", 6, "遾邁"],
      ["df80", "還邅邆邇邉邊邌", 4, "邒邔邖邘邚邜邞邟邠邤邥邧邨邩邫邭邲邷邼邽邿郀摺撷撸撙撺擀擐擗擤擢攉攥攮弋忒甙弑卟叱叽叩叨叻吒吖吆呋呒呓呔呖呃吡呗呙吣吲咂咔呷呱呤咚咛咄呶呦咝哐咭哂咴哒咧咦哓哔呲咣哕咻咿哌哙哚哜咩咪咤哝哏哞唛哧唠哽唔哳唢唣唏唑唧唪啧喏喵啉啭啁啕唿啐唼"],
      ["e040", "郂郃郆郈郉郋郌郍郒郔郕郖郘郙郚郞郟郠郣郤郥郩郪郬郮郰郱郲郳郵郶郷郹郺郻郼郿鄀鄁鄃鄅", 19, "鄚鄛鄜"],
      ["e080", "鄝鄟鄠鄡鄤", 10, "鄰鄲", 6, "鄺", 8, "酄唷啖啵啶啷唳唰啜喋嗒喃喱喹喈喁喟啾嗖喑啻嗟喽喾喔喙嗪嗷嗉嘟嗑嗫嗬嗔嗦嗝嗄嗯嗥嗲嗳嗌嗍嗨嗵嗤辔嘞嘈嘌嘁嘤嘣嗾嘀嘧嘭噘嘹噗嘬噍噢噙噜噌噔嚆噤噱噫噻噼嚅嚓嚯囔囗囝囡囵囫囹囿圄圊圉圜帏帙帔帑帱帻帼"],
      ["e140", "酅酇酈酑酓酔酕酖酘酙酛酜酟酠酦酧酨酫酭酳酺酻酼醀", 4, "醆醈醊醎醏醓", 6, "醜", 5, "醤", 5, "醫醬醰醱醲醳醶醷醸醹醻"],
      ["e180", "醼", 10, "釈釋釐釒", 9, "針", 8, "帷幄幔幛幞幡岌屺岍岐岖岈岘岙岑岚岜岵岢岽岬岫岱岣峁岷峄峒峤峋峥崂崃崧崦崮崤崞崆崛嵘崾崴崽嵬嵛嵯嵝嵫嵋嵊嵩嵴嶂嶙嶝豳嶷巅彳彷徂徇徉後徕徙徜徨徭徵徼衢彡犭犰犴犷犸狃狁狎狍狒狨狯狩狲狴狷猁狳猃狺"],
      ["e240", "釦", 62],
      ["e280", "鈥", 32, "狻猗猓猡猊猞猝猕猢猹猥猬猸猱獐獍獗獠獬獯獾舛夥飧夤夂饣饧", 5, "饴饷饽馀馄馇馊馍馐馑馓馔馕庀庑庋庖庥庠庹庵庾庳赓廒廑廛廨廪膺忄忉忖忏怃忮怄忡忤忾怅怆忪忭忸怙怵怦怛怏怍怩怫怊怿怡恸恹恻恺恂"],
      ["e340", "鉆", 45, "鉵", 16],
      ["e380", "銆", 7, "銏", 24, "恪恽悖悚悭悝悃悒悌悛惬悻悱惝惘惆惚悴愠愦愕愣惴愀愎愫慊慵憬憔憧憷懔懵忝隳闩闫闱闳闵闶闼闾阃阄阆阈阊阋阌阍阏阒阕阖阗阙阚丬爿戕氵汔汜汊沣沅沐沔沌汨汩汴汶沆沩泐泔沭泷泸泱泗沲泠泖泺泫泮沱泓泯泾"],
      ["e440", "銨", 5, "銯", 24, "鋉", 31],
      ["e480", "鋩", 32, "洹洧洌浃浈洇洄洙洎洫浍洮洵洚浏浒浔洳涑浯涞涠浞涓涔浜浠浼浣渚淇淅淞渎涿淠渑淦淝淙渖涫渌涮渫湮湎湫溲湟溆湓湔渲渥湄滟溱溘滠漭滢溥溧溽溻溷滗溴滏溏滂溟潢潆潇漤漕滹漯漶潋潴漪漉漩澉澍澌潸潲潼潺濑"],
      ["e540", "錊", 51, "錿", 10],
      ["e580", "鍊", 31, "鍫濉澧澹澶濂濡濮濞濠濯瀚瀣瀛瀹瀵灏灞宀宄宕宓宥宸甯骞搴寤寮褰寰蹇謇辶迓迕迥迮迤迩迦迳迨逅逄逋逦逑逍逖逡逵逶逭逯遄遑遒遐遨遘遢遛暹遴遽邂邈邃邋彐彗彖彘尻咫屐屙孱屣屦羼弪弩弭艴弼鬻屮妁妃妍妩妪妣"],
      ["e640", "鍬", 34, "鎐", 27],
      ["e680", "鎬", 29, "鏋鏌鏍妗姊妫妞妤姒妲妯姗妾娅娆姝娈姣姘姹娌娉娲娴娑娣娓婀婧婊婕娼婢婵胬媪媛婷婺媾嫫媲嫒嫔媸嫠嫣嫱嫖嫦嫘嫜嬉嬗嬖嬲嬷孀尕尜孚孥孳孑孓孢驵驷驸驺驿驽骀骁骅骈骊骐骒骓骖骘骛骜骝骟骠骢骣骥骧纟纡纣纥纨纩"],
      ["e740", "鏎", 7, "鏗", 54],
      ["e780", "鐎", 32, "纭纰纾绀绁绂绉绋绌绐绔绗绛绠绡绨绫绮绯绱绲缍绶绺绻绾缁缂缃缇缈缋缌缏缑缒缗缙缜缛缟缡", 6, "缪缫缬缭缯", 4, "缵幺畿巛甾邕玎玑玮玢玟珏珂珑玷玳珀珉珈珥珙顼琊珩珧珞玺珲琏琪瑛琦琥琨琰琮琬"],
      ["e840", "鐯", 14, "鐿", 43, "鑬鑭鑮鑯"],
      ["e880", "鑰", 20, "钑钖钘铇铏铓铔铚铦铻锜锠琛琚瑁瑜瑗瑕瑙瑷瑭瑾璜璎璀璁璇璋璞璨璩璐璧瓒璺韪韫韬杌杓杞杈杩枥枇杪杳枘枧杵枨枞枭枋杷杼柰栉柘栊柩枰栌柙枵柚枳柝栀柃枸柢栎柁柽栲栳桠桡桎桢桄桤梃栝桕桦桁桧桀栾桊桉栩梵梏桴桷梓桫棂楮棼椟椠棹"],
      ["e940", "锧锳锽镃镈镋镕镚镠镮镴镵長", 7, "門", 42],
      ["e980", "閫", 32, "椤棰椋椁楗棣椐楱椹楠楂楝榄楫榀榘楸椴槌榇榈槎榉楦楣楹榛榧榻榫榭槔榱槁槊槟榕槠榍槿樯槭樗樘橥槲橄樾檠橐橛樵檎橹樽樨橘橼檑檐檩檗檫猷獒殁殂殇殄殒殓殍殚殛殡殪轫轭轱轲轳轵轶轸轷轹轺轼轾辁辂辄辇辋"],
      ["ea40", "闌", 27, "闬闿阇阓阘阛阞阠阣", 6, "阫阬阭阯阰阷阸阹阺阾陁陃陊陎陏陑陒陓陖陗"],
      ["ea80", "陘陙陚陜陝陞陠陣陥陦陫陭", 4, "陳陸", 12, "隇隉隊辍辎辏辘辚軎戋戗戛戟戢戡戥戤戬臧瓯瓴瓿甏甑甓攴旮旯旰昊昙杲昃昕昀炅曷昝昴昱昶昵耆晟晔晁晏晖晡晗晷暄暌暧暝暾曛曜曦曩贲贳贶贻贽赀赅赆赈赉赇赍赕赙觇觊觋觌觎觏觐觑牮犟牝牦牯牾牿犄犋犍犏犒挈挲掰"],
      ["eb40", "隌階隑隒隓隕隖隚際隝", 9, "隨", 7, "隱隲隴隵隷隸隺隻隿雂雃雈雊雋雐雑雓雔雖", 9, "雡", 6, "雫"],
      ["eb80", "雬雭雮雰雱雲雴雵雸雺電雼雽雿霂霃霅霊霋霌霐霑霒霔霕霗", 4, "霝霟霠搿擘耄毪毳毽毵毹氅氇氆氍氕氘氙氚氡氩氤氪氲攵敕敫牍牒牖爰虢刖肟肜肓肼朊肽肱肫肭肴肷胧胨胩胪胛胂胄胙胍胗朐胝胫胱胴胭脍脎胲胼朕脒豚脶脞脬脘脲腈腌腓腴腙腚腱腠腩腼腽腭腧塍媵膈膂膑滕膣膪臌朦臊膻"],
      ["ec40", "霡", 8, "霫霬霮霯霱霳", 4, "霺霻霼霽霿", 18, "靔靕靗靘靚靜靝靟靣靤靦靧靨靪", 7],
      ["ec80", "靲靵靷", 4, "靽", 7, "鞆", 4, "鞌鞎鞏鞐鞓鞕鞖鞗鞙", 4, "臁膦欤欷欹歃歆歙飑飒飓飕飙飚殳彀毂觳斐齑斓於旆旄旃旌旎旒旖炀炜炖炝炻烀炷炫炱烨烊焐焓焖焯焱煳煜煨煅煲煊煸煺熘熳熵熨熠燠燔燧燹爝爨灬焘煦熹戾戽扃扈扉礻祀祆祉祛祜祓祚祢祗祠祯祧祺禅禊禚禧禳忑忐"],
      ["ed40", "鞞鞟鞡鞢鞤", 6, "鞬鞮鞰鞱鞳鞵", 46],
      ["ed80", "韤韥韨韮", 4, "韴韷", 23, "怼恝恚恧恁恙恣悫愆愍慝憩憝懋懑戆肀聿沓泶淼矶矸砀砉砗砘砑斫砭砜砝砹砺砻砟砼砥砬砣砩硎硭硖硗砦硐硇硌硪碛碓碚碇碜碡碣碲碹碥磔磙磉磬磲礅磴礓礤礞礴龛黹黻黼盱眄眍盹眇眈眚眢眙眭眦眵眸睐睑睇睃睚睨"],
      ["ee40", "頏", 62],
      ["ee80", "顎", 32, "睢睥睿瞍睽瞀瞌瞑瞟瞠瞰瞵瞽町畀畎畋畈畛畲畹疃罘罡罟詈罨罴罱罹羁罾盍盥蠲钅钆钇钋钊钌钍钏钐钔钗钕钚钛钜钣钤钫钪钭钬钯钰钲钴钶", 4, "钼钽钿铄铈", 6, "铐铑铒铕铖铗铙铘铛铞铟铠铢铤铥铧铨铪"],
      ["ef40", "顯", 5, "颋颎颒颕颙颣風", 37, "飏飐飔飖飗飛飜飝飠", 4],
      ["ef80", "飥飦飩", 30, "铩铫铮铯铳铴铵铷铹铼铽铿锃锂锆锇锉锊锍锎锏锒", 4, "锘锛锝锞锟锢锪锫锩锬锱锲锴锶锷锸锼锾锿镂锵镄镅镆镉镌镎镏镒镓镔镖镗镘镙镛镞镟镝镡镢镤", 8, "镯镱镲镳锺矧矬雉秕秭秣秫稆嵇稃稂稞稔"],
      ["f040", "餈", 4, "餎餏餑", 28, "餯", 26],
      ["f080", "饊", 9, "饖", 12, "饤饦饳饸饹饻饾馂馃馉稹稷穑黏馥穰皈皎皓皙皤瓞瓠甬鸠鸢鸨", 4, "鸲鸱鸶鸸鸷鸹鸺鸾鹁鹂鹄鹆鹇鹈鹉鹋鹌鹎鹑鹕鹗鹚鹛鹜鹞鹣鹦", 6, "鹱鹭鹳疒疔疖疠疝疬疣疳疴疸痄疱疰痃痂痖痍痣痨痦痤痫痧瘃痱痼痿瘐瘀瘅瘌瘗瘊瘥瘘瘕瘙"],
      ["f140", "馌馎馚", 10, "馦馧馩", 47],
      ["f180", "駙", 32, "瘛瘼瘢瘠癀瘭瘰瘿瘵癃瘾瘳癍癞癔癜癖癫癯翊竦穸穹窀窆窈窕窦窠窬窨窭窳衤衩衲衽衿袂袢裆袷袼裉裢裎裣裥裱褚裼裨裾裰褡褙褓褛褊褴褫褶襁襦襻疋胥皲皴矜耒耔耖耜耠耢耥耦耧耩耨耱耋耵聃聆聍聒聩聱覃顸颀颃"],
      ["f240", "駺", 62],
      ["f280", "騹", 32, "颉颌颍颏颔颚颛颞颟颡颢颥颦虍虔虬虮虿虺虼虻蚨蚍蚋蚬蚝蚧蚣蚪蚓蚩蚶蛄蚵蛎蚰蚺蚱蚯蛉蛏蚴蛩蛱蛲蛭蛳蛐蜓蛞蛴蛟蛘蛑蜃蜇蛸蜈蜊蜍蜉蜣蜻蜞蜥蜮蜚蜾蝈蜴蜱蜩蜷蜿螂蜢蝽蝾蝻蝠蝰蝌蝮螋蝓蝣蝼蝤蝙蝥螓螯螨蟒"],
      ["f340", "驚", 17, "驲骃骉骍骎骔骕骙骦骩", 6, "骲骳骴骵骹骻骽骾骿髃髄髆", 4, "髍髎髏髐髒體髕髖髗髙髚髛髜"],
      ["f380", "髝髞髠髢髣髤髥髧髨髩髪髬髮髰", 8, "髺髼", 6, "鬄鬅鬆蟆螈螅螭螗螃螫蟥螬螵螳蟋蟓螽蟑蟀蟊蟛蟪蟠蟮蠖蠓蟾蠊蠛蠡蠹蠼缶罂罄罅舐竺竽笈笃笄笕笊笫笏筇笸笪笙笮笱笠笥笤笳笾笞筘筚筅筵筌筝筠筮筻筢筲筱箐箦箧箸箬箝箨箅箪箜箢箫箴篑篁篌篝篚篥篦篪簌篾篼簏簖簋"],
      ["f440", "鬇鬉", 5, "鬐鬑鬒鬔", 10, "鬠鬡鬢鬤", 10, "鬰鬱鬳", 7, "鬽鬾鬿魀魆魊魋魌魎魐魒魓魕", 5],
      ["f480", "魛", 32, "簟簪簦簸籁籀臾舁舂舄臬衄舡舢舣舭舯舨舫舸舻舳舴舾艄艉艋艏艚艟艨衾袅袈裘裟襞羝羟羧羯羰羲籼敉粑粝粜粞粢粲粼粽糁糇糌糍糈糅糗糨艮暨羿翎翕翥翡翦翩翮翳糸絷綦綮繇纛麸麴赳趄趔趑趱赧赭豇豉酊酐酎酏酤"],
      ["f540", "魼", 62],
      ["f580", "鮻", 32, "酢酡酰酩酯酽酾酲酴酹醌醅醐醍醑醢醣醪醭醮醯醵醴醺豕鹾趸跫踅蹙蹩趵趿趼趺跄跖跗跚跞跎跏跛跆跬跷跸跣跹跻跤踉跽踔踝踟踬踮踣踯踺蹀踹踵踽踱蹉蹁蹂蹑蹒蹊蹰蹶蹼蹯蹴躅躏躔躐躜躞豸貂貊貅貘貔斛觖觞觚觜"],
      ["f640", "鯜", 62],
      ["f680", "鰛", 32, "觥觫觯訾謦靓雩雳雯霆霁霈霏霎霪霭霰霾龀龃龅", 5, "龌黾鼋鼍隹隼隽雎雒瞿雠銎銮鋈錾鍪鏊鎏鐾鑫鱿鲂鲅鲆鲇鲈稣鲋鲎鲐鲑鲒鲔鲕鲚鲛鲞", 5, "鲥", 4, "鲫鲭鲮鲰", 7, "鲺鲻鲼鲽鳄鳅鳆鳇鳊鳋"],
      ["f740", "鰼", 62],
      ["f780", "鱻鱽鱾鲀鲃鲄鲉鲊鲌鲏鲓鲖鲗鲘鲙鲝鲪鲬鲯鲹鲾", 4, "鳈鳉鳑鳒鳚鳛鳠鳡鳌", 4, "鳓鳔鳕鳗鳘鳙鳜鳝鳟鳢靼鞅鞑鞒鞔鞯鞫鞣鞲鞴骱骰骷鹘骶骺骼髁髀髅髂髋髌髑魅魃魇魉魈魍魑飨餍餮饕饔髟髡髦髯髫髻髭髹鬈鬏鬓鬟鬣麽麾縻麂麇麈麋麒鏖麝麟黛黜黝黠黟黢黩黧黥黪黯鼢鼬鼯鼹鼷鼽鼾齄"],
      ["f840", "鳣", 62],
      ["f880", "鴢", 32],
      ["f940", "鵃", 62],
      ["f980", "鶂", 32],
      ["fa40", "鶣", 62],
      ["fa80", "鷢", 32],
      ["fb40", "鸃", 27, "鸤鸧鸮鸰鸴鸻鸼鹀鹍鹐鹒鹓鹔鹖鹙鹝鹟鹠鹡鹢鹥鹮鹯鹲鹴", 9, "麀"],
      ["fb80", "麁麃麄麅麆麉麊麌", 5, "麔", 8, "麞麠", 5, "麧麨麩麪"],
      ["fc40", "麫", 8, "麵麶麷麹麺麼麿", 4, "黅黆黇黈黊黋黌黐黒黓黕黖黗黙黚點黡黣黤黦黨黫黬黭黮黰", 8, "黺黽黿", 6],
      ["fc80", "鼆", 4, "鼌鼏鼑鼒鼔鼕鼖鼘鼚", 5, "鼡鼣", 8, "鼭鼮鼰鼱"],
      ["fd40", "鼲", 4, "鼸鼺鼼鼿", 4, "齅", 10, "齒", 38],
      ["fd80", "齹", 5, "龁龂龍", 11, "龜龝龞龡", 4, "郎凉秊裏隣"],
      ["fe40", "兀嗀﨎﨏﨑﨓﨔礼﨟蘒﨡﨣﨤﨧﨨﨩"]
    ];
  }
});

// node_modules/iconv-lite/encodings/tables/gbk-added.json
var require_gbk_added = __commonJS({
  "node_modules/iconv-lite/encodings/tables/gbk-added.json"(exports2, module2) {
    module2.exports = [
      ["a140", "", 62],
      ["a180", "", 32],
      ["a240", "", 62],
      ["a280", "", 32],
      ["a2ab", "", 5],
      ["a2e3", "€"],
      ["a2ef", ""],
      ["a2fd", ""],
      ["a340", "", 62],
      ["a380", "", 31, "　"],
      ["a440", "", 62],
      ["a480", "", 32],
      ["a4f4", "", 10],
      ["a540", "", 62],
      ["a580", "", 32],
      ["a5f7", "", 7],
      ["a640", "", 62],
      ["a680", "", 32],
      ["a6b9", "", 7],
      ["a6d9", "", 6],
      ["a6ec", ""],
      ["a6f3", ""],
      ["a6f6", "", 8],
      ["a740", "", 62],
      ["a780", "", 32],
      ["a7c2", "", 14],
      ["a7f2", "", 12],
      ["a896", "", 10],
      ["a8bc", "ḿ"],
      ["a8bf", "ǹ"],
      ["a8c1", ""],
      ["a8ea", "", 20],
      ["a958", ""],
      ["a95b", ""],
      ["a95d", ""],
      ["a989", "〾⿰", 11],
      ["a997", "", 12],
      ["a9f0", "", 14],
      ["aaa1", "", 93],
      ["aba1", "", 93],
      ["aca1", "", 93],
      ["ada1", "", 93],
      ["aea1", "", 93],
      ["afa1", "", 93],
      ["d7fa", "", 4],
      ["f8a1", "", 93],
      ["f9a1", "", 93],
      ["faa1", "", 93],
      ["fba1", "", 93],
      ["fca1", "", 93],
      ["fda1", "", 93],
      ["fe50", "⺁⺄㑳㑇⺈⺋㖞㘚㘎⺌⺗㥮㤘㧏㧟㩳㧐㭎㱮㳠⺧⺪䁖䅟⺮䌷⺳⺶⺷䎱䎬⺻䏝䓖䙡䙌"],
      ["fe80", "䜣䜩䝼䞍⻊䥇䥺䥽䦂䦃䦅䦆䦟䦛䦷䦶䲣䲟䲠䲡䱷䲢䴓", 6, "䶮", 93],
      ["8135f437", ""]
    ];
  }
});

// node_modules/iconv-lite/encodings/tables/gb18030-ranges.json
var require_gb18030_ranges = __commonJS({
  "node_modules/iconv-lite/encodings/tables/gb18030-ranges.json"(exports2, module2) {
    module2.exports = { uChars: [128, 165, 169, 178, 184, 216, 226, 235, 238, 244, 248, 251, 253, 258, 276, 284, 300, 325, 329, 334, 364, 463, 465, 467, 469, 471, 473, 475, 477, 506, 594, 610, 712, 716, 730, 930, 938, 962, 970, 1026, 1104, 1106, 8209, 8215, 8218, 8222, 8231, 8241, 8244, 8246, 8252, 8365, 8452, 8454, 8458, 8471, 8482, 8556, 8570, 8596, 8602, 8713, 8720, 8722, 8726, 8731, 8737, 8740, 8742, 8748, 8751, 8760, 8766, 8777, 8781, 8787, 8802, 8808, 8816, 8854, 8858, 8870, 8896, 8979, 9322, 9372, 9548, 9588, 9616, 9622, 9634, 9652, 9662, 9672, 9676, 9680, 9702, 9735, 9738, 9793, 9795, 11906, 11909, 11913, 11917, 11928, 11944, 11947, 11951, 11956, 11960, 11964, 11979, 12284, 12292, 12312, 12319, 12330, 12351, 12436, 12447, 12535, 12543, 12586, 12842, 12850, 12964, 13200, 13215, 13218, 13253, 13263, 13267, 13270, 13384, 13428, 13727, 13839, 13851, 14617, 14703, 14801, 14816, 14964, 15183, 15471, 15585, 16471, 16736, 17208, 17325, 17330, 17374, 17623, 17997, 18018, 18212, 18218, 18301, 18318, 18760, 18811, 18814, 18820, 18823, 18844, 18848, 18872, 19576, 19620, 19738, 19887, 40870, 59244, 59336, 59367, 59413, 59417, 59423, 59431, 59437, 59443, 59452, 59460, 59478, 59493, 63789, 63866, 63894, 63976, 63986, 64016, 64018, 64021, 64025, 64034, 64037, 64042, 65074, 65093, 65107, 65112, 65127, 65132, 65375, 65510, 65536], gbChars: [0, 36, 38, 45, 50, 81, 89, 95, 96, 100, 103, 104, 105, 109, 126, 133, 148, 172, 175, 179, 208, 306, 307, 308, 309, 310, 311, 312, 313, 341, 428, 443, 544, 545, 558, 741, 742, 749, 750, 805, 819, 820, 7922, 7924, 7925, 7927, 7934, 7943, 7944, 7945, 7950, 8062, 8148, 8149, 8152, 8164, 8174, 8236, 8240, 8262, 8264, 8374, 8380, 8381, 8384, 8388, 8390, 8392, 8393, 8394, 8396, 8401, 8406, 8416, 8419, 8424, 8437, 8439, 8445, 8482, 8485, 8496, 8521, 8603, 8936, 8946, 9046, 9050, 9063, 9066, 9076, 9092, 9100, 9108, 9111, 9113, 9131, 9162, 9164, 9218, 9219, 11329, 11331, 11334, 11336, 11346, 11361, 11363, 11366, 11370, 11372, 11375, 11389, 11682, 11686, 11687, 11692, 11694, 11714, 11716, 11723, 11725, 11730, 11736, 11982, 11989, 12102, 12336, 12348, 12350, 12384, 12393, 12395, 12397, 12510, 12553, 12851, 12962, 12973, 13738, 13823, 13919, 13933, 14080, 14298, 14585, 14698, 15583, 15847, 16318, 16434, 16438, 16481, 16729, 17102, 17122, 17315, 17320, 17402, 17418, 17859, 17909, 17911, 17915, 17916, 17936, 17939, 17961, 18664, 18703, 18814, 18962, 19043, 33469, 33470, 33471, 33484, 33485, 33490, 33497, 33501, 33505, 33513, 33520, 33536, 33550, 37845, 37921, 37948, 38029, 38038, 38064, 38065, 38066, 38069, 38075, 38076, 38078, 39108, 39109, 39113, 39114, 39115, 39116, 39265, 39394, 189e3] };
  }
});

// node_modules/iconv-lite/encodings/tables/cp949.json
var require_cp949 = __commonJS({
  "node_modules/iconv-lite/encodings/tables/cp949.json"(exports2, module2) {
    module2.exports = [
      ["0", "\0", 127],
      ["8141", "갂갃갅갆갋", 4, "갘갞갟갡갢갣갥", 6, "갮갲갳갴"],
      ["8161", "갵갶갷갺갻갽갾갿걁", 9, "걌걎", 5, "걕"],
      ["8181", "걖걗걙걚걛걝", 18, "걲걳걵걶걹걻", 4, "겂겇겈겍겎겏겑겒겓겕", 6, "겞겢", 5, "겫겭겮겱", 6, "겺겾겿곀곂곃곅곆곇곉곊곋곍", 7, "곖곘", 7, "곢곣곥곦곩곫곭곮곲곴곷", 4, "곾곿괁괂괃괅괇", 4, "괎괐괒괓"],
      ["8241", "괔괕괖괗괙괚괛괝괞괟괡", 7, "괪괫괮", 5],
      ["8261", "괶괷괹괺괻괽", 6, "굆굈굊", 5, "굑굒굓굕굖굗"],
      ["8281", "굙", 7, "굢굤", 7, "굮굯굱굲굷굸굹굺굾궀궃", 4, "궊궋궍궎궏궑", 10, "궞", 5, "궥", 17, "궸", 7, "귂귃귅귆귇귉", 6, "귒귔", 7, "귝귞귟귡귢귣귥", 18],
      ["8341", "귺귻귽귾긂", 5, "긊긌긎", 5, "긕", 7],
      ["8361", "긝", 18, "긲긳긵긶긹긻긼"],
      ["8381", "긽긾긿깂깄깇깈깉깋깏깑깒깓깕깗", 4, "깞깢깣깤깦깧깪깫깭깮깯깱", 6, "깺깾", 5, "꺆", 5, "꺍", 46, "꺿껁껂껃껅", 6, "껎껒", 5, "껚껛껝", 8],
      ["8441", "껦껧껩껪껬껮", 5, "껵껶껷껹껺껻껽", 8],
      ["8461", "꼆꼉꼊꼋꼌꼎꼏꼑", 18],
      ["8481", "꼤", 7, "꼮꼯꼱꼳꼵", 6, "꼾꽀꽄꽅꽆꽇꽊", 5, "꽑", 10, "꽞", 5, "꽦", 18, "꽺", 5, "꾁꾂꾃꾅꾆꾇꾉", 6, "꾒꾓꾔꾖", 5, "꾝", 26, "꾺꾻꾽꾾"],
      ["8541", "꾿꿁", 5, "꿊꿌꿏", 4, "꿕", 6, "꿝", 4],
      ["8561", "꿢", 5, "꿪", 5, "꿲꿳꿵꿶꿷꿹", 6, "뀂뀃"],
      ["8581", "뀅", 6, "뀍뀎뀏뀑뀒뀓뀕", 6, "뀞", 9, "뀩", 26, "끆끇끉끋끍끏끐끑끒끖끘끚끛끜끞", 29, "끾끿낁낂낃낅", 6, "낎낐낒", 5, "낛낝낞낣낤"],
      ["8641", "낥낦낧낪낰낲낶낷낹낺낻낽", 6, "냆냊", 5, "냒"],
      ["8661", "냓냕냖냗냙", 6, "냡냢냣냤냦", 10],
      ["8681", "냱", 22, "넊넍넎넏넑넔넕넖넗넚넞", 4, "넦넧넩넪넫넭", 6, "넶넺", 5, "녂녃녅녆녇녉", 6, "녒녓녖녗녙녚녛녝녞녟녡", 22, "녺녻녽녾녿놁놃", 4, "놊놌놎놏놐놑놕놖놗놙놚놛놝"],
      ["8741", "놞", 9, "놩", 15],
      ["8761", "놹", 18, "뇍뇎뇏뇑뇒뇓뇕"],
      ["8781", "뇖", 5, "뇞뇠", 7, "뇪뇫뇭뇮뇯뇱", 7, "뇺뇼뇾", 5, "눆눇눉눊눍", 6, "눖눘눚", 5, "눡", 18, "눵", 6, "눽", 26, "뉙뉚뉛뉝뉞뉟뉡", 6, "뉪", 4],
      ["8841", "뉯", 4, "뉶", 5, "뉽", 6, "늆늇늈늊", 4],
      ["8861", "늏늒늓늕늖늗늛", 4, "늢늤늧늨늩늫늭늮늯늱늲늳늵늶늷"],
      ["8881", "늸", 15, "닊닋닍닎닏닑닓", 4, "닚닜닞닟닠닡닣닧닩닪닰닱닲닶닼닽닾댂댃댅댆댇댉", 6, "댒댖", 5, "댝", 54, "덗덙덚덝덠덡덢덣"],
      ["8941", "덦덨덪덬덭덯덲덳덵덶덷덹", 6, "뎂뎆", 5, "뎍"],
      ["8961", "뎎뎏뎑뎒뎓뎕", 10, "뎢", 5, "뎩뎪뎫뎭"],
      ["8981", "뎮", 21, "돆돇돉돊돍돏돑돒돓돖돘돚돜돞돟돡돢돣돥돦돧돩", 18, "돽", 18, "됑", 6, "됙됚됛됝됞됟됡", 6, "됪됬", 7, "됵", 15],
      ["8a41", "둅", 10, "둒둓둕둖둗둙", 6, "둢둤둦"],
      ["8a61", "둧", 4, "둭", 18, "뒁뒂"],
      ["8a81", "뒃", 4, "뒉", 19, "뒞", 5, "뒥뒦뒧뒩뒪뒫뒭", 7, "뒶뒸뒺", 5, "듁듂듃듅듆듇듉", 6, "듑듒듓듔듖", 5, "듞듟듡듢듥듧", 4, "듮듰듲", 5, "듹", 26, "딖딗딙딚딝"],
      ["8b41", "딞", 5, "딦딫", 4, "딲딳딵딶딷딹", 6, "땂땆"],
      ["8b61", "땇땈땉땊땎땏땑땒땓땕", 6, "땞땢", 8],
      ["8b81", "땫", 52, "떢떣떥떦떧떩떬떭떮떯떲떶", 4, "떾떿뗁뗂뗃뗅", 6, "뗎뗒", 5, "뗙", 18, "뗭", 18],
      ["8c41", "똀", 15, "똒똓똕똖똗똙", 4],
      ["8c61", "똞", 6, "똦", 5, "똭", 6, "똵", 5],
      ["8c81", "똻", 12, "뙉", 26, "뙥뙦뙧뙩", 50, "뚞뚟뚡뚢뚣뚥", 5, "뚭뚮뚯뚰뚲", 16],
      ["8d41", "뛃", 16, "뛕", 8],
      ["8d61", "뛞", 17, "뛱뛲뛳뛵뛶뛷뛹뛺"],
      ["8d81", "뛻", 4, "뜂뜃뜄뜆", 33, "뜪뜫뜭뜮뜱", 6, "뜺뜼", 7, "띅띆띇띉띊띋띍", 6, "띖", 9, "띡띢띣띥띦띧띩", 6, "띲띴띶", 5, "띾띿랁랂랃랅", 6, "랎랓랔랕랚랛랝랞"],
      ["8e41", "랟랡", 6, "랪랮", 5, "랶랷랹", 8],
      ["8e61", "럂", 4, "럈럊", 19],
      ["8e81", "럞", 13, "럮럯럱럲럳럵", 6, "럾렂", 4, "렊렋렍렎렏렑", 6, "렚렜렞", 5, "렦렧렩렪렫렭", 6, "렶렺", 5, "롁롂롃롅", 11, "롒롔", 7, "롞롟롡롢롣롥", 6, "롮롰롲", 5, "롹롺롻롽", 7],
      ["8f41", "뢅", 7, "뢎", 17],
      ["8f61", "뢠", 7, "뢩", 6, "뢱뢲뢳뢵뢶뢷뢹", 4],
      ["8f81", "뢾뢿룂룄룆", 5, "룍룎룏룑룒룓룕", 7, "룞룠룢", 5, "룪룫룭룮룯룱", 6, "룺룼룾", 5, "뤅", 18, "뤙", 6, "뤡", 26, "뤾뤿륁륂륃륅", 6, "륍륎륐륒", 5],
      ["9041", "륚륛륝륞륟륡", 6, "륪륬륮", 5, "륶륷륹륺륻륽"],
      ["9061", "륾", 5, "릆릈릋릌릏", 15],
      ["9081", "릟", 12, "릮릯릱릲릳릵", 6, "릾맀맂", 5, "맊맋맍맓", 4, "맚맜맟맠맢맦맧맩맪맫맭", 6, "맶맻", 4, "먂", 5, "먉", 11, "먖", 33, "먺먻먽먾먿멁멃멄멅멆"],
      ["9141", "멇멊멌멏멐멑멒멖멗멙멚멛멝", 6, "멦멪", 5],
      ["9161", "멲멳멵멶멷멹", 9, "몆몈몉몊몋몍", 5],
      ["9181", "몓", 20, "몪몭몮몯몱몳", 4, "몺몼몾", 5, "뫅뫆뫇뫉", 14, "뫚", 33, "뫽뫾뫿묁묂묃묅", 7, "묎묐묒", 5, "묙묚묛묝묞묟묡", 6],
      ["9241", "묨묪묬", 7, "묷묹묺묿", 4, "뭆뭈뭊뭋뭌뭎뭑뭒"],
      ["9261", "뭓뭕뭖뭗뭙", 7, "뭢뭤", 7, "뭭", 4],
      ["9281", "뭲", 21, "뮉뮊뮋뮍뮎뮏뮑", 18, "뮥뮦뮧뮩뮪뮫뮭", 6, "뮵뮶뮸", 7, "믁믂믃믅믆믇믉", 6, "믑믒믔", 35, "믺믻믽믾밁"],
      ["9341", "밃", 4, "밊밎밐밒밓밙밚밠밡밢밣밦밨밪밫밬밮밯밲밳밵"],
      ["9361", "밶밷밹", 6, "뱂뱆뱇뱈뱊뱋뱎뱏뱑", 8],
      ["9381", "뱚뱛뱜뱞", 37, "벆벇벉벊벍벏", 4, "벖벘벛", 4, "벢벣벥벦벩", 6, "벲벶", 5, "벾벿볁볂볃볅", 7, "볎볒볓볔볖볗볙볚볛볝", 22, "볷볹볺볻볽"],
      ["9441", "볾", 5, "봆봈봊", 5, "봑봒봓봕", 8],
      ["9461", "봞", 5, "봥", 6, "봭", 12],
      ["9481", "봺", 5, "뵁", 6, "뵊뵋뵍뵎뵏뵑", 6, "뵚", 9, "뵥뵦뵧뵩", 22, "붂붃붅붆붋", 4, "붒붔붖붗붘붛붝", 6, "붥", 10, "붱", 6, "붹", 24],
      ["9541", "뷒뷓뷖뷗뷙뷚뷛뷝", 11, "뷪", 5, "뷱"],
      ["9561", "뷲뷳뷵뷶뷷뷹", 6, "븁븂븄븆", 5, "븎븏븑븒븓"],
      ["9581", "븕", 6, "븞븠", 35, "빆빇빉빊빋빍빏", 4, "빖빘빜빝빞빟빢빣빥빦빧빩빫", 4, "빲빶", 4, "빾빿뺁뺂뺃뺅", 6, "뺎뺒", 5, "뺚", 13, "뺩", 14],
      ["9641", "뺸", 23, "뻒뻓"],
      ["9661", "뻕뻖뻙", 6, "뻡뻢뻦", 5, "뻭", 8],
      ["9681", "뻶", 10, "뼂", 5, "뼊", 13, "뼚뼞", 33, "뽂뽃뽅뽆뽇뽉", 6, "뽒뽓뽔뽖", 44],
      ["9741", "뾃", 16, "뾕", 8],
      ["9761", "뾞", 17, "뾱", 7],
      ["9781", "뾹", 11, "뿆", 5, "뿎뿏뿑뿒뿓뿕", 6, "뿝뿞뿠뿢", 89, "쀽쀾쀿"],
      ["9841", "쁀", 16, "쁒", 5, "쁙쁚쁛"],
      ["9861", "쁝쁞쁟쁡", 6, "쁪", 15],
      ["9881", "쁺", 21, "삒삓삕삖삗삙", 6, "삢삤삦", 5, "삮삱삲삷", 4, "삾샂샃샄샆샇샊샋샍샎샏샑", 6, "샚샞", 5, "샦샧샩샪샫샭", 6, "샶샸샺", 5, "섁섂섃섅섆섇섉", 6, "섑섒섓섔섖", 5, "섡섢섥섨섩섪섫섮"],
      ["9941", "섲섳섴섵섷섺섻섽섾섿셁", 6, "셊셎", 5, "셖셗"],
      ["9961", "셙셚셛셝", 6, "셦셪", 5, "셱셲셳셵셶셷셹셺셻"],
      ["9981", "셼", 8, "솆", 5, "솏솑솒솓솕솗", 4, "솞솠솢솣솤솦솧솪솫솭솮솯솱", 11, "솾", 5, "쇅쇆쇇쇉쇊쇋쇍", 6, "쇕쇖쇙", 6, "쇡쇢쇣쇥쇦쇧쇩", 6, "쇲쇴", 7, "쇾쇿숁숂숃숅", 6, "숎숐숒", 5, "숚숛숝숞숡숢숣"],
      ["9a41", "숤숥숦숧숪숬숮숰숳숵", 16],
      ["9a61", "쉆쉇쉉", 6, "쉒쉓쉕쉖쉗쉙", 6, "쉡쉢쉣쉤쉦"],
      ["9a81", "쉧", 4, "쉮쉯쉱쉲쉳쉵", 6, "쉾슀슂", 5, "슊", 5, "슑", 6, "슙슚슜슞", 5, "슦슧슩슪슫슮", 5, "슶슸슺", 33, "싞싟싡싢싥", 5, "싮싰싲싳싴싵싷싺싽싾싿쌁", 6, "쌊쌋쌎쌏"],
      ["9b41", "쌐쌑쌒쌖쌗쌙쌚쌛쌝", 6, "쌦쌧쌪", 8],
      ["9b61", "쌳", 17, "썆", 7],
      ["9b81", "썎", 25, "썪썫썭썮썯썱썳", 4, "썺썻썾", 5, "쎅쎆쎇쎉쎊쎋쎍", 50, "쏁", 22, "쏚"],
      ["9c41", "쏛쏝쏞쏡쏣", 4, "쏪쏫쏬쏮", 5, "쏶쏷쏹", 5],
      ["9c61", "쏿", 8, "쐉", 6, "쐑", 9],
      ["9c81", "쐛", 8, "쐥", 6, "쐭쐮쐯쐱쐲쐳쐵", 6, "쐾", 9, "쑉", 26, "쑦쑧쑩쑪쑫쑭", 6, "쑶쑷쑸쑺", 5, "쒁", 18, "쒕", 6, "쒝", 12],
      ["9d41", "쒪", 13, "쒹쒺쒻쒽", 8],
      ["9d61", "쓆", 25],
      ["9d81", "쓠", 8, "쓪", 5, "쓲쓳쓵쓶쓷쓹쓻쓼쓽쓾씂", 9, "씍씎씏씑씒씓씕", 6, "씝", 10, "씪씫씭씮씯씱", 6, "씺씼씾", 5, "앆앇앋앏앐앑앒앖앚앛앜앟앢앣앥앦앧앩", 6, "앲앶", 5, "앾앿얁얂얃얅얆얈얉얊얋얎얐얒얓얔"],
      ["9e41", "얖얙얚얛얝얞얟얡", 7, "얪", 9, "얶"],
      ["9e61", "얷얺얿", 4, "엋엍엏엒엓엕엖엗엙", 6, "엢엤엦엧"],
      ["9e81", "엨엩엪엫엯엱엲엳엵엸엹엺엻옂옃옄옉옊옋옍옎옏옑", 6, "옚옝", 6, "옦옧옩옪옫옯옱옲옶옸옺옼옽옾옿왂왃왅왆왇왉", 6, "왒왖", 5, "왞왟왡", 10, "왭왮왰왲", 5, "왺왻왽왾왿욁", 6, "욊욌욎", 5, "욖욗욙욚욛욝", 6, "욦"],
      ["9f41", "욨욪", 5, "욲욳욵욶욷욻", 4, "웂웄웆", 5, "웎"],
      ["9f61", "웏웑웒웓웕", 6, "웞웟웢", 5, "웪웫웭웮웯웱웲"],
      ["9f81", "웳", 4, "웺웻웼웾", 5, "윆윇윉윊윋윍", 6, "윖윘윚", 5, "윢윣윥윦윧윩", 6, "윲윴윶윸윹윺윻윾윿읁읂읃읅", 4, "읋읎읐읙읚읛읝읞읟읡", 6, "읩읪읬", 7, "읶읷읹읺읻읿잀잁잂잆잋잌잍잏잒잓잕잙잛", 4, "잢잧", 4, "잮잯잱잲잳잵잶잷"],
      ["a041", "잸잹잺잻잾쟂", 5, "쟊쟋쟍쟏쟑", 6, "쟙쟚쟛쟜"],
      ["a061", "쟞", 5, "쟥쟦쟧쟩쟪쟫쟭", 13],
      ["a081", "쟻", 4, "젂젃젅젆젇젉젋", 4, "젒젔젗", 4, "젞젟젡젢젣젥", 6, "젮젰젲", 5, "젹젺젻젽젾젿졁", 6, "졊졋졎", 5, "졕", 26, "졲졳졵졶졷졹졻", 4, "좂좄좈좉좊좎", 5, "좕", 7, "좞좠좢좣좤"],
      ["a141", "좥좦좧좩", 18, "좾좿죀죁"],
      ["a161", "죂죃죅죆죇죉죊죋죍", 6, "죖죘죚", 5, "죢죣죥"],
      ["a181", "죦", 14, "죶", 5, "죾죿줁줂줃줇", 4, "줎　、。·‥…¨〃­―∥＼∼‘’“”〔〕〈", 9, "±×÷≠≤≥∞∴°′″℃Å￠￡￥♂♀∠⊥⌒∂∇≡≒§※☆★○●◎◇◆□■△▲▽▼→←↑↓↔〓≪≫√∽∝∵∫∬∈∋⊆⊇⊂⊃∪∩∧∨￢"],
      ["a241", "줐줒", 5, "줙", 18],
      ["a261", "줭", 6, "줵", 18],
      ["a281", "쥈", 7, "쥒쥓쥕쥖쥗쥙", 6, "쥢쥤", 7, "쥭쥮쥯⇒⇔∀∃´～ˇ˘˝˚˙¸˛¡¿ː∮∑∏¤℉‰◁◀▷▶♤♠♡♥♧♣⊙◈▣◐◑▒▤▥▨▧▦▩♨☏☎☜☞¶†‡↕↗↙↖↘♭♩♪♬㉿㈜№㏇™㏂㏘℡€®"],
      ["a341", "쥱쥲쥳쥵", 6, "쥽", 10, "즊즋즍즎즏"],
      ["a361", "즑", 6, "즚즜즞", 16],
      ["a381", "즯", 16, "짂짃짅짆짉짋", 4, "짒짔짗짘짛！", 58, "￦］", 32, "￣"],
      ["a441", "짞짟짡짣짥짦짨짩짪짫짮짲", 5, "짺짻짽짾짿쨁쨂쨃쨄"],
      ["a461", "쨅쨆쨇쨊쨎", 5, "쨕쨖쨗쨙", 12],
      ["a481", "쨦쨧쨨쨪", 28, "ㄱ", 93],
      ["a541", "쩇", 4, "쩎쩏쩑쩒쩓쩕", 6, "쩞쩢", 5, "쩩쩪"],
      ["a561", "쩫", 17, "쩾", 5, "쪅쪆"],
      ["a581", "쪇", 16, "쪙", 14, "ⅰ", 9],
      ["a5b0", "Ⅰ", 9],
      ["a5c1", "Α", 16, "Σ", 6],
      ["a5e1", "α", 16, "σ", 6],
      ["a641", "쪨", 19, "쪾쪿쫁쫂쫃쫅"],
      ["a661", "쫆", 5, "쫎쫐쫒쫔쫕쫖쫗쫚", 5, "쫡", 6],
      ["a681", "쫨쫩쫪쫫쫭", 6, "쫵", 18, "쬉쬊─│┌┐┘└├┬┤┴┼━┃┏┓┛┗┣┳┫┻╋┠┯┨┷┿┝┰┥┸╂┒┑┚┙┖┕┎┍┞┟┡┢┦┧┩┪┭┮┱┲┵┶┹┺┽┾╀╁╃", 7],
      ["a741", "쬋", 4, "쬑쬒쬓쬕쬖쬗쬙", 6, "쬢", 7],
      ["a761", "쬪", 22, "쭂쭃쭄"],
      ["a781", "쭅쭆쭇쭊쭋쭍쭎쭏쭑", 6, "쭚쭛쭜쭞", 5, "쭥", 7, "㎕㎖㎗ℓ㎘㏄㎣㎤㎥㎦㎙", 9, "㏊㎍㎎㎏㏏㎈㎉㏈㎧㎨㎰", 9, "㎀", 4, "㎺", 5, "㎐", 4, "Ω㏀㏁㎊㎋㎌㏖㏅㎭㎮㎯㏛㎩㎪㎫㎬㏝㏐㏓㏃㏉㏜㏆"],
      ["a841", "쭭", 10, "쭺", 14],
      ["a861", "쮉", 18, "쮝", 6],
      ["a881", "쮤", 19, "쮹", 11, "ÆÐªĦ"],
      ["a8a6", "Ĳ"],
      ["a8a8", "ĿŁØŒºÞŦŊ"],
      ["a8b1", "㉠", 27, "ⓐ", 25, "①", 14, "½⅓⅔¼¾⅛⅜⅝⅞"],
      ["a941", "쯅", 14, "쯕", 10],
      ["a961", "쯠쯡쯢쯣쯥쯦쯨쯪", 18],
      ["a981", "쯽", 14, "찎찏찑찒찓찕", 6, "찞찟찠찣찤æđðħıĳĸŀłøœßþŧŋŉ㈀", 27, "⒜", 25, "⑴", 14, "¹²³⁴ⁿ₁₂₃₄"],
      ["aa41", "찥찦찪찫찭찯찱", 6, "찺찿", 4, "챆챇챉챊챋챍챎"],
      ["aa61", "챏", 4, "챖챚", 5, "챡챢챣챥챧챩", 6, "챱챲"],
      ["aa81", "챳챴챶", 29, "ぁ", 82],
      ["ab41", "첔첕첖첗첚첛첝첞첟첡", 6, "첪첮", 5, "첶첷첹"],
      ["ab61", "첺첻첽", 6, "쳆쳈쳊", 5, "쳑쳒쳓쳕", 5],
      ["ab81", "쳛", 8, "쳥", 6, "쳭쳮쳯쳱", 12, "ァ", 85],
      ["ac41", "쳾쳿촀촂", 5, "촊촋촍촎촏촑", 6, "촚촜촞촟촠"],
      ["ac61", "촡촢촣촥촦촧촩촪촫촭", 11, "촺", 4],
      ["ac81", "촿", 28, "쵝쵞쵟А", 5, "ЁЖ", 25],
      ["acd1", "а", 5, "ёж", 25],
      ["ad41", "쵡쵢쵣쵥", 6, "쵮쵰쵲", 5, "쵹", 7],
      ["ad61", "춁", 6, "춉", 10, "춖춗춙춚춛춝춞춟"],
      ["ad81", "춠춡춢춣춦춨춪", 5, "춱", 18, "췅"],
      ["ae41", "췆", 5, "췍췎췏췑", 16],
      ["ae61", "췢", 5, "췩췪췫췭췮췯췱", 6, "췺췼췾", 4],
      ["ae81", "츃츅츆츇츉츊츋츍", 6, "츕츖츗츘츚", 5, "츢츣츥츦츧츩츪츫"],
      ["af41", "츬츭츮츯츲츴츶", 19],
      ["af61", "칊", 13, "칚칛칝칞칢", 5, "칪칬"],
      ["af81", "칮", 5, "칶칷칹칺칻칽", 6, "캆캈캊", 5, "캒캓캕캖캗캙"],
      ["b041", "캚", 5, "캢캦", 5, "캮", 12],
      ["b061", "캻", 5, "컂", 19],
      ["b081", "컖", 13, "컦컧컩컪컭", 6, "컶컺", 5, "가각간갇갈갉갊감", 7, "같", 4, "갠갤갬갭갯갰갱갸갹갼걀걋걍걔걘걜거걱건걷걸걺검겁것겄겅겆겉겊겋게겐겔겜겝겟겠겡겨격겪견겯결겸겹겻겼경곁계곈곌곕곗고곡곤곧골곪곬곯곰곱곳공곶과곽관괄괆"],
      ["b141", "켂켃켅켆켇켉", 6, "켒켔켖", 5, "켝켞켟켡켢켣"],
      ["b161", "켥", 6, "켮켲", 5, "켹", 11],
      ["b181", "콅", 14, "콖콗콙콚콛콝", 6, "콦콨콪콫콬괌괍괏광괘괜괠괩괬괭괴괵괸괼굄굅굇굉교굔굘굡굣구국군굳굴굵굶굻굼굽굿궁궂궈궉권궐궜궝궤궷귀귁귄귈귐귑귓규균귤그극근귿글긁금급긋긍긔기긱긴긷길긺김깁깃깅깆깊까깍깎깐깔깖깜깝깟깠깡깥깨깩깬깰깸"],
      ["b241", "콭콮콯콲콳콵콶콷콹", 6, "쾁쾂쾃쾄쾆", 5, "쾍"],
      ["b261", "쾎", 18, "쾢", 5, "쾩"],
      ["b281", "쾪", 5, "쾱", 18, "쿅", 6, "깹깻깼깽꺄꺅꺌꺼꺽꺾껀껄껌껍껏껐껑께껙껜껨껫껭껴껸껼꼇꼈꼍꼐꼬꼭꼰꼲꼴꼼꼽꼿꽁꽂꽃꽈꽉꽐꽜꽝꽤꽥꽹꾀꾄꾈꾐꾑꾕꾜꾸꾹꾼꿀꿇꿈꿉꿋꿍꿎꿔꿜꿨꿩꿰꿱꿴꿸뀀뀁뀄뀌뀐뀔뀜뀝뀨끄끅끈끊끌끎끓끔끕끗끙"],
      ["b341", "쿌", 19, "쿢쿣쿥쿦쿧쿩"],
      ["b361", "쿪", 5, "쿲쿴쿶", 5, "쿽쿾쿿퀁퀂퀃퀅", 5],
      ["b381", "퀋", 5, "퀒", 5, "퀙", 19, "끝끼끽낀낄낌낍낏낑나낙낚난낟날낡낢남납낫", 4, "낱낳내낵낸낼냄냅냇냈냉냐냑냔냘냠냥너넉넋넌널넒넓넘넙넛넜넝넣네넥넨넬넴넵넷넸넹녀녁년녈념녑녔녕녘녜녠노녹논놀놂놈놉놋농높놓놔놘놜놨뇌뇐뇔뇜뇝"],
      ["b441", "퀮", 5, "퀶퀷퀹퀺퀻퀽", 6, "큆큈큊", 5],
      ["b461", "큑큒큓큕큖큗큙", 6, "큡", 10, "큮큯"],
      ["b481", "큱큲큳큵", 6, "큾큿킀킂", 18, "뇟뇨뇩뇬뇰뇹뇻뇽누눅눈눋눌눔눕눗눙눠눴눼뉘뉜뉠뉨뉩뉴뉵뉼늄늅늉느늑는늘늙늚늠늡늣능늦늪늬늰늴니닉닌닐닒님닙닛닝닢다닥닦단닫", 4, "닳담답닷", 4, "닿대댁댄댈댐댑댓댔댕댜더덕덖던덛덜덞덟덤덥"],
      ["b541", "킕", 14, "킦킧킩킪킫킭", 5],
      ["b561", "킳킶킸킺", 5, "탂탃탅탆탇탊", 5, "탒탖", 4],
      ["b581", "탛탞탟탡탢탣탥", 6, "탮탲", 5, "탹", 11, "덧덩덫덮데덱덴델뎀뎁뎃뎄뎅뎌뎐뎔뎠뎡뎨뎬도독돈돋돌돎돐돔돕돗동돛돝돠돤돨돼됐되된될됨됩됫됴두둑둔둘둠둡둣둥둬뒀뒈뒝뒤뒨뒬뒵뒷뒹듀듄듈듐듕드득든듣들듦듬듭듯등듸디딕딘딛딜딤딥딧딨딩딪따딱딴딸"],
      ["b641", "턅", 7, "턎", 17],
      ["b661", "턠", 15, "턲턳턵턶턷턹턻턼턽턾"],
      ["b681", "턿텂텆", 5, "텎텏텑텒텓텕", 6, "텞텠텢", 5, "텩텪텫텭땀땁땃땄땅땋때땍땐땔땜땝땟땠땡떠떡떤떨떪떫떰떱떳떴떵떻떼떽뗀뗄뗌뗍뗏뗐뗑뗘뗬또똑똔똘똥똬똴뙈뙤뙨뚜뚝뚠뚤뚫뚬뚱뛔뛰뛴뛸뜀뜁뜅뜨뜩뜬뜯뜰뜸뜹뜻띄띈띌띔띕띠띤띨띰띱띳띵라락란랄람랍랏랐랑랒랖랗"],
      ["b741", "텮", 13, "텽", 6, "톅톆톇톉톊"],
      ["b761", "톋", 20, "톢톣톥톦톧"],
      ["b781", "톩", 6, "톲톴톶톷톸톹톻톽톾톿퇁", 14, "래랙랜랠램랩랫랬랭랴략랸럇량러럭런럴럼럽럿렀렁렇레렉렌렐렘렙렛렝려력련렬렴렵렷렸령례롄롑롓로록론롤롬롭롯롱롸롼뢍뢨뢰뢴뢸룀룁룃룅료룐룔룝룟룡루룩룬룰룸룹룻룽뤄뤘뤠뤼뤽륀륄륌륏륑류륙륜률륨륩"],
      ["b841", "퇐", 7, "퇙", 17],
      ["b861", "퇫", 8, "퇵퇶퇷퇹", 13],
      ["b881", "툈툊", 5, "툑", 24, "륫륭르륵른를름릅릇릉릊릍릎리릭린릴림립릿링마막만많", 4, "맘맙맛망맞맡맣매맥맨맬맴맵맷맸맹맺먀먁먈먕머먹먼멀멂멈멉멋멍멎멓메멕멘멜멤멥멧멨멩며멱면멸몃몄명몇몌모목몫몬몰몲몸몹못몽뫄뫈뫘뫙뫼"],
      ["b941", "툪툫툮툯툱툲툳툵", 6, "툾퉀퉂", 5, "퉉퉊퉋퉌"],
      ["b961", "퉍", 14, "퉝", 6, "퉥퉦퉧퉨"],
      ["b981", "퉩", 22, "튂튃튅튆튇튉튊튋튌묀묄묍묏묑묘묜묠묩묫무묵묶문묻물묽묾뭄뭅뭇뭉뭍뭏뭐뭔뭘뭡뭣뭬뮈뮌뮐뮤뮨뮬뮴뮷므믄믈믐믓미믹민믿밀밂밈밉밋밌밍및밑바", 4, "받", 4, "밤밥밧방밭배백밴밸뱀뱁뱃뱄뱅뱉뱌뱍뱐뱝버벅번벋벌벎범법벗"],
      ["ba41", "튍튎튏튒튓튔튖", 5, "튝튞튟튡튢튣튥", 6, "튭"],
      ["ba61", "튮튯튰튲", 5, "튺튻튽튾틁틃", 4, "틊틌", 5],
      ["ba81", "틒틓틕틖틗틙틚틛틝", 6, "틦", 9, "틲틳틵틶틷틹틺벙벚베벡벤벧벨벰벱벳벴벵벼벽변별볍볏볐병볕볘볜보복볶본볼봄봅봇봉봐봔봤봬뵀뵈뵉뵌뵐뵘뵙뵤뵨부북분붇불붉붊붐붑붓붕붙붚붜붤붰붸뷔뷕뷘뷜뷩뷰뷴뷸븀븃븅브븍븐블븜븝븟비빅빈빌빎빔빕빗빙빚빛빠빡빤"],
      ["bb41", "틻", 4, "팂팄팆", 5, "팏팑팒팓팕팗", 4, "팞팢팣"],
      ["bb61", "팤팦팧팪팫팭팮팯팱", 6, "팺팾", 5, "퍆퍇퍈퍉"],
      ["bb81", "퍊", 31, "빨빪빰빱빳빴빵빻빼빽뺀뺄뺌뺍뺏뺐뺑뺘뺙뺨뻐뻑뻔뻗뻘뻠뻣뻤뻥뻬뼁뼈뼉뼘뼙뼛뼜뼝뽀뽁뽄뽈뽐뽑뽕뾔뾰뿅뿌뿍뿐뿔뿜뿟뿡쀼쁑쁘쁜쁠쁨쁩삐삑삔삘삠삡삣삥사삭삯산삳살삵삶삼삽삿샀상샅새색샌샐샘샙샛샜생샤"],
      ["bc41", "퍪", 17, "퍾퍿펁펂펃펅펆펇"],
      ["bc61", "펈펉펊펋펎펒", 5, "펚펛펝펞펟펡", 6, "펪펬펮"],
      ["bc81", "펯", 4, "펵펶펷펹펺펻펽", 6, "폆폇폊", 5, "폑", 5, "샥샨샬샴샵샷샹섀섄섈섐섕서", 4, "섣설섦섧섬섭섯섰성섶세섹센셀셈셉셋셌셍셔셕션셜셤셥셧셨셩셰셴셸솅소속솎손솔솖솜솝솟송솥솨솩솬솰솽쇄쇈쇌쇔쇗쇘쇠쇤쇨쇰쇱쇳쇼쇽숀숄숌숍숏숑수숙순숟술숨숩숫숭"],
      ["bd41", "폗폙", 7, "폢폤", 7, "폮폯폱폲폳폵폶폷"],
      ["bd61", "폸폹폺폻폾퐀퐂", 5, "퐉", 13],
      ["bd81", "퐗", 5, "퐞", 25, "숯숱숲숴쉈쉐쉑쉔쉘쉠쉥쉬쉭쉰쉴쉼쉽쉿슁슈슉슐슘슛슝스슥슨슬슭슴습슷승시식신싣실싫심십싯싱싶싸싹싻싼쌀쌈쌉쌌쌍쌓쌔쌕쌘쌜쌤쌥쌨쌩썅써썩썬썰썲썸썹썼썽쎄쎈쎌쏀쏘쏙쏜쏟쏠쏢쏨쏩쏭쏴쏵쏸쐈쐐쐤쐬쐰"],
      ["be41", "퐸", 7, "푁푂푃푅", 14],
      ["be61", "푔", 7, "푝푞푟푡푢푣푥", 7, "푮푰푱푲"],
      ["be81", "푳", 4, "푺푻푽푾풁풃", 4, "풊풌풎", 5, "풕", 8, "쐴쐼쐽쑈쑤쑥쑨쑬쑴쑵쑹쒀쒔쒜쒸쒼쓩쓰쓱쓴쓸쓺쓿씀씁씌씐씔씜씨씩씬씰씸씹씻씽아악안앉않알앍앎앓암압앗았앙앝앞애액앤앨앰앱앳앴앵야약얀얄얇얌얍얏양얕얗얘얜얠얩어억언얹얻얼얽얾엄", 6, "엌엎"],
      ["bf41", "풞", 10, "풪", 14],
      ["bf61", "풹", 18, "퓍퓎퓏퓑퓒퓓퓕"],
      ["bf81", "퓖", 5, "퓝퓞퓠", 7, "퓩퓪퓫퓭퓮퓯퓱", 6, "퓹퓺퓼에엑엔엘엠엡엣엥여역엮연열엶엷염", 5, "옅옆옇예옌옐옘옙옛옜오옥온올옭옮옰옳옴옵옷옹옻와왁완왈왐왑왓왔왕왜왝왠왬왯왱외왹왼욀욈욉욋욍요욕욘욜욤욥욧용우욱운울욹욺움웁웃웅워웍원월웜웝웠웡웨"],
      ["c041", "퓾", 5, "픅픆픇픉픊픋픍", 6, "픖픘", 5],
      ["c061", "픞", 25],
      ["c081", "픸픹픺픻픾픿핁핂핃핅", 6, "핎핐핒", 5, "핚핛핝핞핟핡핢핣웩웬웰웸웹웽위윅윈윌윔윕윗윙유육윤율윰윱윳융윷으윽은을읊음읍읏응", 7, "읜읠읨읫이익인일읽읾잃임입잇있잉잊잎자작잔잖잗잘잚잠잡잣잤장잦재잭잰잴잼잽잿쟀쟁쟈쟉쟌쟎쟐쟘쟝쟤쟨쟬저적전절젊"],
      ["c141", "핤핦핧핪핬핮", 5, "핶핷핹핺핻핽", 6, "햆햊햋"],
      ["c161", "햌햍햎햏햑", 19, "햦햧"],
      ["c181", "햨", 31, "점접젓정젖제젝젠젤젬젭젯젱져젼졀졈졉졌졍졔조족존졸졺좀좁좃종좆좇좋좌좍좔좝좟좡좨좼좽죄죈죌죔죕죗죙죠죡죤죵주죽준줄줅줆줌줍줏중줘줬줴쥐쥑쥔쥘쥠쥡쥣쥬쥰쥴쥼즈즉즌즐즘즙즛증지직진짇질짊짐집짓"],
      ["c241", "헊헋헍헎헏헑헓", 4, "헚헜헞", 5, "헦헧헩헪헫헭헮"],
      ["c261", "헯", 4, "헶헸헺", 5, "혂혃혅혆혇혉", 6, "혒"],
      ["c281", "혖", 5, "혝혞혟혡혢혣혥", 7, "혮", 9, "혺혻징짖짙짚짜짝짠짢짤짧짬짭짯짰짱째짹짼쨀쨈쨉쨋쨌쨍쨔쨘쨩쩌쩍쩐쩔쩜쩝쩟쩠쩡쩨쩽쪄쪘쪼쪽쫀쫄쫌쫍쫏쫑쫓쫘쫙쫠쫬쫴쬈쬐쬔쬘쬠쬡쭁쭈쭉쭌쭐쭘쭙쭝쭤쭸쭹쮜쮸쯔쯤쯧쯩찌찍찐찔찜찝찡찢찧차착찬찮찰참찹찻"],
      ["c341", "혽혾혿홁홂홃홄홆홇홊홌홎홏홐홒홓홖홗홙홚홛홝", 4],
      ["c361", "홢", 4, "홨홪", 5, "홲홳홵", 11],
      ["c381", "횁횂횄횆", 5, "횎횏횑횒횓횕", 7, "횞횠횢", 5, "횩횪찼창찾채책챈챌챔챕챗챘챙챠챤챦챨챰챵처척천철첨첩첫첬청체첵첸첼쳄쳅쳇쳉쳐쳔쳤쳬쳰촁초촉촌촐촘촙촛총촤촨촬촹최쵠쵤쵬쵭쵯쵱쵸춈추축춘출춤춥춧충춰췄췌췐취췬췰췸췹췻췽츄츈츌츔츙츠측츤츨츰츱츳층"],
      ["c441", "횫횭횮횯횱", 7, "횺횼", 7, "훆훇훉훊훋"],
      ["c461", "훍훎훏훐훒훓훕훖훘훚", 5, "훡훢훣훥훦훧훩", 4],
      ["c481", "훮훯훱훲훳훴훶", 5, "훾훿휁휂휃휅", 11, "휒휓휔치칙친칟칠칡침칩칫칭카칵칸칼캄캅캇캉캐캑캔캘캠캡캣캤캥캬캭컁커컥컨컫컬컴컵컷컸컹케켁켄켈켐켑켓켕켜켠켤켬켭켯켰켱켸코콕콘콜콤콥콧콩콰콱콴콸쾀쾅쾌쾡쾨쾰쿄쿠쿡쿤쿨쿰쿱쿳쿵쿼퀀퀄퀑퀘퀭퀴퀵퀸퀼"],
      ["c541", "휕휖휗휚휛휝휞휟휡", 6, "휪휬휮", 5, "휶휷휹"],
      ["c561", "휺휻휽", 6, "흅흆흈흊", 5, "흒흓흕흚", 4],
      ["c581", "흟흢흤흦흧흨흪흫흭흮흯흱흲흳흵", 6, "흾흿힀힂", 5, "힊힋큄큅큇큉큐큔큘큠크큭큰클큼큽킁키킥킨킬킴킵킷킹타탁탄탈탉탐탑탓탔탕태택탠탤탬탭탯탰탱탸턍터턱턴털턺텀텁텃텄텅테텍텐텔템텝텟텡텨텬텼톄톈토톡톤톨톰톱톳통톺톼퇀퇘퇴퇸툇툉툐투툭툰툴툼툽툿퉁퉈퉜"],
      ["c641", "힍힎힏힑", 6, "힚힜힞", 5],
      ["c6a1", "퉤튀튁튄튈튐튑튕튜튠튤튬튱트특튼튿틀틂틈틉틋틔틘틜틤틥티틱틴틸팀팁팃팅파팍팎판팔팖팜팝팟팠팡팥패팩팬팰팸팹팻팼팽퍄퍅퍼퍽펀펄펌펍펏펐펑페펙펜펠펨펩펫펭펴편펼폄폅폈평폐폘폡폣포폭폰폴폼폽폿퐁"],
      ["c7a1", "퐈퐝푀푄표푠푤푭푯푸푹푼푿풀풂품풉풋풍풔풩퓌퓐퓔퓜퓟퓨퓬퓰퓸퓻퓽프픈플픔픕픗피픽핀필핌핍핏핑하학한할핥함합핫항해핵핸핼햄햅햇했행햐향허헉헌헐헒험헙헛헝헤헥헨헬헴헵헷헹혀혁현혈혐협혓혔형혜혠"],
      ["c8a1", "혤혭호혹혼홀홅홈홉홋홍홑화확환활홧황홰홱홴횃횅회획횐횔횝횟횡효횬횰횹횻후훅훈훌훑훔훗훙훠훤훨훰훵훼훽휀휄휑휘휙휜휠휨휩휫휭휴휵휸휼흄흇흉흐흑흔흖흗흘흙흠흡흣흥흩희흰흴흼흽힁히힉힌힐힘힙힛힝"],
      ["caa1", "伽佳假價加可呵哥嘉嫁家暇架枷柯歌珂痂稼苛茄街袈訶賈跏軻迦駕刻却各恪慤殼珏脚覺角閣侃刊墾奸姦干幹懇揀杆柬桿澗癎看磵稈竿簡肝艮艱諫間乫喝曷渴碣竭葛褐蝎鞨勘坎堪嵌感憾戡敢柑橄減甘疳監瞰紺邯鑑鑒龕"],
      ["cba1", "匣岬甲胛鉀閘剛堈姜岡崗康强彊慷江畺疆糠絳綱羌腔舡薑襁講鋼降鱇介价個凱塏愷愾慨改槪漑疥皆盖箇芥蓋豈鎧開喀客坑更粳羹醵倨去居巨拒据據擧渠炬祛距踞車遽鉅鋸乾件健巾建愆楗腱虔蹇鍵騫乞傑杰桀儉劍劒檢"],
      ["cca1", "瞼鈐黔劫怯迲偈憩揭擊格檄激膈覡隔堅牽犬甄絹繭肩見譴遣鵑抉決潔結缺訣兼慊箝謙鉗鎌京俓倞傾儆勁勍卿坰境庚徑慶憬擎敬景暻更梗涇炅烱璟璥瓊痙硬磬竟競絅經耕耿脛莖警輕逕鏡頃頸驚鯨係啓堺契季屆悸戒桂械"],
      ["cda1", "棨溪界癸磎稽系繫繼計誡谿階鷄古叩告呱固姑孤尻庫拷攷故敲暠枯槁沽痼皐睾稿羔考股膏苦苽菰藁蠱袴誥賈辜錮雇顧高鼓哭斛曲梏穀谷鵠困坤崑昆梱棍滾琨袞鯤汨滑骨供公共功孔工恐恭拱控攻珙空蚣貢鞏串寡戈果瓜"],
      ["cea1", "科菓誇課跨過鍋顆廓槨藿郭串冠官寬慣棺款灌琯瓘管罐菅觀貫關館刮恝括适侊光匡壙廣曠洸炚狂珖筐胱鑛卦掛罫乖傀塊壞怪愧拐槐魁宏紘肱轟交僑咬喬嬌嶠巧攪敎校橋狡皎矯絞翹膠蕎蛟較轎郊餃驕鮫丘久九仇俱具勾"],
      ["cfa1", "區口句咎嘔坵垢寇嶇廐懼拘救枸柩構歐毆毬求溝灸狗玖球瞿矩究絿耉臼舅舊苟衢謳購軀逑邱鉤銶駒驅鳩鷗龜國局菊鞠鞫麴君窘群裙軍郡堀屈掘窟宮弓穹窮芎躬倦券勸卷圈拳捲權淃眷厥獗蕨蹶闕机櫃潰詭軌饋句晷歸貴"],
      ["d0a1", "鬼龜叫圭奎揆槻珪硅窺竅糾葵規赳逵閨勻均畇筠菌鈞龜橘克剋劇戟棘極隙僅劤勤懃斤根槿瑾筋芹菫覲謹近饉契今妗擒昑檎琴禁禽芩衾衿襟金錦伋及急扱汲級給亘兢矜肯企伎其冀嗜器圻基埼夔奇妓寄岐崎己幾忌技旗旣"],
      ["d1a1", "朞期杞棋棄機欺氣汽沂淇玘琦琪璂璣畸畿碁磯祁祇祈祺箕紀綺羈耆耭肌記譏豈起錡錤飢饑騎騏驥麒緊佶吉拮桔金喫儺喇奈娜懦懶拏拿癩", 5, "那樂", 4, "諾酪駱亂卵暖欄煖爛蘭難鸞捏捺南嵐枏楠湳濫男藍襤拉"],
      ["d2a1", "納臘蠟衲囊娘廊", 4, "乃來內奈柰耐冷女年撚秊念恬拈捻寧寗努勞奴弩怒擄櫓爐瑙盧", 5, "駑魯", 10, "濃籠聾膿農惱牢磊腦賂雷尿壘", 7, "嫩訥杻紐勒", 5, "能菱陵尼泥匿溺多茶"],
      ["d3a1", "丹亶但單團壇彖斷旦檀段湍短端簞緞蛋袒鄲鍛撻澾獺疸達啖坍憺擔曇淡湛潭澹痰聃膽蕁覃談譚錟沓畓答踏遝唐堂塘幢戇撞棠當糖螳黨代垈坮大對岱帶待戴擡玳臺袋貸隊黛宅德悳倒刀到圖堵塗導屠島嶋度徒悼挑掉搗桃"],
      ["d4a1", "棹櫂淘渡滔濤燾盜睹禱稻萄覩賭跳蹈逃途道都鍍陶韜毒瀆牘犢獨督禿篤纛讀墩惇敦旽暾沌焞燉豚頓乭突仝冬凍動同憧東桐棟洞潼疼瞳童胴董銅兜斗杜枓痘竇荳讀豆逗頭屯臀芚遁遯鈍得嶝橙燈登等藤謄鄧騰喇懶拏癩羅"],
      ["d5a1", "蘿螺裸邏樂洛烙珞絡落諾酪駱丹亂卵欄欒瀾爛蘭鸞剌辣嵐擥攬欖濫籃纜藍襤覽拉臘蠟廊朗浪狼琅瑯螂郞來崍徠萊冷掠略亮倆兩凉梁樑粮粱糧良諒輛量侶儷勵呂廬慮戾旅櫚濾礪藜蠣閭驢驪麗黎力曆歷瀝礫轢靂憐戀攣漣"],
      ["d6a1", "煉璉練聯蓮輦連鍊冽列劣洌烈裂廉斂殮濂簾獵令伶囹寧岺嶺怜玲笭羚翎聆逞鈴零靈領齡例澧禮醴隷勞怒撈擄櫓潞瀘爐盧老蘆虜路輅露魯鷺鹵碌祿綠菉錄鹿麓論壟弄朧瀧瓏籠聾儡瀨牢磊賂賚賴雷了僚寮廖料燎療瞭聊蓼"],
      ["d7a1", "遼鬧龍壘婁屢樓淚漏瘻累縷蔞褸鏤陋劉旒柳榴流溜瀏琉瑠留瘤硫謬類六戮陸侖倫崙淪綸輪律慄栗率隆勒肋凜凌楞稜綾菱陵俚利厘吏唎履悧李梨浬犁狸理璃異痢籬罹羸莉裏裡里釐離鯉吝潾燐璘藺躪隣鱗麟林淋琳臨霖砬"],
      ["d8a1", "立笠粒摩瑪痲碼磨馬魔麻寞幕漠膜莫邈万卍娩巒彎慢挽晩曼滿漫灣瞞萬蔓蠻輓饅鰻唜抹末沫茉襪靺亡妄忘忙望網罔芒茫莽輞邙埋妹媒寐昧枚梅每煤罵買賣邁魅脈貊陌驀麥孟氓猛盲盟萌冪覓免冕勉棉沔眄眠綿緬面麵滅"],
      ["d9a1", "蔑冥名命明暝椧溟皿瞑茗蓂螟酩銘鳴袂侮冒募姆帽慕摸摹暮某模母毛牟牡瑁眸矛耗芼茅謀謨貌木沐牧目睦穆鶩歿沒夢朦蒙卯墓妙廟描昴杳渺猫竗苗錨務巫憮懋戊拇撫无楙武毋無珷畝繆舞茂蕪誣貿霧鵡墨默們刎吻問文"],
      ["daa1", "汶紊紋聞蚊門雯勿沕物味媚尾嵋彌微未梶楣渼湄眉米美薇謎迷靡黴岷悶愍憫敏旻旼民泯玟珉緡閔密蜜謐剝博拍搏撲朴樸泊珀璞箔粕縛膊舶薄迫雹駁伴半反叛拌搬攀斑槃泮潘班畔瘢盤盼磐磻礬絆般蟠返頒飯勃拔撥渤潑"],
      ["dba1", "發跋醱鉢髮魃倣傍坊妨尨幇彷房放方旁昉枋榜滂磅紡肪膀舫芳蒡蚌訪謗邦防龐倍俳北培徘拜排杯湃焙盃背胚裴裵褙賠輩配陪伯佰帛柏栢白百魄幡樊煩燔番磻繁蕃藩飜伐筏罰閥凡帆梵氾汎泛犯範范法琺僻劈壁擘檗璧癖"],
      ["dca1", "碧蘗闢霹便卞弁變辨辯邊別瞥鱉鼈丙倂兵屛幷昞昺柄棅炳甁病秉竝輧餠騈保堡報寶普步洑湺潽珤甫菩補褓譜輔伏僕匐卜宓復服福腹茯蔔複覆輹輻馥鰒本乶俸奉封峯峰捧棒烽熢琫縫蓬蜂逢鋒鳳不付俯傅剖副否咐埠夫婦"],
      ["dda1", "孚孵富府復扶敷斧浮溥父符簿缶腐腑膚艀芙莩訃負賦賻赴趺部釜阜附駙鳧北分吩噴墳奔奮忿憤扮昐汾焚盆粉糞紛芬賁雰不佛弗彿拂崩朋棚硼繃鵬丕備匕匪卑妃婢庇悲憊扉批斐枇榧比毖毗毘沸泌琵痺砒碑秕秘粃緋翡肥"],
      ["dea1", "脾臂菲蜚裨誹譬費鄙非飛鼻嚬嬪彬斌檳殯浜濱瀕牝玭貧賓頻憑氷聘騁乍事些仕伺似使俟僿史司唆嗣四士奢娑寫寺射巳師徙思捨斜斯柶査梭死沙泗渣瀉獅砂社祀祠私篩紗絲肆舍莎蓑蛇裟詐詞謝賜赦辭邪飼駟麝削數朔索"],
      ["dfa1", "傘刪山散汕珊産疝算蒜酸霰乷撒殺煞薩三參杉森渗芟蔘衫揷澁鈒颯上傷像償商喪嘗孀尙峠常床庠廂想桑橡湘爽牀狀相祥箱翔裳觴詳象賞霜塞璽賽嗇塞穡索色牲生甥省笙墅壻嶼序庶徐恕抒捿敍暑曙書栖棲犀瑞筮絮緖署"],
      ["e0a1", "胥舒薯西誓逝鋤黍鼠夕奭席惜昔晳析汐淅潟石碩蓆釋錫仙僊先善嬋宣扇敾旋渲煽琁瑄璇璿癬禪線繕羨腺膳船蘚蟬詵跣選銑鐥饍鮮卨屑楔泄洩渫舌薛褻設說雪齧剡暹殲纖蟾贍閃陝攝涉燮葉城姓宬性惺成星晟猩珹盛省筬"],
      ["e1a1", "聖聲腥誠醒世勢歲洗稅笹細說貰召嘯塑宵小少巢所掃搔昭梳沼消溯瀟炤燒甦疏疎瘙笑篠簫素紹蔬蕭蘇訴逍遡邵銷韶騷俗屬束涑粟續謖贖速孫巽損蓀遜飡率宋悚松淞訟誦送頌刷殺灑碎鎖衰釗修受嗽囚垂壽嫂守岫峀帥愁"],
      ["e2a1", "戍手授搜收數樹殊水洙漱燧狩獸琇璲瘦睡秀穗竪粹綏綬繡羞脩茱蒐蓚藪袖誰讐輸遂邃酬銖銹隋隧隨雖需須首髓鬚叔塾夙孰宿淑潚熟琡璹肅菽巡徇循恂旬栒楯橓殉洵淳珣盾瞬筍純脣舜荀蓴蕣詢諄醇錞順馴戌術述鉥崇崧"],
      ["e3a1", "嵩瑟膝蝨濕拾習褶襲丞乘僧勝升承昇繩蠅陞侍匙嘶始媤尸屎屍市弑恃施是時枾柴猜矢示翅蒔蓍視試詩諡豕豺埴寔式息拭植殖湜熄篒蝕識軾食飾伸侁信呻娠宸愼新晨燼申神紳腎臣莘薪藎蜃訊身辛辰迅失室實悉審尋心沁"],
      ["e4a1", "沈深瀋甚芯諶什十拾雙氏亞俄兒啞娥峨我牙芽莪蛾衙訝阿雅餓鴉鵝堊岳嶽幄惡愕握樂渥鄂鍔顎鰐齷安岸按晏案眼雁鞍顔鮟斡謁軋閼唵岩巖庵暗癌菴闇壓押狎鴨仰央怏昻殃秧鴦厓哀埃崖愛曖涯碍艾隘靄厄扼掖液縊腋額"],
      ["e5a1", "櫻罌鶯鸚也倻冶夜惹揶椰爺耶若野弱掠略約若葯蒻藥躍亮佯兩凉壤孃恙揚攘敭暘梁楊樣洋瀁煬痒瘍禳穰糧羊良襄諒讓釀陽量養圄御於漁瘀禦語馭魚齬億憶抑檍臆偃堰彦焉言諺孼蘖俺儼嚴奄掩淹嶪業円予余勵呂女如廬"],
      ["e6a1", "旅歟汝濾璵礖礪與艅茹輿轝閭餘驪麗黎亦力域役易曆歷疫繹譯轢逆驛嚥堧姸娟宴年延憐戀捐挻撚椽沇沿涎涓淵演漣烟然煙煉燃燕璉硏硯秊筵緣練縯聯衍軟輦蓮連鉛鍊鳶列劣咽悅涅烈熱裂說閱厭廉念捻染殮炎焰琰艶苒"],
      ["e7a1", "簾閻髥鹽曄獵燁葉令囹塋寧嶺嶸影怜映暎楹榮永泳渶潁濚瀛瀯煐營獰玲瑛瑩瓔盈穎纓羚聆英詠迎鈴鍈零霙靈領乂倪例刈叡曳汭濊猊睿穢芮藝蘂禮裔詣譽豫醴銳隸霓預五伍俉傲午吾吳嗚塢墺奧娛寤悟惡懊敖旿晤梧汚澳"],
      ["e8a1", "烏熬獒筽蜈誤鰲鼇屋沃獄玉鈺溫瑥瘟穩縕蘊兀壅擁瓮甕癰翁邕雍饔渦瓦窩窪臥蛙蝸訛婉完宛梡椀浣玩琓琬碗緩翫脘腕莞豌阮頑曰往旺枉汪王倭娃歪矮外嵬巍猥畏了僚僥凹堯夭妖姚寥寮尿嶢拗搖撓擾料曜樂橈燎燿瑤療"],
      ["e9a1", "窈窯繇繞耀腰蓼蟯要謠遙遼邀饒慾欲浴縟褥辱俑傭冗勇埇墉容庸慂榕涌湧溶熔瑢用甬聳茸蓉踊鎔鏞龍于佑偶優又友右宇寓尤愚憂旴牛玗瑀盂祐禑禹紆羽芋藕虞迂遇郵釪隅雨雩勖彧旭昱栯煜稶郁頊云暈橒殞澐熉耘芸蕓"],
      ["eaa1", "運隕雲韻蔚鬱亐熊雄元原員圓園垣媛嫄寃怨愿援沅洹湲源爰猿瑗苑袁轅遠阮院願鴛月越鉞位偉僞危圍委威尉慰暐渭爲瑋緯胃萎葦蔿蝟衛褘謂違韋魏乳侑儒兪劉唯喩孺宥幼幽庾悠惟愈愉揄攸有杻柔柚柳楡楢油洧流游溜"],
      ["eba1", "濡猶猷琉瑜由留癒硫紐維臾萸裕誘諛諭踰蹂遊逾遺酉釉鍮類六堉戮毓肉育陸倫允奫尹崙淪潤玧胤贇輪鈗閏律慄栗率聿戎瀜絨融隆垠恩慇殷誾銀隱乙吟淫蔭陰音飮揖泣邑凝應膺鷹依倚儀宜意懿擬椅毅疑矣義艤薏蟻衣誼"],
      ["eca1", "議醫二以伊利吏夷姨履已弛彛怡易李梨泥爾珥理異痍痢移罹而耳肄苡荑裏裡貽貳邇里離飴餌匿溺瀷益翊翌翼謚人仁刃印吝咽因姻寅引忍湮燐璘絪茵藺蚓認隣靭靷鱗麟一佚佾壹日溢逸鎰馹任壬妊姙恁林淋稔臨荏賃入卄"],
      ["eda1", "立笠粒仍剩孕芿仔刺咨姉姿子字孜恣慈滋炙煮玆瓷疵磁紫者自茨蔗藉諮資雌作勺嚼斫昨灼炸爵綽芍酌雀鵲孱棧殘潺盞岑暫潛箴簪蠶雜丈仗匠場墻壯奬將帳庄張掌暲杖樟檣欌漿牆狀獐璋章粧腸臟臧莊葬蔣薔藏裝贓醬長"],
      ["eea1", "障再哉在宰才材栽梓渽滓災縡裁財載齋齎爭箏諍錚佇低儲咀姐底抵杵楮樗沮渚狙猪疽箸紵苧菹著藷詛貯躇這邸雎齟勣吊嫡寂摘敵滴狄炙的積笛籍績翟荻謫賊赤跡蹟迪迹適鏑佃佺傳全典前剪塡塼奠專展廛悛戰栓殿氈澱"],
      ["efa1", "煎琠田甸畑癲筌箋箭篆纏詮輾轉鈿銓錢鐫電顚顫餞切截折浙癤竊節絶占岾店漸点粘霑鮎點接摺蝶丁井亭停偵呈姃定幀庭廷征情挺政整旌晶晸柾楨檉正汀淀淨渟湞瀞炡玎珽町睛碇禎程穽精綎艇訂諪貞鄭酊釘鉦鋌錠霆靖"],
      ["f0a1", "靜頂鼎制劑啼堤帝弟悌提梯濟祭第臍薺製諸蹄醍除際霽題齊俎兆凋助嘲弔彫措操早晁曺曹朝條棗槽漕潮照燥爪璪眺祖祚租稠窕粗糟組繰肇藻蚤詔調趙躁造遭釣阻雕鳥族簇足鏃存尊卒拙猝倧宗從悰慫棕淙琮種終綜縱腫"],
      ["f1a1", "踪踵鍾鐘佐坐左座挫罪主住侏做姝胄呪周嗾奏宙州廚晝朱柱株注洲湊澍炷珠疇籌紂紬綢舟蛛註誅走躊輳週酎酒鑄駐竹粥俊儁准埈寯峻晙樽浚準濬焌畯竣蠢逡遵雋駿茁中仲衆重卽櫛楫汁葺增憎曾拯烝甑症繒蒸證贈之只"],
      ["f2a1", "咫地址志持指摯支旨智枝枳止池沚漬知砥祉祗紙肢脂至芝芷蜘誌識贄趾遲直稙稷織職唇嗔塵振搢晉晋桭榛殄津溱珍瑨璡畛疹盡眞瞋秦縉縝臻蔯袗診賑軫辰進鎭陣陳震侄叱姪嫉帙桎瓆疾秩窒膣蛭質跌迭斟朕什執潗緝輯"],
      ["f3a1", "鏶集徵懲澄且侘借叉嗟嵯差次此磋箚茶蹉車遮捉搾着窄錯鑿齪撰澯燦璨瓚竄簒纂粲纘讚贊鑽餐饌刹察擦札紮僭參塹慘慙懺斬站讒讖倉倡創唱娼廠彰愴敞昌昶暢槍滄漲猖瘡窓脹艙菖蒼債埰寀寨彩採砦綵菜蔡采釵冊柵策"],
      ["f4a1", "責凄妻悽處倜刺剔尺慽戚拓擲斥滌瘠脊蹠陟隻仟千喘天川擅泉淺玔穿舛薦賤踐遷釧闡阡韆凸哲喆徹撤澈綴輟轍鐵僉尖沾添甛瞻簽籤詹諂堞妾帖捷牒疊睫諜貼輒廳晴淸聽菁請靑鯖切剃替涕滯締諦逮遞體初剿哨憔抄招梢"],
      ["f5a1", "椒楚樵炒焦硝礁礎秒稍肖艸苕草蕉貂超酢醋醮促囑燭矗蜀觸寸忖村邨叢塚寵悤憁摠總聰蔥銃撮催崔最墜抽推椎楸樞湫皺秋芻萩諏趨追鄒酋醜錐錘鎚雛騶鰍丑畜祝竺筑築縮蓄蹙蹴軸逐春椿瑃出朮黜充忠沖蟲衝衷悴膵萃"],
      ["f6a1", "贅取吹嘴娶就炊翠聚脆臭趣醉驟鷲側仄厠惻測層侈値嗤峙幟恥梔治淄熾痔痴癡稚穉緇緻置致蚩輜雉馳齒則勅飭親七柒漆侵寢枕沈浸琛砧針鍼蟄秤稱快他咤唾墮妥惰打拖朶楕舵陀馱駝倬卓啄坼度托拓擢晫柝濁濯琢琸託"],
      ["f7a1", "鐸呑嘆坦彈憚歎灘炭綻誕奪脫探眈耽貪塔搭榻宕帑湯糖蕩兌台太怠態殆汰泰笞胎苔跆邰颱宅擇澤撑攄兎吐土討慟桶洞痛筒統通堆槌腿褪退頹偸套妬投透鬪慝特闖坡婆巴把播擺杷波派爬琶破罷芭跛頗判坂板版瓣販辦鈑"],
      ["f8a1", "阪八叭捌佩唄悖敗沛浿牌狽稗覇貝彭澎烹膨愎便偏扁片篇編翩遍鞭騙貶坪平枰萍評吠嬖幣廢弊斃肺蔽閉陛佈包匍匏咆哺圃布怖抛抱捕暴泡浦疱砲胞脯苞葡蒲袍褒逋鋪飽鮑幅暴曝瀑爆輻俵剽彪慓杓標漂瓢票表豹飇飄驃"],
      ["f9a1", "品稟楓諷豊風馮彼披疲皮被避陂匹弼必泌珌畢疋筆苾馝乏逼下何厦夏廈昰河瑕荷蝦賀遐霞鰕壑學虐謔鶴寒恨悍旱汗漢澣瀚罕翰閑閒限韓割轄函含咸啣喊檻涵緘艦銜陷鹹合哈盒蛤閤闔陜亢伉姮嫦巷恒抗杭桁沆港缸肛航"],
      ["faa1", "行降項亥偕咳垓奚孩害懈楷海瀣蟹解該諧邂駭骸劾核倖幸杏荇行享向嚮珦鄕響餉饗香噓墟虛許憲櫶獻軒歇險驗奕爀赫革俔峴弦懸晛泫炫玄玹現眩睍絃絢縣舷衒見賢鉉顯孑穴血頁嫌俠協夾峽挾浹狹脅脇莢鋏頰亨兄刑型"],
      ["fba1", "形泂滎瀅灐炯熒珩瑩荊螢衡逈邢鎣馨兮彗惠慧暳蕙蹊醯鞋乎互呼壕壺好岵弧戶扈昊晧毫浩淏湖滸澔濠濩灝狐琥瑚瓠皓祜糊縞胡芦葫蒿虎號蝴護豪鎬頀顥惑或酷婚昏混渾琿魂忽惚笏哄弘汞泓洪烘紅虹訌鴻化和嬅樺火畵"],
      ["fca1", "禍禾花華話譁貨靴廓擴攫確碻穫丸喚奐宦幻患換歡晥桓渙煥環紈還驩鰥活滑猾豁闊凰幌徨恍惶愰慌晃晄榥況湟滉潢煌璜皇篁簧荒蝗遑隍黃匯回廻徊恢悔懷晦會檜淮澮灰獪繪膾茴蛔誨賄劃獲宖橫鐄哮嚆孝效斅曉梟涍淆"],
      ["fda1", "爻肴酵驍侯候厚后吼喉嗅帿後朽煦珝逅勛勳塤壎焄熏燻薰訓暈薨喧暄煊萱卉喙毁彙徽揮暉煇諱輝麾休携烋畦虧恤譎鷸兇凶匈洶胸黑昕欣炘痕吃屹紇訖欠欽歆吸恰洽翕興僖凞喜噫囍姬嬉希憙憘戱晞曦熙熹熺犧禧稀羲詰"]
    ];
  }
});

// node_modules/iconv-lite/encodings/tables/cp950.json
var require_cp950 = __commonJS({
  "node_modules/iconv-lite/encodings/tables/cp950.json"(exports2, module2) {
    module2.exports = [
      ["0", "\0", 127],
      ["a140", "　，、。．‧；：？！︰…‥﹐﹑﹒·﹔﹕﹖﹗｜–︱—︳╴︴﹏（）︵︶｛｝︷︸〔〕︹︺【】︻︼《》︽︾〈〉︿﹀「」﹁﹂『』﹃﹄﹙﹚"],
      ["a1a1", "﹛﹜﹝﹞‘’“”〝〞‵′＃＆＊※§〃○●△▲◎☆★◇◆□■▽▼㊣℅¯￣＿ˍ﹉﹊﹍﹎﹋﹌﹟﹠﹡＋－×÷±√＜＞＝≦≧≠∞≒≡﹢", 4, "～∩∪⊥∠∟⊿㏒㏑∫∮∵∴♀♂⊕⊙↑↓←→↖↗↙↘∥∣／"],
      ["a240", "＼∕﹨＄￥〒￠￡％＠℃℉﹩﹪﹫㏕㎜㎝㎞㏎㎡㎎㎏㏄°兙兛兞兝兡兣嗧瓩糎▁", 7, "▏▎▍▌▋▊▉┼┴┬┤├▔─│▕┌┐└┘╭"],
      ["a2a1", "╮╰╯═╞╪╡◢◣◥◤╱╲╳０", 9, "Ⅰ", 9, "〡", 8, "十卄卅Ａ", 25, "ａ", 21],
      ["a340", "ｗｘｙｚΑ", 16, "Σ", 6, "α", 16, "σ", 6, "ㄅ", 10],
      ["a3a1", "ㄐ", 25, "˙ˉˊˇˋ"],
      ["a3e1", "€"],
      ["a440", "一乙丁七乃九了二人儿入八几刀刁力匕十卜又三下丈上丫丸凡久么也乞于亡兀刃勺千叉口土士夕大女子孑孓寸小尢尸山川工己已巳巾干廾弋弓才"],
      ["a4a1", "丑丐不中丰丹之尹予云井互五亢仁什仃仆仇仍今介仄元允內六兮公冗凶分切刈勻勾勿化匹午升卅卞厄友及反壬天夫太夭孔少尤尺屯巴幻廿弔引心戈戶手扎支文斗斤方日曰月木欠止歹毋比毛氏水火爪父爻片牙牛犬王丙"],
      ["a540", "世丕且丘主乍乏乎以付仔仕他仗代令仙仞充兄冉冊冬凹出凸刊加功包匆北匝仟半卉卡占卯卮去可古右召叮叩叨叼司叵叫另只史叱台句叭叻四囚外"],
      ["a5a1", "央失奴奶孕它尼巨巧左市布平幼弁弘弗必戊打扔扒扑斥旦朮本未末札正母民氐永汁汀氾犯玄玉瓜瓦甘生用甩田由甲申疋白皮皿目矛矢石示禾穴立丞丟乒乓乩亙交亦亥仿伉伙伊伕伍伐休伏仲件任仰仳份企伋光兇兆先全"],
      ["a640", "共再冰列刑划刎刖劣匈匡匠印危吉吏同吊吐吁吋各向名合吃后吆吒因回囝圳地在圭圬圯圩夙多夷夸妄奸妃好她如妁字存宇守宅安寺尖屹州帆并年"],
      ["a6a1", "式弛忙忖戎戌戍成扣扛托收早旨旬旭曲曳有朽朴朱朵次此死氖汝汗汙江池汐汕污汛汍汎灰牟牝百竹米糸缶羊羽老考而耒耳聿肉肋肌臣自至臼舌舛舟艮色艾虫血行衣西阡串亨位住佇佗佞伴佛何估佐佑伽伺伸佃佔似但佣"],
      ["a740", "作你伯低伶余佝佈佚兌克免兵冶冷別判利刪刨劫助努劬匣即卵吝吭吞吾否呎吧呆呃吳呈呂君吩告吹吻吸吮吵吶吠吼呀吱含吟听囪困囤囫坊坑址坍"],
      ["a7a1", "均坎圾坐坏圻壯夾妝妒妨妞妣妙妖妍妤妓妊妥孝孜孚孛完宋宏尬局屁尿尾岐岑岔岌巫希序庇床廷弄弟彤形彷役忘忌志忍忱快忸忪戒我抄抗抖技扶抉扭把扼找批扳抒扯折扮投抓抑抆改攻攸旱更束李杏材村杜杖杞杉杆杠"],
      ["a840", "杓杗步每求汞沙沁沈沉沅沛汪決沐汰沌汨沖沒汽沃汲汾汴沆汶沍沔沘沂灶灼災灸牢牡牠狄狂玖甬甫男甸皂盯矣私秀禿究系罕肖肓肝肘肛肚育良芒"],
      ["a8a1", "芋芍見角言谷豆豕貝赤走足身車辛辰迂迆迅迄巡邑邢邪邦那酉釆里防阮阱阪阬並乖乳事些亞享京佯依侍佳使佬供例來侃佰併侈佩佻侖佾侏侑佺兔兒兕兩具其典冽函刻券刷刺到刮制剁劾劻卒協卓卑卦卷卸卹取叔受味呵"],
      ["a940", "咖呸咕咀呻呷咄咒咆呼咐呱呶和咚呢周咋命咎固垃坷坪坩坡坦坤坼夜奉奇奈奄奔妾妻委妹妮姑姆姐姍始姓姊妯妳姒姅孟孤季宗定官宜宙宛尚屈居"],
      ["a9a1", "屆岷岡岸岩岫岱岳帘帚帖帕帛帑幸庚店府底庖延弦弧弩往征彿彼忝忠忽念忿怏怔怯怵怖怪怕怡性怩怫怛或戕房戾所承拉拌拄抿拂抹拒招披拓拔拋拈抨抽押拐拙拇拍抵拚抱拘拖拗拆抬拎放斧於旺昔易昌昆昂明昀昏昕昊"],
      ["aa40", "昇服朋杭枋枕東果杳杷枇枝林杯杰板枉松析杵枚枓杼杪杲欣武歧歿氓氛泣注泳沱泌泥河沽沾沼波沫法泓沸泄油況沮泗泅泱沿治泡泛泊沬泯泜泖泠"],
      ["aaa1", "炕炎炒炊炙爬爭爸版牧物狀狎狙狗狐玩玨玟玫玥甽疝疙疚的盂盲直知矽社祀祁秉秈空穹竺糾罔羌羋者肺肥肢肱股肫肩肴肪肯臥臾舍芳芝芙芭芽芟芹花芬芥芯芸芣芰芾芷虎虱初表軋迎返近邵邸邱邶采金長門阜陀阿阻附"],
      ["ab40", "陂隹雨青非亟亭亮信侵侯便俠俑俏保促侶俘俟俊俗侮俐俄係俚俎俞侷兗冒冑冠剎剃削前剌剋則勇勉勃勁匍南卻厚叛咬哀咨哎哉咸咦咳哇哂咽咪品"],
      ["aba1", "哄哈咯咫咱咻咩咧咿囿垂型垠垣垢城垮垓奕契奏奎奐姜姘姿姣姨娃姥姪姚姦威姻孩宣宦室客宥封屎屏屍屋峙峒巷帝帥帟幽庠度建弈弭彥很待徊律徇後徉怒思怠急怎怨恍恰恨恢恆恃恬恫恪恤扁拜挖按拼拭持拮拽指拱拷"],
      ["ac40", "拯括拾拴挑挂政故斫施既春昭映昧是星昨昱昤曷柿染柱柔某柬架枯柵柩柯柄柑枴柚查枸柏柞柳枰柙柢柝柒歪殃殆段毒毗氟泉洋洲洪流津洌洱洞洗"],
      ["aca1", "活洽派洶洛泵洹洧洸洩洮洵洎洫炫為炳炬炯炭炸炮炤爰牲牯牴狩狠狡玷珊玻玲珍珀玳甚甭畏界畎畋疫疤疥疢疣癸皆皇皈盈盆盃盅省盹相眉看盾盼眇矜砂研砌砍祆祉祈祇禹禺科秒秋穿突竿竽籽紂紅紀紉紇約紆缸美羿耄"],
      ["ad40", "耐耍耑耶胖胥胚胃胄背胡胛胎胞胤胝致舢苧范茅苣苛苦茄若茂茉苒苗英茁苜苔苑苞苓苟苯茆虐虹虻虺衍衫要觔計訂訃貞負赴赳趴軍軌述迦迢迪迥"],
      ["ada1", "迭迫迤迨郊郎郁郃酋酊重閂限陋陌降面革韋韭音頁風飛食首香乘亳倌倍倣俯倦倥俸倩倖倆值借倚倒們俺倀倔倨俱倡個候倘俳修倭倪俾倫倉兼冤冥冢凍凌准凋剖剜剔剛剝匪卿原厝叟哨唐唁唷哼哥哲唆哺唔哩哭員唉哮哪"],
      ["ae40", "哦唧唇哽唏圃圄埂埔埋埃堉夏套奘奚娑娘娜娟娛娓姬娠娣娩娥娌娉孫屘宰害家宴宮宵容宸射屑展屐峭峽峻峪峨峰島崁峴差席師庫庭座弱徒徑徐恙"],
      ["aea1", "恣恥恐恕恭恩息悄悟悚悍悔悌悅悖扇拳挈拿捎挾振捕捂捆捏捉挺捐挽挪挫挨捍捌效敉料旁旅時晉晏晃晒晌晅晁書朔朕朗校核案框桓根桂桔栩梳栗桌桑栽柴桐桀格桃株桅栓栘桁殊殉殷氣氧氨氦氤泰浪涕消涇浦浸海浙涓"],
      ["af40", "浬涉浮浚浴浩涌涊浹涅浥涔烊烘烤烙烈烏爹特狼狹狽狸狷玆班琉珮珠珪珞畔畝畜畚留疾病症疲疳疽疼疹痂疸皋皰益盍盎眩真眠眨矩砰砧砸砝破砷"],
      ["afa1", "砥砭砠砟砲祕祐祠祟祖神祝祗祚秤秣秧租秦秩秘窄窈站笆笑粉紡紗紋紊素索純紐紕級紜納紙紛缺罟羔翅翁耆耘耕耙耗耽耿胱脂胰脅胭胴脆胸胳脈能脊胼胯臭臬舀舐航舫舨般芻茫荒荔荊茸荐草茵茴荏茲茹茶茗荀茱茨荃"],
      ["b040", "虔蚊蚪蚓蚤蚩蚌蚣蚜衰衷袁袂衽衹記訐討訌訕訊託訓訖訏訑豈豺豹財貢起躬軒軔軏辱送逆迷退迺迴逃追逅迸邕郡郝郢酒配酌釘針釗釜釙閃院陣陡"],
      ["b0a1", "陛陝除陘陞隻飢馬骨高鬥鬲鬼乾偺偽停假偃偌做偉健偶偎偕偵側偷偏倏偯偭兜冕凰剪副勒務勘動匐匏匙匿區匾參曼商啪啦啄啞啡啃啊唱啖問啕唯啤唸售啜唬啣唳啁啗圈國圉域堅堊堆埠埤基堂堵執培夠奢娶婁婉婦婪婀"],
      ["b140", "娼婢婚婆婊孰寇寅寄寂宿密尉專將屠屜屝崇崆崎崛崖崢崑崩崔崙崤崧崗巢常帶帳帷康庸庶庵庾張強彗彬彩彫得徙從徘御徠徜恿患悉悠您惋悴惦悽"],
      ["b1a1", "情悻悵惜悼惘惕惆惟悸惚惇戚戛扈掠控捲掖探接捷捧掘措捱掩掉掃掛捫推掄授掙採掬排掏掀捻捩捨捺敝敖救教敗啟敏敘敕敔斜斛斬族旋旌旎晝晚晤晨晦晞曹勗望梁梯梢梓梵桿桶梱梧梗械梃棄梭梆梅梔條梨梟梡梂欲殺"],
      ["b240", "毫毬氫涎涼淳淙液淡淌淤添淺清淇淋涯淑涮淞淹涸混淵淅淒渚涵淚淫淘淪深淮淨淆淄涪淬涿淦烹焉焊烽烯爽牽犁猜猛猖猓猙率琅琊球理現琍瓠瓶"],
      ["b2a1", "瓷甜產略畦畢異疏痔痕疵痊痍皎盔盒盛眷眾眼眶眸眺硫硃硎祥票祭移窒窕笠笨笛第符笙笞笮粒粗粕絆絃統紮紹紼絀細紳組累終紲紱缽羞羚翌翎習耜聊聆脯脖脣脫脩脰脤舂舵舷舶船莎莞莘荸莢莖莽莫莒莊莓莉莠荷荻荼"],
      ["b340", "莆莧處彪蛇蛀蚶蛄蚵蛆蛋蚱蚯蛉術袞袈被袒袖袍袋覓規訪訝訣訥許設訟訛訢豉豚販責貫貨貪貧赧赦趾趺軛軟這逍通逗連速逝逐逕逞造透逢逖逛途"],
      ["b3a1", "部郭都酗野釵釦釣釧釭釩閉陪陵陳陸陰陴陶陷陬雀雪雩章竟頂頃魚鳥鹵鹿麥麻傢傍傅備傑傀傖傘傚最凱割剴創剩勞勝勛博厥啻喀喧啼喊喝喘喂喜喪喔喇喋喃喳單喟唾喲喚喻喬喱啾喉喫喙圍堯堪場堤堰報堡堝堠壹壺奠"],
      ["b440", "婷媚婿媒媛媧孳孱寒富寓寐尊尋就嵌嵐崴嵇巽幅帽幀幃幾廊廁廂廄弼彭復循徨惑惡悲悶惠愜愣惺愕惰惻惴慨惱愎惶愉愀愒戟扉掣掌描揀揩揉揆揍"],
      ["b4a1", "插揣提握揖揭揮捶援揪換摒揚揹敞敦敢散斑斐斯普晰晴晶景暑智晾晷曾替期朝棺棕棠棘棗椅棟棵森棧棹棒棲棣棋棍植椒椎棉棚楮棻款欺欽殘殖殼毯氮氯氬港游湔渡渲湧湊渠渥渣減湛湘渤湖湮渭渦湯渴湍渺測湃渝渾滋"],
      ["b540", "溉渙湎湣湄湲湩湟焙焚焦焰無然煮焜牌犄犀猶猥猴猩琺琪琳琢琥琵琶琴琯琛琦琨甥甦畫番痢痛痣痙痘痞痠登發皖皓皴盜睏短硝硬硯稍稈程稅稀窘"],
      ["b5a1", "窗窖童竣等策筆筐筒答筍筋筏筑粟粥絞結絨絕紫絮絲絡給絢絰絳善翔翕耋聒肅腕腔腋腑腎脹腆脾腌腓腴舒舜菩萃菸萍菠菅萋菁華菱菴著萊菰萌菌菽菲菊萸萎萄菜萇菔菟虛蛟蛙蛭蛔蛛蛤蛐蛞街裁裂袱覃視註詠評詞証詁"],
      ["b640", "詔詛詐詆訴診訶詖象貂貯貼貳貽賁費賀貴買貶貿貸越超趁跎距跋跚跑跌跛跆軻軸軼辜逮逵週逸進逶鄂郵鄉郾酣酥量鈔鈕鈣鈉鈞鈍鈐鈇鈑閔閏開閑"],
      ["b6a1", "間閒閎隊階隋陽隅隆隍陲隄雁雅雄集雇雯雲韌項順須飧飪飯飩飲飭馮馭黃黍黑亂傭債傲傳僅傾催傷傻傯僇剿剷剽募勦勤勢勣匯嗟嗨嗓嗦嗎嗜嗇嗑嗣嗤嗯嗚嗡嗅嗆嗥嗉園圓塞塑塘塗塚塔填塌塭塊塢塒塋奧嫁嫉嫌媾媽媼"],
      ["b740", "媳嫂媲嵩嵯幌幹廉廈弒彙徬微愚意慈感想愛惹愁愈慎慌慄慍愾愴愧愍愆愷戡戢搓搾搞搪搭搽搬搏搜搔損搶搖搗搆敬斟新暗暉暇暈暖暄暘暍會榔業"],
      ["b7a1", "楚楷楠楔極椰概楊楨楫楞楓楹榆楝楣楛歇歲毀殿毓毽溢溯滓溶滂源溝滇滅溥溘溼溺溫滑準溜滄滔溪溧溴煎煙煩煤煉照煜煬煦煌煥煞煆煨煖爺牒猷獅猿猾瑯瑚瑕瑟瑞瑁琿瑙瑛瑜當畸瘀痰瘁痲痱痺痿痴痳盞盟睛睫睦睞督"],
      ["b840", "睹睪睬睜睥睨睢矮碎碰碗碘碌碉硼碑碓硿祺祿禁萬禽稜稚稠稔稟稞窟窠筷節筠筮筧粱粳粵經絹綑綁綏絛置罩罪署義羨群聖聘肆肄腱腰腸腥腮腳腫"],
      ["b8a1", "腹腺腦舅艇蒂葷落萱葵葦葫葉葬葛萼萵葡董葩葭葆虞虜號蛹蜓蜈蜇蜀蛾蛻蜂蜃蜆蜊衙裟裔裙補裘裝裡裊裕裒覜解詫該詳試詩詰誇詼詣誠話誅詭詢詮詬詹詻訾詨豢貊貉賊資賈賄貲賃賂賅跡跟跨路跳跺跪跤跦躲較載軾輊"],
      ["b940", "辟農運遊道遂達逼違遐遇遏過遍遑逾遁鄒鄗酬酪酩釉鈷鉗鈸鈽鉀鈾鉛鉋鉤鉑鈴鉉鉍鉅鈹鈿鉚閘隘隔隕雍雋雉雊雷電雹零靖靴靶預頑頓頊頒頌飼飴"],
      ["b9a1", "飽飾馳馱馴髡鳩麂鼎鼓鼠僧僮僥僖僭僚僕像僑僱僎僩兢凳劃劂匱厭嗾嘀嘛嘗嗽嘔嘆嘉嘍嘎嗷嘖嘟嘈嘐嗶團圖塵塾境墓墊塹墅塽壽夥夢夤奪奩嫡嫦嫩嫗嫖嫘嫣孵寞寧寡寥實寨寢寤察對屢嶄嶇幛幣幕幗幔廓廖弊彆彰徹慇"],
      ["ba40", "愿態慷慢慣慟慚慘慵截撇摘摔撤摸摟摺摑摧搴摭摻敲斡旗旖暢暨暝榜榨榕槁榮槓構榛榷榻榫榴槐槍榭槌榦槃榣歉歌氳漳演滾漓滴漩漾漠漬漏漂漢"],
      ["baa1", "滿滯漆漱漸漲漣漕漫漯澈漪滬漁滲滌滷熔熙煽熊熄熒爾犒犖獄獐瑤瑣瑪瑰瑭甄疑瘧瘍瘋瘉瘓盡監瞄睽睿睡磁碟碧碳碩碣禎福禍種稱窪窩竭端管箕箋筵算箝箔箏箸箇箄粹粽精綻綰綜綽綾綠緊綴網綱綺綢綿綵綸維緒緇綬"],
      ["bb40", "罰翠翡翟聞聚肇腐膀膏膈膊腿膂臧臺與舔舞艋蓉蒿蓆蓄蒙蒞蒲蒜蓋蒸蓀蓓蒐蒼蓑蓊蜿蜜蜻蜢蜥蜴蜘蝕蜷蜩裳褂裴裹裸製裨褚裯誦誌語誣認誡誓誤"],
      ["bba1", "說誥誨誘誑誚誧豪貍貌賓賑賒赫趙趕跼輔輒輕輓辣遠遘遜遣遙遞遢遝遛鄙鄘鄞酵酸酷酴鉸銀銅銘銖鉻銓銜銨鉼銑閡閨閩閣閥閤隙障際雌雒需靼鞅韶頗領颯颱餃餅餌餉駁骯骰髦魁魂鳴鳶鳳麼鼻齊億儀僻僵價儂儈儉儅凜"],
      ["bc40", "劇劈劉劍劊勰厲嘮嘻嘹嘲嘿嘴嘩噓噎噗噴嘶嘯嘰墀墟增墳墜墮墩墦奭嬉嫻嬋嫵嬌嬈寮寬審寫層履嶝嶔幢幟幡廢廚廟廝廣廠彈影德徵慶慧慮慝慕憂"],
      ["bca1", "慼慰慫慾憧憐憫憎憬憚憤憔憮戮摩摯摹撞撲撈撐撰撥撓撕撩撒撮播撫撚撬撙撢撳敵敷數暮暫暴暱樣樟槨樁樞標槽模樓樊槳樂樅槭樑歐歎殤毅毆漿潼澄潑潦潔澆潭潛潸潮澎潺潰潤澗潘滕潯潠潟熟熬熱熨牖犛獎獗瑩璋璃"],
      ["bd40", "瑾璀畿瘠瘩瘟瘤瘦瘡瘢皚皺盤瞎瞇瞌瞑瞋磋磅確磊碾磕碼磐稿稼穀稽稷稻窯窮箭箱範箴篆篇篁箠篌糊締練緯緻緘緬緝編緣線緞緩綞緙緲緹罵罷羯"],
      ["bda1", "翩耦膛膜膝膠膚膘蔗蔽蔚蓮蔬蔭蔓蔑蔣蔡蔔蓬蔥蓿蔆螂蝴蝶蝠蝦蝸蝨蝙蝗蝌蝓衛衝褐複褒褓褕褊誼諒談諄誕請諸課諉諂調誰論諍誶誹諛豌豎豬賠賞賦賤賬賭賢賣賜質賡赭趟趣踫踐踝踢踏踩踟踡踞躺輝輛輟輩輦輪輜輞"],
      ["be40", "輥適遮遨遭遷鄰鄭鄧鄱醇醉醋醃鋅銻銷鋪銬鋤鋁銳銼鋒鋇鋰銲閭閱霄霆震霉靠鞍鞋鞏頡頫頜颳養餓餒餘駝駐駟駛駑駕駒駙骷髮髯鬧魅魄魷魯鴆鴉"],
      ["bea1", "鴃麩麾黎墨齒儒儘儔儐儕冀冪凝劑劓勳噙噫噹噩噤噸噪器噥噱噯噬噢噶壁墾壇壅奮嬝嬴學寰導彊憲憑憩憊懍憶憾懊懈戰擅擁擋撻撼據擄擇擂操撿擒擔撾整曆曉暹曄曇暸樽樸樺橙橫橘樹橄橢橡橋橇樵機橈歙歷氅濂澱澡"],
      ["bf40", "濃澤濁澧澳激澹澶澦澠澴熾燉燐燒燈燕熹燎燙燜燃燄獨璜璣璘璟璞瓢甌甍瘴瘸瘺盧盥瞠瞞瞟瞥磨磚磬磧禦積穎穆穌穋窺篙簑築篤篛篡篩篦糕糖縊"],
      ["bfa1", "縑縈縛縣縞縝縉縐罹羲翰翱翮耨膳膩膨臻興艘艙蕊蕙蕈蕨蕩蕃蕉蕭蕪蕞螃螟螞螢融衡褪褲褥褫褡親覦諦諺諫諱謀諜諧諮諾謁謂諷諭諳諶諼豫豭貓賴蹄踱踴蹂踹踵輻輯輸輳辨辦遵遴選遲遼遺鄴醒錠錶鋸錳錯錢鋼錫錄錚"],
      ["c040", "錐錦錡錕錮錙閻隧隨險雕霎霑霖霍霓霏靛靜靦鞘頰頸頻頷頭頹頤餐館餞餛餡餚駭駢駱骸骼髻髭鬨鮑鴕鴣鴦鴨鴒鴛默黔龍龜優償儡儲勵嚎嚀嚐嚅嚇"],
      ["c0a1", "嚏壕壓壑壎嬰嬪嬤孺尷屨嶼嶺嶽嶸幫彌徽應懂懇懦懋戲戴擎擊擘擠擰擦擬擱擢擭斂斃曙曖檀檔檄檢檜櫛檣橾檗檐檠歜殮毚氈濘濱濟濠濛濤濫濯澀濬濡濩濕濮濰燧營燮燦燥燭燬燴燠爵牆獰獲璩環璦璨癆療癌盪瞳瞪瞰瞬"],
      ["c140", "瞧瞭矯磷磺磴磯礁禧禪穗窿簇簍篾篷簌篠糠糜糞糢糟糙糝縮績繆縷縲繃縫總縱繅繁縴縹繈縵縿縯罄翳翼聱聲聰聯聳臆臃膺臂臀膿膽臉膾臨舉艱薪"],
      ["c1a1", "薄蕾薜薑薔薯薛薇薨薊虧蟀蟑螳蟒蟆螫螻螺蟈蟋褻褶襄褸褽覬謎謗謙講謊謠謝謄謐豁谿豳賺賽購賸賻趨蹉蹋蹈蹊轄輾轂轅輿避遽還邁邂邀鄹醣醞醜鍍鎂錨鍵鍊鍥鍋錘鍾鍬鍛鍰鍚鍔闊闋闌闈闆隱隸雖霜霞鞠韓顆颶餵騁"],
      ["c240", "駿鮮鮫鮪鮭鴻鴿麋黏點黜黝黛鼾齋叢嚕嚮壙壘嬸彝懣戳擴擲擾攆擺擻擷斷曜朦檳檬櫃檻檸櫂檮檯歟歸殯瀉瀋濾瀆濺瀑瀏燻燼燾燸獷獵璧璿甕癖癘"],
      ["c2a1", "癒瞽瞿瞻瞼礎禮穡穢穠竄竅簫簧簪簞簣簡糧織繕繞繚繡繒繙罈翹翻職聶臍臏舊藏薩藍藐藉薰薺薹薦蟯蟬蟲蟠覆覲觴謨謹謬謫豐贅蹙蹣蹦蹤蹟蹕軀轉轍邇邃邈醫醬釐鎔鎊鎖鎢鎳鎮鎬鎰鎘鎚鎗闔闖闐闕離雜雙雛雞霤鞣鞦"],
      ["c340", "鞭韹額顏題顎顓颺餾餿餽餮馥騎髁鬃鬆魏魎魍鯊鯉鯽鯈鯀鵑鵝鵠黠鼕鼬儳嚥壞壟壢寵龐廬懲懷懶懵攀攏曠曝櫥櫝櫚櫓瀛瀟瀨瀚瀝瀕瀘爆爍牘犢獸"],
      ["c3a1", "獺璽瓊瓣疇疆癟癡矇礙禱穫穩簾簿簸簽簷籀繫繭繹繩繪羅繳羶羹羸臘藩藝藪藕藤藥藷蟻蠅蠍蟹蟾襠襟襖襞譁譜識證譚譎譏譆譙贈贊蹼蹲躇蹶蹬蹺蹴轔轎辭邊邋醱醮鏡鏑鏟鏃鏈鏜鏝鏖鏢鏍鏘鏤鏗鏨關隴難霪霧靡韜韻類"],
      ["c440", "願顛颼饅饉騖騙鬍鯨鯧鯖鯛鶉鵡鵲鵪鵬麒麗麓麴勸嚨嚷嚶嚴嚼壤孀孃孽寶巉懸懺攘攔攙曦朧櫬瀾瀰瀲爐獻瓏癢癥礦礪礬礫竇競籌籃籍糯糰辮繽繼"],
      ["c4a1", "纂罌耀臚艦藻藹蘑藺蘆蘋蘇蘊蠔蠕襤覺觸議譬警譯譟譫贏贍躉躁躅躂醴釋鐘鐃鏽闡霰飄饒饑馨騫騰騷騵鰓鰍鹹麵黨鼯齟齣齡儷儸囁囀囂夔屬巍懼懾攝攜斕曩櫻欄櫺殲灌爛犧瓖瓔癩矓籐纏續羼蘗蘭蘚蠣蠢蠡蠟襪襬覽譴"],
      ["c540", "護譽贓躊躍躋轟辯醺鐮鐳鐵鐺鐸鐲鐫闢霸霹露響顧顥饗驅驃驀騾髏魔魑鰭鰥鶯鶴鷂鶸麝黯鼙齜齦齧儼儻囈囊囉孿巔巒彎懿攤權歡灑灘玀瓤疊癮癬"],
      ["c5a1", "禳籠籟聾聽臟襲襯觼讀贖贗躑躓轡酈鑄鑑鑒霽霾韃韁顫饕驕驍髒鬚鱉鰱鰾鰻鷓鷗鼴齬齪龔囌巖戀攣攫攪曬欐瓚竊籤籣籥纓纖纔臢蘸蘿蠱變邐邏鑣鑠鑤靨顯饜驚驛驗髓體髑鱔鱗鱖鷥麟黴囑壩攬灞癱癲矗罐羈蠶蠹衢讓讒"],
      ["c640", "讖艷贛釀鑪靂靈靄韆顰驟鬢魘鱟鷹鷺鹼鹽鼇齷齲廳欖灣籬籮蠻觀躡釁鑲鑰顱饞髖鬣黌灤矚讚鑷韉驢驥纜讜躪釅鑽鑾鑼鱷鱸黷豔鑿鸚爨驪鬱鸛鸞籲"],
      ["c940", "乂乜凵匚厂万丌乇亍囗兀屮彳丏冇与丮亓仂仉仈冘勼卬厹圠夃夬尐巿旡殳毌气爿丱丼仨仜仩仡仝仚刌匜卌圢圣夗夯宁宄尒尻屴屳帄庀庂忉戉扐氕"],
      ["c9a1", "氶汃氿氻犮犰玊禸肊阞伎优伬仵伔仱伀价伈伝伂伅伢伓伄仴伒冱刓刉刐劦匢匟卍厊吇囡囟圮圪圴夼妀奼妅奻奾奷奿孖尕尥屼屺屻屾巟幵庄异弚彴忕忔忏扜扞扤扡扦扢扙扠扚扥旯旮朾朹朸朻机朿朼朳氘汆汒汜汏汊汔汋"],
      ["ca40", "汌灱牞犴犵玎甪癿穵网艸艼芀艽艿虍襾邙邗邘邛邔阢阤阠阣佖伻佢佉体佤伾佧佒佟佁佘伭伳伿佡冏冹刜刞刡劭劮匉卣卲厎厏吰吷吪呔呅吙吜吥吘"],
      ["caa1", "吽呏呁吨吤呇囮囧囥坁坅坌坉坋坒夆奀妦妘妠妗妎妢妐妏妧妡宎宒尨尪岍岏岈岋岉岒岊岆岓岕巠帊帎庋庉庌庈庍弅弝彸彶忒忑忐忭忨忮忳忡忤忣忺忯忷忻怀忴戺抃抌抎抏抔抇扱扻扺扰抁抈扷扽扲扴攷旰旴旳旲旵杅杇"],
      ["cb40", "杙杕杌杈杝杍杚杋毐氙氚汸汧汫沄沋沏汱汯汩沚汭沇沕沜汦汳汥汻沎灴灺牣犿犽狃狆狁犺狅玕玗玓玔玒町甹疔疕皁礽耴肕肙肐肒肜芐芏芅芎芑芓"],
      ["cba1", "芊芃芄豸迉辿邟邡邥邞邧邠阰阨阯阭丳侘佼侅佽侀侇佶佴侉侄佷佌侗佪侚佹侁佸侐侜侔侞侒侂侕佫佮冞冼冾刵刲刳剆刱劼匊匋匼厒厔咇呿咁咑咂咈呫呺呾呥呬呴呦咍呯呡呠咘呣呧呤囷囹坯坲坭坫坱坰坶垀坵坻坳坴坢"],
      ["cc40", "坨坽夌奅妵妺姏姎妲姌姁妶妼姃姖妱妽姀姈妴姇孢孥宓宕屄屇岮岤岠岵岯岨岬岟岣岭岢岪岧岝岥岶岰岦帗帔帙弨弢弣弤彔徂彾彽忞忥怭怦怙怲怋"],
      ["cca1", "怴怊怗怳怚怞怬怢怍怐怮怓怑怌怉怜戔戽抭抴拑抾抪抶拊抮抳抯抻抩抰抸攽斨斻昉旼昄昒昈旻昃昋昍昅旽昑昐曶朊枅杬枎枒杶杻枘枆构杴枍枌杺枟枑枙枃杽极杸杹枔欥殀歾毞氝沓泬泫泮泙沶泔沭泧沷泐泂沺泃泆泭泲"],
      ["cd40", "泒泝沴沊沝沀泞泀洰泍泇沰泹泏泩泑炔炘炅炓炆炄炑炖炂炚炃牪狖狋狘狉狜狒狔狚狌狑玤玡玭玦玢玠玬玝瓝瓨甿畀甾疌疘皯盳盱盰盵矸矼矹矻矺"],
      ["cda1", "矷祂礿秅穸穻竻籵糽耵肏肮肣肸肵肭舠芠苀芫芚芘芛芵芧芮芼芞芺芴芨芡芩苂芤苃芶芢虰虯虭虮豖迒迋迓迍迖迕迗邲邴邯邳邰阹阽阼阺陃俍俅俓侲俉俋俁俔俜俙侻侳俛俇俖侺俀侹俬剄剉勀勂匽卼厗厖厙厘咺咡咭咥哏"],
      ["ce40", "哃茍咷咮哖咶哅哆咠呰咼咢咾呲哞咰垵垞垟垤垌垗垝垛垔垘垏垙垥垚垕壴复奓姡姞姮娀姱姝姺姽姼姶姤姲姷姛姩姳姵姠姾姴姭宨屌峐峘峌峗峋峛"],
      ["cea1", "峞峚峉峇峊峖峓峔峏峈峆峎峟峸巹帡帢帣帠帤庰庤庢庛庣庥弇弮彖徆怷怹恔恲恞恅恓恇恉恛恌恀恂恟怤恄恘恦恮扂扃拏挍挋拵挎挃拫拹挏挌拸拶挀挓挔拺挕拻拰敁敃斪斿昶昡昲昵昜昦昢昳昫昺昝昴昹昮朏朐柁柲柈枺"],
      ["cf40", "柜枻柸柘柀枷柅柫柤柟枵柍枳柷柶柮柣柂枹柎柧柰枲柼柆柭柌枮柦柛柺柉柊柃柪柋欨殂殄殶毖毘毠氠氡洨洴洭洟洼洿洒洊泚洳洄洙洺洚洑洀洝浂"],
      ["cfa1", "洁洘洷洃洏浀洇洠洬洈洢洉洐炷炟炾炱炰炡炴炵炩牁牉牊牬牰牳牮狊狤狨狫狟狪狦狣玅珌珂珈珅玹玶玵玴珫玿珇玾珃珆玸珋瓬瓮甮畇畈疧疪癹盄眈眃眄眅眊盷盻盺矧矨砆砑砒砅砐砏砎砉砃砓祊祌祋祅祄秕种秏秖秎窀"],
      ["d040", "穾竑笀笁籺籸籹籿粀粁紃紈紁罘羑羍羾耇耎耏耔耷胘胇胠胑胈胂胐胅胣胙胜胊胕胉胏胗胦胍臿舡芔苙苾苹茇苨茀苕茺苫苖苴苬苡苲苵茌苻苶苰苪"],
      ["d0a1", "苤苠苺苳苭虷虴虼虳衁衎衧衪衩觓訄訇赲迣迡迮迠郱邽邿郕郅邾郇郋郈釔釓陔陏陑陓陊陎倞倅倇倓倢倰倛俵俴倳倷倬俶俷倗倜倠倧倵倯倱倎党冔冓凊凄凅凈凎剡剚剒剞剟剕剢勍匎厞唦哢唗唒哧哳哤唚哿唄唈哫唑唅哱"],
      ["d140", "唊哻哷哸哠唎唃唋圁圂埌堲埕埒垺埆垽垼垸垶垿埇埐垹埁夎奊娙娖娭娮娕娏娗娊娞娳孬宧宭宬尃屖屔峬峿峮峱峷崀峹帩帨庨庮庪庬弳弰彧恝恚恧"],
      ["d1a1", "恁悢悈悀悒悁悝悃悕悛悗悇悜悎戙扆拲挐捖挬捄捅挶捃揤挹捋捊挼挩捁挴捘捔捙挭捇挳捚捑挸捗捀捈敊敆旆旃旄旂晊晟晇晑朒朓栟栚桉栲栳栻桋桏栖栱栜栵栫栭栯桎桄栴栝栒栔栦栨栮桍栺栥栠欬欯欭欱欴歭肂殈毦毤"],
      ["d240", "毨毣毢毧氥浺浣浤浶洍浡涒浘浢浭浯涑涍淯浿涆浞浧浠涗浰浼浟涂涘洯浨涋浾涀涄洖涃浻浽浵涐烜烓烑烝烋缹烢烗烒烞烠烔烍烅烆烇烚烎烡牂牸"],
      ["d2a1", "牷牶猀狺狴狾狶狳狻猁珓珙珥珖玼珧珣珩珜珒珛珔珝珚珗珘珨瓞瓟瓴瓵甡畛畟疰痁疻痄痀疿疶疺皊盉眝眛眐眓眒眣眑眕眙眚眢眧砣砬砢砵砯砨砮砫砡砩砳砪砱祔祛祏祜祓祒祑秫秬秠秮秭秪秜秞秝窆窉窅窋窌窊窇竘笐"],
      ["d340", "笄笓笅笏笈笊笎笉笒粄粑粊粌粈粍粅紞紝紑紎紘紖紓紟紒紏紌罜罡罞罠罝罛羖羒翃翂翀耖耾耹胺胲胹胵脁胻脀舁舯舥茳茭荄茙荑茥荖茿荁茦茜茢"],
      ["d3a1", "荂荎茛茪茈茼荍茖茤茠茷茯茩荇荅荌荓茞茬荋茧荈虓虒蚢蚨蚖蚍蚑蚞蚇蚗蚆蚋蚚蚅蚥蚙蚡蚧蚕蚘蚎蚝蚐蚔衃衄衭衵衶衲袀衱衿衯袃衾衴衼訒豇豗豻貤貣赶赸趵趷趶軑軓迾迵适迿迻逄迼迶郖郠郙郚郣郟郥郘郛郗郜郤酐"],
      ["d440", "酎酏釕釢釚陜陟隼飣髟鬯乿偰偪偡偞偠偓偋偝偲偈偍偁偛偊偢倕偅偟偩偫偣偤偆偀偮偳偗偑凐剫剭剬剮勖勓匭厜啵啶唼啍啐唴唪啑啢唶唵唰啒啅"],
      ["d4a1", "唌唲啥啎唹啈唭唻啀啋圊圇埻堔埢埶埜埴堀埭埽堈埸堋埳埏堇埮埣埲埥埬埡堎埼堐埧堁堌埱埩埰堍堄奜婠婘婕婧婞娸娵婭婐婟婥婬婓婤婗婃婝婒婄婛婈媎娾婍娹婌婰婩婇婑婖婂婜孲孮寁寀屙崞崋崝崚崠崌崨崍崦崥崏"],
      ["d540", "崰崒崣崟崮帾帴庱庴庹庲庳弶弸徛徖徟悊悐悆悾悰悺惓惔惏惤惙惝惈悱惛悷惊悿惃惍惀挲捥掊掂捽掽掞掭掝掗掫掎捯掇掐据掯捵掜捭掮捼掤挻掟"],
      ["d5a1", "捸掅掁掑掍捰敓旍晥晡晛晙晜晢朘桹梇梐梜桭桮梮梫楖桯梣梬梩桵桴梲梏桷梒桼桫桲梪梀桱桾梛梖梋梠梉梤桸桻梑梌梊桽欶欳欷欸殑殏殍殎殌氪淀涫涴涳湴涬淩淢涷淶淔渀淈淠淟淖涾淥淜淝淛淴淊涽淭淰涺淕淂淏淉"],
      ["d640", "淐淲淓淽淗淍淣涻烺焍烷焗烴焌烰焄烳焐烼烿焆焓焀烸烶焋焂焎牾牻牼牿猝猗猇猑猘猊猈狿猏猞玈珶珸珵琄琁珽琇琀珺珼珿琌琋珴琈畤畣痎痒痏"],
      ["d6a1", "痋痌痑痐皏皉盓眹眯眭眱眲眴眳眽眥眻眵硈硒硉硍硊硌砦硅硐祤祧祩祪祣祫祡离秺秸秶秷窏窔窐笵筇笴笥笰笢笤笳笘笪笝笱笫笭笯笲笸笚笣粔粘粖粣紵紽紸紶紺絅紬紩絁絇紾紿絊紻紨罣羕羜羝羛翊翋翍翐翑翇翏翉耟"],
      ["d740", "耞耛聇聃聈脘脥脙脛脭脟脬脞脡脕脧脝脢舑舸舳舺舴舲艴莐莣莨莍荺荳莤荴莏莁莕莙荵莔莩荽莃莌莝莛莪莋荾莥莯莈莗莰荿莦莇莮荶莚虙虖蚿蚷"],
      ["d7a1", "蛂蛁蛅蚺蚰蛈蚹蚳蚸蛌蚴蚻蚼蛃蚽蚾衒袉袕袨袢袪袚袑袡袟袘袧袙袛袗袤袬袌袓袎覂觖觙觕訰訧訬訞谹谻豜豝豽貥赽赻赹趼跂趹趿跁軘軞軝軜軗軠軡逤逋逑逜逌逡郯郪郰郴郲郳郔郫郬郩酖酘酚酓酕釬釴釱釳釸釤釹釪"],
      ["d840", "釫釷釨釮镺閆閈陼陭陫陱陯隿靪頄飥馗傛傕傔傞傋傣傃傌傎傝偨傜傒傂傇兟凔匒匑厤厧喑喨喥喭啷噅喢喓喈喏喵喁喣喒喤啽喌喦啿喕喡喎圌堩堷"],
      ["d8a1", "堙堞堧堣堨埵塈堥堜堛堳堿堶堮堹堸堭堬堻奡媯媔媟婺媢媞婸媦婼媥媬媕媮娷媄媊媗媃媋媩婻婽媌媜媏媓媝寪寍寋寔寑寊寎尌尰崷嵃嵫嵁嵋崿崵嵑嵎嵕崳崺嵒崽崱嵙嵂崹嵉崸崼崲崶嵀嵅幄幁彘徦徥徫惉悹惌惢惎惄愔"],
      ["d940", "惲愊愖愅惵愓惸惼惾惁愃愘愝愐惿愄愋扊掔掱掰揎揥揨揯揃撝揳揊揠揶揕揲揵摡揟掾揝揜揄揘揓揂揇揌揋揈揰揗揙攲敧敪敤敜敨敥斌斝斞斮旐旒"],
      ["d9a1", "晼晬晻暀晱晹晪晲朁椌棓椄棜椪棬棪棱椏棖棷棫棤棶椓椐棳棡椇棌椈楰梴椑棯棆椔棸棐棽棼棨椋椊椗棎棈棝棞棦棴棑椆棔棩椕椥棇欹欻欿欼殔殗殙殕殽毰毲毳氰淼湆湇渟湉溈渼渽湅湢渫渿湁湝湳渜渳湋湀湑渻渃渮湞"],
      ["da40", "湨湜湡渱渨湠湱湫渹渢渰湓湥渧湸湤湷湕湹湒湦渵渶湚焠焞焯烻焮焱焣焥焢焲焟焨焺焛牋牚犈犉犆犅犋猒猋猰猢猱猳猧猲猭猦猣猵猌琮琬琰琫琖"],
      ["daa1", "琚琡琭琱琤琣琝琩琠琲瓻甯畯畬痧痚痡痦痝痟痤痗皕皒盚睆睇睄睍睅睊睎睋睌矞矬硠硤硥硜硭硱硪确硰硩硨硞硢祴祳祲祰稂稊稃稌稄窙竦竤筊笻筄筈筌筎筀筘筅粢粞粨粡絘絯絣絓絖絧絪絏絭絜絫絒絔絩絑絟絎缾缿罥"],
      ["db40", "罦羢羠羡翗聑聏聐胾胔腃腊腒腏腇脽腍脺臦臮臷臸臹舄舼舽舿艵茻菏菹萣菀菨萒菧菤菼菶萐菆菈菫菣莿萁菝菥菘菿菡菋菎菖菵菉萉萏菞萑萆菂菳"],
      ["dba1", "菕菺菇菑菪萓菃菬菮菄菻菗菢萛菛菾蛘蛢蛦蛓蛣蛚蛪蛝蛫蛜蛬蛩蛗蛨蛑衈衖衕袺裗袹袸裀袾袶袼袷袽袲褁裉覕覘覗觝觚觛詎詍訹詙詀詗詘詄詅詒詈詑詊詌詏豟貁貀貺貾貰貹貵趄趀趉跘跓跍跇跖跜跏跕跙跈跗跅軯軷軺"],
      ["dc40", "軹軦軮軥軵軧軨軶軫軱軬軴軩逭逴逯鄆鄬鄄郿郼鄈郹郻鄁鄀鄇鄅鄃酡酤酟酢酠鈁鈊鈥鈃鈚鈦鈏鈌鈀鈒釿釽鈆鈄鈧鈂鈜鈤鈙鈗鈅鈖镻閍閌閐隇陾隈"],
      ["dca1", "隉隃隀雂雈雃雱雰靬靰靮頇颩飫鳦黹亃亄亶傽傿僆傮僄僊傴僈僂傰僁傺傱僋僉傶傸凗剺剸剻剼嗃嗛嗌嗐嗋嗊嗝嗀嗔嗄嗩喿嗒喍嗏嗕嗢嗖嗈嗲嗍嗙嗂圔塓塨塤塏塍塉塯塕塎塝塙塥塛堽塣塱壼嫇嫄嫋媺媸媱媵媰媿嫈媻嫆"],
      ["dd40", "媷嫀嫊媴媶嫍媹媐寖寘寙尟尳嵱嵣嵊嵥嵲嵬嵞嵨嵧嵢巰幏幎幊幍幋廅廌廆廋廇彀徯徭惷慉慊愫慅愶愲愮慆愯慏愩慀戠酨戣戥戤揅揱揫搐搒搉搠搤"],
      ["dda1", "搳摃搟搕搘搹搷搢搣搌搦搰搨摁搵搯搊搚摀搥搧搋揧搛搮搡搎敯斒旓暆暌暕暐暋暊暙暔晸朠楦楟椸楎楢楱椿楅楪椹楂楗楙楺楈楉椵楬椳椽楥棰楸椴楩楀楯楄楶楘楁楴楌椻楋椷楜楏楑椲楒椯楻椼歆歅歃歂歈歁殛嗀毻毼"],
      ["de40", "毹毷毸溛滖滈溏滀溟溓溔溠溱溹滆滒溽滁溞滉溷溰滍溦滏溲溾滃滜滘溙溒溎溍溤溡溿溳滐滊溗溮溣煇煔煒煣煠煁煝煢煲煸煪煡煂煘煃煋煰煟煐煓"],
      ["dea1", "煄煍煚牏犍犌犑犐犎猼獂猻猺獀獊獉瑄瑊瑋瑒瑑瑗瑀瑏瑐瑎瑂瑆瑍瑔瓡瓿瓾瓽甝畹畷榃痯瘏瘃痷痾痼痹痸瘐痻痶痭痵痽皙皵盝睕睟睠睒睖睚睩睧睔睙睭矠碇碚碔碏碄碕碅碆碡碃硹碙碀碖硻祼禂祽祹稑稘稙稒稗稕稢稓"],
      ["df40", "稛稐窣窢窞竫筦筤筭筴筩筲筥筳筱筰筡筸筶筣粲粴粯綈綆綀綍絿綅絺綎絻綃絼綌綔綄絽綒罭罫罧罨罬羦羥羧翛翜耡腤腠腷腜腩腛腢腲朡腞腶腧腯"],
      ["dfa1", "腄腡舝艉艄艀艂艅蓱萿葖葶葹蒏蒍葥葑葀蒆葧萰葍葽葚葙葴葳葝蔇葞萷萺萴葺葃葸萲葅萩菙葋萯葂萭葟葰萹葎葌葒葯蓅蒎萻葇萶萳葨葾葄萫葠葔葮葐蜋蜄蛷蜌蛺蛖蛵蝍蛸蜎蜉蜁蛶蜍蜅裖裋裍裎裞裛裚裌裐覅覛觟觥觤"],
      ["e040", "觡觠觢觜触詶誆詿詡訿詷誂誄詵誃誁詴詺谼豋豊豥豤豦貆貄貅賌赨赩趑趌趎趏趍趓趔趐趒跰跠跬跱跮跐跩跣跢跧跲跫跴輆軿輁輀輅輇輈輂輋遒逿"],
      ["e0a1", "遄遉逽鄐鄍鄏鄑鄖鄔鄋鄎酮酯鉈鉒鈰鈺鉦鈳鉥鉞銃鈮鉊鉆鉭鉬鉏鉠鉧鉯鈶鉡鉰鈱鉔鉣鉐鉲鉎鉓鉌鉖鈲閟閜閞閛隒隓隑隗雎雺雽雸雵靳靷靸靲頏頍頎颬飶飹馯馲馰馵骭骫魛鳪鳭鳧麀黽僦僔僗僨僳僛僪僝僤僓僬僰僯僣僠"],
      ["e140", "凘劀劁勩勫匰厬嘧嘕嘌嘒嗼嘏嘜嘁嘓嘂嗺嘝嘄嗿嗹墉塼墐墘墆墁塿塴墋塺墇墑墎塶墂墈塻墔墏壾奫嫜嫮嫥嫕嫪嫚嫭嫫嫳嫢嫠嫛嫬嫞嫝嫙嫨嫟孷寠"],
      ["e1a1", "寣屣嶂嶀嵽嶆嵺嶁嵷嶊嶉嶈嵾嵼嶍嵹嵿幘幙幓廘廑廗廎廜廕廙廒廔彄彃彯徶愬愨慁慞慱慳慒慓慲慬憀慴慔慺慛慥愻慪慡慖戩戧戫搫摍摛摝摴摶摲摳摽摵摦撦摎撂摞摜摋摓摠摐摿搿摬摫摙摥摷敳斠暡暠暟朅朄朢榱榶槉"],
      ["e240", "榠槎榖榰榬榼榑榙榎榧榍榩榾榯榿槄榽榤槔榹槊榚槏榳榓榪榡榞槙榗榐槂榵榥槆歊歍歋殞殟殠毃毄毾滎滵滱漃漥滸漷滻漮漉潎漙漚漧漘漻漒滭漊"],
      ["e2a1", "漶潳滹滮漭潀漰漼漵滫漇漎潃漅滽滶漹漜滼漺漟漍漞漈漡熇熐熉熀熅熂熏煻熆熁熗牄牓犗犕犓獃獍獑獌瑢瑳瑱瑵瑲瑧瑮甀甂甃畽疐瘖瘈瘌瘕瘑瘊瘔皸瞁睼瞅瞂睮瞀睯睾瞃碲碪碴碭碨硾碫碞碥碠碬碢碤禘禊禋禖禕禔禓"],
      ["e340", "禗禈禒禐稫穊稰稯稨稦窨窫窬竮箈箜箊箑箐箖箍箌箛箎箅箘劄箙箤箂粻粿粼粺綧綷緂綣綪緁緀緅綝緎緄緆緋緌綯綹綖綼綟綦綮綩綡緉罳翢翣翥翞"],
      ["e3a1", "耤聝聜膉膆膃膇膍膌膋舕蒗蒤蒡蒟蒺蓎蓂蒬蒮蒫蒹蒴蓁蓍蒪蒚蒱蓐蒝蒧蒻蒢蒔蓇蓌蒛蒩蒯蒨蓖蒘蒶蓏蒠蓗蓔蓒蓛蒰蒑虡蜳蜣蜨蝫蝀蜮蜞蜡蜙蜛蝃蜬蝁蜾蝆蜠蜲蜪蜭蜼蜒蜺蜱蜵蝂蜦蜧蜸蜤蜚蜰蜑裷裧裱裲裺裾裮裼裶裻"],
      ["e440", "裰裬裫覝覡覟覞觩觫觨誫誙誋誒誏誖谽豨豩賕賏賗趖踉踂跿踍跽踊踃踇踆踅跾踀踄輐輑輎輍鄣鄜鄠鄢鄟鄝鄚鄤鄡鄛酺酲酹酳銥銤鉶銛鉺銠銔銪銍"],
      ["e4a1", "銦銚銫鉹銗鉿銣鋮銎銂銕銢鉽銈銡銊銆銌銙銧鉾銇銩銝銋鈭隞隡雿靘靽靺靾鞃鞀鞂靻鞄鞁靿韎韍頖颭颮餂餀餇馝馜駃馹馻馺駂馽駇骱髣髧鬾鬿魠魡魟鳱鳲鳵麧僿儃儰僸儆儇僶僾儋儌僽儊劋劌勱勯噈噂噌嘵噁噊噉噆噘"],
      ["e540", "噚噀嘳嘽嘬嘾嘸嘪嘺圚墫墝墱墠墣墯墬墥墡壿嫿嫴嫽嫷嫶嬃嫸嬂嫹嬁嬇嬅嬏屧嶙嶗嶟嶒嶢嶓嶕嶠嶜嶡嶚嶞幩幝幠幜緳廛廞廡彉徲憋憃慹憱憰憢憉"],
      ["e5a1", "憛憓憯憭憟憒憪憡憍慦憳戭摮摰撖撠撅撗撜撏撋撊撌撣撟摨撱撘敶敺敹敻斲斳暵暰暩暲暷暪暯樀樆樗槥槸樕槱槤樠槿槬槢樛樝槾樧槲槮樔槷槧橀樈槦槻樍槼槫樉樄樘樥樏槶樦樇槴樖歑殥殣殢殦氁氀毿氂潁漦潾澇濆澒"],
      ["e640", "澍澉澌潢潏澅潚澖潶潬澂潕潲潒潐潗澔澓潝漀潡潫潽潧澐潓澋潩潿澕潣潷潪潻熲熯熛熰熠熚熩熵熝熥熞熤熡熪熜熧熳犘犚獘獒獞獟獠獝獛獡獚獙"],
      ["e6a1", "獢璇璉璊璆璁瑽璅璈瑼瑹甈甇畾瘥瘞瘙瘝瘜瘣瘚瘨瘛皜皝皞皛瞍瞏瞉瞈磍碻磏磌磑磎磔磈磃磄磉禚禡禠禜禢禛歶稹窲窴窳箷篋箾箬篎箯箹篊箵糅糈糌糋緷緛緪緧緗緡縃緺緦緶緱緰緮緟罶羬羰羭翭翫翪翬翦翨聤聧膣膟"],
      ["e740", "膞膕膢膙膗舖艏艓艒艐艎艑蔤蔻蔏蔀蔩蔎蔉蔍蔟蔊蔧蔜蓻蔫蓺蔈蔌蓴蔪蓲蔕蓷蓫蓳蓼蔒蓪蓩蔖蓾蔨蔝蔮蔂蓽蔞蓶蔱蔦蓧蓨蓰蓯蓹蔘蔠蔰蔋蔙蔯虢"],
      ["e7a1", "蝖蝣蝤蝷蟡蝳蝘蝔蝛蝒蝡蝚蝑蝞蝭蝪蝐蝎蝟蝝蝯蝬蝺蝮蝜蝥蝏蝻蝵蝢蝧蝩衚褅褌褔褋褗褘褙褆褖褑褎褉覢覤覣觭觰觬諏諆誸諓諑諔諕誻諗誾諀諅諘諃誺誽諙谾豍貏賥賟賙賨賚賝賧趠趜趡趛踠踣踥踤踮踕踛踖踑踙踦踧"],
      ["e840", "踔踒踘踓踜踗踚輬輤輘輚輠輣輖輗遳遰遯遧遫鄯鄫鄩鄪鄲鄦鄮醅醆醊醁醂醄醀鋐鋃鋄鋀鋙銶鋏鋱鋟鋘鋩鋗鋝鋌鋯鋂鋨鋊鋈鋎鋦鋍鋕鋉鋠鋞鋧鋑鋓"],
      ["e8a1", "銵鋡鋆銴镼閬閫閮閰隤隢雓霅霈霂靚鞊鞎鞈韐韏頞頝頦頩頨頠頛頧颲餈飺餑餔餖餗餕駜駍駏駓駔駎駉駖駘駋駗駌骳髬髫髳髲髱魆魃魧魴魱魦魶魵魰魨魤魬鳼鳺鳽鳿鳷鴇鴀鳹鳻鴈鴅鴄麃黓鼏鼐儜儓儗儚儑凞匴叡噰噠噮"],
      ["e940", "噳噦噣噭噲噞噷圜圛壈墽壉墿墺壂墼壆嬗嬙嬛嬡嬔嬓嬐嬖嬨嬚嬠嬞寯嶬嶱嶩嶧嶵嶰嶮嶪嶨嶲嶭嶯嶴幧幨幦幯廩廧廦廨廥彋徼憝憨憖懅憴懆懁懌憺"],
      ["e9a1", "憿憸憌擗擖擐擏擉撽撉擃擛擳擙攳敿敼斢曈暾曀曊曋曏暽暻暺曌朣樴橦橉橧樲橨樾橝橭橶橛橑樨橚樻樿橁橪橤橐橏橔橯橩橠樼橞橖橕橍橎橆歕歔歖殧殪殫毈毇氄氃氆澭濋澣濇澼濎濈潞濄澽澞濊澨瀄澥澮澺澬澪濏澿澸"],
      ["ea40", "澢濉澫濍澯澲澰燅燂熿熸燖燀燁燋燔燊燇燏熽燘熼燆燚燛犝犞獩獦獧獬獥獫獪瑿璚璠璔璒璕璡甋疀瘯瘭瘱瘽瘳瘼瘵瘲瘰皻盦瞚瞝瞡瞜瞛瞢瞣瞕瞙"],
      ["eaa1", "瞗磝磩磥磪磞磣磛磡磢磭磟磠禤穄穈穇窶窸窵窱窷篞篣篧篝篕篥篚篨篹篔篪篢篜篫篘篟糒糔糗糐糑縒縡縗縌縟縠縓縎縜縕縚縢縋縏縖縍縔縥縤罃罻罼罺羱翯耪耩聬膱膦膮膹膵膫膰膬膴膲膷膧臲艕艖艗蕖蕅蕫蕍蕓蕡蕘"],
      ["eb40", "蕀蕆蕤蕁蕢蕄蕑蕇蕣蔾蕛蕱蕎蕮蕵蕕蕧蕠薌蕦蕝蕔蕥蕬虣虥虤螛螏螗螓螒螈螁螖螘蝹螇螣螅螐螑螝螄螔螜螚螉褞褦褰褭褮褧褱褢褩褣褯褬褟觱諠"],
      ["eba1", "諢諲諴諵諝謔諤諟諰諈諞諡諨諿諯諻貑貒貐賵賮賱賰賳赬赮趥趧踳踾踸蹀蹅踶踼踽蹁踰踿躽輶輮輵輲輹輷輴遶遹遻邆郺鄳鄵鄶醓醐醑醍醏錧錞錈錟錆錏鍺錸錼錛錣錒錁鍆錭錎錍鋋錝鋺錥錓鋹鋷錴錂錤鋿錩錹錵錪錔錌"],
      ["ec40", "錋鋾錉錀鋻錖閼闍閾閹閺閶閿閵閽隩雔霋霒霐鞙鞗鞔韰韸頵頯頲餤餟餧餩馞駮駬駥駤駰駣駪駩駧骹骿骴骻髶髺髹髷鬳鮀鮅鮇魼魾魻鮂鮓鮒鮐魺鮕"],
      ["eca1", "魽鮈鴥鴗鴠鴞鴔鴩鴝鴘鴢鴐鴙鴟麈麆麇麮麭黕黖黺鼒鼽儦儥儢儤儠儩勴嚓嚌嚍嚆嚄嚃噾嚂噿嚁壖壔壏壒嬭嬥嬲嬣嬬嬧嬦嬯嬮孻寱寲嶷幬幪徾徻懃憵憼懧懠懥懤懨懞擯擩擣擫擤擨斁斀斶旚曒檍檖檁檥檉檟檛檡檞檇檓檎"],
      ["ed40", "檕檃檨檤檑橿檦檚檅檌檒歛殭氉濌澩濴濔濣濜濭濧濦濞濲濝濢濨燡燱燨燲燤燰燢獳獮獯璗璲璫璐璪璭璱璥璯甐甑甒甏疄癃癈癉癇皤盩瞵瞫瞲瞷瞶"],
      ["eda1", "瞴瞱瞨矰磳磽礂磻磼磲礅磹磾礄禫禨穜穛穖穘穔穚窾竀竁簅簏篲簀篿篻簎篴簋篳簂簉簃簁篸篽簆篰篱簐簊糨縭縼繂縳顈縸縪繉繀繇縩繌縰縻縶繄縺罅罿罾罽翴翲耬膻臄臌臊臅臇膼臩艛艚艜薃薀薏薧薕薠薋薣蕻薤薚薞"],
      ["ee40", "蕷蕼薉薡蕺蕸蕗薎薖薆薍薙薝薁薢薂薈薅蕹蕶薘薐薟虨螾螪螭蟅螰螬螹螵螼螮蟉蟃蟂蟌螷螯蟄蟊螴螶螿螸螽蟞螲褵褳褼褾襁襒褷襂覭覯覮觲觳謞"],
      ["eea1", "謘謖謑謅謋謢謏謒謕謇謍謈謆謜謓謚豏豰豲豱豯貕貔賹赯蹎蹍蹓蹐蹌蹇轃轀邅遾鄸醚醢醛醙醟醡醝醠鎡鎃鎯鍤鍖鍇鍼鍘鍜鍶鍉鍐鍑鍠鍭鎏鍌鍪鍹鍗鍕鍒鍏鍱鍷鍻鍡鍞鍣鍧鎀鍎鍙闇闀闉闃闅閷隮隰隬霠霟霘霝霙鞚鞡鞜"],
      ["ef40", "鞞鞝韕韔韱顁顄顊顉顅顃餥餫餬餪餳餲餯餭餱餰馘馣馡騂駺駴駷駹駸駶駻駽駾駼騃骾髾髽鬁髼魈鮚鮨鮞鮛鮦鮡鮥鮤鮆鮢鮠鮯鴳鵁鵧鴶鴮鴯鴱鴸鴰"],
      ["efa1", "鵅鵂鵃鴾鴷鵀鴽翵鴭麊麉麍麰黈黚黻黿鼤鼣鼢齔龠儱儭儮嚘嚜嚗嚚嚝嚙奰嬼屩屪巀幭幮懘懟懭懮懱懪懰懫懖懩擿攄擽擸攁攃擼斔旛曚曛曘櫅檹檽櫡櫆檺檶檷櫇檴檭歞毉氋瀇瀌瀍瀁瀅瀔瀎濿瀀濻瀦濼濷瀊爁燿燹爃燽獶"],
      ["f040", "璸瓀璵瓁璾璶璻瓂甔甓癜癤癙癐癓癗癚皦皽盬矂瞺磿礌礓礔礉礐礒礑禭禬穟簜簩簙簠簟簭簝簦簨簢簥簰繜繐繖繣繘繢繟繑繠繗繓羵羳翷翸聵臑臒"],
      ["f0a1", "臐艟艞薴藆藀藃藂薳薵薽藇藄薿藋藎藈藅薱薶藒蘤薸薷薾虩蟧蟦蟢蟛蟫蟪蟥蟟蟳蟤蟔蟜蟓蟭蟘蟣螤蟗蟙蠁蟴蟨蟝襓襋襏襌襆襐襑襉謪謧謣謳謰謵譇謯謼謾謱謥謷謦謶謮謤謻謽謺豂豵貙貘貗賾贄贂贀蹜蹢蹠蹗蹖蹞蹥蹧"],
      ["f140", "蹛蹚蹡蹝蹩蹔轆轇轈轋鄨鄺鄻鄾醨醥醧醯醪鎵鎌鎒鎷鎛鎝鎉鎧鎎鎪鎞鎦鎕鎈鎙鎟鎍鎱鎑鎲鎤鎨鎴鎣鎥闒闓闑隳雗雚巂雟雘雝霣霢霥鞬鞮鞨鞫鞤鞪"],
      ["f1a1", "鞢鞥韗韙韖韘韺顐顑顒颸饁餼餺騏騋騉騍騄騑騊騅騇騆髀髜鬈鬄鬅鬩鬵魊魌魋鯇鯆鯃鮿鯁鮵鮸鯓鮶鯄鮹鮽鵜鵓鵏鵊鵛鵋鵙鵖鵌鵗鵒鵔鵟鵘鵚麎麌黟鼁鼀鼖鼥鼫鼪鼩鼨齌齕儴儵劖勷厴嚫嚭嚦嚧嚪嚬壚壝壛夒嬽嬾嬿巃幰"],
      ["f240", "徿懻攇攐攍攉攌攎斄旞旝曞櫧櫠櫌櫑櫙櫋櫟櫜櫐櫫櫏櫍櫞歠殰氌瀙瀧瀠瀖瀫瀡瀢瀣瀩瀗瀤瀜瀪爌爊爇爂爅犥犦犤犣犡瓋瓅璷瓃甖癠矉矊矄矱礝礛"],
      ["f2a1", "礡礜礗礞禰穧穨簳簼簹簬簻糬糪繶繵繸繰繷繯繺繲繴繨罋罊羃羆羷翽翾聸臗臕艤艡艣藫藱藭藙藡藨藚藗藬藲藸藘藟藣藜藑藰藦藯藞藢蠀蟺蠃蟶蟷蠉蠌蠋蠆蟼蠈蟿蠊蠂襢襚襛襗襡襜襘襝襙覈覷覶觶譐譈譊譀譓譖譔譋譕"],
      ["f340", "譑譂譒譗豃豷豶貚贆贇贉趬趪趭趫蹭蹸蹳蹪蹯蹻軂轒轑轏轐轓辴酀鄿醰醭鏞鏇鏏鏂鏚鏐鏹鏬鏌鏙鎩鏦鏊鏔鏮鏣鏕鏄鏎鏀鏒鏧镽闚闛雡霩霫霬霨霦"],
      ["f3a1", "鞳鞷鞶韝韞韟顜顙顝顗颿颽颻颾饈饇饃馦馧騚騕騥騝騤騛騢騠騧騣騞騜騔髂鬋鬊鬎鬌鬷鯪鯫鯠鯞鯤鯦鯢鯰鯔鯗鯬鯜鯙鯥鯕鯡鯚鵷鶁鶊鶄鶈鵱鶀鵸鶆鶋鶌鵽鵫鵴鵵鵰鵩鶅鵳鵻鶂鵯鵹鵿鶇鵨麔麑黀黼鼭齀齁齍齖齗齘匷嚲"],
      ["f440", "嚵嚳壣孅巆巇廮廯忀忁懹攗攖攕攓旟曨曣曤櫳櫰櫪櫨櫹櫱櫮櫯瀼瀵瀯瀷瀴瀱灂瀸瀿瀺瀹灀瀻瀳灁爓爔犨獽獼璺皫皪皾盭矌矎矏矍矲礥礣礧礨礤礩"],
      ["f4a1", "禲穮穬穭竷籉籈籊籇籅糮繻繾纁纀羺翿聹臛臙舋艨艩蘢藿蘁藾蘛蘀藶蘄蘉蘅蘌藽蠙蠐蠑蠗蠓蠖襣襦覹觷譠譪譝譨譣譥譧譭趮躆躈躄轙轖轗轕轘轚邍酃酁醷醵醲醳鐋鐓鏻鐠鐏鐔鏾鐕鐐鐨鐙鐍鏵鐀鏷鐇鐎鐖鐒鏺鐉鏸鐊鏿"],
      ["f540", "鏼鐌鏶鐑鐆闞闠闟霮霯鞹鞻韽韾顠顢顣顟飁飂饐饎饙饌饋饓騲騴騱騬騪騶騩騮騸騭髇髊髆鬐鬒鬑鰋鰈鯷鰅鰒鯸鱀鰇鰎鰆鰗鰔鰉鶟鶙鶤鶝鶒鶘鶐鶛"],
      ["f5a1", "鶠鶔鶜鶪鶗鶡鶚鶢鶨鶞鶣鶿鶩鶖鶦鶧麙麛麚黥黤黧黦鼰鼮齛齠齞齝齙龑儺儹劘劗囃嚽嚾孈孇巋巏廱懽攛欂櫼欃櫸欀灃灄灊灈灉灅灆爝爚爙獾甗癪矐礭礱礯籔籓糲纊纇纈纋纆纍罍羻耰臝蘘蘪蘦蘟蘣蘜蘙蘧蘮蘡蘠蘩蘞蘥"],
      ["f640", "蠩蠝蠛蠠蠤蠜蠫衊襭襩襮襫觺譹譸譅譺譻贐贔趯躎躌轞轛轝酆酄酅醹鐿鐻鐶鐩鐽鐼鐰鐹鐪鐷鐬鑀鐱闥闤闣霵霺鞿韡顤飉飆飀饘饖騹騽驆驄驂驁騺"],
      ["f6a1", "騿髍鬕鬗鬘鬖鬺魒鰫鰝鰜鰬鰣鰨鰩鰤鰡鶷鶶鶼鷁鷇鷊鷏鶾鷅鷃鶻鶵鷎鶹鶺鶬鷈鶱鶭鷌鶳鷍鶲鹺麜黫黮黭鼛鼘鼚鼱齎齥齤龒亹囆囅囋奱孋孌巕巑廲攡攠攦攢欋欈欉氍灕灖灗灒爞爟犩獿瓘瓕瓙瓗癭皭礵禴穰穱籗籜籙籛籚"],
      ["f740", "糴糱纑罏羇臞艫蘴蘵蘳蘬蘲蘶蠬蠨蠦蠪蠥襱覿覾觻譾讄讂讆讅譿贕躕躔躚躒躐躖躗轠轢酇鑌鑐鑊鑋鑏鑇鑅鑈鑉鑆霿韣顪顩飋饔饛驎驓驔驌驏驈驊"],
      ["f7a1", "驉驒驐髐鬙鬫鬻魖魕鱆鱈鰿鱄鰹鰳鱁鰼鰷鰴鰲鰽鰶鷛鷒鷞鷚鷋鷐鷜鷑鷟鷩鷙鷘鷖鷵鷕鷝麶黰鼵鼳鼲齂齫龕龢儽劙壨壧奲孍巘蠯彏戁戃戄攩攥斖曫欑欒欏毊灛灚爢玂玁玃癰矔籧籦纕艬蘺虀蘹蘼蘱蘻蘾蠰蠲蠮蠳襶襴襳觾"],
      ["f840", "讌讎讋讈豅贙躘轤轣醼鑢鑕鑝鑗鑞韄韅頀驖驙鬞鬟鬠鱒鱘鱐鱊鱍鱋鱕鱙鱌鱎鷻鷷鷯鷣鷫鷸鷤鷶鷡鷮鷦鷲鷰鷢鷬鷴鷳鷨鷭黂黐黲黳鼆鼜鼸鼷鼶齃齏"],
      ["f8a1", "齱齰齮齯囓囍孎屭攭曭曮欓灟灡灝灠爣瓛瓥矕礸禷禶籪纗羉艭虃蠸蠷蠵衋讔讕躞躟躠躝醾醽釂鑫鑨鑩雥靆靃靇韇韥驞髕魙鱣鱧鱦鱢鱞鱠鸂鷾鸇鸃鸆鸅鸀鸁鸉鷿鷽鸄麠鼞齆齴齵齶囔攮斸欘欙欗欚灢爦犪矘矙礹籩籫糶纚"],
      ["f940", "纘纛纙臠臡虆虇虈襹襺襼襻觿讘讙躥躤躣鑮鑭鑯鑱鑳靉顲饟鱨鱮鱭鸋鸍鸐鸏鸒鸑麡黵鼉齇齸齻齺齹圞灦籯蠼趲躦釃鑴鑸鑶鑵驠鱴鱳鱱鱵鸔鸓黶鼊"],
      ["f9a1", "龤灨灥糷虪蠾蠽蠿讞貜躩軉靋顳顴飌饡馫驤驦驧鬤鸕鸗齈戇欞爧虌躨钂钀钁驩驨鬮鸙爩虋讟钃鱹麷癵驫鱺鸝灩灪麤齾齉龘碁銹裏墻恒粧嫺╔╦╗╠╬╣╚╩╝╒╤╕╞╪╡╘╧╛╓╥╖╟╫╢╙╨╜║═╭╮╰╯▓"]
    ];
  }
});

// node_modules/iconv-lite/encodings/tables/big5-added.json
var require_big5_added = __commonJS({
  "node_modules/iconv-lite/encodings/tables/big5-added.json"(exports2, module2) {
    module2.exports = [
      ["8740", "䏰䰲䘃䖦䕸𧉧䵷䖳𧲱䳢𧳅㮕䜶䝄䱇䱀𤊿𣘗𧍒𦺋𧃒䱗𪍑䝏䗚䲅𧱬䴇䪤䚡𦬣爥𥩔𡩣𣸆𣽡晍囻"],
      ["8767", "綕夝𨮹㷴霴𧯯寛𡵞媤㘥𩺰嫑宷峼杮薓𩥅瑡璝㡵𡵓𣚞𦀡㻬"],
      ["87a1", "𥣞㫵竼龗𤅡𨤍𣇪𠪊𣉞䌊蒄龖鐯䤰蘓墖靊鈘秐稲晠権袝瑌篅枂稬剏遆㓦珄𥶹瓆鿇垳䤯呌䄱𣚎堘穲𧭥讏䚮𦺈䆁𥶙箮𢒼鿈𢓁𢓉𢓌鿉蔄𣖻䂴鿊䓡𪷿拁灮鿋"],
      ["8840", "㇀", 4, "𠄌㇅𠃑𠃍㇆㇇𠃋𡿨㇈𠃊㇉㇊㇋㇌𠄎㇍㇎ĀÁǍÀĒÉĚÈŌÓǑÒ࿿Ê̄Ế࿿Ê̌ỀÊāáǎàɑēéěèīíǐìōóǒòūúǔùǖǘǚ"],
      ["88a1", "ǜü࿿ê̄ế࿿ê̌ềêɡ⏚⏛"],
      ["8940", "𪎩𡅅"],
      ["8943", "攊"],
      ["8946", "丽滝鵎釟"],
      ["894c", "𧜵撑会伨侨兖兴农凤务动医华发变团声处备夲头学实実岚庆总斉柾栄桥济炼电纤纬纺织经统缆缷艺苏药视设询车轧轮"],
      ["89a1", "琑糼緍楆竉刧"],
      ["89ab", "醌碸酞肼"],
      ["89b0", "贋胶𠧧"],
      ["89b5", "肟黇䳍鷉鸌䰾𩷶𧀎鸊𪄳㗁"],
      ["89c1", "溚舾甙"],
      ["89c5", "䤑马骏龙禇𨑬𡷊𠗐𢫦两亁亀亇亿仫伷㑌侽㹈倃傈㑽㒓㒥円夅凛凼刅争剹劐匧㗇厩㕑厰㕓参吣㕭㕲㚁咓咣咴咹哐哯唘唣唨㖘唿㖥㖿嗗㗅"],
      ["8a40", "𧶄唥"],
      ["8a43", "𠱂𠴕𥄫喐𢳆㧬𠍁蹆𤶸𩓥䁓𨂾睺𢰸㨴䟕𨅝𦧲𤷪擝𠵼𠾴𠳕𡃴撍蹾𠺖𠰋𠽤𢲩𨉖𤓓"],
      ["8a64", "𠵆𩩍𨃩䟴𤺧𢳂骲㩧𩗴㿭㔆𥋇𩟔𧣈𢵄鵮頕"],
      ["8a76", "䏙𦂥撴哣𢵌𢯊𡁷㧻𡁯"],
      ["8aa1", "𦛚𦜖𧦠擪𥁒𠱃蹨𢆡𨭌𠜱"],
      ["8aac", "䠋𠆩㿺塳𢶍"],
      ["8ab2", "𤗈𠓼𦂗𠽌𠶖啹䂻䎺"],
      ["8abb", "䪴𢩦𡂝膪飵𠶜捹㧾𢝵跀嚡摼㹃"],
      ["8ac9", "𪘁𠸉𢫏𢳉"],
      ["8ace", "𡃈𣧂㦒㨆𨊛㕸𥹉𢃇噒𠼱𢲲𩜠㒼氽𤸻"],
      ["8adf", "𧕴𢺋𢈈𪙛𨳍𠹺𠰴𦠜羓𡃏𢠃𢤹㗻𥇣𠺌𠾍𠺪㾓𠼰𠵇𡅏𠹌"],
      ["8af6", "𠺫𠮩𠵈𡃀𡄽㿹𢚖搲𠾭"],
      ["8b40", "𣏴𧘹𢯎𠵾𠵿𢱑𢱕㨘𠺘𡃇𠼮𪘲𦭐𨳒𨶙𨳊閪哌苄喹"],
      ["8b55", "𩻃鰦骶𧝞𢷮煀腭胬尜𦕲脴㞗卟𨂽醶𠻺𠸏𠹷𠻻㗝𤷫㘉𠳖嚯𢞵𡃉𠸐𠹸𡁸𡅈𨈇𡑕𠹹𤹐𢶤婔𡀝𡀞𡃵𡃶垜𠸑"],
      ["8ba1", "𧚔𨋍𠾵𠹻𥅾㜃𠾶𡆀𥋘𪊽𤧚𡠺𤅷𨉼墙剨㘚𥜽箲孨䠀䬬鼧䧧鰟鮍𥭴𣄽嗻㗲嚉丨夂𡯁屮靑𠂆乛亻㔾尣彑忄㣺扌攵歺氵氺灬爫丬犭𤣩罒礻糹罓𦉪㓁"],
      ["8bde", "𦍋耂肀𦘒𦥑卝衤见𧢲讠贝钅镸长门𨸏韦页风飞饣𩠐鱼鸟黄歯龜丷𠂇阝户钢"],
      ["8c40", "倻淾𩱳龦㷉袏𤅎灷峵䬠𥇍㕙𥴰愢𨨲辧釶熑朙玺𣊁𪄇㲋𡦀䬐磤琂冮𨜏䀉橣𪊺䈣蘏𠩯稪𩥇𨫪靕灍匤𢁾鏴盙𨧣龧矝亣俰傼丯众龨吴綋墒壐𡶶庒庙忂𢜒斋"],
      ["8ca1", "𣏹椙橃𣱣泿"],
      ["8ca7", "爀𤔅玌㻛𤨓嬕璹讃𥲤𥚕窓篬糃繬苸薗龩袐龪躹龫迏蕟駠鈡龬𨶹𡐿䁱䊢娚"],
      ["8cc9", "顨杫䉶圽"],
      ["8cce", "藖𤥻芿𧄍䲁𦵴嵻𦬕𦾾龭龮宖龯曧繛湗秊㶈䓃𣉖𢞖䎚䔶"],
      ["8ce6", "峕𣬚諹屸㴒𣕑嵸龲煗䕘𤃬𡸣䱷㥸㑊𠆤𦱁諌侴𠈹妿腬顖𩣺弻"],
      ["8d40", "𠮟"],
      ["8d42", "𢇁𨥭䄂䚻𩁹㼇龳𪆵䃸㟖䛷𦱆䅼𨚲𧏿䕭㣔𥒚䕡䔛䶉䱻䵶䗪㿈𤬏㙡䓞䒽䇭崾嵈嵖㷼㠏嶤嶹㠠㠸幂庽弥徃㤈㤔㤿㥍惗愽峥㦉憷憹懏㦸戬抐拥挘㧸嚱"],
      ["8da1", "㨃揢揻搇摚㩋擀崕嘡龟㪗斆㪽旿晓㫲暒㬢朖㭂枤栀㭘桊梄㭲㭱㭻椉楃牜楤榟榅㮼槖㯝橥橴橱檂㯬檙㯲檫檵櫔櫶殁毁毪汵沪㳋洂洆洦涁㳯涤涱渕渘温溆𨧀溻滢滚齿滨滩漤漴㵆𣽁澁澾㵪㵵熷岙㶊瀬㶑灐灔灯灿炉𠌥䏁㗱𠻘"],
      ["8e40", "𣻗垾𦻓焾𥟠㙎榢𨯩孴穉𥣡𩓙穥穽𥦬窻窰竂竃燑𦒍䇊竚竝竪䇯咲𥰁笋筕笩𥌎𥳾箢筯莜𥮴𦱿篐萡箒箸𥴠㶭𥱥蒒篺簆簵𥳁籄粃𤢂粦晽𤕸糉糇糦籴糳糵糎"],
      ["8ea1", "繧䔝𦹄絝𦻖璍綉綫焵綳緒𤁗𦀩緤㴓緵𡟹緥𨍭縝𦄡𦅚繮纒䌫鑬縧罀罁罇礶𦋐駡羗𦍑羣𡙡𠁨䕜𣝦䔃𨌺翺𦒉者耈耝耨耯𪂇𦳃耻耼聡𢜔䦉𦘦𣷣𦛨朥肧𨩈脇脚墰𢛶汿𦒘𤾸擧𡒊舘𡡞橓𤩥𤪕䑺舩𠬍𦩒𣵾俹𡓽蓢荢𦬊𤦧𣔰𡝳𣷸芪椛芳䇛"],
      ["8f40", "蕋苐茚𠸖𡞴㛁𣅽𣕚艻苢茘𣺋𦶣𦬅𦮗𣗎㶿茝嗬莅䔋𦶥莬菁菓㑾𦻔橗蕚㒖𦹂𢻯葘𥯤葱㷓䓤檧葊𣲵祘蒨𦮖𦹷𦹃蓞萏莑䒠蒓蓤𥲑䉀𥳀䕃蔴嫲𦺙䔧蕳䔖枿蘖"],
      ["8fa1", "𨘥𨘻藁𧂈蘂𡖂𧃍䕫䕪蘨㙈𡢢号𧎚虾蝱𪃸蟮𢰧螱蟚蠏噡虬桖䘏衅衆𧗠𣶹𧗤衞袜䙛袴袵揁装睷𧜏覇覊覦覩覧覼𨨥觧𧤤𧪽誜瞓釾誐𧩙竩𧬺𣾏䜓𧬸煼謌謟𥐰𥕥謿譌譍誩𤩺讐讛誯𡛟䘕衏貛𧵔𧶏貫㜥𧵓賖𧶘𧶽贒贃𡤐賛灜贑𤳉㻐起"],
      ["9040", "趩𨀂𡀔𤦊㭼𨆼𧄌竧躭躶軃鋔輙輭𨍥𨐒辥錃𪊟𠩐辳䤪𨧞𨔽𣶻廸𣉢迹𪀔𨚼𨔁𢌥㦀𦻗逷𨔼𧪾遡𨕬𨘋邨𨜓郄𨛦邮都酧㫰醩釄粬𨤳𡺉鈎沟鉁鉢𥖹銹𨫆𣲛𨬌𥗛"],
      ["90a1", "𠴱錬鍫𨫡𨯫炏嫃𨫢𨫥䥥鉄𨯬𨰹𨯿鍳鑛躼閅閦鐦閠濶䊹𢙺𨛘𡉼𣸮䧟氜陻隖䅬隣𦻕懚隶磵𨫠隽双䦡𦲸𠉴𦐐𩂯𩃥𤫑𡤕𣌊霱虂霶䨏䔽䖅𤫩灵孁霛靜𩇕靗孊𩇫靟鐥僐𣂷𣂼鞉鞟鞱鞾韀韒韠𥑬韮琜𩐳響韵𩐝𧥺䫑頴頳顋顦㬎𧅵㵑𠘰𤅜"],
      ["9140", "𥜆飊颷飈飇䫿𦴧𡛓喰飡飦飬鍸餹𤨩䭲𩡗𩤅駵騌騻騐驘𥜥㛄𩂱𩯕髠髢𩬅髴䰎鬔鬭𨘀倴鬴𦦨㣃𣁽魐魀𩴾婅𡡣鮎𤉋鰂鯿鰌𩹨鷔𩾷𪆒𪆫𪃡𪄣𪇟鵾鶃𪄴鸎梈"],
      ["91a1", "鷄𢅛𪆓𪈠𡤻𪈳鴹𪂹𪊴麐麕麞麢䴴麪麯𤍤黁㭠㧥㴝伲㞾𨰫鼂鼈䮖鐤𦶢鼗鼖鼹嚟嚊齅馸𩂋韲葿齢齩竜龎爖䮾𤥵𤦻煷𤧸𤍈𤩑玞𨯚𡣺禟𨥾𨸶鍩鏳𨩄鋬鎁鏋𨥬𤒹爗㻫睲穃烐𤑳𤏸煾𡟯炣𡢾𣖙㻇𡢅𥐯𡟸㜢𡛻𡠹㛡𡝴𡣑𥽋㜣𡛀坛𤨥𡏾𡊨"],
      ["9240", "𡏆𡒶蔃𣚦蔃葕𤦔𧅥𣸱𥕜𣻻𧁒䓴𣛮𩦝𦼦柹㜳㰕㷧塬𡤢栐䁗𣜿𤃡𤂋𤄏𦰡哋嚞𦚱嚒𠿟𠮨𠸍鏆𨬓鎜仸儫㠙𤐶亼𠑥𠍿佋侊𥙑婨𠆫𠏋㦙𠌊𠐔㐵伩𠋀𨺳𠉵諚𠈌亘"],
      ["92a1", "働儍侢伃𤨎𣺊佂倮偬傁俌俥偘僼兙兛兝兞湶𣖕𣸹𣺿浲𡢄𣺉冨凃𠗠䓝𠒣𠒒𠒑赺𨪜𠜎剙劤𠡳勡鍮䙺熌𤎌𠰠𤦬𡃤槑𠸝瑹㻞璙琔瑖玘䮎𤪼𤂍叐㖄爏𤃉喴𠍅响𠯆圝鉝雴鍦埝垍坿㘾壋媙𨩆𡛺𡝯𡜐娬妸銏婾嫏娒𥥆𡧳𡡡𤊕㛵洅瑃娡𥺃"],
      ["9340", "媁𨯗𠐓鏠璌𡌃焅䥲鐈𨧻鎽㞠尞岞幞幈𡦖𡥼𣫮廍孏𡤃𡤄㜁𡢠㛝𡛾㛓脪𨩇𡶺𣑲𨦨弌弎𡤧𡞫婫𡜻孄蘔𧗽衠恾𢡠𢘫忛㺸𢖯𢖾𩂈𦽳懀𠀾𠁆𢘛憙憘恵𢲛𢴇𤛔𩅍"],
      ["93a1", "摱𤙥𢭪㨩𢬢𣑐𩣪𢹸挷𪑛撶挱揑𤧣𢵧护𢲡搻敫楲㯴𣂎𣊭𤦉𣊫唍𣋠𡣙𩐿曎𣊉𣆳㫠䆐𥖄𨬢𥖏𡛼𥕛𥐥磮𣄃𡠪𣈴㑤𣈏𣆂𤋉暎𦴤晫䮓昰𧡰𡷫晣𣋒𣋡昞𥡲㣑𣠺𣞼㮙𣞢𣏾瓐㮖枏𤘪梶栞㯄檾㡣𣟕𤒇樳橒櫉欅𡤒攑梘橌㯗橺歗𣿀𣲚鎠鋲𨯪𨫋"],
      ["9440", "銉𨀞𨧜鑧涥漋𤧬浧𣽿㶏渄𤀼娽渊塇洤硂焻𤌚𤉶烱牐犇犔𤞏𤜥兹𤪤𠗫瑺𣻸𣙟𤩊𤤗𥿡㼆㺱𤫟𨰣𣼵悧㻳瓌琼鎇琷䒟𦷪䕑疃㽣𤳙𤴆㽘畕癳𪗆㬙瑨𨫌𤦫𤦎㫻"],
      ["94a1", "㷍𤩎㻿𤧅𤣳釺圲鍂𨫣𡡤僟𥈡𥇧睸𣈲眎眏睻𤚗𣞁㩞𤣰琸璛㺿𤪺𤫇䃈𤪖𦆮錇𥖁砞碍碈磒珐祙𧝁𥛣䄎禛蒖禥樭𣻺稺秴䅮𡛦䄲鈵秱𠵌𤦌𠊙𣶺𡝮㖗啫㕰㚪𠇔𠰍竢婙𢛵𥪯𥪜娍𠉛磰娪𥯆竾䇹籝籭䈑𥮳𥺼𥺦糍𤧹𡞰粎籼粮檲緜縇緓罎𦉡"],
      ["9540", "𦅜𧭈綗𥺂䉪𦭵𠤖柖𠁎𣗏埄𦐒𦏸𤥢翝笧𠠬𥫩𥵃笌𥸎駦虅驣樜𣐿㧢𤧷𦖭騟𦖠蒀𧄧𦳑䓪脷䐂胆脉腂𦞴飃𦩂艢艥𦩑葓𦶧蘐𧈛媆䅿𡡀嬫𡢡嫤𡣘蚠蜨𣶏蠭𧐢娂"],
      ["95a1", "衮佅袇袿裦襥襍𥚃襔𧞅𧞄𨯵𨯙𨮜𨧹㺭蒣䛵䛏㟲訽訜𩑈彍鈫𤊄旔焩烄𡡅鵭貟賩𧷜妚矃姰䍮㛔踪躧𤰉輰轊䋴汘澻𢌡䢛潹溋𡟚鯩㚵𤤯邻邗啱䤆醻鐄𨩋䁢𨫼鐧𨰝𨰻蓥訫閙閧閗閖𨴴瑅㻂𤣿𤩂𤏪㻧𣈥随𨻧𨹦𨹥㻌𤧭𤩸𣿮琒瑫㻼靁𩂰"],
      ["9640", "桇䨝𩂓𥟟靝鍨𨦉𨰦𨬯𦎾銺嬑譩䤼珹𤈛鞛靱餸𠼦巁𨯅𤪲頟𩓚鋶𩗗釥䓀𨭐𤩧𨭤飜𨩅㼀鈪䤥萔餻饍𧬆㷽馛䭯馪驜𨭥𥣈檏騡嫾騯𩣱䮐𩥈馼䮽䮗鍽塲𡌂堢𤦸"],
      ["96a1", "𡓨硄𢜟𣶸棅㵽鑘㤧慐𢞁𢥫愇鱏鱓鱻鰵鰐魿鯏𩸭鮟𪇵𪃾鴡䲮𤄄鸘䲰鴌𪆴𪃭𪃳𩤯鶥蒽𦸒𦿟𦮂藼䔳𦶤𦺄𦷰萠藮𦸀𣟗𦁤秢𣖜𣙀䤭𤧞㵢鏛銾鍈𠊿碹鉷鑍俤㑀遤𥕝砽硔碶硋𡝗𣇉𤥁㚚佲濚濙瀞瀞吔𤆵垻壳垊鴖埗焴㒯𤆬燫𦱀𤾗嬨𡞵𨩉"],
      ["9740", "愌嫎娋䊼𤒈㜬䭻𨧼鎻鎸𡣖𠼝葲𦳀𡐓𤋺𢰦𤏁妔𣶷𦝁綨𦅛𦂤𤦹𤦋𨧺鋥珢㻩璴𨭣𡢟㻡𤪳櫘珳珻㻖𤨾𤪔𡟙𤩦𠎧𡐤𤧥瑈𤤖炥𤥶銄珦鍟𠓾錱𨫎𨨖鎆𨯧𥗕䤵𨪂煫"],
      ["97a1", "𤥃𠳿嚤𠘚𠯫𠲸唂秄𡟺緾𡛂𤩐𡡒䔮鐁㜊𨫀𤦭妰𡢿𡢃𧒄媡㛢𣵛㚰鉟婹𨪁𡡢鍴㳍𠪴䪖㦊僴㵩㵌𡎜煵䋻𨈘渏𩃤䓫浗𧹏灧沯㳖𣿭𣸭渂漌㵯𠏵畑㚼㓈䚀㻚䡱姄鉮䤾轁𨰜𦯀堒埈㛖𡑒烾𤍢𤩱𢿣𡊰𢎽梹楧𡎘𣓥𧯴𣛟𨪃𣟖𣏺𤲟樚𣚭𦲷萾䓟䓎"],
      ["9840", "𦴦𦵑𦲂𦿞漗𧄉茽𡜺菭𦲀𧁓𡟛妉媂𡞳婡婱𡤅𤇼㜭姯𡜼㛇熎鎐暚𤊥婮娫𤊓樫𣻹𧜶𤑛𤋊焝𤉙𨧡侰𦴨峂𤓎𧹍𤎽樌𤉖𡌄炦焳𤏩㶥泟勇𤩏繥姫崯㷳彜𤩝𡟟綤萦"],
      ["98a1", "咅𣫺𣌀𠈔坾𠣕𠘙㿥𡾞𪊶瀃𩅛嵰玏糓𨩙𩐠俈翧狍猐𧫴猸猹𥛶獁獈㺩𧬘遬燵𤣲珡臶㻊県㻑沢国琙琞琟㻢㻰㻴㻺瓓㼎㽓畂畭畲疍㽼痈痜㿀癍㿗癴㿜発𤽜熈嘣覀塩䀝睃䀹条䁅㗛瞘䁪䁯属瞾矋売砘点砜䂨砹硇硑硦葈𥔵礳栃礲䄃"],
      ["9940", "䄉禑禙辻稆込䅧窑䆲窼艹䇄竏竛䇏両筢筬筻簒簛䉠䉺类粜䊌粸䊔糭输烀𠳏総緔緐緽羮羴犟䎗耠耥笹耮耱联㷌垴炠肷胩䏭脌猪脎脒畠脔䐁㬹腖腙腚"],
      ["99a1", "䐓堺腼膄䐥膓䐭膥埯臁臤艔䒏芦艶苊苘苿䒰荗险榊萅烵葤惣蒈䔄蒾蓡蓸蔐蔸蕒䔻蕯蕰藠䕷虲蚒蚲蛯际螋䘆䘗袮裿褤襇覑𧥧訩訸誔誴豑賔賲贜䞘塟跃䟭仮踺嗘坔蹱嗵躰䠷軎転軤軭軲辷迁迊迌逳駄䢭飠鈓䤞鈨鉘鉫銱銮銿"],
      ["9a40", "鋣鋫鋳鋴鋽鍃鎄鎭䥅䥑麿鐗匁鐝鐭鐾䥪鑔鑹锭関䦧间阳䧥枠䨤靀䨵鞲韂噔䫤惨颹䬙飱塄餎餙冴餜餷饂饝饢䭰駅䮝騼鬏窃魩鮁鯝鯱鯴䱭鰠㝯𡯂鵉鰺"],
      ["9aa1", "黾噐鶓鶽鷀鷼银辶鹻麬麱麽黆铜黢黱黸竈齄𠂔𠊷𠎠椚铃妬𠓗塀铁㞹𠗕𠘕𠙶𡚺块煳𠫂𠫍𠮿呪吆𠯋咞𠯻𠰻𠱓𠱥𠱼惧𠲍噺𠲵𠳝𠳭𠵯𠶲𠷈楕鰯螥𠸄𠸎𠻗𠾐𠼭𠹳尠𠾼帋𡁜𡁏𡁶朞𡁻𡂈𡂖㙇𡂿𡃓𡄯𡄻卤蒭𡋣𡍵𡌶讁𡕷𡘙𡟃𡟇乸炻𡠭𡥪"],
      ["9b40", "𡨭𡩅𡰪𡱰𡲬𡻈拃𡻕𡼕熘桕𢁅槩㛈𢉼𢏗𢏺𢜪𢡱𢥏苽𢥧𢦓𢫕覥𢫨辠𢬎鞸𢬿顇骽𢱌"],
      ["9b62", "𢲈𢲷𥯨𢴈𢴒𢶷𢶕𢹂𢽴𢿌𣀳𣁦𣌟𣏞徱晈暿𧩹𣕧𣗳爁𤦺矗𣘚𣜖纇𠍆墵朎"],
      ["9ba1", "椘𣪧𧙗𥿢𣸑𣺹𧗾𢂚䣐䪸𤄙𨪚𤋮𤌍𤀻𤌴𤎖𤩅𠗊凒𠘑妟𡺨㮾𣳿𤐄𤓖垈𤙴㦛𤜯𨗨𩧉㝢𢇃譞𨭎駖𤠒𤣻𤨕爉𤫀𠱸奥𤺥𤾆𠝹軚𥀬劏圿煱𥊙𥐙𣽊𤪧喼𥑆𥑮𦭒釔㑳𥔿𧘲𥕞䜘𥕢𥕦𥟇𤤿𥡝偦㓻𣏌惞𥤃䝼𨥈𥪮𥮉𥰆𡶐垡煑澶𦄂𧰒遖𦆲𤾚譢𦐂𦑊"],
      ["9c40", "嵛𦯷輶𦒄𡤜諪𤧶𦒈𣿯𦔒䯀𦖿𦚵𢜛鑥𥟡憕娧晉侻嚹𤔡𦛼乪𤤴陖涏𦲽㘘襷𦞙𦡮𦐑𦡞營𦣇筂𩃀𠨑𦤦鄄𦤹穅鷰𦧺騦𦨭㙟𦑩𠀡禃𦨴𦭛崬𣔙菏𦮝䛐𦲤画补𦶮墶"],
      ["9ca1", "㜜𢖍𧁋𧇍㱔𧊀𧊅銁𢅺𧊋錰𧋦𤧐氹钟𧑐𠻸蠧裵𢤦𨑳𡞱溸𤨪𡠠㦤㚹尐秣䔿暶𩲭𩢤襃𧟌𧡘囖䃟𡘊㦡𣜯𨃨𡏅熭荦𧧝𩆨婧䲷𧂯𨦫𧧽𧨊𧬋𧵦𤅺筃祾𨀉澵𪋟樃𨌘厢𦸇鎿栶靝𨅯𨀣𦦵𡏭𣈯𨁈嶅𨰰𨂃圕頣𨥉嶫𤦈斾槕叒𤪥𣾁㰑朶𨂐𨃴𨄮𡾡𨅏"],
      ["9d40", "𨆉𨆯𨈚𨌆𨌯𨎊㗊𨑨𨚪䣺揦𨥖砈鉕𨦸䏲𨧧䏟𨧨𨭆𨯔姸𨰉輋𨿅𩃬筑𩄐𩄼㷷𩅞𤫊运犏嚋𩓧𩗩𩖰𩖸𩜲𩣑𩥉𩥪𩧃𩨨𩬎𩵚𩶛纟𩻸𩼣䲤镇𪊓熢𪋿䶑递𪗋䶜𠲜达嗁"],
      ["9da1", "辺𢒰边𤪓䔉繿潖檱仪㓤𨬬𧢝㜺躀𡟵𨀤𨭬𨮙𧨾𦚯㷫𧙕𣲷𥘵𥥖亚𥺁𦉘嚿𠹭踎孭𣺈𤲞揞拐𡟶𡡻攰嘭𥱊吚𥌑㷆𩶘䱽嘢嘞罉𥻘奵𣵀蝰东𠿪𠵉𣚺脗鵞贘瘻鱅癎瞹鍅吲腈苷嘥脲萘肽嗪祢噃吖𠺝㗎嘅嗱曱𨋢㘭甴嗰喺咗啲𠱁𠲖廐𥅈𠹶𢱢"],
      ["9e40", "𠺢麫絚嗞𡁵抝靭咔賍燶酶揼掹揾啩𢭃鱲𢺳冚㓟𠶧冧呍唞唓癦踭𦢊疱肶蠄螆裇膶萜𡃁䓬猄𤜆宐茋𦢓噻𢛴𧴯𤆣𧵳𦻐𧊶酰𡇙鈈𣳼𪚩𠺬𠻹牦𡲢䝎𤿂𧿹𠿫䃺"],
      ["9ea1", "鱝攟𢶠䣳𤟠𩵼𠿬𠸊恢𧖣𠿭"],
      ["9ead", "𦁈𡆇熣纎鵐业丄㕷嬍沲卧㚬㧜卽㚥𤘘墚𤭮舭呋垪𥪕𠥹"],
      ["9ec5", "㩒𢑥獴𩺬䴉鯭𣳾𩼰䱛𤾩𩖞𩿞葜𣶶𧊲𦞳𣜠挮紥𣻷𣸬㨪逈勌㹴㙺䗩𠒎癀嫰𠺶硺𧼮墧䂿噼鮋嵴癔𪐴麅䳡痹㟻愙𣃚𤏲"],
      ["9ef5", "噝𡊩垧𤥣𩸆刴𧂮㖭汊鵼"],
      ["9f40", "籖鬹埞𡝬屓擓𩓐𦌵𧅤蚭𠴨𦴢𤫢𠵱"],
      ["9f4f", "凾𡼏嶎霃𡷑麁遌笟鬂峑箣扨挵髿篏鬪籾鬮籂粆鰕篼鬉鼗鰛𤤾齚啳寃俽麘俲剠㸆勑坧偖妷帒韈鶫轜呩鞴饀鞺匬愰"],
      ["9fa1", "椬叚鰊鴂䰻陁榀傦畆𡝭駚剳"],
      ["9fae", "酙隁酜"],
      ["9fb2", "酑𨺗捿𦴣櫊嘑醎畺抅𠏼獏籰𥰡𣳽"],
      ["9fc1", "𤤙盖鮝个𠳔莾衂"],
      ["9fc9", "届槀僭坺刟巵从氱𠇲伹咜哚劚趂㗾弌㗳"],
      ["9fdb", "歒酼龥鮗頮颴骺麨麄煺笔"],
      ["9fe7", "毺蠘罸"],
      ["9feb", "嘠𪙊蹷齓"],
      ["9ff0", "跔蹏鸜踁抂𨍽踨蹵竓𤩷稾磘泪詧瘇"],
      ["a040", "𨩚鼦泎蟖痃𪊲硓咢贌狢獱謭猂瓱賫𤪻蘯徺袠䒷"],
      ["a055", "𡠻𦸅"],
      ["a058", "詾𢔛"],
      ["a05b", "惽癧髗鵄鍮鮏蟵"],
      ["a063", "蠏賷猬霡鮰㗖犲䰇籑饊𦅙慙䰄麖慽"],
      ["a073", "坟慯抦戹拎㩜懢厪𣏵捤栂㗒"],
      ["a0a1", "嵗𨯂迚𨸹"],
      ["a0a6", "僙𡵆礆匲阸𠼻䁥"],
      ["a0ae", "矾"],
      ["a0b0", "糂𥼚糚稭聦聣絍甅瓲覔舚朌聢𧒆聛瓰脃眤覉𦟌畓𦻑螩蟎臈螌詉貭譃眫瓸蓚㘵榲趦"],
      ["a0d4", "覩瑨涹蟁𤀑瓧㷛煶悤憜㳑煢恷"],
      ["a0e2", "罱𨬭牐惩䭾删㰘𣳇𥻗𧙖𥔱𡥄𡋾𩤃𦷜𧂭峁𦆭𨨏𣙷𠃮𦡆𤼎䕢嬟𦍌齐麦𦉫"],
      ["a3c0", "␀", 31, "␡"],
      ["c6a1", "①", 9, "⑴", 9, "ⅰ", 9, "丶丿亅亠冂冖冫勹匸卩厶夊宀巛⼳广廴彐彡攴无疒癶辵隶¨ˆヽヾゝゞ〃仝々〆〇ー［］✽ぁ", 23],
      ["c740", "す", 58, "ァアィイ"],
      ["c7a1", "ゥ", 81, "А", 5, "ЁЖ", 4],
      ["c840", "Л", 26, "ёж", 25, "⇧↸↹㇏𠃌乚𠂊刂䒑"],
      ["c8a1", "龰冈龱𧘇"],
      ["c8cd", "￢￤＇＂㈱№℡゛゜⺀⺄⺆⺇⺈⺊⺌⺍⺕⺜⺝⺥⺧⺪⺬⺮⺶⺼⺾⻆⻊⻌⻍⻏⻖⻗⻞⻣"],
      ["c8f5", "ʃɐɛɔɵœøŋʊɪ"],
      ["f9fe", "￭"],
      ["fa40", "𠕇鋛𠗟𣿅蕌䊵珯况㙉𤥂𨧤鍄𡧛苮𣳈砼杄拟𤤳𨦪𠊠𦮳𡌅侫𢓭倈𦴩𧪄𣘀𤪱𢔓倩𠍾徤𠎀𠍇滛𠐟偽儁㑺儎顬㝃萖𤦤𠒇兠𣎴兪𠯿𢃼𠋥𢔰𠖎𣈳𡦃宂蝽𠖳𣲙冲冸"],
      ["faa1", "鴴凉减凑㳜凓𤪦决凢卂凭菍椾𣜭彻刋刦刼劵剗劔効勅簕蕂勠蘍𦬓包𨫞啉滙𣾀𠥔𣿬匳卄𠯢泋𡜦栛珕恊㺪㣌𡛨燝䒢卭却𨚫卾卿𡖖𡘓矦厓𨪛厠厫厮玧𥝲㽙玜叁叅汉义埾叙㪫𠮏叠𣿫𢶣叶𠱷吓灹唫晗浛呭𦭓𠵴啝咏咤䞦𡜍𠻝㶴𠵍"],
      ["fb40", "𨦼𢚘啇䳭启琗喆喩嘅𡣗𤀺䕒𤐵暳𡂴嘷曍𣊊暤暭噍噏磱囱鞇叾圀囯园𨭦㘣𡉏坆𤆥汮炋坂㚱𦱾埦𡐖堃𡑔𤍣堦𤯵塜墪㕡壠壜𡈼壻寿坃𪅐𤉸鏓㖡够梦㛃湙"],
      ["fba1", "𡘾娤啓𡚒蔅姉𠵎𦲁𦴪𡟜姙𡟻𡞲𦶦浱𡠨𡛕姹𦹅媫婣㛦𤦩婷㜈媖瑥嫓𦾡𢕔㶅𡤑㜲𡚸広勐孶斈孼𧨎䀄䡝𠈄寕慠𡨴𥧌𠖥寳宝䴐尅𡭄尓珎尔𡲥𦬨屉䣝岅峩峯嶋𡷹𡸷崐崘嵆𡺤岺巗苼㠭𤤁𢁉𢅳芇㠶㯂帮檊幵幺𤒼𠳓厦亷廐厨𡝱帉廴𨒂"],
      ["fc40", "廹廻㢠廼栾鐛弍𠇁弢㫞䢮𡌺强𦢈𢏐彘𢑱彣鞽𦹮彲鍀𨨶徧嶶㵟𥉐𡽪𧃸𢙨釖𠊞𨨩怱暅𡡷㥣㷇㘹垐𢞴祱㹀悞悤悳𤦂𤦏𧩓璤僡媠慤萤慂慈𦻒憁凴𠙖憇宪𣾷"],
      ["fca1", "𢡟懓𨮝𩥝懐㤲𢦀𢣁怣慜攞掋𠄘担𡝰拕𢸍捬𤧟㨗搸揸𡎎𡟼撐澊𢸶頔𤂌𥜝擡擥鑻㩦携㩗敍漖𤨨𤨣斅敭敟𣁾斵𤥀䬷旑䃘𡠩无旣忟𣐀昘𣇷𣇸晄𣆤𣆥晋𠹵晧𥇦晳晴𡸽𣈱𨗴𣇈𥌓矅𢣷馤朂𤎜𤨡㬫槺𣟂杞杧杢𤇍𩃭柗䓩栢湐鈼栁𣏦𦶠桝"],
      ["fd40", "𣑯槡樋𨫟楳棃𣗍椁椀㴲㨁𣘼㮀枬楡𨩊䋼椶榘㮡𠏉荣傐槹𣙙𢄪橅𣜃檝㯳枱櫈𩆜㰍欝𠤣惞欵歴𢟍溵𣫛𠎵𡥘㝀吡𣭚毡𣻼毜氷𢒋𤣱𦭑汚舦汹𣶼䓅𣶽𤆤𤤌𤤀"],
      ["fda1", "𣳉㛥㳫𠴲鮃𣇹𢒑羏样𦴥𦶡𦷫涖浜湼漄𤥿𤂅𦹲蔳𦽴凇沜渝萮𨬡港𣸯瑓𣾂秌湏媑𣁋濸㜍澝𣸰滺𡒗𤀽䕕鏰潄潜㵎潴𩅰㴻澟𤅄濓𤂑𤅕𤀹𣿰𣾴𤄿凟𤅖𤅗𤅀𦇝灋灾炧炁烌烕烖烟䄄㷨熴熖𤉷焫煅媈煊煮岜𤍥煏鍢𤋁焬𤑚𤨧𤨢熺𨯨炽爎"],
      ["fe40", "鑂爕夑鑃爤鍁𥘅爮牀𤥴梽牕牗㹕𣁄栍漽犂猪猫𤠣𨠫䣭𨠄猨献珏玪𠰺𦨮珉瑉𤇢𡛧𤨤昣㛅𤦷𤦍𤧻珷琕椃𤨦琹𠗃㻗瑜𢢭瑠𨺲瑇珤瑶莹瑬㜰瑴鏱樬璂䥓𤪌"],
      ["fea1", "𤅟𤩹𨮏孆𨰃𡢞瓈𡦈甎瓩甞𨻙𡩋寗𨺬鎅畍畊畧畮𤾂㼄𤴓疎瑝疞疴瘂瘬癑癏癯癶𦏵皐臯㟸𦤑𦤎皡皥皷盌𦾟葢𥂝𥅽𡸜眞眦着撯𥈠睘𣊬瞯𨥤𨥨𡛁矴砉𡍶𤨒棊碯磇磓隥礮𥗠磗礴碱𧘌辸袄𨬫𦂃𢘜禆褀椂禀𥡗禝𧬹礼禩渪𧄦㺨秆𩄍秔"]
    ];
  }
});

// node_modules/iconv-lite/encodings/dbcs-data.js
var require_dbcs_data = __commonJS({
  "node_modules/iconv-lite/encodings/dbcs-data.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      // == Japanese/ShiftJIS ====================================================
      // All japanese encodings are based on JIS X set of standards:
      // JIS X 0201 - Single-byte encoding of ASCII + ¥ + Kana chars at 0xA1-0xDF.
      // JIS X 0208 - Main set of 6879 characters, placed in 94x94 plane, to be encoded by 2 bytes.
      //              Has several variations in 1978, 1983, 1990 and 1997.
      // JIS X 0212 - Supplementary plane of 6067 chars in 94x94 plane. 1990. Effectively dead.
      // JIS X 0213 - Extension and modern replacement of 0208 and 0212. Total chars: 11233.
      //              2 planes, first is superset of 0208, second - revised 0212.
      //              Introduced in 2000, revised 2004. Some characters are in Unicode Plane 2 (0x2xxxx)
      // Byte encodings are:
      //  * Shift_JIS: Compatible with 0201, uses not defined chars in top half as lead bytes for double-byte
      //               encoding of 0208. Lead byte ranges: 0x81-0x9F, 0xE0-0xEF; Trail byte ranges: 0x40-0x7E, 0x80-0x9E, 0x9F-0xFC.
      //               Windows CP932 is a superset of Shift_JIS. Some companies added more chars, notably KDDI.
      //  * EUC-JP:    Up to 3 bytes per character. Used mostly on *nixes.
      //               0x00-0x7F       - lower part of 0201
      //               0x8E, 0xA1-0xDF - upper part of 0201
      //               (0xA1-0xFE)x2   - 0208 plane (94x94).
      //               0x8F, (0xA1-0xFE)x2 - 0212 plane (94x94).
      //  * JIS X 208: 7-bit, direct encoding of 0208. Byte ranges: 0x21-0x7E (94 values). Uncommon.
      //               Used as-is in ISO2022 family.
      //  * ISO2022-JP: Stateful encoding, with escape sequences to switch between ASCII,
      //                0201-1976 Roman, 0208-1978, 0208-1983.
      //  * ISO2022-JP-1: Adds esc seq for 0212-1990.
      //  * ISO2022-JP-2: Adds esc seq for GB2313-1980, KSX1001-1992, ISO8859-1, ISO8859-7.
      //  * ISO2022-JP-3: Adds esc seq for 0201-1976 Kana set, 0213-2000 Planes 1, 2.
      //  * ISO2022-JP-2004: Adds 0213-2004 Plane 1.
      //
      // After JIS X 0213 appeared, Shift_JIS-2004, EUC-JISX0213 and ISO2022-JP-2004 followed, with just changing the planes.
      //
      // Overall, it seems that it's a mess :( http://www8.plala.or.jp/tkubota1/unicode-symbols-map2.html
      shiftjis: {
        type: "_dbcs",
        table: function() {
          return require_shiftjis();
        },
        encodeAdd: { "¥": 92, "‾": 126 },
        encodeSkipVals: [{ from: 60736, to: 63808 }]
      },
      csshiftjis: "shiftjis",
      mskanji: "shiftjis",
      sjis: "shiftjis",
      windows31j: "shiftjis",
      ms31j: "shiftjis",
      xsjis: "shiftjis",
      windows932: "shiftjis",
      ms932: "shiftjis",
      932: "shiftjis",
      cp932: "shiftjis",
      eucjp: {
        type: "_dbcs",
        table: function() {
          return require_eucjp();
        },
        encodeAdd: { "¥": 92, "‾": 126 }
      },
      // TODO: KDDI extension to Shift_JIS
      // TODO: IBM CCSID 942 = CP932, but F0-F9 custom chars and other char changes.
      // TODO: IBM CCSID 943 = Shift_JIS = CP932 with original Shift_JIS lower 128 chars.
      // == Chinese/GBK ==========================================================
      // http://en.wikipedia.org/wiki/GBK
      // We mostly implement W3C recommendation: https://www.w3.org/TR/encoding/#gbk-encoder
      // Oldest GB2312 (1981, ~7600 chars) is a subset of CP936
      gb2312: "cp936",
      gb231280: "cp936",
      gb23121980: "cp936",
      csgb2312: "cp936",
      csiso58gb231280: "cp936",
      euccn: "cp936",
      // Microsoft's CP936 is a subset and approximation of GBK.
      windows936: "cp936",
      ms936: "cp936",
      936: "cp936",
      cp936: {
        type: "_dbcs",
        table: function() {
          return require_cp936();
        }
      },
      // GBK (~22000 chars) is an extension of CP936 that added user-mapped chars and some other.
      gbk: {
        type: "_dbcs",
        table: function() {
          return require_cp936().concat(require_gbk_added());
        }
      },
      xgbk: "gbk",
      isoir58: "gbk",
      // GB18030 is an algorithmic extension of GBK.
      // Main source: https://www.w3.org/TR/encoding/#gbk-encoder
      // http://icu-project.org/docs/papers/gb18030.html
      // http://source.icu-project.org/repos/icu/data/trunk/charset/data/xml/gb-18030-2000.xml
      // http://www.khngai.com/chinese/charmap/tblgbk.php?page=0
      gb18030: {
        type: "_dbcs",
        table: function() {
          return require_cp936().concat(require_gbk_added());
        },
        gb18030: function() {
          return require_gb18030_ranges();
        },
        encodeSkipVals: [128],
        encodeAdd: { "€": 41699 }
      },
      chinese: "gb18030",
      // == Korean ===============================================================
      // EUC-KR, KS_C_5601 and KS X 1001 are exactly the same.
      windows949: "cp949",
      ms949: "cp949",
      949: "cp949",
      cp949: {
        type: "_dbcs",
        table: function() {
          return require_cp949();
        }
      },
      cseuckr: "cp949",
      csksc56011987: "cp949",
      euckr: "cp949",
      isoir149: "cp949",
      korean: "cp949",
      ksc56011987: "cp949",
      ksc56011989: "cp949",
      ksc5601: "cp949",
      // == Big5/Taiwan/Hong Kong ================================================
      // There are lots of tables for Big5 and cp950. Please see the following links for history:
      // http://moztw.org/docs/big5/  http://www.haible.de/bruno/charsets/conversion-tables/Big5.html
      // Variations, in roughly number of defined chars:
      //  * Windows CP 950: Microsoft variant of Big5. Canonical: http://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP950.TXT
      //  * Windows CP 951: Microsoft variant of Big5-HKSCS-2001. Seems to be never public. http://me.abelcheung.org/articles/research/what-is-cp951/
      //  * Big5-2003 (Taiwan standard) almost superset of cp950.
      //  * Unicode-at-on (UAO) / Mozilla 1.8. Falling out of use on the Web. Not supported by other browsers.
      //  * Big5-HKSCS (-2001, -2004, -2008). Hong Kong standard.
      //    many unicode code points moved from PUA to Supplementary plane (U+2XXXX) over the years.
      //    Plus, it has 4 combining sequences.
      //    Seems that Mozilla refused to support it for 10 yrs. https://bugzilla.mozilla.org/show_bug.cgi?id=162431 https://bugzilla.mozilla.org/show_bug.cgi?id=310299
      //    because big5-hkscs is the only encoding to include astral characters in non-algorithmic way.
      //    Implementations are not consistent within browsers; sometimes labeled as just big5.
      //    MS Internet Explorer switches from big5 to big5-hkscs when a patch applied.
      //    Great discussion & recap of what's going on https://bugzilla.mozilla.org/show_bug.cgi?id=912470#c31
      //    In the encoder, it might make sense to support encoding old PUA mappings to Big5 bytes seq-s.
      //    Official spec: http://www.ogcio.gov.hk/en/business/tech_promotion/ccli/terms/doc/2003cmp_2008.txt
      //                   http://www.ogcio.gov.hk/tc/business/tech_promotion/ccli/terms/doc/hkscs-2008-big5-iso.txt
      //
      // Current understanding of how to deal with Big5(-HKSCS) is in the Encoding Standard, http://encoding.spec.whatwg.org/#big5-encoder
      // Unicode mapping (http://www.unicode.org/Public/MAPPINGS/OBSOLETE/EASTASIA/OTHER/BIG5.TXT) is said to be wrong.
      windows950: "cp950",
      ms950: "cp950",
      950: "cp950",
      cp950: {
        type: "_dbcs",
        table: function() {
          return require_cp950();
        }
      },
      // Big5 has many variations and is an extension of cp950. We use Encoding Standard's as a consensus.
      big5: "big5hkscs",
      big5hkscs: {
        type: "_dbcs",
        table: function() {
          return require_cp950().concat(require_big5_added());
        },
        encodeSkipVals: [
          // Although Encoding Standard says we should avoid encoding to HKSCS area (See Step 1 of
          // https://encoding.spec.whatwg.org/#index-big5-pointer), we still do it to increase compatibility with ICU.
          // But if a single unicode point can be encoded both as HKSCS and regular Big5, we prefer the latter.
          36457,
          36463,
          36478,
          36523,
          36532,
          36557,
          36560,
          36695,
          36713,
          36718,
          36811,
          36862,
          36973,
          36986,
          37060,
          37084,
          37105,
          37311,
          37551,
          37552,
          37553,
          37554,
          37585,
          37959,
          38090,
          38361,
          38652,
          39285,
          39798,
          39800,
          39803,
          39878,
          39902,
          39916,
          39926,
          40002,
          40019,
          40034,
          40040,
          40043,
          40055,
          40124,
          40125,
          40144,
          40279,
          40282,
          40388,
          40431,
          40443,
          40617,
          40687,
          40701,
          40800,
          40907,
          41079,
          41180,
          41183,
          36812,
          37576,
          38468,
          38637,
          // Step 2 of https://encoding.spec.whatwg.org/#index-big5-pointer: Use last pointer for U+2550, U+255E, U+2561, U+256A, U+5341, or U+5345
          41636,
          41637,
          41639,
          41638,
          41676,
          41678
        ]
      },
      cnbig5: "big5hkscs",
      csbig5: "big5hkscs",
      xxbig5: "big5hkscs"
    };
  }
});

// node_modules/iconv-lite/encodings/index.js
var require_encodings = __commonJS({
  "node_modules/iconv-lite/encodings/index.js"(exports2, module2) {
    "use strict";
    var mergeModules = require_merge_exports();
    var modules = [
      require_internal(),
      require_utf32(),
      require_utf16(),
      require_utf7(),
      require_sbcs_codec(),
      require_sbcs_data(),
      require_sbcs_data_generated(),
      require_dbcs_codec(),
      require_dbcs_data()
    ];
    for (i = 0; i < modules.length; i++) {
      module2 = modules[i];
      mergeModules(exports2, module2);
    }
    var module2;
    var i;
  }
});

// node_modules/iconv-lite/lib/streams.js
var require_streams = __commonJS({
  "node_modules/iconv-lite/lib/streams.js"(exports2, module2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    module2.exports = function(streamModule) {
      var Transform = streamModule.Transform;
      function IconvLiteEncoderStream(conv, options) {
        this.conv = conv;
        options = options || {};
        options.decodeStrings = false;
        Transform.call(this, options);
      }
      IconvLiteEncoderStream.prototype = Object.create(Transform.prototype, {
        constructor: { value: IconvLiteEncoderStream }
      });
      IconvLiteEncoderStream.prototype._transform = function(chunk, encoding, done) {
        if (typeof chunk !== "string") {
          return done(new Error("Iconv encoding stream needs strings as its input."));
        }
        try {
          var res = this.conv.write(chunk);
          if (res && res.length)
            this.push(res);
          done();
        } catch (e) {
          done(e);
        }
      };
      IconvLiteEncoderStream.prototype._flush = function(done) {
        try {
          var res = this.conv.end();
          if (res && res.length)
            this.push(res);
          done();
        } catch (e) {
          done(e);
        }
      };
      IconvLiteEncoderStream.prototype.collect = function(cb) {
        var chunks = [];
        this.on("error", cb);
        this.on("data", function(chunk) {
          chunks.push(chunk);
        });
        this.on("end", function() {
          cb(null, Buffer2.concat(chunks));
        });
        return this;
      };
      function IconvLiteDecoderStream(conv, options) {
        this.conv = conv;
        options = options || {};
        options.encoding = this.encoding = "utf8";
        Transform.call(this, options);
      }
      IconvLiteDecoderStream.prototype = Object.create(Transform.prototype, {
        constructor: { value: IconvLiteDecoderStream }
      });
      IconvLiteDecoderStream.prototype._transform = function(chunk, encoding, done) {
        if (!Buffer2.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
          return done(new Error("Iconv decoding stream needs buffers as its input."));
        }
        try {
          var res = this.conv.write(chunk);
          if (res && res.length)
            this.push(res, this.encoding);
          done();
        } catch (e) {
          done(e);
        }
      };
      IconvLiteDecoderStream.prototype._flush = function(done) {
        try {
          var res = this.conv.end();
          if (res && res.length)
            this.push(res, this.encoding);
          done();
        } catch (e) {
          done(e);
        }
      };
      IconvLiteDecoderStream.prototype.collect = function(cb) {
        var res = "";
        this.on("error", cb);
        this.on("data", function(chunk) {
          res += chunk;
        });
        this.on("end", function() {
          cb(null, res);
        });
        return this;
      };
      return {
        IconvLiteEncoderStream,
        IconvLiteDecoderStream
      };
    };
  }
});

// node_modules/iconv-lite/lib/index.js
var require_lib = __commonJS({
  "node_modules/iconv-lite/lib/index.js"(exports2, module2) {
    "use strict";
    var Buffer2 = require_safer().Buffer;
    var bomHandling = require_bom_handling();
    var mergeModules = require_merge_exports();
    module2.exports.encodings = null;
    module2.exports.defaultCharUnicode = "�";
    module2.exports.defaultCharSingleByte = "?";
    module2.exports.encode = function encode(str, encoding, options) {
      str = "" + (str || "");
      var encoder = module2.exports.getEncoder(encoding, options);
      var res = encoder.write(str);
      var trail = encoder.end();
      return trail && trail.length > 0 ? Buffer2.concat([res, trail]) : res;
    };
    module2.exports.decode = function decode(buf, encoding, options) {
      if (typeof buf === "string") {
        if (!module2.exports.skipDecodeWarning) {
          console.error("Iconv-lite warning: decode()-ing strings is deprecated. Refer to https://github.com/ashtuchkin/iconv-lite/wiki/Use-Buffers-when-decoding");
          module2.exports.skipDecodeWarning = true;
        }
        buf = Buffer2.from("" + (buf || ""), "binary");
      }
      var decoder = module2.exports.getDecoder(encoding, options);
      var res = decoder.write(buf);
      var trail = decoder.end();
      return trail ? res + trail : res;
    };
    module2.exports.encodingExists = function encodingExists(enc) {
      try {
        module2.exports.getCodec(enc);
        return true;
      } catch (e) {
        return false;
      }
    };
    module2.exports.toEncoding = module2.exports.encode;
    module2.exports.fromEncoding = module2.exports.decode;
    module2.exports._codecDataCache = { __proto__: null };
    module2.exports.getCodec = function getCodec(encoding) {
      if (!module2.exports.encodings) {
        var raw = require_encodings();
        module2.exports.encodings = { __proto__: null };
        mergeModules(module2.exports.encodings, raw);
      }
      var enc = module2.exports._canonicalizeEncoding(encoding);
      var codecOptions = {};
      while (true) {
        var codec = module2.exports._codecDataCache[enc];
        if (codec) {
          return codec;
        }
        var codecDef = module2.exports.encodings[enc];
        switch (typeof codecDef) {
          case "string":
            enc = codecDef;
            break;
          case "object":
            for (var key in codecDef) {
              codecOptions[key] = codecDef[key];
            }
            if (!codecOptions.encodingName) {
              codecOptions.encodingName = enc;
            }
            enc = codecDef.type;
            break;
          case "function":
            if (!codecOptions.encodingName) {
              codecOptions.encodingName = enc;
            }
            codec = new codecDef(codecOptions, module2.exports);
            module2.exports._codecDataCache[codecOptions.encodingName] = codec;
            return codec;
          default:
            throw new Error("Encoding not recognized: '" + encoding + "' (searched as: '" + enc + "')");
        }
      }
    };
    module2.exports._canonicalizeEncoding = function(encoding) {
      return ("" + encoding).toLowerCase().replace(/:\d{4}$|[^0-9a-z]/g, "");
    };
    module2.exports.getEncoder = function getEncoder(encoding, options) {
      var codec = module2.exports.getCodec(encoding);
      var encoder = new codec.encoder(options, codec);
      if (codec.bomAware && options && options.addBOM) {
        encoder = new bomHandling.PrependBOM(encoder, options);
      }
      return encoder;
    };
    module2.exports.getDecoder = function getDecoder(encoding, options) {
      var codec = module2.exports.getCodec(encoding);
      var decoder = new codec.decoder(options, codec);
      if (codec.bomAware && !(options && options.stripBOM === false)) {
        decoder = new bomHandling.StripBOM(decoder, options);
      }
      return decoder;
    };
    module2.exports.enableStreamingAPI = function enableStreamingAPI(streamModule2) {
      if (module2.exports.supportsStreams) {
        return;
      }
      var streams = require_streams()(streamModule2);
      module2.exports.IconvLiteEncoderStream = streams.IconvLiteEncoderStream;
      module2.exports.IconvLiteDecoderStream = streams.IconvLiteDecoderStream;
      module2.exports.encodeStream = function encodeStream(encoding, options) {
        return new module2.exports.IconvLiteEncoderStream(module2.exports.getEncoder(encoding, options), options);
      };
      module2.exports.decodeStream = function decodeStream(encoding, options) {
        return new module2.exports.IconvLiteDecoderStream(module2.exports.getDecoder(encoding, options), options);
      };
      module2.exports.supportsStreams = true;
    };
    var streamModule;
    try {
      streamModule = require("stream");
    } catch (e) {
    }
    if (streamModule && streamModule.Transform) {
      module2.exports.enableStreamingAPI(streamModule);
    } else {
      module2.exports.encodeStream = module2.exports.decodeStream = function() {
        throw new Error("iconv-lite Streaming API is not enabled. Use iconv.enableStreamingAPI(require('stream')); to enable it.");
      };
    }
    if (false) {
      console.error("iconv-lite warning: js files use non-utf8 encoding. See https://github.com/ashtuchkin/iconv-lite/wiki/Javascript-source-file-encodings for more info.");
    }
  }
});

// src/vendor/musicSdk/kw/util.js
var require_util = __commonJS({
  "src/vendor/musicSdk/kw/util.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.wbdCrypto = exports2.lrcTools = exports2.decodeLyric = exports2.matchToken = exports2.formatPic = exports2.formatSinger = exports2.objStr2JSON = void 0;
    var crypto_1 = require("crypto");
    var utils_1 = require_utils();
    var zlib_1 = require("zlib");
    var iconv_lite_1 = __importDefault(require_lib());
    var objStr2JSON = (str) => {
      return JSON.parse(str.replace(/('(?=(,\s*')))|('(?=:))|((?<=([:,]\s*))')|((?<={)')|('(?=}))/g, '"'));
    };
    exports2.objStr2JSON = objStr2JSON;
    var formatSinger = (rawData) => rawData.replace(/&/g, "、");
    exports2.formatSinger = formatSinger;
    var formatPic = (url, size = 1e3) => {
      if (!url)
        return url;
      return url.replace(/(\/star\/albumcover\/)\d+/, `$1${size}`).replace(/(pictype=)\d+/, `$1${size}`).replace(/(size=)\d+/, `$1${size}`);
    };
    exports2.formatPic = formatPic;
    var matchToken = (headers) => {
      try {
        return headers["set-cookie"][0].match(/kw_token=(\w+)/)[1];
      } catch (err) {
        return null;
      }
    };
    exports2.matchToken = matchToken;
    var handleInflate = async (data) => {
      return new Promise((resolve, reject) => {
        (0, zlib_1.inflate)(data, (err, result) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(result);
        });
      });
    };
    var buf_key = Buffer.from("yeelion");
    var buf_key_len = buf_key.length;
    var decodeLyricInternal = async (buf, isGetLyricx) => {
      if (buf.toString("utf8", 0, 10) != "tp=content")
        return "";
      const lrcData = await handleInflate(buf.subarray(buf.indexOf("\r\n\r\n") + 4));
      if (!isGetLyricx)
        return iconv_lite_1.default.decode(lrcData, "gb18030");
      const buf_str = Buffer.from(lrcData.toString(), "base64");
      const buf_str_len = buf_str.length;
      const output = new Uint8Array(buf_str_len);
      let i = 0;
      while (i < buf_str_len) {
        let j = 0;
        while (j < buf_key_len && i < buf_str_len) {
          output[i] = buf_str[i] ^ buf_key[j];
          i++;
          j++;
        }
      }
      return iconv_lite_1.default.decode(Buffer.from(output), "gb18030");
    };
    var decodeLyric = async ({ lrcBase64, isGetLyricx }) => {
      const lrc = await decodeLyricInternal(Buffer.from(lrcBase64, "base64"), isGetLyricx);
      return Buffer.from(lrc).toString("base64");
    };
    exports2.decodeLyric = decodeLyric;
    exports2.lrcTools = {
      rxps: {
        wordLine: /^(\[\d{1,2}:.*\d{1,4}\])\s*(\S+(?:\s+\S+)*)?\s*/,
        tagLine: /\[(ver|ti|ar|al|offset|by|kuwo):\s*(\S+(?:\s+\S+)*)\s*\]/,
        wordTimeAll: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g,
        wordTime: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/
      },
      offset: 1,
      offset2: 1,
      isOK: false,
      lines: [],
      tags: [],
      getWordInfo(str, str2, prevWord) {
        const offset = parseInt(str);
        const offset2 = parseInt(str2);
        let startTime = Math.abs((offset + offset2) / (this.offset * 2));
        let endTime = Math.abs((offset - offset2) / (this.offset2 * 2)) + startTime;
        if (prevWord) {
          if (startTime < prevWord.endTime) {
            prevWord.endTime = startTime;
            if (prevWord.startTime > prevWord.endTime) {
              prevWord.startTime = prevWord.endTime;
            }
            prevWord.newTimeStr = `<${prevWord.startTime},${prevWord.endTime - prevWord.startTime}>`;
          }
        }
        return {
          startTime,
          endTime,
          timeStr: `<${startTime},${endTime - startTime}>`
        };
      },
      parseLine(line) {
        if (line.length < 6)
          return;
        let result = this.rxps.wordLine.exec(line);
        if (result) {
          const time = result[1];
          let words = result[2];
          if (words == null) {
            words = "";
          }
          const wordTimes = words.match(this.rxps.wordTimeAll);
          if (!wordTimes)
            return;
          let preTimeInfo;
          for (const timeStr of wordTimes) {
            const result2 = this.rxps.wordTime.exec(timeStr);
            const wordInfo = this.getWordInfo(result2[1], result2[2], preTimeInfo);
            words = words.replace(timeStr, wordInfo.timeStr);
            if (preTimeInfo?.newTimeStr)
              words = words.replace(preTimeInfo.timeStr, preTimeInfo.newTimeStr);
            preTimeInfo = wordInfo;
          }
          this.lines.push(time + words);
          return;
        }
        result = this.rxps.tagLine.exec(line);
        if (!result)
          return;
        if (result[1] == "kuwo") {
          let content = result[2];
          if (content != null && content.includes("][")) {
            content = content.substring(0, content.indexOf("]["));
          }
          const valueOf = parseInt(content, 8);
          this.offset = Math.trunc(valueOf / 10);
          this.offset2 = Math.trunc(valueOf % 10);
          if (this.offset == 0 || Number.isNaN(this.offset) || this.offset2 == 0 || Number.isNaN(this.offset2)) {
            this.isOK = false;
          }
        } else {
          this.tags.push(line);
        }
      },
      parse(lrc) {
        const lines = lrc.split(/\r\n|\r|\n/);
        const tools = Object.create(this);
        tools.isOK = true;
        tools.offset = 1;
        tools.offset2 = 1;
        tools.lines = [];
        tools.tags = [];
        for (const line of lines) {
          if (!tools.isOK)
            throw new Error("failed");
          tools.parseLine(line);
        }
        if (!tools.lines.length)
          return "";
        let lrcs = tools.lines.join("\n");
        if (tools.tags.length)
          lrcs = `${tools.tags.join("\n")}
${lrcs}`;
        return lrcs;
      }
    };
    var createAesEncrypt = (buffer, mode, key, iv) => {
      const cipher = (0, crypto_1.createCipheriv)(mode, key, iv);
      return Buffer.concat([cipher.update(buffer), cipher.final()]);
    };
    var createAesDecrypt = (buffer, mode, key, iv) => {
      const cipher = (0, crypto_1.createDecipheriv)(mode, key, iv);
      return Buffer.concat([cipher.update(buffer), cipher.final()]);
    };
    exports2.wbdCrypto = {
      aesMode: "aes-128-ecb",
      aesKey: Buffer.from([112, 87, 39, 61, 199, 250, 41, 191, 57, 68, 45, 114, 221, 94, 140, 228], "binary"),
      aesIv: "",
      appId: "y67sprxhhpws",
      decodeData(base64Result) {
        const data = Buffer.from(decodeURIComponent(base64Result), "base64");
        return JSON.parse(createAesDecrypt(data, this.aesMode, this.aesKey, this.aesIv).toString());
      },
      createSign(data, time) {
        const str = `${this.appId}${data}${time}`;
        return (0, utils_1.toMD5)(str).toUpperCase();
      },
      buildParam(jsonData) {
        const data = Buffer.from(JSON.stringify(jsonData));
        const time = Date.now();
        const encodeData = createAesEncrypt(data, this.aesMode, this.aesKey, this.aesIv).toString("base64");
        const sign = this.createSign(encodeData, time);
        return `data=${encodeURIComponent(encodeData)}&time=${time}&appId=${this.appId}&sign=${sign}`;
      }
    };
  }
});

// src/vendor/musicSdk/kw/musicSearch.js
var require_musicSearch = __commonJS({
  "src/vendor/musicSdk/kw/musicSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var util_1 = require_util();
    exports2.default = {
      regExps: {
        mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/
      },
      limit: 30,
      total: 0,
      page: 0,
      allPage: 1,
      // cancelFn: null,
      musicSearch(str, page, limit) {
        const musicSearchRequestObj = (0, request_1.httpFetch)(`http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`);
        return musicSearchRequestObj.promise;
      },
      // getImg(songId) {
      //   return httpGet(`http://player.kuwo.cn/webmusic/sj/dtflagdate?flag=6&rid=MUSIC_${songId}`)
      // },
      // getLrc(songId) {
      //   return httpGet(`http://mobile.kuwo.cn/mpage/html5/songinfoandlrc?mid=${songId}&flag=0`)
      // },
      handleResult(rawData) {
        const result = [];
        if (!rawData)
          return result;
        for (let i = 0; i < rawData.length; i++) {
          const info = rawData[i];
          let songId = info.MUSICRID.replace("MUSIC_", "");
          if (!info.N_MINFO) {
            console.log("N_MINFO is undefined");
            return null;
          }
          const types = [];
          const _types = {};
          let infoArr = info.N_MINFO.split(";");
          for (let info2 of infoArr) {
            info2 = info2.match(this.regExps.mInfo);
            if (info2) {
              switch (info2[2]) {
                case "4000":
                  types.push({ type: "flac24bit", size: info2[4] });
                  _types.flac24bit = {
                    size: info2[4].toLocaleUpperCase()
                  };
                  break;
                case "2000":
                  types.push({ type: "flac", size: info2[4] });
                  _types.flac = {
                    size: info2[4].toLocaleUpperCase()
                  };
                  break;
                case "320":
                  types.push({ type: "320k", size: info2[4] });
                  _types["320k"] = {
                    size: info2[4].toLocaleUpperCase()
                  };
                  break;
                case "128":
                  types.push({ type: "128k", size: info2[4] });
                  _types["128k"] = {
                    size: info2[4].toLocaleUpperCase()
                  };
                  break;
              }
            }
          }
          types.reverse();
          let interval = parseInt(info.DURATION);
          result.push({
            name: (0, index_1.decodeName)(info.SONGNAME),
            singer: (0, util_1.formatSinger)((0, index_1.decodeName)(info.ARTIST)),
            source: "kw",
            // img = (info.album.name === '' || info.album.name === '空')
            //   ? `http://player.kuwo.cn/webmusic/sj/dtflagdate?flag=6&rid=MUSIC_160911.jpg`
            //   : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${info.album.mid}.jpg`
            songmid: songId,
            albumId: (0, index_1.decodeName)(info.ALBUMID || ""),
            interval: Number.isNaN(interval) ? 0 : (0, index_1.formatPlayTime)(interval),
            albumName: info.ALBUM ? (0, index_1.decodeName)(info.ALBUM) : "",
            lrc: null,
            img: (0, util_1.formatPic)(info.prob_albumpic || (info.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/1000${info.web_albumpic_short}` : null)),
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          });
        }
        return result;
      },
      search(str, page = 1, limit, retryNum = 0) {
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        if (limit == null)
          limit = this.limit;
        return this.musicSearch(str, page, limit).then(({ body: result }) => {
          if (!result || result.TOTAL !== "0" && result.SHOW === "0")
            return this.search(str, page, limit, ++retryNum);
          let list = this.handleResult(result.abslist);
          if (list == null)
            return this.search(str, page, limit, ++retryNum);
          this.total = parseInt(result.TOTAL);
          this.page = page;
          this.allPage = Math.ceil(this.total / limit);
          return Promise.resolve({
            list,
            allPage: this.allPage,
            total: this.total,
            limit,
            source: "kw"
          });
        });
      }
    };
  }
});

// src/vendor/musicSdk/kw/leaderboard.js
var require_leaderboard = __commonJS({
  "src/vendor/musicSdk/kw/leaderboard.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var util_1 = require_util();
    var boardList = [{ id: "kw__93", name: "飙升榜", bangid: "93" }, { id: "kw__17", name: "新歌榜", bangid: "17" }, { id: "kw__16", name: "热歌榜", bangid: "16" }, { id: "kw__158", name: "抖音热歌榜", bangid: "158" }, { id: "kw__292", name: "铃声榜", bangid: "292" }, { id: "kw__284", name: "热评榜", bangid: "284" }, { id: "kw__290", name: "ACG新歌榜", bangid: "290" }, { id: "kw__286", name: "台湾KKBOX榜", bangid: "286" }, { id: "kw__279", name: "冬日暖心榜", bangid: "279" }, { id: "kw__281", name: "巴士随身听榜", bangid: "281" }, { id: "kw__255", name: "KTV点唱榜", bangid: "255" }, { id: "kw__280", name: "家务进行曲榜", bangid: "280" }, { id: "kw__282", name: "熬夜修仙榜", bangid: "282" }, { id: "kw__283", name: "枕边轻音乐榜", bangid: "283" }, { id: "kw__278", name: "古风音乐榜", bangid: "278" }, { id: "kw__264", name: "Vlog音乐榜", bangid: "264" }, { id: "kw__242", name: "电音榜", bangid: "242" }, { id: "kw__187", name: "流行趋势榜", bangid: "187" }, { id: "kw__204", name: "现场音乐榜", bangid: "204" }, { id: "kw__186", name: "ACG神曲榜", bangid: "186" }, { id: "kw__185", name: "最强翻唱榜", bangid: "185" }, { id: "kw__26", name: "经典怀旧榜", bangid: "26" }, { id: "kw__104", name: "华语榜", bangid: "104" }, { id: "kw__182", name: "粤语榜", bangid: "182" }, { id: "kw__22", name: "欧美榜", bangid: "22" }, { id: "kw__184", name: "韩语榜", bangid: "184" }, { id: "kw__183", name: "日语榜", bangid: "183" }, { id: "kw__145", name: "会员畅听榜", bangid: "145" }, { id: "kw__153", name: "网红新歌榜", bangid: "153" }, { id: "kw__64", name: "影视金曲榜", bangid: "64" }, { id: "kw__176", name: "DJ嗨歌榜", bangid: "176" }, { id: "kw__106", name: "真声音", bangid: "106" }, { id: "kw__12", name: "Billboard榜", bangid: "12" }, { id: "kw__49", name: "iTunes音乐榜", bangid: "49" }, { id: "kw__180", name: "beatport电音榜", bangid: "180" }, { id: "kw__13", name: "英国UK榜", bangid: "13" }, { id: "kw__164", name: "百大DJ榜", bangid: "164" }, { id: "kw__246", name: "YouTube音乐排行榜", bangid: "246" }, { id: "kw__265", name: "韩国Genie榜", bangid: "265" }, { id: "kw__14", name: "韩国M-net榜", bangid: "14" }, { id: "kw__8", name: "香港电台榜", bangid: "8" }, { id: "kw__15", name: "日本公信榜", bangid: "15" }, { id: "kw__151", name: "腾讯音乐人原创榜", bangid: "151" }];
    var sortQualityArray = (array) => {
      const qualityMap = {
        flac24bit: 4,
        flac: 3,
        "320k": 2,
        "128k": 1
      };
      const rawQualityArray = [];
      const newQualityArray = [];
      array.forEach((item, index) => {
        const type = qualityMap[item.type];
        if (!type)
          return;
        rawQualityArray.push({ type, index });
      });
      rawQualityArray.sort((a, b) => a.type - b.type);
      rawQualityArray.forEach((item) => {
        newQualityArray.push(array[item.index]);
      });
      return newQualityArray;
    };
    exports2.default = {
      list: [
        {
          id: "kwbiaosb",
          name: "飙升榜",
          bangid: 93
        },
        {
          id: "kwregb",
          name: "热歌榜",
          bangid: 16
        },
        {
          id: "kwhuiyb",
          name: "会员榜",
          bangid: 145
        },
        {
          id: "kwdouyb",
          name: "抖音榜",
          bangid: 158
        },
        {
          id: "kwqsb",
          name: "趋势榜",
          bangid: 187
        },
        {
          id: "kwhuaijb",
          name: "怀旧榜",
          bangid: 26
        },
        {
          id: "kwhuayb",
          name: "华语榜",
          bangid: 104
        },
        {
          id: "kwyueyb",
          name: "粤语榜",
          bangid: 182
        },
        {
          id: "kwoumb",
          name: "欧美榜",
          bangid: 22
        },
        {
          id: "kwhanyb",
          name: "韩语榜",
          bangid: 184
        },
        {
          id: "kwriyb",
          name: "日语榜",
          bangid: 183
        }
      ],
      // getUrl: (p, l, id) => `http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=${p - 1}&rn=${l}&type=bang&data=content&id=${id}&show_copyright_off=0&pcmp4=1&isbang=1`,
      regExps: {
        mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/
      },
      limit: 100,
      _requestBoardsObj: null,
      getBoardsData() {
        if (this._requestBoardsObj)
          this._requestBoardsObj.cancelHttp();
        this._requestBoardsObj = (0, request_1.httpFetch)("http://qukudata.kuwo.cn/q.k?op=query&cont=tree&node=2&pn=0&rn=1000&fmt=json&level=2");
        return this._requestBoardsObj.promise;
      },
      getData(url) {
        const requestDataObj = (0, request_1.httpFetch)(url);
        return requestDataObj.promise;
      },
      filterData(rawList) {
        return rawList.map((item) => {
          let types = [];
          const _types = {};
          const qualitys = /* @__PURE__ */ new Set();
          item.n_minfo.split(";").forEach((i) => {
            const info = i.match(this.regExps.mInfo);
            if (!info)
              return;
            const quality = info[2];
            const size = info[4].toLocaleUpperCase();
            if (qualitys.has(quality))
              return;
            qualitys.add(quality);
            switch (quality) {
              case "4000":
                types.push({ type: "flac24bit", size });
                _types.flac24bit = { size };
                break;
              case "2000":
                types.push({ type: "flac", size });
                _types.flac = { size };
                break;
              case "320":
                types.push({ type: "320k", size });
                _types["320k"] = { size };
                break;
              case "128":
                types.push({ type: "128k", size });
                _types["128k"] = { size };
                break;
            }
          });
          types = sortQualityArray(types);
          return {
            singer: (0, util_1.formatSinger)((0, index_1.decodeName)(item.artist)),
            name: (0, index_1.decodeName)(item.name),
            albumName: (0, index_1.decodeName)(item.album),
            albumId: item.albumId,
            songmid: item.id,
            source: "kw",
            interval: (0, index_1.formatPlayTime)(parseInt(item.duration)),
            img: (0, util_1.formatPic)(item.pic),
            lrc: null,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      filterBoardsData(rawList) {
        let list = [];
        for (const board of rawList) {
          if (board.source != "1")
            continue;
          list.push({
            id: "kw__" + board.sourceid,
            name: board.name,
            bangid: String(board.sourceid)
          });
        }
        return list;
      },
      async getBoards(retryNum = 0) {
        this.list = boardList;
        return {
          list: boardList,
          source: "kw"
        };
      },
      getList(id, page, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        id = String(id).replace(/^kw__/, "");
        const requestBody = { uid: "", devId: "", sFrom: "kuwo_sdk", user_type: "AP", carSource: "kwplayercar_ar_6.0.1.0_apk_keluze.apk", id, pn: page - 1, rn: this.limit };
        const requestUrl = `https://wbd.kuwo.cn/api/bd/bang/bang_info?${util_1.wbdCrypto.buildParam(requestBody)}`;
        const request = (0, request_1.httpFetch)(requestUrl).promise;
        return request.then(({ statusCode, body }) => {
          const rawData = util_1.wbdCrypto.decodeData(body);
          const data = rawData.data;
          if (statusCode !== 200 || rawData.code != 200 || !data.musiclist)
            return this.getList(id, page, retryNum);
          const total = parseInt(data.total);
          const list = this.filterData(data.musiclist);
          return {
            total,
            list,
            limit: this.limit,
            page,
            source: "kw"
          };
        });
      }
      // getDetailPageUrl(id) {
      //   return `http://www.kuwo.cn/rankList/${id}`
      // },
    };
  }
});

// src/vendor/musicSdk/kw/lyric.js
var require_lyric = __commonJS({
  "src/vendor/musicSdk/kw/lyric.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var util_1 = require_util();
    var index_1 = require_vendor();
    var buf_key = Buffer.from("yeelion");
    var buf_key_len = buf_key.length;
    var buildParams = (id, isGetLyricx) => {
      let params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${id}`;
      if (isGetLyricx)
        params += "&lrcx=1";
      const buf_str = Buffer.from(params);
      const buf_str_len = buf_str.length;
      const output = new Uint16Array(buf_str_len);
      let i = 0;
      while (i < buf_str_len) {
        let j = 0;
        while (j < buf_key_len && i < buf_str_len) {
          output[i] = buf_key[j] ^ buf_str[i];
          i++;
          j++;
        }
      }
      return Buffer.from(output).toString("base64");
    };
    var timeExp = /^\[([\d:.]*)\]{1}/g;
    var existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/;
    var lyricxTag = /^<-?\d+,-?\d+>/;
    exports2.default = {
      /* sortLrcArr(arr) {
          const lrcSet = new Set()
          let lrc = []
          let lrcT = []
          let markIndex = []
          for (const item of arr) {
            if (lrcSet.has(item.time)) {
              if (lrc.length < 2) continue
              const index = lrc.findIndex(l => l.time == item.time)
              markIndex.push(index)
              if (index == lrc.length - 1) {
                lrcT.push({ ...lrc[index], time: item.time })
                lrc.push(item)
              } else {
                lrcT.push({ ...lrc[index], time: lrc[index + 1].time })
                if (item.text) {
                  //   const lastIndex = lrc.length - 1
                  //   markIndex.push(lastIndex)
                  //   lrcT.push({ ...lrc[lastIndex], time: lrc[lastIndex - 1].time })
                  lrc.push(item)
                }
              }
            } else {
              lrc.push(item)
              lrcSet.add(item.time)
            }
          }
      
          // console.log(markIndex)
          markIndex = Array.from(new Set(markIndex))
          for (let index = markIndex.length - 1; index >= 0; index--) {
            lrc.splice(markIndex[index], 1)
          }
      
          // if (lrcT.length) {
          //   if (lrc.length * 0.4 < lrcT.length) { // 翻译数量需大于歌词数量的0.4倍，否则认为没有翻译
          //     const tItem = lrc.pop()
          //     tItem.time = lrc[lrc.length - 1].time
          //     lrcT.push(tItem)
          //   } else {
          //     lrc = arr
          //     lrcT = []
          //   }
          // }
      
          console.log(lrc, lrcT)
      
          return {
            lrc,
            lrcT,
          }
        }, */
      sortLrcArr(arr) {
        const lrcSet = /* @__PURE__ */ new Set();
        let lrc = [];
        let lrcT = [];
        let isLyricx = false;
        for (const item of arr) {
          if (lrcSet.has(item.time)) {
            if (lrc.length < 2)
              continue;
            const tItem = lrc.pop();
            tItem.time = lrc[lrc.length - 1].time;
            lrcT.push(tItem);
            lrc.push(item);
          } else {
            lrc.push(item);
            lrcSet.add(item.time);
          }
          if (!isLyricx && lyricxTag.test(item.text))
            isLyricx = true;
        }
        if (!isLyricx && lrcT.length > lrc.length * 0.3 && lrc.length - lrcT.length > 6) {
          throw new Error("failed");
        }
        return {
          lrc,
          lrcT
        };
      },
      transformLrc(tags, lrclist) {
        return `${tags.join("\n")}
${lrclist ? lrclist.map((l) => `[${l.time}]${l.text}
`).join("") : "暂无歌词"}`;
      },
      parseLrc(lrc) {
        const lines = lrc.split(/\r\n|\r|\n/);
        let tags = [];
        let lrcArr = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          let result = timeExp.exec(line);
          if (result) {
            const text = line.replace(timeExp, "").trim();
            let time = RegExp.$1;
            if (/\.\d\d$/.test(time))
              time += "0";
            lrcArr.push({
              time,
              text
            });
          } else if (util_1.lrcTools.rxps.tagLine.test(line)) {
            tags.push(line);
          }
        }
        const lrcInfo = this.sortLrcArr(lrcArr);
        return {
          lyric: (0, index_1.decodeName)(this.transformLrc(tags, lrcInfo.lrc)),
          tlyric: lrcInfo.lrcT.length ? (0, index_1.decodeName)(this.transformLrc(tags, lrcInfo.lrcT)) : ""
        };
      },
      // getLyric2(musicInfo, isGetLyricx = true) {
      //   const requestObj = httpFetch(`http://newlyric.kuwo.cn/newlyric.lrc?${buildParams(musicInfo.songmid, isGetLyricx)}`)
      //   requestObj.promise = requestObj.promise.then(({ statusCode, body, raw }) => {
      //     if (statusCode != 200) return Promise.reject(new Error(JSON.stringify(body)))
      //     return decodeLyric({ lrcBase64: raw.toString('base64'), isGetLyricx }).then(base64Data => {
      //       let lrcInfo
      //       console.log(Buffer.from(base64Data, 'base64').toString())
      //       try {
      //         lrcInfo = this.parseLrc(Buffer.from(base64Data, 'base64').toString())
      //       } catch {
      //         return Promise.reject(new Error('Get lyric failed'))
      //       }
      //       if (lrcInfo.tlyric) lrcInfo.tlyric = lrcInfo.tlyric.replace(lrcTools.rxps.wordTimeAll, '')
      //       lrcInfo.lxlyric = lrcTools.parse(lrcInfo.lyric)
      //       // console.log(lrcInfo.lyric)
      //       // console.log(lrcInfo.tlyric)
      //       // console.log(lrcInfo.lxlyric)
      //       // console.log(JSON.stringify(lrcInfo))
      //     })
      //   })
      //   return requestObj
      // },
      getLyric(musicInfo, isGetLyricx = true) {
        const requestObj = (0, request_1.httpFetch)(`http://newlyric.kuwo.cn/newlyric.lrc?${buildParams(musicInfo.songmid, isGetLyricx)}`);
        requestObj.promise = requestObj.promise.then(({ statusCode, body, raw }) => {
          if (statusCode != 200)
            return Promise.reject(new Error(JSON.stringify(body)));
          return (0, util_1.decodeLyric)({ lrcBase64: raw.toString("base64"), isGetLyricx }).then((base64Data) => {
            let lrcInfo;
            const lrcText = Buffer.from(base64Data, "base64").toString();
            try {
              lrcInfo = this.parseLrc(lrcText);
            } catch (err) {
              return Promise.reject(new Error("Get lyric failed"));
            }
            if (lrcInfo.tlyric)
              lrcInfo.tlyric = lrcInfo.tlyric.replace(util_1.lrcTools.rxps.wordTimeAll, "");
            try {
              lrcInfo.lxlyric = util_1.lrcTools.parse(lrcInfo.lyric);
            } catch {
              lrcInfo.lxlyric = "";
            }
            lrcInfo.lyric = lrcInfo.lyric.replace(util_1.lrcTools.rxps.wordTimeAll, "");
            if (!existTimeExp.test(lrcInfo.lyric)) {
              return Promise.reject(new Error("Get lyric failed"));
            }
            return lrcInfo;
          });
        });
        return requestObj;
      }
    };
  }
});

// src/vendor/musicSdk/kw/pic.js
var require_pic = __commonJS({
  "src/vendor/musicSdk/kw/pic.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var util_1 = require_util();
    exports2.default = {
      getPic({ songmid }) {
        const requestObj = (0, request_1.httpFetch)(`http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=1000&size=1000&rid=${songmid}`);
        requestObj.promise = requestObj.promise.then(({ body }) => /^http/.test(body) ? (0, util_1.formatPic)(body) : null);
        return requestObj.promise;
      }
    };
  }
});

// src/vendor/musicSdk/api-source-info.js
var require_api_source_info = __commonJS({
  "src/vendor/musicSdk/api-source-info.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var sources = [
      // {
      //   id: 'test',
      //   name: '测试接口',
      //   disabled: false,
      //   supportQualitys: {
      //     kw: ['128k'],
      //     kg: ['128k'],
      //     tx: ['128k'],
      //     wy: ['128k'],
      //     mg: ['128k'],
      //     // bd: ['128k'],
      //   },
      // },
      // {
      //   id: 'temp',
      //   name: '临时接口',
      //   disabled: false,
      //   supportQualitys: {
      //     kw: ['128k'],
      //   },
      // },
    ];
    exports2.default = sources;
  }
});

// src/vendor/musicSdk/api-source.js
var require_api_source = __commonJS({
  "src/vendor/musicSdk/api-source.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.supportQuality = exports2.apis = void 0;
    var api_source_info_1 = __importDefault(require_api_source_info());
    var allApi = {};
    var apiList = {};
    var supportQuality = {};
    exports2.supportQuality = supportQuality;
    for (const api of api_source_info_1.default) {
      supportQuality[api.id] = api.supportQualitys;
      for (const source of Object.keys(api.supportQualitys)) {
        apiList[`${api.id}_api_${source}`] = allApi[`${api.id}_${source}`];
      }
    }
    var userApiModule = null;
    var getUserApi = () => {
      if (!userApiModule) {
        try {
          userApiModule = require("../../../server/userApi");
        } catch (err) {
          console.error("[api-source] Failed to load userApi:", err.message);
          userApiModule = { getLoadedApis: () => [] };
        }
      }
      return userApiModule;
    };
    var getUserApis = () => {
      const userApi = getUserApi();
      const loadedApis = userApi.getLoadedApis ? userApi.getLoadedApis() : [];
      const apis2 = {};
      for (const apiInfo of loadedApis) {
        if (!apiInfo.enabled || !apiInfo.sources)
          continue;
        for (const source of Object.keys(apiInfo.sources)) {
          apis2[source] = {
            getMusicUrl: (songInfo, type) => {
              return userApi.callUserApiGetMusicUrl(source, songInfo, type);
            }
            // 其他方法可以在需要时添加
            // getLyric: (songInfo) => { ... },
            // getPic: (songInfo) => { ... },
          };
        }
      }
      return apis2;
    };
    var apis = (source) => {
      const userApis = getUserApis();
      if (userApis[source]) {
        return userApis[source];
      }
      throw new Error(`未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`);
    };
    exports2.apis = apis;
  }
});

// src/vendor/musicSdk/kw/album.js
var require_album = __commonJS({
  "src/vendor/musicSdk/kw/album.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var util_1 = require_util();
    exports2.default = {
      limit_list: 36,
      limit_song: 1e3,
      filterListDetail(rawList, albumName, albumId) {
        return rawList.map((item, inedx) => {
          let formats = item.formats.split("|");
          let types = [];
          let _types = {};
          if (formats.includes("MP3128")) {
            types.push({ type: "128k", size: null });
            _types["128k"] = {
              size: null
            };
          }
          if (formats.includes("MP3H")) {
            types.push({ type: "320k", size: null });
            _types["320k"] = {
              size: null
            };
          }
          if (formats.includes("ALFLAC")) {
            types.push({ type: "flac", size: null });
            _types.flac = {
              size: null
            };
          }
          if (formats.includes("HIRFLAC")) {
            types.push({ type: "flac24bit", size: null });
            _types.flac24bit = {
              size: null
            };
          }
          return {
            singer: (0, util_1.formatSinger)((0, index_1.decodeName)(item.artist)),
            name: (0, index_1.decodeName)(item.name),
            albumName,
            albumId,
            songmid: item.id,
            source: "kw",
            interval: null,
            img: (0, util_1.formatPic)(item.pic),
            lrc: null,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      /**
       * 格式化播放数量
       * @param {*} num
       */
      formatPlayCount(num) {
        if (num > 1e8)
          return parseInt(num / 1e7) / 10 + "亿";
        if (num > 1e4)
          return parseInt(num / 1e3) / 10 + "万";
        return num;
      },
      getAlbumListDetail(id, page, retryNum = 0) {
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const requestObj_listDetail = (0, request_1.httpFetch)(`http://search.kuwo.cn/r.s?pn=${page - 1}&rn=${this.limit_song}&stype=albuminfo&albumid=${id}&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0`);
        return requestObj_listDetail.promise.then(({ statusCode, body }) => {
          if (statusCode !== 200)
            return this.getAlbumListDetail(id, page, ++retryNum);
          body = (0, util_1.objStr2JSON)(body);
          if (!body.musiclist)
            return this.getAlbumListDetail(id, page, ++retryNum);
          body.name = (0, index_1.decodeName)(body.name);
          return {
            list: this.filterListDetail(body.musiclist, body.name, body.albumid),
            page,
            limit: this.limit_song,
            total: parseInt(body.songnum),
            source: "kw",
            info: {
              name: body.name,
              img: (0, util_1.formatPic)(body.img || body.hts_img),
              desc: (0, index_1.decodeName)(body.info),
              author: (0, index_1.decodeName)(body.artist)
              // play_count: this.formatPlayCount(body.playnum),
            }
          };
        });
      }
      // getAlbumListDetail(id, page, retryNum = 0) {
      //   if (retryNum > 2) return Promise.reject(new Error('try max num'))
      //   return tokenRequest(`http://www.kuwo.cn/api/www/album/albumInfo?albumId=${id}&pn=${page}&rn=${this.limit_song}&httpsStatus=1`).then((resp) => {
      //     return resp.promise.then(({ statusCode, body }) => {
      //       console.log(body)
      //       return Promise.reject(new Error('failed'))
      //       // if (statusCode !== 200) return this.getAlbumListDetail(id, page, ++retryNum)
      //       // const data = body.data
      //       // console.log(data)
      //       // if (!data.musicList) return this.getAlbumListDetail(id, page, ++retryNum)
      //       // return {
      //       //   list: this.filterListDetail(data.musiclist),
      //       //   page,
      //       //   limit: this.limit_song,
      //       //   total: data.total,
      //       //   source: 'kw',
      //       //   info: {
      //       //     name: data.album,
      //       //     img: data.pic,
      //       //     desc: data.albuminfo,
      //       //     author: data.artist,
      //       //     play_count: this.formatPlayCount(data.playCnt),
      //       //   },
      //       // }
      //     })
      //   })
      // },
    };
  }
});

// src/vendor/musicSdk/kw/songList.js
var require_songList = __commonJS({
  "src/vendor/musicSdk/kw/songList.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var util_1 = require_util();
    var album_1 = __importDefault(require_album());
    exports2.default = {
      _requestObj_tags: null,
      _requestObj_hotTags: null,
      _requestObj_list: null,
      limit_list: 36,
      limit_song: 1e3,
      successCode: 200,
      sortList: [
        {
          name: "最新",
          id: "new"
        },
        {
          name: "最热",
          id: "hot"
        }
      ],
      regExps: {
        mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/,
        // http://www.kuwo.cn/playlist_detail/2886046289
        // https://m.kuwo.cn/h5app/playlist/2736267853?t=qqfriend
        listDetailLink: /^.+\/playlist(?:_detail)?\/(\d+)(?:\?.*|&.*$|#.*$|$)/
      },
      tagsUrl: "http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&loginUid=0&loginSid=0&appUid=76039576",
      hotTagUrl: "http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmTagList?loginUid=0&loginSid=0&appUid=76039576",
      getListUrl({ sortId, id, type, page }) {
        if (!id)
          return `http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&&pn=${page}&rn=${this.limit_list}&order=${sortId}`;
        switch (type) {
          case "10000":
            return `http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&id=${id}&rn=${this.limit_list}`;
          case "43":
            return `http://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id=${id}&prod=pc`;
        }
      },
      getListDetailUrl(id, page) {
        return `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${id}&pn=${page - 1}&rn=${this.limit_song}&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`;
      },
      // http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=2849349915&pn=0&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1
      // 获取标签
      getTag(tryNum = 0) {
        if (this._requestObj_tags)
          this._requestObj_tags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_tags = (0, request_1.httpFetch)(this.tagsUrl);
        return this._requestObj_tags.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getTag(++tryNum);
          return this.filterTagInfo(body.data);
        });
      },
      // 获取标签
      getHotTag(tryNum = 0) {
        if (this._requestObj_hotTags)
          this._requestObj_hotTags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_hotTags = (0, request_1.httpFetch)(this.hotTagUrl);
        return this._requestObj_hotTags.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getHotTag(++tryNum);
          return this.filterInfoHotTag(body.data[0].data);
        });
      },
      filterInfoHotTag(rawList) {
        return rawList.map((item) => ({
          id: `${item.id}-${item.digest}`,
          name: item.name,
          source: "kw"
        }));
      },
      filterTagInfo(rawList) {
        return rawList.map((type) => ({
          name: type.name,
          list: type.data.map((item) => ({
            parent_id: type.id,
            parent_name: type.name,
            id: `${item.id}-${item.digest}`,
            name: item.name,
            source: "kw"
          }))
        }));
      },
      // 获取列表数据
      getList(sortId, tagId, page, tryNum = 0) {
        if (this._requestObj_list)
          this._requestObj_list.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        let id;
        let type;
        if (tagId) {
          let arr = tagId.split("-");
          id = arr[0];
          type = arr[1];
        } else {
          id = null;
        }
        this._requestObj_list = (0, request_1.httpFetch)(this.getListUrl({ sortId, id, type, page }));
        return this._requestObj_list.promise.then(({ body }) => {
          if (!id || type == "10000") {
            if (body.code !== this.successCode)
              return this.getList(sortId, tagId, page, ++tryNum);
            return {
              list: this.filterList(body.data.data),
              total: body.data.total,
              page: body.data.pn,
              limit: body.data.rn,
              source: "kw"
            };
          } else if (!body.length) {
            return this.getList(sortId, tagId, page, ++tryNum);
          }
          return {
            list: this.filterList2(body),
            total: 1e3,
            page,
            limit: 1e3,
            source: "kw"
          };
        });
      },
      /**
       * 格式化播放数量
       * @param {*} num
       */
      formatPlayCount(num) {
        if (num > 1e8)
          return parseInt(num / 1e7) / 10 + "亿";
        if (num > 1e4)
          return parseInt(num / 1e3) / 10 + "万";
        return num;
      },
      filterList(rawData) {
        return rawData.map((item) => ({
          play_count: this.formatPlayCount(item.listencnt),
          id: `digest-${item.digest}__${item.id}`,
          author: item.uname,
          name: item.name,
          // time: item.publish_time,
          total: item.total,
          img: (0, util_1.formatPic)(item.img),
          grade: item.favorcnt / 10,
          desc: item.desc,
          source: "kw"
        }));
      },
      filterList2(rawData) {
        const list = [];
        rawData.forEach((item) => {
          if (!item.label)
            return;
          list.push(...item.list.map((item2) => ({
            play_count: item2.play_count && this.formatPlayCount(item2.listencnt),
            id: `digest-${item2.digest}__${item2.id}`,
            author: item2.uname,
            name: item2.name,
            total: item2.total,
            // time: item.publish_time,
            img: (0, util_1.formatPic)(item2.img),
            grade: item2.favorcnt && item2.favorcnt / 10,
            desc: item2.desc,
            source: "kw"
          })));
        });
        return list;
      },
      getListDetailDigest8(id, page, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        const requestObj = (0, request_1.httpFetch)(this.getListDetailUrl(id, page));
        return requestObj.promise.then(({ body }) => {
          if (body.result !== "ok")
            return this.getListDetail(id, page, ++tryNum);
          return {
            list: this.filterListDetail(body.musiclist),
            page,
            limit: body.rn,
            total: body.total,
            source: "kw",
            info: {
              name: body.title,
              img: (0, util_1.formatPic)(body.pic),
              desc: body.info,
              author: body.uname,
              play_count: this.formatPlayCount(body.playnum)
            }
          };
        });
      },
      getListDetailDigest5Info(id, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        const requestObj = (0, request_1.httpFetch)(`http://qukudata.kuwo.cn/q.k?op=query&cont=ninfo&node=${id}&pn=0&rn=1&fmt=json&src=mbox&level=2`);
        return requestObj.promise.then(({ statusCode, body }) => {
          if (statusCode != 200 || !body.child)
            return this.getListDetail(id, ++tryNum);
          return body.child.length ? body.child[0].sourceid : null;
        });
      },
      getListDetailDigest5Music(id, page, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        const requestObj = (0, request_1.httpFetch)(`http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${id}&pn=${page - 1}}&rn=${this.limit_song}&encode=utf-8&keyset=pl2012&identity=kuwo&pcmp4=1`);
        return requestObj.promise.then(({ body }) => {
          if (body.result !== "ok")
            return this.getListDetail(id, page, ++tryNum);
          return {
            list: this.filterListDetail(body.musiclist),
            page,
            limit: body.rn,
            total: body.total,
            source: "kw",
            info: {
              name: body.title,
              img: (0, util_1.formatPic)(body.pic),
              desc: body.info,
              author: body.uname,
              play_count: this.formatPlayCount(body.playnum)
            }
          };
        });
      },
      async getListDetailDigest5(id, page, retryNum) {
        const detailId = await this.getListDetailDigest5Info(id, retryNum);
        return this.getListDetailDigest5Music(detailId, page, retryNum);
      },
      filterBDListDetail(rawList) {
        return rawList.map((item) => {
          let types = [];
          let _types = {};
          for (let info of item.audios) {
            info.size = info.size?.toLocaleUpperCase();
            switch (info.bitrate) {
              case "4000":
                types.push({ type: "flac24bit", size: info.size });
                _types.flac24bit = {
                  size: info.size
                };
                break;
              case "2000":
                types.push({ type: "flac", size: info.size });
                _types.flac = {
                  size: info.size
                };
                break;
              case "320":
                types.push({ type: "320k", size: info.size });
                _types["320k"] = {
                  size: info.size
                };
                break;
              case "128":
                types.push({ type: "128k", size: info.size });
                _types["128k"] = {
                  size: info.size
                };
                break;
            }
          }
          types.reverse();
          return {
            singer: item.artists.map((s) => s.name).join("、"),
            name: item.name,
            albumName: item.album,
            albumId: item.albumId,
            songmid: item.id,
            source: "kw",
            interval: (0, index_1.formatPlayTime)(item.duration),
            img: (0, util_1.formatPic)(item.albumPic),
            releaseDate: item.releaseDate,
            lrc: null,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      getReqId() {
        function t() {
          return (65536 * (1 + Math.random()) | 0).toString(16).substring(1);
        }
        return t() + t() + t() + t() + t() + t() + t() + t();
      },
      async getListDetailMusicListByBDListInfo(id, source) {
        const { body: infoData } = await (0, request_1.httpFetch)(`https://bd-api.kuwo.cn/api/service/playlist/info/${id}?reqId=${this.getReqId()}&source=${source}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
            plat: "h5"
          }
        }).promise.catch(() => ({ code: 0 }));
        if (infoData.code != 200)
          return null;
        return {
          name: infoData.data.name,
          img: (0, util_1.formatPic)(infoData.data.pic),
          desc: infoData.data.description,
          author: infoData.data.creatorName,
          play_count: infoData.data.playNum
        };
      },
      async getListDetailMusicListByBDUserPub(id) {
        const { body: infoData } = await (0, request_1.httpFetch)(`https://bd-api.kuwo.cn/api/ucenter/users/pub/${id}?reqId=${this.getReqId()}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
            plat: "h5"
          }
        }).promise.catch(() => ({ code: 0 }));
        if (infoData.code != 200)
          return null;
        return {
          name: infoData.data.userInfo.nickname + "喜欢的音乐",
          img: (0, util_1.formatPic)(infoData.data.userInfo.headImg),
          desc: "",
          author: infoData.data.userInfo.nickname,
          play_count: ""
        };
      },
      async getListDetailMusicListByBDList(id, source, page, tryNum = 0) {
        const { body: listData } = await (0, request_1.httpFetch)(`https://bd-api.kuwo.cn/api/service/playlist/${id}/musicList?reqId=${this.getReqId()}&source=${source}&pn=${page}&rn=${this.limit_song}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
            plat: "h5"
          }
        }).promise.catch(() => {
          if (tryNum > 2)
            return Promise.reject(new Error("try max num"));
          return this.getListDetailMusicListByBDList(id, source, page, ++tryNum);
        });
        if (listData.code !== 200)
          return Promise.reject(new Error("failed"));
        return {
          list: this.filterBDListDetail(listData.data.list),
          page,
          limit: listData.data.pageSize,
          total: listData.data.total,
          source: "kw"
        };
      },
      async getListDetailMusicListByBD(id, page) {
        const uid = /uid=(\d+)/.exec(id)?.[1];
        const listId = /playlistId=(\d+)/.exec(id)?.[1];
        const source = /source=(\d+)/.exec(id)?.[1];
        if (!listId)
          return Promise.reject(new Error("failed"));
        const task = [this.getListDetailMusicListByBDList(listId, source, page)];
        switch (source) {
          case "4":
            task.push(this.getListDetailMusicListByBDListInfo(listId, source));
            break;
          case "5":
            task.push(this.getListDetailMusicListByBDUserPub(uid ?? listId));
            break;
        }
        const [listData, info] = await Promise.all(task);
        listData.info = info ?? {
          name: "",
          img: "",
          desc: "",
          author: "",
          play_count: ""
        };
        return listData;
      },
      // 获取歌曲列表内的音乐
      getListDetail(id, page, retryNum = 0) {
        if (/\/bodian\//.test(id))
          return this.getListDetailMusicListByBD(id, page);
        if (/[?&:/]/.test(id))
          id = id.replace(this.regExps.listDetailLink, "$1");
        else if (/^digest-/.test(id)) {
          let [digest, _id] = id.split("__");
          digest = digest.replace("digest-", "");
          id = _id;
          switch (digest) {
            case "8":
              break;
            case "13":
              return album_1.default.getAlbumListDetail(id, page, retryNum);
            case "5":
            default:
              return this.getListDetailDigest5(id, page, retryNum);
          }
        }
        return this.getListDetailDigest8(id, page, retryNum);
      },
      filterListDetail(rawData) {
        return rawData.map((item) => {
          let infoArr = item.N_MINFO.split(";");
          let types = [];
          let _types = {};
          for (let info of infoArr) {
            info = info.match(this.regExps.mInfo);
            if (info) {
              switch (info[2]) {
                case "4000":
                  types.push({ type: "flac24bit", size: info[4] });
                  _types.flac24bit = {
                    size: info[4].toLocaleUpperCase()
                  };
                  break;
                case "2000":
                  types.push({ type: "flac", size: info[4] });
                  _types.flac = {
                    size: info[4].toLocaleUpperCase()
                  };
                  break;
                case "320":
                  types.push({ type: "320k", size: info[4] });
                  _types["320k"] = {
                    size: info[4].toLocaleUpperCase()
                  };
                  break;
                case "128":
                  types.push({ type: "128k", size: info[4] });
                  _types["128k"] = {
                    size: info[4].toLocaleUpperCase()
                  };
                  break;
              }
            }
          }
          types.reverse();
          return {
            singer: (0, util_1.formatSinger)((0, index_1.decodeName)(item.artist)),
            name: (0, index_1.decodeName)(item.name),
            albumName: (0, index_1.decodeName)(item.album),
            albumId: item.albumid,
            songmid: item.id,
            source: "kw",
            interval: (0, index_1.formatPlayTime)(parseInt(item.duration)),
            img: (0, util_1.formatPic)(item.pic || item.albumpic || item.prob_albumpic || (item.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/1000${item.web_albumpic_short}` : null)),
            lrc: null,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      getTags() {
        return Promise.all([this.getTag(), this.getHotTag()]).then(([tags, hotTag]) => ({ tags, hotTag, source: "kw" }));
      },
      getDetailPageUrl(id) {
        if (/[?&:/]/.test(id))
          id = id.replace(this.regExps.listDetailLink, "$1");
        else if (/^digest-/.test(id)) {
          let result = id.split("__");
          id = result[1];
        }
        return `http://www.kuwo.cn/playlist_detail/${id}`;
      },
      search(text, page, limit = 20) {
        return (0, request_1.httpFetch)(`http://search.kuwo.cn/r.s?all=${encodeURIComponent(text)}&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8&ver=mbox&vipver=MUSIC_8.7.7.0_BCS37&plat=pc&devid=28156413&ft=playlist&pay=0&needliveshow=0`).promise.then(({ body }) => {
          body = (0, util_1.objStr2JSON)(body);
          return {
            list: body.abslist.map((item) => {
              return {
                play_count: this.formatPlayCount(item.playcnt),
                id: String(item.playlistid),
                author: (0, index_1.decodeName)(item.nickname),
                name: (0, index_1.decodeName)(item.name),
                total: item.songnum,
                // time: item.publish_time,
                img: (0, util_1.formatPic)(item.pic),
                desc: (0, index_1.decodeName)(item.intro),
                source: "kw"
              };
            }),
            limit,
            total: parseInt(body.TOTAL),
            source: "kw"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/kw/hotSearch.js
var require_hotSearch = __commonJS({
  "src/vendor/musicSdk/kw/hotSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      _requestObj: null,
      async getList(retryNum = 0) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const _requestObj = (0, request_1.httpFetch)("http://hotword.kuwo.cn/hotword.s?prod=kwplayer_ar_9.3.0.1&corp=kuwo&newver=2&vipver=9.3.0.1&source=kwplayer_ar_9.3.0.1_40.apk&p2p=1&notrace=0&uid=0&plat=kwplayer_ar&rformat=json&encoding=utf8&tabid=1", {
          headers: {
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9;)"
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.status !== "ok")
          throw new Error("获取热搜词失败");
        return { source: "kw", list: this.filterList(body.tagvalue) };
      },
      filterList(rawList) {
        return rawList.map((item) => item.key);
      }
    };
  }
});

// src/vendor/musicSdk/kw/comment.js
var require_comment = __commonJS({
  "src/vendor/musicSdk/kw/comment.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    exports2.default = {
      _requestObj: null,
      _requestObj2: null,
      async getComment({ songmid }, page = 1, limit = 20) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        const _requestObj = (0, request_1.httpFetch)(`http://ncomment.kuwo.cn/com.s?f=web&type=get_comment&aapiver=1&prod=kwplayer_ar_10.5.2.0&digest=15&sid=${songmid}&start=${limit * (page - 1)}&msgflag=1&count=${limit}&newver=3&uid=0`, {
          headers: {
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9;)"
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.code != "200")
          throw new Error("获取评论失败");
        const total = body.comments_counts;
        return {
          source: "kw",
          comments: this.filterComment(body.comments),
          total,
          page,
          limit,
          maxPage: Math.ceil(total / limit) || 1
        };
      },
      async getHotComment({ songmid }, page = 1, limit = 100) {
        if (this._requestObj2)
          this._requestObj2.cancelHttp();
        const _requestObj2 = (0, request_1.httpFetch)(`http://ncomment.kuwo.cn/com.s?f=web&type=get_rec_comment&aapiver=1&prod=kwplayer_ar_10.5.2.0&digest=15&sid=${songmid}&start=${limit * (page - 1)}&msgflag=1&count=${limit}&newver=3&uid=0`, {
          headers: {
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9;)"
          }
        });
        const { body, statusCode } = await _requestObj2.promise;
        if (statusCode != 200 || body.code != "200")
          throw new Error("获取热门评论失败");
        const total = body.hot_comments_counts;
        return {
          source: "kw",
          comments: this.filterComment(body.hot_comments),
          total,
          page,
          limit,
          maxPage: Math.ceil(total / limit) || 1
        };
      },
      filterComment(rawList) {
        if (!rawList)
          return [];
        return rawList.map((item) => {
          return {
            id: item.id,
            text: item.msg,
            time: item.time,
            timeStr: (0, index_1.dateFormat2)(Number(item.time) * 1e3),
            userName: item.u_name,
            avatar: item.u_pic,
            userId: item.u_id,
            likedCount: item.like_num,
            images: item.mpic ? [decodeURIComponent(item.mpic)] : [],
            reply: item.child_comments ? item.child_comments.map((i) => {
              return {
                id: i.id,
                text: i.msg,
                time: i.time,
                timeStr: (0, index_1.dateFormat2)(Number(i.time) * 1e3),
                userName: i.u_name,
                avatar: i.u_pic,
                userId: i.u_id,
                likedCount: i.like_num,
                images: i.mpic ? [i.mpic] : []
              };
            }) : []
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/kw/index.js
var require_kw = __commonJS({
  "src/vendor/musicSdk/kw/index.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var tipSearch_1 = __importDefault(require_tipSearch());
    var musicSearch_1 = __importDefault(require_musicSearch());
    var util_1 = require_util();
    var leaderboard_1 = __importDefault(require_leaderboard());
    var lyric_1 = __importDefault(require_lyric());
    var pic_1 = __importDefault(require_pic());
    var api_source_1 = require_api_source();
    var songList_1 = __importDefault(require_songList());
    var hotSearch_1 = __importDefault(require_hotSearch());
    var comment_1 = __importDefault(require_comment());
    var kw = {
      _musicInfoRequestObj: null,
      _musicInfoPromiseCancelFn: null,
      _musicPicRequestObj: null,
      _musicPicPromiseCancelFn: null,
      // context: null,
      // init(context) {
      //   if (this.isInited) return
      //   this.isInited = true
      //   this.context = context
      //   // this.musicSearch.search('我又想你了').then(res => {
      //   //   console.log(res)
      //   // })
      //   // this.getMusicUrl('62355680', '320k').then(url => {
      //   //   console.log(url)
      //   // })
      // },
      tipSearch: tipSearch_1.default,
      musicSearch: musicSearch_1.default,
      leaderboard: leaderboard_1.default,
      songList: songList_1.default,
      hotSearch: hotSearch_1.default,
      comment: comment_1.default,
      getLyric(songInfo, isGetLyricx) {
        return lyric_1.default.getLyric(songInfo, isGetLyricx);
      },
      handleMusicInfo(songInfo) {
        return this.getMusicInfo(songInfo).then((info) => {
          songInfo.name = info.name;
          songInfo.singer = (0, util_1.formatSinger)(info.artist);
          songInfo.img = (0, util_1.formatPic)(info.pic);
          songInfo.albumName = info.album;
          return songInfo;
        });
      },
      getMusicUrl(songInfo, type) {
        return (0, api_source_1.apis)("kw").getMusicUrl(songInfo, type);
      },
      getMusicInfo(songInfo) {
        if (this._musicInfoRequestObj)
          this._musicInfoRequestObj.cancelHttp();
        this._musicInfoRequestObj = (0, request_1.httpFetch)(`http://www.kuwo.cn/api/www/music/musicInfo?mid=${songInfo.songmid}`);
        return this._musicInfoRequestObj.promise.then(({ body }) => {
          return body.code === 200 ? body.data : Promise.reject(new Error(body.msg));
        });
      },
      getMusicUrls(musicInfo, cb) {
        let tasks = [];
        let songId = musicInfo.songmid;
        musicInfo.types.forEach((type) => {
          tasks.push(kw.getMusicUrl(songId, type.type).promise);
        });
        Promise.all(tasks).then((urlInfo) => {
          let typeUrl = {};
          urlInfo.forEach((info) => {
            typeUrl[info.type] = info.url;
          });
          cb(typeUrl);
        });
      },
      getPic(songInfo) {
        return pic_1.default.getPic(songInfo);
      },
      getMusicDetailPageUrl(songInfo) {
        return `http://www.kuwo.cn/play_detail/${songInfo.songmid}`;
      }
      // init() {
      //   return getToken()
      // },
    };
    exports2.default = kw;
  }
});

// src/vendor/musicSdk/kg/leaderboard.js
var require_leaderboard2 = __commonJS({
  "src/vendor/musicSdk/kg/leaderboard.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var utils_1 = require_utils();
    var boardList = [{ id: "kg__8888", name: "TOP500", bangid: "8888" }, { id: "kg__6666", name: "飙升榜", bangid: "6666" }, { id: "kg__59703", name: "蜂鸟流行音乐榜", bangid: "59703" }, { id: "kg__52144", name: "抖音热歌榜", bangid: "52144" }, { id: "kg__52767", name: "快手热歌榜", bangid: "52767" }, { id: "kg__24971", name: "DJ热歌榜", bangid: "24971" }, { id: "kg__23784", name: "网络红歌榜", bangid: "23784" }, { id: "kg__44412", name: "说唱先锋榜", bangid: "44412" }, { id: "kg__31308", name: "内地榜", bangid: "31308" }, { id: "kg__33160", name: "电音榜", bangid: "33160" }, { id: "kg__31313", name: "香港地区榜", bangid: "31313" }, { id: "kg__51341", name: "民谣榜", bangid: "51341" }, { id: "kg__54848", name: "台湾地区榜", bangid: "54848" }, { id: "kg__31310", name: "欧美榜", bangid: "31310" }, { id: "kg__33162", name: "ACG新歌榜", bangid: "33162" }, { id: "kg__31311", name: "韩国榜", bangid: "31311" }, { id: "kg__31312", name: "日本榜", bangid: "31312" }, { id: "kg__49225", name: "80后热歌榜", bangid: "49225" }, { id: "kg__49223", name: "90后热歌榜", bangid: "49223" }, { id: "kg__49224", name: "00后热歌榜", bangid: "49224" }, { id: "kg__33165", name: "粤语金曲榜", bangid: "33165" }, { id: "kg__33166", name: "欧美金曲榜", bangid: "33166" }, { id: "kg__33163", name: "影视金曲榜", bangid: "33163" }, { id: "kg__51340", name: "伤感榜", bangid: "51340" }, { id: "kg__35811", name: "会员专享榜", bangid: "35811" }, { id: "kg__37361", name: "雷达榜", bangid: "37361" }, { id: "kg__21101", name: "分享榜", bangid: "21101" }, { id: "kg__46910", name: "综艺新歌榜", bangid: "46910" }, { id: "kg__30972", name: "酷狗音乐人原创榜", bangid: "30972" }, { id: "kg__60170", name: "闽南语榜", bangid: "60170" }, { id: "kg__65234", name: "儿歌榜", bangid: "65234" }, { id: "kg__4681", name: "美国BillBoard榜", bangid: "4681" }, { id: "kg__25028", name: "Beatport电子舞曲榜", bangid: "25028" }, { id: "kg__4680", name: "英国单曲榜", bangid: "4680" }, { id: "kg__38623", name: "韩国Melon音乐榜", bangid: "38623" }, { id: "kg__42807", name: "joox本地热歌榜", bangid: "42807" }, { id: "kg__36107", name: "小语种热歌榜", bangid: "36107" }, { id: "kg__4673", name: "日本公信榜", bangid: "4673" }, { id: "kg__46868", name: "日本SPACE SHOWER榜", bangid: "46868" }, { id: "kg__42808", name: "KKBOX风云榜", bangid: "42808" }, { id: "kg__60171", name: "越南语榜", bangid: "60171" }, { id: "kg__60172", name: "泰语榜", bangid: "60172" }, { id: "kg__59895", name: "R&B榜", bangid: "59895" }, { id: "kg__59896", name: "摇滚榜", bangid: "59896" }, { id: "kg__59897", name: "爵士榜", bangid: "59897" }, { id: "kg__59898", name: "乡村音乐榜", bangid: "59898" }, { id: "kg__59900", name: "纯音乐榜", bangid: "59900" }, { id: "kg__59899", name: "古典榜", bangid: "59899" }, { id: "kg__22603", name: "5sing音乐榜", bangid: "22603" }, { id: "kg__21335", name: "繁星音乐榜", bangid: "21335" }, { id: "kg__33161", name: "古风新歌榜", bangid: "33161" }];
    exports2.default = {
      listDetailLimit: 100,
      list: [
        {
          id: "kgtop500",
          name: "TOP500",
          bangid: "8888"
        },
        {
          id: "kgwlhgb",
          name: "网络榜",
          bangid: "23784"
        },
        {
          id: "kgbsb",
          name: "飙升榜",
          bangid: "6666"
        },
        {
          id: "kgfxb",
          name: "分享榜",
          bangid: "21101"
        },
        {
          id: "kgcyyb",
          name: "纯音乐榜",
          bangid: "33164"
        },
        {
          id: "kggfjqb",
          name: "古风榜",
          bangid: "33161"
        },
        {
          id: "kgyyjqb",
          name: "粤语榜",
          bangid: "33165"
        },
        {
          id: "kgomjqb",
          name: "欧美榜",
          bangid: "33166"
        },
        {
          id: "kgdyrgb",
          name: "电音榜",
          bangid: "33160"
        },
        {
          id: "kgjdrgb",
          name: "DJ热歌榜",
          bangid: "24971"
        },
        {
          id: "kghyxgb",
          name: "华语新歌榜",
          bangid: "31308"
        }
      ],
      getUrl(p, id, limit) {
        return `http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${limit}&area_code=1&page=${p}&rankid=${id}&with_res_tag=0&show_portrait_mv=1`;
      },
      regExps: {
        total: /total: '(\d+)',/,
        page: /page: '(\d+)',/,
        limit: /pagesize: '(\d+)',/,
        listData: /global\.features = (\[.+\]);/
      },
      _requestBoardsObj: null,
      getBoardsData() {
        if (this._requestBoardsObj)
          this._requestBoardsObj.cancelHttp();
        this._requestBoardsObj = (0, request_1.httpFetch)("http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1");
        return this._requestBoardsObj.promise;
      },
      getData(url) {
        const requestDataObj = (0, request_1.httpFetch)(url);
        return requestDataObj.promise;
      },
      getSinger(singers) {
        let arr = [];
        singers.forEach((singer) => {
          arr.push(singer.author_name);
        });
        return arr.join("、");
      },
      filterData(rawList) {
        return rawList.map((item) => {
          const types = [];
          const _types = {};
          if (item.filesize !== 0) {
            let size = (0, index_1.sizeFormate)(item.filesize);
            types.push({ type: "128k", size, hash: item.hash });
            _types["128k"] = {
              size,
              hash: item.hash
            };
          }
          if (item["320filesize"] !== 0) {
            let size = (0, index_1.sizeFormate)(item["320filesize"]);
            types.push({ type: "320k", size, hash: item["320hash"] });
            _types["320k"] = {
              size,
              hash: item["320hash"]
            };
          }
          if (item.sqfilesize !== 0) {
            let size = (0, index_1.sizeFormate)(item.sqfilesize);
            types.push({ type: "flac", size, hash: item.sqhash });
            _types.flac = {
              size,
              hash: item.sqhash
            };
          }
          if (item.filesize_high !== 0) {
            let size = (0, index_1.sizeFormate)(item.filesize_high);
            types.push({ type: "flac24bit", size, hash: item.hash_high });
            _types.flac24bit = {
              size,
              hash: item.hash_high
            };
          }
          return {
            singer: (0, utils_1.formatSingerName)(item.authors, "author_name"),
            name: (0, index_1.decodeName)(item.songname),
            albumName: (0, index_1.decodeName)(item.remark),
            albumId: item.album_id,
            songmid: item.audio_id,
            source: "kg",
            interval: (0, index_1.formatPlayTime)(item.duration),
            img: (item.album_sizable_cover || item.trans_param?.union_cover || "").replace("{size}", "1000") || null,
            lrc: null,
            hash: item.hash,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      filterBoardsData(rawList) {
        let list = [];
        for (const board of rawList) {
          if (board.isvol != 1)
            continue;
          list.push({
            id: "kg__" + board.rankid,
            name: board.rankname,
            bangid: String(board.rankid)
          });
        }
        return list;
      },
      async getBoards(retryNum = 0) {
        this.list = boardList;
        return {
          list: boardList,
          source: "kg"
        };
      },
      async getList(bangid, page, retryNum = 0) {
        if (++retryNum > 3)
          throw new Error("try max num");
        bangid = String(bangid).replace(/^kg__/, "");
        const { body } = await this.getData(this.getUrl(page, bangid, this.listDetailLimit));
        if (body.errcode != 0 || !body.data)
          return this.getList(bangid, page, retryNum);
        let total = body.data.total;
        let limit = 100;
        let listData = this.filterData(body.data.info);
        return {
          total,
          list: listData,
          limit,
          page,
          source: "kg"
        };
      },
      getDetailPageUrl(id) {
        if (typeof id == "string")
          id = id.replace("kg__", "");
        return `https://www.kugou.com/yy/rank/home/1-${id}.html`;
      }
    };
  }
});

// src/vendor/musicSdk/kg/vendors/infSign.min.js
var require_infSign_min = __commonJS({
  "src/vendor/musicSdk/kg/vendors/infSign.min.js"(exports2, module2) {
    "use strict";
    !function(t, n) {
      "object" == typeof exports2 && "undefined" != typeof module2 ? module2.exports = n() : "function" == typeof define && define.amd ? define(n) : (t = t || self, t.infSign = n());
    }(exports2, function() {
      "use strict";
      function t(t2, n2, r2) {
        return n2 in t2 ? Object.defineProperty(t2, n2, { value: r2, enumerable: true, configurable: true, writable: true }) : t2[n2] = r2, t2;
      }
      function n(t2, n2) {
        var r2 = Object.keys(t2);
        if (Object.getOwnPropertySymbols) {
          var e2 = Object.getOwnPropertySymbols(t2);
          n2 && (e2 = e2.filter(function(n3) {
            return Object.getOwnPropertyDescriptor(t2, n3).enumerable;
          })), r2.push.apply(r2, e2);
        }
        return r2;
      }
      function r(r2) {
        for (var e2 = 1; e2 < arguments.length; e2++) {
          var o2 = null != arguments[e2] ? arguments[e2] : {};
          e2 % 2 ? n(o2, true).forEach(function(n2) {
            t(r2, n2, o2[n2]);
          }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(r2, Object.getOwnPropertyDescriptors(o2)) : n(o2).forEach(function(t2) {
            Object.defineProperty(r2, t2, Object.getOwnPropertyDescriptor(o2, t2));
          });
        }
        return r2;
      }
      function e(t2, n2) {
        return n2 = { exports: {} }, t2(n2, n2.exports), n2.exports;
      }
      function o(t2) {
        return !!t2.constructor && "function" == typeof t2.constructor.isBuffer && t2.constructor.isBuffer(t2);
      }
      function i(t2) {
        return "function" == typeof t2.readFloatLE && "function" == typeof t2.slice && o(t2.slice(0, 0));
      }
      function c() {
        var t2, n2 = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : {}, e2 = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : "", o2 = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : {}, i2 = false, c2 = false, a2 = "json", l2 = r({}, n2), u2 = s.isInClient();
        "function" == typeof o2 ? t2 = o2 : (t2 = o2.callback, i2 = o2.useH5 || false, a2 = o2.postType || "json", c2 = o2.isCDN || false), e2 && ("[object Object]" != Object.prototype.toString.call(e2) ? u2 = false : "urlencoded" == a2 && (u2 = false));
        var f2 = function() {
          var n3 = (/* @__PURE__ */ new Date()).getTime(), i3 = [], s2 = [], u3 = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt", f3 = { srcappid: "2919", clientver: "20000", clienttime: n3, mid: n3, uuid: n3, dfid: "-" };
          c2 && (delete f3.clienttime, delete f3.mid, delete f3.uuid, delete f3.dfid), l2 = r({}, f3, {}, l2);
          for (var g2 in l2)
            i3.push(g2);
          if (i3.sort(), i3.forEach(function(t3) {
            s2.push(t3 + "=" + l2[t3]);
          }), e2)
            if ("[object Object]" == Object.prototype.toString.call(e2))
              if ("json" == a2)
                s2.push(JSON.stringify(e2));
              else {
                var b = [];
                for (var g2 in e2)
                  b.push(g2 + "=" + e2[g2]);
                s2.push(b.join("&"));
              }
            else
              s2.push(e2);
          s2.unshift(u3), s2.push(u3), l2.signature = d(s2.join("")), o2.log && (console.log("H5签名前参数", s2), console.log("H5签名后返回", l2)), e2 ? t2 && t2(l2, "[object Object]" == Object.prototype.toString.call(e2) && "json" == a2 ? JSON.stringify(e2) : e2) : t2 && t2(l2);
        };
        if (u2 && !i2) {
          var g = false;
          s.mobileCall(764, { get: l2, post: e2 }, function(n3) {
            return !g && (g = true, n3 && n3.status ? (delete n3.status, o2.log && (console.log("客户端签名前参数", { get: l2, post: e2 }), console.log("客户端签名后返回", r({}, l2, {}, n3))), l2 = r({}, l2, {}, n3), e2 ? t2 && t2(l2, "[object Object]" == Object.prototype.toString.call(e2) && "json" == a2 ? JSON.stringify(e2) : e2) : t2 && t2(l2), false) : (u2 = false, void f2()));
          });
        } else
          u2 = false, f2();
      }
      "undefined" != typeof globalThis ? globalThis : "undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof self && self;
      var s = e(function(t2, n2) {
        !function(n3, r2) {
          t2.exports = function() {
            var t3 = { str2Json: function(t4) {
              var n4 = {};
              if ("[object String]" === Object.prototype.toString.call(t4))
                try {
                  n4 = JSON.parse(t4);
                } catch (t5) {
                  n4 = {};
                }
              return n4;
            }, json2Str: function(t4) {
              var n4 = t4;
              if ("string" != typeof t4)
                try {
                  n4 = JSON.stringify(t4);
                } catch (t5) {
                  n4 = "";
                }
              return n4;
            }, _extend: function(t4, n4) {
              if (n4)
                for (var r3 in t4)
                  n4.hasOwnProperty(r3) || (n4[r3] = t4[r3]);
              return n4;
            }, formatURL: { browser: "", url: "" }, formatSong: { filename: "", filesize: "", hash: "", bitrate: "", extname: "", duration: "", mvhash: "", m4afilesize: "", "320hash": "", "320filesize": "", sqhash: "", sqfilesize: 0, feetype: 0, isfirst: 0 }, formatMV: { filename: "", singername: "", hash: "", imgurl: "" }, formatShare: { shareName: "", topicName: "", hash: "", listID: "", type: "", suid: "", slid: "", imgUrl: "", filename: "", duration: "", shareData: { linkUrl: "", picUrl: "", content: "", title: "" } }, cbNum: 0, isIOS: !!navigator.userAgent.match(/KGBrowser/gi), isKugouAndroid: !!navigator.userAgent.match(/kugouandroid/gi), isAndroid: "undefined" != typeof external && void 0 !== external.superCall, loadUrl: function(t4) {
              var n4 = document.createElement("iframe");
              n4.setAttribute("src", t4), n4.setAttribute("style", "display:none;"), n4.setAttribute("height", "0px"), n4.setAttribute("width", "0px"), n4.setAttribute("frameborder", "0"), document.body.appendChild(n4), n4.parentNode.removeChild(n4), n4 = null;
            }, callCmd: function(n4) {
              var r3 = t3;
              if (r3.isKugouAndroid) {
                var e2 = {}, o2 = "";
                if (n4.cmd && (e2.cmd = n4.cmd), n4.jsonStr && (e2.jsonStr = n4.jsonStr), n4.callback && (o2 = "kgandroidmobilecall" + ++r3.cbNum + Math.random().toString().substr(2, 9), e2.callback = o2, window[o2] = function(t4, e3) {
                  void 0 !== t4 && ("[object String]" === Object.prototype.toString.call(t4) ? (t4 = "#" === e3 ? decodeURIComponent(t4) : decodeURIComponent(decodeURIComponent(t4)), n4.callback(r3.str2Json(t4))) : n4.callback(t4));
                }), n4.AndroidCallback) {
                  var i2 = r3.str2Json(n4.jsonStr);
                  i2.AndroidCallback = o2, n4.jsonStr = r3.json2Str(i2), n4.jsonStr && (e2.jsonStr = n4.jsonStr);
                }
                var c2 = encodeURIComponent(JSON.stringify(e2)), s2 = "kugoujsbridge://start.kugou_jsbridge/?".concat(c2);
                r3.loadUrl(s2);
              } else if (r3.isAndroid) {
                var a2 = "", l2 = "";
                if (n4.jsonStr) {
                  if (n4.callback && "" !== n4.callback && true === n4.AndroidCallback) {
                    l2 = "kgmobilecall" + ++r3.cbNum + Math.random().toString().substr(2, 9), window[l2] = function(t4, e3) {
                      void 0 !== t4 && ("[object String]" === Object.prototype.toString.call(t4) ? (t4 = "#" === e3 ? decodeURIComponent(t4) : decodeURIComponent(decodeURIComponent(t4)), n4.callback(r3.str2Json(t4))) : n4.callback(t4));
                    };
                    var u2 = r3.str2Json(n4.jsonStr);
                    u2.AndroidCallback = l2, n4.jsonStr = r3.json2Str(u2);
                  }
                  try {
                    a2 = external.superCall(n4.cmd, n4.jsonStr);
                  } catch (t4) {
                  }
                } else
                  try {
                    a2 = external.superCall(n4.cmd);
                  } catch (t4) {
                  }
                n4.callback && "" !== n4.callback && "AndroidCallback" != a2 && (a2 = r3.str2Json(a2), n4.callback(a2));
              } else {
                var f2 = "", d2 = "";
                n4.callback && (d2 = "kgmobilecall" + ++r3.cbNum + Math.random().toString().substr(2, 9), window[d2] = function(t4) {
                  void 0 !== t4 && n4.callback && ("[object String]" === Object.prototype.toString.call(t4) ? n4.callback(r3.str2Json(t4)) : n4.callback(t4));
                }), d2 && "" != d2 && n4.jsonStr && (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + ', "jsonStr":' + n4.jsonStr + ', "callback":"' + d2 + '"}'), d2 && "" != d2 && !n4.jsonStr && (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + ', "callback":"' + d2 + '"}'), "" == d2 && n4.jsonStr && (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + ', "jsonStr":' + n4.jsonStr + "}"), "" != d2 || n4.jsonStr || (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + "}"), r3.loadUrl(f2);
              }
            }, formartData: function(n4, r3) {
              n4 && 123 == n4 && r3 && (r3 = t3._extend(t3.formatURL, r3)), n4 && 123 == n4 && r3 && (r3 = t3._extend(t3.formatURL, r3));
            } };
            return { isIOS: t3.isIOS, isKugouAndroid: t3.isKugouAndroid, isAndroid: t3.isAndroid, isInClient: function() {
              return !(!t3.isAndroid && !t3.isKugouAndroid && !t3.isIOS);
            }, mobileCall: function(n4, r3, e2) {
              var o2 = "";
              if (r3 && (o2 = t3.json2Str(r3)), !n4)
                return console.error("请输入命令号！"), false;
              var i2 = {};
              n4 && (i2.cmd = n4), "" != o2 && (i2.jsonStr = o2), e2 && (i2.callback = e2), n4 && 186 == n4 && e2 && (i2.AndroidCallback = true), t3.callCmd(i2);
            }, KgWebMobileCall: function(t4, n4) {
              if (t4)
                try {
                  var r3 = t4.split(".");
                  r3.reduce(function(e2, o2) {
                    if (e2[o2]) {
                      if (o2 === r3[r3.length - 1]) {
                        var i2 = e2[o2];
                        return "function" == typeof i2 ? (e2[o2] = function(t5) {
                          i2 && i2(t5), n4 && n4(t5);
                        }, e2[o2]) : (console.error("请检查，当前环境变量已注册了对象：" + t4 + "，且该对象不是方法"), null);
                      }
                      return e2[o2];
                    }
                    return o2 === r3[r3.length - 1] ? e2[o2] = function(t5) {
                      n4 && n4(t5);
                    } : e2[o2] = new Object(), e2[o2];
                  }, window);
                } catch (t5) {
                }
            } };
          }();
        }();
      }), a = e(function(t2) {
        !function() {
          var n2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", r2 = { rotl: function(t3, n3) {
            return t3 << n3 | t3 >>> 32 - n3;
          }, rotr: function(t3, n3) {
            return t3 << 32 - n3 | t3 >>> n3;
          }, endian: function(t3) {
            if (t3.constructor == Number)
              return 16711935 & r2.rotl(t3, 8) | 4278255360 & r2.rotl(t3, 24);
            for (var n3 = 0; n3 < t3.length; n3++)
              t3[n3] = r2.endian(t3[n3]);
            return t3;
          }, randomBytes: function(t3) {
            for (var n3 = []; t3 > 0; t3--)
              n3.push(Math.floor(256 * Math.random()));
            return n3;
          }, bytesToWords: function(t3) {
            for (var n3 = [], r3 = 0, e2 = 0; r3 < t3.length; r3++, e2 += 8)
              n3[e2 >>> 5] |= t3[r3] << 24 - e2 % 32;
            return n3;
          }, wordsToBytes: function(t3) {
            for (var n3 = [], r3 = 0; r3 < 32 * t3.length; r3 += 8)
              n3.push(t3[r3 >>> 5] >>> 24 - r3 % 32 & 255);
            return n3;
          }, bytesToHex: function(t3) {
            for (var n3 = [], r3 = 0; r3 < t3.length; r3++)
              n3.push((t3[r3] >>> 4).toString(16)), n3.push((15 & t3[r3]).toString(16));
            return n3.join("");
          }, hexToBytes: function(t3) {
            for (var n3 = [], r3 = 0; r3 < t3.length; r3 += 2)
              n3.push(parseInt(t3.substr(r3, 2), 16));
            return n3;
          }, bytesToBase64: function(t3) {
            for (var r3 = [], e2 = 0; e2 < t3.length; e2 += 3)
              for (var o2 = t3[e2] << 16 | t3[e2 + 1] << 8 | t3[e2 + 2], i2 = 0; i2 < 4; i2++)
                8 * e2 + 6 * i2 <= 8 * t3.length ? r3.push(n2.charAt(o2 >>> 6 * (3 - i2) & 63)) : r3.push("=");
            return r3.join("");
          }, base64ToBytes: function(t3) {
            t3 = t3.replace(/[^A-Z0-9+\/]/gi, "");
            for (var r3 = [], e2 = 0, o2 = 0; e2 < t3.length; o2 = ++e2 % 4)
              0 != o2 && r3.push((n2.indexOf(t3.charAt(e2 - 1)) & Math.pow(2, -2 * o2 + 8) - 1) << 2 * o2 | n2.indexOf(t3.charAt(e2)) >>> 6 - 2 * o2);
            return r3;
          } };
          t2.exports = r2;
        }();
      }), l = { utf8: { stringToBytes: function(t2) {
        return l.bin.stringToBytes(unescape(encodeURIComponent(t2)));
      }, bytesToString: function(t2) {
        return decodeURIComponent(escape(l.bin.bytesToString(t2)));
      } }, bin: { stringToBytes: function(t2) {
        for (var n2 = [], r2 = 0; r2 < t2.length; r2++)
          n2.push(255 & t2.charCodeAt(r2));
        return n2;
      }, bytesToString: function(t2) {
        for (var n2 = [], r2 = 0; r2 < t2.length; r2++)
          n2.push(String.fromCharCode(t2[r2]));
        return n2.join("");
      } } }, u = l, f = function(t2) {
        return null != t2 && (o(t2) || i(t2) || !!t2._isBuffer);
      }, d = e(function(t2) {
        !function() {
          var n2 = a, r2 = u.utf8, e2 = f, o2 = u.bin, i2 = function(t3, c2) {
            t3.constructor == String ? t3 = c2 && "binary" === c2.encoding ? o2.stringToBytes(t3) : r2.stringToBytes(t3) : e2(t3) ? t3 = Array.prototype.slice.call(t3, 0) : Array.isArray(t3) || (t3 = t3.toString());
            for (var s2 = n2.bytesToWords(t3), a2 = 8 * t3.length, l2 = 1732584193, u2 = -271733879, f2 = -1732584194, d2 = 271733878, g = 0; g < s2.length; g++)
              s2[g] = 16711935 & (s2[g] << 8 | s2[g] >>> 24) | 4278255360 & (s2[g] << 24 | s2[g] >>> 8);
            s2[a2 >>> 5] |= 128 << a2 % 32, s2[14 + (a2 + 64 >>> 9 << 4)] = a2;
            for (var b = i2._ff, p = i2._gg, h = i2._hh, m = i2._ii, g = 0; g < s2.length; g += 16) {
              var y = l2, j = u2, S = f2, v = d2;
              u2 = m(u2 = m(u2 = m(u2 = m(u2 = h(u2 = h(u2 = h(u2 = h(u2 = p(u2 = p(u2 = p(u2 = p(u2 = b(u2 = b(u2 = b(u2 = b(u2, f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 0], 7, -680876936), u2, f2, s2[g + 1], 12, -389564586), l2, u2, s2[g + 2], 17, 606105819), d2, l2, s2[g + 3], 22, -1044525330), f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 4], 7, -176418897), u2, f2, s2[g + 5], 12, 1200080426), l2, u2, s2[g + 6], 17, -1473231341), d2, l2, s2[g + 7], 22, -45705983), f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 8], 7, 1770035416), u2, f2, s2[g + 9], 12, -1958414417), l2, u2, s2[g + 10], 17, -42063), d2, l2, s2[g + 11], 22, -1990404162), f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 12], 7, 1804603682), u2, f2, s2[g + 13], 12, -40341101), l2, u2, s2[g + 14], 17, -1502002290), d2, l2, s2[g + 15], 22, 1236535329), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 1], 5, -165796510), u2, f2, s2[g + 6], 9, -1069501632), l2, u2, s2[g + 11], 14, 643717713), d2, l2, s2[g + 0], 20, -373897302), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 5], 5, -701558691), u2, f2, s2[g + 10], 9, 38016083), l2, u2, s2[g + 15], 14, -660478335), d2, l2, s2[g + 4], 20, -405537848), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 9], 5, 568446438), u2, f2, s2[g + 14], 9, -1019803690), l2, u2, s2[g + 3], 14, -187363961), d2, l2, s2[g + 8], 20, 1163531501), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 13], 5, -1444681467), u2, f2, s2[g + 2], 9, -51403784), l2, u2, s2[g + 7], 14, 1735328473), d2, l2, s2[g + 12], 20, -1926607734), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 5], 4, -378558), u2, f2, s2[g + 8], 11, -2022574463), l2, u2, s2[g + 11], 16, 1839030562), d2, l2, s2[g + 14], 23, -35309556), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 1], 4, -1530992060), u2, f2, s2[g + 4], 11, 1272893353), l2, u2, s2[g + 7], 16, -155497632), d2, l2, s2[g + 10], 23, -1094730640), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 13], 4, 681279174), u2, f2, s2[g + 0], 11, -358537222), l2, u2, s2[g + 3], 16, -722521979), d2, l2, s2[g + 6], 23, 76029189), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 9], 4, -640364487), u2, f2, s2[g + 12], 11, -421815835), l2, u2, s2[g + 15], 16, 530742520), d2, l2, s2[g + 2], 23, -995338651), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 0], 6, -198630844), u2, f2, s2[g + 7], 10, 1126891415), l2, u2, s2[g + 14], 15, -1416354905), d2, l2, s2[g + 5], 21, -57434055), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 12], 6, 1700485571), u2, f2, s2[g + 3], 10, -1894986606), l2, u2, s2[g + 10], 15, -1051523), d2, l2, s2[g + 1], 21, -2054922799), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 8], 6, 1873313359), u2, f2, s2[g + 15], 10, -30611744), l2, u2, s2[g + 6], 15, -1560198380), d2, l2, s2[g + 13], 21, 1309151649), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 4], 6, -145523070), u2, f2, s2[g + 11], 10, -1120210379), l2, u2, s2[g + 2], 15, 718787259), d2, l2, s2[g + 9], 21, -343485551), l2 = l2 + y >>> 0, u2 = u2 + j >>> 0, f2 = f2 + S >>> 0, d2 = d2 + v >>> 0;
            }
            return n2.endian([l2, u2, f2, d2]);
          };
          i2._ff = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (n3 & r3 | ~n3 & e3) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._gg = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (n3 & e3 | r3 & ~e3) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._hh = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (n3 ^ r3 ^ e3) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._ii = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (r3 ^ (n3 | ~e3)) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._blocksize = 16, i2._digestsize = 16, t2.exports = function(t3, r3) {
            if (void 0 === t3 || null === t3)
              throw new Error("Illegal argument " + t3);
            var e3 = n2.wordsToBytes(i2(t3, r3));
            return r3 && r3.asBytes ? e3 : r3 && r3.asString ? o2.bytesToString(e3) : n2.bytesToHex(e3);
          };
        }();
      });
      return c;
    });
  }
});

// src/vendor/musicSdk/kg/util.js
var require_util2 = __commonJS({
  "src/vendor/musicSdk/kg/util.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createHttpFetch = exports2.signatureParams = void 0;
    var utils_1 = require_utils();
    var request_1 = require_request();
    var signatureParams = (params, platform = "android", body = "") => {
      let keyparam = "OIlwieks28dk2k092lksi2UIkp";
      if (platform === "web")
        keyparam = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
      let param_list = params.split("&");
      param_list.sort();
      let sign_params = `${keyparam}${param_list.join("")}${body}${keyparam}`;
      return (0, utils_1.toMD5)(sign_params);
    };
    exports2.signatureParams = signatureParams;
    var createHttpFetch = async (url, options, retryNum = 0) => {
      if (retryNum > 2)
        throw new Error("try max num");
      let result;
      try {
        result = await (0, request_1.httpFetch)(url, options).promise;
      } catch (err) {
        console.log(err);
        return (0, exports2.createHttpFetch)(url, options, ++retryNum);
      }
      if (result.statusCode !== 200 || (result.body.error_code ?? result.body.errcode ?? result.body.err_code) != 0)
        return (0, exports2.createHttpFetch)(url, options, ++retryNum);
      if (result.body.data)
        return result.body.data;
      if (Array.isArray(result.body.info))
        return result.body;
      return result.body.info;
    };
    exports2.createHttpFetch = createHttpFetch;
  }
});

// src/vendor/musicSdk/kg/songList.js
var require_songList2 = __commonJS({
  "src/vendor/musicSdk/kg/songList.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var infSign_min_1 = __importDefault(require_infSign_min());
    var util_1 = require_util2();
    var handleSignature = (id, page, limit) => new Promise((resolve, reject) => {
      (0, infSign_min_1.default)({ appid: 1058, type: 0, module: "playlist", page, pagesize: limit, specialid: id }, null, {
        useH5: true,
        isCDN: true,
        callback(i) {
          resolve(i.signature);
        }
      });
    });
    exports2.default = {
      _requestObj_tags: null,
      _requestObj_listInfo: null,
      _requestObj_list: null,
      _requestObj_listRecommend: null,
      listDetailLimit: 1e4,
      currentTagInfo: {
        id: void 0,
        info: void 0
      },
      sortList: [
        {
          name: "推荐",
          id: "5"
        },
        {
          name: "最热",
          id: "6"
        },
        {
          name: "最新",
          id: "7"
        },
        {
          name: "热藏",
          id: "3"
        },
        {
          name: "飙升",
          id: "8"
        }
      ],
      cache: /* @__PURE__ */ new Map(),
      regExps: {
        listData: /global\.data = (\[.+\]);/,
        listInfo: /global = {[\s\S]+?name: "(.+)"[\s\S]+?pic: "(.+)"[\s\S]+?};/,
        // https://www.kugou.com/yy/special/single/1067062.html
        listDetailLink: /^.+\/(\d+)\.html(?:\?.*|&.*$|#.*$|$)/
      },
      // async getGlobalSpecialId(specialId) {
      //   return httpFetch(`http://mobilecdnbj.kugou.com/api/v5/special/info?specialid=${specialId}`, {
      //     headers: {
      //       'User-Agent': 'Mozilla/5.0 (Linux; Android 10; HLK-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Mobile Safari/537.36 EdgA/104.0.1293.70',
      //     },
      //   }).promise.then(({ body }) => {
      //     // console.log(body)
      //     if (!body.data.global_specialid) Promise.reject(new Error('Failed to get global collection id.'))
      //     return body.data.global_specialid
      //   })
      // },
      // async getListInfoBySpecialId(special_id, retry = 0) {
      //   if (++retry > 2) throw new Error('failed')
      //   return httpFetch(`https://m.kugou.com/plist/list/${special_id}/?json=true`, {
      //     headers: {
      //       'User-Agent': 'Mozilla/5.0 (Linux; Android 10; HLK-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Mobile Safari/537.36 EdgA/104.0.1293.70',
      //     },
      //     follow_max: 2,
      //   }).promise.then(({ body }) => {
      //     // console.log(body)
      //     if (!body.info.list) return this.getListInfoBySpecialId(special_id, retry)
      //     let listinfo = body.info.list
      //     return {
      //       listInfo: {
      //         name: listinfo.specialname,
      //         image: listinfo.imgurl.replace('{size}', '150'),
      //         intro: listinfo.intro,
      //         author: listinfo.nickname,
      //         playcount: listinfo.playcount,
      //         total: listinfo.songcount,
      //       },
      //       globalSpecialId: listinfo.global_specialid,
      //     }
      //   })
      // },
      // async getSongListDetailByGlobalSpecialId(id, page, limit = 100, retry = 0) {
      //   if (++retry > 2) throw new Error('failed')
      //   console.log(id)
      //   const params = `specialid=0&need_sort=1&module=CloudMusic&clientver=11409&pagesize=${limit}&global_collection_id=${id}&userid=0&page=${page}&type=1&area_code=1&appid=1005`
      //   return httpFetch(`http://pubsongscdn.tx.kugou.com/v2/get_other_list_file?${params}&signature=${signatureParams(params)}`).promise.then(({ body }) => {
      //     // console.log(body)
      //     if (body.data?.info == null) return this.getSongListDetailByGlobalSpecialId(id, page, limit, retry)
      //     return body.data.info
      //   })
      // },
      parseHtmlDesc(html) {
        const prefix = '<div class="pc_specail_text pc_singer_tab_content" id="specailIntroduceWrap">';
        let index = html.indexOf(prefix);
        if (index < 0)
          return null;
        const afterStr = html.substring(index + prefix.length);
        index = afterStr.indexOf("</div>");
        if (index < 0)
          return null;
        return (0, index_1.decodeName)(afterStr.substring(0, index));
      },
      async getListDetailBySpecialId(id, page, tryNum = 0) {
        if (tryNum > 2)
          throw new Error("try max num");
        const { body } = await (0, request_1.httpFetch)(this.getSongListDetailUrl(id)).promise;
        let listData = body.match(this.regExps.listData);
        let listInfo = body.match(this.regExps.listInfo);
        if (!listData)
          return this.getListDetailBySpecialId(id, page, ++tryNum);
        let list = await this.getMusicInfos(JSON.parse(listData[1]));
        let name;
        let pic;
        if (listInfo) {
          name = listInfo[1];
          pic = listInfo[2];
        }
        let desc = this.parseHtmlDesc(body);
        return {
          list,
          page: 1,
          limit: 1e4,
          total: list.length,
          source: "kg",
          info: {
            name,
            img: pic,
            desc
            // author: body.result.info.userinfo.username,
            // play_count: formatPlayCount(body.result.listen_num),
          }
        };
      },
      getInfoUrl(tagId) {
        return tagId ? `http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&cdn=cdn&t=5&c=${tagId}` : "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&";
      },
      getSongListUrl(sortId, tagId, page) {
        if (tagId == null)
          tagId = "";
        return `http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=${sortId}&c=${tagId}&p=${page}`;
      },
      getSongListDetailUrl(id) {
        return `http://www2.kugou.kugou.com/yueku/v9/special/single/${id}-5-9999.html`;
      },
      filterInfoHotTag(rawData) {
        const result = [];
        if (rawData.status !== 1)
          return result;
        for (const key of Object.keys(rawData.data)) {
          let tag = rawData.data[key];
          result.push({
            id: tag.special_id,
            name: tag.special_name,
            source: "kg"
          });
        }
        return result;
      },
      filterTagInfo(rawData) {
        const result = [];
        for (const name of Object.keys(rawData)) {
          result.push({
            name,
            list: rawData[name].data.map((tag) => ({
              parent_id: tag.parent_id,
              parent_name: tag.pname,
              id: tag.id,
              name: tag.name,
              source: "kg"
            }))
          });
        }
        return result;
      },
      getSongList(sortId, tagId, page, tryNum = 0) {
        if (this._requestObj_list)
          this._requestObj_list.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_list = (0, request_1.httpFetch)(this.getSongListUrl(sortId, tagId, page));
        return this._requestObj_list.promise.then(({ body }) => {
          if (!body || body.status !== 1)
            return this.getSongList(sortId, tagId, page, ++tryNum);
          return this.filterList(body.special_db);
        });
      },
      getSongListRecommend(tryNum = 0) {
        if (this._requestObj_listRecommend)
          this._requestObj_listRecommend.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_listRecommend = (0, request_1.httpFetch)("http://everydayrec.service.kugou.com/guess_special_recommend", {
          method: "post",
          headers: {
            "User-Agent": "KuGou2012-8275-web_browser_event_handler"
          },
          body: {
            appid: 1001,
            clienttime: 1566798337219,
            clientver: 8275,
            key: "f1f93580115bb106680d2375f8032d96",
            mid: "21511157a05844bd085308bc76ef3343",
            platform: "pc",
            userid: "262643156",
            return_min: 6,
            return_max: 15
          }
        });
        return this._requestObj_listRecommend.promise.then(({ body }) => {
          if (body.status !== 1)
            return this.getSongListRecommend(++tryNum);
          return this.filterList(body.data.special_list);
        });
      },
      filterList(rawData) {
        return rawData.map((item) => ({
          play_count: item.total_play_count || (0, index_1.formatPlayCount)(item.play_count),
          id: "id_" + item.specialid,
          author: item.nickname,
          name: item.specialname,
          time: (0, index_1.dateFormat)(item.publish_time || item.publishtime, "Y-M-D"),
          img: item.img || item.imgurl,
          total: item.songcount,
          grade: item.grade,
          desc: item.intro,
          source: "kg"
        }));
      },
      async createHttp(url, options, retryNum = 0) {
        if (retryNum > 2)
          throw new Error("try max num");
        let result;
        try {
          result = await (0, request_1.httpFetch)(url, options).promise;
        } catch (err) {
          console.log(err);
          return this.createHttp(url, options, ++retryNum);
        }
        if (result.statusCode !== 200 || (result.body.error_code !== void 0 ? result.body.error_code : result.body.errcode !== void 0 ? result.body.errcode : result.body.err_code) !== 0)
          return this.createHttp(url, options, ++retryNum);
        if (result.body.data)
          return result.body.data;
        if (Array.isArray(result.body.info))
          return result.body;
        return result.body.info;
      },
      createTask(hashs) {
        let data = {
          area_code: "1",
          show_privilege: 1,
          show_album_info: "1",
          is_publish: "",
          appid: 1005,
          clientver: 11451,
          mid: "1",
          dfid: "-",
          clienttime: Date.now(),
          key: "OIlwieks28dk2k092lksi2UIkp",
          fields: "album_info,author_name,audio_info,ori_audio_name,base,songname,classification,img,album_img"
        };
        let list = hashs;
        let tasks = [];
        while (list.length) {
          tasks.push(Object.assign({ data: list.slice(0, 100) }, data));
          if (list.length < 100)
            break;
          list = list.slice(100);
        }
        let url = "http://gateway.kugou.com/v3/album_audio/audio";
        return tasks.map((task) => this.createHttp(url, {
          method: "POST",
          body: task,
          headers: {
            "KG-THash": "13a3164",
            "KG-RC": "1",
            "KG-Fake": "0",
            "KG-RF": "00869891",
            "User-Agent": "Android712-AndroidPhone-11451-376-0-FeeCacheUpdate-wifi",
            "x-router": "kmr.service.kugou.com"
          }
        }).then((data2) => data2.map((s) => s[0])));
      },
      async getMusicInfos(list) {
        return this.filterData2(await Promise.all(this.createTask(this.deDuplication(list).map((item) => ({ hash: item.hash })))).then(([...datas]) => datas.flat()));
      },
      async getUserListDetailByCode(id) {
        const songInfo = await this.createHttp("http://t.kugou.com/command/", {
          method: "POST",
          headers: {
            "KG-RC": 1,
            "KG-THash": "network_super_call.cpp:3676261689:379",
            "User-Agent": ""
          },
          body: { appid: 1001, clientver: 9020, mid: "21511157a05844bd085308bc76ef3343", clienttime: 640612895, key: "36164c4015e704673c588ee202b9ecb8", data: id }
        });
        let songList;
        let info = songInfo.info;
        switch (info.type) {
          case 2:
            if (!info.global_collection_id)
              return this.getListDetailBySpecialId(info.id);
            break;
          default:
            break;
        }
        if (info.global_collection_id)
          return this.getUserListDetail2(info.global_collection_id);
        if (info.userid != null) {
          songList = await this.createHttp("http://www2.kugou.kugou.com/apps/kucodeAndShare/app/", {
            method: "POST",
            headers: {
              "KG-RC": 1,
              "KG-THash": "network_super_call.cpp:3676261689:379",
              "User-Agent": ""
            },
            body: { appid: 1001, clientver: 9020, mid: "21511157a05844bd085308bc76ef3343", clienttime: 640612895, key: "36164c4015e704673c588ee202b9ecb8", data: { id: info.id, type: 3, userid: info.userid, collect_type: 0, page: 1, pagesize: info.count } }
          });
        }
        let list = await this.getMusicInfos(songList || songInfo.list);
        return {
          list,
          page: 1,
          limit: info.count,
          total: list.length,
          source: "kg",
          info: {
            name: info.name,
            img: info.img_size && info.img_size.replace("{size}", "1000") || info.img,
            // desc: body.result.info.list_desc,
            author: info.username
            // play_count: formatPlayCount(info.count),
          }
        };
      },
      async getUserListDetail3(chain, page) {
        const songInfo = await this.createHttp(`http://m.kugou.com/schain/transfer?pagesize=${this.listDetailLimit}&chain=${chain}&su=1&page=${page}&n=0.7928855356604456`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
          }
        });
        if (!songInfo.list) {
          if (songInfo.global_collection_id)
            return this.getUserListDetail2(songInfo.global_collection_id);
          else
            return this.getUserListDetail4(songInfo, chain, page).catch(() => this.getUserListDetail5(chain));
        }
        let list = await this.getMusicInfos(songInfo.list);
        return {
          list,
          page: 1,
          limit: this.listDetailLimit,
          total: list.length,
          source: "kg",
          info: {
            name: songInfo.info.name,
            img: songInfo.info.img,
            // desc: body.result.info.list_desc,
            author: songInfo.info.username
            // play_count: formatPlayCount(info.count),
          }
        };
      },
      deDuplication(datas) {
        let ids = /* @__PURE__ */ new Set();
        return datas.filter(({ hash }) => {
          if (ids.has(hash))
            return false;
          ids.add(hash);
          return true;
        });
      },
      async decodeGcid(gcid) {
        const params = "dfid=-&appid=1005&mid=0&clientver=20109&clienttime=640612895&uuid=-";
        const body = {
          ret_info: 1,
          data: [
            {
              id: gcid,
              id_type: 2
            }
          ]
        };
        const result = await this.createHttp(`https://t.kugou.com/v1/songlist/batch_decode?${params}&signature=${(0, util_1.signatureParams)(params, "android", JSON.stringify(body))}`, {
          method: "POST",
          headers: {
            "User-Agent": "Mozilla/5.0 (Linux; Android 10; HUAWEI HMA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36",
            Referer: "https://m.kugou.com/"
          },
          body
        });
        return result.list[0].global_collection_id;
      },
      async getUserListDetailByLink({ info }, link) {
        let listInfo = info["0"];
        let total = listInfo.count;
        let tasks = [];
        let page = 0;
        while (total) {
          const limit = total > 90 ? 90 : total;
          total -= limit;
          page += 1;
          tasks.push(this.createHttp(link.replace(/pagesize=\d+/, "pagesize=" + limit).replace(/page=\d+/, "page=" + page), {
            headers: {
              "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1",
              Referer: link
            }
          }).then((data) => data.list.info));
        }
        let result = await Promise.all(tasks).then(([...datas]) => datas.flat());
        result = await this.getMusicInfos(result);
        return {
          list: result,
          page,
          limit: this.listDetailLimit,
          total: result.length,
          source: "kg",
          info: {
            name: listInfo.name,
            img: listInfo.pic && listInfo.pic.replace("{size}", "1000"),
            // desc: body.result.info.list_desc,
            author: listInfo.list_create_username
            // play_count: formatPlayCount(listInfo.count),
          }
        };
      },
      createGetListDetail2Task(id, total) {
        let tasks = [];
        let page = 0;
        while (total) {
          const limit = total > 300 ? 300 : total;
          total -= limit;
          page += 1;
          const params = "appid=1058&global_specialid=" + id + "&specialid=0&plat=0&version=8000&page=" + page + "&pagesize=" + limit + "&srcappid=2919&clientver=20000&clienttime=1586163263991&mid=1586163263991&uuid=1586163263991&dfid=-";
          tasks.push(this.createHttp(`https://mobiles.kugou.com/api/v5/special/song_v2?${params}&signature=${(0, util_1.signatureParams)(params, "web")}`, {
            headers: {
              mid: "1586163263991",
              Referer: "https://m3ws.kugou.com/share/index.php",
              "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1",
              dfid: "-",
              clienttime: "1586163263991"
            }
          }).then((data) => data.info));
        }
        return Promise.all(tasks).then(([...datas]) => datas.flat());
      },
      async getUserListDetail2(global_collection_id) {
        let id = global_collection_id;
        if (id.length > 1e3)
          throw new Error("get list error");
        const params = "appid=1058&specialid=0&global_specialid=" + id + "&format=jsonp&srcappid=2919&clientver=20000&clienttime=1586163242519&mid=1586163242519&uuid=1586163242519&dfid=-";
        let info = await this.createHttp(`https://mobiles.kugou.com/api/v5/special/info_v2?${params}&signature=${(0, util_1.signatureParams)(params, "web")}`, {
          headers: {
            mid: "1586163242519",
            Referer: "https://m3ws.kugou.com/share/index.php",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1",
            dfid: "-",
            clienttime: "1586163242519"
          }
        });
        const songInfo = await this.createGetListDetail2Task(id, info.songcount);
        let list = await this.getMusicInfos(songInfo);
        return {
          list,
          page: 1,
          limit: this.listDetailLimit,
          total: list.length,
          source: "kg",
          info: {
            name: info.specialname,
            img: info.imgurl && info.imgurl.replace("{size}", "1000"),
            desc: info.intro,
            author: info.nickname,
            play_count: (0, index_1.formatPlayCount)(info.playcount)
          }
        };
      },
      async getListInfoByChain(chain) {
        if (this.cache.has(chain))
          return this.cache.get(chain);
        const { body } = await (0, request_1.httpFetch)(`https://m.kugou.com/share/?chain=${chain}&id=${chain}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
          }
        }).promise;
        let result = body.match(/var\sphpParam\s=\s({.+?});/);
        if (result)
          result = JSON.parse(result[1]);
        this.cache.set(chain, result);
        return result;
      },
      async getUserListDetailByPcChain(chain) {
        let key = `${chain}_pc_list`;
        if (this.cache.has(key))
          return this.cache.get(key);
        const { body } = await (0, request_1.httpFetch)(`http://www.kugou.com/share/${chain}.html`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36"
          }
        }).promise;
        let result = body.match(/var\sdataFromSmarty\s=\s(\[.+?\])/);
        if (result)
          result = JSON.parse(result[1]);
        this.cache.set(chain, result);
        result = await this.getMusicInfos(result);
        return result;
      },
      async getUserListDetail4(songInfo, chain, page) {
        const limit = 100;
        const [listInfo, list] = await Promise.all([
          this.getListInfoByChain(chain),
          this.getUserListDetailById(songInfo.id, page, limit)
        ]);
        return {
          list: list || [],
          page,
          limit,
          total: list.length ?? 0,
          source: "kg",
          info: {
            name: listInfo.specialname,
            img: listInfo.imgurl && listInfo.imgurl.replace("{size}", "1000"),
            // desc: body.result.info.list_desc,
            author: listInfo.nickname
            // play_count: formatPlayCount(info.count),
          }
        };
      },
      async getUserListDetail5(chain) {
        const [listInfo, list] = await Promise.all([
          this.getListInfoByChain(chain),
          this.getUserListDetailByPcChain(chain)
        ]);
        return {
          list: list || [],
          page: 1,
          limit: this.listDetailLimit,
          total: list.length ?? 0,
          source: "kg",
          info: {
            name: listInfo.specialname,
            img: listInfo.imgurl && listInfo.imgurl.replace("{size}", "1000"),
            // desc: body.result.info.list_desc,
            author: listInfo.nickname
            // play_count: formatPlayCount(info.count),
          }
        };
      },
      async getUserListDetailById(id, page, limit) {
        const signature = await handleSignature(id, page, limit);
        let info = await this.createHttp(`https://pubsongscdn.kugou.com/v2/get_other_list_file?srcappid=2919&clientver=20000&appid=1058&type=0&module=playlist&page=${page}&pagesize=${limit}&specialid=${id}&signature=${signature}`, {
          headers: {
            Referer: "https://m3ws.kugou.com/share/index.php",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1",
            dfid: "-"
          }
        });
        let result = await this.getMusicInfos(info.info);
        return result;
      },
      async getUserListDetail(link, page, retryNum = 0) {
        if (retryNum > 3)
          return Promise.reject(new Error("link try max num"));
        if (link.includes("#"))
          link = link.replace(/#.*$/, "");
        if (link.includes("global_collection_id"))
          return this.getUserListDetail2(link.replace(/^.*?global_collection_id=(\w+)(?:&.*$|#.*$|$)/, "$1"));
        if (link.includes("gcid_")) {
          let gcid = link.match(/gcid_\w+/)?.[0];
          if (gcid) {
            const global_collection_id = await this.decodeGcid(gcid);
            if (global_collection_id)
              return this.getUserListDetail2(global_collection_id);
          }
        }
        if (link.includes("chain="))
          return this.getUserListDetail3(link.replace(/^.*?chain=(\w+)(?:&.*$|#.*$|$)/, "$1"), page);
        if (link.includes(".html")) {
          if (link.includes("zlist.html")) {
            link = link.replace(/^(.*)zlist\.html/, "https://m3ws.kugou.com/zlist/list");
            if (link.includes("pagesize")) {
              link = link.replace("pagesize=30", "pagesize=" + this.listDetailLimit).replace("page=1", "page=" + page);
            } else {
              link += `&pagesize=${this.listDetailLimit}&page=${page}`;
            }
          } else if (!link.includes("song.html"))
            return this.getUserListDetail3(link.replace(/.+\/(\w+).html(?:\?.*|&.*$|#.*$|$)/, "$1"), page);
        }
        const requestObj_listDetailLink = (0, request_1.httpFetch)(link, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1",
            Referer: link
          }
        });
        const { headers: { location }, statusCode, body } = await requestObj_listDetailLink.promise;
        if (statusCode > 400)
          return this.getUserListDetail(link, page, ++retryNum);
        if (location) {
          if (location.includes("global_collection_id"))
            return this.getUserListDetail2(location.replace(/^.*?global_collection_id=(\w+)(?:&.*$|#.*$|$)/, "$1"));
          if (location.includes("gcid_")) {
            let gcid = link.match(/gcid_\w+/)?.[0];
            if (gcid) {
              const global_collection_id = await this.decodeGcid(gcid);
              if (global_collection_id)
                return this.getUserListDetail2(global_collection_id);
            }
          }
          if (location.includes("chain="))
            return this.getUserListDetail3(location.replace(/^.*?chain=(\w+)(?:&.*$|#.*$|$)/, "$1"), page);
          if (location.includes(".html")) {
            if (location.includes("zlist.html")) {
              let link2 = location.replace(/^(.*)zlist\.html/, "https://m3ws.kugou.com/zlist/list");
              if (link2.includes("pagesize")) {
                link2 = link2.replace("pagesize=30", "pagesize=" + this.listDetailLimit).replace("page=1", "page=" + page);
              } else {
                link2 += `&pagesize=${this.listDetailLimit}&page=${page}`;
              }
              return this.getUserListDetail(link2, page, ++retryNum);
            } else
              return this.getUserListDetail3(location.replace(/.+\/(\w+).html(?:\?.*|&.*$|#.*$|$)/, "$1"), page);
          }
          return this.getUserListDetail(location, page, ++retryNum);
        }
        if (typeof body == "string") {
          let global_collection_id = body.match(/"global_collection_id":"(\w+)"/)?.[1];
          if (!global_collection_id) {
            let gcid = body.match(/"encode_gic":"(\w+)"/)?.[1];
            if (!gcid)
              gcid = body.match(/"encode_src_gid":"(\w+)"/)?.[1];
            if (gcid)
              global_collection_id = await this.decodeGcid(gcid);
          }
          if (!global_collection_id)
            throw new Error("get list error");
          return this.getUserListDetail2(global_collection_id);
        }
        if (body.errcode !== 0)
          return this.getUserListDetail(link, page, ++retryNum);
        return this.getUserListDetailByLink(body, link);
      },
      async getListDetail(id, page) {
        id = id.toString();
        if (id.includes("special/single/")) {
          id = id.replace(this.regExps.listDetailLink, "$1");
        } else if (/https?:/.test(id)) {
          return this.getUserListDetail(id.replace(/^.*?http/, "http"), page);
        } else if (/^\d+$/.test(id)) {
          return this.getUserListDetailByCode(id);
        } else if (id.startsWith("id_")) {
          id = id.replace("id_", "");
        }
        return this.getListDetailBySpecialId(id, page);
      },
      filterData(rawList) {
        return rawList.map((item) => {
          const types = [];
          const _types = {};
          if (item.filesize !== 0) {
            let size = (0, index_1.sizeFormate)(item.filesize);
            types.push({ type: "128k", size, hash: item.hash });
            _types["128k"] = {
              size,
              hash: item.hash
            };
          }
          if (item.filesize_320 !== 0) {
            let size = (0, index_1.sizeFormate)(item.filesize_320);
            types.push({ type: "320k", size, hash: item.hash_320 });
            _types["320k"] = {
              size,
              hash: item.hash_320
            };
          }
          if (item.filesize_ape !== 0) {
            let size = (0, index_1.sizeFormate)(item.filesize_ape);
            types.push({ type: "ape", size, hash: item.hash_ape });
            _types.ape = {
              size,
              hash: item.hash_ape
            };
          }
          if (item.filesize_flac !== 0) {
            let size = (0, index_1.sizeFormate)(item.filesize_flac);
            types.push({ type: "flac", size, hash: item.hash_flac });
            _types.flac = {
              size,
              hash: item.hash_flac
            };
          }
          return {
            singer: (0, index_1.decodeName)(item.singername),
            name: (0, index_1.decodeName)(item.songname),
            albumName: (0, index_1.decodeName)(item.album_name),
            albumId: item.album_id,
            songmid: item.audio_id,
            source: "kg",
            interval: (0, index_1.formatPlayTime)(item.duration / 1e3),
            img: (item.img || item.album_img || "").replace("{size}", "1000") || null,
            lrc: null,
            hash: item.hash,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      // getSinger(singers) {
      //   let arr = []
      //   singers?.forEach(singer => {
      //     arr.push(singer.name)
      //   })
      //   return arr.join('、')
      // },
      // v9 API
      // filterDatav9(rawList) {
      //   console.log(rawList)
      //   return rawList.map(item => {
      //     const types = []
      //     const _types = {}
      //     item.relate_goods.forEach(qualityObj => {
      //       if (qualityObj.level === 2) {
      //         let size = sizeFormate(qualityObj.size)
      //         types.push({ type: '128k', size, hash: qualityObj.hash })
      //         _types['128k'] = {
      //           size,
      //           hash: qualityObj.hash,
      //         }
      //       } else if (qualityObj.level === 4) {
      //         let size = sizeFormate(qualityObj.size)
      //         types.push({ type: '320k', size, hash: qualityObj.hash })
      //         _types['320k'] = {
      //           size,
      //           hash: qualityObj.hash,
      //         }
      //       } else if (qualityObj.level === 5) {
      //         let size = sizeFormate(qualityObj.size)
      //         types.push({ type: 'flac', size, hash: qualityObj.hash })
      //         _types.flac = {
      //           size,
      //           hash: qualityObj.hash,
      //         }
      //       } else if (qualityObj.level === 6) {
      //         let size = sizeFormate(qualityObj.size)
      //         types.push({ type: 'flac24bit', size, hash: qualityObj.hash })
      //         _types.flac24bit = {
      //           size,
      //           hash: qualityObj.hash,
      //         }
      //       }
      //     })
      //     const nameInfo = item.name.split(' - ')
      //     return {
      //       singer: this.getSinger(item.singerinfo),
      //       name: decodeName((nameInfo[1] ?? nameInfo[0]).trim()),
      //       albumName: decodeName(item.albuminfo.name),
      //       albumId: item.albuminfo.id,
      //       songmid: item.audio_id,
      //       source: 'kg',
      //       interval: formatPlayTime(item.timelen / 1000),
      //       img: null,
      //       lrc: null,
      //       hash: item.hash,
      //       types,
      //       _types,
      //       typeUrl: {},
      //     }
      //   })
      // },
      // hash list filter
      filterData2(rawList) {
        let ids = /* @__PURE__ */ new Set();
        let list = [];
        rawList.forEach((item) => {
          if (!item)
            return;
          if (ids.has(item.audio_info.audio_id))
            return;
          ids.add(item.audio_info.audio_id);
          const types = [];
          const _types = {};
          if (item.audio_info.filesize !== "0") {
            let size = (0, index_1.sizeFormate)(parseInt(item.audio_info.filesize));
            types.push({ type: "128k", size, hash: item.audio_info.hash });
            _types["128k"] = {
              size,
              hash: item.audio_info.hash
            };
          }
          if (item.audio_info.filesize_320 !== "0") {
            let size = (0, index_1.sizeFormate)(parseInt(item.audio_info.filesize_320));
            types.push({ type: "320k", size, hash: item.audio_info.hash_320 });
            _types["320k"] = {
              size,
              hash: item.audio_info.hash_320
            };
          }
          if (item.audio_info.filesize_flac !== "0") {
            let size = (0, index_1.sizeFormate)(parseInt(item.audio_info.filesize_flac));
            types.push({ type: "flac", size, hash: item.audio_info.hash_flac });
            _types.flac = {
              size,
              hash: item.audio_info.hash_flac
            };
          }
          if (item.audio_info.filesize_high !== "0") {
            let size = (0, index_1.sizeFormate)(parseInt(item.audio_info.filesize_high));
            types.push({ type: "flac24bit", size, hash: item.audio_info.hash_high });
            _types.flac24bit = {
              size,
              hash: item.audio_info.hash_high
            };
          }
          list.push({
            singer: (0, index_1.decodeName)(item.author_name),
            name: (0, index_1.decodeName)(item.songname),
            albumName: (0, index_1.decodeName)(item.album_info.album_name),
            albumId: item.album_info.album_id,
            songmid: item.audio_info.audio_id,
            source: "kg",
            interval: (0, index_1.formatPlayTime)(parseInt(item.audio_info.timelength) / 1e3),
            img: (item.img || item.album_info?.sizable_cover || item.audio_info?.trans_param?.union_cover || item.album_info?.pic || item.album_info?.img || item.album_info?.s_img || "").replace("{size}", "1000") || null,
            lrc: null,
            hash: item.audio_info.hash,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          });
        });
        return list;
      },
      // 获取列表信息
      getListInfo(tagId, tryNum = 0) {
        if (this._requestObj_listInfo)
          this._requestObj_listInfo.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_listInfo = (0, request_1.httpFetch)(this.getInfoUrl(tagId));
        return this._requestObj_listInfo.promise.then(({ body }) => {
          if (body.status !== 1)
            return this.getListInfo(tagId, ++tryNum);
          return {
            limit: body.data.params.pagesize,
            page: body.data.params.p,
            total: body.data.params.total,
            source: "kg"
          };
        });
      },
      // 获取列表数据
      getList(sortId, tagId, page) {
        let tasks = [this.getSongList(sortId, tagId, page)];
        tasks.push(this.currentTagInfo.id === tagId ? Promise.resolve(this.currentTagInfo.info) : this.getListInfo(tagId).then((info) => {
          this.currentTagInfo.id = tagId;
          this.currentTagInfo.info = Object.assign({}, info);
          return info;
        }));
        if (!tagId && page === 1 && sortId === this.sortList[0].id)
          tasks.push(this.getSongListRecommend());
        return Promise.all(tasks).then(([list, info, recommendList]) => {
          if (recommendList)
            list.unshift(...recommendList);
          return {
            list,
            ...info
          };
        });
      },
      // 获取标签
      getTags(tryNum = 0) {
        if (this._requestObj_tags)
          this._requestObj_tags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_tags = (0, request_1.httpFetch)(this.getInfoUrl());
        return this._requestObj_tags.promise.then(({ body }) => {
          if (body.status !== 1)
            return this.getTags(++tryNum);
          return {
            hotTag: this.filterInfoHotTag(body.data.hotTag),
            tags: this.filterTagInfo(body.data.tagids),
            source: "kg"
          };
        });
      },
      getDetailPageUrl(id) {
        if (typeof id == "string") {
          if (/^https?:\/\//.test(id))
            return id;
          id = id.replace("id_", "");
        }
        return `https://www.kugou.com/yy/special/single/${id}.html`;
      },
      search(text, page, limit = 20) {
        return (0, request_1.httpFetch)(`http://msearchretry.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(text)}&page=${page}&pagesize=${limit}&showtype=10&filter=0&version=7910&sver=2`).promise.then(({ body }) => {
          if (body.errcode != 0)
            throw new Error("filed");
          return {
            list: body.data.info.map((item) => {
              return {
                play_count: (0, index_1.formatPlayCount)(item.playcount),
                id: "id_" + item.specialid,
                author: item.nickname,
                name: item.specialname,
                time: (0, index_1.dateFormat)(item.publishtime, "Y-M-D"),
                img: item.imgurl,
                grade: item.grade,
                desc: item.intro,
                total: item.songcount,
                source: "kg"
              };
            }),
            limit,
            total: body.data.total,
            source: "kg"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/kg/musicSearch.js
var require_musicSearch2 = __commonJS({
  "src/vendor/musicSdk/kg/musicSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var utils_1 = require_utils();
    exports2.default = {
      limit: 30,
      total: 0,
      page: 0,
      allPage: 1,
      musicSearch(str, page, limit) {
        const searchRequest = (0, request_1.httpFetch)(`https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`);
        return searchRequest.promise.then(({ body }) => body);
      },
      filterData(rawData) {
        const types = [];
        const _types = {};
        if (rawData.FileSize !== 0) {
          let size = (0, index_1.sizeFormate)(rawData.FileSize);
          types.push({ type: "128k", size, hash: rawData.FileHash });
          _types["128k"] = {
            size,
            hash: rawData.FileHash
          };
        }
        if (rawData.HQFileSize !== 0) {
          let size = (0, index_1.sizeFormate)(rawData.HQFileSize);
          types.push({ type: "320k", size, hash: rawData.HQFileHash });
          _types["320k"] = {
            size,
            hash: rawData.HQFileHash
          };
        }
        if (rawData.SQFileSize !== 0) {
          let size = (0, index_1.sizeFormate)(rawData.SQFileSize);
          types.push({ type: "flac", size, hash: rawData.SQFileHash });
          _types.flac = {
            size,
            hash: rawData.SQFileHash
          };
        }
        if (rawData.ResFileSize !== 0) {
          let size = (0, index_1.sizeFormate)(rawData.ResFileSize);
          types.push({ type: "flac24bit", size, hash: rawData.ResFileHash });
          _types.flac24bit = {
            size,
            hash: rawData.ResFileHash
          };
        }
        return {
          singer: (0, index_1.decodeName)((0, utils_1.formatSingerName)(rawData.Singers, "name")),
          name: (0, index_1.decodeName)(rawData.SongName),
          albumName: (0, index_1.decodeName)(rawData.AlbumName),
          albumId: rawData.AlbumID,
          songmid: rawData.Audioid,
          source: "kg",
          interval: (0, index_1.formatPlayTime)(rawData.Duration),
          _interval: rawData.Duration,
          img: rawData.Image ? rawData.Image.replace("{size}", "1000") : rawData.trans_param?.union_cover?.replace("{size}", "1000") || null,
          lrc: null,
          otherSource: null,
          hash: rawData.FileHash,
          types,
          _types,
          typeUrl: {}
        };
      },
      handleResult(rawData) {
        let ids = /* @__PURE__ */ new Set();
        const list = [];
        rawData.forEach((item) => {
          const key = item.Audioid + item.FileHash;
          if (ids.has(key))
            return;
          ids.add(key);
          list.push(this.filterData(item));
          for (const childItem of item.Grp) {
            const key2 = item.Audioid + item.FileHash;
            if (ids.has(key2))
              continue;
            ids.add(key2);
            list.push(this.filterData(childItem));
          }
        });
        return list;
      },
      search(str, page = 1, limit, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        if (limit == null)
          limit = this.limit;
        return this.musicSearch(str, page, limit).then((result) => {
          if (!result || result.error_code !== 0)
            return this.search(str, page, limit, retryNum);
          let list = this.handleResult(result.data.lists);
          if (list == null)
            return this.search(str, page, limit, retryNum);
          this.total = result.data.total;
          this.page = page;
          this.allPage = Math.ceil(this.total / limit);
          return Promise.resolve({
            list,
            allPage: this.allPage,
            limit,
            total: this.total,
            source: "kg"
          });
        });
      }
    };
  }
});

// src/vendor/musicSdk/kg/pic.js
var require_pic2 = __commonJS({
  "src/vendor/musicSdk/kg/pic.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      getPic(songInfo) {
        const requestObj = (0, request_1.httpFetch)("http://media.store.kugou.com/v1/get_res_privilege", {
          method: "POST",
          headers: {
            "KG-RC": 1,
            "KG-THash": "expand_search_manager.cpp:852736169:451",
            "User-Agent": "KuGou2012-9020-ExpandSearchManager"
          },
          body: {
            appid: 1001,
            area_code: "1",
            behavior: "play",
            clientver: "9020",
            need_hash_offset: 1,
            relate: 1,
            resource: [
              {
                album_audio_id: songInfo.songmid.length == 32 ? songInfo.audioId.split("_")[0] : songInfo.songmid,
                album_id: songInfo.albumId,
                hash: songInfo.hash,
                id: 0,
                name: `${songInfo.singer} - ${songInfo.name}.mp3`,
                type: "audio"
              }
            ],
            token: "",
            userid: 2626431536,
            vip: 1
          }
        });
        return requestObj.promise.then(({ body }) => {
          if (body.error_code !== 0)
            return Promise.reject(new Error("图片获取失败"));
          let info = body.data[0].info;
          const img = info.image ? info.image.replace("{size}", "1000") : "";
          if (!img)
            return Promise.reject(new Error("Pic get failed"));
          return img;
        });
      }
    };
  }
});

// utils/lyricUtils/util.js
var require_util3 = __commonJS({
  "utils/lyricUtils/util.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.decodeName = void 0;
    var encodeNames = {
      "&nbsp;": " ",
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
      "&#039;": "'"
    };
    var decodeName = (str = "") => {
      return str?.replace(/(?:&amp;|&lt;|&gt;|&quot;|&apos;|&#039;|&nbsp;)/gm, (s) => encodeNames[s]) ?? "";
    };
    exports2.decodeName = decodeName;
  }
});

// utils/lyricUtils/kg.js
var require_kg = __commonJS({
  "utils/lyricUtils/kg.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.decodeKrc = void 0;
    var zlib_1 = require("zlib");
    var util_1 = require_util3();
    var enc_key = Buffer.from([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105], "binary");
    var decodeLyric = (str) => new Promise((resolve, reject) => {
      if (!str.length)
        return;
      const buf_str = Buffer.from(str, "base64").subarray(4);
      for (let i = 0, len = buf_str.length; i < len; i++) {
        buf_str[i] = buf_str[i] ^ enc_key[i % 16];
      }
      (0, zlib_1.inflate)(buf_str, (err, result) => {
        if (err)
          return reject(err);
        resolve(result.toString());
      });
    });
    var headExp = /^.*\[id:\$\w+\]\n/;
    var parseLyric = (str) => {
      str = str.replace(/\r/g, "");
      if (headExp.test(str))
        str = str.replace(headExp, "");
      let trans = str.match(/\[language:([\w=\\/+]+)\]/);
      let lyric;
      let rlyric;
      let tlyric;
      if (trans) {
        str = str.replace(/\[language:[\w=\\/+]+\]\n/, "");
        let json = JSON.parse(Buffer.from(trans[1], "base64").toString());
        for (const item of json.content) {
          switch (item.type) {
            case 0:
              rlyric = item.lyricContent;
              break;
            case 1:
              tlyric = item.lyricContent;
              break;
          }
        }
      }
      let i = 0;
      let lxlyric = str.replace(/\[((\d+),\d+)\].*/g, (str2) => {
        let result = str2.match(/\[((\d+),\d+)\].*/);
        let time = parseInt(result[2]);
        let ms = time % 1e3;
        time /= 1e3;
        let m = parseInt(time / 60).toString().padStart(2, "0");
        time %= 60;
        let s = parseInt(time).toString().padStart(2, "0");
        time = `${m}:${s}.${ms}`;
        if (rlyric)
          rlyric[i] = `[${time}]${rlyric[i]?.join("") ?? ""}`;
        if (tlyric)
          tlyric[i] = `[${time}]${tlyric[i]?.join("") ?? ""}`;
        i++;
        return str2.replace(result[1], time);
      });
      rlyric = rlyric ? rlyric.join("\n") : "";
      tlyric = tlyric ? tlyric.join("\n") : "";
      lxlyric = lxlyric.replace(/<(\d+,\d+),\d+>/g, "<$1>");
      lxlyric = (0, util_1.decodeName)(lxlyric);
      lyric = lxlyric.replace(/<\d+,\d+>/g, "");
      rlyric = (0, util_1.decodeName)(rlyric);
      tlyric = (0, util_1.decodeName)(tlyric);
      return {
        lyric,
        tlyric,
        rlyric,
        lxlyric
      };
    };
    var decodeKrc = async (data) => {
      return decodeLyric(data).then(parseLyric);
    };
    exports2.decodeKrc = decodeKrc;
  }
});

// src/vendor/musicSdk/kg/lyric.js
var require_lyric2 = __commonJS({
  "src/vendor/musicSdk/kg/lyric.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var kg_1 = require_kg();
    exports2.default = {
      getIntv(interval) {
        if (!interval)
          return 0;
        let intvArr = interval.split(":");
        let intv = 0;
        let unit = 1;
        while (intvArr.length) {
          intv += intvArr.pop() * unit;
          unit *= 60;
        }
        return parseInt(intv);
      },
      // getLyric(songInfo, tryNum = 0) {
      //   let requestObj = httpFetch(`http://m.kugou.com/app/i/krc.php?cmd=100&keyword=${encodeURIComponent(songInfo.name)}&hash=${songInfo.hash}&timelength=${songInfo._interval || this.getIntv(songInfo.interval)}&d=0.38664927426725626`, {
      //     headers: {
      //       'KG-RC': 1,
      //       'KG-THash': 'expand_search_manager.cpp:852736169:451',
      //       'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
      //     },
      //   })
      //   requestObj.promise = requestObj.promise.then(({ body, statusCode }) => {
      //     if (statusCode !== 200) {
      //       if (tryNum > 5) return Promise.reject(new Error('歌词获取失败'))
      //       let tryRequestObj = this.getLyric(songInfo, ++tryNum)
      //       requestObj.cancelHttp = tryRequestObj.cancelHttp.bind(tryRequestObj)
      //       return tryRequestObj.promise
      //     }
      //     return {
      //       lyric: body,
      //       tlyric: '',
      //     }
      //   })
      //   return requestObj
      // },
      searchLyric(name, hash, time, tryNum = 0) {
        const url = `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(name)}&hash=${hash}&timelength=${time}&lrctxt=1`;
        let requestObj = (0, request_1.httpFetch)(url, {
          headers: {
            "KG-RC": 1,
            "KG-THash": "expand_search_manager.cpp:852736169:451",
            "User-Agent": "KuGou2012-9020-ExpandSearchManager"
          }
        });
        requestObj.promise = requestObj.promise.then(({ body, statusCode }) => {
          if (statusCode !== 200) {
            if (tryNum > 5)
              return Promise.reject(new Error("歌词获取失败"));
            let tryRequestObj = this.searchLyric(name, hash, time, ++tryNum);
            requestObj.cancelHttp = tryRequestObj.cancelHttp.bind(tryRequestObj);
            return tryRequestObj.promise;
          }
          if (body.candidates && body.candidates.length) {
            let info = body.candidates[0];
            return { id: info.id, accessKey: info.accesskey, fmt: info.krctype == 1 && info.contenttype != 1 ? "krc" : "lrc" };
          }
          return null;
        });
        return requestObj;
      },
      getLyricDownload(id, accessKey, fmt, tryNum = 0) {
        let requestObj = (0, request_1.httpFetch)(`http://lyrics.kugou.com/download?ver=1&client=pc&id=${id}&accesskey=${accessKey}&fmt=${fmt}&charset=utf8`, {
          headers: {
            "KG-RC": 1,
            "KG-THash": "expand_search_manager.cpp:852736169:451",
            "User-Agent": "KuGou2012-9020-ExpandSearchManager"
          }
        });
        requestObj.promise = requestObj.promise.then(({ body, statusCode }) => {
          if (statusCode !== 200) {
            if (tryNum > 5)
              return Promise.reject(new Error("歌词获取失败"));
            let tryRequestObj = this.getLyric(id, accessKey, fmt, ++tryNum);
            requestObj.cancelHttp = tryRequestObj.cancelHttp.bind(tryRequestObj);
            return tryRequestObj.promise;
          }
          switch (body.fmt) {
            case "krc":
              return (0, kg_1.decodeKrc)(body.content);
            case "lrc":
              return {
                lyric: Buffer.from(body.content, "base64").toString("utf-8"),
                tlyric: "",
                rlyric: "",
                lxlyric: ""
              };
            default:
              return Promise.reject(new Error(`未知歌词格式: ${body.fmt}`));
          }
        });
        return requestObj;
      },
      getLyric(songInfo, tryNum = 0) {
        let requestObj = this.searchLyric(songInfo.name, songInfo.hash, songInfo._interval || this.getIntv(songInfo.interval));
        requestObj.promise = requestObj.promise.then((result) => {
          if (!result)
            return Promise.reject(new Error("Get lyric failed"));
          let requestObj2 = this.getLyricDownload(result.id, result.accessKey, result.fmt);
          requestObj.cancelHttp = requestObj2.cancelHttp.bind(requestObj2);
          return requestObj2.promise;
        });
        return requestObj;
      }
    };
  }
});

// src/vendor/musicSdk/kg/hotSearch.js
var require_hotSearch2 = __commonJS({
  "src/vendor/musicSdk/kg/hotSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    exports2.default = {
      _requestObj: null,
      async getList(retryNum = 0) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const _requestObj = (0, request_1.httpFetch)("http://gateway.kugou.com/api/v3/search/hot_tab?signature=ee44edb9d7155821412d220bcaf509dd&appid=1005&clientver=10026&plat=0", {
          method: "get",
          headers: {
            dfid: "1ssiv93oVqMp27cirf2CvoF1",
            mid: "156798703528610303473757548878786007104",
            clienttime: 1584257267,
            "x-router": "msearch.kugou.com",
            "user-agent": "Android9-AndroidPhone-10020-130-0-searchrecommendprotocol-wifi",
            "kg-rc": 1
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.errcode !== 0)
          throw new Error("获取热搜词失败");
        return { source: "kg", list: this.filterList(body.data.list) };
      },
      filterList(rawList) {
        const list = [];
        rawList.forEach((item) => {
          item.keywords.map((k) => list.push((0, index_1.decodeName)(k.keyword)));
        });
        return list;
      }
    };
  }
});

// src/vendor/musicSdk/kg/comment.js
var require_comment2 = __commonJS({
  "src/vendor/musicSdk/kg/comment.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var util_1 = require_util2();
    exports2.default = {
      _requestObj: null,
      _requestObj2: null,
      async getComment({ hash }, page = 1, limit = 20) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        let timestamp = Date.now();
        const params = `dfid=0&mid=16249512204336365674023395779019&clienttime=${timestamp}&uuid=0&extdata=${hash}&appid=1005&code=fc4be23b4e972707f36b8a828a93ba8a&schash=${hash}&clientver=11409&p=${page}&clienttoken=&pagesize=${limit}&ver=10&kugouid=0`;
        const _requestObj = (0, request_1.httpFetch)(`http://m.comment.service.kugou.com/r/v1/rank/newest?${params}&signature=${(0, util_1.signatureParams)(params)}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.24"
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.err_code !== 0)
          throw new Error("获取评论失败");
        const total = body.count ?? 0;
        return { source: "kg", comments: this.filterComment(body.list || []), total, page, limit, maxPage: Math.ceil(total / limit) || 1 };
      },
      async getHotComment({ hash }, page = 1, limit = 20) {
        if (this._requestObj2)
          this._requestObj2.cancelHttp();
        let timestamp = Date.now();
        const params = `dfid=0&mid=16249512204336365674023395779019&clienttime=${timestamp}&uuid=0&extdata=${hash}&appid=1005&code=fc4be23b4e972707f36b8a828a93ba8a&schash=${hash}&clientver=11409&p=${page}&clienttoken=&pagesize=${limit}&ver=10&kugouid=0`;
        const _requestObj2 = (0, request_1.httpFetch)(`http://m.comment.service.kugou.com/r/v1/rank/topliked?${params}&signature=${(0, util_1.signatureParams)(params)}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.24"
          }
        });
        const { body, statusCode } = await _requestObj2.promise;
        if (statusCode != 200 || body.err_code !== 0)
          throw new Error("获取热门评论失败");
        const total = body.count ?? 0;
        return { source: "kg", comments: this.filterComment(body.list || []), total, page, limit, maxPage: Math.ceil(total / limit) || 1 };
      },
      async getReplyComment({ songmid, audioId }, replyId, page = 1, limit = 100) {
        if (this._requestObj2)
          this._requestObj2.cancelHttp();
        songmid = songmid.length == 32 ? audioId.split("_")[0] : songmid;
        const _requestObj2 = (0, request_1.httpFetch)(`http://comment.service.kugou.com/index.php?r=commentsv2/getReplyWithLike&code=fc4be23b4e972707f36b8a828a93ba8a&p=${page}&pagesize=${limit}&ver=1.01&clientver=8373&kugouid=687373022&need_show_image=1&appid=1001&childrenid=${songmid}&tid=${replyId}`, {
          headers: {
            "User-Agent": "Android712-AndroidPhone-8983-18-0-COMMENT-wifi"
          }
        });
        const { body, statusCode } = await _requestObj2.promise;
        if (statusCode != 200 || body.err_code !== 0)
          throw new Error("获取回复评论失败");
        return { source: "kg", comments: this.filterComment(body.list || []) };
      },
      replaceAt(raw, atList) {
        atList.forEach((atobj) => {
          raw = raw.replaceAll(`[at=${atobj.id}]`, `@${atobj.name} `);
        });
        return raw;
      },
      filterComment(rawList) {
        return rawList.map((item) => {
          let data = {
            id: item.id,
            text: (0, index_1.decodeName)((item.atlist ? this.replaceAt(item.content, item.atlist) : item.content) || ""),
            images: item.images ? item.images.map((i) => i.url) : [],
            location: item.location,
            time: item.addtime,
            timeStr: (0, index_1.dateFormat2)(new Date(item.addtime).getTime()),
            userName: item.user_name,
            avatar: item.user_pic,
            userId: item.user_id,
            likedCount: item.like.likenum,
            replyNum: item.reply_num,
            reply: []
          };
          return item.pcontent ? {
            id: item.id,
            text: (0, index_1.decodeName)(item.pcontent),
            time: null,
            userName: item.puser,
            avatar: null,
            userId: item.puser_id,
            likedCount: null,
            replyNum: null,
            reply: [data]
          } : data;
        });
      }
    };
  }
});

// src/vendor/musicSdk/kg/tipSearch.js
var require_tipSearch2 = __commonJS({
  "src/vendor/musicSdk/kg/tipSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var util_1 = require_util2();
    exports2.default = {
      requestObj: null,
      cancelTipSearch() {
        if (this.requestObj && this.requestObj.cancelHttp)
          this.requestObj.cancelHttp();
      },
      tipSearchBySong(str) {
        this.cancelTipSearch();
        this.requestObj = (0, util_1.createHttpFetch)(`https://searchtip.kugou.com/getSearchTip?MusicTipCount=10&keyword=${encodeURIComponent(str)}`, {
          headers: {
            referer: "https://www.kugou.com/"
          }
        });
        return this.requestObj.then((body) => {
          return body[0].RecordDatas;
        });
      },
      handleResult(rawData) {
        return rawData.map((info) => info.HintInfo);
      },
      async search(str) {
        return this.tipSearchBySong(str).then((result) => this.handleResult(result));
      }
    };
  }
});

// src/vendor/musicSdk/kg/index.js
var require_kg2 = __commonJS({
  "src/vendor/musicSdk/kg/index.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var leaderboard_1 = __importDefault(require_leaderboard2());
    var api_source_1 = require_api_source();
    var songList_1 = __importDefault(require_songList2());
    var musicSearch_1 = __importDefault(require_musicSearch2());
    var pic_1 = __importDefault(require_pic2());
    var lyric_1 = __importDefault(require_lyric2());
    var hotSearch_1 = __importDefault(require_hotSearch2());
    var comment_1 = __importDefault(require_comment2());
    var tipSearch_1 = __importDefault(require_tipSearch2());
    var kg = {
      tipSearch: tipSearch_1.default,
      leaderboard: leaderboard_1.default,
      songList: songList_1.default,
      musicSearch: musicSearch_1.default,
      hotSearch: hotSearch_1.default,
      comment: comment_1.default,
      getMusicUrl(songInfo, type) {
        return (0, api_source_1.apis)("kg").getMusicUrl(songInfo, type);
      },
      getLyric(songInfo) {
        return lyric_1.default.getLyric(songInfo);
      },
      // getLyric(songInfo) {
      //   return apis('kg').getLyric(songInfo)
      // },
      getPic(songInfo) {
        return pic_1.default.getPic(songInfo);
      },
      getMusicDetailPageUrl(songInfo) {
        return `https://www.kugou.com/song/#hash=${songInfo.hash}&album_id=${songInfo.albumId}`;
      }
      // getPic(songInfo) {
      //   return apis('kg').getPic(songInfo)
      // },
    };
    exports2.default = kg;
  }
});

// src/vendor/musicSdk/tx/quality.js
var require_quality = __commonJS({
  "src/vendor/musicSdk/tx/quality.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.buildQualitys = void 0;
    var index_1 = require_vendor();
    var getFirstSize = (file, keys) => {
      for (const key of keys) {
        const size = file?.[key];
        if (size != null && size !== 0 && size !== "0")
          return size;
      }
      return null;
    };
    var addQuality = (types, _types, type, rawSize, force = false) => {
      if (_types[type])
        return;
      if (!force && (rawSize == null || rawSize === 0 || rawSize === "0"))
        return;
      if (force && (rawSize == null || rawSize === 0 || rawSize === "0"))
        return;
      const numericSize = Number(rawSize);
      const size = !Number.isFinite(numericSize) || numericSize <= 0 ? null : (0, index_1.sizeFormate)(numericSize);
      const qualityInfo = { size };
      types.push({ type, ...qualityInfo });
      _types[type] = qualityInfo;
    };
    var buildQualitys = (file = {}) => {
      const types = [];
      const _types = {};
      addQuality(types, _types, "128k", file.size_128mp3);
      addQuality(types, _types, "320k", file.size_320mp3);
      addQuality(types, _types, "flac", file.size_flac);
      const hiresSize = getFirstSize(file, ["size_hires", "size_hires24bit", "size_flac24bit"]);
      addQuality(types, _types, "flac24bit", hiresSize, true);
      addQuality(types, _types, "hires", hiresSize, true);
      addQuality(types, _types, "atmos", getFirstSize(file, ["size_atmos", "size_dolby", "size_dolby_atmos", "size_360ra"]), true);
      addQuality(types, _types, "atmos_plus", getFirstSize(file, ["size_atmos_plus", "size_dolby_plus", "size_360ra_plus"]), true);
      addQuality(types, _types, "master", getFirstSize(file, ["size_master", "size_ai_master", "size_new"]), true);
      return { types, _types };
    };
    exports2.buildQualitys = buildQualitys;
  }
});

// src/vendor/musicSdk/tx/leaderboard.js
var require_leaderboard3 = __commonJS({
  "src/vendor/musicSdk/tx/leaderboard.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var utils_1 = require_utils();
    var quality_1 = require_quality();
    var boardList = [{ id: "tx__4", name: "流行指数榜", bangid: "4" }, { id: "tx__26", name: "热歌榜", bangid: "26" }, { id: "tx__27", name: "新歌榜", bangid: "27" }, { id: "tx__62", name: "飙升榜", bangid: "62" }, { id: "tx__58", name: "说唱榜", bangid: "58" }, { id: "tx__57", name: "喜力电音榜", bangid: "57" }, { id: "tx__28", name: "网络歌曲榜", bangid: "28" }, { id: "tx__5", name: "内地榜", bangid: "5" }, { id: "tx__3", name: "欧美榜", bangid: "3" }, { id: "tx__59", name: "香港地区榜", bangid: "59" }, { id: "tx__16", name: "韩国榜", bangid: "16" }, { id: "tx__60", name: "抖快榜", bangid: "60" }, { id: "tx__29", name: "影视金曲榜", bangid: "29" }, { id: "tx__17", name: "日本榜", bangid: "17" }, { id: "tx__52", name: "腾讯音乐人原创榜", bangid: "52" }, { id: "tx__36", name: "K歌金曲榜", bangid: "36" }, { id: "tx__61", name: "台湾地区榜", bangid: "61" }, { id: "tx__63", name: "DJ舞曲榜", bangid: "63" }, { id: "tx__64", name: "综艺新歌榜", bangid: "64" }, { id: "tx__65", name: "国风热歌榜", bangid: "65" }, { id: "tx__67", name: "听歌识曲榜", bangid: "67" }, { id: "tx__72", name: "动漫音乐榜", bangid: "72" }, { id: "tx__73", name: "游戏音乐榜", bangid: "73" }, { id: "tx__75", name: "有声榜", bangid: "75" }, { id: "tx__131", name: "校园音乐人排行榜", bangid: "131" }];
    exports2.default = {
      limit: 300,
      list: [
        {
          id: "txlxzsb",
          name: "流行榜",
          bangid: 4
        },
        {
          id: "txrgb",
          name: "热歌榜",
          bangid: 26
        },
        {
          id: "txwlhgb",
          name: "网络榜",
          bangid: 28
        },
        {
          id: "txdyb",
          name: "抖音榜",
          bangid: 60
        },
        {
          id: "txndb",
          name: "内地榜",
          bangid: 5
        },
        {
          id: "txxgb",
          name: "香港榜",
          bangid: 59
        },
        {
          id: "txtwb",
          name: "台湾榜",
          bangid: 61
        },
        {
          id: "txoumb",
          name: "欧美榜",
          bangid: 3
        },
        {
          id: "txhgb",
          name: "韩国榜",
          bangid: 16
        },
        {
          id: "txrbb",
          name: "日本榜",
          bangid: 17
        },
        {
          id: "txtybb",
          name: "YouTube榜",
          bangid: 128
        }
      ],
      listDetailRequest(id, period, limit) {
        return (0, request_1.httpFetch)("https://u.y.qq.com/cgi-bin/musicu.fcg", {
          method: "post",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"
          },
          body: {
            toplist: {
              module: "musicToplist.ToplistInfoServer",
              method: "GetDetail",
              param: {
                topid: id,
                num: limit,
                period
              }
            },
            comm: {
              uin: 0,
              format: "json",
              ct: 20,
              cv: 1859
            }
          }
        }).promise;
      },
      regExps: {
        periodList: /<i class="play_cover__btn c_tx_link js_icon_play" data-listkey=".+?" data-listname=".+?" data-tid=".+?" data-date=".+?" .+?<\/i>/g,
        period: /data-listname="(.+?)" data-tid=".*?\/(.+?)" data-date="(.+?)" .+?<\/i>/
      },
      periods: {},
      periodUrl: "https://c.y.qq.com/node/pc/wk_v15/top.html",
      _requestBoardsObj: null,
      getBoardsData() {
        if (this._requestBoardsObj)
          this._requestBoardsObj.cancelHttp();
        this._requestBoardsObj = (0, request_1.httpFetch)("https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?g_tk=1928093487&inCharset=utf-8&outCharset=utf-8&notice=0&format=json&uin=0&needNewCode=1&platform=h5");
        return this._requestBoardsObj.promise;
      },
      getData(url) {
        const requestDataObj = (0, request_1.httpFetch)(url);
        return requestDataObj.promise;
      },
      filterData(rawList) {
        return rawList.map((item) => {
          const { types, _types } = (0, quality_1.buildQualitys)(item.file);
          return {
            singer: (0, utils_1.formatSingerName)(item.singer, "name"),
            name: item.title,
            albumName: item.album.name,
            albumId: item.album.mid,
            source: "tx",
            interval: (0, index_1.formatPlayTime)(item.interval),
            songId: item.id,
            albumMid: item.album.mid,
            strMediaMid: item.file.media_mid,
            songmid: item.mid,
            img: item.album.name === "" || item.album.name === "空" ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R800x800M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R800x800M000${item.album.mid}.jpg`,
            lrc: null,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      getPeriods(bangid) {
        return this.getData(this.periodUrl).then(({ body: html }) => {
          let result = html.match(this.regExps.periodList);
          if (!result)
            return Promise.reject(new Error("get data failed"));
          result.forEach((item) => {
            let result2 = item.match(this.regExps.period);
            if (!result2)
              return;
            this.periods[result2[2]] = {
              name: result2[1],
              bangid: result2[2],
              period: result2[3]
            };
          });
          const info = this.periods[bangid];
          return info && info.period;
        });
      },
      filterBoardsData(rawList) {
        let list = [];
        for (const board of rawList) {
          if (board.id == 201)
            continue;
          if (board.topTitle.startsWith("巅峰榜·")) {
            board.topTitle = board.topTitle.substring(4, board.topTitle.length);
          }
          if (!board.topTitle.endsWith("榜"))
            board.topTitle += "榜";
          list.push({
            id: "tx__" + board.id,
            name: board.topTitle,
            bangid: String(board.id)
          });
        }
        return list;
      },
      async getBoards(retryNum = 0) {
        this.list = boardList;
        return {
          list: boardList,
          source: "tx"
        };
      },
      getList(bangid, page, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        bangid = parseInt(bangid);
        let info = this.periods[bangid];
        let p = info ? Promise.resolve(info.period) : this.getPeriods(bangid);
        return p.then((period) => {
          return this.listDetailRequest(bangid, period, this.limit).then((resp) => {
            if (resp.body.code !== 0)
              return this.getList(bangid, page, retryNum);
            return {
              total: resp.body.toplist.data.songInfoList.length,
              list: this.filterData(resp.body.toplist.data.songInfoList),
              limit: this.limit,
              page: 1,
              source: "tx"
            };
          });
        });
      },
      getDetailPageUrl(id) {
        if (typeof id == "string")
          id = id.replace("tx__", "");
        return `https://y.qq.com/n/ryqq/toplist/${id}`;
      }
    };
  }
});

// src/vendor/musicSdk/tx/lyric.js
var require_lyric3 = __commonJS({
  "src/vendor/musicSdk/tx/lyric.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var decodeName = (str = "") => {
      if (!str)
        return "";
      return str.replace(/&#(\d+);/g, (match, dec) => {
        return String.fromCharCode(dec);
      }).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    };
    var b64DecodeUnicode = (str) => {
      return Buffer.from(str, "base64").toString("utf8");
    };
    exports2.default = {
      regexps: {
        matchLrc: /.+"lyric":"([\w=+/]*)".+/
      },
      getLyric(songmid) {
        const songId = songmid.songmid || songmid;
        const requestObj = (0, request_1.httpFetch)(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songId}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq`, {
          headers: {
            Referer: "https://y.qq.com/portal/player.html"
          }
        });
        requestObj.promise = requestObj.promise.then(({ body }) => {
          if (body.code != 0 || !body.lyric)
            return Promise.reject(new Error("Get lyric failed"));
          return {
            lyric: decodeName(b64DecodeUnicode(body.lyric)),
            tlyric: decodeName(b64DecodeUnicode(body.trans))
          };
        });
        return requestObj;
      }
    };
  }
});

// src/vendor/musicSdk/tx/songList.js
var require_songList3 = __commonJS({
  "src/vendor/musicSdk/tx/songList.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var utils_1 = require_utils();
    var quality_1 = require_quality();
    exports2.default = {
      _requestObj_tags: null,
      _requestObj_hotTags: null,
      _requestObj_list: null,
      limit_list: 36,
      limit_song: 1e5,
      successCode: 0,
      sortList: [
        {
          name: "最热",
          id: 5
        },
        {
          name: "最新",
          id: 2
        }
      ],
      regExps: {
        hotTagHtml: /class="c_bg_link js_tag_item" data-id="\w+">.+?<\/a>/g,
        hotTag: /data-id="(\w+)">(.+?)<\/a>/,
        // https://y.qq.com/n/yqq/playlist/7217720898.html
        // https://i.y.qq.com/n2/m/share/details/taoge.html?platform=11&appshare=android_qq&appversion=9050006&id=7217720898&ADTAG=qfshare
        listDetailLink: /\/playlist\/(\d+)/,
        listDetailLink2: /id=(\d+)/
      },
      tagsUrl: "https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=%7B%22tags%22%3A%7B%22method%22%3A%22get_all_categories%22%2C%22param%22%3A%7B%22qq%22%3A%22%22%7D%2C%22module%22%3A%22playlist.PlaylistAllCategoriesServer%22%7D%7D",
      hotTagUrl: "https://c.y.qq.com/node/pc/wk_v15/category_playlist.html",
      getListUrl(sortId, id, page) {
        const order = Number(sortId) || 5;
        if (id) {
          id = parseInt(id);
          return `https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify({
            comm: { cv: 1602, ct: 20 },
            playlist: {
              method: "get_category_content",
              param: {
                titleid: id,
                caller: "0",
                category_id: id,
                size: this.limit_list,
                page: page - 1,
                use_page: 1,
                order,
                sort: order
              },
              module: "playlist.PlayListCategoryServer"
            }
          }))}`;
        }
        return `https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify({
          comm: { cv: 1602, ct: 20 },
          playlist: {
            method: "get_playlist_by_tag",
            param: { id: 1e7, sin: this.limit_list * (page - 1), size: this.limit_list, order, cur_page: page },
            module: "playlist.PlayListPlazaServer"
          }
        }))}`;
      },
      getListDetailUrl(id) {
        return `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${id}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
      },
      // http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=2849349915&pn=0&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1
      // 获取标签
      getTag(tryNum = 0) {
        if (this._requestObj_tags)
          this._requestObj_tags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_tags = (0, request_1.httpFetch)(this.tagsUrl);
        return this._requestObj_tags.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getTag(++tryNum);
          return this.filterTagInfo(body.tags.data.v_group);
        });
      },
      // 获取标签
      getHotTag(tryNum = 0) {
        if (this._requestObj_hotTags)
          this._requestObj_hotTags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_hotTags = (0, request_1.httpFetch)(this.hotTagUrl);
        return this._requestObj_hotTags.promise.then(({ statusCode, body }) => {
          if (statusCode !== 200)
            return this.getHotTag(++tryNum);
          return this.filterInfoHotTag(body);
        });
      },
      filterInfoHotTag(html) {
        let hotTag = html.match(this.regExps.hotTagHtml);
        const hotTags = [];
        if (!hotTag)
          return hotTags;
        hotTag.forEach((tagHtml) => {
          let result = tagHtml.match(this.regExps.hotTag);
          if (!result)
            return;
          hotTags.push({
            id: parseInt(result[1]),
            name: result[2],
            source: "tx"
          });
        });
        return hotTags;
      },
      filterTagInfo(rawList) {
        return rawList.map((type) => ({
          name: type.group_name,
          list: type.v_item.map((item) => ({
            parent_id: type.group_id,
            parent_name: type.group_name,
            id: item.id,
            name: item.name,
            source: "tx"
          }))
        }));
      },
      // 获取列表数据
      getList(sortId, tagId, page, tryNum = 0) {
        if (this._requestObj_list)
          this._requestObj_list.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_list = (0, request_1.httpFetch)(this.getListUrl(sortId, tagId, page));
        return this._requestObj_list.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getList(sortId, tagId, page, ++tryNum);
          return tagId ? this.filterList2(body.playlist.data, page) : this.filterList(body.playlist.data, page);
        });
      },
      filterList(data, page) {
        return {
          list: data.v_playlist.map((item) => ({
            play_count: (0, index_1.formatPlayCount)(item.access_num),
            id: String(item.tid),
            author: item.creator_info.nick,
            name: item.title,
            time: item.modify_time ? (0, index_1.dateFormat)(item.modify_time * 1e3, "Y-M-D") : "",
            img: item.cover_url_medium,
            // grade: item.favorcnt / 10,
            total: item.song_ids?.length,
            desc: (0, index_1.decodeName)(item.desc).replace(/<br>/g, "\n"),
            source: "tx"
          })),
          total: data.total,
          page,
          limit: this.limit_list,
          source: "tx"
        };
      },
      filterList2({ content }, page) {
        return {
          list: content.v_item.map(({ basic }) => ({
            play_count: (0, index_1.formatPlayCount)(basic.play_cnt),
            id: String(basic.tid),
            author: basic.creator.nick,
            name: basic.title,
            // time: basic.publish_time,
            img: basic.cover.medium_url || basic.cover.default_url,
            // grade: basic.favorcnt / 10,
            desc: (0, index_1.decodeName)(basic.desc).replace(/<br>/g, "\n"),
            source: "tx"
          })),
          total: content.total_cnt,
          page,
          limit: this.limit_list,
          source: "tx"
        };
      },
      async handleParseId(link, retryNum = 0) {
        if (retryNum > 2)
          return Promise.reject(new Error("link try max num"));
        const requestObj_listDetailLink = (0, request_1.httpFetch)(link);
        const { headers: { location }, statusCode } = await requestObj_listDetailLink.promise;
        if (statusCode > 400)
          return this.handleParseId(link, ++retryNum);
        return location == null ? link : location;
      },
      async getListId(id) {
        if (/[?&:/]/.test(id)) {
          if (!this.regExps.listDetailLink.test(id)) {
            id = await this.handleParseId(id);
          }
          let result = this.regExps.listDetailLink.exec(id);
          if (!result) {
            result = this.regExps.listDetailLink2.exec(id);
            if (!result)
              throw new Error("failed");
          }
          id = result[1];
        }
        return id;
      },
      // 获取歌曲列表内的音乐
      async getListDetail(id, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        id = await this.getListId(id);
        const requestObj_listDetail = (0, request_1.httpFetch)(this.getListDetailUrl(id), {
          headers: {
            Origin: "https://y.qq.com",
            Referer: `https://y.qq.com/n/yqq/playsquare/${id}.html`
          }
        });
        const { body } = await requestObj_listDetail.promise;
        if (body.code !== this.successCode)
          return this.getListDetail(id, ++tryNum);
        const cdlist = body.cdlist[0];
        return {
          list: this.filterListDetail(cdlist.songlist),
          page: 1,
          limit: cdlist.songlist.length + 1,
          total: cdlist.songlist.length,
          source: "tx",
          info: {
            name: cdlist.dissname,
            img: cdlist.logo,
            desc: (0, index_1.decodeName)(cdlist.desc).replace(/<br>/g, "\n"),
            author: cdlist.nickname,
            play_count: (0, index_1.formatPlayCount)(cdlist.visitnum)
          }
        };
      },
      filterListDetail(rawList) {
        return rawList.map((item) => {
          const { types, _types } = (0, quality_1.buildQualitys)(item.file);
          return {
            singer: (0, utils_1.formatSingerName)(item.singer, "name"),
            name: item.title,
            albumName: item.album.name,
            albumId: item.album.mid,
            source: "tx",
            interval: (0, index_1.formatPlayTime)(item.interval),
            songId: item.id,
            albumMid: item.album.mid,
            strMediaMid: item.file.media_mid,
            songmid: item.mid,
            img: item.album.name === "" || item.album.name === "空" ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R800x800M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R800x800M000${item.album.mid}.jpg`,
            lrc: null,
            otherSource: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      getTags() {
        return Promise.all([this.getTag(), this.getHotTag()]).then(([tags, hotTag]) => ({ tags, hotTag, source: "tx" }));
      },
      async getDetailPageUrl(id) {
        id = await this.getListId(id);
        return `https://y.qq.com/n/ryqq/playlist/${id}`;
      },
      search(text, page, limit = 20, retryNum = 0) {
        if (retryNum > 5)
          throw new Error("max retry");
        return (0, request_1.httpFetch)(`http://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?page_no=${page - 1}&num_per_page=${limit}&format=json&query=${encodeURIComponent(text)}&remoteplace=txt.yqq.playlist&inCharset=utf8&outCharset=utf-8`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)",
            Referer: "http://y.qq.com/portal/search.html"
          }
        }).promise.then(({ body }) => {
          if (body.code != 0)
            return this.search(text, page, limit, ++retryNum);
          return {
            list: body.data.list.map((item) => {
              return {
                play_count: (0, index_1.formatPlayCount)(item.listennum),
                id: String(item.dissid),
                author: (0, index_1.decodeName)(item.creator.name),
                name: (0, index_1.decodeName)(item.dissname),
                time: (0, index_1.dateFormat)(item.createtime, "Y-M-D"),
                img: item.imgurl,
                // grade: item.favorcnt / 10,
                total: item.song_count,
                desc: (0, index_1.decodeName)((0, index_1.decodeName)(item.introduction)).replace(/<br>/g, "\n"),
                source: "tx"
              };
            }),
            limit,
            total: body.data.sum,
            source: "tx"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/tx/musicSearch.js
var require_musicSearch3 = __commonJS({
  "src/vendor/musicSdk/tx/musicSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var utils_1 = require_utils();
    var quality_1 = require_quality();
    exports2.default = {
      limit: 50,
      total: 0,
      page: 0,
      allPage: 1,
      successCode: 0,
      musicSearch(str, page, limit, retryNum = 0) {
        if (retryNum > 5)
          return Promise.reject(new Error("搜索失败"));
        const searchRequest = (0, request_1.httpFetch)("https://u.y.qq.com/cgi-bin/musicu.fcg", {
          method: "post",
          headers: {
            "User-Agent": "QQMusic 14090508(android 12)"
          },
          body: {
            comm: {
              ct: "11",
              cv: "14090508",
              v: "14090508",
              tmeAppID: "qqmusic",
              phonetype: "EBG-AN10",
              deviceScore: "553.47",
              devicelevel: "50",
              newdevicelevel: "20",
              rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
              os_ver: "12",
              OpenUDID: "0",
              OpenUDID2: "0",
              QIMEI36: "0",
              udid: "0",
              chid: "0",
              aid: "0",
              oaid: "0",
              taid: "0",
              tid: "0",
              wid: "0",
              uid: "0",
              sid: "0",
              modeSwitch: "6",
              teenMode: "0",
              ui_mode: "2",
              nettype: "1020",
              v4ip: ""
            },
            req: {
              module: "music.search.SearchCgiService",
              method: "DoSearchForQQMusicMobile",
              param: {
                search_type: 0,
                query: str,
                page_num: page,
                num_per_page: limit,
                highlight: 0,
                nqc_flag: 0,
                multi_zhida: 0,
                cat: 2,
                grp: 1,
                sin: 0,
                sem: 0
              }
            }
          }
        });
        return searchRequest.promise.then(({ body }) => {
          if (body.code != this.successCode || body.req.code != this.successCode)
            return this.musicSearch(str, page, limit, ++retryNum);
          return body.req.data;
        });
      },
      handleResult(rawList) {
        const list = [];
        rawList.forEach((item) => {
          if (!item.file?.media_mid)
            return;
          const file = item.file;
          const { types, _types } = (0, quality_1.buildQualitys)(file);
          let albumId = "";
          let albumName = "";
          if (item.album) {
            albumName = item.album.name;
            albumId = item.album.mid;
          }
          list.push({
            singer: (0, utils_1.formatSingerName)(item.singer, "name"),
            name: item.name + (item.title_extra ?? ""),
            albumName,
            albumId,
            source: "tx",
            interval: (0, index_1.formatPlayTime)(item.interval),
            songId: item.id,
            albumMid: item.album?.mid ?? "",
            strMediaMid: item.file.media_mid,
            songmid: item.mid,
            img: albumId === "" || albumId === "空" ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R800x800M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumId}.jpg`,
            types,
            _types,
            typeUrl: {}
          });
        });
        return list;
      },
      search(str, page = 1, limit) {
        if (limit == null)
          limit = this.limit;
        return this.musicSearch(str, page, limit).then(({ body, meta }) => {
          let list = this.handleResult(body.item_song);
          this.total = meta.estimate_sum;
          this.page = page;
          this.allPage = Math.ceil(this.total / limit);
          return Promise.resolve({
            list,
            allPage: this.allPage,
            limit,
            total: this.total,
            source: "tx"
          });
        });
      }
    };
  }
});

// src/vendor/musicSdk/tx/hotSearch.js
var require_hotSearch3 = __commonJS({
  "src/vendor/musicSdk/tx/hotSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      _requestObj: null,
      async getList(retryNum = 0) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const _requestObj = (0, request_1.httpFetch)("https://u.y.qq.com/cgi-bin/musicu.fcg", {
          method: "post",
          body: {
            comm: {
              ct: "19",
              cv: "1803",
              guid: "0",
              patch: "118",
              psrf_access_token_expiresAt: 0,
              psrf_qqaccess_token: "",
              psrf_qqopenid: "",
              psrf_qqunionid: "",
              tmeAppID: "qqmusic",
              tmeLoginType: 0,
              uin: "0",
              wid: "0"
            },
            hotkey: {
              method: "GetHotkeyForQQMusicPC",
              module: "tencent_musicsoso_hotkey.HotkeyService",
              param: {
                search_id: "",
                uin: 0
              }
            }
          },
          headers: {
            Referer: "https://y.qq.com/portal/player.html"
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.code !== 0)
          throw new Error("获取热搜词失败");
        return { source: "tx", list: this.filterList(body.hotkey.data.vec_hotkey) };
      },
      filterList(rawList) {
        return rawList.map((item) => item.query);
      }
    };
  }
});

// src/vendor/musicSdk/tx/musicInfo.js
var require_musicInfo = __commonJS({
  "src/vendor/musicSdk/tx/musicInfo.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var quality_1 = require_quality();
    var getSinger = (singers) => {
      let arr = [];
      singers.forEach((singer) => {
        arr.push(singer.name);
      });
      return arr.join("、");
    };
    exports2.default = (songmid) => {
      const requestObj = (0, request_1.httpFetch)("https://u.y.qq.com/cgi-bin/musicu.fcg", {
        method: "post",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"
        },
        body: {
          comm: {
            ct: "19",
            cv: "1859",
            uin: "0"
          },
          req: {
            module: "music.pf_song_detail_svr",
            method: "get_song_detail_yqq",
            param: {
              song_type: 0,
              song_mid: songmid
            }
          }
        }
      });
      return requestObj.promise.then(({ body }) => {
        if (body.code != 0 || body.req.code != 0)
          return Promise.reject(new Error("获取歌曲信息失败"));
        const item = body.req.data.track_info;
        if (!item.file?.media_mid)
          return null;
        const file = item.file;
        const { types, _types } = (0, quality_1.buildQualitys)(file);
        let albumId = "";
        let albumName = "";
        if (item.album) {
          albumName = item.album.name;
          albumId = item.album.mid;
        }
        return {
          singer: getSinger(item.singer),
          name: item.title,
          albumName,
          albumId,
          source: "tx",
          interval: (0, index_1.formatPlayTime)(item.interval),
          songId: item.id,
          albumMid: item.album?.mid ?? "",
          strMediaMid: item.file.media_mid,
          songmid: item.mid,
          img: albumId === "" || albumId === "空" ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R800x800M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumId}.jpg`,
          types,
          _types,
          typeUrl: {}
        };
      });
    };
  }
});

// src/vendor/musicSdk/tx/comment.js
var require_comment3 = __commonJS({
  "src/vendor/musicSdk/tx/comment.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var musicInfo_1 = __importDefault(require_musicInfo());
    var emojis = {
      e400846: "😘",
      e400874: "😴",
      e400825: "😃",
      e400847: "😙",
      e400835: "😍",
      e400873: "😳",
      e400836: "😎",
      e400867: "😭",
      e400832: "😊",
      e400837: "😏",
      e400875: "😫",
      e400831: "😉",
      e400855: "😡",
      e400823: "😄",
      e400862: "😨",
      e400844: "😖",
      e400841: "😓",
      e400830: "😈",
      e400828: "😆",
      e400833: "😋",
      e400822: "😀",
      e400843: "😕",
      e400829: "😇",
      e400824: "😂",
      e400834: "😌",
      e400877: "😷",
      e400132: "🍉",
      e400181: "🍺",
      e401067: "☕️",
      e400186: "🥧",
      e400343: "🐷",
      e400116: "🌹",
      e400126: "🍃",
      e400613: "💋",
      e401236: "❤️",
      e400622: "💔",
      e400637: "💣",
      e400643: "💩",
      e400773: "🔪",
      e400102: "🌛",
      e401328: "🌞",
      e400420: "👏",
      e400914: "🙌",
      e400408: "👍",
      e400414: "👎",
      e401121: "✋",
      e400396: "👋",
      e400384: "👉",
      e401115: "✊",
      e400402: "👌",
      e400905: "🙈",
      e400906: "🙉",
      e400907: "🙊",
      e400562: "👻",
      e400932: "🙏",
      e400644: "💪",
      e400611: "💉",
      e400185: "🎁",
      e400655: "💰",
      e400325: "🐥",
      e400612: "💊",
      e400198: "🎉",
      e401685: "⚡️",
      e400631: "💝",
      e400768: "🔥",
      e400432: "👑"
    };
    var songIdMap = /* @__PURE__ */ new Map();
    var promises = /* @__PURE__ */ new Map();
    exports2.default = {
      _requestObj: null,
      _requestObj2: null,
      async getSongId({ songId, songmid }) {
        if (songId)
          return songId;
        if (songIdMap.has(songmid))
          return songIdMap.get(songmid);
        if (promises.has(songmid))
          return (await promises.get(songmid)).songId;
        const promise = (0, musicInfo_1.default)(songmid);
        promises.set(promise);
        const info = await promise;
        songIdMap.set(songmid, info.songId);
        promises.delete(songmid);
        return info.songId;
      },
      async getComment(mInfo, page = 1, limit = 20) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        const songId = await this.getSongId(mInfo);
        const _requestObj = (0, request_1.httpFetch)("http://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg", {
          method: "POST",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"
          },
          form: {
            uin: "0",
            format: "json",
            cid: "205360772",
            reqtype: "2",
            biztype: "1",
            topid: songId,
            cmd: "8",
            needmusiccrit: "1",
            pagenum: page - 1,
            pagesize: limit
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.code !== 0)
          throw new Error("获取评论失败");
        const comment = body.comment;
        const total = comment.commenttotal || (comment.commentlist ? comment.commentlist.length : 0);
        return {
          source: "tx",
          comments: this.filterNewComment(comment.commentlist),
          total,
          page,
          limit,
          maxPage: Math.ceil(total / limit) || 1
        };
      },
      async getHotComment(mInfo, page = 1, limit = 20) {
        if (this._requestObj2)
          this._requestObj2.cancelHttp();
        const songId = await this.getSongId(mInfo);
        const _requestObj2 = (0, request_1.httpFetch)("https://u.y.qq.com/cgi-bin/musicu.fcg", {
          method: "POST",
          body: {
            comm: {
              cv: 4747474,
              ct: 24,
              format: "json",
              inCharset: "utf-8",
              outCharset: "utf-8",
              notice: 0,
              platform: "yqq.json",
              needNewCode: 1,
              uin: 0
            },
            req: {
              module: "music.globalComment.CommentRead",
              method: "GetHotCommentList",
              param: {
                BizType: 1,
                BizId: String(songId),
                LastCommentSeqNo: "",
                PageSize: limit,
                PageNum: page - 1,
                HotType: 1,
                WithAirborne: 0,
                PicEnable: 1
              }
            }
          },
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.0.0",
            referer: "https://y.qq.com/",
            origin: "https://y.qq.com"
          }
        });
        const { body, statusCode } = await _requestObj2.promise;
        if (statusCode != 200 || body.code !== 0 || body.req.code !== 0)
          throw new Error("获取热门评论失败");
        const comment = body.req.data.CommentList;
        return {
          source: "tx",
          comments: this.filterHotComment(comment.Comments),
          total: comment.Total,
          page,
          limit,
          maxPage: Math.ceil(comment.Total / limit) || 1
        };
      },
      filterNewComment(rawList) {
        return rawList.map((item) => {
          let time = this.formatTime(item.time);
          let timeStr = time ? (0, index_1.dateFormat2)(time) : null;
          if (item.middlecommentcontent) {
            let firstItem = item.middlecommentcontent[0];
            firstItem.avatarurl = item.avatarurl;
            firstItem.praisenum = item.praisenum;
            item.avatarurl = null;
            item.praisenum = null;
            item.middlecommentcontent.reverse();
          }
          return {
            id: `${item.rootcommentid}_${item.commentid}`,
            rootId: item.rootcommentid,
            text: item.rootcommentcontent ? this.replaceEmoji(item.rootcommentcontent).replace(/\\n/g, "\n") : "",
            time: item.rootcommentid == item.commentid ? time : null,
            timeStr: item.rootcommentid == item.commentid ? timeStr : null,
            userName: item.rootcommentnick ? item.rootcommentnick.substring(1) : "",
            avatar: item.avatarurl,
            userId: item.encrypt_rootcommentuin,
            likedCount: item.praisenum,
            reply: item.middlecommentcontent ? item.middlecommentcontent.map((c) => {
              return {
                id: `sub_${item.rootcommentid}_${c.subcommentid}`,
                text: this.replaceEmoji(c.subcommentcontent).replace(/\\n/g, "\n"),
                time: c.subcommentid == item.commentid ? time : null,
                timeStr: c.subcommentid == item.commentid ? timeStr : null,
                userName: c.replynick.substring(1),
                avatar: c.avatarurl,
                userId: c.encrypt_replyuin,
                likedCount: c.praisenum
              };
            }) : []
          };
        });
      },
      filterHotComment(rawList) {
        return rawList.map((item) => {
          return {
            id: `${item.SeqNo}_${item.CmId}`,
            rootId: item.SeqNo,
            text: item.Content ? this.replaceEmoji(item.Content).replace(/\\n/g, "\n") : "",
            time: item.PubTime ? this.formatTime(item.PubTime) : null,
            timeStr: item.PubTime ? (0, index_1.dateFormat2)(this.formatTime(item.PubTime)) : null,
            userName: item.Nick ?? "",
            images: item.Pic ? [item.Pic] : [],
            avatar: item.Avatar,
            location: item.Location ? item.Location : "",
            userId: item.EncryptUin,
            likedCount: item.PraiseNum,
            reply: item.SubComments ? item.SubComments.map((c) => {
              return {
                id: `sub_${c.SeqNo}_${c.CmId}`,
                text: this.replaceEmoji(c.Content).replace(/\\n/g, "\n"),
                time: c.PubTime ? this.formatTime(c.PubTime) : null,
                timeStr: c.PubTime ? (0, index_1.dateFormat2)(this.formatTime(c.PubTime)) : null,
                userName: c.Nick ?? "",
                avatar: c.Avatar,
                images: c.Pic ? [c.Pic] : [],
                userId: c.EncryptUin,
                likedCount: c.PraiseNum
              };
            }) : []
          };
        });
      },
      replaceEmoji(msg) {
        let rxp = /^\[em\](e\d+)\[\/em\]$/;
        let result = msg.match(/\[em\]e\d+\[\/em\]/g);
        if (!result)
          return msg;
        result = Array.from(new Set(result));
        for (let item of result) {
          let code = item.replace(rxp, "$1");
          msg = msg.replace(new RegExp(item.replace("[em]", "\\[em\\]").replace("[/em]", "\\[\\/em\\]"), "g"), emojis[code] || "");
        }
        return msg;
      },
      formatTime(time) {
        return String(time).length < 10 ? null : parseInt(time + "000");
      }
    };
  }
});

// src/vendor/musicSdk/tx/tipSearch.js
var require_tipSearch3 = __commonJS({
  "src/vendor/musicSdk/tx/tipSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      // regExps: {
      //   relWord: /RELWORD=(.+)/,
      // },
      requestObj: null,
      tipSearch(str) {
        this.cancelTipSearch();
        this.requestObj = (0, request_1.httpFetch)(`https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?is_xml=0&format=json&key=${encodeURIComponent(str)}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`, {
          headers: {
            Referer: "https://y.qq.com/portal/player.html"
          }
        });
        return this.requestObj.promise.then(({ statusCode, body }) => {
          if (statusCode != 200 || body.code != 0)
            return Promise.reject(new Error("请求失败"));
          return body.data;
        });
      },
      handleResult(rawData) {
        return rawData.map((info) => `${info.name} - ${info.singer}`);
      },
      cancelTipSearch() {
        if (this.requestObj && this.requestObj.cancelHttp)
          this.requestObj.cancelHttp();
      },
      async search(str) {
        return this.tipSearch(str).then((result) => this.handleResult(result.song.itemlist));
      }
    };
  }
});

// src/vendor/musicSdk/tx/singer.js
var require_singer = __commonJS({
  "src/vendor/musicSdk/tx/singer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.filterMusicInfoItem = void 0;
    var request_1 = require_request();
    var index_1 = require_vendor();
    var utils_1 = require_utils();
    var quality_1 = require_quality();
    var filterMusicInfoItem = (item) => {
      const { types, _types } = (0, quality_1.buildQualitys)(item.file);
      const albumId = item.album.id ?? "";
      const albumMid = item.album.mid ?? "";
      const albumName = item.album.name ?? "";
      return {
        source: "tx",
        singer: (0, utils_1.formatSingerName)(item.singer, "name"),
        name: item.title,
        albumName,
        albumId,
        albumMid,
        interval: (0, index_1.formatPlayTime)(item.interval),
        songId: item.id,
        songmid: item.mid,
        strMediaMid: item.file.media_mid,
        img: albumId === "" || albumId === "空" ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R800x800M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumMid}.jpg`,
        types,
        _types,
        typeUrl: {}
      };
    };
    exports2.filterMusicInfoItem = filterMusicInfoItem;
    var createMusicuFetch = async (data, options, retryNum = 0) => {
      if (retryNum > 2)
        throw new Error("try max num");
      let result;
      try {
        result = await (0, request_1.httpFetch)("https://u.y.qq.com/cgi-bin/musicu.fcg", {
          method: "POST",
          body: {
            comm: {
              cv: 4747474,
              ct: 24,
              format: "json",
              inCharset: "utf-8",
              outCharset: "utf-8",
              uin: 0
            },
            ...data
          },
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"
          }
        }).promise;
      } catch (err) {
        console.log(err);
        return createMusicuFetch(data, options, ++retryNum);
      }
      if (result.statusCode !== 200 || result.body.code != 0)
        return createMusicuFetch(data, options, ++retryNum);
      return result.body;
    };
    exports2.default = {
      /**
       * 获取歌手信息
       * @param {*} id
       */
      getInfo(id) {
        return createMusicuFetch({
          singer: {
            method: "get_singer_detail_info",
            param: {
              sort: 5,
              singermid: id,
              sin: 0,
              num: 50
            },
            module: "music.web_singer_info_svr"
          }
        }).then((body) => {
          if (body.singer.code != 0)
            throw new Error("get singer info faild.");
          const data = body.singer.data;
          return {
            source: "tx",
            id: data.singer_info.mid,
            info: {
              name: data.singer_info.name,
              desc: data.singer_info.desc || "",
              avatar: `https://y.gtimg.cn/music/photo_new/T001R300x300M000${data.singer_info.mid}.jpg`
            },
            count: {
              music: data.total_song || 0,
              album: data.total_album || 0
            }
          };
        });
      },
      /**
       * 获取歌手完整介绍 (Bio)
       * @param {string} id 歌手 MID
       */
      getDesc(id) {
        return (0, request_1.httpFetch)(`https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_singer_desc.fcg?singermid=${id}&format=xml&utf8=1&outCharset=utf-8`, {
          headers: {
            "Referer": "https://y.qq.com/portal/singer_detail.html"
          }
        }).promise.then(({ body }) => {
          const match = body.match(/<desc><!\[CDATA\[([\s\S]*?)\]\]><\/desc>/);
          return match ? match[1].replace(/\n/g, "\n") : "";
        }).catch(() => "");
      },
      /**
       * 获取歌手专辑列表
       * @param {*} id
       * @param {*} page
       * @param {*} limit
       */
      getAlbumList(id, page = 1, limit = 10, order = "hot") {
        return createMusicuFetch({
          singerAlbum: {
            method: "get_singer_album",
            param: {
              singermid: id,
              begin: (page - 1) * limit,
              num: limit,
              order: "time"
            },
            module: "music.web_singer_info_svr"
          }
        }).then((body) => {
          if (body.singerAlbum.code != 0)
            throw new Error("get singer album faild.");
          const list = this.filterAlbumList(body.singerAlbum.data.list);
          return {
            source: "tx",
            list,
            limit,
            page,
            total: body.singerAlbum.data.total
          };
        });
      },
      /**
       * 获取歌手歌曲列表
       * @param {*} id
       * @param {*} page
       * @param {*} limit
       */
      async getSongList(id, page = 1, limit = 100, order = "hot") {
        return createMusicuFetch({
          req: {
            module: "musichall.song_list_server",
            method: "GetSingerSongList",
            param: {
              singerMid: id,
              order: order === "time" ? 0 : 1,
              // 0: 最新, 1: 热门
              begin: (page - 1) * limit,
              num: limit
            }
          }
        }).then((body) => {
          if (body.req.code != 0)
            throw new Error("get singer song list faild.");
          const list = this.filterSongList(body.req.data.songList);
          return {
            source: "tx",
            list,
            limit,
            page,
            total: body.req.data.totalNum
          };
        });
      },
      filterAlbumList(raw) {
        return raw.map((item) => {
          return {
            id: item.album_id || item.albumID,
            mid: item.album_mid || item.albumMid,
            count: item.latest_song?.song_count || item.total_num || item.song_count || item.totalNum || 0,
            info: {
              name: item.album_name || item.albumName,
              author: item.singer_name || item.singerName,
              img: `https://y.gtimg.cn/music/photo_new/T002R800x800M000${item.album_mid || item.albumMid}.jpg`,
              desc: null,
              publishTime: item.pub_time || ""
            }
          };
        });
      },
      filterSongList(raw) {
        return raw.map((item) => {
          return (0, exports2.filterMusicInfoItem)(item.songInfo);
        });
      }
    };
  }
});

// src/vendor/musicSdk/tx/extendDetail.js
var require_extendDetail = __commonJS({
  "src/vendor/musicSdk/tx/extendDetail.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0)
        k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0)
        k2 = k;
      o[k2] = m[k];
    });
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    } : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || /* @__PURE__ */ function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2)
            if (Object.prototype.hasOwnProperty.call(o2, k))
              ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule)
          return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++)
            if (k[i] !== "default")
              __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    }();
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var singer_1 = __importStar(require_singer());
    var utils_1 = require_utils();
    var getAlbumSongsApi = async (albummid) => {
      return (0, request_1.httpFetch)(`https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?platform=h5page&albummid=${albummid}&g_tk=938407465&uin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&_=1459961045571`).promise.then(({ body }) => {
        if (body.code !== 0)
          throw new Error("Get TX album songs failed: " + body.code);
        return body.data || {};
      });
    };
    exports2.default = {
      /**
       * 获取歌手详情
       * @param {string} id 歌手 MID
       */
      getArtistDetail(id) {
        return Promise.all([
          singer_1.default.getInfo(id),
          singer_1.default.getDesc(id)
        ]).then(([data, desc]) => {
          return {
            source: "tx",
            id: data.id,
            name: data.info.name || "未知歌手",
            desc: desc || data.info.desc || "",
            avatar: data.info.avatar || `https://y.gtimg.cn/music/photo_new/T001R300x300M000${id}.jpg`,
            musicSize: data.count.music || 0,
            albumSize: data.count.album || 0
          };
        });
      },
      /**
       * 获取歌手歌曲
       * @param {string} id 歌手 MID
       * @param {number} page
       * @param {number} limit
       * @param {string} order
       */
      getArtistSongs(id, page = 1, limit = 100, order = "hot") {
        return singer_1.default.getSongList(id, page, limit, order);
      },
      /**
       * 获取歌手专辑列表
       * @param {string} id 歌手 MID
       * @param {number} page
       * @param {number} limit
       * @param {string} order
       */
      getArtistAlbums(id, page = 1, limit = 50, order = "hot") {
        return singer_1.default.getAlbumList(id, page, limit, order).then((data) => {
          const formattedList = data.list.map((item) => ({
            id: item.mid || item.id,
            name: item.info.name,
            img: item.info.img,
            singer: item.info.author,
            publishTime: item.info.publishTime,
            total: item.total || item.count || 0,
            source: "tx"
          }));
          return {
            source: "tx",
            list: formattedList,
            total: data.total
          };
        });
      },
      /**
       * 获取专辑歌曲
       * @param {string} id 专辑 MID
       */
      getAlbumSongs(id) {
        return getAlbumSongsApi(id).then((data) => {
          const list = data.list || [];
          const formattedList = list.map((item) => {
            return (0, singer_1.filterMusicInfoItem)({
              id: item?.songid,
              mid: item?.songmid,
              title: item?.songname,
              singer: item?.singer || [],
              album: {
                id: item?.albumid,
                mid: item?.albummid,
                name: item?.albumname
              },
              interval: item?.interval || 0,
              file: {
                media_mid: item?.strMediaMid,
                size_128mp3: item?.size128 || 0,
                size_320mp3: item?.size320 || 0,
                size_flac: item?.sizeflac || 0,
                size_hires: item?.sizehires || 0
              }
            });
          });
          return {
            list: formattedList,
            total: formattedList.length,
            name: data.name,
            publishTime: data.aDate,
            source: "tx"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/tx/extendSearch.js
var require_extendSearch = __commonJS({
  "src/vendor/musicSdk/tx/extendSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    var createSearchFetch = (str, searchType, resultNum, pageNum) => {
      return (0, request_1.httpFetch)(MUSICU_URL, {
        method: "post",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0",
          "Content-Type": "application/json;charset=utf-8"
        },
        body: {
          comm: { ct: "19", cv: "1859", uin: "0" },
          req: {
            method: "DoSearchForQQMusicDesktop",
            module: "music.search.SearchCgiService",
            param: {
              grp: 1,
              num_per_page: resultNum,
              page_num: pageNum,
              query: str,
              search_type: searchType
            }
          }
        }
      });
    };
    exports2.default = {
      /**
       * 搜索歌手
       * @param {string} str 搜索关键词
       * @param {number} page 页码
       * @param {number} limit 每页数量
       */
      searchSinger(str, page = 1, limit = 20) {
        return createSearchFetch(str, 1, limit, page).promise.then(({ body }) => {
          if (body.code !== 0)
            throw new Error("TX singer search failed: " + body.code);
          const singerData = body.req?.data?.body?.singer;
          const rawList = singerData && singerData.list || [];
          const list = this.handleSingerResult(rawList);
          return {
            list,
            total: singerData && singerData.total || list.length,
            allPage: Math.ceil((singerData && singerData.total || list.length) / limit),
            limit,
            source: "tx"
          };
        });
      },
      /**
       * 搜索专辑
       * @param {string} str 搜索关键词
       * @param {number} page 页码
       * @param {number} limit 每页数量
       */
      searchAlbum(str, page = 1, limit = 20) {
        return createSearchFetch(str, 2, limit, page).promise.then(({ body }) => {
          if (body.code !== 0)
            throw new Error("TX album search failed: " + body.code);
          const albumData = body.req?.data?.body?.album;
          const rawList = albumData && albumData.list || [];
          const list = this.handleAlbumResult(rawList);
          return {
            list,
            total: albumData && albumData.total || list.length,
            allPage: Math.ceil((albumData && albumData.total || list.length) / limit),
            limit,
            source: "tx"
          };
        });
      },
      /**
       * 格式化歌手搜索结果
       * @param {Array} rawList
       */
      handleSingerResult(rawList) {
        if (!rawList || !rawList.length)
          return [];
        return rawList.map((item) => {
          const mid = item.singerMID || item.mid || "";
          return {
            id: mid,
            mid,
            name: item.singerName || item.name || "",
            picUrl: mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : "",
            albumSize: item.albumNum || 0,
            source: "tx"
          };
        });
      },
      /**
       * 格式化专辑搜索结果
       * @param {Array} rawList
       */
      handleAlbumResult(rawList) {
        if (!rawList || !rawList.length)
          return [];
        return rawList.map((item) => {
          const mid = item.albumMID || item.mid || "";
          const singerName = item.singerName || item.singer && item.singer[0] && item.singer[0].name || "";
          const singerId = item.singer && item.singer[0] && item.singer[0].mid || "";
          return {
            id: mid,
            mid,
            name: item.albumName || item.name || "",
            picUrl: mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : "",
            artistName: singerName,
            artistId: singerId,
            size: item.song_count || item.songNum || 0,
            publishTime: item.pubTime || "",
            source: "tx"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/tx/userPlaylist.js
var require_userPlaylist = __commonJS({
  "src/vendor/musicSdk/tx/userPlaylist.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    exports2.default = {
      async getList(uid, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        const APIURL = "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss";
        const params = {
          hostuin: uid,
          sin: 0,
          size: 40,
          r: Date.now(),
          g_tk_new_20200303: 1718906646,
          g_tk: 1718906646,
          loginUin: 0,
          hostUin: 0,
          format: "json",
          inCharset: "utf8",
          outCharset: "utf-8",
          notice: 0,
          platform: "yqq.json",
          needNewCode: 0
        };
        const url = `${APIURL}?${Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&")}`;
        const requestObj = (0, request_1.httpFetch)(url, {
          headers: {
            host: "c.y.qq.com",
            referer: "https://y.qq.com/"
          }
        });
        const { body } = await requestObj.promise;
        if (body.code !== 0)
          return this.getList(uid, ++tryNum);
        const { hostname, disslist } = body.data;
        const lists = [];
        const userAvatar = `//q1.qlogo.cn/g?b=qq&s=640&nk=${uid}&t=12345`;
        const defaultCover = "http://y.gtimg.cn/mediastyle/y/img/cover_qzone_130.jpg";
        disslist.forEach((item) => {
          if (item.tid) {
            let img = item.diss_cover;
            if (!img || img === defaultCover)
              img = userAvatar;
            lists.push({
              id: String(item.tid),
              name: item.diss_name,
              img,
              total: item.song_cnt,
              play_count: (0, index_1.formatPlayCount)(item.listen_num),
              source: "tx"
            });
          }
        });
        return {
          uid,
          nickname: hostname,
          avatar: `//q1.qlogo.cn/g?b=qq&s=100&nk=${uid}`,
          list: lists,
          source: "tx"
        };
      }
    };
  }
});

// src/vendor/musicSdk/tx/index.js
var require_tx = __commonJS({
  "src/vendor/musicSdk/tx/index.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var leaderboard_1 = __importDefault(require_leaderboard3());
    var lyric_1 = __importDefault(require_lyric3());
    var songList_1 = __importDefault(require_songList3());
    var musicSearch_1 = __importDefault(require_musicSearch3());
    var api_source_1 = require_api_source();
    var hotSearch_1 = __importDefault(require_hotSearch3());
    var comment_1 = __importDefault(require_comment3());
    var tipSearch_1 = __importDefault(require_tipSearch3());
    var extendDetail_1 = __importDefault(require_extendDetail());
    var extendSearch_1 = __importDefault(require_extendSearch());
    var userPlaylist_1 = __importDefault(require_userPlaylist());
    var tx = {
      tipSearch: tipSearch_1.default,
      leaderboard: leaderboard_1.default,
      songList: songList_1.default,
      userPlaylist: userPlaylist_1.default,
      musicSearch: musicSearch_1.default,
      extendSearch: extendSearch_1.default,
      extendDetail: extendDetail_1.default,
      hotSearch: hotSearch_1.default,
      comment: comment_1.default,
      getMusicUrl(songInfo, type) {
        return (0, api_source_1.apis)("tx").getMusicUrl(songInfo, type);
      },
      getLyric(songInfo) {
        return lyric_1.default.getLyric(songInfo);
      },
      async getPic(songInfo) {
        return `https://y.gtimg.cn/music/photo_new/T002R800x800M000${songInfo.albumId}.jpg`;
      },
      getMusicDetailPageUrl(songInfo) {
        return `https://y.qq.com/n/yqq/song/${songInfo.songmid}.html`;
      }
    };
    exports2.default = tx;
  }
});

// src/vendor/musicSdk/wy/utils/crypto.js
var require_crypto = __commonJS({
  "src/vendor/musicSdk/wy/utils/crypto.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.eapiDecrypt = exports2.eapi = exports2.linuxapi = exports2.weapi = void 0;
    var crypto_1 = require("crypto");
    var iv = Buffer.from("0102030405060708");
    var presetKey = Buffer.from("0CoJUm6Qyw8W8jud");
    var linuxapiKey = Buffer.from("rFgB&h#%2?^eDg:Q");
    var base62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var publicKey = "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----";
    var eapiKey = "e82ckenh8dichen8";
    var aesEncrypt = (buffer, mode, key, iv2) => {
      const cipher = (0, crypto_1.createCipheriv)(mode, key, iv2);
      return Buffer.concat([cipher.update(buffer), cipher.final()]);
    };
    var aesDecrypt = function(cipherBuffer, mode, key, iv2) {
      let decipher = (0, crypto_1.createDecipheriv)(mode, key, iv2);
      return Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);
    };
    var rsaEncrypt = (buffer, key) => {
      buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
      return (0, crypto_1.publicEncrypt)({ key, padding: crypto_1.constants.RSA_NO_PADDING }, buffer);
    };
    var weapi = (object) => {
      const text = JSON.stringify(object);
      const secretKey = (0, crypto_1.randomBytes)(16).map((n) => base62.charAt(n % 62).charCodeAt());
      return {
        params: aesEncrypt(Buffer.from(aesEncrypt(Buffer.from(text), "aes-128-cbc", presetKey, iv).toString("base64")), "aes-128-cbc", secretKey, iv).toString("base64"),
        encSecKey: rsaEncrypt(secretKey.reverse(), publicKey).toString("hex")
      };
    };
    exports2.weapi = weapi;
    var linuxapi = (object) => {
      const text = JSON.stringify(object);
      return {
        eparams: aesEncrypt(Buffer.from(text), "aes-128-ecb", linuxapiKey, "").toString("hex").toUpperCase()
      };
    };
    exports2.linuxapi = linuxapi;
    var eapi = (url, object) => {
      const text = typeof object === "object" ? JSON.stringify(object) : object;
      const message = `nobody${url}use${text}md5forencrypt`;
      const digest = (0, crypto_1.createHash)("md5").update(message).digest("hex");
      const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
      return {
        params: aesEncrypt(Buffer.from(data), "aes-128-ecb", eapiKey, "").toString("hex").toUpperCase()
      };
    };
    exports2.eapi = eapi;
    var eapiDecrypt = (cipherBuffer) => {
      return aesDecrypt(cipherBuffer, "aes-128-ecb", eapiKey, "").toString();
    };
    exports2.eapiDecrypt = eapiDecrypt;
  }
});

// src/vendor/musicSdk/wy/quality.js
var require_quality2 = __commonJS({
  "src/vendor/musicSdk/wy/quality.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.buildQualitys = void 0;
    var index_1 = require_vendor();
    var hasQualityInfo = (info) => info != null;
    var getSize = (info) => {
      const size = info?.size;
      if (size == null || size === 0 || size === "0")
        return null;
      const numericSize = Number(size);
      return !Number.isFinite(numericSize) || numericSize <= 0 ? null : (0, index_1.sizeFormate)(numericSize);
    };
    var addQuality = (types, _types, type, size) => {
      if (_types[type])
        return;
      const qualityInfo = { size };
      types.push({ type, ...qualityInfo });
      _types[type] = qualityInfo;
    };
    var buildQualitys = (item = {}, privilege = {}) => {
      const types = [];
      const _types = {};
      const maxbr = Number(privilege?.maxbr || item.privilege?.maxbr || 0);
      if (maxbr >= 128e3 || item.l)
        addQuality(types, _types, "128k", getSize(item.l));
      if (maxbr >= 32e4 || item.h)
        addQuality(types, _types, "320k", getSize(item.h));
      if (maxbr >= 999e3 || item.sq)
        addQuality(types, _types, "flac", getSize(item.sq));
      const hiresSize = getSize(item.hr);
      if (hasQualityInfo(item.hr)) {
        addQuality(types, _types, "flac24bit", hiresSize);
        addQuality(types, _types, "hires", hiresSize);
      }
      if (hasQualityInfo(item.jyEffect || item.sky))
        addQuality(types, _types, "atmos", getSize(item.jyEffect || item.sky));
      if (hasQualityInfo(item.jm || item.jymaster))
        addQuality(types, _types, "master", getSize(item.jm || item.jymaster));
      return { types, _types };
    };
    exports2.buildQualitys = buildQualitys;
  }
});

// src/vendor/musicSdk/wy/musicDetail.js
var require_musicDetail = __commonJS({
  "src/vendor/musicSdk/wy/musicDetail.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var crypto_1 = require_crypto();
    var index_1 = require_vendor();
    var quality_1 = require_quality2();
    exports2.default = {
      getSinger(singers) {
        let arr = [];
        singers?.forEach((singer) => {
          arr.push(singer.name);
        });
        return arr.join("、");
      },
      filterList({ songs, privileges }) {
        const list = [];
        songs.forEach((item, index) => {
          let privilege = privileges[index];
          if (privilege.id !== item.id)
            privilege = privileges.find((p) => p.id === item.id);
          if (!privilege)
            return;
          const { types, _types } = (0, quality_1.buildQualitys)(item, privilege);
          if (item.pc) {
            list.push({
              singer: item.pc.ar ?? "",
              name: item.pc.sn ?? "",
              albumName: item.pc.alb ?? "",
              albumId: item.al?.id,
              source: "wy",
              interval: (0, index_1.formatPlayTime)(item.dt / 1e3),
              songmid: item.id,
              img: item.al?.picUrl ?? "",
              lrc: null,
              otherSource: null,
              types,
              _types,
              typeUrl: {}
            });
          } else {
            list.push({
              singer: this.getSinger(item.ar),
              name: item.name ?? "",
              albumName: item.al?.name,
              albumId: item.al?.id,
              source: "wy",
              interval: (0, index_1.formatPlayTime)(item.dt / 1e3),
              songmid: item.id,
              img: item.al?.picUrl,
              lrc: null,
              otherSource: null,
              types,
              _types,
              typeUrl: {}
            });
          }
        });
        return list;
      },
      async getList(ids = [], retryNum = 0) {
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const requestObj = (0, request_1.httpFetch)("https://music.163.com/weapi/v3/song/detail", {
          method: "post",
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
            origin: "https://music.163.com"
          },
          form: (0, crypto_1.weapi)({
            c: "[" + ids.map((id) => '{"id":' + id + "}").join(",") + "]",
            ids: "[" + ids.join(",") + "]"
          })
        });
        const { body, statusCode } = await requestObj.promise;
        if (statusCode != 200 || body.code !== 200)
          throw new Error("获取歌曲详情失败");
        return { source: "wy", list: this.filterList(body) };
      }
    };
  }
});

// src/vendor/musicSdk/wy/leaderboard.js
var require_leaderboard4 = __commonJS({
  "src/vendor/musicSdk/wy/leaderboard.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var crypto_1 = require_crypto();
    var request_1 = require_request();
    var musicDetail_1 = __importDefault(require_musicDetail());
    var topList = [
      { id: "wy__19723756", name: "飙升榜", bangid: "19723756" },
      { id: "wy__3779629", name: "新歌榜", bangid: "3779629" },
      { id: "wy__2884035", name: "原创榜", bangid: "2884035" },
      { id: "wy__3778678", name: "热歌榜", bangid: "3778678" },
      { id: "wy__991319590", name: "说唱榜", bangid: "991319590" },
      { id: "wy__71384707", name: "古典榜", bangid: "71384707" },
      { id: "wy__1978921795", name: "电音榜", bangid: "1978921795" },
      { id: "wy__5453912201", name: "黑胶VIP爱听榜", bangid: "5453912201" },
      { id: "wy__71385702", name: "ACG榜", bangid: "71385702" },
      { id: "wy__745956260", name: "韩语榜", bangid: "745956260" },
      { id: "wy__10520166", name: "国电榜", bangid: "10520166" },
      { id: "wy__180106", name: "UK排行榜周榜", bangid: "180106" },
      { id: "wy__60198", name: "美国Billboard榜", bangid: "60198" },
      { id: "wy__3812895", name: "Beatport全球电子舞曲榜", bangid: "3812895" },
      { id: "wy__21845217", name: "KTV唛榜", bangid: "21845217" },
      { id: "wy__60131", name: "日本Oricon榜", bangid: "60131" },
      { id: "wy__2809513713", name: "欧美热歌榜", bangid: "2809513713" },
      { id: "wy__2809577409", name: "欧美新歌榜", bangid: "2809577409" },
      { id: "wy__27135204", name: "法国 NRJ Vos Hits 周榜", bangid: "27135204" },
      { id: "wy__3001835560", name: "ACG动画榜", bangid: "3001835560" },
      { id: "wy__3001795926", name: "ACG游戏榜", bangid: "3001795926" },
      { id: "wy__3001890046", name: "ACG VOCALOID榜", bangid: "3001890046" },
      { id: "wy__3112516681", name: "中国新乡村音乐排行榜", bangid: "3112516681" },
      { id: "wy__5059644681", name: "日语榜", bangid: "5059644681" },
      { id: "wy__5059633707", name: "摇滚榜", bangid: "5059633707" },
      { id: "wy__5059642708", name: "国风榜", bangid: "5059642708" },
      { id: "wy__5338990334", name: "潜力爆款榜", bangid: "5338990334" },
      { id: "wy__5059661515", name: "民谣榜", bangid: "5059661515" },
      { id: "wy__6688069460", name: "听歌识曲榜", bangid: "6688069460" },
      { id: "wy__6723173524", name: "网络热歌榜", bangid: "6723173524" },
      { id: "wy__6732051320", name: "俄语榜", bangid: "6732051320" },
      { id: "wy__6732014811", name: "越南语榜", bangid: "6732014811" },
      { id: "wy__6886768100", name: "中文DJ榜", bangid: "6886768100" },
      { id: "wy__6939992364", name: "俄罗斯top hit流行音乐榜", bangid: "6939992364" },
      { id: "wy__7095271308", name: "泰语榜", bangid: "7095271308" },
      { id: "wy__7356827205", name: "BEAT排行榜", bangid: "7356827205" },
      { id: "wy__7325478166", name: "编辑推荐榜VOL.44 天才女子摇滚乐队boygenius剖白卑微心迹", bangid: "7325478166" },
      { id: "wy__7603212484", name: "LOOK直播歌曲榜", bangid: "7603212484" },
      { id: "wy__7775163417", name: "赏音榜", bangid: "7775163417" },
      { id: "wy__7785123708", name: "黑胶VIP新歌榜", bangid: "7785123708" },
      { id: "wy__7785066739", name: "黑胶VIP热歌榜", bangid: "7785066739" },
      { id: "wy__7785091694", name: "黑胶VIP爱搜榜", bangid: "7785091694" }
    ];
    exports2.default = {
      limit: 1e5,
      list: [
        {
          id: "wybsb",
          name: "飙升榜",
          bangid: "19723756"
        },
        {
          id: "wyrgb",
          name: "热歌榜",
          bangid: "3778678"
        },
        {
          id: "wyxgb",
          name: "新歌榜",
          bangid: "3779629"
        },
        {
          id: "wyycb",
          name: "原创榜",
          bangid: "2884035"
        },
        {
          id: "wygdb",
          name: "古典榜",
          bangid: "71384707"
        },
        {
          id: "wydouyb",
          name: "抖音榜",
          bangid: "2250011882"
        },
        {
          id: "wyhyb",
          name: "韩语榜",
          bangid: "745956260"
        },
        {
          id: "wydianyb",
          name: "电音榜",
          bangid: "1978921795"
        },
        {
          id: "wydjb",
          name: "电竞榜",
          bangid: "2006508653"
        },
        {
          id: "wyktvbb",
          name: "KTV唛榜",
          bangid: "21845217"
        }
      ],
      getUrl(id) {
        return `https://music.163.com/discover/toplist?id=${id}`;
      },
      regExps: {
        list: /<textarea id="song-list-pre-data" style="display:none;">(.+?)<\/textarea>/
      },
      _requestBoardsObj: null,
      getBoardsData() {
        if (this._requestBoardsObj)
          this._requestBoardsObj.cancelHttp();
        this._requestBoardsObj = (0, request_1.httpFetch)("https://music.163.com/weapi/toplist", {
          method: "post",
          form: (0, crypto_1.weapi)({})
        });
        return this._requestBoardsObj.promise;
      },
      getData(id) {
        const requestBoardsDetailObj = (0, request_1.httpFetch)("https://music.163.com/weapi/v3/playlist/detail", {
          method: "post",
          form: (0, crypto_1.weapi)({
            id,
            n: 1e5,
            p: 1
          })
        });
        return requestBoardsDetailObj.promise;
      },
      filterBoardsData(rawList) {
        let list = [];
        for (const board of rawList) {
          list.push({
            id: "wy__" + board.id,
            name: board.name,
            bangid: String(board.id)
          });
        }
        return list;
      },
      async getBoards(retryNum = 0) {
        this.list = topList;
        return {
          list: topList,
          source: "wy"
        };
      },
      async getList(bangid, page, retryNum = 0) {
        if (++retryNum > 6)
          return Promise.reject(new Error("try max num"));
        let resp;
        try {
          resp = await this.getData(bangid);
        } catch (err) {
          if (err.message == "try max num") {
            throw err;
          } else {
            return this.getList(bangid, page, retryNum);
          }
        }
        if (resp.statusCode !== 200 || resp.body.code !== 200)
          return this.getList(bangid, page, retryNum);
        let musicDetail;
        try {
          musicDetail = await musicDetail_1.default.getList(resp.body.playlist.trackIds.map((trackId) => trackId.id));
        } catch (err) {
          console.log(err);
          if (err.message == "try max num") {
            throw err;
          } else {
            return this.getList(bangid, page, retryNum);
          }
        }
        return {
          total: musicDetail.list.length,
          list: musicDetail.list,
          limit: this.limit,
          page,
          source: "wy"
        };
      },
      getDetailPageUrl(id) {
        if (typeof id == "string")
          id = id.replace("wy__", "");
        return `https://music.163.com/#/discover/toplist?id=${id}`;
      }
    };
  }
});

// src/vendor/musicSdk/wy/lyric.js
var require_lyric4 = __commonJS({
  "src/vendor/musicSdk/wy/lyric.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var crypto_1 = require_crypto();
    var eapiRequest = (url, data) => {
      return (0, request_1.httpFetch)("https://interface3.music.163.com/eapi/song/lyric/v1", {
        method: "post",
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
          origin: "https://music.163.com"
          // cookie: 'os=pc; deviceId=A9C064BB4584D038B1565B58CB05F95290998EE8B025AA2D07AE; osver=Microsoft-Windows-10-Home-China-build-19043-64bit; appver=2.5.2.197409; channel=netease; MUSIC_A=37a11f2eb9de9930cad479b2ad495b0e4c982367fb6f909d9a3f18f876c6b49faddb3081250c4980dd7e19d4bd9bf384e004602712cf2b2b8efaafaab164268a00b47359f85f22705cc95cb6180f3aee40f5be1ebf3148d888aa2d90636647d0c3061cd18d77b7a0; __csrf=05b50d54082694f945d7de75c210ef94; mode=Z7M-KP5(7)GZ; NMTID=00OZLp2VVgq9QdwokUgq3XNfOddQyIAAAF_6i8eJg; ntes_kaola_ad=1',
        },
        form: (0, crypto_1.eapi)(url, data)
      });
    };
    var parseTools = {
      rxps: {
        info: /^{"/,
        lineTime: /^\[(\d+),\d+\]/,
        wordTime: /\(\d+,\d+,\d+\)/,
        wordTimeAll: /(\(\d+,\d+,\d+\))/g
      },
      msFormat(timeMs) {
        if (Number.isNaN(timeMs))
          return "";
        let ms = timeMs % 1e3;
        timeMs /= 1e3;
        let m = parseInt(timeMs / 60).toString().padStart(2, "0");
        timeMs %= 60;
        let s = parseInt(timeMs).toString().padStart(2, "0");
        return `[${m}:${s}.${ms}]`;
      },
      parseLyric(lines) {
        const lxlrcLines = [];
        const lrcLines = [];
        for (let line of lines) {
          line = line.trim();
          let result = this.rxps.lineTime.exec(line);
          if (!result) {
            if (line.startsWith("[offset")) {
              lxlrcLines.push(line);
              lrcLines.push(line);
            }
            continue;
          }
          const startMsTime = parseInt(result[1]);
          const startTimeStr = this.msFormat(startMsTime);
          if (!startTimeStr)
            continue;
          let words = line.replace(this.rxps.lineTime, "");
          lrcLines.push(`${startTimeStr}${words.replace(this.rxps.wordTimeAll, "")}`);
          let times = words.match(this.rxps.wordTimeAll);
          if (!times)
            continue;
          times = times.map((time) => {
            const result2 = /\((\d+),(\d+),\d+\)/.exec(time);
            return `<${Math.max(parseInt(result2[1]) - startMsTime, 0)},${result2[2]}>`;
          });
          const wordArr = words.split(this.rxps.wordTime);
          wordArr.shift();
          const newWords = times.map((time, index) => `${time}${wordArr[index]}`).join("");
          lxlrcLines.push(`${startTimeStr}${newWords}`);
        }
        return {
          lyric: lrcLines.join("\n"),
          lxlyric: lxlrcLines.join("\n")
        };
      },
      parseHeaderInfo(str) {
        str = str.trim();
        str = str.replace(/\r/g, "");
        if (!str)
          return null;
        const lines = str.split("\n");
        return lines.map((line) => {
          if (!this.rxps.info.test(line))
            return line;
          try {
            const info = JSON.parse(line);
            const timeTag = this.msFormat(info.t);
            return timeTag ? `${timeTag}${info.c.map((t) => t.tx).join("")}` : "";
          } catch {
            return "";
          }
        });
      },
      getIntv(interval) {
        if (!interval)
          return 0;
        if (!interval.includes("."))
          interval += ".0";
        let arr = interval.split(/:|\./);
        while (arr.length < 3)
          arr.unshift("0");
        const [m, s, ms] = arr;
        return parseInt(m) * 36e5 + parseInt(s) * 1e3 + parseInt(ms);
      },
      fixTimeTag(lrc, targetlrc) {
        let lrcLines = lrc.split("\n");
        const targetlrcLines = targetlrc.split("\n");
        const timeRxp = /^\[([\d:.]+)\]/;
        let temp = [];
        let newLrc = [];
        targetlrcLines.forEach((line) => {
          const result = timeRxp.exec(line);
          if (!result)
            return;
          const words = line.replace(timeRxp, "");
          if (!words.trim())
            return;
          const t1 = this.getIntv(result[1]);
          while (lrcLines.length) {
            const lrcLine = lrcLines.shift();
            const lrcLineResult = timeRxp.exec(lrcLine);
            if (!lrcLineResult)
              continue;
            const t2 = this.getIntv(lrcLineResult[1]);
            if (Math.abs(t1 - t2) < 100) {
              const lrc2 = line.replace(timeRxp, lrcLineResult[0]).trim();
              if (!lrc2)
                continue;
              newLrc.push(lrc2);
              break;
            }
            temp.push(lrcLine);
          }
          lrcLines = [...temp, ...lrcLines];
          temp = [];
        });
        return newLrc.join("\n");
      },
      parse(ylrc, ytlrc, yrlrc, lrc, tlrc, rlrc) {
        const info = {
          lyric: "",
          tlyric: "",
          rlyric: "",
          lxlyric: ""
        };
        if (ylrc) {
          let lines = this.parseHeaderInfo(ylrc);
          if (lines) {
            const result = this.parseLyric(lines);
            if (ytlrc) {
              const lines2 = this.parseHeaderInfo(ytlrc);
              if (lines2) {
                info.tlyric = this.fixTimeTag(result.lyric, lines2.join("\n"));
              }
            }
            if (yrlrc) {
              const lines2 = this.parseHeaderInfo(yrlrc);
              if (lines2) {
                info.rlyric = this.fixTimeTag(result.lyric, lines2.join("\n"));
              }
            }
            const timeRxp = /^\[[\d:.]+\]/;
            const headers = lines.filter((l) => timeRxp.test(l)).join("\n");
            info.lyric = `${headers}
${result.lyric}`;
            info.lxlyric = result.lxlyric;
            return info;
          }
        }
        if (lrc) {
          const lines = this.parseHeaderInfo(lrc);
          if (lines)
            info.lyric = lines.join("\n");
        }
        if (tlrc) {
          const lines = this.parseHeaderInfo(tlrc);
          if (lines)
            info.tlyric = lines.join("\n");
        }
        if (rlrc) {
          const lines = this.parseHeaderInfo(rlrc);
          if (lines)
            info.rlyric = lines.join("\n");
        }
        return info;
      }
    };
    var fixTimeLabel = (lrc, tlrc, romalrc) => {
      if (lrc) {
        let newLrc = lrc.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, "[$1.$2]");
        let newTlrc = tlrc?.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, "[$1.$2]") ?? tlrc;
        if (newLrc != lrc || newTlrc != tlrc) {
          lrc = newLrc;
          tlrc = newTlrc;
          if (romalrc)
            romalrc = romalrc.replace(/\[(\d{2}:\d{2}):(\d{2,3})]/g, "[$1.$2]").replace(/\[(\d{2}:\d{2}\.\d{2})0]/g, "[$1]");
        }
      }
      return { lrc, tlrc, romalrc };
    };
    exports2.default = (songmid) => {
      const requestObj = eapiRequest("/api/song/lyric/v1", {
        id: songmid,
        cp: false,
        tv: 0,
        lv: 0,
        rv: 0,
        kv: 0,
        yv: 0,
        ytv: 0,
        yrv: 0
      });
      requestObj.promise = requestObj.promise.then(({ body }) => {
        if (body.code !== 200 || !body?.lrc?.lyric)
          return Promise.reject(new Error("Get lyric failed"));
        const fixTimeLabelLrc = fixTimeLabel(body.lrc.lyric, body.tlyric?.lyric, body.romalrc?.lyric);
        const info = parseTools.parse(body.yrc?.lyric, body.ytlrc?.lyric, body.yromalrc?.lyric, fixTimeLabelLrc.lrc, fixTimeLabelLrc.tlrc, fixTimeLabelLrc.romalrc);
        if (!info.lyric)
          return Promise.reject(new Error("Get lyric failed"));
        return info;
      });
      return requestObj;
    };
  }
});

// src/vendor/musicSdk/wy/musicInfo.js
var require_musicInfo2 = __commonJS({
  "src/vendor/musicSdk/wy/musicInfo.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var crypto_1 = require_crypto();
    exports2.default = (songmid) => {
      const requestObj = (0, request_1.httpFetch)("https://music.163.com/weapi/v3/song/detail", {
        method: "post",
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
          Referer: "https://music.163.com/song?id=" + songmid,
          origin: "https://music.163.com"
        },
        form: (0, crypto_1.weapi)({
          c: `[{"id":${songmid}}]`,
          ids: `[${songmid}]`
        })
      });
      requestObj.promise = requestObj.promise.then(({ body }) => {
        if (body.code !== 200 || !body.songs.length)
          return Promise.reject(new Error("获取歌曲信息失败"));
        return body.songs[0];
      });
      return requestObj;
    };
  }
});

// src/vendor/musicSdk/wy/utils/index.js
var require_utils2 = __commonJS({
  "src/vendor/musicSdk/wy/utils/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.weapiRequest = exports2.eapiRequest = void 0;
    var request_1 = require_request();
    var crypto_1 = require_crypto();
    var eapiRequest = (url, data) => {
      return (0, request_1.httpFetch)("http://interface.music.163.com/eapi/batch", {
        method: "post",
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
          origin: "https://music.163.com"
        },
        form: (0, crypto_1.eapi)(url, data)
      });
    };
    exports2.eapiRequest = eapiRequest;
    var weapiRequest = (url, data) => {
      return (0, request_1.httpFetch)(`https://music.163.com/weapi${url}`, {
        method: "post",
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
          origin: "https://music.163.com",
          Referer: "https://music.163.com/"
        },
        form: (0, crypto_1.weapi)(data)
      });
    };
    exports2.weapiRequest = weapiRequest;
  }
});

// src/vendor/musicSdk/wy/musicSearch.js
var require_musicSearch4 = __commonJS({
  "src/vendor/musicSdk/wy/musicSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var index_1 = require_vendor();
    var index_2 = require_utils2();
    var quality_1 = require_quality2();
    exports2.default = {
      limit: 30,
      total: 0,
      page: 0,
      allPage: 1,
      musicSearch(str, page, limit) {
        const searchRequest = (0, index_2.eapiRequest)("/api/search/song/list/page", {
          keyword: str,
          needCorrect: "1",
          channel: "typing",
          offset: limit * (page - 1),
          scene: "normal",
          total: page == 1,
          limit
        });
        return searchRequest.promise.then(({ body }) => body);
      },
      getSinger(singers) {
        let arr = [];
        singers.forEach((singer) => {
          arr.push(singer.name);
        });
        return arr.join("、");
      },
      handleResult(rawList) {
        if (!rawList)
          return [];
        return rawList.map((item) => {
          item = item.baseInfo.simpleSongData;
          const { types, _types } = (0, quality_1.buildQualitys)(item, item.privilege);
          return {
            singer: this.getSinger(item.ar),
            name: item.name,
            albumName: item.al.name,
            albumId: item.al.id,
            source: "wy",
            interval: (0, index_1.formatPlayTime)(item.dt / 1e3),
            songmid: item.id,
            img: item.al.picUrl,
            lrc: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      search(str, page = 1, limit, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        if (limit == null)
          limit = this.limit;
        return this.musicSearch(str, page, limit).then((result) => {
          if (!result || result.code !== 200)
            return this.search(str, page, limit, retryNum);
          let list = this.handleResult(result.data.resources || []);
          if (list == null)
            return this.search(str, page, limit, retryNum);
          this.total = result.data.totalCount || 0;
          this.page = page;
          this.allPage = Math.ceil(this.total / this.limit);
          return {
            list,
            allPage: this.allPage,
            limit: this.limit,
            total: this.total,
            source: "wy"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/wy/extendSearch.js
var require_extendSearch2 = __commonJS({
  "src/vendor/musicSdk/wy/extendSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var index_1 = require_utils2();
    var utils_1 = require_utils();
    exports2.default = {
      /**
       * 搜索歌手
       * @param {*} str 搜索关键词
       * @param {*} page 页码
       * @param {*} limit 每页数量
       * @param {*} retryNum 重试次数
       */
      searchSinger(str, page = 1, limit = 20, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        const searchRequest = (0, index_1.eapiRequest)("/api/cloudsearch/pc", {
          s: str,
          type: 100,
          // 歌手类型
          limit,
          total: page === 1,
          // 仅第一页返回总数
          offset: limit * (page - 1)
        });
        return searchRequest.promise.then(({ body: result }) => {
          if (!result || result.code !== 200)
            return this.searchSinger(str, page, limit, retryNum);
          const list = this.handleSingerResult(result.result.artists);
          return {
            list,
            total: result.result.artistCount || 0,
            allPage: Math.ceil((result.result.artistCount || 0) / limit),
            limit,
            source: "wy"
          };
        });
      },
      /**
       * 搜索专辑
       * @param {*} str 搜索关键词
       * @param {*} page 页码
       * @param {*} limit 每页数量
       * @param {*} retryNum 重试次数
       */
      searchAlbum(str, page = 1, limit = 20, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        const searchRequest = (0, index_1.eapiRequest)("/api/cloudsearch/pc", {
          s: str,
          type: 10,
          // 专辑类型
          limit,
          total: page === 1,
          offset: limit * (page - 1)
        });
        return searchRequest.promise.then(({ body: result }) => {
          if (!result || result.code !== 200)
            return this.searchAlbum(str, page, limit, retryNum);
          const list = this.handleAlbumResult(result.result.albums);
          return {
            list,
            total: result.result.albumCount || 0,
            allPage: Math.ceil((result.result.albumCount || 0) / limit),
            limit,
            source: "wy"
          };
        });
      },
      /**
       * 搜索歌单
       * @param {*} str 搜索关键词
       * @param {*} page 页码
       * @param {*} limit 每页数量
       * @param {*} retryNum 重试次数
       */
      searchPlaylist(str, page = 1, limit = 20, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        const searchRequest = (0, index_1.eapiRequest)("/api/cloudsearch/pc", {
          s: str,
          type: 1e3,
          // 歌单类型
          limit,
          total: page === 1,
          offset: limit * (page - 1)
        });
        return searchRequest.promise.then(({ body: result }) => {
          if (!result || result.code !== 200)
            return this.searchPlaylist(str, page, limit, retryNum);
          const list = this.handlePlaylistResult(result.result.playlists);
          return {
            list,
            total: result.result.playlistCount || 0,
            allPage: Math.ceil((result.result.playlistCount || 0) / limit),
            limit,
            source: "wy"
          };
        });
      },
      /**
       * 处理搜索歌手结果格式
       * @param {*} rawList 原始结果列表
       */
      handleSingerResult(rawList) {
        if (!rawList)
          return [];
        return rawList.map((item) => ({
          id: item.id,
          name: item.name,
          picUrl: item.picUrl,
          alias: item.alias,
          albumSize: item.albumSize,
          source: "wy"
        }));
      },
      /**
       * 处理搜索专辑结果格式
       * @param {*} rawList 原始结果列表
       */
      handleAlbumResult(rawList) {
        if (!rawList)
          return [];
        return rawList.map((item) => ({
          id: item.id,
          name: item.name,
          picUrl: item.picUrl,
          artistName: item.artist ? item.artist.name : item.artists ? (0, utils_1.formatSingerName)(item.artists) : "",
          artistId: item.artist ? item.artist.id : item.artists ? item.artists[0].id : null,
          size: item.size,
          publishTime: item.publishTime,
          source: "wy"
        }));
      },
      /**
       * 处理搜索歌单结果格式
       * @param {*} rawList 原始结果列表
       */
      handlePlaylistResult(rawList) {
        if (!rawList)
          return [];
        return rawList.map((item) => ({
          id: item.id,
          name: item.name,
          picUrl: item.coverImgUrl,
          playCount: item.playCount,
          trackCount: item.trackCount,
          creator: item.creator ? item.creator.nickname : "",
          source: "wy"
        }));
      }
    };
  }
});

// src/vendor/musicSdk/wy/extendDetail.js
var require_extendDetail2 = __commonJS({
  "src/vendor/musicSdk/wy/extendDetail.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var index_1 = require_utils2();
    var utils_1 = require_utils();
    var musicDetail_1 = __importDefault(require_musicDetail());
    exports2.default = {
      /**
       * 获取歌手详情
       * @param {*} id 歌手 ID
       */
      getArtistDetail(id) {
        return (0, index_1.weapiRequest)("/artist/head/info/get", { id }).promise.then(({ body }) => {
          if (!body || body.code !== 200)
            throw new Error("Get artist detail failed");
          const data = body.data || {};
          const artist = data.artist || {};
          return {
            source: "wy",
            id: artist.id || id,
            name: artist.name || "未知歌手",
            desc: artist.briefDesc || "",
            avatar: data.user && data.user.avatarUrl || artist.avatar || artist.cover || artist.picUrl || "",
            musicSize: artist.musicSize || 0,
            albumSize: artist.albumSize || 0
          };
        });
      },
      /**
       * 获取歌手歌曲
       * @param {*} id 歌手 ID
       */
      getArtistSongs(id, page = 1, limit = 100, order = "hot") {
        return (0, index_1.weapiRequest)("/v1/artist/songs", {
          id,
          limit,
          offset: limit * (page - 1),
          order,
          private_cloud: "true",
          work_type: 1
        }).promise.then(({ body }) => {
          if (!body || body.code !== 200)
            throw new Error("Get artist songs failed");
          return {
            list: musicDetail_1.default.filterList({ songs: body.songs, privileges: body.songs.map((s) => s.privilege || {}) }),
            total: body.total,
            source: "wy"
          };
        });
      },
      /**
       * 获取歌手专辑列表
       * @param {*} id 歌手 ID
       */
      getArtistAlbums(id, page = 1, limit = 50) {
        return (0, index_1.weapiRequest)(`/artist/albums/${id}`, {
          limit,
          offset: limit * (page - 1),
          total: true
        }).promise.then(({ body }) => {
          if (!body || body.code !== 200)
            throw new Error("Get artist albums failed");
          return {
            source: "wy",
            list: (body.hotAlbums || []).map((item) => ({
              id: item.id,
              name: item.name,
              img: item.picUrl,
              singer: (0, utils_1.formatSingerName)(item.artists),
              publishTime: item.publishTime ? new Date(item.publishTime).toISOString().split("T")[0] : void 0,
              total: item.size
            })),
            total: body.artist ? body.artist.albumSize : body.hotAlbums ? body.hotAlbums.length : 0
          };
        });
      },
      /**
       * 获取专辑歌曲
       * @param {*} id 专辑 ID
       */
      getAlbumSongs(id) {
        return (0, index_1.weapiRequest)(`/v1/album/${id}`, {}).promise.then(({ body }) => {
          if (!body || body.code !== 200 && body.code !== 502) {
            throw new Error(`Get album songs failed: ${body ? body.code : "No body"}`);
          }
          if (body.code === 502) {
            return {
              list: [],
              total: 0,
              source: "wy"
            };
          }
          const songs = body.songs || [];
          if (songs.length === 0) {
            console.warn(`[WY SDK] Album ${id} returned no songs. Body code: ${body.code}`);
          }
          return {
            list: musicDetail_1.default.filterList({
              songs,
              privileges: songs.map((s) => s.privilege || { id: s.id })
            }),
            total: songs.length,
            name: body.album ? body.album.name : void 0,
            publishTime: body.album ? new Date(body.album.publishTime).toISOString().split("T")[0] : void 0,
            source: "wy"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/wy/songList.js
var require_songList4 = __commonJS({
  "src/vendor/musicSdk/wy/songList.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var crypto_1 = require_crypto();
    var request_1 = require_request();
    var index_1 = require_vendor();
    var musicDetail_1 = __importDefault(require_musicDetail());
    var index_2 = require_utils2();
    var utils_1 = require_utils();
    var quality_1 = require_quality2();
    exports2.default = {
      _requestObj_tags: null,
      _requestObj_hotTags: null,
      _requestObj_list: null,
      limit_list: 30,
      limit_song: 1e5,
      successCode: 200,
      cookie: "MUSIC_U=",
      sortList: [
        {
          name: "最热",
          id: "hot"
        }
        // {
        //   name: '最新',
        //   id: 'new',
        // },
      ],
      regExps: {
        listDetailLink: /^.+(?:\?|&)id=(\d+)(?:&.*$|#.*$|$)/,
        listDetailLink2: /^.+\/playlist\/(\d+)\/\d+\/.+$/
      },
      async handleParseId(link, retryNum = 0) {
        if (retryNum > 2)
          throw new Error("link try max num");
        const requestObj_listDetailLink = (0, request_1.httpFetch)(link);
        const { headers: { location }, statusCode } = await requestObj_listDetailLink.promise;
        if (statusCode > 400)
          return this.handleParseId(link, ++retryNum);
        const url = location == null ? link : location;
        return this.regExps.listDetailLink.test(url) ? url.replace(this.regExps.listDetailLink, "$1") : url.replace(this.regExps.listDetailLink2, "$1");
      },
      async getListId(id) {
        let cookie;
        if (/###/.test(id)) {
          const [url, token] = id.split("###");
          id = url;
          cookie = `MUSIC_U=${token}`;
        }
        if (/[?&:/]/.test(id)) {
          if (this.regExps.listDetailLink.test(id)) {
            id = id.replace(this.regExps.listDetailLink, "$1");
          } else if (this.regExps.listDetailLink2.test(id)) {
            id = id.replace(this.regExps.listDetailLink2, "$1");
          } else {
            id = await this.handleParseId(id);
          }
        }
        return { id, cookie };
      },
      async getListDetail(rawId, page, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        const { id, cookie } = await this.getListId(rawId);
        if (cookie)
          this.cookie = cookie;
        const requestObj_listDetail = (0, request_1.httpFetch)("https://music.163.com/api/linux/forward", {
          method: "post",
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
            Cookie: this.cookie
          },
          form: (0, crypto_1.linuxapi)({
            method: "POST",
            url: "https://music.163.com/api/v3/playlist/detail",
            params: {
              id,
              n: this.limit_song,
              s: 8
            }
          })
        });
        const { statusCode, body } = await requestObj_listDetail.promise;
        if (statusCode !== 200 || body.code !== this.successCode)
          return this.getListDetail(id, page, ++tryNum);
        let limit = 1e3;
        let rangeStart = (page - 1) * limit;
        let list;
        if (body.playlist.trackIds.length == body.privileges.length) {
          list = this.filterListDetail(body);
        } else {
          try {
            list = (await musicDetail_1.default.getList(body.playlist.trackIds.slice(rangeStart, limit * page).map((trackId) => trackId.id))).list;
          } catch (err) {
            console.log(err);
            if (err.message == "try max num") {
              throw err;
            } else {
              return this.getListDetail(id, page, ++tryNum);
            }
          }
        }
        return {
          list,
          page,
          limit,
          total: body.playlist.trackIds.length,
          source: "wy",
          info: {
            play_count: (0, index_1.formatPlayCount)(body.playlist.playCount),
            name: body.playlist.name,
            img: body.playlist.coverImgUrl,
            desc: body.playlist.description,
            author: body.playlist.creator.nickname
          }
        };
      },
      filterListDetail({ playlist: { tracks }, privileges }) {
        const list = [];
        tracks.forEach((item, index) => {
          let privilege = privileges[index];
          if (privilege.id !== item.id)
            privilege = privileges.find((p) => p.id === item.id);
          if (!privilege)
            return;
          const { types, _types } = (0, quality_1.buildQualitys)(item, privilege);
          if (item.pc) {
            list.push({
              singer: item.pc.ar ?? "",
              name: item.pc.sn ?? "",
              albumName: item.pc.alb ?? "",
              albumId: item.al?.id,
              source: "wy",
              interval: (0, index_1.formatPlayTime)(item.dt / 1e3),
              songmid: item.id,
              img: item.al?.picUrl ?? "",
              lrc: null,
              otherSource: null,
              types,
              _types,
              typeUrl: {}
            });
          } else {
            list.push({
              singer: (0, utils_1.formatSingerName)(item.ar, "name"),
              name: item.name ?? "",
              albumName: item.al?.name,
              albumId: item.al?.id,
              source: "wy",
              interval: (0, index_1.formatPlayTime)(item.dt / 1e3),
              songmid: item.id,
              img: item.al?.picUrl,
              lrc: null,
              otherSource: null,
              types,
              _types,
              typeUrl: {}
            });
          }
        });
        return list;
      },
      // 获取列表数据
      getList(sortId, tagId, page, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        if (this._requestObj_list)
          this._requestObj_list.cancelHttp();
        this._requestObj_list = (0, request_1.httpFetch)("https://music.163.com/weapi/playlist/list", {
          method: "post",
          form: (0, crypto_1.weapi)({
            cat: tagId || "全部",
            // 全部,华语,欧美,日语,韩语,粤语,小语种,流行,摇滚,民谣,电子,舞曲,说唱,轻音乐,爵士,乡村,R&B/Soul,古典,民族,英伦,金属,朋克,蓝调,雷鬼,世界音乐,拉丁,另类/独立,New Age,古风,后摇,Bossa Nova,清晨,夜晚,学习,工作,午休,下午茶,地铁,驾车,运动,旅行,散步,酒吧,怀旧,清新,浪漫,性感,伤感,治愈,放松,孤独,感动,兴奋,快乐,安静,思念,影视原声,ACG,儿童,校园,游戏,70后,80后,90后,网络歌曲,KTV,经典,翻唱,吉他,钢琴,器乐,榜单,00后
            order: sortId,
            // hot,new
            limit: this.limit_list,
            offset: this.limit_list * (page - 1),
            total: true
          })
        });
        return this._requestObj_list.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getList(sortId, tagId, page, ++tryNum);
          return {
            list: this.filterList(body.playlists),
            total: parseInt(body.total),
            page,
            limit: this.limit_list,
            source: "wy"
          };
        });
      },
      filterList(rawData) {
        return rawData.map((item) => ({
          play_count: (0, index_1.formatPlayCount)(item.playCount),
          id: String(item.id),
          author: item.creator.nickname,
          name: item.name,
          time: item.createTime ? (0, index_1.dateFormat)(item.createTime, "Y-M-D") : "",
          img: item.coverImgUrl,
          grade: item.grade,
          total: item.trackCount,
          desc: item.description,
          source: "wy"
        }));
      },
      // 获取标签
      getTag(tryNum = 0) {
        if (this._requestObj_tags)
          this._requestObj_tags.cancelHttp();
        this._requestObj_tags = (0, request_1.httpFetch)("https://music.163.com/weapi/playlist/catalogue", {
          method: "post",
          form: (0, crypto_1.weapi)({})
        });
        return this._requestObj_tags.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getTag(++tryNum);
          return this.filterTagInfo(body);
        });
      },
      filterTagInfo({ sub, categories }) {
        const subList = {};
        for (const item of sub) {
          if (!subList[item.category])
            subList[item.category] = [];
          subList[item.category].push({
            parent_id: categories[item.category],
            parent_name: categories[item.category],
            id: item.name,
            name: item.name,
            source: "wy"
          });
        }
        const list = [];
        for (const key of Object.keys(categories)) {
          list.push({
            name: categories[key],
            list: subList[key],
            source: "wy"
          });
        }
        return list;
      },
      // 获取热门标签
      getHotTag(tryNum = 0) {
        if (this._requestObj_hotTags)
          this._requestObj_hotTags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_hotTags = (0, request_1.httpFetch)("https://music.163.com/weapi/playlist/hottags", {
          method: "post",
          form: (0, crypto_1.weapi)({})
        });
        return this._requestObj_hotTags.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getTag(++tryNum);
          return this.filterHotTagInfo(body.tags);
        });
      },
      filterHotTagInfo(rawList) {
        return rawList.map((item) => ({
          id: item.playlistTag.name,
          name: item.playlistTag.name,
          source: "wy"
        }));
      },
      getTags() {
        return Promise.all([this.getTag(), this.getHotTag()]).then(([tags, hotTag]) => ({ tags, hotTag, source: "wy" }));
      },
      async getDetailPageUrl(rawId) {
        const { id } = await this.getListId(rawId);
        return `https://music.163.com/#/playlist?id=${id}`;
      },
      search(text, page, limit = 20) {
        return (0, index_2.eapiRequest)("/api/cloudsearch/pc", {
          s: text,
          type: 1e3,
          // 1: 单曲, 10: 专辑, 100: 歌手, 1000: 歌单, 1002: 用户, 1004: MV, 1006: 歌词, 1009: 电台, 1014: 视频
          limit,
          total: page == 1,
          offset: limit * (page - 1)
        }).promise.then(({ body }) => {
          if (body.code != this.successCode)
            throw new Error("filed");
          return {
            list: this.filterList(body.result.playlists),
            limit,
            total: body.result.playlistCount,
            source: "wy"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/wy/hotSearch.js
var require_hotSearch4 = __commonJS({
  "src/vendor/musicSdk/wy/hotSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var index_1 = require_utils2();
    exports2.default = {
      _requestObj: null,
      async getList(retryNum = 0) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const _requestObj = (0, index_1.eapiRequest)("/api/search/chart/detail", {
          id: "HOT_SEARCH_SONG#@#"
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.code !== 200)
          throw new Error("获取热搜词失败");
        return { source: "wy", list: this.filterList(body.data.itemList) };
      },
      filterList(rawList) {
        return rawList.map((item) => item.searchWord);
      }
    };
  }
});

// src/vendor/musicSdk/wy/comment.js
var require_comment4 = __commonJS({
  "src/vendor/musicSdk/wy/comment.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var crypto_1 = require_crypto();
    var index_1 = require_vendor();
    var emojis = [
      ["大笑", "😃"],
      ["可爱", "😊"],
      ["憨笑", "☺️"],
      ["色", "😍"],
      ["亲亲", "😙"],
      ["惊恐", "😱"],
      ["流泪", "😭"],
      ["亲", "😚"],
      ["呆", "😳"],
      ["哀伤", "😔"],
      ["呲牙", "😁"],
      ["吐舌", "😝"],
      ["撇嘴", "😒"],
      ["怒", "😡"],
      ["奸笑", "😏"],
      ["汗", "😓"],
      ["痛苦", "😖"],
      ["惶恐", "😰"],
      ["生病", "😨"],
      ["口罩", "😷"],
      ["大哭", "😂"],
      ["晕", "😵"],
      ["发怒", "👿"],
      ["开心", "😄"],
      ["鬼脸", "😜"],
      ["皱眉", "😞"],
      ["流感", "😢"],
      ["爱心", "❤️"],
      ["心碎", "💔"],
      ["钟情", "💘"],
      ["星星", "⭐️"],
      ["生气", "💢"],
      ["便便", "💩"],
      ["强", "👍"],
      ["弱", "👎"],
      ["拜", "🙏"],
      ["牵手", "👫"],
      ["跳舞", "👯‍♀️"],
      ["禁止", "🙅‍♀️"],
      ["这边", "💁‍♀️"],
      ["爱意", "💏"],
      ["示爱", "👩‍❤️‍👨"],
      ["嘴唇", "👄"],
      ["狗", "🐶"],
      ["猫", "🐱"],
      ["猪", "🐷"],
      ["兔子", "🐰"],
      ["小鸡", "🐤"],
      ["公鸡", "🐔"],
      ["幽灵", "👻"],
      ["圣诞", "🎅"],
      ["外星", "👽"],
      ["钻石", "💎"],
      ["礼物", "🎁"],
      ["男孩", "👦"],
      ["女孩", "👧"],
      ["蛋糕", "🎂"],
      ["18", "🔞"],
      ["圈", "⭕"],
      ["叉", "❌"]
    ];
    var applyEmoji = (text) => {
      for (const e of emojis)
        text = text.replaceAll(`[${e[0]}]`, e[1]);
      return text;
    };
    var cursorTools = {
      cache: {},
      getCursor(id, page, limit) {
        let cacheData = this.cache[id];
        if (!cacheData)
          cacheData = this.cache[id] = {};
        let orderType;
        let cursor;
        let offset;
        if (page == 1) {
          cacheData.page = 1;
          cursor = cacheData.cursor = cacheData.prevCursor = Date.now();
          orderType = 1;
          offset = 0;
        } else if (cacheData.page) {
          cursor = cacheData.cursor;
          if (page > cacheData.page) {
            orderType = 1;
            offset = (page - cacheData.page - 1) * limit;
          } else if (page < cacheData.page) {
            orderType = 0;
            offset = (cacheData.page - page - 1) * limit;
          } else {
            cursor = cacheData.cursor = cacheData.prevCursor;
            offset = cacheData.offset;
            orderType = cacheData.orderType;
          }
        }
        return {
          orderType,
          cursor,
          offset
        };
      },
      setCursor(id, cursor, orderType, offset, page) {
        let cacheData = this.cache[id];
        if (!cacheData)
          cacheData = this.cache[id] = {};
        cacheData.prevCursor = cacheData.cursor;
        cacheData.cursor = cursor;
        cacheData.orderType = orderType;
        cacheData.offset = offset;
        cacheData.page = page;
      }
    };
    exports2.default = {
      _requestObj: null,
      _requestObj2: null,
      async getComment({ songmid }, page = 1, limit = 20) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        const id = "R_SO_4_" + songmid;
        const cursorInfo = cursorTools.getCursor(songmid, page, limit);
        const _requestObj = (0, request_1.httpFetch)("https://music.163.com/weapi/comment/resource/comments/get", {
          method: "post",
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
            origin: "https://music.163.com",
            Refere: "http://music.163.com/"
          },
          form: (0, crypto_1.weapi)({
            cursor: cursorInfo.cursor,
            offset: cursorInfo.offset,
            orderType: cursorInfo.orderType,
            pageNo: page,
            pageSize: limit,
            rid: id,
            threadId: id
          })
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.code !== 200)
          throw new Error("获取评论失败");
        cursorTools.setCursor(songmid, body.data.cursor, cursorInfo.orderType, cursorInfo.offset, page);
        return { source: "wy", comments: this.filterComment(body.data.comments), total: body.data.totalCount, page, limit, maxPage: Math.ceil(body.data.totalCount / limit) || 1 };
      },
      async getHotComment({ songmid }, page = 1, limit = 100) {
        if (this._requestObj2)
          this._requestObj2.cancelHttp();
        const id = "R_SO_4_" + songmid;
        page = page - 1;
        const _requestObj2 = (0, request_1.httpFetch)(`https://music.163.com/weapi/v1/resource/hotcomments/${id}`, {
          method: "post",
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
            origin: "https://music.163.com",
            Refere: "http://music.163.com/"
          },
          form: (0, crypto_1.weapi)({
            rid: id,
            limit,
            offset: limit * page,
            beforeTime: Date.now().toString()
          })
        });
        const { body, statusCode } = await _requestObj2.promise;
        if (statusCode != 200 || body.code !== 200)
          throw new Error("获取热门评论失败");
        const total = body.total ?? 0;
        return { source: "wy", comments: this.filterComment(body.hotComments), total, page, limit, maxPage: Math.ceil(total / limit) || 1 };
      },
      filterComment(rawList) {
        return rawList.map((item) => {
          let data = {
            id: item.commentId,
            text: item.content ? applyEmoji(item.content) : "",
            time: item.time ? item.time : "",
            timeStr: item.time ? (0, index_1.dateFormat2)(item.time) : "",
            location: item.ipLocation?.location,
            userName: item.user.nickname,
            avatar: item.user.avatarUrl,
            userId: item.user.userId,
            likedCount: item.likedCount,
            reply: []
          };
          let replyData = item.beReplied && item.beReplied[0];
          return replyData ? {
            id: item.commentId,
            rootId: replyData.beRepliedCommentId,
            text: replyData.content ? applyEmoji(replyData.content) : "",
            time: item.time,
            timeStr: null,
            location: replyData.ipLocation?.location,
            userName: replyData.user.nickname,
            avatar: replyData.user.avatarUrl,
            userId: replyData.user.userId,
            likedCount: null,
            reply: [data]
          } : data;
        });
      }
    };
  }
});

// src/vendor/musicSdk/wy/tipSearch.js
var require_tipSearch4 = __commonJS({
  "src/vendor/musicSdk/wy/tipSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var crypto_1 = require_crypto();
    var utils_1 = require_utils();
    exports2.default = {
      requestObj: null,
      cancelTipSearch() {
        if (this.requestObj && this.requestObj.cancelHttp)
          this.requestObj.cancelHttp();
      },
      tipSearchBySong(str) {
        this.cancelTipSearch();
        this.requestObj = (0, request_1.httpFetch)("https://music.163.com/weapi/search/suggest/web", {
          method: "POST",
          headers: {
            referer: "https://music.163.com/",
            origin: "https://music.163.com/"
          },
          form: (0, crypto_1.weapi)({
            s: str
          })
        });
        return this.requestObj.promise.then(({ statusCode, body }) => {
          if (statusCode != 200 || body.code != 200)
            return Promise.reject(new Error("请求失败"));
          return body.result.songs;
        });
      },
      handleResult(rawData) {
        return rawData.map((info) => `${info.name} - ${(0, utils_1.formatSingerName)(info.artists, "name")}`);
      },
      async search(str) {
        return this.tipSearchBySong(str).then((result) => this.handleResult(result));
      }
    };
  }
});

// src/vendor/musicSdk/wy/index.js
var require_wy = __commonJS({
  "src/vendor/musicSdk/wy/index.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var leaderboard_1 = __importDefault(require_leaderboard4());
    var api_source_1 = require_api_source();
    var lyric_1 = __importDefault(require_lyric4());
    var musicInfo_1 = __importDefault(require_musicInfo2());
    var musicSearch_1 = __importDefault(require_musicSearch4());
    var extendSearch_1 = __importDefault(require_extendSearch2());
    var extendDetail_1 = __importDefault(require_extendDetail2());
    var songList_1 = __importDefault(require_songList4());
    var hotSearch_1 = __importDefault(require_hotSearch4());
    var comment_1 = __importDefault(require_comment4());
    var tipSearch_1 = __importDefault(require_tipSearch4());
    var wy = {
      tipSearch: tipSearch_1.default,
      leaderboard: leaderboard_1.default,
      musicSearch: musicSearch_1.default,
      extendSearch: extendSearch_1.default,
      extendDetail: extendDetail_1.default,
      songList: songList_1.default,
      hotSearch: hotSearch_1.default,
      comment: comment_1.default,
      getMusicUrl(songInfo, type) {
        return (0, api_source_1.apis)("wy").getMusicUrl(songInfo, type);
      },
      getLyric(songInfo) {
        return (0, lyric_1.default)(songInfo.songmid);
      },
      getPic(songInfo) {
        const requestObj = (0, musicInfo_1.default)(songInfo.songmid);
        return requestObj.promise.then((info) => info.al.picUrl);
      },
      getMusicDetailPageUrl(songInfo) {
        return `https://music.163.com/#/song?id=${songInfo.songmid}`;
      }
    };
    exports2.default = wy;
  }
});

// src/vendor/musicSdk/mg/utils/index.js
var require_utils3 = __commonJS({
  "src/vendor/musicSdk/mg/utils/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createHttpFetch = void 0;
    var request_1 = require_request();
    var createHttpFetch = async (url, options, retryNum = 0) => {
      if (retryNum > 2)
        throw new Error("try max num");
      let result;
      try {
        result = await (0, request_1.httpFetch)(url, options).promise;
      } catch (err) {
        console.log(err);
        return (0, exports2.createHttpFetch)(url, options, ++retryNum);
      }
      if (result.statusCode !== 200 || (result.body.code !== void 0 ? result.body.code : result.body.returnCode !== void 0 ? result.body.returnCode : result.body.code) !== "000000")
        return (0, exports2.createHttpFetch)(url, options, ++retryNum);
      if (result.body.data)
        return result.body.data;
      return result.body;
    };
    exports2.createHttpFetch = createHttpFetch;
  }
});

// src/vendor/musicSdk/mg/musicInfo.js
var require_musicInfo3 = __commonJS({
  "src/vendor/musicSdk/mg/musicInfo.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getMusicInfos = exports2.getMusicInfo = exports2.filterMusicInfoListV5 = exports2.filterMusicInfoList = void 0;
    var index_1 = require_vendor();
    var utils_1 = require_utils3();
    var utils_2 = require_utils();
    var createGetMusicInfosTask = (ids) => {
      let list = ids;
      let tasks = [];
      while (list.length) {
        tasks.push(list.slice(0, 100));
        if (list.length < 100)
          break;
        list = list.slice(100);
      }
      let url = "https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2";
      return Promise.all(tasks.map((task) => (0, utils_1.createHttpFetch)(url, {
        method: "POST",
        form: {
          resourceId: task.join("|")
        }
      }).then((data) => data.resource)));
    };
    var filterMusicInfoList = (rawList) => {
      let ids = /* @__PURE__ */ new Set();
      const list = [];
      rawList.forEach((item) => {
        if (!item.songId || ids.has(item.songId))
          return;
        ids.add(item.songId);
        const types = [];
        const _types = {};
        item.newRateFormats?.forEach((type) => {
          let size;
          switch (type.formatType) {
            case "PQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "128k", size });
              _types["128k"] = {
                size
              };
              break;
            case "HQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "320k", size });
              _types["320k"] = {
                size
              };
              break;
            case "SQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "flac", size });
              _types.flac = {
                size
              };
              break;
            case "ZQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "flac24bit", size });
              _types.flac24bit = {
                size
              };
              break;
          }
        });
        const intervalTest = /(\d\d:\d\d)$/.test(item.length);
        list.push({
          singer: (0, utils_2.formatSingerName)(item.artists, "name"),
          name: item.songName,
          albumName: item.album,
          albumId: item.albumId,
          songmid: item.songId,
          copyrightId: item.copyrightId,
          source: "mg",
          interval: intervalTest ? RegExp.$1 : null,
          img: item.albumImgs?.length ? item.albumImgs[0].img : null,
          lrc: null,
          lrcUrl: item.lrcUrl,
          mrcUrl: item.mrcUrl,
          trcUrl: item.trcUrl,
          otherSource: null,
          types,
          _types,
          typeUrl: {}
        });
      });
      return list;
    };
    exports2.filterMusicInfoList = filterMusicInfoList;
    var filterMusicInfoListV5 = (rawList) => {
      let ids = /* @__PURE__ */ new Set();
      const list = [];
      rawList.forEach((item) => {
        if (!item.songId || ids.has(item.songId))
          return;
        ids.add(item.songId);
        const types = [];
        const _types = {};
        item.audioFormats?.forEach((type) => {
          let size;
          switch (type.formatType) {
            case "PQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "128k", size });
              _types["128k"] = {
                size
              };
              break;
            case "HQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "320k", size });
              _types["320k"] = {
                size
              };
              break;
            case "SQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "flac", size });
              _types.flac = {
                size
              };
              break;
            case "ZQ":
              size = (0, index_1.sizeFormate)(type.size ?? type.androidSize);
              types.push({ type: "flac24bit", size });
              _types.flac24bit = {
                size
              };
              break;
          }
        });
        let img = item.img3 || item.img2 || item.img1 || null;
        if (img && !/https?:/.test(img))
          img = "http://d.musicapp.migu.cn" + img;
        list.push({
          singer: (0, utils_2.formatSingerName)(item.singerList, "name"),
          name: item.songName,
          albumName: item.album,
          albumId: item.albumId,
          songmid: item.songId,
          copyrightId: item.copyrightId,
          source: "mg",
          interval: (0, index_1.formatPlayTime)(item.duration),
          img,
          lrc: null,
          lrcUrl: item.lrcUrl,
          mrcUrl: item.mrcUrl,
          trcUrl: item.trcUrl,
          otherSource: null,
          types,
          _types,
          typeUrl: {}
        });
      });
      return list;
    };
    exports2.filterMusicInfoListV5 = filterMusicInfoListV5;
    var getMusicInfo = async (copyrightId) => {
      return (0, exports2.getMusicInfos)([copyrightId]).then((data) => data[0]);
    };
    exports2.getMusicInfo = getMusicInfo;
    var getMusicInfos = async (copyrightIds) => {
      return (0, exports2.filterMusicInfoList)(await Promise.all(createGetMusicInfosTask(copyrightIds)).then((data) => data.flat()));
    };
    exports2.getMusicInfos = getMusicInfos;
  }
});

// src/vendor/musicSdk/mg/leaderboard.js
var require_leaderboard5 = __commonJS({
  "src/vendor/musicSdk/mg/leaderboard.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var musicInfo_1 = require_musicInfo3();
    var boardList = [
      {
        id: "mg__27553319",
        name: "新歌榜",
        bangid: "27553319",
        source: "mg"
      },
      {
        id: "mg__27186466",
        name: "热歌榜",
        bangid: "27186466",
        source: "mg"
      },
      {
        id: "mg__27553408",
        name: "原创榜",
        bangid: "27553408",
        source: "mg"
      },
      {
        id: "mg__75959118",
        name: "音乐风向榜",
        bangid: "75959118",
        source: "mg"
      },
      {
        id: "mg__76557036",
        name: "彩铃分贝榜",
        bangid: "76557036",
        source: "mg"
      },
      {
        id: "mg__76557745",
        name: "会员臻爱榜",
        bangid: "76557745",
        source: "mg"
      },
      {
        id: "mg__23189800",
        name: "港台榜",
        bangid: "23189800",
        source: "mg"
      },
      {
        id: "mg__23189399",
        name: "内地榜",
        bangid: "23189399",
        source: "mg"
      },
      {
        id: "mg__19190036",
        name: "欧美榜",
        bangid: "19190036",
        source: "mg"
      },
      {
        id: "mg__83176390",
        name: "国风金曲榜",
        bangid: "83176390",
        source: "mg"
      }
    ];
    exports2.default = {
      limit: 200,
      list: [
        {
          id: "mgyyb",
          name: "音乐榜",
          bangid: "27553319"
        },
        {
          id: "mgysb",
          name: "影视榜",
          bangid: "23603721"
        },
        {
          id: "mghybnd",
          name: "华语内地榜",
          bangid: "23603926"
        },
        {
          id: "mghyjqbgt",
          name: "华语港台榜",
          bangid: "23603954"
        },
        {
          id: "mgomb",
          name: "欧美榜",
          bangid: "23603974"
        },
        {
          id: "mgrhb",
          name: "日韩榜",
          bangid: "23603982"
        },
        {
          id: "mgwlb",
          name: "网络榜",
          bangid: "23604058"
        },
        {
          id: "mgclb",
          name: "彩铃榜",
          bangid: "23604023"
        },
        {
          id: "mgktvb",
          name: "KTV榜",
          bangid: "23604040"
        },
        {
          id: "mgrcb",
          name: "原创榜",
          bangid: "23604032"
        }
      ],
      getUrl(id, page) {
        return `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=${id}&needAll=0`;
      },
      successCode: "000000",
      requestBoardsObj: null,
      getBoardsData() {
        if (this.requestBoardsObj)
          this._requestBoardsObj.cancelHttp();
        this.requestBoardsObj = (0, request_1.httpFetch)("https://app.c.nf.migu.cn/pc/bmw/rank/rank-index/v1.0", {
          // this.requestBoardsObj = httpFetch('https://app.c.nf.migu.cn/MIGUM3.0/v1.0/template/rank-list/release', {
          // this.requestBoardsObj = httpFetch('https://app.c.nf.migu.cn/MIGUM2.0/v2.0/content/indexrank.do?templateVersion=8', {
          headers: {
            Referer: "https://app.c.nf.migu.cn/",
            "User-Agent": "Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36",
            channel: "0146921"
          }
        });
        return this.requestBoardsObj.promise;
      },
      getData(url) {
        const requestObj = (0, request_1.httpFetch)(url);
        return requestObj.promise;
      },
      // filterBoardsData(listData, list = [], ids = new Set()) {
      //   for (const item of listData) {
      //     if (item.rankId && !ids.has(item.rankId)) {
      //       ids.add(item.rankId)
      //       list.push({
      //         id: 'mg__' + item.rankId,
      //         name: item.rankName,
      //         bangid: String(item.rankId),
      //         source: 'mg',
      //       })
      //     } else if (item.contents) this.filterBoardsData(item.contents, list, ids)
      //   }
      //   return list
      // },
      // filterBoardsData(rawList) {
      //   // console.log(rawList)
      //   let list = []
      //   for (const board of rawList) {
      //     if (board.template != 'group1') continue
      //     for (const item of board.itemList) {
      //       if ((item.template != 'row1' && item.template != 'grid1' && !item.actionUrl) || !item.actionUrl.includes('rank-info')) continue
      //       let data = item.displayLogId.param
      //       list.push({
      //         id: 'mg__' + data.rankId,
      //         name: data.rankName,
      //         bangid: String(data.rankId),
      //       })
      //     }
      //   }
      //   return list
      // },
      async getBoards(retryNum = 0) {
        this.list = boardList;
        return {
          list: boardList,
          source: "mg"
        };
      },
      getList(bangid, page, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        return this.getData(this.getUrl(bangid, page)).then(({ statusCode, body }) => {
          if (statusCode !== 200 || body.code !== this.successCode)
            return this.getList(bangid, page, retryNum);
          const list = (0, musicInfo_1.filterMusicInfoList)(body.columnInfo.contents.map((m) => m.objectInfo));
          return {
            total: list.length,
            list,
            limit: this.limit,
            page,
            source: "mg"
          };
        });
      },
      getDetailPageUrl(id) {
        if (typeof id == "string")
          id = id.replace("mg__", "");
        for (const item of boardList) {
          if (item.bangid == id) {
            return `https://music.migu.cn/v3/music/top/${item.webId}`;
          }
        }
        return null;
      }
    };
  }
});

// src/vendor/musicSdk/mg/musicSearch.js
var require_musicSearch5 = __commonJS({
  "src/vendor/musicSdk/mg/musicSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createSignature = void 0;
    var request_1 = require_request();
    var index_1 = require_vendor();
    var utils_1 = require_utils();
    var createSignature = (time, str) => {
      const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
      const signatureMd5 = "6cdc72a439cef99a3418d2a78aa28c73";
      const sign = (0, utils_1.toMD5)(`${str}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`);
      return { sign, deviceId };
    };
    exports2.createSignature = createSignature;
    exports2.default = {
      limit: 20,
      total: 0,
      page: 0,
      allPage: 1,
      // 旧版API
      // musicSearch(str, page, limit) {
      //   const searchRequest = httpFetch(`http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=${encodeURIComponent(str)}&pageNo=${page}&pageSize=${limit}&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22songlist%22%3A0%2C%22bestShow%22%3A1%7D`, {
      // searchRequest = httpFetch(`http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=${encodeURIComponent(str)}&pageNo=${page}&pageSize=${limit}&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22songlist%22%3A0%2C%22bestShow%22%3A1%7D`, {
      // searchRequest = httpFetch(`http://jadeite.migu.cn:7090/music_search/v2/search/searchAll?sid=4f87090d01c84984a11976b828e2b02c18946be88a6b4c47bcdc92fbd40762db&isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0`, {
      // searchRequest = httpFetch(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?isCopyright=1&isCorrect=1&pageNo=${page}&pageSize=${limit}&searchSwitch={%22song%22:1,%22album%22:0,%22singer%22:0,%22tagSong%22:0,%22mvSong%22:0,%22songlist%22:0,%22bestShow%22:0}&sort=0&text=${encodeURIComponent(str)}`)
      //   // searchRequest = httpFetch(`http://jadeite.migu.cn:7090/music_search/v2/search/searchAll?sid=4f87090d01c84984a11976b828e2b02c18946be88a6b4c47bcdc92fbd40762db&isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0`, {
      //     headers: {
      //       // sign: 'c3b7ae985e2206e97f1b2de8f88691e2',
      //       // timestamp: 1578225871982,
      //       // appId: 'yyapp2',
      //       // mode: 'android',
      //       // ua: 'Android_migu',
      //       // version: '6.9.4',
      //       osVersion: 'android 7.0',
      //       'User-Agent': 'okhttp/3.9.1',
      //     },
      //   })
      //   // searchRequest = httpFetch(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?isCopyright=1&isCorrect=1&pageNo=${page}&pageSize=${limit}&searchSwitch={%22song%22:1,%22album%22:0,%22singer%22:0,%22tagSong%22:0,%22mvSong%22:0,%22songlist%22:0,%22bestShow%22:0}&sort=0&text=${encodeURIComponent(str)}`)
      //   return searchRequest.promise.then(({ body }) => body)
      // },
      // handleResult(rawData) {
      //   // console.log(rawData)
      //   let ids = new Set()
      //   const list = []
      //   rawData.forEach(item => {
      //     if (ids.has(item.id)) return
      //     ids.add(item.id)
      //     const types = []
      //     const _types = {}
      //     item.newRateFormats && item.newRateFormats.forEach(type => {
      //       let size
      //       switch (type.formatType) {
      //         case 'PQ':
      //           size = sizeFormate(type.size ?? type.androidSize)
      //           types.push({ type: '128k', size })
      //           _types['128k'] = {
      //             size,
      //           }
      //           break
      //         case 'HQ':
      //           size = sizeFormate(type.size ?? type.androidSize)
      //           types.push({ type: '320k', size })
      //           _types['320k'] = {
      //             size,
      //           }
      //           break
      //         case 'SQ':
      //           size = sizeFormate(type.size ?? type.androidSize)
      //           types.push({ type: 'flac', size })
      //           _types.flac = {
      //             size,
      //           }
      //           break
      //         case 'ZQ':
      //           size = sizeFormate(type.size ?? type.androidSize)
      //           types.push({ type: 'flac24bit', size })
      //           _types.flac24bit = {
      //             size,
      //           }
      //           break
      //       }
      //     })
      //     const albumNInfo = item.albums && item.albums.length
      //       ? {
      //           id: item.albums[0].id,
      //           name: item.albums[0].name,
      //         }
      //       : {}
      //     list.push({
      //       singer: this.getSinger(item.singers),
      //       name: item.name,
      //       albumName: albumNInfo.name,
      //       albumId: albumNInfo.id,
      //       songmid: item.songId,
      //       copyrightId: item.copyrightId,
      //       source: 'mg',
      //       interval: null,
      //       img: item.imgItems && item.imgItems.length ? item.imgItems[0].img : null,
      //       lrc: null,
      //       lrcUrl: item.lyricUrl,
      //       mrcUrl: item.mrcurl,
      //       trcUrl: item.trcUrl,
      //       otherSource: null,
      //       types,
      //       _types,
      //       typeUrl: {},
      //     })
      //   })
      //   return list
      // },
      musicSearch(str, page, limit) {
        const time = Date.now().toString();
        const signData = (0, exports2.createSignature)(time, str);
        const searchRequest = (0, request_1.httpFetch)(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0&sid=USS`, {
          headers: {
            uiVersion: "A_music_3.6.1",
            deviceId: signData.deviceId,
            timestamp: time,
            sign: signData.sign,
            channel: "0146921",
            "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"
          }
        });
        return searchRequest.promise.then(({ body }) => body);
      },
      filterData(rawData) {
        const list = [];
        const ids = /* @__PURE__ */ new Set();
        rawData.forEach((item) => {
          item.forEach((data) => {
            if (!data.songId || !data.copyrightId || ids.has(data.copyrightId))
              return;
            ids.add(data.copyrightId);
            const types = [];
            const _types = {};
            data.audioFormats && data.audioFormats.forEach((type) => {
              let size;
              switch (type.formatType) {
                case "PQ":
                  size = (0, index_1.sizeFormate)(type.asize ?? type.isize);
                  types.push({ type: "128k", size });
                  _types["128k"] = {
                    size
                  };
                  break;
                case "HQ":
                  size = (0, index_1.sizeFormate)(type.asize ?? type.isize);
                  types.push({ type: "320k", size });
                  _types["320k"] = {
                    size
                  };
                  break;
                case "SQ":
                  size = (0, index_1.sizeFormate)(type.asize ?? type.isize);
                  types.push({ type: "flac", size });
                  _types.flac = {
                    size
                  };
                  break;
                case "ZQ24":
                  size = (0, index_1.sizeFormate)(type.asize ?? type.isize);
                  types.push({ type: "flac24bit", size });
                  _types.flac24bit = {
                    size
                  };
                  break;
              }
            });
            let img = data.img3 || data.img2 || data.img1 || null;
            if (img && !/https?:/.test(data.img3))
              img = "http://d.musicapp.migu.cn" + img;
            list.push({
              singer: (0, utils_1.formatSingerName)(data.singerList),
              name: data.name,
              albumName: data.album,
              albumId: data.albumId,
              songmid: data.songId,
              copyrightId: data.copyrightId,
              source: "mg",
              interval: (0, index_1.formatPlayTime)(data.duration),
              img,
              lrc: null,
              lrcUrl: data.lrcUrl,
              mrcUrl: data.mrcurl,
              trcUrl: data.trcUrl,
              types,
              _types,
              typeUrl: {}
            });
          });
        });
        return list;
      },
      search(str, page = 1, limit, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        if (limit == null)
          limit = this.limit;
        return this.musicSearch(str, page, limit).then((result) => {
          if (!result || result.code !== "000000")
            return Promise.reject(new Error(result ? result.info : "搜索失败"));
          const songResultData = result.songResultData || { resultList: [], totalCount: 0 };
          let list = this.filterData(songResultData.resultList);
          if (list == null)
            return this.search(str, page, limit, retryNum);
          this.total = parseInt(songResultData.totalCount);
          this.page = page;
          this.allPage = Math.ceil(this.total / limit);
          return {
            list,
            allPage: this.allPage,
            limit,
            total: this.total,
            source: "mg"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/mg/songList.js
var require_songList5 = __commonJS({
  "src/vendor/musicSdk/mg/songList.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var musicInfo_1 = require_musicInfo3();
    var musicSearch_1 = require_musicSearch5();
    var index_2 = require_utils3();
    exports2.default = {
      _requestObj_tags: null,
      _requestObj_list: null,
      limit_list: 30,
      limit_song: 50,
      successCode: "000000",
      cachedDetailInfo: {},
      cachedUrl: {},
      sortList: [
        {
          name: "推荐",
          id: "15127315"
          // id: '1',
        }
        // {
        //   name: '最新',
        //   id: '15127272',
        //   // id: '2',
        // },
      ],
      regExps: {
        list: /<li><div class="thumb">.+?<\/li>/g,
        listInfo: /.+data-original="(.+?)".*data-id="(\d+)".*<div class="song-list-name"><a\s.*?>(.+?)<\/a>.+<i class="iconfont cf-bofangliang"><\/i>(.+?)<\/div>/,
        // https://music.migu.cn/v3/music/playlist/161044573?page=1
        listDetailLink: /^.+\/playlist\/(\d+)(?:\?.*|&.*$|#.*$|$)/
      },
      tagsUrl: "https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-taglist/release",
      // tagsUrl: 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/indexTagPage.do?needAll=0',
      getSongListUrl(sortId, tagId, page) {
        if (!tagId) {
          return `https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0?templateVersion=2&pageNo=${page}`;
        }
        return `https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-listbytag/release?pageNumber=${page}&templateVersion=2&tagId=${tagId}`;
      },
      getSongListDetailUrl(id, page) {
        return `https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=${this.limit_song}&playlistId=${id}`;
      },
      defaultHeaders: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1",
        Referer: "https://m.music.migu.cn/"
        // language: 'Chinese',
        // ua: 'Android_migu',
        // mode: 'android',
        // version: '6.8.5',
      },
      getListDetailList(id, page, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        const requestObj_listDetail = (0, request_1.httpFetch)(this.getSongListDetailUrl(id, page), { headers: this.defaultHeaders });
        return requestObj_listDetail.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getListDetailList(id, page, ++tryNum);
          return {
            list: (0, musicInfo_1.filterMusicInfoListV5)(body.data.songList),
            page,
            limit: this.limit_song,
            total: body.data.totalCount,
            source: "mg"
          };
        });
      },
      getListDetailInfo(id, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        if (this.cachedDetailInfo[id])
          return Promise.resolve(this.cachedDetailInfo[id]);
        const requestObj_listDetailInfo = (0, request_1.httpFetch)(`https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId=${id}`, {
          headers: this.defaultHeaders
        });
        return requestObj_listDetailInfo.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getListDetail(id, ++tryNum);
          const cachedDetailInfo = this.cachedDetailInfo[id] = {
            name: body.data.title,
            img: body.data.imgItem.img,
            desc: body.data.summary,
            author: body.data.ownerName,
            play_count: (0, index_1.formatPlayCount)(body.data.opNumItem.playNum)
          };
          return cachedDetailInfo;
        });
      },
      async getDetailUrl(link, page, retryNum = 0) {
        if (retryNum > 3)
          return Promise.reject(new Error("link try max num"));
        const requestObj_listDetailLink = (0, request_1.httpFetch)(link, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1",
            Referer: link
          }
        });
        const { headers: { location }, statusCode } = await requestObj_listDetailLink.promise;
        if (statusCode > 400)
          return this.getDetailUrl(link, page, ++retryNum);
        if (location) {
          this.cachedUrl[link] = location;
          return this.getListDetail(location, page);
        }
        return Promise.reject(new Error("link get failed"));
      },
      getListDetail(id, page, retryNum = 0) {
        if (/\/playlist[/?]/.test(id)) {
          id = /(?:playlistId|id)=(\d+)/.exec(id)?.[1];
          if (!id)
            throw new Error("list detail id parse failed");
        } else if (this.regExps.listDetailLink.test(id)) {
          id = id.replace(this.regExps.listDetailLink, "$1");
        } else if (/[?&:/]/.test(id)) {
          const url = this.cachedUrl[id];
          return url ? this.getListDetail(url, page) : this.getDetailUrl(id, page);
        }
        return Promise.all([
          this.getListDetailList(id, page, retryNum),
          this.getListDetailInfo(id, retryNum)
        ]).then(([listData, info]) => {
          listData.info = info;
          return listData;
        });
      },
      // 获取列表数据
      getList(sortId, tagId, page, tryNum = 0) {
        if (this._requestObj_list)
          this._requestObj_list.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_list = (0, request_1.httpFetch)(this.getSongListUrl(sortId, tagId, page), {
          headers: this.defaultHeaders
          // headers: {
          //   sign: 'c3b7ae985e2206e97f1b2de8f88691e2',
          //   timestamp: 1578225871982,
          //   appId: 'yyapp2',
          //   mode: 'android',
          //   ua: 'Android_migu',
          //   version: '6.9.4',
          //   osVersion: 'android 7.0',
          //   'User-Agent': 'okhttp/3.9.1',
          // },
        });
        return this._requestObj_list.promise.then(({ body }) => {
          if (body.code !== "000000")
            return this.getList(sortId, tagId, page, ++tryNum);
          const list = body.data.contents ? this.filterList2(body.data.contents) : this.filterList(body.data.contentItemList[1].itemList);
          return {
            list,
            total: 99999,
            page,
            limit: this.limit_list,
            source: "mg"
          };
        });
      },
      filterList2(listData, list = [], ids = /* @__PURE__ */ new Set()) {
        for (const item of listData) {
          if (item.contents)
            this.filterList2(item.contents, list, ids);
          else if (item.resType == "2021" && !ids.has(item.resId)) {
            ids.add(item.resId);
            list.push({
              id: String(item.resId),
              author: "",
              name: item.txt,
              // time: dateFormat(item.createTime, 'Y-M-D'),
              img: item.img,
              // grade: item.grade,
              // total: item.contentCount,
              desc: item.txt2,
              source: "mg"
            });
          }
        }
        return list;
      },
      filterList(rawData) {
        return rawData.map((item) => ({
          play_count: item.barList[0]?.title,
          id: String(item.logEvent.contentId),
          author: "",
          name: item.title,
          // time: dateFormat(item.createTime, 'Y-M-D'),
          img: item.imageUrl,
          // grade: item.grade,
          // total: item.contentCount,
          desc: "",
          source: "mg"
        }));
      },
      // 获取标签
      getTag(tryNum = 0) {
        if (this._requestObj_tags)
          this._requestObj_tags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_tags = (0, request_1.httpFetch)(this.tagsUrl, { headers: this.defaultHeaders });
        return this._requestObj_tags.promise.then(({ body }) => {
          if (body.code !== this.successCode)
            return this.getTag(++tryNum);
          return this.filterTagInfo(body.data);
        });
      },
      filterTagInfo(rawList) {
        return {
          hotTag: rawList[0].content.map(({ texts: [name, id] }) => ({
            id,
            name,
            source: "mg"
          })),
          tags: rawList.slice(1).map(({ header, content }) => ({
            name: header.title,
            list: content.map(({ texts: [name, id] }) => ({
              // parent_id: objectInfo.columnId,
              // parent_name: objectInfo.columnTitle,
              id,
              name,
              source: "mg"
            }))
          })),
          source: "mg"
        };
      },
      getTags() {
        return this.getTag();
      },
      getDetailPageUrl(id) {
        if (/playlist\/index\.html\?/.test(id)) {
          id = id.replace(/.*(?:\?|&)id=(\d+)(?:&.*|$)/, "$1");
        } else if (this.regExps.listDetailLink.test(id)) {
          id = id.replace(this.regExps.listDetailLink, "$1");
        }
        return `https://music.migu.cn/v3/music/playlist/${id}`;
      },
      filterSongListResult(raw) {
        const list = [];
        raw.forEach((item) => {
          if (!item.id)
            return;
          const playCount = parseInt(item.playNum);
          list.push({
            play_count: isNaN(playCount) ? 0 : (0, index_1.formatPlayCount)(playCount),
            id: item.id,
            author: item.userName,
            name: item.name,
            img: item.musicListPicUrl,
            total: item.musicNum,
            source: "mg"
          });
        });
        return list;
      },
      search(text, page, limit = 20) {
        const timeStr = Date.now().toString();
        const signResult = (0, musicSearch_1.createSignature)(timeStr, text);
        return (0, index_2.createHttpFetch)(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22bestShow%22%3A0%2C%22songlist%22%3A1%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(text)}&pageNo=${page}&sort=0&sid=USS`, {
          headers: {
            uiVersion: "A_music_3.6.1",
            deviceId: signResult.deviceId,
            timestamp: timeStr,
            sign: signResult.sign,
            channel: "0146921",
            "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"
          }
        }).then((body) => {
          if (!body.songListResultData)
            throw new Error("get song list faild.");
          const list = this.filterSongListResult(body.songListResultData.result);
          return {
            list,
            limit,
            total: parseInt(body.songListResultData.totalCount),
            source: "mg"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/mg/songId.js
var require_songId = __commonJS({
  "src/vendor/musicSdk/mg/songId.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var musicInfo_1 = require_musicInfo3();
    var getSongId = async (mInfo) => {
      if (mInfo.songmid != mInfo.copyrightId)
        return mInfo.songmid;
      const musicInfo = await (0, musicInfo_1.getMusicInfo)(mInfo.copyrightId);
      return musicInfo.songmid;
    };
    exports2.default = getSongId;
  }
});

// src/vendor/musicSdk/mg/pic.js
var require_pic3 = __commonJS({
  "src/vendor/musicSdk/mg/pic.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    var request_1 = require_request();
    var songId_1 = __importDefault(require_songId());
    exports2.default = {
      async getPicUrl(songId) {
        const requestObj = (0, request_1.httpFetch)(`http://music.migu.cn/v3/api/music/audioPlayer/getSongPic?songId=${songId}`, {
          headers: {
            Referer: "http://music.migu.cn/v3/music/player/audio?from=migu"
          }
        });
        const { body } = await requestObj.promise;
        if (body.returnCode !== "000000")
          throw new Error("图片获取失败");
        let url = body.largePic || body.mediumPic || body.smallPic;
        if (!/https?:/.test(url))
          url = "http:" + url;
        return url;
      },
      async getPic(songInfo) {
        const songId = await (0, songId_1.default)(songInfo);
        return this.getPicUrl(songId);
      }
    };
  }
});

// src/vendor/musicSdk/mg/utils/mrc.js
var require_mrc = __commonJS({
  "src/vendor/musicSdk/mg/utils/mrc.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.decrypt = void 0;
    var DELTA = 2654435769n;
    var MIN_LENGTH = 32;
    var keyArr = [
      27303562373562475n,
      18014862372307051n,
      22799692160172081n,
      34058940340699235n,
      30962724186095721n,
      27303523720101991n,
      27303523720101998n,
      31244139033526382n,
      28992395054481524n
    ];
    var teaDecrypt = (data, key) => {
      const length = data.length;
      const lengthBitint = BigInt(length);
      if (length >= 1) {
        let j2 = data[0];
        let j3 = toLong((6n + 52n / lengthBitint) * DELTA);
        while (true) {
          let j4 = j3;
          if (j4 == 0n)
            break;
          let j5 = toLong(3n & toLong(j4 >> 2n));
          let j6 = lengthBitint;
          while (true) {
            j6--;
            if (j6 > 0n) {
              let j7 = data[j6 - 1n];
              let i = j6;
              j2 = toLong(data[i] - (toLong(toLong(j2 ^ j4) + toLong(j7 ^ key[toLong(toLong(3n & j6) ^ j5)])) ^ toLong(toLong(toLong(j7 >> 5n) ^ toLong(j2 << 2n)) + toLong(toLong(j2 >> 3n) ^ toLong(j7 << 4n)))));
              data[i] = j2;
            } else
              break;
          }
          let j8 = data[lengthBitint - 1n];
          j2 = toLong(data[0n] - toLong(toLong(toLong(key[toLong(toLong(j6 & 3n) ^ j5)] ^ j8) + toLong(j2 ^ j4)) ^ toLong(toLong(toLong(j8 >> 5n) ^ toLong(j2 << 2n)) + toLong(toLong(j2 >> 3n) ^ toLong(j8 << 4n)))));
          data[0] = j2;
          j3 = toLong(j4 - DELTA);
        }
      }
      return data;
    };
    var longArrToString = (data) => {
      const arrayList = [];
      for (const j of data)
        arrayList.push(longToBytes(j).toString("utf16le"));
      return arrayList.join("");
    };
    var longToBytes = (l) => {
      const result = Buffer.alloc(8);
      for (let i = 0; i < 8; i++) {
        result[i] = parseInt(l & 0xffn);
        l >>= 8n;
      }
      return result;
    };
    var toBigintArray = (data) => {
      const length = Math.floor(data.length / 16);
      const jArr = Array(length);
      for (let i = 0; i < length; i++) {
        jArr[i] = toLong(data.substring(i * 16, i * 16 + 16));
      }
      return jArr;
    };
    var MAX = 9223372036854775807n;
    var MIN = -9223372036854775808n;
    var toLong = (str) => {
      const num = typeof str == "string" ? BigInt("0x" + str) : str;
      if (num > MAX)
        return toLong(num - (1n << 64n));
      else if (num < MIN)
        return toLong(num + (1n << 64n));
      return num;
    };
    var decrypt = (data) => {
      return data == null || data.length < MIN_LENGTH ? data : longArrToString(teaDecrypt(toBigintArray(data), keyArr));
    };
    exports2.decrypt = decrypt;
  }
});

// src/vendor/musicSdk/mg/lyric.js
var require_lyric5 = __commonJS({
  "src/vendor/musicSdk/mg/lyric.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var musicInfo_1 = require_musicInfo3();
    var mrc_1 = require_mrc();
    var mrcTools = {
      rxps: {
        lineTime: /^\s*\[(\d+),\d+\]/,
        wordTime: /\(\d+,\d+\)/,
        wordTimeAll: /(\(\d+,\d+\))/g
      },
      parseLyric(str) {
        str = str.replace(/\r/g, "");
        const lines = str.split("\n");
        const lxlrcLines = [];
        const lrcLines = [];
        for (const line of lines) {
          if (line.length < 6)
            continue;
          let result = this.rxps.lineTime.exec(line);
          if (!result)
            continue;
          const startTime = parseInt(result[1]);
          let time = startTime;
          let ms = time % 1e3;
          time /= 1e3;
          let m = parseInt(time / 60).toString().padStart(2, "0");
          time %= 60;
          let s = parseInt(time).toString().padStart(2, "0");
          time = `${m}:${s}.${ms}`;
          let words = line.replace(this.rxps.lineTime, "");
          lrcLines.push(`[${time}]${words.replace(this.rxps.wordTimeAll, "")}`);
          let times = words.match(this.rxps.wordTimeAll);
          if (!times)
            continue;
          times = times.map((time2) => {
            const result2 = /\((\d+),(\d+)\)/.exec(time2);
            return `<${parseInt(result2[1]) - startTime},${result2[2]}>`;
          });
          const wordArr = words.split(this.rxps.wordTime);
          const newWords = times.map((time2, index) => `${time2}${wordArr[index]}`).join("");
          lxlrcLines.push(`[${time}]${newWords}`);
        }
        return {
          lyric: lrcLines.join("\n"),
          lxlyric: lxlrcLines.join("\n")
        };
      },
      getText(url, tryNum = 0) {
        const requestObj = (0, request_1.httpFetch)(url, {
          headers: {
            Referer: "https://app.c.nf.migu.cn/",
            "User-Agent": "Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36",
            channel: "0146921"
          }
        });
        return requestObj.promise.then(({ statusCode, body }) => {
          if (statusCode == 200)
            return body;
          if (tryNum > 5 || statusCode == 404)
            return Promise.reject(new Error("歌词获取失败"));
          return this.getText(url, ++tryNum);
        });
      },
      getMrc(url) {
        return this.getText(url).then((text) => {
          return this.parseLyric((0, mrc_1.decrypt)(text));
        });
      },
      getLrc(url) {
        return this.getText(url).then((text) => {
          const lines = text.split("\n");
          const hasTimeTag = /^\[(\d+):(\d+)\.(\d+)\]/.test(text);
          if (hasTimeTag) {
            const linesWithTime = lines.filter((line) => /^\[(\d+):(\d+)\.(\d+)\]/.test(line));
            if (linesWithTime.length > lines.length * 0.5) {
              return { lxlyric: "", lyric: text };
            }
          }
          let currentTime = 0;
          const lrcLines = lines.map((line, index) => {
            line = line.trim();
            if (!line || line.startsWith("@"))
              return "";
            const minutes = Math.floor(currentTime / 60);
            const seconds = currentTime % 60;
            const timeTag = `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.00]`;
            currentTime += 3;
            return `${timeTag}${line}`;
          }).filter((line) => line);
          return { lxlyric: "", lyric: lrcLines.join("\n") };
        });
      },
      getTrc(url) {
        if (!url)
          return Promise.resolve("");
        return this.getText(url);
      },
      async getMusicInfo(songInfo) {
        return songInfo.mrcUrl == null ? (0, musicInfo_1.getMusicInfo)(songInfo.copyrightId) : songInfo;
      },
      getLyric(songInfo) {
        return {
          promise: this.getMusicInfo(songInfo).then((info) => {
            let p;
            if (info.mrcUrl)
              p = this.getMrc(info.mrcUrl);
            else if (info.lrcUrl)
              p = this.getLrc(info.lrcUrl);
            if (p == null)
              return Promise.reject(new Error("获取歌词失败"));
            return Promise.all([p, this.getTrc(info.trcUrl)]).then(([lrcInfo, tlyric]) => {
              lrcInfo.tlyric = tlyric;
              return lrcInfo;
            });
          }),
          cancelHttp() {
          }
        };
      }
    };
    exports2.default = {
      getLyric(songInfo) {
        let requestObj = mrcTools.getLyric(songInfo);
        return requestObj;
      }
    };
  }
});

// src/vendor/musicSdk/mg/hotSearch.js
var require_hotSearch5 = __commonJS({
  "src/vendor/musicSdk/mg/hotSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      _requestObj: null,
      async getList(retryNum = 0) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const _requestObj = (0, request_1.httpFetch)("http://jadeite.migu.cn:7090/music_search/v3/search/hotword");
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.code !== "000000")
          throw new Error("获取热搜词失败");
        return { source: "mg", list: this.filterList(body.data.hotwords[0].hotwordList) };
      },
      filterList(rawList) {
        return rawList.filter((item) => item.resourceType == "song").map((item) => item.word);
      }
    };
  }
});

// src/vendor/musicSdk/mg/comment.js
var require_comment5 = __commonJS({
  "src/vendor/musicSdk/mg/comment.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var songId_1 = __importDefault(require_songId());
    var index_1 = require_vendor();
    exports2.default = {
      _requestObj: null,
      _requestObj2: null,
      _requestObj3: null,
      lastCommentIds: /* @__PURE__ */ new Map(),
      async getComment(musicInfo, page = 1, limit = 20) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        if (!musicInfo.songId) {
          let id = await (0, songId_1.default)(musicInfo);
          if (!id)
            throw new Error("获取评论失败");
          musicInfo.songId = id;
        }
        if (page === 1)
          this.lastCommentIds.clear();
        const lastCommentId = this.lastCommentIds.get(String(page)) || "";
        if (!lastCommentId && page > 1)
          throw new Error("获取评论失败");
        const _requestObj = (0, request_1.httpFetch)(`https://app.c.nf.migu.cn/MIGUM3.0/user/comment/stack/v1.0?pageSize=${limit}&queryType=1&resourceId=${musicInfo.songId}&resourceType=2&commentId=${lastCommentId}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
            // Referer: 'https://music.migu.cn',
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.code !== "000000")
          throw new Error("获取评论失败");
        const total = parseInt(body.data.commentNums);
        const list = this.filterComment(body.data.comments);
        this.lastCommentIds.set(String(page + 1), list.length ? list[list.length - 1].id : "");
        return { source: "mg", comments: list, total, page, limit, maxPage: Math.ceil(total / limit) || 1 };
      },
      async getHotComment(musicInfo, page = 1, limit = 20) {
        if (this._requestObj2)
          this._requestObj2.cancelHttp();
        if (!musicInfo.songId) {
          let id = await (0, songId_1.default)(musicInfo);
          if (!id)
            throw new Error("获取评论失败");
          musicInfo.songId = id;
        }
        const _requestObj2 = (0, request_1.httpFetch)(`https://app.c.nf.migu.cn/MIGUM3.0/user/comment/stack/v1.0?pageSize=${limit}&queryType=2&resourceId=${musicInfo.songId}&resourceType=2&hotCommentStart=${(page - 1) * limit}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
            // Referer: 'https://music.migu.cn',
          }
        });
        const { body, statusCode } = await _requestObj2.promise;
        if (statusCode != 200 || body.code !== "000000")
          throw new Error("获取热门评论失败");
        const total = parseInt(body.data.cfgHotCount);
        return { source: "mg", comments: this.filterComment(body.data.hotComments), total, page, limit, maxPage: Math.ceil(total / limit) || 1 };
      },
      async getReplyComment(musicInfo, replyId, page = 1, limit = 10) {
        if (this._requestObj2)
          this._requestObj2.cancelHttp();
        const _requestObj2 = (0, request_1.httpFetch)(`https://app.c.nf.migu.cn/MIGUM3.0/user/comment/stack/${replyId}/v1.0?pageSize=${limit}&queryType=2&resourceId=${musicInfo.songId}&resourceType=2&start=${(page - 1) * limit}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
          }
        });
        const { body, statusCode } = await _requestObj2.promise;
        if (statusCode != 200 || body.code !== "000000")
          throw new Error("获取回复评论失败");
        const total = parseInt(body.data.replyTotalCount);
        return { source: "mg", comments: this.filterComment(body.data.mainCommentItem.replyComments), total, page, limit, maxPage: Math.ceil(total / limit) || 1 };
      },
      filterComment(rawList) {
        return rawList.map((item) => ({
          id: item.commentId,
          text: item.commentInfo,
          time: item.commentTime,
          timeStr: (0, index_1.dateFormat2)(new Date(item.commentTime).getTime()),
          userName: item.user.nickName,
          avatar: item.user.middleIcon || item.user.bigIcon || item.user.smallIcon,
          userId: item.user.userId,
          likedCount: item.opNumItem.thumbNum,
          replyNum: item.replyTotalCount,
          reply: item.replyComments.map((c) => ({
            id: c.replyId,
            text: c.replyInfo,
            time: c.replyTime,
            timeStr: (0, index_1.dateFormat2)(new Date(c.replyTime).getTime()),
            userName: c.user.nickName,
            avatar: c.user.middleIcon || c.user.bigIcon || c.user.smallIcon,
            userId: c.user.userId,
            likedCount: null,
            replyNum: null
          }))
        }));
      }
    };
  }
});

// src/vendor/musicSdk/mg/tipSearch.js
var require_tipSearch5 = __commonJS({
  "src/vendor/musicSdk/mg/tipSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var utils_1 = require_utils3();
    exports2.default = {
      requestObj: null,
      cancelTipSearch() {
        if (this.requestObj && this.requestObj.cancelHttp)
          this.requestObj.cancelHttp();
      },
      tipSearchBySong(str) {
        this.cancelTipSearch();
        this.requestObj = (0, utils_1.createHttpFetch)(`https://app.u.nf.migu.cn/pc/resource/content/tone_search_suggest/v1.0?text=${encodeURIComponent(str)}`);
        return this.requestObj.then((data) => {
          return data.songList || [];
        }).catch(() => []);
      },
      handleResult(rawData) {
        if (!rawData)
          return [];
        return rawData.map((info) => info.songName);
      },
      async search(str) {
        return this.tipSearchBySong(str).then((result) => this.handleResult(result));
      }
    };
  }
});

// src/vendor/musicSdk/mg/index.js
var require_mg = __commonJS({
  "src/vendor/musicSdk/mg/index.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var api_source_1 = require_api_source();
    var leaderboard_1 = __importDefault(require_leaderboard5());
    var songList_1 = __importDefault(require_songList5());
    var musicSearch_1 = __importDefault(require_musicSearch5());
    var pic_1 = __importDefault(require_pic3());
    var lyric_1 = __importDefault(require_lyric5());
    var hotSearch_1 = __importDefault(require_hotSearch5());
    var comment_1 = __importDefault(require_comment5());
    var tipSearch_1 = __importDefault(require_tipSearch5());
    var mg = {
      tipSearch: tipSearch_1.default,
      songList: songList_1.default,
      musicSearch: musicSearch_1.default,
      leaderboard: leaderboard_1.default,
      hotSearch: hotSearch_1.default,
      comment: comment_1.default,
      getMusicUrl(songInfo, type) {
        return (0, api_source_1.apis)("mg").getMusicUrl(songInfo, type);
      },
      getLyric(songInfo) {
        return lyric_1.default.getLyric(songInfo);
      },
      getPic(songInfo) {
        return pic_1.default.getPic(songInfo);
      },
      getMusicDetailPageUrl(songInfo) {
        return `http://music.migu.cn/v3/music/song/${songInfo.copyrightId}`;
      }
    };
    exports2.default = mg;
  }
});

// src/vendor/musicSdk/bd/leaderboard.js
var require_leaderboard6 = __commonJS({
  "src/vendor/musicSdk/bd/leaderboard.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var boardList = [
      // { id: 'bd__601', name: '歌单榜', bangid: '601' },
      { id: "bd__2", name: "热歌榜", bangid: "2" },
      { id: "bd__20", name: "华语金曲榜", bangid: "20" },
      { id: "bd__25", name: "网络歌曲榜", bangid: "25" },
      { id: "bd__1", name: "新歌榜", bangid: "1" },
      { id: "bd__21", name: "欧美金曲榜", bangid: "21" },
      { id: "bd__200", name: "原创音乐榜", bangid: "200" },
      { id: "bd__22", name: "经典老歌榜", bangid: "22" },
      { id: "bd__24", name: "影视金曲榜", bangid: "24" },
      { id: "bd__23", name: "情歌对唱榜", bangid: "23" },
      { id: "bd__11", name: "摇滚榜", bangid: "11" },
      { id: "bd__105", name: "好童星榜", bangid: "105" },
      { id: "bd__106", name: "雅克•藏羌彝原创音乐榜", bangid: "106" }
    ];
    exports2.default = {
      limit: 20,
      list: [
        {
          id: "bdrgb",
          name: "热歌榜",
          bangid: "2"
        },
        {
          id: "bdxgb",
          name: "新歌榜",
          bangid: "1"
        },
        {
          id: "bdycb",
          name: "原创榜",
          bangid: "200"
        },
        {
          id: "bdhyjqb",
          name: "华语榜",
          bangid: "20"
        },
        {
          id: "bdomjqb",
          name: "欧美榜",
          bangid: "21"
        },
        {
          id: "bdwugqb",
          name: "网络榜",
          bangid: "25"
        },
        {
          id: "bdjdlgb",
          name: "老歌榜",
          bangid: "22"
        },
        {
          id: "bdysjqb",
          name: "影视金曲榜",
          bangid: "24"
        },
        {
          id: "bdqgdcb",
          name: "情歌对唱榜",
          bangid: "23"
        },
        {
          id: "bdygb",
          name: "摇滚榜",
          bangid: "11"
        }
      ],
      getUrl(id, p) {
        return `http://musicmini.qianqian.com/2018/static/bangdan/bangdanList_${id}_${p}.html`;
      },
      regExps: {
        item: /data-song="({.+?})"/g,
        info: /{total[\s:]+"(\d+)", size[\s:]+"(\d+)", page[\s:]+"(\d+)"}/
      },
      getData(url) {
        const requestObj = (0, request_1.httpFetch)(url);
        return requestObj.promise;
      },
      filterData(rawList) {
        return rawList.map((item) => {
          const types = [];
          const _types = {};
          let size = null;
          types.push({ type: "128k", size });
          _types["128k"] = {
            size
          };
          if (item.biaoshi) {
            types.push({ type: "320k", size });
            _types["320k"] = {
              size
            };
            types.push({ type: "flac", size });
            _types.flac = {
              size
            };
          }
          return {
            singer: item.song_artist.replace(",", "、"),
            name: item.song_title,
            albumName: item.album_title,
            albumId: item.album_id,
            source: "bd",
            interval: "",
            songmid: item.song_id,
            img: null,
            lrc: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      },
      parseData(rawData) {
        return rawData.map((item) => JSON.parse(item.replace(this.regExps.item, "$1").replace(/&quot;/g, '"').replace(/\\\//g, "/")));
      },
      async getBoards(retryNum = 0) {
        this.list = boardList;
        return {
          list: boardList,
          source: "bd"
        };
      },
      getList(bangid, page, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        return this.getData(this.getUrl(bangid, page)).then(({ body }) => {
          let result = body.match(this.regExps.item);
          if (!result)
            return this.getList(bangid, page, retryNum);
          let info = body.match(this.regExps.info);
          if (!info)
            return this.getList(bangid, page, retryNum);
          const list = this.filterData(this.parseData(result));
          this.limit = parseInt(info[2]);
          return {
            total: parseInt(info[1]),
            list,
            limit: this.limit,
            page: parseInt(info[3]),
            source: "bd"
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/bd/musicInfo.js
var require_musicInfo4 = __commonJS({
  "src/vendor/musicSdk/bd/musicInfo.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      cache: {},
      getMusicInfo(songmid) {
        if (this.cache[songmid]) {
          return { promise: Promise.resolve(this.cache[songmid]) };
        }
        const requestObj = (0, request_1.httpFetch)(`https://musicapi.qianqian.com/v1/restserver/ting?method=baidu.ting.song.getSongLink&format=json&from=bmpc&version=1.0.0&version_d=11.1.6.0&songid=${songmid}&type=1&res=1&s_protocol=1&aac=2&project=tpass`);
        requestObj.promise = requestObj.promise.then(({ body }) => {
          if (body.error_code == 22e3) {
            this.cache[songmid] = body.result.songinfo;
            return body.result.songinfo;
          }
          return Promise.reject(new Error("获取音乐信息失败"));
        });
        return requestObj;
      }
    };
  }
});

// node_modules/crypto-js/core.js
var require_core = __commonJS({
  "node_modules/crypto-js/core.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory();
      } else if (typeof define === "function" && define.amd) {
        define([], factory);
      } else {
        root.CryptoJS = factory();
      }
    })(exports2, function() {
      var CryptoJS = CryptoJS || function(Math2, undefined2) {
        var crypto;
        if (typeof window !== "undefined" && window.crypto) {
          crypto = window.crypto;
        }
        if (typeof self !== "undefined" && self.crypto) {
          crypto = self.crypto;
        }
        if (typeof globalThis !== "undefined" && globalThis.crypto) {
          crypto = globalThis.crypto;
        }
        if (!crypto && typeof window !== "undefined" && window.msCrypto) {
          crypto = window.msCrypto;
        }
        if (!crypto && typeof global !== "undefined" && global.crypto) {
          crypto = global.crypto;
        }
        if (!crypto && typeof require === "function") {
          try {
            crypto = require("crypto");
          } catch (err) {
          }
        }
        var cryptoSecureRandomInt = function() {
          if (crypto) {
            if (typeof crypto.getRandomValues === "function") {
              try {
                return crypto.getRandomValues(new Uint32Array(1))[0];
              } catch (err) {
              }
            }
            if (typeof crypto.randomBytes === "function") {
              try {
                return crypto.randomBytes(4).readInt32LE();
              } catch (err) {
              }
            }
          }
          throw new Error("Native crypto module could not be used to get secure random number.");
        };
        var create = Object.create || /* @__PURE__ */ function() {
          function F() {
          }
          return function(obj) {
            var subtype;
            F.prototype = obj;
            subtype = new F();
            F.prototype = null;
            return subtype;
          };
        }();
        var C = {};
        var C_lib = C.lib = {};
        var Base = C_lib.Base = /* @__PURE__ */ function() {
          return {
            /**
             * Creates a new object that inherits from this object.
             *
             * @param {Object} overrides Properties to copy into the new object.
             *
             * @return {Object} The new object.
             *
             * @static
             *
             * @example
             *
             *     var MyType = CryptoJS.lib.Base.extend({
             *         field: 'value',
             *
             *         method: function () {
             *         }
             *     });
             */
            extend: function(overrides) {
              var subtype = create(this);
              if (overrides) {
                subtype.mixIn(overrides);
              }
              if (!subtype.hasOwnProperty("init") || this.init === subtype.init) {
                subtype.init = function() {
                  subtype.$super.init.apply(this, arguments);
                };
              }
              subtype.init.prototype = subtype;
              subtype.$super = this;
              return subtype;
            },
            /**
             * Extends this object and runs the init method.
             * Arguments to create() will be passed to init().
             *
             * @return {Object} The new object.
             *
             * @static
             *
             * @example
             *
             *     var instance = MyType.create();
             */
            create: function() {
              var instance = this.extend();
              instance.init.apply(instance, arguments);
              return instance;
            },
            /**
             * Initializes a newly created object.
             * Override this method to add some logic when your objects are created.
             *
             * @example
             *
             *     var MyType = CryptoJS.lib.Base.extend({
             *         init: function () {
             *             // ...
             *         }
             *     });
             */
            init: function() {
            },
            /**
             * Copies properties into this object.
             *
             * @param {Object} properties The properties to mix in.
             *
             * @example
             *
             *     MyType.mixIn({
             *         field: 'value'
             *     });
             */
            mixIn: function(properties) {
              for (var propertyName in properties) {
                if (properties.hasOwnProperty(propertyName)) {
                  this[propertyName] = properties[propertyName];
                }
              }
              if (properties.hasOwnProperty("toString")) {
                this.toString = properties.toString;
              }
            },
            /**
             * Creates a copy of this object.
             *
             * @return {Object} The clone.
             *
             * @example
             *
             *     var clone = instance.clone();
             */
            clone: function() {
              return this.init.prototype.extend(this);
            }
          };
        }();
        var WordArray = C_lib.WordArray = Base.extend({
          /**
           * Initializes a newly created word array.
           *
           * @param {Array} words (Optional) An array of 32-bit words.
           * @param {number} sigBytes (Optional) The number of significant bytes in the words.
           *
           * @example
           *
           *     var wordArray = CryptoJS.lib.WordArray.create();
           *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607]);
           *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607], 6);
           */
          init: function(words, sigBytes) {
            words = this.words = words || [];
            if (sigBytes != undefined2) {
              this.sigBytes = sigBytes;
            } else {
              this.sigBytes = words.length * 4;
            }
          },
          /**
           * Converts this word array to a string.
           *
           * @param {Encoder} encoder (Optional) The encoding strategy to use. Default: CryptoJS.enc.Hex
           *
           * @return {string} The stringified word array.
           *
           * @example
           *
           *     var string = wordArray + '';
           *     var string = wordArray.toString();
           *     var string = wordArray.toString(CryptoJS.enc.Utf8);
           */
          toString: function(encoder) {
            return (encoder || Hex).stringify(this);
          },
          /**
           * Concatenates a word array to this word array.
           *
           * @param {WordArray} wordArray The word array to append.
           *
           * @return {WordArray} This word array.
           *
           * @example
           *
           *     wordArray1.concat(wordArray2);
           */
          concat: function(wordArray) {
            var thisWords = this.words;
            var thatWords = wordArray.words;
            var thisSigBytes = this.sigBytes;
            var thatSigBytes = wordArray.sigBytes;
            this.clamp();
            if (thisSigBytes % 4) {
              for (var i = 0; i < thatSigBytes; i++) {
                var thatByte = thatWords[i >>> 2] >>> 24 - i % 4 * 8 & 255;
                thisWords[thisSigBytes + i >>> 2] |= thatByte << 24 - (thisSigBytes + i) % 4 * 8;
              }
            } else {
              for (var j = 0; j < thatSigBytes; j += 4) {
                thisWords[thisSigBytes + j >>> 2] = thatWords[j >>> 2];
              }
            }
            this.sigBytes += thatSigBytes;
            return this;
          },
          /**
           * Removes insignificant bits.
           *
           * @example
           *
           *     wordArray.clamp();
           */
          clamp: function() {
            var words = this.words;
            var sigBytes = this.sigBytes;
            words[sigBytes >>> 2] &= 4294967295 << 32 - sigBytes % 4 * 8;
            words.length = Math2.ceil(sigBytes / 4);
          },
          /**
           * Creates a copy of this word array.
           *
           * @return {WordArray} The clone.
           *
           * @example
           *
           *     var clone = wordArray.clone();
           */
          clone: function() {
            var clone = Base.clone.call(this);
            clone.words = this.words.slice(0);
            return clone;
          },
          /**
           * Creates a word array filled with random bytes.
           *
           * @param {number} nBytes The number of random bytes to generate.
           *
           * @return {WordArray} The random word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.lib.WordArray.random(16);
           */
          random: function(nBytes) {
            var words = [];
            for (var i = 0; i < nBytes; i += 4) {
              words.push(cryptoSecureRandomInt());
            }
            return new WordArray.init(words, nBytes);
          }
        });
        var C_enc = C.enc = {};
        var Hex = C_enc.Hex = {
          /**
           * Converts a word array to a hex string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The hex string.
           *
           * @static
           *
           * @example
           *
           *     var hexString = CryptoJS.enc.Hex.stringify(wordArray);
           */
          stringify: function(wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var hexChars = [];
            for (var i = 0; i < sigBytes; i++) {
              var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              hexChars.push((bite >>> 4).toString(16));
              hexChars.push((bite & 15).toString(16));
            }
            return hexChars.join("");
          },
          /**
           * Converts a hex string to a word array.
           *
           * @param {string} hexStr The hex string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Hex.parse(hexString);
           */
          parse: function(hexStr) {
            var hexStrLength = hexStr.length;
            var words = [];
            for (var i = 0; i < hexStrLength; i += 2) {
              words[i >>> 3] |= parseInt(hexStr.substr(i, 2), 16) << 24 - i % 8 * 4;
            }
            return new WordArray.init(words, hexStrLength / 2);
          }
        };
        var Latin1 = C_enc.Latin1 = {
          /**
           * Converts a word array to a Latin1 string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The Latin1 string.
           *
           * @static
           *
           * @example
           *
           *     var latin1String = CryptoJS.enc.Latin1.stringify(wordArray);
           */
          stringify: function(wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var latin1Chars = [];
            for (var i = 0; i < sigBytes; i++) {
              var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              latin1Chars.push(String.fromCharCode(bite));
            }
            return latin1Chars.join("");
          },
          /**
           * Converts a Latin1 string to a word array.
           *
           * @param {string} latin1Str The Latin1 string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Latin1.parse(latin1String);
           */
          parse: function(latin1Str) {
            var latin1StrLength = latin1Str.length;
            var words = [];
            for (var i = 0; i < latin1StrLength; i++) {
              words[i >>> 2] |= (latin1Str.charCodeAt(i) & 255) << 24 - i % 4 * 8;
            }
            return new WordArray.init(words, latin1StrLength);
          }
        };
        var Utf8 = C_enc.Utf8 = {
          /**
           * Converts a word array to a UTF-8 string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The UTF-8 string.
           *
           * @static
           *
           * @example
           *
           *     var utf8String = CryptoJS.enc.Utf8.stringify(wordArray);
           */
          stringify: function(wordArray) {
            try {
              return decodeURIComponent(escape(Latin1.stringify(wordArray)));
            } catch (e) {
              throw new Error("Malformed UTF-8 data");
            }
          },
          /**
           * Converts a UTF-8 string to a word array.
           *
           * @param {string} utf8Str The UTF-8 string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Utf8.parse(utf8String);
           */
          parse: function(utf8Str) {
            return Latin1.parse(unescape(encodeURIComponent(utf8Str)));
          }
        };
        var BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm = Base.extend({
          /**
           * Resets this block algorithm's data buffer to its initial state.
           *
           * @example
           *
           *     bufferedBlockAlgorithm.reset();
           */
          reset: function() {
            this._data = new WordArray.init();
            this._nDataBytes = 0;
          },
          /**
           * Adds new data to this block algorithm's buffer.
           *
           * @param {WordArray|string} data The data to append. Strings are converted to a WordArray using UTF-8.
           *
           * @example
           *
           *     bufferedBlockAlgorithm._append('data');
           *     bufferedBlockAlgorithm._append(wordArray);
           */
          _append: function(data) {
            if (typeof data == "string") {
              data = Utf8.parse(data);
            }
            this._data.concat(data);
            this._nDataBytes += data.sigBytes;
          },
          /**
           * Processes available data blocks.
           *
           * This method invokes _doProcessBlock(offset), which must be implemented by a concrete subtype.
           *
           * @param {boolean} doFlush Whether all blocks and partial blocks should be processed.
           *
           * @return {WordArray} The processed data.
           *
           * @example
           *
           *     var processedData = bufferedBlockAlgorithm._process();
           *     var processedData = bufferedBlockAlgorithm._process(!!'flush');
           */
          _process: function(doFlush) {
            var processedWords;
            var data = this._data;
            var dataWords = data.words;
            var dataSigBytes = data.sigBytes;
            var blockSize = this.blockSize;
            var blockSizeBytes = blockSize * 4;
            var nBlocksReady = dataSigBytes / blockSizeBytes;
            if (doFlush) {
              nBlocksReady = Math2.ceil(nBlocksReady);
            } else {
              nBlocksReady = Math2.max((nBlocksReady | 0) - this._minBufferSize, 0);
            }
            var nWordsReady = nBlocksReady * blockSize;
            var nBytesReady = Math2.min(nWordsReady * 4, dataSigBytes);
            if (nWordsReady) {
              for (var offset = 0; offset < nWordsReady; offset += blockSize) {
                this._doProcessBlock(dataWords, offset);
              }
              processedWords = dataWords.splice(0, nWordsReady);
              data.sigBytes -= nBytesReady;
            }
            return new WordArray.init(processedWords, nBytesReady);
          },
          /**
           * Creates a copy of this object.
           *
           * @return {Object} The clone.
           *
           * @example
           *
           *     var clone = bufferedBlockAlgorithm.clone();
           */
          clone: function() {
            var clone = Base.clone.call(this);
            clone._data = this._data.clone();
            return clone;
          },
          _minBufferSize: 0
        });
        var Hasher = C_lib.Hasher = BufferedBlockAlgorithm.extend({
          /**
           * Configuration options.
           */
          cfg: Base.extend(),
          /**
           * Initializes a newly created hasher.
           *
           * @param {Object} cfg (Optional) The configuration options to use for this hash computation.
           *
           * @example
           *
           *     var hasher = CryptoJS.algo.SHA256.create();
           */
          init: function(cfg) {
            this.cfg = this.cfg.extend(cfg);
            this.reset();
          },
          /**
           * Resets this hasher to its initial state.
           *
           * @example
           *
           *     hasher.reset();
           */
          reset: function() {
            BufferedBlockAlgorithm.reset.call(this);
            this._doReset();
          },
          /**
           * Updates this hasher with a message.
           *
           * @param {WordArray|string} messageUpdate The message to append.
           *
           * @return {Hasher} This hasher.
           *
           * @example
           *
           *     hasher.update('message');
           *     hasher.update(wordArray);
           */
          update: function(messageUpdate) {
            this._append(messageUpdate);
            this._process();
            return this;
          },
          /**
           * Finalizes the hash computation.
           * Note that the finalize operation is effectively a destructive, read-once operation.
           *
           * @param {WordArray|string} messageUpdate (Optional) A final message update.
           *
           * @return {WordArray} The hash.
           *
           * @example
           *
           *     var hash = hasher.finalize();
           *     var hash = hasher.finalize('message');
           *     var hash = hasher.finalize(wordArray);
           */
          finalize: function(messageUpdate) {
            if (messageUpdate) {
              this._append(messageUpdate);
            }
            var hash = this._doFinalize();
            return hash;
          },
          blockSize: 512 / 32,
          /**
           * Creates a shortcut function to a hasher's object interface.
           *
           * @param {Hasher} hasher The hasher to create a helper for.
           *
           * @return {Function} The shortcut function.
           *
           * @static
           *
           * @example
           *
           *     var SHA256 = CryptoJS.lib.Hasher._createHelper(CryptoJS.algo.SHA256);
           */
          _createHelper: function(hasher) {
            return function(message, cfg) {
              return new hasher.init(cfg).finalize(message);
            };
          },
          /**
           * Creates a shortcut function to the HMAC's object interface.
           *
           * @param {Hasher} hasher The hasher to use in this HMAC helper.
           *
           * @return {Function} The shortcut function.
           *
           * @static
           *
           * @example
           *
           *     var HmacSHA256 = CryptoJS.lib.Hasher._createHmacHelper(CryptoJS.algo.SHA256);
           */
          _createHmacHelper: function(hasher) {
            return function(message, key) {
              return new C_algo.HMAC.init(hasher, key).finalize(message);
            };
          }
        });
        var C_algo = C.algo = {};
        return C;
      }(Math);
      return CryptoJS;
    });
  }
});

// node_modules/crypto-js/x64-core.js
var require_x64_core = __commonJS({
  "node_modules/crypto-js/x64-core.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function(undefined2) {
        var C = CryptoJS;
        var C_lib = C.lib;
        var Base = C_lib.Base;
        var X32WordArray = C_lib.WordArray;
        var C_x64 = C.x64 = {};
        var X64Word = C_x64.Word = Base.extend({
          /**
           * Initializes a newly created 64-bit word.
           *
           * @param {number} high The high 32 bits.
           * @param {number} low The low 32 bits.
           *
           * @example
           *
           *     var x64Word = CryptoJS.x64.Word.create(0x00010203, 0x04050607);
           */
          init: function(high, low) {
            this.high = high;
            this.low = low;
          }
          /**
           * Bitwise NOTs this word.
           *
           * @return {X64Word} A new x64-Word object after negating.
           *
           * @example
           *
           *     var negated = x64Word.not();
           */
          // not: function () {
          // var high = ~this.high;
          // var low = ~this.low;
          // return X64Word.create(high, low);
          // },
          /**
           * Bitwise ANDs this word with the passed word.
           *
           * @param {X64Word} word The x64-Word to AND with this word.
           *
           * @return {X64Word} A new x64-Word object after ANDing.
           *
           * @example
           *
           *     var anded = x64Word.and(anotherX64Word);
           */
          // and: function (word) {
          // var high = this.high & word.high;
          // var low = this.low & word.low;
          // return X64Word.create(high, low);
          // },
          /**
           * Bitwise ORs this word with the passed word.
           *
           * @param {X64Word} word The x64-Word to OR with this word.
           *
           * @return {X64Word} A new x64-Word object after ORing.
           *
           * @example
           *
           *     var ored = x64Word.or(anotherX64Word);
           */
          // or: function (word) {
          // var high = this.high | word.high;
          // var low = this.low | word.low;
          // return X64Word.create(high, low);
          // },
          /**
           * Bitwise XORs this word with the passed word.
           *
           * @param {X64Word} word The x64-Word to XOR with this word.
           *
           * @return {X64Word} A new x64-Word object after XORing.
           *
           * @example
           *
           *     var xored = x64Word.xor(anotherX64Word);
           */
          // xor: function (word) {
          // var high = this.high ^ word.high;
          // var low = this.low ^ word.low;
          // return X64Word.create(high, low);
          // },
          /**
           * Shifts this word n bits to the left.
           *
           * @param {number} n The number of bits to shift.
           *
           * @return {X64Word} A new x64-Word object after shifting.
           *
           * @example
           *
           *     var shifted = x64Word.shiftL(25);
           */
          // shiftL: function (n) {
          // if (n < 32) {
          // var high = (this.high << n) | (this.low >>> (32 - n));
          // var low = this.low << n;
          // } else {
          // var high = this.low << (n - 32);
          // var low = 0;
          // }
          // return X64Word.create(high, low);
          // },
          /**
           * Shifts this word n bits to the right.
           *
           * @param {number} n The number of bits to shift.
           *
           * @return {X64Word} A new x64-Word object after shifting.
           *
           * @example
           *
           *     var shifted = x64Word.shiftR(7);
           */
          // shiftR: function (n) {
          // if (n < 32) {
          // var low = (this.low >>> n) | (this.high << (32 - n));
          // var high = this.high >>> n;
          // } else {
          // var low = this.high >>> (n - 32);
          // var high = 0;
          // }
          // return X64Word.create(high, low);
          // },
          /**
           * Rotates this word n bits to the left.
           *
           * @param {number} n The number of bits to rotate.
           *
           * @return {X64Word} A new x64-Word object after rotating.
           *
           * @example
           *
           *     var rotated = x64Word.rotL(25);
           */
          // rotL: function (n) {
          // return this.shiftL(n).or(this.shiftR(64 - n));
          // },
          /**
           * Rotates this word n bits to the right.
           *
           * @param {number} n The number of bits to rotate.
           *
           * @return {X64Word} A new x64-Word object after rotating.
           *
           * @example
           *
           *     var rotated = x64Word.rotR(7);
           */
          // rotR: function (n) {
          // return this.shiftR(n).or(this.shiftL(64 - n));
          // },
          /**
           * Adds this word with the passed word.
           *
           * @param {X64Word} word The x64-Word to add with this word.
           *
           * @return {X64Word} A new x64-Word object after adding.
           *
           * @example
           *
           *     var added = x64Word.add(anotherX64Word);
           */
          // add: function (word) {
          // var low = (this.low + word.low) | 0;
          // var carry = (low >>> 0) < (this.low >>> 0) ? 1 : 0;
          // var high = (this.high + word.high + carry) | 0;
          // return X64Word.create(high, low);
          // }
        });
        var X64WordArray = C_x64.WordArray = Base.extend({
          /**
           * Initializes a newly created word array.
           *
           * @param {Array} words (Optional) An array of CryptoJS.x64.Word objects.
           * @param {number} sigBytes (Optional) The number of significant bytes in the words.
           *
           * @example
           *
           *     var wordArray = CryptoJS.x64.WordArray.create();
           *
           *     var wordArray = CryptoJS.x64.WordArray.create([
           *         CryptoJS.x64.Word.create(0x00010203, 0x04050607),
           *         CryptoJS.x64.Word.create(0x18191a1b, 0x1c1d1e1f)
           *     ]);
           *
           *     var wordArray = CryptoJS.x64.WordArray.create([
           *         CryptoJS.x64.Word.create(0x00010203, 0x04050607),
           *         CryptoJS.x64.Word.create(0x18191a1b, 0x1c1d1e1f)
           *     ], 10);
           */
          init: function(words, sigBytes) {
            words = this.words = words || [];
            if (sigBytes != undefined2) {
              this.sigBytes = sigBytes;
            } else {
              this.sigBytes = words.length * 8;
            }
          },
          /**
           * Converts this 64-bit word array to a 32-bit word array.
           *
           * @return {CryptoJS.lib.WordArray} This word array's data as a 32-bit word array.
           *
           * @example
           *
           *     var x32WordArray = x64WordArray.toX32();
           */
          toX32: function() {
            var x64Words = this.words;
            var x64WordsLength = x64Words.length;
            var x32Words = [];
            for (var i = 0; i < x64WordsLength; i++) {
              var x64Word = x64Words[i];
              x32Words.push(x64Word.high);
              x32Words.push(x64Word.low);
            }
            return X32WordArray.create(x32Words, this.sigBytes);
          },
          /**
           * Creates a copy of this word array.
           *
           * @return {X64WordArray} The clone.
           *
           * @example
           *
           *     var clone = x64WordArray.clone();
           */
          clone: function() {
            var clone = Base.clone.call(this);
            var words = clone.words = this.words.slice(0);
            var wordsLength = words.length;
            for (var i = 0; i < wordsLength; i++) {
              words[i] = words[i].clone();
            }
            return clone;
          }
        });
      })();
      return CryptoJS;
    });
  }
});

// node_modules/crypto-js/lib-typedarrays.js
var require_lib_typedarrays = __commonJS({
  "node_modules/crypto-js/lib-typedarrays.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        if (typeof ArrayBuffer != "function") {
          return;
        }
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var superInit = WordArray.init;
        var subInit = WordArray.init = function(typedArray) {
          if (typedArray instanceof ArrayBuffer) {
            typedArray = new Uint8Array(typedArray);
          }
          if (typedArray instanceof Int8Array || typeof Uint8ClampedArray !== "undefined" && typedArray instanceof Uint8ClampedArray || typedArray instanceof Int16Array || typedArray instanceof Uint16Array || typedArray instanceof Int32Array || typedArray instanceof Uint32Array || typedArray instanceof Float32Array || typedArray instanceof Float64Array) {
            typedArray = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
          }
          if (typedArray instanceof Uint8Array) {
            var typedArrayByteLength = typedArray.byteLength;
            var words = [];
            for (var i = 0; i < typedArrayByteLength; i++) {
              words[i >>> 2] |= typedArray[i] << 24 - i % 4 * 8;
            }
            superInit.call(this, words, typedArrayByteLength);
          } else {
            superInit.apply(this, arguments);
          }
        };
        subInit.prototype = WordArray;
      })();
      return CryptoJS.lib.WordArray;
    });
  }
});

// node_modules/crypto-js/enc-utf16.js
var require_enc_utf16 = __commonJS({
  "node_modules/crypto-js/enc-utf16.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var C_enc = C.enc;
        var Utf16BE = C_enc.Utf16 = C_enc.Utf16BE = {
          /**
           * Converts a word array to a UTF-16 BE string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The UTF-16 BE string.
           *
           * @static
           *
           * @example
           *
           *     var utf16String = CryptoJS.enc.Utf16.stringify(wordArray);
           */
          stringify: function(wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var utf16Chars = [];
            for (var i = 0; i < sigBytes; i += 2) {
              var codePoint = words[i >>> 2] >>> 16 - i % 4 * 8 & 65535;
              utf16Chars.push(String.fromCharCode(codePoint));
            }
            return utf16Chars.join("");
          },
          /**
           * Converts a UTF-16 BE string to a word array.
           *
           * @param {string} utf16Str The UTF-16 BE string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Utf16.parse(utf16String);
           */
          parse: function(utf16Str) {
            var utf16StrLength = utf16Str.length;
            var words = [];
            for (var i = 0; i < utf16StrLength; i++) {
              words[i >>> 1] |= utf16Str.charCodeAt(i) << 16 - i % 2 * 16;
            }
            return WordArray.create(words, utf16StrLength * 2);
          }
        };
        C_enc.Utf16LE = {
          /**
           * Converts a word array to a UTF-16 LE string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The UTF-16 LE string.
           *
           * @static
           *
           * @example
           *
           *     var utf16Str = CryptoJS.enc.Utf16LE.stringify(wordArray);
           */
          stringify: function(wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var utf16Chars = [];
            for (var i = 0; i < sigBytes; i += 2) {
              var codePoint = swapEndian(words[i >>> 2] >>> 16 - i % 4 * 8 & 65535);
              utf16Chars.push(String.fromCharCode(codePoint));
            }
            return utf16Chars.join("");
          },
          /**
           * Converts a UTF-16 LE string to a word array.
           *
           * @param {string} utf16Str The UTF-16 LE string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Utf16LE.parse(utf16Str);
           */
          parse: function(utf16Str) {
            var utf16StrLength = utf16Str.length;
            var words = [];
            for (var i = 0; i < utf16StrLength; i++) {
              words[i >>> 1] |= swapEndian(utf16Str.charCodeAt(i) << 16 - i % 2 * 16);
            }
            return WordArray.create(words, utf16StrLength * 2);
          }
        };
        function swapEndian(word) {
          return word << 8 & 4278255360 | word >>> 8 & 16711935;
        }
      })();
      return CryptoJS.enc.Utf16;
    });
  }
});

// node_modules/crypto-js/enc-base64.js
var require_enc_base64 = __commonJS({
  "node_modules/crypto-js/enc-base64.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var C_enc = C.enc;
        var Base64 = C_enc.Base64 = {
          /**
           * Converts a word array to a Base64 string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The Base64 string.
           *
           * @static
           *
           * @example
           *
           *     var base64String = CryptoJS.enc.Base64.stringify(wordArray);
           */
          stringify: function(wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var map = this._map;
            wordArray.clamp();
            var base64Chars = [];
            for (var i = 0; i < sigBytes; i += 3) {
              var byte1 = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              var byte2 = words[i + 1 >>> 2] >>> 24 - (i + 1) % 4 * 8 & 255;
              var byte3 = words[i + 2 >>> 2] >>> 24 - (i + 2) % 4 * 8 & 255;
              var triplet = byte1 << 16 | byte2 << 8 | byte3;
              for (var j = 0; j < 4 && i + j * 0.75 < sigBytes; j++) {
                base64Chars.push(map.charAt(triplet >>> 6 * (3 - j) & 63));
              }
            }
            var paddingChar = map.charAt(64);
            if (paddingChar) {
              while (base64Chars.length % 4) {
                base64Chars.push(paddingChar);
              }
            }
            return base64Chars.join("");
          },
          /**
           * Converts a Base64 string to a word array.
           *
           * @param {string} base64Str The Base64 string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Base64.parse(base64String);
           */
          parse: function(base64Str) {
            var base64StrLength = base64Str.length;
            var map = this._map;
            var reverseMap = this._reverseMap;
            if (!reverseMap) {
              reverseMap = this._reverseMap = [];
              for (var j = 0; j < map.length; j++) {
                reverseMap[map.charCodeAt(j)] = j;
              }
            }
            var paddingChar = map.charAt(64);
            if (paddingChar) {
              var paddingIndex = base64Str.indexOf(paddingChar);
              if (paddingIndex !== -1) {
                base64StrLength = paddingIndex;
              }
            }
            return parseLoop(base64Str, base64StrLength, reverseMap);
          },
          _map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
        };
        function parseLoop(base64Str, base64StrLength, reverseMap) {
          var words = [];
          var nBytes = 0;
          for (var i = 0; i < base64StrLength; i++) {
            if (i % 4) {
              var bits1 = reverseMap[base64Str.charCodeAt(i - 1)] << i % 4 * 2;
              var bits2 = reverseMap[base64Str.charCodeAt(i)] >>> 6 - i % 4 * 2;
              var bitsCombined = bits1 | bits2;
              words[nBytes >>> 2] |= bitsCombined << 24 - nBytes % 4 * 8;
              nBytes++;
            }
          }
          return WordArray.create(words, nBytes);
        }
      })();
      return CryptoJS.enc.Base64;
    });
  }
});

// node_modules/crypto-js/enc-base64url.js
var require_enc_base64url = __commonJS({
  "node_modules/crypto-js/enc-base64url.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var C_enc = C.enc;
        var Base64url = C_enc.Base64url = {
          /**
           * Converts a word array to a Base64url string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @param {boolean} urlSafe Whether to use url safe
           *
           * @return {string} The Base64url string.
           *
           * @static
           *
           * @example
           *
           *     var base64String = CryptoJS.enc.Base64url.stringify(wordArray);
           */
          stringify: function(wordArray, urlSafe = true) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var map = urlSafe ? this._safe_map : this._map;
            wordArray.clamp();
            var base64Chars = [];
            for (var i = 0; i < sigBytes; i += 3) {
              var byte1 = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              var byte2 = words[i + 1 >>> 2] >>> 24 - (i + 1) % 4 * 8 & 255;
              var byte3 = words[i + 2 >>> 2] >>> 24 - (i + 2) % 4 * 8 & 255;
              var triplet = byte1 << 16 | byte2 << 8 | byte3;
              for (var j = 0; j < 4 && i + j * 0.75 < sigBytes; j++) {
                base64Chars.push(map.charAt(triplet >>> 6 * (3 - j) & 63));
              }
            }
            var paddingChar = map.charAt(64);
            if (paddingChar) {
              while (base64Chars.length % 4) {
                base64Chars.push(paddingChar);
              }
            }
            return base64Chars.join("");
          },
          /**
           * Converts a Base64url string to a word array.
           *
           * @param {string} base64Str The Base64url string.
           *
           * @param {boolean} urlSafe Whether to use url safe
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Base64url.parse(base64String);
           */
          parse: function(base64Str, urlSafe = true) {
            var base64StrLength = base64Str.length;
            var map = urlSafe ? this._safe_map : this._map;
            var reverseMap = this._reverseMap;
            if (!reverseMap) {
              reverseMap = this._reverseMap = [];
              for (var j = 0; j < map.length; j++) {
                reverseMap[map.charCodeAt(j)] = j;
              }
            }
            var paddingChar = map.charAt(64);
            if (paddingChar) {
              var paddingIndex = base64Str.indexOf(paddingChar);
              if (paddingIndex !== -1) {
                base64StrLength = paddingIndex;
              }
            }
            return parseLoop(base64Str, base64StrLength, reverseMap);
          },
          _map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
          _safe_map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        };
        function parseLoop(base64Str, base64StrLength, reverseMap) {
          var words = [];
          var nBytes = 0;
          for (var i = 0; i < base64StrLength; i++) {
            if (i % 4) {
              var bits1 = reverseMap[base64Str.charCodeAt(i - 1)] << i % 4 * 2;
              var bits2 = reverseMap[base64Str.charCodeAt(i)] >>> 6 - i % 4 * 2;
              var bitsCombined = bits1 | bits2;
              words[nBytes >>> 2] |= bitsCombined << 24 - nBytes % 4 * 8;
              nBytes++;
            }
          }
          return WordArray.create(words, nBytes);
        }
      })();
      return CryptoJS.enc.Base64url;
    });
  }
});

// node_modules/crypto-js/md5.js
var require_md5 = __commonJS({
  "node_modules/crypto-js/md5.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function(Math2) {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var Hasher = C_lib.Hasher;
        var C_algo = C.algo;
        var T = [];
        (function() {
          for (var i = 0; i < 64; i++) {
            T[i] = Math2.abs(Math2.sin(i + 1)) * 4294967296 | 0;
          }
        })();
        var MD5 = C_algo.MD5 = Hasher.extend({
          _doReset: function() {
            this._hash = new WordArray.init([
              1732584193,
              4023233417,
              2562383102,
              271733878
            ]);
          },
          _doProcessBlock: function(M, offset) {
            for (var i = 0; i < 16; i++) {
              var offset_i = offset + i;
              var M_offset_i = M[offset_i];
              M[offset_i] = (M_offset_i << 8 | M_offset_i >>> 24) & 16711935 | (M_offset_i << 24 | M_offset_i >>> 8) & 4278255360;
            }
            var H = this._hash.words;
            var M_offset_0 = M[offset + 0];
            var M_offset_1 = M[offset + 1];
            var M_offset_2 = M[offset + 2];
            var M_offset_3 = M[offset + 3];
            var M_offset_4 = M[offset + 4];
            var M_offset_5 = M[offset + 5];
            var M_offset_6 = M[offset + 6];
            var M_offset_7 = M[offset + 7];
            var M_offset_8 = M[offset + 8];
            var M_offset_9 = M[offset + 9];
            var M_offset_10 = M[offset + 10];
            var M_offset_11 = M[offset + 11];
            var M_offset_12 = M[offset + 12];
            var M_offset_13 = M[offset + 13];
            var M_offset_14 = M[offset + 14];
            var M_offset_15 = M[offset + 15];
            var a = H[0];
            var b = H[1];
            var c = H[2];
            var d = H[3];
            a = FF(a, b, c, d, M_offset_0, 7, T[0]);
            d = FF(d, a, b, c, M_offset_1, 12, T[1]);
            c = FF(c, d, a, b, M_offset_2, 17, T[2]);
            b = FF(b, c, d, a, M_offset_3, 22, T[3]);
            a = FF(a, b, c, d, M_offset_4, 7, T[4]);
            d = FF(d, a, b, c, M_offset_5, 12, T[5]);
            c = FF(c, d, a, b, M_offset_6, 17, T[6]);
            b = FF(b, c, d, a, M_offset_7, 22, T[7]);
            a = FF(a, b, c, d, M_offset_8, 7, T[8]);
            d = FF(d, a, b, c, M_offset_9, 12, T[9]);
            c = FF(c, d, a, b, M_offset_10, 17, T[10]);
            b = FF(b, c, d, a, M_offset_11, 22, T[11]);
            a = FF(a, b, c, d, M_offset_12, 7, T[12]);
            d = FF(d, a, b, c, M_offset_13, 12, T[13]);
            c = FF(c, d, a, b, M_offset_14, 17, T[14]);
            b = FF(b, c, d, a, M_offset_15, 22, T[15]);
            a = GG(a, b, c, d, M_offset_1, 5, T[16]);
            d = GG(d, a, b, c, M_offset_6, 9, T[17]);
            c = GG(c, d, a, b, M_offset_11, 14, T[18]);
            b = GG(b, c, d, a, M_offset_0, 20, T[19]);
            a = GG(a, b, c, d, M_offset_5, 5, T[20]);
            d = GG(d, a, b, c, M_offset_10, 9, T[21]);
            c = GG(c, d, a, b, M_offset_15, 14, T[22]);
            b = GG(b, c, d, a, M_offset_4, 20, T[23]);
            a = GG(a, b, c, d, M_offset_9, 5, T[24]);
            d = GG(d, a, b, c, M_offset_14, 9, T[25]);
            c = GG(c, d, a, b, M_offset_3, 14, T[26]);
            b = GG(b, c, d, a, M_offset_8, 20, T[27]);
            a = GG(a, b, c, d, M_offset_13, 5, T[28]);
            d = GG(d, a, b, c, M_offset_2, 9, T[29]);
            c = GG(c, d, a, b, M_offset_7, 14, T[30]);
            b = GG(b, c, d, a, M_offset_12, 20, T[31]);
            a = HH(a, b, c, d, M_offset_5, 4, T[32]);
            d = HH(d, a, b, c, M_offset_8, 11, T[33]);
            c = HH(c, d, a, b, M_offset_11, 16, T[34]);
            b = HH(b, c, d, a, M_offset_14, 23, T[35]);
            a = HH(a, b, c, d, M_offset_1, 4, T[36]);
            d = HH(d, a, b, c, M_offset_4, 11, T[37]);
            c = HH(c, d, a, b, M_offset_7, 16, T[38]);
            b = HH(b, c, d, a, M_offset_10, 23, T[39]);
            a = HH(a, b, c, d, M_offset_13, 4, T[40]);
            d = HH(d, a, b, c, M_offset_0, 11, T[41]);
            c = HH(c, d, a, b, M_offset_3, 16, T[42]);
            b = HH(b, c, d, a, M_offset_6, 23, T[43]);
            a = HH(a, b, c, d, M_offset_9, 4, T[44]);
            d = HH(d, a, b, c, M_offset_12, 11, T[45]);
            c = HH(c, d, a, b, M_offset_15, 16, T[46]);
            b = HH(b, c, d, a, M_offset_2, 23, T[47]);
            a = II(a, b, c, d, M_offset_0, 6, T[48]);
            d = II(d, a, b, c, M_offset_7, 10, T[49]);
            c = II(c, d, a, b, M_offset_14, 15, T[50]);
            b = II(b, c, d, a, M_offset_5, 21, T[51]);
            a = II(a, b, c, d, M_offset_12, 6, T[52]);
            d = II(d, a, b, c, M_offset_3, 10, T[53]);
            c = II(c, d, a, b, M_offset_10, 15, T[54]);
            b = II(b, c, d, a, M_offset_1, 21, T[55]);
            a = II(a, b, c, d, M_offset_8, 6, T[56]);
            d = II(d, a, b, c, M_offset_15, 10, T[57]);
            c = II(c, d, a, b, M_offset_6, 15, T[58]);
            b = II(b, c, d, a, M_offset_13, 21, T[59]);
            a = II(a, b, c, d, M_offset_4, 6, T[60]);
            d = II(d, a, b, c, M_offset_11, 10, T[61]);
            c = II(c, d, a, b, M_offset_2, 15, T[62]);
            b = II(b, c, d, a, M_offset_9, 21, T[63]);
            H[0] = H[0] + a | 0;
            H[1] = H[1] + b | 0;
            H[2] = H[2] + c | 0;
            H[3] = H[3] + d | 0;
          },
          _doFinalize: function() {
            var data = this._data;
            var dataWords = data.words;
            var nBitsTotal = this._nDataBytes * 8;
            var nBitsLeft = data.sigBytes * 8;
            dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
            var nBitsTotalH = Math2.floor(nBitsTotal / 4294967296);
            var nBitsTotalL = nBitsTotal;
            dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = (nBitsTotalH << 8 | nBitsTotalH >>> 24) & 16711935 | (nBitsTotalH << 24 | nBitsTotalH >>> 8) & 4278255360;
            dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = (nBitsTotalL << 8 | nBitsTotalL >>> 24) & 16711935 | (nBitsTotalL << 24 | nBitsTotalL >>> 8) & 4278255360;
            data.sigBytes = (dataWords.length + 1) * 4;
            this._process();
            var hash = this._hash;
            var H = hash.words;
            for (var i = 0; i < 4; i++) {
              var H_i = H[i];
              H[i] = (H_i << 8 | H_i >>> 24) & 16711935 | (H_i << 24 | H_i >>> 8) & 4278255360;
            }
            return hash;
          },
          clone: function() {
            var clone = Hasher.clone.call(this);
            clone._hash = this._hash.clone();
            return clone;
          }
        });
        function FF(a, b, c, d, x, s, t) {
          var n = a + (b & c | ~b & d) + x + t;
          return (n << s | n >>> 32 - s) + b;
        }
        function GG(a, b, c, d, x, s, t) {
          var n = a + (b & d | c & ~d) + x + t;
          return (n << s | n >>> 32 - s) + b;
        }
        function HH(a, b, c, d, x, s, t) {
          var n = a + (b ^ c ^ d) + x + t;
          return (n << s | n >>> 32 - s) + b;
        }
        function II(a, b, c, d, x, s, t) {
          var n = a + (c ^ (b | ~d)) + x + t;
          return (n << s | n >>> 32 - s) + b;
        }
        C.MD5 = Hasher._createHelper(MD5);
        C.HmacMD5 = Hasher._createHmacHelper(MD5);
      })(Math);
      return CryptoJS.MD5;
    });
  }
});

// node_modules/crypto-js/sha1.js
var require_sha1 = __commonJS({
  "node_modules/crypto-js/sha1.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var Hasher = C_lib.Hasher;
        var C_algo = C.algo;
        var W = [];
        var SHA1 = C_algo.SHA1 = Hasher.extend({
          _doReset: function() {
            this._hash = new WordArray.init([
              1732584193,
              4023233417,
              2562383102,
              271733878,
              3285377520
            ]);
          },
          _doProcessBlock: function(M, offset) {
            var H = this._hash.words;
            var a = H[0];
            var b = H[1];
            var c = H[2];
            var d = H[3];
            var e = H[4];
            for (var i = 0; i < 80; i++) {
              if (i < 16) {
                W[i] = M[offset + i] | 0;
              } else {
                var n = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
                W[i] = n << 1 | n >>> 31;
              }
              var t = (a << 5 | a >>> 27) + e + W[i];
              if (i < 20) {
                t += (b & c | ~b & d) + 1518500249;
              } else if (i < 40) {
                t += (b ^ c ^ d) + 1859775393;
              } else if (i < 60) {
                t += (b & c | b & d | c & d) - 1894007588;
              } else {
                t += (b ^ c ^ d) - 899497514;
              }
              e = d;
              d = c;
              c = b << 30 | b >>> 2;
              b = a;
              a = t;
            }
            H[0] = H[0] + a | 0;
            H[1] = H[1] + b | 0;
            H[2] = H[2] + c | 0;
            H[3] = H[3] + d | 0;
            H[4] = H[4] + e | 0;
          },
          _doFinalize: function() {
            var data = this._data;
            var dataWords = data.words;
            var nBitsTotal = this._nDataBytes * 8;
            var nBitsLeft = data.sigBytes * 8;
            dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
            dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = Math.floor(nBitsTotal / 4294967296);
            dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = nBitsTotal;
            data.sigBytes = dataWords.length * 4;
            this._process();
            return this._hash;
          },
          clone: function() {
            var clone = Hasher.clone.call(this);
            clone._hash = this._hash.clone();
            return clone;
          }
        });
        C.SHA1 = Hasher._createHelper(SHA1);
        C.HmacSHA1 = Hasher._createHmacHelper(SHA1);
      })();
      return CryptoJS.SHA1;
    });
  }
});

// node_modules/crypto-js/sha256.js
var require_sha256 = __commonJS({
  "node_modules/crypto-js/sha256.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function(Math2) {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var Hasher = C_lib.Hasher;
        var C_algo = C.algo;
        var H = [];
        var K = [];
        (function() {
          function isPrime(n2) {
            var sqrtN = Math2.sqrt(n2);
            for (var factor = 2; factor <= sqrtN; factor++) {
              if (!(n2 % factor)) {
                return false;
              }
            }
            return true;
          }
          function getFractionalBits(n2) {
            return (n2 - (n2 | 0)) * 4294967296 | 0;
          }
          var n = 2;
          var nPrime = 0;
          while (nPrime < 64) {
            if (isPrime(n)) {
              if (nPrime < 8) {
                H[nPrime] = getFractionalBits(Math2.pow(n, 1 / 2));
              }
              K[nPrime] = getFractionalBits(Math2.pow(n, 1 / 3));
              nPrime++;
            }
            n++;
          }
        })();
        var W = [];
        var SHA256 = C_algo.SHA256 = Hasher.extend({
          _doReset: function() {
            this._hash = new WordArray.init(H.slice(0));
          },
          _doProcessBlock: function(M, offset) {
            var H2 = this._hash.words;
            var a = H2[0];
            var b = H2[1];
            var c = H2[2];
            var d = H2[3];
            var e = H2[4];
            var f = H2[5];
            var g = H2[6];
            var h = H2[7];
            for (var i = 0; i < 64; i++) {
              if (i < 16) {
                W[i] = M[offset + i] | 0;
              } else {
                var gamma0x = W[i - 15];
                var gamma0 = (gamma0x << 25 | gamma0x >>> 7) ^ (gamma0x << 14 | gamma0x >>> 18) ^ gamma0x >>> 3;
                var gamma1x = W[i - 2];
                var gamma1 = (gamma1x << 15 | gamma1x >>> 17) ^ (gamma1x << 13 | gamma1x >>> 19) ^ gamma1x >>> 10;
                W[i] = gamma0 + W[i - 7] + gamma1 + W[i - 16];
              }
              var ch = e & f ^ ~e & g;
              var maj = a & b ^ a & c ^ b & c;
              var sigma0 = (a << 30 | a >>> 2) ^ (a << 19 | a >>> 13) ^ (a << 10 | a >>> 22);
              var sigma1 = (e << 26 | e >>> 6) ^ (e << 21 | e >>> 11) ^ (e << 7 | e >>> 25);
              var t1 = h + sigma1 + ch + K[i] + W[i];
              var t2 = sigma0 + maj;
              h = g;
              g = f;
              f = e;
              e = d + t1 | 0;
              d = c;
              c = b;
              b = a;
              a = t1 + t2 | 0;
            }
            H2[0] = H2[0] + a | 0;
            H2[1] = H2[1] + b | 0;
            H2[2] = H2[2] + c | 0;
            H2[3] = H2[3] + d | 0;
            H2[4] = H2[4] + e | 0;
            H2[5] = H2[5] + f | 0;
            H2[6] = H2[6] + g | 0;
            H2[7] = H2[7] + h | 0;
          },
          _doFinalize: function() {
            var data = this._data;
            var dataWords = data.words;
            var nBitsTotal = this._nDataBytes * 8;
            var nBitsLeft = data.sigBytes * 8;
            dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
            dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = Math2.floor(nBitsTotal / 4294967296);
            dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = nBitsTotal;
            data.sigBytes = dataWords.length * 4;
            this._process();
            return this._hash;
          },
          clone: function() {
            var clone = Hasher.clone.call(this);
            clone._hash = this._hash.clone();
            return clone;
          }
        });
        C.SHA256 = Hasher._createHelper(SHA256);
        C.HmacSHA256 = Hasher._createHmacHelper(SHA256);
      })(Math);
      return CryptoJS.SHA256;
    });
  }
});

// node_modules/crypto-js/sha224.js
var require_sha224 = __commonJS({
  "node_modules/crypto-js/sha224.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_sha256());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./sha256"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var C_algo = C.algo;
        var SHA256 = C_algo.SHA256;
        var SHA224 = C_algo.SHA224 = SHA256.extend({
          _doReset: function() {
            this._hash = new WordArray.init([
              3238371032,
              914150663,
              812702999,
              4144912697,
              4290775857,
              1750603025,
              1694076839,
              3204075428
            ]);
          },
          _doFinalize: function() {
            var hash = SHA256._doFinalize.call(this);
            hash.sigBytes -= 4;
            return hash;
          }
        });
        C.SHA224 = SHA256._createHelper(SHA224);
        C.HmacSHA224 = SHA256._createHmacHelper(SHA224);
      })();
      return CryptoJS.SHA224;
    });
  }
});

// node_modules/crypto-js/sha512.js
var require_sha512 = __commonJS({
  "node_modules/crypto-js/sha512.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_x64_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./x64-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var Hasher = C_lib.Hasher;
        var C_x64 = C.x64;
        var X64Word = C_x64.Word;
        var X64WordArray = C_x64.WordArray;
        var C_algo = C.algo;
        function X64Word_create() {
          return X64Word.create.apply(X64Word, arguments);
        }
        var K = [
          X64Word_create(1116352408, 3609767458),
          X64Word_create(1899447441, 602891725),
          X64Word_create(3049323471, 3964484399),
          X64Word_create(3921009573, 2173295548),
          X64Word_create(961987163, 4081628472),
          X64Word_create(1508970993, 3053834265),
          X64Word_create(2453635748, 2937671579),
          X64Word_create(2870763221, 3664609560),
          X64Word_create(3624381080, 2734883394),
          X64Word_create(310598401, 1164996542),
          X64Word_create(607225278, 1323610764),
          X64Word_create(1426881987, 3590304994),
          X64Word_create(1925078388, 4068182383),
          X64Word_create(2162078206, 991336113),
          X64Word_create(2614888103, 633803317),
          X64Word_create(3248222580, 3479774868),
          X64Word_create(3835390401, 2666613458),
          X64Word_create(4022224774, 944711139),
          X64Word_create(264347078, 2341262773),
          X64Word_create(604807628, 2007800933),
          X64Word_create(770255983, 1495990901),
          X64Word_create(1249150122, 1856431235),
          X64Word_create(1555081692, 3175218132),
          X64Word_create(1996064986, 2198950837),
          X64Word_create(2554220882, 3999719339),
          X64Word_create(2821834349, 766784016),
          X64Word_create(2952996808, 2566594879),
          X64Word_create(3210313671, 3203337956),
          X64Word_create(3336571891, 1034457026),
          X64Word_create(3584528711, 2466948901),
          X64Word_create(113926993, 3758326383),
          X64Word_create(338241895, 168717936),
          X64Word_create(666307205, 1188179964),
          X64Word_create(773529912, 1546045734),
          X64Word_create(1294757372, 1522805485),
          X64Word_create(1396182291, 2643833823),
          X64Word_create(1695183700, 2343527390),
          X64Word_create(1986661051, 1014477480),
          X64Word_create(2177026350, 1206759142),
          X64Word_create(2456956037, 344077627),
          X64Word_create(2730485921, 1290863460),
          X64Word_create(2820302411, 3158454273),
          X64Word_create(3259730800, 3505952657),
          X64Word_create(3345764771, 106217008),
          X64Word_create(3516065817, 3606008344),
          X64Word_create(3600352804, 1432725776),
          X64Word_create(4094571909, 1467031594),
          X64Word_create(275423344, 851169720),
          X64Word_create(430227734, 3100823752),
          X64Word_create(506948616, 1363258195),
          X64Word_create(659060556, 3750685593),
          X64Word_create(883997877, 3785050280),
          X64Word_create(958139571, 3318307427),
          X64Word_create(1322822218, 3812723403),
          X64Word_create(1537002063, 2003034995),
          X64Word_create(1747873779, 3602036899),
          X64Word_create(1955562222, 1575990012),
          X64Word_create(2024104815, 1125592928),
          X64Word_create(2227730452, 2716904306),
          X64Word_create(2361852424, 442776044),
          X64Word_create(2428436474, 593698344),
          X64Word_create(2756734187, 3733110249),
          X64Word_create(3204031479, 2999351573),
          X64Word_create(3329325298, 3815920427),
          X64Word_create(3391569614, 3928383900),
          X64Word_create(3515267271, 566280711),
          X64Word_create(3940187606, 3454069534),
          X64Word_create(4118630271, 4000239992),
          X64Word_create(116418474, 1914138554),
          X64Word_create(174292421, 2731055270),
          X64Word_create(289380356, 3203993006),
          X64Word_create(460393269, 320620315),
          X64Word_create(685471733, 587496836),
          X64Word_create(852142971, 1086792851),
          X64Word_create(1017036298, 365543100),
          X64Word_create(1126000580, 2618297676),
          X64Word_create(1288033470, 3409855158),
          X64Word_create(1501505948, 4234509866),
          X64Word_create(1607167915, 987167468),
          X64Word_create(1816402316, 1246189591)
        ];
        var W = [];
        (function() {
          for (var i = 0; i < 80; i++) {
            W[i] = X64Word_create();
          }
        })();
        var SHA512 = C_algo.SHA512 = Hasher.extend({
          _doReset: function() {
            this._hash = new X64WordArray.init([
              new X64Word.init(1779033703, 4089235720),
              new X64Word.init(3144134277, 2227873595),
              new X64Word.init(1013904242, 4271175723),
              new X64Word.init(2773480762, 1595750129),
              new X64Word.init(1359893119, 2917565137),
              new X64Word.init(2600822924, 725511199),
              new X64Word.init(528734635, 4215389547),
              new X64Word.init(1541459225, 327033209)
            ]);
          },
          _doProcessBlock: function(M, offset) {
            var H = this._hash.words;
            var H0 = H[0];
            var H1 = H[1];
            var H2 = H[2];
            var H3 = H[3];
            var H4 = H[4];
            var H5 = H[5];
            var H6 = H[6];
            var H7 = H[7];
            var H0h = H0.high;
            var H0l = H0.low;
            var H1h = H1.high;
            var H1l = H1.low;
            var H2h = H2.high;
            var H2l = H2.low;
            var H3h = H3.high;
            var H3l = H3.low;
            var H4h = H4.high;
            var H4l = H4.low;
            var H5h = H5.high;
            var H5l = H5.low;
            var H6h = H6.high;
            var H6l = H6.low;
            var H7h = H7.high;
            var H7l = H7.low;
            var ah = H0h;
            var al = H0l;
            var bh = H1h;
            var bl = H1l;
            var ch = H2h;
            var cl = H2l;
            var dh = H3h;
            var dl = H3l;
            var eh = H4h;
            var el = H4l;
            var fh = H5h;
            var fl = H5l;
            var gh = H6h;
            var gl = H6l;
            var hh = H7h;
            var hl = H7l;
            for (var i = 0; i < 80; i++) {
              var Wil;
              var Wih;
              var Wi = W[i];
              if (i < 16) {
                Wih = Wi.high = M[offset + i * 2] | 0;
                Wil = Wi.low = M[offset + i * 2 + 1] | 0;
              } else {
                var gamma0x = W[i - 15];
                var gamma0xh = gamma0x.high;
                var gamma0xl = gamma0x.low;
                var gamma0h = (gamma0xh >>> 1 | gamma0xl << 31) ^ (gamma0xh >>> 8 | gamma0xl << 24) ^ gamma0xh >>> 7;
                var gamma0l = (gamma0xl >>> 1 | gamma0xh << 31) ^ (gamma0xl >>> 8 | gamma0xh << 24) ^ (gamma0xl >>> 7 | gamma0xh << 25);
                var gamma1x = W[i - 2];
                var gamma1xh = gamma1x.high;
                var gamma1xl = gamma1x.low;
                var gamma1h = (gamma1xh >>> 19 | gamma1xl << 13) ^ (gamma1xh << 3 | gamma1xl >>> 29) ^ gamma1xh >>> 6;
                var gamma1l = (gamma1xl >>> 19 | gamma1xh << 13) ^ (gamma1xl << 3 | gamma1xh >>> 29) ^ (gamma1xl >>> 6 | gamma1xh << 26);
                var Wi7 = W[i - 7];
                var Wi7h = Wi7.high;
                var Wi7l = Wi7.low;
                var Wi16 = W[i - 16];
                var Wi16h = Wi16.high;
                var Wi16l = Wi16.low;
                Wil = gamma0l + Wi7l;
                Wih = gamma0h + Wi7h + (Wil >>> 0 < gamma0l >>> 0 ? 1 : 0);
                Wil = Wil + gamma1l;
                Wih = Wih + gamma1h + (Wil >>> 0 < gamma1l >>> 0 ? 1 : 0);
                Wil = Wil + Wi16l;
                Wih = Wih + Wi16h + (Wil >>> 0 < Wi16l >>> 0 ? 1 : 0);
                Wi.high = Wih;
                Wi.low = Wil;
              }
              var chh = eh & fh ^ ~eh & gh;
              var chl = el & fl ^ ~el & gl;
              var majh = ah & bh ^ ah & ch ^ bh & ch;
              var majl = al & bl ^ al & cl ^ bl & cl;
              var sigma0h = (ah >>> 28 | al << 4) ^ (ah << 30 | al >>> 2) ^ (ah << 25 | al >>> 7);
              var sigma0l = (al >>> 28 | ah << 4) ^ (al << 30 | ah >>> 2) ^ (al << 25 | ah >>> 7);
              var sigma1h = (eh >>> 14 | el << 18) ^ (eh >>> 18 | el << 14) ^ (eh << 23 | el >>> 9);
              var sigma1l = (el >>> 14 | eh << 18) ^ (el >>> 18 | eh << 14) ^ (el << 23 | eh >>> 9);
              var Ki = K[i];
              var Kih = Ki.high;
              var Kil = Ki.low;
              var t1l = hl + sigma1l;
              var t1h = hh + sigma1h + (t1l >>> 0 < hl >>> 0 ? 1 : 0);
              var t1l = t1l + chl;
              var t1h = t1h + chh + (t1l >>> 0 < chl >>> 0 ? 1 : 0);
              var t1l = t1l + Kil;
              var t1h = t1h + Kih + (t1l >>> 0 < Kil >>> 0 ? 1 : 0);
              var t1l = t1l + Wil;
              var t1h = t1h + Wih + (t1l >>> 0 < Wil >>> 0 ? 1 : 0);
              var t2l = sigma0l + majl;
              var t2h = sigma0h + majh + (t2l >>> 0 < sigma0l >>> 0 ? 1 : 0);
              hh = gh;
              hl = gl;
              gh = fh;
              gl = fl;
              fh = eh;
              fl = el;
              el = dl + t1l | 0;
              eh = dh + t1h + (el >>> 0 < dl >>> 0 ? 1 : 0) | 0;
              dh = ch;
              dl = cl;
              ch = bh;
              cl = bl;
              bh = ah;
              bl = al;
              al = t1l + t2l | 0;
              ah = t1h + t2h + (al >>> 0 < t1l >>> 0 ? 1 : 0) | 0;
            }
            H0l = H0.low = H0l + al;
            H0.high = H0h + ah + (H0l >>> 0 < al >>> 0 ? 1 : 0);
            H1l = H1.low = H1l + bl;
            H1.high = H1h + bh + (H1l >>> 0 < bl >>> 0 ? 1 : 0);
            H2l = H2.low = H2l + cl;
            H2.high = H2h + ch + (H2l >>> 0 < cl >>> 0 ? 1 : 0);
            H3l = H3.low = H3l + dl;
            H3.high = H3h + dh + (H3l >>> 0 < dl >>> 0 ? 1 : 0);
            H4l = H4.low = H4l + el;
            H4.high = H4h + eh + (H4l >>> 0 < el >>> 0 ? 1 : 0);
            H5l = H5.low = H5l + fl;
            H5.high = H5h + fh + (H5l >>> 0 < fl >>> 0 ? 1 : 0);
            H6l = H6.low = H6l + gl;
            H6.high = H6h + gh + (H6l >>> 0 < gl >>> 0 ? 1 : 0);
            H7l = H7.low = H7l + hl;
            H7.high = H7h + hh + (H7l >>> 0 < hl >>> 0 ? 1 : 0);
          },
          _doFinalize: function() {
            var data = this._data;
            var dataWords = data.words;
            var nBitsTotal = this._nDataBytes * 8;
            var nBitsLeft = data.sigBytes * 8;
            dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
            dataWords[(nBitsLeft + 128 >>> 10 << 5) + 30] = Math.floor(nBitsTotal / 4294967296);
            dataWords[(nBitsLeft + 128 >>> 10 << 5) + 31] = nBitsTotal;
            data.sigBytes = dataWords.length * 4;
            this._process();
            var hash = this._hash.toX32();
            return hash;
          },
          clone: function() {
            var clone = Hasher.clone.call(this);
            clone._hash = this._hash.clone();
            return clone;
          },
          blockSize: 1024 / 32
        });
        C.SHA512 = Hasher._createHelper(SHA512);
        C.HmacSHA512 = Hasher._createHmacHelper(SHA512);
      })();
      return CryptoJS.SHA512;
    });
  }
});

// node_modules/crypto-js/sha384.js
var require_sha384 = __commonJS({
  "node_modules/crypto-js/sha384.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_x64_core(), require_sha512());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./x64-core", "./sha512"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_x64 = C.x64;
        var X64Word = C_x64.Word;
        var X64WordArray = C_x64.WordArray;
        var C_algo = C.algo;
        var SHA512 = C_algo.SHA512;
        var SHA384 = C_algo.SHA384 = SHA512.extend({
          _doReset: function() {
            this._hash = new X64WordArray.init([
              new X64Word.init(3418070365, 3238371032),
              new X64Word.init(1654270250, 914150663),
              new X64Word.init(2438529370, 812702999),
              new X64Word.init(355462360, 4144912697),
              new X64Word.init(1731405415, 4290775857),
              new X64Word.init(2394180231, 1750603025),
              new X64Word.init(3675008525, 1694076839),
              new X64Word.init(1203062813, 3204075428)
            ]);
          },
          _doFinalize: function() {
            var hash = SHA512._doFinalize.call(this);
            hash.sigBytes -= 16;
            return hash;
          }
        });
        C.SHA384 = SHA512._createHelper(SHA384);
        C.HmacSHA384 = SHA512._createHmacHelper(SHA384);
      })();
      return CryptoJS.SHA384;
    });
  }
});

// node_modules/crypto-js/sha3.js
var require_sha3 = __commonJS({
  "node_modules/crypto-js/sha3.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_x64_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./x64-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function(Math2) {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var Hasher = C_lib.Hasher;
        var C_x64 = C.x64;
        var X64Word = C_x64.Word;
        var C_algo = C.algo;
        var RHO_OFFSETS = [];
        var PI_INDEXES = [];
        var ROUND_CONSTANTS = [];
        (function() {
          var x = 1, y = 0;
          for (var t = 0; t < 24; t++) {
            RHO_OFFSETS[x + 5 * y] = (t + 1) * (t + 2) / 2 % 64;
            var newX = y % 5;
            var newY = (2 * x + 3 * y) % 5;
            x = newX;
            y = newY;
          }
          for (var x = 0; x < 5; x++) {
            for (var y = 0; y < 5; y++) {
              PI_INDEXES[x + 5 * y] = y + (2 * x + 3 * y) % 5 * 5;
            }
          }
          var LFSR = 1;
          for (var i = 0; i < 24; i++) {
            var roundConstantMsw = 0;
            var roundConstantLsw = 0;
            for (var j = 0; j < 7; j++) {
              if (LFSR & 1) {
                var bitPosition = (1 << j) - 1;
                if (bitPosition < 32) {
                  roundConstantLsw ^= 1 << bitPosition;
                } else {
                  roundConstantMsw ^= 1 << bitPosition - 32;
                }
              }
              if (LFSR & 128) {
                LFSR = LFSR << 1 ^ 113;
              } else {
                LFSR <<= 1;
              }
            }
            ROUND_CONSTANTS[i] = X64Word.create(roundConstantMsw, roundConstantLsw);
          }
        })();
        var T = [];
        (function() {
          for (var i = 0; i < 25; i++) {
            T[i] = X64Word.create();
          }
        })();
        var SHA3 = C_algo.SHA3 = Hasher.extend({
          /**
           * Configuration options.
           *
           * @property {number} outputLength
           *   The desired number of bits in the output hash.
           *   Only values permitted are: 224, 256, 384, 512.
           *   Default: 512
           */
          cfg: Hasher.cfg.extend({
            outputLength: 512
          }),
          _doReset: function() {
            var state = this._state = [];
            for (var i = 0; i < 25; i++) {
              state[i] = new X64Word.init();
            }
            this.blockSize = (1600 - 2 * this.cfg.outputLength) / 32;
          },
          _doProcessBlock: function(M, offset) {
            var state = this._state;
            var nBlockSizeLanes = this.blockSize / 2;
            for (var i = 0; i < nBlockSizeLanes; i++) {
              var M2i = M[offset + 2 * i];
              var M2i1 = M[offset + 2 * i + 1];
              M2i = (M2i << 8 | M2i >>> 24) & 16711935 | (M2i << 24 | M2i >>> 8) & 4278255360;
              M2i1 = (M2i1 << 8 | M2i1 >>> 24) & 16711935 | (M2i1 << 24 | M2i1 >>> 8) & 4278255360;
              var lane = state[i];
              lane.high ^= M2i1;
              lane.low ^= M2i;
            }
            for (var round = 0; round < 24; round++) {
              for (var x = 0; x < 5; x++) {
                var tMsw = 0, tLsw = 0;
                for (var y = 0; y < 5; y++) {
                  var lane = state[x + 5 * y];
                  tMsw ^= lane.high;
                  tLsw ^= lane.low;
                }
                var Tx = T[x];
                Tx.high = tMsw;
                Tx.low = tLsw;
              }
              for (var x = 0; x < 5; x++) {
                var Tx4 = T[(x + 4) % 5];
                var Tx1 = T[(x + 1) % 5];
                var Tx1Msw = Tx1.high;
                var Tx1Lsw = Tx1.low;
                var tMsw = Tx4.high ^ (Tx1Msw << 1 | Tx1Lsw >>> 31);
                var tLsw = Tx4.low ^ (Tx1Lsw << 1 | Tx1Msw >>> 31);
                for (var y = 0; y < 5; y++) {
                  var lane = state[x + 5 * y];
                  lane.high ^= tMsw;
                  lane.low ^= tLsw;
                }
              }
              for (var laneIndex = 1; laneIndex < 25; laneIndex++) {
                var tMsw;
                var tLsw;
                var lane = state[laneIndex];
                var laneMsw = lane.high;
                var laneLsw = lane.low;
                var rhoOffset = RHO_OFFSETS[laneIndex];
                if (rhoOffset < 32) {
                  tMsw = laneMsw << rhoOffset | laneLsw >>> 32 - rhoOffset;
                  tLsw = laneLsw << rhoOffset | laneMsw >>> 32 - rhoOffset;
                } else {
                  tMsw = laneLsw << rhoOffset - 32 | laneMsw >>> 64 - rhoOffset;
                  tLsw = laneMsw << rhoOffset - 32 | laneLsw >>> 64 - rhoOffset;
                }
                var TPiLane = T[PI_INDEXES[laneIndex]];
                TPiLane.high = tMsw;
                TPiLane.low = tLsw;
              }
              var T0 = T[0];
              var state0 = state[0];
              T0.high = state0.high;
              T0.low = state0.low;
              for (var x = 0; x < 5; x++) {
                for (var y = 0; y < 5; y++) {
                  var laneIndex = x + 5 * y;
                  var lane = state[laneIndex];
                  var TLane = T[laneIndex];
                  var Tx1Lane = T[(x + 1) % 5 + 5 * y];
                  var Tx2Lane = T[(x + 2) % 5 + 5 * y];
                  lane.high = TLane.high ^ ~Tx1Lane.high & Tx2Lane.high;
                  lane.low = TLane.low ^ ~Tx1Lane.low & Tx2Lane.low;
                }
              }
              var lane = state[0];
              var roundConstant = ROUND_CONSTANTS[round];
              lane.high ^= roundConstant.high;
              lane.low ^= roundConstant.low;
            }
          },
          _doFinalize: function() {
            var data = this._data;
            var dataWords = data.words;
            var nBitsTotal = this._nDataBytes * 8;
            var nBitsLeft = data.sigBytes * 8;
            var blockSizeBits = this.blockSize * 32;
            dataWords[nBitsLeft >>> 5] |= 1 << 24 - nBitsLeft % 32;
            dataWords[(Math2.ceil((nBitsLeft + 1) / blockSizeBits) * blockSizeBits >>> 5) - 1] |= 128;
            data.sigBytes = dataWords.length * 4;
            this._process();
            var state = this._state;
            var outputLengthBytes = this.cfg.outputLength / 8;
            var outputLengthLanes = outputLengthBytes / 8;
            var hashWords = [];
            for (var i = 0; i < outputLengthLanes; i++) {
              var lane = state[i];
              var laneMsw = lane.high;
              var laneLsw = lane.low;
              laneMsw = (laneMsw << 8 | laneMsw >>> 24) & 16711935 | (laneMsw << 24 | laneMsw >>> 8) & 4278255360;
              laneLsw = (laneLsw << 8 | laneLsw >>> 24) & 16711935 | (laneLsw << 24 | laneLsw >>> 8) & 4278255360;
              hashWords.push(laneLsw);
              hashWords.push(laneMsw);
            }
            return new WordArray.init(hashWords, outputLengthBytes);
          },
          clone: function() {
            var clone = Hasher.clone.call(this);
            var state = clone._state = this._state.slice(0);
            for (var i = 0; i < 25; i++) {
              state[i] = state[i].clone();
            }
            return clone;
          }
        });
        C.SHA3 = Hasher._createHelper(SHA3);
        C.HmacSHA3 = Hasher._createHmacHelper(SHA3);
      })(Math);
      return CryptoJS.SHA3;
    });
  }
});

// node_modules/crypto-js/ripemd160.js
var require_ripemd160 = __commonJS({
  "node_modules/crypto-js/ripemd160.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function(Math2) {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var Hasher = C_lib.Hasher;
        var C_algo = C.algo;
        var _zl = WordArray.create([
          0,
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          7,
          4,
          13,
          1,
          10,
          6,
          15,
          3,
          12,
          0,
          9,
          5,
          2,
          14,
          11,
          8,
          3,
          10,
          14,
          4,
          9,
          15,
          8,
          1,
          2,
          7,
          0,
          6,
          13,
          11,
          5,
          12,
          1,
          9,
          11,
          10,
          0,
          8,
          12,
          4,
          13,
          3,
          7,
          15,
          14,
          5,
          6,
          2,
          4,
          0,
          5,
          9,
          7,
          12,
          2,
          10,
          14,
          1,
          3,
          8,
          11,
          6,
          15,
          13
        ]);
        var _zr = WordArray.create([
          5,
          14,
          7,
          0,
          9,
          2,
          11,
          4,
          13,
          6,
          15,
          8,
          1,
          10,
          3,
          12,
          6,
          11,
          3,
          7,
          0,
          13,
          5,
          10,
          14,
          15,
          8,
          12,
          4,
          9,
          1,
          2,
          15,
          5,
          1,
          3,
          7,
          14,
          6,
          9,
          11,
          8,
          12,
          2,
          10,
          0,
          4,
          13,
          8,
          6,
          4,
          1,
          3,
          11,
          15,
          0,
          5,
          12,
          2,
          13,
          9,
          7,
          10,
          14,
          12,
          15,
          10,
          4,
          1,
          5,
          8,
          7,
          6,
          2,
          13,
          14,
          0,
          3,
          9,
          11
        ]);
        var _sl = WordArray.create([
          11,
          14,
          15,
          12,
          5,
          8,
          7,
          9,
          11,
          13,
          14,
          15,
          6,
          7,
          9,
          8,
          7,
          6,
          8,
          13,
          11,
          9,
          7,
          15,
          7,
          12,
          15,
          9,
          11,
          7,
          13,
          12,
          11,
          13,
          6,
          7,
          14,
          9,
          13,
          15,
          14,
          8,
          13,
          6,
          5,
          12,
          7,
          5,
          11,
          12,
          14,
          15,
          14,
          15,
          9,
          8,
          9,
          14,
          5,
          6,
          8,
          6,
          5,
          12,
          9,
          15,
          5,
          11,
          6,
          8,
          13,
          12,
          5,
          12,
          13,
          14,
          11,
          8,
          5,
          6
        ]);
        var _sr = WordArray.create([
          8,
          9,
          9,
          11,
          13,
          15,
          15,
          5,
          7,
          7,
          8,
          11,
          14,
          14,
          12,
          6,
          9,
          13,
          15,
          7,
          12,
          8,
          9,
          11,
          7,
          7,
          12,
          7,
          6,
          15,
          13,
          11,
          9,
          7,
          15,
          11,
          8,
          6,
          6,
          14,
          12,
          13,
          5,
          14,
          13,
          13,
          7,
          5,
          15,
          5,
          8,
          11,
          14,
          14,
          6,
          14,
          6,
          9,
          12,
          9,
          12,
          5,
          15,
          8,
          8,
          5,
          12,
          9,
          12,
          5,
          14,
          6,
          8,
          13,
          6,
          5,
          15,
          13,
          11,
          11
        ]);
        var _hl = WordArray.create([0, 1518500249, 1859775393, 2400959708, 2840853838]);
        var _hr = WordArray.create([1352829926, 1548603684, 1836072691, 2053994217, 0]);
        var RIPEMD160 = C_algo.RIPEMD160 = Hasher.extend({
          _doReset: function() {
            this._hash = WordArray.create([1732584193, 4023233417, 2562383102, 271733878, 3285377520]);
          },
          _doProcessBlock: function(M, offset) {
            for (var i = 0; i < 16; i++) {
              var offset_i = offset + i;
              var M_offset_i = M[offset_i];
              M[offset_i] = (M_offset_i << 8 | M_offset_i >>> 24) & 16711935 | (M_offset_i << 24 | M_offset_i >>> 8) & 4278255360;
            }
            var H = this._hash.words;
            var hl = _hl.words;
            var hr = _hr.words;
            var zl = _zl.words;
            var zr = _zr.words;
            var sl = _sl.words;
            var sr = _sr.words;
            var al, bl, cl, dl, el;
            var ar, br, cr, dr, er;
            ar = al = H[0];
            br = bl = H[1];
            cr = cl = H[2];
            dr = dl = H[3];
            er = el = H[4];
            var t;
            for (var i = 0; i < 80; i += 1) {
              t = al + M[offset + zl[i]] | 0;
              if (i < 16) {
                t += f1(bl, cl, dl) + hl[0];
              } else if (i < 32) {
                t += f2(bl, cl, dl) + hl[1];
              } else if (i < 48) {
                t += f3(bl, cl, dl) + hl[2];
              } else if (i < 64) {
                t += f4(bl, cl, dl) + hl[3];
              } else {
                t += f5(bl, cl, dl) + hl[4];
              }
              t = t | 0;
              t = rotl(t, sl[i]);
              t = t + el | 0;
              al = el;
              el = dl;
              dl = rotl(cl, 10);
              cl = bl;
              bl = t;
              t = ar + M[offset + zr[i]] | 0;
              if (i < 16) {
                t += f5(br, cr, dr) + hr[0];
              } else if (i < 32) {
                t += f4(br, cr, dr) + hr[1];
              } else if (i < 48) {
                t += f3(br, cr, dr) + hr[2];
              } else if (i < 64) {
                t += f2(br, cr, dr) + hr[3];
              } else {
                t += f1(br, cr, dr) + hr[4];
              }
              t = t | 0;
              t = rotl(t, sr[i]);
              t = t + er | 0;
              ar = er;
              er = dr;
              dr = rotl(cr, 10);
              cr = br;
              br = t;
            }
            t = H[1] + cl + dr | 0;
            H[1] = H[2] + dl + er | 0;
            H[2] = H[3] + el + ar | 0;
            H[3] = H[4] + al + br | 0;
            H[4] = H[0] + bl + cr | 0;
            H[0] = t;
          },
          _doFinalize: function() {
            var data = this._data;
            var dataWords = data.words;
            var nBitsTotal = this._nDataBytes * 8;
            var nBitsLeft = data.sigBytes * 8;
            dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
            dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = (nBitsTotal << 8 | nBitsTotal >>> 24) & 16711935 | (nBitsTotal << 24 | nBitsTotal >>> 8) & 4278255360;
            data.sigBytes = (dataWords.length + 1) * 4;
            this._process();
            var hash = this._hash;
            var H = hash.words;
            for (var i = 0; i < 5; i++) {
              var H_i = H[i];
              H[i] = (H_i << 8 | H_i >>> 24) & 16711935 | (H_i << 24 | H_i >>> 8) & 4278255360;
            }
            return hash;
          },
          clone: function() {
            var clone = Hasher.clone.call(this);
            clone._hash = this._hash.clone();
            return clone;
          }
        });
        function f1(x, y, z) {
          return x ^ y ^ z;
        }
        function f2(x, y, z) {
          return x & y | ~x & z;
        }
        function f3(x, y, z) {
          return (x | ~y) ^ z;
        }
        function f4(x, y, z) {
          return x & z | y & ~z;
        }
        function f5(x, y, z) {
          return x ^ (y | ~z);
        }
        function rotl(x, n) {
          return x << n | x >>> 32 - n;
        }
        C.RIPEMD160 = Hasher._createHelper(RIPEMD160);
        C.HmacRIPEMD160 = Hasher._createHmacHelper(RIPEMD160);
      })(Math);
      return CryptoJS.RIPEMD160;
    });
  }
});

// node_modules/crypto-js/hmac.js
var require_hmac = __commonJS({
  "node_modules/crypto-js/hmac.js"(exports2, module2) {
    (function(root, factory) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var Base = C_lib.Base;
        var C_enc = C.enc;
        var Utf8 = C_enc.Utf8;
        var C_algo = C.algo;
        var HMAC = C_algo.HMAC = Base.extend({
          /**
           * Initializes a newly created HMAC.
           *
           * @param {Hasher} hasher The hash algorithm to use.
           * @param {WordArray|string} key The secret key.
           *
           * @example
           *
           *     var hmacHasher = CryptoJS.algo.HMAC.create(CryptoJS.algo.SHA256, key);
           */
          init: function(hasher, key) {
            hasher = this._hasher = new hasher.init();
            if (typeof key == "string") {
              key = Utf8.parse(key);
            }
            var hasherBlockSize = hasher.blockSize;
            var hasherBlockSizeBytes = hasherBlockSize * 4;
            if (key.sigBytes > hasherBlockSizeBytes) {
              key = hasher.finalize(key);
            }
            key.clamp();
            var oKey = this._oKey = key.clone();
            var iKey = this._iKey = key.clone();
            var oKeyWords = oKey.words;
            var iKeyWords = iKey.words;
            for (var i = 0; i < hasherBlockSize; i++) {
              oKeyWords[i] ^= 1549556828;
              iKeyWords[i] ^= 909522486;
            }
            oKey.sigBytes = iKey.sigBytes = hasherBlockSizeBytes;
            this.reset();
          },
          /**
           * Resets this HMAC to its initial state.
           *
           * @example
           *
           *     hmacHasher.reset();
           */
          reset: function() {
            var hasher = this._hasher;
            hasher.reset();
            hasher.update(this._iKey);
          },
          /**
           * Updates this HMAC with a message.
           *
           * @param {WordArray|string} messageUpdate The message to append.
           *
           * @return {HMAC} This HMAC instance.
           *
           * @example
           *
           *     hmacHasher.update('message');
           *     hmacHasher.update(wordArray);
           */
          update: function(messageUpdate) {
            this._hasher.update(messageUpdate);
            return this;
          },
          /**
           * Finalizes the HMAC computation.
           * Note that the finalize operation is effectively a destructive, read-once operation.
           *
           * @param {WordArray|string} messageUpdate (Optional) A final message update.
           *
           * @return {WordArray} The HMAC.
           *
           * @example
           *
           *     var hmac = hmacHasher.finalize();
           *     var hmac = hmacHasher.finalize('message');
           *     var hmac = hmacHasher.finalize(wordArray);
           */
          finalize: function(messageUpdate) {
            var hasher = this._hasher;
            var innerHash = hasher.finalize(messageUpdate);
            hasher.reset();
            var hmac = hasher.finalize(this._oKey.clone().concat(innerHash));
            return hmac;
          }
        });
      })();
    });
  }
});

// node_modules/crypto-js/pbkdf2.js
var require_pbkdf2 = __commonJS({
  "node_modules/crypto-js/pbkdf2.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_sha1(), require_hmac());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./sha1", "./hmac"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var Base = C_lib.Base;
        var WordArray = C_lib.WordArray;
        var C_algo = C.algo;
        var SHA1 = C_algo.SHA1;
        var HMAC = C_algo.HMAC;
        var PBKDF2 = C_algo.PBKDF2 = Base.extend({
          /**
           * Configuration options.
           *
           * @property {number} keySize The key size in words to generate. Default: 4 (128 bits)
           * @property {Hasher} hasher The hasher to use. Default: SHA1
           * @property {number} iterations The number of iterations to perform. Default: 1
           */
          cfg: Base.extend({
            keySize: 128 / 32,
            hasher: SHA1,
            iterations: 1
          }),
          /**
           * Initializes a newly created key derivation function.
           *
           * @param {Object} cfg (Optional) The configuration options to use for the derivation.
           *
           * @example
           *
           *     var kdf = CryptoJS.algo.PBKDF2.create();
           *     var kdf = CryptoJS.algo.PBKDF2.create({ keySize: 8 });
           *     var kdf = CryptoJS.algo.PBKDF2.create({ keySize: 8, iterations: 1000 });
           */
          init: function(cfg) {
            this.cfg = this.cfg.extend(cfg);
          },
          /**
           * Computes the Password-Based Key Derivation Function 2.
           *
           * @param {WordArray|string} password The password.
           * @param {WordArray|string} salt A salt.
           *
           * @return {WordArray} The derived key.
           *
           * @example
           *
           *     var key = kdf.compute(password, salt);
           */
          compute: function(password, salt) {
            var cfg = this.cfg;
            var hmac = HMAC.create(cfg.hasher, password);
            var derivedKey = WordArray.create();
            var blockIndex = WordArray.create([1]);
            var derivedKeyWords = derivedKey.words;
            var blockIndexWords = blockIndex.words;
            var keySize = cfg.keySize;
            var iterations = cfg.iterations;
            while (derivedKeyWords.length < keySize) {
              var block = hmac.update(salt).finalize(blockIndex);
              hmac.reset();
              var blockWords = block.words;
              var blockWordsLength = blockWords.length;
              var intermediate = block;
              for (var i = 1; i < iterations; i++) {
                intermediate = hmac.finalize(intermediate);
                hmac.reset();
                var intermediateWords = intermediate.words;
                for (var j = 0; j < blockWordsLength; j++) {
                  blockWords[j] ^= intermediateWords[j];
                }
              }
              derivedKey.concat(block);
              blockIndexWords[0]++;
            }
            derivedKey.sigBytes = keySize * 4;
            return derivedKey;
          }
        });
        C.PBKDF2 = function(password, salt, cfg) {
          return PBKDF2.create(cfg).compute(password, salt);
        };
      })();
      return CryptoJS.PBKDF2;
    });
  }
});

// node_modules/crypto-js/evpkdf.js
var require_evpkdf = __commonJS({
  "node_modules/crypto-js/evpkdf.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_sha1(), require_hmac());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./sha1", "./hmac"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var Base = C_lib.Base;
        var WordArray = C_lib.WordArray;
        var C_algo = C.algo;
        var MD5 = C_algo.MD5;
        var EvpKDF = C_algo.EvpKDF = Base.extend({
          /**
           * Configuration options.
           *
           * @property {number} keySize The key size in words to generate. Default: 4 (128 bits)
           * @property {Hasher} hasher The hash algorithm to use. Default: MD5
           * @property {number} iterations The number of iterations to perform. Default: 1
           */
          cfg: Base.extend({
            keySize: 128 / 32,
            hasher: MD5,
            iterations: 1
          }),
          /**
           * Initializes a newly created key derivation function.
           *
           * @param {Object} cfg (Optional) The configuration options to use for the derivation.
           *
           * @example
           *
           *     var kdf = CryptoJS.algo.EvpKDF.create();
           *     var kdf = CryptoJS.algo.EvpKDF.create({ keySize: 8 });
           *     var kdf = CryptoJS.algo.EvpKDF.create({ keySize: 8, iterations: 1000 });
           */
          init: function(cfg) {
            this.cfg = this.cfg.extend(cfg);
          },
          /**
           * Derives a key from a password.
           *
           * @param {WordArray|string} password The password.
           * @param {WordArray|string} salt A salt.
           *
           * @return {WordArray} The derived key.
           *
           * @example
           *
           *     var key = kdf.compute(password, salt);
           */
          compute: function(password, salt) {
            var block;
            var cfg = this.cfg;
            var hasher = cfg.hasher.create();
            var derivedKey = WordArray.create();
            var derivedKeyWords = derivedKey.words;
            var keySize = cfg.keySize;
            var iterations = cfg.iterations;
            while (derivedKeyWords.length < keySize) {
              if (block) {
                hasher.update(block);
              }
              block = hasher.update(password).finalize(salt);
              hasher.reset();
              for (var i = 1; i < iterations; i++) {
                block = hasher.finalize(block);
                hasher.reset();
              }
              derivedKey.concat(block);
            }
            derivedKey.sigBytes = keySize * 4;
            return derivedKey;
          }
        });
        C.EvpKDF = function(password, salt, cfg) {
          return EvpKDF.create(cfg).compute(password, salt);
        };
      })();
      return CryptoJS.EvpKDF;
    });
  }
});

// node_modules/crypto-js/cipher-core.js
var require_cipher_core = __commonJS({
  "node_modules/crypto-js/cipher-core.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_evpkdf());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./evpkdf"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.lib.Cipher || function(undefined2) {
        var C = CryptoJS;
        var C_lib = C.lib;
        var Base = C_lib.Base;
        var WordArray = C_lib.WordArray;
        var BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm;
        var C_enc = C.enc;
        var Utf8 = C_enc.Utf8;
        var Base64 = C_enc.Base64;
        var C_algo = C.algo;
        var EvpKDF = C_algo.EvpKDF;
        var Cipher = C_lib.Cipher = BufferedBlockAlgorithm.extend({
          /**
           * Configuration options.
           *
           * @property {WordArray} iv The IV to use for this operation.
           */
          cfg: Base.extend(),
          /**
           * Creates this cipher in encryption mode.
           *
           * @param {WordArray} key The key.
           * @param {Object} cfg (Optional) The configuration options to use for this operation.
           *
           * @return {Cipher} A cipher instance.
           *
           * @static
           *
           * @example
           *
           *     var cipher = CryptoJS.algo.AES.createEncryptor(keyWordArray, { iv: ivWordArray });
           */
          createEncryptor: function(key, cfg) {
            return this.create(this._ENC_XFORM_MODE, key, cfg);
          },
          /**
           * Creates this cipher in decryption mode.
           *
           * @param {WordArray} key The key.
           * @param {Object} cfg (Optional) The configuration options to use for this operation.
           *
           * @return {Cipher} A cipher instance.
           *
           * @static
           *
           * @example
           *
           *     var cipher = CryptoJS.algo.AES.createDecryptor(keyWordArray, { iv: ivWordArray });
           */
          createDecryptor: function(key, cfg) {
            return this.create(this._DEC_XFORM_MODE, key, cfg);
          },
          /**
           * Initializes a newly created cipher.
           *
           * @param {number} xformMode Either the encryption or decryption transormation mode constant.
           * @param {WordArray} key The key.
           * @param {Object} cfg (Optional) The configuration options to use for this operation.
           *
           * @example
           *
           *     var cipher = CryptoJS.algo.AES.create(CryptoJS.algo.AES._ENC_XFORM_MODE, keyWordArray, { iv: ivWordArray });
           */
          init: function(xformMode, key, cfg) {
            this.cfg = this.cfg.extend(cfg);
            this._xformMode = xformMode;
            this._key = key;
            this.reset();
          },
          /**
           * Resets this cipher to its initial state.
           *
           * @example
           *
           *     cipher.reset();
           */
          reset: function() {
            BufferedBlockAlgorithm.reset.call(this);
            this._doReset();
          },
          /**
           * Adds data to be encrypted or decrypted.
           *
           * @param {WordArray|string} dataUpdate The data to encrypt or decrypt.
           *
           * @return {WordArray} The data after processing.
           *
           * @example
           *
           *     var encrypted = cipher.process('data');
           *     var encrypted = cipher.process(wordArray);
           */
          process: function(dataUpdate) {
            this._append(dataUpdate);
            return this._process();
          },
          /**
           * Finalizes the encryption or decryption process.
           * Note that the finalize operation is effectively a destructive, read-once operation.
           *
           * @param {WordArray|string} dataUpdate The final data to encrypt or decrypt.
           *
           * @return {WordArray} The data after final processing.
           *
           * @example
           *
           *     var encrypted = cipher.finalize();
           *     var encrypted = cipher.finalize('data');
           *     var encrypted = cipher.finalize(wordArray);
           */
          finalize: function(dataUpdate) {
            if (dataUpdate) {
              this._append(dataUpdate);
            }
            var finalProcessedData = this._doFinalize();
            return finalProcessedData;
          },
          keySize: 128 / 32,
          ivSize: 128 / 32,
          _ENC_XFORM_MODE: 1,
          _DEC_XFORM_MODE: 2,
          /**
           * Creates shortcut functions to a cipher's object interface.
           *
           * @param {Cipher} cipher The cipher to create a helper for.
           *
           * @return {Object} An object with encrypt and decrypt shortcut functions.
           *
           * @static
           *
           * @example
           *
           *     var AES = CryptoJS.lib.Cipher._createHelper(CryptoJS.algo.AES);
           */
          _createHelper: /* @__PURE__ */ function() {
            function selectCipherStrategy(key) {
              if (typeof key == "string") {
                return PasswordBasedCipher;
              } else {
                return SerializableCipher;
              }
            }
            return function(cipher) {
              return {
                encrypt: function(message, key, cfg) {
                  return selectCipherStrategy(key).encrypt(cipher, message, key, cfg);
                },
                decrypt: function(ciphertext, key, cfg) {
                  return selectCipherStrategy(key).decrypt(cipher, ciphertext, key, cfg);
                }
              };
            };
          }()
        });
        var StreamCipher = C_lib.StreamCipher = Cipher.extend({
          _doFinalize: function() {
            var finalProcessedBlocks = this._process(true);
            return finalProcessedBlocks;
          },
          blockSize: 1
        });
        var C_mode = C.mode = {};
        var BlockCipherMode = C_lib.BlockCipherMode = Base.extend({
          /**
           * Creates this mode for encryption.
           *
           * @param {Cipher} cipher A block cipher instance.
           * @param {Array} iv The IV words.
           *
           * @static
           *
           * @example
           *
           *     var mode = CryptoJS.mode.CBC.createEncryptor(cipher, iv.words);
           */
          createEncryptor: function(cipher, iv) {
            return this.Encryptor.create(cipher, iv);
          },
          /**
           * Creates this mode for decryption.
           *
           * @param {Cipher} cipher A block cipher instance.
           * @param {Array} iv The IV words.
           *
           * @static
           *
           * @example
           *
           *     var mode = CryptoJS.mode.CBC.createDecryptor(cipher, iv.words);
           */
          createDecryptor: function(cipher, iv) {
            return this.Decryptor.create(cipher, iv);
          },
          /**
           * Initializes a newly created mode.
           *
           * @param {Cipher} cipher A block cipher instance.
           * @param {Array} iv The IV words.
           *
           * @example
           *
           *     var mode = CryptoJS.mode.CBC.Encryptor.create(cipher, iv.words);
           */
          init: function(cipher, iv) {
            this._cipher = cipher;
            this._iv = iv;
          }
        });
        var CBC = C_mode.CBC = function() {
          var CBC2 = BlockCipherMode.extend();
          CBC2.Encryptor = CBC2.extend({
            /**
             * Processes the data block at offset.
             *
             * @param {Array} words The data words to operate on.
             * @param {number} offset The offset where the block starts.
             *
             * @example
             *
             *     mode.processBlock(data.words, offset);
             */
            processBlock: function(words, offset) {
              var cipher = this._cipher;
              var blockSize = cipher.blockSize;
              xorBlock.call(this, words, offset, blockSize);
              cipher.encryptBlock(words, offset);
              this._prevBlock = words.slice(offset, offset + blockSize);
            }
          });
          CBC2.Decryptor = CBC2.extend({
            /**
             * Processes the data block at offset.
             *
             * @param {Array} words The data words to operate on.
             * @param {number} offset The offset where the block starts.
             *
             * @example
             *
             *     mode.processBlock(data.words, offset);
             */
            processBlock: function(words, offset) {
              var cipher = this._cipher;
              var blockSize = cipher.blockSize;
              var thisBlock = words.slice(offset, offset + blockSize);
              cipher.decryptBlock(words, offset);
              xorBlock.call(this, words, offset, blockSize);
              this._prevBlock = thisBlock;
            }
          });
          function xorBlock(words, offset, blockSize) {
            var block;
            var iv = this._iv;
            if (iv) {
              block = iv;
              this._iv = undefined2;
            } else {
              block = this._prevBlock;
            }
            for (var i = 0; i < blockSize; i++) {
              words[offset + i] ^= block[i];
            }
          }
          return CBC2;
        }();
        var C_pad = C.pad = {};
        var Pkcs7 = C_pad.Pkcs7 = {
          /**
           * Pads data using the algorithm defined in PKCS #5/7.
           *
           * @param {WordArray} data The data to pad.
           * @param {number} blockSize The multiple that the data should be padded to.
           *
           * @static
           *
           * @example
           *
           *     CryptoJS.pad.Pkcs7.pad(wordArray, 4);
           */
          pad: function(data, blockSize) {
            var blockSizeBytes = blockSize * 4;
            var nPaddingBytes = blockSizeBytes - data.sigBytes % blockSizeBytes;
            var paddingWord = nPaddingBytes << 24 | nPaddingBytes << 16 | nPaddingBytes << 8 | nPaddingBytes;
            var paddingWords = [];
            for (var i = 0; i < nPaddingBytes; i += 4) {
              paddingWords.push(paddingWord);
            }
            var padding = WordArray.create(paddingWords, nPaddingBytes);
            data.concat(padding);
          },
          /**
           * Unpads data that had been padded using the algorithm defined in PKCS #5/7.
           *
           * @param {WordArray} data The data to unpad.
           *
           * @static
           *
           * @example
           *
           *     CryptoJS.pad.Pkcs7.unpad(wordArray);
           */
          unpad: function(data) {
            var nPaddingBytes = data.words[data.sigBytes - 1 >>> 2] & 255;
            data.sigBytes -= nPaddingBytes;
          }
        };
        var BlockCipher = C_lib.BlockCipher = Cipher.extend({
          /**
           * Configuration options.
           *
           * @property {Mode} mode The block mode to use. Default: CBC
           * @property {Padding} padding The padding strategy to use. Default: Pkcs7
           */
          cfg: Cipher.cfg.extend({
            mode: CBC,
            padding: Pkcs7
          }),
          reset: function() {
            var modeCreator;
            Cipher.reset.call(this);
            var cfg = this.cfg;
            var iv = cfg.iv;
            var mode = cfg.mode;
            if (this._xformMode == this._ENC_XFORM_MODE) {
              modeCreator = mode.createEncryptor;
            } else {
              modeCreator = mode.createDecryptor;
              this._minBufferSize = 1;
            }
            if (this._mode && this._mode.__creator == modeCreator) {
              this._mode.init(this, iv && iv.words);
            } else {
              this._mode = modeCreator.call(mode, this, iv && iv.words);
              this._mode.__creator = modeCreator;
            }
          },
          _doProcessBlock: function(words, offset) {
            this._mode.processBlock(words, offset);
          },
          _doFinalize: function() {
            var finalProcessedBlocks;
            var padding = this.cfg.padding;
            if (this._xformMode == this._ENC_XFORM_MODE) {
              padding.pad(this._data, this.blockSize);
              finalProcessedBlocks = this._process(true);
            } else {
              finalProcessedBlocks = this._process(true);
              padding.unpad(finalProcessedBlocks);
            }
            return finalProcessedBlocks;
          },
          blockSize: 128 / 32
        });
        var CipherParams = C_lib.CipherParams = Base.extend({
          /**
           * Initializes a newly created cipher params object.
           *
           * @param {Object} cipherParams An object with any of the possible cipher parameters.
           *
           * @example
           *
           *     var cipherParams = CryptoJS.lib.CipherParams.create({
           *         ciphertext: ciphertextWordArray,
           *         key: keyWordArray,
           *         iv: ivWordArray,
           *         salt: saltWordArray,
           *         algorithm: CryptoJS.algo.AES,
           *         mode: CryptoJS.mode.CBC,
           *         padding: CryptoJS.pad.PKCS7,
           *         blockSize: 4,
           *         formatter: CryptoJS.format.OpenSSL
           *     });
           */
          init: function(cipherParams) {
            this.mixIn(cipherParams);
          },
          /**
           * Converts this cipher params object to a string.
           *
           * @param {Format} formatter (Optional) The formatting strategy to use.
           *
           * @return {string} The stringified cipher params.
           *
           * @throws Error If neither the formatter nor the default formatter is set.
           *
           * @example
           *
           *     var string = cipherParams + '';
           *     var string = cipherParams.toString();
           *     var string = cipherParams.toString(CryptoJS.format.OpenSSL);
           */
          toString: function(formatter) {
            return (formatter || this.formatter).stringify(this);
          }
        });
        var C_format = C.format = {};
        var OpenSSLFormatter = C_format.OpenSSL = {
          /**
           * Converts a cipher params object to an OpenSSL-compatible string.
           *
           * @param {CipherParams} cipherParams The cipher params object.
           *
           * @return {string} The OpenSSL-compatible string.
           *
           * @static
           *
           * @example
           *
           *     var openSSLString = CryptoJS.format.OpenSSL.stringify(cipherParams);
           */
          stringify: function(cipherParams) {
            var wordArray;
            var ciphertext = cipherParams.ciphertext;
            var salt = cipherParams.salt;
            if (salt) {
              wordArray = WordArray.create([1398893684, 1701076831]).concat(salt).concat(ciphertext);
            } else {
              wordArray = ciphertext;
            }
            return wordArray.toString(Base64);
          },
          /**
           * Converts an OpenSSL-compatible string to a cipher params object.
           *
           * @param {string} openSSLStr The OpenSSL-compatible string.
           *
           * @return {CipherParams} The cipher params object.
           *
           * @static
           *
           * @example
           *
           *     var cipherParams = CryptoJS.format.OpenSSL.parse(openSSLString);
           */
          parse: function(openSSLStr) {
            var salt;
            var ciphertext = Base64.parse(openSSLStr);
            var ciphertextWords = ciphertext.words;
            if (ciphertextWords[0] == 1398893684 && ciphertextWords[1] == 1701076831) {
              salt = WordArray.create(ciphertextWords.slice(2, 4));
              ciphertextWords.splice(0, 4);
              ciphertext.sigBytes -= 16;
            }
            return CipherParams.create({ ciphertext, salt });
          }
        };
        var SerializableCipher = C_lib.SerializableCipher = Base.extend({
          /**
           * Configuration options.
           *
           * @property {Formatter} format The formatting strategy to convert cipher param objects to and from a string. Default: OpenSSL
           */
          cfg: Base.extend({
            format: OpenSSLFormatter
          }),
          /**
           * Encrypts a message.
           *
           * @param {Cipher} cipher The cipher algorithm to use.
           * @param {WordArray|string} message The message to encrypt.
           * @param {WordArray} key The key.
           * @param {Object} cfg (Optional) The configuration options to use for this operation.
           *
           * @return {CipherParams} A cipher params object.
           *
           * @static
           *
           * @example
           *
           *     var ciphertextParams = CryptoJS.lib.SerializableCipher.encrypt(CryptoJS.algo.AES, message, key);
           *     var ciphertextParams = CryptoJS.lib.SerializableCipher.encrypt(CryptoJS.algo.AES, message, key, { iv: iv });
           *     var ciphertextParams = CryptoJS.lib.SerializableCipher.encrypt(CryptoJS.algo.AES, message, key, { iv: iv, format: CryptoJS.format.OpenSSL });
           */
          encrypt: function(cipher, message, key, cfg) {
            cfg = this.cfg.extend(cfg);
            var encryptor = cipher.createEncryptor(key, cfg);
            var ciphertext = encryptor.finalize(message);
            var cipherCfg = encryptor.cfg;
            return CipherParams.create({
              ciphertext,
              key,
              iv: cipherCfg.iv,
              algorithm: cipher,
              mode: cipherCfg.mode,
              padding: cipherCfg.padding,
              blockSize: cipher.blockSize,
              formatter: cfg.format
            });
          },
          /**
           * Decrypts serialized ciphertext.
           *
           * @param {Cipher} cipher The cipher algorithm to use.
           * @param {CipherParams|string} ciphertext The ciphertext to decrypt.
           * @param {WordArray} key The key.
           * @param {Object} cfg (Optional) The configuration options to use for this operation.
           *
           * @return {WordArray} The plaintext.
           *
           * @static
           *
           * @example
           *
           *     var plaintext = CryptoJS.lib.SerializableCipher.decrypt(CryptoJS.algo.AES, formattedCiphertext, key, { iv: iv, format: CryptoJS.format.OpenSSL });
           *     var plaintext = CryptoJS.lib.SerializableCipher.decrypt(CryptoJS.algo.AES, ciphertextParams, key, { iv: iv, format: CryptoJS.format.OpenSSL });
           */
          decrypt: function(cipher, ciphertext, key, cfg) {
            cfg = this.cfg.extend(cfg);
            ciphertext = this._parse(ciphertext, cfg.format);
            var plaintext = cipher.createDecryptor(key, cfg).finalize(ciphertext.ciphertext);
            return plaintext;
          },
          /**
           * Converts serialized ciphertext to CipherParams,
           * else assumed CipherParams already and returns ciphertext unchanged.
           *
           * @param {CipherParams|string} ciphertext The ciphertext.
           * @param {Formatter} format The formatting strategy to use to parse serialized ciphertext.
           *
           * @return {CipherParams} The unserialized ciphertext.
           *
           * @static
           *
           * @example
           *
           *     var ciphertextParams = CryptoJS.lib.SerializableCipher._parse(ciphertextStringOrParams, format);
           */
          _parse: function(ciphertext, format) {
            if (typeof ciphertext == "string") {
              return format.parse(ciphertext, this);
            } else {
              return ciphertext;
            }
          }
        });
        var C_kdf = C.kdf = {};
        var OpenSSLKdf = C_kdf.OpenSSL = {
          /**
           * Derives a key and IV from a password.
           *
           * @param {string} password The password to derive from.
           * @param {number} keySize The size in words of the key to generate.
           * @param {number} ivSize The size in words of the IV to generate.
           * @param {WordArray|string} salt (Optional) A 64-bit salt to use. If omitted, a salt will be generated randomly.
           *
           * @return {CipherParams} A cipher params object with the key, IV, and salt.
           *
           * @static
           *
           * @example
           *
           *     var derivedParams = CryptoJS.kdf.OpenSSL.execute('Password', 256/32, 128/32);
           *     var derivedParams = CryptoJS.kdf.OpenSSL.execute('Password', 256/32, 128/32, 'saltsalt');
           */
          execute: function(password, keySize, ivSize, salt) {
            if (!salt) {
              salt = WordArray.random(64 / 8);
            }
            var key = EvpKDF.create({ keySize: keySize + ivSize }).compute(password, salt);
            var iv = WordArray.create(key.words.slice(keySize), ivSize * 4);
            key.sigBytes = keySize * 4;
            return CipherParams.create({ key, iv, salt });
          }
        };
        var PasswordBasedCipher = C_lib.PasswordBasedCipher = SerializableCipher.extend({
          /**
           * Configuration options.
           *
           * @property {KDF} kdf The key derivation function to use to generate a key and IV from a password. Default: OpenSSL
           */
          cfg: SerializableCipher.cfg.extend({
            kdf: OpenSSLKdf
          }),
          /**
           * Encrypts a message using a password.
           *
           * @param {Cipher} cipher The cipher algorithm to use.
           * @param {WordArray|string} message The message to encrypt.
           * @param {string} password The password.
           * @param {Object} cfg (Optional) The configuration options to use for this operation.
           *
           * @return {CipherParams} A cipher params object.
           *
           * @static
           *
           * @example
           *
           *     var ciphertextParams = CryptoJS.lib.PasswordBasedCipher.encrypt(CryptoJS.algo.AES, message, 'password');
           *     var ciphertextParams = CryptoJS.lib.PasswordBasedCipher.encrypt(CryptoJS.algo.AES, message, 'password', { format: CryptoJS.format.OpenSSL });
           */
          encrypt: function(cipher, message, password, cfg) {
            cfg = this.cfg.extend(cfg);
            var derivedParams = cfg.kdf.execute(password, cipher.keySize, cipher.ivSize);
            cfg.iv = derivedParams.iv;
            var ciphertext = SerializableCipher.encrypt.call(this, cipher, message, derivedParams.key, cfg);
            ciphertext.mixIn(derivedParams);
            return ciphertext;
          },
          /**
           * Decrypts serialized ciphertext using a password.
           *
           * @param {Cipher} cipher The cipher algorithm to use.
           * @param {CipherParams|string} ciphertext The ciphertext to decrypt.
           * @param {string} password The password.
           * @param {Object} cfg (Optional) The configuration options to use for this operation.
           *
           * @return {WordArray} The plaintext.
           *
           * @static
           *
           * @example
           *
           *     var plaintext = CryptoJS.lib.PasswordBasedCipher.decrypt(CryptoJS.algo.AES, formattedCiphertext, 'password', { format: CryptoJS.format.OpenSSL });
           *     var plaintext = CryptoJS.lib.PasswordBasedCipher.decrypt(CryptoJS.algo.AES, ciphertextParams, 'password', { format: CryptoJS.format.OpenSSL });
           */
          decrypt: function(cipher, ciphertext, password, cfg) {
            cfg = this.cfg.extend(cfg);
            ciphertext = this._parse(ciphertext, cfg.format);
            var derivedParams = cfg.kdf.execute(password, cipher.keySize, cipher.ivSize, ciphertext.salt);
            cfg.iv = derivedParams.iv;
            var plaintext = SerializableCipher.decrypt.call(this, cipher, ciphertext, derivedParams.key, cfg);
            return plaintext;
          }
        });
      }();
    });
  }
});

// node_modules/crypto-js/mode-cfb.js
var require_mode_cfb = __commonJS({
  "node_modules/crypto-js/mode-cfb.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.mode.CFB = function() {
        var CFB = CryptoJS.lib.BlockCipherMode.extend();
        CFB.Encryptor = CFB.extend({
          processBlock: function(words, offset) {
            var cipher = this._cipher;
            var blockSize = cipher.blockSize;
            generateKeystreamAndEncrypt.call(this, words, offset, blockSize, cipher);
            this._prevBlock = words.slice(offset, offset + blockSize);
          }
        });
        CFB.Decryptor = CFB.extend({
          processBlock: function(words, offset) {
            var cipher = this._cipher;
            var blockSize = cipher.blockSize;
            var thisBlock = words.slice(offset, offset + blockSize);
            generateKeystreamAndEncrypt.call(this, words, offset, blockSize, cipher);
            this._prevBlock = thisBlock;
          }
        });
        function generateKeystreamAndEncrypt(words, offset, blockSize, cipher) {
          var keystream;
          var iv = this._iv;
          if (iv) {
            keystream = iv.slice(0);
            this._iv = void 0;
          } else {
            keystream = this._prevBlock;
          }
          cipher.encryptBlock(keystream, 0);
          for (var i = 0; i < blockSize; i++) {
            words[offset + i] ^= keystream[i];
          }
        }
        return CFB;
      }();
      return CryptoJS.mode.CFB;
    });
  }
});

// node_modules/crypto-js/mode-ctr.js
var require_mode_ctr = __commonJS({
  "node_modules/crypto-js/mode-ctr.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.mode.CTR = function() {
        var CTR = CryptoJS.lib.BlockCipherMode.extend();
        var Encryptor = CTR.Encryptor = CTR.extend({
          processBlock: function(words, offset) {
            var cipher = this._cipher;
            var blockSize = cipher.blockSize;
            var iv = this._iv;
            var counter = this._counter;
            if (iv) {
              counter = this._counter = iv.slice(0);
              this._iv = void 0;
            }
            var keystream = counter.slice(0);
            cipher.encryptBlock(keystream, 0);
            counter[blockSize - 1] = counter[blockSize - 1] + 1 | 0;
            for (var i = 0; i < blockSize; i++) {
              words[offset + i] ^= keystream[i];
            }
          }
        });
        CTR.Decryptor = Encryptor;
        return CTR;
      }();
      return CryptoJS.mode.CTR;
    });
  }
});

// node_modules/crypto-js/mode-ctr-gladman.js
var require_mode_ctr_gladman = __commonJS({
  "node_modules/crypto-js/mode-ctr-gladman.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.mode.CTRGladman = function() {
        var CTRGladman = CryptoJS.lib.BlockCipherMode.extend();
        function incWord(word) {
          if ((word >> 24 & 255) === 255) {
            var b1 = word >> 16 & 255;
            var b2 = word >> 8 & 255;
            var b3 = word & 255;
            if (b1 === 255) {
              b1 = 0;
              if (b2 === 255) {
                b2 = 0;
                if (b3 === 255) {
                  b3 = 0;
                } else {
                  ++b3;
                }
              } else {
                ++b2;
              }
            } else {
              ++b1;
            }
            word = 0;
            word += b1 << 16;
            word += b2 << 8;
            word += b3;
          } else {
            word += 1 << 24;
          }
          return word;
        }
        function incCounter(counter) {
          if ((counter[0] = incWord(counter[0])) === 0) {
            counter[1] = incWord(counter[1]);
          }
          return counter;
        }
        var Encryptor = CTRGladman.Encryptor = CTRGladman.extend({
          processBlock: function(words, offset) {
            var cipher = this._cipher;
            var blockSize = cipher.blockSize;
            var iv = this._iv;
            var counter = this._counter;
            if (iv) {
              counter = this._counter = iv.slice(0);
              this._iv = void 0;
            }
            incCounter(counter);
            var keystream = counter.slice(0);
            cipher.encryptBlock(keystream, 0);
            for (var i = 0; i < blockSize; i++) {
              words[offset + i] ^= keystream[i];
            }
          }
        });
        CTRGladman.Decryptor = Encryptor;
        return CTRGladman;
      }();
      return CryptoJS.mode.CTRGladman;
    });
  }
});

// node_modules/crypto-js/mode-ofb.js
var require_mode_ofb = __commonJS({
  "node_modules/crypto-js/mode-ofb.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.mode.OFB = function() {
        var OFB = CryptoJS.lib.BlockCipherMode.extend();
        var Encryptor = OFB.Encryptor = OFB.extend({
          processBlock: function(words, offset) {
            var cipher = this._cipher;
            var blockSize = cipher.blockSize;
            var iv = this._iv;
            var keystream = this._keystream;
            if (iv) {
              keystream = this._keystream = iv.slice(0);
              this._iv = void 0;
            }
            cipher.encryptBlock(keystream, 0);
            for (var i = 0; i < blockSize; i++) {
              words[offset + i] ^= keystream[i];
            }
          }
        });
        OFB.Decryptor = Encryptor;
        return OFB;
      }();
      return CryptoJS.mode.OFB;
    });
  }
});

// node_modules/crypto-js/mode-ecb.js
var require_mode_ecb = __commonJS({
  "node_modules/crypto-js/mode-ecb.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.mode.ECB = function() {
        var ECB = CryptoJS.lib.BlockCipherMode.extend();
        ECB.Encryptor = ECB.extend({
          processBlock: function(words, offset) {
            this._cipher.encryptBlock(words, offset);
          }
        });
        ECB.Decryptor = ECB.extend({
          processBlock: function(words, offset) {
            this._cipher.decryptBlock(words, offset);
          }
        });
        return ECB;
      }();
      return CryptoJS.mode.ECB;
    });
  }
});

// node_modules/crypto-js/pad-ansix923.js
var require_pad_ansix923 = __commonJS({
  "node_modules/crypto-js/pad-ansix923.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.pad.AnsiX923 = {
        pad: function(data, blockSize) {
          var dataSigBytes = data.sigBytes;
          var blockSizeBytes = blockSize * 4;
          var nPaddingBytes = blockSizeBytes - dataSigBytes % blockSizeBytes;
          var lastBytePos = dataSigBytes + nPaddingBytes - 1;
          data.clamp();
          data.words[lastBytePos >>> 2] |= nPaddingBytes << 24 - lastBytePos % 4 * 8;
          data.sigBytes += nPaddingBytes;
        },
        unpad: function(data) {
          var nPaddingBytes = data.words[data.sigBytes - 1 >>> 2] & 255;
          data.sigBytes -= nPaddingBytes;
        }
      };
      return CryptoJS.pad.Ansix923;
    });
  }
});

// node_modules/crypto-js/pad-iso10126.js
var require_pad_iso10126 = __commonJS({
  "node_modules/crypto-js/pad-iso10126.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.pad.Iso10126 = {
        pad: function(data, blockSize) {
          var blockSizeBytes = blockSize * 4;
          var nPaddingBytes = blockSizeBytes - data.sigBytes % blockSizeBytes;
          data.concat(CryptoJS.lib.WordArray.random(nPaddingBytes - 1)).concat(CryptoJS.lib.WordArray.create([nPaddingBytes << 24], 1));
        },
        unpad: function(data) {
          var nPaddingBytes = data.words[data.sigBytes - 1 >>> 2] & 255;
          data.sigBytes -= nPaddingBytes;
        }
      };
      return CryptoJS.pad.Iso10126;
    });
  }
});

// node_modules/crypto-js/pad-iso97971.js
var require_pad_iso97971 = __commonJS({
  "node_modules/crypto-js/pad-iso97971.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.pad.Iso97971 = {
        pad: function(data, blockSize) {
          data.concat(CryptoJS.lib.WordArray.create([2147483648], 1));
          CryptoJS.pad.ZeroPadding.pad(data, blockSize);
        },
        unpad: function(data) {
          CryptoJS.pad.ZeroPadding.unpad(data);
          data.sigBytes--;
        }
      };
      return CryptoJS.pad.Iso97971;
    });
  }
});

// node_modules/crypto-js/pad-zeropadding.js
var require_pad_zeropadding = __commonJS({
  "node_modules/crypto-js/pad-zeropadding.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.pad.ZeroPadding = {
        pad: function(data, blockSize) {
          var blockSizeBytes = blockSize * 4;
          data.clamp();
          data.sigBytes += blockSizeBytes - (data.sigBytes % blockSizeBytes || blockSizeBytes);
        },
        unpad: function(data) {
          var dataWords = data.words;
          var i = data.sigBytes - 1;
          for (var i = data.sigBytes - 1; i >= 0; i--) {
            if (dataWords[i >>> 2] >>> 24 - i % 4 * 8 & 255) {
              data.sigBytes = i + 1;
              break;
            }
          }
        }
      };
      return CryptoJS.pad.ZeroPadding;
    });
  }
});

// node_modules/crypto-js/pad-nopadding.js
var require_pad_nopadding = __commonJS({
  "node_modules/crypto-js/pad-nopadding.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      CryptoJS.pad.NoPadding = {
        pad: function() {
        },
        unpad: function() {
        }
      };
      return CryptoJS.pad.NoPadding;
    });
  }
});

// node_modules/crypto-js/format-hex.js
var require_format_hex = __commonJS({
  "node_modules/crypto-js/format-hex.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function(undefined2) {
        var C = CryptoJS;
        var C_lib = C.lib;
        var CipherParams = C_lib.CipherParams;
        var C_enc = C.enc;
        var Hex = C_enc.Hex;
        var C_format = C.format;
        var HexFormatter = C_format.Hex = {
          /**
           * Converts the ciphertext of a cipher params object to a hexadecimally encoded string.
           *
           * @param {CipherParams} cipherParams The cipher params object.
           *
           * @return {string} The hexadecimally encoded string.
           *
           * @static
           *
           * @example
           *
           *     var hexString = CryptoJS.format.Hex.stringify(cipherParams);
           */
          stringify: function(cipherParams) {
            return cipherParams.ciphertext.toString(Hex);
          },
          /**
           * Converts a hexadecimally encoded ciphertext string to a cipher params object.
           *
           * @param {string} input The hexadecimally encoded string.
           *
           * @return {CipherParams} The cipher params object.
           *
           * @static
           *
           * @example
           *
           *     var cipherParams = CryptoJS.format.Hex.parse(hexString);
           */
          parse: function(input) {
            var ciphertext = Hex.parse(input);
            return CipherParams.create({ ciphertext });
          }
        };
      })();
      return CryptoJS.format.Hex;
    });
  }
});

// node_modules/crypto-js/aes.js
var require_aes = __commonJS({
  "node_modules/crypto-js/aes.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./enc-base64", "./md5", "./evpkdf", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var BlockCipher = C_lib.BlockCipher;
        var C_algo = C.algo;
        var SBOX = [];
        var INV_SBOX = [];
        var SUB_MIX_0 = [];
        var SUB_MIX_1 = [];
        var SUB_MIX_2 = [];
        var SUB_MIX_3 = [];
        var INV_SUB_MIX_0 = [];
        var INV_SUB_MIX_1 = [];
        var INV_SUB_MIX_2 = [];
        var INV_SUB_MIX_3 = [];
        (function() {
          var d = [];
          for (var i = 0; i < 256; i++) {
            if (i < 128) {
              d[i] = i << 1;
            } else {
              d[i] = i << 1 ^ 283;
            }
          }
          var x = 0;
          var xi = 0;
          for (var i = 0; i < 256; i++) {
            var sx = xi ^ xi << 1 ^ xi << 2 ^ xi << 3 ^ xi << 4;
            sx = sx >>> 8 ^ sx & 255 ^ 99;
            SBOX[x] = sx;
            INV_SBOX[sx] = x;
            var x2 = d[x];
            var x4 = d[x2];
            var x8 = d[x4];
            var t = d[sx] * 257 ^ sx * 16843008;
            SUB_MIX_0[x] = t << 24 | t >>> 8;
            SUB_MIX_1[x] = t << 16 | t >>> 16;
            SUB_MIX_2[x] = t << 8 | t >>> 24;
            SUB_MIX_3[x] = t;
            var t = x8 * 16843009 ^ x4 * 65537 ^ x2 * 257 ^ x * 16843008;
            INV_SUB_MIX_0[sx] = t << 24 | t >>> 8;
            INV_SUB_MIX_1[sx] = t << 16 | t >>> 16;
            INV_SUB_MIX_2[sx] = t << 8 | t >>> 24;
            INV_SUB_MIX_3[sx] = t;
            if (!x) {
              x = xi = 1;
            } else {
              x = x2 ^ d[d[d[x8 ^ x2]]];
              xi ^= d[d[xi]];
            }
          }
        })();
        var RCON = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
        var AES = C_algo.AES = BlockCipher.extend({
          _doReset: function() {
            var t;
            if (this._nRounds && this._keyPriorReset === this._key) {
              return;
            }
            var key = this._keyPriorReset = this._key;
            var keyWords = key.words;
            var keySize = key.sigBytes / 4;
            var nRounds = this._nRounds = keySize + 6;
            var ksRows = (nRounds + 1) * 4;
            var keySchedule = this._keySchedule = [];
            for (var ksRow = 0; ksRow < ksRows; ksRow++) {
              if (ksRow < keySize) {
                keySchedule[ksRow] = keyWords[ksRow];
              } else {
                t = keySchedule[ksRow - 1];
                if (!(ksRow % keySize)) {
                  t = t << 8 | t >>> 24;
                  t = SBOX[t >>> 24] << 24 | SBOX[t >>> 16 & 255] << 16 | SBOX[t >>> 8 & 255] << 8 | SBOX[t & 255];
                  t ^= RCON[ksRow / keySize | 0] << 24;
                } else if (keySize > 6 && ksRow % keySize == 4) {
                  t = SBOX[t >>> 24] << 24 | SBOX[t >>> 16 & 255] << 16 | SBOX[t >>> 8 & 255] << 8 | SBOX[t & 255];
                }
                keySchedule[ksRow] = keySchedule[ksRow - keySize] ^ t;
              }
            }
            var invKeySchedule = this._invKeySchedule = [];
            for (var invKsRow = 0; invKsRow < ksRows; invKsRow++) {
              var ksRow = ksRows - invKsRow;
              if (invKsRow % 4) {
                var t = keySchedule[ksRow];
              } else {
                var t = keySchedule[ksRow - 4];
              }
              if (invKsRow < 4 || ksRow <= 4) {
                invKeySchedule[invKsRow] = t;
              } else {
                invKeySchedule[invKsRow] = INV_SUB_MIX_0[SBOX[t >>> 24]] ^ INV_SUB_MIX_1[SBOX[t >>> 16 & 255]] ^ INV_SUB_MIX_2[SBOX[t >>> 8 & 255]] ^ INV_SUB_MIX_3[SBOX[t & 255]];
              }
            }
          },
          encryptBlock: function(M, offset) {
            this._doCryptBlock(M, offset, this._keySchedule, SUB_MIX_0, SUB_MIX_1, SUB_MIX_2, SUB_MIX_3, SBOX);
          },
          decryptBlock: function(M, offset) {
            var t = M[offset + 1];
            M[offset + 1] = M[offset + 3];
            M[offset + 3] = t;
            this._doCryptBlock(M, offset, this._invKeySchedule, INV_SUB_MIX_0, INV_SUB_MIX_1, INV_SUB_MIX_2, INV_SUB_MIX_3, INV_SBOX);
            var t = M[offset + 1];
            M[offset + 1] = M[offset + 3];
            M[offset + 3] = t;
          },
          _doCryptBlock: function(M, offset, keySchedule, SUB_MIX_02, SUB_MIX_12, SUB_MIX_22, SUB_MIX_32, SBOX2) {
            var nRounds = this._nRounds;
            var s0 = M[offset] ^ keySchedule[0];
            var s1 = M[offset + 1] ^ keySchedule[1];
            var s2 = M[offset + 2] ^ keySchedule[2];
            var s3 = M[offset + 3] ^ keySchedule[3];
            var ksRow = 4;
            for (var round = 1; round < nRounds; round++) {
              var t0 = SUB_MIX_02[s0 >>> 24] ^ SUB_MIX_12[s1 >>> 16 & 255] ^ SUB_MIX_22[s2 >>> 8 & 255] ^ SUB_MIX_32[s3 & 255] ^ keySchedule[ksRow++];
              var t1 = SUB_MIX_02[s1 >>> 24] ^ SUB_MIX_12[s2 >>> 16 & 255] ^ SUB_MIX_22[s3 >>> 8 & 255] ^ SUB_MIX_32[s0 & 255] ^ keySchedule[ksRow++];
              var t2 = SUB_MIX_02[s2 >>> 24] ^ SUB_MIX_12[s3 >>> 16 & 255] ^ SUB_MIX_22[s0 >>> 8 & 255] ^ SUB_MIX_32[s1 & 255] ^ keySchedule[ksRow++];
              var t3 = SUB_MIX_02[s3 >>> 24] ^ SUB_MIX_12[s0 >>> 16 & 255] ^ SUB_MIX_22[s1 >>> 8 & 255] ^ SUB_MIX_32[s2 & 255] ^ keySchedule[ksRow++];
              s0 = t0;
              s1 = t1;
              s2 = t2;
              s3 = t3;
            }
            var t0 = (SBOX2[s0 >>> 24] << 24 | SBOX2[s1 >>> 16 & 255] << 16 | SBOX2[s2 >>> 8 & 255] << 8 | SBOX2[s3 & 255]) ^ keySchedule[ksRow++];
            var t1 = (SBOX2[s1 >>> 24] << 24 | SBOX2[s2 >>> 16 & 255] << 16 | SBOX2[s3 >>> 8 & 255] << 8 | SBOX2[s0 & 255]) ^ keySchedule[ksRow++];
            var t2 = (SBOX2[s2 >>> 24] << 24 | SBOX2[s3 >>> 16 & 255] << 16 | SBOX2[s0 >>> 8 & 255] << 8 | SBOX2[s1 & 255]) ^ keySchedule[ksRow++];
            var t3 = (SBOX2[s3 >>> 24] << 24 | SBOX2[s0 >>> 16 & 255] << 16 | SBOX2[s1 >>> 8 & 255] << 8 | SBOX2[s2 & 255]) ^ keySchedule[ksRow++];
            M[offset] = t0;
            M[offset + 1] = t1;
            M[offset + 2] = t2;
            M[offset + 3] = t3;
          },
          keySize: 256 / 32
        });
        C.AES = BlockCipher._createHelper(AES);
      })();
      return CryptoJS.AES;
    });
  }
});

// node_modules/crypto-js/tripledes.js
var require_tripledes = __commonJS({
  "node_modules/crypto-js/tripledes.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./enc-base64", "./md5", "./evpkdf", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var WordArray = C_lib.WordArray;
        var BlockCipher = C_lib.BlockCipher;
        var C_algo = C.algo;
        var PC1 = [
          57,
          49,
          41,
          33,
          25,
          17,
          9,
          1,
          58,
          50,
          42,
          34,
          26,
          18,
          10,
          2,
          59,
          51,
          43,
          35,
          27,
          19,
          11,
          3,
          60,
          52,
          44,
          36,
          63,
          55,
          47,
          39,
          31,
          23,
          15,
          7,
          62,
          54,
          46,
          38,
          30,
          22,
          14,
          6,
          61,
          53,
          45,
          37,
          29,
          21,
          13,
          5,
          28,
          20,
          12,
          4
        ];
        var PC2 = [
          14,
          17,
          11,
          24,
          1,
          5,
          3,
          28,
          15,
          6,
          21,
          10,
          23,
          19,
          12,
          4,
          26,
          8,
          16,
          7,
          27,
          20,
          13,
          2,
          41,
          52,
          31,
          37,
          47,
          55,
          30,
          40,
          51,
          45,
          33,
          48,
          44,
          49,
          39,
          56,
          34,
          53,
          46,
          42,
          50,
          36,
          29,
          32
        ];
        var BIT_SHIFTS = [1, 2, 4, 6, 8, 10, 12, 14, 15, 17, 19, 21, 23, 25, 27, 28];
        var SBOX_P = [
          {
            0: 8421888,
            268435456: 32768,
            536870912: 8421378,
            805306368: 2,
            1073741824: 512,
            1342177280: 8421890,
            1610612736: 8389122,
            1879048192: 8388608,
            2147483648: 514,
            2415919104: 8389120,
            2684354560: 33280,
            2952790016: 8421376,
            3221225472: 32770,
            3489660928: 8388610,
            3758096384: 0,
            4026531840: 33282,
            134217728: 0,
            402653184: 8421890,
            671088640: 33282,
            939524096: 32768,
            1207959552: 8421888,
            1476395008: 512,
            1744830464: 8421378,
            2013265920: 2,
            2281701376: 8389120,
            2550136832: 33280,
            2818572288: 8421376,
            3087007744: 8389122,
            3355443200: 8388610,
            3623878656: 32770,
            3892314112: 514,
            4160749568: 8388608,
            1: 32768,
            268435457: 2,
            536870913: 8421888,
            805306369: 8388608,
            1073741825: 8421378,
            1342177281: 33280,
            1610612737: 512,
            1879048193: 8389122,
            2147483649: 8421890,
            2415919105: 8421376,
            2684354561: 8388610,
            2952790017: 33282,
            3221225473: 514,
            3489660929: 8389120,
            3758096385: 32770,
            4026531841: 0,
            134217729: 8421890,
            402653185: 8421376,
            671088641: 8388608,
            939524097: 512,
            1207959553: 32768,
            1476395009: 8388610,
            1744830465: 2,
            2013265921: 33282,
            2281701377: 32770,
            2550136833: 8389122,
            2818572289: 514,
            3087007745: 8421888,
            3355443201: 8389120,
            3623878657: 0,
            3892314113: 33280,
            4160749569: 8421378
          },
          {
            0: 1074282512,
            16777216: 16384,
            33554432: 524288,
            50331648: 1074266128,
            67108864: 1073741840,
            83886080: 1074282496,
            100663296: 1073758208,
            117440512: 16,
            134217728: 540672,
            150994944: 1073758224,
            167772160: 1073741824,
            184549376: 540688,
            201326592: 524304,
            218103808: 0,
            234881024: 16400,
            251658240: 1074266112,
            8388608: 1073758208,
            25165824: 540688,
            41943040: 16,
            58720256: 1073758224,
            75497472: 1074282512,
            92274688: 1073741824,
            109051904: 524288,
            125829120: 1074266128,
            142606336: 524304,
            159383552: 0,
            176160768: 16384,
            192937984: 1074266112,
            209715200: 1073741840,
            226492416: 540672,
            243269632: 1074282496,
            260046848: 16400,
            268435456: 0,
            285212672: 1074266128,
            301989888: 1073758224,
            318767104: 1074282496,
            335544320: 1074266112,
            352321536: 16,
            369098752: 540688,
            385875968: 16384,
            402653184: 16400,
            419430400: 524288,
            436207616: 524304,
            452984832: 1073741840,
            469762048: 540672,
            486539264: 1073758208,
            503316480: 1073741824,
            520093696: 1074282512,
            276824064: 540688,
            293601280: 524288,
            310378496: 1074266112,
            327155712: 16384,
            343932928: 1073758208,
            360710144: 1074282512,
            377487360: 16,
            394264576: 1073741824,
            411041792: 1074282496,
            427819008: 1073741840,
            444596224: 1073758224,
            461373440: 524304,
            478150656: 0,
            494927872: 16400,
            511705088: 1074266128,
            528482304: 540672
          },
          {
            0: 260,
            1048576: 0,
            2097152: 67109120,
            3145728: 65796,
            4194304: 65540,
            5242880: 67108868,
            6291456: 67174660,
            7340032: 67174400,
            8388608: 67108864,
            9437184: 67174656,
            10485760: 65792,
            11534336: 67174404,
            12582912: 67109124,
            13631488: 65536,
            14680064: 4,
            15728640: 256,
            524288: 67174656,
            1572864: 67174404,
            2621440: 0,
            3670016: 67109120,
            4718592: 67108868,
            5767168: 65536,
            6815744: 65540,
            7864320: 260,
            8912896: 4,
            9961472: 256,
            11010048: 67174400,
            12058624: 65796,
            13107200: 65792,
            14155776: 67109124,
            15204352: 67174660,
            16252928: 67108864,
            16777216: 67174656,
            17825792: 65540,
            18874368: 65536,
            19922944: 67109120,
            20971520: 256,
            22020096: 67174660,
            23068672: 67108868,
            24117248: 0,
            25165824: 67109124,
            26214400: 67108864,
            27262976: 4,
            28311552: 65792,
            29360128: 67174400,
            30408704: 260,
            31457280: 65796,
            32505856: 67174404,
            17301504: 67108864,
            18350080: 260,
            19398656: 67174656,
            20447232: 0,
            21495808: 65540,
            22544384: 67109120,
            23592960: 256,
            24641536: 67174404,
            25690112: 65536,
            26738688: 67174660,
            27787264: 65796,
            28835840: 67108868,
            29884416: 67109124,
            30932992: 67174400,
            31981568: 4,
            33030144: 65792
          },
          {
            0: 2151682048,
            65536: 2147487808,
            131072: 4198464,
            196608: 2151677952,
            262144: 0,
            327680: 4198400,
            393216: 2147483712,
            458752: 4194368,
            524288: 2147483648,
            589824: 4194304,
            655360: 64,
            720896: 2147487744,
            786432: 2151678016,
            851968: 4160,
            917504: 4096,
            983040: 2151682112,
            32768: 2147487808,
            98304: 64,
            163840: 2151678016,
            229376: 2147487744,
            294912: 4198400,
            360448: 2151682112,
            425984: 0,
            491520: 2151677952,
            557056: 4096,
            622592: 2151682048,
            688128: 4194304,
            753664: 4160,
            819200: 2147483648,
            884736: 4194368,
            950272: 4198464,
            1015808: 2147483712,
            1048576: 4194368,
            1114112: 4198400,
            1179648: 2147483712,
            1245184: 0,
            1310720: 4160,
            1376256: 2151678016,
            1441792: 2151682048,
            1507328: 2147487808,
            1572864: 2151682112,
            1638400: 2147483648,
            1703936: 2151677952,
            1769472: 4198464,
            1835008: 2147487744,
            1900544: 4194304,
            1966080: 64,
            2031616: 4096,
            1081344: 2151677952,
            1146880: 2151682112,
            1212416: 0,
            1277952: 4198400,
            1343488: 4194368,
            1409024: 2147483648,
            1474560: 2147487808,
            1540096: 64,
            1605632: 2147483712,
            1671168: 4096,
            1736704: 2147487744,
            1802240: 2151678016,
            1867776: 4160,
            1933312: 2151682048,
            1998848: 4194304,
            2064384: 4198464
          },
          {
            0: 128,
            4096: 17039360,
            8192: 262144,
            12288: 536870912,
            16384: 537133184,
            20480: 16777344,
            24576: 553648256,
            28672: 262272,
            32768: 16777216,
            36864: 537133056,
            40960: 536871040,
            45056: 553910400,
            49152: 553910272,
            53248: 0,
            57344: 17039488,
            61440: 553648128,
            2048: 17039488,
            6144: 553648256,
            10240: 128,
            14336: 17039360,
            18432: 262144,
            22528: 537133184,
            26624: 553910272,
            30720: 536870912,
            34816: 537133056,
            38912: 0,
            43008: 553910400,
            47104: 16777344,
            51200: 536871040,
            55296: 553648128,
            59392: 16777216,
            63488: 262272,
            65536: 262144,
            69632: 128,
            73728: 536870912,
            77824: 553648256,
            81920: 16777344,
            86016: 553910272,
            90112: 537133184,
            94208: 16777216,
            98304: 553910400,
            102400: 553648128,
            106496: 17039360,
            110592: 537133056,
            114688: 262272,
            118784: 536871040,
            122880: 0,
            126976: 17039488,
            67584: 553648256,
            71680: 16777216,
            75776: 17039360,
            79872: 537133184,
            83968: 536870912,
            88064: 17039488,
            92160: 128,
            96256: 553910272,
            100352: 262272,
            104448: 553910400,
            108544: 0,
            112640: 553648128,
            116736: 16777344,
            120832: 262144,
            124928: 537133056,
            129024: 536871040
          },
          {
            0: 268435464,
            256: 8192,
            512: 270532608,
            768: 270540808,
            1024: 268443648,
            1280: 2097152,
            1536: 2097160,
            1792: 268435456,
            2048: 0,
            2304: 268443656,
            2560: 2105344,
            2816: 8,
            3072: 270532616,
            3328: 2105352,
            3584: 8200,
            3840: 270540800,
            128: 270532608,
            384: 270540808,
            640: 8,
            896: 2097152,
            1152: 2105352,
            1408: 268435464,
            1664: 268443648,
            1920: 8200,
            2176: 2097160,
            2432: 8192,
            2688: 268443656,
            2944: 270532616,
            3200: 0,
            3456: 270540800,
            3712: 2105344,
            3968: 268435456,
            4096: 268443648,
            4352: 270532616,
            4608: 270540808,
            4864: 8200,
            5120: 2097152,
            5376: 268435456,
            5632: 268435464,
            5888: 2105344,
            6144: 2105352,
            6400: 0,
            6656: 8,
            6912: 270532608,
            7168: 8192,
            7424: 268443656,
            7680: 270540800,
            7936: 2097160,
            4224: 8,
            4480: 2105344,
            4736: 2097152,
            4992: 268435464,
            5248: 268443648,
            5504: 8200,
            5760: 270540808,
            6016: 270532608,
            6272: 270540800,
            6528: 270532616,
            6784: 8192,
            7040: 2105352,
            7296: 2097160,
            7552: 0,
            7808: 268435456,
            8064: 268443656
          },
          {
            0: 1048576,
            16: 33555457,
            32: 1024,
            48: 1049601,
            64: 34604033,
            80: 0,
            96: 1,
            112: 34603009,
            128: 33555456,
            144: 1048577,
            160: 33554433,
            176: 34604032,
            192: 34603008,
            208: 1025,
            224: 1049600,
            240: 33554432,
            8: 34603009,
            24: 0,
            40: 33555457,
            56: 34604032,
            72: 1048576,
            88: 33554433,
            104: 33554432,
            120: 1025,
            136: 1049601,
            152: 33555456,
            168: 34603008,
            184: 1048577,
            200: 1024,
            216: 34604033,
            232: 1,
            248: 1049600,
            256: 33554432,
            272: 1048576,
            288: 33555457,
            304: 34603009,
            320: 1048577,
            336: 33555456,
            352: 34604032,
            368: 1049601,
            384: 1025,
            400: 34604033,
            416: 1049600,
            432: 1,
            448: 0,
            464: 34603008,
            480: 33554433,
            496: 1024,
            264: 1049600,
            280: 33555457,
            296: 34603009,
            312: 1,
            328: 33554432,
            344: 1048576,
            360: 1025,
            376: 34604032,
            392: 33554433,
            408: 34603008,
            424: 0,
            440: 34604033,
            456: 1049601,
            472: 1024,
            488: 33555456,
            504: 1048577
          },
          {
            0: 134219808,
            1: 131072,
            2: 134217728,
            3: 32,
            4: 131104,
            5: 134350880,
            6: 134350848,
            7: 2048,
            8: 134348800,
            9: 134219776,
            10: 133120,
            11: 134348832,
            12: 2080,
            13: 0,
            14: 134217760,
            15: 133152,
            2147483648: 2048,
            2147483649: 134350880,
            2147483650: 134219808,
            2147483651: 134217728,
            2147483652: 134348800,
            2147483653: 133120,
            2147483654: 133152,
            2147483655: 32,
            2147483656: 134217760,
            2147483657: 2080,
            2147483658: 131104,
            2147483659: 134350848,
            2147483660: 0,
            2147483661: 134348832,
            2147483662: 134219776,
            2147483663: 131072,
            16: 133152,
            17: 134350848,
            18: 32,
            19: 2048,
            20: 134219776,
            21: 134217760,
            22: 134348832,
            23: 131072,
            24: 0,
            25: 131104,
            26: 134348800,
            27: 134219808,
            28: 134350880,
            29: 133120,
            30: 2080,
            31: 134217728,
            2147483664: 131072,
            2147483665: 2048,
            2147483666: 134348832,
            2147483667: 133152,
            2147483668: 32,
            2147483669: 134348800,
            2147483670: 134217728,
            2147483671: 134219808,
            2147483672: 134350880,
            2147483673: 134217760,
            2147483674: 134219776,
            2147483675: 0,
            2147483676: 133120,
            2147483677: 2080,
            2147483678: 131104,
            2147483679: 134350848
          }
        ];
        var SBOX_MASK = [
          4160749569,
          528482304,
          33030144,
          2064384,
          129024,
          8064,
          504,
          2147483679
        ];
        var DES = C_algo.DES = BlockCipher.extend({
          _doReset: function() {
            var key = this._key;
            var keyWords = key.words;
            var keyBits = [];
            for (var i = 0; i < 56; i++) {
              var keyBitPos = PC1[i] - 1;
              keyBits[i] = keyWords[keyBitPos >>> 5] >>> 31 - keyBitPos % 32 & 1;
            }
            var subKeys = this._subKeys = [];
            for (var nSubKey = 0; nSubKey < 16; nSubKey++) {
              var subKey = subKeys[nSubKey] = [];
              var bitShift = BIT_SHIFTS[nSubKey];
              for (var i = 0; i < 24; i++) {
                subKey[i / 6 | 0] |= keyBits[(PC2[i] - 1 + bitShift) % 28] << 31 - i % 6;
                subKey[4 + (i / 6 | 0)] |= keyBits[28 + (PC2[i + 24] - 1 + bitShift) % 28] << 31 - i % 6;
              }
              subKey[0] = subKey[0] << 1 | subKey[0] >>> 31;
              for (var i = 1; i < 7; i++) {
                subKey[i] = subKey[i] >>> (i - 1) * 4 + 3;
              }
              subKey[7] = subKey[7] << 5 | subKey[7] >>> 27;
            }
            var invSubKeys = this._invSubKeys = [];
            for (var i = 0; i < 16; i++) {
              invSubKeys[i] = subKeys[15 - i];
            }
          },
          encryptBlock: function(M, offset) {
            this._doCryptBlock(M, offset, this._subKeys);
          },
          decryptBlock: function(M, offset) {
            this._doCryptBlock(M, offset, this._invSubKeys);
          },
          _doCryptBlock: function(M, offset, subKeys) {
            this._lBlock = M[offset];
            this._rBlock = M[offset + 1];
            exchangeLR.call(this, 4, 252645135);
            exchangeLR.call(this, 16, 65535);
            exchangeRL.call(this, 2, 858993459);
            exchangeRL.call(this, 8, 16711935);
            exchangeLR.call(this, 1, 1431655765);
            for (var round = 0; round < 16; round++) {
              var subKey = subKeys[round];
              var lBlock = this._lBlock;
              var rBlock = this._rBlock;
              var f = 0;
              for (var i = 0; i < 8; i++) {
                f |= SBOX_P[i][((rBlock ^ subKey[i]) & SBOX_MASK[i]) >>> 0];
              }
              this._lBlock = rBlock;
              this._rBlock = lBlock ^ f;
            }
            var t = this._lBlock;
            this._lBlock = this._rBlock;
            this._rBlock = t;
            exchangeLR.call(this, 1, 1431655765);
            exchangeRL.call(this, 8, 16711935);
            exchangeRL.call(this, 2, 858993459);
            exchangeLR.call(this, 16, 65535);
            exchangeLR.call(this, 4, 252645135);
            M[offset] = this._lBlock;
            M[offset + 1] = this._rBlock;
          },
          keySize: 64 / 32,
          ivSize: 64 / 32,
          blockSize: 64 / 32
        });
        function exchangeLR(offset, mask) {
          var t = (this._lBlock >>> offset ^ this._rBlock) & mask;
          this._rBlock ^= t;
          this._lBlock ^= t << offset;
        }
        function exchangeRL(offset, mask) {
          var t = (this._rBlock >>> offset ^ this._lBlock) & mask;
          this._lBlock ^= t;
          this._rBlock ^= t << offset;
        }
        C.DES = BlockCipher._createHelper(DES);
        var TripleDES = C_algo.TripleDES = BlockCipher.extend({
          _doReset: function() {
            var key = this._key;
            var keyWords = key.words;
            if (keyWords.length !== 2 && keyWords.length !== 4 && keyWords.length < 6) {
              throw new Error("Invalid key length - 3DES requires the key length to be 64, 128, 192 or >192.");
            }
            var key1 = keyWords.slice(0, 2);
            var key2 = keyWords.length < 4 ? keyWords.slice(0, 2) : keyWords.slice(2, 4);
            var key3 = keyWords.length < 6 ? keyWords.slice(0, 2) : keyWords.slice(4, 6);
            this._des1 = DES.createEncryptor(WordArray.create(key1));
            this._des2 = DES.createEncryptor(WordArray.create(key2));
            this._des3 = DES.createEncryptor(WordArray.create(key3));
          },
          encryptBlock: function(M, offset) {
            this._des1.encryptBlock(M, offset);
            this._des2.decryptBlock(M, offset);
            this._des3.encryptBlock(M, offset);
          },
          decryptBlock: function(M, offset) {
            this._des3.decryptBlock(M, offset);
            this._des2.encryptBlock(M, offset);
            this._des1.decryptBlock(M, offset);
          },
          keySize: 192 / 32,
          ivSize: 64 / 32,
          blockSize: 64 / 32
        });
        C.TripleDES = BlockCipher._createHelper(TripleDES);
      })();
      return CryptoJS.TripleDES;
    });
  }
});

// node_modules/crypto-js/rc4.js
var require_rc4 = __commonJS({
  "node_modules/crypto-js/rc4.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./enc-base64", "./md5", "./evpkdf", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var StreamCipher = C_lib.StreamCipher;
        var C_algo = C.algo;
        var RC4 = C_algo.RC4 = StreamCipher.extend({
          _doReset: function() {
            var key = this._key;
            var keyWords = key.words;
            var keySigBytes = key.sigBytes;
            var S = this._S = [];
            for (var i = 0; i < 256; i++) {
              S[i] = i;
            }
            for (var i = 0, j = 0; i < 256; i++) {
              var keyByteIndex = i % keySigBytes;
              var keyByte = keyWords[keyByteIndex >>> 2] >>> 24 - keyByteIndex % 4 * 8 & 255;
              j = (j + S[i] + keyByte) % 256;
              var t = S[i];
              S[i] = S[j];
              S[j] = t;
            }
            this._i = this._j = 0;
          },
          _doProcessBlock: function(M, offset) {
            M[offset] ^= generateKeystreamWord.call(this);
          },
          keySize: 256 / 32,
          ivSize: 0
        });
        function generateKeystreamWord() {
          var S = this._S;
          var i = this._i;
          var j = this._j;
          var keystreamWord = 0;
          for (var n = 0; n < 4; n++) {
            i = (i + 1) % 256;
            j = (j + S[i]) % 256;
            var t = S[i];
            S[i] = S[j];
            S[j] = t;
            keystreamWord |= S[(S[i] + S[j]) % 256] << 24 - n * 8;
          }
          this._i = i;
          this._j = j;
          return keystreamWord;
        }
        C.RC4 = StreamCipher._createHelper(RC4);
        var RC4Drop = C_algo.RC4Drop = RC4.extend({
          /**
           * Configuration options.
           *
           * @property {number} drop The number of keystream words to drop. Default 192
           */
          cfg: RC4.cfg.extend({
            drop: 192
          }),
          _doReset: function() {
            RC4._doReset.call(this);
            for (var i = this.cfg.drop; i > 0; i--) {
              generateKeystreamWord.call(this);
            }
          }
        });
        C.RC4Drop = StreamCipher._createHelper(RC4Drop);
      })();
      return CryptoJS.RC4;
    });
  }
});

// node_modules/crypto-js/rabbit.js
var require_rabbit = __commonJS({
  "node_modules/crypto-js/rabbit.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./enc-base64", "./md5", "./evpkdf", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var StreamCipher = C_lib.StreamCipher;
        var C_algo = C.algo;
        var S = [];
        var C_ = [];
        var G = [];
        var Rabbit = C_algo.Rabbit = StreamCipher.extend({
          _doReset: function() {
            var K = this._key.words;
            var iv = this.cfg.iv;
            for (var i = 0; i < 4; i++) {
              K[i] = (K[i] << 8 | K[i] >>> 24) & 16711935 | (K[i] << 24 | K[i] >>> 8) & 4278255360;
            }
            var X = this._X = [
              K[0],
              K[3] << 16 | K[2] >>> 16,
              K[1],
              K[0] << 16 | K[3] >>> 16,
              K[2],
              K[1] << 16 | K[0] >>> 16,
              K[3],
              K[2] << 16 | K[1] >>> 16
            ];
            var C2 = this._C = [
              K[2] << 16 | K[2] >>> 16,
              K[0] & 4294901760 | K[1] & 65535,
              K[3] << 16 | K[3] >>> 16,
              K[1] & 4294901760 | K[2] & 65535,
              K[0] << 16 | K[0] >>> 16,
              K[2] & 4294901760 | K[3] & 65535,
              K[1] << 16 | K[1] >>> 16,
              K[3] & 4294901760 | K[0] & 65535
            ];
            this._b = 0;
            for (var i = 0; i < 4; i++) {
              nextState.call(this);
            }
            for (var i = 0; i < 8; i++) {
              C2[i] ^= X[i + 4 & 7];
            }
            if (iv) {
              var IV = iv.words;
              var IV_0 = IV[0];
              var IV_1 = IV[1];
              var i0 = (IV_0 << 8 | IV_0 >>> 24) & 16711935 | (IV_0 << 24 | IV_0 >>> 8) & 4278255360;
              var i2 = (IV_1 << 8 | IV_1 >>> 24) & 16711935 | (IV_1 << 24 | IV_1 >>> 8) & 4278255360;
              var i1 = i0 >>> 16 | i2 & 4294901760;
              var i3 = i2 << 16 | i0 & 65535;
              C2[0] ^= i0;
              C2[1] ^= i1;
              C2[2] ^= i2;
              C2[3] ^= i3;
              C2[4] ^= i0;
              C2[5] ^= i1;
              C2[6] ^= i2;
              C2[7] ^= i3;
              for (var i = 0; i < 4; i++) {
                nextState.call(this);
              }
            }
          },
          _doProcessBlock: function(M, offset) {
            var X = this._X;
            nextState.call(this);
            S[0] = X[0] ^ X[5] >>> 16 ^ X[3] << 16;
            S[1] = X[2] ^ X[7] >>> 16 ^ X[5] << 16;
            S[2] = X[4] ^ X[1] >>> 16 ^ X[7] << 16;
            S[3] = X[6] ^ X[3] >>> 16 ^ X[1] << 16;
            for (var i = 0; i < 4; i++) {
              S[i] = (S[i] << 8 | S[i] >>> 24) & 16711935 | (S[i] << 24 | S[i] >>> 8) & 4278255360;
              M[offset + i] ^= S[i];
            }
          },
          blockSize: 128 / 32,
          ivSize: 64 / 32
        });
        function nextState() {
          var X = this._X;
          var C2 = this._C;
          for (var i = 0; i < 8; i++) {
            C_[i] = C2[i];
          }
          C2[0] = C2[0] + 1295307597 + this._b | 0;
          C2[1] = C2[1] + 3545052371 + (C2[0] >>> 0 < C_[0] >>> 0 ? 1 : 0) | 0;
          C2[2] = C2[2] + 886263092 + (C2[1] >>> 0 < C_[1] >>> 0 ? 1 : 0) | 0;
          C2[3] = C2[3] + 1295307597 + (C2[2] >>> 0 < C_[2] >>> 0 ? 1 : 0) | 0;
          C2[4] = C2[4] + 3545052371 + (C2[3] >>> 0 < C_[3] >>> 0 ? 1 : 0) | 0;
          C2[5] = C2[5] + 886263092 + (C2[4] >>> 0 < C_[4] >>> 0 ? 1 : 0) | 0;
          C2[6] = C2[6] + 1295307597 + (C2[5] >>> 0 < C_[5] >>> 0 ? 1 : 0) | 0;
          C2[7] = C2[7] + 3545052371 + (C2[6] >>> 0 < C_[6] >>> 0 ? 1 : 0) | 0;
          this._b = C2[7] >>> 0 < C_[7] >>> 0 ? 1 : 0;
          for (var i = 0; i < 8; i++) {
            var gx = X[i] + C2[i];
            var ga = gx & 65535;
            var gb = gx >>> 16;
            var gh = ((ga * ga >>> 17) + ga * gb >>> 15) + gb * gb;
            var gl = ((gx & 4294901760) * gx | 0) + ((gx & 65535) * gx | 0);
            G[i] = gh ^ gl;
          }
          X[0] = G[0] + (G[7] << 16 | G[7] >>> 16) + (G[6] << 16 | G[6] >>> 16) | 0;
          X[1] = G[1] + (G[0] << 8 | G[0] >>> 24) + G[7] | 0;
          X[2] = G[2] + (G[1] << 16 | G[1] >>> 16) + (G[0] << 16 | G[0] >>> 16) | 0;
          X[3] = G[3] + (G[2] << 8 | G[2] >>> 24) + G[1] | 0;
          X[4] = G[4] + (G[3] << 16 | G[3] >>> 16) + (G[2] << 16 | G[2] >>> 16) | 0;
          X[5] = G[5] + (G[4] << 8 | G[4] >>> 24) + G[3] | 0;
          X[6] = G[6] + (G[5] << 16 | G[5] >>> 16) + (G[4] << 16 | G[4] >>> 16) | 0;
          X[7] = G[7] + (G[6] << 8 | G[6] >>> 24) + G[5] | 0;
        }
        C.Rabbit = StreamCipher._createHelper(Rabbit);
      })();
      return CryptoJS.Rabbit;
    });
  }
});

// node_modules/crypto-js/rabbit-legacy.js
var require_rabbit_legacy = __commonJS({
  "node_modules/crypto-js/rabbit-legacy.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./enc-base64", "./md5", "./evpkdf", "./cipher-core"], factory);
      } else {
        factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      (function() {
        var C = CryptoJS;
        var C_lib = C.lib;
        var StreamCipher = C_lib.StreamCipher;
        var C_algo = C.algo;
        var S = [];
        var C_ = [];
        var G = [];
        var RabbitLegacy = C_algo.RabbitLegacy = StreamCipher.extend({
          _doReset: function() {
            var K = this._key.words;
            var iv = this.cfg.iv;
            var X = this._X = [
              K[0],
              K[3] << 16 | K[2] >>> 16,
              K[1],
              K[0] << 16 | K[3] >>> 16,
              K[2],
              K[1] << 16 | K[0] >>> 16,
              K[3],
              K[2] << 16 | K[1] >>> 16
            ];
            var C2 = this._C = [
              K[2] << 16 | K[2] >>> 16,
              K[0] & 4294901760 | K[1] & 65535,
              K[3] << 16 | K[3] >>> 16,
              K[1] & 4294901760 | K[2] & 65535,
              K[0] << 16 | K[0] >>> 16,
              K[2] & 4294901760 | K[3] & 65535,
              K[1] << 16 | K[1] >>> 16,
              K[3] & 4294901760 | K[0] & 65535
            ];
            this._b = 0;
            for (var i = 0; i < 4; i++) {
              nextState.call(this);
            }
            for (var i = 0; i < 8; i++) {
              C2[i] ^= X[i + 4 & 7];
            }
            if (iv) {
              var IV = iv.words;
              var IV_0 = IV[0];
              var IV_1 = IV[1];
              var i0 = (IV_0 << 8 | IV_0 >>> 24) & 16711935 | (IV_0 << 24 | IV_0 >>> 8) & 4278255360;
              var i2 = (IV_1 << 8 | IV_1 >>> 24) & 16711935 | (IV_1 << 24 | IV_1 >>> 8) & 4278255360;
              var i1 = i0 >>> 16 | i2 & 4294901760;
              var i3 = i2 << 16 | i0 & 65535;
              C2[0] ^= i0;
              C2[1] ^= i1;
              C2[2] ^= i2;
              C2[3] ^= i3;
              C2[4] ^= i0;
              C2[5] ^= i1;
              C2[6] ^= i2;
              C2[7] ^= i3;
              for (var i = 0; i < 4; i++) {
                nextState.call(this);
              }
            }
          },
          _doProcessBlock: function(M, offset) {
            var X = this._X;
            nextState.call(this);
            S[0] = X[0] ^ X[5] >>> 16 ^ X[3] << 16;
            S[1] = X[2] ^ X[7] >>> 16 ^ X[5] << 16;
            S[2] = X[4] ^ X[1] >>> 16 ^ X[7] << 16;
            S[3] = X[6] ^ X[3] >>> 16 ^ X[1] << 16;
            for (var i = 0; i < 4; i++) {
              S[i] = (S[i] << 8 | S[i] >>> 24) & 16711935 | (S[i] << 24 | S[i] >>> 8) & 4278255360;
              M[offset + i] ^= S[i];
            }
          },
          blockSize: 128 / 32,
          ivSize: 64 / 32
        });
        function nextState() {
          var X = this._X;
          var C2 = this._C;
          for (var i = 0; i < 8; i++) {
            C_[i] = C2[i];
          }
          C2[0] = C2[0] + 1295307597 + this._b | 0;
          C2[1] = C2[1] + 3545052371 + (C2[0] >>> 0 < C_[0] >>> 0 ? 1 : 0) | 0;
          C2[2] = C2[2] + 886263092 + (C2[1] >>> 0 < C_[1] >>> 0 ? 1 : 0) | 0;
          C2[3] = C2[3] + 1295307597 + (C2[2] >>> 0 < C_[2] >>> 0 ? 1 : 0) | 0;
          C2[4] = C2[4] + 3545052371 + (C2[3] >>> 0 < C_[3] >>> 0 ? 1 : 0) | 0;
          C2[5] = C2[5] + 886263092 + (C2[4] >>> 0 < C_[4] >>> 0 ? 1 : 0) | 0;
          C2[6] = C2[6] + 1295307597 + (C2[5] >>> 0 < C_[5] >>> 0 ? 1 : 0) | 0;
          C2[7] = C2[7] + 3545052371 + (C2[6] >>> 0 < C_[6] >>> 0 ? 1 : 0) | 0;
          this._b = C2[7] >>> 0 < C_[7] >>> 0 ? 1 : 0;
          for (var i = 0; i < 8; i++) {
            var gx = X[i] + C2[i];
            var ga = gx & 65535;
            var gb = gx >>> 16;
            var gh = ((ga * ga >>> 17) + ga * gb >>> 15) + gb * gb;
            var gl = ((gx & 4294901760) * gx | 0) + ((gx & 65535) * gx | 0);
            G[i] = gh ^ gl;
          }
          X[0] = G[0] + (G[7] << 16 | G[7] >>> 16) + (G[6] << 16 | G[6] >>> 16) | 0;
          X[1] = G[1] + (G[0] << 8 | G[0] >>> 24) + G[7] | 0;
          X[2] = G[2] + (G[1] << 16 | G[1] >>> 16) + (G[0] << 16 | G[0] >>> 16) | 0;
          X[3] = G[3] + (G[2] << 8 | G[2] >>> 24) + G[1] | 0;
          X[4] = G[4] + (G[3] << 16 | G[3] >>> 16) + (G[2] << 16 | G[2] >>> 16) | 0;
          X[5] = G[5] + (G[4] << 8 | G[4] >>> 24) + G[3] | 0;
          X[6] = G[6] + (G[5] << 16 | G[5] >>> 16) + (G[4] << 16 | G[4] >>> 16) | 0;
          X[7] = G[7] + (G[6] << 8 | G[6] >>> 24) + G[5] | 0;
        }
        C.RabbitLegacy = StreamCipher._createHelper(RabbitLegacy);
      })();
      return CryptoJS.RabbitLegacy;
    });
  }
});

// node_modules/crypto-js/index.js
var require_crypto_js = __commonJS({
  "node_modules/crypto-js/index.js"(exports2, module2) {
    (function(root, factory, undef) {
      if (typeof exports2 === "object") {
        module2.exports = exports2 = factory(require_core(), require_x64_core(), require_lib_typedarrays(), require_enc_utf16(), require_enc_base64(), require_enc_base64url(), require_md5(), require_sha1(), require_sha256(), require_sha224(), require_sha512(), require_sha384(), require_sha3(), require_ripemd160(), require_hmac(), require_pbkdf2(), require_evpkdf(), require_cipher_core(), require_mode_cfb(), require_mode_ctr(), require_mode_ctr_gladman(), require_mode_ofb(), require_mode_ecb(), require_pad_ansix923(), require_pad_iso10126(), require_pad_iso97971(), require_pad_zeropadding(), require_pad_nopadding(), require_format_hex(), require_aes(), require_tripledes(), require_rc4(), require_rabbit(), require_rabbit_legacy());
      } else if (typeof define === "function" && define.amd) {
        define(["./core", "./x64-core", "./lib-typedarrays", "./enc-utf16", "./enc-base64", "./enc-base64url", "./md5", "./sha1", "./sha256", "./sha224", "./sha512", "./sha384", "./sha3", "./ripemd160", "./hmac", "./pbkdf2", "./evpkdf", "./cipher-core", "./mode-cfb", "./mode-ctr", "./mode-ctr-gladman", "./mode-ofb", "./mode-ecb", "./pad-ansix923", "./pad-iso10126", "./pad-iso97971", "./pad-zeropadding", "./pad-nopadding", "./format-hex", "./aes", "./tripledes", "./rc4", "./rabbit", "./rabbit-legacy"], factory);
      } else {
        root.CryptoJS = factory(root.CryptoJS);
      }
    })(exports2, function(CryptoJS) {
      return CryptoJS;
    });
  }
});

// src/vendor/musicSdk/bd/songList.js
var require_songList6 = __commonJS({
  "src/vendor/musicSdk/bd/songList.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    var crypto_js_1 = __importDefault(require_crypto_js());
    exports2.default = {
      _requestObj_tags: null,
      _requestObj_list: null,
      _requestObj_listRecommend: null,
      limit_list: 30,
      limit_song: 1e4,
      successCode: 22e3,
      sortList: [
        {
          name: "最热",
          id: "1"
        },
        {
          name: "最新",
          id: "0"
        }
      ],
      regExps: {
        // http://music.taihe.com/songlist/566347741
        listDetailLink: /^.+\/songlist\/(\d+)(?:\?.*|&.*$|#.*$|$)/
      },
      aesPassEncod(jsonData) {
        let timestamp = Math.floor(Date.now() / 1e3);
        let privateKey = (0, index_1.toMD5)("baidu_taihe_music_secret_key" + timestamp).substr(8, 16);
        let key = crypto_js_1.default.enc.Utf8.parse(privateKey);
        let iv = crypto_js_1.default.enc.Utf8.parse(privateKey);
        let arrData = [];
        let strData = "";
        for (let key2 in jsonData)
          arrData.push(key2);
        arrData.sort();
        for (let i = 0; i < arrData.length; i++) {
          let key2 = arrData[i];
          strData += (i === 0 ? "" : "&") + key2 + "=" + encodeURIComponent(jsonData[key2]);
        }
        let JsonFormatter = {
          stringify(cipherParams) {
            let jsonObj = {
              ct: cipherParams.ciphertext.toString(crypto_js_1.default.enc.Base64)
            };
            if (cipherParams.iv) {
              jsonObj.iv = cipherParams.iv.toString();
            }
            if (cipherParams.salt) {
              jsonObj.s = cipherParams.salt.toString();
            }
            return jsonObj;
          },
          parse(jsonStr) {
            let jsonObj = JSON.parse(jsonStr);
            let cipherParams = crypto_js_1.default.lib.CipherParams.create({
              ciphertext: crypto_js_1.default.enc.Base64.parse(jsonObj.ct)
            });
            if (jsonObj.iv) {
              cipherParams.iv = crypto_js_1.default.enc.Hex.parse(jsonObj.iv);
            }
            if (jsonObj.s) {
              cipherParams.salt = crypto_js_1.default.enc.Hex.parse(jsonObj.s);
            }
            return cipherParams;
          }
        };
        let encrypted = crypto_js_1.default.AES.encrypt(strData, key, {
          iv,
          blockSize: 16,
          mode: crypto_js_1.default.mode.CBC,
          format: JsonFormatter
        });
        let ciphertext = encrypted.toString().ct;
        let sign = (0, index_1.toMD5)("baidu_taihe_music" + ciphertext + timestamp);
        let jsonRet = {
          timestamp,
          param: ciphertext,
          sign
        };
        return jsonRet;
      },
      createUrl(param, method) {
        let data = this.aesPassEncod(param);
        return `http://musicmini.qianqian.com/v1/restserver/ting?method=${method}&time=${Date.now()}&timestamp=${data.timestamp}&param=${data.param}&sign=${data.sign}`;
      },
      getTagsUrl() {
        return this.createUrl({
          from: "qianqianmini",
          type: "diy",
          version: "10.1.8"
        }, "baidu.ting.ugcdiy.getChannels");
      },
      getListUrl(sortType, tagName, page) {
        return this.createUrl({
          channelname: tagName || "全部",
          from: "qianqianmini",
          offset: (page - 1) * this.limit_list,
          order_type: sortType,
          size: this.limit_list,
          version: "10.1.8"
        }, "baidu.ting.ugcdiy.getChanneldiy");
      },
      getListDetailUrl(list_id, page) {
        return this.createUrl({
          list_id,
          offset: (page - 1) * this.limit_song,
          size: this.limit_song,
          withcount: "1",
          withsong: "1"
        }, "baidu.ting.ugcdiy.getBaseInfo");
      },
      // 获取标签
      getTags(tryNum = 0) {
        if (this._requestObj_tags)
          this._requestObj_tags.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_tags = (0, request_1.httpFetch)(this.getTagsUrl());
        return this._requestObj_tags.promise.then(({ body }) => {
          if (body.error_code !== this.successCode)
            return this.getTags(++tryNum);
          return {
            hotTag: this.filterInfoHotTag(body.result.hot),
            tags: this.filterTagInfo(body.result.tags),
            source: "bd"
          };
        });
      },
      filterInfoHotTag(rawList) {
        return rawList.map((item) => ({
          name: item,
          id: item,
          source: "bd"
        }));
      },
      filterTagInfo(rawList) {
        return rawList.map((type) => ({
          name: type.first,
          list: type.second.map((item) => ({
            parent_id: type.first,
            parent_name: type.first,
            id: item,
            name: item,
            source: "bd"
          }))
        }));
      },
      // 获取列表数据
      getList(sortId, tagId, page, tryNum = 0) {
        if (this._requestObj_list)
          this._requestObj_list.cancelHttp();
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        this._requestObj_list = (0, request_1.httpFetch)(this.getListUrl(sortId, tagId, page));
        return this._requestObj_list.promise.then(({ body }) => {
          if (body.error_code !== this.successCode)
            return this.getList(sortId, tagId, page, ++tryNum);
          return {
            list: this.filterList(body.diyInfo),
            total: body.nums,
            page,
            limit: this.limit_list,
            source: "bd"
          };
        });
      },
      /**
       * 格式化播放数量
       * @param {*} num
       */
      formatPlayCount(num) {
        if (num > 1e8)
          return parseInt(num / 1e7) / 10 + "亿";
        if (num > 1e4)
          return parseInt(num / 1e3) / 10 + "万";
        return num;
      },
      filterList(rawData) {
        return rawData.map((item) => ({
          play_count: this.formatPlayCount(item.listen_num),
          id: String(item.list_id),
          author: item.username,
          name: item.title,
          // time: item.publish_time,
          img: item.list_pic_large || item.list_pic,
          grade: item.grade,
          desc: item.desc || item.tag,
          source: "bd"
        }));
      },
      // 获取歌曲列表内的音乐
      getListDetail(id, page, tryNum = 0) {
        if (tryNum > 2)
          return Promise.reject(new Error("try max num"));
        if (/[?&:/]/.test(id))
          id = id.replace(this.regExps.listDetailLink, "$1");
        const requestObj_listDetail = (0, request_1.httpFetch)(this.getListDetailUrl(id, page));
        return requestObj_listDetail.promise.then(({ body }) => {
          if (body.error_code !== this.successCode)
            return this.getListDetail(id, page, ++tryNum);
          let listData = this.filterData(body.result.songlist);
          return {
            list: listData,
            page,
            limit: this.limit_song,
            total: body.result.song_num,
            source: "bd",
            info: {
              name: body.result.info.list_title,
              img: body.result.info.list_pic,
              desc: body.result.info.list_desc,
              author: body.result.info.userinfo.username,
              play_count: this.formatPlayCount(body.result.listen_num)
            }
          };
        });
      },
      filterData(rawList) {
        return rawList.map((item) => {
          const types = [];
          const _types = {};
          let size = null;
          let itemTypes = item.all_rate.split(",");
          if (itemTypes.includes("128")) {
            types.push({ type: "128k", size });
            _types["128k"] = {
              size
            };
          }
          if (itemTypes.includes("320")) {
            types.push({ type: "320k", size });
            _types["320k"] = {
              size
            };
          }
          if (itemTypes.includes("flac")) {
            types.push({ type: "flac", size });
            _types.flac = {
              size
            };
          }
          return {
            singer: item.author.replace(",", "、"),
            name: item.title,
            albumName: item.album_title,
            albumId: item.album_id,
            source: "bd",
            interval: (0, index_1.formatPlayTime)(parseInt(item.file_duration)),
            songmid: item.song_id,
            img: item.pic_s500,
            lrc: null,
            types,
            _types,
            typeUrl: {}
          };
        });
      }
    };
  }
});

// src/vendor/musicSdk/bd/musicSearch.js
var require_musicSearch6 = __commonJS({
  "src/vendor/musicSdk/bd/musicSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    var index_1 = require_vendor();
    exports2.default = {
      limit: 30,
      total: 0,
      page: 0,
      allPage: 1,
      musicSearch(str, page, limit) {
        const searchRequest = (0, request_1.httpFetch)(`http://tingapi.ting.baidu.com/v1/restserver/ting?from=android&version=5.6.5.6&method=baidu.ting.search.merge&format=json&query=${encodeURIComponent(str)}&page_no=${page}&page_size=${limit}&type=0&data_source=0&use_cluster=1`);
        return searchRequest.promise.then(({ body }) => body);
      },
      handleResult(rawData) {
        let ids = /* @__PURE__ */ new Set();
        const list = [];
        if (!rawData)
          return list;
        rawData.forEach((item) => {
          if (ids.has(item.song_id))
            return;
          ids.add(item.song_id);
          const types = [];
          const _types = {};
          let size = null;
          let itemTypes = item.all_rate.split(",");
          if (itemTypes.includes("128")) {
            types.push({ type: "128k", size });
            _types["128k"] = {
              size
            };
          }
          if (itemTypes.includes("320")) {
            types.push({ type: "320k", size });
            _types["320k"] = {
              size
            };
          }
          if (itemTypes.includes("flac")) {
            types.push({ type: "flac", size });
            _types.flac = {
              size
            };
          }
          list.push({
            singer: item.author.replace(",", "、"),
            name: item.title,
            albumName: item.album_title,
            albumId: item.album_id,
            source: "bd",
            interval: (0, index_1.formatPlayTime)(parseInt(item.file_duration)),
            songmid: item.song_id,
            img: null,
            lrc: null,
            types,
            _types,
            typeUrl: {}
          });
        });
        return list;
      },
      search(str, page = 1, limit, retryNum = 0) {
        if (++retryNum > 3)
          return Promise.reject(new Error("try max num"));
        if (limit == null)
          limit = this.limit;
        return this.musicSearch(str, page, limit).then((result) => {
          if (!result || result.error_code !== 22e3)
            return this.search(str, page, limit, retryNum);
          let list = this.handleResult(result.result.song_info.song_list);
          if (list == null)
            return this.search(str, page, limit, retryNum);
          this.total = result.result.song_info.total;
          this.page = page;
          this.allPage = Math.ceil(this.total / limit);
          return Promise.resolve({
            list,
            allPage: this.allPage,
            limit,
            total: this.total,
            source: "bd"
          });
        });
      }
    };
  }
});

// src/vendor/musicSdk/bd/hotSearch.js
var require_hotSearch6 = __commonJS({
  "src/vendor/musicSdk/bd/hotSearch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var request_1 = require_request();
    exports2.default = {
      _requestObj: null,
      async getList(retryNum = 0) {
        if (this._requestObj)
          this._requestObj.cancelHttp();
        if (retryNum > 2)
          return Promise.reject(new Error("try max num"));
        const _requestObj = (0, request_1.httpFetch)("http://musicapi.qianqian.com/v1/restserver/ting?from=android&version=7.0.2.0&channel=ppzs&operator=0&method=baidu.ting.search.hot", {
          method: "get",
          headers: {
            "User-Agent": "android_7.0.2.0;baiduyinyue"
          }
        });
        const { body, statusCode } = await _requestObj.promise;
        if (statusCode != 200 || body.error_code !== 22e3)
          throw new Error("获取热搜词失败");
        return { source: "bd", list: this.filterList(body.result) };
      },
      filterList(rawList) {
        return rawList.map((item) => item.word);
      }
    };
  }
});

// src/vendor/musicSdk/bd/index.js
var require_bd = __commonJS({
  "src/vendor/musicSdk/bd/index.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var leaderboard_1 = __importDefault(require_leaderboard6());
    var api_source_1 = require_api_source();
    var musicInfo_1 = __importDefault(require_musicInfo4());
    var songList_1 = __importDefault(require_songList6());
    var request_1 = require_request();
    var musicSearch_1 = __importDefault(require_musicSearch6());
    var hotSearch_1 = __importDefault(require_hotSearch6());
    var bd = {
      leaderboard: leaderboard_1.default,
      songList: songList_1.default,
      musicSearch: musicSearch_1.default,
      hotSearch: hotSearch_1.default,
      getMusicUrl(songInfo, type) {
        return (0, api_source_1.apis)("bd").getMusicUrl(songInfo, type);
      },
      getPic(songInfo) {
        const requestObj = this.getMusicInfo(songInfo);
        return requestObj.promise.then((info) => info.pic_premium);
      },
      getLyric(songInfo) {
        const requestObj = this.getMusicInfo(songInfo);
        requestObj.promise = requestObj.promise.then((info) => (0, request_1.httpFetch)(info.lrclink).promise.then((resp) => ({ lyric: resp.body, tlyric: "" })));
        return requestObj;
      },
      // getLyric(songInfo) {
      //   return apis('bd').getLyric(songInfo)
      // },
      // getPic(songInfo) {
      //   return apis('bd').getPic(songInfo)
      // },
      getMusicInfo(songInfo) {
        return musicInfo_1.default.getMusicInfo(songInfo.songmid);
      },
      getMusicDetailPageUrl(songInfo) {
        return `http://music.taihe.com/song/${songInfo.songmid}`;
      }
    };
    exports2.default = bd;
  }
});

// src/vendor/musicSdk/xm.js
var require_xm = __commonJS({
  "src/vendor/musicSdk/xm.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var xm = {
      // songList,
      // musicSearch,
      // leaderboard,
      // hotSearch,
      // closeVerifyModal,
      comment: {
        getComment() {
          return Promise.reject(new Error("fail"));
        },
        getHotComment() {
          return Promise.reject(new Error("fail"));
        }
      },
      getMusicUrl(songInfo, type) {
        return {
          promise: Promise.reject(new Error("fail"))
        };
      },
      getLyric(songInfo) {
        return {
          promise: Promise.reject(new Error("fail"))
        };
      },
      getPic(songInfo) {
        return Promise.reject(new Error("fail"));
      }
      // getMusicDetailPageUrl(songInfo) {
      //   if (songInfo.songStringId) return `https://www.xiami.com/song/${songInfo.songStringId}`
      //   musicInfo.getMusicInfo(songInfo).then(({ data }) => {
      //     songInfo.songStringId = data.songStringId
      //   })
      //   return `https://www.xiami.com/song/${songInfo.songmid}`
      // },
      // init() {
      //   getToken()
      // },
    };
    exports2.default = xm;
  }
});

// src/vendor/musicSdk/index.js
var require_musicSdk = __commonJS({
  "src/vendor/musicSdk/index.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.formatPlayCount = exports2.formatPlayTime = exports2.sizeFormate = exports2.decodeName = exports2.dateFormat2 = exports2.dateFormat = void 0;
    var index_1 = __importDefault(require_kw());
    var index_2 = __importDefault(require_kg2());
    var index_3 = __importDefault(require_tx());
    var index_4 = __importDefault(require_wy());
    var index_5 = __importDefault(require_mg());
    var index_6 = __importDefault(require_bd());
    var xm_1 = __importDefault(require_xm());
    var api_source_1 = require_api_source();
    var index_7 = require_vendor();
    Object.defineProperty(exports2, "dateFormat", { enumerable: true, get: function() {
      return index_7.dateFormat;
    } });
    Object.defineProperty(exports2, "dateFormat2", { enumerable: true, get: function() {
      return index_7.dateFormat2;
    } });
    Object.defineProperty(exports2, "decodeName", { enumerable: true, get: function() {
      return index_7.decodeName;
    } });
    Object.defineProperty(exports2, "sizeFormate", { enumerable: true, get: function() {
      return index_7.sizeFormate;
    } });
    Object.defineProperty(exports2, "formatPlayTime", { enumerable: true, get: function() {
      return index_7.formatPlayTime;
    } });
    Object.defineProperty(exports2, "formatPlayCount", { enumerable: true, get: function() {
      return index_7.formatPlayCount;
    } });
    var sources = {
      sources: [
        {
          name: "酷我音乐",
          id: "kw"
        },
        {
          name: "酷狗音乐",
          id: "kg"
        },
        {
          name: "QQ音乐",
          id: "tx"
        },
        {
          name: "网易音乐",
          id: "wy"
        },
        {
          name: "咪咕音乐",
          id: "mg"
        },
        {
          name: "虾米音乐",
          id: "xm"
        }
        // {
        //   name: '百度音乐',
        //   id: 'bd',
        // },
      ],
      kw: index_1.default,
      kg: index_2.default,
      tx: index_3.default,
      wy: index_4.default,
      mg: index_5.default,
      bd: index_6.default,
      xm: xm_1.default
    };
    exports2.default = {
      ...sources,
      init() {
        const tasks = [];
        for (let source of sources.sources) {
          let sm = sources[source.id];
          sm && sm.init && tasks.push(sm.init());
        }
        return Promise.all(tasks);
      },
      supportQuality: api_source_1.supportQuality,
      async searchMusic({ name, singer, source: s, limit = 25, page = 1 }) {
        const trimStr = (str) => typeof str == "string" ? str.trim() : str;
        const musicName = trimStr(name);
        const tasks = [];
        const excludeSource = ["xm"];
        for (const source of sources.sources) {
          if (!sources[source.id].musicSearch || source.id == s || excludeSource.includes(source.id))
            continue;
          tasks.push(sources[source.id].musicSearch.search(`${musicName} ${singer || ""}`.trim(), page, limit).catch((err) => {
            console.error(`[MusicSdk] Search error in ${source.id}:`, err);
            return null;
          }));
        }
        return (await Promise.all(tasks)).filter((s2) => s2);
      },
      async findMusic({ name, singer, albumName, interval, source: s }) {
        const lists = await this.searchMusic({ name, singer, source: s, limit: 25 });
        const singersRxp = /、|&|;|；|\/|,|，|\|/;
        const sortSingle = (singer2) => singersRxp.test(singer2) ? singer2.split(singersRxp).sort((a, b) => a.localeCompare(b)).join("、") : singer2 || "";
        const sortMusic = (arr, callback) => {
          const tempResult = [];
          for (let i = arr.length - 1; i > -1; i--) {
            const item = arr[i];
            if (callback(item)) {
              delete item.fSinger;
              delete item.fMusicName;
              delete item.fAlbumName;
              delete item.fInterval;
              tempResult.push(item);
              arr.splice(i, 1);
            }
          }
          tempResult.reverse();
          return tempResult;
        };
        const getIntv = (interval2) => {
          if (!interval2)
            return 0;
          let intvArr = interval2.split(":");
          let intv = 0;
          let unit = 1;
          while (intvArr.length) {
            intv += parseInt(intvArr.pop()) * unit;
            unit *= 60;
          }
          return intv;
        };
        const trimStr = (str) => typeof str == "string" ? str.trim() : str || "";
        const filterStr = (str) => typeof str == "string" ? str.replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, "") : String(str || "");
        const fMusicName = filterStr(name).toLowerCase();
        const fSinger = filterStr(sortSingle(singer)).toLowerCase();
        const fAlbumName = filterStr(albumName).toLowerCase();
        const fInterval = getIntv(interval);
        const isEqualsInterval = (intv) => Math.abs((fInterval || intv) - (intv || fInterval)) < 5;
        const isIncludesName = (name2) => fMusicName.includes(name2) || name2.includes(fMusicName);
        const isIncludesSinger = (singer2) => fSinger ? fSinger.includes(singer2) || singer2.includes(fSinger) : true;
        const isEqualsAlbum = (album) => fAlbumName ? fAlbumName == album : true;
        const result = lists.map((source) => {
          for (const item of source.list) {
            item.name = trimStr(item.name);
            item.singer = trimStr(item.singer);
            item.fSinger = filterStr(sortSingle(item.singer).toLowerCase());
            item.fMusicName = filterStr(String(item.name ?? "").toLowerCase());
            item.fAlbumName = filterStr(String(item.albumName ?? "").toLowerCase());
            item.fInterval = getIntv(item.interval);
            if (!isEqualsInterval(item.fInterval)) {
              item.name = null;
              continue;
            }
            if (item.fMusicName == fMusicName && isIncludesSinger(item.fSinger))
              return item;
          }
          for (const item of source.list) {
            if (item.name == null)
              continue;
            if (item.fSinger == fSinger && isIncludesName(item.fMusicName))
              return item;
          }
          for (const item of source.list) {
            if (item.name == null)
              continue;
            if (isEqualsAlbum(item.fAlbumName) && isIncludesSinger(item.fSinger) && isIncludesName(item.fMusicName))
              return item;
          }
          return null;
        }).filter((s2) => s2);
        const newResult = [];
        if (result.length) {
          newResult.push(...sortMusic(result, (item) => item.fSinger == fSinger && item.fMusicName == fMusicName && item.interval == interval));
          newResult.push(...sortMusic(result, (item) => item.fMusicName == fMusicName && item.fSinger == fSinger && item.fAlbumName == fAlbumName));
          newResult.push(...sortMusic(result, (item) => item.fSinger == fSinger && item.fMusicName == fMusicName));
          newResult.push(...sortMusic(result, (item) => item.fMusicName == fMusicName && item.interval == interval));
          newResult.push(...sortMusic(result, (item) => item.fSinger == fSinger && item.interval == interval));
          newResult.push(...sortMusic(result, (item) => item.interval == interval));
          newResult.push(...sortMusic(result, (item) => item.fMusicName == fMusicName));
          newResult.push(...sortMusic(result, (item) => item.fSinger == fSinger));
          newResult.push(...sortMusic(result, (item) => item.fAlbumName == fAlbumName));
          for (const item of result) {
            delete item.fSinger;
            delete item.fMusicName;
            delete item.fAlbumName;
            delete item.fInterval;
          }
          newResult.push(...result);
        }
        return newResult;
      }
    };
  }
});

// src/catalog/index.js
var require_catalog = __commonJS({
  "src/catalog/index.js"(exports2, module2) {
    "use strict";
    var musicSdk = require_musicSdk().default;
    var NAMES = { kw: "酷我", kg: "酷狗", tx: "QQ", wy: "网易云", mg: "咪咕", bd: "百度", xm: "小咪" };
    var IDS = Object.keys(NAMES).filter((id) => musicSdk[id] && musicSdk[id].musicSearch);
    async function search(platform, wd, page) {
      const mod = musicSdk[platform];
      if (!mod || !mod.musicSearch)
        return [];
      const result = await mod.musicSearch.search(wd, page, 20);
      return (result && result.list || []).filter((s) => s && s.songmid).map((s) => ({
        platform,
        name: s.name + " - " + (s.singer || ""),
        pic: s.img || "",
        musicInfo: s
      }));
    }
    async function searchAll(wd, page) {
      const settled = await Promise.allSettled(IDS.map(async (id) => ({ id, songs: await search(id, wd, page) })));
      const perPlatform = settled.map((s) => s.status === "fulfilled" ? s.value.songs : []);
      const merged = [];
      for (let i = 0; i < 20; i++)
        for (const songs of perPlatform)
          if (songs[i])
            merged.push(songs[i]);
      return merged;
    }
    async function unwrapVendor(v, depth = 4) {
      for (let i = 0; i < depth; i++) {
        if (v && typeof v === "object" && typeof v.then === "function") {
          v = await v;
          continue;
        }
        if (v && typeof v === "object" && typeof v.promise !== "undefined") {
          v = await v.promise;
          continue;
        }
        break;
      }
      return v;
    }
    async function getPic(platform, musicInfo) {
      try {
        const mod = musicSdk[platform];
        if (!mod || !mod.getPic)
          return "";
        const pic = await unwrapVendor(mod.getPic(musicInfo));
        if (typeof pic === "string")
          return pic;
        return pic && pic.url || "";
      } catch {
        return "";
      }
    }
    async function getLyric(platform, musicInfo) {
      try {
        const mod = musicSdk[platform];
        if (!mod || !mod.getLyric)
          return "";
        const info = await unwrapVendor(mod.getLyric(musicInfo));
        return info && info.lyric || "";
      } catch {
        return "";
      }
    }
    var boardsCache = /* @__PURE__ */ new Map();
    async function boards(platform) {
      if (boardsCache.has(platform))
        return boardsCache.get(platform);
      try {
        const mod = musicSdk[platform];
        if (!mod || !mod.leaderboard || !mod.leaderboard.getBoards)
          return [];
        const r = await unwrapVendor(mod.leaderboard.getBoards());
        const list = r && r.list || [];
        boardsCache.set(platform, list);
        return list;
      } catch {
        return [];
      }
    }
    async function boardName(platform, boardId) {
      const list = await boards(platform);
      const b = list.find((x) => String(x.id) === String(boardId));
      return b ? b.name : "榜单";
    }
    async function boardSongs(platform, boardId, page) {
      try {
        const mod = musicSdk[platform];
        if (!mod || !mod.leaderboard || !mod.leaderboard.getList)
          return [];
        const r = await unwrapVendor(mod.leaderboard.getList(String(boardId).replace(/^[a-z]+__/, ""), page));
        return (r && r.list || []).filter((s) => s && s.songmid);
      } catch {
        return [];
      }
    }
    var tagsCache = /* @__PURE__ */ new Map();
    async function songListTags(platform) {
      if (tagsCache.has(platform))
        return tagsCache.get(platform);
      try {
        const sl = musicSdk[platform] && musicSdk[platform].songList;
        if (!sl || !sl.getTags)
          return [];
        const raw = await unwrapVendor(sl.getTags());
        const arr = Array.isArray(raw) ? raw : raw && raw.tags || [];
        const flat = [];
        for (const t of arr) {
          if (Array.isArray(t && t.list)) {
            for (const c of t.list)
              flat.push({ id: String(c.id), name: t.name + " · " + c.name });
          } else if (t && t.id) {
            flat.push({ id: String(t.id), name: t.name });
          }
        }
        const tags2 = flat.filter((t) => t.id && t.id !== "undefined" && t.name).slice(0, 14);
        tagsCache.set(platform, tags2);
        return tags2;
      } catch {
        return [];
      }
    }
    async function songLists(platform, tagId, page) {
      try {
        const sl = musicSdk[platform] && musicSdk[platform].songList;
        if (!sl || !sl.getList)
          return { list: [], total: 0 };
        const r = await unwrapVendor(sl.getList("", tagId || "", page));
        return {
          list: (r && r.list || []).filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: x.name || "", pic: x.img || "", author: x.author || "" })),
          total: r && r.total || 0
        };
      } catch {
        return { list: [], total: 0 };
      }
    }
    async function songListSongs(platform, listId, page) {
      try {
        const sl = musicSdk[platform] && musicSdk[platform].songList;
        if (!sl || !sl.getListDetail)
          return [];
        const r = await unwrapVendor(sl.getListDetail(String(listId), page));
        return (r && r.list || r || []).filter((s) => s && s.songmid);
      } catch {
        return [];
      }
    }
    function tags(platform) {
      return tagsCache.get(platform) || [];
    }
    module2.exports = { CATALOGS: { ids: IDS, names: NAMES, tags }, search, searchAll, getPic, getLyric, boards, boardName, boardSongs, songListTags, songLists, songListSongs, musicSdk };
  }
});

// src/actions.js
var require_actions = __commonJS({
  "src/actions.js"(exports2, module2) {
    "use strict";
    var fs = require("node:fs");
    var path = require("node:path");
    var { Buffer: Buffer2 } = require("node:buffer");
    var { loadScript } = require_lx_runtime();
    var catalog2 = require_catalog();
    var PLAY_FLAG = "洛雪音乐";
    var QUALITY_TITLES = { "128k": "标准 128k", "320k": "高品 320k", "flac": "无损 FLAC" };
    var DEFAULT_QUALITIES = Object.keys(QUALITY_TITLES);
    var PLATFORM_HEADERS = {
      kw: { "User-Agent": "kwplayer_ar_9.2.2.1_apk.urlinside.cn.apk" }
    };
    var routes = /* @__PURE__ */ new Map();
    function getRuntime(route, sourcesDir) {
      const scriptPath = path.join(sourcesDir, route + ".js");
      const mtime = fs.statSync(scriptPath).mtimeMs;
      const cur = routes.get(route);
      if (cur && cur.scriptPath === scriptPath && cur.mtime === mtime)
        return cur.runtime;
      console.log("[route]", route, "加载脚本:", scriptPath);
      const runtime = loadScript(scriptPath);
      routes.set(route, { scriptPath, mtime, runtime });
      return runtime;
    }
    function encodeId(song) {
      return Buffer2.from(JSON.stringify({ platform: song.platform, musicInfo: song.musicInfo, name: song.name, pic: song.pic || "" }), "utf8").toString("base64url");
    }
    function decodeId(id) {
      const raw = id.startsWith("lx://") ? id.slice(5) : id;
      return JSON.parse(Buffer2.from(raw, "base64url").toString("utf8"));
    }
    async function home(route, body) {
      await Promise.race([
        Promise.all(catalog2.CATALOGS.ids.map((id) => catalog2.songListTags(id))),
        new Promise((r) => setTimeout(r, 3e3))
      ]);
      const filters = {};
      for (const id of catalog2.CATALOGS.ids) {
        const kindFilter = {
          key: "kind",
          name: "类型",
          value: [{ n: "榜单", v: "board" }, { n: "歌单", v: "songlist" }]
        };
        const tagFilter = {
          key: "tag",
          name: "歌单标签",
          value: [{ n: "热门", v: "" }, ...catalog2.CATALOGS.tags(id).map((t) => ({ n: t.name, v: t.id }))]
        };
        filters[id] = [kindFilter, tagFilter];
      }
      return {
        class: catalog2.CATALOGS.ids.map((id) => ({ type_id: id, type_name: catalog2.CATALOGS.names[id] })),
        filters,
        list: []
        // 宿主 AbsJson 遍历 list，空推荐位也必须给空数组
      };
    }
    async function category(route, body) {
      const page = Number(body.page) || 1;
      const platform = body.id || body.type_id || catalog2.CATALOGS.ids[0];
      const extend = body.extend || {};
      const port = parseInt(process.env.LX_PORT, 10) || 9920;
      if (extend.kind === "songlist") {
        const r = await catalog2.songLists(platform, extend.tag || "", page);
        return {
          list: r.list.map((l) => ({
            vod_id: "sl:" + platform + ":" + encodeURIComponent(l.name) + ":" + l.id,
            vod_name: l.name,
            vod_pic: l.pic,
            vod_remarks: l.author || catalog2.CATALOGS.names[platform] + " · 歌单"
          })),
          page,
          pagecount: r.total > r.list.length * page ? 999 : page,
          total: r.total,
          limit: 30
        };
      }
      const boards = await catalog2.boards(platform);
      return {
        list: boards.map((b) => ({
          vod_id: "pl:" + platform + ":" + b.id,
          vod_name: b.name,
          vod_pic: `http://127.0.0.1:${port}/cover/${platform}/${encodeURIComponent(b.id)}`,
          vod_remarks: catalog2.CATALOGS.names[platform] + " · 榜单"
        })),
        page,
        pagecount: 1,
        total: boards.length,
        limit: 30
      };
    }
    async function search(route, body) {
      const wd = body.wd || "";
      const page = Number(body.page) || 1;
      if (!wd)
        return { list: [], page, pagecount: 1, total: 0, limit: 30 };
      const merged = await catalog2.searchAll(wd, page);
      return {
        list: merged.slice(0, 30).map((s) => ({
          vod_id: "song:" + s.platform + ":" + encodeId(s),
          vod_name: s.musicInfo.name,
          vod_pic: s.pic,
          vod_remarks: catalog2.CATALOGS.names[s.platform] + " · " + (s.musicInfo.singer || "")
        })),
        page,
        pagecount: 1,
        total: merged.length,
        limit: 30
      };
    }
    async function detail(route, body) {
      const id = Array.isArray(body.ids) ? body.ids[0] : body.ids || body.id;
      if (!id)
        return { list: [] };
      if (id.startsWith("pl:") || id.startsWith("sl:")) {
        const parts2 = id.split(":");
        const platform = parts2[1];
        const isBoard = id.startsWith("pl:");
        const nameSeg = !isBoard && parts2.length > 3;
        const listId = (nameSeg ? parts2.slice(3) : parts2.slice(2)).join(":");
        const songs = isBoard ? await catalog2.boardSongs(platform, listId, 1) : await catalog2.songListSongs(platform, listId, 1);
        const name = isBoard ? await catalog2.boardName(platform, listId) : nameSeg ? decodeURIComponent(parts2[2]) : "歌单";
        return {
          list: [{
            vod_id: id,
            vod_name: name,
            vod_pic: songs[0] && (songs[0].img || songs[0].pic) || "",
            vod_play_from: PLAY_FLAG,
            vod_play_url: songs.map((s) => s.name + "$lx://" + encodeId({ platform, name: s.name, pic: "", musicInfo: s })).join("#")
          }],
          page: 1,
          pagecount: 1,
          total: 1,
          limit: 1
        };
      }
      if (!id.startsWith("song:"))
        return { list: [] };
      const parts = id.split(":");
      const song = decodeId(parts.slice(2).join(":"));
      return {
        list: [{
          vod_id: id,
          vod_name: song.musicInfo.name,
          vod_pic: song.pic,
          vod_remarks: song.musicInfo.singer + (song.musicInfo.albumName ? " · " + song.musicInfo.albumName : ""),
          vod_play_from: PLAY_FLAG,
          vod_play_url: song.name + "$lx://" + encodeId(song)
        }],
        page: 1,
        pagecount: 1,
        total: 1,
        limit: 1
      };
    }
    async function play(route, body, sourcesDir) {
      const { flag, id } = body;
      const song = decodeId(id);
      const qualities = DEFAULT_QUALITIES.filter((q) => !flag || flag === PLAY_FLAG || flag === QUALITY_TITLES[q]);
      const runtime = getRuntime(route, sourcesDir);
      const t0 = Date.now();
      const ENHANCE_TIMEOUT = 5e3;
      const timed = (label, p) => p.then(
        (v) => {
          console.log(`[play] ${label} ${Date.now() - t0}ms`);
          return v;
        },
        (e) => {
          console.log(`[play] ${label} 失败 ${Date.now() - t0}ms:`, e && e.message);
          return Promise.reject(e);
        }
      );
      const withTimeout = (label, p) => Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => {
          console.log(`[play] ${label} 超时(${ENHANCE_TIMEOUT}ms) 放弃`);
          resolve("");
        }, ENHANCE_TIMEOUT))
      ]);
      const [results, pic, lrc] = await Promise.all([
        Promise.allSettled(
          qualities.map(async (q) => ({ q, url: await timed("直链 " + q, runtime.resolveMusicUrl(song.platform, song.musicInfo, q)) }))
        ),
        song.pic || song.musicInfo.img ? Promise.resolve(song.pic || song.musicInfo.img) : withTimeout("pic", catalog2.getPic(song.platform, song.musicInfo)),
        withTimeout("lrc", catalog2.getLyric(song.platform, song.musicInfo))
      ]);
      const urls = [];
      for (const r of results) {
        if (r.status === "fulfilled")
          urls.push(QUALITY_TITLES[r.value.q], r.value.url);
        else
          console.log("[play] 音质失败", r.reason && r.reason.message);
      }
      if (!urls.length)
        return { flag: PLAY_FLAG, parse: 0, jx: 0, url: "" };
      const out = { flag: flag || PLAY_FLAG, parse: 0, jx: 0, isMusic: true, url: urls };
      if (pic)
        out.pic = pic;
      if (lrc)
        out.lrc = lrc;
      if (PLATFORM_HEADERS[song.platform])
        out.header = PLATFORM_HEADERS[song.platform];
      return out;
    }
    var ACTIONS = { home, category, search, detail, play };
    async function dispatch2(route, action, body, sourcesDir) {
      const fn = ACTIONS[action];
      if (!fn)
        throw new Error("未知动作: " + action);
      return fn(route, body || {}, sourcesDir);
    }
    module2.exports = { dispatch: dispatch2, getRuntime, PLAY_FLAG };
  }
});

// src/index.js
var http = require("node:http");
var { dispatch } = require_actions();
var catalog = require_catalog();
var PORT = parseInt(process.env.LX_PORT, 10) || parseInt(process.argv[2], 10) || 9920;
var SOURCES_DIR = process.argv[2];
if (!SOURCES_DIR) {
  console.error("用法: LX_PORT=<port> node index.js <sourcesDir>");
  process.exit(1);
}
var BODY_LIMIT = 1024 * 1024;
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e && e.message));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e && e.message));
var coverCache = /* @__PURE__ */ new Map();
async function boardCover(platform, boardId) {
  const key = platform + ":" + boardId;
  if (coverCache.has(key))
    return coverCache.get(key);
  const songs = await catalog.boardSongs(platform, boardId, 1);
  const img = songs[0] && (songs[0].img || songs[0].pic) || "";
  coverCache.set(key, img);
  return img;
}
var server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/check") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"code":200}');
    return;
  }
  const cm = url.pathname.match(/^\/cover\/(\w+)\/(.+)$/);
  if (req.method === "GET" && cm) {
    boardCover(cm[1], cm[2]).then((img) => {
      if (img) {
        res.writeHead(302, { Location: img });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    }).catch(() => {
      res.writeHead(404);
      res.end();
    });
    return;
  }
  const m = url.pathname.match(/^\/lx\/([^/]+)\/(\w+)$/);
  if (req.method !== "POST" || !m) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > BODY_LIMIT) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    const started = Date.now();
    try {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const data = await dispatch(m[1], m[2], body, SOURCES_DIR);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
      console.log("[req]", m[1] + "/" + m[2], Date.now() - started + "ms");
    } catch (e) {
      console.error("[req]", m[1] + "/" + m[2], "失败:", e.message);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});
server.listen(PORT, "127.0.0.1", () => console.log("lx-server listening on " + PORT));
/*! Bundled license information:

crypto-js/ripemd160.js:
  (** @preserve
  	(c) 2012 by Cédric Mesnil. All rights reserved.
  
  	Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
  
  	    - Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
  	    - Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
  
  	THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
  	*)

crypto-js/mode-ctr-gladman.js:
  (** @preserve
   * Counter block mode compatible with  Dr Brian Gladman fileenc.c
   * derived from CryptoJS.mode.CTR
   * Jan Hruby jhruby.web@gmail.com
   *)
*/
