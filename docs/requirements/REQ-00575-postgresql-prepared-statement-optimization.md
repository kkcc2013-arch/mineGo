# REQ-00575：PostgreSQL 预编译语句优化

- **编号**：REQ-00575
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：shared/db.js, location-service, catch-service, gym-service
- **创建时间**：2026-07-16 16:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 后端使用 `shared/db.js` 作为数据库访问层，通过 `pg` 连接池管理 PostgreSQL 连接。在高频查询场景下存在以下性能问题：

1. **重复 SQL 解析开销**：每次查询都经过解析、规划、执行全流程，特别是 PostGIS 空间查询（如 `getNearbyWild` 中的 `ST_DWithin`），每秒执行数百次。
2. **缺乏预编译支持**：当前 `query()` 函数直接执行原始 SQL，未利用 PostgreSQL 的 prepared statement 机制。
3. **计划缓存缺失**：相同的查询模板每次都需要重新生成执行计划，浪费 CPU 资源。

经代码分析，以下高频查询场景适合预编译：
- `location-service`：`getNearbyWild`（获取附近野怪）、`getNearbyGyms`（获取附近道馆）
- `catch-service`：捕捉成功后的数据插入和更新
- `gym-service`：道馆战斗查询

## 2. 目标

引入 PostgreSQL Prepared Statement 机制，实现高频查询模板的预编译，达到：
- 减少 30%+ 的数据库 CPU 消耗（针对高频查询）
- 降低查询延迟 15-25ms（预热后）
- 提升系统整体吞吐量

## 3. 范围

- **包含**：
  - 扩展 `shared/db.js` 添加预编译语句支持
  - 提供命名 prepared statement 注册和执行 API
  - 在 3 个高频场景实施预编译（location/catch/gym）
  - 添加预编译语句性能监控指标
  - 服务启动时预热关键查询

- **不包含**：
  - 一次性/低频查询的预编译
  - 复杂动态 SQL 的预编译（条件不固定）
  - 其他服务的全面改造（后续迭代）

## 4. 详细需求

### 4.1 共享数据库层扩展

**文件**：`backend/shared/db.js`

新增预编译管理模块：

```javascript
// shared/preparedStatements.js
const PREPARED_STATEMENTS = {
  // location-service: 获取附近野怪
  getNearbyWild: {
    name: 'get_nearby_wild',
    text: `
      SELECT w.id, w.species_id, w.lat, w.lng, w.cp,
             w.is_shiny, w.weather_boosted, w.expires_at,
             p.name_zh, p.name_en, p.type1, p.type2, p.rarity, p.sprite_url
      FROM wild_pokemon w
      JOIN pokemon_species p ON p.id = w.species_id
      WHERE w.is_caught = false
        AND w.expires_at > NOW()
        AND ST_DWithin(
          w.location::geography,
          ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
          $3
        )
      ORDER BY w.expires_at DESC
      LIMIT 50
    `,
    paramTypes: ['float8', 'float8', 'float8']
  },
  
  // catch-service: 插入捕捉记录
  insertPokemonInstance: {
    name: 'insert_pokemon_instance',
    text: `
      INSERT INTO pokemon_instances
        (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp,
         is_shiny, is_lucky, is_zero_iv, is_perfect_iv, caught_lat, caught_lng, fast_move, charge_move,
         learned_fast_moves, learned_charge_moves)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,false,$9,$10,
             (SELECT last_lat FROM users WHERE id=$1),
             (SELECT last_lng FROM users WHERE id=$1),
             $11, $12, ARRAY[$11], ARRAY[$12])
      RETURNING id
    `
  },
  
  // gym-service: 获取附近道馆
  getNearbyGyms: {
    name: 'get_nearby_gyms',
    text: `
      SELECT g.id, g.name, g.lat, g.lng, g.team, g.prestige,
             g.slots_available, g.ex_raid_eligible
      FROM gyms g
      WHERE ST_DWithin(
        g.location::geography,
        ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
        $3
      )
      ORDER BY ST_Distance(
        g.location::geography,
        ST_SetSRID(ST_MakePoint($2,$1),4326)::geography
      )
      LIMIT 50
    `
  }
};
```

### 4.2 API 设计

**新增函数签名**：

```javascript
/**
 * 执行预编译查询
 * @param {string} name - 预编译语句名称
 * @param {Array} params - 参数数组
 * @returns {Promise<Object>} 查询结果
 */
async function preparedQuery(name, params) { ... }

/**
 * 预热指定预编译语句（服务启动时调用）
 * @param {string} name - 预编译语句名称
 */
async function warmupStatement(name) { ... }

/**
 * 获取预编译语句性能统计
 */
function getStatementStats() { ... }
```

### 4.3 监控指标

在 Prometheus metrics 中新增：

```
db_prepared_query_duration_seconds{statement="<name>", service="<service>"}
db_prepared_query_count{statement="<name>", service="<service>"}
db_prepared_warmup_count{service="<service>"}
```

### 4.4 实施要点

1. **语句命名规范**：使用 `snake_case` 命名，如 `get_nearby_wild`
2. **参数类型声明**：为 PostGIS 查询提供明确的参数类型，优化执行计划
3. **连接级缓存**：prepared statement 在连接级别缓存，连接释放后自动清理
4. **错误处理**：语句不存在时自动降级为普通查询
5. **预热机制**：服务启动时对关键语句执行空查询以预热

### 4.5 使用示例

```javascript
// 原代码
const { rows } = await query(`
  SELECT ... FROM wild_pokemon WHERE ...
`, [lat, lng, radius]);

// 新代码（预编译）
const { rows } = await preparedQuery('get_nearby_wild', [lat, lng, radius]);
```

## 5. 验收标准（可测试）

- [ ] `preparedQuery()` 函数在 `shared/db.js` 中可用
- [ ] location-service 的 `getNearbyWild()` 使用预编译查询
- [ ] catch-service 的捕捉成功流程使用预编译插入
- [ ] gym-service 的 `getNearbyGyms()` 使用预编译查询
- [ ] Prometheus 指标正确记录预编译查询耗时
- [ ] 单元测试覆盖预编译功能（成功/失败/降级场景）
- [ ] 压测显示高频查询延迟降低 ≥15ms（预热后）

## 6. 工作量估算

**M（中等）**

- 共享层改造：0.5 天
- 三个服务集成：1 天
- 测试与压测：0.5 天

总计约 2 天。

## 7. 优先级理由

**P1（高优先级）**

1. **性能收益明确**：PostGIS 空间查询高频执行，预编译可直接减少 CPU 消耗
2. **低风险**：对现有代码侵入小，可逐步迁移
3. **基础设施改进**：提升整体数据库层性能，为后续优化打基础
4. **生产可用**：PostgreSQL prepared statement 是成熟特性，稳定可靠