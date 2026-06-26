-- database/migrations/20260626100100_create_partition_functions.sql
-- 分区管理函数
-- REQ-00323: 数据库分区表与大数据量表分区策略

-- 创建分区管理函数
CREATE OR REPLACE FUNCTION create_monthly_partitions(
    table_name TEXT,
    start_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    months_ahead INTEGER DEFAULT 3,
    months_behind INTEGER DEFAULT 12
) RETURNS VOID AS $$
DECLARE
    partition_date TIMESTAMP WITH TIME ZONE;
    partition_start TIMESTAMP WITH TIME ZONE;
    partition_end TIMESTAMP WITH TIME ZONE;
    partition_name TEXT;
    i INTEGER;
BEGIN
    -- 创建过去的分区
    FOR i IN 0..(months_behind - 1) LOOP
        partition_date := date_trunc('month', start_date - (i || ' months')::INTERVAL);
        partition_start := partition_date;
        partition_end := partition_date + INTERVAL '1 month';
        partition_name := table_name || '_y' || to_char(partition_date, 'YYYY') || '_m' || to_char(partition_date, 'MM');
        
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_name, partition_start, partition_end
        );
        
        -- 为分区创建本地索引
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_user_id ON %I (user_id)',
            partition_name, partition_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_created ON %I (created_at)',
            partition_name, partition_name
        );
    END LOOP;
    
    -- 创建未来的分区
    FOR i IN 1..months_ahead LOOP
        partition_date := date_trunc('month', start_date + (i || ' months')::INTERVAL);
        partition_start := partition_date;
        partition_end := partition_date + INTERVAL '1 month';
        partition_name := table_name || '_y' || to_char(partition_date, 'YYYY') || '_m' || to_char(partition_date, 'MM');
        
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_name, partition_start, partition_end
        );
        
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_user_id ON %I (user_id)',
            partition_name, partition_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_created ON %I (created_at)',
            partition_name, partition_name
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_monthly_partitions IS '为指定表创建月度分区';

-- 自动创建下个月分区的函数
CREATE OR REPLACE FUNCTION auto_create_next_month_partition()
RETURNS VOID AS $$
DECLARE
    table_record RECORD;
    next_month TIMESTAMP WITH TIME ZONE;
    partition_start TIMESTAMP WITH TIME ZONE;
    partition_end TIMESTAMP WITH TIME ZONE;
    partition_name TEXT;
BEGIN
    next_month := date_trunc('month', CURRENT_TIMESTAMP + INTERVAL '1 month');
    partition_start := next_month;
    partition_end := next_month + INTERVAL '1 month';
    
    FOR table_record IN 
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE '%_partitioned'
    LOOP
        partition_name := table_record.tablename || '_y' || to_char(next_month, 'YYYY') || '_m' || to_char(next_month, 'MM');
        
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_record.tablename, partition_start, partition_end
        );
        
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_user_id ON %I (user_id)',
            partition_name, partition_name
        );
        
        RAISE NOTICE 'Created partition: %', partition_name;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_create_next_month_partition IS '自动为所有分区表创建下个月的分区';

-- 删除旧分区的函数
CREATE OR REPLACE FUNCTION drop_old_partitions(
    table_name TEXT,
    retention_months INTEGER DEFAULT 12
) RETURNS VOID AS $$
DECLARE
    cutoff_date TIMESTAMP WITH TIME ZONE;
    partition_record RECORD;
    year_mon TEXT[];
    partition_date TIMESTAMP WITH TIME ZONE;
BEGIN
    cutoff_date := date_trunc('month', CURRENT_TIMESTAMP - (retention_months || ' months')::INTERVAL);
    
    FOR partition_record IN 
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE table_name || '_y%'
    LOOP
        -- 从分区名称中提取日期
        year_mon := regexp_match(partition_record.tablename, 'y(\d{4})_m(\d{2})');
        
        IF year_mon IS NOT NULL THEN
            partition_date := make_date(year_mon[1]::INTEGER, year_mon[2]::INTEGER, 1);
            
            IF partition_date < cutoff_date THEN
                EXECUTE format('DROP TABLE IF EXISTS %I', partition_record.tablename);
                RAISE NOTICE 'Dropped old partition: %', partition_record.tablename;
            END IF;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION drop_old_partitions IS '删除超过保留期限的旧分区';

-- 获取分区统计信息的函数
CREATE OR REPLACE FUNCTION get_partition_stats(
    table_name TEXT
) RETURNS TABLE (
    partition_name TEXT,
    size_pretty TEXT,
    size_bytes BIGINT,
    row_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        t.tablename::TEXT as partition_name,
        pg_size_pretty(pg_total_relation_size(t.schemaname || '.' || t.tablename))::TEXT as size_pretty,
        pg_total_relation_size(t.schemaname || '.' || t.tablename) as size_bytes,
        COALESCE((
            SELECT reltuples::BIGINT 
            FROM pg_class 
            WHERE relname = t.tablename
        ), 0) as row_count
    FROM pg_tables t
    WHERE t.schemaname = 'public'
    AND t.tablename LIKE table_name || '_y%'
    ORDER BY t.tablename;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_partition_stats IS '获取指定表的分区统计信息';

-- 初始化分区（为所有分区表创建默认分区）
SELECT create_monthly_partitions('catch_records_partitioned');
SELECT create_monthly_partitions('battle_logs_partitioned');
SELECT create_monthly_partitions('user_activities_partitioned', CURRENT_TIMESTAMP, 3, 6);
SELECT create_monthly_partitions('pokemon_location_history_partitioned', CURRENT_TIMESTAMP, 3, 6);
SELECT create_monthly_partitions('audit_logs_partitioned', CURRENT_TIMESTAMP, 3, 24);
SELECT create_monthly_partitions('notifications_partitioned', CURRENT_TIMESTAMP, 3, 6);