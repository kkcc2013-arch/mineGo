/**
 * Security Report Controller - 安全违规报告处理控制器
 * 
 * 功能：
 * - 接收客户端内存违规报告
 * - 分析并存储违规数据
 * - 触发风控决策
 * - 生成安全审计日志
 * 
 * @module backend/security/controllers/securityReportController
 */

'use strict';

const crypto = require('crypto');
const { db } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');
const EventBus = require('../../../shared/EventBus');
const { EVENTS } = require('../../../shared/events');

const logger = createLogger('security-report');

class SecurityReportController {
  constructor() {
    this.violationThresholds = {
      low: 5,      // 轻度违规阈值
      medium: 10,  // 中度违规阈值
      high: 20,    // 高度违规阈值
      critical: 30 // 严重违规阈值
    };
    
    this.actions = {
      low: 'warn',
      medium: 'restrict',
      high: 'suspend',
      critical: 'ban'
    };
  }

  /**
   * 处理内存违规报告
   */
  async handleMemoryViolation(req, res) {
    const startTime = Date.now();
    const userId = req.userId;
    const report = req.body;

    try {
      logger.warn('Memory violation reported', {
        userId,
        region: report.region,
        critical: report.critical,
        scanCount: report.scanCount
      });

      // 1. 记录违规
      const violation = await this.recordViolation(userId, report);

      // 2. 分析违规模式
      const analysis = await this.analyzeViolationPattern(userId);

      // 3. 决定响应动作
      const action = this.determineAction(analysis);

      // 4. 执行动作
      if (action !== 'none') {
        await this.executeAction(userId, action, violation);
      }

      // 5. 记录指标
      metrics.increment('security_violations_total', 1, {
        region: report.region,
        critical: report.critical ? 'true' : 'false',
        action
      });

      metrics.timing('security_violation_processing_duration', Date.now() - startTime);

      res.json({
        success: true,
        violationId: violation.id,
        action,
        message: this.getActionMessage(action)
      });

    } catch (error) {
      logger.error('Failed to handle memory violation', {
        userId,
        error: error.message,
        stack: error.stack
      });

      metrics.increment('security_violation_errors', 1);

      res.status(500).json({
        error: 'FAILED_TO_PROCESS_VIOLATION',
        message: 'Internal server error'
      });
    }
  }

  /**
   * 处理调试检测报告
   */
  async handleDebugDetection(req, res) {
    const userId = req.userId;
    const report = req.body;

    try {
      logger.warn('Debug detection reported', {
        userId,
        type: report.type,
        url: report.url
      });

      // 记录调试检测
      await this.recordDebugDetection(userId, report);

      // 调试检测视为高风险行为
      const analysis = await this.analyzeViolationPattern(userId);
      
      if (analysis.recentViolations >= 3) {
        // 多次检测到调试器，可能正在被逆向
        await this.executeAction(userId, 'restrict', {
          reason: 'MULTIPLE_DEBUG_DETECTIONS',
          timestamp: Date.now()
        });
      }

      metrics.increment('security_debug_detections_total', 1, {
        type: report.type
      });

      res.json({
        success: true,
        message: 'Debug detection recorded'
      });

    } catch (error) {
      logger.error('Failed to handle debug detection', {
        userId,
        error: error.message
      });

      res.status(500).json({
        error: 'FAILED_TO_PROCESS_DEBUG_DETECTION'
      });
    }
  }

  /**
   * 记录违规
   */
  async recordViolation(userId, report) {
    const violationId = crypto.randomUUID();

    const violation = {
      id: violationId,
      user_id: userId,
      type: 'MEMORY_VIOLATION',
      region: report.region,
      expected_hash: report.expected,
      actual_hash: report.actual,
      critical: report.critical || false,
      scan_count: report.scanCount,
      total_violations: report.totalViolations,
      user_agent: report.userAgent,
      url: report.url,
      memory_snapshot: report.memorySnapshot ? JSON.stringify(report.memorySnapshot) : null,
      created_at: new Date()
    };

    // 存储到数据库
    await db('security_violations').insert(violation);

    // 发布事件
    await EventBus.publish(EVENTS.SECURITY_VIOLATION, {
      violationId,
      userId,
      type: violation.type,
      region: violation.region,
      critical: violation.critical
    });

    return violation;
  }

  /**
   * 记录调试检测
   */
  async recordDebugDetection(userId, report) {
    const detectionId = crypto.randomUUID();

    await db('security_violations').insert({
      id: detectionId,
      user_id: userId,
      type: 'DEBUG_DETECTION',
      region: 'DEBUG',
      critical: true,
      metadata: JSON.stringify({
        detectionType: report.type,
        url: report.url,
        userAgent: report.userAgent
      }),
      created_at: new Date()
    });

    // 发布事件
    await EventBus.publish(EVENTS.SECURITY_DEBUG_DETECTED, {
      detectionId,
      userId,
      type: report.type
    });
  }

  /**
   * 分析违规模式
   */
  async analyzeViolationPattern(userId) {
    // 获取最近的违规记录
    const recentViolations = await db('security_violations')
      .where('user_id', userId)
      .where('created_at', '>', db.raw("NOW() - INTERVAL '1 hour'"))
      .count('* as count')
      .first();

    // 获取关键违规数量
    const criticalViolations = await db('security_violations')
      .where('user_id', userId)
      .where('critical', true)
      .where('created_at', '>', db.raw("NOW() - INTERVAL '24 hours'"))
      .count('* as count')
      .first();

    // 获取违规类型分布
    const violationTypes = await db('security_violations')
      .where('user_id', userId)
      .where('created_at', '>', db.raw("NOW() - INTERVAL '24 hours'"))
      .groupBy('type')
      .select('type', db.raw('COUNT(*) as count'));

    return {
      recentViolations: parseInt(recentViolations.count, 10),
      criticalViolations: parseInt(criticalViolations.count, 10),
      violationTypes: violationTypes.reduce((acc, v) => {
        acc[v.type] = v.count;
        return acc;
      }, {})
    };
  }

  /**
   * 决定响应动作
   */
  determineAction(analysis) {
    const { recentViolations, criticalViolations } = analysis;

    // 根据违规次数决定动作
    if (criticalViolations >= this.violationThresholds.critical) {
      return 'ban';
    }

    if (recentViolations >= this.violationThresholds.high || 
        criticalViolations >= this.violationThresholds.high) {
      return 'suspend';
    }

    if (recentViolations >= this.violationThresholds.medium || 
        criticalViolations >= this.violationThresholds.medium) {
      return 'restrict';
    }

    if (recentViolations >= this.violationThresholds.low) {
      return 'warn';
    }

    return 'none';
  }

  /**
   * 执行安全动作
   */
  async executeAction(userId, action, violation) {
    logger.info('Executing security action', {
      userId,
      action,
      violationId: violation.id
    });

    switch (action) {
      case 'warn':
        await this.sendWarning(userId, violation);
        break;

      case 'restrict':
        await this.applyRestrictions(userId, violation);
        break;

      case 'suspend':
        await this.suspendAccount(userId, violation);
        break;

      case 'ban':
        await this.banAccount(userId, violation);
        break;
    }

    // 记录动作
    await db('security_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      action,
      reason: violation.reason || 'SECURITY_VIOLATION',
      violation_id: violation.id,
      created_at: new Date()
    });

    // 发布事件
    await EventBus.publish(EVENTS.SECURITY_ACTION, {
      userId,
      action,
      reason: violation.reason || 'SECURITY_VIOLATION'
    });
  }

  /**
   * 发送警告
   */
  async sendWarning(userId, violation) {
    // 通过推送或站内信发送警告
    await EventBus.publish(EVENTS.NOTIFICATION_SEND, {
      userId,
      type: 'security_warning',
      data: {
        message: '检测到异常游戏行为，请正常游戏。',
        violationType: violation.type
      }
    });
  }

  /**
   * 应用限制
   */
  async applyRestrictions(userId, violation) {
    // 添加到限制用户列表
    await db('user_restrictions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      restriction_type: 'trading_blocked',
      reason: 'SECURITY_VIOLATION',
      expires_at: db.raw("NOW() + INTERVAL '7 days'"),
      created_at: new Date()
    });

    // 清除用户会话缓存
    // await redis.del(`session:${userId}`);

    logger.warn('Applied restrictions to user', {
      userId,
      restriction: 'trading_blocked'
    });
  }

  /**
   * 暂停账户
   */
  async suspendAccount(userId, violation) {
    await db('users')
      .where('id', userId)
      .update({
        status: 'suspended',
        suspended_at: new Date(),
        suspension_reason: 'SECURITY_VIOLATION'
      });

    // 强制登出所有会话
    await EventBus.publish(EVENTS.USER_FORCE_LOGOUT, {
      userId,
      reason: 'ACCOUNT_SUSPENDED'
    });

    logger.warn('Account suspended', { userId });
  }

  /**
   * 封禁账户
   */
  async banAccount(userId, violation) {
    await db('users')
      .where('id', userId)
      .update({
        status: 'banned',
        banned_at: new Date(),
        ban_reason: 'CRITICAL_SECURITY_VIOLATION'
      });

    await EventBus.publish(EVENTS.USER_FORCE_LOGOUT, {
      userId,
      reason: 'ACCOUNT_BANNED'
    });

    logger.error('Account banned', { userId, violation: violation.id });
  }

  /**
   * 获取动作消息
   */
  getActionMessage(action) {
    const messages = {
      none: 'Violation recorded',
      warn: 'Warning issued',
      restrict: 'Account restricted',
      suspend: 'Account suspended',
      ban: 'Account banned'
    };

    return messages[action] || 'Action taken';
  }

  /**
   * 获取用户安全状态
   */
  async getUserSecurityStatus(userId) {
    const violations = await db('security_violations')
      .where('user_id', userId)
      .where('created_at', '>', db.raw("NOW() - INTERVAL '30 days'"))
      .select('*')
      .orderBy('created_at', 'desc')
      .limit(50);

    const actions = await db('security_actions')
      .where('user_id', userId)
      .where('created_at', '>', db.raw("NOW() - INTERVAL '30 days'"))
      .select('*')
      .orderBy('created_at', 'desc');

    return {
      violations,
      actions,
      violationCount: violations.length,
      lastViolation: violations[0] || null
    };
  }
}

// 路由定义
function setupSecurityReportRoutes(app) {
  const controller = new SecurityReportController();

  // 内存违规报告
  app.post('/api/security/report', 
    require('../../../shared/middleware/auth').authenticate,
    controller.handleMemoryViolation.bind(controller)
  );

  // 调试检测报告
  app.post('/api/security/debug-detected',
    require('../../../shared/middleware/auth').authenticate,
    controller.handleDebugDetection.bind(controller)
  );

  // 获取用户安全状态（管理员）
  app.get('/api/security/status/:userId',
    require('../../../shared/middleware/auth').authenticate,
    require('../../../shared/middleware/auth').requireAdmin,
    async (req, res) => {
      const status = await controller.getUserSecurityStatus(req.params.userId);
      res.json(status);
    }
  );

  return controller;
}

module.exports = {
  SecurityReportController,
  setupSecurityReportRoutes
};