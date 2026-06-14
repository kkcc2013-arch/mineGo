# REQ-00197: 精灵天赋系统与隐藏属性机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00197 |
| 标题 | 精灵天赋系统与隐藏属性机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、catch-service、gym-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-14 14:00 |

## 需求描述

实现精灵天赋系统，为每只精灵增加隐藏属性和独特天赋技能，提升游戏策略深度和精灵个体差异。

### 核心功能

1. **天赋类型系统**
   - 攻击天赋：提升特定属性技能伤害
   - 防御天赋：减少特定属性技能伤害
   - 速度天赋：提升先手概率
   - 特殊天赋：独特效果（吸血、反伤、暴击等）
   - 辅助天赋：团队增益效果

2. **天赋觉醒机制**
   - 天赋等级系统（1-5级）
   - 天赋觉醒材料消耗
   - 天赋觉醒成功率机制
   - 天赋重置与洗练功能

3. **隐藏属性系统**
   - 潜力值（影响成长上限）
   - 幸运值（影响捕捉和掉落）
   - 亲密度阈值（影响技能解锁）
   - 隐藏个体值波动范围

4. **天赋继承系统**
   - 精灵培育时天赋遗传概率
   - 天赋继承锁（保护核心天赋）
   - 天赋变异机制（随机获得新天赋）

## 技术方案

### 1. 数据库设计

```sql
-- 天赋类型定义表
CREATE TABLE talent_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    category VARCHAR(20) NOT NULL, -- attack/defense/speed/special/support
    description TEXT,
    max_level INTEGER DEFAULT 5,
    effect_config JSONB NOT NULL, -- 效果配置
    icon_url VARCHAR(255),
    rarity VARCHAR(20) DEFAULT 'common', -- common/rare/epic/legendary
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 天赋效果配置示例
/*
{
  "type": "damage_boost",
  "attribute": "fire",
  "base_value": 0.05,
  "per_level": 0.02,
  "max_value": 0.15
}
*/

-- 精灵天赋表
CREATE TABLE pokemon_talents (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    talent_type_id INTEGER NOT NULL REFERENCES talent_types(id),
    current_level INTEGER DEFAULT 1,
    is_locked BOOLEAN DEFAULT false, -- 天赋继承锁
    awakened_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_id, talent_type_id)
);

-- 精灵隐藏属性表
CREATE TABLE pokemon_hidden_attributes (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    potential_value DECIMAL(5,2) DEFAULT 50.00, -- 潜力值 0-100
    luck_value DECIMAL(5,2) DEFAULT 50.00, -- 幸运值 0-100
    intimacy_threshold INTEGER DEFAULT 100, -- 亲密度阈值
    hidden_iv_fluctuation DECIMAL(4,2) DEFAULT 0.00, -- 隐藏个体值波动
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_id)
);

-- 天赋觉醒记录表
CREATE TABLE talent_awakening_logs (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL,
    talent_type_id INTEGER NOT NULL,
    previous_level INTEGER NOT NULL,
    new_level INTEGER NOT NULL,
    materials_consumed JSONB,
    success BOOLEAN NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_pokemon_talents_pokemon ON pokemon_talents(pokemon_id);
CREATE INDEX idx_pokemon_hidden_attrs_pokemon ON pokemon_hidden_attributes(pokemon_id);
CREATE INDEX idx_talent_types_category ON talent_types(category);
CREATE INDEX idx_talent_types_rarity ON talent_types(rarity);
```

### 2. 天赋服务层

```javascript
// backend/services/pokemon-service/src/talents/TalentService.js

const { db } = require('../../shared/db');
const { logger } = require('../../shared/logger');
const { cache } = require('../../shared/cache');

class TalentService {
  constructor() {
    this.TALENT_CACHE_TTL = 3600; // 1小时缓存
  }

  /**
   * 获取精灵所有天赋
   */
  async getPokemonTalents(pokemonId) {
    const cacheKey = `pokemon:${pokemonId}:talents`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const result = await db.query(`
      SELECT pt.*, tt.name, tt.category, tt.description, tt.effect_config, tt.rarity
      FROM pokemon_talents pt
      JOIN talent_types tt ON pt.talent_type_id = tt.id
      WHERE pt.pokemon_id = $1
      ORDER BY tt.rarity DESC, pt.current_level DESC
    `, [pokemonId]);

    await cache.set(cacheKey, result.rows, this.TALENT_CACHE_TTL);
    return result.rows;
  }

  /**
   * 计算天赋效果
   */
  calculateTalentEffects(talents) {
    const effects = {};
    
    for (const talent of talents) {
      const config = talent.effect_config;
      const effectValue = config.base_value + (config.per_level * (talent.current_level - 1));
      
      const key = `${config.type}_${config.attribute || 'general'}`;
      effects[key] = (effects[key] || 0) + effectValue;
    }
    
    return effects;
  }

  /**
   * 天赋觉醒
   */
  async awakenTalent(pokemonId, talentTypeId, materials, userId) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 获取当前天赋
      const talentResult = await client.query(`
        SELECT * FROM pokemon_talents 
        WHERE pokemon_id = $1 AND talent_type_id = $2
        FOR UPDATE
      `, [pokemonId, talentTypeId]);

      if (talentResult.rows.length === 0) {
        throw new Error('Talent not found');
      }

      const talent = talentResult.rows[0];
      const talentType = await this.getTalentType(talentTypeId);

      if (talent.current_level >= talentType.max_level) {
        throw new Error('Talent already at max level');
      }

      // 验证材料消耗
      const requiredMaterials = this.calculateAwakeningMaterials(talent.current_level + 1);
      if (!this.validateMaterials(materials, requiredMaterials)) {
        throw new Error('Insufficient materials');
      }

      // 扣除材料（调用背包服务）
      await this.consumeMaterials(userId, materials);

      // 计算成功率
      const successRate = this.calculateSuccessRate(talent.current_level, materials);
      const success = Math.random() < successRate;

      // 记录觉醒日志
      await client.query(`
        INSERT INTO talent_awakening_logs 
        (pokemon_id, talent_type_id, previous_level, new_level, materials_consumed, success)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [pokemonId, talentTypeId, talent.current_level, 
          success ? talent.current_level + 1 : talent.current_level,
          JSON.stringify(materials), success]);

      if (success) {
        await client.query(`
          UPDATE pokemon_talents 
          SET current_level = current_level + 1, awakened_at = CURRENT_TIMESTAMP
          WHERE pokemon_id = $1 AND talent_type_id = $2
        `, [pokemonId, talentTypeId]);
      }

      await client.query('COMMIT');

      // 清除缓存
      await cache.del(`pokemon:${pokemonId}:talents`);

      return {
        success,
        newLevel: success ? talent.current_level + 1 : talent.current_level,
        successRate
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 天赋继承计算
   */
  async calculateTalentInheritance(parent1Id, parent2Id) {
    const [talents1, talents2] = await Promise.all([
      this.getPokemonTalents(parent1Id),
      this.getPokemonTalents(parent2Id)
    ]);

    const inheritedTalents = [];
    const lockedTalents = [...talents1, ...talents2].filter(t => t.is_locked);

    // 锁定天赋必继承
    for (const locked of lockedTalents) {
      inheritedTalents.push({
        talentTypeId: locked.talent_type_id,
        level: Math.max(1, locked.current_level - 1), // 继承时降1级
        locked: true
      });
    }

    // 随机继承其他天赋
    const unlockedTalents = [...talents1, ...talents2]
      .filter(t => !t.is_locked && !inheritedTalents.find(it => it.talentTypeId === t.talent_type_id));

    const inheritanceChance = 0.3; // 30%继承概率
    for (const talent of unlockedTalents) {
      if (Math.random() < inheritanceChance) {
        inheritedTalents.push({
          talentTypeId: talent.talent_type_id,
          level: Math.max(1, talent.current_level - 2),
          locked: false
        });
      }
    }

    // 变异概率（5%获得新天赋）
    if (Math.random() < 0.05) {
      const newTalent = await this.getRandomTalentType();
      inheritedTalents.push({
        talentTypeId: newTalent.id,
        level: 1,
        locked: false,
        isMutation: true
      });
    }

    return inheritedTalents;
  }

  /**
   * 计算觉醒成功率
   */
  calculateSuccessRate(currentLevel, materials) {
    const baseRates = {
      1: 0.95, // 1→2: 95%
      2: 0.85, // 2→3: 85%
      3: 0.70, // 3→4: 70%
      4: 0.50  // 4→5: 50%
    };

    let rate = baseRates[currentLevel] || 0.5;

    // 额外材料加成
    if (materials.luckyStone) {
      rate += 0.1 * materials.luckyStone;
    }

    return Math.min(rate, 0.99); // 最高99%
  }

  /**
   * 验证材料是否足够
   */
  validateMaterials(provided, required) {
    for (const [material, amount] of Object.entries(required)) {
      if ((provided[material] || 0) < amount) {
        return false;
      }
    }
    return true;
  }
}

module.exports = new TalentService();
```

### 3. 隐藏属性服务

```javascript
// backend/services/pokemon-service/src/talents/HiddenAttributeService.js

const { db } = require('../../shared/db');
const { logger } = require('../../shared/logger');

class HiddenAttributeService {
  /**
   * 初始化精灵隐藏属性
   */
  async initializeHiddenAttributes(pokemonId, speciesId) {
    // 基于物种基础值生成随机隐藏属性
    const speciesBase = await this.getSpeciesBaseValues(speciesId);
    
    const potentialValue = this.generateRandomValue(
      speciesBase.potentialMin || 30,
      speciesBase.potentialMax || 70
    );
    
    const luckValue = this.generateRandomValue(
      speciesBase.luckMin || 40,
      speciesBase.luckMax || 60
    );
    
    const intimacyThreshold = this.calculateIntimacyThreshold(speciesId);
    const hiddenIvFluctuation = (Math.random() - 0.5) * 10; // -5 ~ +5

    await db.query(`
      INSERT INTO pokemon_hidden_attributes 
      (pokemon_id, potential_value, luck_value, intimacy_threshold, hidden_iv_fluctuation)
      VALUES ($1, $2, $3, $4, $5)
    `, [pokemonId, potentialValue, luckValue, intimacyThreshold, hiddenIvFluctuation]);

    return {
      potentialValue,
      luckValue,
      intimacyThreshold,
      hiddenIvFluctuation
    };
  }

  /**
   * 获取隐藏属性
   */
  async getHiddenAttributes(pokemonId) {
    const result = await db.query(`
      SELECT * FROM pokemon_hidden_attributes WHERE pokemon_id = $1
    `, [pokemonId]);

    if (result.rows.length === 0) {
      // 如果不存在则初始化
      const pokemon = await this.getPokemonSpecies(pokemonId);
      return this.initializeHiddenAttributes(pokemonId, pokemon.species_id);
    }

    return result.rows[0];
  }

  /**
   * 潜力值加成计算
   */
  calculatePotentialBonus(potentialValue) {
    // 潜力值影响成长上限
    // 50 = 无加成, 100 = +20% 成长上限
    return 1 + (potentialValue - 50) * 0.004;
  }

  /**
   * 幸运值加成计算
   */
  calculateLuckBonus(luckValue) {
    return {
      catchRateBonus: luckValue * 0.002, // 幸运值 * 0.2% 捕捉加成
      dropRateBonus: luckValue * 0.001,  // 幸运值 * 0.1% 掉落加成
      criticalBonus: luckValue * 0.001   // 幸运值 * 0.1% 暴击加成
    };
  }

  /**
   * 更新隐藏属性
   */
  async updateHiddenAttribute(pokemonId, attribute, value) {
    const allowedAttributes = ['potential_value', 'luck_value', 'intimacy_threshold'];
    
    if (!allowedAttributes.includes(attribute)) {
      throw new Error(`Invalid attribute: ${attribute}`);
    }

    await db.query(`
      UPDATE pokemon_hidden_attributes 
      SET ${attribute} = $2, last_updated = CURRENT_TIMESTAMP
      WHERE pokemon_id = $1
    `, [pokemonId, value]);
  }

  /**
   * 生成随机值
   */
  generateRandomValue(min, max) {
    return min + Math.random() * (max - min);
  }
}

module.exports = new HiddenAttributeService();
```

### 4. API 路由

```javascript
// backend/services/pokemon-service/src/routes/talents.js

const express = require('express');
const router = express.Router();
const TalentService = require('../talents/TalentService');
const HiddenAttributeService = require('../talents/HiddenAttributeService');
const { authenticate } = require('../../../shared/middleware/auth');
const { validateRequest } = require('../../../shared/middleware/validation');

/**
 * GET /api/pokemon/:id/talents
 * 获取精灵天赋列表
 */
router.get('/:id/talents', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.id);
    const talents = await TalentService.getPokemonTalents(pokemonId);
    const effects = TalentService.calculateTalentEffects(talents);
    
    res.json({
      success: true,
      data: {
        talents,
        calculatedEffects: effects
      }
    });
  } catch (error) {
    logger.error('Get talents error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/pokemon/:id/talents/:talentId/awaken
 * 天赋觉醒
 */
router.post('/:id/talents/:talentId/awaken', 
  authenticate, 
  validateRequest({
    body: {
      materials: { type: 'object', required: true }
    }
  }),
  async (req, res) => {
    try {
      const pokemonId = parseInt(req.params.id);
      const talentId = parseInt(req.params.talentId);
      const { materials } = req.body;

      const result = await TalentService.awakenTalent(
        pokemonId, 
        talentId, 
        materials, 
        req.user.id
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Awaken talent error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/pokemon/:id/talents/:talentId/lock
 * 锁定/解锁天赋
 */
router.post('/:id/talents/:talentId/lock', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.id);
    const talentId = parseInt(req.params.talentId);
    const { locked } = req.body;

    await db.query(`
      UPDATE pokemon_talents SET is_locked = $3
      WHERE pokemon_id = $1 AND talent_type_id = $2
    `, [pokemonId, talentId, locked]);

    await cache.del(`pokemon:${pokemonId}:talents`);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/pokemon/:id/hidden-attributes
 * 获取隐藏属性
 */
router.get('/:id/hidden-attributes', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.id);
    const attrs = await HiddenAttributeService.getHiddenAttributes(pokemonId);
    
    const bonuses = {
      potentialBonus: HiddenAttributeService.calculatePotentialBonus(attrs.potential_value),
      luckBonuses: HiddenAttributeService.calculateLuckBonus(attrs.luck_value)
    };

    res.json({
      success: true,
      data: {
        attributes: attrs,
        calculatedBonuses: bonuses
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/pokemon/talents/inheritance-preview
 * 预览天赋继承结果
 */
router.post('/talents/inheritance-preview', 
  authenticate,
  validateRequest({
    body: {
      parent1Id: { type: 'integer', required: true },
      parent2Id: { type: 'integer', required: true }
    }
  }),
  async (req, res) => {
    try {
      const { parent1Id, parent2Id } = req.body;
      const result = await TalentService.calculateTalentInheritance(parent1Id, parent2Id);
      
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

module.exports = router;
```

### 5. 前端天赋面板组件

```javascript
// frontend/game-client/src/components/TalentPanel.js

class TalentPanel {
  constructor(pokemonId) {
    this.pokemonId = pokemonId;
    this.talents = [];
    this.hiddenAttrs = null;
  }

  async load() {
    const [talentRes, attrRes] = await Promise.all([
      fetch(`/api/pokemon/${this.pokemonId}/talents`, {
        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
      }),
      fetch(`/api/pokemon/${this.pokemonId}/hidden-attributes`, {
        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
      })
    ]);

    const talentData = await talentRes.json();
    const attrData = await attrRes.json();

    this.talents = talentData.data.talents;
    this.effects = talentData.data.calculatedEffects;
    this.hiddenAttrs = attrData.data;
  }

  render() {
    return `
      <div class="talent-panel">
        <h2>精灵天赋</h2>
        
        <div class="talent-list">
          ${this.talents.map(t => this.renderTalent(t)).join('')}
        </div>

        <div class="hidden-attributes">
          <h3>隐藏属性</h3>
          <div class="attr-row">
            <span>潜力值</span>
            <div class="progress-bar">
              <div class="progress" style="width: ${this.hiddenAttrs.attributes.potential_value}%"></div>
            </div>
            <span>${this.hiddenAttrs.attributes.potential_value.toFixed(1)}</span>
          </div>
          <div class="attr-row">
            <span>幸运值</span>
            <div class="progress-bar">
              <div class="progress" style="width: ${this.hiddenAttrs.attributes.luck_value}%"></div>
            </div>
            <span>${this.hiddenAttrs.attributes.luck_value.toFixed(1)}</span>
          </div>
        </div>

        <div class="calculated-effects">
          <h3>天赋效果</h3>
          ${Object.entries(this.effects).map(([key, value]) => `
            <div class="effect-row">
              <span>${this.formatEffectName(key)}</span>
              <span>+${(value * 100).toFixed(1)}%</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  renderTalent(talent) {
    const rarityColors = {
      common: '#9e9e9e',
      rare: '#2196f3',
      epic: '#9c27b0',
      legendary: '#ff9800'
    };

    return `
      <div class="talent-card ${talent.category}" style="border-color: ${rarityColors[talent.rarity]}">
        <div class="talent-header">
          <span class="talent-name">${talent.name}</span>
          <span class="talent-level">Lv.${talent.current_level}/${talent.max_level}</span>
        </div>
        <p class="talent-desc">${talent.description}</p>
        <div class="talent-actions">
          <button onclick="talentPanel.awaken(${talent.talent_type_id})" 
                  class="awaken-btn ${talent.current_level >= talent.max_level ? 'disabled' : ''}">
            觉醒
          </button>
          <button onclick="talentPanel.toggleLock(${talent.talent_type_id}, ${!talent.is_locked})"
                  class="lock-btn ${talent.is_locked ? 'locked' : ''}">
            ${talent.is_locked ? '🔒 已锁定' : '🔓 未锁定'}
          </button>
        </div>
      </div>
    `;
  }

  async awaken(talentId) {
    // 显示觉醒对话框
    const dialog = new AwakeningDialog(talentId);
    await dialog.show();
  }

  formatEffectName(key) {
    const names = {
      'damage_boost_fire': '火属性伤害加成',
      'damage_boost_water': '水属性伤害加成',
      'damage_reduction_physical': '物理伤害减免',
      'speed_boost': '速度加成',
      'critical_rate': '暴击率',
      'lifesteal': '吸血效果'
    };
    return names[key] || key;
  }
}

module.exports = TalentPanel;
```

### 6. 道馆战斗天赋效果集成

```javascript
// backend/services/gym-service/src/battle/TalentEffectApplier.js

class TalentEffectApplier {
  /**
   * 在战斗中应用天赋效果
   */
  applyTalentEffects(attacker, defender, baseDamage) {
    let finalDamage = baseDamage;
    const effects = attacker.talentEffects || {};

    // 属性伤害加成
    if (effects[`damage_boost_${attacker.moveType}`]) {
      finalDamage *= (1 + effects[`damage_boost_${attacker.moveType}`]);
    }

    // 属性伤害减免
    if (defender.talentEffects[`damage_reduction_${attacker.moveType}`]) {
      finalDamage *= (1 - defender.talentEffects[`damage_reduction_${attacker.moveType}`]);
    }

    // 暴击加成
    if (effects.critical_rate && Math.random() < effects.critical_rate) {
      finalDamage *= 1.5;
      attacker.battleLog.push('暴击！');
    }

    // 吸血效果
    if (effects.lifesteal) {
      const healAmount = finalDamage * effects.lifesteal;
      attacker.currentHp = Math.min(attacker.maxHp, attacker.currentHp + healAmount);
    }

    return Math.round(finalDamage);
  }

  /**
   * 计算先手概率
   */
  calculateFirstStrikeChance(attacker, defender) {
    const attackerSpeed = attacker.speed;
    const defenderSpeed = defender.speed;
    
    let firstStrikeBonus = 0;
    if (attacker.talentEffects.speed_boost) {
      firstStrikeBonus = attacker.talentEffects.speed_boost;
    }

    const baseChance = attackerSpeed / (attackerSpeed + defenderSpeed);
    return Math.min(baseChance + firstStrikeBonus, 0.95);
  }
}

module.exports = new TalentEffectApplier();
```

## 验收标准

- [ ] 天赋类型表包含至少 20 种不同天赋
- [ ] 天赋觉醒成功率按等级正确计算（1→2: 95%, 2→3: 85%, 3→4: 70%, 4→5: 50%）
- [ ] 天赋继承时锁定天赋必继承，非锁定天赋有 30% 概率继承
- [ ] 天赋变异概率为 5%
- [ ] 隐藏属性正确影响战斗和捕捉计算
- [ ] 潜力值正确影响精灵成长上限
- [ ] 幸运值正确计算捕捉加成和掉落加成
- [ ] 天赋效果在道馆战斗中正确应用
- [ ] 前端天赋面板正确展示所有天赋和隐藏属性
- [ ] 天赋觉醒消耗材料正确扣除
- [ ] 天赋锁功能正常工作

## 影响范围

- 新增数据库表：talent_types, pokemon_talents, pokemon_hidden_attributes, talent_awakening_logs
- 新增服务：TalentService, HiddenAttributeService, TalentEffectApplier
- 新增路由：/api/pokemon/:id/talents, /api/pokemon/:id/hidden-attributes
- 新增前端组件：TalentPanel, AwakeningDialog
- 影响现有服务：catch-service（捕捉计算）, gym-service（战斗计算）
- 新增迁移文件：添加天赋相关表和初始天赋数据

## 参考

- 宝可梦游戏天赋系统设计
- RPG 游戏隐藏属性机制
- 类似游戏：Pokemon GO IV 系统
