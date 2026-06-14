// tests/unit/transactionManager.test.js
'use strict';

const { 
  IsolationLevel, 
  isDeadlockError, 
  isSerializationError,
  transactionWithIsolation,
} = require('../../shared/transactionManager');

// Mock db module
jest.mock('../../shared/db', () => ({
  getPool: jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({
      query: jest.fn(),
      release: jest.fn(),
    })),
  })),
}));

describe('TransactionManager', () => {
  describe('isDeadlockError', () => {
    test('should detect PostgreSQL deadlock error code 40P01', () => {
      const err = { code: '40P01', message: 'deadlock detected' };
      expect(isDeadlockError(err)).toBe(true);
    });

    test('should detect lock not available error code 55P03', () => {
      const err = { code: '55P03', message: 'lock not available' };
      expect(isDeadlockError(err)).toBe(true);
    });

    test('should detect deadlock in message', () => {
      const err = { message: 'ERROR: deadlock detected in transaction' };
      expect(isDeadlockError(err)).toBe(true);
    });

    test('should detect could not obtain lock in message', () => {
      const err = { message: 'could not obtain lock on relation' };
      expect(isDeadlockError(err)).toBe(true);
    });

    test('should return false for non-deadlock errors', () => {
      const err = { code: '23505', message: 'duplicate key value' };
      expect(isDeadlockError(err)).toBe(false);
    });

    test('should handle null/undefined errors', () => {
      expect(isDeadlockError(null)).toBe(false);
      expect(isDeadlockError(undefined)).toBe(false);
      expect(isDeadlockError({})).toBe(false);
    });
  });

  describe('isSerializationError', () => {
    test('should detect serialization failure error code 40001', () => {
      const err = { code: '40001', message: 'could not serialize access' };
      expect(isSerializationError(err)).toBe(true);
    });

    test('should detect serialization failure in message', () => {
      const err = { message: 'ERROR: could not serialize access due to concurrent update' };
      expect(isSerializationError(err)).toBe(true);
    });

    test('should return false for non-serialization errors', () => {
      const err = { code: '40P01', message: 'deadlock detected' };
      expect(isSerializationError(err)).toBe(false);
    });
  });

  describe('IsolationLevel constants', () => {
    test('should have READ_COMMITTED level', () => {
      expect(IsolationLevel.READ_COMMITTED).toBe('READ COMMITTED');
    });

    test('should have REPEATABLE_READ level', () => {
      expect(IsolationLevel.REPEATABLE_READ).toBe('REPEATABLE READ');
    });

    test('should have SERIALIZABLE level', () => {
      expect(IsolationLevel.SERIALIZABLE).toBe('SERIALIZABLE');
    });
  });

  describe('transactionWithIsolation', () => {
    test('should execute transaction with READ COMMITTED by default', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // callback query
          .mockResolvedValueOnce({}), // COMMIT
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn(() => Promise.resolve(mockClient)),
      };

      const { getPool } = require('../../shared/db');
      getPool.mockReturnValue(mockPool);

      const result = await transactionWithIsolation(async (client) => {
        return await client.query('SELECT 1');
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('BEGIN ISOLATION LEVEL READ COMMITTED')
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should execute transaction with SERIALIZABLE isolation level', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // callback query
          .mockResolvedValueOnce({}), // COMMIT
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn(() => Promise.resolve(mockClient)),
      };

      const { getPool } = require('../../shared/db');
      getPool.mockReturnValue(mockPool);

      const result = await transactionWithIsolation(
        async (client) => {
          return await client.query('SELECT 1');
        },
        { isolationLevel: IsolationLevel.SERIALIZABLE }
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('BEGIN ISOLATION LEVEL SERIALIZABLE')
      );
    });

    test('should rollback on error', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockRejectedValueOnce(new Error('Query failed')) // callback query fails
          .mockResolvedValueOnce({}), // ROLLBACK
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn(() => Promise.resolve(mockClient)),
      };

      const { getPool } = require('../../shared/db');
      getPool.mockReturnValue(mockPool);

      await expect(
        transactionWithIsolation(async (client) => {
          throw new Error('Query failed');
        })
      ).rejects.toThrow('Query failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should retry on deadlock error', async () => {
      const deadlockError = new Error('deadlock detected');
      deadlockError.code = '40P01';

      let attempt = 0;
      const mockClient = {
        query: jest.fn((sql) => {
          attempt++;
          if (sql.includes('BEGIN')) {
            return Promise.resolve({});
          } else if (sql.includes('ROLLBACK')) {
            return Promise.resolve({});
          } else if (attempt === 1) {
            // First attempt: fail with deadlock
            return Promise.reject(deadlockError);
          } else {
            // Second attempt: succeed
            return Promise.resolve({ rows: [{ id: 1 }] });
          }
        }),
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn(() => Promise.resolve(mockClient)),
      };

      const { getPool } = require('../../shared/db');
      getPool.mockReturnValue(mockPool);

      const result = await transactionWithIsolation(
        async (client) => {
          return await client.query('INSERT INTO test VALUES (1)');
        },
        { maxRetries: 3, retryDelay: 10 }
      );

      // Should have called connect twice (2 attempts)
      expect(mockPool.connect).toHaveBeenCalledTimes(2);
    });
  });
});
