# REQ-00376：跨区域灾备自动化切换系统

- **编号**：REQ-00376
- **类别**：容灾/高可用
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared/disasterRecovery、infrastructure/k8s、PostgreSQL、Redis、Kafka、DNS/负载均衡、admin-dashboard
- **创建时间**：2026-06-29 23:00 UTC
- **依赖需求**：REQ-00041（多区域容灾切换系统已完成）、REQ-00373（SLO 系统已完成）

## 1. 背景与问题

当前系统已有基础的多区域容灾配置（REQ-00041），但灾备切换依赖人工决策和手动操作，存在以下问题：

1. **响应延迟**：主区域故障时，人工判断和切换耗时可能达数分钟，导致服务中断时间过长
2. **判断主观**：故障判定依赖运维人员经验，缺乏客观的自动化健康评估机制
3. **切换风险**：手动切换可能遗漏关键步骤（如数据同步验证、流量切断），造成数据丢失或混乱
4. **回滚困难**：灾备切换后回滚到原主区域缺乏自动化流程

## 2. 目标

构建全自动化的跨区域灾备切换系统：
- 基于健康评分自动触发灾备切换决策
- 实现一键式灾备切换流程（包括数据同步验证、流量切换、状态同步）
- 提供灾备演练模式，验证系统灾备能力
- 支持自动回滚和人工确认回滚

## 3. 范围

- **包含**：
  - 跨区域健康监控与评分系统
  - 自动化灾备切换决策引擎
  - 切换流程编排器（数据同步 → 流量切断 → DNS切换 → 状态恢复）
  - 灾备演练与验证机制
  - 回滚机制
  
- **不包含**：
  - 多区域基础设施部署（已有 REQ-00041）
  - 数据库实时复制配置（属于数据库层配置）

## 4. 详细需求

### 4.1 DisasterRecoveryHealthMonitor（健康监控）

```javascript
class DisasterRecoveryHealthMonitor {
  // 区域健康评分维度
  healthDimensions = {
    serviceAvailability: { weight: 0.3, threshold: 0.95 },
    databaseHealth: { weight: 0.25, threshold: 0.90 },
    cacheHealth: { weight: 0.15, threshold: 0.85 },
    networkLatency: { weight: 0.15, threshold: 100 },
    errorRate: { weight: 0.15, threshold: 0.05 }
  };
  
  // 计算区域综合健康评分
  calculateRegionHealthScore(region) {
    // 收集各维度指标
    // 计算加权平均分数
    // 返回健康状态：healthy/degraded/critical
  }
  
  // 监控所有区域健康状态
  monitorAllRegions() {
    // 每 10 秒评估各区域健康分数
    // 当主区域分数 < 阈值时触发预警
    // 当分数持续低于阈值时触发切换决策
  }
}
```

### 4.2 DisasterRecoveryDecisionEngine（决策引擎）

```javascript
class DisasterRecoveryDecisionEngine {
  // 切换决策规则
  decisionRules = {
    immediateSwitch: {
      trigger: 'healthScore < 50 for 30s',
      action: 'switchToBestBackupRegion'
    },
    degradedSwitch: {
      trigger: 'healthScore < 70 for 60s && backupScore > 90',
      action: 'switchToBackupRegion'
    },
    proactiveSwitch: {
      trigger: 'predictedFailureProbability > 0.8',
      action: 'switchToBackupRegion'
    }
  };
  
  // 决策是否需要切换
  shouldSwitch(primaryRegion, backupRegions) {
    // 基于健康评分和决策规则评估
    // 返回切换决策：{ shouldSwitch, targetRegion, reason }
  }
  
  // 选择最佳备区域
  selectBestBackupRegion(backupRegions) {
    // 评估各备区域健康分数、容量、延迟
    // 返回最适合切换的目标区域
  }
}
```

### 4.3 DisasterRecoveryOrchestrator（切换编排器）

```javascript
class DisasterRecoveryOrchestrator {
  // 切换流程步骤
  switchSteps = [
    { name: 'validateDataSync', timeout: 30000, retry: 3 },
    { name: 'drainTraffic', timeout: 15000 },
    { name: 'pauseNewRequests', timeout: 5000 },
    { name: 'switchDNS', timeout: 10000 },
    { name: 'activateBackupRegion', timeout: 20000 },
    { name: 'verifySwitchSuccess', timeout: 30000 },
    { name: 'announceSwitchComplete', timeout: 5000 }
  ];
  
  // 执行灾备切换
  async executeSwitch(fromRegion, toRegion, options = {}) {
    // 按步骤顺序执行切换流程
    // 每步失败时执行回滚或继续
    // 记录详细切换日志
  }
  
  // 回滚到原主区域
  async rollback(originalRegion) {
    // 验证原区域已恢复健康
    // 执行反向切换流程
    // 确保数据一致性
  }
}
```

### 4.4 数据库迁移

```sql
-- 区域健康记录
CREATE TABLE disaster_recovery_region_health (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(50) NOT NULL,
  health_score DECIMAL(5,2) NOT NULL,
  status VARCHAR(20) NOT NULL, -- healthy/degraded/critical
  dimensions JSONB NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 切换历史记录
CREATE TABLE disaster_recovery_switch_history (
  id SERIAL PRIMARY KEY,
  from_region VARCHAR(50) NOT NULL,
  to_region VARCHAR(50) NOT NULL,
  trigger_reason TEXT NOT NULL,
  switch_type VARCHAR(20) NOT NULL, -- automatic/manual/drill
  steps_completed JSONB NOT NULL,
  success BOOLEAN NOT NULL,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  rollback_at TIMESTAMP
);

-- 区域配置
CREATE TABLE disaster_recovery_region_config (
  region_code VARCHAR(50) PRIMARY KEY,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  dns_endpoint VARCHAR(200) NOT NULL,
  postgresql_endpoint VARCHAR(200) NOT NULL,
  redis_endpoint VARCHAR(200) NOT NULL,
  kafka_endpoint VARCHAR(200) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  capacity_weight DECIMAL(3,2) DEFAULT 1.0
);
```

### 4.5 API 接口

| 路径 | 方法 | 功能 |
|------|------|------|
| `/admin/disaster-recovery/regions` | GET | 获取所有区域健康状态 |
| `/admin/disaster-recovery/switch` | POST | 手动触发灾备切换 |
| `/admin/disaster-recovery/drill` | POST | 启动灾备演练 |
| `/admin/disaster-recovery/rollback` | POST | 回滚到原主区域 |
| `/admin/disaster-recovery/history` | GET | 获取切换历史记录 |
| `/admin/disaster-recovery/config` | GET/PUT | 管理区域配置 |

### 4.6 Kubernetes 配置

```yaml
# disaster-recovery-controller.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: disaster-recovery-controller
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: dr-controller
        image: minego/dr-controller:latest
        env:
        - name: PRIMARY_REGION
          value: "us-west"
        - name: BACKUP_REGIONS
          value: "us-east,eu-west"
        - name: HEALTH_CHECK_INTERVAL
          value: "10s"
        - name: SWITCH_THRESHOLD
          value: "50"
```

### 4.7 Prometheus 指标

```
disaster_recovery_region_health_score{region="us-west|us-east|eu-west"}
disaster_recovery_switch_total{type="automatic|manual|drill"}
disaster_recovery_switch_success_rate
disaster_recovery_switch_duration_seconds
disaster_recovery_switch_step_duration{step="validateDataSync|drainTraffic|..."}
```

## 5. 验收标准（可测试）

- [ ] 主区域健康分数持续 <50 超过 30 秒时，自动触发灾备切换
- [ ] 切换流程总时长 ≤60 秒（从触发到服务恢复）
- [ ] 数据同步验证失败时，不执行切换并记录详细原因
- [ ] 灾备演练模式下不切换实际流量，但执行完整流程验证
- [ ] 回滚功能能在原区域恢复后自动或手动触发
- [ ] 提供 Grafana 仪表板展示区域健康分数和切换历史
- [ ] 所有切换操作记录完整审计日志

## 6. 工作量估算

**XL** - 这是复杂的跨区域灾备系统，涉及：
- 健康监控引擎：~600 行
- 决策引擎：~400 行
- 切换编排器：~800 行
- K8s 配置 + DNS 管理集成：~300 行
- 数据库迁移 + API：~200 行
- 测试覆盖（含演练测试）：~500 行
- 文档与仪表板：~3 小时

预计开发周期：3-5 天

## 7. 优先级理由

P0 级别 - 灾备自动化是生产可用性的核心保障。当前人工切换可能导致数分钟服务中断，对用户体验和业务影响巨大。自动化灾备切换能将 MTTR（平均恢复时间）从分钟级降到秒级，是"稳定性与高可用"维度的关键补强。