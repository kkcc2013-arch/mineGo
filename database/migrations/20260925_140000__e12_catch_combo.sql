-- migrate:up
-- REQ-00369：精灵捕捉连击奖励系统（catch-service src/combo/）
-- 依赖：users（V1）、items / player_inventory（20260609_124500 道具系统 + 20260925_030000 可堆叠背包）
-- 幂等：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING；可在全新库或已有库上重复执行。

-- 1) 玩家连击状态（每个玩家一行；user_id 即主键）
CREATE TABLE IF NOT EXISTS catch_combos (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_combo       INTEGER NOT NULL DEFAULT 0 CHECK (current_combo >= 0),
  max_combo           INTEGER NOT NULL DEFAULT 0 CHECK (max_combo >= 0),
  combo_started_at    TIMESTAMPTZ,
  last_catch_time     TIMESTAMPTZ,
  protection_charges  SMALLINT NOT NULL DEFAULT 0 CHECK (protection_charges >= 0),
  protected_until     TIMESTAMPTZ,
  pokemon_ids         UUID[] NOT NULL DEFAULT '{}',   -- 当前这段连击捕获的精灵实例（结束时写入历史）
  combo_rewards       JSONB NOT NULL DEFAULT '{}',    -- 当前这段连击累计发放的奖励
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catch_combos_max ON catch_combos (max_combo DESC);

-- 2) 连击历史（一段连击结束时写一行）
CREATE TABLE IF NOT EXISTS catch_combo_history (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  combo_count     INTEGER NOT NULL CHECK (combo_count > 0),
  pokemon_ids     UUID[] NOT NULL DEFAULT '{}',
  total_rewards   JSONB NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  end_reason      VARCHAR(20) NOT NULL CHECK (end_reason IN ('failed', 'timeout', 'manual_reset')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catch_combo_history_user ON catch_combo_history (user_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_catch_combo_history_combo ON catch_combo_history (combo_count DESC);

-- 3) 连击奖励档位（运营可通过 PUT /v1/catch/combo/rewards 调整；与 comboRules.DEFAULT_REWARD_TIERS 一致）
CREATE TABLE IF NOT EXISTS catch_combo_rewards (
  id                SERIAL PRIMARY KEY,
  combo_threshold   INTEGER NOT NULL UNIQUE CHECK (combo_threshold > 0),
  reward_type       VARCHAR(20) NOT NULL CHECK (reward_type IN ('experience', 'coins', 'premium', 'items')),
  reward_amount     INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  bonus_multiplier  NUMERIC(5,2) NOT NULL DEFAULT 1.0 CHECK (bonus_multiplier >= 0),
  special_rewards   JSONB NOT NULL DEFAULT '[]',  -- [{ "item": "LUCKY_EGG", "amount": 1 }]，到达该档位时发放一次
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO catch_combo_rewards (combo_threshold, reward_type, reward_amount, bonus_multiplier, special_rewards) VALUES
  (3,   'experience', 20,  1.0, '[]'),
  (5,   'experience', 50,  1.0, '[{"item":"POKE_BALL","amount":5}]'),
  (10,  'coins',      10,  1.2, '[{"item":"LUCKY_EGG","amount":1}]'),
  (20,  'coins',      20,  1.5, '[{"item":"RAZZ_BERRY","amount":3}]'),
  (25,  'coins',      25,  1.5, '[{"item":"COMBO_SHIELD","amount":1},{"item":"RARE_CANDY","amount":1}]'),
  (50,  'coins',      50,  2.0, '[{"item":"GOLDEN_RAZZ_BERRY","amount":3},{"item":"ULTRA_BALL","amount":5}]'),
  (100, 'coins',      100, 3.0, '[{"item":"LURE_MODULE","amount":1},{"item":"ULTRA_BALL","amount":10}]'),
  (200, 'premium',    5,   3.5, '[{"item":"STAR_PIECE","amount":2},{"item":"COMBO_SHIELD","amount":2}]'),
  (500, 'premium',    20,  4.0, '[{"item":"MASTER_BALL","amount":1},{"item":"STAR_PIECE","amount":5}]')
ON CONFLICT (combo_threshold) DO NOTHING;

-- 4) 连击事件（按捕捉会话去重：同一会话的成功/逃跑只计一次，重试/重复请求幂等）
--    session_id 不加外键：catch_sessions 可能被分区改造，且事件只用于去重与审计
CREATE TABLE IF NOT EXISTS catch_combo_events (
  session_id    UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type    VARCHAR(10) NOT NULL CHECK (event_type IN ('success', 'failure')),
  species_id    SMALLINT,
  combo_after   INTEGER,
  rewards       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catch_combo_events_user ON catch_combo_events (user_id, created_at DESC);

-- 5) 连击保护道具（与 20260609_124500 道具种子相同的列；item_id 由触发器/显式赋值）
INSERT INTO items (id, item_id, name, name_zh, name_en, name_ja, name_localized, description, description_zh, description_en,
                   category, rarity, max_stack, is_consumable, is_tradable, effect_data)
VALUES ('COMBO_SHIELD', 'COMBO_SHIELD', 'Combo Shield', '连击护符', 'Combo Shield', 'コンボシールド',
        '{"en": "Combo Shield", "zh": "连击护符", "ja": "コンボシールド"}',
        'Protects your catch combo from breaking once within 60 minutes.',
        '使用后 60 分钟内，精灵逃跑时连击不中断（抵消 1 次）。',
        'Protects your catch combo from breaking once within 60 minutes.',
        'special', 'rare', 99, true, false, '{"combo_protection": {"charges": 1, "minutes": 60}}')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE catch_combos IS 'REQ-00369 捕捉连击状态（每玩家一行）';
COMMENT ON TABLE catch_combo_history IS 'REQ-00369 连击历史（每段连击结束时写入）';
COMMENT ON TABLE catch_combo_rewards IS 'REQ-00369 连击奖励档位配置';
COMMENT ON TABLE catch_combo_events IS 'REQ-00369 连击事件（按捕捉会话幂等）';

-- migrate:down
DROP TABLE IF EXISTS catch_combo_events;
DROP TABLE IF EXISTS catch_combo_rewards;
DROP TABLE IF EXISTS catch_combo_history;
DROP TABLE IF EXISTS catch_combos;
DELETE FROM items WHERE id = 'COMBO_SHIELD' AND NOT EXISTS (SELECT 1 FROM player_inventory WHERE item_id = 'COMBO_SHIELD');
