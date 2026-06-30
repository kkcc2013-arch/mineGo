-- REQ-00038: 敏感数据访问审计表
-- 创建时间: 2026-06-08 20:00
-- 描述: 支持敏感数据访问日志记录、加密密钥管理

-- ============================================================
-- 1. 扩展现有 audit_logs 表（如果不存在则创建）
-- ============================================================

-- 检查 audit_logs 表是否存在，不存在则创建
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  action VARCHAR(100) NOT NULL,
  action_data JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 添加加密相关字段（如果不存在）
DO $$
BEGIN
  -- encrypted_data 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'audit_logs' AND column_name = 'encrypted_data'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encrypted_data BYTEA;
  END IF;
  
  -- encryption_key_id 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'audit_logs' AND column_name = 'encryption_key_id'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encryption_key_id VARCHAR(64);
  END IF;
  
  -- encryption_iv 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'audit_logs' AND column_name = 'encryption_iv'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encryption_iv VARCHAR(64);
  END IF;
  
  -- encryption_auth_tag 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'audit_logs' AND column_name = 'encryption_auth_tag'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encryption_auth_tag VARCHAR(64);
  END IF;
END $$;

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action_data JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

COMMENT ON COLUMN audit_logs.encrypted_data IS '加密后的操作数据（AES-256-GCM）';
COMMENT ON COLUMN audit_logs.encryption_key_id IS '加密密钥 ID';
COMMENT ON COLUMN audit_logs.encryption_iv IS '加密初始化向量（16字节 hex）';
COMMENT ON COLUMN audit_logs.encryption_auth_tag IS 'GCM 认证标签（16字节 hex）';

-- ============================================================
-- 2. 敏感数据访问日志表
-- ============================================================

CREATE TABLE IF NOT EXISTS sensitive_data_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  accessed_by UUID NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  accessed_fields TEXT[] NOT NULL,
  access_reason VARCHAR(100),
  encrypted_ip_address BYTEA,
  encryption_key_id VARCHAR(64),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  retention_days INTEGER DEFAULT 90,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_sensitive_access_user ON sensitive_data_access_logs(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_resource ON sensitive_data_access_logs(resource_type, resource_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_by ON sensitive_data_access_logs(accessed_by, timestamp);

COMMENT ON TABLE sensitive_data_access_logs IS '敏感数据访问审计日志';
COMMENT ON COLUMN sensitive_data_access_logs.user_id IS '被访问的用户 ID';
COMMENT ON COLUMN sensitive_data_access_logs.accessed_by IS '访问者用户 ID';
COMMENT ON COLUMN sensitive_data_access_logs.resource_type IS '资源类型（user, pokemon, payment 等）';
COMMENT ON COLUMN sensitive_data_access_logs.resource_id IS '资源 ID';
COMMENT ON COLUMN sensitive_data_access_logs.accessed_fields IS '访问的敏感字段列表';
COMMENT ON COLUMN sensitive_data_access_logs.access_reason IS '访问原因（api_request, admin_view 等）';
COMMENT ON COLUMN sensitive_data_access_logs.encrypted_ip_address IS '加密后的 IP 地址';
COMMENT ON COLUMN sensitive_data_access_logs.retention_days IS '保留天数（默认 90 天）';

-- ============================================================
-- 3. 加密密钥管理表
-- ============================================================

CREATE TABLE IF NOT EXISTS encryption_keys (
  id VARCHAR(64) PRIMARY KEY,
  algorithm VARCHAR(50) DEFAULT 'aes-256-gcm',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  encrypted_key BYTEA NOT NULL,
  key_version INTEGER DEFAULT 1,
  created_by UUID,
  description TEXT
);

ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS key_version INTEGER DEFAULT 1;
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS description TEXT;

-- 索引
CREATE INDEX IF NOT EXISTS idx_encryption_keys_active ON encryption_keys(is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_created ON encryption_keys(created_at);

COMMENT ON TABLE encryption_keys IS '加密密钥管理表';
COMMENT ON COLUMN encryption_keys.id IS '密钥 ID（UUID 或自定义）';
COMMENT ON COLUMN encryption_keys.encrypted_key IS '使用主密钥加密的工作密钥';
COMMENT ON COLUMN encryption_keys.key_version IS '密钥版本号';
COMMENT ON COLUMN encryption_keys.is_active IS '是否激活';

-- ============================================================
-- 4. 敏感字段定义表
-- ============================================================

CREATE TABLE IF NOT EXISTS sensitive_fields_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_name VARCHAR(100) NOT NULL UNIQUE,
  sensitivity_level VARCHAR(10) NOT NULL CHECK (sensitivity_level IN ('P0', 'P1', 'P2', 'P3')),
  masking_type VARCHAR(50),
  masking_config JSONB,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入默认敏感字段配置
INSERT INTO sensitive_fields_config (field_name, sensitivity_level, masking_type, description) VALUES
('password', 'P0', 'remove', '密码'),
('payment_token', 'P0', 'remove', '支付令牌'),
('card_number', 'P0', 'keep_last4', '银行卡号'),
('cvv', 'P0', 'remove', 'CVV 安全码'),
('email', 'P1', 'keep_prefix', '电子邮箱'),
('phone', 'P1', 'keep_suffix', '手机号'),
('real_name', 'P1', 'keep_first', '真实姓名'),
('address', 'P1', 'remove_detail', '地址'),
('birthday', 'P2', 'keep_year_month', '生日'),
('ip_address', 'P2', 'mask_last_octet', 'IP 地址'),
('device_id', 'P2', 'keep_prefix', '设备 ID'),
('location_history', 'P2', 'fuzzy_location', '位置历史')
ON CONFLICT (field_name) DO NOTHING;

COMMENT ON TABLE sensitive_fields_config IS '敏感字段配置表';
COMMENT ON COLUMN sensitive_fields_config.sensitivity_level IS '敏感度级别（P0/P1/P2/P3）';

-- ============================================================
-- 5. 数据清理触发器（自动清理过期日志）
-- ============================================================

-- 创建清理函数
CREATE OR REPLACE FUNCTION cleanup_expired_sensitive_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM sensitive_data_access_logs
  WHERE timestamp < NOW() - INTERVAL '1 day' * retention_days;
  
  DELETE FROM audit_logs
  WHERE timestamp < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 创建定时任务（需要 pg_cron 扩展，可选）
-- 如果 pg_cron 不可用，可以改用外部定时任务
-- -- -- -- -- SELECT cron.schedule('cleanup_sensitive_logs', '0 2 * * *', 'SELECT cleanup_expired_sensitive_logs()');

-- ============================================================
-- 6. 视图：敏感访问统计
-- ============================================================

CREATE OR REPLACE VIEW sensitive_access_statistics AS
SELECT 
  resource_type,
  COUNT(*) as total_access_count,
  COUNT(DISTINCT user_id) as unique_users_count,
  COUNT(DISTINCT accessed_by) as unique_accessors_count,
  DATE_TRUNC('day', timestamp) as access_date
FROM sensitive_data_access_logs
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY resource_type, DATE_TRUNC('day', timestamp)
ORDER BY access_date DESC;

COMMENT ON VIEW sensitive_access_statistics IS '敏感数据访问统计视图';

-- ============================================================
-- 7. 行级安全策略（可选，需要 PostgreSQL 9.5+）
-- ============================================================

-- 启用行级安全（仅限超级管理员查看）
-- ALTER TABLE sensitive_data_access_logs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE encryption_keys ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 完成
-- ============================================================

-- 记录迁移

