'use strict';
// tunnel / socks-proxy-agent stub：插件无代理场景， getRequestAgent 返回 undefined 即可
module.exports = {
  httpsOverHttp: () => undefined,
  httpOverHttp: () => undefined,
};
