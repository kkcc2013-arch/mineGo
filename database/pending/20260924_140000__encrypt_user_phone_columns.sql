-- migrate:up
-- REQ-00565: 手机号改为应用层 AES-256-GCM 密文存储，VARCHAR(20) 放不下密文；
-- phone_hash 改作 HMAC-SHA256 盲索引（64 位 hex，已有 UNIQUE 约束），用于按手机号精确查询。
-- 历史明文数据由 scripts/encrypt-user-phones.js 回填（可重复执行）。
ALTER TABLE users ALTER COLUMN phone TYPE TEXT;
COMMENT ON COLUMN users.phone IS 'AES-256-GCM 密文（enc:v1:<kid>:...），未迁移的历史行可能仍为明文';
COMMENT ON COLUMN users.phone_hash IS 'HMAC-SHA256 盲索引（FIELD_HASH_KEY），用于登录/注册查询';

-- migrate:down
-- 注意：回滚前必须先用脚本解密，否则密文长度超过 20
ALTER TABLE users ALTER COLUMN phone TYPE VARCHAR(20);
