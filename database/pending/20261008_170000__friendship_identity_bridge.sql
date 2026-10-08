-- REQ-00067/00079: keep UUID trainer bonds and their numeric levels/data.
-- The named affinity level is a projection, not a replacement of bond level.
-- migrate:up
CREATE TABLE friendship_identity_bridge_state(
  id BOOLEAN PRIMARY KEY CHECK(id), bond_oid OID NOT NULL,
  history_oid OID, projection_oid OID, original_log_function TEXT NOT NULL
);
DO $guard$
DECLARE original OID:=to_regclass(format('%I.pokemon_friendship',current_schema()));
        column_spec RECORD; fn OID:=to_regprocedure(format('%I.log_friendship_change()',current_schema()));
BEGIN
  IF original IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=original AND relkind='r') OR fn IS NULL THEN
    RAISE EXCEPTION 'Friendship bridge requires the existing UUID trainer bond schema and log trigger';
  END IF;
  FOR column_spec IN SELECT * FROM (VALUES ('id','uuid'),('pokemon_id','uuid'),('user_id','uuid'),
      ('friendship_value','smallint'),('friendship_level','smallint')) c(name,kind) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=original AND attname=column_spec.name
        AND atttypid=column_spec.kind::regtype AND NOT attisdropped) THEN
      RAISE EXCEPTION 'Unsupported friendship identity/column: %; provide an explicit data-preserving upgrade',column_spec.name;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=original AND tgname='trigger_log_friendship_change' AND tgfoid=fn AND NOT tgisinternal)
     OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=original AND attname IN('pokemon_instance_id','affinity_level',
       'daily_walking_bonus','last_walking_bonus_date','daily_interaction_count','last_interaction_date',
       'days_with_trainer','first_obtained_at') AND NOT attisdropped)
     OR to_regclass(format('%I.friendship_history',current_schema())) IS NOT NULL
     OR to_regclass(format('%I.pokemon_affinity',current_schema())) IS NOT NULL THEN
    RAISE EXCEPTION 'Existing friendship bridge objects require an explicit reconciliation plan';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid=fn) IS DISTINCT FROM $legacy$
BEGIN
    IF OLD.friendship_value IS DISTINCT FROM NEW.friendship_value THEN
        INSERT INTO friendship_interactions (pokemon_id, user_id, interaction_type, friendship_gain, mood_change)
        VALUES (
            NEW.pokemon_id,
            NEW.user_id,
            'system_update',
            NEW.friendship_value - OLD.friendship_value,
            NEW.mood
        );
    END IF;
    RETURN NEW;
END;
$legacy$
     OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=fn AND (prosecdef OR proconfig IS NOT NULL))
     OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgfoid=fn AND (tgrelid<>original OR tgname<>'trigger_log_friendship_change')) THEN
    RAISE EXCEPTION 'Custom friendship logging requires an explicit reconciliation plan';
  END IF;
  LOCK TABLE pokemon_friendship IN ACCESS EXCLUSIVE MODE;
  INSERT INTO friendship_identity_bridge_state VALUES(TRUE,original,NULL,NULL,pg_get_functiondef(fn));
END
$guard$;

ALTER TABLE pokemon_friendship
  ADD COLUMN pokemon_instance_id UUID GENERATED ALWAYS AS(pokemon_id) STORED,
  ADD COLUMN affinity_level TEXT GENERATED ALWAYS AS(CASE
    WHEN friendship_value>=200 THEN 'beloved' WHEN friendship_value>=150 THEN 'close'
    WHEN friendship_value>=100 THEN 'friendly' WHEN friendship_value>=50 THEN 'normal'
    ELSE 'stranger' END) STORED,
  ADD COLUMN daily_walking_bonus INTEGER NOT NULL DEFAULT 0 CHECK(daily_walking_bonus BETWEEN 0 AND 10),
  ADD COLUMN last_walking_bonus_date DATE,
  ADD COLUMN daily_interaction_count INTEGER NOT NULL DEFAULT 0 CHECK(daily_interaction_count>=0),
  ADD COLUMN last_interaction_date DATE,
  ADD COLUMN days_with_trainer INTEGER CHECK(days_with_trainer>=0),
  ADD COLUMN first_obtained_at TIMESTAMPTZ;
-- Unknown historic trainer acquisition times and days remain NULL. No row updates.
CREATE TABLE friendship_history(
  id BIGSERIAL PRIMARY KEY,
  friendship_id UUID NOT NULL REFERENCES pokemon_friendship(id) ON DELETE CASCADE,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL, change_amount INTEGER NOT NULL,
  before_value SMALLINT NOT NULL CHECK(before_value BETWEEN 0 AND 255),
  after_value SMALLINT NOT NULL CHECK(after_value BETWEEN 0 AND 255),
  source TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(change_amount=after_value-before_value)
);
CREATE VIEW pokemon_affinity AS SELECT id,pokemon_instance_id,user_id,friendship_value,
  affinity_level AS friendship_level,friendship_level AS bond_level,mood,mood_expiry,
  daily_walking_bonus,last_walking_bonus_date,daily_interaction_count,last_interaction_date,
  total_interactions,days_with_trainer,first_obtained_at,last_interaction_at,created_at,updated_at
  FROM pokemon_friendship;
UPDATE friendship_identity_bridge_state SET history_oid='friendship_history'::regclass,
  projection_oid='pokemon_affinity'::regclass WHERE id=TRUE;

-- The old trigger inserted system_update and negative deltas into the five-action,
-- positive-only interaction table. Keep its identity and enablement, repair its sink.
CREATE OR REPLACE FUNCTION log_friendship_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $history$
BEGIN
  IF OLD.friendship_value IS DISTINCT FROM NEW.friendship_value THEN
    EXECUTE format('INSERT INTO %I.friendship_history(friendship_id,pokemon_instance_id,user_id,
      change_type,change_amount,before_value,after_value,source) VALUES($1,$2,$3,$4,$5,$6,$7,$4)',TG_TABLE_SCHEMA)
      USING NEW.id,NEW.pokemon_id,NEW.user_id,'system_update',NEW.friendship_value-OLD.friendship_value,
        OLD.friendship_value,NEW.friendship_value;
  END IF;
  RETURN NEW;
END
$history$;

-- migrate:down
DO $rollback$
DECLARE state RECORD;
BEGIN
  SELECT * INTO STRICT state FROM friendship_identity_bridge_state WHERE id=TRUE;
  IF 'pokemon_friendship'::regclass::oid<>state.bond_oid OR 'friendship_history'::regclass::oid<>state.history_oid
     OR 'pokemon_affinity'::regclass::oid<>state.projection_oid THEN
    RAISE EXCEPTION 'Friendship bridge relation identity changed';
  END IF;
  LOCK TABLE pokemon_friendship,friendship_history IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM friendship_history) OR EXISTS(SELECT 1 FROM pokemon_friendship WHERE
      daily_walking_bonus<>0 OR last_walking_bonus_date IS NOT NULL OR daily_interaction_count<>0
      OR last_interaction_date IS NOT NULL OR days_with_trainer IS NOT NULL OR first_obtained_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Actual friendship history/metadata exists; provide a data-preserving reverse migration';
  END IF;
  EXECUTE state.original_log_function;
  DROP VIEW pokemon_affinity;
  DROP TABLE friendship_history;
  ALTER TABLE pokemon_friendship DROP COLUMN pokemon_instance_id,DROP COLUMN affinity_level,
    DROP COLUMN daily_walking_bonus,DROP COLUMN last_walking_bonus_date,DROP COLUMN daily_interaction_count,
    DROP COLUMN last_interaction_date,DROP COLUMN days_with_trainer,DROP COLUMN first_obtained_at;
END
$rollback$;
DROP TABLE friendship_identity_bridge_state;
