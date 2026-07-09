-- Error Analysis System Tables
-- Migration: 20260709090000-create-error-analysis-tables.sql

-- 错误聚合组表
CREATE TABLE IF NOT EXISTS error_groups (
  id VARCHAR(36) PRIMARY KEY,
  fingerprint VARCHAR(64) NOT NULL,
  error_code VARCHAR(64),
  error_name VARCHAR(128),
  message_pattern TEXT,
  key_frames JSONB,
  service VARCHAR(64) NOT NULL,
  status VARCHAR(32) DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'ignored')),
  first_seen TIMESTAMP NOT NULL,
  last_seen TIMESTAMP NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  affected_users_count INTEGER DEFAULT 0,
  root_cause JSONB,
  resolution TEXT,
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_groups_fingerprint ON error_groups(fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_groups_service ON error_groups(service);
CREATE INDEX IF NOT EXISTS idx_error_groups_status ON error_groups(status);
CREATE INDEX IF NOT EXISTS idx_error_groups_first_seen ON error_groups(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_error_groups_last_seen ON error_groups(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_error_groups_occurrence ON error_groups(occurrence_count DESC);

-- 错误事件表
CREATE TABLE IF NOT EXISTS error_events (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE CASCADE,
  error_code VARCHAR(64),
  error_name VARCHAR(128),
  message TEXT,
  stack_trace TEXT,
  service VARCHAR(64) NOT NULL,
  user_id VARCHAR(64),
  request_id VARCHAR(64),
  trace_id VARCHAR(64),
  occurred_at TIMESTAMP NOT NULL,
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_events_group_id ON error_events(group_id);
CREATE INDEX IF NOT EXISTS idx_error_events_occurred_at ON error_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_user_id ON error_events(user_id);
CREATE INDEX IF NOT EXISTS idx_error_events_service ON error_events(service, occurred_at DESC);

-- 错误快照表
CREATE TABLE IF NOT EXISTS error_snapshots (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE CASCADE,
  error_event_id VARCHAR(36) REFERENCES error_events(id) ON DELETE CASCADE,
  request JSONB,
  user JSONB,
  trace JSONB,
  environment JSONB,
  system JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_snapshots_group_id ON error_snapshots(group_id);
CREATE INDEX IF NOT EXISTS idx_error_snapshots_expires_at ON error_snapshots(expires_at);

-- 根因分析历史表
CREATE TABLE IF NOT EXISTS root_cause_analyses (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE CASCADE,
  causes JSONB NOT NULL,
  recommendation JSONB,
  analyzed_at TIMESTAMP DEFAULT NOW(),
  analyzed_by VARCHAR(64) DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_root_cause_group_id ON root_cause_analyses(group_id);
CREATE INDEX IF NOT EXISTS idx_root_cause_analyzed_at ON root_cause_analyses(analyzed_at DESC);

-- 告警记录表
CREATE TABLE IF NOT EXISTS error_alerts (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE CASCADE,
  severity VARCHAR(32) NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  channel VARCHAR(32) NOT NULL,
  sent_at TIMESTAMP NOT NULL,
  acknowledged_at TIMESTAMP,
  acknowledged_by VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_alerts_group_id ON error_alerts(group_id);
CREATE INDEX IF NOT EXISTS idx_error_alerts_sent_at ON error_alerts(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_alerts_severity ON error_alerts(severity, sent_at DESC);

-- 错误趋势统计视图
CREATE OR REPLACE VIEW error_trends_view AS
SELECT 
  service,
  error_code,
  DATE_TRUNC('hour', occurred_at) as hour,
  COUNT(*) as occurrence_count,
  COUNT(DISTINCT user_id) as affected_users_count
FROM error_events
WHERE occurred_at > NOW() - INTERVAL '24 hours'
GROUP BY service, error_code, DATE_TRUNC('hour', occurred_at)
ORDER BY hour DESC;

-- 错误统计函数
CREATE OR REPLACE FUNCTION get_error_statistics(
  p_service VARCHAR DEFAULT NULL,
  p_time_range INTERVAL DEFAULT INTERVAL '24 hours'
)
RETURNS TABLE (
  service VARCHAR,
  total_errors BIGINT,
  unique_users BIGINT,
  top_error_code VARCHAR,
  top_error_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    e.service,
    COUNT(*) as total_errors,
    COUNT(DISTINCT e.user_id) as unique_users,
    MODE() WITHIN GROUP (ORDER BY e.error_code) as top_error_code,
    MAX(g.occurrence_count) as top_error_count
  FROM error_events e
  LEFT JOIN error_groups g ON e.group_id = g.id
  WHERE e.occurred_at > NOW() - p_time_range
    AND (p_service IS NULL OR e.service = p_service)
  GROUP BY e.service;
END;
$$ LANGUAGE plpgsql;

-- 清理过期快照的函数
CREATE OR REPLACE FUNCTION cleanup_expired_snapshots()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM error_snapshots
  WHERE expires_at < NOW();
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 触发器：更新 updated_at
CREATE OR REPLACE FUNCTION update_error_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_error_groups_updated_at ON error_groups;
CREATE TRIGGER trigger_update_error_groups_updated_at
  BEFORE UPDATE ON error_groups
  FOR EACH ROW
  EXECUTE FUNCTION update_error_groups_updated_at();

COMMENT ON TABLE error_groups IS '错误聚合组，按指纹聚合相同根因的错误';
COMMENT ON TABLE error_events IS '错误事件原始记录';
COMMENT ON TABLE error_snapshots IS '错误发生时的上下文快照';
COMMENT ON TABLE root_cause_analyses IS '根因分析历史记录';
COMMENT ON TABLE error_alerts IS '告警发送记录';
