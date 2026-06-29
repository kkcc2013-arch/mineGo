/**
 * 精灵测试数据工厂
 * 用于集成测试中创建测试精灵数据
 */

const { v4: uuidv4 } = require('uuid');

class PokemonFactory {
  constructor(dbPool) {
    this.dbPool = dbPool;
    
    // 默认精灵物种数据
    this.defaultSpecies = {
      1: { name: 'Bulbasaur', types: ['grass', 'poison'], baseStats: { hp: 45, attack: 49, defense: 49 } },
      6: { name: 'Charizard', types: ['fire', 'flying'], baseStats: { hp: 78, attack: 84, defense: 78 } },
      25: { name: 'Pikachu', types: ['electric'], baseStats: { hp: 35, attack: 55, defense: 40 } },
      94: { name: 'Gengar', types: ['ghost', 'poison'], baseStats: { hp: 60, attack: 65, defense: 60 } },
      150: { name: 'Mewtwo', types: ['psychic'], baseStats: { hp: 106, attack: 150, defense: 90 } }
    };
    
    // 默认技能数据
    this.defaultMoves = {
      electric: ['thunder-shock', 'thunderbolt', 'thunder'],
      fire: ['ember', 'flamethrower', 'fire-blast'],
      grass: ['vine-whip', 'razor-leaf', 'solar-beam'],
      water: ['water-gun', 'hydro-pump', 'bubble-beam'],
      psychic: ['psychic', 'psybeam', 'confusion']
    };
  }

  /**
   * 创建单个精灵
   */
  async create(overrides = {}) {
    const speciesId = overrides.speciesId || 25; // 默认 Pikachu
    const level = overrides.level || Math.floor(Math.random() * 50) + 1;
    
    // 计算属性值
    const baseStats = this.defaultSpecies[speciesId]?.baseStats || { hp: 50, attack: 50, defense: 50 };
    const hpMultiplier = 1 + (level / 100);
    
    const pokemon = {
      id: overrides.id || uuidv4(),
      userId: overrides.userId || uuidv4(),
      speciesId,
      nickname: overrides.nickname || null,
      level,
      experience: overrides.experience || this.calculateExperience(level),
      hp: overrides.hp || Math.floor(baseStats.hp * hpMultiplier),
      maxHp: overrides.maxHp || Math.floor(baseStats.hp * hpMultiplier),
      currentHp: overrides.currentHp || Math.floor(baseStats.hp * hpMultiplier),
      attack: overrides.attack || Math.floor(baseStats.attack * hpMultiplier),
      defense: overrides.defense || Math.floor(baseStats.defense * hpMultiplier),
      specialAttack: overrides.specialAttack || 50,
      specialDefense: overrides.specialDefense || 50,
      speed: overrides.speed || 50,
      nature: overrides.nature || 'hardy',
      ability: overrides.ability || 'overgrow',
      heldItemId: overrides.heldItemId || null,
      metLocation: overrides.metLocation || 'Pallet Town',
      metDate: overrides.metDate || new Date(),
      isShiny: overrides.isShiny || false,
      friendship: overrides.friendship || 70,
      status: overrides.status || 'healthy',
      moves: overrides.moves || this.getDefaultMoves(speciesId),
      ivs: overrides.ivs || this.generateIVs(),
      evs: overrides.evs || this.generateEVs(),
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
      ...overrides
    };

    // 插入数据库
    await this.dbPool.query(
      `INSERT INTO pokemon (
        id, user_id, species_id, nickname, level, experience,
        hp, max_hp, current_hp, attack, defense, special_attack, special_defense, speed,
        nature, ability, held_item_id, met_location, met_date, is_shiny, friendship, status,
        moves, ivs, evs, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
      [
        pokemon.id, pokemon.userId, pokemon.speciesId, pokemon.nickname,
        pokemon.level, pokemon.experience, pokemon.hp, pokemon.maxHp, pokemon.currentHp,
        pokemon.attack, pokemon.defense, pokemon.specialAttack, pokemon.specialDefense,
        pokemon.speed, pokemon.nature, pokemon.ability, pokemon.heldItemId,
        pokemon.metLocation, pokemon.metDate, pokemon.isShiny, pokemon.friendship,
        pokemon.status, JSON.stringify(pokemon.moves), JSON.stringify(pokemon.ivs),
        JSON.stringify(pokemon.evs), pokemon.createdAt, pokemon.updatedAt
      ]
    );

    return pokemon;
  }

  /**
   * 批量创建精灵
   */
  async createBatch(count, overrides = {}) {
    const pokemons = [];
    for (let i = 0; i < count; i++) {
      pokemons.push(await this.create(overrides));
    }
    return pokemons;
  }

  /**
   * 创建战斗队伍
   */
  async createBattleTeam(userId, teamSize = 6, level = 50) {
    const teamSpeciesIds = [25, 6, 94, 1, 150, 7]; // Pikachu, Charizard, Gengar, Bulbasaur, Mewtwo, Squirtle
    const team = [];
    
    for (let i = 0; i < Math.min(teamSize, teamSpeciesIds.length); i++) {
      team.push(await this.create({
        userId,
        speciesId: teamSpeciesIds[i],
        level,
        currentHp: null // 使用 maxHp
      }));
    }
    
    return team;
  }

  /**
   * 计算经验值
   */
  calculateExperience(level) {
    // 简化的经验值计算公式
    return Math.floor(Math.pow(level, 3) * 0.8);
  }

  /**
   * 获取默认技能
   */
  getDefaultMoves(speciesId) {
    const species = this.defaultSpecies[speciesId];
    if (!species) return ['tackle', 'scratch'];
    
    const types = species.types;
    const moves = [];
    
    for (const type of types) {
      const typeMoves = this.defaultMoves[type] || ['tackle'];
      moves.push(typeMoves[0]);
    }
    
    return moves.slice(0, 4);
  }

  /**
   * 生成个体值 (IVs)
   */
  generateIVs() {
    return {
      hp: Math.floor(Math.random() * 32),
      attack: Math.floor(Math.random() * 32),
      defense: Math.floor(Math.random() * 32),
      specialAttack: Math.floor(Math.random() * 32),
      specialDefense: Math.floor(Math.random() * 32),
      speed: Math.floor(Math.random() * 32)
    };
  }

  /**
   * 生成努力值 (EVs)
   */
  generateEVs() {
    const totalEVs = Math.floor(Math.random() * 510);
    const evs = {
      hp: 0,
      attack: 0,
      defense: 0,
      specialAttack: 0,
      specialDefense: 0,
      speed: 0
    };
    
    // 随机分配 EVs
    const stats = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];
    let remaining = totalEVs;
    
    for (const stat of stats) {
      if (remaining <= 0) break;
      const allocation = Math.min(Math.floor(Math.random() * 255), remaining);
      evs[stat] = allocation;
      remaining -= allocation;
    }
    
    return evs;
  }

  /**
   * 创建野生精灵（用于捕捉测试）
   */
  async createWildSpawn(overrides = {}) {
    const spawnId = overrides.spawnId || uuidv4();
    const speciesId = overrides.speciesId || Math.floor(Math.random() * 151) + 1;
    const level = overrides.level || Math.floor(Math.random() * 30) + 1;
    
    const spawn = {
      spawnId,
      speciesId,
      level,
      lat: overrides.lat || 35.6762,
      lng: overrides.lng || 139.6503,
      spawnTime: overrides.spawnTime || new Date(),
      expireTime: overrides.expireTime || new Date(Date.now() + 30 * 60 * 1000),
      weatherBoost: overrides.weatherBoost || false,
      catchRate: overrides.catchRate || this.calculateCatchRate(speciesId, level)
    };

    // 存储到 Redis（模拟实时生成点）
    if (overrides.redisClient) {
      await overrides.redisClient.hset(`spawn:${spawnId}`, {
        speciesId: spawn.speciesId.toString(),
        level: spawn.level.toString(),
        lat: spawn.lat.toString(),
        lng: spawn.lng.toString(),
        catchRate: spawn.catchRate.toString(),
        expireTime: spawn.expireTime.getTime().toString()
      });
      
      await overrides.redisClient.expire(`spawn:${spawnId}`, 1800);
    }

    return spawn;
  }

  /**
   * 计算捕捉率
   */
  calculateCatchRate(speciesId, level) {
    // 基础捕捉率（简化公式）
    const baseCaptureRate = 0.3; // 默认 30%
    const levelModifier = Math.max(0.1, 1 - (level / 100));
    
    return Math.min(1, baseCaptureRate * levelModifier);
  }

  /**
   * 查询用户精灵
   */
  async getUserPokemon(userId) {
    const result = await this.dbPool.query(
      'SELECT * FROM pokemon WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  /**
   * 更新精灵状态
   */
  async updatePokemon(pokemonId, updates) {
    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      updateFields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }

    values.push(pokemonId);
    
    await this.dbPool.query(
      `UPDATE pokemon SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
      values
    );
  }

  /**
   * 删除精灵
   */
  async deletePokemon(pokemonId) {
    await this.dbPool.query('DELETE FROM pokemon WHERE id = $1', [pokemonId]);
  }

  /**
   * 清理用户精灵
   */
  async clearUserPokemon(userId) {
    await this.dbPool.query('DELETE FROM pokemon WHERE user_id = $1', [userId]);
  }
}

module.exports = PokemonFactory;