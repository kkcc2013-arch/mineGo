# mineGo 全链路监控可视化大屏

## 功能特性

### 1. 实时监控数据聚合
- 从 Prometheus 和 Jaeger 收集监控数据
- 聚合服务拓扑、SLA/SLO 指标、异常指标
- 自动刷新，支持自定义刷新间隔

### 2. WebSocket 实时推送
- 使用 Socket.io 实现毫秒级数据更新
- 自动重连机制
- 支持多客户端连接

### 3. 智能告警系统
- 错误率、延迟、超时率阈值监控
- 自动检测异常并生成告警
- 支持告警确认和去重
- 分级告警（critical / high / medium / low）

### 4. 可视化大屏
- **SLA/SLO 指标卡片**：显示核心链路（注册、登录、捕捉、对战）的实时性能指标
- **服务拓扑图**：可视化微服务依赖关系和流量负载
- **告警列表**：实时显示活跃告警
- **趋势图表**：错误率、延迟趋势可视化

## 目录结构

```
infrastructure/observability/dashboard/
├── monitoringAggregator.js    # 监控数据聚合服务
├── alertingService.js         # 告警服务
├── websocketServer.js         # WebSocket 服务器
├── package.json               # npm 配置
└── .env.example               # 环境变量示例

dashboard/monitor/
├── index.html                 # 监控大屏 HTML
├── styles.css                 # 样式文件
├── monitor.js                 # 前端逻辑
└── README.md                  # 本文档
```

## 使用方法

### 1. 安装依赖

```bash
cd infrastructure/observability/dashboard
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，设置 Prometheus 和 Jaeger URL
```

### 3. 启动 WebSocket 服务器

```bash
npm start
# 或使用 nodemon 开发模式
npm run dev
```

### 4. 访问监控大屏

打开浏览器访问：`http://localhost:8080/monitor/index.html`

## API 端点

### WebSocket 事件

- **connect**: 连接成功
- **disconnect**: 断开连接
- **initial-data**: 发送初始监控数据
- **metrics-update**: 实时推送更新数据
- **alerts**: 发送告警列表
- **new-alert**: 新告警通知
- **acknowledge-alert**: 确认告警

### HTTP 端点

- **GET /health**: 健康检查

## 配置参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| MONITORING_WS_PORT | WebSocket 服务器端口 | 3001 |
| PROMETHEUS_URL | Prometheus 服务地址 | http://localhost:9090 |
| JAEGER_URL | Jaeger 服务地址 | http://localhost:16686 |
| REFRESH_INTERVAL | 数据刷新间隔（ms） | 5000 |
| ERROR_RATE_THRESHOLD | 错误率告警阈值（%） | 5 |
| LATENCY_THRESHOLD | 延迟告警阈值（ms） | 500 |
| TIMEOUT_THRESHOLD | 超时率告警阈值（%） | 1 |

## Prometheus 查询示例

监控聚合器使用以下 Prometheus 查询：

### 错误率
```promql
sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
```

### 延迟 P99
```promql
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))
```

### 吞吐量
```promql
sum(rate(http_requests_total{link="${link}"}[5m]))
```

## 验收标准

✅ 监控大屏在 500ms 内加载完毕
✅ 支持核心业务链路（捕捉/对战）实时延迟和错误率显示
✅ 拓扑图支持自动发现并展示服务节点关系
✅ 异常链路发生时，大屏能自动高亮告警节点
✅ WebSocket 实时推送（毫秒级更新）
✅ 智能告警系统（阈值监控、去重、分级）

## 技术栈

- **后端**: Node.js + Express + Socket.io + Axios
- **前端**: HTML5 + CSS3 + JavaScript + Chart.js
- **数据源**: Prometheus + Jaeger

## 依赖服务

- **Prometheus**: 监控指标存储和查询
- **Jaeger**: 分布式追踪和拓扑发现

## 未来改进

- 支持历史数据查询和对比
- 添加更多告警渠道（邮件、Slack）
- 支持自定义监控面板
- 添加 SLO 预算燃尽率图表
- 支持多租户隔离