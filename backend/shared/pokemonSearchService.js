/**
 * REQ-00498: 精灵搜索服务
 * 提供精灵搜索、筛选、排序功能
 */

'use strict';

const { query } = require('./db');
const { createLogger } = require('./logger');
const PokemonSearchCache = require('./pokemonSearchCache');
const metrics = require('./metrics');
const { getRedis } = require('./redisUtils');

const logger = createLogger('pokemon-search-service');

class PokemonSearchService {
  constructor() {
    this.cache = new PokemonSearchCache(getRedis());
  }

  /**
   * 搜索精灵（支持模糊匹配、拼音、类型筛选）
   * @param {number} userId - 用户 ID
   * @param {string} term - 搜索词
   * @param {object} options - 搜索选项
   * @returns {object[]} 精灵列表
   */
  async search(userId, term, options = {}) {
    const { 
      limit = 50, 
      types = null, 
      minCp = null, 
      maxCp = null,
      sort = 'cp'
    } = options;

    const timer = metrics.histogramTimer('pokemon_search_latency_ms');
    const searchParams = { hasTerm: !!term, hasFilter: !!types || !!minCp || !!maxCp };

    try {
      // 1. 检查缓存
      if (term && term.length >= 2 && !types && !minCp && !maxCp) {
        const cachedIds = await this.cache.getSearchResults(userId, term);
        if (cachedIds && cachedIds.length > 0) {
          const pokemon = await this.getPokemonByIds(userId, cachedIds.slice(0, limit), sort);
          timer();
          metrics.incrementCounter('pokemon_search_requests_total', searchParams);
          metrics.incrementCounter('pokemon_search_cache_hits');
          
          logger.info({ userId, term, cached: true, count: pokemon.length }, 'Search completed (cached)');
          return pokemon;
        }
      }

      // 2. 构建查询条件
      const conditions = ['p.user_id = $1'];
      const params = [userId];
      let paramIndex = 2;

      // 名称模糊搜索（使用 pg_trgm）
      if (term && term.length >= 2) {
        conditions.push(`(
          p.nickname ILIKE $${paramIndex} OR 
          ps.name ILIKE $${paramIndex} OR
          ps.name_cn ILIKE $${paramIndex}
        )`);
        params.push(`%${term}%`);
        paramIndex++;
      }

      // 类型筛选
      if (types && types.length > 0) {
        conditions.push(`(p.types[1] = ANY($${paramIndex}) OR p.types[2] = ANY($${paramIndex}))`);
        params.push(types);
        paramIndex++;
      }

      // CP 范围筛选
      if (minCp !== null) {
        conditions.push(`p.cp >= $${paramIndex}`);
        params.push(parseInt(minCp));
        paramIndex++;
      }
      if (maxCp !== null) {
        conditions.push(`p.cp <= $${paramIndex}`);
        params.push(parseInt(maxCp));
        paramIndex++;
      }

      // 排序
      const orderBy = this._getOrderBy(sort);

      // 3. 执行查询
      const sql = `
        SELECT 
          p.id, p.user_id, p.species_id, p.nickname, p.cp, p.hp, 
          p.attack, p.defense, p.types, p.level, p.ivs, p.created_at,
          ps.name as species_name, ps.name_cn as species_name_cn, 
          ps.types as species_types, ps.rarity, ps.image_url
        FROM pokemon p
        JOIN pokemon_species ps ON p.species_id = ps.id
        WHERE ${conditions.join(' AND ')}
        ${orderBy}
        LIMIT $${paramIndex}
      `;
      params.push(limit);

      const { rows } = await query(sql, params);

      // 4. 缓存搜索结果（仅缓存简单搜索）
      if (rows.length > 0 && term && term.length >= 2 && !types && !minCp && !maxCp) {
        await this.cache.cacheSearch(userId, term, rows.map(r => r.id));
      }

      timer();
      metrics.incrementCounter('pokemon_search_requests_total', searchParams);
      
      logger.info({ userId, term, cached: false, count: rows.length }, 'Search completed');
      
      return rows;
    } catch (error) {
      timer();
      metrics.incrementCounter('pokemon_search_errors_total');
      
      logger.error({ error, userId, term, options }, 'Search failed');
      throw error;
    }
  }

  /**
   * 获取精灵列表（带筛选和排序）
   * @param {number} userId - 用户 ID
   * @param {object} options - 选项
   * @returns {object} 精灵列表 + 分页信息
   */
  async getList(userId, options = {}) {
    const {
      page = 0,
      pageSize = 20,
      sort = 'cp',
      type = null,
      minCp = null,
      maxCp = null
    } = options;

    const timer = metrics.histogramTimer('pokemon_list_latency_ms');
    const filter = { type, minCp, maxCp };

    try {
      // 1. 检查缓存
      const cachedIds = await this.cache.getListIds(userId, sort, filter);
      
      if (cachedIds && cachedIds.ids && cachedIds.ids.length > 0) {
        // 使用缓存 ID，获取当前页
        const startIndex = page * pageSize;
        const endIndex = startIndex + pageSize;
        const pageIds = cachedIds.ids.slice(startIndex, endIndex);
        
        const pokemon = await this.getPokemonByIds(userId, pageIds, sort);
        
        timer();
        metrics.incrementCounter('pokemon_list_cache_hits');
        
        logger.debug({ userId, sort, page, cached: true, count: pokemon.length }, 'List retrieved (cached)');
        
        return {
          pokemon,
          page,
          pageSize,
          total: cachedIds.total,
          hasMore: endIndex < cachedIds.total,
          cached: true,
          cachedAt: cachedIds.cachedAt
        };
      }

      // 2. 缓存未命中，查询数据库
      const conditions = ['p.user_id = $1'];
      const params = [userId];
      let paramIndex = 2;

      if (type) {
        conditions.push(`(p.types[1] = $${paramIndex} OR p.types[2] = $${paramIndex})`);
        params.push(type);
        paramIndex++;
      }

      if (minCp) {
        conditions.push(`p.cp >= $${paramIndex}`);
        params.push(parseInt(minCp));
        paramIndex++;
      }

      if (maxCp) {
        conditions.push(`p.cp <= $${paramIndex}`);
        params.push(parseInt(maxCp));
        paramIndex++;
      }

      const orderBy = this._getOrderBy(sort);

      // 查询所有符合条件的精灵（用于缓存）
      const sql = `
        SELECT 
          p.id, p.user_id, p.species_id, p.nickname, p.cp, p.hp, 
          p.attack, p.defense, p.types, p.level, p.ivs, p.created_at,
          ps.name as species_name, ps.name_cn as species_name_cn,
          ps.types as species_types, ps.rarity, ps.image_url
        FROM pokemon p
        JOIN pokemon_species ps ON p.species_id = ps.id
        WHERE ${conditions.join(' AND ')}
        ${orderBy}
      `;

      const { rows } = await query(sql, params);

      // 3. 缓存 ID 列表
      if (rows.length > 0) {
        await this.cache.cacheList(userId, sort, filter, rows.map(r => r.id));
      }

      // 4. 返回当前页
      const startIndex = page * pageSize;
      const endIndex = startIndex + pageSize;
      const pagePokemon = rows.slice(startIndex, endIndex);

      timer();
      metrics.incrementCounter('pokemon_list_db_queries');
      
      logger.debug({ userId, sort, page, cached: false, total: rows.length }, 'List retrieved (database)');
      
      return {
        pokemon: pagePokemon,
        page,
        pageSize,
        total: rows.length,
        hasMore: endIndex < rows.length,
        cached: false
      };
    } catch (error) {
      timer();
      metrics.incrementCounter('pokemon_list_errors');
      
      logger.error({ error, userId, options }, 'List query failed');
      throw error;
    }
  }

  /**
   * 根据精灵 ID 获取详情
   * @param {number} userId - 用户 ID
   * @param {number[]} ids - 精灵 ID 数组
   * @param {string} sort - 排序方式
   * @returns {object[]} 精灵详情列表
   */
  async getPokemonByIds(userId, ids, sort = 'cp') {
    if (!ids || ids.length === 0) return [];

    const orderBy = this._getOrderBy(sort);
    
    const { rows } = await query(`
      SELECT 
        p.id, p.user_id, p.species_id, p.nickname, p.cp, p.hp, 
        p.attack, p.defense, p.types, p.level, p.ivs, p.created_at,
        ps.name as species_name, ps.name_cn as species_name_cn,
        ps.types as species_types, ps.rarity, ps.image_url
      FROM pokemon p
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE p.user_id = $1 AND p.id = ANY($2)
      ${orderBy}
    `, [userId, ids]);

    return rows;
  }

  /**
   * 获取用户精灵统计
   * @param {number} userId - 用户 ID
   * @returns {object} 统计数据
   */
  async getStats(userId) {
    // 检查缓存
    const cachedStats = await this.cache.getStats(userId);
    if (cachedStats) {
      return cachedStats;
    }

    const { rows: [stats] } = await query(`
      SELECT 
        COUNT(*) as total_pokemon,
        COUNT(CASE WHEN cp >= 2000 THEN 1 END) as high_cp_count,
        COUNT(CASE WHEN rarity = 'legendary' THEN 1 END) as legendary_count,
        MAX(cp) as max_cp,
        AVG(cp)::INTEGER as avg_cp,
        COUNT(DISTINCT species_id) as unique_species
      FROM pokemon p
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE p.user_id = $1
    `, [userId]);

    // 按类型统计
    const { rows: typeStats } = await query(`
      SELECT types[1] as type, COUNT(*) as count
      FROM pokemon WHERE user_id = $1
      GROUP BY types[1] ORDER BY count DESC
    `, [userId]);

    const result = {
      ...stats,
      typeStats
    };

    // 缓存统计数据
    await this.cache.cacheStats(userId, result);

    return result;
  }

  /**
   * 获取排序 SQL
   * @private
   */
  _getOrderBy(sort) {
    const orderMap = {
      'cp': 'ORDER BY p.cp DESC',
      'cp_asc': 'ORDER BY p.cp ASC',
      'name': 'ORDER BY ps.name ASC',
      'name_cn': 'ORDER BY ps.name_cn ASC',
      'recent': 'ORDER BY p.created_at DESC',
      'age': 'ORDER BY p.created_at ASC',
      'rarity': 'ORDER BY ps.rarity DESC, p.cp DESC',
      'level': 'ORDER BY p.level DESC'
    };
    
    return orderMap[sort] || 'ORDER BY p.cp DESC';
  }

  /**
   * 失效用户缓存（捕捉新精灵后调用）
   * @param {number} userId - 用户 ID
   * @param {string} reason - 失效原因
   */
  async invalidateUserCache(userId, reason) {
    const deleted = await this.cache.invalidateUser(userId, reason);
    logger.info({ userId, reason, deletedKeys: deleted }, 'User cache invalidated');
    return deleted;
  }

  /**
   * 检查是否存在慢查询
   * @param {number} latencyMs - 查询延迟
   * @param {string} endpoint - 接口名称
   */
  checkSlowQuery(latencyMs, endpoint) {
    if (latencyMs > 100) {
      metrics.incrementCounter('pokemon_slow_queries', { endpoint });
      logger.warn({ latencyMs, endpoint }, 'Slow pokemon query detected');
    }
  }
}

module.exports = new PokemonSearchService();