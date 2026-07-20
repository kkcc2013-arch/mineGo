-- database/migrations/20260720_200000_read_write_split_system.sql
-- 数据库读写分离与副本延迟监控系统

-- ============================================================
-- 副本延迟心跳表
-- ============================================================

CREATE TABLE IF NOT EXISTS replica_lag_heartbeat (
  id SERIAL PRIMARY KEY,
  heartbeat_time BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replica_lag_heartbeat_time 
ON replica_lag_heartbeat(heartbeat_time);

-- 自动清理旧心跳数据（保留最近 1 小时）
CREATE OR REPLACE FUNCTION cleanup_old_heartbeats()
RETURNS void AS $$
BEGIN
  DELETE FROM replica_lag_heartbeat 
  WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- 定时清理任务（每 10 分钟）
SELECT cron.schedule(
  'cleanup_heartbeats',
  '*/10 * * * *',
  'SELECT cleanup_old_heartbeats()'
);

-- ============================================================
-- 副本监控日志表
-- ============================================================

CREATE TABLE IF NOT EXISTS replica_monitor_log (
  id SERIAL PRIMARY KEY,
  replica_id VARCHAR(50) NOT NULL,
  lag_ms INTEGER NOT NULL,
  healthy BOOLEAN NOT NULL DEFAULT true,
  check_method VARCHAR(20) NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replica_monitor_replica 
ON replica_monitor_log(replica_id);

CREATE INDEX IF NOT EXISTS idx_replica_monitor_created 
ON replica_monitor_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_replica_monitor_healthy 
ON replica_monitor_log(healthy, created_at);

-- ============================================================
-- 副本配置表
-- ============================================================

CREATE TABLE IF NOT EXISTS replica_config (
  id SERIAL PRIMARY KEY,
  replica_id VARCHAR(50) NOT NULL UNIQUE,
  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  lag_warning_threshold_ms INTEGER NOT NULL DEFAULT 500,
  lag_critical_threshold_ms INTEGER NOT NULL DEFAULT 2000,
  lag_max_threshold_ms INTEGER NOT NULL DEFAULT 5000,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 初始配置（示例）
INSERT INTO replica_config (replica_id, host, port, weight)
VALUES
  ('replica-1', 'localhost', 5433, 1)
ON CONFLICT (replica_id) DO NOTHING;

-- ============================================================
-- 读写分离路由日志表
-- ============================================================

CREATE TABLE IF NOT EXISTS read_write_split_log (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(100),
  pool_type VARCHAR(20) NOT NULL, -- primary | replica-{id}
  query_type VARCHAR(20) NOT NULL, -- read | write
  consistency_level VARCHAR(20) NOT NULL, -- strong | eventual
  table_name VARCHAR(100),
  query_duration_ms INTEGER,
  rows_affected INTEGER,
  error_occurred BOOLEAN DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rw_split_log_pool 
ON read_write_split_log(pool_type);

CREATE INDEX IF NOT EXISTS idx_rw_split_log_type 
ON read_write_split_log(query_type);

CREATE INDEX IF NOT EXISTS idx_rw_split_log_created 
ON read_write_split_log(created_at DESC);

-- ============================================================
-- 故障切换事件表
-- ============================================================

CREATE TABLE IF NOT EXISTS failover_event (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL, -- replica_unavailable | lag_exceeded | query_error
  from_pool VARCHAR(50) NOT NULL,
  to_pool VARCHAR(50) NOT NULL,
  reason TEXT NOT NULL,
  lag_ms INTEGER,
  recovered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failover_event_type 
ON failover_event(event_type);

CREATE INDEX IF NOT EXISTS idx_failover_event_created 
ON failover_event(created_at DESC);

-- ============================================================
-- 统计视图
-- ============================================================

CREATE OR REPLACE VIEW replica_health_summary AS
SELECT 
  r.replica_id,
  r.host,
  r.port,
  r.is_active,
  r.lag_warning_threshold_ms,
  r.lag_critical_threshold_ms,
  COALESCE(l.current_lag, 0) as current_lag_ms,
  COALESCE(l.is_healthy, true) as is_healthy,
  l.last_check,
  COUNT(CASE WHEN f.event_type IS NOT NULL THEN 1 END) as failover_count_today
FROM replica_config r
LEFT JOIN LATERAL (
  SELECT 
    lag_ms as current_lag,
    healthy as is_healthy,
    created_at as last_check
  FROM replica_monitor_log
  WHERE replica_id = r.replica_id
  ORDER BY created_at DESC
  LIMIT 1
) l ON true
LEFT JOIN failover_event f ON f.from_pool = r.replica_id 
  AND f.created_at >= CURRENT_DATE
GROUP BY 
  r.replica_id, r.host, r.port, r.is_active,
  r.lag_warning_threshold_ms, r.lag_critical_threshold_ms,
  l.current_lag, l.is_healthy, l.last_check;

-- ============================================================
-- 监控函数
-- ============================================================

CREATE OR REPLACE FUNCTION get_replica_statistics(
  p_hours INTEGER DEFAULT 24
)
RETURNS TABLE (
  replica_id VARCHAR(50),
  avg_lag_ms NUMERIC,
  max_lag_ms INTEGER,
  min_lag_ms INTEGER,
  check_count BIGINT,
  unhealthy_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    rml.replica_id::VARCHAR(50),
    AVG(rml.lag_ms)::NUMERIC as avg_lag_ms,
    MAX(rml.lag_ms) as max_lag_ms,
    MIN(rml.lag_ms) as min_lag_ms,
    COUNT(*)::BIGINT as check_count,
    COUNT(*) FILTER (WHERE NOT rml.healthy)::BIGINT as unhealthy_count
  FROM replica_monitor_log rml
  WHERE rml.created_at >= NOW() - (p_hours || ' hours')::INTERVAL
  GROUP BY rml.replica_id
  ORDER BY avg_lag_ms DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 清理函数
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_old_monitor_logs()
RETURNS void AS $$
BEGIN
  -- 保留最近 30 天的日志
  DELETE FROM replica_monitor_log 
  WHERE created_at < NOW() - INTERVAL '30 days';
  
  DELETE FROM read_write_split_log 
  WHERE created_at < NOW() - INTERVAL '30 days';
  
  DELETE FROM failover_event 
  WHERE created_at < NOW() - INTERVAL '90 days';
  
  RAISE NOTICE 'Cleaned up old monitor logs';
END;
$$ LANGUAGE plpgsql;

-- 定时清理任务（每天凌晨 2 点）
SELECT cron.schedule(
  'cleanup_monitor_logs',
  '0 2 * * *',
  'SELECT cleanup_old_monitor_logs()'
);

-- ============================================================
-- 注释
-- ============================================================

COMMENT ON TABLE replica_lag_heartbeat IS '副本延迟心跳时间戳';
COMMENT ON TABLE replica_monitor_log IS '副本监控日志';
COMMENT ON TABLE replica_config IS '副本配置信息';
COMMENT ON TABLE read_write_split_log IS '读写分离路由日志';
COMMENT ON TABLE failover_event IS '故障切换事件记录';
COMMENT ON VIEW replica_health_summary IS '副本健康状态汇总视图';
COMMENT ON FUNCTION get_replica_statistics IS '获取副本统计信息';
