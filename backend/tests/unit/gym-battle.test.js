/**
 * REQ-00054: 道馆战斗系统 - 单元测试
 * 创建时间: 2026-06-09 16:00
 */

const { BattleEngine, TYPE_CHART, STATUS_EFFECTS } = require('../../services/gym-service/src/battleEngine');

describe('BattleEngine', () => {
  let battleEngine;
  const mockBattleId = 'test-battle-id';
  const mockGymId = 'test-gym-id';
  const mockAttackerId = 'test-attacker-id';
  const mockDefenderId = 'test-defender-id';

  beforeEach(() => {
    battleEngine = new BattleEngine(mockBattleId, mockGymId, mockAttackerId, mockDefenderId);
    battleEngine.statusEngine = {
      initialize: jest.fn().mockResolvedValue(),
      clearBattleStatuses: jest.fn().mockResolvedValue(),
      getPokemonStatuses: jest.fn().mockResolvedValue([]),
      getStatChanges: jest.fn().mockResolvedValue({}),
      calculateModifiedStats: jest.fn().mockImplementation((stats, changes) => stats),
      onTurnStart: jest.fn().mockResolvedValue([]),
      onTurnEnd: jest.fn().mockResolvedValue([]),
      checkActionBlocked: jest.fn().mockResolvedValue({ blocked: false }),
      applyStatus: jest.fn().mockImplementation((battleId, targetId, status, options) => {
        return { success: true, statusName: status };
      }),
      removeStatus: jest.fn().mockResolvedValue(true)
    };
  });

  describe('构造函数', () => {
    test('应该正确初始化战斗引擎', () => {
      expect(battleEngine.battleId).toBe(mockBattleId);
      expect(battleEngine.gymId).toBe(mockGymId);
      expect(battleEngine.attacker.userId).toBe(mockAttackerId);
      expect(battleEngine.turn).toBe(0);
      expect(battleEngine.status).toBe('pending');
      expect(battleEngine.replay).toEqual([]);
    });

    test('应该初始化空队伍', () => {
      expect(battleEngine.attacker.team).toEqual([]);
      expect(battleEngine.defender.team).toEqual([]);
    });
  });

  describe('calculateTypeEffectiveness', () => {
    test('应该正确计算属性克制（火克草）', () => {
      const result = battleEngine.calculateTypeEffectiveness(['fire'], ['grass']);
      expect(result.multiplier).toBe(2);
    });

    test('应该正确计算属性克制（水克火）', () => {
      const result = battleEngine.calculateTypeEffectiveness(['water'], ['fire']);
      expect(result.multiplier).toBe(2);
    });

    test('应该正确计算属性克制（草克水）', () => {
      const result = battleEngine.calculateTypeEffectiveness(['grass'], ['water']);
      expect(result.multiplier).toBe(2);
    });

    test('应该正确计算属性抵抗（火抵抗火）', () => {
      const result = battleEngine.calculateTypeEffectiveness(['fire'], ['fire']);
      expect(result.multiplier).toBe(0.5);
    });

    test('应该正确计算免疫（普通对幽灵无效）', () => {
      const result = battleEngine.calculateTypeEffectiveness(['normal'], ['ghost']);
      expect(result.multiplier).toBe(0);
    });

    test('应该正确计算多重属性', () => {
      const result = battleEngine.calculateTypeEffectiveness(['fire'], ['grass', 'ice']);
      // 火克草(2) * 火克冰(2) = 4
      expect(result.multiplier).toBe(4);
    });

    test('没有克制关系时应该返回 1', () => {
      const result = battleEngine.calculateTypeEffectiveness(['normal'], ['normal']);
      expect(result.multiplier).toBe(1);
    });
  });

  describe('calculateDamage', () => {
    const mockAttacker = {
      id: 'attacker-pokemon',
      species: 'Pikachu',
      level: 50,
      attack: 100,
      special_attack: 100,
      types: ['electric']
    };

    const mockDefender = {
      id: 'defender-pokemon',
      species: 'Squirtle',
      level: 50,
      defense: 80,
      special_defense: 80,
      types: ['water'],
      current_hp: 100,
      max_hp: 100
    };

    const mockMove = {
      id: 'move-1',
      name: 'Thunder Shock',
      type: 'electric',
      power: 40,
      accuracy: 100,
      category: 'special'
    };

    test('应该计算基础伤害', () => {
      const result = battleEngine.calculateDamage(mockAttacker, mockDefender, mockMove);
      
      expect(result.damage).toBeGreaterThan(0);
      expect(result.effectiveness).toBeDefined();
      expect(result.isCrit).toBeDefined();
    });

    test('应该应用 STAB 加成（同属性技能）', () => {
      const result = battleEngine.calculateDamage(mockAttacker, mockDefender, mockMove);
      
      // 电属性精灵使用电属性技能应该有 STAB 加成
      expect(result.damage).toBeGreaterThan(20);
    });

    test('应该应用属性克制', () => {
      // 电克水，伤害应该更高
      const result = battleEngine.calculateDamage(mockAttacker, mockDefender, mockMove);
      
      expect(result.effectiveness).toBe(2); // 电克水
      expect(result.effectivenessText).toBe('效果拔群！');
    });

    test('技能没有威力时应该使用默认值 40', () => {
      const moveNoPower = { ...mockMove, power: null };
      const result = battleEngine.calculateDamage(mockAttacker, mockDefender, moveNoPower);
      
      expect(result.damage).toBeGreaterThan(0);
    });

    test('伤害最小值应该为 1', () => {
      const weakMove = { ...mockMove, power: 1 };
      const strongDefender = { ...mockDefender, defense: 10000, special_defense: 10000 };
      
      const result = battleEngine.calculateDamage(mockAttacker, strongDefender, weakMove);
      
      expect(result.damage).toBeGreaterThanOrEqual(1);
    });
  });

  describe('determineTurnOrder', () => {
    const fastPokemon = {
      id: 'fast',
      species: 'FastPokemon',
      speed: 150,
      current_hp: 100,
      moves: []
    };

    const slowPokemon = {
      id: 'slow',
      species: 'SlowPokemon',
      speed: 50,
      current_hp: 100,
      moves: []
    };

    const mockMove = {
      id: 'move-1',
      name: 'Tackle',
      priority: 0
    };

    test('速度快的精灵应该先行动', () => {
      const result = battleEngine.determineTurnOrder(fastPokemon, slowPokemon, mockMove, mockMove);
      expect(result).toBe('attacker');
    });

    test('速度慢的精灵应该后行动', () => {
      const result = battleEngine.determineTurnOrder(slowPokemon, fastPokemon, mockMove, mockMove);
      expect(result).toBe('defender');
    });

    test('优先级高的技能应该先行动', () => {
      const priorityMove = { ...mockMove, priority: 1 };
      const result = battleEngine.determineTurnOrder(slowPokemon, fastPokemon, priorityMove, mockMove);
      
      expect(result).toBe('attacker');
    });

    test('麻痹状态应该降低速度', () => {
      const paralyzedPokemon = { ...fastPokemon, status: 'paralyze' };
      const result = battleEngine.determineTurnOrder(paralyzedPokemon, slowPokemon, mockMove, mockMove);
      
      // 麻痹降低 50% 速度：150 * 0.5 = 75 > 50
      // 所以麻痹的快精灵仍然先行动
      expect(result).toBe('attacker');
    });

    test('速度相同时应该随机决定', () => {
      const sameSpeed1 = { ...fastPokemon, speed: 100 };
      const sameSpeed2 = { ...slowPokemon, speed: 100 };
      
      let attackerFirst = 0;
      const trials = 100;
      
      for (let i = 0; i < trials; i++) {
        const result = battleEngine.determineTurnOrder(sameSpeed1, sameSpeed2, mockMove, mockMove);
        if (result === 'attacker') attackerFirst++;
      }
      
      // 应该接近 50%
      expect(attackerFirst).toBeGreaterThan(trials * 0.3);
      expect(attackerFirst).toBeLessThan(trials * 0.7);
    });
  });

  describe('selectDefenderMove', () => {
    const defender = {
      id: 'defender',
      species: 'Charizard',
      types: ['fire', 'flying'],
      moves: [
        { id: 'm1', name: 'Ember', type: 'fire', power: 40, accuracy: 100, category: 'special' },
        { id: 'm2', name: 'Air Slash', type: 'flying', power: 40, accuracy: 95, category: 'special' },
        { id: 'm3', name: 'Tackle', type: 'normal', power: 40, accuracy: 100, category: 'physical' }
      ]
    };

    const attacker = {
      id: 'attacker',
      species: 'Bulbasaur',
      types: ['grass', 'poison']
    };

    test('应该选择最优技能', () => {
      const result = battleEngine.selectDefenderMove(defender, attacker);
      
      // 应该选择火属性技能（克制草属性）
      expect(result.type).toBe('fire');
    });

    test('没有技能时应该返回挣扎', () => {
      const noMovesDefender = { ...defender, moves: [] };
      const result = battleEngine.selectDefenderMove(noMovesDefender, attacker);
      
      expect(result.name).toBe('挣扎');
      expect(result.type).toBe('normal');
    });

    test('应该考虑 STAB 加成', () => {
      // 火属性精灵使用火属性技能有 STAB 加成
      const result = battleEngine.selectDefenderMove(defender, attacker);
      
      expect(['fire', 'flying']).toContain(result.type);
    });
  });

  describe('executeTurn', () => {
    beforeEach(() => {
      // 设置攻击方队伍
      battleEngine.attacker.team = [{
        id: 'p1',
        species: 'Pikachu',
        level: 50,
        attack: 100,
        special_attack: 100,
        defense: 80,
        special_defense: 80,
        speed: 120,
        types: ['electric'],
        max_hp: 100,
        current_hp: 100,
        moves: [{
          id: 'm1',
          name: 'Thunder Shock',
          type: 'electric',
          power: 40,
          accuracy: 100,
          category: 'special'
        }]
      }];
      battleEngine.attacker.currentPokemon = battleEngine.attacker.team[0];

      // 设置防守方队伍
      battleEngine.defender.team = [{
        id: 'd1',
        species: 'Squirtle',
        level: 50,
        attack: 90,
        special_attack: 90,
        defense: 100,
        special_defense: 100,
        speed: 80,
        types: ['water'],
        max_hp: 120,
        current_hp: 120,
        moves: [{
          id: 'm2',
          name: 'Water Gun',
          type: 'water',
          power: 40,
          accuracy: 100,
          category: 'special'
        }]
      }];
      battleEngine.defender.currentPokemon = battleEngine.defender.team[0];
    });

    test('应该成功执行回合', async () => {
      const move = battleEngine.attacker.currentPokemon.moves[0];
      const result = await battleEngine.executeTurn(move);
      
      expect(result.turn).toBe(1);
      expect(result.actions).toBeDefined();
      expect(result.damage).toBeDefined();
      expect(battleEngine.turn).toBe(1);
    });

    test('应该记录回放数据', async () => {
      const move = battleEngine.attacker.currentPokemon.moves[0];
      await battleEngine.executeTurn(move);
      
      expect(battleEngine.replay.length).toBe(1);
      expect(battleEngine.replay[0].turn).toBe(1);
    });

    test('未命中时应该记录 miss', async () => {
      const lowAccuracyMove = {
        id: 'm3',
        name: 'Test Move',
        type: 'normal',
        power: 100,
        accuracy: 0, // 必定不命中
        category: 'physical'
      };
      
      const result = await battleEngine.executeTurn(lowAccuracyMove);
      
      const missAction = result.actions.find(a => a.type === 'miss');
      expect(missAction).toBeDefined();
    });

    test('伤害应该更新精灵 HP', async () => {
      const move = battleEngine.attacker.currentPokemon.moves[0];
      const initialHp = battleEngine.defender.currentPokemon.current_hp;
      
      await battleEngine.executeTurn(move);
      
      // 如果命中，HP 应该降低（除非未命中）
      // 由于伤害有随机性，我们只检查 HP 范围
      expect(battleEngine.defender.currentPokemon.current_hp).toBeLessThanOrEqual(initialHp);
    });
  });

  describe('getBattleResult', () => {
    beforeEach(() => {
      battleEngine.attacker.team = [{
        id: 'p1',
        species: 'Pikachu',
        max_hp: 100,
        current_hp: 100
      }];
      battleEngine.attacker.currentPokemon = battleEngine.attacker.team[0];
      
      battleEngine.defender.team = [{
        id: 'd1',
        species: 'Squirtle',
        max_hp: 120,
        current_hp: 0
      }];
      battleEngine.defender.currentPokemon = battleEngine.defender.team[0];
    });

    test('玩家胜利时应该返回胜利结果', () => {
      battleEngine.status = 'attacker_won';
      battleEngine.turn = 5;
      
      const result = battleEngine.getBattleResult();
      
      expect(result.result).toBe('win');
      expect(result.turns).toBe(5);
      expect(result.rewards).toBeDefined();
      expect(result.rewards.prestigeGained).toBeGreaterThan(0);
      expect(result.rewards.experienceGained).toBeGreaterThan(0);
      expect(result.rewards.coinsGained).toBeGreaterThan(0);
    });

    test('玩家失败时应该返回失败结果', () => {
      battleEngine.status = 'attacker_lost';
      battleEngine.turn = 3;
      
      const result = battleEngine.getBattleResult();
      
      expect(result.result).toBe('lose');
      expect(result.rewards).toBeNull();
    });

    test('应该计算战斗持续时间', () => {
      battleEngine.startTime = Date.now() - 60000; // 1 分钟前
      battleEngine.status = 'attacker_won';
      
      const result = battleEngine.getBattleResult();
      
      expect(result.duration).toBeGreaterThanOrEqual(60000);
    });
  });

  describe('序列化和反序列化', () => {
    test('应该正确序列化战斗状态', () => {
      battleEngine.turn = 5;
      battleEngine.status = 'ongoing';
      battleEngine.attacker.team = [{ id: 'p1', species: 'Pikachu' }];
      
      const serialized = battleEngine.serialize();
      const parsed = JSON.parse(serialized);
      
      expect(parsed.battleId).toBe(mockBattleId);
      expect(parsed.turn).toBe(5);
      expect(parsed.status).toBe('ongoing');
    });

    test('应该正确反序列化战斗状态', () => {
      battleEngine.turn = 7;
      battleEngine.status = 'ongoing';
      battleEngine.attacker.team = [{ id: 'p1', species: 'Pikachu', current_hp: 80 }];
      battleEngine.attacker.currentPokemon = battleEngine.attacker.team[0];
      
      const serialized = battleEngine.serialize();
      const restored = BattleEngine.deserialize(serialized);
      
      expect(restored.battleId).toBe(mockBattleId);
      expect(restored.turn).toBe(7);
      expect(restored.status).toBe('ongoing');
      expect(restored.attacker.team[0].species).toBe('Pikachu');
    });
  });
});

describe('TYPE_CHART', () => {
  test('应该包含所有主要属性', () => {
    const expectedTypes = [
      'normal', 'fire', 'water', 'electric', 'grass', 'ice',
      'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug',
      'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'
    ];
    
    expectedTypes.forEach(type => {
      expect(TYPE_CHART).toHaveProperty(type);
    });
  });

  test('克制关系应该正确', () => {
    // 火克草
    expect(TYPE_CHART.fire.grass).toBe(2);
    
    // 水克火
    expect(TYPE_CHART.water.fire).toBe(2);
    
    // 电克水
    expect(TYPE_CHART.electric.water).toBe(2);
    
    // 地面对电免疫
    expect(TYPE_CHART.electric.ground).toBe(0);
    
    // 幽灵对普通免疫
    expect(TYPE_CHART.ghost.normal).toBe(0);
  });
});

describe('STATUS_EFFECTS', () => {
  test('应该包含所有主要状态效果', () => {
    const expectedEffects = ['burn', 'paralyze', 'freeze', 'poison', 'toxic', 'sleep', 'confusion'];
    
    expectedEffects.forEach(effect => {
      expect(STATUS_EFFECTS).toHaveProperty(effect);
    });
  });

  test('灼伤应该有攻击力降低效果', () => {
    expect(STATUS_EFFECTS.burn.statModifier).toEqual({ attack: 0.5 });
    expect(STATUS_EFFECTS.burn.onTurnEnd).toBeDefined();
  });

  test('麻痹应该有速度降低效果', () => {
    expect(STATUS_EFFECTS.paralyze.statModifier).toEqual({ speed: 0.5 });
    expect(STATUS_EFFECTS.paralyze.canAct).toBeDefined();
  });

  test('睡眠应该阻止行动', () => {
    expect(STATUS_EFFECTS.sleep.canAct()).toBe(false);
    expect(STATUS_EFFECTS.sleep.duration).toBeDefined();
  });

  test('混乱应该有自伤概率', () => {
    expect(STATUS_EFFECTS.confusion.onAct).toBeDefined();
  });

  test('剧毒伤害应该递增', () => {
    const pokemon = { max_hp: 160 };
    
    const turn1 = STATUS_EFFECTS.toxic.onTurnEnd(pokemon, 1);
    expect(turn1.damage).toBe(Math.floor(160 * 1 / 16));
    
    const turn2 = STATUS_EFFECTS.toxic.onTurnEnd(pokemon, 2);
    expect(turn2.damage).toBe(Math.floor(160 * 2 / 16));
    
    const turn3 = STATUS_EFFECTS.toxic.onTurnEnd(pokemon, 3);
    expect(turn3.damage).toBe(Math.floor(160 * 3 / 16));
  });
});
