-- 精灵天赋系统数据库迁移
-- Migration: 050_pokemon_talent_system.sql
-- Created: 2026-07-01 14:00 UTC

-- 1. 天赋定义表（系统配置）
CREATE TABLE IF NOT EXISTS talent_definitions (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(20) NOT NULL CHECK (category IN ('attack', 'defense', 'support', 'utility')),
    max_level INTEGER DEFAULT 3,
    cost_per_level INTEGER DEFAULT 1,
    effects JSONB DEFAULT '{}',
    prerequisites JSONB DEFAULT '[]',
    unlock_condition JSONB DEFAULT '{}',
    pokemon_types JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE talent_definitions IS '天赋定义配置表，存储所有可分配的天赋节点';

-- 2. 天赋树定义表（精灵类型天赋树）
CREATE TABLE IF NOT EXISTS talent_tree_definitions (
    pokemon_type VARCHAR(100) PRIMARY KEY,
    branches JSONB NOT NULL,
    total_talent_points INTEGER DEFAULT 15,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE talent_tree_definitions IS '精灵类型天赋树配置，每种精灵类型有独特天赋树';

-- 3. 精灵天赋配置表（玩家精灵已分配天赋）
CREATE TABLE IF NOT EXISTS pokemon_talent_config (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    
    -- 已分配天赋 { "talent_id": level }
    allocated_talents JSONB DEFAULT '{}',
    
    -- 天赋点统计
    total_points INTEGER DEFAULT 0,
    used_points INTEGER DEFAULT 0,
    
    -- 隐藏属性缓存（计算后存储）
    hidden_attributes JSONB DEFAULT '{}',
    
    -- 天赋点来源记录
    point_sources JSONB DEFAULT '[]',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_pokemon_talent UNIQUE (pokemon_id),
    CONSTRAINT valid_points CHECK (used_points <= total_points)
);

COMMENT ON TABLE pokemon_talent_config IS '精灵天赋配置表，存储每个精灵的天赋分配';

-- 4. 天赋重置记录表
CREATE TABLE IF NOT EXISTS talent_reset_logs (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    
    -- 重置前天赋配置
    previous_talents JSONB NOT NULL,
    previous_points INTEGER NOT NULL,
    
    -- 返还信息
    refunded_points INTEGER NOT NULL,
    
    -- 消耗道具
    consumed_item VARCHAR(100),
    
    -- 时间
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE talent_reset_logs IS '天赋重置历史记录';

-- 索引
CREATE INDEX IF NOT EXISTS idx_talent_config_pokemon ON pokemon_talent_config(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_talent_def_category ON talent_definitions(category);
CREATE INDEX IF NOT EXISTS idx_talent_tree_type ON talent_tree_definitions(pokemon_type);
CREATE INDEX IF NOT EXISTS idx_talent_reset_pokemon ON talent_reset_logs(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_talent_reset_user ON talent_reset_logs(user_id);

-- 插入基础天赋定义数据
INSERT INTO talent_definitions (id, name, description, category, max_level, cost_per_level, effects, prerequisites, unlock_condition, pokemon_types) VALUES

-- 攻击类天赋
('critical_rate_boost', '暴击率提升', '提升精灵的暴击率', 'attack', 5, 1, 
 '{"criticalRate": {"base": 0.01, "perLevel": 0.02}}', '[]', '{"level": 10}', '["all"]'),
('critical_damage_boost', '暴击伤害提升', '提升精灵的暴击伤害倍率', 'attack', 3, 2, 
 '{"criticalDamage": {"base": 0.1, "perLevel": 0.15}}', '["critical_rate_boost:1"]', '{"level": 20}', '["all"]'),
('attack_power_boost', '攻击力强化', '提升精灵的基础攻击力', 'attack', 5, 1, 
 '{"attackPower": {"base": 0.02, "perLevel": 0.03}}', '[]', '{"level": 5}', '["all"]'),
('skill_damage_fire', '火焰强化', '提升火属性技能伤害', 'attack', 3, 1, 
 '{"skillDamageBonus": {"type": "fire", "base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 15}', '["fire", "fire_dragon", "fire_bird"]'),
('skill_damage_water', '水流强化', '提升水属性技能伤害', 'attack', 3, 1, 
 '{"skillDamageBonus": {"type": "water", "base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 15}', '["water", "water_dragon", "water_fish"]'),
('skill_damage_electric', '雷电强化', '提升电属性技能伤害', 'attack', 3, 1, 
 '{"skillDamageBonus": {"type": "electric", "base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 15}', '["electric", "electric_mouse"]'),
('penetration_boost', '穿透强化', '提升技能穿透率', 'attack', 3, 2, 
 '{"penetration": {"base": 0.02, "perLevel": 0.05}}', '["attack_power_boost:3"]', '{"level": 30}', '["all"]'),

-- 防御类天赋
('defense_power_boost', '防御力强化', '提升精灵的基础防御力', 'defense', 5, 1, 
 '{"defensePower": {"base": 0.02, "perLevel": 0.03}}', '[]', '{"level": 5}', '["all"]'),
('hp_boost', '生命值强化', '提升精灵的最大生命值', 'defense', 5, 1, 
 '{"maxHp": {"base": 0.02, "perLevel": 0.03}}', '[]', '{"level": 5}', '["all"]'),
('dodge_chance_boost', '闪避率提升', '提升精灵的闪避率', 'defense', 3, 2, 
 '{"dodgeRate": {"base": 0.01, "perLevel": 0.03}}', '["defense_power_boost:2"]', '{"level": 25}', '["all"]'),
('fire_resistance', '火焰抗性', '提升对火属性技能的抗性', 'defense', 3, 1, 
 '{"fireResist": {"base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 15}', '["all"]'),
('water_resistance', '水流抗性', '提升对水属性技能的抗性', 'defense', 3, 1, 
 '{"waterResist": {"base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 15}', '["all"]'),
('electric_resistance', '雷电抗性', '提升对电属性技能的抗性', 'defense', 3, 1, 
 '{"electricResist": {"base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 15}', '["all"]'),

-- 辅助类天赋
('energy_regen_boost', '能量恢复强化', '提升能量恢复速度', 'support', 3, 1, 
 '{"energyRegen": {"base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 10}', '["all"]'),
('skill_cooldown_reduction', '技能冷却缩减', '减少技能冷却时间', 'support', 3, 2, 
 '{"skillCooldownReduction": {"base": 0.03, "perLevel": 0.05}}', '["energy_regen_boost:1"]', '{"level": 20}', '["all"]'),
('accuracy_boost', '命中率提升', '提升技能命中率', 'support', 3, 1, 
 '{"accuracy": {"base": 0.01, "perLevel": 0.02}}', '[]', '{"level": 10}', '["all"]'),
('healing_received_boost', '治疗效果提升', '提升受到治疗效果', 'support', 3, 1, 
 '{"healingBoost": {"base": 0.05, "perLevel": 0.08}}', '[]', '{"level": 15}', '["all"]'),

-- 特殊类天赋（高级）
('ultimate_power', '终极力量', '大幅度提升所有攻击属性', 'attack', 1, 5, 
 '{"attackPower": {"base": 0.1}, "criticalRate": {"base": 0.05}, "skillDamageBonus": {"type": "all", "base": 0.1}}', 
 '["critical_damage_boost:3", "attack_power_boost:5"]', '{"level": 50}', '["all"]'),
('ultimate_defense', '终极防御', '大幅度提升所有防御属性', 'defense', 1, 5, 
 '{"defensePower": {"base": 0.1}, "maxHp": {"base": 0.1}, "dodgeRate": {"base": 0.05}}', 
 '["dodge_chance_boost:3", "defense_power_boost:5"]', '{"level": 50}', '["all"]'),
('master_support', '大师辅助', '大幅度提升所有辅助属性', 'support', 1, 5, 
 '{"energyRegen": {"base": 0.15}, "skillCooldownReduction": {"base": 0.1}, "healingBoost": {"base": 0.15}}', 
 '["skill_cooldown_reduction:3", "energy_regen_boost:3"]', '{"level": 50}', '["all"]')
ON CONFLICT (id) DO NOTHING;

-- 插入基础天赋树定义
INSERT INTO talent_tree_definitions (pokemon_type, branches, total_talent_points) VALUES
('fire_dragon', 
 '{"attack": ["critical_rate_boost", "critical_damage_boost", "attack_power_boost", "skill_damage_fire", "penetration_boost", "ultimate_power"], "defense": ["defense_power_boost", "hp_boost", "dodge_chance_boost", "fire_resistance"], "support": ["energy_regen_boost", "skill_cooldown_reduction", "accuracy_boost"]}',
 15),
('water_dragon',
 '{"attack": ["critical_rate_boost", "critical_damage_boost", "attack_power_boost", "skill_damage_water", "penetration_boost", "ultimate_power"], "defense": ["defense_power_boost", "hp_boost", "dodge_chance_boost", "water_resistance"], "support": ["energy_regen_boost", "skill_cooldown_reduction", "accuracy_boost"]}',
 15),
('electric_mouse',
 '{"attack": ["critical_rate_boost", "critical_damage_boost", "attack_power_boost", "skill_damage_electric", "penetration_boost", "ultimate_power"], "defense": ["defense_power_boost", "hp_boost", "electric_resistance"], "support": ["energy_regen_boost", "skill_cooldown_reduction", "accuracy_boost"]}',
 12),
('default',
 '{"attack": ["critical_rate_boost", "attack_power_boost", "penetration_boost"], "defense": ["defense_power_boost", "hp_boost", "dodge_chance_boost"], "support": ["energy_regen_boost", "accuracy_boost"]}',
 10)
ON CONFLICT (pokemon_type) DO NOTHING;

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_talent_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER talent_config_update_trigger
    BEFORE UPDATE ON pokemon_talent_config
    FOR EACH ROW EXECUTE FUNCTION update_talent_timestamp();

CREATE TRIGGER talent_def_update_trigger
    BEFORE UPDATE ON talent_definitions
    FOR EACH ROW EXECUTE FUNCTION update_talent_timestamp();

CREATE TRIGGER talent_tree_update_trigger
    BEFORE UPDATE ON talent_tree_definitions
    FOR EACH ROW EXECUTE FUNCTION update_talent_timestamp();