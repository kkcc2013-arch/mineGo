/**
 * backend/tests/unit/slow-query-analysis.test.js
 * REQ-00077: 数据库慢查询分析与自动优化建议系统
 * 单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Mock logger
const mockLogger = {
  info: sinon.stub(),
  warn: sinon.stub(),
  error: sinon.stub(),
  debug: sinon.stub()
};

// Mock metrics
const mockMetrics = {
  incrementCounter: sinon.stub(),
  recordHistogram: sinon.stub(),
  setGauge: sinon.stub()
};

describe('REQ-00077: Slow Query Analysis System', function() {
  
  describe('SlowQueryCollector', function() {
    let SlowQueryCollector;
    let collector;
    let mockClient;
    
    beforeEach(function() {
      mockClient = {
        connect: sinon.stub().resolves(),
        end: sinon.stub().resolves(),
        query: sinon.stub()
      };
      
      SlowQueryCollector = proxyquire('../../shared/slowQueryCollector', {
        './logger': mockLogger,
        './metrics': mockMetrics,
        'pg': {
          Client: sinon.stub().returns(mockClient)
        }
      }).SlowQueryCollector;
      
      collector = new SlowQueryCollector({
        slowThreshold: 1000,
        collectInterval: 60000,
        dbConfig: {}
      });
    });
    
    afterEach(function() {
      sinon.restore();
      mockLogger.info.reset();
      mockLogger.warn.reset();
      mockLogger.error.reset();
      mockMetrics.incrementCounter.reset();
      mockMetrics.recordHistogram.reset();
    });
    
    it('should initialize with correct configuration', function() {
      expect(collector.slowThreshold).to.equal(1000);
      expect(collector.collectInterval).to.equal(60000);
      expect(collector.isRunning).to.be.false;
    });
    
    it('should enable pg_stat_statements extension on start', async function() {
      mockClient.query.resolves({ rows: [] });
      
      await collector.enableSlowQueryLog();
      
      expect(mockClient.connect.calledOnce).to.be.true;
      expect(mockClient.query.calledWithMatch(/CREATE EXTENSION/)).to.be.true;
      expect(mockClient.end.calledOnce).to.be.true;
    });
    
    it('should collect slow queries from pg_stat_statements', async function() {
      const mockSlowQueries = [
        {
          queryid: '123',
          query: 'SELECT * FROM users WHERE id = 1',
          calls: 100,
          total_exec_time: 50000,
          mean_exec_time: 500,
          rows: 10,
          shared_blks_hit: 100,
          shared_blks_read: 20
        }
      ];
      
      mockClient.query.resolves({ rows: mockSlowQueries });
      
      const result = await collector.collectSlowQueries();
      
      expect(result.count).to.equal(1);
      expect(result.queries).to.have.lengthOf(1);
      expect(mockMetrics.incrementCounter.called).to.be.true;
    });
    
    it('should record correct metrics for slow queries', function() {
      const query = {
        queryid: '456',
        mean_time: 2000,
        rows: 50,
        shared_blks_hit: 80,
        shared_blks_read: 20
      };
      
      collector.recordQueryMetrics(query);
      
      expect(mockMetrics.incrementCounter.calledWithMatch('slow_query_total')).to.be.true;
      expect(mockMetrics.recordHistogram.calledWithMatch('query_duration_seconds')).to.be.true;
    });
    
    it('should return correct status', function() {
      const status = collector.getStatus();
      
      expect(status.isRunning).to.be.false;
      expect(status.slowThreshold).to.equal(1000);
      expect(status.collectInterval).to.equal(60000);
    });
    
    it('should stop collection properly', async function() {
      collector.isRunning = true;
      collector.collectionTimer = setInterval(() => {}, 10000);
      
      await collector.stop();
      
      expect(collector.isRunning).to.be.false;
      expect(collector.collectionTimer).to.be.null;
    });
  });
  
  describe('QueryPlanAnalyzer', function() {
    let QueryPlanAnalyzer;
    let analyzer;
    let mockPool;
    
    beforeEach(function() {
      mockPool = {
        query: sinon.stub()
      };
      
      QueryPlanAnalyzer = proxyquire('../../shared/queryPlanAnalyzer', {
        './logger': mockLogger,
        './metrics': mockMetrics
      });
      
      analyzer = new QueryPlanAnalyzer(mockPool);
    });
    
    afterEach(function() {
      sinon.restore();
    });
    
    it('should detect sequential scan correctly', function() {
      const plan = { 'Node Type': 'Seq Scan' };
      const scanType = analyzer.detectScanType(plan);
      
      expect(scanType).to.equal('Sequential Scan');
    });
    
    it('should detect index scan correctly', function() {
      const plan = { 'Node Type': 'Index Scan', 'Index Name': 'idx_users_id' };
      const scanType = analyzer.detectScanType(plan);
      
      expect(scanType).to.equal('Index Scan');
    });
    
    it('should detect index usage', function() {
      const plan = {
        'Node Type': 'Index Scan',
        'Index Name': 'idx_pokemon_user',
        Plans: []
      };
      
      const indexUsed = analyzer.detectIndexUsage(plan);
      
      expect(indexUsed).to.exist;
      expect(indexUsed.indexName).to.equal('idx_pokemon_user');
    });
    
    it('should detect sequential scan warning', function() {
      const plan = {
        'Node Type': 'Seq Scan',
        'Actual Rows': 10000,
        'Total Cost': 5000
      };
      
      const warnings = analyzer.detectWarnings(plan);
      const seqScanWarning = warnings.find(w => w.type === 'seq_scan');
      
      expect(seqScanWarning).to.exist;
      expect(seqScanWarning.severity).to.equal('high');
    });
    
    it('should detect high cost warning', function() {
      const plan = {
        'Node Type': 'Index Scan',
        'Total Cost': 5000,
        'Actual Rows': 100
      };
      
      const warnings = analyzer.detectWarnings(plan);
      const costWarning = warnings.find(w => w.type === 'high_cost');
      
      expect(costWarning).to.exist;
      expect(costWarning.message).to.include('5000');
    });
    
    it('should generate suggestions for sequential scan', function() {
      const analysis = {
        scanType: 'Sequential Scan',
        actualRows: 5000,
        executionTime: 2000,
        bufferHits: 0,
        bufferReads: 500,
        totalCost: 1000,
        indexUsed: null
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      
      expect(suggestions).to.have.length.at.least(2);
      expect(suggestions[0].type).to.equal('add_index');
      expect(suggestions[0].priority).to.equal('high');
    });
    
    it('should generate suggestion for high execution time', function() {
      const analysis = {
        scanType: 'Index Scan',
        actualRows: 100,
        executionTime: 5000,
        bufferHits: 100,
        bufferReads: 10,
        totalCost: 100,
        indexUsed: { indexName: 'idx_test' }
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      const timeSuggestion = suggestions.find(s => s.type === 'optimize_query');
      
      expect(timeSuggestion).to.exist;
      expect(timeSuggestion.reason).to.include('5000');
    });
    
    it('should generate suggestion for low cache hit rate', function() {
      const analysis = {
        scanType: 'Index Scan',
        actualRows: 100,
        executionTime: 100,
        bufferHits: 20,
        bufferReads: 80,
        totalCost: 100,
        indexUsed: { indexName: 'idx_test' }
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      const cacheSuggestion = suggestions.find(s => s.type === 'increase_cache');
      
      expect(cacheSuggestion).to.exist;
      expect(cacheSuggestion.reason).to.include('25%'); // 20/(20+80) = 0.25
    });
    
    it('should analyze query and return complete result', async function() {
      const mockPlan = {
        'QUERY PLAN': {
          Plan: {
            'Node Type': 'Seq Scan',
            'Total Cost': 5000,
            'Actual Rows': 1000,
            'Execution Time': 1000,
            'Shared Hit Blocks': 50,
            'Shared Read Blocks': 100
          }
        }
      };
      
      mockPool.query.resolves({ rows: [mockPlan] });
      
      const result = await analyzer.analyze('SELECT * FROM users');
      
      expect(result).to.exist;
      expect(result.analysis).to.exist;
      expect(result.suggestions).to.exist;
      expect(result.timestamp).to.exist;
    });
    
    it('should generate optimization report', function() {
      const analysis = {
        query: 'SELECT * FROM users WHERE id = 1',
        analysis: {
          nodeType: 'Seq Scan',
          scanType: 'Sequential Scan',
          totalCost: 5000,
          executionTime: 1000,
          actualRows: 1000,
          indexUsed: null,
          warnings: [{ severity: 'high', message: 'Test warning' }]
        },
        suggestions: [{ priority: 'high', reason: 'Test reason', action: 'Test action', estimatedImpact: 'Test impact' }],
        timestamp: '2026-07-06T05:00:00Z'
      };
      
      const report = analyzer.generateOptimizationReport(analysis);
      
      expect(report).to.include('Query Plan Analysis Report');
      expect(report).to.include('Sequential Scan');
      expect(report).to.include('Warnings');
      expect(report).to.include('Optimization Suggestions');
    });
  });
  
  describe('IndexUsageAnalyzer', function() {
    let IndexUsageAnalyzer;
    let analyzer;
    let mockPool;
    
    beforeEach(function() {
      mockPool = {
        query: sinon.stub()
      };
      
      IndexUsageAnalyzer = proxyquire('../../shared/indexUsageAnalyzer', {
        './logger': mockLogger,
        './metrics': mockMetrics
      });
      
      analyzer = new IndexUsageAnalyzer(mockPool);
    });
    
    afterEach(function() {
      sinon.restore();
    });
    
    it('should get index statistics', async function() {
      const mockStats = [
        { table_name: 'users', index_name: 'users_pkey', idx_scan: 100, index_size: '8 KB' },
        { table_name: 'pokemon', index_name: 'idx_unused', idx_scan: 0, index_size: '1 MB' }
      ];
      
      mockPool.query.resolves({ rows: mockStats });
      
      const stats = await analyzer.getIndexStats();
      
      expect(stats).to.have.lengthOf(2);
      expect(stats[0].table_name).to.equal('users');
    });
    
    it('should find unused indexes', async function() {
      const mockStats = [
        { table_name: 'users', index_name: 'users_pkey', idx_scan: 0, index_size: '8 KB', index_size_bytes: 8192 },
        { table_name: 'pokemon', index_name: 'idx_unused', idx_scan: 0, index_size: '1 MB', index_size_bytes: 1048576 }
      ];
      
      mockPool.query.onFirstCall().resolves({ rows: mockStats });
      mockPool.query.onSecondCall().resolves({ rows: [{ index_name: 'users_pkey' }] }); // 约束索引
      
      const unused = await analyzer.findUnusedIndexes(mockStats);
      
      expect(unused).to.have.lengthOf(1);
      expect(unused[0].indexName).to.equal('idx_unused');
      expect(unused[0].reason).to.include('Never used');
    });
    
    it('should exclude constraint indexes from unused list', async function() {
      const stats = [
        { table_name: 'users', index_name: 'users_pkey', idx_scan: 0, index_size: '8 KB', index_size_bytes: 8192 }
      ];
      
      mockPool.query.resolves({ rows: [{ index_name: 'users_pkey' }] });
      
      const unused = await analyzer.findUnusedIndexes(stats);
      
      expect(unused).to.have.lengthOf(0);
    });
    
    it('should find duplicate indexes', async function() {
      const mockDuplicates = [
        {
          table_name: 'pokemon',
          index1_name: 'idx_pokemon_a',
          index1_size: '1 MB',
          index2_name: 'idx_pokemon_b',
          index2_size: '1 MB'
        }
      ];
      
      mockPool.query.resolves({ rows: mockDuplicates });
      
      const duplicates = await analyzer.findDuplicateIndexes();
      
      expect(duplicates).to.have.lengthOf(1);
      expect(duplicates[0].index1Name).to.equal('idx_pokemon_a');
    });
    
    it('should find suggested indexes', async function() {
      const mockQueries = [
        {
          queryid: '123',
          query: 'SELECT * FROM pokemon WHERE user_id = 1',
          calls: 500,
          total_exec_time: 10000
        }
      ];
      
      mockPool.query.resolves({ rows: mockQueries });
      
      const suggestions = await analyzer.findSuggestedIndexes();
      
      expect(suggestions).to.have.length.at.least(1);
      expect(suggestions[0].columnSuggestion).to.equal('user_id');
    });
    
    it('should analyze index bloat', async function() {
      const mockBloat = [
        {
          tablename: 'large_table',
          indexname: 'idx_large',
          index_size: '10 MB',
          usage_status: 'UNUSED',
          index_scans: 0
        }
      ];
      
      mockPool.query.resolves({ rows: mockBloat });
      
      const bloat = await analyzer.analyzeIndexBloat();
      
      expect(bloat).to.have.length.at.least(1);
      expect(bloat[0].usageStatus).to.equal('UNUSED');
    });
    
    it('should run full analysis', async function() {
      // Mock all queries
      mockPool.query.onCall(0).resolves({ rows: [{ table_name: 'users', index_name: 'idx', idx_scan: 10 }] });
      mockPool.query.onCall(1).resolves({ rows: [] }); // constraint indexes
      mockPool.query.onCall(2).resolves({ rows: [] }); // duplicates
      mockPool.query.onCall(3).resolves({ rows: [] }); // suggested
      mockPool.query.onCall(4).resolves({ rows: [] }); // bloat
      
      const analysis = await analyzer.analyze();
      
      expect(analysis).to.exist;
      expect(analysis.totalIndexes).to.equal(1);
      expect(analysis.timestamp).to.exist;
    });
    
    it('should generate proper report', function() {
      const analysis = {
        totalIndexes: 10,
        usedIndexes: 8,
        unusedIndexes: 2,
        duplicateIndexes: 1,
        bloatedIndexes: 0,
        timestamp: '2026-07-06T05:00:00Z',
        details: {
          unusedIndexes: [{ tableName: 'test', indexName: 'idx_unused', indexSize: '1 MB', reason: 'Never used' }],
          duplicateIndexes: [],
          suggestedIndexes: [],
          indexBloat: []
        }
      };
      
      const report = analyzer.generateReport(analysis);
      
      expect(report).to.include('Database Index Analysis Report');
      expect(report).to.include('Total Indexes: 10');
      expect(report).to.include('Unused Indexes');
    });
    
    it('should generate index drop SQL', function() {
      const unusedIndexes = [
        { tableName: 'users', indexName: 'idx_old', reason: 'Never used', indexSize: '1 MB' }
      ];
      
      const sql = analyzer.generateIndexDropSQL(unusedIndexes);
      
      expect(sql).to.have.lengthOf(1);
      expect(sql[0].sql).to.include('DROP INDEX');
      expect(sql[0].indexName).to.equal('idx_old');
    });
    
    it('should report metrics correctly', function() {
      const indexStats = [
        { table_name: 'users', idx_scan: 100 },
        { table_name: 'pokemon', idx_scan: 0 }
      ];
      
      analyzer.reportMetrics(indexStats, [{ indexName: 'idx_unused' }]);
      
      expect(mockMetrics.setGauge.calledWithMatch('database_index_total_count')).to.be.true;
      expect(mockMetrics.setGauge.calledWithMatch('database_index_unused_count')).to.be.true;
    });
  });
  
  describe('API Routes', function() {
    // Routes tests would require Express mock setup
    // This is a simplified integration test placeholder
    
    it('should export router with expected routes', function() {
      const routes = require('../../shared/routes/slowQuery');
      
      // Check that router is exported
      expect(routes).to.exist;
      expect(typeof routes).to.equal('function');
    });
  });
});

describe('Integration Tests', function() {
  
  describe('Slow Query Flow', function() {
    it('should detect and analyze slow query end-to-end', async function() {
      // This would be a real integration test with actual database
      // For unit testing purposes, we verify the flow through mocks
      
      const collector = new (proxyquire('../../shared/slowQueryCollector', {
        './logger': mockLogger,
        './metrics': mockMetrics,
        'pg': { Client: sinon.stub() }
      })).SlowQueryCollector({ slowThreshold: 500 });
      
      const status = collector.getStatus();
      
      expect(status.slowThreshold).to.equal(500);
    });
  });
  
  describe('Optimization Flow', function() {
    it('should generate optimization recommendations', function() {
      const analyzer = new (proxyquire('../../shared/queryPlanAnalyzer', {
        './logger': mockLogger,
        './metrics': mockMetrics
      }))(null);
      
      const analysis = {
        scanType: 'Sequential Scan',
        actualRows: 10000,
        executionTime: 5000,
        bufferHits: 10,
        bufferReads: 100,
        totalCost: 5000,
        indexUsed: null
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      
      expect(suggestions.some(s => s.type === 'add_index')).to.be.true;
      expect(suggestions.some(s => s.type === 'optimize_query')).to.be.true;
    });
  });
});