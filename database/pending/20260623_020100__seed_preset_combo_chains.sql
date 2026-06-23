-- 预置连击链数据
-- Migration: 20260623_020100__seed_preset_combo_chains.sql

INSERT INTO combo_chains (chain_id, name, description, trigger_sequence, time_window_ms, element_requirement, damage_multiplier, bonus_effects, cooldown_reduction, combo_points, xp_bonus, min_trainer_level) VALUES

-- 元素连击
(
  'THUNDER_TRINITY',
  '雷电三连',
  '连续释放电系技能，触发强力麻痹效果',
  '["THUNDER_SHOCK", "THUNDER_WAVE", "THUNDERBOLT"]'::jsonb,
  5000,
  'electric',
  2.0,
  '{"status": "paralyzed", "duration": 3, "damage_boost": 50}'::jsonb,
  15,
  3,
  100,
  10
),

(
  'FIRE_STORM',
  '火焰风暴',
  '火焰连击，造成持续燃烧伤害',
  '["FIRE_SPIN", "FLAMETHROWER", "FIRE_BLAST"]'::jsonb,
  6000,
  'fire',
  2.5,
  '{"burn": true, "damage_over_time": 10, "duration": 5}'::jsonb,
  20,
  4,
  150,
  15
),

(
  'WATER_CASCADE',
  '水流冲击',
  '水系技能连击，提升闪避率',
  '["WATER_GUN", "BUBBLE_BEAM", "HYDRO_PUMP"]'::jsonb,
  5500,
  'water',
  2.2,
  '{"dodge_boost": 30, "duration": 4}'::jsonb,
  10,
  3,
  120,
  12
),

-- 状态连击
(
  'STATUS_LOCK',
  '状态封锁',
  '连续施加负面状态，使对手陷入完全劣势',
  '["THUNDER_WAVE", "TOXIC", "CONFUSE_RAY"]'::jsonb,
  8000,
  NULL,
  1.5,
  '{"all_status_immunity": true, "duration": 5}'::jsonb,
  0,
  5,
  200,
  20
),

(
  'SLEEP_LOCK',
  '睡眠封锁',
  '让对手陷入沉睡状态',
  '["HYPNOSIS", "DREAM_EATER", "NIGHTMARE"]'::jsonb,
  7000,
  'psychic',
  1.8,
  '{"sleep": true, "duration": 3, "heal_prevention": true}'::jsonb,
  5,
  4,
  180,
  18
),

-- 防御连击
(
  'IRON_DEFENSE',
  '钢铁防御',
  '大幅提升防御力',
  '["IRON_DEFENSE", "HARDEN", "PROTECT"]'::jsonb,
  6000,
  'steel',
  1.0,
  '{"defense_boost": 100, "duration": 5, "status_immunity": true}'::jsonb,
  0,
  3,
  100,
  10
),

-- 治愈连击
(
  'HEALING_CHAIN',
  '治愈连锁',
  '完全恢复精灵状态',
  '["RECOVER", "REST", "HEAL_BELL"]'::jsonb,
  10000,
  'normal',
  1.0,
  '{"full_heal": true, "status_clear": true, "revive_fainted": 0.5}'::jsonb,
  0,
  4,
  150,
  15
),

-- 速度连击
(
  'SPEED_BURST',
  '极速突袭',
  '大幅提升攻击速度',
  '["AGILITY", "QUICK_ATTACK", "EXTREME_SPEED"]'::jsonb,
  4000,
  'normal',
  1.6,
  '{"speed_boost": 80, "accuracy_boost": 30, "duration": 4}'::jsonb,
  25,
  3,
  130,
  13
),

-- 高级连击（需要高等级解锁）
(
  'ELEMENTAL_MASTERY',
  '元素掌控',
  '三元素融合攻击',
  '["FIRE_BLAST", "THUNDERBOLT", "ICE_BEAM"]'::jsonb,
  8000,
  NULL,
  3.0,
  '{"all_elements": true, "crit_rate_boost": 50, "ignore_defense": 30}'::jsonb,
  30,
  6,
  300,
  30
),

(
  'DRAGON_RAGE',
  '龙之怒',
  '龙系终极连击',
  '["DRAGON_BREATH", "DRAGON_CLAW", "DRAGON_PULSE"]'::jsonb,
  7000,
  'dragon',
  3.5,
  '{"dragon_rage": true, "hp_damage": 40, "ignore_typing": true}'::jsonb,
  40,
  8,
  500,
  40
);

-- 更新注释
COMMENT ON TABLE combo_chains IS '预置 10 个连击链配置';
