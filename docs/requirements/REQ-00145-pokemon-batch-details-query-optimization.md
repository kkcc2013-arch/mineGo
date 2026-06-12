# REQ-00145：精灵详情批量查询优化

- **编号**：REQ-00145
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、gateway、game-client、backend/shared
- **创建时间**：2026-06-12 06:10
- **依赖需求**：REQ-00092（API 请求合并与批量查询优化）

## 1. 背景与问题

### 现状分析

当前 `pokemon-service` 的精灵详情查询接口 `GET /pokemon/my/:id` 仅支持单个精灵查询。当玩家在以下场景操作时，会产生大量独立请求：

1. **精灵列表页**：玩家查看精灵列表后，前端需要加载每个精灵的完整详情（技能、IV 分布、进化链等）
2. **战斗准备页**：PVP 对战前需要加载多只精灵的详细属性和技能数据
3. **交换确认页**：交换精灵时需要展示双方多只精灵的完整信息
4. **图鉴详情页**：批量展示多个精灵的进化链和技能学习表

### 性能影响

```
当前模式（N+1 问题）：
GET /pokemon/my/abc123        → 1 次查询
GET /pokemon/my/def456        → 1 次查询
GET /pokemon/my/ghi789        → 1 次查询
...                           → N 次查询
总计：N 次网络请求 + N 次数据库查询
```

**实测数据**（模拟 50 只精灵批量查询）：
- 网络延迟：50 × 50ms = 2500ms（串行）
- 数据库连接：50 次连接获取
- Gateway 开销：50 次鉴权、日志、指标记录

### 问题根源

1. `pokemon-service/src/index.js` 缺少批量查询端点
2. 前端未实现请求合并逻辑
3. 数据库查询未针对批量场景优化

## 2. 目标

实现精灵详情批量查询接口，将 N 次请求合并为 1 次：

```
优化后模式：
POST /pokemon/batch/details
Body: { ids: ["abc123", "def456", "ghi789", ...] }
→ 1 次请求 + 1 次批量数据库查询
```

**预期收益**：
- 网络请求减少 95%（50 → 1）
- 响应时间减少 80%（2500ms → 500ms）
- 数据库连接复用率提升
- Gateway 负载降低

## 3. 范围

### 包含

1. **pokemon-service** 新增批量查询端点 `POST /pokemon/batch/details`
2. **数据库查询优化**：使用 `WHERE id = ANY($1)` 批量查询
3. **关联数据预加载**：批量加载进化链、技能数据、展示配置
4. **前端 SDK 封装**：`game-client` 批量查询工具函数
5. **缓存策略**：Redis 批量读取 + 未命中批量回源

### 不包含

- 其他服务的批量查询（social-service、gym-service）
- WebSocket 实时推送优化
- 图像资源批量加载（已在 REQ-00052 CDN 优化中覆盖）

## 4. 详细需求

### 4.1 API 设计

```http
POST /pokemon/batch/details
Authorization: Bearer <token>
Content-Type: application/json

{
  "ids": ["uuid-1", "uuid-2", "uuid-3"],
  "options": {
    "include_moves": true,
    "include_evolution": true,
    "include_stats": true
  }
}
```

**响应格式**：
```json
{
  "code": 0,
  "data": {
    "results": [
      {
        "id": "uuid-1",
        "species_id": 25,
        "nickname": "皮皮",
        "cp": 2500,
        "iv_attack": 15,
        "iv_defense": 14,
        "iv_hp": 15,
        "moves": { "fast": "Quick Attack", "charge": "Thunderbolt" },
        "evolution": { "can_evolve": true, "candy_cost": 50 },
        ...
      },
      ...
    ],
    "not_found": ["uuid-x"],
    "total": 3,
    "query_time_ms": 45
  }
}
```

### 4.2 数据库批量查询

```sql
-- 批量查询精灵实例
SELECT pi.*, ps.name_zh, ps.type1, ps.type2, ps.sprite_url
FROM pokemon_instances pi
JOIN pokemon_species ps ON ps.id = pi.species_id
WHERE pi.id = ANY($1) AND pi.user_id = $2;

-- 批量查询技能数据
SELECT * FROM pokemon_moves
WHERE pokemon_instance_id = ANY($1);

-- 批量查询进化信息
SELECT species_id, evolves_to, candy_to_evolve
FROM pokemon_species
WHERE id = ANY($1);
```

### 4.3 缓存策略

```javascript
// Redis 批量读取
const cached = await redis.mget(ids.map(id => `pokemon:detail:${id}`));

// 未命中批量回源
const missIds = ids.filter((id, i) => !cached[i]);
if (missIds.length > 0) {
  const fresh = await batchQueryFromDB(missIds);
  await redis.mset(fresh.map(p => [`pokemon:detail:${p.id}`, JSON.stringify(p)]));
}
```

### 4.4 性能约束

- 单次批量查询上限：100 个 ID
- 响应时间目标：< 200ms（50 个 ID）
- 数据库查询次数：≤ 3 次（主表 + 技能 + 进化）

### 4.5 前端 SDK

```javascript
// game-client/src/api/pokemon.js
export async function batchGetPokemonDetails(ids, options = {}) {
  const chunkSize = 50;
  const chunks = chunk(ids, chunkSize);
  
  const results = await Promise.all(
    chunks.map(chunk => 
      fetch('/pokemon/batch/details', {
        method: 'POST',
        body: JSON.stringify({ ids: chunk, options })
      })
    )
  );
  
  return results.flatMap(r => r.results);
}
```

## 5. 验收标准（可测试）

- [ ] `POST /pokemon/batch/details` 端点已实现并可用
- [ ] 批量查询 50 个精灵详情响应时间 < 200ms
- [ ] 单次请求 ID 数量上限 100 个，超出返回 400 错误
- [ ] 数据库查询次数 ≤ 3 次（验证日志）
- [ ] 未授权用户返回 401，非拥有者返回 403
- [ ] 不存在的 ID 返回在 `not_found` 数组中
- [ ] Redis 缓存命中率 > 80%（预热后）
- [ ] 前端 SDK `batchGetPokemonDetails` 函数可用
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

**M（Medium）**

- 后端批量查询端点：2-3 小时
- 数据库查询优化：1-2 小时
- 缓存策略实现：1-2 小时
- 前端 SDK 封装：1 小时
- 单元测试：2 小时

总计：7-10 小时

## 7. 优先级理由

**P1 理由**：

1. **用户体验直接影响**：精灵列表、战斗准备、交换确认等核心功能的响应速度
2. **性能收益显著**：减少 95% 网络请求，80% 响应时间
3. **基础设施复用**：批量查询模式可推广到其他服务
4. **依赖已满足**：REQ-00092 已定义请求合并规范，可直接复用

**非 P0 理由**：功能已有替代方案（串行查询），优化为增强而非阻塞。
