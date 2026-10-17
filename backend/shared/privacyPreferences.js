/**
 * REQ-00053: 用户隐私偏好管理中心与数据透明度报告
 * 隐私偏好服务核心模块
 */

const logger = require('./logger');
const metrics = require('./metrics');
const { auditLog, AuditActions } = require('./auditLog');

// 数据收集分类定义
const DATA_CATEGORIES = {
  LOCATION: {
    id: 'location',
    name: '位置数据',
    nameEn: 'Location Data',
    nameJa: '位置データ',
    description: 'GPS坐标、移动轨迹、地理围栏',
    descriptionEn: 'GPS coordinates, movement tracks, geofences',
    descriptionJa: 'GPS座標、移動経路、ジオフェンス',
    required: true,
    retentionDays: 90,
    collectable: true
  },
  BEHAVIOR: {
    id: 'behavior',
    name: '行为数据',
    nameEn: 'Behavior Data',
    nameJa: '行動データ',
    description: '捕捉记录、道馆战斗、社交互动',
    descriptionEn: 'Catch records, gym battles, social interactions',
    descriptionJa: '捕獲記録、ジムバトル、ソーシャル交流',
    required: false,
    retentionDays: 365,
    collectable: false
  },
  MARKETING: {
    id: 'marketing',
    name: '营销数据',
    nameEn: 'Marketing Data',
    nameJa: 'マーケティングデータ',
    description: '推送通知、活动提醒、个性化推荐',
    descriptionEn: 'Push notifications, event reminders, personalized recommendations',
    descriptionJa: 'プッシュ通知、イベント通知、パーソナライズ推奨',
    required: false,
    retentionDays: 180,
    collectable: false
  },
  ANALYTICS: {
    id: 'analytics',
    name: '分析数据',
    nameEn: 'Analytics Data',
    nameJa: '分析データ',
    description: '游戏使用统计、性能指标、崩溃报告',
    descriptionEn: 'Game usage statistics, performance metrics, crash reports',
    descriptionJa: 'ゲーム使用統計、パフォーマンス指標、クラッシュレポート',
    required: false,
    retentionDays: 365,
    collectable: false
  },
  SOCIAL: {
    id: 'social',
    name: '社交数据',
    nameEn: 'Social Data',
    nameJa: 'ソーシャルデータ',
    description: '好友列表、聊天记录、精灵交易',
    descriptionEn: 'Friend list, chat records, Pokemon trades',
    descriptionJa: 'フレンドリスト、チャット記録、ポケモン交換',
    required: false,
    retentionDays: 365,
    collectable: false
  },
  PAYMENT: {
    id: 'payment',
    name: '支付数据',
    nameEn: 'Payment Data',
    nameJa: '決済データ',
    description: '订单记录、支付方式、精币余额',
    descriptionEn: 'Order records, payment methods, coin balance',
    descriptionJa: '注文記録、支払い方法、コイン残高',
    required: false,
    retentionDays: 365,
    collectable: false
  },
  DEVICE: {
    id: 'device',
    name: '设备数据',
    nameEn: 'Device Data',
    nameJa: 'デバイスデータ',
    description: '设备型号、操作系统、唯一标识符',
    descriptionEn: 'Device model, operating system, unique identifier',
    descriptionJa: 'デバイスモデル、オペレーティングシステム、一意識別子',
    required: true,
    retentionDays: 365,
    collectable: true
  },
  PROFILE: {
    id: 'profile',
    name: '个人资料',
    nameEn: 'Profile Data',
    nameJa: 'プロフィールデータ',
    description: '用户名、头像、语言偏好、时区',
    descriptionEn: 'Username, avatar, language preference, timezone',
    descriptionJa: 'ユーザー名、アバター、言語設定、タイムゾーン',
    required: false,
    retentionDays: null, // Permanent
    collectable: false
  }
};

class PrivacyPreferencesService {
  constructor(db, eventBus = null) {
    this.db = db;
    this.eventBus = eventBus;
  }

  /**
   * 获取所有数据类别定义
   */
  getDataCategories(language = 'zh-CN') {
    const categories = [];
    for (const [key, cat] of Object.entries(DATA_CATEGORIES)) {
      const isEn = language === 'en-US';
      const isJa = language === 'ja-JP';
      categories.push({
        id: cat.id,
        name: isEn ? cat.nameEn : (isJa ? cat.nameJa : cat.name),
        description: isEn ? cat.descriptionEn : (isJa ? cat.descriptionJa : cat.description),
        required: cat.required,
        retentionDays: cat.retentionDays,
        retentionDisplay: cat.retentionDays ? `${cat.retentionDays} 天` : '永久'
      });
    }
    return categories;
  }

  /**
   * 初始化用户默认隐私偏好
   */
  async initializeUserPreferences(userId, transactionClient = null) {
    const client = transactionClient || await (this.db.getClient ? this.db.getClient() : this.db.pool.connect());
    try {
      if (!transactionClient) await client.query('BEGIN');
      
      for (const cat of Object.values(DATA_CATEGORIES)) {
        await client.query(`
          INSERT INTO user_privacy_preferences (user_id, category, collectable, consented_at)
          VALUES ($1, $2, $3, NULL)
          ON CONFLICT (user_id, category) DO NOTHING
        `, [userId, cat.id, cat.required]);
      }
      
      if (!transactionClient) await client.query('COMMIT');
      logger.info({ userId }, 'Privacy preferences initialized');
    } catch (error) {
      if (!transactionClient) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!transactionClient) client.release();
    }
  }

  /**
   * 获取用户隐私偏好
   */
  async getUserPreferences(userId) {
    const result = await this.db.query(`
      SELECT category, collectable, consented_at, updated_at
      FROM user_privacy_preferences
      WHERE user_id = $1
    `, [userId]);
    
    const preferences = {};
    for (const row of result.rows) {
      if (!Object.values(DATA_CATEGORIES).some(category => category.id === row.category)) continue;
      preferences[row.category] = {
        collectable: row.collectable,
        consentedAt: row.consented_at,
        updatedAt: row.updated_at
      };
    }
    
    // 确保所有类别都有值
    for (const cat of Object.values(DATA_CATEGORIES)) {
      if (!preferences[cat.id]) {
        preferences[cat.id] = {
          collectable: cat.required,
          consentedAt: null,
          updatedAt: null
        };
      }
    }
    
    return preferences;
  }

  /**
   * 更新用户隐私偏好
   */
  async updateUserPreferences(userId, preferences) {
    const client = await (this.db.getClient ? this.db.getClient() : this.db.pool.connect());
    const updatedCategories = [];
    const errors = [];
    
    try {
      await client.query('BEGIN');
      
      for (const [category, collectable] of Object.entries(preferences)) {
        // 检查是否为必需类别
        const catDef = Object.values(DATA_CATEGORIES).find(c => c.id === category);
        if (!catDef) {
          errors.push({ category, error: '未知的数据类别' });
          continue;
        }
        
        if (typeof collectable !== 'boolean') {
          errors.push({category, error: '数据收集开关必须为布尔值'});
          continue;
        }
        if (catDef.required && !collectable) {
          errors.push({ category, error: '该类别为必需数据，不可关闭' });
          continue;
        }
        
        // 更新偏好
        await client.query(`
          INSERT INTO user_privacy_preferences (user_id, category, collectable, consented_at, updated_at)
          VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW())
          ON CONFLICT (user_id, category) 
          DO UPDATE SET collectable = $3, consented_at = EXCLUDED.consented_at, updated_at = NOW()
        `, [userId, category, collectable]);
        
        updatedCategories.push({ category, collectable });
        
        // 记录审计日志
        const audited = await auditLog({userId, action: AuditActions.PRIVACY_PREFERENCE_CHANGE,
          details: {category, collectable}, service: 'user-service', db: client});
        if (!audited) throw new Error('Privacy preference audit could not be persisted');
      }
      
      await client.query('COMMIT');
      
      for (const update of updatedCategories) metrics.privacyPreferenceChanges.inc({category: update.category, action: update.collectable ? 'enable' : 'disable'});
      logger.info({ userId, updatedCategories: updatedCategories.length }, 'Privacy preferences updated');
      
      return {
        success: true,
        updated: updatedCategories,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 检查用户是否允许收集某类数据
   */
  async canCollectData(userId, category) {
    const definition = Object.values(DATA_CATEGORIES).find(item => item.id === category);
    if (!definition) return false;
    const result = await this.db.query(`
      SELECT collectable FROM user_privacy_preferences
      WHERE user_id = $1 AND category = $2
    `, [userId, category]);
    
    if (result.rows.length === 0) {
      return definition.required;
    }
    
    return result.rows[0].collectable === true;
  }

  /**
   * 记录数据访问日志
   */
  async logDataAccess(userId, category, action, purpose, details = null) {
    await this.db.query(`
      INSERT INTO data_access_logs (user_id, category, action, purpose, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, category, action, purpose, details]);
  }

  validateMonth(month) {
    if (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
      const error = new Error('Month must use YYYY-MM format');
      error.statusCode = 400;
      throw error;
    }
  }

  /**
   * 生成月度数据透明度报告
   */
  async generateMonthlyReport(userId, month) {
    this.validateMonth(month);
    // month 格式: 2026-06
    const startDate = `${month}-01`;
    const [year, m] = month.split('-');
    const nextMonth = m === '12' ? `${parseInt(year) + 1}-01` : `${year}-${String(parseInt(m) + 1).padStart(2, '0')}`;
    const endDate = `${nextMonth}-01`;
    
    // 查询数据访问日志
    const accessLogsResult = await this.db.query(`
      SELECT category, action, purpose, COUNT(*) as count
      FROM data_access_logs
      WHERE user_id = $1 AND accessed_at >= $2 AND accessed_at < $3
      GROUP BY category, action, purpose
      ORDER BY category, count DESC
    `, [userId, startDate, endDate]);
    
    // 按类别统计
    const dataByCategory = {};
    let totalDataPoints = 0;
    for (const row of accessLogsResult.rows) {
      if (!dataByCategory[row.category]) {
        dataByCategory[row.category] = 0;
      }
      dataByCategory[row.category] += parseInt(row.count);
      totalDataPoints += parseInt(row.count);
    }
    
    // 计算保留状态
    const retentionStatus = {};
    for (const [key, cat] of Object.entries(DATA_CATEGORIES)) {
      retentionStatus[cat.id] = cat.retentionDays 
        ? `保留 ${cat.retentionDays} 天` 
        : '永久保留';
    }
    
    const report = {
      month,
      generatedAt: new Date().toISOString(),
      summary: {
        totalDataPoints,
        dataByCategory,
        accessCount: accessLogsResult.rows.length,
        shareCount: 0 // 第三方共享次数
      },
      details: accessLogsResult.rows.map(row => ({
        category: row.category,
        action: row.action,
        purpose: row.purpose,
        count: parseInt(row.count)
      })),
      thirdPartyShares: [], // 第三方共享记录
      retentionStatus
    };
    
    // 保存报告
    await this.db.query(`
      INSERT INTO data_transparency_reports (user_id, month, report_json)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, month) 
      DO UPDATE SET report_json = $3, generated_at = NOW()
    `, [userId, month, JSON.stringify(report)]);
    
    metrics.transparencyReportsGenerated.inc();
    return report;
  }

  /**
   * 获取历史报告
   */
  async getReportHistory(userId, limit = 12) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      const error = new Error('History limit must be between 1 and 1000'); error.statusCode = 400; throw error;
    }
    const result = await this.db.query(`
      SELECT month, report_json, generated_at
      FROM data_transparency_reports
      WHERE user_id = $1
      ORDER BY month DESC
      LIMIT $2
    `, [userId, limit]);
    
    return result.rows.map(row => ({
      month: row.month,
      generatedAt: row.generated_at,
      summary: row.report_json.summary
    }));
  }

  /**
   * 获取完整报告
   */
  async getFullReport(userId, month) {
    this.validateMonth(month);
    const result = await this.db.query(`
      SELECT report_json, generated_at
      FROM data_transparency_reports
      WHERE user_id = $1 AND month = $2
    `, [userId, month]);
    
    if (result.rows.length === 0) {
      // 报告不存在，生成新报告
      return this.generateMonthlyReport(userId, month);
    }
    
    return {
      ...result.rows[0].report_json,
      generatedAt: result.rows[0].generated_at
    };
  }
}

/**
 * 隐私政策版本管理服务
 */
class PrivacyPolicyService {
  constructor(db) {
    this.db = db;
  }

  /**
   * 获取当前隐私政策
   */
  async getCurrentPolicy(language = 'zh-CN') {
    const result = await this.db.query(`
      SELECT version, effective_date, changes, 
        content_zh_cn, content_en_us, content_ja_jp, created_at
      FROM privacy_policy_versions
      WHERE effective_date <= NOW() AND COALESCE(is_active, true)
      ORDER BY effective_date DESC
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    let content;
    switch (language) {
      case 'en-US':
        content = row.content_en_us;
        break;
      case 'ja-JP':
        content = row.content_ja_jp;
        break;
      default:
        content = row.content_zh_cn;
    }
    
    return {
      version: row.version,
      effectiveDate: row.effective_date,
      changes: row.changes,
      content,
      createdAt: row.created_at
    };
  }

  /**
   * 获取历史版本列表
   */
  async getVersionHistory(limit = 10) {
    const result = await this.db.query(`
      SELECT version, effective_date, changes, created_at
      FROM privacy_policy_versions
      WHERE effective_date <= NOW()
      ORDER BY effective_date DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows.map(row => ({
      version: row.version,
      effectiveDate: row.effective_date,
      changes: row.changes,
      createdAt: row.created_at
    }));
  }

  /**
   * 获取特定版本
   */
  async getPolicyByVersion(version, language = 'zh-CN') {
    const result = await this.db.query(`
      SELECT version, effective_date, changes, 
        content_zh_cn, content_en_us, content_ja_jp, created_at
      FROM privacy_policy_versions
      WHERE version = $1
    `, [version]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    let content;
    switch (language) {
      case 'en-US':
        content = row.content_en_us;
        break;
      case 'ja-JP':
        content = row.content_ja_jp;
        break;
      default:
        content = row.content_zh_cn;
    }
    
    return {
      version: row.version,
      effectiveDate: row.effective_date,
      changes: row.changes,
      content,
      createdAt: row.created_at
    };
  }

  /**
   * 创建新版本（管理员）
   */
  async createPolicyVersion(version, effectiveDate, changes, contentZh, contentEn, contentJa) {
    const result = await this.db.query(`
      INSERT INTO privacy_policy_versions (version, effective_date, changes, content_zh_cn, content_en_us, content_ja_jp,
        title, content, published_at)
      VALUES ($1, $2::date, $3, $4, $5, $6, $1, $4, $2::date::timestamp)
      RETURNING *
    `, [version, effectiveDate, changes, contentZh, contentEn, contentJa]);
    
    logger.info({ version, effectiveDate }, 'New privacy policy version created');
    return result.rows[0];
  }

  /**
   * 记录用户接受政策
   */
  async recordAcceptance(userId, version, transactionClient = this.db) {
    const result = await transactionClient.query(`
      INSERT INTO privacy_policy_acceptance (user_id, policy_version)
      SELECT $1, version FROM privacy_policy_versions
      WHERE version = $2 AND effective_date <= NOW() AND COALESCE(is_active, true)
      ON CONFLICT (user_id, policy_version) DO UPDATE SET accepted_at = NOW()
      RETURNING policy_version
    `, [userId, version]);
    if (result.rows.length === 0) {
      const error = new Error('Policy version does not exist or is not effective');
      error.statusCode = 400;
      throw error;
    }
    
    logger.info({ userId, version }, 'User accepted privacy policy');
  }

  /**
   * 检查用户是否接受最新政策
   */
  async hasAcceptedLatestPolicy(userId) {
    const currentPolicy = await this.getCurrentPolicy();
    if (!currentPolicy) {
      return true; // 没有政策，视为已接受
    }
    
    const result = await this.db.query(`
      SELECT 1 FROM privacy_policy_acceptance
      WHERE user_id = $1 AND policy_version = $2
    `, [userId, currentPolicy.version]);
    
    return result.rows.length > 0;
  }

  /**
   * 获取未接受最新政策的用户列表
   */
  async getUsersNotAcceptedLatestPolicy(limit = 1000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      const error = new Error('User limit must be between 1 and 1000'); error.statusCode = 400; throw error;
    }
    const currentPolicy = await this.getCurrentPolicy();
    if (!currentPolicy) {
      return [];
    }
    
    const result = await this.db.query(`
      SELECT u.id, u.nickname AS username
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM privacy_policy_acceptance pa
        WHERE pa.user_id = u.id::text AND pa.policy_version = $1
      )
      LIMIT $2
    `, [currentPolicy.version, limit]);
    
    return result.rows;
  }
}

module.exports = {
  PrivacyPreferencesService,
  PrivacyPolicyService,
  DATA_CATEGORIES
};
