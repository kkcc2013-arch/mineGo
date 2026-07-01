# REQ-00407：API 弃用通知与迁移引导系统

- **编号**：REQ-00407
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/deprecationManager.js、docs/api-spec、admin-dashboard
- **创建时间**：2026-07-01 10:00 UTC
- **依赖需求**：REQ-00044（API 版本管理）

## 1. 背景与问题

### 当前现状
mineGo 项目已实现 API 版本管理（REQ-00044），支持 v1/v2 等多版本并存。但随着项目演进，大量 API 需要弃用旧版本、迁移到新版本：

1. **缺乏弃用通知机制**
   - 旧 API 即将下线时，客户端开发者无法提前获知
   - 缺少 `Deprecation` 响应头和 `Sunset` 日期通知
   - 用户在 API 下线后才发现服务不可用

2. **迁移引导缺失**
   - 没有自动化的迁移文档生成
   - 客户端开发者需要手动查找新 API 用法
   - 缺少代码示例和差异对比

3. **监控与统计不足**
   - 无法追踪哪些客户端仍在使用弃用 API
   - 缺少弃用 API 调用量统计和告警
   - 无法评估迁移进度

### 真实痛点
```
# 客户端收到 404 后才发现 API 已下线
GET /api/v1/pokemon/nearby
→ 404 Not Found

# 应该提前收到警告
GET /api/v1/pokemon/nearby
→ 200 OK
→ Deprecation: true
→ Sunset: Sat, 01 Aug 2026 00:00:00 GMT
→ Link: </api/v2/pokemon/nearby>; rel="successor-version"
```

## 2. 目标

建立完整的 API 弃用生命周期管理系统：

1. **标准化弃用通知**：通过 HTTP 响应头、响应体字段、通知邮件等方式提前告知用户
2. **自动化迁移引导**：生成迁移文档、代码示例、差异对比，降低迁移成本
3. **监控迁移进度**：追踪弃用 API 调用量，按客户端/用户维度统计，支持定向通知

## 3. 范围

### 包含
- 弃用 API 注册与管理后台
- 响应头注入中间件（Deprecation、Sunset、Link）
- 响应体扩展字段（deprecationWarning、migrationGuide）
- 弃用 API 调用量监控与告警
- 自动化迁移文档生成器
- 客户端迁移进度追踪仪表板

### 不包含
- API 功能变更（仅关注弃用流程）
- 强制客户端升级（仅提供引导）
- 数据库迁移（仅 API 层面）

## 4. 详细需求

### 4.1 弃用 API 注册系统

#### 数据库表设计
```sql
CREATE TABLE api_deprecations (
    id SERIAL PRIMARY KEY,
    endpoint VARCHAR(255) NOT NULL,           -- /api/v1/pokemon/nearby
    method VARCHAR(10) NOT NULL,              -- GET, POST, PUT, DELETE
    deprecated_at TIMESTAMPTZ NOT NULL,       -- 弃用公告时间
    sunset_at TIMESTAMPTZ NOT NULL,           -- 计划下线时间
    successor_endpoint VARCHAR(255),          -- 接替的 API /api/v2/pokemon/nearby
    migration_guide TEXT,                     -- 迁移指南 Markdown
    breaking_changes JSONB,                   -- Breaking Change 详情
    affected_clients JSONB DEFAULT '[]',      -- 受影响客户端列表
    status VARCHAR(20) DEFAULT 'active',      -- active, sunset, removed
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_deprecations_endpoint ON api_deprecations(endpoint, method);
CREATE INDEX idx_deprecations_sunset ON api_deprecations(sunset_at) WHERE status = 'active';
```

#### 管理后台 API
```
POST   /admin/api/deprecations          # 注册弃用 API
GET    /admin/api/deprecations          # 列表查询（支持筛选）
GET    /admin/api/deprecations/:id      # 详情查询
PATCH  /admin/api/deprecations/:id      # 更新信息
DELETE /admin/api/deprecations/:id      # 取消弃用
```

### 4.2 响应头注入中间件

#### HTTP 响应头规范
```javascript
// backend/shared/middleware/deprecationMiddleware.js
class DeprecationMiddleware {
    // RFC 8594 Deprecation Header
    // https://datatracker.ietf.org/doc/html/rfc8594
    
    injectHeaders(req, res, next) {
        const deprecation = this.findActiveDeprecation(req.path, req.method);
        if (deprecation) {
            // 1. Deprecation 头
            res.setHeader('Deprecation', 'true');
            
            // 2. Sunset 头（下线日期）
            res.setHeader('Sunset', deprecation.sunset_at.toUTCString());
            
            // 3. Link 头（接替 API）
            if (deprecation.successor_endpoint) {
                res.setHeader('Link', 
                    `<${deprecation.successor_endpoint}>; rel="successor-version"`
                );
            }
            
            // 4. 自定义警告头
            res.setHeader('X-API-Deprecation-Warning', 
                `This API will be removed on ${deprecation.sunset_at.toISOString()}`
            );
        }
        next();
    }
}
```

### 4.3 响应体扩展字段

```javascript
// 弃用 API 响应体示例
{
    "success": true,
    "data": { ... },
    "deprecation": {
        "deprecated": true,
        "sunsetAt": "2026-08-01T00:00:00Z",
        "daysRemaining": 30,
        "successorApi": "/api/v2/pokemon/nearby",
        "migrationGuide": "https://docs.minego.game/migration/pokemon-nearby-v2",
        "breakingChanges": [
            {
                "field": "location",
                "change": "renamed to coordinates",
                "oldType": "object",
                "newType": "object"
            },
            {
                "field": "radius",
                "change": "default changed from 1000 to 500"
            }
        ]
    },
    "meta": {
        "requestId": "req-12345",
        "timestamp": "2026-07-01T10:00:00Z"
    }
}
```

### 4.4 弃用 API 调用量监控

#### Prometheus 指标
```javascript
// backend/shared/deprecationMetrics.js
const deprecationCallCounter = new Counter({
    name: 'api_deprecated_calls_total',
    help: 'Total calls to deprecated APIs',
    labelNames: ['endpoint', 'method', 'client_id', 'client_version']
});

const deprecationCallHistogram = new Histogram({
    name: 'api_deprecated_calls_by_client',
    help: 'Deprecated API calls distribution by client',
    labelNames: ['endpoint', 'client_id'],
    buckets: [1, 10, 100, 1000, 10000]
});
```

#### Grafana 仪表板
- 弃用 API 调用量趋势图（按 API、按客户端）
- 距离下线时间倒计时
- 迁移进度百分比
- 高频调用弃用 API 的客户端排行

### 4.5 自动化迁移文档生成

```javascript
// backend/jobs/generateMigrationDocs.js
class MigrationDocGenerator {
    async generate(deprecationId) {
        const deprecation = await this.getDeprecation(deprecationId);
        
        return {
            title: `迁移指南：${deprecation.endpoint}`,
            summary: `此 API 将于 ${deprecation.sunset_at} 下线`,
            
            // 请求对比
            requestDiff: await this.generateRequestDiff(deprecation),
            
            // 响应对比
            responseDiff: await this.generateResponseDiff(deprecation),
            
            // 代码示例
            codeExamples: {
                oldApi: this.generateOldApiExample(deprecation),
                newApi: this.generateNewApiExample(deprecation)
            },
            
            // Breaking Changes 列表
            breakingChanges: deprecation.breaking_changes,
            
            // FAQ
            faq: await this.generateFaq(deprecation)
        };
    }
    
    // 生成 Markdown 文档
    toMarkdown(doc) {
        return `# 迁移指南：${doc.title}

## 概述
${doc.summary}

## 请求对比
\`\`\`diff
${doc.requestDiff}
\`\`\`

## 响应对比
\`\`\`diff
${doc.responseDiff}
\`\`\`

## Breaking Changes
${doc.breakingChanges.map(c => `- **${c.field}**: ${c.change}`).join('\n')}

## 代码示例

### 旧 API（已弃用）
\`\`\`javascript
${doc.codeExamples.oldApi}
\`\`\`

### 新 API（推荐）
\`\`\`javascript
${doc.codeExamples.newApi}
\`\`\`
`;
    }
}
```

### 4.6 客户端迁移进度追踪

#### 数据库表
```sql
CREATE TABLE client_migration_status (
    id SERIAL PRIMARY KEY,
    client_id VARCHAR(100) NOT NULL,          -- 客户端标识
    client_version VARCHAR(50),               -- 客户端版本
    deprecation_id INTEGER REFERENCES api_deprecations(id),
    last_deprecated_call_at TIMESTAMPTZ,      -- 最后调用弃用 API 时间
    deprecated_call_count INTEGER DEFAULT 0,  -- 弃用 API 调用次数
    migrated_at TIMESTAMPTZ,                  -- 迁移完成时间
    notification_sent_at TIMESTAMPTZ,         -- 通知发送时间
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_client_migration ON client_migration_status(client_id, deprecation_id);
```

#### 通知系统
```javascript
// backend/jobs/sendDeprecationNotifications.js
class DeprecationNotifier {
    async sendNotifications() {
        // 1. 识别即将下线的弃用 API
        const upcomingSunsets = await this.getUpcomingSunsets(30); // 30天内下线
        
        for (const deprecation of upcomingSunsets) {
            // 2. 找到仍在使用的客户端
            const activeClients = await this.getActiveClients(deprecation.id);
            
            for (const client of activeClients) {
                // 3. 发送通知（邮件、站内信、Webhook）
                await this.sendEmail({
                    to: client.email,
                    subject: `API 弃用通知：${deprecation.endpoint} 将于 ${deprecation.sunset_at} 下线`,
                    body: this.generateNotificationBody(deprecation, client)
                });
                
                // 4. 记录通知发送
                await this.recordNotification(client.id, deprecation.id);
            }
        }
    }
}
```

## 5. 验收标准（可测试）

- [ ] 管理后台可注册弃用 API，设置下线日期和接替 API
- [ ] 弃用 API 响应包含正确的 Deprecation、Sunset、Link 响应头
- [ ] 弃用 API 响应体包含 deprecation 字段，含迁移指南链接
- [ ] Prometheus 正确记录弃用 API 调用量，按客户端维度统计
- [ ] Grafana 仪表板展示迁移进度和即将下线 API 列表
- [ ] 自动生成迁移文档 Markdown，含代码示例和 Breaking Changes
- [ ] 系统自动识别高频调用弃用 API 的客户端并发送通知
- [ ] 下线日期到达后，弃用 API 返回 410 Gone，响应体包含迁移指引
- [ ] 单元测试覆盖所有核心逻辑，覆盖率 ≥ 80%
- [ ] 集成测试验证端到端流程

## 6. 工作量估算

**L（Large）** - 约 3-5 天

- 数据库表设计与迁移（0.5 天）
- 弃用管理后台 API（1 天）
- 响应头/响应体中间件（0.5 天）
- 监控指标与 Grafana 仪表板（1 天）
- 迁移文档生成器（1 天）
- 通知系统与客户端追踪（0.5 天）
- 单元测试与集成测试（0.5 天）

## 7. 优先级理由

**P1（高优先级）**

1. **生产安全**：避免 API 下线导致的客户端故障，影响用户体验
2. **开发者体验**：降低迁移成本，提升第三方开发者满意度
3. **合规要求**：符合 HTTP 标准和 API 最佳实践
4. **可观测性**：追踪迁移进度，支持数据驱动的决策
5. **项目成熟度**：完善 API 治理能力，推动项目向生产可用演进

---

## 附录：HTTP 标准参考

- [RFC 8594 - The Deprecation HTTP Header Field](https://datatracker.ietf.org/doc/html/rfc8594)
- [RFC 8288 - Web Linking](https://datatracker.ietf.org/doc/html/rfc8288)
- [GitHub API Deprecation](https://docs.github.com/en/rest/overview/api-versions)
