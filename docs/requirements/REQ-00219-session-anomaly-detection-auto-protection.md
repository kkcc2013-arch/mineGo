# REQ-00219：会话异常检测与自动防护系统

- **编号**：REQ-00219
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、backend/shared/sessionAnomalyDetector.js、Redis、PostgreSQL、game-client
- **创建时间**：2026-06-15 13:30
- **依赖需求**：REQ-00021（JWT 黑名单）、REQ-00057（MFA 系统）

## 1. 背景与问题

当前系统已有 JWT 黑名单机制（REQ-00021）和多因素认证（REQ-00057），但缺少会话异常检测与自动防护能力：

1. **会话劫持风险**：攻击者获取有效 JWT 后可在不同设备/位置使用，系统无法识别异常
2. **设备绑定缺失**：用户登录后未绑定设备指纹，同一账号可在多设备同时活跃
3. **异常行为无感知**：短时间内 IP 跳变、设备切换、地理位置突变等异常无检测
4. **被动防护不足**：仅在用户主动登出时失效 token，缺少自动会话终止机制

实际攻击场景：
- XSS 窃取 token 后跨设备使用
- 中间人攻击获取凭证后异地登录
- 凭证泄露后批量账号接管

## 2. 目标

构建会话异常检测与自动防护系统，实现：

1. **设备绑定验证**：登录时绑定设备指纹，后续请求验证设备一致性
2. **异常行为检测**：实时检测 IP 变化、地理位置跳变、设备切换等异常
3. **风险评分系统**：基于多维度计算会话风险分数（0-100）
4. **自动防护动作**：高风险会话自动触发 MFA 重验、强制登出、账号锁定
5. **用户感知通知**：异常登录实时推送通知，用户可一键终止可疑会话

量化目标：
- 会话劫持检测准确率 ≥ 95%
- 异常检测误报率 ≤ 2%
- 风险评估延迟 ≤ 100ms
- 自动防护响应时间 ≤ 500ms

## 3. 范围

- **包含**：
  - 设备指纹绑定与验证逻辑
  - 会话异常检测引擎（IP/位置/设备/行为模式）
  - 风险评分算法与阈值配置
  - 自动防护动作执行器
  - 用户会话管理界面（查看/终止活跃会话）
  - 异常登录通知推送
  - 管理后台会话监控面板

- **不包含**：
  - 新的设备指纹采集算法（复用现有 deviceIntegrity.js）
  - MFA 流程重构（复用 REQ-00057）
  - IP 地理位置数据库（复用现有 location-service）

## 4. 详细需求

### 4.1 设备绑定验证

```javascript
// 会话创建时绑定设备
{
  sessionId: 'sess_xxx',
  userId: 'user_xxx',
  deviceFingerprint: 'hash_xxx', // 设备唯一标识
  deviceInfo: {
    userAgent: 'Mozilla/5.0...',
    platform: 'Windows',
    screenWidth: 1920,
    screenHeight: 1080
  },
  ip: '192.168.1.100',
  geoLocation: { lat: 31.2, lng: 121.5, city: 'Shanghai' },
  createdAt: '2026-06-15T13:00:00Z',
  lastActiveAt: '2026-06-15T13:30:00Z'
}
```

验证规则：
- 每次请求验证设备指纹一致性
- 设备不匹配时触发风险评分
- 支持用户授权新设备（通过 MFA）

### 4.2 异常检测维度

| 检测维度 | 异常条件 | 风险权重 |
|---------|---------|---------|
| IP 变化 | 请求 IP ≠ 会话绑定 IP | 30 |
| 地理位置 | 两请求位置距离 > 500km 且时间 < 1h | 40 |
| 设备切换 | 设备指纹变化 | 50 |
| 多设备并发 | 同账号 > 3 设备同时活跃 | 35 |
| 异常时间 | 登录时间不在用户习惯时段 | 15 |
| 高频操作 | 操作频率 > 用户历史均值 3 倍 | 25 |
| 敏感操作 | 支付/交易/账号修改 | 20 |

### 4.3 风险评分算法

```javascript
function calculateSessionRisk(session, context) {
  let score = 0;
  
  // IP 变化检测
  if (context.ip !== session.bindIp) {
    const ipRisk = calculateIpChangeRisk(session.bindIp, context.ip);
    score += ipRisk * 30;
  }
  
  // 地理位置跳变
  if (context.geoLocation) {
    const distance = calculateDistance(session.bindGeo, context.geoLocation);
    const timeDiff = now() - session.lastActiveAt;
    if (distance > 500 && timeDiff < 3600000) {
      score += 40;
    }
  }
  
  // 设备切换
  if (context.deviceFingerprint !== session.deviceFingerprint) {
    score += 50;
  }
  
  // 多设备并发
  const activeDevices = await getActiveDeviceCount(session.userId);
  if (activeDevices > 3) {
    score += 35;
  }
  
  return Math.min(score, 100);
}
```

### 4.4 自动防护动作

| 风险分数 | 防护动作 |
|---------|---------|
| 0-30 | 正常，记录日志 |
| 31-50 | 低风险，发送提醒通知 |
| 51-70 | 中风险，要求 MFA 重验 |
| 71-85 | 高风险，强制登出当前会话 |
| 86-100 | 极高风险，锁定账号 + 通知用户 |

### 4.5 API 接口

```
POST /api/v1/sessions/validate
  - 验证当前会话有效性
  - 返回风险分数与防护建议

GET /api/v1/sessions/active
  - 获取用户所有活跃会话列表
  - 包含设备信息、位置、最后活跃时间

DELETE /api/v1/sessions/:sessionId
  - 终止指定会话
  - 用户主动操作或系统自动触发

POST /api/v1/sessions/:sessionId/trust-device
  - 信任新设备（需 MFA 验证）
  - 更新会话设备绑定

GET /api/v1/admin/sessions/anomalies
  - 管理后台：查询异常会话统计
  - 支持时间范围、风险等级筛选
```

### 4.6 数据库设计

```sql
-- 会话绑定表
CREATE TABLE session_bindings (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  device_fingerprint VARCHAR(255) NOT NULL,
  device_info JSONB,
  bind_ip INET,
  bind_geo POINT,
  risk_score INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active', -- active, terminated, locked
  created_at TIMESTAMP DEFAULT NOW(),
  last_active_at TIMESTAMP DEFAULT NOW(),
  terminated_at TIMESTAMP,
  terminate_reason VARCHAR(100)
);

-- 会话异常事件表
CREATE TABLE session_anomaly_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  user_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL, -- ip_change, geo_jump, device_switch, etc.
  risk_score INTEGER,
  details JSONB,
  action_taken VARCHAR(50), -- notify, mfa_required, terminated, locked
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_session_user ON session_bindings(user_id);
CREATE INDEX idx_session_active ON session_bindings(user_id, status) WHERE status = 'active';
CREATE INDEX idx_anomaly_time ON session_anomaly_events(created_at);
```

## 5. 验收标准（可测试）

- [ ] 用户登录后自动绑定设备指纹，后续请求验证设备一致性
- [ ] IP 变化时正确计算风险分数，低风险发送通知，高风险触发 MFA
- [ ] 地理位置跳变（>500km/1h）被检测并记录异常事件
- [ ] 同账号超过 3 设备同时活跃时触发多设备并发告警
- [ ] 风险分数 71-85 时自动终止会话，86-100 时锁定账号
- [ ] 用户可在会话管理界面查看所有活跃会话并终止
- [ ] 异常登录事件实时推送通知到用户设备
- [ ] 管理后台可查询异常会话统计与趋势
- [ ] 风险评估延迟 ≤ 100ms（P95）
- [ ] 会话劫持检测准确率 ≥ 95%（测试集验证）

## 6. 工作量估算

**L（Large）**

理由：
- 需要实现完整的风险评分引擎（核心算法）
- 数据库表设计与迁移
- 4 个新 API 接口
- 前端会话管理界面
- 管理后台监控面板
- 与现有 MFA、通知、设备指纹系统集成
- 单元测试与集成测试覆盖

预计工时：3-5 天

## 7. 优先级理由

**P1 理由**：

1. **安全关键**：会话劫持是常见攻击向量，直接影响用户账号安全
2. **生产必需**：生产环境必须有会话异常检测能力
3. **用户期望**：主流应用都提供"查看活跃会话"功能
4. **合规要求**：安全审计要求记录会话异常事件
5. **依赖已就绪**：JWT 黑名单、MFA、设备指纹均已实现，集成成本低

不设 P0 是因为：
- 现有 JWT 黑名单已提供基础防护
- MFA 系统已覆盖部分场景
- 不是阻塞上线的硬性需求
