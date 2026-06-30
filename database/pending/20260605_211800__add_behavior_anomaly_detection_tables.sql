-- REQ-00028: 玩家行为异常模式智能检测系统
-- 创建时间: 2026-06-05 21:18
-- 描述: 建立行为异常检测所需的数据表

-- ============================================================
-- 1. 设备指纹表
-- ============================================================
CREATE TABLE IF NOT EXISTS device_fingerprints (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash VARCHAR(64) NOT NULL,
  device_info JSONB NOT NULL,
  ip_hash VARCHAR(64),
  first_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, device_hash)
);

COMMENT ON TABLE device_fingerprints IS '设备指纹表，用于检测多账号同设备';
COMMENT ON COLUMN device_fingerprints.device_hash IS '设备唯一标识哈希';
COMMENT ON COLUMN device_fingerprints.device_info IS '设备详细信息（UA、分辨率、平台等）';

CREATE INDEX IF NOT EXISTS idx_device_hash ON device_fingerprints(device_hash);
CREATE INDEX IF NOT EXISTS idx_device_user ON device_fingerprints(user_id);
CREATE INDEX IF NOT EXISTS idx_device_last_seen ON device_fingerprints(last_seen DESC);

-- ============================================================
-- 2. 捕捉尝试记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS catch_attempts (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pokemon_id INTEGER NOT NULL,
  pokemon_rarity VARCHAR(20) NOT NULL,
  success BOOLEAN NOT NULL,
  expected_rate DOUBLE PRECISION,
  actual_items_used JSONB,
  technique VARCHAR(20),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE catch_attempts IS '捕捉尝试记录，用于成功率异常分析';
COMMENT ON COLUMN catch_attempts.expected_rate IS '期望捕获率（基于稀有度、道具、技术）';

CREATE INDEX IF NOT EXISTS idx_catch_attempts_user_time ON catch_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_catch_attempts_rarity ON catch_attempts(pokemon_rarity, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_attempts_success ON catch_attempts(success, created_at);

-- ============================================================
-- 3. 用户行为统计快照表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_behavior_stats (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat_type VARCHAR(50) NOT NULL,
  stat_value DOUBLE PRECISION,
  percentile_rank DOUBLE PRECISION,
  is_anomaly BOOLEAN DEFAULT FALSE,
  anomaly_details JSONB,
  snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, stat_type, snapshot_at)
);

COMMENT ON TABLE user_behavior_stats IS '用户行为统计快照，每小时更新';
COMMENT ON COLUMN user_behavior_stats.stat_type IS '统计类型：catch_rate, win_rate, resource_growth, active_hours';
COMMENT ON COLUMN user_behavior_stats.percentile_rank IS '在全服玩家中的百分位排名';

CREATE INDEX IF NOT EXISTS idx_behavior_stats_user ON user_behavior_stats(user_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_stats_type ON user_behavior_stats(stat_type, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_behavior_stats_anomaly ON user_behavior_stats(is_anomaly, snapshot_at);

-- ============================================================
-- 4. 行为异常记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS behavior_anomaly_records (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anomaly_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  details JSONB,
  behavior_score_before INTEGER,
  behavior_score_after INTEGER,
  action_taken VARCHAR(50),
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE behavior_anomaly_records IS '行为异常记录';
COMMENT ON COLUMN behavior_anomaly_records.anomaly_type IS '异常类型：CATCH_RATE_ANOMALY, SUSPICIOUS_WIN_RATE, etc.';
COMMENT ON COLUMN behavior_anomaly_records.action_taken IS '采取的行动：FLAGGED, WARNED, SUSPENDED, BANNED';

CREATE INDEX IF NOT EXISTS idx_anomaly_records_user ON behavior_anomaly_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_records_type ON behavior_anomaly_records(anomaly_type, severity);
CREATE INDEX IF NOT EXISTS idx_anomaly_records_severity ON behavior_anomaly_records(severity, created_at DESC);

-- ============================================================
-- 5. 用户行为评分表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_behavior_scores (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  behavior_score INTEGER NOT NULL DEFAULT 100 CHECK (behavior_score >= 0 AND behavior_score <= 100),
  gps_trust_score INTEGER DEFAULT 100 CHECK (gps_trust_score >= 0 AND gps_trust_score <= 100),
  final_trust_score INTEGER NOT NULL DEFAULT 100 CHECK (final_trust_score >= 0 AND final_trust_score <= 100),
  last_analysis_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id)
);

COMMENT ON TABLE user_behavior_scores IS '用户行为可信度评分';
COMMENT ON COLUMN user_behavior_scores.behavior_score IS '行为评分（0-100，100为完全可信）';
COMMENT ON COLUMN user_behavior_scores.final_trust_score IS '最终信任评分（结合GPS可信度）';

CREATE INDEX IF NOT EXISTS idx_behavior_scores_user ON user_behavior_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_behavior_scores_score ON user_behavior_scores(final_trust_score);
CREATE INDEX IF NOT EXISTS idx_behavior_scores_updated ON user_behavior_scores(updated_at DESC);

-- ============================================================
-- 6. 全局资源统计表
-- ============================================================
CREATE TABLE IF NOT EXISTS global_resource_stats (
  id SERIAL PRIMARY KEY,
  resource_type VARCHAR(20) NOT NULL,
  stat_date DATE NOT NULL,
  mean_value DOUBLE PRECISION,
  median_value DOUBLE PRECISION,
  p25_value DOUBLE PRECISION,
  p50_value DOUBLE PRECISION,
  p75_value DOUBLE PRECISION,
  p90_value DOUBLE PRECISION,
  p95_value DOUBLE PRECISION,
  p99_value DOUBLE PRECISION,
  sample_count INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (resource_type, stat_date)
);

COMMENT ON TABLE global_resource_stats IS '全局资源增长统计，用于异常对比';

CREATE INDEX IF NOT EXISTS idx_global_resource_type_date ON global_resource_stats(resource_type, stat_date DESC);

-- ============================================================
-- 7. 用户移动轨迹表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_movement_trajectories (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id VARCHAR(50) NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  speed DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE user_movement_trajectories IS '用户移动轨迹记录，用于轨迹异常分析';

CREATE INDEX IF NOT EXISTS idx_trajectory_user_session ON user_movement_trajectories(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_trajectory_user_time ON user_movement_trajectories(user_id, timestamp DESC);

-- ============================================================
-- 8. 用户行为事件日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_action_events (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type VARCHAR(50) NOT NULL,
  action_data JSONB,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  device_hash VARCHAR(64),
  ip_hash VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE user_action_events IS '用户行为事件日志，用于时段模式分析';
COMMENT ON COLUMN user_action_events.action_type IS '动作类型：CATCH, BATTLE, TRADE, COLLECT_REWARD';

CREATE INDEX IF NOT EXISTS idx_action_events_user_time ON user_action_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_events_type ON user_action_events(action_type, created_at);

-- ============================================================
-- 9. 插入默认行为评分记录
-- ============================================================
INSERT INTO user_behavior_scores (user_id, behavior_score, gps_trust_score, final_trust_score)
SELECT id, 100, 100, 100 FROM users
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- 10. 创建分析函数
-- ============================================================

-- 计算用户捕捉成功率异常
CREATE OR REPLACE FUNCTION analyze_catch_rate_anomaly(
  p_user_id INTEGER,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  rarity VARCHAR,
  total_attempts BIGINT,
  successful BIGINT,
  actual_rate DOUBLE PRECISION,
  expected_rate DOUBLE PRECISION,
  deviation DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ca.pokemon_rarity::VARCHAR,
    COUNT(*)::BIGINT as total_attempts,
    SUM(CASE WHEN ca.success THEN 1 ELSE 0 END)::BIGINT as successful,
    (SUM(CASE WHEN ca.success THEN 1 ELSE 0 END)::DOUBLE PRECISION / COUNT(*)::DOUBLE PRECISION) as actual_rate,
    AVG(ca.expected_rate) as expected_rate,
    ((SUM(CASE WHEN ca.success THEN 1 ELSE 0 END)::DOUBLE PRECISION / COUNT(*)::DOUBLE PRECISION) - AVG(ca.expected_rate)) / NULLIF(AVG(ca.expected_rate), 0) as deviation
  FROM catch_attempts ca
  WHERE ca.user_id = p_user_id
    AND ca.created_at > NOW() - (p_days || ' days')::INTERVAL
  GROUP BY ca.pokemon_rarity
  HAVING COUNT(*) >= 10; -- 至少10次尝试才分析
END;
$$ LANGUAGE plpgsql;

-- 更新用户行为评分
CREATE OR REPLACE FUNCTION update_user_behavior_score(
  p_user_id INTEGER,
  p_behavior_score INTEGER
)
RETURNS void AS $$
BEGIN
  INSERT INTO user_behavior_scores (user_id, behavior_score, final_trust_score, updated_at)
  VALUES (p_user_id, p_behavior_score, (p_behavior_score + COALESCE(
    (SELECT gps_trust_score FROM user_behavior_scores WHERE user_id = p_user_id), 100
  )) / 2, NOW())
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    behavior_score = EXCLUDED.behavior_score,
    final_trust_score = (EXCLUDED.behavior_score + user_behavior_scores.gps_trust_score) / 2,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- 清理旧数据（保留最近30天）
CREATE OR REPLACE FUNCTION cleanup_old_behavior_data()
RETURNS void AS $$
BEGIN
  DELETE FROM catch_attempts WHERE created_at < NOW() - INTERVAL '30 days';
  DELETE FROM user_movement_trajectories WHERE created_at < NOW() - INTERVAL '7 days';
  DELETE FROM user_action_events WHERE created_at < NOW() - INTERVAL '30 days';
  DELETE FROM user_behavior_stats WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 11. 创建定时任务
-- ============================================================

-- 每小时更新行为统计
-- -- -- -- -- -- -- -- -- -- -- SELECT cron.schedule(
-- -- -- -- -- -- -- -- -- -- --   'update_behavior_stats_hourly',
-- -- -- -- -- -- -- -- -- -- --   '0 * * * *',
-- -- -- -- -- -- -- -- -- -- --   $$
-- -- -- -- -- -- -- -- -- -- --   INSERT INTO user_behavior_stats (user_id, stat_type, stat_value, snapshot_at)
-- -- -- -- -- -- -- -- -- -- --   SELECT 
-- -- -- -- -- -- -- -- -- -- --     user_id,
-- -- -- -- -- -- -- -- -- -- --     'catch_rate',
-- -- -- -- -- -- -- -- -- -- --     SUM(CASE WHEN success THEN 1 ELSE 0 END)::DOUBLE PRECISION / COUNT(*)::DOUBLE PRECISION,
-- -- -- -- -- -- -- -- -- -- --     NOW()
-- -- -- -- -- -- -- -- -- -- --   FROM catch_attempts
-- -- -- -- -- -- -- -- -- -- --   WHERE created_at > NOW() - INTERVAL '1 hour'
-- -- -- -- -- -- -- -- -- -- --   GROUP BY user_id
-- -- -- -- -- -- -- -- -- -- --   ON CONFLICT (user_id, stat_type, snapshot_at) DO NOTHING;
-- -- -- -- -- -- -- -- -- -- --   $$
-- -- -- -- -- -- -- -- -- -- -- );

-- 每天凌晨3点清理旧数据
-- -- -- -- -- -- -- -- -- -- -- SELECT cron.schedule(
-- -- -- -- -- -- -- -- -- -- --   'cleanup_old_behavior_data_daily',
-- -- -- -- -- -- -- -- -- -- --   '0 3 * * *',
-- -- -- -- -- -- -- -- -- -- --   'SELECT cleanup_old_behavior_data();'
-- );

COMMIT;
