-- Migration: Add notification system tables
-- Requirement: REQ-00026 - 游戏内实时推送通知系统
-- Created: 2026-06-05

-- ============================================================
-- 用户通知偏好表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rare_spawn BOOLEAN DEFAULT TRUE,
  raid_started BOOLEAN DEFAULT TRUE,
  friend_request BOOLEAN DEFAULT TRUE,
  gift_received BOOLEAN DEFAULT TRUE,
  quest_complete BOOLEAN DEFAULT TRUE,
  gym_under_attack BOOLEAN DEFAULT TRUE,
  gym_lost BOOLEAN DEFAULT FALSE,
  sound_enabled BOOLEAN DEFAULT TRUE,
  vibration_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 为更新时间创建触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_notification_preferences_updated_at
  BEFORE UPDATE ON user_notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 通知历史表
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_history (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  data JSONB NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引：按用户和时间查询
CREATE INDEX IF NOT EXISTS idx_notification_history_user_created 
  ON notification_history(user_id, created_at DESC);

-- 索引：按用户和已读状态查询
CREATE INDEX IF NOT EXISTS idx_notification_history_user_read 
  ON notification_history(user_id, read) 
  WHERE read = FALSE;

-- ============================================================
-- 自动清理旧通知的函数（保留最近 50 条）
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS void AS $$
BEGIN
  DELETE FROM notification_history
  WHERE id IN (
    SELECT id FROM notification_history
    WHERE user_id IN (SELECT DISTINCT user_id FROM notification_history)
    ORDER BY created_at DESC
    OFFSET 50
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 初始数据：为新用户自动创建默认偏好
-- ============================================================
CREATE OR REPLACE FUNCTION create_default_notification_preferences()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_notification_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_create_default_notification_preferences
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_default_notification_preferences();

-- ============================================================
-- 注释
-- ============================================================
COMMENT ON TABLE user_notification_preferences IS 
  '用户通知偏好设置 - REQ-00026';
COMMENT ON TABLE notification_history IS 
  '通知历史记录 - REQ-00026，保留每个用户最近 50 条';
COMMENT ON COLUMN notification_history.type IS 
  '通知类型: RARE_SPAWN, RAID_STARTED, FRIEND_REQUEST, GIFT_RECEIVED, QUEST_COMPLETE, GYM_UNDER_ATTACK, GYM_LOST';
COMMENT ON COLUMN notification_history.data IS 
  '通知数据 JSONB，结构因类型而异';
