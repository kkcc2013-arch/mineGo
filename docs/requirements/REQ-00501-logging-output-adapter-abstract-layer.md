# REQ-00501：日志输出适配器抽象层与插件化架构

- **编号**：REQ-00501
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/shared/logger.js、所有后端服务、infrastructure/logging
- **创建时间**：2026-07-08 10:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目的日志模块（`backend/shared/logger.js`）使用 Pino 作为日志框架，但存在以下问题：

1. **硬编码输出目标**：日志只输出到 stdout，缺乏对多种输出目标（文件、远程日志服务、Kafka、Elasticsearch）的灵活支持
2. **缺少适配器抽象**：切换日志输出目标需要修改核心代码，违反开闭原则
3. **环境适配性差**：开发、测试、生产环境的日志输出策略难以差异化配置
4. **扩展性受限**：无法轻松集成第三方日志服务（如 Datadog、Splunk、CloudWatch Logs）

在微服务架构中，统一的日志输出适配器抽象层是提升可维护性和可扩展性的关键基础设施。

## 2. 目标

建立一套插件化的日志输出适配器架构，实现：
- 统一的日志输出接口抽象，支持多种输出目标
- 插件化架构，新增输出目标无需修改核心代码
- 环境感知的自动输出目标选择
- 支持多输出目标并行写入（本地文件 + 远程服务）
- 配置驱动的输出策略管理

## 3. 范围

- **包含**：
  - 日志输出适配器接口定义（ILogOutputAdapter）
  - 内置适配器实现（StdoutAdapter、FileAdapter、KafkaAdapter、ElasticsearchAdapter）
  - 适配器管理器（LogAdapterManager）负责多适配器协调
  - 环境配置系统（development/testing/production）
  - 输出策略配置（缓冲、批处理、重试、降级）
  
- **不包含**：
  - 日志采集和存储基础设施的部署
  - 日志可视化平台的开发（使用现有 Grafana Loki）
  - 日志内容的格式化（已在 Pino 中实现）

## 4. 详细需求

### 4.1 适配器接口设计

```javascript
// ILogOutputAdapter 抽象接口
interface ILogOutputAdapter {
  // 适配器名称
  name: string;
  
  // 初始化（传入配置）
  initialize(config: AdapterConfig): Promise<void>;
  
  // 写入单条日志
  write(logEntry: LogEntry): Promise<void>;
  
  // 批量写入日志
  writeBatch(logEntries: LogEntry[]): Promise<void>;
  
  // 刷新缓冲区
  flush(): Promise<void>;
  
  // 关闭适配器（优雅关闭）
  close(): Promise<void>;
  
  // 健康检查
  healthCheck(): Promise<HealthStatus>;
  
  // 支持的日志级别
  supportedLevels: LogLevel[];
}

// 日志条目结构
interface LogEntry {
  timestamp: string;      // ISO 8601
  level: string;         // trace/debug/info/warn/error/fatal
  message: string;
  service: string;
  context: object;        // 结构化上下文
  traceId?: string;      // OpenTelemetry 追踪 ID
  spanId?: string;        // OpenTelemetry Span ID
}

// 适配器配置
interface AdapterConfig {
  enabled: boolean;
  buffer: {
    enabled: boolean;
    maxSize: number;      // 缓冲区大小
    flushInterval: number; // 刷新间隔（毫秒）
  };
  retry: {
    maxRetries: number;
    backoffMs: number;
  };
}
```

### 4.2 内置适配器实现

#### 4.2.1 StdoutAdapter（默认）
- 输出到标准输出
- 支持 Pino pretty-print（开发环境）
- 支持结构化 JSON（生产环境）

#### 4.2.2 FileAdapter
- 输出到本地文件
- 支持日志轮转（按大小/时间）
- 支持压缩归档
- 配置示例：
```yaml
file:
  path: /var/log/mineGo/app.log
  rotation:
    maxSize: 100MB
    maxFiles: 10
    compress: true
```

#### 4.2.3 KafkaAdapter
- 输出到 Kafka Topic
- 支持消息分区（按服务名）
- 支持异步批处理
- 配置示例：
```yaml
kafka:
  topic: minego-logs
  brokers: [kafka:9092]
  partitionKey: service
  batchSize: 100
```

#### 4.2.4 ElasticsearchAdapter
- 输出到 Elasticsearch
- 支持索引自动管理（按日期）
- 支持批量索引（Bulk API）
- 配置示例：
```yaml
elasticsearch:
  node: http://elasticsearch:9200
  index: minego-logs-{date}
  batchSize: 200
  flushInterval: 5000
```

### 4.3 适配器管理器

```javascript
class LogAdapterManager {
  // 注册适配器
  registerAdapter(adapter: ILogOutputAdapter): void;
  
  // 移除适配器
  removeAdapter(name: string): void;
  
  // 获取适配器
  getAdapter(name: string): ILogOutputAdapter;
  
  // 写入日志到所有启用的适配器
  writeToAll(logEntry: LogEntry): Promise<void>;
  
  // 批量写入
  writeToAllBatch(logEntries: LogEntry[]): Promise<void>;
  
  // 刷新所有缓冲区
  flushAll(): Promise<void>;
  
  // 关闭所有适配器
  closeAll(): Promise<void>;
  
  // 健康检查所有适配器
  healthCheckAll(): Promise<Map<string, HealthStatus>>;
}
```

### 4.4 环境配置系统

```javascript
// config/logging.js
module.exports = {
  development: {
    adapters: [
      { name: 'stdout', enabled: true, prettyPrint: true }
    ],
    level: 'debug'
  },
  
  testing: {
    adapters: [
      { name: 'stdout', enabled: true, prettyPrint: false },
      { name: 'file', enabled: true, path: '/tmp/test.log' }
    ],
    level: 'info'
  },
  
  production: {
    adapters: [
      { name: 'stdout', enabled: true },
      { name: 'kafka', enabled: true, topic: 'minego-logs-prod' },
      { name: 'elasticsearch', enabled: true }
    ],
    level: 'info',
    fallback: { enabled: true, adapter: 'stdout' }
  }
};
```

### 4.5 降级策略

- 当主输出目标失败时，自动降级到备用适配器
- 记录降级事件到本地文件
- 定期尝试恢复主输出目标
- 支持手动触发降级/恢复（通过管理 API）

### 4.6 性能要求

- 日志写入延迟 < 5ms（P99）
- 批量写入吞吐量 > 10000 logs/s
- 内存占用 < 50MB（缓冲区）
- CPU 占用 < 2%（正常负载）

## 5. 验收标准（可测试）

- [ ] 实现至少 4 种内置适配器（stdout、file、kafka、elasticsearch）
- [ ] 适配器接口符合 ILogOutputAdapter 规范
- [ ] 支持通过配置文件切换输出目标，无需修改代码
- [ ] 生产环境默认启用多适配器并行写入（stdout + kafka）
- [ ] 主适配器失败时自动降级到备用适配器，降级时间 < 100ms
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试覆盖所有内置适配器
- [ ] 性能基准测试证明满足性能要求
- [ ] 文档说明如何开发自定义适配器
- [ ] 所有现有服务迁移到新架构，无日志丢失

## 6. 工作量估算

**L（Large）** - 需要设计抽象接口、实现 4 种适配器、迁移现有代码、编写完整测试和文档，预计需要 3-5 个工作日。

## 7. 优先级理由

**P1** - 日志输出适配器抽象层是基础设施组件，影响系统的可维护性和可扩展性。当前硬编码的输出方式限制了在不同环境下的灵活配置，阻碍了日志基础设施的演进。作为关键解耦点，应尽早实现，为后续集成更多日志服务和优化日志架构奠定基础。
