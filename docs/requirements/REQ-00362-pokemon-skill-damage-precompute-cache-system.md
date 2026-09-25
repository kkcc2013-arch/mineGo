# REQ-00362：精灵技能伤害预计算与智能缓存系统

- **编号**：REQ-00362
- **类别**：性能优化
- **优先级**：P1
- **状态**：implemented
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

## 实现记录（2026-09-25）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 属性克制预计算矩阵覆盖全部 18x18 种组合（324 种） | ✅ | `battle/damage.js TYPE_MATRIX`；单测逐项校验 324 项 |
| 相同配置的战斗请求缓存命中率 > 80% | ✅ | 进程内 bench（宿主机 Node 22，10 万次攻击、100 种热门配置 Zipf 分布） L1 命中率 89.1%；CI 冒烟 99.26% |
| 战斗回合 P95 响应时间 < 50ms（压测验证） | ⚠️ | 服务端纯计算单回合 P95 0.015ms（进程内）；规则变更前经网关实测回合接口 P95 12ms（6 回合，非压测）。并发压测 `node scripts/bench-battle.js --battles 20 --concurrency 5` 待运行 |
| 精灵配置变更后，相关缓存在 5 秒内自动失效 | ✅ | 键由精灵实际攻防数值、属性、技能威力/属性组成：强化/进化/换技能后下一次计算立即使用新键（0 秒），旧条目不再被命中（单测「数值变化即换键」）；技能表改动 5 分钟内重新加载，可手动刷新立即生效 |
| 内存缓存占用 < 100MB（10000 条记录） | ✅ | 实测 1 万条 L1 堆增量 5.63MB（node --expose-gc） |
| Redis 缓存 TTL 设置为 1 小时，支持手动刷新 | ✅ | L2 键 `battle:dmg:*` EX 3600（DAMAGE_CACHE_TTL_SEC 可调）；管理员刷新接口与看板按钮 |
| 单元测试覆盖率 > 90% | ⚠️ | damage.js 行覆盖 83%：未覆盖部分为 Redis L2 读写/清理（需要 Redis，由冒烟覆盖）；伤害公式与 L1 路径全覆盖 |

- 入口：gym-service `src/battle/*`（纯逻辑：damage/cooldown/energy/combo/engine/ai/stats/leagueRules/recommendScore/replayFormat/presetRules；持久化与编排：repo/store/session/gym/raid/league/replay/recommend/comboPresets/pokemonEnergy/settle/deps）；路由 `routes/gyms.js`、`routes/gymBattle.js`、`routes/raids.js`、`routes/battleApi.js`（挂 `/battle`）；网关 `backend/gateway/src/index.js`：`/v1/gyms/*`、`/v1/raids/*`、`/v1/battle/*`（鉴权）、公开 `/v1/battle/replays/shared/:code`、WebSocket 升级转发 `/ws/raid`、`/ws/notifications`、`/ws/battle`；`battle/damage.js`、`battle/deps.js`；看板 `admin-dashboard/battle.html`
- 迁移：`database/migrations/20260925_110000__e11_battle_core.sql`（补列/新表/连击链种子/时间列 TIMESTAMPTZ，全部 IF NOT EXISTS）、`20260925_110100__e11_restore_fast_move_power.sql`；复用既有表见各行说明
- 测试：宿主机已运行（纯逻辑，不连服务）：`cd backend && node --test tests/unit/battle-core.test.js tests/unit/battle-features.test.js` → 29/29 通过；`node --test frontend/game-client/tests/unit/battle-client.test.mjs` → 11/11 通过；`node --expose-gc scripts/bench-battle.js --local`（数字见表）。验证方式调整前（2026-09-25 08:39，提交 e022c97）曾在隔离 CI 栈实测：`scripts/smoke-battle.js` 101/101、核心冒烟 37/37、battle-core 16/16。之后的改动（连击熟练度接入、实时天气、连击道具奖励、大师联赛分组、AI 对位口径、迁移时间列段、前端全部）**未运行，待验证**。待运行：`BASE_URL=… DATABASE_URL=… REDIS_URL=… node scripts/smoke-battle.js`（102 项）、`node scripts/bench-battle.js --battles 20 --concurrency 5`；迁移在全新库上执行 `reset-db` 后检查 bootstrap-report 无 20260925_1100xx 失败
- 待验证：bench 经网关的回合 P95；精灵强化后伤害立即变化
