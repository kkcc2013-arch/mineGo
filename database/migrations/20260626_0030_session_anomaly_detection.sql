-- REQ-00219: 会话异常检测与自动防护系统
-- 数据库迁移：创建会话绑定表和异常事件表

-- 会话绑定表
CREATE TABLE IF NOT EXISTS session_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id VARCHAR(255) NOT NULL UNIQUE,
  device_fingerprint VARCHAR(255) NOT NULL,
  device_info JSONB DEFAULT '{}',
  bind_ip INET,
  bind_geo GEOGRAPHY(POINT, 4326),
  bind_city VARCHAR(100),
  bind_country VARCHAR(50),
  risk_score INTEGER DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'terminated', 'locked', 'mfa_pending')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  terminated_at TIMESTAMP WITH TIME ZONE,
  terminate_reason VARCHAR(100),
  mfa_verified BOOLEAN DEFAULT FALSE,
  trusted_device BOOLEAN DEFAULT FALSE
);

-- 会话异常事件表
CREATE TABLE IF NOT EXISTS session_anomaly_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES session_bindings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
    'ip_change', 
    'geo_jump', 
    'device_switch', 
    'multi_device',
    'abnormal_time',
    'high_frequency',
    'sensitive_operation',
    'brute_force_attempt',
    'token_reuse'
  )),
  risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
  details JSONB DEFAULT '{}',
  action_taken VARCHAR(50) CHECK (action_taken IN (
    'logged',
    'notified',
    'mfa_required',
    'session_terminated',
    'account_locked'
  )),
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 用户会话统计表
CREATE TABLE IF NOT EXISTS user_session_stats (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_sessions INTEGER DEFAULT 0,
  active_sessions INTEGER DEFAULT 0,
  terminated_sessions INTEGER DEFAULT 0,
  anomaly_count INTEGER DEFAULT 0,
  last_login_at TIMESTAMP WITH TIME ZONE,
  last_login_ip INET,
  last_login_geo GEOGRAPHY(POINT, 4326),
  avg_session_duration_seconds INTEGER DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_session_user ON session_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_session_active ON session_bindings(user_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_session_device ON session_bindings(device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_session_created ON session_bindings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_session ON session_anomaly_events(session_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_user ON session_anomaly_events(user_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_time ON session_anomaly_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_type ON session_anomaly_events(event_type);

-- 触发器：更新用户会话统计
CREATE OR REPLACE FUNCTION update_user_session_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO user_session_stats (user_id, total_sessions, active_sessions, last_login_at, last_login_ip, last_login_geo, updated_at)
    VALUES (
      NEW.user_id, 
      1, 
      1, 
      NEW.created_at, 
      NEW.bind_ip, 
      NEW.bind_geo,
      NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      total_sessions = user_session_stats.total_sessions + 1,
      active_sessions = user_session_stats.active_sessions + 1,
      last_login_at = NEW.created_at,
      last_login_ip = NEW.bind_ip,
      last_login_geo = NEW.bind_geo,
      updated_at = NOW();
    
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'terminated' AND OLD.status = 'active' THEN
    UPDATE user_session_stats 
    SET 
      active_sessions = GREATEST(active_sessions - 1, 0),
      terminated_sessions = terminated_sessions + 1,
      updated_at = NOW()
    WHERE user_id = NEW.user_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_session_stats
AFTER INSERT OR UPDATE ON session_bindings
FOR EACH ROW
EXECUTE FUNCTION update_user_session_stats();

-- 触发器：异常事件计数
CREATE OR REPLACE FUNCTION increment_anomaly_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE user_session_stats 
  SET 
    anomaly_count = anomaly_count + 1,
    updated_at = NOW()
  WHERE user_id = NEW.user_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_anomaly_count
AFTER INSERT ON session_anomaly_events
FOR EACH ROW
EXECUTE FUNCTION increment_anomaly_count();

COMMENT ON TABLE session_bindings IS '会话绑定表 - 记录用户会话与设备、IP、地理位置的绑定关系';
COMMENT ON TABLE session_anomaly_events IS '会话异常事件表 - 记录所有会话异常行为和防护动作';
COMMENT ON TABLE user_session_stats IS '用户会话统计表 - 汇总用户的会话活跃情况';
