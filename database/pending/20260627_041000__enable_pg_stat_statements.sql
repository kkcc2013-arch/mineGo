-- REQ-00077: 数据库慢查询分析与自动优化建议系统
-- 启用 pg_stat_statements 扩展并创建相关表

-- 启用 pg_stat_statements 扩展（需要超级用户权限）
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 创建慢查询分析历史表
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
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_slow_query_history_query_id ON slow_query_history(query_id);
CREATE INDEX IF NOT EXISTS idx_slow_query_history_recorded_at ON slow_query_history(recorded_at);

-- 创建索引建议表
CREATE TABLE IF NOT EXISTS index_suggestions (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(255),
    column_name VARCHAR(255),
    suggestion_type VARCHAR(50),
    reason TEXT,
    priority VARCHAR(20),
    estimated_impact TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    applied BOOLEAN DEFAULT FALSE,
    applied_at TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_index_suggestions_table ON index_suggestions(table_name);
CREATE INDEX IF NOT EXISTS idx_index_suggestions_applied ON index_suggestions(applied);

-- 创建查询性能基准表
CREATE TABLE IF NOT EXISTS query_performance_baseline (
    id SERIAL PRIMARY KEY,
    query_signature VARCHAR(64) UNIQUE,
    avg_execution_time_ms FLOAT,
    p95_execution_time_ms FLOAT,
    calls_per_hour FLOAT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_query_performance_signature ON query_performance_baseline(query_signature);

-- 添加注释
COMMENT ON TABLE slow_query_history IS 'REQ-00077: History of slow queries detected';
COMMENT ON TABLE index_suggestions IS 'REQ-00077: Suggestions for index optimization';
COMMENT ON TABLE query_performance_baseline IS 'REQ-00077: Performance baselines for queries';

-- 创建分析函数
CREATE OR REPLACE FUNCTION analyze_slow_queries(threshold_ms FLOAT DEFAULT 1000)
RETURNS TABLE (
    query_id BIGINT,
    query TEXT,
    calls BIGINT,
    mean_time FLOAT,
    total_time FLOAT,
    optimization_hint TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.queryid,
        s.query,
        s.calls,
        s.mean_time,
        s.total_time,
        CASE 
            WHEN s.query LIKE '%WHERE%' AND s.mean_time > threshold_ms * 2 
            THEN 'Consider adding index on WHERE clause columns'
            WHEN s.rows > 10000 
            THEN 'Consider adding LIMIT or pagination'
            ELSE 'Review query structure'
        END as optimization_hint
    FROM pg_stat_statements s
    WHERE s.mean_time > threshold_ms
    ORDER BY s.total_time DESC
    LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- 创建自动分析视图
CREATE OR REPLACE VIEW v_index_usage_summary AS
SELECT 
    schemaname,
    relname as table_name,
    COUNT(*) as total_indexes,
    COUNT(*) FILTER (WHERE idx_scan > 0) as used_indexes,
    COUNT(*) FILTER (WHERE idx_scan = 0) as unused_indexes,
    ROUND(COUNT(*) FILTER (WHERE idx_scan > 0)::FLOAT / COUNT(*) * 100, 2) as usage_ratio
FROM pg_stat_user_indexes
GROUP BY schemaname, relname
ORDER BY unused_indexes DESC;

-- 创建慢查询快照函数（定期执行）
CREATE OR REPLACE FUNCTION snapshot_slow_queries(threshold_ms FLOAT DEFAULT 1000)
RETURNS INTEGER AS $$
DECLARE
    inserted_count INTEGER;
BEGIN
    INSERT INTO slow_query_history (
        query_id, query_text, mean_time_ms, total_time_ms,
        calls, rows_returned, shared_blks_hit, shared_blks_read
    )
    SELECT 
        queryid,
        query,
        mean_time,
        total_time,
        calls,
        rows,
        shared_blks_hit,
        shared_blks_read
    FROM pg_stat_statements
    WHERE mean_time > threshold_ms;
    
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    
    -- 清理 30 天前的历史数据
    DELETE FROM slow_query_history 
    WHERE recorded_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
    
    RETURN inserted_count;
END;
$$ LANGUAGE plpgsql;
