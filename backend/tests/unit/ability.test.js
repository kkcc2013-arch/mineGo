/**
 * REQ-00086: 精灵特性系统单元测试
 */

const { describe, it, beforeEach, afterEach, expect } = require('@jest/globals');
const AbilityService = require('../../services/pokemon-service/src/abilityService');

// Mock dependencies
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    quit: jest.fn()
  }));
});

jest.mock('../../shared/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../shared/metrics', () => ({
  metrics: {
    gauge: jest.fn(),
    increment: jest.fn(),
    histogram: jest.fn()
  }
}));

describe('AbilityService', () => {
  let abilityService;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    jest.clearAllMocks();
    abilityService = new AbilityService();
    mockDb = abilityService.db;
    mockRedis = abilityService.redis;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('loadAbilityCache', () => {
    it('should load abilities into cache', async () => {
      const mockAbilities = [
        { id: 'intimidate', name_en: 'Intimidate', name_zh: '威吓', type: 'passive' },
        { id: 'blaze', name_en: 'Blaze', name_zh: '猛火', type: 'trigger' }
      ];

      mockDb.query.mockResolvedValueOnce({ rows: mockAbilities });

      await abilityService.loadAbilityCache();

      expect(abilityService.abilityCache.size).toBe(2);
      expect(abilityService.abilityCache.get('intimidate')).toEqual(mockAbilities[0]);
    });

    it('should handle errors gracefully', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Database error'));

      await expect(abilityService.loadAbilityCache()).resolves.not.toThrow();
    });
  });

  describe('getPokemonAbilities', () => {
    it('should return abilities from cache if available', async () => {
      const cachedAbilities = {
        normal: [{ id: 'static', nameZh: '静电' }],
        hidden: { id: 'lightning-rod', nameZh: '避雷针' }
      };

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(cachedAbilities));

      const result = await abilityService.getPokemonAbilities('pikachu');

      expect(result).toEqual(cachedAbilities);
      expect(mockRedis.get).toHaveBeenCalledWith('pokemon_abilities:pikachu');
    });

    it('should fetch from database and cache if not in cache', async () => {
      const mockDbResult = [
        { ability_id: 'static', name_en: 'Static', name_zh: '静电', slot: 1, is_hidden: false },
        { ability_id: 'lightning-rod', name_en: 'Lightning Rod', name_zh: '避雷针', slot: 3, is_hidden: true }
      ];

      mockRedis.get.mockResolvedValueOnce(null);
      mockDb.query.mockResolvedValueOnce({ rows: mockDbResult });

      const result = await abilityService.getPokemonAbilities('pikachu');

      expect(result.normal).toHaveLength(1);
      expect(result.normal[0].id).toBe('static');
      expect(result.hidden.id).toBe('lightning-rod');
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('assignAbilitiesToPokemon', () => {
    beforeEach(() => {
      abilityService.getPokemonAbilities = jest.fn().mockResolvedValue({
        normal: [
          { id: 'static', nameZh: '静电', slot: 1, probability: 0.5 },
          { id: 'quick-feet', nameZh: '飞毛腿', slot: 2, probability: 0.5 }
        ],
        hidden: { id: 'lightning-rod', nameZh: '避雷针', slot: 3 }
      });
    });

    it('should assign normal abilities correctly', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const result = await abilityService.assignAbilitiesToPokemon(123, 'pikachu');

      expect(result).toBeDefined();
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should assign hidden ability with specified probability', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      // Force hidden ability
      const result = await abilityService.assignAbilitiesToPokemon(123, 'pikachu', {
        forceHidden: true
      });

      expect(result.some(a => a.isHidden)).toBe(true);
    });
  });

  describe('switchAbility', () => {
    it('should switch to different ability slot', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValueOnce(mockClient);

      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, ability_id: 'static', slot: 1 }] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 1, ability_id: 'static', slot: 1, is_active: true }] }) // current
        .mockResolvedValueOnce({ rows: [{ id: 2, ability_id: 'quick-feet', slot: 2, is_active: false }] }) // target
        .mockResolvedValueOnce({}) // update
        .mockResolvedValueOnce({}); // COMMIT

      abilityService.abilityCache.set('quick-feet', { id: 'quick-feet', nameZh: '飞毛腿' });

      const result = await abilityService.switchAbility(123, 2);

      expect(result.success).toBe(true);
    });

    it('should throw error if switching to same ability', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValueOnce(mockClient);

      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 1, ability_id: 'static', slot: 1, is_active: true }] }) // current
        .mockResolvedValueOnce({ rows: [{ id: 1, ability_id: 'static', slot: 1, is_active: true }] }); // target

      await expect(abilityService.switchAbility(123, 1)).rejects.toThrow('Target ability is already active');
    });
  });

  describe('unlockHiddenAbility', () => {
    it('should unlock hidden ability successfully', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            ability_id: 'lightning-rod',
            name_en: 'Lightning Rod',
            name_zh: '避雷针',
            unlocked_at: null
          }]
        })
        .mockResolvedValueOnce({}) // update
        .mockResolvedValueOnce({}); // deactivate normal

      const result = await abilityService.unlockHiddenAbility(123);

      expect(result.success).toBe(true);
      expect(result.ability.id).toBe('lightning-rod');
    });

    it('should throw error if no hidden ability exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await expect(abilityService.unlockHiddenAbility(123)).rejects.toThrow('No hidden ability found');
    });

    it('should throw error if already unlocked', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          ability_id: 'lightning-rod',
          unlocked_at: '2026-06-01 00:00:00'
        }]
      });

      await expect(abilityService.unlockHiddenAbility(123)).rejects.toThrow('already unlocked');
    });
  });

  describe('checkTriggerCondition', () => {
    it('should return true for passive abilities', () => {
      const ability = { type: 'passive' };
      const result = abilityService.checkTriggerCondition(ability, {});

      expect(result.canTrigger).toBe(true);
    });

    it('should check HP threshold correctly', () => {
      const ability = {
        type: 'trigger',
        trigger_condition: { type: 'hp_threshold', threshold: 0.33 }
      };

      const lowHpContext = { currentHp: 30, maxHp: 100 };
      const result = abilityService.checkTriggerCondition(ability, lowHpContext);

      expect(result.canTrigger).toBe(true);
      expect(result.reason).toBe('hp_below_threshold');
    });

    it('should check weather condition correctly', () => {
      const ability = {
        type: 'trigger',
        trigger_condition: { type: 'weather', weather: 'rain' }
      };

      const rainContext = { weather: 'rain' };
      const result = abilityService.checkTriggerCondition(ability, rainContext);

      expect(result.canTrigger).toBe(true);
    });

    it('should check status condition correctly', () => {
      const ability = {
        type: 'trigger',
        trigger_condition: { type: 'status_condition', status: 'burn' }
      };

      const burnedContext = { statusEffects: ['burn', 'poison'] };
      const result = abilityService.checkTriggerCondition(ability, burnedContext);

      expect(result.canTrigger).toBe(true);
    });
  });

  describe('applyAbilityEffect', () => {
    beforeEach(() => {
      abilityService.abilityCache.set('intimidate', {
        id: 'intimidate',
        type: 'passive',
        effect_config: { type: 'stat_boost', stat: 'attack', multiplier: 0.9, target: 'opponent' }
      });

      abilityService.abilityCache.set('drizzle', {
        id: 'drizzle',
        type: 'environment',
        effect_config: { type: 'weather_change', weather: 'rain', duration: 5 }
      });
    });

    it('should apply stat boost effect', () => {
      const effects = abilityService.applyAbilityEffect('intimidate', { pokemonId: 1 }, { id: 'battle-1' });

      expect(effects).toHaveLength(1);
      expect(effects[0].type).toBe('stat_modifier');
      expect(effects[0].stat).toBe('attack');
    });

    it('should apply weather change effect', () => {
      const effects = abilityService.applyAbilityEffect('drizzle', { pokemonId: 1 }, { id: 'battle-1' });

      expect(effects).toHaveLength(1);
      expect(effects[0].type).toBe('weather');
      expect(effects[0].weather).toBe('rain');
    });

    it('should throw error for unknown ability', () => {
      expect(() => abilityService.applyAbilityEffect('unknown', {}, { id: 'battle-1' })).toThrow('not found');
    });
  });

  describe('registerTriggerHandlers', () => {
    it('should register all trigger types', () => {
      expect(abilityService.triggerHandlers.has('on_enter')).toBe(true);
      expect(abilityService.triggerHandlers.has('on_turn_start')).toBe(true);
      expect(abilityService.triggerHandlers.has('on_hit')).toBe(true);
      expect(abilityService.triggerHandlers.has('on_low_hp')).toBe(true);
      expect(abilityService.triggerHandlers.has('on_move')).toBe(true);
    });

    it('should return correct abilities for trigger type', () => {
      const enterAbilities = abilityService.getAbilitiesForTrigger('on_enter');

      expect(enterAbilities).toContain('intimidate');
      expect(enterAbilities).toContain('drizzle');
    });
  });

  describe('useAbilityItem', () => {
    it('should use ability capsule to switch ability', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ability_capsule', item_type: 'ability_capsule' }]
      });

      abilityService.switchAbility = jest.fn().mockResolvedValue({
        success: true,
        newAbility: { id: 'quick-feet', nameZh: '飞毛腿' }
      });

      const result = await abilityService.useAbilityItem('user-1', 123, 'ability_capsule');

      expect(result.success).toBe(true);
    });

    it('should use ability patch to unlock hidden ability', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ability_patch', item_type: 'ability_patch' }]
      });

      abilityService.unlockHiddenAbility = jest.fn().mockResolvedValue({
        success: true,
        ability: { id: 'lightning-rod', nameZh: '避雷针' }
      });

      const result = await abilityService.useAbilityItem('user-1', 123, 'ability_patch');

      expect(result.success).toBe(true);
    });
  });
});

describe('AbilityBattleIntegration', () => {
  // Battle integration tests would go here
  // Testing interaction with gym-service battle engine
});
