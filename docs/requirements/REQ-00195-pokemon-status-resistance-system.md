# REQ-00195: 精灵异常状态抗性与免疫计算系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00195 |
| 标题 | 精灵异常状态抗性与免疫计算系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gym-service、catch-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-14 12:30 |

## 需求描述

精灵在战斗中会受到各种异常状态影响（中毒、麻痹、灼伤、冻结、睡眠、混乱等），但目前系统缺少异常状态抗性和免疫的计算机制。本需求实现：

1. **种族抗性系统**：不同精灵种类对特定异常状态有天生抗性（如钢系免疫中毒、火系免疫灼伤）
2. **特性抗性系统**：精灵特性可提供异常状态免疫或抗性加成（如"免疫"特性免疫中毒）
3. **装备抗性加成**：装备道具可提供异常状态抗性加成
4. **等级与亲密度影响**：精灵等级和亲密度影响异常状态持续时间
5. **抗性叠加计算**：多来源抗性的合理叠加机制

## 技术方案

### 1. 数据库 Schema 设计

```sql
-- 精灵种族异常状态抗性表
CREATE TABLE pokemon_species_status_resistance (
  id SERIAL PRIMARY KEY,
  species_id INT NOT NULL REFERENCES pokemon_species(id),
  status_type VARCHAR(32) NOT NULL,  -- poison, paralyze, burn, freeze, sleep, confusion, flinch, attract
  resistance_value DECIMAL(4,2) NOT NULL DEFAULT 0.00,  -- 0.00 = 无抗性, 1.00 = 完全免疫
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(species_id, status_type)
);

-- 精灵特性异常状态免疫表
CREATE TABLE ability_status_immunity (
  id SERIAL PRIMARY KEY,
  ability_id INT NOT NULL REFERENCES abilities(id),
  status_type VARCHAR(32) NOT NULL,
  immunity_type VARCHAR(16) NOT NULL DEFAULT 'full',  -- full, partial
  resistance_bonus DECIMAL(4,2) DEFAULT 0.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ability_id, status_type)
);

-- 异常状态配置表
CREATE TABLE status_effect_config (
  id SERIAL PRIMARY KEY,
  status_type VARCHAR(32) NOT NULL UNIQUE,
  display_name_zh VARCHAR(64) NOT NULL,
  display_name_en VARCHAR(64) NOT NULL,
  display_name_ja VARCHAR(64) NOT NULL,
  base_duration_turns INT NOT NULL DEFAULT 3,
  can_stack BOOLEAN DEFAULT FALSE,
  max_stacks INT DEFAULT 1,
  tick_damage_percent DECIMAL(5,2),  -- 如中毒每回合扣血百分比
  tick_heal_percent DECIMAL(5,2),    -- 如睡眠每回合恢复百分比
  stat_modifiers JSONB,  -- {"attack": 0.5, "speed": 0.25}
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 精灵个体异常状态抗性加成表（装备、道具等）
CREATE TABLE pokemon_status_resistance_bonus (
  id SERIAL PRIMARY KEY,
  pokemon_id BIGINT NOT NULL REFERENCES pokemon(id),
  status_type VARCHAR(32) NOT NULL,
  bonus_source VARCHAR(32) NOT NULL,  -- equipment, item, buff, achievement
  source_id BIGINT,  -- 装备ID、道具ID等
  resistance_value DECIMAL(4,2) NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  INDEX idx_pokemon_status (pokemon_id, status_type)
);
```

### 2. 状态抗性计算引擎

```javascript
// backend/services/pokemon-service/src/statusResistanceEngine.js
'use strict';

const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const logger = createLogger('status-resistance-engine');

class StatusResistanceEngine {
  
  /**
   * 计算精灵对特定异常状态的综合抗性值
   * @param {Object} pokemon - 精灵实例数据
   * @param {string} statusType - 异常状态类型
   * @returns {Promise<Object>} 抗性计算结果
   */
  async calculateResistance(pokemon, statusType) {
    const resistance = {
      statusType,
      finalValue: 0.00,
      isImmune: false,
      components: {
        species: 0.00,
        ability: 0.00,
        equipment: 0.00,
        level: 0.00,
        friendship: 0.00
      }
    };
    
    // 1. 种族抗性
    const speciesResistance = await this.getSpeciesResistance(pokemon.species_id, statusType);
    resistance.components.species = speciesResistance;
    
    // 2. 特性抗性/免疫
    const abilityResult = await this.getAbilityImmunity(pokemon.ability_id, statusType);
    if (abilityResult.isImmune) {
      resistance.isImmune = true;
      resistance.components.ability = 1.00;
      resistance.finalValue = 1.00;
      return resistance;
    }
    resistance.components.ability = abilityResult.resistanceBonus;
    
    // 3. 装备抗性加成
    const equipmentBonus = await this.getEquipmentBonus(pokemon.id, statusType);
    resistance.components.equipment = equipmentBonus;
    
    // 4. 等级影响（高等级略微减少异常状态持续时间）
    const levelBonus = this.calculateLevelBonus(pokemon.level);
    resistance.components.level = levelBonus;
    
    // 5. 亲密度影响（高亲密度增加异常状态恢复概率）
    const friendshipBonus = this.calculateFriendshipBonus(pokemon.friendship);
    resistance.components.friendship = friendshipBonus;
    
    // 计算最终抗性值（叠加公式：1 - (1-a)(1-b)(1-c)...)
    const components = Object.values(resistance.components);
    resistance.finalValue = this.stackResistances(components);
    
    // 抗性值达到或超过 1.00 视为免疫
    if (resistance.finalValue >= 1.00) {
      resistance.isImmune = true;
      resistance.finalValue = 1.00;
    }
    
    return resistance;
  }
  
  /**
   * 抗性叠加计算（递减叠加，防止 100% 免疫）
   */
  stackResistances(values) {
    let remaining = 1.00;
    for (const value of values) {
      remaining *= (1.00 - Math.min(value, 1.00));
    }
    return 1.00 - remaining;
  }
  
  /**
   * 等级抗性加成计算
   */
  calculateLevelBonus(level) {
    // 每 10 级增加 2% 抗性，最高 20 级提供 4%
    return Math.min(level / 10 * 0.02, 0.20);
  }
  
  /**
   * 亲密度抗性加成计算
   */
  calculateFriendshipBonus(friendship) {
    // 每 50 点亲密度增加 1% 抗性，最高 255 点提供约 5%
    return Math.min(friendship / 50 * 0.01, 0.10);
  }
  
  /**
   * 获取种族抗性
   */
  async getSpeciesResistance(speciesId, statusType) {
    const { rows } = await query(`
      SELECT resistance_value 
      FROM pokemon_species_status_resistance
      WHERE species_id = $1 AND status_type = $2
    `, [speciesId, statusType]);
    
    return rows[0]?.resistance_value || 0.00;
  }
  
  /**
   * 获取特性免疫/抗性
   */
  async getAbilityImmunity(abilityId, statusType) {
    const { rows } = await query(`
      SELECT immunity_type, resistance_bonus
      FROM ability_status_immunity
      WHERE ability_id = $1 AND status_type = $2
    `, [abilityId, statusType]);
    
    if (!rows[0]) {
      return { isImmune: false, resistanceBonus: 0.00 };
    }
    
    return {
      isImmune: rows[0].immunity_type === 'full',
      resistanceBonus: rows[0].resistance_bonus || 0.00
    };
  }
  
  /**
   * 获取装备抗性加成
   */
  async getEquipmentBonus(pokemonId, statusType) {
    const { rows } = await query(`
      SELECT SUM(resistance_value) as total_bonus
      FROM pokemon_status_resistance_bonus
      WHERE pokemon_id = $1 
        AND status_type = $2 
        AND (expires_at IS NULL OR expires_at > NOW())
    `, [pokemonId, statusType]);
    
    return parseFloat(rows[0]?.total_bonus || 0);
  }
  
  /**
   * 判断异常状态是否生效
   */
  async shouldApplyStatus(pokemon, statusType, attackerLuck = 0) {
    const resistance = await this.calculateResistance(pokemon, statusType);
    
    if (resistance.isImmune) {
      return { apply: false, reason: 'immune', resistance };
    }
    
    // 基础命中率减去抗性值
    const baseHitChance = 1.00;
    const finalHitChance = baseHitChance - resistance.finalValue + attackerLuck;
    
    const roll = Math.random();
    const apply = roll < finalHitChance;
    
    return {
      apply,
      hitChance: finalHitChance,
      roll,
      resistance
    };
  }
  
  /**
   * 计算异常状态持续时间
   */
  async calculateStatusDuration(pokemon, statusType, baseTurns) {
    const resistance = await this.calculateResistance(pokemon, statusType);
    
    if (resistance.isImmune) {
      return 0;
    }
    
    // 抗性降低持续时间
    const reducedTurns = Math.ceil(baseTurns * (1.00 - resistance.finalValue));
    
    return Math.max(1, reducedTurns);
  }
  
  /**
   * 初始化种族异常状态抗性数据
   */
  async initializeSpeciesResistances() {
    // 钢系免疫中毒
    const steelImmunity = [
      { speciesType: 'steel', status: 'poison', value: 1.00 },
      { speciesType: 'steel', status: 'toxic', value: 1.00 }
    ];
    
    // 火系免疫灼伤
    const fireImmunity = [
      { speciesType: 'fire', status: 'burn', value: 1.00 }
    ];
    
    // 冰系免疫冻结
    const iceImmunity = [
      { speciesType: 'ice', status: 'freeze', value: 1.00 }
    ];
    
    // 电系免疫麻痹
    const electricImmunity = [
      { speciesType: 'electric', status: 'paralyze', value: 1.00 }
    ];
    
    // 地面系免疫雷电
    const groundImmunity = [
      { speciesType: 'ground', status: 'paralyze', value: 0.50 }
    ];
    
    // 批量插入
    const allImmunities = [
      ...steelImmunity, 
      ...fireImmunity, 
      ...iceImmunity, 
      ...electricImmunity,
      ...groundImmunity
    ];
    
    for (const immunity of allImmunities) {
      await query(`
        INSERT INTO pokemon_species_status_resistance (species_id, status_type, resistance_value)
        SELECT id, $1, $2
        FROM pokemon_species
        WHERE type1 = $3 OR type2 = $3
        ON CONFLICT (species_id, status_type) DO UPDATE 
        SET resistance_value = $2
      `, [immunity.status, immunity.value, immunity.speciesType]);
    }
    
    logger.info('Species status resistances initialized', { count: allImmunities.length });
  }
  
  /**
   * 初始化特性免疫数据
   */
  async initializeAbilityImmunities() {
    const abilityImmunities = [
      { abilityName: 'Immunity', status: 'poison', type: 'full' },
      { abilityName: 'Immunity', status: 'toxic', type: 'full' },
      { abilityName: 'Limber', status: 'paralyze', type: 'full' },
      { abilityName: 'Insomnia', status: 'sleep', type: 'full' },
      { abilityName: 'Vital Spirit', status: 'sleep', type: 'full' },
      { abilityName: 'Water Veil', status: 'burn', type: 'full' },
      { abilityName: 'Magma Armor', status: 'freeze', type: 'full' },
      { abilityName: 'Own Tempo', status: 'confusion', type: 'full' },
      { abilityName: 'Oblivious', status: 'attract', type: 'full' },
      { abilityName: 'Inner Focus', status: 'flinch', type: 'full' }
    ];
    
    for (const immunity of abilityImmunities) {
      await query(`
        INSERT INTO ability_status_immunity (ability_id, status_type, immunity_type)
        SELECT id, $1, $2
        FROM abilities
        WHERE name_en = $3
        ON CONFLICT (ability_id, status_type) DO UPDATE 
        SET immunity_type = $2
      `, [immunity.status, immunity.type, immunity.abilityName]);
    }
    
    logger.info('Ability status immunities initialized', { count: abilityImmunities.length });
  }
}

module.exports = new StatusResistanceEngine();
```

### 3. API 路由集成

```javascript
// backend/services/pokemon-service/src/routes/statusResistance.js
'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, successResp } = require('../../../shared/auth');
const statusResistanceEngine = require('../statusResistanceEngine');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('status-resistance-routes');

// 获取精灵异常状态抗性详情
router.get('/:pokemonId/resistance', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const { statusType } = req.query;
    
    // 获取精灵数据
    const { rows } = await query(`
      SELECT p.*, ps.type1, ps.type2
      FROM pokemon p
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE p.id = $1 AND p.user_id = $2
    `, [pokemonId, req.user.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }
    
    const pokemon = rows[0];
    
    if (statusType) {
      // 单一状态抗性
      const resistance = await statusResistanceEngine.calculateResistance(pokemon, statusType);
      return successResp(res, resistance);
    }
    
    // 所有状态抗性
    const statusTypes = ['poison', 'paralyze', 'burn', 'freeze', 'sleep', 'confusion', 'flinch', 'attract'];
    const resistances = {};
    
    for (const type of statusTypes) {
      resistances[type] = await statusResistanceEngine.calculateResistance(pokemon, type);
    }
    
    successResp(res, { pokemonId, resistances });
  } catch (err) {
    logger.error({ err, pokemonId: req.params.pokemonId }, 'Failed to get status resistance');
    next(err);
  }
});

// 预览异常状态效果（用于战斗预判）
router.post('/preview', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId, statusType, attackerLuck = 0, baseTurns = 3 } = req.body;
    
    const { rows } = await query(`
      SELECT p.*, ps.type1, ps.type2
      FROM pokemon p
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE p.id = $1
    `, [pokemonId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }
    
    const pokemon = rows[0];
    
    const [applyResult, duration] = await Promise.all([
      statusResistanceEngine.shouldApplyStatus(pokemon, statusType, attackerLuck),
      statusResistanceEngine.calculateStatusDuration(pokemon, statusType, baseTurns)
    ]);
    
    successResp(res, {
      pokemonId,
      statusType,
      canApply: applyResult.apply,
      hitChance: applyResult.hitChance,
      estimatedDuration: duration,
      resistance: applyResult.resistance
    });
  } catch (err) {
    logger.error({ err }, 'Failed to preview status effect');
    next(err);
  }
});

module.exports = router;
```

### 4. 战斗系统集成

```javascript
// backend/services/gym-service/src/battle/statusManager.js (扩展)
'use strict';

const statusResistanceEngine = require('../../../pokemon-service/src/statusResistanceEngine');

class BattleStatusManager {
  
  /**
   * 尝试施加异常状态
   */
  async attemptApplyStatus(targetPokemon, statusType, options = {}) {
    const { attackerLuck = 0, baseTurns = 3, source = 'move' } = options;
    
    // 判断是否命中
    const applyResult = await statusResistanceEngine.shouldApplyStatus(
      targetPokemon, 
      statusType, 
      attackerLuck
    );
    
    if (!applyResult.apply) {
      return {
        success: false,
        reason: applyResult.resistance.isImmune ? 'immune' : 'resisted',
        resistance: applyResult.resistance
      };
    }
    
    // 计算持续时间
    const duration = await statusResistanceEngine.calculateStatusDuration(
      targetPokemon, 
      statusType, 
      baseTurns
    );
    
    // 施加状态
    const appliedStatus = {
      statusType,
      remainingTurns: duration,
      source,
      appliedAt: Date.now()
    };
    
    return {
      success: true,
      status: appliedStatus,
      resistance: applyResult.resistance
    };
  }
  
  /**
   * 每回合处理异常状态
   */
  async processStatusTurn(pokemon) {
    const results = [];
    
    for (const status of pokemon.activeStatuses || []) {
      switch (status.statusType) {
        case 'poison':
        case 'toxic':
          // 中毒伤害
          const poisonDamage = this.calculatePoisonDamage(pokemon, status);
          results.push({
            type: 'damage',
            statusType: status.statusType,
            value: poisonDamage,
            message: `${pokemon.name} 受到中毒伤害`
          });
          break;
          
        case 'burn':
          // 灼伤伤害 + 攻击力下降
          const burnDamage = this.calculateBurnDamage(pokemon, status);
          results.push({
            type: 'damage',
            statusType: 'burn',
            value: burnDamage,
            message: `${pokemon.name} 受到灼伤伤害`
          });
          break;
          
        case 'paralyze':
          // 麻痹可能导致无法行动
          if (Math.random() < 0.25) {
            results.push({
              type: 'immobilize',
              statusType: 'paralyze',
              message: `${pokemon.name} 因麻痹无法行动`
            });
          }
          break;
          
        case 'freeze':
          // 冻结可能导致无法行动
          if (Math.random() < 0.80) {
            results.push({
              type: 'immobilize',
              statusType: 'freeze',
              message: `${pokemon.name} 处于冻结状态`
            });
          } else {
            // 有几率解冻
            status.remainingTurns = 0;
            results.push({
              type: 'cure',
              statusType: 'freeze',
              message: `${pokemon.name} 解冻了`
            });
          }
          break;
          
        case 'sleep':
          // 睡眠无法行动
          results.push({
            type: 'immobilize',
            statusType: 'sleep',
            message: `${pokemon.name} 正在睡眠`
          });
          break;
          
        case 'confusion':
          // 混乱可能导致自伤
          if (Math.random() < 0.33) {
            const confusionDamage = this.calculateConfusionDamage(pokemon);
            results.push({
              type: 'selfDamage',
              statusType: 'confusion',
              value: confusionDamage,
              message: `${pokemon.name} 在混乱中伤到了自己`
            });
          }
          break;
      }
      
      // 减少持续时间
      status.remainingTurns--;
    }
    
    // 移除已结束的状态
    pokemon.activeStatuses = pokemon.activeStatuses.filter(s => s.remainingTurns > 0);
    
    return results;
  }
  
  calculatePoisonDamage(pokemon, status) {
    const baseDamage = pokemon.maxHp * 0.0625; // 1/16 最大 HP
    return Math.floor(baseDamage);
  }
  
  calculateBurnDamage(pokemon, status) {
    const baseDamage = pokemon.maxHp * 0.0625;
    return Math.floor(baseDamage);
  }
  
  calculateConfusionDamage(pokemon) {
    // 40 威力的物理攻击
    return Math.floor((pokemon.level * 2 / 5 + 2) * 40 * pokemon.attack / pokemon.defense / 50 + 2);
  }
}

module.exports = new BattleStatusManager();
```

### 5. 客户端展示

```javascript
// frontend/game-client/src/components/StatusResistanceDisplay.js
import React from 'react';

const STATUS_CONFIG = {
  poison: { name: '中毒', icon: '☠️', color: '#A040A0' },
  paralyze: { name: '麻痹', icon: '⚡', color: '#F8D030' },
  burn: { name: '灼伤', icon: '🔥', color: '#F08030' },
  freeze: { name: '冻结', icon: '❄️', color: '#98D8D8' },
  sleep: { name: '睡眠', icon: '💤', color: '#A8A878' },
  confusion: { name: '混乱', icon: '💫', color: '#F85888' },
  flinch: { name: '畏缩', icon: '😰', color: '#A8A878' },
  attract: { name: '着迷', icon: '💕', color: '#FF69B4' }
};

export function StatusResistanceDisplay({ resistances }) {
  return (
    <div className="status-resistance-panel">
      <h3>异常状态抗性</h3>
      <div className="resistance-grid">
        {Object.entries(resistances).map(([type, resistance]) => {
          const config = STATUS_CONFIG[type];
          const percentage = Math.round(resistance.finalValue * 100);
          
          return (
            <div 
              key={type} 
              className={`resistance-item ${resistance.isImmune ? 'immune' : ''}`}
            >
              <div className="status-icon" style={{ color: config.color }}>
                {config.icon}
              </div>
              <div className="status-info">
                <span className="status-name">{config.name}</span>
                {resistance.isImmune ? (
                  <span className="immune-badge">免疫</span>
                ) : (
                  <div className="resistance-bar">
                    <div 
                      className="resistance-fill" 
                      style={{ width: `${percentage}%`, backgroundColor: config.color }}
                    />
                    <span className="resistance-value">{percentage}%</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      
      <button className="resistance-detail-btn">
        查看抗性详情
      </button>
    </div>
  );
}
```

### 6. 初始化脚本

```javascript
// backend/jobs/initStatusResistances.js
'use strict';

const statusResistanceEngine = require('../services/pokemon-service/src/statusResistanceEngine');
const { createLogger } = require('../shared/logger');

const logger = createLogger('init-status-resistances');

async function main() {
  logger.info('Starting status resistances initialization...');
  
  try {
    await statusResistanceEngine.initializeSpeciesResistances();
    await statusResistanceEngine.initializeAbilityImmunities();
    
    logger.info('Status resistances initialization completed');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Status resistances initialization failed');
    process.exit(1);
  }
}

main();
```

## 验收标准

- [ ] 数据库表 `pokemon_species_status_resistance`、`ability_status_immunity`、`status_effect_config`、`pokemon_status_resistance_bonus` 创建完成
- [ ] `StatusResistanceEngine` 类实现完整，包含抗性计算、叠加、免疫判断逻辑
- [ ] 种族抗性数据初始化完成（钢系免疫中毒、火系免疫灼伤等）
- [ ] 特性免疫数据初始化完成（免疫、柔软身体、失眠等特性）
- [ ] API `/pokemon/:pokemonId/resistance` 可查询精灵异常状态抗性详情
- [ ] API `/pokemon/status/preview` 可预览异常状态命中概率和持续时间
- [ ] 战斗系统集成异常状态抗性计算
- [ ] 异常状态施加时正确判断免疫和抗性
- [ ] 异常状态持续时间根据抗性正确减少
- [ ] 客户端展示精灵异常状态抗性界面
- [ ] 单元测试覆盖抗性计算逻辑
- [ ] 集成测试覆盖战斗中异常状态流程

## 影响范围

- **数据库迁移**：新增 4 张表
- **pokemon-service**：新增状态抗性计算引擎和路由
- **gym-service**：战斗系统集成异常状态抗性
- **game-client**：新增状态抗性展示组件
- **backend/jobs**：新增初始化脚本

## 参考

- [Pokémon Status Conditions](https://bulbapedia.bulbagarden.net/wiki/Status_condition)
- [Pokémon Abilities](https://bulbapedia.bulbagarden.net/wiki/Ability)
- [Type Immunities](https://bulbapedia.bulbagarden.net/wiki/Type)
