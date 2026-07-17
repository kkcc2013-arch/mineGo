-- REQ-00588: 敏感 API 二次身份验证与风控行为分级系统
-- 数据库迁移文件

-- 创建风险评估日志表
CREATE TABLE IF NOT EXISTS security_risk_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  endpoint VARCHAR(200) NOT NULL,
  risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  action VARCHAR(20) NOT NULL DEFAULT 'allow',
  assessment_factors JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_security_risk_assessments_user_id 
ON security_risk_assessments(user_id);
CREATE INDEX IF NOT EXISTS idx_security_risk_assessments_created_at 
ON security_risk_assessments(created_at);
CREATE INDEX IF NOT EXISTS idx_security_risk_assessments_risk_level 
ON security_risk_assessments(risk_level);

-- 创建安全审计日志表
CREATE TABLE IF NOT EXISTS security_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT,
  action VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_audit_log_user_id 
ON security_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_log_action 
ON security_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_security_audit_log_created_at 
ON security_audit_log(created_at);

-- 创建用户安全设置表
CREATE TABLE IF NOT EXISTS user_security_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_type VARCHAR(20) DEFAULT 'sms',
  totp_enabled BOOLEAN DEFAULT FALSE,
  totp_secret VARCHAR(100),
  recovery_codes JSONB DEFAULT '[]',
  trusted_devices JSONB DEFAULT '[]',
  last_mfa_at TIMESTAMP WITH TIME ZONE,
  security_questions JSONB DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建敏感操作日志表
CREATE TABLE IF NOT EXISTS sensitive_operation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL,
  operation_type VARCHAR(50) NOT NULL,
  endpoint VARCHAR(200) NOT NULL,
  verification_method VARCHAR(20),
  verification_id UUID,
  risk_score INTEGER,
  ip_address VARCHAR(45),
  user_agent TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sensitive_operation_logs_user_id 
ON sensitive_operation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sensitive_operation_logs_operation_type 
ON sensitive_operation_logs(operation_type);
CREATE INDEX IF NOT EXISTS idx_sensitive_operation_logs_created_at 
ON sensitive_operation_logs(created_at);

-- 创建 MFA 验证记录表
CREATE TABLE IF NOT EXISTS mfa_verification_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL,
  verification_type VARCHAR(20) NOT NULL,
  challenge_token VARCHAR(100),
  path VARCHAR(200),
  risk_score INTEGER,
  attempts INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verified_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mfa_verification_records_user_id 
ON mfa_verification_records(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_verification_records_status 
ON mfa_verification_records(status);

-- 创建设备信任表
CREATE TABLE IF NOT EXISTS trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(100) NOT NULL,
  device_name VARCHAR(100),
  device_type VARCHAR(20),
  last_ip VARCHAR(45),
  last_used_at TIMESTAMP WITH TIME ZONE,
  trusted_until TIMESTAMP WITH TIME ZONE,
  trust_level INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_id 
ON trusted_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_device_id 
ON trusted_devices(device_id);

-- 创建敏感 API 配置表
CREATE TABLE IF NOT EXISTS sensitive_api_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path_pattern VARCHAR(200) UNIQUE NOT NULL,
  sensitivity_level VARCHAR(5) NOT NULL CHECK (sensitivity_level IN ('P0', 'P1', 'P2')),
  required_verification VARCHAR(20) DEFAULT 'quick_verify',
  risk_threshold INTEGER DEFAULT 50,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 插入默认敏感 API 配置
INSERT INTO sensitive_api_config (path_pattern, sensitivity_level, required_verification, risk_threshold) VALUES
('/api/v1/payment/withdraw', 'P0', 'full_mfa', 30),
('/api/v1/payment/transfer', 'P0', 'full_mfa', 30),
('/api/v1/user/change-password', 'P0', 'full_mfa', 40),
('/api/v1/user/delete-account', 'P0', 'full_mfa', 20),
('/api/v1/user/bind-email', 'P0', 'full_mfa', 30),
('/api/v1/user/bind-phone', 'P0', 'full_mfa', 30),
('/api/v1/user/change-payment-password', 'P0', 'full_mfa', 20),
('/api/v1/pokemon/trade', 'P1', 'quick_verify', 40),
('/api/v1/pokemon/transfer', 'P1', 'quick_verify', 40),
('/api/v1/pokemon/release-batch', 'P1', 'quick_verify', 50),
('/api/v1/gym/claim-reward', 'P1', 'quick_verify', 50),
('/api/v1/social/update-profile', 'P1', 'quick_verify', 50),
('/api/v1/user/update-settings', 'P1', 'quick_verify', 60),
('/api/v1/user/export-data', 'P2', 'quick_verify', 60),
('/api/v1/social/post-create', 'P2', 'quick_verify', 70),
('/api/v1/social/post-delete', 'P2', 'quick_verify', 70)
ON CONFLICT (path_pattern) DO NOTHING;

-- 创建函数：自动更新时间戳
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为需要自动更新的表创建触发器
DROP TRIGGER IF EXISTS update_user_security_settings_updated_at ON user_security_settings;
CREATE TRIGGER update_user_security_settings_updated_at
    BEFORE UPDATE ON user_security_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_sensitive_api_config_updated_at ON sensitive_api_config;
CREATE TRIGGER update_sensitive_api_config_updated_at
    BEFORE UPDATE ON sensitive_api_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 注释
COMMENT ON TABLE security_risk_assessments IS 'REQ-00588: 安全风险评估记录';
COMMENT ON TABLE security_audit_log IS 'REQ-00588: 安全审计日志';
COMMENT ON TABLE user_security_settings IS 'REQ-00588: 用户安全设置';
COMMENT ON TABLE sensitive_operation_logs IS 'REQ-00588: 敏感操作日志';
COMMENT ON TABLE mfa_verification_records IS 'REQ-00588: MFA验证记录';
COMMENT ON TABLE trusted_devices IS 'REQ-00588: 用户信任设备';
COMMENT ON TABLE sensitive_api_config IS 'REQ-00588: 敏感API配置';