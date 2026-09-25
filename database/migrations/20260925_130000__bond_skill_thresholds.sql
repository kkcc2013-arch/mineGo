-- Epic E07：羁绊技能解锁机制（REQ-00151）（幂等）
--
-- 解锁阈值改为"羁绊等级"（0~100 = 亲密度原值 ×100/255）：1/2/3 槽分别 20/50/90（需求原文）。
-- 原数据 26/76/151 是按亲密度原值 0~255 写的，与需求不一致。表由 pending/20260613_064500 创建。

UPDATE bond_skill_definitions
   SET unlock_friendship_level = CASE slot WHEN 1 THEN 20 WHEN 2 THEN 50 ELSE 90 END,
       updated_at = NOW()
 WHERE unlock_friendship_level IN (26, 76, 151);

-- 补充几个常见物种的羁绊技能（进化后仍保留已学会的技能）
INSERT INTO bond_skill_definitions (pokemon_species_id, slot, skill_name, skill_name_en, type, power, accuracy, pp,
                                    effect_description, effect_type, unlock_friendship_level, friendship_bonus_formula, energy_cost, cooldown_turns)
VALUES
  (1, 1, '羁绊藤鞭', 'Bond Vine Whip', 'grass', 55, 100, 20, '亲密度越高，威力越大', 'damage', 20, '55 + floor(friendship * 0.3)', 15, 0),
  (1, 2, '羁绊光合', 'Bond Synthesis', 'grass', 0, 100, 10, '按亲密度回复体力', 'heal', 50, 'heal_hp: floor(friendship / 5)', 25, 3),
  (1, 3, '日光束·羁绊', 'Solar Bond', 'grass', 120, 90, 5, '强力草属性攻击，亲密度越高暴击越高', 'damage', 90, '120, crit_bonus: friendship / 255', 50, 2),
  (4, 1, '羁绊火花', 'Bond Ember', 'fire', 55, 100, 20, '亲密度越高，威力越大', 'damage', 20, '55 + floor(friendship * 0.35)', 15, 0),
  (4, 2, '羁绊鼓舞', 'Bond Cheer', 'fire', 0, 100, 10, '按亲密度提升攻击', 'buff', 50, 'attack_bonus: floor(friendship / 12)', 25, 4),
  (4, 3, '喷射火焰·羁绊', 'Flamethrower Bond', 'fire', 110, 95, 5, '强力火属性攻击', 'damage', 90, '110 + floor(friendship * 0.2)', 45, 2),
  (26, 1, '羁绊雷击', 'Bond Thunder Shock', 'electric', 70, 100, 15, '亲密度越高，威力越大', 'damage', 20, '70 + floor(friendship * 0.4)', 20, 0),
  (26, 2, '守护电场', 'Guardian Field', 'electric', 0, 100, 10, '电场护盾，吸收伤害', 'shield', 50, 'shield_hp: floor(friendship * 9)', 30, 3),
  (26, 3, '打雷·羁绊', 'Thunder Bond', 'electric', 140, 80, 5, '无视对手电属性抗性', 'damage', 90, '140, ignore_resistance: true', 55, 3)
ON CONFLICT (pokemon_species_id, slot) DO NOTHING;
