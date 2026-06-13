// backend/tests/unit/bag-upgrade.test.js
// REQ-00150: 背包容量扩展与购买系统 - 单元测试

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { InventoryService } = require('../../services/pokemon-service/src/inventoryService');

describe('REQ-00150: 背包容量扩展与购买系统', () => {
  let inventoryService;
  let mockDb;
  let mockRedis;
  let mockEventBus;

  beforeEach(() => {
    // Mock 数据库
    mockDb = {
      connect: sinon.stub(),
      query: sinon.stub()
    };

    // Mock Redis
    mockRedis = {
      get: sinon.stub().resolves(null),
      setex: sinon.stub().resolves('OK'),
      del: sinon.stub().resolves(1)
    };

    // Mock EventBus
    mockEventBus = {
      publish: sinon.stub().resolves()
    };

    inventoryService = new InventoryService({
      db: mockDb,
      redis: mockRedis,
      eventBus: mockEventBus
    });

    // Mock logger
    inventoryService.logger = {
      info: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub()
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getUpgradeConfigs', () => {
    it('应该返回扩容配置列表', async () => {
      const mockConfigs = [
        {
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          gem_cost: 100,
          required_level: 5,
          max_upgrades: 20,
          is_active: true
        }
      ];

      mockDb.query.onFirstCall().resolves({ rows: mockConfigs });
      mockDb.query.onSecondCall().resolves({ rows: [] });

      const result = await inventoryService.getUpgradeConfigs(1);

      expect(result).to.be.an('array');
      expect(result[0]).to.include({
        upgrade_id: 'base_50',
        category: 'base',
        increment: 50,
        purchased: 0,
        available: true
      });
    });

    it('应该正确计算已购买次数', async () => {
      const mockConfigs = [
        {
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          gem_cost: 100,
          required_level: 5,
          max_upgrades: 2,
          is_active: true
        }
      ];

      mockDb.query.onFirstCall().resolves({ rows: mockConfigs });
      mockDb.query.onSecondCall().resolves({ 
        rows: [{ upgrade_id: 'base_50', purchase_count: '2' }] 
      });

      const result = await inventoryService.getUpgradeConfigs(1);

      expect(result[0].purchased).to.equal(2);
      expect(result[0].available).to.be.false;
    });

    it('应该从缓存返回配置', async () => {
      const cachedConfigs = [{ upgrade_id: 'base_50', purchased: 1 }];
      mockRedis.get.resolves(JSON.stringify(cachedConfigs));

      const result = await inventoryService.getUpgradeConfigs(1);

      expect(result).to.deep.equal(cachedConfigs);
      expect(mockDb.query.called).to.be.false;
    });
  });

  describe('purchaseBagUpgrade', () => {
    it('应该成功购买背包扩容（金币）', async () => {
      const mockClient = {
        query: sinon.stub(),
        release: sinon.stub()
      };

      mockDb.connect.resolves(mockClient);

      // Mock 配置查询
      mockClient.query.onFirstCall().resolves({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          gem_cost: 100,
          max_upgrades: 20
        }]
      });

      // Mock 购买次数查询
      mockClient.query.onSecondCall().resolves({ rows: [{ count: '0' }] });

      // Mock 扣款
      mockClient.query.onThirdCall().resolves({
        rows: [{ gold: 40000 }]
      });

      // Mock 插入购买记录
      mockClient.query.onCall(3).resolves({ rowCount: 1 });

      // Mock 更新容量
      mockClient.query.onCall(4).resolves({ rowCount: 1 });

      // Mock commit
      mockClient.query.onCall(5).resolves();

      const result = await inventoryService.purchaseBagUpgrade(1, 'base_50', 'gold');

      expect(result.success).to.be.true;
      expect(result.category).to.equal('base');
      expect(result.increment).to.equal(50);
      expect(result.cost).to.equal(10000);
      expect(result.method).to.equal('gold');
      expect(result.newBalance).to.equal(40000);
    });

    it('应该在配置不存在时抛出错误', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [] }),
        release: sinon.stub()
      };

      mockDb.connect.resolves(mockClient);

      try {
        await inventoryService.purchaseBagUpgrade(1, 'invalid_id', 'gold');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.message).to.equal('Upgrade config not found');
      }
    });

    it('应该在达到最大购买次数时抛出错误', async () => {
      const mockClient = {
        query: sinon.stub(),
        release: sinon.stub()
      };

      mockDb.connect.resolves(mockClient);

      mockClient.query.onFirstCall().resolves({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          max_upgrades: 2
        }]
      });

      mockClient.query.onSecondCall().resolves({ rows: [{ count: '2' }] });

      try {
        await inventoryService.purchaseBagUpgrade(1, 'base_50', 'gold');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.message).to.equal('Maximum upgrades reached');
      }
    });

    it('应该在余额不足时抛出错误', async () => {
      const mockClient = {
        query: sinon.stub(),
        release: sinon.stub()
      };

      mockDb.connect.resolves(mockClient);

      mockClient.query.onFirstCall().resolves({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          max_upgrades: 20
        }]
      });

      mockClient.query.onSecondCall().resolves({ rows: [{ count: '0' }] });

      // 模拟扣款失败（余额不足）
      mockClient.query.onThirdCall().resolves({ rows: [] });

      try {
        await inventoryService.purchaseBagUpgrade(1, 'base_50', 'gold');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.message).to.equal('Insufficient balance');
      }
    });

    it('应该正确发布事件和清除缓存', async () => {
      const mockClient = {
        query: sinon.stub(),
        release: sinon.stub()
      };

      mockDb.connect.resolves(mockClient);

      mockClient.query.onFirstCall().resolves({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50,
          gold_cost: 10000,
          max_upgrades: 20
        }]
      });

      mockClient.query.onSecondCall().resolves({ rows: [{ count: '0' }] });
      mockClient.query.onThirdCall().resolves({ rows: [{ gold: 40000 }] });
      mockClient.query.onCall(3).resolves({ rowCount: 1 });
      mockClient.query.onCall(4).resolves({ rowCount: 1 });
      mockClient.query.onCall(5).resolves();

      await inventoryService.purchaseBagUpgrade(1, 'base_50', 'gold');

      // 验证事件发布
      expect(mockEventBus.publish.calledOnce).to.be.true;
      expect(mockEventBus.publish.firstCall.args[0]).to.equal('bag.upgrade.purchased');
      
      // 验证缓存清除
      expect(mockRedis.del.calledTwice).to.be.true;
    });
  });

  describe('grantFreeUpgrade', () => {
    it('应该成功赠送免费扩容', async () => {
      const mockClient = {
        query: sinon.stub(),
        release: sinon.stub()
      };

      mockDb.query.onFirstCall().resolves({
        rows: [{
          upgrade_id: 'base_50',
          category: 'base',
          increment: 50
        }]
      });

      mockDb.connect.resolves(mockClient);

      mockClient.query.onFirstCall().resolves({ rowCount: 1 });
      mockClient.query.onSecondCall().resolves({ rowCount: 1 });
      mockClient.query.onThirdCall().resolves();

      const result = await inventoryService.grantFreeUpgrade(1, 'base_50', 'achievement');

      expect(result.success).to.be.true;
      expect(result.category).to.equal('base');
      expect(result.increment).to.equal(50);
      expect(result.reason).to.equal('achievement');
    });

    it('应该在配置不存在时抛出错误', async () => {
      mockDb.query.resolves({ rows: [] });

      try {
        await inventoryService.grantFreeUpgrade(1, 'invalid_id', 'achievement');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.message).to.equal('Upgrade config not found');
      }
    });
  });

  describe('Prometheus 指标', () => {
    it('应该注册扩容相关指标', () => {
      expect(inventoryService.metrics).to.have.property('bagUpgradesPurchased');
      expect(inventoryService.metrics).to.have.property('bagUpgradeRevenue');
    });
  });
});
