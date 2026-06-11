-- REQ-00099: 游戏消息中心与通知管理系统
-- 数据库索引优化与扩展

-- ============================================================
-- 1. 添加索引优化查询性能
-- ============================================================

-- 通知列表查询优化（按用户+状态+时间）
CREATE INDEX IF NOT EXISTS idx_notification_history_user_status_time 
ON notification_history(user_id, read, created_at DESC);

-- 通知列表查询优化（按用户+类型+时间）
CREATE INDEX IF NOT EXISTS idx_notification_history_user_type_time 
ON notification_history(user_id, notification_type, created_at DESC);

-- 未读数量统计优化（部分索引）
CREATE INDEX IF NOT EXISTS idx_notification_history_user_unread 
ON notification_history(user_id) WHERE read = false;

-- ============================================================
-- 2. 添加通知偏好扩展字段
-- ============================================================

-- 检查 user_push_preferences 表是否存在
DO $$ 
BEGIN
  -- 添加免打扰时段字段（如果不存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_push_preferences' 
    AND column_name = 'quiet_hours'
  ) THEN
    ALTER TABLE user_push_preferences 
    ADD COLUMN quiet_hours JSONB DEFAULT '{"enabled": false, "start": "22:00", "end": "08:00"}'::jsonb;
  END IF;
END $$;

-- ============================================================
-- 3. 添加通知统计视图
-- ============================================================

CREATE OR REPLACE VIEW notification_stats AS
SELECT 
  user_id,
  COUNT(*) AS total_count,
  COUNT(*) FILTER (WHERE read = false) AS unread_count,
  COUNT(*) FILTER (WHERE read = true) AS read_count,
  COUNT(*) FILTER (WHERE notification_type = 'RARE_SPAWN') AS rare_spawn_count,
  COUNT(*) FILTER (WHERE notification_type = 'RAID_STARTED') AS raid_count,
  COUNT(*) FILTER (WHERE notification_type = 'FRIEND_REQUEST') AS friend_request_count,
  COUNT(*) FILTER (WHERE notification_type = 'QUEST_COMPLETE') AS quest_count,
  COUNT(*) FILTER (WHERE notification_type = 'SYSTEM') AS system_count,
  MAX(created_at) AS last_notification_at
FROM notification_history
GROUP BY user_id;

-- ============================================================
-- 4. 添加清理已读通知的函数
-- ============================================================

CREATE OR REPLACE FUNCTION clear_read_notifications(
  p_user_id VARCHAR(50),
  p_before_date TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days'
)
RETURNS INTEGER AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM notification_history
  WHERE user_id = p_user_id
    AND read = true
    AND created_at < p_before_date;
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. 添加批量标记已读的函数
-- ============================================================

CREATE OR REPLACE FUNCTION mark_notifications_read(
  p_user_id VARCHAR(50),
  p_notification_ids UUID[] DEFAULT NULL,
  p_mark_all BOOLEAN DEFAULT false
)
RETURNS INTEGER AS $$
DECLARE
  v_updated_count INTEGER;
BEGIN
  IF p_mark_all THEN
    -- 标记所有未读通知为已读
    UPDATE notification_history
    SET read = true, read_at = NOW()
    WHERE user_id = p_user_id AND read = false;
  ELSIF p_notification_ids IS NOT NULL THEN
    -- 标记指定通知为已读
    UPDATE notification_history
    SET read = true, read_at = NOW()
    WHERE user_id = p_user_id 
      AND id = ANY(p_notification_ids)
      AND read = false;
  ELSE
    RETURN 0;
  END IF;
  
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  
  RETURN v_updated_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. 添加通知过期自动清理（TTL 90 天）
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_expired_notifications()
RETURNS INTEGER AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM notification_history
  WHERE created_at < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 说明
-- ============================================================
-- 本迁移为 REQ-00099 游戏消息中心与通知管理系统提供数据库支持
-- 
-- 新增功能：
-- 1. 通知列表查询优化索引（支持按状态、类型筛选）
-- 2. 未读数量统计优化索引（部分索引，仅索引未读记录）
-- 3. 通知统计视图（快速获取用户通知统计）
-- 4. 清理已读通知函数（支持批量清理）
-- 5. 批量标记已读函数（支持全部标记或指定标记）
-- 6. 通知过期自动清理函数（TTL 90 天）
