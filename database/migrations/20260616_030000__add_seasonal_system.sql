-- 季节系统数据库迁移
-- 创建时间：2026-06-16 03:00

-- 季节配置表
CREATE TABLE IF NOT EXISTS seasonal_configs (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(season, year)
);

-- 季节精灵池
CREATE TABLE IF NOT EXISTS seasonal_pokemon_pools (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  pokemon_id VARCHAR(50) NOT NULL,
  rarity VARCHAR(20) NOT NULL,
  spawn_multiplier DECIMAL(5, 2) DEFAULT 1.0,
  is_shiny_boosted BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户季节进度
CREATE TABLE IF NOT EXISTS user_seasonal_progress (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  catches INT DEFAULT 0,
  quests_completed INT DEFAULT 0,
  achievements JSONB DEFAULT '[]',
  distance_walked DECIMAL(10, 2) DEFAULT 0,
  gym_battles INT DEFAULT 0,
  special_encounters INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, season, year)
);

-- 季节任务
CREATE TABLE IF NOT EXISTS seasonal_quests (
  id SERIAL PRIMARY KEY,
  quest_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  task_type VARCHAR(50) NOT NULL,
  target_value INT NOT NULL,
  rewards JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户季节任务进度
CREATE TABLE IF NOT EXISTS user_seasonal_quests (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  quest_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  progress INT DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  claimed BOOLEAN DEFAULT false,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, quest_id, season, year)
);

-- 季节商店
CREATE TABLE IF NOT EXISTS seasonal_shop_items (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  item_id VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price INT NOT NULL,
  currency VARCHAR(20) DEFAULT 'coins',
  contents JSONB,
  item_type VARCHAR(50),
  discount_rules JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户季节商店购买记录
CREATE TABLE IF NOT EXISTS user_seasonal_purchases (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  item_id VARCHAR(50) NOT NULL,
  quantity INT DEFAULT 1,
  price_paid INT NOT NULL,
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 季节成就
CREATE TABLE IF NOT EXISTS seasonal_achievements (
  id SERIAL PRIMARY KEY,
  achievement_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  condition_type VARCHAR(50) NOT NULL,
  condition_value JSONB NOT NULL,
  rewards JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(achievement_id, season)
);

-- 用户季节成就解锁
CREATE TABLE IF NOT EXISTS user_seasonal_achievements (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  achievement_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  claimed BOOLEAN DEFAULT false,
  UNIQUE(user_id, achievement_id, season, year)
);

-- 季节热点位置
CREATE TABLE IF NOT EXISTS seasonal_hotspots (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  location_type VARCHAR(50) NOT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  radius INT DEFAULT 100,
  spawn_boost DECIMAL(5, 2) DEFAULT 1.5,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 季节特殊遭遇
CREATE TABLE IF NOT EXISTS seasonal_encounters (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  pokemon_id VARCHAR(50) NOT NULL,
  location_lat DECIMAL(10, 8),
  location_lng DECIMAL(11, 8),
  encountered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  caught BOOLEAN DEFAULT false,
  is_shiny BOOLEAN DEFAULT false
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_seasonal_configs_season_year ON seasonal_configs(season, year);
CREATE INDEX IF NOT EXISTS idx_seasonal_pokemon_pools_season ON seasonal_pokemon_pools(season);
CREATE INDEX IF NOT EXISTS idx_user_seasonal_progress_user_season ON user_seasonal_progress(user_id, season, year);
CREATE INDEX IF NOT EXISTS idx_user_seasonal_quests_user_season ON user_seasonal_quests(user_id, season, year);
CREATE INDEX IF NOT EXISTS idx_seasonal_hotspots_season ON seasonal_hotspots(season);
CREATE INDEX IF NOT EXISTS idx_seasonal_encounters_user_season ON seasonal_encounters(user_id, season);

-- 插入初始季节任务数据
INSERT INTO seasonal_quests (quest_id, season, name, description, task_type, target_value, rewards) VALUES
('spring_catch_10', 'SPRING', '春日捕捉', '捕捉 10 只草系精灵', 'catch_type', 10, '{"stardust": 500, "item": "lucky_egg"}'),
('spring_evolve_5', 'SPRING', '生命绽放', '进化 5 只精灵', 'evolve', 5, '{"xp": 2000, "item": "sun_stone"}'),
('spring_walk_5km', 'SPRING', '春游踏青', '行走 5 公里', 'walk_distance', 5000, '{"candy": 10, "item": "incense"}'),
('summer_catch_15', 'SUMMER', '夏日炎炎', '捕捉 15 只火系精灵', 'catch_type', 15, '{"stardust": 600, "item": "heat_rock"}'),
('summer_gym_5', 'SUMMER', '沙滩对决', '参与 5 次道馆战斗', 'gym_battle', 5, '{"xp": 3000, "item": "rare_candy"}'),
('summer_hatch_3', 'SUMMER', '烈日孵化', '孵化 3 个蛋', 'hatch_eggs', 3, '{"stardust": 800, "item": "super_incubator"}'),
('autumn_catch_ghost', 'AUTUMN', '幽灵之夜', '捕捉 10 只幽灵系精灵', 'catch_type', 10, '{"stardust": 700, "item": "dusk_stone"}'),
('autumn_trade_3', 'AUTUMN', '秋收分享', '完成 3 次精灵交易', 'trade', 3, '{"xp": 2500, "item": "trade_ticket"}'),
('autumn_spin_20', 'AUTUMN', '落叶寻宝', '旋转 20 个 PokéStop', 'spin_pokestops', 20, '{"item": "pumpkin_berry", "qty": 10}'),
('winter_catch_ice', 'WINTER', '冰雪奇缘', '捕捉 10 只冰系精灵', 'catch_type', 10, '{"stardust": 800, "item": "glacial_lure"}'),
('winter_buddy_3', 'WINTER', '冬日陪伴', '与伙伴精灵互动 3 次', 'buddy_interact', 3, '{"hearts": 3, "item": "poffin"}'),
('winter_gift_5', 'WINTER', '冬日礼物', '发送 5 份礼物给好友', 'send_gifts', 5, '{"xp": 1500, "item": "holiday_box"}')
ON CONFLICT DO NOTHING;

-- 插入季节成就数据
INSERT INTO seasonal_achievements (achievement_id, season, name, description, condition_type, condition_value, rewards) VALUES
('spring_master', 'SPRING', '春之大师', '完成所有春季任务', 'complete_all_quests', '{}', '{"badge": "spring_badge", "stardust": 5000}'),
('grass_collector', 'SPRING', '草系收藏家', '捕捉 100 只草系精灵', 'catch_type_count', '{"type": "grass", "count": 100}', '{"medal": "grass_gold", "xp": 10000}'),
('summer_master', 'SUMMER', '夏日英雄', '完成所有夏季任务', 'complete_all_quests', '{}', '{"badge": "summer_badge", "stardust": 5000}'),
('fire_catcher', 'SUMMER', '火焰捕捉者', '捕捉 100 只火系精灵', 'catch_type_count', '{"type": "fire", "count": 100}', '{"medal": "fire_gold", "xp": 10000}'),
('autumn_master', 'AUTUMN', '秋日神秘家', '完成所有秋季任务', 'complete_all_quests', '{}', '{"badge": "autumn_badge", "stardust": 5000}'),
('ghost_hunter', 'AUTUMN', '幽灵猎人', '捕捉 100 只幽灵系精灵', 'catch_type_count', '{"type": "ghost", "count": 100}', '{"medal": "ghost_gold", "xp": 10000}'),
('winter_master', 'WINTER', '冰雪王者', '完成所有冬季任务', 'complete_all_quests', '{}', '{"badge": "winter_badge", "stardust": 5000}'),
('ice_catcher', 'WINTER', '冰霜收集者', '捕捉 100 只冰系精灵', 'catch_type_count', '{"type": "ice", "count": 100}', '{"medal": "ice_gold", "xp": 10000}')
ON CONFLICT DO NOTHING;
