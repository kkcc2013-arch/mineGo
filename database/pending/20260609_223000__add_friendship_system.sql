-- =====================================================
-- 精灵羁绊与互动养成系统
-- REQ-00067: Pokemon Friendship and Interaction System
-- =====================================================

-- 1. 精灵羁绊表
CREATE TABLE IF NOT EXISTS pokemon_friendship (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friendship_value SMALLINT NOT NULL DEFAULT 0 CHECK (friendship_value >= 0 AND friendship_value <= 255),
    friendship_level SMALLINT NOT NULL DEFAULT 0 CHECK (friendship_level >= 0 AND friendship_level <= 10),
    mood VARCHAR(20) NOT NULL DEFAULT 'neutral' CHECK (mood IN ('happy', 'neutral', 'sad', 'excited', 'tired')),
    mood_expiry TIMESTAMPTZ,
    last_interaction_at TIMESTAMPTZ,
    total_interactions INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pokemon_id, user_id)
);

COMMENT ON TABLE pokemon_friendship IS '精灵羁绊表：记录精灵与训练师的羁绊关系';
COMMENT ON COLUMN pokemon_friendship.friendship_value IS '羁绊值 (0-255)';
COMMENT ON COLUMN pokemon_friendship.friendship_level IS '羁绊等级 (0-10)';
COMMENT ON COLUMN pokemon_friendship.mood IS '精灵当前心情状态';
COMMENT ON COLUMN pokemon_friendship.mood_expiry IS '心情过期时间';
COMMENT ON COLUMN pokemon_friendship.total_interactions IS '总互动次数';

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_pokemon_friendship_user ON pokemon_friendship(user_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_friendship_pokemon ON pokemon_friendship(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_friendship_level ON pokemon_friendship(friendship_level);
CREATE INDEX IF NOT EXISTS idx_pokemon_friendship_mood_expiry ON pokemon_friendship(mood_expiry) WHERE mood_expiry IS NOT NULL;

-- 2. 互动记录表
CREATE TABLE IF NOT EXISTS friendship_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interaction_type VARCHAR(30) NOT NULL CHECK (interaction_type IN ('feed', 'play', 'pet', 'train', 'walk')),
    friendship_gain SMALLINT NOT NULL CHECK (friendship_gain > 0),
    mood_change VARCHAR(20) CHECK (mood_change IN ('happy', 'neutral', 'sad', 'excited', 'tired')),
    resource_consumed JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE friendship_interactions IS '互动记录表：记录训练师与精灵的互动历史';
COMMENT ON COLUMN friendship_interactions.interaction_type IS '互动类型：feed/play/pet/train/walk';
COMMENT ON COLUMN friendship_interactions.friendship_gain IS '羁绊值增益';
COMMENT ON COLUMN friendship_interactions.resource_consumed IS '消耗的资源信息';

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_friendship_interactions_pokemon ON friendship_interactions(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_friendship_interactions_user_time ON friendship_interactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friendship_interactions_type ON friendship_interactions(interaction_type);

-- 3. 羁绊里程碑表
CREATE TABLE IF NOT EXISTS friendship_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone_type VARCHAR(50) NOT NULL CHECK (milestone_type IN ('level_up', 'total_interactions', 'battle_heroic')),
    milestone_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pokemon_id, user_id, milestone_type)
);

COMMENT ON TABLE friendship_milestones IS '羁绊里程碑表：记录重要的羁绊事件';
COMMENT ON COLUMN friendship_milestones.milestone_type IS '里程碑类型：level_up/total_interactions/battle_heroic';
COMMENT ON COLUMN friendship_milestones.milestone_data IS '里程碑详细数据';

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_friendship_milestones_user ON friendship_milestones(user_id);
CREATE INDEX IF NOT EXISTS idx_friendship_milestones_type ON friendship_milestones(milestone_type);

-- 4. 互动道具配置表
CREATE TABLE IF NOT EXISTS interaction_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type VARCHAR(30) NOT NULL CHECK (item_type IN ('berry', 'toy', 'accessory')),
    name_i18n JSONB NOT NULL,
    friendship_bonus SMALLINT NOT NULL DEFAULT 10 CHECK (friendship_bonus > 0),
    mood_effect VARCHAR(20) CHECK (mood_effect IN ('happy', 'neutral', 'sad', 'excited', 'tired')),
    mood_duration_minutes INTEGER DEFAULT 60,
    rarity VARCHAR(20) NOT NULL DEFAULT 'common' CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
    obtain_method VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE interaction_items IS '互动道具配置表：定义可用于互动的道具';
COMMENT ON COLUMN interaction_items.item_type IS '道具类型：berry/toy/accessory';
COMMENT ON COLUMN interaction_items.name_i18n IS '多语言名称 {"en-US": "Oran Berry", "zh-CN": "橙橙果"}';
COMMENT ON COLUMN interaction_items.friendship_bonus IS '羁绊值加成';
COMMENT ON COLUMN interaction_items.mood_effect IS '心情效果';
COMMENT ON COLUMN interaction_items.rarity IS '稀有度';

-- 插入默认互动道具数据
INSERT INTO interaction_items (item_type, name_i18n, friendship_bonus, mood_effect, mood_duration_minutes, rarity, obtain_method) VALUES
-- 树果类道具
('berry', '{"en-US": "Oran Berry", "zh-CN": "橙橙果", "ja-JP": "オレンのみ"}', 15, 'happy', 120, 'common', 'catch,raid,shop'),
('berry', '{"en-US": "Pecha Berry", "zh-CN": "桃桃果", "ja-JP": "モモンのみ"}', 12, 'happy', 90, 'common', 'catch,raid'),
('berry', '{"en-US": "Sitrus Berry", "zh-CN": "文柚果", "ja-JP": "オボンのみ"}', 20, 'happy', 150, 'uncommon', 'raid,shop'),
('berry', '{"en-US": "Lum Berry", "zh-CN": "桃桃果", "ja-JP": "ラムのみ"}', 25, 'excited', 180, 'rare', 'raid,quest'),
('berry', '{"en-US": "Enigma Berry", "zh-CN": "谜之果", "ja-JP": "ナゾのみ"}', 35, 'excited', 240, 'legendary', 'event'),

-- 玩具类道具
('toy', '{"en-US": "Poke Ball Toy", "zh-CN": "精灵球玩具", "ja-JP": "モンスターボールのおもちゃ"}', 18, 'excited', 150, 'common', 'shop'),
('toy', '{"en-US": "Pokemon Plush", "zh-CN": "精灵玩偶", "ja-JP": "ポケモンのぬいぐるみ"}', 25, 'excited', 200, 'uncommon', 'shop,quest'),
('toy', '{"en-US": "Flying Disc", "zh-CN": "飞盘", "ja-JP": "フライングディスク"}', 15, 'excited', 120, 'common', 'shop'),

-- 装饰品类道具
('accessory', '{"en-US": "Friendship Ribbon", "zh-CN": "友谊缎带", "ja-JP": "フレンドリボン"}', 30, 'happy', 240, 'rare', 'quest,achievement'),
('accessory', '{"en-US": "Lucky Charm", "zh-CN": "幸运护符", "ja-JP": "ラッキーチャーム"}', 40, 'excited', 300, 'epic', 'achievement');

-- 5. 羁绊等级配置视图
CREATE OR REPLACE VIEW friendship_level_config AS
SELECT 
    level,
    min_value,
    max_value,
    level_name,
    crit_rate_bonus,
    evasion_rate_bonus,
    status_resist_bonus,
    exp_bonus
FROM (
    VALUES 
    (0, 0, 25, '陌生人', 0.00, 0.00, 0.00, 0.00),
    (1, 26, 50, '认识', 0.00, 0.00, 0.00, 0.00),
    (2, 51, 75, '友好', 0.00, 0.00, 0.00, 0.00),
    (3, 76, 100, '熟悉', 0.02, 0.00, 0.00, 0.00),
    (4, 101, 125, '信任', 0.04, 0.00, 0.00, 0.00),
    (5, 126, 150, '亲密', 0.06, 0.01, 0.00, 0.00),
    (6, 151, 175, '挚友', 0.08, 0.02, 0.00, 0.00),
    (7, 176, 200, '魂友', 0.10, 0.03, 0.05, 0.00),
    (8, 201, 225, '生死之交', 0.12, 0.04, 0.10, 0.10),
    (9, 226, 250, '心灵相通', 0.14, 0.05, 0.15, 0.20),
    (10, 251, 255, '灵魂羁绊', 0.16, 0.06, 0.20, 0.30)
) AS t(level, min_value, max_value, level_name, crit_rate_bonus, evasion_rate_bonus, status_resist_bonus, exp_bonus);

COMMENT ON VIEW friendship_level_config IS '羁绊等级配置视图：定义各等级的加成效果';

-- 6. 心情效果配置视图
CREATE OR REPLACE VIEW mood_effect_config AS
SELECT 
    mood,
    friendship_multiplier,
    crit_rate_bonus,
    evasion_rate_bonus,
    description
FROM (
    VALUES 
    ('happy', 1.2, 0.05, 0.00, '心情愉悦，互动效果提升'),
    ('excited', 1.3, 0.00, 0.05, '兴奋状态，渴望冒险'),
    ('neutral', 1.0, 0.00, 0.00, '平静状态'),
    ('sad', 0.8, 0.00, 0.00, '心情低落，需要安慰'),
    ('tired', 0.9, -0.05, 0.00, '疲惫状态，需要休息')
) AS t(mood, friendship_multiplier, crit_rate_bonus, evasion_rate_bonus, description);

COMMENT ON VIEW mood_effect_config IS '心情效果配置视图：定义心情对互动和战斗的影响';

-- 7. 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_friendship_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_friendship_updated_at
BEFORE UPDATE ON pokemon_friendship
FOR EACH ROW
EXECUTE FUNCTION update_friendship_updated_at();

-- 8. 创建羁绊值变更日志函数
CREATE OR REPLACE FUNCTION log_friendship_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.friendship_value IS DISTINCT FROM NEW.friendship_value THEN
        INSERT INTO friendship_interactions (pokemon_id, user_id, interaction_type, friendship_gain, mood_change)
        VALUES (
            NEW.pokemon_id,
            NEW.user_id,
            'system_update',
            NEW.friendship_value - OLD.friendship_value,
            NEW.mood
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_log_friendship_change
AFTER UPDATE ON pokemon_friendship
FOR EACH ROW
EXECUTE FUNCTION log_friendship_change();

-- 完成
SELECT 'Friendship system tables created successfully' AS status;
