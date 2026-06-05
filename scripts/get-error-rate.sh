#!/bin/bash
# scripts/get-error-rate.sh - 获取服务错误率
set -e

SERVICE=${1:-"all"}
NAMESPACE=${2:-pmg}
PROMETHEUS_URL=${PROMETHEUS_URL:-"http://prometheus:9090"}

if [ "$SERVICE" = "all" ]; then
  QUERY='sum(rate(http_requests_total{status=~"5.."}[5m]))/sum(rate(http_requests_total[5m]))'
else
  QUERY="sum(rate(http_requests_total{service=\"$SERVICE\",status=~\"5..\"}[5m]))/sum(rate(http_requests_total{service=\"$SERVICE\"}[5m]))"
fi

ERROR_RATE=$(curl -s "$PROMETHEUS_URL/api/v1/query?query=$QUERY" | jq -r '.data.result[0].value[1] // 0')

if [ -z "$ERROR_RATE" ] || [ "$ERROR_RATE" = "null" ]; then
  echo "0"
else
  echo "$ERROR_RATE"
fi
