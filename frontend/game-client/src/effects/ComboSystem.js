/**
 * 连击奖励系统
 * 管理捕捉连击计数和奖励计算
 */
'use strict';

export class ComboSystem {
  constructor(options = {}) {
    this.combo = 0;
    this.lastCatchTime = 0;
    this.comboTimeout = options.comboTimeout || 30000; // 30秒内连续捕捉算连击
    this.maxCombo = options.maxCombo || 100;
    
    // 连击倍数配置
    this.multipliers = {
      1: 1.0,
      2: 1.1,
      3: 1.2,
      5: 1.5,
      10: 2.0,
      20: 3.0,
      30: 4.0,
      50: 5.0
    };

    // 连击里程碑奖励
    this.milestones = {
      3: { xp: 100, stardust: 200, bonusItems: 1 },
      10: { xp: 500, stardust: 1000, bonusItems: 3 },
      20: { xp: 1500, stardust: 3000, bonusItems: 5 },
      50: { xp: 5000, stardust: 10000, bonusItems: 10 }
    };

    this.listeners = new Map();
  }

  /**
   * 记录一次捕捉
   * @returns {Object} 连击结果 { combo, multiplier, bonusXp, bonusStardust, milestone }
   */
  recordCatch() {
    const now = Date.now();
    const isCombo = now - this.lastCatchTime < this.comboTimeout;

    if (isCombo) {
      this.combo = Math.min(this.combo + 1, this.maxCombo);
    } else {
      this.combo = 1;
    }

    this.lastCatchTime = now;

    const result = {
      combo: this.combo,
      multiplier: this.getMultiplier(),
      bonusXp: this.calculateBonusXp(),
      bonusStardust: this.calculateBonusStardust(),
      milestone: null
    };

    // 检查是否达到里程碑
    const milestone = this.milestones[this.combo];
    if (milestone) {
      result.milestone = {
        combo: this.combo,
        ...milestone
      };
      this._emit('milestone', result.milestone);
    }

    this._emit('combo', result);
    return result;
  }

  /**
   * 记录一次失败（可选：是否重置连击）
   */
  recordFailure(resetCombo = false) {
    if (resetCombo) {
      this.reset();
    }
  }

  /**
   * 获取当前倍数
   */
  getMultiplier() {
    const keys = Object.keys(this.multipliers).map(Number).sort((a, b) => b - a);
    for (const key of keys) {
      if (this.combo >= key) {
        return this.multipliers[key];
      }
    }
    return 1.0;
  }

  /**
   * 计算奖励经验
   */
  calculateBonusXp() {
    if (this.combo < 3) return 0;
    return Math.floor(50 * this.combo * this.getMultiplier());
  }

  /**
   * 计算奖励星尘
   */
  calculateBonusStardust() {
    if (this.combo < 3) return 0;
    return Math.floor(100 * this.combo * this.getMultiplier());
  }

  /**
   * 获取下一个里程碑
   */
  getNextMilestone() {
    const milestoneKeys = Object.keys(this.milestones).map(Number).sort((a, b) => a - b);
    for (const key of milestoneKeys) {
      if (this.combo < key) {
        return {
          combo: key,
          remaining: key - this.combo,
          reward: this.milestones[key]
        };
      }
    }
    return null;
  }

  /**
   * 获取连击进度（百分比）
   */
  getProgress() {
    if (this.combo >= 50) return 100;
    const nextMilestone = this.getNextMilestone();
    if (!nextMilestone) return 100;
    
    const prevMilestone = this._getPreviousMilestone(nextMilestone.combo);
    const range = nextMilestone.combo - prevMilestone;
    const progress = this.combo - prevMilestone;
    
    return Math.floor((progress / range) * 100);
  }

  /**
   * 获取前一个里程碑
   * @private
   */
  _getPreviousMilestone(nextCombo) {
    const milestoneKeys = Object.keys(this.milestones).map(Number).sort((a, b) => a - b);
    for (let i = milestoneKeys.length - 1; i >= 0; i--) {
      if (milestoneKeys[i] < nextCombo) {
        return milestoneKeys[i];
      }
    }
    return 0;
  }

  /**
   * 重置连击
   */
  reset() {
    const oldCombo = this.combo;
    this.combo = 0;
    this.lastCatchTime = 0;
    
    if (oldCombo > 0) {
      this._emit('reset', { previousCombo: oldCombo });
    }
  }

  /**
   * 检查连击是否有效（是否超时）
   */
  isValid() {
    if (this.combo === 0) return false;
    return Date.now() - this.lastCatchTime < this.comboTimeout;
  }

  /**
   * 获取剩余时间（毫秒）
   */
  getRemainingTime() {
    if (this.combo === 0) return 0;
    const elapsed = Date.now() - this.lastCatchTime;
    return Math.max(0, this.comboTimeout - elapsed);
  }

  /**
   * 事件监听
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  /**
   * 移除事件监听
   */
  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const callbacks = this.listeners.get(event);
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
  }

  /**
   * 触发事件
   * @private
   */
  _emit(event, data) {
    if (!this.listeners.has(event)) return;
    for (const callback of this.listeners.get(event)) {
      callback(data);
    }
  }

  /**
   * 获取当前状态
   */
  getState() {
    return {
      combo: this.combo,
      multiplier: this.getMultiplier(),
      isValid: this.isValid(),
      remainingTime: this.getRemainingTime(),
      nextMilestone: this.getNextMilestone(),
      progress: this.getProgress()
    };
  }

  /**
   * 序列化（用于保存）
   */
  toJSON() {
    return {
      combo: this.combo,
      lastCatchTime: this.lastCatchTime
    };
  }

  /**
   * 反序列化（用于恢复）
   */
  static fromJSON(data) {
    const combo = new ComboSystem();
    if (data) {
      combo.combo = data.combo || 0;
      combo.lastCatchTime = data.lastCatchTime || 0;
    }
    return combo;
  }
}
