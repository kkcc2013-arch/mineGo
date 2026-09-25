# mineGo 可观测性栈（REQ-00042）

链路（Jaeger v2，OTLP）＋ 日志（Alloy → Loki）＋ 指标（Prometheus → Alertmanager）＋ 可视化（Grafana），三者按 `trace_id` 关联。

| 组件 | 本地地址 | 配置 |
|---|---|---|
| Grafana | http://localhost:3300（admin / `GRAFANA_ADMIN_PASSWORD`，默认 admin） | `grafana/provisioning/`、`../dashboards/*.json` |
| Jaeger UI | http://localhost:16686；OTLP/HTTP 接收 `:4318` | 镜像默认配置（内存存储） |
| Prometheus | http://localhost:9090 | `prometheus/prometheus.yml`，规则 `../alertmanager/rules.yml` |
| Alertmanager | http://localhost:9093 | `alertmanager/alertmanager.yml` |
| Loki | http://localhost:3100 | `loki/loki-config.yml`，日志告警 `loki/rules/fake/minego-logs.yml` |
| Alloy | —（采集 `pmg-*` 容器 stdout） | `alloy/config.alloy` |

## 一键启动（本地 docker compose）

```bash
docker compose up -d monitoring                                      # 只起监控栈
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 docker compose up -d  # 应用服务开启链路上报
```

PM2 运行的服务（宿主机）：在 `.env` 设 `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` 后 `pm2 reload ecosystem.config.js --update-env`。
PM2 日志不经过 Docker，Alloy 默认不采集；需要时在 `alloy/config.alloy` 增加 `local.file_match` 指向 `~/.pm2/logs/*.log`。

## 工作方式

- **链路**：`backend/shared/tracing.js` 在每个服务入口第一行初始化（未设 `OTEL_EXPORTER_OTLP_ENDPOINT` 时不启用），
  自动埋点 HTTP / Express / PostgreSQL / Redis（ioredis、node-redis）/ Kafka；采样率开发 100%、生产 10%（`OTEL_TRACES_SAMPLER_ARG`）。
- **日志**：pino JSON Lines，字段 `level`、`service`、`timestamp`、`trace_id`、`request_id`（`backend/shared/logger.js`）。
  启用追踪时网关以活动 span 的 trace id 为准，日志中的 `trace_id` 与 Jaeger 一致。
- **关联**：Grafana 中 Loki 日志的 `trace_id` 可点击跳转 Jaeger；Jaeger 的 span 可查看同一 trace 的日志。
- **仪表盘**（`infrastructure/dashboards/`）：服务调用拓扑（Jaeger 依赖图）、错误率（5xx 占比 + error 日志速率 + 错误日志）、P99 延迟（热力图 + 分位数 + 最慢接口）。
- **告警**：Prometheus 规则 `MinegoHighErrorRate`（5xx > 5%）、`MinegoHighLatencyP99`（> 2s）、`MinegoServiceDown`；
  Loki 规则 `MinegoHighErrorLogRate`（error 日志 > 1 条/秒）、`MinegoErrorLogBurst`。

## Kubernetes

`infrastructure/k8s/monitoring/`：`jaeger.yaml`（v2）、`loki.yaml`、`alloy-daemonset.yaml`（需求原文的 promtail，Promtail 已停止维护）、
`grafana-logs-traces.yaml`（数据源与仪表盘 ConfigMap，供 kube-prometheus-stack 的 Grafana sidecar 加载）。
指标告警沿用已有的 `prometheus-rules.yml`（PrometheusRule）。服务通过 `pmg-config` 中的 `OTEL_EXPORTER_OTLP_ENDPOINT` 上报链路。

修改 `grafana/provisioning/datasources/datasources.yml` 或 `../dashboards/*.json` 后，按 `grafana-logs-traces.yaml` 文件头说明重新生成。

## 验证清单（未在本仓库环境运行）

1. 规则单测：`docker run --rm -v "$PWD/infrastructure/alertmanager:/w" -w /w --entrypoint promtool prom/prometheus:v3.15.0 test rules rules.test.yml`
2. 配置检查：`promtool check config`、`amtool check-config`、`alloy fmt`、`loki -verify-config`
3. `docker compose up -d monitoring` 后：Grafana 三个仪表盘有数据；Explore → Loki 按 `trace_id` 过滤；点击跳转 Jaeger
4. 跑一次核心冒烟（`scripts/smoke-core-flow.js`），在 Jaeger 中查看 catch → user → pokemon 的跨服务链路；Jaeger「System Architecture」/ Grafana 拓扑图显示 9 个服务
5. `scripts/fire-test-alert.sh`：Alertmanager 收到模拟告警
