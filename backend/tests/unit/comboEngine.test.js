/**
 * ComboEngine 单元测试
 * 覆盖范围：连击序列检测、奖励计算、超时处理、并发隔离
 */

const { 
  createPokemon,
  createComboChain,
  createComboState
} = require('../factories/battleFactory');

// Mock 依赖
jest.mock('../../shared/db', () => {
  const mockTrx = {
    insert: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    merge: jest.fn().mockResolvedValue(true),
    commit: jest.fn().mockResolvedValue(true),
    rollback: jest.fn().mockResolvedValue(false)
  };
  
  const mockDb = jest.fn((table) => {
    const chain = {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      merge: jest.fn().mockResolvedValue(true),
      transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockTrx);
      }),
      raw: jest.fn((sql) => sql)
    };
    return chain;
  });
  
  mockDb.transaction = jest.fn().mockImplementation(async (callback) => {
    return callback(mockTrx);
  });
  
  return { __esModule: true, default: mockDb };
});

jest.mock('../../shared/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

jest.mock('../../shared/metrics', () => ({
  gauge: jest.fn(() => ({ set: jest.fn() })),
  increment: jest.fn(),
  startTimer: jest.fn(() => () => {})
}));

// 我们需要模拟 ComboEngine 类，因为它在模块加载时就执行了初始化
const ComboEngine = require('../../services/gym-service/src/comboEngine');

describe('ComboEngine', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    // 清理活跃连击状态
    ComboEngine.activeCombos.clear();
    // 预加载测试用连击链
    ComboEngine.comboChains.clear();
  });

  describe('getOrCreateState - 状态管理', () => {
    test('应该创建新的连击状态', () => {
      const stateKey = 'user1_pokemon1';
      const state = ComboEngine.getOrCreateState(stateKey);
      
      expect(state).toBeDefined();
      expect(state.sequence).toEqual([]);
      expect(state.lastUpdate).toBeGreaterThan(0);
    });

    test('应该返回已存在的状态', () => {
      const stateKey = 'user1_pokemon1';
      const state1 = ComboEngine.getOrCreateState(stateKey);
      state1.sequence.push({ skillId: 'skill1', timestamp: Date.now() });
      
      const state2 = ComboEngine.getOrCreateState(stateKey);
      
      expect(state2.sequence).toHaveLength(1);
      expect(state2).toBe(state1);
    });

    test('应该更新 lastUpdate 时间', async () => {
      const stateKey = 'user1_pokemon1';
      const state1 = ComboEngine.getOrCreateState(stateKey);
      const time1 = state1.lastUpdate;
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      ComboEngine.getOrCreateState(stateKey);
      
      expect(ComboEngine.activeCombos.get(stateKey).lastUpdate).toBeGreaterThan(time1);
    });
  });

  describe('matchesSequence - 序列匹配', () => {
    test('应该正确匹配完整序列', () => {
      const currentSequence = ['skill1', 'skill2', 'skill3'];
      const triggerSequence = ['skill1', 'skill2', 'skill3'];
      
      const result = ComboEngine.matchesSequence(currentSequence, triggerSequence);
      
      expect(result).toBe(true);
    });

    test('应该匹配序列末尾部分', () => {
      const currentSequence = ['skill0', 'skill1', 'skill2', 'skill3'];
      const triggerSequence = ['skill1', 'skill2', 'skill3'];
      
      const result = ComboEngine.matchesSequence(currentSequence, triggerSequence);
      
      expect(result).toBe(true);
    });

    test('当前序列较短时不匹配', () => {
      const currentSequence = ['skill1', 'skill2'];
      const triggerSequence = ['skill1', 'skill2', 'skill3'];
      
      const result = ComboEngine.matchesSequence(currentSequence, triggerSequence);
      
      expect(result).toBe(false);
    });

    test('序列不同时不匹配', () => {
      const currentSequence = ['skill1', 'skill2', 'wrong_skill'];
      const triggerSequence = ['skill1', 'skill2', 'skill3'];
      
      const result = ComboEngine.matchesSequence(currentSequence, triggerSequence);
      
      expect(result).toBe(false);
    });

    test('空序列应该匹配', () => {
      const currentSequence = [];
      const triggerSequence = [];
      
      const result = ComboEngine.matchesSequence(currentSequence, triggerSequence);
      
      expect(result).toBe(true);
    });
  });

  describe('checkTimeWindow - 时间窗口检查', () => {
    test('在时间窗口内应该返回 true', () => {
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 's1', timestamp: now },
          { skillId: 's2', timestamp: now + 1000 },
          { skillId: 's3', timestamp: now + 2000 }
        ]
      };
      const timeWindow = 5000;
      
      const result = ComboEngine.checkTimeWindow(state, timeWindow);
      
      expect(result).toBe(true);
    });

    test('超过时间窗口应该返回 false', () => {
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 's1', timestamp: now },
          { skillId: 's2', timestamp: now + 4000 },
          { skillId: 's3', timestamp: now + 6000 }
        ]
      };
      const timeWindow = 5000;
      
      const result = ComboEngine.checkTimeWindow(state, timeWindow);
      
      expect(result).toBe(false);
    });

    test('空序列应该返回 false', () => {
      const state = { sequence: [] };
      const timeWindow = 5000;
      
      const result = ComboEngine.checkTimeWindow(state, timeWindow);
      
      expect(result).toBe(false);
    });

    test('单技能应该总在窗口内', () => {
      const now = Date.now();
      const state = {
        sequence: [{ skillId: 's1', timestamp: now }]
      };
      const timeWindow = 5000;
      
      const result = ComboEngine.checkTimeWindow(state, timeWindow);
      
      expect(result).toBe(true);
    });
  });

  describe('checkComboMatch - 连击匹配检查', () => {
    test('应该匹配配置的连击链', async () => {
      // 添加测试连击链
      const chain = createComboChain({
        chain_id: 'test-chain-1',
        trigger_sequence: ['fire_blast', 'flamethrower', 'fire_spin'],
        time_window_ms: 5000,
        min_trainer_level: 1,
        required_badges: 0
      });
      ComboEngine.comboChains.set('test-chain-1', chain);
      
      // 设置状态匹配
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 'fire_blast', timestamp: now },
          { skillId: 'flamethrower', timestamp: now + 1000 },
          { skillId: 'fire_spin', timestamp: now + 2000 }
        ]
      };
      
      const context = {
        trainerLevel: 10,
        badgeCount: 5
      };
      
      const matches = await ComboEngine.checkComboMatch(state, context);
      
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].chain_id).toBe('test-chain-1');
    });

    test('元素要求不满足不应该匹配', async () => {
      const chain = createComboChain({
        chain_id: 'fire-chain',
        trigger_sequence: ['fire1', 'fire2'],
        element_requirement: 'fire',
        time_window_ms: 10000
      });
      ComboEngine.comboChains.set('fire-chain', chain);
      
      const state = {
        sequence: [
          { skillId: 'fire1', timestamp: Date.now() },
          { skillId: 'fire2', timestamp: Date.now() + 100 }
        ]
      };
      
      const context = { element: 'water', trainerLevel: 10, badgeCount: 0 };
      
      const matches = await ComboEngine.checkComboMatch(state, context);
      
      expect(matches.length).toBe(0);
    });

    test('等级不足不应该匹配', async () => {
      const chain = createComboChain({
        chain_id: 'high-level-chain',
        trigger_sequence: ['skill1', 'skill2'],
        min_trainer_level: 50,
        time_window_ms: 10000
      });
      ComboEngine.comboChains.set('high-level-chain', chain);
      
      const state = {
        sequence: [
          { skillId: 'skill1', timestamp: Date.now() },
          { skillId: 'skill2', timestamp: Date.now() + 100 }
        ]
      };
      
      const context = { trainerLevel: 10, badgeCount: 0 };
      
      const matches = await ComboEngine.checkComboMatch(state, context);
      
      expect(matches.length).toBe(0);
    });

    test('徽章不足不应该匹配', async () => {
      const chain = createComboChain({
        chain_id: 'badge-chain',
        trigger_sequence: ['skill1', 'skill2'],
        required_badges: 10,
        time_window_ms: 10000
      });
      ComboEngine.comboChains.set('badge-chain', chain);
      
      const state = {
        sequence: [
          { skillId: 'skill1', timestamp: Date.now() },
          { skillId: 'skill2', timestamp: Date.now() + 100 }
        ]
      };
      
      const context = { trainerLevel: 50, badgeCount: 5 };
      
      const matches = await ComboEngine.checkComboMatch(state, context);
      
      expect(matches.length).toBe(0);
    });
  });

  describe('selectBestCombo - 最优连击选择', () => {
    test('应该选择伤害倍率最高的连击', () => {
      const combos = [
        createComboChain({ chain_id: 'chain1', damage_multiplier: 1.5 }),
        createComboChain({ chain_id: 'chain2', damage_multiplier: 2.0 }),
        createComboChain({ chain_id: 'chain3', damage_multiplier: 1.2 })
      ];
      
      const best = ComboEngine.selectBestCombo(combos);
      
      expect(best.chain_id).toBe('chain2');
    });

    test('相同倍率应该选择连击点数高的', () => {
      const combos = [
        createComboChain({ chain_id: 'chain1', damage_multiplier: 1.5, combo_points: 50 }),
        createComboChain({ chain_id: 'chain2', damage_multiplier: 1.5, combo_points: 100 })
      ];
      
      const best = ComboEngine.selectBestCombo(combos);
      
      expect(best.chain_id).toBe('chain2');
    });

    test('单个连击应该直接返回', () => {
      const combo = createComboChain({ chain_id: 'single' });
      
      const result = ComboEngine.selectBestCombo([combo]);
      
      expect(result.chain_id).toBe('single');
    });
  });

  describe('evaluateComboQuality - 连击质量评估', () => {
    test('半时间内完成应该是完美连击', () => {
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 's1', timestamp: now },
          { skillId: 's3', timestamp: now + 2000 } // 2 秒内完成
        ]
      };
      const chain = { time_window_ms: 10000 }; // 10 秒窗口
      
      const quality = ComboEngine.evaluateComboQuality(state, chain);
      
      expect(quality).toBe('perfect');
    });

    test('80% 时间内完成应该是优秀连击', () => {
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 's1', timestamp: now },
          { skillId: 's3', timestamp: now + 7000 } // 7 秒
        ]
      };
      const chain = { time_window_ms: 10000 }; // 10 秒窗口
      
      const quality = ComboEngine.evaluateComboQuality(state, chain);
      
      expect(quality).toBe('excellent');
    });

    test('接近时间上限应该是普通连击', () => {
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 's1', timestamp: now },
          { skillId: 's3', timestamp: now + 9000 } // 9 秒
        ]
      };
      const chain = { time_window_ms: 10000 }; // 10 秒窗口
      
      const quality = ComboEngine.evaluateComboQuality(state, chain);
      
      expect(quality).toBe('normal');
    });
  });

  describe('applyComboEffect - 连击效果应用', () => {
    test('完美连击应该有 1.5x 加成', async () => {
      const chain = createComboChain({
        damage_multiplier: 1.5,
        combo_points: 100,
        xp_bonus: 50,
        cooldown_reduction: 10,
        bonus_effects: { extra_damage: 20 }
      });
      
      const effect = await ComboEngine.applyComboEffect(
        'user1', 'pokemon1', chain, 'perfect', {}
      );
      
      expect(effect.damageMultiplier).toBe(1.5 * 1.5); // chain * quality
      expect(effect.quality).toBe('perfect');
      expect(effect.comboPoints).toBe(150); // 100 * 1.5
    });

    test('优秀连击应该有 1.25x 加成', async () => {
      const chain = createComboChain({
        damage_multiplier: 1.5,
        combo_points: 100
      });
      
      const effect = await ComboEngine.applyComboEffect(
        'user1', 'pokemon1', chain, 'excellent', {}
      );
      
      expect(effect.damageMultiplier).toBe(1.5 * 1.25);
      expect(effect.comboPoints).toBe(125); // 100 * 1.25
    });

    test('普通连击应该有 1.0x 加成', async () => {
      const chain = createComboChain({
        damage_multiplier: 1.5,
        combo_points: 100
      });
      
      const effect = await ComboEngine.applyComboEffect(
        'user1', 'pokemon1', chain, 'normal', {}
      );
      
      expect(effect.damageMultiplier).toBe(1.5);
      expect(effect.comboPoints).toBe(100);
    });

    test('完美连击应该有额外奖励', async () => {
      const chain = createComboChain({
        damage_multiplier: 1.0,
        combo_points: 50
      });
      
      const effect = await ComboEngine.applyComboEffect(
        'user1', 'pokemon1', chain, 'perfect', {}
      );
      
      expect(effect.bonusEffects.perfect_bonus).toBeDefined();
      expect(effect.bonusEffects.perfect_bonus.crit_rate_boost).toBe(20);
      expect(effect.bonusEffects.perfect_bonus.accuracy_boost).toBe(10);
    });
  });

  describe('isTimeout - 超时检查', () => {
    test('超过默认窗口 2x 应该超时', () => {
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 's1', timestamp: now - 15000 } // 15 秒前
        ]
      };
      
      const result = ComboEngine.isTimeout(state);
      
      expect(result).toBe(true);
    });

    test('在时间窗口内不应该超时', () => {
      const now = Date.now();
      const state = {
        sequence: [
          { skillId: 's1', timestamp: now - 3000 } // 3 秒前
        ]
      };
      
      const result = ComboEngine.isTimeout(state);
      
      expect(result).toBe(false);
    });

    test('空序列不应该超时', () => {
      const state = { sequence: [] };
      
      const result = ComboEngine.isTimeout(state);
      
      expect(result).toBe(false);
    });
  });

  describe('resetState - 状态重置', () => {
    test('应该删除活跃状态', () => {
      const stateKey = 'user1_pokemon1';
      ComboEngine.activeCombos.set(stateKey, { sequence: [] });
      
      ComboEngine.resetState(stateKey);
      
      expect(ComboEngine.activeCombos.has(stateKey)).toBe(false);
    });

    test('重置不存在状态不应该报错', () => {
      expect(() => {
        ComboEngine.resetState('nonexistent_key');
      }).not.toThrow();
    });
  });

  describe('getActiveState - 获取活跃状态', () => {
    test('应该返回存在的状态', () => {
      const stateKey = 'user1_pokemon1';
      const state = { sequence: ['s1'] };
      ComboEngine.activeCombos.set(stateKey, state);
      
      const result = ComboEngine.getActiveState('user1', 'pokemon1');
      
      expect(result).toBe(state);
    });

    test('不存在的状态应该返回 undefined', () => {
      const result = ComboEngine.getActiveState('unknown', 'pokemon');
      
      expect(result).toBeUndefined();
    });
  });

  describe('getAllComboChains - 获取所有连击链', () => {
    test('应该返回所有连击链', () => {
      ComboEngine.comboChains.set('chain1', { chain_id: 'chain1' });
      ComboEngine.comboChains.set('chain2', { chain_id: 'chain2' });
      
      const chains = ComboEngine.getAllComboChains();
      
      expect(chains.length).toBe(2);
      expect(chains.map(c => c.chain_id)).toContain('chain1');
      expect(chains.map(c => c.chain_id)).toContain('chain2');
    });

    test('空连击链应该返回空数组', () => {
      ComboEngine.comboChains.clear();
      
      const chains = ComboEngine.getAllComboChains();
      
      expect(chains).toEqual([]);
    });
  });

  describe('getAvailableComboChains - 过滤可用连击', () => {
    test('应该过滤等级不足的连击', () => {
      ComboEngine.comboChains.set('chain1', { 
        chain_id: 'chain1', 
        min_trainer_level: 50, 
        required_badges: 0 
      });
      ComboEngine.comboChains.set('chain2', { 
        chain_id: 'chain2', 
        min_trainer_level: 10, 
        required_badges: 0 
      });
      
      const available = ComboEngine.getAvailableComboChains(20, 0);
      
      expect(available.length).toBe(1);
      expect(available[0].chain_id).toBe('chain2');
    });

    test('应该过滤徽章不足的连击', () => {
      ComboEngine.comboChains.set('chain1', { 
        chain_id: 'chain1', 
        min_trainer_level: 1, 
        required_badges: 10 
      });
      ComboEngine.comboChains.set('chain2', { 
        chain_id: 'chain2', 
        min_trainer_level: 1, 
        required_badges: 5 
      });
      
      const available = ComboEngine.getAvailableComboChains(1, 7);
      
      expect(available.length).toBe(1);
      expect(available[0].chain_id).toBe('chain2');
    });
  });

  describe('getComboChainDetails - 获取连击详情', () => {
    test('应该返回存在的连击详情', () => {
      const chain = createComboChain({ chain_id: 'test-chain' });
      ComboEngine.comboChains.set('test-chain', chain);
      
      const result = ComboEngine.getComboChainDetails('test-chain');
      
      expect(result).toBe(chain);
    });

    test('不存在的连击应该返回 undefined', () => {
      const result = ComboEngine.getComboChainDetails('nonexistent');
      
      expect(result).toBeUndefined();
    });
  });

  describe('recordSkillUsage - 完整流程测试', () => {
    test('完整连击触发流程', async () => {
      // 设置连击链
      const chain = createComboChain({
        chain_id: 'fire-combo',
        trigger_sequence: ['fire1', 'fire2', 'fire3'],
        time_window_ms: 10000,
        damage_multiplier: 2.0,
        combo_points: 100,
        min_trainer_level: 1,
        required_badges: 0
      });
      ComboEngine.comboChains.set('fire-combo', chain);
      
      // Mock recordComboExecution 方法避免数据库操作
      ComboEngine.recordComboExecution = jest.fn().mockResolvedValue(true);
      
      // 记录前两个技能
      await ComboEngine.recordSkillUsage('user1', 'pokemon1', 'fire1', { trainerLevel: 10 });
      await ComboEngine.recordSkillUsage('user1', 'pokemon1', 'fire2', { trainerLevel: 10 });
      
      // 第三个技能触发连击
      const result = await ComboEngine.recordSkillUsage('user1', 'pokemon1', 'fire3', {
        trainerLevel: 10,
        badgeCount: 0,
        baseDamage: 50
      });
      
      expect(result.comboTriggered).toBe(true);
      expect(result.combo.chainId).toBe('fire-combo');
      expect(result.effect.damageMultiplier).toBeDefined();
    });

    test('不完整序列不应该触发连击', async () => {
      ComboEngine.comboChains.set('test', createComboChain({
        trigger_sequence: ['a', 'b', 'c'],
        time_window_ms: 10000,
        min_trainer_level: 1,
        required_badges: 0
      }));
      
      const result = await ComboEngine.recordSkillUsage('user1', 'pokemon1', 'a', {
        trainerLevel: 10
      });
      
      expect(result.comboTriggered).toBe(false);
    });

    test('不同用户的序列应该隔离', async () => {
      const chain = createComboChain({
        trigger_sequence: ['x', 'y'],
        time_window_ms: 10000,
        min_trainer_level: 1,
        required_badges: 0
      });
      ComboEngine.comboChains.set('test', chain);
      
      // user1
      await ComboEngine.recordSkillUsage('user1', 'pokemon1', 'x', { trainerLevel: 10 });
      
      // user2
      await ComboEngine.recordSkillUsage('user2', 'pokemon1', 'x', { trainerLevel: 10 });
      
      // 验证状态隔离
      expect(ComboEngine.activeCombos.has('user1_pokemon1')).toBe(true);
      expect(ComboEngine.activeCombos.has('user2_pokemon1')).toBe(true);
      expect(ComboEngine.activeCombos.get('user1_pokemon1')).not.toBe(
        ComboEngine.activeCombos.get('user2_pokemon1')
      );
    });
  });

  describe('Performance - 性能测试', () => {
    test('序列匹配应该高效', () => {
      const currentSequence = Array(100).fill('skill');
      const triggerSequence = Array(10).fill('skill');
      
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        ComboEngine.matchesSequence(currentSequence, triggerSequence);
      }
      const elapsed = performance.now() - start;
      
      // 10000 次 < 100ms
      expect(elapsed).toBeLessThan(100);
    });

    test('连击质量评估应该高效', () => {
      const state = {
        sequence: [
          { skillId: 's1', timestamp: Date.now() },
          { skillId: 's2', timestamp: Date.now() + 1000 }
        ]
      };
      const chain = { time_window_ms: 5000 };
      
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        ComboEngine.evaluateComboQuality(state, chain);
      }
      const elapsed = performance.now() - start;
      
      // 10000 次 < 50ms
      expect(elapsed).toBeLessThan(50);
    });
  });
});