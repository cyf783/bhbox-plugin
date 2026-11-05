'use strict';
// needle 兼容层：仅覆盖 vendor/utils/request.js 用到的 needle.request(method,url,data,options,cb) 子集
// 语义对齐 needle：对象 data 按 options.json/formData/urlencoded 序列化；resp={statusCode,headers,body,raw}；response_timeout 为首字节超时
const http = require('node:http');
const https = require('node:https');
const { URLSearchParams } = require('node:url');

function buildBody(data, options) {
  if (data == null) return { body: null, headers: {} };
  if (typeof data === 'string' || Buffer.isBuffer(data)) return { body: data, headers: {} };
  if (options.json) return { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } };
  if (options.formData || data.content_type) {
    const boundary = '----lxserver' + Math.random().toString(16).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(data)) {
      if (k === 'content_type') continue;
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${val}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary } };
  }
  return { body: new URLSearchParams(data).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
}

function request(method, url, data, options = {}, callback) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const { body, headers: bodyHeaders } = buildBody(data, options);
  const headers = { ...bodyHeaders, ...(options.headers || {}) };
  if (body != null && headers['Content-Length'] == null) headers['Content-Length'] = Buffer.byteLength(body);
  const req = lib.request(u, {
    method: (options.method || method || 'GET').toUpperCase(),
    headers,
    // request.js 传 rejectUnauthorized:false（忽略自签证书），缺省 true
    rejectUnauthorized: options.rejectUnauthorized !== false,
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const raw = Buffer.concat(chunks);
      const resp = { statusCode: res.statusCode, headers: res.headers, raw, body: raw.toString() };
      callback(null, resp, resp.body);
    });
  });
  // response_timeout：needle 语义为首字节超时（收到响应头前计时）
  if (options.response_timeout) {
    let gotResponse = false;
    req.on('response', () => { gotResponse = true; });
    const timer = setTimeout(() => {
      if (!gotResponse) {
        const err = new Error('Response timeout');
        err.code = 'ESOCKETTIMEDOUT';
        req.destroy(err);
      }
    }, options.response_timeout * 1000);
    req.on('response', () => clearTimeout(timer));
    req.on('close', () => clearTimeout(timer));
  }
  req.on('error', (e) => callback(e));
  if (body != null) req.write(body);
  req.end();
  return { request: req };
}

module.exports = { request, get: (u, o, cb) => request('GET', u, null, typeof o === 'function' ? {} : o, typeof o === 'function' ? o : cb) };
