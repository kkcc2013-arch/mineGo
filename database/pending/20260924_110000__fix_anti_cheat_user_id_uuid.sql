-- migrate:up
-- REQ-00586: 反作弊记录表的 user_id 原为 INTEGER，而 users.id 是 UUID，
-- 所有写入都静默失败（异常被吞掉），反作弊证据从未落库。
-- 非破坏性修复：旧列改名保留，新增 UUID 列。
DO $$
BEGIN
  IF (SELECT udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'anti_cheat_records' AND column_name = 'user_id') = 'int4' THEN
    ALTER TABLE anti_cheat_records RENAME COLUMN user_id TO legacy_user_id;
    ALTER TABLE anti_cheat_records ALTER COLUMN legacy_user_id DROP NOT NULL;
    ALTER TABLE anti_cheat_records ADD COLUMN user_id UUID;
  END IF;
  IF (SELECT udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'user_location_history' AND column_name = 'user_id') = 'int4' THEN
    ALTER TABLE user_location_history RENAME COLUMN user_id TO legacy_user_id;
    ALTER TABLE user_location_history ALTER COLUMN legacy_user_id DROP NOT NULL;
    ALTER TABLE user_location_history ADD COLUMN user_id UUID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_anticheat_user_uuid ON anti_cheat_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_location_history_user_uuid ON user_location_history(user_id, recorded_at DESC);

-- migrate:down
DROP INDEX IF EXISTS idx_anticheat_user_uuid;
DROP INDEX IF EXISTS idx_location_history_user_uuid;
