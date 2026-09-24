-- migrate:up
-- 核心链路表的时间列改为 TIMESTAMPTZ（评审遗留缺陷：TIMESTAMP 无时区列的时区换算）
--
-- 问题：TIMESTAMP 存的是"数据库会话时区下的墙上时间"，node-postgres 读回时按 Node 进程时区解析。
-- 数据库时区与 Node 时区不一致（例如数据库为 Asia/Shanghai、进程为 UTC，或反之）时，
-- 所有时间偏移 8 小时：补给站连签判断、会话过期、活动起止、订单超时等都会出错。
-- 做法：按数据库当前 TimeZone 设置解释已有值（这些值由 NOW()/CURRENT_TIMESTAMP 在同一时区下写入），
-- 转为绝对时间 TIMESTAMPTZ；依赖这些列的视图先保存定义、删除，改完按原定义重建。
DO $tz$
DECLARE
  core_tables TEXT[] := ARRAY[
    'users', 'pokemon_instances', 'candy_inventory', 'pokedex_entries', 'spawn_points', 'wild_pokemon',
    'catch_sessions', 'catch_throws', 'pokestops', 'pokestop_spins', 'gyms', 'gym_defenders', 'gym_battles',
    'raids', 'raid_participants', 'friendships', 'friend_gifts', 'pokemon_trades', 'user_achievements',
    'daily_quests', 'orders', 'audit_logs', 'events', 'event_participations', 'player_inventory',
    'trainer_level_ups', 'gdpr_deletion_requests'];
  tz TEXT := current_setting('TimeZone');
  v RECORD;
  c RECORD;
  view_names TEXT[] := '{}';
  view_defs TEXT[] := '{}';
  view_kinds TEXT[] := '{}';
  index_defs TEXT[] := '{}';
  i INT;
BEGIN
  -- 1) 保存并删除依赖这些列的视图，以及依赖这些视图的外层视图（递归），外层先删
  FOR v IN
    WITH RECURSIVE deps AS (
      SELECT dv.oid, dv.relname::text AS relname, dv.relkind::text AS kind, 1 AS depth
        FROM pg_depend d
        JOIN pg_rewrite rw ON rw.oid = d.objid
        JOIN pg_class dv ON dv.oid = rw.ev_class AND dv.relkind IN ('v', 'm')
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       WHERE t.relname = ANY(core_tables)
         AND format_type(a.atttypid, a.atttypmod) = 'timestamp without time zone'
         AND dv.oid <> t.oid
      UNION
      SELECT v2.oid, v2.relname::text, v2.relkind::text, deps.depth + 1
        FROM deps
        JOIN pg_depend d2 ON d2.refobjid = deps.oid
        JOIN pg_rewrite rw2 ON rw2.oid = d2.objid
        JOIN pg_class v2 ON v2.oid = rw2.ev_class AND v2.relkind IN ('v', 'm')
       WHERE v2.oid <> deps.oid AND deps.depth < 20
    )
    SELECT oid, relname, kind, MAX(depth) AS depth FROM deps GROUP BY oid, relname, kind ORDER BY MAX(depth) DESC
  LOOP
    view_names := view_names || v.relname;
    view_defs := view_defs || pg_get_viewdef(v.oid);
    view_kinds := view_kinds || v.kind;
    IF v.kind = 'm' THEN
      -- 物化视图上的索引（REFRESH CONCURRENTLY 需要唯一索引）一并保存
      SELECT index_defs || COALESCE(array_agg(indexdef), '{}') INTO index_defs
        FROM pg_indexes WHERE schemaname = 'public' AND tablename = v.relname;
      EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS %I', v.relname);
    ELSE
      EXECUTE format('DROP VIEW IF EXISTS %I', v.relname);
    END IF;
  END LOOP;

  -- 2) 改列类型（默认值 NOW()/CURRENT_TIMESTAMP 对 TIMESTAMPTZ 同样适用）
  FOR c IN
    SELECT col.table_name, col.column_name
      FROM information_schema.columns col
      JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE col.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND col.table_name = ANY(core_tables)
       AND col.data_type = 'timestamp without time zone'
     ORDER BY col.table_name, col.column_name
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE %L',
                     c.table_name, c.column_name, c.column_name, tz);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '跳过 %.%：%', c.table_name, c.column_name, SQLERRM;
    END;
  END LOOP;

  -- 3) 按原定义重建视图：内层先建（与删除顺序相反）
  FOR i IN REVERSE COALESCE(array_length(view_names, 1), 0)..1 LOOP
    BEGIN
      IF view_kinds[i] = 'm' THEN
        EXECUTE format('CREATE MATERIALIZED VIEW %I AS %s', view_names[i], rtrim(view_defs[i], '; '));
      ELSE
        EXECUTE format('CREATE OR REPLACE VIEW %I AS %s', view_names[i], view_defs[i]);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '重建视图 % 失败（需人工处理）：%', view_names[i], SQLERRM;
    END;
  END LOOP;
  FOR i IN 1..COALESCE(array_length(index_defs, 1), 0) LOOP
    BEGIN
      EXECUTE index_defs[i];
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '重建物化视图索引失败：% (%)', index_defs[i], SQLERRM;
    END;
  END LOOP;
END $tz$;

-- migrate:down
-- 不回滚为 TIMESTAMP（会重新引入时区换算错误）
SELECT 1;
