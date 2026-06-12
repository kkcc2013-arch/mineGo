-- REQ-00082: 精灵捕捉成功率异常检测系统
-- 创建捕捉成功率统计表和捕捉会话表

-- ============================================================
-- 1. 捕捉成功率统计表（按小时维度）
-- ============================================================
CREATE TABLE IF NOT EXISTS catch_success_stats (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  pokemon_id VARCHAR(64) NOT NULL,
  pokemon_rarity VARCHAR(32) NOT NULL, -- common/rare/epic/legendary
  ball_type VARCHAR(32) NOT NULL, -- poke/great/ultra/master
  attempt_count INT DEFAULT 0,
  success_count INT DEFAULT 0,
  expected_success_rate DECIMAL(5,4), -- 基础捕捉率
  actual_success_rate DECIMAL(5,4), -- 实际捕捉率
  anomaly_score DECIMAL(5,2), -- 异常评分 0-100
  hour_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_catch_stats_user_pokemon ON catch_success_stats(user_id, pokemon_id);
CREATE INDEX IF NOT EXISTS idx_catch_stats_hour_anomaly ON catch_success_stats(hour_timestamp, anomaly_score);
CREATE INDEX IF NOT EXISTS idx_catch_stats_rarity ON catch_success_stats(pokemon_rarity);

-- ============================================================
-- 2. 捕捉会话表
-- ============================================================
CREATE TABLE IF NOT EXISTS catch_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(128) UNIQUE NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  pokemon_id VARCHAR(64) NOT NULL,
  pokemon_rarity VARCHAR(32),
  ball_type VARCHAR(32),
  ball_count_used INT,
  berries_used INT DEFAULT 0,
  throw_type VARCHAR(32), -- normal/nice/great/excellent
  curveball BOOLEAN DEFAULT FALSE,
  expected_success_rate DECIMAL(5,4),
  actual_result VARCHAR(16), -- success/fail/escape
  catch_timestamp TIMESTAMPTZ NOT NULL,
  location_lat DECIMAL(10, 7),
  location_lng DECIMAL(10, 7),
  device_fingerprint VARCHAR(256),
  request_signature VARCHAR(512),
  data_integrity_score DECIMAL(5,2),
  risk_score DECIMAL(5,2),
  risk_level VARCHAR(16), -- low/medium/high/critical
  action_taken VARCHAR(32), -- allowed/warned/blocked
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_catch_sessions_user_time ON catch_sessions(user_id, catch_timestamp);
CREATE INDEX IF NOT EXISTS idx_catch_sessions_risk ON catch_sessions(risk_level, catch_timestamp);
CREATE INDEX IF NOT EXISTS idx_catch_sessions_result ON catch_sessions(actual_result);
CREATE INDEX IF NOT EXISTS idx_catch_sessions_pokemon ON catch_sessions(pokemon_id);

-- ============================================================
-- 3. 捕捉风险决策日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS catch_risk_decisions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  total_risk_score DECIMAL(5,2),
  risk_level VARCHAR(16),
  action VARCHAR(32),
  success_rate_score DECIMAL(5,2),
  batch_score DECIMAL(5,2),
  integrity_score DECIMAL(5,2),
  item_score DECIMAL(5,2),
  device_score DECIMAL(5,2),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_decisions_user ON catch_risk_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_risk_decisions_time ON catch_risk_decisions(created_at);

-- ============================================================
-- 4. 用户捕捉行为统计表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_catch_stats (
  user_id VARCHAR(64) PRIMARY KEY,
  total_catches INT DEFAULT 0,
  total_attempts INT DEFAULT 0,
  success_rate_7d DECIMAL(5,4),
  success_rate_30d DECIMAL(5,4),
  anomaly_count INT DEFAULT 0,
  last_anomaly_at TIMESTAMPTZ,
  trust_score INT DEFAULT 100,
  warning_count INT DEFAULT 0,
  blocked_count INT DEFAULT 0,
  last_catch_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 5. 插入初始配置数据
-- ============================================================
INSERT INTO catch_success_stats (user_id, pokemon_id, pokemon_rarity, ball_type, attempt_count, success_count, expected_success_rate, actual_success_rate, anomaly_score, hour_timestamp)
VALUES 
  ('system', 'config', 'common', 'poke', 0, 0, 0.40, 0, 0, NOW()),
  ('system', 'config', 'rare', 'poke', 0, 0, 0.20, 0, 0, NOW()),
  ('system', 'config', 'epic', 'poke', 0, 0, 0.10, 0, 0, NOW()),
  ('system', 'config', 'legendary', 'poke', 0, 0, 0.05, 0, 0, NOW())
ON CONFLICT DO NOTHING;

-- ============================================================
-- 注释
-- ============================================================
COMMENT ON TABLE catch_success_stats IS 'REQ-00082: 捕捉成功率统计表（按小时维度）';
COMMENT ON TABLE catch_sessions IS 'REQ-00082: 捕捉会话表，记录每次捕捉请求的详细信息';
COMMENT ON TABLE catch_risk_decisions IS 'REQ-00082: 捕捉风险决策日志表';
COMMENT ON TABLE user_catch_stats IS 'REQ-00082: 用户捕捉行为统计表';
