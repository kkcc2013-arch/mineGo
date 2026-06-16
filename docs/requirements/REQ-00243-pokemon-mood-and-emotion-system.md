# REQ-00243: 精灵心情系统与情绪表现

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00243 |
| 标题 | 精灵心情系统与情绪表现 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-16 03:30 |

## 需求描述

### 背景
当前精灵系统仅关注基础属性、技能和进化，缺乏精灵个性化和情感交互体验。引入心情系统可以：
- 增强玩家与精灵之间的情感连接
- 提供更丰富的养成策略深度
- 影响战斗表现，增加策略维度
- 提升游戏沉浸感和长期留存

### 目标
实现完整的精灵心情与情绪表现系统，包括：
1. 心情值系统（0-100分，多维度评估）
2. 心情影响因素（互动、战斗、休息、道具等）
3. 情绪表现可视化（动画、表情、粒子效果）
4. 心情对战斗的影响机制
5. 心情恢复与维护策略

### 核心功能
- **心情维度**：饥饿度、快乐度、信任度、疲劳度、兴奋度
- **影响因素**：喂食、互动、战斗、休息、道具、环境、事件
- **情绪表现**：表情动画、粒子效果、音效、特殊动作
- **战斗影响**：心情加成/惩罚、特殊技能触发、状态抵抗

## 技术方案

### 1. 数据模型设计

#### 心情数据表结构
```sql
-- 精灵心情表
CREATE TABLE pokemon_mood (
    id BIGSERIAL PRIMARY KEY,
    pokemon_id BIGINT NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    
    -- 心情维度值（0-100）
    happiness INT NOT NULL DEFAULT 50 CHECK (happiness BETWEEN 0 AND 100),
    hunger INT NOT NULL DEFAULT 50 CHECK (hunger BETWEEN 0 AND 100),
    trust INT NOT NULL DEFAULT 50 CHECK (trust BETWEEN 0 AND 100),
    fatigue INT NOT NULL DEFAULT 0 CHECK (fatigue BETWEEN 0 AND 100),
    excitement INT NOT NULL DEFAULT 50 CHECK (excitement BETWEEN 0 AND 100),
    
    -- 综合心情分数
    overall_mood DECIMAL(5,2) NOT NULL DEFAULT 50.00,
    
    -- 心情状态标签
    mood_state VARCHAR(20) NOT NULL DEFAULT 'neutral',
    -- 可能值: 'ecstatic', 'happy', 'content', 'neutral', 'sad', 'angry', 'sick'
    
    -- 心情更新时间戳
    last_interaction_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_fed_at TIMESTAMP,
    last_played_at TIMESTAMP,
    last_battle_at TIMESTAMP,
    
    -- 心情历史快照（JSON）
    mood_history JSONB DEFAULT '[]',
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(pokemon_id)
);

-- 心情影响因素记录表
CREATE TABLE mood_event_log (
    id BIGSERIAL PRIMARY KEY,
    pokemon_id BIGINT NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    event_type VARCHAR(50) NOT NULL,
    -- 'feed', 'play', 'battle', 'rest', 'item', 'evolution', 'trade', etc.
    
    event_data JSONB DEFAULT '{}',
    
    -- 心情变化
    happiness_delta INT DEFAULT 0,
    hunger_delta INT DEFAULT 0,
    trust_delta INT DEFAULT 0,
    fatigue_delta INT DEFAULT 0,
    excitement_delta INT DEFAULT 0,
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    INDEX idx_pokemon_created (pokemon_id, created_at DESC),
    INDEX idx_user_created (user_id, created_at DESC)
);

-- 心情配置表
CREATE TABLE mood_config (
    id BIGSERIAL PRIMARY KEY,
    pokemon_species_id BIGINT NOT NULL,
    
    -- 基础心情倾向
    base_happiness INT DEFAULT 50,
    base_hunger_rate INT DEFAULT 10,  -- 饥饿度下降速度
    base_fatigue_rate INT DEFAULT 5,  -- 疲劳度上升速度
    
    -- 心情影响因子
    happiness_battle_win_factor DECIMAL(3,2) DEFAULT 1.0,
    happiness_battle_lose_factor DECIMAL(3,2) DEFAULT 0.5,
    trust_growth_factor DECIMAL(3,2) DEFAULT 1.0,
    
    -- 情绪表现配置
    emotion_thresholds JSONB DEFAULT '{}',
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(pokemon_species_id)
);
```

### 2. 后端服务实现

#### 心情计算引擎
```javascript
// backend/shared/MoodEngine.js
class MoodEngine {
  constructor(config = {}) {
    this.config = {
      // 心情衰减配置
      happinessDecayRate: 2,    // 每小时快乐度下降
      hungerIncreaseRate: 5,    // 每小时饥饿度上升
      fatigueIncreaseRate: 3,   // 每小时疲劳度上升
      excitementDecayRate: 10,  // 每小时兴奋度下降
      
      // 心情权重配置
      moodWeights: {
        happiness: 0.30,
        hunger: 0.20,      // 反向（越高越差）
        trust: 0.25,
        fatigue: 0.15,     // 反向
        excitement: 0.10
      },
      
      // 状态阈值
      stateThresholds: {
        ecstatic: { min: 85 },
        happy: { min: 70, max: 85 },
        content: { min: 55, max: 70 },
        neutral: { min: 40, max: 55 },
        sad: { min: 25, max: 40 },
        angry: { min: 10, max: 25 },
        sick: { max: 10 }
      }
    };
  }
  
  /**
   * 计算综合心情分数
   */
  calculateOverallMood(moodData) {
    const { happiness, hunger, trust, fatigue, excitement } = moodData;
    
    // 饥饿度和疲劳度是反向指标
    const hungerScore = 100 - hunger;
    const fatigueScore = 100 - fatigue;
    
    // 加权计算
    const overall = (
      happiness * this.config.moodWeights.happiness +
      hungerScore * this.config.moodWeights.hunger +
      trust * this.config.moodWeights.trust +
      fatigueScore * this.config.moodWeights.fatigue +
      excitement * this.config.moodWeights.excitement
    );
    
    return Math.max(0, Math.min(100, overall));
  }
  
  /**
   * 确定心情状态
   */
  determineMoodState(overallMood) {
    const thresholds = this.config.stateThresholds;
    
    if (overallMood >= thresholds.ecstatic.min) return 'ecstatic';
    if (overallMood >= thresholds.happy.min) return 'happy';
    if (overallMood >= thresholds.content.min) return 'content';
    if (overallMood >= thresholds.neutral.min) return 'neutral';
    if (overallMood >= thresholds.sad.min) return 'sad';
    if (overallMood >= thresholds.angry.min) return 'angry';
    return 'sick';
  }
  
  /**
   * 应用时间衰减
   */
  applyTimeDecay(moodData, hoursElapsed) {
    return {
      happiness: Math.max(0, moodData.happiness - (this.config.happinessDecayRate * hoursElapsed)),
      hunger: Math.min(100, moodData.hunger + (this.config.hungerIncreaseRate * hoursElapsed)),
      trust: moodData.trust, // 信任度不随时间衰减
      fatigue: Math.min(100, moodData.fatigue + (this.config.fatigueIncreaseRate * hoursElapsed)),
      excitement: Math.max(0, moodData.excitement - (this.config.excitementDecayRate * hoursElapsed))
    };
  }
  
  /**
   * 应用心情事件
   */
  applyMoodEvent(moodData, eventType, eventData = {}) {
    const deltas = this.calculateMoodDeltas(eventType, eventData);
    
    return {
      happiness: this.clamp(moodData.happiness + deltas.happiness),
      hunger: this.clamp(moodData.hunger + deltas.hunger),
      trust: this.clamp(moodData.trust + deltas.trust),
      fatigue: this.clamp(moodData.fatigue + deltas.fatigue),
      excitement: this.clamp(moodData.excitement + deltas.excitement)
    };
  }
  
  /**
   * 计算心情变化值
   */
  calculateMoodDeltas(eventType, eventData) {
    const eventConfigs = {
      feed: { 
        happiness: 10, 
        hunger: -30, 
        trust: 2,
        fatigue: 0,
        excitement: 5
      },
      play: {
        happiness: 15,
        hunger: 5,
        trust: 5,
        fatigue: 10,
        excitement: 20
      },
      battle_win: {
        happiness: 20,
        hunger: 10,
        trust: 8,
        fatigue: 20,
        excitement: 30
      },
      battle_lose: {
        happiness: -10,
        hunger: 5,
        trust: -2,
        fatigue: 25,
        excitement: -10
      },
      rest: {
        happiness: 5,
        hunger: 10,
        trust: 0,
        fatigue: -40,
        excitement: -15
      },
      item_use: {
        happiness: 15,
        hunger: 0,
        trust: 10,
        fatigue: -5,
        excitement: 10
      },
      evolution: {
        happiness: 30,
        hunger: 0,
        trust: 15,
        fatigue: 0,
        excitement: 50
      },
      trade: {
        happiness: -20,
        hunger: 0,
        trust: -30,
        fatigue: 5,
        excitement: 0
      },
      pet: {
        happiness: 5,
        hunger: 0,
        trust: 3,
        fatigue: 0,
        excitement: 5
      }
    };
    
    const baseDeltas = eventConfigs[eventType] || {
      happiness: 0,
      hunger: 0,
      trust: 0,
      fatigue: 0,
      excitement: 0
    };
    
    // 根据道具质量调整
    if (eventData.quality) {
      const multiplier = eventData.quality; // 0.5 - 2.0
      return {
        happiness: Math.round(baseDeltas.happiness * multiplier),
        hunger: Math.round(baseDeltas.hunger * multiplier),
        trust: Math.round(baseDeltas.trust * multiplier),
        fatigue: Math.round(baseDeltas.fatigue * multiplier),
        excitement: Math.round(baseDeltas.excitement * multiplier)
      };
    }
    
    return baseDeltas;
  }
  
  /**
   * 计算战斗心情加成
   */
  calculateBattleMoodBonus(overallMood) {
    // 心情影响战斗表现
    if (overallMood >= 80) {
      return {
        attackBonus: 0.10,
        defenseBonus: 0.05,
        criticalRateBonus: 0.05,
        evasionBonus: 0.03
      };
    } else if (overallMood >= 60) {
      return {
        attackBonus: 0.05,
        defenseBonus: 0.02,
        criticalRateBonus: 0.02,
        evasionBonus: 0
      };
    } else if (overallMood >= 40) {
      return {
        attackBonus: 0,
        defenseBonus: 0,
        criticalRateBonus: 0,
        evasionBonus: 0
      };
    } else if (overallMood >= 20) {
      return {
        attackBonus: -0.05,
        defenseBonus: -0.03,
        criticalRateBonus: -0.02,
        evasionBonus: -0.02
      };
    } else {
      return {
        attackBonus: -0.10,
        defenseBonus: -0.08,
        criticalRateBonus: -0.05,
        evasionBonus: -0.05
      };
    }
  }
  
  clamp(value, min = 0, max = 100) {
    return Math.max(min, Math.min(max, value));
  }
}

module.exports = MoodEngine;
```

#### 心情服务 API
```javascript
// backend/services/pokemon-service/src/routes/mood.js
const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const MoodEngine = require('../../../shared/MoodEngine');
const { PokemonMood, MoodEventLog } = require('../models');
const { authenticate } = require('../../../shared/auth');
const logger = require('../../../shared/logger');

const moodEngine = new MoodEngine();

/**
 * 获取精灵心情状态
 * GET /api/pokemon/:pokemonId/mood
 */
router.get('/:pokemonId/mood', 
  authenticate,
  [
    param('pokemonId').isInt({ min: 1 }).withMessage('Invalid pokemon ID')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { pokemonId } = req.params;
      const userId = req.user.id;
      
      // 验证所有权
      const pokemon = await PokemonMood.findOne({
        where: { pokemon_id: pokemonId },
        include: [{ model: UserPokemon, where: { user_id: userId } }]
      });
      
      if (!pokemon) {
        return res.status(404).json({ error: 'Pokemon not found' });
      }
      
      // 应用时间衰减
      const hoursElapsed = (Date.now() - new Date(pokemon.last_interaction_at)) / (1000 * 60 * 60);
      const decayedMood = moodEngine.applyTimeDecay(pokemon, hoursElapsed);
      
      // 计算综合心情
      const overallMood = moodEngine.calculateOverallMood(decayedMood);
      const moodState = moodEngine.determineMoodState(overallMood);
      
      // 计算战斗加成
      const battleBonus = moodEngine.calculateBattleMoodBonus(overallMood);
      
      res.json({
        success: true,
        data: {
          ...decayedMood,
          overallMood,
          moodState,
          battleBonus,
          lastInteraction: pokemon.last_interaction_at,
          recommendations: generateMoodRecommendations(decayedMood, moodState)
        }
      });
    } catch (error) {
      logger.error('Failed to get pokemon mood', { error: error.message, pokemonId: req.params.pokemonId });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * 更新精灵心情（喂食、玩耍、休息等）
 * POST /api/pokemon/:pokemonId/mood/action
 */
router.post('/:pokemonId/mood/action',
  authenticate,
  [
    param('pokemonId').isInt({ min: 1 }),
    body('action').isIn(['feed', 'play', 'rest', 'pet', 'item_use']).withMessage('Invalid action'),
    body('item_id').optional().isInt(),
    body('quality').optional().isFloat({ min: 0.5, max: 2.0 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { pokemonId } = req.params;
      const { action, item_id, quality } = req.body;
      const userId = req.user.id;
      
      // 验证所有权并获取当前心情
      const pokemon = await PokemonMood.findOne({
        where: { pokemon_id: pokemonId },
        include: [{ model: UserPokemon, where: { user_id: userId } }]
      });
      
      if (!pokemon) {
        return res.status(404).json({ error: 'Pokemon not found' });
      }
      
      // 应用时间衰减
      const hoursElapsed = (Date.now() - new Date(pokemon.last_interaction_at)) / (1000 * 60 * 60);
      const decayedMood = moodEngine.applyTimeDecay(pokemon, hoursElapsed);
      
      // 应用动作
      const eventData = { quality, item_id };
      const newMood = moodEngine.applyMoodEvent(decayedMood, action, eventData);
      
      // 计算新的综合心情
      const overallMood = moodEngine.calculateOverallMood(newMood);
      const moodState = moodEngine.determineMoodState(overallMood);
      
      // 更新数据库
      await pokemon.update({
        ...newMood,
        overall_mood: overallMood,
        mood_state: moodState,
        last_interaction_at: new Date(),
        [`last_${action}_at`]: new Date(),
        updated_at: new Date()
      });
      
      // 记录心情事件
      const deltas = moodEngine.calculateMoodDeltas(action, eventData);
      await MoodEventLog.create({
        pokemon_id: pokemonId,
        user_id: userId,
        event_type: action,
        event_data: eventData,
        happiness_delta: deltas.happiness,
        hunger_delta: deltas.hunger,
        trust_delta: deltas.trust,
        fatigue_delta: deltas.fatigue,
        excitement_delta: deltas.excitement
      });
      
      // 发布心情变化事件
      await publishMoodEvent(pokemonId, action, newMood);
      
      res.json({
        success: true,
        data: {
          previousMood: decayedMood,
          newMood,
          overallMood,
          moodState,
          deltas
        }
      });
    } catch (error) {
      logger.error('Failed to update pokemon mood', { error: error.message, pokemonId: req.params.pokemonId });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * 获取心情历史记录
 * GET /api/pokemon/:pokemonId/mood/history
 */
router.get('/:pokemonId/mood/history',
  authenticate,
  [
    param('pokemonId').isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 })
  ],
  async (req, res) => {
    try {
      const { pokemonId } = req.params;
      const { limit = 20, offset = 0 } = req.query;
      const userId = req.user.id;
      
      // 验证所有权
      const pokemon = await PokemonMood.findOne({
        where: { pokemon_id: pokemonId },
        include: [{ model: UserPokemon, where: { user_id: userId } }]
      });
      
      if (!pokemon) {
        return res.status(404).json({ error: 'Pokemon not found' });
      }
      
      const history = await MoodEventLog.findAll({
        where: { pokemon_id: pokemonId },
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
      
      res.json({
        success: true,
        data: history,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: await MoodEventLog.count({ where: { pokemon_id: pokemonId } })
        }
      });
    } catch (error) {
      logger.error('Failed to get mood history', { error: error.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * 生成心情改进建议
 */
function generateMoodRecommendations(moodData, moodState) {
  const recommendations = [];
  
  if (moodData.hunger > 70) {
    recommendations.push({
      priority: 'high',
      action: 'feed',
      message: 'Your Pokemon is hungry! Feed it to improve its mood.',
      expectedImprovement: '+30 happiness'
    });
  }
  
  if (moodData.fatigue > 60) {
    recommendations.push({
      priority: 'high',
      action: 'rest',
      message: 'Your Pokemon is tired. Let it rest to recover.',
      expectedImprovement: '-40 fatigue'
    });
  }
  
  if (moodData.happiness < 40) {
    recommendations.push({
      priority: 'medium',
      action: 'play',
      message: 'Your Pokemon seems sad. Play with it to cheer it up!',
      expectedImprovement: '+15 happiness'
    });
  }
  
  if (moodData.trust < 30) {
    recommendations.push({
      priority: 'medium',
      action: 'interact',
      message: 'Your Pokemon needs more bonding time. Interact with it regularly.',
      expectedImprovement: '+5 trust per interaction'
    });
  }
  
  if (moodState === 'sick') {
    recommendations.push({
      priority: 'critical',
      action: 'heal',
      message: 'Your Pokemon is in critical condition! Use healing items immediately.',
      expectedImprovement: 'Restore to healthy state'
    });
  }
  
  return recommendations;
}

/**
 * 发布心情事件到消息队列
 */
async function publishMoodEvent(pokemonId, action, newMood) {
  const { EventBusAdapter } = require('../../../shared/EventBusAdapter');
  const eventBus = new EventBusAdapter();
  
  await eventBus.publish('pokemon.mood.updated', {
    pokemonId,
    action,
    mood: newMood,
    timestamp: new Date().toISOString()
  });
}

module.exports = router;
```

### 3. 前端实现

#### 心情可视化组件
```javascript
// frontend/game-client/src/components/MoodIndicator.js
import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, Animated, Easing } from 'react-native';
import { useTranslation } from 'react-i18next';

const MOOD_STATES = {
  ecstatic: { color: '#FFD700', emoji: '😆', particleColor: '#FFD700' },
  happy: { color: '#4CAF50', emoji: '😊', particleColor: '#4CAF50' },
  content: { color: '#8BC34A', emoji: '🙂', particleColor: '#8BC34A' },
  neutral: { color: '#9E9E9E', emoji: '😐', particleColor: '#9E9E9E' },
  sad: { color: '#5C6BC0', emoji: '😢', particleColor: '#5C6BC0' },
  angry: { color: '#F44336', emoji: '😠', particleColor: '#F44336' },
  sick: { color: '#9C27B0', emoji: '🤢', particleColor: '#9C27B0' }
};

const MoodIndicator = ({ moodData, size = 'medium' }) => {
  const { t } = useTranslation();
  const [pulseAnim] = useState(new Animated.Value(1));
  const [floatAnim] = useState(new Animated.Value(0));
  
  const { overallMood, moodState, happiness, hunger, trust, fatigue, excitement } = moodData;
  const stateConfig = MOOD_STATES[moodState] || MOOD_STATES.neutral;
  
  useEffect(() => {
    // 心情动画效果
    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.1,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        })
      ])
    );
    
    const floatAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: -5,
          duration: 1500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        })
      ])
    );
    
    pulseAnimation.start();
    floatAnimation.start();
    
    return () => {
      pulseAnimation.stop();
      floatAnimation.stop();
    };
  }, []);
  
  const sizeStyles = {
    small: { width: 60, height: 60, fontSize: 12 },
    medium: { width: 80, height: 80, fontSize: 14 },
    large: { width: 120, height: 120, fontSize: 16 }
  };
  
  const currentSize = sizeStyles[size];
  
  return (
    <View style={styles.container}>
      {/* 主心情指示器 */}
      <Animated.View
        style={[
          styles.moodCircle,
          {
            width: currentSize.width,
            height: currentSize.height,
            backgroundColor: stateConfig.color,
            transform: [
              { scale: pulseAnim },
              { translateY: floatAnim }
            ]
          }
        ]}
      >
        <Text style={styles.emoji}>{stateConfig.emoji}</Text>
        <Text style={[styles.moodScore, { fontSize: currentSize.fontSize }]}>
          {Math.round(overallMood)}
        </Text>
      </Animated.View>
      
      {/* 心情维度条 */}
      <View style={styles.dimensionsContainer}>
        <MoodBar
          label={t('mood.happiness')}
          value={happiness}
          color="#FFD700"
          icon="😊"
        />
        <MoodBar
          label={t('mood.hunger')}
          value={100 - hunger}
          color="#FF9800"
          icon="🍖"
          inverse
        />
        <MoodBar
          label={t('mood.trust')}
          value={trust}
          color="#4CAF50"
          icon="🤝"
        />
        <MoodBar
          label={t('mood.energy')}
          value={100 - fatigue}
          color="#2196F3"
          icon="⚡"
          inverse
        />
        <MoodBar
          label={t('mood.excitement')}
          value={excitement}
          color="#E91E63"
          icon="🎉"
        />
      </View>
      
      {/* 状态标签 */}
      <View style={[styles.stateBadge, { backgroundColor: stateConfig.color }]}>
        <Text style={styles.stateText}>
          {t(`mood.states.${moodState}`)}
        </Text>
      </View>
    </View>
  );
};

// 心情进度条组件
const MoodBar = ({ label, value, color, icon, inverse = false }) => {
  const displayValue = inverse ? 100 - value : value;
  
  return (
    <View style={styles.moodBarContainer}>
      <Text style={styles.moodBarIcon}>{icon}</Text>
      <View style={styles.moodBarTrack}>
        <View
          style={[
            styles.moodBarFill,
            {
              width: `${displayValue}%`,
              backgroundColor: color
            }
          ]}
        />
      </View>
      <Text style={styles.moodBarValue}>{Math.round(value)}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: 10
  },
  moodCircle: {
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5
  },
  emoji: {
    fontSize: 24
  },
  moodScore: {
    fontWeight: 'bold',
    color: '#FFF',
    marginTop: 2
  },
  dimensionsContainer: {
    width: '100%',
    marginTop: 15,
    paddingHorizontal: 10
  },
  moodBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8
  },
  moodBarIcon: {
    fontSize: 16,
    width: 25
  },
  moodBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    marginHorizontal: 8,
    overflow: 'hidden'
  },
  moodBarFill: {
    height: '100%',
    borderRadius: 4
  },
  moodBarValue: {
    fontSize: 12,
    fontWeight: 'bold',
    width: 30,
    textAlign: 'right'
  },
  stateBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    marginTop: 10
  },
  stateText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 12
  }
});

export default MoodIndicator;
```

#### 心情交互界面
```javascript
// frontend/game-client/src/screens/PokemonMoodScreen.js
import React, { useState, useEffect, useCallback } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  ScrollView, 
  TouchableOpacity,
  RefreshControl,
  Alert
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, useRoute } from '@react-navigation/native';
import MoodIndicator from '../components/MoodIndicator';
import MoodActionButton from '../components/MoodActionButton';
import MoodHistoryList from '../components/MoodHistoryList';
import { PokemonService } from '../services/PokemonService';
import { useHaptic } from '../hooks/useHaptic';

const PokemonMoodScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const route = useRoute();
  const { pokemonId } = route.params;
  
  const [moodData, setMoodData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(null);
  
  const haptic = useHaptic();
  
  useEffect(() => {
    loadMoodData();
    loadHistory();
  }, [pokemonId]);
  
  const loadMoodData = async () => {
    try {
      const data = await PokemonService.getMood(pokemonId);
      setMoodData(data);
    } catch (error) {
      Alert.alert(t('error'), t('mood.loadError'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  
  const loadHistory = async () => {
    try {
      const data = await PokemonService.getMoodHistory(pokemonId, { limit: 10 });
      setHistory(data);
    } catch (error) {
      console.error('Failed to load mood history:', error);
    }
  };
  
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadMoodData();
    loadHistory();
  }, [pokemonId]);
  
  const handleMoodAction = async (action, params = {}) => {
    if (actionInProgress) return;
    
    setActionInProgress(action);
    haptic.impact('light');
    
    try {
      const result = await PokemonService.performMoodAction(pokemonId, action, params);
      
      haptic.notification('success');
      
      // 更新心情数据
      setMoodData(result.newMood);
      
      // 添加到历史记录
      setHistory(prev => [{
        event_type: action,
        created_at: new Date().toISOString(),
        ...result.deltas
      }, ...prev].slice(0, 10));
      
      // 显示成功反馈
      showActionFeedback(action, result);
      
    } catch (error) {
      haptic.notification('error');
      Alert.alert(t('error'), t(`mood.actionError.${action}`));
    } finally {
      setActionInProgress(null);
    }
  };
  
  const showActionFeedback = (action, result) => {
    // 显示心情变化动画或提示
    const messages = {
      feed: t('mood.feedback.feed'),
      play: t('mood.feedback.play'),
      rest: t('mood.feedback.rest'),
      pet: t('mood.feedback.pet')
    };
    
    // 可以使用 Toast 或其他轻量提示
    console.log(messages[action] || t('mood.feedback.success'));
  };
  
  const actions = [
    { 
      id: 'feed', 
      label: t('mood.actions.feed'), 
      icon: '🍖',
      color: '#FF9800',
      requiresItem: true
    },
    { 
      id: 'play', 
      label: t('mood.actions.play'), 
      icon: '🎾',
      color: '#4CAF50' 
    },
    { 
      id: 'pet', 
      label: t('mood.actions.pet'), 
      icon: '🤚',
      color: '#2196F3' 
    },
    { 
      id: 'rest', 
      label: t('mood.actions.rest'), 
      icon: '💤',
      color: '#9C27B0' 
    }
  ];
  
  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
          />
        }
      >
        {/* 心情指示器 */}
        {moodData && (
          <MoodIndicator moodData={moodData} size="large" />
        )}
        
        {/* 心情建议 */}
        {moodData?.recommendations?.length > 0 && (
          <View style={styles.recommendationsContainer}>
            <Text style={styles.sectionTitle}>{t('mood.recommendations')}</Text>
            {moodData.recommendations.map((rec, index) => (
              <View
                key={index}
                style={[
                  styles.recommendationCard,
                  { borderLeftColor: rec.priority === 'critical' ? '#F44336' : 
                                   rec.priority === 'high' ? '#FF9800' : '#4CAF50' }
                ]}
              >
                <Text style={styles.recommendationText}>{rec.message}</Text>
                <Text style={styles.recommendationImprovement}>
                  {rec.expectedImprovement}
                </Text>
              </View>
            ))}
          </View>
        )}
        
        {/* 心情动作按钮 */}
        <View style={styles.actionsContainer}>
          <Text style={styles.sectionTitle}>{t('mood.actions.title')}</Text>
          <View style={styles.actionsGrid}>
            {actions.map(action => (
              <MoodActionButton
                key={action.id}
                action={action}
                onPress={() => handleMoodAction(action.id)}
                disabled={actionInProgress !== null}
                inProgress={actionInProgress === action.id}
              />
            ))}
          </View>
        </View>
        
        {/* 心情历史 */}
        <View style={styles.historyContainer}>
          <Text style={styles.sectionTitle}>{t('mood.history.title')}</Text>
          <MoodHistoryList history={history} />
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5'
  },
  scrollContent: {
    padding: 16
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 12,
    color: '#333'
  },
  recommendationsContainer: {
    marginBottom: 20
  },
  recommendationCard: {
    backgroundColor: '#FFF',
    padding: 12,
    borderRadius: 8,
    borderLeftWidth: 4,
    marginBottom: 8,
    elevation: 2
  },
  recommendationText: {
    fontSize: 14,
    color: '#333',
    marginBottom: 4
  },
  recommendationImprovement: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic'
  },
  actionsContainer: {
    marginBottom: 20
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between'
  },
  historyContainer: {
    marginBottom: 20
  }
});

export default PokemonMoodScreen;
```

### 4. 心情粒子效果系统

```javascript
// frontend/game-client/src/effects/MoodParticles.js
import ParticleSystem from '../particles/ParticleSystem';

class MoodParticleSystem {
  constructor() {
    this.particleSystem = new ParticleSystem();
    this.emitters = new Map();
  }
  
  /**
   * 创建心情粒子效果
   */
  createMoodParticles(moodState, position) {
    const config = this.getMoodParticleConfig(moodState);
    
    const emitter = this.particleSystem.createEmitter({
      position,
      ...config
    });
    
    this.emitters.set(moodState, emitter);
    
    return emitter;
  }
  
  /**
   * 获取心情粒子配置
   */
  getMoodParticleConfig(moodState) {
    const configs = {
      ecstatic: {
        particleCount: 50,
        emitRate: 30,
        lifetime: { min: 1, max: 2 },
        speed: { min: 50, max: 150 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.5, end: 0 },
        color: ['#FFD700', '#FFA500', '#FF6347'],
        blendMode: 'add',
        gravity: { x: 0, y: -50 },
        shapes: ['star', 'heart', 'sparkle']
      },
      
      happy: {
        particleCount: 30,
        emitRate: 15,
        lifetime: { min: 1, max: 1.5 },
        speed: { min: 30, max: 80 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.4, end: 0 },
        color: ['#4CAF50', '#8BC34A', '#CDDC39'],
        blendMode: 'normal',
        gravity: { x: 0, y: -30 },
        shapes: ['circle', 'heart']
      },
      
      content: {
        particleCount: 15,
        emitRate: 8,
        lifetime: { min: 0.8, max: 1.2 },
        speed: { min: 20, max: 50 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.3, end: 0 },
        color: ['#8BC34A', '#9E9E9E'],
        blendMode: 'normal',
        gravity: { x: 0, y: -20 },
        shapes: ['circle']
      },
      
      neutral: {
        particleCount: 5,
        emitRate: 3,
        lifetime: { min: 0.5, max: 0.8 },
        speed: { min: 10, max: 30 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.2, end: 0 },
        color: ['#9E9E9E'],
        blendMode: 'normal',
        gravity: { x: 0, y: -10 },
        shapes: ['circle']
      },
      
      sad: {
        particleCount: 20,
        emitRate: 10,
        lifetime: { min: 1.5, max: 2.5 },
        speed: { min: 20, max: 40 },
        angle: { min: 160, max: 200 },
        scale: { start: 0.3, end: 0.1 },
        color: ['#5C6BC0', '#3F51B5'],
        blendMode: 'normal',
        gravity: { x: 0, y: 50 },
        shapes: ['teardrop']
      },
      
      angry: {
        particleCount: 40,
        emitRate: 25,
        lifetime: { min: 0.3, max: 0.6 },
        speed: { min: 100, max: 200 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.5, end: 0.2 },
        color: ['#F44336', '#FF5722', '#FF9800'],
        blendMode: 'add',
        gravity: { x: 0, y: 0 },
        shapes: ['cross', 'triangle']
      },
      
      sick: {
        particleCount: 25,
        emitRate: 15,
        lifetime: { min: 1, max: 2 },
        speed: { min: 10, max: 30 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.4, end: 0 },
        color: ['#9C27B0', '#7B1FA2'],
        blendMode: 'normal',
        gravity: { x: 0, y: -15 },
        shapes: ['bubble', 'swirl']
      }
    };
    
    return configs[moodState] || configs.neutral;
  }
  
  /**
   * 停止心情粒子效果
   */
  stopMoodParticles(moodState) {
    const emitter = this.emitters.get(moodState);
    if (emitter) {
      emitter.stop();
      this.emitters.delete(moodState);
    }
  }
  
  /**
   * 更新所有粒子
   */
  update(deltaTime) {
    this.particleSystem.update(deltaTime);
  }
  
  /**
   * 渲染粒子
   */
  render(context) {
    this.particleSystem.render(context);
  }
}

export default MoodParticleSystem;
```

### 5. 定时任务：心情衰减与恢复

```javascript
// backend/jobs/moodDecayJob.js
const cron = require('node-cron');
const { PokemonMood } = require('../services/pokemon-service/src/models');
const MoodEngine = require('../shared/MoodEngine');
const logger = require('../shared/logger');

const moodEngine = new MoodEngine();

/**
 * 每小时执行一次心情衰减任务
 */
const startMoodDecayJob = () => {
  cron.schedule('0 * * * *', async () => {
    logger.info('Starting mood decay job');
    
    try {
      // 批量处理所有精灵的心情衰减
      const batchSize = 1000;
      let offset = 0;
      let processedCount = 0;
      
      while (true) {
        const moods = await PokemonMood.findAll({
          limit: batchSize,
          offset,
          order: [['last_interaction_at', 'ASC']]
        });
        
        if (moods.length === 0) break;
        
        for (const mood of moods) {
          try {
            // 计算时间差
            const hoursElapsed = (Date.now() - new Date(mood.last_interaction_at)) / (1000 * 60 * 60);
            
            if (hoursElapsed >= 1) {
              // 应用时间衰减
              const newMood = moodEngine.applyTimeDecay(mood, Math.floor(hoursElapsed));
              const overallMood = moodEngine.calculateOverallMood(newMood);
              const moodState = moodEngine.determineMoodState(overallMood);
              
              // 更新数据库
              await mood.update({
                ...newMood,
                overall_mood: overallMood,
                mood_state: moodState,
                updated_at: new Date()
              });
              
              processedCount++;
            }
          } catch (error) {
            logger.error('Failed to update mood for pokemon', {
              pokemonId: mood.pokemon_id,
              error: error.message
            });
          }
        }
        
        offset += batchSize;
      }
      
      logger.info(`Mood decay job completed. Processed ${processedCount} pokemon.`);
      
    } catch (error) {
      logger.error('Mood decay job failed', { error: error.message });
    }
  });
  
  logger.info('Mood decay job scheduled (hourly)');
};

/**
 * 每日重置部分心情（恢复机制）
 */
const startMoodRecoveryJob = () => {
  cron.schedule('0 4 * * *', async () => {
    logger.info('Starting daily mood recovery job');
    
    try {
      // 为睡眠中的精灵恢复体力
      const result = await PokemonMood.update(
        {
          fatigue: 0,
          excitement: Math.max(50, sequelize.literal('excitement')),
          updated_at: new Date()
        },
        {
          where: {
            fatigue: { [Op.gt]: 0 }
          }
        }
      );
      
      logger.info(`Daily mood recovery completed. Reset ${result[0]} pokemon.`);
      
    } catch (error) {
      logger.error('Mood recovery job failed', { error: error.message });
    }
  });
  
  logger.info('Mood recovery job scheduled (daily at 4 AM)');
};

module.exports = {
  startMoodDecayJob,
  startMoodRecoveryJob
};
```

## 验收标准

- [ ] **数据模型**
  - [ ] pokemon_mood 表创建成功
  - [ ] mood_event_log 表创建成功
  - [ ] mood_config 表创建成功
  - [ ] 所有约束和索引正常工作

- [ ] **后端 API**
  - [ ] GET /api/pokemon/:id/mood 返回正确的心情数据
  - [ ] POST /api/pokemon/:id/mood/action 正确更新心情
  - [ ] GET /api/pokemon/:id/mood/history 返回历史记录
  - [ ] 时间衰减机制正常工作
  - [ ] 心情计算算法准确
  - [ ] 战斗加成正确应用

- [ ] **前端界面**
  - [ ] 心情指示器正确显示
  - [ ] 心情动画效果流畅
  - [ ] 动作按钮响应正确
  - [ ] 心情历史列表正确渲染
  - [ ] 心情建议显示正确

- [ ] **粒子效果**
  - [ ] 7 种心情状态各有独特粒子效果
  - [ ] 粒子性能优化（FPS ≥ 55）
  - [ ] 粒子效果不影响游戏性能

- [ ] **定时任务**
  - [ ] 小时级心情衰减任务正常运行
  - [ ] 日级心情恢复任务正常运行
  - [ ] 批量处理不影响数据库性能

- [ ] **单元测试**
  - [ ] MoodEngine 单元测试覆盖率 ≥ 90%
  - [ ] API 集成测试覆盖率 ≥ 80%
  - [ ] 边界条件测试通过

- [ ] **性能指标**
  - [ ] 心情查询 API 响应时间 < 50ms
  - [ ] 心情更新 API 响应时间 < 100ms
  - [ ] 批量心情衰减处理 1000 条/秒

- [ ] **国际化**
  - [ ] 心情状态多语言支持
  - [ ] 动作名称多语言支持
  - [ ] 提示消息多语言支持

## 影响范围

### 数据库
- `database/migrations/20260616_033000__add_mood_system.sql` - 新增心情相关表

### 后端服务
- `backend/services/pokemon-service/src/routes/mood.js` - 心情路由
- `backend/services/pokemon-service/src/models/PokemonMood.js` - 心情模型
- `backend/shared/MoodEngine.js` - 心情计算引擎
- `backend/jobs/moodDecayJob.js` - 心情衰减定时任务

### 前端
- `frontend/game-client/src/components/MoodIndicator.js` - 心情指示器组件
- `frontend/game-client/src/screens/PokemonMoodScreen.js` - 心情交互界面
- `frontend/game-client/src/effects/MoodParticles.js` - 心情粒子效果

### 国际化
- `frontend/game-client/src/i18n/en/mood.json` - 英文翻译
- `frontend/game-client/src/i18n/zh/mood.json` - 中文翻译

### 测试
- `backend/tests/unit/MoodEngine.test.js` - 心情引擎单元测试
- `backend/tests/integration/mood.test.js` - 心情API集成测试
- `frontend/game-client/src/__tests__/MoodIndicator.test.js` - 组件测试

## 参考

- [Pokemon-Amie System Analysis](https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9mon-Amie)
- [Game Emotion Systems Design](https://www.gamedeveloper.com/design/designing-emotion-systems-in-games)
- [PostgreSQL JSONB Best Practices](https://www.postgresql.org/docs/current/datatype-json.html)
- [Particle System Optimization](https://developer.mozilla.org/en-US/docs/Games/Techniques/2D_particle_system)
- [React Native Animated API](https://reactnative.dev/docs/animated)
