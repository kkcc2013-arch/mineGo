/**
 * REQ-00016: GDPR 服务
 * 数据导出、删除等 GDPR 合规业务逻辑
 */

const logger = require('../../../../shared/logger');

class GDPRService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  /**
   * 获取隐私政策
   */
  async getPrivacyPolicy(version) {
    let query = `
      SELECT id, version, content, effective_date
      FROM privacy_policies
      WHERE status = 'active'
    `;
    const params = [];

    if (version) {
      query += ' AND version = $1';
      params.push(version);
    } else {
      query += ' ORDER BY effective_date DESC LIMIT 1';
    }

    const result = await this.db.query(query, params);
    return result.rows[0] || null;
  }

  /**
   * 导出用户数据（GDPR 第 20 条：数据可携带权）
   */
  async exportUserData(userId) {
    const userData = {
      exportedAt: new Date().toISOString(),
      user: {},
      pokemon: [],
      catches: [],
      gymBattles: [],
      friends: [],
      transactions: [],
      auditLogs: []
    };

    // 用户基本信息
    const userResult = await this.db.query(
      'SELECT id, phone, nickname, avatar, timezone, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length > 0) {
      userData.user = userResult.rows[0];
    }

    // 用户精灵
    const pokemonResult = await this.db.query(
      'SELECT * FROM user_pokemon WHERE user_id = $1',
      [userId]
    );
    userData.pokemon = pokemonResult.rows;

    // 捕获记录
    const catchesResult = await this.db.query(
      'SELECT * FROM catches WHERE user_id = $1',
      [userId]
    );
    userData.catches = catchesResult.rows;

    // 道馆战斗记录
    const battlesResult = await this.db.query(
      'SELECT * FROM gym_battles WHERE user_id = $1',
      [userId]
    );
    userData.gymBattles = battlesResult.rows;

    // 好友关系
    const friendsResult = await this.db.query(
      'SELECT * FROM friendships WHERE user_id = $1 OR friend_id = $1',
      [userId]
    );
    userData.friends = friendsResult.rows;

    // 交易记录
    const transactionsResult = await this.db.query(
      'SELECT * FROM transactions WHERE user_id = $1',
      [userId]
    );
    userData.transactions = transactionsResult.rows;

    // 审计日志
    const auditResult = await this.db.query(
      'SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500',
      [userId]
    );
    userData.auditLogs = auditResult.rows;

    return userData;
  }

  /**
   * 请求数据删除（GDPR 第 17 条：被遗忘权）
   */
  async requestDataDeletion(userId, options = {}) {
    const { reason, req } = options;

    // 生成确认令牌
    const crypto = require('crypto');
    const confirmationToken = crypto.randomBytes(32).toString('hex');

    // 插入删除请求
    const result = await this.db.query(`
      INSERT INTO data_deletion_requests (user_id, reason, confirmation_token, status, requested_at)
      VALUES ($1, $2, $3, 'pending', NOW())
      RETURNING id, confirmation_token
    `, [userId, reason, confirmationToken]);

    // 发布事件
    if (this.eventBus) {
      await this.eventBus.emit('data-deletion-requested', {
        userId,
        requestId: result.rows[0].id,
        confirmationToken: result.rows[0].confirmation_token
      });
    }

    return {
      success: true,
      message: 'Data deletion request submitted. Please check your email to confirm.',
      requestId: result.rows[0].id
    };
  }

  /**
   * 执行数据删除
   */
  async executeDataDeletion(userId, requestId) {
    // 开始事务
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // 删除相关数据
      await client.query('DELETE FROM user_pokemon WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM catches WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM gym_battles WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM friendships WHERE user_id = $1 OR friend_id = $1', [userId]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      
      // 匿名化用户记录而非删除（保留审计需要）
      await client.query(`
        UPDATE users 
        SET phone = NULL, 
            nickname = 'Deleted User', 
            avatar = NULL,
            deleted_at = NOW()
        WHERE id = $1
      `, [userId]);

      // 更新删除请求状态
      await client.query(`
        UPDATE data_deletion_requests
        SET status = 'completed', completed_at = NOW()
        WHERE id = $1
      `, [requestId]);

      await client.query('COMMIT');

      // 发布事件
      if (this.eventBus) {
        await this.eventBus.emit('data-deletion-completed', {
          userId,
          requestId
        });
      }

      logger.info({ userId, requestId }, 'User data deletion completed');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 记录用户同意
   */
  async recordConsent(userId, options = {}) {
    const { privacyPolicyVersion, termsVersion, req } = options;

    await this.db.query(`
      INSERT INTO user_consents (user_id, privacy_policy_version, terms_version, consented_at, ip_address)
      VALUES ($1, $2, $3, NOW(), $4)
    `, [userId, privacyPolicyVersion, termsVersion, req?.ip || null]);

    logger.info({ userId, privacyPolicyVersion, termsVersion }, 'User consent recorded');
  }

  /**
   * 撤回同意
   */
  async withdrawConsent(userId) {
    await this.db.query(`
      UPDATE user_consents
      SET withdrawn_at = NOW()
      WHERE user_id = $1 AND withdrawn_at IS NULL
    `, [userId]);

    // 触发数据删除流程
    await this.requestDataDeletion(userId, { reason: 'consent_withdrawn' });

    logger.info({ userId }, 'User consent withdrawn');
  }
}

module.exports = GDPRService;
