/**
 * REQ-00469: 游戏实时对战回放录制与分享系统 - 回放服务
 * 创建时间: 2026-07-07 17:05 UTC
 * 
 * 功能:
 * - 对战事件流录制
 * - 回放数据压缩与存储
 * - 分享链接生成
 * - 精彩片段提取
 * - 社交平台分享
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const zlib = require('zlib');
const db = require('./db');
const { getRedis, setJSON, getJSON } = require('./redis');
const logger = require('./logger');
const metrics = require('./metrics');

class ReplayService {
  constructor() {
    this.cachePrefix = 'replay:';
    this.shareCodeLength = 8;
    this.maxEventStreamSize = 5 * 1024 * 1024; // 5MB 最大回放大小
  }

  /**
   * 录制战斗事件流
   * @param {string} battleId - 战斗ID
   * @param {Object} battleData - 战斗数据
   * @returns {Object} 回放记录
   */
  async recordReplay(battleId, battleData) {
    const startTime = Date.now();
    
    try {
      // 1. 序列化事件流
      const eventStream = this.serializeEventStream(battleData.replay || []);
      
      // 2. 压缩事件流
      const compressed = this.compressEventStream(eventStream);
      
      // 3. 提取精彩片段
      const highlights = this.extractHighlights(eventStream, battleData);
      
      // 4. 计算统计数据
      const stats = this.calculateBattleStats(eventStream);
      
      // 5. 插入回放记录
      const result = await db.query(`
        INSERT INTO battle_replay_records (
          battle_id, gym_id, battle_type,
          attacker_user_id, attacker_team, defender_info,
          result, final_turns, duration_ms,
          event_stream, file_size_bytes, compression
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        battleId,
        battleData.gymId,
        battleData.battleType || 'gym',
        battleData.attackerUserId,
        JSON.stringify(battleData.attackerTeam),
        JSON.stringify(battleData.defenderInfo),
        battleData.result,
        battleData.turns,
        battleData.duration,
        JSON.stringify(eventStream),
        compressed.size,
        compressed.method
      ]);
      
      const replayRecord = result.rows[0];
      
      // 6. 保存精彩片段
      if (highlights.length > 0) {
        await this.saveHighlights(replayRecord.id, highlights);
      }
      
      // 7. 缓存回放元数据
      await this.cacheReplayMetadata(replayRecord.id, {
        battleId,
        result: battleData.result,
        turns: battleData.turns,
        highlights: highlights.length
      });
      
      const duration = Date.now() - startTime;
      logger.info('Replay recorded', {
        battleId,
        replayId: replayRecord.id,
        turns: battleData.turns,
        eventCount: eventStream.length,
        fileSize: compressed.size,
        duration
      });
      
      metrics.replayRecordTotal.inc();
      metrics.replayRecordDuration.observe(duration / 1000);
      
      return {
        replayId: replayRecord.id,
        battleId,
        highlights,
        stats
      };
      
    } catch (error) {
      logger.error('Failed to record replay', {
        error: error.message,
        stack: error.stack,
        battleId
      });
      metrics.replayRecordErrorTotal.inc();
      throw error;
    }
  }

  /**
   * 序列化事件流（标准化格式）
   */
  serializeEventStream(rawReplay) {
    const eventStream = [];
    
    for (const turn of rawReplay) {
      const turnEvent = {
        turn: turn.turn,
        timestamp: turn.timestamp,
        phase: 'action', // action/status_end
        actions: [],
        statusEffects: []
      };
      
      // 标准化动作事件
      if (turn.actions && Array.isArray(turn.actions)) {
        turnEvent.actions = turn.actions.map(action => ({
          type: action.type, // attack/status_apply/status_clear/miss/confusion_damage
          actor: action.attacker || action.pokemon,
          move: action.move,
          target: action.pokemon !== action.attacker ? action.pokemon : null,
          damage: action.damage || 0,
          effectiveness: action.effectiveness || 1,
          isCritical: action.isCrit || false,
          message: action.message
        }));
      }
      
      // 标准化状态效果
      if (turn.statusEffects && Array.isArray(turn.statusEffects)) {
        turnEvent.statusEffects = turn.statusEffects.map(effect => ({
          pokemon: effect.pokemon,
          effect: effect.effect,
          value: effect.damage || effect.heal || 0,
          message: effect.message
        }));
      }
      
      eventStream.push(turnEvent);
    }
    
    return eventStream;
  }

  /**
   * 压缩事件流
   */
  compressEventStream(eventStream) {
    const jsonString = JSON.stringify(eventStream);
    const originalSize = Buffer.byteLength(jsonString, 'utf8');
    
    // 如果小于 1KB，不压缩
    if (originalSize < 1024) {
      return {
        data: jsonString,
        size: originalSize,
        method: 'none'
      };
    }
    
    // Gzip 压缩
    const compressed = zlib.gzipSync(jsonString);
    const compressedSize = compressed.length;
    
    // 如果压缩率不佳，保持原样
    if (compressedSize > originalSize * 0.9) {
      return {
        data: jsonString,
        size: originalSize,
        method: 'none'
      };
    }
    
    logger.debug('Event stream compressed', {
      originalSize,
      compressedSize,
      ratio: (compressedSize / originalSize).toFixed(2)
    });
    
    return {
      data: compressed.toString('base64'),
      size: compressedSize,
      method: 'gzip'
    };
  }

  /**
   * 提取精彩片段
   */
  extractHighlights(eventStream, battleData) {
    const highlights = [];
    
    for (let i = 0; i < eventStream.length; i++) {
      const turn = eventStream[i];
      
      for (const action of turn.actions || []) {
        // 1. 暴击
        if (action.isCritical && action.damage > 50) {
          highlights.push({
            startTurn: turn.turn,
            endTurn: turn.turn,
            highlightType: 'critical_hit',
            title: `${action.actor} 打出了暴击！`,
            description: `${action.move} 造成了 ${action.damage} 点伤害`,
            severity: action.damage > 100 ? 'high' : 'medium'
          });
        }
        
        // 2. 属性克制效果拔群
        if (action.effectiveness >= 2 && action.damage > 40) {
          highlights.push({
            startTurn: turn.turn,
            endTurn: turn.turn,
            highlightType: 'type_effectiveness',
            title: `效果拔群！`,
            description: `${action.move} 对对手造成了双倍伤害`,
            severity: 'medium'
          });
        }
        
        // 3. 击败对手
        if (action.type === 'attack' && action.damage > 0) {
          // 检查是否导致精灵倒下（下一回合有切换或战斗结束）
          const nextTurn = eventStream[i + 1];
          if (nextTurn && nextTurn.actions) {
            const hasFaint = nextTurn.actions.some(a => 
              a.type === 'switch' || a.type === 'defender_fainted'
            );
            if (hasFaint) {
              highlights.push({
                startTurn: turn.turn,
                endTurn: turn.turn,
                highlightType: 'faint',
                title: `${action.actor} 击败了对手！`,
                description: `${action.move} 结束了战斗`,
                severity: 'high'
              });
            }
          }
        }
      }
      
      // 4. 状态效果生效
      for (const effect of turn.statusEffects || []) {
        if (effect.effect === 'burn' || effect.effect === 'poison' || effect.effect === 'toxic') {
          if (effect.value > 20) {
            highlights.push({
              startTurn: turn.turn,
              endTurn: turn.turn,
              highlightType: 'status_damage',
              title: `状态效果发挥威力`,
              description: effect.message,
              severity: 'low'
            });
          }
        }
      }
    }
    
    // 5. 逆袭（战斗后期翻盘）
    if (eventStream.length >= 10) {
      const lateGame = eventStream.slice(-5);
      const playerDamageLate = lateGame.reduce((sum, turn) => {
        return sum + (turn.damage?.attacker || 0);
      }, 0);
      const enemyDamageLate = lateGame.reduce((sum, turn) => {
        return sum + (turn.damage?.defender || 0);
      }, 0);
      
      // 如果玩家在最后5回合造成更多伤害并获胜
      if (playerDamageLate > enemyDamageLate * 1.5 && battleData.result === 'win') {
        highlights.push({
          startTurn: eventStream.length - 5,
          endTurn: eventStream.length,
          highlightType: 'comeback',
          title: `精彩的逆袭！`,
          description: `在战斗的最后关头实现了逆转`,
          severity: 'high'
        });
      }
    }
    
    // 去重并按严重程度排序
    return highlights
      .filter((h, idx, arr) => 
        arr.findIndex(h2 => 
          h2.startTurn === h.startTurn && h2.highlightType === h.highlightType
        ) === idx
      )
      .sort((a, b) => {
        const severityOrder = { high: 3, medium: 2, low: 1 };
        return severityOrder[b.severity] - severityOrder[a.severity];
      })
      .slice(0, 10); // 最多保存10个精彩片段
  }

  /**
   * 计算战斗统计
   */
  calculateBattleStats(eventStream) {
    const stats = {
      totalDamageDealt: 0,
      totalDamageReceived: 0,
      criticalHits: 0,
      superEffectiveHits: 0,
      notVeryEffectiveHits: 0,
      movesUsed: {},
      statusEffectsInflicted: 0,
      statusEffectsReceived: 0
    };
    
    for (const turn of eventStream) {
      // 统计伤害
      if (turn.damage) {
        stats.totalDamageDealt += turn.damage.attacker || 0;
        stats.totalDamageReceived += turn.damage.defender || 0;
      }
      
      // 统计招式
      for (const action of turn.actions || []) {
        if (action.move) {
          stats.movesUsed[action.move] = (stats.movesUsed[action.move] || 0) + 1;
        }
        
        if (action.isCritical) stats.criticalHits++;
        if (action.effectiveness >= 2) stats.superEffectiveHits++;
        if (action.effectiveness < 1 && action.effectiveness > 0) stats.notVeryEffectiveHits++;
      }
      
      // 统计状态效果
      for (const effect of turn.statusEffects || []) {
        if (effect.pokemon === 'defender') {
          stats.statusEffectsInflicted++;
        } else {
          stats.statusEffectsReceived++;
        }
      }
    }
    
    return stats;
  }

  /**
   * 保存精彩片段
   */
  async saveHighlights(replayId, highlights) {
    try {
      const values = highlights.map((h, idx) => 
        `(${replayId}, ${h.startTurn}, ${h.endTurn}, '${h.highlightType}', 
         ${h.title ? `'${h.title.replace(/'/g, "''")}'` : 'NULL'},
         ${h.description ? `'${h.description.replace(/'/g, "''")}'` : 'NULL'})`
      ).join(', ');
      
      await db.query(`
        INSERT INTO replay_highlights 
          (replay_id, start_turn, end_turn, highlight_type, title, description)
        VALUES ${values}
      `);
      
      logger.debug('Highlights saved', { replayId, count: highlights.length });
      
    } catch (error) {
      logger.error('Failed to save highlights', {
        error: error.message,
        replayId
      });
    }
  }

  /**
   * 生成分享链接
   */
  async generateShareLink(replayId, userId, options = {}) {
    try {
      // 生成短链接码
      const shareCode = this.generateShareCode();
      
      // 密码哈希（如果提供）
      let passwordHash = null;
      if (options.password) {
        passwordHash = crypto
          .createHash('sha256')
          .update(options.password + process.env.JWT_SECRET)
          .digest('hex');
      }
      
      // 插入分享记录
      const result = await db.query(`
        INSERT INTO replay_shares (
          replay_id, share_code, shared_by_user_id,
          is_public, password_hash, max_views,
          platform, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        replayId,
        shareCode,
        userId,
        options.isPublic !== false,
        passwordHash,
        options.maxViews || 0,
        options.platform || null,
        options.expiresAt || null
      ]);
      
      const share = result.rows[0];
      const shareUrl = `${process.env.BASE_URL || 'https://minego.app'}/replay/${shareCode}`;
      
      // 更新分享统计
      await db.query(`
        UPDATE battle_replay_records
        SET share_count = share_count + 1
        WHERE id = $1
      `, [replayId]);
      
      logger.info('Share link generated', {
        replayId,
        shareCode,
        userId,
        isPublic: share.is_public
      });
      
      metrics.replayShareTotal.inc();
      
      return {
        shareId: share.id,
        shareCode,
        shareUrl,
        expiresAt: share.expires_at,
        isPublic: share.is_public
      };
      
    } catch (error) {
      logger.error('Failed to generate share link', {
        error: error.message,
        replayId,
        userId
      });
      throw error;
    }
  }

  /**
   * 获取回放数据
   */
  async getReplay(replayIdOrCode, userId = null) {
    try {
      // 尝试作为 replayId
      let query = `
        SELECT brr.*, 
               json_agg(rh ORDER BY rh.severity DESC) as highlights
        FROM battle_replay_records brr
        LEFT JOIN replay_highlights rh ON brr.id = rh.replay_id
        WHERE brr.id = $1
        GROUP BY brr.id
      `;
      
      let result = await db.query(query, [replayIdOrCode]);
      
      // 如果没找到，尝试作为 shareCode
      if (result.rows.length === 0) {
        const shareResult = await db.query(`
          SELECT rs.*, brr.*
          FROM replay_shares rs
          JOIN battle_replay_records brr ON rs.replay_id = brr.id
          WHERE rs.share_code = $1
        `, [replayIdOrCode]);
        
        if (shareResult.rows.length === 0) {
          return null;
        }
        
        const share = shareResult.rows[0];
        
        // 检查访问权限
        if (!share.is_public && share.shared_by_user_id !== userId) {
          return { error: 'private', message: '该回放为私密状态' };
        }
        
        // 检查密码保护
        if (share.password_hash) {
          return { error: 'password_required', shareCode: replayIdOrCode };
        }
        
        // 检查查看次数限制
        if (share.max_views > 0 && share.current_views >= share.max_views) {
          return { error: 'view_limit_exceeded', message: '该回放已达最大查看次数' };
        }
        
        // 更新查看次数
        await db.query(`
          UPDATE replay_shares
          SET current_views = current_views + 1,
              last_viewed_at = NOW()
          WHERE share_code = $1
        `, [replayIdOrCode]);
        
        result = { rows: [share] };
      }
      
      const replay = result.rows[0];
      
      // 解压事件流（如果压缩过）
      let eventStream = replay.event_stream;
      if (replay.compression === 'gzip' && typeof eventStream === 'string') {
        const compressed = Buffer.from(eventStream, 'base64');
        const decompressed = zlib.gunzipSync(compressed);
        eventStream = JSON.parse(decompressed.toString('utf8'));
      }
      
      logger.info('Replay retrieved', {
        replayId: replay.id,
        battleId: replay.battle_id,
        userId
      });
      
      metrics.replayViewTotal.inc();
      
      return {
        replayId: replay.id,
        battleId: replay.battle_id,
        battleType: replay.battle_type,
        result: replay.result,
        turns: replay.final_turns,
        duration: replay.duration_ms,
        eventStream,
        highlights: replay.highlights || [],
        attackerTeam: replay.attacker_team,
        defenderInfo: replay.defender_info,
        viewCount: replay.view_count,
        shareCount: replay.share_count,
        createdAt: replay.created_at
      };
      
    } catch (error) {
      logger.error('Failed to get replay', {
        error: error.message,
        replayIdOrCode
      });
      throw error;
    }
  }

  /**
   * 验证分享密码
   */
  async verifySharePassword(shareCode, password) {
    try {
      const result = await db.query(`
        SELECT rs.*, brr.id as replay_id
        FROM replay_shares rs
        JOIN battle_replay_records brr ON rs.replay_id = brr.id
        WHERE rs.share_code = $1
      `, [shareCode]);
      
      if (result.rows.length === 0) {
        return { valid: false, error: '分享链接不存在' };
      }
      
      const share = result.rows[0];
      
      const passwordHash = crypto
        .createHash('sha256')
        .update(password + process.env.JWT_SECRET)
        .digest('hex');
      
      if (passwordHash !== share.password_hash) {
        return { valid: false, error: '密码错误' };
      }
      
      // 更新查看次数
      await db.query(`
        UPDATE replay_shares
        SET current_views = current_views + 1,
            last_viewed_at = NOW()
        WHERE share_code = $1
      `, [shareCode]);
      
      return {
        valid: true,
        replayId: share.replay_id
      };
      
    } catch (error) {
      logger.error('Failed to verify share password', {
        error: error.message,
        shareCode
      });
      throw error;
    }
  }

  /**
   * 生成短链接码
   */
  generateShareCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 移除易混淆字符
    let code = '';
    for (let i = 0; i < this.shareCodeLength; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * 生成 Open Graph 图片（用于社交媒体预览）
   */
  async generateOGImage(replayId) {
    // TODO: 集成图片生成服务
    // 返回默认图片
    return `${process.env.BASE_URL || 'https://minego.app'}/images/battle-og-default.png`;
  }

  /**
   * 获取用户的回放列表
   */
  async getUserReplays(userId, options = {}) {
    try {
      const limit = options.limit || 20;
      const offset = options.offset || 0;
      const resultFilter = options.result; // win/lose/all
      
      let whereClause = 'WHERE attacker_user_id = $1';
      const params = [userId];
      
      if (resultFilter && resultFilter !== 'all') {
        whereClause += ` AND result = $${params.length + 1}`;
        params.push(resultFilter);
      }
      
      params.push(limit, offset);
      
      const result = await db.query(`
        SELECT id, battle_id, battle_type, result,
               final_turns, duration_ms, view_count, share_count,
               created_at
        FROM battle_replay_records
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);
      
      // 获取总数
      const countResult = await db.query(`
        SELECT COUNT(*) as total
        FROM battle_replay_records
        ${whereClause.replace('LIMIT', '').replace(/OFFSET.*/, '')}
      `, params.slice(0, -2));
      
      return {
        replays: result.rows,
        total: parseInt(countResult.rows[0].total),
        hasMore: offset + limit < parseInt(countResult.rows[0].total)
      };
      
    } catch (error) {
      logger.error('Failed to get user replays', {
        error: error.message,
        userId
      });
      throw error;
    }
  }

  /**
   * 删除回放
   */
  async deleteReplay(replayId, userId) {
    try {
      // 验证所有权
      const checkResult = await db.query(`
        SELECT id FROM battle_replay_records
        WHERE id = $1 AND attacker_user_id = $2
      `, [replayId, userId]);
      
      if (checkResult.rows.length === 0) {
        return { success: false, error: '回放不存在或无权删除' };
      }
      
      // 删除回放（级联删除分享和精彩片段）
      await db.query(`DELETE FROM battle_replay_records WHERE id = $1`, [replayId]);
      
      // 清除缓存
      await this.invalidateCache(replayId);
      
      logger.info('Replay deleted', { replayId, userId });
      
      return { success: true };
      
    } catch (error) {
      logger.error('Failed to delete replay', {
        error: error.message,
        replayId,
        userId
      });
      throw error;
    }
  }

  /**
   * 缓存回放元数据
   */
  async cacheReplayMetadata(replayId, metadata) {
    try {
      const key = `${this.cachePrefix}${replayId}`;
      await setJSON(key, metadata, 3600); // 1小时缓存
    } catch (error) {
      logger.error('Failed to cache replay metadata', { error: error.message });
    }
  }

  /**
   * 使缓存失效
   */
  async invalidateCache(replayId) {
    try {
      const redis = getRedis();
      await redis.del(`${this.cachePrefix}${replayId}`);
    } catch (error) {
      logger.error('Failed to invalidate cache', { error: error.message });
    }
  }
}

module.exports = new ReplayService();
