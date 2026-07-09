# REQ-00517：错误智能分析与根因定位系统

- **编号**：REQ-00517
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/errorAnalysis、gateway/middleware、backend/jobs、infrastructure/monitoring
- **创建时间**：2026-07-09 00:00
- **依赖需求**：REQ-00501（日志适配器层）

## 1. 背景与问题

当前 mineGo 项目有完善的错误处理体系（ErrorCodes、AppError、国际化错误消息），但在生产环境面临以下问题：

**错误聚合与分析缺失**
- 相同根因的错误以不同形式表现，无法自动聚合（如数据库连接超时可能导致 10+ 种错误）
- 缺乏错误堆栈的智能分析，开发人员需要手动阅读大量日志定位问题
- 错误趋势分析依赖人工，无法及时发现异常峰值

**根因定位困难**
- 错误发生时，缺少关键上下文（用户操作链路、最近部署版本、配置变更）
- 无法自动关联错误与可能的根因（如部署、流量突增、依赖服务故障）
- 排查问题时需要在多个系统间切换（日志、监控、部署记录）

**告警噪音严重**
- 所有错误都触发告警，导致告警疲劳
- 重复错误反复告警，缺乏智能降噪
- 无法区分已知问题和新问题，处理优先级不清晰

**代码层面痛点**
- 1900+ 处 throw/catch 分散在各服务，缺少统一追踪
- 错误上下文信息不足，无法还原用户场景
- 缺少错误码使用情况的统计分析，无法识别高频错误

## 2. 目标

构建一套错误智能分析与根因定位系统，实现：

1. **智能错误聚合**：基于错误码、堆栈指纹、上下文相似度，自动聚合相同根因的错误
2. **根因智能定位**：关联错误与最近部署、配置变更、依赖服务状态，自动推荐可能根因
3. **趋势异常检测**：实时监控错误发生率，自动检测异常峰值并触发告警
4. **上下文快照**：错误发生时自动保存完整上下文（请求参数、用户状态、调用链路）
5. **智能降噪**：已知问题自动分类，避免重复告警；新问题优先处理

**可量化目标**：
- 错误排查时间缩短 50%（从平均 30 分钟降至 15 分钟）
- 告警噪音减少 60%（通过智能聚合和降噪）
- 根因定位准确率 ≥ 80%

## 3. 范围

### 包含
- 错误堆栈指纹生成与相似度计算算法
- 错误聚合引擎（支持多种聚合维度：错误码、服务、堆栈）
- 根因分析引擎（关联部署记录、配置变更、依赖服务）
- 错误趋势分析与异常检测（基于统计模型）
- 错误上下文快照管理（请求参数、用户信息、调用链路）
- 智能告警系统（支持降噪、分级、聚合）
- 错误分析 Dashboard（聚合视图、趋势图、根因推荐）
- 错误码使用统计与优化建议

### 不包含
- 分布式追踪系统的实现（依赖现有 OpenTelemetry/Jaeger）
- APM 性能分析（由 REQ-00502 负责）
- 用户行为分析（由 BI 系统负责）
- 自动修复功能（仅提供建议）

## 4. 详细需求

### 4.1 错误堆栈指纹生成器（StackFingerprintGenerator）

**核心类：`backend/shared/errorAnalysis/StackFingerprintGenerator.js`**

```javascript
/**
 * 错误堆栈指纹生成器
 * 
 * 功能：
 * - 解析错误堆栈，提取关键帧
 * - 生成唯一指纹（去除动态部分）
 * - 计算堆栈相似度
 */
class StackFingerprintGenerator {
  constructor(config = {}) {
    this.maxFrames = config.maxFrames || 10;  // 最多分析帧数
    this.minFrames = config.minFrames || 3;   // 最少关键帧数
    this.ignorePatterns = config.ignorePatterns || [
      /node_modules/,
      /internal\/process/,
      /\.next\//,
      /dist\//
    ];
  }

  /**
   * 生成错误指纹
   * @param {Error} error - 错误对象
   * @returns {Object} 指纹对象
   */
  generate(error) {
    const stack = error.stack || '';
    const frames = this._parseStack(stack);
    const keyFrames = this._extractKeyFrames(frames);
    
    return {
      fingerprint: this._hashFrames(keyFrames),
      keyFrames: keyFrames,
      messagePattern: this._normalizeMessage(error.message),
      errorName: error.name,
      frameCount: frames.length,
      keyFrameCount: keyFrames.length
    };
  }

  /**
   * 计算两个错误相似度
   * @param {Object} fp1 - 指纹1
   * @param {Object} fp2 - 指纹2
   * @returns {number} 相似度 [0-1]
   */
  similarity(fp1, fp2) {
    // 实现基于关键帧的相似度计算
  }
}
```

### 4.2 错误聚合引擎（ErrorAggregator）

**核心类：`backend/shared/errorAnalysis/ErrorAggregator.js`**

```javascript
/**
 * 错误聚合引擎
 * 
 * 聚合维度：
 * 1. 按错误码聚合
 * 2. 按堆栈指纹聚合
 * 3. 按服务 + 错误码聚合
 * 4. 自定义维度聚合
 */
class ErrorAggregator {
  constructor(config = {}) {
    this.similarityThreshold = config.similarityThreshold || 0.85;
    this.aggregationWindowMs = config.aggregationWindowMs || 300000; // 5分钟
    this.maxGroupSize = config.maxGroupSize || 1000;
  }

  /**
   * 聚合错误
   * @param {Object} errorEvent - 错误事件
   * @returns {Object} 聚合结果（包含聚合组ID）
   */
  aggregate(errorEvent) {
    // 1. 提取指纹
    // 2. 查找相似聚合组
    // 3. 添加到聚合组或创建新组
    // 4. 更新聚合统计
  }

  /**
   * 获取聚合组详情
   * @param {string} groupId - 聚合组ID
   * @returns {Object} 聚合组详情
   */
  getGroup(groupId) {
    // 返回：样本错误、发生次数、首次/最后发生时间、影响用户数
  }

  /**
   * 获取活跃聚合组列表
   * @param {Object} filters - 过滤条件
   * @returns {Array} 聚合组列表
   */
  getActiveGroups(filters = {}) {
    // 支持按：服务、错误码、时间范围、状态过滤
  }
}
```

### 4.3 根因分析引擎（RootCauseAnalyzer）

**核心类：`backend/shared/errorAnalysis/RootCauseAnalyzer.js`**

```javascript
/**
 * 根因分析引擎
 * 
 * 分析策略：
 * 1. 时间关联：错误发生前是否有部署、配置变更
 * 2. 因果关联：上游服务故障导致下游错误
 * 3. 流量关联：错误率上升是否伴随流量突增
 * 4. 历史模式：匹配已知错误模式
 */
class RootCauseAnalyzer {
  constructor(dependencies) {
    this.deploymentClient = dependencies.deploymentClient;  // CI/CD API
    this.configClient = dependencies.configClient;          // Config Center
    this.serviceClient = dependencies.serviceClient;        // Service Registry
    this.metricsClient = dependencies.metricsClient;        // Prometheus
  }

  /**
   * 分析错误根因
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Object} 根因分析结果
   */
  async analyze(errorGroup) {
    const causes = [];

    // 1. 检查最近部署
    const recentDeployments = await this._checkRecentDeployments(errorGroup);
    if (recentDeployments.length > 0) {
      causes.push({
        type: 'deployment',
        confidence: 0.8,
        details: recentDeployments
      });
    }

    // 2. 检查依赖服务状态
    const dependentFailures = await this._checkDependencies(errorGroup);
    if (dependentFailures.length > 0) {
      causes.push({
        type: 'dependency',
        confidence: 0.9,
        details: dependentFailures
      });
    }

    // 3. 检查配置变更
    const configChanges = await this._checkConfigChanges(errorGroup);
    if (configChanges.length > 0) {
      causes.push({
        type: 'config_change',
        confidence: 0.7,
        details: configChanges
      });
    }

    // 4. 检查历史模式
    const historicalMatch = await this._matchHistoricalPattern(errorGroup);
    if (historicalMatch) {
      causes.push({
        type: 'known_issue',
        confidence: 0.95,
        details: historicalMatch
      });
    }

    return {
      errorGroup: errorGroup.id,
      causes: causes.sort((a, b) => b.confidence - a.confidence),
      recommendation: this._generateRecommendation(causes)
    };
  }
}
```

### 4.4 错误趋势分析器（ErrorTrendAnalyzer）

**核心类：`backend/shared/errorAnalysis/ErrorTrendAnalyzer.js`**

```javascript
/**
 * 错误趋势分析器
 * 
 * 功能：
 * - 实时监控错误发生率
 * - 异常峰值检测（基于统计模型）
 * - 趋势预测
 */
class ErrorTrendAnalyzer {
  constructor(config = {}) {
    this.windowSize = config.windowSize || 60;  // 统计窗口大小（秒）
    this.baselineWindow = config.baselineWindow || 3600; // 基线窗口（秒）
    this.anomalyThreshold = config.anomalyThreshold || 3.0; // 异常阈值（标准差倍数）
  }

  /**
   * 检测异常
   * @param {string} service - 服务名称
   * @param {string} errorCode - 错误码（可选）
   * @returns {Object} 异常检测结果
   */
  async detectAnomaly(service, errorCode = null) {
    // 1. 获取当前错误率
    const currentRate = await this._getCurrentRate(service, errorCode);
    
    // 2. 获取历史基线
    const baseline = await this._getBaseline(service, errorCode);
    
    // 3. 计算Z-score
    const zScore = (currentRate - baseline.mean) / baseline.stdDev;
    
    // 4. 判断是否异常
    const isAnomaly = Math.abs(zScore) > this.anomalyThreshold;
    
    return {
      service,
      errorCode,
      currentRate,
      baseline,
      zScore,
      isAnomaly,
      severity: this._calculateSeverity(zScore)
    };
  }

  /**
   * 获取趋势预测
   * @param {string} service - 服务名称
   * @param {number} horizonMinutes - 预测时间范围（分钟）
   * @returns {Object} 预测结果
   */
  async predictTrend(service, horizonMinutes = 30) {
    // 使用简单移动平均或指数平滑预测
  }
}
```

### 4.5 错误上下文快照管理器（ErrorContextSnapshot）

**核心类：`backend/shared/errorAnalysis/ErrorContextSnapshot.js`**

```javascript
/**
 * 错误上下文快照管理器
 * 
 * 保存内容：
 * - 请求参数（敏感信息脱敏）
 * - 用户信息（ID、等级、设备）
 * - 调用链路（Trace ID、Span ID）
 * - 环境信息（版本、配置、环境变量）
 * - 系统状态（内存、CPU、连接池）
 */
class ErrorContextSnapshot {
  constructor(config = {}) {
    this.retentionMs = config.retentionMs || 604800000; // 7天
    this.maxSnapshotsPerGroup = config.maxSnapshotsPerGroup || 10;
    this.sensitiveFields = config.sensitiveFields || [
      'password', 'token', 'secret', 'apiKey', 'creditCard'
    ];
  }

  /**
   * 保存错误上下文快照
   * @param {Object} errorEvent - 错误事件
   * @param {Object} context - 上下文信息
   * @returns {string} 快照ID
   */
  async save(errorEvent, context) {
    const snapshot = {
      id: this._generateId(),
      timestamp: new Date().toISOString(),
      error: {
        name: errorEvent.name,
        code: errorEvent.code,
        message: errorEvent.message,
        stack: errorEvent.stack
      },
      request: this._sanitizeRequest(context.request),
      user: this._extractUserInfo(context.user),
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId
      },
      environment: {
        serviceVersion: process.env.SERVICE_VERSION,
        nodeEnv: process.env.NODE_ENV,
        hostname: process.env.HOSTNAME,
        region: process.env.REGION
      },
      system: await this._collectSystemMetrics()
    };

    // 保存到 Redis 或 PostgreSQL
    await this._store(snapshot);

    return snapshot.id;
  }

  /**
   * 敏感信息脱敏
   * @param {Object} request - 请求对象
   * @returns {Object} 脱敏后的请求
   */
  _sanitizeRequest(request) {
    const sanitized = { ...request };
    
    // 脱敏敏感字段
    for (const field of this.sensitiveFields) {
      if (sanitized.body && sanitized.body[field]) {
        sanitized.body[field] = '***REDACTED***';
      }
      if (sanitized.headers && sanitized.headers[field]) {
        sanitized.headers[field] = '***REDACTED***';
      }
    }

    return sanitized;
  }
}
```

### 4.6 智能告警系统（IntelligentAlerting）

**核心类：`backend/shared/errorAnalysis/IntelligentAlerting.js`**

```javascript
/**
 * 智能告警系统
 * 
 * 特性：
 * - 告警聚合：相同根因错误只发送一条告警
 * - 告警降噪：已知问题降低优先级
 * - 分级告警：根据错误严重程度和影响范围分级
 * - 告警抑制：维护窗口期间抑制非关键告警
 */
class IntelligentAlerting {
  constructor(config) {
    this.alertChannels = config.channels;  // Slack, Email, SMS
    this.cooldownMs = config.cooldownMs || 300000; // 5分钟冷却
    this.escalationRules = config.escalationRules;
  }

  /**
   * 发送智能告警
   * @param {Object} errorGroup - 错误聚合组
   * @param {Object} rootCause - 根因分析结果
   */
  async alert(errorGroup, rootCause) {
    // 1. 检查冷却期
    if (await this._isInCooldown(errorGroup)) {
      return;
    }

    // 2. 确定告警级别
    const severity = this._calculateSeverity(errorGroup, rootCause);

    // 3. 构建告警消息
    const alert = {
      id: this._generateAlertId(),
      errorGroup: errorGroup.id,
      title: this._generateTitle(errorGroup, rootCause),
      severity,
      summary: {
        occurrences: errorGroup.count,
        affectedUsers: errorGroup.affectedUsers,
        firstSeen: errorGroup.firstSeen,
        lastSeen: errorGroup.lastSeen,
        service: errorGroup.service
      },
      rootCause: rootCause.causes[0],
      actions: this._recommendActions(errorGroup, rootCause),
      snapshotUrl: this._generateSnapshotUrl(errorGroup)
    };

    // 4. 发送告警
    await this._send(alert);

    // 5. 更新冷却状态
    await this._setCooldown(errorGroup);
  }

  /**
   * 计算告警级别
   * @param {Object} errorGroup - 错误聚合组
   * @param {Object} rootCause - 根因分析结果
   * @returns {string} critical/high/medium/low
   */
  _calculateSeverity(errorGroup, rootCause) {
    // P0: 影响用户 > 1000 或支付相关错误
    // P1: 影响用户 > 100 或核心功能不可用
    // P2: 影响用户 > 10 或新问题
    // P3: 已知问题或影响小
  }
}
```

### 4.7 错误分析 Dashboard API

**网关路由：`gateway/src/routes/errorAnalysis.js`**

```javascript
/**
 * 错误分析 Dashboard API
 * 
 * GET /api/error-analysis/groups
 * - 获取活跃错误聚合组列表
 * - 查询参数：service, errorCode, status, timeRange
 * 
 * GET /api/error-analysis/groups/:groupId
 * - 获取聚合组详情（样本错误、趋势图、根因）
 * 
 * GET /api/error-analysis/groups/:groupId/snapshots
 * - 获取聚合组的上下文快照列表
 * 
 * GET /api/error-analysis/groups/:groupId/snapshots/:snapshotId
 * - 获取单个快照详情
 * 
 * POST /api/error-analysis/groups/:groupId/resolve
 * - 标记聚合组为已解决
 * - 参数：resolution, assignee
 * 
 * GET /api/error-analysis/trends
 * - 获取错误趋势数据
 * - 查询参数：service, errorCode, granularity
 * 
 * GET /api/error-analysis/statistics
 * - 获取错误统计数据（按服务、错误码分组）
 * 
 * GET /api/error-analysis/error-codes
 * - 获取错误码使用统计
 * - 返回：使用频率、关联问题数、优化建议
 */
```

### 4.8 定时任务

**任务：`backend/jobs/errorAnalysisJobs.js`**

```javascript
/**
 * 错误分析相关定时任务
 * 
 * 1. 每分钟检测异常峰值
 * 2. 每5分钟聚合最近错误
 * 3. 每小时生成错误统计报告
 * 4. 每天清理过期快照
 * 5. 每周生成错误趋势报告
 */
```

### 4.9 数据库设计

**迁移文件：`database/migrations/YYYYMMDDHHMMSS-create-error-analysis-tables.js`**

```sql
-- 错误聚合组表
CREATE TABLE error_groups (
  id VARCHAR(36) PRIMARY KEY,
  fingerprint VARCHAR(64) NOT NULL,
  error_code VARCHAR(64),
  error_name VARCHAR(128),
  message_pattern TEXT,
  key_frames JSONB,
  service VARCHAR(64) NOT NULL,
  status VARCHAR(32) DEFAULT 'active',
  first_seen TIMESTAMP NOT NULL,
  last_seen TIMESTAMP NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  affected_users INTEGER DEFAULT 0,
  root_cause JSONB,
  resolution TEXT,
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_error_groups_fingerprint ON error_groups(fingerprint);
CREATE INDEX idx_error_groups_service ON error_groups(service);
CREATE INDEX idx_error_groups_status ON error_groups(status);
CREATE INDEX idx_error_groups_first_seen ON error_groups(first_seen);
CREATE INDEX idx_error_groups_last_seen ON error_groups(last_seen);

-- 错误事件表
CREATE TABLE error_events (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id),
  error_code VARCHAR(64),
  error_name VARCHAR(128),
  message TEXT,
  stack_trace TEXT,
  service VARCHAR(64) NOT NULL,
  user_id VARCHAR(64),
  request_id VARCHAR(64),
  trace_id VARCHAR(64),
  occurred_at TIMESTAMP NOT NULL,
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_error_events_group_id ON error_events(group_id);
CREATE INDEX idx_error_events_occurred_at ON error_events(occurred_at);
CREATE INDEX idx_error_events_user_id ON error_events(user_id);

-- 错误快照表
CREATE TABLE error_snapshots (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id),
  error_event_id VARCHAR(36) REFERENCES error_events(id),
  request JSONB,
  user JSONB,
  trace JSONB,
  environment JSONB,
  system JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_error_snapshots_group_id ON error_snapshots(group_id);
CREATE INDEX idx_error_snapshots_expires_at ON error_snapshots(expires_at);

-- 根因分析历史表
CREATE TABLE root_cause_analyses (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id),
  causes JSONB NOT NULL,
  recommendation TEXT,
  analyzed_at TIMESTAMP DEFAULT NOW(),
  analyzed_by VARCHAR(64) DEFAULT 'system'
);

-- 告警记录表
CREATE TABLE error_alerts (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) REFERENCES error_groups(id),
  severity VARCHAR(32) NOT NULL,
  channel VARCHAR(32) NOT NULL,
  sent_at TIMESTAMP NOT NULL,
  acknowledged_at TIMESTAMP,
  acknowledged_by VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_error_alerts_group_id ON error_alerts(group_id);
CREATE INDEX idx_error_alerts_sent_at ON error_alerts(sent_at);
```

## 5. 验收标准（可测试）

- [ ] 错误堆栈指纹生成准确率 ≥ 95%（相同根因错误指纹一致）
- [ ] 错误聚合引擎能正确聚合 ≥ 90% 的相同根因错误
- [ ] 根因分析引擎推荐准确率 ≥ 80%（Top 3 推荐中包含真实根因）
- [ ] 异常检测误报率 < 5%，召回率 ≥ 90%
- [ ] 错误上下文快照保存成功率 ≥ 99%
- [ ] 敏感信息（密码、令牌）正确脱敏率 100%
- [ ] 智能告警降噪效果：重复告警减少 ≥ 60%
- [ ] Dashboard API 响应时间 < 500ms（P95）
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 集成测试覆盖核心场景：错误捕获 → 聚合 → 根因分析 → 告警

## 6. 工作量估算

**估算：XL（预计 8-10 人天）**

**理由**：
- 涉及多个核心模块：指纹生成、聚合引擎、根因分析、趋势检测
- 需要集成多个外部系统：部署平台、配置中心、监控系统
- 数据库设计复杂，包含多张关联表
- 告警系统需要对接多个渠道
- Dashboard API 涉及大量查询和聚合逻辑
- 需要处理大量历史数据和实时数据

**分解**：
- 错误堆栈指纹生成器：1 人天
- 错误聚合引擎：2 人天
- 根因分析引擎：2 人天
- 趋势分析器：1 人天
- 上下文快照管理：1 人天
- 智能告警系统：1 人天
- Dashboard API：1 人天
- 数据库迁移与测试：1 人天

## 7. 优先级理由

**P1 - 高优先级**

**理由**：
1. **生产环境必需**：当前生产环境错误排查效率低，影响系统稳定性
2. **降本增效**：减少开发人员排查问题时间，提升运维效率
3. **用户影响**：快速定位错误有助于减少用户受影响时间
4. **技术债务**：当前缺少系统化的错误管理，属于重要技术债
5. **成熟度提升**：错误智能分析是生产可用系统的重要标志

**对"项目可用"的贡献**：
- 提升运维团队效率 50%+
- 减少生产事故恢复时间 30%+
- 提升系统成熟度评分（可观测性 +2 分）
