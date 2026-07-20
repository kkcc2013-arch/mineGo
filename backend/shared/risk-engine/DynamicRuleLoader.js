/**
 * 反作弊规则动态加载器
 * 支持规则热更新、灰度发布、A/B测试
 * REQ-00608
 */

'use strict';

const crypto = require('crypto');
const { logger } = require('../logging');

class DynamicRuleLoader {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.rulesCache = new Map();
    this.cacheTTL = 300; // 5分钟缓存
    this.listeners = new Set();
  }

  /**
   * 加载所有活跃规则
   */
  async loadActiveRules() {
    const cacheKey = 'anti_cheat:active_rules';
    
    try {
      // 先查缓存
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const rules = JSON.parse(cached);
        rules.forEach(rule => this.rulesCache.set(rule.rule_id, rule));
        return rules;
      }
      
      // 查数据库
      const result = await this.db.query(`
        SELECT * FROM anti_cheat_rules 
        WHERE status = 'active'
        ORDER BY priority DESC, created_at DESC
      `);
      
      const rules = result.rows;
      
      // 写入缓存
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(rules));
      
      // 更新本地缓存
      rules.forEach(rule => this.rulesCache.set(rule.rule_id, rule));
      
      logger.info('Loaded active anti-cheat rules', { count: rules.length });
      return rules;
      
    } catch (error) {
      logger.error('Failed to load active rules', { error: error.message });
      // 返回缓存中的规则（降级处理）
      return Array.from(this.rulesCache.values());
    }
  }

  /**
   * 获取特定用户的规则配置
   * 根据灰度分组返回适用的规则版本
   */
  async getRuleForUser(ruleId, userId) {
    let rule = this.rulesCache.get(ruleId);
    
    if (!rule) {
      // 重新加载
      await this.loadActiveRules();
      rule = this.rulesCache.get(ruleId);
    }
    
    if (!rule) {
      logger.warn('Rule not found', { ruleId });
      return null;
    }
    
    // 解析配置（如果是字符串）
    const config = typeof rule.config === 'string' ? JSON.parse(rule.config) : rule.config;
    
    // 检查规则是否启用
    if (!config.enabled) {
      return { ...rule, config: { enabled: false }, skipCheck: true };
    }
    
    // 检查灰度发布
    if (rule.rollout_strategy === 'gradual') {
      const userBucket = this.hashUserId(userId);
      if (userBucket >= rule.rollout_percentage) {
        // 用户不在灰度范围内，跳过规则
        return { ...rule, config: { enabled: false }, skipCheck: true };
      }
    }
    
    // 检查 A/B 测试
    const abVariants = typeof rule.ab_test_variants === 'string' 
      ? JSON.parse(rule.ab_test_variants) 
      : rule.ab_test_variants;
      
    if (rule.ab_test_enabled && abVariants && abVariants.length > 0) {
      const variant = this.selectVariant(userId, abVariants);
      return {
        ...rule,
        config: variant.config,
        variant_id: variant.id,
        in_ab_test: true
      };
    }
    
    return rule;
  }

  /**
   * 批量获取用户的适用规则
   */
  async getRulesForUser(userId, category = null) {
    await this.loadActiveRules();
    
    const rules = [];
    for (const [ruleId, rule] of this.rulesCache) {
      if (category && rule.category !== category) continue;
      
      const userRule = await this.getRuleForUser(ruleId, userId);
      if (userRule && !userRule.skipCheck) {
        rules.push(userRule);
      }
    }
    
    return rules;
  }

  /**
   * 用户 ID 哈希分桶（0-100）
   */
  hashUserId(userId) {
    const hash = crypto
      .createHash('md5')
      .update(userId.toString())
      .digest('hex');
    return parseInt(hash.slice(0, 2), 16) % 100;
  }

  /**
   * A/B 测试变体选择
   */
  selectVariant(userId, variants) {
    const bucket = this.hashUserId(userId);
    let cumulative = 0;
    
    for (const variant of variants) {
      cumulative += variant.percentage || 0;
      if (bucket < cumulative) {
        return variant;
      }
    }
    
    return variants[0]; // 默认返回第一个
  }

  /**
   * 热更新规则（清除缓存）
   */
  async invalidateCache(ruleId = null) {
    if (ruleId) {
      this.rulesCache.delete(ruleId);
    } else {
      this.rulesCache.clear();
    }
    
    await this.redis.del('anti_cheat:active_rules');
    
    // 重新加载
    await this.loadActiveRules();
    
    // 通知监听器
    this.notifyListeners(ruleId);
  }

  /**
   * 订阅规则变更通知（Redis Pub/Sub）
   */
  subscribeToChanges() {
    const channel = 'anti_cheat:rule_updated';
    
    this.redis.subscribe(channel, (err, count) => {
      if (err) {
        logger.error('Failed to subscribe to rule updates', { error: err.message });
        return;
      }
      logger.info('Subscribed to rule update channel', { channel, count });
    });
    
    this.redis.on('message', (ch, message) => {
      if (ch === channel) {
        try {
          const { ruleId } = JSON.parse(message);
          logger.info('Rule updated notification received', { ruleId });
          this.invalidateCache(ruleId);
        } catch (error) {
          logger.error('Failed to process rule update message', { error: error.message });
        }
      }
    });
  }

  /**
   * 添加规则变更监听器
   */
  addChangeListener(listener) {
    this.listeners.add(listener);
  }

  /**
   * 移除规则变更监听器
   */
  removeChangeListener(listener) {
    this.listeners.delete(listener);
  }

  /**
   * 通知所有监听器
   */
  notifyListeners(ruleId) {
    for (const listener of this.listeners) {
      try {
        listener(ruleId);
      } catch (error) {
        logger.error('Listener error', { error: error.message });
      }
    }
  }

  /**
   * 更新规则统计
   */
  async updateRuleStats(ruleId, stats) {
    try {
      await this.db.query(`
        UPDATE anti_cheat_rules 
        SET stats = stats || $1::jsonb,
            updated_at = NOW()
        WHERE rule_id = $2
      `, [JSON.stringify(stats), ruleId]);
    } catch (error) {
      logger.error('Failed to update rule stats', { ruleId, error: error.message });
    }
  }

  /**
   * 获取规则统计信息
   */
  async getRuleStats(ruleId) {
    const rule = this.rulesCache.get(ruleId);
    if (!rule) return null;
    
    const stats = typeof rule.stats === 'string' ? JSON.parse(rule.stats) : rule.stats;
    return stats;
  }
}

module.exports = { DynamicRuleLoader };
