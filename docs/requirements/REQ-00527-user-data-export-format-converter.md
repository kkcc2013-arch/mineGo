# REQ-00527：用户数据导出格式转换与可携带性系统

- **编号**：REQ-00527
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、gateway、backend/shared/dataExporter、backend/jobs
- **创建时间**：2026-07-10 06:35
- **依赖需求**：REQ-00127（用户数据删除请求管理）

## 1. 背景与问题

GDPR 第20条规定用户享有"数据可携带权"，用户有权以结构化、常用且机器可读的格式接收其个人数据，并有权将这些数据传输给另一个控制者。当前系统仅提供基础的用户数据查询接口，缺乏：

1. **多格式导出支持**：无法导出为 JSON、CSV、XML 等标准格式
2. **批量数据打包**：无法一次性导出用户所有关联数据（精灵、道具、交易记录等）
3. **跨平台可携带性**：缺乏标准化的数据格式规范
4. **导出任务管理**：大数据量导出无异步任务队列支持
5. **导出安全审计**：缺乏导出操作的安全日志记录

## 2. 目标

实现完整的用户数据导出系统：
- 支持 5 种标准导出格式（JSON、CSV、XML、PDF、Parquet）
- 提供完整用户数据打包下载（含关联数据）
- 实现异步导出任务队列，支持大数据量导出
- 符合 GDPR 数据可携带权要求
- 提供导出操作审计日志

## 3. 范围

- **包含**：
  - 多格式数据导出引擎
  - 用户数据聚合器（精灵、道具、交易、好友等）
  - 异步导出任务队列
  - 导出文件加密与签名
  - 导出状态追踪与通知
  - 管理后台导出配置
  
- **不包含**：
  - 第三方平台直接数据传输（后续需求）
  - 实时数据流导出
  - 增量导出同步

## 4. 详细需求

### 4.1 数据导出引擎
```javascript
// backend/shared/dataExporter/DataExporter.js
class DataExporter {
  constructor(config) {
    this.formatters = {
      json: new JsonFormatter(),
      csv: new CsvFormatter(),
      xml: new XmlFormatter(),
      pdf: new PdfFormatter(),
      parquet: new ParquetFormatter()
    };
    this.encryptionKey = config.encryptionKey;
    this.maxFileSize = config.maxFileSize || 100 * 1024 * 1024; // 100MB
  }

  async export(userId, options) {
    const { format, dataTypes, encrypt, sign } = options;
    // 1. 聚合用户数据
    const userData = await this.aggregateUserData(userId, dataTypes);
    // 2. 格式化转换
    const formatted = await this.formatters[format].format(userData);
    // 3. 可选加密
    const result = encrypt ? await this.encrypt(formatted) : formatted;
    // 4. 可选签名
    return sign ? await this.sign(result) : result;
  }

  async aggregateUserData(userId, dataTypes) {
    // 从各服务聚合数据
    const aggregator = new UserDataAggregator(this.services);
    return await aggregator.collect(userId, dataTypes);
  }
}
```

### 4.2 用户数据聚合器
```javascript
// backend/shared/dataExporter/UserDataAggregator.js
class UserDataAggregator {
  constructor(services) {
    this.collectors = {
      profile: new ProfileCollector(services.user),
      pokemon: new PokemonCollector(services.pokemon),
      items: new ItemCollector(services.pokemon),
      transactions: new TransactionCollector(services.payment),
      friends: new FriendCollector(services.social),
      achievements: new AchievementCollector(services.reward),
      battles: new BattleCollector(services.gym),
      locations: new LocationCollector(services.location)
    };
  }

  async collect(userId, dataTypes) {
    const results = {};
    for (const type of dataTypes) {
      if (this.collectors[type]) {
        results[type] = await this.collectors[type].collect(userId);
      }
    }
    return results;
  }
}
```

### 4.3 导出任务队列
```javascript
// backend/jobs/dataExportJob.js
class DataExportJob {
  constructor(config) {
    this.queue = new Queue('data-export', {
      redis: config.redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 30 * 60 * 1000 // 30 minutes
      }
    });
    this.processors = new Map();
  }

  async create(userId, options) {
    return await this.queue.add('export', {
      userId,
      options,
      requestedAt: new Date().toISOString()
    });
  }

  async process(job) {
    const { userId, options } = job.data;
    const exporter = new DataExporter(this.config);
    
    // 更新状态
    await this.updateStatus(job.id, 'processing');
    
    try {
      const result = await exporter.export(userId, options);
      await this.updateStatus(job.id, 'completed', result);
      
      // 发送通知
      await this.notifyUser(userId, result);
      
      return result;
    } catch (error) {
      await this.updateStatus(job.id, 'failed', { error: error.message });
      throw error;
    }
  }
}
```

### 4.4 导出格式规范

**JSON 格式**（机器可读，推荐用于迁移）:
```json
{
  "export": {
    "version": "1.0",
    "userId": "user-xxx",
    "exportedAt": "2026-07-10T06:35:00Z",
    "format": "json",
    "checksum": "sha256:abc123",
    "data": {
      "profile": { ... },
      "pokemon": [ ... ],
      "items": [ ... ],
      "transactions": [ ... ]
    }
  }
}
```

**CSV 格式**（表格数据，适合 Excel 分析）:
- 每种数据类型单独文件
- 包含字段说明行
- UTF-8 BOM 支持

**XML 格式**（企业系统集成）:
- 符合 GDPR 数据可携带性标准
- 支持命名空间和 Schema 验证

**PDF 格式**（用户可读报告）:
- 包含数据摘要和统计
- 水印标识"GDPR 数据导出"
- 支持数字签名

### 4.5 API 接口

```yaml
POST /api/v1/user/data-export
  请求:
    format: json | csv | xml | pdf | parquet
    dataTypes: [profile, pokemon, items, transactions, friends, achievements]
    encrypt: boolean
    sign: boolean
  响应:
    jobId: string
    estimatedTime: number (seconds)

GET /api/v1/user/data-export/:jobId
  响应:
    status: pending | processing | completed | failed
    progress: number (0-100)
    downloadUrl?: string
    expiresAt?: string
    error?: string

GET /api/v1/user/data-export/:jobId/download
  响应:
    Content-Type: application/octet-stream
    Content-Disposition: attachment; filename="user-data-{userId}.{ext}"
```

### 4.6 数据库设计

```sql
CREATE TABLE data_export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  format VARCHAR(20) NOT NULL,
  data_types TEXT[] NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  file_path TEXT,
  file_size BIGINT,
  checksum VARCHAR(128),
  encryption_key_id VARCHAR(64),
  signature TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_export_jobs_user ON data_export_jobs(user_id);
CREATE INDEX idx_export_jobs_status ON data_export_jobs(status);
CREATE INDEX idx_export_jobs_created ON data_export_jobs(created_at);
```

### 4.7 安全措施
- 导出文件 AES-256 加密
- 文件签名防止篡改
- 下载链接有效期 24 小时
- 操作审计日志记录
- 敏感字段脱敏选项

## 5. 验收标准（可测试）

- [ ] 用户可请求导出个人数据，支持 JSON、CSV、XML、PDF、Parquet 五种格式
- [ ] 导出文件包含用户所有选定的数据类型（profile、pokemon、items 等）
- [ ] 大数据量导出（>10MB）通过异步任务队列处理，不阻塞主线程
- [ ] 导出文件支持 AES-256 加密和数字签名
- [ ] 下载链接 24 小时后自动失效
- [ ] 所有导出操作记录到审计日志，包含用户ID、时间、数据类型、格式
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L (Large)**
- 需要实现 5 种格式转换器
- 需要集成 8 个数据源聚合器
- 需要实现任务队列和状态管理
- 预计工作量：5-7 人天

## 7. 优先级理由

**P1** - GDPR 合规核心要求，数据可携带权是用户基本权利，直接影响项目在欧洲市场的合规性。
