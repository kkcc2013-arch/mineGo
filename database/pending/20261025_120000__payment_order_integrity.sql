-- REQ-00003 / REQ-00004: durable owner-scoped 24-hour requests and once-only settlement.
-- migrate:up
DO $contract$
DECLARE orders_oid oid:=to_regclass('orders'); users_oid oid:=to_regclass('users'); relation_oid oid;
BEGIN
 FOREACH relation_oid IN ARRAY ARRAY[orders_oid,users_oid] LOOP
  IF relation_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=relation_oid AND n.nspname=current_schema() AND c.relkind='r') THEN
   RAISE EXCEPTION 'Payment canonical relation requires explicit adoption';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=orders_oid AND attname='id' AND atttypid='uuid'::regtype AND NOT attisdropped)
   OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=orders_oid AND attname='user_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
   OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=orders_oid AND attname='amount_fen' AND atttypid='integer'::regtype AND NOT attisdropped)
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE a.attrelid=orders_oid AND a.attname='status' AND NOT a.attisdropped AND t.typname='order_status_enum' AND n.nspname=current_schema())
   OR NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid=orders_oid AND c.confrelid=users_oid
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=orders_oid AND attname='user_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=users_oid AND attname='id')]::smallint[]) THEN
   RAISE EXCEPTION 'Payment requires canonical UUID orders, owner references, status type and integer minor units; explicit adoption required';
 END IF;
END
$contract$;
-- Append the runtime's original states without renaming historical FAILED rows.
ALTER TYPE order_status_enum ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE order_status_enum ADD VALUE IF NOT EXISTS 'FULFILLED';
-- Unknown historical quantities stay NULL; no money/status/timestamps/keys are rewritten.
ALTER TABLE orders ADD COLUMN quantity INTEGER CHECK(quantity BETWEEN 1 AND 100);
ALTER TABLE orders ADD CONSTRAINT payment_orders_owner_identity UNIQUE(id,user_id);
CREATE TABLE payment_order_requests (
  user_id UUID NOT NULL REFERENCES users(id),
  key_hash CHAR(64) NOT NULL CHECK(key_hash ~ '^[0-9a-f]{64}$'),
  request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  order_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+INTERVAL '24 hours',
  PRIMARY KEY(user_id,key_hash),
  FOREIGN KEY(order_id,user_id) REFERENCES orders(id,user_id),
  CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '24 hours')
);
CREATE TABLE payment_settlements (
  order_id UUID PRIMARY KEY REFERENCES orders(id),
  channel VARCHAR(20) NOT NULL CHECK(channel IN ('WECHAT','ALIPAY','APPLE')),
  channel_transaction_id VARCHAR(200) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(channel,channel_transaction_id)
);
COMMENT ON TABLE payment_order_requests IS 'Canonical owner/key/request binding; absolute rolling 24-hour deadline, Redis is only a mirror';
COMMENT ON TABLE payment_settlements IS 'Retained once-only order settlement and provider transaction identity; no raw callback/signature';
-- migrate:down
DO $retain$
BEGIN
 IF EXISTS(SELECT 1 FROM payment_order_requests) OR EXISTS(SELECT 1 FROM payment_settlements) OR EXISTS(SELECT 1 FROM orders WHERE quantity IS NOT NULL) THEN
   RAISE EXCEPTION 'Retain payment request, quantity and settlement history; explicit adoption required';
 END IF;
END
$retain$;
DROP TABLE payment_settlements;
DROP TABLE payment_order_requests;
ALTER TABLE orders DROP CONSTRAINT payment_orders_owner_identity;
ALTER TABLE orders DROP COLUMN quantity;

-- PostgreSQL enum labels are retained on reversal; no type rebuild or historical status conversion.
