/**
 * MarketplaceService - 精灵交换市场与竞价拍卖系统
 * 
 * 功能：
 * - 创建市场列表（固定价格/竞价拍卖）
 * - 出价与竞价管理
 * - 交易结算与手续费计算
 * - 反作弊检测
 * - 价格历史分析
 * 
 * @module MarketplaceService
 * @requires db
 * @requires logger
 * @requires redis
 */

const db = require('@pmg/shared/db');
const { createLogger } = require('@pmg/shared/logger');
const logger = createLogger('marketplace-service');
const { v4: uuidv4 } = require('uuid');

// 市场配置
const MARKETPLACE_CONFIG = {
  TAX_FIXED: 0.10, // 固定价格手续费 10%
  TAX_AUCTION: 0.12, // 拍卖手续费 12%
  MIN_FEE: 100, // 最低手续费
  HIGH_VALUE_THRESHOLD: 10000, // 高价值交易阈值
  MAX_DAILY_LISTINGS: 50, // 每日上架限制
  MAX_DAILY_TRANSACTIONS: 100, // 每日交易限制
  BID_INCREMENT: 0.05, // 最小加价幅度 5%
  AUCTION_EXTEND_TIME: 180, // 拍卖延长时间（秒）
  EXTEND_THRESHOLD: 300, // 延长触发阈值（秒）
};

/**
 * 市场服务类
 */
class MarketplaceService {
  constructor() {
    this.config = MARKETPLACE_CONFIG;
  }

  /**
   * 创建市场列表
   * @param {number} userId - 用户ID
   * @param {number} pokemonId - 精灵ID
   * @param {Object} listingData - 列表数据
   * @returns {Promise<Object>} 创建的列表
   */
  async createListing(userId, pokemonId, listingData) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 验证精灵所有权
      const pokemonResult = await client.query(
        'SELECT * FROM pokemon WHERE id = $1 AND owner_id = $2 AND is_frozen = false',
        [pokemonId, userId]
      );
      
      if (pokemonResult.rows.length === 0) {
        throw new Error('Pokemon not found or not owned by user');
      }
      
      const pokemon = pokemonResult.rows[0];
      
      // 2. 检查每日上架限制
      const todayListings = await client.query(
        `SELECT COUNT(*) FROM marketplace_listings 
         WHERE seller_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
        [userId]
      );
      
      if (parseInt(todayListings.rows[0].count) >= this.config.MAX_DAILY_LISTINGS) {
        throw new Error('Daily listing limit reached');
      }
      
      // 3. 验证价格合理性
      await this.validatePrice(listingData, pokemon, client);
      
      // 4. 计算过期时间
      const expiresAt = this.calculateExpiryTime(listingData.duration);
      
      // 5. 创建列表
      const listingId = uuidv4();
      const insertResult = await client.query(
        `INSERT INTO marketplace_listings 
         (listing_id, seller_id, pokemon_id, listing_type, fixed_price, 
          starting_bid, buyout_price, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
         RETURNING *`,
        [
          listingId,
          userId,
          pokemonId,
          listingData.listingType,
          listingData.listingType === 'fixed' ? listingData.fixedPrice : null,
          listingData.listingType === 'auction' ? listingData.startingBid : null,
          listingData.buyoutPrice || null,
          expiresAt
        ]
      );
      
      const listing = insertResult.rows[0];
      
      // 6. 冻结精灵（防止重复交易）
      await client.query(
        'UPDATE pokemon SET is_frozen = true WHERE id = $1',
        [pokemonId]
      );
      
      // 7. 更新用户统计
      await client.query(
        `INSERT INTO marketplace_user_stats (user_id, total_listings, last_listing_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (user_id) 
         DO UPDATE SET 
             total_listings = marketplace_user_stats.total_listings + 1,
             last_listing_at = NOW()`,
        [userId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Marketplace listing created', {
        listingId,
        userId,
        pokemonId,
        type: listingData.listingType
      });
      
      return listing;
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to create marketplace listing', {
        userId,
        pokemonId,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 出价（拍卖模式）
   * @param {number} userId - 用户ID
   * @param {string} listingId - 列表ID
   * @param {number} bidAmount - 出价金额
   * @param {number} autoBidMax - 自动出价最大值（可选）
   * @returns {Promise<Object>} 出价结果
   */
  async placeBid(userId, listingId, bidAmount, autoBidMax = null) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取列表信息（加锁）
      const listingResult = await client.query(
        'SELECT * FROM marketplace_listings WHERE listing_id = $1 AND status = $2 FOR UPDATE',
        [listingId, 'active']
      );
      
      if (listingResult.rows.length === 0) {
        throw new Error('Listing not found or not active');
      }
      
      const listing = listingResult.rows[0];
      
      if (listing.listing_type !== 'auction') {
        throw new Error('This listing is not an auction');
      }
      
      // 2. 验证拍卖时间
      if (new Date() >= new Date(listing.expires_at)) {
        throw new Error('Auction has ended');
      }
      
      // 3. 验证卖家不能出价
      if (listing.seller_id === userId) {
        throw new Error('Seller cannot bid on their own listing');
      }
      
      // 4. 验证出价金额
      const minBid = listing.current_highest_bid > 0 
        ? Math.floor(listing.current_highest_bid * (1 + this.config.BID_INCREMENT))
        : listing.starting_bid;
      
      if (bidAmount < minBid) {
        throw new Error(`Minimum bid is ${minBid}`);
      }
      
      // 5. 检查一口价
      if (listing.buyout_price && bidAmount >= listing.buyout_price) {
        const result = await this.executeBuyout(client, listing, userId, listing.buyout_price);
        await client.query('COMMIT');
        return result;
      }
      
      // 6. 检查用户余额
      const userBalance = await this.getUserBalance(userId, client);
      if (userBalance < bidAmount) {
        throw new Error('Insufficient balance');
      }
      
      // 7. 创建出价记录
      const bidId = uuidv4();
      await client.query(
        `INSERT INTO marketplace_bids 
         (bid_id, listing_id, bidder_id, bid_amount, is_auto_bid, max_auto_bid, is_winning)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [
          bidId,
          listing.id,
          userId,
          bidAmount,
          autoBidMax !== null,
          autoBidMax
        ]
      );
      
      // 8. 更新列表最高出价
      await client.query(
        `UPDATE marketplace_listings 
         SET current_highest_bid = $1, current_highest_bidder_id = $2, 
             bid_count = bid_count + 1
         WHERE id = $3`,
        [bidAmount, userId, listing.id]
      );
      
      // 9. 更新之前最高出价为非获胜
      await client.query(
        `UPDATE marketplace_bids 
         SET is_winning = false 
         WHERE listing_id = $1 AND bidder_id != $2 AND is_winning = true`,
        [listing.id, userId]
      );
      
      // 10. 检查是否需要延长拍卖时间
      const now = new Date();
      const expiresAt = new Date(listing.expires_at);
      const remainingSeconds = (expiresAt - now) / 1000;
      
      if (remainingSeconds < this.config.EXTEND_THRESHOLD) {
        const newExpiresAt = new Date(expiresAt.getTime() + this.config.AUCTION_EXTEND_TIME * 1000);
        await client.query(
          'UPDATE marketplace_listings SET expires_at = $1 WHERE id = $2',
          [newExpiresAt, listing.id]
        );
      }
      
      await client.query('COMMIT');
      
      logger.info('Bid placed successfully', {
        bidId,
        listingId,
        userId,
        amount: bidAmount
      });
      
      return {
        bidId,
        listingId,
        bidAmount,
        isWinning: true
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to place bid', {
        userId,
        listingId,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 执行一口价购买
   * @param {Object} client - 数据库客户端
   * @param {Object} listing - 列表对象
   * @param {number} buyerId - 买家ID
   * @param {number} price - 购买价格
   * @returns {Promise<Object>} 交易结果
   */
  async executeBuyout(client, listing, buyerId, price) {
    // 1. 检查用户余额
    const userBalance = await this.getUserBalance(buyerId, client);
    if (userBalance < price) {
      throw new Error('Insufficient balance');
    }
    
    // 2. 计算手续费
    const feeAmount = Math.max(
      Math.floor(price * this.config.TAX_AUCTION),
      this.config.MIN_FEE
    );
    
    // 3. 扣除买家余额
    await this.deductBalance(buyerId, price, client);
    
    // 4. 增加卖家余额
    const sellerEarning = price - feeAmount;
    await this.addBalance(listing.seller_id, sellerEarning, client);
    
    // 5. 创建交易记录
    const transactionId = uuidv4();
    await client.query(
      `INSERT INTO marketplace_transactions 
       (transaction_id, listing_id, seller_id, buyer_id, pokemon_id, 
        final_price, fee_amount, transaction_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'auction')`,
      [
        transactionId,
        listing.id,
        listing.seller_id,
        buyerId,
        listing.pokemon_id,
        price,
        feeAmount
      ]
    );
    
    // 6. 更新列表状态
    await client.query(
      `UPDATE marketplace_listings 
       SET status = 'sold', sold_at = NOW(), current_highest_bid = $1,
           current_highest_bidder_id = $2
       WHERE id = $3`,
      [price, buyerId, listing.id]
    );
    
    // 7. 转移精灵所有权
    await client.query(
      'UPDATE pokemon SET owner_id = $1, is_frozen = false WHERE id = $2',
      [buyerId, listing.pokemon_id]
    );
    
    // 8. 更新用户统计
    await this.updateUserStats(listing.seller_id, buyerId, price, feeAmount, client);
    
    // 9. 更新价格历史
    await this.updatePriceHistory(listing.pokemon_id, price, client);
    
    logger.info('Buyout executed successfully', {
      transactionId,
      listingId: listing.listing_id,
      sellerId: listing.seller_id,
      buyerId,
      price
    });
    
    return {
      transactionId,
      success: true
    };
  }

  /**
   * 固定价格购买
   * @param {number} userId - 用户ID
   * @param {string} listingId - 列表ID
   * @returns {Promise<Object>} 交易结果
   */
  async purchaseFixedPrice(userId, listingId) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取列表信息（加锁）
      const listingResult = await client.query(
        'SELECT * FROM marketplace_listings WHERE listing_id = $1 AND status = $2 FOR UPDATE',
        [listingId, 'active']
      );
      
      if (listingResult.rows.length === 0) {
        throw new Error('Listing not found or not active');
      }
      
      const listing = listingResult.rows[0];
      
      if (listing.listing_type !== 'fixed') {
        throw new Error('This listing is not a fixed price listing');
      }
      
      // 2. 验证卖家不能购买
      if (listing.seller_id === userId) {
        throw new Error('Seller cannot purchase their own listing');
      }
      
      // 3. 检查用户余额
      const userBalance = await this.getUserBalance(userId, client);
      if (userBalance < listing.fixed_price) {
        throw new Error('Insufficient balance');
      }
      
      // 4. 计算手续费
      const feeAmount = Math.max(
        Math.floor(listing.fixed_price * this.config.TAX_FIXED),
        this.config.MIN_FEE
      );
      
      // 5. 扣除买家余额
      await this.deductBalance(userId, listing.fixed_price, client);
      
      // 6. 增加卖家余额
      const sellerEarning = listing.fixed_price - feeAmount;
      await this.addBalance(listing.seller_id, sellerEarning, client);
      
      // 7. 创建交易记录
      const transactionId = uuidv4();
      await client.query(
        `INSERT INTO marketplace_transactions 
         (transaction_id, listing_id, seller_id, buyer_id, pokemon_id, 
          final_price, fee_amount, transaction_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'fixed')`,
        [
          transactionId,
          listing.id,
          listing.seller_id,
          userId,
          listing.pokemon_id,
          listing.fixed_price,
          feeAmount
        ]
      );
      
      // 8. 更新列表状态
      await client.query(
        `UPDATE marketplace_listings 
         SET status = 'sold', sold_at = NOW()
         WHERE id = $1`,
        [listing.id]
      );
      
      // 9. 转移精灵所有权
      await client.query(
        'UPDATE pokemon SET owner_id = $1, is_frozen = false WHERE id = $2',
        [userId, listing.pokemon_id]
      );
      
      // 10. 更新用户统计
      await this.updateUserStats(listing.seller_id, userId, listing.fixed_price, feeAmount, client);
      
      // 11. 更新价格历史
      await this.updatePriceHistory(listing.pokemon_id, listing.fixed_price, client);
      
      await client.query('COMMIT');
      
      logger.info('Fixed price purchase completed', {
        transactionId,
        listingId,
        sellerId: listing.seller_id,
        buyerId: userId,
        price: listing.fixed_price
      });
      
      return {
        transactionId,
        success: true
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to purchase fixed price listing', {
        userId,
        listingId,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 搜索市场列表
   * @param {Object} filters - 筛选条件
   * @param {number} page - 页码
   * @param {number} limit - 每页数量
   * @returns {Promise<Object>} 搜索结果
   */
  async searchListings(filters = {}, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const conditions = ['status = $1'];
    const params = ['active'];
    let paramIndex = 2;
    
    // 构建查询条件
    if (filters.pokemonSpecies) {
      conditions.push(`pokemon_id IN (SELECT id FROM pokemon WHERE species_id = $${paramIndex})`);
      params.push(filters.pokemonSpecies);
      paramIndex++;
    }
    
    if (filters.listingType) {
      conditions.push(`listing_type = $${paramIndex}`);
      params.push(filters.listingType);
      paramIndex++;
    }
    
    if (filters.minPrice) {
      conditions.push(`COALESCE(fixed_price, current_highest_bid) >= $${paramIndex}`);
      params.push(filters.minPrice);
      paramIndex++;
    }
    
    if (filters.maxPrice) {
      conditions.push(`COALESCE(fixed_price, current_highest_bid) <= $${paramIndex}`);
      params.push(filters.maxPrice);
      paramIndex++;
    }
    
    // 构建排序
    let orderBy = 'created_at DESC';
    if (filters.sortBy === 'price_asc') {
      orderBy = 'COALESCE(fixed_price, current_highest_bid) ASC';
    } else if (filters.sortBy === 'price_desc') {
      orderBy = 'COALESCE(fixed_price, current_highest_bid) DESC';
    } else if (filters.sortBy === 'ending_soon') {
      orderBy = 'expires_at ASC';
    }
    
    const query = `
      SELECT 
        ml.*,
        p.species_id,
        p.cp,
        p.level,
        ps.name as species_name,
        u.username as seller_name
      FROM marketplace_listings ml
      JOIN pokemon p ON ml.pokemon_id = p.id
      JOIN pokemon_species ps ON p.species_id = ps.id
      JOIN users u ON ml.seller_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // 获取总数
    const countQuery = `
      SELECT COUNT(*) FROM marketplace_listings
      WHERE ${conditions.join(' AND ')}
    `;
    const countResult = await db.query(countQuery, params.slice(0, -2));
    
    return {
      listings: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
    };
  }

  /**
   * 取消市场列表
   * @param {number} userId - 用户ID
   * @param {string} listingId - 列表ID
   * @returns {Promise<Object>} 取消结果
   */
  async cancelListing(userId, listingId) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取列表信息
      const listingResult = await client.query(
        'SELECT * FROM marketplace_listings WHERE listing_id = $1 FOR UPDATE',
        [listingId]
      );
      
      if (listingResult.rows.length === 0) {
        throw new Error('Listing not found');
      }
      
      const listing = listingResult.rows[0];
      
      // 2. 验证所有权
      if (listing.seller_id !== userId) {
        throw new Error('Not authorized to cancel this listing');
      }
      
      // 3. 验证状态
      if (listing.status !== 'active') {
        throw new Error('Listing is not active');
      }
      
      // 4. 更新列表状态
      await client.query(
        'UPDATE marketplace_listings SET status = $1 WHERE id = $2',
        ['cancelled', listing.id]
      );
      
      // 5. 解冻精灵
      await client.query(
        'UPDATE pokemon SET is_frozen = false WHERE id = $1',
        [listing.pokemon_id]
      );
      
      await client.query('COMMIT');
      
      logger.info('Listing cancelled', {
        listingId,
        userId
      });
      
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 计算过期时间
   * @param {string} duration - 时长（1h/6h/24h/7d）
   * @returns {Date} 过期时间
   */
  calculateExpiryTime(duration) {
    const now = new Date();
    const durationMap = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000
    };
    
    const ms = durationMap[duration] || durationMap['24h'];
    return new Date(now.getTime() + ms);
  }

  /**
   * 获取用户余额
   * @param {number} userId - 用户ID
   * @param {Object} client - 数据库客户端
   * @returns {Promise<number>} 余额
   */
  async getUserBalance(userId, client = null) {
    const query = 'SELECT coins FROM users WHERE id = $1';
    const result = client 
      ? await client.query(query, [userId])
      : await db.query(query, [userId]);
    
    return result.rows[0]?.coins || 0;
  }

  /**
   * 扣除用户余额
   * @param {number} userId - 用户ID
   * @param {number} amount - 金额
   * @param {Object} client - 数据库客户端
   */
  async deductBalance(userId, amount, client) {
    await client.query(
      'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1',
      [amount, userId]
    );
  }

  /**
   * 增加用户余额
   * @param {number} userId - 用户ID
   * @param {number} amount - 金额
   * @param {Object} client - 数据库客户端
   */
  async addBalance(userId, amount, client) {
    await client.query(
      'UPDATE users SET coins = coins + $1 WHERE id = $2',
      [amount, userId]
    );
  }

  /**
   * 更新用户统计
   * @param {number} sellerId - 卖家ID
   * @param {number} buyerId - 买家ID
   * @param {number} price - 价格
   * @param {number} fee - 手续费
   * @param {Object} client - 数据库客户端
   */
  async updateUserStats(sellerId, buyerId, price, fee, client) {
    // 更新卖家统计
    await client.query(
      `INSERT INTO marketplace_user_stats (user_id, total_sales, total_earned, total_fees_paid, last_transaction_at)
       VALUES ($1, 1, $2, $3, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
           total_sales = marketplace_user_stats.total_sales + 1,
           total_earned = marketplace_user_stats.total_earned + $2,
           total_fees_paid = marketplace_user_stats.total_fees_paid + $3,
           last_transaction_at = NOW()`,
      [sellerId, price - fee, fee]
    );
    
    // 更新买家统计
    await client.query(
      `INSERT INTO marketplace_user_stats (user_id, total_purchases, total_spent, last_transaction_at)
       VALUES ($1, 1, $2, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
           total_purchases = marketplace_user_stats.total_purchases + 1,
           total_spent = marketplace_user_stats.total_spent + $2,
           last_transaction_at = NOW()`,
      [buyerId, price]
    );
  }

  /**
   * 更新价格历史
   * @param {number} pokemonId - 精灵ID
   * @param {number} price - 价格
   * @param {Object} client - 数据库客户端
   */
  async updatePriceHistory(pokemonId, price, client) {
    // 获取物种ID
    const pokemonResult = await client.query(
      'SELECT species_id FROM pokemon WHERE id = $1',
      [pokemonId]
    );
    
    if (pokemonResult.rows.length === 0) return;
    
    const speciesId = pokemonResult.rows[0].species_id;
    const today = new Date().toISOString().split('T')[0];
    
    // 更新或插入价格历史
    await client.query(
      `INSERT INTO marketplace_price_history 
       (pokemon_species_id, avg_price, min_price, max_price, transaction_count, recorded_date)
       VALUES ($1, $2, $2, $2, 1, $3)
       ON CONFLICT (pokemon_species_id, recorded_date)
       DO UPDATE SET
           avg_price = (marketplace_price_history.avg_price * marketplace_price_history.transaction_count + $2) / 
                       (marketplace_price_history.transaction_count + 1),
           min_price = LEAST(marketplace_price_history.min_price, $2),
           max_price = GREATEST(marketplace_price_history.max_price, $2),
           transaction_count = marketplace_price_history.transaction_count + 1`,
      [speciesId, price, today]
    );
  }

  /**
   * 验证价格合理性（反作弊）
   * @param {Object} listingData - 列表数据
   * @param {Object} pokemon - 精灵对象
   * @param {Object} client - 数据库客户端
   */
  async validatePrice(listingData, pokemon, client) {
    const price = listingData.listingType === 'fixed' 
      ? listingData.fixedPrice 
      : listingData.startingBid;
    
    // 获取该物种的历史平均价格
    const priceHistoryResult = await client.query(
      `SELECT avg_price, min_price, max_price 
       FROM marketplace_price_history 
       WHERE pokemon_species_id = $1 
       ORDER BY recorded_date DESC 
       LIMIT 1`,
      [pokemon.species_id]
    );
    
    if (priceHistoryResult.rows.length > 0) {
      const history = priceHistoryResult.rows[0];
      const minAcceptablePrice = history.avg_price * 0.3; // 不低于平均价 30%
      
      if (price < minAcceptablePrice) {
        logger.warn('Suspicious low price listing detected', {
          pokemonId: pokemon.id,
          price,
          avgPrice: history.avg_price
        });
        // 不阻止交易，但记录日志用于人工审核
      }
    }
    
    // 检查高价值交易
    if (price >= this.config.HIGH_VALUE_THRESHOLD) {
      logger.info('High value listing created', {
        pokemonId: pokemon.id,
        price,
        sellerId: pokemon.owner_id
      });
    }
  }
}

module.exports = new MarketplaceService();
