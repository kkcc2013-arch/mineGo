# REQ-00104: 精灵交换市场与竞价拍卖系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00104 |
| 标题 | 精灵交换市场与竞价拍卖系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-11 04:30 |

## 需求描述

实现一个完整的精灵交换市场系统，支持玩家之间通过市场交易精灵。包含固定价格交易和竞价拍卖两种模式，提供搜索、筛选、收藏、出价等功能，并集成交易税、反作弊检测等保护机制。

### 核心功能

1. **市场列表系统**
   - 玩家可将精灵上架到市场
   - 支持固定价格（一口价）和竞价拍卖两种模式
   - 设置上架时长（1小时/6小时/24小时/7天）
   - 批量上架管理

2. **竞价拍卖系统**
   - 实时竞价功能
   - 自动出价代理（设置最高价自动跟价）
   - 拍卖倒计时与延长机制（最后5分钟有人出价延长3分钟）
   - 流拍处理与返还

3. **市场搜索与筛选**
   - 按精灵种类、等级、CP、稀有度筛选
   - 按价格、上架时间、剩余时间排序
   - 关键词搜索（精灵名称/技能）
   - 高级筛选（个体值、闪光、技能组合）

4. **交易税与手续费**
   - 固定价格交易：10% 手续费
   - 竞价拍卖：12% 手续费（最低 100 星尘）
   - 高价值精灵额外保护（超过 10000 星尘需额外验证）

5. **反作弊与风控**
   - 异常价格检测（明显低于市场价触发审核）
   - 频繁交易限制（每日交易上限）
   - 关联账号交易检测
   - 洗钱行为检测

## 技术方案

### 1. 数据库设计

```sql
-- 市场列表表
CREATE TABLE marketplace_listings (
    id SERIAL PRIMARY KEY,
    listing_id VARCHAR(36) UNIQUE NOT NULL,
    seller_id INTEGER NOT NULL REFERENCES users(id),
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
    
    -- 交易类型
    listing_type VARCHAR(20) NOT NULL, -- 'fixed' | 'auction'
    
    -- 定价信息
    fixed_price INTEGER, -- 一口价模式的价格
    starting_bid INTEGER, -- 拍卖模式的起拍价
    buyout_price INTEGER, -- 拍卖模式的一口价（可选）
    
    -- 拍卖信息
    current_highest_bid INTEGER DEFAULT 0,
    current_highest_bidder_id INTEGER REFERENCES users(id),
    bid_count INTEGER DEFAULT 0,
    
    -- 时间信息
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    sold_at TIMESTAMP WITH TIME ZONE,
    
    -- 状态
    status VARCHAR(20) DEFAULT 'active', -- 'active' | 'sold' | 'expired' | 'cancelled'
    
    -- 其他
    featured BOOLEAN DEFAULT false,
    view_count INTEGER DEFAULT 0,
    
    INDEX idx_seller_id (seller_id),
    INDEX idx_pokemon_id (pokemon_id),
    INDEX idx_status_expires (status, expires_at),
    INDEX idx_listing_type_price (listing_type, fixed_price, current_highest_bid)
);

-- 竞价记录表
CREATE TABLE marketplace_bids (
    id SERIAL PRIMARY KEY,
    bid_id VARCHAR(36) UNIQUE NOT NULL,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id),
    bidder_id INTEGER NOT NULL REFERENCES users(id),
    bid_amount INTEGER NOT NULL,
    is_auto_bid BOOLEAN DEFAULT false,
    max_auto_bid INTEGER, -- 自动出价的最大值
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_winning BOOLEAN DEFAULT false,
    
    INDEX idx_listing_bidder (listing_id, bidder_id),
    INDEX idx_bidder_created (bidder_id, created_at)
);

-- 市场收藏表
CREATE TABLE marketplace_favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, listing_id),
    INDEX idx_user_favorites (user_id)
);

-- 市场交易历史表
CREATE TABLE marketplace_transactions (
    id SERIAL PRIMARY KEY,
    transaction_id VARCHAR(36) UNIQUE NOT NULL,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id),
    seller_id INTEGER NOT NULL REFERENCES users(id),
    buyer_id INTEGER NOT NULL REFERENCES users(id),
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
    final_price INTEGER NOT NULL,
    fee_amount INTEGER NOT NULL,
    transaction_type VARCHAR(20) NOT NULL, -- 'fixed' | 'auction'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_seller_transactions (seller_id, created_at),
    INDEX idx_buyer_transactions (buyer_id, created_at),
    INDEX idx_pokemon_transactions (pokemon_id)
);

-- 市场价格历史表（用于价格趋势分析）
CREATE TABLE marketplace_price_history (
    id SERIAL PRIMARY KEY,
    pokemon_species_id INTEGER NOT NULL,
    avg_price INTEGER,
    min_price INTEGER,
    max_price INTEGER,
    transaction_count INTEGER,
    recorded_date DATE NOT NULL,
    
    UNIQUE(pokemon_species_id, recorded_date),
    INDEX idx_species_date (pokemon_species_id, recorded_date)
);

-- 用户市场统计表
CREATE TABLE marketplace_user_stats (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    total_listings INTEGER DEFAULT 0,
    total_sales INTEGER DEFAULT 0,
    total_purchases INTEGER DEFAULT 0,
    total_earned INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0,
    total_fees_paid INTEGER DEFAULT 0,
    rating_score DECIMAL(3,2) DEFAULT 5.00,
    rating_count INTEGER DEFAULT 0,
    last_listing_at TIMESTAMP WITH TIME ZONE,
    last_transaction_at TIMESTAMP WITH TIME ZONE,
    
    INDEX idx_total_sales (total_sales DESC),
    INDEX idx_total_earned (total_earned DESC)
);
```

### 2. 核心服务实现

```javascript
// backend/services/social-service/src/marketplace/MarketplaceService.js

const { db } = require('../../../shared/db');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

class MarketplaceService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL);
        this.MARKETPLACE_TAX_FIXED = 0.10; // 10% 固定价格手续费
        this.MARKETPLACE_TAX_AUCTION = 0.12; // 12% 拍卖手续费
        this.MIN_FEE = 100;
        this.HIGH_VALUE_THRESHOLD = 10000;
        this.MAX_DAILY_LISTINGS = 50;
        this.MAX_DAILY_TRANSACTIONS = 100;
    }

    /**
     * 创建市场列表
     */
    async createListing(userId, pokemonId, listingData) {
        const client = await db.connect();
        
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
            
            if (parseInt(todayListings.rows[0].count) >= this.MAX_DAILY_LISTINGS) {
                throw new Error('Daily listing limit reached');
            }
            
            // 3. 计算手续费
            const feeRate = listingData.listingType === 'fixed' 
                ? this.MARKETPLACE_TAX_FIXED 
                : this.MARKETPLACE_TAX_AUCTION;
            const price = listingData.listingType === 'fixed' 
                ? listingData.fixedPrice 
                : listingData.startingBid;
            
            // 4. 高价值交易需要额外验证
            const requiresVerification = price >= this.HIGH_VALUE_THRESHOLD;
            
            // 5. 创建列表
            const listingId = uuidv4();
            const expiresAt = this.calculateExpiryTime(listingData.duration);
            
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
                    listingData.fixedPrice || null,
                    listingData.startingBid || null,
                    listingData.buyoutPrice || null,
                    expiresAt
                ]
            );
            
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
            
            // 8. 发布事件
            await this.publishListingEvent('listing.created', insertResult.rows[0]);
            
            // 9. 缓存热门列表
            await this.cacheHotListing(insertResult.rows[0]);
            
            return insertResult.rows[0];
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 出价（拍卖模式）
     */
    async placeBid(userId, listingId, bidAmount, autoBidMax = null) {
        const client = await db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 1. 获取列表信息
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
                ? Math.floor(listing.current_highest_bid * 1.05) // 最少加价 5%
                : listing.starting_bid;
            
            if (bidAmount < minBid) {
                throw new Error(`Minimum bid is ${minBid}`);
            }
            
            // 5. 检查一口价
            if (listing.buyout_price && bidAmount >= listing.buyout_price) {
                // 触发一口价购买
                return await this.executeBuyout(client, listing, userId, listing.buyout_price);
            }
            
            // 6. 检查用户余额
            const userBalance = await this.getUserBalance(userId);
            if (userBalance < bidAmount) {
                throw new Error('Insufficient balance');
            }
            
            // 7. 创建出价记录
            const bidId = uuidv4();
            await client.query(
                `INSERT INTO marketplace_bids 
                 (bid_id, listing_id, bidder_id, bid_amount, is_auto_bid, max_auto_bid, is_winning)
                 VALUES ($1, $2, $3, $4, $5, $6, true)`,
                [bidId, listing.id, userId, bidAmount, !!autoBidMax, autoBidMax]
            );
            
            // 8. 更新之前的胜出出价
            await client.query(
                `UPDATE marketplace_bids SET is_winning = false 
                 WHERE listing_id = $1 AND is_winning = true`,
                [listing.id]
            );
            
            // 9. 更新列表信息
            const newExpiry = this.checkAndExtendAuction(listing.expires_at);
            
            await client.query(
                `UPDATE marketplace_listings 
                 SET current_highest_bid = $1, 
                     current_highest_bidder_id = $2,
                     bid_count = bid_count + 1,
                     expires_at = $3
                 WHERE id = $4`,
                [bidAmount, userId, newExpiry, listing.id]
            );
            
            // 10. 退款前一个最高出价者（如果有自动出价）
            if (listing.current_highest_bidder_id) {
                await this.refundPreviousBidder(listing.current_highest_bidder_id, listing.current_highest_bid);
            }
            
            // 11. 扣除当前出价者的星尘
            await this.deductStardust(userId, bidAmount);
            
            await client.query('COMMIT');
            
            // 12. 发布出价事件
            await this.publishBidEvent('bid.placed', {
                listingId,
                bidderId: userId,
                bidAmount,
                previousBid: listing.current_highest_bid
            });
            
            // 13. 通知前最高出价者被超越
            if (listing.current_highest_bidder_id) {
                await this.notifyOutbid(listing.current_highest_bidder_id, listing);
            }
            
            return { success: true, bidAmount, newExpiry };
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 购买（固定价格模式）
     */
    async purchaseFixed(userId, listingId) {
        const client = await db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 1. 获取列表信息
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
            
            // 2. 验证卖家不能购买自己的列表
            if (listing.seller_id === userId) {
                throw new Error('Cannot purchase your own listing');
            }
            
            // 3. 检查用户余额
            const userBalance = await this.getUserBalance(userId);
            if (userBalance < listing.fixed_price) {
                throw new Error('Insufficient balance');
            }
            
            // 4. 执行交易
            return await this.executeTransaction(client, listing, userId, listing.fixed_price, 'fixed');
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 执行交易
     */
    async executeTransaction(client, listing, buyerId, price, transactionType) {
        // 1. 计算手续费
        const feeRate = transactionType === 'fixed' 
            ? this.MARKETPLACE_TAX_FIXED 
            : this.MARKETPLACE_TAX_AUCTION;
        const fee = Math.max(Math.floor(price * feeRate), this.MIN_FEE);
        const sellerRevenue = price - fee;
        
        // 2. 扣除买家星尘
        await this.deductStardust(buyerId, price);
        
        // 3. 增加卖家星尘
        await this.addStardust(listing.seller_id, sellerRevenue);
        
        // 4. 转移精灵所有权
        await client.query(
            'UPDATE pokemon SET owner_id = $1, is_frozen = false WHERE id = $2',
            [buyerId, listing.pokemon_id]
        );
        
        // 5. 更新列表状态
        await client.query(
            `UPDATE marketplace_listings 
             SET status = 'sold', sold_at = NOW(), current_highest_bid = $1
             WHERE id = $2`,
            [price, listing.id]
        );
        
        // 6. 创建交易记录
        const transactionId = uuidv4();
        await client.query(
            `INSERT INTO marketplace_transactions 
             (transaction_id, listing_id, seller_id, buyer_id, pokemon_id, 
              final_price, fee_amount, transaction_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [transactionId, listing.id, listing.seller_id, buyerId, 
             listing.pokemon_id, price, fee, transactionType]
        );
        
        // 7. 更新用户统计
        await this.updateUserStats(client, listing.seller_id, 'sale', sellerRevenue, fee);
        await this.updateUserStats(client, buyerId, 'purchase', price, 0);
        
        // 8. 更新价格历史
        await this.updatePriceHistory(client, listing.pokemon_id, price);
        
        // 9. 清除缓存
        await this.clearListingCache(listing.listing_id);
        
        await client.query('COMMIT');
        
        // 10. 发布交易事件
        await this.publishTransactionEvent('transaction.completed', {
            transactionId,
            listingId: listing.listing_id,
            sellerId: listing.seller_id,
            buyerId,
            price,
            fee
        });
        
        // 11. 通知双方
        await this.notifyTransaction(listing.seller_id, buyerId, listing, price);
        
        return { success: true, transactionId, price, fee };
    }

    /**
     * 搜索市场列表
     */
    async searchListings(filters = {}, pagination = {}) {
        const { 
            query, 
            listingType, 
            minPrice, 
            maxPrice, 
            minLevel,
            maxLevel,
            species,
            isShiny,
            sortBy = 'created_at',
            sortOrder = 'DESC'
        } = filters;
        
        const { page = 1, limit = 20 } = pagination;
        const offset = (page - 1) * limit;
        
        let sql = `
            SELECT ml.*, 
                   p.species_id, p.level, p.cp, p.is_shiny, p.iv_attack, p.iv_defense, p.iv_stamina,
                   u.username as seller_name
            FROM marketplace_listings ml
            JOIN pokemon p ON ml.pokemon_id = p.id
            JOIN users u ON ml.seller_id = u.id
            WHERE ml.status = 'active' AND ml.expires_at > NOW()
        `;
        
        const params = [];
        let paramIndex = 1;
        
        // 关键词搜索
        if (query) {
            sql += ` AND (p.species_name ILIKE $${paramIndex} OR p.nickname ILIKE $${paramIndex})`;
            params.push(`%${query}%`);
            paramIndex++;
        }
        
        // 交易类型
        if (listingType) {
            sql += ` AND ml.listing_type = $${paramIndex}`;
            params.push(listingType);
            paramIndex++;
        }
        
        // 价格范围
        if (minPrice !== undefined) {
            sql += ` AND COALESCE(ml.fixed_price, ml.current_highest_bid, ml.starting_bid) >= $${paramIndex}`;
            params.push(minPrice);
            paramIndex++;
        }
        if (maxPrice !== undefined) {
            sql += ` AND COALESCE(ml.fixed_price, ml.current_highest_bid, ml.starting_bid) <= $${paramIndex}`;
            params.push(maxPrice);
            paramIndex++;
        }
        
        // 等级范围
        if (minLevel !== undefined) {
            sql += ` AND p.level >= $${paramIndex}`;
            params.push(minLevel);
            paramIndex++;
        }
        if (maxLevel !== undefined) {
            sql += ` AND p.level <= $${paramIndex}`;
            params.push(maxLevel);
            paramIndex++;
        }
        
        // 种类
        if (species) {
            sql += ` AND p.species_id = $${paramIndex}`;
            params.push(species);
            paramIndex++;
        }
        
        // 闪光
        if (isShiny !== undefined) {
            sql += ` AND p.is_shiny = $${paramIndex}`;
            params.push(isShiny);
            paramIndex++;
        }
        
        // 排序
        const validSortFields = ['created_at', 'expires_at', 'price', 'level', 'bid_count'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';
        const sortDirection = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        if (sortField === 'price') {
            sql += ` ORDER BY COALESCE(ml.fixed_price, ml.current_highest_bid, ml.starting_bid) ${sortDirection}`;
        } else if (sortField === 'level') {
            sql += ` ORDER BY p.level ${sortDirection}`;
        } else if (sortField === 'bid_count') {
            sql += ` ORDER BY ml.bid_count ${sortDirection}`;
        } else {
            sql += ` ORDER BY ml.${sortField} ${sortDirection}`;
        }
        
        // 分页
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
        
        const result = await db.query(sql, params);
        
        // 获取总数
        const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM').replace(/ORDER BY.*$/, '').replace(/LIMIT.*$/, '');
        const countResult = await db.query(countSql, params.slice(0, -2));
        
        return {
            listings: result.rows,
            total: parseInt(countResult.rows[0].count),
            page,
            limit,
            totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
        };
    }

    /**
     * 计算过期时间
     */
    calculateExpiryTime(duration) {
        const now = new Date();
        const durations = {
            '1h': 1 * 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000
        };
        return new Date(now.getTime() + (durations[duration] || durations['24h']));
    }

    /**
     * 检查并延长拍卖
     */
    checkAndExtendAuction(expiresAt) {
        const now = new Date();
        const expiry = new Date(expiresAt);
        const fiveMinutes = 5 * 60 * 1000;
        
        // 如果剩余时间少于5分钟，延长3分钟
        if (expiry - now < fiveMinutes) {
            return new Date(expiry.getTime() + 3 * 60 * 1000);
        }
        return expiry;
    }

    /**
     * 异常价格检测
     */
    async detectAbnormalPrice(speciesId, price) {
        // 获取最近7天的平均价格
        const result = await db.query(
            `SELECT AVG(avg_price) as avg_price, AVG(min_price) as min_price
             FROM marketplace_price_history
             WHERE pokemon_species_id = $1 
             AND recorded_date >= NOW() - INTERVAL '7 days'`,
            [speciesId]
        );
        
        if (result.rows.length === 0 || !result.rows[0].avg_price) {
            return { isAbnormal: false };
        }
        
        const avgPrice = parseFloat(result.rows[0].avg_price);
        const minPrice = parseFloat(result.rows[0].min_price);
        
        // 价格低于平均价的30%视为异常
        const isAbnormal = price < avgPrice * 0.3;
        
        return {
            isAbnormal,
            avgPrice,
            deviation: ((price - avgPrice) / avgPrice * 100).toFixed(2)
        };
    }
}

module.exports = MarketplaceService;
```

### 3. API 路由

```javascript
// backend/services/social-service/src/routes/marketplace.js

const express = require('express');
const router = express.Router();
const MarketplaceService = require('../marketplace/MarketplaceService');
const { authenticate, optionalAuth } = require('../../../shared/auth');
const { validateRequest } = require('../../../shared/validation');
const Joi = require('joi');

const marketplace = new MarketplaceService();

// 创建列表
router.post('/listings', 
    authenticate,
    validateRequest({
        body: Joi.object({
            pokemonId: Joi.number().required(),
            listingType: Joi.string().valid('fixed', 'auction').required(),
            fixedPrice: Joi.number().when('listingType', { is: 'fixed', then: Joi.required() }),
            startingBid: Joi.number().when('listingType', { is: 'auction', then: Joi.required() }),
            buyoutPrice: Joi.number(),
            duration: Joi.string().valid('1h', '6h', '24h', '7d').default('24h')
        })
    }),
    async (req, res) => {
        try {
            const listing = await marketplace.createListing(
                req.user.id, 
                req.body.pokemonId, 
                req.body
            );
            res.status(201).json({ success: true, listing });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }
);

// 搜索列表
router.get('/listings', optionalAuth, async (req, res) => {
    try {
        const result = await marketplace.searchListings(req.query, {
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 20
        });
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取列表详情
router.get('/listings/:listingId', optionalAuth, async (req, res) => {
    try {
        const listing = await marketplace.getListingDetails(req.params.listingId);
        if (!listing) {
            return res.status(404).json({ success: false, error: 'Listing not found' });
        }
        res.json({ success: true, listing });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 出价（拍卖）
router.post('/listings/:listingId/bid',
    authenticate,
    validateRequest({
        body: Joi.object({
            bidAmount: Joi.number().min(1).required(),
            autoBidMax: Joi.number().min(Joi.ref('bidAmount'))
        })
    }),
    async (req, res) => {
        try {
            const result = await marketplace.placeBid(
                req.user.id,
                req.params.listingId,
                req.body.bidAmount,
                req.body.autoBidMax
            );
            res.json({ success: true, ...result });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }
);

// 购买（一口价）
router.post('/listings/:listingId/purchase',
    authenticate,
    async (req, res) => {
        try {
            const result = await marketplace.purchaseFixed(
                req.user.id,
                req.params.listingId
            );
            res.json({ success: true, ...result });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }
);

// 取消列表
router.delete('/listings/:listingId',
    authenticate,
    async (req, res) => {
        try {
            await marketplace.cancelListing(req.user.id, req.params.listingId);
            res.json({ success: true });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }
);

// 收藏列表
router.post('/listings/:listingId/favorite',
    authenticate,
    async (req, res) => {
        try {
            await marketplace.addFavorite(req.user.id, req.params.listingId);
            res.json({ success: true });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }
);

// 获取用户列表
router.get('/users/:userId/listings', optionalAuth, async (req, res) => {
    try {
        const listings = await marketplace.getUserListings(
            req.params.userId,
            req.query.status || 'active'
        );
        res.json({ success: true, listings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取价格历史
router.get('/prices/:speciesId', optionalAuth, async (req, res) => {
    try {
        const history = await marketplace.getPriceHistory(
            req.params.speciesId,
            req.query.days || 30
        );
        res.json({ success: true, history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
```

### 4. 前端组件

```javascript
// frontend/game-client/src/components/Marketplace.js

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './Marketplace.css';

const Marketplace = () => {
    const [listings, setListings] = useState([]);
    const [filters, setFilters] = useState({
        query: '',
        listingType: '',
        minPrice: '',
        maxPrice: '',
        sortBy: 'created_at',
        sortOrder: 'DESC'
    });
    const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0 });
    const [loading, setLoading] = useState(false);
    const [selectedListing, setSelectedListing] = useState(null);
    const [bidAmount, setBidAmount] = useState('');
    const navigate = useNavigate();

    // 获取列表
    const fetchListings = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({
                ...filters,
                page: pagination.page,
                limit: pagination.limit
            });
            
            const response = await fetch(`/api/marketplace/listings?${params}`);
            const data = await response.json();
            
            if (data.success) {
                setListings(data.listings);
                setPagination(prev => ({ ...prev, total: data.total, totalPages: data.totalPages }));
            }
        } catch (error) {
            console.error('Failed to fetch listings:', error);
        } finally {
            setLoading(false);
        }
    }, [filters, pagination.page, pagination.limit]);

    useEffect(() => {
        fetchListings();
    }, [fetchListings]);

    // 出价
    const handleBid = async (listingId) => {
        if (!bidAmount || parseFloat(bidAmount) <= 0) {
            alert('Please enter a valid bid amount');
            return;
        }

        try {
            const response = await fetch(`/api/marketplace/listings/${listingId}/bid`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bidAmount: parseFloat(bidAmount) })
            });
            
            const data = await response.json();
            
            if (data.success) {
                alert('Bid placed successfully!');
                setSelectedListing(null);
                setBidAmount('');
                fetchListings();
            } else {
                alert(data.error);
            }
        } catch (error) {
            alert('Failed to place bid');
        }
    };

    // 购买
    const handlePurchase = async (listingId) => {
        if (!confirm('Are you sure you want to purchase this Pokémon?')) return;

        try {
            const response = await fetch(`/api/marketplace/listings/${listingId}/purchase`, {
                method: 'POST'
            });
            
            const data = await response.json();
            
            if (data.success) {
                alert('Purchase successful!');
                navigate('/pokemon');
            } else {
                alert(data.error);
            }
        } catch (error) {
            alert('Failed to purchase');
        }
    };

    // 格式化时间
    const formatTimeRemaining = (expiresAt) => {
        const now = new Date();
        const expiry = new Date(expiresAt);
        const diff = expiry - now;
        
        if (diff <= 0) return 'Ended';
        
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        
        if (hours > 24) {
            const days = Math.floor(hours / 24);
            return `${days}d ${hours % 24}h`;
        }
        
        return `${hours}h ${minutes}m`;
    };

    // 格式化价格
    const formatPrice = (listing) => {
        if (listing.listing_type === 'fixed') {
            return `💰 ${listing.fixed_price.toLocaleString()} Stardust`;
        } else {
            const currentBid = listing.current_highest_bid || listing.starting_bid;
            return `🔨 ${currentBid.toLocaleString()} Stardust`;
        }
    };

    return (
        <div className="marketplace">
            <header className="marketplace-header">
                <h1>🏪 Pokémon Marketplace</h1>
                <button className="sell-button" onClick={() => navigate('/marketplace/sell')}>
                    + Sell Pokémon
                </button>
            </header>

            {/* 搜索和筛选 */}
            <div className="marketplace-filters">
                <input
                    type="text"
                    placeholder="Search by name..."
                    value={filters.query}
                    onChange={(e) => setFilters({ ...filters, query: e.target.value })}
                />
                
                <select 
                    value={filters.listingType}
                    onChange={(e) => setFilters({ ...filters, listingType: e.target.value })}
                >
                    <option value="">All Types</option>
                    <option value="fixed">Fixed Price</option>
                    <option value="auction">Auction</option>
                </select>

                <input
                    type="number"
                    placeholder="Min Price"
                    value={filters.minPrice}
                    onChange={(e) => setFilters({ ...filters, minPrice: e.target.value })}
                />

                <input
                    type="number"
                    placeholder="Max Price"
                    value={filters.maxPrice}
                    onChange={(e) => setFilters({ ...filters, maxPrice: e.target.value })}
                />

                <select 
                    value={`${filters.sortBy}-${filters.sortOrder}`}
                    onChange={(e) => {
                        const [sortBy, sortOrder] = e.target.value.split('-');
                        setFilters({ ...filters, sortBy, sortOrder });
                    }}
                >
                    <option value="created_at-DESC">Newest First</option>
                    <option value="created_at-ASC">Oldest First</option>
                    <option value="price-ASC">Price: Low to High</option>
                    <option value="price-DESC">Price: High to Low</option>
                    <option value="expires_at-ASC">Ending Soon</option>
                </select>
            </div>

            {/* 列表 */}
            <div className="marketplace-listings">
                {loading ? (
                    <div className="loading">Loading...</div>
                ) : (
                    listings.map(listing => (
                        <div 
                            key={listing.listing_id} 
                            className={`listing-card ${listing.listing_type}`}
                            onClick={() => setSelectedListing(listing)}
                        >
                            <div className="listing-image">
                                {listing.is_shiny && <span className="shiny-badge">✨ Shiny</span>}
                                <img 
                                    src={`/assets/pokemon/${listing.species_id}.png`}
                                    alt={listing.species_name}
                                />
                            </div>
                            
                            <div className="listing-info">
                                <h3>{listing.species_name}</h3>
                                <p className="level">Level {listing.level} | CP {listing.cp}</p>
                                <p className="price">{formatPrice(listing)}</p>
                                <p className="time-remaining">
                                    ⏱️ {formatTimeRemaining(listing.expires_at)}
                                </p>
                                {listing.listing_type === 'auction' && (
                                    <p className="bid-count">{listing.bid_count} bids</p>
                                )}
                            </div>

                            <div className="listing-actions">
                                {listing.listing_type === 'fixed' ? (
                                    <button 
                                        className="buy-button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handlePurchase(listing.listing_id);
                                        }}
                                    >
                                        Buy Now
                                    </button>
                                ) : (
                                    <button className="bid-button">Place Bid</button>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* 分页 */}
            {pagination.totalPages > 1 && (
                <div className="pagination">
                    <button 
                        disabled={pagination.page === 1}
                        onClick={() => setPagination({ ...pagination, page: pagination.page - 1 })}
                    >
                        ← Previous
                    </button>
                    <span>Page {pagination.page} of {pagination.totalPages}</span>
                    <button 
                        disabled={pagination.page === pagination.totalPages}
                        onClick={() => setPagination({ ...pagination, page: pagination.page + 1 })}
                    >
                        Next →
                    </button>
                </div>
            )}

            {/* 详情模态框 */}
            {selectedListing && (
                <div className="listing-modal" onClick={() => setSelectedListing(null)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <button className="close-button" onClick={() => setSelectedListing(null)}>×</button>
                        
                        <div className="modal-header">
                            <img 
                                src={`/assets/pokemon/${selectedListing.species_id}.png`}
                                alt={selectedListing.species_name}
                            />
                            <div>
                                <h2>{selectedListing.species_name} {selectedListing.is_shiny && '✨'}</h2>
                                <p>Level {selectedListing.level} | CP {selectedListing.cp}</p>
                            </div>
                        </div>

                        <div className="modal-details">
                            <div className="detail-row">
                                <span>IVs:</span>
                                <span>ATK {selectedListing.iv_attack} / DEF {selectedListing.iv_defense} / STA {selectedListing.iv_stamina}</span>
                            </div>
                            <div className="detail-row">
                                <span>Seller:</span>
                                <span>{selectedListing.seller_name}</span>
                            </div>
                            <div className="detail-row">
                                <span>Time Remaining:</span>
                                <span>{formatTimeRemaining(selectedListing.expires_at)}</span>
                            </div>
                            <div className="detail-row price-row">
                                <span>Price:</span>
                                <span className="price-value">{formatPrice(selectedListing)}</span>
                            </div>
                        </div>

                        <div className="modal-actions">
                            {selectedListing.listing_type === 'fixed' ? (
                                <button 
                                    className="buy-button large"
                                    onClick={() => handlePurchase(selectedListing.listing_id)}
                                >
                                    Buy Now - {selectedListing.fixed_price.toLocaleString()} Stardust
                                </button>
                            ) : (
                                <div className="bid-form">
                                    <input
                                        type="number"
                                        placeholder={`Min bid: ${Math.floor((selectedListing.current_highest_bid || selectedListing.starting_bid) * 1.05)}`}
                                        value={bidAmount}
                                        onChange={(e) => setBidAmount(e.target.value)}
                                    />
                                    <button 
                                        className="bid-button large"
                                        onClick={() => handleBid(selectedListing.listing_id)}
                                    >
                                        Place Bid
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Marketplace;
```

### 5. 定时任务处理

```javascript
// backend/services/social-service/src/marketplace/MarketplaceScheduler.js

const { db } = require('../../../shared/db');
const cron = require('node-cron');

class MarketplaceScheduler {
    constructor(marketplaceService) {
        this.marketplace = marketplaceService;
    }

    start() {
        // 每分钟检查过期的拍卖
        cron.schedule('* * * * *', async () => {
            await this.processExpiredAuctions();
        });

        // 每小时更新价格历史
        cron.schedule('0 * * * *', async () => {
            await this.updateDailyPriceHistory();
        });

        // 每天清理过期的列表
        cron.schedule('0 0 * * *', async () => {
            await this.cleanupExpiredListings();
        });
    }

    async processExpiredAuctions() {
        try {
            // 获取所有过期的活跃拍卖
            const result = await db.query(
                `SELECT * FROM marketplace_listings 
                 WHERE listing_type = 'auction' 
                 AND status = 'active' 
                 AND expires_at <= NOW()`
            );

            for (const listing of result.rows) {
                if (listing.current_highest_bid > 0 && listing.current_highest_bidder_id) {
                    // 有出价，完成交易
                    await this.marketplace.executeTransaction(
                        null,
                        listing,
                        listing.current_highest_bidder_id,
                        listing.current_highest_bid,
                        'auction'
                    );
                } else {
                    // 无出价，标记为过期并返还精灵
                    await db.query(
                        `UPDATE marketplace_listings SET status = 'expired' WHERE id = $1`,
                        [listing.id]
                    );
                    await db.query(
                        'UPDATE pokemon SET is_frozen = false WHERE id = $1',
                        [listing.pokemon_id]
                    );
                    
                    // 通知卖家
                    await this.notifyAuctionExpired(listing);
                }
            }
        } catch (error) {
            console.error('Error processing expired auctions:', error);
        }
    }

    async updateDailyPriceHistory() {
        try {
            await db.query(`
                INSERT INTO marketplace_price_history (pokemon_species_id, avg_price, min_price, max_price, transaction_count, recorded_date)
                SELECT 
                    p.species_id,
                    AVG(mt.final_price) as avg_price,
                    MIN(mt.final_price) as min_price,
                    MAX(mt.final_price) as max_price,
                    COUNT(*) as transaction_count,
                    CURRENT_DATE
                FROM marketplace_transactions mt
                JOIN pokemon p ON mt.pokemon_id = p.id
                WHERE mt.created_at >= CURRENT_DATE - INTERVAL '1 day'
                GROUP BY p.species_id
                ON CONFLICT (pokemon_species_id, recorded_date) 
                DO UPDATE SET 
                    avg_price = EXCLUDED.avg_price,
                    min_price = EXCLUDED.min_price,
                    max_price = EXCLUDED.max_price,
                    transaction_count = EXCLUDED.transaction_count
            `);
        } catch (error) {
            console.error('Error updating price history:', error);
        }
    }
}

module.exports = MarketplaceScheduler;
```

### 6. Prometheus 指标

```javascript
// backend/services/social-service/src/marketplaceMetrics.js

const promClient = require('prom-client');

const marketplaceMetrics = {
    // 列表创建计数
    listingsCreated: new promClient.Counter({
        name: 'marketplace_listings_created_total',
        help: 'Total number of marketplace listings created',
        labelNames: ['listing_type']
    }),

    // 交易完成计数
    transactionsCompleted: new promClient.Counter({
        name: 'marketplace_transactions_completed_total',
        help: 'Total number of marketplace transactions completed',
        labelNames: ['transaction_type']
    }),

    // 总交易金额
    totalTransactionValue: new promClient.Counter({
        name: 'marketplace_transaction_value_total',
        help: 'Total value of marketplace transactions',
        labelNames: ['transaction_type']
    }),

    // 手续费收入
    totalFeesCollected: new promClient.Counter({
        name: 'marketplace_fees_collected_total',
        help: 'Total fees collected from marketplace transactions'
    }),

    // 活跃列表数量
    activeListings: new promClient.Gauge({
        name: 'marketplace_active_listings',
        help: 'Number of active marketplace listings',
        labelNames: ['listing_type']
    }),

    // 出价数量
    bidsPlaced: new promClient.Counter({
        name: 'marketplace_bids_placed_total',
        help: 'Total number of bids placed'
    }),

    // 搜索请求
    searchRequests: new promClient.Counter({
        name: 'marketplace_search_requests_total',
        help: 'Total number of marketplace search requests'
    }),

    // 异常价格检测
    abnormalPriceDetected: new promClient.Counter({
        name: 'marketplace_abnormal_price_detected_total',
        help: 'Total number of abnormal price detections'
    })
};

module.exports = marketplaceMetrics;
```

## 验收标准

- [ ] 数据库表创建完成（7个表）
- [ ] 市场列表创建功能正常（固定价格和拍卖模式）
- [ ] 竞价出价功能正常（含自动出价）
- [ ] 固定价格购买功能正常
- [ ] 拍卖延长机制生效（最后5分钟出价延长3分钟）
- [ ] 搜索和筛选功能正常
- [ ] 交易税计算正确（固定10%，拍卖12%）
- [ ] 高价值交易需要额外验证
- [ ] 异常价格检测功能正常
- [ ] 过期拍卖自动处理（成交/流拍）
- [ ] 价格历史记录功能正常
- [ ] 前端市场页面展示正常
- [ ] 前端出价/购买流程正常
- [ ] 交易通知推送正常
- [ ] Prometheus 指标正常采集
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试通过

## 影响范围

- `backend/services/social-service/src/marketplace/` - 新增市场核心服务
- `backend/services/social-service/src/routes/marketplace.js` - 新增 API 路由
- `backend/services/user-service/` - 星尘余额管理
- `backend/services/pokemon-service/` - 精灵所有权转移
- `frontend/game-client/src/components/Marketplace.js` - 前端市场组件
- `frontend/game-client/src/components/Marketplace.css` - 市场样式
- `database/migrations/` - 新增数据库迁移文件
- `backend/shared/` - 共享工具函数

## 参考

- [Pokémon GO Trading System](https://pokemongohub.net/post/guide/trading-pokemon-go/)
- [eBay Auction Model](https://www.ebay.com/help/buying/bidding/automatic-bidding)
- [Steam Community Market](https://steamcommunity.com/market/)
- [Marketplace UX Best Practices](https://www.nngroup.com/articles/ecommerce-filtering/)
