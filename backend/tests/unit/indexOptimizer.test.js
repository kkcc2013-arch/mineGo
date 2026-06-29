// backend/tests/unit/indexOptimizer.test.js
'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { SlowQueryCollector } = require('../../shared/indexOptimizer/SlowQueryCollector');
const { IndexRecommender, QueryPatternAnalyzer, ColumnImportanceAnalyzer } = require('../../shared/indexOptimizer/IndexRecommender');
const { IndexHealthChecker } = require('../../shared/indexOptimizer/IndexHealthChecker');
const { IndexOptimizationExecutor } = require('../../shared/indexOptimizer/IndexOptimizationExecutor');
const { IndexOptimizerManager } = require('../../shared/indexOptimizer/IndexOptimizerManager');

describe('IndexOptimizer', () => {
  describe('SlowQueryCollector', () => {
    let collector;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub()
      };
      
      collector = new SlowQueryCollector({
        pool: mockPool,
        slowQueryThreshold: 500,
        collectionInterval: 60000
      });
    });

    afterEach(() => {
      collector?.stop?.();
    });

    describe('normalizeQuery', () => {
      it('should normalize numeric constants', () => {
        const query = 'SELECT * FROM users WHERE id = 123 AND age > 25';
        const normalized = collector.normalizeQuery(query);
        
        expect(normalized).to.include('?');
        expect(normalized).to.not.include('123');
        expect(normalized).to.not.include('25');
      });

      it('should normalize string constants', () => {
        const query = "SELECT * FROM pokemon WHERE name = 'Charmander'";
        const normalized = collector.normalizeQuery(query);
        
        expect(normalized).to.include('?');
        expect(normalized).to.not.include('Charmander');
      });

      it('should normalize multiple whitespaces', () => {
        const query = 'SELECT  *   FROM    users';
        const normalized = collector.normalizeQuery(query);
        
        expect(normalized).to.not.include('  ');
        expect(normalized).to.match(/SELECT \* FROM users/);
      });
    });

    describe('calculateCacheHitRatio', () => {
      it('should return 100 when both values are 0', () => {
        const ratio = collector.calculateCacheHitRatio(0, 0);
        expect(ratio).to.equal(100);
      });

      it('should calculate correct ratio', () => {
        const ratio = collector.calculateCacheHitRatio(80, 20);
        expect(ratio).to.equal(80);
      });
    });

    describe('calculateSeverity', () => {
      it('should return critical for > 5s', () => {
        expect(collector.calculateSeverity(6000)).to.equal('critical');
      });

      it('should return high for > 2s', () => {
        expect(collector.calculateSeverity(3000)).to.equal('high');
      });

      it('should return medium for > 1s', () => {
        expect(collector.calculateSeverity(1500)).to.equal('medium');
      });

      it('should return low for < 1s', () => {
        expect(collector.calculateSeverity(800)).to.equal('low');
      });
    });

    describe('collectSlowQueries', () => {
      it('should collect slow queries from pg_stat_statements', async () => {
        mockPool.query.resolves({
          rows: [
            {
              queryid: 12345,
              query: 'SELECT * FROM pokemon WHERE trainer_id = 1',
              calls: 100,
              total_exec_time: 50000,
              mean_exec_time: 500,
              min_exec_time: 100,
              max_exec_time: 1000,
              rows: 1000,
              shared_blks_hit: 800,
              shared_blks_read: 200,
              temp_blks_written: 0,
              blk_read_time: 100,
              blk_write_time: 50
            }
          ]
        });

        const queries = await collector.collectSlowQueries();

        expect(queries).to.have.lengthOf(1);
        expect(queries[0].queryId).to.be.a('string');
        expect(queries[0].meanExecTime).to.equal(500);
      });

      it('should handle pg_stat_statements not available', async () => {
        mockPool.query.rejects({ code: '42P01' });

        const queries = await collector.collectSlowQueries();

        expect(queries).to.have.lengthOf(0);
      });
    });
  });

  describe('IndexRecommender', () => {
    let recommender;

    beforeEach(() => {
      recommender = new IndexRecommender();
    });

    describe('QueryPatternAnalyzer', () => {
      let analyzer;

      beforeEach(() => {
        analyzer = new QueryPatternAnalyzer();
      });

      it('should parse SELECT query with table', () => {
        const pattern = analyzer.analyze('SELECT * FROM pokemon WHERE trainer_id = ?');
        
        expect(pattern.table).to.equal('pokemon');
        expect(pattern.queryType).to.equal('SELECT');
        expect(pattern.whereClause).to.exist;
      });

      it('should parse WHERE clause conditions', () => {
        const pattern = analyzer.analyze('SELECT * FROM users WHERE id = ? AND name LIKE ?');
        
        expect(pattern.whereClause.conditions).to.have.lengthOf.at.least(1);
        expect(pattern.whereClause.conditions[0].column).to.equal('id');
      });

      it('should detect INSERT queries', () => {
        const pattern = analyzer.analyze('INSERT INTO pokemon VALUES (?)');
        
        expect(pattern.queryType).to.equal('INSERT');
      });

      it('should return null for invalid queries', () => {
        const pattern = analyzer.analyze('');
        
        expect(pattern).to.be.null;
      });
    });

    describe('ColumnImportanceAnalyzer', () => {
      let analyzer;

      beforeEach(() => {
        analyzer = new ColumnImportanceAnalyzer();
      });

      it('should analyze column importance from WHERE clause', () => {
        const pattern = {
          whereClause: {
            conditions: [
              { column: 'trainer_id', operator: '=' }
            ],
            selective: true
          }
        };
        
        const tableStats = [
          {
            attname: 'trainer_id',
            n_distinct: -0.1,
            correlation: 0.8
          }
        ];
        
        const importance = analyzer.analyze(pattern, { rows: 10000 }, tableStats);
        
        expect(importance.singleColumnCandidates).to.have.lengthOf.at.least(1);
        expect(importance.singleColumnCandidates[0].name).to.equal('trainer_id');
      });

      it('should use default values when stats not available', () => {
        const pattern = {
          whereClause: {
            conditions: [{ column: 'unknown_col', operator: '=' }],
            selective: true
          }
        };
        
        const importance = analyzer.analyze(pattern, {}, []);
        
        expect(importance.singleColumnCandidates[0].cardinality).to.equal(1000);
      });
    });

    describe('generateSingleColumnIndexRecommendation', () => {
      it('should generate recommendation for high cardinality column', () => {
        const recommendation = recommender.generateSingleColumnIndexRecommendation(
          'pokemon',
          { name: 'trainer_id', cardinality: 10000 },
          { meanExecTime: 1000, queryId: 'test' },
          []
        );
        
        expect(recommendation).to.exist;
        expect(recommendation.type).to.equal('CREATE');
        expect(recommendation.indexName).to.equal('idx_pokemon_trainer_id');
        expect(recommendation.sql).to.include('CREATE INDEX CONCURRENTLY');
        expect(recommendation.priority).to.be.above(50);
      });

      it('should skip low cardinality columns', () => {
        const recommendation = recommender.generateSingleColumnIndexRecommendation(
          'pokemon',
          { name: 'status', cardinality: 5 },
          { meanExecTime: 1000 },
          []
        );
        
        expect(recommendation).to.be.null;
      });

      it('should skip if index already exists', () => {
        const recommendation = recommender.generateSingleColumnIndexRecommendation(
          'pokemon',
          { name: 'trainer_id', cardinality: 10000 },
          { meanExecTime: 1000 },
          [{ table: 'pokemon', columns: ['trainer_id'] }]
        );
        
        expect(recommendation).to.be.null;
      });
    });

    describe('generateCompositeIndexRecommendation', () => {
      it('should generate composite index recommendation', () => {
        const columns = [
          { name: 'trainer_id', cardinality: 10000 },
          { name: 'level', cardinality: 100 }
        ];
        
        const recommendation = recommender.generateCompositeIndexRecommendation(
          'pokemon',
          columns,
          { meanExecTime: 2000 },
          []
        );
        
        expect(recommendation).to.exist;
        expect(recommendation.columns).to.have.lengthOf(2);
        expect(recommendation.type).to.equal('CREATE');
      });

      it('should order columns by cardinality', () => {
        const columns = [
          { name: 'level', cardinality: 100 },
          { name: 'trainer_id', cardinality: 10000 }
        ];
        
        const recommendation = recommender.generateCompositeIndexRecommendation(
          'pokemon',
          columns,
          { meanExecTime: 2000 },
          []
        );
        
        expect(recommendation.columns[0]).to.equal('trainer_id');
        expect(recommendation.columns[1]).to.equal('level');
      });
    });

    describe('calculatePriority', () => {
      it('should return high priority for slow queries', () => {
        const priority = recommender.calculatePriority(5000, 10000);
        expect(priority).to.be.above(80);
      });

      it('should return lower priority for fast queries', () => {
        const priority = recommender.calculatePriority(500, 100);
        expect(priority).to.be.below(50);
      });
    });

    describe('deduplicateRecommendations', () => {
      it('should remove duplicate recommendations', () => {
        const recommendations = [
          { tableName: 'pokemon', columns: ['trainer_id'], priority: 80 },
          { tableName: 'pokemon', columns: ['trainer_id'], priority: 90 },
          { tableName: 'pokemon', columns: ['level'], priority: 70 }
        ];
        
        const deduped = recommender.deduplicateRecommendations(recommendations);
        
        expect(deduped).to.have.lengthOf(2);
        expect(deduped.find(r => r.columns.includes('trainer_id')).priority).to.equal(90);
      });
    });
  });

  describe('IndexHealthChecker', () => {
    let checker;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub()
      };
      
      checker = new IndexHealthChecker(mockPool);
    });

    describe('findUnusedIndexes', () => {
      it('should find unused indexes', async () => {
        mockPool.query.resolves({
          rows: [
            {
              schemaname: 'public',
              relname: 'pokemon',
              indexrelname: 'idx_pokemon_old',
              idx_scan: 0,
              idx_tup_read: 0,
              idx_tup_fetch: 0,
              index_size_bytes: 1048576
            }
          ]
        });

        const unused = await checker.findUnusedIndexes();

        expect(unused).to.have.lengthOf(1);
        expect(unused[0].indexName).to.equal('idx_pokemon_old');
        expect(unused[0].recommendation).to.equal('DROP');
      });
    });

    describe('findDuplicateIndexes', () => {
      it('should find duplicate indexes', async () => {
        mockPool.query.resolves({
          rows: [
            {
              schema: 'public',
              table: 'pokemon',
              index1: 'idx_pokemon_a',
              index2: 'idx_pokemon_ab',
              size1: 1048576,
              size2: 2097152
            }
          ]
        });

        const duplicates = await checker.findDuplicateIndexes();

        expect(duplicates).to.have.lengthOf.at.least(0);
      });
    });

    describe('formatSize', () => {
      it('should format bytes correctly', () => {
        expect(checker.formatSize(500)).to.equal('500 B');
        expect(checker.formatSize(1024)).to.equal('1.0 KB');
        expect(checker.formatSize(1048576)).to.equal('1.0 MB');
        expect(checker.formatSize(1073741824)).to.match(/GB/);
      });
    });
  });

  describe('IndexOptimizationExecutor', () => {
    let executor;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub().resolves()
      };
      
      executor = new IndexOptimizationExecutor(mockPool, {
        dryRun: true,
        executionWindow: { start: 0, end: 24 }
      });
    });

    describe('executeOptimization', () => {
      it('should execute in dry-run mode', async () => {
        const result = await executor.executeOptimization({
          type: 'CREATE',
          sql: 'CREATE INDEX CONCURRENTLY idx_test ON pokemon (trainer_id)',
          indexName: 'idx_test',
          tableName: 'pokemon'
        });

        expect(result.success).to.be.true;
        expect(result.dryRun).to.be.true;
        expect(result.log.status).to.equal('DRY_RUN');
      });

      it('should check execution window', async () => {
        executor.config.executionWindow = { start: 2, end: 6 };
        executor.config.dryRun = false;

        const result = await executor.executeOptimization({
          type: 'CREATE',
          sql: 'CREATE INDEX idx_test ON pokemon (trainer_id)'
        });

        expect(result.success).to.be.false;
        expect(result.reason).to.include('执行窗口');
      });

      it('should check database load', async () => {
        executor.config.checkLoadBeforeExecute = true;
        executor.config.dryRun = false;
        
        mockPool.query.resolves({
          rows: [
            { total_connections: 100, active_queries: 30, avg_query_age: 40, max_query_age: 400 }
          ]
        });

        const result = await executor.executeOptimization({
          type: 'CREATE',
          sql: 'CREATE INDEX idx_test ON pokemon (trainer_id)'
        });

        expect(result.success).to.be.false;
        expect(result.reason).to.include('负载过高');
      });
    });

    describe('isInExecutionWindow', () => {
      it('should return true for dry-run', () => {
        executor.config.dryRun = true;
        expect(executor.isInExecutionWindow()).to.be.true;
      });

      it('should check time window', () => {
        executor.config.dryRun = false;
        executor.config.executionWindow = { start: 0, end: 24 };
        expect(executor.isInExecutionWindow()).to.be.true;
      });
    });

    describe('checkDatabaseLoad', () => {
      it('should return safe when load is low', async () => {
        mockPool.query.resolves({
          rows: [
            { total_connections: 10, active_queries: 5, avg_query_age: 5, max_query_age: 60 }
          ]
        });

        const check = await executor.checkDatabaseLoad();

        expect(check.safe).to.be.true;
      });

      it('should return unsafe when connections high', async () => {
        mockPool.query.resolves({
          rows: [
            { total_connections: 60, active_queries: 5, avg_query_age: 5, max_query_age: 60 }
          ]
        });

        const check = await executor.checkDatabaseLoad();

        expect(check.safe).to.be.false;
        expect(check.reason).to.include('连接');
      });
    });

    describe('getExecutionLog', () => {
      it('should return execution log', async () => {
        await executor.executeOptimization({ type: 'CREATE', sql: 'test' });
        
        const log = executor.getExecutionLog();

        expect(log).to.have.lengthOf.at.least(1);
        expect(log[0].status).to.equal('DRY_RUN');
      });
    });
  });

  describe('IndexOptimizerManager', () => {
    let manager;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub().resolves({ rows: [] })
      };
      
      manager = new IndexOptimizerManager({
        pool: mockPool,
        dryRun: true,
        collectionInterval: 0
      });
    });

    afterEach(() => {
      manager?.stop?.();
    });

    describe('getStatusSummary', () => {
      it('should return status summary', () => {
        const summary = manager.getStatusSummary();

        expect(summary).to.have.property('slowQueries');
        expect(summary).to.have.property('recommendations');
        expect(summary).to.have.property('executionStats');
        expect(summary).to.have.property('config');
      });
    });

    describe('processSlowQuery', () => {
      it('should process slow query and generate recommendations', async () => {
        mockPool.query.resolves({
          rows: [
            { attname: 'trainer_id', n_distinct: -0.1, correlation: 0.8 }
          ]
        });

        const slowQuery = {
          queryId: 'test',
          query: 'SELECT * FROM pokemon WHERE trainer_id = ?',
          meanExecTime: 1000,
          severity: 'high'
        };

        await manager.processSlowQuery(slowQuery);

        expect(manager.recommendations).to.have.lengthOf.at.least(0);
      });
    });
  });
});