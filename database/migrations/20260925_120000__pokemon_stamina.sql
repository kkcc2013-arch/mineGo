-- Epic E07：精灵体力与疲劳（REQ-00172）（幂等）
--
-- 体力列在 pokemon_instances（20260616_070000 已加，这里兜底）；恢复道具统一走 player_inventory：
-- stamina_recovery_items 增加 item_code 对应 items.item_id；休息站复用 recovery_stations，休息记录 rest_records。

ALTER TABLE pokemon_instances
  ADD COLUMN IF NOT EXISTS max_stamina INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS current_stamina INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS last_stamina_update TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS fatigue_level VARCHAR(20) NOT NULL DEFAULT 'fresh';

CREATE TABLE IF NOT EXISTS stamina_config (
  id SERIAL PRIMARY KEY,
  activity_type VARCHAR(50) NOT NULL,
  stamina_cost INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
DELETE FROM stamina_config a USING stamina_config b WHERE a.activity_type = b.activity_type AND a.id > b.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stamina_config_activity ON stamina_config (activity_type);
INSERT INTO stamina_config (activity_type, stamina_cost, description) VALUES
  ('battle_turn', 5, '每次战斗回合消耗'),
  ('gym_battle', 20, '道馆战斗消耗'),
  ('training', 15, '训练营训练消耗'),
  ('special_training', 20, '专项特训消耗'),
  ('pvp_battle', 25, 'PVP对战消耗'),
  ('team_battle', 30, '团队战斗消耗')
ON CONFLICT (activity_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS stamina_history (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  pokemon_id UUID NOT NULL,
  activity_type VARCHAR(50) NOT NULL,
  stamina_change INTEGER NOT NULL,
  stamina_before INTEGER NOT NULL,
  stamina_after INTEGER NOT NULL,
  source VARCHAR(50) DEFAULT 'activity',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stamina_history_pokemon_time ON stamina_history (pokemon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stamina_history_pokemon_source ON stamina_history (pokemon_id, source, created_at DESC);

CREATE TABLE IF NOT EXISTS stamina_recovery_items (
  id SERIAL PRIMARY KEY,
  item_name VARCHAR(100) NOT NULL,
  stamina_amount INTEGER NOT NULL,
  cooldown_seconds INTEGER DEFAULT 0,
  rarity VARCHAR(20) DEFAULT 'common',
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE stamina_recovery_items ADD COLUMN IF NOT EXISTS item_code VARCHAR(50);

INSERT INTO items (id, item_id, category, name_zh, name_en, description_zh, description_en, effect_type, effect_value, shop_price, is_premium)
VALUES
  ('STAMINA_POTION_S', 'STAMINA_POTION_S', 'stamina', '体力药水(小)', 'Stamina Potion S', '恢复 20 点体力', 'Restores 20 stamina', 'stamina', 20, 100, FALSE),
  ('STAMINA_POTION_M', 'STAMINA_POTION_M', 'stamina', '体力药水(中)', 'Stamina Potion M', '恢复 50 点体力', 'Restores 50 stamina', 'stamina', 50, 220, FALSE),
  ('STAMINA_POTION_L', 'STAMINA_POTION_L', 'stamina', '体力药水(大)', 'Stamina Potion L', '恢复 100 点体力', 'Restores 100 stamina', 'stamina', 100, 400, FALSE),
  ('STAMINA_ENERGY_DRINK', 'STAMINA_ENERGY_DRINK', 'stamina', '能量饮料', 'Energy Drink', '恢复 30 点体力，5 分钟冷却', 'Restores 30 stamina (5 min cooldown)', 'stamina', 30, 80, FALSE),
  ('STAMINA_ENERGY_BLOCK', 'STAMINA_ENERGY_BLOCK', 'stamina', '精灵能量块', 'Energy Block', '恢复 80 点体力，10 分钟冷却', 'Restores 80 stamina (10 min cooldown)', 'stamina', 80, 250, FALSE),
  ('STAMINA_MYSTERY_CANDY', 'STAMINA_MYSTERY_CANDY', 'stamina', '神秘糖果', 'Mystery Candy', '恢复 150 点体力，1 小时冷却', 'Restores 150 stamina (1 h cooldown)', 'stamina', 150, 0, TRUE)
ON CONFLICT (id) DO NOTHING;

UPDATE stamina_recovery_items s SET item_code = v.code FROM (VALUES
  ('体力药水(小)', 'STAMINA_POTION_S'), ('体力药水(中)', 'STAMINA_POTION_M'), ('体力药水(大)', 'STAMINA_POTION_L'),
  ('能量饮料', 'STAMINA_ENERGY_DRINK'), ('精灵能量块', 'STAMINA_ENERGY_BLOCK'), ('神秘糖果', 'STAMINA_MYSTERY_CANDY')
) AS v(name, code)
WHERE s.item_name = v.name AND s.item_code IS NULL
  -- 同名多行（种子重复执行）时只给 id 最小的一行编码，保证下面的唯一索引可建
  AND s.id = (SELECT MIN(x.id) FROM stamina_recovery_items x WHERE x.item_name = v.name)
  AND NOT EXISTS (SELECT 1 FROM stamina_recovery_items y WHERE y.item_code = v.code);

INSERT INTO stamina_recovery_items (item_name, stamina_amount, cooldown_seconds, rarity, description, item_code)
SELECT v.name, v.amount, v.cd, v.rarity, v.descr, v.code FROM (VALUES
  ('体力药水(小)', 20, 0, 'common', '恢复20点体力', 'STAMINA_POTION_S'),
  ('体力药水(中)', 50, 0, 'uncommon', '恢复50点体力', 'STAMINA_POTION_M'),
  ('体力药水(大)', 100, 0, 'rare', '恢复100点体力', 'STAMINA_POTION_L'),
  ('能量饮料', 30, 300, 'common', '恢复30点体力，5分钟冷却', 'STAMINA_ENERGY_DRINK'),
  ('精灵能量块', 80, 600, 'uncommon', '恢复80点体力，10分钟冷却', 'STAMINA_ENERGY_BLOCK'),
  ('神秘糖果', 150, 3600, 'epic', '恢复150点体力，1小时冷却', 'STAMINA_MYSTERY_CANDY')
) AS v(name, amount, cd, rarity, descr, code)
WHERE NOT EXISTS (SELECT 1 FROM stamina_recovery_items s WHERE s.item_code = v.code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stamina_recovery_items_code ON stamina_recovery_items (item_code) WHERE item_code IS NOT NULL;

-- 休息记录（休息站 = recovery_stations）
CREATE TABLE IF NOT EXISTS rest_records (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pokemon_id        UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  station_id        INTEGER NOT NULL,
  rate_multiplier   NUMERIC(4,2) NOT NULL DEFAULT 1,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  stamina_recovered INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rest_records_active ON rest_records (pokemon_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rest_records_user ON rest_records (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_instances_stamina_due ON pokemon_instances (last_stamina_update) WHERE current_stamina < max_stamina;
