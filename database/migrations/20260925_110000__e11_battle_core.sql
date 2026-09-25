-- migrate:up
-- E11 战斗与技能：道馆对战 / 团战 / 技能冷却能量 / 连击 / 伤害缓存 / 技能推荐 / AI 助手 / 回放分享 / 竞技联赛 / 客户端帧率上报
-- 全部 IF NOT EXISTS，可在全新库与已有库上重复执行。

-- ============================================================
-- 1. 道馆对战记录（V1 gym_battles 基础上补列）
-- ============================================================
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS defenders_defeated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS defenders_total    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS attacker_pokemon_ids UUID[];
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS stardust_gained   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS combos_triggered  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS replay_id         INTEGER;
CREATE INDEX IF NOT EXISTS idx_gym_battles_attacker_time ON gym_battles (attacker_id, battled_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_battles_gym_time ON gym_battles (gym_id, battled_at DESC);

-- ============================================================
-- 2. 团战：参与者队伍、能量、奖励
-- ============================================================
ALTER TABLE raid_participants ADD COLUMN IF NOT EXISTS team_pokemon_ids  UUID[];
ALTER TABLE raid_participants ADD COLUMN IF NOT EXISTS active_pokemon_id UUID;
ALTER TABLE raid_participants ADD COLUMN IF NOT EXISTS attacks           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE raid_participants ADD COLUMN IF NOT EXISTS last_attack_at    TIMESTAMPTZ;
ALTER TABLE raid_participants ADD COLUMN IF NOT EXISTS xp_reward         INTEGER;
ALTER TABLE raid_participants ADD COLUMN IF NOT EXISTS stardust_reward   INTEGER;
ALTER TABLE raid_participants ADD COLUMN IF NOT EXISTS rewarded_at       TIMESTAMPTZ;
ALTER TABLE raids ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE raids ADD COLUMN IF NOT EXISTS settled_at   TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_raids_active_window ON raids (status, ends_at);
CREATE INDEX IF NOT EXISTS idx_raid_participants_user ON raid_participants (user_id, joined_at DESC);

-- ============================================================
-- 3. 技能熟练度（REQ-00299 熟练度 0-100 → 冷却缩减 0-15%）
-- ============================================================
CREATE TABLE IF NOT EXISTS pokemon_move_mastery (
  pokemon_id  UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  move_id     VARCHAR(50) NOT NULL,
  mastery     SMALLINT NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 100),
  uses        INTEGER NOT NULL DEFAULT 0,
  combos      INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pokemon_id, move_id)
);

-- ============================================================
-- 4. 冷却装备（REQ-00299 宝石/符文/神器，REQ-00311 装备加成上限 30%）
-- ============================================================
CREATE TABLE IF NOT EXISTS cooldown_equipment_catalog (
  id             VARCHAR(40) PRIMARY KEY,
  name_zh        VARCHAR(50) NOT NULL,
  equip_type     VARCHAR(10) NOT NULL CHECK (equip_type IN ('gem', 'rune', 'artifact')),
  reduction_pct  NUMERIC(5,2) NOT NULL CHECK (reduction_pct > 0 AND reduction_pct <= 30),
  applies_to     VARCHAR(10) NOT NULL DEFAULT 'ALL' CHECK (applies_to IN ('ALL', 'FAST', 'CHARGE')),
  move_type      VARCHAR(20),                 -- 仅对该属性技能生效（NULL = 全部属性）
  description_zh TEXT
);

INSERT INTO cooldown_equipment_catalog (id, name_zh, equip_type, reduction_pct, applies_to, move_type, description_zh) VALUES
  ('GEM_SWIFT',        '迅捷宝石',   'gem',      5,  'ALL',    NULL,       '全部技能冷却 -5%'),
  ('GEM_FLAME',        '火焰宝石',   'gem',      10, 'ALL',    'FIRE',     '火属性技能冷却 -10%'),
  ('GEM_TIDE',         '潮汐宝石',   'gem',      10, 'ALL',    'WATER',    '水属性技能冷却 -10%'),
  ('GEM_VOLT',         '雷霆宝石',   'gem',      10, 'ALL',    'ELECTRIC', '电属性技能冷却 -10%'),
  ('RUNE_FOCUS',       '专注符文',   'rune',     10, 'CHARGE', NULL,       '蓄力技能冷却 -10%'),
  ('RUNE_TEMPO',       '节奏符文',   'rune',     8,  'FAST',   NULL,       '快速技能冷却 -8%'),
  ('ARTIFACT_CHRONO',  '时之神器',   'artifact', 15, 'ALL',    NULL,       '全部技能冷却 -15%'),
  ('ARTIFACT_STORM',   '风暴神器',   'artifact', 20, 'CHARGE', NULL,       '蓄力技能冷却 -20%')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_cooldown_equipment (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  equipment_id  VARCHAR(40) NOT NULL REFERENCES cooldown_equipment_catalog(id),
  pokemon_id    UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  source        VARCHAR(30) NOT NULL DEFAULT 'reward',
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  equipped_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_cd_equipment_user ON user_cooldown_equipment (user_id);
CREATE INDEX IF NOT EXISTS idx_user_cd_equipment_pokemon ON user_cooldown_equipment (pokemon_id) WHERE pokemon_id IS NOT NULL;

-- ============================================================
-- 5. 连击链：禁用引用不存在技能的种子，补充基于现有技能表的连击链（REQ-00364 ≥ 20 种）
-- ============================================================
ALTER TABLE combo_chains ADD COLUMN IF NOT EXISTS chain_cooldown_turns INTEGER NOT NULL DEFAULT 3;

UPDATE combo_chains c SET is_active = FALSE, updated_at = NOW()
 WHERE c.is_active
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(c.trigger_sequence) s(move_id)
      WHERE NOT EXISTS (SELECT 1 FROM moves m WHERE m.id = s.move_id)
   );

INSERT INTO combo_chains (chain_id, name, description, trigger_sequence, time_window_ms, element_requirement,
                          damage_multiplier, bonus_effects, cooldown_reduction, combo_points, xp_bonus,
                          min_trainer_level, required_badges, is_active) VALUES
  ('TACKLE_RUSH',     '冲撞三连',   '连续三次撞击，入门连击',               '["TACKLE","TACKLE","TACKLE"]',                    3000, NULL,       1.20, '{}',                                      5,  1, 20,  1, 0, TRUE),
  ('QUICK_STRIKE',    '疾风破坏',   '电光一闪两次后接破坏光线',             '["QUICK_ATTACK","QUICK_ATTACK","HYPER_BEAM"]',     6000, NULL,       1.60, '{"damage_boost": 10}',                    10, 3, 60,  3, 0, TRUE),
  ('EMBER_BURST',     '火花爆燃',   '火花两次后接喷射火焰，必定灼伤',       '["EMBER","EMBER","FLAMETHROWER"]',                 5000, 'fire',     1.50, '{"status": "BURN"}',                      10, 2, 50,  1, 0, TRUE),
  ('SPIRAL_FLAME',    '螺旋烈焰',   '火焰旋涡两次后接大字爆炎',             '["FIRE_SPIN","FIRE_SPIN","FIRE_BLAST"]',           6000, 'fire',     1.80, '{"status": "BURN", "ignore_defense": 10}', 15, 3, 80,  5, 0, TRUE),
  ('TIDAL_WAVE',      '怒涛',       '水枪两次后接水炮',                     '["WATER_GUN","WATER_GUN","HYDRO_PUMP"]',           5500, 'water',    1.60, '{"energy_refund": 10}',                   10, 2, 60,  1, 0, TRUE),
  ('BUBBLE_SURF',     '泡沫冲浪',   '泡沫两次后接冲浪',                     '["BUBBLE","BUBBLE","SURF"]',                       5000, 'water',    1.50, '{"heal_pct": 5}',                         10, 2, 50,  1, 0, TRUE),
  ('WATERFALL_RUSH',  '瀑布冲击',   '攀瀑两次后接水炮',                     '["WATERFALL","WATERFALL","HYDRO_PUMP"]',           6000, 'water',    1.70, '{"damage_boost": 10}',                    15, 3, 70,  5, 0, TRUE),
  ('VOLT_CHAIN',      '伏特连锁',   '电击两次后接十万伏特，必定麻痹',       '["THUNDER_SHOCK","THUNDER_SHOCK","THUNDERBOLT"]',  5000, 'electric', 1.60, '{"status": "STUN"}',                      10, 2, 60,  1, 0, TRUE),
  ('SPARK_STORM',     '电火风暴',   '电火花两次后接放电',                   '["SPARK","SPARK","DISCHARGE"]',                    5000, 'electric', 1.50, '{"status": "STUN"}',                      10, 2, 50,  1, 0, TRUE),
  ('THUNDER_GOD',     '雷神降临',   '电击、十万伏特、打雷三段雷击',         '["THUNDER_SHOCK","THUNDERBOLT","THUNDER"]',        7000, 'electric', 2.20, '{"status": "STUN", "crit_rate_boost": 25}', 20, 5, 150, 10, 0, TRUE),
  ('LEAF_STORM',      '叶暴',       '藤鞭两次后接阳光烈焰',                 '["VINE_WHIP","VINE_WHIP","SOLAR_BEAM"]',           6000, 'grass',    1.80, '{"heal_pct": 10}',                        15, 3, 80,  5, 0, TRUE),
  ('RAZOR_BLOOM',     '飞叶绽放',   '飞叶快刀两次后接能量球',               '["RAZOR_LEAF","RAZOR_LEAF","ENERGY_BALL"]',        5000, 'grass',    1.50, '{"damage_boost": 10}',                    10, 2, 50,  1, 0, TRUE),
  ('FROST_LOCK',      '冰封',       '冰冻之风两次后接冰冻光束，必定冰冻',   '["FROST_BREATH","FROST_BREATH","ICE_BEAM"]',       5500, 'ice',      1.60, '{"status": "FREEZE"}',                    10, 3, 60,  3, 0, TRUE),
  ('SHARD_BLIZZARD',  '冰晶风暴',   '冰砾两次后接暴风雪',                   '["ICE_SHARD","ICE_SHARD","BLIZZARD"]',             6500, 'ice',      1.90, '{"status": "FREEZE"}',                    15, 4, 90,  8, 0, TRUE),
  ('MIND_BREAK',      '精神崩溃',   '念力两次后接精神强念，必定混乱',       '["CONFUSION","CONFUSION","PSYCHIC"]',              5500, 'psychic',  1.60, '{"status": "CONFUSE"}',                   10, 3, 60,  3, 0, TRUE),
  ('SHADOW_DANCE',    '暗影之舞',   '暗影爪、祸不单行后接暗影球',           '["SHADOW_CLAW","HEX","SHADOW_BALL"]',              5500, 'ghost',    1.70, '{"ignore_defense": 15}',                  15, 3, 70,  5, 0, TRUE),
  ('NIGHT_FANG',      '暗夜獠牙',   '咬住两次后接咬碎',                     '["BITE","BITE","CRUNCH"]',                         5000, 'dark',     1.50, '{"status": "STUN"}',                      10, 2, 50,  1, 0, TRUE),
  ('DARK_AMBUSH',     '暗影伏击',   '突袭两次后接恶之波动',                 '["FEINT_ATTACK","FEINT_ATTACK","DARK_PULSE"]',     5000, 'dark',     1.50, '{"crit_rate_boost": 20}',                 10, 2, 50,  3, 0, TRUE),
  ('ROCK_AVALANCHE',  '岩崩连击',   '落石两次后接尖石攻击',                 '["ROCK_THROW","ROCK_THROW","STONE_EDGE"]',         6000, 'rock',     1.70, '{"crit_rate_boost": 20}',                 15, 3, 70,  5, 0, TRUE),
  ('IRON_WILL',       '钢铁意志',   '金属爪两次后接铁头',                   '["METAL_CLAW","METAL_CLAW","IRON_HEAD"]',          5000, 'steel',    1.50, '{"status": "STUN"}',                      10, 2, 50,  3, 0, TRUE),
  ('TOXIC_STRIKE',    '剧毒突袭',   '毒击两次后接污泥炸弹，必定中毒',       '["POISON_JAB","POISON_JAB","SLUDGE_BOMB"]',        5000, 'poison',   1.50, '{"status": "POISON"}',                    10, 2, 50,  3, 0, TRUE),
  ('MARTIAL_FLURRY',  '格斗连打',   '空手劈、碎岩后接近身战',               '["KARATE_CHOP","ROCK_SMASH","CLOSE_COMBAT"]',      5500, 'fighting', 1.80, '{"ignore_defense": 20}',                  15, 4, 80,  8, 0, TRUE),
  ('DRAGON_FANG',     '龙牙',       '龙息两次后接龙爪',                     '["DRAGON_BREATH","DRAGON_BREATH","DRAGON_CLAW"]',  5000, 'dragon',   1.60, '{"damage_boost": 15}',                    10, 3, 60,  5, 0, TRUE)
ON CONFLICT (chain_id) DO NOTHING;

-- 自定义连招预设（REQ-00143：每只精灵最多 5 套，每套 2-5 步，由服务层校验）
CREATE TABLE IF NOT EXISTS pokemon_skill_combos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pokemon_id    UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  name          VARCHAR(30) NOT NULL,
  steps         JSONB NOT NULL,               -- [{moveId, delayMs, condition}]
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  uses          INTEGER NOT NULL DEFAULT 0,
  completions   INTEGER NOT NULL DEFAULT 0,
  combos_triggered INTEGER NOT NULL DEFAULT 0,
  total_damage  BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_skill_combos_owner ON pokemon_skill_combos (user_id, pokemon_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_combos_default ON pokemon_skill_combos (pokemon_id) WHERE is_default;

ALTER TABLE user_combo_stats ADD COLUMN IF NOT EXISTS total_points INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_combo_records_user_time ON combo_records (user_id, executed_at DESC);

-- ============================================================
-- 6. 战斗技能使用日志（REQ-00324 推荐数据来源）与推荐聚合
-- ============================================================
CREATE TABLE IF NOT EXISTS battle_move_logs (
  id            BIGSERIAL PRIMARY KEY,
  battle_id     UUID NOT NULL,
  battle_type   VARCHAR(20) NOT NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  pokemon_id    UUID,
  species_id    SMALLINT,
  fast_move     VARCHAR(50),
  charge_move   VARCHAR(50),
  move_id       VARCHAR(50) NOT NULL,
  damage        INTEGER NOT NULL DEFAULT 0,
  effectiveness NUMERIC(4,2),
  is_crit       BOOLEAN NOT NULL DEFAULT FALSE,
  combo_chain   VARCHAR(50),
  result        VARCHAR(10),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_battle_move_logs_species ON battle_move_logs (species_id, move_id);
CREATE INDEX IF NOT EXISTS idx_battle_move_logs_time ON battle_move_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_battle_move_logs_battle ON battle_move_logs (battle_id);

CREATE TABLE IF NOT EXISTS move_recommendation_stats (
  species_id   SMALLINT NOT NULL,
  fast_move    VARCHAR(50) NOT NULL,
  charge_move  VARCHAR(50) NOT NULL,
  scenario     VARCHAR(20) NOT NULL,
  battles      INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  avg_damage   NUMERIC(10,2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (species_id, fast_move, charge_move, scenario)
);

CREATE TABLE IF NOT EXISTS move_recommendation_preferences (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  scenario     VARCHAR(20) NOT NULL DEFAULT 'pve',
  style        VARCHAR(20) NOT NULL DEFAULT 'balanced' CHECK (style IN ('balanced', 'dps', 'tank', 'energy')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 7. AI 策略助手（REQ-00357 / REQ-00365）
-- ============================================================
CREATE TABLE IF NOT EXISTS battle_ai_advice_logs (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  battle_id           UUID,
  advice_type         VARCHAR(20) NOT NULL,          -- move / lineup / predict / review
  variant             VARCHAR(10) NOT NULL DEFAULT 'A',
  turn                INTEGER,
  recommended_action  JSONB,
  predicted_win_prob  NUMERIC(5,4),
  actual_result       VARCHAR(10),
  followed            BOOLEAN,
  helpful             BOOLEAN,
  latency_ms          INTEGER,
  cache_hit           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_advice_user_time ON battle_ai_advice_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_advice_battle ON battle_ai_advice_logs (battle_id);
CREATE INDEX IF NOT EXISTS idx_ai_advice_variant ON battle_ai_advice_logs (variant, advice_type, created_at);

CREATE TABLE IF NOT EXISTS battle_ai_preferences (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  newbie_mode  BOOLEAN NOT NULL DEFAULT TRUE,
  auto_advice  BOOLEAN NOT NULL DEFAULT TRUE,
  style        VARCHAR(20) NOT NULL DEFAULT 'balanced' CHECK (style IN ('balanced', 'aggressive', 'defensive')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS battle_ai_reviews (
  battle_id    UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  battle_type  VARCHAR(20) NOT NULL,
  result       VARCHAR(10) NOT NULL,
  score        INTEGER NOT NULL,
  review       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_user ON battle_ai_reviews (user_id, created_at DESC);

-- ============================================================
-- 8. 回放分享补列（REQ-00379 / REQ-00469）
-- ============================================================
ALTER TABLE battle_replay_records ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE battle_replay_records ADD COLUMN IF NOT EXISTS participant_user_ids UUID[];
ALTER TABLE battle_replay_records ADD COLUMN IF NOT EXISTS species_ids SMALLINT[];
ALTER TABLE battle_replay_records ADD COLUMN IF NOT EXISTS summary JSONB;
ALTER TABLE battle_replay_records ADD COLUMN IF NOT EXISTS compressed_data BYTEA;
ALTER TABLE battle_replay_records ALTER COLUMN gym_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_replay_records_participants ON battle_replay_records USING GIN (participant_user_ids);
CREATE INDEX IF NOT EXISTS idx_replay_records_species ON battle_replay_records USING GIN (species_ids);
CREATE INDEX IF NOT EXISTS idx_replay_records_hot ON battle_replay_records (is_public, view_count DESC, like_count DESC);
ALTER TABLE replay_highlights ADD COLUMN IF NOT EXISTS severity VARCHAR(10) NOT NULL DEFAULT 'medium';

-- ============================================================
-- 9. 竞技联赛（REQ-00487）：league_matches 玩家列原为 INTEGER，无法引用 UUID 用户
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'league_matches' AND column_name = 'player1_id' AND data_type = 'integer') THEN
    -- 该表此前没有任何写入路径（服务未接入），整数玩家 ID 无意义，直接改为 UUID
    ALTER TABLE league_matches ALTER COLUMN player1_id DROP NOT NULL;
    ALTER TABLE league_matches ALTER COLUMN player2_id DROP NOT NULL;
    ALTER TABLE league_matches ALTER COLUMN player1_id TYPE UUID USING NULL;
    ALTER TABLE league_matches ALTER COLUMN player2_id TYPE UUID USING NULL;
    ALTER TABLE league_matches ALTER COLUMN winner_id  TYPE UUID USING NULL;
  END IF;
END $$;
ALTER TABLE league_matches ADD COLUMN IF NOT EXISTS battle_id UUID;
ALTER TABLE league_matches ADD COLUMN IF NOT EXISTS opponent_type VARCHAR(10) NOT NULL DEFAULT 'player';
ALTER TABLE league_matches ADD COLUMN IF NOT EXISTS player1_rating_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE league_matches ADD COLUMN IF NOT EXISTS player2_rating_change INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_league_matches_battle ON league_matches (battle_id) WHERE battle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_league_matches_p1 ON league_matches (player1_id, match_time DESC);
CREATE INDEX IF NOT EXISTS idx_league_matches_p2 ON league_matches (player2_id, match_time DESC);
ALTER TABLE league_members ADD COLUMN IF NOT EXISTS best_consecutive_wins INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_league_members_rank ON league_members (season_id, league_level, league_group, league_points DESC);
ALTER TABLE league_rewards ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(80);
CREATE UNIQUE INDEX IF NOT EXISTS uq_league_rewards_dedupe ON league_rewards (player_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ============================================================
-- 10. 客户端战斗帧率上报（REQ-00325）
-- ============================================================
CREATE TABLE IF NOT EXISTS client_battle_perf_reports (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  battle_id        UUID,
  device_tier      VARCHAR(10) NOT NULL CHECK (device_tier IN ('low', 'mid', 'high')),
  device_memory_gb NUMERIC(5,2),
  cpu_cores        SMALLINT,
  target_fps       SMALLINT NOT NULL,
  avg_fps          NUMERIC(6,2) NOT NULL,
  p5_fps           NUMERIC(6,2),
  dropped_frames   INTEGER NOT NULL DEFAULT 0,
  effects_level    VARCHAR(10),
  degrade_events   INTEGER NOT NULL DEFAULT 0,
  network_rtt_ms   INTEGER,
  js_heap_mb       NUMERIC(8,2),
  user_agent       VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_perf_time ON client_battle_perf_reports (created_at);
CREATE INDEX IF NOT EXISTS idx_client_perf_tier ON client_battle_perf_reports (device_tier, created_at);

-- ============================================================
-- 11. 战斗相关表的时间列统一为 TIMESTAMPTZ
--     （与 20260925_050000__core_timestamps_to_timestamptz 一致：服务端按时间做能量回复、分享过期、
--      赛季起止判断，TIMESTAMP 在数据库与 Node 时区不一致时会偏移）
-- ============================================================
DO $e11tz$
DECLARE
  tbls TEXT[] := ARRAY[
    'raids', 'league_seasons', 'league_members', 'league_matches', 'league_history', 'league_rewards',
    'battle_replay_records', 'replay_highlights', 'replay_shares', 'replay_likes', 'replay_comments',
    'combo_chains', 'combo_records', 'user_combo_stats', 'pokemon_energy', 'battle_energy_state', 'energy_regen_rules'];
  tz TEXT := current_setting('TimeZone');
  c RECORD;
BEGIN
  FOR c IN
    SELECT col.table_name, col.column_name
      FROM information_schema.columns col
      JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE col.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND col.table_name = ANY(tbls)
       AND col.data_type = 'timestamp without time zone'
     ORDER BY col.table_name, col.column_name
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE %L',
                     c.table_name, c.column_name, c.column_name, tz);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '跳过 %.%：%', c.table_name, c.column_name, SQLERRM;
    END;
  END LOOP;
END $e11tz$;
