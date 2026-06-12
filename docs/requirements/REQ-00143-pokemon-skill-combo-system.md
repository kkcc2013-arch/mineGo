# REQ-00143: 精灵自定义技能组合与连招系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00143 |
| 标题 | 精灵自定义技能组合与连招系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gym-service、social-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-12 05:00 |

## 需求描述

为精灵战斗系统增加自定义技能组合与连招机制，允许玩家为精灵预设技能释放顺序，在战斗中触发连招效果，提升战斗策略深度和游戏趣味性。

### 核心功能
1. **技能组合预设**：玩家可为精灵创建多个技能组合方案（最多5个）
2. **连招效果系统**：连续释放技能触发额外效果（伤害加成、状态附加、冷却缩减）
3. **连招条件判定**：基于时间窗口、技能类型、精灵状态等条件
4. **战斗中连招执行**：一键触发预设连招，自动按顺序释放技能
5. **连招统计数据**：记录连招使用频率、成功率、效果统计

### 业务价值
- 增强战斗策略深度，提升竞技性
- 降低新手玩家操作门槛（一键连招）
- 增加玩家粘性（连招收集、优化）
- 支持高级玩家深度定制

## 技术方案

### 1. 数据库设计

```sql
-- 精灵技能组合表
CREATE TABLE pokemon_skill_combos (
  id SERIAL PRIMARY KEY,
  pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_pokemon_combo_name UNIQUE (pokemon_instance_id, name)
);

-- 技能组合步骤表
CREATE TABLE skill_combo_steps (
  id SERIAL PRIMARY KEY,
  combo_id INTEGER NOT NULL REFERENCES pokemon_skill_combos(id) ON DELETE CASCADE,
  step_order SMALLINT NOT NULL,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  delay_ms INTEGER DEFAULT 0, -- 与上一技能的延迟时间
  condition_type VARCHAR(30), -- 'on_hit', 'on_crit', 'on_dodge', 'always'
  condition_params JSONB, -- 条件参数
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_combo_step_order UNIQUE (combo_id, step_order)
);

-- 连招效果定义表
CREATE TABLE combo_effects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  min_steps SMALLINT NOT NULL DEFAULT 2, -- 最少技能数
  time_window_ms INTEGER NOT NULL DEFAULT 3000, -- 时间窗口
  effect_type VARCHAR(50) NOT NULL, -- 'damage_boost', 'status_apply', 'cooldown_reduce', 'heal'
  effect_params JSONB NOT NULL,
  skill_type_requirements JSONB, -- 技能类型要求，如 ['fire', 'fire']
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家连招使用统计表
CREATE TABLE player_combo_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  combo_id INTEGER NOT NULL REFERENCES pokemon_skill_combos(id) ON DELETE CASCADE,
  total_uses INTEGER DEFAULT 0,
  successful_uses INTEGER DEFAULT 0,
  total_damage_dealt BIGINT DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_user_combo_stats UNIQUE (user_id, combo_id)
);

-- 创建索引
CREATE INDEX idx_skill_combos_pokemon ON pokemon_skill_combos(pokemon_instance_id);
CREATE INDEX idx_skill_combo_steps_combo ON skill_combo_steps(combo_id);
CREATE INDEX idx_player_combo_stats_user ON player_combo_stats(user_id);
CREATE INDEX idx_player_combo_stats_combo ON player_combo_stats(combo_id);
```

### 2. pokemon-service 技能组合管理模块

```javascript
// backend/services/pokemon-service/src/routes/skillCombos.js

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const auth = require('../../../shared/middleware/auth');
const SkillComboService = require('../services/SkillComboService');
const logger = require('../../../shared/logger');

/**
 * 获取精灵的所有技能组合
 */
router.get('/pokemon/:pokemonId/combos',
  auth,
  param('pokemonId').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { pokemonId } = req.params;
      const userId = req.user.id;

      const combos = await SkillComboService.getCombosByPokemon(pokemonId, userId);
      res.json({ success: true, data: combos });
    } catch (error) {
      logger.error('获取技能组合失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * 创建技能组合
 */
router.post('/pokemon/:pokemonId/combos',
  auth,
  [
    param('pokemonId').isInt({ min: 1 }),
    body('name').trim().isLength({ min: 1, max: 50 }),
    body('description').optional().trim().isLength({ max: 200 }),
    body('steps').isArray({ min: 2, max: 5 }),
    body('steps.*.skillId').isInt({ min: 1 }),
    body('steps.*.delayMs').optional().isInt({ min: 0, max: 5000 }),
    body('steps.*.conditionType').optional().isIn(['on_hit', 'on_crit', 'on_dodge', 'always'])
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { pokemonId } = req.params;
      const { name, description, steps, isDefault } = req.body;
      const userId = req.user.id;

      const combo = await SkillComboService.createCombo(pokemonId, userId, {
        name,
        description,
        steps,
        isDefault
      });

      logger.info(`用户 ${userId} 为精灵 ${pokemonId} 创建技能组合: ${name}`);
      res.status(201).json({ success: true, data: combo });
    } catch (error) {
      logger.error('创建技能组合失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * 更新技能组合
 */
router.put('/combos/:comboId',
  auth,
  [
    param('comboId').isInt({ min: 1 }),
    body('name').optional().trim().isLength({ min: 1, max: 50 }),
    body('description').optional().trim().isLength({ max: 200 }),
    body('steps').optional().isArray({ min: 2, max: 5 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { comboId } = req.params;
      const updates = req.body;
      const userId = req.user.id;

      const combo = await SkillComboService.updateCombo(comboId, userId, updates);
      logger.info(`用户 ${userId} 更新技能组合 ${comboId}`);
      res.json({ success: true, data: combo });
    } catch (error) {
      logger.error('更新技能组合失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * 删除技能组合
 */
router.delete('/combos/:comboId',
  auth,
  param('comboId').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const { comboId } = req.params;
      const userId = req.user.id;

      await SkillComboService.deleteCombo(comboId, userId);
      logger.info(`用户 ${userId} 删除技能组合 ${comboId}`);
      res.json({ success: true, message: '技能组合已删除' });
    } catch (error) {
      logger.error('删除技能组合失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * 获取可用连招效果列表
 */
router.get('/combo-effects',
  auth,
  async (req, res) => {
    try {
      const effects = await SkillComboService.getComboEffects();
      res.json({ success: true, data: effects });
    } catch (error) {
      logger.error('获取连招效果失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * 获取连招使用统计
 */
router.get('/combos/:comboId/stats',
  auth,
  param('comboId').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const { comboId } = req.params;
      const userId = req.user.id;

      const stats = await SkillComboService.getComboStats(comboId, userId);
      res.json({ success: true, data: stats });
    } catch (error) {
      logger.error('获取连招统计失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * 设置默认技能组合
 */
router.post('/combos/:comboId/set-default',
  auth,
  param('comboId').isInt({ min: 1 }),
  async (req, res) => {
    try {
      const { comboId } = req.params;
      const userId = req.user.id;

      await SkillComboService.setDefaultCombo(comboId, userId);
      res.json({ success: true, message: '默认技能组合已更新' });
    } catch (error) {
      logger.error('设置默认技能组合失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

module.exports = router;
```

### 3. 技能组合服务

```javascript
// backend/services/pokemon-service/src/services/SkillComboService.js

const db = require('../../../shared/db');
const redis = require('../../../shared/redis');
const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

class SkillComboService {
  /**
   * 获取精灵的所有技能组合
   */
  static async getCombosByPokemon(pokemonInstanceId, userId) {
    // 验证所有权
    const pokemon = await db.getRow(
      'SELECT id, user_id FROM pokemon_instances WHERE id = $1',
      [pokemonInstanceId]
    );

    if (!pokemon) {
      throw new Error('精灵不存在');
    }

    if (pokemon.user_id !== userId) {
      throw new Error('无权访问该精灵');
    }

    const combos = await db.getRows(`
      SELECT pc.*, 
             json_agg(
               json_build_object(
                 'id', scs.id,
                 'stepOrder', scs.step_order,
                 'skillId', scs.skill_id,
                 'skillName', s.name,
                 'delayMs', scs.delay_ms,
                 'conditionType', scs.condition_type,
                 'conditionParams', scs.condition_params
               ) ORDER BY scs.step_order
             ) as steps
      FROM pokemon_skill_combos pc
      LEFT JOIN skill_combo_steps scs ON pc.id = scs.combo_id
      LEFT JOIN skills s ON scs.skill_id = s.id
      WHERE pc.pokemon_instance_id = $1
      GROUP BY pc.id
      ORDER BY pc.is_default DESC, pc.created_at DESC
    `, [pokemonInstanceId]);

    // 缓存到 Redis
    const cacheKey = `pokemon:combos:${pokemonInstanceId}`;
    await redis.setex(cacheKey, 300, JSON.stringify(combos));

    return combos;
  }

  /**
   * 创建技能组合
   */
  static async createCombo(pokemonInstanceId, userId, { name, description, steps, isDefault }) {
    // 验证精灵所有权
    const pokemon = await db.getRow(
      'SELECT id, user_id FROM pokemon_instances WHERE id = $1',
      [pokemonInstanceId]
    );

    if (!pokemon || pokemon.user_id !== userId) {
      throw new Error('精灵不存在或无权访问');
    }

    // 检查组合数量限制
    const existingCount = await db.getValue(
      'SELECT COUNT(*) FROM pokemon_skill_combos WHERE pokemon_instance_id = $1',
      [pokemonInstanceId]
    );

    if (existingCount >= 5) {
      throw new Error('每个精灵最多创建5个技能组合');
    }

    // 验证技能是否可用
    await this.validateSkills(pokemonInstanceId, steps.map(s => s.skillId));

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 创建技能组合
      const combo = await db.getRowWithClient(client, `
        INSERT INTO pokemon_skill_combos (pokemon_instance_id, name, description, is_default)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [pokemonInstanceId, name, description || null, isDefault || false]);

      // 创建步骤
      for (let i = 0; i < steps.length; i++) {
        await client.query(`
          INSERT INTO skill_combo_steps (combo_id, step_order, skill_id, delay_ms, condition_type, condition_params)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          combo.id,
          i + 1,
          steps[i].skillId,
          steps[i].delayMs || 0,
          steps[i].conditionType || 'always',
          steps[i].conditionParams ? JSON.stringify(steps[i].conditionParams) : null
        ]);
      }

      // 如果设为默认，取消其他默认
      if (isDefault) {
        await client.query(`
          UPDATE pokemon_skill_combos
          SET is_default = FALSE
          WHERE pokemon_instance_id = $1 AND id != $2
        `, [pokemonInstanceId, combo.id]);
      }

      await client.query('COMMIT');

      // 清除缓存
      await redis.del(`pokemon:combos:${pokemonInstanceId}`);

      metrics.counter('pokemon_combo_created').inc();
      return await this.getCombosByPokemon(pokemonInstanceId, userId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 验证技能是否可用
   */
  static async validateSkills(pokemonInstanceId, skillIds) {
    // 获取精灵已学习的技能
    const learnedSkills = await db.getRows(`
      SELECT skill_id FROM pokemon_skills
      WHERE pokemon_instance_id = $1
    `, [pokemonInstanceId]);

    const learnedSkillIds = learnedSkills.map(s => s.skill_id);

    for (const skillId of skillIds) {
      if (!learnedSkillIds.includes(skillId)) {
        throw new Error(`精灵未学习技能 ${skillId}`);
      }
    }
  }

  /**
   * 更新技能组合
   */
  static async updateCombo(comboId, userId, updates) {
    const combo = await db.getRow(
      'SELECT * FROM pokemon_skill_combos WHERE id = $1',
      [comboId]
    );

    if (!combo) {
      throw new Error('技能组合不存在');
    }

    // 验证所有权
    const pokemon = await db.getRow(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [combo.pokemon_instance_id]
    );

    if (pokemon.user_id !== userId) {
      throw new Error('无权修改该技能组合');
    }

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 更新基本信息
      if (updates.name || updates.description !== undefined) {
        await client.query(`
          UPDATE pokemon_skill_combos
          SET name = COALESCE($1, name),
              description = COALESCE($2, description),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
        `, [updates.name, updates.description, comboId]);
      }

      // 更新步骤
      if (updates.steps) {
        await this.validateSkills(combo.pokemon_instance_id, updates.steps.map(s => s.skillId));

        // 删除旧步骤
        await client.query('DELETE FROM skill_combo_steps WHERE combo_id = $1', [comboId]);

        // 插入新步骤
        for (let i = 0; i < updates.steps.length; i++) {
          await client.query(`
            INSERT INTO skill_combo_steps (combo_id, step_order, skill_id, delay_ms, condition_type, condition_params)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            comboId,
            i + 1,
            updates.steps[i].skillId,
            updates.steps[i].delayMs || 0,
            updates.steps[i].conditionType || 'always',
            updates.steps[i].conditionParams ? JSON.stringify(updates.steps[i].conditionParams) : null
          ]);
        }
      }

      await client.query('COMMIT');

      // 清除缓存
      await redis.del(`pokemon:combos:${combo.pokemon_instance_id}`);

      return await this.getCombosByPokemon(combo.pokemon_instance_id, userId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 删除技能组合
   */
  static async deleteCombo(comboId, userId) {
    const combo = await db.getRow(
      'SELECT pc.*, pi.user_id FROM pokemon_skill_combos pc ' +
      'JOIN pokemon_instances pi ON pc.pokemon_instance_id = pi.id ' +
      'WHERE pc.id = $1',
      [comboId]
    );

    if (!combo) {
      throw new Error('技能组合不存在');
    }

    if (combo.user_id !== userId) {
      throw new Error('无权删除该技能组合');
    }

    await db.query('DELETE FROM pokemon_skill_combos WHERE id = $1', [comboId]);

    // 清除缓存
    await redis.del(`pokemon:combos:${combo.pokemon_instance_id}`);

    metrics.counter('pokemon_combo_deleted').inc();
  }

  /**
   * 获取可用连招效果
   */
  static async getComboEffects() {
    const cacheKey = 'combo:effects:all';
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const effects = await db.getRows('SELECT * FROM combo_effects ORDER BY min_steps');

    await redis.setex(cacheKey, 3600, JSON.stringify(effects));
    return effects;
  }

  /**
   * 获取连招使用统计
   */
  static async getComboStats(comboId, userId) {
    const stats = await db.getRow(`
      SELECT * FROM player_combo_stats
      WHERE combo_id = $1 AND user_id = $2
    `, [comboId, userId]);

    return stats || {
      combo_id: comboId,
      total_uses: 0,
      successful_uses: 0,
      total_damage_dealt: 0,
      success_rate: 0
    };
  }

  /**
   * 设置默认技能组合
   */
  static async setDefaultCombo(comboId, userId) {
    const combo = await db.getRow(
      'SELECT pc.*, pi.user_id FROM pokemon_skill_combos pc ' +
      'JOIN pokemon_instances pi ON pc.pokemon_instance_id = pi.id ' +
      'WHERE pc.id = $1',
      [comboId]
    );

    if (!combo || combo.user_id !== userId) {
      throw new Error('技能组合不存在或无权访问');
    }

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 取消当前默认
      await client.query(`
        UPDATE pokemon_skill_combos
        SET is_default = FALSE
        WHERE pokemon_instance_id = $1
      `, [combo.pokemon_instance_id]);

      // 设置新默认
      await client.query(`
        UPDATE pokemon_skill_combos
        SET is_default = TRUE
        WHERE id = $1
      `, [comboId]);

      await client.query('COMMIT');

      // 清除缓存
      await redis.del(`pokemon:combos:${combo.pokemon_instance_id}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 记录连招使用（供战斗服务调用）
   */
  static async recordComboUse(comboId, userId, success, damageDealt) {
    await db.query(`
      INSERT INTO player_combo_stats (user_id, combo_id, total_uses, successful_uses, total_damage_dealt, last_used_at)
      VALUES ($1, $2, 1, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, combo_id)
      DO UPDATE SET
        total_uses = player_combo_stats.total_uses + 1,
        successful_uses = player_combo_stats.successful_uses + $3,
        total_damage_dealt = player_combo_stats.total_damage_dealt + $4,
        last_used_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `, [userId, comboId, success ? 1 : 0, damageDealt || 0]);
  }

  /**
   * 计算连招效果
   */
  static async calculateComboEffect(skillSequence, timeWindowMs) {
    const effects = await this.getComboEffects();
    const applicableEffects = [];

    for (const effect of effects) {
      // 检查技能数量
      if (skillSequence.length < effect.min_steps) continue;

      // 检查时间窗口
      if (timeWindowMs > effect.time_window_ms) continue;

      // 检查技能类型要求
      if (effect.skill_type_requirements) {
        const requirements = effect.skill_type_requirements;
        for (let i = 0; i < requirements.length && i < skillSequence.length; i++) {
          if (skillSequence[i].type !== requirements[i]) continue;
        }
      }

      applicableEffects.push(effect);
    }

    return applicableEffects;
  }
}

module.exports = SkillComboService;
```

### 4. 战斗系统集成

```javascript
// backend/services/gym-service/src/services/BattleComboExecutor.js

const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');
const axios = require('axios');

class BattleComboExecutor {
  /**
   * 执行连招
   */
  static async executeCombo(battle, attacker, comboId) {
    const startTime = Date.now();

    // 获取连招数据
    const combo = await this.getComboData(comboId);
    if (!combo) {
      throw new Error('连招不存在');
    }

    const results = [];
    let totalDamage = 0;
    let successCount = 0;

    for (const step of combo.steps) {
      const stepStartTime = Date.now();

      // 检查条件
      if (step.conditionType !== 'always') {
        const conditionMet = await this.checkCondition(
          battle,
          attacker,
          step.conditionType,
          results
        );

        if (!conditionMet) {
          logger.debug(`连招步骤 ${step.step_order} 条件不满足: ${step.conditionType}`);
          continue;
        }
      }

      // 延迟
      if (step.delayMs > 0) {
        await this.delay(step.delayMs);
      }

      // 执行技能
      try {
        const skillResult = await this.executeSkill(battle, attacker, step.skillId);
        results.push({
          step: step.step_order,
          skillId: step.skillId,
          result: skillResult
        });

        if (skillResult.success) {
          successCount++;
          totalDamage += skillResult.damage || 0;
        }

        metrics.counter('combo_skill_executed').inc();
      } catch (error) {
        logger.error(`连招技能执行失败: ${step.skillId}`, error);
        results.push({
          step: step.step_order,
          skillId: step.skillId,
          error: error.message
        });
      }
    }

    // 计算连招效果
    const timeWindowMs = Date.now() - startTime;
    const comboEffects = await this.calculateComboEffects(
      combo.steps,
      timeWindowMs,
      results
    );

    // 应用连招效果
    const effectResults = await this.applyComboEffects(battle, attacker, comboEffects);

    // 记录统计
    const success = successCount === combo.steps.length;
    await this.recordStats(comboId, attacker.userId, success, totalDamage);

    return {
      comboId: combo.id,
      comboName: combo.name,
      totalSteps: combo.steps.length,
      executedSteps: successCount,
      totalDamage,
      timeWindowMs,
      effects: effectResults,
      results
    };
  }

  /**
   * 获取连招数据（从 pokemon-service 或缓存）
   */
  static async getComboData(comboId) {
    // 这里应该从 pokemon-service 获取或从缓存读取
    // 简化实现，实际应该调用 API
    const response = await axios.get(
      `${process.env.POKEMON_SERVICE_URL}/internal/combos/${comboId}`
    );
    return response.data;
  }

  /**
   * 检查条件
   */
  static async checkCondition(battle, attacker, conditionType, previousResults) {
    switch (conditionType) {
      case 'on_hit':
        return previousResults.some(r => r.result?.hit);
      case 'on_crit':
        return previousResults.some(r => r.result?.critical);
      case 'on_dodge':
        return previousResults.some(r => r.result?.dodged);
      default:
        return true;
    }
  }

  /**
   * 执行技能
   */
  static async executeSkill(battle, attacker, skillId) {
    // 调用战斗系统的技能执行逻辑
    // 这里简化实现
    return {
      success: true,
      damage: Math.floor(Math.random() * 100) + 50,
      hit: true,
      critical: Math.random() > 0.8
    };
  }

  /**
   * 计算连招效果
   */
  static async calculateComboEffects(steps, timeWindowMs, results) {
    const effects = [];

    // 检查是否在时间窗口内
    if (timeWindowMs <= 3000 && steps.length >= 2) {
      effects.push({
        type: 'damage_boost',
        value: 10 + (steps.length - 2) * 5, // 每多一步增加 5%
        reason: 'fast_combo'
      });
    }

    // 检查暴击连招
    const critCount = results.filter(r => r.result?.critical).length;
    if (critCount >= 2) {
      effects.push({
        type: 'status_apply',
        status: 'stun',
        duration: 1000,
        reason: 'critical_chain'
      });
    }

    return effects;
  }

  /**
   * 应用连招效果
   */
  static async applyComboEffects(battle, attacker, effects) {
    const results = [];

    for (const effect of effects) {
      switch (effect.type) {
        case 'damage_boost':
          // 增加伤害加成状态
          results.push({
            effect: 'damage_boost',
            applied: true,
            value: effect.value
          });
          break;

        case 'status_apply':
          // 应用状态效果
          results.push({
            effect: 'status_apply',
            applied: true,
            status: effect.status,
            duration: effect.duration
          });
          break;

        case 'cooldown_reduce':
          // 减少冷却时间
          results.push({
            effect: 'cooldown_reduce',
            applied: true,
            value: effect.value
          });
          break;
      }
    }

    return results;
  }

  /**
   * 记录统计
   */
  static async recordStats(comboId, userId, success, damageDealt) {
    try {
      await axios.post(
        `${process.env.POKEMON_SERVICE_URL}/internal/combos/${comboId}/stats`,
        { userId, success, damageDealt }
      );
    } catch (error) {
      logger.error('记录连招统计失败:', error);
    }
  }

  /**
   * 延迟函数
   */
  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = BattleComboExecutor;
```

### 5. 前端连招管理组件

```javascript
// frontend/game-client/src/components/SkillComboManager.js

import React, { useState, useEffect } from 'react';
import { pokemonService } from '../services/api';
import './SkillComboManager.css';

const SkillComboManager = ({ pokemonId, onClose }) => {
  const [combos, setCombos] = useState([]);
  const [availableEffects, setAvailableEffects] = useState([]);
  const [editingCombo, setEditingCombo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [pokemonId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [combosRes, effectsRes] = await Promise.all([
        pokemonService.getSkillCombos(pokemonId),
        pokemonService.getComboEffects()
      ]);

      setCombos(combosRes.data);
      setAvailableEffects(effectsRes.data);
    } catch (error) {
      console.error('加载数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCombo = () => {
    setEditingCombo({
      name: '',
      description: '',
      steps: [
        { skillId: null, delayMs: 0, conditionType: 'always' },
        { skillId: null, delayMs: 0, conditionType: 'always' }
      ]
    });
  };

  const handleSaveCombo = async () => {
    try {
      if (editingCombo.id) {
        await pokemonService.updateSkillCombo(editingCombo.id, editingCombo);
      } else {
        await pokemonService.createSkillCombo(pokemonId, editingCombo);
      }

      await loadData();
      setEditingCombo(null);
    } catch (error) {
      console.error('保存失败:', error);
      alert('保存失败: ' + error.message);
    }
  };

  const handleDeleteCombo = async (comboId) => {
    if (!confirm('确定删除该技能组合？')) return;

    try {
      await pokemonService.deleteSkillCombo(comboId);
      await loadData();
    } catch (error) {
      console.error('删除失败:', error);
    }
  };

  const handleSetDefault = async (comboId) => {
    try {
      await pokemonService.setDefaultCombo(comboId);
      await loadData();
    } catch (error) {
      console.error('设置默认失败:', error);
    }
  };

  const addStep = () => {
    if (editingCombo.steps.length >= 5) {
      alert('最多5个步骤');
      return;
    }

    setEditingCombo({
      ...editingCombo,
      steps: [
        ...editingCombo.steps,
        { skillId: null, delayMs: 0, conditionType: 'always' }
      ]
    });
  };

  const removeStep = (index) => {
    if (editingCombo.steps.length <= 2) {
      alert('至少2个步骤');
      return;
    }

    const newSteps = editingCombo.steps.filter((_, i) => i !== index);
    setEditingCombo({
      ...editingCombo,
      steps: newSteps
    });
  };

  const updateStep = (index, field, value) => {
    const newSteps = [...editingCombo.steps];
    newSteps[index] = {
      ...newSteps[index],
      [field]: value
    };
    setEditingCombo({
      ...editingCombo,
      steps: newSteps
    });
  };

  if (loading) {
    return <div className="combo-manager-loading">加载中...</div>;
  }

  return (
    <div className="skill-combo-manager">
      <div className="combo-manager-header">
        <h2>技能组合管理</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      {editingCombo ? (
        <div className="combo-editor">
          <div className="form-group">
            <label>组合名称</label>
            <input
              type="text"
              value={editingCombo.name}
              onChange={(e) => setEditingCombo({ ...editingCombo, name: e.target.value })}
              placeholder="输入组合名称"
              maxLength={50}
            />
          </div>

          <div className="form-group">
            <label>描述</label>
            <textarea
              value={editingCombo.description || ''}
              onChange={(e) => setEditingCombo({ ...editingCombo, description: e.target.value })}
              placeholder="描述这个组合的用途"
              maxLength={200}
            />
          </div>

          <div className="steps-section">
            <label>技能步骤</label>
            {editingCombo.steps.map((step, index) => (
              <div key={index} className="step-item">
                <span className="step-number">{index + 1}</span>
                <select
                  value={step.skillId || ''}
                  onChange={(e) => updateStep(index, 'skillId', parseInt(e.target.value))}
                >
                  <option value="">选择技能</option>
                  {/* 技能列表 */}
                </select>
                <input
                  type="number"
                  value={step.delayMs}
                  onChange={(e) => updateStep(index, 'delayMs', parseInt(e.target.value))}
                  min={0}
                  max={5000}
                  placeholder="延迟(ms)"
                />
                <select
                  value={step.conditionType}
                  onChange={(e) => updateStep(index, 'conditionType', e.target.value)}
                >
                  <option value="always">总是执行</option>
                  <option value="on_hit">命中后</option>
                  <option value="on_crit">暴击后</option>
                  <option value="on_dodge">闪避后</option>
                </select>
                <button
                  className="remove-step-btn"
                  onClick={() => removeStep(index)}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="add-step-btn" onClick={addStep}>
              + 添加步骤
            </button>
          </div>

          <div className="combo-effects-info">
            <h4>可用连招效果</h4>
            <div className="effects-list">
              {availableEffects.map((effect) => (
                <div key={effect.id} className="effect-item">
                  <strong>{effect.name}</strong>
                  <p>{effect.description}</p>
                  <small>需要 {effect.min_steps} 个技能，{effect.time_window_ms}ms 内</small>
                </div>
              ))}
            </div>
          </div>

          <div className="combo-actions">
            <button className="save-btn" onClick={handleSaveCombo}>
              保存
            </button>
            <button className="cancel-btn" onClick={() => setEditingCombo(null)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="combos-list">
          <button className="create-btn" onClick={handleCreateCombo}>
            + 创建新组合
          </button>

          {combos.length === 0 ? (
            <div className="no-combos">
              还没有创建技能组合
            </div>
          ) : (
            combos.map((combo) => (
              <div key={combo.id} className={`combo-card ${combo.is_default ? 'default' : ''}`}>
                {combo.is_default && <span className="default-badge">默认</span>}
                <h3>{combo.name}</h3>
                <p>{combo.description}</p>
                <div className="combo-steps-preview">
                  {combo.steps.map((step, index) => (
                    <span key={index} className="step-badge">
                      {step.skillName || `技能${step.stepOrder}`}
                    </span>
                  ))}
                </div>
                <div className="combo-card-actions">
                  <button onClick={() => setEditingCombo(combo)}>编辑</button>
                  {!combo.is_default && (
                    <button onClick={() => handleSetDefault(combo.id)}>设为默认</button>
                  )}
                  <button
                    className="delete-btn"
                    onClick={() => handleDeleteCombo(combo.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default SkillComboManager;
```

### 6. Prometheus 指标

```javascript
// 添加到 backend/shared/metrics.js

// 技能组合创建计数
metrics.gauge('pokemon_combo_created_total', 'Total skill combos created');

// 技能组合删除计数
metrics.gauge('pokemon_combo_deleted_total', 'Total skill combos deleted');

// 连招技能执行计数
metrics.counter('combo_skill_executed_total', 'Total combo skills executed');

// 连招执行延迟
metrics.histogram(
  'combo_execution_duration_ms',
  'Combo execution duration in milliseconds',
  [100, 500, 1000, 2000, 3000, 5000]
);

// 连招成功率
metrics.gauge('combo_success_rate', 'Combo success rate percentage');
```

## 验收标准

- [ ] 玩家可为每个精灵创建最多 5 个技能组合
- [ ] 每个组合包含 2-5 个技能步骤
- [ ] 支持设置技能延迟和执行条件
- [ ] 战斗中可一键触发预设连招
- [ ] 连招效果系统正常工作（伤害加成、状态附加等）
- [ ] 连招统计数据准确记录
- [ ] 前端界面支持创建、编辑、删除、设置默认组合
- [ ] 单元测试覆盖核心逻辑
- [ ] API 文档完整
- [ ] Prometheus 指标正常上报

## 影响范围

- database/migrations: 新增 4 张表
- pokemon-service: 新增技能组合管理路由和服务
- gym-service: 新增连招执行器
- social-service: PVP 战斗集成（可选）
- gateway: 新增 API 路由转发
- game-client: 新增技能组合管理界面
- backend/shared: 新增 Prometheus 指标

## 参考

- REQ-00019: 精灵技能学习与技能机器系统
- REQ-00054: 道馆战斗系统
- REQ-00073: 玩家对战系统（PVP Duel）
- REQ-00109: 精灵团队战斗系统（Team Battle）
