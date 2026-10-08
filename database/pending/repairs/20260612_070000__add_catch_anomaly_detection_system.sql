-- REQ-00082: preserve gameplay sessions; risk requests are a distinct record.
-- Complete original-source-bound repair. No fake catches or arbitrary UUID casts.
-- migrate:up
CREATE TABLE catch_risk_storage_state(id BOOLEAN PRIMARY KEY CHECK(id),session_oid OID NOT NULL,
  throw_oid OID NOT NULL,owned_relations JSONB NOT NULL DEFAULT '{}',initial_config JSONB);
DO $guard$
DECLARE sessions OID:=to_regclass(format('%I.catch_sessions',current_schema()));
        throws OID:=to_regclass(format('%I.catch_throws',current_schema())); target TEXT;
BEGIN
  IF sessions IS NULL OR throws IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=sessions AND attname='id' AND atttypid='uuid'::regtype AND NOT attisdropped)
     OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=sessions AND attname='user_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
     OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=sessions AND attname='wild_pokemon_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
     OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=throws AND attname='session_id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Catch risk storage requires canonical UUID gameplay sessions/throws; provide an explicit reconciliation plan';
  END IF;
  FOREACH target IN ARRAY ARRAY['catch_risk_attempts','catch_success_stats','catch_risk_decisions','user_catch_stats','catch_base_rate_config'] LOOP
    IF to_regclass(format('%I.%I',current_schema(),target)) IS NOT NULL THEN
      RAISE EXCEPTION 'Existing catch risk storage % requires a data-preserving upgrade plan',target;
    END IF;
  END LOOP;
  INSERT INTO catch_risk_storage_state(id,session_oid,throw_oid) VALUES(TRUE,sessions,throws);
END
$guard$;

CREATE TABLE catch_base_rate_config(pokemon_rarity VARCHAR(32) PRIMARY KEY,
  base_rate NUMERIC(5,4) NOT NULL CHECK(base_rate BETWEEN 0 AND 1));
-- These original values are configuration, not synthetic user/catch statistics.
INSERT INTO catch_base_rate_config VALUES('common',0.40),('rare',0.20),('epic',0.10),('legendary',0.05);
CREATE TABLE catch_success_stats(
  id BIGSERIAL PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id),pokemon_id VARCHAR(64) NOT NULL,
  pokemon_rarity VARCHAR(32) NOT NULL,ball_type VARCHAR(32) NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK(success_count>=0 AND success_count<=attempt_count),
  expected_rate_sum NUMERIC NOT NULL DEFAULT 0 CHECK(expected_rate_sum>=0 AND expected_rate_sum<=attempt_count),
  expected_success_rate NUMERIC(5,4),actual_success_rate NUMERIC(5,4),anomaly_score NUMERIC(5,2),
  hour_timestamp TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(expected_success_rate BETWEEN 0 AND 1),CHECK(actual_success_rate BETWEEN 0 AND 1),CHECK(anomaly_score BETWEEN 0 AND 100),
  UNIQUE(user_id,pokemon_id,pokemon_rarity,ball_type,hour_timestamp)
);
CREATE INDEX idx_catch_stats_user_pokemon ON catch_success_stats(user_id,pokemon_id);
CREATE INDEX idx_catch_stats_hour_anomaly ON catch_success_stats(hour_timestamp,anomaly_score);
CREATE INDEX idx_catch_stats_rarity ON catch_success_stats(pokemon_rarity);

CREATE TABLE catch_risk_attempts(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),session_id UUID GENERATED ALWAYS AS(id) STORED,
  user_id UUID NOT NULL REFERENCES users(id),pokemon_id VARCHAR(64) NOT NULL,
  game_session_id UUID REFERENCES catch_sessions(id),throw_id UUID UNIQUE REFERENCES catch_throws(id),
  pokemon_rarity VARCHAR(32),ball_type VARCHAR(32),ball_count_used INTEGER CHECK(ball_count_used BETWEEN 1 AND 100),
  berries_used INTEGER CHECK(berries_used>=0),throw_type VARCHAR(32),curveball BOOLEAN,
  expected_success_rate NUMERIC(5,4) CHECK(expected_success_rate BETWEEN 0 AND 1),
  actual_result VARCHAR(16) CHECK(actual_result IN('success','fail','escape')),
  catch_timestamp TIMESTAMP,location_lat NUMERIC(10,7) CHECK(location_lat BETWEEN -90 AND 90),
  location_lng NUMERIC(10,7) CHECK(location_lng BETWEEN -180 AND 180),
  device_fingerprint VARCHAR(256),request_signature VARCHAR(512),
  data_integrity_score NUMERIC(5,2) CHECK(data_integrity_score BETWEEN 0 AND 100),
  risk_score NUMERIC(5,2) CHECK(risk_score BETWEEN 0 AND 100),
  risk_level VARCHAR(16) CHECK(risk_level IN('low','medium','high','critical')),
  action_taken VARCHAR(32) CHECK(action_taken IN('allow','warn','block')),
  request_snapshot JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK((actual_result IS NULL AND throw_id IS NULL) OR (actual_result IS NOT NULL AND throw_id IS NOT NULL))
);
CREATE INDEX idx_catch_risk_attempts_user_time ON catch_risk_attempts(user_id,created_at);
CREATE INDEX idx_catch_risk_attempts_risk ON catch_risk_attempts(risk_level,created_at);
CREATE INDEX idx_catch_risk_attempts_result ON catch_risk_attempts(actual_result);
CREATE INDEX idx_catch_risk_attempts_pokemon ON catch_risk_attempts(pokemon_id);

CREATE FUNCTION minego_validate_catch_risk_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $evidence$
DECLARE evidence RECORD;session_owner UUID;wild UUID;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Catch risk records are immutable; record a separate correction event'; END IF;
  IF NEW.throw_id IS NOT NULL THEN
    EXECUTE format('SELECT s.id AS session_id,s.user_id,s.wild_pokemon_id,s.result,t.success,t.catch_prob,
      t.ball_type,t.throw_rating,t.is_curve,t.thrown_at,p.rarity FROM %I.catch_throws t JOIN %I.catch_sessions s ON s.id=t.session_id
      JOIN %I.wild_pokemon w ON w.id=s.wild_pokemon_id JOIN %I.pokemon_species p ON p.id=w.species_id WHERE t.id=$1',
      TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO evidence USING NEW.throw_id;
    IF evidence.session_id IS NULL OR evidence.user_id IS DISTINCT FROM NEW.user_id
       OR evidence.wild_pokemon_id::text IS DISTINCT FROM lower(NEW.pokemon_id)
       OR (NEW.game_session_id IS NOT NULL AND NEW.game_session_id IS DISTINCT FROM evidence.session_id)
       OR (NEW.actual_result='success' AND evidence.success IS NOT TRUE)
       OR (NEW.actual_result IN('fail','escape') AND evidence.success IS NOT FALSE)
       OR (NEW.actual_result='escape' AND evidence.result IS DISTINCT FROM 'FLED') THEN
      RAISE EXCEPTION 'Catch risk outcome lacks matching owned gameplay throw evidence';
    END IF;
    NEW.pokemon_id:=evidence.wild_pokemon_id::text;NEW.game_session_id:=evidence.session_id;NEW.catch_timestamp:=evidence.thrown_at;
    NEW.expected_success_rate:=evidence.catch_prob;NEW.ball_type:=evidence.ball_type::text;
    NEW.throw_type:=evidence.throw_rating::text;NEW.curveball:=evidence.is_curve;NEW.pokemon_rarity:=evidence.rarity::text;
  ELSIF NEW.game_session_id IS NOT NULL THEN
    EXECUTE format('SELECT user_id,wild_pokemon_id FROM %I.catch_sessions WHERE id=$1',TG_TABLE_SCHEMA)
      INTO session_owner,wild USING NEW.game_session_id;
    IF session_owner IS DISTINCT FROM NEW.user_id OR wild::text IS DISTINCT FROM lower(NEW.pokemon_id) THEN
      RAISE EXCEPTION 'Catch risk session evidence belongs to a different owner or Pokemon';
    END IF;
    NEW.pokemon_id:=wild::text;
  END IF;
  RETURN NEW;
END
$evidence$;
CREATE TRIGGER minego_catch_risk_evidence BEFORE INSERT OR UPDATE ON catch_risk_attempts
  FOR EACH ROW EXECUTE FUNCTION minego_validate_catch_risk_evidence();

CREATE TABLE catch_risk_decisions(
  id BIGSERIAL PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id),session_id UUID NOT NULL REFERENCES catch_risk_attempts(id),
  total_risk_score NUMERIC(5,2),risk_level VARCHAR(16),action VARCHAR(32),success_rate_score NUMERIC(5,2),
  batch_score NUMERIC(5,2),integrity_score NUMERIC(5,2),item_score NUMERIC(5,2),device_score NUMERIC(5,2),details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_risk_decisions_user ON catch_risk_decisions(user_id);
CREATE INDEX idx_risk_decisions_time ON catch_risk_decisions(created_at);
CREATE TABLE user_catch_stats(
  user_id UUID PRIMARY KEY REFERENCES users(id),total_catches INTEGER NOT NULL DEFAULT 0,
  total_attempts INTEGER NOT NULL DEFAULT 0,risk_requests INTEGER NOT NULL DEFAULT 0,
  success_rate_7d NUMERIC(5,4),success_rate_30d NUMERIC(5,4),anomaly_count INTEGER,
  last_anomaly_at TIMESTAMPTZ,trust_score INTEGER,warning_count INTEGER NOT NULL DEFAULT 0,blocked_count INTEGER NOT NULL DEFAULT 0,
  last_catch_at TIMESTAMP,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(total_catches>=0 AND total_catches<=total_attempts AND total_attempts<=risk_requests)
);
UPDATE catch_risk_storage_state SET owned_relations=(SELECT jsonb_object_agg(name,to_regclass(format('%I.%I',current_schema(),name))::oid)
  FROM unnest(ARRAY['catch_base_rate_config','catch_success_stats','catch_risk_attempts','catch_risk_decisions','user_catch_stats']) name),
  initial_config=(SELECT jsonb_agg(to_jsonb(c) ORDER BY pokemon_rarity) FROM catch_base_rate_config c) WHERE id=TRUE;
COMMENT ON TABLE catch_risk_attempts IS 'REQ-00082: risk requests; distinct from immutable gameplay session identity';
COMMENT ON TABLE catch_success_stats IS 'REQ-00082: actual hourly observations, no configuration or synthetic catches';

-- migrate:down
DO $rollback$
DECLARE state RECORD;owned RECORD;
BEGIN
  SELECT * INTO STRICT state FROM catch_risk_storage_state WHERE id=TRUE;
  IF 'catch_sessions'::regclass::oid<>state.session_oid OR 'catch_throws'::regclass::oid<>state.throw_oid THEN
    RAISE EXCEPTION 'Original gameplay relation identity changed';
  END IF;
  FOR owned IN SELECT key,value FROM jsonb_each_text(state.owned_relations) LOOP
    IF to_regclass(format('%I.%I',current_schema(),owned.key))::oid IS DISTINCT FROM owned.value::oid THEN
      RAISE EXCEPTION 'Catch risk storage relation identity changed: %',owned.key;
    END IF;
  END LOOP;
  LOCK TABLE catch_risk_attempts,catch_success_stats,catch_risk_decisions,user_catch_stats,catch_base_rate_config IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM catch_risk_attempts) OR EXISTS(SELECT 1 FROM catch_success_stats)
     OR EXISTS(SELECT 1 FROM catch_risk_decisions) OR EXISTS(SELECT 1 FROM user_catch_stats)
     OR (SELECT jsonb_agg(to_jsonb(c) ORDER BY pokemon_rarity) FROM catch_base_rate_config c) IS DISTINCT FROM state.initial_config THEN
    RAISE EXCEPTION 'Actual catch risk records/configuration exist; provide a data-preserving reverse migration';
  END IF;
  DROP TABLE catch_risk_decisions,user_catch_stats,catch_success_stats,catch_risk_attempts,catch_base_rate_config;
END
$rollback$;
DROP FUNCTION minego_validate_catch_risk_evidence();
DROP TABLE catch_risk_storage_state;
