/**
 * REQ-00028: 行为异常检测 API 路由
 * 创建时间: 2026-06-05 21:25
 */

'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const logger = require('../logger');
const behaviorAnalyzer = require('../behaviorAnalyzer');

/**
 * POST /internal/anticheat/behavior/analyze
 * 触发用户行为分析
 */
router.post('/analyze', async (req, res, next) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    logger.info({ userId }, 'Starting behavior analysis');
    
    const result = await behaviorAnalyzer.calculateBehaviorTrustScore(userId);
    
    // 更新用户行为评分
    await query(`
      INSERT INTO user_behavior_scores (user_id, behavior_score, gps_trust_score, final_trust_score, last_analysis_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        behavior_score = EXCLUDED.behavior_score,
        gps_trust_score = EXCLUDED.gps_trust_score,
        final_trust_score = EXCLUDED.final_trust_score,
        last_analysis_at = NOW(),
        updated_at = NOW()
    `, [userId, result.behaviorScore, result.gpsTrustScore, result.finalScore]);
    
    // 记录异常
    if (result.anomalies.length > 0) {
      for (const anomaly of result.anomalies) {
        await behaviorAnalyzer.recordAnomaly(userId, anomaly, 100, result.behaviorScore);
      }
    }
    
    logger.info({ 
      userId, 
      behaviorScore: result.behaviorScore,
      anomalyCount: result.anomalies.length 
    }, 'Behavior analysis completed');
    
    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    logger.error({ err }, 'Behavior analysis failed');
    next(err);
  }
});

/**
 * GET /internal/anticheat/behavior/score/:userId
 * 查询用户行为评分
 */
router.get('/score/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    
    const result = await query(`
      SELECT 
        user_id, behavior_score, gps_trust_score, final_trust_score,
        last_analysis_at, created_at, updated_at
      FROM user_behavior_scores
      WHERE user_id = $1
    `, [userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User behavior score not found' });
    }
    
    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get behavior score');
    next(err);
  }
});

/**
 * GET /admin/anticheat/behavior/anomalies
 * 管理员查看行为异常记录
 */
router.get('/anomalies', async (req, res, next) => {
  try {
    const { type, severity, limit = 100, offset = 0 } = req.query;
    
    let sql = `
      SELECT 
        bar.id, bar.user_id, bar.anomaly_type, bar.severity, bar.details,
        bar.behavior_score_before, bar.behavior_score_after, bar.action_taken,
        bar.created_at,
        u.username
      FROM behavior_anomaly_records bar
      LEFT JOIN users u ON bar.user_id = u.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (type) {
      sql += ` AND bar.anomaly_type = $${paramIndex++}`;
      params.push(type);
    }
    
    if (severity) {
      sql += ` AND bar.severity = $${paramIndex++}`;
      params.push(severity);
    }
    
    sql += ` ORDER BY bar.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await query(sql, params);
    
    // 获取总数
    const countResult = await query(`
      SELECT COUNT(*) as total FROM behavior_anomaly_records
      WHERE ($1::text IS NULL OR anomaly_type = $1)
        AND ($2::text IS NULL OR severity = $2)
    `, [type || null, severity || null]);
    
    res.json({
      success: true,
      data: {
        anomalies: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get anomaly records');
    next(err);
  }
});

/**
 * GET /admin/anticheat/device/:deviceHash/accounts
 * 查询设备关联的所有账号
 */
router.get('/device/:deviceHash/accounts', async (req, res, next) => {
  try {
    const { deviceHash } = req.params;
    
    const result = await query(`
      SELECT 
        df.user_id,
        df.device_info,
        df.first_seen,
        df.last_seen,
        u.username,
        u.email,
        ubs.behavior_score,
        ubs.final_trust_score
      FROM device_fingerprints df
      LEFT JOIN users u ON df.user_id = u.id
      LEFT JOIN user_behavior_scores ubs ON df.user_id = ubs.user_id
      WHERE df.device_hash = $1
      ORDER BY df.last_seen DESC
    `, [deviceHash]);
    
    // 分析设备异常
    const deviceAnomaly = await behaviorAnalyzer.analyzeDeviceAnomaly(deviceHash);
    
    res.json({
      success: true,
      data: {
        deviceHash,
        accounts: result.rows,
        anomaly: deviceAnomaly,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get device accounts');
    next(err);
  }
});

/**
 * POST /internal/anticheat/device/fingerprint
 * 上报设备指纹
 */
router.post('/device/fingerprint', async (req, res, next) => {
  try {
    const { userId, deviceId, deviceInfo } = req.body;
    
    if (!userId || !deviceId) {
      return res.status(400).json({ error: 'userId and deviceId are required' });
    }
    
    // 生成设备哈希
    const crypto = require('crypto');
    const deviceHash = crypto
      .createHash('sha256')
      .update(`${deviceId}|${deviceInfo.platform || ''}|${deviceInfo.screenWidth || 0}x${deviceInfo.screenHeight || 0}`)
      .digest('hex')
      .substring(0, 16);
    
    const ipHash = req.ip ? crypto
      .createHash('sha256')
      .update(req.ip)
      .digest('hex')
      .substring(0, 16) : null;
    
    await query(`
      INSERT INTO device_fingerprints (
        user_id, device_hash, device_info, ip_hash, last_seen
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, device_hash)
      DO UPDATE SET
        device_info = EXCLUDED.device_info,
        ip_hash = EXCLUDED.ip_hash,
        last_seen = NOW()
    `, [userId, deviceHash, JSON.stringify(deviceInfo), ipHash]);
    
    // 检查设备关联异常
    const deviceAnomaly = await behaviorAnalyzer.analyzeDeviceAnomaly(deviceHash);
    
    if (deviceAnomaly) {
      logger.warn({ 
        deviceHash, 
        anomaly: deviceAnomaly 
      }, 'Device anomaly detected');
    }
    
    res.json({
      success: true,
      data: {
        deviceHash,
        anomaly: deviceAnomaly,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to record device fingerprint');
    next(err);
  }
});

/**
 * POST /internal/anticheat/catch/record
 * 记录捕捉尝试（用于成功率分析）
 */
router.post('/catch/record', async (req, res, next) => {
  try {
    const {
      userId,
      pokemonId,
      pokemonRarity,
      success,
      expectedRate,
      itemsUsed,
      technique,
      latitude,
      longitude,
    } = req.body;
    
    if (!userId || !pokemonId || !pokemonRarity || success === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    await query(`
      INSERT INTO catch_attempts (
        user_id, pokemon_id, pokemon_rarity, success,
        expected_rate, actual_items_used, technique,
        latitude, longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      userId,
      pokemonId,
      pokemonRarity,
      success,
      expectedRate,
      JSON.stringify(itemsUsed || []),
      technique || null,
      latitude || null,
      longitude || null,
    ]);
    
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to record catch attempt');
    next(err);
  }
});

/**
 * POST /internal/anticheat/action/record
 * 记录用户行为事件
 */
router.post('/action/record', async (req, res, next) => {
  try {
    const {
      userId,
      actionType,
      actionData,
      latitude,
      longitude,
      deviceHash,
    } = req.body;
    
    if (!userId || !actionType) {
      return res.status(400).json({ error: 'userId and actionType are required' });
    }
    
    const crypto = require('crypto');
    const ipHash = req.ip ? crypto
      .createHash('sha256')
      .update(req.ip)
      .digest('hex')
      .substring(0, 16) : null;
    
    await query(`
      INSERT INTO user_action_events (
        user_id, action_type, action_data,
        latitude, longitude, device_hash, ip_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      userId,
      actionType,
      JSON.stringify(actionData || {}),
      latitude || null,
      longitude || null,
      deviceHash || null,
      ipHash,
    ]);
    
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to record action event');
    next(err);
  }
});

/**
 * GET /admin/anticheat/stats
 * 获取反作弊统计信息
 */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await query(`
      SELECT 
        anomaly_type,
        severity,
        COUNT(*) as count,
        COUNT(DISTINCT user_id) as unique_users
      FROM behavior_anomaly_records
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY anomaly_type, severity
      ORDER BY count DESC
    `);
    
    const lowTrustUsers = await query(`
      SELECT COUNT(DISTINCT user_id) as count
      FROM user_behavior_scores
      WHERE final_trust_score < 50
    `);
    
    const avgScore = await query(`
      SELECT AVG(final_trust_score) as avg_score
      FROM user_behavior_scores
    `);
    
    res.json({
      success: true,
      data: {
        anomalies: stats.rows,
        lowTrustUsers: parseInt(lowTrustUsers.rows[0].count),
        avgTrustScore: parseFloat(avgScore.rows[0].avg_score || 100).toFixed(2),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get anticheat stats');
    next(err);
  }
});

module.exports = router;
