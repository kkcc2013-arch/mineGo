/**
 * REQ-00369：捕捉连击 API（挂在 /catch/combo，经网关 /v1/catch/combo/* 访问，网关已统一鉴权）
 *
 *   GET  /catch/combo/status              当前连击（跨设备同步：以服务端为准）
 *   GET  /catch/combo/history?limit=20    连击历史
 *   GET  /catch/combo/leaderboard?limit=  最高连击排行榜（含自己的名次）
 *   POST /catch/combo/protection          使用连击保护道具 { itemId: 'COMBO_SHIELD' }
 *   POST /catch/combo/reset               手动重置（忽略保护，写历史 end_reason=manual_reset）
 *   GET  /catch/combo/rewards             奖励档位配置
 *   PUT  /catch/combo/rewards             运营更新档位（管理员）{ tiers: [...] }
 */
'use strict';

const express = require('express');
const { requireAuth, requireAdmin, successResp } = require('../../../../shared/auth');
const rules = require('./comboRules');

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createComboRouter(getService) {
  const router = express.Router();
  const svc = () => getService();

  // GET /v1/catch/combo/status — 当前连击状态（需登录）
  router.get('/status', requireAuth, wrap(async (req, res) => {
    res.json(successResp(await svc().getStatus(req.user.sub)));
  }));

  // GET /v1/catch/combo/history — 连击历史（需登录）
  router.get('/history', requireAuth, wrap(async (req, res) => {
    res.json(successResp({ history: await svc().getHistory(req.user.sub, req.query.limit) }));
  }));

  // GET /v1/catch/combo/leaderboard — 最高连击排行榜（需登录）
  router.get('/leaderboard', requireAuth, wrap(async (req, res) => {
    res.json(successResp(await svc().getLeaderboard(req.query.limit, req.user.sub)));
  }));

  // POST /v1/catch/combo/protection — 使用连击保护道具（需登录）
  router.post('/protection', requireAuth, wrap(async (req, res) => {
    const itemId = String((req.body && req.body.itemId) || 'COMBO_SHIELD').toUpperCase();
    res.json(successResp(await svc().useProtection(req.user.sub, itemId)));
  }));

  // POST /v1/catch/combo/reset — 手动重置连击（需登录）
  router.post('/reset', requireAuth, wrap(async (req, res) => {
    res.json(successResp(await svc().recordCatchFailure(req.user.sub, { reason: 'manual_reset', force: true })));
  }));

  // GET /v1/catch/combo/rewards — 连击奖励档位配置（需登录）
  router.get('/rewards', requireAuth, wrap(async (req, res) => {
    const tiers = await svc().getTiers();
    res.json(successResp({ tiers, config: { ...rules.DEFAULT_CONFIG, ...svc().config } }));
  }));

  // PUT /v1/catch/combo/rewards — 更新连击奖励档位（管理员）
  router.put('/rewards', requireAuth, requireAdmin, wrap(async (req, res) => {
    const tiers = await svc().replaceTiers(req.body && req.body.tiers, req.user.sub);
    res.json(successResp({ tiers }));
  }));

  return router;
}

/**
 * 里程碑站内通知：E13 的 shared/notificationCenter 合入后自动启用（dedupe 防重复），否则只记日志
 */
function createMilestoneNotifier(logger) {
  let center = null;
  try { center = require('../../../../shared/notificationCenter'); } catch { center = null; }
  return async ({ userId, milestone, maxCombo }) => {
    logger.info({ userId, milestone, maxCombo }, 'catch combo milestone reached');
    if (!center || typeof center.notify !== 'function') return;
    const db = require('../../../../shared/db');
    await center.notify(db, userId, {
      type: 'reward.combo_milestone',
      category: 'reward',
      title: `捕捉连击达成 ${milestone} 连！`,
      body: `你已连续捕捉 ${milestone} 只精灵，里程碑奖励已发放到背包。`,
      params: { milestone, maxCombo },
      data: { milestone, maxCombo },
      icon: '🔥',
      actionUrl: '/catch/combo',
      dedupeKey: `combo_milestone:${milestone}:${new Date().toISOString().slice(0, 13)}`,
    });
  };
}

module.exports = { createComboRouter, createMilestoneNotifier };
