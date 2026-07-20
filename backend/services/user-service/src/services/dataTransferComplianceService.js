/**
 * REQ-00089: 数据跨境传输合规服务
 * 处理用户数据区域映射、跨境传输请求审批、传输日志记录
 */

const logger = require('../../../../shared/logger');
const { publishEvent } = require('../../../../shared/EventBus');

// 数据区域配置（缓存）
const DataRegions = {
  'EU': { countries: ['DE','FR','IT','ES','NL','BE','AT','PT','IE','SE','DK','FI','GR','PL','CZ','HU','RO','BG','HR','SI','SK','EE','LV','LT','LU','MT','CY'], storage: 'eu-west-1', laws: ['GDPR'] },
  'CN': { countries: ['CN'], storage: 'cn-east-1', laws: ['PIPL', 'DSL'] },
  'US': { countries: ['US','CA'], storage: 'us-east-1', laws: ['CCPA'] },
  'RU': { countries: ['RU'], storage: 'ru-central-1', laws: ['RU_DATA_LOCALIZATION'] },
  'JP': { countries: ['JP'], storage: 'ap-northeast-1', laws: ['APPI'] },
  'GB': { countries: ['GB'], storage: 'eu-west-2', laws: ['UK_GDPR'] },
  'ROW': { countries: ['*'], storage: 'us-east-1', laws: [] }
};

// 法律依据类型
const LegalBasis = {
  CONSENT: 'consent',
  CONTRACT: 'contract',
  LEGITIMATE_INTEREST: 'legitimate_interest',
  PUBLIC_INTEREST: 'public_interest',
  VITAL_INTEREST: 'vital_interest',
  LEGAL_OBLIGATION: 'legal_obligation'
};

// 传输状态
const TransferStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTED: 'executed',
  CANCELLED: 'cancelled'
};

class DataTransferComplianceService {
  constructor(db) {
    this.db = db;
  }

  /**
   * 根据IP地址检测用户所属数据区域
   * @param {string} ipAddress - 用户IP地址
   * @param {string} countryCode - 国家代码（可选，优先使用）
   * @returns {Promise<Object>} 区域信息
   */
  async detectUserRegion(ipAddress, countryCode = null) {
    let country = countryCode;
    
    // 如果没有提供国家代码，尝试从IP获取
    if (!country && ipAddress) {
      country = await this.getCountryFromIP(ipAddress);
    }
    
    if (!country) {
      return { region: 'ROW', reason: 'unknown_location' };
    }
    
    // 遍历区域配置，查找匹配的国家
    for (const [regionCode, regionConfig] of Object.entries(DataRegions)) {
      if (regionConfig.countries.includes(country)) {
        return {
          region: regionCode,
          storage: regionConfig.storage,
          laws: regionConfig.laws,
          reason: 'country_match'
        };
      }
    }
    
    // 默认返回 ROW
    return { region: 'ROW', storage: 'us-east-1', laws: [], reason: 'default' };
  }

  /**
   * 从IP地址获取国家代码（简化实现）
   */
  async getCountryFromIP(ipAddress) {
    // 实际项目中应集成 GeoIP 服务
    // 这里返回 null 使用默认值
    try {
      const result = await this.db.query(
        'SELECT country_code FROM ip_country_mappings WHERE $1::inet <<= ip_range LIMIT 1',
        [ipAddress]
      );
      return result.rows[0]?.country_code || null;
    } catch (err) {
      logger.warn({ err, ipAddress }, 'Failed to detect country from IP');
      return null;
    }
  }

  /**
   * 为用户分配数据存储区域
   * @param {number} userId - 用户ID
   * @param {string} regionCode - 区域代码
   * @param {Object} options - 选项
   */
  async assignUserRegion(userId, regionCode, options = {}) {
    const { reason = 'ip_detection', ipAddress = null, assignedBy = null } = options;
    
    // 验证区域代码
    const regionCheck = await this.db.query(
      'SELECT region_code FROM data_regions WHERE region_code = $1 AND is_active = true',
      [regionCode]
    );
    
    if (regionCheck.rows.length === 0) {
      throw new Error(`Invalid or inactive region: ${regionCode}`);
    }
    
    // 插入或更新用户区域映射
    const result = await this.db.query(
      `INSERT INTO user_data_regions (user_id, region_code, assignment_reason, ip_address_at_assignment, assigned_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) 
       DO UPDATE SET region_code = $2, assignment_reason = $3, ip_address_at_assignment = $4, assigned_by = $5, assigned_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId, regionCode, reason, ipAddress, assignedBy]
    );
    
    // 发布事件
    await publishEvent('user.region.assigned', {
      userId,
      regionCode,
      reason,
      timestamp: new Date().toISOString()
    });
    
    logger.info({ userId, regionCode, reason }, 'User data region assigned');
    
    return result.rows[0];
  }

  /**
   * 获取用户数据区域
   */
  async getUserRegion(userId) {
    const result = await this.db.query(
      `SELECT udr.*, dr.storage_location, dr.applicable_laws 
       FROM user_data_regions udr
       JOIN data_regions dr ON udr.region_code = dr.region_code
       WHERE udr.user_id = $1`,
      [userId]
    );
    
    return result.rows[0] || null;
  }

  /**
   * 创建跨境传输请求
   * @param {Object} request - 传输请求数据
   */
  async createTransferRequest(request) {
    const {
      requesterId,
      sourceRegion,
      targetRegion,
      dataTypes,
      legalBasis,
      purpose,
      recipientInfo = {},
      dataSubjectsAffected = 0
    } = request;
    
    // 验证源和目标区域不同
    if (sourceRegion === targetRegion) {
      throw new Error('Source and target regions must be different');
    }
    
    // 验证法律依据
    if (!Object.values(LegalBasis).includes(legalBasis)) {
      throw new Error(`Invalid legal basis: ${legalBasis}`);
    }
    
    // 检查是否需要SCC
    const sccRequired = await this.checkSCCRequirement(sourceRegion, targetRegion);
    let sccReference = null;
    
    if (sccRequired) {
      const sccResult = await this.db.query(
        `SELECT scc_code FROM standard_contractual_clauses 
         WHERE $1 = ANY(applicable_transfers) AND is_active = true
         LIMIT 1`,
        [`${sourceRegion}->${targetRegion}`]
      );
      sccReference = sccResult.rows[0]?.scc_code || null;
    }
    
    const result = await this.db.query(
      `INSERT INTO data_transfer_requests 
       (requester_id, source_region, target_region, data_types, legal_basis, purpose, recipient_info, data_subjects_affected, scc_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [requesterId, sourceRegion, targetRegion, dataTypes, legalBasis, purpose, recipientInfo, dataSubjectsAffected, sccReference]
    );
    
    const transferRequest = result.rows[0];
    
    // 发布事件
    await publishEvent('data.transfer.requested', {
      requestId: transferRequest.request_id,
      requesterId,
      sourceRegion,
      targetRegion,
      dataTypes,
      legalBasis
    });
    
    logger.info({ 
      requestId: transferRequest.request_id,
      requesterId, 
      sourceRegion, 
      targetRegion 
    }, 'Data transfer request created');
    
    return transferRequest;
  }

  /**
   * 检查是否需要标准合同条款
   */
  async checkSCCRequirement(sourceRegion, targetRegion) {
    // 从区域配置获取法律要求
    const sourceConfig = DataRegions[sourceRegion];
    const targetConfig = DataRegions[targetRegion];
    
    // 如果源区域有 GDPR，且目标不在欧盟，需要 SCC
    if (sourceConfig?.laws.includes('GDPR') && targetRegion !== 'EU' && targetRegion !== 'GB') {
      return true;
    }
    
    // 如果源区域是中国，需要安全评估或SCC
    if (sourceRegion === 'CN') {
      return true;
    }
    
    return false;
  }

  /**
   * 审批跨境传输请求
   * @param {number} requestId - 请求ID
   * @param {number} approverId - 审批人ID
   * @param {string} decision - 决定 ('approved' | 'rejected')
   * @param {string} reason - 原因（拒绝时必填）
   */
  async approveTransferRequest(requestId, approverId, decision, reason = null) {
    // 获取请求
    const requestResult = await this.db.query(
      'SELECT * FROM data_transfer_requests WHERE id = $1 FOR UPDATE',
      [requestId]
    );
    
    if (requestResult.rows.length === 0) {
      throw new Error('Transfer request not found');
    }
    
    const request = requestResult.rows[0];
    
    if (request.status !== TransferStatus.PENDING) {
      throw new Error(`Cannot approve request with status: ${request.status}`);
    }
    
    // 更新状态
    const updateResult = await this.db.query(
      `UPDATE data_transfer_requests 
       SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP, rejection_reason = $3
       WHERE id = $4
       RETURNING *`,
      [decision, approverId, decision === TransferStatus.REJECTED ? reason : null, requestId]
    );
    
    const updated = updateResult.rows[0];
    
    // 发布事件
    await publishEvent('data.transfer.' + decision, {
      requestId: updated.request_id,
      sourceRegion: request.source_region,
      targetRegion: request.target_region,
      approverId,
      reason
    });
    
    logger.info({ 
      requestId: updated.request_id, 
      decision, 
      approverId 
    }, 'Data transfer request processed');
    
    return updated;
  }

  /**
   * 记录数据传输日志
   */
  async logTransfer(transferData) {
    const {
      transferRequestId = null,
      userId,
      sourceRegion,
      targetRegion,
      dataType,
      dataCategory = 'personal',
      legalBasis,
      purpose,
      dataVolumeKb = 0,
      ipAddress,
      userAgent,
      metadata = {}
    } = transferData;
    
    const result = await this.db.query(
      `INSERT INTO data_transfer_logs 
       (transfer_request_id, user_id, source_region, target_region, data_type, data_category, legal_basis, purpose, data_volume_kb, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [transferRequestId, userId, sourceRegion, targetRegion, dataType, dataCategory, legalBasis, purpose, dataVolumeKb, ipAddress, userAgent, metadata]
    );
    
    return result.rows[0];
  }

  /**
   * 生成数据传输影响评估报告
   * @param {number} transferRequestId - 传输请求ID
   */
  async generateImpactAssessment(transferRequestId) {
    // 获取传输请求
    const requestResult = await this.db.query(
      'SELECT * FROM data_transfer_requests WHERE id = $1',
      [transferRequestId]
    );
    
    if (requestResult.rows.length === 0) {
      throw new Error('Transfer request not found');
    }
    
    const request = requestResult.rows[0];
    
    // 获取区域法律环境
    const sourceRegionLaws = DataRegions[request.source_region]?.laws || [];
    const targetRegionLaws = DataRegions[request.target_region]?.laws || [];
    
    // 识别法律差距
    const legalGaps = this.identifyLegalGaps(sourceRegionLaws, targetRegionLaws);
    
    // 评估风险等级
    const riskLevel = this.assessRiskLevel(request, legalGaps);
    
    // 生成建议
    const recommendation = this.generateRecommendation(riskLevel, legalGaps);
    
    // 保存评估结果
    const result = await this.db.query(
      `INSERT INTO transfer_impact_assessments 
       (transfer_request_id, data_types_assessed, data_subjects_count, sensitive_data_present, source_region_laws, target_region_laws, legal_gaps, risk_level, recommendation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        transferRequestId,
        request.data_types,
        request.data_subjects_affected,
        request.data_types.includes('payment') || request.data_types.includes('health'),
        { laws: sourceRegionLaws },
        { laws: targetRegionLaws },
        legalGaps,
        riskLevel,
        recommendation
      ]
    );
    
    return result.rows[0];
  }

  /**
   * 识别法律差距
   */
  identifyLegalGaps(sourceLaws, targetLaws) {
    const gaps = [];
    
    if (sourceLaws.includes('GDPR') && !targetLaws.includes('GDPR')) {
      gaps.push('GDPR adequacy decision required');
      gaps.push('Standard contractual clauses may be needed');
    }
    
    if (sourceLaws.includes('PIPL') && !targetLaws.includes('PIPL')) {
      gaps.push('Security assessment required by CAC');
      gaps.push('Separate consent for cross-border transfer needed');
    }
    
    return gaps;
  }

  /**
   * 评估风险等级
   */
  assessRiskLevel(request, legalGaps) {
    let riskScore = 0;
    
    // 法律差距数量
    riskScore += legalGaps.length * 2;
    
    // 数据类型敏感性
    if (request.data_types.includes('payment')) riskScore += 3;
    if (request.data_types.includes('health')) riskScore += 4;
    if (request.data_types.includes('location')) riskScore += 2;
    
    // 数据主体数量
    if (request.data_subjects_affected > 10000) riskScore += 3;
    else if (request.data_subjects_affected > 1000) riskScore += 2;
    
    // 目标区域风险
    const highRiskRegions = ['RU', 'CN'];
    if (highRiskRegions.includes(request.target_region)) riskScore += 2;
    
    if (riskScore >= 10) return 'very_high';
    if (riskScore >= 7) return 'high';
    if (riskScore >= 4) return 'medium';
    return 'low';
  }

  /**
   * 生成建议
   */
  generateRecommendation(riskLevel, legalGaps) {
    if (riskLevel === 'very_high') return 'reject';
    if (riskLevel === 'high') return 'approve_with_conditions';
    return 'approve';
  }

  /**
   * 查询传输日志
   */
  async getTransferLogs(filters = {}) {
    const { userId, sourceRegion, targetRegion, startDate, endDate, limit = 100, offset = 0 } = filters;
    
    let sql = 'SELECT * FROM data_transfer_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (userId) {
      sql += ` AND user_id = $${paramIndex++}`;
      params.push(userId);
    }
    
    if (sourceRegion) {
      sql += ` AND source_region = $${paramIndex++}`;
      params.push(sourceRegion);
    }
    
    if (targetRegion) {
      sql += ` AND target_region = $${paramIndex++}`;
      params.push(targetRegion);
    }
    
    if (startDate) {
      sql += ` AND transferred_at >= $${paramIndex++}`;
      params.push(startDate);
    }
    
    if (endDate) {
      sql += ` AND transferred_at <= $${paramIndex++}`;
      params.push(endDate);
    }
    
    sql += ` ORDER BY transferred_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);
    
    const result = await this.db.query(sql, params);
    return result.rows;
  }

  /**
   * 获取合规统计
   */
  async getComplianceStats() {
    const statsResult = await this.db.query(`
      SELECT 
        (SELECT COUNT(*) FROM data_transfer_requests) as total_requests,
        (SELECT COUNT(*) FROM data_transfer_requests WHERE status = 'pending') as pending_requests,
        (SELECT COUNT(*) FROM data_transfer_requests WHERE status = 'approved') as approved_requests,
        (SELECT COUNT(*) FROM data_transfer_requests WHERE status = 'rejected') as rejected_requests,
        (SELECT COUNT(*) FROM data_transfer_logs) as total_transfers,
        (SELECT COUNT(DISTINCT user_id) FROM user_data_regions) as users_with_region
    `);
    
    return statsResult.rows[0];
  }
}

module.exports = {
  DataTransferComplianceService,
  DataRegions,
  LegalBasis,
  TransferStatus
};
