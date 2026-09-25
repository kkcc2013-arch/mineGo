-- Epic E07：精灵觉醒与潜能激活（REQ-00245）（幂等）
--
-- 觉醒阶段/加成列在 20260925_100000 已加到 pokemon_instances（awakening_stage、awakening_bonuses）。
-- 觉醒材料是 items（AWAKENING_SHARD/STONE/ESSENCE），库存走 player_inventory，不另建 user_awakening_materials；
-- awakening_configs 只放按物种的覆盖配置（为空时使用代码里的默认 5 阶段配置，见 growth/awakeningRules.js）。

CREATE TABLE IF NOT EXISTS awakening_configs (
  id                    SERIAL PRIMARY KEY,
  pokemon_species_id    INTEGER,                    -- NULL = 默认
  awakening_stage       INTEGER NOT NULL CHECK (awakening_stage BETWEEN 1 AND 5),
  required_level        INTEGER,
  required_friendship   INTEGER,
  required_battles      INTEGER,
  required_materials    JSONB,                      -- [{"item_id": "AWAKENING_SHARD", "count": 10}]
  candy                 INTEGER,
  stardust              INTEGER,
  guaranteed_potentials INTEGER,
  max_potentials        INTEGER,
  skill_unlock          BOOLEAN,
  appearance_variant    VARCHAR(40),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_awakening_configs_species_stage
  ON awakening_configs (COALESCE(pokemon_species_id, 0), awakening_stage);

CREATE TABLE IF NOT EXISTS potentials (
  id              SERIAL PRIMARY KEY,
  name_key        VARCHAR(100) NOT NULL UNIQUE,
  name_zh         VARCHAR(100) NOT NULL,
  name_en         VARCHAR(100),
  name_ja         VARCHAR(100),
  description_zh  TEXT,
  description_en  TEXT,
  description_ja  TEXT,
  potential_type  VARCHAR(30) NOT NULL,          -- stat_boost / skill_enhance / special_effect
  effect_config   JSONB NOT NULL,                -- {"stat": "attackPct", "value": 0.05}
  rarity          VARCHAR(20) NOT NULL,
  weight          INTEGER NOT NULL DEFAULT 100 CHECK (weight >= 0),
  min_stage       INTEGER NOT NULL DEFAULT 1,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  icon_url        VARCHAR(500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_potentials_type ON potentials (potential_type);

CREATE TABLE IF NOT EXISTS pokemon_awakenings (
  id                   BIGSERIAL PRIMARY KEY,
  pokemon_instance_id  UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  awakening_stage      INTEGER NOT NULL CHECK (awakening_stage BETWEEN 1 AND 5),
  activated_potentials JSONB NOT NULL DEFAULT '[]'::jsonb,
  consumed_materials   JSONB NOT NULL DEFAULT '{}'::jsonb,
  rolled_attempts      INTEGER NOT NULL DEFAULT 0,
  awakening_date       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pokemon_instance_id, awakening_stage)
);
CREATE INDEX IF NOT EXISTS idx_pokemon_awakenings_user ON pokemon_awakenings (user_id);

INSERT INTO potentials (name_key, name_zh, name_en, name_ja, description_zh, description_en, description_ja, potential_type, effect_config, rarity, weight, min_stage)
VALUES
  ('potential.power_1', '力量觉醒', 'Power Awakening', 'ちからの覚醒', '攻击 +5%', 'Attack +5%', 'こうげき +5%', 'stat_boost', '{"stat": "attackPct", "value": 0.05}', 'common', 100, 1),
  ('potential.guard_1', '坚韧觉醒', 'Guard Awakening', 'まもりの覚醒', '防御 +5%', 'Defense +5%', 'ぼうぎょ +5%', 'stat_boost', '{"stat": "defensePct", "value": 0.05}', 'common', 100, 1),
  ('potential.vital_1', '活力觉醒', 'Vitality Awakening', 'いのちの覚醒', 'HP +5%', 'HP +5%', 'HP +5%', 'stat_boost', '{"stat": "hpPct", "value": 0.05}', 'common', 100, 1),
  ('potential.keen', '锐利', 'Keen Eye', 'するどいめ', '暴击率 +3%', 'Critical rate +3%', '急所率 +3%', 'stat_boost', '{"stat": "critRate", "value": 0.03}', 'rare', 50, 1),
  ('potential.agile', '灵巧', 'Agility', 'みがるさ', '闪避率 +2%', 'Dodge rate +2%', '回避率 +2%', 'stat_boost', '{"stat": "dodgeRate", "value": 0.02}', 'rare', 50, 1),
  ('potential.power_2', '力量觉醒 II', 'Power Awakening II', 'ちからの覚醒 II', '攻击 +10%', 'Attack +10%', 'こうげき +10%', 'stat_boost', '{"stat": "attackPct", "value": 0.10}', 'rare', 40, 2),
  ('potential.guard_2', '坚韧觉醒 II', 'Guard Awakening II', 'まもりの覚醒 II', '防御 +10%', 'Defense +10%', 'ぼうぎょ +10%', 'stat_boost', '{"stat": "defensePct", "value": 0.10}', 'rare', 40, 2),
  ('potential.vital_2', '活力觉醒 II', 'Vitality Awakening II', 'いのちの覚醒 II', 'HP +10%', 'HP +10%', 'HP +10%', 'stat_boost', '{"stat": "hpPct", "value": 0.10}', 'rare', 40, 2),
  ('potential.skill', '技能强化', 'Skill Boost', 'わざ強化', '技能威力 +8%', 'Move power +8%', 'わざの威力 +8%', 'skill_enhance', '{"stat": "skillPowerPct", "value": 0.08}', 'epic', 25, 2),
  ('potential.aura', '治愈光环', 'Healing Aura', 'いやしのオーラ', '每回合回复少量 HP', 'Restores a little HP each turn', '毎ターンHPを少し回復', 'special_effect', '{"effect": "aura_heal", "value": 0.03}', 'epic', 20, 3),
  ('potential.king', '王者之力', 'Might of Kings', '王者の力', '攻击 +20%', 'Attack +20%', 'こうげき +20%', 'stat_boost', '{"stat": "attackPct", "value": 0.20}', 'legendary', 8, 4),
  ('potential.fortress', '不屈', 'Unyielding', 'ふくつ', '防御 +20%', 'Defense +20%', 'ぼうぎょ +20%', 'stat_boost', '{"stat": "defensePct", "value": 0.20}', 'legendary', 8, 4)
ON CONFLICT (name_key) DO NOTHING;

INSERT INTO items (id, item_id, category, name_zh, name_en, name_ja, description_zh, description_en, rarity, effect_type, shop_price, is_premium)
VALUES
  ('AWAKENING_SHARD', 'AWAKENING_SHARD', 'awakening', '觉醒碎片', 'Awakening Shard', '覚醒のかけら', '觉醒所需材料，训练营训练可获得', 'Awakening material, dropped by training camps', 'common', 'awakening_material', 100, FALSE),
  ('AWAKENING_STONE', 'AWAKENING_STONE', 'awakening', '觉醒石', 'Awakening Stone', '覚醒石', '第 2 阶段起的觉醒材料', 'Awakening material for stage 2+', 'rare', 'awakening_material', 1500, FALSE),
  ('AWAKENING_ESSENCE', 'AWAKENING_ESSENCE', 'awakening', '觉醒精华', 'Awakening Essence', '覚醒のエッセンス', '高阶觉醒与重洗潜能所需', 'Needed for high stages and potential rerolls', 'epic', 'awakening_material', 5000, FALSE)
ON CONFLICT (id) DO NOTHING;
