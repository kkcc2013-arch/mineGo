-- REQ-00210: 精灵亲密度进化计算与提示系统
-- 创建亲密度记录表和进化规则表

-- 亲密度记录表
CREATE TABLE IF NOT EXISTS pokemon_friendship_logs (
  id SERIAL PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  change_amount INTEGER NOT NULL,        -- 亲密度变化量（正/负）
  source VARCHAR(50) NOT NULL,           -- 变化来源：walk, battle, feed, spa, gift, trade
  context JSONB DEFAULT '{}',            -- 额外上下文信息
  previous_value INTEGER NOT NULL,       -- 变化前值
  new_value INTEGER NOT NULL,            -- 变化后值
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE pokemon_friendship_logs ADD COLUMN IF NOT EXISTS pokemon_instance_id UUID;
ALTER TABLE pokemon_friendship_logs ADD COLUMN IF NOT EXISTS change_amount INTEGER;
ALTER TABLE pokemon_friendship_logs ADD COLUMN IF NOT EXISTS source VARCHAR(50);
ALTER TABLE pokemon_friendship_logs ADD COLUMN IF NOT EXISTS context JSONB DEFAULT '{}';
ALTER TABLE pokemon_friendship_logs ADD COLUMN IF NOT EXISTS previous_value INTEGER;
ALTER TABLE pokemon_friendship_logs ADD COLUMN IF NOT EXISTS new_value INTEGER;
ALTER TABLE pokemon_friendship_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.pokemon_friendship_logs') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('pokemon_instance_id', 'change_amount', 'source', 'context', 'previous_value', 'new_value', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE pokemon_friendship_logs ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 亲密度进化规则表
CREATE TABLE IF NOT EXISTS friendship_evolution_rules (
  id SERIAL PRIMARY KEY,
  species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  target_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  required_friendship INTEGER NOT NULL DEFAULT 220,  -- 默认220（标准亲密度进化阈值）
  time_restriction VARCHAR(20),          -- 'day', 'night', null（昼夜限制）
  additional_conditions JSONB DEFAULT '{}', -- 其他条件（如携带道具）
  evolution_method VARCHAR(50) DEFAULT 'level_up'  -- level_up, trade, item
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE friendship_evolution_rules ADD COLUMN IF NOT EXISTS species_id INTEGER;
ALTER TABLE friendship_evolution_rules ADD COLUMN IF NOT EXISTS target_species_id INTEGER;
ALTER TABLE friendship_evolution_rules ADD COLUMN IF NOT EXISTS required_friendship INTEGER DEFAULT 220;
ALTER TABLE friendship_evolution_rules ADD COLUMN IF NOT EXISTS time_restriction VARCHAR(20);
ALTER TABLE friendship_evolution_rules ADD COLUMN IF NOT EXISTS additional_conditions JSONB DEFAULT '{}';
ALTER TABLE friendship_evolution_rules ADD COLUMN IF NOT EXISTS evolution_method VARCHAR(50) DEFAULT 'level_up';
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.friendship_evolution_rules') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('species_id', 'target_species_id', 'required_friendship', 'time_restriction', 'additional_conditions', 'evolution_method', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE friendship_evolution_rules ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;
-- 旧版定义（pending/20260611_131000）使用 evolution_species_id NOT NULL；本版使用 target_species_id，两列保持同步
DO $fe$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'friendship_evolution_rules' AND column_name = 'evolution_species_id') THEN
    ALTER TABLE friendship_evolution_rules ALTER COLUMN evolution_species_id DROP NOT NULL;
  END IF;
END $fe$;

-- 索引
CREATE INDEX IF NOT EXISTS idx_friendship_logs_pokemon ON pokemon_friendship_logs(pokemon_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friendship_rules_species ON friendship_evolution_rules(species_id);

-- 修改 pokemon_instances 表添加亲密度字段
ALTER TABLE pokemon_instances 
ADD COLUMN IF NOT EXISTS friendship INTEGER DEFAULT 70,
ADD COLUMN IF NOT EXISTS friendship_updated_at TIMESTAMP DEFAULT NOW();

-- 初始化已有数据的亲密度
UPDATE pokemon_instances SET friendship = 70 WHERE friendship IS NULL;

-- 插入常见亲密度进化规则（示例数据）
-- 皮卡丘 -> 雷丘（阿罗拉形态需要其他条件）
INSERT INTO friendship_evolution_rules (species_id, target_species_id, required_friendship, time_restriction, evolution_method)
SELECT s.id, t.id, 220, NULL, 'level_up'
FROM pokemon_species s, pokemon_species t
WHERE s.name_en = 'Pikachu' AND t.name_en = 'Raichu'
ON CONFLICT DO NOTHING;

-- 伊布 -> 太阳伊布（白天）
INSERT INTO friendship_evolution_rules (species_id, target_species_id, required_friendship, time_restriction, evolution_method)
SELECT s.id, t.id, 220, 'day', 'level_up'
FROM pokemon_species s, pokemon_species t
WHERE s.name_en = 'Eevee' AND t.name_en = 'Espeon'
ON CONFLICT DO NOTHING;

-- 伊布 -> 月亮伊布（夜晚）
INSERT INTO friendship_evolution_rules (species_id, target_species_id, required_friendship, time_restriction, evolution_method)
SELECT s.id, t.id, 220, 'night', 'level_up'
FROM pokemon_species s, pokemon_species t
WHERE s.name_en = 'Eevee' AND t.name_en = 'Umbreon'
ON CONFLICT DO NOTHING;

-- 吉利蛋 -> 幸福蛋
INSERT INTO friendship_evolution_rules (species_id, target_species_id, required_friendship, time_restriction, evolution_method)
SELECT s.id, t.id, 220, NULL, 'level_up'
FROM pokemon_species s, pokemon_species t
WHERE s.name_en = 'Chansey' AND t.name_en = 'Blissey'
ON CONFLICT DO NOTHING;

-- 波克比 -> 波克基古
INSERT INTO friendship_evolution_rules (species_id, target_species_id, required_friendship, time_restriction, evolution_method)
SELECT s.id, t.id, 220, NULL, 'level_up'
FROM pokemon_species s, pokemon_species t
WHERE s.name_en = 'Togepi' AND t.name_en = 'Togetic'
ON CONFLICT DO NOTHING;

-- 注释
COMMENT ON TABLE pokemon_friendship_logs IS '精灵亲密度变化日志';
COMMENT ON TABLE friendship_evolution_rules IS '亲密度进化规则';
COMMENT ON COLUMN pokemon_friendship_logs.source IS '变化来源：walk, battle_win, battle_raid, feed_berry, feed_golden_berry, spa_treatment, gift_receive, trade_away, faint, energy_drink';
COMMENT ON COLUMN friendship_evolution_rules.time_restriction IS '时间限制：day=白天, night=夜晚, null=无限制';

DO $fe2$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'friendship_evolution_rules' AND column_name = 'evolution_species_id') THEN
    UPDATE friendship_evolution_rules SET evolution_species_id = target_species_id WHERE evolution_species_id IS NULL;
  END IF;
END $fe2$;
