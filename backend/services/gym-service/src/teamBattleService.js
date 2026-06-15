/**
 * REQ-00109: 精灵团队战斗系统（Team Battle）
 * 创建时间: 2026-06-15 18:10
 * 
 * 功能:
 * - 团队组建和管理
 * - 团队回合制战斗逻辑
 * - 团队技能连携系统
 * - 贡献度计算和奖励分配
 * - Raid Boss 挑战支持
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../../shared/logger');
const db = require('../../../shared/db');

// 团队战斗类型
const BATTLE_TYPES = {
  RAID: 'raid',           // Raid Boss 挑战
  PVP_TEAM: 'pvp_team',   // 团队 PVP
  GYM_ASSAULT: 'gym_assault' // 团队道馆攻坚
};

// 团队状态
const TEAM_STATUS = {
  OPEN: 'open',           // 开放招募
  IN_BATTLE: 'in_battle', // 战斗中
  CLOSED: 'closed'        // 已关闭
};

// 邀请状态
const INVITATION_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
};

// 连携技能定义
const COMBO_SKILLS = {
  double_strike: {
    name: '双重打击',
    trigger: { type: 'same_type_attack', count: 2 },
    effect: { damageMultiplier: 1.5, description: '两名玩家同时使用同类型攻击，伤害提升 50%' }
  },
  elemental_resonance: {
    name: '元素共鸣',
    trigger: { type: 'different_elements', count: 3 },
    effect: { allDamageBoost: 0.2, duration: 3, description: '三种不同属性技能组合，全队伤害提升 20%' }
  },
  guardian_formation: {
    name: '守护阵型',
    trigger: { type: 'defense_skills', count: 2 },
    effect: { teamDefenseBoost: 0.3, duration: 2, description: '两名玩家使用防御技能，全队防御提升 30%' }
  },
  perfect_coordination: {
    name: '完美配合',
    trigger: { type: 'consecutive_attacks', count: 4 },
    effect: { finalDamageMultiplier: 2.0, description: '四名玩家连续攻击，最终伤害翻倍' }
  },
  healing_circle: {
    name: '治愈光环',
    trigger: { type: 'healing_skills', count: 2 },
    effect: { teamHealPercent: 0.15, description: '两名玩家使用治疗技能，全队恢复 15% HP' }
  },
  critical_fury: {
    name: '暴怒连击',
    trigger: { type: 'critical_hits', count: 3, withinTurns: 2 },
    effect: { critDamageBoost: 0.5, description: '两回合内 3 次暴击，暴击伤害提升 50%' }
  }
};

class TeamBattleService {
  constructor() {
    this.activeBattles = new Map(); // 战斗房间缓存
    this.teamSockets = new Map();   // WebSocket 连接管理
  }

  // ==================== 团队管理 ====================

  /**
   * 创建团队
   */
  async createTeam(leaderId, name, battleType, maxSize = 5) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // 创建团队记录
      const teamResult = await client.query(
        `INSERT INTO teams (name, leader_id, max_size, battle_type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING *`,
        [name, leaderId, maxSize, battleType, TEAM_STATUS.OPEN]
      );

      const team = teamResult.rows[0];

      // 队长自动加入团队
      await client.query(
        `INSERT INTO team_members (team_id, user_id, pokemon_ids, ready, joined_at)
         VALUES ($1, $2, $3, false, NOW())`,
        [team.id, leaderId, []]
      );

      await client.query('COMMIT');

      logger.info(`Team created: ${team.id} by user ${leaderId}`);
      return team;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to create team:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 加入团队
   */
  async joinTeam(teamId, userId, pokemonIds = []) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // 检查团队状态
      const teamResult = await client.query(
        'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
        [teamId]
      );

      if (teamResult.rows.length === 0) {
        throw new Error('团队不存在');
      }

      const team = teamResult.rows[0];

      if (team.status !== TEAM_STATUS.OPEN) {
        throw new Error('团队已关闭或正在战斗中');
      }

      // 检查团队人数
      const memberCount = await client.query(
        'SELECT COUNT(*) FROM team_members WHERE team_id = $1',
        [teamId]
      );

      if (parseInt(memberCount.rows[0].count) >= team.max_size) {
        throw new Error('团队已满');
      }

      // 检查是否已在团队中
      const existingMember = await client.query(
        'SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2',
        [teamId, userId]
      );

      if (existingMember.rows.length > 0) {
        throw new Error('已在团队中');
      }

      // 加入团队
      await client.query(
        `INSERT INTO team_members (team_id, user_id, pokemon_ids, ready, joined_at)
         VALUES ($1, $2, $3, false, NOW())`,
        [teamId, userId, pokemonIds]
      );

      await client.query('COMMIT');

      logger.info(`User ${userId} joined team ${teamId}`);
      return { success: true, teamId };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to join team:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 邀请玩家加入团队
   */
  async invitePlayer(teamId, inviterId, inviteeId) {
    // 检查邀请者是否是队长
    const teamResult = await db.pool.query(
      'SELECT * FROM teams WHERE id = $1 AND leader_id = $2',
      [teamId, inviterId]
    );

    if (teamResult.rows.length === 0) {
      throw new Error('无权邀请玩家');
    }

    // 创建邀请记录
    const inviteResult = await db.pool.query(
      `INSERT INTO team_invitations (team_id, inviter_id, invitee_id, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes', NOW())
       RETURNING *`,
      [teamId, inviterId, inviteeId, INVITATION_STATUS.PENDING]
    );

    logger.info(`Invitation sent from ${inviterId} to ${inviteeId} for team ${teamId}`);
    return inviteResult.rows[0];
  }

  /**
   * 标记准备状态
   */
  async setReady(teamId, userId, pokemonIds) {
    const result = await db.pool.query(
      `UPDATE team_members 
       SET ready = true, pokemon_ids = $1
       WHERE team_id = $2 AND user_id = $3
       RETURNING *`,
      [pokemonIds, teamId, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('不是团队成员');
    }

    // 检查是否所有人都准备好了
    const allReady = await this.checkAllReady(teamId);

    logger.info(`User ${userId} is ready for team ${teamId}`);
    return { ready: true, allReady };
  }

  /**
   * 检查所有成员是否准备就绪
   */
  async checkAllReady(teamId) {
    const result = await db.pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE ready = true) as ready_count,
        COUNT(*) as total_count
       FROM team_members 
       WHERE team_id = $1`,
      [teamId]
    );

    const { ready_count, total_count } = result.rows[0];
    return parseInt(ready_count) === parseInt(total_count) && parseInt(total_count) >= 2;
  }

  /**
   * 获取团队详情
   */
  async getTeam(teamId) {
    const teamResult = await db.pool.query(
      `SELECT t.*, 
        json_agg(json_build_object(
          'user_id', tm.user_id,
          'pokemon_ids', tm.pokemon_ids,
          'ready', tm.ready,
          'joined_at', tm.joined_at
        )) as members
       FROM teams t
       LEFT JOIN team_members tm ON t.id = tm.team_id
       WHERE t.id = $1
       GROUP BY t.id`,
      [teamId]
    );

    return teamResult.rows[0] || null;
  }

  /**
   * 获取开放团队列表
   */
  async getOpenTeams(battleType = null, limit = 20) {
    let query = `
      SELECT t.*, 
        COUNT(tm.id) as member_count
      FROM teams t
      LEFT JOIN team_members tm ON t.id = tm.team_id
      WHERE t.status = $1
    `;
    const params = [TEAM_STATUS.OPEN];

    if (battleType) {
      query += ' AND t.battle_type = $' + (params.length + 1);
      params.push(battleType);
    }

    query += ' GROUP BY t.id ORDER BY t.created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await db.pool.query(query, params);
    return result.rows;
  }

  // ==================== 团队战斗逻辑 ====================

  /**
   * 启动团队战斗
   */
  async startBattle(teamId, leaderId) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // 验证队长权限
      const teamResult = await client.query(
        'SELECT * FROM teams WHERE id = $1 AND leader_id = $2 FOR UPDATE',
        [teamId, leaderId]
      );

      if (teamResult.rows.length === 0) {
        throw new Error('无权启动战斗');
      }

      const team = teamResult.rows[0];

      // 检查所有成员是否准备就绪
      const allReady = await this.checkAllReady(teamId);
      if (!allReady) {
        throw new Error('还有成员未准备就绪');
      }

      // 获取团队成员及其精灵
      const membersResult = await client.query(
        'SELECT * FROM team_members WHERE team_id = $1',
        [teamId]
      );

      const members = membersResult.rows;

      // 创建战斗实例
      const battleId = uuidv4();
      const battleState = {
        battleId,
        teamId,
        battleType: team.battle_type,
        members: members.map(m => ({
          userId: m.user_id,
          pokemonIds: m.pokemon_ids,
          currentPokemonIndex: 0,
          defeatedPokemon: [],
          contribution: 0
        })),
        turn: 1,
        actions: [],
        comboQueue: [],
        activeCombos: [],
        startedAt: Date.now(),
        status: 'ongoing'
      };

      // 更新团队状态
      await client.query(
        "UPDATE teams SET status = $1, updated_at = NOW() WHERE id = $2",
        [TEAM_STATUS.IN_BATTLE, teamId]
      );

      // 根据战斗类型初始化敌人
      if (team.battle_type === BATTLE_TYPES.RAID) {
        // Raid Boss 将在外部设置
        battleState.enemy = null;
      }

      this.activeBattles.set(battleId, battleState);

      await client.query('COMMIT');

      logger.info(`Team battle started: ${battleId} for team ${teamId}`);
      return battleState;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to start team battle:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 提交回合行动
   */
  async submitAction(battleId, userId, action) {
    const battle = this.activeBattles.get(battleId);
    if (!battle) {
      throw new Error('战斗不存在');
    }

    const member = battle.members.find(m => m.userId === userId);
    if (!member) {
      throw new Error('不是战斗参与者');
    }

    // 记录行动
    const actionRecord = {
      turn: battle.turn,
      userId,
      pokemonId: member.pokemonIds[member.currentPokemonIndex],
      action: action.type, // 'attack', 'defend', 'heal', 'item', 'switch'
      targetId: action.targetId,
      skillId: action.skillId,
      itemId: action.itemId,
      timestamp: Date.now()
    };

    battle.actions.push(actionRecord);

    // 检查连携技能触发
    await this.checkComboTriggers(battle, actionRecord);

    // 广播行动到所有成员
    this.broadcastToTeam(battle.teamId, 'team:action_submitted', actionRecord);

    return { success: true, action: actionRecord };
  }

  /**
   * 执行回合
   */
  async executeTurn(battleId) {
    const battle = this.activeBattles.get(battleId);
    if (!battle) {
      throw new Error('战斗不存在');
    }

    // 收集本回合所有行动
    const turnActions = battle.actions.filter(a => a.turn === battle.turn);

    // 按速度排序（简化版，实际需要查询精灵速度值）
    // TODO: 实际实现需要查询精灵数据

    const results = [];
    for (const action of turnActions) {
      const result = await this.executeAction(battle, action);
      results.push(result);

      // 检查战斗是否结束
      if (await this.checkBattleEnd(battle)) {
        break;
      }
    }

    // 处理连携技能效果
    for (const combo of battle.activeCombos) {
      const comboResult = await this.executeComboEffect(battle, combo);
      results.push(comboResult);
    }

    battle.turn++;
    battle.activeCombos = [];

    // 广播回合结果
    this.broadcastToTeam(battle.teamId, 'team:turn_complete', { turn: battle.turn - 1, results });

    return { turn: battle.turn - 1, results };
  }

  /**
   * 执行单个行动
   */
  async executeAction(battle, action) {
    // 简化的伤害计算
    // 实际实现需要调用 BattleEngine 的详细计算
    const result = {
      action,
      damage: 0,
      healing: 0,
      effects: [],
      success: true
    };

    // TODO: 实现完整的战斗逻辑
    // 参考 gym-service/src/battleEngine.js

    return result;
  }

  /**
   * 检查连携技能触发
   */
  async checkComboTriggers(battle, newAction) {
    const recentActions = battle.actions.filter(
      a => a.turn >= battle.turn - 2
    );

    for (const [comboId, combo] of Object.entries(COMBO_SKILLS)) {
      if (this.isComboTriggered(combo, recentActions, battle)) {
        battle.activeCombos.push({
          id: comboId,
          ...combo,
          triggeredAt: Date.now()
        });

        // 广播连携触发
        this.broadcastToTeam(battle.teamId, 'team:combo_triggered', {
          comboId,
          name: combo.name,
          effect: combo.effect
        });

        logger.info(`Combo triggered: ${comboId} in battle ${battle.battleId}`);
      }
    }
  }

  /**
   * 检查连携技能是否触发
   */
  isComboTriggered(combo, actions, battle) {
    const trigger = combo.trigger;

    switch (trigger.type) {
      case 'same_type_attack':
        // 同类型攻击
        const attackTypes = actions
          .filter(a => a.action === 'attack')
          .map(a => a.skillType)
          .filter(Boolean);
        const typeCounts = {};
        attackTypes.forEach(t => typeCounts[t] = (typeCounts[t] || 0) + 1);
        return Object.values(typeCounts).some(count => count >= trigger.count);

      case 'different_elements':
        // 不同属性组合
        const elements = new Set(
          actions
            .filter(a => a.action === 'attack')
            .map(a => a.skillType)
            .filter(Boolean)
        );
        return elements.size >= trigger.count;

      case 'defense_skills':
        // 防御技能
        const defenseCount = actions.filter(a => a.action === 'defend').length;
        return defenseCount >= trigger.count;

      case 'healing_skills':
        // 治疗技能
        const healCount = actions.filter(a => a.action === 'heal').length;
        return healCount >= trigger.count;

      case 'consecutive_attacks':
        // 连续攻击
        const attackCount = actions.filter(a => a.action === 'attack').length;
        return attackCount >= trigger.count;

      case 'critical_hits':
        // 暴击（需要额外数据）
        const critCount = actions.filter(a => a.isCritical).length;
        return critCount >= trigger.count;

      default:
        return false;
    }
  }

  /**
   * 执行连携技能效果
   */
  async executeComboEffect(battle, combo) {
    const effect = combo.effect;
    const result = {
      comboId: combo.id,
      name: combo.name,
      effects: []
    };

    if (effect.damageMultiplier) {
      result.effects.push(`伤害提升 ${((effect.damageMultiplier - 1) * 100).toFixed(0)}%`);
    }

    if (effect.allDamageBoost) {
      result.effects.push(`全队伤害提升 ${(effect.allDamageBoost * 100).toFixed(0)}%`);
    }

    if (effect.teamDefenseBoost) {
      result.effects.push(`全队防御提升 ${(effect.teamDefenseBoost * 100).toFixed(0)}%`);
    }

    if (effect.teamHealPercent) {
      result.effects.push(`全队恢复 ${(effect.teamHealPercent * 100).toFixed(0)}% HP`);
    }

    if (effect.finalDamageMultiplier) {
      result.effects.push(`最终伤害翻倍`);
    }

    return result;
  }

  /**
   * 检查战斗是否结束
   */
  async checkBattleEnd(battle) {
    // 检查是否所有玩家的精灵都被击败
    const allDefeated = battle.members.every(m => 
      m.currentPokemonIndex >= m.pokemonIds.length
    );

    if (allDefeated) {
      battle.status = 'lost';
      battle.endedAt = Date.now();
      return true;
    }

    // 检查敌人是否被击败（Raid Boss）
    if (battle.enemy && battle.enemy.currentHp <= 0) {
      battle.status = 'won';
      battle.endedAt = Date.now();
      return true;
    }

    return false;
  }

  // ==================== 贡献度计算 ====================

  /**
   * 计算玩家贡献度
   */
  calculateContribution(userId, battleLog) {
    const playerActions = battleLog.filter(e => e.userId === userId);

    let contribution = 0;

    for (const action of playerActions) {
      // 伤害贡献
      if (action.damage) {
        contribution += action.damage;
      }

      // 治疗贡献（权重 0.5）
      if (action.healing) {
        contribution += action.healing * 0.5;
      }

      // 防御贡献（权重 0.3）
      if (action.damageBlocked) {
        contribution += action.damageBlocked * 0.3;
      }

      // 连携触发奖励
      if (action.comboTriggered) {
        contribution += 100;
      }
    }

    return Math.floor(contribution);
  }

  /**
   * 分配战斗奖励
   */
  async distributeRewards(battleId) {
    const battle = this.activeBattles.get(battleId);
    if (!battle || battle.status === 'ongoing') {
      throw new Error('战斗未结束');
    }

    // 计算总贡献度
    const totalContribution = battle.members.reduce(
      (sum, m) => sum + (m.contribution || 0), 0
    );

    // 基础奖励池
    const baseRewards = {
      exp: 1000,
      coins: 500,
      items: []
    };

    // 如果是 Raid Boss，增加奖励
    if (battle.battleType === BATTLE_TYPES.RAID && battle.status === 'won') {
      baseRewards.exp *= 2;
      baseRewards.coins *= 2;
      baseRewards.items.push({ itemId: 'rare_candy', quantity: 3 });
    }

    // 按贡献度分配
    const rewards = {};
    for (const member of battle.members) {
      const share = member.contribution / Math.max(totalContribution, 1);
      rewards[member.userId] = {
        exp: Math.floor(baseRewards.exp * share),
        coins: Math.floor(baseRewards.coins * share),
        items: baseRewards.items,
        contribution: member.contribution,
        share: share.toFixed(2)
      };
    }

    return rewards;
  }

  // ==================== Raid Boss ====================

  /**
   * 获取活跃 Raid Boss
   */
  async getActiveRaidBosses() {
    const result = await db.pool.query(
      `SELECT rb.*, p.species, p.types
       FROM raid_bosses rb
       JOIN pokemon p ON rb.pokemon_id = p.id
       WHERE rb.active_from <= NOW() 
         AND rb.active_until >= NOW()
       ORDER BY rb.active_until ASC`
    );
    return result.rows;
  }

  /**
   * 初始化 Raid Boss 战斗
   */
  async initRaidBattle(teamId, raidBossId) {
    const raidBoss = await db.pool.query(
      'SELECT * FROM raid_bosses WHERE id = $1',
      [raidBossId]
    );

    if (raidBoss.rows.length === 0) {
      throw new Error('Raid Boss 不存在');
    }

    const boss = raidBoss.rows[0];

    // 创建 Raid 战斗记录
    const battleResult = await db.pool.query(
      `INSERT INTO raid_battles (raid_boss_id, team_id, status, boss_current_hp, boss_max_hp, started_at)
       VALUES ($1, $2, 'ongoing', $3, $3, NOW())
       RETURNING *`,
      [raidBossId, teamId, boss.boss_hp]
    );

    const raidBattle = battleResult.rows[0];

    // 设置战斗中的敌人数据
    const battle = this.activeBattles.get(raidBattle.id);
    if (battle) {
      battle.enemy = {
        id: boss.id,
        pokemonId: boss.pokemon_id,
        name: boss.name || 'Raid Boss',
        maxHp: boss.boss_hp,
        currentHp: boss.boss_hp,
        attack: boss.boss_attack,
        defense: boss.boss_defense,
        skills: boss.boss_skills,
        timeLimit: boss.time_limit
      };
    }

    return raidBattle;
  }

  // ==================== 统计 ====================

  /**
   * 更新团队战斗统计
   */
  async updateBattleStats(userId, result) {
    const { won, damage, healing, comboTriggered, isMvp } = result;

    await db.pool.query(
      `INSERT INTO team_battle_stats (user_id, total_battles, wins, losses, total_damage, total_healing, combos_triggered, mvp_count, updated_at)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         total_battles = team_battle_stats.total_battles + 1,
         wins = team_battle_stats.wins + $2,
         losses = team_battle_stats.losses + $3,
         total_damage = team_battle_stats.total_damage + $4,
         total_healing = team_battle_stats.total_healing + $5,
         combos_triggered = team_battle_stats.combos_triggered + $6,
         mvp_count = team_battle_stats.mvp_count + $7,
         updated_at = NOW()`,
      [userId, won ? 1 : 0, won ? 0 : 1, damage || 0, healing || 0, comboTriggered ? 1 : 0, isMvp ? 1 : 0]
    );
  }

  /**
   * 获取玩家团队战斗统计
   */
  async getBattleStats(userId) {
    const result = await db.pool.query(
      'SELECT * FROM team_battle_stats WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  // ==================== WebSocket ====================

  /**
   * 广播消息到团队成员
   */
  broadcastToTeam(teamId, event, data) {
    const sockets = this.teamSockets.get(teamId) || [];
    for (const ws of sockets) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify({ event, data }));
      }
    }
  }

  /**
   * 注册 WebSocket 连接
   */
  registerSocket(teamId, userId, ws) {
    if (!this.teamSockets.has(teamId)) {
      this.teamSockets.set(teamId, []);
    }
    this.teamSockets.get(teamId).push(ws);

    ws.on('close', () => {
      const sockets = this.teamSockets.get(teamId) || [];
      const index = sockets.indexOf(ws);
      if (index > -1) {
        sockets.splice(index, 1);
      }
    });
  }
}

// 导出单例和常量
const teamBattleService = new TeamBattleService();

module.exports = {
  TeamBattleService,
  teamBattleService,
  BATTLE_TYPES,
  TEAM_STATUS,
  INVITATION_STATUS,
  COMBO_SKILLS
};
