# REQ-00515：服务端复数形式国际化与智能复数规则系统

- **编号**：REQ-00515
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/i18n/plural.js、gateway、user-service、social-service、game-client
- **创建时间**：2026-07-08 22:00
- **依赖需求**：REQ-00500（服务端数字格式化本地化系统）

## 1. 背景与问题

当前项目已完成基础的 i18n 支持（`backend/shared/i18n.js`），包含错误消息翻译、本地化中间件、翻译缓存等。但现有系统存在以下不足：

**现有痛点：**
1. 服务端消息拼接时复数形式处理硬编码，如 `catch ${count} Pokemon` 在不同语言中复数规则不同
2. 缺少 CLDR 标准复数规则支持（如俄语有 4 种复数形式，阿拉伯语有 6 种）
3. 前端和后端复数逻辑重复实现，不一致
4. 翻译键中缺少复数形式占位符支持（如 `{{count}} item` vs `{{count}} items`）
5. 动态消息（如 "caught 1 Pikachu" vs "caught 2 Pikachu"）无法优雅处理

## 2. 目标

建立服务端复数形式国际化系统，实现：
- CLDR 标准复数规则引擎（支持所有语言的复数形式）
- 智能复数规则匹配（基于数字、语言、上下文）
- 翻译键复数形式支持（单复数键自动选择）
- 上下文感知复数（名词 vs 动词 vs 形容词）
- 与现有 i18n 系统无缝集成

## 3. 范围

- **包含**：
  - PluralFormLocalization - 复数形式本地化引擎
  - PluralRuleMatcher - 复数规则匹配器（CLDR 规则）
  - PluralContextAnalyzer - 上下文分析器（名词/动词/形容词）
  - PluralTranslationCache - 翻译缓存优化
  - PluralValidator - 复数翻译验证器
  - API 端点扩展

- **不包含**：
  - 前端复数处理（已有前端 i18n 模块）
  - 性别语法处理（后续需求）
  - 动词变位（后续需求）

## 4. 详细需求

### 4.1 PluralFormLocalization 复数形式本地化引擎

```javascript
class PluralFormLocalization {
  // 支持 CLDR 复数类别
  pluralCategories: {
    'zh-CN': ['other'],           // 中文无复数
    'en-US': ['one', 'other'],    // 英文：单数/其他
    'ja-JP': ['other'],           // 日语无复数
    'ru-RU': ['one', 'few', 'many', 'other'], // 俄语 4 种
    'ar-SA': ['zero', 'one', 'two', 'few', 'many', 'other'] // 阿拉伯语 6 种
  }
  
  // 核心方法
  async localizePlural(key, count, locale, context)
  selectPluralForm(count, locale) // 选择正确的复数形式
  formatPluralMessage(key, count, locale, params) // 格式化复数消息
  
  // 示例输出
  // en-US: "You caught 1 Pokemon" vs "You caught 5 Pokemon"
  // ru-RU: "Вы поймали 1 Покемона" vs "Вы поймали 2 Покемона" vs "Вы поймали 5 Покемонов"
  // zh-CN: "你捕获了 1 只精灵" vs "你捕获了 5 只精灵"
}
```

### 4.2 PluralRuleMatcher 复数规则匹配器

```javascript
class PluralRuleMatcher {
  // CLDR 复数规则
  rules: {
    'en-US': {
      one: 'n = 1',
      other: ''
    },
    'ru-RU': {
      one: 'n % 10 = 1 and n % 100 != 11',
      few: 'n % 10 in 2..4 and n % 100 not in 12..14',
      many: 'n % 10 = 0 or n % 10 in 5..9 or n % 100 in 11..14',
      other: ''
    },
    'ar-SA': {
      zero: 'n = 0',
      one: 'n = 1',
      two: 'n = 2',
      few: 'n % 100 in 3..10',
      many: 'n % 100 in 11..99',
      other: ''
    }
  }
  
  // 核心方法
  matchRule(count, locale) // 返回复数类别
  parseRuleExpression(expression) // 解析 CLDR 规则表达式
  evaluateRule(count, rule) // 计算规则结果
}
```

### 4.3 PluralContextAnalyzer 上下文分析器

```javascript
class PluralContextAnalyzer {
  // 上下文类型
  contexts: {
    noun: '名词复数',        // Pokemon -> Pokemons
    verb: '动词复数',        // catches -> catch
    adjective: '形容词复数', // wild -> wild (不变)
    possessive: '所有格复数' // trainer's -> trainers'
  }
  
  // 核心方法
  analyzeContext(key, message) // 分析消息上下文
  getContextualPlural(key, count, locale, context) // 获取上下文复数形式
}
```

### 4.4 翻译键格式扩展

```javascript
// 支持的翻译键格式
const translationKeys = {
  // 显式复数键
  'catch.success_one': 'You caught 1 Pokemon',
  'catch.success_other': 'You caught {{count}} Pokemon',
  
  // 复数后缀映射
  '_zero': 'zero 形式',
  '_one': '单数形式',
  '_two': '双数形式',
  '_few': '少量形式',
  '_many': '大量形式',
  '_other': '其他形式',
  
  // 带计数的插值
  'pokemon.caught': '{{count}} Pokemon caught',
  'items.in_bag': '{{count}} items in bag'
};
```

### 4.5 API 端点

```
POST /api/v1/i18n/plural
请求体：
{
  "key": "catch.success",
  "count": 5,
  "locale": "ru-RU",
  "params": { "pokemon": "Pikachu" }
}

响应：
{
  "message": "Вы поймали 5 Покемонов",
  "pluralForm": "many",
  "locale": "ru-RU"
}
```

## 5. 验收标准（可测试）

- [ ] 支持至少 20 种语言的复数规则（包含中/英/日/俄/阿拉伯/西班牙/法语等）
- [ ] 俄语复数规则正确匹配（one/few/many/other 四种形式）
- [ ] 阿拉伯语复数规则正确匹配（6 种复数形式）
- [ ] 翻译键后缀正确解析（_one, _other, _few 等）
- [ ] 插值变量正确替换（{{count}} -> 实际数字）
- [ ] 与现有 i18n.js 系统集成无冲突
- [ ] 单元测试覆盖：复数规则匹配 15+ 用例，本地化格式化 10+ 用例
- [ ] 性能：复数匹配延迟 < 1ms

## 6. 工作量估算

M（Medium）
- CLDR 规则解析引擎需要精确实现
- 多语言复数规则配置需要维护
- 与现有系统集成需要兼容性考虑

## 7. 优先级理由

P1 级别：
- 当前服务端消息在多语言环境下用户体验差
- 俄语、阿拉伯语等市场无法正确显示复数形式
- 影响游戏内消息、通知、社交文本等核心功能
- 对项目"国际化可用"贡献显著