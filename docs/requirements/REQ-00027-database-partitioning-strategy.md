# REQ-00027: 游戏数据分区策略与自动化分区管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00027 |
| 标题 | 游戏数据分区策略与自动化分区管理系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database、player-service、catch-service、battle-service、trade-service、monitoring、admin-dashboard |
| 创建时间 | 2026-07-03 02:00 |

## 需求描述

随着游戏用户增长，核心业务表（玩家数据、精灵捕捉记录、战斗日志、交易记录等）数据量急剧膨胀，导致查询性能下降、索引维护成本上升、备份恢复时间过长。

**核心问题：**
1. 单表数据量超过 5000 万行，查询延迟显著增加
2. 热数据和冷数据混合存储，缓存命中率低
3. 历史数据清理效率低下，影响数据库性能
4. 跨时间范围查询性能差（如查询玩家近 30 天战斗记录）
5. 数据备份和恢复时间过长，影响业务连续性

**目标：**
- 实现核心业务表的自动化分区管理
- 热数据与冷数据分离存储
- 分区自动创建、归档、删除
- 查询性能提升 60%+
- 备份恢复时间减少 70%+

## 技术方案

### 1. 分区策略设计

#### 1.1 分区表识别与分类

```typescript
// shared/database-partition/src/partition-strategy.ts

export enum PartitionType {
  RANGE = 'RANGE',           // 范围分区（时间）
  HASH = 'HASH',             // 哈希分区（均匀分布）
  LIST = 'LIST',             // 列表分区（地区/类型）
  COMPOSITE = 'COMPOSITE'    // 复合分区
}

export enum DataTemperature {
  HOT = 'hot',     // 近 7 天数据，高频访问
  WARM = 'warm',   // 7-30 天数据，中频访问
  COLD = 'cold'    // 30 天以上数据，低频访问
}

export interface PartitionConfig {
  tableName: string;
  partitionType: PartitionType;
  partitionKey: string;
  subPartitionKey?: string;
  interval: string;           // '1 day' | '1 month' | '1 year'
  retentionDays: number;      // 数据保留天数
  archiveEnabled: boolean;    // 是否归档冷数据
  archiveTarget?: string;     // 归档目标（S3/Glacier）
  compressionEnabled: boolean;
  indexes: PartitionIndex[];
}

export interface PartitionIndex {
  name: string;
  columns: string[];
  type: 'btree' | 'hash' | 'gin' | 'gist';
  unique: boolean;
}

// 核心业务表分区配置
export const PARTITION_CONFIGS: PartitionConfig[] = [
  {
    tableName: 'catch_records',
    partitionType: PartitionType.RANGE,
    partitionKey: 'caught_at',
    interval: '1 day',
    retentionDays: 365,
    archiveEnabled: true,
    archiveTarget: 's3://minego-archive/catch-records/',
    compressionEnabled: true,
    indexes: [
      { name: 'idx_player_id', columns: ['player_id'], type: 'btree', unique: false },
      { name: 'idx_species_id', columns: ['species_id'], type: 'btree', unique: false },
      { name: 'idx_location', columns: ['latitude', 'longitude'], type: 'gist', unique: false }
    ]
  },
  {
    tableName: 'battle_logs',
    partitionType: PartitionType.RANGE,
    partitionKey: 'battle_at',
    interval: '1 day',
    retentionDays: 90,
    archiveEnabled: true,
    archiveTarget: 's3://minego-archive/battle-logs/',
    compressionEnabled: true,
    indexes: [
      { name: 'idx_battle_player', columns: ['player_id', 'battle_at'], type: 'btree', unique: false },
      { name: 'idx_battle_type', columns: ['battle_type', 'result'], type: 'btree', unique: false }
    ]
  },
  {
    tableName: 'trade_records',
    partitionType: PartitionType.RANGE,
    partitionKey: 'traded_at',
    interval: '1 month',
    retentionDays: 365,
    archiveEnabled: true,
    archiveTarget: 's3://minego-archive/trade-records/',
    compressionEnabled: true,
    indexes: [
      { name: 'idx_trade_player', columns: ['seller_id', 'buyer_id'], type: 'btree', unique: false },
      { name: 'idx_trade_status', columns: ['status', 'traded_at'], type: 'btree', unique: false }
    ]
  },
  {
    tableName: 'player_sessions',
    partitionType: PartitionType.RANGE,
    partitionKey: 'login_at',
    interval: '1 day',
    retentionDays: 30,
    archiveEnabled: false,
    compressionEnabled: true,
    indexes: [
      { name: 'idx_session_player', columns: ['player_id', 'login_at'], type: 'btree', unique: false },
      { name: 'idx_session_device', columns: ['device_id'], type: 'hash', unique: false }
    ]
  },
  {
    tableName: 'payment_transactions',
    partitionType: PartitionType.RANGE,
    partitionKey: 'transaction_at',
    interval: '1 month',
    retentionDays: 2555, // 7年（财务合规要求）
    archiveEnabled: true,
    archiveTarget: 's3://minego-archive/payments/',
    compressionEnabled: true,
    indexes: [
      { name: 'idx_payment_player', columns: ['player_id', 'transaction_at'], type: 'btree', unique: false },
      { name: 'idx_payment_status', columns: ['status'], type: 'btree', unique: false }
    ]
  },
  {
    tableName: 'player_activities',
    partitionType: PartitionType.COMPOSITE,
    partitionKey: 'activity_date',
    subPartitionKey: 'player_id',
    interval: '1 month',
    retentionDays: 180,
    archiveEnabled: true,
    archiveTarget: 's3://minego-archive/activities/',
    compressionEnabled: true,
    indexes: [
      { name: 'idx_activity_player', columns: ['player_id', 'activity_date'], type: 'btree', unique: false },
      { name: 'idx_activity_type', columns: ['activity_type'], type: 'btree', unique: false }
    ]
  }
];
```

#### 1.2 分区创建引擎

```typescript
// shared/database-partition/src/partition-manager.ts

import { Pool } from 'pg';
import { PartitionConfig, PARTITION_CONFIGS } from './partition-strategy';
import { Logger } from '@minego/logger';
import { MetricsCollector } from '@minego/monitoring';

export class PartitionManager {
  private logger: Logger;
  private metrics: MetricsCollector;

  constructor(
    private db: Pool,
    private config: PartitionConfig
  ) {
    this.logger = new Logger('PartitionManager');
    this.metrics = new MetricsCollector('partition_manager');
  }

  /**
   * 初始化分区表
   */
  async initializePartitionedTable(): Promise<void> {
    const { tableName, partitionKey, partitionType } = this.config;

    this.logger.info('Initializing partitioned table', { tableName, partitionType });

    // 检查表是否已分区
    const isPartitioned = await this.checkTablePartitioned(tableName);
    if (isPartitioned) {
      this.logger.info('Table already partitioned', { tableName });
      return;
    }

    // 创建分区表（PostgreSQL 语法）
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        LIKE ${tableName}_template INCLUDING ALL
      ) PARTITION BY RANGE (${partitionKey});
    `);

    // 创建默认分区（防止数据丢失）
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${tableName}_default 
      PARTITION OF ${tableName} DEFAULT;
    `);

    this.metrics.increment('partition_table_created', { table: tableName });
  }

  /**
   * 预创建未来分区（提前 7 天）
   */
  async precreatePartitions(): Promise<void> {
    const { tableName, interval } = this.config;
    
    for (let i = 0; i < 7; i++) {
      const partitionDate = this.getPartitionDate(i);
      const partitionName = `${tableName}_${partitionDate.replace(/-/g, '_')}`;
      
      const exists = await this.checkPartitionExists(partitionName);
      if (!exists) {
        await this.createPartition(partitionDate);
        this.logger.info('Partition created', { partitionName });
      }
    }
  }

  /**
   * 创建单个分区
   */
  private async createPartition(partitionDate: string): Promise<void> {
    const { tableName, partitionKey, interval } = this.config;
    const partitionName = `${tableName}_${partitionDate.replace(/-/g, '_')}`;
    
    const { startDate, endDate } = this.getPartitionRange(partitionDate, interval);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${partitionName}
      PARTITION OF ${tableName}
      FOR VALUES FROM ('${startDate}') TO ('${endDate}');
    `);

    // 创建局部索引
    await this.createPartitionIndexes(partitionName);

    this.metrics.increment('partition_created', { table: tableName });
  }

  /**
   * 创建分区索引
   */
  private async createPartitionIndexes(partitionName: string): Promise<void> {
    for (const index of this.config.indexes) {
      const indexName = `${partitionName}_${index.name}`;
      
      await this.db.query(`
        CREATE ${index.unique ? 'UNIQUE' : ''} INDEX IF NOT EXISTS ${indexName}
        ON ${partitionName}
        USING ${index.type} (${index.columns.join(', ')});
      `);
    }
  }

  /**
   * 归档冷数据
   */
  async archiveColdPartitions(): Promise<ArchiveResult> {
    const { tableName, retentionDays, archiveEnabled, archiveTarget } = this.config;

    if (!archiveEnabled || !archiveTarget) {
      return { archived: 0, size: 0 };
    }

    const coldPartitions = await this.getColdPartitions(retentionDays);
    let totalArchived = 0;
    let totalSize = 0;

    for (const partition of coldPartitions) {
      this.logger.info('Archiving cold partition', { partition: partition.name });

      // 导出分区数据到 S3
      const exportPath = `${archiveTarget}${partition.name}.parquet`;
      await this.exportPartitionToS3(partition.name, exportPath);

      // 验证数据完整性
      const verified = await this.verifyArchive(partition.name, exportPath);
      if (!verified) {
        throw new Error(`Archive verification failed for ${partition.name}`);
      }

      // 记录归档元数据
      await this.recordArchiveMetadata(partition.name, exportPath, partition.rowCount);

      // 删除已归档分区
      await this.db.query(`DROP TABLE IF EXISTS ${partition.name};`);

      totalArchived += partition.rowCount;
      totalSize += partition.size;

      this.metrics.increment('partition_archived', { table: tableName });
    }

    return { archived: totalArchived, size: totalSize };
  }

  /**
   * 导出分区到 S3（Parquet 格式）
   */
  private async exportPartitionToS3(partitionName: string, s3Path: string): Promise<void> {
    // 使用 PostgreSQL COPY 命令导出
    const tempFile = `/tmp/${partitionName}.csv`;
    
    await this.db.query(`
      COPY ${partitionName} TO '${tempFile}' 
      WITH (FORMAT CSV, HEADER true, DELIMITER ',');
    `);

    // 转换为 Parquet 并上传（使用 DuckDB）
    await this.convertToParquetAndUpload(tempFile, s3Path);

    // 清理临时文件
    await this.cleanup([tempFile]);
  }

  /**
   * 从归档恢复数据（用于查询历史数据）
   */
  async restoreFromArchive(partitionName: string): Promise<void> {
    const metadata = await this.getArchiveMetadata(partitionName);
    if (!metadata) {
      throw new Error(`No archive metadata found for ${partitionName}`);
    }

    // 下载 Parquet 文件
    const tempFile = await this.downloadFromS3(metadata.s3Path);

    // 导入到临时表
    await this.importParquetToTempTable(tempFile, partitionName);

    // 创建分区并导入数据
    const partitionDate = this.extractDateFromPartitionName(partitionName);
    await this.createPartition(partitionDate);
    
    await this.db.query(`
      INSERT INTO ${partitionName}
      SELECT * FROM temp_${partitionName};
    `);

    this.logger.info('Partition restored from archive', { partitionName });
  }

  /**
   * 获取分区统计信息
   */
  async getPartitionStats(): Promise<PartitionStats> {
    const stats = await this.db.query(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
        pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes,
        (SELECT count(*) FROM pg_stat_user_tables WHERE relname = tablename) AS row_count
      FROM pg_tables
      WHERE tablename LIKE '${this.config.tableName}_%'
      ORDER BY tablename;
    `);

    return {
      table: this.config.tableName,
      partitions: stats.rows.map(row => ({
        name: row.tablename,
        size: row.size,
        sizeBytes: row.size_bytes,
        rowCount: row.row_count
      }))
    };
  }

  private async checkTablePartitioned(tableName: string): Promise<boolean> {
    const result = await this.db.query(`
      SELECT relkind 
      FROM pg_class 
      WHERE relname = $1;
    `, [tableName]);

    return result.rows[0]?.relkind === 'p';
  }

  private async checkPartitionExists(partitionName: string): Promise<boolean> {
    const result = await this.db.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE tablename = $1
      );
    `, [partitionName]);

    return result.rows[0].exists;
  }

  private getPartitionDate(daysFromNow: number): string {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    return date.toISOString().split('T')[0];
  }

  private getPartitionRange(date: string, interval: string): { startDate: string; endDate: string } {
    const startDate = new Date(date);
    const endDate = new Date(startDate);

    if (interval === '1 day') {
      endDate.setDate(endDate.getDate() + 1);
    } else if (interval === '1 month') {
      endDate.setMonth(endDate.getMonth() + 1);
    } else if (interval === '1 year') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    }

    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString()
    };
  }

  private async getColdPartitions(retentionDays: number): Promise<PartitionInfo[]> {
    const coldDate = new Date();
    coldDate.setDate(coldDate.getDate() - retentionDays);
    const coldDateStr = coldDate.toISOString().split('T')[0].replace(/-/g, '_');

    const result = await this.db.query(`
      SELECT 
        tablename AS name,
        pg_total_relation_size(schemaname||'.'||tablename) AS size,
        (SELECT count(*) FROM ${this.config.tableName}) AS row_count
      FROM pg_tables
      WHERE tablename LIKE '${this.config.tableName}_%'
        AND tablename < '${this.config.tableName}_${coldDateStr}'
        AND tablename != '${this.config.tableName}_default'
      ORDER BY tablename;
    `);

    return result.rows;
  }
}
```

### 2. 数据温度分层存储

```typescript
// shared/database-partition/src/temperature-manager.ts

import { Pool } from 'pg';
import Redis from 'ioredis';

export class DataTemperatureManager {
  private hotCache: Redis;
  private warmCache: Redis;

  constructor(
    private db: Pool,
    hotRedisConfig: RedisConfig,
    warmRedisConfig: RedisConfig
  ) {
    this.hotCache = new Redis(hotRedisConfig);
    this.warmCache = new Redis(warmRedisConfig);
  }

  /**
   * 智能查询路由（根据数据温度选择存储）
   */
  async queryWithTemperatureRouting<T>(
    query: string,
    params: any[],
    dateField: string,
    dateValue: Date
  ): Promise<T[]> {
    const temperature = this.calculateTemperature(dateValue);

    switch (temperature) {
      case 'hot':
        // 热数据：优先缓存，其次主库
        return this.queryHotData(query, params);
      
      case 'warm':
        // 温数据：使用只读副本
        return this.queryWarmData(query, params);
      
      case 'cold':
        // 冷数据：按需恢复或直接查询归档
        return this.queryColdData(query, params);
    }
  }

  /**
   * 查询热数据（缓存优先）
   */
  private async queryHotData<T>(query: string, params: any[]): Promise<T[]> {
    const cacheKey = this.generateCacheKey(query, params);
    
    // 尝试从缓存获取
    const cached = await this.hotCache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // 从主库查询
    const result = await this.db.query(query, params);
    
    // 写入缓存（TTL: 5分钟）
    await this.hotCache.setex(cacheKey, 300, JSON.stringify(result.rows));
    
    return result.rows;
  }

  /**
   * 查询温数据（只读副本）
   */
  private async queryWarmData<T>(query: string, params: any[]): Promise<T[]> {
    // 使用只读副本连接
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 查询冷数据（归档）
   */
  private async queryColdData<T>(query: string, params: any[]): Promise<T[]> {
    // 解析查询中的时间范围
    const dateRange = this.extractDateRange(query);
    
    // 确定需要恢复的分区
    const partitions = await this.identifyPartitionsForDateRange(dateRange);
    
    // 按需恢复分区
    for (const partition of partitions) {
      if (!await this.isPartitionAvailable(partition)) {
        await this.restorePartitionFromArchive(partition);
      }
    }

    // 执行查询
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 计算数据温度
   */
  private calculateTemperature(date: Date): DataTemperature {
    const now = new Date();
    const ageInDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);

    if (ageInDays <= 7) return 'hot';
    if (ageInDays <= 30) return 'warm';
    return 'cold';
  }

  /**
   * 数据温度统计
   */
  async getTemperatureStats(tableName: string): Promise<TemperatureStats> {
    const hotCount = await this.db.query(`
      SELECT count(*) FROM ${tableName}
      WHERE created_at > NOW() - INTERVAL '7 days';
    `);

    const warmCount = await this.db.query(`
      SELECT count(*) FROM ${tableName}
      WHERE created_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '7 days';
    `);

    const coldCount = await this.db.query(`
      SELECT count(*) FROM ${tableName}
      WHERE created_at < NOW() - INTERVAL '30 days';
    `);

    return {
      hot: parseInt(hotCount.rows[0].count),
      warm: parseInt(warmCount.rows[0].count),
      cold: parseInt(coldCount.rows[0].count)
    };
  }
}
```

### 3. 分区自动化调度系统

```typescript
// shared/database-partition/src/scheduler.ts

import { CronJob } from 'cron';
import { PartitionManager } from './partition-manager';
import { Logger } from '@minego/logger';
import { AlertManager } from '@minego/monitoring';

export class PartitionScheduler {
  private logger: Logger;
  private alertManager: AlertManager;
  private managers: Map<string, PartitionManager>;

  constructor() {
    this.logger = new Logger('PartitionScheduler');
    this.alertManager = new AlertManager();
    this.managers = new Map();
  }

  /**
   * 启动定时任务
   */
  start(): void {
    // 每天凌晨 2:00 预创建分区
    new CronJob('0 2 * * *', async () => {
      await this.executeWithAlert('precreate', async () => {
        for (const [tableName, manager] of this.managers) {
          await manager.precreatePartitions();
        }
      });
    }, null, true, 'UTC');

    // 每天凌晨 3:00 归档冷数据
    new CronJob('0 3 * * *', async () => {
      await this.executeWithAlert('archive', async () => {
        for (const [tableName, manager] of this.managers) {
          const result = await manager.archiveColdPartitions();
          this.logger.info('Archive completed', { 
            table: tableName, 
            archived: result.archived,
            size: result.size 
          });
        }
      });
    }, null, true, 'UTC');

    // 每小时检查分区健康状态
    new CronJob('0 * * * *', async () => {
      await this.executeWithAlert('health-check', async () => {
        for (const [tableName, manager] of this.managers) {
          const stats = await manager.getPartitionStats();
          await this.checkPartitionHealth(tableName, stats);
        }
      });
    }, null, true, 'UTC');

    this.logger.info('Partition scheduler started');
  }

  /**
   * 分区健康检查
   */
  private async checkPartitionHealth(tableName: string, stats: PartitionStats): Promise<void> {
    // 检查默认分区数据量（应该为 0）
    const defaultPartition = stats.partitions.find(p => p.name.includes('default'));
    if (defaultPartition && defaultPartition.rowCount > 1000) {
      await this.alertManager.sendAlert({
        level: 'warning',
        title: 'Default partition has data',
        message: `Table ${tableName} default partition has ${defaultPartition.rowCount} rows`,
        tags: { table: tableName }
      });
    }

    // 检查分区数量
    if (stats.partitions.length > 365) {
      await this.alertManager.sendAlert({
        level: 'info',
        title: 'Many partitions exist',
        message: `Table ${tableName} has ${stats.partitions.length} partitions`,
        tags: { table: tableName }
      });
    }
  }

  private async executeWithAlert(task: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error('Scheduled task failed', { task, error });
      await this.alertManager.sendAlert({
        level: 'critical',
        title: `Partition task failed: ${task}`,
        message: error.message,
        tags: { task }
      });
    }
  }
}
```

### 4. 分区监控与告警

```typescript
// shared/database-partition/src/monitoring.ts

import { Registry, Gauge, Counter, Histogram } from 'prom-client';

export class PartitionMonitoring {
  private registry: Registry;

  private partitionCountGauge: Gauge<string>;
  private partitionSizeGauge: Gauge<string>;
  private archiveCounter: Counter<string>;
  private queryLatencyHistogram: Histogram<string>;

  constructor() {
    this.registry = new Registry();

    this.partitionCountGauge = new Gauge({
      name: 'partition_count',
      help: 'Number of partitions per table',
      labelNames: ['table'],
      registers: [this.registry]
    });

    this.partitionSizeGauge = new Gauge({
      name: 'partition_size_bytes',
      help: 'Size of each partition in bytes',
      labelNames: ['table', 'partition'],
      registers: [this.registry]
    });

    this.archiveCounter = new Counter({
      name: 'partition_archive_total',
      help: 'Total number of archived partitions',
      labelNames: ['table'],
      registers: [this.registry]
    });

    this.queryLatencyHistogram = new Histogram({
      name: 'partition_query_duration_seconds',
      help: 'Query latency by temperature',
      labelNames: ['table', 'temperature'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry]
    });
  }

  /**
   * 更新分区指标
   */
  async updateMetrics(stats: PartitionStats): Promise<void> {
    this.partitionCountGauge.set({ table: stats.table }, stats.partitions.length);

    for (const partition of stats.partitions) {
      this.partitionSizeGauge.set(
        { table: stats.table, partition: partition.name },
        partition.sizeBytes
      );
    }
  }

  /**
   * 记录查询延迟
   */
  recordQueryLatency(table: string, temperature: DataTemperature, duration: number): void {
    this.queryLatencyHistogram.observe(
      { table, temperature },
      duration / 1000
    );
  }

  getRegistry(): Registry {
    return this.registry;
  }
}
```

### 5. 管理后台 API

```typescript
// admin-dashboard/src/api/partition.controller.ts

import { Router } from 'express';
import { PartitionManager, PARTITION_CONFIGS } from '@minego/database-partition';

export class PartitionController {
  private managers: Map<string, PartitionManager>;

  constructor() {
    this.managers = new Map();
    // 初始化各表的分区管理器
    for (const config of PARTITION_CONFIGS) {
      this.managers.set(config.tableName, new PartitionManager(db, config));
    }
  }

  /**
   * 获取所有表的分区统计
   * GET /api/partitions/stats
   */
  async getAllStats(req: Request, res: Response): Promise<void> {
    const allStats = {};

    for (const [tableName, manager] of this.managers) {
      allStats[tableName] = await manager.getPartitionStats();
    }

    res.json(allStats);
  }

  /**
   * 手动触发分区预创建
   * POST /api/partitions/:table/precreate
   */
  async precreatePartitions(req: Request, res: Response): Promise<void> {
    const { table } = req.params;
    const manager = this.managers.get(table);

    if (!manager) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    await manager.precreatePartitions();
    res.json({ success: true });
  }

  /**
   * 手动触发归档
   * POST /api/partitions/:table/archive
   */
  async archivePartitions(req: Request, res: Response): Promise<void> {
    const { table } = req.params;
    const manager = this.managers.get(table);

    if (!manager) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    const result = await manager.archiveColdPartitions();
    res.json(result);
  }

  /**
   * 从归档恢复分区
   * POST /api/partitions/:table/restore
   */
  async restorePartition(req: Request, res: Response): Promise<void> {
    const { table } = req.params;
    const { partitionName } = req.body;
    const manager = this.managers.get(table);

    if (!manager) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    await manager.restoreFromArchive(partitionName);
    res.json({ success: true });
  }

  /**
   * 获取数据温度分布
   * GET /api/partitions/:table/temperature
   */
  async getTemperatureDistribution(req: Request, res: Response): Promise<void> {
    const { table } = req.params;
    const tempManager = new DataTemperatureManager(db, hotRedisConfig, warmRedisConfig);
    const stats = await tempManager.getTemperatureStats(table);
    res.json(stats);
  }
}
```

### 6. 数据库迁移脚本

```sql
-- migrations/000_partition_tables.sql

-- 捕捉记录表分区
CREATE TABLE IF NOT EXISTS catch_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL,
  species_id INTEGER NOT NULL,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  caught_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ball_type VARCHAR(50),
  capture_rate DECIMAL(5, 2),
  flee_attempts INTEGER DEFAULT 0,
  metadata JSONB
) PARTITION BY RANGE (caught_at);

-- 为现有数据创建分区
CREATE TABLE catch_records_2026_01 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE catch_records_2026_02 
  PARTITION OF catch_records 
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- 战斗日志表分区
CREATE TABLE IF NOT EXISTS battle_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL,
  opponent_id UUID,
  battle_type VARCHAR(50) NOT NULL,
  result VARCHAR(20) NOT NULL,
  battle_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  duration_seconds INTEGER,
  damage_dealt INTEGER,
  damage_taken INTEGER,
  rewards JSONB,
  metadata JSONB
) PARTITION BY RANGE (battle_at);

-- 交易记录表分区
CREATE TABLE IF NOT EXISTS trade_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  buyer_id UUID,
  species_id INTEGER NOT NULL,
  price INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  traded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  commission_rate DECIMAL(5, 2) DEFAULT 0.05,
  metadata JSONB
) PARTITION BY RANGE (traded_at);

-- 创建默认分区（防止数据丢失）
CREATE TABLE catch_records_default PARTITION OF catch_records DEFAULT;
CREATE TABLE battle_logs_default PARTITION OF battle_logs DEFAULT;
CREATE TABLE trade_records_default PARTITION OF trade_records DEFAULT;

-- 创建索引
CREATE INDEX idx_catch_player ON catch_records(player_id, caught_at);
CREATE INDEX idx_battle_player ON battle_logs(player_id, battle_at);
CREATE INDEX idx_trade_player ON trade_records(seller_id, buyer_id, traded_at);

-- 分区管理函数
CREATE OR REPLACE FUNCTION create_partition(
  table_name TEXT,
  partition_date DATE,
  interval_days INTEGER DEFAULT 1
) RETURNS VOID AS $$
DECLARE
  partition_name TEXT;
  start_date TIMESTAMP;
  end_date TIMESTAMP;
BEGIN
  partition_name := table_name || '_' || to_char(partition_date, 'YYYY_MM_DD');
  start_date := partition_date::TIMESTAMP;
  end_date := (partition_date + interval_days * INTERVAL '1 day')::TIMESTAMP;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    table_name,
    start_date,
    end_date
  );
END;
$$ LANGUAGE plpgsql;

-- 自动创建分区触发器
CREATE OR REPLACE FUNCTION auto_create_partition()
RETURNS TRIGGER AS $$
BEGIN
  -- 如果插入的数据在未来 7 天内，自动创建分区
  IF NEW.caught_at > NOW() - INTERVAL '7 days' THEN
    PERFORM create_partition('catch_records', NEW.caught_at::DATE);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 归档统计视图
CREATE VIEW partition_stats AS
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
  pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
FROM pg_tables
WHERE tablename LIKE '%_%'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

### 7. 性能测试与验证

```typescript
// tests/partition-performance.test.ts

import { PerformanceTester } from '@minego/testing';

describe('Partition Performance', () => {
  let tester: PerformanceTester;

  beforeAll(() => {
    tester = new PerformanceTester();
  });

  test('Hot data query latency < 50ms', async () => {
    const query = `
      SELECT * FROM catch_records 
      WHERE player_id = $1 AND caught_at > NOW() - INTERVAL '1 day'
      LIMIT 100;
    `;

    const latency = await tester.measureQueryLatency(query, [playerId], 1000);
    expect(latency.p95).toBeLessThan(50);
  });

  test('Warm data query latency < 100ms', async () => {
    const query = `
      SELECT * FROM catch_records 
      WHERE player_id = $1 AND caught_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      LIMIT 100;
    `;

    const latency = await tester.measureQueryLatency(query, [playerId], 1000);
    expect(latency.p95).toBeLessThan(100);
  });

  test('Archive and restore performance', async () => {
    const partitionName = 'catch_records_2025_01_01';
    
    // 归档性能
    const archiveStart = Date.now();
    await manager.archiveColdPartitions();
    const archiveDuration = Date.now() - archiveStart;
    
    // 恢复性能
    const restoreStart = Date.now();
    await manager.restoreFromArchive(partitionName);
    const restoreDuration = Date.now() - restoreStart;

    console.log(`Archive: ${archiveDuration}ms, Restore: ${restoreDuration}ms`);
    expect(archiveDuration).toBeLessThan(60000); // < 1分钟
    expect(restoreDuration).toBeLessThan(30000); // < 30秒
  });

  test('Partition pruning effectiveness', async () => {
    // 验证分区剪枝是否生效
    const explainResult = await db.query(`
      EXPLAIN ANALYZE 
      SELECT * FROM catch_records 
      WHERE caught_at = '2026-01-15';
    `);

    const plan = explainResult.rows[0]['QUERY PLAN'];
    expect(plan).toContain('Partition'); // 确认使用了分区
    expect(plan).not.toContain('Seq Scan'); // 不应该全表扫描
  });
});
```

## 验收标准

- [ ] 核心业务表实现自动分区（catch_records、battle_logs、trade_records、payment_transactions）
- [ ] 分区预创建功能正常（提前 7 天创建）
- [ ] 冷数据自动归档到 S3（Parquet 格式，压缩率 > 70%）
- [ ] 归档数据可按需恢复，恢复时间 < 30秒
- [ ] 热数据查询延迟 < 50ms（P95）
- [ ] 温数据查询延迟 < 100ms（P95）
- [ ] 数据备份时间减少 > 70%
- [ ] 监控指标完整（分区数量、大小、归档次数、查询延迟）
- [ ] 管理后台可查看分区状态和手动触发操作
- [ ] 告警规则配置完成（默认分区数据、归档失败等）
- [ ] 数据完整性验证通过（归档前后数据一致）
- [ ] 文档完善（分区策略、运维手册、故障恢复指南）

## 影响范围

- **数据库**：核心业务表结构调整（分区表创建）
- **player-service**：查询路由适配
- **catch-service**：捕捉记录查询优化
- **battle-service**：战斗日志查询优化
- **trade-service**：交易记录查询优化
- **monitoring**：新增分区监控指标和告警
- **admin-dashboard**：新增分区管理界面

## 参考

- [PostgreSQL Partitioning Documentation](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [TimescaleDB Hypertables](https://docs.timescale.com/timescaledb/latest/how-to-guides/hypertables/)
- [AWS S3 Glacier Storage Classes](https://aws.amazon.com/s3/storage-classes/glacier/)
- [Apache Parquet Format](https://parquet.apache.org/docs/)
- [Database Partitioning Best Practices](https://use-the-index-luke.com/sql/partitioning)
