-- Guarded UUID bond/affinity projection and canonical species-key repair; raw source unchanged.
-- REQ-00079: 精灵好感度系统与亲密度进化机制
-- 创建时间: 2026-06-11 13:10

-- The identity prerequisite preserves the original trainer bond and history.
-- Do not reinterpret UUIDs as integers, or numeric bond levels as text.
DO $bridge$
BEGIN
  IF to_regclass(format('%I.friendship_identity_bridge_state',current_schema())) IS NULL THEN
    RAISE EXCEPTION 'The canonical friendship identity bridge must execute first';
  END IF;
END
$bridge$;

-- 亲密度进化规则表
CREATE TABLE IF NOT EXISTS friendship_evolution_rules (
    id SERIAL PRIMARY KEY,
    species_id SMALLINT NOT NULL REFERENCES pokemon_species(id),
    evolution_species_id SMALLINT NOT NULL REFERENCES pokemon_species(id),
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
WHERE s.id = 113 AND e.id = 242
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, 'day'
FROM pokemon_species s, pokemon_species e
WHERE s.id = 175 AND e.id = 176
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.id = 176 AND e.id = 468
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, 'day'
FROM pokemon_species s, pokemon_species e
WHERE s.id = 133 AND e.id = 196
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, 'night'
FROM pokemon_species s, pokemon_species e
WHERE s.id = 133 AND e.id = 197
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.id = 183 AND e.id = 184
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.id = 280 AND e.id = 281
ON CONFLICT DO NOTHING;

INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition)
SELECT s.id, e.id, 220, NULL
FROM pokemon_species s, pokemon_species e
WHERE s.id = 406 AND e.id = 407
ON CONFLICT DO NOTHING;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_friendship_pokemon ON pokemon_friendship(pokemon_instance_id,user_id);
CREATE INDEX IF NOT EXISTS idx_friendship_level ON pokemon_friendship(affinity_level);
CREATE INDEX IF NOT EXISTS idx_friendship_value ON pokemon_friendship(friendship_value);
CREATE INDEX IF NOT EXISTS idx_friendship_history_pokemon ON friendship_history(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_friendship_history_created ON friendship_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_rules_species ON friendship_evolution_rules(species_id);

-- The prerequisite's existing update trigger/function retain their identities,
-- enablement and behavior. Do not drop/recreate or replace a deployed trigger.
