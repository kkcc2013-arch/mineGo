-- Epic E07：精灵专项特训（REQ-00612）（幂等）

-- 训练属性（每 10 点 = 1 级）
CREATE TABLE IF NOT EXISTS pokemon_training_attributes (
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  attribute           VARCHAR(20) NOT NULL CHECK (attribute IN ('attack', 'defense', 'speed', 'critical', 'dodge', 'energy')),
  points              INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  level               INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pokemon_instance_id, attribute)
);

-- 技能熟练度（每只精灵每个招式一行）
CREATE TABLE IF NOT EXISTS pokemon_skill_mastery (
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  move_id             VARCHAR(32) NOT NULL,
  power               SMALLINT NOT NULL DEFAULT 0 CHECK (power BETWEEN 0 AND 10),
  accuracy            SMALLINT NOT NULL DEFAULT 0 CHECK (accuracy BETWEEN 0 AND 10),
  critical_chance     SMALLINT NOT NULL DEFAULT 0 CHECK (critical_chance BETWEEN 0 AND 5),
  mastery_exp         SMALLINT NOT NULL DEFAULT 0 CHECK (mastery_exp BETWEEN 0 AND 100),
  unlocked_effects    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pokemon_instance_id, move_id)
);

-- 特训队列 / 记录
CREATE TABLE IF NOT EXISTS special_training_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pokemon_id          UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  attribute           VARCHAR(20) NOT NULL,
  facility_id         VARCHAR(40) NOT NULL DEFAULT 'basic',
  status              VARCHAR(20) NOT NULL DEFAULT 'training' CHECK (status IN ('training', 'completed', 'cancelled')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at             TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  expected_points     INTEGER NOT NULL,
  success_rate        NUMERIC(4,3) NOT NULL DEFAULT 0.8,
  success             BOOLEAN,
  points_gained       INTEGER,
  accelerated_minutes INTEGER NOT NULL DEFAULT 0,
  cost                JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_special_training_active_pokemon ON special_training_sessions (pokemon_id) WHERE status = 'training';
CREATE INDEX IF NOT EXISTS idx_special_training_user_status ON special_training_sessions (user_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_special_training_pokemon ON special_training_sessions (pokemon_id, started_at DESC);

-- 训练场地首次使用记录（解锁条件为训练师等级）
CREATE TABLE IF NOT EXISTS user_training_facilities (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id VARCHAR(40) NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, facility_id)
);

-- 训练成就（达成即发放奖励）
CREATE TABLE IF NOT EXISTS special_training_achievements (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id VARCHAR(40) NOT NULL,
  achieved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rewards        JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, achievement_id)
);

-- 训练道具（库存走 player_inventory；shop_price > 0 且非付费道具可用金币购买）
INSERT INTO items (id, item_id, category, name_zh, name_en, description_zh, description_en, rarity, effect_type, shop_price, is_premium)
VALUES
  ('TRAIN_ENERGY_DRINK', 'TRAIN_ENERGY_DRINK', 'special_training', '训练能量饮料', 'Training Energy Drink', '攻击特训必需', 'Required for attack training', 'common', 'training_material', 100, FALSE),
  ('TRAIN_PROTEIN_POWDER', 'TRAIN_PROTEIN_POWDER', 'special_training', '蛋白粉', 'Protein Powder', '防御特训必需', 'Required for defense training', 'common', 'training_material', 100, FALSE),
  ('TRAIN_AGILITY_PILL', 'TRAIN_AGILITY_PILL', 'special_training', '敏捷药剂', 'Agility Pill', '速度特训必需', 'Required for speed training', 'common', 'training_material', 100, FALSE),
  ('TRAIN_CRITICAL_STONE', 'TRAIN_CRITICAL_STONE', 'special_training', '暴击石', 'Critical Stone', '暴击特训、技能暴击熟练度必需', 'Required for critical training', 'rare', 'training_material', 500, FALSE),
  ('TRAIN_SWIFT_FEATHER', 'TRAIN_SWIFT_FEATHER', 'special_training', '疾风羽毛', 'Swift Feather', '闪避特训必需', 'Required for dodge training', 'rare', 'training_material', 500, FALSE),
  ('TRAIN_ENERGY_CORE', 'TRAIN_ENERGY_CORE', 'special_training', '能量核心', 'Energy Core', '能量特训必需', 'Required for energy training', 'rare', 'training_material', 500, FALSE),
  ('TRAIN_FOCUS_LENS', 'TRAIN_FOCUS_LENS', 'special_training', '焦点镜', 'Focus Lens', '技能命中熟练度必需', 'Required for accuracy mastery', 'uncommon', 'training_material', 300, FALSE),
  ('TRAINING_ACCELERATOR_1H', 'TRAINING_ACCELERATOR_1H', 'special_training', '训练加速器(1小时)', 'Training Accelerator (1h)', '特训时间缩短 1 小时', 'Shortens special training by 1 hour', 'uncommon', 'training_speedup', 300, FALSE),
  ('TRAINING_ACCELERATOR_8H', 'TRAINING_ACCELERATOR_8H', 'special_training', '训练加速器(8小时)', 'Training Accelerator (8h)', '特训时间缩短 8 小时', 'Shortens special training by 8 hours', 'rare', 'training_speedup', 2000, FALSE),
  ('TRAIN_MASTERY_MANUAL', 'TRAIN_MASTERY_MANUAL', 'special_training', '熟练度手册', 'Mastery Manual', '技能熟练度经验 +20', 'Skill mastery +20', 'epic', 'mastery', 0, TRUE),
  ('TRAIN_GOLDEN_APPLE', 'TRAIN_GOLDEN_APPLE', 'special_training', '金苹果', 'Golden Apple', '特训成功率 +20%', 'Special training success +20%', 'legendary', 'training_success', 0, TRUE)
ON CONFLICT (id) DO NOTHING;
