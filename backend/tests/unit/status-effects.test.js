/**
 * REQ-00090: 精灵状态效果系统与战斗Buff/Debuff管理 - 单元测试
 */
'use strict';

const StatusEffectEngine = require('../../services/pokemon-service/src/statusEffectEngine');
const { query } = require('../../shared/db');

// Mock shared db module
jest.mock('../../shared/db', () => ({
  query: jest.fn()
}));

// Mock shared logger
jest.mock('../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  })
}));

describe('StatusEffectEngine', () => {
  let engine;
  let mockRedis;
  
  const mockStatuses = [
    { id: 1, code: 'burn', name: '灼伤', category: 'control', description: 'desc', max_stacks: 1, duration_type: 'turns', default_duration: null, dispellable: true, priority: 10, mutually_exclusive_with: [] },
    { id: 2, code: 'paralysis', name: '麻痹', category: 'control', description: 'desc', max_stacks: 1, duration_type: 'turns', default_duration: null, dispellable: true, priority: 10, mutually_exclusive_with: [] },
    { id: 3, code: 'sleep', name: '睡眠', category: 'control', description: 'desc', max_stacks: 1, duration_type: 'turns', default_duration: 2, dispellable: true, priority: 15, mutually_exclusive_with: [] },
    { id: 4, code: 'toxic', name: '剧毒', category: 'dot', description: 'desc', max_stacks: 1, duration_type: 'turns', default_duration: null, dispellable: true, priority: 10, mutually_exclusive_with: [] },
    { id: 5, code: 'attack_up', name: '攻击提升', category: 'stat_change', description: 'desc', max_stacks: 6, duration_type: 'permanent', default_duration: null, dispellable: true, priority: 3, mutually_exclusive_with: [] },
    { id: 6, code: 'misty_terrain', name: '薄雾场地', category: 'field', description: 'desc', max_stacks: 1, duration_type: 'turns', default_duration: 5, dispellable: false, priority: 1, mutually_exclusive_with: [] },
    { id: 7, code: 'confusion', name: '混乱', category: 'control', description: 'desc', max_stacks: 1, duration_type: 'turns', default_duration: 2, dispellable: true, priority: 5, mutually_exclusive_with: [] },
    { id: 8, code: 'flinch', name: '畏缩', category: 'control', description: 'desc', max_stacks: 1, duration_type: 'turns', default_duration: 1, dispellable: false, priority: 20, mutually_exclusive_with: [] }
  ];

  const mockMechanics = [
    { id: 1, status_id: 1, mechanic_type: 'damage', trigger_event: 'turn_end', calculation_formula: 'Math.floor(MAX_HP / 8)', conditions: {} },
    { id: 2, status_id: 4, mechanic_type: 'damage', trigger_event: 'turn_end', calculation_formula: 'Math.floor(MAX_HP * STACKS / 16)', conditions: {} }
  ];

  const mockTypeImmunities = [
    { type_id: 10, status_id: 1, immunity_type: 'complete', status_code: 'burn' } // Fire immune to Burn
  ];

  const mockAbilityImmunities = [
    { ability_id: 100, status_id: 2, immunity_type: 'complete', status_code: 'paralysis' } // Limber immune to Paralysis
  ];

  beforeEach(() => {
    jest.resetAllMocks();
    
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([])
    };

    engine = new StatusEffectEngine(mockRedis);

    // Mock query logic for initialization (checking specific tables first to avoid join mismatch)
    query.mockImplementation((sql, params) => {
      if (sql.includes('type_status_immunities')) {
        return Promise.resolve({ rows: mockTypeImmunities });
      }
      if (sql.includes('ability_status_immunities')) {
        return Promise.resolve({ rows: mockAbilityImmunities });
      }
      if (sql.includes('status_effect_mechanics')) {
        return Promise.resolve({ rows: mockMechanics });
      }
      if (sql.includes('status_effect_definitions')) {
        return Promise.resolve({ rows: mockStatuses });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  describe('initialize', () => {
    test('should cache status definitions, mechanics, and immunities', async () => {
      await engine.initialize();
      expect(engine.initialized).toBe(true);
      expect(engine.statusCache.has('burn')).toBe(true);
      expect(engine.statusCache.has('id_1')).toBe(true);
      expect(engine.mechanicsCache.get(1)).toHaveLength(1);
      expect(engine.immunityCache.has('type_10_burn')).toBe(true);
      expect(engine.immunityCache.has('ability_100_paralysis')).toBe(true);
    });
  });

  describe('canApplyStatus', () => {
    beforeEach(async () => {
      await engine.initialize();
    });

    test('should allow applying status under normal conditions', async () => {
      const target = { battle_id: 'b1', instance_id: 1, type_id: 1, ability_id: 1 };
      query.mockResolvedValueOnce({ rows: [] }); // no existing status
      const result = await engine.canApplyStatus(target, 'burn');
      expect(result.canApply).toBe(true);
    });

    test('should block if type is immune', async () => {
      const target = { battle_id: 'b1', instance_id: 1, type_id: 10, ability_id: 1 }; // Fire type
      query.mockResolvedValueOnce({ rows: [] });
      const result = await engine.canApplyStatus(target, 'burn');
      expect(result.canApply).toBe(false);
      expect(result.reason).toContain('属性免疫');
    });

    test('should block if ability is immune', async () => {
      const target = { battle_id: 'b1', instance_id: 1, type_id: 1, ability_id: 100 }; // Limber
      query.mockResolvedValueOnce({ rows: [] });
      const result = await engine.canApplyStatus(target, 'paralysis');
      expect(result.canApply).toBe(false);
      expect(result.reason).toContain('特性免疫');
    });

    test('should block if status already exists and max_stacks is 1', async () => {
      const target = { battle_id: 'b1', instance_id: 1, type_id: 1, ability_id: 1 };
      query.mockResolvedValueOnce({ rows: [{ code: 'burn', status_id: 1 }] }); // existing burn
      const result = await engine.canApplyStatus(target, 'burn');
      expect(result.canApply).toBe(false);
      expect(result.reason).toBe('已存在该状态');
    });
  });

  describe('applyStatus', () => {
    beforeEach(async () => {
      await engine.initialize();
    });

    test('should successfully apply control status and write to db/cache', async () => {
      const targetId = 123;
      const battleId = 'b1';
      
      // Mock canApplyStatus check (no existing status)
      query.mockResolvedValueOnce({ rows: [] }); // getPokemonStatuses in canApplyStatus
      // Mock INSERT query returning status ID
      query.mockResolvedValueOnce({ rows: [{ id: 999 }] });

      const result = await engine.applyStatus(battleId, targetId, 'sleep', {
        targetTypeId: 1,
        targetAbilityId: 1
      });

      expect(result.success).toBe(true);
      expect(result.statusId).toBe(999);
      expect(result.statusCode).toBe('sleep');
      expect(result.duration).toBeGreaterThanOrEqual(1);
      expect(result.duration).toBeLessThanOrEqual(3);
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    test('should call applyStatChange for status of category stat_change', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // check existing stat stage
      query.mockResolvedValueOnce({ rows: [] }); // insert/upsert stat stage

      const result = await engine.applyStatus('b1', 123, 'attack_up', { stacks: 2 });
      expect(result.success).toBe(true);
      expect(result.statType).toBe('attack');
      expect(result.newStage).toBe(2);
    });
  });

  describe('applyStatChange', () => {
    beforeEach(async () => {
      await engine.initialize();
    });

    test('should stack stages up to 6', async () => {
      query.mockResolvedValueOnce({ rows: [{ stage: 4 }] }); // existing stage
      query.mockResolvedValueOnce({ rows: [] }); // update query

      const result = await engine.applyStatChange('b1', 123, 'attack_up', 3);
      expect(result.success).toBe(true);
      expect(result.newStage).toBe(6); // capped at 6
      expect(result.delta).toBe(2); // delta 6-4=2
    });

    test('should stack negative stages down to -6', async () => {
      query.mockResolvedValueOnce({ rows: [{ stage: -5 }] });
      query.mockResolvedValueOnce({ rows: [] });

      const result = await engine.applyStatChange('b1', 123, 'attack_down', 3);
      expect(result.success).toBe(true);
      expect(result.newStage).toBe(-6); // capped at -6
      expect(result.delta).toBe(-1);
    });

    test('should fail if stat is already at maximum level', async () => {
      query.mockResolvedValueOnce({ rows: [{ stage: 6 }] });

      const result = await engine.applyStatChange('b1', 123, 'attack_up', 1);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('能力已达极限');
    });
  });

  describe('checkActionBlocked', () => {
    beforeEach(async () => {
      await engine.initialize();
    });

    test('should block action under sleep or freeze', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { status_id: 3, code: 'sleep', name: '睡眠', category: 'control' }
        ]
      });

      const result = await engine.checkActionBlocked('b1', 123, 'move');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('睡眠状态');
    });

    test('should support paralysis 25% random block', async () => {
      query.mockResolvedValue({
        rows: [
          { status_id: 2, code: 'paralysis', name: '麻痹', category: 'control' }
        ]
      });

      // Stub Math.random to always block
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.1);
      let result = await engine.checkActionBlocked('b1', 123, 'move');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('麻痹发作');

      // Stub Math.random to pass
      Math.random.mockReturnValue(0.8);
      result = await engine.checkActionBlocked('b1', 123, 'move');
      expect(result.blocked).toBe(false);

      randomSpy.mockRestore();
    });
  });

  describe('onTurnEnd', () => {
    beforeEach(async () => {
      await engine.initialize();
    });

    test('should tick duration and remove when expired', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { id: 77, status_id: 3, code: 'sleep', name: '睡眠', category: 'control', remaining_turns: 1 }
        ]
      }); // getPokemonStatuses
      query.mockResolvedValueOnce({ rows: [] }); // delete query in removeStatus

      const results = await engine.onTurnEnd('b1', 123, 1, { max_hp: 100, current_hp: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('status_expired');
      expect(results[0].statusCode).toBe('sleep');
    });

    test('should execute damage DOT and update toxic metadata', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { id: 88, status_id: 4, code: 'toxic', name: '剧毒', category: 'dot', remaining_turns: null, metadata: { toxic_stacks: 2 } }
        ]
      }); // getPokemonStatuses
      query.mockResolvedValueOnce({ rows: [] }); // update toxic stacks query

      const results = await engine.onTurnEnd('b1', 123, 1, { max_hp: 160, current_hp: 100 });
      
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('damage');
      expect(results[0].statusCode).toBe('toxic');
      // 160 * 2 / 16 = 20
      expect(results[0].value).toBe(20);
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE battle_pokemon_status'), [3, 88]); // toxic_stacks incremented to 3
    });
  });

  describe('dispelStatuses', () => {
    beforeEach(async () => {
      await engine.initialize();
    });

    test('should only remove dispellable statuses', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { id: 10, status_id: 1, code: 'burn', name: '灼伤', category: 'control', dispellable: true },
          { id: 11, status_id: 8, code: 'flinch', name: '畏缩', category: 'control', dispellable: false }
        ]
      }); // getPokemonStatuses

      query.mockResolvedValue({ rows: [] }); // delete query

      const removed = await engine.dispelStatuses('b1', 123);
      expect(removed).toHaveLength(1);
      expect(removed[0].code).toBe('burn');
      expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM battle_pokemon_status'), ['b1', 123, 1]); // Burn definition id is 1
    });
  });
});
