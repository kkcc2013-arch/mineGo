-- migrate:up
-- 历史迁移中大量"用户引用列"声明为 INTEGER/BIGINT（且没有外键，fix_fk_types 无法发现），而 users.id 是 UUID：
-- 这些表对真实用户一律写入失败（如活动参与 event_participations.user_id 导致 /v1/events 全部 500）。
-- 这里把所有此类列统一改为 UUID：
--   * 只处理普通表/分区父表（分区子表随父表一起改）；跳过 legacy_* 列（保留的旧数据列）；
--   * 列中已有非空数据的不改（整数值不可能对应 UUID 用户，需人工处理），只输出 NOTICE；
--   * 因视图依赖等原因改不了的列输出 NOTICE 并跳过，不中断迁移。
DO $conv$
DECLARE
  r RECORD;
  has_data BOOLEAN;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name, c.data_type, c.column_default
      FROM information_schema.columns c
      JOIN pg_class k ON k.relname = c.table_name
      JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = c.table_schema
     WHERE c.table_schema = 'public'
       AND k.relkind IN ('r', 'p') AND NOT k.relispartition
       AND c.data_type IN ('integer', 'bigint', 'smallint')
       AND c.column_name !~ '^legacy_'
       AND (c.column_name ~ '(^|_)user_id$'
            OR c.column_name IN ('sender_id', 'receiver_id', 'requester_id', 'reporter_id', 'player_id',
                                 'created_by', 'approved_by', 'reviewed_by', 'banned_by', 'inviter_id', 'invitee_id'))
     ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I IS NOT NULL)', r.table_name, r.column_name) INTO has_data;
    IF has_data THEN
      RAISE NOTICE '跳过 %.%（%）：已有非空整数数据，需人工迁移', r.table_name, r.column_name, r.data_type;
      CONTINUE;
    END IF;
    BEGIN
      IF r.column_default IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', r.table_name, r.column_name);
      END IF;
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE UUID USING NULL', r.table_name, r.column_name);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '跳过 %.%：%', r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;
END $conv$;

-- migrate:down
-- 不可逆（整数值无法对应 UUID 用户）；回滚无需操作
SELECT 1;
