/**
 * REQ-00019: 精灵技能学习与技能机器系统
 * 技能管理服务模块
 */

const { query, transaction } = require('../../../shared/db');
const logger = require('../../../shared/logger');

class MoveService {
  /**
   * 获取技能列表
   * @param {Object} filters - 筛选条件
   * @param {string} [filters.type] - 属性类型
   * @param {string} [filters.category] - 技能类别 (FAST/CHARGE)
   * @param {number} [filters.limit] - 分页限制
   * @param {number} [filters.offset] - 分页偏移
   */
  async getMoves(filters = {}) {
    const { type, category, limit = 50, offset = 0 } = filters;
    
    let sql = 'SELECT * FROM moves WHERE 1=1';
    const params = [];
    
    if (type) {
      params.push(type.toUpperCase());
      sql += ` AND type = $${params.length}`;
    }
    
    if (category) {
      params.push(category.toUpperCase());
      sql += ` AND category = $${params.length}`;
    }
    
    // 获取总数
    const countResult = await query(sql.replace('SELECT *', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);
    
    // 获取分页数据
    params.push(limit, offset);
    sql += ` ORDER BY category, name_zh LIMIT $${params.length - 1} OFFSET $${params.length}`;
    
    const result = await query(sql, params);
    
    return {
      moves: result.rows,
      total,
      limit,
      offset
    };
  }
  
  /**
   * 获取技能详情
   * @param {string} moveId - 技能ID
   */
  async getMoveById(moveId) {
    const result = await query('SELECT * FROM moves WHERE id = $1', [moveId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  }
  
  /**
   * 获取精灵技能栏
   * @param {number} userId - 用户ID
   * @param {number} pokemonInstanceId - 精灵实例ID
   */
  async getPokemonMoves(userId, pokemonInstanceId) {
    // 验证精灵所有权
    const pokemonResult = await query(`
      SELECT 
        pi.id,
        pi.species_id,
        pi.fast_move,
        pi.charge_move,
        pi.learned_fast_moves,
        pi.learned_charge_moves,
        ps.name_zh as species_name
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = $1 AND pi.user_id = $2
    `, [pokemonInstanceId, userId]);
    
    if (pokemonResult.rows.length === 0) {
      throw new Error('Pokemon not found or not owned by user');
    }
    
    const pokemon = pokemonResult.rows[0];
    
    // 获取该种族可学习的技能
    const learnsetResult = await query(`
      SELECT 
        pm.move_id,
        pm.learn_method,
        pm.tm_id,
        m.name_zh,
        m.name_en,
        m.type,
        m.category,
        m.power,
        m.energy_delta
      FROM pokemon_moves pm
      JOIN moves m ON pm.move_id = m.id
      WHERE pm.species_id = $1
      ORDER BY m.category, m.name_zh
    `, [pokemon.species_id]);
    
    // 获取已学技能详情
    const learnedFastMoves = pokemon.learned_fast_moves || [];
    const learnedChargeMoves = pokemon.learned_charge_moves || [];
    
    const allLearnedMoves = [...learnedFastMoves, ...learnedChargeMoves];
    let learnedMovesDetails = [];
    
    if (allLearnedMoves.length > 0) {
      const learnedResult = await query(`
        SELECT * FROM moves WHERE id = ANY($1)
      `, [allLearnedMoves]);
      learnedMovesDetails = learnedResult.rows;
    }
    
    // 计算可学习但未学的技能
    const learnedSet = new Set(allLearnedMoves);
    const availableMoves = learnsetResult.rows.filter(m => !learnedSet.has(m.move_id));
    
    return {
      pokemonId: pokemon.id,
      speciesId: pokemon.species_id,
      speciesName: pokemon.species_name,
      currentFastMove: pokemon.fast_move,
      currentChargeMove: pokemon.charge_move,
      learnedFastMoves: learnedMovesDetails.filter(m => m.category === 'FAST'),
      learnedChargeMoves: learnedMovesDetails.filter(m => m.category === 'CHARGE'),
      availableMoves,
      canLearnMore: {
        fast: learnedFastMoves.length < 2,
        charge: learnedChargeMoves.length < 4
      }
    };
  }
  
  /**
   * 学习新技能
   * @param {number} userId - 用户ID
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {string} tmId - TM ID
   * @param {string} [forgetMoveId] - 需要遗忘的技能ID
   */
  async learnMove(userId, pokemonInstanceId, tmId, forgetMoveId = null) {
    return await transaction(async (client) => {
      // 1. 验证 TM 是否在玩家背包
      const tmResult = await client.query(`
        SELECT ti.*, tm.move_id, tm.is_elite
        FROM tm_inventory ti
        JOIN technical_machines tm ON ti.tm_id = tm.id
        WHERE ti.user_id = $1 AND ti.tm_id = $2 AND ti.quantity > 0
      `, [userId, tmId]);
      
      if (tmResult.rows.length === 0) {
        throw new Error('TM not found in inventory');
      }
      
      const tm = tmResult.rows[0];
      const moveId = tm.move_id;
      
      // 2. 获取技能信息
      const moveResult = await client.query(`
        SELECT * FROM moves WHERE id = $1
      `, [moveId]);
      
      if (moveResult.rows.length === 0) {
        throw new Error('Move not found');
      }
      
      const move = moveResult.rows[0];
      
      // 3. 验证精灵所有权
      const pokemonResult = await client.query(`
        SELECT * FROM pokemon_instances WHERE id = $1 AND user_id = $2
      `, [pokemonInstanceId, userId]);
      
      if (pokemonResult.rows.length === 0) {
        throw new Error('Pokemon not found or not owned by user');
      }
      
      const pokemon = pokemonResult.rows[0];
      
      // 4. 验证精灵是否可学习该技能
      const canLearnResult = await client.query(`
        SELECT * FROM pokemon_moves
        WHERE species_id = $1 AND move_id = $2
      `, [pokemon.species_id, moveId]);
      
      if (canLearnResult.rows.length === 0) {
        throw new Error('This pokemon cannot learn this move');
      }
      
      const learnMethod = canLearnResult.rows[0].learn_method;
      
      // 检查是否需要精英 TM
      if (learnMethod === 'LEGACY' && !tm.is_elite) {
        throw new Error('This move requires an Elite TM to learn');
      }
      
      // 5. 检查是否已经学会该技能
      const learnedFast = pokemon.learned_fast_moves || [];
      const learnedCharge = pokemon.learned_charge_moves || [];
      
      if (learnedFast.includes(moveId) || learnedCharge.includes(moveId)) {
        throw new Error('Pokemon already knows this move');
      }
      
      // 6. 检查技能栏是否已满
      const targetArray = move.category === 'FAST' ? learnedFast : learnedCharge;
      const maxSlots = move.category === 'FAST' ? 2 : 4;
      
      if (targetArray.length >= maxSlots) {
        if (!forgetMoveId) {
          throw new Error(`Move slot is full. Must forget a ${move.category === 'FAST' ? 'fast' : 'charge'} move`);
        }
        
        // 验证遗忘的技能
        if (!targetArray.includes(forgetMoveId)) {
          throw new Error('Move to forget is not in the learned moves');
        }
        
        // 不能遗忘当前使用的技能
        if (
          (move.category === 'FAST' && pokemon.fast_move === forgetMoveId) ||
          (move.category === 'CHARGE' && pokemon.charge_move === forgetMoveId)
        ) {
          throw new Error('Cannot forget currently equipped move');
        }
        
        // 移除遗忘的技能
        const newArray = targetArray.filter(id => id !== forgetMoveId);
        newArray.push(moveId);
        
        if (move.category === 'FAST') {
          await client.query(`
            UPDATE pokemon_instances
            SET learned_fast_moves = $1
            WHERE id = $2
          `, [newArray, pokemonInstanceId]);
        } else {
          await client.query(`
            UPDATE pokemon_instances
            SET learned_charge_moves = $1
            WHERE id = $2
          `, [newArray, pokemonInstanceId]);
        }
      } else {
        // 技能栏未满，直接添加
        if (move.category === 'FAST') {
          await client.query(`
            UPDATE pokemon_instances
            SET learned_fast_moves = array_append(learned_fast_moves, $1)
            WHERE id = $2
          `, [moveId, pokemonInstanceId]);
        } else {
          await client.query(`
            UPDATE pokemon_instances
            SET learned_charge_moves = array_append(learned_charge_moves, $1)
            WHERE id = $2
          `, [moveId, pokemonInstanceId]);
        }
      }
      
      // 7. 扣除 TM
      if (tm.quantity > 1) {
        await client.query(`
          UPDATE tm_inventory SET quantity = quantity - 1
          WHERE user_id = $1 AND tm_id = $2
        `, [userId, tmId]);
      } else {
        await client.query(`
          DELETE FROM tm_inventory
          WHERE user_id = $1 AND tm_id = $2
        `, [userId, tmId]);
      }
      
      logger.info('Move learned', {
        userId,
        pokemonInstanceId,
        moveId,
        tmId,
        forgotMove: forgetMoveId
      });
      
      return {
        success: true,
        moveId,
        moveName: move.name_zh,
        forgotMove: forgetMoveId
      };
    });
  }
  
  /**
   * 切换技能
   * @param {number} userId - 用户ID
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {string} [fastMoveId] - 快速技能ID
   * @param {string} [chargeMoveId] - 蓄力技能ID
   */
  async switchMove(userId, pokemonInstanceId, fastMoveId = null, chargeMoveId = null) {
    return await transaction(async (client) => {
      // 验证精灵所有权
      const pokemonResult = await client.query(`
        SELECT * FROM pokemon_instances WHERE id = $1 AND user_id = $2
      `, [pokemonInstanceId, userId]);
      
      if (pokemonResult.rows.length === 0) {
        throw new Error('Pokemon not found or not owned by user');
      }
      
      const pokemon = pokemonResult.rows[0];
      const updates = [];
      const params = [];
      
      if (fastMoveId) {
        // 验证快速技能是否在已学列表中
        const learnedFast = pokemon.learned_fast_moves || [];
        if (!learnedFast.includes(fastMoveId)) {
          throw new Error('Fast move not in learned moves');
        }
        params.push(fastMoveId);
        updates.push(`fast_move = $${params.length}`);
      }
      
      if (chargeMoveId) {
        // 验证蓄力技能是否在已学列表中
        const learnedCharge = pokemon.learned_charge_moves || [];
        if (!learnedCharge.includes(chargeMoveId)) {
          throw new Error('Charge move not in learned moves');
        }
        params.push(chargeMoveId);
        updates.push(`charge_move = $${params.length}`);
      }
      
      if (updates.length === 0) {
        throw new Error('No move specified to switch');
      }
      
      params.push(pokemonInstanceId);
      await client.query(`
        UPDATE pokemon_instances
        SET ${updates.join(', ')}
        WHERE id = $${params.length}
      `, params);
      
      logger.info('Move switched', {
        userId,
        pokemonInstanceId,
        fastMoveId,
        chargeMoveId
      });
      
      return {
        success: true,
        fastMove: fastMoveId || pokemon.fast_move,
        chargeMove: chargeMoveId || pokemon.charge_move
      };
    });
  }
  
  /**
   * 遗忘技能
   * @param {number} userId - 用户ID
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {string} moveId - 技能ID
   */
  async forgetMove(userId, pokemonInstanceId, moveId) {
    return await transaction(async (client) => {
      // 验证精灵所有权
      const pokemonResult = await client.query(`
        SELECT * FROM pokemon_instances WHERE id = $1 AND user_id = $2
      `, [pokemonInstanceId, userId]);
      
      if (pokemonResult.rows.length === 0) {
        throw new Error('Pokemon not found or not owned by user');
      }
      
      const pokemon = pokemonResult.rows[0];
      
      // 获取技能信息
      const moveResult = await client.query(`
        SELECT * FROM moves WHERE id = $1
      `, [moveId]);
      
      if (moveResult.rows.length === 0) {
        throw new Error('Move not found');
      }
      
      const move = moveResult.rows[0];
      
      // 不能遗忘当前使用的技能
      if (
        (move.category === 'FAST' && pokemon.fast_move === moveId) ||
        (move.category === 'CHARGE' && pokemon.charge_move === moveId)
      ) {
        throw new Error('Cannot forget currently equipped move');
      }
      
      // 检查技能是否在已学列表中
      if (move.category === 'FAST') {
        const learnedFast = pokemon.learned_fast_moves || [];
        if (!learnedFast.includes(moveId)) {
          throw new Error('Move not in learned fast moves');
        }
        
        const newArray = learnedFast.filter(id => id !== moveId);
        await client.query(`
          UPDATE pokemon_instances
          SET learned_fast_moves = $1
          WHERE id = $2
        `, [newArray, pokemonInstanceId]);
      } else {
        const learnedCharge = pokemon.learned_charge_moves || [];
        if (!learnedCharge.includes(moveId)) {
          throw new Error('Move not in learned charge moves');
        }
        
        const newArray = learnedCharge.filter(id => id !== moveId);
        await client.query(`
          UPDATE pokemon_instances
          SET learned_charge_moves = $1
          WHERE id = $2
        `, [newArray, pokemonInstanceId]);
      }
      
      logger.info('Move forgotten', {
        userId,
        pokemonInstanceId,
        moveId
      });
      
      return {
        success: true,
        moveId
      };
    });
  }
  
  /**
   * 获取种族可学习技能列表
   * @param {number} speciesId - 种族ID
   */
  async getSpeciesLearnset(speciesId) {
    const result = await query(`
      SELECT 
        pm.move_id,
        pm.learn_method,
        pm.tm_id,
        m.name_zh,
        m.name_en,
        m.type,
        m.category,
        m.power,
        m.energy_delta,
        m.is_legacy
      FROM pokemon_moves pm
      JOIN moves m ON pm.move_id = m.id
      WHERE pm.species_id = $1
      ORDER BY m.category, m.name_zh
    `, [speciesId]);
    
    return {
      speciesId,
      moves: result.rows
    };
  }
  
  /**
   * 获取玩家 TM 背包
   * @param {number} userId - 用户ID
   */
  async getTMInventory(userId) {
    const result = await query(`
      SELECT 
        ti.tm_id,
        ti.quantity,
        ti.obtained_at,
        tm.move_id,
        tm.rarity,
        tm.is_elite,
        m.name_zh as move_name_zh,
        m.name_en as move_name_en,
        m.type as move_type,
        m.category as move_category
      FROM tm_inventory ti
      JOIN technical_machines tm ON ti.tm_id = tm.id
      JOIN moves m ON tm.move_id = m.id
      WHERE ti.user_id = $1
      ORDER BY tm.rarity, tm.id
    `, [userId]);
    
    return {
      tms: result.rows
    };
  }
  
  /**
   * 给玩家添加 TM
   * @param {number} userId - 用户ID
   * @param {string} tmId - TM ID
   * @param {number} quantity - 数量
   */
  async addTMToInventory(userId, tmId, quantity = 1) {
    await query(`
      INSERT INTO tm_inventory (user_id, tm_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, tm_id)
      DO UPDATE SET quantity = tm_inventory.quantity + $3
    `, [userId, tmId, quantity]);
    
    logger.info('TM added to inventory', { userId, tmId, quantity });
  }
}

module.exports = new MoveService();
