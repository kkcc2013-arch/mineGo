/**
 * REQ-00045: 设备完整性与模拟器检测系统
 * 设备管理路由
 * 
 * 创建时间: 2026-06-18
 */

'use strict';

const express = require('express');
const router = express.Router();
const deviceIntegrity = require('@pmg/shared/deviceIntegrity');
const { createLogger } = require('@pmg/shared/logger');
const { query } = require('@pmg/shared/db');

const logger = createLogger('device-routes');

/**
 * POST /api/device/register
 * 设备注册与完整性检测
 */
router.post('/register', async (req, res) => {
  try {
    const deviceInfo = req.body;
    const userId = req.user?.sub;
    
    if (!deviceInfo) {
      return res.status(400).json({
        code: 7100,
        message: '设备信息缺失',
        data: null,
      });
    }
    
    const result = await deviceIntegrity.registerDevice(deviceInfo, userId);
    
    logger.info({
      deviceId: result.device_id,
      userId,
      riskScore: result.risk_score,
      trustLevel: result.trust_level,
      action: result.action,
    }, 'Device registered');
    
    res.json({
      code: 0,
      message: 'success',
      data: {
        device_id: result.device_id,
        trust_level: result.trust_level,
        risk_score: result.risk_score,
        action: result.action,
        restrictions: result.restrictions,
        message: result.message,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Device registration failed');
    res.status(500).json({
      code: 7101,
      message: '设备注册失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/:deviceId
 * 获取设备信息
 */
router.get('/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    const device = await deviceIntegrity.getDevice(deviceId);
    
    if (!device) {
      return res.status(404).json({
        code: 7102,
        message: '设备不存在',
        data: null,
      });
    }
    
    // 获取关联账号
    const accounts = await deviceIntegrity.getDeviceAccounts(deviceId);
    
    res.json({
      code: 0,
      message: 'success',
      data: {
        device,
        accounts,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Get device failed');
    res.status(500).json({
      code: 7103,
      message: '获取设备信息失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/:deviceId/accounts
 * 获取设备关联的账号列表
 */
router.get('/:deviceId/accounts', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const accounts = await deviceIntegrity.getDeviceAccounts(deviceId);
    
    res.json({
      code: 0,
      message: 'success',
      data: accounts,
    });
  } catch (error) {
    logger.error({ error }, 'Get device accounts failed');
    res.status(500).json({
      code: 7104,
      message: '获取设备账号列表失败',
      data: { error: error.message },
    });
  }
});

/**
 * POST /api/device/:deviceId/ban
 * 封禁设备
 */
router.post('/:deviceId/ban', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { reason } = req.body;
    const adminId = req.user?.sub;
    
    if (!reason) {
      return res.status(400).json({
        code: 7105,
        message: '封禁原因不能为空',
        data: null,
      });
    }
    
    await deviceIntegrity.banDevice(deviceId, reason);
    
    logger.info({ deviceId, reason, adminId }, 'Device banned');
    
    res.json({
      code: 0,
      message: '设备已封禁',
      data: { device_id: deviceId },
    });
  } catch (error) {
    logger.error({ error }, 'Ban device failed');
    res.status(500).json({
      code: 7106,
      message: '封禁设备失败',
      data: { error: error.message },
    });
  }
});

/**
 * POST /api/device/:deviceId/unban
 * 解封设备
 */
router.post('/:deviceId/unban', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const adminId = req.user?.sub;
    
    await deviceIntegrity.unbanDevice(deviceId);
    
    logger.info({ deviceId, adminId }, 'Device unbanned');
    
    res.json({
      code: 0,
      message: '设备已解封',
      data: { device_id: deviceId },
    });
  } catch (error) {
    logger.error({ error }, 'Unban device failed');
    res.status(500).json({
      code: 7107,
      message: '解封设备失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/statistics/overview
 * 获取设备统计概览
 */
router.get('/statistics/overview', async (req, res) => {
  try {
    const { rows: [stats] } = await query('SELECT * FROM device_statistics');
    
    res.json({
      code: 0,
      message: 'success',
      data: stats,
    });
  } catch (error) {
    logger.error({ error }, 'Get device statistics failed');
    res.status(500).json({
      code: 7108,
      message: '获取设备统计失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/statistics/risky
 * 获取高风险设备列表
 */
router.get('/statistics/risky', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const { rows } = await query(`
      SELECT 
        device_id, model, brand, os_type, os_version,
        is_emulator, is_rooted, is_virtual_env, has_hook_framework,
        risk_score, trust_level, status,
        last_seen_at, first_seen_at
      FROM device_registrations
      WHERE risk_score >= 50
      ORDER BY risk_score DESC, last_seen_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      code: 0,
      message: 'success',
      data: rows,
    });
  } catch (error) {
    logger.error({ error }, 'Get risky devices failed');
    res.status(500).json({
      code: 7109,
      message: '获取高风险设备列表失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/statistics/emulators
 * 获取模拟器设备列表
 */
router.get('/statistics/emulators', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const { rows } = await query(`
      SELECT 
        device_id, model, brand, os_type, emulator_type,
        risk_score, trust_level, status,
        last_seen_at, first_seen_at
      FROM device_registrations
      WHERE is_emulator = TRUE
      ORDER BY last_seen_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      code: 0,
      message: 'success',
      data: rows,
    });
  } catch (error) {
    logger.error({ error }, 'Get emulator devices failed');
    res.status(500).json({
      code: 7110,
      message: '获取模拟器设备列表失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/statistics/cluster
 * 获取群控设备列表
 */
router.get('/statistics/cluster', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const { rows } = await query(`
      SELECT 
        dcd.device_id, dcd.account_count, dcd.cluster_type, dcd.risk_score,
        dcd.internal_transfer_count, dcd.internal_trade_count,
        dcd.status, dcd.first_detected_at, dcd.last_updated_at,
        dr.model, dr.brand, dr.os_type
      FROM device_cluster_detection dcd
      LEFT JOIN device_registrations dr ON dcd.device_id = dr.device_id
      WHERE dcd.is_cluster_device = TRUE
      ORDER BY dcd.account_count DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      code: 0,
      message: 'success',
      data: rows,
    });
  } catch (error) {
    logger.error({ error }, 'Get cluster devices failed');
    res.status(500).json({
      code: 7111,
      message: '获取群控设备列表失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/logs/:deviceId
 * 获取设备检测日志
 */
router.get('/logs/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const { rows } = await query(`
      SELECT 
        id, device_id, user_id, detection_result, risk_score, trust_level,
        action_taken, emulator_detected, root_detected, virtual_env_detected, hook_detected,
        client_version, check_duration_ms, created_at
      FROM device_integrity_logs
      WHERE device_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [deviceId, limit]);
    
    res.json({
      code: 0,
      message: 'success',
      data: rows,
    });
  } catch (error) {
    logger.error({ error }, 'Get device logs failed');
    res.status(500).json({
      code: 7112,
      message: '获取设备日志失败',
      data: { error: error.message },
    });
  }
});

/**
 * GET /api/device/rules
 * 获取设备风险规则列表
 */
router.get('/rules', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM device_risk_rules
      WHERE is_active = TRUE
      ORDER BY priority ASC
    `);
    
    res.json({
      code: 0,
      message: 'success',
      data: rows,
    });
  } catch (error) {
    logger.error({ error }, 'Get device rules failed');
    res.status(500).json({
      code: 7113,
      message: '获取设备规则失败',
      data: { error: error.message },
    });
  }
});

/**
 * PUT /api/device/rules/:ruleId
 * 更新设备风险规则
 */
router.put('/rules/:ruleId', async (req, res) => {
  try {
    const { ruleId } = req.params;
    const { base_score, action, restrictions, message, is_active } = req.body;
    
    const { rows: [rule] } = await query(`
      UPDATE device_risk_rules SET
        base_score = COALESCE($1, base_score),
        action = COALESCE($2, action),
        restrictions = COALESCE($3, restrictions),
        message = COALESCE($4, message),
        is_active = COALESCE($5, is_active),
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [base_score, action, restrictions, message, is_active, ruleId]);
    
    if (!rule) {
      return res.status(404).json({
        code: 7114,
        message: '规则不存在',
        data: null,
      });
    }
    
    logger.info({ ruleId, updates: req.body }, 'Device rule updated');
    
    res.json({
      code: 0,
      message: 'success',
      data: rule,
    });
  } catch (error) {
    logger.error({ error }, 'Update device rule failed');
    res.status(500).json({
      code: 7115,
      message: '更新设备规则失败',
      data: { error: error.message },
    });
  }
});

module.exports = router;
