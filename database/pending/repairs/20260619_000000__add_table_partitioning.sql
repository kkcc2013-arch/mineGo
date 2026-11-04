-- Source-bound duplicate migration repair. Actual business parents remain canonical.
-- Weekly bounds retain the already established June9 phase; no overlapping shadow ranges.
DO $canonical$
DECLARE name text; parent oid;
BEGIN
  IF to_regprocedure('minego_create_time_partition(text,text,timestamp with time zone,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'Guarded partition prerequisite is required';
  END IF;
  FOREACH name IN ARRAY ARRAY['catch_records','location_updates','audit_logs','event_logs','payment_transactions'] LOOP
    parent:=to_regclass(format('%I.%I',current_schema(),name));
    IF NOT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_attribute a
      ON a.attrelid=p.partrelid AND a.attnum=p.partattrs[0]
      WHERE p.partrelid=parent AND p.partstrat='r' AND p.partnatts=1 AND a.attname='created_at') THEN
      RAISE EXCEPTION 'Canonical created_at range parent required: %',name;
    END IF;
    IF to_regclass(format('%I.%I',current_schema(),name||'_partitioned')) IS NOT NULL THEN
      RAISE EXCEPTION 'Existing shadow partition layout requires explicit adoption: %',name;
    END IF;
  END LOOP;
END
$canonical$;

-- =====================================================
-- REQ-00060: 数据库分区表与大数据量表分区策略
-- =====================================================
-- 创建时间: 2026-06-19 00:00 UTC
-- 状态: implementing
-- =====================================================

-- 1. catch_records 分区改造
-- 创建分区父表
CREATE TABLE IF NOT EXISTS catch_records (
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
CREATE INDEX IF NOT EXISTS idx_catch_records_user
    ON catch_records (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_pokemon
    ON catch_records (pokemon_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_location
    ON catch_records USING GIST (location);

-- 2. location_updates 分区改造
CREATE TABLE IF NOT EXISTS location_updates (
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

CREATE INDEX IF NOT EXISTS idx_location_updates_user
    ON location_updates (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_location_updates_location
    ON location_updates USING GIST (location);

-- 3. audit_logs 分区改造
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

CREATE INDEX IF NOT EXISTS idx_audit_logs_user
    ON audit_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action
    ON audit_logs (action, created_at);

-- 4. event_logs 分区改造
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

CREATE INDEX IF NOT EXISTS idx_event_logs_type
    ON event_logs (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_user
    ON event_logs (user_id, created_at);

-- 5. payment_transactions 分区改造
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

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user
    ON payment_transactions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_order
    ON payment_transactions (order_id, created_at);

-- 6. 分区管理函数
-- Preserve the existing BOOLEAN helper and its metadata; use the guarded prerequisite directly.

-- 7. 创建初始分区（2026年6月）
SELECT minego_create_time_partition(
    'catch_records',
    'catch_records_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT minego_create_time_partition(
    'location_updates',
    'location_updates_2026_06_01',
    '2026-06-01 00:00:00+00',
    '2026-06-02 00:00:00+00'
);

SELECT minego_create_time_partition(
    'audit_logs',
    'audit_logs_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT minego_create_time_partition(
    'event_logs',
    'event_logs_2026_w23',
    '2026-06-02 00:00:00+00',
    '2026-06-09 00:00:00+00'
);

SELECT minego_create_time_partition(
    'payment_transactions',
    'payment_transactions_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

-- 8. 创建未来3个月的分区（提前准备）
-- catch_records: 月分区
SELECT minego_create_time_partition('catch_records', 'catch_records_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00');
SELECT minego_create_time_partition('catch_records', 'catch_records_2026_08', '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00');
SELECT minego_create_time_partition('catch_records', 'catch_records_2026_09', '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00');

-- audit_logs: 月分区
SELECT minego_create_time_partition('audit_logs', 'audit_logs_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00');
SELECT minego_create_time_partition('audit_logs', 'audit_logs_2026_08', '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00');
SELECT minego_create_time_partition('audit_logs', 'audit_logs_2026_09', '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00');

-- payment_transactions: 月分区
SELECT minego_create_time_partition('payment_transactions', 'payment_transactions_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00');
SELECT minego_create_time_partition('payment_transactions', 'payment_transactions_2026_08', '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00');
SELECT minego_create_time_partition('payment_transactions', 'payment_transactions_2026_09', '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00');

-- event_logs: 周分区（未来3周）
SELECT minego_create_time_partition('event_logs', 'event_logs_2026_w24', '2026-06-09 00:00:00+00', '2026-06-16 00:00:00+00');
SELECT minego_create_time_partition('event_logs', 'event_logs_2026_w25', '2026-06-16 00:00:00+00', '2026-06-23 00:00:00+00');
SELECT minego_create_time_partition('event_logs', 'event_logs_2026_w26', '2026-06-23 00:00:00+00', '2026-06-30 00:00:00+00');

-- 9. 分区维护视图
DO $status$
DECLARE expected text; actual text; existing oid := to_regclass(format('%I.partition_status',current_schema()));
BEGIN
  IF to_regclass('pg_temp.minego_partition_status_expected') IS NOT NULL THEN
    RAISE EXCEPTION 'Temporary status name is already owned';
  END IF;
  EXECUTE $view$CREATE TEMP VIEW minego_partition_status_expected AS
SELECT n.nspname AS schemaname, c.relname AS tablename,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
       pg_total_relation_size(c.oid) AS size_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=current_schema() AND
  (c.oid=ANY(ARRAY['catch_records'::regclass::oid,'location_updates'::regclass::oid,
    'audit_logs'::regclass::oid,'event_logs'::regclass::oid,'payment_transactions'::regclass::oid])
   OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid AND
     i.inhparent=ANY(ARRAY['catch_records'::regclass::oid,'location_updates'::regclass::oid,
       'audit_logs'::regclass::oid,'event_logs'::regclass::oid,'payment_transactions'::regclass::oid])))
ORDER BY pg_total_relation_size(c.oid) DESC
$view$;
  SELECT pg_get_viewdef('pg_temp.minego_partition_status_expected'::regclass,true) INTO expected;
  IF existing IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=existing AND relkind='v') THEN
      RAISE EXCEPTION 'Partition status name is owned by another relation';
    END IF;
    SELECT pg_get_viewdef(existing,true) INTO actual;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Partition status definition differs; explicit adoption required'; END IF;
  ELSE
    EXECUTE format('CREATE VIEW %I.partition_status AS %s',current_schema(),expected);
  END IF;
  DROP VIEW pg_temp.minego_partition_status_expected;
END
$status$;

-- Existing canonical relation/helper comments remain operator owned.
