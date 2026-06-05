#!/bin/bash
# scripts/deploy-service.sh - 单服务滚动更新部署脚本
set -e

SERVICE=$1
VERSION=$2
NAMESPACE=${3:-pmg}
TIMEOUT=${4:-300}

if [ -z "$SERVICE" ] || [ -z "$VERSION" ]; then
  echo "Usage: $0 <service> <version> [namespace] [timeout]"
  echo "Example: $0 user-service abc123 pmg 300"
  exit 1
fi

echo "🚀 Deploying $SERVICE with version $VERSION to namespace $NAMESPACE..."

# 获取当前部署版本
CURRENT_REVISION=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null || echo "0")
echo "📌 Current revision: $CURRENT_REVISION"

# 设置容器镜像
kubectl set image deployment/$SERVICE \
  $SERVICE=registry.cn-shanghai.aliyuncs.com/pmg/$SERVICE:$VERSION \
  -n $NAMESPACE \
  --record

# 添加 change-cause 注解
kubectl annotate deployment $SERVICE \
  kubernetes.io/change-cause="Deploy version $VERSION at $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -n $NAMESPACE \
  --overwrite

echo "⏳ Waiting for rollout to complete (timeout: ${TIMEOUT}s)..."
kubectl rollout status deployment/$SERVICE -n $NAMESPACE --timeout=${TIMEOUT}s

# 验证部署
READY_PODS=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.status.readyReplicas}')
DESIRED_PODS=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.spec.replicas}')

if [ "$READY_PODS" != "$DESIRED_PODS" ]; then
  echo "❌ Deployment failed: Ready pods ($READY_PODS) != Desired pods ($DESIRED_PODS)"
  exit 1
fi

echo "✅ Deployment successful: $SERVICE @ $VERSION ($READY_PODS/$DESIRED_PODS pods ready)"

# 记录部署信息
NEW_REVISION=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
echo "📌 New revision: $NEW_REVISION"
