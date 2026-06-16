-- REQ-00147: API 请求速率限制绕过检测与防护系统
-- 创建时间: 2026-06-16 00:00

-- 绕过尝试记录表
CREATE TABLE IF NOT EXISTS rate_limit_bypass_attempts (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    ip VARCHAR(45) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('ip_rotation', 'account_distribution', 'boundary_attack', 'state_tampering', 'unknown')),
    risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    details JSONB,
    blocked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 封禁记录表
CREATE TABLE IF NOT EXISTS rate_limit_blocks (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    reason VARCHAR(64) NOT NULL,
    risk_score INTEGER NOT NULL,
    blocked_until TIMESTAMP WITH TIME ZONE NOT NULL,
    unblocked_at TIMESTAMP WITH TIME ZONE,
    unblocked_by VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_bypass_attempts_user_id ON rate_limit_bypass_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_bypass_attempts_ip ON rate_limit_bypass_attempts(ip);
CREATE INDEX IF NOT EXISTS idx_bypass_attempts_type ON rate_limit_bypass_attempts(type);
CREATE INDEX IF NOT EXISTS idx_bypass_attempts_created_at ON rate_limit_bypass_attempts(created_at);
CREATE INDEX IF NOT EXISTS idx_bypass_attempts_risk_score ON rate_limit_bypass_attempts(risk_score);

CREATE INDEX IF NOT EXISTS idx_blocks_user_id ON rate_limit_blocks(user_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked_until ON rate_limit_blocks(blocked_until);
CREATE INDEX IF NOT EXISTS idx_blocks_active ON rate_limit_blocks(user_id, blocked_until) WHERE unblocked_at IS NULL;

-- 注释
COMMENT ON TABLE rate_limit_bypass_attempts IS '限流绕过尝试记录';
COMMENT ON TABLE rate_limit_blocks IS '限流绕过封禁记录';

COMMENT ON COLUMN rate_limit_bypass_attempts.type IS '绕过类型: ip_rotation/account_distribution/boundary_attack/state_tampering';
COMMENT ON COLUMN rate_limit_bypass_attempts.risk_score IS '风险分数 0-100';
COMMENT ON COLUMN rate_limit_bypass_attempts.details IS '检测详情 JSON';
