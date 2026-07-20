-- 威胁事件表
CREATE TABLE IF NOT EXISTS threat_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_id VARCHAR(64) UNIQUE NOT NULL,
  source_ip INET NOT NULL,
  user_id UUID,
  session_id VARCHAR(128),
  threat_score INT NOT NULL CHECK (threat_score >= 0 AND threat_score <= 100),
  threat_level VARCHAR(20) NOT NULL CHECK (threat_level IN ('normal', 'suspicious', 'threat', 'critical')),
  features JSONB NOT NULL,
  actions_taken JSONB DEFAULT '[]',
  feedback_label VARCHAR(20),
  feedback_comment TEXT,
  feedback_by UUID,
  feedback_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  CONSTRAINT valid_threat_level CHECK (threat_level IN ('normal', 'suspicious', 'threat', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_threat_events_source_ip ON threat_events(source_ip);
CREATE INDEX IF NOT EXISTS idx_threat_events_created_at ON threat_events(created_at);
CREATE INDEX IF NOT EXISTS idx_threat_events_threat_level ON threat_events(threat_level);
CREATE INDEX IF NOT EXISTS idx_threat_events_user_id ON threat_events(user_id);

COMMENT ON TABLE threat_events IS '威胁事件记录表';
COMMENT ON COLUMN threat_events.threat_id IS '唯一威胁标识';
COMMENT ON COLUMN threat_events.threat_score IS '威胁分数 (0-100)';
COMMENT ON COLUMN threat_events.threat_level IS '威胁等级';
COMMENT ON COLUMN threat_events.features IS '检测时的特征快照';
COMMENT ON COLUMN threat_events.actions_taken IS '执行的响应动作列表';
COMMENT ON COLUMN threat_events.feedback_label IS '反馈标签 (true_positive/false_positive/unknown)';

-- IP 封禁记录表
CREATE TABLE IF NOT EXISTS ip_bans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address INET UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  threat_id UUID REFERENCES threat_events(id),
  banned_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  banned_by VARCHAR(50) DEFAULT 'auto',
  unbanned_at TIMESTAMP,
  unbanned_by VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_ip_bans_ip ON ip_bans(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_bans_expires ON ip_bans(expires_at);
CREATE INDEX IF NOT EXISTS idx_ip_bans_active ON ip_bans(is_active);

COMMENT ON TABLE ip_bans IS 'IP封禁记录表';

-- 创建自动解封的触发器函数
CREATE OR REPLACE FUNCTION auto_unban_expired_ips()
RETURNS VOID AS $$
BEGIN
  UPDATE ip_bans 
  SET is_active = FALSE, unbanned_at = NOW(), unbanned_by = 'auto_expired'
  WHERE is_active = TRUE AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- 创建定时任务扩展（如果不存在）
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 每分钟检查一次过期的封禁
SELECT cron.schedule('auto_unban_ips', '* * * * *', $$SELECT auto_unban_expired_ips()$$);

-- 威胁反馈历史表
CREATE TABLE IF NOT EXISTS threat_feedback_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_id UUID REFERENCES threat_events(id),
  label VARCHAR(20) NOT NULL,
  comment TEXT,
  reviewer_id UUID NOT NULL,
  reviewed_at TIMESTAMP DEFAULT NOW(),
  model_version VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_threat_feedback_threat_id ON threat_feedback_history(threat_id);
CREATE INDEX IF NOT EXISTS idx_threat_feedback_reviewed_at ON threat_feedback_history(reviewed_at);

COMMENT ON TABLE threat_feedback_history IS '威胁反馈历史表';

-- 威胁统计聚合视图
CREATE OR REPLACE VIEW threat_statistics_daily AS
SELECT 
  DATE(created_at) AS stat_date,
  threat_level,
  COUNT(*) AS event_count,
  AVG(threat_score) AS avg_score,
  COUNT(DISTINCT source_ip) AS unique_ips,
  COUNT(DISTINCT user_id) AS unique_users,
  COUNT(*) FILTER (WHERE feedback_label = 'false_positive') AS false_positives,
  COUNT(*) FILTER (WHERE feedback_label = 'true_positive') AS true_positives
FROM threat_events
GROUP BY DATE(created_at), threat_level
ORDER BY stat_date DESC, threat_level;

COMMENT ON VIEW threat_statistics_daily IS '每日威胁统计聚合视图';