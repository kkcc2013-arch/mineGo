/**
 * 数据库迁移：连接池智能管理相关表
 * REQ-00623: 数据库连接池智能预热与动态自适应管理系统
 */

-- 连接池使用历史记录表
CREATE TABLE IF NOT EXISTS pool_usage_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name    VARCHAR(50) NOT NULL,
  pool_name       VARCHAR(100) NOT NULL,
  total_connections   INTEGER NOT NULL,
  idle_connections    INTEGER NOT NULL,
  waiting_clients     INTEGER NOT NULL,
  utilization         DECIMAL(5,4) NOT NULL,
  avg_query_time_ms   INTEGER,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- 索引优化字段
  hour            INTEGER NOT NULL,
  day_of_week     INTEGER NOT NULL
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pool_history_service_time 
  ON pool_usage_history(service_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pool_history_hour 
  ON pool_usage_history(service_name, hour, day_of_week);
CREATE INDEX IF NOT EXISTS idx_pool_history_utilization 
  ON pool_usage_history(service_name, utilization DESC) 
  WHERE utilization > 0.8;

-- 连接池配置调整历史表
CREATE TABLE IF NOT EXISTS pool_config_changes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name    VARCHAR(50) NOT NULL,
  old_max_size    INTEGER NOT NULL,
  new_max_size    INTEGER NOT NULL,
  old_min_size    INTEGER NOT NULL,
  new_min_size    INTEGER NOT NULL,
  action          VARCHAR(20) NOT NULL, -- 'scale_up', 'scale_down', 'preheat'
  reason          TEXT,
  triggered_by    VARCHAR(50) NOT NULL, -- 'auto', 'manual', 'scheduled'
  metrics_snapshot JSONB,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_changes_service_time 
  ON pool_config_changes(service_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pool_changes_action 
  ON pool_config_changes(action, timestamp DESC);

-- 流量预测数据表
CREATE TABLE IF NOT EXISTS traffic_predictions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prediction_time TIMESTAMP NOT NULL,
  predicted_hour  INTEGER NOT NULL,
  predicted_day   INTEGER NOT NULL,
  expected_traffic VARCHAR(20) NOT NULL, -- 'low', 'medium', 'high', 'very_high'
  confidence      DECIMAL(3,2) NOT NULL, -- 0.00 - 1.00
  model_version   VARCHAR(50),
  features        JSONB,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traffic_predictions_time 
  ON traffic_predictions(prediction_time);
CREATE INDEX IF NOT EXISTS idx_traffic_predictions_expires 
  ON traffic_predictions(expires_at) 
  WHERE expires_at IS NOT NULL;

-- 预热任务记录表
CREATE TABLE IF NOT EXISTS pool_preheat_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name    VARCHAR(50) NOT NULL,
  preheat_type    VARCHAR(50) NOT NULL, -- 'scheduled', 'manual', 'prediction-based'
  target_connections INTEGER NOT NULL,
  actual_connections  INTEGER,
  success         BOOLEAN NOT NULL DEFAULT false,
  duration_ms     INTEGER,
  error_message   TEXT,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_preheat_records_time 
  ON pool_preheat_records(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_preheat_records_service 
  ON pool_preheat_records(service_name, timestamp DESC);

-- 添加注释
COMMENT ON TABLE pool_usage_history IS '连接池使用率历史记录，用于分析和预测';
COMMENT ON TABLE pool_config_changes IS '连接池配置调整历史记录';
COMMENT ON TABLE traffic_predictions IS '流量预测数据存储';
COMMENT ON TABLE pool_preheat_records IS '连接池预热任务执行记录';

-- 创建视图：连接池使用率统计
CREATE OR REPLACE VIEW v_pool_utilization_stats AS
SELECT 
  service_name,
  DATE_TRUNC('hour', timestamp) AS hour,
  COUNT(*) AS sample_count,
  AVG(utilization) AS avg_utilization,
  MAX(utilization) AS max_utilization,
  MIN(utilization) AS min_utilization,
  AVG(waiting_clients) AS avg_waiting_clients,
  MAX(waiting_clients) AS max_waiting_clients
FROM pool_usage_history
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY service_name, DATE_TRUNC('hour', timestamp)
ORDER BY service_name, hour DESC;

-- 创建视图：连接池健康状态
CREATE OR REPLACE VIEW v_pool_health_status AS
SELECT 
  service_name,
  COUNT(*) FILTER (WHERE utilization > 0.85) AS high_utilization_count,
  COUNT(*) FILTER (WHERE utilization < 0.3) AS low_utilization_count,
  AVG(utilization) AS avg_utilization,
  MAX(timestamp) AS last_update
FROM pool_usage_history
WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY service_name;

-- 创建函数：清理过期数据
CREATE OR REPLACE FUNCTION cleanup_pool_history()
RETURNS void AS $$
BEGIN
  -- 删除 7 天前的历史记录
  DELETE FROM pool_usage_history 
  WHERE timestamp < NOW() - INTERVAL '7 days';
  
  -- 删除过期的预测数据
  DELETE FROM traffic_predictions 
  WHERE expires_at < NOW();
  
  -- 删除 30 天前的配置变更记录
  DELETE FROM pool_config_changes 
  WHERE timestamp < NOW() - INTERVAL '30 days';
  
  RAISE NOTICE 'Pool history cleanup completed';
END;
$$ LANGUAGE plpgsql;

-- 创建定时任务：每小时清理一次
-- 注意：需要安装 pg_cron 扩展
-- SELECT cron.schedule('cleanup_pool_history', '0 * * * *', 'SELECT cleanup_pool_history()');
