/**
 * REQ-00046: 精灵培育系统与遗传机制
 * 核心培育服务
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('breeding-service');

class BreedingService {
  constructor(config = {}) {
    this.db = config.db || new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'minego',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres'
    });

    this.redis = config.redis || new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD
    });

    // 培育时间配置（单位：小时）
    this.breedingTimes = {
      common: 2,      // 普通精灵
      uncommon: 3,    // 稀有精灵
      rare: 4,        // 非常稀有
      legendary: 12,  // 传说
      mythical: 24    // 幻兽
    };

    // 孵化步数配置
    this.hatchingSteps = {
      common: 2560,
      uncommon: 3840,
      rare: 5120,
      legendary: 10240,
      mythical: 30720
    };

    // 个体值遗传规则
    this.ivInheritance = {
      maxParents: 3,      // 最多遗传 3 个个体值
      destinyKnotBonus: 5, // 红线道具遗传 5 个
      probability: 0.5     // 遗传概率
    };
  }

  /**
   * 获取或创建培育中心
   */
  async getOrCreateBreedingCenter(userId, transaction = null) {
    const client = transaction || this.db;
    
    const result = await client.query(
      `INSERT INTO breeding_centers (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [userId]
    );

    metrics.increment('breeding_center_accessed');
    return result.rows[0];
  }

  /**
   * 检查两只精灵是否可以培育
   */
  async canBreed(parent1Id, parent2Id) {
    // 获取精灵详情
    const pokemonResult = await this.db.query(
      `SELECT up.id, up.species_id, up.gender, ps.name, ps.rarity, ps.is_breedable
       FROM user_pokemon up
       JOIN pokemon_species ps ON up.species_id = ps.id
       WHERE up.id IN ($1, $2)`,
      [parent1Id, parent2Id]
    );

    if (pokemonResult.rows.length !== 2) {
      return { canBreed: false, reason: '精灵不存在' };
    }

    const parent1 = pokemonResult.rows.find(p => p.id === parent1Id);
    const parent2 = pokemonResult.rows.find(p => p.id === parent2Id);

    // 检查是否可培育
    if (!parent1.is_breedable || !parent2.is_breedable) {
      return { canBreed: false, reason: '这些精灵无法培育' };
    }

    // 检查性别（需要有雄性和雌性，或者其中一个是百变怪）
    const hasDitto = parent1.species_id === 132 || parent2.species_id === 132;
    if (!hasDitto) {
      if (parent1.gender === parent2.gender) {
        return { canBreed: false, reason: '相同性别的精灵无法培育' };
      }
      if (!parent1.gender || !parent2.gender) {
        return { canBreed: false, reason: '无性别精灵只能与百变怪培育' };
      }
    }

    // 检查蛋组
    const eggGroupsResult = await this.db.query(
      `SELECT species_id, egg_group_id
       FROM species_egg_groups
       WHERE species_id IN ($1, $2)`,
      [parent1.species_id, parent2.species_id]
    );

    const parent1Groups = eggGroupsResult.rows
      .filter(r => r.species_id === parent1.species_id)
      .map(r => r.egg_group_id);
    const parent2Groups = eggGroupsResult.rows
      .filter(r => r.species_id === parent2.species_id)
      .map(r => r.egg_group_id);

    // 百变怪特殊处理
    if (hasDitto) {
      return { 
        canBreed: true, 
        reason: '百变怪可以与任何可培育精灵配对',
        breedingTime: this.getBreedingTime(parent1.species_id === 132 ? parent2.rarity : parent1.rarity)
      };
    }

    // 检查是否有共同蛋组（排除未发现组）
    const commonGroup = parent1Groups.find(g => parent2Groups.includes(g) && g !== 12);
    if (!commonGroup) {
      return { canBreed: false, reason: '这两个精灵属于不同的蛋组，无法培育' };
    }

    return { 
      canBreed: true, 
      reason: '可以培育',
      breedingTime: this.getBreedingTime(parent1.rarity, parent2.rarity)
    };
  }

  /**
   * 获取培育时间（小时）
   */
  getBreedingTime(rarity1, rarity2 = null) {
    const rarityPriority = { legendary: 4, mythical: 5, rare: 3, uncommon: 2, common: 1 };
    const maxRarity = rarity2 ? 
      (rarityPriority[rarity1] >= rarityPriority[rarity2] ? rarity1 : rarity2) : 
      rarity1;
    
    return this.breedingTimes[maxRarity] || this.breedingTimes.common;
  }

  /**
   * 开始培育
   */
  async startBreeding(userId, parent1Id, parent2Id, slotIndex = 0) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // 检查是否可以培育
      const breedCheck = await this.canBreed(parent1Id, parent2Id);
      if (!breedCheck.canBreed) {
        throw new Error(breedCheck.reason);
      }

      // 获取培育中心
      const center = await this.getOrCreateBreedingCenter(userId, client);

      // 检查槽位
      if (slotIndex >= center.slots) {
        throw new Error(`槽位 ${slotIndex + 1} 未解锁，当前最大槽位数：${center.slots}`);
      }

      // 检查槽位是否已被占用
      const slotCheck = await client.query(
        `SELECT id FROM breeding_pairs 
         WHERE center_id = $1 AND slot_index = $2 AND status IN ('breeding', 'ready')`,
        [center.id, slotIndex]
      );

      if (slotCheck.rows.length > 0) {
        throw new Error(`槽位 ${slotIndex + 1} 已被占用`);
      }

      // 检查精灵所有权
      const ownershipCheck = await client.query(
        `SELECT id, is_in_team, is_egg FROM user_pokemon WHERE id IN ($1, $2) AND user_id = $3`,
        [parent1Id, parent2Id, userId]
      );

      if (ownershipCheck.rows.length !== 2) {
        throw new Error('精灵不存在或不属于你');
      }

      const parent1 = ownershipCheck.rows.find(p => p.id === parent1Id);
      const parent2 = ownershipCheck.rows.find(p => p.id === parent2Id);

      if (parent1.is_egg || parent2.is_egg) {
        throw new Error('精灵蛋无法培育');
      }

      if (parent1.is_in_team || parent2.is_in_team) {
        throw new Error('队伍中的精灵无法培育，请先移出队伍');
      }

      // 预生成后代数据
      const offspringData = await this.generateOffspringData(parent1Id, parent2Id, client);

      // 计算培育完成时间
      const readyAt = new Date(Date.now() + breedCheck.breedingTime * 60 * 60 * 1000);

      // 创建培育配对
      const result = await client.query(
        `INSERT INTO breeding_pairs 
         (center_id, slot_index, parent1_pokemon_id, parent2_pokemon_id, status, ready_at, offspring_data)
         VALUES ($1, $2, $3, $4, 'breeding', $5, $6)
         RETURNING *`,
        [center.id, slotIndex, parent1Id, parent2Id, readyAt, JSON.stringify(offspringData)]
      );

      // 将精灵标记为培育中
      await client.query(
        `UPDATE user_pokemon SET is_breeding = true WHERE id IN ($1, $2)`,
        [parent1Id, parent2Id]
      );

      await client.query('COMMIT');

      metrics.increment('breeding_started');
      logger.info('Breeding started', {
        userId,
        pairId: result.rows[0].id,
        parent1Id,
        parent2Id,
        readyAt
      });

      return {
        success: true,
        pair: result.rows[0],
        readyAt,
        breedingTimeHours: breedCheck.breedingTime
      };

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to start breeding', { error: error.message, userId, parent1Id, parent2Id });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 生成后代数据
   */
  async generateOffspringData(parent1Id, parent2Id, client) {
    // 获取父母数据
    const parentsResult = await client.query(
      `SELECT up.id, up.species_id, up.iv_attack, up.iv_defense, up.iv_stamina,
              up.move1, up.move2, up.is_shiny, up.gender,
              ps.name, ps.rarity, ps.base_hatch_steps
       FROM user_pokemon up
       JOIN pokemon_species ps ON up.species_id = ps.id
       WHERE up.id IN ($1, $2)`,
      [parent1Id, parent2Id]
    );

    const parent1 = parentsResult.rows.find(p => p.id === parent1Id);
    const parent2 = parentsResult.rows.find(p => p.id === parent2Id);

    // 决定子代物种（通常是母方物种，百变怪例外）
    let offspringSpeciesId = parent1.gender === 'female' ? parent1.species_id : parent2.species_id;
    
    // 百变怪特殊处理
    if (parent1.species_id === 132) {
      offspringSpeciesId = parent2.species_id;
    } else if (parent2.species_id === 132) {
      offspringSpeciesId = parent1.species_id;
    }

    // 遗传个体值
    const inheritedIVs = this.calculateInheritedIVs(parent1, parent2);

    // 遗传技能
    const inheritedMoves = this.calculateInheritedMoves(parent1, parent2, offspringSpeciesId, client);

    // 计算闪光概率（父母双方都是闪光时概率更高）
    let shinyChance = 1 / 4096; // 基础概率
    if (parent1.is_shiny && parent2.is_shiny) {
      shinyChance = 1 / 64;
    } else if (parent1.is_shiny || parent2.is_shiny) {
      shinyChance = 1 / 1024;
    }

    const isShiny = Math.random() < shinyChance;

    // 获取孵化步数
    const hatchSteps = this.hatchingSteps[parent1.rarity] || this.hatchingSteps.common;

    return {
      species_id: offspringSpeciesId,
      iv_attack: inheritedIVs.attack,
      iv_defense: inheritedIVs.defense,
      iv_stamina: inheritedIVs.stamina,
      move1: inheritedMoves.move1,
      move2: inheritedMoves.move2,
      is_shiny: isShiny,
      gender: await this.determineGender(offspringSpeciesId, client),
      hatch_steps: hatchSteps,
      parent1_id: parent1Id,
      parent2_id: parent2Id,
      parent1_species_id: parent1.species_id,
      parent2_species_id: parent2.species_id
    };
  }

  /**
   * 计算遗传的个体值
   */
  calculateInheritedIVs(parent1, parent2) {
    const result = {
      attack: Math.floor(Math.random() * 16),
      defense: Math.floor(Math.random() * 16),
      stamina: Math.floor(Math.random() * 16)
    };

    // 随机选择遗传的属性数量（1-3个）
    const inheritCount = Math.floor(Math.random() * 3) + 1;
    const stats = ['attack', 'defense', 'stamina'];
    const selectedStats = stats.sort(() => Math.random() - 0.5).slice(0, inheritCount);

    selectedStats.forEach(stat => {
      // 随机从父母中遗传
      const source = Math.random() < 0.5 ? parent1 : parent2;
      result[stat] = source[`iv_${stat}`];
    });

    return result;
  }

  /**
   * 计算遗传的技能
   */
  calculateInheritedMoves(parent1, parent2, speciesId, client) {
    const moves = {
      move1: null,
      move2: null
    };

    // 遗传技能概率
    if (Math.random() < 0.3 && parent1.move1) {
      moves.move1 = parent1.move1;
    }
    if (Math.random() < 0.3 && parent2.move1) {
      moves.move2 = moves.move1 ? parent2.move1 : parent2.move1;
    }

    return moves;
  }

  /**
   * 决定性别
   */
  async determineGender(speciesId, client) {
    const speciesResult = await client.query(
      `SELECT gender_ratio FROM pokemon_species WHERE id = $1`,
      [speciesId]
    );

    if (speciesResult.rows.length === 0) {
      return 'unknown';
    }

    const genderRatio = speciesResult.rows[0].gender_ratio;
    
    // -1 表示无性别
    if (genderRatio === -1) {
      return 'unknown';
    }

    // 根据性别比例随机决定
    return Math.random() * 100 < genderRatio ? 'female' : 'male';
  }

  /**
   * 获取培育状态
   */
  async getBreedingStatus(userId) {
    const client = await this.db.connect();
    
    try {
      const center = await this.getOrCreateBreedingCenter(userId, client);
      
      const pairsResult = await client.query(
        `SELECT bp.*, 
                up1.species_id as parent1_species_id,
                up2.species_id as parent2_species_id,
                ps1.name as parent1_name,
                ps2.name as parent2_name
         FROM breeding_pairs bp
         LEFT JOIN user_pokemon up1 ON bp.parent1_pokemon_id = up1.id
         LEFT JOIN user_pokemon up2 ON bp.parent2_pokemon_id = up2.id
         LEFT JOIN pokemon_species ps1 ON up1.species_id = ps1.id
         LEFT JOIN pokemon_species ps2 ON up2.species_id = ps2.id
         WHERE bp.center_id = $1 AND bp.status IN ('breeding', 'ready')
         ORDER BY bp.slot_index`,
        [center.id]
      );

      // 检查已完成的培育
      const now = new Date();
      for (const pair of pairsResult.rows) {
        if (pair.status === 'breeding' && new Date(pair.ready_at) <= now) {
          await client.query(
            `UPDATE breeding_pairs SET status = 'ready', updated_at = NOW() WHERE id = $1`,
            [pair.id]
          );
          pair.status = 'ready';
          metrics.increment('breeding_ready');
        }
      }

      return {
        center,
        pairs: pairsResult.rows
      };

    } finally {
      client.release();
    }
  }

  /**
   * 收集培育完成的蛋
   */
  async collectEgg(userId, pairId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // 获取培育配对
      const pairResult = await client.query(
        `SELECT bp.*, bc.user_id
         FROM breeding_pairs bp
         JOIN breeding_centers bc ON bp.center_id = bc.id
         WHERE bp.id = $1`,
        [pairId]
      );

      if (pairResult.rows.length === 0) {
        throw new Error('培育配对不存在');
      }

      const pair = pairResult.rows[0];

      if (pair.user_id !== userId) {
        throw new Error('无权操作此培育配对');
      }

      if (pair.status !== 'ready') {
        throw new Error('培育尚未完成');
      }

      // 创建精灵蛋
      const offspringData = typeof pair.offspring_data === 'string' 
        ? JSON.parse(pair.offspring_data) 
        : pair.offspring_data;

      const pokemonResult = await client.query(
        `INSERT INTO user_pokemon 
         (user_id, species_id, iv_attack, iv_defense, iv_stamina, move1, move2, 
          is_shiny, gender, is_egg, egg_steps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
         RETURNING *`,
        [userId, offspringData.species_id, offspringData.iv_attack, 
         offspringData.iv_defense, offspringData.iv_stamina,
         offspringData.move1, offspringData.move2, offspringData.is_shiny,
         offspringData.gender, offspringData.hatch_steps]
      );

      const pokemon = pokemonResult.rows[0];

      // 创建孵化记录
      await client.query(
        `INSERT INTO egg_hatching (user_id, pokemon_id, required_steps)
         VALUES ($1, $2, $3)`,
        [userId, pokemon.id, offspringData.hatch_steps]
      );

      // 创建谱系记录
      await client.query(
        `INSERT INTO pokemon_lineage 
         (pokemon_id, parent1_id, parent1_species_id, parent2_id, parent2_species_id, bred_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [pokemon.id, offspringData.parent1_id, offspringData.parent1_species_id,
         offspringData.parent2_id, offspringData.parent2_species_id, userId]
      );

      // 更新培育配对状态
      await client.query(
        `UPDATE breeding_pairs 
         SET status = 'collected', offspring_id = $1, collected_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [pokemon.id, pairId]
      );

      // 释放父母精灵
      await client.query(
        `UPDATE user_pokemon SET is_breeding = false 
         WHERE id IN ($1, $2)`,
        [pair.parent1_pokemon_id, pair.parent2_pokemon_id]
      );

      // 更新统计
      await client.query(
        `INSERT INTO breeding_stats (user_id, total_breeds, last_bred_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (user_id) DO UPDATE 
         SET total_breeds = breeding_stats.total_breeds + 1,
             last_bred_at = NOW(),
             updated_at = NOW()`,
        [userId]
      );

      await client.query('COMMIT');

      metrics.increment('egg_collected');
      if (pokemon.is_shiny) {
        metrics.increment('shiny_bred');
      }

      logger.info('Egg collected', {
        userId,
        pairId,
        pokemonId: pokemon.id,
        speciesId: offspringData.species_id,
        isShiny: pokemon.is_shiny
      });

      return {
        success: true,
        pokemon,
        offspringData
      };

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to collect egg', { error: error.message, userId, pairId });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 更新孵化进度
   */
  async updateHatchingProgress(userId, steps) {
    const result = await this.db.query(
      `UPDATE egg_hatching 
       SET current_steps = current_steps + $1, updated_at = NOW()
       WHERE user_id = $2 AND hatched_at IS NULL
       RETURNING *`,
      [steps, userId]
    );

    // 检查是否孵化完成
    const hatched = [];
    for (const egg of result.rows) {
      if (egg.current_steps >= egg.required_steps) {
        const hatchedPokemon = await this.hatchEgg(egg.id, userId);
        hatched.push(hatchedPokemon);
      }
    }

    return { updated: result.rows.length, hatched };
  }

  /**
   * 孵化精灵蛋
   */
  async hatchEgg(hatchingId, userId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      const hatchingResult = await client.query(
        `SELECT eh.*, up.species_id, up.is_shiny
         FROM egg_hatching eh
         JOIN user_pokemon up ON eh.pokemon_id = up.id
         WHERE eh.id = $1 AND eh.user_id = $2`,
        [hatchingId, userId]
      );

      if (hatchingResult.rows.length === 0) {
        throw new Error('孵化记录不存在');
      }

      const hatching = hatchingResult.rows[0];

      // 更新精灵状态
      await client.query(
        `UPDATE user_pokemon SET is_egg = false, egg_steps = NULL WHERE id = $1`,
        [hatching.pokemon_id]
      );

      // 更新孵化记录
      await client.query(
        `UPDATE egg_hatching SET hatched_at = NOW() WHERE id = $1`,
        [hatchingId]
      );

      // 更新统计
      await client.query(
        `INSERT INTO breeding_stats (user_id, total_eggs_hatched, last_hatched_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (user_id) DO UPDATE 
         SET total_eggs_hatched = breeding_stats.total_eggs_hatched + 1,
             last_hatched_at = NOW(),
             updated_at = NOW()`,
        [userId]
      );

      await client.query('COMMIT');

      metrics.increment('egg_hatched');
      if (hatching.is_shiny) {
        metrics.increment('shiny_hatched');
      }

      logger.info('Egg hatched', {
        userId,
        pokemonId: hatching.pokemon_id,
        speciesId: hatching.species_id,
        isShiny: hatching.is_shiny
      });

      return hatching;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 取消培育
   */
  async cancelBreeding(userId, pairId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      const pairResult = await client.query(
        `SELECT bp.*, bc.user_id
         FROM breeding_pairs bp
         JOIN breeding_centers bc ON bp.center_id = bc.id
         WHERE bp.id = $1`,
        [pairId]
      );

      if (pairResult.rows.length === 0) {
        throw new Error('培育配对不存在');
      }

      const pair = pairResult.rows[0];

      if (pair.user_id !== userId) {
        throw new Error('无权操作此培育配对');
      }

      // 更新状态
      await client.query(
        `UPDATE breeding_pairs SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [pairId]
      );

      // 释放父母精灵
      await client.query(
        `UPDATE user_pokemon SET is_breeding = false 
         WHERE id IN ($1, $2)`,
        [pair.parent1_pokemon_id, pair.parent2_pokemon_id]
      );

      await client.query('COMMIT');

      metrics.increment('breeding_cancelled');
      logger.info('Breeding cancelled', { userId, pairId });

      return { success: true };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取培育统计
   */
  async getBreedingStats(userId) {
    const result = await this.db.query(
      `SELECT * FROM breeding_stats WHERE user_id = $1`,
      [userId]
    );

    return result.rows[0] || {
      user_id: userId,
      total_breeds: 0,
      total_eggs_hatched: 0,
      perfect_iv_breeds: 0,
      shiny_breeds: 0
    };
  }

  /**
   * 升级培育中心（增加槽位）
   */
  async upgradeBreedingCenter(userId) {
    const result = await this.db.query(
      `UPDATE breeding_centers 
       SET slots = LEAST(slots + 1, 10), upgraded_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND slots < 10
       RETURNING *`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('培育中心已达到最大槽位数');
    }

    metrics.increment('breeding_center_upgraded');
    return result.rows[0];
  }
}

module.exports = BreedingService;
