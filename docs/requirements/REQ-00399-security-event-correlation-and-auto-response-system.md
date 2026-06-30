# REQ-00399：安全事件关联分析与自动化响应系统

- **编号**：REQ-00399
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、所有微服务、backend/shared/SecurityEventCorrelator.js、backend/shared/AutoResponseEngine.js、Redis、PostgreSQL、Kafka、admin-dashboard
- **创建时间**：2026-06-30 22:10 UTC
- **依赖需求**：REQ-00343（API 密钥泄露检测）、REQ-00389（限流绕过检测）、REQ-00395（敏感操作风险评估）

## 1. 背景与问题

当前 mineGo 项目已实现了多个独立的安全检测模块：

- API 密钥泄露检测系统（REQ-00343）
- 会话异常检测系统
- 限流绕过检测系统（REQ-00389）
- 敏感操作风险评估系统（REQ-00395）
- GPS 欺诈检测系统
- 交易欺诈检测系统

然而，这些安全模块**各自独立运行**，缺乏关联分析能力：

1. **缺乏事件关联**：单个异常事件可能看起来不严重，但多个事件组合可能构成严重攻击
2. **响应延迟**：发现威胁后需要人工介入，缺乏自动化响应机制
3. **威胁识别不完整**：无法识别跨服务的攻击模式
4. **告警风暴**：多个安全模块独立告警，造成告警疲劳
5. **缺乏学习机制**：无法从历史攻击中学习新的威胁模式

实际案例：
- 攻击者可能先尝试 API 密钥泄露，失败后尝试限流绕过，再进行会话劫持
- 当前系统会分别触发三个独立告警，无法识别这是一次有组织的攻击

## 2. 目标

构建一个**智能安全事件关联分析与自动化响应系统**：

1. **事件关联分析**：实时关联多个安全事件，识别复杂攻击模式
2. **威胁评分引擎**：基于多维度数据计算威胁评分
3. **自动化响应**：根据威胁等级自动触发响应措施
4. **告警聚合**：合并相关告警，减少告警疲劳
5. **攻击模式学习**：从历史数据中学习新的攻击模式

可量化目标：
- 攻击识别准确率 ≥ 95%
- 平均响应时间 < 5 秒
- 告警数量减少 ≥ 60%（通过聚合）
- 误报率 < 5%

## 3. 范围

### 包含

1. **SecurityEventCorrelator**：安全事件关联分析引擎
   - 事件标准化接口
   - 时间窗口关联（5分钟、1小时、24小时）
   - 规则引擎（预定义攻击模式）
   - 机器学习模型（异常检测）

2. **ThreatScoreEngine**：威胁评分引擎
   - 多维度威胁评分（IP、设备、账号、行为）
   - 威胁等级分类（低、中、高、严重）
   - 风险累积计算

3. **AutoResponseEngine**：自动化响应引擎
   - 响应策略配置
   - 响应动作执行（IP 封禁、账号冻结、强制登出、二次验证）
   - 响应审计日志

4. **AlertAggregator**：告警聚合器
   - 相关告警合并
   - 告警去重
   - 告警优先级排序

5. **AttackPatternLearner**：攻击模式学习器
   - 历史数据分析
   - 新威胁模式识别
   - 规则自动更新

6. **管理界面**：admin-dashboard 安全事件管理
   - 实时安全事件仪表板
   - 攻击时间线可视化
   - 响应策略配置

### 不包含

- 第三方威胁情报源集成（可作为后续扩展）
- AI 大模型集成（使用传统 ML 模型）
- 法律合规报告生成

## 4. 详细需求

### 4.1 事件标准化接口

```javascript
// 统一的安全事件格式
interface SecurityEvent {
  eventId: string;          // 事件唯一 ID
  eventType: string;        // 事件类型（如 'api_key_leak', 'rate_limit_bypass'）
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: Date;
  
  // 主体信息
  userId?: string;
  deviceId?: string;
  ipAddress: string;
  userAgent?: string;
  
  // 事件详情
  details: {
    service: string;        // 来源服务
    endpoint?: string;      // 触发接口
    metadata?: object;      // 额外元数据
  };
  
  // 关联信息
  sessionId?: string;
  requestId?: string;
  relatedEvents?: string[]; // 关联事件 ID
}
```

### 4.2 事件关联规则

预定义的攻击模式规则：

| 攻击模式 | 关联事件 | 时间窗口 | 威胁等级 |
|---------|---------|---------|---------|
| 凭证填充攻击 | 多次登录失败 + 不同 IP | 5分钟 | 高 |
| API 滥用 | 限流绕过 + 异常请求量 | 1小时 | 中 |
| 会话劫持 | 会话异常 + 设备变化 + IP 变化 | 10分钟 | 严重 |
| 分布式攻击 | 同一用户多 IP + 异常行为 | 1小时 | 高 |
| 数据泄露尝试 | 批量查询 + 敏感接口访问 | 30分钟 | 高 |

### 4.3 威胁评分算法

```javascript
// 多维度威胁评分
interface ThreatScore {
  overall: number;          // 综合评分 (0-100)
  
  dimensions: {
    ipScore: number;        // IP 风险评分
    deviceScore: number;    // 设备风险评分
    accountScore: number;   // 账号风险评分
    behaviorScore: number;  // 行为风险评分
  };
  
  confidence: number;       // 置信度 (0-100)
  level: 'low' | 'medium' | 'high' | 'critical';
}
```

### 4.4 自动化响应策略

| 威胁等级 | 响应动作 | 执行时机 |
|---------|---------|---------|
| 低 (0-30) | 记录日志 + 监控 | 事件发生时 |
| 中 (31-60) | 增加验证频率 + 限流加强 | 事件发生时 |
| 高 (61-80) | 强制二次验证 + 账号临时锁定 | 立即执行 |
| 严重 (81-100) | 账号冻结 + IP 封禁 + 安全团队通知 | 立即执行 |

### 4.5 API 接口

```
POST /api/v1/security/events
  - 接收安全事件报告

GET /api/v1/security/events/:eventId
  - 获取事件详情

GET /api/v1/security/threats/:userId
  - 获取用户威胁评分

POST /api/v1/security/response/execute
  - 手动触发响应动作

GET /api/v1/security/patterns
  - 获取攻击模式列表

PUT /api/v1/security/rules/:ruleId
  - 更新关联规则
```

### 4.6 数据库设计

```sql
-- 安全事件表
CREATE TABLE security_events (
  id UUID PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  user_id UUID,
  device_id VARCHAR(255),
  ip_address INET NOT NULL,
  session_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 威胁评分历史表
CREATE TABLE threat_scores (
  id UUID PRIMARY KEY,
  user_id UUID,
  device_id VARCHAR(255),
  ip_address INET,
  score INTEGER NOT NULL,
  dimensions JSONB,
  level VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 响应动作日志表
CREATE TABLE security_responses (
  id UUID PRIMARY KEY,
  event_id UUID REFERENCES security_events(id),
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(50), -- 'user', 'ip', 'device'
  target_id VARCHAR(255),
  status VARCHAR(20),
  executed_at TIMESTAMPTZ,
  details JSONB
);

-- 索引优化
CREATE INDEX idx_security_events_user_time ON security_events(user_id, created_at DESC);
CREATE INDEX idx_security_events_ip_time ON security_events(ip_address, created_at DESC);
CREATE INDEX idx_security_events_type ON security_events(event_type);
```

## 5. 验收标准（可测试）

- [ ] 安全事件标准化接口支持 10+ 种事件类型
- [ ] 事件关联引擎能在 100ms 内完成单个事件分析
- [ ] 预定义攻击模式规则 ≥ 15 条
- [ ] 威胁评分算法覆盖 4 个维度（IP/设备/账号/行为）
- [ ] 自动化响应策略支持 4 个威胁等级
- [ ] 告警聚合减少告警数量 ≥ 60%
- [ ] 攻击模式学习器能识别新的异常模式
- [ ] 管理后台安全事件仪表板实时更新（< 1秒延迟）
- [ ] 所有安全事件持久化到 PostgreSQL
- [ ] Prometheus 指标暴露安全事件统计
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证端到端响应流程

## 6. 工作量估算

**L** - 大型需求

理由：
- 需要开发 5 个核心模块
- 涉及数据库设计和迁移
- 需要与现有安全模块集成
- 需要开发管理后台界面
- 预计工作量：2-3 天

## 7. 优先级理由

**P1 理由**：

1. **安全关键**：当前安全模块各自独立，无法应对复杂攻击
2. **告警疲劳**：运营团队面临告警过多的问题
3. **响应效率**：缺乏自动化响应，依赖人工介入
4. **合规要求**：满足安全审计和事件响应要求

对"项目可用"的贡献：提升整体安全防护能力，减少安全事件响应时间，提高运营效率。
