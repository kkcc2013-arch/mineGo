#!/bin/bash
# mineGo 告警监控脚本
# 持续监控告警状态并发送报告

set -e

# 配置
PROMETHEUS_URL=${PROMETHEUS_URL:-"http://localhost:9090"}
ALERTMANAGER_URL=${ALERTMANAGER_URL:-"http://localhost:9093"}
SLACK_WEBHOOK=${SLACK_WEBHOOK:-""}
REPORT_INTERVAL=${REPORT_INTERVAL:-3600}  # 默认 1 小时

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 获取告警统计
get_alert_stats() {
  local alerts=$1
  local p0=$(echo "$alerts" | jq -r '[.[] | select(.labels.priority == "P0" and .status == "firing")] | length' || echo "0")
  local p1=$(echo "$alerts" | jq -r '[.[] | select(.labels.priority == "P1" and .status == "firing")] | length' || echo "0")
  local p2=$(echo "$alerts" | jq -r '[.[] | select(.labels.priority == "P2" and .status == "firing")] | length' || echo "0")
  local resolved=$(echo "$alerts" | jq -r '[.[] | select(.status == "resolved")] | length' || echo "0")
  
  echo "p0=$p0 p1=$p1 p2=$p2 resolved=$resolved"
}

# 发送报告到 Slack
send_slack_report() {
  local p0=$1
  local p1=$2
  local p2=$3
  local resolved=$4
  
  if [ -z "$SLACK_WEBHOOK" ]; then
    return
  fi
  
  local color="good"
  if [ "$p0" -gt 0 ]; then
    color="danger"
  elif [ "$p1" -gt 0 ]; then
    color="warning"
  fi
  
  local message=$(cat <<EOF
{
  "attachments": [
    {
      "color": "$color",
      "title": "📊 mineGo 告警状态报告",
      "fields": [
        {
          "title": "P0 告警",
          "value": "$p0",
          "short": true
        },
        {
          "title": "P1 告警",
          "value": "$p1",
          "short": true
        },
        {
          "title": "P2 告警",
          "value": "$p2",
          "short": true
        },
        {
          "title": "已恢复",
          "value": "$resolved",
          "short": true
        }
      ],
      "footer": "mineGo Alert Monitor",
      "ts": $(date +%s)
    }
  ]
}
EOF
)
  
  curl -s -X POST -H 'Content-Type: application/json' -d "$message" "$SLACK_WEBHOOK" > /dev/null
}

# 主循环
echo "=========================================="
echo "📊 mineGo 告警监控启动"
echo "=========================================="
echo "Prometheus: $PROMETHEUS_URL"
echo "Alertmanager: $ALERTMANAGER_URL"
echo "报告间隔: ${REPORT_INTERVAL}s"
echo ""

while true; do
  # 获取当前时间
  NOW=$(date '+%Y-%m-%d %H:%M:%S')
  
  # 获取 Alertmanager 告警
  ALERTS=$(curl -s "${ALERTMANAGER_URL}/api/v1/alerts" | jq -r '.data' || echo "[]")
  
  # 解析统计
  eval $(get_alert_stats "$ALERTS")
  
  # 输出状态
  echo -e "${BLUE}[$NOW]${NC} 告警状态:"
  echo "  P0 (严重): $p0"
  echo "  P1 (重要): $p1"
  echo "  P2 (通知): $p2"
  echo "  已恢复: $resolved"
  
  # 列出活跃告警
  if [ "$p0" -gt 0 ] || [ "$p1" -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}活跃告警:${NC}"
    echo "$ALERTS" | jq -r '.[] | select(.status == "firing") | "  [\(.labels.priority)] \(.labels.alertname) - \(.annotations.summary)"' | head -10
  fi
  
  # 发送报告
  send_slack_report "$p0" "$p1" "$p2" "$resolved"
  
  # 检查是否需要紧急通知
  if [ "$p0" -gt 3 ]; then
    echo ""
    echo -e "${RED}⚠️ P0 告警过多，可能存在严重故障！${NC}"
  fi
  
  echo ""
  
  # 等待下一次检查
  sleep "$REPORT_INTERVAL"
done
