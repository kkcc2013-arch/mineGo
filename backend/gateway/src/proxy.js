'use strict';

const httpProxy = require('http-proxy');
const { Readable } = require('node:stream');
const querystring = require('node:querystring');

function rewritePath(req, rewrite) {
  if (typeof rewrite === 'function') return rewrite(req.url, req);
  if (!rewrite) return req.url;
  for (const [pattern, replacement] of Object.entries(rewrite)) {
    const expression = new RegExp(pattern);
    if (expression.test(req.url)) return req.url.replace(expression, replacement);
    // Express removes the mount prefix from req.url. Some legacy rules name
    // that full prefix explicitly; only those rules use the original URL.
    if (expression.test(req.originalUrl)) return req.originalUrl.replace(expression, replacement);
  }
  return req.url;
}

function replayBody(req) {
  if (!req.readableEnded || req.body === undefined) return undefined;
  let body;
  const contentType = String(req.headers['content-type'] || '').split(';')[0];
  if (Buffer.isBuffer(req.body)) body = req.body;
  else if (typeof req.body === 'string') body = Buffer.from(req.body);
  else if (contentType === 'application/json' || contentType.endsWith('+json')) body = Buffer.from(JSON.stringify(req.body));
  else if (contentType === 'application/x-www-form-urlencoded') body = Buffer.from(querystring.stringify(req.body));
  else throw new Error('Cannot replay a consumed request body of this content type');
  req.headers['content-length'] = String(body.length);
  delete req.headers['transfer-encoding'];
  return Readable.from([body]);
}

// Static upstream targets and explicit path rewrites cover the gateway's proxy
// routes. No glob matcher or Host-header-based router is needed.
function createProxyMiddleware(options) {
  const target = new URL(options.target);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Proxy target must use HTTP or HTTPS');
  const proxy = httpProxy.createProxyServer({
    target: target.href,
    changeOrigin: options.changeOrigin === true,
    secure: options.secure !== false,
    proxyTimeout: options.proxyTimeout || 30000,
    timeout: options.timeout || 30000
  });
  for (const event of ['proxyReq', 'proxyRes', 'proxyReqWs']) {
    if (options.on?.[event]) proxy.on(event, (...args) => {
      try { options.on[event](...args); }
      catch (error) {
        if (args[1] && args[2]) {
          args[0].destroy();
          onError(error, args[1], args[2]);
        }
      }
    });
  }
  function onError(error, req, res) {
    if (options.on?.error) return options.on.error(error, req, res);
    if (typeof res.writeHead === 'function') {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 9002, message: 'Downstream service unavailable', data: null }));
      } else res.destroy(error);
    } else res.destroy();
  }
  proxy.on('error', onError);
  const middleware = (req, res, next) => {
    try {
      const buffer = replayBody(req);
      req.url = rewritePath(req, options.pathRewrite);
      proxy.web(req, res, { buffer });
    } catch (error) { next(error); }
  };
  middleware.upgrade = (req, socket, head) => {
    req.url = rewritePath(req, options.pathRewrite);
    proxy.ws(req, socket, head);
  };
  middleware.close = () => proxy.close();
  return middleware;
}

module.exports = { createProxyMiddleware, rewritePath };
