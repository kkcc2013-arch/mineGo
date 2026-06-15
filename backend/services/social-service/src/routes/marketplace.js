/**
 * 市场路由 - 精灵交换市场与竞价拍卖
 * REQ-00104: 精灵交换市场与竞价拍卖系统
 * 
 * @module routes/marketplace
 */

const express = require('express');
const router = express.Router();
const marketplaceService = require('../marketplace/MarketplaceService');
const { requireAuth } = require('@pmg/shared/auth');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('marketplace-routes');

/**
 * POST /api/marketplace/listings
 * 创建市场列表
 */
router.post('/listings', requireAuth, async (req, res) => {
  try {
    const { pokemonId, listingType, fixedPrice, startingBid, buyoutPrice, duration } = req.body;
    const userId = req.user.id;
    
    // 验证必填参数
    if (!pokemonId || !listingType || !duration) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: pokemonId, listingType, duration'
      });
    }
    
    // 验证交易类型
    if (!['fixed', 'auction'].includes(listingType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid listingType. Must be "fixed" or "auction"'
      });
    }
    
    // 验证价格
    if (listingType === 'fixed' && (!fixedPrice || fixedPrice <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'Fixed price listing requires a valid fixedPrice'
      });
    }
    
    if (listingType === 'auction' && (!startingBid || startingBid <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'Auction listing requires a valid startingBid'
      });
    }
    
    // 验证时长
    const validDurations = ['1h', '6h', '24h', '7d'];
    if (!validDurations.includes(duration)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid duration. Must be one of: ' + validDurations.join(', ')
      });
    }
    
    const listing = await marketplaceService.createListing(userId, pokemonId, {
      listingType,
      fixedPrice,
      startingBid,
      buyoutPrice,
      duration
    });
    
    res.status(201).json({
      success: true,
      data: listing
    });
    
  } catch (error) {
    logger.error('Failed to create listing', {
      userId: req.user.id,
      error: error.message
    });
    
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/marketplace/listings
 * 搜索市场列表
 */
router.get('/listings', async (req, res) => {
  try {
    const {
      pokemonSpecies,
      listingType,
      minPrice,
      maxPrice,
      sortBy,
      page = 1,
      limit = 20
    } = req.query;
    
    const filters = {
      pokemonSpecies: pokemonSpecies ? parseInt(pokemonSpecies) : undefined,
      listingType,
      minPrice: minPrice ? parseInt(minPrice) : undefined,
      maxPrice: maxPrice ? parseInt(maxPrice) : undefined,
      sortBy
    };
    
    const result = await marketplaceService.searchListings(
      filters,
      parseInt(page),
      parseInt(limit)
    );
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error('Failed to search listings', {
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/marketplace/listings/:listingId
 * 获取列表详情
 */
router.get('/listings/:listingId', async (req, res) => {
  try {
    const { listingId } = req.params;
    
    const result = await db.query(
      `SELECT 
        ml.*,
        p.species_id,
        p.cp,
        p.level,
        p.iv_attack,
        p.iv_defense,
        p.iv_stamina,
        ps.name as species_name,
        u.username as seller_name
      FROM marketplace_listings ml
      JOIN pokemon p ON ml.pokemon_id = p.id
      JOIN pokemon_species ps ON p.species_id = ps.id
      JOIN users u ON ml.seller_id = u.id
      WHERE ml.listing_id = $1`,
      [listingId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found'
      });
    }
    
    // 更新浏览次数
    await db.query(
      'UPDATE marketplace_listings SET view_count = view_count + 1 WHERE listing_id = $1',
      [listingId]
    );
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    logger.error('Failed to get listing details', {
      listingId: req.params.listingId,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/marketplace/listings/:listingId/bid
 * 出价（拍卖模式）
 */
router.post('/listings/:listingId/bid', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;
    const { bidAmount, autoBidMax } = req.body;
    const userId = req.user.id;
    
    if (!bidAmount || bidAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid bidAmount'
      });
    }
    
    const result = await marketplaceService.placeBid(
      userId,
      listingId,
      parseInt(bidAmount),
      autoBidMax ? parseInt(autoBidMax) : null
    );
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error('Failed to place bid', {
      userId: req.user.id,
      listingId: req.params.listingId,
      error: error.message
    });
    
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/marketplace/listings/:listingId/purchase
 * 固定价格购买
 */
router.post('/listings/:listingId/purchase', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = req.user.id;
    
    const result = await marketplaceService.purchaseFixedPrice(userId, listingId);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error('Failed to purchase listing', {
      userId: req.user.id,
      listingId: req.params.listingId,
      error: error.message
    });
    
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/marketplace/listings/:listingId
 * 取消列表
 */
router.delete('/listings/:listingId', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = req.user.id;
    
    const result = await marketplaceService.cancelListing(userId, listingId);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error('Failed to cancel listing', {
      userId: req.user.id,
      listingId: req.params.listingId,
      error: error.message
    });
    
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/marketplace/listings/:listingId/favorite
 * 收藏列表
 */
router.post('/listings/:listingId/favorite', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = req.user.id;
    
    // 获取列表ID
    const listingResult = await db.query(
      'SELECT id FROM marketplace_listings WHERE listing_id = $1',
      [listingId]
    );
    
    if (listingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found'
      });
    }
    
    await db.query(
      `INSERT INTO marketplace_favorites (user_id, listing_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, listing_id) DO NOTHING`,
      [userId, listingResult.rows[0].id]
    );
    
    res.json({
      success: true,
      message: 'Listing added to favorites'
    });
    
  } catch (error) {
    logger.error('Failed to favorite listing', {
      userId: req.user.id,
      listingId: req.params.listingId,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/marketplace/listings/:listingId/favorite
 * 取消收藏
 */
router.delete('/listings/:listingId/favorite', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = req.user.id;
    
    const listingResult = await db.query(
      'SELECT id FROM marketplace_listings WHERE listing_id = $1',
      [listingId]
    );
    
    if (listingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found'
      });
    }
    
    await db.query(
      'DELETE FROM marketplace_favorites WHERE user_id = $1 AND listing_id = $2',
      [userId, listingResult.rows[0].id]
    );
    
    res.json({
      success: true,
      message: 'Listing removed from favorites'
    });
    
  } catch (error) {
    logger.error('Failed to unfavorite listing', {
      userId: req.user.id,
      listingId: req.params.listingId,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/marketplace/favorites
 * 获取用户收藏列表
 */
router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      `SELECT 
        ml.*,
        p.species_id,
        p.cp,
        ps.name as species_name,
        mf.created_at as favorited_at
      FROM marketplace_favorites mf
      JOIN marketplace_listings ml ON mf.listing_id = ml.id
      JOIN pokemon p ON ml.pokemon_id = p.id
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE mf.user_id = $1 AND ml.status = 'active'
      ORDER BY mf.created_at DESC`,
      [userId]
    );
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    logger.error('Failed to get favorites', {
      userId: req.user.id,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/marketplace/my/listings
 * 获取我的列表
 */
router.get('/my/listings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      `SELECT 
        ml.*,
        p.species_id,
        p.cp,
        ps.name as species_name
      FROM marketplace_listings ml
      JOIN pokemon p ON ml.pokemon_id = p.id
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE ml.seller_id = $1
      ORDER BY ml.created_at DESC`,
      [userId]
    );
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    logger.error('Failed to get my listings', {
      userId: req.user.id,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/marketplace/stats
 * 获取市场统计信息
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      'SELECT * FROM marketplace_user_stats WHERE user_id = $1',
      [userId]
    );
    
    res.json({
      success: true,
      data: result.rows[0] || {
        user_id: userId,
        total_listings: 0,
        total_sales: 0,
        total_purchases: 0,
        total_earned: 0,
        total_spent: 0,
        total_fees_paid: 0,
        rating_score: 5.00,
        rating_count: 0
      }
    });
    
  } catch (error) {
    logger.error('Failed to get market stats', {
      userId: req.user.id,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
