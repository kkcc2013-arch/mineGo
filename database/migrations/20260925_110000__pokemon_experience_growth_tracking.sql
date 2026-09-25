-- Epic E07：精灵经验动态调整（REQ-00216）与经验历史/成长轨迹（REQ-00230）（幂等）
--
-- pokemon_exp_history   每次经验变化一行（按月 RANGE 分区 + DEFAULT 分区；ensure_pokemon_exp_history_partitions()
--                       预建当月与后两个月分区，pokemon-service 每天调用一次）
-- pokemon_growth_stats  每只精灵每个游戏日一行的汇总（轨迹曲线、来源占比、报告的数据源）
-- pokemon_milestones    成长里程碑（等级/累计经验/进化），(精灵, 类型, 键) 唯一
-- pokemon_exp_boosts    玩家激活的经验加成（幸运蛋 30 分钟 ×2、经验卡 24 小时 ×1.5、永久经验卡 ×1.1）
-- 经验道具写入 items（category = 'growth'），库存走 player_inventory

CREATE TABLE IF NOT EXISTS pokemon_exp_history (
  id                  BIGSERIAL,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exp_amount          INTEGER NOT NULL CHECK (exp_amount <> 0),
  base_amount         INTEGER NOT NULL DEFAULT 0,
  multiplier          NUMERIC(8,3) NOT NULL DEFAULT 1,
  source_type         VARCHAR(50) NOT NULL,     -- catch / item / training_camp / special_training / transfer_in / transfer_out / battle / event / breeding
  source_id           VARCHAR(100),
  level_before        INTEGER NOT NULL,
  level_after         INTEGER NOT NULL,
  exp_before          INTEGER NOT NULL,
  exp_after           INTEGER NOT NULL,
  gained_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  location_lat        DOUBLE PRECISION,
  location_lng        DOUBLE PRECISION,
  location_name       VARCHAR(200),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, gained_at)
) PARTITION BY RANGE (gained_at);

CREATE TABLE IF NOT EXISTS pokemon_exp_history_default PARTITION OF pokemon_exp_history DEFAULT;

CREATE INDEX IF NOT EXISTS idx_exp_history_pokemon ON pokemon_exp_history (pokemon_instance_id, gained_at DESC);
CREATE INDEX IF NOT EXISTS idx_exp_history_user ON pokemon_exp_history (user_id, gained_at DESC);
CREATE INDEX IF NOT EXISTS idx_exp_history_source ON pokemon_exp_history (source_type, gained_at DESC);

-- 预建分区：当月起 months_ahead+1 个月（已存在则跳过；DEFAULT 分区里若已有该月数据则跳过，避免建分区失败）
CREATE OR REPLACE FUNCTION ensure_pokemon_exp_history_partitions(months_ahead INTEGER DEFAULT 2)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  m DATE := date_trunc('month', NOW())::date;
  i INTEGER;
  part TEXT;
  created INTEGER := 0;
BEGIN
  FOR i IN 0..months_ahead LOOP
    part := format('pokemon_exp_history_%s', to_char(m + make_interval(months => i), 'YYYY_MM'));
    IF to_regclass('public.' || part) IS NULL AND NOT EXISTS (
         SELECT 1 FROM pokemon_exp_history_default
          WHERE gained_at >= (m + make_interval(months => i)) AND gained_at < (m + make_interval(months => i + 1))) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF pokemon_exp_history FOR VALUES FROM (%L) TO (%L)',
                     part, (m + make_interval(months => i))::date, (m + make_interval(months => i + 1))::date);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

SELECT ensure_pokemon_exp_history_partitions(2);

CREATE TABLE IF NOT EXISTS pokemon_growth_stats (
  id                  BIGSERIAL PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat_date           DATE NOT NULL,
  total_exp_gained    INTEGER NOT NULL DEFAULT 0,
  exp_sources         JSONB NOT NULL DEFAULT '{}'::jsonb,
  level_ups           INTEGER NOT NULL DEFAULT 0,
  battles_count       INTEGER NOT NULL DEFAULT 0,
  cumulative_exp      INTEGER NOT NULL DEFAULT 0,
  current_level       INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pokemon_instance_id, stat_date)
);
CREATE INDEX IF NOT EXISTS idx_growth_stats_user_date ON pokemon_growth_stats (user_id, stat_date DESC);

CREATE TABLE IF NOT EXISTS pokemon_milestones (
  id                  BIGSERIAL PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone_type      VARCHAR(50) NOT NULL,   -- level_up / exp_total / evolution / awakening / first_exp
  milestone_key       VARCHAR(100) NOT NULL,  -- 如 'level:10'、'exp:100000'、'species:2'
  milestone_name      VARCHAR(200) NOT NULL,
  description         TEXT,
  achieved_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pokemon_instance_id, milestone_type, milestone_key)
);
CREATE INDEX IF NOT EXISTS idx_milestones_pokemon ON pokemon_milestones (pokemon_instance_id, achieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_milestones_user ON pokemon_milestones (user_id, achieved_at DESC);

CREATE TABLE IF NOT EXISTS pokemon_exp_boosts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  boost_type  VARCHAR(30) NOT NULL,          -- lucky_egg / exp_card / exp_card_permanent
  multiplier  NUMERIC(5,2) NOT NULL CHECK (multiplier >= 1),
  item_id     VARCHAR(50),
  expires_at  TIMESTAMPTZ,                   -- NULL = 永久
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exp_boosts_user_active ON pokemon_exp_boosts (user_id, boost_type, expires_at);

INSERT INTO items (id, item_id, category, name_zh, name_en, name_ja, description_zh, description_en, effect_type, effect_value, shop_price, is_premium)
VALUES
  ('EXP_CANDY_S', 'EXP_CANDY_S', 'growth', '经验糖果S', 'Exp. Candy S', 'けいけんアメS', '使用后精灵获得 1,000 经验', 'Gives a Pokémon 1,000 Exp.', 'pokemon_exp', 1000, 200, FALSE),
  ('EXP_CANDY_M', 'EXP_CANDY_M', 'growth', '经验糖果M', 'Exp. Candy M', 'けいけんアメM', '使用后精灵获得 5,000 经验', 'Gives a Pokémon 5,000 Exp.', 'pokemon_exp', 5000, 800, FALSE),
  ('EXP_CANDY_L', 'EXP_CANDY_L', 'growth', '经验糖果L', 'Exp. Candy L', 'けいけんアメL', '使用后精灵获得 20,000 经验', 'Gives a Pokémon 20,000 Exp.', 'pokemon_exp', 20000, 2500, FALSE),
  ('EXP_CARD_24H', 'EXP_CARD_24H', 'growth', '经验卡（24小时）', 'Exp. Card (24h)', '経験カード（24時間）', '24 小时内精灵获得的经验 ×1.5', 'Pokémon Exp. ×1.5 for 24 hours', 'exp_boost', 1.5, 1000, FALSE),
  ('EXP_CARD_PERMANENT', 'EXP_CARD_PERMANENT', 'growth', '永久经验卡', 'Permanent Exp. Card', '永久経験カード', '永久使精灵获得的经验 ×1.1（不可叠加）', 'Permanently Pokémon Exp. ×1.1 (not stackable)', 'exp_boost', 1.1, 0, TRUE)
ON CONFLICT (id) DO NOTHING;
