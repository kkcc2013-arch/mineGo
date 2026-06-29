/**
 * MotionLimiter - 运动敏感性限制器
 * 减少或禁用快速运动、旋转、缩放动画，为运动敏感玩家提供舒适体验
 */

export class MotionLimiter {
  constructor(preferences = {}) {
    // 默认运动类型和限制值
    this.motionTypes = {
      rotation: {
        name: '旋转运动',
        reduction: preferences.rotation_reduction || 0.5,
        examples: ['精灵选择转盘', '物品轮盘', '3D模型旋转']
      },
      translation: {
        name: '快速移动',
        reduction: preferences.translation_reduction || 0.3,
        examples: ['镜头快速切换', '地图滚动', '滑动捕捉']
      },
      scaling: {
        name: '缩放动画',
        reduction: preferences.scaling_reduction || 0.4,
        examples: ['精灵放大详情', 'UI 弹窗缩放', '地图缩放']
      },
      parallax: {
        name: '视差效果',
        reduction: preferences.parallax_reduction || 0.6,
        examples: ['地图背景层', '3D场景深度', 'UI 浮动效果']
      },
      particles: {
        name: '粒子效果',
        reduction: preferences.particles_reduction || 0.5,
        examples: ['星星散射', '技能粒子', '天气粒子']
      }
    };

    this.enabled = preferences.motion_sensitivity_enabled || false;
  }

  /**
   * 分类动画的运动类型
   * @param {Object} animation - 动画对象
   * @returns {string} 运动类型
   */
  classifyMotion(animation) {
    if (animation.rotation || animation.rotate) return 'rotation';
    if (animation.translate || animation.move || animation.velocity) return 'translation';
    if (animation.scale || animation.zoom) return 'scaling';
    if (animation.parallax || animation.depth) return 'parallax';
    if (animation.particles || animation.particleCount) return 'particles';
    
    // 默认根据类型属性判断
    return animation.motionType || 'translation';
  }

  /**
   * 应用运动限制
   * @param {Object} animation - 原始动画对象
   * @returns {Object} 限制后的动画对象
   */
  applyMotionReduction(animation) {
    if (!this.enabled) {
      return animation;
    }

    const type = this.classifyMotion(animation);
    const reduction = this.motionTypes[type]?.reduction || 0;

    // 完全禁用 (reduction >= 1.0)
    if (reduction >= 1.0) {
      return this.getStaticAlternative(animation);
    }

    // 应用运动限制
    const limitedAnimation = { ...animation };

    // 旋转限制
    if (type === 'rotation' && animation.rotation) {
      limitedAnimation.rotation = {
        speed: animation.rotation.speed * (1 - reduction),
        duration: animation.rotation.duration * (1 + reduction),
        angle: animation.rotation.angle * (1 - reduction)
      };
    }

    // 移动限制
    if (type === 'translation' && animation.velocity) {
      limitedAnimation.velocity = animation.velocity * (1 - reduction);
      limitedAnimation.duration = animation.duration * (1 + reduction);
      limitedAnimation.easing = 'easeInOut'; // 使用更平滑的缓动函数
    }

    // 缩放限制
    if (type === 'scaling' && animation.scale) {
      limitedAnimation.scale = {
        from: animation.scale.from,
        to: animation.scale.from + (animation.scale.to - animation.scale.from) * (1 - reduction),
        duration: animation.scale.duration * (1 + reduction)
      };
    }

    // 视差限制
    if (type === 'parallax' && animation.parallax) {
      limitedAnimation.parallax = {
        layers: animation.parallax.layers.map(layer => ({
          ...layer,
          speed: layer.speed * (1 - reduction),
          offset: layer.offset * (1 - reduction)
        }))
      };
    }

    // 粒子限制
    if (type === 'particles' && animation.particles) {
      limitedAnimation.particles = {
        count: Math.ceil(animation.particles.count * (1 - reduction)),
        speed: animation.particles.speed * (1 - reduction),
        lifetime: animation.particles.lifetime * (1 - reduction),
        sparkle: reduction > 0.5 ? false : animation.particles.sparkle
      };
    }

    return limitedAnimation;
  }

  /**
   * 获取静态替代方案
   * @param {Object} animation - 动画对象
   * @returns {Object} 静态替代动画
   */
  getStaticAlternative(animation) {
    return {
      type: 'static',
      image: animation.staticFallback || animation.fallbackImage || 'placeholder.png',
      duration: 100, // 最短持续时间
      description: animation.name || '静态替代'
    };
  }

  /**
   * 批量处理动画序列
   * @param {Array} animations - 动画序列
   * @returns {Array} 处理后的动画序列
   */
  processAnimationSequence(animations) {
    return animations.map(anim => this.applyMotionReduction(anim));
  }

  /**
   * 更新运动类型限制值
   * @param {string} type - 运动类型
   * @param {number} reduction - 限制值 (0-1)
   */
  setReduction(type, reduction) {
    if (this.motionTypes[type]) {
      this.motionTypes[type].reduction = Math.max(0, Math.min(1, reduction));
    }
  }

  /**
   * 批量更新限制值
   * @param {Object} preferences - 偏好对象
   */
  updatePreferences(preferences) {
    this.enabled = preferences.motion_sensitivity_enabled || false;
    
    for (const [type, prefs] of Object.entries(preferences)) {
      if (type.endsWith('_reduction') && this.motionTypes[type.replace('_reduction', '')]) {
        this.motionTypes[type.replace('_reduction', '')].reduction = prefs;
      }
    }
  }

  /**
   * 获取当前限制配置
   * @returns {Object} 当前配置
   */
  getConfiguration() {
    return {
      enabled: this.enabled,
      motionTypes: Object.entries(this.motionTypes).map(([key, value]) => ({
        type: key,
        name: value.name,
        reduction: value.reduction,
        examples: value.examples
      }))
    };
  }

  /**
   * 禁用所有运动动画
   * @returns {Object} 禁用配置
   */
  disableAllMotion() {
    for (const type of Object.keys(this.motionTypes)) {
      this.motionTypes[type].reduction = 1.0;
    }
    this.enabled = true;
    
    return {
      allMotionDisabled: true,
      configuration: this.getConfiguration()
    };
  }

  /**
   * 启用所有运动动画（恢复默认）
   * @returns {Object} 默认配置
   */
  enableAllMotion() {
    const defaults = {
      rotation: 0.5,
      translation: 0.3,
      scaling: 0.4,
      parallax: 0.6,
      particles: 0.5
    };

    for (const [type, reduction] of Object.entries(defaults)) {
      this.motionTypes[type].reduction = reduction;
    }
    this.enabled = false;
    
    return {
      allMotionEnabled: true,
      configuration: this.getConfiguration()
    };
  }
}

/**
 * VelocityReducer - 速度递减器
 * 对特定类型的运动进行速度优化
 */
export class VelocityReducer {
  /**
   * 减少旋转速度
   * @param {Object} rotation - 旋转参数
   * @param {number} reduction - 减少比例
   * @returns {Object} 优化后的旋转参数
   */
  reduceRotation(rotation, reduction) {
    return {
      ...rotation,
      speed: rotation.speed * (1 - reduction),
      duration: rotation.duration * (1 + reduction * 0.5),
      easing: 'easeInOutQuad' // 更平滑的缓动
    };
  }

  /**
   * 减少平移速度
   * @param {Object} translation - 平移参数
   * @param {number} reduction - 减少比例
   * @returns {Object} 优化后的平移参数
   */
  reduceTranslation(translation, reduction) {
    return {
      ...translation,
      velocity: translation.velocity * (1 - reduction),
      duration: translation.duration * (1 + reduction),
      smoothStart: true,
      smoothEnd: true
    };
  }

  /**
   * 减少缩放速度
   * @param {Object} scaling - 缩放参数
   * @param {number} reduction - 减少比例
   * @returns {Object} 优化后的缩放参数
   */
  reduceScaling(scaling, reduction) {
    const range = scaling.to - scaling.from;
    return {
      ...scaling,
      to: scaling.from + range * (1 - reduction),
      duration: scaling.duration * (1 + reduction * 1.5),
      easing: 'easeInOutCubic'
    };
  }
}

export default MotionLimiter;