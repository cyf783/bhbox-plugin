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
        const raw = Buffer.concat(chunks);
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
