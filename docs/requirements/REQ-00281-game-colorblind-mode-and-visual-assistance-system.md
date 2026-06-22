# REQ-00281: 游戏色盲模式与视觉辅助系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00281 |
| 标题 | 游戏色盲模式与视觉辅助系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client, pokemon-service, backend/shared |
| 创建时间 | 2026-06-22 05:00 |

## 需求描述

游戏约有8%的男性玩家和0.5%的女性玩家存在色觉障碍，当前游戏大量使用颜色作为信息传递方式（精灵属性、战斗状态、地图标记等），导致色盲玩家难以正常游戏。

本需求实现完整的色盲模式系统，包括：
1. **四种色盲类型支持**：红绿色盲（protanopia/deuteranopia）、蓝黄色盲（tritanopia）、全色盲（achromatopsia）
2. **智能颜色替换**：根据色盲类型自动替换问题颜色
3. **图案辅助系统**：为纯颜色信息添加形状/图案/图标辅助
4. **文字标签增强**：关键信息增加文字描述
5. **对比度调整**：提高元素间对比度
6. **色盲模拟预览**：开发者工具预览色盲效果

## 技术方案

### 1. 色盲检测与配置系统

```javascript
// game-client/src/accessibility/colorBlindnessManager.js

class ColorBlindnessManager {
  constructor() {
    this.colorBlindnessTypes = {
      protanopia: {        // 红色盲
        name: '红绿色盲（红色盲）',
        affectedColors: ['red', 'green', 'orange'],
        prevalence: '1% 男性',
        filterMatrix: [/* 色彩转换矩阵 */]
      },
      deuteranopia: {      // 绿色盲
        name: '红绿色盲（绿色盲）',
        affectedColors: ['red', 'green', 'orange'],
        prevalence: '6% 男性',
        filterMatrix: [/* 色彩转换矩阵 */]
      },
      tritanopia: {        // 蓝黄色盲
        name: '蓝黄色盲',
        affectedColors: ['blue', 'yellow', 'purple'],
        prevalence: '0.01% 人口',
        filterMatrix: [/* 色彩转换矩阵 */]
      },
      achromatopsia: {     // 全色盲
        name: '全色盲',
        affectedColors: ['all'],
        prevalence: '0.003% 人口',
        filterMatrix: [/* 灰度转换矩阵 */]
      }
    };
    
    this.currentMode = 'none';
    this.colorMappings = new Map();
    this.patternOverlays = new Map();
  }

  /**
   * 初始化色盲模式
   */
  async init() {
    // 从用户配置加载
    const savedMode = await this.loadUserPreference();
    if (savedMode && this.colorBlindnessTypes[savedMode]) {
      await this.setColorBlindnessMode(savedMode);
    }
    
    // 监听配置变化
    this.listenToConfigChanges();
  }

  /**
   * 设置色盲模式
   */
  async setColorBlindnessMode(mode) {
    if (!this.colorBlindnessTypes[mode] && mode !== 'none') {
      throw new Error(`Invalid color blindness mode: ${mode}`);
    }

    this.currentMode = mode;
    
    // 应用CSS滤镜
    this.applyColorFilter(mode);
    
    // 应用颜色映射
    this.applyColorMappings(mode);
    
    // 应用图案叠加
    this.applyPatternOverlays(mode);
    
    // 保存用户偏好
    await this.saveUserPreference(mode);
    
    // 触发重新渲染
    this.dispatchEvent('colorBlindnessModeChanged', { mode });
  }

  /**
   * 应用颜色滤镜到整个游戏
   */
  applyColorFilter(mode) {
    const root = document.documentElement;
    
    if (mode === 'none') {
      root.style.filter = '';
      root.style.setProperty('--color-blind-filter', 'none');
      return;
    }
    
    const filterMatrix = this.colorBlindnessTypes[mode].filterMatrix;
    const svgFilter = this.createSVGFilter(filterMatrix);
    
    root.style.filter = `url(#${svgFilter})`;
    root.style.setProperty('--color-blind-filter', `url(#${svgFilter})`);
  }

  /**
   * 创建SVG滤镜
   */
  createSVGFilter(matrix) {
    const filterId = `color-blind-filter-${Date.now()}`;
    
    let svg = document.getElementById('color-blind-svg-filters');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'color-blind-svg-filters';
      svg.style.position = 'absolute';
      svg.style.width = '0';
      svg.style.height = '0';
      document.body.appendChild(svg);
    }
    
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.id = filterId;
    
    const feColorMatrix = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
    feColorMatrix.setAttribute('type', 'matrix');
    feColorMatrix.setAttribute('values', matrix.join(' '));
    
    filter.appendChild(feColorMatrix);
    svg.appendChild(filter);
    
    return filterId;
  }
}

export default new ColorBlindnessManager();
```

### 2. 颜色替换映射系统

```javascript
// game-client/src/accessibility/colorMappings.js

const COLOR_MAPPINGS = {
  // 精灵属性颜色映射
  pokemonTypes: {
    fire: {
      default: '#F08030',      // 火红
      protanopia: '#FF8C00',   // 深橙色（增加对比度）
      deuteranopia: '#FFA500', // 橙色
      tritanopia: '#F08030',   // 保持原色
      achromatopsia: '#888888' // 灰色
    },
    grass: {
      default: '#78C850',      // 草绿
      protanopia: '#4682B4',   // 钢蓝色（替换）
      deuteranopia: '#5F9EA0', // 军绿色
      tritanopia: '#78C850',
      achromatopsia: '#708090'
    },
    water: {
      default: '#6890F0',      // 水蓝
      protanopia: '#6890F0',
      deuteranopia: '#6890F0',
      tritanopia: '#4169E1',   // 皇家蓝
      achromatopsia: '#778899'
    },
    // ... 其他属性
  },
  
  // 战斗状态颜色
  battleStatus: {
    effective: {
      default: '#00FF00',      // 绿色 = 有效
      protanopia: '#00BFFF',   // 替换为蓝色
      deuteranopia: '#1E90FF',
      tritanopia: '#00FF00',
      achromatopsia: '#FFFFFF'
    },
    ineffective: {
      default: '#FF0000',      // 红色 = 无效
      protanopia: '#FFD700',   // 替换为金色
      deuteranopia: '#FFD700',
      tritanopia: '#FF0000',
      achromatopsia: '#666666'
    },
    neutral: {
      default: '#FFFFFF',      // 白色 = 中性
      protanopia: '#FFFFFF',
      deuteranopia: '#FFFFFF',
      tritanopia: '#FFFFFF',
      achromatopsia: '#CCCCCC'
    }
  },
  
  // 地图标记颜色
  mapMarkers: {
    pokestop: {
      default: '#00BFFF',      // 蓝色
      protanopia: '#00BFFF',
      deuteranopia: '#00BFFF',
      tritanopia: '#FF69B4',   // 替换为粉色
      achromatopsia: '#A9A9A9'
    },
    gym: {
      default: '#FFD700',      // 金色
      protanopia: '#9370DB',   // 替换为紫色
      deuteranopia: '#9370DB',
      tritanopia: '#FFD700',
      achromatopsia: '#C0C0C0'
    }
  }
};

class ColorMapper {
  constructor(colorBlindnessManager) {
    this.manager = colorBlindnessManager;
    this.mappings = COLOR_MAPPINGS;
  }

  /**
   * 获取适配后的颜色
   */
  getMappedColor(category, key) {
    const categoryMappings = this.mappings[category];
    if (!categoryMappings || !categoryMappings[key]) {
      console.warn(`No color mapping for ${category}.${key}`);
      return null;
    }
    
    const mode = this.manager.currentMode;
    const colorSet = categoryMappings[key];
    
    return colorSet[mode] || colorSet.default;
  }

  /**
   * 应用映射到DOM元素
   */
  applyToElement(element, property, category, key) {
    const color = this.getMappedColor(category, key);
    if (color) {
      element.style[property] = color;
    }
  }

  /**
   * 批量应用颜色映射
   */
  applyAllMappings() {
    // 精灵属性标签
    document.querySelectorAll('[data-pokemon-type]').forEach(el => {
      const type = el.dataset.pokemonType;
      this.applyToElement(el, 'backgroundColor', 'pokemonTypes', type);
    });
    
    // 战斗状态指示器
    document.querySelectorAll('[data-battle-effectiveness]').forEach(el => {
      const effectiveness = el.dataset.battleEffectiveness;
      this.applyToElement(el, 'color', 'battleStatus', effectiveness);
    });
    
    // 地图标记
    document.querySelectorAll('[data-map-marker]').forEach(el => {
      const markerType = el.dataset.mapMarker;
      this.applyToElement(el, 'backgroundColor', 'mapMarkers', markerType);
    });
  }
}

export default ColorMapper;
```

### 3. 图案辅助系统

```javascript
// game-client/src/accessibility/patternOverlay.js

const PATTERNS = {
  // 精灵属性图案
  pokemonTypes: {
    fire: {
      pattern: 'zigzag',       // 锯齿图案
      description: '火焰图案',
      svgPattern: `<pattern id="fire-pattern">
        <path d="M0,10 L5,0 L10,10" stroke="#F08030" fill="none"/>
      </pattern>`
    },
    grass: {
      pattern: 'dots',         // 点状图案
      description: '叶子图案',
      svgPattern: `<pattern id="grass-pattern">
        <circle cx="5" cy="5" r="2" fill="#78C850"/>
      </pattern>`
    },
    water: {
      pattern: 'waves',        // 波浪图案
      description: '水波图案',
      svgPattern: `<pattern id="water-pattern">
        <path d="M0,5 Q2.5,0 5,5 T10,5" stroke="#6890F0" fill="none"/>
      </pattern>`
    },
    electric: {
      pattern: 'lightning',    // 闪电图案
      description: '闪电图案',
      svgPattern: `<pattern id="electric-pattern">
        <path d="M5,0 L3,5 L6,5 L4,10" stroke="#F8D030" fill="none"/>
      </pattern>`
    }
  },
  
  // 战斗效果图案
  battleEffectiveness: {
    effective: {
      pattern: 'checkmark',    // 对勾
      description: '✓ 有效',
      svgPattern: `<pattern id="effective-pattern">
        <path d="M2,5 L4,7 L8,3" stroke="#00FF00" fill="none" stroke-width="2"/>
      </pattern>`
    },
    ineffective: {
      pattern: 'cross',        // 叉号
      description: '✗ 无效',
      svgPattern: `<pattern id="ineffective-pattern">
        <path d="M2,2 L8,8 M2,8 L8,2" stroke="#FF0000" fill="none" stroke-width="2"/>
      </pattern>`
    }
  }
};

class PatternOverlay {
  constructor() {
    this.patterns = PATTERNS;
    this.activePatterns = new Set();
  }

  /**
   * 应用图案叠加到元素
   */
  applyPattern(element, patternId) {
    const pattern = this.getPatternById(patternId);
    if (!pattern) return;

    // 创建SVG图案定义
    const svgPattern = this.createSVGPatternElement(pattern);
    
    // 应用图案作为背景
    element.style.backgroundImage = `url(#${patternId})`;
    element.setAttribute('data-pattern', pattern.description);
    
    this.activePatterns.add(patternId);
  }

  /**
   * 移除图案叠加
   */
  removePattern(element) {
    element.style.backgroundImage = '';
    element.removeAttribute('data-pattern');
  }

  /**
   * 为精灵属性标签添加图案
   */
  enhanceTypeLabels() {
    document.querySelectorAll('[data-pokemon-type]').forEach(el => {
      const type = el.dataset.pokemonType;
      const pattern = this.patterns.pokemonTypes[type];
      
      if (pattern) {
        // 添加图案背景
        this.applyPattern(el, `${type}-pattern`);
        
        // 添加文字描述（如果不存在）
        if (!el.querySelector('.type-description')) {
          const desc = document.createElement('span');
          desc.className = 'type-description';
          desc.textContent = type.toUpperCase();
          desc.setAttribute('aria-label', pattern.description);
          el.appendChild(desc);
        }
      }
    });
  }

  /**
   * 为战斗效果添加图案
   */
  enhanceBattleIndicators() {
    document.querySelectorAll('[data-battle-effectiveness]').forEach(el => {
      const effectiveness = el.dataset.battleEffectiveness;
      const pattern = this.patterns.battleEffectiveness[effectiveness];
      
      if (pattern) {
        this.applyPattern(el, `${effectiveness}-pattern`);
        
        // 添加文字描述
        if (!el.querySelector('.effectiveness-description')) {
          const desc = document.createElement('span');
          desc.className = 'effectiveness-description';
          desc.textContent = effectiveness === 'effective' ? '有效' : '无效';
          el.appendChild(desc);
        }
      }
    });
  }
}

export default new PatternOverlay();
```

### 4. 文字标签增强系统

```javascript
// game-client/src/accessibility/textEnhancer.js

class TextEnhancer {
  constructor() {
    this.enhancements = {
      // 精灵属性文字描述
      pokemonTypes: {
        fire: '火属性',
        water: '水属性',
        grass: '草属性',
        electric: '电属性',
        psychic: '超能力属性',
        ice: '冰属性',
        dragon: '龙属性',
        dark: '恶属性',
        fairy: '妖精属性',
        // ... 其他属性
      },
      
      // 战斗效果文字
      battleEffects: {
        effective: '非常有效',
        superEffective: '效果拔群',
        ineffective: '效果不佳',
        noEffect: '没有效果',
        neutral: '普通效果'
      },
      
      // 精灵稀有度
      rarity: {
        common: '常见',
        uncommon: '普通',
        rare: '稀有',
        epic: '史诗',
        legendary: '传说',
        mythical: '幻兽'
      },
      
      // 地图标记
      mapMarkers: {
        pokestop: '补给站',
        gym: '道馆',
        raid: '团队战',
        spawn: '精灵出现点'
      }
    };
  }

  /**
   * 增强元素，添加文字描述
   */
  enhanceElement(element, category, key) {
    const text = this.getText(category, key);
    if (!text) return;

    // 如果元素已有文字内容，添加括号注释
    const currentText = element.textContent.trim();
    if (currentText && !currentText.includes(text)) {
      element.textContent = `${currentText} (${text})`;
    } else if (!currentText) {
      element.textContent = text;
    }

    // 添加aria-label
    element.setAttribute('aria-label', text);
    
    // 添加title属性（鼠标悬停提示）
    element.setAttribute('title', text);
  }

  /**
   * 批量增强所有需要文字的元素
   */
  enhanceAll() {
    // 精灵属性标签
    document.querySelectorAll('[data-pokemon-type]').forEach(el => {
      const type = el.dataset.pokemonType;
      this.enhanceElement(el, 'pokemonTypes', type);
    });

    // 战斗效果指示器
    document.querySelectorAll('[data-battle-effectiveness]').forEach(el => {
      const effectiveness = el.dataset.battleEffectiveness;
      this.enhanceElement(el, 'battleEffects', effectiveness);
    });

    // 精灵稀有度徽章
    document.querySelectorAll('[data-rarity]').forEach(el => {
      const rarity = el.dataset.rarity;
      this.enhanceElement(el, 'rarity', rarity);
    });

    // 地图标记
    document.querySelectorAll('[data-map-marker]').forEach(el => {
      const markerType = el.dataset.mapMarker;
      this.enhanceElement(el, 'mapMarkers', markerType);
    });
  }

  /**
   * 获取文字描述
   */
  getText(category, key) {
    return this.enhancements[category]?.[key] || null;
  }
}

export default new TextEnhancer();
```

### 5. 对比度调整系统

```javascript
// game-client/src/accessibility/contrastEnhancer.js

class ContrastEnhancer {
  constructor() {
    this.contrastLevels = {
      normal: 1.0,
      enhanced: 1.25,     // 增强对比度
      high: 1.5,          // 高对比度
      maximum: 2.0        // 最大对比度
    };
    
    this.currentLevel = 'normal';
  }

  /**
   * 设置对比度级别
   */
  setContrastLevel(level) {
    if (!this.contrastLevels[level]) {
      throw new Error(`Invalid contrast level: ${level}`);
    }

    this.currentLevel = level;
    const contrastValue = this.contrastLevels[level];
    
    // 应用CSS变量
    document.documentElement.style.setProperty(
      '--accessibility-contrast',
      contrastValue
    );
    
    // 应用对比度滤镜
    const root = document.documentElement;
    if (level === 'normal') {
      root.style.filter = root.style.filter.replace(/contrast\([^)]+\)/, '');
    } else {
      const currentFilter = root.style.filter;
      if (currentFilter.includes('contrast')) {
        root.style.filter = currentFilter.replace(
          /contrast\([^)]+\)/,
          `contrast(${contrastValue})`
        );
      } else {
        root.style.filter += ` contrast(${contrastValue})`;
      }
    }
    
    this.dispatchEvent('contrastLevelChanged', { level, value: contrastValue });
  }

  /**
   * 自动增强低对比度元素
   */
  autoEnhanceLowContrastElements() {
    const elements = document.querySelectorAll('*');
    
    elements.forEach(el => {
      const styles = window.getComputedStyle(el);
      const color = styles.color;
      const bgColor = styles.backgroundColor;
      
      // 计算对比度
      const contrastRatio = this.calculateContrastRatio(color, bgColor);
      
      // 如果对比度低于WCAG AA标准（4.5:1）
      if (contrastRatio < 4.5) {
        this.enhanceElementContrast(el, color, bgColor);
      }
    });
  }

  /**
   * 计算颜色对比度
   */
  calculateContrastRatio(color1, color2) {
    const lum1 = this.getLuminance(color1);
    const lum2 = this.getLuminance(color2);
    
    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);
    
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * 获取颜色的相对亮度
   */
  getLuminance(color) {
    const rgb = this.parseColor(color);
    const [r, g, b] = rgb.map(c => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * 解析颜色为RGB
   */
  parseColor(color) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  }

  /**
   * 增强元素对比度
   */
  enhanceElementContrast(element, color, bgColor) {
    // 策略1: 增加边框
    if (!element.style.border) {
      element.style.border = '1px solid rgba(0, 0, 0, 0.3)';
    }
    
    // 策略2: 调整文本颜色
    const rgb = this.parseColor(color);
    const isLightColor = (rgb[0] + rgb[1] + rgb[2]) / 3 > 128;
    
    if (isLightColor) {
      element.style.color = '#000000';
    } else {
      element.style.color = '#FFFFFF';
    }
  }
}

export default new ContrastEnhancer();
```

### 6. 后端API支持

```javascript
// backend/user-service/src/routes/accessibility.js

import express from 'express';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * 获取用户无障碍配置
 */
router.get('/settings', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const settings = await AccessibilitySettings.findOne({ userId });
    
    res.json({
      success: true,
      data: settings || {
        colorBlindnessMode: 'none',
        contrastLevel: 'normal',
        textEnhancement: true,
        patternOverlay: true,
        fontSize: 'normal'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 更新用户无障碍配置
 */
router.put('/settings', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      colorBlindnessMode,
      contrastLevel,
      textEnhancement,
      patternOverlay,
      fontSize
    } = req.body;
    
    // 验证色盲模式
    const validModes = ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'];
    if (colorBlindnessMode && !validModes.includes(colorBlindnessMode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid color blindness mode'
      });
    }
    
    // 验证对比度级别
    const validContrastLevels = ['normal', 'enhanced', 'high', 'maximum'];
    if (contrastLevel && !validContrastLevels.includes(contrastLevel)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid contrast level'
      });
    }
    
    const settings = await AccessibilitySettings.findOneAndUpdate(
      { userId },
      {
        $set: {
          colorBlindnessMode,
          contrastLevel,
          textEnhancement,
          patternOverlay,
          fontSize,
          updatedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );
    
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取颜色映射配置
 */
router.get('/color-mappings', async (req, res) => {
  try {
    const { mode } = req.query;
    
    // 返回指定模式下的颜色映射
    const mappings = await ColorMappingService.getMappings(mode);
    
    res.json({ success: true, data: mappings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
```

### 7. 数据库Schema

```sql
-- database/migrations/20260622050000_add_accessibility_settings.sql

CREATE TABLE accessibility_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- 色盲模式
  color_blindness_mode VARCHAR(20) DEFAULT 'none',
    -- 'none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'
  
  -- 对比度级别
  contrast_level VARCHAR(20) DEFAULT 'normal',
    -- 'normal', 'enhanced', 'high', 'maximum'
  
  -- 文字增强开关
  text_enhancement BOOLEAN DEFAULT true,
  
  -- 图案叠加开关
  pattern_overlay BOOLEAN DEFAULT true,
  
  -- 字体大小
  font_size VARCHAR(20) DEFAULT 'normal',
    -- 'small', 'normal', 'large', 'extra-large'
  
  -- 其他无障碍设置
  reduce_motion BOOLEAN DEFAULT false,        -- 减少动画
  screen_reader_mode BOOLEAN DEFAULT false,   -- 屏幕阅读器模式
  high_contrast_mode BOOLEAN DEFAULT false,   -- 高对比度模式
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(user_id)
);

-- 创建索引
CREATE INDEX idx_accessibility_settings_user_id ON accessibility_settings(user_id);

-- 添加注释
COMMENT ON TABLE accessibility_settings IS '用户无障碍设置表';
COMMENT ON COLUMN accessibility_settings.color_blindness_mode IS '色盲模式：none/protanopia/deuteranopia/tritanopia/achromatopsia';
COMMENT ON COLUMN accessibility_settings.contrast_level IS '对比度级别：normal/enhanced/high/maximum';
```

## 验收标准

- [ ] 支持四种色盲类型（红色盲、绿色盲、蓝黄色盲、全色盲）
- [ ] 实现智能颜色替换系统，至少覆盖精灵属性、战斗状态、地图标记
- [ ] 图案辅助系统为关键颜色信息添加形状/图案识别
- [ ] 文字标签增强为所有颜色编码信息添加文字描述
- [ ] 对比度调整支持4个级别（普通/增强/高/最大）
- [ ] 色盲模拟预览功能供开发者测试
- [ ] 用户配置持久化到数据库
- [ ] 所有UI组件支持无障碍属性（aria-label、role等）
- [ ] 满足WCAG 2.1 AA级标准
- [ ] 提供完整的单元测试覆盖
- [ ] 提供用户使用文档和开发者集成指南

## 影响范围

### 前端文件
- `game-client/src/accessibility/colorBlindnessManager.js`（新建）
- `game-client/src/accessibility/colorMappings.js`（新建）
- `game-client/src/accessibility/patternOverlay.js`（新建）
- `game-client/src/accessibility/textEnhancer.js`（新建）
- `game-client/src/accessibility/contrastEnhancer.js`（新建）
- `game-client/src/styles/accessibility.css`（新建）
- `game-client/src/components/SettingsPanel.js`（修改）

### 后端文件
- `backend/user-service/src/routes/accessibility.js`（新建）
- `backend/user-service/src/models/AccessibilitySettings.js`（新建）
- `backend/user-service/src/services/ColorMappingService.js`（新建）

### 数据库文件
- `database/migrations/20260622050000_add_accessibility_settings.sql`（新建）

### 测试文件
- `backend/tests/unit/accessibility.test.js`（新建）
- `game-client/tests/accessibility.test.js`（新建）

## 参考

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Color Blindness Simulation](https://www.color-blindness.com/coblis-color-blindness-simulator/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Pokemon GO Accessibility Features](https://nianticlabs.com/accessibility)
- [Microsoft Inclusive Design](https://www.microsoft.com/design/inclusive/)
