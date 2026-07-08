-- REQ-00484: 数据库连接池自动弹性伸缩与健康巡检系统
-- 创建连接池健康检查记录表和基准配置表

-- 连接池健康检查记录表
CREATE TABLE IF NOT EXISTS connection_pool_health_checks (
    id SERIAL PRIMARY KEY,
    is_healthy BOOLEAN NOT NULL DEFAULT true,
    pool_status JSONB NOT NULL DEFAULT '{}',
    response_time_ms INTEGER NOT NULL DEFAULT 0,
    issues JSONB NOT NULL DEFAULT '[]',
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 连接池伸缩历史表
CREATE TABLE IF NOT EXISTS connection_pool_scaling_history (
    id SERIAL PRIMARY KEY,
    action VARCHAR(20) NOT NULL CHECK (action IN ('scale_up', 'scale_down', 'health_check')),
    previous_connections INTEGER NOT NULL,
    target_connections INTEGER NOT NULL,
    actual_connections INTEGER NOT NULL,
    reason TEXT,
    pool_status JSONB NOT NULL DEFAULT '{}',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 连接池配置表
CREATE TABLE IF NOT EXISTS connection_pool_config (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL UNIQUE,
    min_connections INTEGER NOT NULL DEFAULT 5,
    max_connections INTEGER NOT NULL DEFAULT 100,
    scale_up_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.80,
    scale_down_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.30,
    health_check_interval_ms INTEGER NOT NULL DEFAULT 30000,
    idle_timeout_ms INTEGER NOT NULL DEFAULT 300000,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    last_modified TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    modified_by VARCHAR(100)
);

-- 插入默认配置
INSERT INTO connection_pool_config (service_name, min_connections, max_connections) VALUES
    ('gateway-service', 10, 200),
    ('user-service', 5, 50),
    ('pokemon-service', 10, 100),
    ('location-service', 5, 50),
    ('catch-service', 20, 300),
    ('gym-service', 10, 100),
    ('social-service', 5, 50),
    ('reward-service', 5, 30),
    ('payment-service', 5, 30)
ON CONFLICT (service_name) DO NOTHING;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pool_health_checks_time ON connection_pool_health_checks(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_pool_scaling_history_time ON connection_pool_scaling_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pool_health_healthy ON connection_pool_health_checks(is_healthy);

-- 连接池实时状态缓存（用于 Prometheus 指标）
CREATE TABLE IF NOT EXISTS connection_pool_realtime_stats (
    service_name VARCHAR(100) PRIMARY KEY,
    total_connections INTEGER NOT NULL DEFAULT 0,
    idle_connections INTEGER NOT NULL DEFAULT 0,
    active_connections INTEGER NOT NULL DEFAULT 0,
    waiting_clients INTEGER NOT NULL DEFAULT 0,
    utilization DECIMAL(5,4) NOT NULL DEFAULT 0,
    is_healthy BOOLEAN NOT NULL DEFAULT true,
    last_updated TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 更新触发器
CREATE OR REPLACE FUNCTION update_pool_stats_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_pool_stats_timestamp
    BEFORE UPDATE ON connection_pool_realtime_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_pool_stats_timestamp();

-- 注释
COMMENT ON TABLE connection_pool_health_checks IS '连接池健康检查记录';
COMMENT ON TABLE connection_pool_scaling_history IS '连接池伸缩历史记录';
COMMENT ON TABLE connection_pool_config IS '连接池自动伸缩配置';
COMMENT ON TABLE connection_pool_realtime_stats IS '连接池实时状态';