-- REQ-00060 / REQ-00626: use the actual canonical parents and real operational evidence.
-- Preserve partition_stats and every dependent view/column/OID; do not replace its contract.
-- Existing archive/delete automation needs durable verified archives and explicit retention policy.
-- This migration provisions creation/stats/health; it never schedules deletion or fabricates archives.
DO $prerequisites$
DECLARE name text; parent oid;
BEGIN
  IF to_regprocedure(format('%I.minego_create_time_partition(text,text,timestamptz,timestamptz)',current_schema())) IS NULL THEN RAISE EXCEPTION 'Guarded partition creation prerequisite required'; END IF;
  FOREACH name IN ARRAY ARRAY['catch_records','location_updates','audit_logs','event_logs','payment_transactions'] LOOP
    parent:=to_regclass(format('%I.%I',current_schema(),name));
    IF NOT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_attribute a ON a.attrelid=p.partrelid AND a.attnum=p.partattrs[0] WHERE p.partrelid=parent AND p.partstrat='r' AND p.partnatts=1 AND a.attname='created_at') THEN RAISE EXCEPTION 'Canonical created_at range parent required: %',name; END IF;
    IF to_regclass(format('%I.%I',current_schema(),name||'_partitioned')) IS NOT NULL THEN RAISE EXCEPTION 'Existing shadow partition layout requires explicit adoption: %',name; END IF;
  END LOOP;
END
$prerequisites$;

DO $owned$
DECLARE identity oid; expected_oid oid; actual record; expected record;
BEGIN
  IF to_regprocedure('pg_temp.minego_partition_expected(text)') IS NOT NULL THEN RAISE EXCEPTION 'Partition function probe name already exists'; END IF;
  EXECUTE replace('CREATE FUNCTION minego_partition_children(p_parent text) RETURNS TABLE(partition_name text,relation_oid oid,partition_bound text,start_at timestamptz,end_at timestamptz,is_default boolean) LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE parent_oid oid; item record; dates text[];
BEGIN
  IF p_parent IS NULL OR p_parent<>ALL(ARRAY[''catch_records'',''location_updates'',''audit_logs'',''event_logs'',''payment_transactions'']) THEN RAISE EXCEPTION ''Unknown managed partition parent''; END IF;
  parent_oid:=to_regclass(format(''%I.%I'',current_schema(),p_parent));
  IF NOT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_attribute a ON a.attrelid=p.partrelid AND a.attnum=p.partattrs[0] WHERE p.partrelid=parent_oid AND p.partstrat=''r'' AND p.partnatts=1 AND a.attname=''created_at'' AND a.atttypid IN(''timestamp''::regtype,''timestamptz''::regtype)) THEN RAISE EXCEPTION ''Canonical created_at range parent required: %'',p_parent; END IF;
  FOR item IN SELECT c.oid,c.relname,pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=parent_oid ORDER BY c.relname LOOP
    partition_name:=item.relname;relation_oid:=item.oid;partition_bound:=item.bound;is_default:=item.bound=''DEFAULT'';start_at:=NULL;end_at:=NULL;
    IF NOT is_default THEN
      dates:=regexp_match(item.bound,$range$FROM \(''([^'']+)''\) TO \(''([^'']+)''\)$range$);
      IF dates IS NULL THEN RAISE EXCEPTION ''Unsupported managed partition bounds: %'',item.relname; END IF;
      start_at:=dates[1]::timestamptz;end_at:=dates[2]::timestamptz;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$body$','CREATE FUNCTION minego_partition_children(','CREATE FUNCTION pg_temp.minego_partition_expected(');
  expected_oid:=to_regprocedure('pg_temp.minego_partition_expected(text)');
  identity:=to_regprocedure(format('%I.minego_partition_children(text)',current_schema()));
  IF identity IS NULL THEN EXECUTE 'CREATE FUNCTION minego_partition_children(p_parent text) RETURNS TABLE(partition_name text,relation_oid oid,partition_bound text,start_at timestamptz,end_at timestamptz,is_default boolean) LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE parent_oid oid; item record; dates text[];
BEGIN
  IF p_parent IS NULL OR p_parent<>ALL(ARRAY[''catch_records'',''location_updates'',''audit_logs'',''event_logs'',''payment_transactions'']) THEN RAISE EXCEPTION ''Unknown managed partition parent''; END IF;
  parent_oid:=to_regclass(format(''%I.%I'',current_schema(),p_parent));
  IF NOT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_attribute a ON a.attrelid=p.partrelid AND a.attnum=p.partattrs[0] WHERE p.partrelid=parent_oid AND p.partstrat=''r'' AND p.partnatts=1 AND a.attname=''created_at'' AND a.atttypid IN(''timestamp''::regtype,''timestamptz''::regtype)) THEN RAISE EXCEPTION ''Canonical created_at range parent required: %'',p_parent; END IF;
  FOR item IN SELECT c.oid,c.relname,pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=parent_oid ORDER BY c.relname LOOP
    partition_name:=item.relname;relation_oid:=item.oid;partition_bound:=item.bound;is_default:=item.bound=''DEFAULT'';start_at:=NULL;end_at:=NULL;
    IF NOT is_default THEN
      dates:=regexp_match(item.bound,$range$FROM \(''([^'']+)''\) TO \(''([^'']+)''\)$range$);
      IF dates IS NULL THEN RAISE EXCEPTION ''Unsupported managed partition bounds: %'',item.relname; END IF;
      start_at:=dates[1]::timestamptz;end_at:=dates[2]::timestamptz;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$body$';
  ELSE
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO actual FROM pg_proc WHERE oid=identity;
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO expected FROM pg_proc WHERE oid=expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Customized partition function minego_partition_children requires explicit adoption'; END IF;
  END IF;
  DROP FUNCTION pg_temp.minego_partition_expected(text);
END
$owned$;

DO $owned$
DECLARE identity oid; expected_oid oid; actual record; expected record;
BEGIN
  IF to_regprocedure('pg_temp.minego_partition_expected(text,integer,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'Partition function probe name already exists'; END IF;
  EXECUTE replace('CREATE FUNCTION minego_partition_plan(p_parent text,p_months integer DEFAULT 3,p_reference timestamptz DEFAULT CURRENT_TIMESTAMP) RETURNS TABLE(partition_name text,start_at timestamptz,end_at timestamptz) LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE cursor_at timestamptz; horizon timestamptz; step interval;
BEGIN
  PERFORM * FROM minego_partition_children(p_parent);
  IF p_months IS NULL OR p_months<1 OR p_months>12 OR p_reference IS NULL OR NOT isfinite(p_reference) THEN RAISE EXCEPTION ''Partition horizon requires 1..12 months and finite reference''; END IF;
  horizon:=date_trunc(''month'',p_reference)+make_interval(months=>p_months+1);
  IF p_parent=''location_updates'' THEN cursor_at:=date_trunc(''day'',p_reference);step:=INTERVAL ''1 day'';
  ELSIF p_parent=''event_logs'' THEN cursor_at:=date_bin(INTERVAL ''7 days'',p_reference,TIMESTAMPTZ ''2026-06-02 00:00:00+00'');step:=INTERVAL ''7 days'';
  ELSE cursor_at:=date_trunc(''month'',p_reference);step:=INTERVAL ''1 month''; END IF;
  WHILE cursor_at<horizon LOOP
    partition_name:=p_parent||''_''||to_char(cursor_at,CASE WHEN p_parent IN(''event_logs'',''location_updates'') THEN ''YYYY_MM_DD'' ELSE ''YYYY_MM'' END);
    start_at:=cursor_at;end_at:=cursor_at+step;RETURN NEXT;cursor_at:=cursor_at+step;
  END LOOP;
END;
$body$','CREATE FUNCTION minego_partition_plan(','CREATE FUNCTION pg_temp.minego_partition_expected(');
  expected_oid:=to_regprocedure('pg_temp.minego_partition_expected(text,integer,timestamptz)');
  identity:=to_regprocedure(format('%I.minego_partition_plan(text,integer,timestamptz)',current_schema()));
  IF identity IS NULL THEN EXECUTE 'CREATE FUNCTION minego_partition_plan(p_parent text,p_months integer DEFAULT 3,p_reference timestamptz DEFAULT CURRENT_TIMESTAMP) RETURNS TABLE(partition_name text,start_at timestamptz,end_at timestamptz) LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE cursor_at timestamptz; horizon timestamptz; step interval;
BEGIN
  PERFORM * FROM minego_partition_children(p_parent);
  IF p_months IS NULL OR p_months<1 OR p_months>12 OR p_reference IS NULL OR NOT isfinite(p_reference) THEN RAISE EXCEPTION ''Partition horizon requires 1..12 months and finite reference''; END IF;
  horizon:=date_trunc(''month'',p_reference)+make_interval(months=>p_months+1);
  IF p_parent=''location_updates'' THEN cursor_at:=date_trunc(''day'',p_reference);step:=INTERVAL ''1 day'';
  ELSIF p_parent=''event_logs'' THEN cursor_at:=date_bin(INTERVAL ''7 days'',p_reference,TIMESTAMPTZ ''2026-06-02 00:00:00+00'');step:=INTERVAL ''7 days'';
  ELSE cursor_at:=date_trunc(''month'',p_reference);step:=INTERVAL ''1 month''; END IF;
  WHILE cursor_at<horizon LOOP
    partition_name:=p_parent||''_''||to_char(cursor_at,CASE WHEN p_parent IN(''event_logs'',''location_updates'') THEN ''YYYY_MM_DD'' ELSE ''YYYY_MM'' END);
    start_at:=cursor_at;end_at:=cursor_at+step;RETURN NEXT;cursor_at:=cursor_at+step;
  END LOOP;
END;
$body$';
  ELSE
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO actual FROM pg_proc WHERE oid=identity;
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO expected FROM pg_proc WHERE oid=expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Customized partition function minego_partition_plan requires explicit adoption'; END IF;
  END IF;
  DROP FUNCTION pg_temp.minego_partition_expected(text,integer,timestamptz);
END
$owned$;

DO $owned$
DECLARE identity oid; expected_oid oid; actual record; expected record;
BEGIN
  IF to_regprocedure('pg_temp.minego_partition_expected(text,integer,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'Partition function probe name already exists'; END IF;
  EXECUTE replace('CREATE FUNCTION minego_ensure_partition_horizon(p_parent text,p_months integer DEFAULT 3,p_reference timestamptz DEFAULT CURRENT_TIMESTAMP) RETURNS text[] LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE item record; created text[]:=ARRAY[]::text[]; namespace text:=current_schema();
BEGIN
  PERFORM * FROM minego_partition_children(p_parent);
  EXECUTE format(''LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE'',namespace,p_parent);
  FOR item IN SELECT * FROM minego_partition_plan(p_parent,p_months,p_reference) LOOP
    IF EXISTS(SELECT 1 FROM minego_partition_children(p_parent) c WHERE c.start_at=item.start_at AND c.end_at=item.end_at) THEN CONTINUE; END IF;
    IF minego_create_time_partition(p_parent,item.partition_name,item.start_at,item.end_at) THEN created:=array_append(created,item.partition_name); END IF;
    IF NOT EXISTS(SELECT 1 FROM minego_partition_children(p_parent) c WHERE c.start_at=item.start_at AND c.end_at=item.end_at) THEN RAISE EXCEPTION ''Partition creator did not produce expected bounds''; END IF;
  END LOOP;
  RETURN created;
END;
$body$','CREATE FUNCTION minego_ensure_partition_horizon(','CREATE FUNCTION pg_temp.minego_partition_expected(');
  expected_oid:=to_regprocedure('pg_temp.minego_partition_expected(text,integer,timestamptz)');
  identity:=to_regprocedure(format('%I.minego_ensure_partition_horizon(text,integer,timestamptz)',current_schema()));
  IF identity IS NULL THEN EXECUTE 'CREATE FUNCTION minego_ensure_partition_horizon(p_parent text,p_months integer DEFAULT 3,p_reference timestamptz DEFAULT CURRENT_TIMESTAMP) RETURNS text[] LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE item record; created text[]:=ARRAY[]::text[]; namespace text:=current_schema();
BEGIN
  PERFORM * FROM minego_partition_children(p_parent);
  EXECUTE format(''LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE'',namespace,p_parent);
  FOR item IN SELECT * FROM minego_partition_plan(p_parent,p_months,p_reference) LOOP
    IF EXISTS(SELECT 1 FROM minego_partition_children(p_parent) c WHERE c.start_at=item.start_at AND c.end_at=item.end_at) THEN CONTINUE; END IF;
    IF minego_create_time_partition(p_parent,item.partition_name,item.start_at,item.end_at) THEN created:=array_append(created,item.partition_name); END IF;
    IF NOT EXISTS(SELECT 1 FROM minego_partition_children(p_parent) c WHERE c.start_at=item.start_at AND c.end_at=item.end_at) THEN RAISE EXCEPTION ''Partition creator did not produce expected bounds''; END IF;
  END LOOP;
  RETURN created;
END;
$body$';
  ELSE
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO actual FROM pg_proc WHERE oid=identity;
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO expected FROM pg_proc WHERE oid=expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Customized partition function minego_ensure_partition_horizon requires explicit adoption'; END IF;
  END IF;
  DROP FUNCTION pg_temp.minego_partition_expected(text,integer,timestamptz);
END
$owned$;

DO $owned$
DECLARE identity oid; expected_oid oid; actual record; expected record;
BEGIN
  IF to_regprocedure('pg_temp.minego_partition_expected(text)') IS NOT NULL THEN RAISE EXCEPTION 'Partition function probe name already exists'; END IF;
  EXECUTE replace('CREATE FUNCTION minego_partition_live_stats(p_parent text) RETURNS TABLE(partition_name text,partition_bound text,is_default boolean,row_count bigint,size_bytes bigint,estimated_rows bigint,start_at timestamptz,end_at timestamptz) LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM minego_partition_children(p_parent) LOOP
    partition_name:=item.partition_name;partition_bound:=item.partition_bound;is_default:=item.is_default;start_at:=item.start_at;end_at:=item.end_at;
    EXECUTE format(''SELECT count(*) FROM %I.%I'',current_schema(),item.partition_name) INTO row_count;
    SELECT pg_total_relation_size(c.oid),c.reltuples::bigint INTO size_bytes,estimated_rows FROM pg_class c WHERE c.oid=item.relation_oid;
    RETURN NEXT;
  END LOOP;
END;
$body$','CREATE FUNCTION minego_partition_live_stats(','CREATE FUNCTION pg_temp.minego_partition_expected(');
  expected_oid:=to_regprocedure('pg_temp.minego_partition_expected(text)');
  identity:=to_regprocedure(format('%I.minego_partition_live_stats(text)',current_schema()));
  IF identity IS NULL THEN EXECUTE 'CREATE FUNCTION minego_partition_live_stats(p_parent text) RETURNS TABLE(partition_name text,partition_bound text,is_default boolean,row_count bigint,size_bytes bigint,estimated_rows bigint,start_at timestamptz,end_at timestamptz) LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM minego_partition_children(p_parent) LOOP
    partition_name:=item.partition_name;partition_bound:=item.partition_bound;is_default:=item.is_default;start_at:=item.start_at;end_at:=item.end_at;
    EXECUTE format(''SELECT count(*) FROM %I.%I'',current_schema(),item.partition_name) INTO row_count;
    SELECT pg_total_relation_size(c.oid),c.reltuples::bigint INTO size_bytes,estimated_rows FROM pg_class c WHERE c.oid=item.relation_oid;
    RETURN NEXT;
  END LOOP;
END;
$body$';
  ELSE
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO actual FROM pg_proc WHERE oid=identity;
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO expected FROM pg_proc WHERE oid=expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Customized partition function minego_partition_live_stats requires explicit adoption'; END IF;
  END IF;
  DROP FUNCTION pg_temp.minego_partition_expected(text);
END
$owned$;

DO $owned$
DECLARE identity oid; expected_oid oid; actual record; expected record;
BEGIN
  IF to_regprocedure('pg_temp.minego_partition_expected(text,integer,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'Partition function probe name already exists'; END IF;
  EXECUTE replace('CREATE FUNCTION minego_partition_live_health(p_parent text,p_months integer DEFAULT 3,p_reference timestamptz DEFAULT CURRENT_TIMESTAMP) RETURNS jsonb LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE missing integer; default_rows bigint:=0; item record;
BEGIN
  SELECT count(*) INTO missing FROM minego_partition_plan(p_parent,p_months,p_reference) p WHERE NOT EXISTS(SELECT 1 FROM minego_partition_children(p_parent) c WHERE c.start_at=p.start_at AND c.end_at=p.end_at);
  FOR item IN SELECT * FROM minego_partition_children(p_parent) WHERE is_default LOOP
    EXECUTE format(''SELECT count(*) FROM %I.%I'',current_schema(),item.partition_name) INTO default_rows;
  END LOOP;
  RETURN jsonb_build_object(''schema'',current_schema(),''table'',p_parent,''missingRanges'',missing,''defaultRows'',default_rows::text,''status'',CASE WHEN missing>0 THEN ''needs_partitions'' WHEN default_rows>0 THEN ''warning_default_rows'' ELSE ''healthy'' END,''checkedAt'',CURRENT_TIMESTAMP);
END;
$body$','CREATE FUNCTION minego_partition_live_health(','CREATE FUNCTION pg_temp.minego_partition_expected(');
  expected_oid:=to_regprocedure('pg_temp.minego_partition_expected(text,integer,timestamptz)');
  identity:=to_regprocedure(format('%I.minego_partition_live_health(text,integer,timestamptz)',current_schema()));
  IF identity IS NULL THEN EXECUTE 'CREATE FUNCTION minego_partition_live_health(p_parent text,p_months integer DEFAULT 3,p_reference timestamptz DEFAULT CURRENT_TIMESTAMP) RETURNS jsonb LANGUAGE plpgsql SET TimeZone=''UTC'' AS $body$
DECLARE missing integer; default_rows bigint:=0; item record;
BEGIN
  SELECT count(*) INTO missing FROM minego_partition_plan(p_parent,p_months,p_reference) p WHERE NOT EXISTS(SELECT 1 FROM minego_partition_children(p_parent) c WHERE c.start_at=p.start_at AND c.end_at=p.end_at);
  FOR item IN SELECT * FROM minego_partition_children(p_parent) WHERE is_default LOOP
    EXECUTE format(''SELECT count(*) FROM %I.%I'',current_schema(),item.partition_name) INTO default_rows;
  END LOOP;
  RETURN jsonb_build_object(''schema'',current_schema(),''table'',p_parent,''missingRanges'',missing,''defaultRows'',default_rows::text,''status'',CASE WHEN missing>0 THEN ''needs_partitions'' WHEN default_rows>0 THEN ''warning_default_rows'' ELSE ''healthy'' END,''checkedAt'',CURRENT_TIMESTAMP);
END;
$body$';
  ELSE
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO actual FROM pg_proc WHERE oid=identity;
    SELECT prosrc,prorettype,proretset,proallargtypes,proargmodes,proargnames,pg_get_expr(proargdefaults,0),proconfig,prolang,prosecdef,provolatile INTO expected FROM pg_proc WHERE oid=expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Customized partition function minego_partition_live_health requires explicit adoption'; END IF;
  END IF;
  DROP FUNCTION pg_temp.minego_partition_expected(text,integer,timestamptz);
END
$owned$;

DO $initial_horizon$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['catch_records','location_updates','audit_logs','event_logs','payment_transactions'] LOOP
    PERFORM minego_ensure_partition_horizon(name,3);
  END LOOP;
END
$initial_horizon$;
