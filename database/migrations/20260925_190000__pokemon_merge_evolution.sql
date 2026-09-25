-- Epic E07：精灵合并进化（REQ-00390）（幂等）
--
-- 与需求原稿的差异：user_id 为 UUID、精灵实例 ID 为 UUID；合并即时完成（merge_queue 表保留结构但当前未使用，
-- 配方 duration_seconds 为 0）；记录里保存本次成功率。

CREATE TABLE IF NOT EXISTS merge_recipes (
  id                    SERIAL PRIMARY KEY,
  recipe_code           VARCHAR(50) UNIQUE NOT NULL,
  name_i18n             JSONB NOT NULL,
  description_i18n      JSONB,
  required_pokemon      JSONB NOT NULL,          -- [{"species_id": 1, "min_level": 5, "count": 3}]
  required_items        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{"item_id": "THUNDER_STONE", "count": 1}]
  output_pokemon_id     SMALLINT NOT NULL REFERENCES pokemon_species(id),
  output_min_level      INTEGER NOT NULL DEFAULT 1,
  output_level_variance INTEGER NOT NULL DEFAULT 5,
  base_success_rate     NUMERIC(5,2) NOT NULL DEFAULT 70.00,
  variant_pokemon_id    SMALLINT REFERENCES pokemon_species(id),
  variant_rate          NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  duration_seconds      INTEGER NOT NULL DEFAULT 0,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  unlock_conditions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merge_recipes_active ON merge_recipes (is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_merge_recipes_output ON merge_recipes (output_pokemon_id);

CREATE TABLE IF NOT EXISTS merge_records (
  id                         BIGSERIAL PRIMARY KEY,
  user_id                    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id                  INTEGER REFERENCES merge_recipes(id),
  input_pokemon              JSONB NOT NULL,
  input_items                JSONB,
  output_pokemon_instance_id UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  output_pokemon_id          SMALLINT,
  output_level               INTEGER,
  is_variant                 BOOLEAN NOT NULL DEFAULT FALSE,
  success                    BOOLEAN NOT NULL,
  lucky_bonus                NUMERIC(5,2) NOT NULL DEFAULT 0,
  success_rate               NUMERIC(5,2),
  merged_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merge_records_user ON merge_records (user_id, merged_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_records_success ON merge_records (success);

CREATE TABLE IF NOT EXISTS merge_queue (
  id                         BIGSERIAL PRIMARY KEY,
  user_id                    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id                  INTEGER REFERENCES merge_recipes(id),
  input_pokemon_instance_ids UUID[] NOT NULL,
  input_item_ids             TEXT[],
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completes_at               TIMESTAMPTZ NOT NULL,
  status                     VARCHAR(20) NOT NULL DEFAULT 'pending',
  result_data                JSONB,
  processed_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_merge_queue_user_status ON merge_queue (user_id, status);

-- 配方（只引用已存在的物种）
INSERT INTO merge_recipes (recipe_code, name_i18n, description_i18n, required_pokemon, required_items, output_pokemon_id,
                           output_min_level, output_level_variance, base_success_rate, variant_pokemon_id, variant_rate, unlock_conditions)
SELECT v.code, v.name::jsonb, v.descr::jsonb, v.req::jsonb, v.items::jsonb, v.out_id, v.min_lv, v.var_lv, v.rate, v.variant, v.vrate, v.unlock::jsonb
  FROM (VALUES
    ('bulbasaur_trio', '{"zh":"种子三重奏","en":"Seed Trio","ja":"タネのトリオ"}', '{"zh":"3 只妙蛙种子合并为妙蛙草，小概率直接变异为妙蛙花","en":"Merge 3 Bulbasaur into Ivysaur; rarely Venusaur"}',
      '[{"species_id":1,"min_level":5,"count":3}]', '[]', 2, 10, 5, 70.00, 3, 5.00, '{}'),
    ('charmander_trio', '{"zh":"火苗三重奏","en":"Flame Trio","ja":"ほのおのトリオ"}', '{"zh":"3 只小火龙合并为火恐龙，小概率变异为喷火龙","en":"Merge 3 Charmander into Charmeleon; rarely Charizard"}',
      '[{"species_id":4,"min_level":5,"count":3}]', '[]', 5, 10, 5, 70.00, 6, 5.00, '{}'),
    ('squirtle_trio', '{"zh":"水花三重奏","en":"Splash Trio","ja":"みずのトリオ"}', '{"zh":"3 只杰尼龟合并为卡咪龟，小概率变异为水箭龟","en":"Merge 3 Squirtle into Wartortle; rarely Blastoise"}',
      '[{"species_id":7,"min_level":5,"count":3}]', '[]', 8, 10, 5, 70.00, 9, 5.00, '{}'),
    ('pikachu_storm', '{"zh":"雷暴","en":"Thunderstorm","ja":"かみなりあらし"}', '{"zh":"5 只皮卡丘加雷之石合并为雷丘，极小概率召唤闪电鸟","en":"5 Pikachu + Thunder Stone into Raichu; very rarely Zapdos"}',
      '[{"species_id":25,"min_level":1,"count":5}]', '[{"item_id":"THUNDER_STONE","count":1}]', 26, 15, 5, 80.00, 145, 1.00, '{}'),
    ('eevee_tide', '{"zh":"潮汐之约","en":"Tidal Pact","ja":"しおのちかい"}', '{"zh":"3 只伊布加水之石合并为水伊布，小概率变异为拉普拉斯","en":"3 Eevee + Water Stone into Vaporeon; rarely Lapras"}',
      '[{"species_id":133,"min_level":1,"count":3}]', '[{"item_id":"WATER_STONE","count":1}]', 134, 15, 5, 75.00, 131, 3.00, '{}'),
    ('geodude_pile', '{"zh":"碎石堆","en":"Rock Pile","ja":"いしのやま"}', '{"zh":"4 只小拳石合并为隆隆石，小概率变异为卡比兽","en":"4 Geodude into Graveler; rarely Snorlax"}',
      '[{"species_id":74,"min_level":1,"count":4}]', '[]', 75, 12, 5, 75.00, 143, 2.00, '{}'),
    ('meowth_gang', '{"zh":"喵喵帮","en":"Meowth Gang","ja":"ニャースだん"}', '{"zh":"10 只喵喵合并为猫老大，极小概率遇见梦幻","en":"10 Meowth into Persian; very rarely Mew"}',
      '[{"species_id":52,"min_level":1,"count":10}]', '[]', 53, 12, 5, 90.00, 151, 0.50, '{}'),
    ('legendary_birds', '{"zh":"三圣鸟之约","en":"Legendary Birds","ja":"伝説の鳥の誓い"}', '{"zh":"急冻鸟、闪电鸟、火焰鸟合并为超梦，小概率为梦幻","en":"Articuno + Zapdos + Moltres into Mewtwo; rarely Mew"}',
      '[{"species_id":144,"min_level":20,"count":1},{"species_id":145,"min_level":20,"count":1},{"species_id":146,"min_level":20,"count":1}]', '[]', 150, 30, 10, 50.00, 151, 10.00, '{"trainer_level":30}')
  ) AS v(code, name, descr, req, items, out_id, min_lv, var_lv, rate, variant, vrate, unlock)
 WHERE EXISTS (SELECT 1 FROM pokemon_species s WHERE s.id = v.out_id)
   AND (v.variant IS NULL OR EXISTS (SELECT 1 FROM pokemon_species s WHERE s.id = v.variant))
ON CONFLICT (recipe_code) DO NOTHING;

INSERT INTO items (id, item_id, category, name_zh, name_en, description_zh, description_en, rarity, effect_type, effect_value, shop_price, is_premium)
VALUES ('MERGE_LUCKY_CHARM', 'MERGE_LUCKY_CHARM', 'merge', '合并幸运符', 'Merge Lucky Charm', '合并成功率 +15%', 'Merge success rate +15%', 'rare', 'merge_luck', 15, 800, FALSE)
ON CONFLICT (id) DO NOTHING;
