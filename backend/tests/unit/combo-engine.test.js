/**
 * 连击系统单元测试
 */

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const comboEngine = require('../../src/comboEngine');

describe('ComboEngine', () => {
  beforeEach(() => {
    // 重置引擎状态
    comboEngine.activeCombos.clear();
    
    // 加载测试连击链
    comboEngine.comboChains = new Map([
      ['THUNDER_TRINITY', {
        chain_id: 'THUNDER_TRINITY',
        name: '雷电三连',
        trigger_sequence: ['THUNDER_SHOCK', 'THUNDER_WAVE', 'THUNDERBOLT'],
        time_window_ms: 5000,
        damage_multiplier: 2.0,
        bonus_effects: { status: 'paralyzed', duration: 3 },
        combo_points: 3,
        min_trainer_level: 10,
        required_badges: 0
      }],
      ['FIRE_STORM', {
        chain_id: 'FIRE_STORM',
        name: '火焰风暴',
        trigger_sequence: ['FIRE_SPIN', 'FLAMETHROWER', 'FIRE_BLAST'],
        time_window_ms: 6000,
        damage_multiplier: 2.5,
        bonus_effects: { burn: true },
        combo_points: 4,
        min_trainer_level: 15,
        required_badges: 0
      }]
    ]);
  });

  describe('recordSkillUsage', () => {
    it('should trigger combo when sequence matches', async () => {
      const userId = 'user-123';
      const pokemonId = 'pokemon-456';
      const context = {
        trainerLevel: 20,
        badgeCount: 3
      };
      
      // 释放技能序列
      await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDER_SHOCK', context);
      await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDER_WAVE', context);
      const result = await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDERBOLT', context);
      
      expect(result.comboTriggered).to.be.true;
      expect(result.combo.chainId).to.equal('THUNDER_TRINITY');
      expect(result.effect.damageMultiplier).to.be.at.least(2.0);
      expect(result.effect.comboPoints).to.be.at.least(3);
    });

    it('should not trigger combo when sequence does not match', async () => {
      const userId = 'user-123';
      const pokemonId = 'pokemon-456';
      const context = { trainerLevel: 20 };
      
      // 错误的技能序列
      await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDER_SHOCK', context);
      await comboEngine.recordSkillUsage(userId, pokemonId, 'QUICK_ATTACK', context);
      const result = await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDERBOLT', context);
      
      expect(result.comboTriggered).to.be.false;
    });

    it('should evaluate combo quality correctly', async () => {
      const userId = 'user-123';
      const pokemonId = 'pokemon-456';
      const context = { trainerLevel: 20 };
      
      // 快速释放技能（模拟完美连击）
      await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDER_SHOCK', context);
      await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDER_WAVE', context);
      const result = await comboEngine.recordSkillUsage(userId, pokemonId, 'THUNDERBOLT', context);
      
      expect(['perfect', 'excellent', 'normal']).to.include(result.quality);
    });
  });

  describe('matchesSequence', () => {
    it('should match when sequence is correct', () => {
      const currentSequence = ['A', 'B', 'C', 'D'];
      const triggerSequence = ['B', 'C', 'D'];
      
      const result = comboEngine.matchesSequence(currentSequence, triggerSequence);
      expect(result).to.be.true;
    });

    it('should not match when sequence is incorrect', () => {
      const currentSequence = ['A', 'B', 'D', 'C'];
      const triggerSequence = ['B', 'C', 'D'];
      
      const result = comboEngine.matchesSequence(currentSequence, triggerSequence);
      expect(result).to.be.false;
    });

    it('should not match when sequence is too short', () => {
      const currentSequence = ['A', 'B'];
      const triggerSequence = ['A', 'B', 'C'];
      
      const result = comboEngine.matchesSequence(currentSequence, triggerSequence);
      expect(result).to.be.false;
    });
  });

  describe('evaluateComboQuality', () => {
    it('should return perfect for very fast execution', () => {
      const state = {
        sequence: [
          { skillId: 'A', timestamp: 0 },
          { skillId: 'B', timestamp: 1000 },
          { skillId: 'C', timestamp: 2000 }
        ]
      };
      const chain = { time_window_ms: 5000 };
      
      const quality = comboEngine.evaluateComboQuality(state, chain);
      expect(quality).to.equal('perfect');
    });

    it('should return excellent for moderately fast execution', () => {
      const state = {
        sequence: [
          { skillId: 'A', timestamp: 0 },
          { skillId: 'B', timestamp: 2500 },
          { skillId: 'C', timestamp: 3800 }
        ]
      };
      const chain = { time_window_ms: 5000 };
      
      const quality = comboEngine.evaluateComboQuality(state, chain);
      expect(quality).to.equal('excellent');
    });

    it('should return normal for slow execution', () => {
      const state = {
        sequence: [
          { skillId: 'A', timestamp: 0 },
          { skillId: 'B', timestamp: 3000 },
          { skillId: 'C', timestamp: 4500 }
        ]
      };
      const chain = { time_window_ms: 5000 };
      
      const quality = comboEngine.evaluateComboQuality(state, chain);
      expect(quality).to.equal('normal');
    });
  });

  describe('selectBestCombo', () => {
    it('should select combo with highest damage multiplier', () => {
      const combos = [
        { chain_id: 'A', damage_multiplier: 1.5, combo_points: 3 },
        { chain_id: 'B', damage_multiplier: 2.0, combo_points: 2 },
        { chain_id: 'C', damage_multiplier: 1.8, combo_points: 4 }
      ];
      
      const best = comboEngine.selectBestCombo(combos);
      expect(best.chain_id).to.equal('B');
    });

    it('should select combo with more points when damage is equal', () => {
      const combos = [
        { chain_id: 'A', damage_multiplier: 2.0, combo_points: 3 },
        { chain_id: 'B', damage_multiplier: 2.0, combo_points: 5 }
      ];
      
      const best = comboEngine.selectBestCombo(combos);
      expect(best.chain_id).to.equal('B');
    });
  });

  describe('applyComboEffect', () => {
    it('should apply perfect quality multiplier', async () => {
      const chain = {
        damage_multiplier: 2.0,
        bonus_effects: { status: 'paralyzed' },
        cooldown_reduction: 10,
        combo_points: 3,
        xp_bonus: 100
      };
      
      const effect = await comboEngine.applyComboEffect('user-123', 'pokemon-456', chain, 'perfect', {});
      
      expect(effect.damageMultiplier).to.equal(3.0); // 2.0 * 1.5
      expect(effect.comboPoints).to.equal(4); // Math.floor(3 * 1.5)
      expect(effect.xpBonus).to.equal(150); // Math.floor(100 * 1.5)
      expect(effect.bonusEffects.perfect_bonus).to.exist;
    });

    it('should apply excellent quality multiplier', async () => {
      const chain = {
        damage_multiplier: 2.0,
        combo_points: 3
      };
      
      const effect = await comboEngine.applyComboEffect('user-123', 'pokemon-456', chain, 'excellent', {});
      
      expect(effect.damageMultiplier).to.equal(2.5); // 2.0 * 1.25
      expect(effect.comboPoints).to.equal(3); // Math.floor(3 * 1.25)
    });

    it('should apply normal quality multiplier', async () => {
      const chain = {
        damage_multiplier: 2.0,
        combo_points: 3
      };
      
      const effect = await comboEngine.applyComboEffect('user-123', 'pokemon-456', chain, 'normal', {});
      
      expect(effect.damageMultiplier).to.equal(2.0); // 2.0 * 1.0
      expect(effect.comboPoints).to.equal(3); // 3 * 1.0
    });
  });

  describe('getAvailableComboChains', () => {
    it('should filter combos by trainer level', () => {
      const available = comboEngine.getAvailableComboChains(12);
      
      expect(available).to.have.length(1); // Only THUNDER_TRINITY (level 10)
      expect(available[0].chain_id).to.equal('THUNDER_TRINITY');
    });

    it('should return all combos for high level trainer', () => {
      const available = comboEngine.getAvailableComboChains(20);
      
      expect(available).to.have.length(2);
    });
  });
});
