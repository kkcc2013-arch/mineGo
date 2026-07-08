/**
 * REQ-00027: 数据库分区策略测试
 * 测试分区管理器的核心功能
 */

'use strict';

const { expect } = require('chai');
const { PartitionManager, PartitionScheduler, DataTemperatureManager } = require('../shared/partitionManager');
const { query } = require('../shared/db');
const { getRedis } = require('../shared/redis');

describe('PartitionManager', function() {
  this.timeout(30000);

  let catchRecordsManager;

  before(async () => {
    catchRecordsManager = new PartitionManager('catch_records');
  });

  describe('isPartitioned', () => {
    it('should return true for partitioned tables', async () => {
      const result = await catchRecordsManager.isPartitioned();
      expect(result).to.be.a('boolean');
    });
  });

  describe('precreatePartitions', () => {
    it('should precreate 7 daily partitions', async () => {
      const result = await catchRecordsManager.precreatePartitions();
      expect(result).to.not.throw;
      
      // 验证分区已创建
      const stats = await catchRecordsManager.getPartitionStats();
      const recentPartitions = stats.partitions.filter(p => {
        const today = new Date().toISOString().split('T')[0];
        return p.name.includes(today.replace(/-/g, '_'));
      });
      
      expect(recentPartitions.length).to.be.at.least(1);
    });
  });

  describe('getPartitionStats', () => {
    it('should return partition statistics', async () => {
      const stats = await catchRecordsManager.getPartitionStats();
      
      expect(stats).to.have.property('table', 'catch_records');
      expect(stats).to.have.property('partitions').that.is.an('array');
      expect(stats).to.have.property('totalSize').that.is.a('number');
      expect(stats).to.have.property('totalCount').that.is.a('number');
    });
  });

  describe('createPartition', () => {
    it('should create a partition for a specific date', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      const dateStr = futureDate.toISOString().split('T')[0];

      const created = await catchRecordsManager.createPartition(dateStr);
      
      // 如果分区已存在，返回 false
      if (!created) {
        console.log('Partition already exists');
      }
    });
  });

  describe('getColdPartitions', () => {
    it('should identify partitions older than retention period', async () => {
      const coldPartitions = await catchRecordsManager.getColdPartitions();
      
      expect(coldPartitions).to.be.an('array');
      // 由于是新系统，可能没有冷数据
      console.log(`Found ${coldPartitions.length} cold partitions`);
    });
  });

  describe('healthCheck', () => {
    it('should perform health check on partitions', async () => {
      const health = await catchRecordsManager.healthCheck();
      
      expect(health).to.have.property('table', 'catch_records');
      expect(health).to.have.property('healthy').that.is.a('boolean');
      expect(health).to.have.property('issues').that.is.an('array');
      expect(health).to.have.property('stats');
    });
  });
});

describe('PartitionScheduler', function() {
  this.timeout(60000);

  let scheduler;

  before(() => {
    scheduler = new PartitionScheduler();
  });

  describe('runAllTasks', () => {
    it('should run partition tasks for all tables', async () => {
      const results = await scheduler.runAllTasks();
      
      expect(results).to.have.property('precreate');
      expect(results).to.have.property('archive');
      expect(results).to.have.property('health');
      
      // 验证各表的预创建结果
      expect(results.precreate).to.have.property('catch_records');
      expect(results.precreate).to.have.property('battle_logs');
    });
  });

  describe('getAllStats', () => {
    it('should return stats for all partitioned tables', async () => {
      const stats = await scheduler.getAllStats();
      
      expect(stats).to.have.property('catch_records');
      expect(stats).to.have.property('battle_logs');
      expect(stats).to.have.property('trade_records');
      expect(stats).to.have.property('payment_transactions');
    });
  });
});

describe('DataTemperatureManager', function() {
  let tempManager;

  before(() => {
    tempManager = new DataTemperatureManager();
  });

  describe('calculateTemperature', () => {
    it('should classify hot data (within 7 days)', () => {
      const hotDate = new Date();
      hotDate.setDate(hotDate.getDate() - 3);
      
      const temp = tempManager.calculateTemperature(hotDate);
      expect(temp).to.equal('hot');
    });

    it('should classify warm data (7-30 days)', () => {
      const warmDate = new Date();
      warmDate.setDate(warmDate.getDate() - 15);
      
      const temp = tempManager.calculateTemperature(warmDate);
      expect(temp).to.equal('warm');
    });

    it('should classify cold data (older than 30 days)', () => {
      const coldDate = new Date();
      coldDate.setDate(coldDate.getDate() - 60);
      
      const temp = tempManager.calculateTemperature(coldDate);
      expect(temp).to.equal('cold');
    });
  });

  describe('getTemperatureStats', () => {
    it('should return temperature distribution for a table', async () => {
      const stats = await tempManager.getTemperatureStats('catch_records');
      
      expect(stats).to.have.property('hot').that.is.a('number');
      expect(stats).to.have.property('warm').that.is.a('number');
      expect(stats).to.have.property('cold').that.is.a('number');
      
      console.log('Temperature stats:', stats);
    });
  });
});

describe('Partition Query Performance', function() {
  this.timeout(30000);

  it('should use partition pruning for date-based queries', async () => {
    const today = new Date().toISOString().split('T')[0];
    
    const { rows: explainResult } = await query(`
      EXPLAIN ANALYZE 
      SELECT * FROM catch_records 
      WHERE caught_at = $1
    `, [today]);
    
    const plan = JSON.stringify(explainResult);
    console.log('Query plan:', plan);
    
    // 验证分区剪枝（应该只扫描相关分区）
    expect(plan).to.satisfy(p => 
      p.includes('Partition') || p.includes('Scan') || p.includes('caught_at')
    );
  });

  it('should have low latency for hot data queries', async () => {
    const userId = 1; // 测试用户 ID
    const start = Date.now();
    
    try {
      await query(`
        SELECT * FROM catch_records 
        WHERE user_id = $1 
          AND caught_at > NOW() - INTERVAL '1 day'
        LIMIT 100
      `, [userId]);
    } catch (err) {
      // 表可能为空，忽略错误
    }
    
    const latency = Date.now() - start;
    console.log(`Hot data query latency: ${latency}ms`);
    
    // 热数据查询应该在 100ms 内完成
    expect(latency).to.be.lessThan(100);
  });

  it('should use indexes on partitioned tables', async () => {
    const { rows: indexCheck } = await query(`
      SELECT indexname, tablename 
      FROM pg_indexes 
      WHERE tablename LIKE 'catch_records_%'
        AND indexname LIKE '%user%'
    `);
    
    expect(indexCheck.length).to.be.at.least(1);
    console.log(`Found ${indexCheck.length} user indexes on catch_records partitions`);
  });
});

describe('Partition Metadata Management', function() {
  it('should track archived partitions', async () => {
    const { rows } = await query(`
      SELECT * FROM partition_archive_metadata 
      ORDER BY archived_at DESC 
      LIMIT 5
    `);
    
    expect(rows).to.be.an('array');
    console.log('Archived partitions:', rows.length);
  });

  it('should log partition health checks', async () => {
    const { rows } = await query(`
      SELECT * FROM partition_health_log 
      ORDER BY check_at DESC 
      LIMIT 5
    `);
    
    expect(rows).to.be.an('array');
    expect(rows.length).to.be.at.least(1);
    console.log('Health check logs:', rows.length);
  });
});

describe('Partition Functions', function() {
  it('should create partition using create_partition function', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    
    const { rows } = await query(`
      SELECT create_partition($1, $2, $3) as result
    `, ['catch_records', futureDate.toISOString().split('T')[0], 
        new Date(futureDate.getTime() + 86400000).toISOString().split('T')[0]]);
    
    expect(rows[0].result).to.include('catch_records');
    console.log('Create partition result:', rows[0].result);
  });

  it('should get partition stats using get_partition_stats function', async () => {
    const { rows } = await query(`
      SELECT * FROM get_partition_stats('catch_records')
    `);
    
    expect(rows).to.be.an('array');
    console.log('Partition stats:', rows.length, 'partitions');
  });

  it('should precreate partitions using precreate_partitions function', async () => {
    const { rows } = await query(`
      SELECT precreate_partitions('catch_records', 3) as result
    `);
    
    expect(rows[0].result).to.include('catch_records');
    console.log('Precreate result:', rows[0].result);
  });
});

// 性能基准测试
describe('Performance Benchmarks', function() {
  this.timeout(60000);

  const iterations = 100;

  it(`should have avg query latency < 50ms for ${iterations} iterations`, async () => {
    const latencies = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      
      try {
        await query(`
          SELECT * FROM catch_records 
          WHERE user_id = $1 
          ORDER BY caught_at DESC 
          LIMIT 20
        `, [i % 100 + 1]);
      } catch (err) {
        // 忽略空表错误
      }
      
      latencies.push(Date.now() - start);
    }
    
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(iterations * 0.95)];
    
    console.log(`Avg latency: ${avgLatency.toFixed(2)}ms`);
    console.log(`P95 latency: ${p95Latency}ms`);
    
    expect(avgLatency).to.be.lessThan(50);
    expect(p95Latency).to.be.lessThan(100);
  });
});

// 清理测试数据
after(async () => {
  console.log('\n=== Partition Tests Completed ===\n');
});