# REQ-00005：Prometheus 告警规则与 Alertmanager 集成

- **编号**：REQ-00005
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：infrastructure/k8s、所有微服务
- **创建时间**：2026-06-05 01:30
- **依赖需求**：REQ-00002

## 1. 背景与问题

REQ-00002 已为所有服务集成了 Prometheus 指标，包括：
- HTTP 请求指标（延迟、错误率、吞吐量）
- 数据库查询指标（延迟、错误、连接数）
- Redis 缓存指标（命中率、操作延迟）
- WebSocket 连接指标
- 业务指标（捕捉尝试、精灵刷新、Raid 参与者）

但当前存在以下关键缺口：

1. **缺少告警规则**：虽然收集了指标，但没有定义告警规则，无法主动发现问题
2. **缺少通知渠道**：没有配置 Alertmanager，无法将告警发送到 Slack/钉钉/邮件
3. **缺少告警分级**：没有区分 P0/P1/P2 告警严重级别
4. **缺少告警抑制规则**：可能导致告警风暴，淹没关键告警
5. **缺少 SLO/SLI 定义**：没有定义服务可用性目标

这些问题可能导致：
- 服务故障无法及时发现，影响用户体验
- 运维团队被动响应，而非主动预防
- 告警风暴导致重要告警被忽视
- 缺少明确的服务质量标准

## 2. 目标

1. 为所有微服务定义 Prometheus 告警规则（HTTP/DB/Redis/业务指标）
2. 配置 Alertmanager，集成钉钉/Slack 通知渠道
3. 定义告警分级（P0/P1/P2/P3）和抑制规则
4. 定义核心服务的 SLO（服务可用性目标）
5. 在 Grafana 中创建告警可视化仪表板

**预期收益**：
- 平均故障发现时间（MTTD）从 >30 分钟降低到 <5 分钟
- 减少告警噪音 60%（通过抑制规则和分级）
- 运维团队可主动响应问题，而非被动救火
- 建立明确的服务质量标准

## 3. 范围

- **包含**：
  - Prometheus 告警规则文件（prometheus-rules.yml）
  - Alertmanager 配置文件（alertmanager.yml）
  - 钉钉/Slack Webhook 集成
  - 告警分级与抑制规则
  - 核心服务 SLO 定义（API Gateway、Payment、Location）
  - K8s ConfigMap 部署配置
  - 告警测试脚本

- **不包含**：
  - Grafana 仪表板创建（另立需求）
  - 日志告警（应使用 Loki）
  - 分布式追踪告警（应使用 Jaeger）
  - 容量规划告警（需要基线数据）

## 4. 详细需求

### 4.1 Prometheus 告警规则

```yaml
# infrastructure/k8s/monitoring/prometheus-rules.yml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: minego-alerts
  namespace: monitoring
spec:
  groups:
    # ============================================================
    # P0 告警：立即响应（<5 分钟）
    # ============================================================
    - name: minego.p0.critical
      rules:
        # HTTP 错误率 > 10%
        - alert: HighErrorRate
          expr: |
            sum(rate(minego_http_requests_total{status=~"5.."}[5m])) by (service)
            /
            sum(rate(minego_http_requests_total[5m])) by (service)
            > 0.1
          for: 2m
          labels:
            severity: critical
            priority: P0
          annotations:
            summary: "服务 {{ $labels.service }} 错误率过高"
            description: "{{ $labels.service }} 5xx 错误率 {{ $value | humanizePercentage }}，超过 10% 阈值"

        # 数据库连接池耗尽
        - alert: DatabaseConnectionPoolExhausted
          expr: |
            minego_db_connections_active / minego_db_connections_max > 0.9
          for: 1m
          labels:
            severity: critical
            priority: P0
          annotations:
            summary: "服务 {{ $labels.service }} 数据库连接池即将耗尽"
            description: "连接池使用率 {{ $value | humanizePercentage }}，可能影响服务可用性"

        # 支付服务 P99 延迟 > 3s
        - alert: PaymentServiceSlow
          expr: |
            histogram_quantile(0.99, 
              sum(rate(minego_http_request_duration_ms_bucket{service="payment-service"}[5m])) by (le)
            ) > 3000
          for: 5m
          labels:
            severity: critical
            priority: P0
          annotations:
            summary: "支付服务响应缓慢"
            description: "payment-service P99 延迟 {{ $value }}ms，超过 3000ms 阈值"

    # ============================================================
    # P1 告警：重要但不紧急（<15 分钟）
    # ============================================================
    - name: minego.p1.important
      rules:
        # HTTP P95 延迟 > 1s
        - alert: HighLatency
          expr: |
            histogram_quantile(0.95,
              sum(rate(minego_http_request_duration_ms_bucket[5m])) by (service, le)
            ) > 1000
          for: 5m
          labels:
            severity: warning
            priority: P1
          annotations:
            summary: "服务 {{ $labels.service }} 响应缓慢"
            description: "{{ $labels.service }} P95 延迟 {{ $value }}ms"

        # 缓存命中率 < 70%
        - alert: LowCacheHitRate
          expr: |
            sum(rate(minego_cache_hits_total{result="hit"}[10m])) by (service, cache_name)
            /
            sum(rate(minego_cache_hits_total[10m])) by (service, cache_name)
            < 0.7
          for: 10m
          labels:
            severity: warning
            priority: P1
          annotations:
            summary: "缓存 {{ $labels.cache_name }} 命中率过低"
            description: "{{ $labels.service }} 的 {{ $labels.cache_name }} 命中率 {{ $value | humanizePercentage }}"

        # 数据库查询错误率 > 1%
        - alert: DatabaseQueryErrors
          expr: |
            sum(rate(minego_db_query_errors_total[5m])) by (service, query_name)
            /
            sum(rate(minego_db_query_duration_ms_count[5m])) by (service, query_name)
            > 0.01
          for: 5m
          labels:
            severity: warning
            priority: P1
          annotations:
            summary: "数据库查询错误率过高"
            description: "{{ $labels.service }} 的 {{ $labels.query_name }} 错误率 {{ $value | humanizePercentage }}"

    # ============================================================
    # P2 告警：需要关注（<1 小时）
    # ============================================================
    - name: minego.p2.notice
      rules:
        # WebSocket 连接数异常增长
        - alert: WebSocketConnectionsSpike
          expr: |
            sum(minego_websocket_connections_active) > 10000
          for: 10m
          labels:
            severity: info
            priority: P2
          annotations:
            summary: "WebSocket 连接数异常"
            description: "当前活跃连接数 {{ $value }}，可能需要扩容"

        # 捕捉成功率异常下降
        - alert: LowCatchSuccessRate
          expr: |
            sum(rate(minego_catch_attempts_total{result="success"}[30m]))
            /
            sum(rate(minego_catch_attempts_total[30m]))
            < 0.3
          for: 30m
          labels:
            severity: info
            priority: P2
          annotations:
            summary: "捕捉成功率过低"
            description: "最近 30 分钟捕捉成功率 {{ $value | humanizePercentage }}，可能影响游戏体验"

    # ============================================================
    # SLO 告警：服务可用性目标
    # ============================================================
    - name: minego.slo
      rules:
        # API Gateway 可用性 < 99.9%（30 天窗口）
        - alert: APIGatewaySLONotMet
          expr: |
            (
              sum(rate(minego_http_requests_total{service="gateway",status!~"5.."}[30d]))
              /
              sum(rate(minego_http_requests_total{service="gateway"}[30d]))
            ) < 0.999
          for: 1h
          labels:
            severity: warning
            priority: P1
          annotations:
            summary: "API Gateway 未达到可用性 SLO"
            description: "最近 30 天可用性 {{ $value | humanizePercentage }}，目标 99.9%"

        # Payment 可用性 < 99.95%（7 天窗口）
        - alert: PaymentServiceSLONotMet
          expr: |
            (
              sum(rate(minego_http_requests_total{service="payment-service",status!~"5.."}[7d]))
              /
              sum(rate(minego_http_requests_total{service="payment-service"}[7d]))
            ) < 0.9995
          for: 30m
          labels:
            severity: critical
            priority: P0
          annotations:
            summary: "支付服务未达到可用性 SLO"
            description: "最近 7 天可用性 {{ $value | humanizePercentage }}，目标 99.95%"
```

### 4.2 Alertmanager 配置

```yaml
# infrastructure/k8s/monitoring/alertmanager.yml
global:
  resolve_timeout: 5m
  # 钉钉 Webhook（通过钉钉机器人）
  # Slack Webhook（如需 Slack 通知）

route:
  # 默认接收者
  receiver: 'default'
  # 按 severity 和 priority 分组
  group_by: ['severity', 'priority', 'service']
  # 同组告警等待时间（避免重复通知）
  group_wait: 30s
  # 同组告警间隔时间
  group_interval: 5m
  # 重复告警间隔时间
  repeat_interval: 4h

  routes:
    # P0 告警 → 立即通知 + 电话
    - match:
        priority: P0
      receiver: 'p0-critical'
      group_wait: 10s
      group_interval: 1m
      repeat_interval: 1h
      continue: false

    # P1 告警 → 钉钉通知
    - match:
        priority: P1
      receiver: 'p1-important'
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      continue: false

    # P2 告警 → Slack 通知
    - match:
        priority: P2
      receiver: 'p2-notice'
      group_wait: 5m
      group_interval: 30m
      repeat_interval: 12h
      continue: false

# 接收者配置
receivers:
  - name: 'default'
    slack_configs:
      - channel: '#minego-alerts'
        send_resolved: true
        title: '{{ .Status | toUpper }}: {{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'

  - name: 'p0-critical'
    # 钉钉 Webhook
    webhook_configs:
      - url: 'http://dingtalk-webhook:8060/dingtalk/p0/send'
        send_resolved: true
    # 同时发送 Slack
    slack_configs:
      - channel: '#minego-p0-alerts'
        send_resolved: true

  - name: 'p1-important'
    slack_configs:
      - channel: '#minego-p1-alerts'
        send_resolved: true

  - name: 'p2-notice'
    slack_configs:
      - channel: '#minego-alerts'
        send_resolved: true

# 抑制规则
inhibit_rules:
  # 如果服务宕机（P0），抑制该服务的所有 P1/P2 告警
  - source_match:
      severity: 'critical'
      alertname: 'ServiceDown'
    target_match_re:
      severity: 'warning|info'
    equal: ['service']

  # 如果数据库连接池耗尽（P0），抑制数据库查询错误告警
  - source_match:
      alertname: 'DatabaseConnectionPoolExhausted'
    target_match_re:
      alertname: 'DatabaseQueryErrors'
    equal: ['service']
```

### 4.3 K8s ConfigMap 部署

```yaml
# infrastructure/k8s/monitoring/kube-prometheus-stack-values.yml
prometheus:
  prometheusSpec:
    additionalPrometheusRules:
      - name: minego-alerts
        groups:
          # 从 prometheus-rules.yml 加载

alertmanager:
  config:
    # 从 alertmanager.yml 加载
```

### 4.4 钉钉 Webhook 集成

```yaml
# infrastructure/k8s/monitoring/dingtalk-webhook-deployment.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dingtalk-webhook
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: dingtalk-webhook
  template:
    metadata:
      labels:
        app: dingtalk-webhook
    spec:
      containers:
        - name: dingtalk-webhook
          image: timonwong/prometheus-webhook-dingtalk:latest
          args:
            - --web.listen-address=:8060
            - --config.file=/config/dingtalk.yml
          volumeMounts:
            - name: config
              mountPath: /config
          env:
            - name: DINGTALK_TOKEN
              valueFrom:
                secretKeyRef:
                  name: dingtalk-secret
                  key: token
      volumes:
        - name: config
          configMap:
            name: dingtalk-config
```

### 4.5 告警测试脚本

```bash
#!/bin/bash
# scripts/test-alerts.sh

echo "🧪 测试 Prometheus 告警规则..."

# 1. 测试 HighErrorRate 告警
echo "1. 触发高错误率告警..."
curl -X POST http://localhost:8080/api/test/error-rate \
  -H "Content-Type: application/json" \
  -d '{"error_rate": 0.15}'

sleep 120  # 等待 2 分钟触发告警

# 2. 测试数据库连接池告警
echo "2. 触发数据库连接池耗尽告警..."
curl -X POST http://localhost:8082/api/test/db-connections \
  -H "Content-Type: application/json" \
  -d '{"connections": 95}'

sleep 60

# 3. 检查 Alertmanager 是否收到告警
echo "3. 检查 Alertmanager..."
curl http://localhost:9093/api/v1/alerts | jq .

echo "✅ 告警测试完成"
```

## 5. 验收标准（可测试）

- [ ] Prometheus 告警规则文件已创建并部署到 K8s
- [ ] Alertmanager 配置文件已创建并部署到 K8s
- [ ] P0 告警能在 5 分钟内发送到钉钉/Slack
- [ ] P1 告警能在 15 分钟内发送到 Slack
- [ ] 告警抑制规则生效（服务宕机时抑制 P1/P2 告警）
- [ ] SLO 告警正确计算（可用性目标 99.9%）
- [ ] 告警测试脚本可通过（触发告警并验证通知）
- [ ] K8s ConfigMap/Secret 已正确配置
- [ ] README 更新告警规则说明

## 6. 工作量估算

**L（大型）**

理由：
- 需要定义约 15-20 条告警规则
- 需要配置 Alertmanager 多个通知渠道
- 需要编写 K8s 部署文件（ConfigMap、Deployment、Service）
- 需要测试告警触发和抑制逻辑
- 需要与钉钉/Slack Webhook 集成
- 预计 3-5 天完成

## 7. 优先级理由

**P1 级别**

1. **可观测性关键缺口**：有指标无告警，等于没有监控
2. **影响故障响应速度**：缺少告警可能导致故障发现延迟
3. **依赖 REQ-00002**：需要在 Prometheus 指标基础上构建
4. **对项目可用性的贡献**：可观测性维度从 10/10 提升到更完善水平
5. **生产环境必需**：没有告警系统的服务不应上生产
