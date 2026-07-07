-- REQ-00487: 精灵竞技联赛系统
-- 创建联赛相关数据表

-- 联赛赛季表
CREATE TABLE IF NOT EXISTS league_seasons (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL UNIQUE,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  total_players INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_league_seasons_status ON league_seasons(status);

-- 联赛成员表
CREATE TABLE IF NOT EXISTS league_members (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  league_level VARCHAR(20) NOT NULL DEFAULT 'BRONZE',
  league_group VARCHAR(10) NOT NULL DEFAULT 'III',
  league_points INTEGER NOT NULL DEFAULT 0,
  league_rating INTEGER NOT NULL DEFAULT 1000,
  consecutive_wins INTEGER NOT NULL DEFAULT 0,
  season_id INTEGER NOT NULL REFERENCES league_seasons(id),
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  last_match_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(player_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_league_members_season ON league_members(season_id, league_level, league_group);
CREATE INDEX IF NOT EXISTS idx_league_members_rating ON league_members(season_id, league_rating);
CREATE INDEX IF NOT EXISTS idx_league_members_player ON league_members(player_id);

-- 联赛对战记录表
CREATE TABLE IF NOT EXISTS league_matches (
  id SERIAL PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES league_seasons(id),
  player1_id INTEGER NOT NULL,
  player2_id INTEGER NOT NULL,
  winner_id INTEGER,
  player1_points_change INTEGER,
  player2_points_change INTEGER,
  match_duration_seconds INTEGER,
  match_time TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_league_matches_season ON league_matches(season_id, match_time);
CREATE INDEX IF NOT EXISTS idx_league_matches_player ON league_matches(player1_id, player2_id);

-- 联赛升降级历史表
CREATE TABLE IF NOT EXISTS league_history (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  action VARCHAR(20) NOT NULL,
  from_level VARCHAR(20),
  from_group VARCHAR(10),
  to_level VARCHAR(20),
  to_group VARCHAR(10),
  points_at_action INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_league_history_player ON league_history(player_id);
CREATE INDEX IF NOT EXISTS idx_league_history_season ON league_history(season_id);

-- 联赛奖励记录表
CREATE TABLE IF NOT EXISTS league_rewards (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  reward_type VARCHAR(20) NOT NULL,
  league_level VARCHAR(20) NOT NULL,
  final_rank INTEGER,
  reward_data JSONB NOT NULL,
  claimed BOOLEAN DEFAULT false,
  claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_league_rewards_player ON league_rewards(player_id, season_id);
CREATE INDEX IF NOT EXISTS idx_league_rewards_claimed ON league_rewards(player_id, claimed);

-- 插入初始赛季
INSERT INTO league_seasons (season_number, start_time, end_time, status)
VALUES (
  1,
  '2026-07-01 00:00:00',
  '2026-07-29 00:00:00',
  'active'
) ON CONFLICT (season_number) DO NOTHING;
