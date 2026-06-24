# REQ-00311: 精灵技能冷却智能加速与连击链系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00311 |
| 标题 | 精灵技能冷却智能加速与连击链系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gym-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-24 05:00 UTC |

## 需求描述

精灵技能冷却智能加速与连击链系统是精灵战斗体验的核心增强功能。该系统实现了技能冷却的动态调整机制，基于精灵属性、战斗状态和环境因素智能计算冷却加速比例，并支持多技能连击链组合释放，提升战斗策略深度和游戏可玩性。

### 核心功能

1. **技能冷却智能加速**
   - 基于精灵速度属性的冷却加速计算
   - 战斗连击触发冷却缩减
   - 特定装备/道具的冷却加成
   - 环境天气对冷却的影响

2. **连击链系统**
   - 预设连击链组合配置
   - 连击链触发条件检测
   - 连击链伤害倍率计算
   - 连击链动画串联播放

3. **连击链解锁与升级**
   - 精灵羁绊等级解锁连击链槽位
   - 连击链熟练度提升伤害加成
   - 特殊精灵独有连击链

## 技术方案

### 1. 技能冷却智能加速模块

```javascript
// backend/pokemon-service/src/skillCooldownAccelerator.js

const { Pokemon, Skill, BattleState } = require('./models');
const { EventBus } = require('../../shared/eventBus');

class SkillCooldownAccelerator {
  constructor() {
    this.baseCooldownReduction = 0; // 基础冷却缩减
    this.maxCooldownReduction = 0.5; // 最大冷却缩减 50%
    this.speedScalingFactor = 0.002; // 速度属性缩放因子
  }

  /**
   * 计算技能冷却时间
   * @param {string} pokemonId - 精灵ID
   * @param {string} skillId - 技能ID
   * @param {object} battleContext - 战斗上下文
   * @returns {number} 实际冷却时间（秒）
   */
  async calculateCooldown(pokemonId, skillId, battleContext = {}) {
    const pokemon = await Pokemon.findById(pokemonId).populate('skills');
    const skill = await Skill.findById(skillId);
    
    if (!pokemon || !skill) {
      throw new Error('Pokemon or skill not found');
    }

    // 基础冷却时间
    let cooldown = skill.baseCooldown;

    // 1. 速度属性加成
    const speedBonus = this.calculateSpeedBonus(pokemon.stats.speed);
    cooldown *= (1 - speedBonus);

    // 2. 装备加成
    const equipmentBonus = await this.calculateEquipmentBonus(pokemonId, skillId);
    cooldown *= (1 - equipmentBonus);

    // 3. 天气环境加成
    const weatherBonus = this.calculateWeatherBonus(skill, battleContext.weather);
    cooldown *= (1 - weatherBonus);

    // 4. 连击链加成
    if (battleContext.chainCount > 0) {
      const chainBonus = Math.min(battleContext.chainCount * 0.05, 0.2);
      cooldown *= (1 - chainBonus);
    }

    // 5. 精灵特性加成
    const traitBonus = this.calculateTraitBonus(pokemon, skill);
    cooldown *= (1 - traitBonus);

    // 确保冷却时间不低于最小值
    const minCooldown = skill.baseCooldown * (1 - this.maxCooldownReduction);
    cooldown = Math.max(cooldown, minCooldown);

    return Math.round(cooldown * 100) / 100;
  }

  /**
   * 计算速度属性冷却加成
   */
  calculateSpeedBonus(speed) {
    // 每 10 点速度减少 2% 冷却时间
    return Math.min(speed * this.speedScalingFactor, 0.3);
  }

  /**
   * 计算装备冷却加成
   */
  async calculateEquipmentBonus(pokemonId, skillId) {
    const equipment = await Equipment.find({ pokemonId, type: 'cooldown' });
    let totalBonus = 0;
    
    for (const item of equipment) {
      if (item.targetSkills.includes(skillId) || item.targetSkills.includes('*')) {
        totalBonus += item.cooldownReduction;
      }
    }
    
    return Math.min(totalBonus, 0.3);
  }

  /**
   * 计算天气冷却加成
   */
  calculateWeatherBonus(skill, weather) {
    const weatherEffects = {
      rain: { water: 0.1, fire: -0.1 },
      sunny: { fire: 0.15, water: -0.05 },
      sandstorm: { rock: 0.1, ground: 0.1 },
      hail: { ice: 0.1 }
    };

    if (!weather || !weatherEffects[weather]) return 0;
    
    const skillType = skill.type.toLowerCase();
    return weatherEffects[weather][skillType] || 0;
  }

  /**
   * 计算精灵特性冷却加成
   */
  calculateTraitBonus(pokemon, skill) {
    const traitEffects = {
      'haste': 0.15,
      'quick_draw': 0.1,
      'pressure': 0.05,
      'rhythm': 0.08
    };

    if (!pokemon.traits || pokemon.traits.length === 0) return 0;

    let totalBonus = 0;
    for (const trait of pokemon.traits) {
      if (traitEffects[trait.name]) {
        totalBonus += traitEffects[trait.name];
      }
    }

    return Math.min(totalBonus, 0.25);
  }
}

module.exports = SkillCooldownAccelerator;
```

### 2. 连击链系统模块

```javascript
// backend/pokemon-service/src/comboChainSystem.js

const { ComboChain, ComboExecution, Pokemon } = require('./models');
const { EventBus } = require('../../shared/eventBus');
const mongoose = require('mongoose');

class ComboChainSystem {
  constructor() {
    this.chainConfigs = new Map();
    this.activeChains = new Map();
    this.eventBus = EventBus;
  }

  /**
   * 加载精灵可用的连击链配置
   */
  async loadComboChains(pokemonId) {
    const pokemon = await Pokemon.findById(pokemonId)
      .populate('species')
      .populate('skills');
    
    if (!pokemon) return [];

    // 查找该精灵可用的连击链
    const chains = await ComboChain.find({
      $or: [
        { species: pokemon.species._id },
        { species: { $exists: false } }, // 通用连击链
      ],
      unlockLevel: { $lte: pokemon.level },
    });

    // 过滤已解锁的连击链
    const unlockedChains = chains.filter(chain => {
      return this.checkUnlockConditions(pokemon, chain);
    });

    // 缓存到内存
    this.chainConfigs.set(pokemonId, unlockedChains);
    
    return unlockedChains;
  }

  /**
   * 检查连击链解锁条件
   */
  checkUnlockConditions(pokemon, chain) {
    // 检查羁绊等级
    if (chain.bondLevel && pokemon.bondLevel < chain.bondLevel) {
      return false;
    }

    // 检查技能是否已学习
    const requiredSkills = chain.requiredSkills || [];
    const pokemonSkillIds = pokemon.skills.map(s => s._id.toString());
    
    for (const skillId of requiredSkills) {
      if (!pokemonSkillIds.includes(skillId.toString())) {
        return false;
      }
    }

    // 检查熟练度
    if (chain.proficiencyRequired) {
      const proficiency = pokemon.comboProficiency?.get(chain._id.toString()) || 0;
      if (proficiency < chain.proficiencyRequired) {
        return false;
      }
    }

    return true;
  }

  /**
   * 尝试触发连击链
   */
  async tryTriggerComboChain(pokemonId, skillId, battleContext) {
    const chains = this.chainConfigs.get(pokemonId) || await this.loadComboChains(pokemonId);
    const triggeredChains = [];

    for (const chain of chains) {
      const triggerResult = this.checkTriggerCondition(chain, skillId, battleContext);
      
      if (triggerResult.canTrigger) {
        triggeredChains.push({
          chain,
          priority: chain.priority,
          damageMultiplier: chain.damageMultiplier,
          nextSkills: chain.sequence.slice(1), // 后续技能列表
        });
      }
    }

    // 按优先级排序
    triggeredChains.sort((a, b) => b.priority - a.priority);

    if (triggeredChains.length > 0) {
      // 触发连击链开始事件
      await this.eventBus.emit('combo.chain.triggered', {
        pokemonId,
        chain: triggeredChains[0].chain,
        battleContext,
        timestamp: Date.now(),
      });
    }

    return triggeredChains[0] || null;
  }

  /**
   * 检查连击链触发条件
   */
  checkTriggerCondition(chain, skillId, battleContext) {
    const sequence = chain.sequence;
    
    if (!sequence || sequence.length === 0) {
      return { canTrigger: false, reason: 'Empty sequence' };
    }

    // 检查是否是起始技能
    if (sequence[0].toString() !== skillId.toString()) {
      return { canTrigger: false, reason: 'Not starting skill' };
    }

    // 检查冷却状态
    if (chain.cooldownRemaining > 0) {
      return { canTrigger: false, reason: 'Chain on cooldown' };
    }

    // 检查特殊条件
    if (chain.conditions) {
      for (const condition of chain.conditions) {
        if (!this.evaluateCondition(condition, battleContext)) {
          return { canTrigger: false, reason: `Condition not met: ${condition.type}` };
        }
      }
    }

    return { canTrigger: true };
  }

  /**
   * 执行连击链序列
   */
  async executeComboChain(pokemonId, chainId, battleContext) {
    const chain = await ComboChain.findById(chainId);
    if (!chain) {
      throw new Error('Combo chain not found');
    }

    const execution = {
      chainId,
      pokemonId,
      startTime: Date.now(),
      currentStep: 0,
      totalSteps: chain.sequence.length,
      results: [],
      totalDamage: 0,
    };

    // 执行每一步连击
    for (let i = 0; i < chain.sequence.length; i++) {
      const skillId = chain.sequence[i];
      const stepBonus = this.calculateStepBonus(i, chain);
      
      execution.results.push({
        step: i,
        skillId,
        bonus: stepBonus,
      });

      // 发布连击步事件
      await this.eventBus.emit('combo.chain.step', {
        pokemonId,
        chainId,
        step: i,
        skillId,
        bonus: stepBonus,
        battleContext,
      });
    }

    // 计算总伤害加成
    execution.totalDamage = this.calculateTotalDamageMultiplier(chain, execution);

    // 更新熟练度
    await this.updateProficiency(pokemonId, chainId);

    // 设置冷却
    chain.cooldownRemaining = chain.cooldown || 0;

    return execution;
  }

  /**
   * 计算连击步加成
   */
  calculateStepBonus(stepIndex, chain) {
    // 每一步增加 10% 伤害
    const baseBonus = 0.1 * stepIndex;
    
    // 完美时机窗口加成（如果玩家在正确时机按下）
    const timingBonus = chain.timingWindow ? 0.05 : 0;

    return baseBonus + timingBonus;
  }

  /**
   * 计算总伤害倍率
   */
  calculateTotalDamageMultiplier(chain, execution) {
    const baseMultiplier = chain.damageMultiplier || 1.0;
    const chainBonus = execution.results.reduce((sum, r) => sum + r.bonus, 0);
    
    return baseMultiplier * (1 + chainBonus);
  }

  /**
   * 更新连击熟练度
   */
  async updateProficiency(pokemonId, chainId) {
    const pokemon = await Pokemon.findById(pokemonId);
    
    if (!pokemon.comboProficiency) {
      pokemon.comboProficiency = new Map();
    }

    const currentProficiency = pokemon.comboProficiency.get(chainId.toString()) || 0;
    pokemon.comboProficiency.set(chainId.toString(), currentProficiency + 1);

    await pokemon.save();
  }

  /**
   * 获取连击链推荐
   */
  async getComboRecommendations(pokemonId, currentSkills) {
    const chains = await this.loadComboChains(pokemonId);
    const recommendations = [];

    for (const chain of chains) {
      const matchScore = this.calculateMatchScore(chain, currentSkills);
      
      if (matchScore > 0) {
        recommendations.push({
          chain,
          matchScore,
          missingSkills: this.getMissingSkills(chain, currentSkills),
          potentialDamage: chain.damageMultiplier * (1 + chain.sequence.length * 0.1),
        });
      }
    }

    return recommendations.sort((a, b) => b.matchScore - a.matchScore);
  }
}

module.exports = ComboChainSystem;
```

### 3. 数据库模型

```javascript
// backend/pokemon-service/models/ComboChain.js

const mongoose = require('mongoose');

const ComboChainSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  
  // 适用范围
  species: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Species' }], // null 表示通用
  unlockLevel: { type: Number, default: 1 },
  bondLevel: { type: Number, default: 0 }, // 解锁所需羁绊等级
  
  // 连击序列
  sequence: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Skill',
    required: true,
  }],
  
  // 触发条件
  conditions: [{
    type: { type: String, enum: ['hp_below', 'enemy_status', 'weather', 'turn_count', 'combo_count'] },
    value: mongoose.Schema.Types.Mixed,
  }],
  
  // 效果
  damageMultiplier: { type: Number, default: 1.0 },
  effects: [{
    type: { type: String },
    duration: { type: Number },
    value: { type: Number },
  }],
  
  // 冷却
  cooldown: { type: Number, default: 0 }, // 连击链冷却时间（秒）
  cooldownRemaining: { type: Number, default: 0 },
  
  // 优先级
  priority: { type: Number, default: 0 },
  
  // 熟练度
  proficiencyRequired: { type: Number, default: 0 },
  maxProficiency: { type: Number, default: 100 },
  
  // 元数据
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// 索引
ComboChainSchema.index({ species: 1, unlockLevel: 1 });
ComboChainSchema.index({ 'sequence.0': 1 }); // 起始技能索引

module.exports = mongoose.model('ComboChain', ComboChainSchema);
```

### 4. API 路由

```javascript
// backend/pokemon-service/routes/comboChainRoutes.js

const express = require('express');
const router = express.Router();
const ComboChainSystem = require('../src/comboChainSystem');
const authMiddleware = require('../../../shared/middleware/auth');
const { validateRequest } = require('../../../shared/middleware/validation');

const comboSystem = new ComboChainSystem();

/**
 * 获取精灵可用的连击链
 */
router.get('/pokemon/:pokemonId/chains', authMiddleware, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const chains = await comboSystem.loadComboChains(pokemonId);
    
    res.json({
      success: true,
      data: chains,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 获取连击链推荐
 */
router.get('/pokemon/:pokemonId/recommendations', authMiddleware, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { skills } = req.query;
    
    const currentSkills = skills ? skills.split(',') : [];
    const recommendations = await comboSystem.getComboRecommendations(pokemonId, currentSkills);
    
    res.json({
      success: true,
      data: recommendations,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 触发连击链
 */
router.post('/pokemon/:pokemonId/trigger', 
  authMiddleware,
  validateRequest({
    body: {
      skillId: { type: 'string', required: true },
      battleContext: { type: 'object', required: false },
    },
  }),
  async (req, res) => {
    try {
      const { pokemonId } = req.params;
      const { skillId, battleContext } = req.body;
      
      const result = await comboSystem.tryTriggerComboChain(pokemonId, skillId, battleContext);
      
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

/**
 * 执行连击链
 */
router.post('/pokemon/:pokemonId/execute',
  authMiddleware,
  validateRequest({
    body: {
      chainId: { type: 'string', required: true },
      battleContext: { type: 'object', required: false },
    },
  }),
  async (req, res) => {
    try {
      const { pokemonId } = req.params;
      const { chainId, battleContext } = req.body;
      
      const execution = await comboSystem.executeComboChain(pokemonId, chainId, battleContext);
      
      res.json({
        success: true,
        data: execution,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

module.exports = router;
```

### 5. 前端连击链 UI 组件

```javascript
// frontend/game-client/src/components/ComboChainDisplay.js

import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Text, Animated, TouchableOpacity } from 'react-native';
import { useGame } from '../hooks/useGame';
import { comboChainApi } from '../api/comboChainApi';

export function ComboChainDisplay({ pokemonId }) {
  const { battleState } = useGame();
  const [availableChains, setAvailableChains] = useState([]);
  const [activeChain, setActiveChain] = useState(null);
  const [chainProgress, setChainProgress] = useState(0);
  const [timingAnim] = useState(new Animated.Value(0));

  // 加载可用连击链
  useEffect(() => {
    comboChainApi.getAvailableChains(pokemonId).then(chains => {
      setAvailableChains(chains);
    });
  }, [pokemonId]);

  // 时机窗口动画
  const startTimingAnimation = useCallback(() => {
    Animated.sequence([
      Animated.timing(timingAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(timingAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, [timingAnim]);

  // 连击链执行中动画
  if (activeChain) {
    return (
      <View style={styles.container}>
        <View style={styles.chainProgress}>
          {activeChain.sequence.map((skill, index) => (
            <View
              key={skill.id}
              style={[
                styles.skillNode,
                index <= chainProgress && styles.skillNodeActive,
                index === chainProgress && styles.skillNodeCurrent,
              ]}
            >
              <Text style={styles.skillIcon}>{skill.icon}</Text>
              {index === chainProgress && (
                <Animated.View
                  style={[
                    styles.timingRing,
                    { transform: [{ scale: timingAnim }] },
                  ]}
                />
              )}
            </View>
          ))}
        </View>
        
        <Text style={styles.chainName}>{activeChain.name}</Text>
        <Text style={styles.damageBonus}>伤害加成: +{activeChain.currentBonus}%</Text>
      </View>
    );
  }

  // 显示可用连击链提示
  return (
    <View style={styles.container}>
      {availableChains.length > 0 && (
        <View style={styles.hintContainer}>
          <Text style={styles.hintTitle}>可用连击链</Text>
          {availableChains.slice(0, 3).map(chain => (
            <TouchableOpacity
              key={chain.id}
              style={styles.chainHint}
              onPress={() => {/* 显示连击链详情 */}}
            >
              <Text style={styles.chainName}>{chain.name}</Text>
              <Text style={styles.chainRequirement}>
                起始技能: {chain.startSkill?.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 100,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 12,
    padding: 16,
  },
  chainProgress: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  skillNode: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 8,
    borderWidth: 2,
    borderColor: '#555',
  },
  skillNodeActive: {
    backgroundColor: '#4CAF50',
    borderColor: '#81C784',
  },
  skillNodeCurrent: {
    borderColor: '#FFD700',
    shadowColor: '#FFD700',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 10,
  },
  skillIcon: {
    fontSize: 20,
    color: '#FFF',
  },
  timingRing: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 3,
    borderColor: '#FFD700',
  },
  chainName: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 8,
  },
  damageBonus: {
    color: '#4CAF50',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
  },
  hintContainer: {
    alignItems: 'center',
  },
  hintTitle: {
    color: '#FFF',
    fontSize: 14,
    marginBottom: 8,
  },
  chainHint: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    padding: 8,
    borderRadius: 8,
    marginBottom: 4,
    width: '100%',
  },
  chainRequirement: {
    color: '#AAA',
    fontSize: 12,
  },
});
```

## 验收标准

- [ ] 技能冷却智能加速系统正确计算各项加成
- [ ] 速度属性冷却缩减效果符合预期（每 10 点速度减少 2% 冷却）
- [ ] 装备冷却加成上限为 30%
- [ ] 天气环境对特定属性技能冷却有正确影响
- [ ] 连击链触发条件检测准确
- [ ] 连击链序列执行动画流畅
- [ ] 连击熟练度更新正常
- [ ] API 接口返回正确的连击链数据
- [ ] 前端连击链 UI 显示正确
- [ ] 时机窗口动画流畅无卡顿
- [ ] 连击链冷却机制正常工作
- [ ] 连击链推荐功能正确返回建议

## 影响范围

- `backend/pokemon-service/src/skillCooldownAccelerator.js` - 新增冷却加速模块
- `backend/pokemon-service/src/comboChainSystem.js` - 新增连击链系统
- `backend/pokemon-service/models/ComboChain.js` - 新增连击链数据模型
- `backend/pokemon-service/routes/comboChainRoutes.js` - 新增 API 路由
- `frontend/game-client/src/components/ComboChainDisplay.js` - 新增前端组件
- `database/migrations/` - 新增数据库迁移脚本

## 参考

- [精灵技能系统设计文档](../architecture/skill-system.md)
- [战斗系统设计文档](../architecture/battle-system.md)
- [REQ-00288 精灵技能连击系统](./REQ-00288-skill-combo-system.md)
- [REQ-00112 精灵技能冷却与能量系统](./REQ-00112-skill-cooldown-energy-system.md)
