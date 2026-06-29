-- REQ-00367: API 请求限流智能优化与动态配额分配系统
-- 数据库迁移脚本

-- 用户配额调整记录表
CREATE TABLE IF NOT EXISTS quota_adjustments (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  adjustment INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL CHECK (reason IN ('bonus', 'penalty', 'event', 'manual', 'system', 'anti_cheat')),
  admin_id VARCHAR(255),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quota_adjustments_user_id ON quota_adjustments(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_adjustments_created_at ON quota_adjustments(created_at);
CREATE INDEX IF NOT EXISTS idx_quota_adjustments_reason ON quota_adjustments(reason);

-- 请求成本归因表
CREATE TABLE IF NOT EXISTS request_cost_attribution (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  request_id VARCHAR(255),
  response_time_ms INTEGER,
  response_size_bytes INTEGER,
  cost_usd DECIMAL(10, 8),
  user_tier VARCHAR(50),
  priority VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_cost_user_created ON request_cost_attribution(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_cost_endpoint ON request_cost_attribution(endpoint);
CREATE INDEX IF NOT EXISTS idx_request_cost_created_at ON request_cost_attribution(created_at);

-- 用户使用历史表（用于预测分析）
CREATE TABLE IF NOT EXISTS user_usage_history (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour < 24),
  request_count INTEGER DEFAULT 0,
  endpoint_breakdown JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, date, hour)
);

CREATE INDEX IF NOT EXISTS idx_user_usage_date ON user_usage_history(date);
CREATE INDEX IF NOT EXISTS idx_user_usage_user_date ON user_usage_history(user_id, date);

-- 用户层级配额定义表
CREATE TABLE IF NOT EXISTS user_tier_quotas (
  id SERIAL PRIMARY KEY,
  tier_name VARCHAR(50) NOT NULL UNIQUE,
  requests_per_day INTEGER NOT NULL,
  requests_per_hour INTEGER NOT NULL,
  requests_per_minute INTEGER NOT NULL,
  priority_weight INTEGER DEFAULT 1,
  features JSONB,
  cost_multiplier DECIMAL(5, 2) DEFAULT 1.0,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认层级配置
INSERT INTO user_tier_quotas (tier_name, requests_per_day, requests_per_hour, requests_per_minute, priority_weight, features, description)
VALUES
  ('free', 1000, 100, 20, 1, '{"features": ["basic_catch", "basic_battle", "view_pokemon"]}', '免费用户基础套餐'),
  ('premium', 10000, 500, 100, 2, '{"features": ["all_basic", "advanced_battle", "trade", "special_events"]}', '付费用户高级套餐'),
  ('vip', 50000, 2000, 400, 4, '{"features": ["all_features", "early_access", "exclusive_pokemon", "priority_queue"]}', 'VIP用户专属套餐'),
  ('svip', 100000, 5000, 1000, 5, '{"features": ["all_features", "api_access", "custom_limits", "white_glove_service"]}', '超级VIP企业套餐')
ON CONFLICT (tier_name) DO UPDATE SET
  requests_per_day = EXCLUDED.requests_per_day,
  requests_per_hour = EXCLUDED.requests_per_hour,
  requests_per_minute = EXCLUDED.requests_per_minute,
  priority_weight = EXCLUDED.priority_weight,
  features = EXCLUDED.features,
  description = EXCLUDED.description,
  updated_at = NOW();

-- 优先级队列状态表
CREATE TABLE IF NOT EXISTS priority_queue_stats (
  id SERIAL PRIMARY KEY,
  queue_name VARCHAR(20) NOT NULL,
  queue_size INTEGER DEFAULT 0,
  dequeued_count INTEGER DEFAULT 0,
  avg_wait_time_ms INTEGER DEFAULT 0,
  max_wait_time_ms INTEGER DEFAULT 0,
  rejection_count INTEGER DEFAULT 0,
  snapshot_time TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_priority_queue_stats_time ON priority_queue_stats(snapshot_time);

-- 配额预警记录表
CREATE TABLE IF NOT EXISTS quota_warnings (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  warning_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  message TEXT,
  usage_percentage DECIMAL(5, 2),
  recommendation TEXT,
  acknowledged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quota_warnings_user ON quota_warnings(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_warnings_created ON quota_warnings(created_at);
CREATE INDEX IF NOT EXISTS idx_quota_warnings_severity ON quota_warnings(severity);

-- 添加 comment
COMMENT ON TABLE quota_adjustments IS '用户配额调整记录，记录配额增减及原因';
COMMENT ON TABLE request_cost_attribution IS '请求成本归因数据，用于成本分析和优化建议';
COMMENT ON TABLE user_usage_history IS '用户历史使用数据，用于配额预测和趋势分析';
COMMENT ON TABLE user_tier_quotas IS '用户层级配额定义，各层级配额标准和特权';
COMMENT ON TABLE priority_queue_stats IS '优先级队列统计，监控队列运行状态';
COMMENT ON TABLE quota_warnings IS '配额预警记录，记录用户配额使用预警';