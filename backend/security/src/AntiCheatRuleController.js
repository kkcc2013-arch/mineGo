/**
 * 反作弊规则管理控制器
 * 管理后台 API 控制器
 * REQ-00608
 */

'use strict';

const { logger } = require('../../shared/logging');
const { DynamicRuleLoader } = require('../../shared/risk-engine/DynamicRuleLoader');
const { RuleRolloutController } = require('./RuleRolloutController');
const { ABTestAnalyzer } = require('./ABTestAnalyzer');

class AntiCheatRuleController {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.ruleLoader = new DynamicRuleLoader(db, redis);
    this.rolloutController = new RuleRolloutController(db, redis);
    this.abTestAnalyzer = new ABTestAnalyzer(db);
  }

  /**
   * 获取所有规则列表
   */
  async list(req, res) {
    try {
      const { category, status, page = 1, limit = 20 } = req.query;
      
      let query = 'SELECT * FROM anti_cheat_rules WHERE 1=1';
      const params = [];
      
      if (category) {
        params.push(category);
        query += ` AND category = $${params.length}`;
      }
      
      if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
      }
      
      // 总数
      const countResult = await this.db.query(
        `SELECT COUNT(*) FROM (${query}) as t`,
        params
      );
      const total = parseInt(countResult.rows[0].count);
      
      // 分页
      params.push(limit);
      query += ` ORDER BY priority DESC, created_at DESC LIMIT $${params.length}`;
      params.push((page - 1) * limit);
      query += ` OFFSET $${params.length}`;
      
      const result = await this.db.query(query, params);
      
      res.json({
        rules: result.rows,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      logger.error('Failed to list rules', { error: error.message });
      res.status(500).json({ error: 'Failed to list rules' });
    }
  }

  /**
   * 创建新规则
   */
  async create(req, res) {
    try {
      const { rule_id, rule_name, category, description, config, priority = 50 } = req.body;
      
      // 验证必填字段
      if (!rule_id || !rule_name || !category || !config) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // 插入规则
      const result = await this.db.query(`
        INSERT INTO anti_cheat_rules (
          rule_id, rule_name, category, description, config, priority, created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING *
      `, [
        rule_id,
        rule_name,
        category,
        description || '',
        JSON.stringify(config),
        priority,
        req.user?.id
      ]);
      
      const rule = result.rows[0];
      
      // 刷新缓存
      await this.ruleLoader.invalidateCache(rule_id);
      
      // 记录历史
      await this.db.query(`
        INSERT INTO anti_cheat_rule_history (
          rule_id, action, new_config, changed_by, created_at
        ) VALUES ($1, 'created', $2, $3, NOW())
      `, [rule_id, JSON.stringify(rule), req.user?.id]);
      
      logger.info('Rule created', { ruleId: rule_id, userId: req.user?.id });
      
      res.status(201).json(rule);
    } catch (error) {
      logger.error('Failed to create rule', { error: error.message });
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Rule ID already exists' });
      }
      res.status(500).json({ error: 'Failed to create rule' });
    }
  }

  /**
   * 更新规则
   */
  async update(req, res) {
    try {
      const { ruleId } = req.params;
      const updates = req.body;
      
      // 获取旧配置
      const oldResult = await this.db.query(
        'SELECT * FROM anti_cheat_rules WHERE rule_id = $1',
        [ruleId]
      );
      
      if (oldResult.rows.length === 0) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      const oldConfig = oldResult.rows[0];
      
      // 构建更新语句
      const updateFields = [];
      const updateValues = [];
      let paramCount = 1;
      
      if (updates.rule_name) {
        updateFields.push(`rule_name = $${paramCount++}`);
        updateValues.push(updates.rule_name);
      }
      if (updates.description !== undefined) {
        updateFields.push(`description = $${paramCount++}`);
        updateValues.push(updates.description);
      }
      if (updates.config) {
        updateFields.push(`config = $${paramCount++}`);
        updateValues.push(JSON.stringify(updates.config));
      }
      if (updates.priority !== undefined) {
        updateFields.push(`priority = $${paramCount++}`);
        updateValues.push(updates.priority);
      }
      if (updates.status) {
        updateFields.push(`status = $${paramCount++}`);
        updateValues.push(updates.status);
      }
      
      updateFields.push(`version = version + 1`);
      updateFields.push(`updated_at = NOW()`);
      
      updateValues.push(ruleId);
      
      const query = `
        UPDATE anti_cheat_rules 
        SET ${updateFields.join(', ')}
        WHERE rule_id = $${paramCount}
        RETURNING *
      `;
      
      const result = await this.db.query(query, updateValues);
      const newConfig = result.rows[0];
      
      // 刷新缓存
      await this.ruleLoader.invalidateCache(ruleId);
      
      // 记录历史
      await this.db.query(`
        INSERT INTO anti_cheat_rule_history (
          rule_id, action, old_config, new_config, changed_by, created_at
        ) VALUES ($1, 'updated', $2, $3, $4, NOW())
      `, [ruleId, JSON.stringify(oldConfig), JSON.stringify(newConfig), req.user?.id]);
      
      logger.info('Rule updated', { ruleId, userId: req.user?.id });
      
      res.json(newConfig);
    } catch (error) {
      logger.error('Failed to update rule', { error: error.message });
      res.status(500).json({ error: 'Failed to update rule' });
    }
  }

  /**
   * 创建灰度发布
   */
  async createRollout(req, res) {
    try {
      const { ruleId } = req.params;
      const { strategy, initialPercentage, incrementStep, intervalMinutes, autoRollback, rollbackThreshold } = req.body;
      
      const plan = await this.rolloutController.createRolloutPlan(ruleId, strategy, {
        initialPercentage,
        incrementStep,
        intervalMinutes,
        autoRollback,
        rollbackThreshold
      });
      
      res.json(plan);
    } catch (error) {
      logger.error('Failed to create rollout', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 推进灰度
   */
  async advanceRollout(req, res) {
    try {
      const { ruleId } = req.params;
      const result = await this.rolloutController.advanceRollout(ruleId);
      res.json(result);
    } catch (error) {
      logger.error('Failed to advance rollout', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 回滚灰度
   */
  async rollbackRollout(req, res) {
    try {
      const { ruleId } = req.params;
      const { reason } = req.body;
      
      const result = await this.rolloutController.rollbackRollout(ruleId, reason);
      res.json(result);
    } catch (error) {
      logger.error('Failed to rollback rollout', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 创建 A/B 测试
   */
  async createABTest(req, res) {
    try {
      const { ruleId } = req.params;
      const { variants } = req.body;
      
      const testId = `test-${ruleId}-${Date.now()}`;
      const result = await this.abTestAnalyzer.createABTest(ruleId, testId, variants);
      
      // 刷新缓存
      await this.ruleLoader.invalidateCache(ruleId);
      
      res.json(result);
    } catch (error) {
      logger.error('Failed to create A/B test', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 获取 A/B 测试结果
   */
  async getABTestResults(req, res) {
    try {
      const { ruleId } = req.params;
      const { testId } = req.query;
      
      if (!testId) {
        return res.status(400).json({ error: 'testId is required' });
      }
      
      const results = await this.abTestAnalyzer.analyzeTestResults(testId, ruleId);
      res.json(results);
    } catch (error) {
      logger.error('Failed to get A/B test results', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 获取规则统计
   */
  async getStats(req, res) {
    try {
      const { ruleId } = req.params;
      
      const result = await this.db.query(
        'SELECT stats, updated_at FROM anti_cheat_rules WHERE rule_id = $1',
        [ruleId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      const stats = typeof result.rows[0].stats === 'string' 
        ? JSON.parse(result.rows[0].stats) 
        : result.rows[0].stats;
      
      res.json({
        ruleId,
        stats,
        updatedAt: result.rows[0].updated_at
      });
    } catch (error) {
      logger.error('Failed to get rule stats', { error: error.message });
      res.status(500).json({ error: 'Failed to get rule stats' });
    }
  }

  /**
   * 获取规则变更历史
   */
  async getHistory(req, res) {
    try {
      const { ruleId } = req.params;
      const { limit = 50 } = req.query;
      
      const result = await this.db.query(`
        SELECT * FROM anti_cheat_rule_history
        WHERE rule_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `, [ruleId, limit]);
      
      res.json(result.rows);
    } catch (error) {
      logger.error('Failed to get rule history', { error: error.message });
      res.status(500).json({ error: 'Failed to get rule history' });
    }
  }
}

module.exports = { AntiCheatRuleController };
