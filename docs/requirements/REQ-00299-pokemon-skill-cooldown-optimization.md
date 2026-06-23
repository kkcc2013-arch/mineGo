# REQ-00299: 精灵技能冷却时间智能优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00299 |
| 标题 | 精灵技能冷却时间智能优化系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gym-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-23 15:00 |

## 需求描述

### 背景
当前精灵技能冷却时间采用固定值设计，缺乏动态调整机制，导致：
1. **战斗节奏单一**：所有玩家使用相同节奏，缺乏策略深度
2. **技能价值不均衡**：高冷却技能在快节奏战斗中劣势明显
3. **玩家体验不佳**：冷却等待时间缺乏反馈，玩家焦虑感强
4. **成长感缺失**：技能熟练度无法体现，冷却时间成为死板限制

### 目标
构建智能化的技能冷却时间优化系统，实现：
- 技能熟练度影响冷却缩减（最多15%）
- 战斗节奏动态调整（连击加速机制）
- 冷却时间可视化与预测
- 特殊道具与装备冷却加成
- PVE/PVP 不同冷却策略

## 技术方案

### 1. 技能冷却核心架构

```javascript
// backend/shared/skillCooldownManager.js

class SkillCooldownManager {
  constructor() {
    this.baseCooldowns = new Map(); // 基础冷却时间表
    this.cooldownModifiers = new Map(); // 冷却修正器
    this.playerSkillMastery = new Map(); // 玩家技能熟练度
  }

  /**
   * 计算实际冷却时间
   * @param {string} pokemonId - 精灵ID
   * @param {string} skillId - 技能ID
   * @param {Object} context - 战斗上下文
   * @returns {number} 实际冷却时间（秒）
   */
  calculateActualCooldown(pokemonId, skillId, context) {
    const baseCooldown = this.getBaseCooldown(skillId);
    const masteryReduction = this.getMasteryReduction(pokemonId, skillId);
    const comboBonus = this.getComboBonus(context);
    const equipmentBonus = this.getEquipmentBonus(pokemonId, skillId);
    const battleMode = context.battleMode || 'pvp';
    
    const modifiers = {
      mastery: 1 - masteryReduction, // 熟练度缩减（0.85-1.0）
      combo: 1 - comboBonus, // 连击加速（0.9-1.0）
      equipment: 1 - equipmentBonus, // 装备加成（0.8-1.0）
      mode: battleMode === 'pve' ? 0.85 : 1.0 // PVE模式冷却缩短15%
    };
    
    const actualCooldown = baseCooldown * 
      modifiers.mastery * 
      modifiers.combo * 
      modifiers.equipment * 
      modifiers.mode;
    
    // 冷却时间下限保护（不低于基础冷却的40%）
    return Math.max(actualCooldown, baseCooldown * 0.4);
  }

  /**
   * 获取基础冷却时间
   */
  getBaseCooldown(skillId) {
    return this.baseCooldowns.get(skillId) || 10; // 默认10秒
  }

  /**
   * 获取熟练度冷却缩减
   */
  getMasteryReduction(pokemonId, skillId) {
    const mastery = this.playerSkillMastery.get(`${pokemonId}:${skillId}`) || 0;
    // 熟练度0-100，每10点减少1.5%冷却，最多15%
    return Math.min(mastery / 10 * 0.015, 0.15);
  }

  /**
   * 获取连击加速加成
   */
  getComboBonus(context) {
    const comboCount = context.comboCount || 0;
    // 连击3次以上，每次额外连击减少2%冷却（最多10%）
    if (comboCount < 3) return 0;
    return Math.min((comboCount - 2) * 0.02, 0.10);
  }

  /**
   * 获取装备冷却加成
   */
  getEquipmentBonus(pokemonId, skillId) {
    const equipment = this.cooldownModifiers.get(pokemonId);
    if (!equipment) return 0;
    
    // 特定装备减少冷却
    return equipment.skillCooldownReduction || 0;
  }

  /**
   * 更新技能熟练度
   */
  async updateSkillMastery(pokemonId, skillId, usageCount = 1) {
    const key = `${pokemonId}:${skillId}`;
    const currentMastery = this.playerSkillMastery.get(key) || 0;
    
    // 熟练度增长曲线：初期快，后期慢
    const increment = Math.max(1, Math.floor(10 / (currentMastery / 10 + 1)));
    const newMastery = Math.min(currentMastery + increment, 100);
    
    this.playerSkillMastery.set(key, newMastery);
    
    // 持久化到数据库
    await this.persistMastery(pokemonId, skillId, newMastery);
    
    return newMastery;
  }

  /**
   * 持久化熟练度数据
   */
  async persistMastery(pokemonId, skillId, mastery) {
    // 实现数据库存储
  }
}

module.exports = { SkillCooldownManager };
```

### 2. 技能熟练度系统

```javascript
// backend/services/pokemon-service/src/models/SkillMastery.js

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SkillMastery = sequelize.define('SkillMastery', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    pokemonId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'pokemon_id',
      references: {
        model: 'pokemons',
        key: 'id'
      }
    },
    skillId: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'skill_id'
    },
    masteryLevel: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'mastery_level',
      validate: {
        min: 0,
        max: 100
      }
    },
    usageCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'usage_count'
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      field: 'last_used_at'
    },
    cooldownReduction: {
      type: DataTypes.DECIMAL(5, 4),
      allowNull: false,
      defaultValue: 0.0000,
      field: 'cooldown_reduction',
      comment: '冷却缩减比例，最大0.15'
    }
  }, {
    tableName: 'skill_masteries',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['pokemon_id', 'skill_id']
      },
      {
        fields: ['mastery_level']
      }
    ]
  });

  return SkillMastery;
};
```

### 3. 冷却时间可视化系统

```javascript
// frontend/game-client/src/components/SkillCooldownDisplay.js

class SkillCooldownDisplay {
  constructor() {
    this.animations = new Map();
    this.predictions = new Map();
  }

  /**
   * 渲染冷却时间显示
   */
  renderCooldown(skillSlot, cooldownInfo) {
    const { actualCooldown, remainingTime, progress } = cooldownInfo;
    
    // 主冷却进度条
    const progressBar = this.createProgressBar(progress, {
      width: 100,
      height: 8,
      backgroundColor: '#333',
      fillColor: this.getCooldownColor(progress),
      animation: 'slide'
    });
    
    // 时间显示
    const timeText = remainingTime > 0 
      ? `${remainingTime.toFixed(1)}s` 
      : 'READY';
    
    // 冷却缩减提示
    const reduction = actualCooldown.base - actualCooldown.current;
    const reductionText = reduction > 0 
      ? `(-${(reduction / actualCooldown.base * 100).toFixed(1)}%)` 
      : '';
    
    return {
      progressBar,
      timeText,
      reductionText,
      isReady: remainingTime <= 0
    }
  }

  /**
   * 预测冷却完成时间
   */
  predictCooldownComplete(skillId, context) {
    const baseCooldown = this.getBaseCooldown(skillId);
    const modifiers = this.calculateModifiers(context);
    const estimatedCooldown = baseCooldown * modifiers.total;
    
    // 考虑连击加速预测
    if (context.comboCount >= 2) {
      const nextComboReduction = 0.02;
      estimatedCooldown *= (1 - nextComboReduction);
    }
    
    return {
      estimatedCooldown,
      confidence: this.calculateConfidence(context),
      recommendations: this.generateRecommendations(context)
    }
  }

  /**
   * 冷却颜色编码
   */
  getCooldownColor(progress) {
    if (progress >= 1) return '#4CAF50'; // 就绪 - 绿色
    if (progress >= 0.5) return '#FFC107'; // 进行中 - 黄色
    return '#F44336'; // 冷却中 - 红色
  }

  /**
   * 生成冷却建议
   */
  generateRecommendations(context) {
    const recommendations = [];
    
    // 连击建议
    if (context.comboCount < 3) {
      recommendations.push({
        type: 'combo',
        message: '继续连击可获得冷却加速',
        bonus: '+2% 冷却缩减/次'
      });
    }
    
    // 装备建议
    if (!context.hasCooldownEquipment) {
      recommendations.push({
        type: 'equipment',
        message: '装备「时间晶石」可减少冷却时间',
        bonus: '-10% 冷却时间'
      });
    }
    
    // 熟练度建议
    const mastery = context.skillMastery || 0;
    if (mastery < 50) {
      recommendations.push({
        type: 'mastery',
        message: `熟练度 ${mastery}/100，继续使用可减少冷却`,
        bonus: `-${Math.floor(mastery / 10 * 1.5)}% 冷却时间`
      });
    }
    
    return recommendations;
  }
}

module.exports = { SkillCooldownDisplay };
```

### 4. 冷却道具与装备系统

```javascript
// backend/services/pokemon-service/src/models/CooldownEquipment.js

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const CooldownEquipment = sequelize.define('CooldownEquipment', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('gem', 'rune', 'artifact'),
      allowNull: false
    },
    rarity: {
      type: DataTypes.ENUM('common', 'rare', 'epic', 'legendary'),
      allowNull: false,
      defaultValue: 'common'
    },
    // 冷却缩减效果
    cooldownReduction: {
      type: DataTypes.DECIMAL(5, 4),
      allowNull: false,
      defaultValue: 0.0000,
      field: 'cooldown_reduction',
      comment: '全局冷却缩减（0-0.2）'
    },
    // 特定技能类型加成
    skillTypeBonus: {
      type: DataTypes.JSONB,
      field: 'skill_type_bonus',
      defaultValue: {},
      comment: '特定技能类型额外缩减 {fire: 0.1, water: 0.05}'
    },
    // 连击加成倍率
    comboMultiplier: {
      type: DataTypes.DECIMAL(4, 3),
      field: 'combo_multiplier',
      defaultValue: 1.0,
      comment: '连击加速效果倍率'
    },
    // 套装效果
    setBonus: {
      type: DataTypes.JSONB,
      field: 'set_bonus',
      defaultValue: null,
      comment: '套装效果 {setName: "TimeWeaver", pieces: 2, bonus: 0.05}'
    },
    // 持续时间（消耗品）
    duration: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '效果持续时间（秒），null表示永久'
    }
  }, {
    tableName: 'cooldown_equipments',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return CooldownEquipment;
};
```

### 5. PVE/PVP 冷却策略

```javascript
// backend/shared/battleCooldownStrategy.js

class BattleCooldownStrategy {
  constructor() {
    this.strategies = {
      pvp: this.getPPVStrategy(),
      pve: this.getPVEStrategy(),
      raid: this.getRaidStrategy(),
      tournament: this.getTournamentStrategy()
    };
  }

  /**
   * PVP 模式策略
   */
  getPVPStrategy() {
    return {
      baseMultiplier: 1.0, // 标准冷却
      comboEnabled: true, // 连击加速
      masteryEnabled: true, // 熟练度生效
      equipmentEnabled: true, // 装备生效
      maxReduction: 0.40, // 最多减少40%
      specialRules: [
        { skill: 'ultimate', minCooldown: 30 }, // 大招最低30秒
        { skill: 'heal', maxReduction: 0.25 } // 治疗最多减少25%
      ]
    };
  }

  /**
   * PVE 模式策略
   */
  getPVEStrategy() {
    return {
      baseMultiplier: 0.85, // 冷却缩短15%
      comboEnabled: true,
      masteryEnabled: true,
      equipmentEnabled: true,
      maxReduction: 0.50, // 最多减少50%
      specialRules: [
        { skill: 'aoe', minCooldown: 8 }, // AOE技能最低8秒
        { skill: 'buff', cooldownReduction: 0.20 } // 增益技能额外减少20%
      ]
    };
  }

  /**
   * 团队副本策略
   */
  getRaidStrategy() {
    return {
      baseMultiplier: 0.90,
      comboEnabled: false, // 禁用连击加速
      masteryEnabled: true,
      equipmentEnabled: true,
      maxReduction: 0.35,
      teamBonus: 0.05, // 团队协作加成5%
      specialRules: [
        { skill: 'resurrection', cooldown: 180 }, // 复活固定180秒
        { skill: 'shield', teamShare: true } // 护盾共享冷却
      ]
    };
  }

  /**
   * 锦标赛模式策略
   */
  getTournamentStrategy() {
    return {
      baseMultiplier: 1.0, // 公平竞技
      comboEnabled: false, // 禁用连击加速
      masteryEnabled: false, // 禁用熟练度
      equipmentEnabled: false, // 禁用装备加成
      maxReduction: 0, // 无缩减
      specialRules: [
        { all: 'standard' } // 所有技能使用标准冷却
      ]
    };
  }

  /**
   * 应用战斗模式策略
   */
  applyStrategy(skillId, baseCooldown, battleMode, context) {
    const strategy = this.strategies[battleMode] || this.strategies.pvp;
    
    let adjustedCooldown = baseCooldown * strategy.baseMultiplier;
    
    // 应用各种加成
    if (strategy.masteryEnabled) {
      adjustedCooldown *= (1 - context.masteryReduction || 0);
    }
    
    if (strategy.comboEnabled && context.comboCount > 2) {
      adjustedCooldown *= (1 - Math.min((context.comboCount - 2) * 0.02, 0.10));
    }
    
    if (strategy.equipmentEnabled) {
      adjustedCooldown *= (1 - context.equipmentReduction || 0);
    }
    
    // 应用特殊规则
    const specialRule = strategy.specialRules.find(r => r.skill === skillId);
    if (specialRule) {
      if (specialRule.minCooldown) {
        adjustedCooldown = Math.max(adjustedCooldown, specialRule.minCooldown);
      }
      if (specialRule.maxReduction) {
        adjustedCooldown = Math.max(baseCooldown * (1 - specialRule.maxReduction), adjustedCooldown);
      }
      if (specialRule.cooldown) {
        adjustedCooldown = specialRule.cooldown;
      }
    }
    
    // 应用最大缩减限制
    const maxReductionCooldown = baseCooldown * (1 - strategy.maxReduction);
    adjustedCooldown = Math.max(adjustedCooldown, maxReductionCooldown);
    
    return adjustedCooldown;
  }
}

module.exports = { BattleCooldownStrategy };
```

### 6. 数据库迁移脚本

```javascript
// database/migrations/20260623150000_create_skill_mastery_and_cooldown_tables.js

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 创建技能熟练度表
    await queryInterface.createTable('skill_masteries', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      pokemon_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'pokemons',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      skill_id: {
        type: Sequelize.STRING(50),
        allowNull: false
      },
      mastery_level: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      usage_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      last_used_at: {
        type: Sequelize.DATE
      },
      cooldown_reduction: {
        type: Sequelize.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0.0000
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // 创建唯一索引
    await queryInterface.addIndex('skill_masteries', ['pokemon_id', 'skill_id'], {
      unique: true,
      name: 'skill_masteries_pokemon_skill_idx'
    });

    // 创建冷却装备表
    await queryInterface.createTable('cooldown_equipments', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false
      },
      type: {
        type: Sequelize.ENUM('gem', 'rune', 'artifact'),
        allowNull: false
      },
      rarity: {
        type: Sequelize.ENUM('common', 'rare', 'epic', 'legendary'),
        allowNull: false,
        defaultValue: 'common'
      },
      cooldown_reduction: {
        type: Sequelize.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0.0000
      },
      skill_type_bonus: {
        type: Sequelize.JSONB,
        defaultValue: {}
      },
      combo_multiplier: {
        type: Sequelize.DECIMAL(4, 3),
        defaultValue: 1.0
      },
      set_bonus: {
        type: Sequelize.JSONB,
        defaultValue: null
      },
      duration: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // 插入初始冷却装备数据
    await queryInterface.bulkInsert('cooldown_equipments', [
      {
        id: Sequelize.UUIDV4(),
        name: '时间晶石',
        type: 'gem',
        rarity: 'rare',
        cooldown_reduction: 0.10,
        skill_type_bonus: JSON.stringify({}),
        combo_multiplier: 1.0,
        set_bonus: null,
        duration: null,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        id: Sequelize.UUIDV4(),
        name: '时间编织者符文',
        type: 'rune',
        rarity: 'epic',
        cooldown_reduction: 0.08,
        skill_type_bonus: JSON.stringify({ fire: 0.05, ice: 0.05 }),
        combo_multiplier: 1.2,
        set_bonus: JSON.stringify({ setName: 'TimeWeaver', pieces: 2, bonus: 0.05 }),
        duration: null,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        id: Sequelize.UUIDV4(),
        name: '永恒沙漏',
        type: 'artifact',
        rarity: 'legendary',
        cooldown_reduction: 0.15,
        skill_type_bonus: JSON.stringify({ ultimate: 0.10 }),
        combo_multiplier: 1.5,
        set_bonus: JSON.stringify({ setName: 'EternalChronicle', pieces: 3, bonus: 0.08 }),
        duration: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('cooldown_equipments');
    await queryInterface.dropTable('skill_masteries');
  }
};
```

### 7. API 接口设计

```yaml
# docs/api-spec/skill-cooldown.yaml

paths:
  /pokemon/{pokemonId}/skills/{skillId}/cooldown:
    get:
      summary: 获取技能冷却信息
      tags: [Skill Cooldown]
      parameters:
        - name: pokemonId
          in: path
          required: true
          schema:
            type: string
            format: uuid
        - name: skillId
          in: path
          required: true
          schema:
            type: string
        - name: battleMode
          in: query
          schema:
            type: string
            enum: [pvp, pve, raid, tournament]
            default: pvp
      responses:
        200:
          description: 技能冷却信息
          content:
            application/json:
              schema:
                type: object
                properties:
                  baseCooldown:
                    type: number
                    description: 基础冷却时间（秒）
                  actualCooldown:
                    type: number
                    description: 实际冷却时间（秒）
                  remainingTime:
                    type: number
                    description: 剩余冷却时间（秒）
                  reduction:
                    type: object
                    properties:
                      mastery:
                        type: number
                        description: 熟练度缩减
                      combo:
                        type: number
                        description: 连击缩减
                      equipment:
                        type: number
                        description: 装备缩减
                  prediction:
                    type: object
                    properties:
                      estimatedReadyAt:
                        type: string
                        format: date-time
                      confidence:
                        type: number
                      recommendations:
                        type: array
                        items:
                          type: object
                          properties:
                            type:
                              type: string
                            message:
                              type: string
                            bonus:
                              type: string

  /pokemon/{pokemonId}/skills/{skillId}/mastery:
    get:
      summary: 获取技能熟练度信息
      tags: [Skill Cooldown]
      parameters:
        - name: pokemonId
          in: path
          required: true
          schema:
            type: string
            format: uuid
        - name: skillId
          in: path
          required: true
          schema:
            type: string
      responses:
        200:
          description: 技能熟练度信息
          content:
            application/json:
              schema:
                type: object
                properties:
                  skillId:
                    type: string
                  masteryLevel:
                    type: integer
                    minimum: 0
                    maximum: 100
                  usageCount:
                    type: integer
                  cooldownReduction:
                    type: number
                  nextMilestone:
                    type: object
                    properties:
                      level:
                        type: integer
                      bonus:
                        type: number
                      remainingUsage:
                        type: integer

  /cooldown/equipments:
    get:
      summary: 获取冷却装备列表
      tags: [Skill Cooldown]
      parameters:
        - name: rarity
          in: query
          schema:
            type: string
            enum: [common, rare, epic, legendary]
        - name: type
          in: query
          schema:
            type: string
            enum: [gem, rune, artifact]
      responses:
        200:
          description: 冷却装备列表
          content:
            application/json:
              schema:
                type: object
                properties:
                  equipments:
                    type: array
                    items:
                      $ref: '#/components/schemas/CooldownEquipment'
                  total:
                    type: integer

components:
  schemas:
    CooldownEquipment:
      type: object
      properties:
        id:
          type: string
          format: uuid
        name:
          type: string
        type:
          type: string
          enum: [gem, rune, artifact]
        rarity:
          type: string
          enum: [common, rare, epic, legendary]
        cooldownReduction:
          type: number
        skillTypeBonus:
          type: object
        comboMultiplier:
          type: number
        setBonus:
          type: object
```

### 8. 单元测试

```javascript
// backend/tests/unit/skillCooldownManager.test.js

const { SkillCooldownManager } = require('../../shared/skillCooldownManager');

describe('SkillCooldownManager', () => {
  let manager;

  beforeEach(() => {
    manager = new SkillCooldownManager();
  });

  describe('calculateActualCooldown', () => {
    it('should calculate base cooldown without modifiers', () => {
      const result = manager.calculateActualCooldown('pokemon1', 'fireball', {
        battleMode: 'pvp'
      });
      
      expect(result).toBe(10); // 默认基础冷却
    });

    it('should apply mastery reduction', () => {
      manager.playerSkillMastery.set('pokemon1:fireball', 50);
      
      const result = manager.calculateActualCooldown('pokemon1', 'fireball', {
        battleMode: 'pvp'
      });
      
      // 熟练度50 = 7.5%缩减
      expect(result).toBeLessThan(10);
      expect(result).toBeCloseTo(9.25, 1);
    });

    it('should apply combo bonus', () => {
      const result = manager.calculateActualCooldown('pokemon1', 'fireball', {
        battleMode: 'pvp',
        comboCount: 5
      });
      
      // 连击5次 = 6%缩减（3次以上每次2%）
      expect(result).toBeLessThan(10);
      expect(result).toBeCloseTo(9.4, 1);
    });

    it('should apply PVE mode reduction', () => {
      const result = manager.calculateActualCooldown('pokemon1', 'fireball', {
        battleMode: 'pve'
      });
      
      // PVE模式减少15%
      expect(result).toBeCloseTo(8.5, 1);
    });

    it('should enforce minimum cooldown (40% of base)', () => {
      manager.playerSkillMastery.set('pokemon1:fireball', 100);
      manager.cooldownModifiers.set('pokemon1', {
        skillCooldownReduction: 0.30
      });
      
      const result = manager.calculateActualCooldown('pokemon1', 'fireball', {
        battleMode: 'pve',
        comboCount: 10
      });
      
      // 各种加成可能使冷却低于40%，但应限制在40%
      expect(result).toBeGreaterThanOrEqual(10 * 0.4);
    });
  });

  describe('updateSkillMastery', () => {
    it('should increase mastery level', async () => {
      const newMastery = await manager.updateSkillMastery('pokemon1', 'fireball');
      
      expect(newMastery).toBe(1);
    });

    it('should use diminishing returns for high mastery', async () => {
      manager.playerSkillMastery.set('pokemon1:fireball', 80);
      
      const newMastery = await manager.updateSkillMastery('pokemon1', 'fireball');
      
      // 高熟练度时增长减慢
      expect(newMastery).toBeLessThanOrEqual(81);
    });

    it('should cap at 100', async () => {
      manager.playerSkillMastery.set('pokemon1:fireball', 99);
      
      const newMastery = await manager.updateSkillMastery('pokemon1', 'fireball');
      
      expect(newMastery).toBe(100);
    });
  });
});
```

## 验收标准

- [ ] 技能熟练度系统实现，熟练度0-100对应0-15%冷却缩减
- [ ] 连击加速机制实现，3次连击后每次减少2%冷却（最多10%）
- [ ] 冷却装备系统实现，支持宝石/符文/神器三种类型
- [ ] PVE/PVP/团本/锦标赛四种战斗模式冷却策略实现
- [ ] 冷却时间可视化界面实现，显示进度条和剩余时间
- [ ] 冷却预测系统实现，提供建议和优化提示
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] API 接口文档完整
- [ ] 性能测试：冷却计算响应时间 < 50ms
- [ ] 数据库迁移脚本可执行

## 影响范围

- **新增文件**:
  - `backend/shared/skillCooldownManager.js`
  - `backend/shared/battleCooldownStrategy.js`
  - `backend/services/pokemon-service/src/models/SkillMastery.js`
  - `backend/services/pokemon-service/src/models/CooldownEquipment.js`
  - `frontend/game-client/src/components/SkillCooldownDisplay.js`
  - `database/migrations/20260623150000_create_skill_mastery_and_cooldown_tables.js`
  - `docs/api-spec/skill-cooldown.yaml`
  - `backend/tests/unit/skillCooldownManager.test.js`

- **修改文件**:
  - `backend/services/pokemon-service/src/routes/pokemon.js` (新增冷却相关路由)
  - `backend/services/gym-service/src/controllers/battleController.js` (集成冷却计算)
  - `frontend/game-client/src/game/BattleEngine.js` (冷却显示集成)
  - `frontend/game-client/src/game/SkillManager.js` (熟练度更新)

## 参考

- [游戏技能冷却设计最佳实践](https://game-design.org/skill-cooldown)
- [ICU MessageFormat 规范](https://unicode-org.github.io/icu/userguide/format_parse/messages/)
- [WCAG 2.1 可访问性指南](https://www.w3.org/TR/WCAG21/)
- [PostgreSQL 性能优化指南](https://www.postgresql.org/docs/current/performance-tips.html)
