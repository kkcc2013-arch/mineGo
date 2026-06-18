-- REQ-00250: 设备管理系统数据库迁移
-- 创建用户设备管理表和设备活动日志表

-- 设备管理表
CREATE TABLE IF NOT EXISTS user_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint VARCHAR(64) NOT NULL,
  device_name VARCHAR(255),
  device_type VARCHAR(50), -- 'mobile', 'tablet', 'desktop'
  ip_address INET,
  location VARCHAR(255),
  user_agent TEXT,
  trust_level INTEGER DEFAULT 0, -- 0-4
  is_verified BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  is_frozen BOOLEAN DEFAULT false,
  first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  login_count INTEGER DEFAULT 1,
  verified_at TIMESTAMP WITH TIME ZONE,
  frozen_at TIMESTAMP WITH TIME ZONE,
  frozen_reason VARCHAR(255),
  unfrozen_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  revoked_reason VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(user_id, fingerprint)
);

-- 设备活动日志表
CREATE TABLE IF NOT EXISTS device_activity_log (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  ip_address INET,
  location VARCHAR(255),
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_fingerprint ON user_devices(fingerprint);
CREATE INDEX IF NOT EXISTS idx_user_devices_trust_level ON user_devices(trust_level);
CREATE INDEX IF NOT EXISTS idx_user_devices_last_seen ON user_devices(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_devices_is_active ON user_devices(is_active);

CREATE INDEX IF NOT EXISTS idx_device_activity_log_device_id ON device_activity_log(device_id);
CREATE INDEX IF NOT EXISTS idx_device_activity_log_user_id ON device_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_device_activity_log_created_at ON device_activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_activity_log_action ON device_activity_log(action);

-- 注释
COMMENT ON TABLE user_devices IS '用户设备管理表 - 存储用户登录设备信息与信任等级';
COMMENT ON TABLE device_activity_log IS '设备活动日志表 - 记录设备所有操作行为';

COMMENT ON COLUMN user_devices.trust_level IS '信任等级: 0=UNTRUSTED, 1=LOW, 2=MEDIUM, 3=HIGH, 4=VERIFIED';
COMMENT ON COLUMN user_devices.fingerprint IS '设备指纹 SHA-256 哈希值';
COMMENT ON COLUMN user_devices.device_type IS '设备类型: mobile, tablet, desktop, unknown';

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_user_devices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user_devices_updated_at ON user_devices;
CREATE TRIGGER trigger_update_user_devices_updated_at
  BEFORE UPDATE ON user_devices
  FOR EACH ROW
  EXECUTE FUNCTION update_user_devices_updated_at();
