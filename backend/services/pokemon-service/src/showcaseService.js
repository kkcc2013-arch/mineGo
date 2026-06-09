/**
 * REQ-00055: 精灵收藏展示系统
 * 核心服务模块
 * 
 * 创建时间: 2026-06-09 20:20
 */

'use strict';

const { query, transaction } = require('../../shared/db');
const { getRedis, getJSON, setJSON, del } = require('../../shared/redis');
const logger = require('../../shared/logger');
const promClient = require('prom-client');

// ============================================================
// 配置常量
// ============================================================

const CONFIG = {
  MAX_FAVORITES: 6,              // 最大收藏数量
  MAX_LIKES_PER_DAY: 20,         // 每日最大点赞数
  MAX_COMMENTS_PER_DAY: 5,       // 每日最大评语数
  COMMENT_MIN_LENGTH: 1,         // 评语最小长度
  COMMENT_MAX_LENGTH: 200,       // 评语最大长度
  
  // 奖励配置
  REWARDS: {
    LIKED_OWNER: { coins: 10, experience: 20 },      // 被点赞者奖励
    LIKER: { coins: 5, experience: 10 },             // 点赞者奖励
    COMMENTED_OWNER: { coins: 20, experience: 40 }, // 被评语者奖励
    COMMENTER: { coins: 2, experience: 5 }          // 评语者奖励
  },
  
  // Redis 缓存键前缀
  CACHE_PREFIX: {
    FAVORITES: 'showcase:favorites:',
    STATS: 'showcase:stats:',
    LEADERBOARD: 'showcase:leaderboard',
    QUOTA: 'showcase:quota:'
  },
  
  // 缓存过期时间（秒）
  CACHE_TTL: {
    FAVORITES: 300,      // 5分钟
    STATS: 60,           // 1分钟
    LEADERBOARD: 3600    // 1小时
  }
};

// ============================================================
// Prometheus 指标
// ============================================================

const register = new promClient.Registry();

const metrics = {
  favoritesTotal: new promClient.Counter({
    name: 'minego_showcase_favorites_total',
    help: 'Total number of favorites',
    registers: [register]
  }),
  
  likesTotal: new promClient.Counter({
    name: 'minego_showcase_likes_total',
    help: 'Total likes given',
    registers: [register]
  }),
  
  commentsTotal: new promClient.Counter({
    name: 'minego_showcase_comments_total',
    help: 'Total comments posted',
    registers: [register]
  }),
  
  viewsTotal: new promClient.Counter({
    name: 'minego_showcase_views_total',
    help: 'Total showcase views',
    registers: [register]
  }),
  
  limitReachedTotal: new promClient.Counter({
    name: 'minego_showcase_limit_reached_total',
    help: 'Times daily limit was reached',
    labelNames: ['type'],
    registers: [register]
  }),
  
  rewardsGivenTotal: new promClient.Counter({
    name: 'minego_showcase_rewards_given_total',
    help: 'Total rewards given',
    labelNames: ['type'], // coins, experience
    registers: [register]
  })
};

// ============================================================
// 收藏管理
// ============================================================

/**
 * 获取用户收藏列表
 */
async function getFavorites(userId) {
  const cacheKey = CONFIG.CACHE_PREFIX.FAVORITES + userId;
  
  // 尝试从缓存获取
  const cached = await getJSON(cacheKey);
  if (cached) {
    logger.debug({ userId }, 'Returning cached favorites');
    return cached;
  }
  
  const result = await query(`
    SELECT 
      pf.id,
      pf.pokemon_id,
      pf.display_order,
      pf.is_showcased,
      p.species,
      p.level,
      p.is_shiny,
      p.iv_total,
      p.cp,
      p.moves,
      s.like_count,
      s.comment_count,
      s.view_count
    FROM pokemon_favorites pf
    JOIN pokemon p ON pf.pokemon_id = p.id
    LEFT JOIN pokemon_showcase_stats s ON p.id = s.pokemon_id
    WHERE pf.user_id = $1
    ORDER BY pf.display_order ASC
  `, [userId]);
  
  const favorites = result.rows;
  
  // 缓存结果
  await setJSON(cacheKey, favorites, CONFIG.CACHE_TTL.FAVORITES);
  
  return favorites;
}

/**
 * 添加收藏
 */
async function addFavorite(userId, pokemonId, displayOrder = 0) {
  // 检查精灵是否属于该用户
  const pokemonCheck = await query(
    'SELECT id, user_id FROM pokemon WHERE id = $1',
    [pokemonId]
  );
  
  if (pokemonCheck.rows.length === 0) {
    throw new Error('Pokemon not found');
  }
  
  if (pokemonCheck.rows[0].user_id !== userId) {
    throw new Error('You can only favorite your own Pokemon');
  }
  
  // 检查当前收藏数量
  const countResult = await query(
    'SELECT COUNT(*) FROM pokemon_favorites WHERE user_id = $1',
    [userId]
  );
  
  const currentCount = parseInt(countResult.rows[0].count);
  
  if (currentCount >= CONFIG.MAX_FAVORITES) {
    throw new Error(`Maximum ${CONFIG.MAX_FAVORITES} favorites allowed`);
  }
  
  // 如果未指定顺序，放到最后
  if (displayOrder === 0 && currentCount > 0) {
    displayOrder = currentCount;
  }
  
  // 添加收藏
  const result = await query(`
    INSERT INTO pokemon_favorites (pokemon_id, user_id, display_order)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [pokemonId, userId, displayOrder]);
  
  // 更新精灵展示状态
  await query(
    'UPDATE pokemon SET is_showcased = true WHERE id = $1',
    [pokemonId]
  );
  
  // 清除缓存
  await del(CONFIG.CACHE_PREFIX.FAVORITES + userId);
  
  metrics.favoritesTotal.inc();
  
  logger.info({ userId, pokemonId, displayOrder }, 'Pokemon added to favorites');
  
  return result.rows[0];
}

/**
 * 移除收藏
 */
async function removeFavorite(userId, pokemonId) {
  const result = await query(`
    DELETE FROM pokemon_favorites 
    WHERE pokemon_id = $1 AND user_id = $2
    RETURNING *
  `, [pokemonId, userId]);
  
  if (result.rows.length === 0) {
    throw new Error('Favorite not found');
  }
  
  // 更新精灵展示状态
  await query(
    'UPDATE pokemon SET is_showcased = false WHERE id = $1',
    [pokemonId]
  );
  
  // 重新排序剩余收藏
  await query(`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY display_order) - 1 as new_order
      FROM pokemon_favorites
      WHERE user_id = $1
    )
    UPDATE pokemon_favorites pf
    SET display_order = o.new_order
    FROM ordered o
    WHERE pf.id = o.id
  `, [userId]);
  
  // 清除缓存
  await del(CONFIG.CACHE_PREFIX.FAVORITES + userId);
  
  logger.info({ userId, pokemonId }, 'Pokemon removed from favorites');
  
  return { success: true, message: 'Favorite removed' };
}

/**
 * 重新排序收藏
 */
async function reorderFavorites(userId, orders) {
  // orders = [{ pokemonId, displayOrder }, ...]
  
  await transaction(async (client) => {
    for (const item of orders) {
      await client.query(`
        UPDATE pokemon_favorites
        SET display_order = $1
        WHERE pokemon_id = $2 AND user_id = $3
      `, [item.displayOrder, item.pokemonId, userId]);
    }
  });
  
  // 清除缓存
  await del(CONFIG.CACHE_PREFIX.FAVORITES + userId);
  
  logger.info({ userId, count: orders.length }, 'Favorites reordered');
  
  return { success: true };
}

// ============================================================
// 点赞功能
// ============================================================

/**
 * 检查并重置每日限额
 */
async function checkAndResetQuota(userId) {
  const today = new Date().toISOString().split('T')[0];
  
  const result = await query(`
    INSERT INTO user_showcase_quotas (user_id, likes_today, comments_today, last_reset_date)
    VALUES ($1, 0, 0, $2)
    ON CONFLICT (user_id) 
    DO UPDATE SET 
      likes_today = CASE WHEN user_showcase_quotas.last_reset_date < $2 THEN 0 ELSE user_showcase_quotas.likes_today END,
      comments_today = CASE WHEN user_showcase_quotas.last_reset_date < $2 THEN 0 ELSE user_showcase_quotas.comments_today END,
      last_reset_date = CASE WHEN user_showcase_quotas.last_reset_date < $2 THEN $2 ELSE user_showcase_quotas.last_reset_date END
    RETURNING likes_today, comments_today, last_reset_date
  `, [userId, today]);
  
  return result.rows[0];
}

/**
 * 点赞精灵
 */
async function likePokemon(userId, pokemonId) {
  // 检查精灵是否存在
  const pokemonResult = await query(
    'SELECT id, user_id FROM pokemon WHERE id = $1',
    [pokemonId]
  );
  
  if (pokemonResult.rows.length === 0) {
    throw new Error('Pokemon not found');
  }
  
  const pokemon = pokemonResult.rows[0];
  
  // 不能点赞自己的精灵
  if (pokemon.user_id === userId) {
    throw new Error('You cannot like your own Pokemon');
  }
  
  // 检查是否已点赞
  const existingLike = await query(
    'SELECT id FROM pokemon_likes WHERE pokemon_id = $1 AND user_id = $2',
    [pokemonId, userId]
  );
  
  if (existingLike.rows.length > 0) {
    throw new Error('You have already liked this Pokemon');
  }
  
  // 检查每日限额
  const quota = await checkAndResetQuota(userId);
  
  if (quota.likes_today >= CONFIG.MAX_LIKES_PER_DAY) {
    metrics.limitReachedTotal.inc({ type: 'like' });
    throw new Error(`Daily like limit (${CONFIG.MAX_LIKES_PER_DAY}) reached`);
  }
  
  // 执行点赞
  await transaction(async (client) => {
    // 添加点赞记录
    await client.query(`
      INSERT INTO pokemon_likes (pokemon_id, user_id)
      VALUES ($1, $2)
    `, [pokemonId, userId]);
    
    // 更新用户限额
    await client.query(`
      UPDATE user_showcase_quotas
      SET likes_today = likes_today + 1
      WHERE user_id = $1
    `, [userId]);
    
    // 给点赞者发奖励
    await client.query(`
      UPDATE users
      SET coins = coins + $1, experience = experience + $2
      WHERE id = $3
    `, [CONFIG.REWARDS.LIKER.coins, CONFIG.REWARDS.LIKER.experience, userId]);
    
    // 给精灵主人发奖励
    await client.query(`
      UPDATE users
      SET coins = coins + $1, experience = experience + $2
      WHERE id = $3
    `, [CONFIG.REWARDS.LIKED_OWNER.coins, CONFIG.REWARDS.LIKED_OWNER.experience, pokemon.user_id]);
  });
  
  // 获取最新点赞数
  const statsResult = await query(
    'SELECT like_count FROM pokemon_showcase_stats WHERE pokemon_id = $1',
    [pokemonId]
  );
  
  const likeCount = statsResult.rows[0]?.like_count || 0;
  
  // 更新指标
  metrics.likesTotal.inc();
  metrics.rewardsGivenTotal.inc({ type: 'coins' }, CONFIG.REWARDS.LIKER.coins + CONFIG.REWARDS.LIKED_OWNER.coins);
  metrics.rewardsGivenTotal.inc({ type: 'experience' }, CONFIG.REWARDS.LIKER.experience + CONFIG.REWARDS.LIKED_OWNER.experience);
  
  logger.info({ userId, pokemonId, ownerId: pokemon.user_id }, 'Pokemon liked');
  
  return {
    success: true,
    likeCount,
    reward: CONFIG.REWARDS.LIKER
  };
}

/**
 * 取消点赞
 */
async function unlikePokemon(userId, pokemonId) {
  const result = await query(`
    DELETE FROM pokemon_likes
    WHERE pokemon_id = $1 AND user_id = $2
    RETURNING *
  `, [pokemonId, userId]);
  
  if (result.rows.length === 0) {
    throw new Error('Like not found');
  }
  
  // 获取最新点赞数
  const statsResult = await query(
    'SELECT like_count FROM pokemon_showcase_stats WHERE pokemon_id = $1',
    [pokemonId]
  );
  
  const likeCount = statsResult.rows[0]?.like_count || 0;
  
  logger.info({ userId, pokemonId }, 'Pokemon unliked');
  
  return {
    success: true,
    likeCount
  };
}

/**
 * 检查是否已点赞
 */
async function hasLiked(userId, pokemonId) {
  const result = await query(
    'SELECT id FROM pokemon_likes WHERE pokemon_id = $1 AND user_id = $2',
    [pokemonId, userId]
  );
  
  return result.rows.length > 0;
}

// ============================================================
// 评语功能
// ============================================================

/**
 * 添加评语
 */
async function addComment(userId, pokemonId, commentText) {
  // 验证评语长度
  if (commentText.length < CONFIG.COMMENT_MIN_LENGTH || 
      commentText.length > CONFIG.COMMENT_MAX_LENGTH) {
    throw new Error(`Comment must be between ${CONFIG.COMMENT_MIN_LENGTH} and ${CONFIG.COMMENT_MAX_LENGTH} characters`);
  }
  
  // 检查敏感词
  const hasSensitive = await query(
    'SELECT contains_sensitive_words($1) as has_sensitive',
    [commentText]
  );
  
  if (hasSensitive.rows[0].has_sensitive) {
    throw new Error('Comment contains inappropriate content');
  }
  
  // 检查精灵是否存在
  const pokemonResult = await query(
    'SELECT id, user_id FROM pokemon WHERE id = $1',
    [pokemonId]
  );
  
  if (pokemonResult.rows.length === 0) {
    throw new Error('Pokemon not found');
  }
  
  const pokemon = pokemonResult.rows[0];
  
  // 检查是否已评论
  const existingComment = await query(
    'SELECT id FROM pokemon_comments WHERE pokemon_id = $1 AND user_id = $2 AND is_deleted = false',
    [pokemonId, userId]
  );
  
  if (existingComment.rows.length > 0) {
    throw new Error('You have already commented on this Pokemon');
  }
  
  // 检查每日限额
  const quota = await checkAndResetQuota(userId);
  
  if (quota.comments_today >= CONFIG.MAX_COMMENTS_PER_DAY) {
    metrics.limitReachedTotal.inc({ type: 'comment' });
    throw new Error(`Daily comment limit (${CONFIG.MAX_COMMENTS_PER_DAY}) reached`);
  }
  
  // 执行评论
  const result = await transaction(async (client) => {
    // 添加评语
    const commentResult = await client.query(`
      INSERT INTO pokemon_comments (pokemon_id, user_id, comment)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [pokemonId, userId, commentText]);
    
    // 更新用户限额
    await client.query(`
      UPDATE user_showcase_quotas
      SET comments_today = comments_today + 1
      WHERE user_id = $1
    `, [userId]);
    
    // 给评论者发奖励
    await client.query(`
      UPDATE users
      SET coins = coins + $1, experience = experience + $2
      WHERE id = $3
    `, [CONFIG.REWARDS.COMMENTER.coins, CONFIG.REWARDS.COMMENTER.experience, userId]);
    
    // 给精灵主人发奖励
    await client.query(`
      UPDATE users
      SET coins = coins + $1, experience = experience + $2
      WHERE id = $3
    `, [CONFIG.REWARDS.COMMENTED_OWNER.coins, CONFIG.REWARDS.COMMENTED_OWNER.experience, pokemon.user_id]);
    
    return commentResult.rows[0];
  });
  
  // 更新指标
  metrics.commentsTotal.inc();
  metrics.rewardsGivenTotal.inc({ type: 'coins' }, CONFIG.REWARDS.COMMENTER.coins + CONFIG.REWARDS.COMMENTED_OWNER.coins);
  metrics.rewardsGivenTotal.inc({ type: 'experience' }, CONFIG.REWARDS.COMMENTER.experience + CONFIG.REWARDS.COMMENTED_OWNER.experience);
  
  logger.info({ userId, pokemonId, commentId: result.id }, 'Comment added');
  
  return {
    success: true,
    commentId: result.id,
    reward: CONFIG.REWARDS.COMMENTER
  };
}

/**
 * 获取评语列表
 */
async function getComments(pokemonId, limit = 20, offset = 0) {
  const result = await query(`
    SELECT 
      pc.id,
      pc.comment,
      pc.created_at,
      u.id as user_id,
      u.nickname,
      u.avatar_url
    FROM pokemon_comments pc
    JOIN users u ON pc.user_id = u.id
    WHERE pc.pokemon_id = $1 AND pc.is_deleted = false
    ORDER BY pc.created_at DESC
    LIMIT $2 OFFSET $3
  `, [pokemonId, limit, offset]);
  
  const countResult = await query(
    'SELECT comment_count FROM pokemon_showcase_stats WHERE pokemon_id = $1',
    [pokemonId]
  );
  
  return {
    comments: result.rows,
    total: countResult.rows[0]?.comment_count || 0
  };
}

/**
 * 删除评语（软删除）
 */
async function deleteComment(userId, commentId) {
  const result = await query(`
    UPDATE pokemon_comments
    SET is_deleted = true, updated_at = NOW()
    WHERE id = $1 AND user_id = $2 AND is_deleted = false
    RETURNING *
  `, [commentId, userId]);
  
  if (result.rows.length === 0) {
    throw new Error('Comment not found or already deleted');
  }
  
  logger.info({ userId, commentId }, 'Comment deleted');
  
  return { success: true, message: 'Comment deleted' };
}

// ============================================================
// 展示页面
// ============================================================

/**
 * 获取用户展示页
 */
async function getUserShowcase(userId, viewerId = null) {
  // 获取用户信息
  const userResult = await query(`
    SELECT id, nickname, level, team, avatar_url
    FROM users
    WHERE id = $1
  `, [userId]);
  
  if (userResult.rows.length === 0) {
    throw new Error('User not found');
  }
  
  const user = userResult.rows[0];
  
  // 获取收藏精灵
  const favoritesResult = await query(`
    SELECT 
      pf.pokemon_id,
      pf.display_order,
      p.species,
      p.level,
      p.is_shiny,
      p.iv_total,
      p.cp,
      p.moves,
      s.like_count,
      s.comment_count,
      s.view_count
    FROM pokemon_favorites pf
    JOIN pokemon p ON pf.pokemon_id = p.id
    LEFT JOIN pokemon_showcase_stats s ON p.id = s.pokemon_id
    WHERE pf.user_id = $1 AND pf.is_showcased = true
    ORDER BY pf.display_order ASC
  `, [userId]);
  
  const favorites = favoritesResult.rows;
  
  // 如果有观看者，检查每只精灵是否已被点赞
  if (viewerId && viewerId !== userId) {
    for (const fav of favorites) {
      fav.isLikedByMe = await hasLiked(viewerId, fav.pokemon_id);
    }
  }
  
  // 获取总统计
  const statsResult = await query(`
    SELECT 
      COALESCE(SUM(s.like_count), 0) as total_likes,
      COALESCE(SUM(s.view_count), 0) as total_views
    FROM pokemon_favorites pf
    LEFT JOIN pokemon_showcase_stats s ON pf.pokemon_id = s.pokemon_id
    WHERE pf.user_id = $1
  `, [userId]);
  
  const stats = statsResult.rows[0];
  
  // 增加浏览数
  if (viewerId && viewerId !== userId) {
    for (const fav of favorites) {
      await query(`
        INSERT INTO pokemon_showcase_stats (pokemon_id, view_count)
        VALUES ($1, 1)
        ON CONFLICT (pokemon_id)
        DO UPDATE SET view_count = pokemon_showcase_stats.view_count + 1
      `, [fav.pokemon_id]);
    }
    metrics.viewsTotal.inc(favorites.length);
  }
  
  return {
    user,
    showcase: favorites,
    stats: {
      totalLikes: parseInt(stats.total_likes),
      totalViews: parseInt(stats.total_views)
    }
  };
}

// ============================================================
// 排行榜
// ============================================================

/**
 * 获取排行榜
 */
async function getLeaderboard(type = 'likes', limit = 50) {
  const cacheKey = CONFIG.CACHE_PREFIX.LEADERBOARD + ':' + type;
  
  // 尝试从缓存获取
  const cached = await getJSON(cacheKey);
  if (cached) {
    logger.debug('Returning cached leaderboard');
    return cached.slice(0, limit);
  }
  
  // 刷新物化视图
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY pokemon_showcase_leaderboard');
  
  const result = await query(`
    SELECT 
      rank,
      pokemon_id,
      species,
      level,
      is_shiny,
      iv_total,
      owner_id,
      owner_nickname,
      like_count,
      comment_count,
      view_count
    FROM pokemon_showcase_leaderboard
    ORDER BY rank ASC
    LIMIT $1
  `, [limit]);
  
  // 缓存结果
  await setJSON(cacheKey, result.rows, CONFIG.CACHE_TTL.LEADERBOARD);
  
  return result.rows;
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  CONFIG,
  
  // 收藏管理
  getFavorites,
  addFavorite,
  removeFavorite,
  reorderFavorites,
  
  // 点赞功能
  likePokemon,
  unlikePokemon,
  hasLiked,
  
  // 评语功能
  addComment,
  getComments,
  deleteComment,
  
  // 展示页面
  getUserShowcase,
  
  // 排行榜
  getLeaderboard,
  
  // 指标
  metrics
};
