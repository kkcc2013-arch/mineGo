-- REQ-00151: 精灵羁绊技能解锁机制
-- 创建羁绊技能定义表和学习表

-- 羁绊技能定义表
CREATE TABLE IF NOT EXISTS bond_skill_definitions (
  id SERIAL PRIMARY KEY,
  pokemon_species_id INTEGER NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  skill_name VARCHAR(50) NOT NULL,
  skill_name_en VARCHAR(50),
  type VARCHAR(20) NOT NULL,
  power INTEGER,
  accuracy INTEGER CHECK (accuracy BETWEEN 0 AND 100),
  pp INTEGER NOT NULL DEFAULT 10,
  effect_description TEXT,
  effect_type VARCHAR(30), -- damage/buff/debuff/shield/heal
  unlock_friendship_level INTEGER NOT NULL,
  friendship_bonus_formula TEXT,
  energy_cost INTEGER DEFAULT 20,
  cooldown_turns INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(pokemon_species_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_bond_skill_species ON bond_skill_definitions(pokemon_species_id);
CREATE INDEX IF NOT EXISTS idx_bond_skill_unlock ON bond_skill_definitions(unlock_friendship_level);

-- 精灵羁绊技能学习表
CREATE TABLE IF NOT EXISTS pokemon_bond_skills (
  id SERIAL PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL,
  bond_skill_id INTEGER NOT NULL REFERENCES bond_skill_definitions(id) ON DELETE CASCADE,
  learned_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  current_pp INTEGER,
  times_used INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(pokemon_instance_id, bond_skill_id)
);

CREATE INDEX IF NOT EXISTS idx_pokemon_bond_skills_instance ON pokemon_bond_skills(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_bond_skills_skill ON pokemon_bond_skills(bond_skill_id);

-- 羁绊技能使用统计表
CREATE TABLE IF NOT EXISTS bond_skill_usage_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  pokemon_instance_id UUID NOT NULL,
  bond_skill_id INTEGER NOT NULL,
  battle_id VARCHAR(50),
  damage_dealt INTEGER DEFAULT 0,
  effect_applied VARCHAR(50),
  used_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bond_skill_usage_user ON bond_skill_usage_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_bond_skill_usage_skill ON bond_skill_usage_stats(bond_skill_id);

-- 插入示例羁绊技能数据
-- 皮卡丘 (species_id = 25)
INSERT INTO bond_skill_definitions (pokemon_species_id, slot, skill_name, skill_name_en, type, power, accuracy, pp, effect_description, effect_type, unlock_friendship_level, friendship_bonus_formula, energy_cost, cooldown_turns) VALUES
(25, 1, '羁绊电击', 'Bond Thunderbolt', 'electric', 65, 100, 15, '亲密度越高，威力越大', 'damage', 26, '65 + floor(friendship * 0.5)', 20, 0),
(25, 2, '守护闪电', 'Guardian Spark', 'electric', 0, 100, 10, '为队友提供电属性护盾，吸收伤害', 'shield', 76, 'floor(friendship * 10)', 30, 3),
(25, 3, '十万伏特·羁绊', 'Thunder Bond', 'electric', 120, 90, 5, '无视对手电属性抗性，暴击率随亲密度提升', 'damage', 151, '120, crit_bonus: friendship / 255', 50, 2)
ON CONFLICT (pokemon_species_id, slot) DO NOTHING;

-- 伊布 (species_id = 133)
INSERT INTO bond_skill_definitions (pokemon_species_id, slot, skill_name, skill_name_en, type, power, accuracy, pp, effect_description, effect_type, unlock_friendship_level, friendship_bonus_formula, energy_cost, cooldown_turns) VALUES
(133, 1, '羁绊撞击', 'Bond Tackle', 'normal', 50, 100, 20, '根据亲密度提升威力', 'damage', 26, '50 + floor(friendship * 0.3)', 15, 0),
(133, 2, '羁绊守护', 'Bond Guard', 'normal', 0, 100, 15, '根据亲密度提升防御', 'buff', 76, 'defense_bonus: floor(friendship / 10)', 25, 4),
(133, 3, '进化共鸣', 'Evolution Resonance', 'normal', 80, 95, 5, '根据进化倾向提升效果', 'damage', 151, '80 + floor(friendship * 0.4)', 40, 2)
ON CONFLICT (pokemon_species_id, slot) DO NOTHING;

-- 喷火龙 (species_id = 6)
INSERT INTO bond_skill_definitions (pokemon_species_id, slot, skill_name, skill_name_en, type, power, accuracy, pp, effect_description, effect_type, unlock_friendship_level, friendship_bonus_formula, energy_cost, cooldown_turns) VALUES
(6, 1, '羁绊火焰', 'Bond Flame', 'fire', 70, 100, 15, '亲密度越高，威力越大，可能灼伤', 'damage', 26, '70 + floor(friendship * 0.4)', 20, 0),
(6, 2, '龙之羁绊', 'Dragon Bond', 'dragon', 85, 90, 10, '龙属性羁绊攻击', 'damage', 76, '85 + floor(friendship * 0.3)', 30, 2),
(6, 3, '烈焰风暴·羁绊', 'Firestorm Bond', 'fire', 150, 85, 5, '强力火焰攻击，无视火抗性', 'damage', 151, '150, ignore_resistance: true', 60, 3)
ON CONFLICT (pokemon_species_id, slot) DO NOTHING;

-- 杰尼龟 (species_id = 7)
INSERT INTO bond_skill_definitions (pokemon_species_id, slot, skill_name, skill_name_en, type, power, accuracy, pp, effect_description, effect_type, unlock_friendship_level, friendship_bonus_formula, energy_cost, cooldown_turns) VALUES
(7, 1, '羁绊水泡', 'Bond Bubble', 'water', 60, 100, 20, '亲密度越高，威力越大', 'damage', 26, '60 + floor(friendship * 0.35)', 18, 0),
(7, 2, '守护水盾', 'Guardian Water Shield', 'water', 0, 100, 10, '水属性护盾，减少伤害', 'shield', 76, 'shield_hp: floor(friendship * 8)', 25, 3),
(7, 3, ' hydro泵·羁绊', 'Hydro Pump Bond', 'water', 130, 80, 5, '强力水属性攻击', 'damage', 151, '130 + floor(friendship * 0.2)', 55, 2)
ON CONFLICT (pokemon_species_id, slot) DO NOTHING;

-- 注释
COMMENT ON TABLE bond_skill_definitions IS '羁绊技能定义表 - REQ-00151';
COMMENT ON TABLE pokemon_bond_skills IS '精灵羁绊技能学习表 - REQ-00151';
COMMENT ON TABLE bond_skill_usage_stats IS '羁绊技能使用统计表 - REQ-00151';
