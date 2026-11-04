-- REQ-00038: preserve actual audit/encrypted history and isolate installation.
DO $scope$
BEGIN
  IF to_regclass('pg_temp.minego_sensitive_migration_scope') IS NOT NULL THEN RAISE EXCEPTION 'Sensitive migration scope is already owned'; END IF;
  CREATE TEMP TABLE minego_sensitive_migration_scope(path text NOT NULL);
  INSERT INTO pg_temp.minego_sensitive_migration_scope VALUES(current_setting('search_path'));
  PERFORM set_config('search_path',format('%I,pg_catalog',current_schema()),true);
END
$scope$;

-- REQ-00038: 敏感数据访问审计表
-- 创建时间: 2026-06-08 20:00
-- 描述: 支持敏感数据访问日志记录、加密密钥管理

-- ============================================================
-- 1. 扩展现有 audit_logs 表（如果不存在则创建）
-- ============================================================

-- 检查 audit_logs 表是否存在，不存在则创建
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  action VARCHAR(100) NOT NULL,
  action_data JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 添加加密相关字段（如果不存在）
DO $$
BEGIN
  -- encrypted_data 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'audit_logs' AND column_name = 'encrypted_data'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encrypted_data BYTEA;
  END IF;

  -- encryption_key_id 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'audit_logs' AND column_name = 'encryption_key_id'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encryption_key_id VARCHAR(64);
  END IF;

  -- encryption_iv 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'audit_logs' AND column_name = 'encryption_iv'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encryption_iv VARCHAR(64);
  END IF;

  -- encryption_auth_tag 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'audit_logs' AND column_name = 'encryption_auth_tag'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN encryption_auth_tag VARCHAR(64);
  END IF;
END $$;

DO $timestamp_contract$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname='timestamp' AND NOT attisdropped) THEN
    ALTER TABLE audit_logs ADD COLUMN timestamp TIMESTAMPTZ;
    IF (SELECT atttypid FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname='created_at' AND NOT attisdropped)='timestamptz'::regtype THEN
      UPDATE audit_logs SET timestamp=created_at;
    END IF;
    ALTER TABLE audit_logs ALTER COLUMN timestamp SET DEFAULT NOW();
  END IF;
END
$timestamp_contract$;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action_data JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);

DO $column_contract$
DECLARE field record;
BEGIN
  FOR field IN SELECT * FROM (VALUES('encrypted_data','bytea'),('encryption_key_id','character varying(64)'),('encryption_iv','character varying(64)'),('encryption_auth_tag','character varying(64)'),('timestamp','timestamp with time zone')) AS fields(name,type) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.audit_logs',current_schema())) AND attname=field.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=field.type) THEN RAISE EXCEPTION 'Sensitive audit column requires explicit adoption: %',field.name; END IF;
  END LOOP;
END
$column_contract$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

DO $comment$ BEGIN IF col_description('audit_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname='encrypted_data')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN audit_logs.encrypted_data IS ''加密后的操作数据（AES-256-GCM）'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('audit_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname='encryption_key_id')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN audit_logs.encryption_key_id IS ''加密密钥 ID'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('audit_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname='encryption_iv')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN audit_logs.encryption_iv IS ''加密初始化向量（16字节 hex）'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('audit_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname='encryption_auth_tag')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN audit_logs.encryption_auth_tag IS ''GCM 认证标签（16字节 hex）'';'; END IF; END $comment$;

-- ============================================================
-- 2. 敏感数据访问日志表
-- ============================================================

CREATE TABLE IF NOT EXISTS sensitive_data_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  accessed_by UUID NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  accessed_fields TEXT[] NOT NULL,
  access_reason VARCHAR(100),
  encrypted_ip_address BYTEA,
  encryption_key_id VARCHAR(64),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  retention_days INTEGER DEFAULT 90,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_sensitive_access_user ON sensitive_data_access_logs(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_resource ON sensitive_data_access_logs(resource_type, resource_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_by ON sensitive_data_access_logs(accessed_by, timestamp);

DO $comment$ BEGIN IF obj_description('sensitive_data_access_logs'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON TABLE sensitive_data_access_logs IS ''敏感数据访问审计日志'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='user_id')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.user_id IS ''被访问的用户 ID'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='accessed_by')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.accessed_by IS ''访问者用户 ID'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='resource_type')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.resource_type IS ''资源类型（user, pokemon, payment 等）'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='resource_id')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.resource_id IS ''资源 ID'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='accessed_fields')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.accessed_fields IS ''访问的敏感字段列表'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='access_reason')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.access_reason IS ''访问原因（api_request, admin_view 等）'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='encrypted_ip_address')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.encrypted_ip_address IS ''加密后的 IP 地址'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_data_access_logs'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_data_access_logs'::regclass AND attname='retention_days')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_data_access_logs.retention_days IS ''保留天数（默认 90 天）'';'; END IF; END $comment$;

-- ============================================================
-- 3. 加密密钥管理表
-- ============================================================

CREATE TABLE IF NOT EXISTS encryption_keys (
  id VARCHAR(64) PRIMARY KEY,
  algorithm VARCHAR(50) DEFAULT 'aes-256-gcm',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  encrypted_key BYTEA NOT NULL,
  key_version INTEGER DEFAULT 1,
  created_by UUID,
  description TEXT
);

DO $key_history$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='encryption_keys'::regclass AND attname='key_version' AND NOT attisdropped) THEN
    ALTER TABLE encryption_keys ADD COLUMN key_version INTEGER;
    ALTER TABLE encryption_keys ALTER COLUMN key_version SET DEFAULT 1;
  END IF;
END
$key_history$;
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS description TEXT;

-- 索引
CREATE INDEX IF NOT EXISTS idx_encryption_keys_active ON encryption_keys(is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_created ON encryption_keys(created_at);

DO $comment$ BEGIN IF obj_description('encryption_keys'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON TABLE encryption_keys IS ''加密密钥管理表'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('encryption_keys'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='encryption_keys'::regclass AND attname='id')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN encryption_keys.id IS ''密钥 ID（UUID 或自定义）'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('encryption_keys'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='encryption_keys'::regclass AND attname='encrypted_key')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN encryption_keys.encrypted_key IS ''使用主密钥加密的工作密钥'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('encryption_keys'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='encryption_keys'::regclass AND attname='key_version')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN encryption_keys.key_version IS ''密钥版本号'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('encryption_keys'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='encryption_keys'::regclass AND attname='is_active')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN encryption_keys.is_active IS ''是否激活'';'; END IF; END $comment$;

-- ============================================================
-- 4. 敏感字段定义表
-- ============================================================

CREATE TABLE IF NOT EXISTS sensitive_fields_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_name VARCHAR(100) NOT NULL UNIQUE,
  sensitivity_level VARCHAR(10) NOT NULL CHECK (sensitivity_level IN ('P0', 'P1', 'P2', 'P3')),
  masking_type VARCHAR(50),
  masking_config JSONB,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入默认敏感字段配置
INSERT INTO sensitive_fields_config (field_name, sensitivity_level, masking_type, description) VALUES
('password', 'P0', 'remove', '密码'),
('payment_token', 'P0', 'remove', '支付令牌'),
('card_number', 'P0', 'keep_last4', '银行卡号'),
('cvv', 'P0', 'remove', 'CVV 安全码'),
('email', 'P1', 'keep_prefix', '电子邮箱'),
('phone', 'P1', 'keep_suffix', '手机号'),
('real_name', 'P1', 'keep_first', '真实姓名'),
('address', 'P1', 'remove_detail', '地址'),
('birthday', 'P2', 'keep_year_month', '生日'),
('ip_address', 'P2', 'mask_last_octet', 'IP 地址'),
('device_id', 'P2', 'keep_prefix', '设备 ID'),
('location_history', 'P2', 'fuzzy_location', '位置历史')
ON CONFLICT (field_name) DO NOTHING;

DO $comment$ BEGIN IF obj_description('sensitive_fields_config'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON TABLE sensitive_fields_config IS ''敏感字段配置表'';'; END IF; END $comment$;
DO $comment$ BEGIN IF col_description('sensitive_fields_config'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='sensitive_fields_config'::regclass AND attname='sensitivity_level')) IS NULL THEN EXECUTE 'COMMENT ON COLUMN sensitive_fields_config.sensitivity_level IS ''敏感度级别（P0/P1/P2/P3）'';'; END IF; END $comment$;

-- ============================================================
-- 5. 数据清理触发器（自动清理过期日志）
-- ============================================================

DO $storage_contract$
DECLARE field record;
BEGIN
  FOR field IN SELECT * FROM (VALUES
    ('sensitive_data_access_logs','user_id','uuid'),('sensitive_data_access_logs','accessed_by','uuid'),
    ('sensitive_data_access_logs','resource_id','uuid'),('sensitive_data_access_logs','encrypted_ip_address','bytea'),
    ('sensitive_data_access_logs','encryption_key_id','character varying(64)'),('sensitive_data_access_logs','timestamp','timestamp with time zone'),
    ('sensitive_data_access_logs','retention_days','integer'),('encryption_keys','id','character varying(64)'),
    ('encryption_keys','encrypted_key','bytea'),('encryption_keys','key_version','integer')
  ) AS fields(parent,name,type) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.%I',current_schema(),field.parent)) AND attname=field.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=field.type) THEN RAISE EXCEPTION 'Sensitive storage requires explicit adoption: %.%',field.parent,field.name; END IF;
  END LOOP;
END
$storage_contract$;

-- 创建清理函数
DO $cleanup_contract$
DECLARE identity oid; previous record; body text;
BEGIN
  body:=format('BEGIN
  DELETE FROM %I.sensitive_data_access_logs
  WHERE retention_days>=90 AND timestamp < NOW() - INTERVAL ''1 day'' * retention_days;
  DELETE FROM %I.audit_logs WHERE timestamp < NOW() - INTERVAL ''90 days'';
END;',current_schema(),current_schema());
  identity:=to_regprocedure(format('%I.cleanup_expired_sensitive_logs()',current_schema()));
  IF identity IS NOT NULL THEN
    SELECT p.*,l.lanname INTO previous FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=identity;
    IF previous.prorettype<>'void'::regtype OR previous.proretset OR previous.lanname<>'plpgsql' OR previous.provolatile<>'v' OR NOT(
      (previous.prosrc=E'\nBEGIN\n  DELETE FROM sensitive_data_access_logs\n  WHERE timestamp < NOW() - INTERVAL ''1 day'' * retention_days;\n  \n  DELETE FROM audit_logs\n  WHERE timestamp < NOW() - INTERVAL ''90 days'';\nEND;\n' AND previous.prosecdef AND previous.proconfig IS NULL)
      OR (previous.prosrc=body AND NOT previous.prosecdef AND previous.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog'])
    ) THEN RAISE EXCEPTION 'Customized sensitive-log cleanup requires explicit adoption'; END IF;
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION %I.cleanup_expired_sensitive_logs() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS %L',current_schema(),body);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.cleanup_expired_sensitive_logs() FROM PUBLIC',current_schema());
END
$cleanup_contract$;

DO $older_cleanup_contract$
DECLARE identity oid; previous record; body text;
BEGIN
  identity:=to_regprocedure(format('%I.cleanup_expired_sensitive_access_logs()',current_schema()));
  IF identity IS NOT NULL THEN
    body:=format('BEGIN DELETE FROM %I.sensitive_data_access_logs WHERE retention_days>=90 AND timestamp < NOW() - INTERVAL ''1 day'' * retention_days; END;',current_schema());
    SELECT p.*,l.lanname INTO previous FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=identity;
    IF previous.prorettype<>'void'::regtype OR previous.proretset OR previous.lanname<>'plpgsql' OR previous.provolatile<>'v' OR NOT(
      (previous.prosrc=E'\nBEGIN\n  DELETE FROM sensitive_data_access_logs\n  WHERE timestamp < NOW() - (retention_days || '' days'')::interval;\n  \n  RAISE NOTICE ''Cleaned up expired sensitive access logs'';\nEND;\n' AND previous.prosecdef AND previous.proconfig IS NULL)
      OR (previous.prosrc=body AND NOT previous.prosecdef AND previous.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog'])
    ) THEN RAISE EXCEPTION 'Customized sensitive-access cleanup requires explicit adoption'; END IF;
    EXECUTE format('CREATE OR REPLACE FUNCTION %I.cleanup_expired_sensitive_access_logs() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS %L',current_schema(),body);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.cleanup_expired_sensitive_access_logs() FROM PUBLIC',current_schema());
  END IF;
END
$older_cleanup_contract$;

-- 创建定时任务（需要 pg_cron 扩展，可选）
-- 如果 pg_cron 不可用，可以改用外部定时任务
-- -- -- -- -- -- -- -- -- -- -- -- SELECT cron.schedule('cleanup_sensitive_logs', '0 2 * * *', 'SELECT cleanup_expired_sensitive_logs()');

-- ============================================================
-- 6. 视图：敏感访问统计
-- ============================================================

DO $statistics_contract$
DECLARE previous oid; actual_definition text; expected_definition text;
BEGIN
  IF to_regclass('pg_temp.minego_expected_sensitive_stats') IS NOT NULL THEN RAISE EXCEPTION 'Sensitive statistics probe already exists'; END IF;
  EXECUTE 'CREATE TEMP VIEW minego_expected_sensitive_stats AS
SELECT
  resource_type,
  COUNT(*) as total_access_count,
  COUNT(DISTINCT user_id) as unique_users_count,
  COUNT(DISTINCT accessed_by) as unique_accessors_count,
  DATE_TRUNC(''day'', timestamp) as access_date
FROM sensitive_data_access_logs
WHERE timestamp > NOW() - INTERVAL ''30 days''
GROUP BY resource_type, DATE_TRUNC(''day'', timestamp)
ORDER BY access_date DESC';
  previous:=to_regclass(format('%I.sensitive_access_statistics',current_schema()));
  IF previous IS NULL THEN EXECUTE 'CREATE VIEW sensitive_access_statistics AS
SELECT
  resource_type,
  COUNT(*) as total_access_count,
  COUNT(DISTINCT user_id) as unique_users_count,
  COUNT(DISTINCT accessed_by) as unique_accessors_count,
  DATE_TRUNC(''day'', timestamp) as access_date
FROM sensitive_data_access_logs
WHERE timestamp > NOW() - INTERVAL ''30 days''
GROUP BY resource_type, DATE_TRUNC(''day'', timestamp)
ORDER BY access_date DESC';
  ELSE
    SELECT pg_get_viewdef(previous,true) INTO actual_definition;
    SELECT pg_get_viewdef('pg_temp.minego_expected_sensitive_stats'::regclass,true) INTO expected_definition;
    IF (SELECT relkind FROM pg_class WHERE oid=previous)<>'v' OR actual_definition IS DISTINCT FROM expected_definition THEN RAISE EXCEPTION 'Customized sensitive statistics requires explicit adoption'; END IF;
  END IF;
  DROP VIEW pg_temp.minego_expected_sensitive_stats;
END
$statistics_contract$;

DO $comment$ BEGIN IF obj_description('sensitive_access_statistics'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON VIEW sensitive_access_statistics IS ''敏感数据访问统计视图'';'; END IF; END $comment$;

-- ============================================================
-- 7. 行级安全策略（可选，需要 PostgreSQL 9.5+）
-- ============================================================

-- 启用行级安全（仅限超级管理员查看）
-- ALTER TABLE sensitive_data_access_logs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE encryption_keys ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 完成
-- ============================================================

-- 记录迁移


DO $scope$
BEGIN
  PERFORM set_config('search_path',(SELECT path FROM pg_temp.minego_sensitive_migration_scope),true);
  DROP TABLE pg_temp.minego_sensitive_migration_scope;
END
$scope$;
