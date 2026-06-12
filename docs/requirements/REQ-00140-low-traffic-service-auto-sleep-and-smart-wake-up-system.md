# REQ-00140：低峰期服务自动休眠与智能唤醒系统

- **编号**：REQ-00140
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/sleepManager.js、backend/shared/trafficAnalyzer.js、infrastructure/k8s、backend/jobs
- **创建时间**：2026-06-12 03:00
- **依赖需求**：REQ-00071（K8s Pod 自动扩缩容）、REQ-00040（云成本监控）

## 1. 背景与问题

mineGo 作为一款基于真实 GPS 的 AR 精灵捕捉手游，存在明显的流量潮汐特征：
- **高峰时段**：周末下午、节假日、晚间 18:00-22:00，用户活跃度是低谷期的 5-10 倍
- **低谷时段**：凌晨 02:00-06:00、工作日白天，在线用户不足高峰期的 10%

当前所有微服务 7x24 小时全量运行，导致：
1. **资源浪费严重**：低谷期 90% 的服务实例 CPU 利用率低于 5%，但仍在消耗 K8s 资源配额
2. **云成本居高不下**：每月云资源账单中约 35% 来自低谷期的"空转"开销
3. **缺乏智能调度**：无法根据历史流量模式预测并提前调整服务状态

虽然已有 HPA（水平自动扩缩容）和 K8s Pod 自动扩缩容系统（REQ-00071），但它们仅能缩容到最小副本数（通常为 1），无法实现真正的"零副本休眠"。

## 2. 目标

构建低峰期服务自动休眠与智能唤醒系统，实现：
1. **成本节省**：低谷期将非关键服务副本数缩至 0，预计节省云成本 20-30%
2. **智能预测**：基于历史流量模式，预测高峰到来时间并提前唤醒服务
3. **无感切换**：用户请求到达时自动快速唤醒（冷启动 < 30s），对用户透明
4. **安全保护**：关键服务（gateway、user-service）永不休眠，确保核心链路可用

## 3. 范围

- **包含**：
  - 流量模式分析与预测引擎
  - 服务休眠状态管理器
  - K8s Deployment 副本数动态调整接口
  - 冷启动请求队列与快速唤醒机制
  - 休眠策略配置中心（支持按服务、时段、地区配置）
  - Prometheus 指标与 Grafana 仪表板

- **不包含**：
  - 数据库/Redis 休眠（数据层始终保持可用）
  - 跨区域休眠协调（单区域独立决策）
  - 前端客户端休眠提示（对用户完全透明）

## 4. 详细需求

### 4.1 流量分析器（TrafficAnalyzer）

```javascript
// backend/shared/trafficAnalyzer.js
class TrafficAnalyzer {
  // 收集过去 N 小时的请求量数据
  async collectTrafficMetrics(hours = 24) {}
  
  // 分析历史流量模式，识别高峰/低谷时段
  async analyzeTrafficPattern() {
    // 返回 { peakHours: [18,19,20,21], troughHours: [2,3,4,5], ... }
  }
  
  // 预测未来 N 小时的流量趋势
  async predictTrafficTrend(hoursAhead = 2) {}
  
  // 判断当前是否应该休眠某服务
  async shouldSleep(serviceName) {}
  
  // 判断距离下次高峰还有多久
  async timeToNextPeak() {}
}
```

### 4.2 休眠管理器（SleepManager）

```javascript
// backend/shared/sleepManager.js
class SleepManager {
  // 休眠配置
  config = {
    neverSleep: ['gateway', 'user-service'],  // 永不休眠的服务
    minSleepDuration: 30 * 60 * 1000,  // 最小休眠时长 30 分钟
    wakeUpLeadTime: 5 * 60 * 1000,  // 提前 5 分钟唤醒
    coldStartTimeout: 30 * 1000,  // 冷启动超时 30 秒
  };
  
  // 休眠服务（副本数设为 0）
  async sleepService(serviceName) {}
  
  // 唤醒服务（副本数恢复）
  async wakeUpService(serviceName) {}
  
  // 获取服务休眠状态
  async getServiceStatus(serviceName) {}
  
  // 批量休眠/唤醒
  async batchSleep(serviceNames) {}
  async batchWakeUp(serviceNames) {}
}
```

### 4.3 K8s 集成接口

```yaml
# infrastructure/k8s/sleep-policy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sleep-policy
  namespace: minego
data:
  # 服务休眠策略配置
  catch-service: |
    enabled: true
    sleepAt: "02:00-06:00"
    timezone: "Asia/Shanghai"
    minReplicas: 0
    wakeUpLeadMinutes: 5
  gym-service: |
    enabled: true
    sleepAt: "02:00-06:00"
    timezone: "Asia/Shanghai"
  social-service: |
    enabled: true
    sleepAt: "02:00-08:00"
  reward-service: |
    enabled: true
    sleepAt: "03:00-07:00"
```

### 4.4 请求拦截与快速唤醒

```javascript
// gateway 中的休眠拦截中间件
async function sleepAwareMiddleware(req, res, next) {
  const targetService = getServiceFromPath(req.path);
  const status = await sleepManager.getServiceStatus(targetService);
  
  if (status === 'sleeping') {
    // 将请求加入等待队列
    const queueId = await requestQueue.enqueue(req);
    
    // 触发快速唤醒
    await sleepManager.wakeUpService(targetService);
    
    // 等待服务就绪或超时
    const ready = await waitForServiceReady(targetService, 30000);
    
    if (ready) {
      // 重放请求
      return replayRequest(queueId);
    } else {
      return res.status(503).json({ error: 'Service waking up, please retry' });
    }
  }
  
  next();
}
```

### 4.5 定时调度任务

```javascript
// backend/jobs/sleepScheduler.js
// 每 5 分钟执行一次
async function sleepSchedulerJob() {
  const services = getAllServices();
  const now = new Date();
  
  for (const service of services) {
    const policy = await getSleepPolicy(service);
    const shouldSleep = await trafficAnalyzer.shouldSleep(service);
    const timeToPeak = await trafficAnalyzer.timeToNextPeak();
    
    // 判断是否应该休眠
    if (shouldSleep && !policy.neverSleep && timeToPeak > policy.minSleepDuration) {
      await sleepManager.sleepService(service);
    }
    
    // 判断是否应该提前唤醒
    if (status === 'sleeping' && timeToPeak <= policy.wakeUpLeadTime) {
      await sleepManager.wakeUpService(service);
    }
  }
}
```

### 4.6 Prometheus 指标

```javascript
// 新增指标
- minego_service_sleep_status{service}  // 0=running, 1=sleeping
- minego_service_sleep_duration_seconds{service}  // 本次休眠时长
- minego_service_wakeup_count{service}  // 唤醒次数
- minego_service_cold_start_seconds{service}  // 冷启动耗时
- minego_sleep_cost_saved_dollars  // 累计节省成本
```

## 5. 验收标准（可测试）

- [ ] 流量分析器能准确识别高峰/低谷时段，预测误差 < 15%
- [ ] 休眠管理器能成功将非关键服务副本数缩至 0
- [ ] 冷启动时间 < 30 秒，请求队列正确重放
- [ ] 关键服务（gateway、user-service）在任何时段都不会被休眠
- [ ] 提前唤醒机制确保高峰期开始前 5 分钟服务已就绪
- [ ] Grafana 仪表板展示休眠状态、成本节省等指标
- [ ] 低谷期云成本相比实施前降低 >= 20%
- [ ] 用户请求成功率不受影响（>= 99.9%）

## 6. 工作量估算

**L（Large）**

理由：
- 需要新建流量分析器、休眠管理器两个核心模块
- 需要与 K8s API 深度集成（Deployment 副本数控制）
- 需要修改 gateway 添加请求拦截逻辑
- 需要配置定时任务、监控指标、仪表板
- 涉及多个服务的协调与测试

预计工时：3-5 人日

## 7. 优先级理由

**P1 理由**：
1. **成本收益显著**：预计节省 20-30% 云成本，对项目可持续运营有直接贡献
2. **技术可行性高**：K8s 原生支持副本数调整，冷启动技术成熟
3. **不影响核心功能**：通过智能唤醒和请求队列，用户体验不受影响
4. **已有基础**：REQ-00071（HPA）和 REQ-00040（成本监控）提供了技术基础
5. **适合当前阶段**：项目已有 139 个需求，基础设施相对完善，可以开始精细化成本优化
