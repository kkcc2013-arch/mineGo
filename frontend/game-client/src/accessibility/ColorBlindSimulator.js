/**
 * 色盲模拟器
 * 使用 Brettel, Viénot, Mollon 算法模拟色盲视觉效果
 * 用于开发者测试和预览
 * 
 * @module ColorBlindSimulator
 */

/**
 * 色盲转换矩阵（基于 Brettel, Viénot, Mollon 算法）
 */
const COLOR_BLIND_MATRICES = {
  // 红色盲（Protanopia）
  protanopia: [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758]
  ],
  
  // 绿色盲（Deuteranopia）
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7]
  ],
  
  // 蓝色盲（Tritanopia）
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525]
  ],
  
  // 全色盲（Achromatopsia）- 灰度
  achromatopsia: [
    [0.299, 0.587, 0.114],
    [0.299, 0.587, 0.114],
    [0.299, 0.587, 0.114]
  ]
};

/**
 * 色盲模拟器类
 */
class ColorBlindSimulator {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.isActive = false;
    this.currentType = 'normal';
  }

  /**
   * 初始化模拟器
   */
  init() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
  }

  /**
   * 应用颜色转换矩阵
   */
  applyMatrix(r, g, b, matrix) {
    return {
      r: Math.round(matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b),
      g: Math.round(matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b),
      b: Math.round(matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b)
    };
  }

  /**
   * 模拟图像数据
   */
  simulateImageData(imageData, type) {
    if (type === 'normal' || !COLOR_BLIND_MATRICES[type]) {
      return imageData;
    }

    const matrix = COLOR_BLIND_MATRICES[type];
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const simulated = this.applyMatrix(r, g, b, matrix);

      data[i] = Math.min(255, Math.max(0, simulated.r));
      data[i + 1] = Math.min(255, Math.max(0, simulated.g));
      data[i + 2] = Math.min(255, Math.max(0, simulated.b));
    }

    return imageData;
  }

  /**
   * 模拟元素截图
   */
  async simulateElement(element, type) {
    if (!this.canvas) this.init();

    // 使用 html2canvas 或类似库截取元素
    // 这里提供简化版本
    const rect = element.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;

    // 绘制元素到 canvas
    // 实际实现需要 html2canvas 或类似库
    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    return this.simulateImageData(imageData, type);
  }

  /**
   * 实时预览模式（通过 CSS filter 模拟）
   */
  enablePreviewMode(type) {
    if (!COLOR_BLIND_MATRICES[type] && type !== 'normal') {
      console.error(`Invalid color blind type: ${type}`);
      return;
    }

    this.currentType = type;
    this.isActive = true;

    // 移除所有预览类
    document.body.classList.remove(
      'cb-preview-protanopia',
      'cb-preview-deuteranopia',
      'cb-preview-tritanopia',
      'cb-preview-achromatopsia'
    );

    if (type !== 'normal') {
      document.body.classList.add(`cb-preview-${type}`);
    }

    console.log(`[ColorBlindSimulator] Preview mode enabled: ${type}`);
  }

  /**
   * 禁用预览模式
   */
  disablePreviewMode() {
    document.body.classList.remove(
      'cb-preview-protanopia',
      'cb-preview-deuteranopia',
      'cb-preview-tritanopia',
      'cb-preview-achromatopsia'
    );

    this.isActive = false;
    this.currentType = 'normal';

    console.log('[ColorBlindSimulator] Preview mode disabled');
  }

  /**
   * 切换预览模式
   */
  togglePreviewMode(type) {
    if (this.isActive && this.currentType === type) {
      this.disablePreviewMode();
    } else {
      this.enablePreviewMode(type);
    }
  }

  /**
   * 检测颜色对比度
   */
  calculateContrastRatio(color1, color2) {
    const getLuminance = (r, g, b) => {
      const [rs, gs, bs] = [r, g, b].map(c => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };

    const l1 = getLuminance(color1.r, color1.g, color1.b);
    const l2 = getLuminance(color2.r, color2.g, color2.b);

    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);

    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * 检查 WCAG 2.1 对比度合规性
   */
  checkContrastCompliance(foreground, background, level = 'AA') {
    const ratio = this.calculateContrastRatio(foreground, background);

    const requirements = {
      'AA': {
        normalText: 4.5,
        largeText: 3,
        ui: 3
      },
      'AAA': {
        normalText: 7,
        largeText: 4.5,
        ui: 3
      }
    };

    const req = requirements[level] || requirements['AA'];

    return {
      ratio: ratio.toFixed(2),
      passesNormalText: ratio >= req.normalText,
      passesLargeText: ratio >= req.largeText,
      passesUI: ratio >= req.ui,
      level: level,
      recommendation: ratio < req.normalText
        ? `建议提高对比度至至少 ${req.normalText}:1 (当前 ${ratio.toFixed(2)}:1)`
        : '对比度符合标准'
    };
  }

  /**
   * 批量检查元素对比度
   */
  auditPageContrast() {
    const results = [];

    // 检查所有文本元素
    const textElements = document.querySelectorAll('p, span, div, h1, h2, h3, h4, h5, h6, a, button, label');

    textElements.forEach(element => {
      const style = window.getComputedStyle(element);
      const color = this.parseColor(style.color);
      const bgColor = this.getEffectiveBackgroundColor(element);

      if (color && bgColor) {
        const check = this.checkContrastCompliance(color, bgColor);
        if (!check.passesNormalText) {
          results.push({
            element: element.tagName,
            text: element.textContent.substring(0, 50),
            ...check
          });
        }
      }
    });

    return {
      totalChecked: textElements.length,
      issues: results.length,
      issues: results,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 解析颜色字符串
   */
  parseColor(colorStr) {
    // 简单的颜色解析
    const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      return {
        r: parseInt(match[1]),
        g: parseInt(match[2]),
        b: parseInt(match[3])
      };
    }
    return null;
  }

  /**
   * 获取元素的有效背景颜色
   */
  getEffectiveBackgroundColor(element) {
    let current = element;
    while (current) {
      const style = window.getComputedStyle(current);
      const bgColor = style.backgroundColor;

      if (bgColor && bgColor !== 'transparent' && bgColor !== 'rgba(0, 0, 0, 0)') {
        return this.parseColor(bgColor);
      }

      current = current.parentElement;
    }

    // 默认白色背景
    return { r: 255, g: 255, b: 255 };
  }
}

// 导出单例
const colorBlindSimulator = new ColorBlindSimulator();

export {
  colorBlindSimulator,
  ColorBlindSimulator,
  COLOR_BLIND_MATRICES
};

export default colorBlindSimulator;

// 挂载到 window 供开发工具使用
if (typeof window !== 'undefined') {
  window.colorBlindSimulator = colorBlindSimulator;
  window.auditContrast = () => colorBlindSimulator.auditPageContrast();
}
