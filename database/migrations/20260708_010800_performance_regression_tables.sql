-- 性能回归测试系统数据库表
-- REQ-00490: API性能回归测试自动化与基准线管理系统
-- 创建时间: 2026-07-08 01:08 UTC

-- 1. API 性能基准线表
CREATE TABLE IF NOT EXISTS api_performance_baselines (
  id SERIAL PRIMARY KEY,
  endpoint VARCHAR(255) NOT NULL UNIQUE,
  avg_response_time FLOAT NOT NULL DEFAULT 0,
  median_response_time FLOAT NOT NULL DEFAULT 0,
  p90_response_time FLOAT NOT NULL DEFAULT 0,
  p95_response_time FLOAT NOT NULL DEFAULT 0,
  p99_response_time FLOAT NOT NULL DEFAULT 0,
  error_rate FLOAT NOT NULL DEFAULT 0,
  throughput FLOAT NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  std_dev FLOAT DEFAULT NULL,
  last_updated TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 基准线表索引
CREATE INDEX IF NOT EXISTS idx_perf_baselines_endpoint ON api_performance_baselines(endpoint);
CREATE INDEX IF NOT EXISTS idx_perf_baselines_updated ON api_performance_baselines(last_updated);

COMMENT ON TABLE api_performance_baselines IS 'API性能基准线数据表';
COMMENT ON COLUMN api_performance_baselines.endpoint IS 'API端点标识，如 GET /api/pokemon/list';
COMMENT ON COLUMN api_performance_baselines.avg_response_time IS '平均响应时间(ms)';
COMMENT ON COLUMN api_performance_baselines.p95_response_time IS 'P95响应时间(ms)';
COMMENT ON COLUMN api_performance_baselines.error_rate IS '错误率(0-1)';
COMMENT ON COLUMN api_performance_baselines.throughput IS '吞吐量(req/s)';

-- 2. API 性能测试结果表
CREATE TABLE IF NOT EXISTS api_performance_test_results (
  id SERIAL PRIMARY KEY,
  endpoint VARCHAR(255) NOT NULL,
  test_type VARCHAR(50) NOT NULL DEFAULT 'regression',
  metrics JSONB NOT NULL,
  analysis_result JSONB NOT NULL,
  passed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 测试结果表索引
CREATE INDEX IF NOT EXISTS idx_perf_results_endpoint ON api_performance_test_results(endpoint);
CREATE INDEX IF NOT EXISTS idx_perf_results_created ON api_performance_test_results(created_at);
CREATE INDEX IF NOT EXISTS idx_perf_results_passed ON api_performance_test_results(passed);
CREATE INDEX IF NOT EXISTS idx_perf_results_type ON api_performance_test_results(test_type);

COMMENT ON TABLE api_performance_test_results IS 'API性能测试结果历史表';
COMMENT ON COLUMN api_performance_test_results.metrics IS '性能指标JSON对象';
COMMENT ON COLUMN api_performance_test_results.analysis_result IS '分析结果JSON对象';
COMMENT ON COLUMN api_performance_test_results.passed IS '是否通过测试';

-- 3. 性能退化告警表
CREATE TABLE IF NOT EXISTS api_performance_alerts (
  id SERIAL PRIMARY KEY,
  endpoint VARCHAR(255) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  message TEXT NOT NULL,
  metrics_before JSONB,
  metrics_after JSONB,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_by VARCHAR(100) DEFAULT NULL,
  acknowledged_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 告警表索引
CREATE INDEX IF NOT EXISTS idx_perf_alerts_endpoint ON api_performance_alerts(endpoint);
CREATE INDEX IF NOT EXISTS idx_perf_alerts_created ON api_performance_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_perf_alerts_severity ON api_performance_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_perf_alerts_acknowledged ON api_performance_alerts(acknowledged);

COMMENT ON TABLE api_performance_alerts IS '性能退化告警记录表';
COMMENT ON COLUMN api_performance_alerts.alert_type IS '告警类型: regression, degradation, baseline_stale';
COMMENT ON COLUMN api_performance_alerts.severity IS '严重程度: critical, high, medium, low';

-- 4. 插入示例数据（仅用于演示）
INSERT INTO api_performance_baselines (endpoint, avg_response_time, median_response_time, 
  p90_response_time, p95_response_time, p99_response_time, error_rate, throughput, sample_count)
VALUES 
  ('GET /api/pokemon/list', 45.2, 38.5, 78.3, 95.6, 120.4, 0.002, 125.5, 100),
  ('GET /api/location/nearby', 62.8, 55.0, 98.7, 125.3, 156.2, 0.001, 95.2, 100),
  ('POST /api/catch/attempt', 85.4, 72.3, 125.6, 156.8, 198.5, 0.005, 78.4, 100),
  ('GET /api/user/profile', 35.6, 30.2, 55.8, 68.9, 85.3, 0.001, 150.2, 100),
  ('GET /api/gym/battle', 120.5, 105.2, 175.6, 205.3, 258.7, 0.003, 65.8, 100)
ON CONFLICT (endpoint) DO NOTHING;

-- 5. 创建清理过期数据的函数
CREATE OR REPLACE FUNCTION cleanup_old_performance_results(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM api_performance_test_results
  WHERE created_at < NOW() - INTERVAL '1 day' * retention_days;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_performance_results IS '清理过期的性能测试结果数据';

-- 6. 创建更新基准线的函数
CREATE OR REPLACE FUNCTION update_performance_baseline(
  p_endpoint VARCHAR(255),
  p_avg FLOAT,
  p_median FLOAT,
  p_p90 FLOAT,
  p_p95 FLOAT,
  p_p99 FLOAT,
  p_error_rate FLOAT,
  p_throughput FLOAT,
  p_samples INTEGER,
  p_std_dev FLOAT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO api_performance_baselines 
    (endpoint, avg_response_time, median_response_time, p90_response_time, p95_response_time, 
     p99_response_time, error_rate, throughput, sample_count, std_dev, last_updated)
  VALUES 
    (p_endpoint, p_avg, p_median, p_p90, p_p95, p_p99, p_error_rate, p_throughput, p_samples, p_std_dev, NOW())
  ON CONFLICT (endpoint) DO UPDATE SET
    avg_response_time = EXCLUDED.avg_response_time,
    median_response_time = EXCLUDED.median_response_time,
    p90_response_time = EXCLUDED.p90_response_time,
    p95_response_time = EXCLUDED.p95_response_time,
    p99_response_time = EXCLUDED.p99_response_time,
    error_rate = EXCLUDED.error_rate,
    throughput = EXCLUDED.throughput,
    sample_count = EXCLUDED.sample_count,
    std_dev = EXCLUDED.std_dev,
    last_updated = NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_performance_baseline IS '更新或插入API性能基准线';

-- 7. 创建性能退化检测函数
CREATE OR REPLACE FUNCTION detect_performance_regression(
  p_endpoint VARCHAR(255),
  p_current_p95 FLOAT,
  p_threshold FLOAT DEFAULT 0.2
)
RETURNS BOOLEAN AS $$
DECLARE
  baseline_p95 FLOAT;
BEGIN
  SELECT p95_response_time INTO baseline_p95
  FROM api_performance_baselines
  WHERE endpoint = p_endpoint
    AND last_updated > NOW() - INTERVAL '7 days'
  ORDER BY last_updated DESC
  LIMIT 1;
  
  IF baseline_p95 IS NULL THEN
    RETURN FALSE; -- 无基准线
  END IF;
  
  RETURN (p_current_p95 - baseline_p95) / baseline_p95 > p_threshold;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION detect_performance_regression IS '检测是否存在性能退化';

-- 完成
-- 验证表创建
DO $$
BEGIN
  RAISE NOTICE '性能回归测试系统数据库表已创建';
  RAISE NOTICE '表: api_performance_baselines, api_performance_test_results, api_performance_alerts';
END $$;