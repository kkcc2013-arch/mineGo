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
UPDATE moves SET type = 'fire', power = 40 WHERE name = 'ember';
UPDATE moves SET type = 'fire', power = 70 WHERE name = 'flamethrower';
UPDATE moves SET type = 'water', power = 40 WHERE name = 'water_gun';
UPDATE moves SET type = 'water', power = 90 WHERE name = 'hydro_pump';
UPDATE moves SET type = 'grass', power = 55 WHERE name = 'vine_whip';
UPDATE moves SET type = 'grass', power = 100 WHERE name = 'solar_beam';
UPDATE moves SET type = 'electric', power = 65 WHERE name = 'thunder_shock';
UPDATE moves SET type = 'electric', power = 100 WHERE name = 'thunder';
UPDATE moves SET type = 'ice', power = 90 WHERE name = 'ice_beam';
UPDATE moves SET type = 'psychic', power = 90 WHERE name = 'psychic';
UPDATE moves SET type = 'fighting', power = 50 WHERE name = 'karate_chop';
UPDATE moves SET type = 'fighting', power = 100 WHERE name = 'close_combat';
UPDATE moves SET type = 'dragon', power = 85 WHERE name = 'dragon_claw';
UPDATE moves SET type = 'dark', power = 80 WHERE name = 'crunch';
UPDATE moves SET type = 'ghost', power = 100 WHERE name = 'shadow_ball';
UPDATE moves SET type = 'fairy', power = 90 WHERE name = 'dazzling_gleam';
UPDATE moves SET type = 'normal', power = 35 WHERE name = 'tackle';
UPDATE moves SET type = 'normal', power = 50 WHERE name = 'quick_attack';
UPDATE moves SET type = 'rock', power = 80 WHERE name = 'rock_slide';
UPDATE moves SET type = 'steel', power = 100 WHERE name = 'iron_head';
UPDATE moves SET type = 'ground', power = 100 WHERE name = 'earthquake';
UPDATE moves SET type = 'poison', power = 80 WHERE name = 'sludge_bomb';
UPDATE moves SET type = 'bug', power = 90 WHERE name = 'bug_buzz';
UPDATE moves SET type = 'flying', power = 80 WHERE name = 'air_slash';

-- 插入默认技能数据（如果不存在）
INSERT INTO moves (name, type, power, energy_cost, duration_ms)
VALUES 
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
ON CONFLICT (name) DO UPDATE SET
  type = EXCLUDED.type,
  power = EXCLUDED.power,
  energy_cost = EXCLUDED.energy_cost,
  duration_ms = EXCLUDED.duration_ms;
