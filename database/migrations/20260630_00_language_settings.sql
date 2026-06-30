-- database/migrations/20260630_00_language_settings.sql - REQ-00393 动态语言切换无需重新登录系统

-- 1. 添加语言字段和更新时间字段（如果不存在）
DO $$ 
BEGIN
  -- 添加 language 字段
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'language') THEN
    ALTER TABLE users ADD COLUMN language VARCHAR(10) DEFAULT 'en';
  END IF;
  
  -- 添加 language_updated_at 字段
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'language_updated_at') THEN
    ALTER TABLE users ADD COLUMN language_updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

-- 2. 创建语言变更日志表
CREATE TABLE IF NOT EXISTS language_change_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  previous_language VARCHAR(10) NOT NULL,
  new_language VARCHAR(10) NOT NULL,
  change_source VARCHAR(50) NOT NULL DEFAULT 'user_request',
  session_preserved BOOLEAN DEFAULT TRUE,
  ip_address INET,
  device_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_language_change_logs_user ON language_change_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_language_change_logs_time ON language_change_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_language ON users(language);

-- 4. 创建语言使用统计视图
CREATE OR REPLACE VIEW language_usage_stats AS
SELECT 
  language,
  COUNT(*) as user_count,
  COUNT(*) FILTER (WHERE language_updated_at > NOW() - INTERVAL '24 hours') as daily_changes,
  COUNT(*) FILTER (WHERE language_updated_at > NOW() - INTERVAL '7 days') as weekly_changes,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM users
GROUP BY language
ORDER BY user_count DESC;

-- 5. 创建语言变更触发器函数
CREATE OR REPLACE FUNCTION log_language_change()
RETURNS TRIGGER AS $$BEGIN
  IF OLD.language IS DISTINCT FROM NEW.language THEN
    INSERT INTO language_change_logs (
      user_id,
      previous_language,
      new_language,
      change_source
    ) VALUES (
      NEW.id,
      OLD.language,
      NEW.language,
      'user_request'
    );
    
    -- 发布通知（通过 pg_notify）
    NOTIFY 'language_changed', json_build_object(
      'userId', NEW.id,
      'previousLanguage', OLD.language,
      'newLanguage', NEW.language,
      'timestamp', EXTRACT(EPOCH FROM NOW()) * 1000
    )::text;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. 创建触发器（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_log_language_change') THEN
    CREATE TRIGGER trigger_log_language_change
    AFTER UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION log_language_change();
  END IF;
END $$;

-- 7. 插入默认语言数据（为现有用户）
UPDATE users SET language = 'en' WHERE language IS NULL OR language = '';

-- 8. 创建语言偏好缓存表（可选，用于快速查询）
CREATE TABLE IF NOT EXISTS language_cache (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  ttl_seconds INTEGER DEFAULT 3600
);

-- 9. 评论
COMMENT ON COLUMN users.language IS '用户偏好语言代码: zh, en, ja';
COMMENT ON COLUMN users.language_updated_at IS '语言偏好最后更新时间';
COMMENT ON TABLE language_change_logs IS 'REQ-00393: 语言变更日志表';
COMMENT ON VIEW language_usage_stats IS 'REQ-00393: 语言使用统计视图';

-- 完成
INSERT INTO schema_migrations (version, applied_at, description)
VALUES ('20260630_00', NOW(), 'REQ-00393: 动态语言切换无需重新登录系统 - 语言设置字段和日志表')
ON CONFLICT (version) DO NOTHING;