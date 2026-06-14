-- REQ-00111: API 安全响应头与 CSP 强化系统
-- 安全相关数据库表

-- CSP 违规报告表
CREATE TABLE IF NOT EXISTS csp_violation_reports (
  id SERIAL PRIMARY KEY,
  document_uri TEXT NOT NULL,
  violated_directive VARCHAR(255) NOT NULL,
  blocked_uri TEXT,
  source_file TEXT,
  line_number INTEGER,
  column_number INTEGER,
  user_agent TEXT,
  ip_address INET,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_csp_reports_created_at ON csp_violation_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_csp_reports_directive ON csp_violation_reports(violated_directive);
CREATE INDEX IF NOT EXISTS idx_csp_reports_user ON csp_violation_reports(user_id);

-- 安全事件审计表
CREATE TABLE IF NOT EXISTS security_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  details JSONB DEFAULT '{}',
  severity VARCHAR(20) DEFAULT 'medium',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);

-- CSRF 令牌黑名单（用于撤销）
CREATE TABLE IF NOT EXISTS csrf_token_blacklist (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(255),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_csrf_blacklist_token ON csrf_token_blacklist(token_hash);
CREATE INDEX IF NOT EXISTS idx_csrf_blacklist_expires ON csrf_token_blacklist(expires_at);

-- 安全配置表（动态配置安全策略）
CREATE TABLE IF NOT EXISTS security_config (
  id SERIAL PRIMARY KEY,
  config_key VARCHAR(100) NOT NULL UNIQUE,
  config_value JSONB NOT NULL,
  description TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入默认配置
INSERT INTO security_config (config_key, config_value, description) VALUES
  ('csp.enabled', 'true', '启用 CSP 策略'),
  ('csp.report_only', 'false', 'CSP 仅报告模式（用于测试）'),
  ('csrf.enabled', 'true', '启用 CSRF 保护'),
  ('csrf.token_ttl', '86400', 'CSRF 令牌有效期（秒）'),
  ('origin_check.enabled', 'true', '启用 Origin 验证'),
  ('security_headers.enabled', 'true', '启用安全响应头')
ON CONFLICT (config_key) DO NOTHING;

-- 注释
COMMENT ON TABLE csp_violation_reports IS 'CSP 违规报告记录';
COMMENT ON TABLE security_events IS '安全事件审计日志';
COMMENT ON TABLE csrf_token_blacklist IS 'CSRF 令牌黑名单';
COMMENT ON TABLE security_config IS '安全策略动态配置';
