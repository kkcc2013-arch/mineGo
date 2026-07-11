-- 多区域同步系统数据库表
-- Migration: 089_create_region_sync_tables

-- 区域配置表
CREATE TABLE IF NOT EXISTS regions (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  priority INTEGER NOT NULL,
  endpoint VARCHAR(255),
  status VARCHAR(20) DEFAULT 'unknown',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 服务健康状态表
CREATE TABLE IF NOT EXISTS service_health (
  id SERIAL PRIMARY KEY,
  region_id VARCHAR(50) NOT NULL REFERENCES regions(id),
  service_name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL,
  health_score DECIMAL(5,2) DEFAULT 0.00,
  metadata JSONB DEFAULT '{}',
  last_check_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(region_id, service_name)
);

CREATE INDEX idx_service_health_region ON service_health(region_id, last_check_at DESC);
CREATE INDEX idx_service_health_status ON service_health(status);

-- 区域指标表
CREATE TABLE IF NOT EXISTS region_metrics (
  id SERIAL PRIMARY KEY,
  region_id VARCHAR(50) NOT NULL REFERENCES regions(id),
  metric_name VARCHAR(100) NOT NULL,
  metric_value DECIMAL(15,4) NOT NULL,
  unit VARCHAR(50),
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_region_metrics_lookup ON region_metrics(region_id, metric_name, collected_at DESC);

-- 区域服务事件表
CREATE TABLE IF NOT EXISTS region_service_events (
  id SERIAL PRIMARY KEY,
  region_id VARCHAR(50) NOT NULL,
  service_name VARCHAR(100) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_region_service_events_region ON region_service_events(region_id, created_at DESC);
CREATE INDEX idx_region_service_events_type ON region_service_events(event_type);

-- 区域切换事件表
CREATE TABLE IF NOT EXISTS region_switch_events (
  id SERIAL PRIMARY KEY,
  from_region VARCHAR(50) NOT NULL,
  to_region VARCHAR(50) NOT NULL,
  reason TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) DEFAULT 'completed',
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_region_switch_events_time ON region_switch_events(executed_at DESC);

-- 仲裁历史表
CREATE TABLE IF NOT EXISTS arbitration_history (
  id SERIAL PRIMARY KEY,
  current_region VARCHAR(50) NOT NULL,
  reason VARCHAR(100) NOT NULL,
  analysis JSONB NOT NULL,
  result JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_arbitration_history_time ON arbitration_history(timestamp DESC);
CREATE INDEX idx_arbitration_history_reason ON arbitration_history(reason);

-- 区域告警表
CREATE TABLE IF NOT EXISTS region_alerts (
  id SERIAL PRIMARY KEY,
  region_id VARCHAR(50) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  severity VARCHAR(20) DEFAULT 'medium',
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_by VARCHAR(100),
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_region_alerts_region ON region_alerts(region_id, created_at DESC);
CREATE INDEX idx_region_alerts_unack ON region_alerts(acknowledged, severity);

-- 插入默认区域配置
INSERT INTO regions (id, name, priority, endpoint, status) VALUES
  ('cn-east', '华东', 1, NULL, 'unknown'),
  ('cn-north', '华北', 2, NULL, 'unknown'),
  ('cn-south', '华南', 3, NULL, 'unknown'),
  ('ap-southeast', '东南亚', 4, NULL, 'unknown')
ON CONFLICT (id) DO NOTHING;

-- 注释
COMMENT ON TABLE regions IS '区域配置表';
COMMENT ON TABLE service_health IS '服务健康状态表';
COMMENT ON TABLE region_metrics IS '区域指标表';
COMMENT ON TABLE region_service_events IS '区域服务事件表';
COMMENT ON TABLE region_switch_events IS '区域切换事件表';
COMMENT ON TABLE arbitration_history IS '仲裁历史表';
COMMENT ON TABLE region_alerts IS '区域告警表';
