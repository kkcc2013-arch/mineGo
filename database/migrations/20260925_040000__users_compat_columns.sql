-- migrate:up
-- users 兼容列：28 个服务/共享模块的 SQL 读取 users.username（V1 中只有 nickname），11 处读取 users.email。
-- 好友搜索/请求列表/礼物/好友排行等接口因此全部 500。
--   * username：由 nickname 生成的只读列（STORED），与昵称始终一致，代码无需逐处修改
--   * email：可空的联系邮箱（隐私通知、数据导出等功能使用；注册仍只需手机号）

DO $compat$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'username') THEN
    ALTER TABLE users ADD COLUMN username VARCHAR(30) GENERATED ALWAYS AS (nickname) STORED;
  END IF;
END $compat$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;
-- 昵称/用户名模糊搜索（好友搜索）：需要 pg_trgm，不可用时跳过（查询仍可执行，只是没有索引）
DO $trgm$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_users_nickname_trgm ON users USING gin (nickname gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm 不可用，跳过昵称模糊搜索索引：%', SQLERRM;
END $trgm$;

-- migrate:down
DROP INDEX IF EXISTS idx_users_nickname_trgm;
DROP INDEX IF EXISTS uq_users_email_lower;
ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users DROP COLUMN IF EXISTS username;
