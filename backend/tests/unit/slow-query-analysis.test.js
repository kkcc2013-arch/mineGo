/**
 * backend/tests/unit/slow-query-analysis.test.js
 * REQ-00063: 数据库慢查询分析与自动优化建议系统
 * 单元测试
 */

'use strict';

const assert = require('assert');
const QueryAnalyzer = require('../../shared/queryAnalyzer');
const { SlowQueryCollector } = require('../../shared/slowQueryCollector');

// Mock 数据库客户端
class MockClient {
  constructor() {
    this.queries = [];
    this.connected = false;
  }
  
  async connect() {
    this.connected = true;
  }
  
  async end() {
    this.connected = false;
  }
  
  async query(sql, params) {
    this.queries.push({ sql, params });
    
    // 模拟 pg_stat_statements 响应
    if (sql.includes('pg_stat_statements')) {
      return {
        rows: [
          {
            queryid: 'test-query-1',
            query: 'SELECT * FROM users WHERE email = $1',
            calls: 100,
            total_exec_time: 5000,
            mean_exec_time: 50,
            min_exec_time: 40,
            max_exec_time: 100,
            rows: 100,
            shared_blks_hit: 900,
            shared_blks_read: 100
          },
          {
            queryid: 'test-query-2',
            query: 'SELECT * FROM pokemon ORDER BY created_at',
            calls: 50,
            total_exec_time: 10000,
            mean_exec_time: 200,
            min_exec_time: 150,
            max_exec_time: 300,
            rows: 50000,
            shared_blks_hit: 40000,
            shared_blks_read: 10000
          }
        ]
      };
    }
    
    // 模拟插入响应
    if (sql.includes('INSERT INTO slow_query_log')) {
      return { rows: [] };
    }
    
    return { rows: [] };
  }
}

// 测试 QueryAnalyzer
describe('QueryAnalyzer', () => {
  let analyzer;
  
  beforeEach(() => {
    analyzer = new QueryAnalyzer();
  });
  
  describe('#checkMissingIndex', () => {
    it('should detect missing index on sequential scan', async () => {
      const query = {
        query: 'SELECT * FROM users WHERE email = $1',
        mean_time: 600
      };
      const explainResult = {
        'Plan': {
          'Node Type': 'Seq Scan',
          'Relation Name': 'users'
        }
      };
      
      const result = await analyzer.checkMissingIndex(query, explainResult);
      
      assert.ok(result);
      assert.strictEqual(result.issue.type, 'missing_index');
      assert.strictEqual(result.issue.severity, 'high');
      assert.ok(result.suggestion.sql.includes('CREATE INDEX'));
    });
    
    it('should not flag fast queries', async () => {
      const query = {
        query: 'SELECT * FROM users WHERE email = $1',
        mean_time: 100
      };
      const explainResult = {
        'Plan': {
          'Node Type': 'Seq Scan',
          'Relation Name': 'users'
        }
      };
      
      const result = await analyzer.checkMissingIndex(query, explainResult);
      
      assert.strictEqual(result, null);
    });
  });
  
  describe('#checkFullTableScan', () => {
    it('should detect full table scan on large tables', async () => {
      const query = {
        rows: 50000
      };
      const explainResult = {
        'Plan': {
          'Node Type': 'Seq Scan'
        }
      };
      
      const result = await analyzer.checkFullTableScan(query, explainResult);
      
      assert.ok(result);
      assert.strictEqual(result.issue.type, 'full_table_scan');
      assert.strictEqual(result.issue.severity, 'critical');
    });
    
    it('should not flag small table scans', async () => {
      const query = {
        rows: 100
      };
      const explainResult = {
        'Plan': {
          'Node Type': 'Seq Scan'
        }
      };
      
      const result = await analyzer.checkFullTableScan(query, explainResult);
      
      assert.strictEqual(result, null);
    });
  });
  
  describe('#checkSelectStar', () => {
    it('should detect SELECT * usage', async () => {
      const query = {
        query: 'SELECT * FROM users WHERE id = 1'
      };
      
      const result = await analyzer.checkSelectStar(query, {});
      
      assert.ok(result);
      assert.strictEqual(result.issue.type, 'select_star');
      assert.strictEqual(result.issue.severity, 'medium');
    });
    
    it('should not flag explicit column selection', async () => {
      const query = {
        query: 'SELECT id, name FROM users'
      };
      
      const result = await analyzer.checkSelectStar(query, {});
      
      assert.strictEqual(result, null);
    });
  });
  
  describe('#checkMissingWhereClause', () => {
    it('should detect missing WHERE clause', async () => {
      const query = {
        query: 'SELECT * FROM users'
      };
      
      const result = await analyzer.checkMissingWhereClause(query, {});
      
      assert.ok(result);
      assert.strictEqual(result.issue.type, 'missing_where_clause');
      assert.strictEqual(result.issue.severity, 'high');
    });
    
    it('should not flag queries with WHERE', async () => {
      const query = {
        query: 'SELECT * FROM users WHERE id = 1'
      };
      
      const result = await analyzer.checkMissingWhereClause(query, {});
      
      assert.strictEqual(result, null);
    });
  });
  
  describe('#checkLikePattern', () => {
    it('should detect leading wildcard in LIKE', async () => {
      const query = {
        query: "SELECT * FROM users WHERE name LIKE '%john%'"
      };
      
      const result = await analyzer.checkLikePattern(query, {});
      
      assert.ok(result);
      assert.strictEqual(result.issue.type, 'leading_wildcard');
    });
    
    it('should not flag trailing wildcard', async () => {
      const query = {
        query: "SELECT * FROM users WHERE name LIKE 'john%'"
      };
      
      const result = await analyzer.checkLikePattern(query, {});
      
      assert.strictEqual(result, null);
    });
  });
  
  describe('#extractColumns', () => {
    it('should extract columns from WHERE clause', () => {
      const whereClause = "email = $1 AND status = 'active' AND created_at > '2024-01-01'";
      const columns = analyzer.extractColumns(whereClause);
      
      assert.ok(columns.includes('email'));
      assert.ok(columns.includes('status'));
      assert.ok(columns.includes('created_at'));
    });
  });
  
  describe('#calculateSeverity', () => {
    it('should return critical for critical issues', () => {
      const issues = [
        { severity: 'high' },
        { severity: 'critical' },
        { severity: 'medium' }
      ];
      
      const severity = analyzer.calculateSeverity(issues);
      assert.strictEqual(severity, 'critical');
    });
    
    it('should return high when no critical issues', () => {
      const issues = [
        { severity: 'medium' },
        { severity: 'high' }
      ];
      
      const severity = analyzer.calculateSeverity(issues);
      assert.strictEqual(severity, 'high');
    });
    
    it('should return low for no issues', () => {
      const issues = [];
      
      const severity = analyzer.calculateSeverity(issues);
      assert.strictEqual(severity, 'low');
    });
  });
  
  describe('#analyze', () => {
    it('should return comprehensive analysis', async () => {
      const query = {
        queryid: 'test-123',
        query: 'SELECT * FROM users WHERE email = $1',
        mean_time: 800
      };
      const explainResult = {
        'Plan': {
          'Node Type': 'Seq Scan',
          'Relation Name': 'users'
        }
      };
      
      const result = await analyzer.analyze(query, explainResult);
      
      assert.ok(result);
      assert.strictEqual(result.queryId, 'test-123');
      assert.ok(Array.isArray(result.issues));
      assert.ok(Array.isArray(result.suggestions));
      assert.ok(result.severity);
    });
  });
});

// 测试 SlowQueryCollector
describe('SlowQueryCollector', () => {
  let collector;
  let mockClient;
  
  beforeEach(() => {
    mockClient = new MockClient();
    collector = new SlowQueryCollector({
      dbConfig: {},
      slowThreshold: 1000,
      collectInterval: 60000
    });
    
    // Mock pg Client
    const originalClient = require('pg').Client;
    require('pg').Client = function() { return mockClient; };
  });
  
  afterEach(() => {
    if (collector && collector.isRunning) {
      collector.stop();
    }
  });
  
  describe('#constructor', () => {
    it('should initialize with default values', () => {
      const c = new SlowQueryCollector();
      
      assert.strictEqual(c.slowThreshold, 1000);
      assert.strictEqual(c.verySlowThreshold, 5000);
      assert.strictEqual(c.collectInterval, 60000);
      assert.strictEqual(c.isRunning, false);
    });
    
    it('should accept custom config', () => {
      const c = new SlowQueryCollector({
        slowThreshold: 500,
        verySlowThreshold: 2000,
        collectInterval: 30000
      });
      
      assert.strictEqual(c.slowThreshold, 500);
      assert.strictEqual(c.verySlowThreshold, 2000);
      assert.strictEqual(c.collectInterval, 30000);
    });
  });
  
  describe('#getStatus', () => {
    it('should return current status', () => {
      const status = collector.getStatus();
      
      assert.ok('isRunning' in status);
      assert.ok('slowThreshold' in status);
      assert.ok('verySlowThreshold' in status);
      assert.ok('collectInterval' in status);
    });
  });
  
  describe('#recordQueryMetrics', () => {
    it('should record metrics without error', () => {
      const query = {
        queryid: 'test-123',
        mean_time: 1500,
        rows: 100,
        shared_blks_hit: 900,
        shared_blks_read: 100
      };
      
      // Should not throw
      assert.doesNotThrow(() => {
        collector.recordQueryMetrics(query);
      });
    });
  });
});

// 测试集成场景
describe('Integration Tests', () => {
  describe('End-to-end analysis flow', () => {
    it('should analyze query and generate recommendations', async () => {
      const analyzer = new QueryAnalyzer();
      
      const slowQuery = {
        queryid: 'integration-test-1',
        query: 'SELECT * FROM pokemon WHERE trainer_id = 123 ORDER BY created_at DESC',
        mean_time: 1500,
        rows: 50000
      };
      
      const explainResult = {
        'Plan': {
          'Node Type': 'Seq Scan',
          'Relation Name': 'pokemon'
        }
      };
      
      const analysis = await analyzer.analyze(slowQuery, explainResult);
      
      assert.ok(analysis.issues.length > 0, 'Should detect issues');
      assert.ok(analysis.suggestions.length > 0, 'Should generate suggestions');
    });
  });
});

// 运行测试
if (require.main === module) {
  console.log('Running slow query analysis tests...\n');
  
  // 手动运行测试
  const mocha = require('mocha');
  new mocha().addFile(__filename).run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}

module.exports = {
  MockClient
};
