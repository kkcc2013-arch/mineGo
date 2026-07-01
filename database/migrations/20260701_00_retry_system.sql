-- database/migrations/20260701_00_retry_system.sql
-- REQ-00402: API 重试系统数据库表

-- 重试配置表
CREATE TABLE IF NOT EXISTS retry_configs (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL UNIQUE,
  max_retries INTEGER DEFAULT 3,
  initial_delay_ms INTEGER DEFAULT 100,
  max_delay_ms INTEGER DEFAULT 30000,
  backoff_type VARCHAR(20) DEFAULT 'exponential',
  jitter_type VARCHAR(20) DEFAULT 'full',
  timeout_ms INTEGER DEFAULT 30000,
  retry_budget_max INTEGER DEFAULT 100,
  retry_budget_refill INTEGER DEFAULT 10,
  error_config JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 重试事件日志表（用于分析）
CREATE TABLE IF NOT EXISTS retry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name VARCHAR(100) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  attempt INTEGER NOT NULL,
  delay_ms INTEGER,
  error_type VARCHAR(50),
  error_message TEXT,
  success BOOLEAN NOT NULL,
  duration_ms INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_retry_events_service ON retry_events(service_name);
CREATE INDEX idx_retry_events_operation ON retry_events(operation_name);
CREATE INDEX idx_retry_events_created ON retry_events(created_at);
CREATE INDEX idx_retry_events_success ON retry_events(success);

-- 重试统计聚合表
CREATE TABLE IF NOT EXISTS retry_stats_hourly (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  hour_timestamp TIMESTAMP NOT NULL,
  total_attempts BIGINT DEFAULT 0,
  successful_attempts BIGINT DEFAULT 0,
  retry_attempts BIGINT DEFAULT 0,
  avg_delay_ms DOUBLE PRECISION,
  max_delay_ms INTEGER,
  error_breakdown JSONB DEFAULT '{}',
  avg_duration_ms DOUBLE PRECISION,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(service_name, operation_name, hour_timestamp)
);

CREATE INDEX idx_retry_stats_service ON retry_stats_hourly(service_name);
CREATE INDEX idx_retry_stats_hour ON retry_stats_hourly(hour_timestamp);

-- 默认配置
INSERT INTO retry_configs (service_name, max_retries, initial_delay_ms, max_delay_ms, backoff_type, jitter_type, timeout_ms)
VALUES
  ('gateway', 3, 100, 10000, 'exponential', 'full', 30000),
  ('user-service', 3, 100, 10000, 'exponential', 'full', 30000),
  ('pokemon-service', 3, 100, 10000, 'exponential', 'full', 30000),
  ('catch-service', 3, 100, 10000, 'exponential', 'full', 30000),
  ('gym-service', 3, 100, 10000, 'exponential', 'full', 30000),
  ('social-service', 3, 100, 10000, 'exponential', 'full', 30000),
  ('location-service', 3, 100, 10000, 'exponential', 'full', 30000),
  ('reward-service', 3, 100, 10000, 'exponential', 'full', 30000),
  ('payment-service', 5, 100, 15000, 'exponential', 'full', 60000)
ON CONFLICT (service_name) DO NOTHING;

-- 聚合函数：每小时统计
CREATE OR REPLACE FUNCTION aggregate_retry_stats()
RETURNS void AS $$
BEGIN
  INSERT INTO retry_stats_hourly (
    service_name,
    operation_name,
    hour_timestamp,
    total_attempts,
    successful_attempts,
    retry_attempts,
    avg_delay_ms,
    max_delay_ms,
    error_breakdown,
    avg_duration_ms
  )
  SELECT
    service_name,
    operation_name,
    date_trunc('hour', created_at) as hour_timestamp,
    COUNT(*) as total_attempts,
    COUNT(*) FILTER (WHERE success = true) as successful_attempts,
    COUNT(*) FILTER (WHERE attempt > 1) as retry_attempts,
    AVG(delay_ms) FILTER (WHERE delay_ms IS NOT NULL) as avg_delay_ms,
    MAX(delay_ms) FILTER (WHERE delay_ms IS NOT NULL) as max_delay_ms,
    jsonb_object_agg(error_type, cnt) as error_breakdown,
    AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration_ms
  FROM (
    SELECT
      service_name,
      operation_name,
      attempt,
      delay_ms,
      error_type,
      success,
      duration_ms,
      created_at,
      COUNT(*) OVER (PARTITION BY service_name, operation_name, error_type) as cnt
    FROM retry_events
    WHERE created_at >= NOW() - INTERVAL '1 hour'
  ) subq
  GROUP BY service_name, operation_name, date_trunc('hour', created_at)
  ON CONFLICT (service_name, operation_name, hour_timestamp)
  DO UPDATE SET
    total_attempts = EXCLUDED.total_attempts,
    successful_attempts = EXCLUDED.successful_attempts,
    retry_attempts = EXCLUDED.retry_attempts,
    avg_delay_ms = EXCLUDED.avg_delay_ms,
    max_delay_ms = EXCLUDED.max_delay_ms,
    error_breakdown = EXCLUDED.error_breakdown,
    avg_duration_ms = EXCLUDED.avg_duration_ms;
END;
$$ LANGUAGE plpgsql;

-- 注释
COMMENT ON TABLE retry_configs IS '服务重试配置表';
COMMENT ON TABLE retry_events IS '重试事件日志表，用于实时监控和分析';
COMMENT ON TABLE retry_stats_hourly IS '重试统计聚合表，按小时聚合';
COMMENT ON FUNCTION aggregate_retry_stats() IS '聚合最近一小时的重试统计数据';
