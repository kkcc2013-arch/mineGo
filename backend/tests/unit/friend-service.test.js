/**
 * REQ-00048: 精灵好友系统单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

// Mock dependencies
jest.mock('../../shared/db', () => {
  const sinon = require('sinon');
  return {
    query: sinon.stub(),
    transaction: sinon.stub()
  };
});

jest.mock('../../shared/redis', () => {
  const sinon = require('sinon');
  const mock = {
    getRedis: () => mock,
    get: sinon.stub(),
    setex: sinon.stub(),
    del: sinon.stub(),
    zadd: sinon.stub(),
    zrange: sinon.stub()
  };
  return mock;
});

jest.mock('../../shared/EventBus', () => {
  const sinon = require('sinon');
  return {
    publish: sinon.stub().resolves()
  };
});

jest.mock('../../shared/metrics', () => {
  const sinon = require('sinon');
  return {
    incrementCounter: sinon.stub(),
    observeHistogram: sinon.stub()
  };
});

jest.mock('../../shared/logger', () => {
  const sinon = require('sinon');
  const mockLogger = {
    info: sinon.stub(),
    error: sinon.stub(),
    warn: sinon.stub(),
    debug: sinon.stub()
  };
  return {
    createLogger: () => mockLogger,
    logger: mockLogger
  };
});

const mockDb = require('../../shared/db');
const mockRedis = require('../../shared/redis');
const mockEventBus = require('../../shared/EventBus');
const mockMetrics = require('../../shared/metrics');
const { logger: mockLogger } = require('../../shared/logger');

// Load friend service
const { FriendService } = require('../../services/social-service/src/friendService');

describe('FriendService', () => {
  let friendService;
  
  beforeEach(() => {
    friendService = new FriendService();
    sinon.reset();

    // Reset histories manually
    mockDb.query.resetHistory();
    mockDb.transaction.resetHistory();
    mockRedis.get.resetHistory();
    mockRedis.setex.resetHistory();
    mockRedis.del.resetHistory();
    mockRedis.zadd.resetHistory();
    mockRedis.zrange.resetHistory();
    mockEventBus.publish.resetHistory();
    mockMetrics.incrementCounter.resetHistory();
    mockMetrics.observeHistogram.resetHistory();

    // Default stub implementations
    mockDb.query.callsFake(async (sql) => {
      return { rows: [], rowCount: 0 };
    });

    mockDb.transaction.callsFake(async (callback) => {
      const mockTrx = {
        query: sinon.stub().resolves({ rows: [], rowCount: 0 }),
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };
      try {
        const res = await callback(mockTrx);
        await mockTrx.commit();
        return res;
      } catch (err) {
        await mockTrx.rollback();
        throw err;
      }
    });

    mockRedis.get.resolves(null);
    mockRedis.setex.resolves();
    mockRedis.del.resolves();
    mockRedis.zadd.resolves();
    mockRedis.zrange.resolves();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('sendFriendRequest', () => {
    it('should send friend request successfully', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-2';
      const message = 'Let\'s be friends!';

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT id, username FROM users')) {
          return {
            rows: [
              { id: fromUserId, username: 'user1' },
              { id: toUserId, username: 'user2' }
            ]
          };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friends')) {
          return { rows: [{ count: 10 }] };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friend_requests')) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('INSERT INTO friend_requests')) {
          return {
            rows: [{
              id: 1,
              from_user_id: fromUserId,
              to_user_id: toUserId,
              message,
              status: 'pending'
            }]
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await friendService.sendFriendRequest(fromUserId, toUserId, message);

      expect(result).to.have.property('success', true);
      expect(result).to.have.property('requestId', 1);
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

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT id, username FROM users')) {
          return {
            rows: [
              { id: fromUserId },
              { id: toUserId }
            ]
          };
        }
        if (sql.includes('SELECT * FROM friends')) {
          return {
            rows: [{ id: 'friend-1', status: 'accepted' }]
          };
        }
        return { rows: [], rowCount: 0 };
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

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT id, username FROM users')) {
          return {
            rows: [
              { id: fromUserId },
              { id: toUserId }
            ]
          };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friends')) {
          return { rows: [{ count: 400 }] };
        }
        return { rows: [], rowCount: 0 };
      });

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
        try {
          const res = await callback(mockTrx);
          await mockTrx.commit();
          return res;
        } catch (err) {
          await mockTrx.rollback();
          throw err;
        }
      });

      mockTrx.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM friend_requests')) {
          return {
            rows: [{
              id: requestId,
              from_user_id: fromUserId,
              to_user_id: userId,
              status: 'pending'
            }]
          };
        }
        return { rows: [], rowCount: 1 };
      });

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
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        try {
          const res = await callback(mockTrx);
          await mockTrx.commit();
          return res;
        } catch (err) {
          await mockTrx.rollback();
          throw err;
        }
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

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('FROM friends f') && sql.includes('JOIN users u')) {
          return { rows: mockFriends };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friends')) {
          return { rows: [{ count: 2 }] };
        }
        return { rows: [], rowCount: 0 };
      });

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

      const mockTrx = {
        query: sinon.stub(),
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        try {
          const res = await callback(mockTrx);
          await mockTrx.commit();
          return res;
        } catch (err) {
          await mockTrx.rollback();
          throw err;
        }
      });

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM friends')) {
          return { rows: [{ id: 'friendship-1', status: 'accepted' }] };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friend_gifts')) {
          return { rows: [{ count: 10 }] };
        }
        return { rows: [], rowCount: 0 };
      });

      mockTrx.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM user_inventory')) {
          return { rows: [{ item_id: 'item-123', quantity: 10 }] };
        }
        if (sql.includes('INSERT INTO friend_gifts')) {
          return {
            rows: [{
              id: 'gift-1',
              from_user_id: fromUserId,
              to_user_id: toUserId,
              gift_type: 'item',
              status: 'pending'
            }]
          };
        }
        return { rows: [], rowCount: 1 };
      });

      const result = await friendService.sendGift(fromUserId, toUserId, giftData);

      expect(result).to.have.property('success', true);
      expect(result).to.have.property('giftId', 'gift-1');
    });

    it('should reject gift to non-friend', async () => {
      const fromUserId = 'user-1';
      const toUserId = 'user-3';
      const giftData = { giftType: 'item', giftId: 'item-123' };

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM friends')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      });

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

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM friends')) {
          return { rows: [{ id: 'friendship-1' }] };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friend_gifts')) {
          return { rows: [{ count: 50 }] };
        }
        return { rows: [], rowCount: 0 };
      });

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

      const mockTrx = {
        query: sinon.stub(),
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        try {
          const res = await callback(mockTrx);
          await mockTrx.commit();
          return res;
        } catch (err) {
          await mockTrx.rollback();
          throw err;
        }
      });

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM friends')) {
          return { rows: [{ id: 'friendship-1' }] };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friend_gifts')) {
          return { rows: [{ count: 10 }] };
        }
        return { rows: [], rowCount: 0 };
      });

      mockTrx.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM user_inventory')) {
          return { rows: [{ item_id: 'item-123', quantity: 5 }] };
        }
        return { rows: [], rowCount: 0 };
      });

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
        try {
          const res = await callback(mockTrx);
          await mockTrx.commit();
          return res;
        } catch (err) {
          await mockTrx.rollback();
          throw err;
        }
      });

      mockTrx.query.callsFake(async (sql) => {
        if (sql.includes('SELECT * FROM friend_gifts')) {
          return {
            rows: [{
              id: giftId,
              to_user_id: userId,
              gift_type: 'item',
              gift_id: 'item-123',
              quantity: 5,
              from_user_id: 'user-1',
              status: 'pending'
            }]
          };
        }
        if (sql.includes('SELECT id, friendship_points, friendship_level FROM friends')) {
          return {
            rows: [
              { id: 101, friendship_points: 10, friendship_level: 1, user_id: 'user-1', friend_user_id: userId }
            ]
          };
        }
        return { rows: [], rowCount: 1 };
      });

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
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        try {
          const res = await callback(mockTrx);
          await mockTrx.commit();
          return res;
        } catch (err) {
          await mockTrx.rollback();
          throw err;
        }
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

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT id FROM users WHERE friend_code')) {
          return { rows: [{ id: targetUserId }] };
        }
        if (sql.includes('SELECT id, username FROM users')) {
          return {
            rows: [
              { id: userId, username: 'user1' },
              { id: targetUserId, username: 'user2' }
            ]
          };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friends')) {
          return { rows: [{ count: 10 }] };
        }
        if (sql.includes('SELECT COUNT(*)::int as count FROM friend_requests')) {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes('INSERT INTO friend_requests')) {
          return {
            rows: [{ id: 1, status: 'pending' }]
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await friendService.addFriendByCode(userId, friendCode);

      expect(result).to.have.property('success', true);
      expect(result).to.have.property('requestId', 1);
    });

    it('should reject invalid friend code', async () => {
      const userId = 'user-1';
      const friendCode = 'INVALID';

      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('SELECT id FROM users WHERE friend_code')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      });

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
        query: sinon.stub(),
        commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves()
      };

      mockDb.transaction.callsFake(async (callback) => {
        try {
          const res = await callback(mockTrx);
          await mockTrx.commit();
          return res;
        } catch (err) {
          await mockTrx.rollback();
          throw err;
        }
      });

      mockTrx.query.callsFake(async (sql) => {
        if (sql.includes('DELETE FROM friends')) {
          return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
        }
        return { rows: [], rowCount: 0 };
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
      mockDb.query.callsFake(async (sql) => {
        if (sql.includes('FROM friends f') && sql.includes('JOIN users u')) {
          return { rows: mockLeaderboard };
        }
        return { rows: [], rowCount: 0 };
      });
      mockRedis.setex.resolves();

      const result = await friendService.getFriendLeaderboard(userId, 'friendship', 10);

      expect(result).to.deep.equal(mockLeaderboard);
      expect(mockDb.query.calledOnce).to.be.true;
      expect(mockRedis.setex.calledOnce).to.be.true;
    });
  });
});
