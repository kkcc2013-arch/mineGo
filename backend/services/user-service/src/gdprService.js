/**
 * REQ-00016: GDPR 服务模块
 * 提供数据导出、删除等 GDPR 合规功能
 */

const logger = require('../../shared/logger');
const { auditLog, AuditActions } = require('../../shared/auditLog');
const DataMasking = require('../../shared/dataMasking');

class GDPRService {
  constructor(db, eventBus = null) {
    this.db = db;
    this.eventBus = eventBus;
  }

  /**
   * 导出用户数据
   * @param {number} userId - 用户 ID
   * @returns {object} 用户数据
   */
  async exportUserData(userId) {
    logger.info({ userId }, 'Starting data export');
    
    const exportData = {
      exportDate: new Date().toISOString(),
      exportVersion: '1.0',
      user: await this._exportUser(userId),
      consents: await this._exportConsents(userId),
      pokemon: await this._exportPokemon(userId),
      catches: await this._exportCatches(userId),
      gyms: await this._exportGyms(userId),
      social: await this._exportSocial(userId),
      payments: await this._exportPayments(userId),
      rewards: await this._exportRewards(userId),
      auditLogs: await this._exportAuditLogs(userId)
    };
    
    logger.info({ userId }, 'Data export completed');
    return exportData;
  }

  async _exportUser(userId) {
    const result = await this.db.query(`
      SELECT id, email, username, language_preference, created_at
      FROM users WHERE id = $1
    `, [userId]);
    return result.rows[0] || null;
  }

  async _exportConsents(userId) {
    const result = await this.db.query(`
      SELECT privacy_policy_version, terms_version, consented_at, withdrawn_at
      FROM user_consents WHERE user_id = $1
    `, [userId]);
    return result.rows;
  }

  async _exportPokemon(userId) {
    const result = await this.db.query(`
      SELECT id, pokemon_id, name, cp, iv, caught_at
      FROM user_pokemon WHERE user_id = $1
    `, [userId]);
    return result.rows;
  }

  async _exportCatches(userId) {
    const result = await this.db.query(`
      SELECT id, pokemon_id, cp, caught_at, location
      FROM catch_history WHERE user_id = $1
      ORDER BY caught_at DESC
      LIMIT 1000
    `, [userId]);
    return result.rows;
  }

  async _exportGyms(userId) {
    const result = await this.db.query(`
      SELECT id, gym_id, action, created_at
      FROM gym_battles WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1000
    `, [userId]);
    return result.rows;
  }

  async _exportSocial(userId) {
    // 好友关系
    const friends = await this.db.query(`
      SELECT 
        CASE WHEN user1_id = $1 THEN user2_id ELSE user1_id END as friend_id,
        created_at
      FROM friendships
      WHERE user1_id = $1 OR user2_id = $1
    `, [userId]);
    
    // 消息
    const messages = await this.db.query(`
      SELECT sender_id, receiver_id, content, created_at
      FROM messages
      WHERE sender_id = $1 OR receiver_id = $1
      ORDER BY created_at DESC
      LIMIT 1000
    `, [userId]);
    
    return { friends: friends.rows, messages: messages.rows };
  }

  async _exportPayments(userId) {
    const result = await this.db.query(`
      SELECT 
        id, 
        amount, 
        currency, 
        status, 
        created_at,
        completed_at
      FROM payments WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);
    
    // 脱敏支付数据
    return result.rows.map(p => ({
      ...p,
      // 不导出敏感支付信息
      payment_method: '****'
    }));
  }

  async _exportRewards(userId) {
    const result = await this.db.query(`
      SELECT id, reward_type, amount, reason, created_at
      FROM user_rewards WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1000
    `, [userId]);
    return result.rows;
  }

  async _exportAuditLogs(userId) {
    const result = await this.db.query(`
      SELECT action, details, created_at
      FROM audit_logs WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1000
    `, [userId]);
    return result.rows;
  }

  /**
   * 请求数据删除
   * @param {number} userId - 用户 ID
   * @param {object} options - 选项
   * @returns {object} 删除请求结果
   */
  async requestDataDeletion(userId, options = {}) {
    const { reason = 'user_request', req } = options;
    
    // 创建删除请求记录
    const confirmationToken = this._generateConfirmationToken();
    
    const result = await this.db.query(`
      INSERT INTO data_deletion_requests (user_id, confirmation_token)
      VALUES ($1, $2)
      RETURNING id
    `, [userId, confirmationToken]);
    
    const requestId = result.rows[0].id;
    
    // 记录审计日志
    await auditLog({
      userId,
      action: AuditActions.DELETION_REQUESTED,
      details: { requestId, reason },
      req,
      service: 'user-service',
      db: this.db
    });
    
    // 发布删除事件（异步处理）
    if (this.eventBus) {
      await this.eventBus.publish('gdpr.delete', {
        userId,
        requestId,
        confirmationToken
      });
    } else {
      // 直接执行删除（同步）
      await this.executeDataDeletion(userId, requestId);
    }
    
    logger.info({ userId, requestId }, 'Data deletion requested');
    
    return {
      success: true,
      requestId,
      confirmationToken,
      message: 'Data deletion in progress. You will receive email confirmation.'
    };
  }

  /**
   * 执行数据删除
   * @param {number} userId - 用户 ID
   * @param {number} requestId - 请求 ID
   */
  async executeDataDeletion(userId, requestId) {
    logger.info({ userId, requestId }, 'Starting data deletion');
    
    try {
      // 更新状态为处理中
      await this.db.query(`
        UPDATE data_deletion_requests
        SET status = 'processing'
        WHERE id = $1
      `, [requestId]);
      
      // 1. 删除精灵数据
      await this.db.query('DELETE FROM user_pokemon WHERE user_id = $1', [userId]);
      
      // 2. 删除捕捉历史
      await this.db.query('DELETE FROM catch_history WHERE user_id = $1', [userId]);
      
      // 3. 删除道馆数据
      await this.db.query('DELETE FROM gym_battles WHERE user_id = $1', [userId]);
      
      // 4. 删除社交数据
      await this.db.query(
        'DELETE FROM friendships WHERE user1_id = $1 OR user2_id = $1',
        [userId]
      );
      await this.db.query(
        'DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1',
        [userId]
      );
      
      // 5. 脱敏支付数据（保留审计需要）
      await this.db.query(`
        UPDATE payments 
        SET payment_method = 'DELETED', 
            metadata = '{}' 
        WHERE user_id = $1
      `, [userId]);
      
      // 6. 删除奖励数据
      await this.db.query('DELETE FROM user_rewards WHERE user_id = $1', [userId]);
      
      // 7. 删除位置数据
      await this.db.query('DELETE FROM encrypted_user_locations WHERE user_id = $1', [userId]);
      
      // 8. 删除同意记录
      await this.db.query('DELETE FROM user_consents WHERE user_id = $1', [userId]);
      
      // 9. 匿名化用户记录（保留审计需要）
      await this.db.query(`
        UPDATE users 
        SET email = 'deleted@deleted.com', 
            username = 'deleted_user_' || id,
            password_hash = '',
            deleted_at = NOW(),
            deletion_reason = 'gdpr_request'
        WHERE id = $1
      `, [userId]);
      
      // 10. 更新删除请求状态
      await this.db.query(`
        UPDATE data_deletion_requests
        SET status = 'completed', completed_at = NOW()
        WHERE id = $1
      `, [requestId]);
      
      // 11. 记录审计日志
      await auditLog({
        userId,
        action: AuditActions.DELETION_COMPLETED,
        details: { requestId, deletedAt: new Date().toISOString() },
        service: 'user-service',
        db: this.db
      });
      
      logger.info({ userId, requestId }, 'Data deletion completed');
      
      return { success: true };
    } catch (err) {
      logger.error({ err, userId, requestId }, 'Data deletion failed');
      
      // 更新状态为失败
      await this.db.query(`
        UPDATE data_deletion_requests
        SET status = 'failed', error_message = $2
        WHERE id = $1
      `, [requestId, err.message]);
      
      // 记录审计日志
      await auditLog({
        userId,
        action: AuditActions.DELETION_FAILED,
        details: { requestId, error: err.message },
        service: 'user-service',
        db: this.db
      });
      
      throw err;
    }
  }

  _generateConfirmationToken() {
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 获取隐私政策
   * @param {string} version - 版本号（可选，默认最新）
   */
  async getPrivacyPolicy(version = null) {
    let query = `
      SELECT version, title, content, summary, published_at
      FROM privacy_policy_versions
      WHERE is_active = true
    `;
    const params = [];
    
    if (version) {
      query += ' AND version = $1';
      params.push(version);
    } else {
      query += ' ORDER BY published_at DESC LIMIT 1';
    }
    
    const result = await this.db.query(query, params);
    return result.rows[0] || null;
  }

  /**
   * 记录用户同意
   * @param {number} userId - 用户 ID
   * @param {object} options - 选项
   */
  async recordConsent(userId, options = {}) {
    const {
      privacyPolicyVersion = '1.0',
      termsVersion = '1.0',
      req
    } = options;
    
    await this.db.query(`
      INSERT INTO user_consents 
        (user_id, privacy_policy_version, terms_version, consented_at, ip_address, user_agent)
      VALUES ($1, $2, $3, NOW(), $4, $5)
    `, [
      userId,
      privacyPolicyVersion,
      termsVersion,
      req?.ip || null,
      req?.headers?.['user-agent'] || null
    ]);
    
    // 记录审计日志
    await auditLog({
      userId,
      action: AuditActions.CONSENT_GIVEN,
      details: { privacyPolicyVersion, termsVersion },
      req,
      service: 'user-service',
      db: this.db
    });
    
    logger.info({ userId }, 'Consent recorded');
  }

  /**
   * 撤回同意
   * @param {number} userId - 用户 ID
   */
  async withdrawConsent(userId) {
    await this.db.query(`
      UPDATE user_consents
      SET withdrawn_at = NOW()
      WHERE user_id = $1 AND withdrawn_at IS NULL
    `, [userId]);
    
    // 记录审计日志
    await auditLog({
      userId,
      action: AuditActions.CONSENT_WITHDRAWN,
      details: {},
      service: 'user-service',
      db: this.db
    });
    
    logger.info({ userId }, 'Consent withdrawn');
  }
}

module.exports = GDPRService;
