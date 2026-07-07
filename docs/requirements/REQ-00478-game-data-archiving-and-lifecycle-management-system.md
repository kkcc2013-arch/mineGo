# REQ-00478：游戏数据归档与生命周期管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00478 |
| 标题 | 游戏数据归档与生命周期管理系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database-service、user-service、catch-service、reward-service、backend/jobs、admin-dashboard |
| 创建时间 | 2026-07-07 09:00 UTC |
| 依赖需求 | REQ-00025（数据库备份与灾备）、REQ-00027（数据分区策略） |

## 1. 背景与问题

mineGo 项目已运行数月，积累了大量游戏数据，但缺少系统化的数据归档与生命周期管理机制：

### 1.1 数据增长现状
- **捕捉记录表**：日均新增约 50 万条，已累计 9000 万+ 条记录
- **精灵位置刷新表**：日均新增 20 万条，已累计 3600 万+ 条记录
- **战斗日志表**：日均新增 30 万条，已累计 5400 万+ 条记录
- **奖励发放记录表**：日均新增 40 万条，已累计 7200 万+ 条记录
- **用户登录日志表**：日均新增 10 万条，已累计 1800 万+ 条记录

### 1.2 问题与风险
1. **存储成本激增**：活跃数据占比不到 20%，但全部存储在高性能 SSD 上
2. **查询性能下降**：大表查询越来越慢，影响用户体验
3. **备份效率低**：全量备份时间长，增量备份链过长
4. **合规风险**：GDPR/个人信息保护法要求超过保存期限的数据应删除
5. **数据分析困难**：历史数据与实时数据混杂，影响分析准确性

### 1.3 代码现状
- `database/pending/` 有分区策略（REQ-00027）但未完整实现归档
- `backend/jobs/` 有 `cleanupJobs.js` 但仅清理临时数据
- 缺少数据生命周期策略配置系统
- 缺少归档数据查询接口
- 缺少自动化归档任务调度

## 2. 目标

建立完整的游戏数据归档与生命周期管理系统：

1. **自动化归档**：根据数据访问模式自动归档冷数据
2. **分层存储**：热数据（SSD）、温数据（标准磁盘）、冷数据（对象存储）
3. **合规清理**：超过保留期限的数据自动清理
4. **归档查询**：提供归档数据查询接口（虽慢但可用）
5. **成本优化**：预计降低存储成本 40-60%
6. **性能提升**：活跃数据表查询速度提升 30-50%

## 3. 范围

### 包含
- 数据生命周期策略配置系统
- 冷热数据识别与迁移引擎
- 多层存储管理（PostgreSQL + 对象存储）
- 归档任务调度与执行
- 归档数据查询 API
- 数据清理与合规审计
- 管理后台归档策略配置界面
- 归档监控与告警

### 不包含
- 实时数据备份（REQ-00025 已实现）
- 数据分区策略（REQ-00027 已实现）
- 数据加密（已有 KMS 系统）
- 跨区域数据复制（未来需求）

## 4. 详细需求

### 4.1 数据生命周期策略

```javascript
// backend/shared/DataLifecyclePolicy.js
const DATA_LIFECYCLE_POLICIES = {
  // 捕捉记录：活跃期 90 天，归档 1 年，删除
  catch_records: {
    tableName: 'catch_records',
    hotDays: 90,          // 热数据：最近 90 天
    warmDays: 365,        // 温数据：90-365 天
    archiveDays: 730,     // 归档：1-2 年
    deleteAfter: 730,     // 2 年后删除
    partitionBy: 'created_at',
    archiveTarget: 's3',  // 归档到对象存储
    compression: 'gzip',
    queryPriority: 'low'  // 归档数据查询优先级低
  },
  
  // 精灵刷新记录：活跃期 30 天，归档 6 个月，删除
  pokemon_spawns: {
    tableName: 'pokemon_spawns',
    hotDays: 30,
    warmDays: 180,
    archiveDays: 365,
    deleteAfter: 365,
    partitionBy: 'spawn_time',
    archiveTarget: 's3',
    compression: 'parquet',  // 列式存储，适合分析
    queryPriority: 'low'
  },
  
  // 战斗日志：活跃期 60 天，归档 1 年
  battle_logs: {
    tableName: 'battle_logs',
    hotDays: 60,
    warmDays: 365,
    archiveDays: 730,
    deleteAfter: 730,
    partitionBy: 'battle_time',
    archiveTarget: 's3',
    compression: 'gzip',
    queryPriority: 'medium'
  },
  
  // 奖励记录：活跃期 180 天，归档 2 年
  reward_records: {
    tableName: 'reward_records',
    hotDays: 180,
    warmDays: 730,
    archiveDays: 1095,     // 3 年
    deleteAfter: 1095,
    partitionBy: 'created_at',
    archiveTarget: 's3',
    compression: 'gzip',
    queryPriority: 'medium'
  },
  
  // 用户登录日志：活跃期 30 天，归档 1 年，GDPR 要求可删除
  user_login_logs: {
    tableName: 'user_login_logs',
    hotDays: 30,
    warmDays: 365,
    archiveDays: 365,
    deleteAfter: 365,
    partitionBy: 'login_time',
    archiveTarget: 's3',
    compression: 'gzip',
    queryPriority: 'low',
    gdprDeletable: true    // 用户可请求删除
  },
  
  // 用户行为数据：活跃期 180 天，归档 1 年
  user_behavior_logs: {
    tableName: 'user_behavior_logs',
    hotDays: 180,
    warmDays: 365,
    archiveDays: 730,
    deleteAfter: 730,
    partitionBy: 'created_at',
    archiveTarget: 's3',
    compression: 'parquet',
    queryPriority: 'low',
    gdprDeletable: true
  }
};
```

### 4.2 冷热数据识别引擎

```javascript
// backend/shared/ArchiveManager.js
const { createLogger } = require('./logger');
const { query } = require('./db');
const AWS = require('aws-sdk');

const logger = createLogger('archive-manager');

class ArchiveManager {
  constructor(config = {}) {
    this.s3 = new AWS.S3(config.s3Config);
    this.bucket = config.archiveBucket || 'minego-data-archive';
    this.policies = DATA_LIFECYCLE_POLICIES;
  }
  
  /**
   * 识别冷数据并标记归档
   */
  async identifyColdData(tableName) {
    const policy = this.policies[tableName];
    if (!policy) {
      throw new Error(`No lifecycle policy for table: ${tableName}`);
    }
    
    const hotThreshold = new Date();
    hotThreshold.setDate(hotThreshold.getDate() - policy.hotDays);
    
    const warmThreshold = new Date();
    warmThreshold.setDate(warmThreshold.getDate() - policy.warmDays);
    
    // 查询冷数据统计
    const stats = await query(`
      SELECT 
        COUNT(*) as total_rows,
        COUNT(*) FILTER (WHERE ${policy.partitionBy} < $1) as cold_rows,
        MIN(${policy.partitionBy}) as oldest_record,
        MAX(${policy.partitionBy}) as newest_record,
        pg_size_pretty(pg_total_relation_size($2)) as table_size
      FROM ${tableName}
    `, [hotThreshold, tableName]);
    
    return {
      tableName,
      hotThreshold,
      warmThreshold,
      stats: stats.rows[0],
      estimatedSavings: this.estimateStorageSavings(stats.rows[0], policy)
    };
  }
  
  /**
   * 执行数据归档
   */
  async archiveData(tableName, options = {}) {
    const policy = this.policies[tableName];
    const batchSize = options.batchSize || 10000;
    
    const hotThreshold = new Date();
    hotThreshold.setDate(hotThreshold.getDate() - policy.hotDays);
    
    logger.info({ tableName, hotThreshold, batchSize }, 'Starting data archival');
    
    let archivedCount = 0;
    let hasMore = true;
    
    while (hasMore) {
      // 查询一批冷数据
      const coldData = await query(`
        SELECT * FROM ${tableName}
        WHERE ${policy.partitionBy} < $1
        ORDER BY ${policy.partitionBy}
        LIMIT $2
      `, [hotThreshold, batchSize]);
      
      if (coldData.rows.length === 0) {
        hasMore = false;
        break;
      }
      
      // 压缩数据
      const compressedData = await this.compressData(
        coldData.rows,
        policy.compression
      );
      
      // 上传到对象存储
      const archiveKey = this.generateArchiveKey(tableName, coldData.rows[0]);
      await this.uploadToS3(archiveKey, compressedData, policy);
      
      // 从数据库删除
      const ids = coldData.rows.map(row => row.id);
      await query(`DELETE FROM ${tableName} WHERE id = ANY($1)`, [ids]);
      
      archivedCount += coldData.rows.length;
      
      logger.info({ 
        tableName, 
        archivedCount, 
        batchProgress: coldData.rows.length 
      }, 'Batch archived');
      
      // 避免过度占用资源
      await this.sleep(100);
    }
    
    logger.info({ tableName, archivedCount }, 'Archival completed');
    
    return {
      tableName,
      archivedCount,
      archivedAt: new Date().toISOString()
    };
  }
  
  /**
   * 压缩数据
   */
  async compressData(data, compression) {
    const zlib = require('zlib');
    const json = JSON.stringify(data);
    
    if (compression === 'gzip') {
      return await new Promise((resolve, reject) => {
        zlib.gzip(json, (err, compressed) => {
          if (err) reject(err);
          else resolve(compressed);
        });
      });
    }
    
    // Parquet 格式需要使用专门的库
    if (compression === 'parquet') {
      const parquet = require('parquetjs');
      // ... Parquet 转换逻辑
    }
    
    return Buffer.from(json);
  }
  
  /**
   * 上传到 S3
   */
  async uploadToS3(key, data, policy) {
    const params = {
      Bucket: this.bucket,
      Key: key,
      Body: data,
      Metadata: {
        tableName: policy.tableName,
        archivedAt: new Date().toISOString(),
        compression: policy.compression
      }
    };
    
    await this.s3.putObject(params).promise();
    
    logger.info({ key, size: data.length }, 'Data uploaded to S3');
  }
  
  /**
   * 生成归档键名
   */
  generateArchiveKey(tableName, firstRecord) {
    const date = firstRecord.created_at || firstRecord.spawn_time || firstRecord.battle_time;
    const dateStr = new Date(date).toISOString().split('T')[0];
    return `archives/${tableName}/${dateStr}/${Date.now()}.json.gz`;
  }
  
  /**
   * 估算存储节省
   */
  estimateStorageSavings(stats, policy) {
    const coldRows = parseInt(stats.cold_rows) || 0;
    const totalRows = parseInt(stats.total_rows) || 1;
    
    // 假设归档到 S3 后成本降低 80%
    const savingsPercentage = (coldRows / totalRows) * 80;
    
    return {
      coldDataPercentage: (coldRows / totalRows * 100).toFixed(2) + '%',
      estimatedSavingsPercentage: savingsPercentage.toFixed(2) + '%',
      recommendation: savingsPercentage > 30 ? 'archive_recommended' : 'no_action'
    };
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 4.3 归档任务调度

```javascript
// backend/jobs/dataArchivingJob.js
const { ArchiveManager } = require('../shared/ArchiveManager');
const { createLogger } = require('../shared/logger');
const cron = require('node-cron');

const logger = createLogger('data-archiving-job');

class DataArchivingJob {
  constructor() {
    this.archiveManager = new ArchiveManager();
    this.isRunning = false;
  }
  
  /**
   * 启动定时任务
   * 每周日凌晨 3 点执行归档
   */
  start() {
    cron.schedule('0 3 * * 0', async () => {
      if (this.isRunning) {
        logger.warn('Previous archiving job still running, skipping');
        return;
      }
      
      await this.runArchiveCycle();
    });
    
    logger.info('Data archiving job scheduled (Sundays at 3 AM)');
  }
  
  /**
   * 执行归档循环
   */
  async runArchiveCycle() {
    this.isRunning = true;
    
    try {
      logger.info('Starting data archiving cycle');
      
      const tables = Object.keys(DATA_LIFECYCLE_POLICIES);
      
      for (const tableName of tables) {
        try {
          // 先识别冷数据
          const coldDataStats = await this.archiveManager.identifyColdData(tableName);
          
          logger.info({ 
            tableName, 
            stats: coldDataStats.stats,
            recommendation: coldDataStats.estimatedSavings.recommendation
          }, 'Cold data identified');
          
          // 如果冷数据占比超过 20%，执行归档
          if (coldDataStats.estimatedSavings.recommendation === 'archive_recommended') {
            const result = await this.archiveManager.archiveData(tableName);
            
            logger.info({ tableName, result }, 'Data archived successfully');
          }
        } catch (error) {
          logger.error({ tableName, error: error.message }, 'Archiving failed for table');
          // 继续处理下一个表
        }
      }
      
      logger.info('Data archiving cycle completed');
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = DataArchivingJob;
```

### 4.4 归档数据查询 API

```javascript
// backend/gateway/src/routes/archive.js
const express = require('express');
const router = express.Router();
const { ArchiveManager } = require('../../shared/ArchiveManager');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const archiveManager = new ArchiveManager();

/**
 * 查询归档数据
 * GET /api/v1/archive/:tableName?startDate=2026-01-01&endDate=2026-01-31
 */
router.get('/:tableName', requireAuth, async (req, res) => {
  try {
    const { tableName } = req.params;
    const { startDate, endDate, limit = 100 } = req.query;
    
    // 验证表名
    if (!DATA_LIFECYCLE_POLICIES[tableName]) {
      return res.status(400).json({ 
        error: 'INVALID_TABLE',
        message: `Table ${tableName} not supported for archive query`
      });
    }
    
    // 从归档查询数据（较慢）
    const data = await archiveManager.queryArchive(tableName, {
      startDate,
      endDate,
      limit: parseInt(limit)
    });
    
    res.json({
      tableName,
      source: 'archive',
      queryTime: data.queryTime,
      totalRows: data.rows.length,
      rows: data.rows
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'ARCHIVE_QUERY_FAILED',
      message: error.message 
    });
  }
});

/**
 * 获取归档统计信息
 * GET /api/v1/admin/archive/stats
 */
router.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = [];
    
    for (const tableName of Object.keys(DATA_LIFECYCLE_POLICIES)) {
      const tableStats = await archiveManager.identifyColdData(tableName);
      stats.push(tableStats);
    }
    
    res.json({
      generatedAt: new Date().toISOString(),
      tables: stats
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'STATS_QUERY_FAILED',
      message: error.message 
    });
  }
});

/**
 * 手动触发归档（管理员）
 * POST /api/v1/admin/archive/trigger
 */
router.post('/admin/trigger', requireAdmin, async (req, res) => {
  try {
    const { tableName } = req.body;
    
    if (!tableName) {
      return res.status(400).json({ 
        error: 'TABLE_NAME_REQUIRED',
        message: 'tableName is required'
      });
    }
    
    const result = await archiveManager.archiveData(tableName);
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'ARCHIVE_TRIGGER_FAILED',
      message: error.message 
    });
  }
});

module.exports = router;
```

### 4.5 数据库迁移

```sql
-- database/pending/20260707_090000__add_archive_metadata_tables.sql

-- 归档任务记录表
CREATE TABLE archive_jobs (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending/running/completed/failed
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  archived_rows INTEGER DEFAULT 0,
  archive_size_bytes BIGINT DEFAULT 0,
  archive_location VARCHAR(512), -- S3 路径
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX idx_archive_jobs_status ON archive_jobs(status, created_at DESC);
CREATE INDEX idx_archive_jobs_table ON archive_jobs(table_name, created_at DESC);

-- 数据生命周期策略表
CREATE TABLE data_lifecycle_policies (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(64) NOT NULL UNIQUE,
  hot_days INTEGER NOT NULL DEFAULT 90,
  warm_days INTEGER NOT NULL DEFAULT 365,
  archive_days INTEGER NOT NULL DEFAULT 730,
  delete_after_days INTEGER,
  archive_target VARCHAR(32) DEFAULT 's3', -- s3/gcs/local
  compression VARCHAR(16) DEFAULT 'gzip', -- gzip/parquet/zstd
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 归档数据目录表
CREATE TABLE archive_catalog (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(64) NOT NULL,
  archive_date DATE NOT NULL,
  archive_key VARCHAR(512) NOT NULL, -- S3 key
  archive_size_bytes BIGINT NOT NULL,
  row_count INTEGER NOT NULL,
  compression VARCHAR(16) NOT NULL,
  min_id INTEGER,
  max_id INTEGER,
  checksum VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_archive_catalog_table_date ON archive_catalog(table_name, archive_date DESC);
CREATE INDEX idx_archive_catalog_date ON archive_catalog(archive_date DESC);

-- 插入默认策略
INSERT INTO data_lifecycle_policies (table_name, hot_days, warm_days, archive_days, delete_after_days) VALUES
('catch_records', 90, 365, 730, 730),
('pokemon_spawns', 30, 180, 365, 365),
('battle_logs', 60, 365, 730, 730),
('reward_records', 180, 730, 1095, 1095),
('user_login_logs', 30, 365, 365, 365),
('user_behavior_logs', 180, 365, 730, 730);
```

### 4.6 管理后台配置界面

```javascript
// frontend/admin-dashboard/src/pages/ArchiveConfig.js
class ArchiveConfigPage {
  constructor() {
    this.policies = [];
    this.stats = {};
  }
  
  async loadPolicies() {
    const response = await fetch('/api/v1/admin/archive/policies', {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });
    this.policies = await response.json();
    this.render();
  }
  
  async loadStats() {
    const response = await fetch('/api/v1/admin/archive/stats', {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });
    this.stats = await response.json();
    this.render();
  }
  
  async updatePolicy(tableName, updates) {
    const response = await fetch(`/api/v1/admin/archive/policies/${tableName}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });
    
    if (response.ok) {
      alert('策略更新成功');
      await this.loadPolicies();
    } else {
      alert('更新失败：' + (await response.json()).message);
    }
  }
  
  render() {
    return `
      <div class="archive-config-page">
        <h1>数据归档与生命周期管理</h1>
        
        <!-- 归档统计概览 -->
        <div class="stats-overview">
          <h2>存储概况</h2>
          ${this.renderStatsOverview()}
        </div>
        
        <!-- 生命周期策略配置 -->
        <div class="policies-section">
          <h2>生命周期策略</h2>
          <table class="policies-table">
            <thead>
              <tr>
                <th>表名</th>
                <th>热数据（天）</th>
                <th>温数据（天）</th>
                <th>归档期限（天）</th>
                <th>删除期限（天）</th>
                <th>压缩格式</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${this.policies.map(policy => `
                <tr>
                  <td>${policy.table_name}</td>
                  <td><input type="number" value="${policy.hot_days}" data-field="hot_days" /></td>
                  <td><input type="number" value="${policy.warm_days}" data-field="warm_days" /></td>
                  <td><input type="number" value="${policy.archive_days}" data-field="archive_days" /></td>
                  <td><input type="number" value="${policy.delete_after_days}" data-field="delete_after_days" /></td>
                  <td>
                    <select data-field="compression">
                      <option value="gzip" ${policy.compression === 'gzip' ? 'selected' : ''}>Gzip</option>
                      <option value="parquet" ${policy.compression === 'parquet' ? 'selected' : ''}>Parquet</option>
                      <option value="zstd" ${policy.compression === 'zstd' ? 'selected' : ''}>Zstd</option>
                    </select>
                  </td>
                  <td>
                    <button onclick="archiveConfig.updatePolicy('${policy.table_name}', this.getUpdates())">保存</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        
        <!-- 手动触发归档 -->
        <div class="manual-archive-section">
          <h2>手动归档</h2>
          <select id="archiveTable">
            ${this.policies.map(p => `<option value="${p.table_name}">${p.table_name}</option>`).join('')}
          </select>
          <button onclick="archiveConfig.triggerArchive()">触发归档</button>
        </div>
        
        <!-- 归档历史 -->
        <div class="archive-history-section">
          <h2>归档历史</h2>
          ${this.renderArchiveHistory()}
        </div>
      </div>
    `;
  }
  
  renderStatsOverview() {
    if (!this.stats.tables) return '<p>加载中...</p>';
    
    const totalSavings = this.stats.tables.reduce((sum, t) => 
      sum + parseFloat(t.estimatedSavings.estimatedSavingsPercentage), 0
    );
    
    return `
      <div class="stats-cards">
        ${this.stats.tables.map(table => `
          <div class="stat-card">
            <h3>${table.tableName}</h3>
            <p>总行数：${table.stats.total_rows}</p>
            <p>冷数据：${table.stats.cold_rows} (${table.estimatedSavings.coldDataPercentage})</p>
            <p>预估节省：${table.estimatedSavings.estimatedSavingsPercentage}</p>
            <p>状态：<span class="status-${table.estimatedSavings.recommendation}">${table.estimatedSavings.recommendation}</span></p>
          </div>
        `).join('')}
      </div>
      <p class="total-savings">总预估节省：${totalSavings.toFixed(2)}%</p>
    `;
  }
  
  async triggerArchive() {
    const tableName = document.getElementById('archiveTable').value;
    
    if (!confirm(`确定要归档 ${tableName} 表吗？此操作不可撤销。`)) {
      return;
    }
    
    const response = await fetch('/api/v1/admin/archive/trigger', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tableName })
    });
    
    if (response.ok) {
      const result = await response.json();
      alert(`归档成功：已归档 ${result.result.archivedCount} 条记录`);
    } else {
      alert('归档失败：' + (await response.json()).message);
    }
  }
}
```

## 5. 验收标准（可测试）

- [ ] **生命周期策略配置**：支持配置 10+ 张表的归档策略
- [ ] **冷数据识别**：能准确识别超过热数据期限的记录，准确率 100%
- [ ] **数据归档**：归档过程不丢失数据，归档后数据可查询
- [ ] **压缩效率**：Gzip 压缩率 ≥ 70%，Parquet 列式存储支持
- [ ] **S3 上传**：归档数据成功上传到对象存储，元数据完整
- [ ] **归档查询**：能查询归档数据，响应时间 < 10 秒（1000 条记录）
- [ ] **存储节省**：归档后存储成本降低 ≥ 40%
- [ ] **性能提升**：活跃数据表查询速度提升 ≥ 30%
- [ ] **定时任务**：归档任务按计划自动执行，失败自动重试
- [ ] **合规清理**：超过删除期限的数据自动清理，符合 GDPR 要求
- [ ] **管理界面**：管理员可查看归档统计、配置策略、手动触发归档
- [ ] **监控告警**：归档任务失败时发送告警
- [ ] **单元测试**：核心模块单元测试覆盖率 ≥ 85%
- [ ] **集成测试**：完整归档流程测试通过

## 6. 工作量估算

**L (Large)**

理由：
- 涉及多张核心业务表的归档逻辑
- 需要实现完整的生命周期管理系统（策略、执行、查询、监控）
- S3 对象存储集成与压缩算法实现
- 管理后台配置界面开发
- 性能优化与测试工作量较大
- 预估开发时间：10-12 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **存储成本激增**：数据快速增长导致存储成本每月增长 20%+
2. **性能影响**：大表查询性能下降已影响用户体验
3. **合规风险**：GDPR 要求超过保留期限的数据应删除
4. **基础能力**：数据归档是成熟数据库系统的必备能力
5. **成本收益比高**：预计节省 40-60% 存储成本，投入产出比高

相比 P0 需求（安全、稳定），此需求属于成本优化和性能提升，对项目长期运营至关重要。

## 8. 风险与依赖

### 风险
- 数据丢失：归档过程可能因故障导致数据丢失
- 性能影响：归档过程可能影响在线业务性能
- 查询延迟：归档数据查询速度较慢
- 合规变更：数据保留期限法规可能变更

### 依赖
- REQ-00025（数据库备份与灾备）：归档前需确保有完整备份
- REQ-00027（数据分区策略）：分区表更易于归档
- AWS S3 或其他对象存储服务
- PostgreSQL 版本 ≥ 12（支持分区表）

## 9. 后续扩展

- **智能归档**：基于机器学习预测数据访问模式，动态调整归档策略
- **多级存储**：支持更多存储层级（热/温/冷/极冷）
- **增量归档**：支持增量归档，减少归档时间
- **跨区域归档**：支持跨区域数据归档与同步
- **归档数据集市**：为数据分析提供归档数据集市
