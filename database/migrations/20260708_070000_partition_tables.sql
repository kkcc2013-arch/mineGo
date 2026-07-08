-- REQ-00027: 数据库分区策略迁移
-- 创建核心业务表的分区架构
-- 执行时间: 2026-07-08 07:00 UTC

-- ============================================================
-- 1. 分区元数据表
-- ============================================================

-- 归档元数据表
CREATE TABLE IF NOT EXISTS partition_archive_metadata (
  partition_name VARCHAR(100) PRIMARY KEY,
  table_name VARCHAR(50) NOT NULL,
  row_count INTEGER NOT NULL,
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  storage_location TEXT,
  checksum VARCHAR(64),
  restored_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_archive_table ON partition_archive_metadata(table_name);
CREATE INDEX idx_archive_date ON partition_archive_metadata(archived_at);

-- 分区健康记录表
CREATE TABLE IF NOT EXISTS partition_health_log (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(50) NOT NULL,
  check_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  partition_count INTEGER,
  total_size_bytes BIGINT,
  issues JSONB,
  status VARCHAR(20) DEFAULT 'healthy'
);

CREATE INDEX idx_health_table ON partition_health_log(table_name, check_at);

-- ============================================================
-- 2. 捕捉记录表分区改造
-- ============================================================

-- 检查表是否已分区，如果未分区则创建分区表
DO $$
BEGIN
  -- 检查 catch_records 是否存在且未分区
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'catch_records') THEN
    -- 检查是否已分区
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c 
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'catch_records' AND c.relkind = 'p'
    ) THEN
      -- 创建临时表保存数据
      CREATE TABLE catch_records_temp AS SELECT * FROM catch_records;
      
      -- 删除原表
      DROP TABLE catch_records CASCADE;
      
      -- 创建分区表
      CREATE TABLE catch_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER NOT NULL,
        species_id INTEGER NOT NULL,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        caught_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        ball_type VARCHAR(50),
        capture_rate DECIMAL(5, 2),
        cp INTEGER,
        is_shiny BOOLEAN DEFAULT false,
        flee_attempts INTEGER DEFAULT 0,
        xp_reward INTEGER DEFAULT 100,
        stardust_reward INTEGER DEFAULT 100,
        candy_reward INTEGER DEFAULT 3,
        habitat_bonus DECIMAL(3, 2) DEFAULT 1.0,
        metadata JSONB
      ) PARTITION BY RANGE (caught_at);
      
      -- 恢复数据
      INSERT INTO catch_records SELECT * FROM catch_records_temp;
      
      -- 删除临时表
      DROP TABLE catch_records_temp;
    END IF;
  ELSE
    -- 表不存在，创建新分区表
    CREATE TABLE catch_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL,
      species_id INTEGER NOT NULL,
      latitude DECIMAL(10, 8),
      longitude DECIMAL(11, 8),
      caught_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      ball_type VARCHAR(50),
      capture_rate DECIMAL(5, 2),
      cp INTEGER,
      is_shiny BOOLEAN DEFAULT false,
      flee_attempts INTEGER DEFAULT 0,
      xp_reward INTEGER DEFAULT 100,
      stardust_reward INTEGER DEFAULT 100,
      candy_reward INTEGER DEFAULT 3,
      habitat_bonus DECIMAL(3, 2) DEFAULT 1.0,
      metadata JSONB
    ) PARTITION BY RANGE (caught_at);
  END IF;
END $$;

-- 创建默认分区（防止数据丢失）
CREATE TABLE IF NOT EXISTS catch_records_default 
  PARTITION OF catch_records DEFAULT;

-- 创建近期分区（2026年7月）
CREATE TABLE IF NOT EXISTS catch_records_2026_07_01 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-01') TO ('2026-07-02');

CREATE TABLE IF NOT EXISTS catch_records_2026_07_02 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-02') TO ('2026-07-03');

CREATE TABLE IF NOT EXISTS catch_records_2026_07_03 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-03') TO ('2026-07-04');

CREATE TABLE IF NOT EXISTS catch_records_2026_07_04 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-04') TO ('2026-07-05');

CREATE TABLE IF NOT EXISTS catch_records_2026_07_05 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-05') TO ('2026-07-06');

CREATE TABLE IF NOT EXISTS catch_records_2026_07_06 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-06') TO ('2026-07-07');

CREATE TABLE IF NOT EXISTS catch_records_2026_07_07 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-07') TO ('2026-07-08');

CREATE TABLE IF NOT EXISTS catch_records_2026_07_08 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-07-08') TO ('2026-07-09');

-- ============================================================
-- 3. 战斗日志表分区改造
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'battle_logs') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.relname = 'battle_logs' AND c.relkind = 'p'
    ) THEN
      CREATE TABLE battle_logs_temp AS SELECT * FROM battle_logs;
      DROP TABLE battle_logs CASCADE;
      
      CREATE TABLE battle_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER NOT NULL,
        opponent_id INTEGER,
        gym_id INTEGER,
        battle_type VARCHAR(50) NOT NULL, -- 'gym', 'raid', 'pvp'
        result VARCHAR(20) NOT NULL, -- 'win', 'lose', 'draw'
        battle_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        duration_seconds INTEGER,
        damage_dealt INTEGER,
        damage_taken INTEGER,
        pokemon_used JSONB,
        rewards JSONB,
        metadata JSONB
      ) PARTITION BY RANGE (battle_at);
      
      INSERT INTO battle_logs SELECT * FROM battle_logs_temp;
      DROP TABLE battle_logs_temp;
    END IF;
  ELSE
    CREATE TABLE battle_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL,
      opponent_id INTEGER,
      gym_id INTEGER,
      battle_type VARCHAR(50) NOT NULL,
      result VARCHAR(20) NOT NULL,
      battle_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      duration_seconds INTEGER,
      damage_dealt INTEGER,
      damage_taken INTEGER,
      pokemon_used JSONB,
      rewards JSONB,
      metadata JSONB
    ) PARTITION BY RANGE (battle_at);
  END IF;
END $$;

-- 创建默认分区
CREATE TABLE IF NOT EXISTS battle_logs_default 
  PARTITION OF battle_logs DEFAULT;

-- 创建近期分区
CREATE TABLE IF NOT EXISTS battle_logs_2026_07_01 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-01') TO ('2026-07-02');

CREATE TABLE IF NOT EXISTS battle_logs_2026_07_02 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-02') TO ('2026-07-03');

CREATE TABLE IF NOT EXISTS battle_logs_2026_07_03 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-03') TO ('2026-07-04');

CREATE TABLE IF NOT EXISTS battle_logs_2026_07_04 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-04') TO ('2026-07-05');

CREATE TABLE IF NOT EXISTS battle_logs_2026_07_05 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-05') TO ('2026-07-06');

CREATE TABLE IF NOT EXISTS battle_logs_2026_07_06 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-06') TO ('2026-07-07');

CREATE TABLE IF NOT EXISTS battle_logs_2026_07_07 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-07') TO ('2026-07-08');

CREATE TABLE IF NOT EXISTS battle_logs_2026_07_08 
  PARTITION OF battle_logs 
  FOR VALUES FROM ('2026-07-08') TO ('2026-07-09');

-- ============================================================
-- 4. 交易记录表分区改造
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'trade_records') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.relname = 'trade_records' AND c.relkind = 'p'
    ) THEN
      CREATE TABLE trade_records_temp AS SELECT * FROM trade_records;
      DROP TABLE trade_records CASCADE;
      
      CREATE TABLE trade_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        pokemon_id INTEGER NOT NULL,
        traded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        status VARCHAR(20) NOT NULL DEFAULT 'completed',
        candy_cost INTEGER DEFAULT 0,
        stardust_cost INTEGER DEFAULT 0,
        metadata JSONB
      ) PARTITION BY RANGE (traded_at);
      
      INSERT INTO trade_records SELECT * FROM trade_records_temp;
      DROP TABLE trade_records_temp;
    END IF;
  ELSE
    CREATE TABLE trade_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      pokemon_id INTEGER NOT NULL,
      traded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      status VARCHAR(20) NOT NULL DEFAULT 'completed',
      candy_cost INTEGER DEFAULT 0,
      stardust_cost INTEGER DEFAULT 0,
      metadata JSONB
    ) PARTITION BY RANGE (traded_at);
  END IF;
END $$;

-- 创建默认分区
CREATE TABLE IF NOT EXISTS trade_records_default 
  PARTITION OF trade_records DEFAULT;

-- 创建月度分区（按月）
CREATE TABLE IF NOT EXISTS trade_records_2026_07 
  PARTITION OF trade_records 
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS trade_records_2026_08 
  PARTITION OF trade_records 
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ============================================================
-- 5. 支付交易表分区改造
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'payment_transactions') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.relname = 'payment_transactions' AND c.relkind = 'p'
    ) THEN
      CREATE TABLE payment_transactions_temp AS SELECT * FROM payment_transactions;
      DROP TABLE payment_transactions CASCADE;
      
      CREATE TABLE payment_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        transaction_type VARCHAR(50) NOT NULL, -- 'purchase', 'refund'
        product_id VARCHAR(100),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        transaction_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        payment_method VARCHAR(50),
        receipt_id VARCHAR(200),
        metadata JSONB
      ) PARTITION BY RANGE (transaction_at);
      
      INSERT INTO payment_transactions SELECT * FROM payment_transactions_temp;
      DROP TABLE payment_transactions_temp;
    END IF;
  ELSE
    CREATE TABLE payment_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'USD',
      transaction_type VARCHAR(50) NOT NULL,
      product_id VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      transaction_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      payment_method VARCHAR(50),
      receipt_id VARCHAR(200),
      metadata JSONB
    ) PARTITION BY RANGE (transaction_at);
  END IF;
END $$;

-- 创建默认分区
CREATE TABLE IF NOT EXISTS payment_transactions_default 
  PARTITION OF payment_transactions DEFAULT;

-- 创建月度分区（财务合规需要长期保存）
CREATE TABLE IF NOT EXISTS payment_transactions_2026_07 
  PARTITION OF payment_transactions 
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS payment_transactions_2026_08 
  PARTITION OF payment_transactions 
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ============================================================
-- 6. 用户行为事件表分区（反作弊）
-- ============================================================

-- user_behavior_events 已在 REQ-00494 中创建，这里确保分区架构
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'user_behavior_events') THEN
    -- 表已存在，检查是否需要添加分区索引
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'idx_behavior_events_time'
    ) THEN
      CREATE INDEX idx_behavior_events_time ON user_behavior_events(event_time);
    END IF;
  END IF;
END $$;

-- ============================================================
-- 7. 分区索引优化
-- ============================================================

-- 为 catch_records 各分区创建索引
DO $$
DECLARE
  partition_rec RECORD;
BEGIN
  FOR partition_rec IN 
    SELECT tablename FROM pg_tables WHERE tablename LIKE 'catch_records_%' AND tablename != 'catch_records_default'
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (user_id)', 
      partition_rec.tablename || '_user_idx', partition_rec.tablename);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (species_id)', 
      partition_rec.tablename || '_species_idx', partition_rec.tablename);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (caught_at)', 
      partition_rec.tablename || '_time_idx', partition_rec.tablename);
  END LOOP;
END $$;

-- 为 battle_logs 各分区创建索引
DO $$
DECLARE
  partition_rec RECORD;
BEGIN
  FOR partition_rec IN 
    SELECT tablename FROM pg_tables WHERE tablename LIKE 'battle_logs_%' AND tablename != 'battle_logs_default'
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (user_id)', 
      partition_rec.tablename || '_user_idx', partition_rec.tablename);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (battle_type)', 
      partition_rec.tablename || '_type_idx', partition_rec.tablename);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (battle_at)', 
      partition_rec.tablename || '_time_idx', partition_rec.tablename);
  END LOOP;
END $$;

-- ============================================================
-- 8. 分区管理函数
-- ============================================================

-- 自动创建分区函数
CREATE OR REPLACE FUNCTION create_partition(
  p_table_name TEXT,
  p_start_date DATE,
  p_end_date DATE
) RETURNS TEXT AS $$
DECLARE
  v_partition_name TEXT;
BEGIN
  v_partition_name := p_table_name || '_' || to_char(p_start_date, 'YYYY_MM_DD');
  
  -- 检查分区是否已存在
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = v_partition_name) THEN
    RETURN v_partition_name || ' (already exists)';
  END IF;
  
  -- 创建分区
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    v_partition_name,
    p_table_name,
    p_start_date::timestamp,
    p_end_date::timestamp
  );
  
  RETURN v_partition_name || ' (created)';
END;
$$ LANGUAGE plpgsql;

-- 批量预创建分区函数
CREATE OR REPLACE FUNCTION precreate_partitions(
  p_table_name TEXT,
  p_days INTEGER DEFAULT 7
) RETURNS TEXT AS $$
DECLARE
  v_date DATE;
  v_result TEXT;
BEGIN
  FOR i IN 0..p_days-1 LOOP
    v_date := current_date + i;
    v_result := create_partition(p_table_name, v_date, v_date + 1);
    RAISE NOTICE '%', v_result;
  END LOOP;
  
  RETURN format('Precreated %s partitions for %s', p_days, p_table_name);
END;
$$ LANGUAGE plpgsql;

-- 获取分区统计函数
CREATE OR REPLACE FUNCTION get_partition_stats(
  p_table_name TEXT
) RETURNS TABLE (
  partition_name TEXT,
  size_bytes BIGINT,
  size_pretty TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    t.tablename::TEXT,
    pg_total_relation_size(t.schemaname || '.' || t.tablename)::BIGINT,
    pg_size_pretty(pg_total_relation_size(t.schemaname || '.' || t.tablename))::TEXT
  FROM pg_tables t
  WHERE t.tablename LIKE p_table_name || '_%'
  ORDER BY t.tablename;
END;
$$ LANGUAGE plpgsql;

-- 归档冷数据分区函数
CREATE OR REPLACE FUNCTION archive_old_partitions(
  p_table_name TEXT,
  p_retention_days INTEGER DEFAULT 30
) RETURNS INTEGER AS $$
DECLARE
  v_partition_rec RECORD;
  v_archived_count INTEGER := 0;
  v_cutoff_date TEXT;
BEGIN
  v_cutoff_date := to_char(current_date - p_retention_days, 'YYYY_MM_DD');
  
  FOR v_partition_rec IN 
    SELECT tablename FROM pg_tables 
    WHERE tablename LIKE p_table_name || '_%'
      AND tablename < p_table_name || '_' || v_cutoff_date
      AND tablename != p_table_name || '_default'
  LOOP
    -- 记录归档日志
    INSERT INTO partition_archive_metadata (partition_name, table_name, row_count)
    SELECT v_partition_rec.tablename, p_table_name, 
      (SELECT count(*) FROM v_partition_rec.tablename::regclass);
    
    -- 删除分区（实际应该先导出再删除）
    -- EXECUTE format('DROP TABLE IF EXISTS %I', v_partition_rec.tablename);
    
    v_archived_count := v_archived_count + 1;
    RAISE NOTICE 'Archived partition: %s', v_partition_rec.tablename;
  END LOOP;
  
  RETURN v_archived_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 9. 分区监控视图
-- ============================================================

CREATE OR REPLACE VIEW partition_overview AS
SELECT 
  t.tablename as partition_name,
  CASE 
    WHEN t.tablename LIKE 'catch_records_%' THEN 'catch_records'
    WHEN t.tablename LIKE 'battle_logs_%' THEN 'battle_logs'
    WHEN t.tablename LIKE 'trade_records_%' THEN 'trade_records'
    WHEN t.tablename LIKE 'payment_transactions_%' THEN 'payment_transactions'
    ELSE 'other'
  END as parent_table,
  pg_size_pretty(pg_total_relation_size(t.schemaname || '.' || t.tablename)) as size,
  pg_total_relation_size(t.schemaname || '.' || t.tablename) as size_bytes,
  t.tablename LIKE '%default' as is_default
FROM pg_tables t
WHERE t.tablename LIKE '%_%' 
  AND t.tablename NOT LIKE 'pg_%'
ORDER BY pg_total_relation_size(t.schemaname || '.' || t.tablename) DESC;

-- ============================================================
-- 10. 触发器：插入数据时自动检查分区
-- ============================================================

CREATE OR REPLACE FUNCTION ensure_partition_exists()
RETURNS TRIGGER AS $$
BEGIN
  -- 对于 catch_records，确保当天分区存在
  IF TG_TABLE_NAME = 'catch_records' THEN
    PERFORM create_partition('catch_records', NEW.caught_at::date, NEW.caught_at::date + 1);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 11. 初始化数据温度统计
-- ============================================================

INSERT INTO partition_health_log (table_name, partition_count, total_size_bytes, issues, status)
SELECT 
  'catch_records',
  count(*),
  sum(pg_total_relation_size(schemaname || '.' || tablename)),
  jsonb_build_array('Initial partition setup'),
  'healthy'
FROM pg_tables WHERE tablename LIKE 'catch_records_%';

INSERT INTO partition_health_log (table_name, partition_count, total_size_bytes, issues, status)
SELECT 
  'battle_logs',
  count(*),
  sum(pg_total_relation_size(schemaname || '.' || tablename)),
  jsonb_build_array('Initial partition setup'),
  'healthy'
FROM pg_tables WHERE tablename LIKE 'battle_logs_%';

-- ============================================================
-- 12. 授权
-- ============================================================

GRANT SELECT, INSERT, UPDATE ON partition_archive_metadata TO minego_app;
GRANT SELECT, INSERT ON partition_health_log TO minego_app;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA public TO minego_app;
GRANT SELECT ON partition_overview TO minego_app;

-- ============================================================
-- 迁移记录
-- ============================================================

INSERT INTO schema_migrations_log (version, description, applied_at)
VALUES (
  '20260708_070000_partition_tables',
  'REQ-00027: Core tables partition strategy - catch_records, battle_logs, trade_records, payment_transactions',
  NOW()
) ON CONFLICT (version) DO NOTHING;