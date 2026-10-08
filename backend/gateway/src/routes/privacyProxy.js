'use strict';
const {createProxyMiddleware} = require('../proxy');

function mountPrivacyProxy(app, target) {
  const privacy = createProxyMiddleware({target, changeOrigin: true, pathRewrite: {'^/': '/privacy/'}});
  const admin = createProxyMiddleware({target, changeOrigin: true, pathRewrite: {'^/': '/privacy/admin/'}});
  app.use(['/api/v1/privacy', '/api/v1/user/privacy', '/v1/privacy'], privacy);
  app.use('/api/v1/admin/privacy', admin);
  return {close() { privacy.close(); admin.close(); }};
}
module.exports = {mountPrivacyProxy};
