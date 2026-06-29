/**
 * REQ-00086: 精灵特性系统单元测试
 */

const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');
const AbilityService = require('../src/abilityService');

// Mock dependencies
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

jest.mock('ioredis', () => {
  return jest.fn(() => ({
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    quit: jest.fn()
  }));
});

describe('AbilityService', () => {
  let abilityService;
  let mockDb;
  let mockRedis;

  beforeAll(() => {
    abilityService = new AbilityService();
    mockDb = abilityService.db;
    mockRedis = abilityService.redis;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // 初始化特性缓存
    abilityService.abilityCache.set('blaze', {
      id: 'blaze',
      name_en: 'Blaze',
      name_zh: '猛火',
      type: 'trigger',
      description: 'HP低于1/3时火系技能威力提升50%',
      trigger_condition: { type: 'hp_threshold', threshold: 0.333 },
      effect_config: { type: 'damage_modifier', move_type: 'fire', multiplier: 1.5 }
    });
    
    abilityService.abilityCache.set('intimidate', {
      id: 'intimidate',
      name_en: 'Intimidate',
      name_zh: '威吓',
      type: 'passive',
      description: '出场时降低对手攻击',
      trigger_condition: { trigger: 'on_enter' },
      effect_config: { type: 'stat_boost', target: 'opponent', stat: 'attack', stage: -1 }
    });
    
    abilityService.abilityCache.set('levitate', {
      id: 'levitate',
      name_en: 'Levitate',
      name_zh: '漂浮',
      type: 'immunity',
      description: '免疫地面系技能',
      trigger_condition: null,
      effect_config: { type: 'immune', to: ['ground'] }
    });
  });

  afterAll(async () => {
    await abilityService.close();
  });

  describe('getAbility', () => {
    it('should return ability from cache', () => {
      const ability = abilityService.getAbility('blaze');
      
      expect(ability).toBeDefined();
      expect(ability.id).toBe('blaze');
      expect(ability.name_zh).toBe('猛火');
    });

    it('should return undefined for non-existent ability', () => {
      const ability = abilityService.getAbility('non_existent');
      
      expect(ability).toBeUndefined();
    });
  });

  describe('getAllAbilities', () => {
    it('should return all abilities from cache', () => {
      const abilities = abilityService.getAllAbilities();
      
      expect(abilities).toBeInstanceOf(Array);
      expect(abilities.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('getPokemonAbilities', () => {
    it('should return abilities from cache if available', async () => {
      const speciesId = 'pikachu';
      const cachedData = {
        normal: [{ id: 'static', nameZh: '静电' }],
        hidden: { id: 'lightning_rod', nameZh: '避雷针' }
      };
      
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));
      
      const abilities = await abilityService.getPokemonAbilities(speciesId);
      
      expect(abilities).toEqual(cachedData);
      expect(mockRedis.get).toHaveBeenCalledWith(`pokemon_abilities:${speciesId}`);
    });

    it('should query database and cache result if not in cache', async () => {
      const speciesId = 'charizard';
      
      mockRedis.get.mockResolvedValue(null);
      mockDb.query.mockResolvedValue({
        rows: [
          {
            ability_id: 'blaze',
            name_en: 'Blaze',
            name_zh: '猛火',
            type: 'trigger',
            description: 'HP低于1/3时火系技能威力提升50%',
            slot: 1,
            probability: 1.0,
            is_hidden: false
          },
          {
            ability_id: 'solar_power',
            name_en: 'Solar Power',
            name_zh: '太阳之力',
            type: 'trigger',
            description: '晴天时特攻提升但每回合损失HP',
            slot: 3,
            probability: 1.0,
            is_hidden: true
          }
        ]
      });
      
      const abilities = await abilityService.getPokemonAbilities(speciesId);
      
      expect(abilities.normal).toHaveLength(1);
      expect(abilities.normal[0].id).toBe('blaze');
      expect(abilities.hidden.id).toBe('solar_power');
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('assignAbilitiesToPokemon', () => {
    it('should assign normal ability to pokemon', async () => {
      const playerPokemonId = 1;
      const speciesId = 'charizard';
      
      mockRedis.get.mockResolvedValue(JSON.stringify({
        normal: [
          { id: 'blaze', nameZh: '猛火', probability: 1.0, slot: 1 }
        ],
        hidden: { id: 'solar_power', nameZh: '太阳之力', slot: 3 }
      }));
      
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const abilities = await abilityService.assignAbilitiesToPokemon(playerPokemonId, speciesId);
      
      expect(abilities.length).toBeGreaterThan(0);
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should assign hidden ability with low probability', async () => {
      const playerPokemonId = 2;
      const speciesId = 'pikachu';
      
      mockRedis.get.mockResolvedValue(JSON.stringify({
        normal: [{ id: 'static', nameZh: '静电', probability: 1.0, slot: 1 }],
        hidden: { id: 'lightning_rod', nameZh: '避雷针', slot: 3 }
      }));
      
      mockDb.query.mockResolvedValue({ rows: [] });
      
      // 强制分配隐藏特性
      const abilities = await abilityService.assignAbilitiesToPokemon(
        playerPokemonId,
        speciesId,
        { forceHidden: true }
      );
      
      expect(abilities.some(a => a.isHidden)).toBe(true);
    });
  });

  describe('getPlayerPokemonAbilities', () => {
    it('should return player pokemon abilities', async () => {
      const playerPokemonId = 1;
      
      mockDb.query.mockResolvedValue({
        rows: [
          {
            ability_id: 'blaze',
            name_en: 'Blaze',
            name_zh: '猛火',
            type: 'trigger',
            description: 'HP低于1/3时火系技能威力提升50%',
            effect_config: { type: 'damage_modifier' },
            slot: 1,
            is_active: true,
            is_hidden: false,
            unlocked_at: null
          }
        ]
      });
      
      const abilities = await abilityService.getPlayerPokemonAbilities(playerPokemonId);
      
      expect(abilities).toHaveLength(1);
      expect(abilities[0].id).toBe('blaze');
      expect(abilities[0].isActive).toBe(true);
    });
  });

  describe('getActiveAbility', () => {
    it('should return active ability', async () => {
      const playerPokemonId = 1;
      
      mockDb.query.mockResolvedValue({
        rows: [
          {
            ability_id: 'blaze',
            name_en: 'Blaze',
            name_zh: '猛火',
            type: 'trigger',
            description: 'HP低于1/3时火系技能威力提升50%',
            effect_config: { type: 'damage_modifier', multiplier: 1.5 },
            trigger_condition: { type: 'hp_threshold', threshold: 0.333 },
            is_hidden: false
          }
        ]
      });
      
      const ability = await abilityService.getActiveAbility(playerPokemonId);
      
      expect(ability).toBeDefined();
      expect(ability.id).toBe('blaze');
      expect(ability.type).toBe('trigger');
    });

    it('should return null if no active ability', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const ability = await abilityService.getActiveAbility(999);
      
      expect(ability).toBeNull();
    });
  });

  describe('switchAbility', () => {
    it('should switch to different normal ability', async () => {
      const playerPokemonId = 1;
      const targetSlot = 2;
      
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, ability_id: 'blaze', slot: 1 }] })
          .mockResolvedValueOnce({ rows: [{ id: 2, ability_id: 'solar_power', slot: 2 }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      
      const result = await abilityService.switchAbility(playerPokemonId, targetSlot);
      
      expect(result.success).toBe(true);
      expect(result.newAbility.id).toBe('solar_power');
    });

    it('should throw error if target ability is already active', async () => {
      const playerPokemonId = 1;
      const targetSlot = 1;
      
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, ability_id: 'blaze', slot: 1 }] })
          .mockResolvedValueOnce({ rows: [{ id: 1, ability_id: 'blaze', slot: 1 }] }),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      
      await expect(abilityService.switchAbility(playerPokemonId, targetSlot))
        .rejects.toThrow('Target ability is already active');
    });
  });

  describe('checkTriggerCondition', () => {
    it('should return true for passive abilities', () => {
      const ability = { type: 'passive' };
      const context = {};
      
      const result = abilityService.checkTriggerCondition(ability, context);
      
      expect(result.canTrigger).toBe(true);
    });

    it('should check HP threshold condition correctly', () => {
      const ability = {
        type: 'trigger',
        trigger_condition: { type: 'hp_threshold', threshold: 0.333 }
      };
      
      const contextLow = { currentHp: 10, maxHp: 100 };
      const contextHigh = { currentHp: 50, maxHp: 100 };
      
      const resultLow = abilityService.checkTriggerCondition(ability, contextLow);
      const resultHigh = abilityService.checkTriggerCondition(ability, contextHigh);
      
      expect(resultLow.canTrigger).toBe(true);
      expect(resultHigh.canTrigger).toBe(false);
    });

    it('should check weather condition correctly', () => {
      const ability = {
        type: 'trigger',
        trigger_condition: { type: 'weather', weather: 'rain' }
      };
      
      const contextRain = { weather: 'rain' };
      const contextSun = { weather: 'sun' };
      
      const resultRain = abilityService.checkTriggerCondition(ability, contextRain);
      const resultSun = abilityService.checkTriggerCondition(ability, contextSun);
      
      expect(resultRain.canTrigger).toBe(true);
      expect(resultSun.canTrigger).toBe(false);
    });
  });

  describe('applyAbilityEffect', () => {
    it('should apply stat boost effect', () => {
      const abilityId = 'intimidate';
      const context = { pokemonId: 1 };
      const battle = { id: 'battle-1' };
      
      const effects = abilityService.applyAbilityEffect(abilityId, context, battle);
      
      expect(effects).toHaveLength(1);
      expect(effects[0].type).toBe('stat_boost');
      expect(effects[0].stat).toBe('attack');
    });

    it('should apply immune effect', () => {
      const abilityId = 'levitate';
      const context = { pokemonId: 1 };
      const battle = { id: 'battle-1' };
      
      const effects = abilityService.applyAbilityEffect(abilityId, context, battle);
      
      expect(effects).toHaveLength(1);
      expect(effects[0].type).toBe('immune');
      expect(effects[0].to).toContain('ground');
    });

    it('should throw error for non-existent ability', () => {
      expect(() => {
        abilityService.applyAbilityEffect('non_existent', {}, {});
      }).toThrow('Ability non_existent not found');
    });
  });

  describe('shouldTriggerAt', () => {
    it('should return true for abilities that trigger at specified time', () => {
      expect(abilityService.shouldTriggerAt('intimidate', 'on_enter')).toBe(true);
      expect(abilityService.shouldTriggerAt('blaze', 'on_low_hp')).toBe(true);
    });

    it('should return false for abilities that do not trigger at specified time', () => {
      expect(abilityService.shouldTriggerAt('intimidate', 'on_turn_end')).toBe(false);
    });
  });

  describe('getAbilitiesForTrigger', () => {
    it('should return abilities for specific trigger type', () => {
      const abilities = abilityService.getAbilitiesForTrigger('on_enter');
      
      expect(abilities).toContain('intimidate');
    });

    it('should return empty array for unknown trigger type', () => {
      const abilities = abilityService.getAbilitiesForTrigger('unknown');
      
      expect(abilities).toEqual([]);
    });
  });
});

describe('Ability Service Integration', () => {
  it('should handle full ability assignment workflow', async () => {
    const service = new AbilityService();
    
    // 模拟数据库响应
    service.db.query = jest.fn()
      .mockResolvedValueOnce({
        rows: [
          {
            ability_id: 'blaze',
            name_en: 'Blaze',
            name_zh: '猛火',
            type: 'trigger',
            description: 'HP低于1/3时火系技能威力提升50%',
            slot: 1,
            probability: 1.0,
            is_hidden: false
          }
        ]
      })
      .mockResolvedValue({ rows: [] });
    
    service.redis.get = jest.fn().mockResolvedValue(null);
    service.redis.setex = jest.fn();
    
    const abilities = await service.assignAbilitiesToPokemon(1, 'charmander');
    
    expect(abilities).toBeDefined();
  });
});
