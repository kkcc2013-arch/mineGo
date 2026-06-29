-- REQ-00112: 精灵技能冷却与能量系统
-- 创建时间: 2026-06-29 20:00 UTC

-- 扩展技能表，添加冷却和能量属性
ALTER TABLE moves 
ADD COLUMN IF NOT EXISTS cooldown_turns INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS energy_cost INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS energy_recover INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS energy_type VARCHAR(20) DEFAULT 'standard';

-- 精灵能量池表
CREATE TABLE IF NOT EXISTS pokemon_energy (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    current_energy INTEGER DEFAULT 100,
    max_energy INTEGER DEFAULT 100,
    energy_regen_rate INTEGER DEFAULT 10,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_instance_id)
);

-- 战斗中的能量记录表
CREATE TABLE IF NOT EXISTS battle_energy_state (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(100) NOT NULL,
    pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    current_energy INTEGER DEFAULT 100,
    cooldowns JSONB DEFAULT '{}',
    turn_number INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 能量回复规则配置表
CREATE TABLE IF NOT EXISTS energy_regen_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(50) NOT NULL,
    base_regen INTEGER DEFAULT 10,
    hp_threshold_bonus JSONB DEFAULT '[]',
    status_effect_modifiers JSONB DEFAULT '{}',
    item_modifiers JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pokemon_energy_pokemon ON pokemon_energy(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_battle_energy_battle ON battle_energy_state(battle_id);
CREATE INDEX IF NOT EXISTS idx_battle_energy_pokemon ON battle_energy_state(pokemon_instance_id);

-- 初始化现有技能的冷却和能量值（如果moves表有数据）
DO $$
BEGIN
    -- 快速技能：低威力，低冷却，低能量消耗
    UPDATE moves SET 
        cooldown_turns = 0,
        energy_cost = 10,
        energy_recover = 0,
        energy_type = 'fast'
    WHERE power IS NOT NULL AND power < 40 AND cooldown_turns IS NULL;
    
    -- 标准技能：中等威力
    UPDATE moves SET 
        cooldown_turns = 1,
        energy_cost = 30,
        energy_recover = 0,
        energy_type = 'standard'
    WHERE power IS NOT NULL AND power >= 40 AND power < 70 AND cooldown_turns IS NULL;
    
    -- 特殊技能：高威力
    UPDATE moves SET 
        cooldown_turns = 2,
        energy_cost = 45,
        energy_recover = 0,
        energy_type = 'special'
    WHERE power IS NOT NULL AND power >= 70 AND power < 100 AND cooldown_turns IS NULL;
    
    -- 蓄力技能：超高威力
    UPDATE moves SET 
        cooldown_turns = 3,
        energy_cost = 60,
        energy_recover = 0,
        energy_type = 'charged'
    WHERE power IS NOT NULL AND power >= 100 AND cooldown_turns IS NULL;
    
    -- 回复类技能
    UPDATE moves SET 
        cooldown_turns = 1,
        energy_cost = 20,
        energy_recover = 30,
        energy_type = 'recovery'
    WHERE name ILIKE '%recover%' OR name ILIKE '%heal%' OR name ILIKE '%rest%';
    
EXCEPTION WHEN OTHERS THEN
    -- 如果moves表不存在或其他错误，忽略
    NULL;
END $$;

-- 插入默认能量回复规则
INSERT INTO energy_regen_rules (rule_name, base_regen, hp_threshold_bonus, status_effect_modifiers, item_modifiers) VALUES
('standard', 10, '[{"threshold": 0.25, "bonus": 5}]', '{"paralyzed": -5, "frozen": -10}', '{"energy_charm": 5}'),
('aggressive', 8, '[{"threshold": 0.5, "bonus": 3}]', '{}', '{"berserker_charm": 8}'),
('defensive', 12, '[{"threshold": 0.25, "bonus": 8}]', '{"burned": -3, "poisoned": -3}', '{"guard_charm": 10}')
ON CONFLICT DO NOTHING;

-- 添加注释
COMMENT ON TABLE pokemon_energy IS '精灵能量池表 - 存储每个精灵的能量状态';
COMMENT ON TABLE battle_energy_state IS '战斗能量状态表 - 记录战斗中每个精灵的能量和冷却';
COMMENT ON TABLE energy_regen_rules IS '能量回复规则配置表';

COMMENT ON COLUMN moves.cooldown_turns IS '技能冷却回合数';
COMMENT ON COLUMN moves.energy_cost IS '技能能量消耗';
COMMENT ON COLUMN moves.energy_recover IS '技能能量回复量';
COMMENT ON COLUMN moves.energy_type IS '能量类型：fast/standard/special/charged/recovery';

COMMENT ON COLUMN pokemon_energy.current_energy IS '当前能量值';
COMMENT ON COLUMN pokemon_energy.max_energy IS '最大能量上限';
COMMENT ON COLUMN pokemon_energy.energy_regen_rate IS '每回合能量回复率';

COMMENT ON COLUMN battle_energy_state.cooldowns IS '冷却状态JSON：{"move_id": remaining_turns}';
