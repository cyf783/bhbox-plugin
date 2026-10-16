// 精简版：原 utils/createAxiosAgent.js 含系统代理/DoH 拦截器（依赖 undici/https-proxy-agent/dns_doh）
// 设备端仅保留 keepAlive 连接池与忽略证书的 axios 实例
import axios from 'axios';
import http from 'http';
import https from 'https';

export default function createAxiosInstance(options = {}) {
    const maxSockets = options.maxSockets || 64;
    const timeout = options.timeout || 0;
    return axios.create({
        httpAgent: new http.Agent({keepAlive: true, maxSockets, timeout}),
        httpsAgent: new https.Agent({keepAlive: true, maxSockets, timeout, rejectUnauthorized: false}),
        proxy: false,
    });
}
