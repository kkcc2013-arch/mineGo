/**
 * REQ-00485: 安全导出服务
 * 整合限流、审批、脱敏、异常检测的导出服务
 */

const GDPRService = require('../../gdprService');
const ExportRateLimiter = require('../middleware/exportRateLimiter');
const ExportApprovalWorkflow = require('../workflows/exportApprovalWorkflow');
const DataMaskingEngine = require('../utils/dataMaskingEngine');
const ExportAnomalyDetector = require('../detection/exportAnomalyDetector');

class SecureExportService {
  constructor(db, redis, eventBus, notificationService) {
    this.db = db;
    this.redis = redis;
    this.eventBus = eventBus;
    this.notificationService = notificationService;
    
    // 初始化组件
    this.rateLimiter = new ExportRateLimiter(redis, db);
    this.approvalWorkflow = new ExportApprovalWorkflow(db, eventBus, notificationService);
    this.maskingEngine = new DataMaskingEngine();
    this.anomalyDetector = new ExportAnomalyDetector(redis, db);
    
    // 原有GDPR服务
    this.gdprService = new GDPRService(db, eventBus);
  }

  /**
   * 安全导出用户数据
   * @param {number} userId - 用户ID
   * @param {string} requesterRole - 请求者角色
   */
  async secureExportUserData(userId, requesterRole = 'user') {
    // 1. 检查频率限制
    const limitCheck = await this.rateLimiter.checkUserExportLimit(userId);
    
    if (!limitCheck.allowed) {
      return {
        success: false,
        error: limitCheck.reason,
        message: limitCheck.message,
        nextAvailableAt: limitCheck.nextAvailableAt
      };
    }
    
    // 2. 异常检测
    const anomalyCheck = await this.anomalyDetector.detect(userId);
    
    if (anomalyCheck.riskScore >= 80) {
      return {
        success: false,
        error: 'HIGH_RISK_BLOCKED',
        message: '导出请求因安全风险被阻止，请联系客服',
        riskScore: anomalyCheck.riskScore,
        anomalies: anomalyCheck.anomalies
      };
    }
    
    // 3. 执行导出
    const requestId = this.rateLimiter.generateRequestId();
    
    await this.rateLimiter.recordUserExport(userId, requestId);
    await this.anomalyDetector.recordExportActivity(userId);
    
    try {
      // 获取原始数据
      const rawData = await this.gdprService.exportUserData(userId);
      
      // 4. 脱敏处理
      const maskedData = this.maskingEngine.maskExportData(rawData, requesterRole);
      
      // 5. 记录完成状态
      await this.rateLimiter.updateExportStatus(requestId, 'completed');
      
      // 6. 发布事件
      if (this.eventBus) {
        await this.eventBus.publish('export.completed', {
          requestId,
          userId,
          requesterRole,
          masked: true
        });
      }
      
      return {
        success: true,
        requestId,
        data: maskedData,
        exportDate: maskedData.exportDate,
        remainingExports: limitCheck.remaining - 1
      };
      
    } catch (error) {
      await this.rateLimiter.updateExportStatus(requestId, 'failed', null, error.message);
      
      return {
        success: false,
        error: 'EXPORT_FAILED',
        message: error.message,
        requestId
      };
    }
  }

  /**
   * 申请批量导出（管理员）
   * @param {number} adminId - 管理员ID
   * @param {object} request - 申请详情
   */
  async submitBatchExportRequest(adminId, request) {
    const { userIds, reason, filters } = request;
    
    // 1. 检查数量限制
    const limitCheck = await this.rateLimiter.checkAdminExportLimit(adminId, userIds.length);
    
    if (!limitCheck.allowed) {
      return {
        success: false,
        error: limitCheck.reason,
        message: limitCheck.message
      };
    }
    
    // 2. 异常检测
    const anomalyCheck = await this.anomalyDetector.detect(adminId, true);
    
    if (anomalyCheck.riskScore >= 80) {
      return {
        success: false,
        error: 'HIGH_RISK_BLOCKED',
        message: '批量导出请求因安全风险被阻止',
        riskScore: anomalyCheck.riskScore,
        anomalies: anomalyCheck.anomalies
      };
    }
    
    // 3. 提交审批申请
    const approvalResult = await this.approvalWorkflow.submitExportRequest(adminId, {
      userIds,
      reason,
      filters
    });
    
    return {
      success: true,
      requestId: approvalResult.requestId,
      status: approvalResult.status,
      approvalLevel: approvalResult.approvalLevel,
      requiredApprovers: approvalResult.requiredApprovers,
      message: '批量导出申请已提交，等待审批'
    };
  }

  /**
   * 执行已批准的批量导出
   * @param {number} requestId - 申请ID
   */
  async executeBatchExport(requestId) {
    // 获取申请详情
    const request = await this.approvalWorkflow.getRequestDetails(requestId);
    
    if (!request) {
      return {
        success: false,
        error: 'REQUEST_NOT_FOUND',
        message: '导出申请不存在'
      };
    }
    
    if (request.status !== 'approved') {
      return {
        success: false,
        error: 'NOT_APPROVED',
        message: '导出申请尚未获得批准'
      };
    }
    
    const userIds = request.user_ids;
    const adminId = request.admin_id;
    
    // 执行导出
    const results = [];
    const errors = [];
    
    for (const userId of userIds) {
      try {
        const rawData = await this.gdprService.exportUserData(userId);
        const maskedData = this.maskingEngine.maskExportData(rawData, 'admin');
        
        results.push({
          userId,
          data: maskedData,
          success: true
        });
      } catch (error) {
        errors.push({
          userId,
          error: error.message,
          success: false
        });
      }
    }
    
    // 发布完成事件
    if (this.eventBus) {
      await this.eventBus.publish('export.batch.completed', {
        requestId,
        adminId,
        totalCount: userIds.length,
        successCount: results.length,
        errorCount: errors.length
      });
    }
    
    return {
      success: true,
      requestId,
      results,
      errors,
      summary: {
        total: userIds.length,
        successful: results.length,
        failed: errors.length
      }
    };
  }

  /**
   * 审批导出请求
   */
  async approveExportRequest(requestId, approverId, comment) {
    return await this.approvalWorkflow.approveExportRequest(requestId, approverId, comment);
  }

  /**
   * 拒绝导出请求
   */
  async rejectExportRequest(requestId, approverId, reason) {
    return await this.approvalWorkflow.rejectExportRequest(requestId, approverId, reason);
  }

  /**
   * 获取用户导出历史
   */
  async getUserExportHistory(userId) {
    return await this.rateLimiter.getUserExportHistory(userId);
  }

  /**
   * 获取待审批列表
   */
  async getPendingRequests(limit, offset) {
    return await this.approvalWorkflow.getPendingRequests(limit, offset);
  }

  /**
   * 获取最近异常
   */
  async getRecentAnomalies(limit) {
    return await this.anomalyDetector.getRecentAnomalies(limit);
  }

  /**
   * 获取高风险用户
   */
  async getHighRiskUsers(limit) {
    return await this.anomalyDetector.getHighRiskUsers(limit);
  }

  /**
   * 初始化数据库表
   */
  async initializeTables() {
    await this.rateLimiter._createAuditTableIfNeeded();
    await this.approvalWorkflow.ensureTablesExist();
    await this.anomalyDetector._ensureAnomalyTableExists();
  }
}

module.exports = SecureExportService;