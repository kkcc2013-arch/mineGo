-- REQ-00057: 多因素认证（MFA）系统
-- 创建时间: 2026-06-10 00:00
-- 说明: 支持 TOTP、恢复码、敏感操作二次验证

-- 用户 MFA 配置表
CREATE TABLE IF NOT EXISTS user_mfa (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_type        VARCHAR(20) NOT NULL DEFAULT 'totp',
  secret_encrypted TEXT NOT NULL,
  secret_iv       TEXT NOT NULL,
  is_enabled      BOOLEAN NOT NULL DEFAULT false,
  verified_at     TIMESTAMP,
  backup_codes_generated_at TIMESTAMP,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMP,
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
  ip_address      INET,
  user_agent      TEXT,
  failure_reason  VARCHAR(100),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- MFA 会话表（用于"记住此设备"功能）
CREATE TABLE IF NOT EXISTS mfa_trusted_devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_fingerprint VARCHAR(64) NOT NULL,
  device_name     VARCHAR(100),
  ip_address      INET,
  user_agent      TEXT,
  expires_at      TIMESTAMP NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_fingerprint)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_mfa_user_id ON user_mfa(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mfa_enabled ON user_mfa(is_enabled);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_unused ON mfa_recovery_codes(user_id, is_used);
CREATE INDEX IF NOT EXISTS idx_mfa_verification_logs_user_created ON mfa_verification_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfa_trusted_devices_user_expires ON mfa_trusted_devices(user_id, expires_at);

-- 注释
COMMENT ON TABLE user_mfa IS '用户 MFA 配置表，存储 TOTP 密钥等';
COMMENT ON TABLE mfa_recovery_codes IS 'MFA 备用恢复码，每个码使用一次后失效';
COMMENT ON TABLE mfa_verification_logs IS 'MFA 验证日志，用于审计和风控';
COMMENT ON TABLE mfa_trusted_devices IS '受信任设备列表，实现"记住此设备"功能';
