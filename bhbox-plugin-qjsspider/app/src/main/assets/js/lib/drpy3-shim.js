/**
 * drpy3 宿主垫片（qjsspider 插件 / quickjs_wrapper 引擎）。
 *
 * drpy3-qjs.bundle.js 原设计运行在 libquickjs_bridge.so 宿主（fjs）上，要求宿主
 * 预置若干原生全局；本垫片在 pure-JS + Java 桥上补齐这些全局，使 bundle 能直接
 * 跑在插件的 QuickJSContext 上：
 *
 *   - Buffer / TextEncoder / TextDecoder(utf-8, gbk) / zlib / crypto / cheerio
 *   - fjs.bridge_call：bundle 的宿主桥（req/getProxy/loadAsset/evalModule）
 *
 * 本模块为 ES module，须先于 drpy3-qjs.bundle.js 求值。
 * 字节串一律经 base64 跨越 JS↔Java 边界，避免依赖 wrapper 的 typed array 透传。
 */
import { gbkTool } from './gbk.js'
import { cheerio } from './cat.js'

// ═══ UTF-8 编解码 ═══

function utf8Encode(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.codePointAt(i);
        if (c > 0xffff) i++;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
}

function utf8Decode(bytes, fatal) {
    let out = '';
    for (let i = 0; i < bytes.length;) {
        const b = bytes[i];
        let cp, len;
        if (b < 0x80) { cp = b; len = 1; }
        else if ((b & 0xe0) === 0xc0) { cp = b & 31; len = 2; }
        else if ((b & 0xf0) === 0xe0) { cp = b & 15; len = 3; }
        else if ((b & 0xf8) === 0xf0) { cp = b & 7; len = 4; }
        else {
            if (fatal) throw new TypeError('invalid utf-8 byte 0x' + b.toString(16));
            out += '\ufffd'; i++; continue;
        }
        if (i + len > bytes.length) {
            if (fatal) throw new TypeError('truncated utf-8 sequence');
            out += '\ufffd'; break;
        }
        let ok = true;
        for (let k = 1; k < len; k++) {
            if ((bytes[i + k] & 0xc0) !== 0x80) { ok = false; break; }
            cp = (cp << 6) | (bytes[i + k] & 63);
        }
        if (!ok || (len === 2 && cp < 0x80) || (len === 3 && cp < 0x800) || (len === 4 && cp < 0x10000) || cp > 0x10ffff) {
            if (fatal) throw new TypeError('invalid utf-8 sequence');
            out += '\ufffd'; i++; continue;
        }
        out += String.fromCodePoint(cp);
        i += len;
    }
    return out;
}

// ═══ GBK 编解码（gbk.js 基于百分号转义串） ═══

const gbk = gbkTool();

function gbkEncode(str) {
    const pct = gbk.encode(String(str));
    const out = new Uint8Array(pct.length / 3);
    for (let i = 0, j = 0; i < pct.length; i += 3, j++) out[j] = parseInt(pct.substr(i + 1, 2), 16);
    return out;
}

function gbkDecode(bytes) {
    let pct = '';
    for (let i = 0; i < bytes.length; i++) pct += '%' + bytes[i].toString(16).padStart(2, '0').toUpperCase();
    return gbk.decode(pct);
}

function normLabel(label) {
    return String(label || 'utf-8').toLowerCase().replace(/_/g, '-');
}

function isGbk(label) {
    const l = normLabel(label);
    return l === 'gbk' || l === 'gb2312' || l === 'gb18030';
}

if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        constructor(label) { this.encoding = isGbk(label) ? 'gbk' : 'utf-8'; }
        encode(str) { return this.encoding === 'gbk' ? gbkEncode(str) : utf8Encode(String(str === undefined ? '' : str)); }
        encodeInto() { throw new Error('TextEncoder.encodeInto 未实现'); }
    };
}

if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor(label, options) {
            this.encoding = isGbk(label) ? 'gbk' : 'utf-8';
            this.fatal = !!(options && options.fatal);
        }
        decode(input) {
            const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
            return this.encoding === 'gbk' ? gbkDecode(bytes) : utf8Decode(bytes, this.fatal);
        }
    };
}

// ═══ base64 / hex（纯 JS，供 Buffer 与 zlib 边界转换） ═══

const B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Encode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b1 = bytes[i], b2 = bytes[i + 1], b3 = bytes[i + 2];
        out += B64A[b1 >> 2] + B64A[((b1 & 3) << 4) | ((b2 === undefined ? 0 : b2) >> 4)];
        out += b2 === undefined ? '=' : B64A[((b2 & 15) << 2) | ((b3 === undefined ? 0 : b3) >> 6)];
        out += b3 === undefined ? '=' : B64A[b3 & 63];
    }
    return out;
}

const B64I = (() => {
    const t = new Int8Array(128).fill(-1);
    for (let i = 0; i < 64; i++) t[B64A.charCodeAt(i)] = i;
    t['-'.charCodeAt(0)] = 62;
    t['_'.charCodeAt(0)] = 63;
    return t;
})();

function b64Decode(str) {
    const clean = String(str).replace(/[^A-Za-z0-9+/=-]/g, '').replace(/=+$/, '');
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0, buf = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
        const v = B64I[clean.charCodeAt(i)];
        if (v < 0) throw new TypeError('invalid base64');
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (buf >> bits) & 0xff;
        }
    }
    return out.subarray(0, o);
}

const HEXA = '0123456789abcdef';

function hexEncode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += HEXA[bytes[i] >> 4] + HEXA[bytes[i] & 15];
    return out;
}

function hexDecode(str) {
    const s = String(str).replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
}

function toU8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input) || (input && typeof input.length === 'number')) return new Uint8Array(input);
    throw new TypeError('expected bytes');
}

// ═══ Buffer（Node 兼容子集） ═══

class Drpy3Buffer extends Uint8Array {
    constructor(arg, enc) {
        if (typeof arg === 'number') super(arg);
        else if (typeof arg === 'string') {
            const u8 = normLabel(enc) === 'gbk' ? gbkEncode(arg)
                : normLabel(enc) === 'base64' ? b64Decode(arg)
                : normLabel(enc) === 'hex' ? hexDecode(arg)
                : utf8Encode(arg);
            super(u8.length);
            this.set(u8);
        } else super(toU8(arg));
    }

    toString(enc) {
        const l = normLabel(enc === undefined ? 'utf-8' : enc);
        if (l === 'base64') return b64Encode(this);
        if (l === 'hex') return hexEncode(this);
        if (l === 'gbk' || l === 'gb2312' || l === 'gb18030') return gbkDecode(this);
        return utf8Decode(this, false);
    }

    slice(start, end) { return new Drpy3Buffer(super.subarray(start, end)); }
    subarray(start, end) { return new Drpy3Buffer(super.subarray(start, end)); }
    equals(other) {
        const o = toU8(other);
        return o.length === this.length && this.every((v, i) => v === o[i]);
    }
    every(fn) { for (let i = 0; i < this.length; i++) if (!fn(this[i], i, this)) return false; return true; }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
}

globalThis.Buffer = class Buffer extends Drpy3Buffer {
    static from(input, enc) { return new Drpy3Buffer(input, enc); }
    static alloc(size, fill) {
        const b = new Drpy3Buffer(size);
        if (fill !== undefined) b.fill(fill);
        return b;
    }
    static allocUnsafe(size) { return new Drpy3Buffer(size); }
    static concat(list) {
        const arr = Array.from(list, (x) => toU8(x));
        const total = arr.reduce((n, x) => n + x.length, 0);
        const out = new Drpy3Buffer(total);
        let o = 0;
        for (const x of arr) { out.set(x, o); o += x.length; }
        return out;
    }
    static isBuffer(x) { return x instanceof Drpy3Buffer; }
    static byteLength(str, enc) {
        if (str instanceof Uint8Array || str instanceof ArrayBuffer) return toU8(str).length;
        return normLabel(enc) === 'gbk' ? gbkEncode(String(str)).length : utf8Encode(String(str)).length;
    }
};

// ═══ Uint8Array base64/hex 扩展 ═══
// 原 libquickjs_bridge 宿主（quickjs-ng）内置；bundle 仅自 polyfill fromBase64，
// 但 getKey/rsaX 路径还会用到 toBase64/fromHex/toHex，此处按 shim 实现补齐。

if (typeof Uint8Array.fromBase64 !== 'function') Uint8Array.fromBase64 = (s) => b64Decode(s);
if (typeof Uint8Array.fromHex !== 'function') Uint8Array.fromHex = (s) => hexDecode(s);
if (typeof Uint8Array.prototype.toBase64 !== 'function') Uint8Array.prototype.toBase64 = function () { return b64Encode(this); };
if (typeof Uint8Array.prototype.toHex !== 'function') Uint8Array.prototype.toHex = function () { return hexEncode(this); };

// ═══ zlib（经 __drpy3host Java 桥，base64 进出；返回 Buffer 便于 .toString(enc)） ═══

const wrapBuf = (x) => (typeof globalThis.Buffer === 'function' ? globalThis.Buffer.from(x) : x);

globalThis.zlib = {
    gzip: (input) => wrapBuf(b64Decode(__drpy3host.gzip(b64Encode(toU8(input))))),
    gunzip: (input) => wrapBuf(b64Decode(__drpy3host.gunzip(b64Encode(toU8(input))))),
    unzip: (input) => wrapBuf(b64Decode(__drpy3host.unzip(b64Encode(toU8(input))))),
    deflate: (input) => wrapBuf(b64Decode(__drpy3host.deflate(b64Encode(toU8(input))))),
    inflate: (input) => wrapBuf(b64Decode(__drpy3host.inflate(b64Encode(toU8(input)))))
};

// ═══ crypto（getRandomValues + 完整 subtle 桥；后端为 __drpy3host 的 java.security/javax.crypto） ═══

const subtleImpl = (() => {
    function normHash(h) {
        h = String(h || 'SHA-1').toUpperCase();
        return h === 'SHA' ? 'SHA-1' : h;
    }

    function algOf(a) {
        if (typeof a === 'string') return { name: a };
        if (!a || !a.name) throw new TypeError('[drpy3] 无效算法对象');
        return a;
    }

    function u8Of(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        return toU8(data);
    }

    /** 返回独立拷贝的 ArrayBuffer（WebCrypto 语义），避免 subarray 共享缓冲区 */
    function ab(u8) {
        return u8.slice().buffer;
    }

    function keyOf(key, usage) {
        if (!key || key.__drpy3key !== true) throw new Error('[drpy3] 无效 CryptoKey（须由 subtle.importKey/generateKey 产生）');
        return key;
    }

    function isAes(name) { return name === 'AES-GCM' || name === 'AES-CBC'; }
    function isRsa(name) { return name === 'RSA-OAEP' || name === 'RSA-PKCS1-v1_5'; }
    function isRsaSig(name) { return name === 'RSASSA-PKCS1-v1_5' || name === 'RSA-PSS'; }

    /**
     * 从 RSA 密钥 DER（spki/pkcs8）解析模长（bit）。
     * DER 中 RSA modulus 是最大的 02 82 长整数（公钥指数 65537 仅 3 字节），
     * 扫描取其长度 * 8；JSEncrypt._maxEncryptSegment 依赖该值做分块，缺失会死循环。
     */
    function rsaModBits(der) {
        let best = 0;
        for (let i = 0; i < der.length - 4; i++) {
            if (der[i] === 0x02 && der[i + 1] === 0x82) {
                const len = (der[i + 2] << 8) | der[i + 3];
                if (len >= 64 && len > best) best = len;
            }
        }
        return best ? best * 8 : 1024;
    }

    // 注意：bundle（JSEncrypt/NODERSA/WebCrypto helper）全部按【同步】语义消费 subtle
    // （如 new Uint8Array(subtle.encrypt(...))，不经 await），故本实现为同步 API；
    // 源码侧若写 await subtle.xxx() 同样兼容（await 同步值）。
    return {
        importKey(format, data, algorithm, extractable, usages) {
            const alg = algOf(algorithm);
            const hash = alg.hash ? normHash(alg.hash.name || alg.hash) : undefined;
            const bytes = new Uint8Array(u8Of(data));
            const isRsaKey = format === 'spki' || format === 'pkcs8';
            const modulusLength = isRsaKey ? rsaModBits(bytes) : alg.modulusLength;
            return {
                __drpy3key: true,
                type: format === 'spki' ? 'public' : format === 'pkcs8' ? 'private' : 'secret',
                format: String(format),
                bytes,
                algorithm: { name: alg.name, hash, modulusLength },
                usages: usages || [],
                extractable: extractable !== false
            };
        },

        exportKey(format, key) {
            keyOf(key);
            if (format !== key.format) throw new Error('[drpy3] exportKey: 格式不匹配 ' + format + ' != ' + key.format);
            return ab(key.bytes);
        },

        generateKey(algorithm, extractable, usages) {
            const alg = algOf(algorithm);
            if (String(alg.name).indexOf('RSA') !== 0) throw new Error('[drpy3] generateKey 仅支持 RSA，收到 ' + alg.name);
            const modulusLength = alg.modulusLength || 1024;
            const pair = JSON.parse(__drpy3host.rsaGen(modulusLength));
            const hash = normHash(alg.hash && (alg.hash.name || alg.hash) || 'SHA-1');
            const mk = (type, format, bytes) => ({
                __drpy3key: true, type, format, bytes,
                algorithm: { name: alg.name, hash, modulusLength },
                usages: usages || [], extractable: extractable !== false
            });
            return {
                publicKey: mk('public', 'spki', b64Decode(pair.publicKey)),
                privateKey: mk('private', 'pkcs8', b64Decode(pair.privateKey))
            };
        },

        digest(algorithm, data) {
            return ab(b64Decode(__drpy3host.digest(normHash(algOf(algorithm).name), b64Encode(u8Of(data)))));
        },

        encrypt(algorithm, key, data) {
            const alg = algOf(algorithm);
            keyOf(key);
            if (isAes(alg.name)) {
                const out = __drpy3host.aesEnc(alg.name, b64Encode(key.bytes), b64Encode(u8Of(alg.iv)),
                    b64Encode(u8Of(data)), alg.additionalData ? b64Encode(u8Of(alg.additionalData)) : '', alg.tagLength || 128);
                return ab(b64Decode(out));
            }
            if (isRsa(alg.name)) {
                const out = __drpy3host.rsaCipher(1, alg.name, b64Encode(key.bytes), key.type === 'public' ? 1 : 0, b64Encode(u8Of(data)), key.algorithm.hash || 'SHA-1');
                return ab(b64Decode(out));
            }
            throw new Error('[drpy3] subtle.encrypt 不支持 ' + alg.name);
        },

        decrypt(algorithm, key, data) {
            const alg = algOf(algorithm);
            keyOf(key);
            if (isAes(alg.name)) {
                const out = __drpy3host.aesDec(alg.name, b64Encode(key.bytes), b64Encode(u8Of(alg.iv)),
                    b64Encode(u8Of(data)), alg.additionalData ? b64Encode(u8Of(alg.additionalData)) : '', alg.tagLength || 128);
                return ab(b64Decode(out));
            }
            if (isRsa(alg.name)) {
                const out = __drpy3host.rsaCipher(0, alg.name, b64Encode(key.bytes), key.type === 'private' ? 0 : 1, b64Encode(u8Of(data)), key.algorithm.hash || 'SHA-1');
                return ab(b64Decode(out));
            }
            throw new Error('[drpy3] subtle.decrypt 不支持 ' + alg.name);
        },

        sign(algorithm, key, data) {
            const alg = algOf(algorithm);
            keyOf(key);
            if (isRsaSig(alg.name)) {
                return ab(b64Decode(__drpy3host.rsaSign(b64Encode(key.bytes), b64Encode(u8Of(data)), alg.name, key.algorithm.hash || 'SHA-1', alg.saltLength || 0)));
            }
            if (alg.name === 'HMAC') {
                return ab(b64Decode(__drpy3host.hmacSign(b64Encode(key.bytes), b64Encode(u8Of(data)), key.algorithm.hash || 'SHA-256')));
            }
            throw new Error('[drpy3] subtle.sign 不支持 ' + alg.name);
        },

        verify(algorithm, key, signature, data) {
            const alg = algOf(algorithm);
            keyOf(key);
            if (isRsaSig(alg.name)) {
                const ok = __drpy3host.rsaVerify(b64Encode(key.bytes), b64Encode(u8Of(signature)), b64Encode(u8Of(data)), alg.name, key.algorithm.hash || 'SHA-1', alg.saltLength || 0);
                return ok === '1';
            }
            if (alg.name === 'HMAC') {
                const mac = b64Encode(u8Of(subtleImpl.sign(algorithm, key, data)));
                const expect = b64Encode(u8Of(signature));
                return mac.length === expect.length && mac === expect;
            }
            throw new Error('[drpy3] subtle.verify 不支持 ' + alg.name);
        },

        deriveBits(algorithm, key, length) {
            const alg = algOf(algorithm);
            keyOf(key);
            if (alg.name !== 'PBKDF2') throw new Error('[drpy3] deriveBits 仅支持 PBKDF2，收到 ' + alg.name);
            const out = __drpy3host.pbkdf2(b64Encode(key.bytes), b64Encode(u8Of(alg.salt)), alg.iterations || 1,
                normHash(alg.hash && (alg.hash.name || alg.hash) || 'SHA-1'), length);
            return ab(b64Decode(out));
        },

        deriveKey(algorithm, key, deriveType, extractable, usages) {
            const bits = this.deriveBits(algorithm, key, deriveType.length || 128);
            return this.importKey('raw', bits, deriveType, extractable, usages);
        }
    };
})();

globalThis.crypto = {
    getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
    },
    subtle: subtleImpl
};

// ═══ cheerio（cat.js 内置纯 JS 版，drpy3 shim 要求 so.load 形态） ═══

if (typeof globalThis.cheerio === 'undefined') globalThis.cheerio = cheerio;

// ═══ 宿主桥：Java 侧注册 __drpy3host（字符串进出），此处实现 bundle 期望的 fjs.bridge_call ═══

globalThis.fjs = {
    version: 'bhbox-qjsspider-1.0',
    async bridge_call(msg) {
        if (!msg || typeof msg !== 'object') return null;
        const action = msg.action;
        if (action === 'req') {
            const o = msg.options || {};
            const wantBytes = o.buffer === 1;
            const opts = Object.assign({}, o, { buffer: wantBytes ? 2 : 0 });
            const res = JSON.parse(__drpy3host.req(String(msg.url), JSON.stringify(opts)));
            if (wantBytes && typeof res.content === 'string') {
                res.content = typeof Uint8Array.fromBase64 === 'function'
                    ? Uint8Array.fromBase64(res.content)
                    : b64Decode(res.content);
            }
            return res;
        }
        if (action === 'getProxy') return __drpy3host.getProxy(msg.isPublic ? 1 : 0);
        if (action === 'loadAsset') return __drpy3host.loadAsset(String(msg.path || ''));
        if (action === 'evalModule') {
            // bundle 以 (code, path) 请求注册源码模块；Java 模块加载器可按 path（api URL）重新拉取
            // 同一内容并编译为 ES module，故直接返回 path 作为模块名，bundle 随后 import(name)。
            const name = String(msg.path || '');
            if (!name) throw new Error('evalModule: 源未提供 path，无法注册模块');
            return name;
        }
        return null;
    }
};
