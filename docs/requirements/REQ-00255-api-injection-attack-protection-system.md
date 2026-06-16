# REQ-00255：API 请求参数注入攻击防护系统

- **编号**：REQ-00255
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/InjectionGuard.js、backend/shared/InputSanitizer.js
- **创建时间**：2026-06-16 17:00
- **依赖需求**：REQ-00003、REQ-00111

## 1. 背景与问题

当前 mineGo 项目虽然实现了基础的输入验证，但缺乏系统化的注入攻击防护机制：

1. **SQL 注入风险**：部分动态查询仍使用字符串拼接，PostGIS 地理查询参数未完全参数化
2. **NoSQL 注入风险**：Redis 命令构建存在潜在的注入点，特别是用户输入直接用于键名构造
3. **命令注入风险**：日志文件名、导出文件路径等包含用户输入，可能被利用执行系统命令
4. **XSS 风险**：用户昵称、精灵自定义名称等字段未进行 HTML 实体编码，在管理后台展示时存在跨站脚本风险
5. **路径遍历风险**：静态资源访问、头像上传等路径校验不严格，可能被利用访问非授权文件

根据安全审计，以下 API 端点存在较高风险：
- `POST /api/pokemon/search` - 动态 SQL 构建
- `GET /api/location/nearby` - PostGIS 查询参数
- `POST /api/social/nickname` - XSS 风险
- `GET /api/admin/export` - 路径遍历风险

## 2. 目标

构建统一的注入攻击防护系统，实现：

1. **多层防护**：输入层验证 + 中间件过滤 + 输出层编码
2. **智能检测**：基于规则的注入特征检测，支持自定义规则扩展
3. **零误报**：对正常业务请求无影响，仅拦截真实攻击
4. **可观测性**：完整的攻击日志记录与告警机制
5. **性能优化**：防护逻辑对请求延迟影响 < 5ms

## 3. 范围

- **包含**：
  - SQL 注入防护中间件（参数化查询强制、动态 SQL 检测）
  - NoSQL 注入防护（Redis 键名白名单、命令参数过滤）
  - XSS 防护（HTML 实体编码、CSP 策略强化）
  - 路径遍历防护（路径规范化、访问边界检查）
  - 命令注入防护（特殊字符转义、安全执行函数）
  - 注入攻击检测规则引擎
  - 攻击日志与告警系统

- **不包含**：
  - WAF 级别的网络层防护（由基础设施处理）
  - 业务逻辑漏洞防护（如越权访问，由其他需求覆盖）
  - 第三方依赖漏洞扫描（由 REQ-00241 SBOM 系统覆盖）

## 4. 详细需求

### 4.1 SQL 注入防护

```javascript
// backend/shared/InjectionGuard.js
class SQLInjectionGuard {
  // 检测规则
  static patterns = [
    /(\bOR\b|\bAND\b)\s*['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,  // OR 1=1
    /UNION\s+(ALL\s+)?SELECT/i,                              // UNION SELECT
    /;\s*(DROP|DELETE|UPDATE|INSERT|EXEC)/i,                // 堆叠查询
    /--\s*$|\/\*.*\*\//,                                      // 注释截断
    /'\s*(OR|AND)\s*'/i,                                      // 字符串逃逸
  ];
  
  // 参数化查询强制检查
  static validateParameterized(query, params) {
    // 检测是否使用字符串拼接
    const hasConcatenation = /\$\{.*\}|`\$\{.*\}`/.test(query);
    if (hasConcatenation && !params) {
      throw new SecurityError('SQL_INJECTION_RISK', '必须使用参数化查询');
    }
  }
}
```

### 4.2 NoSQL 注入防护

```javascript
// Redis 键名白名单校验
class RedisKeyValidator {
  static allowedPatterns = [
    /^user:\d+:[a-z]+$/,           // user:123:profile
    /^pokemon:\d+:[a-z]+$/,        // pokemon:456:stats
    /^session:[a-f0-9]{32}$/,      // session:abc123...
    /^cache:[a-z]+:[\w\-]+$/,      // cache:type:key
  ];
  
  static validate(key) {
    const isValid = this.allowedPatterns.some(p => p.test(key));
    if (!isValid) {
      throw new SecurityError('NOSQL_INJECTION_RISK', `非法 Redis 键名: ${key}`);
    }
  }
}
```

### 4.3 XSS 防护

```javascript
// 输出编码器
class XSSEncoder {
  static encode(value, context = 'html') {
    const encoders = {
      html: v => v.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'
      }[c])),
      attribute: v => v.replace(/["'>]/g, c => ({
        '"': '&quot;', "'": '&#x27;', '>': '&gt;'
      }[c])),
      javascript: v => v.replace(/[\\'"<>]/g, c => '\\x' + c.charCodeAt(0).toString(16)),
      url: v => encodeURIComponent(v),
    };
    return encoders[context](String(value));
  }
}
```

### 4.4 路径遍历防护

```javascript
class PathTraversalGuard {
  static validate(userPath, baseDir) {
    // 规范化路径
    const normalized = path.normalize(path.join(baseDir, userPath));
    // 检查是否在允许目录内
    if (!normalized.startsWith(path.resolve(baseDir))) {
      throw new SecurityError('PATH_TRAVERSAL', '非法路径访问');
    }
    return normalized;
  }
}
```

### 4.5 注入检测中间件

```javascript
// gateway/middleware/injectionDetection.js
function injectionDetectionMiddleware(req, res, next) {
  const detector = new InjectionDetector();
  
  // 检测所有输入参数
  const inputs = { ...req.query, ...req.body, ...req.params };
  
  for (const [key, value] of Object.entries(inputs)) {
    const result = detector.scan(String(value));
    if (result.threat) {
      // 记录攻击日志
      await AttackLogger.log({
        type: result.type,
        ip: req.ip,
        userId: req.user?.id,
        endpoint: req.path,
        param: key,
        value: value.substring(0, 200),
        severity: result.severity,
      });
      
      // 高危攻击触发告警
      if (result.severity === 'high') {
        await AlertManager.trigger('injection_attack', result);
      }
      
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: '检测到非法输入',
      });
    }
  }
  
  next();
}
```

### 4.6 攻击日志与告警

```javascript
// backend/shared/AttackLogger.js
class AttackLogger {
  static async log(attack) {
    // 写入安全审计日志
    await db.query(`
      INSERT INTO security.attack_logs 
      (type, ip, user_id, endpoint, param, value, severity, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [attack.type, attack.ip, attack.userId, attack.endpoint, 
        attack.param, attack.value, attack.severity]);
    
    // 发送到 Kafka 用于实时分析
    await kafka.produce('security.attacks', attack);
  }
}
```

### 4.7 数据库迁移

```sql
-- database/migrations/20260616_create_attack_logs.sql
CREATE SCHEMA IF NOT EXISTS security;

CREATE TABLE security.attack_logs (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,           -- sql_injection, xss, path_traversal
  ip INET NOT NULL,
  user_id INTEGER,
  endpoint VARCHAR(255) NOT NULL,
  param VARCHAR(100) NOT NULL,
  value TEXT,
  severity VARCHAR(20) NOT NULL,       -- low, medium, high, critical
  blocked BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attack_logs_type_created 
  ON security.attack_logs (type, created_at DESC);
CREATE INDEX idx_attack_logs_ip 
  ON security.attack_logs (ip, created_at DESC);

-- 攻击统计视图
CREATE VIEW security.attack_stats_24h AS
SELECT 
  type,
  severity,
  COUNT(*) as count,
  COUNT(DISTINCT ip) as unique_ips
FROM security.attack_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY type, severity;
```

## 5. 验收标准（可测试）

- [ ] SQL 注入测试：`/api/pokemon/search?name="; DROP TABLE users;--` 返回 400，日志记录攻击
- [ ] XSS 测试：`POST /api/social/nickname {"nickname": "<script>alert(1)</script>"}` 存储值被编码为 `&lt;script&gt;alert(1)&lt;/script&gt;`
- [ ] 路径遍历测试：`GET /api/avatar/../../../etc/passwd` 返回 400，拒绝访问
- [ ] NoSQL 注入测试：Redis 键名包含 `$where` 或特殊字符时抛出异常
- [ ] 性能测试：注入检测中间件增加延迟 < 5ms（P95）
- [ ] 误报测试：正常业务请求（包含特殊字符如单引号、百分号）不被拦截
- [ ] 告警测试：连续 10 次高危攻击触发 Slack/邮件告警
- [ ] 日志查询：可通过 admin-dashboard 查看攻击日志统计

## 6. 工作量估算

**L（Large）**

理由：
- 需要实现 5 种注入防护机制（SQL、NoSQL、XSS、路径遍历、命令注入）
- 需要创建检测规则引擎和中间件
- 需要修改多个现有 API 端点的输入处理逻辑
- 需要创建数据库表和管理界面
- 需要编写全面的测试用例覆盖各种攻击场景

预计工时：3-5 天

## 7. 优先级理由

**P1 理由**：

1. **安全基础**：注入攻击是 OWASP Top 10 第一位，属于必须防护的基础安全能力
2. **生产就绪**：项目已进入 P1 阶段，安全加固是生产部署的前提条件
3. **风险可控**：已有 REQ-00003（支付安全）和 REQ-00111（CSP 强化）作为基础
4. **影响范围**：涉及所有 API 端点，对整体安全态势有重大提升
5. **合规要求**：等保二级、GDPR 等合规要求必须具备注入防护能力
