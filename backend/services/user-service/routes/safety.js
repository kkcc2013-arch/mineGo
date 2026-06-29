/**
 * 用户安全偏好 API 路由
 * REQ-00356: 游戏光敏性癫痫防护与运动敏感性设置系统
 */

const express = require('express');
const router = express.Router();
const { query } = require('../database/connection');
const logger = require('../shared/logger');

/**
 * GET /api/safety/preferences
 * 获取当前用户的安全偏好设置
 */
router.get('/preferences', async (req, res) => {
  try {
    const userId = req.user?.sub || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: user ID required'
      });
    }

    const { rows: [prefs] } = await query(
      `SELECT * FROM user_safety_preferences WHERE user_id = $1`,
      [userId]
    );

    // 默认偏好
    const defaultPrefs = {
      epilepsy_protection: 'moderate',
      motion_sensitivity_enabled: false,
      max_flash_hz: 3.0,
      max_contrast_ratio: 4.5,
      rotation_reduction: 0.5,
      translation_reduction: 0.3,
      scaling_reduction: 0.4,
      parallax_reduction: 0.6,
      particles_reduction: 0.5,
      safe_evolution: true,
      safe_battle_effects: true,
      safe_weather_effects: true,
      safe_gym_flashes: true
    };

    res.json({
      success: true,
      data: prefs || defaultPrefs
    });
  } catch (error) {
    logger.error('Failed to get safety preferences', {
      userId: req.user?.sub,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve safety preferences'
    });
  }
});

/**
 * PUT /api/safety/preferences
 * 更新用户安全偏好设置
 */
router.put('/preferences', async (req, res) => {
  try {
    const userId = req.user?.sub || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: user ID required'
      });
    }

    const {
      epilepsy_protection,
      motion_sensitivity_enabled,
      max_flash_hz,
      max_contrast_ratio,
      rotation_reduction,
      translation_reduction,
      scaling_reduction,
      parallax_reduction,
      particles_reduction,
      safe_evolution,
      safe_battle_effects,
      safe_weather_effects,
      safe_gym_flashes
    } = req.body;

    // 验证输入
    const validProtectionLevels = ['off', 'moderate', 'strong'];
    if (epilepsy_protection && !validProtectionLevels.includes(epilepsy_protection)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid epilepsy_protection value. Must be: off, moderate, or strong'
      });
    }

    const { rows: [prefs] } = await query(
      `INSERT INTO user_safety_preferences (
        user_id, epilepsy_protection, motion_sensitivity_enabled,
        max_flash_hz, max_contrast_ratio,
        rotation_reduction, translation_reduction, scaling_reduction,
        parallax_reduction, particles_reduction,
        safe_evolution, safe_battle_effects, safe_weather_effects, safe_gym_flashes,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        epilepsy_protection = EXCLUDED.epilepsy_protection,
        motion_sensitivity_enabled = EXCLUDED.motion_sensitivity_enabled,
        max_flash_hz = EXCLUDED.max_flash_hz,
        max_contrast_ratio = EXCLUDED.max_contrast_ratio,
        rotation_reduction = EXCLUDED.rotation_reduction,
        translation_reduction = EXCLUDED.translation_reduction,
        scaling_reduction = EXCLUDED.scaling_reduction,
        parallax_reduction = EXCLUDED.parallax_reduction,
        particles_reduction = EXCLUDED.particles_reduction,
        safe_evolution = EXCLUDED.safe_evolution,
        safe_battle_effects = EXCLUDED.safe_battle_effects,
        safe_weather_effects = EXCLUDED.safe_weather_effects,
        safe_gym_flashes = EXCLUDED.safe_gym_flashes,
        updated_at = NOW()
      RETURNING *`,
      [
        userId,
        epilepsy_protection || 'moderate',
        motion_sensitivity_enabled || false,
        max_flash_hz || 3.0,
        max_contrast_ratio || 4.5,
        rotation_reduction || 0.5,
        translation_reduction || 0.3,
        scaling_reduction || 0.4,
        parallax_reduction || 0.6,
        particles_reduction || 0.5,
        safe_evolution !== false,
        safe_battle_effects !== false,
        safe_weather_effects !== false,
        safe_gym_flashes !== false
      ]
    );

    // 记录偏好变更
    logger.info('Safety preferences updated', {
      userId,
      protectionLevel: epilepsy_protection,
      motionSensitivity: motion_sensitivity_enabled
    });

    res.json({
      success: true,
      data: prefs,
      message: 'Safety preferences updated successfully'
    });
  } catch (error) {
    logger.error('Failed to update safety preferences', {
      userId: req.user?.sub,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to update safety preferences'
    });
  }
});

/**
 * GET /api/safety/rules
 * 获取动画安全规则列表
 */
router.get('/rules', async (req, res) => {
  try {
    const { danger_level, category } = req.query;

    let sql = `SELECT * FROM animation_safety_rules WHERE 1=1`;
    const params = [];

    if (danger_level) {
      params.push(danger_level);
      sql += ` AND danger_level = $${params.length}`;
    }

    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }

    sql += ` ORDER BY danger_level DESC, flash_frequency DESC`;

    const { rows } = await query(sql, params);

    res.json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    logger.error('Failed to get animation safety rules', { error: error.message });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve safety rules'
    });
  }
});

/**
 * GET /api/safety/rules/:animationId
 * 获取特定动画的安全规则
 */
router.get('/rules/:animationId', async (req, res) => {
  try {
    const { animationId } = req.params;

    const { rows: [rule] } = await query(
      `SELECT * FROM animation_safety_rules WHERE animation_id = $1`,
      [animationId]
    );

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Animation rule not found'
      });
    }

    res.json({
      success: true,
      data: rule
    });
  } catch (error) {
    logger.error('Failed to get animation rule', {
      animationId: req.params.animationId,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve animation rule'
    });
  }
});

/**
 * POST /api/safety/check-animation
 * 检查动画安全性
 */
router.post('/check-animation', async (req, res) => {
  try {
    const { animation_id, frames, user_id } = req.body;

    // 获取动画规则
    const { rows: [rule] } = await query(
      `SELECT * FROM animation_safety_rules WHERE animation_id = $1`,
      [animation_id]
    );

    if (!rule) {
      return res.json({
        success: true,
        data: {
          safe: true,
          risk_level: 'unknown',
          message: 'No safety rules defined for this animation'
        }
      });
    }

    // 分析帧数据（如果提供）
    let analysis = {
      safe: true,
      flash_frequency: rule.flash_frequency,
      motion_intensity: rule.motion_intensity
    };

    if (frames && frames.length > 0) {
      // 简化的闪光分析
      let flashCount = 0;
      for (let i = 1; i < frames.length; i++) {
        const delta = Math.abs((frames[i].brightness || 0) - (frames[i-1].brightness || 0));
        if (delta > 0.2) flashCount++;
      }
      
      analysis.flash_frequency = flashCount / (frames.length / 60); // 假设60fps
      analysis.safe = analysis.flash_frequency <= 3;
    }

    // 判断风险等级
    const riskLevel = rule.danger_level;
    const isSafe = analysis.safe && riskLevel !== 'critical';

    res.json({
      success: true,
      data: {
        safe: isSafe,
        risk_level: riskLevel,
        flash_frequency: analysis.flash_frequency,
        motion_intensity: analysis.motion_intensity,
        recommendation: isSafe ? 'safe' : 'use_alternative',
        alternatives: {
          moderate: rule.moderate_alternative,
          strong: rule.strong_alternative,
          static: rule.static_fallback
        }
      }
    });

    // 记录检查事件
    if (!isSafe && user_id) {
      await query(
        `INSERT INTO safety_event_log (user_id, event_type, animation_id, severity, flash_frequency, motion_intensity, action_taken)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user_id, 'animation_check', animation_id, riskLevel, analysis.flash_frequency, analysis.motion_intensity, 'check_complete']
      );
    }
  } catch (error) {
    logger.error('Failed to check animation safety', { error: error.message });

    res.status(500).json({
      success: false,
      error: 'Failed to check animation safety'
    });
  }
});

/**
 * POST /api/safety/event
 * 记录安全事件
 */
router.post('/event', async (req, res) => {
  try {
    const {
      user_id,
      event_type,
      animation_id,
      severity,
      flash_frequency,
      motion_intensity,
      action_taken,
      alternative_applied,
      game_context
    } = req.body;

    const { rows: [event] } = await query(
      `INSERT INTO safety_event_log (
        user_id, event_type, animation_id, severity, 
        flash_frequency, motion_intensity, 
        action_taken, alternative_applied, game_context
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [user_id, event_type, animation_id, severity || 'info', 
       flash_frequency, motion_intensity,
       action_taken, alternative_applied, game_context || {}]
    );

    logger.warn('Safety event recorded', {
      userId: user_id,
      eventType: event_type,
      severity,
      animationId: animation_id
    });

    res.json({
      success: true,
      data: event,
      message: 'Safety event recorded'
    });
  } catch (error) {
    logger.error('Failed to record safety event', { error: error.message });

    res.status(500).json({
      success: false,
      error: 'Failed to record safety event'
    });
  }
});

/**
 * GET /api/safety/events
 * 获取安全事件日志
 */
router.get('/events', async (req, res) => {
  try {
    const userId = req.user?.sub || req.headers['x-user-id'];
    const { limit = 50, severity } = req.query;

    let sql = `SELECT * FROM safety_event_log WHERE user_id = $1`;
    const params = [userId];

    if (severity) {
      params.push(severity);
      sql += ` AND severity = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const { rows } = await query(sql, params);

    res.json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    logger.error('Failed to get safety events', { error: error.message });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve safety events'
    });
  }
});

/**
 * GET /api/safety/stats
 * 获取安全统计数据
 */
router.get('/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await query(`
      SELECT 
        COUNT(*) as total_events,
        COUNT(CASE WHEN severity = 'critical' THEN 1 END) as critical_events,
        COUNT(CASE WHEN severity = 'danger' THEN 1 END) as danger_events,
        COUNT(CASE WHEN severity = 'warning' THEN 1 END) as warning_events,
        COUNT(CASE WHEN event_type = 'flash_danger' THEN 1 END) as flash_dangers,
        COUNT(CASE WHEN event_type = 'motion_danger' THEN 1 END) as motion_dangers,
        AVG(flash_frequency) as avg_flash_frequency
      FROM safety_event_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    const { rows: protectionDist } = await query(`
      SELECT 
        epilepsy_protection,
        COUNT(*) as user_count
      FROM user_safety_preferences
      GROUP BY epilepsy_protection
    `);

    res.json({
      success: true,
      data: {
        events: stats,
        protection_distribution: protectionDist
      }
    });
  } catch (error) {
    logger.error('Failed to get safety stats', { error: error.message });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve safety statistics'
    });
  }
});

module.exports = router;