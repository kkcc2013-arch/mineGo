-- migrate:up
-- 训练师等级随经验提升（评审遗留缺陷：users.xp 增长但 level 永远是 1）
-- 做法：等级表 + users 上的触发器。所有加经验的路径（捕捉、补给站、签到、活动奖励…）都只需要改 xp，
-- 等级由数据库统一换算，不会出现各服务各算各的；升级记录写入 trainer_level_ups 供客户端提示/成就使用。

CREATE TABLE IF NOT EXISTS trainer_levels (
  level          SMALLINT PRIMARY KEY CHECK (level BETWEEN 1 AND 50),
  total_xp       BIGINT NOT NULL UNIQUE CHECK (total_xp >= 0),   -- 达到该等级所需的累计经验
  reward_items   JSONB NOT NULL DEFAULT '{}'::jsonb              -- 升级奖励（如 {"pokeballs": 15}），由奖励服务发放
);

INSERT INTO trainer_levels (level, total_xp, reward_items) VALUES
  (1, 0, '{}'), (2, 1000, '{"pokeballs": 15}'), (3, 3000, '{"pokeballs": 15}'), (4, 6000, '{"pokeballs": 15}'),
  (5, 10000, '{"pokeballs": 20, "stardust": 1000}'), (6, 15000, '{"pokeballs": 15}'), (7, 21000, '{"pokeballs": 15}'),
  (8, 28000, '{"pokeballs": 15}'), (9, 36000, '{"pokeballs": 15}'), (10, 45000, '{"pokeballs": 20, "greatballs": 10, "stardust": 2000}'),
  (11, 55000, '{"greatballs": 15}'), (12, 65000, '{"greatballs": 15}'), (13, 75000, '{"greatballs": 15}'),
  (14, 85000, '{"greatballs": 15}'), (15, 100000, '{"greatballs": 20, "stardust": 3000}'), (16, 120000, '{"greatballs": 15}'),
  (17, 140000, '{"greatballs": 15}'), (18, 160000, '{"greatballs": 15}'), (19, 185000, '{"greatballs": 15}'),
  (20, 210000, '{"ultraballs": 20, "stardust": 5000}'), (21, 260000, '{"ultraballs": 10}'), (22, 335000, '{"ultraballs": 10}'),
  (23, 435000, '{"ultraballs": 10}'), (24, 560000, '{"ultraballs": 10}'), (25, 710000, '{"ultraballs": 20, "stardust": 8000}'),
  (26, 900000, '{"ultraballs": 10}'), (27, 1100000, '{"ultraballs": 10}'), (28, 1350000, '{"ultraballs": 10}'),
  (29, 1650000, '{"ultraballs": 10}'), (30, 2000000, '{"ultraballs": 20, "stardust": 10000}'), (31, 2500000, '{"ultraballs": 10}'),
  (32, 3000000, '{"ultraballs": 10}'), (33, 3750000, '{"ultraballs": 10}'), (34, 4750000, '{"ultraballs": 10}'),
  (35, 6000000, '{"ultraballs": 20, "stardust": 15000}'), (36, 7500000, '{"ultraballs": 10}'), (37, 9500000, '{"ultraballs": 10}'),
  (38, 12000000, '{"ultraballs": 10}'), (39, 15000000, '{"ultraballs": 10}'), (40, 20000000, '{"ultraballs": 20, "masterballs": 1}'),
  (41, 26000000, '{"ultraballs": 20}'), (42, 33500000, '{"ultraballs": 20}'), (43, 42500000, '{"ultraballs": 20}'),
  (44, 53500000, '{"ultraballs": 20}'), (45, 66500000, '{"ultraballs": 30, "masterballs": 1}'), (46, 82000000, '{"ultraballs": 20}'),
  (47, 100000000, '{"ultraballs": 20}'), (48, 121000000, '{"ultraballs": 20}'), (49, 146000000, '{"ultraballs": 20}'),
  (50, 176000000, '{"ultraballs": 30, "masterballs": 2}')
ON CONFLICT (level) DO NOTHING;

CREATE TABLE IF NOT EXISTS trainer_level_ups (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_level  SMALLINT NOT NULL,
  to_level    SMALLINT NOT NULL,
  xp          BIGINT NOT NULL,
  rewards     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 跨越的各等级奖励之和
  claimed_at  TIMESTAMPTZ,                          -- 奖励已发放时间（由奖励服务写入）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trainer_level_ups_user ON trainer_level_ups (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trainer_level_ups_unclaimed ON trainer_level_ups (user_id) WHERE claimed_at IS NULL;

CREATE OR REPLACE FUNCTION trainer_level_for_xp(p_xp BIGINT) RETURNS SMALLINT AS $$
  SELECT COALESCE(MAX(level), 1)::SMALLINT FROM trainer_levels WHERE total_xp <= GREATEST(p_xp, 0);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION users_sync_trainer_level() RETURNS trigger AS $$
DECLARE
  new_level SMALLINT := trainer_level_for_xp(NEW.xp);
BEGIN
  -- 只升不降（经验回滚/管理员调整不会让玩家掉级）
  IF TG_OP = 'UPDATE' THEN
    new_level := GREATEST(new_level, OLD.level);
  END IF;
  NEW.level := LEAST(new_level, 50);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION users_log_trainer_level_up() RETURNS trigger AS $$
BEGIN
  IF NEW.level > OLD.level THEN
    INSERT INTO trainer_level_ups (user_id, from_level, to_level, xp, rewards)
    SELECT NEW.id, OLD.level, NEW.level, NEW.xp,
           COALESCE((SELECT jsonb_object_agg(k, total) FROM (
              SELECT e.key AS k, SUM((e.value)::bigint) AS total
                FROM trainer_levels tl, jsonb_each_text(tl.reward_items) e
               WHERE tl.level > OLD.level AND tl.level <= NEW.level
               GROUP BY e.key) s), '{}'::jsonb);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_sync_trainer_level ON users;
CREATE TRIGGER trg_users_sync_trainer_level
  BEFORE INSERT OR UPDATE OF xp ON users
  FOR EACH ROW EXECUTE FUNCTION users_sync_trainer_level();

DROP TRIGGER IF EXISTS trg_users_log_trainer_level_up ON users;
CREATE TRIGGER trg_users_log_trainer_level_up
  AFTER UPDATE OF xp, level ON users   -- 列级触发只看 SET 子句里的列：加经验的语句只 SET xp
  FOR EACH ROW WHEN (NEW.level > OLD.level)
  EXECUTE FUNCTION users_log_trainer_level_up();

-- 已有玩家按现有经验校正等级（只升不降）
UPDATE users SET level = LEAST(GREATEST(level, trainer_level_for_xp(xp)), 50)
 WHERE level < trainer_level_for_xp(xp);

-- migrate:down
DROP TRIGGER IF EXISTS trg_users_log_trainer_level_up ON users;
DROP TRIGGER IF EXISTS trg_users_sync_trainer_level ON users;
DROP FUNCTION IF EXISTS users_log_trainer_level_up();
DROP FUNCTION IF EXISTS users_sync_trainer_level();
DROP FUNCTION IF EXISTS trainer_level_for_xp(BIGINT);
DROP TABLE IF EXISTS trainer_level_ups;
DROP TABLE IF EXISTS trainer_levels;
