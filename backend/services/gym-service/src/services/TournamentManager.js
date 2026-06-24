const db = require('@pmg/shared/db');
const { getRedis } = require('@pmg/shared/redis');
const { createLogger } = require('@pmg/shared/logger');
const { v4: uuidv4 } = require('uuid');

const logger = createLogger('tournament-manager');

class TournamentManager {
  // 获取可报名的锦标赛列表
  async getAvailableTournaments(options = {}) {
    const { type, limit = 20 } = options;
    
    let queryStr = `
      SELECT t.*, 
             (SELECT COUNT(*)::int FROM tournament_participants tp WHERE tp.tournament_id = t.id) as current_participants
      FROM tournaments t
      WHERE t.status IN ('upcoming', 'registration')
        AND t.registration_end > NOW()
    `;
    
    const params = [];
    
    if (type) {
      queryStr += ` AND t.type = $1`;
      params.push(type);
    }
    
    queryStr += ` ORDER BY t.start_time ASC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await db.query(queryStr, params);
    
    return result.rows.map(this.formatTournament);
  }
  
  // 报名锦标赛
  async register(userId, tournamentId) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 检查锦标赛状态
      const tournamentResult = await client.query(
        `SELECT * FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId]
      );
      
      if (tournamentResult.rows.length === 0) {
        throw new Error('TOURNAMENT_NOT_FOUND');
      }
      
      const tournament = tournamentResult.rows[0];
      
      if (tournament.status !== 'registration' && tournament.status !== 'upcoming') {
        throw new Error('REGISTRATION_CLOSED');
      }
      
      if (new Date() > new Date(tournament.registration_end)) {
        throw new Error('REGISTRATION_ENDED');
      }
      
      // 检查是否已报名
      const existingResult = await client.query(
        `SELECT * FROM tournament_participants WHERE tournament_id = $1 AND user_id = $2`,
        [tournamentId, userId]
      );
      
      if (existingResult.rows.length > 0) {
        throw new Error('ALREADY_REGISTERED');
      }
      
      // 检查人数限制
      const countResult = await client.query(
        `SELECT COUNT(*)::int as count FROM tournament_participants WHERE tournament_id = $1`,
        [tournamentId]
      );
      
      if (countResult.rows[0].count >= tournament.max_participants) {
        throw new Error('TOURNAMENT_FULL');
      }
      
      // 检查段位限制
      if (tournament.min_tier) {
        const seasonResult = await client.query(
          `SELECT * FROM seasons WHERE status = 'active' LIMIT 1`
        );
        
        if (seasonResult.rows.length > 0) {
          const rankResult = await client.query(
            `SELECT * FROM player_ranks WHERE user_id = $1 AND season_id = $2`,
            [userId, seasonResult.rows[0].id]
          );
          
          if (rankResult.rows.length > 0) {
            const playerTier = rankResult.rows[0].tier;
            const tierLevels = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster'];
            
            if (tierLevels.indexOf(playerTier) < tierLevels.indexOf(tournament.min_tier)) {
              throw new Error('TIER_REQUIREMENT_NOT_MET');
            }
          }
        }
      }
      
      // 添加参与者
      await client.query(
        `INSERT INTO tournament_participants (tournament_id, user_id, registered_at)
         VALUES ($1, $2, NOW())`,
        [tournamentId, userId]
      );
      
      // 更新当前报名人数统计
      await client.query(
        `UPDATE tournaments SET current_participants = current_participants + 1 WHERE id = $1`,
        [tournamentId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Tournament registration successful', { userId, tournamentId });
      
      return { success: true, tournamentId };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 取消报名
  async unregister(userId, tournamentId) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `DELETE FROM tournament_participants 
         WHERE tournament_id = $1 AND user_id = $2
         RETURNING *`,
        [tournamentId, userId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('NOT_REGISTERED');
      }
      
      await client.query(
        `UPDATE tournaments SET current_participants = GREATEST(0, current_participants - 1) WHERE id = $1`,
        [tournamentId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Tournament unregistration successful', { userId, tournamentId });
      
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 生成对战树
  async generateBracket(tournamentId) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取所有参与者
      const participantsResult = await client.query(
        `SELECT tp.*, u.nickname as username, pr.rank_points, pr.tier
         FROM tournament_participants tp
         JOIN users u ON tp.user_id = u.id
         LEFT JOIN player_ranks pr ON tp.user_id = pr.user_id
         WHERE tp.tournament_id = $1
         ORDER BY pr.rank_points DESC NULLS LAST`,
        [tournamentId]
      );
      
      const participants = participantsResult.rows;
      
      if (participants.length < 2) {
        throw new Error('NOT_ENOUGH_PARTICIPANTS');
      }
      
      // 计算需要的轮数
      const rounds = Math.ceil(Math.log2(participants.length));
      const bracketSize = Math.pow(2, rounds);
      
      // 生成淘汰赛树
      const bracket = this.buildEliminationBracket(participants, bracketSize, rounds);
      
      // 保存对战树
      await client.query(
        `UPDATE tournaments SET bracket = $1, status = 'in_progress', updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(bracket), tournamentId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Tournament bracket generated', { tournamentId, participants: participants.length });
      
      return bracket;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 构建淘汰赛树
  buildEliminationBracket(participants, bracketSize, rounds) {
    const bracket = {
      rounds: [],
      participants: participants.length
    };
    
    // 种子分配
    const seeds = participants.map((p, i) => ({
      ...p,
      seed: i + 1
    }));
    
    // 第一轮对阵
    const firstRound = [];
    for (let i = 0; i < bracketSize / 2; i++) {
      const player1 = seeds[i];
      const player2 = seeds[bracketSize - 1 - i] || null;
      
      firstRound.push({
        matchId: uuidv4(),
        round: 1,
        position: i + 1,
        player1: player1 ? {
          id: player1.user_id,
          username: player1.username,
          seed: player1.seed
        } : null,
        player2: player2 ? {
          id: player2.user_id,
          username: player2.username,
          seed: player2.seed
        } : null,
        winner: player2 ? null : player1?.user_id, // 轮空自动晋级
        status: player2 ? 'pending' : 'completed'
      });
    }
    
    bracket.rounds.push({ round: 1, matches: firstRound });
    
    // 后续轮次
    for (let r = 2; r <= rounds; r++) {
      const matchCount = bracketSize / Math.pow(2, r);
      const round = [];
      
      for (let i = 0; i < matchCount; i++) {
        round.push({
          matchId: uuidv4(),
          round: r,
          position: i + 1,
          player1: null,
          player2: null,
          winner: null,
          status: 'pending'
        });
      }
      
      bracket.rounds.push({ round: r, matches: round });
    }
    
    return bracket;
  }
  
  // 上报比赛结果
  async reportMatchResult(tournamentId, matchId, winnerId, battleData) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取锦标赛和对战树
      const tournamentResult = await client.query(
        `SELECT * FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId]
      );
      
      if (tournamentResult.rows.length === 0) {
        throw new Error('TOURNAMENT_NOT_FOUND');
      }
      
      const tournament = tournamentResult.rows[0];
      const bracket = typeof tournament.bracket === 'string' ? JSON.parse(tournament.bracket) : tournament.bracket;
      
      // 找到比赛并更新结果
      let match = null;
      let matchRoundIndex = -1;
      let matchIndex = -1;
      
      for (let ri = 0; ri < bracket.rounds.length; ri++) {
        const round = bracket.rounds[ri];
        for (let mi = 0; mi < round.matches.length; mi++) {
          if (round.matches[mi].matchId === matchId) {
            match = round.matches[mi];
            matchRoundIndex = ri;
            matchIndex = mi;
            break;
          }
        }
        if (match) break;
      }
      
      if (!match) {
        throw new Error('MATCH_NOT_FOUND');
      }
      
      // 更新比赛结果
      match.winner = winnerId;
      match.status = 'completed';
      match.battleData = battleData;
      match.completedAt = new Date().toISOString();
      
      // 晋级到下一轮
      if (matchRoundIndex < bracket.rounds.length - 1) {
        const nextRound = bracket.rounds[matchRoundIndex + 1];
        const nextMatchIndex = Math.floor(matchIndex / 2);
        const nextMatch = nextRound.matches[nextMatchIndex];
        
        const winnerName = match.player1?.id === winnerId ? match.player1.username : match.player2?.username;
        const winnerSeed = match.player1?.id === winnerId ? match.player1.seed : match.player2?.seed;
        
        if (matchIndex % 2 === 0) {
          nextMatch.player1 = {
            id: winnerId,
            username: winnerName,
            seed: winnerSeed
          };
        } else {
          nextMatch.player2 = {
            id: winnerId,
            username: winnerName,
            seed: winnerSeed
          };
        }
      } else {
        // 锦标赛结束
        bracket.winner = winnerId;
        await this.finalizeTournament(client, tournamentId, winnerId, bracket);
      }
      
      // 保存更新后的对战树
      await client.query(
        `UPDATE tournaments SET bracket = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(bracket), tournamentId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Tournament match result reported', { tournamentId, matchId, winnerId });
      
      return { success: true, bracket };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 结束锦标赛
  async finalizeTournament(client, tournamentId, winnerId, bracket) {
    // 获取所有参与者排名
    const participants = await client.query(
      `SELECT * FROM tournament_participants WHERE tournament_id = $1`,
      [tournamentId]
    );
    
    // 更新参与者排名
    const updates = participants.rows.map(p => {
      let rank = participants.rows.length; // 默认最后一名
      
      if (p.user_id === winnerId) {
        rank = 1;
      } else if (this.isRunnerUp(bracket, p.user_id)) {
        rank = 2;
      } else if (this.isSemiFinalist(bracket, p.user_id)) {
        rank = 3;
      }
      
      return client.query(
        `UPDATE tournament_participants 
         SET final_rank = $1, eliminated = $2
         WHERE tournament_id = $3 AND user_id = $4`,
        [rank, rank < participants.rows.length, tournamentId, p.user_id]
      );
    });
    
    await Promise.all(updates);
    
    // 更新锦标赛状态
    await client.query(
      `UPDATE tournaments SET status = 'completed', end_time = NOW(), updated_at = NOW() WHERE id = $1`,
      [tournamentId]
    );
    
    logger.info('Tournament finalized', { tournamentId, winnerId });
  }
  
  // 辅助方法：格式化锦标赛
  formatTournament(tournament) {
    return {
      id: tournament.id,
      name: tournament.name,
      type: tournament.type,
      format: tournament.format,
      status: tournament.status,
      participants: {
        current: parseInt(tournament.current_participants) || 0,
        max: tournament.max_participants
      },
      registration: {
        start: tournament.registration_start,
        end: tournament.registration_end
      },
      startTime: tournament.start_time,
      minTier: tournament.min_tier,
      rewards: tournament.rewards,
      entryFee: tournament.entry_fee
    };
  }
  
  // 辅助方法：判断是否亚军
  isRunnerUp(bracket, userId) {
    const finalMatch = bracket.rounds[bracket.rounds.length - 1].matches[0];
    if (!finalMatch) return false;
    const loser = finalMatch.winner === finalMatch.player1?.id 
      ? finalMatch.player2 
      : finalMatch.player1;
    return loser?.id === userId;
  }
  
  // 辅助方法：判断是否四强
  isSemiFinalist(bracket, userId) {
    if (bracket.rounds.length < 2) return false;
    const semiFinals = bracket.rounds[bracket.rounds.length - 2].matches;
    return semiFinals.some(m => 
      (m.player1?.id === userId || m.player2?.id === userId) && m.winner !== userId
    );
  }
}

module.exports = new TournamentManager();
