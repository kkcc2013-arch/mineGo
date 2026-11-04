-- REQ-00479 / REQ-00523: canonical, bounded, transactional cache invalidation.
-- Notifications contain only an opaque event UUID; sensitive/full rows never leave storage.
-- Pending work survives listener/Redis outages and transaction rollback follows the source write.
DO $function_contract$
DECLARE body text:='
SELECT jsonb_typeof(payload)=''object''
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(payload) AS item(key,value)
 WHERE key<>ALL(ARRAY[''achievement_id'',''gym_id'',''id'',''initiator_id'',''item_id'',''offered_pokemon'',''pokemon_id'',''raid_id'',''received_pokemon'',''receiver_id'',''sender_id'',''species_id'',''user_a'',''user_b'',''user_id''])
 OR jsonb_typeof(value) NOT IN(''string'',''null'') OR length(value#>>''{}'')>128)
'; identity oid; previous record;
BEGIN
  identity:=to_regprocedure(format('%I.minego_cache_keys_valid(jsonb)',current_schema()));
  IF identity IS NULL THEN
    EXECUTE format('CREATE FUNCTION %I.minego_cache_keys_valid(payload jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS %L',current_schema(),body);
  ELSE
    SELECT p.prosrc,p.prorettype,p.prosecdef,p.proconfig,p.provolatile,l.lanname INTO previous FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=identity;
    IF previous.prosrc IS DISTINCT FROM body OR previous.prorettype<>'boolean'::regtype OR previous.prosecdef OR previous.proconfig IS NOT NULL OR previous.provolatile<>'i' OR previous.lanname<>'sql' THEN
      RAISE EXCEPTION 'Customized cache function minego_cache_keys_valid requires explicit adoption';
    END IF;
  END IF;
END
$function_contract$;

DO $function_contract$
DECLARE body text:='
DECLARE projection text; new_ids jsonb:=''{}''::jsonb; old_ids jsonb:=''{}''::jsonb; event uuid; parent_name text:=TG_ARGV[0]; fields text[]:=TG_ARGV[1]::text[];
BEGIN
  -- Project only approved identity columns. Never serialize entire NEW/OLD rows.
  SELECT ''jsonb_build_object(''||string_agg(format(''%L,($1).%I::text'',field,field),'','')||'')'' INTO projection FROM unnest(fields) AS keys(field);
  IF TG_OP<>''DELETE'' THEN EXECUTE ''SELECT ''||projection INTO new_ids USING NEW; END IF;
  IF TG_OP<>''INSERT'' THEN EXECUTE ''SELECT ''||projection INTO old_ids USING OLD; END IF;
  EXECUTE format(''INSERT INTO %I.cache_invalidation_outbox(table_name,operation,new_keys,old_keys) VALUES($1,$2,$3,$4) RETURNING event_id'',TG_TABLE_SCHEMA)
    INTO event USING parent_name,lower(TG_OP),new_ids,old_ids;
  -- Commit-coupled hint only. Durable work stays in the transactional outbox.
  PERFORM pg_notify(''minego_cache_''||md5(TG_TABLE_SCHEMA),event::text);
  RETURN NULL;
END;
'; identity oid; previous record;
BEGIN
  identity:=to_regprocedure(format('%I.minego_capture_cache_change()',current_schema()));
  IF identity IS NULL THEN
    EXECUTE format('CREATE FUNCTION %I.minego_capture_cache_change() RETURNS trigger LANGUAGE plpgsql VOLATILE AS %L',current_schema(),body);
  ELSE
    SELECT p.prosrc,p.prorettype,p.prosecdef,p.proconfig,p.provolatile,l.lanname INTO previous FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=identity;
    IF previous.prosrc IS DISTINCT FROM body OR previous.prorettype<>'trigger'::regtype OR previous.prosecdef OR previous.proconfig IS NOT NULL OR previous.provolatile<>'v' OR previous.lanname<>'plpgsql' THEN
      RAISE EXCEPTION 'Customized cache function minego_capture_cache_change requires explicit adoption';
    END IF;
  END IF;
END
$function_contract$;

CREATE TABLE IF NOT EXISTS cache_invalidation_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL CHECK(table_name IN('users','pokemon_species','pokemon_instances','candy_inventory','pokedex_entries','catch_records','gyms','gym_defenders','raids','raid_participants','friendships','friend_gifts','pokemon_trades','items','player_inventory','daily_quests','user_achievements','orders')),
  operation TEXT NOT NULL CHECK(operation IN('insert','update','delete')),
  new_keys JSONB NOT NULL CHECK(minego_cache_keys_valid(new_keys) IS TRUE),
  old_keys JSONB NOT NULL CHECK(minego_cache_keys_valid(old_keys) IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_error_code VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS cache_invalidation_outbox_ready ON cache_invalidation_outbox(available_at,created_at);

DO $outbox_contract$
DECLARE expected record; actual_columns jsonb; expected_columns jsonb; actual_constraints text[]; expected_constraints text[];
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('event_id','uuid'),('table_name','text'),('operation','text'),('new_keys','jsonb'),('old_keys','jsonb'),
    ('created_at','timestamp with time zone'),('available_at','timestamp with time zone'),('attempts','integer'),('last_error_code','character varying(64)')
  ) AS fields(name,type) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.cache_invalidation_outbox',current_schema())) AND attname=expected.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=expected.type) THEN RAISE EXCEPTION 'Cache outbox %.% requires explicit adoption','cache_invalidation_outbox',expected.name; END IF;
  END LOOP;

  IF to_regclass('pg_temp.minego_cache_expected_outbox') IS NOT NULL THEN RAISE EXCEPTION 'Cache contract probe already exists'; END IF;
  EXECUTE 'CREATE TEMP TABLE minego_cache_expected_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL CHECK(table_name IN(''users'',''pokemon_species'',''pokemon_instances'',''candy_inventory'',''pokedex_entries'',''catch_records'',''gyms'',''gym_defenders'',''raids'',''raid_participants'',''friendships'',''friend_gifts'',''pokemon_trades'',''items'',''player_inventory'',''daily_quests'',''user_achievements'',''orders'')),
  operation TEXT NOT NULL CHECK(operation IN(''insert'',''update'',''delete'')),
  new_keys JSONB NOT NULL CHECK(minego_cache_keys_valid(new_keys) IS TRUE),
  old_keys JSONB NOT NULL CHECK(minego_cache_keys_valid(old_keys) IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_error_code VARCHAR(64)
);';
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO actual_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='cache_invalidation_outbox'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO expected_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='pg_temp.minego_cache_expected_outbox'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO actual_constraints FROM pg_constraint WHERE conrelid='cache_invalidation_outbox'::regclass;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO expected_constraints FROM pg_constraint WHERE conrelid='pg_temp.minego_cache_expected_outbox'::regclass;
  IF actual_columns IS DISTINCT FROM expected_columns OR actual_constraints IS DISTINCT FROM expected_constraints THEN RAISE EXCEPTION 'Customized cache outbox contract requires explicit adoption'; END IF;
  DROP TABLE pg_temp.minego_cache_expected_outbox;
END
$outbox_contract$;

DO $capture_contract$
DECLARE expected record; relation_id oid; function_id oid; previous record; fields text[]; field text; expected_args bytea; expected_type oid;
BEGIN
  function_id:=to_regprocedure(format('%I.minego_capture_cache_change()',current_schema()));
  FOR expected IN SELECT * FROM (VALUES
    ('users','{id}'),
    ('pokemon_species','{id}'),
    ('pokemon_instances','{id,user_id,species_id}'),
    ('candy_inventory','{user_id,species_id}'),
    ('pokedex_entries','{user_id,species_id}'),
    ('catch_records','{id,user_id}'),
    ('gyms','{id}'),
    ('gym_defenders','{id,gym_id,user_id,pokemon_id}'),
    ('raids','{id,gym_id}'),
    ('raid_participants','{id,raid_id,user_id}'),
    ('friendships','{id,user_a,user_b}'),
    ('friend_gifts','{id,sender_id,receiver_id}'),
    ('pokemon_trades','{id,initiator_id,receiver_id,offered_pokemon,received_pokemon}'),
    ('items','{id,item_id}'),
    ('player_inventory','{id,user_id,item_id}'),
    ('daily_quests','{id,user_id}'),
    ('user_achievements','{user_id,achievement_id}'),
    ('orders','{id,user_id}')
  ) AS resources(name,keys) LOOP
    relation_id:=to_regclass(format('%I.%I',current_schema(),expected.name));
    IF relation_id IS NULL THEN RAISE EXCEPTION 'Canonical cache source is missing: %',expected.name; END IF;
    fields:=expected.keys::text[];
    FOREACH field IN ARRAY fields LOOP
      expected_type:=CASE WHEN field='species_id' OR (expected.name='pokemon_species' AND field='id') THEN 'int2'::regtype
        WHEN (expected.name='items' AND field IN('id','item_id')) OR field IN('item_id','achievement_id') THEN 'varchar'::regtype
        WHEN expected.name='player_inventory' AND field='id' THEN 'int8'::regtype ELSE 'uuid'::regtype END;
      IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation_id AND attname=field AND attnum>0 AND NOT attisdropped AND atttypid=expected_type) THEN RAISE EXCEPTION 'Canonical cache %.% identity requires explicit adoption',expected.name,field; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation_id AND NOT tgisinternal AND tgfoid=to_regprocedure(format('%I.notify_cache_invalidation()',current_schema()))) THEN
      RAISE EXCEPTION 'Active legacy cache notifications require explicit adoption: %',expected.name;
    END IF;
    expected_args:=convert_to(expected.name,'UTF8')||decode('00','hex')||convert_to(expected.keys,'UTF8')||decode('00','hex');
    SELECT * INTO previous FROM pg_trigger WHERE tgrelid=relation_id AND tgname='minego_cache_cdc_'||expected.name AND NOT tgisinternal;
    IF FOUND THEN
      IF previous.tgfoid<>function_id OR previous.tgtype<>29 OR previous.tgenabled<>'O' OR previous.tgnargs<>2 OR previous.tgargs<>expected_args OR previous.tgqual IS NOT NULL OR previous.tgattr::text<>'' OR previous.tgdeferrable THEN RAISE EXCEPTION 'Customized cache trigger requires explicit adoption: %',expected.name; END IF;
    ELSE
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.minego_capture_cache_change(%L,%L)','minego_cache_cdc_'||expected.name,current_schema(),expected.name,current_schema(),expected.name,expected.keys);
    END IF;
  END LOOP;
END
$capture_contract$;

-- Persist only validated operator overrides; built-in safe mappings stay in YAML.
CREATE TABLE IF NOT EXISTS cache_invalidation_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
DO $settings_contract$
DECLARE actual_columns jsonb; expected_columns jsonb; actual_constraints text[]; expected_constraints text[];
BEGIN
  IF to_regclass('pg_temp.minego_cache_expected_settings') IS NOT NULL THEN RAISE EXCEPTION 'Cache settings probe already exists'; END IF;
  EXECUTE 'CREATE TEMP TABLE minego_cache_expected_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    document JSONB NOT NULL CHECK(jsonb_typeof(document)=''object''),
    revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )';
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO actual_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='cache_invalidation_settings'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO expected_columns FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='pg_temp.minego_cache_expected_settings'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO actual_constraints FROM pg_constraint WHERE conrelid='cache_invalidation_settings'::regclass;
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO expected_constraints FROM pg_constraint WHERE conrelid='pg_temp.minego_cache_expected_settings'::regclass;
  IF actual_columns IS DISTINCT FROM expected_columns OR actual_constraints IS DISTINCT FROM expected_constraints THEN RAISE EXCEPTION 'Customized cache settings contract requires explicit adoption'; END IF;
  DROP TABLE pg_temp.minego_cache_expected_settings;
END
$settings_contract$;
