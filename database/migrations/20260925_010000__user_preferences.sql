-- Epic E21（客户端无障碍）：通用用户偏好表，按 namespace 存 JSONB
-- 用途：无障碍设置（namespace='a11y'）跨设备同步；数据删除系统（REQ-00127）已把 user_preferences 登记为 user-service 数据
-- 幂等：可重复执行
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace         VARCHAR(32) NOT NULL,
  prefs             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  version           INTEGER     NOT NULL DEFAULT 1,
  client_updated_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, namespace)
);

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_preferences_namespace ON user_preferences (namespace);

COMMENT ON TABLE user_preferences IS 'Epic E21: 用户偏好（按 namespace 的 JSONB 文档，如 a11y 无障碍设置）';
