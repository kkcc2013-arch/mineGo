-- REQ-00056: 精灵图鉴完成度奖励系统
-- 数据库迁移：图鉴进度追踪、里程碑奖励、成就系统

-- ============================================================
-- 1. 图鉴完成度记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS pokedex_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    
    -- 见过/捕获状态
    seen BOOLEAN DEFAULT FALSE,
    caught BOOLEAN DEFAULT FALSE,
    catch_count INTEGER DEFAULT 0,
    
    -- 闪光标记
    shiny_caught BOOLEAN DEFAULT FALSE,
    
    -- 时间戳
    first_seen_at TIMESTAMP,
    first_caught_at TIMESTAMP,
    last_seen_at TIMESTAMP,
    last_caught_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(user_id, pokemon_species_id)
);

-- 索引
CREATE INDEX idx_pokedex_progress_user ON pokedex_progress(user_id);
CREATE INDEX idx_pokedex_progress_species ON pokedex_progress(pokemon_species_id);
CREATE INDEX idx_pokedex_progress_caught ON pokedex_progress(user_id, caught) WHERE caught = TRUE;
CREATE INDEX idx_pokedex_progress_shiny ON pokedex_progress(user_id, shiny_caught) WHERE shiny_caught = TRUE;

COMMENT ON TABLE pokedex_progress IS '用户图鉴进度记录';

-- ============================================================
-- 2. 图鉴里程碑奖励配置表
-- ============================================================
CREATE TABLE IF NOT EXISTS pokedex_milestones (
    id SERIAL PRIMARY KEY,
    
    -- 里程碑类型
    milestone_type VARCHAR(20) NOT NULL CHECK (milestone_type IN ('percentage', 'count', 'category', 'special')),
    
    -- 阈值（百分比、数量等）
    threshold INTEGER NOT NULL,
    
    -- 分类（用于按地区、世代等）
    category VARCHAR(50),
    
    -- 奖励配置
    reward_type VARCHAR(50) NOT NULL,
    reward_data JSONB NOT NULL,
    
    -- 显示信息
    title VARCHAR(100) NOT NULL,
    title_en VARCHAR(100),
    description TEXT,
    description_en TEXT,
    icon VARCHAR(255),
    
    -- 是否可重复领取
    is_repeatable BOOLEAN DEFAULT FALSE,
    
    -- 排序权重
    sort_order INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pokedex_milestones IS '图鉴里程碑奖励配置';

-- ============================================================
-- 3. 用户里程碑领取记录
-- ============================================================
CREATE TABLE IF NOT EXISTS user_milestone_claims (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone_id INTEGER NOT NULL REFERENCES pokedex_milestones(id),
    claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reward_data JSONB,
    
    UNIQUE(user_id, milestone_id)
);

CREATE INDEX idx_user_milestone_claims_user ON user_milestone_claims(user_id);

COMMENT ON TABLE user_milestone_claims IS '用户里程碑奖励领取记录';

-- ============================================================
-- 4. 图鉴成就配置表
-- ============================================================
CREATE TABLE IF NOT EXISTS pokedex_achievements (
    id SERIAL PRIMARY KEY,
    
    -- 成就标识
    achievement_key VARCHAR(50) UNIQUE NOT NULL,
    
    -- 显示信息
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(100),
    description TEXT,
    description_en TEXT,
    
    -- 解锁条件
    requirement_type VARCHAR(50) NOT NULL CHECK (requirement_type IN (
        'caught_count',      -- 捕获数量
        'seen_count',        -- 见过数量
        'shiny_count',       -- 闪光数量
        'legendary_count',   -- 传说数量
        'completion_percentage', -- 完成度百分比
        'region_completion', -- 地区完成度
        'type_completion'    -- 属性完成度
    )),
    requirement_value INTEGER NOT NULL,
    requirement_data JSONB, -- 额外条件数据（如地区名、属性名）
    
    -- 奖励
    reward_type VARCHAR(50),
    reward_data JSONB,
    
    -- 图标和徽章
    badge_icon VARCHAR(255),
    badge_color VARCHAR(20),
    
    -- 稀有度
    rarity VARCHAR(20) DEFAULT 'common' CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
    
    -- 经验值奖励
    xp_reward INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pokedex_achievements IS '图鉴成就配置';

-- ============================================================
-- 5. 用户图鉴成就解锁记录
-- ============================================================
CREATE TABLE IF NOT EXISTS user_pokedex_achievements (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id INTEGER NOT NULL REFERENCES pokedex_achievements(id),
    unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(user_id, achievement_id)
);

CREATE INDEX idx_user_pokedex_achievements_user ON user_pokedex_achievements(user_id);

COMMENT ON TABLE user_pokedex_achievements IS '用户图鉴成就解锁记录';

-- ============================================================
-- 6. 图鉴统计缓存表
-- ============================================================
CREATE TABLE IF NOT EXISTS pokedex_stats_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    
    -- 基础统计
    total_species INTEGER DEFAULT 0,
    seen_count INTEGER DEFAULT 0,
    caught_count INTEGER DEFAULT 0,
    shiny_count INTEGER DEFAULT 0,
    legendary_count INTEGER DEFAULT 0,
    mythical_count INTEGER DEFAULT 0,
    
    -- 完成度
    completion_percentage DECIMAL(5,2) DEFAULT 0.00,
    
    -- 地区统计
    region_stats JSONB DEFAULT '{}',
    
    -- 属性统计
    type_stats JSONB DEFAULT '{}',
    
    -- 世代统计
    generation_stats JSONB DEFAULT '{}',
    
    -- 排名缓存
    global_rank INTEGER,
    rank_updated_at TIMESTAMP,
    
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pokedex_stats_cache IS '图鉴统计缓存';

-- ============================================================
-- 7. 里程碑奖励种子数据
-- ============================================================
INSERT INTO pokedex_milestones (milestone_type, threshold, category, reward_type, reward_data, title, title_en, description, description_en, icon, sort_order) VALUES
-- 完成度里程碑
('percentage', 10, NULL, 'items', '{"items": [{"type": "poke_ball", "count": 10}, {"type": "potion", "count": 5}]}', '初学者图鉴', 'Beginner Collector', '完成图鉴 10%', 'Complete 10% of the Pokédex', '📘', 10),
('percentage', 25, NULL, 'items', '{"items": [{"type": "rare_candy", "count": 3}, {"type": "incubator", "count": 1}]}', '收藏家图鉴', 'Collector', '完成图鉴 25%', 'Complete 25% of the Pokédex', '📗', 25),
('percentage', 50, NULL, 'items', '{"items": [{"type": "master_ball", "count": 3}, {"type": "lucky_egg", "count": 2}]}', '专家图鉴', 'Expert Collector', '完成图鉴 50%', 'Complete 50% of the Pokédex', '📙', 50),
('percentage', 75, NULL, 'special', '{"shiny_encounter_ticket": 1, "items": [{"type": "premium_pass", "count": 5}]}', '大师图鉴', 'Master Collector', '完成图鉴 75%', 'Complete 75% of the Pokédex', '📕', 75),
('percentage', 100, NULL, 'special', '{"title": "图鉴大师", "shiny_dex_unlock": true, "items": [{"type": "master_ball", "count": 10}]}', '完美图鉴', 'Perfect Collector', '完成图鉴 100%！', 'Complete 100% of the Pokédex!', '🏆', 100),

-- 数量里程碑
('count', 10, NULL, 'items', '{"items": [{"type": "poke_ball", "count": 20}]}', '捕获新手', 'Catch Beginner', '捕获 10 种精灵', 'Catch 10 different species', '🎯', 110),
('count', 50, NULL, 'items', '{"items": [{"type": "great_ball", "count": 10}, {"type": "lure_module", "count": 1}]}', '捕获达人', 'Catch Expert', '捕获 50 种精灵', 'Catch 50 different species', '🎯', 120),
('count', 100, NULL, 'items', '{"items": [{"type": "ultra_ball", "count": 15}, {"type": "incense", "count": 2}]}', '捕获大师', 'Catch Master', '捕获 100 种精灵', 'Catch 100 different species', '🎯', 130),
('count', 200, NULL, 'special', '{"shiny_encounter_ticket": 2, "items": [{"type": "rare_candy", "count": 10}]}', '捕获传奇', 'Catch Legend', '捕获 200 种精灵', 'Catch 200 different species', '⭐', 140),

-- 特殊里程碑
('special', 1, 'shiny', 'special', '{"shiny_badge": true, "items": [{"type": "star_piece", "count": 5}]}', '闪光猎人', 'Shiny Hunter', '捕获第一只闪光精灵', 'Catch your first shiny Pokémon', '✨', 200),
('special', 10, 'shiny', 'special', '{"shiny_badge_gold": true, "items": [{"type": "master_ball", "count": 1}]}', '闪光大师', 'Shiny Master', '捕获 10 只闪光精灵', 'Catch 10 shiny Pokémon', '✨', 210),
('special', 1, 'legendary', 'special', '{"legendary_badge": true, "items": [{"type": "golden_razz_berry", "count": 5}]}', '传说猎人', 'Legendary Hunter', '捕获第一只传说精灵', 'Catch your first legendary Pokémon', '🌟', 220);

-- ============================================================
-- 8. 图鉴成就种子数据
-- ============================================================
INSERT INTO pokedex_achievements (achievement_key, name, name_en, description, description_en, requirement_type, requirement_value, reward_data, badge_icon, badge_color, rarity, xp_reward) VALUES
-- 数量成就
('pokedex_beginner', '图鉴初学者', 'Pokédex Beginner', '捕获 10 种不同的精灵', 'Catch 10 different Pokémon species', 'caught_count', 10, '{"items": [{"type": "potion", "count": 10}]}', '🥉', '#CD7F32', 'common', 100),
('pokedex_apprentice', '图鉴学徒', 'Pokédex Apprentice', '捕获 25 种不同的精灵', 'Catch 25 different Pokémon species', 'caught_count', 25, '{"items": [{"type": "great_ball", "count": 10}]}', '🥈', '#C0C0C0', 'uncommon', 250),
('pokedex_collector', '图鉴收藏家', 'Pokédex Collector', '捕获 50 种不同的精灵', 'Catch 50 different Pokémon species', 'caught_count', 50, '{"items": [{"type": "ultra_ball", "count": 10}, {"type": "lucky_egg", "count": 1}]}', '🥇', '#FFD700', 'rare', 500),
('pokedex_expert', '图鉴专家', 'Pokédex Expert', '捕获 100 种不同的精灵', 'Catch 100 different Pokémon species', 'caught_count', 100, '{"items": [{"type": "rare_candy", "count": 5}]}', '💎', '#00CED1', 'epic', 1000),
('pokedex_master', '图鉴大师', 'Pokédex Master', '捕获 200 种不同的精灵', 'Catch 200 different Pokémon species', 'caught_count', 200, '{"items": [{"type": "master_ball", "count": 1}, {"type": "rare_candy", "count": 10}]}', '👑', '#9B59B6', 'legendary', 2500),

-- 见过成就
('pokedex_explorer', '图鉴探索者', 'Pokédex Explorer', '见过 50 种不同的精灵', 'See 50 different Pokémon species', 'seen_count', 50, '{"items": [{"type": "poke_ball", "count": 20}]}', '🔍', '#3498DB', 'common', 100),
('pokedex_scout', '图鉴侦察兵', 'Pokédex Scout', '见过 100 种不同的精灵', 'See 100 different Pokémon species', 'seen_count', 100, '{"items": [{"type": "incense", "count": 1}]}', '🔭', '#2ECC71', 'uncommon', 200),

-- 闪光成就
('shiny_finder', '闪光发现者', 'Shiny Finder', '捕获第一只闪光精灵', 'Catch your first shiny Pokémon', 'shiny_count', 1, '{"items": [{"type": "star_piece", "count": 3}]}', '✨', '#F1C40F', 'rare', 500),
('shiny_collector', '闪光收藏家', 'Shiny Collector', '捕获 5 只闪光精灵', 'Catch 5 shiny Pokémon', 'shiny_count', 5, '{"items": [{"type": "master_ball", "count": 1}]}', '🌟', '#E67E22', 'epic', 1500),
('shiny_master', '闪光大师', 'Shiny Master', '捕获 10 只闪光精灵', 'Catch 10 shiny Pokémon', 'shiny_count', 10, '{"special": "shiny_avatar_frame"}', '💫', '#E74C3C', 'legendary', 3000),

-- 传说成就
('legendary_hunter', '传说猎人', 'Legendary Hunter', '捕获第一只传说精灵', 'Catch your first legendary Pokémon', 'legendary_count', 1, '{"items": [{"type": "golden_razz_berry", "count": 5}]}', '⭐', '#9B59B6', 'epic', 1000),
('legendary_master', '传说大师', 'Legendary Master', '捕获 5 只传说精灵', 'Catch 5 legendary Pokémon', 'legendary_count', 5, '{"special": "legendary_avatar_background"}', '🌙', '#8E44AD', 'legendary', 5000),

-- 完成度成就
('pokedex_perfect', '完美图鉴', 'Perfect Pokédex', '完成图鉴 100%', 'Complete 100% of the Pokédex', 'completion_percentage', 100, '{"special": "perfect_dex_title", "items": [{"type": "master_ball", "count": 10}]}', '🏆', '#FFD700', 'legendary', 10000);

-- ============================================================
-- 9. 触发器：自动更新 updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_pokedex_progress_updated_at 
    BEFORE UPDATE ON pokedex_progress 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pokedex_milestones_updated_at 
    BEFORE UPDATE ON pokedex_milestones 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 10. 存储过程：更新图鉴统计缓存
-- ============================================================
CREATE OR REPLACE FUNCTION update_pokedex_stats(p_user_id INTEGER)
RETURNS VOID AS $$
DECLARE
    v_total_species INTEGER;
    v_seen_count INTEGER;
    v_caught_count INTEGER;
    v_shiny_count INTEGER;
    v_legendary_count INTEGER;
    v_mythical_count INTEGER;
    v_completion DECIMAL(5,2);
BEGIN
    -- 获取总精灵数
    SELECT COUNT(*) INTO v_total_species FROM pokemon_species;
    
    -- 统计用户图鉴进度
    SELECT 
        COUNT(DISTINCT CASE WHEN pp.seen THEN pp.pokemon_species_id END),
        COUNT(DISTINCT CASE WHEN pp.caught THEN pp.pokemon_species_id END),
        COUNT(DISTINCT CASE WHEN pp.shiny_caught THEN pp.pokemon_species_id END),
        COUNT(DISTINCT CASE WHEN pp.caught AND ps.is_legendary THEN pp.pokemon_species_id END),
        COUNT(DISTINCT CASE WHEN pp.caught AND ps.is_mythical THEN pp.pokemon_species_id END)
    INTO v_seen_count, v_caught_count, v_shiny_count, v_legendary_count, v_mythical_count
    FROM pokedex_progress pp
    LEFT JOIN pokemon_species ps ON pp.pokemon_species_id = ps.id
    WHERE pp.user_id = p_user_id;
    
    -- 计算完成度
    v_completion := (v_caught_count::DECIMAL / v_total_species * 100);
    
    -- 更新或插入缓存
    INSERT INTO pokedex_stats_cache (
        user_id, total_species, seen_count, caught_count, 
        shiny_count, legendary_count, mythical_count, 
        completion_percentage, last_updated
    ) VALUES (
        p_user_id, v_total_species, v_seen_count, v_caught_count,
        v_shiny_count, v_legendary_count, v_mythical_count,
        v_completion, CURRENT_TIMESTAMP
    )
    ON CONFLICT (user_id) DO UPDATE SET
        total_species = EXCLUDED.total_species,
        seen_count = EXCLUDED.seen_count,
        caught_count = EXCLUDED.caught_count,
        shiny_count = EXCLUDED.shiny_count,
        legendary_count = EXCLUDED.legendary_count,
        mythical_count = EXCLUDED.mythical_count,
        completion_percentage = EXCLUDED.completion_percentage,
        last_updated = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 11. 视图：用户图鉴概览
-- ============================================================
CREATE OR REPLACE VIEW v_pokedex_overview AS
SELECT 
    psc.user_id,
    u.username,
    psc.total_species,
    psc.seen_count,
    psc.caught_count,
    psc.shiny_count,
    psc.legendary_count,
    psc.mythical_count,
    psc.completion_percentage,
    psc.last_updated,
    COUNT(upa.id) as achievement_count
FROM pokedex_stats_cache psc
JOIN users u ON psc.user_id = u.id
LEFT JOIN user_pokedex_achievements upa ON u.id = upa.user_id
GROUP BY psc.user_id, u.username, psc.total_species, psc.seen_count, 
         psc.caught_count, psc.shiny_count, psc.legendary_count, 
         psc.mythical_count, psc.completion_percentage, psc.last_updated;

COMMENT ON VIEW v_pokedex_overview IS '用户图鉴概览视图';

-- ============================================================
-- 完成
-- ============================================================
