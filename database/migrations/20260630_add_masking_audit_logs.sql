-- REQ-00394: 敏感数据审计日志表
-- 创建时间: 2026-06-30

-- 脱敏审计日志表
CREATE TABLE IF NOT EXISTS masking_audit_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event VARCHAR(50) NOT NULL,
    field VARCHAR(100) NOT NULL,
    rule VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    strategy VARCHAR(50) NOT NULL,
    priority INTEGER NOT NULL,
    description TEXT,
    service VARCHAR(50),
    request_id VARCHAR(100),
    user_id INTEGER,
    ip VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_masking_audit_timestamp ON masking_audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_masking_audit_event ON masking_audit_logs(event);
CREATE INDEX IF NOT EXISTS idx_masking_audit_user_id ON masking_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_masking_audit_service ON masking_audit_logs(service);
CREATE INDEX IF NOT EXISTS idx_masking_audit_category ON masking_audit_logs(category);

-- 脱敏规则配置表
CREATE TABLE IF NOT EXISTS masking_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) UNIQUE NOT NULL,
    patterns TEXT[] NOT NULL,
    strategy VARCHAR(50) NOT NULL,
    priority INTEGER DEFAULT 3,
    description TEXT,
    category VARCHAR(50) DEFAULT 'custom',
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 插入默认规则
INSERT INTO masking_rules (rule_name, patterns, strategy, priority, description, category) VALUES
-- 认证信息
('password', ARRAY['password', 'passwd', 'pwd', 'pass', 'pin', 'secret', 'credential'], 'mask_all', 1, '用户密码', 'authentication'),
('confirmPassword', ARRAY['confirmPassword', 'confirm_password', 'confirmPass'], 'mask_all', 1, '确认密码', 'authentication'),
('newPassword', ARRAY['newPassword', 'new_password', 'newPass'], 'mask_all', 1, '新密码', 'authentication'),

-- 支付信息
('creditCardNumber', ARRAY['creditCard', 'cardNumber', 'card_number', 'pan', 'ccNumber'], 'mask_partial', 1, '信用卡号', 'payment'),
('cvv', ARRAY['cvv', 'cvv2', 'securityCode', 'security_code'], 'mask_all', 1, 'CVV 安全码', 'payment'),
('cardExpiry', ARRAY['expiry', 'expiryDate', 'expDate', 'exp_date'], 'mask_all', 1, '卡片有效期', 'payment'),
('bankAccount', ARRAY['bankAccount', 'bank_account', 'accountNumber'], 'mask_partial', 1, '银行账号', 'payment'),

-- 个人身份信息
('email', ARRAY['email', 'emailAddress', 'email_address'], 'mask_email', 2, '电子邮件地址', 'pii'),
('phone', ARRAY['phone', 'phoneNumber', 'phone_number', 'mobile'], 'mask_phone', 2, '手机号码', 'pii'),
('idCard', ARRAY['idCard', 'id_card', 'identityCard', 'ssn'], 'mask_id_card', 1, '身份证号', 'pii'),
('realName', ARRAY['realName', 'real_name', 'fullName', 'full_name'], 'mask_name', 2, '真实姓名', 'pii'),
('address', ARRAY['address', 'street', 'homeAddress'], 'mask_address', 3, '地址信息', 'pii'),

-- API 密钥和令牌
('apiKey', ARRAY['apiKey', 'api_key', 'secretKey', 'secret_key'], 'mask_token', 1, 'API 密钥', 'security'),
('accessToken', ARRAY['accessToken', 'access_token', 'token', 'jwt'], 'mask_token', 1, '访问令牌', 'security'),
('refreshToken', ARRAY['refreshToken', 'refresh_token'], 'mask_token', 1, '刷新令牌', 'security'),

-- 其他
('ip', ARRAY['ipAddress', 'ip_address', 'clientIp'], 'mask_ip', 3, 'IP 地址', 'network'),
('deviceId', ARRAY['deviceId', 'device_id', 'udid', 'imei'], 'mask_partial', 2, '设备标识', 'device'),
('sessionId', ARRAY['sessionId', 'session_id', 'sessId'], 'mask_partial', 2, '会话ID', 'security')
ON CONFLICT (rule_name) DO NOTHING;

-- 脱敏统计表（按日统计）
CREATE TABLE IF NOT EXISTS masking_stats_daily (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    service VARCHAR(50) NOT NULL,
    total_masked INTEGER DEFAULT 0,
    by_category JSONB DEFAULT '{}',
    by_strategy JSONB DEFAULT '{}',
    unique_users INTEGER DEFAULT 0,
    unique_ips INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(date, service)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_masking_stats_date ON masking_stats_daily(date DESC);
CREATE INDEX IF NOT EXISTS idx_masking_stats_service ON masking_stats_daily(service);

-- 敏感数据泄露事件表
CREATE TABLE IF NOT EXISTS sensitive_data_leak_events (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    severity VARCHAR(20) NOT NULL, -- 'critical', 'high', 'medium', 'low'
    source_type VARCHAR(50) NOT NULL, -- 'log', 'response', 'error'
    field VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    sample TEXT, -- 脱敏后的样本
    location VARCHAR(255), -- 文件路径或日志位置
    service VARCHAR(50),
    request_id VARCHAR(100),
    resolved BOOLEAN DEFAULT false,
    resolved_at TIMESTAMPTZ,
    resolved_by INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_leak_events_detected ON sensitive_data_leak_events(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_leak_events_severity ON sensitive_data_leak_events(severity);
CREATE INDEX IF NOT EXISTS idx_leak_events_resolved ON sensitive_data_leak_events(resolved);
CREATE INDEX IF NOT EXISTS idx_leak_events_service ON sensitive_data_leak_events(service);

-- 注释
COMMENT ON TABLE masking_audit_logs IS 'REQ-00394: 敏感数据脱敏审计日志';
COMMENT ON TABLE masking_rules IS 'REQ-00394: 可配置的脱敏规则';
COMMENT ON TABLE masking_stats_daily IS 'REQ-00394: 每日脱敏统计';
COMMENT ON TABLE sensitive_data_leak_events IS 'REQ-00394: 敏感数据泄露事件记录';