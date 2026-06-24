-- REQ-00269: 精灵锦标赛与竞技场赛季系统
-- 创建锦标赛与排位赛季相关表结构

-- 1. 赛季表 (seasons)
CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  season_number INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'upcoming', -- upcoming, active, ended
  config JSONB DEFAULT '{}', -- 赛季配置
  rewards JSONB DEFAULT '{}', -- 赛季奖励配置
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons(status);
CREATE INDEX IF NOT EXISTS idx_seasons_time ON seasons(start_time, end_time);

-- 2. 玩家段位表 (player_ranks)
CREATE TABLE IF NOT EXISTS player_ranks (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season_id INT NOT NULL REFERENCES seasons(id),
  tier VARCHAR(20) NOT NULL, -- bronze, silver, gold, platinum, diamond, master, grandmaster
  tier_level INT DEFAULT 1, -- 1-5, e.g., Gold III
  rank_points INT DEFAULT 0, -- 竞技积分
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  win_streak INT DEFAULT 0, -- 连胜场次
  max_win_streak INT DEFAULT 0,
  highest_tier VARCHAR(20), -- 本赛季最高段位
  placement_matches INT DEFAULT 0, -- 定位赛场次
  placement_done BOOLEAN DEFAULT FALSE,
  decay_points INT DEFAULT 0, -- 休眠衰减积分
  last_match_at TIMESTAMP,
  promoted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_player_ranks_season ON player_ranks(season_id);
CREATE INDEX IF NOT EXISTS idx_player_ranks_user ON player_ranks(user_id);
CREATE INDEX IF NOT EXISTS idx_player_ranks_tier ON player_ranks(season_id, tier, rank_points DESC);

-- 3. 锦标赛表 (tournaments)
CREATE TABLE IF NOT EXISTS tournaments (
  id SERIAL PRIMARY KEY,
  season_id INT REFERENCES seasons(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL, -- daily, weekly, monthly, special
  format VARCHAR(50) NOT NULL, -- elimination, swiss, round_robin
  min_tier VARCHAR(20), -- 最低段位限制
  max_participants INT DEFAULT 64,
  current_participants INT DEFAULT 0,
  registration_start TIMESTAMP NOT NULL,
  registration_end TIMESTAMP NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  status VARCHAR(20) DEFAULT 'upcoming', -- upcoming, registration, in_progress, completed, cancelled
  bracket JSONB DEFAULT '{}', -- 对战树
  rewards JSONB DEFAULT '{}', -- 奖励配置
  entry_fee JSONB DEFAULT '{}', -- 报名费用
  rules JSONB DEFAULT '{}', -- 比赛规则
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tournaments_season ON tournaments(season_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
CREATE INDEX IF NOT EXISTS idx_tournaments_time ON tournaments(start_time);

-- 4. 锦标赛参与者表 (tournament_participants)
CREATE TABLE IF NOT EXISTS tournament_participants (
  id SERIAL PRIMARY KEY,
  tournament_id INT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  seed INT, -- 种子排名
  current_round INT DEFAULT 0,
  match_wins INT DEFAULT 0,
  match_losses INT DEFAULT 0,
  eliminated BOOLEAN DEFAULT FALSE,
  final_rank INT,
  prizes_claimed BOOLEAN DEFAULT FALSE,
  registered_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_participants_tournament ON tournament_participants(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_participants_user ON tournament_participants(user_id);

-- 5. 对战记录表 (battle_records)
CREATE TABLE IF NOT EXISTS battle_records (
  id SERIAL PRIMARY KEY,
  season_id INT NOT NULL REFERENCES seasons(id),
  tournament_id INT REFERENCES tournaments(id),
  attacker_id INT NOT NULL REFERENCES users(id),
  defender_id INT NOT NULL REFERENCES users(id),
  attacker_pokemon JSONB NOT NULL, -- 参战精灵
  defender_pokemon JSONB NOT NULL,
  result VARCHAR(20) NOT NULL, -- win, lose, draw
  battle_type VARCHAR(50) NOT NULL, -- ranked, tournament, friendly
  rank_points_change INT DEFAULT 0, -- 积分变化
  battle_duration INT, -- 战斗时长（秒）
  battle_data JSONB DEFAULT '{}', -- 战斗详情
  rewards JSONB DEFAULT '{}', -- 奖励
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_battle_records_season ON battle_records(season_id);
CREATE INDEX IF NOT EXISTS idx_battle_records_attacker ON battle_records(attacker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_battle_records_defender ON battle_records(defender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_battle_records_tournament ON battle_records(tournament_id);

-- 6. 赛季奖励发放记录表 (season_rewards)
CREATE TABLE IF NOT EXISTS season_rewards (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season_id INT NOT NULL REFERENCES seasons(id),
  tier VARCHAR(20) NOT NULL,
  final_rank INT,
  rewards JSONB NOT NULL, -- 发放的奖励
  status VARCHAR(20) DEFAULT 'pending', -- pending, claimed
  claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_season_rewards_user ON season_rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_season_rewards_season ON season_rewards(season_id);
