/**
 * FlashFrequencyAnalyzer - 闪光频率分析器
 * 实时检测游戏动画中的危险闪烁，预防光敏性癫痫
 */

export class FlashFrequencyAnalyzer {
  constructor(options = {}) {
    this.history = [];
    this.maxHistoryLength = options.maxHistoryLength || 60; // 1秒@60fps
    this.threshold = options.threshold || 0.2; // 20%亮度变化=闪光
    this.maxSafeHz = options.maxSafeHz || 3; // 安全阈值：3Hz
    this.enabled = true;
  }

  /**
   * 分析单帧亮度变化
   * @param {Object} frame - 帧数据 { brightness, timestamp }
   * @returns {Object} 分析结果
   */
  analyze(frame) {
    if (!this.enabled) {
      return { isDangerous: false, frequency: 0, recommendation: 'disabled' };
    }

    const brightness = frame.brightness || this.calculateBrightness(frame);
    const timestamp = frame.timestamp || Date.now();
    
    const previousBrightness = this.history[this.history.length - 1]?.brightness;
    
    if (previousBrightness !== undefined) {
      const delta = Math.abs(brightness - previousBrightness);
      
      this.history.push({
        brightness,
        delta,
        timestamp
      });

      // 保持历史记录长度
      if (this.history.length > this.maxHistoryLength) {
        this.history.shift();
      }

      // 检测闪光频率
      const flashCount = this.detectFlashes();
      const frequency = flashCount; // flashes per second

      return {
        isDangerous: frequency > this.maxSafeHz,
        frequency,
        recommendation: this.getRecommendation(frequency),
        currentBrightness: brightness,
        delta,
        historyLength: this.history.length
      };
    }

    // 第一帧，仅记录
    this.history.push({ brightness, delta: 0, timestamp });
    return { isDangerous: false, frequency: 0, recommendation: 'initial' };
  }

  /**
   * 计算帧亮度（简化版）
   * @param {Object} frame - 帧数据
   * @returns {number} 亮度值 0-1
   */
  calculateBrightness(frame) {
    // 如果帧提供了平均亮度，直接使用
    if (frame.averageBrightness !== undefined) {
      return frame.averageBrightness;
    }

    // 如果提供了颜色数据，计算亮度
    if (frame.colors) {
      let totalBrightness = 0;
      let count = 0;
      
      for (const color of frame.colors) {
        // 使用感知亮度公式：0.299*R + 0.587*G + 0.114*B
        const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
        totalBrightness += brightness;
        count++;
      }
      
      return count > 0 ? totalBrightness / count : 0;
    }

    // 默认值
    return frame.brightness || 0.5;
  }

  /**
   * 检测闪光次数
   * @returns {number} 每秒闪光次数
   */
  detectFlashes() {
    if (this.history.length < 3) return 0;

    let flashCount = 0;
    let prevSign = null;
    let flashTimestamps = [];

    for (let i = 1; i < this.history.length; i++) {
      const delta = this.history[i].delta;
      const sign = delta > this.threshold ? 1 : 
                   delta < -this.threshold ? -1 : 0;
      
      if (prevSign && sign !== prevSign && sign !== 0) {
        flashCount++;
        flashTimestamps.push(this.history[i].timestamp);
      }
      
      if (sign !== 0) prevSign = sign;
    }

    // 计算实际频率（基于时间窗口）
    if (flashTimestamps.length >= 2) {
      const timeWindow = flashTimestamps[flashTimestamps.length - 1] - flashTimestamps[0];
      if (timeWindow > 0) {
        return (flashCount / (timeWindow / 1000)).toFixed(1);
      }
    }

    return flashCount;
  }

  /**
   * 根据频率给出建议
   * @param {number} frequency - 闪光频率
   * @returns {string} 建议
   */
  getRecommendation(frequency) {
    if (frequency <= this.maxSafeHz) {
      return 'safe';
    } else if (frequency <= 5) {
      return 'warning: consider reducing flash intensity';
    } else if (frequency <= 10) {
      return 'danger: reduce flash frequency immediately';
    } else {
      return 'critical: disable animation or use static alternative';
    }
  }

  /**
   * 批量分析帧序列
   * @param {Array} frames - 帧序列
   * @returns {Object} 分析报告
   */
  analyzeFrames(frames) {
    const results = [];
    let dangerousFrames = 0;
    let maxFrequency = 0;

    for (const frame of frames) {
      const result = this.analyze(frame);
      results.push(result);
      
      if (result.isDangerous) {
        dangerousFrames++;
        maxFrequency = Math.max(maxFrequency, result.frequency);
      }
    }

    return {
      totalFrames: frames.length,
      dangerousFrames,
      maxFrequency,
      safeRate: ((frames.length - dangerousFrames) / frames.length * 100).toFixed(1),
      recommendations: this.generateReport(results)
    };
  }

  /**
   * 生成分析报告
   * @param {Array} results - 分析结果数组
   * @returns {Object} 报告对象
   */
  generateReport(results) {
    const dangerousResults = results.filter(r => r.isDangerous);
    
    return {
      summary: dangerousResults.length > 0 ? 
        `检测到 ${dangerousResults.length} 个危险帧，最大闪光频率 ${Math.max(...results.map(r => r.frequency))} Hz` :
        '所有帧符合安全标准',
      action: dangerousResults.length > 0 ? 'downgrade' : 'none',
      suggestedAlternative: dangerousResults.length > frames.length * 0.3 ?
        'static' : 'reduced'
    };
  }

  /**
   * 重置分析器状态
   */
  reset() {
    this.history = [];
  }

  /**
   * 更新安全阈值
   * @param {number} maxSafeHz - 新的安全阈值
   */
  setThreshold(maxSafeHz) {
    this.maxSafeHz = maxSafeHz;
  }

  /**
   * 启用/禁用分析器
   * @param {boolean} enabled - 是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }
}

/**
 * ContrastAnalyzer - 对比度分析器
 * 分析颜色对比度，防止高对比度闪烁
 */
export class ContrastAnalyzer {
  constructor() {
    this.maxSafeContrast = 4.5; // WCAG AA标准
  }

  /**
   * 计算两个颜色之间的对比度
   * @param {Object} color1 - { r, g, b }
   * @param {Object} color2 - { r, g, b }
   * @returns {number} 对比度比值
   */
  calculateContrast(color1, color2) {
    const lum1 = this.getLuminance(color1);
    const lum2 = this.getLuminance(color2);
    
    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);
    
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * 计算颜色相对亮度
   * @param {Object} color - { r, g, b }
   * @returns {number} 相对亮度
   */
  getLuminance(color) {
    const r = this.normalize(color.r);
    const g = this.normalize(color.g);
    const b = this.normalize(color.b);
    
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * 标准化颜色值
   * @param {number} value - 0-255
   * @returns {number} 标准化值
   */
  normalize(value) {
    value = value / 255;
    return value <= 0.03928 ?
      value / 12.92 :
      Math.pow((value + 0.055) / 1.055, 2.4);
  }

  /**
   * 检查颜色序列对比度安全性
   * @param {Array} colors - 颜色序列
   * @returns {Object} 分析结果
   */
  analyzeSequence(colors) {
    let maxContrast = 0;
    let dangerousPairs = [];

    for (let i = 1; i < colors.length; i++) {
      const contrast = this.calculateContrast(colors[i-1], colors[i]);
      
      if (contrast > this.maxSafeContrast) {
        dangerousPairs.push({
          index: i,
          contrast,
          colors: [colors[i-1], colors[i]]
        });
      }
      
      maxContrast = Math.max(maxContrast, contrast);
    }

    return {
      safe: dangerousPairs.length === 0,
      maxContrast,
      dangerousPairs,
      recommendation: dangerousPairs.length > 0 ? 
        'reduce contrast between consecutive colors' : 'safe'
    };
  }
}

export default FlashFrequencyAnalyzer;