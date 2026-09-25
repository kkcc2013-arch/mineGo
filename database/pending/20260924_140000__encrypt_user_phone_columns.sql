-- migrate:up
-- REQ-00565: 手机号改为应用层 AES-256-GCM 密文存储，VARCHAR(20) 放不下密文；
-- phone_hash 改作 HMAC-SHA256 盲索引（64 位 hex，已有 UNIQUE 约束），用于按手机号精确查询。
-- 历史明文数据由 scripts/encrypt-user-phones.js 回填（可重复执行）。
-- 已有视图引用 users.phone 时（如隐私政策迁移中的 user_policy_status）不能直接改类型：先保存定义并删除这些视图，改完再按原定义重建
DO $enc$ DECLARE r RECORD; names TEXT[] := '{}'; defs TEXT[] := '{}'; i INT;
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone') <> 'text' THEN
    FOR r IN SELECT DISTINCT v.oid, v.relname
               FROM pg_depend d
               JOIN pg_rewrite rw ON rw.oid = d.objid
               JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind = 'v'
               JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
              WHERE d.refobjid = 'public.users'::regclass AND a.attname = 'phone' LOOP
      names := names || r.relname::text;
      defs := defs || pg_get_viewdef(r.oid);
      EXECUTE format('DROP VIEW %I', r.relname);
    END LOOP;
    ALTER TABLE users ALTER COLUMN phone TYPE TEXT;
    FOR i IN 1..COALESCE(array_length(names, 1), 0) LOOP
      EXECUTE format('CREATE VIEW %I AS %s', names[i], defs[i]);
    END LOOP;
  END IF;
END $enc$;
COMMENT ON COLUMN users.phone IS 'AES-256-GCM 密文（enc:v1:<kid>:...），未迁移的历史行可能仍为明文';
COMMENT ON COLUMN users.phone_hash IS 'HMAC-SHA256 盲索引（FIELD_HASH_KEY），用于登录/注册查询';

-- migrate:down
-- 注意：回滚前必须先用脚本解密，否则密文长度超过 20
ALTER TABLE users ALTER COLUMN phone TYPE VARCHAR(20);
