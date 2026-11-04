-- REQ-00160: real genotype flags, current ownership counts and actual spawn time.
-- Complete original-source-bound repair; original V1 values/identities remain intact.
-- migrate:up
CREATE TABLE special_iv_storage_state(id BOOLEAN PRIMARY KEY CHECK(id),wild_oid OID NOT NULL,
  instances_oid OID NOT NULL,owned_columns JSONB NOT NULL,owns_configs BOOLEAN NOT NULL,
  configs_oid OID,inserted_config JSONB,original_triggers JSONB NOT NULL,owned_relations JSONB NOT NULL DEFAULT '{}',derived_shape JSONB,owned_functions JSONB);
DO $guard$
DECLARE wild OID:=to_regclass(format('%I.wild_pokemon',current_schema()));
        instances OID:=to_regclass(format('%I.pokemon_instances',current_schema()));t RECORD;name TEXT;invalid BOOLEAN;owned JSONB:='{}';
BEGIN
  IF wild IS NULL OR instances IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=wild AND attname='spawned_at' AND NOT attisdropped)
     OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=instances AND attname='is_lucky' AND atttypid='boolean'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Special IV storage requires canonical V1 spawn/genotype/lucky contracts';
  END IF;
  IF to_regclass(format('%I.user_special_iv_stats',current_schema())) IS NOT NULL
     OR to_regclass(format('%I.special_iv_spawn_stats',current_schema())) IS NOT NULL
     OR to_regprocedure(format('%I.minego_derive_special_iv()',current_schema())) IS NOT NULL
     OR to_regprocedure(format('%I.update_special_iv_stats()',current_schema())) IS NOT NULL THEN
    RAISE EXCEPTION 'Existing special IV storage requires an explicit data-preserving reconciliation plan';
  END IF;
  LOCK TABLE wild_pokemon,pokemon_instances IN ACCESS EXCLUSIVE MODE;
  FOR t IN SELECT * FROM (VALUES('wild_pokemon',wild),('pokemon_instances',instances)) v(name,relation) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=t.relation AND attname='id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
      RAISE EXCEPTION 'Special IV storage requires canonical UUID identity';
    END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE iv_attack NOT BETWEEN 0 AND 15 OR iv_defense NOT BETWEEN 0 AND 15 OR iv_hp NOT BETWEEN 0 AND 15)',t.name) INTO invalid;
    IF invalid THEN RAISE EXCEPTION 'Invalid existing IV values require explicit reconciliation'; END IF;
    FOREACH name IN ARRAY ARRAY['is_zero_iv','is_perfect_iv'] LOOP
      IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=t.relation AND attname=name AND NOT attisdropped) THEN
        IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=t.relation AND attname=name AND atttypid='boolean'::regtype AND NOT attisdropped) THEN RAISE EXCEPTION 'Unsupported existing special IV flag type'; END IF;
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE %I IS DISTINCT FROM (iv_attack=$1 AND iv_defense=$1 AND iv_hp=$1))',t.name,name)
          INTO invalid USING CASE WHEN name='is_zero_iv' THEN 0 ELSE 15 END;
        IF invalid THEN RAISE EXCEPTION 'Existing special IV flags contradict genotype; explicit reconciliation required'; END IF;
      ELSE owned:=owned||jsonb_build_object(t.name||'.'||name,TRUE); END IF;
    END LOOP;
  END LOOP;
  INSERT INTO special_iv_storage_state(id,wild_oid,instances_oid,owned_columns,owns_configs,configs_oid,inserted_config,original_triggers) VALUES(TRUE,wild,instances,owned,
    to_regclass(format('%I.game_configs',current_schema())) IS NULL,NULL,NULL,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',tgname,'enabled',tgenabled)) FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid WHERE g.tgrelid IN(wild,instances) AND NOT tgisinternal),'[]'));
END
$guard$;
ALTER TABLE wild_pokemon ADD COLUMN IF NOT EXISTS is_zero_iv BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_perfect_iv BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT minego_wild_iv_range CHECK(iv_attack BETWEEN 0 AND 15 AND iv_defense BETWEEN 0 AND 15 AND iv_hp BETWEEN 0 AND 15);
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS is_zero_iv BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_perfect_iv BOOLEAN NOT NULL DEFAULT FALSE;
-- Backfill only derived flags. Preserve original metadata and do not replay old events.
ALTER TABLE wild_pokemon DISABLE TRIGGER USER;
ALTER TABLE pokemon_instances DISABLE TRIGGER USER;
UPDATE wild_pokemon SET is_zero_iv=(iv_attack=0 AND iv_defense=0 AND iv_hp=0),is_perfect_iv=(iv_attack=15 AND iv_defense=15 AND iv_hp=15);
UPDATE pokemon_instances SET is_zero_iv=(iv_attack=0 AND iv_defense=0 AND iv_hp=0),is_perfect_iv=(iv_attack=15 AND iv_defense=15 AND iv_hp=15);
DO $restore$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT * FROM jsonb_to_recordset((SELECT original_triggers FROM special_iv_storage_state WHERE id=TRUE)) AS x("table" TEXT,name TEXT,enabled TEXT) LOOP
    EXECUTE format('ALTER TABLE %I %s TRIGGER %I',t."table",CASE t.enabled WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'A' THEN 'ENABLE ALWAYS' ELSE 'ENABLE' END,t.name);
  END LOOP;
END
$restore$;
CREATE FUNCTION minego_derive_special_iv() RETURNS trigger LANGUAGE plpgsql AS $derive$
BEGIN
  NEW.is_zero_iv:=NEW.iv_attack=0 AND NEW.iv_defense=0 AND NEW.iv_hp=0;
  NEW.is_perfect_iv:=NEW.iv_attack=15 AND NEW.iv_defense=15 AND NEW.iv_hp=15;
  RETURN NEW;
END
$derive$;
CREATE TRIGGER minego_derive_special_iv BEFORE INSERT OR UPDATE ON wild_pokemon FOR EACH ROW EXECUTE FUNCTION minego_derive_special_iv();
CREATE TRIGGER minego_derive_special_iv BEFORE INSERT OR UPDATE ON pokemon_instances FOR EACH ROW EXECUTE FUNCTION minego_derive_special_iv();
CREATE INDEX idx_wild_pokemon_zero_iv ON wild_pokemon(is_zero_iv) WHERE is_zero_iv;
CREATE INDEX idx_wild_pokemon_perfect_iv ON wild_pokemon(is_perfect_iv) WHERE is_perfect_iv;
CREATE INDEX idx_pokemon_instances_zero_iv ON pokemon_instances(is_zero_iv) WHERE is_zero_iv;
CREATE INDEX idx_pokemon_instances_perfect_iv ON pokemon_instances(is_perfect_iv) WHERE is_perfect_iv;
CREATE INDEX idx_pokemon_instances_lucky ON pokemon_instances(is_lucky) WHERE is_lucky;
CREATE INDEX idx_pokemon_instances_user_special ON pokemon_instances(user_id,is_zero_iv,is_perfect_iv,is_lucky);
CREATE TABLE user_special_iv_stats(user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  zero_iv_count INTEGER NOT NULL DEFAULT 0 CHECK(zero_iv_count>=0),perfect_iv_count INTEGER NOT NULL DEFAULT 0 CHECK(perfect_iv_count>=0),
  lucky_count INTEGER NOT NULL DEFAULT 0 CHECK(lucky_count>=0),last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO user_special_iv_stats(user_id,zero_iv_count,perfect_iv_count,lucky_count)
SELECT user_id,count(*) FILTER(WHERE is_zero_iv),count(*) FILTER(WHERE is_perfect_iv),count(*) FILTER(WHERE is_lucky) FROM pokemon_instances GROUP BY user_id;
CREATE FUNCTION update_special_iv_stats() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $counts$
DECLARE old_owner UUID;new_owner UUID;owner UUID;dz INTEGER;dp INTEGER;dl INTEGER;present BOOLEAN;
BEGIN
  IF TG_TABLE_NAME<>'pokemon_instances' THEN RAISE EXCEPTION 'Special IV count trigger requires its actual Pokemon table'; END IF;
  IF TG_OP<>'INSERT' THEN old_owner:=OLD.user_id; END IF;
  IF TG_OP<>'DELETE' THEN new_owner:=NEW.user_id; END IF;
  FOR owner IN SELECT DISTINCT o FROM unnest(ARRAY[old_owner,new_owner]) o WHERE o IS NOT NULL ORDER BY o LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.users WHERE id=$1)',TG_TABLE_SCHEMA) INTO present USING owner;
    IF NOT present THEN CONTINUE; END IF; -- user deletion cascades remove derived caches
    dz:=0;dp:=0;dl:=0;
    IF old_owner=owner THEN dz:=dz-OLD.is_zero_iv::integer;dp:=dp-OLD.is_perfect_iv::integer;dl:=dl-OLD.is_lucky::integer; END IF;
    IF new_owner=owner THEN dz:=dz+NEW.is_zero_iv::integer;dp:=dp+NEW.is_perfect_iv::integer;dl:=dl+NEW.is_lucky::integer; END IF;
    EXECUTE format('INSERT INTO %I.user_special_iv_stats(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',TG_TABLE_SCHEMA) USING owner;
    EXECUTE format('UPDATE %I.user_special_iv_stats SET zero_iv_count=zero_iv_count+$2,perfect_iv_count=perfect_iv_count+$3,
      lucky_count=lucky_count+$4,last_updated=NOW() WHERE user_id=$1',TG_TABLE_SCHEMA) USING owner,dz,dp,dl;
  END LOOP;
  RETURN NULL;
END
$counts$;
CREATE TRIGGER trigger_update_special_iv_stats AFTER INSERT OR UPDATE OR DELETE ON pokemon_instances FOR EACH ROW EXECUTE FUNCTION update_special_iv_stats();
CREATE MATERIALIZED VIEW special_iv_spawn_stats AS SELECT DATE(spawned_at) AS spawn_date,
  count(*) FILTER(WHERE is_zero_iv) AS zero_iv_count,count(*) FILTER(WHERE is_perfect_iv) AS perfect_iv_count,count(*) AS total_spawns,
  round(100.0*count(*) FILTER(WHERE is_zero_iv)/NULLIF(count(*),0),4) AS zero_iv_rate,
  round(100.0*count(*) FILTER(WHERE is_perfect_iv)/NULLIF(count(*),0),4) AS perfect_iv_rate FROM wild_pokemon GROUP BY DATE(spawned_at);
CREATE UNIQUE INDEX idx_special_iv_spawn_stats_date ON special_iv_spawn_stats(spawn_date);
DO $configs$
BEGIN
  IF (SELECT owns_configs FROM special_iv_storage_state WHERE id=TRUE) THEN
    EXECUTE format('CREATE TABLE %I.game_configs(key TEXT PRIMARY KEY,value TEXT NOT NULL,description TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',current_schema());
  END IF;
END
$configs$;
WITH inserted AS(INSERT INTO game_configs(key,value,description,updated_at) VALUES
  ('lucky_pokemon_chance','0.05','Lucky trade probability',NOW()),('lucky_pokemon_iv_floor','12','Lucky trade IV floor',NOW()),
  ('zero_iv_chance','0.0001','Zero IV probability',NOW()),('perfect_iv_chance','0.001','Cumulative zero/perfect threshold',NOW())
  ON CONFLICT(key) DO NOTHING RETURNING key,value,description,updated_at)
UPDATE special_iv_storage_state SET configs_oid='game_configs'::regclass,
  inserted_config=(SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY key),'[]') FROM inserted i),
  owned_relations=(SELECT jsonb_object_agg(name,to_regclass(format('%I.%I',current_schema(),name))::oid) FROM unnest(ARRAY[
    'user_special_iv_stats','special_iv_spawn_stats','idx_special_iv_spawn_stats_date','idx_wild_pokemon_zero_iv','idx_wild_pokemon_perfect_iv',
    'idx_pokemon_instances_zero_iv','idx_pokemon_instances_perfect_iv','idx_pokemon_instances_lucky','idx_pokemon_instances_user_special']) name) WHERE id=TRUE;

UPDATE special_iv_storage_state SET derived_shape=(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,
  'modifier',a.atttypmod,'required',a.attnotnull,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='user_special_iv_stats'::regclass AND a.attnum>0 AND NOT a.attisdropped),
  owned_functions=(SELECT jsonb_object_agg(oid::text,pg_get_functiondef(oid)) FROM pg_proc WHERE oid IN(
    'minego_derive_special_iv()'::regprocedure,'update_special_iv_stats()'::regprocedure)) WHERE id=TRUE;

-- migrate:down
DO $rollback$
DECLARE state RECORD;column_name TEXT;pair TEXT[];entry RECORD;
BEGIN
  SELECT * INTO STRICT state FROM special_iv_storage_state WHERE id=TRUE;
  IF 'wild_pokemon'::regclass::oid<>state.wild_oid OR 'pokemon_instances'::regclass::oid<>state.instances_oid OR 'game_configs'::regclass::oid<>state.configs_oid THEN RAISE EXCEPTION 'Special IV relation identity changed'; END IF;
  FOR entry IN SELECT key,value FROM jsonb_each_text(state.owned_relations) LOOP
    IF to_regclass(format('%I.%I',current_schema(),entry.key))::oid IS DISTINCT FROM entry.value::oid THEN RAISE EXCEPTION 'Owned special IV relation identity changed: %',entry.key; END IF;
  END LOOP;
  IF (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,'modifier',a.atttypmod,'required',a.attnotnull,
       'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid='user_special_iv_stats'::regclass AND a.attnum>0 AND NOT a.attisdropped) IS DISTINCT FROM state.derived_shape THEN
    RAISE EXCEPTION 'Derived IV cache structure changed; provide a data-preserving reverse migration';
  END IF;
  FOR entry IN SELECT key,value FROM jsonb_each_text(state.owned_functions) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=entry.key::oid AND pg_get_functiondef(oid)=entry.value) THEN
      RAISE EXCEPTION 'Owned IV function changed; provide an explicit reverse migration';
    END IF;
  END LOOP;
  LOCK TABLE wild_pokemon,pokemon_instances,game_configs IN ACCESS EXCLUSIVE MODE;
  FOR entry IN SELECT * FROM jsonb_to_recordset(state.inserted_config) AS x(key TEXT,value TEXT,description TEXT,updated_at TIMESTAMPTZ) LOOP
    IF NOT EXISTS(SELECT 1 FROM game_configs WHERE key=entry.key AND value=entry.value AND description IS NOT DISTINCT FROM entry.description AND updated_at=entry.updated_at) THEN
      RAISE EXCEPTION 'Special IV configuration changed; provide a data-preserving reverse migration';
    END IF;
  END LOOP;
  IF state.owns_configs AND (SELECT count(*) FROM game_configs)<>jsonb_array_length(state.inserted_config) THEN RAISE EXCEPTION 'Additional game configuration requires a data-preserving reverse migration'; END IF;
  DROP TRIGGER trigger_update_special_iv_stats ON pokemon_instances;
  DROP TRIGGER minego_derive_special_iv ON pokemon_instances;
  DROP TRIGGER minego_derive_special_iv ON wild_pokemon;
  DROP MATERIALIZED VIEW special_iv_spawn_stats;
  DROP TABLE user_special_iv_stats;
  DROP INDEX idx_wild_pokemon_zero_iv,idx_wild_pokemon_perfect_iv,idx_pokemon_instances_zero_iv,
    idx_pokemon_instances_perfect_iv,idx_pokemon_instances_lucky,idx_pokemon_instances_user_special;
  ALTER TABLE wild_pokemon DROP CONSTRAINT minego_wild_iv_range;
  FOR column_name IN SELECT jsonb_object_keys(state.owned_columns) LOOP
    pair:=string_to_array(column_name,'.');EXECUTE format('ALTER TABLE %I DROP COLUMN %I',pair[1],pair[2]);
  END LOOP;
  DELETE FROM game_configs WHERE key IN(SELECT key FROM jsonb_to_recordset(state.inserted_config) AS x(key TEXT));
  IF state.owns_configs THEN DROP TABLE game_configs; END IF;
END
$rollback$;
DROP FUNCTION update_special_iv_stats();
DROP FUNCTION minego_derive_special_iv();
DROP TABLE special_iv_storage_state;
