-- REQ-00045: 设备完整性与模拟器检测系统
-- 数据库迁移脚本
-- 创建时间: 2026-06-09 07:00

-- ============================================================
-- 1. 设备注册表
-- ============================================================
CREATE TABLE IF NOT EXISTS device_registrations (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(64) UNIQUE NOT NULL,
    fingerprint VARCHAR(128) UNIQUE NOT NULL,
    
    -- 设备基本信息
    brand VARCHAR(50),
    model VARCHAR(100),
    device_name VARCHAR(100),
    os_type VARCHAR(20) CHECK (os_type IN ('android', 'ios', 'web', 'unknown')),
    os_version VARCHAR(20),
    app_version VARCHAR(20),
    sdk_version VARCHAR(20),
    
    -- 硬件特征
    cpu_abi VARCHAR(50),
    screen_width INTEGER,
    screen_height INTEGER,
    screen_density DECIMAL(4,2),
    sensor_count INTEGER,
    has_battery BOOLEAN DEFAULT TRUE,
    
    -- 完整性检测结果
    is_emulator BOOLEAN DEFAULT FALSE,
    emulator_type VARCHAR(50), -- 'bluestacks', 'nox', 'ldplayer', 'genymotion', etc.
    is_rooted BOOLEAN DEFAULT FALSE,
    root_type VARCHAR(50), -- 'magisk', 'supersu', 'kingroot', etc.
    is_jailbroken BOOLEAN DEFAULT FALSE, -- iOS
    is_virtual_env BOOLEAN DEFAULT FALSE,
    virtual_env_type VARCHAR(50), -- 'virtualapp', 'parallel_space', etc.
    has_hook_framework BOOLEAN DEFAULT FALSE,
    hook_framework_type VARCHAR(50), -- 'xposed', 'frida', 'substrate', etc.
    
    -- 风险评分
    risk_score INTEGER DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
    trust_level VARCHAR(20) DEFAULT 'HIGH' CHECK (trust_level IN ('HIGH', 'MEDIUM', 'LOW', 'BANNED')),
    
    -- 状态
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BANNED', 'RESTRICTED', 'SUSPENDED')),
    restrictions TEXT[] DEFAULT '{}',
    ban_reason VARCHAR(200),
    
    -- 时间戳
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_check_at TIMESTAMP WITH TIME ZONE,
    banned_at TIMESTAMP WITH TIME ZONE,
    
    -- 元数据（存储原始检测数据）
    detection_details JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_device_registrations_device_id ON device_registrations(device_id);
CREATE INDEX IF NOT EXISTS idx_device_registrations_fingerprint ON device_registrations(fingerprint);
CREATE INDEX IF NOT EXISTS idx_device_registrations_risk_score ON device_registrations(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_device_registrations_status ON device_registrations(status);
CREATE INDEX IF NOT EXISTS idx_device_registrations_os_type ON device_registrations(os_type);
CREATE INDEX IF NOT EXISTS idx_device_registrations_last_seen ON device_registrations(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_registrations_emulator ON device_registrations(is_emulator) WHERE is_emulator = TRUE;
CREATE INDEX IF NOT EXISTS idx_device_registrations_rooted ON device_registrations(is_rooted) WHERE is_rooted = TRUE;

-- ============================================================
-- 2. 设备-账号关联表
-- ============================================================
CREATE TABLE IF NOT EXISTS device_account_associations (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL REFERENCES device_registrations(device_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    
    first_login_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    login_count INTEGER DEFAULT 1,
    
    -- 登录来源
    login_ip VARCHAR(45),
    login_location VARCHAR(100),
    
    -- 状态
    is_primary_device BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE (device_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_device_account_device ON device_account_associations(device_id);
CREATE INDEX IF NOT EXISTS idx_device_account_user ON device_account_associations(user_id);
CREATE INDEX IF NOT EXISTS idx_device_account_primary ON device_account_associations(user_id, is_primary_device) WHERE is_primary_device = TRUE;

-- ============================================================
-- 3. 设备完整性检测日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS device_integrity_logs (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(64),
    user_id INTEGER,
    
    -- 检测结果快照
    detection_result JSONB NOT NULL,
    risk_score INTEGER,
    trust_level VARCHAR(20),
    action_taken VARCHAR(20), -- 'ALLOW', 'MONITOR', 'RESTRICT', 'BLOCK'
    
    -- 检测详情
    emulator_detected BOOLEAN DEFAULT FALSE,
    root_detected BOOLEAN DEFAULT FALSE,
    virtual_env_detected BOOLEAN DEFAULT FALSE,
    hook_detected BOOLEAN DEFAULT FALSE,
    
    -- 客户端信息
    client_version VARCHAR(20),
    check_duration_ms INTEGER,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_integrity_logs_device ON device_integrity_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_integrity_logs_user ON device_integrity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_integrity_logs_created ON device_integrity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrity_logs_action ON device_integrity_logs(action_taken);

-- ============================================================
-- 4. 设备群控检测表（多账号设备）
-- ============================================================
CREATE TABLE IF NOT EXISTS device_cluster_detection (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    
    -- 群控指标
    account_count INTEGER DEFAULT 1,
    suspicious_account_ids INTEGER[],
    
    -- 资源转移统计（群控特征）
    internal_transfer_count INTEGER DEFAULT 0,
    internal_trade_count INTEGER DEFAULT 0,
    
    -- 活动时间模式
    active_hours_per_day DECIMAL(4,1),
    continuous_activity_hours DECIMAL(4,1),
    
    -- 风险判定
    is_cluster_device BOOLEAN DEFAULT FALSE,
    cluster_type VARCHAR(50), -- 'farm', 'automation', 'multi_account'
    risk_score INTEGER DEFAULT 0,
    
    -- 处理状态
    status VARCHAR(20) DEFAULT 'MONITORING',
    action_taken VARCHAR(200),
    
    first_detected_at TIMESTAMP WITH TIME ZONE,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_cluster_device ON device_cluster_detection(device_id);
CREATE INDEX IF NOT EXISTS idx_cluster_account_count ON device_cluster_detection(account_count DESC);
CREATE INDEX IF NOT EXISTS idx_cluster_risk ON device_cluster_detection(is_cluster_device, risk_score DESC);

-- ============================================================
-- 5. 设备风险规则配置表
-- ============================================================
CREATE TABLE IF NOT EXISTS device_risk_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) NOT NULL UNIQUE,
    rule_type VARCHAR(50) NOT NULL, -- 'emulator', 'root', 'virtual_env', 'hook', 'cluster'
    
    -- 风险权重
    base_score INTEGER NOT NULL, -- 基础风险分数
    multiplier DECIMAL(4,2) DEFAULT 1.0,
    
    -- 处理策略
    action VARCHAR(20) NOT NULL, -- 'BLOCK', 'RESTRICT', 'MONITOR', 'ALLOW'
    restrictions TEXT[],
    message VARCHAR(200),
    
    -- 规则配置
    thresholds JSONB DEFAULT '{}',
    conditions JSONB DEFAULT '{}',
    
    -- 状态
    is_active BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 100,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 插入默认规则
INSERT INTO device_risk_rules (rule_name, rule_type, base_score, action, message, is_active, priority) VALUES
('emulator_block', 'emulator', 80, 'BLOCK', '您的设备存在安全风险（模拟器），无法登录游戏', TRUE, 1),
('root_warning', 'root', 40, 'RESTRICT', '您的设备已root，部分功能受限', TRUE, 2),
('jailbreak_warning', 'root', 40, 'RESTRICT', '您的设备已越狱，部分功能受限', TRUE, 2),
('virtual_env_block', 'virtual_env', 50, 'RESTRICT', '检测到虚拟运行环境，功能受限', TRUE, 3),
('hook_framework_warning', 'hook', 30, 'MONITOR', '检测到动态注入框架', TRUE, 4),
('multi_account_warning', 'cluster', 20, 'MONITOR', '该设备关联多个账号', TRUE, 5)
ON CONFLICT (rule_name) DO NOTHING;

-- ============================================================
-- 6. 更新触发器
-- ============================================================
CREATE OR REPLACE FUNCTION update_device_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_device_registrations_updated
    BEFORE UPDATE ON device_registrations
    FOR EACH ROW EXECUTE FUNCTION update_device_updated_at();

CREATE TRIGGER trigger_device_account_updated
    BEFORE UPDATE ON device_account_associations
    FOR EACH ROW EXECUTE FUNCTION update_device_updated_at();

CREATE TRIGGER trigger_device_risk_rules_updated
    BEFORE UPDATE ON device_risk_rules
    FOR EACH ROW EXECUTE FUNCTION update_device_updated_at();

-- ============================================================
-- 7. 统计视图
-- ============================================================
CREATE OR REPLACE VIEW device_statistics AS
SELECT 
    COUNT(*) AS total_devices,
    COUNT(*) FILTER (WHERE is_emulator = TRUE) AS emulator_count,
    COUNT(*) FILTER (WHERE is_rooted = TRUE) AS rooted_count,
    COUNT(*) FILTER (WHERE is_jailbroken = TRUE) AS jailbroken_count,
    COUNT(*) FILTER (WHERE is_virtual_env = TRUE) AS virtual_env_count,
    COUNT(*) FILTER (WHERE has_hook_framework = TRUE) AS hook_framework_count,
    COUNT(*) FILTER (WHERE status = 'BANNED') AS banned_count,
    COUNT(*) FILTER (WHERE status = 'RESTRICTED') AS restricted_count,
    COUNT(*) FILTER (WHERE risk_score >= 80) AS high_risk_count,
    COUNT(*) FILTER (WHERE risk_score >= 50 AND risk_score < 80) AS medium_risk_count,
    COUNT(*) FILTER (WHERE risk_score < 50) AS low_risk_count,
    AVG(risk_score) AS avg_risk_score
FROM device_registrations;

CREATE OR REPLACE VIEW device_account_stats AS
SELECT 
    d.device_id,
    d.model,
    d.is_emulator,
    d.is_rooted,
    d.risk_score,
    COUNT(da.user_id) AS account_count,
    SUM(da.login_count) AS total_login_count,
    MAX(da.last_login_at) AS last_login
FROM device_registrations d
LEFT JOIN device_account_associations da ON d.device_id = da.device_id
GROUP BY d.device_id, d.model, d.is_emulator, d.is_rooted, d.risk_score
ORDER BY account_count DESC;

-- ============================================================
-- 8. 注释
-- ============================================================
COMMENT ON TABLE device_registrations IS 'REQ-00045: 设备注册与完整性检测结果';
COMMENT ON TABLE device_account_associations IS 'REQ-00045: 设备-账号关联关系，用于群控检测';
COMMENT ON TABLE device_integrity_logs IS 'REQ-00045: 设备完整性检测日志';
COMMENT ON TABLE device_cluster_detection IS 'REQ-00045: 设备群控检测结果';
COMMENT ON TABLE device_risk_rules IS 'REQ-00045: 设备风险判定规则配置';