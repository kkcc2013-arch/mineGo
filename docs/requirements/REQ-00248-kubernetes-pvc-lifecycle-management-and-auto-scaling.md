# REQ-00248：Kubernetes 存储卷生命周期管理与自动扩缩容系统

- **编号**：REQ-00248
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：infrastructure/k8s、backend/shared/PVCManager.js、backend/jobs、所有微服务、admin-dashboard
- **创建时间**：2026-06-16 06:00
- **依赖需求**：REQ-00060（数据库分区表）、REQ-00107（数据生命周期管理）

## 1. 背景与问题

### 1.1 现状分析
当前 mineGo 项目在 Kubernetes 集群中运行 9 个微服务，使用 PostgreSQL、Redis、Kafka 等有状态服务，涉及多个持久卷（PVC）。但存在以下问题：

1. **存储容量规划缺失**：
   - PVC 大小在创建时固定，无法根据实际使用量动态调整
   - PostgreSQL 数据库 PVC 初始分配 100Gi，当前使用仅 35Gi，存在资源浪费
   - Redis AOF 持久化 PVC 预留空间过大，利用率不足 40%

2. **存储成本不可控**：
   - 使用高性能 SSD 存储类（alicloud-disk-ssd）但未区分冷热数据
   - 日志 PVC、临时数据 PVC 未设置自动清理策略
   - 无存储使用趋势预测，无法提前规划扩容

3. **存储扩容操作风险高**：
   - 手动扩容 PVC 需要重启 Pod，影响服务可用性
   - 无自动扩容机制，存储满时可能导致服务中断
   - 扩容后无回滚机制，可能造成资源浪费

4. **僵尸 PVC 清理缺失**：
   - 已删除服务遗留的 PVC 未自动清理
   - 测试环境 PVC 未及时回收，持续产生费用
   - 无 PVC 使用情况追踪和告警

### 1.2 影响评估
- **存储成本**：当前集群月存储成本约 ¥2,400，其中约 35% 为低效利用
- **运维风险**：存储满导致服务不可用的风险增加
- **资源浪费**：僵尸 PVC 每月浪费约 ¥500 存储费用

## 2. 目标

建立完整的 Kubernetes 存储卷生命周期管理系统，实现：
1. **自动扩缩容**：基于使用率自动调整 PVC 大小，存储利用率提升至 70%+
2. **智能存储分层**：根据数据访问频率自动迁移冷热数据，成本降低 30%
3. **僵尸 PVC 清理**：自动识别并清理未使用的 PVC，回收闲置资源
4. **容量预测告警**：预测存储使用趋势，提前预警扩容需求
5. **零停机扩容**：支持在线扩容 PVC，不影响服务可用性

## 3. 范围

### 3.1 包含
- PVC 使用率监控与自动扩缩容策略
- 存储类智能选择与数据分层迁移
- 僵尸 PVC 检测与自动清理
- 存储容量趋势预测与告警
- 存储配额管理与成本归因
- 管理后台存储可视化仪表板

### 3.2 不包含
- 数据库内部存储优化（由 REQ-00060 覆盖）
- 数据生命周期清理策略（由 REQ-00107 覆盖）
- 跨区域存储复制（由 REQ-00041 覆盖）

## 4. 详细需求

### 4.1 PVC 使用率监控与自动扩缩容

#### 4.1.1 使用率采集器
```javascript
// backend/shared/PVCManager/UsageCollector.js

const k8s = require('@kubernetes/client-node');
const promClient = require('prom-client');

class PVCUsageCollector {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.customMetricsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    
    // Prometheus 指标
    this.pvcUsageGauge = new promClient.Gauge({
      name: 'minego_pvc_usage_ratio',
      help: 'PVC usage ratio (used/total)',
      labelNames: ['pvc_name', 'namespace', 'storage_class', 'service']
    });
    
    this.pvcCapacityGauge = new promClient.Gauge({
      name: 'minego_pvc_capacity_bytes',
      help: 'PVC total capacity in bytes',
      labelNames: ['pvc_name', 'namespace', 'storage_class']
    });
    
    this.pvcUsedGauge = new promClient.Gauge({
      name: 'minego_pvc_used_bytes',
      help: 'PVC used bytes',
      labelNames: ['pvc_name', 'namespace', 'pod_name']
    });
  }

  async collectAllPVCUsage() {
    const pvcs = await this.listAllPVCs();
    const usageData = [];
    
    for (const pvc of pvcs) {
      const usage = await this.getPVCUsage(pvc);
      usageData.push({
        name: pvc.metadata.name,
        namespace: pvc.metadata.namespace,
        storageClass: pvc.spec.storageClassName,
        capacity: this.parseSize(pvc.status.capacity.storage),
        used: usage.usedBytes,
        usageRatio: usage.usedBytes / this.parseSize(pvc.status.capacity.storage),
        boundPod: await this.getBoundPod(pvc),
        labels: pvc.metadata.labels || {}
      });
      
      // 更新 Prometheus 指标
      this.updateMetrics(usageData[usageData.length - 1]);
    }
    
    return usageData;
  }

  async getPVCUsage(pvc) {
    // 通过 kubelet metrics 或 df 命令获取实际使用量
    const boundPod = await this.getBoundPod(pvc);
    if (!boundPod) {
      return { usedBytes: 0, availableBytes: 0 };
    }
    
    // 使用 Kubernetes Volume Statistics API
    try {
      const stats = await this.customMetricsApi.getNamespacedCustomObject(
        'metrics.k8s.io', 'v1beta1',
        pvc.metadata.namespace,
        'pods', boundPod,
        'pvc', pvc.metadata.name
      );
      return {
        usedBytes: stats.body.used,
        availableBytes: stats.body.available
      };
    } catch (err) {
      // Fallback: 通过 Prometheus 查询
      return await this.getUsageFromPrometheus(pvc);
    }
  }

  async getUsageFromPrometheus(pvc) {
    // 查询 Prometheus kubelet_volume_stats_used_bytes
    const query = `kubelet_volume_stats_used_bytes{persistentvolumeclaim="${pvc.metadata.name}"}`;
    const result = await this.prometheusQuery(query);
    return { usedBytes: result || 0 };
  }
}
```

#### 4.1.2 自动扩缩容策略
```javascript
// backend/shared/PVCManager/AutoScaler.js

class PVCAutoScaler {
  constructor(config) {
    this.config = {
      // 扩容阈值
      expandThreshold: 0.85, // 使用率 > 85% 触发扩容
      expandFactor: 1.5,     // 扩容 1.5 倍
      maxCapacity: '500Gi',  // 最大容量限制
      
      // 缩容阈值（仅支持支持的存储类）
      shrinkThreshold: 0.3,  // 使用率 < 30% 考虑缩容
      shrinkFactor: 0.7,     // 缩容到 70%
      minCapacity: '10Gi',   // 最小容量限制
      
      // 冷却时间
      cooldownMinutes: 60,
      
      // 预测提前量
      predictDays: 7,        // 预测 7 天后的使用量
      ...config
    };
    
    this.usageCollector = new PVCUsageCollector();
    this.trendPredictor = new StorageTrendPredictor();
  }

  async evaluateAndScale() {
    const pvcUsages = await this.usageCollector.collectAllPVCUsage();
    const actions = [];
    
    for (const pvc of pvcUsages) {
      // 跳过不可扩容的 PVC
      if (!await this.isExpandable(pvc)) continue;
      
      // 检查冷却时间
      if (await this.isInCooldown(pvc)) continue;
      
      // 预测未来使用量
      const prediction = await this.trendPredictor.predict(pvc, this.config.predictDays);
      
      // 扩容决策
      if (pvc.usageRatio > this.config.expandThreshold || 
          prediction.predictedRatio > this.config.expandThreshold) {
        const newCapacity = this.calculateExpandCapacity(pvc.capacity);
        actions.push({
          type: 'expand',
          pvc: pvc.name,
          namespace: pvc.namespace,
          currentCapacity: pvc.capacity,
          newCapacity,
          reason: pvc.usageRatio > this.config.expandThreshold 
            ? `当前使用率 ${(pvc.usageRatio * 100).toFixed(1)}% 超过阈值`
            : `预测 ${this.config.predictDays} 天后使用率 ${(prediction.predictedRatio * 100).toFixed(1)}%`,
          urgency: pvc.usageRatio > 0.95 ? 'critical' : 'high'
        });
      }
      
      // 缩容决策（仅支持特定存储类）
      if (this.canShrink(pvc) && pvc.usageRatio < this.config.shrinkThreshold) {
        const newCapacity = this.calculateShrinkCapacity(pvc.capacity);
        actions.push({
          type: 'shrink',
          pvc: pvc.name,
          namespace: pvc.namespace,
          currentCapacity: pvc.capacity,
          newCapacity,
          reason: `当前使用率 ${(pvc.usageRatio * 100).toFixed(1)}% 低于阈值`,
          urgency: 'low'
        });
      }
    }
    
    return actions;
  }

  async executeScaleAction(action) {
    const { type, pvc, namespace, newCapacity } = action;
    
    if (type === 'expand') {
      // 在线扩容（Kubernetes 1.11+ 支持）
      await this.expandPVC(namespace, pvc, newCapacity);
      
      // 记录扩容事件
      await this.recordScaleEvent(action);
      
      // 发送通知
      await this.sendNotification({
        title: `PVC 扩容: ${pvc}`,
        message: `${action.currentCapacity} -> ${newCapacity}\n原因: ${action.reason}`,
        severity: action.urgency
      });
    } else if (type === 'shrink') {
      // 缩容需要重建 PVC（谨慎操作）
      await this.shrinkPVC(namespace, pvc, newCapacity);
    }
  }

  async expandPVC(namespace, pvcName, newCapacity) {
    // 获取当前 PVC
    const pvc = await this.coreApi.readNamespacedPersistentVolumeClaim(pvcName, namespace);
    
    // 更新 PVC 大小
    pvc.body.spec.resources.requests.storage = newCapacity;
    
    // 应用更新
    await this.coreApi.replaceNamespacedPersistentVolumeClaim(
      pvcName, namespace, pvc.body
    );
    
    // 等待扩容完成
    await this.waitForExpansion(namespace, pvcName, newCapacity);
    
    logger.info(`PVC ${pvcName} expanded to ${newCapacity}`);
  }
}
```

### 4.2 智能存储分层

#### 4.2.1 存储类管理
```javascript
// backend/shared/PVCManager/StorageTierManager.js

class StorageTierManager {
  constructor() {
    // 存储类定义
    this.storageClasses = {
      'alicloud-disk-ssd': {
        tier: 'hot',
        performance: 'high',
        costPerGBMonth: 0.35,  // ¥/GB/月
        minSize: '20Gi',
        maxSize: '32Ti',
        supportsExpansion: true,
        supportsShrink: false
      },
      'alicloud-disk-efficiency': {
        tier: 'warm',
        performance: 'medium',
        costPerGBMonth: 0.12,
        minSize: '10Gi',
        maxSize: '32Ti',
        supportsExpansion: true,
        supportsShrink: false
      },
      'alicloud-disk-essd-pl0': {
        tier: 'cold',
        performance: 'low',
        costPerGBMonth: 0.05,
        minSize: '10Gi',
        maxSize: '32Ti',
        supportsExpansion: true,
        supportsShrink: false
      },
      'alicloud-nas': {
        tier: 'shared',
        performance: 'medium',
        costPerGBMonth: 0.30,
        supportsExpansion: true,
        supportsShrink: true
      }
    };
  }

  async analyzeAndRecommendTiering() {
    const pvcs = await this.listAllPVCs();
    const recommendations = [];
    
    for (const pvc of pvcs) {
      const usage = await this.analyzeAccessPattern(pvc);
      const currentClass = this.storageClasses[pvc.spec.storageClassName];
      
      // 根据访问模式推荐存储类
      let recommendedClass;
      if (usage.accessFrequency === 'high' && usage.latencySensitive) {
        recommendedClass = 'alicloud-disk-ssd';
      } else if (usage.accessFrequency === 'medium') {
        recommendedClass = 'alicloud-disk-efficiency';
      } else if (usage.accessFrequency === 'low') {
        recommendedClass = 'alicloud-disk-essd-pl0';
      }
      
      if (recommendedClass && recommendedClass !== pvc.spec.storageClassName) {
        const targetClass = this.storageClasses[recommendedClass];
        const potentialSaving = this.calculateSaving(
          pvc.status.capacity.storage,
          currentClass.costPerGBMonth,
          targetClass.costPerGBMonth
        );
        
        recommendations.push({
          pvc: pvc.metadata.name,
          namespace: pvc.metadata.namespace,
          currentClass: pvc.spec.storageClassName,
          recommendedClass,
          potentialSaving,
          accessPattern: usage,
          migrationRisk: this.assessMigrationRisk(pvc, recommendedClass)
        });
      }
    }
    
    return recommendations.sort((a, b) => b.potentialSaving - a.potentialSaving);
  }

  async analyzeAccessPattern(pvc) {
    // 通过 Prometheus 查询访问频率
    const queries = {
      readIOPS: `rate(kubelet_volume_stats_read_ops_total{persistentvolumeclaim="${pvc.metadata.name}"}[7d])`,
      writeIOPS: `rate(kubelet_volume_stats_write_ops_total{persistentvolumeclaim="${pvc.metadata.name}"}[7d])`,
      readBytes: `rate(kubelet_volume_stats_read_bytes_total{persistentvolumeclaim="${pvc.metadata.name}"}[7d])`,
      latency: `histogram_quantile(0.95, rate(kubelet_volume_stats_read_latency_seconds_bucket{persistentvolumeclaim="${pvc.metadata.name}"}[7d]))`
    };
    
    const results = await Promise.all(
      Object.entries(queries).map(([key, query]) => 
        this.prometheusQuery(query).then(r => [key, r])
      )
    );
    
    const metrics = Object.fromEntries(results);
    const totalIOPS = (metrics.readIOPS || 0) + (metrics.writeIOPS || 0);
    
    return {
      accessFrequency: totalIOPS > 100 ? 'high' : totalIOPS > 10 ? 'medium' : 'low',
      latencySensitive: (metrics.latency || 0) < 0.01,
      avgReadIOPS: metrics.readIOPS || 0,
      avgWriteIOPS: metrics.writeIOPS || 0,
      avgThroughput: metrics.readBytes || 0
    };
  }
}
```

### 4.3 僵尸 PVC 清理

```javascript
// backend/shared/PVCManager/OrphanCleaner.js

class PVCOrphanCleaner {
  constructor() {
    this.config = {
      // 未使用时间阈值（天）
      unusedDays: 30,
      
      // 保护标签
      protectedLabels: ['app.kubernetes.io/managed-by', 'minego.io/protected'],
      
      // 白名单 PVC
      whitelist: ['postgres-data', 'redis-data', 'kafka-data'],
      
      // 清理前通知天数
      notifyBeforeDays: 7
    };
  }

  async findOrphanPVCs() {
    const pvcs = await this.listAllPVCs();
    const orphans = [];
    
    for (const pvc of pvcs) {
      // 检查白名单
      if (this.config.whitelist.includes(pvc.metadata.name)) continue;
      
      // 检查保护标签
      if (this.hasProtectedLabels(pvc)) continue;
      
      // 检查绑定状态
      const boundPod = await this.getBoundPod(pvc);
      if (boundPod) continue; // 有 Pod 使用，不是孤儿
      
      // 检查最近使用时间
      const lastUsed = await this.getLastUsedTime(pvc);
      const unusedDays = (Date.now() - lastUsed.getTime()) / (1000 * 60 * 60 * 24);
      
      if (unusedDays > this.config.unusedDays) {
        orphans.push({
          name: pvc.metadata.name,
          namespace: pvc.metadata.namespace,
          storageClass: pvc.spec.storageClassName,
          capacity: pvc.status.capacity.storage,
          lastUsed,
          unusedDays,
          estimatedCost: this.calculateMonthlyCost(pvc)
        });
      }
    }
    
    return orphans;
  }

  async cleanupOrphanPVCs(dryRun = true) {
    const orphans = await this.findOrphanPVCs();
    const results = [];
    
    for (const orphan of orphans) {
      // 检查是否需要通知
      const notifyDate = new Date(orphan.lastUsed);
      notifyDate.setDate(notifyDate.getDate() + this.config.unusedDays - this.config.notifyBeforeDays);
      
      if (new Date() < notifyDate) {
        // 发送预通知
        await this.sendCleanupNotification(orphan, 'warning');
        results.push({ ...orphan, action: 'notified' });
        continue;
      }
      
      if (dryRun) {
        results.push({ ...orphan, action: 'dry-run' });
        continue;
      }
      
      // 执行清理
      try {
        // 先创建快照备份
        const snapshot = await this.createSnapshot(orphan);
        
        // 删除 PVC
        await this.coreApi.deleteNamespacedPersistentVolumeClaim(
          orphan.name, orphan.namespace
        );
        
        results.push({ ...orphan, action: 'deleted', snapshot: snapshot.metadata.name });
        
        logger.info(`Deleted orphan PVC: ${orphan.name}`, { snapshot: snapshot.metadata.name });
      } catch (err) {
        results.push({ ...orphan, action: 'failed', error: err.message });
        logger.error(`Failed to delete orphan PVC: ${orphan.name}`, err);
      }
    }
    
    return results;
  }
}
```

### 4.4 存储容量趋势预测

```javascript
// backend/shared/PVCManager/TrendPredictor.js

class StorageTrendPredictor {
  constructor() {
    this.model = null;
  }

  async predict(pvc, daysAhead) {
    // 获取历史数据（过去 30 天）
    const history = await this.getUsageHistory(pvc, 30);
    
    // 使用线性回归预测
    const { slope, intercept } = this.linearRegression(history);
    
    // 预测未来使用量
    const futureDays = history.length + daysAhead;
    const predictedUsed = slope * futureDays + intercept;
    
    // 计算预测使用率
    const currentCapacity = pvc.capacity;
    const predictedRatio = predictedUsed / currentCapacity;
    
    // 计算预计耗尽时间
    const daysUntilFull = slope > 0 
      ? Math.floor((currentCapacity - intercept) / slope - history.length)
      : Infinity;
    
    return {
      predictedUsed,
      predictedRatio,
      daysUntilFull,
      trend: slope > 0 ? 'increasing' : slope < 0 ? 'decreasing' : 'stable',
      confidence: this.calculateConfidence(history)
    };
  }

  linearRegression(data) {
    const n = data.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += data[i];
      sumXY += i * data[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  }
}
```

### 4.5 管理后台仪表板

```html
<!-- admin-dashboard/storage-management.html -->

<!DOCTYPE html>
<html>
<head>
  <title>存储管理仪表板 - mineGo</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="dashboard">
    <h1>存储卷管理仪表板</h1>
    
    <!-- 总览卡片 -->
    <div class="overview-cards">
      <div class="card">
        <h3>总存储容量</h3>
        <p class="value" id="totalCapacity">-</p>
        <p class="unit">GiB</p>
      </div>
      <div class="card">
        <h3>平均使用率</h3>
        <p class="value" id="avgUsage">-</p>
        <p class="unit">%</p>
      </div>
      <div class="card">
        <h3>月存储成本</h3>
        <p class="value" id="monthlyCost">-</p>
        <p class="unit">¥</p>
      </div>
      <div class="card alert">
        <h3>待处理告警</h3>
        <p class="value" id="pendingAlerts">-</p>
      </div>
    </div>
    
    <!-- PVC 列表 -->
    <div class="pvc-list">
      <h2>PVC 列表</h2>
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>命名空间</th>
            <th>存储类</th>
            <th>容量</th>
            <th>使用率</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="pvcTableBody">
        </tbody>
      </table>
    </div>
    
    <!-- 存储趋势图表 -->
    <div class="charts">
      <div class="chart-container">
        <h2>存储使用趋势</h2>
        <canvas id="usageTrendChart"></canvas>
      </div>
      <div class="chart-container">
        <h2>成本分布</h2>
        <canvas id="costDistributionChart"></canvas>
      </div>
    </div>
    
    <!-- 自动扩缩容策略 -->
    <div class="autoscaler-config">
      <h2>自动扩缩容策略</h2>
      <form id="autoscalerForm">
        <label>扩容阈值: <input type="number" id="expandThreshold" value="85" step="1" min="50" max="95">%</label>
        <label>扩容倍数: <input type="number" id="expandFactor" value="1.5" step="0.1" min="1.1" max="2.0">x</label>
        <label>最大容量: <input type="text" id="maxCapacity" value="500Gi"></label>
        <button type="submit">保存配置</button>
      </form>
    </div>
  </div>
  
  <script>
    async function loadDashboard() {
      const response = await fetch('/api/admin/storage/overview');
      const data = await response.json();
      
      document.getElementById('totalCapacity').textContent = data.totalCapacityGB.toFixed(1);
      document.getElementById('avgUsage').textContent = (data.avgUsageRatio * 100).toFixed(1);
      document.getElementById('monthlyCost').textContent = data.monthlyCost.toFixed(2);
      document.getElementById('pendingAlerts').textContent = data.pendingAlerts;
      
      renderPVCTable(data.pvcs);
      renderCharts(data);
    }
    
    loadDashboard();
    setInterval(loadDashboard, 60000); // 每分钟刷新
  </script>
</body>
</html>
```

### 4.6 Kubernetes 定时任务

```yaml
# infrastructure/k8s/pvc-manager-cronjob.yaml

apiVersion: batch/v1
kind: CronJob
metadata:
  name: pvc-usage-collector
  namespace: minego
spec:
  schedule: "*/15 * * * *"  # 每 15 分钟采集一次
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: pvc-manager
          containers:
          - name: collector
            image: minego/pvc-manager:latest
            command:
            - node
            - /app/jobs/pvcUsageCollector.js
            env:
            - name: KUBE_CONFIG
              value: /var/run/secrets/kubernetes.io/serviceaccount
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
              limits:
                cpu: 500m
                memory: 256Mi
          restartPolicy: OnFailure

---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pvc-autoscaler
  namespace: minego
spec:
  schedule: "0 * * * *"  # 每小时评估一次
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: pvc-manager
          containers:
          - name: scaler
            image: minego/pvc-manager:latest
            command:
            - node
            - /app/jobs/pvcAutoScaler.js
            env:
            - name: DRY_RUN
              value: "false"
            resources:
              requests:
                cpu: 200m
                memory: 256Mi
          restartPolicy: OnFailure

---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pvc-orphan-cleaner
  namespace: minego
spec:
  schedule: "0 2 * * 0"  # 每周日凌晨 2 点清理
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: pvc-manager
          containers:
          - name: cleaner
            image: minego/pvc-manager:latest
            command:
            - node
            - /app/jobs/pvcOrphanCleaner.js
            env:
            - name: DRY_RUN
              value: "false"
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
          restartPolicy: OnFailure

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pvc-manager
  namespace: minego

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pvc-manager
rules:
- apiGroups: [""]
  resources: ["persistentvolumeclaims", "persistentvolumes", "pods"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses", "volumeattachments"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshots"]
  verbs: ["get", "list", "create"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: pvc-manager
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: pvc-manager
subjects:
- kind: ServiceAccount
  name: pvc-manager
  namespace: minego
```

## 5. 验收标准（可测试）

- [ ] PVC 使用率采集器每 15 分钟运行一次，数据写入 Prometheus
- [ ] 当 PVC 使用率 > 85% 时，自动触发扩容，扩容倍数为当前容量的 1.5 倍
- [ ] 扩容操作不导致 Pod 重启，服务保持可用（零停机扩容）
- [ ] 存储分层推荐能根据访问频率正确推荐存储类，潜在节省成本可量化
- [ ] 僵尸 PVC 检测能识别超过 30 天未使用的 PVC
- [ ] 清理前创建快照备份，清理操作记录审计日志
- [ ] 存储趋势预测准确率 > 80%（基于历史数据回测）
- [ ] 管理后台仪表板实时显示存储使用情况，支持手动触发扩缩容
- [ ] Prometheus 告警规则：使用率 > 90% 触发 critical 告警
- [ ] 单元测试覆盖率 > 80%，包含扩缩容、分层、清理逻辑测试

## 6. 工作量估算

**L（Large）**

理由：
- 需要开发多个核心组件：使用率采集、自动扩缩容、存储分层、僵尸清理、趋势预测
- 涉及 Kubernetes API 深度集成，需要处理各种边界情况
- 管理后台仪表板需要前端开发
- 需要充分的测试验证，特别是扩缩容操作的安全性
- 预估工作量：3-5 人日

## 7. 优先级理由

**P1 理由：**

1. **成本影响显著**：存储成本占云基础设施成本的 20-30%，优化空间大
2. **运维风险降低**：自动扩容避免存储满导致的服务中断，提升系统可靠性
3. **资源利用率提升**：从当前 40-60% 提升至 70%+，显著减少资源浪费
4. **僵尸 PVC 清理**：每月可节省约 ¥500 存储费用，投资回报明确
5. **为生产环境必备**：生产环境需要存储容量规划和自动运维能力

## 8. 相关需求

- REQ-00060：数据库分区表与大数据量表分区策略（数据存储优化）
- REQ-00107：数据生命周期管理与自动清理策略（数据清理）
- REQ-00040：云成本监控与预算告警系统（成本监控）
- REQ-00178：容器镜像生命周期管理与存储优化系统（镜像存储优化）
- REQ-00212：云资源利用率分析与成本归因系统（资源利用率）
