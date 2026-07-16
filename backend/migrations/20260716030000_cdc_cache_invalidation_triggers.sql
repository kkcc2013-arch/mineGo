-- REQ-00523: 数据库 CDC 缓存失效触发器
-- 为核心表创建触发器，在数据变更时发送 NOTIFY 事件

-- 创建通知函数
CREATE OR REPLACE FUNCTION notify_cache_invalidation()
RETURNS TRIGGER AS $$
DECLARE
    payload JSONB;
    table_name TEXT := TG_TABLE_NAME;
    operation TEXT := TG_OP;
BEGIN
    -- 构建 payload
    payload := jsonb_build_object(
        'table', table_name,
        'operation', operation,
        'timestamp', EXTRACT(EPOCH FROM NOW()) * 1000,
        'data', CASE
            WHEN operation = 'DELETE' THEN jsonb_build_object('old', row_to_json(OLD))
            WHEN operation = 'INSERT' THEN jsonb_build_object('new', row_to_json(NEW))
            ELSE jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW))
        END
    );
    
    -- 发送通知
    PERFORM pg_notify('minego_cdc_events', payload::text);
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 核心表触发器
-- ============================================

-- 用户表
DROP TRIGGER IF EXISTS notify_cache_users ON users;
CREATE TRIGGER notify_cache_users
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 精灵表
DROP TRIGGER IF EXISTS notify_cache_pokemon ON pokemon;
CREATE TRIGGER notify_cache_pokemon
    AFTER INSERT OR UPDATE OR DELETE ON pokemon
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 道馆表
DROP TRIGGER IF EXISTS notify_cache_gyms ON gyms;
CREATE TRIGGER notify_cache_gyms
    AFTER INSERT OR UPDATE OR DELETE ON gyms
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- Raid 表
DROP TRIGGER IF EXISTS notify_cache_raids ON raids;
CREATE TRIGGER notify_cache_raids
    AFTER INSERT OR UPDATE OR DELETE ON raids
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 好友关系表
DROP TRIGGER IF EXISTS notify_cache_friendships ON friendships;
CREATE TRIGGER notify_cache_friendships
    AFTER INSERT OR UPDATE OR DELETE ON friendships
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 用户道具表
DROP TRIGGER IF EXISTS notify_cache_user_items ON user_items;
CREATE TRIGGER notify_cache_user_items
    AFTER INSERT OR UPDATE OR DELETE ON user_items
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 奖励表
DROP TRIGGER IF EXISTS notify_cache_rewards ON rewards;
CREATE TRIGGER notify_cache_rewards
    AFTER INSERT OR UPDATE OR DELETE ON rewards
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 交易表
DROP TRIGGER IF EXISTS notify_cache_trades ON trades;
CREATE TRIGGER notify_cache_trades
    AFTER INSERT OR UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 支付表
DROP TRIGGER IF EXISTS notify_cache_payments ON payments;
CREATE TRIGGER notify_cache_payments
    AFTER INSERT OR UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 活动表
DROP TRIGGER IF EXISTS notify_cache_events ON events;
CREATE TRIGGER notify_cache_events
    AFTER INSERT OR UPDATE OR DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 排行榜表
DROP TRIGGER IF EXISTS notify_cache_leaderboards ON leaderboards;
CREATE TRIGGER notify_cache_leaderboards
    AFTER INSERT OR UPDATE OR DELETE ON leaderboards
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 精灵出生点表
DROP TRIGGER IF EXISTS notify_cache_spawn_points ON pokemon_spawn_points;
CREATE TRIGGER notify_cache_spawn_points
    AFTER INSERT OR UPDATE OR DELETE ON pokemon_spawn_points
    FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- ============================================
-- 批量优化触发器（用于高频写入场景）
-- ============================================

-- 创建批量触发器函数（使用 STATEMENT 级别）
CREATE OR REPLACE FUNCTION notify_cache_invalidation_batch()
RETURNS TRIGGER AS $$
DECLARE
    payload JSONB;
    table_name TEXT := TG_TABLE_NAME;
    operation TEXT := TG_OP;
    records JSONB;
BEGIN
    -- 收集所有变更的记录
    IF operation = 'DELETE' THEN
        SELECT jsonb_agg(row_to_json(OLD)) INTO records FROM OLD;
    ELSIF operation = 'INSERT' THEN
        SELECT jsonb_agg(row_to_json(NEW)) INTO records FROM NEW;
    ELSE
        SELECT jsonb_agg(row_to_json(NEW)) INTO records FROM NEW;
    END IF;
    
    -- 构建批量 payload
    payload := jsonb_build_object(
        'table', table_name,
        'operation', operation,
        'timestamp', EXTRACT(EPOCH FROM NOW()) * 1000,
        'batch', true,
        'records', records
    );
    
    -- 发送通知
    PERFORM pg_notify('minego_cdc_events', payload::text);
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 注释：对于高频表，可以考虑使用 STATEMENT 级别的触发器
-- 例如：
-- CREATE TRIGGER notify_cache_pokemon_batch
--     AFTER INSERT OR UPDATE OR DELETE ON pokemon
--     FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidation_batch();

-- ============================================
-- 权限设置
-- ============================================

-- 确保 postgres 用户有发送通知的权限
-- GRANT USAGE ON SCHEMA public TO postgres;

-- 监听频道权限（需要超级用户权限执行）
-- ALTER SYSTEM SET max_notify_queue_size = '1GB';
-- SELECT pg_reload_conf();

-- ============================================
-- 验证触发器
-- ============================================

-- 测试通知函数
-- SELECT pg_notify('minego_cdc_events', '{"table":"test","operation":"INSERT","data":{"id":1}}');

-- 查看所有触发器
-- SELECT tgname, tgrelid::regclass, tgtype 
-- FROM pg_trigger 
-- WHERE tgname LIKE 'notify_cache%';

-- ============================================
-- 性能监控视图
-- ============================================

-- 创建缓存失效统计视图
CREATE OR REPLACE VIEW cache_invalidation_stats AS
SELECT 
    schemaname,
    relname as table_name,
    n_tup_ins as inserts,
    n_tup_upd as updates,
    n_tup_del as deletes,
    n_live_tup as live_rows,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN (
    'users', 'pokemon', 'gyms', 'raids', 
    'friendships', 'user_items', 'rewards', 
    'trades', 'payments', 'events', 'leaderboards'
)
ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC;

COMMENT ON VIEW cache_invalidation_stats IS 'REQ-00523: CDC 缓存失效统计视图';

-- ============================================
-- 历史记录
-- ============================================

-- 创建失效事件历史表（用于审计和调试）
CREATE TABLE IF NOT EXISTS cache_invalidation_history (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    operation VARCHAR(20) NOT NULL,
    record_id VARCHAR(100),
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_cache_history_table ON cache_invalidation_history(table_name);
CREATE INDEX IF NOT EXISTS idx_cache_history_created ON cache_invalidation_history(created_at DESC);

-- 可选：创建历史记录触发器（谨慎使用，可能产生大量数据）
-- CREATE OR REPLACE FUNCTION log_cache_invalidation()
-- RETURNS TRIGGER AS $$
-- BEGIN
--     INSERT INTO cache_invalidation_history (table_name, operation, payload)
--     VALUES (TG_TABLE_NAME, TG_OP, jsonb_build_object('data', row_to_json(NEW)));
--     RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;

-- 管理员可以查询历史
-- SELECT * FROM cache_invalidation_history ORDER BY created_at DESC LIMIT 100;