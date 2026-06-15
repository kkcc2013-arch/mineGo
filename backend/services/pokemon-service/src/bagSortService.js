/**
 * Bag Sort Service - 背包排序服务
 * REQ-00110: 精灵背包容量管理与扩展系统
 * 
 * 功能:
 * - 多种排序方式
 * - 筛选功能
 * - 自定义排序顺序
 */

'use strict';

const { query } = require('../../../shared/db');
const logger = require('../../../shared/logger');

class BagSortService {
  /**
   * 获取排序后的精灵列表
   * @param {number} userId - 用户ID
   * @param {Object} options - 排序选项
   * @returns {Promise<Object>} 精灵列表和分页信息
   */
  async getSortedPokemonList(userId, options = {}) {
    const {
      sortBy = 'recent',
      sortOrder = 'desc',
      page = 1,
      limit = 30,
      filters = {},
      storageStatus = 'bag' // bag, storage, all
    } = options;

    const offset = (page - 1) * limit;
    const orderBy = this.buildOrderBy(sortBy, sortOrder);
    const { whereClause, params } = this.buildWhereClause(filters, storageStatus);

    try {
      // 主查询
      const result = await query(`
        SELECT 
          p.id,
          p.species_id,
          p.level,
          p.cp,
          p.iv_attack,
          p.iv_defense,
          p.iv_stamina,
          p.is_shiny,
          p.is_favorited,
          p.favorite_at,
          p.bag_sort_order,
          p.storage_status,
          p.created_at,
          p.nickname,
          s.name as species_name,
          s.name_zh,
          s.name_en,
          s.types,
          s.pokedex_number,
          s.is_legendary,
          s.is_mythical
        FROM pokemon p
        JOIN species s ON s.id = p.species_id
        WHERE p.user_id = $1 
        AND p.is_released = FALSE 
        ${whereClause}
        ORDER BY 
          CASE WHEN p.is_favorited THEN 0 ELSE 1 END,
          ${orderBy}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]);

      // 获取总数
      const countResult = await query(`
        SELECT COUNT(*) as total 
        FROM pokemon p
        JOIN species s ON s.id = p.species_id
        WHERE p.user_id = $1 
        AND p.is_released = FALSE 
        ${whereClause}
      `, params);

      // 计算IV百分比
      const pokemon = result.rows.map(p => ({
        ...p,
        iv_percent: ((p.iv_attack + p.iv_defense + p.iv_stamina) / 45 * 100).toFixed(1),
        types: p.types || []
      }));

      return {
        pokemon,
        pagination: {
          page,
          limit,
          total: parseInt(countResult.rows[0].total),
          totalPages: Math.ceil(countResult.rows[0].total / limit)
        },
        sortBy,
        sortOrder
      };
    } catch (error) {
      logger.error('[BagSortService] getSortedPokemonList error:', error);
      throw error;
    }
  }

  /**
   * 批量设置排序顺序
   * @param {number} userId - 用户ID
   * @param {Array<number>} pokemonIds - 精灵ID列表（按新顺序）
   * @returns {Promise<Object>} 更新结果
   */
  async updateSortOrder(userId, pokemonIds) {
    try {
      // 使用 unnest 批量更新
      const result = await query(`
        UPDATE pokemon 
        SET bag_sort_order = s.row_num - 1
        FROM UNNEST($1::int[]) WITH ORDINALITY AS s(pokemon_id, row_num)
        WHERE pokemon.id = s.pokemon_id 
        AND pokemon.user_id = $2
        AND pokemon.is_released = FALSE
      `, [pokemonIds, userId]);

      return { 
        success: true, 
        updated: result.rowCount 
      };
    } catch (error) {
      logger.error('[BagSortService] updateSortOrder error:', error);
      throw error;
    }
  }

  /**
   * 获取筛选选项
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 可用的筛选选项
   */
  async getFilterOptions(userId) {
    try {
      // 获取所有类型
      const typesResult = await query(`
        SELECT DISTINCT unnest(s.types) as type
        FROM pokemon p
        JOIN species s ON s.id = p.species_id
        WHERE p.user_id = $1 AND p.is_released = FALSE
        ORDER BY type
      `, [userId]);

      // 获取CP范围
      const cpRangeResult = await query(`
        SELECT MIN(cp) as min_cp, MAX(cp) as max_cp
        FROM pokemon
        WHERE user_id = $1 AND is_released = FALSE
      `, [userId]);

      // 获取统计
      const statsResult = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE is_favorited) as favorited,
          COUNT(*) FILTER (WHERE is_shiny) as shiny,
          COUNT(*) FILTER (WHERE storage_status = 'storage') as in_storage
        FROM pokemon
        WHERE user_id = $1 AND is_released = FALSE
      `, [userId]);

      return {
        types: typesResult.rows.map(r => r.type),
        cpRange: cpRangeResult.rows[0],
        stats: statsResult.rows[0]
      };
    } catch (error) {
      logger.error('[BagSortService] getFilterOptions error:', error);
      throw error;
    }
  }

  /**
   * 构建排序语句
   */
  buildOrderBy(sortBy, sortOrder) {
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const sortMap = {
      recent: `p.created_at ${order}`,
      cp: `p.cp ${order}`,
      iv: `((p.iv_attack + p.iv_defense + p.iv_stamina)::float / 45) ${order}`,
      name: `COALESCE(p.nickname, s.name_zh, s.name_en) ${order}`,
      species: `s.pokedex_number ${order}`,
      favorite: `p.is_favorited DESC, p.favorite_at ${order}`,
      level: `p.level ${order}`,
      number: `s.pokedex_number ${order}`,
      order: `p.bag_sort_order ${order}`
    };
    return sortMap[sortBy] || sortMap.recent;
  }

  /**
   * 构建 WHERE 子句
   */
  buildWhereClause(filters, storageStatus) {
    const params = [];
    const conditions = [];
    let paramIndex = 2; // $1 is userId

    // 存储状态
    if (storageStatus === 'bag') {
      conditions.push(`p.storage_status = 'bag'`);
    } else if (storageStatus === 'storage') {
      conditions.push(`p.storage_status = 'storage'`);
    }

    // 类型筛选
    if (filters.type) {
      conditions.push(`$${paramIndex} = ANY(s.types)`);
      params.push(filters.type);
      paramIndex++;
    }

    // CP 范围
    if (filters.minCp !== undefined) {
      conditions.push(`p.cp >= $${paramIndex}`);
      params.push(filters.minCp);
      paramIndex++;
    }
    if (filters.maxCp !== undefined) {
      conditions.push(`p.cp <= $${paramIndex}`);
      params.push(filters.maxCp);
      paramIndex++;
    }

    // IV 范围
    if (filters.minIv !== undefined) {
      conditions.push(`((p.iv_attack + p.iv_defense + p.iv_stamina)::float / 45 * 100) >= $${paramIndex}`);
      params.push(filters.minIv);
      paramIndex++;
    }
    if (filters.maxIv !== undefined) {
      conditions.push(`((p.iv_attack + p.iv_defense + p.iv_stamina)::float / 45 * 100) <= $${paramIndex}`);
      params.push(filters.maxIv);
      paramIndex++;
    }

    // 闪光
    if (filters.isShiny !== undefined) {
      conditions.push(`p.is_shiny = $${paramIndex}`);
      params.push(filters.isShiny);
      paramIndex++;
    }

    // 收藏
    if (filters.isFavorited !== undefined) {
      conditions.push(`p.is_favorited = $${paramIndex}`);
      params.push(filters.isFavorited);
      paramIndex++;
    }

    // 传说/幻兽
    if (filters.isLegendary !== undefined) {
      conditions.push(`s.is_legendary = $${paramIndex}`);
      params.push(filters.isLegendary);
      paramIndex++;
    }
    if (filters.isMythical !== undefined) {
      conditions.push(`s.is_mythical = $${paramIndex}`);
      params.push(filters.isMythical);
      paramIndex++;
    }

    // 搜索关键词
    if (filters.search) {
      conditions.push(`(
        LOWER(s.name_zh) LIKE LOWER($${paramIndex}) OR
        LOWER(s.name_en) LIKE LOWER($${paramIndex}) OR
        LOWER(p.nickname) LIKE LOWER($${paramIndex})
      )`);
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    // 种族ID列表
    if (filters.speciesIds && filters.speciesIds.length > 0) {
      conditions.push(`p.species_id = ANY($${paramIndex})`);
      params.push(filters.speciesIds);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 
      ? 'AND ' + conditions.join(' AND ') 
      : '';

    return { whereClause, params };
  }

  /**
   * 快速排序 - 按指定规则重新排列
   * @param {number} userId - 用户ID
   * @param {string} sortBy - 排序方式
   * @param {string} sortOrder - 排序顺序
   * @returns {Promise<Object>} 排序结果
   */
  async quickSort(userId, sortBy = 'cp', sortOrder = 'desc') {
    try {
      const orderBy = this.buildOrderBy(sortBy, sortOrder);
      
      // 获取排序后的ID列表
      const result = await query(`
        SELECT id FROM pokemon
        WHERE user_id = $1 AND is_released = FALSE AND storage_status = 'bag'
        ORDER BY 
          CASE WHEN is_favorited THEN 0 ELSE 1 END,
          ${orderBy}
      `, [userId]);

      // 批量更新排序顺序
      const ids = result.rows.map(r => r.id);
      await this.updateSortOrder(userId, ids);

      return {
        success: true,
        sortedCount: ids.length,
        sortBy,
        sortOrder
      };
    } catch (error) {
      logger.error('[BagSortService] quickSort error:', error);
      throw error;
    }
  }
}

module.exports = new BagSortService();
