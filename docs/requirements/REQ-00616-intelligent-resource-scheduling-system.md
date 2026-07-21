# REQ-00616: 智能资源调度与自动扩缩容系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00616 |
| 标题 | 智能资源调度与自动扩缩容系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | infrastructure, gateway, autoscaling |
| 创建时间 | 2026-07-20 18:00 |

## 需求描述

当前 mineGo 项目依靠 Kubernetes HPA 和 VPA 进行基础扩缩容。随着业务流量波动日益复杂，静态阈值配置已无法应对突发流量（如大型节假日活动）。需要构建一套智能调度与自动扩缩容系统，结合业务实时流量、历史负载模式和成本预测，动态调整集群资源，平衡性能与成本。

## 技术方案

### 1. 流量特征分析引擎
- 接入业务网关流量实时数据。
- 使用时间序列分析预测未来 1-4 小时的流量趋势。
- 结合历史数据识别节假日或推广活动的流量模式。

### 2. 预测型调度算法
- 将预测流量转换为 Kubernetes 自定义指标 (Custom Metrics)。
- 引入主动扩缩容 (Proactive Scaling)，在高峰到来前 15 分钟提前预热容器。

### 3. 多维度成本-性能权衡机制
- 在非核心业务高峰期，优先选择低成本实例（如 Spot 实例）。
- 在业务高峰期，优先保证核心服务 SLA。

## 验收标准

- [ ] 流量预测准确率达到 90% 以上。
- [ ] 支持在业务高峰到来前提前 15 分钟触发扩容。
- [ ] 生产环境部署资源成本降低 15% 以上。
- [ ] 核心业务接口响应延迟（p99）保持平稳。

## 影响范围

- infrastructure/k8s/hpa/
- gateway/src/
- backend/jobs/

## 参考

- [Kubernetes Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [Prometheus Custom Metrics](https://github.com/kubernetes-sigs/prometheus-adapter)
