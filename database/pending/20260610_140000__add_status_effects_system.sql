-- database/pending/20260610_140000__add_status_effects_system.sql
-- REQ-00090: 精灵状态效果系统与战斗Buff/Debuff管理

BEGIN;

-- 状态效果定义表
CREATE TABLE IF NOT EXISTS status_effect_definitions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('control', 'dot', 'stat_change', 'field', 'special')),
    description TEXT NOT NULL,
    icon_url VARCHAR(255),
    max_stacks INT DEFAULT 1,
    duration_type VARCHAR(30) NOT NULL CHECK (duration_type IN ('turns', 'permanent', 'conditional')),
    default_duration INT,
    dispellable BOOLEAN DEFAULT true,
    priority INT DEFAULT 0,
    mutually_exclusive_with INT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 状态效果详细效果表
CREATE TABLE IF NOT EXISTS status_effect_mechanics (
    id SERIAL PRIMARY KEY,
    status_id INT REFERENCES status_effect_definitions(id) ON DELETE CASCADE,
    mechanic_type VARCHAR(50) NOT NULL CHECK (mechanic_type IN ('damage', 'heal', 'stat_mod', 'action_block', 'custom')),
    trigger_event VARCHAR(50) NOT NULL CHECK (trigger_event IN ('turn_start', 'turn_end', 'action_attempt', 'damage_received', 'on_apply', 'on_remove')),
    calculation_formula TEXT NOT NULL,
    conditions JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 战斗中精灵状态表
CREATE TABLE IF NOT EXISTS battle_pokemon_status (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(100) NOT NULL,
    pokemon_instance_id INT NOT NULL,
    status_id INT REFERENCES status_effect_definitions(id),
    source_pokemon_id INT,
    source_move_id INT,
    current_stacks INT DEFAULT 1,
    remaining_turns INT,
    applied_at_turn INT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(battle_id, pokemon_instance_id, status_id)
);

-- 能力变化记录表
CREATE TABLE IF NOT EXISTS battle_stat_changes (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(100) NOT NULL,
    pokemon_instance_id INT NOT NULL,
    stat_type VARCHAR(30) NOT NULL CHECK (stat_type IN ('attack', 'defense', 'sp_attack', 'sp_defense', 'speed', 'accuracy', 'evasion', 'crit_rate')),
    stage INT NOT NULL CHECK (stage >= -6 AND stage <= 6),
    source_status_id INT REFERENCES status_effect_definitions(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(battle_id, pokemon_instance_id, stat_type)
);

-- 属性免疫表
CREATE TABLE IF NOT EXISTS type_status_immunities (
    id SERIAL PRIMARY KEY,
    type_id INT NOT NULL,
    status_id INT REFERENCES status_effect_definitions(id),
    immunity_type VARCHAR(30) DEFAULT 'complete' CHECK (immunity_type IN ('complete', 'partial')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type_id, status_id)
);

-- 特性免疫表
CREATE TABLE IF NOT EXISTS ability_status_immunities (
    id SERIAL PRIMARY KEY,
    ability_id INT NOT NULL,
    status_id INT REFERENCES status_effect_definitions(id),
    immunity_type VARCHAR(30) DEFAULT 'complete' CHECK (immunity_type IN ('complete', 'partial')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ability_id, status_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_battle_pokemon_status_battle ON battle_pokemon_status(battle_id);
CREATE INDEX IF NOT EXISTS idx_battle_pokemon_status_pokemon ON battle_pokemon_status(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_battle_stat_changes_battle ON battle_stat_changes(battle_id);
CREATE INDEX IF NOT EXISTS idx_battle_stat_changes_pokemon ON battle_stat_changes(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_status_effect_mechanics_status ON status_effect_mechanics(status_id);

-- 初始状态效果数据
INSERT INTO status_effect_definitions (code, name, category, description, max_stacks, duration_type, default_duration, dispellable, priority) VALUES
-- 控制类
('burn', '灼伤', 'control', '每回合损失1/8 HP，物理攻击降低50%', 1, 'turns', NULL, true, 10),
('paralysis', '麻痹', 'control', '25%概率无法行动，速度降低50%', 1, 'turns', NULL, true, 10),
('freeze', '冰冻', 'control', '无法行动，受火属性攻击时20%概率解除', 1, 'turns', NULL, true, 12),
('sleep', '睡眠', 'control', '1-3回合无法行动，受伤害时苏醒', 1, 'turns', 2, true, 15),
('confusion', '混乱', 'control', '33%概率攻击自己', 1, 'turns', 2, true, 5),
('flinch', '畏缩', 'control', '跳过当回合行动', 1, 'turns', 1, false, 20),
('attract', '着迷', 'control', '50%概率无法攻击异性精灵', 1, 'turns', NULL, true, 5),
('disable', '封印', 'control', '封印最后使用的技能4回合', 1, 'turns', 4, true, 8),
('encore', '再来一次', 'control', '连续使用最后技能3回合', 1, 'turns', 3, true, 8),
('torment', '折磨', 'control', '无法连续使用同一技能', 1, 'permanent', NULL, true, 6),
-- 持续伤害类
('poison', '中毒', 'dot', '每回合损失1/8 HP', 1, 'turns', NULL, true, 10),
('toxic', '剧毒', 'dot', '每回合递增伤害（n/16 HP）', 1, 'turns', NULL, true, 10),
('leech_seed', '寄生种子', 'dot', '每回合损失1/8 HP，转移给对手', 1, 'permanent', NULL, true, 7),
('curse_ghost', '诅咒(幽灵)', 'dot', '每回合损失1/4 HP', 1, 'permanent', NULL, false, 9),
('perish_song', '灭亡之歌', 'dot', '3回合后濒死', 1, 'turns', 3, false, 0),
-- 能力变化类
('attack_up', '攻击提升', 'stat_change', '攻击力提升', 6, 'permanent', NULL, true, 3),
('attack_down', '攻击下降', 'stat_change', '攻击力下降', 6, 'permanent', NULL, true, 3),
('defense_up', '防御提升', 'stat_change', '防御力提升', 6, 'permanent', NULL, true, 3),
('defense_down', '防御下降', 'stat_change', '防御力下降', 6, 'permanent', NULL, true, 3),
('sp_attack_up', '特攻提升', 'stat_change', '特攻提升', 6, 'permanent', NULL, true, 3),
('sp_attack_down', '特攻下降', 'stat_change', '特攻下降', 6, 'permanent', NULL, true, 3),
('speed_up', '速度提升', 'stat_change', '速度提升', 6, 'permanent', NULL, true, 3),
('speed_down', '速度下降', 'stat_change', '速度下降', 6, 'permanent', NULL, true, 3),
('accuracy_up', '命中提升', 'stat_change', '命中率提升', 6, 'permanent', NULL, true, 3),
('accuracy_down', '命中下降', 'stat_change', '命中率下降', 6, 'permanent', NULL, true, 3),
('evasion_up', '闪避提升', 'stat_change', '闪避率提升', 6, 'permanent', NULL, true, 3),
('evasion_down', '闪避下降', 'stat_change', '闪避率下降', 6, 'permanent', NULL, true, 3),
('crit_rate_up', '暴击提升', 'stat_change', '暴击率提升', 3, 'permanent', NULL, true, 4),
-- 场地效果
('sunny_day', '大晴天', 'field', '火属性技能伤害+50%，水属性技能伤害-50%', 1, 'turns', 5, false, 1),
('rain_dance', '求雨', 'field', '水属性技能伤害+50%，火属性技能伤害-50%', 1, 'turns', 5, false, 1),
('sandstorm', '沙尘暴', 'field', '岩石/地面/钢免疫，其他属性每回合损失1/16 HP', 1, 'turns', 5, false, 1),
('hail', '冰雹', 'field', '冰属性免疫，其他属性每回合损失1/16 HP', 1, 'turns', 5, false, 1),
('electric_terrain', '电气场地', 'field', '电属性技能伤害+30%，免疫睡眠', 1, 'turns', 5, false, 1),
('grassy_terrain', '草地场地', 'field', '草属性技能伤害+30%，每回合回复1/16 HP', 1, 'turns', 5, false, 1),
('psychic_terrain', '精神场地', 'field', '超能属性技能伤害+30%，免疫先制技能', 1, 'turns', 5, false, 1),
('misty_terrain', '薄雾场地', 'field', '龙属性技能伤害-50%，免疫异常状态', 1, 'turns', 5, false, 1),
-- 防御状态
('protect', '守住', 'special', '免疫当回合所有攻击', 1, 'turns', 1, false, 25),
('detect', '看穿', 'special', '免疫当回合所有攻击', 1, 'turns', 1, false, 25),
('endure', '忍耐', 'special', 'HP降至1时免疫死亡', 1, 'turns', 1, false, 22),
('substitute', '替身', 'special', '消耗1/4 HP创建替身吸收伤害', 1, 'permanent', NULL, true, 15),
('ingrain', '扎根', 'special', '每回合回复1/16 HP，无法交换', 1, 'permanent', NULL, true, 7),
('aquatic_ring', '水之圈', 'special', '每回合回复1/16 HP', 1, 'turns', 5, true, 6),
-- 特殊状态
('bound', '束缚', 'special', '无法交换精灵', 1, 'turns', 4, true, 11),
('charging', '蓄力', 'special', '正在蓄力准备强力技能', 1, 'turns', 1, false, 30),
('recharging', '休息', 'special', '使用强力技能后的休息回合', 1, 'turns', 1, false, 30),
('identify', '识破', 'special', '无视闪避', 1, 'turns', 2, false, 4),
('minimize', '变小', 'special', '闪避提升，受特定技能伤害x2', 1, 'permanent', NULL, true, 3)
ON CONFLICT (code) DO NOTHING;

-- 添加状态机制
INSERT INTO status_effect_mechanics (status_id, mechanic_type, trigger_event, calculation_formula, conditions) VALUES
-- 灼伤：回合结束造成伤害
((SELECT id FROM status_effect_definitions WHERE code = 'burn'), 'damage', 'turn_end', 'Math.floor(MAX_HP / 8)', '{"physical_attack_reduction": 0.5}'::jsonb),
-- 中毒：回合结束造成伤害
((SELECT id FROM status_effect_definitions WHERE code = 'poison'), 'damage', 'turn_end', 'Math.floor(MAX_HP / 8)', '{}'::jsonb),
-- 剧毒：回合结束造成递增伤害
((SELECT id FROM status_effect_definitions WHERE code = 'toxic'), 'damage', 'turn_end', 'Math.floor(MAX_HP * STACKS / 16)', '{"increment_stacks": true}'::jsonb),
-- 寄生种子：回合结束造成伤害
((SELECT id FROM status_effect_definitions WHERE code = 'leech_seed'), 'damage', 'turn_end', 'Math.floor(MAX_HP / 8)', '{"transfer_to_source": true}'::jsonb),
-- 扎根：回合开始回复
((SELECT id FROM status_effect_definitions WHERE code = 'ingrain'), 'heal', 'turn_start', 'Math.floor(MAX_HP / 16)', '{}'::jsonb),
-- 水之圈：回合开始回复
((SELECT id FROM status_effect_definitions WHERE code = 'aquatic_ring'), 'heal', 'turn_start', 'Math.floor(MAX_HP / 16)', '{}'::jsonb),
-- 草地场地：回合开始回复
((SELECT id FROM status_effect_definitions WHERE code = 'grassy_terrain'), 'heal', 'turn_start', 'Math.floor(MAX_HP / 16)', '{"ground_type_only": false}'::jsonb),
-- 沙尘暴：回合结束造成伤害
((SELECT id FROM status_effect_definitions WHERE code = 'sandstorm'), 'damage', 'turn_end', 'Math.floor(MAX_HP / 16)', '{"immune_types": ["rock", "ground", "steel"]}'::jsonb),
-- 冰雹：回合结束造成伤害
((SELECT id FROM status_effect_definitions WHERE code = 'hail'), 'damage', 'turn_end', 'Math.floor(MAX_HP / 16)', '{"immune_types": ["ice"]}'::jsonb),
-- 睡眠：阻止行动
((SELECT id FROM status_effect_definitions WHERE code = 'sleep'), 'action_block', 'action_attempt', 'true', '{"wake_on_damage": true}'::jsonb),
-- 冰冻：阻止行动
((SELECT id FROM status_effect_definitions WHERE code = 'freeze'), 'action_block', 'action_attempt', 'true', '{"thaw_on_fire": 0.2}'::jsonb),
-- 畏缩：阻止行动
((SELECT id FROM status_effect_definitions WHERE code = 'flinch'), 'action_block', 'action_attempt', 'true', '{"single_turn": true}'::jsonb)
ON CONFLICT DO NOTHING;

-- 属性免疫数据
-- 火属性免疫灼伤
INSERT INTO type_status_immunities (type_id, status_id, immunity_type) VALUES
(10, (SELECT id FROM status_effect_definitions WHERE code = 'burn'), 'complete'),
-- 电属性免疫麻痹
(13, (SELECT id FROM status_effect_definitions WHERE code = 'paralysis'), 'complete'),
-- 冰属性免疫冰冻
(15, (SELECT id FROM status_effect_definitions WHERE code = 'freeze'), 'complete'),
-- 毒属性免疫中毒
(4, (SELECT id FROM status_effect_definitions WHERE code = 'poison'), 'complete'),
(4, (SELECT id FROM status_effect_definitions WHERE code = 'toxic'), 'complete'),
-- 钢属性免疫中毒
(9, (SELECT id FROM status_effect_definitions WHERE code = 'poison'), 'complete'),
(9, (SELECT id FROM status_effect_definitions WHERE code = 'toxic'), 'complete'),
-- 地面属性免疫沙尘暴
(5, (SELECT id FROM status_effect_definitions WHERE code = 'sandstorm'), 'complete'),
-- 岩石属性免疫沙尘暴
(6, (SELECT id FROM status_effect_definitions WHERE code = 'sandstorm'), 'complete'),
-- 钢属性免疫沙尘暴
(9, (SELECT id FROM status_effect_definitions WHERE code = 'sandstorm'), 'complete'),
-- 冰属性免疫冰雹
(15, (SELECT id FROM status_effect_definitions WHERE code = 'hail'), 'complete')
ON CONFLICT (type_id, status_id) DO NOTHING;

COMMIT;
