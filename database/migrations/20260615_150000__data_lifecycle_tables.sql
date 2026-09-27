-- ============================================================
-- Data Lifecycle Management Tables
-- REQ-00107: 数据生命周期管理与自动清理策略
-- ============================================================

-- 数据保留策略配置表
CREATE TABLE IF NOT EXISTS data_retention_policies (
  id SERIAL PRIMARY KEY,
  category VARCHAR(32) UNIQUE NOT NULL,
  category_name VARCHAR(64) NOT NULL,
  retention_days INTEGER,
  cleanup_policy VARCHAR(32) NOT NULL, -- 'hard_delete', 'soft_delete', 'archive_then_delete', 'user_initiated'
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE data_retention_policies ADD COLUMN IF NOT EXISTS category VARCHAR(32);
ALTER TABLE data_retention_policies ADD COLUMN IF NOT EXISTS category_name VARCHAR(64);
ALTER TABLE data_retention_policies ADD COLUMN IF NOT EXISTS retention_days INTEGER;
ALTER TABLE data_retention_policies ADD COLUMN IF NOT EXISTS cleanup_policy VARCHAR(32);
ALTER TABLE data_retention_policies ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;
ALTER TABLE data_retention_policies ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE data_retention_policies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.data_retention_policies') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('category', 'category_name', 'retention_days', 'cleanup_policy', 'enabled', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE data_retention_policies ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;
-- 旧版表（20260605_161000__add_gdpr_tables.sql）以 table_name 为主键；本版按 category 维护，需要唯一索引且放开 table_name 非空
CREATE UNIQUE INDEX IF NOT EXISTS uq_data_retention_policies_category ON data_retention_policies(category);
DO $drp$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'data_retention_policies' AND column_name = 'table_name') THEN
    ALTER TABLE data_retention_policies DROP CONSTRAINT IF EXISTS data_retention_policies_pkey;
    ALTER TABLE data_retention_policies ALTER COLUMN table_name DROP NOT NULL;
  END IF;
END $drp$;

-- 插入默认策略
INSERT INTO data_retention_policies (category, category_name, retention_days, cleanup_policy) VALUES
('TEMPORARY', '临时数据', 7, 'hard_delete'),
('OPERATION_LOGS', '操作日志', 90, 'hard_delete'),
('TRANSACTION_RECORDS', '交易记录', 1095, 'archive_then_delete'),
('USER_DATA', '用户数据', NULL, 'user_initiated'),
('HISTORICAL_DATA', '历史数据', 365, 'archive_then_delete')
ON CONFLICT (category) DO NOTHING;

-- 用户数据删除请求表
CREATE TABLE IF NOT EXISTS user_data_deletion_requests (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  request_type VARCHAR(16) NOT NULL, -- 'immediate', 'scheduled'
  requested_at TIMESTAMP NOT NULL,
  scheduled_deletion_at TIMESTAMP,
  status VARCHAR(16) NOT NULL, -- 'pending', 'processing', 'completed', 'cancelled'
  completed_at TIMESTAMP,
  performed_by VARCHAR(64),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS request_type VARCHAR(16);
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS requested_at TIMESTAMP;
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMP;
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS status VARCHAR(16);
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS performed_by VARCHAR(64);
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE user_data_deletion_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.user_data_deletion_requests') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'request_type', 'requested_at', 'scheduled_deletion_at', 'status', 'completed_at', 'performed_by', 'notes', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE user_data_deletion_requests ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_user_deletion_requests_user ON user_data_deletion_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_user_deletion_requests_status ON user_data_deletion_requests(status);
CREATE INDEX IF NOT EXISTS idx_user_deletion_requests_scheduled ON user_data_deletion_requests(scheduled_deletion_at) WHERE status = 'pending';

-- 数据清理审计日志表
CREATE TABLE IF NOT EXISTS data_cleanup_audit_logs (
  id SERIAL PRIMARY KEY,
  operation_type VARCHAR(32) NOT NULL, -- 'soft_delete', 'hard_delete', 'archive', 'restore', 'user_data_deletion'
  category VARCHAR(32) NOT NULL,
  table_name VARCHAR(128) NOT NULL,
  record_count INTEGER NOT NULL,
  reason TEXT,
  performed_by VARCHAR(64), -- 'system', 'user_id', 'admin_id'
  retention_days INTEGER,
  criteria JSONB, -- 清理条件
  execution_time_ms INTEGER,
  status VARCHAR(16) NOT NULL, -- 'success', 'failed', 'partial'
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS operation_type VARCHAR(32);
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS category VARCHAR(32);
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS table_name VARCHAR(128);
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS record_count INTEGER;
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS performed_by VARCHAR(64);
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS retention_days INTEGER;
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS criteria JSONB;
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER;
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS status VARCHAR(16);
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE data_cleanup_audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.data_cleanup_audit_logs') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('operation_type', 'category', 'table_name', 'record_count', 'reason', 'performed_by', 'retention_days', 'criteria', 'execution_time_ms', 'status', 'error_message', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE data_cleanup_audit_logs ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_cleanup_audit_logs_operation ON data_cleanup_audit_logs(operation_type, created_at);
CREATE INDEX IF NOT EXISTS idx_cleanup_audit_logs_category ON data_cleanup_audit_logs(category, created_at);
CREATE INDEX IF NOT EXISTS idx_cleanup_audit_logs_status ON data_cleanup_audit_logs(status, created_at);

-- 数据归档表
CREATE TABLE IF NOT EXISTS data_archives (
  id SERIAL PRIMARY KEY,
  archive_id VARCHAR(64) UNIQUE NOT NULL,
  category VARCHAR(32) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  record_count INTEGER NOT NULL,
  storage_path VARCHAR(512) NOT NULL,
  storage_type VARCHAR(32) NOT NULL, -- 'oss', 's3', 'local'
  compressed BOOLEAN DEFAULT true,
  file_size_bytes BIGINT,
  archived_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP, -- 归档数据保留期限
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS archive_id VARCHAR(64);
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS category VARCHAR(32);
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS table_name VARCHAR(64);
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS record_count INTEGER;
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS storage_path VARCHAR(512);
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS storage_type VARCHAR(32);
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS compressed BOOLEAN DEFAULT true;
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE data_archives ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.data_archives') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('archive_id', 'category', 'table_name', 'record_count', 'storage_path', 'storage_type', 'compressed', 'file_size_bytes', 'archived_at', 'expires_at', 'metadata', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE data_archives ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_data_archives_category ON data_archives(category);
CREATE INDEX IF NOT EXISTS idx_data_archives_archived_at ON data_archives(archived_at);
CREATE INDEX IF NOT EXISTS idx_data_archives_expires ON data_archives(expires_at) WHERE expires_at IS NOT NULL;

-- 为现有表添加删除标记字段（如果不存在）
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_reason VARCHAR(128);

-- 添加注释
COMMENT ON TABLE data_retention_policies IS '数据保留策略配置';
COMMENT ON TABLE user_data_deletion_requests IS '用户数据删除请求';
COMMENT ON TABLE data_cleanup_audit_logs IS '数据清理审计日志';
COMMENT ON TABLE data_archives IS '数据归档记录';

COMMENT ON COLUMN data_retention_policies.category IS '数据类别：TEMPORARY/OPERATION_LOGS/TRANSACTION_RECORDS/USER_DATA/HISTORICAL_DATA';
COMMENT ON COLUMN data_retention_policies.cleanup_policy IS '清理策略：hard_delete/soft_delete/archive_then_delete/user_initiated';
COMMENT ON COLUMN data_cleanup_audit_logs.operation_type IS '操作类型：soft_delete/hard_delete/archive/restore/user_data_deletion';
