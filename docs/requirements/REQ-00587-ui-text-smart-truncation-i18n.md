# REQ-00587：用户界面文本智能截断与本地化适配系统

- **编号**：REQ-00587
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：game-client、backend/shared/i18n/textTruncator.js、所有后端服务、admin-dashboard
- **创建时间**：2026-07-16 23:00
- **依赖需求**：无

## 1. 背景与问题

mineGo 是一款全球化 AR 手游，支持中/英/日等多语言。当前系统存在以下痛点：

1. **文本长度差异导致的 UI 溢出**：不同语言的文本长度差异可达 300%（如英文 "Catch the Pokemon" vs 德语 "Fangen Sie das Pokémon"），固定宽度容器经常出现文本溢出、换行错乱等问题
2. **硬编码截断丢失语义**：当前使用简单的字符串截断（`text.substring(0, maxLen)`），可能截断关键信息，甚至破坏 Unicode 字符（如 emoji、中文生僻字）
3. **缺乏语言特定的截断策略**：不同语言的截断点不同（英语在空格，中文在字边界，日语可断在任意位置），当前一刀切策略导致显示效果差
4. **响应式布局适配不足**：移动端屏幕尺寸多样，缺乏根据可用空间动态调整显示文本长度的能力
5. **无占位符保护机制**：截断可能破坏 i18n 占位符（如 `{userName}`），导致显示异常或安全漏洞

## 2. 目标

构建一套用户界面文本智能截断与本地化适配系统，实现：

1. **语义完整性**：截断后文本保持语义可读，不破坏关键信息
2. **语言适应性**：根据不同语言特性选择最优截断策略
3. **UI 友好性**：自动适配可用空间，避免溢出和布局错乱
4. **安全性**：保护占位符、特殊字符不被破坏
5. **可配置性**：支持按场景、组件、语言配置截断规则

## 3. 范围

### 包含
- 智能文本截断核心引擎（多语言策略）
- UI 组件集成适配器（Vue/React/Vanilla JS）
- 服务端文本预处理 API
- 截断预览与测试工具
- 配置管理后台

### 不包含
- 自动翻译系统（已有 REQ-00495）
- 字体渲染优化（属于前端渲染层）
- 文本到语音转换（属于无障碍功能）

## 4. 详细需求

### 4.1 核心截断引擎

```javascript
// backend/shared/i18n/textTruncator.js
class SmartTextTruncator {
  constructor(options = {}) {
    this.strategies = {
      'zh': new ChineseStrategy(),      // 在字边界截断
      'ja': new JapaneseStrategy(),     // 可在任意位置截断
      'en': new EnglishStrategy(),      // 在单词边界截断
      'de': new GermanStrategy(),       // 避免截断复合词
      'ar': new ArabicStrategy(),       // RTL 支持，保护连接字符
      'th': new ThaiStrategy(),         // 无空格语言，在音节边界截断
      'default': new DefaultStrategy()
    };
  }
  
  // 主截断方法
  truncate(text, options) {
    const {
      maxLength,           // 最大字符数
      maxLines,             // 最大行数（可选）
      ellipsis = '...',     // 省略符
      locale,               // 语言环境
      preservePlaceholders = true,  // 保护占位符
      breakOnWord = true,   // 在单词边界断开
      respectHTML = true    // 保护 HTML 标签
    } = options;
    
    // 1. 预处理：提取并保护特殊元素
    const { protectedText, placeholders } = this.protectSpecialElements(text);
    
    // 2. 选择截断策略
    const strategy = this.getStrategy(locale);
    
    // 3. 执行截断
    let truncated = strategy.truncate(protectedText, maxLength - ellipsis.length);
    
    // 4. 恢复占位符（检查完整性）
    truncated = this.restorePlaceholders(truncated, placeholders);
    
    // 5. 添加省略符
    return truncated + ellipsis;
  }
}
```

### 4.2 语言特定截断策略

```javascript
// 中文策略：在字边界截断，保护语义完整性
class ChineseStrategy {
  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    
    // 智能截断：优先在标点符号后截断
    const punctuation = ['。', '，', '！', '？', '、', '；', '：'];
    let cutPoint = maxLength;
    
    // 向前查找最近的标点符号（保留 80% 长度阈值）
    const threshold = Math.floor(maxLength * 0.8);
    for (let i = maxLength; i >= threshold; i--) {
      if (punctuation.includes(text[i])) {
        cutPoint = i + 1;
        break;
      }
    }
    
    return text.substring(0, cutPoint);
  }
}

// 英语策略：在单词边界截断
class EnglishStrategy {
  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    
    // 向前查找空格
    let cutPoint = maxLength;
    while (cutPoint > 0 && text[cutPoint] !== ' ') {
      cutPoint--;
    }
    
    // 如果找不到空格，使用硬截断（但保护 Unicode）
    if (cutPoint === 0) {
      cutPoint = maxLength;
    }
    
    return text.substring(0, cutPoint).trim();
  }
}

// 阿拉伯语策略：RTL 支持，保护连接字符
class ArabicStrategy {
  truncate(text, maxLength) {
    // 阿拉伯语连接字符不能在中间断开
    const ligatures = ['لا', 'لل', 'بـ', 'ـة'];
    // ... 特殊处理逻辑
  }
}
```

### 4.3 占位符保护机制

```javascript
protectSpecialElements(text) {
  const placeholders = [];
  const placeholderRegex = /\{[^}]+\}/g;
  let index = 0;
  
  // 提取并替换占位符为临时标记
  const protectedText = text.replace(placeholderRegex, (match) => {
    const marker = `__PH_${index}__`;
    placeholders.push({ marker, original: match });
    index++;
    return marker;
  });
  
  return { protectedText, placeholders };
}

restorePlaceholders(truncated, placeholders) {
  let result = truncated;
  
  // 只恢复完整存在的占位符
  for (const { marker, original } of placeholders) {
    if (result.includes(marker)) {
      result = result.replace(marker, original);
    } else {
      // 占位符被截断，记录警告
      logger.warn(`Placeholder truncated: ${original}`);
    }
  }
  
  return result;
}
```

### 4.4 前端组件集成

```javascript
// game-client/src/components/SmartText.js
class SmartText {
  constructor(element, options = {}) {
    this.element = element;
    this.maxLines = options.maxLines || 2;
    this.locale = options.locale || navigator.language;
    this.truncator = new SmartTextTruncator();
  }
  
  // 响应式截断
  render(text) {
    const availableWidth = this.element.clientWidth;
    const fontSize = parseFloat(getComputedStyle(this.element).fontSize);
    const charsPerLine = Math.floor(availableWidth / (fontSize * 0.6)); // 估算
    
    const maxChars = charsPerLine * this.maxLines;
    
    const truncated = this.truncator.truncate(text, {
      maxLength: maxChars,
      locale: this.locale,
      maxLines: this.maxLines
    });
    
    this.element.textContent = truncated;
    
    // 如果截断了，添加展开功能
    if (truncated !== text) {
      this.addExpandTooltip(text);
    }
  }
  
  addExpandTooltip(fullText) {
    this.element.title = fullText;
    this.element.style.cursor = 'pointer';
    // 点击展开完整文本
    this.element.addEventListener('click', () => {
      this.showFullTextModal(fullText);
    });
  }
}
```

### 4.5 服务端 API

```javascript
// gateway/src/routes/i18n.js
router.post('/api/v1/i18n/truncate', async (req, res) => {
  const { texts, options } = req.body;
  
  const results = texts.map(text => ({
    original: text,
    truncated: textTruncator.truncate(text, {
      maxLength: options.maxLength,
      locale: options.locale,
      ...options
    }),
    wasTruncated: text.length > options.maxLength
  }));
  
  res.json({ results });
});

// 批量预览截断效果
router.post('/api/v1/i18n/truncate/preview', async (req, res) => {
  const { locale, maxLength } = req.body;
  
  // 获取所有 UI 文本
  const uiTexts = await i18nService.getAllTexts(locale);
  
  const preview = uiTexts.map(item => ({
    key: item.key,
    original: item.text,
    truncated: textTruncator.truncate(item.text, { maxLength, locale }),
    length: {
      original: item.text.length,
      truncated: textTruncator.truncate(item.text, { maxLength, locale }).length,
      reduction: ((1 - textTruncator.truncate(item.text, { maxLength, locale }).length / item.text.length) * 100).toFixed(1) + '%'
    }
  }));
  
  res.json({ preview, locale, maxLength });
});
```

### 4.6 配置管理

```javascript
// 配置示例
const truncationConfig = {
  // 默认截断长度
  defaults: {
    maxLength: 50,
    ellipsis: '...',
    preservePlaceholders: true
  },
  
  // 按组件覆盖
  components: {
    'pokemon-name': { maxLength: 20, ellipsis: '…' },
    'item-description': { maxLength: 100, maxLines: 3 },
    'notification-title': { maxLength: 30 },
    'chat-message': { maxLength: 200, maxLines: 4 }
  },
  
  // 按语言覆盖
  locales: {
    'ja': { maxLengthFactor: 1.5 },    // 日语通常更长
    'de': { maxLengthFactor: 1.3 },    // 德语单词更长
    'zh': { maxLengthFactor: 0.8 }     // 中文更紧凑
  }
};
```

### 4.7 测试与验证工具

```javascript
// 测试用例
describe('SmartTextTruncator', () => {
  test('中文截断保护标点', () => {
    const text = '这是一段很长的中文描述文字，需要在逗号处截断。';
    const result = truncator.truncate(text, { maxLength: 15, locale: 'zh' });
    expect(result).toBe('这是一段很长的中文描述文字，...');
  });
  
  test('英语截断在单词边界', () => {
    const text = 'Catch the legendary Pokemon Mewtwo';
    const result = truncator.truncate(text, { maxLength: 20, locale: 'en' });
    expect(result).toBe('Catch the legendary...');
  });
  
  test('保护占位符', () => {
    const text = 'Welcome {userName}! You have {count} new messages.';
    const result = truncator.truncate(text, { maxLength: 30, locale: 'en' });
    expect(result).not.toContain('{user');
    expect(result).toMatch(/Welcome.*\{userName\}/);
  });
  
  test('RTL语言支持', () => {
    const text = 'مرحبا بك في اللعبة'; // 阿拉伯语
    const result = truncator.truncate(text, { maxLength: 10, locale: 'ar' });
    expect(result).toMatch(/^[\u0600-\u06FF]+…$/);
  });
});
```

## 5. 验收标准（可测试）

- [ ] 截断引擎支持至少 10 种语言的特定截断策略
- [ ] 中文截断优先在标点符号后截断，保持语义完整
- [ ] 英语截断在单词边界截断，不破坏单词完整性
- [ ] 占位符保护机制 100% 保护 `{xxx}` 格式的占位符
- [ ] 前端组件根据可用空间动态计算截断长度，适配不同屏幕尺寸
- [ ] 截断后的文本不破坏 UI 布局（无溢出）
- [ ] 被截断的文本提供展开/查看完整内容的方式（tooltip 或点击展开）
- [ ] 截断预览工具显示所有 UI 文本的截断效果和长度变化
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 性能测试：1000 次截断操作耗时 < 100ms

## 6. 工作量估算

**工作量：M（中等）**

理由：
- 核心截断逻辑相对简单，但需要支持多种语言策略
- 前端集成和响应式计算需要一定工作量
- 测试用例需要覆盖多种语言和边界情况
- 预估开发时间：3-5 天

## 7. 优先级理由

**优先级：P1**

理由：
1. **用户体验关键问题**：文本溢出直接影响 UI 可读性和专业性
2. **全球化必要功能**：多语言游戏必须解决文本长度差异问题
3. **预防性修复**：避免未来新语言添加时出现大量 UI 问题
4. **技术债积累风险**：当前硬编码截断可能导致语义丢失和安全问题
5. **影响范围广**：所有包含动态文本的 UI 组件都需要此功能