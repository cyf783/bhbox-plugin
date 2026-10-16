// 精简版：原 utils/req.js 含 DoH/系统代理拦截器，设备端不需要，仅保留 keepAlive + 忽略证书
import _axios from 'axios';
import https from 'https';
import http from 'http';

const req = _axios.create({
    httpsAgent: new https.Agent({keepAlive: true, rejectUnauthorized: false}),
    httpAgent: new http.Agent({keepAlive: true}),
});

export const reqs = _axios.create({
    httpsAgent: new https.Agent({rejectUnauthorized: false}),
});

export default req;
