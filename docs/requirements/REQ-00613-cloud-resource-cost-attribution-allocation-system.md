# REQ-00613：云资源成本归因与分摊精细化系统

- **编号**：REQ-00613
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/costAttribution、admin-dashboard、Kubernetes
- **创建时间**：2026-07-20 16:00
- **依赖需求**：REQ-00040（云成本监控与预算告警）

## 1. 背景与问题

### 现状
mineGo 项目已实现基础的成本监控（REQ-00040），包括：
- `CloudCostCollector`：采集云服务商成本数据
- `CostMonitor`：定时监控与预测
- `BudgetManager`：预算管理与告警

### 问题
当前系统存在以下痛点：

1. **成本归因粒度粗糙**
   - 只能追踪到云服务商级别（AWS/GCP/Azure）
   - 无法精确识别哪个微服务消耗了多少资源
   - 成本数据与业务逻辑脱节

2. **多租户成本分摊困难**
   - 不同地区用户（中国/美国/欧洲）的资源成本无法区分
   - 无法按业务线（PvP/社交/支付）分摊成本
   - 缺乏成本责任归属机制

3. **资源浪费难以识别**
   - 无法发现闲置资源（未充分利用的 Pod、存储卷）
   - 无法识别异常成本飙升（如某个服务突然占用大量 CPU）
   - 缺乏成本优化建议

4. **成本数据孤岛**
   - Kubernetes 资源使用数据与云账单数据分离
   - 缺乏统一的成本视图
   - 难以进行成本趋势分析

### 影响
- 运维团队无法回答"这个功能成本多少？"
- 无法有效控制成本增长
- 资源浪费无法及时发现
- 预算分配缺乏数据支撑

## 2. 目标

### 核心目标
构建云资源成本归因与分摊精细化系统，实现：

1. **精准成本归因**
   - 按**服务**、**地区**、**环境**、**业务线**四个维度归因成本
   - 归因准确率 ≥ 95%
   - 成本数据延迟 < 5 分钟

2. **智能成本分摊**
   - 支持多租户成本分摊策略
   - 自动生成分摊报告（日报/周报/月报）
   - 支持自定义分摊规则

3. **成本异常检测**
   - 自动识别成本异常飙升
   - 检测资源浪费（CPU/内存/存储利用率 < 20%）
   - 提供优化建议

4. **统一成本视图**
   - 整合 Kubernetes 资源使用与云账单数据
   - 提供可视化成本仪表板
   - 支持成本趋势分析

### 可量化目标
- 成本归因覆盖率：**≥ 95%**
- 成本异常检测准确率：**≥ 90%**
- 资源浪费识别率：**≥ 80%**
- 成本报告生成时间：**< 10 秒**
- 成本优化建议采纳率：**≥ 30%**

## 3. 范围

### 包含

**Phase 1: 成本归因引擎**
- 实现多维度成本归因算法
- 集成 Kubernetes 资源使用数据（通过 Prometheus）
- 集成云服务商账单数据（AWS Cost Explorer API、GCP Billing API）
- 实现成本标签（Tag）管理

**Phase 2: 成本分摊系统**
- 实现多租户成本分摊策略
- 支持自定义分摊规则（按用户数、按请求量、按存储使用量）
- 自动生成分摊报告
- 提供 API 供其他系统查询成本数据

**Phase 3: 成本异常检测**
- 实现成本异常检测算法（基于历史数据、机器学习）
- 检测资源浪费（利用率低的 Pod、未挂载的存储卷）
- 提供优化建议（自动缩容、资源调整）

**Phase 4: 可视化与管理**
- 实现成本仪表板（admin-dashboard）
- 提供成本趋势分析图表
- 支持成本预算设置与告警
- 提供成本导出功能（CSV/JSON）

### 不包含

- **多云成本优化策略**：自动调整云服务商选择（后续需求）
- **实时成本控制**：超预算自动停止服务（需要人工确认）
- **成本预测模型**：基于机器学习的长期预测（后续需求）
- **跨云成本对比**：多云成本对比与迁移建议（后续需求）

## 4. 详细需求

### 4.1 成本归因引擎

#### 4.1.1 多维度归因算法

**归因维度**：
```javascript
const COST_DIMENSIONS = {
  SERVICE: 'service',      // 微服务维度（gateway, user-service, ...）
  REGION: 'region',        // 地区维度（cn-north, us-west, ...）
  ENVIRONMENT: 'env',      // 环境维度（production, staging, dev）
  BUSINESS_LINE: 'biz',    // 业务线维度（pvp, social, payment）
  RESOURCE_TYPE: 'type'    // 资源类型（compute, storage, network）
};
```

**归因算法**：
1. **直接归因**：资源有明确标签 → 直接归因到对应维度
2. **比例分摊**：共享资源（如共享数据库）→ 按使用比例分摊
3. **启发式归因**：无标签资源 → 根据命名规则、使用模式推断

**数据结构**：
```javascript
// 成本归因记录
{
  id: 'cost-record-001',
  timestamp: '2026-07-20T16:00:00Z',
  provider: 'aws',           // 云服务商
  service: 'user-service',   // 微服务
  region: 'us-west-2',       // 地区
  environment: 'production', // 环境
  businessLine: 'social',    // 业务线
  resourceType: 'compute',   // 资源类型
  amount: 123.45,            // 成本金额（USD）
  currency: 'USD',
  tags: {
    team: 'backend',
    project: 'minego'
  },
  usage: {
    cpu: 2.5,                // CPU 核数
    memory: 8,               // 内存 GB
    storage: 100,            // 存储 GB
    network: 50              // 网络流量 GB
  }
}
```

#### 4.1.2 Kubernetes 资源数据集成

**数据源**：
- Prometheus：CPU、内存、网络使用数据
- Kubernetes API：Pod、Deployment、StatefulSet 元数据
- 节点标签：地区、环境、实例类型

**采集策略**：
```javascript
// 每 5 分钟采集一次
const COLLECTION_INTERVAL = 300000; // 5 分钟

// 采集指标
const METRICS_TO_COLLECT = [
  'container_cpu_usage_seconds_total',
  'container_memory_working_set_bytes',
  'container_network_receive_bytes_total',
  'kube_pod_info',
  'kube_deployment_labels'
];
```

#### 4.1.3 云账单数据集成

**支持的云服务商**：
- AWS：通过 AWS Cost Explorer API
- GCP：通过 Cloud Billing API
- Azure：通过 Cost Management API

**数据同步策略**：
- 每小时同步一次账单数据
- 支持历史数据回填（最多 90 天）
- 自动检测账单更新并重新计算

### 4.2 成本分摊系统

#### 4.2.1 分摊策略

**策略类型**：
```javascript
const ALLOCATION_STRATEGIES = {
  EQUAL: 'equal',           // 平均分摊
  BY_USAGE: 'by_usage',     // 按使用量分摊
  BY_USERS: 'by_users',     // 按用户数分摊
  BY_REQUESTS: 'by_requests', // 按请求数分摊
  CUSTOM: 'custom'          // 自定义权重
};
```

**分摊规则示例**：
```javascript
{
  id: 'rule-001',
  name: '数据库成本分摊',
  resourceType: 'rds',
  strategy: 'by_usage',
  basis: {
    'user-service': 0.4,    // 40%
    'pokemon-service': 0.3, // 30%
    'catch-service': 0.2,   // 20%
    'social-service': 0.1   // 10%
  },
  createdAt: '2026-07-20T16:00:00Z',
  updatedAt: '2026-07-20T16:00:00Z'
}
```

#### 4.2.2 分摊报告生成

**报告格式**：
```javascript
{
  id: 'report-2026-07',
  period: {
    start: '2026-07-01',
    end: '2026-07-31'
  },
  granularity: 'daily', // daily, weekly, monthly
  totalCost: 12345.67,
  currency: 'USD',
  breakdown: {
    byService: [
      { service: 'user-service', cost: 2345.67, percentage: 19.0 },
      { service: 'pokemon-service', cost: 3456.78, percentage: 28.0 },
      ...
    ],
    byRegion: [
      { region: 'us-west-2', cost: 5678.90, percentage: 46.0 },
      ...
    ],
    byBusinessLine: [
      { businessLine: 'pvp', cost: 4567.89, percentage: 37.0 },
      ...
    ]
  },
  anomalies: [
    {
      service: 'catch-service',
      type: 'spike',
      severity: 'high',
      description: '成本较上周增长 150%',
      recommendation: '检查是否有异常流量或资源泄漏'
    }
  ],
  optimizations: [
    {
      resource: 'user-service-staging',
      type: 'underutilized',
      currentUsage: 15, // CPU 利用率 15%
      recommendation: '考虑缩减实例规格或合并到生产环境',
      estimatedSaving: 123.45
    }
  ]
}
```

### 4.3 成本异常检测

#### 4.3.1 异常检测算法

**检测类型**：
1. **成本飙升**：当前成本较历史均值增长超过阈值
2. **资源浪费**：资源利用率持续低于阈值
3. **预测偏离**：实际成本与预测成本偏差过大

**算法参数**：
```javascript
const ANOMALY_CONFIG = {
  costSpike: {
    threshold: 1.5,         // 超过历史均值 1.5 倍
    windowDays: 7,          // 基于过去 7 天数据
    minAbsoluteChange: 10   // 最小绝对变化 10 USD
  },
  resourceWaste: {
    cpuThreshold: 0.2,      // CPU 利用率 < 20%
    memoryThreshold: 0.2,   // 内存利用率 < 20%
    duration: '3d'          // 持续 3 天
  },
  forecastDeviation: {
    threshold: 0.3          // 偏差超过 30%
  }
};
```

#### 4.3.2 优化建议生成

**建议类型**：
- **缩容建议**：低利用率资源 → 缩小实例规格
- **合并建议**：多个低利用率资源 → 合并到一个实例
- **删除建议**：未使用的资源 → 删除以节省成本
- **预留实例建议**：稳定工作负载 → 购买预留实例

### 4.4 API 端点

#### 4.4.1 成本查询 API

```
GET /api/v1/cost/summary
  ?start=2026-07-01
  &end=2026-07-31
  &group_by=service,region
  &filter[service]=user-service,catch-service

Response:
{
  "total": 12345.67,
  "breakdown": {
    "service": [...],
    "region": [...]
  }
}
```

#### 4.4.2 分摊报告 API

```
POST /api/v1/cost/reports
{
  "period": {
    "start": "2026-07-01",
    "end": "2026-07-31"
  },
  "granularity": "daily",
  "strategy": "by_usage",
  "filters": {
    "service": ["user-service"]
  }
}

Response:
{
  "reportId": "report-2026-07",
  "status": "completed",
  "downloadUrl": "/api/v1/cost/reports/report-2026-07/download"
}
```

#### 4.4.3 异常检测 API

```
GET /api/v1/cost/anomalies
  ?severity=high
  &service=user-service

Response:
{
  "anomalies": [
    {
      "id": "anomaly-001",
      "type": "cost_spike",
      "service": "user-service",
      "severity": "high",
      "description": "成本较上周增长 150%",
      "detectedAt": "2026-07-20T15:30:00Z",
      "recommendation": "检查是否有异常流量"
    }
  ]
}
```

### 4.5 数据库设计

#### 4.5.1 成本记录表

```sql
CREATE TABLE cost_records (
  id VARCHAR(100) PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  provider VARCHAR(50) NOT NULL,
  service VARCHAR(100),
  region VARCHAR(50),
  environment VARCHAR(50),
  business_line VARCHAR(100),
  resource_type VARCHAR(50),
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  tags JSONB,
  usage JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 索引
  INDEX idx_cost_records_timestamp (timestamp),
  INDEX idx_cost_records_service (service),
  INDEX idx_cost_records_region (region),
  INDEX idx_cost_records_environment (environment)
);
```

#### 4.5.2 分摊规则表

```sql
CREATE TABLE cost_allocation_rules (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  resource_type VARCHAR(50),
  strategy VARCHAR(50) NOT NULL,
  basis JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by VARCHAR(100),
  
  -- 索引
  INDEX idx_allocation_rules_resource_type (resource_type)
);
```

#### 4.5.3 异常记录表

```sql
CREATE TABLE cost_anomalies (
  id VARCHAR(100) PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  service VARCHAR(100),
  region VARCHAR(50),
  severity VARCHAR(20) NOT NULL,
  description TEXT,
  detected_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  recommendation TEXT,
  metadata JSONB,
  
  -- 索引
  INDEX idx_cost_anomalies_service (service),
  INDEX idx_cost_anomalies_severity (severity),
  INDEX idx_cost_anomalies_detected_at (detected_at)
);
```

### 4.6 监控指标

**新增 Prometheus 指标**：
```javascript
// 成本指标
cost_total{provider, service, region, environment}        // 总成本
cost_by_business_line{business_line}                      // 业务线成本
cost_by_resource_type{resource_type}                       // 资源类型成本

// 异常指标
cost_anomalies_total{type, severity}                       // 异常数量
cost_waste_total{service, resource_type}                   // 浪费成本

// 归因指标
cost_attribution_coverage{service}                         // 归因覆盖率
cost_allocation_rules_total{strategy}                      // 分摊规则数量
```

## 5. 验收标准（可测试）

- [ ] **成本归因功能**
  - [ ] 能够按服务、地区、环境、业务线四个维度归因成本
  - [ ] 归因准确率 ≥ 95%（与实际账单对比）
  - [ ] 成本数据延迟 < 5 分钟

- [ ] **成本分摊功能**
  - [ ] 支持至少 5 种分摊策略（平均、按使用量、按用户数、按请求数、自定义）
  - [ ] 能够生成日报、周报、月报
  - [ ] 报告生成时间 < 10 秒

- [ ] **异常检测功能**
  - [ ] 能够检测成本飙升（阈值可配置）
  - [ ] 能够检测资源浪费（CPU/内存利用率 < 20%）
  - [ ] 异常检测准确率 ≥ 90%

- [ ] **API 功能**
  - [ ] 提供成本查询 API，支持多维度筛选和分组
  - [ ] 提供分摊报告 API，支持多种报告格式
  - [ ] 提供异常检测 API，返回异常列表和建议

- [ ] **数据集成**
  - [ ] 能够从 Prometheus 采集 Kubernetes 资源使用数据
  - [ ] 能够从 AWS/GCP/Azure 同步账单数据
  - [ ] 数据同步成功率达到 100%

- [ ] **监控指标**
  - [ ] 暴露至少 10 个成本相关的 Prometheus 指标
  - [ ] 指标数据准确、实时更新

- [ ] **测试覆盖**
  - [ ] 单元测试覆盖率 ≥ 80%
  - [ ] 集成测试覆盖核心流程
  - [ ] 提供测试数据和测试用例

- [ ] **文档**
  - [ ] API 文档完整（包含请求示例、响应示例）
  - [ ] 架构设计文档完整
  - [ ] 使用指南完整

## 6. 工作量估算

**估算**：XL（约 8-12 个工作日）

**理由**：
1. 需要集成多个数据源（Prometheus、AWS/GCP/Azure API）
2. 需要实现复杂的归因算法和分摊策略
3. 需要设计和实现多个数据库表
4. 需要实现多个 API 端点
5. 需要实现异常检测算法
6. 需要编写大量测试代码
7. 需要编写完整文档

**任务分解**：
- Phase 1（成本归因引擎）：3-4 天
- Phase 2（成本分摊系统）：2-3 天
- Phase 3（异常检测）：2-3 天
- Phase 4（API 与可视化）：1-2 天
- 测试与文档：1-2 天

## 7. 优先级理由

**优先级**：P1（高优先级）

**理由**：

1. **业务价值高**
   - 精确的成本归因和分摊是成本控制的基础
   - 可以帮助团队识别浪费，优化资源配置
   - 支持数据驱动的预算分配决策

2. **紧迫性强**
   - 项目已上线，成本开始快速增长
   - 当前无法回答"这个功能成本多少？"的问题
   - 缺乏成本异常检测，可能导致成本失控

3. **依赖关系**
   - 依赖 REQ-00040（云成本监控），该需求已完成
   - 不阻塞其他高优先级需求

4. **技术可行性**
   - 所有依赖的技术（Prometheus、云 API）都成熟可用
   - 团队有相关经验
   - 风险可控

5. **对"项目可用"的贡献**
   - 提升项目的成本可控性
   - 为持续运营提供数据支撑
   - 降低成本失控风险
