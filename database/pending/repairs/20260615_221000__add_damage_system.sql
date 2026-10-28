-- REQ-00146: canonical move identity/energy projections and retained proposed defaults.
-- Preserve canonical learning/gameplay values instead of overwriting them with a different schema.
-- migrate:up
LOCK TABLE moves IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF (SELECT relnamespace FROM pg_class WHERE oid='moves'::regclass) <> current_schema()::regnamespace
    OR (SELECT relkind FROM pg_class WHERE oid='moves'::regclass)<>'r' THEN
    RAISE EXCEPTION 'Damage catalog requires canonical moves in the migration schema';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='energy_delta' AND atttypid='integer'::regtype AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='name_en' AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='category' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Unsupported moves identity/energy contract; explicit mapping required';
  END IF;
  IF to_regclass(format('%I.damage_move_defaults',current_schema())) IS NOT NULL
    OR to_regclass(format('%I.damage_catalog_state',current_schema())) IS NOT NULL THEN
    RAISE EXCEPTION 'Existing damage defaults/state require explicit adoption';
  END IF;
END;
$guard$;
CREATE TABLE damage_catalog_state(id boolean PRIMARY KEY CHECK(id),moves_oid oid NOT NULL,
  owns_name boolean NOT NULL,owns_cost boolean NOT NULL,name_definition text,cost_definition text,
  profiles_oid oid,profiles_snapshot jsonb,index_oid oid,index_definition text);
DO $aliases$
DECLARE owns_name boolean:=false; owns_cost boolean:=false; expr text; kind "char";
BEGIN
  SELECT attgenerated INTO kind FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='name' AND NOT attisdropped;
  IF FOUND THEN
    SELECT pg_get_expr(adbin,adrelid) INTO expr FROM pg_attrdef WHERE adrelid='moves'::regclass AND adnum=(SELECT attnum FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='name' AND NOT attisdropped);
    IF kind<>'s' OR expr IS DISTINCT FROM 'lower((id)::text)' THEN RAISE EXCEPTION 'Unsupported existing moves.name; refusing overwrite'; END IF;
  ELSE
    ALTER TABLE moves ADD COLUMN name text GENERATED ALWAYS AS(lower(id)) STORED;
    COMMENT ON COLUMN moves.name IS 'minego:damage-catalog:name:v1';owns_name:=true;
  END IF;
  SELECT attgenerated INTO kind FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='energy_cost' AND NOT attisdropped;
  IF FOUND THEN
    SELECT pg_get_expr(adbin,adrelid) INTO expr FROM pg_attrdef WHERE adrelid='moves'::regclass AND adnum=(SELECT attnum FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='energy_cost' AND NOT attisdropped);
    IF kind<>'s' OR regexp_replace(expr,'[[:space:]()]','','g') IS DISTINCT FROM 'GREATEST0::bigint,-energy_delta::bigint' THEN RAISE EXCEPTION 'Unsupported existing moves.energy_cost; refusing overwrite'; END IF;
  ELSE
    ALTER TABLE moves ADD COLUMN energy_cost bigint GENERATED ALWAYS AS(GREATEST(0::bigint,-energy_delta::bigint)) STORED;
    COMMENT ON COLUMN moves.energy_cost IS 'minego:damage-catalog:energy:v1';owns_cost:=true;
  END IF;
  -- A name projection must resolve one actual identity, never an ambiguous alias.
  CREATE UNIQUE INDEX damage_catalog_name_identity ON moves(name);
  INSERT INTO damage_catalog_state(id,moves_oid,owns_name,owns_cost,name_definition,cost_definition)
    SELECT true,'moves'::regclass,owns_name,owns_cost,
      (SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef WHERE adrelid='moves'::regclass AND adnum=(SELECT attnum FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='name' AND NOT attisdropped)),
      (SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef WHERE adrelid='moves'::regclass AND adnum=(SELECT attnum FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='energy_cost' AND NOT attisdropped));
END;
$aliases$;
CREATE TABLE damage_move_defaults(move_name text PRIMARY KEY,type text NOT NULL,power integer NOT NULL,
  energy_cost integer NOT NULL,duration_ms integer NOT NULL);
COMMENT ON TABLE damage_move_defaults IS 'Proposed original REQ-00146 defaults, not active gameplay values; canonical moves remains authoritative';
INSERT INTO damage_move_defaults(move_name,type,power,energy_cost,duration_ms) VALUES
('ember', 'fire', 40, 0, 1000),
  ('flamethrower', 'fire', 70, 50, 2500),
  ('water_gun', 'water', 40, 0, 1000),
  ('hydro_pump', 'water', 90, 80, 3500),
  ('vine_whip', 'grass', 55, 0, 800),
  ('solar_beam', 'grass', 100, 80, 4000),
  ('thunder_shock', 'electric', 65, 0, 1200),
  ('thunder', 'electric', 100, 75, 3500),
  ('ice_beam', 'ice', 90, 60, 3000),
  ('psychic', 'psychic', 90, 60, 2800),
  ('karate_chop', 'fighting', 50, 0, 800),
  ('close_combat', 'fighting', 100, 70, 3000),
  ('dragon_claw', 'dragon', 85, 50, 2000),
  ('crunch', 'dark', 80, 45, 2000),
  ('shadow_ball', 'ghost', 100, 55, 2500),
  ('dazzling_gleam', 'fairy', 90, 55, 2500),
  ('tackle', 'normal', 35, 0, 500),
  ('quick_attack', 'normal', 50, 0, 600),
  ('rock_slide', 'rock', 80, 50, 2500),
  ('iron_head', 'steel', 100, 60, 2800),
  ('earthquake', 'ground', 100, 70, 3500),
  ('sludge_bomb', 'poison', 80, 50, 2200),
  ('bug_buzz', 'bug', 90, 55, 2500),
  ('air_slash', 'flying', 80, 45, 2000);
UPDATE damage_catalog_state SET profiles_oid='damage_move_defaults'::regclass,
  profiles_snapshot=(SELECT jsonb_agg(to_jsonb(d) ORDER BY move_name) FROM damage_move_defaults d),
  index_oid='damage_catalog_name_identity'::regclass,index_definition=pg_get_indexdef('damage_catalog_name_identity'::regclass);

-- migrate:down
LOCK TABLE moves,damage_move_defaults,damage_catalog_state IN ACCESS EXCLUSIVE MODE;
DO $reverse$
DECLARE s damage_catalog_state%ROWTYPE;expr text;kind "char";name text;owned boolean;signature text;
BEGIN
  SELECT * INTO STRICT s FROM damage_catalog_state WHERE id;
  IF s.moves_oid IS DISTINCT FROM to_regclass(format('%I.moves',current_schema()))::oid
    OR s.profiles_oid IS DISTINCT FROM to_regclass(format('%I.damage_move_defaults',current_schema()))::oid
    OR s.index_oid IS DISTINCT FROM to_regclass(format('%I.damage_catalog_name_identity',current_schema()))::oid
    OR s.index_definition IS DISTINCT FROM pg_get_indexdef(s.index_oid) THEN
    RAISE EXCEPTION 'Damage catalog relation identity changed; refusing reverse';
  END IF;
  IF s.profiles_snapshot IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(d) ORDER BY move_name) FROM damage_move_defaults d) THEN
    RAISE EXCEPTION 'Damage defaults changed; refusing lossy reverse';
  END IF;
  FOR name,owned,signature IN SELECT 'name',s.owns_name,'minego:damage-catalog:name:v1' UNION ALL SELECT 'energy_cost',s.owns_cost,'minego:damage-catalog:energy:v1' LOOP
    IF owned THEN
      SELECT a.attgenerated,pg_get_expr(d.adbin,d.adrelid) INTO kind,expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=s.moves_oid AND a.attname=name AND NOT a.attisdropped;
      IF kind IS DISTINCT FROM 's' OR expr IS DISTINCT FROM (CASE name WHEN 'name' THEN s.name_definition ELSE s.cost_definition END)
        OR (SELECT col_description(s.moves_oid,attnum) FROM pg_attribute WHERE attrelid=s.moves_oid AND attname=name AND NOT attisdropped) IS DISTINCT FROM signature THEN
        RAISE EXCEPTION 'Owned damage alias changed; refusing reverse';
      END IF;
    END IF;
  END LOOP;
  DROP INDEX damage_catalog_name_identity;
  IF s.owns_cost THEN ALTER TABLE moves DROP COLUMN energy_cost; END IF;
  IF s.owns_name THEN ALTER TABLE moves DROP COLUMN name; END IF;
END;
$reverse$;
DROP TABLE damage_move_defaults;
DROP TABLE damage_catalog_state;
