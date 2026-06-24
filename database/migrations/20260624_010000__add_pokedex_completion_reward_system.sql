-- REQ-00056: 精灵图鉴完成度奖励系统
-- 创建图鉴进度追踪、里程碑奖励、成就系统相关表

-- ============================================
-- 图鉴进度记录表
-- ============================================
CREATE TABLE IF NOT EXISTS pokedex_progress (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_species_id INTEGER NOT NULL,
    seen BOOLEAN DEFAULT FALSE,
    caught BOOLEAN DEFAULT FALSE,
    catch_count INTEGER DEFAULT 0,
    shiny_caught BOOLEAN DEFAULT FALSE,
    first_seen_at TIMESTAMP WITH TIME ZONE,
    first_caught_at TIMESTAMP WITH TIME ZONE,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    last_caught_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, pokemon_species_id)
);

COMMENT ON TABLE pokedex_progress IS '用户图鉴进度记录';
COMMENT ON COLUMN pokedex_progress.seen IS '是否见过该精灵';
COMMENT ON COLUMN pokedex_progress.caught IS '是否捕获过该精灵';
COMMENT ON COLUMN pokedex_progress.catch_count IS '捕获次数';
COMMENT ON COLUMN pokedex_progress.shiny_caught IS '是否捕获过闪光形态';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pokedex_progress_user ON pokedex_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_pokedex_progress_species ON pokedex_progress(pokemon_species_id);
CREATE INDEX IF NOT EXISTS idx_pokedex_progress_caught ON pokedex_progress(user_id, caught) WHERE caught = TRUE;
CREATE INDEX IF NOT EXISTS idx_pokedex_progress_shiny ON pokedex_progress(user_id, shiny_caught) WHERE shiny_caught = TRUE;

-- ============================================
-- 图鉴里程碑奖励表
-- ============================================
CREATE TABLE IF NOT EXISTS pokedex_milestones (
    id SERIAL PRIMARY KEY,
    milestone_type VARCHAR(20) NOT NULL CHECK (milestone_type IN ('percentage', 'count', 'special')),
    category VARCHAR(50), -- 'shiny', 'legendary', 'kanto', etc.
    threshold INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0,
    reward_type VARCHAR(50) NOT NULL,
    reward_data JSONB NOT NULL,
    title VARCHAR(100) NOT NULL,
    title_zh VARCHAR(100),
    description TEXT,
    description_zh TEXT,
    icon VARCHAR(100),
    is_repeatable BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pokedex_milestones IS '图鉴里程碑奖励配置';

-- 插入默认里程碑数据
INSERT INTO pokedex_milestones (milestone_type, threshold, sort_order, reward_type, reward_data, title, title_zh, description, description_zh, icon) VALUES
('percentage', 10, 1, 'items', '{"items": [{"id": "poke_ball", "count": 10}, {"id": "potion", "count": 5}]}', 'Beginner Collector', '初级收藏家', 'Reached 10% Pokedex completion', '完成图鉴10%', '🎯'),
('percentage', 25, 2, 'items', '{"items": [{"id": "rare_egg", "count": 1}, {"id": "great_ball", "count": 20}]}', 'Casual Collector', '休闲收藏家', 'Reached 25% Pokedex completion', '完成图鉴25%', '📚'),
('percentage', 50, 3, 'items', '{"items": [{"id": "master_ball", "count": 3}, {"id": "ultra_ball", "count": 50}]}', 'Dedicated Collector', '专注收藏家', 'Reached 50% Pokedex completion', '完成图鉴50%', '🏆'),
('percentage', 75, 4, 'items', '{"items": [{"id": "shiny_encounter_ticket", "count": 1}, {"id": "master_ball", "count": 5}]}', 'Expert Collector', '专家收藏家', 'Reached 75% Pokedex completion', '完成图鉴75%', '⭐'),
('percentage', 100, 5, 'special', '{"title": "Pokedex Master", "badge": "pokedex_master", "items": [{"id": "shiny_ditto_ticket", "count": 1}]}', 'Pokedex Master', '图鉴大师', 'Completed the entire Pokedex!', '完成全部图鉴!', '🌟'),
('count', 10, 6, 'items', '{"items": [{"id": "poke_ball", "count": 5}]}', 'First Steps', '初学者', 'Caught 10 different species', '捕获10种不同精灵', '🚶'),
('count', 50, 7, 'items', '{"items": [{"id": "great_ball", "count": 30}]}', 'Collector', '收藏家', 'Caught 50 different species', '捕获50种不同精灵', '📦'),
('count', 100, 8, 'items', '{"items": [{"id": "ultra_ball", "count": 50}]}', 'Expert', '专家', 'Caught 100 different species', '捕获100种不同精灵', '🎓'),
('count', 200, 9, 'items', '{"items": [{"id": "master_ball", "count": 10}]}', 'Master', '大师', 'Caught 200 different species', '捕获200种不同精灵', '👑'),
('special', 5, 10, 'shiny', 'items', '{"items": [{"id": "shiny_charm", "count": 1}]}', 'Shiny Hunter', '闪光猎人', 'Caught 5 shiny Pokemon', '捕获5只闪光精灵', '✨'),
('special', 10, 11, 'shiny', 'items', '{"items": [{"id": "golden_shiny_charm", "count": 1}]}', 'Shiny Master', '闪光大师', 'Caught 10 shiny Pokemon', '捕获10只闪光精灵', '💎'),
('special', 3, 12, 'legendary', 'items', '{"items": [{"id": "legendary_encounter_boost", "count": 1}]}', 'Legend Seeker', '传说追寻者', 'Caught 3 legendary Pokemon', '捕获3只传说精灵', '🔥')
ON CONFLICT DO NOTHING;

-- ============================================
-- 用户里程碑领取记录
-- ============================================
CREATE TABLE IF NOT EXISTS user_milestone_claims (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone_id INTEGER NOT NULL REFERENCES pokedex_milestones(id) ON DELETE CASCADE,
    reward_data JSONB,
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, milestone_id)
);

COMMENT ON TABLE user_milestone_claims IS '用户里程碑奖励领取记录';

CREATE INDEX IF NOT EXISTS idx_user_milestone_claims_user ON user_milestone_claims(user_id);

-- ============================================
-- 图鉴成就表
-- ============================================
CREATE TABLE IF NOT EXISTS pokedex_achievements (
    id SERIAL PRIMARY KEY,
    achievement_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_zh VARCHAR(100),
    description TEXT,
    description_zh TEXT,
    requirement_type VARCHAR(50) NOT NULL CHECK (requirement_type IN ('caught_count', 'seen_count', 'shiny_count', 'legendary_count', 'completion_percentage')),
    requirement_value INTEGER NOT NULL,
    reward_type VARCHAR(50),
    reward_data JSONB,
    badge_icon VARCHAR(255),
    badge_color VARCHAR(50),
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pokedex_achievements IS '图鉴成就配置';

-- 插入默认成就数据
INSERT INTO pokedex_achievements (achievement_key, name, name_zh, description, description_zh, requirement_type, requirement_value, reward_type, reward_data, badge_icon, badge_color, sort_order) VALUES
('beginner', 'Beginner Trainer', '初学者训练师', 'Caught your first Pokemon', '捕获第一只精灵', 'caught_count', 1, 'title', '{"title": "Beginner Trainer"}', '🎓', 'gray', 1),
('collector_10', 'Collector - Level 1', '收藏家 Lv.1', 'Caught 10 different species', '捕获10种不同精灵', 'caught_count', 10, 'items', '{"items": [{"id": "poke_ball", "count": 20}]}', '📦', 'green', 2),
('collector_50', 'Collector - Level 2', '收藏家 Lv.2', 'Caught 50 different species', '捕获50种不同精灵', 'caught_count', 50, 'items', '{"items": [{"id": "great_ball", "count": 30}]}', '📚', 'blue', 3),
('collector_100', 'Collector - Level 3', '收藏家 Lv.3', 'Caught 100 different species', '捕获100种不同精灵', 'caught_count', 100, 'items', '{"items": [{"id": "ultra_ball", "count": 50}]}', '🏆', 'purple', 4),
('expert', 'Pokemon Expert', '精灵专家', 'Caught 200 different species', '捕获200种不同精灵', 'caught_count', 200, 'title', '{"title": "Pokemon Expert"}', '🎓', 'gold', 5),
('master', 'Pokemon Master', '精灵大师', 'Caught 500 different species', '捕获500种不同精灵', 'caught_count', 500, 'title', '{"title": "Pokemon Master", "badge": "master_badge"}', '👑', 'legendary', 6),
('shiny_hunter', 'Shiny Hunter', '闪光猎人', 'Caught a shiny Pokemon', '捕获一只闪光精灵', 'shiny_count', 1, 'badge', '{"badge": "shiny_hunter"}', '✨', 'shiny', 7),
('shiny_master', 'Shiny Master', '闪光大师', 'Caught 10 shiny Pokemon', '捕获10只闪光精灵', 'shiny_count', 10, 'badge', '{"badge": "shiny_master", "bonus": {"shiny_rate": 0.05}}', '💎', 'shiny', 8),
('legendary_seeker', 'Legend Seeker', '传说追寻者', 'Caught 3 legendary Pokemon', '捕获3只传说精灵', 'legendary_count', 3, 'badge', '{"badge": "legendary_seeker"}', '🔥', 'legendary', 9),
('legendary_master', 'Legendary Master', '传说大师', 'Caught 10 legendary Pokemon', '捕获10只传说精灵', 'legendary_count', 10, 'badge', '{"badge": "legendary_master"}', '⭐', 'legendary', 10),
('completion_25', 'Quarter Completed', '四分之一完成', 'Reached 25% Pokedex completion', '完成图鉴25%', 'completion_percentage', 25, 'items', '{"items": [{"id": "rare_egg", "count": 1}]}', '📊', 'blue', 11),
('completion_50', 'Halfway There', '半程达成', 'Reached 50% Pokedex completion', '完成图鉴50%', 'completion_percentage', 50, 'items', '{"items": [{"id": "master_ball", "count": 3}]}', '📈', 'purple', 12),
('completion_75', 'Almost There', '即将完成', 'Reached 75% Pokedex completion', '完成图鉴75%', 'completion_percentage', 75, 'items', '{"items": [{"id": "shiny_encounter_ticket", "count": 1}]}', '📉', 'gold', 13),
('completion_100', 'Pokedex Complete', '图鉴完成', 'Completed the entire Pokedex!', '完成全部图鉴!', 'completion_percentage', 100, 'special', '{"title": "Pokedex Master", "badge": "complete_pokedex", "unlock_shiny_dex": true}', '🌟', 'legendary', 14)
ON CONFLICT (achievement_key) DO NOTHING;

-- ============================================
-- 用户图鉴成就解锁记录
-- ============================================
CREATE TABLE IF NOT EXISTS user_pokedex_achievements (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id INTEGER NOT NULL REFERENCES pokedex_achievements(id) ON DELETE CASCADE,
    unlocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, achievement_id)
);

COMMENT ON TABLE user_pokedex_achievements IS '用户图鉴成就解锁记录';

CREATE INDEX IF NOT EXISTS idx_user_pokedex_achievements_user ON user_pokedex_achievements(user_id);

-- ============================================
-- 图鉴统计缓存表
-- ============================================
CREATE TABLE IF NOT EXISTS pokedex_stats_cache (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_species INTEGER DEFAULT 905,
    seen_count INTEGER DEFAULT 0,
    caught_count INTEGER DEFAULT 0,
    shiny_count INTEGER DEFAULT 0,
    legendary_count INTEGER DEFAULT 0,
    completion_percentage DECIMAL(5,2) DEFAULT 0.00,
    region_stats JSONB DEFAULT '{}',
    type_stats JSONB DEFAULT '{}',
    generation_stats JSONB DEFAULT '{}',
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pokedex_stats_cache IS '图鉴统计缓存（实时更新）';

-- ============================================
-- 创建更新统计缓存的函数
-- ============================================
CREATE OR REPLACE FUNCTION update_pokedex_stats(p_user_id UUID)
RETURNS VOID AS $$
DECLARE
    v_seen_count INTEGER;
    v_caught_count INTEGER;
    v_shiny_count INTEGER;
    v_legendary_count INTEGER;
    v_completion DECIMAL(5,2);
BEGIN
    -- 计算基础统计
    SELECT 
        COUNT(DISTINCT CASE WHEN seen THEN pokemon_species_id END),
        COUNT(DISTINCT CASE WHEN caught THEN pokemon_species_id END),
        COUNT(DISTINCT CASE WHEN shiny_caught THEN pokemon_species_id END)
    INTO v_seen_count, v_caught_count, v_shiny_count
    FROM pokedex_progress
    WHERE user_id = p_user_id;
    
    -- 计算传说精灵数量（需要关联 pokemon_species 表）
    SELECT COUNT(DISTINCT pp.pokemon_species_id)
    INTO v_legendary_count
    FROM pokedex_progress pp
    JOIN pokemon_species ps ON pp.pokemon_species_id = ps.id
    WHERE pp.user_id = p_user_id 
      AND pp.caught = TRUE
      AND (ps.is_legendary = TRUE OR ps.is_mythical = TRUE);
    
    -- 计算完成度百分比
    v_completion := (v_caught_count::DECIMAL / 905 * 100)::DECIMAL(5,2);
    
    -- 更新或插入缓存
    INSERT INTO pokedex_stats_cache (
        user_id, seen_count, caught_count, shiny_count, legendary_count, 
        completion_percentage, last_updated
    ) VALUES (
        p_user_id, v_seen_count, v_caught_count, v_shiny_count, v_legendary_count,
        v_completion, CURRENT_TIMESTAMP
    )
    ON CONFLICT (user_id) 
    DO UPDATE SET
        seen_count = EXCLUDED.seen_count,
        caught_count = EXCLUDED.caught_count,
        shiny_count = EXCLUDED.shiny_count,
        legendary_count = EXCLUDED.legendary_count,
        completion_percentage = EXCLUDED.completion_percentage,
        last_updated = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_pokedex_stats IS '更新用户图鉴统计缓存';

-- ============================================
-- 创建触发器：自动更新缓存
-- ============================================
CREATE OR REPLACE FUNCTION trigger_update_pokedex_stats()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM update_pokedex_stats(NEW.user_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pokedex_progress_update
AFTER INSERT OR UPDATE ON pokedex_progress
FOR EACH ROW
EXECUTE FUNCTION trigger_update_pokedex_stats();

-- ============================================
-- 创建精灵种类表（如果不存在）
-- ============================================
CREATE TABLE IF NOT EXISTS pokemon_species (
    id SERIAL PRIMARY KEY,
    pokedex_number INTEGER UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_zh VARCHAR(100),
    name_ja VARCHAR(100),
    generation INTEGER,
    region VARCHAR(50),
    types TEXT[],
    is_legendary BOOLEAN DEFAULT FALSE,
    is_mythical BOOLEAN DEFAULT FALSE,
    base_stats JSONB,
    evolution_chain INTEGER[],
    catch_rate DECIMAL(5,2),
    rarity VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pokemon_species IS '精灵种类基础数据';

CREATE INDEX IF NOT EXISTS idx_pokemon_species_pokedex ON pokemon_species(pokedex_number);
CREATE INDEX IF NOT EXISTS idx_pokemon_species_types ON pokemon_species USING GIN(types);
CREATE INDEX IF NOT EXISTS idx_pokemon_species_region ON pokemon_species(region);

-- ============================================
-- 权限授予
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON pokedex_progress TO minego_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pokedex_milestones TO minego_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_milestone_claims TO minego_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pokedex_achievements TO minego_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_pokedex_achievements TO minego_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pokedex_stats_cache TO minego_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pokemon_species TO minego_app;
GRANT EXECUTE ON FUNCTION update_pokedex_stats TO minego_app;