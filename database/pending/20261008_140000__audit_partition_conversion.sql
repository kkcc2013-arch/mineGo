-- REQ-00060: preserve V1 audit storage, identity and data while creating a real range parent.
-- This prerequisite is transactional; the runner owns commit/rollback and the migration lock.
-- migrate:up
CREATE TABLE audit_partition_conversion_state (
  id BOOLEAN PRIMARY KEY CHECK(id),
  original_oid OID NOT NULL,
  parent_oid OID,
  converted BOOLEAN NOT NULL,
  original_primary_key JSONB,
  original_triggers JSONB NOT NULL DEFAULT '[]',
  original_views JSONB NOT NULL DEFAULT '[]'
);

CREATE FUNCTION minego_audit_identity_reserve() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $identity$
DECLARE duplicate BOOLEAN;
BEGIN
  IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id THEN
    -- Reserve/lock the logical ID until transaction end. This serializes inserts
    -- across different time partitions without changing the ID type or sequence.
    EXECUTE format('INSERT INTO %s(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id',TG_ARGV[0]) USING NEW.id;
    EXECUTE format('SELECT count(*)>1 FROM %s WHERE id=$1',TG_ARGV[1]) INTO duplicate USING NEW.id;
    IF duplicate THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Duplicate audit log id'; END IF;
  END IF;
  RETURN NEW;
END
$identity$;
CREATE FUNCTION minego_audit_identity_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $identity$
BEGIN
  -- AFTER row events observe the final statement state, including rows moved by
  -- an UPDATE of the partition key. Do not release IDs still present in a leaf.
  IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id THEN
    EXECUTE format('DELETE FROM %s WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM %s WHERE id=$1)',TG_ARGV[0],TG_ARGV[1]) USING OLD.id;
  END IF;
  RETURN NULL;
END
$identity$;
REVOKE ALL ON FUNCTION minego_audit_identity_reserve() FROM PUBLIC;
REVOKE ALL ON FUNCTION minego_audit_identity_after() FROM PUBLIC;

DO $conversion$
DECLARE
  ns TEXT := current_schema();
  original RECORD;
  pk RECORD;
  entry RECORD;
  triggers JSONB;
  views JSONB;
  id_type TEXT;
  tail TEXT;
  role_name TEXT;
  registry TEXT := format('%I.audit_log_identity',current_schema());
  parent_name TEXT := format('%I.audit_logs',current_schema());
BEGIN
  SELECT c.*,r.rolname AS owner_name INTO STRICT original FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid=to_regclass(parent_name);
  IF original.relkind='p' THEN
    INSERT INTO audit_partition_conversion_state(id,original_oid,parent_oid,converted) VALUES(TRUE,original.oid,original.oid,FALSE);
    RETURN;
  END IF;
  IF original.relkind<>'r' OR original.relpersistence<>'p' THEN RAISE EXCEPTION 'Expected a persistent regular audit table'; END IF;
  IF original.relforcerowsecurity THEN RAISE EXCEPTION 'Forced audit RLS requires an explicit identity-check policy'; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=original.oid AND contype='f') THEN
    RAISE EXCEPTION 'Incoming audit foreign keys require a partition-key migration before conversion';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_index WHERE indrelid=original.oid AND indisunique AND NOT indisprimary) THEN
    RAISE EXCEPTION 'Additional audit uniqueness requires a matching global identity rule';
  END IF;
  IF to_regclass(format('%I.audit_logs_default',ns)) IS NOT NULL OR to_regclass(registry) IS NOT NULL THEN
    RAISE EXCEPTION 'Audit conversion target already exists';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=original.oid AND attidentity<>'') THEN
    RAISE EXCEPTION 'Audit identity columns require explicit sequence adoption';
  END IF;
  EXECUTE format('LOCK TABLE %I.audit_logs IN ACCESS EXCLUSIVE MODE',ns);
  SELECT conname,pg_get_constraintdef(oid) AS definition INTO STRICT pk FROM pg_constraint WHERE conrelid=original.oid AND contype='p';
  IF pk.definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Expected the V1 audit ID primary key'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled)), '[]'::jsonb)
    INTO triggers FROM pg_trigger WHERE tgrelid=original.oid AND NOT tgisinternal;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',v.relname,'definition',pg_get_viewdef(v.oid))), '[]'::jsonb)
    INTO views FROM pg_class v JOIN pg_namespace n ON n.oid=v.relnamespace WHERE v.relkind='v' AND v.oid IN
      (SELECT DISTINCT rw.ev_class FROM pg_depend d JOIN pg_rewrite rw ON rw.oid=d.objid WHERE d.refobjid=original.oid AND d.classid='pg_rewrite'::regclass);
  IF EXISTS(SELECT 1 FROM pg_class v WHERE v.relkind='m' AND v.oid IN
      (SELECT rw.ev_class FROM pg_depend d JOIN pg_rewrite rw ON rw.oid=d.objid WHERE d.refobjid=original.oid AND d.classid='pg_rewrite'::regclass)) THEN
    RAISE EXCEPTION 'Materialized audit views require an explicit refresh/rebind migration';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=original.oid AND tgname IN('minego_audit_identity_reserve','minego_audit_identity_after')) THEN
    RAISE EXCEPTION 'Audit identity trigger name already exists';
  END IF;
  INSERT INTO audit_partition_conversion_state(id,original_oid,converted,original_primary_key,original_triggers,original_views)
    VALUES(TRUE,original.oid,TRUE,jsonb_build_object('name',pk.conname,'definition',pk.definition),triggers,views);
  -- Keep every original column/type, and add only missing fields needed by the
  -- partition/encryption contracts. These additive fields survive rollback.
  EXECUTE format('ALTER TABLE %I.audit_logs ADD COLUMN IF NOT EXISTS resource_type VARCHAR(50), ADD COLUMN IF NOT EXISTS resource_id VARCHAR(100), ADD COLUMN IF NOT EXISTS old_values JSONB, ADD COLUMN IF NOT EXISTS new_values JSONB, ADD COLUMN IF NOT EXISTS metadata JSONB',ns);
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=original.oid AND attname='entity_type' AND NOT attisdropped) THEN
    EXECUTE format('UPDATE %I.audit_logs SET resource_type=COALESCE(resource_type,entity_type),resource_id=COALESCE(resource_id,entity_id)',ns);
  END IF;
  SELECT format_type(atttypid,atttypmod) INTO STRICT id_type FROM pg_attribute WHERE attrelid=original.oid AND attname='id' AND NOT attisdropped;
  EXECUTE format('CREATE TABLE %s(id %s PRIMARY KEY)',registry,id_type);
  EXECUTE format('INSERT INTO %s SELECT id FROM %I.audit_logs',registry,ns);
  FOR entry IN SELECT * FROM jsonb_to_recordset(triggers) AS t(name TEXT,definition TEXT,enabled TEXT) LOOP
    EXECUTE format('DROP TRIGGER %I ON %I.audit_logs',entry.name,ns);
  END LOOP;
  EXECUTE format('ALTER TABLE %I.audit_logs DROP CONSTRAINT %I',ns,pk.conname);
  EXECUTE format('ALTER TABLE %I.audit_logs RENAME TO audit_logs_default',ns);
  EXECUTE format('CREATE TABLE %I.audit_logs(LIKE %I.audit_logs_default INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMMENTS) PARTITION BY RANGE(created_at)',ns,ns);
  EXECUTE format('ALTER TABLE %I.audit_logs ADD CONSTRAINT audit_logs_partition_key PRIMARY KEY(id,created_at)',ns);
  EXECUTE format('ALTER TABLE %I.audit_logs ATTACH PARTITION %I.audit_logs_default DEFAULT',ns,ns);
  UPDATE audit_partition_conversion_state SET parent_oid=to_regclass(parent_name) WHERE id=TRUE;
  -- Outbound foreign keys remain effective for every time partition.
  FOR entry IN SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=original.oid AND contype='f' LOOP
    EXECUTE format('ALTER TABLE %I.audit_logs ADD CONSTRAINT %I %s',ns,entry.conname,entry.definition);
  END LOOP;
  -- Original indexes stay with original storage. Parent indexes are copied so
  -- future partitions receive the same expression/include/predicate behavior.
  FOR entry IN SELECT i.indexrelid,c.relname,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=original.oid AND NOT i.indisprimary LOOP
    IF position(' USING ' IN entry.relname)>0 THEN RAISE EXCEPTION 'Unsupported index identifier'; END IF;
    tail:=substring(entry.definition FROM position(' USING ' IN entry.definition));
    EXECUTE format('CREATE INDEX %I ON %I.audit_logs %s',left(entry.relname,38)||'_p_'||entry.indexrelid::text,ns,tail);
  END LOOP;
  FOR entry IN SELECT * FROM jsonb_to_recordset(triggers) AS t(name TEXT,definition TEXT,enabled TEXT) LOOP
    EXECUTE entry.definition;
    EXECUTE format('ALTER TABLE %I.audit_logs %s TRIGGER %I',ns,CASE entry.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END,entry.name);
  END LOOP;
  EXECUTE format('CREATE TRIGGER minego_audit_identity_reserve AFTER INSERT OR UPDATE ON %I.audit_logs FOR EACH ROW EXECUTE FUNCTION %I.minego_audit_identity_reserve(%L,%L)',ns,ns,registry,parent_name);
  EXECUTE format('CREATE TRIGGER minego_audit_identity_after AFTER DELETE OR UPDATE ON %I.audit_logs FOR EACH ROW EXECUTE FUNCTION %I.minego_audit_identity_after(%L,%L)',ns,ns,registry,parent_name);
  -- Preserve ordinary views' bindings, not merely their text/name.
  FOR entry IN SELECT * FROM jsonb_to_recordset(views) AS v(schema TEXT,name TEXT,definition TEXT) LOOP
    EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s',entry.schema,entry.name,entry.definition);
  END LOOP;
  -- V1 has no policies; copy any ordinary (non-forced) custom policies as well.
  FOR entry IN SELECT p.*,pg_get_expr(polqual,polrelid) AS using_expr,pg_get_expr(polwithcheck,polrelid) AS check_expr FROM pg_policy p WHERE polrelid=original.oid LOOP
    SELECT string_agg(CASE role_id WHEN 0 THEN 'PUBLIC' ELSE quote_ident((SELECT rolname FROM pg_roles WHERE oid=role_id)) END,',') INTO role_name FROM unnest(entry.polroles) AS role_id;
    EXECUTE format('CREATE POLICY %I ON %I.audit_logs AS %s FOR %s TO %s%s%s',entry.polname,ns,CASE WHEN entry.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,CASE entry.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,role_name,CASE WHEN entry.using_expr IS NULL THEN '' ELSE ' USING ('||entry.using_expr||')' END,CASE WHEN entry.check_expr IS NULL THEN '' ELSE ' WITH CHECK ('||entry.check_expr||')' END);
  END LOOP;
  IF original.relrowsecurity THEN EXECUTE format('ALTER TABLE %I.audit_logs ENABLE ROW LEVEL SECURITY',ns); END IF;
  EXECUTE format('ALTER TABLE %I.audit_logs OWNER TO %I',ns,original.owner_name);
  FOR entry IN SELECT a.* FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=original.oid LOOP
    role_name:=CASE entry.grantee WHEN 0 THEN 'PUBLIC' ELSE quote_ident((SELECT rolname FROM pg_roles WHERE oid=entry.grantee)) END;
    EXECUTE format('GRANT %s ON %I.audit_logs TO %s%s',entry.privilege_type,ns,role_name,CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  FOR entry IN SELECT t.attname,a.* FROM pg_attribute t CROSS JOIN LATERAL aclexplode(t.attacl) a WHERE t.attrelid=original.oid AND t.attnum>0 AND NOT t.attisdropped LOOP
    role_name:=CASE entry.grantee WHEN 0 THEN 'PUBLIC' ELSE quote_ident((SELECT rolname FROM pg_roles WHERE oid=entry.grantee)) END;
    EXECUTE format('GRANT %s(%I) ON %I.audit_logs TO %s%s',entry.privilege_type,entry.attname,ns,role_name,CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  EXECUTE format('COMMENT ON TABLE %I.audit_logs IS %L',ns,obj_description(original.oid,'pg_class'));
END
$conversion$;

CREATE FUNCTION minego_create_time_partition(parent_table TEXT,partition_name TEXT,start_date TIMESTAMPTZ,end_date TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SET TimeZone='UTC' AS $partition$
DECLARE
  ns TEXT:=current_schema();
  parent_oid OID:=to_regclass(format('%I.%I',current_schema(),parent_table));
  target_oid OID:=to_regclass(format('%I.%I',current_schema(),partition_name));
  default_oid OID;
  default_name TEXT;
  columns_list TEXT;
  entry RECORD;
  triggers JSONB;
  bound TEXT;
  bounds TEXT[];
  key_type OID;
BEGIN
  IF parent_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_attribute a ON a.attrelid=p.partrelid AND a.attnum=p.partattrs[0]
      WHERE p.partrelid=parent_oid AND p.partstrat='r' AND p.partnatts=1 AND a.attname='created_at') THEN
    RAISE EXCEPTION 'Expected a created_at range parent: %',parent_table;
  END IF;
  IF start_date IS NULL OR end_date IS NULL OR start_date>=end_date THEN RAISE EXCEPTION 'Invalid time partition bounds'; END IF;
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',ns,parent_table);
  -- A competing creator may have committed while this lock was waiting.
  target_oid:=to_regclass(format('%I.%I',ns,partition_name));
  IF target_oid IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=parent_oid AND inhrelid=target_oid) THEN RAISE EXCEPTION 'Partition name belongs to another relation'; END IF;
    SELECT pg_get_expr(relpartbound,oid) INTO bound FROM pg_class WHERE oid=target_oid;
    bounds:=regexp_match(bound,$bound$FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    SELECT atttypid INTO key_type FROM pg_attribute WHERE attrelid=parent_oid AND attname='created_at';
    IF bounds IS NULL THEN RAISE EXCEPTION 'Existing partition has incompatible bounds'; END IF;
    IF key_type='timestamp without time zone'::regtype THEN
      IF bounds[1]::timestamp IS DISTINCT FROM start_date AT TIME ZONE 'UTC' OR bounds[2]::timestamp IS DISTINCT FROM end_date AT TIME ZONE 'UTC' THEN RAISE EXCEPTION 'Existing partition bounds differ'; END IF;
    ELSE
      IF bounds[1]::timestamptz IS DISTINCT FROM start_date OR bounds[2]::timestamptz IS DISTINCT FROM end_date THEN RAISE EXCEPTION 'Existing partition bounds differ'; END IF;
    END IF;
    RETURN FALSE;
  END IF;
  SELECT c.oid,c.relname INTO default_oid,default_name FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=parent_oid AND pg_get_expr(c.relpartbound,c.oid)='DEFAULT';
  IF default_oid IS NULL THEN
    default_name:=parent_table||'_default';
    IF to_regclass(format('%I.%I',ns,default_name)) IS NOT NULL THEN RAISE EXCEPTION 'Default partition name belongs to another relation'; END IF;
    EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I DEFAULT',ns,default_name,ns,parent_table);
    default_oid:=to_regclass(format('%I.%I',ns,default_name));
  END IF;
  EXECUTE format('CREATE TABLE %I.%I(LIKE %I.%I INCLUDING ALL)',ns,partition_name,ns,parent_table);
  IF default_oid IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled)),'[]'::jsonb) INTO triggers FROM pg_trigger WHERE tgrelid=default_oid AND NOT tgisinternal;
    EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER USER',ns,default_name);
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns_list FROM pg_attribute WHERE attrelid=parent_oid AND attnum>0 AND NOT attisdropped AND attgenerated='';
    EXECUTE format('WITH moved AS(DELETE FROM %I.%I WHERE created_at>=$1 AND created_at<$2 RETURNING %s) INSERT INTO %I.%I(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM moved',ns,default_name,columns_list,ns,partition_name,columns_list,columns_list) USING start_date,end_date;
  END IF;
  EXECUTE format('ALTER TABLE %I.%I ATTACH PARTITION %I.%I FOR VALUES FROM(%L) TO(%L)',ns,parent_table,ns,partition_name,start_date,end_date);
  IF default_oid IS NOT NULL THEN
    FOR entry IN SELECT * FROM jsonb_to_recordset(triggers) AS t(name TEXT,enabled TEXT) LOOP
      EXECUTE format('ALTER TABLE %I.%I %s TRIGGER %I',ns,default_name,CASE entry.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END,entry.name);
    END LOOP;
  END IF;
  RETURN TRUE;
END
$partition$;

-- migrate:down
DO $rollback$
DECLARE
  ns TEXT:=current_schema();
  state RECORD;
  entry RECORD;
  columns_list TEXT;
  views JSONB;
  current_triggers JSONB;
BEGIN
  SELECT * INTO STRICT state FROM audit_partition_conversion_state WHERE id=TRUE;
  IF NOT state.converted THEN RETURN; END IF;
  IF to_regclass(format('%I.audit_logs',ns)) IS DISTINCT FROM state.parent_oid OR to_regclass(format('%I.audit_logs_default',ns)) IS DISTINCT FROM state.original_oid THEN
    RAISE EXCEPTION 'Audit conversion relation identity changed';
  END IF;
  EXECUTE format('LOCK TABLE %I.audit_logs IN ACCESS EXCLUSIVE MODE',ns);
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=state.parent_oid AND contype='f') THEN RAISE EXCEPTION 'New incoming audit references must be migrated before rollback'; END IF;
  IF to_regclass(format('%I.audit_logs_rollback_parent',ns)) IS NOT NULL THEN RAISE EXCEPTION 'Audit rollback target already exists'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',v.relname,'definition',pg_get_viewdef(v.oid))),'[]'::jsonb) INTO views
    FROM pg_class v JOIN pg_namespace n ON n.oid=v.relnamespace WHERE v.relkind='v' AND v.oid IN
      (SELECT DISTINCT rw.ev_class FROM pg_depend d JOIN pg_rewrite rw ON rw.oid=d.objid WHERE d.refobjid=state.parent_oid AND d.classid='pg_rewrite'::regclass);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled)),'[]'::jsonb) INTO current_triggers
    FROM pg_trigger WHERE tgrelid=state.parent_oid AND NOT tgisinternal AND tgname NOT IN('minego_audit_identity_reserve','minego_audit_identity_after');
  EXECUTE format('ALTER TABLE %I.audit_logs DETACH PARTITION %I.audit_logs_default',ns,ns);
  EXECUTE format('ALTER TABLE %I.audit_logs_default DISABLE TRIGGER USER',ns);
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns_list FROM pg_attribute WHERE attrelid=state.parent_oid AND attnum>0 AND NOT attisdropped AND attgenerated='';
  EXECUTE format('INSERT INTO %I.audit_logs_default(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM %I.audit_logs',ns,columns_list,columns_list,ns);
  EXECUTE format('ALTER TABLE %I.audit_logs RENAME TO audit_logs_rollback_parent',ns);
  EXECUTE format('ALTER TABLE %I.audit_logs_default RENAME TO audit_logs',ns);
  FOR entry IN SELECT * FROM jsonb_to_recordset(views) AS v(schema TEXT,name TEXT,definition TEXT) LOOP
    EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s',entry.schema,entry.name,entry.definition);
  END LOOP;
  EXECUTE format('DROP TABLE %I.audit_logs_rollback_parent',ns);
  EXECUTE format('DROP TRIGGER IF EXISTS minego_audit_identity_reserve ON %I.audit_logs',ns);
  EXECUTE format('DROP TRIGGER IF EXISTS minego_audit_identity_after ON %I.audit_logs',ns);
  FOR entry IN SELECT * FROM jsonb_to_recordset(current_triggers) AS t(name TEXT,definition TEXT,enabled TEXT) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.audit_logs',entry.name,ns);
    EXECUTE entry.definition;
    EXECUTE format('ALTER TABLE %I.audit_logs %s TRIGGER %I',ns,CASE entry.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END,entry.name);
  END LOOP;
  FOR entry IN SELECT conname FROM pg_constraint WHERE conrelid=state.original_oid AND contype='p' LOOP
    EXECUTE format('ALTER TABLE %I.audit_logs DROP CONSTRAINT %I',ns,entry.conname);
  END LOOP;
  EXECUTE format('ALTER TABLE %I.audit_logs ADD CONSTRAINT %I %s',ns,state.original_primary_key->>'name',state.original_primary_key->>'definition');
  EXECUTE format('DROP TABLE %I.audit_log_identity',ns);
END
$rollback$;
DROP FUNCTION minego_create_time_partition(TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ);
DROP FUNCTION minego_audit_identity_reserve();
DROP FUNCTION minego_audit_identity_after();
DROP TABLE audit_partition_conversion_state;
