/**
 * REQ-00096: 数据库事务隔离级别控制与死锁检测机制
 * 单元测试
 */

'use strict';

const { TransactionManager, ISOLATION_LEVELS, ERROR_CODES, isDeadlockError, isTimeoutError, parseDeadlockDetail, calculateRetryDelay } = require('../TransactionManager');
const { createLogger } = require('../logger');

// Mock pool
const mockPool = {
  connect: jest.fn(),
  query: jest.fn()
};

const mockClient = {
  query: jest.fn(),
  release: jest.fn()
};

describe('TransactionManager', () => {
  let transactionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
    transactionManager = new TransactionManager(mockPool);
  });

  describe('isDeadlockError', () => {
    test('should return true for deadlock detected error', () => {
      const error = { code: ERROR_CODES.DEADLOCK_DETECTED };
      expect(isDeadlockError(error)).toBe(true);
    });

    test('should return true for serialization failure error', () => {
      const error = { code: ERROR_CODES.SERIALIZATION_FAILURE };
      expect(isDeadlockError(error)).toBe(true);
    });

    test('should return false for other errors', () => {
      const error = { code: '23505' }; // unique violation
      expect(isDeadlockError(error)).toBe(false);
    });

    test('should return false for null error', () => {
      expect(isDeadlockError(null)).toBe(false);
    });
  });

  describe('isTimeoutError', () => {
    test('should return true for query canceled error', () => {
      const error = { code: ERROR_CODES.QUERY_CANCELED };
      expect(isTimeoutError(error)).toBe(true);
    });

    test('should return true for timeout message', () => {
      const error = { message: 'Transaction timeout' };
      expect(isTimeoutError(error)).toBe(true);
    });

    test('should return false for other errors', () => {
      const error = { code: '23505', message: 'Unique violation' };
      expect(isTimeoutError(error)).toBe(false);
    });
  });

  describe('parseDeadlockDetail', () => {
    test('should parse deadlock detail correctly', () => {
      const error = {
        code: '40P01',
        message: 'deadlock detected',
        detail: 'Process 12345 waits for ShareLock; blocked by process 67890.'
      };

      const result = parseDeadlockDetail(error);

      expect(result).toEqual({
        code: '40P01',
        message: 'deadlock detected',
        detail: 'Process 12345 waits for ShareLock; blocked by process 67890.',
        processes: [12345, 67890],
        timestamp: expect.any(Number)
      });
    });

    test('should return null for error without detail', () => {
      const error = { code: '40P01', message: 'deadlock detected' };
      expect(parseDeadlockDetail(error)).toBeNull();
    });
  });

  describe('calculateRetryDelay', () => {
    test('should calculate exponential backoff', () => {
      const delay1 = calculateRetryDelay(1, 100, 2000);
      const delay2 = calculateRetryDelay(2, 100, 2000);
      const delay3 = calculateRetryDelay(3, 100, 2000);

      // Delay should increase exponentially (with jitter)
      expect(delay1).toBeGreaterThan(50);
      expect(delay2).toBeGreaterThan(delay1 * 0.5);
      expect(delay3).toBeGreaterThan(delay2 * 0.5);
    });

    test('should cap delay at maxDelay', () => {
      const delay = calculateRetryDelay(10, 100, 2000);
      expect(delay).toBeLessThanOrEqual(2000);
    });
  });

  describe('execute', () => {
    test('should execute transaction successfully', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // user query
        .mockResolvedValueOnce({}); // COMMIT

      const result = await transactionManager.execute(async (client) => {
        return await client.query('SELECT * FROM users WHERE id = $1', [1]);
      }, { transactionName: 'test_query' });

      expect(result.rows).toEqual([{ id: 1 }]);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should use specified isolation level', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // query
        .mockResolvedValueOnce({}); // COMMIT

      await transactionManager.execute(async (client) => {
        return await client.query('SELECT 1');
      }, { 
        isolationLevel: ISOLATION_LEVELS['REPEATABLE READ'],
        transactionName: 'test_repeatable_read'
      });

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ');
    });

    test('should rollback on error', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed')) // user query
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        transactionManager.execute(async (client) => {
          throw new Error('Query failed');
        }, { transactionName: 'test_rollback' })
      ).rejects.toThrow('Query failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should timeout long-running transaction', async () => {
      mockClient.query.mockResolvedValueOnce({}); // BEGIN

      await expect(
        transactionManager.execute(async (client) => {
          await new Promise(resolve => setTimeout(resolve, 200)); // Simulate long operation
          return await client.query('SELECT 1');
        }, { 
          timeout: 100,
          transactionName: 'test_timeout'
        })
      ).rejects.toThrow('Transaction timeout');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    test('should retry on deadlock', async () => {
      const deadlockError = new Error('deadlock detected');
      deadlockError.code = ERROR_CODES.DEADLOCK_DETECTED;
      deadlockError.detail = 'Process 123 waits for ShareLock';

      let attempts = 0;

      mockClient.query
        .mockImplementation(async (sql) => {
          if (sql.includes('BEGIN')) {
            return {};
          }
          if (sql.includes('COMMIT')) {
            return {};
          }
          if (sql.includes('ROLLBACK')) {
            return {};
          }
          // User query
          attempts++;
          if (attempts === 1) {
            throw deadlockError;
          }
          return { rows: [{ id: 1 }] };
        });

      const result = await transactionManager.execute(async (client) => {
        return await client.query('SELECT * FROM users WHERE id = 1');
      }, {
        retryOnDeadlock: true,
        maxRetries: 3,
        transactionName: 'test_deadlock_retry'
      });

      expect(attempts).toBe(2); // 1 failure + 1 success
      expect(result.rows).toEqual([{ id: 1 }]);
    });

    test('should give up after max retries', async () => {
      const deadlockError = new Error('deadlock detected');
      deadlockError.code = ERROR_CODES.DEADLOCK_DETECTED;

      mockClient.query
        .mockImplementation(async (sql) => {
          if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) {
            return {};
          }
          throw deadlockError;
        });

      await expect(
        transactionManager.execute(async (client) => {
          return await client.query('SELECT 1');
        }, {
          retryOnDeadlock: true,
          maxRetries: 2,
          transactionName: 'test_max_retries'
        })
      ).rejects.toThrow('deadlock detected');

      // Should have tried 3 times (1 initial + 2 retries)
      expect(mockClient.query).toHaveBeenCalledTimes(6); // 3 * (BEGIN + query + ROLLBACK)
    });

    test('should not retry non-deadlock errors', async () => {
      const uniqueViolation = new Error('unique violation');
      uniqueViolation.code = '23505';

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(uniqueViolation) // user query
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        transactionManager.execute(async (client) => {
          return await client.query('INSERT INTO users (id) VALUES (1)');
        }, {
          retryOnDeadlock: true,
          maxRetries: 3,
          transactionName: 'test_no_retry'
        })
      ).rejects.toThrow('unique violation');

      // Should only try once
      expect(mockClient.query).toHaveBeenCalledTimes(3); // BEGIN + query + ROLLBACK
    });

    test('should throw error for invalid isolation level', async () => {
      await expect(
        transactionManager.execute(async (client) => {
          return await client.query('SELECT 1');
        }, {
          isolationLevel: 'INVALID LEVEL',
          transactionName: 'test_invalid_isolation'
        })
      ).rejects.toThrow('Invalid isolation level');
    });
  });

  describe('getActiveTransactions', () => {
    test('should return active transactions', async () => {
      mockClient.query.mockImplementation(async () => {
        // Simulate long-running transaction
        await new Promise(resolve => setTimeout(resolve, 1000));
        return {};
      });

      const txPromise = transactionManager.execute(async (client) => {
        await client.query('SELECT pg_sleep(1)');
      }, { 
        timeout: 5000,
        transactionName: 'test_active'
      });

      // Wait a bit for transaction to start
      await new Promise(resolve => setTimeout(resolve, 50));

      const active = transactionManager.getActiveTransactions();
      expect(active.length).toBe(1);
      expect(active[0].name).toBe('test_active');

      await txPromise;
    });
  });

  describe('SERIALIZABLE isolation level', () => {
    test('should use SERIALIZABLE for payment operations', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance: 100 }] })
        .mockResolvedValueOnce({ rows: [{ balance: 90 }] })
        .mockResolvedValueOnce({}); // COMMIT

      const result = await transactionManager.execute(async (client) => {
        // Simulate payment: deduct balance
        const { rows: [user] } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [1]);
        const newBalance = user.balance - 10;
        await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, 1]);
        return { success: true, newBalance };
      }, {
        isolationLevel: ISOLATION_LEVELS.SERIALIZABLE,
        timeout: 30000,
        retryOnDeadlock: true,
        maxRetries: 5,
        transactionName: 'payment_deduct'
      });

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL SERIALIZABLE');
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(90);
    });
  });
});

describe('Integration with db.js', () => {
  test('transaction function should support options', () => {
    const { transaction, ISOLATION_LEVELS } = require('../db');
    
    expect(typeof transaction).toBe('function');
    expect(ISOLATION_LEVELS).toBeDefined();
    expect(ISOLATION_LEVELS['READ COMMITTED']).toBe('READ COMMITTED');
    expect(ISOLATION_LEVELS['REPEATABLE READ']).toBe('REPEATABLE READ');
    expect(ISOLATION_LEVELS.SERIALIZABLE).toBe('SERIALIZABLE');
  });
});
