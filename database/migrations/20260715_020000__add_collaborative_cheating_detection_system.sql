-- database/migrations/20260715_020000__add_collaborative_cheating_detection_system.sql
-- REQ-00550: 协同作弊团伙检测系统

-- 团伙实体表
CREATE TABLE IF NOT EXISTS cheating_gangs (
  id SERIAL PRIMARY KEY,
  gang_id VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(128),
  status VARCHAR(32) DEFAULT 'active',
  risk_score DECIMAL(5,2) DEFAULT 0,
  risk_level VARCHAR(16) DEFAULT 'low',
  member_count INT DEFAULT 0,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity TIMESTAMPTZ,
  first_activity TIMESTAMPTZ,
  affected_resources JSONB DEFAULT '{}',
  evidence JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gang_status ON cheating_gangs(status, risk_level);
CREATE INDEX IF NOT EXISTS idx_gang_detected ON cheating_gangs(detected_at);
CREATE INDEX IF NOT EXISTS idx_gang_risk_score ON cheating_gangs(risk_score DESC);

-- 团伙成员关系表
CREATE TABLE IF NOT EXISTS gang_members (
  id SERIAL PRIMARY KEY,
  gang_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  role VARCHAR(32) DEFAULT 'member',
  join_score DECIMAL(5,2) DEFAULT 0,
  first_detected TIMESTAMPTZ DEFAULT NOW(),
  last_activity TIMESTAMPTZ,
  violations JSONB DEFAULT '[]',
  status VARCHAR(32) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(gang_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_gang ON gang_members(user_id);
CREATE INDEX IF NOT EXISTS idx_gang_role ON gang_members(gang_id, role);
CREATE INDEX IF NOT EXISTS idx_gang_member_status ON gang_members(status);

-- 团伙关系边（用于图分析）
CREATE TABLE IF NOT EXISTS gang_edges (
  id SERIAL PRIMARY KEY,
  gang_id VARCHAR(64) NOT NULL,
  user_id_a VARCHAR(64) NOT NULL,
  user_id_b VARCHAR(64) NOT NULL,
  edge_type VARCHAR(32) NOT NULL,
  weight DECIMAL(5,2) DEFAULT 1.0,
  evidence_count INT DEFAULT 1,
  first_evidence TIMESTAMPTZ DEFAULT NOW(),
  last_evidence TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(gang_id, user_id_a, user_id_b, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_gang_edges ON gang_edges(gang_id);
CREATE INDEX IF NOT EXISTS idx_user_edges ON gang_edges(user_id_a, user_id_b);
CREATE INDEX IF NOT EXISTS idx_edge_type ON gang_edges(edge_type);

-- 协同作弊事件表
CREATE TABLE IF NOT EXISTS collab_cheat_events (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(128) UNIQUE NOT NULL,
  gang_id VARCHAR(64),
  event_type VARCHAR(32) NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]',
  location TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  affected_pokemon_id VARCHAR(64),
  affected_gym_id VARCHAR(64),
  value_score DECIMAL(10,2) DEFAULT 0,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  evidence JSONB DEFAULT '{}',
  action_taken VARCHAR(32) DEFAULT 'logged',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gang_events ON collab_cheat_events(gang_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_event_type ON collab_cheat_events(event_type, detected_at);
CREATE INDEX IF NOT EXISTS idx_event_participants ON collab_cheat_events USING GIN(participants);

-- 添加注释
COMMENT ON TABLE cheating_gangs IS '作弊团伙信息表';
COMMENT ON TABLE gang_members IS '团伙成员关系表';
COMMENT ON TABLE gang_edges IS '团伙成员关系边（图分析用）';
COMMENT ON TABLE collab_cheat_events IS '协同作弊事件记录表';

COMMENT ON COLUMN cheating_gangs.risk_level IS '风险等级: low/medium/high/critical';
COMMENT ON COLUMN cheating_gangs.status IS '团伙状态: active/confirmed/disbanded';
COMMENT ON COLUMN gang_members.role IS '成员角色: leader/core/member/peripheral';
COMMENT ON COLUMN gang_edges.edge_type IS '边类型: spatial_temporal/trade/friend/gym_collab';
COMMENT ON COLUMN collab_cheat_events.event_type IS '事件类型: collab_catch/gym_collab/fake_trade/resource_transfer';