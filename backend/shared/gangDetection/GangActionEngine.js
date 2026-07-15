/**
 * 团伙处置引擎
 * REQ-00550: 协同作弊团伙检测系统
 * 
 * 功能:
 * - 团伙处置决策（监控/限制/封禁）
 * - 处置执行与记录
 * - 处置效果追踪
 */

'use strict';

const { createLogger } = require('../logger');
const { Pool } = require('pg');

const logger = createLogger('gang-action');

// 处置阈值配置
const ACTION_THRESHOLDS = {
  monitor: { minScore: 0, maxScore: 39 },
  restrict: { minScore: 40, maxScore: 69 },
  restrict_hard: { minScore: 70, maxScore: 84 },
  ban: { minScore: 85, maxScore: 100 }
};

// 限制策略配置
const RESTRICTION_POLICIES = {
  no_trading_with_new_accounts: {
    description: '禁止与小号交易',
    checkAge: 7 // 天
  },
  limited_catch_quota: {
    description: '限制每日捕捉数量',
    dailyLimit: 100
  },
  no_gym_battle_rewards: {
    description: '禁止道馆战奖励'
  },
  no_trading: {
    description: '禁止所有交易'
  },
  no_gym_battles: {
    description: '禁止道馆战'
  },
  no_pokemon_transfer: {
    description: '禁止精灵转移'
  }
};

class GangActionEngine {
  constructor(config = {}) {
    this.db = new Pool({ connectionString: config.dbUrl || process.env.DATABASE_URL });
    this.thresholds = { ...ACTION_THRESHOLDS, ...config.thresholds };
  }

  /**
   * 确定处置策略
   */
  determineAction(riskScore) {
    for (const [action, range] of Object.entries(this.thresholds)) {
      if (riskScore >= range.minScore && riskScore <= range.maxScore) {
        return action;
      }
    }
    return 'monitor';
  }

  /**
   * 执行处置决策
   */
  async executeAction(gang, action) {
    const startTime = Date.now();
    const results = [];

    try {
      switch (action) {
        case 'monitor':
          await this.logGangActivity(gang);
          results.push({ action: 'monitor', status: 'logged' });
          break;

        case 'restrict':
          for (const member of gang.members || []) {
            await this.applyRestrictions(member.user_id || member, [
              'no_trading_with_new_accounts',
              'limited_catch_quota',
              'no_gym_battle_rewards'
            ]);
            results.push({ userId: member.user_id || member, action: 'restricted' });
          }
          break;

        case 'restrict_hard':
          for (const member of gang.members || []) {
            await this.applyRestrictions(member.user_id || member, [
              'no_trading',
              'no_gym_battles',
              'no_pokemon_transfer',
              'limited_catch_quota'
            ]);
            results.push({ userId: member.user_id || member, action: 'restricted_hard' });
          }
          break;

        case 'ban':
          for (const member of gang.members || []) {
            const userId = member.user_id || member;
            if (member.role === 'leader' || member.role === 'core') {
              await this.banUser(userId, {
                reason: 'GANG_CHEATING',
                duration: 'permanent',
                gangId: gang.gang_id
              });
              results.push({ userId, action: 'banned_permanent' });
            } else {
              await this.banUser(userId, {
                reason: 'GANG_ASSOCIATION',
                duration: '30d',
                gangId: gang.gang_id
              });
              results.push({ userId, action: 'banned_temporary' });
            }
          }
          break;
      }

      // 记录处置结果
      await this.logGangAction(gang.gang_id, action, results, Date.now() - startTime);

      logger.info({
        gangId: gang.gang_id,
        action,
        memberCount: results.length,
        latencyMs: Date.now() - startTime
      }, 'Gang action executed');

      return {
        success: true,
        action,
        results,
        latencyMs: Date.now() - startTime
      };
    } catch (error) {
      logger.error({
        gangId: gang.gang_id,
        action,
        error: error.message
      }, 'Gang action execution failed');

      return {
        success: false,
        action,
        error: error.message
      };
    }
  }

  /**
   * 记录团伙活动
   */
  async logGangActivity(gang) {
    await this.db.query(`
      UPDATE cheating_gangs 
      SET last_activity = NOW(), updated_at = NOW()
      WHERE gang_id = $1
    `, [gang.gang_id]);
  }

  /**
   * 应用限制
   */
  async applyRestrictions(userId, restrictions) {
    await this.db.query(`
      INSERT INTO user_restrictions (user_id, restrictions, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        restrictions = EXCLUDED.restrictions,
        updated_at = NOW()
    `, [userId, JSON.stringify(restrictions)]);
  }

  /**
   * 封禁用户
   */
  async banUser(userId, options) {
    const expiresAt = options.duration === 'permanent' 
      ? null 
      : new Date(Date.now() + this.parseDuration(options.duration));

    await this.db.query(`
      INSERT INTO user_bans (user_id, reason, expires_at, metadata, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [userId, options.reason, expiresAt, JSON.stringify({ gangId: options.gangId })]);
  }

  /**
   * 解析持续时间
   */
  parseDuration(duration) {
    const match = duration.match(/^(\d+)(d|h|m)$/);
    if (!match) return 30 * 24 * 60 * 60 * 1000; // 默认30天

    const [, value, unit] = match;
    const multipliers = { d: 86400000, h: 3600000, m: 60000 };
    return parseInt(value) * multipliers[unit];
  }

  /**
   * 记录处置日志
   */
  async logGangAction(gangId, action, results, latencyMs) {
    await this.db.query(`
      INSERT INTO gang_action_logs (gang_id, action, results, latency_ms, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [gangId, action, JSON.stringify(results), latencyMs]);
  }

  /**
   * 获取处置历史
   */
  async getActionHistory(gangId, limit = 50) {
    const result = await this.db.query(`
      SELECT * FROM gang_action_logs
      WHERE gang_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [gangId, limit]);
    
    return result.rows;
  }

  /**
   * 批量处置决策
   */
  async batchExecuteActions(gangs) {
    const results = [];
    
    for (const gang of gangs) {
      const action = this.determineAction(gang.risk_score);
      const result = await this.executeAction(gang, action);
      results.push(result);
    }
    
    return results;
  }

  /**
   * 关闭资源连接
   */
  async close() {
    await this.db.end();
  }
}

module.exports = GangActionEngine;