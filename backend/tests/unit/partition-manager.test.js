/**
 * 分区管理器单元测试
 */

const { PartitionManager, PARTITION_CONFIGS } = require('../../shared/partitionManager');

// Mock database
jest.mock('pg', () => {
  const mockPool = {
    query: jest.fn(),
    connect: jest.fn()
  };
  return { Pool: jest.fn(() => mockPool) };
});

describe('PartitionManager', () => {
  let partitionManager;
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    partitionManager = new PartitionManager();
    mockDb = partitionManager.db;
  });

  describe('calculatePartition', () => {
    it('should calculate monthly partition correctly', () => {
      const result = partitionManager.calculatePartition('monthly', 0);

      expect(result.name).toMatch(/^\d{4}_\d{2}$/);
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
      expect(result.end > result.start).toBe(true);
    });

    it('should calculate daily partition correctly', () => {
      const result = partitionManager.calculatePartition('daily', 0);

      expect(result.name).toMatch(/^\d{4}_\d{2}_\d{2}$/);
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
      expect(result.end.getTime() - result.start.getTime()).toBe(24 * 60 * 60 * 1000); // 1 day
    });

    it('should calculate weekly partition correctly', () => {
      const result = partitionManager.calculatePartition('weekly', 0);

      expect(result.name).toMatch(/^\d{4}_w\d{2}$/);
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
      expect(result.end.getTime() - result.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000); // 7 days
    });

    it('should calculate future partition with offset', () => {
      const current = partitionManager.calculatePartition('monthly', 0);
      const future = partitionManager.calculatePartition('monthly', 1);

      expect(future.start >= current.end).toBe(true);
    });

    it('should throw error for unknown granularity', () => {
      expect(() => {
        partitionManager.calculatePartition('unknown', 0);
      }).toThrow('Unknown granularity: unknown');
    });
  });

  describe('ensureFuturePartitions', () => {
    it('should create future partitions', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const created = await partitionManager.ensureFuturePartitions('catch_records', 2);

      expect(mockDb.query).toHaveBeenCalled();
      expect(created.length).toBeGreaterThanOrEqual(0);
    });

    it('should skip existing partitions', async () => {
      const error = new Error('Partition already exists');
      error.code = '42P07';
      mockDb.query.mockRejectedValueOnce(error);
      mockDb.query.mockResolvedValue({ rows: [] });

      const created = await partitionManager.ensureFuturePartitions('catch_records', 1);

      expect(created).toBeDefined();
    });

    it('should throw error for unknown table', async () => {
      await expect(
        partitionManager.ensureFuturePartitions('unknown_table', 1)
      ).rejects.toThrow('Unknown table: unknown_table');
    });
  });

  describe('createPartition', () => {
    it('should create partition with correct parameters', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const partition = {
        name: '2026_06',
        start: new Date('2026-06-01'),
        end: new Date('2026-07-01')
      };

      await partitionManager.createPartition('catch_records', partition);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS'),
        [partition.start, partition.end]
      );
    });
  });

  describe('listPartitions', () => {
    it('should list all partitions', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          {
            partition_name: 'catch_records_2026_06',
            partition_bound: "FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')"
          }
        ]
      });

      const partitions = await partitionManager.listPartitions('catch_records');

      expect(partitions).toBeInstanceOf(Array);
      expect(partitions[0]).toHaveProperty('name');
      expect(partitions[0]).toHaveProperty('start');
      expect(partitions[0]).toHaveProperty('end');
    });
  });

  describe('getPartitionStats', () => {
    it('should return partition statistics', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            {
              partition_name: 'catch_records_2026_06',
              partition_bound: "FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')"
            }
          ]
        })
        .mockResolvedValueOnce({
          rows: [{
            table_size: '1048576',
            row_count: '10000'
          }]
        });

      const stats = await partitionManager.getPartitionStats('catch_records');

      expect(stats).toBeInstanceOf(Array);
      expect(stats[0]).toHaveProperty('name');
      expect(stats[0]).toHaveProperty('sizeBytes');
      expect(stats[0]).toHaveProperty('rowCount');
      expect(stats[0].sizeBytes).toBe(1048576);
      expect(stats[0].rowCount).toBe(10000);
    });
  });

  describe('archivePartition', () => {
    it('should archive partition successfully', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({}) // DETACH
          .mockResolvedValueOnce({}) // RENAME
          .mockResolvedValueOnce({}), // COMMIT
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValue(mockClient);

      const partition = {
        name: '2025_01',
        start: new Date('2025-01-01'),
        end: new Date('2025-02-01')
      };

      await partitionManager.archivePartition('catch_records', partition);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('DETACH PARTITION')
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('RENAME TO')
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback on error', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockRejectedValueOnce(new Error('Detach failed')) // DETACH fails
          .mockResolvedValueOnce({}), // ROLLBACK
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValue(mockClient);

      const partition = {
        name: '2025_01',
        start: new Date('2025-01-01'),
        end: new Date('2025-02-01')
      };

      await expect(
        partitionManager.archivePartition('catch_records', partition)
      ).rejects.toThrow('Detach failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('calculateCutoffDate', () => {
    it('should calculate correct cutoff date for monthly retention', () => {
      const config = PARTITION_CONFIGS.catch_records;
      const cutoff = partitionManager.calculateCutoffDate(config);

      expect(cutoff).toBeInstanceOf(Date);
      expect(cutoff < new Date()).toBe(true);
    });

    it('should calculate correct cutoff date for daily retention', () => {
      const config = PARTITION_CONFIGS.location_updates;
      const cutoff = partitionManager.calculateCutoffDate(config);

      expect(cutoff).toBeInstanceOf(Date);
      expect(cutoff < new Date()).toBe(true);
    });
  });

  describe('runMaintenance', () => {
    it('should run maintenance for all tables', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

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

    it('should handle errors gracefully', async () => {
      mockDb.query.mockRejectedValue(new Error('Database error'));

      const results = await partitionManager.runMaintenance();

      expect(results.errors.length).toBeGreaterThan(0);
      expect(results.errors[0]).toHaveProperty('table');
      expect(results.errors[0]).toHaveProperty('error');
    });
  });

  describe('PARTITION_CONFIGS', () => {
    it('should have correct configuration for catch_records', () => {
      const config = PARTITION_CONFIGS.catch_records;

      expect(config.granularity).toBe('monthly');
      expect(config.retentionMonths).toBe(12);
      expect(config.archiveMonths).toBe(12);
      expect(config.partitionColumn).toBe('created_at');
    });

    it('should have correct configuration for location_updates', () => {
      const config = PARTITION_CONFIGS.location_updates;

      expect(config.granularity).toBe('daily');
      expect(config.retentionDays).toBe(30);
      expect(config.archiveDays).toBe(60);
      expect(config.partitionColumn).toBe('created_at');
    });

    it('should have null retention for payment_transactions (永久保留)', () => {
      const config = PARTITION_CONFIGS.payment_transactions;

      expect(config.granularity).toBe('monthly');
      expect(config.retentionMonths).toBeNull();
      expect(config.partitionColumn).toBe('created_at');
    });
  });
});
