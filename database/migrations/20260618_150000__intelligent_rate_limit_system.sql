-- REQ-00234: API 请求速率限制智能适配与动态配额系统
-- 数据库迁移：用户违规记录、游戏行为统计、临时配额提升记录

-- 用户违规记录表
CREATE TABLE IF NOT EXISTS user_violations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_violations_user_id ON user_violations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_violations_created_at ON user_violations(created_at);
CREATE INDEX IF NOT EXISTS idx_user_violations_severity ON user_violations(severity);

-- 用户游戏行为统计表
CREATE TABLE IF NOT EXISTS user_gameplay_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catch_rate DECIMAL(5,4),
  battle_win_rate DECIMAL(5,4),
  is_suspicious BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_gameplay_stats_user_id ON user_gameplay_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_user_gameplay_stats_created_at ON user_gameplay_stats(created_at);
CREATE INDEX IF NOT EXISTS idx_user_gameplay_stats_suspicious ON user_gameplay_stats(is_suspicious);

-- 临时配额提升记录表
CREATE TABLE IF NOT EXISTS rate_limit_boosts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  multiplier DECIMAL(3,2) NOT NULL,
  duration_seconds INTEGER NOT NULL,
  reason TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  granted_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_boosts_user_id ON rate_limit_boosts(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_boosts_expires_at ON rate_limit_boosts(expires_at);

-- 触发器：自动清理过期的提升记录
CREATE OR REPLACE FUNCTION cleanup_expired_boosts()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM rate_limit_boosts WHERE expires_at < NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_cleanup_expired_boosts ON rate_limit_boosts;
CREATE TRIGGER trigger_cleanup_expired_boosts
AFTER INSERT ON rate_limit_boosts
EXECUTE FUNCTION cleanup_expired_boosts();

-- 用户举报记录表（用于社交信任度计算）
CREATE TABLE IF NOT EXISTS user_reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'valid', 'invalid', 'dismissed')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_id ON user_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_reported_user_id ON user_reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status);

-- API 访问日志表（用于活跃一致性计算）
CREATE TABLE IF NOT EXISTS api_access_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  ip VARCHAR(45),
  user_agent TEXT,
  status_code INTEGER,
  response_time_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_access_logs_user_id ON api_access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_access_logs_created_at ON api_access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_access_logs_endpoint ON api_access_logs(endpoint);

-- 评论：分区表优化（可选）
-- 对于高流量系统，可考虑按时间分区 api_access_logs 表
-- 例如：按月分区，保留最近 3 个月数据

-- 添加表注释
COMMENT ON TABLE user_violations IS '用户违规记录，用于信誉度计算';
COMMENT ON TABLE user_gameplay_stats IS '用户游戏行为统计，用于检测异常行为';
COMMENT ON TABLE rate_limit_boosts IS '临时配额提升记录，活动期间可临时提升用户限流配额';
COMMENT ON TABLE user_reports IS '用户举报记录，用于社交信任度计算';
COMMENT ON TABLE api_access_logs IS 'API 访问日志，用于活跃一致性计算和限流分析';
