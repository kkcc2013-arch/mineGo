-- REQ-00127: 用户数据删除请求管理系统
-- 数据库迁移脚本

-- 数据删除请求表
CREATE TABLE IF NOT EXISTS data_deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_type VARCHAR(20) NOT NULL CHECK (request_type IN ('full', 'partial')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'verifying', 'approved', 'processing', 
        'completed', 'rejected', 'cancelled'
    )),
    reason TEXT,
    requested_data_types TEXT[] DEFAULT ARRAY['all'],
    
    -- 审批信息
    approval_status VARCHAR(20) DEFAULT 'pending' CHECK (approval_status IN (
        'pending', 'auto_approved', 'manual_approved', 'rejected'
    )),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    
    -- 处理信息
    processing_started_at TIMESTAMPTZ,
    processing_completed_at TIMESTAMPTZ,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    
    -- 元数据
    ip_address INET,
    user_agent TEXT,
    verification_code VARCHAR(32),
    verification_expires_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 数据删除任务表（细粒度删除任务）
CREATE TABLE IF NOT EXISTS data_deletion_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_deletion_requests(id) ON DELETE CASCADE,
    task_name VARCHAR(100) NOT NULL,
    service_name VARCHAR(50) NOT NULL,
    data_category VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'skipped'
    )),
    
    -- 任务详情
    table_name VARCHAR(100),
    query_template TEXT,
    affected_rows INTEGER DEFAULT 0,
    backup_path TEXT,
    
    -- 执行信息
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- 依赖关系
    depends_on UUID[] DEFAULT ARRAY[]::UUID[],
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 数据删除证明表（合规凭证）
CREATE TABLE IF NOT EXISTS data_deletion_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_deletion_requests(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    
    -- 证明信息
    certificate_number VARCHAR(50) UNIQUE NOT NULL,
    deletion_summary JSONB NOT NULL,
    deleted_data_categories TEXT[] NOT NULL,
    total_records_deleted INTEGER DEFAULT 0,
    
    -- 数字签名
    signature TEXT NOT NULL,
    signature_algorithm VARCHAR(50) DEFAULT 'SHA256-RSA',
    
    -- 保留期限（合规要求保留删除记录）
    retention_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 years'),
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 数据类别定义表
CREATE TABLE IF NOT EXISTS data_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_code VARCHAR(50) UNIQUE NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    description TEXT,
    related_tables TEXT[] NOT NULL,
    retention_period_days INTEGER,
    is_deletable BOOLEAN DEFAULT TRUE,
    deletion_priority INTEGER DEFAULT 50,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 预定义数据类别
INSERT INTO data_categories (category_code, category_name, description, related_tables, retention_period_days, deletion_priority) VALUES
('profile', '用户档案', '用户基本信息', ARRAY['users', 'user_profiles'], 0, 10),
('pokemon', '精灵数据', '用户拥有的精灵', ARRAY['user_pokemon', 'pokemon_stats'], 0, 20),
('social', '社交数据', '好友、公会等社交关系', ARRAY['friendships', 'guild_members', 'messages'], 0, 30),
('transaction', '交易记录', '支付和交易记录', ARRAY['transactions', 'payments'], 2555, 40),
('location', '位置历史', 'GPS位置历史', ARRAY['location_history', 'visit_records'], 90, 15),
('activity', '活动日志', '用户活动日志', ARRAY['activity_logs', 'audit_logs'], 365, 50),
('preferences', '用户偏好', '设置和偏好', ARRAY['user_preferences', 'notification_preferences'], 0, 5),
('achievements', '成就数据', '用户成就和里程碑', ARRAY['user_achievements', 'milestones'], 0, 35)
ON CONFLICT (category_code) DO NOTHING;

-- 审批历史表
CREATE TABLE IF NOT EXISTS data_deletion_approval_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_deletion_requests(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    actor_id UUID REFERENCES users(id),
    actor_type VARCHAR(20) DEFAULT 'system' CHECK (actor_type IN ('system', 'admin', 'auto')),
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    comment TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_deletion_requests_user_id ON data_deletion_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_status ON data_deletion_requests(status);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_created_at ON data_deletion_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_deletion_tasks_request_id ON data_deletion_tasks(request_id);
CREATE INDEX IF NOT EXISTS idx_deletion_tasks_status ON data_deletion_tasks(status);
CREATE INDEX IF NOT EXISTS idx_deletion_tasks_data_category ON data_deletion_tasks(data_category);
CREATE INDEX IF NOT EXISTS idx_deletion_certificates_request_id ON data_deletion_certificates(request_id);
CREATE INDEX IF NOT EXISTS idx_deletion_certificates_number ON data_deletion_certificates(certificate_number);
CREATE INDEX IF NOT EXISTS idx_deletion_approval_request_id ON data_deletion_approval_history(request_id);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_data_deletion_requests_updated_at 
    BEFORE UPDATE ON data_deletion_requests 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_data_deletion_tasks_updated_at 
    BEFORE UPDATE ON data_deletion_tasks 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_data_categories_updated_at 
    BEFORE UPDATE ON data_categories 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
