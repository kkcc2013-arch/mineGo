-- 精灵天赋系统数据库迁移
-- REQ-00408：精灵天赋系统与隐藏属性解锁机制

-- 精灵天赋配置表
CREATE TABLE IF NOT EXISTS pokemon_talent_config (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    
    -- 已分配天赋 JSON: { "talent_id": level }
    allocated_talents JSONB DEFAULT '{}',
    
    -- 天赋点
    total_points INTEGER DEFAULT 0,
    used_points INTEGER DEFAULT 0,
    
    -- 隐藏属性缓存 (计算后)
    hidden_attributes JSONB DEFAULT '{}',
    -- 示例: { "criticalRate": 0.15, "criticalDamage": 1.8, "accuracy": 0.97, "dodgeRate": 0.07 }
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_pokemon_talent UNIQUE (pokemon_id),
    CONSTRAINT valid_points CHECK (used_points >= 0 AND used_points <= total_points)
);

-- 天赋定义表 (系统配置)
CREATE TABLE IF NOT EXISTS talent_definitions (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    name_i18n JSONB DEFAULT '{}', -- 多语言名称
    description TEXT,
    description_i18n JSONB DEFAULT '{}',
    
    -- 类别: attack/defense/support/utility
    category VARCHAR(20) NOT NULL,
    
    -- 最大等级
    max_level INTEGER DEFAULT 3,
    
    -- 每级消耗天赋点
    cost_per_level INTEGER DEFAULT 1,
    
    -- 效果配置
    effects JSONB NOT NULL DEFAULT '{}',
    -- 示例: { "type": "skill_damage_boost", "elementType": "fire", "valuePerLevel": [0.10, 0.20, 0.30] }
    
    -- 前置天赋
    prerequisites JSONB DEFAULT '[]',
    -- 示例: ["talent_fire_boost_1", "talent_critical_boost"]
    
    -- 解锁条件
    unlock_condition JSONB DEFAULT '{}',
    -- 示例: { "level": 10, "evolution": 2 }
    
    -- 适用精灵类型 (空数组表示全部适用)
    pokemon_types JSONB DEFAULT '[]',
    -- 示例: ["fire", "dragon"]
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 天赋树定义表
CREATE TABLE IF NOT EXISTS talent_tree_definitions (
    pokemon_type VARCHAR(100) PRIMARY KEY,
    
    -- 分支配置
    branches JSONB NOT NULL,
    -- 示例: {
    --   "attack": { "name": "攻击", "nodes": ["talent_fire_boost_1", ...] },
    --   "defense": { "name": "防御", "nodes": [...] },
    --   "support": { "name": "辅助", "nodes": [...] }
    -- }
    
    -- 最大天赋点数
    total_talent_points INTEGER DEFAULT 15,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 天赋点获取记录表
CREATE TABLE IF NOT EXISTS talent_point_records (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    
    -- 来源类型: level_up/evolution/achievement/item
    source_type VARCHAR(50) NOT NULL,
    
    -- 获得点数
    points INTEGER NOT NULL,
    
    -- 来源详情
    details JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 天赋重置历史表
CREATE TABLE IF NOT EXISTS talent_reset_history (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    
    -- 重置前配置
    previous_talents JSONB NOT NULL,
    
    -- 返还点数
    refunded_points INTEGER NOT NULL,
    
    -- 消耗道具ID
    consumed_item_id VARCHAR(100),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 天赋推荐配置表
CREATE TABLE IF NOT EXISTS talent_recommendations (
    id SERIAL PRIMARY KEY,
    pokemon_type VARCHAR(100) NOT NULL,
    
    -- 推荐风格: attack/defense/balance/pvp/pve
    style VARCHAR(50) NOT NULL,
    
    -- 推荐天赋配置
    recommended_talents JSONB NOT NULL,
    -- 示例: { "talent_critical_boost": 3, "talent_attack_power": 2 }
    
    -- 推荐描述
    description TEXT,
    description_i18n JSONB DEFAULT '{}',
    
    -- 推荐评分
    rating INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_type_style UNIQUE (pokemon_type, style)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_talent_config_pokemon ON pokemon_talent_config(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_talent_config_points ON pokemon_talent_config(total_points, used_points);
CREATE INDEX IF NOT EXISTS idx_talent_def_category ON talent_definitions(category);
CREATE INDEX IF NOT EXISTS idx_talent_tree_type ON talent_tree_definitions(pokemon_type);
CREATE INDEX IF NOT EXISTS idx_talent_point_pokemon ON talent_point_records(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_talent_reset_user ON talent_reset_history(user_id);

-- 初始化部分天赋定义
INSERT INTO talent_definitions (id, name, name_i18n, description, description_i18n, category, max_level, cost_per_level, effects, prerequisites, unlock_condition, pokemon_types) VALUES
-- 攻击类天赋
('talent_fire_boost', '火焰强化', '{"en": "Fire Boost", "ja": "炎強化"}', '火属性技能伤害提升', '{"en": "Fire skill damage boost", "ja": "炎タイプのスキルダメージアップ"}', 'attack', 3, 1,
 '{"type": "skill_damage_boost", "elementType": "fire", "valuePerLevel": [0.10, 0.20, 0.30]}', '[]', '{"level": 10}', '["fire"]'),
('talent_water_boost', '水流强化', '{"en": "Water Boost", "ja": "水強化"}', '水属性技能伤害提升', '{"en": "Water skill damage boost", "ja": "水タイプのスキルダメージアップ"}', 'attack', 3, 1,
 '{"type": "skill_damage_boost", "elementType": "water", "valuePerLevel": [0.10, 0.20, 0.30]}', '[]', '{"level": 10}', '["water"]'),
('talent_electric_boost', '雷电强化', '{"en": "Electric Boost", "ja": "電気強化"}', '电属性技能伤害提升', '{"en": "Electric skill damage boost", "ja": "電気タイプのスキルダメージアップ"}', 'attack', 3, 1,
 '{"type": "skill_damage_boost", "elementType": "electric", "valuePerLevel": [0.10, 0.20, 0.30]}', '[]', '{"level": 10}', '["electric"]'),
('talent_critical_boost', '暴击强化', '{"en": "Critical Boost", "ja": "クリティカル強化"}', '暴击率提升', '{"en": "Critical rate boost", "ja": "クリティカル率アップ"}', 'attack', 3, 1,
 '{"type": "attribute_boost", "attribute": "criticalRate", "valuePerLevel": [0.03, 0.06, 0.10]}', '[]', '{"level": 15}', '[]'),
('talent_critical_damage', '暴击伤害', '{"en": "Critical Damage", "ja": "クリティカルダメージ"}', '暴击伤害提升', '{"en": "Critical damage boost", "ja": "クリティカルダメージアップ"}', 'attack', 3, 1,
 '{"type": "attribute_boost", "attribute": "criticalDamage", "valuePerLevel": [0.15, 0.30, 0.50]}', '["talent_critical_boost"]', '{"level": 20}', '[]'),
('talent_attack_power', '攻击力', '{"en": "Attack Power", "ja": "攻撃力"}', '基础攻击力提升', '{"en": "Base attack boost", "ja": "基礎攻撃力アップ"}', 'attack', 3, 1,
 '{"type": "stat_boost", "stat": "attack", "valuePerLevel": [0.05, 0.10, 0.15]}', '[]', '{"level": 10}', '[]'),
('talent_penetration', '穿透', '{"en": "Penetration", "ja": "貫通"}', '技能穿透率', '{"en": "Skill penetration", "ja": "スキル貫通率"}', 'attack', 2, 1,
 '{"type": "attribute_boost", "attribute": "penetration", "valuePerLevel": [0.10, 0.20]}', '["talent_attack_power"]', '{"level": 25}', '[]'),

-- 防御类天赋
('talent_defense_boost', '防御强化', '{"en": "Defense Boost", "ja": "防御強化"}', '基础防御力提升', '{"en": "Base defense boost", "ja": "基礎防御力アップ"}', 'defense', 3, 1,
 '{"type": "stat_boost", "stat": "defense", "valuePerLevel": [0.05, 0.10, 0.15]}', '[]', '{"level": 10}', '[]'),
('talent_hp_boost', '生命强化', '{"en": "HP Boost", "ja": "HP強化"}', '最大生命值提升', '{"en": "Max HP boost", "ja": "最大HPアップ"}', 'defense', 3, 1,
 '{"type": "stat_boost", "stat": "hp", "valuePerLevel": [0.05, 0.10, 0.15]}', '[]', '{"level": 10}', '[]'),
('talent_fire_resist', '火焰抗性', '{"en": "Fire Resist", "ja": "炎耐性"}', '火焰伤害减免', '{"en": "Fire damage reduction", "ja": "炎ダメージ軽減"}', 'defense', 3, 1,
 '{"type": "resistance_boost", "elementType": "fire", "valuePerLevel": [0.10, 0.20, 0.30]}', '[]', '{"level": 15}', '[]'),
('talent_water_resist', '水流抗性', '{"en": "Water Resist", "ja": "水耐性"}', '水流伤害减免', '{"en": "Water damage reduction", "ja": "水ダメージ軽減"}', 'defense', 3, 1,
 '{"type": "resistance_boost", "elementType": "water", "valuePerLevel": [0.10, 0.20, 0.30]}', '[]', '{"level": 15}', '[]'),
('talent_dodge_chance', '闪避强化', '{"en": "Dodge Boost", "ja": "回避強化"}', '闪避率提升', '{"en": "Dodge rate boost", "ja": "回避率アップ"}', 'defense', 3, 1,
 '{"type": "attribute_boost", "attribute": "dodgeRate", "valuePerLevel": [0.03, 0.06, 0.10]}', '["talent_defense_boost"]', '{"level": 20}', '[]'),

-- 辅助类天赋
('talent_energy_regen', '能量回复', '{"en": "Energy Regen", "ja": "エネルギー回復"}', '能量恢复速度提升', '{"en": "Energy regeneration boost", "ja": "エネルギー回復速度アップ"}', 'support', 3, 1,
 '{"type": "attribute_boost", "attribute": "energyRegen", "valuePerLevel": [0.05, 0.10, 0.15]}', '[]', '{"level": 10}', '[]'),
('talent_cooldown_reduction', '冷却缩减', '{"en": "Cooldown Reduction", "ja": "クールダウン短縮"}', '技能冷却时间减少', '{"en": "Skill cooldown reduction", "ja": "スキルクールダウン短縮"}', 'support', 3, 1,
 '{"type": "cooldown_reduction", "valuePerLevel": [0.05, 0.10, 0.15]}', '["talent_energy_regen"]', '{"level": 15}', '[]'),
('talent_accuracy', '命中强化', '{"en": "Accuracy Boost", "ja": "命中強化"}', '命中率提升', '{"en": "Accuracy boost", "ja": "命中率アップ"}', 'support', 3, 1,
 '{"type": "attribute_boost", "attribute": "accuracy", "valuePerLevel": [0.01, 0.02, 0.05]}', '[]', '{"level": 10}', '[]'),
('talent_healing_boost', '治愈强化', '{"en": "Healing Boost", "ja": "回復強化"}', '受到治疗效果提升', '{"en": "Healing received boost", "ja": "回復量アップ"}', 'support', 3, 1,
 '{"type": "attribute_boost", "attribute": "healingBoost", "valuePerLevel": [0.10, 0.20, 0.30]}', '[]', '{"level": 15}', '[]');

-- 初始化天赋推荐配置
INSERT INTO talent_recommendations (pokemon_type, style, recommended_talents, description, description_i18n) VALUES
('fire_dragon', 'attack', '{"talent_fire_boost": 3, "talent_critical_boost": 3, "talent_attack_power": 2, "talent_critical_damage": 3}', '高伤害输出配置', '{"en": "High damage output build", "ja": "高ダメージ出力ビルド"}'),
('fire_dragon', 'defense', '{"talent_hp_boost": 3, "talent_defense_boost": 3, "talent_fire_resist": 3, "talent_dodge_chance": 2}', '生存能力配置', '{"en": "Survival build", "ja": "サバイバルビルド"}'),
('fire_dragon', 'balance', '{"talent_fire_boost": 2, "talent_defense_boost": 2, "talent_hp_boost": 2, "talent_energy_regen": 2}', '均衡配置', '{"en": "Balanced build", "ja": "バランスビルド"}'),
('water_dragon', 'attack', '{"talent_water_boost": 3, "talent_critical_boost": 3, "talent_attack_power": 2, "talent_critical_damage": 3}', '高伤害输出配置', '{"en": "High damage output build", "ja": "高ダメージ出力ビルド"}'),
('electric_dragon', 'attack', '{"talent_electric_boost": 3, "talent_critical_boost": 3, "talent_attack_power": 2, "talent_penetration": 2}', '高爆发配置', '{"en": "High burst build", "ja": "高バーストビルド"}');

-- 表注释
COMMENT ON TABLE pokemon_talent_config IS '精灵天赋配置表';
COMMENT ON TABLE talent_definitions IS '天赋定义表';
COMMENT ON TABLE talent_tree_definitions IS '天赋树定义表';
COMMENT ON TABLE talent_point_records IS '天赋点获取记录';
COMMENT ON TABLE talent_reset_history IS '天赋重置记录';
COMMENT ON TABLE talent_recommendations IS '天赋推荐配置';