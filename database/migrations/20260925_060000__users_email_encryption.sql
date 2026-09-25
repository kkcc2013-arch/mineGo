-- migrate:up
-- REQ-00565：users.email 按敏感字段加密存储（AES-256-GCM 密文，与 users.phone 相同方案），
-- email_hash 为 HMAC-SHA256 盲索引（小写规范化后计算），用于精确查找与唯一约束。
ALTER TABLE users ALTER COLUMN email TYPE TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_hash ON users (email_hash) WHERE email_hash IS NOT NULL;
-- 密文不能再做 lower(email) 唯一约束（明文唯一由 email_hash 保证）
DROP INDEX IF EXISTS uq_users_email_lower;
COMMENT ON COLUMN users.email IS 'AES-256-GCM 密文（enc:v1:<kid>:...）；未配置加密密钥的环境为明文';
COMMENT ON COLUMN users.email_hash IS 'HMAC-SHA256 盲索引（小写规范化，FIELD_HASH_KEY）';

-- migrate:down
DROP INDEX IF EXISTS uq_users_email_hash;
ALTER TABLE users DROP COLUMN IF EXISTS email_hash;
