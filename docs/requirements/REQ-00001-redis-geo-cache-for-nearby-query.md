# REQ-00001：附近精灵查询 Redis GEO 缓存层

- **编号**：REQ-00001
- **类别**：性能优化
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：location-service、shared/redis.js
- **创建时间**：2026-06-04 15:11
- **依赖需求**：无

## 1. 背景与问题

当前 `location-service` 的 `/map/nearby` 接口直接查询 PostgreSQL + PostGIS 获取附近精灵数据。代码分析：

```javascript
async function getNearbyWild(lat, lng, radius) {
  const { rows } = await query(`
    SELECT w.id, w.species_id, w.lat, w.lng, w.cp, ...
    FROM wild_pokemon w
    JOIN pokemon_species p ON p.id = w.species_id
    WHERE w.is_caught = false
      AND w.expires_at > NOW()
      AND ST_DWithin(w.location::geography, ..., $3)
    ORDER BY w.expires_at DESC
    LIMIT 50
  `, [lat, lng, radius]);
  return rows;
}
```

**问题**：
1. 每次请求都执行复杂的 PostGIS 地理查询 + JOIN，延迟约 50-100ms
2. 高频GPS场景下（每5秒一次），单用户每分钟产生12次查询
3. 1000并发用户 = 12000 QPS，DB压力巨大
4. 精灵刷新周期30分钟，数据变化慢，完全可缓存

## 2. 目标

1. 将附近精灵查询延迟从 50-100ms 降至 5-10ms（降低 80%+）
2. 减少数据库 QPS 压力 90%+
3. 支持高并发场景（10000+ QPS）
4. 保持数据一致性（精灵消失/捕捉后及时失效）

## 3. 范围

- **包含**：
  - 使用 Redis GEO 数据结构缓存活跃精灵位置
  - 实现缓存查询逻辑（GEORADIUS + 批量获取详情）
  - 实现缓存更新逻辑（精灵刷新时写入，捕捉/消失时删除）
  - 添加缓存命中率监控指标
  
- **不包含**：
  - Pokestop 和 Gym 的缓存（另立需求）
  - 分布式缓存一致性方案（单 Redis 实例足够）
  - 客户端缓存

## 4. 详细需求

### 4.1 Redis GEO 缓存结构

```
Key: geo:wild_pokemon
Members: wild_pokemon.id
Scores: longitude, latitude (GEO格式)
```

详情缓存：
```
Key: wild:{wild_pokemon_id}
Value: {
  id, species_id, lat, lng, cp, is_shiny, 
  weather_boosted, expires_at, name_zh, rarity
}
TTL: 1800s (30分钟)
```

### 4.2 查询流程

```javascript
async function getNearbyWild(lat, lng, radius) {
  // 1. 从 Redis GEO 查询附近精灵ID
  const ids = await geoRadius('geo:wild_pokemon', lng, lat, radius, 'm');
  
  // 2. 批量获取详情
  const cached = await Promise.all(ids.map(id => getJSON(`wild:${id}`)));
  
  // 3. 过滤过期/已捕捉
  const valid = cached.filter(w => w && w.expires_at > Date.now());
  
  // 4. 缓存未命中时回源DB
  if (valid.length < ids.length * 0.8) {
    // 回源并重建缓存
    return await fetchFromDBAndCache(lat, lng, radius);
  }
  
  return valid;
}
```

### 4.3 缓存更新时机

1. **写入**：`spawnPokemonForPoint()` 创建精灵时，同时写入 GEO 和详情缓存
2. **删除**：
   - `catch-service` 捕捉成功后，调用 location-service API 删除缓存
   - 精灵过期时，依赖 TTL 自动清理 + 定期清理任务

### 4.4 监控指标

```
- location_nearby_cache_hit_rate
- location_nearby_cache_latency_ms
- location_nearby_db_fallback_count
```

## 5. 验收标准（可测试）

- [ ] 附近精灵查询 P95 延迟 < 15ms（压测 1000 QPS）
- [ ] 缓存命中率 > 95%（正常游戏场景）
- [ ] 精灵被捕捉后，缓存立即失效（3秒内不可见）
- [ ] 精灵刷新后，缓存立即可用
- [ ] 缓存服务不可用时，自动降级到 DB 查询
- [ ] 添加单元测试覆盖缓存逻辑

## 6. 工作量估算

**M（中等）**

理由：
- 核心逻辑约 100-150 行代码
- 需要修改 location-service 和 catch-service
- 需要添加缓存失效机制
- 测试用例编写

## 7. 优先级理由

**P0（最高优先级）**

理由：
1. 性能瓶颈直接影响用户体验（地图卡顿）
2. 影响 DB 稳定性（高并发下可能拖垮数据库）
3. 解决成本低、收益高（典型高 ROI 优化）
4. 是其他性能优化的基础（后续可扩展到 Pokestop/Gym）
