-- database/pending/20260605_170500__add_pokemon_composite_indexes.sql
-- REQ-00020: 精灵列表查询复合索引优化
-- 创建时间: 2026-06-05 17:05
-- 描述: 为 pokemon_instances 表添加复合索引，优化精灵列表查询性能

-- ============================================================================
-- 背景
-- ============================================================================
-- 当前 pokemon_instances 表已有 idx_instances_user 和 idx_instances_cp 两个独立索引，
-- 但 GET /pokemon/my 接口的查询模式为 WHERE user_id=$1 ORDER BY cp DESC，
-- PostgreSQL 优化器无法高效利用现有索引，导致高数据量场景下性能下降。
--
-- 解决方案：创建复合索引 (user_id, cp DESC)，使排序查询可以直接使用索引扫描。

-- ============================================================================
-- 复合索引创建（使用 CONCURRENTLY 避免锁表）
-- ============================================================================

-- 1. 用户精灵列表 CP 排序索引
-- 优化场景: SELECT ... FROM pokemon_instances WHERE user_id = ? ORDER BY cp DESC
-- 预期效果: 消除 filesort，直接使用索引扫描
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_instances_user_cp
  ON pokemon_instances(user_id, cp DESC);

-- 2. 用户精灵列表捕捉时间排序索引
-- 优化场景: SELECT ... FROM pokemon_instances WHERE user_id = ? ORDER BY caught_at DESC
-- 预期效果: 按捕捉时间排序的查询可以直接使用索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_instances_user_caught
  ON pokemon_instances(user_id, caught_at DESC);

-- 3. 按物种查询精灵 CP 排序索引
-- 优化场景: SELECT ... FROM pokemon_instances WHERE species_id = ? ORDER BY cp DESC
-- 预期效果: 图鉴页面查看某物种的精灵时可以使用索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_instances_species_cp
  ON pokemon_instances(species_id, cp DESC);

-- 4. 用户精灵 IV 排序索引
-- 优化场景: SELECT ... WHERE user_id = ? ORDER BY (iv_attack+iv_defense+iv_hp) DESC
-- 使用函数索引（表达式索引）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_instances_user_iv
  ON pokemon_instances(user_id, (iv_attack + iv_defense + iv_hp) DESC);

-- ============================================================================
-- 分析表以更新统计信息
-- ============================================================================
ANALYZE pokemon_instances;

-- ============================================================================
-- 验证查询计划（开发调试用，生产环境可忽略）
-- ============================================================================
-- 验证索引是否被使用:
-- EXPLAIN ANALYZE SELECT * FROM pokemon_instances WHERE user_id = 1 ORDER BY cp DESC LIMIT 30;
-- 应该显示: Index Scan using idx_instances_user_cp on pokemon_instances

-- ============================================================================
-- 索引使用监控建议
-- ============================================================================
-- 定期检查索引使用情况:
-- SELECT schemaname, relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
-- FROM pg_stat_user_indexes
-- WHERE relname = 'pokemon_instances'
-- ORDER BY idx_scan DESC;
--
-- 如果某个索引 idx_scan = 0 且创建时间超过 1 个月，考虑删除。

-- ============================================================================
-- 注意事项
-- ============================================================================
-- 1. CONCURRENTLY 创建索引不会阻塞写入操作，适合生产环境
-- 2. 创建时间取决于数据量，10万条约需 10-30 秒
-- 3. 索引会增加约 10-15% 的存储空间，但查询性能提升显著
-- 4. 写入性能会有轻微影响（约 5%），但查询频率远高于写入，整体收益为正
