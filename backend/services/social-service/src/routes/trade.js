// backend/services/social-service/src/routes/trade.js
// 精灵交易路由

'use strict';

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const { calculateStardustCost, calculatePokemonValue } = require('../trade/stardust');
const { checkTradeLimits, checkPokemonFrequentTrade } = require('../trade/limits');
const { detectSuspiciousTrade } = require('../trade/antiCheat');
const { validateTradeDistance } = require('../trade/distance');
const { FraudDetectionService, RiskLevel } = require('../../../../shared/tradeFraudDetection');
const { 
  TradeConfirmationService,
  TradeRollbackService,
  TradeAuditService
} = require('../../../../shared/tradeConfirmation');

const fraudDetectionService = new FraudDetectionService();
const tradeConfirmationService = new TradeConfirmationService();
const tradeRollbackService = new TradeRollbackService();
const tradeAuditService = new TradeAuditService();

const logger = createLogger('trade-routes');

/**
 * POST /trades/request
 * 发起交易请求
 */
router.post('/request', requireAuth, async (req, res, next) => {
  try {
    const { friendId, myPokemonId, theirPokemonId } = req.body;
    const userId = req.user.sub;

    // 验证必填参数
    if (!friendId || !myPokemonId || !theirPokemonId) {
      throw new AppError(1001, '缺少必填参数（friendId, myPokemonId, theirPokemonId）', 400);
    }

    if (friendId === userId) {
      throw new AppError(2010, '不能与自己交易', 400);
    }

    // 验证好友关系
    const [a, b] = userId < friendId ? [userId, friendId] : [friendId, userId];
    const { rows: [friendship] } = await query(`
      SELECT level, interaction_days FROM friendships WHERE user_a = $1 AND user_b = $2
    `, [a, b]);

    if (!friendship) {
      throw new AppError(2009, '你们还不是好友', 400);
    }

    // 验证精灵所有权和获取精灵信息
    const { rows: [myPokemon] } = await query(`
      SELECT pi.id, pi.species_id, pi.cp, pi.level, pi.iv_attack, pi.iv_defense, pi.iv_hp,
             pi.is_lucky, pi.is_shiny, pi.defending_gym_id, ps.rarity, ps.name
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = $1 AND pi.user_id = $2
    `, [myPokemonId, userId]);

    if (!myPokemon) {
      throw new AppError(3001, '你的精灵不存在', 404);
    }

    if (myPokemon.defending_gym_id) {
      throw new AppError(3002, '精灵正在道馆驻守，无法交易', 400);
    }

    const { rows: [theirPokemon] } = await query(`
      SELECT pi.id, pi.species_id, pi.cp, pi.level, pi.iv_attack, pi.iv_defense, pi.iv_hp,
             pi.is_lucky, pi.is_shiny, pi.defending_gym_id, ps.rarity, ps.name
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = $1 AND pi.user_id = $2
    `, [theirPokemonId, friendId]);

    if (!theirPokemon) {
      throw new AppError(3001, '对方精灵不存在', 404);
    }

    if (theirPokemon.defending_gym_id) {
      throw new AppError(3002, '对方精灵正在道馆驻守，无法交易', 400);
    }

    // 检查交易限制
    const limitCheck = await checkTradeLimits(userId, friendId, myPokemon);
    if (!limitCheck.allowed) {
      throw new AppError(3011, limitCheck.reason, 400);
    }

    // 检查精灵频繁交易
    const frequentCheck = await checkPokemonFrequentTrade(myPokemonId);
    if (!frequentCheck.allowed) {
      throw new AppError(3012, frequentCheck.reason, 400);
    }

    // 验证距离（近距离交易）
    const distanceCheck = await validateTradeDistance(userId, friendId);
    let isRemote = false;
    let distance = null;

    if (!distanceCheck.valid) {
      // 如果距离验证失败或超出限制，检查是否支持远程交易
      if (friendship.level === 'BEST') {
        isRemote = true;
        logger.info({ userId, friendId }, '启用远程交易（BEST好友）');
      } else {
        throw new AppError(3013, 
          `距离超出限制（需要 BEST 好友才能远程交易）。${distanceCheck.error || `当前距离: ${distanceCheck.distance}m，最大: ${distanceCheck.maxDistance}m`}`, 
          400
        );
      }
    } else {
      distance = distanceCheck.distance;
    }

    // 计算星尘消耗
    const stardustCost = calculateStardustCost(myPokemon, theirPokemon, friendship.level, isRemote);

    // 检查用户星尘余额
    const { rows: [user] } = await query('SELECT stardust FROM users WHERE id = $1', [userId]);
    if (user.stardust < stardustCost) {
      throw new AppError(3010, `星尘不足（需要 ${stardustCost}，当前 ${user.stardust}）`, 400);
    }

    // 创建交易请求
    const { rows: [trade] } = await query(`
      INSERT INTO pokemon_trades (
        initiator_id, receiver_id, offered_pokemon, received_pokemon,
        stardust_cost, is_remote, distance_meters, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
      RETURNING *
    `, [userId, friendId, myPokemonId, theirPokemonId, stardustCost, isRemote, distance]);

    logger.info({
      tradeId: trade.id,
      initiator: userId,
      receiver: friendId,
      stardustCost,
      isRemote,
      distance
    }, '交易请求已创建');

    // 构建交易上下文
    const context = await fraudDetectionService.buildTradeContext(userId, friendId);

    // 欺诈检测分析
    const fraudAnalysis = await fraudDetectionService.analyze({
      tradeId: trade.id,
      initiatorId: userId,
      receiverId: friendId,
      initiatorOffer: [myPokemon],
      receiverOffer: [theirPokemon],
      context
    });

    logger.info({
      tradeId: trade.id,
      riskLevel: fraudAnalysis.riskLevel,
      overallScore: fraudAnalysis.overallScore
    }, '欺诈检测分析完成');

    // 根据风险等级处理
    if (fraudAnalysis.riskLevel === RiskLevel.CRITICAL) {
      // 阻止交易
      await query(`UPDATE pokemon_trades SET status = 'BLOCKED' WHERE id = $1`, [trade.id]);
      throw new AppError(3015, '交易风险过高，已被系统阻止', 403);
    }

    // 高风险交易需要额外确认
    let confirmationRequired = false;
    if (fraudAnalysis.riskLevel === RiskLevel.HIGH) {
      confirmationRequired = true;
    }

    // 评估交易公平性
    const fairness = await fraudDetectionService.quickEvaluateFairness(myPokemon, theirPokemon);

    // 记录审计日志
    await tradeAuditService.logTradeEvent({
      tradeId: trade.id,
      type: 'trade_requested',
      initiatorId: userId,
      receiverId: friendId,
      initiatorOffer: [myPokemon],
      receiverOffer: [theirPokemon],
      riskAnalysis: fraudAnalysis,
      traceId: req.headers['x-trace-id']
    });

    // 异步检测可疑交易（保留原有检测）
    detectSuspiciousTrade(trade, myPokemon, theirPokemon).catch(err => {
      logger.error({ err, tradeId: trade.id }, '可疑交易检测失败');
    });

    res.status(201).json(successResp({
      tradeId: trade.id,
      stardustCost,
      distance,
      isRemote,
      myPokemon: {
        id: myPokemon.id,
        name: myPokemon.name,
        cp: myPokemon.cp,
        rarity: myPokemon.rarity
      },
      theirPokemon: {
        id: theirPokemon.id,
        name: theirPokemon.name,
        cp: theirPokemon.cp,
        rarity: theirPokemon.rarity
      },
      fraudAnalysis: {
        riskLevel: fraudAnalysis.riskLevel,
        fairness: {
          yourValue: fairness.offerValue,
          theirValue: fairness.receiveValue,
          ratio: fairness.ratio,
          risk: fairness.risk
        },
        warnings: fraudAnalysis.scores.flatMap(s => s.indicators)
      },
      confirmationRequired,
      expiresIn: 300 // 5分钟有效期
    }, '交易请求已发送'));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /trades/:id/confirm
 * 确认交易
 */
router.post('/:id/confirm', requireAuth, async (req, res, next) => {
  try {
    const tradeId = req.params.id;
    const userId = req.user.sub;

    // 获取交易信息
    const { rows: [trade] } = await query(`
      SELECT * FROM pokemon_trades WHERE id = $1 AND receiver_id = $2 AND status = 'PENDING'
    `, [tradeId, userId]);

    if (!trade) {
      throw new AppError(2017, '交易请求不存在或已过期', 404);
    }

    // 检查交易是否过期（5分钟）
    const elapsed = Date.now() - new Date(trade.created_at).getTime();
    if (elapsed > 300000) {
      await query(`UPDATE pokemon_trades SET status = 'EXPIRED' WHERE id = $1`, [tradeId]);
      throw new AppError(3014, '交易请求已过期', 400);
    }

    // 如果不是远程交易，再次验证距离
    if (!trade.is_remote) {
      const distanceCheck = await validateTradeDistance(trade.initiator_id, userId);
      if (!distanceCheck.valid) {
        throw new AppError(3013, 
          `距离超出限制。${distanceCheck.error || `当前距离: ${distanceCheck.distance}m`}`, 
          400
        );
      }
    }

    // 获取精灵信息
    const { rows: [offeredPokemon] } = await query(`
      SELECT pi.*, ps.rarity FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = $1
    `, [trade.offered_pokemon]);

    const { rows: [receivedPokemon] } = await query(`
      SELECT pi.*, ps.rarity FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = $1
    `, [trade.received_pokemon]);

    if (!offeredPokemon || !receivedPokemon) {
      throw new AppError(3001, '精灵不存在', 404);
    }

    // 检查接收方星尘余额
    const { rows: [receiver] } = await query('SELECT stardust FROM users WHERE id = $1', [userId]);
    if (receiver.stardust < trade.stardust_cost) {
      throw new AppError(3010, `星尘不足（需要 ${trade.stardust_cost}，当前 ${receiver.stardust}）`, 400);
    }

    // 计算幸运交易概率 (REQ-00160: 5% 基础概率，好友互动天数加成)
    const { rows: [fs] } = await query(`
      SELECT interaction_days FROM friendships
      WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
    `, [trade.initiator_id, userId]);

    // 基础概率 5%，好友互动天数加成（最多 +20%）
    const interactionBonus = Math.min((fs?.interaction_days || 0) / 365 * 0.2, 0.2);
    const luckyRate = 0.05 + interactionBonus;
    const isLucky = Math.random() < luckyRate;
    
    logger.info({ 
      tradeId, 
      interactionDays: fs?.interaction_days || 0,
      luckyRate,
      isLucky 
    }, 'Lucky trade calculation');

    // 执行交易（事务）
    await transaction(async (client) => {
      // 转移精灵所有权
      await client.query('UPDATE pokemon_instances SET user_id = $1 WHERE id = $2', 
        [userId, trade.offered_pokemon]);
      await client.query('UPDATE pokemon_instances SET user_id = $1 WHERE id = $2', 
        [trade.initiator_id, trade.received_pokemon]);

      // 幸运精灵：提升IV
      if (isLucky) {
        await client.query(`
          UPDATE pokemon_instances SET
            iv_attack = GREATEST(iv_attack, 12),
            iv_defense = GREATEST(iv_defense, 12),
            iv_hp = GREATEST(iv_hp, 12),
            is_lucky = true
          WHERE id = $1 OR id = $2
        `, [trade.offered_pokemon, trade.received_pokemon]);
      }

      // 扣除双方星尘
      await client.query('UPDATE users SET stardust = stardust - $1 WHERE id = $2', 
        [trade.stardust_cost, trade.initiator_id]);
      await client.query('UPDATE users SET stardust = stardust - $1 WHERE id = $2', 
        [trade.stardust_cost, userId]);

      // 更新交易状态
      await client.query(`
        UPDATE pokemon_trades 
        SET status = 'COMPLETED', is_lucky = $1, traded_at = NOW()
        WHERE id = $2
      `, [isLucky, tradeId]);

      // 更新好友关系
      const [a, b] = trade.initiator_id < userId ? 
        [trade.initiator_id, userId] : [userId, trade.initiator_id];
      
      await client.query(`
        UPDATE friendships SET
          last_interaction_at = NOW(),
          interaction_days = interaction_days + 1
        WHERE user_a = $1 AND user_b = $2
      `, [a, b]);
    });

    logger.info({
      tradeId,
      initiator: trade.initiator_id,
      receiver: userId,
      isLucky
    }, '交易完成');

    res.json(successResp({
      isLucky,
      message: isLucky ? '幸运交易！精灵个体值提升！' : '交易完成',
      stardustCost: trade.stardust_cost
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /trades/:id/cancel
 * 取消交易
 */
router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const tradeId = req.params.id;
    const userId = req.user.sub;
    const { reason } = req.body;

    // 获取交易信息
    const { rows: [trade] } = await query(`
      SELECT * FROM pokemon_trades 
      WHERE id = $1 AND (initiator_id = $2 OR receiver_id = $2) AND status = 'PENDING'
    `, [tradeId, userId]);

    if (!trade) {
      throw new AppError(2017, '交易请求不存在或已处理', 404);
    }

    // 取消交易
    await query(`
      UPDATE pokemon_trades 
      SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = NOW(), cancel_reason = $2
      WHERE id = $3
    `, [userId, reason || '用户取消', tradeId]);

    logger.info({ tradeId, userId, reason }, '交易已取消');

    res.json(successResp(null, '交易已取消'));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /trades/history
 * 查询交易历史
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { limit = 50, offset = 0, status } = req.query;

    let statusFilter = '';
    const params = [userId, parseInt(limit), parseInt(offset)];

    if (status && ['PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED'].includes(status)) {
      statusFilter = 'AND pt.status = $4';
      params.push(status);
    }

    const { rows } = await query(`
      SELECT 
        pt.id,
        pt.initiator_id,
        pt.receiver_id,
        pt.stardust_cost,
        pt.is_remote,
        pt.is_lucky,
        pt.status,
        pt.distance_meters,
        pt.created_at,
        pt.traded_at,
        u1.username AS initiator_name,
        u2.username AS receiver_name,
        json_build_object(
          'id', up1.id,
          'species_id', up1.species_id,
          'cp', up1.cp,
          'name', ps1.name,
          'rarity', ps1.rarity
        ) AS offered_pokemon,
        json_build_object(
          'id', up2.id,
          'species_id', up2.species_id,
          'cp', up2.cp,
          'name', ps2.name,
          'rarity', ps2.rarity
        ) AS received_pokemon
      FROM pokemon_trades pt
      JOIN users u1 ON u1.id = pt.initiator_id
      JOIN users u2 ON u2.id = pt.receiver_id
      JOIN pokemon_instances up1 ON up1.id = pt.offered_pokemon
      JOIN pokemon_species ps1 ON ps1.id = up1.species_id
      LEFT JOIN pokemon_instances up2 ON up2.id = pt.received_pokemon
      LEFT JOIN pokemon_species ps2 ON ps2.id = up2.species_id
      WHERE (pt.initiator_id = $1 OR pt.receiver_id = $1)
        ${statusFilter}
      ORDER BY pt.created_at DESC
      LIMIT $2 OFFSET $3
    `, params);

    // 获取总数
    const { rows: [countResult] } = await query(`
      SELECT COUNT(*)::int AS total
      FROM pokemon_trades
      WHERE (initiator_id = $1 OR receiver_id = $1)
        ${status ? `AND status = '${status}'` : ''}
    `, [userId]);

    res.json(successResp({
      trades: rows,
      total: countResult.total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /trades/:id
 * 查询交易详情
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const tradeId = req.params.id;
    const userId = req.user.sub;

    const { rows: [trade] } = await query(`
      SELECT 
        pt.*,
        u1.username AS initiator_name,
        u2.username AS receiver_name,
        json_build_object(
          'id', up1.id,
          'species_id', up1.species_id,
          'cp', up1.cp,
          'level', up1.level,
          'name', ps1.name,
          'rarity', ps1.rarity,
          'is_shiny', up1.is_shiny,
          'is_lucky', up1.is_lucky
        ) AS offered_pokemon,
        json_build_object(
          'id', up2.id,
          'species_id', up2.species_id,
          'cp', up2.cp,
          'level', up2.level,
          'name', ps2.name,
          'rarity', ps2.rarity,
          'is_shiny', up2.is_shiny,
          'is_lucky', up2.is_lucky
        ) AS received_pokemon
      FROM pokemon_trades pt
      JOIN users u1 ON u1.id = pt.initiator_id
      JOIN users u2 ON u2.id = pt.receiver_id
      JOIN pokemon_instances up1 ON up1.id = pt.offered_pokemon
      JOIN pokemon_species ps1 ON ps1.id = up1.species_id
      LEFT JOIN pokemon_instances up2 ON up2.id = pt.received_pokemon
      LEFT JOIN pokemon_species ps2 ON ps2.id = up2.species_id
      WHERE pt.id = $1 AND (pt.initiator_id = $2 OR pt.receiver_id = $2)
    `, [tradeId, userId]);

    if (!trade) {
      throw new AppError(2017, '交易不存在', 404);
    }

    res.json(successResp(trade));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /trades/:id/rollback
 * 回滚交易（24小时内）
 */
router.post('/:id/rollback', requireAuth, async (req, res, next) => {
  try {
    const tradeId = req.params.id;
    const userId = req.user.sub;
    const { reason } = req.body;

    // 验证权限（管理员或交易参与者）
    const { rows: [trade] } = await query(`
      SELECT * FROM pokemon_trades WHERE id = $1
    `, [tradeId]);

    if (!trade) {
      throw new AppError(2017, '交易不存在', 404);
    }

    // 检查是否为交易参与者或管理员
    const isParticipant = trade.initiator_id === userId || trade.receiver_id === userId;
    const isAdmin = req.user.role === 'admin';

    if (!isParticipant && !isAdmin) {
      throw new AppError(1003, '无权回滚此交易', 403);
    }

    // 检查是否可以回滚
    const rollbackCheck = await tradeRollbackService.canRollback(tradeId);
    if (!rollbackCheck.canRollback) {
      throw new AppError(3016, rollbackCheck.reason, 400);
    }

    // 执行回滚
    const result = await tradeRollbackService.rollback(tradeId, reason || '用户请求回滚');

    // 通知双方
    await tradeRollbackService.notifyRollback(
      trade.initiator_id,
      trade.receiver_id,
      reason || '用户请求回滚'
    );

    logger.info({
      tradeId,
      userId,
      reason
    }, '交易已回滚');

    res.json(successResp(result, '交易已回滚'));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /trades/analytics/report
 * 生成异常交易报表（管理员）
 */
router.get('/analytics/report', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    // 验证管理员权限
    if (req.user.role !== 'admin') {
      throw new AppError(1003, '需要管理员权限', 403);
    }

    const { start, end } = req.query;

    if (!start || !end) {
      throw new AppError(1001, '缺少时间范围参数', 400);
    }

    const report = await tradeAuditService.generateAnomalyReport({
      start: new Date(start),
      end: new Date(end)
    });

    res.json(successResp(report));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /trades/fraud/rings
 * 检测欺诈团伙（管理员）
 */
router.get('/fraud/rings', requireAuth, async (req, res, next) => {
  try {
    // 验证管理员权限
    if (req.user.role !== 'admin') {
      throw new AppError(1003, '需要管理员权限', 403);
    }

    const { FraudRingDetector } = require('../../../../shared/tradeConfirmation');
    const detector = new FraudRingDetector();

    const report = await detector.analyzeTradeNetwork();

    res.json(successResp(report));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
