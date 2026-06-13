# REQ-00054: 道馆战斗系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00054 |
| 标题 | 道馆战斗系统 |
| 类别 | 功能增强 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | gym-service、pokemon-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-09 16:00 |

## 需求描述

实现完整的道馆战斗系统，这是 mineGo 游戏的核心玩法之一。玩家可以使用自己的精灵挑战敌方道馆，与防守精灵进行回合制战斗，获胜后可以获得道馆控制权并放置自己的精灵防守。

### 核心功能

1. **道馆挑战机制**
   - 玩家选择 6 只精灵组成战斗队伍
   - 挑战敌方道馆，与防守精灵依次战斗
   - 战斗胜利后获得声望值和经验值

2. **回合制战斗系统**
   - 属性克制计算（火克草、水克火等）
   - 技能威力、命中率、暴击率计算
   - 精灵速度决定行动顺序
   - 状态效果（灼伤、麻痹、冰冻、中毒等）

3. **道馆防守系统**
   - 胜利后可放置精灵防守道馆
   - 防守精灵获得浆果奖励
   - 道馆声望等级影响防守精灵数量上限

4. **战斗奖励**
   - 经验值和声望值
   - 道具掉落（药水、复活等）
   - 金币奖励

## 技术方案

### 1. 数据库设计

```sql
-- 道馆战斗记录表
CREATE TABLE gym_battles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id UUID NOT NULL REFERENCES gyms(id),
    attacker_user_id UUID NOT NULL REFERENCES users(id),
    attacker_team TEXT[] NOT NULL, -- 参战精灵ID列表
    defender_pokemon_id UUID REFERENCES pokemon(id),
    result TEXT NOT NULL CHECK (result IN ('win', 'lose', 'retreat')),
    prestige_gained INTEGER DEFAULT 0,
    experience_gained INTEGER DEFAULT 0,
    coins_gained INTEGER DEFAULT 0,
    battle_duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- 战斗回放表
CREATE TABLE battle_replays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    battle_id UUID NOT NULL REFERENCES gym_battles(id),
    turn_number INTEGER NOT NULL,
    attacker_pokemon_id UUID NOT NULL,
    defender_pokemon_id UUID NOT NULL,
    move_id UUID REFERENCES moves(id),
    damage_dealt INTEGER,
    damage_taken INTEGER,
    status_effects JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 状态效果表
CREATE TABLE status_effects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    effect_type TEXT NOT NULL, -- 'burn', 'paralyze', 'freeze', 'poison', 'sleep', 'confusion'
    damage_per_turn INTEGER DEFAULT 0,
    action_chance REAL DEFAULT 1.0, -- 影响行动概率
    duration_turns INTEGER,
    stat_modifier JSONB, -- {"attack": 0.5, "speed": 0.25}
    description TEXT
);

-- 插入状态效果数据
INSERT INTO status_effects (name, effect_type, damage_per_turn, action_chance, duration_turns, stat_modifier, description) VALUES
('灼伤', 'burn', 8, 1.0, NULL, '{"attack": 0.5}', '灼伤状态，每回合损失 1/8 HP，物理攻击降低 50%'),
('麻痹', 'paralyze', 0, 0.75, NULL, '{"speed": 0.5}', '麻痹状态，速度降低 50%，有 25% 概率无法行动'),
('冰冻', 'freeze', 0, 0.2, NULL, '{}', '冰冻状态，有 80% 概率无法行动，被火属性技能攻击后解除'),
('中毒', 'poison', 12, 1.0, NULL, '{}', '中毒状态，每回合损失 1/8 HP'),
('剧毒', 'toxic', 6, 1.0, NULL, '{}', '剧毒状态，每回合损失递增 HP（n/16）'),
('睡眠', 'sleep', 0, 0.0, 2, '{}', '睡眠状态，无法行动 1-3 回合后自动醒来'),
('混乱', 'confusion', 0, 0.67, 3, '{}', '混乱状态，有 33% 概率攻击自己');

-- 战斗队伍预设表
CREATE TABLE battle_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    pokemon_ids TEXT[] NOT NULL CHECK (array_length(pokemon_ids, 1) <= 6),
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, name)
);

-- 创建索引
CREATE INDEX idx_gym_battles_gym_id ON gym_battles(gym_id);
CREATE INDEX idx_gym_battles_attacker ON gym_battles(attacker_user_id);
CREATE INDEX idx_gym_battles_created ON gym_battles(created_at DESC);
CREATE INDEX idx_battle_replays_battle ON battle_replays(battle_id);
CREATE INDEX idx_battle_teams_user ON battle_teams(user_id);
```

### 2. 战斗引擎核心模块

```javascript
// backend/services/gym-service/src/battleEngine.js

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const cache = require('../../../shared/cache');
const metrics = require('../../../shared/metrics');
const logger = require('../../../shared/logger');

// 属性克制表
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
    onTurnEnd: (pokemon) => ({
      damage: Math.floor(pokemon.max_hp / 8),
      message: `${pokemon.nickname || pokemon.species} 受到灼伤伤害！`
    }),
    statModifier: { attack: 0.5 }
  },
  paralyze: {
    canAct: () => Math.random() < 0.75,
    statModifier: { speed: 0.5 }
  },
  freeze: {
    canAct: () => Math.random() < 0.2,
    onHit: (move) => move.type === 'fire' ? 'thaw' : null
  },
  poison: {
    onTurnEnd: (pokemon) => ({
      damage: Math.floor(pokemon.max_hp / 8),
      message: `${pokemon.nickname || pokemon.species} 受到中毒伤害！`
    })
  },
  toxic: {
    onTurnEnd: (pokemon, turnCount) => ({
      damage: Math.floor(pokemon.max_hp * turnCount / 16),
      message: `${pokemon.nickname || pokemon.species} 受到剧毒伤害！`
    })
  },
  sleep: {
    canAct: () => false,
    duration: () => Math.floor(Math.random() * 3) + 1
  },
  confusion: {
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
    this.attacker = { userId: attackerId, team: [], currentPokemon: null };
    this.defender = { pokemon: defenderId, currentPokemon: null };
    this.turn = 0;
    this.replay = [];
    this.status = 'pending';
    this.startTime = Date.now();
  }

  // 计算属性克制倍率
  calculateTypeEffectiveness(moveTypes, defenderTypes) {
    let multiplier = 1;
    for (const moveType of moveTypes) {
      for (const defenderType of defenderTypes) {
        if (TYPE_CHART[moveType] && TYPE_CHART[moveType][defenderType] !== undefined) {
          multiplier *= TYPE_CHART[moveType][defenderType];
        }
      }
    }
    return multiplier;
  }

  // 计算伤害
  calculateDamage(attacker, defender, move) {
    const level = attacker.level;
    const attack = move.category === 'physical' ? attacker.attack : attacker.special_attack;
    const defense = move.category === 'physical' ? defender.defense : defender.special_defense;
    const power = move.power || 40;
    
    // 基础伤害公式
    let damage = Math.floor(((2 * level / 5 + 2) * power * attack / defense) / 50 + 2);
    
    // 属性克制
    const effectiveness = this.calculateTypeEffectiveness([move.type], defender.types);
    damage = Math.floor(damage * effectiveness);
    
    // STAB 加成
    if (attacker.types.includes(move.type)) {
      damage = Math.floor(damage * 1.5);
    }
    
    // 暴击
    const critChance = move.crit_rate || 0.0625;
    const isCrit = Math.random() < critChance;
    if (isCrit) {
      damage = Math.floor(damage * 1.5);
    }
    
    // 随机波动 85%-100%
    damage = Math.floor(damage * (0.85 + Math.random() * 0.15));
    
    return {
      damage: Math.max(1, damage),
      effectiveness,
      isCrit
    };
  }

  // 计算行动顺序
  determineTurnOrder(attackerPokemon, defenderPokemon, attackerMove, defenderMove) {
    const attackerSpeed = attackerPokemon.speed * (STATUS_EFFECTS[attackerPokemon.status]?.statModifier?.speed || 1);
    const defenderSpeed = defenderPokemon.speed * (STATUS_EFFECTS[defenderPokemon.status]?.statModifier?.speed || 1);
    
    // 优先级比较
    if (attackerMove.priority !== defenderMove.priority) {
      return attackerMove.priority > defenderMove.priority ? 'attacker' : 'defender';
    }
    
    // 速度比较
    if (attackerSpeed !== defenderSpeed) {
      return attackerSpeed > defenderSpeed ? 'attacker' : 'defender';
    }
    
    // 速度相同随机决定
    return Math.random() < 0.5 ? 'attacker' : 'defender';
  }

  // 执行回合
  async executeTurn(attackerMove) {
    this.turn++;
    const turnData = {
      turn: this.turn,
      actions: [],
      statusEffects: [],
      damage: { attacker: 0, defender: 0 }
    };

    const attackerPokemon = this.attacker.currentPokemon;
    const defenderPokemon = this.defender.currentPokemon;
    
    // 获取防守方技能（AI 选择最优技能）
    const defenderMove = await this.selectDefenderMove(defenderPokemon, attackerPokemon);
    
    // 决定行动顺序
    const order = this.determineTurnOrder(attackerPokemon, defenderPokemon, attackerMove, defenderMove);
    
    // 执行攻击
    const executeAttack = async (attacker, defender, move, isPlayer) => {
      // 检查状态效果
      const statusHandler = STATUS_EFFECTS[attacker.status];
      if (statusHandler?.canAct && !statusHandler.canAct()) {
        turnData.actions.push({
          type: 'status_prevent',
          pokemon: isPlayer ? 'attacker' : 'defender',
          status: attacker.status,
          message: `${attacker.nickname || attacker.species} 无法行动！`
        });
        return;
      }
      
      // 混乱检查
      if (statusHandler?.onAct) {
        const confusionResult = statusHandler.onAct(attacker);
        if (confusionResult) {
          attacker.current_hp -= confusionResult.selfDamage;
          turnData.actions.push({
            type: 'confusion_damage',
            pokemon: isPlayer ? 'attacker' : 'defender',
            ...confusionResult
          });
        }
      }
      
      // 命中率检查
      const accuracy = move.accuracy || 100;
      if (Math.random() * 100 > accuracy) {
        turnData.actions.push({
          type: 'miss',
          pokemon: isPlayer ? 'attacker' : 'defender',
          move: move.name,
          message: `${attacker.nickname || attacker.species} 的 ${move.name} 没有命中！`
        });
        return;
      }
      
      // 计算伤害
      const damageResult = this.calculateDamage(attacker, defender, move);
      defender.current_hp -= damageResult.damage;
      
      if (isPlayer) {
        turnData.damage.attacker += damageResult.damage;
      } else {
        turnData.damage.defender += damageResult.damage;
      }
      
      const effectivenessText = damageResult.effectiveness > 1 ? '效果拔群！' : 
                                 damageResult.effectiveness < 1 && damageResult.effectiveness > 0 ? '效果不太好...' :
                                 damageResult.effectiveness === 0 ? '没有效果...' : '';
      
      turnData.actions.push({
        type: 'attack',
        attacker: isPlayer ? 'attacker' : 'defender',
        move: move.name,
        damage: damageResult.damage,
        effectiveness: damageResult.effectiveness,
        isCrit: damageResult.isCrit,
        effectivenessText,
        message: `${attacker.nickname || attacker.species} 使用了 ${move.name}！${effectivenessText}${damageResult.isCrit ? '暴击！' : ''}`
      });
      
      // 技能附加效果
      if (move.status_effect && Math.random() < (move.status_chance || 0.1)) {
        defender.status = move.status_effect;
        turnData.statusEffects.push({
          pokemon: isPlayer ? 'defender' : 'attacker',
          effect: move.status_effect
        });
      }
      
      // 冰冻状态下被火属性攻击解冻
      if (defender.status === 'freeze' && move.type === 'fire') {
        defender.status = null;
        turnData.statusEffects.push({
          pokemon: isPlayer ? 'defender' : 'attacker',
          effect: 'thaw',
          message: `${defender.nickname || defender.species} 解冻了！`
        });
      }
    };
    
    // 按顺序执行攻击
    if (order === 'attacker') {
      await executeAttack(attackerPokemon, defenderPokemon, attackerMove, true);
      if (defenderPokemon.current_hp > 0) {
        await executeAttack(defenderPokemon, attackerPokemon, defenderMove, false);
      }
    } else {
      await executeAttack(defenderPokemon, attackerPokemon, defenderMove, false);
      if (attackerPokemon.current_hp > 0) {
        await executeAttack(attackerPokemon, defenderPokemon, attackerMove, true);
      }
    }
    
    // 回合结束处理状态效果伤害
    for (const pokemon of [attackerPokemon, defenderPokemon]) {
      const statusHandler = STATUS_EFFECTS[pokemon.status];
      if (statusHandler?.onTurnEnd) {
        const result = statusHandler.onTurnEnd(pokemon);
        pokemon.current_hp -= result.damage;
        turnData.statusEffects.push({
          pokemon: pokemon === attackerPokemon ? 'attacker' : 'defender',
          effect: pokemon.status,
          damage: result.damage,
          message: result.message
        });
      }
    }
    
    // 记录回放
    this.replay.push(turnData);
    
    // 检查战斗是否结束
    if (defenderPokemon.current_hp <= 0) {
      this.status = 'defender_fainted';
      return { ...turnData, battleEnded: false, defenderFainted: true };
    }
    
    if (attackerPokemon.current_hp <= 0) {
      // 检查是否有下一只精灵
      const nextPokemon = this.attacker.team.find(p => p.current_hp > 0 && p.id !== attackerPokemon.id);
      if (nextPokemon) {
        this.attacker.currentPokemon = nextPokemon;
        this.status = 'attacker_switch';
        return { ...turnData, battleEnded: false, attackerFainted: true, nextPokemon: nextPokemon.id };
      } else {
        this.status = 'attacker_lost';
        return { ...turnData, battleEnded: true, result: 'lose' };
      }
    }
    
    this.status = 'ongoing';
    return { ...turnData, battleEnded: false };
  }

  // AI 选择防守方技能
  async selectDefenderMove(defender, attacker) {
    const moves = defender.moves || [];
    if (moves.length === 0) {
      return { name: '挣扎', type: 'normal', power: 50, accuracy: 100, category: 'physical' };
    }
    
    // AI 策略：优先选择克制对手的技能
    let bestMove = moves[0];
    let bestScore = 0;
    
    for (const move of moves) {
      let score = move.power || 40;
      const effectiveness = this.calculateTypeEffectiveness([move.type], attacker.types);
      score *= effectiveness;
      
      // STAB 加分
      if (defender.types.includes(move.type)) {
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

  // 获取战斗结果
  getBattleResult() {
    const duration = Date.now() - this.startTime;
    
    return {
      battleId: this.battleId,
      gymId: this.gymId,
      result: this.status === 'attacker_lost' ? 'lose' : 'win',
      turns: this.turn,
      duration,
      replay: this.replay
    };
  }
}

module.exports = {
  BattleEngine,
  TYPE_CHART,
  STATUS_EFFECTS
};
```

### 3. API 路由

```javascript
// backend/services/gym-service/src/routes/battle.js

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { BattleEngine } = require('../battleEngine');
const cache = require('../../../shared/cache');
const metrics = require('../../../shared/metrics');
const logger = require('../../../shared/logger');
const auth = require('../../../shared/auth');

// 活跃战斗缓存
const activeBattles = new Map();

// 开始道馆战斗
router.post('/gym/:gymId/battle/start', auth.requireAuth, async (req, res) => {
  const { gymId } = req.params;
  const { teamIds } = req.body; // 玩家选择的精灵队伍
  const userId = req.user.id;
  
  try {
    metrics.increment('gym_battle_start_total');
    
    // 验证道馆存在且可挑战
    const gym = await db.query(`
      SELECT g.*, 
             gp.pokemon_id as defender_pokemon_id,
             p.species, p.level, p.hp as max_hp
      FROM gyms g
      LEFT JOIN gym_pokemon gp ON g.id = gp.gym_id
      LEFT JOIN pokemon p ON gp.pokemon_id = p.id
      WHERE g.id = $1 AND gp.is_active = true
      ORDER BY gp.position
    `, [gymId]);
    
    if (gym.rows.length === 0) {
      return res.status(404).json({ error: '道馆不存在或没有防守精灵' });
    }
    
    // 验证玩家精灵队伍
    if (!teamIds || teamIds.length === 0 || teamIds.length > 6) {
      return res.status(400).json({ error: '请选择 1-6 只精灵组成战斗队伍' });
    }
    
    const team = await db.query(`
      SELECT p.*, 
             json_agg(m.*) FILTER (WHERE m.id IS NOT NULL) as moves
      FROM pokemon p
      LEFT JOIN pokemon_moves pm ON p.id = pm.pokemon_id
      LEFT JOIN moves m ON pm.move_id = m.id
      WHERE p.id = ANY($1) AND p.user_id = $2 AND p.current_hp > 0
      GROUP BY p.id
    `, [teamIds, userId]);
    
    if (team.rows.length !== teamIds.length) {
      return res.status(400).json({ error: '部分精灵不可用' });
    }
    
    // 创建战斗实例
    const battleId = uuidv4();
    const battle = new BattleEngine(
      battleId,
      gymId,
      userId,
      gym.rows[0].defender_pokemon_id
    );
    
    battle.attacker.team = team.rows.map(p => ({
      ...p,
      max_hp: p.hp,
      moves: p.moves || []
    }));
    battle.attacker.currentPokemon = battle.attacker.team[0];
    
    // 获取防守方精灵详情
    const defender = await db.query(`
      SELECT p.*, 
             json_agg(m.*) FILTER (WHERE m.id IS NOT NULL) as moves
      FROM pokemon p
      LEFT JOIN pokemon_moves pm ON p.id = pm.pokemon_id
      LEFT JOIN moves m ON pm.move_id = m.id
      WHERE p.id = $1
      GROUP BY p.id
    `, [gym.rows[0].defender_pokemon_id]);
    
    battle.defender.currentPokemon = {
      ...defender.rows[0],
      max_hp: defender.rows[0].hp,
      current_hp: defender.rows[0].hp,
      moves: defender.rows[0].moves || []
    };
    
    // 缓存战斗实例
    activeBattles.set(battleId, battle);
    
    // 设置 10 分钟超时
    setTimeout(() => {
      if (activeBattles.has(battleId)) {
        activeBattles.delete(battleId);
        metrics.increment('gym_battle_timeout_total');
      }
    }, 10 * 60 * 1000);
    
    logger.info('Battle started', { battleId, gymId, userId, teamSize: team.rows.length });
    
    res.json({
      battleId,
      attacker: {
        currentPokemon: {
          id: battle.attacker.currentPokemon.id,
          species: battle.attacker.currentPokemon.species,
          level: battle.attacker.currentPokemon.level,
          currentHp: battle.attacker.currentPokemon.current_hp,
          maxHp: battle.attacker.currentPokemon.max_hp,
          moves: battle.attacker.currentPokemon.moves
        },
        team: battle.attacker.team.map(p => ({
          id: p.id,
          species: p.species,
          currentHp: p.current_hp,
          maxHp: p.max_hp
        }))
      },
      defender: {
        currentPokemon: {
          id: battle.defender.currentPokemon.id,
          species: battle.defender.currentPokemon.species,
          level: battle.defender.currentPokemon.level,
          currentHp: battle.defender.currentPokemon.current_hp,
          maxHp: battle.defender.currentPokemon.max_hp
        }
      },
      gym: {
        id: gym.rows[0].id,
        name: gym.rows[0].name,
        prestige: gym.rows[0].prestige
      }
    });
    
  } catch (error) {
    logger.error('Failed to start battle', { error: error.message, gymId, userId });
    metrics.increment('gym_battle_start_error_total');
    res.status(500).json({ error: '开始战斗失败' });
  }
});

// 执行战斗回合
router.post('/battle/:battleId/turn', auth.requireAuth, async (req, res) => {
  const { battleId } = req.params;
  const { moveId } = req.body;
  const userId = req.user.id;
  
  try {
    const battle = activeBattles.get(battleId);
    
    if (!battle) {
      return res.status(404).json({ error: '战斗不存在或已过期' });
    }
    
    if (battle.attacker.userId !== userId) {
      return res.status(403).json({ error: '无权操作此战斗' });
    }
    
    // 获取使用的技能
    const currentPokemon = battle.attacker.currentPokemon;
    const move = currentPokemon.moves.find(m => m.id === moveId);
    
    if (!move) {
      return res.status(400).json({ error: '该精灵没有学会此技能' });
    }
    
    // 执行回合
    const turnResult = await battle.executeTurn(move);
    
    metrics.increment('gym_battle_turn_total');
    
    // 战斗结束
    if (turnResult.battleEnded) {
      const result = battle.getBattleResult();
      activeBattles.delete(battleId);
      
      // 保存战斗记录
      await db.query(`
        INSERT INTO gym_battles (id, gym_id, attacker_user_id, attacker_team, 
                                 defender_pokemon_id, result, battle_duration_ms, completed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [battleId, battle.gymId, userId, battle.attacker.team.map(p => p.id),
          battle.defender.currentPokemon.id, result.result, result.duration]);
      
      // 保存回放
      for (const turn of result.replay) {
        await db.query(`
          INSERT INTO battle_replays (battle_id, turn_number, status_effects)
          VALUES ($1, $2, $3)
        `, [battleId, turn.turn, JSON.stringify(turn)]);
      }
      
      // 更新精灵 HP
      for (const pokemon of battle.attacker.team) {
        await db.query(`
          UPDATE pokemon SET current_hp = $1 WHERE id = $2
        `, [Math.max(0, pokemon.current_hp), pokemon.id]);
      }
      
      if (result.result === 'win') {
        metrics.increment('gym_battle_win_total');
        
        // 计算奖励
        const prestigeGained = Math.floor(1000 + Math.random() * 500);
        const experienceGained = Math.floor(100 + Math.random() * 50);
        const coinsGained = Math.floor(10 + Math.random() * 20);
        
        // 更新道馆声望
        await db.query(`
          UPDATE gyms SET prestige = prestige - $1 WHERE id = $2
        `, [prestigeGained, battle.gymId]);
        
        // 发放奖励
        await db.query(`
          UPDATE users SET 
            experience = experience + $1,
            coins = coins + $2
          WHERE id = $3
        `, [experienceGained, coinsGained, userId]);
        
        result.rewards = { prestigeGained, experienceGained, coinsGained };
      } else {
        metrics.increment('gym_battle_lose_total');
      }
      
      logger.info('Battle ended', { battleId, result: result.result, turns: result.turns });
      
      return res.json({ ...turnResult, battleResult: result });
    }
    
    // 防守方精灵被击败，切换下一只
    if (turnResult.defenderFainted) {
      // 获取下一只防守精灵
      const nextDefender = await db.query(`
        SELECT gp.pokemon_id, p.species, p.level, p.hp
        FROM gym_pokemon gp
        JOIN pokemon p ON gp.pokemon_id = p.id
        WHERE gp.gym_id = $1 AND gp.is_active = true AND gp.position > (
          SELECT position FROM gym_pokemon WHERE gym_id = $1 AND pokemon_id = $2
        )
        ORDER BY gp.position
        LIMIT 1
      `, [battle.gymId, battle.defender.currentPokemon.id]);
      
      if (nextDefender.rows.length > 0) {
        battle.defender.currentPokemon = {
          ...nextDefender.rows[0],
          current_hp: nextDefender.rows[0].hp,
          max_hp: nextDefender.rows[0].hp
        };
        
        return res.json({
          ...turnResult,
          nextDefender: {
            id: battle.defender.currentPokemon.id,
            species: battle.defender.currentPokemon.species,
            level: battle.defender.currentPokemon.level
          }
        });
      } else {
        // 所有防守精灵被击败，玩家胜利
        battle.status = 'attacker_won';
        const result = battle.getBattleResult();
        activeBattles.delete(battleId);
        
        return res.json({ ...turnResult, battleEnded: true, battleResult: result });
      }
    }
    
    res.json(turnResult);
    
  } catch (error) {
    logger.error('Failed to execute turn', { error: error.message, battleId, userId });
    metrics.increment('gym_battle_turn_error_total');
    res.status(500).json({ error: '执行回合失败' });
  }
});

// 切换精灵
router.post('/battle/:battleId/switch', auth.requireAuth, async (req, res) => {
  const { battleId } = req.params;
  const { pokemonId } = req.body;
  const userId = req.user.id;
  
  try {
    const battle = activeBattles.get(battleId);
    
    if (!battle) {
      return res.status(404).json({ error: '战斗不存在或已过期' });
    }
    
    const pokemon = battle.attacker.team.find(p => p.id === pokemonId);
    
    if (!pokemon || pokemon.current_hp <= 0) {
      return res.status(400).json({ error: '该精灵不可用' });
    }
    
    battle.attacker.currentPokemon = pokemon;
    
    res.json({
      message: '切换成功',
      currentPokemon: {
        id: pokemon.id,
        species: pokemon.species,
        level: pokemon.level,
        currentHp: pokemon.current_hp,
        maxHp: pokemon.max_hp
      }
    });
    
  } catch (error) {
    logger.error('Failed to switch pokemon', { error: error.message, battleId, userId });
    res.status(500).json({ error: '切换精灵失败' });
  }
});

// 放置精灵防守道馆
router.post('/gym/:gymId/defend', auth.requireAuth, async (req, res) => {
  const { gymId } = req.params;
  const { pokemonId } = req.body;
  const userId = req.user.id;
  
  try {
    // 验证道馆可防守
    const gym = await db.query(`
      SELECT * FROM gyms WHERE id = $1 AND (team_id IS NULL OR prestige < 50000)
    `, [gymId]);
    
    if (gym.rows.length === 0) {
      return res.status(400).json({ error: '该道馆无法放置精灵防守' });
    }
    
    // 验证精灵归属
    const pokemon = await db.query(`
      SELECT * FROM pokemon WHERE id = $1 AND user_id = $2 AND current_hp > 0
    `, [pokemonId, userId]);
    
    if (pokemon.rows.length === 0) {
      return res.status(400).json({ error: '该精灵不可用' });
    }
    
    // 检查玩家是否已有精灵在该道馆
    const existing = await db.query(`
      SELECT COUNT(*) FROM gym_pokemon gp
      JOIN pokemon p ON gp.pokemon_id = p.id
      WHERE gp.gym_id = $1 AND p.user_id = $2
    `, [gymId, userId]);
    
    if (parseInt(existing.rows[0].count) > 0) {
      return res.status(400).json({ error: '您已在该道馆放置了精灵' });
    }
    
    // 计算位置
    const countResult = await db.query(`
      SELECT COUNT(*) FROM gym_pokemon WHERE gym_id = $1 AND is_active = true
    `, [gymId]);
    
    const position = parseInt(countResult.rows[0].count) + 1;
    
    // 放置精灵
    await db.query(`
      INSERT INTO gym_pokemon (gym_id, pokemon_id, position, placed_at, is_active)
      VALUES ($1, $2, $3, NOW(), true)
    `, [gymId, pokemonId, position]);
    
    // 更新道馆声望
    await db.query(`
      UPDATE gyms SET prestige = prestige + 2000 WHERE id = $1
    `, [gymId]);
    
    logger.info('Pokemon placed to defend gym', { gymId, pokemonId, userId, position });
    
    res.json({
      message: '精灵已放置在道馆中',
      gymId,
      pokemonId,
      position
    });
    
  } catch (error) {
    logger.error('Failed to place defender', { error: error.message, gymId, userId });
    res.status(500).json({ error: '放置精灵失败' });
  }
});

// 获取战斗回放
router.get('/battle/:battleId/replay', auth.requireAuth, async (req, res) => {
  const { battleId } = req.params;
  const userId = req.user.id;
  
  try {
    const battle = await db.query(`
      SELECT * FROM gym_battles WHERE id = $1 AND attacker_user_id = $2
    `, [battleId, userId]);
    
    if (battle.rows.length === 0) {
      return res.status(404).json({ error: '战斗记录不存在' });
    }
    
    const replay = await db.query(`
      SELECT * FROM battle_replays WHERE battle_id = $1 ORDER BY turn_number
    `, [battleId]);
    
    res.json({
      battle: battle.rows[0],
      replay: replay.rows
    });
    
  } catch (error) {
    logger.error('Failed to get battle replay', { error: error.message, battleId });
    res.status(500).json({ error: '获取回放失败' });
  }
});

module.exports = router;
```

### 4. 前端战斗组件

```javascript
// frontend/game-client/src/components/BattleScene.js

import React, { useState, useEffect, useCallback } from 'react';
import { battleApi } from '../api/battle';
import './BattleScene.css';

const BattleScene = ({ gymId, teamIds, onBattleEnd }) => {
  const [battleState, setBattleState] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedMove, setSelectedMove] = useState(null);
  const [battleLog, setBattleLog] = useState([]);
  const [currentHp, setCurrentHp] = useState({
    attacker: 0,
    defender: 0
  });

  // 开始战斗
  useEffect(() => {
    const startBattle = async () => {
      try {
        const response = await battleApi.startBattle(gymId, teamIds);
        setBattleState(response);
        setCurrentHp({
          attacker: response.attacker.currentPokemon.currentHp,
          defender: response.defender.currentPokemon.currentHp
        });
        setIsLoading(false);
      } catch (error) {
        console.error('Failed to start battle:', error);
      }
    };

    startBattle();
  }, [gymId, teamIds]);

  // 执行回合
  const executeTurn = useCallback(async (moveId) => {
    if (!battleState || isLoading) return;

    setIsLoading(true);
    setSelectedMove(moveId);

    try {
      const response = await battleApi.executeTurn(battleState.battleId, moveId);
      
      // 更新 HP
      if (response.actions) {
        for (const action of response.actions) {
          setBattleLog(prev => [...prev, action.message]);
        }
      }

      if (response.battleEnded) {
        setBattleState(prev => ({ ...prev, ended: true, result: response.battleResult }));
        onBattleEnd(response.battleResult);
      } else {
        // 更新当前精灵 HP
        setCurrentHp({
          attacker: battleState.attacker.currentPokemon.currentHp - response.damage.attacker,
          defender: battleState.defender.currentPokemon.currentHp - response.damage.defender
        });
      }
    } catch (error) {
      console.error('Failed to execute turn:', error);
    } finally {
      setIsLoading(false);
      setSelectedMove(null);
    }
  }, [battleState, isLoading, onBattleEnd]);

  // 切换精灵
  const switchPokemon = useCallback(async (pokemonId) => {
    try {
      const response = await battleApi.switchPokemon(battleState.battleId, pokemonId);
      setBattleState(prev => ({
        ...prev,
        attacker: {
          ...prev.attacker,
          currentPokemon: response.currentPokemon
        }
      }));
    } catch (error) {
      console.error('Failed to switch pokemon:', error);
    }
  }, [battleState]);

  // HP 条渲染
  const HpBar = ({ current, max, label }) => {
    const percentage = Math.max(0, (current / max) * 100);
    const color = percentage > 50 ? '#4CAF50' : percentage > 25 ? '#FFC107' : '#F44336';

    return (
      <div className="hp-bar-container">
        <span className="hp-label">{label}</span>
        <div className="hp-bar">
          <div className="hp-fill" style={{ width: `${percentage}%`, backgroundColor: color }} />
        </div>
        <span className="hp-text">{Math.max(0, current)} / {max}</span>
      </div>
    );
  };

  if (isLoading && !battleState) {
    return <div className="battle-loading">正在加载战斗...</div>;
  }

  if (!battleState) {
    return <div className="battle-error">战斗加载失败</div>;
  }

  if (battleState.ended) {
    return (
      <div className="battle-result">
        <h2>{battleState.result.result === 'win' ? '🎉 胜利！' : '💔 失败'}</h2>
        {battleState.result.rewards && (
          <div className="rewards">
            <p>声望: +{battleState.result.rewards.prestigeGained}</p>
            <p>经验: +{battleState.result.rewards.experienceGained}</p>
            <p>金币: +{battleState.result.rewards.coinsGained}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="battle-scene">
      {/* 道馆信息 */}
      <div className="gym-info">
        <h3>{battleState.gym.name}</h3>
        <p>声望: {battleState.gym.prestige}</p>
      </div>

      {/* 战斗场景 */}
      <div className="battle-field">
        {/* 防守方 */}
        <div className="defender-side">
          <HpBar
            current={currentHp.defender}
            max={battleState.defender.currentPokemon.maxHp}
            label={battleState.defender.currentPokemon.species}
          />
          <div className="pokemon-sprite defender">
            {/* 3D 精灵模型或精灵图 */}
            <img
              src={`/assets/pokemon/${battleState.defender.currentPokemon.id}.png`}
              alt={battleState.defender.currentPokemon.species}
            />
          </div>
        </div>

        {/* 攻击方 */}
        <div className="attacker-side">
          <div className="pokemon-sprite attacker">
            <img
              src={`/assets/pokemon/${battleState.attacker.currentPokemon.id}.png`}
              alt={battleState.attacker.currentPokemon.species}
            />
          </div>
          <HpBar
            current={currentHp.attacker}
            max={battleState.attacker.currentPokemon.maxHp}
            label={battleState.attacker.currentPokemon.species}
          />
        </div>
      </div>

      {/* 战斗日志 */}
      <div className="battle-log">
        {battleLog.slice(-5).map((log, index) => (
          <p key={index}>{log}</p>
        ))}
      </div>

      {/* 技能选择 */}
      <div className="move-selection">
        <h4>选择技能</h4>
        <div className="moves-grid">
          {battleState.attacker.currentPokemon.moves.map(move => (
            <button
              key={move.id}
              className={`move-button type-${move.type}`}
              onClick={() => executeTurn(move.id)}
              disabled={isLoading || selectedMove === move.id}
            >
              <span className="move-name">{move.name}</span>
              <span className="move-info">
                威力: {move.power || '-'} | 命中: {move.accuracy || 100}%
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 队伍状态 */}
      <div className="team-status">
        {battleState.attacker.team.map((pokemon, index) => (
          <div
            key={pokemon.id}
            className={`team-pokemon ${pokemon.id === battleState.attacker.currentPokemon.id ? 'active' : ''} ${pokemon.currentHp <= 0 ? 'fainted' : ''}`}
            onClick={() => pokemon.currentHp > 0 && switchPokemon(pokemon.id)}
          >
            <img src={`/assets/pokemon/${pokemon.id}.png`} alt={pokemon.species} />
            <div className="quick-hp">
              <div className="quick-hp-bar" style={{ width: `${(pokemon.currentHp / pokemon.maxHp) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default BattleScene;
```

### 5. Prometheus 指标

```javascript
// backend/services/gym-service/src/metrics.js

const client = require('prom-client');

// 战斗相关指标
const gymBattleStartTotal = new client.Counter({
  name: 'gym_battle_start_total',
  help: 'Total number of gym battles started',
  labelNames: ['gym_id']
});

const gymBattleWinTotal = new client.Counter({
  name: 'gym_battle_win_total',
  help: 'Total number of gym battles won',
  labelNames: ['gym_id']
});

const gymBattleLoseTotal = new client.Counter({
  name: 'gym_battle_lose_total',
  help: 'Total number of gym battles lost',
  labelNames: ['gym_id']
});

const gymBattleTurnTotal = new client.Counter({
  name: 'gym_battle_turn_total',
  help: 'Total number of battle turns executed'
});

const gymBattleDuration = new client.Histogram({
  name: 'gym_battle_duration_seconds',
  help: 'Duration of gym battles in seconds',
  buckets: [30, 60, 120, 180, 300, 600]
});

const gymBattleActiveCount = new client.Gauge({
  name: 'gym_battle_active_count',
  help: 'Number of currently active gym battles'
});

const pokemonDefendingCount = new client.Gauge({
  name: 'pokemon_defending_count',
  help: 'Total number of pokemon currently defending gyms',
  labelNames: ['team_id']
});

module.exports = {
  gymBattleStartTotal,
  gymBattleWinTotal,
  gymBattleLoseTotal,
  gymBattleTurnTotal,
  gymBattleDuration,
  gymBattleActiveCount,
  pokemonDefendingCount
};
```

## 验收标准

- [ ] 玩家可以选择 1-6 只精灵组成战斗队伍挑战道馆
- [ ] 回合制战斗系统正确计算属性克制、伤害、暴击
- [ ] 状态效果（灼伤、麻痹、冰冻、中毒、睡眠、混乱）正常生效
- [ ] 防守方 AI 能智能选择最优技能
- [ ] 战斗胜利后正确发放奖励（声望、经验、金币）
- [ ] 玩家可以在道馆放置精灵防守
- [ ] 战斗回放功能正常工作
- [ ] 所有 API 端点有完整的单元测试
- [ ] 前端战斗 UI 正确显示 HP、技能选择、战斗日志
- [ ] Prometheus 指标正确记录战斗统计
- [ ] 战斗超时自动清理机制正常工作

## 影响范围

- `backend/services/gym-service/src/battleEngine.js` - 战斗引擎核心模块
- `backend/services/gym-service/src/routes/battle.js` - 战斗 API 路由
- `backend/services/gym-service/src/metrics.js` - 战斗指标
- `frontend/game-client/src/components/BattleScene.js` - 前端战斗组件
- `frontend/game-client/src/api/battle.js` - 战斗 API 客户端
- `frontend/game-client/src/styles/BattleScene.css` - 战斗场景样式
- `database/pending/20260609_160000__add_gym_battle_system.sql` - 数据库迁移
- `backend/tests/unit/gym-battle.test.js` - 单元测试

## 参考

- [Pokémon Battle Mechanics](https://bulbapedia.bulbagarden.net/wiki/Battle)
- [Type Chart](https://bulbapedia.bulbagarden.net/wiki/Type)
- [Status Conditions](https://bulbapedia.bulbagarden.net/wiki/Status_condition)
