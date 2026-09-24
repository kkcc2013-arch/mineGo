-- REQ-00146: 伤害公式与属性克制系统数据库迁移
-- 创建时间: 2026-06-15 22:15

-- 确保技能表有属性和威力字段
ALTER TABLE moves 
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS power INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS energy_cost INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER DEFAULT 1000;

-- 添加技能类型索引
CREATE INDEX IF NOT EXISTS idx_moves_type ON moves(type);

-- 更新常见技能数据
UPDATE moves SET type = 'FIRE', power = 40 WHERE lower(replace(name_en, ' ', '_')) = 'ember';
UPDATE moves SET type = 'FIRE', power = 70 WHERE lower(replace(name_en, ' ', '_')) = 'flamethrower';
UPDATE moves SET type = 'WATER', power = 40 WHERE lower(replace(name_en, ' ', '_')) = 'water_gun';
UPDATE moves SET type = 'WATER', power = 90 WHERE lower(replace(name_en, ' ', '_')) = 'hydro_pump';
UPDATE moves SET type = 'GRASS', power = 55 WHERE lower(replace(name_en, ' ', '_')) = 'vine_whip';
UPDATE moves SET type = 'GRASS', power = 100 WHERE lower(replace(name_en, ' ', '_')) = 'solar_beam';
UPDATE moves SET type = 'ELECTRIC', power = 65 WHERE lower(replace(name_en, ' ', '_')) = 'thunder_shock';
UPDATE moves SET type = 'ELECTRIC', power = 100 WHERE lower(replace(name_en, ' ', '_')) = 'thunder';
UPDATE moves SET type = 'ICE', power = 90 WHERE lower(replace(name_en, ' ', '_')) = 'ice_beam';
UPDATE moves SET type = 'PSYCHIC', power = 90 WHERE lower(replace(name_en, ' ', '_')) = 'psychic';
UPDATE moves SET type = 'FIGHTING', power = 50 WHERE lower(replace(name_en, ' ', '_')) = 'karate_chop';
UPDATE moves SET type = 'FIGHTING', power = 100 WHERE lower(replace(name_en, ' ', '_')) = 'close_combat';
UPDATE moves SET type = 'DRAGON', power = 85 WHERE lower(replace(name_en, ' ', '_')) = 'dragon_claw';
UPDATE moves SET type = 'DARK', power = 80 WHERE lower(replace(name_en, ' ', '_')) = 'crunch';
UPDATE moves SET type = 'GHOST', power = 100 WHERE lower(replace(name_en, ' ', '_')) = 'shadow_ball';
UPDATE moves SET type = 'FAIRY', power = 90 WHERE lower(replace(name_en, ' ', '_')) = 'dazzling_gleam';
UPDATE moves SET type = 'NORMAL', power = 35 WHERE lower(replace(name_en, ' ', '_')) = 'tackle';
UPDATE moves SET type = 'NORMAL', power = 50 WHERE lower(replace(name_en, ' ', '_')) = 'quick_attack';
UPDATE moves SET type = 'ROCK', power = 80 WHERE lower(replace(name_en, ' ', '_')) = 'rock_slide';
UPDATE moves SET type = 'STEEL', power = 100 WHERE lower(replace(name_en, ' ', '_')) = 'iron_head';
UPDATE moves SET type = 'GROUND', power = 100 WHERE lower(replace(name_en, ' ', '_')) = 'earthquake';
UPDATE moves SET type = 'POISON', power = 80 WHERE lower(replace(name_en, ' ', '_')) = 'sludge_bomb';
UPDATE moves SET type = 'BUG', power = 90 WHERE lower(replace(name_en, ' ', '_')) = 'bug_buzz';
UPDATE moves SET type = 'FLYING', power = 80 WHERE lower(replace(name_en, ' ', '_')) = 'air_slash';

-- 插入默认技能数据（如果不存在）
-- moves 表结构见 20260605_180000__add_moves_and_tm_system.sql（id/name_zh/name_en/category/energy_delta/cooldown_ms 必填，属性大写）
INSERT INTO moves (id, name_zh, name_en, type, category, power, energy_delta, energy_cost, duration_ms, cooldown_ms)
SELECT upper(v.name), initcap(replace(v.name, '_', ' ')), initcap(replace(v.name, '_', ' ')), upper(v.type),
       CASE WHEN v.energy_cost = 0 THEN 'FAST' ELSE 'CHARGE' END, v.power,
       CASE WHEN v.energy_cost = 0 THEN 8 ELSE -v.energy_cost END, v.energy_cost, v.duration_ms, v.duration_ms
FROM (VALUES 
  ('ember', 'fire', 40, 0, 1000),
  ('flamethrower', 'fire', 70, 50, 2500),
  ('water_gun', 'water', 40, 0, 1000),
  ('hydro_pump', 'water', 90, 80, 3500),
  ('vine_whip', 'grass', 55, 0, 800),
  ('solar_beam', 'grass', 100, 80, 4000),
  ('thunder_shock', 'electric', 65, 0, 1200),
  ('thunder', 'electric', 100, 75, 3500),
  ('ice_beam', 'ice', 90, 60, 3000),
  ('psychic', 'psychic', 90, 60, 2800),
  ('karate_chop', 'fighting', 50, 0, 800),
  ('close_combat', 'fighting', 100, 70, 3000),
  ('dragon_claw', 'dragon', 85, 50, 2000),
  ('crunch', 'dark', 80, 45, 2000),
  ('shadow_ball', 'ghost', 100, 55, 2500),
  ('dazzling_gleam', 'fairy', 90, 55, 2500),
  ('tackle', 'normal', 35, 0, 500),
  ('quick_attack', 'normal', 50, 0, 600),
  ('rock_slide', 'rock', 80, 50, 2500),
  ('iron_head', 'steel', 100, 60, 2800),
  ('earthquake', 'ground', 100, 70, 3500),
  ('sludge_bomb', 'poison', 80, 50, 2200),
  ('bug_buzz', 'bug', 90, 55, 2500),
  ('air_slash', 'flying', 80, 45, 2000)
) AS v(name, type, power, energy_cost, duration_ms)
ON CONFLICT (id) DO UPDATE SET
  power = EXCLUDED.power,
  energy_cost = EXCLUDED.energy_cost,
  duration_ms = EXCLUDED.duration_ms;
