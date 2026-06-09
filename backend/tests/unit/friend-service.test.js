/**
 * REQ-00048: 好友系统单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Mock dependencies
const mockQuery = sinon.stub();
const mockTransaction = sinon.stub();
const mockRedis = {
  get: sinon.stub().resolves(null),
  setex: sinon.stub().resolves('OK'),
  del: sinon.stub().resolves(1)
};

const mockEventBus = {
  publish: sinon.stub().resolves(true)
};

const mockMetrics = {
  incrementCounter: sinon.stub(),
  observeHistogram: sinon.stub()
};

// Proxyquire the friendService with mocked dependencies
const friendService = proxyquire('../src/friendService', {
  '../../../shared/db': {
    query: mockQuery,
    transaction: mockTransaction
  },
  '../../../shared/redis': mockRedis,
  '../../../shared/EventBus': mockEventBus,
  '../../../shared/metrics': mockMetrics,
  '../../../shared/logger': {
    createLogger: () => ({
      info: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub()
    })
  }
});

describe('FriendService', () => {
  beforeEach(() => {
    // Reset all stubs
    sinon.resetHistory();
    
    // Default mock implementations
    mockTransaction.callsFake(async (fn) => {
      const mockClient = {
        query: mockQuery
      };
      return fn(mockClient);
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  // ============================================
  // 发送好友请求
  // ============================================
  describe('sendFriendRequest', () => {
    it('应该成功发送好友请求', async () => {
      // Mock 用户存在
      mockQuery.onFirstCall().resolves({
        rows: [
          { id: 'user1', username: 'Alice' },
          { id: 'user2', username: 'Bob' }
        ]
      });

      // Mock 无现有好友关系
      mockQuery.onSecondCall().resolves({ rows: [] });

      // Mock 无现有请求
      mockQuery.onThirdCall().resolves({ rows: [] });

      // Mock 接收方好友数量
      mockQuery.onCall(3).resolves({ rows: [{ count: 50 }] });

      // Mock 发送方待处理数量
      mockQuery.onCall(4).resolves({ rows: [{ count: 10 }] });

      // Mock 插入请求
      mockQuery.onCall(5).resolves({
        rows: [{
          id: 1,
          from_user_id: 'user1',
          to_user_id: 'user2',
          status: 'pending'
        }]
      });

      const result = await friendService.sendFriendRequest('user1', 'user2', 'Hi!');

      expect(result.success).to.be.true;
      expect(result.requestId).to.equal(1);
      expect(mockEventBus.publish.calledOnce).to.be.true;
    });

    it('应该拒绝添加自己为好友', async () => {
      try {
        await friendService.sendFriendRequest('user1', 'user1');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2012);
      }
    });

    it('应该拒绝已是好友的请求', async () => {
      mockQuery.onFirstCall().resolves({
        rows: [
          { id: 'user1', username: 'Alice' },
          { id: 'user2', username: 'Bob' }
        ]
      });

      mockQuery.onSecondCall().resolves({
        rows: [{ status: 'accepted' }]
      });

      try {
        await friendService.sendFriendRequest('user1', 'user2');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2002);
      }
    });

    it('应该拒绝好友数量超限的请求', async () => {
      mockQuery.onFirstCall().resolves({
        rows: [
          { id: 'user1', username: 'Alice' },
          { id: 'user2', username: 'Bob' }
        ]
      });

      mockQuery.onSecondCall().resolves({ rows: [] });
      mockQuery.onThirdCall().resolves({ rows: [] });

      // 接收方好友数量已达上限
      mockQuery.onCall(3).resolves({ rows: [{ count: 400 }] });

      try {
        await friendService.sendFriendRequest('user1', 'user2');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2003);
      }
    });
  });

  // ============================================
  // 接受好友请求
  // ============================================
  describe('acceptFriendRequest', () => {
    it('应该成功接受好友请求', async () => {
      mockQuery.onFirstCall().resolves({
        rows: [{
          id: 1,
          from_user_id: 'user1',
          to_user_id: 'user2',
          status: 'pending'
        }]
      });

      mockQuery.onSecondCall().resolves({ rowCount: 1 });
      mockQuery.onThirdCall().resolves({ rowCount: 2 });

      const result = await friendService.acceptFriendRequest('user2', 1);

      expect(result.success).to.be.true;
      expect(result.friendshipLevel).to.equal(1);
      expect(mockEventBus.publish.calledOnce).to.be.true;
    });

    it('应该拒绝不存在的好友请求', async () => {
      mockQuery.onFirstCall().resolves({ rows: [] });

      try {
        await friendService.acceptFriendRequest('user2', 999);
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2005);
      }
    });
  });

  // ============================================
  // 获取好友列表
  // ============================================
  describe('getFriendList', () => {
    it('应该返回好友列表', async () => {
      const mockFriends = [
        {
          id: 'friend1',
          username: 'Alice',
          avatar_url: 'avatar1.png',
          level: 25,
          friendship_level: 2,
          friendship_points: 150,
          online_status: 'online'
        },
        {
          id: 'friend2',
          username: 'Bob',
          avatar_url: 'avatar2.png',
          level: 30,
          friendship_level: 3,
          friendship_points: 600,
          online_status: 'offline'
        }
      ];

      mockQuery.onFirstCall().resolves({ rows: mockFriends });
      mockQuery.onSecondCall().resolves({ rows: [{ count: 2 }] });
      mockQuery.onThirdCall().resolves({ rows: [] });

      const result = await friendService.getFriendList('user1');

      expect(result.friends).to.have.lengthOf(2);
      expect(result.pagination.total).to.equal(2);
    });

    it('应该支持分页和排序', async () => {
      mockQuery.onFirstCall().resolves({ rows: [] });
      mockQuery.onSecondCall().resolves({ rows: [{ count: 0 }] });
      mockQuery.onThirdCall().resolves({ rows: [] });

      await friendService.getFriendList('user1', { page: 2, limit: 10, sortBy: 'level' });

      // 验证查询参数
    });
  });

  // ============================================
  // 发送礼物
  // ============================================
  describe('sendGift', () => {
    it('应该成功发送道具礼物', async () => {
      // Mock 好友关系
      mockQuery.onFirstCall().resolves({
        rows: [{ status: 'accepted' }]
      });

      // Mock 今日礼物数量
      mockQuery.onSecondCall().resolves({ rows: [{ count: 5 }] });

      // Mock 库存检查
      mockQuery.onThirdCall().resolves({
        rows: [{ quantity: 10 }]
      });

      // Mock 扣减库存
      mockQuery.onCall(3).resolves({ rowCount: 1 });

      // Mock 创建礼物
      mockQuery.onCall(4).resolves({
        rows: [{
          id: 1,
          from_user_id: 'user1',
          to_user_id: 'user2',
          gift_type: 'item',
          quantity: 1
        }]
      });

      const result = await friendService.sendGift('user1', 'user2', {
        giftType: 'item',
        giftId: 'item1',
        quantity: 1,
        giftName: '精灵球'
      });

      expect(result.success).to.be.true;
      expect(mockEventBus.publish.calledOnce).to.be.true;
    });

    it('应该拒绝非好友的礼物', async () => {
      mockQuery.onFirstCall().resolves({ rows: [] });

      try {
        await friendService.sendGift('user1', 'user2', {
          giftType: 'item',
          giftId: 'item1'
        });
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2006);
      }
    });

    it('应该拒绝超过每日限制的礼物', async () => {
      mockQuery.onFirstCall().resolves({
        rows: [{ status: 'accepted' }]
      });

      mockQuery.onSecondCall().resolves({ rows: [{ count: 50 }] });

      try {
        await friendService.sendGift('user1', 'user2', {
          giftType: 'item',
          giftId: 'item1'
        });
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2009);
      }
    });

    it('应该拒绝库存不足的礼物', async () => {
      mockQuery.onFirstCall().resolves({
        rows: [{ status: 'accepted' }]
      });

      mockQuery.onSecondCall().resolves({ rows: [{ count: 5 }] });
      mockQuery.onThirdCall().resolves({ rows: [{ quantity: 0 }] });

      try {
        await friendService.sendGift('user1', 'user2', {
          giftType: 'item',
          giftId: 'item1',
          quantity: 1
        });
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2007);
      }
    });
  });

  // ============================================
  // 领取礼物
  // ============================================
  describe('claimGift', () => {
    it('应该成功领取礼物', async () => {
      const mockGift = {
        id: 1,
        from_user_id: 'user1',
        to_user_id: 'user2',
        gift_type: 'item',
        gift_id: 'item1',
        gift_name: '精灵球',
        quantity: 5
      };

      mockQuery.onFirstCall().resolves({ rows: [mockGift] });
      mockQuery.onSecondCall().resolves({ rowCount: 1 });
      mockQuery.onThirdCall().resolves({ rowCount: 1 });
      mockQuery.onCall(3).resolves({ rowCount: 1 });
      mockQuery.onCall(4).resolves({ rows: [] });
      mockQuery.onCall(5).resolves({ rows: [] });
      mockQuery.onCall(6).resolves({ rows: [] });

      const result = await friendService.claimGift('user2', 1);

      expect(result.success).to.be.true;
      expect(result.giftType).to.equal('item');
      expect(result.pointsEarned).to.equal(10);
    });

    it('应该拒绝不存在或已领取的礼物', async () => {
      mockQuery.onFirstCall().resolves({ rows: [] });

      try {
        await friendService.claimGift('user2', 999);
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2010);
      }
    });
  });

  // ============================================
  // 友情等级计算
  // ============================================
  describe('calculateFriendshipLevel', () => {
    it('应该正确计算友情等级', () => {
      expect(friendService.calculateFriendshipLevel(0)).to.equal(1);
      expect(friendService.calculateFriendshipLevel(50)).to.equal(1);
      expect(friendService.calculateFriendshipLevel(100)).to.equal(2);
      expect(friendService.calculateFriendshipLevel(500)).to.equal(3);
      expect(friendService.calculateFriendshipLevel(1000)).to.equal(4);
      expect(friendService.calculateFriendshipLevel(2000)).to.equal(5);
      expect(friendService.calculateFriendshipLevel(5000)).to.equal(6);
      expect(friendService.calculateFriendshipLevel(10000)).to.equal(6);
    });
  });

  // ============================================
  // 删除好友
  // ============================================
  describe('removeFriend', () => {
    it('应该成功删除好友', async () => {
      mockQuery.onFirstCall().resolves({
        rows: [{ id: 1, user_id: 'user1', friend_user_id: 'user2' }]
      });

      const result = await friendService.removeFriend('user1', 'user2');

      expect(result.success).to.be.true;
      expect(mockEventBus.publish.calledOnce).to.be.true;
    });

    it('应该拒绝非好友关系的删除', async () => {
      mockQuery.onFirstCall().resolves({ rows: [] });

      try {
        await friendService.removeFriend('user1', 'user2');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2006);
      }
    });
  });

  // ============================================
  // 通过好友码添加好友
  // ============================================
  describe('addFriendByCode', () => {
    it('应该成功通过好友码查找用户', async () => {
      mockQuery.onFirstCall().resolves({
        rows: [{ id: 'user2' }]
      });

      // 后续是 sendFriendRequest 的 mock
      mockQuery.onSecondCall().resolves({
        rows: [
          { id: 'user1', username: 'Alice' },
          { id: 'user2', username: 'Bob' }
        ]
      });

      await friendService.addFriendByCode('user1', 'ABC12345');
    });

    it('应该拒绝无效好友码', async () => {
      mockQuery.onFirstCall().resolves({ rows: [] });

      try {
        await friendService.addFriendByCode('user1', 'INVALID');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error.code).to.equal(2011);
      }
    });
  });

  // ============================================
  // 好友排行榜
  // ============================================
  describe('getFriendLeaderboard', () => {
    it('应该返回友情排行榜', async () => {
      const mockLeaderboard = [
        { id: 'f1', username: 'Alice', friendship_points: 1000 },
        { id: 'f2', username: 'Bob', friendship_points: 500 }
      ];

      mockQuery.resolves({ rows: mockLeaderboard });

      const result = await friendService.getFriendLeaderboard('user1', 'friendship', 10);

      expect(result).to.have.lengthOf(2);
    });

    it('应该使用缓存', async () => {
      const cachedData = [{ id: 'f1', username: 'Cached' }];
      mockRedis.get.resolves(JSON.stringify(cachedData));

      const result = await friendService.getFriendLeaderboard('user1', 'friendship', 10);

      expect(result).to.deep.equal(cachedData);
      expect(mockQuery.called).to.be.false;
    });
  });

  // ============================================
  // 搜索用户
  // ============================================
  describe('searchUsers', () => {
    it('应该返回匹配的用户', async () => {
      const mockUsers = [
        { id: 'u1', username: 'alice', level: 20 },
        { id: 'u2', username: 'alice2', level: 15 }
      ];

      mockQuery.resolves({ rows: mockUsers });

      const result = await friendService.searchUsers('user1', 'alice', 20);

      expect(result).to.have.lengthOf(2);
    });
  });

  // ============================================
  // 辅助方法
  // ============================================
  describe('helper methods', () => {
    it('getFriendCount 应该返回正确数量', async () => {
      mockQuery.resolves({ rows: [{ count: 42 }] });
      
      const count = await friendService.getFriendCount('user1');
      
      expect(count).to.equal(42);
    });

    it('getTodayGiftCount 应该返回正确数量', async () => {
      mockQuery.resolves({ rows: [{ count: 5 }] });
      
      const count = await friendService.getTodayGiftCount('user1');
      
      expect(count).to.equal(5);
    });

    it('updateUserActiveStatus 应该更新用户状态', async () => {
      mockQuery.resolves({ rowCount: 1 });
      
      await friendService.updateUserActiveStatus('user1');
      
      expect(mockQuery.calledOnce).to.be.true;
    });
  });
});

// ============================================
// 运行测试
// ============================================
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha({ timeout: 10000 });
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}
