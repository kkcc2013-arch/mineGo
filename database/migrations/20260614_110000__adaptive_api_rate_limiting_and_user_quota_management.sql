-- REQ-00098: 自适应 API 限流与用户配额管理系统
-- 创建时间: 2026-06-14

-- =====================================================
-- 1. 用户配额表
-- =====================================================
CREATE TABLE IF NOT EXISTS user_quotas (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  quota_level VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (quota_level IN ('free', 'vip', 'svip')),
  daily_limit INTEGER NOT NULL DEFAULT 1000,
  hourly_limit INTEGER NOT NULL DEFAULT 100,
  minute_limit INTEGER NOT NULL DEFAULT 20,
  used_today INTEGER NOT NULL DEFAULT 0,
  used_this_hour INTEGER NOT NULL DEFAULT 0,
  used_this_minute INTEGER NOT NULL DEFAULT 0,
  quota_multiplier DECIMAL(3,2) DEFAULT 1.00 CHECK (quota_multiplier >= 0.1 AND quota_multiplier <= 5.0),
  multiplier_reason VARCHAR(255),
  multiplier_expires_at TIMESTAMP,
  last_reset_date DATE NOT NULL DEFAULT CURRENT_DATE,
  last_reset_hour INTEGER NOT NULL DEFAULT EXTRACT(HOUR FROM NOW())::INTEGER,
  last_reset_minute INTEGER NOT NULL DEFAULT EXTRACT(MINUTE FROM NOW())::INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_quotas_user_id ON user_quotas(user_id);
CREATE INDEX IF NOT EXISTS idx_user_quotas_level ON user_quotas(quota_level);
CREATE INDEX IF NOT EXISTS idx_user_quotas_multiplier_expires ON user_quotas(multiplier_expires_at) WHERE multiplier_expires_at IS NOT NULL;

-- =====================================================
-- 2. API 分级配置表
-- =====================================================
CREATE TABLE IF NOT EXISTS api_tier_configs (
  id SERIAL PRIMARY KEY,
  api_pattern VARCHAR(255) NOT NULL UNIQUE,
  tier VARCHAR(20) NOT NULL CHECK (tier IN ('critical', 'important', 'normal')),
  base_limit_per_minute INTEGER NOT NULL,
  burst_limit INTEGER NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_tier_configs_tier ON api_tier_configs(tier);
CREATE INDEX IF NOT EXISTS idx_api_tier_configs_enabled ON api_tier_configs(enabled);

-- =====================================================
-- 3. 配额使用记录表（审计日志）
-- =====================================================
CREATE TABLE IF NOT EXISTS quota_usage_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_pattern VARCHAR(255) NOT NULL,
  tier VARCHAR(20) NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  was_blocked BOOLEAN DEFAULT false,
  user_level VARCHAR(20),
  quota_remaining INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_logs_user_id ON quota_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_usage_logs_created_at ON quota_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_quota_usage_logs_blocked ON quota_usage_logs(was_blocked) WHERE was_blocked = true;

-- =====================================================
-- 4. 配额配置历史表
-- =====================================================
CREATE TABLE IF NOT EXISTS quota_config_history (
  id SERIAL PRIMARY KEY,
  quota_level VARCHAR(20) NOT NULL,
  old_config JSONB NOT NULL,
  new_config JSONB NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- 5. 自适应限流状态表
-- =====================================================
CREATE TABLE IF NOT EXISTS adaptive_rate_limit_state (
  id SERIAL PRIMARY KEY,
  api_pattern VARCHAR(255) NOT NULL UNIQUE,
  base_limit INTEGER NOT NULL,
  current_limit INTEGER NOT NULL,
  load_factor DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  system_load_score INTEGER CHECK (system_load_score >= 0 AND system_load_score <= 100),
  last_adjusted_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- 6. 默认配额配置
-- =====================================================
INSERT INTO user_quotas (user_id, quota_level, daily_limit, hourly_limit, minute_limit)
SELECT id, 'free', 1000, 100, 20
FROM users
WHERE NOT EXISTS (SELECT 1 FROM user_quotas WHERE user_quotas.user_id = users.id)
ON CONFLICT (user_id) DO NOTHING;

-- =====================================================
-- 7. API 分级配置种子数据
-- =====================================================
INSERT INTO api_tier_configs (api_pattern, tier, base_limit_per_minute, burst_limit, description) VALUES
  ('/api/v2/payment/*', 'critical', 10, 15, '支付相关 API - 最高优先级保护'),
  ('/api/v2/catch/*', 'critical', 30, 50, '捕捉精灵 API - 核心游戏功能'),
  ('/api/v2/gym/battle/*', 'critical', 20, 30, '道馆战斗 API - 核心游戏功能'),
  ('/api/v2/gym/raid/*', 'critical', 15, 25, '团队副本 API - 核心游戏功能'),
  ('/api/v2/pokemon/trade/*', 'important', 30, 50, '精灵交易 API - 重要功能'),
  ('/api/v2/pokemon/evolve/*', 'important', 40, 60, '精灵进化 API - 重要功能'),
  ('/api/v2/pokemon/*', 'important', 60, 100, '精灵管理 API - 重要功能'),
  ('/api/v2/social/trade/*', 'important', 30, 50, '社交交易 API - 重要功能'),
  ('/api/v2/social/friends/*', 'important', 60, 100, '好友系统 API - 重要功能'),
  ('/api/v2/social/pvp/*', 'important', 40, 60, 'PVP 对战 API - 重要功能'),
  ('/api/v2/reward/*', 'important', 40, 60, '奖励系统 API - 重要功能'),
  ('/api/v2/location/nearby/*', 'normal', 120, 200, '附近查询 API - 普通功能'),
  ('/api/v2/location/*', 'normal', 120, 200, '位置服务 API - 普通功能'),
  ('/api/v2/user/profile/*', 'normal', 100, 150, '用户资料 API - 普通功能'),
  ('/api/v2/user/*', 'normal', 120, 200, '用户服务 API - 普通功能')
ON CONFLICT (api_pattern) DO NOTHING;

-- =====================================================
-- 8. 触发器：自动更新 updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_quotas_updated_at
  BEFORE UPDATE ON user_quotas
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_tier_configs_updated_at
  BEFORE UPDATE ON api_tier_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_adaptive_rate_limit_state_updated_at
  BEFORE UPDATE ON adaptive_rate_limit_state
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 9. 注释
-- =====================================================
COMMENT ON TABLE user_quotas IS '用户配额表 - 存储每个用户的 API 调用配额';
COMMENT ON TABLE api_tier_configs IS 'API 分级配置表 - 定义不同 API 的限流策略';
COMMENT ON TABLE quota_usage_logs IS '配额使用记录表 - 审计日志';
COMMENT ON TABLE quota_config_history IS '配额配置历史表 - 记录配置变更';
COMMENT ON TABLE adaptive_rate_limit_state IS '自适应限流状态表 - 记录当前限流状态';
