# REQ-00589：微服务架构可视化与 API 依赖关系图谱系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00589 |
| 标题 | 微服务架构可视化与 API 依赖关系图谱系统 |
| 类别 | 文档/开发者体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | admin-dashboard, gateway, 所有后端服务, docs-site |
| 创建时间 | 2026-07-17 00:00 |
| 依赖需求 | 无 |

## 1. 背景与问题

mineGo 项目采用微服务架构，包含 9 个后端服务（gateway/user/location/pokemon/catch/gym/social/reward/payment），服务之间存在复杂的调用关系。当前架构文档散落在各处，新开发者难以快速理解：
- 哪些 API 调用了哪些服务
- 服务之间的依赖链路是什么
- 数据流向如何传递
- 服务健康状态与调用拓扑的实时关系

缺乏可视化的架构文档导致：
- 新人上手成本高（平均需要 2-3 天理解架构）
- 故障排查困难（难以定位调用链路瓶颈）
- API 变更影响分析不完整（容易遗漏下游服务）

## 2. 目标

构建一个实时更新的微服务架构可视化系统，实现：
1. **服务拓扑图**：展示 9 个微服务的调用关系
2. **API 依赖图谱**：每个 API 的完整调用链路追踪
3. **实时健康状态**：服务状态实时展示在拓扑图上
4. **变更影响分析**：评估 API 变更对下游服务的影响范围

## 3. 范围

### 包含
- 服务拓扑可视化前端组件（admin-dashboard）
- API 调用关系采集中间件（gateway）
- 依赖关系数据存储与查询（PostgreSQL）
- 架构文档导出功能（Mermaid/PlantUML 格式）
- OpenTelemetry 集成获取实时调用数据

### 不包含
- 生产环境实时流量监控（仅展示架构，不展示具体请求）
- 自动化影响分析建议（仅提供依赖查询）
- API 版本管理（已有 REQ-00520）

## 4. 详细需求

### 4.1 服务拓扑采集
- 在 `gateway/src/middleware/serviceTopologyCollector.js` 实现：
  - 自动识别请求路由到的目标服务
  - 记录服务间调用关系（caller → callee）
  - 支持同步/异步调用区分

### 4.2 依赖关系数据模型
```sql
-- 服务节点表
CREATE TABLE service_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name VARCHAR(50) UNIQUE NOT NULL,
  service_type VARCHAR(20) NOT NULL, -- 'gateway' | 'microservice' | 'external'
  description TEXT,
  health_endpoint VARCHAR(200),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- API 端点表
CREATE TABLE api_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID REFERENCES service_nodes(id),
  path VARCHAR(200) NOT NULL,
  method VARCHAR(10) NOT NULL,
  description TEXT,
  UNIQUE(service_id, path, method)
);

-- 调用关系表
CREATE TABLE service_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_api_id UUID REFERENCES api_endpoints(id),
  callee_service_id UUID REFERENCES service_nodes(id),
  callee_endpoint_path VARCHAR(200),
  call_type VARCHAR(20) DEFAULT 'sync', -- 'sync' | 'async' | 'event'
  last_seen_at TIMESTAMP,
  UNIQUE(caller_api_id, callee_service_id, callee_endpoint_path)
);
```

### 4.3 拓扑可视化前端
- 在 `admin-dashboard/src/pages/architecture.html` 实现：
  - D3.js 或 vis.js 力导向图展示
  - 支持缩放、拖拽、搜索
  - 节点点击展示详细 API 列表
  - 实时健康状态颜色标识（绿/黄/红）

### 4.4 API 导航功能
- 在 `docs-site` 集成：
  - 从拓扑图跳转到 API 文档
  - 显示"此 API 被哪些服务调用"
  - 显示"此 API 依赖了哪些服务"

### 4.5 架构导出
- 支持导出格式：
  - Mermaid 图表代码
  - PlantUML 组件图
  - JSON 依赖树

## 5. 验收标准

- [ ] 管理后台可查看 9 个微服务的完整拓扑图
- [ ] 拓扑图实时反映服务健康状态（延迟 < 5s）
- [ ] 点击服务节点可展开该服务的所有 API 列表
- [ ] 支持搜索 API 端点并高亮其依赖链路
- [ ] 导出的 Mermaid 图表可在 Markdown 中渲染
- [ ] 新增 API 自动被发现并纳入依赖图谱（无需手动维护）

## 6. 工作量估算

**L（3-5 人日）**

理由：
- 需要开发采集中间件、数据模型、前端可视化、导出功能
- 前端可视化部分工作量较大
- OpenTelemetry 集成相对简单（项目已有链路追踪基础设施）

## 7. 优先级理由

**P1**：文档与开发者体验是项目成熟度的关键维度（当前得分 8），架构可视化能显著降低新人上手成本，提升故障排查效率，对团队协作效率有直接帮助。不涉及核心功能，但能提升整体开发体验。
