/**
 * HapticManager - 游戏触觉反馈增强系统
 * 
 * 功能：
 * - 差异化震动模式，覆盖捕捉、战斗、UI、成就等场景
 * - 用户可配置震动强度（弱/中/强/关闭）
 * - 静音模式自动增强触觉反馈
 * - 设备兼容性检测与优雅降级
 * 
 * @module HapticManager
 */

export class HapticManager {
  // 震动强度等级
  static INTENSITY = {
    OFF: 0,
    LIGHT: 1,
    MEDIUM: 2,
    STRONG: 3
  };

  // 预定义震动模式（毫秒数组：[震动, 暂停, 震动, ...]）
  static PATTERNS = {
    // ── UI 交互 ──
    'tap': [10],
    'button_press': [15],
    'toggle_on': [20, 50, 20],
    'toggle_off': [40],
    'dialog_open': [30],
    'dialog_close': [20],
    'scroll': [5],
    'zoom': [10],
    
    // ── 捕捉场景 ──
    'catch_throw': [25, 30, 10],
    'catch_hit': [50],
    'catch_shake_1': [30],
    'catch_shake_2': [30, 50, 30],
    'catch_shake_3': [30, 50, 30, 50, 30],
    'catch_success': [100, 50, 30, 50, 100],
    'catch_escape': [60, 30, 60],
    'catch_fled': [200, 100, 200],
    'throw_excellent': [30, 20, 30, 20, 80],
    'throw_great': [20, 30, 60],
    'throw_nice': [40],
    
    // ── 战斗场景 ──
    'battle_start': [100, 50, 100],
    'battle_attack': [40],
    'battle_hit': [60],
    'battle_crit': [30, 20, 30, 60],
    'battle_dodge': [20],
    'battle_win': [100, 50, 50, 50, 100],
    'battle_lose': [200, 100, 200, 100, 200],
    'battle_skill': [50, 30, 50],
    
    // ── 成就/奖励 ──
    'level_up': [100, 50, 50, 50, 50, 50, 150],
    'achievement': [80, 40, 80, 40, 150],
    'reward': [50, 30, 50],
    'daily_bonus': [100, 30, 100],
    
    // ── 精灵出现 ──
    'pokemon_spawn_nearby': [50, 100, 50],
    'pokemon_spawn_rare': [100, 50, 100, 50, 200],
    'pokemon_spawn_legendary': [200, 100, 100, 50, 50, 50, 200],
    
    // ── 警告/错误 ──
    'warning': [100, 50, 100],
    'error': [150, 50, 150],
    'low_battery': [200, 100, 200, 100, 200],
    'network_error': [100, 50, 50, 50, 100],
    
    // ── 导航 ──
    'map_scroll': [5],
    'map_zoom': [10],
    'direction_change': [15],
    'location_update': [8],
    
    // ── 社交 ──
    'friend_request': [50, 50, 50],
    'gift_received': [40, 30, 40],
    'trade_complete': [80, 40, 80],
    
    // ── 物品/背包 ──
    'item_pickup': [30],
    'item_use': [25],
    'inventory_full': [100, 50, 100],
    'bag_open': [15]
  };

  // 场景分组（REQ-00316：可按场景启用/禁用）
  static sceneOf(patternName) {
    const n = String(patternName || '');
    if (/^(catch_|throw_)/.test(n)) return 'catch';
    if (/^battle_/.test(n)) return 'battle';
    if (/^(map_|direction_|location_|pokemon_spawn)/.test(n)) return 'navigation';
    if (/^(level_up|achievement|reward|daily_bonus|item_|friend_|gift_|trade_|inventory_|bag_)/.test(n)) return 'special';
    return 'ui';
  }

  constructor() {
    // Epic E21：百分比强度（0-200%，REQ-00316）、按场景开关、调用记录与统计、震动监听（手柄震动镜像）
    this._scalePct = 100;
    this._scenes = { catch: true, battle: true, ui: true, navigation: true, special: true };
    this.history = [];
    this.stats = { total: 0, delivered: 0, byPattern: {} };
    this._listeners = new Set();
    this._intensity = HapticManager.INTENSITY.MEDIUM;
    this._enabled = true;
    this._silentModeBoost = true;
    this._unlocked = false;
    this._supported = this._checkSupport();
    this._audioManager = null;
    
    // 从 localStorage 加载设置
    this._loadSettings();
    
    // 监听用户交互以解锁震动
    this._setupUnlock();
  }

  // ── 公共 API ─────────────────────────────────────────────

  /**
   * 触发震动
   * @param {string} patternName - 预定义模式名称
   * @param {Object} options - 可选配置
   * @param {number} options.intensity - 临时覆盖强度
   */
  vibrate(patternName, options = {}) {
    const scene = options.scene || HapticManager.sceneOf(patternName);
    const pattern = HapticManager.PATTERNS[patternName];
    const rec = { pattern: patternName, scene, t: Date.now(), delivered: false, reason: null, scaled: null };
    this.history.push(rec);
    if (this.history.length > 100) this.history.shift();
    this.stats.total++;
    this.stats.byPattern[patternName] = (this.stats.byPattern[patternName] || 0) + 1;

    if (!pattern) {
      rec.reason = 'unknown';
      console.warn(`[HapticManager] 未知的震动模式: ${patternName}`);
      return false;
    }
    if (!this._enabled || this._intensity === 0 || this._scalePct === 0) { rec.reason = 'disabled'; return false; }
    if (this._scenes[scene] === false) { rec.reason = 'scene-off'; return false; }
    rec.scaled = this._scalePattern(pattern, options.intensity ?? this._intensity);
    this._listeners.forEach((fn) => { try { fn(rec); } catch { /* ignore */ } });
    if (!this._supported) { rec.reason = 'unsupported'; return false; }

    if (!this._unlocked) {
      rec.reason = 'locked';
      console.debug('[HapticManager] 震动未解锁，等待用户交互');
      return false;
    }

    // 计算最终强度（考虑静音模式增强）
    let finalIntensity = options.intensity ?? this._intensity;
    if (this._silentModeBoost && this._audioManager?.muted) {
      finalIntensity = Math.min(finalIntensity + 1, HapticManager.INTENSITY.STRONG);
    }

    // 缩放震动模式
    const scaledPattern = this._scalePattern(pattern, finalIntensity);
    
    try {
      navigator.vibrate(scaledPattern);
      rec.delivered = true;
      this.stats.delivered++;
      return true;
    } catch (err) {
      console.warn('[HapticManager] 震动失败:', err);
      return false;
    }
  }

  /** 百分比强度 0-200（REQ-00316），100 为默认 */
  setScalePercent(pct) {
    this._scalePct = Math.max(0, Math.min(200, Number(pct) || 0));
  }

  getScalePercent() { return this._scalePct; }

  setSceneEnabled(scene, enabled) { this._scenes[scene] = !!enabled; }

  setScenes(scenes = {}) { Object.assign(this._scenes, scenes); }

  isSceneEnabled(scene) { return this._scenes[scene] !== false; }

  /** 设备震动能力：none（无 Vibration API）/ basic（navigator.vibrate）/ advanced（手柄双马达等） */
  getCapability() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    if (pads.some((p) => p.vibrationActuator)) return 'advanced';
    return this._supported ? 'basic' : 'none';
  }

  /** 订阅每次震动请求（手柄震动镜像、调试统计） */
  onVibrate(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  /**
   * 使用自定义模式震动
   * @param {number[]} pattern - 自定义震动模式
   */
  vibratePattern(pattern) {
    if (!this._supported || !this._enabled || this._intensity === 0) {
      return false;
    }

    const scaledPattern = this._scalePattern(pattern, this._intensity);
    
    try {
      navigator.vibrate(scaledPattern);
      return true;
    } catch (err) {
      console.warn('[HapticManager] 自定义震动失败:', err);
      return false;
    }
  }

  /**
   * 停止震动
   */
  stop() {
    if (this._supported) {
      navigator.vibrate(0);
    }
  }

  /**
   * 设置震动强度
   * @param {number} intensity - 0-3
   */
  setIntensity(intensity) {
    this._intensity = Math.max(0, Math.min(3, intensity));
    this._saveSettings();
  }

  /**
   * 获取当前震动强度
   */
  getIntensity() {
    return this._intensity;
  }

  /**
   * 启用/禁用震动
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled;
    this._saveSettings();
  }

  /**
   * 是否启用震动
   */
  isEnabled() {
    return this._enabled && this._supported;
  }

  /**
   * 设置静音模式增强
   * @param {boolean} boost
   */
  setSilentModeBoost(boost) {
    this._silentModeBoost = boost;
    this._saveSettings();
  }

  /**
   * 关联 AudioManager 用于静音检测
   * @param {Object} audioManager
   */
  setAudioManager(audioManager) {
    this._audioManager = audioManager;
  }

  /**
   * 检查设备是否支持震动
   */
  isSupported() {
    return this._supported;
  }

  /**
   * 获取所有可用模式名称
   */
  getAvailablePatterns() {
    return Object.keys(HapticManager.PATTERNS);
  }

  // ── 私有方法 ─────────────────────────────────────────────

  _checkSupport() {
    return 'vibrate' in navigator;
  }

  _setupUnlock() {
    // iOS Safari 需要用户交互后才能触发震动
    const unlock = () => {
      this._unlocked = true;
      // 触发一次极短震动来"激活"震动能力
      if (this._supported) {
        navigator.vibrate(1);
      }
    };

    // 监听首次用户交互
    const events = ['touchstart', 'click', 'keydown'];
    events.forEach(event => {
      document.addEventListener(event, unlock, { once: true, passive: true });
    });
  }

  _scalePattern(pattern, intensity) {
    if (intensity === 0) return [];
    
    // 强度映射系数
    const scaleMap = {
      [HapticManager.INTENSITY.LIGHT]: 0.5,
      [HapticManager.INTENSITY.MEDIUM]: 1.0,
      [HapticManager.INTENSITY.STRONG]: 1.5
    };
    
    const scale = (scaleMap[intensity] || 1.0) * (this._scalePct / 100);
    
    // 震动时长缩放，暂停时长不变
    return pattern.map((value, index) => {
      if (index % 2 === 0) {
        // 震动时长（单段上限 1000ms）
        return Math.min(1000, Math.round(value * scale));
      } else {
        // 暂停时长保持不变
        return value;
      }
    });
  }

  _loadSettings() {
    try {
      const stored = localStorage.getItem('haptic_settings');
      if (stored) {
        const settings = JSON.parse(stored);
        this._enabled = settings.enabled ?? true;
        this._intensity = settings.intensity ?? HapticManager.INTENSITY.MEDIUM;
        this._silentModeBoost = settings.silentModeBoost ?? true;
      }
    } catch (err) {
      console.warn('[HapticManager] 加载设置失败:', err);
    }
  }

  _saveSettings() {
    try {
      localStorage.setItem('haptic_settings', JSON.stringify({
        enabled: this._enabled,
        intensity: this._intensity,
        silentModeBoost: this._silentModeBoost
      }));
    } catch (err) {
      console.warn('[HapticManager] 保存设置失败:', err);
    }
  }
}

// 导出单例
export const hapticManager = new HapticManager();

// 默认导出
export default HapticManager;
