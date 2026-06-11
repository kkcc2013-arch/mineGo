-- REQ-00079: 精灵好感度系统与亲密度进化机制
-- 创建时间: 2026-06-11 13:10

-- 精灵好感度表
CREATE TABLE IF NOT EXISTS pokemon_friendship (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id INTEGER NOT NULL,
    friendship_value INTEGER NOT NULL DEFAULT 50,
    friendship_level VARCHAR(20) NOT NULL DEFAULT 'normal',
    daily_walking_bonus INTEGER DEFAULT 0,
    last_walking_bonus_date DATE,
    daily_interaction_count INTEGER DEFAULT 0,
    last_interaction_date DATE,
    total_interactions INTEGER DEFAULT 0,
    days_with_trainer INTEGER DEFAULT 0,
    first_obtained_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_interaction_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT valid_friendship_value CHECK (friendship_value >= 0 AND friendship_value <= 255),
    CONSTRAINT valid_daily_walking_bonus CHECK (daily_walking_bonus >= 0 AND daily_walking_bonus <= 10),
    UNIQUE(pokemon_instance_id)
);

COMMENT ON TABLE pokemon_friendship IS '精灵好感度表';
COMMENT ON COLUMN pokemon_friendship.friendship_value IS '好感度值 (0-255)';
COMMENT ON COLUMN pokemon_friendship.friendship_level IS '好感度等级: stranger/normal/friendly/close/beloved';

-- 好感度历史记录表
CREATE TABLE IF NOT EXISTS friendship_history (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id INTEGER NOT NULL,
    change_type VARCHAR(50) NOT NULL,
    change_amount INTEGER NOT NULL,
    before_value INTEGER NOT NULL,
    after_value INTEGER NOT NULL,
    source VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE friendship_history IS '好感度变化历史记录';

-- 亲密度进化规则表
CREATE TABLE IF NOT EXISTS friendship_evolution_rules (
    id SERIAL PRIMARY KEY,
    species_id INTEGER NOT NULL,
    evolution_species_id INTEGER NOT NULL,
    required_friendship INTEGER NOT NULL DEFAULT 220,
    time_condition VARCHAR(20), -- 'day', 'night', null
    additional_item_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE friendship_evolution_rules IS '亲密度进化规则配置';

-- 好感度互动配置表
CREATE TABLE IF NOT EXISTS friendship_interaction_config (
    id SERIAL PRIMARY KEY,
    interaction_type VARCHAR(50) NOT NULL UNIQUE,
    friendship_change INTEGER NOT NULL,
    daily_limit INTEGER DEFAULT NULL,
    cooldown_hours INTEGER DEFAULT 0,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE friendship_interaction_config IS '好感度互动类型配置';

-- 插入默认互动配置
INSERT INTO friendship_interaction_config (interaction_type, friendship_change, daily_limit, description) VALUES
('battle_win', 1, 20, '战斗胜利'),
('battle_loss', 0, NULL, '战斗失败'),
('faint', -5, NULL, '精灵晕倒'),
('walking', 1, 10, '行走步数奖励'),
('massage', 8, 1, '按摩服务'),
('camping', 4, 3, '露营互动'),
('feed_berry', 3, 5, '喂食精灵果'),
('feed_vitamin', 5, 3, '使用营养剂'),
('bitter_herb', -8, NULL, '使用苦味药草'),
('spa', 10, 1, 'SPA服务'),
('touch', 1, 10, '触摸互动')
ON CONFLICT (interaction_type) DO NOTHING;

-- 插入亲密度进化规则（基于常见精灵物种ID）
-- 注意：实际物种ID需要根据 pokemon_species 表数据调整
INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 113 AND e.species_id = 242
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, 'day'
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 175 AND e.species_id = 176
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 176 AND e.species_id = 468
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, 'day'
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 133 AND e.species_id = 196
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, 'night'
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 133 AND e.species_id = 197
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 183 AND e.species_id = 184
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 280 AND e.species_id = 281
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.species_id = 406 AND e.species_id = 407
ON CONFLICT DO NOTHING;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_friendship_pokemon ON pokemon_friendship(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_friendship_level ON pokemon_friendship(friendship_level);
CREATE INDEX IF NOT EXISTS idx_friendship_value ON pokemon_friendship(friendship_value);
CREATE INDEX IF NOT EXISTS idx_friendship_history_pokemon ON friendship_history(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_friendship_history_created ON friendship_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_rules_species ON friendship_evolution_rules(species_id);

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_friendship_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_friendship_updated_at ON pokemon_friendship;
CREATE TRIGGER trigger_update_friendship_updated_at
    BEFORE UPDATE ON pokemon_friendship
    FOR EACH ROW
    EXECUTE FUNCTION update_friendship_updated_at();
