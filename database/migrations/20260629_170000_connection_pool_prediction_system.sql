-- database/migrations/20260629_170000_connection_pool_prediction_system.sql
-- REQ-00362: 数据库连接池智能预测与预分配系统

-- 流量预测历史表
CREATE TABLE IF NOT EXISTS connection_pool_predictions (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  prediction_time TIMESTAMPTZ NOT NULL,
  predicted_connections INTEGER NOT NULL,
  confidence_score DECIMAL(3,2),
  model_version VARCHAR(20),
  features JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predictions_service_time 
  ON connection_pool_predictions(service_name, prediction_time);

-- 预分配调度记录表
CREATE TABLE IF NOT EXISTS connection_pool_schedules (
  id VARCHAR(100) PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('scale_up', 'scale_down', 'preallocate')),
  target_connections INTEGER NOT NULL,
  current_connections INTEGER NOT NULL,
  trigger_reason VARCHAR(50),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedules_service_status 
  ON connection_pool_schedules(service_name, status, created_at);

CREATE INDEX IF NOT EXISTS idx_schedules_created 
  ON connection_pool_schedules(created_at DESC);

-- 流量模式特征表
CREATE TABLE IF NOT EXISTS traffic_patterns (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  pattern_type VARCHAR(20) NOT NULL CHECK (pattern_type IN ('hourly', 'daily', 'weekly', 'event')),
  pattern_key VARCHAR(50) NOT NULL,
  avg_connections INTEGER NOT NULL,
  peak_connections INTEGER NOT NULL,
  confidence DECIMAL(3,2) DEFAULT 0.5,
  sample_count INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(service_name, pattern_type, pattern_key)
);

CREATE INDEX IF NOT EXISTS idx_patterns_service 
  ON traffic_patterns(service_name);

CREATE INDEX IF NOT EXISTS idx_patterns_last_updated 
  ON traffic_patterns(last_updated DESC);

-- 活动预热配置表
CREATE TABLE IF NOT EXISTS event_preheat_configs (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(100) NOT NULL UNIQUE,
  event_name VARCHAR(200),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  expected_rpm INTEGER,
  preheat_minutes INTEGER DEFAULT 10,
  target_connections INTEGER,
  services JSONB,
  status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'preheating', 'active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_preheat_time 
  ON event_preheat_configs(start_time, status);

CREATE INDEX IF NOT EXISTS idx_event_preheat_status 
  ON event_preheat_configs(status);

-- 连接池历史数据表（用于模式学习）
CREATE TABLE IF NOT EXISTS connection_pool_history (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  connection_count INTEGER NOT NULL,
  pool_usage_percent DECIMAL(5,2)
);

-- 分区表（按天分区）
CREATE INDEX IF NOT EXISTS idx_pool_history_service_time 
  ON connection_pool_history(service_name, timestamp);

-- 预测准确率评估表
CREATE TABLE IF NOT EXISTS prediction_accuracy (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  evaluation_time TIMESTAMPTZ DEFAULT NOW(),
  mape DECIMAL(5,4), -- Mean Absolute Percentage Error
  accuracy DECIMAL(5,4),
  sample_count INTEGER,
  model_version VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_accuracy_service_time 
  ON prediction_accuracy(service_name, evaluation_time);

-- 初始化默认流量模式
INSERT INTO traffic_patterns (service_name, pattern_type, pattern_key, avg_connections, peak_connections, confidence)
VALUES 
-- user-service 模式
('user-service', 'hourly', '18:00', 50, 120, 0.5),
('user-service', 'hourly', '19:00', 55, 130, 0.5),
('user-service', 'hourly', '20:00', 60, 150, 0.5),
('user-service', 'daily', 'friday', 45, 130, 0.5),
('user-service', 'daily', 'saturday', 50, 150, 0.5),
-- catch-service 模式
('catch-service', 'hourly', '18:00', 40, 100, 0.5),
('catch-service', 'hourly', '19:00', 45, 110, 0.5),
('catch-service', 'hourly', '20:00', 50, 130, 0.5),
-- location-service 模式
('location-service', 'hourly', '18:00', 30, 80, 0.5),
('location-service', 'hourly', '19:00', 35, 90, 0.5),
ON CONFLICT (service_name, pattern_type, pattern_key) DO NOTHING;

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_event_preheat_updated_at
  BEFORE UPDATE ON event_preheat_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE connection_pool_predictions IS 'REQ-00362: 连接池预测历史记录';
COMMENT ON TABLE connection_pool_schedules IS 'REQ-00362: 预分配调度记录';
COMMENT ON TABLE traffic_patterns IS 'REQ-00362: 流量模式特征';
COMMENT ON TABLE event_preheat_configs IS 'REQ-00362: 活动预热配置';
COMMENT ON TABLE connection_pool_history IS 'REQ-00362: 连接池历史数据';
COMMENT ON TABLE prediction_accuracy IS 'REQ-00362: 预测准确率评估';
