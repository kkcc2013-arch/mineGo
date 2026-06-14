-- REQ-00086: 精灵特性系统与隐藏能力激活机制
-- 创建时间: 2026-06-14 02:00

-- 特性定义表
CREATE TABLE IF NOT EXISTS abilities (
    id VARCHAR(50) PRIMARY KEY,
    name_en VARCHAR(100) NOT NULL,
    name_zh VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('passive', 'trigger', 'environment', 'immunity', 'transformation')),
    trigger_condition JSONB,
    effect_config JSONB NOT NULL,
    priority INTEGER DEFAULT 0,
    is_hidden BOOLEAN DEFAULT FALSE,
    introduced_generation INTEGER DEFAULT 9,
    meta_data JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE abilities IS '精灵特性定义表';
COMMENT ON COLUMN abilities.type IS '特性类型: passive=被动, trigger=触发, environment=环境, immunity=免疫, transformation=转换';
COMMENT ON COLUMN abilities.trigger_condition IS '触发条件配置JSON';
COMMENT ON COLUMN abilities.effect_config IS '特性效果配置JSON';

-- 精灵特性映射表（定义每个精灵可选特性）
CREATE TABLE IF NOT EXISTS pokemon_abilities (
    id SERIAL PRIMARY KEY,
    pokemon_species_id VARCHAR(50) NOT NULL,
    ability_id VARCHAR(50) NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot IN (1, 2, 3)),
    probability DECIMAL(5, 4) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_species_id, ability_id)
);

CREATE INDEX IF NOT EXISTS idx_pokemon_abilities_species ON pokemon_abilities(pokemon_species_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_abilities_ability ON pokemon_abilities(ability_id);

COMMENT ON TABLE pokemon_abilities IS '精灵种类与特性映射表，slot 1,2为普通特性，3为隐藏特性';

-- 玩家精灵实例特性表
CREATE TABLE IF NOT EXISTS player_pokemon_abilities (
    id SERIAL PRIMARY KEY,
    player_pokemon_id INTEGER NOT NULL,
    ability_id VARCHAR(50) NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot IN (1, 2, 3)),
    is_active BOOLEAN DEFAULT TRUE,
    is_hidden BOOLEAN DEFAULT FALSE,
    unlocked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_pokemon_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_player_pokemon_abilities_pokemon ON player_pokemon_abilities(player_pokemon_id);
CREATE INDEX IF NOT EXISTS idx_player_pokemon_abilities_active ON player_pokemon_abilities(player_pokemon_id, is_active);

COMMENT ON TABLE player_pokemon_abilities IS '玩家精灵实例特性表，记录每个精灵的特性状态';

-- 特性触发日志
CREATE TABLE IF NOT EXISTS ability_trigger_logs (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(50),
    player_pokemon_id INTEGER NOT NULL,
    ability_id VARCHAR(50) NOT NULL,
    trigger_type VARCHAR(50) NOT NULL,
    trigger_context JSONB NOT NULL,
    effect_result JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ability_trigger_logs_battle ON ability_trigger_logs(battle_id);
CREATE INDEX IF NOT EXISTS idx_ability_trigger_logs_ability ON ability_trigger_logs(ability_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ability_trigger_logs_time ON ability_trigger_logs(created_at);

COMMENT ON TABLE ability_trigger_logs IS '特性触发日志，用于分析和调试';

-- 特性道具表
CREATE TABLE IF NOT EXISTS ability_items (
    id VARCHAR(50) PRIMARY KEY,
    name_en VARCHAR(100) NOT NULL,
    name_zh VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    item_type VARCHAR(50) NOT NULL CHECK (item_type IN ('ability_capsule', 'ability_patch', 'hidden_ability_unlock')),
    effect_config JSONB NOT NULL,
    rarity VARCHAR(20) DEFAULT 'rare',
    obtained_from JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE ability_items IS '特性道具定义表';

-- 插入常见特性定义（精选 50+ 种核心特性）
INSERT INTO abilities (id, name_en, name_zh, description, type, trigger_condition, effect_config, priority, is_hidden) VALUES
-- 被动特性（永久生效）
('intimidate', 'Intimidate', '威吓', '出场时降低对手攻击', 'passive', '{"trigger": "on_enter"}', '{"type": "stat_boost", "target": "opponent", "stat": "attack", "stage": -1}', 1, false),
('pressure', 'Pressure', '压迫感', '增加对手PP消耗', 'passive', NULL, '{"type": "pp_drain", "multiplier": 2}', 0, false),
('synchronize', 'Synchronize', '同步', '受到异常状态时传递给对手', 'passive', NULL, '{"type": "status_mirror"}', 0, false),
('clear_body', 'Clear Body', '净体', '免疫能力值降低', 'passive', NULL, '{"type": "stat_immunity", "direction": "decrease"}', 0, false),
('white_smoke', 'White Smoke', '白色烟雾', '免疫能力值降低', 'passive', NULL, '{"type": "stat_immunity", "direction": "decrease"}', 0, false),

-- 触发特性（条件触发）
('blaze', 'Blaze', '猛火', 'HP低于1/3时火系技能威力提升50%', 'trigger', '{"type": "hp_threshold", "threshold": 0.333}', '{"type": "damage_modifier", "move_type": "fire", "multiplier": 1.5}', 0, false),
('torrent', 'Torrent', '激流', 'HP低于1/3时水系技能威力提升50%', 'trigger', '{"type": "hp_threshold", "threshold": 0.333}', '{"type": "damage_modifier", "move_type": "water", "multiplier": 1.5}', 0, false),
('overgrow', 'Overgrow', '茂盛', 'HP低于1/3时草系技能威力提升50%', 'trigger', '{"type": "hp_threshold", "threshold": 0.333}', '{"type": "damage_modifier", "move_type": "grass", "multiplier": 1.5}', 0, false),
('swarm', 'Swarm', '虫之预感', 'HP低于1/3时虫系技能威力提升50%', 'trigger', '{"type": "hp_threshold", "threshold": 0.333}', '{"type": "damage_modifier", "move_type": "bug", "multiplier": 1.5}', 0, false),
('guts', 'Guts', '毅力', '异常状态时攻击提升50%', 'trigger', '{"type": "has_status"}', '{"type": "stat_boost", "stat": "attack", "multiplier": 1.5}', 0, false),

-- 环境特性（影响天气/场地）
('drizzle', 'Drizzle', '降雨', '出场时天气变为雨天', 'environment', '{"trigger": "on_enter"}', '{"type": "weather_change", "weather": "rain", "duration": 5}', 1, false),
('drought', 'Drought', '日照', '出场时天气变为晴天', 'environment', '{"trigger": "on_enter"}', '{"type": "weather_change", "weather": "sun", "duration": 5}', 1, false),
('sandstream', 'Sand Stream', '沙暴', '出场时天气变为沙暴', 'environment', '{"trigger": "on_enter"}', '{"type": "weather_change", "weather": "sandstorm", "duration": 5}', 1, false),
('snow_warning', 'Snow Warning', '降雪', '出场时天气变为冰雹', 'environment', '{"trigger": "on_enter"}', '{"type": "weather_change", "weather": "hail", "duration": 5}', 1, false),
('electric_terrain', 'Electric Surge', '电气场地', '出场时展开电气场地', 'environment', '{"trigger": "on_enter"}', '{"type": "terrain_change", "terrain": "electric", "duration": 5}', 1, false),

-- 免疫特性
('levitate', 'Levitate', '漂浮', '免疫地面系技能', 'immunity', NULL, '{"type": "immune", "to": ["ground"]}', 0, false),
('water_absorb', 'Water Absorb', '储水', '受到水系技能时回复HP', 'immunity', NULL, '{"type": "absorb", "from": "water", "heal_percent": 25}', 0, false),
('volt_absorb', 'Volt Absorb', '蓄电', '受到电系技能时回复HP', 'immunity', NULL, '{"type": "absorb", "from": "electric", "heal_percent": 25}', 0, false),
('flash_fire', 'Flash Fire', '引火', '受到火系技能时提升火系威力', 'immunity', NULL, '{"type": "absorb_boost", "from": "fire", "boost_type": "fire", "multiplier": 1.5}', 0, false),
('lightning_rod', 'Lightning Rod', '避雷针', '免疫电系技能并提升特攻', 'immunity', NULL, '{"type": "redirect_absorb", "from": "electric", "stat": "sp_attack", "stage": 1}', 0, false),

-- 转换特性
('protean', 'Protean', '变幻自如', '使用技能前变为技能属性', 'transformation', '{"trigger": "before_move"}', '{"type": "type_change", "source": "move"}', 0, true),
('libero', 'Libero', '自由者', '使用技能前变为技能属性', 'transformation', '{"trigger": "before_move"}', '{"type": "type_change", "source": "move"}', 0, true),
('color_change', 'Color Change', '变色', '受到技能后变为该技能属性', 'transformation', '{"trigger": "on_hit"}', '{"type": "type_change", "source": "incoming_move"}', 0, false),

-- 受击触发特性
('static', 'Static', '静电', '受到接触类技能时30%麻痹对手', 'trigger', '{"trigger": "on_hit", "contact": true}', '{"type": "status_inflict", "status": "paralysis", "chance": 30}', 0, false),
('flame_body', 'Flame Body', '火焰之躯', '受到接触类技能时30%灼伤对手', 'trigger', '{"trigger": "on_hit", "contact": true}', '{"type": "status_inflict", "status": "burn", "chance": 30}', 0, false),
('poison_point', 'Poison Point', '毒刺', '受到接触类技能时30%中毒对手', 'trigger', '{"trigger": "on_hit", "contact": true}', '{"type": "status_inflict", "status": "poison", "chance": 30}', 0, false),
('rough_skin', 'Rough Skin', '粗糙皮肤', '受到接触类技能时反伤1/8', 'trigger', '{"trigger": "on_hit", "contact": true}', '{"type": "recoil_damage", "percent": 12.5}', 0, false),
('iron_barbs', 'Iron Barbs', '铁刺', '受到接触类技能时反伤1/8', 'trigger', '{"trigger": "on_hit", "contact": true}', '{"type": "recoil_damage", "percent": 12.5}', 0, false),

-- 速度/行动相关
('speed_boost', 'Speed Boost', '加速', '每回合速度提升一级', 'trigger', '{"trigger": "on_turn_end"}', '{"type": "stat_boost", "stat": "speed", "stage": 1}', 0, true),
('moody', 'Moody', '心情不定', '每回合随机提升一项能力两级，降低一项一级', 'trigger', '{"trigger": "on_turn_end"}', '{"type": "random_stat_change", "up": 2, "down": 1}', 0, true),

-- 特殊隐藏特性
('huge_power', 'Huge Power', '大力士', '攻击力翻倍', 'passive', NULL, '{"type": "stat_multiplier", "stat": "attack", "multiplier": 2}', 0, true),
('pure_power', 'Pure Power', '瑜伽之力', '攻击力翻倍', 'passive', NULL, '{"type": "stat_multiplier", "stat": "attack", "multiplier": 2}', 0, true),
('sheer_force', 'Sheer Force', '强行', '附加效果技能威力提升30%', 'trigger', '{"trigger": "on_move_with_effect"}', '{"type": "damage_modifier", "multiplier": 1.3, "remove_effect": true}', 0, true),
('tough_claws', 'Tough Claws', '强硬', '接触类技能威力提升33%', 'trigger', '{"trigger": "on_contact_move"}', '{"type": "damage_modifier", "multiplier": 1.33}', 0, true),
('iron_fist', 'Iron Fist', '铁拳', '拳击类技能威力提升20%', 'trigger', '{"trigger": "on_punch_move"}', '{"type": "damage_modifier", "multiplier": 1.2}', 0, false),

-- 天气相关
('rain_dish', 'Rain Dish', '雨盘', '雨天时每回合回复1/16 HP', 'trigger', '{"trigger": "on_turn_end", "weather": "rain"}', '{"type": "heal", "percent": 6.25}', 0, false),
('solar_power', 'Solar Power', '太阳之力', '晴天时特攻提升但每回合损失HP', 'trigger', '{"trigger": "on_turn_end", "weather": "sun"}', '{"type": "stat_boost_damage", "stat": "sp_attack", "multiplier": 1.5, "hp_loss": 12.5}', 0, false),

-- 其他实用特性
('multiscale', 'Multiscale', '多重鳞片', '满HP时受到伤害减半', 'trigger', '{"trigger": "on_damage", "condition": "full_hp"}', '{"type": "damage_reduction", "percent": 50}', 0, true),
('magic_guard', 'Magic Guard', '魔法防守', '免疫间接伤害', 'passive', NULL, '{"type": "indirect_damage_immunity"}', 0, true),
('regenerator', 'Regenerator', '再生力', '切换出场时回复1/3 HP', 'trigger', '{"trigger": "on_switch_out"}', '{"type": "heal", "percent": 33.3}', 0, true),
('natural_cure', 'Natural Cure', '自然回复', '切换出场时治愈异常状态', 'trigger', '{"trigger": "on_switch_out"}', '{"type": "cure_status"}', 0, false),
('shed_skin', 'Shed Skin', '蜕皮', '每回合30%治愈异常状态', 'trigger', '{"trigger": "on_turn_end"}', '{"type": "cure_status", "chance": 30}', 0, false),

-- 防御特性
('sturdy', 'Sturdy', '结实', '满HP时免疫一击必杀，HP为1时保留1HP', 'passive', NULL, '{"type": "prevent_ohko", "endure": true}', 0, false),
('battle_armor', 'Battle Armor', '战斗盔甲', '免疫暴击', 'passive', NULL, '{"type": "critical_immunity"}', 0, false),
('shell_armor', 'Shell Armor', '贝壳盔甲', '免疫暴击', 'passive', NULL, '{"type": "critical_immunity"}', 0, false),

-- 能力提升特性
('mold_breaker', 'Mold Breaker', '破格', '无视对手特性', 'passive', NULL, '{"type": "ignore_opponent_ability"}', 0, false),
('teravolt', 'Teravolt', '涡轮火焰', '无视对手特性', 'passive', NULL, '{"type": "ignore_opponent_ability"}', 0, true),
('turboblaze', 'Turboblaze', '兆级电压', '无视对手特性', 'passive', NULL, '{"type": "ignore_opponent_ability"}', 0, true)
ON CONFLICT (id) DO NOTHING;

-- 插入特性道具
INSERT INTO ability_items (id, name_en, name_zh, description, item_type, effect_config, rarity) VALUES
('ability_capsule', 'Ability Capsule', '特性胶囊', '切换精灵的普通特性', 'ability_capsule', '{"action": "switch_normal"}', 'rare'),
('ability_patch', 'Ability Patch', '特性膏药', '解锁精灵的隐藏特性', 'ability_patch', '{"action": "unlock_hidden"}', 'ultra_rare'),
('hidden_ability_unlock', 'Hidden Ability Unlock', '隐藏特性解锁道具', '解锁精灵的隐藏特性（特殊活动道具）', 'hidden_ability_unlock', '{"action": "unlock_hidden", "special": true}', 'legendary')
ON CONFLICT (id) DO NOTHING;

-- 为部分精灵分配特性示例
-- 皮卡丘
INSERT INTO pokemon_abilities (pokemon_species_id, ability_id, slot, probability) VALUES
('pikachu', 'static', 1, 0.5),
('pikachu', 'lightning_rod', 2, 0.5),
('pikachu', 'speed_boost', 3, 0.01)
ON CONFLICT (pokemon_species_id, ability_id) DO NOTHING;

-- 小火龙
INSERT INTO pokemon_abilities (pokemon_species_id, ability_id, slot, probability) VALUES
('charmander', 'blaze', 1, 1.0),
('charmander', 'solar_power', 3, 0.01)
ON CONFLICT (pokemon_species_id, ability_id) DO NOTHING;

-- 杰尼龟
INSERT INTO pokemon_abilities (pokemon_species_id, ability_id, slot, probability) VALUES
('squirtle', 'torrent', 1, 1.0),
('squirtle', 'rain_dish', 3, 0.01)
ON CONFLICT (pokemon_species_id, ability_id) DO NOTHING;

-- 妙蛙种子
INSERT INTO pokemon_abilities (pokemon_species_id, ability_id, slot, probability) VALUES
('bulbasaur', 'overgrow', 1, 1.0),
('bulbasaur', 'chlorophyll', 3, 0.01)
ON CONFLICT (pokemon_species_id, ability_id) DO NOTHING;

-- 添加缺失的叶绿素特性
INSERT INTO abilities (id, name_en, name_zh, description, type, trigger_condition, effect_config, priority, is_hidden) VALUES
('chlorophyll', 'Chlorophyll', '叶绿素', '晴天时速度翻倍', 'trigger', '{"trigger": "weather", "weather": "sun"}', '{"type": "stat_multiplier", "stat": "speed", "multiplier": 2}', 0, true)
ON CONFLICT (id) DO NOTHING;

-- 创建特性统计视图
CREATE OR REPLACE VIEW ability_stats AS
SELECT 
    a.id,
    a.name_en,
    a.name_zh,
    a.type,
    a.is_hidden,
    COUNT(DISTINCT pa.pokemon_species_id) as pokemon_count,
    COUNT(DISTINCT ppa.player_pokemon_id) as active_count
FROM abilities a
LEFT JOIN pokemon_abilities pa ON a.id = pa.ability_id
LEFT JOIN player_pokemon_abilities ppa ON a.id = ppa.ability_id AND ppa.is_active = TRUE
GROUP BY a.id, a.name_en, a.name_zh, a.type, a.is_hidden;

COMMENT ON VIEW ability_stats IS '特性统计视图，显示每个特性的使用情况';
