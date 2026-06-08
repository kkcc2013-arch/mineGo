# REQ-00038：API 敏感数据泄露防护与审计日志加密存储

- **编号**：REQ-00038
- **类别**：安全加固
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared、database/migrations
- **创建时间**：2026-06-08 19:48
- **依赖需求**：REQ-00016（GDPR 合规）、REQ-00021（JWT 黑名单）

## 1. 背景与问题

当前系统虽然已实现基础的安全措施（JWT 认证、反作弊、支付安全），但在敏感数据泄露防护方面仍存在以下风险：

1. **API 响应泄露敏感数据**：部分 API 响应中包含完整的用户信息、精灵数据、支付记录等敏感字段，存在过度暴露风险。例如：
   - `/api/users/:id` 返回完整的用户信息（包括 email、phone、payment_info）
   - `/api/pokemon/:id` 返回完整的精灵属性（包括隐藏的 iv_values、shiny_rate）
   - `/api/payments/:id` 返回完整的支付信息（包括 card_number 后四位、billing_address）

2. **审计日志未加密存储**：当前审计日志（REQ-00016）以明文存储在数据库中，包含用户的敏感操作记录（登录、支付、交易等），一旦数据库泄露，攻击者可以获取完整的用户行为轨迹。

3. **缺少敏感数据访问审计**：系统未记录谁在何时访问了哪些敏感数据，无法追溯数据泄露源头。

4. **API 响应未做字段级权限控制**：不同角色的用户（普通用户、管理员、系统服务）应该看到不同级别的数据，但目前缺乏细粒度的字段级访问控制。

根据 OWASP API Security Top 10 和 GDPR 数据最小化原则，需要对敏感数据的暴露和存储进行严格控制。

## 2. 目标

建立全面的敏感数据泄露防护体系，确保：

1. **数据最小化暴露**：API 响应仅返回必要字段，根据用户角色动态过滤敏感字段
2. **审计日志加密存储**：所有审计日志采用 AES-256-GCM 加密存储，确保数据安全
3. **敏感操作追踪**：记录所有敏感数据的访问行为，支持完整的数据访问审计链
4. **数据脱敏与掩码**：对日志、错误消息、调试输出中的敏感数据进行自动脱敏
5. **满足合规要求**：符合 GDPR、PCI-DSS、等保 2.0 的数据保护要求

## 3. 范围

- **包含**：
  - API 响应字段级过滤中间件（基于角色和数据敏感度）
  - 审计日志加密存储模块（AES-256-GCM）
  - 敏感数据访问日志记录系统
  - 数据脱敏规则引擎（支持多种数据类型）
  - API 响应扫描与敏感字段检测工具
  - 数据库敏感字段加密迁移脚本
  - 管理后台敏感数据查看权限控制
  - 单元测试和集成测试

- **不包含**：
  - 数据库字段级加密（作为后续独立需求）
  - 动态数据脱敏（查询时实时脱敏，作为后续需求）
  - 数据泄露检测与告警系统（作为后续需求）

## 4. 详细需求

### 4.1 API 响应字段级过滤中间件

**实现位置**：`backend/shared/responseFilter.js`

**功能要求**：
1. 定义敏感字段分类（P0/P1/P2/P3）：
   ```javascript
   const SENSITIVITY_LEVELS = {
     P0: ['password', 'payment_token', 'card_number', 'cvv'], // 完全隐藏
     P1: ['email', 'phone', 'real_name', 'address'],          // 需要授权
     P2: ['birthday', 'gender', 'location_history'],           // 部分脱敏
     P3: ['user_id', 'username', 'avatar'],                   // 公开
   };
   ```

2. 基于用户角色动态过滤响应字段：
   ```javascript
   const ROLE_PERMISSIONS = {
     'user': { allowedLevels: ['P3'], partialLevels: ['P2'] },
     'premium': { allowedLevels: ['P3', 'P2'], partialLevels: ['P1'] },
     'admin': { allowedLevels: ['P3', 'P2', 'P1'], partialLevels: [] },
     'system': { allowedLevels: ['P3', 'P2', 'P1', 'P0'], partialLevels: [] },
   };
   ```

3. 集成到 Gateway 和各微服务的响应处理链：
   ```javascript
   app.use(responseFilterMiddleware({ 
     enableAutoFilter: true,
     customRules: routeSpecificRules,
     logSensitiveAccess: true,
   }));
   ```

### 4.2 审计日志加密存储模块

**实现位置**：`backend/shared/auditLogEncrypted.js`

**功能要求**：
1. 使用 AES-256-GCM 算法加密审计日志：
   ```javascript
   // 加密配置
   const ENCRYPTION_CONFIG = {
     algorithm: 'aes-256-gcm',
     keyLength: 32,
     ivLength: 16,
     authTagLength: 16,
     keyRotationDays: 90,
   };
   ```

2. 密钥管理：
   - 主密钥存储在 KMS（生产环境）或环境变量（开发环境）
   - 支持密钥轮换，保留历史密钥用于解密旧日志
   - 每条日志使用唯一 IV（初始化向量）

3. 加密字段：
   - `action_data`：操作详细数据（JSON 加密）
   - `ip_address`：用户 IP 地址
   - `user_agent`：用户浏览器标识
   - `sensitive_fields`：敏感字段访问记录

4. 提供解密 API（仅限授权管理员）：
   ```javascript
   // GET /api/admin/audit-logs/:id/decrypt
   // 需要 admin 权限 + MFA 验证
   ```

### 4.3 敏感数据访问日志记录

**实现位置**：`backend/shared/sensitiveDataAudit.js`

**功能要求**：
1. 记录敏感数据访问行为：
   ```javascript
   const SensitiveDataAccessLog = {
     id: UUID,
     user_id: String,
     accessed_by: String,      // 访问者 ID
     resource_type: String,    // 'user', 'pokemon', 'payment'
     resource_id: String,
     accessed_fields: Array,   // ['email', 'phone']
     access_reason: String,    // 'api_request', 'admin_view'
     ip_address: String,
     timestamp: DateTime,
     retention_days: 90,
   };
   ```

2. 定义敏感数据访问规则：
   ```javascript
   const SENSITIVE_ACCESS_RULES = {
     'user.email': { logAccess: true, requireReason: true },
     'user.phone': { logAccess: true, requireReason: true },
     'payment.*': { logAccess: true, requireReason: true, mfaRequired: true },
     'pokemon.iv_values': { logAccess: true, requireReason: false },
   };
   ```

3. 提供查询接口：
   ```javascript
   // GET /api/admin/sensitive-access-logs?user_id=xxx&start_date=xxx
   // 返回用户的敏感数据访问记录（加密存储）
   ```

### 4.4 数据脱敏规则引擎

**实现位置**：`backend/shared/dataMaskingEngine.js`（扩展现有的 `dataMasking.js`）

**功能要求**：
1. 扩展脱敏规则，支持更多数据类型：
   ```javascript
   const MASKING_RULES = {
     'email': { type: 'partial', pattern: 'keep_prefix', visibleChars: 3 },
     // example@example.com → exa***@example.com
     
     'phone': { type: 'partial', pattern: 'keep_suffix', visibleChars: 4 },
     // +8613812345678 → +861****5678
     
     'card_number': { type: 'partial', pattern: 'keep_last4', visibleChars: 4 },
     // 1234567890123456 → ************3456
     
     'ip_address': { type: 'partial', pattern: 'mask_last_octet' },
     // 192.168.1.100 → 192.168.1.***
     
     'location': { type: 'fuzzy', precision: 2 }, // 经纬度模糊化到小数点后 2 位
     // 31.2304, 121.4737 → 31.23, 121.47
     
     'id_card': { type: 'partial', pattern: 'keep_prefix_suffix', prefixChars: 4, suffixChars: 4 },
     // 310101199001011234 → 3101********1234
   };
   ```

2. 自动应用到：
   - API 响应（根据用户角色）
   - 日志输出（结构化日志自动脱敏）
   - 错误消息（错误堆栈中的敏感数据）
   - 调试输出（console.log 拦截）

3. 支持自定义脱敏规则注册：
   ```javascript
   registerMaskingRule('custom_field', {
     type: 'regex',
     pattern: /sensitive_data/,
     replacement: '***REDACTED***',
   });
   ```

### 4.5 API 响应扫描工具

**实现位置**：`backend/tools/api-sensitive-scanner.js`

**功能要求**：
1. 自动扫描所有 API 端点，检测敏感字段暴露：
   ```bash
   node backend/tools/api-sensitive-scanner.js
   # 输出：
   # [WARN] GET /api/users/:id 暴露 P1 字段: email, phone
   # [WARN] GET /api/payments/:id 暴露 P0 字段: card_number (partial)
   ```

2. 生成敏感字段暴露报告：
   - 列出所有暴露敏感字段的 API
   - 按敏感级别分类（P0/P1/P2/P3）
   - 提供修复建议

3. 集成到 CI/CD 流程：
   ```yaml
   # .github/workflows/security-scan.yml
   - name: Scan API for sensitive data exposure
     run: node backend/tools/api-sensitive-scanner.js --fail-on-p0
   ```

### 4.6 数据库迁移

**实现位置**：`database/pending/20260608_194800__add_sensitive_data_audit_tables.sql`

```sql
-- 审计日志加密表（扩展现有 audit_logs 表）
ALTER TABLE audit_logs 
ADD COLUMN encrypted_data BYTEA,
ADD COLUMN encryption_key_id VARCHAR(64),
ADD COLUMN encryption_iv VARCHAR(64);

-- 敏感数据访问日志表
CREATE TABLE sensitive_data_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  accessed_by UUID NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  accessed_fields TEXT[] NOT NULL,
  access_reason VARCHAR(100),
  encrypted_ip_address BYTEA,
  encryption_key_id VARCHAR(64),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  retention_days INTEGER DEFAULT 90,
  INDEX idx_user_access (user_id, timestamp),
  INDEX idx_resource_access (resource_type, resource_id, timestamp)
);

-- 加密密钥管理表
CREATE TABLE encryption_keys (
  id VARCHAR(64) PRIMARY KEY,
  algorithm VARCHAR(50) DEFAULT 'aes-256-gcm',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  encrypted_key BYTEA NOT NULL -- 使用主密钥加密的工作密钥
);
```

### 4.7 管理后台权限控制

**实现位置**：`frontend/admin-dashboard/src/sensitive-data-control.js`

**功能要求**：
1. 敏感数据查看需要二次验证：
   ```javascript
   // 管理员查看用户 email/phone 时，需要输入 MFA 验证码
   async function viewSensitiveField(userId, field) {
     const mfaToken = await requestMFA();
     const response = await fetch(`/api/admin/users/${userId}/${field}`, {
       headers: { 'X-MFA-Token': mfaToken },
     });
     return response.json();
   }
   ```

2. 敏感数据查看日志：
   - 记录管理员查看敏感数据的所有操作
   - 显示查看原因、时间、IP 地址
   - 支持导出审计报告

3. 权限分级：
   - L1 管理员：只能查看脱敏后的数据
   - L2 管理员：可以查看完整数据（需 MFA）
   - L3 管理员：可以导出敏感数据（需审批）

## 5. 验收标准（可测试）

- [ ] API 响应过滤中间件已实现，普通用户无法看到 P0/P1 字段
- [ ] 审计日志采用 AES-256-GCM 加密存储，密钥可轮换
- [ ] 敏感数据访问日志记录完整，支持查询和审计
- [ ] 数据脱敏规则覆盖至少 10 种数据类型（email、phone、card、ip、location 等）
- [ ] API 扫描工具可以检测出所有暴露敏感字段的端点
- [ ] 管理后台查看敏感数据需要 MFA 二次验证
- [ ] 单元测试覆盖率 >= 90%，包括加密/解密、脱敏规则、权限控制
- [ ] 集成测试验证 API 响应字段过滤正确性
- [ ] CI/CD 流水线集成 API 敏感字段扫描，P0 级暴露会导致构建失败
- [ ] 文档更新，包括敏感字段定义、脱敏规则配置、密钥管理流程

## 6. 工作量估算

**L (Large)**

**理由**：
- 需要实现多个核心模块（响应过滤、加密存储、审计日志、脱敏引擎）
- 涉及数据库迁移和密钥管理系统
- 需要与现有系统（Gateway、审计日志、用户服务）深度集成
- 需要全面的测试覆盖（加密算法、权限控制、API 扫描）
- 预估开发时间：5-7 个工作日

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **合规要求**：GDPR 第 25 条要求"设计和默认数据保护"，PCI-DSS 要求敏感数据加密存储
2. **安全风险**：当前审计日志明文存储，存在重大数据泄露风险
3. **用户信任**：敏感数据保护是用户信任的基础，直接影响品牌声誉
4. **审计需求**：缺少敏感数据访问审计，无法满足合规审计要求
5. **项目成熟度**：项目已达到 100/100 成熟度评分，但安全加固仍有提升空间，此需求可进一步提升安全评分

此需求完成后，项目的数据安全防护将达到生产级标准，满足全球主要地区的合规要求。
