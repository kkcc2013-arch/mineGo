'use strict';
const express = require('express');
const {requireAuth, requireAdmin} = require('@pmg/shared/auth');
const {createLogger} = require('@pmg/shared/logger');
const logger = createLogger('cache-invalidation-routes');

function createCacheInvalidationRoutes(center) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      const status = [400, 409, 503].includes(error.status) ? error.status : 503;
      logger.warn({code: error.code || 'CACHE_CONTROL_UNAVAILABLE'}, 'Cache administration request failed');
      res.status(status).json({success: false, error: status === 400 ? 'Invalid cache rules or revision' : status === 409 ? 'Cache configuration revision changed' : 'Cache invalidation is awaiting recovery'});
    }
  };
  router.get('/status', handle(async (_req, res) => res.json({success: true, data: await center.getStats()})));
  router.get('/metrics', handle(async (_req, res) => res.json({success: true, data: await center.getStats()})));
  router.get('/health', handle(async (_req, res) => {
    const health = await center.healthCheck();
    res.status(health.status === 'healthy' ? 200 : 503).json({success: health.status === 'healthy', data: health});
  }));
  router.get('/rules', handle(async (_req, res) => res.json({success: true, data: await center.getRules()})));
  router.post('/rules', express.json({limit: '64kb'}), handle(async (req, res) => {
    if (!req.body || Object.keys(req.body).some(key => !['document', 'expectedRevision'].includes(key))) return res.status(400).json({success: false, error: 'Expected document and expectedRevision'});
    const result = await center.updateRules(req.body.document, req.body.expectedRevision);
    res.json({success: true, data: result});
  }));
  router.use((error, _req, res, next) => {
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') return res.status(error.status).json({success: false, error: error.status === 413 ? 'Cache configuration is too large' : 'Invalid JSON configuration'});
    next(error);
  });
  return router;
}
module.exports = {createCacheInvalidationRoutes};
