-- REQ-00585: 数据库死锁检测与自动化记录分析系统
-- 创建死锁日志表和相关索引

-- 死锁日志表
CREATE TABLE IF NOT EXISTS deadlock_log (
    id BIGSERIAL PRIMARY KEY,
    deadlock_id VARCHAR(64) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- 错误信息
    error_code VARCHAR(20) NOT NULL,
    error_message TEXT,
    error_detail TEXT,
    error_hint TEXT,
    
    -- 上下文信息
    service_name VARCHAR(100),
    transaction_name VARCHAR(200),
    trace_id VARCHAR(64),
    
    -- 涉及的对象
    involved_processes JSONB DEFAULT '[]',
    involved_tables JSONB DEFAULT '[]',
    lock_types JSONB DEFAULT '[]',
    
    -- SQL 语句
    sql_queries JSONB DEFAULT '[]',
    
    -- 处理信息
    retry_count INTEGER DEFAULT 0,
    resolved BOOLEAN DEFAULT FALSE,
    severity VARCHAR(20) DEFAULT 'low',
    
    -- 额外上下文
    context JSONB DEFAULT '{}'
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_deadlock_log_created_at ON deadlock_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deadlock_log_service ON deadlock_log(service_name);
CREATE INDEX IF NOT EXISTS idx_deadlock_log_resolved ON deadlock_log(resolved);
CREATE INDEX IF NOT EXISTS idx_deadlock_log_severity ON deadlock_log(severity);
CREATE INDEX IF NOT EXISTS idx_deadlock_log_trace_id ON deadlock_log(trace_id);

-- 死锁统计表（按小时聚合）
CREATE TABLE IF NOT EXISTS deadlock_stats_hourly (
    id BIGSERIAL PRIMARY KEY,
    hour_timestamp TIMESTAMPTZ NOT NULL,
    service_name VARCHAR(100),
    
    -- 统计数据
    total_deadlocks INTEGER DEFAULT 0,
    resolved_deadlocks INTEGER DEFAULT 0,
    failed_deadlocks INTEGER DEFAULT 0,
    avg_retry_count NUMERIC(10, 2) DEFAULT 0,
    
    -- 热点表统计
    hot_tables JSONB DEFAULT '{}',
    
    -- 分布统计
    operation_distribution JSONB DEFAULT '{}',
    lock_type_distribution JSONB DEFAULT '{}',
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(hour_timestamp, service_name)
);

CREATE INDEX IF NOT EXISTS idx_deadlock_stats_hourly_time ON deadlock_stats_hourly(hour_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_deadlock_stats_hourly_service ON deadlock_stats_hourly(service_name);

-- 死锁模式分析表
CREATE TABLE IF NOT EXISTS deadlock_patterns (
    id BIGSERIAL PRIMARY KEY,
    pattern_hash VARCHAR(64) UNIQUE NOT NULL,
    
    -- 模式特征
    involved_tables JSONB NOT NULL,
    lock_types JSONB NOT NULL,
    operation_types JSONB NOT NULL,
    
    -- 统计信息
    occurrence_count INTEGER DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    
    -- 建议
    recommendation TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deadlock_patterns_tables ON deadlock_patterns USING GIN(involved_tables);
CREATE INDEX IF NOT EXISTS idx_deadlock_patterns_count ON deadlock_patterns(occurrence_count DESC);

-- 死锁告警配置表
CREATE TABLE IF NOT EXISTS deadlock_alert_config (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100),
    
    -- 阈值配置
    alert_threshold INTEGER DEFAULT 3,  -- 1小时内超过此数量告警
    critical_threshold INTEGER DEFAULT 5,  -- 1小时内超过此数量严重告警
    
    -- 通知配置
    notification_channels JSONB DEFAULT '["log"]',
    cooldown_minutes INTEGER DEFAULT 30,
    
    -- 状态
    enabled BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(service_name)
);

-- 初始化默认配置
INSERT INTO deadlock_alert_config (service_name, alert_threshold, critical_threshold, notification_channels)
VALUES 
    ('default', 3, 5, '["log", "webhook"]'),
    ('gateway', 5, 10, '["log", "webhook", "slack"]'),
    ('user-service', 3, 5, '["log", "webhook"]'),
    ('payment-service', 2, 3, '["log", "webhook", "slack"]')
ON CONFLICT (service_name) DO NOTHING;

-- 创建用于聚合统计的函数
CREATE OR REPLACE FUNCTION aggregate_deadlock_stats()
RETURNS void AS $$
DECLARE
    current_hour TIMESTAMPTZ;
BEGIN
    current_hour := date_trunc('hour', NOW() - INTERVAL '1 hour');
    
    INSERT INTO deadlock_stats_hourly (hour_timestamp, service_name, total_deadlocks, resolved_deadlocks, failed_deadlocks, avg_retry_count)
    SELECT 
        current_hour,
        service_name,
        COUNT(*),
        SUM(CASE WHEN resolved THEN 1 ELSE 0 END),
        SUM(CASE WHEN NOT resolved THEN 1 ELSE 0 END),
        AVG(retry_count)
    FROM deadlock_log
    WHERE created_at >= current_hour AND created_at < current_hour + INTERVAL '1 hour'
    GROUP BY service_name
    ON CONFLICT (hour_timestamp, service_name) 
    DO UPDATE SET
        total_deadlocks = EXCLUDED.total_deadlocks,
        resolved_deadlocks = EXCLUDED.resolved_deadlocks,
        failed_deadlocks = EXCLUDED.failed_deadlocks,
        avg_retry_count = EXCLUDED.avg_retry_count;
END;
$$ LANGUAGE plpgsql;

-- 创建定时任务（需要 pg_cron 扩展，如果可用）
-- SELECT cron.schedule('aggregate_deadlock_stats', '0 * * * *', 'SELECT aggregate_deadlock_stats()');

-- 视图：近期死锁统计
CREATE OR REPLACE VIEW v_recent_deadlock_stats AS
SELECT 
    service_name,
    COUNT(*) as total_deadlocks,
    SUM(CASE WHEN resolved THEN 1 ELSE 0 END) as resolved_count,
    SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
    AVG(retry_count) as avg_retries,
    MAX(created_at) as last_deadlock_time
FROM deadlock_log
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY service_name;

-- 视图：热点表分析
CREATE OR REPLACE VIEW v_deadlock_hot_tables AS
SELECT 
    table_oid,
    COUNT(*) as deadlock_count,
    array_agg(DISTINCT service_name) as services
FROM deadlock_log,
     jsonb_array_elements_text(involved_tables) as table_oid
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY table_oid
ORDER BY deadlock_count DESC;

COMMENT ON TABLE deadlock_log IS 'REQ-00585: 死锁事件日志记录';
COMMENT ON TABLE deadlock_stats_hourly IS 'REQ-00585: 每小时死锁统计聚合';
COMMENT ON TABLE deadlock_patterns IS 'REQ-00585: 死锁模式分析';
COMMENT ON TABLE deadlock_alert_config IS 'REQ-00585: 死锁告警配置';
