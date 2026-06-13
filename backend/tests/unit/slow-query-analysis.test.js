/**
 * backend/tests/unit/slow-query-analysis.test.js
 * REQ-00077: 数据库慢查询分析与自动优化建议系统
 * 单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const SlowQueryCollector = require('../../shared/slowQueryCollector');
const QueryPlanAnalyzer = require('../../shared/queryPlanAnalyzer');
const IndexUsageAnalyzer = require('../../shared/indexUsageAnalyzer');
const QueryAnalyzer = require('../../shared/queryAnalyzer');

describe('Slow Query Analysis System', () => {
  
  describe('SlowQueryCollector', () => {
    let collector;
    
    beforeEach(() => {
      collector = new SlowQueryCollector.SlowQueryCollector({ 
        slowThreshold: 1000,
        collectInterval: 60000
      });
    });

    afterEach(() => {
      if (collector && collector.isRunning) {
        collector.stop();
      }
    });

    it('should initialize with correct threshold', () => {
      expect(collector.slowThreshold).to.equal(1000);
      expect(collector.verySlowThreshold).to.equal(5000);
      expect(collector.collectInterval).to.equal(60000);
    });

    it('should not be running initially', () => {
      expect(collector.isRunning).to.be.false;
    });

    it('should return status correctly', () => {
      const status = collector.getStatus();
      expect(status).to.have.property('isRunning');
      expect(status).to.have.property('slowThreshold');
      expect(status).to.have.property('lastCollectionTime');
    });

    it('should stop collection correctly', async () => {
      await collector.stop();
      expect(collector.isRunning).to.be.false;
      expect(collector.collectionTimer).to.be.null;
    });
  });

  describe('QueryPlanAnalyzer', () => {
    let analyzer;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub()
      };
      analyzer = new QueryPlanAnalyzer(mockPool);
    });

    it('should detect sequential scan', () => {
      const plan = { 'Node Type': 'Seq Scan' };
      const scanType = analyzer.detectScanType(plan);
      expect(scanType).to.equal('Sequential Scan');
    });

    it('should detect index scan', () => {
      const plan = { 'Node Type': 'Index Scan' };
      const scanType = analyzer.detectScanType(plan);
      expect(scanType).to.equal('Index Scan');
    });

    it('should detect index only scan', () => {
      const plan = { 'Node Type': 'Index Only Scan' };
      const scanType = analyzer.detectScanType(plan);
      expect(scanType).to.equal('Index Only Scan');
    });

    it('should detect index usage', () => {
      const plan = {
        'Node Type': 'Index Scan',
        'Index Name': 'idx_test'
      };
      const indexUsage = analyzer.detectIndexUsage(plan);
      expect(indexUsage).to.exist;
      expect(indexUsage.indexName).to.equal('idx_test');
    });

    it('should return null when no index is used', () => {
      const plan = {
        'Node Type': 'Seq Scan'
      };
      const indexUsage = analyzer.detectIndexUsage(plan);
      expect(indexUsage).to.be.null;
    });

    it('should detect warnings for sequential scan', () => {
      const plan = {
        'Node Type': 'Seq Scan',
        'Actual Rows': 5000
      };
      const warnings = analyzer.detectWarnings(plan);
      const seqScanWarning = warnings.find(w => w.type === 'seq_scan');
      expect(seqScanWarning).to.exist;
      expect(seqScanWarning.severity).to.equal('high');
    });

    it('should detect high cost warnings', () => {
      const plan = {
        'Total Cost': 5000,
        'Actual Rows': 100
      };
      const warnings = analyzer.detectWarnings(plan);
      const costWarning = warnings.find(w => w.type === 'high_cost');
      expect(costWarning).to.exist;
    });

    it('should detect large result set warnings', () => {
      const plan = {
        'Actual Rows': 50000
      };
      const warnings = analyzer.detectWarnings(plan);
      const resultWarning = warnings.find(w => w.type === 'large_result');
      expect(resultWarning).to.exist;
    });

    it('should detect cache miss warnings', () => {
      const plan = {
        'Shared Read Blocks': 500
      };
      const warnings = analyzer.detectWarnings(plan);
      const cacheWarning = warnings.find(w => w.type === 'cache_miss');
      expect(cacheWarning).to.exist;
    });

    it('should generate suggestions for seq scan', () => {
      const analysis = {
        scanType: 'Sequential Scan',
        actualRows: 1000,
        executionTime: 2000,
        bufferHits: 0,
        bufferReads: 500,
        indexUsed: null,
        totalCost: 2000
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      expect(suggestions).to.have.length.at.least(1);
      expect(suggestions[0].type).to.equal('add_index');
    });

    it('should generate suggestions for high execution time', () => {
      const analysis = {
        scanType: 'Index Scan',
        actualRows: 100,
        executionTime: 5000,
        bufferHits: 800,
        bufferReads: 200,
        indexUsed: { indexName: 'idx_test' },
        totalCost: 500
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      const timeSuggestion = suggestions.find(s => s.type === 'optimize_query');
      expect(timeSuggestion).to.exist;
    });

    it('should generate suggestions for low cache hit rate', () => {
      const analysis = {
        scanType: 'Index Scan',
        actualRows: 100,
        executionTime: 100,
        bufferHits: 200,
        bufferReads: 800,
        indexUsed: { indexName: 'idx_test' },
        totalCost: 500
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      const cacheSuggestion = suggestions.find(s => s.type === 'increase_cache');
      expect(cacheSuggestion).to.exist;
    });

    it('should parse plan correctly', () => {
      const planData = {
        'QUERY PLAN': {
          'Total Cost': 1000,
          'Plan Rows': 500,
          'Actual Rows': 480,
          'Actual Total Time': 50.5,
          'Planning Time': 1.2,
          'Execution Time': 51.7,
          'Node Type': 'Index Scan',
          'Shared Hit Blocks': 1000,
          'Shared Read Blocks': 50
        }
      };
      
      const parsed = analyzer.parsePlan(planData);
      
      expect(parsed.totalCost).to.equal(1000);
      expect(parsed.planRows).to.equal(500);
      expect(parsed.actualRows).to.equal(480);
      expect(parsed.executionTime).to.equal(51.7);
      expect(parsed.scanType).to.equal('Index Scan');
    });
  });

  describe('IndexUsageAnalyzer', () => {
    let analyzer;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub()
      };
      analyzer = new IndexUsageAnalyzer(mockPool);
    });

    it('should get index stats', async () => {
      mockPool.query.resolves({
        rows: [
          { table_name: 'users', index_name: 'idx_users_email', idx_scan: 100, index_size: '128 kB' }
        ]
      });
      
      const stats = await analyzer.getIndexStats();
      expect(stats).to.have.lengthOf(1);
      expect(stats[0].table_name).to.equal('users');
    });

    it('should find unused indexes', async () => {
      const indexStats = [
        { table_name: 'users', index_name: 'idx_unused', idx_scan: 0, index_size: '1 MB' }
      ];
      
      mockPool.query.resolves({
        rows: []
      });
      
      const unused = await analyzer.findUnusedIndexes(indexStats);
      expect(unused).to.have.lengthOf(1);
      expect(unused[0].indexName).to.equal('idx_unused');
    });

    it('should exclude constraint indexes from unused list', async () => {
      const indexStats = [
        { table_name: 'users', index_name: 'users_pkey', idx_scan: 0, index_size: '1 MB' }
      ];
      
      mockPool.query.resolves({
        rows: [
          { index_name: 'users_pkey', table_name: 'users' }
        ]
      });
      
      const unused = await analyzer.findUnusedIndexes(indexStats);
      expect(unused).to.have.lengthOf(0);
    });

    it('should generate proper report', () => {
      const analysis = {
        timestamp: '2026-06-13T17:00:00Z',
        totalIndexes: 10,
        usedIndexes: 8,
        unusedIndexes: 2,
        duplicateIndexes: 1,
        bloatedIndexes: 0,
        details: {
          unusedIndexes: [{ 
            tableName: 'test', 
            indexName: 'idx_unused', 
            indexSize: '1 MB',
            reason: 'Never used'
          }],
          duplicateIndexes: [],
          suggestedIndexes: [],
          indexBloat: []
        }
      };
      
      const report = analyzer.generateReport(analysis);
      expect(report).to.include('Total Indexes: 10');
      expect(report).to.include('Unused Indexes');
    });

    it('should handle analyze errors gracefully', async () => {
      mockPool.query.rejects(new Error('Connection error'));
      
      try {
        await analyzer.analyze();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Connection error');
      }
    });
  });

  describe('QueryAnalyzer', () => {
    let analyzer;

    beforeEach(() => {
      analyzer = new QueryAnalyzer();
    });

    it('should check for missing index', async () => {
      const query = {
        query: 'SELECT * FROM users WHERE email = ?',
        mean_time: 2000
      };
      const explainResult = {
        Plan: {
          'Node Type': 'Seq Scan'
        }
      };
      
      const result = await analyzer.checkMissingIndex(query, explainResult);
      expect(result).to.exist;
      expect(result.issue.type).to.equal('missing_index');
    });

    it('should check for SELECT *', async () => {
      const query = {
        query: 'SELECT * FROM users'
      };
      
      const result = await analyzer.checkSelectStar(query);
      expect(result).to.exist;
      expect(result.issue.type).to.equal('select_star');
    });

    it('should check for missing WHERE clause', async () => {
      const query = {
        query: 'SELECT id, name FROM users'
      };
      
      const result = await analyzer.checkMissingWhereClause(query);
      expect(result).to.exist;
      expect(result.issue.type).to.equal('missing_where_clause');
    });

    it('should check for leading wildcard in LIKE', async () => {
      const query = {
        query: "SELECT * FROM users WHERE name LIKE '%john%'"
      };
      
      const result = await analyzer.checkLikePattern(query);
      expect(result).to.exist;
      expect(result.issue.type).to.equal('leading_wildcard');
    });

    it('should extract columns from WHERE clause', () => {
      const whereClause = "email = 'test@example.com' AND status = 'active' OR name = 'John'";
      const columns = analyzer.extractColumns(whereClause);
      
      expect(columns).to.include('email');
      expect(columns).to.include('status');
      expect(columns).to.include('name');
    });

    it('should generate index SQL', () => {
      const sql = analyzer.generateIndexSQL('users', ['email', 'status']);
      expect(sql).to.include('CREATE INDEX');
      expect(sql).to.include('idx_users_email_status');
      expect(sql).to.include('users (email, status)');
    });

    it('should calculate severity correctly', () => {
      const issues = [
        { severity: 'low' },
        { severity: 'medium' },
        { severity: 'high' }
      ];
      
      const severity = analyzer.calculateSeverity(issues);
      expect(severity).to.equal('high');
    });

    it('should return critical severity if any critical issue', () => {
      const issues = [
        { severity: 'low' },
        { severity: 'critical' },
        { severity: 'high' }
      ];
      
      const severity = analyzer.calculateSeverity(issues);
      expect(severity).to.equal('critical');
    });

    it('should analyze query and return results', async () => {
      const query = {
        queryid: '12345',
        query: 'SELECT * FROM users WHERE email = ?',
        mean_time: 500
      };
      const explainResult = {
        Plan: {
          'Node Type': 'Index Scan',
          'Index Name': 'idx_users_email'
        }
      };
      
      const result = await analyzer.analyze(query, explainResult);
      
      expect(result).to.have.property('queryId');
      expect(result).to.have.property('issues');
      expect(result).to.have.property('suggestions');
      expect(result).to.have.property('severity');
    });
  });

  describe('Integration Tests', () => {
    
    it('should create SlowQueryCollector instance', () => {
      const collector = new SlowQueryCollector.SlowQueryCollector({
        slowThreshold: 500
      });
      expect(collector.slowThreshold).to.equal(500);
    });

    it('should analyze a complete query flow', async () => {
      const mockPool = {
        query: sinon.stub()
      };

      // Mock EXPLAIN result
      mockPool.query.resolves({
        rows: [{
          'QUERY PLAN': {
            'Total Cost': 5000,
            'Plan Rows': 10000,
            'Actual Rows': 9500,
            'Actual Total Time': 150,
            'Execution Time': 152,
            'Node Type': 'Seq Scan',
            'Shared Hit Blocks': 100,
            'Shared Read Blocks': 500
          }
        }]
      });

      const planAnalyzer = new QueryPlanAnalyzer(mockPool);
      const analysis = await planAnalyzer.analyze('SELECT * FROM large_table');
      
      expect(analysis).to.exist;
      expect(analysis.analysis.scanType).to.equal('Sequential Scan');
      expect(analysis.analysis.warnings).to.have.length.at.least(1);
      expect(analysis.suggestions).to.have.length.at.least(1);
    });
  });
});
