# REQ-00192：精灵战斗伤害预计算与结果缓存系统

- **编号**：REQ-00192
- **类别**：性能优化
- **优先级**：P1
- **状态**：implemented
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

## 实现记录（2026-09-25）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 属性克制系数缓存命中率 ≥ 95% | ✅ | 18×18 矩阵启动时预计算（GO 倍率 1.6/0.625/0.390625），查询全部命中：进程内 bench（宿主机 Node 22，10 万次攻击、100 种热门配置 Zipf 分布） 命中率 100%；技能系数层命中率 100% |
| 技能伤害缓存命中率 ≥ 80% | ✅ | L1 LRU（1 万条）+ Redis L2（TTL 1h，写后批量落盘、新实例启动载入）：进程内 bench（宿主机 Node 22，10 万次攻击、100 种热门配置 Zipf 分布） 89.1%；规则变更前 CI 冒烟中 99.26% |
| 缓存命中时伤害计算延迟 < 5ms | ✅ | 实测命中 P99 0.004ms（最大 6.1ms 为 GC 抖动） |
| 缓存未命中时伤害计算延迟 < 50ms | ✅ | 实测未命中 P99 0.005ms |
| 服务启动缓存预热时间 < 30s | ✅ | 启动时按全部技能 × 种族属性组合 × 天气 × 是否本系预计算：CI 库 13664 个系数 96ms（规则变更前日志），bench 夹具 4ms |
| 缓存失效后自动重建 | ✅ | 内容寻址键（攻防数值/属性/技能威力/天气），数值变化即换键；LRU 淘汰或手动刷新后按需重算；`POST /v1/battle/damage/cache/refresh`（管理员）清 L1/L2 并广播各实例后重新预热 |
| 监控指标正确上报 Prometheus | ✅ | `minego_battle_damage_cache_requests_total{layer,result}`、`minego_battle_damage_calc_seconds`、`minego_battle_damage_cache_entries`（15 秒导出一次） |

- 入口：gym-service `src/battle/*`（纯逻辑：damage/cooldown/energy/combo/engine/ai/stats/leagueRules/recommendScore/replayFormat/presetRules；持久化与编排：repo/store/session/gym/raid/league/replay/recommend/comboPresets/pokemonEnergy/settle/deps）；路由 `routes/gyms.js`、`routes/gymBattle.js`、`routes/raids.js`、`routes/battleApi.js`（挂 `/battle`）；网关 `backend/gateway/src/index.js`：`/v1/gyms/*`、`/v1/raids/*`、`/v1/battle/*`（鉴权）、公开 `/v1/battle/replays/shared/:code`、WebSocket 升级转发 `/ws/raid`、`/ws/notifications`、`/ws/battle`；`battle/damage.js`、`battle/deps.js`（预热/刷新/订阅失效广播）；看板 `admin-dashboard/battle.html`
- 迁移：`database/migrations/20260925_110000__e11_battle_core.sql`（补列/新表/连击链种子/时间列 TIMESTAMPTZ，全部 IF NOT EXISTS）、`20260925_110100__e11_restore_fast_move_power.sql`；复用既有表见各行说明
- 测试：宿主机已运行（纯逻辑，不连服务）：`cd backend && node --test tests/unit/battle-core.test.js tests/unit/battle-features.test.js` → 29/29 通过；`node --test frontend/game-client/tests/unit/battle-client.test.mjs` → 11/11 通过；`node --expose-gc scripts/bench-battle.js --local`（数字见表）。验证方式调整前（2026-09-25 08:39，提交 e022c97）曾在隔离 CI 栈实测：`scripts/smoke-battle.js` 101/101、核心冒烟 37/37、battle-core 16/16。之后的改动（连击熟练度接入、实时天气、连击道具奖励、大师联赛分组、AI 对位口径、迁移时间列段、前端全部）**未运行，待验证**。待运行：`BASE_URL=… DATABASE_URL=… REDIS_URL=… node scripts/smoke-battle.js`（102 项）、`node scripts/bench-battle.js --battles 20 --concurrency 5`；迁移在全新库上执行 `reset-db` 后检查 bootstrap-report 无 20260925_1100xx 失败
- 待验证：服务启动日志 "battle damage cache warmed up" 的耗时；运行一段时间后 /v1/battle/damage/cache/stats 的命中率与 /metrics
