'use strict';
// socks-proxy-agent stub：仅 request.js 的 socks 代理分支动态 import，插件场景不可达
class SocksProxyAgent {
  constructor() {
    throw new Error('socks proxy not supported in lx-server');
  }
}
module.exports = { SocksProxyAgent };
