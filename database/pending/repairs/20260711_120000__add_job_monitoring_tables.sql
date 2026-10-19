-- REQ-00669 (legacy REQ-00538): canonical durable job history.
-- Raw proposal stays immutable; preserve compatible identities/data and refuse unknown contracts.


CREATE TABLE IF NOT EXISTS job_execution_logs (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  job_name VARCHAR(200),
  category VARCHAR(50),
  status VARCHAR(20) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  duration_ms INTEGER,
  error_message TEXT,
  error_stack TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_alert_history (
  id SERIAL PRIMARY KEY,
  alert_id VARCHAR(100) UNIQUE NOT NULL,
  job_id VARCHAR(100) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  channels JSONB,
  metadata JSONB,
  sent_at TIMESTAMP NOT NULL,
  acknowledged_at TIMESTAMP,
  acknowledged_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_health_snapshots (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  health_score INTEGER NOT NULL,
  grade CHAR(1) NOT NULL,
  success_rate NUMERIC(5, 2),
  avg_duration_ms INTEGER,
  run_count INTEGER,
  failure_count INTEGER,
  factors JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_suppression_log (
  id SERIAL PRIMARY KEY,
  alert_key VARCHAR(200) NOT NULL,
  original_alert_id VARCHAR(100),
  suppressed_at TIMESTAMP NOT NULL,
  suppression_window_ms INTEGER,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

DO $table_contract$
DECLARE actual_columns jsonb; expected_columns jsonb; actual_constraints text[]; expected_constraints text[]; sequence_name text;
BEGIN
  IF to_regclass('pg_temp.minego_expected_job_execution_logs') IS NOT NULL THEN RAISE EXCEPTION 'Job contract probe already exists'; END IF;
  EXECUTE 'CREATE TEMP TABLE minego_expected_job_execution_logs (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  job_name VARCHAR(200),
  category VARCHAR(50),
  status VARCHAR(20) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  duration_ms INTEGER,
  error_message TEXT,
  error_stack TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);';
  sequence_name:=pg_get_serial_sequence(format('%I.job_execution_logs',current_schema()),'id');
  IF sequence_name IS NULL OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE objid=sequence_name::regclass AND refobjid='job_execution_logs'::regclass AND deptype='a') THEN RAISE EXCEPTION 'Job serial identity requires explicit adoption: job_execution_logs'; END IF;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' AND pg_get_expr(d.adbin,d.adrelid)=format('nextval(%L::regclass)',sequence_name::regclass::text) THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO actual_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='job_execution_logs'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO expected_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='pg_temp.minego_expected_job_execution_logs'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO actual_constraints FROM pg_constraint WHERE conrelid='job_execution_logs'::regclass;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO expected_constraints FROM pg_constraint WHERE conrelid='pg_temp.minego_expected_job_execution_logs'::regclass;
  IF actual_columns IS DISTINCT FROM expected_columns OR actual_constraints IS DISTINCT FROM expected_constraints THEN RAISE EXCEPTION 'Customized job history contract requires explicit adoption: job_execution_logs'; END IF;
  DROP TABLE pg_temp.minego_expected_job_execution_logs;
END
$table_contract$;

DO $table_contract$
DECLARE actual_columns jsonb; expected_columns jsonb; actual_constraints text[]; expected_constraints text[]; sequence_name text;
BEGIN
  IF to_regclass('pg_temp.minego_expected_job_alert_history') IS NOT NULL THEN RAISE EXCEPTION 'Job contract probe already exists'; END IF;
  EXECUTE 'CREATE TEMP TABLE minego_expected_job_alert_history (
  id SERIAL PRIMARY KEY,
  alert_id VARCHAR(100) UNIQUE NOT NULL,
  job_id VARCHAR(100) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  channels JSONB,
  metadata JSONB,
  sent_at TIMESTAMP NOT NULL,
  acknowledged_at TIMESTAMP,
  acknowledged_by UUID,
  created_at TIMESTAMP DEFAULT NOW()
);';
  sequence_name:=pg_get_serial_sequence(format('%I.job_alert_history',current_schema()),'id');
  IF sequence_name IS NULL OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE objid=sequence_name::regclass AND refobjid='job_alert_history'::regclass AND deptype='a') THEN RAISE EXCEPTION 'Job serial identity requires explicit adoption: job_alert_history'; END IF;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' AND pg_get_expr(d.adbin,d.adrelid)=format('nextval(%L::regclass)',sequence_name::regclass::text) THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO actual_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='job_alert_history'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO expected_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='pg_temp.minego_expected_job_alert_history'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO actual_constraints FROM pg_constraint WHERE conrelid='job_alert_history'::regclass AND contype<>'f';
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO expected_constraints FROM pg_constraint WHERE conrelid='pg_temp.minego_expected_job_alert_history'::regclass;
  IF actual_columns IS DISTINCT FROM expected_columns OR actual_constraints IS DISTINCT FROM expected_constraints THEN RAISE EXCEPTION 'Customized job history contract requires explicit adoption: job_alert_history'; END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='job_alert_history'::regclass AND contype='f')<>1 OR NOT EXISTS(
    SELECT 1 FROM pg_constraint c JOIN pg_attribute owner ON owner.attrelid=c.conrelid AND owner.attname='acknowledged_by'
    JOIN pg_attribute subject ON subject.attrelid=c.confrelid AND subject.attname='id'
    WHERE c.conrelid='job_alert_history'::regclass AND c.contype='f' AND c.confrelid='users'::regclass
    AND c.conkey=ARRAY[owner.attnum] AND c.confkey=ARRAY[subject.attnum] AND c.convalidated AND NOT c.condeferrable
    AND c.confdeltype='a' AND c.confupdtype='a' AND c.confmatchtype='s'
  ) THEN RAISE EXCEPTION 'Customized job history contract requires explicit adoption: acknowledged_by'; END IF;
  DROP TABLE pg_temp.minego_expected_job_alert_history;
END
$table_contract$;

DO $table_contract$
DECLARE actual_columns jsonb; expected_columns jsonb; actual_constraints text[]; expected_constraints text[]; sequence_name text;
BEGIN
  IF to_regclass('pg_temp.minego_expected_job_health_snapshots') IS NOT NULL THEN RAISE EXCEPTION 'Job contract probe already exists'; END IF;
  EXECUTE 'CREATE TEMP TABLE minego_expected_job_health_snapshots (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  health_score INTEGER NOT NULL,
  grade CHAR(1) NOT NULL,
  success_rate NUMERIC(5, 2),
  avg_duration_ms INTEGER,
  run_count INTEGER,
  failure_count INTEGER,
  factors JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);';
  sequence_name:=pg_get_serial_sequence(format('%I.job_health_snapshots',current_schema()),'id');
  IF sequence_name IS NULL OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE objid=sequence_name::regclass AND refobjid='job_health_snapshots'::regclass AND deptype='a') THEN RAISE EXCEPTION 'Job serial identity requires explicit adoption: job_health_snapshots'; END IF;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' AND pg_get_expr(d.adbin,d.adrelid)=format('nextval(%L::regclass)',sequence_name::regclass::text) THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO actual_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='job_health_snapshots'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO expected_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='pg_temp.minego_expected_job_health_snapshots'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO actual_constraints FROM pg_constraint WHERE conrelid='job_health_snapshots'::regclass;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO expected_constraints FROM pg_constraint WHERE conrelid='pg_temp.minego_expected_job_health_snapshots'::regclass;
  IF actual_columns IS DISTINCT FROM expected_columns OR actual_constraints IS DISTINCT FROM expected_constraints THEN RAISE EXCEPTION 'Customized job history contract requires explicit adoption: job_health_snapshots'; END IF;
  DROP TABLE pg_temp.minego_expected_job_health_snapshots;
END
$table_contract$;

DO $table_contract$
DECLARE actual_columns jsonb; expected_columns jsonb; actual_constraints text[]; expected_constraints text[]; sequence_name text;
BEGIN
  IF to_regclass('pg_temp.minego_expected_alert_suppression_log') IS NOT NULL THEN RAISE EXCEPTION 'Job contract probe already exists'; END IF;
  EXECUTE 'CREATE TEMP TABLE minego_expected_alert_suppression_log (
  id SERIAL PRIMARY KEY,
  alert_key VARCHAR(200) NOT NULL,
  original_alert_id VARCHAR(100),
  suppressed_at TIMESTAMP NOT NULL,
  suppression_window_ms INTEGER,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);';
  sequence_name:=pg_get_serial_sequence(format('%I.alert_suppression_log',current_schema()),'id');
  IF sequence_name IS NULL OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE objid=sequence_name::regclass AND refobjid='alert_suppression_log'::regclass AND deptype='a') THEN RAISE EXCEPTION 'Job serial identity requires explicit adoption: alert_suppression_log'; END IF;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' AND pg_get_expr(d.adbin,d.adrelid)=format('nextval(%L::regclass)',sequence_name::regclass::text) THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO actual_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='alert_suppression_log'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,CASE WHEN a.attname='id' THEN '<owned serial>' ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attname) INTO expected_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='pg_temp.minego_expected_alert_suppression_log'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO actual_constraints FROM pg_constraint WHERE conrelid='alert_suppression_log'::regclass;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO expected_constraints FROM pg_constraint WHERE conrelid='pg_temp.minego_expected_alert_suppression_log'::regclass;
  IF actual_columns IS DISTINCT FROM expected_columns OR actual_constraints IS DISTINCT FROM expected_constraints THEN RAISE EXCEPTION 'Customized job history contract requires explicit adoption: alert_suppression_log'; END IF;
  DROP TABLE pg_temp.minego_expected_alert_suppression_log;
END
$table_contract$;

DO $index_contract$
DECLARE expected record; identity oid; definition record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES ('idx_job_logs_job_id','job_execution_logs','job_id',0),
    ('idx_job_logs_status','job_execution_logs','status',0),
    ('idx_job_logs_start_time','job_execution_logs','start_time',3),
    ('idx_job_logs_category','job_execution_logs','category',0),
    ('idx_job_logs_created_at','job_execution_logs','created_at',3),
    ('idx_alert_history_job_id','job_alert_history','job_id',0),
    ('idx_alert_history_severity','job_alert_history','severity',0),
    ('idx_alert_history_sent_at','job_alert_history','sent_at',3),
    ('idx_health_snapshots_job_id','job_health_snapshots','job_id',0),
    ('idx_health_snapshots_created_at','job_health_snapshots','created_at',3),
    ('idx_suppression_alert_key','alert_suppression_log','alert_key',0)) AS indexes(name,parent,column_name,sort_options) LOOP
    identity:=to_regclass(format('%I.%I',current_schema(),expected.name));
    IF identity IS NOT NULL THEN
      SELECT i.*,c.relam,a.attname,a.attcollation,am.amname,op.opcdefault INTO definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0] JOIN pg_opclass op ON op.oid=i.indclass[0] WHERE i.indexrelid=identity;
      IF NOT FOUND OR definition.indrelid<>to_regclass(format('%I.%I',current_schema(),expected.parent)) OR definition.attname<>expected.column_name OR definition.indnatts<>1 OR definition.indnkeyatts<>1 OR definition.indisunique OR NOT definition.indisvalid OR NOT definition.indisready OR definition.indpred IS NOT NULL OR definition.indexprs IS NOT NULL OR definition.indoption[0]<>expected.sort_options OR definition.amname<>'btree' OR NOT definition.opcdefault OR definition.indcollation[0]<>definition.attcollation THEN RAISE EXCEPTION 'Customized job index requires explicit adoption: %',expected.name; END IF;
    ELSE
      EXECUTE format('CREATE INDEX %I ON %I.%I(%I%s)',expected.name,current_schema(),expected.parent,expected.column_name,CASE WHEN expected.sort_options=3 THEN ' DESC' ELSE '' END);
    END IF;
  END LOOP;
END
$index_contract$;

DO $view_contract$
DECLARE previous oid; actual_columns jsonb; expected_columns jsonb; expected_definition text;
BEGIN
  IF to_regclass('pg_temp.minego_expected_job_daily_statistics') IS NOT NULL THEN RAISE EXCEPTION 'Job view probe already exists'; END IF;
  EXECUTE 'CREATE TEMP VIEW minego_expected_job_daily_statistics AS
SELECT
  job_id,
  job_name,
  category,
  DATE(start_time) as stat_date,
  COUNT(*) as total_runs,
  COUNT(*) FILTER (WHERE status = ''success'') as success_count,
  COUNT(*) FILTER (WHERE status = ''failed'') as failure_count,
  COUNT(*) FILTER (WHERE status = ''timeout'') as timeout_count,
  AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration_ms,
  MIN(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as min_duration_ms,
  MAX(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as max_duration_ms,
  ROUND(
    COUNT(*) FILTER (WHERE status = ''success'')::numeric / NULLIF(COUNT(*), 0) * 100,
    2
  ) as success_rate
FROM job_execution_logs
GROUP BY job_id, job_name, category, DATE(start_time)';
  previous:=to_regclass(format('%I.job_daily_statistics',current_schema()));
  IF previous IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod)) ORDER BY attnum) INTO actual_columns FROM pg_attribute WHERE attrelid=previous AND attnum>0 AND NOT attisdropped;
    SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod)) ORDER BY attnum) INTO expected_columns FROM pg_attribute WHERE attrelid='pg_temp.minego_expected_job_daily_statistics'::regclass AND attnum>0 AND NOT attisdropped;
    expected_definition:=pg_get_viewdef('pg_temp.minego_expected_job_daily_statistics'::regclass,true);
    IF (SELECT relkind FROM pg_class WHERE oid=previous)<>'v' OR actual_columns IS DISTINCT FROM expected_columns OR pg_get_viewdef(previous,true) IS DISTINCT FROM expected_definition THEN RAISE EXCEPTION 'Customized job statistics view requires explicit adoption'; END IF;
  ELSE
    EXECUTE 'CREATE VIEW job_daily_statistics AS
SELECT
  job_id,
  job_name,
  category,
  DATE(start_time) as stat_date,
  COUNT(*) as total_runs,
  COUNT(*) FILTER (WHERE status = ''success'') as success_count,
  COUNT(*) FILTER (WHERE status = ''failed'') as failure_count,
  COUNT(*) FILTER (WHERE status = ''timeout'') as timeout_count,
  AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration_ms,
  MIN(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as min_duration_ms,
  MAX(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as max_duration_ms,
  ROUND(
    COUNT(*) FILTER (WHERE status = ''success'')::numeric / NULLIF(COUNT(*), 0) * 100,
    2
  ) as success_rate
FROM job_execution_logs
GROUP BY job_id, job_name, category, DATE(start_time)';
  END IF;
  DROP VIEW pg_temp.minego_expected_job_daily_statistics;
END
$view_contract$;

DO $comment$ BEGIN IF obj_description('job_execution_logs'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON TABLE job_execution_logs IS ''任务执行日志记录表'''; END IF; END $comment$;

DO $comment$ BEGIN IF obj_description('job_alert_history'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON TABLE job_alert_history IS ''告警历史记录表'''; END IF; END $comment$;

DO $comment$ BEGIN IF obj_description('job_health_snapshots'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON TABLE job_health_snapshots IS ''任务健康评分快照表'''; END IF; END $comment$;

DO $comment$ BEGIN IF obj_description('alert_suppression_log'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON TABLE alert_suppression_log IS ''告警噪音抑制日志表'''; END IF; END $comment$;

DO $comment$ BEGIN IF obj_description('job_daily_statistics'::regclass,'pg_class') IS NULL THEN EXECUTE 'COMMENT ON VIEW job_daily_statistics IS ''任务每日统计视图'''; END IF; END $comment$;
