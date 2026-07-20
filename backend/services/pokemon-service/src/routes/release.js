/**
 * REQ-00240: 精灵放生与资源回收系统 API
 * 路由: /api/pokemon/release
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const db = require('../../../../shared/db');
const logger = require('../../../../shared/logger');
const ReleaseCalculator = require('../../../../shared/ReleaseCalculator');
const { authenticate } = require('../../../../shared/authMiddleware');
const { sendKafkaEvent } = require('../../../../shared/kafkaProducer');
const metrics = require('../../../../shared/metrics');

/**
 * POST /api/pokemon/release/preview
 * 预览放生资源
 */
router.post('/preview', authenticate, async (req, res) => {
  try {
    const { pokemonIds } = req.body;
    const userId = req.user.id;

    if (!pokemonIds || !Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_INPUT',
        message: '请选择要放生的精灵'
      });
    }

    // 限制批量放生数量
    if (pokemonIds.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'TOO_MANY_POKEMON',
        message: '单次最多放生 100 只精灵'
      });
    }

    // 验证所有权并获取精灵信息
    const pokemon = await db.query(`
      SELECT 
        pi.id, pi.species_id, pi.level, pi.iv_total, pi.is_shiny,
        ps.rarity, ps.name, ps.pokedex_number
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = ANY($1) AND pi.owner_id = $2
    `, [pokemonIds, userId]);

    if (pokemon.rows.length !== pokemonIds.length) {
      const foundIds = pokemon.rows.map(p => p.id);
      const missingIds = pokemonIds.filter(id => !foundIds.includes(id));
      
      return res.status(400).json({
        success: false,
        error: 'INVALID_POKEMON',
        message: '部分精灵不存在或不属于该用户',
        missingIds
      });
    }

    // 计算资源
    const result = ReleaseCalculator.calculateBatchResources(pokemon.rows);

    // 检查需要确认的精灵
    const requiresConfirmation = pokemon.rows
      .filter(p => ReleaseCalculator.requiresConfirmation(p))
      .map(p => ({
        id: p.id,
        name: p.name,
        rarity: p.rarity,
        ivTotal: p.iv_total,
        isShiny: p.is_shiny,
        level: p.level
      }));

    // 记录预览指标
    if (metrics && metrics.releasePreviewCount) {
      metrics.releasePreviewCount.inc({ 
        count: pokemonIds.length,
        has_high_value: requiresConfirmation.length > 0 
      });
    }

    res.json({
      success: true,
      data: {
        totalResources: result.totalResources,
        pokemonCount: pokemonIds.length,
        details: result.details,
        requiresConfirmation
      }
    });
  } catch (error) {
    logger.error('放生预览失败', { 
      error: error.message, 
      userId: req.user?.id 
    });
    res.status(500).json({ 
      success: false, 
      error: 'INTERNAL_ERROR' 
    });
  }
});

/**
 * POST /api/pokemon/release/execute
 * 执行放生
 */
router.post('/execute', authenticate, async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { pokemonIds, confirmationToken } = req.body;
    const userId = req.user.id;

    if (!pokemonIds || !Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_INPUT'
      });
    }

    // 获取精灵信息并锁定
    const pokemon = await client.query(`
      SELECT 
        pi.id, pi.species_id, pi.level, pi.iv_total, pi.is_shiny,
        ps.rarity, ps.name, ps.pokedex_number
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = ANY($1) AND pi.owner_id = $2
      FOR UPDATE
    `, [pokemonIds, userId]);

    if (pokemon.rows.length !== pokemonIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_POKEMON',
        message: '部分精灵不存在或不属于该用户'
      });
    }

    // 检查需要确认的精灵
    const needsConfirm = pokemon.rows.filter(p => 
      ReleaseCalculator.requiresConfirmation(p)
    );

    if (needsConfirm.length > 0 && !confirmationToken) {
      const token = crypto.randomBytes(32).toString('hex');
      
      // 存储确认令牌
      await client.query(`
        INSERT INTO pending_releases (user_id, pokemon_ids, token, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')
      `, [userId, JSON.stringify(pokemonIds), token]);

      await client.query('ROLLBACK');
      
      return res.status(403).json({
        success: false,
        error: 'CONFIRMATION_REQUIRED',
        message: '包含高价值精灵，需要二次确认',
        confirmationToken: token,
        pokemonRequiringConfirmation: needsConfirm.map(p => ({
          id: p.id,
          name: p.name,
          rarity: p.rarity,
          ivTotal: p.iv_total,
          isShiny: p.is_shiny,
          level: p.level
        }))
      });
    }

    // 验证确认令牌
    if (confirmationToken) {
      const pending = await client.query(`
        SELECT * FROM pending_releases
        WHERE user_id = $1 AND token = $2 AND expires_at > NOW()
      `, [userId, confirmationToken]);

      if (pending.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'INVALID_TOKEN',
          message: '确认令牌无效或已过期'
        });
      }
    }

    // 计算资源
    const result = ReleaseCalculator.calculateBatchResources(pokemon.rows);

    // 创建放生记录
    for (const p of pokemon.rows) {
      const resources = ReleaseCalculator.calculateResources(p);
      await client.query(`
        INSERT INTO pokemon_releases 
          (user_id, pokemon_instance_id, pokemon_species_id, level, 
           iv_total, is_shiny, rarity, resources_returned, confirmed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [
        userId, p.id, p.species_id, p.level,
        p.iv_total, p.is_shiny, p.rarity, JSON.stringify(resources)
      ]);
    }

    // 删除精灵
    await client.query(`
      DELETE FROM pokemon_instances
      WHERE id = ANY($1) AND owner_id = $2
    `, [pokemonIds, userId]);

    // 发放资源
    const goldAmount = result.totalResources.gold || 0;
    const stardustAmount = result.totalResources.stardust || 0;
    
    await client.query(`
      UPDATE users SET
        gold = COALESCE(gold, 0) + $1,
        stardust = COALESCE(stardust, 0) + $2,
        updated_at = NOW()
      WHERE id = $3
    `, [goldAmount, stardustAmount, userId]);

    // 发送 Kafka 事件
    if (sendKafkaEvent) {
      await sendKafkaEvent('pokemon.released', {
        userId,
        pokemonCount: pokemonIds.length,
        resources: result.totalResources,
        timestamp: new Date().toISOString()
      });
    }

    await client.query('COMMIT');

    // 清理确认令牌
    if (confirmationToken) {
      await client.query(`
        DELETE FROM pending_releases WHERE token = $1
      `, [confirmationToken]);
    }

    // 记录指标
    if (metrics && metrics.pokemonReleaseTotal) {
      metrics.pokemonReleaseTotal.inc({ 
        count: pokemonIds.length 
      });
    }

    logger.info('精灵放生成功', {
      userId,
      pokemonCount: pokemonIds.length,
      resources: result.totalResources
    });

    res.json({
      success: true,
      data: {
        message: '放生成功',
        resources: result.totalResources,
        pokemonCount: pokemonIds.length
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('放生执行失败', { 
      error: error.message, 
      userId: req.user?.id 
    });
    res.status(500).json({ 
      success: false, 
      error: 'INTERNAL_ERROR' 
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/pokemon/release/history
 * 查询放生历史
 */
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const result = await db.query(`
      SELECT 
        pr.id, pr.pokemon_instance_id, pr.level, pr.iv_total, 
        pr.is_shiny, pr.rarity, pr.resources_returned, pr.released_at,
        ps.name as pokemon_name, ps.pokedex_number
      FROM pokemon_releases pr
      JOIN pokemon_species ps ON pr.pokemon_species_id = ps.id
      WHERE pr.user_id = $1
      ORDER BY pr.released_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const countResult = await db.query(`
      SELECT COUNT(*) as total FROM pokemon_releases WHERE user_id = $1
    `, [userId]);

    res.json({
      success: true,
      data: {
        releases: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].total)
        }
      }
    });
  } catch (error) {
    logger.error('查询放生历史失败', { 
      error: error.message, 
      userId: req.user?.id 
    });
    res.status(500).json({ 
      success: false, 
      error: 'INTERNAL_ERROR' 
    });
  }
});

/**
 * GET /api/pokemon/release/stats
 * 放生统计
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;

    const stats = await db.query(`
      SELECT 
        COUNT(*) as total_releases,
        COUNT(DISTINCT pokemon_species_id) as unique_species,
        COALESCE(SUM((resources_returned->>'gold')::numeric), 0) as total_gold,
        COALESCE(SUM((resources_returned->>'stardust')::numeric), 0) as total_stardust,
        COUNT(*) FILTER (WHERE is_shiny) as shiny_releases,
        MAX(released_at) as last_release_at
      FROM pokemon_releases
      WHERE user_id = $1
        AND ($2::timestamp IS NULL OR released_at >= $2)
        AND ($3::timestamp IS NULL OR released_at <= $3)
    `, [userId, startDate || null, endDate || null]);

    res.json({
      success: true,
      data: stats.rows[0]
    });
  } catch (error) {
    logger.error('查询放生统计失败', { 
      error: error.message, 
      userId: req.user?.id 
    });
    res.status(500).json({ 
      success: false, 
      error: 'INTERNAL_ERROR' 
    });
  }
});

module.exports = router;
