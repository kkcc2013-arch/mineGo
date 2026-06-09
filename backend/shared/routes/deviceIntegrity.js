/**
 * REQ-00045: 设备完整性 API 路由
 * 
 * 创建时间: 2026-06-09 07:00
 */

'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const deviceIntegrity = require('../deviceIntegrity');
const { requireAuth, AppError, successResp } = require('../auth');
const { createLogger } = require('../logger');

const logger = createLogger('device-api');

/**
 * POST /api/device/register
 * 注册或更新设备信息
 */
router.post('/register', requireAuth, async (req, res, next) => {
  try {
    const deviceInfo = req.body;
    const userId = req.user.sub;
    
    if (!deviceInfo) {
      throw new AppError(7010, '设备信息不能为空', 400);
    }
    
    // 执行设备注册
    const result = await deviceIntegrity.registerDevice(deviceInfo, userId);
    
    // 返回结果
    res.json(successResp({
      device_id: result.device_id,
      risk_score: result.risk_score,
      trust_level: result.trust_level,
      action: result.action,
      restrictions: result.restrictions,
      message: result.message,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/device/:deviceId
 * 获取设备信息
 */
router.get('/:deviceId', requireAuth, async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    const userId = req.user.sub;
    
    const device = await deviceIntegrity.getDevice(deviceId);
    
    if (!device) {
      throw new AppError(7011, '设备不存在', 404);
    }
    
    // 验证权限（只能查看自己关联的设备）
    const accounts = await deviceIntegrity.getDeviceAccounts(deviceId);
    const isOwner = accounts.some(a => a.user_id === userId);
    
    if (!isOwner && req.user.role !== 'admin') {
      throw new AppError(7012, '无权查看该设备', 403);
    }
    
    res.json(successResp({
      device_id: device.device_id,
      brand: device.brand,
      model: device.model,
      os_type: device.os_type,
      os_version: device.os_version,
      is_emulator: device.is_emulator,
      is_rooted: device.is_rooted,
      is_jailbroken: device.is_jailbroken,
      is_virtual_env: device.is_virtual_env,
      has_hook_framework: device.has_hook_framework,
      risk_score: device.risk_score,
      trust_level: device.trust_level,
      status: device.status,
      restrictions: device.restrictions,
      first_seen_at: device.first_seen_at,
      last_seen_at: device.last_seen_at,
      account_count: accounts.length,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/device/:deviceId/accounts
 * 获取设备关联的账号列表（管理员）
 */
router.get('/:deviceId/accounts', requireAuth, async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    
    // 只有管理员可以查看
    if (req.user.role !== 'admin') {
      throw new AppError(7013, '无权执行此操作', 403);
    }
    
    const accounts = await deviceIntegrity.getDeviceAccounts(deviceId);
    
    res.json(successResp({
      device_id: deviceId,
      accounts: accounts.map(a => ({
        user_id: a.user_id,
        first_login_at: a.first_login_at,
        last_login_at: a.last_login_at,
        login_count: a.login_count,
        is_primary_device: a.is_primary_device,
      })),
      total: accounts.length,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/device/user/devices
 * 获取当前用户关联的所有设备
 */
router.get('/user/devices', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    
    const { rows } = await query(`
      SELECT 
        d.device_id, d.brand, d.model, d.os_type, d.os_version,
        d.is_emulator, d.is_rooted, d.risk_score, d.trust_level, d.status,
        da.first_login_at, da.last_login_at, da.login_count, da.is_primary_device
      FROM device_account_associations da
      JOIN device_registrations d ON d.device_id = da.device_id
      WHERE da.user_id = $1
      ORDER BY da.last_login_at DESC
    `, [userId]);
    
    res.json(successResp({
      devices: rows,
      total: rows.length,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/device/:deviceId/ban
 * 封禁设备（管理员）
 */
router.post('/:deviceId/ban', requireAuth, async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    const { reason } = req.body;
    
    // 只有管理员可以封禁
    if (req.user.role !== 'admin') {
      throw new AppError(7014, '无权执行此操作', 403);
    }
    
    if (!reason) {
      throw new AppError(7015, '封禁原因不能为空', 400);
    }
    
    await deviceIntegrity.banDevice(deviceId, reason);
    
    logger.info({ deviceId, reason, operator: req.user.sub }, 'Device banned');
    
    res.json(successResp({
      device_id: deviceId,
      status: 'BANNED',
      reason,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/device/:deviceId/unban
 * 解封设备（管理员）
 */
router.post('/:deviceId/unban', requireAuth, async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    
    // 只有管理员可以解封
    if (req.user.role !== 'admin') {
      throw new AppError(7016, '无权执行此操作', 403);
    }
    
    await deviceIntegrity.unbanDevice(deviceId);
    
    logger.info({ deviceId, operator: req.user.sub }, 'Device unbanned');
    
    res.json(successResp({
      device_id: deviceId,
      status: 'ACTIVE',
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/device/stats/overview
 * 获取设备统计概览（管理员）
 */
router.get('/stats/overview', requireAuth, async (req, res, next) => {
  try {
    // 只有管理员可以查看
    if (req.user.role !== 'admin') {
      throw new AppError(7017, '无权执行此操作', 403);
    }
    
    const { rows: [stats] } = await query('SELECT * FROM device_statistics');
    
    res.json(successResp(stats));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/device/stats/high-risk
 * 获取高风险设备列表（管理员）
 */
router.get('/stats/high-risk', requireAuth, async (req, res, next) => {
  try {
    // 只有管理员可以查看
    if (req.user.role !== 'admin') {
      throw new AppError(7018, '无权执行此操作', 403);
    }
    
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    
    const { rows } = await query(`
      SELECT device_id, brand, model, os_type, risk_score, trust_level, status,
             is_emulator, is_rooted, is_virtual_env, has_hook_framework,
             first_seen_at, last_seen_at, banned_at, ban_reason
      FROM device_registrations
      WHERE risk_score >= 50
      ORDER BY risk_score DESC, last_seen_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json(successResp({
      devices: rows,
      total: rows.length,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/device/stats/cluster
 * 获取群控设备列表（管理员）
 */
router.get('/stats/cluster', requireAuth, async (req, res, next) => {
  try {
    // 只有管理员可以查看
    if (req.user.role !== 'admin') {
      throw new AppError(7019, '无权执行此操作', 403);
    }
    
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    
    const { rows } = await query(`
      SELECT device_id, account_count, internal_transfer_count, internal_trade_count,
             is_cluster_device, cluster_type, risk_score, status, 
             first_detected_at, last_updated_at
      FROM device_cluster_detection
      WHERE is_cluster_device = TRUE OR account_count > 3
      ORDER BY account_count DESC, risk_score DESC
      LIMIT $1
    `, [limit]);
    
    res.json(successResp({
      devices: rows,
      total: rows.length,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/device/rules
 * 获取风险规则列表（管理员）
 */
router.get('/rules', requireAuth, async (req, res, next) => {
  try {
    // 只有管理员可以查看
    if (req.user.role !== 'admin') {
      throw new AppError(7020, '无权执行此操作', 403);
    }
    
    const { rows } = await query(`
      SELECT id, rule_name, rule_type, base_score, action, restrictions, message,
             is_active, priority, created_at, updated_at
      FROM device_risk_rules
      ORDER BY priority, rule_name
    `);
    
    res.json(successResp({
      rules: rows,
      total: rows.length,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/device/rules/:ruleId
 * 更新风险规则（管理员）
 */
router.put('/rules/:ruleId', requireAuth, async (req, res, next) => {
  try {
    const { ruleId } = req.params;
    const { base_score, action, restrictions, message, is_active } = req.body;
    
    // 只有管理员可以修改
    if (req.user.role !== 'admin') {
      throw new AppError(7021, '无权执行此操作', 403);
    }
    
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
      throw new AppError(7022, '规则不存在', 404);
    }
    
    logger.info({ ruleId, updates: req.body, operator: req.user.sub }, 'Risk rule updated');
    
    res.json(successResp(rule));
  } catch (err) {
    next(err);
  }
});

module.exports = router;