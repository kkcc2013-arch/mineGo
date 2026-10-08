'use strict';
const express = require('express');
const { isIP } = require('node:net');
const { requireAuth } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const { getClientIp } = require('../../../../shared/clientIp');
const logger = createLogger('ip-appeal');
let manager;
function initIpAppealRoutes(instance) { manager = instance; }
function createIpAppealRouter(getManager = () => manager) {
  const router = express.Router();
  async function ready(req, res, next) {
    req.appealManager = getManager();
    if (!req.appealManager) return res.status(503).json({ error: 'IP appeal service unavailable' });
    req.clientIp = getClientIp(req);
    if (!isIP(req.clientIp || '')) return res.status(400).json({ error: 'Invalid client address' });
    try { await req.appealManager.init(); next(); }
    catch (err) { logger.error({ err }, 'IP appeal initialization failed'); res.status(503).json({ error: 'IP appeal service unavailable' }); }
  }
  router.post('/', requireAuth, ready, async (req, res, next) => {
    try {
      const reason = req.body?.appealReason;
      if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 5000) return res.status(400).json({ error: 'Appeal reason must contain 10 to 5000 characters' });
      const blocked = await req.appealManager.isBlocked(req.clientIp);
      if (!blocked.blocked) return res.status(400).json({ error: 'NOT_BLOCKED' });
      const result = await req.appealManager.submitAppeal(req.clientIp, req.user.id, reason.trim());
      res.json({ success: true, message: '申诉已提交', appealId: result.appealId });
    } catch (err) { next(err); }
  });
  router.get('/status', requireAuth, ready, async (req, res, next) => {
    let client;
    try {
      client = await req.appealManager.db.connect();
      const result = await client.query(`SELECT a.*, r.nickname AS reviewer_name FROM ip_ban_appeals a
        LEFT JOIN users r ON a.reviewed_by = r.id WHERE a.ip_address = $1::inet AND a.user_id = $2
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1`, [req.clientIp, req.user.id]);
      if (!result.rows.length) return res.json({ hasAppeal: false });
      const appeal = result.rows[0];
      res.json({ hasAppeal: true, appeal: { id: appeal.id, status: appeal.status, appealReason: appeal.appeal_reason,
        createdAt: appeal.created_at, reviewedAt: appeal.reviewed_at, reviewNote: appeal.status === 'pending' ? null : appeal.review_note,
        reviewerName: appeal.reviewer_name } });
    } catch (err) { next(err); }
    finally { client?.release(); }
  });
  router.get('/check', ready, async (req, res, next) => {
    try {
      const blocked = await req.appealManager.isBlocked(req.clientIp);
      res.json({ ipAddress: req.clientIp, isBlocked: blocked.blocked, reason: blocked.reason || null,
        expires: blocked.expires || null, riskScore: await req.appealManager.getRiskScore(req.clientIp),
        isWhitelisted: await req.appealManager.isWhitelisted(req.clientIp) });
    } catch (err) { next(err); }
  });
  return router;
}
module.exports = createIpAppealRouter();
module.exports.initIpAppealRoutes = initIpAppealRoutes;
module.exports.createIpAppealRouter = createIpAppealRouter;
