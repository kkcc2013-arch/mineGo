/**
 * SafeAnimationRenderer - 安全动画渲染器
 * 结合闪光频率检测和运动限制，为光敏性和运动敏感玩家提供安全的动画渲染
 */

import { FlashFrequencyAnalyzer, ContrastAnalyzer } from './FlashFrequencyAnalyzer.js';
import { MotionLimiter } from './MotionLimiter.js';

// 癫痫防护级别配置
const EPILEPSY_PROTECTION_LEVELS = {
  off: {
    name: '关闭',
    description: '无任何限制',
    flashLimit: null,
    contrastLimit: null,
    animationRestriction: 'none'
  },
  moderate: {
    name: '中等防护',
    description: '减少闪烁，限制对比度',
    flashLimit: { maxHz: 3, maxBrightness: 0.7 },
    contrastLimit: { maxRatio: 4.5 },
    animationRestriction: 'reduce_flashes'
  },
  strong: {
    name: '强防护',
    description: '禁用所有闪烁和快速动画',
    flashLimit: { maxHz: 0, maxBrightness: 0.5 },
    contrastLimit: { maxRatio: 2.0 },
    animationRestriction: 'disable_flashes',
    alternatives: 'static_images'
  }
};

// 高风险动画降级规则
const ANIMATION_DOWNGRADE_RULES = {
  evolution_flash: {
    dangerLevel: 'critical',
    original: { type: 'flash', duration: 2000, intensity: 1.0 },
    moderate: { type: 'glow', duration: 3000, intensity: 0.5 },
    strong: { type: 'static', image: 'evolution_success.png' }
  },
  battle_beam: {
    dangerLevel: 'high',
    original: { type: 'laser', flickerRate: 10, colors: ['red', 'blue'] },
    moderate: { type: 'laser', flickerRate: 2, colors: ['white'] },
    strong: { type: 'static', image: 'beam_hit.png' }
  },
  catch_explosion: {
    dangerLevel: 'high',
    original: { type: 'particles', count: 100, sparkle: true },
    moderate: { type: 'particles', count: 20, sparkle: false },
    strong: { type: 'fade', duration: 500 }
  },
  lightning: {
    dangerLevel: 'critical',
    original: { type: 'flash', randomInterval: true },
    moderate: { type: 'dim_flash', maxIntensity: 0.3 },
    strong: { type: 'static_overlay', image: 'clouds.png' }
  },
  gym_flash: {
    dangerLevel: 'high',
    original: { type: 'flash', intensity: 0.8 },
    moderate: { type: 'glow', intensity: 0.3 },
    strong: { type: 'static', image: 'gym_battle_result.png' }
  },
  skill_particles: {
    dangerLevel: 'medium',
    original: { type: 'particles', count: 50, sparkle: true },
    moderate: { type: 'particles', count: 15, sparkle: false },
    strong: { type: 'static', image: 'skill_effect.png' }
  }
};

export class SafeAnimationRenderer {
  constructor(userPreferences = {}) {
    this.preferences = {
      epilepsy_protection: userPreferences.epilepsy_protection || 'moderate',
      motion_sensitivity_enabled: userPreferences.motion_sensitivity_enabled || false,
      ...userPreferences
    };

    this.flashAnalyzer = new FlashFrequencyAnalyzer({
      maxSafeHz: this.getMaxFlashHz(),
      threshold: 0.2
    });

    this.contrastAnalyzer = new ContrastAnalyzer();
    this.motionLimiter = new MotionLimiter(this.preferences);
    
    this.enabled = true;
    this.safetyLog = [];
  }

  /**
   * 获取当前防护级别的最大闪光频率
   * @returns {number} 最大允许频率
   */
  getMaxFlashHz() {
    const level = EPILEPSY_PROTECTION_LEVELS[this.preferences.epilepsy_protection];
    return level?.flashLimit?.maxHz || 3;
  }

  /**
   * 渲染安全动画
   * @param {Object} animation - 原始动画对象
   * @returns {Object} 安全渲染结果
   */
  async renderAnimation(animation) {
    if (!this.enabled) {
      return { animation, safety: { applied: false, reason: 'disabled' } };
    }

    // 1. 检查动画风险等级
    const rule = ANIMATION_DOWNGRADE_RULES[animation.id];
    
    // 2. 根据防护级别应用安全设置
    const safeAnimation = this.applySafetySettings(animation, rule);

    // 3. 运动敏感性检查
    const motionSafeAnimation = this.motionLimiter.applyMotionReduction(safeAnimation);

    // 4. 闪光频率检查（如果动画包含帧数据）
    if (animation.frames && this.preferences.epilepsy_protection !== 'off') {
      const flashAnalysis = this.flashAnalyzer.analyzeFrames(animation.frames);
      
      if (flashAnalysis.dangerousFrames > 0) {
        // 记录安全事件
        this.logSafetyEvent({
          animationId: animation.id,
          type: 'flash_danger',
          severity: flashAnalysis.maxFrequency > 10 ? 'critical' : 'high',
          details: flashAnalysis
        });

        // 自动降级
        return this.renderAlternative(motionSafeAnimation, rule?.strong || { type: 'static' });
      }
    }

    // 5. 记录安全渲染
    this.logSafetyEvent({
      animationId: animation.id,
      type: 'render_safe',
      severity: 'info',
      details: { applied: true, protectionLevel: this.preferences.epilepsy_protection }
    });

    return {
      animation: motionSafeAnimation,
      safety: {
        applied: true,
        protectionLevel: this.preferences.epilepsy_protection,
        motionReduced: this.preferences.motion_sensitivity_enabled,
        flashChecked: this.preferences.epilepsy_protection !== 'off'
      }
    };
  }

  /**
   * 应用安全设置
   * @param {Object} animation - 原始动画
   * @param {Object} rule - 安全规则
   * @returns {Object} 安全动画
   */
  applySafetySettings(animation, rule) {
    const protectionLevel = this.preferences.epilepsy_protection;

    if (protectionLevel === 'off') {
      return animation;
    }

    if (!rule) {
      // 无特定规则，应用通用限制
      return this.applyGenericLimits(animation);
    }

    // 强防护：直接使用静态替代
    if (protectionLevel === 'strong') {
      return {
        ...animation,
        type: rule.strong?.type || 'static',
        image: rule.strong?.image || animation.staticFallback,
        duration: 100,
        safetyApplied: true
      };
    }

    // 中等防护：应用中等降级规则
    if (protectionLevel === 'moderate') {
      return {
        ...animation,
        ...rule.moderate,
        safetyApplied: true,
        flashLimitEnabled: true
      };
    }

    return animation;
  }

  /**
   * 应用通用闪光限制
   * @param {Object} animation - 动画对象
   * @returns {Object} 限制后的动画
   */
  applyGenericLimits(animation) {
    const level = EPILEPSY_PROTECTION_LEVELS[this.preferences.epilepsy_protection];
    
    if (!level.flashLimit) {
      return animation;
    }

    return {
      ...animation,
      maxBrightness: level.flashLimit.maxBrightness,
      maxContrastRatio: level.contrastLimit?.maxRatio,
      flashLimitEnabled: true,
      safetyApplied: true
    };
  }

  /**
   * 渲染替代方案
   * @param {Object} animation - 原动画
   * @param {Object} alternative - 替代方案
   * @returns {Object} 渲染结果
   */
  renderAlternative(animation, alternative) {
    return {
      animation: {
        ...animation,
        type: alternative.type,
        image: alternative.image,
        duration: alternative.duration || 100,
        safetyApplied: true,
        alternativeUsed: true
      },
      safety: {
        applied: true,
        alternative: true,
        reason: 'dangerous_animation_downgraded'
      }
    };
  }

  /**
   * 预检查动画安全性
   * @param {Object} animation - 动画对象
   * @returns {Object} 安全检查结果
   */
  preCheckAnimation(animation) {
    const rule = ANIMATION_DOWNGRADE_RULES[animation.id];
    
    if (!rule) {
      return { safe: true, riskLevel: 'unknown' };
    }

    const riskLevel = rule.dangerLevel;
    const protectionLevel = this.preferences.epilepsy_protection;

    // 强防护下，任何高风险动画都需要替代
    if (protectionLevel === 'strong' && riskLevel !== 'low') {
      return {
        safe: false,
        riskLevel,
        action: 'use_alternative',
        alternative: rule.strong
      };
    }

    // 中等防护下，检查是否需要降级
    if (protectionLevel === 'moderate' && (riskLevel === 'high' || riskLevel === 'critical')) {
      return {
        safe: false,
        riskLevel,
        action: 'downgrade',
        alternative: rule.moderate
      };
    }

    return {
      safe: true,
      riskLevel,
      action: 'none'
    };
  }

  /**
   * 记录安全事件
   * @param {Object} event - 事件详情
   */
  logSafetyEvent(event) {
    this.safetyLog.push({
      timestamp: Date.now(),
      ...event
    });

    // 保持日志长度限制
    if (this.safetyLog.length > 100) {
      this.safetyLog.shift();
    }
  }

  /**
   * 获取安全日志
   * @returns {Array} 安全事件日志
   */
  getSafetyLog() {
    return this.safetyLog;
  }

  /**
   * 更新用户偏好
   * @param {Object} newPreferences - 新偏好设置
   */
  updatePreferences(newPreferences) {
    this.preferences = {
      ...this.preferences,
      ...newPreferences
    };

    // 更新闪光分析器阈值
    this.flashAnalyzer.setThreshold(this.getMaxFlashHz());
    
    // 更新运动限制器
    this.motionLimiter.updatePreferences(newPreferences);
  }

  /**
   * 获取当前防护级别配置
   * @returns {Object} 当前配置
   */
  getCurrentConfiguration() {
    return {
      epilepsyProtection: {
        level: this.preferences.epilepsy_protection,
        config: EPILEPSY_PROTECTION_LEVELS[this.preferences.epilepsy_protection]
      },
      motionSensitivity: this.motionLimiter.getConfiguration(),
      enabled: this.enabled
    };
  }

  /**
   * 启用/禁用安全渲染器
   * @param {boolean} enabled - 是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    this.flashAnalyzer.setEnabled(enabled);
  }

  /**
   * 获取高风险动画列表
   * @returns {Array} 高风险动画配置
   */
  getHighRiskAnimations() {
    return Object.entries(ANIMATION_DOWNGRADE_RULES)
      .filter(([_, rule]) => rule.dangerLevel === 'critical' || rule.dangerLevel === 'high')
      .map(([id, rule]) => ({
        id,
        dangerLevel: rule.dangerLevel,
        original: rule.original,
        alternatives: {
          moderate: rule.moderate,
          strong: rule.strong
        }
      }));
  }

  /**
   * 批量渲染动画序列
   * @param {Array} animations - 动画序列
   * @returns {Array} 渲染结果序列
   */
  async renderAnimationSequence(animations) {
    return animations.map(anim => this.renderAnimation(anim));
  }
}

/**
 * AnimationSafetyMonitor - 动画安全监控器
 * 实时监控渲染过程中的安全事件
 */
export class AnimationSafetyMonitor {
  constructor(renderer) {
    this.renderer = renderer;
    this.violations = [];
    this.metrics = {
      totalAnimations: 0,
      safeAnimations: 0,
      downgradedAnimations: 0,
      staticAlternatives: 0
    };
  }

  /**
   * 监控单帧渲染
   * @param {Object} frame - 渲染帧
   * @param {Object} preferences - 用户偏好
   * @returns {Object} 监控结果
   */
  checkFrame(frame, preferences) {
    const violations = [];

    // 闪光检查
    if (preferences.epilepsy_protection !== 'off') {
      const flashResult = this.renderer.flashAnalyzer.analyze(frame);
      
      if (flashResult.isDangerous) {
        violations.push({
          type: 'flash_danger',
          severity: flashResult.frequency > 10 ? 'critical' : 'high',
          details: flashResult
        });
      }
    }

    // 运动检查
    if (preferences.motion_sensitivity_enabled) {
      const motionType = this.renderer.motionLimiter.classifyMotion(frame);
      const reduction = this.renderer.motionLimiter.motionTypes[motionType]?.reduction || 0;
      
      if (reduction >= 1.0 && frame.type !== 'static') {
        violations.push({
          type: 'motion_danger',
          severity: 'medium',
          details: { motionType, reduction }
        });
      }
    }

    // 更新指标
    this.metrics.totalAnimations++;
    
    if (violations.length > 0) {
      this.violations.push({
        timestamp: Date.now(),
        violations,
        frameId: frame.id
      });

      this.metrics.downgradedAnimations++;
      
      // 自动降级
      return {
        safe: false,
        action: 'downgrade',
        alternative: this.getSafeAlternative(frame, preferences)
      };
    }

    this.metrics.safeAnimations++;
    return { safe: true };
  }

  /**
   * 获取安全替代方案
   * @param {Object} frame - 原帧
   * @param {Object} preferences - 偏好
   * @returns {Object} 替代方案
   */
  getSafeAlternative(frame, preferences) {
    if (preferences.epilepsy_protection === 'strong') {
      return {
        type: 'static',
        image: frame.staticFallback || 'safe_placeholder.png',
        duration: 100
      };
    }

    return {
      type: 'reduced',
      ...frame,
      intensity: frame.intensity * 0.3,
      speed: frame.speed * 0.5
    };
  }

  /**
   * 获取监控报告
   * @returns {Object} 监控报告
   */
  getReport() {
    return {
      metrics: this.metrics,
      safetyRate: (this.metrics.safeAnimations / this.metrics.totalAnimations * 100).toFixed(1),
      recentViolations: this.violations.slice(-10),
      rendererConfig: this.renderer.getCurrentConfiguration()
    };
  }

  /**
   * 重置监控状态
   */
  reset() {
    this.violations = [];
    this.metrics = {
      totalAnimations: 0,
      safeAnimations: 0,
      downgradedAnimations: 0,
      staticAlternatives: 0
    };
  }
}

export default SafeAnimationRenderer;
export { EPILEPSY_PROTECTION_LEVELS, ANIMATION_DOWNGRADE_RULES };