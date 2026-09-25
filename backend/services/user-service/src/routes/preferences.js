// user-service/src/routes/preferences.js
// 通用用户偏好读写（user_preferences 表，按 namespace 存 JSONB）
//   GET    /users/me/preferences/:namespace   读取（无记录时 prefs=null）
//   PUT    /users/me/preferences/:namespace   覆盖保存 { prefs, clientUpdatedAt? }
//   DELETE /users/me/preferences/:namespace   删除（用户可随时清除云端副本）
// 客户端无障碍设置（namespace=a11y，Epic E21）经网关 /v1/users/me/preferences/a11y 同步。
'use strict';

const express = require('express');
const { query } = require('../../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const { validatePreferences, validateNamespace, PreferenceValidationError } = require('../services/userPreferences');

const logger = createLogger('user-service:preferences');
const router = express.Router();
router.use(requireAuth);

function toResp(row, namespace) {
  if (!row) return { namespace, prefs: null, version: 0, updatedAt: null, clientUpdatedAt: null };
  return {
    namespace: row.namespace,
    prefs: row.prefs,
    version: row.version,
    updatedAt: row.updated_at,
    clientUpdatedAt: row.client_updated_at,
  };
}

function badRequest(err) {
  if (err instanceof PreferenceValidationError) {
    const e = new AppError(1001, `偏好校验失败：${err.message}`, 400);
    e.field = err.field;
    return e;
  }
  return err;
}

router.get('/me/preferences/:namespace', async (req, res, next) => {
  try {
    const ns = validateNamespace(req.params.namespace);
    const { rows } = await query(
      `SELECT namespace, prefs, version, updated_at, client_updated_at
         FROM user_preferences WHERE user_id = $1 AND namespace = $2`,
      [req.user.sub, ns]
    );
    res.json(successResp(toResp(rows[0], ns)));
  } catch (err) { next(badRequest(err)); }
});

router.put('/me/preferences/:namespace', async (req, res, next) => {
  try {
    const ns = req.params.namespace;
    const body = req.body || {};
    const { prefs, flags } = validatePreferences(ns, body.prefs);
    let clientUpdatedAt = null;
    if (body.clientUpdatedAt !== undefined && body.clientUpdatedAt !== null) {
      const d = new Date(body.clientUpdatedAt);
      if (Number.isNaN(d.getTime())) throw new AppError(1001, 'clientUpdatedAt 非法', 400);
      clientUpdatedAt = d.toISOString();
    }
    const { rows } = await query(
      `INSERT INTO user_preferences (user_id, namespace, prefs, version, client_updated_at, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, $4, NOW())
       ON CONFLICT (user_id, namespace) DO UPDATE
         SET prefs = EXCLUDED.prefs,
             version = user_preferences.version + 1,
             client_updated_at = EXCLUDED.client_updated_at,
             updated_at = NOW()
       RETURNING namespace, prefs, version, updated_at, client_updated_at`,
      [req.user.sub, ns, JSON.stringify(prefs), clientUpdatedAt]
    );
    if (flags.slowMode) {
      // 慢速模式只作用于客户端表现；记录一条审计日志便于反作弊侧关联分析
      logger.info({ userId: req.user.sub, namespace: ns, pace: prefs.pace }, 'a11y slow mode enabled');
    }
    res.json(successResp({ ...toResp(rows[0], ns), flags }));
  } catch (err) { next(badRequest(err)); }
});

router.delete('/me/preferences/:namespace', async (req, res, next) => {
  try {
    const ns = validateNamespace(req.params.namespace);
    const { rowCount } = await query(
      'DELETE FROM user_preferences WHERE user_id = $1 AND namespace = $2',
      [req.user.sub, ns]
    );
    res.json(successResp({ namespace: ns, deleted: rowCount > 0 }));
  } catch (err) { next(badRequest(err)); }
});

module.exports = router;
