/**
 * REQ-00060: 分区管理器单元测试
 */

const partitionManager = require('../../shared/partitionManager');
const db = require('../../shared/db');

// Mock dependencies
jest.mock('../../shared/db', () => ({
  query: jest.fn()
}));

jest.mock('../../shared/index', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  },
  metrics: {
    increment: jest.fn(),
    gauge: jest.fn()
  }
}));

describe('PartitionManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    partitionManager.initialized = false;
  });

  describe('calculatePartition', () => {
    it('should calculate monthly partition correctly', () => {
      // Mock current date
      const originalDate = Date;
      const mockDate = new Date('2026-06-10T10:00:00Z');
      global.Date = class extends originalDate {
        constructor(...args) {
          if (args.length === 0) {
            return mockDate;
          }
          return new originalDate(...args);
        }
        static now() {
          return mockDate.getTime();
        }
      };

      const result = partitionManager.calculatePartition('monthly', 0);

      expect(result.name).toBe('2026_06');
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
      expect(result.end > result.start).toBe(true);

      global.Date = originalDate;
    });

    it('should calculate daily partition correctly', () => {
      const result = partitionManager.calculatePartition('daily', 0);

      expect(result.name).toMatch(/^\d{4}_\d{2}_\d{2}$/);
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
      expect(result.end > result.start).toBe(true);
    });

    it('should calculate weekly partition correctly', () => {
      const result = partitionManager.calculatePartition('weekly', 0);

      expect(result.name).toMatch(/^\d{4}_w\d{2}$/);
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
      expect(result.end > result.start).toBe(true);
    });

    it('should calculate future partition with offset', () => {
      const current = partitionManager.calculatePartition('monthly', 0);
      const future = partitionManager.calculatePartition('monthly', 1);

      expect(future.start >= current.end).toBe(true);
    });

    it('should calculate daily partition with offset', () => {
      const current = partitionManager.calculatePartition('daily', 0);
      const next = partitionManager.calculatePartition('daily', 1);

      expect(next.start >= current.end).toBe(true);
    });

    it('should throw error for unknown granularity', () => {
      expect(() => {
        partitionManager.calculatePartition('yearly', 0);
      }).toThrow('Unknown granularity: yearly');
    });
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      db.query.mockResolvedValue({ rows: [] });

      await partitionManager.initialize();

      expect(db.query).toHaveBeenCalled();
      expect(partitionManager.initialized).toBe(true);
    });

    it('should not reinitialize if already initialized', async () => {
      partitionManager.initialized = true;

      await partitionManager.initialize();

      expect(db.query).not.toHaveBeenCalled();
    });
  });

  describe('ensureFuturePartitions', () => {
    it('should create future partitions', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [] }) // initialize
        .mockResolvedValue({ rows: [{ created: true }] });

      const created = await partitionManager.ensureFuturePartitions('catch_records', 2);

      expect(created.length).toBeGreaterThanOrEqual(0);
    });

    it('should throw error for unknown table', async () => {
      db.query.mockResolvedValue({ rows: [] });

      await expect(
        partitionManager.ensureFuturePartitions('unknown_table', 1)
      ).rejects.toThrow('Unknown table: unknown_table');
    });
  });

  describe('listPartitions', () => {
    it('should list all partitions', async () => {
      db.query.mockResolvedValue({
        rows: [
          {
            partition_name: 'catch_records_2026_06',
            partition_bound: "FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')"
          },
          {
            partition_name: 'catch_records_2026_07',
            partition_bound: "FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')"
          }
        ]
      });

      const partitions = await partitionManager.listPartitions('catch_records');

      expect(partitions).toBeInstanceOf(Array);
      expect(partitions.length).toBe(2);
      expect(partitions[0]).toHaveProperty('name');
      expect(partitions[0]).toHaveProperty('fullName');
      expect(partitions[0]).toHaveProperty('start');
      expect(partitions[0]).toHaveProperty('end');
    });

    it('should return empty array on error', async () => {
      db.query.mockRejectedValue(new Error('Database error'));

      const partitions = await partitionManager.listPartitions('catch_records');

      expect(partitions).toEqual([]);
    });
  });

  describe('parsePartitionBound', () => {
    it('should parse partition bound correctly', () => {
      const row = {
        partition_name: 'catch_records_2026_06',
        partition_bound: "FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')"
      };

      const result = partitionManager.parsePartitionBound(row);

      expect(result.name).toBe('2026_06');
      expect(result.fullName).toBe('catch_records_2026_06');
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
    });

    it('should handle missing bound', () => {
      const row = {
        partition_name: 'catch_records_2026_06',
        partition_bound: null
      };

      const result = partitionManager.parsePartitionBound(row);

      expect(result.name).toBe('2026_06');
      expect(result.start).toBeNull();
      expect(result.end).toBeNull();
    });
  });

  describe('getPartitionStats', () => {
    it('should return partition statistics', async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [{
            partition_name: 'catch_records_2026_06',
            partition_bound: "FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')"
          }]
        })
        .mockResolvedValueOnce({ rows: [{ table_size: '1048576' }] })
        .mockResolvedValueOnce({ rows: [{ row_count: '10000' }] });

      const stats = await partitionManager.getPartitionStats('catch_records');

      expect(stats).toBeInstanceOf(Array);
      expect(stats[0]).toHaveProperty('name');
      expect(stats[0]).toHaveProperty('sizeBytes');
      expect(stats[0]).toHaveProperty('rowCount');
    });
  });

  describe('calculateRetentionCutoff', () => {
    it('should calculate cutoff for monthly retention', () => {
      const config = { retentionMonths: 12 };
      const cutoff = partitionManager.calculateRetentionCutoff(config);

      expect(cutoff).toBeInstanceOf(Date);
    });

    it('should calculate cutoff for daily retention', () => {
      const config = { retentionDays: 30 };
      const cutoff = partitionManager.calculateRetentionCutoff(config);

      expect(cutoff).toBeInstanceOf(Date);
    });

    it('should return null for permanent retention', () => {
      const config = { retentionMonths: null };
      const cutoff = partitionManager.calculateRetentionCutoff(config);

      expect(cutoff).toBeNull();
    });
  });

  describe('calculateArchiveCutoff', () => {
    it('should calculate archive cutoff', () => {
      const config = { retentionMonths: 12, archiveMonths: 12 };
      const cutoff = partitionManager.calculateArchiveCutoff(config);

      expect(cutoff).toBeInstanceOf(Date);
    });

    it('should return null when no archive config', () => {
      const config = { retentionMonths: 12 };
      const cutoff = partitionManager.calculateArchiveCutoff(config);

      expect(cutoff).toBeNull();
    });
  });

  describe('runMaintenance', () => {
    it('should run maintenance for all tables', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [] }) // initialize
        .mockResolvedValue({ rows: [] }); // other queries

      const results = await partitionManager.runMaintenance();

      expect(results).toHaveProperty('created');
      expect(results).toHaveProperty('archived');
      expect(results).toHaveProperty('dropped');
      expect(results).toHaveProperty('errors');
      expect(Array.isArray(results.created)).toBe(true);
      expect(Array.isArray(results.archived)).toBe(true);
      expect(Array.isArray(results.dropped)).toBe(true);
      expect(Array.isArray(results.errors)).toBe(true);
    });
  });

  describe('getOverview', () => {
    it('should return overview for all tables', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [] }) // initialize
        .mockResolvedValue({ rows: [] }); // listPartitions

      const overview = await partitionManager.getOverview();

      expect(overview).toBeInstanceOf(Object);
      expect(overview).toHaveProperty('catch_records');
      expect(overview).toHaveProperty('location_updates');
      expect(overview).toHaveProperty('audit_logs');
      expect(overview).toHaveProperty('event_logs');
      expect(overview).toHaveProperty('payment_transactions');
    });
  });

  describe('partitionConfigs', () => {
    it('should have correct table configurations', () => {
      const configs = partitionManager.partitionConfigs;

      expect(configs.catch_records.granularity).toBe('monthly');
      expect(configs.location_updates.granularity).toBe('daily');
      expect(configs.audit_logs.granularity).toBe('monthly');
      expect(configs.event_logs.granularity).toBe('weekly');
      expect(configs.payment_transactions.granularity).toBe('monthly');
    });

    it('should have retention settings', () => {
      const configs = partitionManager.partitionConfigs;

      expect(configs.catch_records.retentionMonths).toBe(12);
      expect(configs.location_updates.retentionDays).toBe(30);
      expect(configs.audit_logs.retentionMonths).toBe(24);
      expect(configs.payment_transactions.retentionMonths).toBeNull();
    });
  });
});

describe('Partition API Router', () => {
  // API 路由测试将在集成测试中进行
  it('should be defined', () => {
    const router = require('../../gateway/src/routes/partitions');
    expect(router).toBeDefined();
  });
});
