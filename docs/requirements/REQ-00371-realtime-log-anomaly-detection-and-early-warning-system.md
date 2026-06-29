# REQ-00371: 实时日志异常检测与预警系统

- **编号**：REQ-00371
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/LogAnomalyDetector.js、backend/shared/LogStreamProcessor.js、backend/shared/AlertCorrelator.js、infrastructure/k8s/monitoring、admin-dashboard
- **创建时间**：2026-06-29 19:00 UTC
- **依赖需求**：REQ-00002（结构化日志）、REQ-00275（告警关联）

## 1. 背景与问题

### 现状分析

当前 mineGo 项目日志管理存在以下问题：

1. **事后分析，缺乏预警**：RootCauseAnalyzer 仅在故障后进行根因分析，无法在故障发生前检测异常信号

2. **日志量巨大，人工难以处理**：9 个微服务每秒产生大量日志，运维人员无法实时阅读所有日志

3. **异常模式识别滞后**：现有告警主要基于阈值触发（如 CPU > 80%），而非基于日志内容的异常检测

4. **缺少日志流处理**：没有实时流处理机制来检测日志中的异常模式（如错误突增、异常堆栈、敏感操作等）

### 业务影响

- 故障发现滞后，平均 MTTR（平均恢复时间）超过 30 分钟
- 运维人员需要手动检索日志，效率低下
- 无法在用户感知前发现问题

## 2. 目标

构建实时日志异常检测与预警系统，实现：

1. **实时日志流处理**：每秒处理 10000+ 条日志，延迟 < 100ms
2. **智能异常检测**：自动检测错误突增、异常堆栈、敏感操作、性能退化等模式
3. **预测性预警**：在故障发生前 5-10 分钟发出预警
4. **低误报率**：误报率控制在 < 5%

## 3. 范围

### 包含

- 日志流处理器（LogStreamProcessor）
- 多维度异常检测引擎（LogAnomalyDetector）
- 告警关联与去重系统（AlertCorrelator 增强）
- 实时告警通知（WebSocket + 多渠道推送）
- 日志异常仪表板（admin-dashboard）
- 与 OpenTelemetry 集成

### 不包含

- 日志长期存储（已有 ELK）
- 日志采样策略（已有）
- 用户行为分析（已有 behaviorAnalyzer）

## 4. 详细需求

### 4.1 日志流处理器

#### 文件：`backend/shared/LogStreamProcessor.js`

```javascript
/**
 * 日志流处理器
 * 
 * 功能：
 * 1. 订阅所有微服务的日志流（通过 Kafka）
 * 2. 实时解析结构化日志
 * 3. 分发到异常检测管道
 * 4. 维护滑动窗口统计
 */
class LogStreamProcessor {
  constructor(config) {
    this.kafkaConsumer = new KafkaConsumer({
      topic: 'logs-all',
      groupId: 'log-anomaly-detector',
      fromBeginning: false
    });
    
    // 滑动窗口（1分钟、5分钟、15分钟）
    this.windows = {
      '1m': new TimeWindow(60000),
      '5m': new TimeWindow(300000),
      '15m': new TimeWindow(900000)
    };
    
    // 服务维度统计
    this.serviceStats = new Map();
    
    // 异常检测器
    this.anomalyDetectors = [
      new ErrorSpikeDetector(),
      new StackPatternDetector(),
      new LatencyAnomalyDetector(),
      new SensitiveOperationDetector()
    ];
  }
  
  async start() {
    await this.kafkaConsumer.subscribe(['logs-all']);
    
    this.kafkaConsumer.run({
      eachMessage: async ({ message }) => {
        const log = JSON.parse(message.value.toString());
        await this.processLog(log);
      }
    });
  }
  
  async processLog(log) {
    const now = Date.now();
    
    // 更新滑动窗口
    for (const [name, window] of Object.entries(this.windows)) {
      window.add(log);
    }
    
    // 更新服务统计
    this.updateServiceStats(log);
    
    // 运行异常检测
    const anomalies = await this.detectAnomalies(log);
    
    if (anomalies.length > 0) {
      await this.emitAnomalies(anomalies);
    }
  }
}
```

### 4.2 异常检测器

#### 错误突增检测器

```javascript
/**
 * 错误突增检测器
 * 
 * 检测逻辑：
 * 1. 统计过去 1 分钟内错误日志数量
 * 2. 与过去 1 小时基线对比
 * 3. 使用泊松分布计算异常概率
 */
class ErrorSpikeDetector {
  constructor(config) {
    this.baselineWindow = 3600000; // 1 小时基线
    this.spikeThreshold = 3.0; // 基线 3 倍
    this.minSampleSize = 100; // 最小样本量
  }
  
  async detect(currentWindow, baselineWindow) {
    const currentErrors = currentWindow.count(log => log.level >= 40);
    const baselineErrors = baselineWindow.count(log => log.level >= 40);
    
    if (baselineErrors < this.minSampleSize) {
      return null;
    }
    
    const baselineRate = baselineErrors / baselineWindow.duration;
    const currentRate = currentErrors / currentWindow.duration;
    
    // 使用泊松分布计算 P(X >= current | λ = baseline)
    const pValue = this.poissonPValue(currentErrors, baselineRate * currentWindow.duration);
    
    if (currentRate / baselineRate > this.spikeThreshold && pValue < 0.01) {
      return {
        type: 'error_spike',
        severity: this.calculateSeverity(currentRate / baselineRate),
        details: {
          currentRate,
          baselineRate,
          ratio: currentRate / baselineRate,
          pValue,
          affectedService: currentWindow.mostCommon(log => log.service)
        }
      };
    }
    
    return null;
  }
  
  poissonPValue(k, lambda) {
    // 使用正态近似
    if (lambda > 30) {
      const z = (k - lambda) / Math.sqrt(lambda);
      return 1 - this.normalCDF(z);
    }
    // 小样本使用精确计算
    return 1 - this.poissonCDF(k - 1, lambda);
  }
}
```

#### 堆栈模式检测器

```javascript
/**
 * 堆栈模式检测器
 * 
 * 检测逻辑：
 * 1. 提取错误日志中的堆栈信息
 * 2. 对堆栈进行哈希去重
 * 3. 识别新出现的错误模式
 * 4. 追踪错误传播链
 */
class StackPatternDetector {
  constructor() {
    this.knownPatterns = new Map(); // patternHash -> firstSeen, count
    this.newPatternThreshold = 60000; // 1 分钟内首次出现视为新模式
  }
  
  async detect(log) {
    if (log.level < 40 || !log.err || !log.err.stack) {
      return null;
    }
    
    const stackHash = this.hashStack(log.err.stack);
    const now = Date.now();
    
    if (!this.knownPatterns.has(stackHash)) {
      // 新错误模式
      this.knownPatterns.set(stackHash, {
        firstSeen: now,
        count: 1,
        sample: log
      });
      
      return {
        type: 'new_error_pattern',
        severity: 'high',
        details: {
          stackHash,
          errorMessage: log.err.message,
          firstOccurrence: new Date(now).toISOString(),
          service: log.service,
          stackTrace: this.truncateStack(log.err.stack, 10)
        }
      };
    }
    
    // 更新已知模式计数
    const pattern = this.knownPatterns.get(stackHash);
    pattern.count++;
    
    // 检测高频错误
    if (pattern.count === 10 || pattern.count === 50 || pattern.count === 100) {
      return {
        type: 'frequent_error',
        severity: pattern.count >= 100 ? 'critical' : 'high',
        details: {
          stackHash,
          errorMessage: log.err.message,
          occurrenceCount: pattern.count,
          service: log.service
        }
      };
    }
    
    return null;
  }
}
```

#### 延迟异常检测器

```javascript
/**
 * 延迟异常检测器
 * 
 * 检测逻辑：
 * 1. 监控请求响应时间日志
 * 2. 使用指数加权移动平均（EWMA）
 * 3. 检测 P99 延迟突增
 */
class LatencyAnomalyDetector {
  constructor() {
    this.ewma = {
      alpha: 0.1,
      mean: null,
      variance: null
    };
    this.threshold = 3.0; // 3 sigma
  }
  
  async detect(log) {
    if (!log.responseTime) return null;
    
    const latency = log.responseTime;
    
    if (this.ewma.mean === null) {
      this.ewma.mean = latency;
      this.ewma.variance = 0;
      return null;
    }
    
    // 更新 EWMA
    const delta = latency - this.ewma.mean;
    this.ewma.mean += this.ewma.alpha * delta;
    this.ewma.variance = (1 - this.ewma.alpha) * (this.ewma.variance + this.ewma.alpha * delta * delta);
    
    // 计算标准化残差
    const stdDev = Math.sqrt(this.ewma.variance);
    const zScore = Math.abs(delta) / (stdDev || 1);
    
    if (zScore > this.threshold && latency > 1000) {
      return {
        type: 'latency_anomaly',
        severity: latency > 5000 ? 'critical' : 'high',
        details: {
          currentLatency: latency,
          expectedLatency: this.ewma.mean,
          zScore,
          endpoint: log.apiPath,
          method: log.method
        }
      };
    }
    
    return null;
  }
}
```

### 4.3 告警关联与去重

#### 文件：`backend/shared/AlertCorrelator.js`（增强）

```javascript
/**
 * 告警关联器（增强版）
 * 
 * 新增功能：
 * 1. 日志异常告警关联
 * 2. 时空聚类（同一服务 5 分钟内异常合并）
 * 3. 因果链推断（错误 -> 延迟 -> 用户影响）
 */
class AlertCorrelator {
  constructor() {
    this.alertWindow = new TimeWindow(300000); // 5 分钟窗口
    this.causalityGraph = new Map();
  }
  
  async correlate(anomaly) {
    const now = Date.now();
    
    // 查找时间窗口内的相关告警
    const relatedAlerts = this.alertWindow.filter(alert => 
      this.isRelated(alert, anomaly)
    );
    
    if (relatedAlerts.length > 0) {
      // 合并告警
      const merged = this.mergeAlerts(relatedAlerts, anomaly);
      this.alertWindow.add(merged);
      return merged;
    }
    
    // 新告警
    this.alertWindow.add(anomaly);
    return anomaly;
  }
  
  isRelated(alert1, alert2) {
    // 同一服务
    if (alert1.service === alert2.service) return true;
    
    // 因果关系（如数据库错误导致 API 错误）
    if (this.hasCausalRelation(alert1, alert2)) return true;
    
    // 相似错误模式
    if (alert1.stackHash && alert1.stackHash === alert2.stackHash) return true;
    
    return false;
  }
  
  async inferCausalChain(anomalies) {
    // 构建因果链
    // 例如：数据库连接池耗尽 -> 查询超时 -> API 503 -> 用户报错
    const chain = [];
    
    // 按时间排序
    anomalies.sort((a, b) => a.timestamp - b.timestamp);
    
    for (let i = 0; i < anomalies.length - 1; i++) {
      const current = anomalies[i];
      const next = anomalies[i + 1];
      
      if (this.isCausedBy(current, next)) {
        chain.push({
          cause: current,
          effect: next,
          confidence: this.calculateConfidence(current, next)
        });
      }
    }
    
    return chain;
  }
}
```

### 4.4 实时告警通知

#### WebSocket 告警推送

```javascript
/**
 * 告警 WebSocket 推送
 */
class AlertWebSocketNotifier {
  constructor(wss) {
    this.wss = wss;
    this.subscriptions = new Map(); // userId -> { services, severity }
  }
  
  async notify(anomaly) {
    const message = {
      type: 'log_anomaly',
      timestamp: anomaly.timestamp,
      severity: anomaly.severity,
      service: anomaly.service,
      anomalyType: anomaly.type,
      summary: this.generateSummary(anomaly),
      details: anomaly.details
    };
    
    // 推送给订阅了该服务的管理员
    for (const [userId, subscription] of this.subscriptions) {
      if (this.matchesSubscription(anomaly, subscription)) {
        this.wss.sendToUser(userId, message);
      }
    }
  }
  
  generateSummary(anomaly) {
    switch (anomaly.type) {
      case 'error_spike':
        return `${anomaly.service} 错误率突增 ${anomaly.details.ratio.toFixed(1)}x`;
      case 'new_error_pattern':
        return `发现新错误模式: ${anomaly.details.errorMessage.substring(0, 50)}`;
      case 'latency_anomaly':
        return `${anomaly.details.endpoint} 延迟异常 (${anomaly.details.currentLatency}ms)`;
      default:
        return `检测到异常: ${anomaly.type}`;
    }
  }
}
```

### 4.5 数据库设计

#### 迁移文件：`database/migrations/20260629_190000__add_log_anomaly_tables.sql`

```sql
-- 日志异常记录表
CREATE TABLE log_anomalies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- 异常信息
    type VARCHAR(50) NOT NULL, -- error_spike, new_error_pattern, latency_anomaly, etc.
    severity VARCHAR(20) NOT NULL, -- low, medium, high, critical
    service VARCHAR(50) NOT NULL,
    
    -- 详细信息
    details JSONB NOT NULL,
    
    -- 关联信息
    correlated_alerts UUID[], -- 关联的其他告警
    causal_chain JSONB, -- 因果链
    
    -- 处理状态
    status VARCHAR(20) NOT NULL DEFAULT 'new', -- new, acknowledged, resolved, false_positive
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMP,
    resolved_at TIMESTAMP,
    resolution_note TEXT,
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 异常模式库
CREATE TABLE anomaly_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_hash VARCHAR(64) NOT NULL UNIQUE,
    pattern_type VARCHAR(50) NOT NULL,
    first_seen TIMESTAMP NOT NULL,
    last_seen TIMESTAMP NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    is_known BOOLEAN NOT NULL DEFAULT FALSE,
    known_since TIMESTAMP,
    resolution_strategy TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 异常统计视图
CREATE VIEW anomaly_statistics AS
SELECT 
    service,
    type,
    DATE_TRUNC('hour', detected_at) AS hour,
    COUNT(*) AS anomaly_count,
    AVG(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_rate,
    AVG(CASE WHEN status = 'false_positive' THEN 1 ELSE 0 END) AS false_positive_rate
FROM log_anomalies
WHERE detected_at > NOW() - INTERVAL '7 days'
GROUP BY service, type, DATE_TRUNC('hour', detected_at);

-- 索引
CREATE INDEX idx_log_anomalies_detected_at ON log_anomalies(detected_at DESC);
CREATE INDEX idx_log_anomalies_service ON log_anomalies(service);
CREATE INDEX idx_log_anomalies_type_severity ON log_anomalies(type, severity);
CREATE INDEX idx_log_anomalies_status ON log_anomalies(status);
CREATE INDEX idx_anomaly_patterns_hash ON anomaly_patterns(pattern_hash);

COMMENT ON TABLE log_anomalies IS '实时检测到的日志异常记录';
COMMENT ON TABLE anomaly_patterns IS '已识别的异常模式库';
```

### 4.6 Prometheus 指标

```javascript
// backend/shared/metrics.js 新增
const logAnomaliesDetected = new Counter({
  name: 'log_anomalies_detected_total',
  help: 'Number of log anomalies detected',
  labelNames: ['type', 'severity', 'service']
});

const logAnomalyProcessingTime = new Histogram({
  name: 'log_anomaly_processing_time_ms',
  help: 'Time to process a log entry for anomaly detection',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500]
});

const logStreamBufferSize = new Gauge({
  name: 'log_stream_buffer_size',
  help: 'Current size of log stream buffer'
});

const alertCorrelationCount = new Counter({
  name: 'alert_correlation_total',
  help: 'Number of alerts correlated',
  labelNames: ['correlation_type']
});
```

## 5. 验收标准（可测试）

- [ ] 日志流处理器启动后能订阅所有微服务日志
- [ ] 错误突增检测器在错误率突增 3x 时触发告警，延迟 < 100ms
- [ ] 新错误模式在首次出现 10 秒内发出通知
- [ ] 延迟异常检测器在 P99 延迟超过基线 3 sigma 时告警
- [ ] 告警关联器将同一服务 5 分钟内异常合并为一条
- [ ] 因果链推断正确识别错误 -> 延迟 -> 用户影响的关系
- [ ] WebSocket 推送延迟 < 500ms
- [ ] 误报率 < 5%（基于人工标注验证）
- [ ] Prometheus 指标正确导出（log_anomalies_detected_total）
- [ ] Admin Dashboard 显示实时异常仪表板
- [ ] 单元测试覆盖率 > 80%
- [ ] 压力测试：支持 10000 条/秒日志处理

## 6. 工作量估算

**估算：L（Large）**

理由：
- 涉及日志流处理、多维度异常检测、告警关联等多个复杂模块
- 需要与现有 Kafka、Prometheus、WebSocket 集成
- 算法设计（泊松分布、EWMA）需要调优
- 前端仪表板开发

预计工时：5-7 人天

## 7. 优先级理由

**P1 理由：**

1. **可观测性核心能力**：日志异常检测是可观测性体系的关键组成部分，直接影响故障发现速度

2. **生产价值高**：可显著降低 MTTR，提升系统可靠性

3. **现有基础完善**：已有结构化日志、Prometheus 集成，实现成本可控

4. **依赖关系**：为 REQ-00358（服务健康聚合）提供输入数据

---

创建时间：2026-06-29 19:00 UTC
