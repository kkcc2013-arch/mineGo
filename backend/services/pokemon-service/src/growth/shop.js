/**
 * 成长道具商店：用金币购买成长类道具（非付费、shop_price > 0），库存走 player_inventory
 * 覆盖分类：growth（经验）、stamina（体力）、training（训练营）、special_training（特训）、awakening（觉醒）、
 * legacy（传承）、breeding（培育）、merge（合并）
 */
'use strict';

const { query, transaction } = require('../../../../shared/db');
const { addItems } = require('../../../../shared/inventory');
const { GrowthError, spendCurrency } = require('./common');

const CATEGORIES = Object.freeze(['growth', 'stamina', 'training', 'special_training', 'awakening', 'legacy', 'breeding', 'merge']);

async function list(userId, { category } = {}) {
  const cats = category ? [category].filter((c) => CATEGORIES.includes(c)) : CATEGORIES;
  if (!cats.length) throw new GrowthError('INVALID_CATEGORY', `未知的分类 ${category}`, 400);
  const { rows } = await query(
    `SELECT i.item_id AS "itemId", i.category, i.name_zh AS name, i.name_en AS "nameEn", i.description_zh AS description,
            i.rarity, i.shop_price AS price, i.is_premium AS premium,
            (NOT i.is_premium AND COALESCE(i.shop_price, 0) > 0) AS "forSale", COALESCE(pi.qty, 0)::int AS owned
       FROM items i
       LEFT JOIN (SELECT item_id, SUM(quantity) AS qty FROM player_inventory WHERE user_id = $1 GROUP BY item_id) pi ON pi.item_id = i.item_id
      WHERE i.category = ANY($2::text[])
      ORDER BY i.category, i.shop_price NULLS LAST, i.item_id`, [userId, cats]);
  return rows;
}

async function buy(userId, { itemId, quantity = 1 }, { categories = CATEGORIES } = {}) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new GrowthError('INVALID_PARAM', 'quantity 必须是 1~99', 400);
  if (typeof itemId !== 'string' || !itemId) throw new GrowthError('INVALID_ITEM', 'itemId 必填', 400);
  return transaction(async (client) => {
    const { rows: [it] } = await client.query(
      'SELECT item_id, category, shop_price, is_premium FROM items WHERE item_id = $1 AND category = ANY($2::text[])', [itemId, categories]);
    if (!it) throw new GrowthError('INVALID_ITEM', `商店没有这个道具：${itemId}`, 400);
    if (it.is_premium || !(Number(it.shop_price) > 0)) throw new GrowthError('NOT_FOR_SALE', '该道具不在商店出售', 400);
    const total = Number(it.shop_price) * qty;
    if (!(await spendCurrency(client, userId, 'coins', total))) throw new GrowthError('INSUFFICIENT_FUNDS', `金币不足（需要 ${total}）`, 400);
    const { credited } = await addItems(client, userId, [{ type: itemId, qty }]);
    if (!credited.length) throw new GrowthError('INVALID_ITEM', `道具未定义：${itemId}`, 400);
    return { itemId, category: it.category, quantity: qty, cost: { coins: total } };
  });
}

module.exports = { CATEGORIES, list, buy };
