# REQ-00275：告警智能关联与根因分析系统

- **编号**：REQ-00275
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/alertCorrelator.js、infrastructure/k8s/monitoring、gateway
- **创建时间**：2026-06-22 01:00
- **依赖需求**：REQ-00005（Prometheus 告警规则与 Alertmanager 集成）

## 1. 背景与问题

当前 Alertmanager 配置（`infrastructure/k8s/monitoring/alertmanager.yml`）已实现：
- 基于 severity/priority 的告警分级
- 基本的抑制规则（ServiceDown 抑制同服务其他告警）
- 多渠道通知（钉钉/Slack/邮件）

但存在以下关键缺口：

1. **缺少告警关联分析**：多个告警可能由同一根因触发，但无法自动识别关联关系
2. **缺少根因推断**：运维人员需要手动分析告警链路，定位根本原因耗时
3. **缺少告警拓扑图**：无法可视化展示告警之间的依赖关系和传播路径
4. **缺少智能降噪**：抑制规则是静态的，无法基于历史数据动态调整
5. **缺少告警聚类**：相似告警无法自动聚合，告警风暴时难以处理

**实际痛点**：
- 数据库连接池耗尽时，会触发 20+ 个下游服务告警，运维需要逐个排查
- 网络抖动导致批量告警，难以区分真实故障和瞬时抖动
- 微服务依赖链路复杂，根因定位平均耗时 15+ 分钟

## 2. 目标

构建告警智能关联与根因分析系统：

1. **告警关联引擎**：基于服务拓扑、时间窗口、因果规则自动关联相关告警
2. **根因推断算法**：使用因果图分析推断最可能的根因告警
3. **告警聚类器**：相似告警自动聚合，减少告警噪音 70%
4. **告警拓扑可视化**：生成告警传播图，展示根因→影响链路
5. **智能降噪策略**：基于历史告警数据动态调整抑制规则

**预期收益**：
- 平均根因定位时间从 15 分钟降低到 2 分钟
- 告警噪音减少 70%（通过聚类和智能降噪）
- 运维效率提升 3 倍（快速定位根因）
- 减少告警疲劳，提升团队响应质量

## 3. 范围

### 包含
- 告警关联分析引擎（AlertCorrelator）
- 根因推断算法（CausalGraph）
- 告警聚类器（AlertClusterer）
- 告警拓扑图生成器（AlertTopology）
- 智能降噪策略管理器（NoiseReducer）
- 与 Alertmanager Webhook 集成
- REST API 查询接口
- Grafana 告警拓扑面板

### 不包含
- 告警发送渠道（已有 Alertmanager 处理）
- 指标采集（已有 Prometheus）
- 日志分析（已有 Loki）
- APM 追踪（已有 Jaeger）

## 4. 详细需求

### 4.1 架构设计

```
┌─────────────────┐     ┌──────────────────┐
│  Alertmanager   │────▶│  Webhook Receiver │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────┐
│           Alert Correlator Service           │
├─────────────────────────────────────────────┤
│  ┌─────────────┐  ┌───────────────────────┐  │
│  │ Correlation │  │  Causal Inference     │  │
│  │   Engine    │──│      Engine           │  │
│  └─────────────┘  └───────────────────────┘  │
│  ┌─────────────┐  ┌───────────────────────┐  │
│  │  Clusterer  │  │   Noise Reducer       │  │
│  └─────────────┘  └───────────────────────┘  │
│  ┌─────────────────────────────────────────┐ │
│  │      Topology Generator                 │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────┐
│         Storage (Redis + PostgreSQL)         │
└─────────────────────────────────────────────┘
```

### 4.2 核心模块设计

#### 4.2.1 告警关联引擎（AlertCorrelator）

```javascript
// backend/shared/alertCorrelator.js
class AlertCorrelator {
  constructor(config) {
    this.serviceTopology = config.serviceTopology; // 服务依赖图
    this.correlationRules = config.correlationRules; // 关联规则
    this.timeWindowMs = config.timeWindowMs || 60000; // 时间窗口
    this.alertGroups = new Map(); // 告警分组
  }

  /**
   * 关联分析
   * @param {Alert} alert - 新告警
   * @returns {CorrelationResult} - 关联结果
   */
  correlate(alert) {
    const correlations = [];
    
    // 1. 基于服务拓扑关联
    const topologyCorrelations = this.correlateByTopology(alert);
    correlations.push(...topologyCorrelations);
    
    // 2. 基于时间窗口关联
    const timeCorrelations = this.correlateByTime(alert);
    correlations.push(...timeCorrelations);
    
    // 3. 基于规则关联
    const ruleCorrelations = this.correlateByRules(alert);
    correlations.push(...ruleCorrelations);
    
    // 4. 计算关联强度
    return this.calculateCorrelationScore(alert, correlations);
  }

  /**
   * 基于服务拓扑关联
   */
  correlateByTopology(alert) {
    const serviceName = alert.labels.service;
    const dependencies = this.serviceTopology.getDependencies(serviceName);
    const dependents = this.serviceTopology.getDependents(serviceName);
    
    // 查找上下游服务的活跃告警
    const relatedAlerts = this.findActiveAlerts([...dependencies, ...dependents]);
    
    return relatedAlerts.map(related => ({
      alert: related,
      type: 'topology',
      relation: dependencies.includes(related.labels.service) ? 'upstream' : 'downstream',
      score: 0.8 // 拓扑关联基础分
    }));
  }

  /**
   * 基于时间窗口关联
   */
  correlateByTime(alert) {
    const timeWindow = Date.now() - this.timeWindowMs;
    const recentAlerts = this.getRecentAlerts(timeWindow);
    
    return recentAlerts
      .filter(a => a.fingerprint !== alert.fingerprint)
      .map(related => ({
        alert: related,
        type: 'temporal',
        timeDiff: alert.startsAt - related.startsAt,
        score: this.calculateTemporalScore(alert, related)
      }));
  }
}
```

#### 4.2.2 根因推断引擎（CausalInferenceEngine）

```javascript
class CausalInferenceEngine {
  constructor(config) {
    this.causalRules = this.loadCausalRules();
    this.severityWeights = {
      'ServiceDown': 1.0,
      'DatabaseConnectionPoolExhausted': 0.95,
      'HighErrorRate': 0.8,
      'HighLatency': 0.6,
      'LowCacheHitRate': 0.4
    };
  }

  /**
   * 推断根因
   * @param {Alert[]} alerts - 相关告警列表
   * @returns {RootCauseResult} - 根因分析结果
   */
  inferRootCause(alerts) {
    // 1. 构建因果图
    const causalGraph = this.buildCausalGraph(alerts);
    
    // 2. 计算每个告警的根因概率
    const rootCauseProbabilities = this.calculateProbabilities(causalGraph);
    
    // 3. 选择最可能的根因
    const rootCause = this.selectRootCause(rootCauseProbabilities);
    
    // 4. 生成影响链路
    const impactChain = this.traceImpactChain(causalGraph, rootCause);
    
    return {
      rootCause,
      confidence: rootCauseProbabilities.get(rootCause.fingerprint),
      impactChain,
      affectedServices: this.getAffectedServices(impactChain),
      suggestedActions: this.getSuggestedActions(rootCause)
    };
  }

  /**
   * 构建因果图
   */
  buildCausalGraph(alerts) {
    const graph = new Map();
    
    for (const alert of alerts) {
      const causes = this.identifyPotentialCauses(alert, alerts);
      graph.set(alert.fingerprint, {
        alert,
        causes,
        effects: []
      });
    }
    
    // 建立双向关系
    for (const [fingerprint, node] of graph) {
      for (const cause of node.causes) {
        const causeNode = graph.get(cause.fingerprint);
        if (causeNode) {
          causeNode.effects.push(node.alert);
        }
      }
    }
    
    return graph;
  }

  /**
   * 识别潜在原因
   */
  identifyPotentialCauses(alert, allAlerts) {
    const causes = [];
    
    // 规则1: 服务宕机是其他告警的根因
    if (alert.labels.alertname !== 'ServiceDown') {
      const serviceDown = allAlerts.find(a => 
        a.labels.alertname === 'ServiceDown' &&
        a.labels.service === alert.labels.service
      );
      if (serviceDown) causes.push(serviceDown);
    }
    
    // 规则2: 数据库问题是服务问题的根因
    if (this.isServiceAlert(alert)) {
      const dbAlerts = allAlerts.filter(a => 
        this.isDatabaseAlert(a) &&
        this.isRelated(alert, a)
      );
      causes.push(...dbAlerts);
    }
    
    // 规则3: 基础设施问题是应用问题的根因
    if (this.isApplicationAlert(alert)) {
      const infraAlerts = allAlerts.filter(a => 
        this.isInfrastructureAlert(a) &&
        this.isRelated(alert, a)
      );
      causes.push(...infraAlerts);
    }
    
    return causes;
  }
}
```

#### 4.2.3 告警聚类器（AlertClusterer）

```javascript
class AlertClusterer {
  constructor(config) {
    this.similarityThreshold = config.similarityThreshold || 0.7;
    this.maxClusterSize = config.maxClusterSize || 50;
    this.clusters = new Map();
  }

  /**
   * 聚类告警
   * @param {Alert} alert - 新告警
   * @returns {ClusterResult} - 聚类结果
   */
  cluster(alert) {
    // 1. 计算与现有聚类的相似度
    let bestCluster = null;
    let bestSimilarity = 0;
    
    for (const [clusterId, cluster] of this.clusters) {
      const similarity = this.calculateSimilarity(alert, cluster);
      if (similarity > bestSimilarity && similarity >= this.similarityThreshold) {
        bestSimilarity = similarity;
        bestCluster = cluster;
      }
    }
    
    // 2. 加入现有聚类或创建新聚类
    if (bestCluster) {
      bestCluster.addAlert(alert);
      return { action: 'merged', cluster: bestCluster, similarity: bestSimilarity };
    } else {
      const newCluster = this.createCluster(alert);
      return { action: 'created', cluster: newCluster, similarity: 1.0 };
    }
  }

  /**
   * 计算告警相似度
   */
  calculateSimilarity(alert, cluster) {
    const representative = cluster.getRepresentative();
    
    // 特征向量
    const features = [
      this.compareAlertName(alert, representative),      // 告警名称
      this.compareService(alert, representative),        // 服务
      this.compareSeverity(alert, representative),       // 严重程度
      this.compareLabels(alert, representative),         // 标签
      this.compareTimeProximity(alert, representative)   // 时间接近度
    ];
    
    // 加权平均
    const weights = [0.3, 0.25, 0.15, 0.2, 0.1];
    return features.reduce((sum, f, i) => sum + f * weights[i], 0);
  }
}
```

#### 4.2.4 智能降噪策略（NoiseReducer）

```javascript
class NoiseReducer {
  constructor(config) {
    this.historyWindow = config.historyWindow || 7 * 24 * 3600000; // 7天
    this.noiseThreshold = config.noiseThreshold || 0.9;
    this.patterns = new Map();
  }

  /**
   * 判断是否为噪音告警
   * @param {Alert} alert - 待判断告警
   * @returns {NoiseResult} - 降噪结果
   */
  async evaluate(alert) {
    // 1. 查询历史模式
    const pattern = await this.findHistoricalPattern(alert);
    
    // 2. 计算噪音概率
    const noiseProbability = this.calculateNoiseProbability(alert, pattern);
    
    // 3. 决策
    if (noiseProbability >= this.noiseThreshold) {
      return {
        isNoise: true,
        reason: 'historical_pattern',
        confidence: noiseProbability,
        action: 'suppress',
        similarPastAlerts: pattern?.instances || []
      };
    }
    
    // 4. 检查是否为瞬时抖动
    if (await this.isFlapping(alert)) {
      return {
        isNoise: true,
        reason: 'flapping',
        confidence: 0.85,
        action: 'delay', // 延迟发送
        delayMs: 60000
      };
    }
    
    return {
      isNoise: false,
      action: 'forward'
    };
  }

  /**
   * 查找历史模式
   */
  async findHistoricalPattern(alert) {
    const history = await this.queryHistory(alert, this.historyWindow);
    
    // 统计自动恢复率
    const autoResolved = history.filter(a => 
      a.status === 'resolved' && 
      a.duration < 300000 // 5分钟内自动恢复
    );
    
    if (history.length > 10 && autoResolved.length / history.length > 0.8) {
      return {
        type: 'auto_resolving',
        instances: history,
        autoResolveRate: autoResolved.length / history.length
      };
    }
    
    return null;
  }

  /**
   * 检测抖动（Flapping）
   */
  async isFlapping(alert) {
    const recentAlerts = await this.queryRecent(alert, 600000); // 10分钟
    const stateChanges = this.countStateChanges(recentAlerts);
    
    // 10分钟内状态变化超过5次视为抖动
    return stateChanges >= 5;
  }
}
```

### 4.3 Alertmanager Webhook 集成

```yaml
# infrastructure/k8s/monitoring/alertmanager.yml (新增 receiver)
receivers:
  - name: 'alert-correlator'
    webhook_configs:
      - url: 'http://alert-correlator-service:8080/webhook/alert'
        send_resolved: true
        http_config:
          headers:
            X-Source: 'alertmanager'
```

### 4.4 REST API 设计

```
GET  /api/alerts/correlated              # 获取关联告警
GET  /api/alerts/:id/root-cause          # 获取根因分析
GET  /api/alerts/clusters                # 获取告警聚类
GET  /api/alerts/topology                # 获取告警拓扑图
POST /api/alerts/noise-rules             # 创建降噪规则
GET  /api/alerts/statistics              # 获取告警统计
```

### 4.5 Grafana 告警拓扑面板

```json
{
  "title": "Alert Topology",
  "type": "graph",
  "datasource": "AlertCorrelator",
  "targets": [
    {
      "query": "alert_topology",
      "format": "tree"
    }
  ],
  "options": {
    "nodeRadius": 30,
    "layoutAlgorithm": "forceDirected",
    "colorBy": "severity",
    "showLabels": true
  }
}
```

## 5. 验收标准（可测试）

- [ ] 创建 `backend/shared/alertCorrelator.js` 模块
- [ ] 实现告警关联引擎，支持拓扑/时间/规则三种关联方式
- [ ] 实现根因推断引擎，准确率 ≥ 85%
- [ ] 实现告警聚类器，聚类相似度阈值可配置
- [ ] 实现智能降噪策略，噪音减少 ≥ 70%
- [ ] 集成 Alertmanager Webhook，接收告警事件
- [ ] 提供 REST API 查询接口
- [ ] 创建 Grafana 告警拓扑面板
- [ ] 根因定位平均时间 < 2 分钟
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 压力测试：1000 告警/分钟 下响应时间 < 100ms

## 6. 工作量估算

**L (Large)**

理由：
- 需要实现多个复杂算法（关联分析、根因推断、聚类）
- 需要处理服务拓扑数据
- 需要与 Alertmanager 深度集成
- 需要设计 REST API 和 Grafana 面板
- 需要处理大量历史数据

预计开发时间：3 天

## 7. 优先级理由

**P1 理由**：
1. **显著提升运维效率**：根因定位时间从 15 分钟降到 2 分钟
2. **减少告警疲劳**：噪音减少 70%，提升团队响应质量
3. **支撑生产可用**：告警系统是生产环境必备能力
4. **复用现有基础设施**：基于 Alertmanager 扩展，不重复建设
5. **高 ROI**：一次性投入，持续收益

## 8. 相关需求

- REQ-00005: Prometheus 告警规则与 Alertmanager 集成（依赖）
- REQ-00023: 分布式追踪与 Jaeger 集成（服务拓扑数据源）
- REQ-00103: 微服务依赖图与循环检测（服务拓扑数据源）
- REQ-00168: 分布式追踪链路可视化（参考实现）

## 9. 风险评估

### 技术风险（中）
- 根因推断算法准确性需要持续调优
- 服务拓扑数据需要保持同步
- 大量告警时性能可能成为瓶颈

### 缓解措施
- 引入机器学习模型辅助推断（后续优化）
- 定期同步服务拓扑数据
- 使用 Redis 缓存 + 分片处理高并发

## 10. 后续优化方向

1. **机器学习增强**：使用历史数据训练根因预测模型
2. **自动修复**：基于根因分析结果自动执行修复脚本
3. **告警预测**：基于趋势预测即将触发的告警
4. **多集群支持**：跨集群告警关联分析
