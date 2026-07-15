-- 安全违规记录表
CREATE TABLE IF NOT EXISTS security_violations (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    type VARCHAR(50) NOT NULL,
    region VARCHAR(100),
    expected_hash VARCHAR(255),
    actual_hash VARCHAR(255),
    critical BOOLEAN DEFAULT false,
    scan_count INTEGER DEFAULT 0,
    total_violations INTEGER DEFAULT 0,
    user_agent TEXT,
    url TEXT,
    memory_snapshot JSONB,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_security_violations_user_id ON security_violations(user_id);
CREATE INDEX idx_security_violations_created_at ON security_violations(created_at);
CREATE INDEX idx_security_violations_type ON security_violations(type);
CREATE INDEX idx_security_violations_critical ON security_violations(critical) WHERE critical = true;

-- 安全动作记录表
CREATE TABLE IF NOT EXISTS security_actions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    action VARCHAR(50) NOT NULL,
    reason TEXT,
    violation_id VARCHAR(36),
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_security_actions_user_id ON security_actions(user_id);
CREATE INDEX idx_security_actions_created_at ON security_actions(created_at);

-- 用户限制表
CREATE TABLE IF NOT EXISTS user_restrictions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    restriction_type VARCHAR(50) NOT NULL,
    reason TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_user_restrictions_user_id ON user_restrictions(user_id);
CREATE INDEX idx_user_restrictions_expires_at ON user_restrictions(expires_at) WHERE expires_at IS NOT NULL;

-- 添加用户表字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 注释
COMMENT ON TABLE security_violations IS '存储客户端安全违规报告';
COMMENT ON TABLE security_actions IS '存储对用户执行的安全动作';
COMMENT ON TABLE user_restrictions IS '存储用户限制记录';
