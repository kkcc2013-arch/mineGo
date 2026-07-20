/**
 * 数据库迁移：用户时区偏好和活动时区支持
 * REQ-00612: 全球化业务实时时区调度与跨区协作支持系统
 */

-- 用户时区偏好表
CREATE TABLE IF NOT EXISTS user_timezone_preferences (
  user_id VARCHAR(100) PRIMARY KEY,
  timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
  auto_detect BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ,
  
  CONSTRAINT valid_timezone CHECK (timezone IN (
    'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 
    'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 
    'Australia/Sydney'
  ))
);

-- 为 events 表添加时区相关字段
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_timezone_relative BOOLEAN DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS target_timezone VARCHAR(100);

-- 添加注释
COMMENT ON TABLE user_timezone_preferences IS '用户时区偏好配置表';
COMMENT ON COLUMN user_timezone_preferences.timezone IS '用户偏好时区';
COMMENT ON COLUMN user_timezone_preferences.auto_detect IS '是否自动检测时区（基于IP）';
COMMENT ON COLUMN events.is_timezone_relative IS '活动是否使用相对时间（用户本地时间）';
COMMENT ON COLUMN events.target_timezone IS '目标时区（相对时间模式）';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_user_timezone_timezone ON user_timezone_preferences(timezone);
CREATE INDEX IF NOT EXISTS idx_events_timezone_relative ON events(is_timezone_relative);
CREATE INDEX IF NOT EXISTS idx_events_target_timezone ON events(target_timezone);

-- 插入测试数据
INSERT INTO user_timezone_preferences (user_id, timezone, auto_detect, updated_at)
VALUES 
  ('test-user-1', 'Asia/Shanghai', false, NOW()),
  ('test-user-2', 'America/New_York', true, NOW())
ON CONFLICT (user_id) DO NOTHING;

-- 插入测试活动
INSERT INTO events (name, description, start_time, end_time, is_timezone_relative, target_timezone, type, rewards, metadata)
VALUES 
  (
    '限时挑战赛',
    '北京时间 20:00 开启的限时活动',
    NOW() + INTERVAL '2 hours',
    NOW() + INTERVAL '4 hours',
    false,
    null,
    'challenge',
    '{"coins": 1000, "items": ["rare_candy"]}',
    '{"difficulty": "hard"}'
  ),
  (
    '全球庆祝活动',
    '每个地区当地时间 18:00 开启',
    NOW() + INTERVAL '1 hour',
    NOW() + INTERVAL '24 hours',
    true,
    'Asia/Shanghai',
    'global',
    '{"coins": 500, "items": ["lucky_egg"]}',
    '{"regions": ["asia", "america", "europe"]}'
  )
ON CONFLICT DO NOTHING;
