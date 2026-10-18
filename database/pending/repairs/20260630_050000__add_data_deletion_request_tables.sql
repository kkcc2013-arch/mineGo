-- REQ-00127: an explicit UUID erasure workflow, separate from legacy SERIAL requests.
-- Never reinterpret integer historical owners/IDs or manufacture approvals/proofs.
DO $identity$
DECLARE expected record; target oid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.users',current_schema())) AND attname='id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Erasure workflow requires canonical local UUID users';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.data_deletion_requests',current_schema())) AND attname='id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Existing UUID deletion workflow needs explicit adoption; requests cannot be silently duplicated';
  END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('data_erasure_requests','id','uuid'),('data_erasure_requests','user_id','uuid'),('data_erasure_requests','live_user_id','uuid'),('data_erasure_requests','verification_digest','bytea'),
    ('data_erasure_tasks','request_id','uuid'),('data_erasure_certificates','request_id','uuid'),('data_erasure_certificates','user_id','uuid'),
    ('data_erasure_categories','declared_tables','text[]'),('data_erasure_approval_history','request_id','uuid')
  ) AS fields(relation,name,type) LOOP
    target:=to_regclass(format('%I.%I',current_schema(),expected.relation));
    IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=target AND attname=expected.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=expected.type) THEN
      RAISE EXCEPTION 'Erasure %.% schema requires explicit adoption',expected.relation,expected.name;
    END IF;
  END LOOP;
END
$identity$;

CREATE TABLE IF NOT EXISTS data_erasure_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  live_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  request_type VARCHAR(20) NOT NULL CHECK(request_type IN('full','partial')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verifying','approved','processing','completed','rejected','cancelled','failed')),
  reason TEXT,
  requested_data_types TEXT[] NOT NULL DEFAULT ARRAY['all'],
  approval_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(approval_status IN('pending','auto_approved','manual_approved','rejected')),
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  execute_after TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  processing_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK(max_retries BETWEEN 0 AND 10),
  ip_address INET,
  user_agent TEXT,
  verification_digest BYTEA CHECK(verification_digest IS NULL OR octet_length(verification_digest)=32),
  verification_expires_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,user_id),
  CHECK(live_user_id IS NULL OR live_user_id=user_id),
  CHECK(cardinality(requested_data_types)>0 AND array_position(requested_data_types,NULL) IS NULL),
  CHECK(status NOT IN('approved','processing','completed') OR (verified_at IS NOT NULL AND approved_at IS NOT NULL AND execute_after IS NOT NULL AND approval_status IN('auto_approved','manual_approved'))),
  CHECK(status<>'completed' OR processing_completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS erasure_one_active_request_per_subject ON data_erasure_requests(user_id) WHERE status IN('pending','verifying','approved','processing');
CREATE INDEX IF NOT EXISTS idx_erasure_requests_status ON data_erasure_requests(status,execute_after);
CREATE INDEX IF NOT EXISTS idx_erasure_requests_created ON data_erasure_requests(created_at);

CREATE TABLE IF NOT EXISTS data_erasure_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES data_erasure_requests(id) ON DELETE CASCADE,
  task_name VARCHAR(100) NOT NULL,
  service_name VARCHAR(50) NOT NULL,
  data_category VARCHAR(50) NOT NULL,
  resource_code VARCHAR(100) NOT NULL,
  plan_version VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','completed','failed','skipped')),
  affected_rows BIGINT CHECK(affected_rows>=0),
  retention_basis TEXT,
  backup_path TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT CHECK(duration_ms>=0),
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK(max_retries BETWEEN 0 AND 10),
  depends_on UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(request_id,resource_code),
  CHECK(status<>'completed' OR (affected_rows IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK(status<>'skipped' OR (retention_basis IS NOT NULL AND length(btrim(retention_basis))>0 AND completed_at IS NOT NULL)),
  CHECK(array_position(depends_on,NULL) IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_erasure_tasks_request ON data_erasure_tasks(request_id,status);
CREATE INDEX IF NOT EXISTS idx_erasure_tasks_category ON data_erasure_tasks(data_category);

CREATE TABLE IF NOT EXISTS data_erasure_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  user_id UUID NOT NULL,
  certificate_number VARCHAR(50) UNIQUE NOT NULL,
  deletion_summary JSONB NOT NULL,
  signed_payload TEXT NOT NULL,
  payload_digest BYTEA NOT NULL CHECK(octet_length(payload_digest)=32),
  deleted_data_categories TEXT[] NOT NULL,
  total_records_deleted BIGINT NOT NULL CHECK(total_records_deleted>=0),
  signature TEXT NOT NULL CHECK(length(signature)>0),
  signature_algorithm VARCHAR(50) NOT NULL CHECK(signature_algorithm IN('RSA-SHA256','Ed25519')),
  signing_key_id VARCHAR(100) NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(request_id,user_id) REFERENCES data_erasure_requests(id,user_id) ON DELETE RESTRICT,
  CHECK(deletion_summary=signed_payload::jsonb),
  CHECK((deletion_summary->>'requestId') IS NOT DISTINCT FROM request_id::text),
  CHECK((deletion_summary->>'userId') IS NOT DISTINCT FROM user_id::text),
  CHECK((deletion_summary->>'totalRecords') IS NOT DISTINCT FROM total_records_deleted::text),
  CHECK(payload_digest=digest(signed_payload,'sha256')),
  CHECK(cardinality(deleted_data_categories)>0 AND array_position(deleted_data_categories,NULL) IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_erasure_certificates_request ON data_erasure_certificates(request_id);

CREATE TABLE IF NOT EXISTS data_erasure_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_code VARCHAR(50) UNIQUE NOT NULL,
  category_name VARCHAR(100) NOT NULL,
  description TEXT,
  declared_tables TEXT[] NOT NULL,
  proposed_retention_days INTEGER,
  is_deletable BOOLEAN NOT NULL DEFAULT TRUE,
  deletion_priority INTEGER NOT NULL DEFAULT 50,
  policy_reference TEXT,
  resource_plan_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Preserve proposal metadata, not executable SQL identifiers or legal approval.
INSERT INTO data_erasure_categories(category_code,category_name,description,declared_tables,proposed_retention_days,deletion_priority) VALUES
('profile','用户档案','用户基本信息',ARRAY['users','user_profiles'],0,10),
('pokemon','精灵数据','用户拥有的精灵',ARRAY['user_pokemon','pokemon_stats'],0,20),
('social','社交数据','好友、公会等社交关系',ARRAY['friendships','guild_members','messages'],0,30),
('transaction','交易记录','支付和交易记录',ARRAY['transactions','payments'],2555,40),
('location','位置历史','GPS位置历史',ARRAY['location_history','visit_records'],90,15),
('activity','活动日志','用户活动日志',ARRAY['activity_logs','audit_logs'],365,50),
('preferences','用户偏好','设置和偏好',ARRAY['user_preferences','notification_preferences'],0,5),
('achievements','成就数据','用户成就和里程碑',ARRAY['user_achievements','milestones'],0,35)
ON CONFLICT(category_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS data_erasure_approval_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES data_erasure_requests(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type VARCHAR(20) NOT NULL CHECK(actor_type IN('system','admin','auto')),
  previous_status VARCHAR(20),
  new_status VARCHAR(20),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erasure_approval_request ON data_erasure_approval_history(request_id);

DO $contracts$
DECLARE expected record; relation_id oid; target_id oid; source_columns smallint[]; target_columns smallint[];
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('data_erasure_requests','id','uuid'),('data_erasure_requests','user_id','uuid'),('data_erasure_requests','live_user_id','uuid'),('data_erasure_requests','verification_digest','bytea'),
    ('data_erasure_tasks','id','uuid'),('data_erasure_tasks','request_id','uuid'),('data_erasure_tasks','resource_code','character varying(100)'),('data_erasure_tasks','plan_version','character varying(100)'),('data_erasure_tasks','affected_rows','bigint'),('data_erasure_tasks','max_retries','integer'),
    ('data_erasure_certificates','id','uuid'),('data_erasure_certificates','request_id','uuid'),('data_erasure_certificates','user_id','uuid'),('data_erasure_certificates','signed_payload','text'),('data_erasure_certificates','payload_digest','bytea'),('data_erasure_certificates','retention_until','timestamp with time zone'),
    ('data_erasure_categories','declared_tables','text[]'),('data_erasure_categories','proposed_retention_days','integer'),('data_erasure_approval_history','request_id','uuid')
  ) AS fields(relation,name,type) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.%I',current_schema(),expected.relation)) AND attname=expected.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=expected.type) THEN
      RAISE EXCEPTION 'Erasure %.% schema requires explicit adoption',expected.relation,expected.name;
    END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('data_erasure_requests',ARRAY['live_user_id'],'users',ARRAY['id'],'n'),('data_erasure_requests',ARRAY['approved_by'],'users',ARRAY['id'],'n'),
    ('data_erasure_tasks',ARRAY['request_id'],'data_erasure_requests',ARRAY['id'],'c'),
    ('data_erasure_certificates',ARRAY['request_id','user_id'],'data_erasure_requests',ARRAY['id','user_id'],'r'),
    ('data_erasure_approval_history',ARRAY['request_id'],'data_erasure_requests',ARRAY['id'],'c'),('data_erasure_approval_history',ARRAY['actor_id'],'users',ARRAY['id'],'n')
  ) AS refs(relation,source,target,target_columns,on_delete) LOOP
    relation_id:=to_regclass(format('%I.%I',current_schema(),expected.relation));target_id:=to_regclass(format('%I.%I',current_schema(),expected.target));
    SELECT array_agg(a.attnum ORDER BY k.position) INTO source_columns FROM unnest(expected.source) WITH ORDINALITY k(name,position) JOIN pg_attribute a ON a.attrelid=relation_id AND a.attname=k.name AND NOT a.attisdropped;
    SELECT array_agg(a.attnum ORDER BY k.position) INTO target_columns FROM unnest(expected.target_columns) WITH ORDINALITY k(name,position) JOIN pg_attribute a ON a.attrelid=target_id AND a.attname=k.name AND NOT a.attisdropped;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=relation_id AND contype='f' AND conkey=source_columns AND confrelid=target_id AND confkey=target_columns AND confdeltype::text=expected.on_delete AND convalidated) THEN
      RAISE EXCEPTION 'Erasure % reference contract requires explicit adoption',expected.relation;
    END IF;
  END LOOP;
END
$contracts$;

DO $active_index$
DECLARE actual record; identity oid;
BEGIN
  identity:=to_regclass(format('%I.erasure_one_active_request_per_subject',current_schema()));
  SELECT i.*,pg_get_expr(i.indpred,i.indrelid) AS predicate INTO actual FROM pg_index i WHERE i.indexrelid=identity;
  IF NOT FOUND THEN RAISE EXCEPTION 'Erasure active request index requires explicit adoption'; END IF;
  IF NOT actual.indisunique OR NOT actual.indisvalid OR actual.indrelid<>'data_erasure_requests'::regclass OR actual.indnatts<>1
     OR actual.indkey::text<>(SELECT attnum::text FROM pg_attribute WHERE attrelid='data_erasure_requests'::regclass AND attname='user_id' AND NOT attisdropped)
     OR regexp_replace(actual.predicate,'[[:space:]]','','g')<>regexp_replace('((status)::text = ANY ((ARRAY[''pending''::character varying, ''verifying''::character varying, ''approved''::character varying, ''processing''::character varying])::text[]))','[[:space:]]','','g') THEN
    RAISE EXCEPTION 'Erasure active request index requires explicit adoption';
  END IF;
END
$active_index$;

-- Own functions only. Never replace the globally shared update_updated_at_column.
DO $functions$
DECLARE expected record; existing record; identity oid;
binding TEXT := $body$
DECLARE account_exists BOOLEAN;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.live_user_id IS NULL OR NEW.live_user_id<>NEW.user_id THEN
      RAISE EXCEPTION 'New erasure request requires its live subject';
    END IF;
  ELSE
    IF NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id THEN
      RAISE EXCEPTION 'Erasure request identity is immutable';
    END IF;
    IF NEW.live_user_id IS DISTINCT FROM OLD.live_user_id THEN
      IF NEW.live_user_id IS NOT NULL THEN RAISE EXCEPTION 'Erasure live subject cannot be reassigned'; END IF;
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.users WHERE id=$1)',TG_TABLE_SCHEMA) INTO STRICT account_exists USING OLD.live_user_id;
      IF account_exists THEN RAISE EXCEPTION 'Live subject can detach only when the account is removed'; END IF;
    END IF;
  END IF;
  NEW.updated_at=NOW();
  RETURN NEW;
END;
$body$;
touching TEXT := $body$
BEGIN
  NEW.updated_at=NOW();
  RETURN NEW;
END;
$body$;
proof TEXT := $body$
DECLARE state record; actual_categories text[]; actual_totals jsonb;
BEGIN
  EXECUTE format('SELECT r.status,r.processing_completed_at,count(t.id) FILTER(WHERE t.status=''completed'') AS completed,count(t.id) FILTER(WHERE t.status NOT IN(''completed'',''skipped'')) AS pending,COALESCE(sum(t.affected_rows) FILTER(WHERE t.status=''completed''),0) AS total,COALESCE(array_agg(DISTINCT t.data_category::text ORDER BY t.data_category::text) FILTER(WHERE t.status=''completed''),ARRAY[]::text[]) AS categories FROM %I.data_erasure_requests r LEFT JOIN %I.data_erasure_tasks t ON t.request_id=r.id WHERE r.id=$1 GROUP BY r.id',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO state USING NEW.request_id;
  EXECUTE format('SELECT COALESCE(jsonb_object_agg(category,amount::text),''{}''::jsonb) FROM (SELECT data_category AS category,sum(affected_rows) AS amount FROM %I.data_erasure_tasks WHERE request_id=$1 AND status=''completed'' GROUP BY data_category) totals',TG_TABLE_SCHEMA) INTO actual_totals USING NEW.request_id;
  SELECT array_agg(category ORDER BY category) INTO actual_categories FROM unnest(NEW.deleted_data_categories) AS categories(category);
  IF state.status IS DISTINCT FROM 'completed' OR state.processing_completed_at IS NULL OR state.pending<>0 OR state.completed=0 OR state.total<>NEW.total_records_deleted OR state.categories IS DISTINCT FROM actual_categories OR NEW.deletion_summary->'categories' IS DISTINCT FROM actual_totals THEN
    RAISE EXCEPTION 'Erasure certificate requires completed accounted tasks and request';
  END IF;
  RETURN NULL;
END;
$body$;
BEGIN
  FOR expected IN SELECT * FROM (VALUES('data_erasure_bind_subject',binding),('data_erasure_touch_updated_at',touching),('data_erasure_validate_certificate',proof)) AS functions(name,body) LOOP
    identity:=to_regprocedure(format('%I.%I()',current_schema(),expected.name));
    IF identity IS NULL THEN
      EXECUTE format('CREATE FUNCTION %I.%I() RETURNS trigger LANGUAGE plpgsql AS %L',current_schema(),expected.name,expected.body);
    ELSE
      SELECT p.prosrc,p.prosecdef,p.proconfig,l.lanname,p.prorettype INTO existing FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=identity;
      IF existing.prosrc IS DISTINCT FROM expected.body OR existing.prosecdef OR existing.proconfig IS NOT NULL OR existing.lanname<>'plpgsql' OR existing.prorettype<>'trigger'::regtype THEN
        RAISE EXCEPTION 'Customized erasure function % needs explicit adoption',expected.name;
      END IF;
    END IF;
  END LOOP;
END
$functions$;

DO $triggers$
DECLARE expected record; previous record; target oid; function_id oid;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('data_erasure_requests','erasure_bind_subject','data_erasure_bind_subject',23,false),
    ('data_erasure_tasks','erasure_touch_task','data_erasure_touch_updated_at',19,false),
    ('data_erasure_categories','erasure_touch_category','data_erasure_touch_updated_at',19,false),
    ('data_erasure_certificates','erasure_validate_certificate','data_erasure_validate_certificate',21,true)
  ) AS triggers(relation,name,function_name,kind,deferred) LOOP
    target:=to_regclass(format('%I.%I',current_schema(),expected.relation));
    function_id:=to_regprocedure(format('%I.%I()',current_schema(),expected.function_name));
    SELECT * INTO previous FROM pg_trigger WHERE tgrelid=target AND tgname=expected.name AND NOT tgisinternal;
    IF FOUND THEN
      IF previous.tgfoid<>function_id OR previous.tgtype<>expected.kind OR previous.tgenabled<>'O' OR previous.tgnargs<>0 OR previous.tgdeferrable<>expected.deferred OR previous.tginitdeferred<>expected.deferred OR previous.tgqual IS NOT NULL OR previous.tgattr::text<>'' THEN
        RAISE EXCEPTION 'Customized erasure trigger % needs explicit adoption',expected.name;
      END IF;
    ELSIF expected.deferred THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION %I.%I()',expected.name,current_schema(),expected.relation,current_schema(),expected.function_name);
    ELSE
      EXECUTE format('CREATE TRIGGER %I BEFORE %s ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.%I()',expected.name,CASE WHEN expected.kind=23 THEN 'INSERT OR UPDATE' ELSE 'UPDATE' END,current_schema(),expected.relation,current_schema(),expected.function_name);
    END IF;
  END LOOP;
END
$triggers$;
