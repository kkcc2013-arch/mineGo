// backend/tests/unit/inventory.test.js
// REQ-00047: 精灵道具与背包管理系统 - 单元测试

'use strict';

const { InventoryService } = require('../../services/pokemon-service/src/inventoryService');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { EventBus } = require('../../shared/EventBus');

// Mock dependencies
jest.mock('pg');
jest.mock('ioredis');
jest.mock('../../shared/EventBus');
jest.mock('../../shared/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

jest.mock('../../shared/metrics', () => ({
  counter: jest.fn(() => ({ inc: jest.fn() })),
  gauge: jest.fn(() => ({ set: jest.fn() })),
  histogram: jest.fn(() => ({ observe: jest.fn() }))
}));

describe('InventoryService', () => {
  let service;
  let mockDb;
  let mockRedis;
  let mockEventBus;
  
  beforeEach(() => {
    // 创建 mock
    mockDb = {
      query: jest.fn(),
      connect: jest.fn()
    };
    
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      ttl: jest.fn()
    };
    
    mockEventBus = {
      publish: jest.fn()
    };
    
    // 创建服务实例
    service = new InventoryService({
      db: mockDb,
      redis: mockRedis,
      eventBus: mockEventBus
    });
    
    // Mock console
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('getInventory', () => {
    it('应从缓存返回背包数据', async () => {
      const cachedData = {
        items: { pokeball: [] },
        capacity: { base_capacity: 350 },
        stats: { totalItems: 0 }
      };
      
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));
      
      const result = await service.getInventory(123);
      
      expect(mockRedis.get).toHaveBeenCalledWith('inventory:123');
      expect(result).toEqual(cachedData);
    });
    
    it('应从数据库查询并缓存数据', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      mockDb.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.getInventory(123);
      
      expect(mockDb.query).toHaveBeenCalledTimes(3);
      expect(mockRedis.setex).toHaveBeenCalled();
      expect(result.items).toBeDefined();
      expect(result.capacity).toBeDefined();
      expect(result.stats).toBeDefined();
    });
    
    it('应正确分类道具', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      const mockItems = [
        { id: 1, item_id: 'POKE_BALL', category: 'pokeball', quantity: 10, rarity: 'common' },
        { id: 2, item_id: 'POTION', category: 'potion', quantity: 5, rarity: 'common' }
      ];
      
      mockDb.query
        .mockResolvedValueOnce({ rows: mockItems })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.getInventory(123);
      
      expect(result.items.pokeball).toHaveLength(1);
      expect(result.items.potion).toHaveLength(1);
    });
  });
  
  describe('addItem', () => {
    let mockClient;
    
    beforeEach(() => {
      mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      mockDb.connect.mockResolvedValue(mockClient);
    });
    
    it('应成功添加道具', async () => {
      const mockItem = {
        item_id: 'POKE_BALL',
        category: 'pokeball',
        max_stack: 999,
        expires_after_days: null
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })           // 获取道具定义
        .mockResolvedValueOnce({ rows: [{ can_add: true, current: 0, limit: 100 }] }) // 容量检查
        .mockResolvedValueOnce({ rows: [] })                    // 查找现有堆叠
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })           // 插入新堆叠
        .mockResolvedValueOnce({ rows: [] });                   // 更新容量
      
      const result = await service.addItem(123, 'POKE_BALL', 5);
      
      expect(result.success).toBe(true);
      expect(result.quantityAdded).toBe(5);
    });
    
    it('应在背包满时拒绝添加', async () => {
      const mockItem = {
        item_id: 'POKE_BALL',
        category: 'pokeball',
        max_stack: 999
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [{ can_add: false, current: 100, limit: 100 }] });
      
      await expect(service.addItem(123, 'POKE_BALL', 5))
        .rejects.toThrow('Inventory full');
    });
    
    it('应在道具不存在时抛出错误', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      
      await expect(service.addItem(123, 'INVALID_ITEM', 1))
        .rejects.toThrow('Item not found');
    });
    
    it('应正确堆叠道具', async () => {
      const mockItem = {
        item_id: 'POKE_BALL',
        category: 'pokeball',
        max_stack: 999
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [{ can_add: true, current: 50, limit: 100 }] })
        .mockResolvedValueOnce({ rows: [{ id: 10, quantity: 990 }] }) // 现有堆叠
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.addItem(123, 'POKE_BALL', 5);
      
      expect(result.quantityAdded).toBe(5);
    });
    
    it('应设置过期时间', async () => {
      const mockItem = {
        item_id: 'PREMIER_BALL',
        category: 'pokeball',
        max_stack: 999,
        expires_after_days: 1
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [{ can_add: true, current: 0, limit: 100 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.addItem(123, 'PREMIER_BALL', 5);
      
      expect(result.success).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO player_inventory'),
        expect.arrayContaining([expect.any(Date)])
      );
    });
  });
  
  describe('useItem', () => {
    let mockClient;
    
    beforeEach(() => {
      mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      mockDb.connect.mockResolvedValue(mockClient);
    });
    
    it('应成功使用精灵球', async () => {
      const mockItem = {
        id: 1,
        item_id: 'POKE_BALL',
        category: 'pokeball',
        quantity: 10,
        is_consumable: true,
        effect_data: { catch_rate: 1.0 },
        use_requirements: {}
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.useItem(123, 'POKE_BALL');
      
      expect(result.success).toBe(true);
      expect(result.effect.type).toBe('catch_bonus');
    });
    
    it('应成功使用药水恢复HP', async () => {
      const mockItem = {
        id: 1,
        item_id: 'POTION',
        category: 'potion',
        quantity: 10,
        is_consumable: true,
        effect_data: { heal_hp: 20 },
        use_requirements: {}
      };
      
      const mockPokemon = {
        id: 100,
        hp: 50,
        max_hp: 100,
        is_fainted: false
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [mockPokemon] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.useItem(123, 'POTION', { pokemonId: 100 });
      
      expect(result.success).toBe(true);
      expect(result.effect.type).toBe('heal');
      expect(result.effect.healedHp).toBe(20);
    });
    
    it('应成功使用复活药', async () => {
      const mockItem = {
        id: 1,
        item_id: 'REVIVE',
        category: 'potion',
        quantity: 5,
        is_consumable: true,
        effect_data: { revive_percent: 50 },
        use_requirements: {}
      };
      
      const mockPokemon = {
        id: 100,
        hp: 0,
        max_hp: 100,
        is_fainted: true
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [mockPokemon] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.useItem(123, 'REVIVE', { pokemonId: 100 });
      
      expect(result.success).toBe(true);
      expect(result.effect.type).toBe('revive');
    });
    
    it('应在精灵已倒下时拒绝使用普通药水', async () => {
      const mockItem = {
        id: 1,
        item_id: 'POTION',
        category: 'potion',
        quantity: 10,
        is_consumable: true,
        effect_data: { heal_hp: 20 },
        use_requirements: {}
      };
      
      const mockPokemon = {
        id: 100,
        hp: 0,
        max_hp: 100,
        is_fainted: true
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [mockPokemon] });
      
      await expect(service.useItem(123, 'POTION', { pokemonId: 100 }))
        .rejects.toThrow('Pokemon is fainted');
    });
    
    it('应在缺少精灵ID时拒绝使用药水', async () => {
      const mockItem = {
        id: 1,
        item_id: 'POTION',
        category: 'potion',
        quantity: 10,
        is_consumable: true,
        effect_data: { heal_hp: 20 }
      };
      
      mockClient.query.mockResolvedValueOnce({ rows: [mockItem] });
      
      await expect(service.useItem(123, 'POTION'))
        .rejects.toThrow('Pokemon ID required');
    });
    
    it('应激活特殊道具效果', async () => {
      const mockItem = {
        id: 1,
        item_id: 'LUCKY_EGG',
        category: 'special',
        quantity: 5,
        is_consumable: true,
        effect_data: { duration_minutes: 30, xp_multiplier: 2.0 }
      };
      
      mockRedis.get.mockResolvedValue(null);
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.useItem(123, 'LUCKY_EGG');
      
      expect(result.success).toBe(true);
      expect(result.effect.type).toBe('timed_effect');
      expect(mockRedis.setex).toHaveBeenCalled();
    });
    
    it('应在效果已激活时拒绝使用', async () => {
      const mockItem = {
        id: 1,
        item_id: 'LUCKY_EGG',
        category: 'special',
        quantity: 5,
        is_consumable: true,
        effect_data: { duration_minutes: 30 }
      };
      
      mockRedis.get.mockResolvedValue(JSON.stringify({ active: true }));
      mockClient.query.mockResolvedValueOnce({ rows: [mockItem] });
      
      await expect(service.useItem(123, 'LUCKY_EGG'))
        .rejects.toThrow('already active');
    });
    
    it('应在道具不存在时抛出错误', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      
      await expect(service.useItem(123, 'INVALID_ITEM'))
        .rejects.toThrow('Item not in inventory');
    });
    
    it('应在道具过期时拒绝使用', async () => {
      const mockItem = {
        id: 1,
        item_id: 'PREMIER_BALL',
        category: 'pokeball',
        quantity: 10,
        is_consumable: true,
        expires_at: new Date(Date.now() - 86400000) // 昨天过期
      };
      
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockItem] })
        .mockResolvedValueOnce({ rows: [] });
      
      await expect(service.useItem(123, 'PREMIER_BALL'))
        .rejects.toThrow('expired');
    });
  });
  
  describe('dropItem', () => {
    let mockClient;
    
    beforeEach(() => {
      mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      mockDb.connect.mockResolvedValue(mockClient);
    });
    
    it('应成功丢弃道具', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 1, quantity: 10, is_droppable: true }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.dropItem(123, 'POKE_BALL', 5);
      
      expect(result.success).toBe(true);
      expect(result.droppedQuantity).toBe(5);
    });
    
    it('应在道具不可丢弃时拒绝', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [{ id: 1, quantity: 10, is_droppable: false }] });
      
      await expect(service.dropItem(123, 'MASTER_BALL', 1))
        .rejects.toThrow('cannot be dropped');
    });
    
    it('应在道具不存在时抛出错误', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      
      await expect(service.dropItem(123, 'INVALID_ITEM', 1))
        .rejects.toThrow('Item not found');
    });
  });
  
  describe('setQuickSlot', () => {
    it('应成功设置快速访问栏', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await service.setQuickSlot(123, 0, 'POKE_BALL');
      
      expect(result.success).toBe(true);
    });
    
    it('应在槽位索引无效时拒绝', async () => {
      await expect(service.setQuickSlot(123, 10, 'POKE_BALL'))
        .rejects.toThrow('Invalid slot index');
    });
    
    it('应在道具不存在时拒绝', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      await expect(service.setQuickSlot(123, 0, 'INVALID_ITEM'))
        .rejects.toThrow('Item not in inventory');
    });
  });
  
  describe('checkCapacity', () => {
    it('应正确检查容量', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ pokeball_slots: 100 }] })
        .mockResolvedValueOnce({ rows: [{ total: 50 }] });
      
      const result = await service.checkCapacity(123, 'pokeball', 10, mockDb);
      
      expect(result.canAdd).toBe(true);
      expect(result.remaining).toBe(50);
    });
    
    it('应在超限时返回 false', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ pokeball_slots: 100 }] })
        .mockResolvedValueOnce({ rows: [{ total: 95 }] });
      
      const result = await service.checkCapacity(123, 'pokeball', 10, mockDb);
      
      expect(result.canAdd).toBe(false);
    });
  });
  
  describe('cleanupExpiredItems', () => {
    it('应清理过期道具', async () => {
      const expiredItems = [
        { user_id: 123, item_id: 'PREMIER_BALL', quantity: 5 },
        { user_id: 456, item_id: 'PREMIER_BALL', quantity: 3 }
      ];
      
      mockDb.query
        .mockResolvedValueOnce({ rows: expiredItems })
        .mockResolvedValue({ rows: [] });
      
      const count = await service.cleanupExpiredItems();
      
      expect(count).toBe(2);
    });
    
    it('应处理无过期道具的情况', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      const count = await service.cleanupExpiredItems();
      
      expect(count).toBe(0);
    });
  });
  
  describe('getActiveEffects', () => {
    it('应返回激活的效果列表', async () => {
      mockRedis.keys.mockResolvedValue(['active_effect:123:LUCKY_EGG']);
      mockRedis.get.mockResolvedValue(JSON.stringify({
        itemId: 'LUCKY_EGG',
        activatedAt: Date.now()
      }));
      mockRedis.ttl.mockResolvedValue(1800);
      
      const effects = await service.getActiveEffects(123);
      
      expect(effects).toHaveLength(1);
      expect(effects[0].itemId).toBe('LUCKY_EGG');
    });
    
    it('应处理无激活效果的情况', async () => {
      mockRedis.keys.mockResolvedValue([]);
      
      const effects = await service.getActiveEffects(123);
      
      expect(effects).toHaveLength(0);
    });
  });
});

describe('Item Handler Tests', () => {
  let service;
  let mockDb;
  let mockRedis;
  let mockClient;
  
  beforeEach(() => {
    mockDb = { connect: jest.fn() };
    mockRedis = {};
    
    service = new InventoryService({ db: mockDb, redis: mockRedis });
    
    mockClient = { query: jest.fn(), release: jest.fn() };
    mockDb.connect.mockResolvedValue(mockClient);
  });
  
  describe('handlePotion', () => {
    it('应正确计算百分比治疗', async () => {
      const item = { effect_data: { heal_percent: 100 } };
      const context = { pokemonId: 100 };
      
      mockClient.query.mockResolvedValueOnce({ rows: [{ id: 100, hp: 50, max_hp: 100, is_fainted: false }] });
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      
      const result = await service.handlePotion(123, item, context, mockClient);
      
      expect(result.type).toBe('heal');
      expect(result.healedHp).toBe(50);
    });
    
    it('应正确处理复活', async () => {
      const item = { effect_data: { revive_percent: 50 } };
      const context = { pokemonId: 100 };
      
      mockClient.query.mockResolvedValueOnce({ rows: [{ id: 100, hp: 0, max_hp: 100, is_fainted: true }] });
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      
      const result = await service.handlePotion(123, item, context, mockClient);
      
      expect(result.type).toBe('revive');
      expect(result.healedHp).toBe(50);
    });
  });
  
  describe('handleBoost', () => {
    it('应正确处理 CP 提升', async () => {
      const item = { item_id: 'RARE_CANDY', effect_data: { cp_boost: 1 } };
      const context = { pokemonId: 100 };
      
      const result = await service.handleBoost(123, item, context, mockClient);
      
      expect(result.type).toBe('cp_boost');
      expect(result.boost).toBe(1);
    });
    
    it('应正确处理捕捉加成', async () => {
      const item = { 
        item_id: 'GOLDEN_RAZZ_BERRY', 
        effect_data: { catch_rate_multiplier: 2.5 } 
      };
      
      const result = await service.handleBoost(123, item, {}, mockClient);
      
      expect(result.type).toBe('catch_boost');
      expect(result.catchRateMultiplier).toBe(2.5);
    });
  });
});

describe('Edge Cases', () => {
  let service;
  let mockDb;
  let mockRedis;
  
  beforeEach(() => {
    mockDb = { connect: jest.fn(), query: jest.fn() };
    mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn() };
    
    service = new InventoryService({ db: mockDb, redis: mockRedis });
  });
  
  it('应处理空背包', async () => {
    mockRedis.get.mockResolvedValue(null);
    mockDb.query
      .mockResolvedValue({ rows: [] });
    
    const result = await service.getInventory(123);
    
    expect(result.stats.totalItems).toBe(0);
  });
  
  it('应处理数据库错误', async () => {
    mockDb.query.mockRejectedValue(new Error('Database error'));
    
    await expect(service.getInventory(123))
      .rejects.toThrow('Database error');
  });
  
  it('应处理 Redis 错误', async () => {
    mockRedis.get.mockRejectedValue(new Error('Redis error'));
    
    await expect(service.getInventory(123))
      .rejects.toThrow('Redis error');
  });
  
  it('应处理事务回滚', async () => {
    const mockClient = {
      query: jest.fn().mockRejectedValue(new Error('Insert failed')),
      release: jest.fn()
    };
    mockDb.connect.mockResolvedValue(mockClient);
    
    await expect(service.addItem(123, 'POKE_BALL', 1))
      .rejects.toThrow('Insert failed');
    
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
