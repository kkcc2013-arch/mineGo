-- REQ-00074: 玩家排行榜系统
-- 创建时间：2026-06-29

-- 排行榜类型枚举
CREATE TYPE leaderboard_type AS ENUM (
  'catch_total',        -- 捕捉总数榜
  'catch_rare',         -- 稀有捕捉榜
  'battle_pvp',         -- PVP积分榜
  'battle_gym',         -- 道馆战斗榜
  'pokedex_completion', -- 图鉴完成榜
  'shiny_collection',   -- 闪光收集榜
  'guild_contribution'  -- 公会贡献榜
);

-- 赛季表
CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  leaderboard_type leaderboard_type NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  rewards JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 排行榜主表
CREATE TABLE IF NOT EXISTS leaderboards (
  id SERIAL PRIMARY KEY,
  leaderboard_type leaderboard_type NOT NULL,
  season_id INTEGER REFERENCES seasons(id),
  player_id INTEGER REFERENCES users(id),
  score BIGINT NOT NULL DEFAULT 0,
  rank INTEGER,
  previous_rank INTEGER,
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(leaderboard_type, season_id, player_id)
);

-- 排名历史记录
CREATE TABLE IF NOT EXISTS leaderboard_history (
  id SERIAL PRIMARY KEY,
  season_id INTEGER REFERENCES seasons(id),
  player_id INTEGER REFERENCES users(id),
  leaderboard_type leaderboard_type NOT NULL,
  final_rank INTEGER NOT NULL,
  final_score BIGINT NOT NULL,
  rewards_claimed BOOLEAN DEFAULT FALSE,
  rewards_claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_leaderboards_type_season ON leaderboards(leaderboard_type, season_id);
CREATE INDEX IF NOT EXISTS idx_leaderboards_score ON leaderboards(leaderboard_type, season_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboards_player ON leaderboards(player_id);
CREATE INDEX IF NOT EXISTS idx_seasons_active ON seasons(status, end_time);
CREATE INDEX IF NOT EXISTS idx_leaderboard_history_season ON leaderboard_history(season_id, player_id);

-- 初始化默认赛季
INSERT INTO seasons (name, leaderboard_type, start_time, end_time, rewards) VALUES
('2026年夏季捕捉赛季', 'catch_total', '2026-06-01 00:00:00', '2026-08-31 23:59:59', 
  '[{"rank": 1, "coins": 10000, "items": ["rare-candy-x10", "master-ball-x1"]}, 
   {"rank": 2, "coins": 5000, "items": ["rare-candy-x5"]}, 
   {"rank": 3, "coins": 3000, "items": ["rare-candy-x3"]}]'::jsonb),
('2026年夏季PVP赛季', 'battle_pvp', '2026-06-01 00:00:00', '2026-08-31 23:59:59',
  '[{"rank": 1, "coins": 15000, "title": "pvp-master"}, 
   {"rank": 2, "coins": 8000}, 
   {"rank": 3, "coins": 5000}]'::jsonb),
('2026年图鉴完成赛季', 'pokedex_completion', '2026-06-01 00:00:00', '2026-12-31 23:59:59',
  '[{"rank": 1, "coins": 20000, "title": "collector-king"}]'::jsonb),
('2026年闪光收集赛季', 'shiny_collection', '2026-06-01 00:00:00', '2026-12-31 23:59:59',
  '[{"rank": 1, "coins": 25000, "title": "shiny-hunter"}]'::jsonb);

COMMENT ON TABLE seasons IS '赛季配置表';
COMMENT ON TABLE leaderboards IS '排行榜数据表';
COMMENT ON TABLE leaderboard_history IS '赛季历史排名记录';