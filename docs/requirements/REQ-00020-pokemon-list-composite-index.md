# REQ-00020：精灵列表查询复合索引优化

- **编号**：REQ-00020
- **类别**：性能优化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：pokemon-service、database/migrations
- **创建时间**：2026-06-05 11:00
- **依赖需求**：无

## 1. 背景与问题

当前 `pokemon_instances` 表已有 `idx_instances_user` 和 `idx_instances_cp` 两个独立索引，但 `GET /pokemon/my` 接口在查询用户精灵列表时使用 `WHERE user_id=$1 ORDER BY cp DESC` 模式：

```sql
SELECT ... FROM pokemon_instances pi
WHERE pi.user_id=$1
ORDER BY pi.cp DESC
LIMIT $n OFFSET $m
```

这种查询模式下，PostgreSQL 优化器只能选择：
1. 使用 `idx_instances_user` 扫描后排序（需要 filesort）
2. 使用 `idx_instances_cp` 扫描并过滤（大量无效扫描）

两个选择在高数据量场景下性能均不理想。当用户精灵数量达到 500+ 时，每次列表查询可能产生 50ms+ 延迟。

类似问题也存在于 `idx_instances_species` 与 `ORDER BY cp DESC` 的组合查询。

## 2. 目标

通过创建复合索引优化精灵列表查询性能，预期收益：
- 用户精灵列表查询延迟降低 70%+
- 排序相关查询的 CPU 消耗降低 50%+
- 为未来百万级精灵数据量做好性能准备

## 3. 范围

- **包含**：
  - 创建 `idx_instances_user_cp` 复合索引（user_id, cp DESC）
  - 创建 `idx_instances_user_caught` 复合索引（user_id, caught_at DESC）
  - 创建 `idx_instances_species_cp` 复合索引（species_id, cp DESC）
  - 使用 `CONCURRENTLY` 创建索引避免锁表
  - 添加数据库迁移文件

- **不包含**：
  - 修改查询语句（索引足够优化）
  - Redis 缓存层（当前优先级不高）
  - 分区表策略（数据量未达阈值）

## 4. 详细需求

### 4.1 复合索引设计

```sql
-- 用户精灵列表排序优化（CP 排序）
CREATE INDEX CONCURRENTLY idx_instances_user_cp 
  ON pokemon_instances(user_id, cp DESC);

-- 用户精灵列表排序优化（捕捉时间排序）
CREATE INDEX CONCURRENTLY idx_instances_user_caught 
  ON pokemon_instances(user_id, caught_at DESC);

-- 按物种查询精灵排序优化
CREATE INDEX CONCURRENTLY idx_instances_species_cp 
  ON pokemon_instances(species_id, cp DESC);
```

### 4.2 迁移文件

创建文件 `database/pending/20260605_110000__add_pokemon_composite_indexes.sql`，内容包含：
- 使用 `IF NOT EXISTS` 确保幂等性
- 使用 `CONCURRENTLY` 避免锁表
- 添加注释说明索引用途

### 4.3 索引维护策略

- 监控索引使用情况（pg_stat_user_indexes）
- 定期执行 `ANALYZE pokemon_instances` 更新统计信息
- 评估旧索引是否需要保留

## 5. 验收标准（可测试）

- [ ] 迁移文件已创建并包含正确的索引定义
- [ ] 使用 `EXPLAIN ANALYZE` 验证查询计划使用新索引
- [ ] 用户精灵列表查询延迟 < 10ms（100 条数据场景）
- [ ] 索引创建时间 < 60 秒（模拟 10 万条数据）
- [ ] 单元测试验证索引存在性

## 6. 工作量估算

**S**（0.5 天）

理由：仅需创建迁移文件，索引创建为 DDL 操作，无需修改应用代码。

## 7. 优先级理由

P1 理由：
- 直接影响核心玩法体验（精灵列表是最频繁的操作之一）
- 性能问题随数据增长会逐渐恶化
- 改动成本低但收益高，属于高性价比优化
