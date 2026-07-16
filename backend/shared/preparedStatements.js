/**
 * PostgreSQL Prepared Statements Registry
 * REQ-00575: PostgreSQL 预编译语句优化
 * 
 * 功能：
 * - 定义高频查询的预编译模板
 * - 支持参数类型声明以优化执行计划
 * - 服务启动时预热关键语句
 */

const PREPARED_STATEMENTS = {
  // ==================== location-service ====================
  
  /**
   * 获取附近野怪（含 PostGIS 空间查询）
   * 高频调用：每秒数百次
   */
  getNearbyWild: {
    name: 'get_nearby_wild',
    text: `
      SELECT w.id, w.species_id, w.lat, w.lng, w.cp,
             w.is_shiny, w.weather_boosted, w.expires_at,
             p.name_zh, p.name_en, p.type1, p.type2, p.rarity, p.sprite_url
      FROM wild_pokemon w
      JOIN pokemon_species p ON p.id = w.species_id
      WHERE w.is_caught = false
        AND w.expires_at > NOW()
        AND ST_DWithin(
          w.location::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $3
        )
      ORDER BY w.expires_at DESC
      LIMIT 50
    `,
    paramTypes: ['float8', 'float8', 'float8'],
    description: 'Get nearby wild pokemon within radius',
    service: 'location-service'
  },

  /**
   * 获取附近野怪数量（用于附近提醒）
   */
  getNearbyWildCount: {
    name: 'get_nearby_wild_count',
    text: `
      SELECT COUNT(*) as count
      FROM wild_pokemon
      WHERE is_caught = false
        AND expires_at > NOW()
        AND ST_DWithin(
          location::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $3
        )
    `,
    paramTypes: ['float8', 'float8', 'float8'],
    description: 'Count nearby wild pokemon',
    service: 'location-service'
  },

  /**
   * 获取附近道馆（含 PostGIS 空间查询）
   */
  getNearbyGyms: {
    name: 'get_nearby_gyms',
    text: `
      SELECT g.id, g.name, g.lat, g.lng, g.team, g.prestige,
             g.slots_available, g.ex_raid_eligible
      FROM gyms g
      WHERE ST_DWithin(
        g.location::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )
      ORDER BY ST_Distance(
        g.location::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      )
      LIMIT 50
    `,
    paramTypes: ['float8', 'float8', 'float8'],
    description: 'Get nearby gyms within radius',
    service: 'location-service'
  },

  /**
   * 获取附近补给站
   */
  getNearbyPokestops: {
    name: 'get_nearby_pokestops',
    text: `
      SELECT ps.id, ps.name, ps.lat, ps.lng, ps.type,
             ps.cooldown_end, ps.lure_type, ps.lure_expires_at
      FROM pokestops ps
      WHERE ST_DWithin(
        ps.location::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )
      ORDER BY ST_Distance(
        ps.location::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      )
      LIMIT 50
    `,
    paramTypes: ['float8', 'float8', 'float8'],
    description: 'Get nearby pokestops within radius',
    service: 'location-service'
  },

  // ==================== catch-service ====================

  /**
   * 插入捕捉的精灵实例
   */
  insertPokemonInstance: {
    name: 'insert_pokemon_instance',
    text: `
      INSERT INTO pokemon_instances
        (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp,
         is_shiny, is_lucky, is_zero_iv, is_perfect_iv, caught_lat, caught_lng,
         fast_move, charge_move, learned_fast_moves, learned_charge_moves,
         caught_at, source)
      VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, false, $9, $10, $11, $12, $13, $14, ARRAY[$13], ARRAY[$14], NOW(), 'catch')
      RETURNING id, user_id, species_id, cp, hp_current, hp_max
    `,
    paramTypes: ['int4', 'int4', 'int4', 'int4', 'int4', 'int4', 'int4', 'bool', 'bool', 'bool', 'float8', 'float8', 'varchar', 'varchar'],
    description: 'Insert caught pokemon instance',
    service: 'catch-service'
  },

  /**
   * 更新野怪为已捕捉状态
   */
  updateWildPokemonCaught: {
    name: 'update_wild_pokemon_caught',
    text: `
      UPDATE wild_pokemon
      SET is_caught = true, caught_by = $2, caught_at = NOW()
      WHERE id = $1 AND is_caught = false
      RETURNING id, species_id
    `,
    paramTypes: ['int4', 'int4'],
    description: 'Mark wild pokemon as caught',
    service: 'catch-service'
  },

  // ==================== gym-service ====================

  /**
   * 获取道馆详细信息
   */
  getGymById: {
    name: 'get_gym_by_id',
    text: `
      SELECT g.id, g.name, g.lat, g.lng, g.team, g.prestige,
             g.slots_available, g.ex_raid_eligible,
             g.updated_at
      FROM gyms g
      WHERE g.id = $1
    `,
    paramTypes: ['int4'],
    description: 'Get gym details by ID',
    service: 'gym-service'
  },

  /**
   * 获取道馆防守精灵
   */
  getGymDefenders: {
    name: 'get_gym_defenders',
    text: `
      SELECT gd.id, gd.gym_id, gd.pokemon_id, gd.position,
             p.species_id, p.cp, p.hp_current, p.hp_max,
             p.fast_move, p.charge_move, p.is_shiny
      FROM gym_defenders gd
      JOIN pokemon_instances p ON p.id = gd.pokemon_id
      WHERE gd.gym_id = $1
      ORDER BY gd.position
    `,
    paramTypes: ['int4'],
    description: 'Get gym defending pokemon',
    service: 'gym-service'
  },

  /**
   * 更新道馆声望
   */
  updateGymPrestige: {
    name: 'update_gym_prestige',
    text: `
      UPDATE gyms
      SET prestige = $2, team = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING id, prestige, team
    `,
    paramTypes: ['int4', 'int4', 'varchar'],
    description: 'Update gym prestige and team',
    service: 'gym-service'
  },

  // ==================== user-service ====================

  /**
   * 获取用户信息
   */
  getUserById: {
    name: 'get_user_by_id',
    text: `
      SELECT id, username, email, nickname, level, exp,
             coins, stardust, last_lat, last_lng, created_at
      FROM users
      WHERE id = $1
    `,
    paramTypes: ['int4'],
    description: 'Get user by ID',
    service: 'user-service'
  },

  /**
   * 更新用户位置
   */
  updateUserLocation: {
    name: 'update_user_location',
    text: `
      UPDATE users
      SET last_lat = $2, last_lng = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING id, last_lat, last_lng
    `,
    paramTypes: ['int4', 'float8', 'float8'],
    description: 'Update user location',
    service: 'user-service'
  },

  /**
   * 更新用户货币
   */
  updateUserCurrency: {
    name: 'update_user_currency',
    text: `
      UPDATE users
      SET coins = coins + $2, stardust = stardust + $3, updated_at = NOW()
      WHERE id = $1
      RETURNING id, coins, stardust
    `,
    paramTypes: ['int4', 'int4', 'int4'],
    description: 'Update user currency',
    service: 'user-service'
  }
};

/**
 * 获取指定服务的预编译语句列表
 * @param {string} serviceName - 服务名称
 * @returns {Array} 预编译语句配置数组
 */
function getStatementsForService(serviceName) {
  return Object.entries(PREPARED_STATEMENTS)
    .filter(([_, config]) => config.service === serviceName)
    .map(([key, config]) => ({ key, ...config }));
}

/**
 * 获取所有预编译语句名称列表
 * @returns {Array<string>} 语句名称数组
 */
function getAllStatementNames() {
  return Object.keys(PREPARED_STATEMENTS);
}

/**
 * 根据名称获取预编译语句配置
 * @param {string} name - 语句名称（如 'getNearbyWild'）
 * @returns {Object|null} 语句配置或 null
 */
function getStatementByName(name) {
  return PREPARED_STATEMENTS[name] || null;
}

module.exports = {
  PREPARED_STATEMENTS,
  getStatementsForService,
  getAllStatementNames,
  getStatementByName
};