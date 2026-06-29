# REQ-00365: 精灵团队战斗AI策略助手系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00365 |
| 标题 | 精灵团队战斗AI策略助手系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gym-service、pokemon-service、user-service、social-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 14:00 UTC |

## 需求描述

### 背景
当前精灵战斗系统已有完整的战斗机制和道馆对战功能，但玩家在战斗中缺乏智能策略建议。许多玩家特别是新手，在面对复杂战斗场景时难以做出最优决策，导致战斗体验不佳和流失风险。

### 目标
构建精灵团队战斗AI策略助手系统，在战斗中为玩家提供实时智能策略建议、技能释放推荐、阵容搭配优化等功能，提升战斗的智能性和趣味性，降低新手玩家学习成本。

### 核心功能
1. **实时战斗策略推荐**：基于当前战斗状态，推荐最优技能使用顺序
2. **阵容智能分析**：分析玩家精灵团队配置，提供阵容优化建议
3. **对手弱点分析**：识别敌方精灵属性弱点，推荐针对性技能
4. **战斗预测系统**：预测战斗结果和伤害输出，辅助玩家决策
5. **历史战报学习**：基于历史战斗数据，持续优化AI策略模型

## 技术方案

### 1. 战斗策略AI引擎

#### 1.1 策略推荐算法
```javascript
// backend/gym-service/ai/BattleStrategyEngine.js
const { EventEmitter } = require('events');
const TensorFlow = require('@tensorflow/tfjs-node');

class BattleStrategyEngine extends EventEmitter {
  constructor() {
    super();
    this.model = null;
    this.actionSpace = this.initActionSpace();
    this.stateSpace = this.initStateSpace();
  }

  /**
   * 初始化动作空间
   */
  initActionSpace() {
    return {
      SKILL_USE: 'skill_use',
      SWITCH_POKEMON: 'switch_pokemon',
      ITEM_USE: 'item_use',
      DEFEND: 'defend',
      FLEE: 'flee'
    };
  }

  /**
   * 初始化状态空间
   */
  initStateSpace() {
    return {
      allyPokemon: ['hp', 'energy', 'buffs', 'debuffs', 'skill_cooldowns'],
      enemyPokemon: ['hp', 'energy', 'buffs', 'debuffs', 'predicted_skills'],
      battleContext: ['turn', 'weather', 'terrain', 'status']
    };
  }

  /**
   * 加载预训练模型
   */
  async loadModel() {
    try {
      this.model = await TensorFlow.loadLayersModel(
        'file://./models/battle_strategy_model.json'
      );
      console.log('[BattleStrategyEngine] Model loaded successfully');
    } catch (error) {
      console.error('[BattleStrategyEngine] Failed to load model:', error);
      // 使用默认启发式策略
      this.model = null;
    }
  }

  /**
   * 分析战斗状态并生成策略建议
   * @param {Object} battleState - 当前战斗状态
   * @returns {Object} 策略建议
   */
  async analyzeBattleState(battleState) {
    const startTime = Date.now();
    
    try {
      // 特征提取
      const features = this.extractFeatures(battleState);
      
      // AI模型预测
      let strategy;
      if (this.model) {
        strategy = await this.predictWithModel(features);
      } else {
        strategy = this.heuristicStrategy(features);
      }
      
      // 添加解释性信息
      strategy.explanation = this.generateExplanation(strategy, features);
      strategy.confidence = this.calculateConfidence(strategy, features);
      strategy.processingTime = Date.now() - startTime;
      
      this.emit('strategyGenerated', strategy);
      
      return strategy;
    } catch (error) {
      console.error('[BattleStrategyEngine] Strategy analysis failed:', error);
      return this.getDefaultStrategy();
    }
  }

  /**
   * 提取战斗特征
   */
  extractFeatures(battleState) {
    const { ally, enemy, context } = battleState;
    
    return {
      // 己方精灵特征
      allyFeatures: {
        hpRatio: ally.currentHp / ally.maxHp,
        energyRatio: ally.currentEnergy / ally.maxEnergy,
        attributeType: ally.type,
        skills: ally.skills.map(s => ({
          id: s.id,
          power: s.power,
          accuracy: s.accuracy,
          cooldown: s.cooldown,
          element: s.element
        })),
        buffs: ally.buffs || [],
        debuffs: ally.debuffs || [],
        level: ally.level,
        ivTotal: Object.values(ally.iv).reduce((a, b) => a + b, 0)
      },
      
      // 敌方精灵特征
      enemyFeatures: {
        hpRatio: enemy.currentHp / enemy.maxHp,
        energyRatio: enemy.currentEnergy / enemy.maxEnergy,
        attributeType: enemy.type,
        weaknesses: this.getAttributeWeaknesses(enemy.type),
        predictedSkills: this.predictEnemySkills(enemy),
        threatLevel: this.calculateThreatLevel(enemy)
      },
      
      // 战斗上下文特征
      contextFeatures: {
        turnNumber: context.turn,
        weather: context.weather || 'normal',
        terrain: context.terrain || 'normal',
        battleType: context.type, // pvp, pve, gym
        timePressure: context.timeLimit ? true : false
      }
    };
  }

  /**
   * 使用AI模型预测
   */
  async predictWithModel(features) {
    const inputTensor = this.featuresToTensor(features);
    const prediction = this.model.predict(inputTensor);
    const actionProbabilities = await prediction.data();
    
    return this.decodePrediction(actionProbabilities, features);
  }

  /**
   * 启发式策略（无模型时使用）
   */
  heuristicStrategy(features) {
    const { allyFeatures, enemyFeatures, contextFeatures } = features;
    
    const recommendations = [];
    
    // 策略1：属性克制优先
    const effectiveSkills = allyFeatures.skills.filter(skill => 
      this.isSuperEffective(skill.element, enemyFeatures.attributeType)
    );
    
    if (effectiveSkills.length > 0 && allyFeatures.energyRatio > 0.3) {
      recommendations.push({
        action: this.actionSpace.SKILL_USE,
        skillId: effectiveSkills[0].id,
        priority: 'high',
        reason: '属性克制技能，伤害加成50%'
      });
    }
    
    // 策略2：血量低时防御或切换
    if (allyFeatures.hpRatio < 0.3) {
      const hasHealSkill = allyFeatures.skills.some(s => s.heal > 0);
      
      if (hasHealSkill && allyFeatures.energyRatio > 0.2) {
        recommendations.push({
          action: this.actionSpace.SKILL_USE,
          skillId: allyFeatures.skills.find(s => s.heal > 0).id,
          priority: 'critical',
          reason: '血量过低，优先使用治疗技能'
        });
      } else {
        recommendations.push({
          action: this.actionSpace.DEFEND,
          priority: 'critical',
          reason: '血量过低，建议防御或切换精灵'
        });
      }
    }
    
    // 策略3：敌方血量低时收割
    if (enemyFeatures.hpRatio < 0.2) {
      const strongestSkill = allyFeatures.skills.reduce((a, b) => 
        a.power > b.power ? a : b
      );
      
      recommendations.push({
        action: this.actionSpace.SKILL_USE,
        skillId: strongestSkill.id,
        priority: 'high',
        reason: '敌方血量低，使用最强技能收割'
      });
    }
    
    // 策略4：能量管理
    if (allyFeatures.energyRatio < 0.3) {
      recommendations.push({
        action: this.actionSpace.DEFEND,
        priority: 'medium',
        reason: '能量不足，建议防御回复能量'
      });
    }
    
    // 策略5：根据天气/地形调整
    if (contextFeatures.weather !== 'normal') {
      const weatherBoostSkill = allyFeatures.skills.find(s => 
        this.getWeatherBoost(s.element, contextFeatures.weather) > 1.0
      );
      
      if (weatherBoostSkill) {
        recommendations.push({
          action: this.actionSpace.SKILL_USE,
          skillId: weatherBoostSkill.id,
          priority: 'medium',
          reason: `天气${contextFeatures.weather}加成技能`
        });
      }
    }
    
    // 排序并返回最高优先级
    recommendations.sort((a, b) => {
      const priorityOrder = { critical: 3, high: 2, medium: 1, low: 0 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
    
    return {
      primaryAction: recommendations[0] || { action: this.actionSpace.DEFEND, priority: 'low' },
      alternativeActions: recommendations.slice(1, 3),
      confidence: 0.75,
      strategy: 'heuristic'
    };
  }

  /**
   * 获取属性弱点
   */
  getAttributeWeaknesses(type) {
    const weaknessMap = {
      fire: ['water', 'ground', 'rock'],
      water: ['electric', 'grass'],
      grass: ['fire', 'ice', 'poison', 'flying', 'bug'],
      electric: ['ground'],
      ice: ['fire', 'fighting', 'rock', 'steel'],
      fighting: ['flying', 'psychic', 'fairy'],
      poison: ['ground', 'psychic'],
      ground: ['water', 'grass', 'ice'],
      flying: ['electric', 'ice', 'rock'],
      psychic: ['bug', 'ghost', 'dark'],
      bug: ['fire', 'flying', 'rock'],
      rock: ['water', 'grass', 'fighting', 'ground', 'steel'],
      ghost: ['ghost', 'dark'],
      dragon: ['ice', 'dragon', 'fairy'],
      dark: ['fighting', 'bug', 'fairy'],
      steel: ['fire', 'fighting', 'ground'],
      fairy: ['poison', 'steel']
    };
    
    return weaknessMap[type.toLowerCase()] || [];
  }

  /**
   * 判断属性克制
   */
  isSuperEffective(attackType, defenseType) {
    const weaknesses = this.getAttributeWeaknesses(defenseType);
    return weaknesses.includes(attackType.toLowerCase());
  }

  /**
   * 预测敌方技能
   */
  predictEnemySkills(enemy) {
    // 基于敌方精灵类型和等级预测可能使用的技能
    // 简化实现：返回敌方技能列表按威胁度排序
    return enemy.skills
      .map(skill => ({
        id: skill.id,
        power: skill.power,
        likelihood: this.calculateSkillLikelihood(skill, enemy)
      }))
      .sort((a, b) => b.likelihood - a.likelihood)
      .slice(0, 3);
  }

  /**
   * 计算威胁等级
   */
  calculateThreatLevel(enemy) {
    const hpFactor = enemy.currentHp / enemy.maxHp;
    const levelFactor = enemy.level / 100;
    const skillPowerFactor = enemy.skills.reduce((sum, s) => sum + s.power, 0) / (enemy.skills.length * 100);
    
    return (hpFactor * 0.3 + levelFactor * 0.4 + skillPowerFactor * 0.3);
  }

  /**
   * 生成策略解释
   */
  generateExplanation(strategy, features) {
    const explanation = {
      summary: '',
      details: []
    };
    
    if (strategy.primaryAction) {
      const action = strategy.primaryAction;
      
      switch (action.action) {
        case this.actionSpace.SKILL_USE:
          const skill = features.allyFeatures.skills.find(s => s.id === action.skillId);
          explanation.summary = `推荐使用技能【${skill.name}】`;
          explanation.details.push(`技能威力：${skill.power}`);
          explanation.details.push(`命中率：${skill.accuracy}%`);
          if (action.reason) {
            explanation.details.push(`理由：${action.reason}`);
          }
          break;
          
        case this.actionSpace.SWITCH_POKEMON:
          explanation.summary = '建议切换精灵';
          explanation.details.push('当前精灵状态不佳，切换可保存战力');
          break;
          
        case this.actionSpace.DEFEND:
          explanation.summary = '建议防御';
          explanation.details.push('防御可减少受到的伤害，并回复能量');
          break;
          
        case this.actionSpace.ITEM_USE:
          explanation.summary = '建议使用道具';
          break;
      }
    }
    
    return explanation;
  }

  /**
   * 计算置信度
   */
  calculateConfidence(strategy, features) {
    // 基于多个因素计算置信度
    let confidence = 0.5;
    
    // 血量差异
    const hpAdvantage = features.allyFeatures.hpRatio - features.enemyFeatures.hpRatio;
    confidence += hpAdvantage * 0.2;
    
    // 等级差异
    const levelAdvantage = (features.allyFeatures.level - features.enemyFeatures.level) / 100;
    confidence += levelAdvantage * 0.1;
    
    // 属性克制
    if (strategy.primaryAction?.action === this.actionSpace.SKILL_USE) {
      const skill = features.allyFeatures.skills.find(s => s.id === strategy.primaryAction.skillId);
      if (skill && this.isSuperEffective(skill.element, features.enemyFeatures.attributeType)) {
        confidence += 0.15;
      }
    }
    
    return Math.max(0.1, Math.min(0.95, confidence));
  }

  /**
   * 获取默认策略
   */
  getDefaultStrategy() {
    return {
      primaryAction: {
        action: this.actionSpace.DEFEND,
        priority: 'low'
      },
      alternativeActions: [],
      confidence: 0.3,
      explanation: {
        summary: '无法分析当前状态，建议谨慎行动',
        details: ['系统无法获取完整的战斗信息']
      }
    };
  }

  /**
   * 特征转张量
   */
  featuresToTensor(features) {
    // 将特征转换为模型输入张量
    const featureArray = [
      features.allyFeatures.hpRatio,
      features.allyFeatures.energyRatio,
      features.allyFeatures.level / 100,
      features.enemyFeatures.hpRatio,
      features.enemyFeatures.energyRatio,
      features.enemyFeatures.threatLevel
    ];
    
    return TensorFlow.tensor2d([featureArray]);
  }

  /**
   * 解码预测结果
   */
  decodePrediction(probabilities, features) {
    // 将模型输出转换为可执行的策略建议
    const maxProbIndex = probabilities.indexOf(Math.max(...probabilities));
    
    // 根据概率分布选择动作
    const actions = Object.values(this.actionSpace);
    const selectedAction = actions[maxProbIndex] || this.actionSpace.DEFEND;
    
    return {
      primaryAction: {
        action: selectedAction,
        priority: 'high',
        confidence: probabilities[maxProbIndex]
      },
      alternativeActions: [],
      strategy: 'ai_model'
    };
  }
}

module.exports = BattleStrategyEngine;
```

#### 1.2 阵容智能分析服务
```javascript
// backend/gym-service/ai/TeamCompositionAnalyzer.js
class TeamCompositionAnalyzer {
  constructor(pokemonService) {
    this.pokemonService = pokemonService;
    this.synergyMatrix = this.initSynergyMatrix();
  }

  /**
   * 初始化协同矩阵
   */
  initSynergyMatrix() {
    // 定义精灵类型之间的协同关系
    return {
      'fire-grass': { synergy: 0.8, reason: '火草组合可覆盖更多属性弱点' },
      'water-electric': { synergy: 0.9, reason: '水电组合形成强力输出链' },
      'fighting-psychic': { synergy: 0.85, reason: '格斗超能组合攻守兼备' },
      'dragon-fairy': { synergy: 0.75, reason: '龙妖精组合提供强力打击面' }
    };
  }

  /**
   * 分析团队配置
   * @param {Array} team - 玩家精灵团队
   * @returns {Object} 分析结果和建议
   */
  async analyzeTeamComposition(team) {
    const analysis = {
      overallScore: 0,
      typeCoverage: this.analyzeTypeCoverage(team),
      synergyAnalysis: this.analyzeSynergy(team),
      weaknesses: this.identifyWeaknesses(team),
      recommendations: []
    };

    // 计算综合评分
    analysis.overallScore = this.calculateOverallScore(analysis);

    // 生成优化建议
    analysis.recommendations = this.generateRecommendations(analysis);

    return analysis;
  }

  /**
   * 分析属性覆盖
   */
  analyzeTypeCoverage(team) {
    const allTypes = ['fire', 'water', 'grass', 'electric', 'ice', 'fighting', 
                      'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 
                      'ghost', 'dragon', 'dark', 'steel', 'fairy'];
    
    const coveredTypes = new Set();
    const teamTypes = team.map(p => p.type);

    // 检查每个精灵的攻击属性覆盖
    team.forEach(pokemon => {
      pokemon.skills.forEach(skill => {
        if (skill.element) {
          coveredTypes.add(skill.element.toLowerCase());
        }
      });
    });

    const uncoveredTypes = allTypes.filter(type => !coveredTypes.has(type));
    const coverageRatio = (allTypes.length - uncoveredTypes.length) / allTypes.length;

    return {
      coveredTypes: Array.from(coveredTypes),
      uncoveredTypes,
      coverageRatio,
      score: coverageRatio * 100
    };
  }

  /**
   * 分析协同效应
   */
  analyzeSynergy(team) {
    const synergies = [];
    
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        const type1 = team[i].type.toLowerCase();
        const type2 = team[j].type.toLowerCase();
        
        const key1 = `${type1}-${type2}`;
        const key2 = `${type2}-${type1}`;
        
        const synergy = this.synergyMatrix[key1] || this.synergyMatrix[key2];
        
        if (synergy) {
          synergies.push({
            pokemon1: team[i].id,
            pokemon2: team[j].id,
            synergy: synergy.synergy,
            reason: synergy.reason
          });
        }
      }
    }

    return {
      synergies,
      averageSynergy: synergies.length > 0 
        ? synergies.reduce((sum, s) => sum + s.synergy, 0) / synergies.length 
        : 0.5
    };
  }

  /**
   * 识别团队弱点
   */
  identifyWeaknesses(team) {
    const allWeaknesses = new Map();

    team.forEach(pokemon => {
      const weaknesses = this.getAttributeWeaknesses(pokemon.type);
      weaknesses.forEach(weakness => {
        allWeaknesses.set(
          weakness, 
          (allWeaknesses.get(weakness) || 0) + 1
        );
      });
    });

    // 识别共同弱点（被多个精灵克制）
    const commonWeaknesses = Array.from(allWeaknesses.entries())
      .filter(([type, count]) => count >= Math.ceil(team.length / 2))
      .map(([type, count]) => ({
        type,
        affectedCount: count,
        severity: count >= team.length ? 'critical' : 'high'
      }));

    return {
      allWeaknesses: Array.from(allWeaknesses.entries()).map(([type, count]) => ({ type, count })),
      commonWeaknesses,
      score: Math.max(0, 100 - commonWeaknesses.length * 20)
    };
  }

  /**
   * 计算综合评分
   */
  calculateOverallScore(analysis) {
    const weights = {
      typeCoverage: 0.4,
      synergy: 0.3,
      weaknesses: 0.3
    };

    return (
      analysis.typeCoverage.score * weights.typeCoverage +
      analysis.synergyAnalysis.averageSynergy * 100 * weights.synergy +
      analysis.weaknesses.score * weights.weaknesses
    );
  }

  /**
   * 生成优化建议
   */
  generateRecommendations(analysis) {
    const recommendations = [];

    // 属性覆盖不足
    if (analysis.typeCoverage.uncoveredTypes.length > 5) {
      recommendations.push({
        type: 'type_coverage',
        priority: 'high',
        suggestion: `团队属性覆盖不足，建议添加${analysis.typeCoverage.uncoveredTypes.slice(0, 3).join('、')}类型精灵`,
        impact: '提升团队打击面，增加战斗优势'
      });
    }

    // 共同弱点
    if (analysis.weaknesses.commonWeaknesses.length > 0) {
      const criticalWeakness = analysis.weaknesses.commonWeaknesses.find(w => w.severity === 'critical');
      if (criticalWeakness) {
        recommendations.push({
          type: 'weakness',
          priority: 'critical',
          suggestion: `团队存在致命弱点：${criticalWeakness.type}属性可克制${criticalWeakness.affectedCount}只精灵`,
          impact: '建议调整阵容，避免被单一属性全面克制'
        });
      }
    }

    // 协同效应低
    if (analysis.synergyAnalysis.averageSynergy < 0.5) {
      recommendations.push({
        type: 'synergy',
        priority: 'medium',
        suggestion: '团队协同效应较低，建议调整精灵组合',
        impact: '提升团队配合度，发挥更强战斗力'
      });
    }

    return recommendations;
  }

  /**
   * 获取属性弱点
   */
  getAttributeWeaknesses(type) {
    const weaknessMap = {
      fire: ['water', 'ground', 'rock'],
      water: ['electric', 'grass'],
      grass: ['fire', 'ice', 'poison', 'flying', 'bug'],
      electric: ['ground'],
      ice: ['fire', 'fighting', 'rock', 'steel'],
      fighting: ['flying', 'psychic', 'fairy'],
      poison: ['ground', 'psychic'],
      ground: ['water', 'grass', 'ice'],
      flying: ['electric', 'ice', 'rock'],
      psychic: ['bug', 'ghost', 'dark'],
      bug: ['fire', 'flying', 'rock'],
      rock: ['water', 'grass', 'fighting', 'ground', 'steel'],
      ghost: ['ghost', 'dark'],
      dragon: ['ice', 'dragon', 'fairy'],
      dark: ['fighting', 'bug', 'fairy'],
      steel: ['fire', 'fighting', 'ground'],
      fairy: ['poison', 'steel']
    };

    return weaknessMap[type.toLowerCase()] || [];
  }
}

module.exports = TeamCompositionAnalyzer;
```

### 2. API接口设计

#### 2.1 战斗策略推荐API
```javascript
// backend/gym-service/routes/battleStrategy.js
const express = require('express');
const router = express.Router();
const BattleStrategyEngine = require('../ai/BattleStrategyEngine');
const { authenticate, validateRequest } = require('../../../shared/middleware');
const Joi = require('joi');

const strategyEngine = new BattleStrategyEngine();

// 初始化AI引擎
strategyEngine.loadModel().catch(err => {
  console.error('Failed to load AI model:', err);
});

/**
 * POST /api/gym/battle/strategy
 * 获取实时战斗策略建议
 */
router.post('/strategy', 
  authenticate,
  validateRequest({
    body: Joi.object({
      battleId: Joi.string().required(),
      battleState: Joi.object({
        ally: Joi.object().required(),
        enemy: Joi.object().required(),
        context: Joi.object().required()
      }).required()
    })
  }),
  async (req, res) => {
    try {
      const { battleId, battleState } = req.body;
      const userId = req.user.id;

      // 获取策略建议
      const strategy = await strategyEngine.analyzeBattleState(battleState);

      // 记录策略使用情况（用于后续学习优化）
      await redis.hset(`battle:${battleId}:strategy:${userId}`, {
        timestamp: Date.now(),
        strategy: JSON.stringify(strategy)
      });

      res.json({
        success: true,
        data: {
          strategy,
          battleId
        }
      });
    } catch (error) {
      console.error('[BattleStrategy] Error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate strategy'
      });
    }
  }
);

/**
 * POST /api/gym/team/analyze
 * 分析团队配置并提供优化建议
 */
router.post('/team/analyze',
  authenticate,
  validateRequest({
    body: Joi.object({
      team: Joi.array().items(Joi.object()).min(1).max(6).required()
    })
  }),
  async (req, res) => {
    try {
      const { team } = req.body;
      const TeamCompositionAnalyzer = require('../ai/TeamCompositionAnalyzer');
      const analyzer = new TeamCompositionAnalyzer();

      const analysis = await analyzer.analyzeTeamComposition(team);

      res.json({
        success: true,
        data: analysis
      });
    } catch (error) {
      console.error('[TeamAnalyzer] Error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to analyze team'
      });
    }
  }
);

/**
 * GET /api/gym/battle/prediction/:battleId
 * 获取战斗预测
 */
router.get('/prediction/:battleId',
  authenticate,
  async (req, res) => {
    try {
      const { battleId } = req.params;
      const userId = req.user.id;

      // 从缓存获取战斗状态
      const battleData = await redis.get(`battle:${battleId}:state`);
      if (!battleData) {
        return res.status(404).json({
          success: false,
          error: 'Battle not found'
        });
      }

      const battleState = JSON.parse(battleData);
      
      // 生成预测
      const prediction = await generateBattlePrediction(battleState);

      res.json({
        success: true,
        data: prediction
      });
    } catch (error) {
      console.error('[BattlePrediction] Error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate prediction'
      });
    }
  }
);

/**
 * 生成战斗预测
 */
async function generateBattlePrediction(battleState) {
  const { ally, enemy } = battleState;

  // 计算胜率
  const allyPower = calculateTeamPower(ally);
  const enemyPower = calculateTeamPower(enemy);

  const winProbability = allyPower / (allyPower + enemyPower);

  // 预测剩余回合数
  const avgDamagePerTurn = allyPower * 0.1;
  const enemyHp = enemy.currentHp || enemy.reduce((sum, p) => sum + p.currentHp, 0);
  const estimatedTurns = Math.ceil(enemyHp / avgDamagePerTurn);

  return {
    winProbability: winProbability.toFixed(2),
    estimatedTurns,
    powerComparison: {
      ally: allyPower,
      enemy: enemyPower,
      advantage: allyPower > enemyPower ? 'ally' : 'enemy'
    },
    criticalFactors: [
      allyPower > enemyPower * 1.5 ? '战力大幅领先' : null,
      ally.some(p => p.type && isSuperEffective(p.type, enemy.type)) ? '存在属性克制' : null
    ].filter(Boolean)
  };
}

/**
 * 计算团队战力
 */
function calculateTeamPower(team) {
  if (Array.isArray(team)) {
    return team.reduce((sum, pokemon) => {
      return sum + calculatePokemonPower(pokemon);
    }, 0);
  }
  return calculatePokemonPower(team);
}

/**
 * 计算精灵战力
 */
function calculatePokemonPower(pokemon) {
  const basePower = pokemon.level * 10;
  const hpFactor = pokemon.currentHp / pokemon.maxHp;
  const skillPower = pokemon.skills ? pokemon.skills.reduce((sum, s) => sum + s.power, 0) : 0;

  return basePower * hpFactor + skillPower;
}

/**
 * 判断属性克制
 */
function isSuperEffective(attackType, defenseType) {
  const weaknessMap = {
    fire: ['grass', 'ice', 'bug', 'steel'],
    water: ['fire', 'ground', 'rock'],
    grass: ['water', 'ground', 'rock'],
    electric: ['water', 'flying'],
    ice: ['grass', 'ground', 'flying', 'dragon'],
    fighting: ['normal', 'ice', 'rock', 'dark', 'steel'],
    poison: ['grass', 'fairy'],
    ground: ['fire', 'electric', 'poison', 'rock', 'steel'],
    flying: ['grass', 'fighting', 'bug'],
    psychic: ['fighting', 'poison'],
    bug: ['grass', 'psychic', 'dark'],
    rock: ['fire', 'ice', 'flying', 'bug'],
    ghost: ['psychic', 'ghost'],
    dragon: ['dragon'],
    dark: ['psychic', 'ghost'],
    steel: ['ice', 'rock', 'fairy'],
    fairy: ['fighting', 'dragon', 'dark']
  };

  const weaknesses = weaknessMap[attackType.toLowerCase()] || [];
  return weaknesses.includes(defenseType.toLowerCase());
}

module.exports = router;
```

### 3. 数据库设计

```sql
-- backend/database/migrations/20260629_create_battle_strategy_tables.sql

-- 战斗策略记录表
CREATE TABLE IF NOT EXISTS battle_strategy_logs (
  id SERIAL PRIMARY KEY,
  battle_id VARCHAR(100) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  battle_state JSONB NOT NULL,
  strategy_recommendation JSONB NOT NULL,
  user_action VARCHAR(50),
  action_result VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_battle_strategy_logs_battle_id ON battle_strategy_logs(battle_id);
CREATE INDEX idx_battle_strategy_logs_user_id ON battle_strategy_logs(user_id);
CREATE INDEX idx_battle_strategy_logs_created_at ON battle_strategy_logs(created_at);

-- 团队配置分析历史表
CREATE TABLE IF NOT EXISTS team_analysis_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_composition JSONB NOT NULL,
  analysis_result JSONB NOT NULL,
  overall_score DECIMAL(5, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_team_analysis_history_user_id ON team_analysis_history(user_id);
CREATE INDEX idx_team_analysis_history_score ON team_analysis_history(overall_score);

-- AI策略模型训练数据表
CREATE TABLE IF NOT EXISTS ai_strategy_training_data (
  id SERIAL PRIMARY KEY,
  battle_id VARCHAR(100) NOT NULL,
  user_id INTEGER NOT NULL,
  battle_state JSONB NOT NULL,
  strategy_used JSONB,
  battle_outcome VARCHAR(20) NOT NULL,
  user_feedback INTEGER CHECK (user_feedback >= 1 AND user_feedback <= 5),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_training_battle_id ON ai_strategy_training_data(battle_id);
CREATE INDEX idx_ai_training_outcome ON ai_strategy_training_data(battle_outcome);

-- 用户策略偏好表
CREATE TABLE IF NOT EXISTS user_strategy_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  preferred_strategy_style VARCHAR(50) DEFAULT 'balanced',
  risk_tolerance DECIMAL(3, 2) DEFAULT 0.5,
  enable_auto_suggestions BOOLEAN DEFAULT true,
  suggestion_frequency VARCHAR(20) DEFAULT 'always',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 策略效果统计表
CREATE TABLE IF NOT EXISTS strategy_effectiveness_stats (
  id SERIAL PRIMARY KEY,
  strategy_type VARCHAR(50) NOT NULL,
  total_usage INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  avg_battle_duration DECIMAL(8, 2),
  avg_damage_dealt DECIMAL(10, 2),
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(strategy_type)
);
```

### 4. 前端集成

```javascript
// frontend/game-client/src/game/BattleStrategyUI.js
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import { battleApi } from '../api/battleApi';

class BattleStrategyUI {
  constructor(battleId) {
    this.battleId = battleId;
    this.strategyEngine = new BattleStrategyEngine();
    this.suggestionQueue = [];
    this.isVisible = false;
    this.animationValue = new Animated.Value(0);
  }

  /**
   * 请求策略建议
   */
  async requestStrategy(battleState) {
    try {
      const response = await battleApi.getStrategy({
        battleId: this.battleId,
        battleState
      });

      if (response.success) {
        this.showStrategySuggestion(response.data.strategy);
      }
    } catch (error) {
      console.error('Failed to get strategy:', error);
    }
  }

  /**
   * 显示策略建议
   */
  showStrategySuggestion(strategy) {
    this.currentStrategy = strategy;
    
    Animated.spring(this.animationValue, {
      toValue: 1,
      useNativeDriver: true,
      tension: 100,
      friction: 7
    }).start();

    this.isVisible = true;

    // 5秒后自动隐藏
    setTimeout(() => {
      this.hideSuggestion();
    }, 5000);
  }

  /**
   * 隐藏建议
   */
  hideSuggestion() {
    Animated.timing(this.animationValue, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true
    }).start(() => {
      this.isVisible = false;
    });
  }

  /**
   * 渲染UI
   */
  render() {
    if (!this.isVisible || !this.currentStrategy) {
      return null;
    }

    const { primaryAction, explanation, confidence } = this.currentStrategy;

    return (
      <Animated.View 
        style={[
          styles.container,
          {
            opacity: this.animationValue,
            transform: [{
              translateY: this.animationValue.interpolate({
                inputRange: [0, 1],
                outputRange: [100, 0]
              })
            }]
          }
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>AI 策略建议</Text>
          <View style={[styles.confidenceBadge, { backgroundColor: this.getConfidenceColor(confidence) }]}>
            <Text style={styles.confidenceText}>{Math.round(confidence * 100)}%</Text>
          </View>
        </View>

        <Text style={styles.summary}>{explanation.summary}</Text>

        {explanation.details.map((detail, index) => (
          <Text key={index} style={styles.detail}>• {detail}</Text>
        ))}

        <TouchableOpacity 
          style={styles.actionButton}
          onPress={() => this.executeAction(primaryAction)}
        >
          <Text style={styles.actionButtonText}>
            {this.getActionText(primaryAction.action)}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={styles.dismissButton}
          onPress={() => this.hideSuggestion()}
        >
          <Text style={styles.dismissText}>忽略</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  }

  /**
   * 获取置信度颜色
   */
  getConfidenceColor(confidence) {
    if (confidence >= 0.8) return '#4CAF50';
    if (confidence >= 0.6) return '#FF9800';
    return '#F44336';
  }

  /**
   * 获取动作文本
   */
  getActionText(action) {
    const actionTexts = {
      skill_use: '使用推荐技能',
      switch_pokemon: '切换精灵',
      defend: '防御',
      item_use: '使用道具',
      flee: '逃跑'
    };
    return actionTexts[action] || '执行动作';
  }

  /**
   * 执行动作
   */
  executeAction(action) {
    this.hideSuggestion();
    // 触发游戏战斗引擎执行相应动作
    BattleEngine.executeStrategy(action);
  }
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: '#4CAF50'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#4CAF50'
  },
  confidenceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12
  },
  confidenceText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold'
  },
  summary: {
    fontSize: 14,
    color: 'white',
    marginBottom: 8,
    fontWeight: '600'
  },
  detail: {
    fontSize: 12,
    color: '#CCCCCC',
    marginBottom: 4
  },
  actionButton: {
    backgroundColor: '#4CAF50',
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 12,
    alignItems: 'center'
  },
  actionButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold'
  },
  dismissButton: {
    marginTop: 8,
    alignItems: 'center'
  },
  dismissText: {
    color: '#999999',
    fontSize: 12
  }
});

export default BattleStrategyUI;
```

### 5. 性能优化

```javascript
// backend/gym-service/ai/StrategyCache.js
const NodeCache = require('node-cache');

class StrategyCache {
  constructor() {
    // 策略缓存（5分钟TTL）
    this.strategyCache = new NodeCache({
      stdTTL: 300,
      checkperiod: 60,
      maxKeys: 10000
    });

    // 团队分析缓存（1小时TTL）
    this.teamAnalysisCache = new NodeCache({
      stdTTL: 3600,
      checkperiod: 300,
      maxKeys: 5000
    });
  }

  /**
   * 获取缓存的策略
   */
  getCachedStrategy(battleStateHash) {
    return this.strategyCache.get(battleStateHash);
  }

  /**
   * 缓存策略
   */
  cacheStrategy(battleStateHash, strategy) {
    this.strategyCache.set(battleStateHash, strategy);
  }

  /**
   * 生成战斗状态哈希
   */
  generateBattleStateHash(battleState) {
    const { ally, enemy, context } = battleState;
    const key = `${ally.id}-${ally.currentHp}-${ally.currentEnergy}-${enemy.id}-${enemy.currentHp}-${context.turn}`;
    return require('crypto').createHash('md5').update(key).digest('hex');
  }

  /**
   * 获取缓存的团队分析
   */
  getCachedTeamAnalysis(teamHash) {
    return this.teamAnalysisCache.get(teamHash);
  }

  /**
   * 缓存团队分析
   */
  cacheTeamAnalysis(teamHash, analysis) {
    this.teamAnalysisCache.set(teamHash, analysis);
  }

  /**
   * 生成团队哈希
   */
  generateTeamHash(team) {
    const sortedTeam = team.sort((a, b) => a.id - b.id);
    const key = sortedTeam.map(p => `${p.id}-${p.level}`).join('-');
    return require('crypto').createHash('md5').update(key).digest('hex');
  }
}

module.exports = StrategyCache;
```

## 验收标准

- [ ] 战斗策略推荐功能上线，响应时间 < 500ms
- [ ] 团队配置分析功能可用，提供至少3个维度的分析
- [ ] AI策略准确率达到70%以上（基于用户反馈）
- [ ] 前端策略建议UI可用，支持一键执行推荐动作
- [ ] 策略缓存系统有效，缓存命中率 > 60%
- [ ] 战斗预测功能可用，准确率 > 65%
- [ ] 支持新手引导模式，自动显示策略建议
- [ ] 数据库表创建完成，索引优化到位
- [ ] API接口文档完善，包含使用示例
- [ ] 单元测试覆盖率 > 80%

## 影响范围

- gym-service：新增AI策略引擎和分析服务
- pokemon-service：需要提供精灵数据接口
- user-service：存储用户策略偏好
- social-service：支持策略分享功能
- gateway：新增路由配置
- game-client：新增策略UI组件
- database/migrations：新增5张数据表

## 参考

- TensorFlow.js 文档：https://www.tensorflow.org/js
- 游戏AI策略设计：https://www.gamedeveloper.com/programming/game-ai
- 强化学习在游戏中的应用：https://arxiv.org/abs/2006.05838
- mineGo战斗系统设计文档：/docs/architecture/battle-system.md
