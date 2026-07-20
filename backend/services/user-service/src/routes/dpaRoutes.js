// backend/services/user-service/src/routes/dpaRoutes.js
// REQ-00467: 第三方数据处理协议管理系统路由

'use strict';

const express = require('express');
const router = express.Router();
const DPAManager = require('../../../../shared/compliance/DPAManager');
const { authenticate, requireAdmin } = require('../../../../shared/middleware/auth');
const multer = require('multer');
const path = require('path');

const dpaManager = new DPAManager();

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = process.env.DPA_UPLOAD_DIR || './uploads/dpa';
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'dpa-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 最大10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname);
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 PDF、DOC、DOCX 格式文档'));
    }
  }
});

// ==================== 供应商管理 ====================

/**
 * POST /dpa/vendors
 * 注册新的数据处理供应商（管理员）
 */
router.post('/vendors', authenticate, requireAdmin, async (req, res) => {
  try {
    const vendorData = req.body;

    // 验证必要字段
    const requiredFields = ['name', 'type', 'contact_email', 'country', 'data_types_processed', 'processing_purpose'];
    for (const field of requiredFields) {
      if (!vendorData[field]) {
        return res.status(400).json({
          code: 400,
          message: `缺少必要字段: ${field}`
        });
      }
    }

    const vendor = await dpaManager.registerVendor(vendorData);

    res.status(201).json({
      code: 200,
      message: '供应商注册成功',
      data: vendor
    });
  } catch (error) {
    console.error('注册供应商失败:', error);
    res.status(500).json({
      code: 500,
      message: '注册供应商失败: ' + error.message
    });
  }
});

/**
 * GET /dpa/vendors
 * 获取供应商列表
 */
router.get('/vendors', authenticate, async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      type: req.query.type,
      search: req.query.search
    };

    const vendors = await dpaManager.getVendors(filters);

    res.json({
      code: 200,
      data: vendors,
      total: vendors.length
    });
  } catch (error) {
    console.error('获取供应商列表失败:', error);
    res.status(500).json({
      code: 500,
      message: '获取供应商列表失败'
    });
  }
});

/**
 * GET /dpa/vendors/:id
 * 获取供应商详情
 */
router.get('/vendors/:id', authenticate, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.id);

    const result = await dpaManager.getVendors({ id: vendorId });
    if (!result.length) {
      return res.status(404).json({
        code: 404,
        message: '供应商不存在'
      });
    }

    res.json({
      code: 200,
      data: result[0]
    });
  } catch (error) {
    console.error('获取供应商详情失败:', error);
    res.status(500).json({
      code: 500,
      message: '获取供应商详情失败'
    });
  }
});

// ==================== 协议管理 ====================

/**
 * POST /dpa/agreements/upload
 * 上传数据处理协议文档（管理员）
 */
router.post('/agreements/upload', authenticate, requireAdmin, upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        code: 400,
        message: '请上传协议文档'
      });
    }

    const agreementData = {
      vendor_id: parseInt(req.body.vendor_id),
      agreement_type: req.body.agreement_type || 'standard_dpa',
      effective_date: req.body.effective_date,
      expiry_date: req.body.expiry_date,
      signatory_name: req.body.signatory_name,
      signatory_title: req.body.signatory_title,
      signed_date: req.body.signed_date,
      version: req.body.version || '1.0',
      summary: req.body.summary,
      special_conditions: req.body.special_conditions ? JSON.parse(req.body.special_conditions) : []
    };

    // 验证必要字段
    const requiredFields = ['vendor_id', 'effective_date', 'signatory_name', 'signed_date'];
    for (const field of requiredFields) {
      if (!agreementData[field]) {
        return res.status(400).json({
          code: 400,
          message: `缺少必要字段: ${field}`
        });
      }
    }

    const agreement = await dpaManager.uploadAgreement(
      agreementData.vendor_id,
      agreementData,
      req.file.buffer || await require('fs').promises.readFile(req.file.path)
    );

    res.status(201).json({
      code: 200,
      message: '协议上传成功，等待审批',
      data: agreement
    });
  } catch (error) {
    console.error('上传协议失败:', error);
    res.status(500).json({
      code: 500,
      message: '上传协议失败: ' + error.message
    });
  }
});

/**
 * POST /dpa/agreements/:id/approve
 * 审批协议（管理员）
 */
router.post('/agreements/:id/approve', authenticate, requireAdmin, async (req, res) => {
  try {
    const agreementId = parseInt(req.params.id);
    const { approval_status, comments } = req.body;

    if (!['approved', 'rejected'].includes(approval_status)) {
      return res.status(400).json({
        code: 400,
        message: '审批状态必须为 approved 或 rejected'
      });
    }

    const agreement = await dpaManager.approveAgreement(
      agreementId,
      req.user.id,
      approval_status,
      comments || ''
    );

    res.json({
      code: 200,
      message: `协议已${approval_status === 'approved' ? '审批通过' : '被拒绝'}`,
      data: agreement
    });
  } catch (error) {
    console.error('审批协议失败:', error);
    res.status(500).json({
      code: 500,
      message: '审批协议失败: ' + error.message
    });
  }
});

/**
 * GET /dpa/agreements/:id
 * 获取协议详情
 */
router.get('/agreements/:id', authenticate, async (req, res) => {
  try {
    const agreementId = parseInt(req.params.id);
    const agreement = await dpaManager.getAgreementDetails(agreementId);

    res.json({
      code: 200,
      data: agreement
    });
  } catch (error) {
    console.error('获取协议详情失败:', error);
    if (error.message === 'Agreement not found') {
      return res.status(404).json({
        code: 404,
        message: '协议不存在'
      });
    }
    res.status(500).json({
      code: 500,
      message: '获取协议详情失败'
    });
  }
});

/**
 * GET /dpa/agreements/:id/document
 * 下载协议文档（管理员）
 */
router.get('/agreements/:id/document', authenticate, requireAdmin, async (req, res) => {
  try {
    const agreementId = parseInt(req.params.id);
    const agreement = await dpaManager.getAgreementDetails(agreementId);
    const documentBuffer = await dpaManager.getAgreementDocument(agreementId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dpa_${agreementId}.pdf"`);
    res.send(documentBuffer);
  } catch (error) {
    console.error('下载协议文档失败:', error);
    res.status(500).json({
      code: 500,
      message: '下载协议文档失败: ' + error.message
    });
  }
});

// ==================== 合规报告 ====================

/**
 * GET /dpa/compliance/report
 * 生成DPA合规报告（管理员）
 */
router.get('/compliance/report', authenticate, requireAdmin, async (req, res) => {
  try {
    const report = await dpaManager.generateComplianceReport();

    res.json({
      code: 200,
      data: report
    });
  } catch (error) {
    console.error('生成合规报告失败:', error);
    res.status(500).json({
      code: 500,
      message: '生成合规报告失败'
    });
  }
});

/**
 * GET /dpa/compliance/expiring
 * 检查即将到期的协议
 */
router.get('/compliance/expiring', authenticate, async (req, res) => {
  try {
    const expiring = await dpaManager.checkExpiringAgreements();

    res.json({
      code: 200,
      data: expiring,
      total: expiring.length
    });
  } catch (error) {
    console.error('检查到期协议失败:', error);
    res.status(500).json({
      code: 500,
      message: '检查到期协议失败'
    });
  }
});

/**
 * GET /dpa/compliance/view
 * 查看合规视图
 */
router.get('/compliance/view', authenticate, async (req, res) => {
  try {
    const result = await require('../../../../shared/db').query(`
      SELECT * FROM dpa_compliance_view ORDER BY expiry_status, latest_expiry DESC
    `);

    res.json({
      code: 200,
      data: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    console.error('获取合规视图失败:', error);
    res.status(500).json({
      code: 500,
      message: '获取合规视图失败'
    });
  }
});

module.exports = { router };