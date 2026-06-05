# REQ-00016：GDPR 合规与用户数据隐私保护

- **编号**：REQ-00016
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、所有微服务、gateway、database
- **创建时间**：2026-06-05 09:40
- **依赖需求**：REQ-00003（支付安全）

## 1. 背景与问题

mineGo 作为面向全球用户的 AR 游戏，需要符合 GDPR（欧盟通用数据保护条例）等隐私法规：

### 1.1 当前合规问题

1. **无隐私政策**：缺少明确的隐私政策和用户同意机制
2. **数据收集不透明**：用户不知道收集了哪些数据、用途是什么
3. **无数据导出功能**：用户无法导出自己的数据（GDPR 第 20 条）
4. **无数据删除功能**：用户无法删除自己的数据（GDPR 第 17 条"被遗忘权"）
5. **敏感数据处理不当**：GPS 位置、支付信息等敏感数据缺少特殊保护
6. **无数据保留策略**：数据永久保存，违反最小化原则

### 1.2 GDPR 核心要求

| 条款 | 要求 | 当前状态 |
|------|------|---------|
| 第 7 条 | 用户明确同意 | ❌ 缺失 |
| 第 12 条 | 透明告知 | ❌ 缺失 |
| 第 17 条 | 被遗忘权 | ❌ 缺失 |
| 第 20 条 | 数据可携带权 | ❌ 缺失 |
| 第 25 条 | 隐私设计 | ⚠️ 部分 |
| 第 32 条 | 安全措施 | ✅ 已有 |

## 2. 目标

建立完整的 GDPR 合规体系：

1. **隐私政策与同意机制**：用户注册时明确同意隐私政策
2. **数据透明化**：用户可查看收集的所有个人数据
3. **数据导出**：支持导出用户数据（JSON/CSV 格式）
4. **数据删除**：支持删除用户数据，满足被遗忘权
5. **敏感数据保护**：GPS、支付等敏感数据特殊处理
6. **数据保留策略**：定义各类数据的保留期限

## 3. 范围

### 包含
- 隐私政策和同意机制
- 用户数据导出 API
- 用户数据删除 API（GDPR 删除）
- 敏感数据脱敏和加密
- 数据保留策略和自动清理
- 合规审计日志

### 不包含
- Cookie 同意横幅（前端实现）
- 第三方数据处理协议（DPA）
- 数据保护官（DPO）任命流程

## 4. 详细需求

### 4.1 隐私政策与同意机制

#### 4.1.1 隐私政策文档
```markdown
# mineGo 隐私政策

## 我们收集的数据

### 必需数据
- 账户信息：邮箱、用户名、密码（加密）
- 位置数据：GPS 坐标（用于游戏功能）
- 设备信息：设备类型、操作系统

### 可选数据
- 支付信息：支付方式、交易记录
- 社交数据：好友列表、聊天记录

## 数据用途

- 提供游戏服务（位置数据用于精灵生成）
- 改进游戏体验（分析用户行为）
- 发送通知（新活动、好友请求）

## 数据共享

我们不会出售您的数据。仅在以下情况共享：
- 支付处理（支付服务商）
- 法律要求

## 您的权利

- 查看您的数据
- 导出您的数据
- 删除您的数据
- 撤回同意

## 联系我们

privacy@minego.com
```

#### 4.1.2 同意机制实现
```javascript
// backend/services/user-service/src/routes/auth.js
router.post('/register', async (req, res) => {
  const { email, password, username, consent } = req.body;
  
  // 验证同意
  if (!consent || !consent.privacyPolicy || !consent.termsOfService) {
    return res.status(400).json({
      error: 'Must accept privacy policy and terms of service'
    });
  }
  
  // 创建用户
  const user = await createUser({ email, password, username });
  
  // 记录同意
  await db.query(`
    INSERT INTO user_consents (user_id, privacy_policy_version, terms_version, consented_at)
    VALUES ($1, $2, $3, NOW())
  `, [user.id, '1.0', '1.0']);
  
  // 记录审计日志
  await auditLog({
    userId: user.id,
    action: 'consent_given',
    details: { privacyPolicy: true, termsOfService: true }
  });
  
  res.json({ success: true, user });
});
```

#### 4.1.3 数据库表
```sql
-- 用户同意记录
CREATE TABLE user_consents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  privacy_policy_version VARCHAR(10),
  terms_version VARCHAR(10),
  consented_at TIMESTAMP NOT NULL,
  withdrawn_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 隐私政策版本
CREATE TABLE privacy_policy_versions (
  version VARCHAR(10) PRIMARY KEY,
  content TEXT NOT NULL,
  published_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4.2 用户数据导出

#### 4.2.1 数据导出 API
```javascript
// backend/services/user-service/src/routes/gdpr.js
router.get('/export', authenticate, async (req, res) => {
  const userId = req.user.id;
  
  // 收集所有用户数据
  const userData = {
    exportDate: new Date().toISOString(),
    user: await exportUserData(userId),
    pokemon: await exportPokemonData(userId),
    catches: await exportCatchHistory(userId),
    gyms: await exportGymHistory(userId),
    social: await exportSocialData(userId),
    payments: await exportPaymentData(userId),
    rewards: await exportRewardHistory(userId)
  };
  
  // 记录审计日志
  await auditLog({
    userId,
    action: 'data_exported',
    details: { format: 'json' }
  });
  
  // 返回 JSON
  res.setHeader('Content-Disposition', `attachment; filename="minego-data-${userId}.json"`);
  res.json(userData);
});

// 导出用户数据
async function exportUserData(userId) {
  const result = await db.query(`
    SELECT id, email, username, created_at, language_preference
    FROM users WHERE id = $1
  `, [userId]);
  
  return result.rows[0];
}

// 导出精灵数据
async function exportPokemonData(userId) {
  const result = await db.query(`
    SELECT id, pokemon_id, name, cp, iv, caught_at, caught_location
    FROM user_pokemon WHERE user_id = $1
  `, [userId]);
  
  return result.rows;
}

// 导出支付数据（脱敏）
async function exportPaymentData(userId) {
  const result = await db.query(`
    SELECT 
      id, 
      amount, 
      currency, 
      status, 
      created_at,
      '****' || RIGHT(payment_method, 4) as payment_method
    FROM payments WHERE user_id = $1
  `, [userId]);
  
  return result.rows;
}
```

### 4.3 用户数据删除

#### 4.3.1 数据删除 API
```javascript
// backend/services/user-service/src/routes/gdpr.js
router.delete('/delete', authenticate, async (req, res) => {
  const userId = req.user.id;
  const { confirmation } = req.body;
  
  // 验证确认
  if (confirmation !== 'DELETE MY ACCOUNT') {
    return res.status(400).json({
      error: 'Please type "DELETE MY ACCOUNT" to confirm'
    });
  }
  
  // 记录审计日志
  await auditLog({
    userId,
    action: 'data_deletion_requested',
    details: { reason: 'user_request' }
  });
  
  // 异步删除（避免超时）
  await eventBus.publish('gdpr.delete', { userId });
  
  res.json({ 
    success: true, 
    message: 'Data deletion in progress. You will receive email confirmation.' 
  });
});
```

#### 4.3.2 数据删除处理器
```javascript
// backend/services/user-service/src/handlers/gdprHandler.js
async function handleDataDeletion(event) {
  const { userId } = event.data;
  
  logger.info({ userId }, 'Starting GDPR data deletion');
  
  try {
    // 1. 删除精灵数据
    await db.query('DELETE FROM user_pokemon WHERE user_id = $1', [userId]);
    
    // 2. 删除捕捉历史
    await db.query('DELETE FROM catch_history WHERE user_id = $1', [userId]);
    
    // 3. 删除道馆数据
    await db.query('DELETE FROM gym_battles WHERE user_id = $1', [userId]);
    
    // 4. 删除社交数据
    await db.query('DELETE FROM friendships WHERE user1_id = $1 OR user2_id = $1', [userId]);
    await db.query('DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1', [userId]);
    
    // 5. 删除支付数据（保留审计记录，脱敏）
    await db.query(`
      UPDATE payments 
      SET payment_method = 'DELETED', 
          metadata = '{}' 
      WHERE user_id = $1
    `, [userId]);
    
    // 6. 删除奖励数据
    await db.query('DELETE FROM user_rewards WHERE user_id = $1', [userId]);
    
    // 7. 匿名化用户记录（保留审计需要）
    await db.query(`
      UPDATE users 
      SET email = 'deleted@deleted.com', 
          username = 'deleted_user_' || id,
          password_hash = '',
          deleted_at = NOW()
      WHERE id = $1
    `, [userId]);
    
    // 8. 记录完成
    await auditLog({
      userId,
      action: 'data_deletion_completed',
      details: { deletedAt: new Date().toISOString() }
    });
    
    // 9. 发送确认邮件
    await sendEmail(userId, 'data-deletion-complete');
    
    logger.info({ userId }, 'GDPR data deletion completed');
  } catch (err) {
    logger.error({ err, userId }, 'GDPR data deletion failed');
    throw err;
  }
}

eventBus.subscribe('gdpr.delete', handleDataDeletion);
```

### 4.4 敏感数据保护

#### 4.4.1 GPS 数据加密
```javascript
// backend/shared/encryption.js
const crypto = require('crypto');

class DataEncryption {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  }

  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  }

  decrypt(encrypted, iv, authTag) {
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.key,
      Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
}

// 加密 GPS 数据
async function saveEncryptedLocation(userId, lat, lng) {
  const encrypted = encrypt(JSON.stringify({ lat, lng }));
  
  await db.query(`
    INSERT INTO user_locations (user_id, encrypted_location, iv, auth_tag)
    VALUES ($1, $2, $3, $4)
  `, [userId, encrypted.encrypted, encrypted.iv, encrypted.authTag]);
}
```

#### 4.4.2 数据脱敏
```javascript
// backend/shared/dataMasking.js
const DataMasking = {
  // 邮箱脱敏
  email: (email) => {
    const [local, domain] = email.split('@');
    return `${local[0]}***@${domain}`;
  },
  
  // 手机号脱敏
  phone: (phone) => {
    return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
  },
  
  // 支付方式脱敏
  paymentMethod: (method) => {
    return `****${method.slice(-4)}`;
  },
  
  // GPS 位置模糊化
  location: (lat, lng, precision = 3) => {
    return {
      lat: Math.round(lat * Math.pow(10, precision)) / Math.pow(10, precision),
      lng: Math.round(lng * Math.pow(10, precision)) / Math.pow(10, precision)
    };
  }
};
```

### 4.5 数据保留策略

#### 4.5.1 保留策略配置
```javascript
// backend/shared/dataRetention.js
const DataRetentionPolicy = {
  // 用户数据：永久保留（用户删除时删除）
  users: { retention: null, autoDelete: false },
  
  // 捕捉历史：保留 2 年
  catchHistory: { retention: 730, autoDelete: true },
  
  // 道馆战斗记录：保留 1 年
  gymBattles: { retention: 365, autoDelete: true },
  
  // 消息记录：保留 90 天
  messages: { retention: 90, autoDelete: true },
  
  // 支付记录：保留 7 年（法律要求）
  payments: { retention: 2555, autoDelete: false },
  
  // 审计日志：保留 7 年
  auditLogs: { retention: 2555, autoDelete: false }
};
```

#### 4.5.2 自动清理任务
```javascript
// scripts/data-retention-cleanup.js
async function cleanupExpiredData() {
  for (const [table, policy] of Object.entries(DataRetentionPolicy)) {
    if (!policy.autoDelete || !policy.retention) continue;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - policy.retention);
    
    const result = await db.query(`
      DELETE FROM ${table}
      WHERE created_at < $1
      RETURNING id
    `, [cutoffDate]);
    
    logger.info({ 
      table, 
      deleted: result.rowCount,
      cutoffDate 
    }, 'Data retention cleanup');
  }
}

// 每天凌晨 2 点执行
cron.schedule('0 2 * * *', cleanupExpiredData);
```

### 4.6 合规审计日志

#### 4.6.1 审计日志表
```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  action VARCHAR(100) NOT NULL,
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
```

#### 4.6.2 审计日志记录
```javascript
// backend/shared/auditLog.js
async function auditLog({ userId, action, details, req }) {
  await db.query(`
    INSERT INTO audit_logs (user_id, action, details, ip_address, user_agent)
    VALUES ($1, $2, $3, $4, $5)
  `, [
    userId,
    action,
    JSON.stringify(details),
    req?.ip || null,
    req?.headers['user-agent'] || null
  ]);
}
```

## 5. 验收标准（可测试）

- [ ] 隐私政策文档已创建，版本管理正常
- [ ] 用户注册时必须同意隐私政策，记录同意时间
- [ ] 数据导出 API 正常：`GET /api/gdpr/export` 返回完整用户数据
- [ ] 数据删除 API 正常：`DELETE /api/gdpr/delete` 触发删除流程
- [ ] 删除流程完整：所有用户数据被删除或匿名化
- [ ] GPS 数据加密存储，解密正常
- [ ] 敏感数据脱敏：邮箱、手机号、支付方式正确脱敏
- [ ] 数据保留策略生效：过期数据自动清理
- [ ] 审计日志完整：所有 GDPR 操作记录审计日志
- [ ] 单元测试覆盖率 ≥ 80%（GDPR 相关功能）
- [ ] 集成测试验证完整删除流程
- [ ] 法律审核通过（隐私政策）

## 6. 工作量估算

**L (Large)**

- 隐私政策和同意机制：1 天
- 数据导出 API：1 天
- 数据删除 API 和处理器：2 天
- 敏感数据加密和脱敏：1 天
- 数据保留策略：1 天
- 审计日志：0.5 天
- 测试和验证：1 天

**总计：7.5 天**

## 7. 优先级理由

**P1** 理由：

1. **法律合规**：GDPR 违规可导致高达 2000 万欧元罚款
2. **用户信任**：隐私保护是用户信任的基础
3. **市场准入**：欧盟市场要求 GDPR 合规
4. **道德责任**：保护用户隐私是企业的道德责任
5. **竞争优势**：良好的隐私保护是竞争优势

GDPR 合规是法律要求，必须尽快实施。
