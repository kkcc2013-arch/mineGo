-- database/migrations/20260618_140000__add_image_load_metrics.sql
-- 图片加载性能指标表
-- REQ-00164: 精灵详情页图片懒加载与渐进式加载系统

-- 创建图片加载指标表
CREATE TABLE IF NOT EXISTS image_load_metrics (
    id BIGSERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL,
    user_id VARCHAR(64),
    load_time_ms INTEGER NOT NULL CHECK (load_time_ms >= 0 AND load_time_ms <= 60000),
    was_cached BOOLEAN NOT NULL DEFAULT false,
    device_type VARCHAR(20),
    connection_type VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_image_metrics_created ON image_load_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_metrics_pokemon ON image_load_metrics(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_image_metrics_user ON image_load_metrics(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_image_metrics_device ON image_load_metrics(device_type);
CREATE INDEX IF NOT EXISTS idx_image_metrics_cached ON image_load_metrics(was_cached);

-- 复合索引（用于按时间段查询）
CREATE INDEX IF NOT EXISTS idx_image_metrics_time_range ON image_load_metrics(created_at, pokemon_id);

-- 创建统计视图（按天）
CREATE OR REPLACE VIEW image_load_stats_daily AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_loads,
    AVG(load_time_ms) as avg_load_time,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY load_time_ms) as p90_load_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY load_time_ms) as p99_load_time,
    MIN(load_time_ms) as min_load_time,
    MAX(load_time_ms) as max_load_time,
    SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count,
    COUNT(DISTINCT pokemon_id) as unique_pokemon,
    COUNT(DISTINCT user_id) as unique_users
FROM image_load_metrics
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- 创建统计视图（按小时）
CREATE OR REPLACE VIEW image_load_stats_hourly AS
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    COUNT(*) as total_loads,
    AVG(load_time_ms) as avg_load_time,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
    SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count,
    COUNT(DISTINCT pokemon_id) as unique_pokemon
FROM image_load_metrics
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- 创建按精灵统计视图
CREATE OR REPLACE VIEW image_load_stats_by_pokemon AS
SELECT 
    pokemon_id,
    COUNT(*) as total_loads,
    AVG(load_time_ms) as avg_load_time,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
    SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count,
    MAX(created_at) as last_loaded_at
FROM image_load_metrics
GROUP BY pokemon_id
ORDER BY total_loads DESC;

-- 创建按设备类型统计视图
CREATE OR REPLACE VIEW image_load_stats_by_device AS
SELECT 
    device_type,
    connection_type,
    COUNT(*) as total_loads,
    AVG(load_time_ms) as avg_load_time,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
    SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count
FROM image_load_metrics
GROUP BY device_type, connection_type
ORDER BY total_loads DESC;

-- 清理过期数据的函数（保留 90 天）
CREATE OR REPLACE FUNCTION cleanup_image_metrics()
RETURNS void AS $$
BEGIN
    DELETE FROM image_load_metrics 
    WHERE created_at < NOW() - INTERVAL '90 days';
    
    -- 记录清理日志
    RAISE NOTICE 'Cleaned up image_load_metrics older than 90 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 创建清理定时任务（需要 pg_cron 扩展）
-- 如果 pg_cron 不可用，可以手动调用 cleanup_image_metrics() 函数
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        -- 每天凌晨 3 点执行清理
        PERFORM cron.schedule(
            'cleanup_image_metrics_daily',
            '0 3 * * *',
            'SELECT cleanup_image_metrics()'
        );
        RAISE NOTICE 'Scheduled daily cleanup job for image_load_metrics';
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_cron not available, manual cleanup required';
END;
$$;

-- 添加表注释
COMMENT ON TABLE image_load_metrics IS '图片加载性能指标记录表 - REQ-00164';
COMMENT ON COLUMN image_load_metrics.pokemon_id IS '精灵 ID';
COMMENT ON COLUMN image_load_metrics.user_id IS '用户 ID（可选）';
COMMENT ON COLUMN image_load_metrics.load_time_ms IS '图片加载时间（毫秒）';
COMMENT ON COLUMN image_load_metrics.was_cached IS '是否从缓存加载';
COMMENT ON COLUMN image_load_metrics.device_type IS '设备类型：ios/android/desktop/tablet 等';
COMMENT ON COLUMN image_load_metrics.connection_type IS '网络连接类型：4g/wifi/3g 等';

-- 创建分区表（按月分区，适用于大量数据）
-- 注意：分区表需要额外的配置，这里仅作为参考
-- CREATE TABLE image_load_metrics_y2026m06 PARTITION OF image_load_metrics
--     FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
