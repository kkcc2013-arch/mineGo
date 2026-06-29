/**
 * 道具测试数据工厂
 */

const { v4: uuidv4 } = require('uuid');

class ItemFactory {
  constructor(dbPool) {
    this.dbPool = dbPool;
    
    // 默认道具类型
    this.itemTypes = {
      'pokeball': { name: 'Poke Ball', category: 'ball', price: 100, effect: 'catch_rate_boost', value: 1.0 },
      'greatball': { name: 'Great Ball', category: 'ball', price: 300, effect: 'catch_rate_boost', value: 1.5 },
      'ultraball': { name: 'Ultra Ball', category: 'ball', price: 600, effect: 'catch_rate_boost', value: 2.0 },
      'masterball': { name: 'Master Ball', category: 'ball', price: 0, effect: 'catch_rate_boost', value: 255 },
      'potion': { name: 'Potion', category: 'medicine', price: 100, effect: 'heal_hp', value: 20 },
      'super_potion': { name: 'Super Potion', category: 'medicine', price: 300, effect: 'heal_hp', value: 50 },
      'hyper_potion': { name: 'Hyper Potion', category: 'medicine', price: 600, effect: 'heal_hp', value: 200 },
      'revive': { name: 'Revive', category: 'medicine', price: 500, effect: 'revive', value: 50 },
      'razz_berry': { name: 'Razz Berry', category: 'berry', price: 50, effect: 'catch_rate_boost', value: 1.5 },
      'pinap_berry': { name: 'Pinap Berry', category: 'berry', price: 50, effect: 'candy_boost', value: 2.0 },
      'incense': { name: 'Incense', category: 'enhancement', price: 1000, effect: 'spawn_boost', value: 1.5 },
      'lure_module': { name: 'Lure Module', category: 'enhancement', price: 1000, effect: 'lure_spawn', value: 1.0 },
      'lucky_egg': { name: 'Lucky Egg', category: 'enhancement', price: 500, effect: 'exp_boost', value: 2.0 }
    };
  }

  /**
   * 创建道具
   */
  async create(overrides = {}) {
    const itemId = overrides.itemId || uuidv4();
    const itemType = overrides.itemType || 'pokeball';
    const itemData = this.itemTypes[itemType] || this.itemTypes['pokeball'];
    
    const item = {
      id: itemId,
      userId: overrides.userId || uuidv4(),
      itemType,
      itemName: overrides.itemName || itemData.name,
      category: overrides.category || itemData.category,
      quantity: overrides.quantity || 1,
      maxStack: overrides.maxStack || 999,
      price: overrides.price || itemData.price,
      effect: overrides.effect || itemData.effect,
      effectValue: overrides.effectValue || itemData.value,
      rarity: overrides.rarity || 'common',
      tradable: overrides.tradable || true,
      sellable: overrides.sellable || true,
      expiresAt: overrides.expiresAt || null,
      metadata: overrides.metadata || {},
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO items (
        id, user_id, item_type, item_name, category, quantity, max_stack,
        price, effect, effect_value, rarity, tradable, sellable,
        expires_at, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        item.id, item.userId, item.itemType, item.itemName, item.category,
        item.quantity, item.maxStack, item.price, item.effect, item.effectValue,
        item.rarity, item.tradable, item.sellable, item.expiresAt,
        JSON.stringify(item.metadata), item.createdAt, item.updatedAt
      ]
    );

    return item;
  }

  /**
   * 批量创建道具
   */
  async createBatch(items) {
    const createdItems = [];
    for (const item of items) {
      createdItems.push(await this.create(item));
    }
    return createdItems;
  }

  /**
   * 创建用户背包
   */
  async createUserInventory(userId) {
    const inventory = {};
    
    // 创建各类球
    inventory.balls = await this.createBatch([
      { userId, itemType: 'pokeball', quantity: 50 },
      { userId, itemType: 'greatball', quantity: 20 },
      { userId, itemType: 'ultraball', quantity: 10 },
      { userId, itemType: 'masterball', quantity: 1 }
    ]);
    
    // 创建药品
    inventory.medicine = await this.createBatch([
      { userId, itemType: 'potion', quantity: 30 },
      { userId, itemType: 'super_potion', quantity: 15 },
      { userId, itemType: 'hyper_potion', quantity: 5 },
      { userId, itemType: 'revive', quantity: 10 }
    ]);
    
    // 创建树果
    inventory.berries = await this.createBatch([
      { userId, itemType: 'razz_berry', quantity: 20 },
      { userId, itemType: 'pinap_berry', quantity: 15 }
    ]);
    
    // 创建增强道具
    inventory.enhancements = await this.createBatch([
      { userId, itemType: 'incense', quantity: 5 },
      { userId, itemType: 'lure_module', quantity: 3 },
      { userId, itemType: 'lucky_egg', quantity: 10 }
    ]);
    
    return inventory;
  }

  /**
   * 查询用户道具
   */
  async getUserItems(userId, category = null) {
    let query = 'SELECT * FROM items WHERE user_id = $1';
    const params = [userId];
    
    if (category) {
      query += ' AND category = $2';
      params.push(category);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await this.dbPool.query(query, params);
    return result.rows;
  }

  /**
   * 更新道具数量
   */
  async updateQuantity(itemId, delta) {
    await this.dbPool.query(
      `UPDATE items SET quantity = GREATEST(0, quantity + $1), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [delta, itemId]
    );
  }

  /**
   * 删除道具
   */
  async deleteItem(itemId) {
    await this.dbPool.query('DELETE FROM items WHERE id = $1', [itemId]);
  }

  /**
   * 清理用户道具
   */
  async clearUserItems(userId) {
    await this.dbPool.query('DELETE FROM items WHERE user_id = $1', [userId]);
  }
}

module.exports = ItemFactory;