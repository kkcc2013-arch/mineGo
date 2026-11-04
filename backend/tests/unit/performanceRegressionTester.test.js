/**
 * PerformanceRegressionTester 单元测试
 * REQ-00490: API性能回归测试自动化与基准线管理系统
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const PerformanceRegressionTester = require('../regression/shared/performanceRegressionTester');

describe('PerformanceRegressionTester', () => {
  let tester;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    // Mock 数据库
    mockDb = {
      query: sinon.stub().resolves({ rows: [] })
    };

    // Mock Redis
    mockRedis = {
      get: sinon.stub().resolves(null),
      set: sinon.stub().resolves('OK'),
      del: sinon.stub().resolves(1)
    };

    tester = new PerformanceRegressionTester(mockDb, mockRedis, {
      iterations: 10,
      concurrency: 5,
      warmupIterations: 2,
      responseTimeThreshold: 0.2,
      throughputThreshold: 0.15,
      errorRateThreshold: 0.01,
      jitterFilterEnabled: true,
      outlierThreshold: 3
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const defaultTester = new PerformanceRegressionTester(mockDb, mockRedis);
      
      expect(defaultTester.config.iterations).to.equal(100);
      expect(defaultTester.config.concurrency).to.equal(10);
      expect(defaultTester.config.responseTimeThreshold).to.equal(0.2);
      expect(defaultTester.config.jitterFilterEnabled).to.be.true;
    });

    it('should override default config', () => {
      expect(tester.config.iterations).to.equal(10);
      expect(tester.config.concurrency).to.equal(5);
    });
  });

  describe('_average', () => {
    it('should calculate average correctly', () => {
      expect(tester._average([10, 20, 30])).to.equal(20);
      expect(tester._average([5])).to.equal(5);
      expect(tester._average([])).to.equal(0);
    });
  });

  describe('_median', () => {
    it('should calculate median for odd count', () => {
      expect(tester._median([10, 20, 30])).to.equal(20);
    });

    it('should calculate median for even count', () => {
      expect(tester._median([10, 20, 30, 40])).to.equal(25);
    });

    it('should handle empty array', () => {
      expect(tester._median([])).to.equal(0);
    });
  });

  describe('_percentile', () => {
    it('should calculate percentiles correctly', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      
      expect(tester._percentile(values, 50)).to.equal(5);
      expect(tester._percentile(values, 90)).to.equal(9);
      expect(tester._percentile(values, 95)).to.equal(10);
      expect(tester._percentile(values, 99)).to.equal(10);
    });

    it('should handle empty array', () => {
      expect(tester._percentile([], 95)).to.equal(0);
    });
  });

  describe('_standardDeviation', () => {
    it('should calculate standard deviation correctly', () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      const stdDev = tester._standardDeviation(values);
      
      expect(stdDev).to.be.closeTo(2.0, 0.1);
    });

    it('should return 0 for empty array', () => {
      expect(tester._standardDeviation([])).to.equal(0);
    });

    it('should return 0 for single value', () => {
      expect(tester._standardDeviation([5])).to.equal(0);
    });
  });

  describe('_filterOutliers', () => {
    it('should filter outliers using Z-score', () => {
      const values = [10, 12, 11, 13, 10, 12, 11, 10, 12, 11, 13, 100]; // Z-score of 100 exceeds 3
      
      const filtered = tester._filterOutliers(values);
      
      expect(filtered).to.not.include(100);
      expect(filtered.length).to.be.lessThan(values.length);
    });

    it('should return all values when filter is disabled', () => {
      tester.config.jitterFilterEnabled = false;
      const values = [10, 12, 100];
      
      const filtered = tester._filterOutliers(values);
      
      expect(filtered).to.deep.equal(values);
    });

    it('should handle small arrays', () => {
      const values = [10];
      
      const filtered = tester._filterOutliers(values);
      
      expect(filtered).to.deep.equal(values);
    });
  });

  describe('_calculateMetrics', () => {
    it('should calculate all metrics correctly', () => {
      const results = [
        { responseTime: 10, statusCode: 200, error: null },
        { responseTime: 20, statusCode: 200, error: null },
        { responseTime: 30, statusCode: 500, error: 'Internal Error' },
        { responseTime: 15, statusCode: 200, error: null },
        { responseTime: 25, statusCode: 200, error: null }
      ];
      
      const metrics = tester._calculateMetrics(results);
      
      expect(metrics.totalRequests).to.equal(5);
      expect(metrics.successCount).to.equal(4);
      expect(metrics.errorCount).to.equal(1);
      expect(metrics.errorRate).to.equal(0.2);
      expect(metrics.samples).to.be.greaterThan(0);
      expect(metrics.timestamp).to.be.a('string');
    });
  });

  describe('_analyzePerformance', () => {
    it('should return null when no baseline', () => {
      const current = { avgResponseTime: 50, p95ResponseTime: 80, errorRate: 0.01, throughput: 100 };
      
      const analysis = tester._analyzePerformance(current, null);
      
      expect(analysis.hasBaseline).to.be.false;
      expect(analysis.isRegression).to.be.null;
      expect(analysis.message).to.include('无历史基准线');
    });

    it('should detect regression when response time increases', () => {
      const baseline = {
        avgResponseTime: 50,
        p95ResponseTime: 80,
        errorRate: 0.01,
        throughput: 100,
        sampleCount: 50
      };
      
      const current = {
        avgResponseTime: 70, // +40%
        p95ResponseTime: 100, // +25%
        errorRate: 0.01,
        throughput: 100,
        stdDev: 10,
        samples: 50
      };
      
      const analysis = tester._analyzePerformance(current, baseline);
      
      expect(analysis.hasBaseline).to.be.true;
      expect(analysis.isRegression).to.be.true;
      expect(analysis.regressions).to.have.length.greaterThan(0);
      expect(analysis.regressions[0].metric).to.equal('avgResponseTime');
    });

    it('should detect improvement when performance improves', () => {
      const baseline = {
        avgResponseTime: 50,
        p95ResponseTime: 80,
        errorRate: 0.01,
        throughput: 100,
        sampleCount: 50
      };
      
      const current = {
        avgResponseTime: 35, // -30%
        p95ResponseTime: 60, // -25%
        errorRate: 0.01,
        throughput: 100,
        stdDev: 10,
        samples: 50
      };
      
      const analysis = tester._analyzePerformance(current, baseline);
      
      expect(analysis.hasBaseline).to.be.true;
      expect(analysis.isRegression).to.be.false;
      expect(analysis.improvements).to.have.length.greaterThan(0);
    });

    it('should detect regression when error rate increases', () => {
      const baseline = {
        avgResponseTime: 50,
        p95ResponseTime: 80,
        errorRate: 0.01,
        throughput: 100,
        sampleCount: 50
      };
      
      const current = {
        avgResponseTime: 50,
        p95ResponseTime: 80,
        errorRate: 0.05, // +4%
        throughput: 100,
        stdDev: 10,
        samples: 50
      };
      
      const analysis = tester._analyzePerformance(current, baseline);
      
      expect(analysis.isRegression).to.be.true;
      const errorRegression = analysis.regressions.find(r => r.metric === 'errorRate');
      expect(errorRegression).to.exist;
      expect(errorRegression.severity).to.equal('high'); // +4 percentage points; critical requires >5
    });

    it('should detect regression when throughput decreases', () => {
      const baseline = {
        avgResponseTime: 50,
        p95ResponseTime: 80,
        errorRate: 0.01,
        throughput: 100,
        sampleCount: 50
      };
      
      const current = {
        avgResponseTime: 50,
        p95ResponseTime: 80,
        errorRate: 0.01,
        throughput: 75, // -25%
        stdDev: 10,
        samples: 50
      };
      
      const analysis = tester._analyzePerformance(current, baseline);
      
      expect(analysis.isRegression).to.be.true;
      const throughputRegression = analysis.regressions.find(r => r.metric === 'throughput');
      expect(throughputRegression).to.exist;
    });
  });

  describe('_calculateOverallScore', () => {
    it('should return 100 for no regressions', () => {
      const score = tester._calculateOverallScore([], []);
      expect(score).to.equal(100);
    });

    it('should penalize critical regressions', () => {
      const regressions = [{ severity: 'critical' }];
      const score = tester._calculateOverallScore(regressions, []);
      
      expect(score).to.equal(60); // 100 - 40
    });

    it('should reward improvements', () => {
      const improvements = [{}, {}];
      const score = tester._calculateOverallScore([], improvements);
      
      expect(score).to.equal(100); // Requirement limits the score to 0–100
    });
  });

  describe('_generateRecommendation', () => {
    it('should recommend pass for no regressions', () => {
      const recommendation = tester._generateRecommendation([], { isSignificant: false });
      expect(recommendation).to.include('通过');
    });

    it('should recommend fix for critical regressions', () => {
      const regressions = [{ severity: 'critical' }];
      const recommendation = tester._generateRecommendation(regressions, { isSignificant: true });
      expect(recommendation).to.include('严重');
      expect(recommendation).to.include('立即');
    });

    it('should recommend check for high regressions', () => {
      const regressions = [{ severity: 'high' }];
      const recommendation = tester._generateRecommendation(regressions, { isSignificant: true });
      expect(recommendation).to.include('显著');
    });

    it('should recommend observation for non-significant changes', () => {
      const regressions = [{ severity: 'medium' }];
      const recommendation = tester._generateRecommendation(regressions, { isSignificant: false });
      expect(recommendation).to.include('未达统计显著性');
    });
  });

  describe('_performTTest', () => {
    it('should perform t-test correctly', () => {
      const current = {
        avgResponseTime: 50,
        stdDev: 10,
        samples: 100
      };
      
      const baseline = {
        avgResponseTime: 45,
        stdDev: 10,
        sampleCount: 100
      };
      
      const test = tester._performTTest(current, baseline);
      
      expect(test.tValue).to.be.a('string');
      expect(test.isSignificant).to.be.a('boolean');
      expect(test.pValue).to.be.a('string');
    });
  });

  describe('_calculateThroughput', () => {
    it('should calculate throughput correctly', () => {
      const results = [
        { responseTime: 10 },
        { responseTime: 20 },
        { responseTime: 15 }
      ];
      
      const throughput = tester._calculateThroughput(results);
      
      expect(throughput).to.be.greaterThan(0);
    });

    it('should return 0 for empty results', () => {
      expect(tester._calculateThroughput([])).to.equal(0);
      expect(tester._calculateThroughput(null)).to.equal(0);
    });
  });

  describe('_generateBatchReport', () => {
    it('should generate complete batch report', () => {
      const results = [
        {
          endpoint: 'GET /api/test1',
          passed: true,
          performance: { avgResponseTime: 50, p95ResponseTime: 80, errorRate: 0.01 },
          analysis: { isRegression: false, regressions: [] }
        },
        {
          endpoint: 'GET /api/test2',
          passed: false,
          performance: { avgResponseTime: 100, p95ResponseTime: 150, errorRate: 0.02 },
          analysis: { 
            isRegression: true, 
            regressions: [{ metric: 'avgResponseTime', severity: 'high' }],
            recommendation: '建议检查'
          }
        }
      ];
      
      const summary = {
        total: 2,
        passed: 1,
        failed: 1,
        regressions: 1,
        duration: 5000
      };
      
      const report = tester._generateBatchReport(results, summary);
      
      expect(report).to.include('API 性能回归测试报告');
      expect(report).to.include('GET /api/test1');
      expect(report).to.include('GET /api/test2');
      expect(report).to.include('性能退化详情');
    });
  });

  describe('runTest with database doubles and real HTTP', () => {
    const app = require('express')();
    app.get('/api/pokemon/list', (_req, res) => res.json({ items: [] }));
    it('should run complete test without baseline', async () => {
      mockDb.query.onFirstCall().resolves({ rows: [] }); // _getBaseline
      mockDb.query.onSecondCall().resolves({ rows: [{ id: 'test-123' }] }); // _storeTestResult
      
      const result = await tester.runTest('GET /api/pokemon/list', {
        app,
        iterations: 5
      });
      
      expect(result).to.have.property('testId');
      expect(result).to.have.property('endpoint');
      expect(result).to.have.property('performance');
      expect(result).to.have.property('analysis');
      expect(result.analysis.hasBaseline).to.be.false;
    });

    it('should run complete test with baseline', async () => {
      mockRedis.get.onFirstCall().resolves(JSON.stringify({
        avgResponseTime: 50,
        p95ResponseTime: 80,
        errorRate: 0.01,
        throughput: 100,
        sampleCount: 50
      }));
      
      mockDb.query.resolves({ rows: [{ id: 'test-456' }] });
      
      const result = await tester.runTest('GET /api/pokemon/list', {
        app,
        iterations: 5
      });
      
      expect(result).to.have.property('baseline');
      expect(result.baseline).to.not.be.null;
    });
  });

  describe('real measurements and failure reporting', () => {
    const express = require('express');
    let server;
    afterEach(async () => { if (server) { await new Promise(resolve => server.close(resolve)); server = null; } });

    it('rejects missing targets and invalid sample configuration', async () => {
      for (const config of [{}, {app: express(), iterations: -1}, {app: express(), concurrency: -1}]) {
        await require('assert').rejects(tester.runTest('GET /test', config));
      }
    });

    it('measures actual HTTP bodies, headers, paths and failing status codes', async () => {
      const app = express();
      app.use(express.json());
      app.post('/items/test-id-123', (req, res) => res.status(422).json({ body: req.body, auth: req.headers.authorization }));
      server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const config = {baseUrl: `http://127.0.0.1:${server.address().port}/`, body: {value: 42}, headers: {authorization: 'test-fixture'}};
      const response = await tester._makeRequest('POST /items/:id', config);
      expect(response.status).to.equal(422);
      expect(response.data).to.deep.equal({body: {value: 42}, auth: 'test-fixture'});
      const metrics = await tester._executePerformanceTest('POST /items/:id', {...config, iterations: 3, concurrency: 2, warmupIterations: 0});
      expect(metrics.errorCount).to.equal(3);
      expect(metrics.throughput).to.be.greaterThan(0);
      await require('assert').rejects(tester._makeRequest('INVALID /test', config));
    });

    it('records connection failures as errors instead of successes', async () => {
      const measured = await tester._measureApiCall('GET /test', {baseUrl: 'http://127.0.0.1:1'});
      expect(measured.statusCode).to.equal(500);
      expect(measured.error).to.be.a('string');
    });

    it('computes concurrent throughput from measured wall time', () => {
      expect(tester._calculateThroughput(Array(10).fill({responseTime: 100}), 100)).to.equal(100);
    });

    it('does not swallow baseline and result persistence failures', async () => {
      mockDb.query.rejects(new Error('Storage unavailable'));
      await require('assert').rejects(tester._updateBaseline('GET /test', {}), /Storage unavailable/);
      await require('assert').rejects(tester._storeTestResult('GET /test', {}, {}), /Storage unavailable/);
    });

    it('uses database baseline when cache is unavailable and tolerates cache writes', async () => {
      mockRedis.get.rejects(new Error('Cache unavailable'));
      mockRedis.set.rejects(new Error('Cache unavailable'));
      mockDb.query.resolves({rows: [{endpoint: 'GET /test', avg_response_time: 50, sample_count: 10}]});
      const baseline = await tester._getBaseline('GET /test');
      expect(baseline.avgResponseTime).to.equal(50);
      expect(baseline.sampleCount).to.equal(10);
    });

    it('tolerates cache invalidation failure after a successful database update', async () => {
      mockRedis.del.rejects(new Error('Cache unavailable'));
      await tester._updateBaseline('GET /test', {});
      expect(mockDb.query.calledOnce).to.be.true;
    });

    it('classifies a greater than five point error increase as critical', () => {
      const analysis = tester._analyzePerformance(
        {avgResponseTime: 10, p95ResponseTime: 10, throughput: 100, errorRate: 0.08, samples: 10},
        {avgResponseTime: 10, p95ResponseTime: 10, throughput: 100, errorRate: 0.01, sampleCount: 10});
      expect(analysis.regressions.find(r => r.metric === 'errorRate').severity).to.equal('critical');
    });

    it('batch report retains measurement failures rather than passing them', async () => {
      const result = await tester.runBatchTests(['GET /test']);
      expect(result.summary.failed).to.equal(1);
      expect(result.summary.passed).to.equal(0);
      expect(result.results[0].error).to.include('real app or baseUrl');
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      mockDb.query.rejects(new Error('Database error'));
      
      try {
        await tester._getBaseline('GET /api/test');
        throw new Error('Expected database failure to reject');
      } catch (error) {
        expect(error.message).to.equal('Database error');
      }
    });

    it('should handle redis errors gracefully', async () => {
      mockRedis.get.rejects(new Error('Redis error'));
      mockDb.query.resolves({ rows: [] });
      
      const baseline = await tester._getBaseline('GET /api/test');
      expect(baseline).to.be.null;
    });
  });
});
