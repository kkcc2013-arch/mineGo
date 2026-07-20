/**
 * 反作弊规则灰度发布控制器
 * 支持渐进式发布、自动推进、自动回滚
 * REQ-00608
 */

'use strict';

const { logger } = require('../../shared/logging');
const { metrics } = require('../../shared/metrics');

class RuleRolloutController {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.rolloutJobs = new Map();
  }

  /**
   * 创建灰度发布计划
   */
  async createRolloutPlan(ruleId, strategy, options = {}) {
    const {
      initialPercentage = 1,
      targetPercentage = 100,
      incrementStep = 10,
      intervalMinutes = 60,
      autoRollback = true,
      rollbackThreshold = 0.05 // 误封率超过 5% 自动回滚
    } = options;

    // 验证规则存在
    const ruleCheck = await this.db.query(
      'SELECT rule_id FROM anti_cheat_rules WHERE rule_id = $1',
      [ruleId]
    );
    
    if (ruleCheck.rows.length === 0) {
      throw new Error(`Rule not found: ${ruleId}`);
    }

    // 创建灰度计划
    const plan = {
      ruleId,
      strategy,
      currentPercentage: initialPercentage,
      targetPercentage,
      incrementStep,
      intervalMinutes,
      autoRollback,
      rollbackThreshold,
      status: 'running',
      stages: [
        { 
          percentage: initialPercentage, 
          status: 'active', 
          startedAt: new Date().toISOString() 
        }
      ],
      createdAt: new Date().toISOString()
    };

    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_strategy = $1,
        rollout_percentage = $2,
        rollout_plan = $3,
        updated_at = NOW()
      WHERE rule_id = $4
    `, [strategy, initialPercentage, JSON.stringify(plan), ruleId]);

    // 记录历史
    await this.logHistory(ruleId, 'rollout_created', null, { strategy, plan });

    logger.info('Rollout plan created', { ruleId, strategy, initialPercentage });

    // 如果是渐进式发布，启动定时任务
    if (strategy === 'gradual') {
      this.scheduleAutoAdvance(ruleId, intervalMinutes);
    }

    // 更新指标
    if (metrics && metrics.gauge) {
      metrics.gauge('minego_rule_rollout_percentage').set({ rule_id: ruleId }, initialPercentage);
    }

    return plan;
  }

  /**
   * 推进灰度进度
   */
  async advanceRollout(ruleId) {
    const result = await this.db.query(`
      SELECT rollout_plan, rollout_percentage, stats 
      FROM anti_cheat_rules 
      WHERE rule_id = $1
    `, [ruleId]);

    const rule = result.rows[0];
    if (!rule) {
      throw new Error('Rule not found');
    }

    const plan = typeof rule.rollout_plan === 'string' 
      ? JSON.parse(rule.rollout_plan) 
      : rule.rollout_plan;
    const stats = typeof rule.stats === 'string' 
      ? JSON.parse(rule.stats) 
      : rule.stats;
    
    // 检查是否需要回滚
    if (plan.autoRollback && stats) {
      const falsePositiveRate = stats.falsePositiveRate || 0;
      if (falsePositiveRate > plan.rollbackThreshold) {
        logger.warn('Auto rollback triggered due to high false positive rate', {
          ruleId,
          falsePositiveRate,
          threshold: plan.rollbackThreshold
        });
        return await this.rollbackRollout(ruleId, 'High false positive rate detected');
      }
    }

    // 推进到下一阶段
    const nextPercentage = Math.min(
      plan.currentPercentage + plan.incrementStep,
      plan.targetPercentage
    );

    // 更新计划
    plan.currentPercentage = nextPercentage;
    plan.stages.push({
      percentage: nextPercentage,
      status: 'active',
      startedAt: new Date().toISOString()
    });

    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_percentage = $1,
        rollout_plan = $2,
        updated_at = NOW()
      WHERE rule_id = $3
    `, [nextPercentage, JSON.stringify(plan), ruleId]);

    logger.info('Rollout advanced', { 
      ruleId, 
      from: plan.currentPercentage - plan.incrementStep, 
      to: nextPercentage 
    });

    // 通知规则引擎刷新缓存
    await this.redis.publish('anti_cheat:rule_updated', JSON.stringify({ ruleId }));

    // 更新指标
    if (metrics && metrics.gauge) {
      metrics.gauge('minego_rule_rollout_percentage').set({ rule_id: ruleId }, nextPercentage);
    }

    const completed = nextPercentage >= plan.targetPercentage;
    
    if (completed) {
      // 停止自动推进
      this.stopAutoAdvance(ruleId);
      
      // 记录历史
      await this.logHistory(ruleId, 'rollout_completed', plan, { finalPercentage: nextPercentage });
    }

    return { 
      percentage: nextPercentage, 
      completed,
      plan 
    };
  }

  /**
   * 回滚灰度发布
   */
  async rollbackRollout(ruleId, reason) {
    // 获取当前计划
    const result = await this.db.query(`
      SELECT rollout_plan 
      FROM anti_cheat_rules 
      WHERE rule_id = $1
    `, [ruleId]);

    const oldPlan = result.rows[0]?.rollout_plan;

    // 更新规则状态
    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_percentage = 0,
        rollout_plan = jsonb_set(
          rollout_plan::jsonb,
          '{status}',
          '"rolled_back"'
        ),
        updated_at = NOW()
      WHERE rule_id = $1
    `, [ruleId]);

    // 记录回滚原因
    await this.logHistory(ruleId, 'rolled_back', oldPlan, { reason });

    // 停止自动推进
    this.stopAutoAdvance(ruleId);

    // 更新指标
    if (metrics) {
      if (metrics.counter) {
        metrics.counter('minego_rule_rollback_total').inc({ rule_id: ruleId, reason });
      }
      if (metrics.gauge) {
        metrics.gauge('minego_rule_rollout_percentage').set({ rule_id: ruleId }, 0);
      }
    }

    logger.warn('Rollout rolled back', { ruleId, reason });

    await this.redis.publish('anti_cheat:rule_updated', JSON.stringify({ ruleId }));

    return { success: true, reason };
  }

  /**
   * 暂停灰度发布
   */
  async pauseRollout(ruleId) {
    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_plan = jsonb_set(
          rollout_plan::jsonb,
          '{status}',
          '"paused"'
        ),
        updated_at = NOW()
      WHERE rule_id = $1
    `, [ruleId]);

    this.stopAutoAdvance(ruleId);
    
    await this.logHistory(ruleId, 'rollout_paused', null, {});

    logger.info('Rollout paused', { ruleId });

    return { success: true };
  }

  /**
   * 恢复灰度发布
   */
  async resumeRollout(ruleId) {
    const result = await this.db.query(`
      SELECT rollout_plan 
      FROM anti_cheat_rules 
      WHERE rule_id = $1
    `, [ruleId]);

    const plan = typeof result.rows[0].rollout_plan === 'string'
      ? JSON.parse(result.rows[0].rollout_plan)
      : result.rows[0].rollout_plan;

    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_plan = jsonb_set(
          rollout_plan::jsonb,
          '{status}',
          '"running"'
        ),
        updated_at = NOW()
      WHERE rule_id = $1
    `, [ruleId]);

    // 重新启动自动推进
    if (plan.strategy === 'gradual') {
      this.scheduleAutoAdvance(ruleId, plan.intervalMinutes);
    }

    await this.logHistory(ruleId, 'rollout_resumed', null, {});

    logger.info('Rollout resumed', { ruleId });

    return { success: true };
  }

  /**
   * 获取灰度发布状态
   */
  async getRolloutStatus(ruleId) {
    const result = await this.db.query(`
      SELECT rollout_strategy, rollout_percentage, rollout_plan, stats
      FROM anti_cheat_rules 
      WHERE rule_id = $1
    `, [ruleId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      strategy: row.rollout_strategy,
      percentage: row.rollout_percentage,
      plan: typeof row.rollout_plan === 'string' ? JSON.parse(row.rollout_plan) : row.rollout_plan,
      stats: typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats
    };
  }

  /**
   * 调度自动推进任务
   */
  scheduleAutoAdvance(ruleId, intervalMinutes) {
    // 清除已存在的任务
    this.stopAutoAdvance(ruleId);

    const intervalMs = intervalMinutes * 60 * 1000;
    const timerId = setInterval(async () => {
      try {
        const status = await this.getRolloutStatus(ruleId);
        if (status && status.plan.status === 'running' && status.percentage < 100) {
          await this.advanceRollout(ruleId);
        } else {
          this.stopAutoAdvance(ruleId);
        }
      } catch (error) {
        logger.error('Auto advance failed', { ruleId, error: error.message });
      }
    }, intervalMs);

    this.rolloutJobs.set(ruleId, timerId);
    logger.info('Scheduled auto advance', { ruleId, intervalMinutes });
  }

  /**
   * 停止自动推进
   */
  stopAutoAdvance(ruleId) {
    const timerId = this.rolloutJobs.get(ruleId);
    if (timerId) {
      clearInterval(timerId);
      this.rolloutJobs.delete(ruleId);
      logger.info('Stopped auto advance', { ruleId });
    }
  }

  /**
   * 记录历史
   */
  async logHistory(ruleId, action, oldConfig, newData) {
    try {
      await this.db.query(`
        INSERT INTO anti_cheat_rule_history (
          rule_id, action, old_config, new_config, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
      `, [
        ruleId,
        action,
        oldConfig ? JSON.stringify(oldConfig) : null,
        JSON.stringify(newData)
      ]);
    } catch (error) {
      logger.error('Failed to log history', { ruleId, error: error.message });
    }
  }

  /**
   * 清理资源
   */
  cleanup() {
    for (const [ruleId, timerId] of this.rolloutJobs) {
      clearInterval(timerId);
    }
    this.rolloutJobs.clear();
  }
}

module.exports = { RuleRolloutController };
