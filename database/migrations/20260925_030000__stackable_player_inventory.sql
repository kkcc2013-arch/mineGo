-- migrate:up
-- 道具背包可堆叠入账（评审遗留缺陷：补给站掉落的浆果等道具从未入账，捕捉时也无法使用浆果）
--
-- 1) items 有两套主键约定：localization_layer 的 id（VARCHAR，如 'RAZZ_BERRY'）与道具系统的 item_id。
--    道具系统迁移只回填了当时已存在的行，之后插入的道具 item_id 为空，player_inventory 的外键引用不到。
DO $items$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'id') = 'character varying'
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'item_id') THEN
    UPDATE items SET item_id = id WHERE item_id IS NULL;
    CREATE OR REPLACE FUNCTION items_default_item_id() RETURNS trigger AS $f$
    BEGIN
      IF NEW.item_id IS NULL THEN NEW.item_id := NEW.id; END IF;
      RETURN NEW;
    END;
    $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_items_default_item_id ON items;
    CREATE TRIGGER trg_items_default_item_id BEFORE INSERT OR UPDATE ON items
      FOR EACH ROW EXECUTE FUNCTION items_default_item_id();
  END IF;
END $items$;

-- 2) 不占格子（slot_index 为空）的道具按 (用户, 道具) 堆叠，入账用 INSERT … ON CONFLICT 原子累加
--    先合并历史上可能存在的重复堆叠行
WITH dup AS (
  SELECT user_id, item_id, MIN(id) AS keep_id, SUM(quantity) AS total
    FROM player_inventory WHERE slot_index IS NULL
   GROUP BY user_id, item_id HAVING COUNT(*) > 1
)
UPDATE player_inventory p SET quantity = dup.total, updated_at = NOW()
  FROM dup WHERE p.id = dup.keep_id;
DELETE FROM player_inventory p
 USING (SELECT user_id, item_id, MIN(id) AS keep_id FROM player_inventory WHERE slot_index IS NULL
         GROUP BY user_id, item_id HAVING COUNT(*) > 1) d
 WHERE p.user_id = d.user_id AND p.item_id = d.item_id AND p.slot_index IS NULL AND p.id <> d.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_inventory_stack
  ON player_inventory (user_id, item_id) WHERE slot_index IS NULL;

-- migrate:down
DROP INDEX IF EXISTS uq_player_inventory_stack;
DROP TRIGGER IF EXISTS trg_items_default_item_id ON items;
DROP FUNCTION IF EXISTS items_default_item_id();
