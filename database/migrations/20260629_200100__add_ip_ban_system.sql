-- REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
-- 数据库迁移文件

-- IP 黑名单表
CREATE TABLE IF NOT EXISTS ip_blacklist (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,           -- 支持 CIDR，如 192.168.1.0/24
  reason VARCHAR(500) NOT NULL,       -- 封禁原因
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  is_auto BOOLEAN DEFAULT false,      -- 是否自动封禁
  blocked_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,               -- NULL 表示永久封禁
  blocked_by INTEGER REFERENCES users(id), -- 封禁操作人
  created_at TIMESTAMP DEFAULT NOW()
);

-- IP 白名单表
CREATE TABLE IF NOT EXISTS ip_whitelist (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  description VARCHAR(500),
  added_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- IP 风险评分表
CREATE TABLE IF NOT EXISTS ip_risk_scores (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL UNIQUE,
  risk_score INTEGER DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),  -- 0-100
  violation_count INTEGER DEFAULT 0,  -- 违规次数
  last_violation_at TIMESTAMP,
  last_access_at TIMESTAMP,
  country_code VARCHAR(2),            -- ISO 3166-1 国家代码
  city VARCHAR(100),
  isp VARCHAR(200),                   -- ISP 信息
  is_vpn BOOLEAN DEFAULT false,       -- 是否为 VPN/代理
  is_tor BOOLEAN DEFAULT false,       -- 是否为 Tor 出口节点
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- IP 封禁申诉表
CREATE TABLE IF NOT EXISTS ip_ban_appeals (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  user_id INTEGER REFERENCES users(id),
  appeal_reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  review_note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- IP 访问日志表（用于风险评分计算）
CREATE TABLE IF NOT EXISTS ip_access_logs (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  user_id INTEGER,
  endpoint VARCHAR(200),
  method VARCHAR(10),
  status_code INTEGER,
  response_time_ms INTEGER,
  is_blocked BOOLEAN DEFAULT false,
  block_reason VARCHAR(100),
  user_agent VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- IP 触发事件表（用于自动封禁判断）
CREATE TABLE IF NOT EXISTS ip_trigger_events (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,  -- gps_cheat, device_anomaly, captcha_fail, rate_limit, tor_exit, vpn_proxy
  user_id INTEGER,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 地理位置封禁表
CREATE TABLE IF NOT EXISTS geo_ban (
  id SERIAL PRIMARY KEY,
  country_code VARCHAR(2) NOT NULL,   -- ISO 3166-1 国家代码
  reason VARCHAR(500) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  banned_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_ip_blacklist_ip ON ip_blacklist USING gist(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_blacklist_blocked_at ON ip_blacklist(blocked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_blacklist_severity ON ip_blacklist(severity);
CREATE INDEX IF NOT EXISTS idx_ip_blacklist_expires ON ip_blacklist(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ip_whitelist_ip ON ip_whitelist USING gist(ip_address);

CREATE INDEX IF NOT EXISTS idx_ip_risk_scores_ip ON ip_risk_scores(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_risk_scores_score ON ip_risk_scores(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_ip_risk_scores_country ON ip_risk_scores(country_code);

CREATE INDEX IF NOT EXISTS idx_ip_ban_appeals_ip ON ip_ban_appeals(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_ban_appeals_status ON ip_ban_appeals(status);
CREATE INDEX IF NOT EXISTS idx_ip_ban_appeals_user ON ip_ban_appeals(user_id);
CREATE INDEX IF NOT EXISTS idx_ip_ban_appeals_created ON ip_ban_appeals(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ip_access_logs_ip ON ip_access_logs(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_access_logs_created ON ip_access_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_access_logs_blocked ON ip_access_logs(is_blocked) WHERE is_blocked = true;

CREATE INDEX IF NOT EXISTS idx_ip_trigger_events_ip ON ip_trigger_events(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_trigger_events_type ON ip_trigger_events(trigger_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_geo_ban_country ON geo_ban(country_code);
CREATE INDEX IF NOT EXISTS idx_geo_ban_active ON geo_ban(is_active) WHERE is_active = true;

-- 创建清理触发事件的定时任务函数
CREATE OR REPLACE FUNCTION cleanup_old_trigger_events()
RETURNS void AS $$
BEGIN
  DELETE FROM ip_trigger_events 
  WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- 创建清理访问日志的定时任务函数
CREATE OR REPLACE FUNCTION cleanup_old_access_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM ip_access_logs 
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- 插入初始地理位置封禁配置（可选）
-- 示例：封禁已知高风险地区
-- INSERT INTO geo_ban (country_code, reason, banned_by) VALUES
--   ('XX', '示例封禁 - 高风险地区', 1);

-- 添加注释
COMMENT ON TABLE ip_blacklist IS 'IP 黑名单表，记录被封禁的 IP 地址';
COMMENT ON TABLE ip_whitelist IS 'IP 白名单表，记录被放行的可信 IP 地址';
COMMENT ON TABLE ip_risk_scores IS 'IP 风险评分表，记录每个 IP 的风险分数和行为历史';
COMMENT ON TABLE ip_ban_appeals IS 'IP 封禁申诉表，记录用户提交的申诉和审核结果';
COMMENT ON TABLE ip_access_logs IS 'IP 访问日志表，用于风险评分计算和访问分析';
COMMENT ON TABLE ip_trigger_events IS 'IP 触发事件表，记录自动封禁触发事件';
COMMENT ON TABLE geo_ban IS '地理位置封禁表，按国家/地区封禁 IP';

-- 验证表结构
DO $$
BEGIN
  -- 验证所有表已创建
  IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'ip_blacklist') THEN
    RAISE EXCEPTION 'ip_blacklist table not created';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'ip_whitelist') THEN
    RAISE EXCEPTION 'ip_whitelist table not created';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'ip_risk_scores') THEN
    RAISE EXCEPTION 'ip_risk_scores table not created';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'ip_ban_appeals') THEN
    RAISE EXCEPTION 'ip_ban_appeals table not created';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'ip_access_logs') THEN
    RAISE EXCEPTION 'ip_access_logs table not created';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'ip_trigger_events') THEN
    RAISE EXCEPTION 'ip_trigger_events table not created';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'geo_ban') THEN
    RAISE EXCEPTION 'geo_ban table not created';
  END IF;
  
  RAISE NOTICE 'REQ-00075: IP 封禁系统数据库迁移完成';
END $$;