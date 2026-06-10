/**
 * REQ-00073: PVP 玩家对战系统 - 战斗室管理
 * 创建时间: 2026-06-10 01:40
 * 
 * 功能:
 * - PVP 战斗室管理
 * - 实时回合同步
 * - 战斗状态管理
 */

const { v4: uuidv4 } = require('uuid');
const { logger } = require('../../shared/logger');
const { query } = require('../../shared/db');
const pvpMatching = require('../../shared/pvpMatching');

/**
 * 属性克制表
 */
const TYPE_CHART = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
};

/**
 * PVP 战斗室
 */
class PVPBattleRoom {
  constructor(battleId, player1, player2, battleType = 'ranked') {
    this.battleId = battleId;
    this.battleType = battleType;
    this.status = 'pending';
    
    // 玩家数据
    this.players = new Map([
      [player1.id, {
        id: player1.id,
        ws: player1.ws,
        team: player1.team,
        currentPokemonIndex: 0,
        ready: false,
        eloRating: player1.eloRating
      }],
      [player2.id, {
        id: player2.id,
        ws: player2.ws,
        team: player2.team,
        currentPokemonIndex: 0,
        ready: false,
        eloRating: player2.eloRating
      }]
    ]);
    
    // 战斗状态
    this.turnNumber = 0;
    this.currentTurn = player1.id;
    this.battleLog = [];
    this.turnActions = new Map();
    this.startTime = null;
    this.endTime = null;
    this.winnerId = null;
  }

  /**
   * 获取当前玩家
   */
  getCurrentPlayer() {
    return this.players.get(this.currentTurn);
  }

  /**
   * 获取对手
   */
  getOpponent(playerId) {
    for (const [id, player] of this.players) {
      if (id !== playerId) return player;
    }
    return null;
  }

  /**
   * 玩家准备
   */
  setPlayerReady(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;
    
    player.ready = true;
    
    // 检查是否双方都准备好了
    const allReady = [...this.players.values()].every(p => p.ready);
    
    if (allReady) {
      this.status = 'in_progress';
      this.startTime = Date.now();
      this.broadcast({ type: 'battle_start', battleId: this.battleId });
      this.notifyTurn();
    } else {
      this.broadcast({ type: 'player_ready', playerId });
    }
    
    return true;
  }

  /**
   * 提交回合行动
   */
  submitTurnAction(playerId, action) {
    // 验证是否是当前回合玩家
    if (this.currentTurn !== playerId) {
      this.sendToPlayer(playerId, { type: 'error', message: '不是你的回合' });
      return false;
    }
    
    // 验证行动
    if (!this.validateAction(playerId, action)) {
      this.sendToPlayer(playerId, { type: 'error', message: '无效的行动' });
      return false;
    }
    
    // 保存行动
    this.turnActions.set(playerId, action);
    
    // 广播行动
    this.broadcast({
      type: 'turn_action',
      playerId,
      action,
      turnNumber: this.turnNumber
    });
    
    // 处理回合
    this.processTurn();
    
    return true;
  }

  /**
   * 验证行动
   */
  validateAction(playerId, action) {
    const player = this.players.get(playerId);
    if (!player) return false;
    
    const currentPokemon = player.team[player.currentPokemonIndex];
    if (!currentPokemon) return false;
    
    // 验证技能是否存在
    if (action.type === 'move') {
      const move = currentPokemon.moves?.find(m => m.id === action.moveId);
      if (!move) return false;
      
      // 验证 PP
      if (move.pp !== undefined && move.pp <= 0) return false;
    }
    
    // 验证切换精灵
    if (action.type === 'switch') {
      if (action.pokemonIndex < 0 || action.pokemonIndex >= player.team.length) return false;
      if (action.pokemonIndex === player.currentPokemonIndex) return false;
      if (!player.team[action.pokemonIndex].hp_current > 0) return false;
    }
    
    return true;
  }

  /**
   * 处理回合
   */
  processTurn() {
    this.turnNumber++;
    
    // 获取双方行动
    const actions = {};
    for (const [playerId, action] of this.turnActions) {
      actions[playerId] = action;
    }
    
    // 计算行动顺序（速度优先）
    const actionOrder = this.calculateActionOrder(actions);
    
    // 执行行动
    const turnResult = {
      turnNumber: this.turnNumber,
      actions: [],
      damageDealt: [],
      pokemonFainted: []
    };
    
    for (const playerId of actionOrder) {
      const action = actions[playerId];
      const result = this.executeAction(playerId, action);
      turnResult.actions.push(result);
      
      // 检查是否有精灵倒下
      if (result.fainted) {
        turnResult.pokemonFainted.push(result.fainted);
        
        // 检查战斗是否结束
        if (this.checkBattleEnd()) {
          this.endBattle();
          return;
        }
      }
    }
    
    // 记录日志
    this.battleLog.push(turnResult);
    
    // 广播回合结果
    this.broadcast({
      type: 'turn_result',
      ...turnResult
    });
    
    // 清空行动
    this.turnActions.clear();
    
    // 切换回合
    this.switchTurn();
    
    // 通知下一回合
    this.notifyTurn();
  }

  /**
   * 计算行动顺序
   */
  calculateActionOrder(actions) {
    const order = [];
    
    // 切换精灵优先
    for (const [playerId, action] of Object.entries(actions)) {
      if (action.type === 'switch') {
        order.unshift(playerId);
      }
    }
    
    // 按速度排序技能
    const moveActions = [];
    for (const [playerId, action] of Object.entries(actions)) {
      if (action.type === 'move') {
        const player = this.players.get(playerId);
        const pokemon = player.team[player.currentPokemonIndex];
        moveActions.push({
          playerId,
          speed: pokemon.speed || 100,
          priority: action.priority || 0
        });
      }
    }
    
    // 排序：优先级 > 速度
    moveActions.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.speed - a.speed;
    });
    
    for (const { playerId } of moveActions) {
      order.push(playerId);
    }
    
    return order;
  }

  /**
   * 执行行动
   */
  executeAction(playerId, action) {
    const player = this.players.get(playerId);
    const opponent = this.getOpponent(playerId);
    
    const result = {
      playerId,
      action,
      timestamp: Date.now()
    };
    
    if (action.type === 'switch') {
      // 切换精灵
      player.currentPokemonIndex = action.pokemonIndex;
      result.message = `${player.team[action.pokemonIndex].nickname || player.team[action.pokemonIndex].name} 上场！`;
    } else if (action.type === 'move') {
      // 使用技能
      const attacker = player.team[player.currentPokemonIndex];
      const defender = opponent.team[opponent.currentPokemonIndex];
      
      const damageResult = this.calculateDamage(attacker, defender, action);
      result.damage = damageResult.damage;
      result.effectiveness = damageResult.effectiveness;
      result.critical = damageResult.critical;
      result.message = damageResult.message;
      
      // 应用伤害
      defender.hp_current = Math.max(0, defender.hp_current - damageResult.damage);
      
      // 检查是否倒下
      if (defender.hp_current <= 0) {
        result.fainted = {
          playerId: opponent.id,
          pokemonIndex: opponent.currentPokemonIndex,
          pokemon: defender
        };
      }
    }
    
    return result;
  }

  /**
   * 计算伤害
   */
  calculateDamage(attacker, defender, action) {
    const move = attacker.moves?.find(m => m.id === action.moveId);
    if (!move) return { damage: 0, message: '技能无效' };
    
    const level = attacker.level || 50;
    const attack = move.category === 'physical' ? (attacker.attack || 100) : (attacker.special_attack || 100);
    const defense = move.category === 'physical' ? (defender.defense || 100) : (defender.special_defense || 100);
    const power = move.power || 40;
    
    // 基础伤害
    let damage = Math.floor(((2 * level / 5 + 2) * power * attack / defense) / 50 + 2);
    
    // 属性克制
    const effectiveness = this.calculateTypeEffectiveness(move.type, defender.types || ['normal']);
    damage = Math.floor(damage * effectiveness.multiplier);
    
    // STAB 加成
    if (attacker.types?.includes(move.type)) {
      damage = Math.floor(damage * 1.5);
    }
    
    // 暴击
    const critical = Math.random() < 0.0625;
    if (critical) {
      damage = Math.floor(damage * 1.5);
    }
    
    // 随机浮动
    damage = Math.floor(damage * (0.85 + Math.random() * 0.15));
    
    // 最小伤害为 1
    damage = Math.max(1, damage);
    
    // 消息
    let message = `${attacker.nickname || attacker.name} 使用了 ${move.name}！`;
    if (effectiveness.multiplier > 1) message += ' 效果拔群！';
    if (effectiveness.multiplier < 1 && effectiveness.multiplier > 0) message += ' 效果不太好...';
    if (effectiveness.multiplier === 0) message += ' 没有效果...';
    if (critical) message += ' 暴击！';
    
    return { damage, effectiveness, critical, message };
  }

  /**
   * 计算属性克制
   */
  calculateTypeEffectiveness(moveType, defenderTypes) {
    let multiplier = 1;
    
    for (const defenderType of defenderTypes) {
      if (TYPE_CHART[moveType] && TYPE_CHART[moveType][defenderType] !== undefined) {
        multiplier *= TYPE_CHART[moveType][defenderType];
      }
    }
    
    return { multiplier };
  }

  /**
   * 检查战斗是否结束
   */
  checkBattleEnd() {
    for (const [playerId, player] of this.players) {
      const hasAlive = player.team.some(p => p.hp_current > 0);
      if (!hasAlive) {
        this.winnerId = this.getOpponent(playerId).id;
        return true;
      }
    }
    return false;
  }

  /**
   * 结束战斗
   */
  async endBattle() {
    this.status = 'completed';
    this.endTime = Date.now();
    
    const loserId = this.getOpponent(this.winnerId).id;
    
    // 计算 ELO 变化
    const winner = this.players.get(this.winnerId);
    const loser = this.players.get(loserId);
    
    const eloChange = pvpMatching.calculateEloChange(winner.eloRating, loser.eloRating);
    
    // 更新排位
    if (this.battleType === 'ranked') {
      await pvpMatching.updateRanking(this.winnerId, eloChange.winnerChange, true);
      await pvpMatching.updateRanking(loserId, eloChange.loserChange, false);
    }
    
    // 保存战斗记录
    await this.saveBattleRecord(eloChange);
    
    // 广播战斗结束
    this.broadcast({
      type: 'battle_end',
      winnerId: this.winnerId,
      eloChange,
      battleLog: this.battleLog
    });
  }

  /**
   * 保存战斗记录
   */
  async saveBattleRecord(eloChange) {
    try {
      await query(`
        INSERT INTO pvp_battles (
          id, attacker_id, defender_id, battle_type, status,
          winner_id, battle_data, turns, elo_change, started_at, ended_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        this.battleId,
        [...this.players.keys()][0],
        [...this.players.keys()][1],
        this.battleType,
        this.status,
        this.winnerId,
        JSON.stringify({ log: this.battleLog, teams: [...this.players.values()].map(p => ({ id: p.id, team: p.team })) }),
        this.turnNumber,
        JSON.stringify(eloChange),
        new Date(this.startTime).toISOString(),
        new Date(this.endTime).toISOString()
      ]);
      
      logger.info('PVP battle record saved', { battleId: this.battleId });
    } catch (error) {
      logger.error('Failed to save battle record', { error: error.message, battleId: this.battleId });
    }
  }

  /**
   * 投降
   */
  surrender(playerId) {
    this.winnerId = this.getOpponent(playerId).id;
    this.endBattle();
  }

  /**
   * 切换回合
   */
  switchTurn() {
    for (const playerId of this.players.keys()) {
      if (playerId !== this.currentTurn) {
        this.currentTurn = playerId;
        break;
      }
    }
  }

  /**
   * 通知当前回合玩家
   */
  notifyTurn() {
    const currentPlayer = this.getCurrentPlayer();
    this.sendToPlayer(this.currentTurn, {
      type: 'your_turn',
      turnNumber: this.turnNumber
    });
    
    this.sendToPlayer(this.getOpponent(this.currentTurn).id, {
      type: 'opponent_turn',
      turnNumber: this.turnNumber
    });
  }

  /**
   * 广播消息
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const player of this.players.values()) {
      if (player.ws && player.ws.readyState === 1) {
        player.ws.send(data);
      }
    }
  }

  /**
   * 发送给指定玩家
   */
  sendToPlayer(playerId, message) {
    const player = this.players.get(playerId);
    if (player && player.ws && player.ws.readyState === 1) {
      player.ws.send(JSON.stringify(message));
    }
  }
}

/**
 * PVP 战斗管理器
 */
class PVPBattleManager {
  constructor() {
    this.activeBattles = new Map(); // battleId -> PVPBattleRoom
    this.playerBattles = new Map(); // userId -> battleId
  }

  /**
   * 创建战斗
   */
  createBattle(player1, player2, battleType) {
    const battleId = uuidv4();
    const battleRoom = new PVPBattleRoom(battleId, player1, player2, battleType);
    
    this.activeBattles.set(battleId, battleRoom);
    this.playerBattles.set(player1.id, battleId);
    this.playerBattles.set(player2.id, battleId);
    
    logger.info('PVP battle created', {
      battleId,
      player1: player1.id,
      player2: player2.id,
      battleType
    });
    
    return battleRoom;
  }

  /**
   * 获取战斗
   */
  getBattle(battleId) {
    return this.activeBattles.get(battleId);
  }

  /**
   * 获取玩家当前战斗
   */
  getPlayerBattle(playerId) {
    const battleId = this.playerBattles.get(playerId);
    return battleId ? this.activeBattles.get(battleId) : null;
  }

  /**
   * 结束战斗
   */
  endBattle(battleId) {
    const battle = this.activeBattles.get(battleId);
    if (battle) {
      for (const playerId of battle.players.keys()) {
        this.playerBattles.delete(playerId);
      }
      this.activeBattles.delete(battleId);
    }
  }
}

module.exports = {
  PVPBattleRoom,
  PVPBattleManager: new PVPBattleManager()
};
