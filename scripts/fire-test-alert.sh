#!/usr/bin/env bash
# REQ-00042：向 Alertmanager 发送一条模拟告警，验证告警路由/通知渠道（不依赖真实错误流量）
#   ALERTMANAGER_URL=http://127.0.0.1:9093 scripts/fire-test-alert.sh [service]
# 告警 5 分钟后自动恢复（endsAt）；在 Alertmanager UI 或 Grafana → Alerting 中查看。
# 规则本身的阈值逻辑用 promtool 单测：infrastructure/alertmanager/rules.test.yml
set -euo pipefail
AM="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
SERVICE="${1:-catch-service}"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ends=$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+5M +%Y-%m-%dT%H:%M:%SZ)
payload=$(cat <<JSON
[{
  "labels": {"alertname": "MinegoHighErrorRate", "severity": "critical", "service": "${SERVICE}", "test": "true"},
  "annotations": {"summary": "【模拟】服务 ${SERVICE} 错误率过高", "description": "scripts/fire-test-alert.sh 发送的测试告警"},
  "startsAt": "${now}",
  "endsAt": "${ends}"
}]
JSON
)
curl -fsS -X POST -H 'Content-Type: application/json' -d "$payload" "${AM}/api/v2/alerts"
echo "已发送模拟告警到 ${AM}；当前告警："
curl -fsS "${AM}/api/v2/alerts?filter=test%3D%22true%22" | head -c 600; echo
