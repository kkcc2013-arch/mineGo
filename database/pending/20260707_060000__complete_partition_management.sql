-- =====================================================
-- REQ-00027: 游戏数据分区策略与自动化分区管理系统
-- =====================================================
-- 创建时间: 2026-07-07 06:00 UTC
-- 状态: implementing
-- =====================================================

-- 1. 分区管理函数

-- 创建单个分区的函数
CREATE OR REPLACE FUNCTION create_partition(
  p_table_name TEXT,
  p_start_date DATE,
  p_end_date DATE
) RETURNS VOID AS $$
DECLARE
  v_partition_name TEXT;
BEGIN
  v_partition_name := p_table_name || '_' || to_char(p_start_date, 'YYYY_MM_DD');
  
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    v_partition_name,
    p_table_name || '_partitioned',
    p_start_date,
    p_end_date
  );
  
  -- 创建分区局部索引
  PERFORM create_partition_indexes(v_partition_name, p_table_name);
END;
$$ LANGUAGE plpgsql;

-- 创建分区索引的函数
CREATE OR REPLACE FUNCTION create_partition_indexes(
  p_partition_name TEXT,
  p_table_name TEXT
) RETURNS VOID AS $$
BEGIN
  -- 根据表类型创建不同索引
  CASE p_table_name
    WHEN 'catch_records' THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_user ON %I (user_id)', p_partition_name, p_partition_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_created ON %I (created_at)', p_partition_name, p_partition_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_location ON %I USING GIST (location)', p_partition_name, p_partition_name);
    WHEN 'location_updates' THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_user ON %I (user_id)', p_partition_name, p_partition_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_location ON %I USING GIST (location)', p_partition_name, p_partition_name);
    WHEN 'audit_logs' THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_user ON %I (user_id)', p_partition_name, p_partition_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_action ON %I (action, created_at)', p_partition_name, p_partition_name);
    WHEN 'event_logs' THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_type ON %I (event_type, created_at)', p_partition_name, p_partition_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_user ON %I (user_id)', p_partition_name, p_partition_name);
    WHEN 'payment_transactions' THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_user ON %I (user_id)', p_partition_name, p_partition_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_status ON %I (status, created_at)', p_partition_name, p_partition_name);
    ELSE
      -- 默认索引
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_created ON %I (created_at)', p_partition_name, p_partition_name);
  END CASE;
END;
$$ LANGUAGE plpgsql;

-- 预创建未来分区的函数（提前7天）
CREATE OR REPLACE FUNCTION precreate_partitions(
  p_table_name TEXT,
  p_days_ahead INTEGER DEFAULT 7
) RETURNS TEXT[] AS $$
DECLARE
  v_created TEXT[];
  v_date DATE;
  v_partition_name TEXT;
BEGIN
  FOR i IN 0..p_days_ahead LOOP
    v_date := CURRENT_DATE + i;
    v_partition_name := p_table_name || '_' || to_char(v_date, 'YYYY_MM_DD');
    
    BEGIN
      PERFORM create_partition(
        p_table_name,
        v_date,
        v_date + INTERVAL '1 day'
      );
      v_created := array_append(v_created, v_partition_name);
    EXCEPTION WHEN duplicate_table THEN
      -- 分区已存在，跳过
      CONTINUE;
    END;
  END LOOP;
  
  RETURN v_created;
END;
$$ LANGUAGE plpgsql;

-- 归档旧分区的函数
CREATE OR REPLACE FUNCTION archive_old_partitions(
  p_table_name TEXT,
  p_retention_days INTEGER DEFAULT 90
) RETURNS TEXT[] AS $$
DECLARE
  v_partition RECORD;
  v_archived TEXT[];
  v_archive_name TEXT;
  v_cutoff_date DATE;
BEGIN
  v_cutoff_date := CURRENT_DATE - p_retention_days;
  
  FOR v_partition IN
    SELECT 
      pt.relname AS partition_name,
      pg_get_expr(pt.relpartbound, pt.oid) AS partition_bound
    FROM pg_class pc
    JOIN pg_inherits pi ON pc.oid = pi.inhparent
    JOIN pg_class pt ON pi.inhrelid = pt.oid
    WHERE pc.relname = p_table_name || '_partitioned'
      AND pt.relname ~ p_table_name || '_\d{4}_\d{2}_\d{2}'
    ORDER BY pt.relname
  LOOP
    -- 解析分区日期
    DECLARE
      v_partition_date DATE;
    BEGIN
      v_partition_date := to_date(
        substring(v_partition.partition_name from '(\d{4}_\d{2}_\d{2})'),
        'YYYY_MM_DD'
      );
      
      IF v_partition_date < v_cutoff_date THEN
        -- 分离分区
        EXECUTE format('ALTER TABLE %s_partitioned DETACH PARTITION %I', 
          p_table_name, v_partition.partition_name);
        
        -- 重命名为归档表
        v_archive_name := p_table_name || '_archive_' || to_char(v_partition_date, 'YYYY_MM_DD');
        EXECUTE format('ALTER TABLE %I RENAME TO %I', 
          v_partition.partition_name, v_archive_name);
        
        v_archived := array_append(v_archived, v_archive_name);
        
        RAISE NOTICE 'Archived partition: %', v_archive_name;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Failed to archive partition %: %', v_partition.partition_name, SQLERRM;
    END;
  END LOOP;
  
  RETURN v_archived;
END;
$$ LANGUAGE plpgsql;

-- 清理过期分区的函数
CREATE OR REPLACE FUNCTION drop_expired_partitions(
  p_table_name TEXT,
  p_retention_days INTEGER
) RETURNS TEXT[] AS $$
DECLARE
  v_partition RECORD;
  v_dropped TEXT[];
  v_cutoff_date DATE;
BEGIN
  IF p_retention_days IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  END IF;
  
  v_cutoff_date := CURRENT_DATE - p_retention_days;
  
  FOR v_partition IN
    SELECT 
      pt.relname AS partition_name
    FROM pg_class pc
    JOIN pg_inherits pi ON pc.oid = pi.inhparent
    JOIN pg_class pt ON pi.inhrelid = pt.oid
    WHERE pc.relname = p_table_name || '_partitioned'
      AND pt.relname ~ p_table_name || '_\d{4}_\d{2}_\d{2}'
    ORDER BY pt.relname
  LOOP
    DECLARE
      v_partition_date DATE;
    BEGIN
      v_partition_date := to_date(
        substring(v_partition.partition_name from '(\d{4}_\d{2}_\d{2})'),
        'YYYY_MM_DD'
      );
      
      IF v_partition_date < v_cutoff_date THEN
        EXECUTE format('DROP TABLE IF EXISTS %I', v_partition.partition_name);
        v_dropped := array_append(v_dropped, v_partition.partition_name);
        
        RAISE NOTICE 'Dropped partition: %', v_partition.partition_name;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Failed to drop partition %: %', v_partition.partition_name, SQLERRM;
    END;
  END LOOP;
  
  RETURN v_dropped;
END;
$$ LANGUAGE plpgsql;

-- 2. 分区统计视图

CREATE OR REPLACE VIEW partition_stats AS
SELECT
  p.relname AS parent_table,
  c.relname AS partition_name,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
  pg_total_relation_size(c.oid) AS size_bytes,
  (SELECT count(*) FROM pg_stat_user_tables WHERE relname = c.relname) AS row_count,
  c.reltuples::BIGINT AS estimated_rows
FROM pg_class p
JOIN pg_inherits i ON p.oid = i.inhparent
JOIN pg_class c ON i.inhrelid = c.oid
WHERE p.relname LIKE '%_partitioned'
ORDER BY p.relname, c.relname;

-- 3. 分区健康检查函数

CREATE OR REPLACE FUNCTION check_partition_health(
  p_table_name TEXT
) RETURNS TABLE(
  table_name TEXT,
  partition_count BIGINT,
  total_size TEXT,
  default_partition_count BIGINT,
  oldest_partition DATE,
  newest_partition DATE,
  health_status TEXT
) AS $$
DECLARE
  v_count BIGINT;
  v_size BIGINT;
  v_default_count BIGINT;
  v_oldest DATE;
  v_newest DATE;
  v_status TEXT;
BEGIN
  -- 计算分区数量
  SELECT count(*) INTO v_count
  FROM pg_class pc
  JOIN pg_inherits pi ON pc.oid = pi.inhparent
  JOIN pg_class pt ON pi.inhrelid = pt.oid
  WHERE pc.relname = p_table_name || '_partitioned';
  
  -- 计算总大小
  SELECT COALESCE(SUM(pg_total_relation_size(pt.oid)), 0) INTO v_size
  FROM pg_class pc
  JOIN pg_inherits pi ON pc.oid = pi.inhparent
  JOIN pg_class pt ON pi.inhrelid = pt.oid
  WHERE pc.relname = p_table_name || '_partitioned';
  
  -- 检查默认分区
  SELECT count(*) INTO v_default_count
  FROM pg_class pc
  JOIN pg_inherits pi ON pc.oid = pi.inhparent
  JOIN pg_class pt ON pi.inhrelid = pt.oid
  WHERE pc.relname = p_table_name || '_partitioned'
    AND pt.relname = p_table_name || '_default';
  
  -- 检查最旧和最新分区
  SELECT MIN(to_date(substring(pt.relname from '(\d{4}_\d{2}_\d{2})'), 'YYYY_MM_DD'))
  INTO v_oldest
  FROM pg_class pc
  JOIN pg_inherits pi ON pc.oid = pi.inhparent
  JOIN pg_class pt ON pi.inhrelid = pt.oid
  WHERE pc.relname = p_table_name || '_partitioned'
    AND pt.relname ~ p_table_name || '_\d{4}_\d{2}_\d{2}';
  
  SELECT MAX(to_date(substring(pt.relname from '(\d{4}_\d{2}_\d{2})'), 'YYYY_MM_DD'))
  INTO v_newest
  FROM pg_class pc
  JOIN pg_inherits pi ON pc.oid = pi.inhparent
  JOIN pg_class pt ON pi.inhrelid = pt.oid
  WHERE pc.relname = p_table_name || '_partitioned'
    AND pt.relname ~ p_table_name || '_\d{4}_\d{2}_\d{2}';
  
  -- 评估健康状态
  IF v_default_count > 0 THEN
    v_status := 'WARNING: Default partition exists, may contain misrouted data';
  ELSIF v_newest IS NULL OR v_newest < CURRENT_DATE THEN
    v_status := 'WARNING: No future partitions created';
  ELSIF v_count < 3 THEN
    v_status := 'WARNING: Too few partitions';
  ELSE
    v_status := 'HEALTHY';
  END IF;
  
  RETURN QUERY SELECT
    p_table_name::TEXT,
    v_count,
    pg_size_pretty(v_size)::TEXT,
    v_default_count,
    v_oldest,
    v_newest,
    v_status::TEXT;
END;
$$ LANGUAGE plpgsql;

-- 4. 自动维护定时任务（需要 pg_cron 扩展）

-- 安装 pg_cron 扩展（如果未安装）
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 每天凌晨 2:00 预创建分区
SELECT cron.schedule(
  'precreate-catch-partitions',
  '0 2 * * *',
  $$SELECT precreate_partitions('catch_records', 7)$$
);

SELECT cron.schedule(
  'precreate-location-partitions',
  '0 2 * * *',
  $$SELECT precreate_partitions('location_updates', 7)$$
);

SELECT cron.schedule(
  'precreate-audit-partitions',
  '0 2 * * *',
  $$SELECT precreate_partitions('audit_logs', 7)$$
);

SELECT cron.schedule(
  'precreate-event-partitions',
  '0 2 * * *',
  $$SELECT precreate_partitions('event_logs', 7)$$
);

SELECT cron.schedule(
  'precreate-payment-partitions',
  '0 2 * * *',
  $$SELECT precreate_partitions('payment_transactions', 7)$$
);

-- 每天凌晨 3:00 归档旧分区
SELECT cron.schedule(
  'archive-old-catch-partitions',
  '0 3 * * *',
  $$SELECT archive_old_partitions('catch_records', 90)$$
);

SELECT cron.schedule(
  'archive-old-location-partitions',
  '0 3 * * *',
  $$SELECT archive_old_partitions('location_updates', 30)$$
);

SELECT cron.schedule(
  'archive-old-audit-partitions',
  '0 3 * * *',
  $$SELECT archive_old_partitions('audit_logs', 365)$$
);

-- 每天凌晨 4:00 清理过期分区
SELECT cron.schedule(
  'drop-expired-location-partitions',
  '0 4 * * *',
  $$SELECT drop_expired_partitions('location_updates', 60)$$
);

SELECT cron.schedule(
  'drop-expired-event-partitions',
  '0 4 * * *',
  $$SELECT drop_expired_partitions('event_logs', 90)$$
);

-- 每小时检查分区健康状态
SELECT cron.schedule(
  'check-partition-health',
  '0 * * * *',
  $$SELECT check_partition_health('catch_records')$$
);

-- 5. 创建默认分区（防止数据丢失）

CREATE TABLE IF NOT EXISTS catch_records_default 
  PARTITION OF catch_records_partitioned DEFAULT;

CREATE TABLE IF NOT EXISTS location_updates_default 
  PARTITION OF location_updates_partitioned DEFAULT;

CREATE TABLE IF NOT EXISTS audit_logs_default 
  PARTITION OF audit_logs_partitioned DEFAULT;

CREATE TABLE IF NOT EXISTS event_logs_default 
  PARTITION OF event_logs_partitioned DEFAULT;

CREATE TABLE IF NOT EXISTS payment_transactions_default 
  PARTITION OF payment_transactions_partitioned DEFAULT;

-- 6. 创建初始分区（当前月份和未来2个月）

-- catch_records 初始分区
SELECT create_partition('catch_records', DATE_TRUNC('month', CURRENT_DATE), DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month');
SELECT create_partition('catch_records', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '2 month');
SELECT create_partition('catch_records', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '2 month', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '3 month');

-- location_updates 初始分区（按天）
SELECT precreate_partitions('location_updates', 7);

-- audit_logs 初始分区
SELECT create_partition('audit_logs', DATE_TRUNC('month', CURRENT_DATE), DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month');
SELECT create_partition('audit_logs', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '2 month');

-- event_logs 初始分区（按周）
SELECT create_partition('event_logs', DATE_TRUNC('week', CURRENT_DATE), DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 week');
SELECT create_partition('event_logs', DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 week', DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '2 week');

-- payment_transactions 初始分区
SELECT create_partition('payment_transactions', DATE_TRUNC('month', CURRENT_DATE), DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month');
SELECT create_partition('payment_transactions', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month', DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '2 month');

-- 7. 创建视图用于查询历史数据

CREATE OR REPLACE VIEW catch_records_archive_view AS
SELECT * FROM catch_records_partitioned
UNION ALL
SELECT * FROM catch_records_archive_2025_01
UNION ALL
SELECT * FROM catch_records_archive_2025_02
-- 添加更多归档表
;

-- 8. 性能监控函数

CREATE OR REPLACE FUNCTION get_partition_query_performance(
  p_table_name TEXT
) RETURNS TABLE(
  query TEXT,
  calls BIGINT,
  total_time DECIMAL,
  mean_time DECIMAL,
  rows BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    q.query,
    q.calls,
    q.total_exec_time::DECIMAL,
    q.mean_exec_time::DECIMAL,
    q.rows
  FROM pg_stat_statements q
  WHERE q.query LIKE '%' || p_table_name || '%'
    AND q.query LIKE '%SELECT%'
  ORDER BY q.total_exec_time DESC
  LIMIT 20;
END;
$$ LANGUAGE plpgsql;

-- 确保扩展存在
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 完成提示
DO $$
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'REQ-00027: Partition Management System';
  RAISE NOTICE 'Status: Implemented';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Created functions:';
  RAISE NOTICE '  - create_partition()';
  RAISE NOTICE '  - precreate_partitions()';
  RAISE NOTICE '  - archive_old_partitions()';
  RAISE NOTICE '  - drop_expired_partitions()';
  RAISE NOTICE '  - check_partition_health()';
  RAISE NOTICE '  - get_partition_query_performance()';
  RAISE NOTICE '';
  RAISE NOTICE 'Created views:';
  RAISE NOTICE '  - partition_stats';
  RAISE NOTICE '  - catch_records_archive_view';
  RAISE NOTICE '';
  RAISE NOTICE 'Scheduled jobs:';
  RAISE NOTICE '  - Daily 2:00 UTC: Precreate partitions';
  RAISE NOTICE '  - Daily 3:00 UTC: Archive old partitions';
  RAISE NOTICE '  - Daily 4:00 UTC: Drop expired partitions';
  RAISE NOTICE '  - Hourly: Health check';
END $$;
