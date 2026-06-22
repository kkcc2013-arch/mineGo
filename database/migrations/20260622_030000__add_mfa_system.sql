-- REQ-00057: MFA 数据库迁移
-- 多因素认证系统所需的数据库表

-- 用户 MFA 配置表
CREATE TABLE IF NOT EXISTS user_mfa (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_type        VARCHAR(20) NOT NULL DEFAULT 'totp',
  secret_encrypted TEXT NOT NULL,
  secret_iv       TEXT NOT NULL,
  is_enabled      BOOLEAN NOT NULL DEFAULT false,
  verified_at     TIMESTAMP,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMP,
  backup_codes_generated_at TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 备用恢复码表
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       VARCHAR(64) NOT NULL,
  is_used         BOOLEAN NOT NULL DEFAULT false,
  used_at         TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- MFA 验证日志表
CREATE TABLE IF NOT EXISTS mfa_verification_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  mfa_type        VARCHAR(20) NOT NULL,
  success         BOOLEAN NOT NULL,
  failure_reason  TEXT,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 受信任设备表
CREATE TABLE IF NOT EXISTS mfa_trusted_devices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_fingerprint  VARCHAR(128) NOT NULL,
  device_name         TEXT,
  ip_address          INET,
  user_agent          TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMP NOT NULL,
  UNIQUE(user_id, device_fingerprint)
);

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_user_mfa_user_id ON user_mfa(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_id ON mfa_recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_unused ON mfa_recovery_codes(user_id, is_used);
CREATE INDEX IF NOT EXISTS idx_mfa_verification_logs_user_created ON mfa_verification_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfa_trusted_devices_user_expires ON mfa_trusted_devices(user_id, expires_at);

-- 添加 users 表的 mfa_enabled 字段（如果不存在）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'mfa_enabled'
  ) THEN
    ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

COMMENT ON TABLE user_mfa IS '用户 MFA 配置表 - REQ-00057';
COMMENT ON TABLE mfa_recovery_codes IS 'MFA 备用恢复码表 - REQ-00057';
COMMENT ON TABLE mfa_verification_logs IS 'MFA 验证日志表 - REQ-00057';
COMMENT ON TABLE mfa_trusted_devices IS 'MFA 受信任设备表 - REQ-00057';
