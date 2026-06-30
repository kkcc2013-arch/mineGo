-- REQ-00073: PVP 玩家对战系统数据库迁移
-- 创建时间: 2026-06-10 01:30

-- PVP 对战记录表
CREATE TABLE IF NOT EXISTS pvp_battles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id UUID NOT NULL REFERENCES users(id),
  defender_id UUID NOT NULL REFERENCES users(id),
  battle_type VARCHAR(20) NOT NULL CHECK (battle_type IN ('friendly', 'ranked', 'casual')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  winner_id UUID REFERENCES users(id),
  battle_data JSONB,
  turns INTEGER DEFAULT 0,
  elo_change JSONB,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvp_battles_attacker ON pvp_battles(attacker_id);
CREATE INDEX IF NOT EXISTS idx_pvp_battles_defender ON pvp_battles(defender_id);
CREATE INDEX IF NOT EXISTS idx_pvp_battles_status ON pvp_battles(status);
CREATE INDEX IF NOT EXISTS idx_pvp_battles_type ON pvp_battles(battle_type);
CREATE INDEX IF NOT EXISTS idx_pvp_battles_created ON pvp_battles(created_at DESC);

-- PVP 排位积分表
CREATE TABLE IF NOT EXISTS pvp_rankings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  elo_rating INTEGER NOT NULL DEFAULT 1000,
  tier VARCHAR(20) NOT NULL DEFAULT 'bronze' CHECK (tier IN ('bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster')),
  tier_points INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  total_battles INTEGER DEFAULT 0,
  season_id INTEGER,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvp_rankings_elo ON pvp_rankings(elo_rating DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_rankings_tier ON pvp_rankings(tier);
CREATE INDEX IF NOT EXISTS idx_pvp_rankings_streak ON pvp_rankings(current_streak DESC);

-- PVP 赛季表
CREATE TABLE IF NOT EXISTS pvp_seasons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  season_number INTEGER NOT NULL,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  rewards JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvp_seasons_active ON pvp_seasons(is_active);
CREATE INDEX IF NOT EXISTS idx_pvp_seasons_dates ON pvp_seasons(start_date, end_date);

-- PVP 队伍配置表
CREATE TABLE IF NOT EXISTS pvp_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name VARCHAR(50),
  pokemon_ids INTEGER[] NOT NULL CHECK (array_length(pokemon_ids, 1) = 3),
  is_active BOOLEAN DEFAULT true,
  total_cp INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvp_teams_user ON pvp_teams(user_id);
CREATE INDEX IF NOT EXISTS idx_pvp_teams_active ON pvp_teams(is_active);

-- PVP 战斗回放表
CREATE TABLE IF NOT EXISTS pvp_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id UUID NOT NULL REFERENCES pvp_battles(id) ON DELETE CASCADE,
  replay_data JSONB NOT NULL,
  views INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvp_replays_battle ON pvp_replays(battle_id);
CREATE INDEX IF NOT EXISTS idx_pvp_replays_created ON pvp_replays(created_at DESC);

-- 匹配队列表
CREATE TABLE IF NOT EXISTS pvp_match_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) UNIQUE,
  elo_rating INTEGER NOT NULL,
  preferences JSONB DEFAULT '{}',
  matched BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvp_match_queue_elo ON pvp_match_queue(elo_rating);
CREATE INDEX IF NOT EXISTS idx_pvp_match_queue_created ON pvp_match_queue(created_at);

-- 插入初始赛季数据
INSERT INTO pvp_seasons (name, season_number, start_date, end_date, rewards, is_active)
VALUES (
  'Season 1 - Genesis',
  1,
  NOW(),
  NOW() + INTERVAL '90 days',
  '{
    "grandmaster": {"pokemon_egg": "legendary", "coins": 5000, "title": "传奇挑战者"},
    "master": {"pokemon_egg": "epic", "coins": 3000, "avatar_frame": "master"},
    "diamond": {"pokemon_egg": "rare", "coins": 2000},
    "platinum": {"items": [{"type": "premium_ball", "count": 10}], "coins": 1000},
    "gold": {"items": [{"type": "premium_ball", "count": 5}], "coins": 500},
    "silver": {"items": [{"type": "poke_ball", "count": 10}], "coins": 200},
    "bronze": {"items": [{"type": "poke_ball", "count": 5}], "coins": 100}
  }',
  true
);

-- 触发器：更新 pvp_rankings 的 updated_at
CREATE OR REPLACE FUNCTION update_pvp_rankings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_pvp_rankings_timestamp
BEFORE UPDATE ON pvp_rankings
FOR EACH ROW
EXECUTE FUNCTION update_pvp_rankings_timestamp();

-- 注释
COMMENT ON TABLE pvp_battles IS 'PVP 对战记录表';
COMMENT ON TABLE pvp_rankings IS 'PVP 排位积分表';
COMMENT ON TABLE pvp_seasons IS 'PVP 赛季表';
COMMENT ON TABLE pvp_teams IS 'PVP 队伍配置表';
COMMENT ON TABLE pvp_replays IS 'PVP 战斗回放表';
COMMENT ON TABLE pvp_match_queue IS 'PVP 匹配队列表';
