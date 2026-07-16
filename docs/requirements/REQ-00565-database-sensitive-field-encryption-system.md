# REQ-00565：数据库敏感字段透明加密系统

- **编号**：REQ-00565
- **类别**：安全加固
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：backend/shared/crypto、user-service、payment-service、social-service、database
- **创建时间**：2026-07-16 02:05
- **依赖需求**：REQ-00016（GDPR合规）、REQ-00394（API敏感参数脱敏）

## 1. 背景与问题

mineGo 项目存储了大量用户敏感数据，但当前仅依赖数据库层面的访问控制，缺乏对敏感字段的加密保护：

### 1.1 当前问题

1. **敏感数据明文存储风险**：
   - 用户手机号、邮箱明文存储在 `users` 表
   - 支付卡号后四位、账单地址明文存储在 `payment_methods` 表
   - 用户真实姓名、身份证号（部分地区的年龄验证）明文存储
   - 聊天消息内容、精灵自定义名称等可能包含用户隐私信息

2. **数据库泄露即数据泄露**：
   - 数据库备份文件被盗取 → 所有敏感数据直接暴露
   - 内部运维人员越权查询 → 无防护屏障
   - 数据库账号被盗 → 所有数据可被批量导出

3. **合规性要求未满足**：
   - GDPR 第32条要求"适当的技术措施"保护个人数据
   - PCI DSS 要求支付数据加密存储
   - 多地区数据保护法规要求敏感数据加密

4. **现有加密方案的局限**：
   - 部分字段使用 bcrypt（如密码），但不可逆，无法用于需要查询的字段
   - JWT 密钥管理在环境变量，缺乏密钥轮换机制
   - 缺乏统一的加密基础设施，各服务可能自行实现不一致的方案

### 1.2 风险评估

| 数据类型 | 敏感级别 | 当前状态 | 风险等级 |
|----------|----------|----------|----------|
| 用户手机号 | 高 | 明文 | 🔴 高危 |
| 用户邮箱 | 高 | 明文 | 🔴 高危 |
| 支付卡号后四位 | 高 | 明文 | 🔴 高危 |
| 账单地址 | 高 | 明文 | 🔴 高危 |
| 聊天消息 | 中 | 明文 | 🟡 中危 |
| 用户昵称 | 低 | 明文 | 🟢 低危 |

## 2. 目标

构建数据库敏感字段透明加密系统，实现：

1. **透明加密**：应用层无需关心加解密，ORM 层自动处理
2. **字段级加密**：支持针对特定字段进行加密，非全表加密
3. **密钥管理**：集中式密钥管理，支持密钥轮换和多环境隔离
4. **查询兼容**：加密字段仍支持精确查询（通过确定性加密或盲索引）
5. **审计追踪**：加密操作日志、密钥使用记录、异常告警

## 3. 范围

### 3.1 包含

- **加密引擎**：
  - AES-256-GCM 作为默认加密算法
  - 支持确定性加密（用于查询字段）和非确定性加密（高敏感字段）
  - 基于密钥派生函数（HKDF）的上下文密钥生成

- **ORM 集成**：
  - Sequelize 模型层自动加密/解密
  - 支持虚拟字段（加密存储、明文访问）
  - 批量查询时的自动解密

- **密钥管理服务**：
  - 集中式密钥存储（支持 HashiCorp Vault、AWS KMS、本地加密存储）
  - 密钥轮换机制（定时轮换 + 手动触发）
  - 多环境密钥隔离（dev/staging/prod）

- **字段配置**：
  - 通过模型装饰器声明加密字段
  - 敏感字段分级（高敏感→不可搜索加密，中敏感→可搜索加密）

- **迁移工具**：
  - 现有数据批量加密迁移脚本
  - 加密状态校验工具
  - 回滚机制（紧急情况解密）

### 3.2 不包含

- 全库加密（依赖 PostgreSQL TDE 或云服务商方案）
- 磁盘级加密（由基础设施层处理）
- 传输层加密（已有 TLS 配置）
- 密码字段加密（已使用 bcrypt 哈希）

## 4. 详细需求

### 4.1 加密引擎实现

```javascript
// backend/shared/crypto/EncryptionEngine.js

class EncryptionEngine {
  /**
   * 加密数据
   * @param {string} plaintext - 明文
   * @param {string} context - 加密上下文（表名+字段名）
   * @param {Object} options - 加密选项
   * @returns {string} - Base64 编码的密文
   */
  async encrypt(plaintext, context, options = {}) { ... }

  /**
   * 解密数据
   * @param {string} ciphertext - Base64 编码的密文
   * @param {string} context - 加密上下文
   * @returns {string} - 明文
   */
  async decrypt(ciphertext, context) { ... }

  /**
   * 确定性加密（用于可查询字段）
   * 相同明文 + 相同上下文 → 相同密文
   */
  async encryptDeterministic(plaintext, context) { ... }

  /**
   * 生成盲索引（用于模糊查询）
   */
  async generateBlindIndex(plaintext, context) { ... }
}
```

### 4.2 ORM 模型集成

```javascript
// backend/services/user-service/src/models/User.js

const { EncryptedField } = require('@pmg/shared/crypto');

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    
    // 加密字段：手机号（可搜索）
    phone: {
      type: DataTypes.STRING(256), // 加密后长度增加
      ...EncryptedField({
        searchable: true,           // 确定性加密，支持精确查询
        context: 'users.phone'
      })
    },
    
    // 加密字段：邮箱（可搜索）
    email: {
      type: DataTypes.STRING(512),
      ...EncryptedField({
        searchable: true,
        context: 'users.email'
      })
    },
    
    // 加密字段：真实姓名（不可搜索）
    realName: {
      type: DataTypes.STRING(256),
      ...EncryptedField({
        searchable: false,          // 非确定性加密
        context: 'users.realName'
      })
    },
    
    // 非敏感字段：昵称
    nickname: {
      type: DataTypes.STRING(50),
      allowNull: true
    }
  });
  
  return User;
};
```

### 4.3 密钥管理服务

```javascript
// backend/shared/crypto/KeyManagementService.js

class KeyManagementService {
  /**
   * 获取当前加密密钥
   * @param {string} context - 加密上下文
   * @returns {Buffer} - 加密密钥
   */
  async getCurrentKey(context) { ... }
  
  /**
   * 轮换密钥
   * @param {string} context - 加密上下文
   * @returns {string} - 新密钥版本
   */
  async rotateKey(context) { ... }
  
  /**
   * 使用指定密钥版本解密（支持历史数据解密）
   * @param {string} ciphertext - 密文
   * @param {string} keyVersion - 密钥版本
   * @param {string} context - 加密上下文
   */
  async decryptWithVersion(ciphertext, keyVersion, context) { ... }
  
  /**
   * 密钥健康检查
   */
  async healthCheck() { ... }
}
```

### 4.4 敏感字段配置清单

| 表名 | 字段 | 加密类型 | 可搜索 | 优先级 |
|------|------|----------|--------|--------|
| users | phone | 确定性 | ✓ | P0 |
| users | email | 确定性 | ✓ | P0 |
| users | real_name | 非确定性 | ✗ | P1 |
| payment_methods | card_last_four | 确定性 | ✓ | P0 |
| payment_methods | billing_address | 非确定性 | ✗ | P1 |
| social_messages | content | 非确定性 | ✗ | P2 |
| user_profiles | avatar_url | 不加密 | - | - |

### 4.5 API 接口影响

```javascript
// 查询加密字段示例

// ❌ 错误：无法直接查询加密字段
const user = await User.findOne({
  where: { phone: '+8613800138000' }
});

// ✅ 正确：使用加密查询
const user = await User.findOne({
  where: {
    phone: await User.sequelize.encrypt('+8613800138000', 'users.phone')
  }
});

// ✅ 或使用模型方法封装
const user = await User.findByEncrypted('phone', '+8613800138000');
```

### 4.6 数据迁移脚本

```javascript
// scripts/migrate-encrypt-sensitive-fields.js

async function migrateEncryptUsers() {
  const users = await User.findAll({ where: { phone_encrypted: null } });
  
  for (const user of users) {
    await User.update(
      {
        phone: user.phone,  // 会自动加密
        email: user.email,
        realName: user.realName
      },
      { where: { id: user.id }, encrypt: true }
    );
    
    console.log(`Encrypted user ${user.id}`);
  }
}
```

## 5. 验收标准（可测试）

- [ ] **加密功能验证**：
  - 数据库中的敏感字段存储为加密字符串（Base64格式）
  - 应用层查询返回解密后的明文
  - 密文无法直接被 SQL 函数解析

- [ ] **查询功能验证**：
  - 确定性加密字段支持精确查询
  - 查询性能下降不超过 10%
  - 不支持模糊查询、范围查询（设计如此）

- [ ] **密钥管理验证**：
  - 密钥存储在安全位置（Vault 或加密文件）
  - 密钥轮换后，新数据使用新密钥，历史数据仍可解密
  - 密钥访问有审计日志

- [ ] **性能验证**：
  - 单条记录加解密延迟 < 1ms
  - 批量查询（100条）加解密总延迟 < 50ms
  - 内存使用增加 < 10%

- [ ] **安全性验证**：
  - 密钥不在日志中打印
  - 加密算法符合行业标准（AES-256-GCM）
  - 通过安全扫描（无弱加密警告）

- [ ] **迁移验证**：
  - 迁移脚本可中断、可恢复
  - 迁移后数据一致性校验通过
  - 回滚脚本可正常执行

## 6. 工作量估算

**XL（预计 10-15 人日）**

| 任务 | 工作量 |
|------|--------|
| 加密引擎实现 + 单元测试 | 2 人日 |
| ORM 模型集成（Sequelize） | 2 人日 |
| 密钥管理服务 | 2 人日 |
| 密钥轮换机制 | 1 人日 |
| 数据迁移脚本 | 2 人日 |
| API 层适配 + 测试 | 2 人日 |
| 文档 + 安全审计 | 1 人日 |
| Buffer + 联调 | 2 人日 |

## 7. 优先级理由

**P0 理由**：

1. **安全合规强制要求**：GDPR、PCI DSS 等法规明确要求敏感数据加密存储
2. **数据泄露风险**：数据库泄露事件频发，明文存储敏感数据是重大安全隐患
3. **生产上线阻碍**：安全审计无法通过，可能影响产品上线
4. **用户信任**：加密保护是用户隐私保护的基本承诺
5. **依赖其他安全需求**：后续可能需要字段级访问控制、动态脱敏等功能

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 性能下降 | 中 | 使用确定性加密减少解密次数；缓存解密结果 |
| 查询能力受限 | 中 | 盲索引支持模糊查询；关键查询字段使用确定性加密 |
| 密钥丢失数据无法恢复 | 高 | 密钥多副本备份；密钥轮换保留历史版本 |
| 迁移过程服务中断 | 中 | 分批迁移；灰度切换 |

## 9. 相关需求

- REQ-00016：GDPR 合规（数据保护要求）
- REQ-00394：API 敏感参数脱敏（日志保护）
- REQ-00003：支付幂等性与安全（支付数据安全）
- REQ-00565（本需求）：数据库敏感字段加密

---

**创建时间**：2026-07-16 02:05 UTC
**创建者**：mineGo 开发循环自动化系统