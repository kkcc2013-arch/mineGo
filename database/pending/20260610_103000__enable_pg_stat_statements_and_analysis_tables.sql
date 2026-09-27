-- REQ-00077: 数据库慢查询分析与自动优化建议系统
-- 迁移: 启用 pg_stat_statements 和创建分析表

-- =====================================================
-- 1. 启用 pg_stat_statements 扩展
-- =====================================================

DO $ext$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_stat_statements; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '扩展 pg_stat_statements 不可用，跳过：%', SQLERRM; END $ext$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE slow_query_log ADD COLUMN IF NOT EXISTS query_id VARCHAR(50);
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
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.slow_query_log') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('query_id', 'query_text', 'calls', 'total_time_ms', 'mean_time_ms', 'min_time_ms', 'max_time_ms', 'rows_affected', 'shared_blks_hit', 'shared_blks_read', 'cache_hit_ratio', 'collected_at', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE slow_query_log ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS query_id BIGINT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS query_text TEXT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS mean_time_ms FLOAT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS total_time_ms FLOAT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS calls BIGINT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS rows_returned BIGINT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS shared_blks_hit BIGINT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS shared_blks_read BIGINT;
ALTER TABLE slow_query_history ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.slow_query_history') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('query_id', 'query_text', 'mean_time_ms', 'total_time_ms', 'calls', 'rows_returned', 'shared_blks_hit', 'shared_blks_read', 'recorded_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE slow_query_history ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;
CREATE INDEX IF NOT EXISTS idx_slow_query_history_query_id ON slow_query_history (query_id);
CREATE INDEX IF NOT EXISTS idx_slow_query_history_recorded_at ON slow_query_history (recorded_at);

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS table_name VARCHAR(255);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS column_name VARCHAR(255);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS suggestion_type VARCHAR(50);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS priority VARCHAR(20);
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS estimated_impact TEXT;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS suggested_sql TEXT;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS applied BOOLEAN DEFAULT FALSE;
ALTER TABLE index_suggestions ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.index_suggestions') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('table_name', 'column_name', 'suggestion_type', 'reason', 'priority', 'estimated_impact', 'suggested_sql', 'created_at', 'applied', 'applied_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE index_suggestions ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS query_signature VARCHAR(64);
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS query_text TEXT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS avg_execution_time_ms FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS p95_execution_time_ms FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS p99_execution_time_ms FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS calls_per_hour FLOAT;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE query_performance_baseline ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.query_performance_baseline') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('query_signature', 'query_text', 'avg_execution_time_ms', 'p95_execution_time_ms', 'p99_execution_time_ms', 'calls_per_hour', 'last_updated', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE query_performance_baseline ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS schema_name VARCHAR(255);
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS table_name VARCHAR(255);
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS index_name VARCHAR(255);
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS index_scans BIGINT;
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS tuples_read BIGINT;
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS tuples_fetched BIGINT;
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS index_size_bytes BIGINT;
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS is_constraint BOOLEAN DEFAULT FALSE;
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP;
ALTER TABLE index_usage_stats ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.index_usage_stats') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('schema_name', 'table_name', 'index_name', 'index_scans', 'tuples_read', 'tuples_fetched', 'index_size_bytes', 'is_constraint', 'last_used_at', 'recorded_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE index_usage_stats ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE query_analysis_results ADD COLUMN IF NOT EXISTS query_id VARCHAR(50);
ALTER TABLE query_analysis_results ADD COLUMN IF NOT EXISTS query_text TEXT;
ALTER TABLE query_analysis_results ADD COLUMN IF NOT EXISTS issues JSONB;
ALTER TABLE query_analysis_results ADD COLUMN IF NOT EXISTS suggestions JSONB;
ALTER TABLE query_analysis_results ADD COLUMN IF NOT EXISTS severity VARCHAR(20);
ALTER TABLE query_analysis_results ADD COLUMN IF NOT EXISTS execution_time_ms FLOAT;
ALTER TABLE query_analysis_results ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.query_analysis_results') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('query_id', 'query_text', 'issues', 'suggestions', 'severity', 'execution_time_ms', 'analyzed_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE query_analysis_results ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE slow_query_cleanup_config ADD COLUMN IF NOT EXISTS table_name VARCHAR(255);
ALTER TABLE slow_query_cleanup_config ADD COLUMN IF NOT EXISTS retention_days INTEGER DEFAULT 30;
ALTER TABLE slow_query_cleanup_config ADD COLUMN IF NOT EXISTS last_cleanup_at TIMESTAMP;
ALTER TABLE slow_query_cleanup_config ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.slow_query_cleanup_config') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('table_name', 'retention_days', 'last_cleanup_at', 'is_active', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE slow_query_cleanup_config ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
