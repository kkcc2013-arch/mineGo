'use strict';

/**
 * 时段显示组件 - 显示当前游戏时间、时段、倒计时
 * REQ-00102: 精灵昼夜循环系统
 */
class TimePeriodDisplay {
  constructor(options = {}) {
    this.container = options.container || document.getElementById('time-period-display');
    this.updateInterval = options.updateInterval || 60000; // 1分钟更新一次
    this.onPeriodChange = options.onPeriodChange || (() => {});
    
    this.currentPeriod = null;
    this.timerId = null;
    
    this.init();
  }

  async init() {
    await this.updatePeriod();
    this.startAutoUpdate();
  }

  /**
   * 更新时段信息
   */
  async updatePeriod() {
    try {
      const response = await fetch('/api/time/current?timezone=' + this.getUserTimezone());
      const data = await response.json();
      
      const previousPeriod = this.currentPeriod;
      this.currentPeriod = data.data || data;
      
      if (previousPeriod && previousPeriod.id !== this.currentPeriod.id) {
        this.onPeriodChange(this.currentPeriod, previousPeriod);
      }
      
      this.render();
    } catch (error) {
      console.error('Failed to update time period:', error);
      // 使用默认值
      this.currentPeriod = {
        id: 'day',
        name_i18n: { zh: '白天' },
        light_level: 1.0,
        background_tint: '#87CEEB',
        time_until_next: { hours: 0, minutes: 0 }
      };
      this.render();
    }
  }

  /**
   * 渲染时段显示
   */
  render() {
    if (!this.currentPeriod || !this.container) return;
    
    const period = this.currentPeriod;
    const timeUntilNext = period.time_until_next || { hours: 0, minutes: 0 };
    
    const html = `
      <div class="time-period-container" style="background: linear-gradient(135deg, ${period.background_tint}22, ${period.background_tint}11);">
        <div class="period-icon">
          ${this.getPeriodIcon(period.id)}
        </div>
        <div class="period-info">
          <div class="period-name">${this.getPeriodName(period.id)}</div>
          <div class="period-time">${period.local_time || period.utc_time || ''}</div>
          <div class="next-period">
            下一时段: ${this.getPeriodName(period.next_period?.id || 'day')} 
            (${timeUntilNext.hours || 0}小时${timeUntilNext.minutes || 0}分)
          </div>
        </div>
        <div class="period-effects">
          ${this.renderPeriodEffects(period)}
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    this.applyAtmosphereEffects(period);
  }

  /**
   * 获取时段图标
   */
  getPeriodIcon(periodId) {
    const icons = {
      'dawn': '🌅',
      'day': '☀️',
      'dusk': '🌆',
      'night': '🌙',
      'late_night': '🌃'
    };
    return icons[periodId] || '⏰';
  }

  /**
   * 获取时段名称
   */
  getPeriodName(periodId) {
    if (!periodId) return '';
    const names = {
      'dawn': '黎明',
      'day': '白天',
      'dusk': '黄昏',
      'night': '夜晚',
      'late_night': '深夜'
    };
    return names[periodId] || periodId;
  }

  /**
   * 渲染时段效果
   */
  renderPeriodEffects(period) {
    const effects = [];
    
    if (period.atmosphere) {
      if (period.atmosphere.stars) effects.push('⭐ 星空可见');
      if (period.atmosphere.moon) effects.push('🌙 月亮可见');
      if (period.atmosphere.sunset) effects.push('🌅 日落特效');
      if (period.atmosphere.fog) effects.push(`🌫️ 雾气(${Math.round(period.atmosphere.fog * 100)}%)`);
    }
    
    return effects.map(e => `<span class="effect-badge">${e}</span>`).join('');
  }

  /**
   * 应用大气效果到游戏界面
   */
  applyAtmosphereEffects(period) {
    const gameContainer = document.getElementById('game-container');
    if (!gameContainer) return;
    
    // 移除旧的效果类
    gameContainer.classList.remove('period-dawn', 'period-day', 'period-dusk', 'period-night', 'period-late-night');
    
    // 添加新的效果类
    gameContainer.classList.add(`period-${period.id}`);
    
    // 应用光照强度
    gameContainer.style.setProperty('--light-level', period.light_level || 1.0);
    gameContainer.style.setProperty('--background-tint', period.background_tint || '#87CEEB');
    
    // 应用大气效果
    if (period.atmosphere) {
      if (period.atmosphere.fog) {
        gameContainer.style.setProperty('--fog-opacity', period.atmosphere.fog);
      }
    }
  }

  /**
   * 获取用户时区
   */
  getUserTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
      return 'UTC';
    }
  }

  /**
   * 启动自动更新
   */
  startAutoUpdate() {
    if (this.timerId) {
      clearInterval(this.timerId);
    }
    
    this.timerId = setInterval(() => {
      this.updatePeriod();
    }, this.updateInterval);
  }

  /**
   * 停止自动更新
   */
  stopAutoUpdate() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * 销毁组件
   */
  destroy() {
    this.stopAutoUpdate();
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TimePeriodDisplay;
} else if (typeof window !== 'undefined') {
  window.TimePeriodDisplay = TimePeriodDisplay;
}
