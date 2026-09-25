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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(128);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS brand VARCHAR(50);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS model VARCHAR(100);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS device_name VARCHAR(100);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS os_type VARCHAR(20);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS os_version VARCHAR(20);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS app_version VARCHAR(20);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS sdk_version VARCHAR(20);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS cpu_abi VARCHAR(50);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS screen_width INTEGER;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS screen_height INTEGER;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS screen_density DECIMAL(4,2);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS sensor_count INTEGER;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS has_battery BOOLEAN DEFAULT TRUE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS is_emulator BOOLEAN DEFAULT FALSE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS emulator_type VARCHAR(50);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS is_rooted BOOLEAN DEFAULT FALSE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS root_type VARCHAR(50);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS is_jailbroken BOOLEAN DEFAULT FALSE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS is_virtual_env BOOLEAN DEFAULT FALSE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS virtual_env_type VARCHAR(50);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS has_hook_framework BOOLEAN DEFAULT FALSE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS hook_framework_type VARCHAR(50);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS trust_level VARCHAR(20) DEFAULT 'HIGH';
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE';
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS restrictions TEXT[] DEFAULT '{}';
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS ban_reason VARCHAR(200);
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS last_check_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS detection_details JSONB DEFAULT '{}';
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.device_registrations') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('device_id', 'fingerprint', 'brand', 'model', 'device_name', 'os_type', 'os_version', 'app_version', 'sdk_version', 'cpu_abi', 'screen_width', 'screen_height', 'screen_density', 'sensor_count', 'has_battery', 'is_emulator', 'emulator_type', 'is_rooted', 'root_type', 'is_jailbroken', 'is_virtual_env', 'virtual_env_type', 'has_hook_framework', 'hook_framework_type', 'risk_score', 'trust_level', 'status', 'restrictions', 'ban_reason', 'first_seen_at', 'last_seen_at', 'last_check_at', 'banned_at', 'detection_details', 'metadata', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE device_registrations ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 1;
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS login_ip VARCHAR(45);
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS login_location VARCHAR(100);
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS is_primary_device BOOLEAN DEFAULT FALSE;
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE';
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_account_associations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.device_account_associations') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('device_id', 'user_id', 'first_login_at', 'last_login_at', 'login_count', 'login_ip', 'login_location', 'is_primary_device', 'status', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE device_account_associations ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS detection_result JSONB;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS risk_score INTEGER;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS trust_level VARCHAR(20);
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS action_taken VARCHAR(20);
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS emulator_detected BOOLEAN DEFAULT FALSE;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS root_detected BOOLEAN DEFAULT FALSE;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS virtual_env_detected BOOLEAN DEFAULT FALSE;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS hook_detected BOOLEAN DEFAULT FALSE;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS client_version VARCHAR(20);
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS check_duration_ms INTEGER;
ALTER TABLE device_integrity_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.device_integrity_logs') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('device_id', 'user_id', 'detection_result', 'risk_score', 'trust_level', 'action_taken', 'emulator_detected', 'root_detected', 'virtual_env_detected', 'hook_detected', 'client_version', 'check_duration_ms', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE device_integrity_logs ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS account_count INTEGER DEFAULT 1;
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS suspicious_account_ids INTEGER[];
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS internal_transfer_count INTEGER DEFAULT 0;
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS internal_trade_count INTEGER DEFAULT 0;
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS active_hours_per_day DECIMAL(4,1);
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS continuous_activity_hours DECIMAL(4,1);
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS is_cluster_device BOOLEAN DEFAULT FALSE;
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS cluster_type VARCHAR(50);
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'MONITORING';
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS action_taken VARCHAR(200);
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS first_detected_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_cluster_detection ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.device_cluster_detection') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('device_id', 'account_count', 'suspicious_account_ids', 'internal_transfer_count', 'internal_trade_count', 'active_hours_per_day', 'continuous_activity_hours', 'is_cluster_device', 'cluster_type', 'risk_score', 'status', 'action_taken', 'first_detected_at', 'last_updated_at', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE device_cluster_detection ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS rule_name VARCHAR(100);
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS rule_type VARCHAR(50);
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS base_score INTEGER;
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS multiplier DECIMAL(4,2) DEFAULT 1.0;
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS action VARCHAR(20);
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS restrictions TEXT[];
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS message VARCHAR(200);
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS thresholds JSONB DEFAULT '{}';
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS conditions JSONB DEFAULT '{}';
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 100;
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE device_risk_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.device_risk_rules') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('rule_name', 'rule_type', 'base_score', 'multiplier', 'action', 'restrictions', 'message', 'thresholds', 'conditions', 'is_active', 'priority', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE device_risk_rules ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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

DROP TRIGGER IF EXISTS trigger_device_registrations_updated ON device_registrations;
CREATE TRIGGER trigger_device_registrations_updated
    BEFORE UPDATE ON device_registrations
    FOR EACH ROW EXECUTE FUNCTION update_device_updated_at();

DROP TRIGGER IF EXISTS trigger_device_account_updated ON device_account_associations;
CREATE TRIGGER trigger_device_account_updated
    BEFORE UPDATE ON device_account_associations
    FOR EACH ROW EXECUTE FUNCTION update_device_updated_at();

DROP TRIGGER IF EXISTS trigger_device_risk_rules_updated ON device_risk_rules;
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