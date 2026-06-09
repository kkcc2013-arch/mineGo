# REQ-00057：多因素认证（MFA）系统

- **编号**：REQ-00057
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、gateway、game-client、backend/shared、database/migrations
- **创建时间**：2026-06-09 17:05
- **依赖需求**：REQ-00021（JWT 黑名单）

## 1. 背景与问题

当前系统仅依赖用户名+密码进行身份验证，存在以下安全风险：

1. **密码泄露风险**：用户可能在多个平台使用相同密码，一旦泄露即可被盗号
2. **无二次验证**：敏感操作（修改密码、绑定支付、大额交易）无额外保护
3. **合规要求**：GDPR、PCI-DSS 对敏感数据访问建议启用 MFA
4. **行业惯例**：主流游戏（Pokémon GO、原神）均支持 MFA

代码现状：
- `backend/shared/responseFilter.js` 有 `mfaVerified` 字段但未实现
- `backend/shared/sensitiveDataAudit.js` 标记部分操作 `mfaRequired: true` 但无验证逻辑
- 数据库无 MFA 相关表结构

## 2. 目标

实现完整的多因素认证系统，支持：

1. **TOTP（基于时间的一次性密码）**：兼容 Google Authenticator、Microsoft Authenticator、Authy 等主流应用
2. **备用验证方式**：备用恢复码（8 个一次性码）
3. **敏感操作二次验证**：修改密码、绑定支付、大额交易需 MFA 确认
4. **MFA 状态管理**：启用/禁用、重置、恢复码管理

预期收益：
- 账号安全提升 90%+（即使密码泄露也无法登录）
- 满足 PCI-DSS Level 1 合规要求
- 降低账号被盗投诉率 80%+

## 3. 范围

- **包含**：
  - TOTP 密钥生成与验证（RFC 6238）
  - 二维码生成（otpauth:// URI）
  - 备用恢复码生成与验证
  - MFA 启用/禁用/重置流程
  - 敏感操作 MFA 中间件
  - 前端 MFA 设置页面
  - 登录流程 MFA 验证步骤

- **不包含**：
  - 短信验证码（成本高、延迟大）
  - 邮箱验证码（已有邮箱验证）
  - 硬件安全密钥（YubiKey，后续需求）
  - 生物识别（依赖设备能力）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 用户 MFA 配置表
CREATE TABLE user_mfa (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_type        VARCHAR(20) NOT NULL DEFAULT 'totp',  -- totp, recovery
  secret_encrypted TEXT NOT NULL,                        -- AES-256-GCM 加密的 TOTP 密钥
  secret_iv       TEXT NOT NULL,                         -- 加密 IV
  is_enabled      BOOLEAN NOT NULL DEFAULT false,
  verified_at     TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 备用恢复码表
CREATE TABLE mfa_recovery_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       VARCHAR(64) NOT NULL,                  -- SHA-256 哈希
  is_used         BOOLEAN NOT NULL DEFAULT false,
  used_at         TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_user_unused (user_id, is_used)
);

-- MFA 验证日志表
CREATE TABLE mfa_verification_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  mfa_type        VARCHAR(20) NOT NULL,
  success         BOOLEAN NOT NULL,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_user_created (user_id, created_at DESC)
);
```

### 4.2 API 设计

#### 用户 MFA 管理 API

| 端点 | 方法 | 说明 | MFA 要求 |
|------|------|------|----------|
| `/api/users/me/mfa/setup` | POST | 初始化 MFA，返回密钥和二维码 | 否（需登录） |
| `/api/users/me/mfa/verify` | POST | 验证并启用 MFA | 否（需登录） |
| `/api/users/me/mfa/disable` | POST | 禁用 MFA | **是** |
| `/api/users/me/mfa/recovery-codes` | GET | 获取恢复码状态 | **是** |
| `/api/users/me/mfa/recovery-codes/regenerate` | POST | 重新生成恢复码 | **是** |
| `/api/auth/mfa/verify` | POST | 登录时 MFA 验证 | 否 |
| `/api/auth/mfa/recovery` | POST | 使用恢复码验证 | 否 |

#### 请求/响应示例

```javascript
// POST /api/users/me/mfa/setup
// Response:
{
  "secret": "JBSWY3DPEHPK3PXP",  // Base32 密钥（仅此一次返回）
  "qrCodeUrl": "otpauth://totp/mineGo:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=mineGo",
  "recoveryCodes": ["ABCD-EFGH", "IJKL-MNOP", ...]  // 8 个恢复码
}

// POST /api/auth/mfa/verify
// Request:
{
  "userId": "uuid",
  "code": "123456"  // TOTP 6 位码
}
// Response:
{
  "success": true,
  "token": "jwt-token"
}
```

### 4.3 TOTP 实现

```javascript
// backend/shared/totp.js
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

class TOTPService {
  // 生成密钥
  generateSecret(email) {
    return speakeasy.generateSecret({
      name: `mineGo:${email}`,
      issuer: 'mineGo',
      length: 20  // 160 bits
    });
  }

  // 验证 TOTP 码
  verify(secret, code) {
    return speakeasy.totp.verify({
      secret: secret,
      encoding: 'base32',
      token: code,
      window: 2  // 允许前后 2 个时间窗口（60 秒容差）
    });
  }

  // 生成 otpauth:// URI
  generateOtpAuthUrl(email, secret) {
    return `otpauth://totp/mineGo:${encodeURIComponent(email)}?secret=${secret}&issuer=mineGo`;
  }

  // 生成二维码 Data URL
  async generateQRCode(otpAuthUrl) {
    return QRCode.toDataURL(otpAuthUrl);
  }
}
```

### 4.4 恢复码设计

```javascript
// 生成 8 个 8 位恢复码（格式：XXXX-XXXX）
function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0,4)}-${code.slice(4)}`);
  }
  return codes;
}

// 哈希存储（SHA-256）
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}
```

### 4.5 敏感操作 MFA 中间件

```javascript
// backend/gateway/src/middleware/mfaRequired.js
function mfaRequired(options = { maxAge: 300 }) {
  return async (req, res, next) => {
    if (!req.user.mfaEnabled) {
      return next();  // 未启用 MFA，直接通过
    }

    const mfaToken = req.headers['x-mfa-token'];
    if (!mfaToken) {
      return res.status(403).json({
        code: 1040,
        message: '此操作需要 MFA 验证',
        mfaRequired: true
      });
    }

    // 验证 MFA token（短期 JWT，5 分钟有效）
    const decoded = verifyMfaToken(mfaToken);
    if (!decoded || decoded.userId !== req.user.id) {
      return res.status(403).json({
        code: 1041,
        message: 'MFA 验证无效或已过期'
      });
    }

    next();
  };
}
```

### 4.6 登录流程改造

```
原流程：用户名/密码 → JWT Token

新流程：
1. 用户名/密码验证
2. 检查用户是否启用 MFA
   - 未启用 → 直接返回 JWT Token
   - 已启用 → 返回 { mfaRequired: true, tempToken: "临时token" }
3. 前端显示 MFA 输入框
4. 用户输入 TOTP 码或恢复码
5. POST /api/auth/mfa/verify 验证
6. 验证成功 → 返回 JWT Token
```

### 4.7 前端组件

```javascript
// frontend/game-client/src/components/MFASetup.js
class MFASetup {
  // 显示二维码和密钥
  // 输入验证码确认启用
  // 显示恢复码（仅一次）
}

// frontend/game-client/src/components/MFAVerify.js
class MFAVerify {
  // TOTP 码输入框
  // 恢复码输入选项
  // 记住设备选项（7 天免 MFA）
}
```

### 4.8 Prometheus 指标

```javascript
// MFA 相关指标
mfa_setup_total{status="success|failed"}
mfa_verification_total{type="totp|recovery",status="success|failed"}
mfa_recovery_codes_used_total
mfa_enabled_users_gauge
```

## 5. 验收标准（可测试）

- [ ] 用户可以成功设置 TOTP MFA，二维码可被 Google Authenticator 扫描识别
- [ ] TOTP 验证码验证成功率达到 99%+（在正确时间窗口内）
- [ ] 备用恢复码可以成功验证，使用后标记为已使用
- [ ] 启用 MFA 后，登录流程要求输入 MFA 码
- [ ] 禁用 MFA 需要当前 MFA 验证
- [ ] 敏感操作（修改密码、绑定支付）需要 MFA 验证
- [ ] MFA 验证失败 5 次后锁定 15 分钟
- [ ] 恢复码使用后立即失效，无法重复使用
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] Prometheus 指标正确上报

## 6. 工作量估算

**L（Large）**，约 3-4 天

理由：
- 涉及数据库迁移、后端服务、网关中间件、前端组件
- TOTP 库集成和测试
- 安全敏感功能，需要充分测试
- 登录流程改造

## 7. 优先级理由

**P1 理由**：
1. 账号安全是游戏运营的基础，MFA 是行业标准
2. 涉及支付系统，需满足 PCI-DSS 合规
3. 已有 `mfaRequired` 标记但未实现，属于技术债
4. 对"项目可用"贡献：防止账号被盗，降低客服成本
