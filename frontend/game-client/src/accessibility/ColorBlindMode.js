/**
 * 色盲模式支持系统
 * 支持 4 种色盲类型：红色盲(protanopia)、绿色盲(deuteranopia)、蓝色盲(tritanopia)、全色盲(achromatopsia)
 * 
 * @module ColorBlindMode
 */

// 色盲类型定义
const COLOR_BLIND_TYPES = {
  normal: '正常视觉',
  protanopia: '红色盲（无法识别红色）',
  deuteranopia: '绿色盲（无法识别绿色）',
  tritanopia: '蓝色盲（无法识别蓝色）',
  achromatopsia: '全色盲（仅灰度）'
};

// 各类色盲模式的配色方案
const COLOR_PALETTES = {
  normal: {
    primary: '#3d8ef8',    // 蓝色
    secondary: '#e63946',  // 红色
    warning: '#f4c430',    // 黄色
    success: '#2ecc71',    // 绿色
    danger: '#e63946',     // 红色
    info: '#3d8ef8'        // 蓝色
  },
  protanopia: {
    // 红色盲：使用蓝橙色系替代红绿色系
    primary: '#0077BB',    // 蓝
    secondary: '#EE7733',  // 橙
    warning: '#CCBB44',    // 黄
    success: '#009988',    // 青绿
    danger: '#EE3377',     // 粉红
    info: '#33BBEE'        // 浅蓝
  },
  deuteranopia: {
    // 绿色盲：与红色盲类似，使用蓝橙配色
    primary: '#0077BB',
    secondary: '#EE7733',
    warning: '#CCBB44',
    success: '#009988',
    danger: '#EE3377',
    info: '#33BBEE'
  },
  tritanopia: {
    // 蓝色盲：使用青绿-粉红配色
    primary: '#009988',    // 青绿
    secondary: '#EE3377',  // 粉红
    warning: '#DDAA33',    // 橙黄
    success: '#00AA55',    // 绿色
    danger: '#BB4411',     // 深橙
    info: '#77AADD'        // 浅蓝
  },
  achromatopsia: {
    // 全色盲：高对比度灰度方案
    primary: '#444444',
    secondary: '#777777',
    warning: '#999999',
    success: '#666666',
    danger: '#111111',
    info: '#888888'
  }
};

// 精灵稀有度图标标识（形状+颜色双重编码）
const RARITY_ICONS = {
  common: {
    color: '#4CAF50',
    colorBlindSafe: {
      normal: '#4CAF50',
      protanopia: '#009988',
      deuteranopia: '#009988',
      tritanopia: '#00AA55',
      achromatopsia: '#666666'
    },
    icon: '●',        // 实心圆
    shape: 'circle',
    label: '普通',
    pattern: 'solid'
  },
  rare: {
    color: '#2196F3',
    colorBlindSafe: {
      normal: '#2196F3',
      protanopia: '#0077BB',
      deuteranopia: '#0077BB',
      tritanopia: '#009988',
      achromatopsia: '#888888'
    },
    icon: '◆',        // 实心菱形
    shape: 'diamond',
    label: '稀有',
    pattern: 'striped'
  },
  epic: {
    color: '#9C27B0',
    colorBlindSafe: {
      normal: '#9C27B0',
      protanopia: '#9977BB',
      deuteranopia: '#9977BB',
      tritanopia: '#EE3377',
      achromatopsia: '#777777'
    },
    icon: '★',        // 五角星
    shape: 'star',
    label: '史诗',
    pattern: 'dotted'
  },
  legendary: {
    color: '#FFD700',
    colorBlindSafe: {
      normal: '#FFD700',
      protanopia: '#CCBB44',
      deuteranopia: '#CCBB44',
      tritanopia: '#DDAA33',
      achromatopsia: '#999999'
    },
    icon: '☆',        // 空心五角星带边框
    shape: 'star-outline',
    label: '传说',
    pattern: 'crosshatch'
  }
};

// 地图图钉样式（形状+颜色双重编码）
const MAP_PIN_STYLES = {
  wild_pokemon: {
    shape: 'circle',      // 圆形图钉
    icon: 'P',
    color: '#4CAF50',
    label: '野 生精灵'
  },
  gym: {
    shape: 'triangle',    // 三角形图钉
    icon: 'G',
    color: '#E91E63',
    label: '道馆'
  },
  pokestop: {
    shape: 'square',      // 方形图钉
    icon: 'S',
    color: '#2196F3',
    label: '补给站'
  },
  raid: {
    shape: 'star',        // 星形图钉
    icon: 'R',
    color: '#FF9800',
    label: 'Raid'
  }
};

// 战斗状态效果图标化
const STATUS_EFFECTS = {
  poison: {
    icon: '☠️',
    symbol: 'P',
    color: '#9C27B0',
    colorBlindSafe: {
      normal: '#9C27B0',
      protanopia: '#9977BB',
      deuteranopia: '#9977BB',
      tritanopia: '#EE3377',
      achromatopsia: '#777777'
    },
    label: '中毒',
    pattern: 'diagonal-lines'
  },
  burn: {
    icon: '🔥',
    symbol: 'B',
    color: '#F44336',
    colorBlindSafe: {
      normal: '#F44336',
      protanopia: '#EE7733',
      deuteranopia: '#EE7733',
      tritanopia: '#BB4411',
      achromatopsia: '#333333'
    },
    label: '烧伤',
    pattern: 'horizontal-lines'
  },
  paralysis: {
    icon: '⚡',
    symbol: 'L',
    color: '#FFEB3B',
    colorBlindSafe: {
      normal: '#FFEB3B',
      protanopia: '#CCBB44',
      deuteranopia: '#CCBB44',
      tritanopia: '#DDAA33',
      achromatopsia: '#999999'
    },
    label: '麻痹',
    pattern: 'zigzag'
  },
  freeze: {
    icon: '❄️',
    symbol: 'F',
    color: '#00BCD4',
    colorBlindSafe: {
      normal: '#00BCD4',
      protanopia: '#33BBEE',
      deuteranopia: '#33BBEE',
      tritanopia: '#77AADD',
      achromatopsia: '#888888'
    },
    label: '冰冻',
    pattern: 'snowflake'
  },
  sleep: {
    icon: '💤',
    symbol: 'S',
    color: '#9E9E9E',
    colorBlindSafe: {
      normal: '#9E9E9E',
      protanopia: '#AAAAAA',
      deuteranopia: '#AAAAAA',
      tritanopia: '#BBBBBB',
      achromatopsia: '#AAAAAA'
    },
    label: '睡眠',
    pattern: 'dots'
  }
};

// 阵营标识符号化
const TEAM_IDENTITIES = {
  valor: {
    color: '#F44336',
    colorBlindSafe: {
      normal: '#F44336',
      protanopia: '#EE7733',
      deuteranopia: '#EE7733',
      tritanopia: '#BB4411',
      achromatopsia: '#333333'
    },
    shape: '▲',        // 三角形向上
    name: 'Valor',
    icon: '🔥',
    label: '火焰队'
  },
  mystic: {
    color: '#2196F3',
    colorBlindSafe: {
      normal: '#2196F3',
      protanopia: '#0077BB',
      deuteranopia: '#0077BB',
      tritanopia: '#009988',
      achromatopsia: '#888888'
    },
    shape: '■',        // 方形
    name: 'Mystic',
    icon: '❄️',
    label: '寒冰队'
  },
  instinct: {
    color: '#FFEB3B',
    colorBlindSafe: {
      normal: '#FFEB3B',
      protanopia: '#CCBB44',
      deuteranopia: '#CCBB44',
      tritanopia: '#DDAA33',
      achromatopsia: '#999999'
    },
    shape: '●',        // 圆形
    name: 'Instinct',
    icon: '⚡',
    label: '雷电队'
  }
};

/**
 * 色盲模式管理类
 */
class ColorBlindModeManager {
  constructor() {
    this.currentMode = this.loadMode();
    this.listeners = new Set();
  }

  /**
   * 从本地存储加载色盲模式
   */
  loadMode() {
    return localStorage.getItem('pmg_colorblind_mode') || 'normal';
  }

  /**
   * 保存色盲模式到本地存储
   */
  saveMode(mode) {
    localStorage.setItem('pmg_colorblind_mode', mode);
  }

  /**
   * 获取当前色盲模式
   */
  getMode() {
    return this.currentMode;
  }

  /**
   * 设置色盲模式
   */
  setMode(mode) {
    if (!COLOR_BLIND_TYPES[mode]) {
      console.error(`Invalid color blind mode: ${mode}`);
      return false;
    }

    const oldMode = this.currentMode;
    this.currentMode = mode;
    this.saveMode(mode);
    this.applyMode(mode);
    
    // 通知所有监听器
    this.listeners.forEach(listener => {
      try {
        listener(mode, oldMode);
      } catch (err) {
        console.error('[ColorBlindMode] Listener error:', err);
      }
    });

    return true;
  }

  /**
   * 应用色盲模式到页面
   */
  applyMode(mode) {
    // 移除所有色盲模式类
    document.body.classList.remove(
      'color-blind-normal',
      'color-blind-protanopia',
      'color-blind-deuteranopia',
      'color-blind-tritanopia',
      'color-blind-achromatopsia'
    );

    // 添加新模式类
    document.body.classList.add(`color-blind-${mode}`);

    // 更新 CSS 变量
    const palette = COLOR_PALETTES[mode] || COLOR_PALETTES.normal;
    const root = document.documentElement;
    root.style.setProperty('--color-primary', palette.primary);
    root.style.setProperty('--color-secondary', palette.secondary);
    root.style.setProperty('--color-warning', palette.warning);
    root.style.setProperty('--color-success', palette.success);
    root.style.setProperty('--color-danger', palette.danger);
    root.style.setProperty('--color-info', palette.info);

    console.log(`[ColorBlindMode] Applied mode: ${mode}`);
  }

  /**
   * 添加模式变更监听器
   */
  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 获取稀有度图标（根据当前模式）
   */
  getRarityIcon(rarity) {
    const config = RARITY_ICONS[rarity];
    if (!config) return { icon: '?', color: '#999', shape: 'circle', label: '未知' };

    const colorBlindSafe = config.colorBlindSafe[this.currentMode] || config.color;
    return {
      icon: config.icon,
      color: colorBlindSafe,
      shape: config.shape,
      label: config.label,
      pattern: config.pattern
    };
  }

  /**
   * 获取状态效果图标（根据当前模式）
   */
  getStatusEffect(status) {
    const config = STATUS_EFFECTS[status];
    if (!config) return { icon: '?', color: '#999', label: '未知' };

    const colorBlindSafe = config.colorBlindSafe[this.currentMode] || config.color;
    return {
      icon: config.icon,
      symbol: config.symbol,
      color: colorBlindSafe,
      label: config.label,
      pattern: config.pattern
    };
  }

  /**
   * 获取阵营标识（根据当前模式）
   */
  getTeamIdentity(team) {
    const config = TEAM_IDENTITIES[team];
    if (!config) return { shape: '?', color: '#999', label: '未知' };

    const colorBlindSafe = config.colorBlindSafe[this.currentMode] || config.color;
    return {
      shape: config.shape,
      color: colorBlindSafe,
      name: config.name,
      icon: config.icon,
      label: config.label
    };
  }

  /**
   * 获取地图图钉样式（根据当前模式）
   */
  getMapPinStyle(pinType) {
    const config = MAP_PIN_STYLES[pinType];
    if (!config) return { shape: 'circle', icon: '?', color: '#999', label: '未知' };

    return {
      shape: config.shape,
      icon: config.icon,
      color: config.color,
      label: config.label
    };
  }

  /**
   * 获取所有支持的色盲类型
   */
  getSupportedTypes() {
    return Object.entries(COLOR_BLIND_TYPES).map(([key, label]) => ({
      value: key,
      label,
      isCurrent: key === this.currentMode
    }));
  }

  /**
   * 检测用户是否可能有色觉障碍（基于用户设置）
   */
  detectPotentialColorBlindness() {
    // 这里可以集成一些启发式检测逻辑
    // 例如：检查用户是否频繁调整对比度等
    return {
      detected: false,
      suggestion: null
    };
  }
}

// 导出单例
const colorBlindMode = new ColorBlindModeManager();

export {
  colorBlindMode,
  ColorBlindModeManager,
  COLOR_BLIND_TYPES,
  COLOR_PALETTES,
  RARITY_ICONS,
  STATUS_EFFECTS,
  TEAM_IDENTITIES,
  MAP_PIN_STYLES
};

export default colorBlindMode;
