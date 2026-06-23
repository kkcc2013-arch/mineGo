-- KMS (Key Management System) 数据库迁移
-- 创建密钥管理相关的数据库表

-- 密钥元数据表
CREATE TABLE IF NOT EXISTS kms_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_type VARCHAR(50) NOT NULL,
  key_name VARCHAR(100) NOT NULL UNIQUE,
  sensitivity VARCHAR(20) NOT NULL CHECK (sensitivity IN ('critical', 'high', 'medium', 'low')),
  current_version INTEGER DEFAULT 1,
  rotation_period_days INTEGER NOT NULL DEFAULT 90,
  last_rotated_at TIMESTAMP,
  next_rotation_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 密钥版本表（支持多版本并存）
CREATE TABLE IF NOT EXISTS kms_key_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id UUID NOT NULL REFERENCES kms_keys(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv VARCHAR(64) NOT NULL,
  tag VARCHAR(64) NOT NULL,
  algorithm VARCHAR(20) DEFAULT 'AES-256-GCM',
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'revoked')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  revoked_at TIMESTAMP,
  UNIQUE(key_id, version)
);

-- 密钥访问审计日志
CREATE TABLE IF NOT EXISTS kms_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id UUID REFERENCES kms_keys(id) ON DELETE SET NULL,
  service_name VARCHAR(100),
  action VARCHAR(20) NOT NULL,
  success BOOLEAN NOT NULL,
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 安全事件表
CREATE TABLE IF NOT EXISTS security_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id UUID REFERENCES kms_keys(id) ON DELETE SET NULL,
  key_name VARCHAR(100),
  action VARCHAR(50) NOT NULL,
  reason TEXT,
  severity VARCHAR(20) DEFAULT 'high' CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_kms_keys_name ON kms_keys(key_name);
CREATE INDEX IF NOT EXISTS idx_kms_keys_active ON kms_keys(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_kms_keys_next_rotation ON kms_keys(next_rotation_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_kms_key_versions_key_id ON kms_key_versions(key_id);
CREATE INDEX IF NOT EXISTS idx_kms_key_versions_status ON kms_key_versions(status);
CREATE INDEX IF NOT EXISTS idx_kms_access_logs_key_id ON kms_access_logs(key_id);
CREATE INDEX IF NOT EXISTS idx_kms_access_logs_created_at ON kms_access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_security_incidents_created_at ON security_incidents(created_at);

-- 注释
COMMENT ON TABLE kms_keys IS '密钥元数据表';
COMMENT ON TABLE kms_key_versions IS '密钥版本表，支持多版本并存实现零停机轮换';
COMMENT ON TABLE kms_access_logs IS '密钥访问审计日志';
COMMENT ON TABLE security_incidents IS '安全事件记录';

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_kms_keys_updated_at
  BEFORE UPDATE ON kms_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 初始化数据：插入默认密钥记录（如果不存在）
INSERT INTO kms_keys (key_type, key_name, sensitivity, rotation_period_days, next_rotation_at)
VALUES 
  ('jwt_secret', 'jwt-access-secret', 'high', 90, CURRENT_TIMESTAMP + INTERVAL '90 days'),
  ('jwt_secret', 'jwt-refresh-secret', 'high', 90, CURRENT_TIMESTAMP + INTERVAL '90 days'),
  ('api_key', 'openweathermap-api-key', 'medium', 180, CURRENT_TIMESTAMP + INTERVAL '180 days'),
  ('db_password', 'database-password', 'high', 90, CURRENT_TIMESTAMP + INTERVAL '90 days'),
  ('redis_password', 'redis-password', 'high', 90, CURRENT_TIMESTAMP + INTERVAL '90 days'),
  ('encryption_key', 'data-encryption-key', 'critical', 30, CURRENT_TIMESTAMP + INTERVAL '30 days')
ON CONFLICT (key_name) DO NOTHING;
