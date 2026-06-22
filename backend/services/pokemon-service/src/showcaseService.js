/**
 * REQ-00055: 精灵收藏展示系统 - 服务层实现
 * 
 * 创建时间: 2026-06-22 05:00
 */

'use strict';

const { query, transaction } = require('../../../shared/db');
const { getRedis, setJSON, getJSON, del } = require('../../../shared/redis');
const logger = require('../../../shared/logger');
const { incrementCounter, getCounter } = require('../../../shared/metrics');

// ============================================================
// 配置常量
// ============================================================

const MAX_FAVORITES = 6;
const MAX_LIKES_PER_DAY = 20;
const MAX_COMMENTS_PER_DAY = 5;
const MAX_COMMENT_LENGTH = 200;

// 奖励配置
const REWARDS = {
  likedByOther: { coins: 10, experience: 20 },
  likeOther: { coins: 5, experience: 10 },
  commentedByOther: { coins: 20, experience: 40 },
  commentOther: { coins: 2, experience: 5 }
};

// Redis 键前缀
const REDIS_KEYS = {
  leaderboard: 'pokemon:showcase:leaderboard',
  userQuota: (userId) => `pokemon:quota:${userId}`
};

// ============================================================
// 收藏管理
// ============================================================

/**
 * 获取用户收藏列表
 */
async function getFavorites(userId) {
  const result = await query(`
    SELECT 
      pf.pokemon_id,
      pf.display_order,
      pf.is_showcased,
      pi.species_id,
      ps.name_en as species,
      pi.level,
      pi.cp,
      pi.is_shiny,
      pi.iv_attack,
      pi.iv_defense,
      pi.iv_stamina,
      ROUND((pi.iv_attack + pi.iv_defense + pi.iv_stamina) / 45.0 * 100) as iv_percentage,
      COALESCE(pss.like_count, 0) as like_count,
      COALESCE(pss.comment_count, 0) as comment_count
    FROM pokemon_favorites pf
    JOIN pokemon_instances pi ON pf.pokemon_id = pi.id
    JOIN pokemon_species ps ON pi.species_id = ps.id
    LEFT JOIN pokemon_showcase_stats pss ON pf.pokemon_id = pss.pokemon_id
    WHERE pf.user_id = $1
    ORDER BY pf.display_order ASC
  `, [userId]);
  
  return result.rows.map(row => ({
    pokemonId: row.pokemon_id,
    speciesId: row.species_id,
    species: row.species,
    level: row.level,
    cp: row.cp,
    isShiny: row.is_shiny,
    iv: Math.round(row.iv_percentage),
    likeCount: row.like_count,
    commentCount: row.comment_count,
    displayOrder: row.display_order,
    isShowcased: row.is_showcased
  }));
}

/**
 * 添加收藏
 */
async function addFavorite(userId, pokemonId, displayOrder = 0) {
  // 检查精灵是否属于用户
  const pokemonCheck = await query(`
    SELECT id FROM pokemon_instances 
    WHERE id = $1 AND user_id = $2
  `, [pokemonId, userId]);
  
  if (pokemonCheck.rows.length === 0) {
    throw new Error('Pokemon not found or does not belong to user');
  }
  
  // 检查收藏数量限制
  const countCheck = await query(`
    SELECT COUNT(*) as count FROM pokemon_favorites WHERE user_id = $1
  `, [userId]);
  
  if (parseInt(countCheck.rows[0].count) >= MAX_FAVORITES) {
    throw new Error(`Maximum ${MAX_FAVORITES} favorites allowed`);
  }
  
  // 检查是否已收藏
  const existingCheck = await query(`
    SELECT id FROM pokemon_favorites WHERE user_id = $1 AND pokemon_id = $2
  `, [userId, pokemonId]);
  
  if (existingCheck.rows.length > 0) {
    throw new Error('Pokemon already favorited');
  }
  
  // 如果指定位置已被占用，调整其他精灵的顺序
  if (displayOrder > 0) {
    await query(`
      UPDATE pokemon_favorites 
      SET display_order = display_order + 1
      WHERE user_id = $1 AND display_order >= $2
    `, [userId, displayOrder]);
  }
  
  // 添加收藏
  const result = await query(`
    INSERT INTO pokemon_favorites (pokemon_id, user_id, display_order)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [pokemonId, userId, displayOrder]);
  
  // 创建展示统计记录
  await query(`
    INSERT INTO pokemon_showcase_stats (pokemon_id)
    VALUES ($1)
    ON CONFLICT DO NOTHING
  `, [pokemonId]);
  
  logger.info({ userId, pokemonId, displayOrder }, 'Pokemon added to favorites');
  incrementCounter('pokemon_favorite_total', { user_id: userId });
  
  return result.rows[0];
}

/**
 * 移除收藏
 */
async function removeFavorite(userId, pokemonId) {
  const result = await query(`
    DELETE FROM pokemon_favorites 
    WHERE user_id = $1 AND pokemon_id = $2
    RETURNING display_order
  `, [userId, pokemonId]);
  
  if (result.rows.length === 0) {
    throw new Error('Favorite not found');
  }
  
  // 重新排序
  const displayOrder = result.rows[0].display_order;
  await query(`
    UPDATE pokemon_favorites 
    SET display_order = display_order - 1
    WHERE user_id = $1 AND display_order > $2
  `, [userId, displayOrder]);
  
  logger.info({ userId, pokemonId }, 'Pokemon removed from favorites');
  
  return { success: true, message: 'Removed from favorites' };
}

/**
 * 重新排序收藏
 */
async function reorderFavorites(userId, orders) {
  await transaction(async (client) => {
    for (const item of orders) {
      await client.query(`
        UPDATE pokemon_favorites 
        SET display_order = $1
        WHERE user_id = $2 AND pokemon_id = $3
      `, [item.displayOrder, userId, item.pokemonId]);
    }
  });
  
  logger.info({ userId, count: orders.length }, 'Favorites reordered');
  
  return { success: true };
}

// ============================================================
// 点赞功能
// ============================================================

/**
 * 检查并更新用户限额
 */
async function checkAndUpdateQuota(userId, type) {
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = REDIS_KEYS.userQuota(userId);
  
  // 尝试从缓存获取
  let quota = await getJSON(cacheKey);
  
  if (!quota || quota.lastResetDate !== today) {
    // 初始化或重置限额
    quota = {
      likesToday: 0,
      commentsToday: 0,
      lastResetDate: today
    };
  }
  
  // 检查限额
  if (type === 'like' && quota.likesToday >= MAX_LIKES_PER_DAY) {
    incrementCounter('pokemon_like_daily_limit_reached_total');
    throw new Error(`Daily like limit (${MAX_LIKES_PER_DAY}) reached`);
  }
  
  if (type === 'comment' && quota.commentsToday >= MAX_COMMENTS_PER_DAY) {
    incrementCounter('pokemon_comment_daily_limit_reached_total');
    throw new Error(`Daily comment limit (${MAX_COMMENTS_PER_DAY}) reached`);
  }
  
  return quota;
}

/**
 * 更新限额
 */
async function updateQuota(userId, quota) {
  const cacheKey = REDIS_KEYS.userQuota(userId);
  await setJSON(cacheKey, quota, 86400); // 缓存 24 小时
}

/**
 * 点赞精灵
 */
async function likePokemon(userId, pokemonId) {
  // 检查精灵是否存在
  const pokemonCheck = await query(`
    SELECT pi.id, pi.user_id, ps.name_en as species
    FROM pokemon_instances pi
    JOIN pokemon_species ps ON pi.species_id = ps.id
    WHERE pi.id = $1
  `, [pokemonId]);
  
  if (pokemonCheck.rows.length === 0) {
    throw new Error('Pokemon not found');
  }
  
  const pokemon = pokemonCheck.rows[0];
  
  // 不能给自己的精灵点赞
  if (pokemon.user_id === userId) {
    throw new Error('Cannot like your own pokemon');
  }
  
  // 检查是否已点赞
  const existingCheck = await query(`
    SELECT id FROM pokemon_likes WHERE pokemon_id = $1 AND user_id = $2
  `, [pokemonId, userId]);
  
  if (existingCheck.rows.length > 0) {
    throw new Error('Already liked this pokemon');
  }
  
  // 检查并更新限额
  const quota = await checkAndUpdateQuota(userId, 'like');
  
  // 执行点赞
  await transaction(async (client) => {
    // 添加点赞记录
    await client.query(`
      INSERT INTO pokemon_likes (pokemon_id, user_id)
      VALUES ($1, $2)
    `, [pokemonId, userId]);
    
    // 更新统计
    await client.query(`
      INSERT INTO pokemon_showcase_stats (pokemon_id, like_count, last_liked_at)
      VALUES ($1, 1, NOW())
      ON CONFLICT (pokemon_id) 
      DO UPDATE SET 
        like_count = pokemon_showcase_stats.like_count + 1,
        last_liked_at = NOW(),
        updated_at = NOW()
    `, [pokemonId]);
    
    // 给精灵主人发放奖励
    await client.query(`
      UPDATE users 
      SET coins = coins + $1, experience = experience + $2
      WHERE id = $3
    `, [REWARDS.likedByOther.coins, REWARDS.likedByOther.experience, pokemon.user_id]);
    
    // 给点赞者发放奖励
    await client.query(`
      UPDATE users 
      SET coins = coins + $1, experience = experience + $2
      WHERE id = $3
    `, [REWARDS.likeOther.coins, REWARDS.likeOther.experience, userId]);
  });
  
  // 更新限额
  quota.likesToday++;
  await updateQuota(userId, quota);
  
  // 清除排行榜缓存
  await del(REDIS_KEYS.leaderboard);
  
  // 记录指标
  incrementCounter('pokemon_like_total', { pokemon_id: pokemonId });
  incrementCounter('pokemon_showcase_reward_given_total');
  incrementCounter('pokemon_showcase_reward_coins_total', REWARDS.likedByOther.coins + REWARDS.likeOther.coins);
  incrementCounter('pokemon_showcase_reward_experience_total', REWARDS.likedByOther.experience + REWARDS.likeOther.experience);
  
  logger.info({ userId, pokemonId, ownerId: pokemon.user_id }, 'Pokemon liked');
  
  // 获取当前点赞数
  const statsResult = await query(`
    SELECT like_count FROM pokemon_showcase_stats WHERE pokemon_id = $1
  `, [pokemonId]);
  
  return {
    success: true,
    likeCount: statsResult.rows[0]?.like_count || 1,
    reward: REWARDS.likeOther
  };
}

/**
 * 取消点赞
 */
async function unlikePokemon(userId, pokemonId) {
  const result = await query(`
    DELETE FROM pokemon_likes 
    WHERE pokemon_id = $1 AND user_id = $2
    RETURNING id
  `, [pokemonId, userId]);
  
  if (result.rows.length === 0) {
    throw new Error('Like not found');
  }
  
  // 更新统计
  await query(`
    UPDATE pokemon_showcase_stats 
    SET like_count = GREATEST(0, like_count - 1),
        updated_at = NOW()
    WHERE pokemon_id = $1
  `, [pokemonId]);
  
  // 清除排行榜缓存
  await del(REDIS_KEYS.leaderboard);
  
  logger.info({ userId, pokemonId }, 'Pokemon unliked');
  
  // 获取当前点赞数
  const statsResult = await query(`
    SELECT like_count FROM pokemon_showcase_stats WHERE pokemon_id = $1
  `, [pokemonId]);
  
  return {
    success: true,
    likeCount: statsResult.rows[0]?.like_count || 0
  };
}

/**
 * 检查是否已点赞
 */
async function hasLiked(userId, pokemonId) {
  const result = await query(`
    SELECT id FROM pokemon_likes WHERE pokemon_id = $1 AND user_id = $2
  `, [pokemonId, userId]);
  
  return result.rows.length > 0;
}

// ============================================================
// 评语功能
// ============================================================

/**
 * 敏感词过滤
 */
function filterSensitiveWords(comment) {
  // 简单的敏感词列表（实际项目应使用专门的敏感词库）
  const sensitiveWords = ['spam', 'bad', 'ugly', 'hate'];
  
  const lowerComment = comment.toLowerCase();
  for (const word of sensitiveWords) {
    if (lowerComment.includes(word)) {
      throw new Error('Comment contains inappropriate content');
    }
  }
  
  return comment;
}

/**
 * 添加评语
 */
async function addComment(userId, pokemonId, comment) {
  // 验证评语长度
  if (!comment || comment.length < 1) {
    throw new Error('Comment cannot be empty');
  }
  
  if (comment.length > MAX_COMMENT_LENGTH) {
    throw new Error(`Comment exceeds maximum length (${MAX_COMMENT_LENGTH} characters)`);
  }
  
  // 敏感词过滤
  filterSensitiveWords(comment);
  
  // 检查精灵是否存在
  const pokemonCheck = await query(`
    SELECT pi.id, pi.user_id
    FROM pokemon_instances pi
    WHERE pi.id = $1
  `, [pokemonId]);
  
  if (pokemonCheck.rows.length === 0) {
    throw new Error('Pokemon not found');
  }
  
  const pokemon = pokemonCheck.rows[0];
  
  // 检查是否已发表过评语
  const existingCheck = await query(`
    SELECT id FROM pokemon_comments WHERE pokemon_id = $1 AND user_id = $2
  `, [pokemonId, userId]);
  
  if (existingCheck.rows.length > 0) {
    throw new Error('Already commented on this pokemon');
  }
  
  // 检查并更新限额
  const quota = await checkAndUpdateQuota(userId, 'comment');
  
  // 执行添加评语
  let commentId;
  await transaction(async (client) => {
    // 添加评语
    const result = await client.query(`
      INSERT INTO pokemon_comments (pokemon_id, user_id, comment)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [pokemonId, userId, comment]);
    
    commentId = result.rows[0].id;
    
    // 更新统计
    await client.query(`
      INSERT INTO pokemon_showcase_stats (pokemon_id, comment_count)
      VALUES ($1, 1)
      ON CONFLICT (pokemon_id) 
      DO UPDATE SET 
        comment_count = pokemon_showcase_stats.comment_count + 1,
        updated_at = NOW()
    `, [pokemonId]);
    
    // 给精灵主人发放奖励（如果不是自己的精灵）
    if (pokemon.user_id !== userId) {
      await client.query(`
        UPDATE users 
        SET coins = coins + $1, experience = experience + $2
        WHERE id = $3
      `, [REWARDS.commentedByOther.coins, REWARDS.commentedByOther.experience, pokemon.user_id]);
    }
    
    // 给评论者发放奖励
    await client.query(`
      UPDATE users 
      SET coins = coins + $1, experience = experience + $2
      WHERE id = $3
    `, [REWARDS.commentOther.coins, REWARDS.commentOther.experience, userId]);
  });
  
  // 更新限额
  quota.commentsToday++;
  await updateQuota(userId, quota);
  
  // 记录指标
  incrementCounter('pokemon_comment_total', { pokemon_id: pokemonId });
  incrementCounter('pokemon_showcase_reward_given_total');
  incrementCounter('pokemon_showcase_reward_coins_total', REWARDS.commentOther.coins);
  
  logger.info({ userId, pokemonId, commentLength: comment.length }, 'Comment added');
  
  return {
    success: true,
    commentId,
    reward: REWARDS.commentOther
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
    WHERE pc.pokemon_id = $1
    ORDER BY pc.created_at DESC
    LIMIT $2 OFFSET $3
  `, [pokemonId, limit, offset]);
  
  const countResult = await query(`
    SELECT COUNT(*) as total FROM pokemon_comments WHERE pokemon_id = $1
  `, [pokemonId]);
  
  return {
    comments: result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      nickname: row.nickname,
      avatarUrl: row.avatar_url,
      comment: row.comment,
      createdAt: row.created_at
    })),
    total: parseInt(countResult.rows[0].total)
  };
}

/**
 * 删除评语
 */
async function deleteComment(userId, commentId) {
  const result = await query(`
    DELETE FROM pokemon_comments 
    WHERE id = $1 AND user_id = $2
    RETURNING pokemon_id
  `, [commentId, userId]);
  
  if (result.rows.length === 0) {
    throw new Error('Comment not found or not authorized');
  }
  
  const pokemonId = result.rows[0].pokemon_id;
  
  // 更新统计
  await query(`
    UPDATE pokemon_showcase_stats 
    SET comment_count = GREATEST(0, comment_count - 1),
        updated_at = NOW()
    WHERE pokemon_id = $1
  `, [pokemonId]);
  
  logger.info({ userId, commentId, pokemonId }, 'Comment deleted');
  
  return { success: true, message: 'Comment deleted' };
}

// ============================================================
// 展示页面
// ============================================================

/**
 * 获取用户展示页
 */
async function getUserShowcase(userId, viewerId) {
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
      pi.species_id,
      ps.name_en as species,
      pi.level,
      pi.cp,
      pi.is_shiny,
      pi.iv_attack,
      pi.iv_defense,
      pi.iv_stamina,
      ROUND((pi.iv_attack + pi.iv_defense + pi.iv_stamina) / 45.0 * 100) as iv_percentage,
      COALESCE(pss.like_count, 0) as like_count,
      COALESCE(pss.comment_count, 0) as comment_count
    FROM pokemon_favorites pf
    JOIN pokemon_instances pi ON pf.pokemon_id = pi.id
    JOIN pokemon_species ps ON pi.species_id = ps.id
    LEFT JOIN pokemon_showcase_stats pss ON pf.pokemon_id = pss.pokemon_id
    WHERE pf.user_id = $1 AND pf.is_showcased = true
    ORDER BY pf.display_order ASC
  `, [userId]);
  
  // 检查观众是否已点赞
  let likedPokemonIds = [];
  if (viewerId) {
    const pokemonIds = favoritesResult.rows.map(r => r.pokemon_id);
    if (pokemonIds.length > 0) {
      const likesResult = await query(`
        SELECT pokemon_id FROM pokemon_likes
        WHERE user_id = $1 AND pokemon_id = ANY($2)
      `, [viewerId, pokemonIds]);
      
      likedPokemonIds = likesResult.rows.map(r => r.pokemon_id);
    }
  }
  
  // 更新浏览次数
  await query(`
    UPDATE pokemon_showcase_stats 
    SET view_count = view_count + 1
    WHERE pokemon_id = ANY($1)
  `, [favoritesResult.rows.map(r => r.pokemon_id)]);
  
  // 获取统计
  const statsResult = await query(`
    SELECT 
      COALESCE(SUM(pss.like_count), 0) as total_likes,
      COALESCE(SUM(pss.view_count), 0) as total_views
    FROM pokemon_favorites pf
    LEFT JOIN pokemon_showcase_stats pss ON pf.pokemon_id = pss.pokemon_id
    WHERE pf.user_id = $1
  `, [userId]);
  
  incrementCounter('pokemon_showcase_view_total');
  
  return {
    userId: user.id,
    nickname: user.nickname,
    level: user.level,
    team: user.team,
    avatarUrl: user.avatar_url,
    showcase: favoritesResult.rows.map(row => ({
      pokemonId: row.pokemon_id,
      speciesId: row.species_id,
      species: row.species,
      level: row.level,
      cp: row.cp,
      isShiny: row.is_shiny,
      iv: Math.round(row.iv_percentage),
      likeCount: row.like_count,
      commentCount: row.comment_count,
      isLikedByMe: likedPokemonIds.includes(row.pokemon_id)
    })),
    stats: {
      totalLikes: parseInt(statsResult.rows[0].total_likes),
      totalViews: parseInt(statsResult.rows[0].total_views)
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
  const cacheKey = `${REDIS_KEYS.leaderboard}:${type}`;
  
  // 尝试从缓存获取
  const cached = await getJSON(cacheKey);
  if (cached) {
    return cached;
  }
  
  // 从数据库查询
  let orderBy = 'pss.like_count DESC, pss.comment_count DESC';
  
  const result = await query(`
    SELECT 
      pi.id as pokemon_id,
      ps.name_en as species,
      pi.level,
      pi.cp,
      pi.is_shiny,
      ROUND((pi.iv_attack + pi.iv_defense + pi.iv_stamina) / 45.0 * 100) as iv_percentage,
      pi.user_id as owner_id,
      u.nickname as owner_nickname,
      COALESCE(pss.like_count, 0) as like_count,
      COALESCE(pss.comment_count, 0) as comment_count
    FROM pokemon_instances pi
    JOIN pokemon_species ps ON pi.species_id = ps.id
    JOIN users u ON pi.user_id = u.id
    LEFT JOIN pokemon_showcase_stats pss ON pi.id = pss.pokemon_id
    WHERE pss.like_count > 0
    ORDER BY ${orderBy}
    LIMIT $1
  `, [limit]);
  
  const leaderboard = result.rows.map((row, index) => ({
    rank: index + 1,
    pokemonId: row.pokemon_id,
    species: row.species,
    level: row.level,
    cp: row.cp,
    isShiny: row.is_shiny,
    iv: Math.round(row.iv_percentage),
    ownerId: row.owner_id,
    ownerNickname: row.owner_nickname,
    likeCount: row.like_count,
    commentCount: row.comment_count
  }));
  
  // 缓存 1 小时
  await setJSON(cacheKey, leaderboard, 3600);
  
  return leaderboard;
}

// ============================================================
// 导出
// ============================================================

module.exports = {
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
  
  // 常量导出（用于测试）
  MAX_FAVORITES,
  MAX_LIKES_PER_DAY,
  MAX_COMMENTS_PER_DAY,
  MAX_COMMENT_LENGTH,
  REWARDS
};
