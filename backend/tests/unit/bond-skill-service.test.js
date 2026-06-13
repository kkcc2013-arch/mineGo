/**
 * 羁绊技能服务单元测试 - REQ-00151
 */

const { BondSkillService } = require('../bondSkillService');
const { getPool } = require('../../../shared/db');
const { getRedis } = require('../../../shared/redis');

// Mock dependencies
jest.mock('../../../shared/db');
jest.mock('../../../shared/redis');
jest.mock('../../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  })
}));

describe('BondSkillService', () => {
  let service;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      connect: jest.fn()
    };
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn()
    };
    
    getPool.mockReturnValue(mockDb);
    getRedis.mockReturnValue(mockRedis);
    
    service = new BondSkillService({ db: mockDb, redis: mockRedis });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getAvailableBondSkills', () => {
    it('should return cached skills if available', async () => {
      const cachedSkills = [{ id: 1, skill_name: '羁绊电击' }];
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedSkills));
      
      const result = await service.getAvailableBondSkills(25);
      
      expect(result).toEqual(cachedSkills);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('should fetch from database if cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.query.mockResolvedValue({
        rows: [
          { id: 1, pokemon_species_id: 25, skill_name: '羁绊电击', slot: 1 }
        ]
      });
      
      const result = await service.getAvailableBondSkills(25);
      
      expect(result).toHaveLength(1);
      expect(result[0].skill_name).toBe('羁绊电击');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM bond_skill_definitions'),
        [25]
      );
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('getPokemonBondSkills', () => {
    it('should return skills with unlock status', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ id: 'pokemon-1', species_id: 25, user_id: 1, friendship: 100 }]
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 1, skill_name: '羁绊电击', unlock_friendship_level: 26 },
            { id: 2, skill_name: '守护闪电', unlock_friendship_level: 76 },
            { id: 3, skill_name: '十万伏特·羁绊', unlock_friendship_level: 151 }
          ]
        })
        .mockResolvedValueOnce({ rows: [] });
      
      mockRedis.get.mockResolvedValue(null);
      
      const result = await service.getPokemonBondSkills('pokemon-1', 1);
      
      expect(result.friendship).toBe(100);
      expect(result.skills).toHaveLength(3);
      
      // 检查解锁状态
      const skill1 = result.skills.find(s => s.id === 1);
      expect(skill1.isUnlocked).toBe(true); // friendship 100 >= 26
      
      const skill2 = result.skills.find(s => s.id === 2);
      expect(skill2.isUnlocked).toBe(true); // friendship 100 >= 76
      
      const skill3 = result.skills.find(s => s.id === 3);
      expect(skill3.isUnlocked).toBe(false); // friendship 100 < 151
    });

    it('should throw error if pokemon not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      await expect(service.getPokemonBondSkills('invalid-id', 1))
        .rejects.toThrow('Pokemon not found');
    });
  });

  describe('learnBondSkill', () => {
    it('should learn skill successfully', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', species_id: 25, user_id: 1, friendship: 100 }] })
          .mockResolvedValueOnce({ rows: [{ id: 1, skill_name: '羁绊电击', unlock_friendship_level: 26, pp: 15 }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ id: 1, learned_at: new Date() }] }),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      mockRedis.keys.mockResolvedValue([]);
      
      const result = await service.learnBondSkill('pokemon-1', 1, 1);
      
      expect(result.success).toBe(true);
      expect(result.skill.name).toBe('羁绊电击');
    });

    it('should fail if friendship not enough', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', species_id: 25, user_id: 1, friendship: 20 }] })
          .mockResolvedValueOnce({ rows: [{ id: 1, skill_name: '羁绊电击', unlock_friendship_level: 26, pp: 15 }] }),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      
      await expect(service.learnBondSkill('pokemon-1', 1, 1))
        .rejects.toThrow('Friendship level not enough');
    });

    it('should fail if already learned', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', species_id: 25, user_id: 1, friendship: 100 }] })
          .mockResolvedValueOnce({ rows: [{ id: 1, skill_name: '羁绊电击', unlock_friendship_level: 26, pp: 15 }] })
          .mockResolvedValueOnce({ rows: [{ id: 1 }] }),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      
      await expect(service.learnBondSkill('pokemon-1', 1, 1))
        .rejects.toThrow('already learned');
    });
  });

  describe('forgetBondSkill', () => {
    it('should forget skill successfully', async () => {
      mockDb.query.mockResolvedValue({ rows: [{ id: 1 }] });
      mockRedis.keys.mockResolvedValue([]);
      
      const result = await service.forgetBondSkill('pokemon-1', 1, 1);
      
      expect(result.success).toBe(true);
    });

    it('should fail if skill not found', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await expect(service.forgetBondSkill('pokemon-1', 999, 1))
        .rejects.toThrow('not found');
    });
  });

  describe('activateBondSkill', () => {
    it('should activate skill successfully', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ id: 1 }] }),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      mockRedis.keys.mockResolvedValue([]);
      
      const result = await service.activateBondSkill('pokemon-1', 1, 1);
      
      expect(result.success).toBe(true);
    });
  });

  describe('calculateBondSkillEffect', () => {
    it('should calculate power with friendship bonus', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          id: 1,
          skill_name: '羁绊电击',
          type: 'electric',
          effect_type: 'damage',
          power: 65,
          accuracy: 100,
          pp: 15,
          energy_cost: 20,
          cooldown_turns: 0,
          friendship_bonus_formula: '65 + floor(friendship * 0.5)'
        }]
      });
      
      const effect = await service.calculateBondSkillEffect('pokemon-1', 1, 100);
      
      expect(effect.skillName).toBe('羁绊电击');
      expect(effect.calculatedPower).toBe(115); // 65 + floor(100 * 0.5)
      expect(effect.friendship).toBe(100);
    });

    it('should parse additional effects', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          id: 1,
          skill_name: '十万伏特·羁绊',
          type: 'electric',
          effect_type: 'damage',
          power: 120,
          accuracy: 90,
          pp: 5,
          energy_cost: 50,
          cooldown_turns: 2,
          friendship_bonus_formula: '120, crit_bonus: friendship / 255'
        }]
      });
      
      const effect = await service.calculateBondSkillEffect('pokemon-1', 1, 200);
      
      expect(effect.additionalEffects.critBonus).toBeCloseTo(200 / 255);
    });
  });

  describe('recordSkillUsage', () => {
    it('should record usage and update times_used', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await service.recordSkillUsage({
        userId: 1,
        pokemonInstanceId: 'pokemon-1',
        bondSkillId: 1,
        battleId: 'battle-1',
        damageDealt: 150,
        effectApplied: 'damage'
      });
      
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('getBondSkillStats', () => {
    it('should return user bond skill statistics', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            pokemon_with_bond_skills: 3,
            total_skills_learned: 5,
            total_times_used: 20
          }]
        })
        .mockResolvedValueOnce({
          rows: [
            { skill_name: '羁绊电击', type: 'electric', usage_count: 10, avg_damage: 120 }
          ]
        });
      
      const stats = await service.getBondSkillStats(1);
      
      expect(stats.summary.pokemon_with_bond_skills).toBe(3);
      expect(stats.topSkills).toHaveLength(1);
    });
  });
});

describe('Bond Skill Unlock Thresholds', () => {
  it('should have correct unlock thresholds', () => {
    const service = new BondSkillService();
    
    expect(service.UNLOCK_THRESHOLDS.slot1).toBe(26);
    expect(service.UNLOCK_THRESHOLDS.slot2).toBe(76);
    expect(service.UNLOCK_THRESHOLDS.slot3).toBe(151);
  });

  it('should allow max 1 active bond skill', () => {
    const service = new BondSkillService();
    
    expect(service.MAX_ACTIVE_BOND_SKILLS).toBe(1);
  });
});
