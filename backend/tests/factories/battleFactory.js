/**
 * 战斗测试数据工厂
 * 用于生成战斗引擎和连击系统测试所需的测试数据
 */

/**
 * 创建精灵数据
 */
function createPokemon(overrides = {}) {
  const defaults = {
    id: 'pokemon-test-001',
    species: 'Charizard',
    nickname: 'Flame',
    level: 50,
    types: ['fire', 'flying'],
    type_id: 10, // fire
    ability_id: 1,
    stats: {
      hp: 150,
      attack: 100,
      defense: 90,
      special_attack: 120,
      special_defense: 95,
      speed: 110
    },
    max_hp: 150,
    current_hp: 150,
    status: null,
    statuses: [],
    moves: [
      createMove({ name: 'Flamethrower', type: 'fire', power: 90 }),
      createMove({ name: 'Air Slash', type: 'flying', power: 75 }),
      createMove({ name: 'Dragon Claw', type: 'dragon', power: 80 }),
      createMove({ name: 'Fire Blast', type: 'fire', power: 110, accuracy: 85 })
    ]
  };

  return { ...defaults, ...overrides };
}

/**
 * 创建技能数据
 */
function createMove(overrides = {}) {
  const defaults = {
    id: 'move-test-001',
    name: 'Tackle',
    type: 'normal',
    power: 40,
    accuracy: 100,
    pp: 35,
    category: 'physical',
    priority: 0,
    crit_rate: 0.0625
  };

  return { ...defaults, ...overrides };
}

/**
 * 创建战斗引擎实例
 */
function createBattleEngine(options = {}) {
  const { BattleEngine } = require('../../services/gym-service/src/battleEngine');
  
  const defaults = {
    battleId: 'battle-test-001',
    gymId: 'gym-test-001',
    attackerId: 'user-test-001',
    defenderId: 'npc-defender-001'
  };

  const engine = new BattleEngine(
    options.battleId || defaults.battleId,
    options.gymId || defaults.gymId,
    options.attackerId || defaults.attackerId,
    options.defenderId || defaults.defenderId
  );

  return engine;
}

/**
 * 设置战斗引擎状态
 */
function setupBattleState(engine, attackerPokemon, defenderPokemon) {
  engine.attacker.currentPokemon = attackerPokemon;
  engine.attacker.team = [attackerPokemon];
  engine.defender.currentPokemon = defenderPokemon;
  engine.defender.team = [defenderPokemon];
  engine.status = 'ongoing';
  return engine;
}

/**
 * 创建连击链配置
 */
function createComboChain(overrides = {}) {
  const defaults = {
    chain_id: 'combo-test-001',
    name: '火焰连击',
    description: '连续使用火属性技能触发连击',
    trigger_sequence: ['fire_blast', 'flamethrower', 'fire_spin'],
    time_window_ms: 5000,
    damage_multiplier: 1.5,
    combo_points: 100,
    xp_bonus: 50,
    cooldown_reduction: 0,
    min_trainer_level: 1,
    required_badges: 0,
    bonus_effects: {
      extra_damage: 20
    },
    is_active: true
  };

  return { ...defaults, ...overrides };
}

/**
 * 创建连击状态
 */
function createComboState(overrides = {}) {
  const defaults = {
    sequence: [],
    startedAt: null,
    lastUpdate: Date.now()
  };

  return { ...defaults, ...overrides };
}

/**
 * Mock 数据库查询
 */
function mockDbQuery(results) {
  const mockDb = jest.fn();
  
  if (Array.isArray(results)) {
    mockDb.mockResolvedValue(results);
  } else {
    mockDb.mockImplementation((table) => {
      const chain = {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(results.select || []),
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        merge: jest.fn().mockResolvedValue(true),
        transaction: jest.fn().mockImplementation(async (callback) => {
          const mockTrx = {
            insert: jest.fn().mockReturnThis(),
            onConflict: jest.fn().mockReturnThis(),
            merge: jest.fn().mockResolvedValue(true),
            commit: jest.fn().mockResolvedValue(true),
            rollback: jest.fn().mockResolvedValue(false)
          };
          return callback(mockTrx);
        })
      };
      return chain;
    });
  }
  
  return mockDb;
}

/**
 * 属性克制测试矩阵
 * 格式: [攻击方类型, 防守方类型, 期望倍率]
 */
const TYPE_EFFECTIVENESS_MATRIX = [
  // 单属性克制
  ['fire', 'grass', 2.0],
  ['fire', 'water', 0.5],
  ['fire', 'fire', 0.5],
  ['fire', 'rock', 0.5],
  ['fire', 'dragon', 0.5],
  ['fire', 'ice', 2.0],
  ['fire', 'bug', 2.0],
  ['fire', 'steel', 2.0],
  
  ['water', 'fire', 2.0],
  ['water', 'water', 0.5],
  ['water', 'grass', 0.5],
  ['water', 'ground', 2.0],
  ['water', 'rock', 2.0],
  ['water', 'dragon', 0.5],
  
  ['electric', 'water', 2.0],
  ['electric', 'electric', 0.5],
  ['electric', 'grass', 0.5],
  ['electric', 'ground', 0],      // 无效
  ['electric', 'flying', 2.0],
  ['electric', 'dragon', 0.5],
  
  ['grass', 'water', 2.0],
  ['grass', 'fire', 0.5],
  ['grass', 'grass', 0.5],
  ['grass', 'poison', 0.5],
  ['grass', 'ground', 2.0],
  ['grass', 'flying', 0.5],
  ['grass', 'bug', 0.5],
  ['grass', 'rock', 2.0],
  ['grass', 'dragon', 0.5],
  ['grass', 'steel', 0.5],
  
  ['ice', 'grass', 2.0],
  ['ice', 'ground', 2.0],
  ['ice', 'flying', 2.0],
  ['ice', 'dragon', 2.0],
  ['ice', 'fire', 0.5],
  ['ice', 'water', 0.5],
  ['ice', 'ice', 0.5],
  ['ice', 'steel', 0.5],
  
  ['fighting', 'normal', 2.0],
  ['fighting', 'ice', 2.0],
  ['fighting', 'rock', 2.0],
  ['fighting', 'dark', 2.0],
  ['fighting', 'steel', 2.0],
  ['fighting', 'ghost', 0],       // 无效
  ['fighting', 'fairy', 0.5],
  ['fighting', 'flying', 0.5],
  
  ['poison', 'grass', 2.0],
  ['poison', 'fairy', 2.0],
  ['poison', 'poison', 0.5],
  ['poison', 'ground', 0.5],
  ['poison', 'rock', 0.5],
  ['poison', 'ghost', 0.5],
  ['poison', 'steel', 0],         // 无效
  
  ['ground', 'fire', 2.0],
  ['ground', 'electric', 2.0],
  ['ground', 'poison', 2.0],
  ['ground', 'rock', 2.0],
  ['ground', 'steel', 2.0],
  ['ground', 'flying', 0],        // 无效
  ['ground', 'grass', 0.5],
  ['ground', 'bug', 0.5],
  
  ['flying', 'grass', 2.0],
  ['flying', 'fighting', 2.0],
  ['flying', 'bug', 2.0],
  ['flying', 'electric', 0.5],
  ['flying', 'rock', 0.5],
  ['flying', 'steel', 0.5],
  
  ['psychic', 'fighting', 2.0],
  ['psychic', 'poison', 2.0],
  ['psychic', 'psychic', 0.5],
  ['psychic', 'dark', 0],         // 无效
  ['psychic', 'steel', 0.5],
  
  ['bug', 'grass', 2.0],
  ['bug', 'psychic', 2.0],
  ['bug', 'dark', 2.0],
  ['bug', 'fire', 0.5],
  ['bug', 'fighting', 0.5],
  ['bug', 'poison', 0.5],
  ['bug', 'flying', 0.5],
  ['bug', 'ghost', 0.5],
  ['bug', 'steel', 0.5],
  ['bug', 'fairy', 0.5],
  
  ['rock', 'fire', 2.0],
  ['rock', 'ice', 2.0],
  ['rock', 'flying', 2.0],
  ['rock', 'bug', 2.0],
  ['rock', 'fighting', 0.5],
  ['rock', 'ground', 0.5],
  ['rock', 'steel', 0.5],
  
  ['ghost', 'psychic', 2.0],
  ['ghost', 'ghost', 2.0],
  ['ghost', 'normal', 0],         // 无效
  ['ghost', 'dark', 0.5],
  
  ['dragon', 'dragon', 2.0],
  ['dragon', 'steel', 0.5],
  ['dragon', 'fairy', 0],         // 无效
  
  ['dark', 'psychic', 2.0],
  ['dark', 'ghost', 2.0],
  ['dark', 'fighting', 0.5],
  ['dark', 'dark', 0.5],
  ['dark', 'fairy', 0.5],
  
  ['steel', 'ice', 2.0],
  ['steel', 'rock', 2.0],
  ['steel', 'fairy', 2.0],
  ['steel', 'fire', 0.5],
  ['steel', 'water', 0.5],
  ['steel', 'electric', 0.5],
  ['steel', 'steel', 0.5],
  
  ['fairy', 'fighting', 2.0],
  ['fairy', 'dragon', 2.0],
  ['fairy', 'dark', 2.0],
  ['fairy', 'fire', 0.5],
  ['fairy', 'poison', 0.5],
  ['fairy', 'steel', 0.5],
  
  ['normal', 'ghost', 0],         // 无效
  ['normal', 'rock', 0.5],
  ['normal', 'steel', 0.5]
];

/**
 * 双属性克制测试矩阵
 */
const DUAL_TYPE_MATRIX = [
  // [攻击方, [防守方类型1, 防守方类型2], 期望倍率]
  ['fire', ['water', 'dragon'], 0.25],    // 0.5 * 0.5
  ['rock', ['fire', 'flying'], 4.0],      // 2 * 2
  ['ice', ['dragon', 'flying'], 4.0],     // 2 * 2
  ['ground', ['electric', 'poison'], 4.0],// 2 * 2
  ['water', ['ground', 'rock'], 4.0],     // 2 * 2
  ['fighting', ['normal', 'ice'], 4.0],   // 2 * 2
  ['ground', ['flying', 'electric'], 0],  // 0 * 2 = 0
  ['electric', ['ground', 'flying'], 0],  // 0 * 2 = 0
];

module.exports = {
  createPokemon,
  createMove,
  createBattleEngine,
  setupBattleState,
  createComboChain,
  createComboState,
  mockDbQuery,
  TYPE_EFFECTIVENESS_MATRIX,
  DUAL_TYPE_MATRIX
};