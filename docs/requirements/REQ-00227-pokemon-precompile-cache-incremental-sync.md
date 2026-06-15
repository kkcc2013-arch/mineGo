# REQ-00227：精灵数据预编译缓存与增量同步系统

- **编号**：REQ-00227
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、gateway、backend/shared/PokemonPrecompileCache.js、game-client、Redis、database/migrations
- **创建时间**：2026-06-15 18:05
- **依赖需求**：REQ-00031（API 响应缓存层）、REQ-00039（热点数据缓存预热）

## 1. 背景与问题

当前精灵数据查询存在以下性能瓶颈：

1. **重复计算开销**：每次查询精灵详情时，都需要实时计算 CP/HP/战斗力等衍生属性（基于个体值、等级、技能），这些计算在大量并发请求时消耗显著 CPU 资源。

2. **多表关联查询延迟**：精灵详情涉及 `pokemon`、`pokemon_skills`、`pokemon_stats`、`pokemon_abilities` 等多张表，N+1 查询问题在列表场景尤为突出。

3. **缓存粒度过粗**：现有缓存层以完整精灵对象为粒度，当精灵属性局部变更（如仅升级、学习新技能）时，需要使整个缓存失效，导致缓存命中率下降。

4. **前端数据同步开销**：game-client 每次启动或切换场景时，都需要拉取完整的精灵数据列表，网络开销大且响应慢。

## 2. 目标

- 将精灵衍生属性（CP、战斗力、属性克制系数等）预编译并缓存，减少实时计算开销
- 实现增量同步机制，精灵局部变更只推送变更部分，减少网络传输
- 提升精灵列表查询性能 50% 以上（P95 < 100ms）
- 缓存命中率提升至 90%+

## 3. 范围

- **包含**：
  - 精灵衍生属性预编译服务
  - 增量变更追踪与推送机制
  - 前端增量同步 SDK
  - 缓存版本管理与失效策略
  - 性能监控指标

- **不包含**：
  - 精灵 3D 模型资源预加载（已在 REQ-00027 实现）
  - 战斗中的实时属性计算（属于战斗系统逻辑）
  - 跨区域数据同步（属于 REQ-00041 多区域容灾）

## 4. 详细需求

### 4.1 精灵预编译属性服务

```javascript
// backend/shared/PokemonPrecompileCache.js
class PokemonPrecompileCache {
  // 预编译属性列表
  static PRECOMPILE_FIELDS = [
    'cp',           // 战斗力
    'maxHp',        // 最大 HP
    'combatPower',  // 综合战力
    'typeEffectiveness', // 属性克制系数
    'skillDps',     // 技能 DPS 预计算
    'evolutionReady' // 进化就绪状态
  ];

  // 编译单个精灵
  async precompile(pokemonId) { ... }
  
  // 批量编译（启动时预热）
  async precompileBatch(pokemonIds) { ... }
  
  // 增量更新
  async updateField(pokemonId, field, value) { ... }
}
```

### 4.2 增量变更追踪

```javascript
// 数据库迁移：增加版本追踪字段
ALTER TABLE pokemon ADD COLUMN data_version BIGINT DEFAULT 1;
ALTER TABLE pokemon ADD COLUMN precompiled_at TIMESTAMP;
ALTER TABLE pokemon ADD COLUMN fields_checksum VARCHAR(64);

// 变更日志表
CREATE TABLE pokemon_change_log (
  id SERIAL PRIMARY KEY,
  pokemon_id INT NOT NULL,
  changed_fields JSONB NOT NULL,
  old_values JSONB,
  new_values JSONB,
  version BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4.3 增量同步 API

```
GET /api/pokemon/sync?since_version={version}&pokemon_ids={ids}

Response:
{
  "version": 1234567890,
  "changes": [
    {
      "pokemon_id": 42,
      "fields": ["level", "exp"],
      "values": { "level": 25, "exp": 15000 }
    }
  ],
  "deleted": [101, 102],
  "added": [201]
}
```

### 4.4 前端增量同步 SDK

```javascript
// game-client/src/api/PokemonSyncManager.js
class PokemonSyncManager {
  constructor() {
    this.localVersion = this.loadVersion();
    this.cache = new Map();
  }

  async sync() {
    const changes = await api.get(`/pokemon/sync?since_version=${this.localVersion}`);
    this.applyChanges(changes);
    this.localVersion = changes.version;
    this.saveVersion();
  }

  applyChanges(changes) {
    for (const change of changes.changes) {
      const cached = this.cache.get(change.pokemon_id) || {};
      Object.assign(cached, change.values);
      this.cache.set(change.pokemon_id, cached);
    }
    // 处理删除和新增...
  }
}
```

### 4.5 缓存失效策略

- **字段级失效**：单个字段变更只更新对应缓存键
- **版本号机制**：使用单调递增版本号追踪变更
- **TTL 分层**：
  - 预编译属性：24 小时
  - 增量同步版本：7 天
  - 完整数据：1 小时

### 4.6 性能监控

```javascript
// 新增 Prometheus 指标
pokemon_precompile_duration_seconds
pokemon_cache_hit_ratio
pokemon_incremental_sync_bytes
pokemon_sync_latency_seconds
```

## 5. 验收标准

- [ ] 精灵列表查询 P95 延迟 < 100ms（当前约 200ms）
- [ ] 预编译属性缓存命中率 ≥ 90%
- [ ] 增量同步减少网络传输量 ≥ 70%
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 压力测试：1000 QPS 下系统稳定运行
- [ ] 文档：增量同步 API 文档、前端 SDK 使用指南

## 6. 工作量估算

**L（Large）**

理由：
- 涉及数据库 schema 变更、新增预编译服务、前端 SDK
- 需要仔细设计增量同步协议
- 需要大量测试验证缓存一致性

## 7. 优先级理由

P1 优先级：精灵查询是最核心的高频操作，优化该路径能显著提升用户体验和系统容量。预编译缓存与增量同步是业界成熟方案，风险可控，收益明确。
