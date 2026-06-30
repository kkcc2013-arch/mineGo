// backend/tests/unit/bag-upgrade.test.js
// REQ-00150: 背包容量扩展与购买系统 - 单元测试
'use strict';

const { describe, it, beforeEach, afterEach, expect, mock } = require('../../../shared/test-utils');
const { BagUpgradeService } = require('../../services/pokemon-service/src/bagUpgradeService');

// Mock dependencies
const mockDb = {
  query: mock.fn(),
  transaction: mock.fn()
};

const mockRedis = {
  get: mock.fn(),
  set: mock.fn(),
  del: mock.fn()
};

const mockLogger = {
  info: mock.fn(),
  error: mock.fn(),
  warn: mock.fn()
};

describe('BagUpgradeService', () => {
  let service;
  
  beforeEach(() => {
    service = new BagUpgradeService(mockLogger);
    // Reset mocks
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.del.mockReset();
    mockLogger.info.mockReset();
  });
  
  describe('getUpgradeConfigs', () => {
    it('should return configs with purchase counts', async () => {
      // Mock database responses
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { upgrade_id: 'base_50', category: 'base', increment: 50, gold_cost: 10000, gem_cost: 100, required_level: 5, max_upgrades: 20 },
          { upgrade_id: 'pokeball_20', category: 'pokeball', increment: 20, gold_cost: 5000, gem_cost: 50, required_level: 1, max_upgrades: 15 }
        ]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { upgrade_id: 'base_50', purchase_count: '3' }
        ]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ max_items: 350, pokeball_slots: 50 }]
      });
      
      mockRedis.get.mockResolvedValue(null);
      
      const configs = await service.getUpgradeConfigs(1);
      
      expect(configs).toBeDefined();
      expect(configs.length).toBe(2);
      
      // Verify first config has correct purchase info
      const baseConfig = configs.find(c => c.upgrade_id === 'base_50');
      expect(baseConfig.purchased).toBe(3);
      expect(baseConfig.remaining).toBe(17);
      expect(baseConfig.available).toBe(true);
    });
    
    it('should mark config as unavailable when max purchases reached', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { upgrade_id: 'base_50', category: 'base', increment: 50, gold_cost: 10000, gem_cost: 100, required_level: 5, max_upgrades: 20 }
        ]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ upgrade_id: 'base_50', purchase_count: '20' }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ max_items: 350 }]
      });
      
      mockRedis.get.mockResolvedValue(null);
      
      const configs = await service.getUpgradeConfigs(1);
      
      expect(configs[0].purchased).toBe(20);
      expect(configs[0].remaining).toBe(0);
      expect(configs[0].available).toBe(false);
    });
  });
  
  describe('purchaseBagUpgrade', () => {
    it('should successfully purchase upgrade with gold', async () => {
      const mockClient = {
        query: mock.fn(),
        release: mock.fn()
      };
      
      // Mock transaction
      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });
      
      // Mock config query
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          gem_cost: 100,
          required_level: 5,
          max_upgrades: 20
        }]
      });
      
      // Mock purchase count
      mockClient.query.mockResolvedValueOnce({
        rows: [{ count: '3' }]
      });
      
      // Mock user balance
      mockClient.query.mockResolvedValueOnce({
        rows: [{ gold: 50000, gems: 500 }]
      });
      
      // Mock user level
      mockClient.query.mockResolvedValueOnce({
        rows: [{ level: 10 }]
      });
      
      // Mock current capacity
      mockClient.query.mockResolvedValueOnce({
        rows: [{ current_slots: 350 }]
      });
      
      // Mock dedup
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      
      // Mock purchase record
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      
      // Mock capacity update
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      
      // Mock audit log
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      
      const result = await service.purchaseBagUpgrade(1, 'base_50', 'gold');
      
      expect(result.success).toBe(true);
      expect(result.category).toBe('base');
      expect(result.increment).toBe(50);
      expect(result.method).toBe('gold');
      expect(result.cost).toBe(10000);
      expect(result.oldCapacity).toBe(350);
      expect(result.newCapacity).toBe(400);
    });
    
    it('should reject purchase when max upgrades reached', async () => {
      const mockClient = {
        query: mock.fn(),
        release: mock.fn()
      };
      
      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          gem_cost: 100,
          required_level: 5,
          max_upgrades: 20
        }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ count: '20' }]
      });
      
      await expect(
        service.purchaseBagUpgrade(1, 'base_50', 'gold')
      ).rejects.toThrow('Maximum upgrades reached');
    });
    
    it('should reject purchase when insufficient balance', async () => {
      const mockClient = {
        query: mock.fn(),
        release: mock.fn()
      };
      
      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          gem_cost: 100,
          required_level: 5,
          max_upgrades: 20
        }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ count: '3' }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ gold: 5000, gems: 50 }] // Insufficient gold
      });
      
      await expect(
        service.purchaseBagUpgrade(1, 'base_50', 'gold')
      ).rejects.toThrow('Insufficient gold balance');
    });
    
    it('should reject purchase when level requirement not met', async () => {
      const mockClient = {
        query: mock.fn(),
        release: mock.fn()
      };
      
      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          upgrade_id: 'base_100',
          category: 'base',
          increment: 100,
          gold_cost: 50000,
          gem_cost: 500,
          required_level: 10, // Requires level 10
          max_upgrades: 10
        }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ count: '3' }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ gold: 100000, gems: 1000 }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ level: 5 }] // User is level 5
      });
      
      await expect(
        service.purchaseBagUpgrade(1, 'base_100', 'gold')
      ).rejects.toThrow('Requires level 10');
    });
    
    it('should reject invalid purchase method', async () => {
      await expect(
        service.purchaseBagUpgrade(1, 'base_50', 'invalid')
      ).rejects.toThrow('Invalid purchase method');
    });
    
    it('should reject purchase when cost is null for method', async () => {
      const mockClient = {
        query: mock.fn(),
        release: mock.fn()
      };
      
      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          upgrade_id: 'base_200',
          category: 'base',
          increment: 200,
          gold_cost: null, // Cannot purchase with gold
          gem_cost: 1000,
          required_level: 15,
          max_upgrades: 5
        }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ count: '0' }]
      });
      
      await expect(
        service.purchaseBagUpgrade(1, 'base_200', 'gold')
      ).rejects.toThrow('Cannot purchase this upgrade with gold');
    });
  });
  
  describe('grantFreeUpgrade', () => {
    it('should successfully grant free upgrade', async () => {
      const mockClient = {
        query: mock.fn(),
        release: mock.fn()
      };
      
      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          gem_cost: 100,
          required_level: 5,
          max_upgrades: 20
        }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ count: '0' }]
      });
      
      mockClient.query.mockResolvedValueOnce({
        rows: [{ current_slots: 350 }]
      });
      
      // Mock grant record
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      
      // Mock capacity update
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      
      // Mock audit log
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      
      const result = await service.grantFreeUpgrade(1, 'base_50', 'achievement');
      
      expect(result.success).toBe(true);
      expect(result.category).toBe('base');
      expect(result.increment).toBe(50);
      expect(result.reason).toBe('achievement');
    });
    
    it('should reject invalid grant reason', async () => {
      await expect(
        service.grantFreeUpgrade(1, 'base_50', 'invalid_reason')
      ).rejects.toThrow('Invalid grant reason');
    });
  });
  
  describe('getUserUpgradeStats', () => {
    it('should return user upgrade statistics', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          total_upgrades: '10',
          total_gold_spent: '50000',
          total_gem_spent: '500',
          free_upgrades: '2',
          last_upgrade_time: '2026-06-30 10:00:00'
        }]
      });
      
      const stats = await service.getUserUpgradeStats(1);
      
      expect(stats.total_upgrades).toBe('10');
      expect(stats.total_gold_spent).toBe('50000');
      expect(stats.total_gem_spent).toBe('500');
      expect(stats.free_upgrades).toBe('2');
    });
    
    it('should return default stats when no upgrades', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: []
      });
      
      const stats = await service.getUserUpgradeStats(1);
      
      expect(stats.total_upgrades).toBe(0);
      expect(stats.total_gold_spent).toBe(0);
      expect(stats.total_gem_spent).toBe(0);
      expect(stats.free_upgrades).toBe(0);
      expect(stats.last_upgrade_time).toBeNull();
    });
  });
  
  describe('getCategoryColumn', () => {
    it('should return correct column for each category', () => {
      expect(service.getCategoryColumn('base')).toBe('max_items');
      expect(service.getCategoryColumn('pokeball')).toBe('pokeball_slots');
      expect(service.getCategoryColumn('potion')).toBe('potion_slots');
      expect(service.getCategoryColumn('tm')).toBe('tm_slots');
      expect(service.getCategoryColumn('evolution')).toBe('evolution_slots');
      expect(service.getCategoryColumn('berry')).toBe('berry_slots');
      expect(service.getCategoryColumn('special')).toBe('special_slots');
      expect(service.getCategoryColumn('misc')).toBe('misc_slots');
    });
  });
  
  describe('getDefaultCapacity', () => {
    it('should return correct default for each category', () => {
      expect(service.getDefaultCapacity('base')).toBe(350);
      expect(service.getDefaultCapacity('pokeball')).toBe(50);
      expect(service.getDefaultCapacity('potion')).toBe(50);
      expect(service.getDefaultCapacity('tm')).toBe(20);
      expect(service.getDefaultCapacity('evolution')).toBe(30);
      expect(service.getDefaultCapacity('berry')).toBe(50);
      expect(service.getDefaultCapacity('special')).toBe(20);
      expect(service.getDefaultCapacity('misc')).toBe(100);
    });
  });
});

// 运行测试
describe.run();