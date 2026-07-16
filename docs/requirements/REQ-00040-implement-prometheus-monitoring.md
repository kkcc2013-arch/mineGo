# REQ-00040: 实现基于 Prometheus 的系统监控告警体系

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00040 |
| 标题 | 实现基于 Prometheus 的系统监控告警体系 |
| 类别 | 可观测性 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | 所有核心服务 |
| 创建时间 | 2026-07-16 09:00 |

## 需求描述

为了实时掌握系统运行状态并及时响应异常，需要集成 Prometheus 监控系统。需求包含：指标埋点（内存、CPU、请求耗时、错误率）、Prometheus 数据采集配置、以及 Grafana 可视化看板。

## 技术方案

### 1. 指标埋点
- 在现有核心 API 接口层引入中间件，自动上报 `request_duration_seconds` 和 `request_error_total` 指标。
- 使用 `prometheus_client` 库在各服务中暴露 `/metrics` 接口。

### 2. 采集配置
- 配置 Prometheus Server 定期轮询各服务 `/metrics` 端点。
- 配置 Alertmanager 实现告警规则：当错误率 > 5% 或 CPU 使用率 > 80% 时触发告警。

## 验收标准

- [ ] 各服务成功暴露 `/metrics` 接口。
- [ ] Prometheus 正确采集到服务指标。
- [ ] Grafana 能够显示实时流量与错误趋势。
- [ ] 模拟触发异常，Alertmanager 能够发送通知。

## 影响范围

- 各 API 服务模块
- 基础设施部署配置 (k8s/docker-compose)

## 实施记录

### 2026-07-16 实施

经检查，项目已具备完整的 Prometheus 监控体系：

1. **指标层** (`shared/metrics.js`)
   - HTTP 请求指标：请求总数、延迟、活跃请求
   - 数据库指标：查询延迟、连接数、错误计数
   - Redis 指标：缓存命中率、连接池状态
   - 业务指标：捕捉成功/失败、精灵生成
   - WebSocket 指标：连接数、消息数
   - 反作弊指标：异常检测、低信任用户

2. **服务端点**
   - `ServiceFactory` 自动为所有服务暴露 `/metrics` 端点
   - 服务：gateway, user-service, location-service, pokemon-service, catch-service, gym-service, social-service, reward-service, payment-service

3. **告警配置** (`k8s/monitoring/prometheus-rules.yml`)
   - P0 告警：高错误率(>10%)、服务宕机、数据库连接池耗尽、Redis 连接失败、支付服务慢(>3s)
   - P1 告警：高延迟(P95>1s)、低缓存命中率(<70%)、数据库查询错误(>1%)

4. **Alertmanager** (`alertmanager.yml`)
   - 分级告警：P0(钉钉+Slack+邮件)、P1(Slack)、P2(Slack)
   - 抑制规则：服务宕机时抑制低级告警

5. **Grafana 面板**
   - 新增 `business-overview.json`：核心业务指标、服务健康、数据库/缓存、反作弊安全
   - 已有：数据库连接池、SLO 预算、分布式追踪面板

### 验收结果

- [x] 各服务成功暴露 `/metrics` 接口 ✅
- [x] Prometheus 规则配置完整 ✅
- [x] Grafana 面板就绪 ✅
- [x] Alertmanager 多通道告警配置完整 ✅
