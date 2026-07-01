# REQ-00413：游戏文本自动方向布局系统

- **编号**：REQ-00413
- **类别**：国际化/本地化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、shared/i18n、admin-dashboard
- **创建时间**：2026-07-01 15:00 UTC
- **依赖需求**：REQ-00101（后端 API 错误消息 i18n）

## 1. 背景与问题

mineGo 已支持中/英/日三种语言，但游戏界面文本方向布局仍存在问题：

**当前缺口**：
1. **固定布局方向**：所有文本默认从左到右（LTR），无法支持阿拉伯语、希伯来语等 RTL 语言
2. **UI 镜像缺失**：按钮、图标、进度条等 UI 元素在 RTL 语言下未自动镜像
3. **文本溢出**：不同语言文本长度差异大，固定宽度容器导致文本截断或溢出
4. **动态布局未适配**：实时更新文本（如精灵状态、战斗信息）未考虑文本方向

**国际化扩展需求**：
- 计划扩展至阿拉伯语、希伯来语等 RTL 语言市场
- 玩家反馈 UI 在某些语言下显示异常
- 品牌一致性要求所有语言版本体验一致

## 2. 目标

构建自动文本方向布局系统：
1. **自动方向检测**：根据语言自动切换 LTR/RTL 布局
2. **UI 元素镜像**：RTL 模式下自动镜像对称 UI 元素
3. **动态容器适配**：根据文本长度自动调整容器宽度
4. **混合文本处理**：正确处理 RTL 文本中的 LTR 数字、英文片段
5. **管理后台支持**：翻译人员可预览不同方向布局效果

## 3. 范围

### 包含
- 客户端文本方向检测与布局引擎
- CSS 逻辑属性集成（margin-inline-start 等）
- UI 镜像规则配置
- 动态文本容器组件
- 管理后台预览功能

### 不包含
- 翻译管理系统（属 REQ-00370 范畴）
- 自动翻译功能（属外部服务）
- 字体渲染优化（属 REQ-00377）

## 4. 详细需求

### 4.1 文本方向检测器

```javascript
// frontend/game-client/src/i18n/TextDirectionManager.js

class TextDirectionManager {
  constructor() {
    // RTL 语言列表
    this.rtlLanguages = new Set(['ar', 'he', 'fa', 'ur', 'yi']);
    
    // 当前方向
    this.direction = 'ltr';
    this.locale = 'en';
    
    // 方向变更回调
    this.onDirectionChange = null;
  }
  
  /**
   * 设置语言并更新方向
   */
  setLocale(locale) {
    this.locale = locale;
    const langCode = locale.split('-')[0];
    const newDirection = this.rtlLanguages.has(langCode) ? 'rtl' : 'ltr';
    
    if (newDirection !== this.direction) {
      this.direction = newDirection;
      this._applyDirection();
      this.onDirectionChange?.(this.direction);
    }
    
    return this.direction;
  }
  
  /**
   * 应用方向到 DOM
   */
  _applyDirection() {
    document.documentElement.dir = this.direction;
    document.documentElement.lang = this.locale;
    
    // 更新 CSS 变量
    document.documentElement.style.setProperty('--text-direction', this.direction);
    document.documentElement.style.setProperty('--inline-start', this.direction === 'ltr' ? 'left' : 'right');
    document.documentElement.style.setProperty('--inline-end', this.direction === 'ltr' ? 'right' : 'left');
  }
  
  /**
   * 获取对齐方向
   */
  getAlignment(fallback = 'start') {
    if (fallback === 'start') {
      return this.direction === 'ltr' ? 'left' : 'right';
    } else if (fallback === 'end') {
      return this.direction === 'ltr' ? 'right' : 'left';
    }
    return fallback;
  }
  
  /**
   * 检测混合文本方向
   */
  detectTextDirection(text) {
    // 使用 Unicode 双向算法检测
    const rtlRegex = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
    const ltrRegex = /[A-Za-z0-9]/;
    
    const hasRtl = rtlRegex.test(text);
    const hasLtr = ltrRegex.test(text);
    
    if (hasRtl && hasLtr) return 'mixed';
    if (hasRtl) return 'rtl';
    return 'ltr';
  }
  
  /**
   * 处理混合文本（插入方向标记）
   */
  processMixedText(text) {
    // 使用 Unicode 双向控制字符
    const LRE = '\u202A'; // Left-to-Right Embedding
    const RLE = '\u202B'; // Right-to-Left Embedding
    const PDF = '\u202C'; // Pop Directional Format
    
    // 处理数字和英文片段
    const segments = text.split(/(\d+|[A-Za-z]+)/g);
    
    return segments.map(segment => {
      if (/^\d+$/.test(segment) || /^[A-Za-z]+$/.test(segment)) {
        return `${LRE}${segment}${PDF}`;
      }
      return segment;
    }).join('');
  }
}

module.exports = TextDirectionManager;
```

### 4.2 CSS 逻辑属性系统

```css
/* frontend/game-client/src/styles/direction-agnostic.css */

/* 使用 CSS 逻辑属性替代物理属性 */
:root {
  --text-direction: ltr;
  --inline-start: left;
  --inline-end: right;
}

/* 方向无关的边距和内边距 */
.card {
  margin-inline-start: 16px;
  margin-inline-end: 16px;
  padding-inline-start: 12px;
  padding-inline-end: 12px;
}

/* 方向无关的定位 */
.tooltip {
  inset-inline-start: 0;
  inset-inline-end: auto;
}

/* 方向无关的圆角 */
.button {
  border-start-start-radius: 8px;
  border-start-end-radius: 8px;
  border-end-start-radius: 8px;
  border-end-end-radius: 8px;
}

/* 浮动 */
.icon {
  float: inline-start;
}

/* 文本对齐 */
.title {
  text-align: start;
}

/* RTL 模式下的镜像 */
[dir="rtl"] .arrow-icon {
  transform: scaleX(-1);
}

[dir="rtl"] .progress-bar {
  transform: scaleX(-1);
}

[dir="rtl"] .back-button {
  transform: scaleX(-1);
}

/* 不镜像的元素（数字、播放器等） */
[dir="rtl"] .no-flip {
  transform: none;
}

/* Flexbox 方向 */
.sidebar {
  display: flex;
  flex-direction: row;
  /* 使用 inline-start 自动适配方向 */
  justify-content: flex-start; /* 自动适配 */
}

/* Grid 布局 */
.grid-container {
  display: grid;
  grid-template-columns: auto 1fr auto;
  /* Grid 会自动适配 RTL */
}
```

### 4.3 动态文本容器组件

```javascript
// frontend/game-client/src/components/DynamicTextContainer.js

class DynamicTextContainer {
  /**
   * 创建自适应文本容器
   */
  static create(options = {}) {
    const {
      minLines = 1,
      maxLines = 5,
      minFontSize = 12,
      maxFontSize = 16,
      containerPadding = 8,
      expandOnOverflow = true
    } = options;
    
    const container = document.createElement('div');
    container.className = 'dynamic-text-container';
    
    const textElement = document.createElement('span');
    textElement.className = 'dynamic-text';
    container.appendChild(textElement);
    
    // 应用样式
    Object.assign(container.style, {
      display: 'inline-block',
      minWidth: 'fit-content',
      padding: `${containerPadding}px`,
      textAlign: 'start',
      writingMode: 'horizontal-tb',
      overflow: expandOnOverflow ? 'visible' : 'hidden'
    });
    
    return {
      container,
      setText: (text) => {
        textElement.textContent = text;
        this._adjustContainer(container, textElement, options);
      }
    };
  }
  
  /**
   * 动态调整容器
   */
  static _adjustContainer(container, textElement, options) {
    const { minLines, maxLines, minFontSize, maxFontSize, expandOnOverflow } = options;
    
    // 获取文本尺寸
    const textWidth = textElement.scrollWidth;
    const textHeight = textElement.scrollHeight;
    
    // 计算需要的行数
    const containerWidth = container.clientWidth - (options.containerPadding * 2);
    const lineHeight = parseFloat(getComputedStyle(textElement).lineHeight);
    const charsPerLine = Math.floor(containerWidth / (textWidth / textElement.textContent.length));
    const neededLines = Math.ceil(textElement.textContent.length / charsPerLine);
    
    // 调整字体大小
    let fontSize = maxFontSize;
    const actualLines = Math.min(neededLines, maxLines);
    
    if (neededLines > maxLines && expandOnOverflow) {
      // 缩小字体以适应
      fontSize = Math.max(minFontSize, maxFontSize * (maxLines / neededLines));
    }
    
    textElement.style.fontSize = `${fontSize}px`;
    
    // 设置容器高度
    container.style.minHeight = `${minLines * lineHeight}px`;
    if (!expandOnOverflow) {
      container.style.maxHeight = `${maxLines * lineHeight}px`;
    }
  }
  
  /**
   * 计算文本宽度
   */
  static measureText(text, fontFamily, fontSize) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontSize}px ${fontFamily}`;
    return ctx.measureText(text).width;
  }
}
```

### 4.4 UI 镜像规则配置

```javascript
// frontend/game-client/src/config/mirror-rules.json
{
  "mirrorElements": [
    {
      "selector": ".arrow-icon",
      "property": "transform",
      "value": "scaleX(-1)",
      "reason": "方向箭头需镜像"
    },
    {
      "selector": ".progress-bar-fill",
      "property": "transform",
      "value": "scaleX(-1)",
      "reason": "进度条填充方向"
    },
    {
      "selector": ".back-button-icon",
      "property": "transform",
      "value": "scaleX(-1)",
      "reason": "返回箭头方向"
    },
    {
      "selector": ".nav-menu",
      "property": "flex-direction",
      "value": "row-reverse",
      "reason": "导航菜单顺序"
    },
    {
      "selector": ".checkbox",
      "property": "flex-direction",
      "value": "row-reverse",
      "reason": "复选框位置"
    }
  ],
  "noMirrorElements": [
    {
      "selector": ".number-display",
      "reason": "数字始终从左到右"
    },
    {
      "selector": ".logo",
      "reason": "品牌 Logo 不镜像"
    },
    {
      "selector": ".video-player",
      "reason": "播放器控件不镜像"
    },
    {
      "selector": ".map-controls",
      "reason": "地图控件位置固定"
    }
  ],
  "conditionalMirror": [
    {
      "selector": ".pokemon-stat-bar",
      "condition": "statType !== 'health'",
      "reason": "健康条不镜像，其他属性条镜像"
    }
  ]
}
```

### 4.5 管理后台预览功能

```javascript
// frontend/admin-dashboard/src/views/i18n/DirectionPreview.vue

<template>
  <div class="direction-preview">
    <div class="controls">
      <select v-model="selectedLocale" @change="updatePreview">
        <option v-for="lang in supportedLanguages" :key="lang.code" :value="lang.code">
          {{ lang.name }} ({{ lang.direction === 'rtl' ? 'RTL' : 'LTR' }})
        </option>
      </select>
      
      <button @click="toggleDirection">
        切换方向: {{ currentDirection }}
      </button>
    </div>
    
    <div class="preview-container" :dir="currentDirection">
      <!-- 模拟游戏界面 -->
      <div class="mock-game-screen">
        <div class="mock-header">
          <span class="back-button">◀</span>
          <span class="title">{{ previewText.title }}</span>
          <span class="menu-icon">☰</span>
        </div>
        
        <div class="mock-content">
          <div class="pokemon-card">
            <img src="/placeholder-pokemon.png" :class="{ 'flip-image': currentDirection === 'rtl' }">
            <div class="pokemon-info">
              <span class="pokemon-name">{{ previewText.pokemonName }}</span>
              <div class="stat-bar">
                <div class="stat-fill" :style="{ width: '70%' }"></div>
              </div>
            </div>
          </div>
          
          <div class="action-buttons">
            <button class="btn-catch">{{ previewText.catch }}</button>
            <button class="btn-battle">{{ previewText.battle }}</button>
          </div>
        </div>
      </div>
    </div>
    
    <div class="issues-panel" v-if="layoutIssues.length">
      <h4>布局问题</h4>
      <ul>
        <li v-for="issue in layoutIssues" :key="issue.id" :class="issue.severity">
          {{ issue.message }}
        </li>
      </ul>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      selectedLocale: 'en',
      currentDirection: 'ltr',
      supportedLanguages: [
        { code: 'en', name: 'English', direction: 'ltr' },
        { code: 'zh-CN', name: '简体中文', direction: 'ltr' },
        { code: 'ja', name: '日本語', direction: 'ltr' },
        { code: 'ar', name: 'العربية', direction: 'rtl' },
        { code: 'he', name: 'עברית', direction: 'rtl' }
      ],
      previewText: {
        title: 'Pokédex',
        pokemonName: 'Pikachu',
        catch: 'Catch',
        battle: 'Battle'
      },
      layoutIssues: []
    };
  },
  methods: {
    updatePreview() {
      const lang = this.supportedLanguages.find(l => l.code === this.selectedLocale);
      this.currentDirection = lang.direction;
      this.loadPreviewText();
      this.checkLayoutIssues();
    },
    toggleDirection() {
      this.currentDirection = this.currentDirection === 'ltr' ? 'rtl' : 'ltr';
      this.checkLayoutIssues();
    },
    async loadPreviewText() {
      // 加载对应语言的预览文本
      const response = await fetch(`/api/i18n/translations/${this.selectedLocale}`);
      const data = await response.json();
      this.previewText = data.gameUI;
    },
    checkLayoutIssues() {
      this.layoutIssues = [];
      
      // 检查文本溢出
      const textElements = document.querySelectorAll('.preview-container .pokemon-name, .preview-container .btn-catch');
      textElements.forEach(el => {
        if (el.scrollWidth > el.clientWidth) {
          this.layoutIssues.push({
            id: `overflow-${el.className}`,
            severity: 'warning',
            message: `文本溢出: ${el.className}`
          });
        }
      });
      
      // 检查图标对齐
      if (this.currentDirection === 'rtl') {
        const backBtn = document.querySelector('.back-button');
        if (backBtn && !backBtn.style.transform.includes('scaleX')) {
          this.layoutIssues.push({
            id: 'icon-alignment',
            severity: 'info',
            message: '建议: 返回按钮图标应镜像'
          });
        }
      }
    }
  }
};
</script>
```

## 5. 验收标准（可测试）

- [ ] **方向自动检测**：设置阿拉伯语后，页面方向自动变为 RTL
- [ ] **CSS 逻辑属性**：所有 UI 元素在 RTL 模式下正确镜像显示
- [ ] **UI 镜像规则**：back-button、arrow-icon、progress-bar 在 RTL 下正确镜像
- [ ] **数字不镜像**：数字、品牌 Logo 在 RTL 下保持原方向
- [ ] **文本不溢出**：各语言文本在容器内完整显示，无截断
- [ ] **混合文本正确**：RTL 文本中的数字和英文片段方向正确
- [ ] **动态容器自适应**：长文本自动换行，容器高度自适应
- [ ] **管理后台预览**：翻译人员可切换方向预览，检测布局问题
- [ ] **实时切换**：运行时切换语言，布局立即更新
- [ ] **性能影响小**：方向切换响应时间 < 100ms

## 6. 工作量估算

**工作量**：M（中型）

**理由**：
- 需改造大量现有 UI 组件使用逻辑属性
- 需配置镜像规则并进行测试
- 涉及客户端和管理后台两部分
- 不涉及后端服务改造

## 7. 优先级理由

**P2 优先级**：
- 国际化扩展准备：为 RTL 语言市场做好准备
- 体验一致性：确保所有语言版本体验一致
- 技术债务预防：早期改造成本低于后期重构
- 依赖已就绪：REQ-00101 i18n 基础已完成
