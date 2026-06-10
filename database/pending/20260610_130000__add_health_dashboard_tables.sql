-- REQ-00061: 服务健康仪表板与自动恢复系统
-- 创建健康评分历史、恢复记录、故障演练等表

-- 健康评分历史表
CREATE TABLE IF NOT EXISTS health_score_history (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    total_score INTEGER NOT NULL CHECK (total_score >= 0 AND total_score <= 100),
    status VARCHAR(20) NOT NULL CHECK (status IN ('healthy', 'warning', 'degraded', 'critical')),
    scores JSONB NOT NULL,
    trend VARCHAR(20),
    recommendations JSONB,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_health_score_history_service ON health_score_history(service_name);
CREATE INDEX IF NOT EXISTS idx_health_score_history_time ON health_score_history(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_score_history_status ON health_score_history(status);

-- 自动恢复记录表
CREATE TABLE IF NOT EXISTS auto_recovery_records (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    recovery_type VARCHAR(50) NOT NULL,
    trigger_score INTEGER,
    trigger_status VARCHAR(20),
    action_taken VARCHAR(100),
    success BOOLEAN NOT NULL,
    result JSONB,
    duration_ms INTEGER,
    error_message TEXT,
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    cooldown_until TIMESTAMP WITH TIME ZONE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_auto_recovery_service ON auto_recovery_records(service_name);
CREATE INDEX IF NOT EXISTS idx_auto_recovery_time ON auto_recovery_records(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_recovery_success ON auto_recovery_records(success);

-- 故障演练记录表
CREATE TABLE IF NOT EXISTS chaos_experiments (
    id SERIAL PRIMARY KEY,
    experiment_name VARCHAR(200) NOT NULL UNIQUE,
    experiment_type VARCHAR(50) NOT NULL,
    target_service VARCHAR(100) NOT NULL,
    duration VARCHAR(20),
    intensity VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    config JSONB,
    result JSONB,
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_chaos_experiments_service ON chaos_experiments(target_service);
CREATE INDEX IF NOT EXISTS idx_chaos_experiments_status ON chaos_experiments(status);
CREATE INDEX IF NOT EXISTS idx_chaos_experiments_time ON chaos_experiments(created_at DESC);

-- 服务健康配置表
CREATE TABLE IF NOT EXISTS service_health_config (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT true,
    weights JSONB DEFAULT '{"cpu":0.15,"memory":0.15,"errorRate":0.20,"responseTime":0.20,"connectionPool":0.15,"eventLag":0.15}',
    thresholds JSONB DEFAULT '{"healthy":80,"warning":60,"degraded":40}',
    auto_recovery_enabled BOOLEAN DEFAULT true,
    cooldown_seconds INTEGER DEFAULT 300,
    max_replicas INTEGER DEFAULT 10,
    min_replicas INTEGER DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认配置
INSERT INTO service_health_config (service_name) VALUES
    ('user-service'),
    ('location-service'),
    ('pokemon-service'),
    ('catch-service'),
    ('gym-service'),
    ('social-service'),
    ('reward-service'),
    ('payment-service'),
    ('gateway')
ON CONFLICT (service_name) DO NOTHING;

-- 服务依赖关系表
CREATE TABLE IF NOT EXISTS service_dependencies (
    id SERIAL PRIMARY KEY,
    from_service VARCHAR(100) NOT NULL,
    to_service VARCHAR(100) NOT NULL,
    dependency_type VARCHAR(50) DEFAULT 'sync',
    avg_traffic INTEGER DEFAULT 0,
    latency_p50 INTEGER,
    latency_p95 INTEGER,
    latency_p99 INTEGER,
    error_rate DECIMAL(5,4),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_service, to_service)
);

-- 插入默认依赖关系
INSERT INTO service_dependencies (from_service, to_service, dependency_type, avg_traffic) VALUES
    ('gateway', 'user-service', 'sync', 1000),
    ('gateway', 'location-service', 'sync', 800),
    ('gateway', 'pokemon-service', 'sync', 600),
    ('gateway', 'catch-service', 'sync', 500),
    ('gateway', 'gym-service', 'sync', 300),
    ('gateway', 'social-service', 'sync', 200),
    ('gateway', 'reward-service', 'sync', 400),
    ('gateway', 'payment-service', 'sync', 100),
    ('user-service', 'postgres', 'sync', 1000),
    ('location-service', 'postgres', 'sync', 800),
    ('location-service', 'redis', 'sync', 800),
    ('pokemon-service', 'postgres', 'sync', 600),
    ('catch-service', 'postgres', 'sync', 500),
    ('catch-service', 'kafka', 'async', 500),
    ('gym-service', 'postgres', 'sync', 300),
    ('social-service', 'postgres', 'sync', 200),
    ('reward-service', 'postgres', 'sync', 400),
    ('reward-service', 'kafka', 'async', 400),
    ('payment-service', 'postgres', 'sync', 100)
ON CONFLICT (from_service, to_service) DO NOTHING;

-- 健康告警规则表
CREATE TABLE IF NOT EXISTS health_alert_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(200) NOT NULL UNIQUE,
    service_pattern VARCHAR(100),
    condition_type VARCHAR(50) NOT NULL,
    threshold_value DECIMAL(10,4) NOT NULL,
    duration_seconds INTEGER DEFAULT 60,
    severity VARCHAR(20) DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    auto_recovery_action VARCHAR(50),
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认告警规则
INSERT INTO health_alert_rules (rule_name, service_pattern, condition_type, threshold_value, duration_seconds, severity, auto_recovery_action) VALUES
    ('cpu_high', NULL, 'cpu', 85, 120, 'warning', 'scaling'),
    ('cpu_critical', NULL, 'cpu', 95, 60, 'critical', 'scaling'),
    ('memory_high', NULL, 'memory', 85, 120, 'warning', NULL),
    ('memory_critical', NULL, 'memory', 95, 60, 'critical', 'restart'),
    ('error_rate_high', NULL, 'errorRate', 0.10, 120, 'warning', NULL),
    ('error_rate_critical', NULL, 'errorRate', 0.20, 60, 'critical', 'rollback'),
    ('response_time_slow', NULL, 'responseTime', 1000, 120, 'warning', NULL),
    ('response_time_critical', NULL, 'responseTime', 3000, 60, 'critical', 'scaling'),
    ('connection_pool_high', NULL, 'connectionPool', 85, 120, 'warning', 'restart'),
    ('event_lag_high', NULL, 'eventLag', 300, 120, 'warning', 'scaling')
ON CONFLICT (rule_name) DO NOTHING;

-- 创建视图：服务健康状态摘要
CREATE OR REPLACE VIEW service_health_summary AS
SELECT 
    h.service_name,
    h.total_score,
    h.status,
    h.trend,
    h.recorded_at,
    c.auto_recovery_enabled,
    c.cooldown_seconds,
    r.last_recovery_at,
    r.recovery_count_24h
FROM health_score_history h
JOIN service_health_config c ON h.service_name = c.service_name
LEFT JOIN LATERAL (
    SELECT 
        MAX(executed_at) as last_recovery_at,
        COUNT(*) as recovery_count_24h
    FROM auto_recovery_records 
    WHERE service_name = h.service_name 
    AND executed_at > NOW() - INTERVAL '24 hours'
) r ON true
WHERE h.id IN (
    SELECT MAX(id) FROM health_score_history GROUP BY service_name
);

-- 创建函数：清理旧的健康评分历史
CREATE OR REPLACE FUNCTION cleanup_health_history(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM health_score_history 
    WHERE recorded_at < NOW() - (retention_days || ' days')::INTERVAL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 创建函数：获取服务健康趋势
CREATE OR REPLACE FUNCTION get_service_health_trend(
    p_service_name VARCHAR,
    p_hours INTEGER DEFAULT 24
)
RETURNS TABLE (
    hour TIMESTAMP WITH TIME ZONE,
    avg_score NUMERIC,
    min_score INTEGER,
    max_score INTEGER,
    sample_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        date_trunc('hour', recorded_at) as hour,
        AVG(total_score)::NUMERIC(5,2) as avg_score,
        MIN(total_score) as min_score,
        MAX(total_score) as max_score,
        COUNT(*) as sample_count
    FROM health_score_history
    WHERE service_name = p_service_name
    AND recorded_at > NOW() - (p_hours || ' hours')::INTERVAL
    GROUP BY date_trunc('hour', recorded_at)
    ORDER BY hour DESC;
END;
$$ LANGUAGE plpgsql;

-- 注释
COMMENT ON TABLE health_score_history IS 'REQ-00061: 服务健康评分历史记录';
COMMENT ON TABLE auto_recovery_records IS 'REQ-00061: 自动恢复执行记录';
COMMENT ON TABLE chaos_experiments IS 'REQ-00061: 故障演练实验记录';
COMMENT ON TABLE service_health_config IS 'REQ-00061: 服务健康监控配置';
COMMENT ON TABLE service_dependencies IS 'REQ-00061: 服务依赖关系';
COMMENT ON TABLE health_alert_rules IS 'REQ-00061: 健康告警规则';
