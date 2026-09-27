/**
 * REQ-00586 补全：反作弊申诉、地形区域管理、风控监控统计
 *
 * 玩家（网关 /v1/location/...）：
 *   POST /location/appeals          提交申诉（同一时间只能有一个待审核申诉）
 *   GET  /location/appeals          我的申诉与当前可信度
 * 管理员（网关 /api/admin/anticheat/...，网关已校验管理员）：
 *   GET  /anticheat/appeals?status=PENDING
 *   POST /anticheat/appeals/:id/decision   { decision: 'APPROVE'|'REJECT', note }
 *   GET  /anticheat/stats?hours=24         监控面板数据
 *   GET  /anticheat/zones  /  POST /anticheat/zones { name, kind, geojson }  /  DELETE /anticheat/zones/:id
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../../../shared/db');
const { requireAuth, requireAdmin, AppError, successResp } = require('../../../../shared/auth');
const { getTrustScore, getRiskLevel, restoreTrustScore, TRUST_SCORE } = require('../../../../shared/anti-cheat');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── 玩家：提交申诉 ────────────────────────────────────────────
router.post('/location/appeals', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const body = z.object({
      reason: z.string().trim().min(10).max(2000),
      evidence: z.object({
        device: z.string().max(200).optional(),
        scenario: z.string().max(500).optional(),
        contact: z.string().max(200).optional(),
      }).partial().optional(),
    }).parse(req.body || {});

    const trustScore = await getTrustScore(userId);
    const { rows: incidents } = await query(`
      SELECT type, severity, details, created_at FROM anti_cheat_records
       WHERE user_id = $1 AND type NOT IN ('TRUST_DECREASE', 'TRUST_INCREASE')
       ORDER BY created_at DESC LIMIT 20`, [userId]);
    if (trustScore >= TRUST_SCORE.INITIAL && incidents.length === 0) {
      throw new AppError(6010, '当前账号没有风控记录，无需申诉', 400);
    }
    try {
      const { rows: [appeal] } = await query(`
        INSERT INTO location_appeals (user_id, reason, evidence, trust_score_at_submit, incidents_snapshot)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, status, created_at`,
      [userId, body.reason, JSON.stringify(body.evidence || {}), trustScore, JSON.stringify(incidents)]);
      res.status(201).json(successResp({ ...appeal, trustScore }, '申诉已提交，我们会尽快审核'));
    } catch (err) {
      if (err.code === '23505') throw new AppError(6011, '已有待审核的申诉，请耐心等待', 409);
      throw err;
    }
  } catch (err) { next(err); }
});

// ── 玩家：我的申诉 ────────────────────────────────────────────
router.get('/location/appeals', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { rows } = await query(`
      SELECT id, status, reason, review_note, trust_score_at_submit, trust_score_after, reviewed_at, created_at
        FROM location_appeals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]);
    const trustScore = await getTrustScore(userId);
    res.json(successResp({ trustScore, riskLevel: getRiskLevel(trustScore), appeals: rows }));
  } catch (err) { next(err); }
});

// ── 管理员：申诉列表 ──────────────────────────────────────────
router.get('/anticheat/appeals', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    if (!['PENDING', 'APPROVED', 'REJECTED', 'ALL'].includes(status)) throw new AppError(1001, 'status 无效', 400);
    const { rows } = await query(`
      SELECT a.*, u.nickname FROM location_appeals a JOIN users u ON u.id = a.user_id
       WHERE ($1 = 'ALL' OR a.status = $1)
       ORDER BY a.created_at ASC LIMIT 100`, [status]);
    res.json(successResp({ status, appeals: rows }));
  } catch (err) { next(err); }
});

// ── 管理员：审核 ──────────────────────────────────────────────
router.post('/anticheat/appeals/:id/decision', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw new AppError(1001, '申诉 ID 无效', 400);
    const { decision, note } = z.object({
      decision: z.enum(['APPROVE', 'REJECT']),
      note: z.string().max(1000).optional(),
    }).parse(req.body || {});

    // 条件更新保证同一申诉只被审核一次（并发审核只有一个成功）
    const appeal = await transaction(async (client) => {
      const { rows: [a] } = await client.query(`
        UPDATE location_appeals
           SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW()
         WHERE id = $1 AND status = 'PENDING'
        RETURNING id, user_id, status`,
      [req.params.id, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', note || null, req.user.sub]);
      if (!a) throw new AppError(6012, '申诉不存在或已审核', 409);
      return a;
    });

    let trustScore = await getTrustScore(appeal.user_id);
    if (decision === 'APPROVE') {
      trustScore = await restoreTrustScore(appeal.user_id, 'APPEAL_APPROVED');
    }
    await query('UPDATE location_appeals SET trust_score_after = $2 WHERE id = $1', [appeal.id, trustScore]);
    await query(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES ($1, 'anticheat.appeal_decision', 'location_appeal', $2, $3)",
      [req.user.sub, appeal.id, JSON.stringify({ decision, targetUser: appeal.user_id, trustScore })]).catch(() => {});
    res.json(successResp({ id: appeal.id, status: appeal.status, userId: appeal.user_id, trustScore }));
  } catch (err) { next(err); }
});

// ── 管理员：监控面板数据 ──────────────────────────────────────
router.get('/anticheat/stats', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10) || 24, 1), 24 * 30);
    const [byType, timeline, appeals, blocked] = await Promise.all([
      query(`SELECT type, severity, COUNT(*)::int AS count, COUNT(DISTINCT user_id)::int AS users
               FROM anti_cheat_records
              WHERE created_at > NOW() - make_interval(hours => $1) AND type NOT IN ('TRUST_DECREASE', 'TRUST_INCREASE')
              GROUP BY type, severity ORDER BY count DESC`, [hours]),
      query(`SELECT date_trunc('hour', created_at) AS hour, COUNT(*)::int AS count
               FROM anti_cheat_records
              WHERE created_at > NOW() - make_interval(hours => $1) AND type NOT IN ('TRUST_DECREASE', 'TRUST_INCREASE')
              GROUP BY 1 ORDER BY 1`, [hours]),
      query(`SELECT status, COUNT(*)::int AS count FROM location_appeals GROUP BY status`),
      query(`SELECT COUNT(DISTINCT user_id)::int AS users FROM anti_cheat_records
              WHERE created_at > NOW() - make_interval(hours => $1) AND trust_score_after < $2`, [hours, TRUST_SCORE.THRESHOLD.RESTRICTED]),
    ]);
    res.json(successResp({
      hours,
      byType: byType.rows,
      timeline: timeline.rows,
      appeals: Object.fromEntries(appeals.rows.map((r) => [r.status, r.count])),
      restrictedUsers: blocked.rows[0].users,
      thresholds: TRUST_SCORE.THRESHOLD,
    }));
  } catch (err) { next(err); }
});

// ── 管理员：地形/禁入区域 ─────────────────────────────────────
router.get('/anticheat/zones', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, name, kind, source, active, ST_AsGeoJSON(area)::json AS geojson, created_at
                                    FROM geo_restricted_zones ORDER BY id`);
    res.json(successResp({ zones: rows }));
  } catch (err) { next(err); }
});

router.post('/anticheat/zones', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().trim().min(2).max(120),
      kind: z.enum(['water', 'restricted']),
      geojson: z.object({ type: z.enum(['Polygon', 'MultiPolygon']), coordinates: z.array(z.any()).min(1) }),
      source: z.string().max(200).optional(),
    }).parse(req.body || {});
    try {
      const { rows: [zone] } = await query(`
        INSERT INTO geo_restricted_zones (name, kind, area, source)
        VALUES ($1, $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))::geography, $4)
        RETURNING id, name, kind`, [body.name, body.kind, JSON.stringify(body.geojson), body.source || 'admin']);
      res.status(201).json(successResp(zone));
    } catch (err) {
      if (err.code === '23505') throw new AppError(6013, '区域名称已存在', 409);
      if (/GeoJSON|geometry|parse/i.test(err.message)) throw new AppError(1001, `GeoJSON 无效：${err.message}`, 400);
      throw err;
    }
  } catch (err) { next(err); }
});

router.delete('/anticheat/zones/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await query('UPDATE geo_restricted_zones SET active = FALSE WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
    if (!rowCount) throw new AppError(4004, '区域不存在', 404);
    res.json(successResp({ id: Number(req.params.id), active: false }));
  } catch (err) { next(err); }
});

module.exports = router;
