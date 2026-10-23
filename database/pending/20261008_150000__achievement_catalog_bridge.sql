-- REQ-00076: reconcile V1 tiered progress and the newer claimable catalog.
-- Preserve the original composite key, definition FK, counters, tiers and timestamps.
-- migrate:up
CREATE TABLE achievement_catalog_bridge_state(
  id BOOLEAN PRIMARY KEY CHECK(id),
  progress_oid OID NOT NULL,
  catalog_oid OID,
  owns_catalog BOOLEAN NOT NULL
);
DO $guard$
DECLARE original OID:=to_regclass(format('%I.user_achievements',current_schema()));
BEGIN
  IF original IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=original AND attname='current_value' AND atttypid='integer'::regtype AND NOT attisdropped)
     OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=original AND attname='user_id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Achievement bridge requires the canonical V1 UUID/tiered progress schema';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=original AND attname IN('progress','target','completed','completed_at','rewards_claimed','rewards_claimed_at','created_at','modern_achievement_id') AND NOT attisdropped)
     OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='achievement_definitions'::regclass AND attname='is_modern' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Existing achievement bridge columns require an explicit upgrade plan';
  END IF;
  LOCK TABLE user_achievements,achievement_definitions IN ACCESS EXCLUSIVE MODE;
  INSERT INTO achievement_catalog_bridge_state VALUES(TRUE,original,NULL,to_regclass(format('%I.achievements',current_schema())) IS NULL);
END
$guard$;
-- REQ-00076: 精灵成就系统与里程碑奖励
-- 数据库迁移：创建成就相关表

-- 成就定义表
CREATE TABLE IF NOT EXISTS achievements (
    id SERIAL PRIMARY KEY,
    achievement_id VARCHAR(50) UNIQUE NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('catch', 'breed', 'battle', 'social', 'explore')),
    name JSONB NOT NULL,
    description JSONB NOT NULL,
    icon_url VARCHAR(500),
    rarity VARCHAR(20) NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
    points INTEGER NOT NULL DEFAULT 10,
    is_hidden BOOLEAN DEFAULT FALSE,
    trigger_conditions JSONB NOT NULL,
    rewards JSONB NOT NULL,
    prerequisite_achievement_id VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),

    FOREIGN KEY (prerequisite_achievement_id) REFERENCES achievements(achievement_id)
);


UPDATE achievement_catalog_bridge_state SET catalog_oid='achievements'::regclass WHERE id=TRUE;
ALTER TABLE achievement_definitions ADD COLUMN is_modern BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_achievements
  ADD COLUMN progress NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN target NUMERIC,
  ADD COLUMN completed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN completed_at TIMESTAMP,
  ADD COLUMN rewards_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN rewards_claimed_at TIMESTAMP,
  ADD COLUMN created_at TIMESTAMP,
  ADD COLUMN modern_achievement_id VARCHAR(50),
  ADD CONSTRAINT achievement_bridge_progress_valid CHECK(progress>=0 AND progress<='2147483647'::numeric),
  ADD CONSTRAINT achievement_bridge_target_valid CHECK(target IS NULL OR (target>0 AND target<='2147483647'::numeric)),
  ADD CONSTRAINT achievement_bridge_definition_identity CHECK(modern_achievement_id IS NULL OR modern_achievement_id=achievement_id),
  ADD CONSTRAINT achievement_bridge_modern_definition FOREIGN KEY(modern_achievement_id) REFERENCES achievements(achievement_id) ON DELETE RESTRICT,
  ADD CONSTRAINT achievement_bridge_claim_valid CHECK(NOT rewards_claimed OR (modern_achievement_id IS NOT NULL AND completed));
-- Existing rows have no known creation/completion/claim time. Do not invent one.
UPDATE user_achievements u SET progress=u.current_value,
  target=(SELECT max((tier->>'target')::numeric) FROM jsonb_array_elements(d.tiers) tier)
  FROM achievement_definitions d WHERE d.id=u.achievement_id;
UPDATE user_achievements SET completed=(target IS NOT NULL AND progress>=target);
ALTER TABLE user_achievements ALTER COLUMN created_at SET DEFAULT NOW();

CREATE FUNCTION minego_sync_achievement_catalog() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $bridge$
DECLARE ns TEXT:=TG_TABLE_SCHEMA; marked BOOLEAN; threshold NUMERIC;
BEGIN
  IF TG_OP='DELETE' THEN
    EXECUTE format('DELETE FROM %I.achievement_definitions WHERE id=$1 AND is_modern',ns) USING OLD.achievement_id;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.achievement_id IS DISTINCT FROM NEW.achievement_id THEN
    RAISE EXCEPTION 'Achievement IDs are immutable';
  END IF;
  threshold:=(NEW.trigger_conditions->>'target')::numeric;
  IF threshold IS NULL OR threshold<=0 OR threshold>'2147483647'::numeric OR threshold='NaN'::numeric THEN
    RAISE EXCEPTION 'Achievement target must be positive and fit the V1 counter range';
  END IF;
  EXECUTE format('SELECT is_modern FROM %I.achievement_definitions WHERE id=$1',ns) INTO marked USING NEW.achievement_id;
  IF marked IS FALSE THEN RAISE EXCEPTION 'Modern achievement ID collides with a preserved tiered definition: %',NEW.achievement_id; END IF;
  EXECUTE format('INSERT INTO %I.achievement_definitions(id,name_zh,description_zh,category,tiers,is_modern)
    VALUES($1,$2,$3,$4,$5,TRUE) ON CONFLICT(id) DO UPDATE SET name_zh=EXCLUDED.name_zh,
    description_zh=EXCLUDED.description_zh,category=EXCLUDED.category,tiers=EXCLUDED.tiers WHERE achievement_definitions.is_modern',ns)
    USING NEW.achievement_id,COALESCE(NEW.name->>'zh',NEW.name->>'en',NEW.achievement_id),
      COALESCE(NEW.description->>'zh',NEW.description->>'en'),NEW.category,
      jsonb_build_array(jsonb_build_object('tier',1,'target',threshold));
  RETURN NEW;
END
$bridge$;
REVOKE ALL ON FUNCTION minego_sync_achievement_catalog() FROM PUBLIC;
CREATE TRIGGER minego_achievement_catalog_bridge AFTER INSERT OR UPDATE OR DELETE ON achievements
  FOR EACH ROW EXECUTE FUNCTION minego_sync_achievement_catalog();
-- Reuse the actual trigger contract to adopt a compatible preexisting catalog.
UPDATE achievements SET achievement_id=achievement_id;

CREATE FUNCTION minego_sync_achievement_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $progress$
DECLARE ns TEXT:=TG_TABLE_SCHEMA; definition RECORD; threshold NUMERIC;
BEGIN
  EXECUTE format('SELECT is_modern,tiers FROM %I.achievement_definitions WHERE id=$1',ns) INTO definition USING NEW.achievement_id;
  IF definition.is_modern IS NULL THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Unknown achievement definition'; END IF;
  IF TG_OP='UPDATE' AND (OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.achievement_id IS DISTINCT FROM NEW.achievement_id) THEN
    RAISE EXCEPTION 'Achievement progress owner and identity are immutable';
  END IF;
  IF definition.is_modern THEN
    IF (TG_OP='INSERT' AND NEW.current_value<>0 AND NEW.progress=0) OR (TG_OP='UPDATE' AND NEW.current_value IS DISTINCT FROM OLD.current_value AND NEW.progress IS NOT DISTINCT FROM OLD.progress) THEN
      RAISE EXCEPTION 'Modern achievement progress is updated through its exact progress counter';
    END IF;
    EXECUTE format('SELECT (trigger_conditions->>''target'')::numeric FROM %I.achievements WHERE achievement_id=$1',ns) INTO threshold USING NEW.achievement_id;
    IF threshold IS NULL THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Missing modern achievement definition'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.target IS NOT NULL AND NEW.target IS DISTINCT FROM threshold THEN RAISE EXCEPTION 'Achievement target differs from its definition'; END IF;
      NEW.target:=threshold;
    ELSE
      IF NEW.target IS DISTINCT FROM OLD.target THEN RAISE EXCEPTION 'Existing achievement target is immutable'; END IF;
      IF OLD.completed AND NEW.progress IS DISTINCT FROM OLD.progress THEN RAISE EXCEPTION 'Completed achievement progress is immutable'; END IF;
      IF OLD.rewards_claimed AND (NOT NEW.rewards_claimed OR NEW.progress IS DISTINCT FROM OLD.progress) THEN
        RAISE EXCEPTION 'Claimed achievement progress and claim state are immutable';
      END IF;
    END IF;
    NEW.modern_achievement_id:=NEW.achievement_id;
    -- The modern numeric counter remains exact; the legacy integer projection is
    -- only for compatibility. Tiered records never use this projection.
    NEW.current_value:=floor(NEW.progress)::integer;
    NEW.completed:=NEW.progress>=NEW.target;
    NEW.current_tier:=CASE WHEN NEW.completed THEN 1 ELSE 0 END;
    IF NEW.completed THEN NEW.unlocked_at:=COALESCE(NEW.unlocked_at,LOCALTIMESTAMP); END IF;
    IF NEW.completed THEN
      IF TG_OP='INSERT' OR NOT OLD.completed THEN NEW.completed_at:=COALESCE(NEW.completed_at,LOCALTIMESTAMP); END IF;
    ELSE NEW.completed_at:=NULL; END IF;
  ELSE
    IF NEW.modern_achievement_id IS NOT NULL OR NEW.rewards_claimed THEN RAISE EXCEPTION 'Tiered achievements cannot claim modern rewards'; END IF;
    IF TG_OP='UPDATE' AND NEW.progress IS DISTINCT FROM OLD.progress AND NEW.current_value IS NOT DISTINCT FROM OLD.current_value THEN
      RAISE EXCEPTION 'Tiered achievement progress is updated through its original counter';
    END IF;
    NEW.progress:=NEW.current_value;
    SELECT max((tier->>'target')::numeric) INTO NEW.target FROM jsonb_array_elements(definition.tiers) tier;
    NEW.completed:=NEW.target IS NOT NULL AND NEW.progress>=NEW.target;
    -- Retain unknown legacy completion times instead of fabricating a date.
    NEW.completed_at:=NULL;
  END IF;
  RETURN NEW;
END
$progress$;
REVOKE ALL ON FUNCTION minego_sync_achievement_progress() FROM PUBLIC;
CREATE TRIGGER minego_achievement_progress_bridge BEFORE INSERT OR UPDATE ON user_achievements
  FOR EACH ROW EXECUTE FUNCTION minego_sync_achievement_progress();

-- migrate:down
DO $rollback$
DECLARE state RECORD;
BEGIN
  SELECT * INTO STRICT state FROM achievement_catalog_bridge_state WHERE id=TRUE;
  IF 'user_achievements'::regclass::oid<>state.progress_oid OR 'achievements'::regclass::oid<>state.catalog_oid THEN
    RAISE EXCEPTION 'Achievement bridge relation identity changed';
  END IF;
  LOCK TABLE user_achievements,achievements,achievement_definitions IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM achievements) OR EXISTS(SELECT 1 FROM user_achievements WHERE modern_achievement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Modern achievement data exists; retain the bridge or provide an explicit data-preserving reverse migration';
  END IF;
  DROP TRIGGER minego_achievement_progress_bridge ON user_achievements;
  DROP TRIGGER minego_achievement_catalog_bridge ON achievements;
  ALTER TABLE user_achievements DROP COLUMN modern_achievement_id,DROP COLUMN progress,DROP COLUMN target,
    DROP COLUMN completed,DROP COLUMN completed_at,DROP COLUMN rewards_claimed,DROP COLUMN rewards_claimed_at,DROP COLUMN created_at;
  ALTER TABLE achievement_definitions DROP COLUMN is_modern;
  IF state.owns_catalog THEN DROP TABLE achievements; END IF;
END
$rollback$;
DROP FUNCTION minego_sync_achievement_progress();
DROP FUNCTION minego_sync_achievement_catalog();
DROP TABLE achievement_catalog_bridge_state;
