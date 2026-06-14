# REQ-00186: 精灵历史数据归档与冷热分离系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00186 |
| 标题 | 精灵历史数据归档与冷热分离系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、database、backend/jobs、backend/shared、infrastructure/k8s |
| 创建时间 | 2026-06-14 07:00 |

## 需求描述

随着游戏运营时间增长，精灵捕捉记录、战斗日志、交易历史等数据量持续膨胀，导致：
1. 主库查询性能下降，影响用户体验
2. 存储成本持续上升，缺乏有效管理
3. 历史数据访问需求（如玩家查看早期捕捉记录）与性能矛盾

本需求实现精灵历史数据的自动归档与冷热分离机制，将活跃数据保留在主库，历史数据归档至低成本存储，同时保证历史数据的可访问性。

### 核心目标
- 自动识别冷数据（超过 N 天未访问）
- 定期归档至对象存储（S3/OSS）
- 冷数据查询透明代理
- 降低主库存储成本 40%+
- 历史数据查询延迟 < 3s

## 技术方案

### 1. 冷热数据识别引擎

```javascript
// backend/shared/dataArchiver/ColdDataDetector.js
class ColdDataDetector {
  constructor(config) {
    this.thresholds = {
      catchRecords: { days: 90, minAccess: 0 },  // 90天未访问
      battleLogs: { days: 60, minAccess: 0 },    // 60天未访问
      tradeHistory: { days: 180, minAccess: 0 }, // 180天未访问
      pokemonStats: { days: 30, minAccess: 1 }   // 30天访问<1次
    };
  }

  async detectColdData(tableName, options = {}) {
    const threshold = this.thresholds[tableName];
    if (!threshold) return [];

    const query = `
      SELECT id, user_id, last_accessed_at
      FROM ${tableName}
      WHERE 
        last_accessed_at < NOW() - INTERVAL '${threshold.days} days'
        AND access_count <= ${threshold.minAccess}
        AND archived = false
      LIMIT $1
    `;

    const result = await db.query(query, [options.batchSize || 1000]);
    return result.rows;
  }

  async batchDetect(options = {}) {
    const results = {};
    for (const [table, threshold] of Object.entries(this.thresholds)) {
      results[table] = await this.detectColdData(table, options);
    }
    return results;
  }
}
```

### 2. 数据归档服务

```javascript
// backend/jobs/archiveWorker.js
const { Worker } = require('bullmq');
const S3Client = require('../shared/s3Client');
const ColdDataDetector = require('../shared/dataArchiver/ColdDataDetector');

const archiveWorker = new Worker('data-archive', async (job) => {
  const { tableName, records } = job.data;
  
  // 1. 导出数据为 JSON/Parquet
  const exportedData = await exportRecords(tableName, records);
  
  // 2. 上传至对象存储
  const archiveKey = `archives/${tableName}/${Date.now()}-${uuid()}.parquet`;
  await S3Client.upload(archiveKey, exportedData, {
    contentType: 'application/octet-stream',
    metadata: {
      tableName,
      recordCount: records.length,
      archivedAt: new Date().toISOString()
    }
  });
  
  // 3. 标记主库记录为已归档
  await markAsArchived(tableName, records, archiveKey);
  
  // 4. 删除主库冷数据（可选，根据配置）
  if (config.deleteAfterArchive) {
    await deleteArchivedRecords(tableName, records);
  }
  
  return { archived: records.length, archiveKey };
}, {
  concurrency: 3,
  limiter: { max: 100, duration: 60000 } // 每分钟最多100个任务
});

// 定时调度
schedule.scheduleJob('0 3 * * *', async () => {
  // 每天凌晨3点执行归档
  const detector = new ColdDataDetector();
  const coldData = await detector.batchDetect({ batchSize: 5000 });
  
  for (const [table, records] of Object.entries(coldData)) {
    if (records.length > 0) {
      await archiveQueue.add('archive', { tableName: table, records });
    }
  }
});
```

### 3. 冷数据查询代理

```javascript
// backend/shared/dataArchiver/ArchiveQueryProxy.js
class ArchiveQueryProxy {
  constructor() {
    this.cache = new LRUCache({ max: 1000, ttl: 300000 });
  }

  async query(tableName, userId, options = {}) {
    // 1. 先查主库热数据
    const hotData = await this.queryHotData(tableName, userId, options);
    
    // 2. 判断是否需要查询冷数据
    if (options.includeArchived && options.dateRange?.start) {
      const coldData = await this.queryColdData(tableName, userId, options);
      return this.mergeResults(hotData, coldData);
    }
    
    return hotData;
  }

  async queryColdData(tableName, userId, options) {
    // 1. 查询归档索引表获取归档文件列表
    const archives = await db.query(`
      SELECT archive_key, date_range_start, date_range_end
      FROM archive_index
      WHERE table_name = $1
        AND user_id = $2
        AND date_range_start <= $3
        AND date_range_end >= $4
    `, [tableName, userId, options.dateRange.end, options.dateRange.start]);

    // 2. 从 S3 加载归档数据
    const results = [];
    for (const archive of archives.rows) {
      const cacheKey = `${tableName}:${archive.archive_key}`;
      
      let data = this.cache.get(cacheKey);
      if (!data) {
        data = await S3Client.download(archive.archive_key);
        this.cache.set(cacheKey, data);
      }
      
      // 过滤用户数据
      results.push(...data.filter(r => r.user_id === userId));
    }

    return results;
  }
}
```

### 4. 归档索引管理

```sql
-- database/migrations/20260614_archive_index.sql
CREATE TABLE archive_index (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(100) NOT NULL,
  archive_key VARCHAR(255) NOT NULL UNIQUE,
  record_count INTEGER NOT NULL,
  date_range_start TIMESTAMP NOT NULL,
  date_range_end TIMESTAMP NOT NULL,
  archived_at TIMESTAMP DEFAULT NOW(),
  storage_size_bytes BIGINT,
  checksum VARCHAR(64),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_archive_table_date ON archive_index(table_name, date_range_start, date_range_end);
CREATE INDEX idx_archive_archived_at ON archive_index(archived_at);

-- 为需要归档的表添加归档标记字段
ALTER TABLE catch_records ADD COLUMN archived BOOLEAN DEFAULT FALSE;
ALTER TABLE catch_records ADD COLUMN archive_key VARCHAR(255);
ALTER TABLE catch_records ADD COLUMN last_accessed_at TIMESTAMP DEFAULT NOW();
ALTER TABLE catch_records ADD COLUMN access_count INTEGER DEFAULT 0;

CREATE INDEX idx_catch_archived ON catch_records(archived) WHERE archived = FALSE;
CREATE INDEX idx_catch_last_accessed ON catch_records(last_accessed_at) WHERE archived = FALSE;
```

### 5. 访问计数中间件

```javascript
// backend/shared/dataArchiver/accessTracker.js
const accessTrackerMiddleware = (tableName, idField = 'id') => {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    
    res.json = (data) => {
      // 异步更新访问计数，不阻塞响应
      if (data && data[idField]) {
        incrementAccessCount(tableName, data[idField]).catch(err => {
          logger.warn('Failed to update access count', { error: err.message });
        });
      }
      return originalJson(data);
    };
    
    next();
  };
};

async function incrementAccessCount(tableName, recordId) {
  await db.query(`
    UPDATE ${tableName}
    SET access_count = access_count + 1,
        last_accessed_at = NOW()
    WHERE id = $1 AND archived = FALSE
  `, [recordId]);
}
```

### 6. 归档恢复接口

```javascript
// backend/services/pokemon-service/src/routes/archive.js
router.post('/archive/restore', authenticate, authorize('admin'), async (req, res) => {
  const { tableName, archiveKey, userId } = req.body;
  
  // 1. 从 S3 下载归档数据
  const archivedData = await S3Client.download(archiveKey);
  
  // 2. 过滤指定用户数据（如果提供）
  const toRestore = userId 
    ? archivedData.filter(r => r.user_id === userId)
    : archivedData;
  
  // 3. 恢复到主库
  await db.transaction(async (trx) => {
    for (const record of toRestore) {
      await trx(tableName).insert({
        ...record,
        archived: false,
        archive_key: null,
        restored_at: new Date()
      }).onConflict('id').merge();
    }
  });
  
  res.json({ restored: toRestore.length });
});

router.get('/archive/stats', authenticate, async (req, res) => {
  const stats = await db.query(`
    SELECT 
      table_name,
      COUNT(*) as archive_count,
      SUM(record_count) as total_records,
      SUM(storage_size_bytes) as total_size_bytes,
      MAX(archived_at) as last_archive_time
    FROM archive_index
    GROUP BY table_name
    ORDER BY total_records DESC
  `);
  
  res.json(stats.rows);
});
```

### 7. 监控与告警

```javascript
// backend/shared/metrics/archiveMetrics.js
const archiveMetrics = {
  recordsArchived: new Counter({
    name: 'archive_records_total',
    help: 'Total number of records archived',
    labelNames: ['table_name']
  }),
  
  archiveLatency: new Histogram({
    name: 'archive_latency_seconds',
    help: 'Archive operation latency',
    labelNames: ['table_name'],
    buckets: [0.1, 0.5, 1, 2, 5, 10]
  }),
  
  coldQueryLatency: new Histogram({
    name: 'cold_query_latency_seconds',
    help: 'Cold data query latency',
    buckets: [0.5, 1, 2, 3, 5, 10]
  }),
  
  storageSaved: new Gauge({
    name: 'archive_storage_saved_bytes',
    help: 'Storage saved by archiving'
  })
};

// 定期上报存储节省量
setInterval(async () => {
  const result = await db.query(`
    SELECT COALESCE(SUM(storage_size_bytes), 0) as saved
    FROM archive_index
  `);
  archiveMetrics.storageSaved.set(result.rows[0].saved);
}, 60000);
```

## 验收标准

- [ ] 冷数据自动识别准确率 ≥ 95%（基于访问模式）
- [ ] 归档任务每日定时执行，失败自动重试
- [ ] 归档后主库存储成本降低 ≥ 40%
- [ ] 冷数据查询延迟 < 3s（P95）
- [ ] 归档数据完整性校验通过率 100%
- [ ] 归档恢复接口支持单用户/全量恢复
- [ ] 监控指标覆盖归档量、延迟、存储节省
- [ ] 访问计数中间件正确更新 last_accessed_at
- [ ] 归档索引表支持按时间范围快速检索
- [ ] S3 归档文件支持 Parquet 格式压缩

## 影响范围

- **数据库**
  - 新增 `archive_index` 表
  - `catch_records`、`battle_logs`、`trade_history` 表添加归档字段
  
- **后端服务**
  - `pokemon-service`：新增归档查询、恢复接口
  - `user-service`：用户数据归档管理
  - `backend/jobs`：新增 `archiveWorker.js` 定时任务
  
- **共享模块**
  - 新增 `backend/shared/dataArchiver/` 目录
  - `ColdDataDetector.js`、`ArchiveQueryProxy.js`、`accessTracker.js`
  
- **基础设施**
  - S3/OSS 对象存储配置
  - K8s CronJob 调度归档任务

## 参考

- [PostgreSQL Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [AWS S3 Glacier for Cold Storage](https://aws.amazon.com/s3/storage-classes/glacier/)
- [Apache Parquet Columnar Format](https://parquet.apache.org/)
- [数据生命周期管理最佳实践](https://www.postgresql.org/docs/current/maintenance.html)
