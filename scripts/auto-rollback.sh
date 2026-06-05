#!/bin/bash
# scripts/auto-rollback.sh - 自动回滚脚本
set -e

SERVICE=$1
NAMESPACE=${2:-pmg}
THRESHOLD=${3:-0.05}  # 5% 错误率阈值
DURATION=${4:-300}    # 监控时长（秒）

if [ -z "$SERVICE" ]; then
  echo "Usage: $0 <service> [namespace] [threshold] [duration]"
  echo "Example: $0 user-service pmg 0.05 300"
  exit 1
fi

PROMETHEUS_URL=${PROMETHEUS_URL:-"http://prometheus:9090"}
SLACK_WEBHOOK=${SLACK_WEBHOOK:-""}

echo "🔍 Monitoring $SERVICE for $DURATION seconds..."
echo "   Threshold: $(echo "$THRESHOLD * 100" | bc)% error rate"
echo "   Namespace: $NAMESPACE"

# 获取当前部署版本
CURRENT_REVISION=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
echo "📌 Current revision: $CURRENT_REVISION"

# 监控错误率
START_TIME=$(date +%s)
ERROR_COUNT=0

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  
  if [ $ELAPSED -ge $DURATION ]; then
    echo "✅ Monitoring complete ($DURATION seconds), no rollback needed"
    exit 0
  fi
  
  # 从 Prometheus 获取错误率
  ERROR_RATE=$(curl -s "$PROMETHEUS_URL/api/v1/query?query=sum(rate(http_requests_total{service=\"$SERVICE\",status=~\"5..\"}[5m]))/sum(rate(http_requests_total{service=\"$SERVICE\"}[5m]))" 2>/dev/null | jq -r '.data.result[0].value[1] // 0')
  
  # 如果无法获取 Prometheus 数据，使用健康检查作为备选
  if [ -z "$ERROR_RATE" ] || [ "$ERROR_RATE" = "null" ]; then
    echo "⚠️ Cannot get error rate from Prometheus, using health check as fallback..."
    
    # 检查健康 Pod 数量
    READY_PODS=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    DESIRED_PODS=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.spec.replicas}')
    
    if [ "$READY_PODS" -lt "$DESIRED_PODS" ]; then
      UNHEALTHY_RATIO=$(echo "scale=2; ($DESIRED_PODS - $READY_PODS) / $DESIRED_PODS" | bc)
      ERROR_RATE=$UNHEALTHY_RATIO
    else
      ERROR_RATE=0
    fi
  fi
  
  echo "⏱️  [${ELAPSED}s] Error rate: ${ERROR_RATE}"
  
  # 检查是否超过阈值
  if (( $(echo "$ERROR_RATE > $THRESHOLD" | bc -l) )); then
    ERROR_COUNT=$((ERROR_COUNT + 1))
    echo "⚠️ Error rate ${ERROR_RATE} exceeds threshold ${THRESHOLD} (count: $ERROR_COUNT)"
    
    # 连续 3 次超过阈值才触发回滚
    if [ $ERROR_COUNT -ge 3 ]; then
      echo "🔙 Rolling back $SERVICE due to persistent high error rate..."
      
      # 执行回滚
      kubectl rollout undo deployment/$SERVICE -n $NAMESPACE
      kubectl rollout status deployment/$SERVICE -n $NAMESPACE --timeout=300s
      
      # 发送告警
      if [ -n "$SLACK_WEBHOOK" ]; then
        curl -X POST "$SLACK_WEBHOOK" \
          -H 'Content-Type: application/json' \
          -d "{\"text\":\"🚨 Auto-rollback triggered for $SERVICE. Error rate: ${ERROR_RATE} exceeded threshold ${THRESHOLD}\"}"
      fi
      
      echo "✅ Rollback completed for $SERVICE"
      exit 1
    fi
  else
    ERROR_COUNT=0
  fi
  
  sleep 10
done
