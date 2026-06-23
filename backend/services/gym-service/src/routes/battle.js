/**
 * REQ-00054: 道馆战斗系统 - 战斗 API 路由
 * 创建时间: 2026-06-09 16:00
 * 
 * API 端点:
 * - POST /gym/:gymId/battle/start - 开始战斗
 * - POST /battle/:battleId/turn - 执行回合
 * - POST /battle/:battleId/switch - 切换精灵
 * - POST /gym/:gymId/defend - 放置精灵防守
 * - GET /battle/:battleId/replay - 获取战斗回放
 * - GET /battle/teams - 获取战斗队伍预设
 * - POST /battle/teams - 创建战斗队伍预设
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../../../shared/db');
const { BattleEngine } = require('../battleEngine');
const cache = require('../../../../shared/cache');
const metrics = require('../../../../shared/metrics');
const logger = require('../../../../shared/logger');
const auth = require('../../../../shared/auth');

// 活跃战斗缓存（10分钟 TTL）
const activeBattles = new Map();
const BATTLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * POST /gym/:gymId/battle/start
 * 开始道馆战斗
 */
router.post('/gym/:gymId/battle/start', auth.requireAuth, async (req, res) => {
  const { gymId } = req.params;
  const { teamIds } = req.body;
  const userId = req.user.id;
  
  const timer = metrics.gymBattleDuration.startTimer();
  
  try {
    metrics.gymBattleStartTotal.inc();
    
    // 验证精灵队伍
    if (!teamIds || teamIds.length === 0 || teamIds.length > 6) {
      return res.status(400).json({ error: '请选择 1-6 只精灵组成战斗队伍' });
    }
    
    // 获取道馆信息
    const gymResult = await db.query(`
      SELECT g.id, g.name, g.prestige, g.team_id,
             gp.pokemon_id, gp.position
      FROM gyms g
      LEFT JOIN gym_pokemon gp ON g.id = gp.gym_id AND gp.is_active = true
      WHERE g.id = $1
      ORDER BY gp.position
    `, [gymId]);
    
    if (gymResult.rows.length === 0) {
      return res.status(404).json({ error: '道馆不存在' });
    }
    
    const gym = gymResult.rows[0];
    const defenderPokemonIds = gymResult.rows
      .filter(r => r.pokemon_id)
      .map(r => r.pokemon_id);
    
    if (defenderPokemonIds.length === 0) {
      return res.status(400).json({ error: '该道馆没有防守精灵' });
    }
    
    // 获取玩家精灵队伍
    const teamResult = await db.query(`
      SELECT p.*, 
             COALESCE(json_agg(
               json_build_object(
                 'id', m.id,
                 'name', m.name,
                 'type', m.type,
                 'power', m.power,
                 'accuracy', m.accuracy,
                 'category', m.category,
                 'priority', m.priority,
                 'status_effect', m.status_effect,
                 'status_chance', m.status_chance
               )
             ) FILTER (WHERE m.id IS NOT NULL), '[]') as moves
      FROM pokemon p
      LEFT JOIN pokemon_moves pm ON p.id = pm.pokemon_id
      LEFT JOIN moves m ON pm.move_id = m.id
      WHERE p.id = ANY($1) AND p.user_id = $2 AND p.current_hp > 0
      GROUP BY p.id
    `, [teamIds, userId]);
    
    if (teamResult.rows.length !== teamIds.length) {
      return res.status(400).json({ error: '部分精灵不可用或已阵亡' });
    }
    
    // 获取防守精灵详情
    const defenderResult = await db.query(`
      SELECT p.*, 
             COALESCE(json_agg(
               json_build_object(
                 'id', m.id,
                 'name', m.name,
                 'type', m.type,
                 'power', m.power,
                 'accuracy', m.accuracy,
                 'category', m.category,
                 'priority', m.priority,
                 'status_effect', m.status_effect,
                 'status_chance', m.status_chance
               )
             ) FILTER (WHERE m.id IS NOT NULL), '[]') as moves
      FROM pokemon p
      LEFT JOIN pokemon_moves pm ON p.id = pm.pokemon_id
      LEFT JOIN moves m ON pm.move_id = m.id
      WHERE p.id = ANY($1)
      GROUP BY p.id
      ORDER BY array_position($1, p.id)
    `, [defenderPokemonIds]);
    
    // 创建战斗实例
    const battleId = uuidv4();
    const battle = new BattleEngine(
      battleId,
      gymId,
      userId,
      defenderPokemonIds[0]
    );
    
    // 设置攻击方队伍
    battle.attacker.team = teamResult.rows.map(p => ({
      ...p,
      max_hp: p.hp,
      current_hp: p.current_hp,
      types: p.types || ['normal'],
      attack: p.attack || 100,
      defense: p.defense || 100,
      special_attack: p.special_attack || 100,
      special_defense: p.special_defense || 100,
      speed: p.speed || 100,
      moves: p.moves || []
    }));
    battle.attacker.currentPokemon = battle.attacker.team[0];
    
    // 设置防守方队伍
    battle.defender.team = defenderResult.rows.map(p => ({
      ...p,
      max_hp: p.hp,
      current_hp: p.hp,
      types: p.types || ['normal'],
      attack: p.attack || 100,
      defense: p.defense || 100,
      special_attack: p.special_attack || 100,
      special_defense: p.special_defense || 100,
      speed: p.speed || 100,
      moves: p.moves || []
    }));
    battle.defender.currentPokemon = battle.defender.team[0];
    battle.defender.currentDefenderIndex = 0;
    
    // 缓存战斗实例
    activeBattles.set(battleId, battle);
    
    // 设置超时清理
    setTimeout(() => {
      if (activeBattles.has(battleId)) {
        const expiredBattle = activeBattles.get(battleId);
        activeBattles.delete(battleId);
        metrics.gymBattleTimeoutTotal.inc();
        logger.warn('Battle timeout', { battleId, gymId, userId });
      }
    }, BATTLE_TIMEOUT_MS);
    
    logger.info('Battle started', { 
      battleId, 
      gymId, 
      userId, 
      teamSize: teamResult.rows.length,
      defenderSize: defenderResult.rows.length 
    });
    
    metrics.gymBattleActiveCount.inc();
    
    res.json({
      battleId,
      attacker: {
        currentPokemon: {
          id: battle.attacker.currentPokemon.id,
          species: battle.attacker.currentPokemon.species,
          level: battle.attacker.currentPokemon.level,
          currentHp: battle.attacker.currentPokemon.current_hp,
          maxHp: battle.attacker.currentPokemon.max_hp,
          types: battle.attacker.currentPokemon.types,
          moves: battle.attacker.currentPokemon.moves
        },
        team: battle.attacker.team.map(p => ({
          id: p.id,
          species: p.species,
          level: p.level,
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
          maxHp: battle.defender.currentPokemon.max_hp,
          types: battle.defender.currentPokemon.types
        },
        teamSize: battle.defender.team.length
      },
      gym: {
        id: gym.id,
        name: gym.name,
        prestige: gym.prestige
      }
    });
    
  } catch (error) {
    logger.error('Failed to start battle', { error: error.message, stack: error.stack, gymId, userId });
    metrics.gymBattleStartErrorTotal.inc();
    res.status(500).json({ error: '开始战斗失败' });
  } finally {
    timer();
  }
});

/**
 * POST /battle/:battleId/turn
 * 执行战斗回合
 */
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
    
    metrics.gymBattleTurnTotal.inc();
    
    // 战斗结束
    if (turnResult.battleEnded) {
      const result = battle.getBattleResult();
      activeBattles.delete(battleId);
      metrics.gymBattleActiveCount.dec();
      
      // 保存战斗记录
      await saveBattleRecord(battle, result, userId);
      
      // 更新精灵 HP 和统计
      await updatePokemonAfterBattle(battle, result);
      
      if (result.result === 'win') {
        metrics.gymBattleWinTotal.inc();
        
        // 更新道馆声望
        await db.query(`
          UPDATE gyms 
          SET prestige = GREATEST(0, prestige - $1)
          WHERE id = $2
        `, [result.rewards.prestigeGained, battle.gymId]);
        
        // 发放奖励
        await db.query(`
          UPDATE users 
          SET experience = experience + $1,
              coins = coins + $2
          WHERE id = $3
        `, [result.rewards.experienceGained, result.rewards.coinsGained, userId]);
        
        logger.info('Battle won', { 
          battleId, 
          gymId: battle.gymId, 
          userId, 
          turns: result.turns,
          rewards: result.rewards 
        });
      } else {
        metrics.gymBattleLoseTotal.inc();
        logger.info('Battle lost', { battleId, gymId: battle.gymId, userId, turns: result.turns });
      }
      
      return res.json({ ...turnResult, battleResult: result });
    }
    
    // 防守方精灵被击败，切换下一只
    if (turnResult.defenderFainted && turnResult.nextDefender) {
      logger.info('Defender fainted, switching', { 
        battleId, 
        nextDefender: turnResult.nextDefender.species 
      });
    }
    
    // 攻击方精灵被击败，需要切换
    if (turnResult.attackerFainted && turnResult.nextPokemon) {
      logger.info('Attacker fainted, switching', { 
        battleId, 
        nextPokemon: turnResult.nextPokemon.species 
      });
    }
    
    res.json(turnResult);
    
  } catch (error) {
    logger.error('Failed to execute turn', { error: error.message, stack: error.stack, battleId, userId });
    metrics.gymBattleTurnErrorTotal.inc();
    res.status(500).json({ error: '执行回合失败' });
  }
});

/**
 * POST /battle/:battleId/switch
 * 切换精灵
 */
router.post('/battle/:battleId/switch', auth.requireAuth, async (req, res) => {
  const { battleId } = req.params;
  const { pokemonId } = req.body;
  const userId = req.user.id;
  
  try {
    const battle = activeBattles.get(battleId);
    
    if (!battle) {
      return res.status(404).json({ error: '战斗不存在或已过期' });
    }
    
    if (battle.attacker.userId !== userId) {
      return res.status(403).json({ error: '无权操作此战斗' });
    }
    
    const pokemon = battle.attacker.team.find(p => p.id === pokemonId);
    
    if (!pokemon) {
      return res.status(400).json({ error: '该精灵不在队伍中' });
    }
    
    if (pokemon.current_hp <= 0) {
      return res.status(400).json({ error: '该精灵已阵亡，无法切换' });
    }
    
    battle.attacker.currentPokemon = pokemon;
    
    logger.info('Pokemon switched', { battleId, userId, pokemonId: pokemon.id, species: pokemon.species });
    
    res.json({
      message: '切换成功',
      currentPokemon: {
        id: pokemon.id,
        species: pokemon.species,
        level: pokemon.level,
        currentHp: pokemon.current_hp,
        maxHp: pokemon.max_hp,
        types: pokemon.types,
        moves: pokemon.moves
      }
    });
    
  } catch (error) {
    logger.error('Failed to switch pokemon', { error: error.message, battleId, userId });
    res.status(500).json({ error: '切换精灵失败' });
  }
});

/**
 * POST /gym/:gymId/defend
 * 放置精灵防守道馆
 */
router.post('/gym/:gymId/defend', auth.requireAuth, async (req, res) => {
  const { gymId } = req.params;
  const { pokemonId } = req.body;
  const userId = req.user.id;
  
  try {
    // 验证道馆可防守
    const gymResult = await db.query(`
      SELECT * FROM gyms 
      WHERE id = $1 AND (team_id IS NULL OR prestige < 50000)
    `, [gymId]);
    
    if (gymResult.rows.length === 0) {
      return res.status(400).json({ error: '该道馆无法放置精灵防守' });
    }
    
    // 验证精灵归属
    const pokemonResult = await db.query(`
      SELECT * FROM pokemon 
      WHERE id = $1 AND user_id = $2 AND current_hp > 0
    `, [pokemonId, userId]);
    
    if (pokemonResult.rows.length === 0) {
      return res.status(400).json({ error: '该精灵不可用' });
    }
    
    // 检查玩家是否已有精灵在该道馆
    const existingResult = await db.query(`
      SELECT COUNT(*) as count
      FROM gym_pokemon gp
      JOIN pokemon p ON gp.pokemon_id = p.id
      WHERE gp.gym_id = $1 AND p.user_id = $2 AND gp.is_active = true
    `, [gymId, userId]);
    
    if (parseInt(existingResult.rows[0].count) > 0) {
      return res.status(400).json({ error: '您已在该道馆放置了精灵' });
    }
    
    // 计算位置
    const countResult = await db.query(`
      SELECT COUNT(*) as count
      FROM gym_pokemon 
      WHERE gym_id = $1 AND is_active = true
    `, [gymId]);
    
    const position = parseInt(countResult.rows[0].count) + 1;
    
    // 放置精灵（使用事务）
    await db.query('BEGIN');
    
    try {
      // 插入防守记录
      await db.query(`
        INSERT INTO gym_pokemon (gym_id, pokemon_id, position, placed_at, is_active)
        VALUES ($1, $2, $3, NOW(), true)
      `, [gymId, pokemonId, position]);
      
      // 更新道馆声望
      await db.query(`
        UPDATE gyms 
        SET prestige = prestige + 2000
        WHERE id = $1
      `, [gymId]);
      
      await db.query('COMMIT');
      
      metrics.pokemonDefendingCount.inc();
      
      logger.info('Pokemon placed to defend gym', { 
        gymId, 
        pokemonId, 
        userId, 
        position,
        species: pokemonResult.rows[0].species
      });
      
      res.json({
        message: '精灵已放置在道馆中',
        gymId,
        pokemonId,
        position,
        prestigeGained: 2000
      });
      
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    
  } catch (error) {
    logger.error('Failed to place defender', { error: error.message, stack: error.stack, gymId, userId });
    res.status(500).json({ error: '放置精灵失败' });
  }
});

/**
 * GET /battle/:battleId/replay
 * 获取战斗回放
 */
router.get('/battle/:battleId/replay', auth.requireAuth, async (req, res) => {
  const { battleId } = req.params;
  const userId = req.user.id;
  
  try {
    // 查询战斗记录
    const battleResult = await db.query(`
      SELECT * FROM gym_battles 
      WHERE id = $1 AND attacker_user_id = $2
    `, [battleId, userId]);
    
    if (battleResult.rows.length === 0) {
      return res.status(404).json({ error: '战斗记录不存在' });
    }
    
    // 查询回放数据
    const replayResult = await db.query(`
      SELECT * FROM battle_replays 
      WHERE battle_id = $1 
      ORDER BY turn_number
    `, [battleId]);
    
    logger.info('Battle replay retrieved', { battleId, userId });
    
    res.json({
      battle: battleResult.rows[0],
      replay: replayResult.rows
    });
    
  } catch (error) {
    logger.error('Failed to get battle replay', { error: error.message, battleId, userId });
    res.status(500).json({ error: '获取回放失败' });
  }
});

/**
 * GET /battle/teams
 * 获取玩家的战斗队伍预设
 */
router.get('/battle/teams', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const result = await db.query(`
      SELECT bt.*, 
             json_agg(
               json_build_object(
                 'id', p.id,
                 'species', p.species,
                 'level', p.level,
                 'currentHp', p.current_hp,
                 'maxHp', p.hp
               )
             ) as pokemon_details
      FROM battle_teams bt
      LEFT JOIN pokemon p ON p.id = ANY(bt.pokemon_ids)
      WHERE bt.user_id = $1
      GROUP BY bt.id
      ORDER BY bt.is_default DESC, bt.created_at DESC
    `, [userId]);
    
    res.json({ teams: result.rows });
    
  } catch (error) {
    logger.error('Failed to get battle teams', { error: error.message, userId });
    res.status(500).json({ error: '获取战斗队伍失败' });
  }
});

/**
 * POST /battle/teams
 * 创建战斗队伍预设
 */
router.post('/battle/teams', auth.requireAuth, async (req, res) => {
  const { name, pokemonIds, isDefault } = req.body;
  const userId = req.user.id;
  
  try {
    if (!name || !pokemonIds || pokemonIds.length === 0 || pokemonIds.length > 6) {
      return res.status(400).json({ error: '队伍名称和 1-6 只精灵为必填项' });
    }
    
    // 如果设为默认，取消其他默认队伍
    if (isDefault) {
      await db.query(`
        UPDATE battle_teams 
        SET is_default = false
        WHERE user_id = $1
      `, [userId]);
    }
    
    const result = await db.query(`
      INSERT INTO battle_teams (user_id, name, pokemon_ids, is_default)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [userId, name, pokemonIds, isDefault || false]);
    
    logger.info('Battle team created', { userId, teamId: result.rows[0].id, name });
    
    res.json({
      message: '战斗队伍创建成功',
      team: result.rows[0]
    });
    
  } catch (error) {
    logger.error('Failed to create battle team', { error: error.message, userId });
    res.status(500).json({ error: '创建战斗队伍失败' });
  }
});

/**
 * 保存战斗记录
 */
async function saveBattleRecord(battle, result, userId) {
  try {
    // 插入战斗记录
    await db.query(`
      INSERT INTO gym_battles (
        id, gym_id, attacker_user_id, attacker_team,
        defender_pokemon_id, result, prestige_gained,
        experience_gained, coins_gained, battle_duration_ms,
        turns_played, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    `, [
      battle.battleId,
      battle.gymId,
      userId,
      battle.attacker.team.map(p => p.id),
      battle.defender.currentPokemon?.id,
      result.result,
      result.rewards?.prestigeGained || 0,
      result.rewards?.experienceGained || 0,
      result.rewards?.coinsGained || 0,
      result.duration,
      result.turns
    ]);
    
    // 插入回放数据
    for (const turn of result.replay) {
      await db.query(`
        INSERT INTO battle_replays (
          battle_id, turn_number, status_effects, action_log
        ) VALUES ($1, $2, $3, $4)
      `, [
        battle.battleId,
        turn.turn,
        JSON.stringify(turn.statusEffects || []),
        JSON.stringify(turn.actions || [])
      ]);
    }
    
  } catch (error) {
    logger.error('Failed to save battle record', { 
      error: error.message, 
      battleId: battle.battleId 
    });
    throw error;
  }
}

/**
 * 更新精灵状态和统计
 */
async function updatePokemonAfterBattle(battle, result) {
  try {
    // 更新攻击方精灵 HP
    for (const pokemon of battle.attacker.team) {
      await db.query(`
        UPDATE pokemon 
        SET current_hp = $1
        WHERE id = $2
      `, [Math.max(0, pokemon.current_hp), pokemon.id]);
      
      // 更新战斗统计
      await db.query(`
        INSERT INTO pokemon_battle_stats (pokemon_id, battles_won, battles_lost)
        VALUES ($1, $2, $3)
        ON CONFLICT (pokemon_id)
        DO UPDATE SET
          battles_won = pokemon_battle_stats.battles_won + $2,
          battles_lost = pokemon_battle_stats.battles_lost + $3,
          updated_at = NOW()
      `, [
        pokemon.id,
        result.result === 'win' ? 1 : 0,
        result.result === 'lose' ? 1 : 0
      ]);
    }
    
  } catch (error) {
    logger.error('Failed to update pokemon after battle', { 
      error: error.message, 
      battleId: battle.battleId 
    });
    throw error;
  }
}

module.exports = router;
