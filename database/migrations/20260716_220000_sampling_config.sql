-- 采样率配置表
-- REQ-00582: 微服务链路追踪采样率智能自适应与成本优化系统

CREATE TABLE IF NOT EXISTS sampling_config (
  service_name VARCHAR(100) PRIMARY KEY,
  base_rate DECIMAL(5,4) DEFAULT 0.01,
  min_rate DECIMAL(5,4) DEFAULT 0.001,
  max_rate DECIMAL(5,4) DEFAULT 1.0,
  error_rate DECIMAL(5,4) DEFAULT 1.0,
  slow_threshold_ms INTEGER DEFAULT 1000,
  adaptive_enabled BOOLEAN DEFAULT true,
  priority_rules JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sampling_config_service ON sampling_config(service_name);

-- 采样历史记录表
CREATE TABLE IF NOT EXISTS sampling_history (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  current_rate DECIMAL(5,4) NOT NULL,
  qps DECIMAL(10,2),
  error_rate DECIMAL(5,4),
  slow_request_ratio DECIMAL(5,4),
  avg_latency DECIMAL(10,2),
  sampled_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sampling_history_service ON sampling_history(service_name);
CREATE INDEX IF NOT EXISTS idx_sampling_history_created ON sampling_history(created_at);

-- 初始配置
INSERT INTO sampling_config (service_name, base_rate, min_rate, max_rate, error_rate, slow_threshold_ms)
VALUES
  ('gateway', 0.01, 0.001, 1.0, 1.0, 1000),
  ('user-service', 0.01, 0.001, 1.0, 1.0, 1000),
  ('location-service', 0.01, 0.001, 1.0, 1.0, 1000),
  ('pokemon-service', 0.01, 0.001, 1.0, 1.0, 1000),
  ('catch-service', 0.05, 0.001, 1.0, 1.0, 500),
  ('gym-service', 0.01, 0.001, 1.0, 1.0, 1000),
  ('social-service', 0.01, 0.001, 1.0, 1.0, 1000),
  ('reward-service', 0.01, 0.001, 1.0, 1.0, 1000),
  ('payment-service', 0.1, 0.01, 1.0, 1.0, 500)
ON CONFLICT (service_name) DO NOTHING;

COMMENT ON TABLE sampling_config IS '采样率配置表';
COMMENT ON TABLE sampling_history IS '采样历史记录表';