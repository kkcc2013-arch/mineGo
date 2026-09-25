-- Epic E07：精灵培育与基因遗传（REQ-00276）（幂等；培育屋/配对/谱系/统计表由 pending/20260609_080000 创建）
--
-- 1) 精灵蛋 pokemon_eggs：基因集合（IV 来源/显隐性/变异、技能、闪光）、孵化所需距离、孵化器、开始孵化时的累计行走距离
--    （原 egg_hatching 要求先有 pokemon_instances 行，且进度靠客户端上报步数，不再使用）
-- 2) 为全部物种补蛋组（原只配了 9 行）；传说/幻之精灵为"未发现"组
-- 3) 培育相关表时间列改 TIMESTAMPTZ；培育道具入 items

CREATE TABLE IF NOT EXISTS pokemon_eggs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_id            UUID REFERENCES breeding_pairs(id) ON DELETE SET NULL,
  species_id         SMALLINT NOT NULL REFERENCES pokemon_species(id),
  mother_id          UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  father_id          UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  gene_set           JSONB NOT NULL,
  rarity             VARCHAR(20) NOT NULL DEFAULT 'COMMON',
  required_km        NUMERIC(6,2) NOT NULL CHECK (required_km > 0),
  generation         SMALLINT NOT NULL DEFAULT 1,
  status             VARCHAR(20) NOT NULL DEFAULT 'unhatched' CHECK (status IN ('unhatched', 'incubating', 'hatched')),
  incubator          VARCHAR(30),
  speed_multiplier   NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  distance_start_km  NUMERIC(10,2),
  incubated_at       TIMESTAMPTZ,
  hatched_at         TIMESTAMPTZ,
  hatched_pokemon_id UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pokemon_eggs_user_status ON pokemon_eggs (user_id, status);

INSERT INTO species_egg_groups (species_id, egg_group_id)
SELECT v.sid, v.gid FROM (VALUES
  (1, 1), (1, 5), (2, 1), (2, 5), (3, 1), (3, 5),
  (4, 1), (4, 9), (5, 1), (5, 9), (6, 1), (6, 9),
  (7, 1), (7, 2), (8, 1), (8, 2), (9, 1), (9, 2),
  (25, 11), (25, 4), (26, 11), (26, 4),
  (39, 4), (40, 4),
  (52, 11), (53, 11),
  (54, 2), (54, 11), (55, 2), (55, 11),
  (74, 7), (75, 7),
  (79, 1), (79, 2), (80, 1), (80, 2),
  (94, 8),
  (131, 1), (131, 2),
  (132, 13),
  (133, 11), (134, 11), (135, 11), (136, 11), (196, 11), (197, 11),
  (143, 1),
  (144, 12), (145, 12), (146, 12), (150, 12), (151, 12)
) AS v(sid, gid)
WHERE EXISTS (SELECT 1 FROM pokemon_species s WHERE s.id = v.sid)
  AND EXISTS (SELECT 1 FROM egg_groups g WHERE g.id = v.gid)
ON CONFLICT (species_id, egg_group_id) DO NOTHING;

DO $$
DECLARE
  c RECORD;
  tz TEXT := current_setting('TimeZone');
BEGIN
  FOR c IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('breeding_centers', 'breeding_pairs', 'breeding_stats', 'pokemon_lineage')
              AND data_type = 'timestamp without time zone' LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE %L',
                   c.table_name, c.column_name, c.column_name, tz);
  END LOOP;
END $$;

INSERT INTO items (id, item_id, category, name_zh, name_en, description_zh, description_en, rarity, effect_type, shop_price, is_premium)
VALUES
  ('DESTINY_KNOT', 'DESTINY_KNOT', 'breeding', '命运红线', 'Destiny Knot', '培育时 IV 遗传率从 50% 提升到 80%', 'Raises IV inheritance from 50% to 80% when breeding', 'rare', 'gene_enhance', 1500, FALSE),
  ('INCUBATOR_SUPER', 'INCUBATOR_SUPER', 'breeding', '超级孵化器', 'Super Incubator', '孵化所需距离按 1.5 倍速度累计', 'Eggs hatch 1.5x faster', 'uncommon', 'hatch_speed', 800, FALSE),
  ('INCUBATOR_ULTRA', 'INCUBATOR_ULTRA', 'breeding', '究极孵化器', 'Ultra Incubator', '孵化所需距离按 2 倍速度累计', 'Eggs hatch 2x faster', 'rare', 'hatch_speed', 0, TRUE)
ON CONFLICT (id) DO NOTHING;
