# REQ-00024：蓝绿部署策略实现

- **编号**：REQ-00024
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、infrastructure/k8s、.github/workflows、scripts
- **创建时间**：2026-06-05 16:05
- **依赖需求**：REQ-00006

## 1. 背景与问题

当前 mineGo 项目使用滚动更新策略（REQ-00006），虽然具备自动回滚能力，但存在以下问题：

1. **切换期间仍有短暂风险**：滚动更新逐个替换 Pod，新旧版本共存期间可能出现兼容性问题
2. **回滚速度有限**：需要重新拉取旧镜像、逐个替换，回滚耗时 3-5 分钟
3. **无法预验证**：新版本在接收生产流量前无法进行真实流量测试
4. **缺少流量切换控制**：无法精确控制流量切换比例和时间

蓝绿部署通过维护两套完整环境（blue/green），可以实现：
- 真正的零停机切换（瞬间切换流量）
- 秒级回滚（切回旧环境）
- 新环境预验证（真实流量测试后再全量切换）
- 精确的流量控制

## 2. 目标

实现生产级蓝绿部署策略，达成以下收益：

1. **零停机部署**：流量切换在 1 秒内完成，用户无感知
2. **秒级回滚**：发现问题立即切回旧环境，恢复时间 < 10 秒
3. **新环境验证**：支持在 green 环境进行冒烟测试和流量预览
4. **部署可观测**：完整的部署状态追踪和通知

## 3. 范围

- **包含**：
  - K8s 蓝绿部署架构设计（Service/Ingress 切换机制）
  - 部署脚本：创建新环境、验证、切换、回滚
  - GitHub Actions 工作流集成
  - 部署状态追踪和通知
  - 管理命令：`./scripts/deploy-blue-green.sh`
  
- **不包含**：
  - 数据库迁移策略（已有 REQ-00007）
  - 金丝雀发布（可后续扩展）
  - 多集群部署

## 4. 详细需求

### 4.1 K8s 架构设计

```yaml
# 蓝绿 Service 架构
# 每个服务维护两个版本的 Deployment：
#   - {service}-blue  (当前生产)
#   - {service}-green (新版本)
# 通过 Service selector 切换流量

# 示例：catch-service
apiVersion: apps/v1
kind: Deployment
metadata:
  name: catch-service-blue
  labels:
    app: catch-service
    version: blue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: catch-service
      version: blue
  template:
    # ... pod spec

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: catch-service-green
  labels:
    app: catch-service
    version: green
spec:
  replicas: 0  # 初始为 0，部署时扩容
  # ... pod spec

---
apiVersion: v1
kind: Service
metadata:
  name: catch-service
spec:
  selector:
    app: catch-service
    version: blue  # 通过脚本切换为 green
  ports:
    - port: 8084
```

### 4.2 部署脚本

```bash
# scripts/deploy-blue-green.sh

# 用法：
#   ./scripts/deploy-blue-green.sh deploy <service> <image>   # 部署新版本到 green
#   ./scripts/deploy-blue-green.sh verify <service>           # 验证 green 环境
#   ./scripts/deploy-blue-green.sh switch <service>           # 切换流量到 green
#   ./scripts/deploy-blue-green.sh rollback <service>         # 回滚到 blue
#   ./scripts/deploy-blue-green.sh status                     # 查看当前状态

# 部署流程：
# 1. 确定当前活跃环境（blue 或 green）
# 2. 部署新版本到非活跃环境
# 3. 等待新环境就绪（健康检查通过）
# 4. 运行冒烟测试
# 5. 切换 Service selector
# 6. 监控错误率 5 分钟
# 7. 如有问题，立即回滚
# 8. 缩容旧环境（保留 1 副本用于快速回滚）
```

### 4.3 GitHub Actions 集成

```yaml
# .github/workflows/deploy-blue-green.yml

jobs:
  deploy-green:
    # 部署到 green 环境
    steps:
      - name: Deploy to green
        run: ./scripts/deploy-blue-green.sh deploy all $IMAGE_TAG
      
      - name: Verify green environment
        run: ./scripts/deploy-blue-green.sh verify all
      
      - name: Run smoke tests on green
        run: ./scripts/smoke-test.sh green
      
  switch-production:
    needs: deploy-green
    # 切换生产流量
    steps:
      - name: Switch traffic to green
        run: ./scripts/deploy-blue-green.sh switch all
      
      - name: Monitor for 5 minutes
        run: ./scripts/monitor-error-rate.sh 300
      
      - name: Scale down blue (keep 1 replica)
        run: ./scripts/deploy-blue-green.sh scale-down-blue
```

### 4.4 状态追踪

```bash
# 部署状态存储在 ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: deploy-state
data:
  active-version: "blue"
  blue-commit: "a1b2c3d"
  blue-deployed-at: "2026-06-05T16:00:00Z"
  green-commit: "e4f5g6h"
  green-deployed-at: "2026-06-05T16:05:00Z"
  last-switch: "2026-06-05T16:10:00Z"
```

### 4.5 通知集成

- 部署开始：通知团队新版本部署中
- 验证完成：通知 green 环境就绪
- 切换完成：通知生产流量已切换
- 回滚触发：告警通知回滚原因

## 5. 验收标准（可测试）

- [ ] 运行 `./scripts/deploy-blue-green.sh deploy catch-service test-image:v1` 成功部署到 green 环境
- [ ] green 环境健康检查通过，Pod 状态为 Ready
- [ ] 运行 `./scripts/deploy-blue-green.sh switch catch-service` 在 1 秒内完成流量切换
- [ ] 切换后，请求全部路由到 green 环境（验证 Service selector 已更新）
- [ ] 模拟错误：green 环境返回 500，运行 `./scripts/deploy-blue-green.sh rollback catch-service` 在 10 秒内完成回滚
- [ ] 回滚后，请求全部路由回 blue 环境
- [ ] GitHub Actions 工作流完整运行，包含 deploy → verify → switch → monitor 步骤
- [ ] 部署状态 ConfigMap 正确记录 active-version、commit、时间戳
- [ ] 钉钉/Slack 通知在部署关键节点正确发送
- [ ] 所有 9 个微服务都支持蓝绿部署

## 6. 工作量估算

**L（Large）**

理由：
- 需要重构 K8s 部署架构（每个服务从单 Deployment 改为双 Deployment）
- 编写完整的部署脚本集（deploy/verify/switch/rollback/status）
- 集成 GitHub Actions 工作流
- 实现状态追踪和通知机制
- 测试和验证所有场景

预计工作量：2-3 天

## 7. 优先级理由

**P1 理由**：

1. **生产可用性关键**：蓝绿部署是生产级应用的标准部署策略，直接影响服务可用性
2. **回滚能力提升**：当前滚动更新回滚需要 3-5 分钟，蓝绿部署可缩短到 10 秒内
3. **部署风险降低**：新版本可在隔离环境验证后再切换，大幅降低部署风险
4. **依赖已完成**：REQ-00006（滚动更新）已完成，具备基础部署能力
5. **运维效率**：运维团队需要快速、可靠的部署和回滚能力

对"项目可用"的贡献：提升运维效率和系统稳定性，是生产级运维的必备能力。
