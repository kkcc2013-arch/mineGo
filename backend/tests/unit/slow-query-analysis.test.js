/**
 * backend/tests/unit/slow-query-analysis.test.js
 * REQ-00063: 数据库慢查询分析与自动优化建议系统
 * 单元测试
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const QueryAnalyzer = require('../../shared/queryAnalyzer');

describe('Slow Query Analysis System', () => {
  describe('QueryAnalyzer', () => {
    let analyzer;

    beforeEach(() => {
      analyzer = new QueryAnalyzer();
    });

    describe('analyze()', () => {
      it('should detect missing index on sequential scan', async () => {
        const query = {
          queryid: 'test-001',
          query: 'SELECT * FROM users WHERE email = ?',
          mean_time: 800
        };
        
        const explainResult = [
          { 'Plan': { 'Node Type': 'Seq Scan' } }
        ];
        
        const result = await analyzer.analyze(query, explainResult);
        
        assert.ok(result);
        assert.strictEqual(result.queryId, 'test-001');
        assert.ok(result.issues.some(i => i.type === 'missing_index'));
      });

      it('should detect SELECT * usage', async () => {
        const query = {
          queryid: 'test-002',
          query: 'SELECT * FROM pokemon WHERE id = ?',
          mean_time: 100
        };
        
        const explainResult = [{}];
        
        const result = await analyzer.analyze(query, explainResult);
        
        assert.ok(result);
        assert.ok(result.issues.some(i => i.type === 'select_star'));
      });

      it('should detect missing WHERE clause', async () => {
        const query = {
          queryid: 'test-003',
          query: 'SELECT id, name FROM pokemon',
          mean_time: 100
        };
        
        const explainResult = [{}];
        
        const result = await analyzer.analyze(query, explainResult);
        
        assert.ok(result);
        assert.ok(result.issues.some(i => i.type === 'missing_where_clause'));
      });

      it('should detect OR conditions', async () => {
        const query = {
          queryid: 'test-004',
          query: 'SELECT * FROM users WHERE status = ? OR role = ? OR type = ?',
          mean_time: 800
        };
        
        const explainResult = [{}];
        
        const result = await analyzer.analyze(query, explainResult);
        
        assert.ok(result);
        assert.ok(result.issues.some(i => i.type === 'or_condition'));
      });

      it('should detect LIKE with leading wildcard', async () => {
        const query = {
          queryid: 'test-005',
          query: "SELECT * FROM pokemon WHERE name LIKE '%char%'",
          mean_time: 500
        };
        
        const explainResult = [{}];
        
        const result = await analyzer.analyze(query, explainResult);
        
        assert.ok(result);
        assert.ok(result.issues.some(i => i.type === 'leading_wildcard'));
      });

      it('should calculate correct severity', async () => {
        const query = {
          queryid: 'test-006',
          query: 'SELECT * FROM large_table',
          mean_time: 5000
        };
        
        const explainResult = [
          { 'Plan': { 'Node Type': 'Seq Scan' } }
        ];
        
        const result = await analyzer.analyze(query, explainResult);
        
        assert.ok(result);
        assert.ok(['critical', 'high'].includes(result.severity));
      });

      it('should generate index suggestion', async () => {
        const query = {
          queryid: 'test-007',
          query: 'SELECT * FROM users WHERE email = ? AND status = ?',
          mean_time: 1000
        };
        
        const explainResult = [
          { 'Plan': { 'Node Type': 'Seq Scan' } }
        ];
        
        const result = await analyzer.analyze(query, explainResult);
        
        assert.ok(result);
        const indexSuggestion = result.suggestions.find(s => s.type === 'create_index');
        assert.ok(indexSuggestion);
        assert.ok(indexSuggestion.sql.includes('CREATE INDEX'));
      });
    });

    describe('extractColumns()', () => {
      it('should extract columns from WHERE clause', () => {
        const whereClause = 'email = ? AND status = ? AND role = ?';
        const columns = analyzer.extractColumns(whereClause);
        
        assert.deepStrictEqual(columns, ['email', 'status', 'role']);
      });

      it('should handle complex conditions', () => {
        const whereClause = 'created_at > ? AND (status = ? OR type LIKE ?)';
        const columns = analyzer.extractColumns(whereClause);
        
        assert.ok(columns.includes('created_at'));
        assert.ok(columns.includes('status'));
      });

      it('should return empty array for no columns', () => {
        const whereClause = '';
        const columns = analyzer.extractColumns(whereClause);
        
        assert.deepStrictEqual(columns, []);
      });
    });

    describe('generateIndexSQL()', () => {
      it('should generate valid index SQL', () => {
        const sql = analyzer.generateIndexSQL('users', ['email', 'status']);
        
        assert.ok(sql.includes('CREATE INDEX'));
        assert.ok(sql.includes('idx_users_email_status'));
        assert.ok(sql.includes('ON users'));
        assert.ok(sql.includes('(email, status)'));
      });

      it('should handle empty columns', () => {
        const sql = analyzer.generateIndexSQL('users', []);
        
        assert.ok(sql.includes('Cannot generate index'));
      });
    });

    describe('calculateSeverity()', () => {
      it('should return critical for critical issues', () => {
        const issues = [{ severity: 'critical' }];
        const severity = analyzer.calculateSeverity(issues);
        
        assert.strictEqual(severity, 'critical');
      });

      it('should return high for high issues', () => {
        const issues = [{ severity: 'high' }, { severity: 'medium' }];
        const severity = analyzer.calculateSeverity(issues);
        
        assert.strictEqual(severity, 'high');
      });

      it('should return medium for medium issues', () => {
        const issues = [{ severity: 'medium' }, { severity: 'low' }];
        const severity = analyzer.calculateSeverity(issues);
        
        assert.strictEqual(severity, 'medium');
      });

      it('should return low for low issues', () => {
        const issues = [{ severity: 'low' }];
        const severity = analyzer.calculateSeverity(issues);
        
        assert.strictEqual(severity, 'low');
      });
    });

    describe('checkSubquery()', () => {
      it('should detect nested subqueries', async () => {
        const query = {
          query: 'SELECT * FROM (SELECT * FROM (SELECT * FROM users) AS t1) AS t2',
          mean_time: 1500
        };
        
        const result = await analyzer.checkSubquery(query);
        
        assert.ok(result);
        assert.strictEqual(result.issue.type, 'subquery');
        assert.strictEqual(result.issue.subqueryCount, 2);
      });

      it('should not flag simple subqueries', async () => {
        const query = {
          query: 'SELECT * FROM (SELECT id FROM users) AS t',
          mean_time: 100
        };
        
        const result = await analyzer.checkSubquery(query);
        
        assert.strictEqual(result, null);
      });
    });

    describe('checkDistinct()', () => {
      it('should detect DISTINCT overhead', async () => {
        const query = {
          query: 'SELECT DISTINCT name FROM large_table',
          mean_time: 800
        };
        
        const result = await analyzer.checkDistinct(query);
        
        assert.ok(result);
        assert.strictEqual(result.issue.type, 'distinct_overhead');
      });

      it('should not flag fast DISTINCT', async () => {
        const query = {
          query: 'SELECT DISTINCT id FROM small_table',
          mean_time: 50
        };
        
        const result = await analyzer.checkDistinct(query);
        
        assert.strictEqual(result, null);
      });
    });
  });

  describe('SlowQueryCollector', () => {
    it('should initialize with correct config', () => {
      const { SlowQueryCollector } = require('../../shared/slowQueryCollector');
      
      const collector = new SlowQueryCollector({
        slowThreshold: 500,
        verySlowThreshold: 2000,
        collectInterval: 30000
      });
      
      assert.strictEqual(collector.slowThreshold, 500);
      assert.strictEqual(collector.verySlowThreshold, 2000);
      assert.strictEqual(collector.collectInterval, 30000);
      assert.strictEqual(collector.isRunning, false);
    });

    it('should return status correctly', () => {
      const { SlowQueryCollector } = require('../../shared/slowQueryCollector');
      
      const collector = new SlowQueryCollector({
        slowThreshold: 1000
      });
      
      const status = collector.getStatus();
      
      assert.ok(status);
      assert.strictEqual(status.isRunning, false);
      assert.strictEqual(status.slowThreshold, 1000);
    });
  });

  describe('OptimizationAdvisor', () => {
    let advisor;

    beforeEach(() => {
      const OptimizationAdvisor = require('../../shared/optimizationAdvisor');
      advisor = new OptimizationAdvisor({
        dbConfig: 'postgresql://test:test@localhost:5432/test'
      });
    });

    describe('extractIndexColumns()', () => {
      it('should extract columns from index definition', () => {
        const indexDef = 'CREATE INDEX idx_test ON users (email, status)';
        const columns = advisor.extractIndexColumns(indexDef);
        
        assert.deepStrictEqual(columns, ['email', 'status']);
      });

      it('should handle single column', () => {
        const indexDef = 'CREATE INDEX idx_email ON users (email)';
        const columns = advisor.extractIndexColumns(indexDef);
        
        assert.deepStrictEqual(columns, ['email']);
      });
    });

    describe('isOverlappingIndex()', () => {
      it('should detect overlapping index', () => {
        const newColumns = ['email'];
        const existingColumns = ['email', 'status'];
        
        const result = advisor.isOverlappingIndex(newColumns, existingColumns);
        
        assert.strictEqual(result, true);
      });

      it('should not detect non-overlapping index', () => {
        const newColumns = ['status', 'created_at'];
        const existingColumns = ['email', 'status'];
        
        const result = advisor.isOverlappingIndex(newColumns, existingColumns);
        
        assert.strictEqual(result, false);
      });

      it('should detect exact match', () => {
        const newColumns = ['email', 'status'];
        const existingColumns = ['email', 'status'];
        
        const result = advisor.isOverlappingIndex(newColumns, existingColumns);
        
        assert.strictEqual(result, true);
      });
    });
  });
});

describe('Integration Tests', () => {
  it('should analyze end-to-end query flow', async () => {
    const analyzer = new QueryAnalyzer();
    
    const slowQuery = {
      queryid: 'integration-test',
      query: 'SELECT * FROM users WHERE status = ?',
      mean_time: 2000
    };
    
    const explainResult = [
      { 'Plan': { 'Node Type': 'Seq Scan' } }
    ];
    
    const result = await analyzer.analyze(slowQuery, explainResult);
    
    assert.ok(result);
    assert.ok(result.queryId);
    assert.ok(Array.isArray(result.issues));
    assert.ok(Array.isArray(result.suggestions));
    assert.ok(result.severity);
    assert.ok(result.analyzedAt);
    
    // 验证问题类型
    assert.ok(result.issues.some(i => i.type === 'select_star' || i.type === 'missing_index'));
    
    // 验证建议
    if (result.suggestions.length > 0) {
      assert.ok(result.suggestions[0].type);
      assert.ok(result.suggestions[0].reason);
      assert.ok(result.suggestions[0].estimatedImprovement);
    }
  });
});