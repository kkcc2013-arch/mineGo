// gym-service/src/websocketLanguageHandler.js - REQ-00393 WebSocket 语言同步处理器
'use strict';

const redis = require('../../../shared/redis');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const languageService = require('../../../shared/LanguageService');

const logger = createLogger('gym-service:websocketLanguage');

class WebSocketLanguageHandler {
  constructor() {
    this.connections = new Map(); // userId -> { ws, language, battleId }
    this.battleConnections = new Map(); // battleId -> Set<userId>
  }

  /**
   * 注册 WebSocket 连接
   * @param {string} userId - 用户ID
   * @param {object} ws - WebSocket 连接对象
   * @param {string} battleId - 战斗ID（可选）
   */
  async registerConnection(userId, ws, battleId = null) {
    // 获取用户当前语言
    const language = await languageService.getLanguage(userId);
    
    this.connections.set(userId, {
      ws,
      language,
      battleId,
      registeredAt: Date.now()
    });
    
    // 如果在战斗中，添加到战斗连接集合
    if (battleId) {
      if (!this.battleConnections.has(battleId)) {
        this.battleConnections.set(battleId, new Set());
      }
      this.battleConnections.get(battleId).add(userId);
    }
    
    logger.info('WebSocket 连接已注册', { userId, language, battleId });
    metrics.increment('websocket.language.register');
    
    return { language };
  }

  /**
   * 移除 WebSocket 连接
   * @param {string} userId - 用户ID
   */
  removeConnection(userId) {
    const connection = this.connections.get(userId);
    
    if (connection) {
      // 从战斗连接集合中移除
      if (connection.battleId) {
        const battleSet = this.battleConnections.get(connection.battleId);
        if (battleSet) {
          battleSet.delete(userId);
          if (battleSet.size === 0) {
            this.battleConnections.delete(connection.battleId);
          }
        }
      }
      
      this.connections.delete(userId);
      logger.info('WebSocket 连接已移除', { userId });
      metrics.increment('websocket.language.unregister');
    }
  }

  /**
   * 更新连接语言
   * @param {string} userId - 用户ID
   * @param {string} language - 新语言
   */
  async updateConnectionLanguage(userId, language) {
    const connection = this.connections.get(userId);
    
    if (connection && connection.ws) {
      const previousLanguage = connection.language;
      connection.language = language;
      
      // 发送语言确认消息
      connection.ws.send(JSON.stringify({
        type: 'language-updated',
        language,
        previousLanguage,
        message: this.getLocalizedMessage(language, 'language_switched'),
        timestamp: Date.now()
      }));
      
      logger.info('WebSocket 语言已更新', { userId, previousLanguage, newLanguage: language });
      metrics.increment('websocket.language.updated');
      
      // 如果在战斗中，通知其他玩家
      if (connection.battleId) {
        await this.notifyBattleParticipants(connection.battleId, userId, language);
      }
      
      return { success: true, previousLanguage, newLanguage: language };
    }
    
    return { success: false, reason: 'connection_not_found' };
  }

  /**
   * 发送本地化消息
   * @param {string} userId - 用户ID
   * @param {string} messageType - 消息类型
   * @param {object} data - 消息数据
   */
  sendLocalizedMessage(userId, messageType, data) {
    const connection = this.connections.get(userId);
    
    if (!connection || !connection.ws) {
      logger.warn('连接不存在，无法发送消息', { userId, messageType });
      return false;
    }
    
    const language = connection.language || 'en';
    const localizedData = this.localizeData(data, language);
    
    connection.ws.send(JSON.stringify({
      type: messageType,
      ...localizedData,
      language,
      timestamp: Date.now()
    }));
    
    metrics.increment(`websocket.message.${messageType}`);
    return true;
  }

  /**
   * 批量发送本地化消息（战斗场景）
   * @param {string} battleId - 战斗ID
   * @param {string} messageType - 消息类型
   * @param {object} data - 消息数据
   */
  broadcastToBattle(battleId, messageType, data) {
    const participants = this.battleConnections.get(battleId);
    
    if (!participants || participants.size === 0) {
      logger.warn('战斗参与者不存在', { battleId });
      return;
    }
    
    for (const userId of participants) {
      this.sendLocalizedMessage(userId, messageType, data);
    }
    
    metrics.increment(`websocket.broadcast.${messageType}`);
    logger.debug('战斗广播消息已发送', { battleId, messageType, participants: participants.size });
  }

  /**
   * 通知战斗参与者语言变更
   * @param {string} battleId - 战斗ID
   * @param {string} changedUserId - 变更语言的用户ID
   * @param {string} newLanguage - 新语言
   */
  async notifyBattleParticipants(battleId, changedUserId, newLanguage) {
    const participants = this.battleConnections.get(battleId);
    
    if (!participants) return;
    
    for (const userId of participants) {
      if (userId !== changedUserId) {
        const connection = this.connections.get(userId);
        if (connection && connection.ws) {
          connection.ws.send(JSON.stringify({
            type: 'participant-language-changed',
            userId: changedUserId,
            language: newLanguage,
            timestamp: Date.now()
          }));
        }
      }
    }
  }

  /**
   * 本地化数据
   * @param {object} data - 原始数据
   * @param {string} language - 目标语言
   * @returns {object} - 本地化后的数据
   */
  localizeData(data, language) {
    const localizedData = { ...data };
    
    // 本地化消息
    if (localizedData.message) {
      localizedData.message = this.getLocalizedMessage(language, localizedData.message);
    }
    
    // 本地化描述
    if (localizedData.description) {
      localizedData.description = this.getLocalizedMessage(language, localizedData.description);
    }
    
    // 本地化提示
    if (localizedData.tip) {
      localizedData.tip = this.getLocalizedMessage(language, localizedData.tip);
    }
    
    return localizedData;
  }

  /**
   * 获取本地化消息
   * @param {string} language - 语言代码
   * @param {string} key - 消息键
   * @returns {string} - 本地化消息
   */
  getLocalizedMessage(language, key) {
    const messages = {
      'language_switched': {
        zh: '语言已切换为中文',
        en: 'Language switched to English',
        ja: '言語が日本語に切り替わりました'
      },
      'battle_start': {
        zh: '战斗开始！',
        en: 'Battle started!',
        ja: '戦闘開始！'
      },
      'battle_end': {
        zh: '战斗结束',
        en: 'Battle ended',
        ja: '戦闘終了'
      },
      'pokemon_appeared': {
        zh: '精灵出现了！',
        en: 'Pokemon appeared!',
        ja: 'ポケモンが現れた！'
      },
      'critical_hit': {
        zh: '暴击！',
        en: 'Critical hit!',
        ja: 'クリティカルヒット！'
      },
      'combo_hit': {
        zh: '连击！',
        en: 'Combo hit!',
        ja: 'コンボヒット！'
      },
      'knock_out': {
        zh: '精灵被击败！',
        en: 'Pokemon knocked out!',
        ja: 'ポケモンが倒れた！'
      },
      'victory': {
        zh: '胜利！',
        en: 'Victory!',
        ja: '勝利！'
      },
      'defeat': {
        zh: '失败',
        en: 'Defeat',
        ja: '敗北'
      },
      'skill_used': {
        zh: '使用了技能',
        en: 'Skill used',
        ja: 'スキル使用'
      },
      'waiting_for_opponent': {
        zh: '等待对手...',
        en: 'Waiting for opponent...',
        ja: '対戦相手を待っています...'
      },
      'turn_timeout': {
        zh: '回合超时',
        en: 'Turn timeout',
        ja: 'ターンタイムアウト'
      },
      'connection_restored': {
        zh: '连接已恢复',
        en: 'Connection restored',
        ja: '接続が復元されました'
      },
      'connection_lost': {
        zh: '连接已断开',
        en: 'Connection lost',
        ja: '接続が切断されました'
      }
    };
    
    const msgSet = messages[key];
    if (msgSet) {
      return msgSet[language] || msgSet['en'] || key;
    }
    
    return key;
  }

  /**
   * 获取连接统计
   * @returns {object}
   */
  getStats() {
    const languageDistribution = {};
    
    for (const [userId, conn] of this.connections) {
      const lang = conn.language;
      languageDistribution[lang] = (languageDistribution[lang] || 0) + 1;
    }
    
    return {
      totalConnections: this.connections.size,
      activeBattles: this.battleConnections.size,
      languageDistribution,
      connectionsByBattle: Array.from(this.battleConnections.entries())
        .map(([battleId, users]) => ({ battleId, participants: users.size }))
    };
  }

  /**
   * 初始化 Redis 语言变更订阅
   */
  async initLanguageSubscription() {
    //订阅语言变更频道
    const subscriber = redis.duplicate();
    
    subscriber.subscribe('gym:language:*', async (message) => {
      try {
        const data = JSON.parse(message);
        await this.updateConnectionLanguage(data.userId, data.language);
      } catch (error) {
        logger.error('处理语言变更订阅失败', { error });
      }
    });
    
    logger.info('语言变更订阅已初始化');
  }
}

module.exports = new WebSocketLanguageHandler();