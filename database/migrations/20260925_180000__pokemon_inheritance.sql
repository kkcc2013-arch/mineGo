-- Epic E07：精灵传承与属性遗产（REQ-00361）（幂等）
--
-- 与需求原稿的差异：user_id 为 UUID（users.id）、species_id 为 SMALLINT 并统一存家族根物种、
-- 精灵 ID 为 UUID；增加 refreshed_at（再次放生同家族精灵时重置有效期，衰减按它计算）与记录的传承率。

CREATE TABLE IF NOT EXISTS pokemon_inheritance_pool (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id              SMALLINT NOT NULL REFERENCES pokemon_species(id),
  source_pokemon_id       UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  source_nickname         VARCHAR(100),
  iv_attack_bonus         NUMERIC(5,2) NOT NULL DEFAULT 0,
  iv_defense_bonus        NUMERIC(5,2) NOT NULL DEFAULT 0,
  iv_hp_bonus             NUMERIC(5,2) NOT NULL DEFAULT 0,
  cp_base_bonus           INTEGER NOT NULL DEFAULT 0,
  inheritance_rate        NUMERIC(4,3) NOT NULL DEFAULT 0.05 CHECK (inheritance_rate BETWEEN 0 AND 1),
  inheritance_type        VARCHAR(20) NOT NULL DEFAULT 'normal',
  item_used               VARCHAR(50),
  inheritance_count       INTEGER NOT NULL DEFAULT 0,
  source_level            INTEGER,
  source_friendship_level INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refreshed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at            TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  UNIQUE (user_id, species_id)
);
CREATE INDEX IF NOT EXISTS idx_inheritance_pool_expires ON pokemon_inheritance_pool (expires_at);

CREATE TABLE IF NOT EXISTS pokemon_inheritance_records (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pool_id              BIGINT REFERENCES pokemon_inheritance_pool(id) ON DELETE SET NULL,
  source_pokemon_id    UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  target_pokemon_id    UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  species_id           SMALLINT NOT NULL,
  inherited_iv_attack  INTEGER NOT NULL DEFAULT 0,
  inherited_iv_defense INTEGER NOT NULL DEFAULT 0,
  inherited_iv_hp      INTEGER NOT NULL DEFAULT 0,
  inherited_cp_bonus   INTEGER NOT NULL DEFAULT 0,
  rate                 NUMERIC(4,3) NOT NULL DEFAULT 0,
  inheritance_type     VARCHAR(20) NOT NULL DEFAULT 'normal',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inheritance_records_user ON pokemon_inheritance_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inheritance_records_target ON pokemon_inheritance_records (target_pokemon_id);

INSERT INTO items (id, item_id, category, name_zh, name_en, description_zh, description_en, rarity, effect_type, effect_value, shop_price, is_premium)
VALUES
  ('LEGACY_STONE_NORMAL', 'LEGACY_STONE_NORMAL', 'legacy', '传承石', 'Legacy Stone', '放生精灵时使用，传承率 +10%', 'Inheritance rate +10% when releasing', 'uncommon', 'inheritance', 0.10, 100, FALSE),
  ('LEGACY_STONE_ADVANCED', 'LEGACY_STONE_ADVANCED', 'legacy', '高级传承石', 'Advanced Legacy Stone', '放生精灵时使用，传承率 +20%', 'Inheritance rate +20% when releasing', 'rare', 'inheritance', 0.20, 500, FALSE),
  ('LEGACY_STONE_PERFECT', 'LEGACY_STONE_PERFECT', 'legacy', '完美传承石', 'Perfect Legacy Stone', '放生精灵时使用，传承全部属性', 'Inherit all attributes when releasing', 'epic', 'inheritance', 1.00, 1000, TRUE)
ON CONFLICT (id) DO NOTHING;
