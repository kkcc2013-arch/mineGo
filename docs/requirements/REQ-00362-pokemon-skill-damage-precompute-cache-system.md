# REQ-00362：精灵技能伤害预计算与智能缓存系统

- **编号**：REQ-00362
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service、pokemon-service、backend/shared、Redis、game-client
- **创建时间**：2026-06-29 11:00 UTC
- **依赖需求**：REQ-00054（道馆战斗系统）

## 1. 背景与问题

当前战斗系统（`gym-service/src/battleEngine.js`）每次回合都需要实时计算：
- 属性克制倍率（18x18 类型表查表 + 乘法运算）
- 伤害公式计算（攻击/防御/威力/等级/暴击/STAB 多因子运算）
- 状态效果修正（灼伤/麻痹等状态修正）

在高并发场景下（如道馆战、竞技场比赛），大量实时计算会导致：
1. CPU 负载飙升，响应延迟增加
2. 相同配置的战斗重复计算相同结果
3. 战斗回合响应时间不稳定（50-200ms 波动）

## 2. 目标

- 预计算常见战斗配置的伤害结果，缓存命中率 > 80%
- 战斗回合响应时间从 50-200ms 降至 10-50ms（P95）
- 减少战斗服务 CPU 使用率 30%+
- 支持动态失效策略（精灵配置变更时自动刷新缓存）

## 3. 范围

### 包含
- 属性克制预计算矩阵（18x18 类型组合共 324 种）
- 基础伤害公式预计算（技能+精灵配置组合）
- 智能缓存层（Redis + 内存两级缓存）
- 缓存预热机制（战斗开始前预加载）
- 失效策略（精灵变更/技能变更时清除相关缓存）

### 不包含
- 客户端预测计算（未来需求）
- AI 战斗决策优化（属于 REQ-00357）
- 战斗动画性能优化（属于 REQ-00325）

## 4. 详细需求

### 4.1 属性克制预计算矩阵

```javascript
// backend/shared/TypeEffectivenessCache.js
class TypeEffectivenessCache {
  constructor() {
    // 预计算所有 324 种组合
    this.effectivenessMatrix = this._precomputeMatrix();
  }
  
  _precomputeMatrix() {
    const matrix = new Map();
    for (const attackType of POKEMON_TYPES) {
      for (const defendType of POKEMON_TYPES) {
        const key = `${attackType}:${defendType}`;
        matrix.set(key, this._calculate(attackType, defendType));
      }
    }
    return matrix;
  }
  
  get(attackTypes, defendTypes) {
    let multiplier = 1;
    for (const atk of attackTypes) {
      for (const def of defendTypes) {
        multiplier *= this.effectivenessMatrix.get(`${atk}:${def}`) || 1;
      }
    }
    return multiplier;
  }
}
```

### 4.2 基础伤害预计算

```javascript
// backend/shared/DamagePrecomputeService.js
class DamagePrecomputeService {
  constructor(redis) {
    this.redis = redis;
    this.localCache = new LRUCache({ max: 10000, ttl: 3600000 });
  }
  
  // 缓存键: damage:{attackerId}:{skillId}:{defenderId}:{level}
  async getBaseDamage(attackerConfig, skillConfig, defenderConfig) {
    const cacheKey = this._buildKey(attackerConfig, skillConfig, defenderConfig);
    
    // 1. 本地内存缓存（最快）
    const localHit = this.localCache.get(cacheKey);
    if (localHit) return localHit;
    
    // 2. Redis 缓存（次快）
    const redisHit = await this.redis.get(cacheKey);
    if (redisHit) {
      const parsed = JSON.parse(redisHit);
      this.localCache.set(cacheKey, parsed);
      return parsed;
    }
    
    // 3. 计算并缓存
    const damage = this._compute(attackerConfig, skillConfig, defenderConfig);
    await this._cache(cacheKey, damage);
    return damage;
  }
  
  _compute(attacker, skill, defender) {
    // 基础伤害公式
    const baseDamage = ((2 * attacker.level / 5 + 2) * skill.power * 
      (attacker.attack / defender.defense)) / 50 + 2;
    return Math.floor(baseDamage);
  }
}
```

### 4.3 战斗缓存预热

```javascript
// gym-service/src/BattleCacheWarmup.js
class BattleCacheWarmup {
  async warmupBeforeBattle(battleConfig) {
    const { attackerTeam, defenderTeam } = battleConfig;
    const preloadKeys = [];
    
    // 预计算所有可能的对战组合
    for (const attacker of attackerTeam) {
      for (const skill of attacker.skills) {
        for (const defender of defenderTeam) {
          preloadKeys.push(this._buildKey(attacker, skill, defender));
        }
      }
    }
    
    // 批量预热
    await this.damageService.batchPrecompute(preloadKeys);
  }
}
```

### 4.4 缓存失效策略

```javascript
// backend/shared/CacheInvalidationHandler.js
class CacheInvalidationHandler {
  async onPokemonConfigChange(pokemonId) {
    // 清除所有包含该精灵的缓存
    const pattern = `damage:*${pokemonId}*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(keys);
      logger.info(`Invalidated ${keys.length} cache entries for pokemon ${pokemonId}`);
    }
  }
  
  async onSkillChange(skillId) {
    const pattern = `damage:*${skillId}*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(keys);
    }
  }
}
```

### 4.5 API 端点

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/battle/cache/warmup` | 手动触发缓存预热 |
| GET | `/api/v1/battle/cache/stats` | 获取缓存统计信息 |
| POST | `/api/v1/battle/cache/invalidate` | 手动失效缓存 |

## 5. 验收标准（可测试）

- [ ] 属性克制预计算矩阵覆盖全部 18x18 种组合（324 种）
- [ ] 相同配置的战斗请求缓存命中率 > 80%
- [ ] 战斗回合 P95 响应时间 < 50ms（压测验证）
- [ ] 精灵配置变更后，相关缓存在 5 秒内自动失效
- [ ] 内存缓存占用 < 100MB（10000 条记录）
- [ ] Redis 缓存 TTL 设置为 1 小时，支持手动刷新
- [ ] 单元测试覆盖率 > 90%

## 6. 工作量估算

**L（Large）** - 需要：
- 属性克制矩阵预计算服务（2人日）
- 伤害预计算缓存层（3人日）
- 缓存预热与失效机制（2人日）
- 性能测试与优化（2人日）
- 文档与集成测试（1人日）

总计：约 **10 人日**

## 7. 优先级理由

战斗系统是游戏核心玩法，性能直接影响用户体验：
1. P1 优先：高并发场景下的核心性能瓶颈
2. 可量化收益：响应时间降低 70%+
3. 技术可行性：预计算模式成熟，风险可控
4. 依赖 REQ-00054：需要战斗系统基础功能完成后实施
