-- REQ-00076: 精灵成就系统与里程碑奖励
-- 数据库迁移：创建成就相关表

-- 成就定义表
CREATE TABLE IF NOT EXISTS achievements (
    id SERIAL PRIMARY KEY,
    achievement_id VARCHAR(50) UNIQUE NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('catch', 'breed', 'battle', 'social', 'explore')),
    name JSONB NOT NULL,
    description JSONB NOT NULL,
    icon_url VARCHAR(500),
    rarity VARCHAR(20) NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
    points INTEGER NOT NULL DEFAULT 10,
    is_hidden BOOLEAN DEFAULT FALSE,
    trigger_conditions JSONB NOT NULL,
    rewards JSONB NOT NULL,
    prerequisite_achievement_id VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    
    FOREIGN KEY (prerequisite_achievement_id) REFERENCES achievements(achievement_id)
);

-- 用户成就表
CREATE TABLE IF NOT EXISTS user_achievements (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    achievement_id VARCHAR(50) NOT NULL,
    progress INTEGER DEFAULT 0,
    target INTEGER NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    rewards_claimed BOOLEAN DEFAULT FALSE,
    rewards_claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (achievement_id) REFERENCES achievements(achievement_id) ON DELETE CASCADE,
    UNIQUE(user_id, achievement_id)
);

-- 成就进度快照（用于快速查询）
CREATE TABLE IF NOT EXISTS achievement_progress_snapshots (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    category_progress JSONB NOT NULL DEFAULT '{}',
    total_points INTEGER DEFAULT 0,
    achievements_completed INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW(),
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 成就触发事件日志
CREATE TABLE IF NOT EXISTS achievement_events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 称号表
CREATE TABLE IF NOT EXISTS user_titles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title_id VARCHAR(50) NOT NULL,
    source_achievement_id VARCHAR(50),
    is_active BOOLEAN DEFAULT FALSE,
    unlocked_at TIMESTAMP DEFAULT NOW(),
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (source_achievement_id) REFERENCES achievements(achievement_id) ON DELETE SET NULL,
    UNIQUE(user_id, title_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_completed ON user_achievements(completed) WHERE completed = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_achievements_achievement ON user_achievements(achievement_id);
CREATE INDEX IF NOT EXISTS idx_achievement_progress_user ON achievement_progress_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_achievement_events_user ON achievement_events(user_id, processed);
CREATE INDEX IF NOT EXISTS idx_achievement_events_type ON achievement_events(event_type);
CREATE INDEX IF NOT EXISTS idx_achievements_category ON achievements(category);
CREATE INDEX IF NOT EXISTS idx_achievements_hidden ON achievements(is_hidden);
CREATE INDEX IF NOT EXISTS idx_achievements_rarity ON achievements(rarity);
CREATE INDEX IF NOT EXISTS idx_user_titles_user ON user_titles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_titles_active ON user_titles(user_id, is_active) WHERE is_active = TRUE;

-- 插入种子数据：成就定义
INSERT INTO achievements (achievement_id, category, name, description, rarity, points, is_hidden, trigger_conditions, rewards) VALUES
-- 捕捉类成就
('first_catch', 'catch', '{"zh": "初次捕捉", "en": "First Catch"}', '{"zh": "捕捉你的第一只精灵", "en": "Catch your first Pokémon"}', 'common', 10, false, '{"type": "catch_count", "target": 1}', '{"coins": 100, "items": [{"item_id": "pokeball", "count": 10}]}'),
('catch_master_100', 'catch', '{"zh": "捕捉新手", "en": "Novice Catcher"}', '{"zh": "捕捉 100 只精灵", "en": "Catch 100 Pokémon"}', 'common', 50, false, '{"type": "catch_count", "target": 100}', '{"coins": 1000, "title": "catcher_100"}'),
('catch_master_500', 'catch', '{"zh": "捕捉达人", "en": "Skilled Catcher"}', '{"zh": "捕捉 500 只精灵", "en": "Catch 500 Pokémon"}', 'rare', 100, false, '{"type": "catch_count", "target": 500}', '{"coins": 5000, "items": [{"item_id": "great_ball", "count": 20}]}'),
('catch_master_1000', 'catch', '{"zh": "捕捉大师", "en": "Catch Master"}', '{"zh": "捕捉 1000 只精灵", "en": "Catch 1000 Pokémon"}', 'epic', 200, false, '{"type": "catch_count", "target": 1000}', '{"coins": 10000, "items": [{"item_id": "lucky_egg", "count": 5}], "title": "catcher_1000"}'),
('shiny_hunter', 'catch', '{"zh": "闪光猎人", "en": "Shiny Hunter"}', '{"zh": "捕捉第一只闪光精灵", "en": "Catch your first shiny Pokémon"}', 'rare', 100, false, '{"type": "shiny_catch", "target": 1}', '{"coins": 5000, "title": "shiny_hunter"}'),
('pokedex_50', 'catch', '{"zh": "图鉴新手", "en": "Pokédex Novice"}', '{"zh": "收集 50 种精灵", "en": "Collect 50 Pokémon species"}', 'common', 50, false, '{"type": "catch_species", "target": 50}', '{"coins": 1000}'),
('pokedex_100', 'catch', '{"zh": "图鉴收藏家", "en": "Pokédex Collector"}', '{"zh": "收集 100 种精灵", "en": "Collect 100 Pokémon species"}', 'rare', 150, false, '{"type": "catch_species", "target": 100}', '{"coins": 8000, "items": [{"item_id": "rare_candy", "count": 5}]}'),
('pokedex_151', 'catch', '{"zh": "图鉴大师", "en": "Pokédex Master"}', '{"zh": "收集 151 种精灵", "en": "Collect 151 Pokémon species"}', 'legendary', 500, false, '{"type": "catch_species", "target": 151}', '{"coins": 50000, "items": [{"item_id": "master_ball", "count": 1}], "title": "pokedex_master"}'),

-- 战斗类成就
('first_battle', 'battle', '{"zh": "初次战斗", "en": "First Battle"}', '{"zh": "赢得第一场战斗", "en": "Win your first battle"}', 'common', 10, false, '{"type": "battle_win", "target": 1}', '{"coins": 100}'),
('battle_master_50', 'battle', '{"zh": "战斗新手", "en": "Battle Novice"}', '{"zh": "赢得 50 场战斗", "en": "Win 50 battles"}', 'common', 50, false, '{"type": "battle_win", "target": 50}', '{"coins": 1000}'),
('battle_master_200', 'battle', '{"zh": "战斗达人", "en": "Battle Expert"}', '{"zh": "赢得 200 场战斗", "en": "Win 200 battles"}', 'rare', 100, false, '{"type": "battle_win", "target": 200}', '{"coins": 5000, "items": [{"item_id": "rare_candy", "count": 3}]}'),
('gym_conqueror_10', 'battle', '{"zh": "道馆挑战者", "en": "Gym Challenger"}', '{"zh": "攻克 10 座道馆", "en": "Conquer 10 gyms"}', 'rare', 100, false, '{"type": "gym_conquer", "target": 10}', '{"coins": 5000, "items": [{"item_id": "rare_candy", "count": 5}]}'),
('gym_conqueror_100', 'battle', '{"zh": "道馆征服者", "en": "Gym Conqueror"}', '{"zh": "攻克 100 座道馆", "en": "Conquer 100 gyms"}', 'epic', 200, false, '{"type": "gym_conquer", "target": 100}', '{"coins": 20000, "title": "gym_conqueror"}'),
('pvp_master_50', 'battle', '{"zh": "对战达人", "en": "PvP Expert"}', '{"zh": "赢得 50 场玩家对战", "en": "Win 50 PvP battles"}', 'rare', 100, false, '{"type": "battle_win", "target": 50, "filters": {"battle_type": "pvp"}}', '{"coins": 5000}'),
('pvp_master_100', 'battle', '{"zh": "对战大师", "en": "PvP Master"}', '{"zh": "赢得 100 场玩家对战", "en": "Win 100 PvP battles"}', 'epic', 200, false, '{"type": "battle_win", "target": 100, "filters": {"battle_type": "pvp"}}', '{"coins": 10000, "title": "pvp_master"}'),

-- 培育类成就
('first_breed', 'breed', '{"zh": "培育新人", "en": "Novice Breeder"}', '{"zh": "培育出第一只精灵", "en": "Breed your first Pokémon"}', 'common', 20, false, '{"type": "pokemon_breed", "target": 1}', '{"coins": 200}'),
('breed_master_50', 'breed', '{"zh": "培育达人", "en": "Skilled Breeder"}', '{"zh": "培育 50 只精灵", "en": "Breed 50 Pokémon"}', 'rare', 100, false, '{"type": "pokemon_breed", "target": 50}', '{"coins": 5000, "items": [{"item_id": "incubator", "count": 2}]}'),
('shiny_breeder', 'breed', '{"zh": "闪光培育师", "en": "Shiny Breeder"}', '{"zh": "培育出一只闪光精灵", "en": "Breed a shiny Pokémon"}', 'epic', 150, false, '{"type": "pokemon_breed", "target": 1, "filters": {"is_shiny": true}}', '{"coins": 8000, "title": "shiny_breeder"}'),
('egg_hatcher_100', 'breed', '{"zh": "蛋孵化达人", "en": "Egg Hatcher"}', '{"zh": "孵化 100 个蛋", "en": "Hatch 100 eggs"}', 'rare', 100, false, '{"type": "egg_hatch", "target": 100}', '{"coins": 5000}'),

-- 社交类成就
('first_trade', 'social', '{"zh": "首次交易", "en": "First Trade"}', '{"zh": "完成第一次精灵交易", "en": "Complete your first trade"}', 'common', 15, false, '{"type": "trade_count", "target": 1}', '{"coins": 150}'),
('trade_master_50', 'social', '{"zh": "交易达人", "en": "Trade Expert"}', '{"zh": "完成 50 次交易", "en": "Complete 50 trades"}', 'rare', 80, false, '{"type": "trade_count", "target": 50}', '{"coins": 3000}'),
('trade_master_100', 'social', '{"zh": "交易大师", "en": "Trade Master"}', '{"zh": "完成 100 次交易", "en": "Complete 100 trades"}', 'epic', 150, false, '{"type": "trade_count", "target": 100}', '{"coins": 8000, "title": "trade_master"}'),
('friend_maker_50', 'social', '{"zh": "社交达人", "en": "Social Butterfly"}', '{"zh": "添加 50 位好友", "en": "Add 50 friends"}', 'rare', 80, false, '{"type": "friend_count", "target": 50}', '{"coins": 3000}'),

-- 探索类成就
('walker_10km', 'explore', '{"zh": "步行者", "en": "Walker"}', '{"zh": "累计行走 10 公里", "en": "Walk 10 kilometers"}', 'common', 20, false, '{"type": "distance_traveled", "target": 10}', '{"coins": 300, "items": [{"item_id": "egg_incubator", "count": 1}]}'),
('walker_100km', 'explore', '{"zh": "徒步达人", "en": "Hiker"}', '{"zh": "累计行走 100 公里", "en": "Walk 100 kilometers"}', 'rare', 100, false, '{"type": "distance_traveled", "target": 100}', '{"coins": 5000, "items": [{"item_id": "super_incubator", "count": 1}]}'),
('walker_500km', 'explore', '{"zh": "探险家", "en": "Explorer"}', '{"zh": "累计行走 500 公里", "en": "Walk 500 kilometers"}', 'epic', 200, false, '{"type": "distance_traveled", "target": 500}', '{"coins": 15000, "title": "explorer"}'),
('walker_1000km', 'explore', '{"zh": "环球旅行家", "en": "World Traveler"}', '{"zh": "累计行走 1000 公里", "en": "Walk 1000 kilometers"}', 'legendary', 300, false, '{"type": "distance_traveled", "target": 1000}', '{"coins": 20000, "items": [{"item_id": "super_incubator", "count": 3}], "title": "world_traveler"}'),
('pokestop_visitor_100', 'explore', '{"zh": "补给站常客", "en": "Stop Visitor"}', '{"zh": "访问 100 次补给站", "en": "Visit 100 PokéStops"}', 'common', 50, false, '{"type": "pokestop_visit", "target": 100}', '{"coins": 1000}'),
('pokestop_visitor_1000', 'explore', '{"zh": "补给站猎人", "en": "Stop Hunter"}', '{"zh": "访问 1000 次补给站", "en": "Visit 1000 PokéStops"}', 'rare', 150, false, '{"type": "pokestop_visit", "target": 1000}', '{"coins": 8000, "title": "stop_hunter"}'),

-- 隐藏成就
('lucky_encounter', 'catch', '{"zh": "幸运邂逅", "en": "Lucky Encounter"}', '{"zh": "???", "en": "???"}', 'legendary', 200, true, '{"type": "lucky_catch", "target": 1}', '{"coins": 15000, "items": [{"item_id": "lucky_pendant", "count": 1}]}'),
('perfectionist', 'breed', '{"zh": "完美主义者", "en": "Perfectionist"}', '{"zh": "???", "en": "???"}', 'legendary', 300, true, '{"type": "perfect_iv_breed", "target": 1}', '{"coins": 20000, "items": [{"item_id": "iv_checker", "count": 1}]}')
ON CONFLICT (achievement_id) DO NOTHING;

COMMENT ON TABLE achievements IS '成就定义表';
COMMENT ON TABLE user_achievements IS '用户成就进度表';
COMMENT ON TABLE achievement_progress_snapshots IS '成就进度快照，用于快速查询';
COMMENT ON TABLE achievement_events IS '成就触发事件日志';
COMMENT ON TABLE user_titles IS '用户称号表';

COMMENT ON COLUMN achievements.trigger_conditions IS '触发条件JSON，如 {"type": "catch_count", "target": 100, "filters": {...}}';
COMMENT ON COLUMN achievements.rewards IS '奖励JSON，如 {"coins": 1000, "items": [...], "title": "xxx"}';
COMMENT ON COLUMN user_achievements.progress IS '当前进度值';
COMMENT ON COLUMN user_achievements.target IS '目标值（从成就定义复制）';
