-- REQ-00064: 风险触发式人机验证（CAPTCHA）系统
-- 数据库迁移文件

-- 验证会话表
CREATE TABLE IF NOT EXISTS captcha_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_type VARCHAR(20) NOT NULL CHECK (session_type IN ('slide', 'click', 'calculate', 'behavior')),
    difficulty VARCHAR(20) NOT NULL CHECK (difficulty IN ('low', 'medium', 'high')),
    trigger_reason VARCHAR(50) NOT NULL, -- 'risk_score', 'high_risk_action', 'periodic', 'appeal'
    challenge_data JSONB NOT NULL, -- 验证题目数据（加密）
    expected_answer JSONB NOT NULL, -- 预期答案（加密）
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'expired')),
    attempt_count INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    client_data JSONB, -- 客户端验证数据（时间、轨迹、设备指纹）
    ip_address INET,
    device_fingerprint VARCHAR(128)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_captcha_sessions_user ON captcha_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captcha_sessions_status ON captcha_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_captcha_sessions_device ON captcha_sessions(device_fingerprint);

-- 验证历史统计表
CREATE TABLE IF NOT EXISTS captcha_stats (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total_verifications INTEGER DEFAULT 0,
    passed_verifications INTEGER DEFAULT 0,
    failed_verifications INTEGER DEFAULT 0,
    avg_response_time_ms INTEGER,
    last_verification_at TIMESTAMPTZ,
    last_verification_status VARCHAR(20),
    
    UNIQUE(user_id)
);

-- 验证配置表
CREATE TABLE IF NOT EXISTS captcha_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 初始配置数据
INSERT INTO captcha_config (key, value, description) VALUES
('trigger_thresholds', '{"low_risk": 80, "medium_risk": 60, "high_risk": 40}', '风险评分触发阈值'),
('session_timeout_seconds', '300', '验证会话超时时间（秒）'),
('max_attempts', '3', '最大尝试次数'),
('difficulty_mapping', '{"low": ["slide"], "medium": ["slide", "click"], "high": ["slide", "click", "calculate"]}', '难度对应验证类型'),
('trust_score_recovery', '10', '验证通过后恢复的可信度'),
('trust_score_penalty', '10', '验证失败后扣除的可信度'),
('min_response_time_ms', '{"low": 1000, "medium": 2000, "high": 3000}', '最小响应时间阈值（毫秒）'),
('freeze_threshold', '3', '连续验证失败冻结阈值'),
('freeze_duration_hours', '24', '账号冻结时长（小时）')
ON CONFLICT (key) DO NOTHING;

-- 高风险操作触发配置
CREATE TABLE IF NOT EXISTS captcha_trigger_rules (
    id SERIAL PRIMARY KEY,
    trigger_type VARCHAR(50) NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT true,
    difficulty_override VARCHAR(20) CHECK (difficulty_override IN ('low', 'medium', 'high')),
    cooldown_seconds INTEGER DEFAULT 300, -- 同一触发类型冷却时间
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 初始触发规则
INSERT INTO captcha_trigger_rules (trigger_type, enabled, difficulty_override, cooldown_seconds, description) VALUES
('cross_region_login', true, 'medium', 300, '跨区域登录触发验证'),
('anomalous_catch', true, 'medium', 600, '异常捕捉行为触发验证'),
('device_switch', true, 'medium', 300, '设备切换触发验证'),
('bulk_operation', true, 'high', 900, '批量操作触发验证'),
('night_activity', true, 'low', 1800, '深夜活动（2-6点）触发验证'),
('high_speed_movement', true, 'medium', 300, '高速移动触发验证'),
('suspicious_trajectory', true, 'high', 600, '可疑轨迹触发验证'),
('api_rate_limit_exceeded', true, 'medium', 300, 'API频率限制超标触发验证')
ON CONFLICT (trigger_type) DO NOTHING;

-- 评论：此迁移为 REQ-00064 风险触发式人机验证系统创建必要的数据表
