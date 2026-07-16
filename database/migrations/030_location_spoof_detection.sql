-- REQ-00586: GPS 位置欺骗检测与虚拟定位防护系统
-- 数据库迁移脚本

-- 位置可信度记录表
CREATE TABLE IF NOT EXISTS location_trust_records (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  location GEOMETRY(POINT, 4326),
  trust_score INT NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  device_risk_score INT,
  velocity_score INT,
  terrain_score INT,
  network_score INT,
  pattern_score INT,
  evidence JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ltr_user_id ON location_trust_records(user_id);
CREATE INDEX IF NOT EXISTS idx_ltr_trust_score ON location_trust_records(trust_score);
CREATE INDEX IF NOT EXISTS idx_ltr_created_at ON location_trust_records(created_at);

-- 可疑移动记录表
CREATE TABLE IF NOT EXISTS suspicious_movements (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  movement_type VARCHAR(50) NOT NULL,
  prev_location GEOMETRY(POINT, 4326),
  curr_location GEOMETRY(POINT, 4326),
  velocity FLOAT,
  risk_score INT,
  evidence JSONB,
  status VARCHAR(20) DEFAULT 'pending',
  reviewed_by VARCHAR(64),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sm_user_id ON suspicious_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_sm_movement_type ON suspicious_movements(movement_type);
CREATE INDEX IF NOT EXISTS idx_sm_status ON suspicious_movements(status);
CREATE INDEX IF NOT EXISTS idx_sm_created_at ON suspicious_movements(created_at);

-- 位置作弊封禁记录表
CREATE TABLE IF NOT EXISTS location_spoof_bans (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  ban_type VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  duration_ms BIGINT,
  start_at TIMESTAMPTZ DEFAULT NOW(),
  end_at TIMESTAMPTZ,
  lifted_at TIMESTAMPTZ,
  lifted_by VARCHAR(64),
  appeal_status VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lsb_user_id ON location_spoof_bans(user_id);
CREATE INDEX IF NOT EXISTS idx_lsb_ban_type ON location_spoof_bans(ban_type);
CREATE INDEX IF NOT EXISTS idx_lsb_start_at ON location_spoof_bans(start_at);
CREATE INDEX IF NOT EXISTS idx_lsb_end_at ON location_spoof_bans(end_at);