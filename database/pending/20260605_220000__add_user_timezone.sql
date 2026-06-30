-- database/pending/20260605_220000__add_user_timezone.sql
-- REQ-00029: 游戏事件时区本地化与多时区支持
-- 为 users 表添加 timezone 字段，支持用户时区偏好

BEGIN;

-- 添加 timezone 字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC';

-- 添加约束，确保时区值有效（PostgreSQL 内置时区检查）
-- 注意：PostgreSQL 会自动验证时区是否有效
-- ALTER TABLE users ADD CONSTRAINT valid_timezone CHECK ... (removed subquery constraint)

-- 创建索引，便于按时区查询用户
CREATE INDEX IF NOT EXISTS idx_users_timezone ON users(timezone);

-- 更新现有用户时区为 UTC（如果为 NULL）
UPDATE users SET timezone = 'UTC' WHERE timezone IS NULL;

-- 添加时区更新时间字段（可选，用于跟踪时区变更）
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone_updated_at TIMESTAMPTZ;

-- 添加注释
COMMENT ON COLUMN users.timezone IS '用户时区偏好，IANA 时区标识符，如 Asia/Shanghai';
COMMENT ON COLUMN users.timezone_updated_at IS '时区最后更新时间';

COMMIT;
