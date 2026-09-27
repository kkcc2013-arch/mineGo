-- =====================================================
-- REQ-00060: 数据库分区表与大数据量表分区策略
-- 创建时间: 2026-06-10 10:00
-- 描述: 将高增长表转换为分区表，支持时间范围分区
-- =====================================================

-- 分区管理函数
-- 函数原名 create_partition_if_not_exists 与 20260619_000000__add_table_partitioning.sql 中的同名函数返回类型不同，改名避免冲突（partition_overview 亦被 20260708_070000 占用）
CREATE OR REPLACE FUNCTION create_range_partition_if_absent(
  parent_table TEXT,
  partition_name TEXT,
  start_date TIMESTAMP WITH TIME ZONE,
  end_date TIMESTAMP WITH TIME ZONE
) RETURNS BOOLEAN AS $$
DECLARE
  partition_exists INTEGER;
BEGIN
  SELECT count(*) INTO partition_exists
  FROM pg_class WHERE relname = partition_name;
  
  IF partition_exists > 0 THEN
    RETURN FALSE;
  END IF;
  
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name, parent_table, start_date, end_date
  );
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 1. catch_records 分区改造
-- =====================================================

-- 创建分区父表
CREATE TABLE IF NOT EXISTS catch_records (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    location GEOMETRY(Point, 4326),
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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS pokemon_id UUID;
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS location GEOMETRY(Point, 4326);
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS catch_method VARCHAR(50);
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS ball_type VARCHAR(50);
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS catch_rate DECIMAL(5, 4);
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS experience_gained INTEGER;
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS stardust_gained INTEGER;
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS candy_gained INTEGER;
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS device_info JSONB;
ALTER TABLE catch_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.catch_records') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'user_id', 'pokemon_id', 'location', 'catch_method', 'ball_type', 'catch_rate', 'experience_gained', 'stardust_gained', 'candy_gained', 'device_info', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE catch_records ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_catch_records_user 
    ON catch_records (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_pokemon 
    ON catch_records (pokemon_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_location 
    ON catch_records USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_catch_records_created 
    ON catch_records (created_at);

-- 创建初始分区（当前月和未来3个月）
SELECT create_range_partition_if_absent(
    'catch_records',
    'catch_records_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'catch_records',
    'catch_records_2026_07',
    '2026-07-01 00:00:00+00',
    '2026-08-01 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'catch_records',
    'catch_records_2026_08',
    '2026-08-01 00:00:00+00',
    '2026-09-01 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'catch_records',
    'catch_records_2026_09',
    '2026-09-01 00:00:00+00',
    '2026-10-01 00:00:00+00'
);

-- =====================================================
-- 2. location_updates 分区改造
-- =====================================================

CREATE TABLE IF NOT EXISTS location_updates (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    location GEOMETRY(Point, 4326),
    accuracy FLOAT,
    speed FLOAT,
    heading FLOAT,
    source VARCHAR(50),
    device_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS location GEOMETRY(Point, 4326);
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS accuracy FLOAT;
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS speed FLOAT;
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS heading FLOAT;
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS source VARCHAR(50);
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS device_id VARCHAR(100);
ALTER TABLE location_updates ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.location_updates') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'user_id', 'location', 'accuracy', 'speed', 'heading', 'source', 'device_id', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE location_updates ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_location_updates_user 
    ON location_updates (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_location_updates_location 
    ON location_updates USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_location_updates_created 
    ON location_updates (created_at);

-- 创建初始日分区（今天和未来7天）
SELECT create_range_partition_if_absent(
    'location_updates',
    'location_updates_2026_06_10',
    '2026-06-10 00:00:00+00',
    '2026-06-11 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'location_updates',
    'location_updates_2026_06_11',
    '2026-06-11 00:00:00+00',
    '2026-06-12 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'location_updates',
    'location_updates_2026_06_12',
    '2026-06-12 00:00:00+00',
    '2026-06-13 00:00:00+00'
);

-- =====================================================
-- 3. audit_logs 分区改造
-- =====================================================

CREATE TABLE IF NOT EXISTS audit_logs (
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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action VARCHAR(100);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource_type VARCHAR(50);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource_id VARCHAR(100);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS old_values JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS new_values JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.audit_logs') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'user_id', 'action', 'resource_type', 'resource_id', 'old_values', 'new_values', 'ip_address', 'user_agent', 'metadata', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE audit_logs ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_audit_logs_user 
    ON audit_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action 
    ON audit_logs (action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource 
    ON audit_logs (resource_type, resource_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created 
    ON audit_logs (created_at);

-- 创建初始月分区
SELECT create_range_partition_if_absent(
    'audit_logs',
    'audit_logs_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'audit_logs',
    'audit_logs_2026_07',
    '2026-07-01 00:00:00+00',
    '2026-08-01 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'audit_logs',
    'audit_logs_2026_08',
    '2026-08-01 00:00:00+00',
    '2026-09-01 00:00:00+00'
);

-- =====================================================
-- 4. event_logs 分区改造
-- =====================================================

CREATE TABLE IF NOT EXISTS event_logs (
    id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_source VARCHAR(50),
    payload JSONB,
    user_id UUID,
    session_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE event_logs ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE event_logs ADD COLUMN IF NOT EXISTS event_type VARCHAR(100);
ALTER TABLE event_logs ADD COLUMN IF NOT EXISTS event_source VARCHAR(50);
ALTER TABLE event_logs ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE event_logs ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE event_logs ADD COLUMN IF NOT EXISTS session_id VARCHAR(100);
ALTER TABLE event_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.event_logs') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'event_type', 'event_source', 'payload', 'user_id', 'session_id', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE event_logs ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_event_logs_type 
    ON event_logs (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_user 
    ON event_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_session 
    ON event_logs (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_created 
    ON event_logs (created_at);

-- 创建初始周分区
SELECT create_range_partition_if_absent(
    'event_logs',
    'event_logs_2026_w24',
    '2026-06-09 00:00:00+00',
    '2026-06-16 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'event_logs',
    'event_logs_2026_w25',
    '2026-06-16 00:00:00+00',
    '2026-06-23 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'event_logs',
    'event_logs_2026_w26',
    '2026-06-23 00:00:00+00',
    '2026-06-30 00:00:00+00'
);

-- =====================================================
-- 5. payment_transactions 分区改造
-- =====================================================

CREATE TABLE IF NOT EXISTS payment_transactions (
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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS order_id VARCHAR(100);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(20, 2);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS currency CHAR(3) DEFAULT 'USD';
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(50);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS provider VARCHAR(50);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS provider_transaction_id VARCHAR(200);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.payment_transactions') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'order_id', 'user_id', 'amount', 'currency', 'status', 'payment_method', 'provider', 'provider_transaction_id', 'metadata', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE payment_transactions ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user 
    ON payment_transactions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_order 
    ON payment_transactions (order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status 
    ON payment_transactions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_created 
    ON payment_transactions (created_at);

-- 创建初始月分区
SELECT create_range_partition_if_absent(
    'payment_transactions',
    'payment_transactions_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'payment_transactions',
    'payment_transactions_2026_07',
    '2026-07-01 00:00:00+00',
    '2026-08-01 00:00:00+00'
);

SELECT create_range_partition_if_absent(
    'payment_transactions',
    'payment_transactions_2026_08',
    '2026-08-01 00:00:00+00',
    '2026-09-01 00:00:00+00'
);

-- =====================================================
-- 6. 分区统计视图
-- =====================================================

-- 与 20260707_060000__complete_partition_management.sql 的 partition_stats 列不同，改名避免冲突（partition_overview 亦被 20260708_070000 占用）
CREATE OR REPLACE VIEW partition_table_overview AS
SELECT 
    pc.relname AS parent_table,
    pt.relname AS partition_name,
    pg_relation_size(pt.oid) AS size_bytes,
    pt.reltuples::bigint AS estimated_rows,
    pg_get_expr(pt.relpartbound, pt.oid) AS partition_bound
FROM pg_class pc
JOIN pg_inherits pi ON pc.oid = pi.inhparent
JOIN pg_class pt ON pi.inhrelid = pt.oid
WHERE pc.relkind = 'p'  -- 分区父表
ORDER BY pc.relname, pt.relname;

-- =====================================================
-- 7. 分区维护定时任务函数
-- =====================================================

CREATE OR REPLACE FUNCTION maintain_partitions()
RETURNS TABLE(
    table_name TEXT,
    action TEXT,
    partition_name TEXT,
    success BOOLEAN
) AS $$
DECLARE
    tbl RECORD;
    partition RECORD;
    partition_start TIMESTAMP WITH TIME ZONE;
    partition_end TIMESTAMP WITH TIME ZONE;
    partition_name_str TEXT;
BEGIN
    -- 遍历需要维护的表
    FOR tbl IN 
        SELECT unnest(ARRAY['catch_records', 'location_updates', 'audit_logs', 'event_logs', 'payment_transactions']) AS table_name
    LOOP
        -- 创建下个月的分区（示例：月分区）
        partition_start := date_trunc('month', CURRENT_TIMESTAMP + INTERVAL '1 month');
        partition_end := date_trunc('month', CURRENT_TIMESTAMP + INTERVAL '2 months');
        partition_name_str := tbl.table_name || '_' || to_char(partition_start, 'YYYY_MM');
        
        BEGIN
            PERFORM create_range_partition_if_absent(
                tbl.table_name,
                partition_name_str,
                partition_start,
                partition_end
            );
            
            RETURN QUERY SELECT tbl.table_name::TEXT, 'created'::TEXT, partition_name_str::TEXT, TRUE::BOOLEAN;
        EXCEPTION WHEN OTHERS THEN
            -- 分区已存在，忽略
            NULL;
        END;
    END LOOP;
    
    RETURN;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 完成标记
-- =====================================================

COMMENT ON TABLE catch_records IS 'REQ-00060: 精灵捕捉记录分区表（月分区）';
COMMENT ON TABLE location_updates IS 'REQ-00060: 位置更新分区表（日分区）';
COMMENT ON TABLE audit_logs IS 'REQ-00060: 审计日志分区表（月分区）';
COMMENT ON TABLE event_logs IS 'REQ-00060: 事件日志分区表（周分区）';
COMMENT ON TABLE payment_transactions IS 'REQ-00060: 支付交易分区表（月分区）';
