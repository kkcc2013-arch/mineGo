# REQ-00316: 游戏触觉反馈增强与震动优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00316 |
| 标题 | 游戏触觉反馈增强与震动优化系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、catch-service、gym-service、backend/shared |
| 创建时间 | 2026-06-24 10:00 |

## 需求描述

为游戏客户端实现完整的触觉反馈系统，通过精确的震动模式增强游戏体验，并提供无障碍适配选项。触觉反馈应覆盖精灵捕捉、战斗、UI交互等核心场景，同时支持不同设备的震动能力适配和用户个性化配置。

### 核心目标

1. **沉浸式体验**：通过差异化震动模式提升游戏沉浸感
2. **无障碍支持**：为视觉障碍玩家提供触觉反馈替代方案
3. **个性化配置**：支持用户自定义震动强度和模式
4. **设备适配**：兼容不同设备的震动硬件能力

## 技术方案

### 1. 触觉反馈管理器

```javascript
// frontend/game-client/src/haptics/HapticsManager.js

class HapticsManager {
  constructor() {
    this.isSupported = false;
    this.userPreferences = {
      enabled: true,
      intensity: 1.0, // 0.0 - 1.0
      patterns: {
        catch: true,
        battle: true,
        ui: true,
        navigation: true
      }
    };
    this.hapticPatterns = new Map();
    this.capabilityLevel = 'none'; // 'none', 'basic', 'advanced'
  }

  async initialize() {
    await this.detectCapabilities();
    await this.loadUserPreferences();
    this.registerPatterns();
    
    logger.info('HapticsManager initialized', {
      isSupported: this.isSupported,
      capabilityLevel: this.capabilityLevel
    });
  }

  async detectCapabilities() {
    // 检测 Vibration API 支持
    if (!navigator.vibrate) {
      this.isSupported = false;
      this.capabilityLevel = 'none';
      return;
    }

    this.isSupported = true;

    // 检测高级震动模式支持（模式序列、自定义时长）
    try {
      navigator.vibrate(1);
      navigator.vibrate(0);
      
      // 测试复杂模式支持
      const complexPattern = [100, 50, 100, 50, 100];
      navigator.vibrate(complexPattern);
      
      this.capabilityLevel = 'advanced';
    } catch (e) {
      this.capabilityLevel = 'basic';
    }
  }

  registerPatterns() {
    // 精灵捕捉触觉模式
    this.hapticPatterns.set('catch_attempt', {
      basic: [50],
      advanced: [30, 20, 30, 20, 50]
    });

    this.hapticPatterns.set('catch_success', {
      basic: [100],
      advanced: [100, 50, 50, 50, 100, 50, 50, 50, 150]
    });

    this.hapticPatterns.set('catch_miss', {
      basic: [30],
      advanced: [50, 30, 50]
    });

    this.hapticPatterns.set('catch_excellent', {
      basic: [200],
      advanced: [50, 30, 50, 30, 50, 30, 100, 50, 200]
    });

    // 战斗触觉模式
    this.hapticPatterns.set('battle_attack', {
      basic: [50],
      advanced: [30, 20, 80]
    });

    this.hapticPatterns.set('battle_hit', {
      basic: [70],
      advanced: [50, 30, 50, 30, 50]
    });

    this.hapticPatterns.set('battle_critical', {
      basic: [100],
      advanced: [100, 50, 50, 50, 100]
    });

    this.hapticPatterns.set('battle_faint', {
      basic: [150],
      advanced: [200, 100, 200, 100, 200]
    });

    this.hapticPatterns.set('battle_victory', {
      basic: [200],
      advanced: [100, 50, 100, 50, 100, 50, 200]
    });

    // UI 交互触觉模式
    this.hapticPatterns.set('ui_tap', {
      basic: [10],
      advanced: [10]
    });

    this.hapticPatterns.set('ui_long_press', {
      basic: [30],
      advanced: [30]
    });

    this.hapticPatterns.set('ui_scroll_boundary', {
      basic: [20],
      advanced: [20, 10, 20]
    });

    this.hapticPatterns.set('ui_error', {
      basic: [50],
      advanced: [100, 50, 100]
    });

    this.hapticPatterns.set('ui_success', {
      basic: [40],
      advanced: [40, 20, 40]
    });

    // 导航触觉模式
    this.hapticPatterns.set('navigation_step', {
      basic: [5],
      advanced: [5]
    });

    this.hapticPatterns.set('navigation_nearby_pokemon', {
      basic: [20],
      advanced: [10, 5, 10, 5, 20]
    });

    this.hapticPatterns.set('navigation_arrival', {
      basic: [50],
      advanced: [50, 30, 50, 30, 100]
    });

    // 特殊事件触觉模式
    this.hapticPatterns.set('level_up', {
      basic: [150],
      advanced: [50, 30, 50, 30, 50, 30, 50, 30, 150]
    });

    this.hapticPatterns.set('achievement_unlock', {
      basic: [200],
      advanced: [100, 50, 50, 50, 100, 50, 50, 50, 200]
    });

    this.hapticPatterns.set('item_pickup', {
      basic: [30],
      advanced: [20, 10, 30]
    });

    // 无障碍专用模式
    this.hapticPatterns.set('a11y_button_focus', {
      basic: [5],
      advanced: [5]
    });

    this.hapticPatterns.set('a11y_error_announce', {
      basic: [100],
      advanced: [150, 50, 150, 50, 150]
    });

    this.hapticPatterns.set('a11y_direction_change', {
      basic: [10],
      advanced: [10]
    });
  }

  async loadUserPreferences() {
    try {
      const stored = await storage.get('haptics_preferences');
      if (stored) {
        this.userPreferences = { ...this.userPreferences, ...stored };
      }
    } catch (error) {
      logger.warn('Failed to load haptics preferences', { error: error.message });
    }
  }

  async saveUserPreferences() {
    try {
      await storage.set('haptics_preferences', this.userPreferences);
    } catch (error) {
      logger.error('Failed to save haptics preferences', { error: error.message });
    }
  }

  /**
   * 触发触觉反馈
   * @param {string} patternName - 模式名称
   * @param {object} options - 选项
   * @param {number} options.intensity - 强度覆盖 (0.0 - 2.0)
   * @param {string} options.category - 分类 (用于检查用户偏好)
   */
  vibrate(patternName, options = {}) {
    if (!this.isSupported || !this.userPreferences.enabled) {
      return false;
    }

    const { intensity, category } = options;

    // 检查分类偏好
    if (category && this.userPreferences.patterns[category] === false) {
      return false;
    }

    const pattern = this.hapticPatterns.get(patternName);
    if (!pattern) {
      logger.warn(`Unknown haptic pattern: ${patternName}`);
      return false;
    }

    // 根据设备能力选择模式
    const rawPattern = pattern[this.capabilityLevel] || pattern.basic;
    
    // 应用强度调整
    const finalPattern = this.applyIntensity(rawPattern, intensity || this.userPreferences.intensity);

    try {
      navigator.vibrate(finalPattern);
      
      metrics.increment('haptics.triggered', {
        pattern: patternName,
        capability: this.capabilityLevel
      });

      return true;
    } catch (error) {
      logger.error('Haptic feedback failed', {
        pattern: patternName,
        error: error.message
      });
      return false;
    }
  }

  applyIntensity(pattern, intensity) {
    if (intensity === 1.0) {
      return pattern;
    }

    // 强度为 0 时静默
    if (intensity === 0) {
      return [];
    }

    // 根据强度调整震动时长
    return pattern.map((duration, index) => {
      // 偶数索引是震动时长，奇数索引是暂停时长
      if (index % 2 === 0) {
        return Math.round(duration * intensity);
      }
      return duration;
    });
  }

  /**
   * 停止所有震动
   */
  stop() {
    if (this.isSupported) {
      navigator.vibrate(0);
    }
  }

  /**
   * 更新用户偏好
   */
  async updatePreferences(newPreferences) {
    this.userPreferences = { ...this.userPreferences, ...newPreferences };
    await this.saveUserPreferences();
    
    metrics.gauge('haptics.preference_enabled', this.userPreferences.enabled ? 1 : 0);
    metrics.gauge('haptics.preference_intensity', this.userPreferences.intensity);
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      isSupported: this.isSupported,
      capabilityLevel: this.capabilityLevel,
      preferences: this.userPreferences,
      availablePatterns: Array.from(this.hapticPatterns.keys())
    };
  }
}

export const hapticsManager = new HapticsManager();
```

### 2. 场景集成模块

```javascript
// frontend/game-client/src/haptics/HapticsIntegrator.js

import { hapticsManager } from './HapticsManager';

class HapticsIntegrator {
  /**
   * 捕捉场景集成
   */
  static onCatchAttempt() {
    hapticsManager.vibrate('catch_attempt', { category: 'catch' });
  }

  static onCatchSuccess(quality = 'normal') {
    const pattern = quality === 'excellent' ? 'catch_excellent' : 'catch_success';
    hapticsManager.vibrate(pattern, { category: 'catch' });
  }

  static onCatchMiss() {
    hapticsManager.vibrate('catch_miss', { category: 'catch' });
  }

  static onBerryUse() {
    hapticsManager.vibrate('item_pickup', { category: 'ui' });
  }

  /**
   * 战斗场景集成
   */
  static onBattleAttack(moveType = 'normal') {
    hapticsManager.vibrate('battle_attack', { category: 'battle' });
  }

  static onBattleHit(isCritical = false) {
    const pattern = isCritical ? 'battle_critical' : 'battle_hit';
    hapticsManager.vibrate(pattern, { category: 'battle', intensity: isCritical ? 1.3 : 1.0 });
  }

  static onBattleFaint() {
    hapticsManager.vibrate('battle_faint', { category: 'battle' });
  }

  static onBattleVictory() {
    hapticsManager.vibrate('battle_victory', { category: 'battle' });
  }

  static onBattleDefeat() {
    hapticsManager.vibrate('battle_faint', { category: 'battle' });
  }

  /**
   * UI 场景集成
   */
  static onUITap() {
    hapticsManager.vibrate('ui_tap', { category: 'ui', intensity: 0.7 });
  }

  static onUILongPress() {
    hapticsManager.vibrate('ui_long_press', { category: 'ui' });
  }

  static onUIScrollBoundary() {
    hapticsManager.vibrate('ui_scroll_boundary', { category: 'ui' });
  }

  static onUIError() {
    hapticsManager.vibrate('ui_error', { category: 'ui' });
  }

  static onUISuccess() {
    hapticsManager.vibrate('ui_success', { category: 'ui' });
  }

  /**
   * 导航场景集成
   */
  static onNavigationStep() {
    hapticsManager.vibrate('navigation_step', { category: 'navigation', intensity: 0.3 });
  }

  static onNearbyPokemon(distance) {
    // 根据距离调整强度
    const intensity = Math.max(0.5, 1.5 - distance / 100);
    hapticsManager.vibrate('navigation_nearby_pokemon', {
      category: 'navigation',
      intensity
    });
  }

  static onArrival(locationType) {
    hapticsManager.vibrate('navigation_arrival', { category: 'navigation' });
  }

  /**
   * 特殊事件集成
   */
  static onLevelUp() {
    hapticsManager.vibrate('level_up', { intensity: 1.5 });
  }

  static onAchievementUnlock() {
    hapticsManager.vibrate('achievement_unlock', { intensity: 1.5 });
  }

  static onItemPickup() {
    hapticsManager.vibrate('item_pickup', { category: 'ui' });
  }

  /**
   * 无障碍专用集成
   */
  static onA11yButtonFocus() {
    hapticsManager.vibrate('a11y_button_focus', { category: 'ui' });
  }

  static onA11yErrorAnnounce() {
    hapticsManager.vibrate('a11y_error_announce', { category: 'ui' });
  }

  static onA11yDirectionChange() {
    hapticsManager.vibrate('a11y_direction_change', { category: 'navigation' });
  }
}

export { HapticsIntegrator };
```

### 3. 触觉反馈设置面板

```javascript
// frontend/game-client/src/components/HapticsSettingsPanel.js

import React, { useState, useEffect } from 'react';
import { hapticsManager } from '../haptics/HapticsManager';
import './HapticsSettingsPanel.css';

const HapticsSettingsPanel = ({ onClose }) => {
  const [settings, setSettings] = useState({
    enabled: true,
    intensity: 1.0,
    patterns: {
      catch: true,
      battle: true,
      ui: true,
      navigation: true
    }
  });

  const [deviceSupport, setDeviceSupport] = useState(null);

  useEffect(() => {
    const status = hapticsManager.getStatus();
    setSettings(status.preferences);
    setDeviceSupport({
      isSupported: status.isSupported,
      capabilityLevel: status.capabilityLevel
    });
  }, []);

  const handleToggle = async () => {
    const newEnabled = !settings.enabled;
    setSettings(prev => ({ ...prev, enabled: newEnabled }));
    await hapticsManager.updatePreferences({ enabled: newEnabled });
    
    // 提供即时反馈
    if (newEnabled) {
      hapticsManager.vibrate('ui_success');
    }
  };

  const handleIntensityChange = async (value) => {
    setSettings(prev => ({ ...prev, intensity: value }));
    await hapticsManager.updatePreferences({ intensity: value });
    
    // 即时预览
    hapticsManager.vibrate('ui_tap', { intensity: value });
  };

  const handlePatternToggle = async (category) => {
    const newPatterns = {
      ...settings.patterns,
      [category]: !settings.patterns[category]
    };
    setSettings(prev => ({ ...prev, patterns: newPatterns }));
    await hapticsManager.updatePreferences({ patterns: newPatterns });
    
    // 即时预览
    if (newPatterns[category]) {
      const previewPatterns = {
        catch: 'catch_success',
        battle: 'battle_hit',
        ui: 'ui_tap',
        navigation: 'navigation_arrival'
      };
      hapticsManager.vibrate(previewPatterns[category], { category });
    }
  };

  const handleTestPattern = (patternName) => {
    hapticsManager.vibrate(patternName, { intensity: settings.intensity });
  };

  if (!deviceSupport) {
    return <div className="haptics-settings loading">加载中...</div>;
  }

  if (!deviceSupport.isSupported) {
    return (
      <div className="haptics-settings not-supported">
        <h2>触觉反馈</h2>
        <p>您的设备不支持震动功能</p>
        <button onClick={onClose}>关闭</button>
      </div>
    );
  }

  return (
    <div className="haptics-settings">
      <h2>触觉反馈设置</h2>
      
      <div className="device-info">
        <span className={`badge ${deviceSupport.capabilityLevel}`}>
          {deviceSupport.capabilityLevel === 'advanced' ? '高级震动' : '基础震动'}
        </span>
      </div>

      <div className="setting-group">
        <div className="setting-row">
          <label>启用触觉反馈</label>
          <button
            className={`toggle ${settings.enabled ? 'active' : ''}`}
            onClick={handleToggle}
          >
            {settings.enabled ? '开' : '关'}
          </button>
        </div>
      </div>

      {settings.enabled && (
        <>
          <div className="setting-group">
            <label>震动强度</label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={settings.intensity}
              onChange={(e) => handleIntensityChange(parseFloat(e.target.value))}
              disabled={!settings.enabled}
            />
            <span className="intensity-value">
              {Math.round(settings.intensity * 100)}%
            </span>
          </div>

          <div className="setting-group">
            <label>场景触觉</label>
            <div className="pattern-toggles">
              {Object.entries(settings.patterns).map(([category, enabled]) => (
                <div key={category} className="pattern-row">
                  <span>{getCategoryName(category)}</span>
                  <button
                    className={`toggle small ${enabled ? 'active' : ''}`}
                    onClick={() => handlePatternToggle(category)}
                  >
                    {enabled ? '✓' : '✗'}
                  </button>
                  <button
                    className="test-button"
                    onClick={() => handleTestPattern(getTestPattern(category))}
                  >
                    测试
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="setting-group">
            <label>模式测试</label>
            <div className="test-patterns">
              <button onClick={() => handleTestPattern('catch_success')}>
                捕捉成功
              </button>
              <button onClick={() => handleTestPattern('battle_critical')}>
                暴击
              </button>
              <button onClick={() => handleTestPattern('level_up')}>
                升级
              </button>
              <button onClick={() => handleTestPattern('achievement_unlock')}>
                成就解锁
              </button>
            </div>
          </div>
        </>
      )}

      <div className="actions">
        <button onClick={onClose}>完成</button>
      </div>
    </div>
  );
};

function getCategoryName(category) {
  const names = {
    catch: '捕捉场景',
    battle: '战斗场景',
    ui: '界面交互',
    navigation: '导航'
  };
  return names[category] || category;
}

function getTestPattern(category) {
  const patterns = {
    catch: 'catch_success',
    battle: 'battle_hit',
    ui: 'ui_tap',
    navigation: 'navigation_arrival'
  };
  return patterns[category];
}

export default HapticsSettingsPanel;
```

### 4. 无障碍增强模块

```javascript
// frontend/game-client/src/haptics/AccessibilityHaptics.js

import { hapticsManager } from './HapticsManager';

/**
 * 无障碍触觉反馈增强
 * 为视觉障碍用户提供更详细的触觉反馈
 */
class AccessibilityHaptics {
  constructor() {
    this.enabled = false;
    this.mode = 'standard'; // 'standard', 'enhanced', 'minimal'
  }

  initialize(accessibilitySettings) {
    this.enabled = accessibilitySettings.screenReaderEnabled || false;
    this.mode = accessibilitySettings.hapticsMode || 'standard';
    
    if (this.enabled) {
      this.enhanceHapticsManager();
    }
  }

  enhanceHapticsManager() {
    // 添加额外的无障碍模式
    hapticsManager.hapticPatterns.set('a11y_text_cursor', {
      basic: [3],
      advanced: [3]
    });

    hapticsManager.hapticPatterns.set('a11y_element_highlight', {
      basic: [10],
      advanced: [10, 5, 10]
    });

    hapticsManager.hapticPatterns.set('a11y_action_available', {
      basic: [15],
      advanced: [10, 5, 15]
    });

    hapticsManager.hapticPatterns.set('a11y_distance_feedback', {
      basic: [5],
      advanced: [5]
    });

    hapticsManager.hapticPatterns.set('a11y_obstacle_warning', {
      basic: [80],
      advanced: [100, 50, 100, 50, 100]
    });

    // 根据模式调整强度
    if (this.mode === 'enhanced') {
      hapticsManager.updatePreferences({ intensity: 1.5 });
    }
  }

  /**
   * 距离反馈 - 根据目标距离提供渐变触觉
   */
  provideDistanceFeedback(distance, maxDistance = 200) {
    if (!this.enabled || !this.shouldProvideFeedback('navigation')) {
      return;
    }

    // 距离越近，震动越频繁
    const proximity = 1 - (distance / maxDistance);
    const intensity = Math.max(0.3, proximity);
    
    if (proximity > 0.8) {
      // 非常近
      hapticsManager.vibrate('a11y_distance_feedback', {
        category: 'navigation',
        intensity: intensity * 1.5
      });
    } else if (proximity > 0.5) {
      // 较近
      hapticsManager.vibrate('a11y_distance_feedback', {
        category: 'navigation',
        intensity: intensity
      });
    }
    // 较远时不提供反馈，避免干扰
  }

  /**
   * 方向指引反馈
   */
  provideDirectionFeedback(angle, targetAngle) {
    if (!this.enabled) {
      return;
    }

    const angleDiff = Math.abs(angle - targetAngle);
    
    if (angleDiff < 15) {
      // 正确方向
      hapticsManager.vibrate('ui_success', { intensity: 0.5 });
    } else if (angleDiff < 45) {
      // 接近正确方向
      hapticsManager.vibrate('a11y_direction_change', { intensity: 0.3 });
    }
  }

  /**
   * 障碍物警告
   */
  provideObstacleWarning(type = 'nearby') {
    if (!this.enabled) {
      return;
    }

    const intensity = type === 'immediate' ? 2.0 : 1.0;
    hapticsManager.vibrate('a11y_obstacle_warning', {
      category: 'navigation',
      intensity
    });
  }

  /**
   * 元素高亮反馈
   */
  provideElementHighlight(elementType) {
    if (!this.enabled) {
      return;
    }

    hapticsManager.vibrate('a11y_element_highlight', {
      category: 'ui',
      intensity: 0.7
    });
  }

  /**
   * 可操作元素提示
   */
  indicateActionAvailable(actionType) {
    if (!this.enabled) {
      return;
    }

    hapticsManager.vibrate('a11y_action_available', {
      category: 'ui',
      intensity: 0.8
    });
  }

  shouldProvideFeedback(category) {
    const preferences = hapticsManager.userPreferences;
    return preferences.enabled && preferences.patterns[category] !== false;
  }

  updateMode(newMode) {
    this.mode = newMode;
    
    switch (newMode) {
      case 'enhanced':
        hapticsManager.updatePreferences({ intensity: 1.5 });
        break;
      case 'minimal':
        hapticsManager.updatePreferences({ intensity: 0.5 });
        break;
      default:
        hapticsManager.updatePreferences({ intensity: 1.0 });
    }
  }
}

export const accessibilityHaptics = new AccessibilityHaptics();
```

### 5. 后端配置 API

```javascript
// backend/services/user-service/routes/haptics.js

import express from 'express';
import { authenticate } from '../../shared/middleware/auth.js';
import { validateRequest } from '../../shared/middleware/validation.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';

const router = express.Router();

/**
 * 获取用户触觉反馈偏好
 */
router.get('/preferences', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  
  const preferences = await db.query(`
    SELECT haptics_preferences
    FROM user_settings
    WHERE user_id = $1
  `, [userId]);

  res.json({
    success: true,
    data: preferences.rows[0]?.haptics_preferences || getDefaultPreferences()
  });
}));

/**
 * 更新用户触觉反馈偏好
 */
router.put('/preferences', 
  authenticate,
  validateRequest({
    body: {
      enabled: { type: 'boolean', optional: true },
      intensity: { type: 'number', min: 0, max: 2, optional: true },
      patterns: {
        type: 'object',
        optional: true,
        properties: {
          catch: { type: 'boolean' },
          battle: { type: 'boolean' },
          ui: { type: 'boolean' },
          navigation: { type: 'boolean' }
        }
      }
    }
  }),
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const updates = req.body;

    // 获取当前偏好
    const current = await db.query(`
      SELECT haptics_preferences
      FROM user_settings
      WHERE user_id = $1
    `, [userId]);

    const currentPrefs = current.rows[0]?.haptics_preferences || getDefaultPreferences();
    const newPrefs = { ...currentPrefs, ...updates };

    // 保存更新
    await db.query(`
      INSERT INTO user_settings (user_id, haptics_preferences, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET haptics_preferences = $2, updated_at = NOW()
    `, [userId, JSON.stringify(newPrefs)]);

    // 记录审计日志
    await auditLogger.log({
      userId,
      action: 'haptics_preferences_updated',
      metadata: { changes: updates }
    });

    res.json({
      success: true,
      data: newPrefs
    });
  })
);

/**
 * 获取设备能力报告
 */
router.post('/device-report', 
  authenticate,
  validateRequest({
    body: {
      isSupported: { type: 'boolean' },
      capabilityLevel: { type: 'string', enum: ['none', 'basic', 'advanced'] },
      deviceModel: { type: 'string', optional: true },
      osVersion: { type: 'string', optional: true }
    }
  }),
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const report = req.body;

    // 保存设备能力报告用于统计和优化
    await db.query(`
      INSERT INTO device_haptics_reports
      (user_id, is_supported, capability_level, device_model, os_version, reported_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, report.isSupported, report.capabilityLevel, report.deviceModel, report.osVersion]);

    res.json({ success: true });
  })
);

/**
 * 获取推荐模式
 */
router.get('/recommendations', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // 获取用户设备能力
  const deviceReport = await db.query(`
    SELECT capability_level
    FROM device_haptics_reports
    WHERE user_id = $1
    ORDER BY reported_at DESC
    LIMIT 1
  `, [userId]);

  const capability = deviceReport.rows[0]?.capability_level || 'basic';

  // 获取用户无障碍设置
  const a11ySettings = await db.query(`
    SELECT screen_reader_enabled, reduced_motion
    FROM user_accessibility_settings
    WHERE user_id = $1
  `, [userId]);

  const recommendations = {
    standard: getDefaultPreferences(),
    accessibility: null
  };

  // 为无障碍用户提供特殊推荐
  if (a11ySettings.rows[0]?.screen_reader_enabled) {
    recommendations.accessibility = {
      enabled: true,
      intensity: 1.3,
      patterns: {
        catch: true,
        battle: true,
        ui: true,
        navigation: true
      },
      mode: 'enhanced'
    };
  }

  // 根据设备能力调整推荐
  if (capability === 'advanced') {
    recommendations.standard.intensity = 1.0;
  } else if (capability === 'basic') {
    recommendations.standard.intensity = 0.8;
  }

  res.json({
    success: true,
    data: recommendations
  });
}));

function getDefaultPreferences() {
  return {
    enabled: true,
    intensity: 1.0,
    patterns: {
      catch: true,
      battle: true,
      ui: true,
      navigation: true
    }
  };
}

export default router;
```

### 6. 数据库迁移

```sql
-- database/migrations/20260624_haptics_system.sql

-- 用户触觉偏好设置表（如果不存在）
CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  haptics_preferences JSONB DEFAULT '{
    "enabled": true,
    "intensity": 1.0,
    "patterns": {
      "catch": true,
      "battle": true,
      "ui": true,
      "navigation": true
    }
  }'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 设备触觉能力报告表
CREATE TABLE IF NOT EXISTS device_haptics_reports (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  is_supported BOOLEAN NOT NULL,
  capability_level VARCHAR(20) NOT NULL CHECK (capability_level IN ('none', 'basic', 'advanced')),
  device_model VARCHAR(100),
  os_version VARCHAR(50),
  reported_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_device_haptics_user ON device_haptics_reports(user_id);
CREATE INDEX idx_device_haptics_capability ON device_haptics_reports(capability_level);

-- 触觉使用统计表
CREATE TABLE IF NOT EXISTS haptics_usage_stats (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  pattern_name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL,
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  intensity FLOAT,
  device_capability VARCHAR(20)
);

CREATE INDEX idx_haptics_usage_user ON haptics_usage_stats(user_id);
CREATE INDEX idx_haptics_usage_pattern ON haptics_usage_stats(pattern_name);
CREATE INDEX idx_haptics_usage_date ON haptics_usage_stats(triggered_at);

-- 注释
COMMENT ON TABLE user_settings IS '用户设置，包含触觉反馈偏好';
COMMENT ON TABLE device_haptics_reports IS '设备触觉能力报告，用于优化体验';
COMMENT ON TABLE haptics_usage_stats IS '触觉反馈使用统计';
```

### 7. 性能监控

```javascript
// frontend/game-client/src/haptics/HapticsMonitor.js

class HapticsMonitor {
  constructor() {
    this.stats = {
      totalTriggers: 0,
      patternsTriggered: {},
      averageLatency: 0,
      errors: 0
    };
    this.latencySamples = [];
  }

  recordTrigger(patternName, latencyMs) {
    this.stats.totalTriggers++;
    this.stats.patternsTriggered[patternName] = 
      (this.stats.patternsTriggered[patternName] || 0) + 1;

    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > 100) {
      this.latencySamples.shift();
    }

    this.stats.averageLatency = 
      this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length;
  }

  recordError() {
    this.stats.errors++;
  }

  getReport() {
    return {
      ...this.stats,
      topPatterns: Object.entries(this.stats.patternsTriggered)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ pattern: name, count }))
    };
  }
}

export const hapticsMonitor = new HapticsMonitor();
```

## 验收标准

- [ ] 支持检测设备震动能力（basic/advanced/none）
- [ ] 实现 20+ 种触觉反馈模式
- [ ] 捕捉场景集成：尝试、成功、失败、优秀投球
- [ ] 战斗场景集成：攻击、命中、暴击、昏厥、胜利
- [ ] UI 场景集成：点击、长按、滚动边界、错误、成功
- [ ] 导航场景集成：步伐、附近精灵、到达目的地
- [ ] 特殊事件：升级、成就解锁、道具拾取
- [ ] 用户可配置震动强度（0-200%）
- [ ] 用户可按场景启用/禁用触觉反馈
- [ ] 无障碍增强模式支持
- [ ] 设置面板提供即时预览功能
- [ ] 后端 API 保存用户偏好
- [ ] 设备能力报告收集
- [ ] 性能监控和统计

## 影响范围

- **game-client**: 新增触觉反馈系统、设置面板
- **user-service**: 新增触觉偏好 API
- **database/migrations**: 新增相关表结构
- **backend/shared**: 无变更

## 参考

- [Vibration API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Vibration_API)
- [Haptic Feedback Best Practices - Apple](https://developer.apple.com/design/human-interface-guidelines/patterns/playing-haptics/)
- [Accessibility Guidelines for Haptics - W3C](https://www.w3.org/TR/wai-aria-practices/)
