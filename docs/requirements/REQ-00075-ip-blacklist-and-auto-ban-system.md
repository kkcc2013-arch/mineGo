# REQ-00075：IP 黑名单与恶意 IP 自动封禁系统

- **编号**：REQ-00075
- **类别**：安全加固
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、user-service、backend/shared、Redis、database/migrations
- **创建时间**：2026-06-10 02:00
- **依赖需求**：REQ-00010（GPS 反作弊）、REQ-00045（设备完整性检测）

## 1. 背景与问题

当前 mineGo 项目已实现多层安全防护：
- REQ-00010：GPS 伪造检测与速度限制反作弊
- REQ-00016：GDPR 合规与用户数据隐私保护
- REQ-00034：COPPA 合规与未成年人年龄验证
- REQ-00045：设备完整性与模拟器检测系统
- REQ-00064：风险触发式人机验证（CAPTCHA）系统
- REQ-00057：多因素认证（MFA）系统

**然而，缺少 IP 级别的访问控制机制**：

1. **恶意 IP 无自动封禁**：攻击者可以通过更换账号绕过设备封禁，IP 封禁是必要的补充手段
2. **无 IP 黑名单/白名单管理**：运维人员无法手动封禁可疑 IP 或放行可信 IP
3. **缺少 IP 风险评分**：无法根据 IP 历史行为动态调整访问限制
4. **无分布式 IP 封禁同步**：多实例部署时 IP 封禁状态无法实时同步
5. **缺少地理位置封禁**：无法根据 IP 地理位置限制特定高风险地区访问

**实际影响**：
- 恶意用户可通过 VPN/代理切换 IP 继续攻击
- DDoS 攻击无法在网关层快速阻断
- 运维人员无法快速封禁攻击源 IP

## 2. 目标

构建完整的 IP 黑名单与恶意 IP 自动封禁系统：

1. **IP 黑名单/白名单管理**：支持手动添加、删除、查询，支持 CIDR 网段封禁
2. **自动封禁机制**：基于行为异常自动触发 IP 封禁（如短时间内多次触发反作弊）
3. **IP 风险评分**：根据历史行为计算 IP 风险分数（0-100），高风险 IP 自动限流
4. **分布式同步**：使用 Redis Pub/Sub 实时同步封禁状态到所有网关实例
5. **地理位置封禁**：支持按国家/地区封禁 IP（如封禁已知恶意 IP 来源国）
6. **封禁申诉流程**：用户可提交申诉，管理员审核后解封

**预期收益**：
- 恶意 IP 攻击阻断率提升 90%+
- 运维响应时间从小时级降至分钟级
- DDoS 攻击影响降低 80%+

## 3. 范围

- **包含**：
  - IP 黑名单/白名单 CRUD API
  - 自动封禁触发器（与反作弊、设备检测集成）
  - IP 风险评分引擎
  - Redis 分布式封禁状态同步
  - IP 地理位置查询与地区封禁
  - 封禁申诉 API 与审核流程
  - Prometheus 监控指标
  - 管理后台界面

- **不包含**：
  - 机器学习模型训练（使用规则引擎即可）
  - 第三方 IP 威胁情报订阅（可后续扩展）
  - 自动解封策略（需人工审核）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- IP 黑名单表
CREATE TABLE ip_blacklist (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,           -- 支持 CIDR，如 192.168.1.0/24
  reason VARCHAR(500) NOT NULL,       -- 封禁原因
  severity VARCHAR(20) NOT NULL,      -- low/medium/high/critical
  is_auto BOOLEAN DEFAULT false,      -- 是否自动封禁
  blocked_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,               -- NULL 表示永久封禁
  blocked_by INTEGER REFERENCES users(id), -- 封禁操作人
  created_at TIMESTAMP DEFAULT NOW()
);

-- IP 白名单表
CREATE TABLE ip_whitelist (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  description VARCHAR(500),
  added_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- IP 风险评分表
CREATE TABLE ip_risk_scores (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL UNIQUE,
  risk_score INTEGER DEFAULT 0,       -- 0-100
  violation_count INTEGER DEFAULT 0,  -- 违规次数
  last_violation_at TIMESTAMP,
  last_access_at TIMESTAMP,
  country_code VARCHAR(2),            -- ISO 3166-1 国家代码
  city VARCHAR(100),
  isp VARCHAR(200),                   -- ISP 信息
  is_vpn BOOLEAN DEFAULT false,       -- 是否为 VPN/代理
  is_tor BOOLEAN DEFAULT false,       -- 是否为 Tor 出口节点
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- IP 封禁申诉表
CREATE TABLE ip_ban_appeals (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  user_id INTEGER REFERENCES users(id),
  appeal_reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending/approved/rejected
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  review_note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- IP 访问日志表（用于风险评分计算）
CREATE TABLE ip_access_logs (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  user_id INTEGER,
  endpoint VARCHAR(200),
  method VARCHAR(10),
  status_code INTEGER,
  response_time_ms INTEGER,
  is_blocked BOOLEAN DEFAULT false,
  block_reason VARCHAR(100),
  user_agent VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_ip_blacklist_ip ON ip_blacklist USING gist(ip_address);
CREATE INDEX idx_ip_whitelist_ip ON ip_whitelist USING gist(ip_address);
CREATE INDEX idx_ip_risk_scores_ip ON ip_risk_scores(ip_address);
CREATE INDEX idx_ip_access_logs_ip ON ip_access_logs(ip_address, created_at DESC);
CREATE INDEX idx_ip_access_logs_created ON ip_access_logs(created_at DESC);
```

### 4.2 核心模块设计

#### 4.2.1 IP 封禁管理器（backend/shared/IpBanManager.js）

```javascript
class IpBanManager {
  // 检查 IP 是否被封禁
  async isBlocked(ipAddress) {
    // 1. 检查白名单（优先）
    // 2. 检查黑名单
    // 3. 检查 Redis 缓存
  }

  // 添加到黑名单
  async addToBlacklist(ipAddress, reason, severity, expiresAt, blockedBy) {
    // 1. 写入数据库
    // 2. 更新 Redis 缓存
    // 3. 发布封禁事件到 Redis Pub/Sub
  }

  // 从黑名单移除
  async removeFromBlacklist(ipAddress) {
    // 1. 数据库删除
    // 2. Redis 缓存删除
    // 3. 发布解封事件
  }

  // 自动封禁触发
  async autoBan(ipAddress, reason, severity) {
    // 根据风险评分决定是否自动封禁
  }

  // 获取 IP 风险评分
  async getRiskScore(ipAddress) {
    // 返回 0-100 的风险分数
  }

  // 更新风险评分
  async updateRiskScore(ipAddress, delta, reason) {
    // 增加或减少风险分数
  }
}
```

#### 4.2.2 IP 风险评分引擎（backend/shared/IpRiskEngine.js）

```javascript
class IpRiskEngine {
  // 计算风险评分
  async calculateRiskScore(ipAddress) {
    // 基于以下因素：
    // 1. 历史违规次数
    // 2. 是否为 VPN/代理
    // 3. 是否为 Tor 出口节点
    // 4. 地理位置风险
    // 5. ISP 信誉
    // 6. 短时间请求频率
  }

  // 检测 VPN/代理
  async detectVpnProxy(ipAddress) {
    // 使用 IP 信息查询服务
  }

  // 检测 Tor 出口节点
  async detectTorExitNode(ipAddress) {
    // 查询 Tor 出口节点列表
  }

  // 获取地理位置
  async getGeoLocation(ipAddress) {
    // 使用 GeoIP 数据库
  }
}
```

#### 4.2.3 网关中间件（backend/gateway/src/middleware/ipBan.js）

```javascript
async function ipBanMiddleware(req, res, next) {
  const ipAddress = req.ip || req.connection.remoteAddress;

  // 1. 检查白名单
  if (await ipBanManager.isWhitelisted(ipAddress)) {
    return next();
  }

  // 2. 检查黑名单
  if (await ipBanManager.isBlocked(ipAddress)) {
    return res.status(403).json({
      error: 'IP_BLOCKED',
      message: '您的 IP 已被封禁，如有疑问请联系客服'
    });
  }

  // 3. 检查风险评分
  const riskScore = await ipBanManager.getRiskScore(ipAddress);
  if (riskScore >= 80) {
    // 高风险 IP 自动限流
    req.highRiskIp = true;
  }

  // 4. 记录访问日志
  await ipBanManager.logAccess(ipAddress, req);

  next();
}
```

### 4.3 API 设计

#### 管理端 API（需要管理员权限）

```
POST   /api/admin/ip-blacklist          # 添加 IP 到黑名单
DELETE /api/admin/ip-blacklist/:ip      # 从黑名单移除
GET    /api/admin/ip-blacklist          # 查询黑名单列表
GET    /api/admin/ip-blacklist/stats    # 黑名单统计

POST   /api/admin/ip-whitelist          # 添加 IP 到白名单
DELETE /api/admin/ip-whitelist/:ip      # 从白名单移除
GET    /api/admin/ip-whitelist          # 查询白名单列表

GET    /api/admin/ip-risk/:ip           # 查询 IP 风险评分
POST   /api/admin/ip-risk/recalculate   # 重新计算风险评分

GET    /api/admin/ip-appeals            # 查询申诉列表
POST   /api/admin/ip-appeals/:id/approve # 批准申诉
POST   /api/admin/ip-appeals/:id/reject  # 拒绝申诉

POST   /api/admin/geo-ban               # 按地理位置封禁
DELETE /api/admin/geo-ban/:country      # 解除地理位置封禁
```

#### 用户端 API

```
POST /api/ip-appeal                     # 提交封禁申诉
GET  /api/ip-appeal/status              # 查询申诉状态
```

### 4.4 自动封禁触发规则

| 触发条件 | 封禁时长 | 严重级别 |
|---------|---------|---------|
| 1小时内触发 GPS 反作弊 5 次 | 24 小时 | medium |
| 1小时内触发设备检测异常 3 次 | 48 小时 | high |
| 1小时内触发人机验证失败 10 次 | 12 小时 | low |
| 1小时内请求频率超过限流阈值 5 倍 | 6 小时 | medium |
| 被识别为 Tor 出口节点 | 永久 | critical |
| 风险评分达到 100 | 永久 | critical |

### 4.5 Prometheus 指标

```javascript
// IP 封禁相关指标
ip_ban_total{type="blacklist"}         // 黑名单总数
ip_ban_total{type="whitelist"}         // 白名单总数
ip_ban_auto_total{reason="gps_cheat"}  // 自动封禁次数（按原因）
ip_ban_appeal_total{status="pending"}  // 申诉数量（按状态）
ip_risk_score_sum                      // 风险评分总和
ip_access_blocked_total                // 被阻断的请求总数
ip_access_total{status="allowed"}      // 访问总数（按状态）
```

### 4.6 管理后台界面

在 admin-dashboard 中新增 IP 管理页面：
- IP 黑名单管理（添加、删除、查询、批量导入）
- IP 白名单管理
- IP 风险评分查询与可视化
- 封禁申诉审核
- 地理位置封禁配置
- 实时封禁事件日志

## 5. 验收标准（可测试）

- [ ] IP 黑名单 CRUD API 全部可用，支持 CIDR 网段封禁
- [ ] IP 白名单优先级高于黑名单，白名单 IP 可绕过所有封禁
- [ ] 自动封禁在触发条件满足时正确执行，封禁时长符合规则
- [ ] IP 风险评分在 0-100 范围内，高风险 IP（>=80）自动限流
- [ ] Redis Pub/Sub 正确同步封禁状态到所有网关实例
- [ ] 地理位置封禁可按国家代码封禁/解封
- [ ] 封禁申诉流程完整（提交→审核→解封/拒绝）
- [ ] 网关中间件正确阻断黑名单 IP 的请求
- [ ] Prometheus 指标正确暴露并可被 Prometheus 抓取
- [ ] 管理后台界面可正常管理 IP 黑名单/白名单
- [ ] 单元测试覆盖率 >= 80%
- [ ] 集成测试覆盖核心流程

## 6. 工作量估算

**L（Large）**

理由：
- 涉及多个模块（网关中间件、共享模块、数据库、Redis、API、前端）
- 需要实现 IP 地理位置查询（GeoIP 数据库）
- 需要实现分布式同步机制
- 需要与现有反作弊系统集成
- 需要实现管理后台界面

预计开发时间：2-3 天

## 7. 优先级理由

**P1 理由**：

1. **安全必要性**：IP 封禁是多层安全防护的重要补充，可有效阻断恶意 IP 攻击
2. **运维价值高**：运维人员可快速响应安全事件，手动封禁攻击源
3. **已有基础**：项目已实现反作弊、设备检测、人机验证，IP 封禁是自然延伸
4. **生产必需**：生产环境必须有 IP 级别的访问控制能力
5. **影响范围广**：可提升整体安全防护能力，降低 DDoS 攻击影响
