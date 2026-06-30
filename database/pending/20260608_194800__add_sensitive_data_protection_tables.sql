-- REQ-00038: API 敏感数据泄露防护与审计日志加密存储
-- 数据库迁移脚本

-- ============================================================
-- 1. 扩展审计日志表（添加加密字段）
-- ============================================================

ALTER TABLE audit_logs 
ADD COLUMN IF NOT EXISTS encrypted_data BYTEA,
ADD COLUMN IF NOT EXISTS encryption_key_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS encryption_iv VARCHAR(64);

-- 为加密审计日志添加索引
CREATE INDEX IF NOT EXISTS idx_audit_logs_encryption_key 
ON audit_logs(encryption_key_id);

COMMENT ON COLUMN audit_logs.encrypted_data IS '加密的审计日志数据';
COMMENT ON COLUMN audit_logs.encryption_key_id IS '加密密钥 ID';
COMMENT ON COLUMN audit_logs.encryption_iv IS '加密初始化向量';

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
  
  CONSTRAINT fk_sensitive_access_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_sensitive_access_accessor FOREIGN KEY (accessed_by) REFERENCES users(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_sensitive_access_user ON sensitive_data_access_logs(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_resource ON sensitive_data_access_logs(resource_type, resource_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_accessor ON sensitive_data_access_logs(accessed_by, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_timestamp ON sensitive_data_access_logs(timestamp);

COMMENT ON TABLE sensitive_data_access_logs IS '敏感数据访问审计日志';
COMMENT ON COLUMN sensitive_data_access_logs.accessed_by IS '访问者用户 ID';
COMMENT ON COLUMN sensitive_data_access_logs.resource_type IS '资源类型（user/payment/pokemon）';
COMMENT ON COLUMN sensitive_data_access_logs.accessed_fields IS '访问的敏感字段列表';
COMMENT ON COLUMN sensitive_data_access_logs.encrypted_ip_address IS '加密的访问者 IP 地址';

-- ============================================================
-- 3. 加密密钥管理表
-- ============================================================

CREATE TABLE IF NOT EXISTS encryption_keys (
  id VARCHAR(64) PRIMARY KEY,
  algorithm VARCHAR(50) DEFAULT 'aes-256-gcm',
  encrypted_key BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  rotated_from VARCHAR(64),
  
  CONSTRAINT fk_encryption_key_rotated_from FOREIGN KEY (rotated_from) REFERENCES encryption_keys(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_encryption_keys_active ON encryption_keys(is_active, created_at);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_expires ON encryption_keys(expires_at) WHERE is_active = true;

COMMENT ON TABLE encryption_keys IS '加密密钥管理表（密钥使用主密钥加密存储）';
COMMENT ON COLUMN encryption_keys.encrypted_key IS '使用主密钥加密的工作密钥';
COMMENT ON COLUMN encryption_keys.rotated_from IS '从哪个密钥轮换而来';

-- ============================================================
-- 4. 数据清理任务（自动删除过期的访问日志）
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_expired_sensitive_access_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM sensitive_data_access_logs
  WHERE timestamp < NOW() - (retention_days || ' days')::interval;
  
  RAISE NOTICE 'Cleaned up expired sensitive access logs';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 创建定时任务扩展（需要 pg_cron 扩展）
-- 如果没有 pg_cron，可以在应用层定期执行
-- -- -- -- -- -- -- -- -- -- -- -- SELECT cron.schedule('cleanup_sensitive_access_logs', '0 2 * * *', 'SELECT cleanup_expired_sensitive_access_logs()');

-- ============================================================
-- 5. 敏感字段定义表（可选，用于动态配置）
-- ============================================================

CREATE TABLE IF NOT EXISTS sensitive_field_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type VARCHAR(50) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  sensitivity_level VARCHAR(10) NOT NULL, -- P0/P1/P2/P3
  description TEXT,
  mfa_required BOOLEAN DEFAULT false,
  requires_reason BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT uk_sensitive_field UNIQUE (resource_type, field_name)
);

-- 插入初始敏感字段定义
INSERT INTO sensitive_field_definitions (resource_type, field_name, sensitivity_level, description, mfa_required, requires_reason)
VALUES
  ('user', 'email', 'P1', '用户邮箱', false, true),
  ('user', 'phone', 'P1', '用户手机号', false, true),
  ('user', 'real_name', 'P1', '用户真实姓名', false, true),
  ('user', 'id_card', 'P1', '用户身份证号', true, true),
  ('user', 'address', 'P1', '用户地址', false, true),
  ('user', 'birthday', 'P1', '用户生日', false, false),
  ('user', 'location_history', 'P2', '用户位置历史', false, true),
  ('payment', 'card_number', 'P0', '银行卡号', true, true),
  ('payment', 'cvv', 'P0', 'CVV 安全码', true, true),
  ('payment', 'billing_address', 'P1', '账单地址', false, true),
  ('pokemon', 'iv_values', 'P2', '精灵 IV 值', false, false),
  ('pokemon', 'shiny_rate', 'P2', '闪光精灵概率', false, false)
ON CONFLICT (resource_type, field_name) DO NOTHING;

-- ============================================================
-- 6. 管理员敏感数据访问审批表（可选）
-- ============================================================

CREATE TABLE IF NOT EXISTS sensitive_access_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES users(id),
  approver_id UUID REFERENCES users(id),
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  requested_fields TEXT[] NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending/approved/rejected/expired
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT fk_access_approval_requester FOREIGN KEY (requester_id) REFERENCES users(id),
  CONSTRAINT fk_access_approval_approver FOREIGN KEY (approver_id) REFERENCES users(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_access_approval_requester ON sensitive_access_approvals(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_access_approval_status ON sensitive_access_approvals(status, created_at);

COMMENT ON TABLE sensitive_access_approvals IS '敏感数据访问审批记录';

-- ============================================================
-- 7. 触发器：自动更新 updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_sensitive_field_definitions_updated_at
BEFORE UPDATE ON sensitive_field_definitions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 完成
-- ============================================================

-- 插入迁移记录

