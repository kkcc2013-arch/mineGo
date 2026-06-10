/**
 * REQ-00073: PVP 玩家对战系统 - API 路由
 * 创建时间: 2026-06-10 01:50
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../../shared/db');
const { requireAuth, AppError, successResp } = require('../../shared/auth');
const { logger } = require('../../shared/logger');
const pvpMatching = require('../../shared/pvpMatching');
const { PVPBattleManager } = require('../../shared/pvpBattleRoom');

/**
 * @route   POST /api/pvp/match/join
 * @desc    加入匹配队列
 * @access  Private
 */
router.post('/match/join', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { battleType = 'ranked' } = req.body;
    
    // 获取用户 ELO
    const userRanking = await pvpMatching.getUserRanking(userId);
    
    // 获取用户 PVP 队伍
    const { rows: [team] } = await query(`
      SELECT id, pokemon_ids, name
      FROM pvp_teams
      WHERE user_id = $1 AND is_active = true
    `, [userId]);
    
    if (!team) {
      throw new AppError(7001, '请先设置 PVP 队伍', 400);
    }
    
    // 验证队伍中的精灵
    const { rows: pokemon } = await query(`
      SELECT 
        pi.id, pi.species_id, pi.nickname, pi.cp, pi.hp_current, pi.hp_max,
        pi.iv_attack, pi.iv_defense, pi.iv_hp,
        pi.fast_move, pi.charge_move,
        ps.name_zh, ps.name_en, ps.type1, ps.type2, ps.base_attack, ps.base_defense, ps.base_hp
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = ANY($1) AND pi.user_id = $2
    `, [team.pokemon_ids, userId]);
    
    if (pokemon.length !== 3) {
      throw new AppError(7002, 'PVP 队伍需要 3 只精灵', 400);
    }
    
    // 检查是否已在队列中
    const { rows: [existing] } = await query(`
      SELECT id FROM pvp_match_queue WHERE user_id = $1
    `, [userId]);
    
    if (existing) {
      return res.json(successResp({
        message: '已在匹配队列中',
        position: await pvpMatching.getQueuePosition(userId)
      }));
    }
    
    // 加入队列
    await pvpMatching.joinQueue(userId, userRanking.elo_rating, { battleType, teamId: team.id });
    
    // 尝试匹配
    const match = await pvpMatching.findMatch(userId, userRanking.elo_rating);
    
    if (match) {
      res.json(successResp({
        matched: true,
        battleId: uuidv4(),
        opponent: {
          id: match.opponentId,
          rating: match.opponentRating,
          ratingDiff: match.ratingDiff
        }
      }));
    } else {
      res.json(successResp({
        matched: false,
        message: '已加入匹配队列，等待对手...',
        rating: userRanking.elo_rating
      }));
    }
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/pvp/match/leave
 * @desc    离开匹配队列
 * @access  Private
 */
router.delete('/match/leave', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const removed = await pvpMatching.leaveQueue(userId);
    
    res.json(successResp({
      removed,
      message: removed ? '已离开匹配队列' : '不在匹配队列中'
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/pvp/battle/start
 * @desc    开始好友对战
 * @access  Private
 */
router.post('/battle/start', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { friendId, battleType = 'friendly' } = req.body;
    
    if (!friendId) {
      throw new AppError(7003, '请指定对战好友', 400);
    }
    
    // 验证好友关系
    const { rows: [friendship] } = await query(`
      SELECT id FROM friendships
      WHERE (user_id = $1 AND friend_id = $2)
         OR (user_id = $2 AND friend_id = $1)
    `, [userId, friendId]);
    
    if (!friendship) {
      throw new AppError(7004, '只能与好友进行对战', 400);
    }
    
    // 获取双方队伍
    const { rows: teams } = await query(`
      SELECT user_id, pokemon_ids
      FROM pvp_teams
      WHERE user_id IN ($1, $2) AND is_active = true
    `, [userId, friendId]);
    
    if (teams.length !== 2) {
      throw new AppError(7005, '双方都需要设置 PVP 队伍', 400);
    }
    
    // 获取双方精灵详情
    const player1Team = teams.find(t => t.user_id === userId);
    const player2Team = teams.find(t => t.user_id === friendId);
    
    const { rows: pokemon1 } = await query(`
      SELECT pi.*, ps.name_zh, ps.name_en, ps.type1, ps.type2
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = ANY($1)
    `, [player1Team.pokemon_ids]);
    
    const { rows: pokemon2 } = await query(`
      SELECT pi.*, ps.name_zh, ps.name_en, ps.type1, ps.type2
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = ANY($1)
    `, [player2Team.pokemon_ids]);
    
    // 获取双方 ELO
    const ranking1 = await pvpMatching.getUserRanking(userId);
    const ranking2 = await pvpMatching.getUserRanking(friendId);
    
    // 创建战斗
    const battleRoom = PVPBattleManager.createBattle(
      { id: userId, team: pokemon1, eloRating: ranking1.elo_rating },
      { id: friendId, team: pokemon2, eloRating: ranking2.elo_rating },
      battleType
    );
    
    res.json(successResp({
      battleId: battleRoom.battleId,
      battleType,
      opponent: {
        id: friendId,
        rating: ranking2.elo_rating
      },
      message: '战斗已创建，等待双方准备'
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/pvp/battle/:battleId/action
 * @desc    提交回合行动
 * @access  Private
 */
router.post('/battle/:battleId/action', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { battleId } = req.params;
    const { type, moveId, pokemonIndex } = req.body;
    
    const battle = PVPBattleManager.getBattle(battleId);
    if (!battle) {
      throw new AppError(7006, '战斗不存在', 404);
    }
    
    const action = { type, moveId, pokemonIndex };
    const success = battle.submitTurnAction(userId, action);
    
    res.json(successResp({
      success,
      message: success ? '行动已提交' : '行动失败'
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/pvp/battle/:battleId/ready
 * @desc    标记准备就绪
 * @access  Private
 */
router.post('/battle/:battleId/ready', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { battleId } = req.params;
    
    const battle = PVPBattleManager.getBattle(battleId);
    if (!battle) {
      throw new AppError(7006, '战斗不存在', 404);
    }
    
    const success = battle.setPlayerReady(userId);
    
    res.json(successResp({
      success,
      status: battle.status,
      message: battle.status === 'in_progress' ? '战斗开始！' : '等待对手准备'
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/pvp/battle/:battleId/surrender
 * @desc    认输
 * @access  Private
 */
router.post('/battle/:battleId/surrender', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { battleId } = req.params;
    
    const battle = PVPBattleManager.getBattle(battleId);
    if (!battle) {
      throw new AppError(7006, '战斗不存在', 404);
    }
    
    battle.surrender(userId);
    
    res.json(successResp({
      message: '已认输'
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/pvp/ranking
 * @desc    获取用户排位信息
 * @access  Private
 */
router.get('/ranking', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const ranking = await pvpMatching.getUserRanking(userId);
    
    res.json(successResp(ranking));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/pvp/leaderboard
 * @desc    获取排行榜
 * @access  Public
 */
router.get('/leaderboard', async (req, res, next) => {
  try {
    const { tier, limit = 100, offset = 0 } = req.query;
    const leaderboard = await pvpMatching.getLeaderboard(tier, parseInt(limit), parseInt(offset));
    
    res.json(successResp(leaderboard));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/pvp/history
 * @desc    获取对战历史
 * @access  Private
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { limit = 20, offset = 0 } = req.query;
    
    const { rows } = await query(`
      SELECT 
        pb.id, pb.battle_type, pb.status, pb.winner_id, pb.turns,
        pb.created_at, pb.ended_at,
        CASE 
          WHEN pb.attacker_id = $1 THEN pb.defender_id
          ELSE pb.attacker_id
        END as opponent_id,
        CASE 
          WHEN pb.attacker_id = $1 THEN u2.username
          ELSE u1.username
        END as opponent_name,
        CASE 
          WHEN pb.winner_id = $1 THEN 'win'
          WHEN pb.winner_id IS NULL THEN 'draw'
          ELSE 'lose'
        END as result,
        pb.elo_change->>'winnerChange' as elo_change
      FROM pvp_battles pb
      LEFT JOIN users u1 ON u1.id = pb.attacker_id
      LEFT JOIN users u2 ON u2.id = pb.defender_id
      WHERE pb.attacker_id = $1 OR pb.defender_id = $1
      ORDER BY pb.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, parseInt(limit), parseInt(offset)]);
    
    res.json(successResp(rows));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/pvp/replay/:battleId
 * @desc    获取战斗回放
 * @access  Public
 */
router.get('/replay/:battleId', async (req, res, next) => {
  try {
    const { battleId } = req.params;
    
    const { rows: [replay] } = await query(`
      SELECT 
        pr.replay_data,
        pr.views,
        pb.battle_type,
        pb.winner_id,
        pb.turns,
        pb.created_at,
        u1.username as attacker_name,
        u2.username as defender_name
      FROM pvp_replays pr
      JOIN pvp_battles pb ON pb.id = pr.battle_id
      JOIN users u1 ON u1.id = pb.attacker_id
      JOIN users u2 ON u2.id = pb.defender_id
      WHERE pr.battle_id = $1
    `, [battleId]);
    
    if (!replay) {
      throw new AppError(7007, '回放不存在', 404);
    }
    
    // 增加观看次数
    await query(`
      UPDATE pvp_replays SET views = views + 1 WHERE battle_id = $1
    `, [battleId]);
    
    res.json(successResp(replay));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/pvp/team
 * @desc    保存 PVP 队伍
 * @access  Private
 */
router.post('/team', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { name, pokemonIds } = req.body;
    
    if (!pokemonIds || pokemonIds.length !== 3) {
      throw new AppError(7008, 'PVP 队伍需要 3 只精灵', 400);
    }
    
    // 验证精灵归属
    const { rows: pokemon } = await query(`
      SELECT id, cp FROM pokemon_instances
      WHERE id = ANY($1) AND user_id = $2
    `, [pokemonIds, userId]);
    
    if (pokemon.length !== 3) {
      throw new AppError(7009, '精灵不存在或不属于你', 400);
    }
    
    // 计算 CP 总和
    const totalCp = pokemon.reduce((sum, p) => sum + p.cp, 0);
    
    // 停用其他队伍
    await query(`
      UPDATE pvp_teams SET is_active = false WHERE user_id = $1
    `, [userId]);
    
    // 保存新队伍
    const { rows: [team] } = await query(`
      INSERT INTO pvp_teams (user_id, name, pokemon_ids, total_cp)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        name = $2, 
        pokemon_ids = $3, 
        total_cp = $4, 
        is_active = true,
        updated_at = NOW()
      RETURNING *
    `, [userId, name || 'PVP Team', pokemonIds, totalCp]);
    
    res.json(successResp(team));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/pvp/team
 * @desc    获取 PVP 队伍
 * @access  Private
 */
router.get('/team', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    
    const { rows: teams } = await query(`
      SELECT 
        pt.*,
        array_agg(
          json_build_object(
            'id', pi.id,
            'species_id', pi.species_id,
            'nickname', pi.nickname,
            'cp', pi.cp,
            'name_zh', ps.name_zh,
            'type1', ps.type1,
            'type2', ps.type2
          )
        ) as pokemon
      FROM pvp_teams pt
      LEFT JOIN pokemon_instances pi ON pi.id = ANY(pt.pokemon_ids)
      LEFT JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pt.user_id = $1
      GROUP BY pt.id
      ORDER BY pt.is_active DESC, pt.created_at DESC
    `, [userId]);
    
    res.json(successResp(teams));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/pvp/season
 * @desc    获取赛季信息
 * @access  Public
 */
router.get('/season', async (req, res, next) => {
  try {
    const { rows: [season] } = await query(`
      SELECT * FROM pvp_seasons WHERE is_active = true ORDER BY id DESC LIMIT 1
    `);
    
    if (!season) {
      throw new AppError(7010, '当前没有活跃的赛季', 404);
    }
    
    // 计算剩余时间
    const remainingDays = Math.ceil((new Date(season.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    
    res.json(successResp({
      ...season,
      remainingDays
    }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
