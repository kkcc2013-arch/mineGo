# REQ-00006：K8s 滚动更新与回滚自动化

- **编号**：REQ-00006
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：infrastructure/k8s、GitHub Actions、所有微服务
- **创建时间**：2026-06-05 02:00
- **依赖需求**：REQ-00002

## 1. 背景与问题

当前项目已具备基础的 CI/CD 流程（GitHub Actions），但存在以下关键缺口：

1. **缺少滚动更新策略**：部署时直接替换 Pod，可能导致服务短暂不可用
2. **缺少自动回滚机制**：部署失败时需要手动回滚，恢复时间长
3. **缺少健康检查验证**：部署后未验证服务健康状态即标记成功
4. **缺少灰度发布能力**：无法逐步放量验证新版本
5. **缺少部署历史追踪**：难以追溯部署变更和回滚记录

这些问题可能导致：
- 部署过程中服务中断，影响用户体验
- 部署失败后恢复时间长（MTTR > 30 分钟）
- 问题版本扩散到所有实例
- 缺少部署可追溯性，难以排查问题

## 2. 目标

1. 为所有微服务配置 K8s RollingUpdate 策略（maxSurge/maxUnavailable）
2. 实现自动回滚机制（基于健康检查和错误率）
3. 在 GitHub Actions 中集成部署验证和回滚流程
4. 实现基础灰度发布能力（Canary Deployment）
5. 建立部署历史记录和通知机制

**预期收益**：
- 部署零停机（Zero-Downtime Deployment）
- 部署失败自动回滚，MTTR < 5 分钟
- 问题版本影响范围可控（灰度发布）
- 部署过程可追溯、可审计

## 3. 范围

- **包含**：
  - K8s Deployment 滚动更新配置
  - GitHub Actions 部署工作流优化
  - 自动回滚脚本（基于 Prometheus 指标）
  - 灰度发布配置（Flux/ArgoCD 或手动）
  - 部署历史记录（GitHub Releases + Slack 通知）
  - 健康检查验证脚本

- **不包含**：
  - 完整的 GitOps 流程（ArgoCD/Flux）
  - 蓝绿部署（需要双倍资源）
  - A/B 测试发布
  - 金丝雀分析平台（如 Kayenta）

## 4. 详细需求

### 4.1 K8s Deployment 滚动更新配置

```yaml
# infrastructure/k8s/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Values.service.name }}
  annotations:
    # 部署历史追踪
    kubernetes.io/change-cause: "{{ .Values.deploy.commit }} - {{ .Values.deploy.message }}"
spec:
  replicas: {{ .Values.service.replicas }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      # 最多超出期望副本数 25%（渐进式发布）
      maxSurge: 25%
      # 最多不可用副本数 25%（保证 75% 可用）
      maxUnavailable: 25%
  revisionHistoryLimit: 10  # 保留 10 个历史版本用于回滚
  selector:
    matchLabels:
      app: {{ .Values.service.name }}
  template:
    metadata:
      labels:
        app: {{ .Values.service.name }}
        version: {{ .Values.deploy.version }}
    spec:
      containers:
        - name: {{ .Values.service.name }}
          image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
          # 就绪探针（新 Pod 必须就绪才接收流量）
          readinessProbe:
            httpGet:
              path: /health
              port: {{ .Values.service.port }}
            initialDelaySeconds: 10
            periodSeconds: 5
            successThreshold: 3
            failureThreshold: 3
          # 存活探针（检测死锁）
          livenessProbe:
            httpGet:
              path: /health
              port: {{ .Values.service.port }}
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          # 启动探针（慢启动保护）
          startupProbe:
            httpGet:
              path: /health
              port: {{ .Values.service.port }}
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 30  # 最多等待 150s 启动
```

### 4.2 GitHub Actions 部署工作流

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      service:
        description: 'Service to deploy'
        required: true
      version:
        description: 'Version to deploy'
        required: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/setup-kubectl@v3
        with:
          version: 'v1.28.0'

      - name: Set kubeconfig
        run: |
          echo "${{ secrets.KUBE_CONFIG }}" | base64 -d > kubeconfig
          export KUBECONFIG=kubeconfig

      - name: Deploy with Rolling Update
        run: |
          SERVICE=${{ github.event.inputs.service || 'all' }}
          VERSION=${{ github.event.inputs.version || github.sha }}
          
          if [ "$SERVICE" = "all" ]; then
            # 部署所有服务
            for svc in gateway user location pokemon catch gym social reward payment; do
              ./scripts/deploy-service.sh $svc $VERSION
            done
          else
            ./scripts/deploy-service.sh $SERVICE $VERSION
          fi

      - name: Wait for Rollout
        run: |
          SERVICE=${{ github.event.inputs.service || 'all' }}
          TIMEOUT=300  # 5 分钟超时
          
          if [ "$SERVICE" = "all" ]; then
            for svc in gateway user location pokemon catch gym social reward payment; do
              kubectl rollout status deployment/$svc -n minego --timeout=${TIMEOUT}s
            done
          else
            kubectl rollout status deployment/$SERVICE -n minego --timeout=${TIMEOUT}s
          fi

      - name: Verify Health Check
        run: |
          SERVICE=${{ github.event.inputs.service || 'all' }}
          ./scripts/verify-health.sh $SERVICE

      - name: Monitor Error Rate (5 minutes)
        run: |
          # 等待 5 分钟，监控错误率
          sleep 300
          ERROR_RATE=$(./scripts/get-error-rate.sh)
          if (( $(echo "$ERROR_RATE > 0.05" | bc -l) )); then
            echo "::error::Error rate too high: $ERROR_RATE"
            exit 1
          fi

      - name: Rollback on Failure
        if: failure()
        run: |
          SERVICE=${{ github.event.inputs.service || 'all' }}
          echo "::warning::Deployment failed, rolling back..."
          
          if [ "$SERVICE" = "all" ]; then
            for svc in gateway user location pokemon catch gym social reward payment; do
              kubectl rollout undo deployment/$svc -n minego
            done
          else
            kubectl rollout undo deployment/$SERVICE -n minego
          fi

      - name: Notify Slack
        if: always()
        uses: 8398a7/action-slack@v3
        with:
          status: ${{ job.status }}
          fields: repo,message,commit,author,action,eventName,ref,workflow
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}

      - name: Create GitHub Release
        if: success()
        uses: softprops/action-gh-release@v1
        with:
          tag_name: v${{ github.event.inputs.version || github.sha }}
          body: |
            Deployed ${{ github.event.inputs.service || 'all' }} to production
            Commit: ${{ github.sha }}
            Author: ${{ github.actor }}
```

### 4.3 自动回滚脚本

```bash
#!/bin/bash
# scripts/auto-rollback.sh

SERVICE=$1
NAMESPACE=${2:-minego}
THRESHOLD=${3:-0.05}  # 5% 错误率阈值
DURATION=${4:-300}    # 监控时长（秒）

echo "🔍 Monitoring $SERVICE for $DURATION seconds..."

# 获取当前部署版本
CURRENT_REVISION=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')

# 监控错误率
START_TIME=$(date +%s)
while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  
  if [ $ELAPSED -ge $DURATION ]; then
    echo "✅ Monitoring complete, no rollback needed"
    exit 0
  fi
  
  # 从 Prometheus 获取错误率
  ERROR_RATE=$(curl -s "http://prometheus:9090/api/v1/query?query=sum(rate(minego_http_requests_total{service=\"$SERVICE\",status=~\"5..\"}[5m]))/sum(rate(minego_http_requests_total{service=\"$SERVICE\"}[5m]))" | jq -r '.data.result[0].value[1] // 0')
  
  if (( $(echo "$ERROR_RATE > $THRESHOLD" | bc -l) )); then
    echo "⚠️ Error rate $ERROR_RATE exceeds threshold $THRESHOLD"
    echo "🔙 Rolling back $SERVICE..."
    
    kubectl rollout undo deployment/$SERVICE -n $NAMESPACE
    kubectl rollout status deployment/$SERVICE -n $NAMESPACE --timeout=300s
    
    # 发送告警
    curl -X POST $SLACK_WEBHOOK \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"🚨 Auto-rollback triggered for $SERVICE. Error rate: $ERROR_RATE\"}"
    
    exit 1
  fi
  
  sleep 10
done
```

### 4.4 灰度发布配置

```yaml
# infrastructure/k8s/canary/canary-deployment.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-service
  namespace: minego
spec:
  # 目标 Deployment
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  # Istio/Flagger 服务网格
  service:
    port: 8087
    targetPort: 8087
  # 灰度发布分析
  analysis:
    # 灰度时间 10 分钟
    interval: 1m
    threshold: 10
    # 每次增加 10% 流量
    stepWeight: 10
    maxWeight: 50
    # 回滚条件
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m
```

### 4.5 部署验证脚本

```bash
#!/bin/bash
# scripts/verify-health.sh

SERVICE=$1
NAMESPACE=${2:-minego}
TIMEOUT=${3:-60}

echo "🔍 Verifying health for $SERVICE..."

# 等待所有 Pod 就绪
kubectl wait --for=condition=ready pod -l app=$SERVICE -n $NAMESPACE --timeout=${TIMEOUT}s

# 检查健康检查端点
PODS=$(kubectl get pods -l app=$SERVICE -n $NAMESPACE -o jsonpath='{.items[*].metadata.name}')

for POD in $PODS; do
  HEALTH=$(kubectl exec $POD -n $NAMESPACE -- curl -s http://localhost:8080/health)
  if [ "$HEALTH" != "ok" ]; then
    echo "::error::Pod $POD health check failed: $HEALTH"
    exit 1
  fi
  echo "✅ Pod $POD is healthy"
done

echo "✅ All pods are healthy"
```

### 4.6 部署历史记录

```bash
#!/bin/bash
# scripts/deploy-history.sh

SERVICE=$1
NAMESPACE=${2:-minego}

echo "📜 Deployment history for $SERVICE:"

# 显示历史版本
kubectl rollout history deployment/$SERVICE -n $NAMESPACE

# 显示当前版本
CURRENT=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
echo ""
echo "Current revision: $CURRENT"

# 显示最近的 ReplicaSet
kubectl get rs -l app=$SERVICE -n $NAMESPACE --sort-by='.metadata.creationTimestamp' | tail -5
```

## 5. 验收标准（可测试）

- [ ] 所有微服务 Deployment 配置了 RollingUpdate 策略
- [ ] GitHub Actions 部署工作流包含滚动更新和回滚
- [ ] 部署失败时自动回滚（错误率 > 5%）
- [ ] 健康检查验证脚本可执行
- [ ] 部署零停机（滚动更新期间服务可用）
- [ ] 部署历史可查询（kubectl rollout history）
- [ ] Slack 通知部署状态
- [ ] 灰度发布配置文件已创建

## 6. 工作量估算

**L（大型）**

理由：
- 需要修改所有 9 个微服务的 Deployment 配置
- 需要编写 GitHub Actions 工作流（约 200 行）
- 需要编写多个部署脚本（deploy、rollback、verify、history）
- 需要配置 Flagger/ArgoCD 灰度发布
- 需要测试滚动更新和回滚场景
- 预计 3-5 天完成

## 7. 优先级理由

**P1 级别**

1. **运维关键能力**：滚动更新和回滚是生产环境必需能力
2. **影响服务可用性**：缺少滚动更新可能导致部署时服务中断
3. **影响故障恢复速度**：自动回滚可将 MTTR 从 30 分钟降到 5 分钟
4. **对项目可用性的贡献**：运维与交付维度从 3/5 提升到 5/5
5. **生产环境必需**：没有滚动更新的部署策略不应上生产
