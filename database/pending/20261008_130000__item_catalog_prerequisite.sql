-- REQ-00007/REQ-00047: the inventory migration requires the localized item catalog.
-- Add a declared prerequisite without changing the legacy migration's checksum.
-- migrate:up
CREATE TABLE migration_20261008_item_catalog_state (
  id BOOLEAN PRIMARY KEY CHECK (id),
  created_items BOOLEAN NOT NULL,
  items_oid OID NOT NULL
);

DO $bootstrap$
DECLARE
  previous_oid OID := to_regclass(format('%I.items', current_schema()));
BEGIN
  CREATE TABLE IF NOT EXISTS items (
    id VARCHAR(50) PRIMARY KEY,
    category VARCHAR(30) NOT NULL,
    name_zh VARCHAR(100) NOT NULL,
    name_en VARCHAR(100) NOT NULL,
    name_ja VARCHAR(100),
    description_zh TEXT,
    description_en TEXT,
    description_ja TEXT,
    effect_type VARCHAR(50),
    effect_value DECIMAL(10,4),
    shop_price INTEGER,
    is_premium BOOLEAN NOT NULL DEFAULT FALSE,
    sprite_url VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );
  INSERT INTO migration_20261008_item_catalog_state
  VALUES (TRUE, previous_oid IS NULL, to_regclass(format('%I.items', current_schema())));
END
$bootstrap$;

-- Validate the existing contract too; do not fabricate or overwrite older data.
SELECT id, category, name_zh, name_en, name_ja FROM items LIMIT 0;

-- migrate:down
DO $rollback$
DECLARE
  state RECORD;
  current_oid OID := to_regclass(format('%I.items', current_schema()));
BEGIN
  SELECT * INTO STRICT state FROM migration_20261008_item_catalog_state WHERE id=TRUE;
  IF state.created_items THEN
    IF current_oid IS DISTINCT FROM state.items_oid THEN
      RAISE EXCEPTION 'Item catalog identity changed; automatic rollback refused';
    END IF;
    EXECUTE format('DROP TABLE %I.items', current_schema());
  END IF;
END
$rollback$;
DROP TABLE migration_20261008_item_catalog_state;
