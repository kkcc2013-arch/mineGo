-- REQ-00077: 数据库慢查询分析与自动优化建议系统
-- 创建慢查询日志表和相关索引

-- 启用 pg_stat_statements 扩展（如果未启用）
DO $ext$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_stat_statements; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '扩展 pg_stat_statements 不可用，跳过：%', SQLERRM; END $ext$;

-- 慢查询日志表
CREATE TABLE IF NOT EXISTS slow_query_log (
    id SERIAL PRIMARY KEY,
    query_id VARCHAR(64) NOT NULL,
    query_text TEXT NOT NULL,
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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS query_id VARCHAR(64);
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS query_text TEXT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS calls BIGINT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS total_time_ms FLOAT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS mean_time_ms FLOAT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS min_time_ms FLOAT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS max_time_ms FLOAT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS rows_affected BIGINT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS shared_blks_hit BIGINT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS shared_blks_read BIGINT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS cache_hit_ratio FLOAT;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_slow_query_log_query_id ON slow_query_log(query_id);
CREATE INDEX IF NOT EXISTS idx_slow_query_log_collected_at ON slow_query_log(collected_at);
CREATE INDEX IF NOT EXISTS idx_slow_query_log_mean_time ON slow_query_log(mean_time_ms DESC);
-- 按日期查询直接用 idx_slow_query_log_collected_at 做范围扫描（collected_at 在不同迁移中分别为 TIMESTAMP/TIMESTAMPTZ，::date 表达式索引对后者不是 IMMUTABLE）

-- 索引建议表
CREATE TABLE IF NOT EXISTS index_suggestions (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(255) NOT NULL,
    column_name VARCHAR(255) NOT NULL,
    suggestion_type VARCHAR(50) NOT NULL,
    reason TEXT,
    priority VARCHAR(20),
    estimated_impact TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    applied BOOLEAN DEFAULT FALSE,
    applied_at TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS table_name VARCHAR(255);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS column_name VARCHAR(255);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS suggestion_type VARCHAR(50);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS priority VARCHAR(20);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS estimated_impact TEXT;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS applied BOOLEAN DEFAULT FALSE;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_index_suggestions_table ON index_suggestions(table_name);
CREATE INDEX IF NOT EXISTS idx_index_suggestions_applied ON index_suggestions(applied);

-- 查询性能基准表
CREATE TABLE IF NOT EXISTS query_performance_baseline (
    id SERIAL PRIMARY KEY,
    query_signature VARCHAR(64) NOT NULL UNIQUE,
    avg_execution_time_ms FLOAT,
    p95_execution_time_ms FLOAT,
    p99_execution_time_ms FLOAT,
    calls_per_hour FLOAT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS query_signature VARCHAR(64);
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS avg_execution_time_ms FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS p95_execution_time_ms FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS p99_execution_time_ms FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS calls_per_hour FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_query_performance_signature ON query_performance_baseline(query_signature);

-- 添加注释
COMMENT ON TABLE slow_query_log IS 'REQ-00077: History of slow queries detected by pg_stat_statements';
COMMENT ON TABLE index_suggestions IS 'REQ-00077: Suggestions for index optimization with tracking';
COMMENT ON TABLE query_performance_baseline IS 'REQ-00077: Performance baselines for queries';

-- 创建定期清理慢查询日志的函数（保留最近30天）
CREATE OR REPLACE FUNCTION cleanup_old_slow_queries()
RETURNS void AS $$
BEGIN
    DELETE FROM slow_query_log 
    WHERE collected_at < CURRENT_DATE - INTERVAL '30 days';
    
    RAISE NOTICE 'Cleaned up slow queries older than 30 days';
END;
$$ LANGUAGE plpgsql;

-- 创建分析结果汇总视图
-- 与 pending/20260611_030000 中的同名视图列不同：先删除再按本迁移（新版）定义重建
DROP VIEW IF EXISTS slow_query_summary;
CREATE VIEW slow_query_summary AS
SELECT 
    query_id,
    LEFT(query_text, 200) as query_preview,
    COUNT(*) as occurrences,
    AVG(mean_time_ms) as avg_mean_time,
    MAX(mean_time_ms) as max_mean_time,
    SUM(calls) as total_calls,
    AVG(cache_hit_ratio) as avg_cache_hit,
    MAX(collected_at) as last_seen
FROM slow_query_log
WHERE collected_at > CURRENT_DATE - INTERVAL '7 days'
GROUP BY query_id, LEFT(query_text, 200)
ORDER BY avg_mean_time DESC;