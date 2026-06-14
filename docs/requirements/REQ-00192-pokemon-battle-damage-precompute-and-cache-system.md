# REQ-00192：精灵战斗伤害预计算与结果缓存系统

- **编号**：REQ-00192
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service、pokemon-service、backend/shared/DamageCache.js、Redis、game-client
- **创建时间**：2026-06-14 10:35
- **依赖需求**：REQ-00086（精灵特性系统）、REQ-00146（道馆战斗伤害公式）

## 1. 背景与问题

当前道馆战斗和 PVP 对战中，每次攻击都需要实时计算伤害值，涉及：
- 属性克制系数查询（17种属性 × 17种属性 = 289种组合）
- 技能威力与效果修正
- 精灵个体值与等级计算
- 特性与隐藏特性影响
- 天气与环境加成

在高并发战斗场景下（如 Raid Boss 战、公会战），相同的攻击组合被重复计算数千次，造成：
1. CPU 计算资源浪费，战斗服务负载过高
2. 战斗响应延迟增加，影响实时对战体验
3. 数据库频繁查询属性克制表，增加 I/O 压力

## 2. 目标

建立精灵战斗伤害预计算与缓存系统：
- 预计算所有常见战斗场景的伤害结果并缓存
- 实现战斗参数哈希，快速命中缓存
- 缓存命中率目标 ≥ 85%
- 战斗响应延迟降低 60%+

## 3. 范围

- **包含**：
  - 属性克制系数预计算与缓存
  - 技能伤害公式预计算（基于常见等级/个体值组合）
  - 战斗场景缓存键设计与哈希算法
  - 缓存失效策略（技能调整、属性平衡更新时）
  - 缓存预热机制（服务启动时加载）
  - 缓存命中率监控指标

- **不包含**：
  - 新的伤害计算公式设计（使用现有公式）
  - 客户端本地缓存（另需需求）
  - 战斗回放系统

## 4. 详细需求

### 4.1 属性克制预计算

```javascript
// backend/shared/DamageCache.js
class DamageCache {
  // 预计算所有属性组合的克制系数
  async precomputeTypeEffectiveness() {
    // 17种属性 × 17种属性 = 289种组合
    // 存储: type_effectiveness:{attacker_type}:{defender_type} => coefficient
  }
  
  // 获取属性克制系数（优先缓存）
  async getTypeEffectiveness(attackerType, defenderType) {
    // 1. 尝试从 Redis 获取
    // 2. 未命中则查询数据库并缓存
  }
}
```

### 4.2 技能伤害预计算

```javascript
// 预计算常见战斗参数组合的伤害
// 缓存键: damage:{skill_id}:{attacker_level}:{defender_level}:{attacker_type}:{defender_type}
async precomputeSkillDamage(skillId, attackerLevel, defenderLevel, types) {
  // 量化等级范围：1-50（每5级一个区间，共10档）
  // 常见技能：Top 100 使用率技能
  // 预计算组合：100技能 × 10等级档 × 10等级档 × 289类型组合 ≈ 289万条
}
```

### 4.3 战斗场景缓存键设计

```javascript
// 战斗参数哈希函数
function generateBattleCacheKey(params) {
  const { 
    skillId, 
    attackerPokemonId, 
    attackerLevel, 
    attackerIvHash, // 个体值量化哈希（按10分位分组）
    defenderPokemonId, 
    defenderLevel,
    weather, // 天气加成
    terrain  // 地形加成
  } = params;
  
  // 生成确定性哈希键
  return `battle:dmg:${skillId}:${attackerPokemonId}:${quantizeLevel(attackerLevel)}:${defenderPokemonId}:${quantizeLevel(defenderLevel)}:${weather || 'none'}:${terrain || 'none'}`;
}
```

### 4.4 缓存失效策略

```javascript
// 当发生以下情况时清除相关缓存：
// 1. 技能威力调整 → 清除该技能所有缓存
// 2. 属性克制表更新 → 清除所有类型克制缓存
// 3. 特性效果修改 → 清除涉及该特性的缓存
// 4. 游戏版本更新 → 全量清除

async invalidateCache(scope, params) {
  switch(scope) {
    case 'skill':
      await redis.del(`damage:skill:${params.skillId}:*`);
      break;
    case 'type':
      await redis.del('type_effectiveness:*');
      break;
    case 'full':
      await redis.flushdb();
      break;
  }
}
```

### 4.5 缓存预热

```javascript
// 服务启动时预热缓存
async warmupCache() {
  // 1. 加载属性克制表到 Redis
  // 2. 预计算 Top 100 技能的常见伤害值
  // 3. 加载热门精灵（Top 500）的基础属性
  logger.info('Damage cache warmup completed');
}
```

### 4.6 监控指标

```javascript
// Prometheus 指标
const damageCacheHits = new Counter({
  name: 'damage_cache_hits_total',
  help: 'Total damage cache hits',
  labelNames: ['cache_type']
});

const damageCacheMisses = new Counter({
  name: 'damage_cache_misses_total',
  help: 'Total damage cache misses',
  labelNames: ['cache_type']
});

const damageCalculationTime = new Histogram({
  name: 'damage_calculation_duration_seconds',
  help: 'Time spent calculating damage',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
});
```

## 5. 验收标准（可测试）

- [ ] 属性克制系数缓存命中率 ≥ 95%
- [ ] 技能伤害缓存命中率 ≥ 80%
- [ ] 缓存命中时伤害计算延迟 < 5ms
- [ ] 缓存未命中时伤害计算延迟 < 50ms
- [ ] 服务启动缓存预热时间 < 30s
- [ ] 缓存失效后自动重建
- [ ] 监控指标正确上报 Prometheus

## 6. 工作量估算

**M（中等）**：约 3-5 人日
- 缓存系统设计与实现：1人日
- 预计算逻辑开发：1人日
- 缓存失效机制：0.5人日
- 监控指标集成：0.5人日
- 测试与调优：1人日

## 7. 优先级理由

P1 理由：
1. 战斗系统是核心玩法，性能直接影响用户体验
2. 高并发场景（Raid、公会战）下收益显著
3. 实现成本可控，风险低
4. 为后续更复杂的战斗模式（团队战、锦标赛）奠定性能基础
