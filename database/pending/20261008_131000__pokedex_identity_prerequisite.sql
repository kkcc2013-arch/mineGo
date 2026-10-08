-- REQ-00007/REQ-00056: align the cache owner identity with V1 UUID users.
-- Legacy migration remains immutable. Existing incompatible identities are not cast.
-- migrate:up
CREATE TABLE migration_20261008_pokedex_state (id BOOLEAN PRIMARY KEY CHECK(id), created_cache BOOLEAN NOT NULL, cache_oid OID NOT NULL);
DO $bootstrap$
DECLARE previous_oid OID := to_regclass(format('%I.pokedex_stats_cache', current_schema()));
BEGIN
CREATE TABLE IF NOT EXISTS pokedex_stats_cache (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    
    -- 基础统计
    total_species INTEGER DEFAULT 0,
    seen_count INTEGER DEFAULT 0,
    caught_count INTEGER DEFAULT 0,
    shiny_count INTEGER DEFAULT 0,
    legendary_count INTEGER DEFAULT 0,
    mythical_count INTEGER DEFAULT 0,
    
    -- 完成度
    completion_percentage DECIMAL(5,2) DEFAULT 0.00,
    
    -- 地区统计
    region_stats JSONB DEFAULT '{}',
    
    -- 属性统计
    type_stats JSONB DEFAULT '{}',
    
    -- 世代统计
    generation_stats JSONB DEFAULT '{}',
    
    -- 排名缓存
    global_rank INTEGER,
    rank_updated_at TIMESTAMP,
    
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO migration_20261008_pokedex_state VALUES(TRUE, previous_oid IS NULL, to_regclass(format('%I.pokedex_stats_cache', current_schema())));
END
$bootstrap$;


DO $validate$
BEGIN
  IF (SELECT atttypid FROM pg_attribute WHERE attrelid='pokedex_stats_cache'::regclass AND attname='user_id') <> (SELECT atttypid FROM pg_attribute WHERE attrelid='users'::regclass AND attname='id') THEN
    RAISE EXCEPTION 'Pokedex cache identity differs from authoritative users identity';
  END IF;
END
$validate$;

-- migrate:down
DO $rollback$
DECLARE state RECORD; current_oid OID := to_regclass(format('%I.pokedex_stats_cache',current_schema()));
BEGIN
  SELECT * INTO STRICT state FROM migration_20261008_pokedex_state WHERE id=TRUE;
  IF state.created_cache THEN
    IF current_oid IS DISTINCT FROM state.cache_oid THEN RAISE EXCEPTION 'Pokedex cache identity changed; rollback refused'; END IF;
    EXECUTE format('DROP TABLE %I.pokedex_stats_cache',current_schema());
  END IF;
END
$rollback$;
DROP TABLE migration_20261008_pokedex_state;
