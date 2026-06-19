-- =====================================================
-- REQ-00060: 数据库分区表与大数据量表分区策略
-- =====================================================
-- 创建时间: 2026-06-19 00:00 UTC
-- 状态: implementing
-- =====================================================

-- 1. catch_records 分区改造
-- 创建分区父表
CREATE TABLE IF NOT EXISTS catch_records_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    location GEOMETRY(Point, 4326) NOT NULL,
    catch_method VARCHAR(50),
    ball_type VARCHAR(50),
    catch_rate DECIMAL(5, 4),
    experience_gained INTEGER,
    stardust_gained INTEGER,
    candy_gained INTEGER,
    device_info JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_catch_records_user_partitioned
    ON catch_records_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_pokemon_partitioned
    ON catch_records_partitioned (pokemon_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_location_partitioned
    ON catch_records_partitioned USING GIST (location);

-- 2. location_updates 分区改造
CREATE TABLE IF NOT EXISTS location_updates_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    location GEOMETRY(Point, 4326) NOT NULL,
    accuracy FLOAT,
    speed FLOAT,
    heading FLOAT,
    source VARCHAR(50),
    device_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_location_updates_user_partitioned
    ON location_updates_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_location_updates_location_partitioned
    ON location_updates_partitioned USING GIST (location);

-- 3. audit_logs 分区改造
CREATE TABLE IF NOT EXISTS audit_logs_partitioned (
    id UUID NOT NULL,
    user_id UUID,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(100),
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_partitioned
    ON audit_logs_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_partitioned
    ON audit_logs_partitioned (action, created_at);

-- 4. event_logs 分区改造
CREATE TABLE IF NOT EXISTS event_logs_partitioned (
    id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_source VARCHAR(50),
    payload JSONB,
    user_id UUID,
    session_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_event_logs_type_partitioned
    ON event_logs_partitioned (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_user_partitioned
    ON event_logs_partitioned (user_id, created_at);

-- 5. payment_transactions 分区改造
CREATE TABLE IF NOT EXISTS payment_transactions_partitioned (
    id UUID NOT NULL,
    order_id VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    currency CHAR(3) DEFAULT 'USD',
    status VARCHAR(50) NOT NULL,
    payment_method VARCHAR(50),
    provider VARCHAR(50),
    provider_transaction_id VARCHAR(200),
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_partitioned
    ON payment_transactions_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_partitioned
    ON payment_transactions_partitioned (order_id, created_at);

-- 6. 分区管理函数
CREATE OR REPLACE FUNCTION create_partition_if_not_exists(
    parent_table TEXT,
    partition_name TEXT,
    start_date TIMESTAMP WITH TIME ZONE,
    end_date TIMESTAMP WITH TIME ZONE
) RETURNS VOID AS $$
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        partition_name, parent_table, start_date, end_date
    );
END;
$$ LANGUAGE plpgsql;

-- 7. 创建初始分区（2026年6月）
SELECT create_partition_if_not_exists(
    'catch_records_partitioned',
    'catch_records_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'location_updates_partitioned',
    'location_updates_2026_06_01',
    '2026-06-01 00:00:00+00',
    '2026-06-02 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'audit_logs_partitioned',
    'audit_logs_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'event_logs_partitioned',
    'event_logs_2026_w01',
    '2026-06-01 00:00:00+00',
    '2026-06-08 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'payment_transactions_partitioned',
    'payment_transactions_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

-- 8. 创建未来3个月的分区（提前准备）
-- catch_records: 月分区
SELECT create_partition_if_not_exists('catch_records_partitioned', 'catch_records_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00');
SELECT create_partition_if_not_exists('catch_records_partitioned', 'catch_records_2026_08', '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00');
SELECT create_partition_if_not_exists('catch_records_partitioned', 'catch_records_2026_09', '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00');

-- audit_logs: 月分区
SELECT create_partition_if_not_exists('audit_logs_partitioned', 'audit_logs_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00');
SELECT create_partition_if_not_exists('audit_logs_partitioned', 'audit_logs_2026_08', '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00');
SELECT create_partition_if_not_exists('audit_logs_partitioned', 'audit_logs_2026_09', '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00');

-- payment_transactions: 月分区
SELECT create_partition_if_not_exists('payment_transactions_partitioned', 'payment_transactions_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00');
SELECT create_partition_if_not_exists('payment_transactions_partitioned', 'payment_transactions_2026_08', '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00');
SELECT create_partition_if_not_exists('payment_transactions_partitioned', 'payment_transactions_2026_09', '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00');

-- event_logs: 周分区（未来3周）
SELECT create_partition_if_not_exists('event_logs_partitioned', 'event_logs_2026_w02', '2026-06-08 00:00:00+00', '2026-06-15 00:00:00+00');
SELECT create_partition_if_not_exists('event_logs_partitioned', 'event_logs_2026_w03', '2026-06-15 00:00:00+00', '2026-06-22 00:00:00+00');
SELECT create_partition_if_not_exists('event_logs_partitioned', 'event_logs_2026_w04', '2026-06-22 00:00:00+00', '2026-06-29 00:00:00+00');

-- 9. 分区维护视图
CREATE OR REPLACE VIEW partition_status AS
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
    pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
FROM pg_tables
WHERE tablename LIKE '%_partitioned' OR tablename ~ '^((catch_records|location_updates|audit_logs|event_logs|payment_transactions)_[0-9])'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- 10. 注释
COMMENT ON TABLE catch_records_partitioned IS '分区表：精灵捕捉记录（按月分区）';
COMMENT ON TABLE location_updates_partitioned IS '分区表：位置更新记录（按日分区）';
COMMENT ON TABLE audit_logs_partitioned IS '分区表：审计日志（按月分区）';
COMMENT ON TABLE event_logs_partitioned IS '分区表：事件日志（按周分区）';
COMMENT ON TABLE payment_transactions_partitioned IS '分区表：支付交易记录（按月分区）';

COMMENT ON FUNCTION create_partition_if_not_exists IS '自动创建分区（如不存在）';
