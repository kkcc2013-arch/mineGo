# REQ-00508: 服务发现与动态负载均衡健康检查系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00508 |
| 标题 | 服务发现与动态负载均衡健康检查系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | infrastructure/service-registry, gateway, backend/shared/health-check |
| 创建时间 | 2026-07-09 04:30 |

## 需求描述

为了提高微服务架构的鲁棒性和自愈能力，需要实现一个基于服务发现机制的动态负载均衡健康检查系统。当服务实例出现故障或响应延迟过高时，负载均衡器应自动将其下线并从流量路径中移除，保障系统的高可用性。

## 技术方案

### 1. 健康检查模块 (backend/shared/health-check)
- 基于轻量级 HTTP 探针 (gRPC 可选) 进行状态检测。
- 支持定义检查频率（默认每 5 秒）、超时时间（2 秒）和失败阈值（3 次重试）。

### 2. 服务注册与发现 (infrastructure/service-registry)
- 集成 Consul 或 Etcd 作为服务注册中心，通过 SDK 定期上报心跳。
- 监听实例状态变化，更新 gateway 的路由映射。

### 3. Gateway 负载均衡策略
- 动态调整加权轮询权重，如果服务实例心跳异常，自动标记为 "DOWN"。
- 在 gateway 中增加健康检测模块，定期清理无效的 upstream。

## 验收标准

- [ ] 服务实例可根据健康检查结果在注册中心自动更新状态。
- [ ] 当服务实例离线时，gateway 能在 10 秒内将其从流量转发列表中移除。
- [ ] 提供监控 Dashboard，展示当前所有服务实例的在线状态和延迟统计。
- [ ] 实现相关压力测试，验证动态切换流量时，用户响应成功率不低于 99.99%。

## 影响范围

- `infrastructure/service-registry` (新增模块)
- `gateway` (路由逻辑更新)
- `backend/shared/health-check` (新增核心代码库)

## 参考

- [微服务高可用模式 - 服务发现](https://microservices.io/patterns/service-registry.html)
- 项目内部架构文档 `/docs/architecture/microservices.md`
