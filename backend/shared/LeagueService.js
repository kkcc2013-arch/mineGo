// REQ-00487: 精灵竞技联赛核心服务
'use strict';

const { createLogger } = require('./logger');
const { LEAGUE_LEVELS, LEAGUE_ORDER, SEASON_CONFIG, SEASON_REWARDS, MATCHMAKING_CONFIG } = require('./LeagueConstants');

const logger = createLogger('league-service');

class LeagueService {
  constructor(dbPool) {
    this.dbPool = dbPool;
  }

  /**
   * 获取当前赛季信息
   */
  async getCurrentSeason() {
    const result = await this.dbPool.query(`
      SELECT * FROM league_seasons 
      WHERE status = 'active' 
      ORDER BY season_number DESC 
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      throw new Error('No active season found');
    }
    
    const season = result.rows[0];
    const now = new Date();
    const remainingDays = Math.ceil((season.end_time - now) / (1000 * 60 * 60 * 24));
    
    return {
      ...season,
      remaining_days: Math.max(0, remainingDays),
      total_players: await this.getTotalPlayers(season.id)
    };
  }

  /**
   * 获取赛季总玩家数
   */
  async getTotalPlayers(seasonId) {
    const result = await this.dbPool.query(`
      SELECT COUNT(DISTINCT player_id) as total 
      FROM league_members 
      WHERE season_id = $1
    `, [seasonId]);
    return parseInt(result.rows[0].total) || 0;
  }

  /**
   * 获取玩家联赛信息
   */
  async getPlayerLeagueInfo(playerId) {
    const season = await this.getCurrentSeason();
    
    const result = await this.dbPool.query(`
      SELECT * FROM league_members 
      WHERE player_id = $1 AND season_id = $2
    `, [playerId, season.id]);
    
    if (result.rows.length === 0) {
      // 新玩家初始化为青铜III
      const newMember = await this.initializePlayer(playerId, season.id);
      return newMember;
    }
    
    return result.rows[0];
  }

  /**
   * 初始化玩家联赛状态
   */
  async initializePlayer(playerId, seasonId) {
    const result = await this.dbPool.query(`
      INSERT INTO league_members 
        (player_id, league_level, league_group, league_points, league_rating, season_id)
      VALUES ($1, 'BRONZE', 'III', 0, 1000, $2)
      RETURNING *
    `, [playerId, seasonId]);
    
    return result.rows[0];
  }

  /**
   * 计算胜利积分
   */
  calculateWinPoints(playerRating, opponentRating, consecutiveWins) {
    const basePoints = 25;
    const ratingDiff = opponentRating - playerRating;
    const ratingBonus = Math.max(0, Math.floor(ratingDiff / 100));
    
    // 连胜奖励：每连胜增加5分，上限25分
    const consecutiveBonus = Math.min(25, consecutiveWins * 5);
    
    return basePoints + ratingBonus + consecutiveBonus;
  }

  /**
   * 计算失败积分
   */
  calculateLossPoints(playerRating, opponentRating, consecutiveWins) {
    const baseLoss = 15;
    
    // 连胜保护：连胜3场以上，失败积分减少50%
    const protectionFactor = consecutiveWins >= 3 ? 0.5 : 1.0;
    
    return Math.floor(baseLoss * protectionFactor);
  }

  /**
   * 更新真实实力评分（ELO变体）
   */
  updateTrueRating(playerRating, opponentRating, result, kFactor = 32) {
    const expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
    const actual = result === 'win' ? 1 : 0;
    return Math.floor(playerRating + kFactor * (actual - expected));
  }

  /**
   * 处理对战结果
   */
  async processMatchResult(player1Id, player2Id, winnerId, matchDuration) {
    const season = await this.getCurrentSeason();
    
    const player1 = await this.getPlayerLeagueInfo(player1Id);
    const player2 = await this.getPlayerLeagueInfo(player2Id);
    
    const isPlayer1Winner = winnerId === player1Id;
    const isPlayer2Winner = winnerId === player2Id;
    
    // 计算积分变化
    const player1PointsChange = isPlayer1Winner 
      ? this.calculateWinPoints(player1.league_rating, player2.league_rating, player1.consecutive_wins)
      : -this.calculateLossPoints(player1.league_rating, player2.league_rating, player1.consecutive_wins);
    
    const player2PointsChange = isPlayer2Winner 
      ? this.calculateWinPoints(player2.league_rating, player1.league_rating, player2.consecutive_wins)
      : -this.calculateLossPoints(player2.league_rating, player1.league_rating, player2.consecutive_wins);
    
    // 更新真实评分
    const newRating1 = this.updateTrueRating(
      player1.league_rating, 
      player2.league_rating, 
      isPlayer1Winner ? 'win' : 'loss'
    );
    
    const newRating2 = this.updateTrueRating(
      player2.league_rating, 
      player1.league_rating, 
      isPlayer2Winner ? 'win' : 'loss'
    );
    
    // 更新连胜
    const newConsecutiveWins1 = isPlayer1Winner ? player1.consecutive_wins + 1 : 0;
    const newConsecutiveWins2 = isPlayer2Winner ? player2.consecutive_wins + 1 : 0;
    
    // 更新积分和分组
    const newPoints1 = Math.max(0, player1.league_points + player1PointsChange);
    const newPoints2 = Math.max(0, player2.league_points + player2PointsChange);
    
    const promotion1 = this.determinePromotion(newPoints1, player1.league_level, player1.league_group);
    const promotion2 = this.determinePromotion(newPoints2, player2.league_level, player2.league_group);
    
    // 更新数据库
    await this.updatePlayerLeague(player1Id, season.id, {
      points: newPoints1,
      rating: newRating1,
      consecutiveWins: newConsecutiveWins1,
      wins: isPlayer1Winner ? player1.wins + 1 : player1.wins,
      losses: isPlayer1Winner ? player1.losses : player1.losses + 1,
      level: promotion1.newLevel,
      group: promotion1.newGroup
    });
    
    await this.updatePlayerLeague(player2Id, season.id, {
      points: newPoints2,
      rating: newRating2,
      consecutiveWins: newConsecutiveWins2,
      wins: isPlayer2Winner ? player2.wins + 1 : player2.wins,
      losses: isPlayer2Winner ? player2.losses : player2.losses + 1,
      level: promotion2.newLevel,
      group: promotion2.newGroup
    });
    
    // 记录对战
    await this.recordMatch(season.id, player1Id, player2Id, winnerId, 
      player1PointsChange, player2PointsChange, matchDuration);
    
    // 记录升降级历史
    if (promotion1.action !== 'stay') {
      await this.recordHistory(player1Id, season.id, promotion1, player1.league_points);
    }
    if (promotion2.action !== 'stay') {
      await this.recordHistory(player2Id, season.id, promotion2, player2.league_points);
    }
    
    // 发放连胜奖励
    if (newConsecutiveWins1 >= 5 && newConsecutiveWins1 % 5 === 0) {
      await this.grantConsecutiveWinReward(player1Id, season.id, player1.league_level, newConsecutiveWins1);
    }
    if (newConsecutiveWins2 >= 5 && newConsecutiveWins2 % 5 === 0) {
      await this.grantConsecutiveWinReward(player2Id, season.id, player2.league_level, newConsecutiveWins2);
    }
    
    return {
      player1: {
        pointsChange: player1PointsChange,
        newPoints: newPoints1,
        newRating: newRating1,
        promotion: promotion1
      },
      player2: {
        pointsChange: player2PointsChange,
        newPoints: newPoints2,
        newRating: newRating2,
        promotion: promotion2
      }
    };
  }

  /**
   * 判断升降级
   */
  determinePromotion(playerPoints, currentLeague, currentGroup) {
    const leagueDef = LEAGUE_LEVELS[currentLeague];
    const currentLeagueIndex = LEAGUE_ORDER.indexOf(currentLeague);
    
    // 升级判定：积分达到下一联赛下限
    if (currentLeagueIndex < LEAGUE_ORDER.length - 1) {
      const nextLeague = LEAGUE_ORDER[currentLeagueIndex + 1];
      const nextLeagueDef = LEAGUE_LEVELS[nextLeague];
      
      if (playerPoints >= nextLeagueDef.minPoints) {
        return {
          action: 'promote',
          newLevel: nextLeague,
          newGroup: 'III',
          fromLevel: currentLeague,
          fromGroup: currentGroup
        };
      }
    }
    
    // 分组晋升
    const groupIndex = leagueDef.groups.indexOf(currentGroup);
    if (groupIndex > 0) {
      const threshold = leagueDef.minPoints + (groupIndex * 333);
      if (playerPoints >= threshold) {
        return {
          action: 'groupPromote',
          newLevel: currentLeague,
          newGroup: leagueDef.groups[groupIndex - 1],
          fromLevel: currentLeague,
          fromGroup: currentGroup
        };
      }
    }
    
    // 降级判定
    if (currentLeagueIndex > 0) {
      if (playerPoints < leagueDef.minPoints) {
        const prevLeague = LEAGUE_ORDER[currentLeagueIndex - 1];
        return {
          action: 'demote',
          newLevel: prevLeague,
          newGroup: 'I',
          fromLevel: currentLeague,
          fromGroup: currentGroup
        };
      }
    }
    
    return { action: 'stay', newLevel: currentLeague, newGroup: currentGroup };
  }

  /**
   * 更新玩家联赛状态
   */
  async updatePlayerLeague(playerId, seasonId, updates) {
    const result = await this.dbPool.query(`
      UPDATE league_members SET
        league_points = $3,
        league_rating = $4,
        consecutive_wins = $5,
        wins = $6,
        losses = $7,
        league_level = $8,
        league_group = $9,
        last_match_time = NOW(),
        updated_at = NOW()
      WHERE player_id = $1 AND season_id = $2
      RETURNING *
    `, [playerId, seasonId, updates.points, updates.rating, updates.consecutiveWins,
        updates.wins, updates.losses, updates.level, updates.group]);
    
    return result.rows[0];
  }

  /**
   * 记录对战结果
   */
  async recordMatch(seasonId, player1Id, player2Id, winnerId, 
    player1PointsChange, player2PointsChange, matchDuration) {
    await this.dbPool.query(`
      INSERT INTO league_matches 
        (season_id, player1_id, player2_id, winner_id, 
         player1_points_change, player2_points_change, match_duration_seconds)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [seasonId, player1Id, player2Id, winnerId,
        player1PointsChange, player2PointsChange, matchDuration]);
  }

  /**
   * 记录升降级历史
   */
  async recordHistory(playerId, seasonId, promotion, points) {
    await this.dbPool.query(`
      INSERT INTO league_history 
        (player_id, season_id, action, from_level, from_group, 
         to_level, to_group, points_at_action)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [playerId, seasonId, promotion.action, promotion.fromLevel, promotion.fromGroup,
        promotion.newLevel, promotion.newGroup, points]);
  }

  /**
   * 发放连胜奖励
   */
  async grantConsecutiveWinReward(playerId, seasonId, leagueLevel, consecutiveWins) {
    const rewardData = {
      coins: 50 + Math.floor(consecutiveWins / 5) * 20,
      items: ['stardust_boost'],
      badge: null,
      consecutiveWins
    };
    
    await this.dbPool.query(`
      INSERT INTO league_rewards 
        (player_id, season_id, reward_type, league_level, reward_data)
      VALUES ($1, $2, 'consecutiveWin', $3, $4)
    `, [playerId, seasonId, leagueLevel, JSON.stringify(rewardData)]);
    
    logger.info(`Granted consecutive win reward to player ${playerId}: ${consecutiveWins} wins`);
  }

  /**
   * 获取联赛排行榜
   */
  async getLeagueRanking(leagueLevel, leagueGroup, limit = 100) {
    const season = await this.getCurrentSeason();
    
    const result = await this.dbPool.query(`
      SELECT lm.*, 
        p.username,
        RANK() OVER (ORDER BY lm.league_points DESC, lm.league_rating DESC) as rank
      FROM league_members lm
      JOIN players p ON lm.player_id = p.id
      WHERE lm.season_id = $1 
        AND lm.league_level = $2 
        AND lm.league_group = $3
      ORDER BY lm.league_points DESC, lm.league_rating DESC
      LIMIT $4
    `, [season.id, leagueLevel, leagueGroup, limit]);
    
    return result.rows;
  }

  /**
   * 获取玩家待领取奖励
   */
  async getPendingRewards(playerId) {
    const result = await this.dbPool.query(`
      SELECT * FROM league_rewards
      WHERE player_id = $1 AND claimed = false
      ORDER BY created_at DESC
    `, [playerId]);
    
    return result.rows;
  }

  /**
   * 领取奖励
   */
  async claimReward(playerId, rewardId) {
    const result = await this.dbPool.query(`
      UPDATE league_rewards
      SET claimed = true, claimed_at = NOW()
      WHERE id = $1 AND player_id = $2 AND claimed = false
      RETURNING *
    `, [rewardId, playerId]);
    
    if (result.rows.length === 0) {
      throw new Error('Reward not found or already claimed');
    }
    
    return result.rows[0];
  }

  /**
   * 联赛匹配
   */
  async findMatch(playerId) {
    const player = await this.getPlayerLeagueInfo(playerId);
    const season = await this.getCurrentSeason();
    
    const groupRange = MATCHMAKING_CONFIG.groupRange;
    const groups = this.getAdjacentGroups(player.league_group, groupRange);
    
    const result = await this.dbPool.query(`
      SELECT player_id, league_rating, league_level, league_group
      FROM league_members
      WHERE season_id = $1
        AND league_level = $2
        AND league_group IN (${groups.map((_, i) => `$${i + 3}`).join(',')})
        AND ABS(league_rating - $${groups.length + 3}) <= $${groups.length + 4}
        AND player_id != $${groups.length + 5}
        AND last_match_time < NOW() - INTERVAL '5 minutes'
      ORDER BY ABS(league_rating - $${groups.length + 3}) ASC
      LIMIT 20
    `, [season.id, player.league_level, ...groups, player.league_rating, 
        MATCHMAKING_CONFIG.ratingRange, playerId]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * 获取相邻分组
   */
  getAdjacentGroups(currentGroup, range) {
    const leagueDef = LEAGUE_LEVELS[this.getCurrentLeagueLevel()];
    const groups = leagueDef.groups;
    const currentIndex = groups.indexOf(currentGroup);
    
    const adjacent = [];
    for (let i = Math.max(0, currentIndex - range); 
         i <= Math.min(groups.length - 1, currentIndex + range); i++) {
      adjacent.push(groups[i]);
    }
    
    return adjacent;
  }

  getCurrentLeagueLevel() {
    // 临时方法，实际应从实例获取
    return 'BRONZE';
  }
}

module.exports = LeagueService;
