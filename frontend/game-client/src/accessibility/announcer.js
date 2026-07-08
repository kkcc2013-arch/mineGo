/**
 * A11y Announcer - 屏幕阅读器实时通知系统
 * REQ-00503: 游戏客户端屏幕阅读器与 ARIA 无障碍支持
 * 
 * 提供动态内容变化的语音通知
 * Updated: REQ-00335 - Distance unit localization
 * Enhanced: REQ-00503 - 完整的游戏事件播报系统
 */

import { i18n } from '../i18n/index.js';
import { formatDistance } from '../utils/unitSystem.js';
import ARIAUtils from './ariaUtils.js';

/**
 * 播报详细程度配置
 */
export const AnnouncerVerbosity = {
  MINIMAL: 'minimal',   // 仅关键事件
  NORMAL: 'normal',     // 常规事件
  DETAILED: 'detailed'  // 详细信息
};

/**
 * A11y Announcer 类
 */
export class A11yAnnouncer {
  constructor() {
    this.liveRegion = null;
    this.assertiveRegion = null;
    
    // 播报配置
    this.settings = {
      verbosity: AnnouncerVerbosity.NORMAL,
      announceDistance: true,
      announceStats: true,
      announceBattle: true,
      announceItems: true,
      announceSocial: true,
      maxQueueLength: 5,
      debounceMs: 150
    };
    
    // 播报队列（避免过多消息）
    this.announceQueue = [];
    this.isAnnouncing = false;
    
    this.init();
  }

  /**
   * 初始化播报器
   */
  init() {
    // 创建礼貌通知区域（一般状态更新）
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.className = 'sr-only';
    this.liveRegion.id = 'a11y-live-region';
    document.body.appendChild(this.liveRegion);

    // 创建紧急通知区域（重要提醒）
    this.assertiveRegion = document.createElement('div');
    this.assertiveRegion.setAttribute('role', 'alert');
    this.assertiveRegion.setAttribute('aria-live', 'assertive');
    this.assertiveRegion.setAttribute('aria-atomic', 'true');
    this.assertiveRegion.className = 'sr-only';
    this.assertiveRegion.id = 'a11y-alert-region';
    document.body.appendChild(this.assertiveRegion);

    console.log('[A11y] Announcer initialized');
  }

  /**
   * 设置播报配置
   */
  setSettings(settings) {
    Object.assign(this.settings, settings);
    console.log('[A11y] Settings updated:', this.settings);
  }

  /**
   * 发送礼貌通知（一般状态更新）
   */
  announce(message, options = {}) {
    // 检查是否在详细程度范围内
    if (options.verbosity && options.verbosity > this.settings.verbosity) {
      return; // 超出当前详细程度，跳过
    }
    
    this.addToQueue(message, 'polite');
  }

  /**
   * 发送紧急通知（重要提醒）
   */
  alert(message, options = {}) {
    this.addToQueue(message, 'assertive');
  }

  /**
   * 添加到播报队列
   */
  addToQueue(message, priority) {
    // 队列长度限制
    if (this.announceQueue.length >= this.settings.maxQueueLength) {
      this.announceQueue.shift();
    }
    
    this.announceQueue.push({
      message,
      priority,
      timestamp: Date.now()
    });
    
    // 处理队列
    this.processQueue();
  }

  /**
   * 处理播报队列
   */
  processQueue() {
    if (this.isAnnouncing || this.announceQueue.length === 0) return;
    
    this.isAnnouncing = true;
    const item = this.announceQueue.shift();
    
    const region = item.priority === 'assertive' 
      ? this.assertiveRegion 
      : this.liveRegion;
    
    // 清空后重新设置，确保屏幕阅读器捕获变化
    region.textContent = '';
    setTimeout(() => {
      region.textContent = item.message;
      console.log('[A11y] Announced:', item.message, 'priority:', item.priority);
      
      // 延迟后处理下一个
      setTimeout(() => {
        this.isAnnouncing = false;
        this.processQueue();
      }, this.settings.debounceMs);
    }, 100);
  }

  /**
   * 清除通知
   */
  clear() {
    this.liveRegion.textContent = '';
    this.assertiveRegion.textContent = '';
    this.announceQueue = [];
    this.isAnnouncing = false;
  }

  /**
   * 游戏事件通知模板
   */
  
  // 精灵出现
  announcePokemonSpawn(speciesName, distance, rarity = 'common') {
    if (!this.settings.announceDistance) return;
    
    // REQ-00335: 使用本地化距离格式化
    const distanceStr = formatDistance(distance, { shortForm: false });
    
    let message;
    if (this.settings.verbosity === AnnouncerVerbosity.MINIMAL) {
      message = `${speciesName} 出现`;
    } else {
      const rarityText = this.getRarityText(rarity);
      message = i18n.t('accessibility.pokemonSpawn', {
        speciesName,
        distance: distanceStr,
        rarity: rarityText
      }) || `${rarityText}${speciesName} 出现了，距离${distanceStr}`;
    }
    
    this.announce(message);
  }

  // 捕捉成功
  announceCatchSuccess(speciesName, cp, xpGained) {
    let message;
    if (this.settings.verbosity === AnnouncerVerbosity.MINIMAL) {
      message = `捕捉成功：${speciesName}`;
    } else {
      message = `捕捉成功！你获得了一只${speciesName}，CP ${cp}`;
      if (this.settings.announceStats && xpGained) {
        message += `，获得 ${xpGained} 经验值`;
      }
    }
    
    this.announce(message);
  }

  // 捕捉失败
  announceCatchFail(speciesName, reason = 'escaped') {
    const reasonText = reason === 'escaped' ? '逃跑了' : '捕捉失败';
    this.alert(`${speciesName} ${reasonText}！`);
  }

  // 物品收集
  announceItemCollected(itemName, quantity) {
    if (!this.settings.announceItems) return;
    
    const message = `获得 ${quantity} 个${itemName}`;
    this.announce(message);
  }

  // 升级
  announceLevelUp(newLevel, rewards = []) {
    let message = `恭喜升级！你现在是 ${newLevel} 级了`;
    
    if (this.settings.verbosity === AnnouncerVerbosity.DETAILED && rewards.length > 0) {
      message += `，获得：${rewards.join('、')}`;
    }
    
    this.alert(message);
  }

  // 道馆战斗
  announceGymBattle(won, gymName, details = {}) {
    if (!this.settings.announceBattle) return;
    
    let message;
    if (won) {
      message = `成功占领了 ${gymName} 道馆！`;
      if (this.settings.verbosity === AnnouncerVerbosity.DETAILED) {
        message += `，获得 ${details.xp || 0} 经验值`;
      }
    } else {
      message = `在 ${gymName} 道馆战斗失败`;
      if (details.reason) {
        message += `：${details.reason}`;
      }
    }
    
    this.announce(message);
  }

  // 好友请求
  announceFriendRequest(username) {
    if (!this.settings.announceSocial) return;
    this.announce(`${username} 向你发送了好友请求`);
  }

  // 交易完成
  announceTradeComplete(givenSpecies, receivedSpecies) {
    if (!this.settings.announceSocial) return;
    this.announce(`交易完成！你给出了${givenSpecies}，收到了${receivedSpecies}`);
  }

  // 电量不足
  announceLowBattery(percentage) {
    this.alert(`电量不足 ${percentage}%，请及时充电`);
  }

  // 网络错误
  announceNetworkError(action = '') {
    const message = action ? `${action}失败：网络连接失败` : '网络连接失败，请检查网络';
    this.alert(message);
  }

  // 精灵列表聚焦
  announcePokemonFocus(speciesName, cp, hp, maxHp) {
    let message = `${speciesName}，CP ${cp}`;
    
    if (this.settings.verbosity === AnnouncerVerbosity.DETAILED) {
      message += `，生命值 ${hp}/${maxHp}`;
    }
    
    this.announce(message, { verbosity: AnnouncerVerbosity.MINIMAL });
  }

  // 道馆状态
  announceGymStatus(gymName, teamColor, slotsAvailable) {
    const teamText = teamColor === 'red' ? '红队' : teamColor === 'blue' ? '蓝队' : '黄队';
    const message = `${gymName} 道馆，${teamText}占领，${slotsAvailable} 个空闲位置`;
    this.announce(message);
  }

  // 焦点变化（通用）
  announceFocusChange(description) {
    this.announce(description, { verbosity: AnnouncerVerbosity.MINIMAL });
  }

  // 战斗状态更新（实时）
  announceBattleState(state, details = {}) {
    if (!this.settings.announceBattle) return;
    
    // 战斗状态使用紧急播报
    let message;
    switch (state) {
      case 'attack':
        message = `攻击！造成 ${details.damage} 点伤害`;
        break;
      case 'defend':
        message = `敌方攻击，受到 ${details.damage} 点伤害`;
        break;
      case 'hp_update':
        message = `生命值 ${details.currentHp}/${details.maxHp}`;
        break;
      case 'victory':
        message = '战斗胜利！';
        break;
      case 'defeat':
        message = '战斗失败';
        break;
      default:
        message = state;
    }
    
    this.alert(message);
  }

  // 地图导航
  announceMapLocation(locationName) {
    this.announce(`当前位置：${locationName}`);
  }

  // 导航栏聚焦
  announceNavigationItem(itemName, isActive) {
    const message = isActive ? `${itemName}，已激活` : itemName;
    this.announceFocusChange(message);
  }

  /**
   * 辅助方法
   */
  
  // 获取稀有度文本
  getRarityText(rarity) {
    const rarityMap = {
      'common': '',
      'uncommon': '稀有的',
      'rare': '罕见的',
      'epic': '极罕见的',
      'legendary': '传说中的'
    };
    return rarityMap[rarity] || '';
  }

  // 获取播报统计
  getStats() {
    return {
      queueLength: this.announceQueue.length,
      isAnnouncing: this.isAnnouncing,
      settings: this.settings
    };
  }
}

// 导出单例
export const a11yAnnouncer = new A11yAnnouncer();
export default a11yAnnouncer;