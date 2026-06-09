/**
 * REQ-00054: 道馆战斗系统 - 战斗引擎核心模块
 * 创建时间: 2026-06-09 16:00
 * 
 * 功能:
 * - 回合制战斗逻辑
 * - 属性克制计算
 * - 伤害计算（威力、暴击、STAB）
 * - 状态效果处理（灼伤、麻痹、冰冻、中毒、睡眠、混乱）
 * - AI 防守策略
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../../shared/logger');

// 属性克制表（基于 Pokemon 标准）
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

// 状态效果处理器
const STATUS_EFFECTS = {
  burn: {
    name: '灼伤',
    onTurnEnd: (pokemon) => ({
      damage: Math.floor(pokemon.max_hp / 8),
      message: `${pokemon.nickname || pokemon.species} 受到灼伤伤害！`
    }),
    statModifier: { attack: 0.5 }
  },
  paralyze: {
    name: '麻痹',
    canAct: () => Math.random() < 0.75,
    statModifier: { speed: 0.5 }
  },
  freeze: {
    name: '冰冻',
    canAct: () => Math.random() < 0.2,
    onHit: (move) => move.type === 'fire' ? 'thaw' : null
  },
  poison: {
    name: '中毒',
    onTurnEnd: (pokemon) => ({
      damage: Math.floor(pokemon.max_hp / 8),
      message: `${pokemon.nickname || pokemon.species} 受到中毒伤害！`
    })
  },
  toxic: {
    name: '剧毒',
    onTurnEnd: (pokemon, turnCount) => ({
      damage: Math.floor(pokemon.max_hp * turnCount / 16),
      message: `${pokemon.nickname || pokemon.species} 受到剧毒伤害！`
    })
  },
  sleep: {
    name: '睡眠',
    canAct: () => false,
    duration: () => Math.floor(Math.random() * 3) + 1
  },
  confusion: {
    name: '混乱',
    onAct: (pokemon) => {
      if (Math.random() < 0.33) {
        return {
          selfDamage: Math.floor(pokemon.attack * 0.4),
          message: `${pokemon.nickname || pokemon.species} 在混乱中攻击了自己！`
        };
      }
      return null;
    }
  }
};

class BattleEngine {
  constructor(battleId, gymId, attackerId, defenderId) {
    this.battleId = battleId;
    this.gymId = gymId;
    this.attacker = {
      userId: attackerId,
      team: [],
      currentPokemon: null,
      defeatedCount: 0
    };
    this.defender = {
      pokemon: defenderId,
      currentPokemon: null,
      team: [],
      currentDefenderIndex: 0
    };
    this.turn = 0;
    this.replay = [];
    this.status = 'pending';
    this.startTime = Date.now();
    this.toxicTurns = { attacker: 0, defender: 0 };
  }

  /**
   * 计算属性克制倍率
   */
  calculateTypeEffectiveness(moveTypes, defenderTypes) {
    let multiplier = 1;
    const effectivenessLog = [];
    
    for (const moveType of moveTypes) {
      for (const defenderType of defenderTypes) {
        if (TYPE_CHART[moveType] && TYPE_CHART[moveType][defenderType] !== undefined) {
          multiplier *= TYPE_CHART[moveType][defenderType];
          effectivenessLog.push({
            moveType,
            defenderType,
            multiplier: TYPE_CHART[moveType][defenderType]
          });
        }
      }
    }
    
    return { multiplier, log: effectivenessLog };
  }

  /**
   * 计算伤害
   */
  calculateDamage(attacker, defender, move) {
    const level = attacker.level || 50;
    const attack = move.category === 'physical' ? (attack_stat || 100) : (attacker.special_attack || 100);
    const defense = move.category === 'physical' ? (defender.defense || 100) : (defender.special_defense || 100);
    const power = move.power || 40;
    
    // 基础伤害公式
    let damage = Math.floor(((2 * level / 5 + 2) * power * attack / defense) / 50 + 2);
    
    // 属性克制
    const { multiplier: effectiveness } = this.calculateTypeEffectiveness([move.type], defender.types || ['normal']);
    damage = Math.floor(damage * effectiveness);
    
    // STAB 加成（同属性技能加成）
    if (attacker.types && attacker.types.includes(move.type)) {
      damage = Math.floor(damage * 1.5);
    }
    
    // 暴击（基础 6.25% 概率）
    const critChance = move.crit_rate || 0.0625;
    const isCrit = Math.random() < critChance;
    if (isCrit) {
      damage = Math.floor(damage * 1.5);
    }
    
    // 随机波动 85%-100%
    damage = Math.floor(damage * (0.85 + Math.random() * 0.15));
    
    // 最小伤害为 1
    damage = Math.max(1, damage);
    
    return {
      damage,
      effectiveness,
      isCrit,
      effectivenessText: effectiveness > 1 ? '效果拔群！' : 
                        effectiveness < 1 && effectiveness > 0 ? '效果不太好...' :
                        effectiveness === 0 ? '没有效果...' : ''
    };
  }

  /**
   * 计算行动顺序
   */
  determineTurnOrder(attackerPokemon, defenderPokemon, attackerMove, defenderMove) {
    // 获取实际速度（考虑状态效果）
    let attackerSpeed = attackerPokemon.speed || 100;
    let defenderSpeed = defenderPokemon.speed || 100;
    
    // 状态效果影响速度
    if (attackerPokemon.status && STATUS_EFFECTS[attackerPokemon.status]?.statModifier?.speed) {
      attackerSpeed *= STATUS_EFFECTS[attackerPokemon.status].statModifier.speed;
    }
    if (defenderPokemon.status && STATUS_EFFECTS[defenderPokemon.status]?.statModifier?.speed) {
      defenderSpeed *= STATUS_EFFECTS[defenderPokemon.status].statModifier.speed;
    }
    
    // 优先级比较
    const attackerPriority = attackerMove.priority || 0;
    const defenderPriority = defenderMove.priority || 0;
    
    if (attackerPriority !== defenderPriority) {
      return attackerPriority > defenderPriority ? 'attacker' : 'defender';
    }
    
    // 速度比较
    if (attackerSpeed !== defenderSpeed) {
      return attackerSpeed > defenderSpeed ? 'attacker' : 'defender';
    }
    
    // 速度相同随机决定
    return Math.random() < 0.5 ? 'attacker' : 'defender';
  }

  /**
   * 执行攻击动作
   */
  async executeAttack(attacker, defender, move, isPlayer) {
    const actions = [];
    
    // 检查状态效果是否允许行动
    const statusHandler = attacker.status ? STATUS_EFFECTS[attacker.status] : null;
    
    if (statusHandler?.canAct && !statusHandler.canAct()) {
      actions.push({
        type: 'status_prevent',
        pokemon: isPlayer ? 'attacker' : 'defender',
        status: attacker.status,
        message: `${attacker.nickname || attacker.species} 因为${statusHandler.name}无法行动！`
      });
      return { actions, damage: 0 };
    }
    
    // 混乱检查
    if (statusHandler?.onAct) {
      const confusionResult = statusHandler.onAct(attacker);
      if (confusionResult) {
        attacker.current_hp -= confusionResult.selfDamage;
        actions.push({
          type: 'confusion_damage',
          pokemon: isPlayer ? 'attacker' : 'defender',
          ...confusionResult
        });
      }
    }
    
    // 命中率检查
    const accuracy = move.accuracy || 100;
    if (Math.random() * 100 > accuracy) {
      actions.push({
        type: 'miss',
        pokemon: isPlayer ? 'attacker' : 'defender',
        move: move.name,
        message: `${attacker.nickname || attacker.species} 的 ${move.name} 没有命中！`
      });
      return { actions, damage: 0 };
    }
    
    // 计算伤害
    const damageResult = this.calculateDamage(attacker, defender, move);
    defender.current_hp -= damageResult.damage;
    
    actions.push({
      type: 'attack',
      attacker: isPlayer ? 'attacker' : 'defender',
      move: move.name,
      damage: damageResult.damage,
      effectiveness: damageResult.effectiveness,
      isCrit: damageResult.isCrit,
      message: `${attacker.nickname || attacker.species} 使用了 ${move.name}！${damageResult.effectivenessText}${damageResult.isCrit ? '暴击！' : ''}`
    });
    
    // 技能附加效果（状态效果）
    if (move.status_effect && Math.random() < (move.status_chance || 0.1)) {
      defender.status = move.status_effect;
      actions.push({
        type: 'status_apply',
        pokemon: isPlayer ? 'defender' : 'attacker',
        effect: move.status_effect,
        message: `${defender.nickname || defender.species} 陷入了${STATUS_EFFECTS[move.status_effect]?.name || move.status_effect}状态！`
      });
    }
    
    // 冰冻状态下被火属性攻击解冻
    if (defender.status === 'freeze' && move.type === 'fire') {
      defender.status = null;
      actions.push({
        type: 'status_clear',
        pokemon: isPlayer ? 'defender' : 'attacker',
        effect: 'thaw',
        message: `${defender.nickname || defender.species} 解冻了！`
      });
    }
    
    return { actions, damage: damageResult.damage };
  }

  /**
   * 执行回合
   */
  async executeTurn(attackerMove) {
    this.turn++;
    const turnData = {
      turn: this.turn,
      actions: [],
      statusEffects: [],
      damage: { attacker: 0, defender: 0 },
      timestamp: Date.now()
    };

    const attackerPokemon = this.attacker.currentPokemon;
    const defenderPokemon = this.defender.currentPokemon;
    
    if (!attackerPokemon || !defenderPokemon) {
      throw new Error('战斗数据异常：当前精灵不存在');
    }
    
    // 获取防守方技能（AI 选择最优技能）
    const defenderMove = this.selectDefenderMove(defenderPokemon, attackerPokemon);
    
    // 决定行动顺序
    const order = this.determineTurnOrder(attackerPokemon, defenderPokemon, attackerMove, defenderMove);
    
    // 按顺序执行攻击
    const executeInOrder = async () => {
      if (order === 'attacker') {
        // 玩家先攻
        const playerResult = await this.executeAttack(attackerPokemon, defenderPokemon, attackerMove, true);
        turnData.actions.push(...playerResult.actions);
        turnData.damage.attacker += playerResult.damage;
        
        if (defenderPokemon.current_hp > 0) {
          const defenderResult = await this.executeAttack(defenderPokemon, attackerPokemon, defenderMove, false);
          turnData.actions.push(...defenderResult.actions);
          turnData.damage.defender += defenderResult.damage;
        }
      } else {
        // 防守方先攻
        const defenderResult = await this.executeAttack(defenderPokemon, attackerPokemon, defenderMove, false);
        turnData.actions.push(...defenderResult.actions);
        turnData.damage.defender += defenderResult.damage;
        
        if (attackerPokemon.current_hp > 0) {
          const playerResult = await this.executeAttack(attackerPokemon, defenderPokemon, attackerMove, true);
          turnData.actions.push(...playerResult.actions);
          turnData.damage.attacker += playerResult.damage;
        }
      }
    };
    
    await executeInOrder();
    
    // 回合结束处理状态效果伤害
    await this.processTurnEndStatusEffects(attackerPokemon, defenderPokemon, turnData);
    
    // 记录回放
    this.replay.push(turnData);
    
    // 检查战斗是否结束
    return this.checkBattleEnd(turnData);
  }

  /**
   * 处理回合结束的状态效果
   */
  async processTurnEndStatusEffects(attackerPokemon, defenderPokemon, turnData) {
    for (const [pokemon, isPlayer, side] of [[attackerPokemon, true, 'attacker'], [defenderPokemon, false, 'defender']]) {
      if (!pokemon.status) continue;
      
      const statusHandler = STATUS_EFFECTS[pokemon.status];
      if (!statusHandler?.onTurnEnd) continue;
      
      // 计算状态伤害
      let damage;
      if (pokemon.status === 'toxic') {
        this.toxicTurns[side]++;
        damage = statusHandler.onTurnEnd(pokemon, this.toxicTurns[side]).damage;
      } else {
        damage = statusHandler.onTurnEnd(pokemon).damage;
      }
      
      pokemon.current_hp -= damage;
      
      turnData.statusEffects.push({
        pokemon: isPlayer ? 'attacker' : 'defender',
        effect: pokemon.status,
        damage,
        message: statusHandler.onTurnEnd(pokemon).message
      });
    }
  }

  /**
   * 检查战斗是否结束
   */
  checkBattleEnd(turnData) {
    const attackerPokemon = this.attacker.currentPokemon;
    const defenderPokemon = this.defender.currentPokemon;
    
    // 检查防守方是否被击败
    if (defenderPokemon.current_hp <= 0) {
      this.defender.currentPokemon.current_hp = 0;
      
      // 检查是否有下一只防守精灵
      const nextDefender = this.getNextDefender();
      if (nextDefender) {
        this.defender.currentPokemon = nextDefender;
        this.defender.currentDefenderIndex++;
        this.status = 'defender_fainted';
        
        return {
          ...turnData,
          battleEnded: false,
          defenderFainted: true,
          nextDefender: {
            id: nextDefender.id,
            species: nextDefender.species,
            level: nextDefender.level,
            currentHp: nextDefender.current_hp,
            maxHp: nextDefender.max_hp
          }
        };
      } else {
        // 所有防守精灵被击败，玩家胜利
        this.status = 'attacker_won';
        return {
          ...turnData,
          battleEnded: true,
          result: 'win'
        };
      }
    }
    
    // 检查攻击方是否被击败
    if (attackerPokemon.current_hp <= 0) {
      attackerPokemon.current_hp = 0;
      this.attacker.defeatedCount++;
      
      // 检查是否有下一只精灵
      const nextPokemon = this.getNextAttackerPokemon();
      if (nextPokemon) {
        this.attacker.currentPokemon = nextPokemon;
        this.status = 'attacker_switch';
        
        return {
          ...turnData,
          battleEnded: false,
          attackerFainted: true,
          nextPokemon: {
            id: nextPokemon.id,
            species: nextPokemon.species,
            level: nextPokemon.level,
            currentHp: nextPokemon.current_hp,
            maxHp: nextPokemon.max_hp
          }
        };
      } else {
        // 所有精灵被击败，玩家失败
        this.status = 'attacker_lost';
        return {
          ...turnData,
          battleEnded: true,
          result: 'lose'
        };
      }
    }
    
    this.status = 'ongoing';
    return { ...turnData, battleEnded: false };
  }

  /**
   * 获取下一只攻击方精灵
   */
  getNextAttackerPokemon() {
    return this.attacker.team.find(p => 
      p.current_hp > 0 && p.id !== this.attacker.currentPokemon.id
    );
  }

  /**
   * 获取下一只防守精灵
   */
  getNextDefender() {
    if (this.defender.team.length === 0) return null;
    
    const nextIndex = this.defender.currentDefenderIndex + 1;
    return nextIndex < this.defender.team.length ? this.defender.team[nextIndex] : null;
  }

  /**
   * AI 选择防守方技能
   */
  selectDefenderMove(defender, attacker) {
    const moves = defender.moves || [];
    
    if (moves.length === 0) {
      // 没有技能时使用挣扎
      return {
        id: 'struggle',
        name: '挣扎',
        type: 'normal',
        power: 50,
        accuracy: 100,
        category: 'physical',
        priority: 0
      };
    }
    
    // AI 策略：优先选择克制对手的技能
    let bestMove = moves[0];
    let bestScore = 0;
    
    for (const move of moves) {
      let score = move.power || 40;
      
      // 计算属性克制
      const { multiplier: effectiveness } = this.calculateTypeEffectiveness(
        [move.type], 
        attacker.types || ['normal']
      );
      score *= effectiveness;
      
      // STAB 加分
      if (defender.types && defender.types.includes(move.type)) {
        score *= 1.2;
      }
      
      // 命中率加权
      score *= (move.accuracy || 100) / 100;
      
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }
    
    return bestMove;
  }

  /**
   * 获取战斗结果
   */
  getBattleResult() {
    const duration = Date.now() - this.startTime;
    
    // 计算奖励
    let prestigeGained = 0;
    let experienceGained = 0;
    let coinsGained = 0;
    
    if (this.status === 'attacker_won') {
      prestigeGained = Math.floor(1000 + Math.random() * 500);
      experienceGained = Math.floor(100 + Math.random() * 50);
      coinsGained = Math.floor(10 + Math.random() * 20);
    }
    
    return {
      battleId: this.battleId,
      gymId: this.gymId,
      result: this.status === 'attacker_won' ? 'win' : 'lose',
      turns: this.turn,
      duration,
      replay: this.replay,
      rewards: this.status === 'attacker_won' ? {
        prestigeGained,
        experienceGained,
        coinsGained
      } : null
    };
  }

  /**
   * 序列化战斗状态（用于缓存）
   */
  serialize() {
    return JSON.stringify({
      battleId: this.battleId,
      gymId: this.gymId,
      attacker: this.attacker,
      defender: this.defender,
      turn: this.turn,
      status: this.status,
      startTime: this.startTime,
      toxicTurns: this.toxicTurns
    });
  }

  /**
   * 反序列化战斗状态
   */
  static deserialize(data) {
    const parsed = JSON.parse(data);
    const engine = new BattleEngine(
      parsed.battleId,
      parsed.gymId,
      parsed.attacker.userId,
      parsed.defender.pokemon
    );
    
    engine.attacker = parsed.attacker;
    engine.defender = parsed.defender;
    engine.turn = parsed.turn;
    engine.status = parsed.status;
    engine.startTime = parsed.startTime;
    engine.toxicTurns = parsed.toxicTurns;
    
    return engine;
  }
}

module.exports = {
  BattleEngine,
  TYPE_CHART,
  STATUS_EFFECTS
};
