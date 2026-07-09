/**
 * AntiCheatResponse - 反作弊响应引擎
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 * 
 * 功能：
 * - 违规响应策略管理
 * - 用户封禁/解封
 * - 影子封禁（降权）
 * - 违规历史追踪
 * - 申诉处理
 */

const db = require('../../shared/db');
const logger = require('../../shared/logger');
const metrics = require('../../shared/metrics');

class AntiCheatResponse {
  constructor() {
    this.metrics = this._initMetrics();
    this.responseStrategies = this._initStrategies();
  }

  /**
   * 初始化 Prometheus 指标
   */
  _initMetrics() {
    return {
      responsesExecuted: metrics.registerCounter(
        'anti_cheat_response_executed_total',
        'Total anti-cheat responses executed',
        ['response_type', 'reason']
      ),
      usersBanned: metrics.registerGauge(
        'anti_cheat_users_banned_current',
        'Current number of banned users'
      ),
      usersShadowBanned: metrics.registerGauge(
        'anti_cheat_users_shadow_banned_current',
        'Current number of shadow-banned users'
      ),
      appealsTotal: metrics.registerCounter(
        'anti_cheat_appeals_total',
        'Total appeal requests',
        ['status']
      )
    };
  }

  /**
   * 初始化响应策略
   */
  _initStrategies() {
    return {
      // 严重违规（90+）
      critical: {
        type: 'ban',
        duration: 'permanent',
        effects: ['account_locked', 'data_frozen'],
        appealable: true,
        notify: true,
        notifyMessage: 'security_violation_permanent_ban'
      },
      // 高风险（70-89）
      high: {
        type: 'suspend',
        duration: '7_days',
        effects: ['temporary_suspension'],
        appealable: true,
        notify: true,
        notifyMessage: 'security_violation_suspension'
      },
      // 中等风险（50-69）
      medium: {
        type: 'shadow_ban',
        duration: '30_days',
        effects: ['reduced_spawn_rate', 'increased_flee_rate', 'reduced_rewards'],
        appealable: true,
        notify: false, // 不通知用户
        notifyMessage: null
      },
      // 低风险（30-49）
      low: {
        type: 'warn',
        duration: null,
        effects: ['strike_recorded'],
        appealable: false,
        notify: true,
        notifyMessage: 'suspicious_activity_warning'
      },
      // 轻微异常（0-29）
      minimal: {
        type: 'flag',
        duration: null,
        effects: ['enhanced_monitoring'],
        appealable: false,
        notify: false,
        notifyMessage: null
      }
    };
  }

  /**
   * 处理违规
   */
  async handleViolation(userId, violation) {
    try {
      const history = await this._getViolationHistory(userId);
      const severity = this._calculateSeverity(violation, history);
      const strategy = this._getStrategy(severity);
      const response = this._buildResponse(strategy, violation, history);

      // 执行响应
      await this._executeResponse(userId, response);

      // 记录指标
      this.metrics.responsesExecuted.inc({
        response_type: response.type,
        reason: violation.type
      });

      // 发送通知
      if (response.notify) {
        await this._notifyUser(userId, response);
      }

      // 记录日志
      await this._logResponse(userId, violation, response);

      logger.info('Anti-cheat response executed', {
        userId,
        violationType: violation.type,
        severity,
        responseType: response.type
      });

      return response;
    } catch (error) {
      logger.error('Failed to handle violation', { userId, error });
      throw error;
    }
  }

  /**
   * 计算严重程度分数
   */
  _calculateSeverity(violation, history) {
    let severity = 0;

    // 违规类型基础分数
    const baseScores = {
      'gps_spoofing': 50,
      'emulator_detected': 40,
      'root_detected': 30,
      'injection_framework': 70,
      'automation_detected': 60,
      'impossible_travel': 50,
      'abnormal_success_rate': 35,
      'pattern_irregularity': 30,
      'device_fingerprint_invalid': 25,
      'sensor_anomaly': 20,
      'mock_location': 45,
      'api_abuse': 40,
      'data_manipulation': 65
    };

    severity = baseScores[violation.type] || 20;

    // 累犯加重（最多 +40）
    const repeatOffenderBonus = Math.min(40, history.totalViolations * 5);
    severity += repeatOffenderBonus;

    // 证据强度加成
    if (violation.evidenceStrength === 'strong') {
      severity += 15;
    } else if (violation.evidenceStrength === 'medium') {
      severity += 8;
    }

    // 最近违规历史加成
    const recentViolations = history.violations.filter(v => {
      const daysAgo = (Date.now() - new Date(v.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      return daysAgo <= 30;
    });

    if (recentViolations.length >= 3) {
      severity += 20;
    } else if (recentViolations.length >= 2) {
      severity += 10;
    }

    return Math.min(100, severity);
  }

  /**
   * 获取响应策略
   */
  _getStrategy(severity) {
    if (severity >= 90) return { ...this.responseStrategies.critical, severity };
    if (severity >= 70) return { ...this.responseStrategies.high, severity };
    if (severity >= 50) return { ...this.responseStrategies.medium, severity };
    if (severity >= 30) return { ...this.responseStrategies.low, severity };
    return { ...this.responseStrategies.minimal, severity };
  }

  /**
   * 构建响应对象
   */
  _buildResponse(strategy, violation, history) {
    const response = {
      type: strategy.type,
      severity: strategy.severity,
      duration: strategy.duration,
      effects: strategy.effects,
      reason: violation.type,
      evidence: violation.evidence || {},
      appealable: strategy.appealable,
      notify: strategy.notify,
      notifyMessage: strategy.notifyMessage,
      strike: strategy.type === 'warn' ? true : false,
      timestamp: new Date().toISOString()
    };

    // 计算到期时间
    if (response.duration) {
      response.expiresAt = this._calculateExpiry(response.duration);
    }

    return response;
  }

  /**
   * 执行响应
   */
  async _executeResponse(userId, response) {
    switch (response.type) {
      case 'ban':
        await this._banUser(userId, response);
        this.metrics.usersBanned.inc();
        break;
      case 'suspend':
        await this._suspendUser(userId, response);
        break;
      case 'shadow_ban':
        await this._shadowBanUser(userId, response);
        this.metrics.usersShadowBanned.inc();
        break;
      case 'warn':
        await this._warnUser(userId, response);
        break;
      case 'flag':
        await this._flagUser(userId, response);
        break;
    }
  }

  /**
   * 永久封禁用户
   */
  async _banUser(userId, response) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // 更新用户状态
      await client.query(`
        UPDATE users
        SET status = 'banned',
            ban_reason = $1,
            banned_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [response.reason, userId]);

      // 记录违规
      await client.query(`
        INSERT INTO security_violations (
          user_id, violation_type, severity, evidence,
          response_type, response_details, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP)
      `, [
        userId,
        response.reason,
        response.severity,
        JSON.stringify(response.evidence),
        response.type,
        JSON.stringify({ effects: response.effects, expiresAt: response.expiresAt })
      ]);

      // 清除会话
      await client.query(`
        DELETE FROM user_sessions WHERE user_id = $1
      `, [userId]);

      await client.query('COMMIT');

      logger.warn('User permanently banned', { userId, reason: response.reason });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 暂停用户
   */
  async _suspendUser(userId, response) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // 更新用户状态
      await client.query(`
        UPDATE users
        SET status = 'suspended',
            suspension_reason = $1,
            suspended_until = $2,
            suspended_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [response.reason, response.expiresAt, userId]);

      // 记录违规
      await client.query(`
        INSERT INTO security_violations (
          user_id, violation_type, severity, evidence,
          response_type, response_details, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP)
      `, [
        userId,
        response.reason,
        response.severity,
        JSON.stringify(response.evidence),
        response.type,
        JSON.stringify({ effects: response.effects, expiresAt: response.expiresAt })
      ]);

      await client.query('COMMIT');

      logger.warn('User suspended', { userId, reason: response.reason, until: response.expiresAt });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 影子封禁（降权）
   */
  async _shadowBanUser(userId, response) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // 设置影子封禁状态
      await client.query(`
        INSERT INTO user_shadow_bans (
          user_id, effects, reason, severity,
          expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id)
        DO UPDATE SET
          effects = EXCLUDED.effects,
          reason = EXCLUDED.reason,
          expires_at = EXCLUDED.expires_at,
          created_at = CURRENT_TIMESTAMP
      `, [
        userId,
        JSON.stringify(response.effects),
        response.reason,
        response.severity,
        response.expiresAt
      ]);

      // 记录违规
      await client.query(`
        INSERT INTO security_violations (
          user_id, violation_type, severity, evidence,
          response_type, response_details, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP)
      `, [
        userId,
        response.reason,
        response.severity,
        JSON.stringify(response.evidence),
        response.type,
        JSON.stringify({ effects: response.effects, expiresAt: response.expiresAt })
      ]);

      await client.query('COMMIT');

      logger.info('User shadow-banned', { userId, effects: response.effects, until: response.expiresAt });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 警告用户
   */
  async _warnUser(userId, response) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // 增加警告计数
      await client.query(`
        UPDATE users
        SET warning_count = warning_count + 1,
            last_warning_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [userId]);

      // 记录违规
      await client.query(`
        INSERT INTO security_violations (
          user_id, violation_type, severity, evidence,
          response_type, response_details, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP)
      `, [
        userId,
        response.reason,
        response.severity,
        JSON.stringify(response.evidence),
        response.type,
        JSON.stringify({ strike: response.strike })
      ]);

      await client.query('COMMIT');

      logger.info('User warned', { userId, reason: response.reason });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 标记用户
   */
  async _flagUser(userId, response) {
    try {
      // 设置增强监控标记
      await db.query(`
        INSERT INTO user_monitoring_flags (
          user_id, reason, severity, evidence, created_at
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [
        userId,
        response.reason,
        response.severity,
        JSON.stringify(response.evidence)
      ]);

      logger.info('User flagged for monitoring', { userId, reason: response.reason });
    } catch (error) {
      logger.error('Failed to flag user', { userId, error });
    }
  }

  /**
   * 处理申诉
   */
  async handleAppeal(userId, appealId, decision, adminId) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // 获取申诉信息
      const { rows: appeals } = await client.query(`
        SELECT * FROM security_appeals
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
      `, [appealId, userId]);

      const appeal = appeals[0];
      if (!appeal) {
        throw new Error('Appeal not found or already processed');
      }

      if (decision === 'approved') {
        // 解除处罚
        await this._revokeViolation(userId, appeal.violationId, adminId);
        
        await client.query(`
          UPDATE security_appeals
          SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $1
          WHERE id = $2
        `, [adminId, appealId]);

        this.metrics.appealsTotal.inc({ status: 'approved' });
      } else {
        // 驳回申诉
        await client.query(`
          UPDATE security_appeals
          SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $1
          WHERE id = $2
        `, [adminId, appealId]);

        this.metrics.appealsTotal.inc({ status: 'rejected' });
      }

      await client.query('COMMIT');

      logger.info('Appeal processed', { userId, appealId, decision, adminId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 撤销违规处罚
   */
  async _revokeViolation(userId, violationId, adminId) {
    // 获取违规信息
    const { rows: violations } = await db.query(`
      SELECT * FROM security_violations
      WHERE id = $1 AND user_id = $2
    `, [violationId, userId]);

    const violation = violations[0];
    if (!violation) return;

    switch (violation.response_type) {
      case 'ban':
        await db.query(`
          UPDATE users
          SET status = 'active', ban_reason = NULL, banned_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [userId]);
        break;

      case 'suspend':
        await db.query(`
          UPDATE users
          SET status = 'active', suspension_reason = NULL, suspended_until = NULL, suspended_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [userId]);
        break;

      case 'shadow_ban':
        await db.query(`
          DELETE FROM user_shadow_bans WHERE user_id = $1
        `, [userId]);
        break;

      case 'warn':
        await db.query(`
          UPDATE users
          SET warning_count = GREATEST(0, warning_count - 1), updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [userId]);
        break;
    }

    // 标记违规为已解决
    await db.query(`
      UPDATE security_violations
      SET status = 'revoked', resolved_at = CURRENT_TIMESTAMP, resolved_by = $1
      WHERE id = $2
    `, [adminId, violationId]);
  }

  /**
   * 通知用户
   */
  async _notifyUser(userId, response) {
    // TODO: 集成推送通知服务
    logger.info('Sending notification to user', { userId, message: response.notifyMessage });
  }

  /**
   * 记录响应日志
   */
  async _logResponse(userId, violation, response) {
    logger.info('Security response logged', {
      userId,
      violationType: violation.type,
      responseType: response.type,
      severity: response.severity
    });
  }

  /**
   * 获取违规历史
   */
  async _getViolationHistory(userId) {
    try {
      const { rows } = await db.query(`
        SELECT 
          violation_type, severity, response_type, created_at
        FROM security_violations
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `, [userId]);

      return {
        totalViolations: rows.length,
        violations: rows
      };
    } catch (error) {
      return { totalViolations: 0, violations: [] };
    }
  }

  /**
   * 计算到期时间
   */
  _calculateExpiry(duration) {
    const now = new Date();
    
    switch (duration) {
      case '1_day':
        return new Date(now.getTime() + 24 * 60 * 60 * 1000);
      case '7_days':
        return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      case '30_days':
        return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      case 'permanent':
        return null;
      default:
        return null;
    }
  }
}

module.exports = AntiCheatResponse;