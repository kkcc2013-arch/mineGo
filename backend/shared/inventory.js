/**
 * 道具入账/扣减（在调用方的事务 client 中执行）
 *
 * 精灵球沿用 users 上的计数列（捕捉主链路一直这样用）；其余道具（浆果、药水…）写入 player_inventory，
 * 不占格子的道具按 (user_id, item_id) 堆叠（唯一索引 uq_player_inventory_stack，见 20260925_030000 迁移）。
 */
'use strict';

const BALL_COLUMNS = Object.freeze({
  POKE_BALL: 'pokeball_count',
  GREAT_BALL: 'greatball_count',
  ULTRA_BALL: 'ultraball_count',
  MASTER_BALL: 'masterball_count',
});

/**
 * 入账一组道具 [{ type, qty }]，返回实际入账的明细（未知道具跳过并返回在 skipped 中）
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {Array<{type: string, qty: number}>} items
 */
async function addItems(client, userId, items) {
  const credited = [];
  const skipped = [];
  const merged = new Map();
  for (const it of items || []) {
    const qty = Math.floor(Number(it.qty ?? it.quantity ?? 0));
    if (!it || !it.type || !(qty > 0)) continue;
    merged.set(it.type, (merged.get(it.type) || 0) + qty);
  }
  for (const [type, qty] of merged) {
    const col = BALL_COLUMNS[type];
    if (col) {
      await client.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [qty, userId]);
      credited.push({ type, qty });
      continue;
    }
    // 只入账 items 中已定义的道具（外键 player_inventory.item_id → items.item_id）
    const { rowCount } = await client.query(
      `INSERT INTO player_inventory (user_id, item_id, quantity, acquired_at, created_at, updated_at)
       SELECT $1, i.item_id, $3, NOW(), NOW(), NOW() FROM items i WHERE i.item_id = $2
       ON CONFLICT (user_id, item_id) WHERE slot_index IS NULL
       DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [userId, type, qty],
    );
    if (rowCount) credited.push({ type, qty });
    else skipped.push({ type, qty });
  }
  return { credited, skipped };
}

/**
 * 原子扣减一个可堆叠道具；数量不足返回 false（不会扣成负数）
 */
async function consumeItem(client, userId, itemId, qty = 1) {
  const col = BALL_COLUMNS[itemId];
  if (col) {
    const { rowCount } = await client.query(
      `UPDATE users SET ${col} = ${col} - $1 WHERE id = $2 AND ${col} >= $1`, [qty, userId]);
    return rowCount === 1;
  }
  // quantity 有 CHECK (quantity > 0)：扣到 0 时删除该堆叠行
  const { rows } = await client.query(
    `WITH upd AS (
       UPDATE player_inventory SET quantity = quantity - $3, updated_at = NOW()
        WHERE user_id = $1 AND item_id = $2 AND slot_index IS NULL AND quantity > $3
        RETURNING 1
     ), del AS (
       DELETE FROM player_inventory
        WHERE user_id = $1 AND item_id = $2 AND slot_index IS NULL AND quantity = $3
          AND NOT EXISTS (SELECT 1 FROM upd)
        RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM upd) + (SELECT COUNT(*) FROM del) AS n`,
    [userId, itemId, qty],
  );
  return Number(rows[0].n) === 1;
}

/** 查询可堆叠道具数量（不含精灵球） */
async function getStackableItems(queryable, userId) {
  const { rows } = await queryable.query(
    `SELECT item_id, quantity FROM player_inventory
      WHERE user_id = $1 AND slot_index IS NULL AND quantity > 0 ORDER BY item_id`, [userId]);
  return rows.map((r) => ({ itemId: r.item_id, quantity: Number(r.quantity) }));
}

module.exports = { BALL_COLUMNS, addItems, consumeItem, getStackableItems };
