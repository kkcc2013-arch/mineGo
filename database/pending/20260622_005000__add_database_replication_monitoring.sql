-- REQ-00259: 数据库读写分离与主从同步监控系统
-- 创建时间: 2026-06-22 00:50

-- ============================================================
-- 主从同步状态记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS replication_status (
    id SERIAL PRIMARY KEY,
    node_name VARCHAR(100) NOT NULL UNIQUE,
    node_type VARCHAR(20) NOT NULL CHECK (node_type IN ('master', 'replica', 'standby')),
    connection_string TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    is_healthy BOOLEAN DEFAULT true,
    last_check_at TIMESTAMPTZ,
    sync_delay_ms INTEGER DEFAULT 0,
    sync_lag_bytes BIGINT DEFAULT 0,
    connections_active INTEGER DEFAULT 0,
    connections_idle INTEGER DEFAULT 0,
    query_latency_ms INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 读写分离路由日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS read_write_routing_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_type VARCHAR(20) NOT NULL CHECK (query_type IN ('read', 'write')),
    target_node VARCHAR(100) NOT NULL,
    service_name VARCHAR(50),
    endpoint VARCHAR(200),
    query_hash VARCHAR(64),
    execution_time_ms INTEGER,
    success BOOLEAN DEFAULT true,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 主从切换事件记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS failover_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(50) NOT NULL,
    old_master VARCHAR(100),
    new_master VARCHAR(100),
    reason TEXT,
    duration_ms INTEGER,
    success BOOLEAN DEFAULT true,
    triggered_by VARCHAR(50) DEFAULT 'auto', -- auto, manual
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 连接池统计表
-- ============================================================
CREATE TABLE IF NOT EXISTS connection_pool_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_name VARCHAR(100) NOT NULL,
    pool_size INTEGER DEFAULT 0,
    pool_available INTEGER DEFAULT 0,
    pool_waiting INTEGER DEFAULT 0,
    total_queries INTEGER DEFAULT 0,
    avg_query_time_ms INTEGER DEFAULT 0,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 读写分离配置表
-- ============================================================
CREATE TABLE IF NOT EXISTS read_write_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 初始化默认配置
INSERT INTO read_write_config (key, value, description) VALUES
('sync_delay_threshold_ms', '100', '主从同步延迟阈值（毫秒），超过此值读取降级到主库'),
('read_weight_distribution', '["round-robin", "least-connections", "random"]', '读请求负载均衡策略'),
('replica_health_check_interval_ms', '5000', '从库健康检查间隔（毫秒）'),
('failover_timeout_ms', '30000', '故障切换超时时间（毫秒）'),
('max_replication_lag_bytes', '10485760', '最大允许的复制延迟字节数（10MB）'),
('read_from_master_on_failure', 'true', '从库不可用时是否降级到主库读取'),
('enable_query_routing_log', 'true', '是否启用查询路由日志记录')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 创建索引
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_replication_status_type ON replication_status(node_type, is_active);
CREATE INDEX IF NOT EXISTS idx_replication_status_health ON replication_status(is_healthy, sync_delay_ms);
CREATE INDEX IF NOT EXISTS idx_routing_logs_created ON read_write_routing_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_routing_logs_type_node ON read_write_routing_logs(query_type, target_node);
CREATE INDEX IF NOT EXISTS idx_failover_events_created ON failover_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_pool_stats_node ON connection_pool_stats(node_name, recorded_at DESC);

-- ============================================================
-- 视图：当前主从状态概览
-- ============================================================
CREATE OR REPLACE VIEW replication_overview AS
SELECT 
    node_name,
    node_type,
    is_healthy,
    sync_delay_ms,
    sync_lag_bytes,
    connections_active,
    query_latency_ms,
    last_check_at,
    EXTRACT(EPOCH FROM (NOW() - last_check_at)) as seconds_since_check,
    CASE 
        WHEN is_healthy = false THEN 'unhealthy'
        WHEN sync_delay_ms > (SELECT value::int FROM read_write_config WHERE key = 'sync_delay_threshold_ms') THEN 'lagging'
        ELSE 'healthy'
    END as health_status
FROM replication_status
WHERE is_active = true
ORDER BY node_type, node_name;

-- ============================================================
-- 视图：读写分布统计（按小时）
-- ============================================================
CREATE OR REPLACE VIEW read_write_hourly_stats AS
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    query_type,
    target_node,
    COUNT(*) as query_count,
    AVG(execution_time_ms) as avg_execution_time_ms,
    COUNT(*) FILTER (WHERE success = false) as error_count,
    COUNT(*) FILTER (WHERE success = true) as success_count
FROM read_write_routing_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', created_at), query_type, target_node
ORDER BY hour DESC, query_type;

-- ============================================================
-- 函数：更新从库健康状态
-- ============================================================
CREATE OR REPLACE FUNCTION update_replica_health(
    p_node_name VARCHAR,
    p_is_healthy BOOLEAN,
    p_sync_delay_ms INTEGER DEFAULT NULL,
    p_sync_lag_bytes BIGINT DEFAULT NULL,
    p_connections_active INTEGER DEFAULT NULL,
    p_query_latency_ms INTEGER DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    UPDATE replication_status
    SET 
        is_healthy = p_is_healthy,
        sync_delay_ms = COALESCE(p_sync_delay_ms, sync_delay_ms),
        sync_lag_bytes = COALESCE(p_sync_lag_bytes, sync_lag_bytes),
        connections_active = COALESCE(p_connections_active, connections_active),
        query_latency_ms = COALESCE(p_query_latency_ms, query_latency_ms),
        last_check_at = NOW(),
        updated_at = NOW()
    WHERE node_name = p_node_name;
    
    IF NOT FOUND THEN
        INSERT INTO replication_status (
            node_name, node_type, is_healthy, 
            sync_delay_ms, sync_lag_bytes,
            connections_active, query_latency_ms
        )
        VALUES (
            p_node_name, 'replica', p_is_healthy,
            COALESCE(p_sync_delay_ms, 0),
            COALESCE(p_sync_lag_bytes, 0),
            COALESCE(p_connections_active, 0),
            COALESCE(p_query_latency_ms, 0)
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 函数：记录路由日志
-- ============================================================
CREATE OR REPLACE FUNCTION log_routing_decision(
    p_query_type VARCHAR,
    p_target_node VARCHAR,
    p_service_name VARCHAR DEFAULT NULL,
    p_endpoint VARCHAR DEFAULT NULL,
    p_query_hash VARCHAR DEFAULT NULL,
    p_execution_time_ms INTEGER DEFAULT NULL,
    p_success BOOLEAN DEFAULT true,
    p_error_message TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_log_id UUID;
BEGIN
    INSERT INTO read_write_routing_logs (
        query_type, target_node, service_name, endpoint,
        query_hash, execution_time_ms, success, error_message
    )
    VALUES (
        p_query_type, p_target_node, p_service_name, p_endpoint,
        p_query_hash, p_execution_time_ms, p_success, p_error_message
    )
    RETURNING id INTO v_log_id;
    
    RETURN v_log_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 函数：记录故障切换事件
-- ============================================================
CREATE OR REPLACE FUNCTION log_failover_event(
    p_event_type VARCHAR,
    p_old_master VARCHAR DEFAULT NULL,
    p_new_master VARCHAR DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_duration_ms INTEGER DEFAULT NULL,
    p_success BOOLEAN DEFAULT true,
    p_triggered_by VARCHAR DEFAULT 'auto'
)
RETURNS UUID AS $$
DECLARE
    v_event_id UUID;
BEGIN
    INSERT INTO failover_events (
        event_type, old_master, new_master, reason,
        duration_ms, success, triggered_by
    )
    VALUES (
        p_event_type, p_old_master, p_new_master, p_reason,
        p_duration_ms, p_success, p_triggered_by
    )
    RETURNING id INTO v_event_id;
    
    RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 触发器：自动更新 updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_replication_status_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_replication_status
    BEFORE UPDATE ON replication_status
    FOR EACH ROW EXECUTE FUNCTION update_replication_status_updated_at();

CREATE TRIGGER trigger_update_read_write_config
    BEFORE UPDATE ON read_write_config
    FOR EACH ROW EXECUTE FUNCTION update_replication_status_updated_at();

-- ============================================================
-- 注释
-- ============================================================
COMMENT ON TABLE replication_status IS '主从节点状态信息';
COMMENT ON TABLE read_write_routing_logs IS '读写分离路由日志';
COMMENT ON TABLE failover_events IS '主从切换事件记录';
COMMENT ON TABLE connection_pool_stats IS '连接池统计信息';
COMMENT ON TABLE read_write_config IS '读写分离配置项';
