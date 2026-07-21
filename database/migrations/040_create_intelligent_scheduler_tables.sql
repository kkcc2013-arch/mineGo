-- 智能调度系统数据库迁移
-- 创建流量预测和调度相关的表

-- 1. 流量指标表
CREATE TABLE IF NOT EXISTS traffic_metrics (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  service_name VARCHAR(64) NOT NULL,
  request_count INTEGER DEFAULT 0,
  avg_response_time DECIMAL(10,3) DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  cpu_usage DECIMAL(5,2),
  memory_usage DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_traffic_metrics_time ON traffic_metrics(timestamp DESC);
CREATE INDEX idx_traffic_metrics_service ON traffic_metrics(service_name, timestamp DESC);

-- 2. 流量预测表
CREATE TABLE IF NOT EXISTS traffic_predictions (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL,
  predicted_value DECIMAL(10,2) NOT NULL,
  confidence DECIMAL(5,4) DEFAULT 0,
  model_version VARCHAR(32) DEFAULT 'v1',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_traffic_predictions_time ON traffic_predictions(timestamp DESC);

-- 3. 实际流量表（用于验证预测准确率）
CREATE TABLE IF NOT EXISTS traffic_actuals (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL UNIQUE,
  actual_value DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_traffic_actuals_time ON traffic_actuals(timestamp DESC);

-- 4. 调度事件表
CREATE TABLE IF NOT EXISTS scaling_events (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  service_name VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,  -- 'scale_up', 'scale_down', 'none'
  from_replicas INTEGER NOT NULL,
  to_replicas INTEGER NOT NULL,
  reason TEXT,
  trigger_type VARCHAR(32),  -- 'proactive', 'reactive', 'manual'
  confidence DECIMAL(5,4),
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_scaling_events_time ON scaling_events(timestamp DESC);
CREATE INDEX idx_scaling_events_service ON scaling_events(service_name, timestamp DESC);

-- 5. 计划事件表（节假日、推广活动）
CREATE TABLE IF NOT EXISTS scheduled_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL,  -- 'holiday', 'promotion', 'maintenance'
  event_name VARCHAR(128) NOT NULL,
  event_start TIMESTAMP NOT NULL,
  event_end TIMESTAMP NOT NULL,
  expected_traffic_multiplier DECIMAL(5,2) DEFAULT 1.0,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_scheduled_events_time ON scheduled_events(event_start, event_end);

-- 6. 成本指标表
CREATE TABLE IF NOT EXISTS cost_metrics (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  service_name VARCHAR(64) NOT NULL,
  instance_type VARCHAR(32) NOT NULL,  -- 'onDemand', 'spot', 'reserved'
  instance_count INTEGER NOT NULL,
  hourly_cost DECIMAL(10,2) NOT NULL,
  region VARCHAR(32),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cost_metrics_time ON cost_metrics(timestamp DESC);
CREATE INDEX idx_cost_metrics_service ON cost_metrics(service_name, timestamp DESC);

-- 7. 资源使用表
CREATE TABLE IF NOT EXISTS resource_usage (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  service_name VARCHAR(64) NOT NULL,
  cpu_cores DECIMAL(6,3),
  memory_gb DECIMAL(6,3),
  network_in_gb DECIMAL(8,4),
  network_out_gb DECIMAL(8,4),
  storage_gb DECIMAL(8,4),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_resource_usage_time ON resource_usage(timestamp DESC);
CREATE INDEX idx_resource_usage_service ON resource_usage(service_name, timestamp DESC);

-- 8. 插入示例数据（测试用）
INSERT INTO scheduled_events (event_type, event_name, event_start, event_end, expected_traffic_multiplier)
VALUES 
  ('promotion', 'Summer Sale Event', '2026-07-25 00:00:00', '2026-07-27 23:59:59', 2.5),
  ('holiday', 'National Day', '2026-10-01 00:00:00', '2026-10-07 23:59:59', 3.0);

-- 9. 创建视图：预测准确率统计
CREATE OR REPLACE VIEW prediction_accuracy_stats AS
SELECT 
  DATE_TRUNC('day', p.timestamp) AS day,
  COUNT(*) AS total_predictions,
  AVG(ABS(p.predicted_value - a.actual_value) / a.actual_value) AS avg_error_rate,
  1 - AVG(ABS(p.predicted_value - a.actual_value) / a.actual_value) AS accuracy,
  AVG(p.confidence) AS avg_confidence
FROM traffic_predictions p
JOIN traffic_actuals a ON p.timestamp = a.timestamp
WHERE p.timestamp > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', p.timestamp)
ORDER BY day DESC;

-- 10. 创建视图：成本趋势
CREATE OR REPLACE VIEW cost_trends AS
SELECT 
  DATE_TRUNC('hour', timestamp) AS hour,
  service_name,
  SUM(hourly_cost) AS total_cost,
  SUM(CASE WHEN instance_type = 'spot' THEN instance_count ELSE 0 END) AS spot_instances,
  SUM(CASE WHEN instance_type = 'onDemand' THEN instance_count ELSE 0 END) AS on_demand_instances,
  SUM(CASE WHEN instance_type = 'reserved' THEN instance_count ELSE 0 END) AS reserved_instances
FROM cost_metrics
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY DATE_TRUNC('hour', timestamp), service_name
ORDER BY hour DESC, service_name;

-- 11. 创建函数：自动归档旧数据
CREATE OR REPLACE FUNCTION archive_old_traffic_data()
RETURNS VOID AS $$
BEGIN
  -- 归档90天前的数据到历史表
  INSERT INTO traffic_metrics_archive
  SELECT * FROM traffic_metrics
  WHERE timestamp < NOW() - INTERVAL '90 days'
  ON CONFLICT DO NOTHING;

  -- 删除已归档的数据
  DELETE FROM traffic_metrics
  WHERE timestamp < NOW() - INTERVAL '90 days';

  RAISE NOTICE 'Archived old traffic data';
END;
$$ LANGUAGE plpgsql;

-- 12. 创建定时任务（需要 pg_cron 扩展）
-- SELECT cron.schedule('archive_traffic_data', '0 2 * * *', 'SELECT archive_old_traffic_data()');

COMMENT ON TABLE traffic_metrics IS '流量指标采集数据';
COMMENT ON TABLE traffic_predictions IS '流量预测结果';
COMMENT ON TABLE traffic_actuals IS '实际流量数据（用于验证预测）';
COMMENT ON TABLE scaling_events IS '扩缩容事件记录';
COMMENT ON TABLE scheduled_events IS '计划事件（节假日、推广活动）';
COMMENT ON TABLE cost_metrics IS '成本指标数据';
COMMENT ON TABLE resource_usage IS '资源使用统计';
