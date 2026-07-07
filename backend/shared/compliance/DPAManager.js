// backend/shared/compliance/DPAManager.js - 数据处理协议管理系统
'use strict';

const db = require('../db');
const EventBus = require('../EventBus');
const logger = require('../logger');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

/**
 * 第三方数据处理协议（DPA）管理器
 * 管理与供应商的数据处理协议生命周期
 */
class DPAManager {
  constructor() {
    this.uploadDir = process.env.DPA_UPLOAD_DIR || './uploads/dpa';
    this.alertThresholdDays = [90, 60, 30]; // 协议到期提醒阈值
  }

  /**
   * 注册数据处理供应商
   * @param {Object} vendorData - 供应商信息
   * @returns {Promise<Object>} - 创建的供应商记录
   */
  async registerVendor(vendorData) {
    const {
      name,
      type, // cloud_provider, payment_gateway, push_service, analytics, etc.
      contact_email,
      contact_phone,
      country,
      data_types_processed, // ['personal_data', 'payment_data', 'location_data']
      processing_purpose,
      data_residency_countries,
      contract_reference,
      notes
    } = vendorData;

    const result = await db.query(`
      INSERT INTO dpa_vendors (
        name, type, contact_email, contact_phone, country,
        data_types_processed, processing_purpose, data_residency_countries,
        contract_reference, notes, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW())
      RETURNING *
    `, [
      name, type, contact_email, contact_phone, country,
      JSON.stringify(data_types_processed), processing_purpose,
      JSON.stringify(data_residency_countries), contract_reference, notes
    ]);

    // 发布供应商注册事件
    await EventBus.emit('dpa.vendor_registered', {
      vendor_id: result.rows[0].id,
      vendor_name: name,
      timestamp: new Date().toISOString()
    });

    logger.info('DPA vendor registered', { vendor_id: result.rows[0].id, name });
    return result.rows[0];
  }

  /**
   * 上传数据处理协议文档
   * @param {number} vendorId - 供应商ID
   * @param {Object} agreementData - 协议信息
   * @param {Buffer} documentBuffer - 协议文档内容
   * @returns {Promise<Object>} - 协议记录
   */
  async uploadAgreement(vendorId, agreementData, documentBuffer) {
    const {
      agreement_type, // standard_dpa, custom_dpa, privacy_addendum
      effective_date,
      expiry_date,
      signatory_name,
      signatory_title,
      signed_date,
      version,
      summary,
      special_conditions
    } = agreementData;

    // 生成文档存储路径
    const documentHash = crypto.createHash('sha256').update(documentBuffer).digest('hex');
    const fileName = `dpa_${vendorId}_${Date.now()}_${documentHash.slice(0, 8)}.pdf`;
    const filePath = path.join(this.uploadDir, fileName);

    // 确保上传目录存在
    await fs.mkdir(this.uploadDir, { recursive: true });

    // 存储文档
    await fs.writeFile(filePath, documentBuffer);

    // 创建协议记录
    const result = await db.query(`
      INSERT INTO dpa_agreements (
        vendor_id, agreement_type, document_path, document_hash,
        effective_date, expiry_date, signatory_name, signatory_title,
        signed_date, version, summary, special_conditions, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending_approval', NOW())
      RETURNING *
    `, [
      vendorId, agreement_type, filePath, documentHash,
      effective_date, expiry_date, signatory_name, signatory_title,
      signed_date, version, summary, JSON.stringify(special_conditions || [])
    ]);

    // 更新供应商状态
    await db.query(`
      UPDATE dpa_vendors SET status = 'agreement_pending', updated_at = NOW()
      WHERE id = $1
    `, [vendorId]);

    // 发布协议上传事件
    await EventBus.emit('dpa.agreement_uploaded', {
      agreement_id: result.rows[0].id,
      vendor_id: vendorId,
      expiry_date: expiry_date,
      timestamp: new Date().toISOString()
    });

    logger.info('DPA agreement uploaded', {
      agreement_id: result.rows[0].id,
      vendor_id: vendorId,
      expiry_date
    });

    return result.rows[0];
  }

  /**
   * 审批数据处理协议
   * @param {number} agreementId - 协议ID
   * @param {number} approverId - 审批人ID
   * @param {string} approvalStatus - approved/rejected
   * @param {string} comments - 审批意见
   * @returns {Promise<Object>} - 更新的协议记录
   */
  async approveAgreement(agreementId, approverId, approvalStatus, comments) {
    const result = await db.query(`
      UPDATE dpa_agreements 
      SET status = $1, approved_by = $2, approved_at = NOW(), approval_comments = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING *
    `, [approvalStatus, approverId, comments, agreementId]);

    if (approvalStatus === 'approved') {
      // 更新供应商状态为已签署协议
      await db.query(`
        UPDATE dpa_vendors 
        SET status = 'agreement_active', updated_at = NOW()
        WHERE id = $1
      `, [result.rows[0].vendor_id]);

      // 记录审批历史
      await this.recordChangeHistory(agreementId, 'approval', null, approvalStatus, approverId, comments);

      // 检查是否需要设置到期提醒
      await this.setupExpiryAlert(result.rows[0]);
    }

    // 发布审批事件
    await EventBus.emit('dpa.agreement_approved', {
      agreement_id: agreementId,
      vendor_id: result.rows[0].vendor_id,
      status: approvalStatus,
      approver_id: approverId,
      timestamp: new Date().toISOString()
    });

    logger.info('DPA agreement approved', {
      agreement_id: agreementId,
      status: approvalStatus,
      approver_id: approverId
    });

    return result.rows[0];
  }

  /**
   * 获取供应商列表
   * @param {Object} filters - 筛选条件
   * @returns {Promise<Array>} - 供应商列表
   */
  async getVendors(filters = {}) {
    const { status, type, search } = filters;

    let query = `
      SELECT v.*, 
        COUNT(a.id) as agreement_count,
        MAX(a.expiry_date) as latest_expiry,
        MAX(a.status) as latest_agreement_status
      FROM dpa_vendors v
      LEFT JOIN dpa_agreements a ON v.id = a.vendor_id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND v.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (type) {
      query += ` AND v.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (search) {
      query += ` AND (v.name ILIKE $${paramIndex} OR v.contact_email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` GROUP BY v.id ORDER BY v.created_at DESC`;

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * 获取协议详情
   * @param {number} agreementId - 协议ID
   * @returns {Promise<Object>} - 协议详情
   */
  async getAgreementDetails(agreementId) {
    const result = await db.query(`
      SELECT a.*, v.name as vendor_name, v.type as vendor_type, v.contact_email
      FROM dpa_agreements a
      JOIN dpa_vendors v ON a.vendor_id = v.id
      WHERE a.id = $1
    `, [agreementId]);

    if (result.rows.length === 0) {
      throw new Error('Agreement not found');
    }

    return result.rows[0];
  }

  /**
   * 获取协议文档
   * @param {number} agreementId - 协议ID
   * @returns {Promise<Buffer>} - 文档内容
   */
  async getAgreementDocument(agreementId) {
    const agreement = await this.getAgreementDetails(agreementId);

    if (!agreement.document_path) {
      throw new Error('No document attached to this agreement');
    }

    const documentBuffer = await fs.readFile(agreement.document_path);
    return documentBuffer;
  }

  /**
   * 检查即将到期的协议
   * @returns {Promise<Array>} - 即将到期的协议列表
   */
  async checkExpiringAgreements() {
    const alerts = [];

    for (const thresholdDays of this.alertThresholdDays) {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + thresholdDays);

      const result = await db.query(`
        SELECT a.*, v.name as vendor_name, v.type as vendor_type, v.contact_email
        FROM dpa_agreements a
        JOIN dpa_vendors v ON a.vendor_id = v.id
        WHERE a.status = 'approved'
        AND a.expiry_date <= $1
        AND a.expiry_date > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM dpa_expiry_alerts e 
          WHERE e.agreement_id = a.id 
          AND e.alert_days = $2
          AND e.created_at > NOW() - INTERVAL '7 days'
        )
        ORDER BY a.expiry_date ASC
      `, [expiryDate, thresholdDays]);

      for (const agreement of result.rows) {
        alerts.push({
          agreement,
          threshold_days: thresholdDays,
          days_remaining: Math.ceil((new Date(agreement.expiry_date) - new Date()) / (1000 * 60 * 60 * 24))
        });

        // 记录已发送提醒，避免重复
        await db.query(`
          INSERT INTO dpa_expiry_alerts (agreement_id, alert_days, created_at)
          VALUES ($1, $2, NOW())
        `, [agreement.id, thresholdDays]);
      }
    }

    if (alerts.length > 0) {
      // 发布到期提醒事件
      await EventBus.emit('dpa.agreements_expiring', {
        alerts_count: alerts.length,
        alerts: alerts.map(a => ({
          agreement_id: a.agreement.id,
          vendor_name: a.agreement.vendor_name,
          days_remaining: a.days_remaining
        })),
        timestamp: new Date().toISOString()
      });

      logger.warn('DPA agreements expiring', { count: alerts.length });
    }

    return alerts;
  }

  /**
   * 生成合规报告
   * @returns {Promise<Object>} - DPA合规报告
   */
  async generateComplianceReport() {
    // 供应商统计
    const vendorStats = await db.query(`
      SELECT status, COUNT(*) as count
      FROM dpa_vendors
      GROUP BY status
    `);

    // 协议统计
    const agreementStats = await db.query(`
      SELECT status, COUNT(*) as count
      FROM dpa_agreements
      GROUP BY status
    `);

    // 即将到期协议
    const expiringAgreements = await db.query(`
      SELECT a.id, a.expiry_date, v.name as vendor_name
      FROM dpa_agreements a
      JOIN dpa_vendors v ON a.vendor_id = v.id
      WHERE a.status = 'approved'
      AND a.expiry_date <= NOW() + INTERVAL '90 days'
      ORDER BY a.expiry_date ASC
    `);

    // 已过期协议
    const expiredAgreements = await db.query(`
      SELECT a.id, a.expiry_date, v.name as vendor_name
      FROM dpa_agreements a
      JOIN dpa_vendors v ON a.vendor_id = v.id
      WHERE a.status = 'approved'
      AND a.expiry_date < NOW()
    `);

    // 数据类型处理统计
    const dataTypeStats = await db.query(`
      SELECT jsonb_array_elements_text(data_types_processed) as data_type, COUNT(*) as count
      FROM dpa_vendors
      GROUP BY data_type
    `);

    return {
      generated_at: new Date().toISOString(),
      vendor_summary: vendorStats.rows,
      agreement_summary: agreementStats.rows,
      expiring_agreements: expiringAgreements.rows,
      expired_agreements: expiredAgreements.rows,
      data_type_distribution: dataTypeStats.rows,
      compliance_score: this.calculateComplianceScore(vendorStats.rows, agreementStats.rows, expiredAgreements.rows.length)
    };
  }

  /**
   * 计算合规评分
   */
  calculateComplianceScore(vendorStats, agreementStats, expiredCount) {
    const totalVendors = vendorStats.reduce((sum, v) => sum + parseInt(v.count), 0);
    const activeVendors = vendorStats.find(v => v.status === 'agreement_active')?.count || 0;
    const approvedAgreements = agreementStats.find(a => a.status === 'approved')?.count || 0;

    // 基础分：已签署协议供应商占比
    let score = (activeVendors / totalVendors) * 50;

    // 扣分：过期协议
    score -= expiredCount * 5;

    // 加分：已审批协议数量
    score += Math.min(approvedAgreements * 2, 30);

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 记录变更历史
   */
  async recordChangeHistory(agreementId, action, oldStatus, newStatus, changedBy, reason) {
    await db.query(`
      INSERT INTO dpa_change_history (agreement_id, action, old_status, new_status, changed_by, change_reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [agreementId, action, oldStatus, newStatus, changedBy, reason]);
  }

  /**
   * 设置到期提醒
   */
  async setupExpiryAlert(agreement) {
    const expiryDate = new Date(agreement.expiry_date);
    const now = new Date();

    for (const thresholdDays of this.alertThresholdDays) {
      const alertDate = new Date(expiryDate);
      alertDate.setDate(alertDate.getDate() - thresholdDays);

      if (alertDate > now) {
        // 创建定时提醒（通过 cron 或事件系统）
        await EventBus.emit('dpa.alert_schedule', {
          agreement_id: agreement.id,
          vendor_id: agreement.vendor_id,
          alert_date: alertDate.toISOString(),
          threshold_days: thresholdDays
        });
      }
    }
  }
}

module.exports = DPAManager;