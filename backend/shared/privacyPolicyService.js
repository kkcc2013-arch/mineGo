/**
 * REQ-00497: 隐私政策版本管理服务
 * 
 * 功能：
 * - 政策版本管理（创建、发布、废弃）
 * - 用户确认记录
 * - 待确认政策查询
 * - 批量通知调度
 * 
 * @module backend/shared/privacyPolicyService
 */

'use strict';

const { createLogger } = require('./logger');
const { executeQuery, transaction } = require('./db');

const logger = createLogger('privacy-policy-service');

/**
 * 隐私政策类型
 */
const POLICY_TYPES = {
  PRIVACY_POLICY: 'privacy_policy',
  TERMS_OF_SERVICE: 'terms_of_service',
  COOKIE_POLICY: 'cookie_policy',
  MARKETING_CONSENT: 'marketing_consent'
};

/**
 * 政策状态
 */
const POLICY_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  DEPRECATED: 'deprecated'
};

/**
 * 确认状态
 */
const CONFIRMATION_STATUS = {
  PENDING: 'pending_confirmation',
  CONFIRMED_LATEST: 'confirmed_latest',
  NEEDS_UPDATE: 'needs_update'
};

/**
 * 隐私政策版本管理服务
 */
class PrivacyPolicyService {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 300000; // 5分钟缓存
  }

  /**
   * 创建新政策版本
   * @param {Object} policyData 政策数据
   * @returns {Promise<Object>} 创建的政策
   */
  async createPolicy(policyData) {
    const {
      policyType = POLICY_TYPES.PRIVACY_POLICY,
      title,
      contentUrl,
      summary,
      effectiveDate,
      mandatoryConfirm = true,
      createdBy
    } = policyData;

    const result = await executeQuery(
      `INSERT INTO privacy_policies (
        policy_type, title, content_url, summary, effective_date,
        mandatory_confirm, status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        policyType,
        title,
        contentUrl,
        summary,
        effectiveDate,
        mandatoryConfirm,
        POLICY_STATUS.DRAFT,
        createdBy
      ]
    );

    const policy = result.rows[0];
    
    logger.info('Policy created', {
      policyId: policy.id,
      version: policy.version,
      type: policy.policy_type
    });

    return policy;
  }

  /**
   * 发布政策
   * @param {number} policyId 政策ID
   * @param {number} publishedBy 发布者ID
   * @returns {Promise<void>}
   */
  async publishPolicy(policyId, publishedBy) {
    await transaction(async (client) => {
      // 获取政策信息
      const policyResult = await client.query(
        'SELECT * FROM privacy_policies WHERE id = $1',
        [policyId]
      );

      if (policyResult.rows.length === 0) {
        throw new Error('Policy not found');
      }

      const policy = policyResult.rows[0];

      // 将旧版本标记为废弃
      await client.query(
        `UPDATE privacy_policies 
         SET status = $1, deprecated_at = NOW()
         WHERE policy_type = $2 
           AND id != $3 
           AND status = $4`,
        [POLICY_STATUS.DEPRECATED, policy.policy_type, policyId, POLICY_STATUS.PUBLISHED]
      );

      // 发布新版本
      await client.query(
        `UPDATE privacy_policies 
         SET status = $1, published_at = NOW(), created_by = COALESCE(created_by, $2)
         WHERE id = $3`,
        [POLICY_STATUS.PUBLISHED, publishedBy, policyId]
      );

      logger.info('Policy published', {
        policyId,
        version: policy.version,
        type: policy.policy_type,
        publishedBy
      });
    });

    // 清除缓存
    this.cache.clear();
  }

  /**
   * 获取当前生效的政策
   * @param {string} policyType 政策类型
   * @returns {Promise<Object|null>}
   */
  async getCurrentPolicy(policyType = POLICY_TYPES.PRIVACY_POLICY) {
    const cacheKey = `current:${policyType}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    const result = await executeQuery(
      `SELECT * FROM privacy_policies 
       WHERE policy_type = $1 AND status = $2
       ORDER BY effective_date DESC
       LIMIT 1`,
      [policyType, POLICY_STATUS.PUBLISHED]
    );

    const policy = result.rows[0] || null;
    
    this.cache.set(cacheKey, {
      data: policy,
      timestamp: Date.now()
    });

    return policy;
  }

  /**
   * 获取所有待确认的政策
   * @param {number} userId 用户ID
   * @returns {Promise<Object[]>}
   */
  async getPendingPolicies(userId) {
    const result = await executeQuery(
      `SELECT pp.id, pp.version, pp.policy_type, pp.title, 
              pp.content_url, pp.summary, pp.mandatory_confirm
       FROM privacy_policies pp
       WHERE pp.status = $1
         AND pp.mandatory_confirm = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM user_privacy_confirmations upc
           WHERE upc.user_id = $2 
             AND upc.policy_id = pp.id
             AND upc.revoked_at IS NULL
         )
       ORDER BY pp.effective_date DESC`,
      [POLICY_STATUS.PUBLISHED, userId]
    );

    return result.rows;
  }

  /**
   * 检查用户是否已确认最新政策
   * @param {number} userId 用户ID
   * @returns {Promise<Object>} 确认状态
   */
  async checkUserConfirmationStatus(userId) {
    const policies = await executeQuery(
      `SELECT pp.id, pp.version, pp.mandatory_confirm,
              upc.id AS confirmation_id, upc.confirmed_at, upc.policy_version AS confirmed_version
       FROM privacy_policies pp
       LEFT JOIN user_privacy_confirmations upc ON upc.user_id = $1 AND upc.policy_id = pp.id
       WHERE pp.status = $2 AND pp.mandatory_confirm = TRUE
       ORDER BY pp.effective_date DESC`,
      [userId, POLICY_STATUS.PUBLISHED]
    );

    const pendingPolicies = policies.rows.filter(p => !p.confirmation_id);
    const outdatedPolicies = policies.rows.filter(
      p => p.confirmation_id && p.confirmed_version !== p.version
    );

    return {
      isUpToDate: pendingPolicies.length === 0 && outdatedPolicies.length === 0,
      pendingCount: pendingPolicies.length,
      outdatedCount: outdatedPolicies.length,
      pendingPolicies: pendingPolicies.map(p => ({
        id: p.id,
        version: p.version,
        type: p.policy_type
      })),
      outdatedPolicies: outdatedPolicies.map(p => ({
        id: p.id,
        oldVersion: p.confirmed_version,
        newVersion: p.version
      }))
    };
  }

  /**
   * 记录用户确认
   * @param {Object} confirmationData 确认数据
   * @returns {Promise<Object>} 确认记录
   */
  async confirmPolicy(confirmationData) {
    const {
      userId,
      policyId,
      ipAddress,
      userAgent,
      deviceId,
      confirmationType = 'explicit'
    } = confirmationData;

    // 获取政策信息
    const policyResult = await executeQuery(
      'SELECT version FROM privacy_policies WHERE id = $1',
      [policyId]
    );

    if (policyResult.rows.length === 0) {
      throw new Error('Policy not found');
    }

    const policyVersion = policyResult.rows[0].version;

    // 插入或更新确认记录
    const result = await executeQuery(
      `INSERT INTO user_privacy_confirmations (
        user_id, policy_id, policy_version, ip_address, user_agent, device_id, confirmation_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, policy_id) 
      DO UPDATE SET 
        confirmed_at = NOW(),
        policy_version = $3,
        ip_address = $4,
        user_agent = $5,
        device_id = $6,
        confirmation_type = $7,
        revoked_at = NULL,
        revoke_reason = NULL
      RETURNING *`,
      [userId, policyId, policyVersion, ipAddress, userAgent, deviceId, confirmationType]
    );

    const confirmation = result.rows[0];

    logger.info('Policy confirmed', {
      userId,
      policyId,
      policyVersion,
      confirmationType
    });

    return confirmation;
  }

  /**
   * 批量确认政策（用于注册时）
   * @param {number} userId 用户ID
   * @param {number[]} policyIds 政策ID数组
   * @param {Object} metadata 元数据
   * @returns {Promise<Object[]>}
   */
  async confirmMultiplePolicies(userId, policyIds, metadata = {}) {
    const confirmations = [];

    for (const policyId of policyIds) {
      const confirmation = await this.confirmPolicy({
        userId,
        policyId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        deviceId: metadata.deviceId,
        confirmationType: metadata.confirmationType || 'explicit'
      });
      confirmations.push(confirmation);
    }

    return confirmations;
  }

  /**
   * 获取用户确认历史
   * @param {number} userId 用户ID
   * @returns {Promise<Object[]>}
   */
  async getUserConfirmationHistory(userId) {
    const result = await executeQuery(
      `SELECT upc.*, pp.title, pp.policy_type
       FROM user_privacy_confirmations upc
       JOIN privacy_policies pp ON pp.id = upc.policy_id
       WHERE upc.user_id = $1
       ORDER BY upc.confirmed_at DESC`,
      [userId]
    );

    return result.rows;
  }

  /**
   * 获取政策确认统计
   * @param {number} policyId 政策ID
   * @returns {Promise<Object>}
   */
  async getPolicyConfirmationStats(policyId) {
    const result = await executeQuery(
      `SELECT 
        COUNT(*) AS total_confirmations,
        COUNT(DISTINCT user_id) AS unique_users,
        COUNT(CASE WHEN confirmation_type = 'explicit' THEN 1 END) AS explicit_count,
        COUNT(CASE WHEN confirmation_type = 'forced' THEN 1 END) AS forced_count,
        MIN(confirmed_at) AS first_confirmation,
        MAX(confirmed_at) AS last_confirmation
       FROM user_privacy_confirmations
       WHERE policy_id = $1 AND revoked_at IS NULL`,
      [policyId]
    );

    return result.rows[0];
  }

  /**
   * 获取需要通知的用户列表
   * @param {number} policyId 政策ID
   * @param {number} limit 限制数量
   * @returns {Promise<Object[]>}
   */
  async getUsersNeedingNotification(policyId, limit = 1000) {
    const result = await executeQuery(
      `SELECT u.id, u.phone, u.email, u.language
       FROM users u
       WHERE NOT EXISTS (
         SELECT 1 FROM user_privacy_confirmations upc
         WHERE upc.user_id = u.id 
           AND upc.policy_id = $1
           AND upc.revoked_at IS NULL
       )
       AND u.status != 'banned'
       ORDER BY u.created_at DESC
       LIMIT $2`,
      [policyId, limit]
    );

    return result.rows;
  }
}

/**
 * 创建单例实例
 */
let instance = null;

function getPrivacyPolicyService() {
  if (!instance) {
    instance = new PrivacyPolicyService();
  }
  return instance;
}

module.exports = {
  PrivacyPolicyService,
  getPrivacyPolicyService,
  POLICY_TYPES,
  POLICY_STATUS,
  CONFIRMATION_STATUS
};
