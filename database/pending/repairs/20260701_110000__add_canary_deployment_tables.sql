-- REQ-00078: reconcile the repeated proposal with existing SERIAL rollout history.
-- Preserve IDs, existing rows/sequences/views/FKs/operator comments and the earlier index.
DO $identity$
DECLARE expected record; relation_id oid;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('canary_deployments','id','integer'),('canary_deployments','service_name','character varying(100)'),
    ('canary_deployments','status','character varying(20)'),('canary_deployments','traffic_split','integer'),
    ('canary_deployment_history','id','integer'),('canary_deployment_history','deployment_id','integer'),
    ('canary_metrics_snapshots','id','integer'),('canary_metrics_snapshots','deployment_id','integer'),
    ('canary_request_logs','id','integer'),('canary_request_logs','deployment_id','integer')
  ) AS columns(relation,name,type) LOOP
    relation_id:=to_regclass(format('%I.%I',current_schema(),expected.relation));
    IF relation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation_id AND attname=expected.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=expected.type) THEN
      RAISE EXCEPTION 'Canary %.% requires explicit schema adoption',expected.relation,expected.name;
    END IF;
  END LOOP;
END
$identity$;

CREATE TABLE IF NOT EXISTS canary_deployments (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,

    -- 版本信息
    canary_version VARCHAR(100) NOT NULL,
    stable_version VARCHAR(100) NOT NULL,

    -- 流量控制
    traffic_split INTEGER DEFAULT 0 CHECK (traffic_split >= 0 AND traffic_split <= 100),

    -- 策略
    strategy VARCHAR(20) DEFAULT 'progressive' CHECK (strategy IN ('progressive', 'manual', 'auto', 'header', 'cookie', 'user-segment', 'force-canary')),
    rules JSONB DEFAULT '{}',
    auto_promote BOOLEAN DEFAULT true,

    -- 指标基线
    metrics_baseline JSONB DEFAULT '{}',

    -- 状态
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'promoting', 'completed', 'rolled_back', 'cancelled')),

    -- 回滚信息
    rollback_reason TEXT,
    rolled_back_at TIMESTAMP,

    -- 时间戳
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,

    created_by INTEGER
);

-- 金丝雀发布历史表
CREATE TABLE IF NOT EXISTS canary_deployment_history (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 金丝雀指标快照表
CREATE TABLE IF NOT EXISTS canary_metrics_snapshots (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    metrics JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 金丝雀请求日志表（用于指标统计）
CREATE TABLE IF NOT EXISTS canary_request_logs (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    status_code INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_canary_deployments_service ON canary_deployments(service_name, status);
CREATE INDEX IF NOT EXISTS idx_canary_deployments_status ON canary_deployments(status);
CREATE INDEX IF NOT EXISTS idx_canary_deployments_active ON canary_deployments(service_name) WHERE status IN ('active', 'promoting');
CREATE INDEX IF NOT EXISTS idx_canary_history_deployment ON canary_deployment_history(deployment_id);
CREATE INDEX IF NOT EXISTS idx_canary_metrics_deployment ON canary_metrics_snapshots(deployment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canary_logs_deployment_time ON canary_request_logs(deployment_id, created_at DESC);

-- Runtime readers order by created_at, absent from both original proposals.
-- Existing creation time is unknown; do not copy started_at or fabricate NOW().
DO $creation_time$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='canary_deployments'::regclass AND attname='created_at' AND NOT attisdropped) THEN
    ALTER TABLE canary_deployments ADD COLUMN created_at TIMESTAMP;
    ALTER TABLE canary_deployments ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
  END IF;
END
$creation_time$;

DO $contracts$
DECLARE expected record; relation_id oid; source_column smallint; target_column smallint;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('canary_deployments','canary_version','character varying(100)'),('canary_deployments','stable_version','character varying(100)'),
    ('canary_deployments','strategy','character varying(20)'),('canary_deployments','rules','jsonb'),('canary_deployments','metrics_baseline','jsonb'),
    ('canary_deployments','created_by','integer'),('canary_deployments','created_at','timestamp without time zone'),('canary_deployments','updated_at','timestamp without time zone'),
    ('canary_deployment_history','details','jsonb'),('canary_metrics_snapshots','metrics','jsonb'),
    ('canary_request_logs','status_code','integer'),('canary_request_logs','latency_ms','integer'),('canary_request_logs','created_at','timestamp without time zone')
  ) AS columns(relation,name,type) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.%I',current_schema(),expected.relation)) AND attname=expected.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=expected.type) THEN
      RAISE EXCEPTION 'Canary %.% requires explicit schema adoption',expected.relation,expected.name;
    END IF;
  END LOOP;
  SELECT attnum INTO target_column FROM pg_attribute WHERE attrelid='canary_deployments'::regclass AND attname='id' AND NOT attisdropped;
  FOR expected IN SELECT * FROM (VALUES('canary_deployment_history'),('canary_metrics_snapshots'),('canary_request_logs')) AS children(relation) LOOP
    relation_id:=to_regclass(format('%I.%I',current_schema(),expected.relation));
    SELECT attnum INTO source_column FROM pg_attribute WHERE attrelid=relation_id AND attname='deployment_id' AND NOT attisdropped;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=relation_id AND contype='f' AND conkey=ARRAY[source_column] AND confrelid='canary_deployments'::regclass AND confkey=ARRAY[target_column] AND confdeltype='c' AND convalidated) THEN
      RAISE EXCEPTION 'Canary % reference requires explicit schema adoption',expected.relation;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM canary_deployments WHERE status IN('active','promoting') GROUP BY service_name HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Multiple active canaries for one service require explicit adoption; no rollout may be discarded';
  END IF;
END
$contracts$;

-- The earlier service/status index allows one active AND one promoting row.
-- Preserve that index and add the manager's actual one-active-rollout-per-service rule.
CREATE UNIQUE INDEX IF NOT EXISTS canary_one_active_service ON canary_deployments(service_name) WHERE status IN('active','promoting');
DO $index_contract$
DECLARE actual record;
BEGIN
  SELECT i.*,pg_get_expr(i.indpred,i.indrelid) AS predicate INTO actual FROM pg_index i WHERE indexrelid=to_regclass(format('%I.canary_one_active_service',current_schema()));
  IF NOT FOUND THEN RAISE EXCEPTION 'Canary active-service index requires explicit adoption'; END IF;
  IF NOT actual.indisunique OR NOT actual.indisvalid OR actual.indrelid<>'canary_deployments'::regclass OR actual.indnatts<>1
     OR actual.indkey::text<>(SELECT attnum::text FROM pg_attribute WHERE attrelid='canary_deployments'::regclass AND attname='service_name' AND NOT attisdropped)
     OR regexp_replace(actual.predicate,'[[:space:]]','','g') IS DISTINCT FROM regexp_replace('((status)::text = ANY ((ARRAY[''active''::character varying, ''promoting''::character varying])::text[]))','[[:space:]]','','g') THEN
    RAISE EXCEPTION 'Canary active-service index requires explicit adoption';
  END IF;
END
$index_contract$;

DO $update_contract$
DECLARE identity oid; existing record; trigger_record record;
body TEXT := $function$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$function$;
BEGIN
  identity:=to_regprocedure(format('%I.update_canary_deployments_updated_at()',current_schema()));
  IF identity IS NULL THEN
    EXECUTE format('CREATE FUNCTION %I.update_canary_deployments_updated_at() RETURNS trigger LANGUAGE plpgsql AS %L',current_schema(),body);
    identity:=to_regprocedure(format('%I.update_canary_deployments_updated_at()',current_schema()));
  ELSE
    SELECT p.prosrc,p.prosecdef,p.proconfig,l.lanname,p.prorettype INTO existing FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=identity;
    IF existing.prosrc IS DISTINCT FROM body OR existing.prosecdef OR existing.proconfig IS NOT NULL OR existing.lanname<>'plpgsql' OR existing.prorettype<>'trigger'::regtype THEN
      RAISE EXCEPTION 'Customized canary timestamp function requires explicit adoption';
    END IF;
  END IF;
  SELECT * INTO trigger_record FROM pg_trigger WHERE tgrelid='canary_deployments'::regclass AND tgname='trigger_update_canary_deployments_updated_at' AND NOT tgisinternal;
  IF FOUND THEN
    IF trigger_record.tgfoid<>identity OR trigger_record.tgtype<>19 OR trigger_record.tgenabled<>'O' OR trigger_record.tgnargs<>0 OR trigger_record.tgdeferrable OR trigger_record.tgqual IS NOT NULL OR trigger_record.tgattr::text<>'' THEN
      RAISE EXCEPTION 'Customized canary timestamp trigger requires explicit adoption';
    END IF;
  ELSE
    EXECUTE format('CREATE TRIGGER trigger_update_canary_deployments_updated_at BEFORE UPDATE ON %I.canary_deployments FOR EACH ROW EXECUTE FUNCTION %I.update_canary_deployments_updated_at()',current_schema(),current_schema());
  END IF;
END
$update_contract$;

DO $comments$
DECLARE expected record; relation_id oid;
BEGIN
  FOR expected IN SELECT * FROM (VALUES('canary_deployments','金丝雀发布主表'),('canary_deployment_history','金丝雀发布历史记录'),('canary_metrics_snapshots','金丝雀指标快照'),('canary_request_logs','金丝雀请求日志（用于指标统计）')) AS notes(relation,note) LOOP
    relation_id:=to_regclass(format('%I.%I',current_schema(),expected.relation));
    IF obj_description(relation_id,'pg_class') IS NULL THEN EXECUTE format('COMMENT ON TABLE %I.%I IS %L',current_schema(),expected.relation,expected.note); END IF;
  END LOOP;
END
$comments$;
