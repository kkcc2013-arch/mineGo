-- database/pending/20260614_090500__add_daily_quest_system.sql
-- REQ-00097: 精灵日常任务系统与任务奖励机制
-- 创建任务定义表、玩家任务表、任务历史表和连击记录表

-- 任务定义表
CREATE TABLE IF NOT EXISTS quest_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quest_type VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'social', 'explore', 'evolve', 'breed', 'special'
    title_i18n_key VARCHAR(100) NOT NULL, -- 国际化 key
    description_i18n_key VARCHAR(100) NOT NULL,
    objective_type VARCHAR(50) NOT NULL, -- 'catch_pokemon', 'win_gym_battle', 'trade_pokemon', etc.
    objective_params JSONB DEFAULT '{}', -- {'type': 'water', 'count': 5}
    difficulty VARCHAR(20) NOT NULL DEFAULT 'medium', -- 'easy', 'medium', 'hard'
    reward_config JSONB NOT NULL, -- {'items': [...], 'stardust': 500, 'xp': 100}
    time_restriction JSONB, -- {'weather': 'rain', 'timeOfDay': 'night'}
    weight INTEGER DEFAULT 100, -- 抽取权重
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家任务表
CREATE TABLE IF NOT EXISTS player_quests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_definition_id UUID NOT NULL REFERENCES quest_definitions(id),
    quest_pool VARCHAR(20) NOT NULL, -- 'daily', 'weekly', 'limited_time'
    progress_current INTEGER DEFAULT 0,
    progress_target INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'in_progress', -- 'in_progress', 'completed', 'claimed'
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    claimed_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_quest UNIQUE (user_id, quest_definition_id, assigned_at::date)
);

-- 任务完成历史
CREATE TABLE IF NOT EXISTS quest_completion_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_definition_id UUID NOT NULL,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    rewards_claimed JSONB NOT NULL,
    streak_day INTEGER, -- 连击天数
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家连击记录
CREATE TABLE IF NOT EXISTS player_quest_streaks (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_completion_date DATE,
    multiplier DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_player_quests_user_status ON player_quests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_player_quests_expires ON player_quests(expires_at) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_quest_completion_user_date ON quest_completion_history(user_id, completed_at::date);
CREATE INDEX IF NOT EXISTS idx_quest_definitions_type ON quest_definitions(quest_type, is_active);
CREATE INDEX IF NOT EXISTS idx_player_quests_assigned ON player_quests(user_id, assigned_at::date);

-- 种子数据：示例任务定义
INSERT INTO quest_definitions (quest_type, title_i18n_key, description_i18n_key, objective_type, objective_params, difficulty, reward_config, weight) VALUES
-- 捕捉任务
('catch', 'quest.catch_water.title', 'quest.catch_water.desc', 'catch_pokemon', '{"type": "water", "count": 5}', 'easy', '{"items": [{"type": "poke_ball", "count": 10}], "stardust": 500, "xp": 200}', 100),
('catch', 'quest.catch_fire.title', 'quest.catch_fire.desc', 'catch_pokemon', '{"type": "fire", "count": 3}', 'medium', '{"items": [{"type": "great_ball", "count": 5}], "stardust": 600, "xp": 300}', 90),
('catch', 'quest.catch_rare.title', 'quest.catch_rare.desc', 'catch_pokemon', '{"rarity": "rare", "count": 3}', 'hard', '{"items": [{"type": "ultra_ball", "count": 5}, {"type": "rare_candy", "count": 1}], "stardust": 1000, "xp": 500}', 50),
('catch', 'quest.catch_total.title', 'quest.catch_total.desc', 'catch_pokemon', '{"count": 10}', 'easy', '{"items": [{"type": "poke_ball", "count": 15}], "stardust": 400, "xp": 150}', 120),
('catch', 'quest.catch_legendary.title', 'quest.catch_legendary.desc', 'catch_pokemon', '{"rarity": "legendary", "count": 1}', 'hard', '{"items": [{"type": "golden_razz_berry", "count": 3}, {"type": "rare_candy", "count": 5}], "stardust": 2000, "xp": 1000}', 20),

-- 战斗任务
('battle', 'quest.gym_battle.title', 'quest.gym_battle.desc', 'win_gym_battle', '{"count": 3}', 'medium', '{"items": [{"type": "revive", "count": 3}, {"type": "potion", "count": 5}], "stardust": 800, "xp": 400}', 80),
('battle', 'quest.raid_win.title', 'quest.raid_win.desc', 'win_raid', '{"count": 1}', 'hard', '{"items": [{"type": "rare_candy", "count": 3}, {"type": "golden_razz_berry", "count": 2}], "stardust": 1500, "xp": 600}', 60),
('battle', 'quest.gym_train.title', 'quest.gym_train.desc', 'gym_battle', '{"count": 5}', 'easy', '{"items": [{"type": "potion", "count": 10}], "stardust": 500, "xp": 200}', 100),

-- 社交任务
('social', 'quest.trade.title', 'quest.trade.desc', 'trade_pokemon', '{"count": 1}', 'easy', '{"items": [{"type": "poke_ball", "count": 5}], "stardust": 300, "xp": 150}', 100),
('social', 'quest.gift_send.title', 'quest.gift_send.desc', 'send_gift', '{"count": 3}', 'easy', '{"items": [{"type": "poke_ball", "count": 8}], "stardust": 400, "xp": 200}', 110),
('social', 'quest.friend_add.title', 'quest.friend_add.desc', 'add_friend', '{"count": 1}', 'easy', '{"items": [{"type": "great_ball", "count": 3}], "stardust": 500, "xp": 300}', 80),

-- 探索任务
('explore', 'quest.pokestop.title', 'quest.pokestop.desc', 'visit_pokestop', '{"count": 3}', 'easy', '{"items": [{"type": "poke_ball", "count": 8}], "stardust": 400, "xp": 200}', 100),
('explore', 'quest.pokestop_chain.title', 'quest.pokestop_chain.desc', 'visit_pokestop', '{"count": 7}', 'medium', '{"items": [{"type": "great_ball", "count": 5}, {"type": "razz_berry", "count": 3}], "stardust": 700, "xp": 350}', 70),
('explore', 'quest.hatch_egg.title', 'quest.hatch_egg.desc', 'hatch_egg', '{"count": 1}', 'medium', '{"items": [{"type": "incubator", "count": 1}], "stardust": 800, "xp": 400}', 60),

-- 进化任务
('evolve', 'quest.evolve.title', 'quest.evolve.desc', 'evolve_pokemon', '{"count": 2}', 'medium', '{"items": [{"type": "razz_berry", "count": 3}], "stardust": 600, "xp": 300}', 90),
('evolve', 'quest.evolve_new.title', 'quest.evolve_new.desc', 'evolve_pokemon', '{"new_entry": true, "count": 1}', 'hard', '{"items": [{"type": "ultra_ball", "count": 10}], "stardust": 1200, "xp": 600}', 40),

-- 培育任务
('breed', 'quest.hatch_specific.title', 'quest.hatch_specific.desc', 'hatch_egg', '{"distance": 5, "count": 1}', 'medium', '{"items": [{"type": "rare_candy", "count": 2}], "stardust": 1000, "xp": 500}', 50),
('breed', 'quest.breed_start.title', 'quest.breed_start.desc', 'start_breeding', '{"count": 1}', 'medium', '{"items": [{"type": "incubator", "count": 1}], "stardust": 600, "xp": 300}', 70),

-- 特殊任务（天气、时间相关）
('special', 'quest.weather_rain.title', 'quest.weather_rain.desc', 'catch_pokemon', '{"weather": "rain", "count": 3}', 'medium', '{"items": [{"type": "golden_razz_berry", "count": 1}], "stardust": 700, "xp": 350}', 60),
('special', 'quest.weather_sunny.title', 'quest.weather_sunny.desc', 'catch_pokemon', '{"weather": "sunny", "count": 3}', 'medium', '{"items": [{"type": "golden_razz_berry", "count": 1}], "stardust": 700, "xp": 350}', 60),
('special', 'quest.night_catch.title', 'quest.night_catch.desc', 'catch_pokemon', '{"timeOfDay": "night", "count": 5}', 'medium', '{"items": [{"type": "great_ball", "count": 5}], "stardust": 600, "xp": 300}', 50),
('special', 'quest.spin_streak.title', 'quest.spin_streak.desc', 'pokestop_streak', '{"count": 7}', 'hard', '{"items": [{"type": "ultra_ball", "count": 10}, {"type": "rare_candy", "count": 2}], "stardust": 1500, "xp": 800}', 30)
ON CONFLICT DO NOTHING;

-- 注释
COMMENT ON TABLE quest_definitions IS '任务定义表：存储所有可用的任务类型和配置';
COMMENT ON TABLE player_quests IS '玩家任务表：记录玩家当前分配的任务和进度';
COMMENT ON TABLE quest_completion_history IS '任务完成历史：记录玩家完成的所有任务';
COMMENT ON TABLE player_quest_streaks IS '玩家连击记录：记录玩家的连续完成任务天数';
