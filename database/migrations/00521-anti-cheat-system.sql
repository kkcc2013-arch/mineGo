-- REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
-- 数据库迁移：创建相关表结构

-- 设备指纹表
CREATE TABLE IF NOT EXISTS device_fingerprints (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(100) NOT NULL,
  fingerprint_hash VARCHAR(64) NOT NULL,
  device_info JSONB NOT NULL,
  security_flags JSONB,
  trust_score INTEGER DEFAULT 100,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_trusted BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, fingerprint_hash)
);

COMMENT ON TABLE device_fingerprints IS '设备指纹注册表，用于识别和追踪用户设备';

CREATE INDEX IF NOT EXISTS idx_device_fingerprints_user ON device_fingerprints(user_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_hash ON device_fingerprints(fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_trust ON device_fingerprints(trust_score);

-- 捕捉验证记录表
CREATE TABLE IF NOT EXISTS capture_validations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  capture_session_id VARCHAR(100) NOT NULL,
  validation_result JSONB NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  action_taken VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE capture_validations IS '捕捉请求验证记录，记录每次捕捉验证的结果';

CREATE INDEX IF NOT EXISTS idx_capture_validations_user ON capture_validations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_validations_risk ON capture_validations(risk_level, created_at);
CREATE INDEX IF NOT EXISTS idx_capture_validations_session ON capture_validations(capture_session_id);

-- 违规记录表
CREATE TABLE IF NOT EXISTS security_violations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  violation_type VARCHAR(50) NOT NULL,
  severity INTEGER NOT NULL CHECK (severity >= 0 AND severity <= 100),
  evidence JSONB NOT NULL,
  response_type VARCHAR(50),
  response_details JSONB,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id)
);

COMMENT ON TABLE security_violations IS '安全违规记录，记录用户违规行为和处理结果';

CREATE INDEX IF NOT EXISTS idx_security_violations_user ON security_violations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_violations_status ON security_violations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_security_violations_type ON security_violations(violation_type, created_at);

-- 用户影子封禁表
CREATE TABLE IF NOT EXISTS user_shadow_bans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effects JSONB NOT NULL,
  reason VARCHAR(100),
  severity INTEGER CHECK (severity >= 0 AND severity <= 100),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE user_shadow_bans IS '用户影子封禁状态，实现降权效果';

CREATE INDEX IF NOT EXISTS idx_user_shadow_bans_user ON user_shadow_bans(user_id);
CREATE INDEX IF NOT EXISTS idx_user_shadow_bans_expires ON user_shadow_bans(expires_at);

-- 用户监控标记表
CREATE TABLE IF NOT EXISTS user_monitoring_flags (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(100),
  severity INTEGER CHECK (severity >= 0 AND severity <= 100),
  evidence JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE user_monitoring_flags IS '用户监控标记，记录需要增强监控的用户';

CREATE INDEX IF NOT EXISTS idx_user_monitoring_flags_user ON user_monitoring_flags(user_id, created_at DESC);

-- 安全申诉表
CREATE TABLE IF NOT EXISTS security_appeals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  violation_id INTEGER NOT NULL REFERENCES security_violations(id),
  appeal_reason TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP,
  reviewed_by INTEGER REFERENCES users(id)
);

COMMENT ON TABLE security_appeals IS '安全违规申诉记录';

CREATE INDEX IF NOT EXISTS idx_security_appeals_user ON security_appeals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_appeals_status ON security_appeals(status, created_at);

-- 捕捉会话表（扩展）
CREATE TABLE IF NOT EXISTS capture_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  status VARCHAR(50) DEFAULT 'active'
);

COMMENT ON TABLE capture_sessions IS '捕捉会话记录，用于验证捕捉窗口';

CREATE INDEX IF NOT EXISTS idx_capture_sessions_session ON capture_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_capture_sessions_user ON capture_sessions(user_id, created_at DESC);

-- 捕捉尝试记录表
CREATE TABLE IF NOT EXISTS capture_attempts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  session_id VARCHAR(100) REFERENCES capture_sessions(session_id),
  result VARCHAR(50) NOT NULL,
  risk_score INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE capture_attempts IS '捕捉尝试记录，用于统计捕捉成功率';

CREATE INDEX IF NOT EXISTS idx_capture_attempts_user ON capture_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_attempts_session ON capture_attempts(session_id);

-- 添加用户表的违规相关字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS warning_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_warning_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP;

COMMENT ON COLUMN users.warning_count IS '用户累计警告次数';
COMMENT ON COLUMN users.last_warning_at IS '最后一次警告时间';
COMMENT ON COLUMN users.suspension_reason IS '暂停原因';
COMMENT ON COLUMN users.suspended_until IS '暂停到期时间';
COMMENT ON COLUMN users.suspended_at IS '暂停开始时间';
COMMENT ON COLUMN users.ban_reason IS '封禁原因';
COMMENT ON COLUMN users.banned_at IS '封禁时间';

-- 插入初始数据
INSERT INTO device_fingerprints (user_id, device_id, fingerprint_hash, device_info, security_flags, trust_score)
SELECT 
  1,
  'test-device-001',
  'abc123def456',
  '{"platform": "android", "model": "Pixel 6", "osVersion": "12"}',
  '{"emulatorDetected": false, "rootDetected": false}',
  100
WHERE NOT EXISTS (SELECT 1 FROM device_fingerprints WHERE device_id = 'test-device-001');

-- 创建触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_device_fingerprints_updated_at
  BEFORE UPDATE ON device_fingerprints
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_shadow_bans_updated_at
  BEFORE UPDATE ON user_shadow_bans
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();