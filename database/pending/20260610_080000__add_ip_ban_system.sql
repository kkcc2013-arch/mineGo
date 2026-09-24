-- REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
-- 创建时间: 2026-06-10 08:20

-- IP 黑名单表
CREATE TABLE IF NOT EXISTS ip_blacklist (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  reason VARCHAR(500) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  is_auto BOOLEAN DEFAULT false,
  blocked_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  blocked_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS reason VARCHAR(500);
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS severity VARCHAR(20);
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS is_auto BOOLEAN DEFAULT false;
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMP DEFAULT NOW();
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS blocked_by UUID;
ALTER TABLE ip_blacklist ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ip_blacklist_ip ON ip_blacklist USING gist(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_blacklist_expires ON ip_blacklist(expires_at) WHERE expires_at IS NOT NULL;

-- IP 白名单表
CREATE TABLE IF NOT EXISTS ip_whitelist (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL UNIQUE,
  description VARCHAR(500),
  added_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE ip_whitelist ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE ip_whitelist ADD COLUMN IF NOT EXISTS description VARCHAR(500);
ALTER TABLE ip_whitelist ADD COLUMN IF NOT EXISTS added_by UUID;
ALTER TABLE ip_whitelist ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ip_whitelist_ip ON ip_whitelist USING gist(ip_address);

-- IP 风险评分表
CREATE TABLE IF NOT EXISTS ip_risk_scores (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL UNIQUE,
  risk_score INTEGER DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  violation_count INTEGER DEFAULT 0,
  last_violation_at TIMESTAMP,
  last_access_at TIMESTAMP,
  country_code VARCHAR(2),
  city VARCHAR(100),
  isp VARCHAR(200),
  is_vpn BOOLEAN DEFAULT false,
  is_tor BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS violation_count INTEGER DEFAULT 0;
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS last_violation_at TIMESTAMP;
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS last_access_at TIMESTAMP;
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS country_code VARCHAR(2);
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS isp VARCHAR(200);
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS is_vpn BOOLEAN DEFAULT false;
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS is_tor BOOLEAN DEFAULT false;
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE ip_risk_scores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ip_risk_scores_ip ON ip_risk_scores(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_risk_scores_score ON ip_risk_scores(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_ip_risk_scores_country ON ip_risk_scores(country_code);

-- IP 封禁申诉表
CREATE TABLE IF NOT EXISTS ip_ban_appeals (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  user_id UUID REFERENCES users(id),
  appeal_reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP,
  review_note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS appeal_reason TEXT;
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE ip_ban_appeals ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ip_ban_appeals_status ON ip_ban_appeals(status);
CREATE INDEX IF NOT EXISTS idx_ip_ban_appeals_user ON ip_ban_appeals(user_id);

-- IP 访问日志表（用于风险评分计算）
CREATE TABLE IF NOT EXISTS ip_access_logs (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  user_id UUID REFERENCES users(id),
  endpoint VARCHAR(200),
  method VARCHAR(10),
  status_code INTEGER,
  response_time_ms INTEGER,
  is_blocked BOOLEAN DEFAULT false,
  block_reason VARCHAR(100),
  user_agent VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS endpoint VARCHAR(200);
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS method VARCHAR(10);
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS status_code INTEGER;
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS response_time_ms INTEGER;
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false;
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS block_reason VARCHAR(100);
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS user_agent VARCHAR(500);
ALTER TABLE ip_access_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ip_access_logs_ip ON ip_access_logs(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_access_logs_created ON ip_access_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_access_logs_blocked ON ip_access_logs(is_blocked) WHERE is_blocked = true;

-- 地理位置封禁表
CREATE TABLE IF NOT EXISTS geo_bans (
  id SERIAL PRIMARY KEY,
  country_code VARCHAR(2) NOT NULL UNIQUE,
  reason VARCHAR(500),
  banned_by UUID REFERENCES users(id),
  banned_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE geo_bans ADD COLUMN IF NOT EXISTS country_code VARCHAR(2);
ALTER TABLE geo_bans ADD COLUMN IF NOT EXISTS reason VARCHAR(500);
ALTER TABLE geo_bans ADD COLUMN IF NOT EXISTS banned_by UUID;
ALTER TABLE geo_bans ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP DEFAULT NOW();
ALTER TABLE geo_bans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_geo_bans_country ON geo_bans(country_code);

-- 自动封禁触发记录表
CREATE TABLE IF NOT EXISTS auto_ban_triggers (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,  -- gps_cheat, device_anomaly, captcha_fail, rate_limit, tor_exit
  trigger_count INTEGER DEFAULT 1,
  first_triggered_at TIMESTAMP DEFAULT NOW(),
  last_triggered_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(ip_address, trigger_type)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE auto_ban_triggers ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE auto_ban_triggers ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(50);
ALTER TABLE auto_ban_triggers ADD COLUMN IF NOT EXISTS trigger_count INTEGER DEFAULT 1;
ALTER TABLE auto_ban_triggers ADD COLUMN IF NOT EXISTS first_triggered_at TIMESTAMP DEFAULT NOW();
ALTER TABLE auto_ban_triggers ADD COLUMN IF NOT EXISTS last_triggered_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_auto_ban_triggers_ip ON auto_ban_triggers(ip_address);
CREATE INDEX IF NOT EXISTS idx_auto_ban_triggers_type ON auto_ban_triggers(trigger_type);

-- 注释
COMMENT ON TABLE ip_blacklist IS 'IP 黑名单表';
COMMENT ON TABLE ip_whitelist IS 'IP 白名单表';
COMMENT ON TABLE ip_risk_scores IS 'IP 风险评分表';
COMMENT ON TABLE ip_ban_appeals IS 'IP 封禁申诉表';
COMMENT ON TABLE ip_access_logs IS 'IP 访问日志表';
COMMENT ON TABLE geo_bans IS '地理位置封禁表';
COMMENT ON TABLE auto_ban_triggers IS '自动封禁触发记录表';
