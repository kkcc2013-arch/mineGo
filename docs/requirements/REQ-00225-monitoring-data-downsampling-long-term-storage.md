# REQ-00225：监控数据降采样与长期存储系统

- **编号**：REQ-00225
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：infrastructure/k8s/monitoring、backend/shared、Prometheus、Thanos/VictoriaMetrics、admin-dashboard
- **创建时间**：2026-06-15 17:05
- **依赖需求**：REQ-00002、REQ-00005、REQ-00094

## 1. 背景与问题

当前 mineGo 项目已实现 Prometheus 指标监控和 Grafana 可视化（REQ-00002、REQ-00005、REQ-00094），但存在以下监控数据存储痛点：

### 现状问题

1. **存储成本高**：Prometheus 默认保留 15 天数据，高分辨率（15s 采集间隔）占用大量磁盘，9 个微服务每秒产生 500+ 指标数据点
2. **历史数据缺失**：无法查询超过 15 天的历史趋势，影响容量规划、性能对比和事故复盘
3. **降采样策略缺失**：旧数据无需保持高精度（如 1 年前的数据 5 分钟粒度即可），但没有自动降采样机制
4. **成本不可控**：监控数据存储成本随时间线性增长，缺乏优化策略
5. **多集群数据聚合困难**：未来多区域部署时，需要全局视角的监控数据聚合能力

### 业务影响

- 无法回答"去年同期系统性能如何"这类问题
- 容量规划缺乏历史数据支撑，容易过度配置或配置不足
- 季节性流量模式无法识别，影响资源调度策略
- 监控存储成本随时间持续增长，无优化手段

## 2. 目标

1. **长期存储**：监控数据保留 1 年以上，支持历史趋势查询
2. **成本优化**：通过降采样和分层存储，降低 70% 存储成本
3. **数据精度分层**：近期数据高精度（15s），历史数据低精度（5m/1h）
4. **全局视角**：支持多集群监控数据聚合查询
5. **无缝集成**：不改变现有 Prometheus 查询接口，Grafana 零改动

## 3. 范围

### 包含

- VictoriaMetrics 或 Thanos 部署（二选一技术选型）
- Prometheus 远程写入配置
- 降采样策略配置（Retention + Downsampling）
- 存储分层（Hot/Warm/Cold）
- Grafana 数据源配置
- 成本监控与优化建议
- 历史数据查询 API

### 不包含

- 多集群联邦（后续需求）
- 自定义降采样算法（使用成熟方案）
- 监控数据备份到对象存储（后续迭代）

## 4. 详细需求

### 4.1 技术选型：VictoriaMetrics vs Thanos

| 特性 | VictoriaMetrics | Thanos |
|------|----------------|--------|
| 部署复杂度 | 低（单二进制） | 高（多组件） |
| 存储效率 | 高（压缩率 10x） | 中（压缩率 5x） |
| 查询性能 | 高 | 中（取决于组件） |
| 降采样支持 | 原生支持 | 需要 Thanos Downsample |
| 社区成熟度 | 高 | 高 |

**推荐选择：VictoriaMetrics**，理由：
- 部署简单，维护成本低
- 存储效率高，适合成本优化目标
- 原生支持降采样和长期存储

### 4.2 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    数据流架构                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  微服务 → Prometheus → Remote Write → VictoriaMetrics      │
│                               ↓                             │
│                          降采样策略                          │
│                               ↓                             │
│                     ┌─────────────────┐                    │
│                     │  分层存储策略    │                    │
│                     └─────────────────┘                    │
│                               │                             │
│            ┌──────────────────┼──────────────────┐         │
│            ↓                  ↓                  ↓         │
│        Hot Storage      Warm Storage      Cold Storage     │
│       (15s, 7 天)       (5m, 30 天)      (1h, 1 年)        │
│                                                             │
│  Grafana ← 查询 ← VictoriaMetrics (统一查询接口)            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 VictoriaMetrics 部署配置

```yaml
# infrastructure/k8s/monitoring/victoriametrics.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: victoriametrics
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: victoriametrics
  template:
    spec:
      containers:
      - name: victoriametrics
        image: victoriametrics/victoria-metrics:v1.93.0
        args:
          - -storageDataPath=/storage
          - -retentionPeriod=365d  # 保留 1 年
          - -downsampling.period=30d:5m,180d:1h  # 降采样策略
          - -memory.allowedPercent=80
          - -search.maxPointsPerTimeseries=30000
        ports:
        - containerPort: 8428
        volumeMounts:
        - name: storage
          mountPath: /storage
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
      volumes:
      - name: storage
        persistentVolumeClaim:
          claimName: victoriametrics-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: victoriametrics
  namespace: monitoring
spec:
  ports:
  - port: 8428
    targetPort: 8428
  selector:
    app: victoriametrics
```

### 4.4 Prometheus 远程写入配置

```yaml
# infrastructure/k8s/monitoring/prometheus-config-update.yaml
# 在现有 Prometheus 配置中添加远程写入
remote_write:
  - url: http://victoriametrics:8428/api/v1/write
    queue_config:
      max_samples_per_send: 10000
      max_shards: 10
      capacity: 25000
    # 标签过滤，减少存储压力
    write_relabel_configs:
      - source_labels: [__name__]
        regex: 'go_.*'
        action: drop  # 过滤 Go 运行时指标
```

### 4.5 降采样策略详解

```yaml
# 降采样时间线
# 0-30 天：原始精度（15s）
# 30-180 天：降采样到 5 分钟粒度
# 180 天以上：降采样到 1 小时粒度

downsampling:
  periods:
    - period: "0d-30d"
      resolution: "15s"  # 原始精度
      aggregation: "raw"
    - period: "30d-180d"
      resolution: "5m"   # 降采样到 5 分钟
      aggregation: "avg,max,min"  # 保留聚合值
    - period: "180d-365d"
      resolution: "1h"   # 降采样到 1 小时
      aggregation: "avg,max,min"
```

### 4.6 存储容量估算与成本优化

```javascript
// backend/shared/monitoringStorageOptimizer.js
class MonitoringStorageOptimizer {
  /**
   * 计算存储需求
   * @param {number} metricsPerSecond - 每秒指标数
   * @param {number} retentionDays - 保留天数
   */
  estimateStorageNeeds(metricsPerSecond, retentionDays) {
    // VictoriaMetrics 压缩率约 10x
    const bytesPerSample = 1.5;  // 压缩后每个样本约 1.5 字节
    
    // 原始数据存储
    const rawSamples = metricsPerSecond * 86400 * 30;  // 前 30 天原始
    const rawStorage = rawSamples * bytesPerSample;
    
    // 降采样数据存储（5 分钟粒度，保留 150 天）
    const downsampled5mSamples = (metricsPerSecond / 20) * 86400 * 150;
    const downsampled5mStorage = downsampled5mSamples * bytesPerSample;
    
    // 降采样数据存储（1 小时粒度，保留 185 天）
    const downsampled1hSamples = (metricsPerSecond / 240) * 86400 * 185;
    const downsampled1hStorage = downsampled1hSamples * bytesPerSample;
    
    const totalStorage = rawStorage + downsampled5mStorage + downsampled1hStorage;
    
    return {
      totalGB: (totalStorage / 1e9).toFixed(2),
      costPerMonth: ((totalStorage / 1e9) * 0.23).toFixed(2),  // SSD $0.23/GB
      savingsVsRaw: ((1 - totalStorage / (metricsPerSecond * 86400 * retentionDays * bytesPerSample)) * 100).toFixed(1)
    };
  }
  
  /**
   * 优化建议生成
   */
  generateOptimizationSuggestions(currentMetrics) {
    const suggestions = [];
    
    // 检查高基数指标
    if (currentMetrics.cardinality > 100000) {
      suggestions.push({
        type: 'high_cardinality',
        message: `发现高基数指标（${currentMetrics.cardinality}），建议添加标签过滤`,
        impact: '可减少 30% 存储成本'
      });
    }
    
    // 检查未使用的指标
    if (currentMetrics.unusedMetrics > 50) {
      suggestions.push({
        type: 'unused_metrics',
        message: `发现 ${currentMetrics.unusedMetrics} 个未使用的指标，建议删除`,
        impact: '可减少 10% 存储成本'
      });
    }
    
    return suggestions;
  }
}
```

### 4.7 Grafana 数据源配置

```yaml
# infrastructure/k8s/monitoring/grafana-datasources.yaml
apiVersion: 1
datasources:
  - name: VictoriaMetrics
    type: prometheus
    access: proxy
    url: http://victoriametrics:8428
    isDefault: false
    editable: false
    jsonData:
      httpMethod: POST
      timeInterval: "15s"
      queryTimeout: "60s"
```

### 4.8 历史数据查询 API

```javascript
// backend/shared/monitoringQuery.js
const axios = require('axios');

class MonitoringQueryAPI {
  constructor(victoriametricsUrl = 'http://victoriametrics:8428') {
    this.baseUrl = victoriametricsUrl;
  }
  
  /**
   * 查询历史范围数据
   * @param {string} query - PromQL 查询
   * @param {Date} start - 开始时间
   * @param {Date} end - 结束时间
   * @param {string} step - 查询步长
   */
  async queryRange(query, start, end, step = '5m') {
    const response = await axios.get(`${this.baseUrl}/api/v1/query_range`, {
      params: {
        query,
        start: Math.floor(start.getTime() / 1000),
        end: Math.floor(end.getTime() / 1000),
        step
      }
    });
    
    return response.data.data;
  }
  
  /**
   * 获取去年同期数据
   */
  async getYearOverYearComparison(metric, serviceName) {
    const now = new Date();
    const lastYear = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    
    const currentData = await this.queryRange(
      `${metric}{service="${serviceName}"}`,
      new Date(now.getTime() - 7 * 86400 * 1000),
      now,
      '1h'
    );
    
    const lastYearData = await this.queryRange(
      `${metric}{service="${serviceName}"}`,
      new Date(lastYear.getTime() - 7 * 86400 * 1000),
      lastYear,
      '1h'
    );
    
    return {
      current: currentData,
      lastYear: lastYearData,
      comparison: this.calculateChange(currentData, lastYearData)
    };
  }
  
  /**
   * 获取存储统计
   */
  async getStorageStats() {
    const response = await axios.get(`${this.baseUrl}/api/v1/status/tsdb`);
    return {
      totalSeries: response.data.data.seriesCountByMetricName,
      totalSamples: response.data.data.numSeries,
      storageSize: response.data.data.storageSize
    };
  }
}
```

## 5. 验收标准（可测试）

- [ ] Prometheus 成功远程写入到 VictoriaMetrics，无数据丢失
- [ ] 监控数据保留 1 年，可查询 365 天前的历史数据
- [ ] 降采样策略生效：30 天前数据自动降采样到 5 分钟粒度
- [ ] Grafana 可查询 VictoriaMetrics，无需修改现有仪表板
- [ ] 存储成本相比纯 Prometheus 方案降低 60% 以上
- [ ] 查询性能：历史数据查询 P95 延迟 < 2 秒
- [ ] 存储优化器提供成本估算和优化建议
- [ ] 文档包含部署指南、查询示例、成本优化最佳实践

## 6. 工作量估算

**L**（Large）

- 理由：需要部署 VictoriaMetrics，配置 Prometheus 远程写入，实现降采样策略，开发存储优化器，更新 Grafana 配置，编写迁移脚本和文档

## 7. 优先级理由

1. **成本可控性**：监控数据存储成本随时间线性增长，降采样可节省 70% 成本
2. **历史数据价值**：容量规划、趋势分析、事故复盘都需要历史数据支撑
3. **生产必备**：长期监控数据存储是生产环境的标准需求
4. **技术成熟**：VictoriaMetrics 是成熟的开源方案，风险可控
5. **与现有系统集成**：与 Prometheus/Grafana 无缝集成，改动小
