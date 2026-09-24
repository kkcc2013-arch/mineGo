-- ============================================================
-- REQ-00082: 精灵捕捉成功率异常检测系统
-- 数据库迁移文件
-- ============================================================

-- 捕捉成功率统计表（按小时维度）
CREATE TABLE IF NOT EXISTS catch_success_stats (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_id VARCHAR(64) NOT NULL,
    pokemon_rarity VARCHAR(32) NOT NULL CHECK(pokemon_rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
    ball_type VARCHAR(32) NOT NULL CHECK(ball_type IN ('POKE_BALL', 'GREAT_BALL', 'ULTRA_BALL', 'MASTER_BALL')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    expected_success_rate DECIMAL(5,4), -- 基础捕捉率（理论值）
    actual_success_rate DECIMAL(5,4), -- 实际捕捉率
    anomaly_score DECIMAL(5,2) DEFAULT 0.0, -- 异常评分 0-100
    hour_timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_user_pokemon_ball_hour UNIQUE(user_id, pokemon_id, ball_type, hour_timestamp)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS pokemon_id VARCHAR(64);
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS pokemon_rarity VARCHAR(32);
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS ball_type VARCHAR(32);
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0;
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS success_count INTEGER DEFAULT 0;
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS expected_success_rate DECIMAL(5,4);
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS actual_success_rate DECIMAL(5,4);
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS anomaly_score DECIMAL(5,2) DEFAULT 0.0;
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS hour_timestamp TIMESTAMPTZ;
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE catch_success_stats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_catch_stats_user ON catch_success_stats(user_id, hour_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_catch_stats_anomaly ON catch_success_stats(hour_timestamp, anomaly_score DESC);
CREATE INDEX IF NOT EXISTS idx_catch_stats_rarity ON catch_success_stats(pokemon_rarity, hour_timestamp);

COMMENT ON TABLE catch_success_stats IS '捕捉成功率统计表，用于分析玩家捕捉行为异常';

-- 扩展 catch_sessions 表，增加风控字段
ALTER TABLE catch_sessions ADD COLUMN IF NOT EXISTS session_signature VARCHAR(128);
ALTER TABLE catch_sessions ADD COLUMN IF NOT EXISTS request_nonce VARCHAR(64);
ALTER TABLE catch_sessions ADD COLUMN IF NOT EXISTS location_signature VARCHAR(128);
ALTER TABLE catch_sessions ADD COLUMN IF NOT EXISTS data_integrity_score DECIMAL(5,2) DEFAULT 100.0;
ALTER TABLE catch_sessions ADD COLUMN IF NOT EXISTS risk_score DECIMAL(5,2) DEFAULT 0.0;
ALTER TABLE catch_sessions ADD COLUMN IF NOT EXISTS risk_level VARCHAR(16) DEFAULT 'low' CHECK(risk_level IN ('low', 'medium', 'high', 'critical'));
ALTER TABLE catch_sessions ADD COLUMN IF NOT EXISTS action_taken VARCHAR(32) DEFAULT 'allowed' CHECK(action_taken IN ('allowed', 'warned', 'blocked'));

CREATE INDEX IF NOT EXISTS idx_catch_sessions_risk ON catch_sessions(risk_level, created_at DESC) WHERE risk_level != 'low';

-- 道具使用记录表（用于检测道具异常）
CREATE TABLE IF NOT EXISTS item_usage_records (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type VARCHAR(64) NOT NULL,
    item_category VARCHAR(32) NOT NULL CHECK(item_category IN ('ball', 'berry', 'medicine', 'evolution', 'boost')),
    session_id VARCHAR(128),
    pokemon_id VARCHAR(64),
    quantity_used INTEGER NOT NULL DEFAULT 1,
    quantity_before INTEGER,
    quantity_after INTEGER,
    expected_effect DECIMAL(5,4),
    actual_effect DECIMAL(5,4),
    anomaly_detected BOOLEAN DEFAULT false,
    anomaly_details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS item_type VARCHAR(64);
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS item_category VARCHAR(32);
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS session_id VARCHAR(128);
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS pokemon_id VARCHAR(64);
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS quantity_used INTEGER DEFAULT 1;
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS quantity_before INTEGER;
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS quantity_after INTEGER;
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS expected_effect DECIMAL(5,4);
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS actual_effect DECIMAL(5,4);
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS anomaly_detected BOOLEAN DEFAULT false;
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS anomaly_details JSONB;
ALTER TABLE item_usage_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_item_usage_records_user_time ON item_usage_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_usage_records_anomaly ON item_usage_records (anomaly_detected, created_at DESC);

COMMENT ON TABLE item_usage_records IS '道具使用记录表，用于检测道具数量和效果篡改';

-- 风控决策日志表
CREATE TABLE IF NOT EXISTS risk_decision_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(128),
    action_type VARCHAR(32) NOT NULL CHECK(action_type IN ('catch_attempt', 'item_use', 'inventory_check')),
    risk_score DECIMAL(5,2) NOT NULL,
    risk_level VARCHAR(16) NOT NULL,
    action_taken VARCHAR(32) NOT NULL,
    rule_scores JSONB NOT NULL DEFAULT '{}',
    request_data_hash VARCHAR(128),
    client_ip_hash VARCHAR(64),
    user_agent_hash VARCHAR(64),
    device_fingerprint VARCHAR(256),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS session_id VARCHAR(128);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS action_type VARCHAR(32);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS risk_score DECIMAL(5,2);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS risk_level VARCHAR(16);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS action_taken VARCHAR(32);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS rule_scores JSONB DEFAULT '{}';
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS request_data_hash VARCHAR(128);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS client_ip_hash VARCHAR(64);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS user_agent_hash VARCHAR(64);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR(256);
ALTER TABLE risk_decision_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_risk_decision_logs_risk_user ON risk_decision_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_decision_logs_risk_level ON risk_decision_logs (risk_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_decision_logs_risk_session ON risk_decision_logs (session_id);

COMMENT ON TABLE risk_decision_logs IS '风控决策日志表，记录所有捕捉请求的风险评估';

-- 用户风控状态表
CREATE TABLE IF NOT EXISTS user_risk_profiles (
    id SERIAL PRIMARY KEY,
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total_catch_attempts BIGINT NOT NULL DEFAULT 0,
    total_anomaly_detections BIGINT NOT NULL DEFAULT 0,
    total_blocks BIGINT NOT NULL DEFAULT 0,
    last_anomaly_at TIMESTAMPTZ,
    last_block_at TIMESTAMPTZ,
    baseline_success_rate DECIMAL(5,4), -- 基于历史的基准成功率
    current_streak_anomaly INTEGER DEFAULT 0,
    is_flagged BOOLEAN DEFAULT false,
    flag_reason TEXT,
    flag_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS total_catch_attempts BIGINT DEFAULT 0;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS total_anomaly_detections BIGINT DEFAULT 0;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS total_blocks BIGINT DEFAULT 0;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS last_anomaly_at TIMESTAMPTZ;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS last_block_at TIMESTAMPTZ;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS baseline_success_rate DECIMAL(5,4);
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS current_streak_anomaly INTEGER DEFAULT 0;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT false;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS flag_expires_at TIMESTAMPTZ;
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE user_risk_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_user_risk_profiles_flagged ON user_risk_profiles (is_flagged, updated_at DESC);

COMMENT ON TABLE user_risk_profiles IS '用户风控状态表，追踪用户的整体风控状态';

-- 创建触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_catch_stats_timestamp ON catch_success_stats;
CREATE TRIGGER update_catch_stats_timestamp
BEFORE UPDATE ON catch_success_stats
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_user_risk_timestamp ON user_risk_profiles;
CREATE TRIGGER update_user_risk_timestamp
BEFORE UPDATE ON user_risk_profiles
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 创建视图：高风险捕捉会话汇总
CREATE OR REPLACE VIEW v_high_risk_catches AS
SELECT
    cs.id,
    cs.user_id,
    u.username,
    cs.pokemon_id,
    ps.name_zh,
    cs.risk_score,
    cs.risk_level,
    cs.action_taken,
    cs.created_at
FROM catch_sessions cs
JOIN users u ON u.id = cs.user_id
LEFT JOIN pokemon_species ps ON ps.id = cs.pokemon_id::INTEGER
WHERE cs.risk_level IN ('high', 'critical')
  AND cs.created_at > NOW() - INTERVAL '24 hours'
ORDER BY cs.risk_score DESC, cs.created_at DESC;

COMMENT ON VIEW v_high_risk_catches IS '高风险捕捉会话汇总视图';

-- 创建视图：用户异常捕捉统计
CREATE OR REPLACE VIEW v_user_catch_anomaly_stats AS
SELECT
    urp.user_id,
    u.username,
    urp.total_catch_attempts,
    urp.total_anomaly_detections,
    CASE
        WHEN urp.total_catch_attempts > 0 
        THEN ROUND((urp.total_anomaly_detections::DECIMAL / urp.total_catch_attempts) * 100, 2)
        ELSE 0
    END AS anomaly_rate,
    urp.baseline_success_rate,
    urp.current_streak_anomaly,
    urp.is_flagged,
    urp.flag_reason,
    urp.last_anomaly_at
FROM user_risk_profiles urp
JOIN users u ON u.id = urp.user_id
ORDER BY urp.total_anomaly_detections DESC;

COMMENT ON VIEW v_user_catch_anomaly_stats IS '用户异常捕捉统计视图';

-- 插入默认风控配置（如果配置表存在）
INSERT INTO system_config (config_key, config_value, description)
VALUES 
    ('risk.catch.anomaly_threshold', '70', '捕捉成功率异常评分阈值'),
    ('risk.catch.batch_threshold', '50', '批量捕捉检测阈值'),
    ('risk.catch.integrity_threshold', '60', '数据完整性评分阈值'),
    ('risk.catch.item_anomaly_threshold', '50', '道具异常评分阈值'),
    ('risk.catch.min_sample_size', '20', '异常检测最小样本数'),
    ('risk.catch.block_duration_hours', '24', '高风险用户封禁时长（小时）')
ON CONFLICT (config_key) DO NOTHING;
