/**
 * Color Blind Friendly Design - 色盲友好设计
 * 提供图标+颜色双重编码
 */

export const ColorBlindFriendly = {
  // 精灵类型配置（图标 + 颜色 + 纹理）
  pokemonTypes: {
    fire: { 
      color: '#c41e00', 
      icon: '🔥', 
      pattern: 'stripes',
      name: '火'
    },
    water: { 
      color: '#0052cc', 
      icon: '💧', 
      pattern: 'dots',
      name: '水'
    },
    grass: { 
      color: '#0a6000', 
      icon: '🌿', 
      pattern: 'crosses',
      name: '草'
    },
    electric: { 
      color: '#b55800', 
      icon: '⚡', 
      pattern: 'waves',
      name: '电'
    },
    psychic: { 
      color: '#7b0099', 
      icon: '🔮', 
      pattern: 'spirals',
      name: '超能'
    },
    ice: { 
      color: '#00a0c0', 
      icon: '❄️', 
      pattern: 'diamonds',
      name: '冰'
    },
    dragon: { 
      color: '#5a0080', 
      icon: '🐲', 
      pattern: 'scales',
      name: '龙'
    },
    dark: { 
      color: '#404040', 
      icon: '🌑', 
      pattern: 'shadows',
      name: '暗'
    },
    fairy: { 
      color: '#e080a0', 
      icon: '✨', 
      pattern: 'sparkles',
      name: '妖精'
    },
    fighting: { 
      color: '#802020', 
      icon: '👊', 
      pattern: 'slashes',
      name: '格斗'
    },
    flying: { 
      color: '#6080a0', 
      icon: '🦅', 
      pattern: 'clouds',
      name: '飞行'
    },
    poison: { 
      color: '#602080', 
      icon: '☠️', 
      pattern: 'bubbles',
      name: '毒'
    },
    ground: { 
      color: '#806040', 
      icon: '🏜️', 
      pattern: 'layers',
      name: '地面'
    },
    rock: { 
      color: '#807060', 
      icon: '🪨', 
      pattern: 'cracks',
      name: '岩石'
    },
    bug: { 
      color: '#608020', 
      icon: '🐛', 
      pattern: 'hexagons',
      name: '虫'
    },
    steel: { 
      color: '#607080', 
      icon: '⚙️', 
      pattern: 'metal',
      name: '钢'
    },
    ghost: { 
      color: '#404060', 
      icon: '👻', 
      pattern: 'mist',
      name: '幽灵'
    },
    normal: { 
      color: '#606060', 
      icon: '⚪', 
      pattern: 'plain',
      name: '普通'
    }
  },

  /**
   * 渲染精灵类型标签（双重编码）
   */
  renderTypeTag(type) {
    const config = this.pokemonTypes[type] || this.pokemonTypes.normal;
    return `
      <span 
        class="type-tag type-${type}" 
        style="background: ${config.color}"
        aria-label="${config.name}类型精灵"
        data-pattern="${config.pattern}"
      >
        <span class="type-icon" aria-hidden="true">${config.icon}</span>
        <span class="type-name">${config.name}</span>
      </span>
    `;
  },

  /**
   * 渲染精灵类型指示器（带纹理）
   */
  renderTypeIndicator(type) {
    const config = this.pokemonTypes[type] || this.pokemonTypes.normal;
    return {
      color: config.color,
      icon: config.icon,
      pattern: config.pattern,
      ariaLabel: `${config.name}类型`,
      html: `
        <div 
          class="type-indicator"
          style="background-color: ${config.color}"
          aria-label="${config.name}类型"
        >
          <span class="icon" aria-hidden="true">${config.icon}</span>
        </div>
      `
    };
  },

  /**
   * 渲染稀有度指示器（星星 + 颜色）
   */
  renderRarityIndicator(rarity) {
    const stars = rarity;
    const colorMap = {
      1: '#808080', // 普通 - 灰色
      2: '#60a080', // 较少 - 绿色
      3: '#2080c0', // 稀有 - 蓝色
      4: '#c040c0', // 稀有+ - 紫色
      5: '#c0a000'  // 传说 - 金色
    };
    const labelMap = {
      1: '普通',
      2: '较少',
      3: '稀有',
      4: '稀有+',
      5: '传说'
    };

    const starIcons = Array(rarity).fill('⭐').join('');
    const color = colorMap[rarity] || colorMap[1];
    const label = labelMap[rarity] || labelMap[1];

    return `
      <div 
        class="rarity-indicator"
        style="color: ${color}"
        aria-label="${label}稀有度，${rarity}星"
      >
        <span class="stars" aria-hidden="true">${starIcons}</span>
        <span class="sr-only">${label}，${rarity}星</span>
      </div>
    `;
  },

  /**
   * 渲染状态指示器（颜色 + 文字）
   */
  renderStatusIndicator(status) {
    const statusConfig = {
      success: { color: '#0a6000', icon: '✓', label: '成功' },
      warning: { color: '#b55800', icon: '⚠', label: '警告' },
      error: { color: '#c41e00', icon: '✗', label: '错误' },
      info: { color: '#0052cc', icon: 'ℹ', label: '信息' },
      loading: { color: '#606060', icon: '⋯', label: '加载中' }
    };

    const config = statusConfig[status] || statusConfig.info;
    return `
      <span 
        class="status-indicator"
        style="color: ${config.color}"
        aria-label="${config.label}"
      >
        <span aria-hidden="true">${config.icon}</span>
        <span class="sr-only">${config.label}</span>
      </span>
    `;
  },

  /**
   * 获取对比度友好的颜色方案
   */
  getContrastFriendlyColors() {
    return {
      // 主要文本颜色（对比度 >= 4.5:1）
      textPrimary: '#1a1a1a',      // 对比度 16:1
      textSecondary: '#4a4a4a',    // 对比度 7:1
      textOnDark: '#f0f0f0',       // 深色背景上的文本
      
      // 强调色（对比度 >= 4.5:1）
      accentPrimary: '#0052cc',    // 对比度 7:1
      accentSecondary: '#0066cc',  // 对比度 6:1
      
      // 状态色（对比度 >= 4.5:1）
      success: '#0a6000',          // 对比度 5:1
      warning: '#b55800',          // 对比度 4.5:1
      error: '#c41e00',            // 对比度 5:1
      
      // 背景色
      bgPrimary: '#ffffff',
      bgSecondary: '#f5f5f5',
      bgDark: '#0d0f14'
    };
  },

  /**
   * 计算对比度（WCAG 2.1）
   */
  calculateContrastRatio(fgColor, bgColor) {
    // 解析颜色
    const fg = this.parseColor(fgColor);
    const bg = this.parseColor(bgColor);
    
    // 计算相对亮度
    const fgLum = this.getRelativeLuminance(fg);
    const bgLum = this.getRelativeLuminance(bg);
    
    // 计算对比度
    const lighter = Math.max(fgLum, bgLum);
    const darker = Math.min(fgLum, bgLum);
    
    return (lighter + 0.05) / (darker + 0.05);
  },

  /**
   * 解析颜色为 RGB
   */
  parseColor(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  },

  /**
   * 计算相对亮度（WCAG 2.1）
   */
  getRelativeLuminance(rgb) {
    const { r, g, b } = rgb;
    
    const rsrgb = r / 255;
    const gsrgb = g / 255;
    const bsrgb = b / 255;
    
    const rLinear = rsrgb <= 0.03928 ? rsrgb / 12.92 : Math.pow((rsrgb + 0.055) / 1.055, 2.4);
    const gLinear = gsrgb <= 0.03928 ? gsrgb / 12.92 : Math.pow((gsrgb + 0.055) / 1.055, 2.4);
    const bLinear = bsrgb <= 0.03928 ? bsrgb / 12.92 : Math.pow((bsrgb + 0.055) / 1.055, 2.4);
    
    return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
  },

  /**
   * 检查对比度是否符合 WCAG AA 标准
   */
  meetsWCAGAA(fgColor, bgColor) {
    const ratio = this.calculateContrastRatio(fgColor, bgColor);
    return ratio >= 4.5;
  },

  /**
   * 检查对比度是否符合 WCAG AAA 标准
   */
  meetsWCAGAAA(fgColor, bgColor) {
    const ratio = this.calculateContrastRatio(fgColor, bgColor);
    return ratio >= 7;
  }
};

// 导出
export default ColorBlindFriendly;