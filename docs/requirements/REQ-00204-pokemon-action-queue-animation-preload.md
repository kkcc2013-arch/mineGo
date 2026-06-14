# REQ-00204: 精灵动作队列与动画预加载系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00204 |
| 标题 | 精灵动作队列与动画预加载系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、frontend/game-client/src/animation、frontend/game-client/src/game、gateway、pokemon-service |
| 创建时间 | 2026-06-14 17:00 |

## 需求描述

精灵战斗和交互过程中的动画播放存在卡顿和延迟问题，影响用户体验。本需求旨在建立统一的精灵动作队列管理系统，实现动画资源的预加载和智能调度，确保战斗过程的流畅性和响应速度。

### 核心目标
1. 建立统一的动作队列管理器，支持动作排队、优先级插队、动作取消
2. 实现动画资源预加载机制，根据战斗上下文预测性加载可能使用的动画
3. 提供动画资源池管理，支持内存优化和 LRU 淘汰策略
4. 支持动画中断和过渡效果，确保动作切换的自然流畅

## 技术方案

### 1. 动作队列管理器（ActionQueueManager）

```javascript
// frontend/game-client/src/animation/ActionQueueManager.js

class ActionQueueManager {
  constructor(options = {}) {
    this.queue = [];
    this.currentAction = null;
    this.maxQueueSize = options.maxQueueSize || 10;
    this.priorityLevels = {
      IMMEDIATE: 0,    // 立即执行，清空队列
      HIGH: 1,         // 队列头部插入
      NORMAL: 2,       // 正常排队
      LOW: 3           // 低优先级
    };
    this.eventEmitter = new EventEmitter();
  }

  /**
   * 添加动作到队列
   * @param {Object} action - 动作对象
   * @param {string} action.id - 动作唯一标识
   * @param {string} action.type - 动作类型 (attack/skill/item/flee/switch)
   * @param {string} action.pokemonId - 精灵ID
   * @param {string} action.animationKey - 动画资源键
   * @param {number} action.priority - 优先级
   * @param {Object} action.params - 动画参数
   * @param {number} action.duration - 预期持续时间(ms)
   */
  enqueue(action) {
    if (this.queue.length >= this.maxQueueSize) {
      console.warn('[ActionQueue] Queue full, dropping lowest priority action');
      this.dropLowestPriority();
    }

    // 根据优先级插入队列
    if (action.priority === this.priorityLevels.IMMEDIATE) {
      this.queue = [action];
      this.eventEmitter.emit('queue:immediate', action);
    } else {
      const insertIndex = this.findInsertIndex(action.priority);
      this.queue.splice(insertIndex, 0, action);
      this.eventEmitter.emit('queue:enqueue', action);
    }

    // 如果当前没有执行中的动作，开始执行
    if (!this.currentAction) {
      this.processNext();
    }

    return action.id;
  }

  /**
   * 查找优先级插入位置
   */
  findInsertIndex(priority) {
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > priority) {
        return i;
      }
    }
    return this.queue.length;
  }

  /**
   * 处理下一个动作
   */
  async processNext() {
    if (this.queue.length === 0) {
      this.currentAction = null;
      this.eventEmitter.emit('queue:empty');
      return;
    }

    this.currentAction = this.queue.shift();
    this.eventEmitter.emit('action:start', this.currentAction);

    try {
      await this.executeAction(this.currentAction);
    } catch (error) {
      console.error('[ActionQueue] Action execution failed:', error);
      this.eventEmitter.emit('action:error', { action: this.currentAction, error });
    }

    this.eventEmitter.emit('action:complete', this.currentAction);
    
    // 短暂延迟后处理下一个
    setTimeout(() => this.processNext(), 50);
  }

  /**
   * 执行动作
   */
  async executeAction(action) {
    const animator = await AnimationPreloader.getAnimator(action.animationKey);
    if (!animator) {
      throw new Error(`Animation not found: ${action.animationKey}`);
    }

    return new Promise((resolve) => {
      animator.play({
        ...action.params,
        onComplete: () => resolve(),
        onInterrupt: () => resolve() // 允许中断
      });
    });
  }

  /**
   * 取消指定动作
   */
  cancel(actionId) {
    const index = this.queue.findIndex(a => a.id === actionId);
    if (index !== -1) {
      const cancelled = this.queue.splice(index, 1)[0];
      this.eventEmitter.emit('action:cancel', cancelled);
      return true;
    }
    return false;
  }

  /**
   * 清空队列
   */
  clear() {
    this.queue = [];
    this.eventEmitter.emit('queue:clear');
  }

  /**
   * 获取队列状态
   */
  getStatus() {
    return {
      currentAction: this.currentAction,
      queueLength: this.queue.length,
      pendingActions: this.queue.map(a => ({
        id: a.id,
        type: a.type,
        priority: a.priority
      }))
    };
  }
}

export default new ActionQueueManager();
```

### 2. 动画预加载器（AnimationPreloader）

```javascript
// frontend/game-client/src/animation/AnimationPreloader.js

import { LRUCache } from 'lru-cache';

class AnimationPreloader {
  constructor() {
    // 动画资源缓存池
    this.cache = new LRUCache({
      max: 100,              // 最多缓存 100 个动画
      maxSize: 50 * 1024 * 1024, // 最大 50MB
      sizeCalculation: (value) => value.size || 10000,
      ttl: 30 * 60 * 1000,   // 30 分钟过期
      dispose: (value, key) => {
        this.unloadAnimation(key, value);
      }
    });

    // 加载状态跟踪
    this.loadingPromises = new Map();
    
    // 预测加载队列
    this.predictQueue = [];

    // 动画配置
    this.animationConfig = new Map();
  }

  /**
   * 初始化动画配置
   */
  async init() {
    const response = await fetch('/api/v1/pokemon/animations/config');
    const config = await response.json();
    
    config.animations.forEach(anim => {
      this.animationConfig.set(anim.key, {
        key: anim.key,
        url: anim.url,
        type: anim.type, // sprite/spine/3d
        size: anim.estimatedSize,
        preloadPriority: anim.preloadPriority
      });
    });

    // 预加载基础动画
    await this.preloadBasicAnimations();
  }

  /**
   * 预加载基础动画
   */
  async preloadBasicAnimations() {
    const basicKeys = ['idle', 'walk', 'attack_basic', 'damage', 'faint'];
    const pokemonTypes = ['normal', 'fire', 'water', 'grass', 'electric'];
    
    const loadPromises = [];
    basicKeys.forEach(key => {
      pokemonTypes.forEach(type => {
        loadPromises.push(this.preload(`${type}_${key}`));
      });
    });

    await Promise.allSettled(loadPromises);
  }

  /**
   * 预加载动画资源
   */
  async preload(animationKey) {
    // 已缓存，直接返回
    if (this.cache.has(animationKey)) {
      return this.cache.get(animationKey);
    }

    // 正在加载中，返回现有 Promise
    if (this.loadingPromises.has(animationKey)) {
      return this.loadingPromises.get(animationKey);
    }

    const config = this.animationConfig.get(animationKey);
    if (!config) {
      console.warn(`[AnimationPreloader] Unknown animation: ${animationKey}`);
      return null;
    }

    const loadPromise = this.loadAnimationResource(config);
    this.loadingPromises.set(animationKey, loadPromise);

    try {
      const animator = await loadPromise;
      this.cache.set(animationKey, animator);
      return animator;
    } finally {
      this.loadingPromises.delete(animationKey);
    }
  }

  /**
   * 加载动画资源
   */
  async loadAnimationResource(config) {
    switch (config.type) {
      case 'sprite':
        return this.loadSpriteAnimation(config);
      case 'spine':
        return this.loadSpineAnimation(config);
      case '3d':
        return this.load3DAnimation(config);
      default:
        throw new Error(`Unknown animation type: ${config.type}`);
    }
  }

  /**
   * 加载精灵动画
   */
  async loadSpriteAnimation(config) {
    const spritesheet = await this.loadImage(config.url);
    const frameData = await fetch(config.url.replace('.png', '.json')).then(r => r.json());
    
    return {
      type: 'sprite',
      spritesheet,
      frameData,
      size: config.size,
      play: (options) => this.playSpriteAnimation(spritesheet, frameData, options)
    };
  }

  /**
   * 加载 Spine 动画
   */
  async loadSpineAnimation(config) {
    const spineLoader = new SpineLoader();
    const skeleton = await spineLoader.load(config.url);
    
    return {
      type: 'spine',
      skeleton,
      size: config.size,
      play: (options) => this.playSpineAnimation(skeleton, options)
    };
  }

  /**
   * 预测性加载 - 根据战斗上下文预测可能需要的动画
   */
  predictAndPreload(context) {
    const predictions = [];

    // 基于当前精灵技能预测
    if (context.activePokemon?.skills) {
      context.activePokemon.skills.forEach(skill => {
        predictions.push(`${context.activePokemon.type}_${skill.animationKey}`);
      });
    }

    // 基于对手精灵预测反击动画
    if (context.opponentPokemon) {
      predictions.push(`${context.opponentPokemon.type}_attack_basic`);
      predictions.push(`${context.opponentPokemon.type}_skill_1`);
    }

    // 基于战斗阶段预测
    if (context.battlePhase === 'critical') {
      predictions.push('heal_animation');
      predictions.push('revive_animation');
    }

    // 异步预加载预测的动画
    predictions.forEach(key => {
      if (!this.cache.has(key)) {
        this.preload(key).catch(() => {
          // 静默失败，预测性加载不阻塞主流程
        });
      }
    });
  }

  /**
   * 获取动画器
   */
  getAnimator(animationKey) {
    return this.cache.get(animationKey) || null;
  }

  /**
   * 卸载动画资源
   */
  unloadAnimation(key, animator) {
    if (animator.spritesheet) {
      URL.revokeObjectURL(animator.spritesheet.src);
    }
    console.log(`[AnimationPreloader] Unloaded: ${key}`);
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      calculatedSize: this.cache.calculatedSize,
      keys: Array.from(this.cache.keys())
    };
  }
}

export default new AnimationPreloader();
```

### 3. 战斗动画集成器

```javascript
// frontend/game-client/src/game/BattleAnimationIntegrator.js

import ActionQueueManager from '../animation/ActionQueueManager';
import AnimationPreloader from '../animation/AnimationPreloader';

class BattleAnimationIntegrator {
  constructor(battleEngine) {
    this.battleEngine = battleEngine;
    this.setupEventListeners();
  }

  setupEventListeners() {
    // 监听战斗事件，自动入队动画
    this.battleEngine.on('battle:turn', (turnData) => {
      this.handleBattleTurn(turnData);
    });

    this.battleEngine.on('battle:skill', (skillData) => {
      this.handleSkillUse(skillData);
    });

    this.battleEngine.on('battle:damage', (damageData) => {
      this.handleDamage(damageData);
    });

    // 监听队列事件
    ActionQueueManager.on('action:complete', (action) => {
      this.onActionComplete(action);
    });
  }

  /**
   * 处理战斗回合开始
   */
  async handleBattleTurn(turnData) {
    // 预测性加载本轮可能使用的动画
    AnimationPreloader.predictAndPreload({
      activePokemon: turnData.playerPokemon,
      opponentPokemon: turnData.opponentPokemon,
      battlePhase: turnData.phase
    });
  }

  /**
   * 处理技能使用
   */
  handleSkillUse(skillData) {
    const animationKey = `${skillData.pokemon.type}_${skillData.skill.animationKey}`;
    
    ActionQueueManager.enqueue({
      id: `skill_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'skill',
      pokemonId: skillData.pokemon.id,
      animationKey,
      priority: 2, // NORMAL
      params: {
        target: skillData.target,
        power: skillData.skill.power,
        effects: skillData.skill.effects
      },
      duration: skillData.skill.animationDuration || 1000
    });
  }

  /**
   * 处理伤害动画
   */
  handleDamage(damageData) {
    // 伤害动画可以低优先级排队
    ActionQueueManager.enqueue({
      id: `damage_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'damage',
      pokemonId: damageData.targetId,
      animationKey: 'damage_effect',
      priority: 3, // LOW
      params: {
        damage: damageData.amount,
        critical: damageData.critical
      },
      duration: 300
    });
  }

  /**
   * 动作完成回调
   */
  onActionComplete(action) {
    // 通知战斗引擎动画播放完成
    this.battleEngine.emit('animation:complete', {
      actionId: action.id,
      type: action.type,
      pokemonId: action.pokemonId
    });
  }

  /**
   * 紧急中断当前动画
   */
  interruptCurrent() {
    if (ActionQueueManager.currentAction) {
      ActionQueueManager.clear();
      ActionQueueManager.enqueue({
        id: 'interrupt',
        type: 'interrupt',
        priority: 0, // IMMEDIATE
        animationKey: 'interrupt_flash',
        duration: 200
      });
    }
  }
}

export default BattleAnimationIntegrator;
```

### 4. 动画配置 API

```javascript
// backend/services/pokemon-service/src/routes/animations.js

const express = require('express');
const router = express.Router();

/**
 * GET /api/v1/pokemon/animations/config
 * 获取所有精灵动画配置
 */
router.get('/config', async (req, res) => {
  try {
    const config = await AnimationConfigService.getAll();
    
    res.json({
      animations: config.map(anim => ({
        key: anim.key,
        url: anim.url,
        type: anim.type,
        estimatedSize: anim.size,
        preloadPriority: anim.preloadPriority
      })),
      version: await AnimationConfigService.getVersion(),
      cdnBase: process.env.CDN_BASE_URL
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load animation config' });
  }
});

/**
 * GET /api/v1/pokemon/animations/pokemon/:pokemonType
 * 获取指定类型精灵的所有动画
 */
router.get('/pokemon/:pokemonType', async (req, res) => {
  const { pokemonType } = req.params;
  
  try {
    const animations = await AnimationConfigService.getByPokemonType(pokemonType);
    res.json({ animations });
  } catch (error) {
    res.status(404).json({ error: `Unknown pokemon type: ${pokemonType}` });
  }
});

/**
 * POST /api/v1/pokemon/animations/preload-batch
 * 批量预加载动画（返回预签名URL）
 */
router.post('/preload-batch', async (req, res) => {
  const { animationKeys } = req.body;
  
  if (!Array.isArray(animationKeys) || animationKeys.length > 50) {
    return res.status(400).json({ error: 'Invalid animationKeys' });
  }

  try {
    const urls = await AnimationConfigService.getPresignedUrls(animationKeys);
    res.json({ urls });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate preload URLs' });
  }
});

module.exports = router;
```

### 5. 数据库迁移

```sql
-- database/migrations/050_create_animation_config.sql

-- 动画配置表
CREATE TABLE animation_configs (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) NOT NULL UNIQUE,
    pokemon_type VARCHAR(50) NOT NULL,
    animation_type VARCHAR(20) NOT NULL, -- sprite/spine/3d
    url VARCHAR(500) NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    preload_priority INTEGER DEFAULT 2,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_animation_configs_pokemon_type ON animation_configs(pokemon_type);
CREATE INDEX idx_animation_configs_preload_priority ON animation_configs(preload_priority);

-- 动画使用统计表
CREATE TABLE animation_usage_stats (
    id SERIAL PRIMARY KEY,
    animation_key VARCHAR(255) NOT NULL,
    play_count INTEGER DEFAULT 0,
    avg_play_duration INTEGER DEFAULT 0,
    last_played_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_animation_usage_stats_key ON animation_usage_stats(animation_key);
```

## 验收标准

- [ ] 动作队列支持优先级排队、插队、取消操作
- [ ] 预加载器支持 LRU 缓存，最大 50MB 内存限制
- [ ] 战斗场景动画预加载命中率 ≥ 80%
- [ ] 动画播放延迟 < 100ms（命中缓存）
- [ ] 支持动画中断和紧急插队
- [ ] 缓存命中率监控指标上报到 Prometheus
- [ ] 单元测试覆盖 ActionQueueManager 和 AnimationPreloader
- [ ] 集成测试验证战斗动画流程

## 影响范围

- `frontend/game-client/src/animation/` - 新增动画管理模块
- `frontend/game-client/src/game/BattleAnimationIntegrator.js` - 战斗动画集成
- `backend/services/pokemon-service/src/routes/animations.js` - 动画配置 API
- `database/migrations/050_create_animation_config.sql` - 数据库迁移
- `gateway/src/middleware/cache.js` - 动画配置缓存策略

## 参考

- [PixiJS Animation System](https://pixijs.download/release/docs/scene.AnimatedSprite.html)
- [Spine Runtime Documentation](http://esotericsoftware.com/spine-runtime-reference)
- [LRU Cache npm package](https://www.npmjs.com/package/lru-cache)
- [Web Animation API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API)
