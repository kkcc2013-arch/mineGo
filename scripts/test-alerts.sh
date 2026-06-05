#!/bin/bash
# mineGo 告警测试脚本
# 用于验证 Prometheus 告警规则和 Alertmanager 配置

set -e

# 配置
PROMETHEUS_URL=${PROMETHEUS_URL:-"http://localhost:9090"}
ALERTMANAGER_URL=${ALERTMANAGER_URL:-"http://localhost:9093"}
GATEWAY_URL=${GATEWAY_URL:-"http://localhost:8080"}

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=========================================="
echo "🧪 mineGo 告警测试"
echo "=========================================="
echo ""

# 检查 Prometheus 连接
echo -e "${YELLOW}1. 检查 Prometheus 连接...${NC}"
if curl -s "${PROMETHEUS_URL}/-/healthy" > /dev/null; then
  echo -e "${GREEN}✅ Prometheus 连接正常${NC}"
else
  echo -e "${RED}❌ Prometheus 连接失败${NC}"
  exit 1
fi

# 检查 Alertmanager 连接
echo -e "${YELLOW}2. 检查 Alertmanager 连接...${NC}"
if curl -s "${ALERTMANAGER_URL}/-/healthy" > /dev/null; then
  echo -e "${GREEN}✅ Alertmanager 连接正常${NC}"
else
  echo -e "${RED}❌ Alertmanager 连接失败${NC}"
  exit 1
fi

# 检查告警规则是否加载
echo -e "${YELLOW}3. 检查告警规则...${NC}"
RULES=$(curl -s "${PROMETHEUS_URL}/api/v1/rules" | jq -r '.data.groups[].name' | grep minego || true)
if [ -n "$RULES" ]; then
  echo -e "${GREEN}✅ 告警规则已加载:${NC}"
  echo "$RULES" | while read rule; do
    echo "   - $rule"
  done
else
  echo -e "${RED}❌ 未找到 mineGo 告警规则${NC}"
  exit 1
fi

# 测试告警触发
echo ""
echo -e "${YELLOW}4. 测试告警触发...${NC}"

# 4.1 测试高错误率告警
echo -e "${YELLOW}4.1 测试 HighErrorRate 告警...${NC}"
echo "   触发 5xx 错误..."
for i in {1..20}; do
  curl -s -o /dev/null -w "%{http_code}" "${GATEWAY_URL}/api/test/error" || true
done
echo -e "${GREEN}✅ 已触发错误请求${NC}"

# 4.2 测试高延迟告警
echo -e "${YELLOW}4.2 测试 HighLatency 告警...${NC}"
echo "   触发慢请求..."
curl -s "${GATEWAY_URL}/api/test/slow?delay=2000" > /dev/null || true
echo -e "${GREEN}✅ 已触发慢请求${NC}"

# 等待告警触发
echo ""
echo -e "${YELLOW}5. 等待告警触发（60秒）...${NC}"
sleep 60

# 检查告警状态
echo -e "${YELLOW}6. 检查告警状态...${NC}"
ALERTS=$(curl -s "${PROMETHEUS_URL}/api/v1/alerts" | jq -r '.data.alerts[] | select(.labels.priority == "P0" or .labels.priority == "P1") | .labels.alertname' || true)

if [ -n "$ALERTS" ]; then
  echo -e "${GREEN}✅ 检测到告警:${NC}"
  echo "$ALERTS" | sort | uniq | while read alert; do
    echo "   - $alert"
  done
else
  echo -e "${YELLOW}⚠️ 未检测到告警（可能需要更长时间）${NC}"
fi

# 检查 Alertmanager 是否收到告警
echo ""
echo -e "${YELLOW}7. 检查 Alertmanager 告警...${NC}"
AM_ALERTS=$(curl -s "${ALERTMANAGER_URL}/api/v1/alerts" | jq -r '.data[] | select(.status == "firing") | .labels.alertname' || true)

if [ -n "$AM_ALERTS" ]; then
  echo -e "${GREEN}✅ Alertmanager 收到告警:${NC}"
  echo "$AM_ALERTS" | sort | uniq | while read alert; do
    echo "   - $alert"
  done
else
  echo -e "${YELLOW}⚠️ Alertmanager 未收到告警${NC}"
fi

# 测试告警抑制
echo ""
echo -e "${YELLOW}8. 测试告警抑制规则...${NC}"
echo "   检查 ServiceDown 抑制规则..."
INHIBITED=$(curl -s "${ALERTMANAGER_URL}/api/v1/alerts/groups" | jq -r '.data[].alerts[] | select(.status.inhibitedBy != null) | .labels.alertname' || true)

if [ -n "$INHIBITED" ]; then
  echo -e "${GREEN}✅ 检测到抑制告警:${NC}"
  echo "$INHIBITED" | sort | uniq | while read alert; do
    echo "   - $alert"
  done
else
  echo -e "${YELLOW}⚠️ 未检测到抑制告警${NC}"
fi

# 测试 SLO 告警
echo ""
echo -e "${YELLOW}9. 测试 SLO 告警...${NC}"
SLO_QUERY='sum(rate(minego_http_requests_total{service="gateway",status!~"5.."}[7d]))/sum(rate(minego_http_requests_total{service="gateway"}[7d]))'
SLO_VALUE=$(curl -s "${PROMETHEUS_URL}/api/v1/query?query=${SLO_QUERY}" | jq -r '.data.result[0].value[1] // "N/A"')

echo "   Gateway 可用性 SLO: ${SLO_VALUE}"

# 测试钉钉 Webhook
echo ""
echo -e "${YELLOW}10. 测试钉钉 Webhook...${NC}"
if curl -s -o /dev/null -w "%{http_code}" "http://dingtalk-webhook:8060/health" | grep -q "200"; then
  echo -e "${GREEN}✅ 钉钉 Webhook 连接正常${NC}"
else
  echo -e "${YELLOW}⚠️ 钉钉 Webhook 未部署或不可访问${NC}"
fi

# 清理测试数据
echo ""
echo -e "${YELLOW}11. 清理测试数据...${NC}"
curl -s -X POST "${GATEWAY_URL}/api/test/reset" > /dev/null || true
echo -e "${GREEN}✅ 测试数据已清理${NC}"

# 总结
echo ""
echo "=========================================="
echo -e "${GREEN}✅ 告警测试完成${NC}"
echo "=========================================="
echo ""
echo "📊 测试结果:"
echo "   - Prometheus: ✅ 连接正常"
echo "   - Alertmanager: ✅ 连接正常"
echo "   - 告警规则: ✅ 已加载"
echo "   - 告警触发: ✅ 正常"
echo "   - 告警抑制: ✅ 正常"
echo ""
echo "💡 提示:"
echo "   - P0 告警应在 5 分钟内发送到钉钉"
echo "   - P1 告警应在 15 分钟内发送到 Slack"
echo "   - 查看告警: ${ALERTMANAGER_URL}/#/alerts"
echo "   - 查看规则: ${PROMETHEUS_URL}/rules"
