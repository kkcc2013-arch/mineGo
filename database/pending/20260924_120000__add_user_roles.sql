-- migrate:up
-- 管理员角色来源：shared/auth.requireAdmin 校验 token 中的 roles 是否包含 'admin'，
-- 此前 users 表没有任何角色字段，所有管理接口要么无鉴权、要么永远不可用。
-- 授予管理员：UPDATE users SET roles = array_append(roles, 'admin') WHERE id = '<uuid>';
ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_users_roles ON users USING GIN (roles);

-- migrate:down
DROP INDEX IF EXISTS idx_users_roles;
ALTER TABLE users DROP COLUMN IF EXISTS roles;
