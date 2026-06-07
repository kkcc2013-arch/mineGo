-- database/pending/20260607_000000__add_push_notification_preferences.sql
-- Multi-channel push notification preferences and logging

-- 用户推送偏好表
CREATE TABLE IF NOT EXISTS user_push_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT,
  apns_token TEXT,
  preferred_channels TEXT[] NOT NULL DEFAULT ARRAY['websocket', 'fcm', 'apns'],
  notification_types JSONB NOT NULL DEFAULT '{
    "gym_raid": true,
    "friend_request": true,
    "trade_request": true,
    "reward": true,
    "system": true
  }',
  quiet_hours JSONB DEFAULT '{"enabled": false, "start": "22:00", "end": "08:00"}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

COMMENT ON TABLE user_push_preferences IS '用户推送通知偏好设置';
COMMENT ON COLUMN user_push_preferences.fcm_token IS 'Firebase Cloud Messaging 设备 Token';
COMMENT ON COLUMN user_push_preferences.apns_token IS 'Apple Push Notification service 设备 Token';
COMMENT ON COLUMN user_push_preferences.preferred_channels IS '推送渠道优先级（按顺序尝试）';
COMMENT ON COLUMN user_push_preferences.notification_types IS '各类型通知开关';
COMMENT ON COLUMN user_push_preferences.quiet_hours IS '静默时段配置';

-- 推送日志表
CREATE TABLE IF NOT EXISTS push_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel VARCHAR(20) NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  title TEXT,
  body TEXT,
  payload JSONB,
  success BOOLEAN NOT NULL,
  message_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE push_logs IS '推送通知日志';
COMMENT ON COLUMN push_logs.channel IS '推送渠道：websocket/fcm/apns/all';
COMMENT ON COLUMN push_logs.notification_type IS '通知类型：gym_raid/friend_request/trade_request/reward/system';
COMMENT ON COLUMN push_logs.success IS '是否推送成功';
COMMENT ON COLUMN push_logs.message_id IS '推送平台返回的消息ID';

CREATE INDEX IF NOT EXISTS idx_push_logs_user_created ON push_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_logs_channel ON push_logs(channel, created_at);
CREATE INDEX IF NOT EXISTS idx_push_logs_type ON push_logs(notification_type, created_at);

-- 为现有用户创建默认推送偏好
INSERT INTO user_push_preferences (user_id)
SELECT id FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM user_push_preferences WHERE user_push_preferences.user_id = users.id
);

-- 更新触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_push_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_push_preferences_updated_at
  BEFORE UPDATE ON user_push_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_push_preferences_updated_at();
