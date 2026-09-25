-- Epic E07 精灵成长：核心结构（幂等）
--
-- 1) 精灵实例新增成长属性：等级（由 experience 换算）、忙碌锁（训练营/特训/培育占用中不能进化、合并、放生）、
--    觉醒阶段与加成、世代（培育后代 +1）、来源
-- 2) users.vip_level（经验 VIP 加成、背包 VIP 加成共用；原代码引用了但从未建列）
-- 3) 补伊布的 5 个进化形态：伊布 candy_to_evolve=25 但没有任何可进化目标（evolution_rules 里的分支目标物种不存在）
-- 4) evolution_rules 增加隐藏路径与提示；evolution_history 的实例 ID 改为 UUID（原为 integer，任何写入都会失败）
-- 5) 糖果按进化家族记账（pokemon_family_root + candy_inventory 插入触发器）

ALTER TABLE pokemon_instances
  ADD COLUMN IF NOT EXISTS level SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS occupied_by VARCHAR(30),
  ADD COLUMN IF NOT EXISTS occupied_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS awakening_stage SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS awakening_bonuses JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS generation SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'wild';

-- 历史迁移给 experience / friendship 设了默认值但允许 NULL；成长逻辑按非空处理
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS experience INTEGER DEFAULT 0;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS friendship INTEGER DEFAULT 70;
UPDATE pokemon_instances SET experience = 0 WHERE experience IS NULL;
UPDATE pokemon_instances SET friendship = 70 WHERE friendship IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pokemon_instances_level_range') THEN
    ALTER TABLE pokemon_instances
      ADD CONSTRAINT chk_pokemon_instances_level_range CHECK (level BETWEEN 1 AND 100) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pokemon_instances_occupied
  ON pokemon_instances (user_id, occupied_by) WHERE occupied_by IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_level SMALLINT NOT NULL DEFAULT 0;

-- 伊布进化形态（只在 ANY 生态刷新，与其他进化形态一致）
INSERT INTO pokemon_species (id, name_zh, name_en, type1, type2, rarity, base_attack, base_defense, base_hp,
                             base_catch_rate, base_flee_rate, candy_to_evolve, evolves_to, biomes, description_zh)
VALUES
  (134, '水伊布', 'Vaporeon', 'WATER',    NULL, 'RARE', 205, 161, 277, 0.12, 0.06, NULL, NULL, '{}', '使用水之石进化的伊布，能与水融为一体。'),
  (135, '雷伊布', 'Jolteon',  'ELECTRIC', NULL, 'RARE', 232, 182, 163, 0.12, 0.06, NULL, NULL, '{}', '使用雷之石进化的伊布，全身毛发带电。'),
  (136, '火伊布', 'Flareon',  'FIRE',     NULL, 'RARE', 246, 179, 163, 0.12, 0.06, NULL, NULL, '{}', '使用火之石进化的伊布，体内有火焰囊。'),
  (196, '太阳伊布', 'Espeon', 'PSYCHIC',  NULL, 'RARE', 261, 175, 163, 0.12, 0.06, NULL, NULL, '{}', '与训练师关系亲密时在白天进化的伊布。'),
  (197, '月亮伊布', 'Umbreon', 'DARK',    NULL, 'RARE', 126, 240, 216, 0.12, 0.06, NULL, NULL, '{}', '与训练师关系亲密时在夜晚进化的伊布。')
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'name_ja') THEN
    UPDATE pokemon_species SET name_ja = v.ja FROM (VALUES
      (134, 'シャワーズ'), (135, 'サンダース'), (136, 'ブースター'), (196, 'エーフィ'), (197, 'ブラッキー')
    ) AS v(id, ja) WHERE pokemon_species.id = v.id AND pokemon_species.name_ja IS NULL;
  END IF;
END $$;

-- evolution_rules：隐藏路径与发现提示（表由 pending/20260609_211500 创建）
ALTER TABLE IF EXISTS evolution_rules
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS hint_zh TEXT,
  ADD COLUMN IF NOT EXISTS hint_en TEXT,
  ADD COLUMN IF NOT EXISTS hint_ja TEXT;

DO $$
BEGIN
  IF to_regclass('public.evolution_rules') IS NOT NULL THEN
    UPDATE evolution_rules SET is_hidden = TRUE,
           hint_zh = '据说与训练师非常亲密的伊布，会在阳光下发生变化……',
           hint_en = 'An Eevee that is very close to its trainer is said to change under the sun...',
           hint_ja = 'トレーナーととても仲の良いイーブイは、日の光を浴びると……'
     WHERE from_species_id = 133 AND to_species_id = 196 AND hint_zh IS NULL;
    UPDATE evolution_rules SET is_hidden = TRUE,
           hint_zh = '据说与训练师非常亲密的伊布，会在月光下发生变化……',
           hint_en = 'An Eevee that is very close to its trainer is said to change under the moon...',
           hint_ja = 'トレーナーととても仲の良いイーブイは、月の光を浴びると……'
     WHERE from_species_id = 133 AND to_species_id = 197 AND hint_zh IS NULL;
  END IF;
END $$;

-- evolution_history：实例 ID 改 UUID（原 integer 列无法存放 UUID，历史行本就写不进来）
DO $$
BEGIN
  IF to_regclass('public.evolution_history') IS NULL THEN
    CREATE TABLE evolution_history (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      pokemon_instance_id UUID,
      from_species_id INTEGER NOT NULL,
      to_species_id INTEGER NOT NULL,
      evolution_type VARCHAR(20),
      before_cp INTEGER, before_level INTEGER, before_stats JSONB,
      after_cp INTEGER, after_level INTEGER, after_stats JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'evolution_history' AND column_name = 'pokemon_instance_id'
                   AND data_type <> 'uuid') THEN
    ALTER TABLE evolution_history ALTER COLUMN pokemon_instance_id DROP NOT NULL;
    ALTER TABLE evolution_history ALTER COLUMN pokemon_instance_id TYPE UUID USING NULL;
  END IF;
END $$;

ALTER TABLE evolution_history
  ADD COLUMN IF NOT EXISTS candy_cost INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS item_used VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'evolve';
CREATE INDEX IF NOT EXISTS idx_evolution_history_user_time ON evolution_history (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_history_instance ON evolution_history (pokemon_instance_id);

-- 糖果按进化家族结算：candy_inventory 的 species_id 统一存家族根物种（妙蛙种子/妙蛙草/妙蛙花共用种子糖果）。
-- 原实现按物种分别记账，捕捉妙蛙种子得到的糖果无法用于妙蛙草进化 → 二段进化实际上不可能完成。
-- 家族关系：species.evolves_to 与目标物种存在的 evolution_rules（伊布分支）。
CREATE OR REPLACE FUNCTION pokemon_family_root(p_species INTEGER) RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cur INTEGER := p_species;
  parent INTEGER;
  i INTEGER := 0;
  has_rules BOOLEAN := to_regclass('public.evolution_rules') IS NOT NULL;
BEGIN
  IF cur IS NULL THEN RETURN NULL; END IF;
  LOOP
    parent := NULL;
    SELECT s.id INTO parent FROM pokemon_species s WHERE s.evolves_to = cur ORDER BY s.id LIMIT 1;
    IF parent IS NULL AND has_rules THEN
      EXECUTE 'SELECT r.from_species_id FROM evolution_rules r JOIN pokemon_species f ON f.id = r.from_species_id
                WHERE r.to_species_id = $1 AND r.is_active ORDER BY r.from_species_id LIMIT 1'
        INTO parent USING cur;
    END IF;
    EXIT WHEN parent IS NULL OR parent = cur OR i >= 10;
    cur := parent;
    i := i + 1;
  END LOOP;
  RETURN cur;
END $$;

CREATE OR REPLACE FUNCTION candy_inventory_family_root() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.species_id := COALESCE(pokemon_family_root(NEW.species_id), NEW.species_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_candy_inventory_family_root ON candy_inventory;
CREATE TRIGGER trg_candy_inventory_family_root
  BEFORE INSERT ON candy_inventory
  FOR EACH ROW EXECUTE FUNCTION candy_inventory_family_root();

-- 已有的非根物种糖果并入家族根（幂等：并完后不再有非根行）
WITH moved AS (
  DELETE FROM candy_inventory c
   WHERE pokemon_family_root(c.species_id) <> c.species_id
  RETURNING c.user_id, pokemon_family_root(c.species_id) AS root, c.amount
)
INSERT INTO candy_inventory (user_id, species_id, amount)
SELECT user_id, root, SUM(amount) FROM moved GROUP BY user_id, root
ON CONFLICT (user_id, species_id) DO UPDATE SET amount = candy_inventory.amount + EXCLUDED.amount, updated_at = NOW();
