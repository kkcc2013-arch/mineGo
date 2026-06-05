#!/bin/bash
# scripts/deploy-history.sh - 部署历史查询脚本
set -e

SERVICE=$1
NAMESPACE=${2:-pmg}

if [ -z "$SERVICE" ]; then
  echo "Usage: $0 <service> [namespace]"
  echo "Example: $0 user-service pmg"
  exit 1
fi

echo "📜 Deployment history for $SERVICE in namespace $NAMESPACE:"
echo "============================================================"
echo ""

# 显示历史版本
kubectl rollout history deployment/$SERVICE -n $NAMESPACE

echo ""
echo "============================================================"

# 显示当前版本
CURRENT=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
echo "📌 Current revision: $CURRENT"

# 显示 change-cause
CHANGE_CAUSE=$(kubectl get deployment $SERVICE -n $NAMESPACE -o jsonpath='{.metadata.annotations.kubernetes\.io/change-cause}')
if [ -n "$CHANGE_CAUSE" ]; then
  echo "📝 Change cause: $CHANGE_CAUSE"
fi

echo ""
echo "============================================================"

# 显示最近的 ReplicaSet
echo "📊 Recent ReplicaSets:"
kubectl get rs -l app=$SERVICE -n $NAMESPACE --sort-by='.metadata.creationTimestamp' | tail -5

echo ""
echo "============================================================"

# 显示当前 Pod 状态
echo "🎯 Current Pods:"
kubectl get pods -l app=$SERVICE -n $NAMESPACE -o wide

echo ""
echo "============================================================"

# 显示部署事件
echo "📋 Recent Events:"
kubectl get events -n $NAMESPACE --field-selector involvedObject.name=$SERVICE --sort-by='.lastTimestamp' | tail -10
