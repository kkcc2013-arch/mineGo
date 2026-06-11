-- database/pending/20260611_030000__add_slow_query_analysis_system.sql
-- REQ-00063: 数据库慢查询分析与自动优化建议系统
-- 数据库迁移脚本

-- 慢查询日志表
CREATE TABLE IF NOT EXISTS slow_query_log (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL,
  query_text TEXT NOT NULL,
  calls BIGINT,
  total_time_ms DOUBLE PRECISION,
  mean_time_ms DOUBLE PRECISION,
  min_time_ms DOUBLE PRECISION,
  max_time_ms DOUBLE PRECISION,
  rows_affected BIGINT,
  cache_hit_ratio DOUBLE PRECISION,
  collected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 慢查询日志索引
CREATE INDEX IF NOT EXISTS idx_slow_query_query_id ON slow_query_log(query_id);
CREATE INDEX IF NOT EXISTS idx_slow_query_collected_at ON slow_query_log(collected_at);
CREATE INDEX IF NOT EXISTS idx_slow_query_mean_time ON slow_query_log(mean_time_ms);

-- 查询优化建议表
CREATE TABLE IF NOT EXISTS query_optimization_recommendations (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  sql TEXT,
  reason TEXT,
  estimated_improvement VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  conflict_check JSONB,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  applied_at TIMESTAMP WITH TIME ZONE,
  
  CONSTRAINT valid_severity CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'applied', 'failed', 'dismissed'))
);

-- 建议表索引
CREATE INDEX IF NOT EXISTS idx_recommendations_query_id ON query_optimization_recommendations(query_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON query_optimization_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_recommendations_severity ON query_optimization_recommendations(severity);

-- 查询性能历史表
CREATE TABLE IF NOT EXISTS query_performance_history (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL,
  snapshot_date DATE NOT NULL,
  total_calls BIGINT,
  avg_time_ms DOUBLE PRECISION,
  max_time_ms DOUBLE PRECISION,
  min_time_ms DOUBLE PRECISION,
  total_time_ms DOUBLE PRECISION,
  cache_hit_ratio DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(query_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_performance_history_date ON query_performance_history(snapshot_date);

-- 性能基线表
CREATE TABLE IF NOT EXISTS query_performance_baseline (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL UNIQUE,
  query_pattern TEXT,
  baseline_avg_time_ms DOUBLE PRECISION,
  baseline_max_time_ms DOUBLE PRECISION,
  baseline_calls_per_day BIGINT,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 告警配置表
CREATE TABLE IF NOT EXISTS query_alert_config (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  metric_type VARCHAR(50) NOT NULL,
  threshold DOUBLE PRECISION NOT NULL,
  comparison VARCHAR(10) NOT NULL DEFAULT 'gt',
  enabled BOOLEAN DEFAULT TRUE,
  notification_channels JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT valid_comparison CHECK (comparison IN ('gt', 'lt', 'gte', 'lte', 'eq'))
);

-- 插入默认告警配置
INSERT INTO query_alert_config (name, metric_type, threshold, comparison, notification_channels) VALUES
('Slow Query Alert', 'mean_time_ms', 5000, 'gt', '{"channels": ["slack", "email"]}'::jsonb),
('High Query Volume', 'calls_per_minute', 1000, 'gt', '{"channels": ["slack"]}'::jsonb),
('Low Cache Hit Ratio', 'cache_hit_ratio', 0.8, 'lt', '{"channels": ["email"]}'::jsonb)
ON CONFLICT DO NOTHING;

-- 分区表（按日期分区）
CREATE TABLE IF NOT EXISTS slow_query_log_partitioned (
  LIKE slow_query_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (collected_at);

-- 创建初始分区
CREATE TABLE IF NOT EXISTS slow_query_log_202606 PARTITION OF slow_query_log_partitioned
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS slow_query_log_202607 PARTITION OF slow_query_log_partitioned
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- 视图：慢查询摘要
CREATE OR REPLACE VIEW slow_query_summary AS
SELECT 
  query_id,
  LEFT(query_text, 200) as query_preview,
  COUNT(*) as occurrence_count,
  AVG(mean_time_ms) as avg_time_ms,
  MAX(mean_time_ms) as max_time_ms,
  MIN(mean_time_ms) as min_time_ms,
  SUM(calls) as total_calls,
  AVG(cache_hit_ratio) as avg_cache_hit_ratio
FROM slow_query_log
WHERE collected_at > NOW() - INTERVAL '7 days'
GROUP BY query_id, LEFT(query_text, 200)
ORDER BY avg_time_ms DESC;

-- 函数：自动创建分区
CREATE OR REPLACE FUNCTION create_monthly_partition(base_table TEXT, partition_month DATE)
RETURNS VOID AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_name := base_table || '_' || TO_CHAR(partition_month, 'YYYYMM');
  start_date := DATE_TRUNC('month', partition_month);
  end_date := start_date + INTERVAL '1 month';
  
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name, base_table, start_date, end_date);
END;
$$ LANGUAGE plpgsql;

-- 注释
COMMENT ON TABLE slow_query_log IS '存储慢查询日志，用于性能分析';
COMMENT ON TABLE query_optimization_recommendations IS '查询优化建议记录';
COMMENT ON TABLE query_performance_history IS '查询性能历史数据';
COMMENT ON TABLE query_performance_baseline IS '查询性能基线';
COMMENT ON TABLE query_alert_config IS '查询性能告警配置';