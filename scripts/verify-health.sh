#!/bin/bash
# scripts/verify-health.sh - 部署健康检查验证脚本
set -e

SERVICE=$1
NAMESPACE=${2:-pmg}
TIMEOUT=${3:-60}

if [ -z "$SERVICE" ]; then
  echo "Usage: $0 <service> [namespace] [timeout]"
  echo "Example: $0 user-service pmg 60"
  exit 1
fi

echo "🔍 Verifying health for $SERVICE in namespace $NAMESPACE..."

# 等待所有 Pod 就绪
echo "⏳ Waiting for pods to be ready (timeout: ${TIMEOUT}s)..."
kubectl wait --for=condition=ready pod -l app=$SERVICE -n $NAMESPACE --timeout=${TIMEOUT}s

# 获取所有 Pod
PODS=$(kubectl get pods -l app=$SERVICE -n $NAMESPACE -o jsonpath='{.items[*].metadata.name}')

if [ -z "$PODS" ]; then
  echo "❌ No pods found for service $SERVICE"
  exit 1
fi

# 检查每个 Pod 的健康状态
POD_COUNT=0
HEALTHY_COUNT=0

for POD in $PODS; do
  POD_COUNT=$((POD_COUNT + 1))
  
  # 获取容器端口
  CONTAINER_PORT=$(kubectl get pod $POD -n $NAMESPACE -o jsonpath='{.spec.containers[0].ports[0].containerPort}' 2>/dev/null || echo "8080")
  
  # 执行健康检查
  HEALTH_STATUS=$(kubectl exec $POD -n $NAMESPACE -- curl -s -o /dev/null -w "%{http_code}" http://localhost:$CONTAINER_PORT/health 2>/dev/null || echo "000")
  
  if [ "$HEALTH_STATUS" = "200" ]; then
    echo "✅ Pod $POD is healthy (HTTP $HEALTH_STATUS)"
    HEALTHY_COUNT=$((HEALTHY_COUNT + 1))
  else
    echo "❌ Pod $POD health check failed (HTTP $HEALTH_STATUS)"
  fi
done

# 检查健康 Pod 比例
HEALTHY_RATIO=$(echo "scale=2; $HEALTHY_COUNT / $POD_COUNT * 100" | bc)

echo ""
echo "📊 Health Summary:"
echo "  - Total Pods: $POD_COUNT"
echo "  - Healthy Pods: $HEALTHY_COUNT"
echo "  - Health Ratio: ${HEALTHY_RATIO}%"

if [ "$HEALTHY_COUNT" -eq "$POD_COUNT" ]; then
  echo "✅ All pods are healthy"
  exit 0
elif [ "$HEALTHY_RATIO" -ge 75 ]; then
  echo "⚠️ Some pods are unhealthy, but majority are healthy (${HEALTHY_RATIO}%)"
  exit 0
else
  echo "❌ Too many unhealthy pods (${HEALTHY_RATIO}% healthy)"
  exit 1
fi
