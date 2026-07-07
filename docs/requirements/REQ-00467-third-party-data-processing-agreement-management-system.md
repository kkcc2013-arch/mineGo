# REQ-00467：第三方数据处理协议管理系统

- **编号**：REQ-00467
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/services/user-service、backend/shared/compliance、admin-dashboard
- **创建时间**：2026-07-07 01:00 UTC
- **依赖需求**：REQ-00053（隐私偏好中心）、REQ-00016（GDPR合规）

## 1. 背景与问题

GDPR 第 28 条要求：**控制器与处理者之间必须签订书面数据处理协议（DPA）**。当前 mineGo 项目：

1. **缺少 DPA 管理**：无系统记录与第三方供应商（云服务商、支付网关、推送服务）的数据处理协议
2. **协议状态不透明**：无法追踪哪些供应商已签署协议、协议是否过期
3. **审计追溯困难**：无集中化存储协议条款、签署日期、审核历史
4. **合规风险**：监管审计时无法快速提供数据处理协议证据
5. **缺少自动提醒**：协议到期前无预警机制

**代码现状**：
- `privacyPreferences.js`：仅管理用户隐私偏好
- `auditLog.js`：通用审计日志
- 缺少：供应商管理、DPA 存储、协议状态追踪

## 2. 目标

构建完整的第三方数据处理协议管理系统：

1. **供应商注册**：记录数据处理方信息、数据类型、处理目的
2. **协议管理**：上传/存储 DPA 文档，追踪签署状态
3. **自动提醒**：协议到期前 90/60/30 天自动告警
4. **合规审计**：生成数据处理协议清单报告
5. **权限控制**：仅管理员可访问敏感协议信息

## 3. 范围

### 包含
- 供应商信息管理 API
- 数据处理协议文档存储（PDF/Docx）
- 协议签署状态追踪
- 协议到期自动告警（集成告警系统）
- 管理后台查看界面
- 协议清单导出功能
- 审计日志记录

### 不包含
- 用户隐私偏好管理（REQ-00053 已完成）
- GDPR 数据删除请求（REQ-00305 已完成）
- 隐私政策版本管理（REQ-00341 已完成）

## 4. 详细需求

### 4.1 数据库设计

创建迁移文件 `database/migrations/20260707_010000_create_data_processing_agreement_tables.sql`：

```sql
-- 数据处理方（供应商）表
CREATE TABLE data_processors (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'cloud_provider', 'payment_gateway', 'push_service', 'analytics', 'other'
  contact_email VARCHAR(255),
  contact_phone VARCHAR(50),
  address TEXT,
  country VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id),
  is_active BOOLEAN DEFAULT TRUE
);

-- 数据处理协议表
CREATE TABLE data_processing_agreements (
  id SERIAL PRIMARY KEY,
  processor_id INTEGER NOT NULL REFERENCES data_processors(id),
  agreement_number VARCHAR(100) UNIQUE NOT NULL, -- DPA-2026-001
  title VARCHAR(255) NOT NULL,
  version VARCHAR(50),
  
  -- 协议日期
  signed_date DATE,
  effective_date DATE NOT NULL,
  expiry_date DATE,
  is_indefinite BOOLEAN DEFAULT FALSE,
  
  -- 协议状态
  status VARCHAR(50) DEFAULT 'draft', -- 'draft', 'pending_signature', 'active', 'expired', 'terminated'
  
  -- 数据处理详情
  data_categories TEXT[] NOT NULL, -- ['location', 'payment', 'device']
  processing_purposes TEXT[] NOT NULL, -- ['service_delivery', 'payment_processing']
  data_subjects TEXT[] NOT NULL, -- ['users', 'players']
  retention_period_days INTEGER,
  
  -- 安全措施
  security_measures TEXT,
  sub_processors TEXT, -- 子处理方列表（JSON）
  
  -- 文档存储路径
  document_path VARCHAR(500),
  document_hash VARCHAR(128),
  
  -- 审核信息
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id)
);

-- 协议变更历史
CREATE TABLE dpa_change_history (
  id SERIAL PRIMARY KEY,
  agreement_id INTEGER NOT NULL REFERENCES data_processing_agreements(id),
  action VARCHAR(100) NOT NULL, -- 'created', 'signed', 'expired', 'terminated', 'renewed'
  old_status VARCHAR(50),
  new_status VARCHAR(50),
  changed_by INTEGER REFERENCES users(id),
  change_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_dpa_processor ON data_processing_agreements(processor_id);
CREATE INDEX idx_dpa_status ON data_processing_agreements(status);
CREATE INDEX idx_dpa_expiry ON data_processing_agreements(expiry_date);
CREATE INDEX idx_dpa_number ON data_processing_agreements(agreement_number);

-- 注释
COMMENT ON TABLE data_processors IS 'GDPR Art.28 数据处理方（供应商）信息';
COMMENT ON TABLE data_processing_agreements IS 'GDPR Art.28 数据处理协议（DPA）';
COMMENT ON TABLE dpa_change_history IS '协议状态变更历史记录';
```

### 4.2 供应商管理服务

创建 `backend/shared/compliance/DataProcessorService.js`：

```javascript
/**
 * 数据处理方（供应商）管理服务
 * GDPR Art.28 合规
 */
class DataProcessorService {
  constructor(db) {
    this.db = db;
  }

  /**
   * 注册新供应商
   */
  async createProcessor(data, createdBy) {
    const result = await this.db.query(`
      INSERT INTO data_processors (
        name, type, contact_email, contact_phone, address, country, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      data.name, data.type, data.contactEmail, data.contactPhone,
      data.address, data.country, createdBy
    ]);

    await this.auditLog(result.rows[0].id, 'processor_created', null, null, createdBy);
    return result.rows[0];
  }

  /**
   * 获取供应商列表
   */
  async listProcessors(filters = {}) {
    let query = `
      SELECT dp.*, u.username as created_by_name
      FROM data_processors dp
      LEFT JOIN users u ON dp.created_by = u.id
      WHERE dp.is_active = TRUE
    `;
    const params = [];
    let paramCount = 1;

    if (filters.type) {
      query += ` AND dp.type = $${paramCount++}`;
      params.push(filters.type);
    }

    if (filters.search) {
      query += ` AND (dp.name ILIKE $${paramCount} OR dp.contact_email ILIKE $${paramCount})`;
      params.push(`%${filters.search}%`);
      paramCount++;
    }

    query += ' ORDER BY dp.created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramCount++}`;
      params.push(filters.limit);
    }

    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 获取供应商详情（含协议列表）
   */
  async getProcessorDetail(processorId) {
    const processorResult = await this.db.query(`
      SELECT * FROM data_processors WHERE id = $1
    `, [processorId]);

    if (processorResult.rows.length === 0) {
      return null;
    }

    const agreementsResult = await this.db.query(`
      SELECT id, agreement_number, title, status, effective_date, expiry_date
      FROM data_processing_agreements
      WHERE processor_id = $1
      ORDER BY effective_date DESC
    `, [processorId]);

    return {
      ...processorResult.rows[0],
      agreements: agreementsResult.rows
    };
  }

  /**
   * 更新供应商信息
   */
  async updateProcessor(processorId, updates, updatedBy) {
    const allowedFields = ['name', 'type', 'contact_email', 'contact_phone', 'address', 'country'];
    const setClauses = [];
    const params = [processorId];
    let paramCount = 2;

    for (const [key, value] of Object.entries(updates)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbKey)) {
        setClauses.push(`${dbKey} = $${paramCount++}`);
        params.push(value);
      }
    }

    if (setClauses.length === 0) {
      return null;
    }

    setClauses.push('updated_at = NOW()');

    const result = await this.db.query(`
      UPDATE data_processors
      SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING *
    `, params);

    return result.rows[0];
  }

  /**
   * 停用供应商
   */
  async deactivateProcessor(processorId, reason, deactivatedBy) {
    await this.db.query(`
      UPDATE data_processors SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1
    `, [processorId]);

    await this.auditLog(processorId, 'processor_deactivated', null, null, deactivatedBy, reason);
  }

  async auditLog(processorId, action, oldStatus, newStatus, userId, notes = null) {
    await this.db.query(`
      INSERT INTO compliance_audit_log (entity_type, entity_id, action, old_value, new_value, user_id, notes)
      VALUES ('data_processor', $1, $2, $3, $4, $5, $6)
    `, [processorId, action, oldStatus, newStatus, userId, notes]);
  }
}

module.exports = { DataProcessorService };
```

### 4.3 数据处理协议服务

创建 `backend/shared/compliance/DataProcessingAgreementService.js`：

```javascript
/**
 * 数据处理协议管理服务
 * GDPR Art.28 合规
 */
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class DataProcessingAgreementService {
  constructor(db, config = {}) {
    this.db = db;
    this.storagePath = config.storagePath || '/data/dpa-documents';
  }

  /**
   * 创建新协议
   */
  async createAgreement(data, createdBy) {
    const agreementNumber = await this.generateAgreementNumber();
    
    const result = await this.db.query(`
      INSERT INTO data_processing_agreements (
        processor_id, agreement_number, title, version,
        effective_date, expiry_date, is_indefinite,
        data_categories, processing_purposes, data_subjects,
        retention_period_days, security_measures, sub_processors,
        status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14)
      RETURNING *
    `, [
      data.processorId, agreementNumber, data.title, data.version,
      data.effectiveDate, data.expiryDate, data.isIndefinite || false,
      data.dataCategories, data.processingPurposes, data.dataSubjects,
      data.retentionPeriodDays, data.securityMeasures, JSON.stringify(data.subProcessors || []),
      createdBy
    ]);

    await this.logChange(result.rows[0].id, 'created', null, 'draft', createdBy);
    return result.rows[0];
  }

  /**
   * 生成协议编号
   */
  async generateAgreementNumber() {
    const year = new Date().getFullYear();
    const result = await this.db.query(`
      SELECT COUNT(*) + 1 as next_number
      FROM data_processing_agreements
      WHERE EXTRACT(YEAR FROM created_at) = $1
    `, [year]);

    const number = String(result.rows[0].next_number).padStart(3, '0');
    return `DPA-${year}-${number}`;
  }

  /**
   * 上传协议文档
   */
  async uploadDocument(agreementId, file, userId) {
    const agreement = await this.getAgreement(agreementId);
    if (!agreement) {
      throw new Error('协议不存在');
    }

    // 生成文件存储路径
    const fileName = `${agreement.agreement_number}_${Date.now()}${path.extname(file.name)}`;
    const filePath = path.join(this.storagePath, fileName);

    // 计算文件哈希
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // 保存文件
    await fs.mkdir(this.storagePath, { recursive: true });
    await fs.writeFile(filePath, file.buffer);

    // 更新数据库
    await this.db.query(`
      UPDATE data_processing_agreements
      SET document_path = $1, document_hash = $2, updated_at = NOW()
      WHERE id = $3
    `, [filePath, hash, agreementId]);

    await this.logChange(agreementId, 'document_uploaded', null, null, userId);

    return { path: filePath, hash };
  }

  /**
   * 标记协议已签署
   */
  async markSigned(agreementId, signedDate, userId) {
    const result = await this.db.query(`
      UPDATE data_processing_agreements
      SET signed_date = $1, status = 'active', updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [signedDate, agreementId]);

    await this.logChange(agreementId, 'signed', 'draft', 'active', userId);
    return result.rows[0];
  }

  /**
   * 获取协议详情
   */
  async getAgreement(agreementId) {
    const result = await this.db.query(`
      SELECT dpa.*, dp.name as processor_name, dp.type as processor_type
      FROM data_processing_agreements dpa
      JOIN data_processors dp ON dpa.processor_id = dp.id
      WHERE dpa.id = $1
    `, [agreementId]);

    return result.rows[0] || null;
  }

  /**
   * 获取即将到期的协议
   */
  async getExpiringAgreements(daysAhead = 90) {
    const result = await this.db.query(`
      SELECT dpa.*, dp.name as processor_name, dp.contact_email
      FROM data_processing_agreements dpa
      JOIN data_processors dp ON dpa.processor_id = dp.id
      WHERE dpa.status = 'active'
        AND dpa.is_indefinite = FALSE
        AND dpa.expiry_date <= CURRENT_DATE + INTERVAL '${daysAhead} days'
        AND dpa.expiry_date > CURRENT_DATE
      ORDER BY dpa.expiry_date ASC
    `);

    return result.rows;
  }

  /**
   * 检查并更新过期协议
   */
  async checkExpiredAgreements() {
    const result = await this.db.query(`
      UPDATE data_processing_agreements
      SET status = 'expired', updated_at = NOW()
      WHERE status = 'active'
        AND is_indefinite = FALSE
        AND expiry_date < CURRENT_DATE
      RETURNING id
    `);

    for (const row of result.rows) {
      await this.logChange(row.id, 'expired', 'active', 'expired', null, '自动标记过期');
    }

    return result.rows.length;
  }

  /**
   * 获取协议清单报告
   */
  async generateComplianceReport() {
    const result = await this.db.query(`
      SELECT 
        dp.name as processor_name,
        dp.type as processor_type,
        dpa.agreement_number,
        dpa.title,
        dpa.status,
        dpa.signed_date,
        dpa.effective_date,
        dpa.expiry_date,
        dpa.data_categories,
        dpa.processing_purposes
      FROM data_processing_agreements dpa
      JOIN data_processors dp ON dpa.processor_id = dp.id
      WHERE dp.is_active = TRUE
      ORDER BY dp.name, dpa.effective_date DESC
    `);

    const summary = {
      total: result.rows.length,
      active: result.rows.filter(r => r.status === 'active').length,
      draft: result.rows.filter(r => r.status === 'draft').length,
      expired: result.rows.filter(r => r.status === 'expired').length,
      expiringIn30Days: result.rows.filter(r => 
        r.status === 'active' && 
        r.expiry_date && 
        new Date(r.expiry_date) <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      ).length
    };

    return {
      generatedAt: new Date().toISOString(),
      summary,
      agreements: result.rows
    };
  }

  /**
   * 记录状态变更
   */
  async logChange(agreementId, action, oldStatus, newStatus, userId, reason = null) {
    await this.db.query(`
      INSERT INTO dpa_change_history (agreement_id, action, old_status, new_status, changed_by, change_reason)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [agreementId, action, oldStatus, newStatus, userId, reason]);
  }
}

module.exports = { DataProcessingAgreementService };
```

### 4.4 协议到期监控任务

创建 `backend/jobs/compliance/dpaExpiryMonitor.js`：

```javascript
/**
 * 数据处理协议到期监控定时任务
 */
const { DataProcessingAgreementService } = require('../../shared/compliance/DataProcessingAgreementService');
const logger = require('../../shared/logger').createLogger('dpa-monitor');

class DPAExpiryMonitor {
  constructor(db, alertingService) {
    this.dpaService = new DataProcessingAgreementService(db);
    this.alerting = alertingService;
  }

  async run() {
    logger.info('Starting DPA expiry monitoring');

    try {
      // 1. 检查并标记过期协议
      const expiredCount = await this.dpaService.checkExpiredAgreements();
      if (expiredCount > 0) {
        logger.warn(`${expiredCount} agreements marked as expired`);
      }

      // 2. 获取即将到期的协议（90天）
      const expiring90 = await this.dpaService.getExpiringAgreements(90);
      const expiring60 = await this.dpaService.getExpiringAgreements(60);
      const expiring30 = await this.dpaService.getExpiringAgreements(30);

      // 3. 发送告警
      if (expiring30.length > 0) {
        await this.sendUrgentAlert(expiring30, 30);
      }

      if (expiring60.length > 0) {
        await this.sendWarningAlert(expiring60, 60);
      }

      if (expiring90.length > 0) {
        await this.sendNoticeAlert(expiring90, 90);
      }

      logger.info('DPA monitoring completed', {
        expiring30: expiring30.length,
        expiring60: expiring60.length,
        expiring90: expiring90.length
      });
    } catch (error) {
      logger.error({ error: error.message }, 'DPA monitoring failed');
    }
  }

  async sendUrgentAlert(agreements, days) {
    await this.alerting.sendAdminAlert({
      type: 'dpa_expiry_urgent',
      severity: 'high',
      subject: `[紧急] ${agreements.length} 份数据处理协议将在 ${days} 天内到期`,
      message: agreements.map(a => 
        `- ${a.processor_name}: ${a.agreement_number} (到期: ${a.expiry_date})`
      ).join('\n'),
      agreements
    });
  }

  async sendWarningAlert(agreements, days) {
    await this.alerting.sendTeamAlert({
      type: 'dpa_expiry_warning',
      severity: 'medium',
      subject: `[警告] ${agreements.length} 份数据处理协议将在 ${days} 天内到期`,
      message: '请及时联系供应商续签协议'
    });
  }

  async sendNoticeAlert(agreements, days) {
    await this.alerting.sendTeamAlert({
      type: 'dpa_expiry_notice',
      severity: 'low',
      subject: `[通知] ${agreements.length} 份数据处理协议将在 ${days} 天内到期`,
      message: '请提前规划协议续签事宜'
    });
  }
}

// 定时任务入口
async function startMonitoring(db, alerting) {
  const monitor = new DPAExpiryMonitor(db, alerting);

  // 每天凌晨 2 点执行
  const cron = require('node-cron');
  cron.schedule('0 2 * * *', () => monitor.run());

  // 启动时执行一次
  await monitor.run();
}

module.exports = { DPAExpiryMonitor, startMonitoring };
```

## 5. 验收标准（可测试）

- [ ] 数据库迁移成功执行（3 张表 + 索引）
- [ ] DataProcessorService 所有方法单元测试通过
- [ ] DataProcessingAgreementService 所有方法单元测试通过
- [ ] 协议文档上传功能测试通过（PDF/Docx）
- [ ] 协议到期监控任务运行正常
- [ ] 90/60/30 天告警发送测试通过
- [ ] 合规报告生成功能测试通过
- [ ] 审计日志记录完整
- [ ] 管理后台协议列表页面可访问

## 6. 工作量估算

**L（Large）** - 约 14-18 小时

**理由：**
- 数据库设计与迁移（2h）
- 供应商管理服务（2-3h）
- 协议管理服务（3-4h）
- 文档上传与存储（2h）
- 到期监控任务（2h）
- API 路由与管理后台（2-3h）
- 单元测试与集成测试（3h）

## 7. 优先级理由

**P1 理由：**

1. **法律合规要求**：GDPR Art.28 强制要求，缺失将导致重大合规风险
2. **监管审计必要**：监管机构可能随时要求提供数据处理协议证据
3. **供应商管理基础**：没有 DPA 管理系统，无法证明数据处理合规
4. **补充现有功能**：隐私偏好管理已完成，DPA 管理是必要补充

**不为 P0 的原因：**
- 当前无监管压力，可优先级稍低于生产阻塞问题
- 系统仍可正常运行，此为合规增强功能
