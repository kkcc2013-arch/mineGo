-- 数据库迁移：任务队列与死信队列相关表
-- REQ-00519: 任务队列可靠性增强与死信处理系统

-- 死信队列表（用于持久化存储和审计）
CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(100) NOT NULL,
    task_type VARCHAR(50) NOT NULL,
    task_data JSONB NOT NULL,
    error_message TEXT,
    error_stack TEXT,
    error_code VARCHAR(50),
    retry_count INTEGER DEFAULT 0,
    failed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    original_created_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolved_by VARCHAR(100),
    resolution_action VARCHAR(20), -- 'retry', 'deleted', 'ignored'
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_dlq_task_type ON dead_letter_queue(task_type);
CREATE INDEX idx_dlq_failed_at ON dead_letter_queue(failed_at DESC);
CREATE INDEX idx_dlq_resolved ON dead_letter_queue(resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX idx_dlq_unresolved ON dead_letter_queue(task_type, failed_at) WHERE resolved_at IS NULL;

-- 任务执行历史表
CREATE TABLE IF NOT EXISTS task_execution_history (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(100) NOT NULL,
    task_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL, -- 'pending', 'processing', 'completed', 'failed', 'retrying'
    attempt_number INTEGER DEFAULT 1,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    error_message TEXT,
    error_stack TEXT,
    worker_id VARCHAR(100),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_task_history_task_id ON task_execution_history(task_id);
CREATE INDEX idx_task_history_task_type ON task_execution_history(task_type, created_at DESC);
CREATE INDEX idx_task_history_status ON task_execution_history(status, created_at DESC);

-- 任务队列指标表（用于 Prometheus 查询和历史趋势）
CREATE TABLE IF NOT EXISTS task_queue_metrics (
    id SERIAL PRIMARY KEY,
    task_type VARCHAR(50) NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value DOUBLE PRECISION NOT NULL,
    labels JSONB DEFAULT '{}'::jsonb,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 索引（用于快速查询最近指标）
CREATE INDEX idx_metrics_task_type_time ON task_queue_metrics(task_type, recorded_at DESC);
CREATE INDEX idx_metrics_name_time ON task_queue_metrics(metric_name, recorded_at DESC);

-- 分区（按月分区，保留 6 个月数据）
CREATE TABLE IF NOT EXISTS task_queue_metrics_202607 PARTITION OF task_queue_metrics
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS task_queue_metrics_202608 PARTITION OF task_queue_metrics
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS task_queue_metrics_202609 PARTITION OF task_queue_metrics
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS task_queue_metrics_202610 PARTITION OF task_queue_metrics
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS task_queue_metrics_202611 PARTITION OF task_queue_metrics
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS task_queue_metrics_202612 PARTITION OF task_queue_metrics
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- 任务重试策略配置表
CREATE TABLE IF NOT EXISTS task_retry_configs (
    id SERIAL PRIMARY KEY,
    task_type VARCHAR(50) UNIQUE NOT NULL,
    max_retries INTEGER NOT NULL DEFAULT 5,
    initial_delay_ms INTEGER NOT NULL DEFAULT 1000,
    max_delay_ms INTEGER NOT NULL DEFAULT 300000,
    backoff_multiplier DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    jitter_ms INTEGER NOT NULL DEFAULT 500,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 插入默认配置
INSERT INTO task_retry_configs (task_type, max_retries, initial_delay_ms, max_delay_ms) VALUES
    ('push_notification', 3, 2000, 60000),
    ('data_export', 5, 5000, 600000),
    ('data_cleanup', 3, 10000, 300000),
    ('backup', 2, 60000, 1800000),
    ('email_send', 5, 3000, 120000),
    ('default', 5, 1000, 300000)
ON CONFLICT (task_type) DO NOTHING;

-- DLQ 告警规则配置表
CREATE TABLE IF NOT EXISTS dlq_alert_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) UNIQUE NOT NULL,
    task_type VARCHAR(50), -- NULL 表示全局规则
    metric_type VARCHAR(50) NOT NULL, -- 'dlq_size', 'dlq_age', 'queue_backlog', 'error_rate'
    threshold_value DOUBLE PRECISION NOT NULL,
    comparison_operator VARCHAR(10) NOT NULL DEFAULT '>', -- '>', '>=', '<', '<=', '=='
    severity VARCHAR(20) NOT NULL DEFAULT 'warning', -- 'info', 'warning', 'critical'
    duration_seconds INTEGER DEFAULT 300, -- 持续时间阈值
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    cooldown_seconds INTEGER DEFAULT 600, -- 同一告警冷却时间
    last_triggered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 插入默认告警规则
INSERT INTO dlq_alert_rules (rule_name, task_type, metric_type, threshold_value, severity) VALUES
    ('dlq_size_global', NULL, 'dlq_size', 100, 'warning'),
    ('dlq_size_critical', NULL, 'dlq_size', 500, 'critical'),
    ('queue_backlog_global', NULL, 'queue_backlog', 1000, 'warning'),
    ('error_rate_high', NULL, 'error_rate', 0.5, 'warning'),
    ('dlq_age_old', NULL, 'dlq_age', 3600, 'warning')
ON CONFLICT (rule_name) DO NOTHING;

-- 清理函数：定期清理已解决的 DLQ 记录
CREATE OR REPLACE FUNCTION cleanup_resolved_dlq()
RETURNS INTEGER AS $$
BEGIN
    DELETE FROM dead_letter_queue
    WHERE resolved_at IS NOT NULL
      AND resolved_at < NOW() - INTERVAL '30 days';
    
    RETURN ROW_COUNT;
END;
$$ LANGUAGE plpgsql;

-- 清理函数：定期清理旧的任务历史
CREATE OR REPLACE FUNCTION cleanup_old_task_history()
RETURNS INTEGER AS $$
BEGIN
    DELETE FROM task_execution_history
    WHERE created_at < NOW() - INTERVAL '90 days';
    
    RETURN ROW_COUNT;
END;
$$ LANGUAGE plpgsql;

-- 清理函数：定期聚合和清理指标数据
CREATE OR REPLACE FUNCTION aggregate_and_cleanup_metrics()
RETURNS INTEGER AS $$
BEGIN
    -- 聚合 7 天前的指标（每小时聚合）
    INSERT INTO task_queue_metrics (task_type, metric_name, metric_value, labels, recorded_at)
    SELECT 
        task_type,
        metric_name,
        AVG(metric_value) as metric_value,
        labels,
        date_trunc('hour', recorded_at) as recorded_at
    FROM task_queue_metrics
    WHERE recorded_at < NOW() - INTERVAL '7 days'
      AND recorded_at >= NOW() - INTERVAL '30 days'
    GROUP BY task_type, metric_name, labels, date_trunc('hour', recorded_at)
    ON CONFLICT DO NOTHING;
    
    -- 删除 30 天前的原始数据
    DELETE FROM task_queue_metrics
    WHERE recorded_at < NOW() - INTERVAL '30 days';
    
    RETURN ROW_COUNT;
END;
$$ LANGUAGE plpgsql;

-- 视图：DLQ 统计摘要
CREATE OR REPLACE VIEW dlq_stats_view AS
SELECT 
    task_type,
    COUNT(*) as total_items,
    COUNT(*) FILTER (WHERE resolved_at IS NULL) as unresolved_items,
    COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved_items,
    MAX(failed_at) FILTER (WHERE resolved_at IS NULL) as latest_failure,
    MIN(failed_at) FILTER (WHERE resolved_at IS NULL) as oldest_failure,
    AVG(retry_count) FILTER (WHERE resolved_at IS NULL) as avg_retry_count,
    MAX(retry_count) FILTER (WHERE resolved_at IS NULL) as max_retry_count
FROM dead_letter_queue
GROUP BY task_type;

-- 视图：任务执行统计
CREATE OR REPLACE VIEW task_execution_stats_view AS
SELECT 
    task_type,
    COUNT(*) as total_executions,
    COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
    COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
    COUNT(*) FILTER (WHERE status = 'retrying') as retrying_count,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'completed)::NUMERIC / NULLIF(COUNT(*), 0) * 100,
        2
    ) as success_rate,
    AVG(duration_ms) FILTER (WHERE status = 'completed') as avg_duration_ms,
    MAX(duration_ms) FILTER (WHERE status = 'completed') as max_duration_ms
FROM task_execution_history
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY task_type;

-- 注释
COMMENT ON TABLE dead_letter_queue IS 'REQ-00519: 死信队列持久化存储';
COMMENT ON TABLE task_execution_history IS 'REQ-00519: 任务执行历史记录';
COMMENT ON TABLE task_queue_metrics IS 'REQ-00519: 任务队列指标历史';
COMMENT ON TABLE task_retry_configs IS 'REQ-00519: 任务重试策略配置';
COMMENT ON TABLE dlq_alert_rules IS 'REQ-00519: DLQ 告警规则配置';
