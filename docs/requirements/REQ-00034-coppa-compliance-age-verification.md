# REQ-00034：COPPA 合规与未成年人年龄验证系统

- **编号**：REQ-00034
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：user-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-07 21:15
- **依赖需求**：REQ-00016（GDPR 合规）

## 1. 背景与问题

mineGo 作为一款基于地理位置的 AR 游戏，可能吸引大量未成年人玩家。当前系统缺乏年龄验证机制，存在以下合规风险：

**COPPA 合规风险**：
- 美国 COPPA 法案要求：13 岁以下儿童收集个人信息前必须获得家长同意
- 当前注册流程未收集年龄信息，无法识别未成年人
- 缺少家长同意流程和监护人验证机制
- 未提供儿童账号的隐私保护增强措施

**其他地区法规**：
- 欧盟 GDPR-K 对未成年人数据处理有特殊要求
- 中国《未成年人保护法》要求网络游戏实施防沉迷系统
- 韩国强制游戏账号实名认证

**当前代码问题**：
- `backend/services/user-service/src/routes/auth.js` 注册流程未包含年龄字段
- 缺少家长邮箱验证和同意记录
- 没有针对未成年人的功能限制机制

## 2. 目标

实现完整的年龄验证和未成年人保护系统，确保：
- 符合 COPPA、GDPR-K、中国未成年人保护法等国际法规
- 13 岁以下用户必须获得家长同意才能注册
- 提供家长控制面板管理儿童账号
- 未成年人游戏时间限制和消费保护
- 避免高额法律罚款和品牌声誉损失

## 3. 范围

- **包含**：
  - 注册流程增加年龄/出生日期字段
  - 家长邮箱验证和同意流程（COPPA 合规）
  - 未成年人账号标识和数据库表设计
  - 家长控制面板 API（查看游戏时间、设置限制）
  - 游戏时间限制中间件
  - 消费金额限制
  - 前端年龄选择器和家长验证 UI

- **不包含**：
  - 实名认证系统集成（可作为后续需求）
  - 人脸识别年龄验证（成本过高，暂不实施）
  - 具体国家的防沉迷规则细节（仅实现通用框架）

## 4. 详细需求

### 4.1 数据库设计

新增表 `user_age_profiles`：
```sql
CREATE TABLE user_age_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  birth_date DATE,
  age_bracket VARCHAR(20), -- 'under_13', '13_17', '18_plus', 'unknown'
  parent_email VARCHAR(255),
  parent_consent_status VARCHAR(20), -- 'pending', 'verified', 'denied', 'not_required'
  parent_consent_token VARCHAR(255),
  parent_consent_expires_at TIMESTAMP,
  consent_verified_at TIMESTAMP,
  daily_play_limit_minutes INTEGER,
  monthly_spend_limit_cents INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE parent_consent_logs (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  parent_email VARCHAR(255),
  action VARCHAR(50), -- 'sent', 'verified', 'denied', 'revoked'
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4.2 注册流程改造

修改 `backend/services/user-service/src/routes/auth.js`：

```javascript
const RegisterSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  smsCode: z.string().length(6, '验证码为6位'),
  nickname: z.string().min(2).max(30),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD
  deviceId: z.string().optional(),
  consent: z.object({
    privacyPolicy: z.boolean(),
    termsOfService: z.boolean()
  }).optional()
});
```

年龄计算逻辑：
- 根据 `birthDate` 计算当前年龄
- 年龄 < 13：要求提供 `parentEmail`，发送验证邮件
- 年龄 13-17：标记为青少年账号，可选家长监督
- 年龄 >= 18：正常注册

### 4.3 家长验证流程

**发送验证邮件**：
```javascript
POST /auth/send-parent-consent
{
  "userId": "uuid",
  "parentEmail": "parent@example.com"
}
```

邮件内容包含：
- 孩子昵称（脱敏）
- 游戏介绍和隐私政策链接
- 同意/拒绝按钮链接（带 token）
- token 有效期 7 天

**家长确认**：
```javascript
GET /auth/verify-parent-consent?token=xxx&action=approve|deny
```

### 4.4 家长控制面板 API

```javascript
// 家长登录（通过验证过的邮箱）
POST /auth/parent-login
{
  "email": "parent@example.com",
  "token": "verification_token"
}

// 查看儿童账号信息
GET /parent/children
Response: [{
  "userId": "uuid",
  "nickname": "xxx",
  "age": 12,
  "todayPlayMinutes": 45,
  "weeklyPlayMinutes": 320,
  "monthlySpendCents": 0
}]

// 设置限制
PUT /parent/children/:userId/limits
{
  "dailyPlayMinutes": 60,
  "monthlySpendCents": 0,
  "featuresDisabled": ["social", "trade"]
}
```

### 4.5 游戏时间限制中间件

在 `gateway` 层添加中间件：
```javascript
// backend/gateway/src/middleware/ageRestriction.js
async function checkPlayTimeLimit(req, res, next) {
  const userId = req.user.id;
  const ageProfile = await getAgeProfile(userId);
  
  if (ageProfile.age_bracket === 'under_13') {
    const todayMinutes = await getTodayPlayMinutes(userId);
    const limit = ageProfile.daily_play_limit_minutes || 60;
    
    if (todayMinutes >= limit) {
      throw new AppError(4031, '今日游戏时间已达上限，请明日再来', 403);
    }
  }
  next();
}
```

### 4.6 消费限制

在 `payment-service` 中检查：
```javascript
// 支付前检查月度消费限额
if (userAge.age_bracket === 'under_13') {
  const monthlySpend = await getMonthlySpend(userId);
  const limit = ageProfile.monthly_spend_limit_cents || 0;
  
  if (monthlySpend + amount > limit) {
    throw new AppError(4032, '消费金额已达月度限制', 403);
  }
}
```

### 4.7 前端改造

**注册页面**：
- 添加出生日期选择器（年月日下拉框）
- 检测到未成年人时，显示家长邮箱输入框
- 友好提示："根据法规要求，13 岁以下需要家长同意"

**家长验证页面**：
- 新增 `/parent-verify` 路由
- 显示家长控制面板登录入口

## 5. 验收标准（可测试）

- [ ] 注册时可以输入出生日期，系统正确计算年龄
- [ ] 13 岁以下用户注册后状态为 `pending`，必须完成家长验证才能登录
- [ ] 家长邮箱验证链接可正常发送和点击
- [ ] 家长同意后，儿童账号状态变为 `verified`，可正常游戏
- [ ] 家长拒绝后，儿童账号被锁定，提示联系客服
- [ ] 未成年人游戏时间超过限制时，被阻止继续游戏
- [ ] 未成年人消费超过限额时，支付被拒绝
- [ ] 家长可通过控制面板查看儿童游戏时间和消费记录
- [ ] 所有验证操作记录在 `parent_consent_logs` 表
- [ ] 单元测试覆盖年龄计算、验证流程、限制检查

## 6. 工作量估算

**M（Medium）**
- 数据库设计和迁移：2 小时
- 注册流程改造：3 小时
- 邮件发送和验证逻辑：3 小时
- 家长控制面板 API：4 小时
- 时间和消费限制中间件：3 小时
- 前端 UI 改造：4 小时
- 单元测试：3 小时
- 总计：约 22 小时

## 7. 优先级理由

**P1 理由**：
- 合规性风险：违反 COPPA 可能面临每例最高 $43,792 美元罚款
- 全球化必需：美国、欧盟、中国等主要市场都有未成年人保护法规
- 用户安全：保护未成年人免受过度消费和沉迷影响
- 品牌声誉：合规问题可能导致应用下架和负面舆论

**依赖 REQ-00016**：
- GDPR 合规已实现基础的用户同意记录机制
- 可复用 `user_consents` 表和审计日志架构
