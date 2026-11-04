-- REQ-00026/REQ-00099/REQ-00120: retain actual numeric IDs and original type/data.
-- migrate:up
CREATE TABLE notification_history_contract_state(id BOOLEAN PRIMARY KEY CHECK(id),history_oid OID NOT NULL,added_columns TEXT[] NOT NULL,event_index_oid OID);
CREATE FUNCTION minego_notification_type(value TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $type$
  SELECT CASE lower(replace(value,'_',''))
    WHEN 'rarespawn' THEN 'RARE_SPAWN' WHEN 'raidstarted' THEN 'RAID_STARTED' WHEN 'gymraid' THEN 'RAID_STARTED'
    WHEN 'friendrequest' THEN 'FRIEND_REQUEST' WHEN 'giftreceived' THEN 'GIFT_RECEIVED'
    WHEN 'questcomplete' THEN 'QUEST_COMPLETE' WHEN 'reward' THEN 'QUEST_COMPLETE'
    WHEN 'gymunderattack' THEN 'GYM_UNDER_ATTACK' WHEN 'gymlost' THEN 'GYM_LOST'
    WHEN 'system' THEN 'SYSTEM' WHEN 'traderequest' THEN 'TRADE_REQUEST' ELSE value END
$type$;
DO $contract$
DECLARE relation OID:=to_regclass(format('%I.notification_history',current_schema())); column_name TEXT; added TEXT[]:=ARRAY[]::text[];
BEGIN
  IF relation IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation AND attname='id' AND atttypid='integer'::regtype AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation AND attname='user_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation AND attname='type' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Notification contract requires the canonical UUID owner/integer ID/type history';
  END IF;
  LOCK TABLE notification_history IN ACCESS EXCLUSIVE MODE;
  FOR column_name IN SELECT unnest(ARRAY['notification_type','title','body','read_at','source_event_id']) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation AND attname=column_name AND NOT attisdropped) THEN added:=array_append(added,column_name); END IF;
  END LOOP;
  IF 'notification_type'=ANY(added) THEN
    ALTER TABLE notification_history ADD COLUMN notification_type VARCHAR(50) GENERATED ALWAYS AS(minego_notification_type(type)) STORED;
  ELSE
    RAISE EXCEPTION 'An existing notification type alias requires explicit reconciliation';
  END IF;
  ALTER TABLE notification_history ADD COLUMN IF NOT EXISTS title TEXT,ADD COLUMN IF NOT EXISTS body TEXT,ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,ADD COLUMN IF NOT EXISTS source_event_id TEXT;
  UPDATE notification_history SET title=CASE WHEN jsonb_typeof(data->'title')='string' THEN data->>'title' ELSE NULL END WHERE title IS NULL;
  UPDATE notification_history SET body=CASE WHEN jsonb_typeof(data->'body')='string' THEN data->>'body' ELSE NULL END WHERE body IS NULL;
  -- Old read flags do not establish a historical read timestamp.
  IF to_regclass(format('%I.notification_history_event_identity',current_schema())) IS NOT NULL THEN RAISE EXCEPTION 'Notification event index name already exists'; END IF;
  CREATE UNIQUE INDEX notification_history_event_identity ON notification_history(user_id,notification_type,source_event_id) WHERE source_event_id IS NOT NULL;
  INSERT INTO notification_history_contract_state VALUES(TRUE,relation,added,'notification_history_event_identity'::regclass);
END
$contract$;

CREATE TABLE notification_event_receipts(
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,
  source_event_id TEXT NOT NULL,
  notification_id INTEGER REFERENCES notification_history(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id,notification_type,source_event_id)
);

-- migrate:down
DO $rollback$
DECLARE state RECORD; column_name TEXT;
BEGIN
  SELECT * INTO STRICT state FROM notification_history_contract_state WHERE id=TRUE;
  IF 'notification_history'::regclass::oid<>state.history_oid THEN RAISE EXCEPTION 'Notification history relation identity changed'; END IF;
  LOCK TABLE notification_history,notification_event_receipts IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM notification_event_receipts) THEN RAISE EXCEPTION 'Notification event receipts exist; an explicit data-preserving reverse migration is required'; END IF;
  IF 'notification_history_event_identity'::regclass::oid<>state.event_index_oid THEN RAISE EXCEPTION 'Notification event index identity changed'; END IF;
  DROP TABLE notification_event_receipts;
  DROP INDEX notification_history_event_identity;
  IF ('read_at'=ANY(state.added_columns) AND EXISTS(SELECT 1 FROM notification_history WHERE read_at IS NOT NULL))
    OR ('source_event_id'=ANY(state.added_columns) AND EXISTS(SELECT 1 FROM notification_history WHERE source_event_id IS NOT NULL))
    OR ('title'=ANY(state.added_columns) AND EXISTS(SELECT 1 FROM notification_history WHERE title IS DISTINCT FROM CASE WHEN jsonb_typeof(data->'title')='string' THEN data->>'title' END))
    OR ('body'=ANY(state.added_columns) AND EXISTS(SELECT 1 FROM notification_history WHERE body IS DISTINCT FROM CASE WHEN jsonb_typeof(data->'body')='string' THEN data->>'body' END)) THEN
    RAISE EXCEPTION 'Modern notification metadata exists; an explicit data-preserving reverse migration is required';
  END IF;
  FOREACH column_name IN ARRAY state.added_columns LOOP
    EXECUTE format('ALTER TABLE %I.notification_history DROP COLUMN %I',current_schema(),column_name);
  END LOOP;
END
$rollback$;
DROP TABLE notification_history_contract_state;
DROP FUNCTION minego_notification_type(TEXT);
