-- database/migrations/20260708_054200_risk_control_system.sql
-- 风险控制与反作弊系统数据库架构

-- ============================================================
-- 用户行为事件表
-- ============================================================

CREATE TABLE IF NOT EXISTS user_behavior_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB,
  ip_address INET,
  device_id VARCHAR(255),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  altitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_behavior_events_user_time ON user_behavior_events(user_id, created_at DESC);
CREATE INDEX idx_behavior_events_type ON user_behavior_events(event_type);
CREATE INDEX idx_behavior_events_location ON user_behavior_events USING GIST (
  ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
);

-- 分区（按月分区，保留 3 个月）
-- 注意：需要在后续维护中创建新的分区

-- ============================================================
-- 反作弊审计日志表
-- ============================================================

CREATE TABLE IF NOT EXISTS anti_cheat_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  event_type VARCHAR(50),
  event_data JSONB,
  rules_triggered JSONB,
  risk_score INTEGER,
  action_taken VARCHAR(50),
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user ON anti_cheat_audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_score ON anti_cheat_audit_logs(risk_score) WHERE risk_score >= 60;
CREATE INDEX idx_audit_logs_action ON anti_cheat_audit_logs(action_taken);

-- ============================================================
-- 用户封禁记录表
-- ============================================================

CREATE TABLE IF NOT EXISTS user_bans (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ban_type VARCHAR(20) NOT NULL, -- temp_ban / perm_ban
  reason TEXT NOT NULL,
  triggered_rules JSONB,
  score INTEGER,
  unbanned_at TIMESTAMP WITH TIME ZONE,
  unbanned_by INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_user_bans_user ON user_bans(user_id);
CREATE INDEX idx_user_bans_active ON user_bans(user_id) WHERE unbanned_at IS NULL;

-- ============================================================
-- 人工审核队列表
-- ============================================================

CREATE TABLE IF NOT EXISTS manual_review_queue (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,
  details TEXT,
  score INTEGER,
  status VARCHAR(20) DEFAULT 'pending', -- pending / reviewing / resolved / dismissed
  assigned_to INTEGER,
  resolution_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_manual_review_status ON manual_review_queue(status, created_at);
CREATE INDEX idx_manual_review_user ON manual_review_queue(user_id);

-- ============================================================
-- 风控规则配置表
-- ============================================================

CREATE TABLE IF NOT EXISTS risk_control_rules (
  id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) UNIQUE NOT NULL,
  rule_name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL, -- low / medium / high / critical
  description TEXT,
  config JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 插入默认规则
INSERT INTO risk_control_rules (rule_id, rule_name, category, severity, description) VALUES
('SPEED_HACK_001', '速度异常检测', 'location', 'high', '检测移动速度是否超过物理限制'),
('CATCH_FREQUENCY_001', '捕捉频率异常', 'catch', 'high', '检测捕捉频率是否超过合理范围'),
('LOCATION_SPOOF_001', 'GPS 伪造检测', 'location', 'critical', '检测 GPS 坐标伪造特征'),
('ITEM_USAGE_001', '道具使用异常', 'item', 'medium', '检测道具使用频率异常'),
('GYM_BATTLE_001', '道馆战斗异常', 'gym', 'high', '检测道馆战斗异常（自动战斗脚本）'),
('MULTI_DEVICE_001', '多设备登录检测', 'auth', 'high', '检测同一账号多设备同时登录'),
('ANOMALOUS_TRADE_001', '异常交易检测', 'trade', 'medium', '检测精灵交易异常模式')
ON CONFLICT (rule_id) DO NOTHING;

-- ============================================================
-- 用户风险评分历史表
-- ============================================================

CREATE TABLE IF NOT EXISTS user_risk_scores (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  score INTEGER NOT NULL,
  top_rules JSONB,
  window_size_seconds INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_risk_scores_user_time ON user_risk_scores(user_id, created_at DESC);
CREATE INDEX idx_risk_scores_high ON user_risk_scores(score) WHERE score >= 60;

-- ============================================================
-- 实时风控状态表（Redis 缓存备份）
-- ============================================================

CREATE TABLE IF NOT EXISTS user_risk_state (
  user_id INTEGER PRIMARY KEY,
  current_score INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  last_warning_at TIMESTAMP WITH TIME ZONE,
  restriction_level VARCHAR(20) DEFAULT 'normal', -- normal / restricted / suspended / banned
  restriction_reason TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 统计视图
-- ============================================================

CREATE OR REPLACE VIEW v_risk_control_stats AS
SELECT 
  DATE(created_at) as date,
  COUNT(DISTINCT user_id) as unique_users_flagged,
  COUNT(*) as total_events_processed,
  COUNT(*) FILTER (WHERE action_taken IS NOT NULL) as actions_taken,
  AVG(risk_score) as avg_risk_score,
  MAX(risk_score) as max_risk_score
FROM anti_cheat_audit_logs
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- ============================================================
-- 函数：获取用户风险历史
-- ============================================================

CREATE OR REPLACE FUNCTION get_user_risk_history(
  p_user_id INTEGER,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  date DATE,
  avg_score NUMERIC,
  max_score INTEGER,
  event_count BIGINT,
  top_rule TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    DATE(created_at) as date,
    AVG(risk_score)::NUMERIC as avg_score,
    MAX(risk_score) as max_score,
    COUNT(*) as event_count,
    (
      SELECT rule->>0
      FROM jsonb_array_elements(rules_triggered) as rule
      GROUP BY rule->>0
      ORDER BY COUNT(*) DESC
      LIMIT 1
    ) as top_rule
  FROM anti_cheat_audit_logs
  WHERE user_id = p_user_id
    AND created_at >= NOW() - (p_days || ' days')::INTERVAL
  GROUP BY DATE(created_at)
  ORDER BY date DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 触发器：更新 updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_risk_control_rules_updated_at
  BEFORE UPDATE ON risk_control_rules
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_manual_review_updated_at
  BEFORE UPDATE ON manual_review_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 注释
-- ============================================================

COMMENT ON TABLE user_behavior_events IS '用户行为事件原始数据，用于风控分析';
COMMENT ON TABLE anti_cheat_audit_logs IS '反作弊检测审计日志';
COMMENT ON TABLE user_bans IS '用户封禁记录';
COMMENT ON TABLE manual_review_queue IS '人工审核队列';
COMMENT ON TABLE risk_control_rules IS '风控规则配置';
COMMENT ON TABLE user_risk_scores IS '用户风险评分历史';
COMMENT ON TABLE user_risk_state IS '用户实时风控状态';
