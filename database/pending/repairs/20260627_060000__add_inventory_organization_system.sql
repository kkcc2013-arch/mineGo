-- REQ-00348: preserve canonical UUID inventory, species metadata and resources.
-- Apply only through the source-bound, transaction-owned migration runner.
-- deleted_at is the deletion fact; do not invent a second writable is_deleted flag.
DO $canonical$
DECLARE expected record;
BEGIN
  IF to_regclass(format('%I.users',current_schema())) IS NULL
     OR to_regclass(format('%I.pokemon_instances',current_schema())) IS NULL
     OR to_regclass(format('%I.pokemon_species',current_schema())) IS NULL
     OR to_regclass(format('%I.candy_inventory',current_schema())) IS NULL THEN
    RAISE EXCEPTION 'Inventory organization requires the canonical local V1 schema';
  END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('users','id','uuid'),('pokemon_instances','id','uuid'),
    ('pokemon_instances','user_id','uuid'),('pokemon_instances','species_id','smallint'),
    ('pokemon_instances','cp','integer'),('pokemon_instances','is_favorite','boolean'),
    ('candy_inventory','user_id','uuid'),('candy_inventory','species_id','smallint'),
    ('candy_inventory','amount','integer')
  ) AS fields(relation,name,type) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.%I',current_schema(),expected.relation))
      AND attname=expected.name AND NOT attisdropped AND format_type(atttypid,atttypmod)=expected.type) THEN
      RAISE EXCEPTION 'Inventory organization canonical %.% requires explicit adoption',expected.relation,expected.name;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='pokemon_instances'::regclass AND attname='is_deleted' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Legacy inventory is_deleted requires explicit adoption; historical deletion times must not be fabricated';
  END IF;
  IF to_regclass(format('%I.user_candies',current_schema())) IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy global user_candies requires explicit species-resource adoption';
  END IF;
END
$canonical$;

-- Preserve established favorite/nickname values, types and existing comments.
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS custom_tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS sort_priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
DO $fields$
BEGIN
  IF EXISTS(SELECT 1 FROM (VALUES('is_locked','boolean'),('custom_tags','text[]'),('sort_priority','integer'),('deleted_at','timestamp without time zone')) expected(name,type)
    LEFT JOIN pg_attribute a ON a.attrelid='pokemon_instances'::regclass AND a.attname=expected.name AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR format_type(a.atttypid,a.atttypmod)<>expected.type) THEN
    RAISE EXCEPTION 'Inventory organization field types require explicit adoption';
  END IF;
END
$fields$;

CREATE INDEX IF NOT EXISTS idx_pokemon_user_favorite ON pokemon_instances(user_id,is_favorite DESC,cp DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pokemon_user_locked ON pokemon_instances(user_id,is_locked DESC,caught_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pokemon_user_species ON pokemon_instances(user_id,species_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pokemon_user_cp ON pokemon_instances(user_id,cp DESC) WHERE deleted_at IS NULL;
-- Type/rarity belong to pokemon_species. V1 already indexes type1 and rarity.
CREATE INDEX IF NOT EXISTS idx_inventory_species_type2 ON pokemon_species(type2) WHERE type2 IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_inventory_preferences (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  primary_sort VARCHAR(50) DEFAULT 'combatPower',
  secondary_sort VARCHAR(50) DEFAULT 'rarity',
  sort_order VARCHAR(10) DEFAULT 'desc',
  default_group_by VARCHAR(50),
  custom_groups JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DO $preferences$
DECLARE fn oid; existing record; owner_att smallint; id_att smallint; user_att smallint;
BEGIN
  IF EXISTS(SELECT 1 FROM (VALUES('id','integer'),('user_id','uuid'),('primary_sort','character varying(50)'),('secondary_sort','character varying(50)'),('sort_order','character varying(10)'),('default_group_by','character varying(50)'),('custom_groups','jsonb'),('created_at','timestamp without time zone'),('updated_at','timestamp without time zone')) expected(name,type)
    LEFT JOIN pg_attribute a ON a.attrelid='user_inventory_preferences'::regclass AND a.attname=expected.name AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR format_type(a.atttypid,a.atttypmod)<>expected.type) THEN
    RAISE EXCEPTION 'Inventory preference schema requires explicit adoption';
  END IF;
  SELECT attnum INTO owner_att FROM pg_attribute WHERE attrelid='user_inventory_preferences'::regclass AND attname='user_id' AND NOT attisdropped;
  SELECT attnum INTO id_att FROM pg_attribute WHERE attrelid='user_inventory_preferences'::regclass AND attname='id' AND NOT attisdropped;
  SELECT attnum INTO user_att FROM pg_attribute WHERE attrelid='users'::regclass AND attname='id' AND NOT attisdropped;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='user_inventory_preferences'::regclass AND attnum=owner_att AND attnotnull)
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='user_inventory_preferences'::regclass AND contype='p' AND conkey=ARRAY[id_att])
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='user_inventory_preferences'::regclass AND contype IN ('u','p') AND conkey=ARRAY[owner_att])
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='user_inventory_preferences'::regclass AND contype='f' AND conkey=ARRAY[owner_att] AND confrelid='users'::regclass AND confkey=ARRAY[user_att] AND confdeltype='c' AND convalidated) THEN
    RAISE EXCEPTION 'Inventory preference ownership constraints require explicit adoption';
  END IF;
  fn:=to_regprocedure(format('%I.update_inventory_preferences_timestamp()',current_schema()));
  IF fn IS NULL THEN
    EXECUTE $ddl$CREATE FUNCTION update_inventory_preferences_timestamp() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$body$$ddl$;
    fn:=to_regprocedure(format('%I.update_inventory_preferences_timestamp()',current_schema()));
  ELSE
    SELECT p.*,l.lanname INTO existing FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=fn;
    IF existing.prorettype<>'trigger'::regtype OR existing.lanname<>'plpgsql' OR existing.prosecdef OR existing.proconfig IS NOT NULL
       OR upper(regexp_replace(existing.prosrc,'[[:space:]]','','g'))<>'BEGINNEW.UPDATED_AT=CURRENT_TIMESTAMP;RETURNNEW;END;' THEN
      RAISE EXCEPTION 'Customized inventory preference timestamp function requires explicit adoption';
    END IF;
  END IF;
  SELECT * INTO existing FROM pg_trigger WHERE tgrelid='user_inventory_preferences'::regclass AND tgname='trigger_update_inventory_preferences_timestamp' AND NOT tgisinternal;
  IF FOUND THEN
    IF existing.tgfoid<>fn OR existing.tgtype<>19 OR existing.tgnargs<>0 OR existing.tgqual IS NOT NULL OR existing.tgattr::text<>'' THEN
      RAISE EXCEPTION 'Customized inventory preference timestamp trigger requires explicit adoption';
    END IF;
    -- Preserve its OID and operator-selected enabled state.
  ELSE
    CREATE TRIGGER trigger_update_inventory_preferences_timestamp BEFORE UPDATE ON user_inventory_preferences FOR EACH ROW EXECUTE FUNCTION update_inventory_preferences_timestamp();
  END IF;
END
$preferences$;

-- Keep the earlier gym system's UUID team identity, UUID arrays and constraints.
CREATE TABLE IF NOT EXISTS battle_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pokemon_ids UUID[] NOT NULL CHECK (array_length(pokemon_ids,1)<=6),
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id,name)
);
DO $teams$
DECLARE owner_att smallint; id_att smallint; name_att smallint; user_att smallint;
BEGIN
  IF EXISTS(SELECT 1 FROM (VALUES('id','uuid'),('user_id','uuid'),('name','text'),('pokemon_ids','uuid[]'),('is_default','boolean')) expected(name,type)
    LEFT JOIN pg_attribute a ON a.attrelid='battle_teams'::regclass AND a.attname=expected.name AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR format_type(a.atttypid,a.atttypmod)<>expected.type) THEN
    RAISE EXCEPTION 'Inventory organization requires canonical UUID battle teams; explicit adoption required';
  END IF;
  SELECT attnum INTO owner_att FROM pg_attribute WHERE attrelid='battle_teams'::regclass AND attname='user_id' AND NOT attisdropped;
  SELECT attnum INTO id_att FROM pg_attribute WHERE attrelid='battle_teams'::regclass AND attname='id' AND NOT attisdropped;
  SELECT attnum INTO name_att FROM pg_attribute WHERE attrelid='battle_teams'::regclass AND attname='name' AND NOT attisdropped;
  SELECT attnum INTO user_att FROM pg_attribute WHERE attrelid='users'::regclass AND attname='id' AND NOT attisdropped;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='battle_teams'::regclass AND contype='p' AND conkey=ARRAY[id_att])
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='battle_teams'::regclass AND contype='u' AND conkey=ARRAY[owner_att,name_att])
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='battle_teams'::regclass AND contype='f' AND conkey=ARRAY[owner_att] AND confrelid='users'::regclass AND confkey=ARRAY[user_att] AND confdeltype='c' AND convalidated)
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='battle_teams'::regclass AND contype='c' AND convalidated AND upper(regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g'))='CHECK((ARRAY_LENGTH(POKEMON_IDS,1)<=6))') THEN
    RAISE EXCEPTION 'Canonical battle team ownership/size constraints require explicit adoption';
  END IF;
END
$teams$;
ALTER TABLE battle_teams ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
DO $team_time$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='battle_teams'::regclass AND attname='used_at' AND NOT attisdropped AND atttypid IN ('timestamp'::regtype,'timestamptz'::regtype)) THEN
    RAISE EXCEPTION 'Inventory team used_at requires explicit adoption';
  END IF;
END
$team_time$;
CREATE INDEX IF NOT EXISTS idx_battle_teams_user ON battle_teams(user_id);


DO $indexes$
DECLARE expected record; actual record; identity oid;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('idx_pokemon_user_favorite','pokemon_instances',ARRAY['user_id','is_favorite','cp'],'0 3 3','(deleted_at IS NULL)'),
    ('idx_pokemon_user_locked','pokemon_instances',ARRAY['user_id','is_locked','caught_at'],'0 3 3','(deleted_at IS NULL)'),
    ('idx_pokemon_user_species','pokemon_instances',ARRAY['user_id','species_id'],'0 0','(deleted_at IS NULL)'),
    ('idx_pokemon_user_cp','pokemon_instances',ARRAY['user_id','cp'],'0 3','(deleted_at IS NULL)'),
    ('idx_inventory_species_type2','pokemon_species',ARRAY['type2'],'0','(type2 IS NOT NULL)'),
    ('idx_battle_teams_user','battle_teams',ARRAY['user_id'],'0',NULL)
  ) AS indexes(name,relation,columns,options,predicate) LOOP
    identity:=to_regclass(format('%I.%I',current_schema(),expected.name));
    SELECT i.*,am.amname,pg_get_expr(i.indpred,i.indrelid) AS predicate,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.position) AS columns
      INTO actual FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE i.indexrelid=identity;
    IF NOT FOUND THEN RAISE EXCEPTION 'Inventory index % requires explicit adoption',expected.name; END IF;
    IF actual.indrelid<>to_regclass(format('%I.%I',current_schema(),expected.relation)) OR actual.amname<>'btree'
       OR actual.indisunique OR NOT actual.indisvalid OR actual.indnatts<>cardinality(expected.columns)
       OR actual.indnkeyatts<>cardinality(expected.columns) OR actual.columns<>expected.columns
       OR actual.indoption::text<>expected.options OR actual.predicate IS DISTINCT FROM expected.predicate THEN
      RAISE EXCEPTION 'Inventory index % requires explicit adoption',expected.name;
    END IF;
  END LOOP;
END
$indexes$;

-- Existing choices/IDs/sequence values stay intact; no UPDATE on conflict.
INSERT INTO user_inventory_preferences(user_id)
SELECT u.id FROM users u WHERE NOT EXISTS(SELECT 1 FROM user_inventory_preferences p WHERE p.user_id=u.id)
ON CONFLICT(user_id) DO NOTHING;
-- Candy remains the canonical (user_id,species_id) ledger; never seed global balances.
