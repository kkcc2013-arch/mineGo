-- REQ-00638 / REQ-00038: persistent factor replay and scoped proof ownership.
-- migrate:up
DO $contract$
DECLARE actual_schema text:=current_schema(); relation_name text; relation record;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['users','user_mfa','mfa_recovery_codes','mfa_verification_logs'] LOOP
    SELECT n.nspname,c.relkind INTO relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass(relation_name);
    IF NOT FOUND OR relation.nspname<>actual_schema OR relation.relkind<>'r' THEN RAISE EXCEPTION 'MFA canonical relation requires explicit adoption: %',relation_name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='user_mfa'::regclass AND attname='user_id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN RAISE EXCEPTION 'MFA requires canonical UUID subjects'; END IF;
END
$contract$;

-- Older profiles/ciphertext/failure/lock history stay untouched. Runtime adoption
-- is explicit; unknown timestamp provenance is never converted into an instant.
CREATE TABLE mfa_security_state (
  user_id UUID PRIMARY KEY REFERENCES user_mfa(user_id) ON DELETE CASCADE,
  credential_epoch UUID NOT NULL,
  last_totp_counter BIGINT CHECK(last_totp_counter>=0),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts>=0),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE mfa_auth_proofs (
  proof_hash VARCHAR(64) PRIMARY KEY CHECK(proof_hash ~ '^[0-9a-f]{64}$'),
  user_id UUID NOT NULL REFERENCES mfa_security_state(user_id) ON DELETE CASCADE,
  credential_epoch UUID NOT NULL,
  proof_kind VARCHAR(16) NOT NULL CHECK(proof_kind IN ('step-up','login')),
  scope VARCHAR(64) NOT NULL CHECK(scope ~ '^[a-z][a-z0-9-]{0,63}$'),
  subject_binding VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '5 minutes'),
  CHECK((proof_kind='step-up' AND subject_binding ~ '^[0-9a-f]{64}$') OR (proof_kind='login' AND subject_binding=''))
);
CREATE INDEX mfa_auth_proofs_subject_expiry ON mfa_auth_proofs(user_id,expires_at);
COMMENT ON TABLE mfa_security_state IS 'Authoritative new MFA epochs, one-time TOTP counters and absolute lock instants; legacy profiles require explicit adoption';
COMMENT ON TABLE mfa_auth_proofs IS 'Only hashes of opaque server proofs; bound to credential epoch, purpose and access session; no caller-declared MFA flags';

-- migrate:down
DO $retain$
BEGIN
  IF EXISTS(SELECT 1 FROM mfa_security_state) OR EXISTS(SELECT 1 FROM mfa_auth_proofs) THEN RAISE EXCEPTION 'Retain MFA replay and authentication history; explicit adoption required before reversal'; END IF;
END
$retain$;
DROP TABLE mfa_auth_proofs;
DROP TABLE mfa_security_state;
