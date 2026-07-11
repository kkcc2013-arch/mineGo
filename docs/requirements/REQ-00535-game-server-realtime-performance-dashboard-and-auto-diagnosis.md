# REQ-00535: 游戏服务端实时性能看板与自动诊断系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00535 |
| 标题 | 游戏服务端实时性能看板与自动诊断系统 |
| 类别 | 可观测性 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | infrastructure/monitoring, backend/shared/metrics, admin-dashboard |
| 创建时间 | 2026-07-11 15:00 |

## 需求描述

为了更快速地发现生产环境的服务瓶颈，需要开发一个实时性能看板，结合自动诊断算法，能够实时监控服务的 CPU、内存、请求延迟、吞吐量以及数据库连接池状态。在指标异常时，系统应自动进行初步诊断（如检测慢查询、资源竞争）。

## 技术方案

### 1. 性能指标采集
- 使用 Prometheus 暴露核心监控指标。
- 引入自定义 metrics 采集模块 `backend/shared/metrics`，支持在拦截器中自动埋点。

### 2. 自动诊断模块
- 开发自动诊断服务 `backend/shared/perfAnalyzer`，定时比对基准线。
- 实现慢查询识别逻辑，关联慢请求日志。

### 3. 可视化界面
- 在 `admin-dashboard` 开发实时监控大屏。
- 集成 Grafana 进行指标展示，开发嵌入式诊断建议提示组件。

## 验收标准

- [ ] 实时看板能够展示所有核心服务的资源利用率和请求统计。
- [ ] 系统能够自动识别并高亮显示当前的性能瓶颈点（如慢查询、高 CPU 使用率函数）。
- [ ] 异常指标告警能够触发自动诊断日志生成。

## 影响范围

- infrastructure/monitoring
- backend/shared/metrics
- admin-dashboard

## 参考

- 相关监控文档：docs/infrastructure/monitoring.md
