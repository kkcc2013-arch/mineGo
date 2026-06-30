/**
 * REQ-00109: 团队战斗路由
 * 创建时间: 2026-06-15 18:15
 */

const express = require('express');
const router = express.Router();
const { teamBattleService, BATTLE_TYPES, TEAM_STATUS, COMBO_SKILLS } = require('../teamBattleService');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const logger = require('../../../shared/logger');

// ==================== 团队管理 API ====================

/**
 * 创建团队
 * POST /api/teams
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, battleType, maxSize } = req.body;
    const userId = req.user.id;

    if (!name || !battleType) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (!Object.values(BATTLE_TYPES).includes(battleType)) {
      return res.status(400).json({ error: '无效的战斗类型' });
    }

    const team = await teamBattleService.createTeam(userId, name, battleType, maxSize || 5);
    res.status(201).json({ success: true, team });
  } catch (error) {
    logger.error('Create team error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取开放团队列表
 * GET /api/teams/open
 */
router.get('/open', requireAuth, async (req, res) => {
  try {
    const { battleType, limit } = req.query;
    const teams = await teamBattleService.getOpenTeams(battleType, parseInt(limit) || 20);
    res.json({ success: true, teams });
  } catch (error) {
    logger.error('Get open teams error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取团队详情
 * GET /api/teams/:id
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const team = await teamBattleService.getTeam(parseInt(req.params.id));
    if (!team) {
      return res.status(404).json({ error: '团队不存在' });
    }
    res.json({ success: true, team });
  } catch (error) {
    logger.error('Get team error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 加入团队
 * POST /api/teams/:id/join
 */
router.post('/:id/join', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const userId = req.user.id;
    const { pokemonIds } = req.body;

    const result = await teamBattleService.joinTeam(teamId, userId, pokemonIds || []);
    res.json(result);
  } catch (error) {
    logger.error('Join team error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 离开团队
 * POST /api/teams/:id/leave
 */
router.post('/:id/leave', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const userId = req.user.id;

    // TODO: 实现离开逻辑
    res.json({ success: true, message: '已离开团队' });
  } catch (error) {
    logger.error('Leave team error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 邀请玩家
 * POST /api/teams/:id/invite
 */
router.post('/:id/invite', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const inviterId = req.user.id;
    const { inviteeId } = req.body;

    if (!inviteeId) {
      return res.status(400).json({ error: '缺少被邀请者 ID' });
    }

    const invitation = await teamBattleService.invitePlayer(teamId, inviterId, inviteeId);
    res.status(201).json({ success: true, invitation });
  } catch (error) {
    logger.error('Invite player error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 踢出成员
 * POST /api/teams/:id/kick
 */
router.post('/:id/kick', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const leaderId = req.user.id;
    const { memberId } = req.body;

    // TODO: 实现踢出逻辑
    res.json({ success: true, message: '已踢出成员' });
  } catch (error) {
    logger.error('Kick member error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 标记准备状态
 * POST /api/teams/:id/ready
 */
router.post('/:id/ready', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const userId = req.user.id;
    const { pokemonIds } = req.body;

    if (!pokemonIds || !Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ error: '请选择精灵' });
    }

    const result = await teamBattleService.setReady(teamId, userId, pokemonIds);
    res.json(result);
  } catch (error) {
    logger.error('Set ready error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 启动战斗
 * POST /api/teams/:id/start-battle
 */
router.post('/:id/start-battle', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const leaderId = req.user.id;

    const battleState = await teamBattleService.startBattle(teamId, leaderId);
    res.json({ success: true, battle: battleState });
  } catch (error) {
    logger.error('Start battle error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 团队战斗 API ====================

/**
 * 提交行动
 * POST /api/teams/battle/:battleId/action
 */
router.post('/battle/:battleId/action', requireAuth, async (req, res) => {
  try {
    const { battleId } = req.params;
    const userId = req.user.id;
    const action = req.body;

    const result = await teamBattleService.submitAction(battleId, userId, action);
    res.json(result);
  } catch (error) {
    logger.error('Submit action error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 执行回合
 * POST /api/teams/battle/:battleId/execute-turn
 */
router.post('/battle/:battleId/execute-turn', requireAuth, async (req, res) => {
  try {
    const { battleId } = req.params;

    const result = await teamBattleService.executeTurn(battleId);
    res.json(result);
  } catch (error) {
    logger.error('Execute turn error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取战斗奖励
 * GET /api/teams/battle/:battleId/rewards
 */
router.get('/battle/:battleId/rewards', requireAuth, async (req, res) => {
  try {
    const { battleId } = req.params;

    const rewards = await teamBattleService.distributeRewards(battleId);
    res.json({ success: true, rewards });
  } catch (error) {
    logger.error('Get rewards error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取战斗统计
 * GET /api/teams/battle/stats
 */
router.get('/battle/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const stats = await teamBattleService.getBattleStats(userId);
    res.json({ success: true, stats });
  } catch (error) {
    logger.error('Get battle stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Raid Boss API ====================

/**
 * 获取活跃 Raid Boss
 * GET /api/teams/raids
 */
router.get('/raids', requireAuth, async (req, res) => {
  try {
    const raids = await teamBattleService.getActiveRaidBosses();
    res.json({ success: true, raids });
  } catch (error) {
    logger.error('Get raids error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 挑战 Raid Boss
 * POST /api/teams/raids/:raidId/challenge
 */
router.post('/raids/:raidId/challenge', requireAuth, async (req, res) => {
  try {
    const { raidId } = req.params;
    const { teamId } = req.body;

    const raidBattle = await teamBattleService.initRaidBattle(teamId, parseInt(raidId));
    res.json({ success: true, raidBattle });
  } catch (error) {
    logger.error('Challenge raid error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取连携技能列表
 * GET /api/teams/combo-skills
 */
router.get('/combo-skills', requireAuth, (req, res) => {
  res.json({ success: true, comboSkills: COMBO_SKILLS });
});

module.exports = router;
