/**
 * 公会 API 路由 - REQ-00058
 */

const express = require('express');
const router = express.Router();
const guildService = require('../src/guildService');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('guild-routes');

/**
 * GET /api/guild/search
 * 搜索公会
 */
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const { name, minLevel, joinType, limit = 20 } = req.query;
    
    const guilds = await guildService.searchGuilds({
      name,
      minLevel: minLevel ? parseInt(minLevel) : null,
      joinType,
      limit: parseInt(limit)
    });
    
    res.json(successResp(guilds));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/guild/leaderboard
 * 获取公会排行榜
 */
router.get('/leaderboard', requireAuth, async (req, res, next) => {
  try {
    const { type = 'global', limit = 100 } = req.query;
    
    const leaderboard = await guildService.getGuildLeaderboard(type, parseInt(limit));
    
    res.json(successResp(leaderboard));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/guild/my
 * 获取当前用户的公会信息
 */
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    
    const member = await guildService.getMemberByUserId(userId);
    
    if (!member) {
      return res.json(successResp(null));
    }
    
    const guild = await guildService.getGuild(member.guild_id);
    const memberCount = await guildService.getMemberCount(member.guild_id);
    const activeBuffs = await guildService.getActiveBuffs(member.guild_id);
    
    res.json(successResp({
      guild,
      member,
      memberCount,
      activeBuffs
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/guild/create
 * 创建公会
 */
router.post('/create', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { name, description, badgeUrl, joinType, minLevel, minPokedexCount } = req.body;
    
    const guild = await guildService.createGuild(userId, {
      name,
      description,
      badgeUrl,
      joinType,
      minLevel,
      minPokedexCount
    });
    
    res.status(201).json(successResp(guild));
  } catch (err) {
    logger.error({ err }, '创建公会失败');
    next(err);
  }
});

/**
 * POST /api/guild/join
 * 加入公会
 */
router.post('/join', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { guildId, guildKey, applicationText } = req.body;
    
    const result = await guildService.joinGuild(
      userId, 
      guildId || guildKey, 
      applicationText
    );
    
    res.json(successResp(result));
  } catch (err) {
    logger.error({ err }, '加入公会失败');
    next(err);
  }
});

/**
 * POST /api/guild/leave
 * 离开公会
 */
router.post('/leave', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    
    const result = await guildService.leaveGuild(userId);
    
    res.json(successResp(result));
  } catch (err) {
    logger.error({ err }, '离开公会失败');
    next(err);
  }
});

/**
 * GET /api/guild/:guildId
 * 获取公会详情
 */
router.get('/:guildId', requireAuth, async (req, res, next) => {
  try {
    const { guildId } = req.params;
    
    const guild = await guildService.getGuild(guildId);
    
    if (!guild) {
      throw new AppError(404, '公会不存在', 404);
    }
    
    const memberCount = await guildService.getMemberCount(guildId);
    const tasks = await guildService.getGuildTasks(guildId);
    
    res.json(successResp({
      ...guild,
      memberCount,
      tasks
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/guild/:guildId/members
 * 获取公会成员列表
 */
router.get('/:guildId/members', requireAuth, async (req, res, next) => {
  try {
    const { guildId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    const members = await guildService.getGuildMembers(
      guildId, 
      parseInt(limit), 
      parseInt(offset)
    );
    
    res.json(successResp(members));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/guild/:guildId/transfer
 * 转让会长
 */
router.post('/:guildId/transfer', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { guildId } = req.params;
    const { newLeaderId } = req.body;
    
    if (!newLeaderId) {
      throw new AppError(400, 'newLeaderId 必填', 400);
    }
    
    const result = await guildService.transferLeadership(
      parseInt(guildId),
      userId,
      newLeaderId
    );
    
    res.json(successResp(result));
  } catch (err) {
    logger.error({ err }, '转让会长失败');
    next(err);
  }
});

/**
 * POST /api/guild/:guildId/set-role
 * 设置成员职位
 */
router.post('/:guildId/set-role', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { guildId } = req.params;
    const { memberId, role } = req.body;
    
    if (!memberId || !role) {
      throw new AppError(400, 'memberId 和 role 必填', 400);
    }
    
    const result = await guildService.setMemberRole(
      parseInt(guildId),
      userId,
      memberId,
      role
    );
    
    res.json(successResp(result));
  } catch (err) {
    logger.error({ err }, '设置成员职位失败');
    next(err);
  }
});

/**
 * POST /api/guild/:guildId/donate
 * 捐赠公会资金
 */
router.post('/:guildId/donate', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { guildId } = req.params;
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      throw new AppError(400, 'amount 必须大于 0', 400);
    }
    
    const result = await guildService.donateToGuild(userId, parseInt(amount));
    
    res.json(successResp(result));
  } catch (err) {
    logger.error({ err }, '捐赠失败');
    next(err);
  }
});

/**
 * POST /api/guild/:guildId/activate-buff
 * 激活公会增益
 */
router.post('/:guildId/activate-buff', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { guildId } = req.params;
    const { buffType } = req.body;
    
    if (!buffType) {
      throw new AppError(400, 'buffType 必填', 400);
    }
    
    const result = await guildService.activateBuff(
      parseInt(guildId),
      userId,
      buffType
    );
    
    res.json(successResp(result));
  } catch (err) {
    logger.error({ err }, '激活增益失败');
    next(err);
  }
});

/**
 * GET /api/guild/:guildId/buffs
 * 获取公会活跃增益
 */
router.get('/:guildId/buffs', requireAuth, async (req, res, next) => {
  try {
    const { guildId } = req.params;
    
    const buffs = await guildService.getActiveBuffs(parseInt(guildId));
    
    res.json(successResp(buffs));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/guild/:guildId/chat
 * 发送公会聊天消息
 */
router.post('/:guildId/chat', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { guildId } = req.params;
    const { content } = req.body;
    
    if (!content) {
      throw new AppError(400, 'content 必填', 400);
    }
    
    const message = await guildService.sendChatMessage(
      parseInt(guildId),
      userId,
      content
    );
    
    res.status(201).json(successResp(message));
  } catch (err) {
    logger.error({ err }, '发送消息失败');
    next(err);
  }
});

/**
 * GET /api/guild/:guildId/chat
 * 获取公会聊天历史
 */
router.get('/:guildId/chat', requireAuth, async (req, res, next) => {
  try {
    const { guildId } = req.params;
    const { limit = 100, beforeId } = req.query;
    
    const messages = await guildService.getChatHistory(
      parseInt(guildId),
      parseInt(limit),
      beforeId ? parseInt(beforeId) : null
    );
    
    res.json(successResp(messages));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/guild/application/review
 * 审批公会申请
 */
router.post('/application/review', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { applicationId, approved, note } = req.body;
    
    if (!applicationId) {
      throw new AppError(400, 'applicationId 必填', 400);
    }
    
    const result = await guildService.reviewApplication(
      applicationId,
      userId,
      approved,
      note
    );
    
    res.json(successResp(result));
  } catch (err) {
    logger.error({ err }, '审批申请失败');
    next(err);
  }
});

module.exports = router;
