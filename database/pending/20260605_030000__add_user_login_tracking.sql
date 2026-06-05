-- migrate:up
-- Add user last login IP tracking for security audit
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip INET;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;

-- Add index for IP-based queries (useful for detecting suspicious patterns)
CREATE INDEX IF NOT EXISTS idx_users_last_login_ip ON users(last_login_ip) WHERE last_login_ip IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS idx_users_last_login_ip;
ALTER TABLE users DROP COLUMN IF EXISTS login_count;
ALTER TABLE users DROP COLUMN IF EXISTS last_login_ip;
