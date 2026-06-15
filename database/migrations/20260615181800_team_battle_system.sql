-- REQ-00109: 团队战斗系统数据库迁移
-- 创建时间: 2026-06-15 18:18

-- 团队表
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  leader_id INTEGER NOT NULL REFERENCES users(id),
  max_size INTEGER DEFAULT 5 CHECK (max_size BETWEEN 2 AND 5),
  battle_type VARCHAR(20) NOT NULL, -- 'raid', 'pvp_team', 'gym_assault'
  status VARCHAR(20) DEFAULT 'open', -- 'open', 'in_battle', 'closed'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_teams_leader ON teams(leader_id);
CREATE INDEX idx_teams_status ON teams(status);
CREATE INDEX idx_teams_battle_type ON teams(battle_type);

-- 团队成员表
CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_ids INTEGER[] NOT NULL DEFAULT '{}', -- 选择的精灵 ID 列表（最多 6 只）
  ready BOOLEAN DEFAULT false,
  joined_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

CREATE INDEX idx_team_members_team ON team_members(team_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);

-- 团队邀请表
CREATE TABLE IF NOT EXISTS team_invitations (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  inviter_id INTEGER NOT NULL REFERENCES users(id),
  invitee_id INTEGER NOT NULL REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', 'rejected', 'expired'
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_team_invitations_invitee ON team_invitations(invitee_id);
CREATE INDEX idx_team_invitations_status ON team_invitations(status);

-- Raid Boss 定义表
CREATE TABLE IF NOT EXISTS raid_bosses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  pokemon_id INTEGER NOT NULL,
  species VARCHAR(50) NOT NULL,
  types VARCHAR(20)[] NOT NULL,
  boss_hp INTEGER NOT NULL,
  boss_attack INTEGER NOT NULL,
  boss_defense INTEGER NOT NULL,
  boss_skills JSONB NOT NULL,
  cp_multiplier DECIMAL(5,2) NOT NULL,
  min_team_size INTEGER DEFAULT 2,
  max_team_size INTEGER DEFAULT 5,
  time_limit INTEGER DEFAULT 300, -- 秒
  rewards JSONB NOT NULL,
  active_from TIMESTAMP,
  active_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_raid_bosses_active ON raid_bosses(active_from, active_until);

-- Raid 战斗记录表
CREATE TABLE IF NOT EXISTS raid_battles (
  id SERIAL PRIMARY KEY,
  raid_boss_id INTEGER NOT NULL REFERENCES raid_bosses(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  status VARCHAR(20) DEFAULT 'ongoing', -- 'ongoing', 'won', 'lost'
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  boss_current_hp INTEGER,
  boss_max_hp INTEGER,
  duration_seconds INTEGER
);

CREATE INDEX idx_raid_battles_team ON raid_battles(team_id);
CREATE INDEX idx_raid_battles_status ON raid_battles(status);

-- 团队战斗统计表
CREATE TABLE IF NOT EXISTS team_battle_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) UNIQUE,
  total_battles INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_damage BIGINT DEFAULT 0,
  total_healing BIGINT DEFAULT 0,
  combos_triggered INTEGER DEFAULT 0,
  mvp_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_team_battle_stats_user ON team_battle_stats(user_id);

-- 团队战斗日志表（用于回放）
CREATE TABLE IF NOT EXISTS team_battle_logs (
  id SERIAL PRIMARY KEY,
  battle_id VARCHAR(36) NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  turn INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action_type VARCHAR(20) NOT NULL,
  action_data JSONB NOT NULL,
  result_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_team_battle_logs_battle ON team_battle_logs(battle_id);
CREATE INDEX idx_team_battle_logs_team ON team_battle_logs(team_id);

-- 插入示例 Raid Boss
INSERT INTO raid_bosses (name, pokemon_id, species, types, boss_hp, boss_attack, boss_defense, boss_skills, cp_multiplier, min_team_size, max_team_size, time_limit, rewards, active_from, active_until)
VALUES 
  ('传说烈空坐', 384, 'Rayquaza', ARRAY['dragon', 'flying'], 50000, 250, 150, 
   '[{"id": "dragon_ascent", "name": "画龙点睛", "type": "dragon", "power": 120, "accuracy": 100}, {"id": "hurricane", "name": "暴风", "type": "flying", "power": 110, "accuracy": 70}]'::jsonb,
   3.0, 3, 5, 300,
   '{"exp": 5000, "coins": 2000, "items": [{"itemId": "rare_candy", "quantity": 5}, {"itemId": "golden_razz_berry", "quantity": 3}]}'::jsonb,
   NOW(), NOW() + INTERVAL '7 days'),
  ('超梦 X', 150, 'Mewtwo', ARRAY['psychic', 'fighting'], 60000, 280, 120,
   '[{"id": "psystrike", "name": "精神强念", "type": "psychic", "power": 100, "accuracy": 100}, {"id": "aura_sphere", "name": "波导弹", "type": "fighting", "power": 80, "accuracy": 100}]'::jsonb,
   3.5, 4, 5, 360,
   '{"exp": 8000, "coins": 3000, "items": [{"itemId": "rare_candy", "quantity": 10}, {"itemId": "premium_pass", "quantity": 1}]}'::jsonb,
   NOW(), NOW() + INTERVAL '7 days');

-- 注释
COMMENT ON TABLE teams IS 'REQ-00109: 团队战斗系统 - 团队表';
COMMENT ON TABLE team_members IS 'REQ-00109: 团队战斗系统 - 团队成员表';
COMMENT ON TABLE team_invitations IS 'REQ-00109: 团队战斗系统 - 团队邀请表';
COMMENT ON TABLE raid_bosses IS 'REQ-00109: 团队战斗系统 - Raid Boss 定义';
COMMENT ON TABLE raid_battles IS 'REQ-00109: 团队战斗系统 - Raid 战斗记录';
COMMENT ON TABLE team_battle_stats IS 'REQ-00109: 团队战斗系统 - 团队战斗统计';
COMMENT ON TABLE team_battle_logs IS 'REQ-00109: 团队战斗系统 - 战斗日志（用于回放）';
