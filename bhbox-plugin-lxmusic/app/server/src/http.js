'use strict';
// 共享 HTTP 工具：lx shim 的 request 与曲库适配层共用
const { Buffer } = require('node:buffer');

/**
 * 发起 HTTP 请求，Promise<{statusCode, headers, body, raw}>。
 * body 自动尝试 JSON 解析（JSON 不可解析则保持字符串）；raw 为原始 Buffer。
 */
function rawRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
    const method = (options.method || 'GET').toUpperCase();
    const headers = Object.assign({}, options.headers);
    let data = options.body;
    if (data != null && typeof data !== 'string' && !Buffer.isBuffer(data)) {
      data = JSON.stringify(data);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    if (data != null && method !== 'GET') headers['Content-Length'] = Buffer.byteLength(data);
    const req = lib.request(u, { method, headers, timeout: (options.timeout || 15) * 1000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        // 响应压缩自动解压（插件脚本普遍带 accept-encoding 头，Node http 不自动解压）
        const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
        try {
          if (enc === 'gzip') raw = require('node:zlib').gunzipSync(raw);
          else if (enc === 'deflate') raw = require('node:zlib').inflateSync(raw);
          else if (enc === 'br') raw = require('node:zlib').brotliDecompressSync(raw);
        } catch { /* 解压失败按原样继续 */ }
        const text = raw.toString('utf8').trim();
        let parsed = null;
        if (text.startsWith('{') || text.startsWith('[')) {
          try { parsed = JSON.parse(text); } catch { parsed = null; }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed != null ? parsed : raw.toString('utf8'), raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (data != null && method !== 'GET') req.write(data);
    req.end();
  });
}

module.exports = { rawRequest };
