-- ============================================================
-- Disaster Recovery System Tables
-- REQ-00041: 多区域容灾切换与灾备恢复系统
-- ============================================================

-- 容灾故障切换事件记录表
CREATE TABLE IF NOT EXISTS dr_failover_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(36) UNIQUE NOT NULL,
    from_region VARCHAR(50) NOT NULL,
    to_region VARCHAR(50) NOT NULL,
    trigger_type VARCHAR(20) NOT NULL CHECK (trigger_type IN ('manual', 'automatic', 'drill')),
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')),
    steps JSONB DEFAULT '[]',
    rto_seconds INTEGER,
    rpo_seconds INTEGER,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(36),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dr_failover_events IS '容灾故障切换事件记录';
COMMENT ON COLUMN dr_failover_events.rto_seconds IS '实际 RTO（恢复时间目标）秒数';
COMMENT ON COLUMN dr_failover_events.rpo_seconds IS '实际 RPO（恢复点目标）秒数';

CREATE INDEX idx_dr_failover_events_status ON dr_failover_events(status);
CREATE INDEX idx_dr_failover_events_started_at ON dr_failover_events(started_at DESC);
CREATE INDEX idx_dr_failover_events_trigger_type ON dr_failover_events(trigger_type);

-- 容灾演练记录表
CREATE TABLE IF NOT EXISTS dr_drills (
    id SERIAL PRIMARY KEY,
    drill_id VARCHAR(36) UNIQUE NOT NULL,
    scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    rto_seconds INTEGER,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'completed', 'failed', 'cancelled')),
    auto_rollback BOOLEAN DEFAULT true,
    failover_event_id VARCHAR(36),
    rollback_event_id VARCHAR(36),
    created_by VARCHAR(36),
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    FOREIGN KEY (failover_event_id) REFERENCES dr_failover_events(event_id),
    FOREIGN KEY (rollback_event_id) REFERENCES dr_failover_events(event_id)
);

COMMENT ON TABLE dr_drills IS '容灾演练记录';

CREATE INDEX idx_dr_drills_status ON dr_drills(status);
CREATE INDEX idx_dr_drills_scheduled_time ON dr_drills(scheduled_time DESC);

-- 服务健康检查历史表
CREATE TABLE IF NOT EXISTS dr_health_check_history (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    region VARCHAR(50) NOT NULL,
    healthy BOOLEAN NOT NULL,
    latency_ms INTEGER,
    status_code INTEGER,
    error_message TEXT,
    checks JSONB DEFAULT '{}',
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dr_health_check_history IS '服务健康检查历史';

CREATE INDEX idx_dr_health_check_history_checked_at ON dr_health_check_history(checked_at DESC);
CREATE INDEX idx_dr_health_check_history_service ON dr_health_check_history(service_name, region);
CREATE INDEX idx_dr_health_check_history_healthy ON dr_health_check_history(healthy);

-- 数据库同步状态表
CREATE TABLE IF NOT EXISTS dr_db_sync_status (
    id SERIAL PRIMARY KEY,
    primary_region VARCHAR(50) NOT NULL,
    secondary_region VARCHAR(50) NOT NULL,
    primary_lsn VARCHAR(100),
    secondary_lsn VARCHAR(100),
    replay_lsn VARCHAR(100),
    lag_seconds DECIMAL(10, 3),
    healthy BOOLEAN NOT NULL,
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dr_db_sync_status IS '数据库跨区域同步状态';

CREATE INDEX idx_dr_db_sync_status_checked_at ON dr_db_sync_status(checked_at DESC);
CREATE INDEX idx_dr_db_sync_status_healthy ON dr_db_sync_status(healthy);

-- 容灾系统配置表
CREATE TABLE IF NOT EXISTS dr_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    value_type VARCHAR(20) DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(36)
);

COMMENT ON TABLE dr_config IS '容灾系统配置';

-- 插入默认配置
INSERT INTO dr_config (config_key, config_value, value_type, description) VALUES
('primary_region', 'cn-east-1', 'string', 'Primary region identifier'),
('secondary_region', 'cn-north-1', 'string', 'Secondary region identifier'),
('auto_failover_enabled', 'true', 'boolean', 'Enable automatic failover'),
('health_check_interval_seconds', '5', 'number', 'Health check interval in seconds'),
('health_check_timeout_seconds', '3', 'number', 'Health check timeout in seconds'),
('failure_threshold', '3', 'number', 'Number of consecutive failures before triggering failover'),
('recovery_threshold', '2', 'number', 'Number of consecutive successes before marking healthy'),
('cooldown_period_seconds', '300', 'number', 'Cooldown period between failovers in seconds'),
('dns_ttl_seconds', '30', 'number', 'DNS TTL for failover updates'),
('target_rto_seconds', '300', 'number', 'Target RTO (Recovery Time Objective) in seconds'),
('target_rpo_seconds', '60', 'number', 'Target RPO (Recovery Point Objective) in seconds'),
('drill_interval_days', '7', 'number', 'Interval between automatic drills in days'),
('drill_auto_rollback', 'true', 'boolean', 'Auto rollback after drill completion')
ON CONFLICT (config_key) DO NOTHING;

-- 容灾告警规则表
CREATE TABLE IF NOT EXISTS dr_alert_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) UNIQUE NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    condition_operator VARCHAR(10) NOT NULL CHECK (condition_operator IN ('>', '<', '>=', '<=', '==', '!=', 'threshold')),
    condition_value DECIMAL(10, 3) NOT NULL,
    duration_seconds INTEGER DEFAULT 60,
    severity VARCHAR(20) NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical', 'emergency')),
    notification_channels JSONB DEFAULT '["email", "slack"]',
    enabled BOOLEAN DEFAULT true,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dr_alert_rules IS '容灾告警规则';

-- 插入默认告警规则
INSERT INTO dr_alert_rules (rule_name, metric_name, condition_operator, condition_value, duration_seconds, severity, description) VALUES
('high_db_sync_lag', 'dr_db_sync_lag_seconds', '>', 30, 60, 'warning', 'Database sync lag exceeds 30 seconds'),
('critical_db_sync_lag', 'dr_db_sync_lag_seconds', '>', 60, 30, 'critical', 'Database sync lag exceeds 60 seconds'),
('service_unhealthy', 'dr_health_check_status', '==', 0, 15, 'critical', 'Service health check failed'),
('failover_triggered', 'dr_failover_in_progress', '==', 1, 0, 'emergency', 'Failover in progress'),
('high_failure_count', 'dr_failure_count', '>', 2, 30, 'warning', 'Service failure count high')
ON CONFLICT (rule_name) DO NOTHING;

-- 容灾审计日志表
CREATE TABLE IF NOT EXISTS dr_audit_log (
    id SERIAL PRIMARY KEY,
    action VARCHAR(50) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id VARCHAR(100),
    actor VARCHAR(100),
    actor_ip VARCHAR(45),
    details JSONB DEFAULT '{}',
    result VARCHAR(20) NOT NULL CHECK (result IN ('success', 'failure', 'partial')),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dr_audit_log IS '容灾操作审计日志';

CREATE INDEX idx_dr_audit_log_action ON dr_audit_log(action);
CREATE INDEX idx_dr_audit_log_resource ON dr_audit_log(resource_type, resource_id);
CREATE INDEX idx_dr_audit_log_created_at ON dr_audit_log(created_at DESC);

-- 创建视图：容灾状态概览
CREATE OR REPLACE VIEW dr_status_overview AS
SELECT 
    (SELECT config_value FROM dr_config WHERE config_key = 'primary_region') as primary_region,
    (SELECT config_value FROM dr_config WHERE config_key = 'secondary_region') as secondary_region,
    (SELECT config_value FROM dr_config WHERE config_key = 'auto_failover_enabled') as auto_failover_enabled,
    (SELECT COUNT(*) FROM dr_health_check_history WHERE healthy = false AND checked_at > NOW() - INTERVAL '5 minutes') as unhealthy_services,
    (SELECT lag_seconds FROM dr_db_sync_status ORDER BY checked_at DESC LIMIT 1) as current_db_lag,
    (SELECT COUNT(*) FROM dr_failover_events WHERE status = 'in_progress') as failover_in_progress,
    (SELECT COUNT(*) FROM dr_drills WHERE status = 'running') as drill_in_progress,
    (SELECT completed_at FROM dr_failover_events WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1) as last_failover_time,
    (SELECT completed_at FROM dr_drills WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1) as last_drill_time;

COMMENT ON VIEW dr_status_overview IS '容灾系统状态概览';

-- 创建函数：记录故障切换事件
CREATE OR REPLACE FUNCTION dr_record_failover_event(
    p_event_id VARCHAR(36),
    p_from_region VARCHAR(50),
    p_to_region VARCHAR(50),
    p_trigger_type VARCHAR(20),
    p_reason TEXT,
    p_created_by VARCHAR(36)
) RETURNS INTEGER AS $$
DECLARE
    v_id INTEGER;
BEGIN
    INSERT INTO dr_failover_events (
        event_id, from_region, to_region, trigger_type, 
        reason, status, started_at, created_by
    ) VALUES (
        p_event_id, p_from_region, p_to_region, p_trigger_type,
        p_reason, 'in_progress', NOW(), p_created_by
    ) RETURNING id INTO v_id;
    
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- 创建函数：完成故障切换事件
CREATE OR REPLACE FUNCTION dr_complete_failover_event(
    p_event_id VARCHAR(36),
    p_status VARCHAR(20),
    p_steps JSONB,
    p_rto_seconds INTEGER,
    p_rpo_seconds INTEGER
) RETURNS VOID AS $$
BEGIN
    UPDATE dr_failover_events SET
        status = p_status,
        steps = p_steps,
        rto_seconds = p_rto_seconds,
        rpo_seconds = p_rpo_seconds,
        completed_at = NOW()
    WHERE event_id = p_event_id;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_dr_config_updated_at
    BEFORE UPDATE ON dr_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_dr_alert_rules_updated_at
    BEFORE UPDATE ON dr_alert_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
