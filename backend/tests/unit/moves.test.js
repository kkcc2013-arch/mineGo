/**
 * REQ-00019: 精灵技能学习与技能机器系统
 * 单元测试
 */

const { describe, it, beforeEach, afterEach, expect, jest } = require('@jest/globals');

// Mock dependencies
jest.mock('../../../shared/db', () => ({
  query: jest.fn(),
  transaction: jest.fn()
}));

jest.mock('../../../shared/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const moveService = require('../src/moveService');
const { query, transaction } = require('../../../shared/db');

describe('MoveService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMoves', () => {
    it('should return moves list with filters', async () => {
      const mockMoves = [
        { id: 'THUNDERBOLT', name_zh: '十万伏特', type: 'ELECTRIC', category: 'CHARGE' },
        { id: 'TACKLE', name_zh: '撞击', type: 'NORMAL', category: 'FAST' }
      ];

      query
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })  // count query
        .mockResolvedValueOnce({ rows: mockMoves });        // data query

      const result = await moveService.getMoves({ type: 'ELECTRIC', limit: 10, offset: 0 });

      expect(result.moves).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });

    it('should filter by category', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'THUNDERBOLT', category: 'CHARGE' }] });

      await moveService.getMoves({ category: 'CHARGE' });

      // Verify category filter was applied
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('category ='),
        expect.arrayContaining(['CHARGE'])
      );
    });
  });

  describe('getMoveById', () => {
    it('should return move details', async () => {
      const mockMove = {
        id: 'THUNDERBOLT',
        name_zh: '十万伏特',
        type: 'ELECTRIC',
        category: 'CHARGE',
        power: 80
      };

      query.mockResolvedValue({ rows: [mockMove] });

      const result = await moveService.getMoveById('THUNDERBOLT');

      expect(result).toEqual(mockMove);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        ['THUNDERBOLT']
      );
    });

    it('should return null if move not found', async () => {
      query.mockResolvedValue({ rows: [] });

      const result = await moveService.getMoveById('NONEXISTENT');

      expect(result).toBeNull();
    });
  });

  describe('getPokemonMoves', () => {
    it('should return pokemon moves with available moves', async () => {
      const mockPokemon = {
        id: 1,
        species_id: 25,
        species_name: '皮卡丘',
        fast_move: 'THUNDER_SHOCK',
        charge_move: 'THUNDERBOLT',
        learned_fast_moves: ['THUNDER_SHOCK', 'QUICK_ATTACK'],
        learned_charge_moves: ['THUNDERBOLT']
      };

      const mockLearnset = [
        { move_id: 'THUNDER_SHOCK', category: 'FAST', learn_method: 'LEVEL_UP' },
        { move_id: 'THUNDERBOLT', category: 'CHARGE', learn_method: 'TM' },
        { move_id: 'THUNDER', category: 'CHARGE', learn_method: 'TM' }
      ];

      const mockLearnedDetails = [
        { id: 'THUNDER_SHOCK', category: 'FAST' },
        { id: 'QUICK_ATTACK', category: 'FAST' },
        { id: 'THUNDERBOLT', category: 'CHARGE' }
      ];

      query
        .mockResolvedValueOnce({ rows: [mockPokemon] })
        .mockResolvedValueOnce({ rows: mockLearnset })
        .mockResolvedValueOnce({ rows: mockLearnedDetails });

      const result = await moveService.getPokemonMoves(1, 1);

      expect(result.currentFastMove).toBe('THUNDER_SHOCK');
      expect(result.currentChargeMove).toBe('THUNDERBOLT');
      expect(result.learnedFastMoves).toHaveLength(2);
      expect(result.learnedChargeMoves).toHaveLength(1);
      expect(result.availableMoves).toHaveLength(1); // Only THUNDER is available
    });

    it('should throw error if pokemon not found', async () => {
      query.mockResolvedValue({ rows: [] });

      await expect(moveService.getPokemonMoves(1, 999))
        .rejects.toThrow('Pokemon not found or not owned by user');
    });
  });

  describe('learnMove', () => {
    it('should successfully learn a new move', async () => {
      const mockTM = {
        tm_id: 'TM13',
        move_id: 'THUNDERBOLT',
        is_elite: false,
        quantity: 2
      };

      const mockMove = {
        id: 'THUNDERBOLT',
        category: 'CHARGE',
        name_zh: '十万伏特'
      };

      const mockPokemon = {
        id: 1,
        species_id: 25,
        learned_fast_moves: ['THUNDER_SHOCK'],
        learned_charge_moves: [],
        fast_move: 'THUNDER_SHOCK',
        charge_move: 'DISCHARGE'
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockTM] })      // TM inventory check
          .mockResolvedValueOnce({ rows: [mockMove] })    // Move details
          .mockResolvedValueOnce({ rows: [mockPokemon] }) // Pokemon check
          .mockResolvedValueOnce({ rows: [{ learn_method: 'TM' }] }) // Can learn check
          .mockResolvedValue({ rows: [] })                // Update operations
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      const result = await moveService.learnMove(1, 1, 'TM13');

      expect(result.success).toBe(true);
      expect(result.moveId).toBe('THUNDERBOLT');
    });

    it('should throw error if TM not in inventory', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      await expect(moveService.learnMove(1, 1, 'TM99'))
        .rejects.toThrow('TM not found in inventory');
    });

    it('should require forgetMoveId when move slot is full', async () => {
      const mockTM = {
        tm_id: 'TM13',
        move_id: 'THUNDERBOLT',
        is_elite: false,
        quantity: 1
      };

      const mockMove = {
        id: 'THUNDERBOLT',
        category: 'CHARGE'
      };

      const mockPokemon = {
        id: 1,
        species_id: 25,
        learned_charge_moves: ['THUNDER', 'DISCHARGE', 'THUNDER_PUNCH', 'IRON_HEAD'],
        charge_move: 'THUNDER',
        fast_move: 'THUNDER_SHOCK'
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockTM] })
          .mockResolvedValueOnce({ rows: [mockMove] })
          .mockResolvedValueOnce({ rows: [mockPokemon] })
          .mockResolvedValueOnce({ rows: [{ learn_method: 'TM' }] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      await expect(moveService.learnMove(1, 1, 'TM13'))
        .rejects.toThrow('Move slot is full');
    });

    it('should not allow forgetting currently equipped move', async () => {
      const mockTM = {
        tm_id: 'TM13',
        move_id: 'THUNDERBOLT',
        is_elite: false,
        quantity: 1
      };

      const mockMove = {
        id: 'THUNDERBOLT',
        category: 'CHARGE'
      };

      const mockPokemon = {
        id: 1,
        species_id: 25,
        learned_charge_moves: ['THUNDER', 'DISCHARGE', 'THUNDER_PUNCH', 'IRON_HEAD'],
        charge_move: 'THUNDER',
        fast_move: 'THUNDER_SHOCK'
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockTM] })
          .mockResolvedValueOnce({ rows: [mockMove] })
          .mockResolvedValueOnce({ rows: [mockPokemon] })
          .mockResolvedValueOnce({ rows: [{ learn_method: 'TM' }] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      await expect(moveService.learnMove(1, 1, 'TM13', 'THUNDER'))
        .rejects.toThrow('Cannot forget currently equipped move');
    });

    it('should require elite TM for legacy moves', async () => {
      const mockTM = {
        tm_id: 'TM13',
        move_id: 'THUNDER_PUNCH',
        is_elite: false,
        quantity: 1
      };

      const mockMove = {
        id: 'THUNDER_PUNCH',
        category: 'CHARGE'
      };

      const mockPokemon = {
        id: 1,
        species_id: 25,
        learned_charge_moves: [],
        charge_move: 'DISCHARGE',
        fast_move: 'THUNDER_SHOCK'
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockTM] })
          .mockResolvedValueOnce({ rows: [mockMove] })
          .mockResolvedValueOnce({ rows: [mockPokemon] })
          .mockResolvedValueOnce({ rows: [{ learn_method: 'LEGACY' }] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      await expect(moveService.learnMove(1, 1, 'TM13'))
        .rejects.toThrow('This move requires an Elite TM to learn');
    });
  });

  describe('switchMove', () => {
    it('should successfully switch equipped move', async () => {
      const mockPokemon = {
        id: 1,
        fast_move: 'THUNDER_SHOCK',
        charge_move: 'THUNDERBOLT',
        learned_fast_moves: ['THUNDER_SHOCK', 'QUICK_ATTACK'],
        learned_charge_moves: ['THUNDERBOLT', 'THUNDER']
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockPokemon] })
          .mockResolvedValue({ rows: [] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      const result = await moveService.switchMove(1, 1, 'QUICK_ATTACK', 'THUNDER');

      expect(result.success).toBe(true);
      expect(result.fastMove).toBe('QUICK_ATTACK');
      expect(result.chargeMove).toBe('THUNDER');
    });

    it('should throw error if move not in learned list', async () => {
      const mockPokemon = {
        id: 1,
        fast_move: 'THUNDER_SHOCK',
        charge_move: 'THUNDERBOLT',
        learned_fast_moves: ['THUNDER_SHOCK'],
        learned_charge_moves: ['THUNDERBOLT']
      };

      const mockClient = {
        query: jest.fn().mockResolvedValueOnce({ rows: [mockPokemon] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      await expect(moveService.switchMove(1, 1, 'QUICK_ATTACK'))
        .rejects.toThrow('Fast move not in learned moves');
    });
  });

  describe('forgetMove', () => {
    it('should successfully forget a move', async () => {
      const mockPokemon = {
        id: 1,
        fast_move: 'THUNDER_SHOCK',
        charge_move: 'THUNDERBOLT',
        learned_fast_moves: ['THUNDER_SHOCK', 'QUICK_ATTACK'],
        learned_charge_moves: ['THUNDERBOLT', 'THUNDER']
      };

      const mockMove = {
        id: 'QUICK_ATTACK',
        category: 'FAST'
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockPokemon] })
          .mockResolvedValueOnce({ rows: [mockMove] })
          .mockResolvedValue({ rows: [] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      const result = await moveService.forgetMove(1, 1, 'QUICK_ATTACK');

      expect(result.success).toBe(true);
      expect(result.moveId).toBe('QUICK_ATTACK');
    });

    it('should not allow forgetting equipped move', async () => {
      const mockPokemon = {
        id: 1,
        fast_move: 'THUNDER_SHOCK',
        charge_move: 'THUNDERBOLT',
        learned_fast_moves: ['THUNDER_SHOCK'],
        learned_charge_moves: ['THUNDERBOLT']
      };

      const mockMove = {
        id: 'THUNDER_SHOCK',
        category: 'FAST'
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockPokemon] })
          .mockResolvedValueOnce({ rows: [mockMove] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      await expect(moveService.forgetMove(1, 1, 'THUNDER_SHOCK'))
        .rejects.toThrow('Cannot forget currently equipped move');
    });
  });

  describe('getTMInventory', () => {
    it('should return user TM inventory', async () => {
      const mockTMs = [
        { tm_id: 'TM13', move_id: 'THUNDERBOLT', quantity: 2, rarity: 'RARE' },
        { tm_id: 'TM01', move_id: 'TACKLE', quantity: 5, rarity: 'COMMON' }
      ];

      query.mockResolvedValue({ rows: mockTMs });

      const result = await moveService.getTMInventory(1);

      expect(result.tms).toHaveLength(2);
      expect(result.tms[0].tm_id).toBe('TM13');
    });
  });

  describe('getSpeciesLearnset', () => {
    it('should return learnable moves for species', async () => {
      const mockLearnset = [
        { move_id: 'THUNDER_SHOCK', learn_method: 'LEVEL_UP' },
        { move_id: 'THUNDERBOLT', learn_method: 'TM', tm_id: 'TM13' }
      ];

      query.mockResolvedValue({ rows: mockLearnset });

      const result = await moveService.getSpeciesLearnset(25);

      expect(result.speciesId).toBe(25);
      expect(result.moves).toHaveLength(2);
    });
  });
});

// Test raid rewards
describe('Raid Rewards', () => {
  const raidRewards = require('../src/raidRewards');
  const { query, transaction } = require('../../../shared/db');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateRaidRewards', () => {
    it('should generate rewards for level 5 raid', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] })
      };

      transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      const rewards = await raidRewards.generateRaidRewards(5, 1);

      expect(rewards.xp).toBe(10000);
      expect(rewards.stardust).toBe(3000);
      expect(rewards.items.length).toBeGreaterThan(0);
    });

    it('should have correct TM drop chance', () => {
      expect(raidRewards.RAID_TM_CHANCE[1]).toBe(0.05);
      expect(raidRewards.RAID_TM_CHANCE[3]).toBe(0.15);
      expect(raidRewards.RAID_TM_CHANCE[5]).toBe(0.30);
      expect(raidRewards.RAID_TM_CHANCE.MEGA).toBe(0.50);
      expect(raidRewards.RAID_TM_CHANCE.ELITE).toBe(0.80);
    });
  });

  describe('tryPokestopTMDrop', () => {
    it('should occasionally drop TM from pokestop', async () => {
      query.mockResolvedValue({ rows: [] });

      // Mock Math.random to return value below threshold
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.01); // 1% < 2%

      const result = await raidRewards.tryPokestopTMDrop(1);

      expect(result).not.toBeNull();
      expect(result.qty).toBe(1);

      Math.random = originalRandom;
    });

    it('should usually not drop TM from pokestop', async () => {
      // Mock Math.random to return value above threshold
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.50); // 50% > 2%

      const result = await raidRewards.tryPokestopTMDrop(1);

      expect(result).toBeNull();

      Math.random = originalRandom;
    });
  });
});
