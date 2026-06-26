-- REQ-00327: 会话劫持防护与安全会话管理系统
-- 数据库迁移脚本

-- =====================================================
-- 用户会话表
-- =====================================================
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash VARCHAR(64) NOT NULL UNIQUE,
  refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
  device_fingerprint VARCHAR(255) NOT NULL,
  device_name VARCHAR(100),
  device_type VARCHAR(20), -- mobile, desktop, tablet
  ip_address INET NOT NULL,
  user_agent TEXT,
  geo_location JSONB, -- {country, city, lat, lng}
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  is_suspicious BOOLEAN DEFAULT false,
  risk_score INTEGER DEFAULT 0 -- 风险评分 0-100
);

-- 索引
CREATE INDEX idx_user_sessions_user_active ON user_sessions(user_id, is_active, last_activity_at DESC);
CREATE INDEX idx_user_sessions_token ON user_sessions(session_token_hash);
CREATE INDEX idx_user_sessions_refresh ON user_sessions(refresh_token_hash);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at) WHERE is_active = true;
CREATE INDEX idx_user_sessions_suspicious ON user_sessions(is_suspicious) WHERE is_suspicious = true;

COMMENT ON TABLE user_sessions IS '用户会话管理表';
COMMENT ON COLUMN user_sessions.session_token_hash IS '会话令牌哈希值';
COMMENT ON COLUMN user_sessions.refresh_token_hash IS '刷新令牌哈希值';
COMMENT ON COLUMN user_sessions.device_fingerprint IS '设备指纹';
COMMENT ON COLUMN user_sessions.geo_location IS '地理位置信息 JSON';
COMMENT ON COLUMN user_sessions.is_suspicious IS '是否标记为可疑会话';
COMMENT ON COLUMN user_sessions.risk_score IS '会话风险评分 0-100';

-- =====================================================
-- 会话审计日志表
-- =====================================================
CREATE TABLE IF NOT EXISTS session_audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES user_sessions(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL, -- created, refreshed, destroyed, hijacked_detected, geo_anomaly, device_change
  device_fingerprint VARCHAR(255),
  ip_address INET,
  geo_location JSONB,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_session_audit_user_time ON session_audit_logs(user_id, created_at DESC);
CREATE INDEX idx_session_audit_action ON session_audit_logs(action, created_at DESC);
CREATE INDEX idx_session_audit_session ON session_audit_logs(session_id, created_at DESC);

COMMENT ON TABLE session_audit_logs IS '会话审计日志表';
COMMENT ON COLUMN session_audit_logs.action IS '会话操作类型';
COMMENT ON COLUMN session_audit_logs.metadata IS '额外元数据';

-- =====================================================
-- 会话异常事件表
-- =====================================================
CREATE TABLE IF NOT EXISTS session_anomaly_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES user_sessions(id) ON DELETE SET NULL,
  anomaly_type VARCHAR(50) NOT NULL, -- geo_jump, device_change, concurrent_limit, ip_change, suspicious_location
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  details JSONB,
  detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE,
  action_taken VARCHAR(50), -- none, logged, challenged, terminated
  resolution_notes TEXT
);

-- 索引
CREATE INDEX idx_session_anomaly_user ON session_anomaly_events(user_id, detected_at DESC);
CREATE INDEX idx_session_anomaly_severity ON session_anomaly_events(severity, resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_session_anomaly_type ON session_anomaly_events(anomaly_type, detected_at DESC);

COMMENT ON TABLE session_anomaly_events IS '会话异常事件表';
COMMENT ON COLUMN session_anomaly_events.anomaly_type IS '异常类型';
COMMENT ON COLUMN session_anomaly_events.severity IS '严重程度';
COMMENT ON COLUMN session_anomaly_events.action_taken IS '采取的处理措施';

-- =====================================================
-- 用户设备绑定表（信任设备列表）
-- =====================================================
CREATE TABLE IF NOT EXISTS user_trusted_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_fingerprint VARCHAR(255) NOT NULL,
  device_name VARCHAR(100),
  device_type VARCHAR(20),
  first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  is_trusted BOOLEAN DEFAULT false,
  trust_level VARCHAR(20) DEFAULT 'low', -- low, medium, high
  verification_count INTEGER DEFAULT 0,
  metadata JSONB,
  UNIQUE(user_id, device_fingerprint)
);

-- 索引
CREATE INDEX idx_trusted_devices_user ON user_trusted_devices(user_id, last_seen_at DESC);
CREATE INDEX idx_trusted_devices_trusted ON user_trusted_devices(user_id, is_trusted) WHERE is_trusted = true;

COMMENT ON TABLE user_trusted_devices IS '用户信任设备列表';
COMMENT ON COLUMN user_trusted_devices.trust_level IS '设备信任级别';
COMMENT ON COLUMN user_trusted_devices.verification_count IS '验证通过次数';

-- =====================================================
-- 会话配置参数表
-- =====================================================
CREATE TABLE IF NOT EXISTS session_config (
  id SERIAL PRIMARY KEY,
  config_key VARCHAR(100) NOT NULL UNIQUE,
  config_value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id)
);

-- 插入默认配置
INSERT INTO session_config (config_key, config_value, description) VALUES
  ('max_concurrent_sessions', '5', '单用户最大并发会话数'),
  ('access_token_ttl', '900', '访问令牌有效期（秒），默认 15 分钟'),
  ('refresh_token_ttl', '604800', '刷新令牌有效期（秒），默认 7 天'),
  ('geo_jump_threshold_km', '500', '地理位置跳变阈值（公里）'),
  ('max_device_changes_per_hour', '3', '每小时最大设备切换次数'),
  ('max_ip_changes_per_hour', '5', '每小时最大 IP 变更次数'),
  ('strict_ip_check', 'false', '是否启用严格 IP 检查'),
  ('session_activity_update_interval', '60', '会话活动更新间隔（秒）'),
  ('suspicious_risk_score_threshold', '70', '可疑会话风险评分阈值')
ON CONFLICT (config_key) DO NOTHING;

COMMENT ON TABLE session_config IS '会话配置参数表';

-- =====================================================
-- 清理过期会话的定时任务函数
-- =====================================================
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS void AS $$
BEGIN
  -- 软删除过期会话
  UPDATE user_sessions
  SET is_active = false
  WHERE is_active = true
    AND expires_at < NOW();
  
  -- 删除 30 天前的审计日志
  DELETE FROM session_audit_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
  
  -- 删除 90 天前的异常事件
  DELETE FROM session_anomaly_events
  WHERE detected_at < NOW() - INTERVAL '90 days'
    AND resolved_at IS NOT NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_sessions() IS '清理过期会话和旧日志';

-- =====================================================
-- 触发器：自动更新 last_activity_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_session_activity()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_activity_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 注意：如果触发器已存在，先删除再创建
DROP TRIGGER IF EXISTS trigger_update_session_activity ON user_sessions;
CREATE TRIGGER trigger_update_session_activity
  BEFORE UPDATE ON user_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_session_activity();

-- =====================================================
-- 视图：活跃会话统计
-- =====================================================
CREATE OR REPLACE VIEW v_active_sessions_stats AS
SELECT
  user_id,
  COUNT(*) AS total_active_sessions,
  COUNT(*) FILTER (WHERE is_suspicious = true) AS suspicious_sessions,
  COUNT(DISTINCT device_fingerprint) AS unique_devices,
  MAX(last_activity_at) AS last_activity,
  AVG(risk_score) AS avg_risk_score
FROM user_sessions
WHERE is_active = true
  AND expires_at > NOW()
GROUP BY user_id;

COMMENT ON VIEW v_active_sessions_stats IS '活跃会话统计视图';

-- =====================================================
-- 视图：最近异常事件
-- =====================================================
CREATE OR REPLACE VIEW v_recent_anomalies AS
SELECT
  sae.id,
  sae.user_id,
  u.username,
  sae.session_id,
  sae.anomaly_type,
  sae.severity,
  sae.details,
  sae.detected_at,
  sae.action_taken,
  us.device_name,
  us.ip_address
FROM session_anomaly_events sae
JOIN users u ON u.id = sae.user_id
LEFT JOIN user_sessions us ON us.id = sae.session_id
WHERE sae.resolved_at IS NULL
ORDER BY
  CASE sae.severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  sae.detected_at DESC;

COMMENT ON VIEW v_recent_anomalies IS '最近未处理的异常事件';

-- 授权（如果需要）
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO minego_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO minego_user;
