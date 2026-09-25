-- migrate:up
-- E11：恢复快速技能的 GO 威力值。
-- pending/20260615_221000__add_damage_system.sql 用主系列威力（撞击 35、火花 40、电击 65…）覆盖了
-- pending/20260605_180000__add_moves_and_tm_system.sql 中的 GO 数值，而战斗伤害采用 GO 公式
-- （0.5 × 威力 × 攻/防），快速技能 35~65 威力会使快速技能伤害接近蓄力技能，能量/冷却/连击策略失去意义。
-- 只在仍为被覆盖的旧值时更新，可重复执行，也不会覆盖运营后续手工调整的数值。
UPDATE moves SET power = 5  WHERE id = 'TACKLE'        AND power = 35;
UPDATE moves SET power = 10 WHERE id = 'EMBER'         AND power = 40;
UPDATE moves SET power = 5  WHERE id = 'WATER_GUN'     AND power = 40;
UPDATE moves SET power = 7  WHERE id = 'VINE_WHIP'     AND power = 55;
UPDATE moves SET power = 6  WHERE id = 'THUNDER_SHOCK' AND power = 65;
UPDATE moves SET power = 8  WHERE id = 'KARATE_CHOP'   AND power = 50;
UPDATE moves SET power = 8  WHERE id = 'QUICK_ATTACK'  AND power = 50;
