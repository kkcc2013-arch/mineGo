// backend/services/social-service/src/routes/team.js
// REQ-00558: 团队管理 API 路由

'use strict';

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const authMiddleware = require('../../../../shared/middleware/auth');
const { getTeamService } = require('../teamService');
const { getVoiceRoomManager } = require('../voice/roomManager');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('team-routes');

/**
 * 创建团队
 * POST /api/team
 */
router.post('/',
  authMiddleware,
  [
    body('name').isString().trim().isLength({ min: 1, max: 100 }),
    body('teamType').optional().isIn(['casual', 'raid', 'gym', 'friend']),
    body('maxMembers').optional().isInt({ min: 2, max: 20 }),
    body('settings').optional().isObject()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { name, teamType, maxMembers, settings } = req.body;
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      const team = await teamService.createTeam(userId, {
        name,
        teamType,
        maxMembers,
        settings
      });

      // 创建对应的语音房间
      try {
        const roomManager = getVoiceRoomManager();
        await roomManager.createRoom({
          name: `${team.name} 语音频道`,
          creatorId: userId,
          roomType: 'battle',
          maxMembers: team.maxMembers,
          teamId: team.teamId
        });
      } catch (voiceError) {
        logger.warn('Failed to create voice room for team', {
          teamId: team.teamId,
          error: voiceError.message
        });
      }

      res.json({
        success: true,
        data: team
      });

    } catch (error) {
      logger.error('Failed to create team', { error: error.message, userId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 获取团队详情
 * GET /api/team/:teamId
 */
router.get('/:teamId',
  authMiddleware,
  [param('teamId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;

    try {
      const teamService = getTeamService();
      const team = await teamService.getTeamById(teamId);

      if (!team) {
        return res.status(404).json({
          success: false,
          error: 'TEAM_NOT_FOUND'
        });
      }

      // 获取团队位置
      const locations = await teamService.getTeamLocations(teamId);

      // 获取团队状态
      const statuses = await teamService.getTeamStatuses(teamId);

      res.json({
        success: true,
        data: {
          ...team,
          locations,
          statuses
        }
      });

    } catch (error) {
      logger.error('Failed to get team', { error: error.message, teamId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 获取我的团队列表
 * GET /api/team/my-teams
 */
router.get('/my-teams',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      const teams = await teamService.getUserTeams(userId);

      res.json({
        success: true,
        data: teams
      });

    } catch (error) {
      logger.error('Failed to get user teams', { error: error.message, userId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 加入团队
 * POST /api/team/:teamId/join
 */
router.post('/:teamId/join',
  authMiddleware,
  [param('teamId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      const team = await teamService.joinTeam(teamId, userId);

      res.json({
        success: true,
        data: team
      });

    } catch (error) {
      logger.error('Failed to join team', { error: error.message, teamId, userId });
      
      const statusCode = error.message === 'TEAM_NOT_FOUND' ? 404 :
                         error.message === 'TEAM_FULL' ? 400 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 退出团队
 * POST /api/team/:teamId/leave
 */
router.post('/:teamId/leave',
  authMiddleware,
  [param('teamId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      await teamService.leaveTeam(teamId, userId);

      res.json({
        success: true
      });

    } catch (error) {
      logger.error('Failed to leave team', { error: error.message, teamId, userId });
      
      const statusCode = error.message === 'TEAM_NOT_FOUND' ? 404 :
                         error.message === 'LEADER_MUST_TRANSFER_OR_DISBAND' ? 400 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 邀请成员
 * POST /api/team/:teamId/invite
 */
router.post('/:teamId/invite',
  authMiddleware,
  [
    param('teamId').isUUID(),
    body('inviteeId').isString().notEmpty(),
    body('message').optional().isString().isLength({ max: 500 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;
    const { inviteeId, message } = req.body;
    const inviterId = req.user.id;

    try {
      const teamService = getTeamService();
      const result = await teamService.inviteMember(teamId, inviterId, inviteeId, message);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Failed to invite member', { error: error.message, teamId, inviterId, inviteeId });
      
      const statusCode = error.message === 'NOT_A_MEMBER' ? 403 :
                         error.message === 'TEAM_FULL' ? 400 :
                         error.message === 'INVITATION_ALREADY_EXISTS' ? 409 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 响应邀请
 * POST /api/team/invitation/:invitationId/respond
 */
router.post('/invitation/:invitationId/respond',
  authMiddleware,
  [
    param('invitationId').isInt(),
    body('accept').isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { invitationId } = req.params;
    const { accept } = req.body;
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      const result = await teamService.respondToInvitation(invitationId, userId, accept);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Failed to respond to invitation', { error: error.message, invitationId, userId });
      
      const statusCode = error.message === 'INVITATION_NOT_FOUND' ? 404 :
                         error.message === 'INVITATION_EXPIRED' ? 400 :
                         error.message === 'INVITATION_ALREADY_RESPONDED' ? 409 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 移除成员（队长权限）
 * POST /api/team/:teamId/kick/:userId
 */
router.post('/:teamId/kick/:userId',
  authMiddleware,
  [param('teamId').isUUID(), param('userId').isString().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId, userId } = req.params;
    const leaderId = req.user.id;

    try {
      const teamService = getTeamService();
      await teamService.kickMember(teamId, leaderId, userId);

      res.json({
        success: true
      });

    } catch (error) {
      logger.error('Failed to kick member', { error: error.message, teamId, leaderId, userId });
      
      const statusCode = error.message === 'NOT_LEADER' ? 403 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 转让队长
 * POST /api/team/:teamId/transfer/:newLeaderId
 */
router.post('/:teamId/transfer/:newLeaderId',
  authMiddleware,
  [param('teamId').isUUID(), param('newLeaderId').isString().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId, newLeaderId } = req.params;
    const currentLeaderId = req.user.id;

    try {
      const teamService = getTeamService();
      const team = await teamService.transferLeadership(teamId, currentLeaderId, newLeaderId);

      res.json({
        success: true,
        data: team
      });

    } catch (error) {
      logger.error('Failed to transfer leadership', { error: error.message, teamId, currentLeaderId, newLeaderId });
      
      const statusCode = error.message === 'NOT_LEADER' ? 403 :
                         error.message === 'NEW_LEADER_NOT_MEMBER' ? 400 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 解散团队
 * DELETE /api/team/:teamId
 */
router.delete('/:teamId',
  authMiddleware,
  [param('teamId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      await teamService.disbandTeam(teamId, userId);

      res.json({
        success: true
      });

    } catch (error) {
      logger.error('Failed to disband team', { error: error.message, teamId, userId });
      
      const statusCode = error.message === 'NOT_LEADER' ? 403 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 更新位置（实时共享）
 * POST /api/team/:teamId/location
 */
router.post('/:teamId/location',
  authMiddleware,
  [
    param('teamId').isUUID(),
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;
    const { lat, lng } = req.body;
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      await teamService.updateMemberLocation(teamId, userId, { lat, lng });

      res.json({
        success: true
      });

    } catch (error) {
      logger.error('Failed to update location', { error: error.message, teamId, userId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 获取团队成员位置
 * GET /api/team/:teamId/locations
 */
router.get('/:teamId/locations',
  authMiddleware,
  [param('teamId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;

    try {
      const teamService = getTeamService();
      const locations = await teamService.getTeamLocations(teamId);

      res.json({
        success: true,
        data: locations
      });

    } catch (error) {
      logger.error('Failed to get team locations', { error: error.message, teamId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 更新成员状态
 * POST /api/team/:teamId/status
 */
router.post('/:teamId/status',
  authMiddleware,
  [
    param('teamId').isUUID(),
    body('status').isIn(['ready', 'in_battle', 'offline', 'away'])
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;
    const { status } = req.body;
    const userId = req.user.id;

    try {
      const teamService = getTeamService();
      await teamService.updateMemberStatus(teamId, userId, status);

      res.json({
        success: true
      });

    } catch (error) {
      logger.error('Failed to update status', { error: error.message, teamId, userId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 获取团队战绩统计
 * GET /api/team/:teamId/stats
 */
router.get('/:teamId/stats',
  authMiddleware,
  [param('teamId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;

    try {
      const teamService = getTeamService();
      const stats = await teamService.getTeamStats(teamId);

      res.json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Failed to get team stats', { error: error.message, teamId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 记录团队战斗结果
 * POST /api/team/:teamId/battle-record
 */
router.post('/:teamId/battle-record',
  authMiddleware,
  [
    param('teamId').isUUID(),
    body('battleType').isIn(['raid', 'gym', 'pvp']),
    body('result').isIn(['win', 'loss', 'draw']),
    body('durationSeconds').optional().isInt({ min: 0 }),
    body('members').isArray(),
    body('totalContribution').optional().isInt({ min: 0 }),
    body('rewards').optional().isObject()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { teamId } = req.params;
    const battleData = req.body;

    try {
      const teamService = getTeamService();
      const result = await teamService.recordBattleResult(teamId, battleData);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Failed to record battle result', { error: error.message, teamId });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

module.exports = router;