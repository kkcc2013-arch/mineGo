-- Anti-cheat system tables
-- REQ-00010: GPS 伪造检测与速度限制反作弊系统

-- 用户位置历史表
CREATE TABLE IF NOT EXISTS user_location_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  altitude DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  is_mock BOOLEAN DEFAULT FALSE,
  recorded_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引：按用户和时间查询
CREATE INDEX IF NOT EXISTS idx_location_history_user_time 
ON user_location_history(user_id, recorded_at DESC);

-- 索引：按时间清理旧数据
CREATE INDEX IF NOT EXISTS idx_location_history_created 
ON user_location_history(created_at);

-- 作弊记录表
CREATE TABLE IF NOT EXISTS anti_cheat_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'SPEED_ANOMALY', 'GPS_FAKE', 'BEHAVIOR_ANOMALY', 'TRUST_DECREASE', 'TRUST_INCREASE'
  severity VARCHAR(20) NOT NULL, -- 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  details JSONB,
  trust_score_before INTEGER,
  trust_score_after INTEGER,
  action_taken VARCHAR(50), -- 'WARN', 'THROTTLE', 'BLOCK', 'BAN'
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引：按用户查询
CREATE INDEX IF NOT EXISTS idx_anticheat_user 
ON anti_cheat_records(user_id, created_at DESC);

-- 索引：按类型统计
CREATE INDEX IF NOT EXISTS idx_anticheat_type 
ON anti_cheat_records(type, created_at);

-- 索引：按严重程度
CREATE INDEX IF NOT EXISTS idx_anticheat_severity 
ON anti_cheat_records(severity, created_at);

-- 注释
COMMENT ON TABLE user_location_history IS '用户位置历史记录，用于反作弊分析';
COMMENT ON TABLE anti_cheat_records IS '反作弊记录，记录作弊行为和可信度变化';
