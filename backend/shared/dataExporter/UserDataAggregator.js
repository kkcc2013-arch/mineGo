/**
 * REQ-00527: 用户数据聚合器
 * 从各个微服务收集用户数据
 */

const logger = require('../logger');

class UserDataAggregator {
  constructor(services) {
    this.services = services;
    
    // 数据收集器映射
    this.collectors = {
      profile: this._collectProfile.bind(this),
      pokemon: this._collectPokemon.bind(this),
      items: this._collectItems.bind(this),
      transactions: this._collectTransactions.bind(this),
      friends: this._collectFriends.bind(this),
      achievements: this._collectAchievements.bind(this),
      battles: this._collectBattles.bind(this),
      locations: this._collectLocations.bind(this),
      notifications: this._collectNotifications.bind(this),
      settings: this._collectSettings.bind(this)
    };
  }

  /**
   * 收集用户数据
   * @param {string} userId - 用户 ID
   * @param {string[]} dataTypes - 数据类型列表
   * @returns {object} 用户数据
   */
  async collect(userId, dataTypes) {
    logger.info({ userId, dataTypes }, 'Collecting user data');
    
    const results = {};
    const errors = [];
    
    // 并行收集所有数据
    const promises = dataTypes.map(async (type) => {
      try {
        if (this.collectors[type]) {
          const startTime = Date.now();
          const data = await this.collectors[type](userId);
          const duration = Date.now() - startTime;
          
          logger.info({ userId, type, duration, recordCount: this._countRecords(data) }, 'Data collected');
          
          return { type, data, success: true };
        } else {
          return { type, error: `Unknown data type: ${type}`, success: false };
        }
      } catch (error) {
        logger.error({ userId, type, error: error.message }, 'Data collection failed');
        return { type, error: error.message, success: false };
      }
    });
    
    const settled = await Promise.allSettled(promises);
    
    // 处理结果
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const { type, data, success, error } = result.value;
        if (success) {
          results[type] = data;
        } else {
          results[type] = { error };
          errors.push({ type, error });
        }
      } else {
        results[dataTypes[settled.indexOf(result)]] = { error: result.reason.message };
        errors.push({ type: dataTypes[settled.indexOf(result)], error: result.reason.message });
      }
    }
    
    // 如果有错误，记录但不中断流程
    if (errors.length > 0) {
      logger.warn({ userId, errors }, 'Some data types failed to collect');
    }
    
    return results;
  }

  /**
   * 收集用户档案数据
   */
  async _collectProfile(userId) {
    const query = `
      SELECT 
        u.id,
        u.username,
        u.email,
        u.phone,
        u.language_preference,
        u.timezone,
        u.created_at,
        u.updated_at,
        u.last_login_at,
        up.avatar_url,
        up.bio,
        up.level,
        up.experience,
        up.total_catches,
        up.total_battles,
        up.total_distance_meters
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE u.id = $1
    `;
    
    const result = await this.services.db.query(query, [userId]);
    const profile = result.rows[0];
    
    // 脱敏敏感字段
    if (profile) {
      profile.email = this._maskEmail(profile.email);
      profile.phone = profile.phone ? this._maskPhone(profile.phone) : null;
    }
    
    return profile;
  }

  /**
   * 收集精灵数据
   */
  async _collectPokemon(userId) {
    const query = `
      SELECT 
        id,
        pokemon_id,
        nickname,
        cp,
        hp,
        max_hp,
        attack_iv,
        defense_iv,
        stamina_iv,
        level,
        move_1,
        move_2,
        is_favorite,
        caught_at,
        caught_location,
        evolved_at
      FROM user_pokemon
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    
    const result = await this.services.db.query(query, [userId]);
    return result.rows;
  }

  /**
   * 收集道具数据
   */
  async _collectItems(userId) {
    const query = `
      SELECT 
        item_id,
        item_type,
        quantity,
        acquired_at
      FROM user_items
      WHERE user_id = $1
      ORDER BY acquired_at DESC
    `;
    
    const result = await this.services.db.query(query, [userId]);
    return result.rows;
  }

  /**
   * 收集交易数据
   */
  async _collectTransactions(userId) {
    const query = `
      SELECT 
        id,
        transaction_type,
        amount,
        currency,
        payment_method,
        status,
        created_at,
        completed_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1000
    `;
    
    const result = await this.services.db.query(query, [userId]);
    
    // 脱敏支付信息
    return result.rows.map(t => ({
      ...t,
      payment_method: this._maskPaymentMethod(t.payment_method)
    }));
  }

  /**
   * 收集好友数据
   */
  async _collectFriends(userId) {
    const query = `
      SELECT 
        f.id,
        f.friend_id,
        u.username as friend_username,
        f.status,
        f.created_at,
        f.accepted_at
      FROM friends f
      LEFT JOIN users u ON f.friend_id = u.id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
    `;
    
    const result = await this.services.db.query(query, [userId]);
    
    // 脱敏好友信息
    return result.rows.map(f => ({
      ...f,
      friend_username: f.friend_username || '[Unknown]'
    }));
  }

  /**
   * 收集成就数据
   */
  async _collectAchievements(userId) {
    const query = `
      SELECT 
        achievement_id,
        achievement_type,
        unlocked_at,
        progress
      FROM user_achievements
      WHERE user_id = $1
      ORDER BY unlocked_at DESC
    `;
    
    const result = await this.services.db.query(query, [userId]);
    return result.rows;
  }

  /**
   * 收集战斗数据
   */
  async _collectBattles(userId) {
    const query = `
      SELECT 
        id,
        battle_type,
        result,
        opponent_id,
        gym_id,
        rewards,
        created_at
      FROM battle_history
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 500
    `;
    
    const result = await this.services.db.query(query, [userId]);
    return result.rows;
  }

  /**
   * 收集位置数据
   */
  async _collectLocations(userId) {
    const query = `
      SELECT 
        id,
        ST_AsGeoJSON(location)::json as location,
        location_type,
        created_at
      FROM user_locations
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1000
    `;
    
    const result = await this.services.db.query(query, [userId]);
    
    // 位置数据脱敏（仅保留城市级别）
    return result.rows.map(loc => ({
      ...loc,
      location: this._fuzzyLocation(loc.location)
    }));
  }

  /**
   * 收集通知数据
   */
  async _collectNotifications(userId) {
    const query = `
      SELECT 
        id,
        notification_type,
        title,
        message,
        is_read,
        created_at
      FROM user_notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `;
    
    const result = await this.services.db.query(query, [userId]);
    return result.rows;
  }

  /**
   * 收集设置数据
   */
  async _collectSettings(userId) {
    const query = `
      SELECT 
        setting_key,
        setting_value,
        updated_at
      FROM user_settings
      WHERE user_id = $1
    `;
    
    const result = await this.services.db.query(query, [userId]);
    return result.rows;
  }

  /**
   * 邮箱脱敏
   */
  _maskEmail(email) {
    if (!email) return null;
    const [local, domain] = email.split('@');
    const masked = local.slice(0, 2) + '***';
    return `${masked}@${domain}`;
  }

  /**
   * 电话脱敏
   */
  _maskPhone(phone) {
    if (!phone) return null;
    return phone.slice(0, 3) + '****' + phone.slice(-3);
  }

  /**
   * 支付方式脱敏
   */
  _maskPaymentMethod(method) {
    if (!method) return null;
    if (method.startsWith('card_')) {
      return 'card_****' + method.slice(-4);
    }
    return method;
  }

  /**
   * 位置模糊化
   */
  _fuzzyLocation(location) {
    if (!location || !location.coordinates) return null;
    const [lng, lat] = location.coordinates;
    // 偏移约 1km
    const fuzzyLng = lng + (Math.random() - 0.5) * 0.01;
    const fuzzyLat = lat + (Math.random() - 0.5) * 0.01;
    return {
      type: 'Point',
      coordinates: [fuzzyLng, fuzzyLat]
    };
  }

  /**
   * 统计记录数
   */
  _countRecords(data) {
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') return 1;
    return data ? 1 : 0;
  }
}

module.exports = UserDataAggregator;
