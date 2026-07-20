# REQ-00617：用户体验实时监控与性能追踪系统（RUM/APM）

- **编号**：REQ-00617
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、gateway、backend/shared/monitoring
- **创建时间**：2026-07-20 19:00
- **依赖需求**：REQ-00614（核心战斗逻辑业务指标监控系统）

## 1. 背景与问题

当前项目的可观测性主要集中在后端服务的日志、指标和分布式追踪上。然而，对于前端用户体验（UX）的实时监控存在明显缺口：

**现有问题：**
1. **前端性能黑盒**：无法感知用户真实的页面加载时间、FPS、交互延迟
2. **用户体验无量化**：缺乏用户满意度指标（如 First Paint、FCP、LCP、CLS）
3. **错误追踪不完整**：前端 JavaScript 错误、资源加载失败未统一收集
4. **行为路径缺失**：无法分析用户在游戏中的操作路径、点击热图、转化漏斗
5. **性能瓶颈难定位**：无法区分是网络问题、渲染问题还是业务逻辑问题

**业务影响：**
- 用户卡顿流失无法及时发现
- 性能退化无预警机制
- 产品迭代缺乏数据驱动

## 2. 目标

建立完整的用户体验实时监控系统（Real User Monitoring, RUM），实现：

1. **核心 Web 指标监控**：自动采集并上报 LCP、FID、CLS、TTFB 等 Core Web Vitals
2. **游戏性能追踪**：FPS、内存占用、WebSocket 延迟、API 响应时间
3. **错误实时上报**：JavaScript 异常、Promise rejection、资源加载失败
4. **用户行为分析**：操作路径、点击热图、功能使用频率
5. **性能告警**：当用户体验指标劣化时自动告警

**可量化目标：**
- 用户性能数据上报延迟 < 500ms
- 关键性能指标采集覆盖率 > 95%
- 性能问题发现时间 < 5 分钟

## 3. 范围

### 包含：
1. **前端 SDK**：轻量级性能采集库（< 10KB gzip），支持自动埋点
2. **数据采集**：Performance API、PerformanceObserver、Game Loop FPS 监控
3. **数据上报**：批量上报、离线缓存、重试机制
4. **后端存储**：时序数据库存储（复用 Prometheus + 自定义存储）
5. **可视化面板**：Grafana 仪表板展示用户体验指标
6. **告警规则**：性能阈值告警、异常检测

### 不包含：
- 会话回放功能（录屏）
- A/B 测试功能
- 用户画像分析
- 商业分析报表

## 4. 详细需求

### 4.1 前端 SDK 实现

**文件路径**：`frontend/game-client/src/monitoring/UxMonitor.js`

**核心功能：**

```javascript
// 初始化配置
{
  appId: 'minego-game-client',
  version: '1.0.0',
  sampleRate: 1.0,           // 采样率（生产环境可降至 0.1）
  endpoint: '/api/ux-metrics',
  batchInterval: 5000,       // 批量上报间隔（ms）
  maxBatchSize: 50           // 单批最大条数
}

// 自动采集指标
- Core Web Vitals: LCP, FID, CLS, TTFB
- 资源加载：JS/CSS/Image 加载时间
- API 性能：fetch/XMLHttpRequest 拦截
- 游戏性能：FPS、内存、Canvas 渲染时间
- 错误追踪：window.onerror, unhandledrejection
```

**性能约束：**
- SDK 初始化时间 < 50ms
- 内存占用增量 < 5MB
- 不阻塞主线程（使用 requestIdleCallback）

### 4.2 数据采集项

**Web 性能指标：**
| 指标 | 采集方式 | 阈值（告警） |
|------|---------|-------------|
| LCP (Largest Contentful Paint) | PerformanceObserver | > 2.5s |
| FID (First Input Delay) | PerformanceEventTiming | > 100ms |
| CLS (Cumulative Layout Shift) | PerformanceObserver | > 0.1 |
| TTFB (Time to First Byte) | performance.timing | > 600ms |
| FCP (First Contentful Paint) | performance.timing | > 1.8s |

**游戏性能指标：**
| 指标 | 采集方式 | 阈值 |
|------|---------|------|
| FPS | requestAnimationFrame | < 30 fps |
| Memory | performance.memory | > 80% heap |
| WebSocket Latency | ping/pong | > 200ms |
| API Response Time | fetch 拦截 | > 1s (P95) |

**错误追踪：**
```javascript
{
  type: 'js_error' | 'resource_error' | 'api_error' | 'websocket_error',
  message: string,
  stack: string,
  context: {
    url: string,
    line: number,
    column: number,
    userAgent: string,
    timestamp: number
  }
}
```

### 4.3 后端存储与查询

**数据库设计：**

```sql
-- 用户体验指标表
CREATE TABLE ux_metrics (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64),
  session_id VARCHAR(128),
  metric_name VARCHAR(64) NOT NULL,
  metric_value DECIMAL(10,3),
  metric_unit VARCHAR(16),
  tags JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_ux_metrics_name_time ON ux_metrics(metric_name, created_at DESC);
CREATE INDEX idx_ux_metrics_user ON ux_metrics(user_id);
CREATE INDEX idx_ux_metrics_session ON ux_metrics(session_id);

-- 错误日志表
CREATE TABLE ux_errors (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64),
  session_id VARCHAR(128),
  error_type VARCHAR(32) NOT NULL,
  error_message TEXT,
  error_stack TEXT,
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ux_errors_type_time ON ux_errors(error_type, created_at DESC);
```

**API 端点**：
- `POST /api/ux-metrics/batch` - 批量上报指标
- `POST /api/ux-errors` - 上报错误
- `GET /api/ux-metrics/summary` - 查询聚合指标
- `GET /api/ux-errors/stats` - 查询错误统计

### 4.4 性能告警规则

**告警配置**（`backend/shared/ux-alert-rules.js`）：

```javascript
[
  {
    name: 'high_lcp',
    metric: 'lcp',
    condition: 'p95 > 2500',  // 毫秒
    severity: 'warning',
    message: 'LCP 过高，影响用户体验',
    autoAction: 'log_to_slack'
  },
  {
    name: 'low_fps',
    metric: 'fps',
    condition: 'avg < 30',
    severity: 'critical',
    message: '游戏帧率过低，影响游戏体验',
    autoAction: 'notify_ops'
  },
  {
    name: 'high_error_rate',
    metric: 'js_error_rate',
    condition: 'rate > 0.05',  // 5%
    severity: 'critical',
    message: '前端错误率异常',
    autoAction: 'create_incident'
  }
]
```

### 4.5 Grafana 仪表板

**面板名称**：User Experience Monitoring

**核心图表：**
1. Core Web Vitals 趋势（LCP/FID/CLS 时序图）
2. FPS 分布（直方图 + 百分位数）
3. API 响应时间分布（P50/P95/P99）
4. 错误率趋势（按类型分组）
5. 用户会话性能排名（最慢 Top 100）
6. 地理位置性能分布（地图可视化）

### 4.6 用户行为分析

**自动采集事件：**
- 页面访问：路由切换、页面停留时长
- 用户操作：点击、滚动、输入
- 功能使用：捕捉精灵、道馆战斗、好友互动

**数据结构：**
```javascript
{
  eventType: 'click' | 'page_view' | 'custom',
  eventName: string,
  element: string,      // CSS selector
  page: string,         // 当前页面路径
  referrer: string,     // 来源页面
  duration: number,     // 停留时长（ms）
  timestamp: number,
  userId: string,
  sessionId: string
}
```

## 5. 验收标准（可测试）

- [ ] 前端 SDK 成功集成到 game-client，初始化时间 < 50ms
- [ ] Core Web Vitals（LCP/FID/CLS）采集覆盖率 > 95%
- [ ] FPS 监控功能正常，准确度误差 < 5%
- [ ] JavaScript 错误自动上报到后端，包含完整堆栈信息
- [ ] 批量上报机制正常，网络请求合并率 > 80%
- [ ] Grafana 仪表板成功展示用户体验指标
- [ ] 性能告警规则生效，告警触发延迟 < 1 分钟
- [ ] 用户行为事件采集正常，事件丢失率 < 1%
- [ ] 单元测试覆盖率 > 80%，集成测试通过
- [ ] 性能测试：SDK 对页面加载时间影响 < 5%

## 6. 工作量估算

**规模**：L（Large）

**理由**：
- 需要开发前端 SDK、后端 API、数据库设计、告警系统
- 涉及多个技术栈：JavaScript、Node.js、PostgreSQL、Prometheus、Grafana
- 需要处理大量时序数据，性能优化复杂
- 预估工作量：3-5 人日

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **用户体验是核心竞争力**：手游的用户留存高度依赖流畅的游戏体验，无监控则无法保障
2. **闭环监控体系**：当前后端监控完善，前端监控缺失，无法形成完整的可观测性闭环
3. **快速问题定位**：前端性能问题占比通常 30%+，无监控则问题定位依赖用户投诉，响应滞后
4. **数据驱动优化**：为性能优化、功能迭代提供数据支撑，提升产品决策质量
5. **合规要求**：Google 将 Core Web Vitals 纳入搜索排名，影响 SEO 和用户获取

**对项目可用的贡献**：
- 提升可观测性维度评分（+5 分）
- 降低用户流失率（通过性能问题快速发现和修复）
- 提升运维效率（性能问题自动告警）
