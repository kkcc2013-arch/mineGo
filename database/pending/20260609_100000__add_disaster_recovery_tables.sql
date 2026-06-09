-- database/pending/20260609_100000__add_disaster_recovery_tables.sql
-- 多区域容灾切换与灾备恢复系统数据库迁移

-- 容灾状态表
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

CREATE INDEX IF NOT EXISTS idx_dr_failover_events_status ON dr_failover_events(status);
CREATE INDEX IF NOT EXISTS idx_dr_failover_events_started_at ON dr_failover_events(started_at DESC);

-- 容灾演练表
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
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dr_drills_status ON dr_drills(status);
CREATE INDEX IF NOT EXISTS idx_dr_drills_scheduled_time ON dr_drills(scheduled_time DESC);

-- 健康检查历史表
CREATE TABLE IF NOT EXISTS dr_health_check_history (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    region VARCHAR(50) NOT NULL,
    healthy BOOLEAN NOT NULL,
    latency_ms INTEGER,
    error_message TEXT,
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dr_health_check_history_checked_at ON dr_health_check_history(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_dr_health_check_history_service ON dr_health_check_history(service_name, region);

-- 数据库同步状态表
CREATE TABLE IF NOT EXISTS dr_db_sync_status (
    id SERIAL PRIMARY KEY,
    primary_region VARCHAR(50) NOT NULL,
    secondary_region VARCHAR(50) NOT NULL,
    primary_lsn VARCHAR(100),
    secondary_lsn VARCHAR(100),
    lag_seconds DECIMAL(10, 3),
    healthy BOOLEAN NOT NULL,
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dr_db_sync_status_checked_at ON dr_db_sync_status(checked_at DESC);

-- 容灾配置表
CREATE TABLE IF NOT EXISTS dr_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(36)
);

-- 插入默认配置
INSERT INTO dr_config (config_key, config_value, description) VALUES
('primary_region', 'cn-east-1', 'Primary region identifier'),
('secondary_region', 'cn-north-1', 'Secondary region identifier'),
('auto_failover_enabled', 'true', 'Enable automatic failover'),
('health_check_interval_seconds', '5', 'Health check interval in seconds'),
('failure_threshold', '3', 'Number of failures before triggering failover'),
('cooldown_period_seconds', '300', 'Cooldown period between failovers'),
('target_rto_seconds', '300', 'Target RTO in seconds'),
('target_rpo_seconds', '60', 'Target RPO in seconds'),
('dns_ttl_seconds', '30', 'DNS TTL for failover'),
('max_drill_duration_seconds', '1800', 'Maximum drill duration in seconds')
ON CONFLICT (config_key) DO NOTHING;

-- 添加表注释
COMMENT ON TABLE dr_failover_events IS '容灾故障切换事件记录';
COMMENT ON TABLE dr_drills IS '容灾演练记录';
COMMENT ON TABLE dr_health_check_history IS '服务健康检查历史';
COMMENT ON TABLE dr_db_sync_status IS '数据库同步状态';
COMMENT ON TABLE dr_config IS '容灾系统配置';

COMMENT ON COLUMN dr_failover_events.event_id IS '事件唯一标识 UUID';
COMMENT ON COLUMN dr_failover_events.from_region IS '源区域';
COMMENT ON COLUMN dr_failover_events.to_region IS '目标区域';
COMMENT ON COLUMN dr_failover_events.trigger_type IS '触发类型: manual/automatic/drill';
COMMENT ON COLUMN dr_failover_events.rto_seconds IS '实际 RTO 秒数';
COMMENT ON COLUMN dr_failover_events.rpo_seconds IS '实际 RPO 秒数';

COMMENT ON COLUMN dr_drills.drill_id IS '演练唯一标识 UUID';
COMMENT ON COLUMN dr_drills.rto_seconds IS '演练实际 RTO 秒数';
COMMENT ON COLUMN dr_drills.auto_rollback IS '是否自动回切';
