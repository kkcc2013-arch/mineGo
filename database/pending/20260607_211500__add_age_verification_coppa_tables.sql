-- REQ-00034: COPPA 合规与未成年人年龄验证系统
-- 创建用户年龄档案表和家长同意记录表

-- 用户年龄档案表
CREATE TABLE IF NOT EXISTS user_age_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  birth_date DATE,
  age_bracket VARCHAR(20) NOT NULL DEFAULT 'unknown', -- 'under_13', '13_17', '18_plus', 'unknown'
  parent_email VARCHAR(255),
  parent_consent_status VARCHAR(20) NOT NULL DEFAULT 'not_required', -- 'pending', 'verified', 'denied', 'not_required'
  parent_consent_token VARCHAR(255),
  parent_consent_expires_at TIMESTAMP,
  consent_verified_at TIMESTAMP,
  daily_play_limit_minutes INTEGER DEFAULT 60,
  monthly_spend_limit_cents INTEGER DEFAULT 0,
  features_disabled TEXT[] DEFAULT '{}', -- ['social', 'trade', 'payment']
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 家长同意操作日志表
CREATE TABLE IF NOT EXISTS parent_consent_logs (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_email VARCHAR(255) NOT NULL,
  action VARCHAR(50) NOT NULL, -- 'sent', 'verified', 'denied', 'revoked', 'resent'
  ip_address VARCHAR(45),
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 游戏时间记录表（按天统计）
CREATE TABLE IF NOT EXISTS user_play_time_daily (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_date DATE NOT NULL,
  total_minutes INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, play_date)
);

-- 月度消费统计表
CREATE TABLE IF NOT EXISTS user_monthly_spend (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year_month VARCHAR(7) NOT NULL, -- 'YYYY-MM'
  total_cents BIGINT DEFAULT 0,
  transaction_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, year_month)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_age_profiles_age_bracket ON user_age_profiles(age_bracket);
CREATE INDEX IF NOT EXISTS idx_user_age_profiles_parent_consent_status ON user_age_profiles(parent_consent_status);
CREATE INDEX IF NOT EXISTS idx_user_age_profiles_parent_email ON user_age_profiles(parent_email);
CREATE INDEX IF NOT EXISTS idx_parent_consent_logs_user_id ON parent_consent_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_parent_consent_logs_parent_email ON parent_consent_logs(parent_email);
CREATE INDEX IF NOT EXISTS idx_user_play_time_daily_user_date ON user_play_time_daily(user_id, play_date);
CREATE INDEX IF NOT EXISTS idx_user_monthly_spend_user_month ON user_monthly_spend(user_id, year_month);

-- 注释
COMMENT ON TABLE user_age_profiles IS 'REQ-00034: 用户年龄档案，用于 COPPA 合规';
COMMENT ON TABLE parent_consent_logs IS 'REQ-00034: 家长同意操作审计日志';
COMMENT ON TABLE user_play_time_daily IS 'REQ-00034: 用户每日游戏时间统计';
COMMENT ON TABLE user_monthly_spend IS 'REQ-00034: 用户月度消费统计';
