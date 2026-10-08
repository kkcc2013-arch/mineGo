'use strict';
const {createProxyMiddleware} = require('../proxy');
const {getClientIp} = require('../../../shared/clientIp');
const prefixes = ['/api/ip-appeal','/api/v1/ip-appeal','/api/v1/users/ip-appeal','/api/v2/ip-appeal','/api/v2/users/ip-appeal','/v1/ip-appeal','/v1/users/ip-appeal','/users/ip-appeal'];
function isIpAppealPath(path) { return prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/')); }
function mountIpAppealProxy(app,target) {
  const proxy = createProxyMiddleware({target,changeOrigin:true,pathRewrite:{'^/':'/ip-appeal/'},on:{
    proxyReq(proxyReq,req) {
      proxyReq.removeHeader('x-forwarded-for');
      proxyReq.removeHeader('x-real-ip');
      const ip = getClientIp(req);
      if (ip) proxyReq.setHeader('X-Forwarded-For',ip);
    }
  }});
  app.use(prefixes,proxy);
  return proxy;
}
module.exports = {mountIpAppealProxy,isIpAppealPath,prefixes};
