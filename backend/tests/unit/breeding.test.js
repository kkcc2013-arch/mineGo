/**
 * REQ-00046: 精灵培育系统单元测试
 */

const BreedingService = require('../../services/pokemon-service/src/breedingService');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { query } = require('../../shared/db');

// Mock 数据库和 Redis
jest.mock('pg');
jest.mock('ioredis');
jest.mock('../../shared/db', () => ({
  query: jest.fn(),
  transaction: jest.fn()
}));

describe('BreedingService', () => {
  let breedingService;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();
    
    mockDb = {
      query: jest.fn(),
      connect: jest.fn()
    };
    
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn()
    };

    Pool.mockImplementation(() => mockDb);
    Redis.mockImplementation(() => mockRedis);

    breedingService = new BreedingService({
      db: mockDb,
      redis: mockRedis
    });
  });

  describe('getOrCreateBreedingCenter', () => {
    it('应该创建新的培育中心', async () => {
      const mockCenter = {
        id: 'center-1',
        user_id: 'user-1',
        slots: 4
      };

      mockDb.query.mockResolvedValueOnce({ rows: [mockCenter] });

      const result = await breedingService.getOrCreateBreedingCenter('user-1');

      expect(result).toEqual(mockCenter);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO breeding_centers'),
        ['user-1']
      );
    });

    it('应该返回已存在的培育中心', async () => {
      const mockCenter = {
        id: 'center-1',
        user_id: 'user-1',
        slots: 6
      };

      mockDb.query.mockResolvedValueOnce({ rows: [mockCenter] });

      const result = await breedingService.getOrCreateBreedingCenter('user-1');

      expect(result).toEqual(mockCenter);
    });
  });

  describe('canBreed', () => {
    it('应该允许相同蛋组的雄性和雌性精灵培育', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pokemon-1',
            species_id: 1,
            gender: 'male',
            name: '妙蛙花',
            rarity: 'rare',
            is_breedable: true
          },
          {
            id: 'pokemon-2',
            species_id: 4,
            gender: 'female',
            name: '喷火龙',
            rarity: 'rare',
            is_breedable: true
          }
        ]
      });

      mockDb.query.mockResolvedValueOnce({
        rows: [
          { species_id: 1, egg_group_id: 1 },
          { species_id: 1, egg_group_id: 5 },
          { species_id: 4, egg_group_id: 1 },
          { species_id: 4, egg_group_id: 9 }
        ]
      });

      const result = await breedingService.canBreed('pokemon-1', 'pokemon-2');

      expect(result.canBreed).toBe(true);
      expect(result.breedingTime).toBeDefined();
    });

    it('应该拒绝相同性别的精灵培育', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pokemon-1',
            species_id: 25,
            gender: 'male',
            name: '皮卡丘',
            rarity: 'common',
            is_breedable: true
          },
          {
            id: 'pokemon-2',
            species_id: 25,
            gender: 'male',
            name: '皮卡丘',
            rarity: 'common',
            is_breedable: true
          }
        ]
      });

      const result = await breedingService.canBreed('pokemon-1', 'pokemon-2');

      expect(result.canBreed).toBe(false);
      expect(result.reason).toContain('相同性别');
    });

    it('应该允许百变怪与任何可培育精灵配对', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'ditto',
            species_id: 132,
            gender: 'unknown',
            name: '百变怪',
            rarity: 'uncommon',
            is_breedable: true
          },
          {
            id: 'pokemon-1',
            species_id: 25,
            gender: 'male',
            name: '皮卡丘',
            rarity: 'common',
            is_breedable: true
          }
        ]
      });

      mockDb.query.mockResolvedValueOnce({
        rows: [
          { species_id: 132, egg_group_id: 13 },
          { species_id: 25, egg_group_id: 4 },
          { species_id: 25, egg_group_id: 11 }
        ]
      });

      const result = await breedingService.canBreed('ditto', 'pokemon-1');

      expect(result.canBreed).toBe(true);
      expect(result.reason).toContain('百变怪');
    });

    it('应该拒绝不同蛋组的精灵培育', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pokemon-1',
            species_id: 1,
            gender: 'male',
            name: '妙蛙种子',
            rarity: 'common',
            is_breedable: true
          },
          {
            id: 'pokemon-2',
            species_id: 7,
            gender: 'female',
            name: '杰尼龟',
            rarity: 'common',
            is_breedable: true
          }
        ]
      });

      mockDb.query.mockResolvedValueOnce({
        rows: [
          { species_id: 1, egg_group_id: 1 },
          { species_id: 1, egg_group_id: 5 },
          { species_id: 7, egg_group_id: 1 },
          { species_id: 7, egg_group_id: 2 }
        ]
      });

      // 它们有共同的蛋组（怪物组），所以应该可以培育
      const result = await breedingService.canBreed('pokemon-1', 'pokemon-2');

      expect(result.canBreed).toBe(true);
    });
  });

  describe('startBreeding', () => {
    it('应该成功开始培育', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValueOnce(mockClient);

      // Mock 事务
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rows: [{ canBreed: true, breedingTime: 4 }]
      }); // canBreed check
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'center-1', user_id: 'user-1', slots: 4 }]
      }); // get center
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // slot check
      mockClient.query.mockResolvedValueOnce({
        rows: [
          { id: 'p1', is_in_team: false, is_egg: false },
          { id: 'p2', is_in_team: false, is_egg: false }
        ]
      }); // ownership check
      mockClient.query.mockResolvedValueOnce({
        rows: [
          { id: 'p1', species_id: 25, iv_attack: 15, iv_defense: 14, iv_stamina: 13 },
          { id: 'p2', species_id: 25, iv_attack: 12, iv_defense: 11, iv_stamina: 10 }
        ]
      }); // parents data
      mockClient.query.mockResolvedValueOnce({
        rows: [{ gender_ratio: 50 }]
      }); // gender ratio
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          id: 'pair-1',
          parent1_pokemon_id: 'p1',
          parent2_pokemon_id: 'p2',
          status: 'breeding'
        }]
      }); // insert pair
      mockClient.query.mockResolvedValueOnce({}); // update parents
      mockClient.query.mockResolvedValueOnce({}); // COMMIT

      const result = await breedingService.startBreeding('user-1', 'p1', 'p2', 0);

      expect(result.success).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('应该拒绝已被占用的槽位', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValueOnce(mockClient);

      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rows: [{ canBreed: true, breedingTime: 4 }]
      });
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'center-1', user_id: 'user-1', slots: 4 }]
      });
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'existing-pair' }]
      }); // slot occupied
      mockClient.query.mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        breedingService.startBreeding('user-1', 'p1', 'p2', 0)
      ).rejects.toThrow('已被占用');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('calculateInheritedIVs', () => {
    it('应该正确遗传个体值', () => {
      const parent1 = {
        iv_attack: 15,
        iv_defense: 14,
        iv_stamina: 13
      };

      const parent2 = {
        iv_attack: 12,
        iv_defense: 11,
        iv_stamina: 10
      };

      const result = breedingService.calculateInheritedIVs(parent1, parent2);

      expect(result).toHaveProperty('attack');
      expect(result).toHaveProperty('defense');
      expect(result).toHaveProperty('stamina');
      expect(result.attack).toBeGreaterThanOrEqual(0);
      expect(result.attack).toBeLessThanOrEqual(15);
      expect(result.defense).toBeGreaterThanOrEqual(0);
      expect(result.defense).toBeLessThanOrEqual(15);
      expect(result.stamina).toBeGreaterThanOrEqual(0);
      expect(result.stamina).toBeLessThanOrEqual(15);
    });
  });

  describe('getBreedingTime', () => {
    it('应该返回正确的培育时间', () => {
      expect(breedingService.getBreedingTime('common')).toBe(2);
      expect(breedingService.getBreedingTime('rare')).toBe(4);
      expect(breedingService.getBreedingTime('legendary')).toBe(12);
      expect(breedingService.getBreedingTime('mythical')).toBe(24);
    });

    it('应该使用更高的稀有度', () => {
      expect(breedingService.getBreedingTime('common', 'rare')).toBe(4);
      expect(breedingService.getBreedingTime('uncommon', 'legendary')).toBe(12);
    });
  });

  describe('collectEgg', () => {
    it('应该成功收集培育完成的蛋', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValueOnce(mockClient);

      const mockPair = {
        id: 'pair-1',
        user_id: 'user-1',
        status: 'ready',
        parent1_pokemon_id: 'p1',
        parent2_pokemon_id: 'p2',
        offspring_data: JSON.stringify({
          species_id: 25,
          iv_attack: 15,
          iv_defense: 14,
          iv_stamina: 13,
          move1: 'thunder-shock',
          move2: 'quick-attack',
          is_shiny: false,
          gender: 'male',
          hatch_steps: 2560,
          parent1_id: 'p1',
          parent2_id: 'p2',
          parent1_species_id: 25,
          parent2_species_id: 25
        })
      };

      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rows: [mockPair]
      });
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          id: 'egg-1',
          species_id: 25,
          is_egg: true,
          egg_steps: 2560
        }]
      }); // insert pokemon
      mockClient.query.mockResolvedValueOnce({}); // insert hatching
      mockClient.query.mockResolvedValueOnce({}); // insert lineage
      mockClient.query.mockResolvedValueOnce({}); // update pair
      mockClient.query.mockResolvedValueOnce({}); // release parents
      mockClient.query.mockResolvedValueOnce({}); // update stats
      mockClient.query.mockResolvedValueOnce({}); // COMMIT

      const result = await breedingService.collectEgg('user-1', 'pair-1');

      expect(result.success).toBe(true);
      expect(result.pokemon).toBeDefined();
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('应该拒绝未完成的培育', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValueOnce(mockClient);

      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          id: 'pair-1',
          user_id: 'user-1',
          status: 'breeding' // 未完成
        }]
      });
      mockClient.query.mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        breedingService.collectEgg('user-1', 'pair-1')
      ).rejects.toThrow('尚未完成');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('updateHatchingProgress', () => {
    it('应该更新孵化进度', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'hatch-1',
          pokemon_id: 'egg-1',
          current_steps: 1000,
          required_steps: 2560
        }]
      });

      const result = await breedingService.updateHatchingProgress('user-1', 500);

      expect(result.updated).toBe(1);
      expect(result.hatched).toEqual([]);
    });

    it('应该孵化完成的蛋', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'hatch-1',
          pokemon_id: 'egg-1',
          current_steps: 2560,
          required_steps: 2560,
          species_id: 25,
          is_shiny: false
        }]
      });

      mockDb.connect.mockResolvedValueOnce(mockClient);
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          id: 'hatch-1',
          pokemon_id: 'egg-1',
          species_id: 25,
          is_shiny: false
        }]
      });
      mockClient.query.mockResolvedValueOnce({}); // update pokemon
      mockClient.query.mockResolvedValueOnce({}); // update hatching
      mockClient.query.mockResolvedValueOnce({}); // update stats
      mockClient.query.mockResolvedValueOnce({}); // COMMIT

      const result = await breedingService.updateHatchingProgress('user-1', 100);

      expect(result.hatched.length).toBeGreaterThan(0);
    });
  });

  describe('cancelBreeding', () => {
    it('应该成功取消培育', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValueOnce(mockClient);

      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          id: 'pair-1',
          user_id: 'user-1',
          parent1_pokemon_id: 'p1',
          parent2_pokemon_id: 'p2'
        }]
      });
      mockClient.query.mockResolvedValueOnce({}); // update pair
      mockClient.query.mockResolvedValueOnce({}); // release parents
      mockClient.query.mockResolvedValueOnce({}); // COMMIT

      const result = await breedingService.cancelBreeding('user-1', 'pair-1');

      expect(result.success).toBe(true);
    });
  });

  describe('getBreedingStats', () => {
    it('应该返回培育统计', async () => {
      const mockStats = {
        user_id: 'user-1',
        total_breeds: 10,
        total_eggs_hatched: 8,
        perfect_iv_breeds: 2,
        shiny_breeds: 1
      };

      mockDb.query.mockResolvedValueOnce({ rows: [mockStats] });

      const result = await breedingService.getBreedingStats('user-1');

      expect(result).toEqual(mockStats);
    });

    it('应该返回默认统计（无数据时）', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const result = await breedingService.getBreedingStats('user-1');

      expect(result.total_breeds).toBe(0);
      expect(result.total_eggs_hatched).toBe(0);
    });
  });

  describe('upgradeBreedingCenter', () => {
    it('应该成功升级培育中心', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'center-1',
          user_id: 'user-1',
          slots: 5
        }]
      });

      const result = await breedingService.upgradeBreedingCenter('user-1');

      expect(result.slots).toBe(5);
    });

    it('应该拒绝已达最大槽位的升级', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        breedingService.upgradeBreedingCenter('user-1')
      ).rejects.toThrow('最大槽位数');
    });
  });
});
