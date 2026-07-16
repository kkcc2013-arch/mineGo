-- REQ-00578: 未成年人保护事件表
-- 记录强制下线、时长限制触发等事件

CREATE TABLE IF NOT EXISTS minor_protection_events (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  event_type VARCHAR(50) NOT NULL,  -- force_logout, curfew_start, limit_exceeded
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_minor_protection_user_id ON minor_protection_events(user_id);
CREATE INDEX IF NOT EXISTS idx_minor_protection_event_type ON minor_protection_events(event_type);
CREATE INDEX IF NOT EXISTS idx_minor_protection_created_at ON minor_protection_events(created_at);

-- 确保 user_play_time_daily 表存在
CREATE TABLE IF NOT EXISTS user_play_time_daily (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  play_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_minutes INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, play_date)
);

CREATE INDEX IF NOT EXISTS idx_play_time_user_date ON user_play_time_daily(user_id, play_date);

-- 确保 user_age_profiles 表的 daily_play_limit_minutes 字段适合13-17岁
-- 13-17岁默认90分钟限制
UPDATE user_age_profiles 
SET daily_play_limit_minutes = 90
WHERE age_bracket = '13_17' 
  AND daily_play_limit_minutes IS NULL;