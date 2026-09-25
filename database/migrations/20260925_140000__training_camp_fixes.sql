-- Epic E07：精灵训练营（REQ-00370）修正（幂等；表由 20260629_191000 创建）
--
-- 1) training_slots 的 UNIQUE(user_id, camp_id, slot_index) 让同一槽位训练结束后永远不能再用 → 改为只约束进行中的训练；
--    同一只精灵同时只能有一个进行中的训练
-- 2) 时间列改 TIMESTAMPTZ（原 TIMESTAMP 与 Node 进程时区不一致时进度/到点判断会偏移）；按数据库当前时区解释已有值
-- 3) 槽位增加评级列；训练加速道具入 items（库存走 player_inventory）

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'training_slots'::regclass AND contype = 'u'
              AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, camp_id, slot_index)' LOOP
    EXECUTE format('ALTER TABLE training_slots DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE training_slots ADD COLUMN IF NOT EXISTS rating VARCHAR(20);

-- 历史上的重复进行中记录（旧实现从未成功写入，理论上不存在）只保留最新一条
UPDATE training_slots t SET status = 'cancelled'
 WHERE status IN ('training', 'ready')
   AND EXISTS (SELECT 1 FROM training_slots o WHERE o.status IN ('training', 'ready') AND o.id <> t.id
                 AND ((o.pokemon_id = t.pokemon_id) OR (o.user_id = t.user_id AND o.camp_id = t.camp_id AND o.slot_index = t.slot_index))
                 AND o.started_at > t.started_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_slots_active_slot
  ON training_slots (user_id, camp_id, slot_index) WHERE status IN ('training', 'ready');
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_slots_active_pokemon
  ON training_slots (pokemon_id) WHERE status IN ('training', 'ready');
CREATE INDEX IF NOT EXISTS idx_training_slots_due ON training_slots (ends_at) WHERE status = 'training';

DO $$
DECLARE
  c RECORD;
  tz TEXT := current_setting('TimeZone');
BEGIN
  FOR c IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('training_slots', 'training_reports', 'user_training_camps', 'training_boosts')
              AND data_type = 'timestamp without time zone' LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE %L',
                   c.table_name, c.column_name, c.column_name, tz);
  END LOOP;
END $$;

INSERT INTO items (id, item_id, category, name_zh, name_en, description_zh, description_en, effect_type, effect_value, shop_price, is_premium)
VALUES
  ('TRAINING_TIMER_HALF', 'TRAINING_TIMER_HALF', 'training', '训练加速器', 'Training Timer', '训练营剩余时间减半', 'Halves the remaining training time', 'training_speedup', 0.5, 300, FALSE),
  ('TRAINING_TIMER_INSTANT', 'TRAINING_TIMER_INSTANT', 'training', '训练完成券', 'Instant Training Ticket', '训练营训练立即完成', 'Completes a training immediately', 'training_speedup', 0, 0, TRUE),
  ('TRAINING_EXP_DOUBLE', 'TRAINING_EXP_DOUBLE', 'training', '双倍经验训练券', 'Double Exp Training Ticket', '本次训练经验翻倍', 'Doubles the Exp. of this training', 'training_exp', 2, 500, FALSE)
ON CONFLICT (id) DO NOTHING;
