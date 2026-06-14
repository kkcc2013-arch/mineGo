// ============================================================
// REQ-00091: Equipment Service Unit Tests
// File: backend/tests/unit/equipment-service.test.js
// ============================================================

'use strict';

const { describe, it, beforeEach, afterEach, expect } = require('@jest/globals');
const { EquipmentService, RARITY_CONFIG } = require('../../shared/equipmentService');

// Mock database
const mockDb = {
  query: jest.fn(),
  connect: jest.fn()
};

// Mock Redis
const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn()
};

describe('EquipmentService', () => {
  let service;

  beforeEach(() => {
    service = new EquipmentService(mockDb, mockRedis);
    jest.clearAllMocks();
  });

  describe('getTemplates', () => {
    it('should return equipment templates', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { id: 1, name_zh: '训练师之剑', type: 'weapon', rarity: 'common' },
          { id: 2, name_zh: '水之长剑', type: 'weapon', rarity: 'rare' }
        ]
      });

      const result = await service.getTemplates();

      expect(result).toHaveLength(2);
      expect(result[0].name_zh).toBe('训练师之剑');
    });

    it('should filter by type', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      await service.getTemplates({ type: 'weapon' });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('AND type = $1'),
        expect.arrayContaining(['weapon'])
      );
    });

    it('should filter by rarity', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      await service.getTemplates({ rarity: 'rare' });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('AND rarity = $'),
        expect.arrayContaining(['rare'])
      );
    });
  });

  describe('getInventory', () => {
    it('should return user equipment inventory', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { id: 1, template_id: 1, name_zh: '训练师之剑', is_equipped: false },
          { id: 2, template_id: 2, name_zh: '水之长剑', is_equipped: true }
        ]
      });

      const result = await service.getInventory(1);

      expect(result).toHaveLength(2);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE pe.user_id = $1'),
        expect.arrayContaining([1])
      );
    });

    it('should filter equipped status', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      await service.getInventory(1, { equipped: true });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('AND pe.is_equipped = $'),
        expect.any(Array)
      );
    });
  });

  describe('equip', () => {
    const mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };

    beforeEach(() => {
      mockDb.connect.mockResolvedValue(mockClient);
    });

    it('should equip equipment to pokemon', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, is_equipped: false, type: 'weapon', element_affinity: null }] }) // equipment check
        .mockResolvedValueOnce({ rows: [{ id: 1, type1: 'water', type2: null }] }) // pokemon check
        .mockResolvedValueOnce({ rows: [] }) // existing check
        .mockResolvedValueOnce({ rows: [] }) // equip
        .mockResolvedValueOnce({ rows: [] }); // commit

      const result = await service.equip(1, 1, 1);

      expect(result.success).toBe(true);
      expect(result.equipmentId).toBe(1);
    });

    it('should throw if equipment not found', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // equipment check
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.equip(999, 1, 1)).rejects.toThrow('EQUIPMENT_NOT_FOUND');
    });

    it('should throw if equipment already equipped', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, is_equipped: true }] }) // equipment check
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.equip(1, 1, 1)).rejects.toThrow('EQUIPMENT_ALREADY_EQUIPPED');
    });

    it('should throw if pokemon not found', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, is_equipped: false, type: 'weapon', element_affinity: null }] })
        .mockResolvedValueOnce({ rows: [] }) // pokemon check
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.equip(1, 999, 1)).rejects.toThrow('POKEMON_NOT_FOUND');
    });

    it('should throw if element mismatch', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, is_equipped: false, type: 'weapon', element_affinity: 'fire' }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, type1: 'water', type2: null }] })
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.equip(1, 1, 1)).rejects.toThrow('ELEMENT_MISMATCH');
    });
  });

  describe('unequip', () => {
    it('should unequip equipment', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ template_id: 1, pokemon_id: 1 }]
      });

      const result = await service.unequip(1, 1);

      expect(result.success).toBe(true);
    });

    it('should throw if equipment not equipped', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      await expect(service.unequip(1, 1)).rejects.toThrow('EQUIPMENT_NOT_EQUIPPED');
    });
  });

  describe('calculateUpgradeCost', () => {
    it('should calculate correct cost for common rarity', () => {
      const cost = service.calculateUpgradeCost(1, 'common');

      expect(cost.stardust).toBe(100);
      expect(cost.coins).toBe(50);
    });

    it('should increase cost with level', () => {
      const cost1 = service.calculateUpgradeCost(1, 'rare');
      const cost5 = service.calculateUpgradeCost(5, 'rare');

      expect(cost5.stardust).toBeGreaterThan(cost1.stardust);
      expect(cost5.coins).toBeGreaterThan(cost1.coins);
    });

    it('should apply rarity multiplier', () => {
      const commonCost = service.calculateUpgradeCost(1, 'common');
      const legendaryCost = service.calculateUpgradeCost(1, 'legendary');

      expect(legendaryCost.stardust).toBeGreaterThan(commonCost.stardust);
    });
  });

  describe('calculateUpgradeSuccessRate', () => {
    it('should return 1.0 for level 1', () => {
      const rate = service.calculateUpgradeSuccessRate(1, 'common');
      expect(rate).toBe(1.0);
    });

    it('should decrease with level', () => {
      const rate1 = service.calculateUpgradeSuccessRate(1, 'rare');
      const rate5 = service.calculateUpgradeSuccessRate(5, 'rare');

      expect(rate5).toBeLessThan(rate1);
    });

    it('should apply rarity bonus', () => {
      const commonRate = service.calculateUpgradeSuccessRate(5, 'common');
      const legendaryRate = service.calculateUpgradeSuccessRate(5, 'legendary');

      expect(legendaryRate).toBeGreaterThan(commonRate);
    });

    it('should not go below 0.3', () => {
      const rate = service.calculateUpgradeSuccessRate(15, 'common');
      expect(rate).toBeGreaterThanOrEqual(0.3);
    });
  });

  describe('upgrade', () => {
    const mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };

    beforeEach(() => {
      mockDb.connect.mockResolvedValue(mockClient);
    });

    it('should successfully upgrade equipment', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, current_level: 1, max_level: 10, rarity: 'common', template_id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ stardust: 10000, coins: 10000 }] })
        .mockResolvedValueOnce({ rows: [] }) // deduct resources
        .mockResolvedValueOnce({ rows: [{ stats: { attack: 11 } }] }) // calculate stats
        .mockResolvedValueOnce({ rows: [] }) // update equipment
        .mockResolvedValueOnce({ rows: [] }) // record upgrade
        .mockResolvedValueOnce({ rows: [] }); // commit

      const result = await service.upgrade(1, 1);

      expect(result.success).toBe(true);
    });

    it('should throw if max level reached', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, current_level: 10, max_level: 10, rarity: 'common' }] })
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.upgrade(1, 1)).rejects.toThrow('MAX_LEVEL_REACHED');
    });

    it('should throw if insufficient resources', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, current_level: 1, max_level: 10, rarity: 'common', template_id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ stardust: 10, coins: 10 }] })
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.upgrade(1, 1)).rejects.toThrow('INSUFFICIENT_RESOURCES');
    });
  });

  describe('grantEquipment', () => {
    it('should grant equipment to user', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ id: 1, current_level: 1, current_stats: { attack: 5 } }]
      });

      const result = await service.grantEquipment(1, 1, 'drop');

      expect(result.id).toBe(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO player_equipment'),
        expect.arrayContaining([1, 1, 'drop', null])
      );
    });
  });

  describe('randomDrop', () => {
    it('should drop equipment with correct rarity distribution', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ id: 1 }]
      });

      // Run multiple times to test distribution
      const results = [];
      for (let i = 0; i < 100; i++) {
        const result = await service.randomDrop(1);
        results.push(result);
      }

      expect(results.filter(r => r !== null).length).toBeGreaterThan(0);
    });

    it('should drop guaranteed rarity', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ id: 1 }]
      });

      await service.randomDrop(1, null, 'legendary');

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE rarity = $1'),
        expect.arrayContaining(['legendary'])
      );
    });
  });

  describe('calculateSetBonuses', () => {
    it('should return empty array if no set equipment', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const result = await service.calculateSetBonuses(1);

      expect(result).toEqual([]);
    });

    it('should calculate set bonuses correctly', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          set_id: 1,
          name_zh: '水之守护者',
          pieces_required: 2,
          bonus_2_pieces: { water_damage_boost: 0.15 },
          bonus_4_pieces: { water_damage_boost: 0.25 },
          bonus_6_pieces: null,
          piece_count: 2
        }]
      });

      const result = await service.calculateSetBonuses(1);

      expect(result).toHaveLength(1);
      expect(result[0].bonuses.water_damage_boost).toBe(0.15);
    });
  });

  describe('calculateBattleStats', () => {
    it('should calculate battle stats with equipment bonuses', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            attack_iv: 10,
            defense_iv: 10,
            hp_iv: 10,
            speed_iv: 5,
            base_attack: 100,
            base_defense: 100,
            base_hp: 100,
            type1: 'water',
            type2: null
          }]
        })
        .mockResolvedValueOnce({
          rows: [{ current_stats: { attack: 20, defense: 10 } }]
        });

      const result = await service.calculateBattleStats(1);

      expect(result.attack).toBeGreaterThan(100);
      expect(result.defense).toBeGreaterThan(100);
    });
  });

  describe('sell', () => {
    const mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };

    beforeEach(() => {
      mockDb.connect.mockResolvedValue(mockClient);
    });

    it('should sell equipment', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, sell_price: 100, sellable: true, is_equipped: false }] })
        .mockResolvedValueOnce({ rows: [] }) // delete
        .mockResolvedValueOnce({ rows: [] }) // add coins
        .mockResolvedValueOnce({ rows: [] }); // commit

      const result = await service.sell(1, 1);

      expect(result.success).toBe(true);
      expect(result.price).toBe(100);
    });

    it('should throw if equipment not sellable', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, sell_price: 100, sellable: false, is_equipped: false }] })
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.sell(1, 1)).rejects.toThrow('EQUIPMENT_NOT_SELLABLE');
    });

    it('should throw if equipment is equipped', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, sell_price: 100, sellable: true, is_equipped: true }] })
        .mockResolvedValueOnce({ rows: [] }); // rollback

      await expect(service.sell(1, 1)).rejects.toThrow('EQUIPMENT_EQUIPPED');
    });
  });
});

describe('RARITY_CONFIG', () => {
  it('should have correct drop rates', () => {
    const totalDropRate = Object.values(RARITY_CONFIG).reduce((sum, config) => sum + config.dropRate, 0);
    expect(totalDropRate).toBeCloseTo(1.0, 1);
  });

  it('should have increasing max levels for higher rarities', () => {
    expect(RARITY_CONFIG.common.maxLevel).toBeLessThan(RARITY_CONFIG.rare.maxLevel);
    expect(RARITY_CONFIG.rare.maxLevel).toBeLessThan(RARITY_CONFIG.legendary.maxLevel);
  });

  it('should have increasing multipliers for higher rarities', () => {
    expect(RARITY_CONFIG.common.multiplier).toBeLessThan(RARITY_CONFIG.rare.multiplier);
    expect(RARITY_CONFIG.rare.multiplier).toBeLessThan(RARITY_CONFIG.legendary.multiplier);
  });
});
