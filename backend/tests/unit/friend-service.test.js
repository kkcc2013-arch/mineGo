/**
 * REQ-00048: 精灵好友系统单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Mock dependencies
const mockDb = {
  query: sinon.stub(),
  transaction: sinon.stub()
};

const mockRedis = {
  get: sinon.stub(),
  setex: sinon.stub(),
  del: sinon.stub(),
  zadd: sinon.stub(),
  zrange: sinon.stub()
};

const mockEventBus = {
  publish: sinon.stub().resolves()
};

// Load friend service with mocks
const FriendService = proxyquire('../../services/social-service/src/friendService', {
  '../../../shared/db': mockDb,
  '../../../shared/redis': mockRedis,
  '../../../shared/EventBus': mockEventBus
});

describe('FriendService', () => {
  let friendService;
  
  beforeEach(() => {
    friendService = new FriendService();
    sinon.resetAll();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('sendFriendRequest', () => {
    it('should send friend request successfully', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-2';
      const message = 'Let\'s be friends!';

      // Mock user existence check
      mockDb.query.onFirstCall().resolves({
        rows: [
          { id: fromUserId, username: 'user1' },
          { id: toUserId, username: 'user2' }
        ]
      });

      // Mock existing friendship check
      mockDb.query.onSecondCall().resolves({ rows: [] });

      // Mock friend count check
      mockDb.query.onThirdCall().resolves({ rows: [{ count: '10' }] });

      // Mock insert
      mockDb.query.onCall(3).resolves({
        rows: [{
          id: 1,
          from_user_id: fromUserId,
          to_user_id: toUserId,
          message,
          status: 'pending'
        }]
      });

      const result = await friendService.sendFriendRequest(fromUserId, toUserId, message);

      expect(result).to.have.property('id', 1);
      expect(result).to.have.property('status', 'pending');
      expect(mockEventBus.publish.calledOnce).to.be.true;
    });

    it('should reject self-friend request', async () => {
      const userId = 'user-1';
      
      try {
        await friendService.sendFriendRequest(userId, userId, '');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2012);
      }
    });

    it('should reject when already friends', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-2';

      mockDb.query.onFirstCall().resolves({
        rows: [
          { id: fromUserId },
          { id: toUserId }
        ]
      });

      mockDb.query.onSecondCall().resolves({
        rows: [{ id: 'friend-1', status: 'accepted' }]
      });

      try {
        await friendService.sendFriendRequest(fromUserId, toUserId, '');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2002);
      }
    });

    it('should reject when friend limit reached', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-2';

      mockDb.query.onFirstCall().resolves({
        rows: [
          { id: fromUserId },
          { id: toUserId }
        ]
      });

      mockDb.query.onSecondCall().resolves({ rows: [] });
      mockDb.query.onThirdCall().resolves({ rows: [{ count: '400' }] });

      try {
        await friendService.sendFriendRequest(fromUserId, toUserId, '');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2003);
      }
    });
  });

  describe('acceptFriendRequest', () => {
    it('should accept friend request and create bidirectional friendship', async () => {
      const userId = 'user-2';
      const requestId = 1;
      const fromUserId = 'user-1';

      const mockTrx = {
        query: sinon.stub(),
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        return callback(mockTrx);
      });

      // Mock get request
      mockTrx.query.onFirstCall().resolves({
        rows: [{
          id: requestId,
          from_user_id: fromUserId,
          to_user_id: userId,
          status: 'pending'
        }]
      });

      // Mock update request
      mockTrx.query.onSecondCall().resolves({ rowCount: 1 });

      // Mock insert friendships
      mockTrx.query.onThirdCall().resolves({ rowCount: 2 });

      const result = await friendService.acceptFriendRequest(userId, requestId);

      expect(result).to.have.property('success', true);
      expect(result).to.have.property('friendshipLevel', 1);
      expect(mockTrx.commit.calledOnce).to.be.true;
    });

    it('should reject invalid request', async () => {
      const userId = 'user-2';
      const requestId = 999;

      const mockTrx = {
        query: sinon.stub().resolves({ rows: [] }),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        return callback(mockTrx);
      });

      try {
        await friendService.acceptFriendRequest(userId, requestId);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2005);
        expect(mockTrx.rollback.calledOnce).to.be.true;
      }
    });
  });

  describe('getFriendList', () => {
    it('should return paginated friend list with online status', async () => {
      const userId = 'user-1';
      const options = { page: 1, limit: 10, sortBy: 'last_interaction' };

      const mockFriends = [
        {
          id: 'friend-1',
          username: 'friend1',
          avatar_url: 'avatar1.png',
          level: 25,
          friendship_level: 3,
          friendship_points: 500,
          last_interaction_at: new Date(),
          online_status: 'online'
        },
        {
          id: 'friend-2',
          username: 'friend2',
          avatar_url: 'avatar2.png',
          level: 30,
          friendship_level: 2,
          friendship_points: 200,
          last_interaction_at: new Date(Date.now() - 3600000),
          online_status: 'away'
        }
      ];

      mockDb.query.onFirstCall().resolves({ rows: mockFriends });
      mockDb.query.onSecondCall().resolves({ rows: [{ count: '2' }] });

      const result = await friendService.getFriendList(userId, options);

      expect(result.friends).to.have.lengthOf(2);
      expect(result.pagination).to.have.property('total', 2);
      expect(result.friends[0]).to.have.property('online_status');
    });
  });

  describe('sendGift', () => {
    it('should send item gift to friend', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-2';
      const giftData = {
        giftType: 'item',
        giftId: 'item-123',
        quantity: 5
      };

      // Mock friendship check
      mockDb.query.onFirstCall().resolves({
        rows: [{ id: 'friendship-1', status: 'accepted' }]
      });

      // Mock today gift count
      mockDb.query.onSecondCall().resolves({ rows: [{ count: '10' }] });

      // Mock inventory check
      mockDb.query.onThirdCall().resolves({
        rows: [{ item_id: 'item-123', quantity: 10 }]
      });

      // Mock inventory decrement
      mockDb.query.onCall(3).resolves({ rowCount: 1 });

      // Mock gift insert
      mockDb.query.onCall(4).resolves({
        rows: [{
          id: 'gift-1',
          from_user_id: fromUserId,
          to_user_id: toUserId,
          gift_type: 'item',
          status: 'pending'
        }]
      });

      const result = await friendService.sendGift(fromUserId, toUserId, giftData);

      expect(result).to.have.property('id', 'gift-1');
      expect(result).to.have.property('status', 'pending');
    });

    it('should reject gift to non-friend', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-3';
      const giftData = { giftType: 'item', giftId: 'item-123' };

      mockDb.query.onFirstCall().resolves({ rows: [] });

      try {
        await friendService.sendGift(fromUserId, toUserId, giftData);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2006);
      }
    });

    it('should reject when daily gift limit reached', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-2';
      const giftData = { giftType: 'item', giftId: 'item-123' };

      mockDb.query.onFirstCall().resolves({
        rows: [{ id: 'friendship-1' }]
      });
      mockDb.query.onSecondCall().resolves({ rows: [{ count: '50' }] });

      try {
        await friendService.sendGift(fromUserId, toUserId, giftData);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2009);
      }
    });

    it('should reject when insufficient item quantity', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-2';
      const giftData = { giftType: 'item', giftId: 'item-123', quantity: 10 };

      mockDb.query.onFirstCall().resolves({ rows: [{ id: 'friendship-1' }] });
      mockDb.query.onSecondCall().resolves({ rows: [{ count: '10' }] });
      mockDb.query.onThirdCall().resolves({ rows: [{ item_id: 'item-123', quantity: 5 }] });

      try {
        await friendService.sendGift(fromUserId, toUserId, giftData);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2007);
      }
    });
  });

  describe('claimGift', () => {
    it('should claim gift and add friendship points', async () => {
      const userId = 'user-2';
      const giftId = 1;

      const mockTrx = {
        query: sinon.stub(),
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        return callback(mockTrx);
      });

      // Mock get gift
      mockTrx.query.onFirstCall().resolves({
        rows: [{
          id: giftId,
          to_user_id: userId,
          gift_type: 'item',
          gift_id: 'item-123',
          quantity: 5,
          from_user_id: 'user-1',
          status: 'pending'
        }]
      });

      // Mock add to inventory
      mockTrx.query.onSecondCall().resolves({ rowCount: 1 });

      // Mock update gift status
      mockTrx.query.onThirdCall().resolves({ rowCount: 1 });

      // Mock add friendship points
      mockTrx.query.onCall(3).resolves({ rowCount: 1 });

      const result = await friendService.claimGift(userId, giftId);

      expect(result).to.have.property('success', true);
      expect(result).to.have.property('pointsEarned', 10);
      expect(mockTrx.commit.calledOnce).to.be.true;
    });

    it('should reject already claimed gift', async () => {
      const userId = 'user-2';
      const giftId = 1;

      const mockTrx = {
        query: sinon.stub().resolves({ rows: [] }),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        return callback(mockTrx);
      });

      try {
        await friendService.claimGift(userId, giftId);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2010);
      }
    });
  });

  describe('calculateFriendshipLevel', () => {
    it('should return correct friendship level based on points', () => {
      expect(friendService.calculateFriendshipLevel(0)).to.equal(1);
      expect(friendService.calculateFriendshipLevel(50)).to.equal(1);
      expect(friendService.calculateFriendshipLevel(100)).to.equal(2);
      expect(friendService.calculateFriendshipLevel(500)).to.equal(3);
      expect(friendService.calculateFriendshipLevel(1000)).to.equal(4);
      expect(friendService.calculateFriendshipLevel(2000)).to.equal(5);
      expect(friendService.calculateFriendshipLevel(5000)).to.equal(5);
    });
  });

  describe('addFriendByCode', () => {
    it('should send request by valid friend code', async () => {
      const userId = 'user-1';
      const friendCode = 'ABC123DEF456';
      const targetUserId = 'user-2';

      mockDb.query.onFirstCall().resolves({
        rows: [{ id: targetUserId, username: 'target' }]
      });

      // Mock user existence check
      mockDb.query.onSecondCall().resolves({
        rows: [
          { id: userId },
          { id: targetUserId }
        ]
      });

      // Mock existing friendship check
      mockDb.query.onThirdCall().resolves({ rows: [] });

      // Mock friend count check
      mockDb.query.onCall(3).resolves({ rows: [{ count: '10' }] });

      // Mock insert
      mockDb.query.onCall(4).resolves({
        rows: [{ id: 1, status: 'pending' }]
      });

      const result = await friendService.addFriendByCode(userId, friendCode);

      expect(result).to.have.property('status', 'pending');
    });

    it('should reject invalid friend code', async () => {
      const userId = 'user-1';
      const friendCode = 'INVALID';

      mockDb.query.onFirstCall().resolves({ rows: [] });

      try {
        await friendService.addFriendByCode(userId, friendCode);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.code).to.equal(2011);
      }
    });
  });

  describe('removeFriend', () => {
    it('should remove bidirectional friendship', async () => {
      const userId = 'user-1';
      const friendId = 'user-2';

      const mockTrx = {
        query: sinon.stub().resolves({ rowCount: 2 }),
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        return callback(mockTrx);
      });

      const result = await friendService.removeFriend(userId, friendId);

      expect(result).to.have.property('success', true);
      expect(mockTrx.commit.calledOnce).to.be.true;
    });
  });

  describe('getFriendLeaderboard', () => {
    it('should return cached leaderboard', async () => {
      const userId = 'user-1';
      const cachedData = [
        { id: 'friend-1', username: 'top1', friendship_points: 1000 }
      ];

      mockRedis.get.resolves(JSON.stringify(cachedData));

      const result = await friendService.getFriendLeaderboard(userId, 'friendship', 10);

      expect(result).to.deep.equal(cachedData);
      expect(mockRedis.get.calledOnce).to.be.true;
    });

    it('should fetch and cache leaderboard when not cached', async () => {
      const userId = 'user-1';
      const mockLeaderboard = [
        { id: 'friend-1', username: 'top1', friendship_points: 1000 },
        { id: 'friend-2', username: 'top2', friendship_points: 800 }
      ];

      mockRedis.get.resolves(null);
      mockDb.query.resolves({ rows: mockLeaderboard });
      mockRedis.setex.resolves();

      const result = await friendService.getFriendLeaderboard(userId, 'friendship', 10);

      expect(result).to.deep.equal(mockLeaderboard);
      expect(mockDb.query.calledOnce).to.be.true;
      expect(mockRedis.setex.calledOnce).to.be.true;
    });
  });
});
