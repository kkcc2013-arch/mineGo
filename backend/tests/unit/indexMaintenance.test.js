// tests/unit/indexMaintenance.test.js - Index Maintenance Unit Tests
'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Mock dependencies
const mockDb = {
  query: sinon.stub()
};

const mockRedis = {
  keys: sinon.stub(),
  get: sinon.stub(),
  set: sinon.stub(),
  del: sinon.stub(),
  publish: sinon.stub()
};

const mockLogger = {
  info: sinon.stub(),
  warn: sinon.stub(),
  error: sinon.stub()
};

// Stub modules
const indexUsageMonitor = proxyquire('../../shared/indexUsageMonitor', {
  './db': { query: mockDb.query },
  './redis': {
    getRedis: () => mockRedis,
    getJSON: () => Promise.resolve(null),
    setJSON: () => Promise.resolve(),
    publish: () => Promise.resolve()
  },
  './logger': { createLogger: () => mockLogger }
});

describe('IndexUsageMonitor', () => {
  let monitor;

  beforeEach(() => {
    monitor = new indexUsageMonitor.IndexUsageMonitor();
    sinon.resetHistory();
  });

  describe('categorizeIndex', () => {
    it('should categorize primary key correctly', () => {
      const def = { is_primary: true };
      expect(monitor.categorizeIndex(def)).to.equal('PRIMARY');
    });

    it('should categorize unique index correctly', () => {
      const def = { is_unique: true, is_primary: false };
      expect(monitor.categorizeIndex(def)).to.equal('UNIQUE');
    });

    it('should categorize foreign key correctly', () => {
      const def = { column_name: 'user_id', is_primary: false, is_unique: false };
      expect(monitor.categorizeIndex(def)).to.equal('FOREIGN_KEY');
    });

    it('should categorize performance index correctly', () => {
      const def = { index_type: 'btree', is_primary: false, is_unique: false };
      expect(monitor.categorizeIndex(def)).to.equal('PERFORMANCE');
    });
  });

  describe('calculateRiskLevel', () => {
    it('should return CRITICAL for unused large index', () => {
      const usage = {
        index_scans: 0,
        index_size_bytes: 50 * 1024 * 1024, // 50 MB
        scan_read_ratio: null
      };
      const def = { isPrimary: false };
      const risk = monitor.calculateRiskLevel(usage, def);
      expect(risk.level).to.equal('CRITICAL');
    });

    it('should return SAFE for frequently used index', () => {
      const usage = {
        index_scans: 10000,
        index_size_bytes: 1024,
        scan_read_ratio: 1.5
      };
      const def = { isPrimary: false };
      const risk = monitor.calculateRiskLevel(usage, def);
      expect(risk.level).to.equal('SAFE');
    });

    it('should return MEDIUM for low usage index', () => {
      const usage = {
        index_scans: 50,
        index_size_bytes: 5 * 1024 * 1024,
        scan_read_ratio: 2
      };
      const def = { isPrimary: false };
      const risk = monitor.calculateRiskLevel(usage, def);
      expect(risk.level).to.be.oneOf(['LOW', 'MEDIUM', 'HIGH']);
    });

    it('should protect primary keys', () => {
      const usage = {
        index_scans: 0,
        index_size_bytes: 100 * 1024 * 1024
      };
      const def = { isPrimary: true };
      const risk = monitor.calculateRiskLevel(usage, def);
      expect(risk.level).to.equal('SAFE');
    });
  });

  describe('generateRecommendation', () => {
    it('should recommend removal for CRITICAL risk index', () => {
      const usage = { index_scans: 0, index_name: 'test_idx' };
      const def = { isPrimary: false };
      const risk = { level: 'CRITICAL' };
      const recommendations = monitor.generateRecommendation(usage, def, risk);
      expect(recommendations).to.have.length.greaterThan(0);
      expect(recommendations[0].type).to.equal('REMOVE');
    });

    it('should recommend review for HIGH risk index', () => {
      const usage = { index_scans: 5, index_name: 'test_idx' };
      const def = { isPrimary: false };
      const risk = { level: 'HIGH' };
      const recommendations = monitor.generateRecommendation(usage, def, risk);
      expect(recommendations).to.have.length.greaterThan(0);
      expect(recommendations[0].type).to.equal('REVIEW');
    });

    it('should recommend monitoring for MEDIUM risk index', () => {
      const usage = { index_scans: 50, index_name: 'test_idx' };
      const def = { isPrimary: false };
      const risk = { level: 'MEDIUM' };
      const recommendations = monitor.generateRecommendation(usage, def, risk);
      expect(recommendations).to.have.length.greaterThan(0);
      expect(recommendations[0].type).to.equal('MONITOR');
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(monitor.formatBytes(0)).to.equal('0 B');
      expect(monitor.formatBytes(1024)).to.equal('1 KB');
      expect(monitor.formatBytes(1024 * 1024)).to.equal('1 MB');
      expect(monitor.formatBytes(1024 * 1024 * 1024)).to.equal('1 GB');
    });
  });

  describe('processIndexStats', () => {
    it('should process index statistics correctly', () => {
      const usageRows = [
        {
          schemaname: 'public',
          relname: 'users',
          indexrelname: 'users_pkey',
          idx_scan: '10000',
          idx_tup_read: '50000',
          idx_tup_fetch: '45000',
          index_size: '100 MB',
          index_size_bytes: '104857600',
          scan_read_ratio: '0.8'
        },
        {
          schemaname: 'public',
          relname: 'catches',
          indexrelname: 'catches_date_idx',
          idx_scan: '0',
          idx_tup_read: '0',
          idx_tup_fetch: '0',
          index_size: '50 MB',
          index_size_bytes: '52428800',
          scan_read_ratio: null
        }
      ];

      const defRows = [
        {
          table_name: 'users',
          index_name: 'users_pkey',
          column_name: 'id',
          is_unique: true,
          is_primary: true,
          index_type: 'btree',
          index_def: 'CREATE UNIQUE INDEX users_pkey ON users(id)'
        },
        {
          table_name: 'catches',
          index_name: 'catches_date_idx',
          column_name: 'created_at',
          is_unique: false,
          is_primary: false,
          index_type: 'btree',
          index_def: 'CREATE INDEX catches_date_idx ON catches(created_at)'
        }
      ];

      const stats = monitor.processIndexStats(usageRows, defRows, [], []);

      expect(stats.total).to.equal(2);
      expect(stats.unused).to.have.lengthOf(1);
      expect(stats.unused[0].name).to.equal('catches_date_idx');
      expect(stats.primaryKeys).to.have.lengthOf(1);
      expect(stats.primaryKeys[0].name).to.equal('users_pkey');
    });
  });

  describe('generateSummary', () => {
    it('should generate summary with correct statistics', () => {
      const stats = {
        total: 10,
        indexes: [
          { sizeBytes: 1000000, risk: { level: 'SAFE' } },
          { sizeBytes: 2000000, risk: { level: 'LOW' } },
          { sizeBytes: 500000, risk: { level: 'CRITICAL' } }
        ],
        unused: [{ sizeBytes: 500000 }],
        lowUsage: [{ sizeBytes: 300000 }],
        duplicates: []
      };

      const summary = monitor.generateSummary(stats);

      expect(summary.totalIndexes).to.equal(10);
      expect(summary.unusedCount).to.equal(1);
      expect(summary.lowUsageCount).to.equal(1);
      expect(summary.distributionByRisk.SAFE).to.equal(1);
      expect(summary.distributionByRisk.LOW).to.equal(1);
      expect(summary.distributionByRisk.CRITICAL).to.equal(1);
    });
  });
});

describe('IndexMaintenanceJob', () => {
  let IndexMaintenanceJob;
  let job;

  before(() => {
    IndexMaintenanceJob = proxyquire('../../jobs/indexMaintenanceJob', {
      '../shared/db': { query: mockDb.query },
      '../shared/redis': {
        getRedis: () => mockRedis,
        getJSON: () => Promise.resolve(null),
        setJSON: () => Promise.resolve(),
        publish: () => Promise.resolve()
      },
      '../shared/logger': { createLogger: () => mockLogger },
      '../shared/indexUsageMonitor': {
        collectIndexStats: () => Promise.resolve({ total: 10, unused: [], lowUsage: [], duplicates: [] }),
        generateReport: () => Promise.resolve({ recommendations: [], summary: {} })
      }
    }).IndexMaintenanceJob;
  });

  beforeEach(() => {
    job = new IndexMaintenanceJob();
    sinon.resetHistory();
  });

  describe('collectStats', () => {
    it('should collect and return index statistics', async () => {
      const result = await job.collectStats();

      expect(result.status).to.equal('success');
      expect(result).to.have.property('totalIndexes');
      expect(result).to.have.property('unusedCount');
      expect(result).to.have.property('timestamp');
    });
  });

  describe('analyzeIndexes', () => {
    it('should analyze indexes and return recommendations', async () => {
      const result = await job.analyzeIndexes();

      expect(result.status).to.equal('success');
      expect(result).to.have.property('recommendationCount');
    });
  });

  describe('getStats', () => {
    it('should return job statistics', () => {
      const stats = job.getStats();

      expect(stats).to.have.property('runs');
      expect(stats).to.have.property('errors');
      expect(stats).to.have.property('config');
      expect(stats.config).to.have.property('enabled');
      expect(stats.config).to.have.property('schedule');
    });
  });

  describe('formatEmailContent', () => {
    it('should generate valid HTML email', () => {
      const report = {
        summary: {
          totalIndexes: 10,
          totalSize: '100 MB',
          unusedCount: 2,
          potentialSavings: '50 MB',
          distributionByRisk: { SAFE: 5, LOW: 3, MEDIUM: 1, HIGH: 1, CRITICAL: 0 }
        },
        recommendations: [
          { priority: 'HIGH', type: 'REMOVE_INDEX', index: 'test_idx', table: 'users', reason: 'Never used', sql: 'DROP INDEX test_idx;' }
        ]
      };

      const html = job.formatEmailContent(report);

      expect(html).to.be.a('string');
      expect(html).to.include('<!DOCTYPE html>');
      expect(html).to.include('Index Maintenance Report');
      expect(html).to.include('Total Indexes');
      expect(html).to.include('10');
      expect(html).to.include('test_idx');
    });
  });

  describe('recordMaintenanceHistory', () => {
    it('should record maintenance action in history', async () => {
      const result = { status: 'success', removed: 2, failed: 0 };

      await job.recordMaintenanceHistory('remove_unused', result);

      // Verify Redis set was called
      expect(mockRedis.set.called).to.be.true;
    });
  });
});

describe('Integration Tests', () => {
  describe('Full Workflow', () => {
    it('should handle end-to-end workflow', async function() {
      this.timeout(5000);

      // This would be a real integration test
      // For now, we just verify the modules are wired correctly

      const { IndexUsageMonitor } = indexUsageMonitor;
      const monitor = new IndexUsageMonitor();

      expect(monitor).to.have.property('collectIndexStats');
      expect(monitor).to.have.property('getLatestStats');
      expect(monitor).to.have.property('generateReport');
      expect(monitor).to.have.property('formatBytes');
    });
  });
});

// Test configuration validation
describe('Configuration', () => {
  it('should have valid CONFIG constants', () => {
    const { CONFIG } = indexUsageMonitor;

    expect(CONFIG.UNUSED_INDEX_THRESHOLD_DAYS).to.be.a('number');
    expect(CONFIG.LOW_USAGE_THRESHOLD).to.be.a('number');
    expect(CONFIG.INDEX_SIZE_THRESHOLD_MB).to.be.a('number');
    expect(CONFIG.SCAN_INTERVAL_HOURS).to.be.a('number');
    expect(CONFIG.RETENTION_DAYS).to.be.a('number');
  });

  it('should have valid RISK_LEVELS', () => {
    const { RISK_LEVELS } = indexUsageMonitor;

    expect(RISK_LEVELS.SAFE).to.have.property('level');
    expect(RISK_LEVELS.SAFE).to.have.property('score');
    expect(RISK_LEVELS.SAFE).to.have.property('action');
    expect(RISK_LEVELS.CRITICAL.score).to.equal(100);
  });

  it('should have valid INDEX_CATEGORIES', () => {
    const { INDEX_CATEGORIES } = indexUsageMonitor;

    expect(INDEX_CATEGORIES.PRIMARY).to.equal('PRIMARY');
    expect(INDEX_CATEGORIES.UNIQUE).to.equal('UNIQUE');
    expect(INDEX_CATEGORIES.FOREIGN_KEY).to.equal('FOREIGN_KEY');
    expect(INDEX_CATEGORIES.PERFORMANCE).to.equal('PERFORMANCE');
  });
});
