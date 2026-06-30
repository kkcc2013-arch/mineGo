-- REQ-00074: 玩家排行榜系统
-- 创建时间: 2026-06-10 02:00

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
CREATE TABLE seasons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  leaderboard_type leaderboard_type NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- active, ended
  rewards JSONB DEFAULT '[]', -- 奖励配置
  created_at TIMESTAMP DEFAULT NOW()
);

-- 排行榜主表
CREATE TABLE leaderboards (
  id SERIAL PRIMARY KEY,
  leaderboard_type leaderboard_type NOT NULL,
  season_id INTEGER REFERENCES seasons(id),
  player_id UUID REFERENCES users(id),
  score BIGINT NOT NULL DEFAULT 0,
  rank INTEGER,
  previous_rank INTEGER,
  metadata JSONB DEFAULT '{}', -- 额外统计信息
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(leaderboard_type, season_id, player_id)
);

-- 排名历史记录
CREATE TABLE leaderboard_history (
  id SERIAL PRIMARY KEY,
  season_id INTEGER REFERENCES seasons(id),
  player_id UUID REFERENCES users(id),
  leaderboard_type leaderboard_type NOT NULL,
  final_rank INTEGER NOT NULL,
  final_score BIGINT NOT NULL,
  rewards_claimed BOOLEAN DEFAULT FALSE,
  rewards_claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 排名快照表（每日记录）
CREATE TABLE leaderboard_snapshots (
  id SERIAL PRIMARY KEY,
  leaderboard_type leaderboard_type NOT NULL,
  season_id INTEGER REFERENCES seasons(id),
  player_id UUID REFERENCES users(id),
  rank INTEGER NOT NULL,
  score BIGINT NOT NULL,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(leaderboard_type, season_id, player_id, snapshot_date)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_leaderboards_type_season ON leaderboards(leaderboard_type, season_id);
CREATE INDEX IF NOT EXISTS idx_leaderboards_score ON leaderboards(leaderboard_type, season_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboards_player ON leaderboards(player_id);
CREATE INDEX IF NOT EXISTS idx_seasons_active ON seasons(status, end_time);
CREATE INDEX IF NOT EXISTS idx_seasons_type ON seasons(leaderboard_type, status);
CREATE INDEX IF NOT EXISTS idx_leaderboard_history_season ON leaderboard_history(season_id, player_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_date ON leaderboard_snapshots(snapshot_date);

-- 插入初始赛季数据
INSERT INTO seasons (name, leaderboard_type, start_time, end_time, rewards) VALUES
('捕捉大师赛季 #1', 'catch_total', NOW(), NOW() + INTERVAL '30 days', 
 '[{"rank": 1, "coins": 10000, "items": ["rare_candy", "lucky_egg"]}, {"rank": 2, "coins": 5000, "items": ["rare_candy"]}, {"rank": 3, "coins": 3000, "items": []}]'),
('PVP 战神赛季 #1', 'battle_pvp', NOW(), NOW() + INTERVAL '30 days',
 '[{"rank": 1, "coins": 15000, "items": ["elite_tm", "rare_candy"]}, {"rank": 2, "coins": 8000, "items": ["elite_tm"]}, {"rank": 3, "coins": 5000, "items": []}]'),
('图鉴收集家赛季 #1', 'pokedex_completion', NOW(), NOW() + INTERVAL '30 days',
 '[{"rank": 1, "coins": 12000, "items": ["incubator", "lure_module"]}, {"rank": 2, "coins": 6000, "items": ["incubator"]}, {"rank": 3, "coins": 4000, "items": []}]'),
('闪光猎人赛季 #1', 'shiny_collection', NOW(), NOW() + INTERVAL '30 days',
 '[{"rank": 1, "coins": 20000, "items": ["shiny_charm", "super_incubator"]}, {"rank": 2, "coins": 10000, "items": ["shiny_charm"]}, {"rank": 3, "coins": 7000, "items": []}]');

-- 添加注释
COMMENT ON TABLE seasons IS '赛季配置表';
COMMENT ON TABLE leaderboards IS '排行榜主表';
COMMENT ON TABLE leaderboard_history IS '赛季结束后的排名历史记录';
COMMENT ON TABLE leaderboard_snapshots IS '每日排名快照，用于历史对比';
COMMENT ON TYPE leaderboard_type IS '排行榜类型枚举';
