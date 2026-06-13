-- REQ-00077: 数据库慢查询分析与自动优化建议系统
-- 迁移: 启用 pg_stat_statements 和创建分析表

-- =====================================================
-- 1. 启用 pg_stat_statements 扩展
-- =====================================================

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- =====================================================
-- 2. 创建慢查询日志表
-- =====================================================

CREATE TABLE IF NOT EXISTS slow_query_log (
    id SERIAL PRIMARY KEY,
    query_id VARCHAR(50),
    query_text TEXT,
    calls BIGINT,
    total_time_ms FLOAT,
    mean_time_ms FLOAT,
    min_time_ms FLOAT,
    max_time_ms FLOAT,
    rows_affected BIGINT,
    shared_blks_hit BIGINT,
    shared_blks_read BIGINT,
    cache_hit_ratio FLOAT,
    collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_slow_query_log_query_id ON slow_query_log(query_id);
CREATE INDEX IF NOT EXISTS idx_slow_query_log_collected_at ON slow_query_log(collected_at);
CREATE INDEX IF NOT EXISTS idx_slow_query_log_mean_time ON slow_query_log(mean_time_ms DESC);

-- =====================================================
-- 3. 创建慢查询历史表
-- =====================================================

CREATE TABLE IF NOT EXISTS slow_query_history (
    id SERIAL PRIMARY KEY,
    query_id BIGINT,
    query_text TEXT,
    mean_time_ms FLOAT,
    total_time_ms FLOAT,
    calls BIGINT,
    rows_returned BIGINT,
    shared_blks_hit BIGINT,
    shared_blks_read BIGINT,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_slow_query_history_query_id (query_id),
    INDEX idx_slow_query_history_recorded_at (recorded_at)
);

-- =====================================================
-- 4. 创建索引建议表
-- =====================================================

CREATE TABLE IF NOT EXISTS index_suggestions (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(255),
    column_name VARCHAR(255),
    suggestion_type VARCHAR(50), -- 'create', 'drop', 'modify'
    reason TEXT,
    priority VARCHAR(20), -- 'low', 'medium', 'high', 'critical'
    estimated_impact TEXT,
    suggested_sql TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    applied BOOLEAN DEFAULT FALSE,
    applied_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_index_suggestions_table ON index_suggestions(table_name);
CREATE INDEX IF NOT EXISTS idx_index_suggestions_applied ON index_suggestions(applied);
CREATE INDEX IF NOT EXISTS idx_index_suggestions_priority ON index_suggestions(priority);

-- =====================================================
-- 5. 创建查询性能基准表
-- =====================================================

CREATE TABLE IF NOT EXISTS query_performance_baseline (
    id SERIAL PRIMARY KEY,
    query_signature VARCHAR(64) UNIQUE,
    query_text TEXT,
    avg_execution_time_ms FLOAT,
    p95_execution_time_ms FLOAT,
    p99_execution_time_ms FLOAT,
    calls_per_hour FLOAT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_query_performance_signature ON query_performance_baseline(query_signature);

-- =====================================================
-- 6. 创建索引使用统计表
-- =====================================================

CREATE TABLE IF NOT EXISTS index_usage_stats (
    id SERIAL PRIMARY KEY,
    schema_name VARCHAR(255),
    table_name VARCHAR(255),
    index_name VARCHAR(255),
    index_scans BIGINT,
    tuples_read BIGINT,
    tuples_fetched BIGINT,
    index_size_bytes BIGINT,
    is_constraint BOOLEAN DEFAULT FALSE,
    last_used_at TIMESTAMP,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_index_usage_stats_table ON index_usage_stats(table_name);
CREATE INDEX IF NOT EXISTS idx_index_usage_stats_scans ON index_usage_stats(index_scans);

-- =====================================================
-- 7. 创建查询分析结果表
-- =====================================================

CREATE TABLE IF NOT EXISTS query_analysis_results (
    id SERIAL PRIMARY KEY,
    query_id VARCHAR(50),
    query_text TEXT,
    issues JSONB, -- 存储检测到的问题
    suggestions JSONB, -- 存储优化建议
    severity VARCHAR(20),
    execution_time_ms FLOAT,
    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_query_analysis_query_id ON query_analysis_results(query_id);
CREATE INDEX IF NOT EXISTS idx_query_analysis_severity ON query_analysis_results(severity);
CREATE INDEX IF NOT EXISTS idx_query_analysis_analyzed_at ON query_analysis_results(analyzed_at);

-- =====================================================
-- 8. 创建定时清理任务表
-- =====================================================

CREATE TABLE IF NOT EXISTS slow_query_cleanup_config (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(255) UNIQUE,
    retention_days INTEGER DEFAULT 30,
    last_cleanup_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- 插入默认配置
INSERT INTO slow_query_cleanup_config (table_name, retention_days)
VALUES 
    ('slow_query_log', 30),
    ('slow_query_history', 90),
    ('query_analysis_results', 60)
ON CONFLICT (table_name) DO NOTHING;

-- =====================================================
-- 9. 添加注释
-- =====================================================

COMMENT ON TABLE slow_query_log IS '慢查询日志记录';
COMMENT ON TABLE slow_query_history IS '慢查询历史记录';
COMMENT ON TABLE index_suggestions IS '索引优化建议';
COMMENT ON TABLE query_performance_baseline IS '查询性能基准';
COMMENT ON TABLE index_usage_stats IS '索引使用统计';
COMMENT ON TABLE query_analysis_results IS '查询分析结果';

COMMENT ON COLUMN slow_query_log.query_id IS '查询标识符（来自 pg_stat_statements）';
COMMENT ON COLUMN slow_query_log.mean_time_ms IS '平均执行时间（毫秒）';
COMMENT ON COLUMN slow_query_log.cache_hit_ratio IS '缓存命中率';

-- =====================================================
-- 10. 创建清理函数
-- =====================================================

CREATE OR REPLACE FUNCTION cleanup_old_slow_query_data()
RETURNS void AS $$
DECLARE
    config_record RECORD;
BEGIN
    FOR config_record IN 
        SELECT * FROM slow_query_cleanup_config WHERE is_active = TRUE
    LOOP
        EXECUTE format('DELETE FROM %I WHERE recorded_at < NOW() - INTERVAL %L DAY',
            config_record.table_name,
            config_record.retention_days);
        
        UPDATE slow_query_cleanup_config 
        SET last_cleanup_at = NOW() 
        WHERE table_name = config_record.table_name;
        
        RAISE NOTICE 'Cleaned up table % with retention % days', 
            config_record.table_name, 
            config_record.retention_days;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 11. 创建统计视图
-- =====================================================

CREATE OR REPLACE VIEW v_slow_query_summary AS
SELECT 
    query_id,
    LEFT(query_text, 100) as query_preview,
    COUNT(*) as log_count,
    AVG(mean_time_ms) as avg_mean_time,
    MAX(mean_time_ms) as max_mean_time,
    SUM(calls) as total_calls,
    AVG(cache_hit_ratio) as avg_cache_hit_ratio,
    MAX(collected_at) as last_collected
FROM slow_query_log
GROUP BY query_id, LEFT(query_text, 100)
ORDER BY avg_mean_time DESC;

CREATE OR REPLACE VIEW v_index_health AS
SELECT 
    schema_name,
    table_name,
    index_name,
    index_scans,
    index_size_bytes,
    CASE 
        WHEN index_scans = 0 THEN 'UNUSED'
        WHEN index_scans < 10 THEN 'RARELY_USED'
        WHEN index_scans < 100 THEN 'MODERATELY_USED'
        ELSE 'ACTIVELY_USED'
    END as usage_status,
    last_used_at
FROM index_usage_stats
ORDER BY index_size_bytes DESC;

-- =====================================================
-- 完成
-- =====================================================
