/**
 * REQ-00585: 数据库死锁检测与自动化记录分析系统 - 单元测试
 */

'use strict';

const assert = require('assert');
const { 
  DbDeadlockMonitor, 
  DeadlockAnalyzer, 
  DeadlockRecord,
  PG_ERROR_CODES, 
  DEADLOCK_SEVERITY,
  getDbDeadlockMonitor,
  resetDbDeadlockMonitor
} = require('../dbDeadlockMonitor');

describe('REQ-00585: 数据库死锁检测与自动化记录分析系统', () => {
  
  beforeEach(() => {
    resetDbDeadlockMonitor();
  });

  afterEach(() => {
    resetDbDeadlockMonitor();
  });

  describe('DeadlockRecord', () => {
    it('should create deadlock record with defaults', () => {
      const record = new DeadlockRecord();
      
      assert(record.id.startsWith('DL-'));
      assert(record.timestamp);
      assert.strictEqual(record.code, PG_ERROR_CODES.DEADLOCK_DETECTED);
      assert.strictEqual(record.service, 'unknown');
      assert.strictEqual(record.severity, DEADLOCK_SEVERITY.LOW);
      assert.strictEqual(record.resolved, false);
    });

    it('should create deadlock record with custom data', () => {
      const record = new DeadlockRecord({
        code: '40P01',
        message: 'Deadlock detected',
        detail: 'Process 123 waits for ShareLock',
        service: 'payment-service',
        transactionName: 'create_order',
        traceId: 'abc123',
        sqlQueries: ['SELECT * FROM orders', 'UPDATE orders SET status = $1'],
        involvedProcesses: [123, 456],
        involvedTables: [12345, 67890],
        lockTypes: ['ShareLock', 'ExclusiveLock'],
        retryCount: 2,
        resolved: true
      });

      assert.strictEqual(record.code, '40P01');
      assert.strictEqual(record.service, 'payment-service');
      assert.strictEqual(record.transactionName, 'create_order');
      assert.strictEqual(record.sqlQueries.length, 2);
      assert.strictEqual(record.involvedProcesses.length, 2);
      assert.strictEqual(record.resolved, true);
    });

    it('should serialize to JSON correctly', () => {
      const record = new DeadlockRecord({
        service: 'test-service',
        transactionName: 'test-tx'
      });

      const json = record.toJSON();

      assert(json.id);
      assert(json.timestamp);
      assert(json.datetime);
      assert.strictEqual(json.service, 'test-service');
      assert.strictEqual(json.transaction_name, 'test-tx');
    });
  });

  describe('DeadlockAnalyzer', () => {
    let analyzer;

    beforeEach(() => {
      analyzer = new DeadlockAnalyzer();
    });

    describe('parseDeadlockDetail', () => {
      it('should parse process IDs', () => {
        const detail = 'Process 12345 waits for ShareLock on transaction 1234; blocked by Process 67890.';
        const result = analyzer.parseDeadlockDetail(detail);

        assert.deepStrictEqual(result.processes, [12345, 67890]);
      });

      it('should parse lock types', () => {
        const detail = 'Process 123 waits for ShareLock; Process 456 waits for ExclusiveLock';
        const result = analyzer.parseDeadlockDetail(detail);

        assert.deepStrictEqual(result.lockTypes, ['ShareLock', 'ExclusiveLock']);
      });

      it('should parse relation/table IDs', () => {
        const detail = 'relation 12345 of database 12345';
        const result = analyzer.parseDeadlockDetail(detail);

        assert.deepStrictEqual(result.tables, [12345]);
      });

      it('should handle null detail', () => {
        const result = analyzer.parseDeadlockDetail(null);

        assert.deepStrictEqual(result.processes, []);
        assert.deepStrictEqual(result.tables, []);
        assert.deepStrictEqual(result.lockTypes, []);
      });
    });

    describe('calculateSeverity', () => {
      it('should return CRITICAL for unresolved with max retries', () => {
        const deadlock = new DeadlockRecord({
          resolved: false,
          retryCount: 3
        });

        const severity = analyzer.calculateSeverity(deadlock);
        assert.strictEqual(severity, DEADLOCK_SEVERITY.CRITICAL);
      });

      it('should return HIGH for frequent deadlocks', () => {
        const deadlock = new DeadlockRecord();
        const stats = { recentDeadlocks: 5 };

        const severity = analyzer.calculateSeverity(deadlock, stats);
        assert.strictEqual(severity, DEADLOCK_SEVERITY.HIGH);
      });

      it('should return MEDIUM for moderate frequency', () => {
        const deadlock = new DeadlockRecord();
        const stats = { recentDeadlocks: 3 };

        const severity = analyzer.calculateSeverity(deadlock, stats);
        assert.strictEqual(severity, DEADLOCK_SEVERITY.MEDIUM);
      });

      it('should return MEDIUM for multiple processes/tables', () => {
        const deadlock = new DeadlockRecord({
          involvedProcesses: [1, 2, 3, 4],
          involvedTables: [100, 200, 300]
        });

        const severity = analyzer.calculateSeverity(deadlock);
        assert.strictEqual(severity, DEADLOCK_SEVERITY.MEDIUM);
      });

      it('should return LOW for simple deadlock', () => {
        const deadlock = new DeadlockRecord();

        const severity = analyzer.calculateSeverity(deadlock);
        assert.strictEqual(severity, DEADLOCK_SEVERITY.LOW);
      });
    });

    describe('analyzePatterns', () => {
      it('should analyze deadlock patterns', () => {
        const deadlocks = [
          new DeadlockRecord({
            involvedTables: [100, 200],
            sqlQueries: ['SELECT * FROM users', 'UPDATE users SET name = $1'],
            service: 'gateway',
            retryCount: 1
          }),
          new DeadlockRecord({
            involvedTables: [100, 300],
            sqlQueries: ['SELECT * FROM orders', 'INSERT INTO orders'],
            service: 'gateway',
            retryCount: 2
          }),
          new DeadlockRecord({
            involvedTables: [200, 300],
            sqlQueries: ['DELETE FROM items', 'SELECT * FROM items'],
            service: 'user-service',
            retryCount: 1
          })
        ];

        const patterns = analyzer.analyzePatterns(deadlocks);

        assert.strictEqual(patterns.frequentTables[100], 2);
        assert.strictEqual(patterns.frequentOperations['SELECT'], 3);
        assert.strictEqual(patterns.serviceDistribution['gateway'], 2);
        assert.ok(patterns.avgRetryCount > 0);
      });

      it('should handle empty deadlock list', () => {
        const patterns = analyzer.analyzePatterns([]);

        assert.deepStrictEqual(patterns.frequentTables, {});
        assert.strictEqual(patterns.avgRetryCount, 0);
      });
    });

    describe('generateReport', () => {
      it('should generate markdown report', () => {
        const deadlock = new DeadlockRecord({
          service: 'test-service',
          transactionName: 'test-transaction',
          code: '40P01',
          message: 'Deadlock detected',
          detail: 'Process 123 waits for ShareLock',
          involvedProcesses: [123, 456],
          involvedTables: [100],
          lockTypes: ['ShareLock'],
          sqlQueries: ['SELECT * FROM test'],
          retryCount: 2,
          resolved: true
        });

        const report = analyzer.generateReport(deadlock);

        assert(report.includes('# 死锁分析报告'));
        assert(report.includes('test-service'));
        assert(report.includes('test-transaction'));
        assert(report.includes('40P01'));
        assert(report.includes('ShareLock'));
        assert(report.includes('SELECT * FROM test'));
      });
    });
  });

  describe('DbDeadlockMonitor', () => {
    let monitor;

    beforeEach(() => {
      monitor = new DbDeadlockMonitor({
        enableMetrics: false,
        enableAlerts: false
      });
    });

    afterEach(() => {
      monitor.stop();
    });

    describe('captureDeadlock', () => {
      it('should capture deadlock event', () => {
        const error = new Error('Deadlock detected');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;
        error.detail = 'Process 123 waits for ShareLock on transaction 456';

        const record = monitor.captureDeadlock(error, {
          transactionName: 'test_transaction',
          sqlQueries: ['SELECT * FROM users'],
          retryCount: 1
        });

        assert(record.id);
        assert.strictEqual(record.code, PG_ERROR_CODES.DEADLOCK_DETECTED);
        assert.strictEqual(record.transactionName, 'test_transaction');
        assert.deepStrictEqual(record.involvedProcesses, [123]);
        assert.strictEqual(monitor.stats.totalDetected, 1);
      });

      it('should add to history', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        monitor.captureDeadlock(error);

        assert.strictEqual(monitor.history.length, 1);
      });

      it('should respect max history size', () => {
        const smallMonitor = new DbDeadlockMonitor({
          maxHistorySize: 5,
          enableMetrics: false,
          enableAlerts: false
        });

        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        for (let i = 0; i < 10; i++) {
          smallMonitor.captureDeadlock(error);
        }

        assert.strictEqual(smallMonitor.history.length, 5);
        smallMonitor.stop();
      });
    });

    describe('markResolved', () => {
      it('should mark deadlock as resolved', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        const record = monitor.captureDeadlock(error);
        
        monitor.markResolved(record.id, { retryCount: 2 });

        const updated = monitor.history.find(r => r.id === record.id);
        assert.strictEqual(updated.resolved, true);
        assert.strictEqual(updated.retryCount, 2);
        assert.strictEqual(monitor.stats.totalResolved, 1);
      });
    });

    describe('markFailed', () => {
      it('should mark deadlock as failed', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        const record = monitor.captureDeadlock(error);
        
        monitor.markFailed(record.id);

        assert.strictEqual(monitor.stats.totalFailed, 1);
      });
    });

    describe('getHistory', () => {
      beforeEach(() => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        monitor.captureDeadlock(error, { transactionName: 'tx1' });
        monitor.captureDeadlock(error, { transactionName: 'tx2' });
      });

      it('should return all history', () => {
        const history = monitor.getHistory();
        assert.strictEqual(history.length, 2);
      });

      it('should filter by limit', () => {
        const history = monitor.getHistory({ limit: 1 });
        assert.strictEqual(history.length, 1);
      });
    });

    describe('getStats', () => {
      it('should return statistics', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        monitor.captureDeadlock(error);

        const stats = monitor.getStats();

        assert.strictEqual(stats.totalDetected, 1);
        assert.strictEqual(stats.historySize, 1);
        assert.ok(stats.uptime >= 0);
      });
    });

    describe('getPatterns', () => {
      it('should return pattern analysis', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        monitor.captureDeadlock(error, {
          sqlQueries: ['SELECT * FROM users'],
          service: 'gateway'
        });

        const patterns = monitor.getPatterns();

        assert.ok(patterns.serviceDistribution);
        assert.ok(patterns.frequentOperations);
      });
    });

    describe('queryContextMap', () => {
      it('should record and retrieve query context', () => {
        monitor.recordQueryContext('query-1', {
          sql: 'SELECT * FROM users',
          traceId: 'trace-123'
        });

        const ctx = monitor.queryContextMap.get('query-1');
        assert.strictEqual(ctx.sql, 'SELECT * FROM users');
        assert.strictEqual(ctx.traceId, 'trace-123');
      });

      it('should limit context map size', () => {
        for (let i = 0; i < 15000; i++) {
          monitor.recordQueryContext(`query-${i}`, { sql: 'test' });
        }

        assert.ok(monitor.queryContextMap.size <= 10000);
      });
    });

    describe('activeTransactions', () => {
      it('should track active transactions', () => {
        monitor.recordActiveTransaction('tx-1', { name: 'test' });
        monitor.recordActiveTransaction('tx-2', { name: 'test2' });

        assert.strictEqual(monitor.activeTransactions.size, 2);

        monitor.removeActiveTransaction('tx-1');

        assert.strictEqual(monitor.activeTransactions.size, 1);
      });
    });

    describe('alertHandlers', () => {
      it('should call alert handlers', async () => {
        const alertMonitor = new DbDeadlockMonitor({
          enableMetrics: false,
          enableAlerts: true
        });

        let receivedAlert = null;
        alertMonitor.addAlertHandler((alert) => {
          receivedAlert = alert;
        });

        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        alertMonitor.captureDeadlock(error, { transactionName: 'test' });

        // Allow async alert processing
        await new Promise(resolve => setTimeout(resolve, 10));

        assert(receivedAlert);
        assert.strictEqual(receivedAlert.event, 'db_deadlock_detected');

        alertMonitor.stop();
      });
    });

    describe('generateReport', () => {
      it('should generate summary report', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        monitor.captureDeadlock(error);

        const report = monitor.generateReport();

        assert(report.includes('# 数据库死锁监控报告'));
        assert(report.includes('统计概览'));
      });

      it('should generate specific deadlock report', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        const record = monitor.captureDeadlock(error);

        const report = monitor.generateReport(record.id);

        assert(report.includes('# 死锁分析报告'));
        assert(report.includes(record.id));
      });
    });

    describe('reset', () => {
      it('should reset all state', () => {
        const error = new Error('Deadlock');
        error.code = PG_ERROR_CODES.DEADLOCK_DETECTED;

        monitor.captureDeadlock(error);
        monitor.reset();

        assert.strictEqual(monitor.history.length, 0);
        assert.strictEqual(monitor.stats.totalDetected, 0);
      });
    });
  });

  describe('Singleton', () => {
    it('should return same instance', () => {
      const m1 = getDbDeadlockMonitor();
      const m2 = getDbDeadlockMonitor();

      assert.strictEqual(m1, m2);
    });

    it('should reset singleton', () => {
      const m1 = getDbDeadlockMonitor();
      resetDbDeadlockMonitor();
      const m2 = getDbDeadlockMonitor();

      assert.notStrictEqual(m1, m2);
    });
  });
});
