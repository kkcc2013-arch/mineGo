/**
 * 安全会话与篡改事件表迁移
 * 
 * 创建：
 * - security_sessions: 安全会话表
 * - tamper_events: 篡改事件表
 * - request_nonces: 请求 Nonce 缓存表（PostgreSQL 备份）
 * 
 * @migration 20260616180000_security_sessions
 */

-- 安全会话表
CREATE TABLE IF NOT EXISTS security_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(128) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_id VARCHAR(256) NOT NULL,
  secret_key VARCHAR(256) NOT NULL,
  tamper_count INTEGER DEFAULT 0,
  is_banned BOOLEAN DEFAULT FALSE,
  ban_reason TEXT,
  banned_at TIMESTAMPTZ,
  last_key_refresh TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  
  CONSTRAINT valid_session_id CHECK (LENGTH(session_id) >= 32)
);

-- 篡改事件表
CREATE TABLE IF NOT EXISTS tamper_events (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(128) REFERENCES security_sessions(session_id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  data_key VARCHAR(256),
  details JSONB DEFAULT '{}',
  client_ip INET,
  user_agent TEXT,
  reported_at TIMESTAMPTZ DEFAULT NOW()
);

-- 请求 Nonce 缓存表（PostgreSQL 备份，主要用于审计）
CREATE TABLE IF NOT EXISTS request_nonces (
  id SERIAL PRIMARY KEY,
  nonce VARCHAR(128) UNIQUE NOT NULL,
  session_id VARCHAR(128) REFERENCES security_sessions(session_id) ON DELETE CASCADE,
  request_path VARCHAR(512),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_security_sessions_session_id ON security_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_security_sessions_user_id ON security_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_security_sessions_device_id ON security_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_security_sessions_expires_at ON security_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_security_sessions_is_banned ON security_sessions(is_banned);
CREATE INDEX IF NOT EXISTS idx_security_sessions_created_at ON security_sessions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tamper_events_session_id ON tamper_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tamper_events_event_type ON tamper_events(event_type);
CREATE INDEX IF NOT EXISTS idx_tamper_events_reported_at ON tamper_events(reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_tamper_events_data_key ON tamper_events(data_key);

CREATE INDEX IF NOT EXISTS idx_request_nonces_nonce ON request_nonces(nonce);
CREATE INDEX IF NOT EXISTS idx_request_nonces_session_id ON request_nonces(session_id);
CREATE INDEX IF NOT EXISTS idx_request_nonces_expires_at ON request_nonces(expires_at);

-- 清理过期会话的函数
CREATE OR REPLACE FUNCTION cleanup_expired_security_sessions()
RETURNS void AS $$
BEGIN
  -- 删除过期会话（会级联删除相关的 tamper_events 和 request_nonces）
  DELETE FROM security_sessions
  WHERE expires_at < NOW() - INTERVAL '1 day';
  
  -- 删除过期的 Nonce 记录
  DELETE FROM request_nonces
  WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- 创建定时清理任务（需要 pg_cron 扩展）
-- 如果 pg_cron 不可用，可以删除此部分或手动调用 cleanup_expired_security_sessions()
-- SELECT cron.schedule('cleanup_security_sessions', '0 * * * *', 'SELECT cleanup_expired_security_sessions()');

-- 统计视图：会话安全状态
CREATE OR REPLACE VIEW v_security_session_stats AS
SELECT 
  ss.session_id,
  ss.user_id,
  ss.device_id,
  ss.tamper_count,
  ss.is_banned,
  ss.created_at,
  ss.expires_at,
  COUNT(te.id) as total_events,
  COUNT(CASE WHEN te.event_type = 'checksum_mismatch' THEN 1 END) as checksum_failures,
  COUNT(CASE WHEN te.event_type = 'signature_mismatch' THEN 1 END) as signature_failures,
  COUNT(CASE WHEN te.event_type = 'scan_detection' THEN 1 END) as scan_detections,
  COUNT(CASE WHEN te.event_type = 'replay_attack' THEN 1 END) as replay_attacks,
  MAX(te.reported_at) as last_event_at
FROM security_sessions ss
LEFT JOIN tamper_events te ON ss.session_id = te.session_id
GROUP BY ss.session_id, ss.user_id, ss.device_id, ss.tamper_count, 
         ss.is_banned, ss.created_at, ss.expires_at;

-- 统计视图：每日安全事件汇总
CREATE OR REPLACE VIEW v_daily_security_events AS
SELECT 
  DATE(reported_at) as event_date,
  event_type,
  COUNT(*) as event_count,
  COUNT(DISTINCT session_id) as affected_sessions
FROM tamper_events
GROUP BY DATE(reported_at), event_type
ORDER BY event_date DESC, event_count DESC;

-- 注释
COMMENT ON TABLE security_sessions IS '安全会话表，存储客户端安全会话信息';
COMMENT ON TABLE tamper_events IS '篡改事件表，记录所有安全相关事件';
COMMENT ON TABLE request_nonces IS '请求Nonce缓存表，用于防重放攻击审计';
COMMENT ON COLUMN security_sessions.secret_key IS '会话密钥，用于签名和加密';
COMMENT ON COLUMN security_sessions.tamper_count IS '篡改次数累计，超过阈值触发封禁';
COMMENT ON COLUMN tamper_events.event_type IS '事件类型：checksum_mismatch, signature_mismatch, scan_detection, replay_attack';
