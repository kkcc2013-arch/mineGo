# REQ-00011：游戏客户端多语言国际化支持

- **编号**：REQ-00011
- **类别**：国际化/本地化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、backend/gateway、所有微服务
- **创建时间**：2026-06-05 08:15
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 游戏客户端存在以下国际化问题：

1. **硬编码中文**：前端界面所有文本硬编码在 HTML/JS 中，`<html lang="zh-CN">` 固定为中文
2. **无语言切换能力**：用户无法在游戏内切换语言，无法服务国际用户
3. **服务端错误消息硬编码**：后端服务返回的错误消息、提示信息均为中文硬编码
4. **缺少翻译管理**：没有翻译文件、语言包或 i18n 配置
5. **限制市场拓展**：无法进入英语、日语等海外市场

随着项目成熟度达到 92/100，国际化成为拓展用户群体的关键能力。

## 2. 目标

为 mineGo 建立完整的国际化支持体系：

1. **前端多语言 UI**：支持中文、英文、日文三种语言切换
2. **服务端国际化响应**：根据用户语言偏好返回对应语言的错误消息和提示
3. **语言偏好持久化**：用户语言选择保存至数据库，跨设备同步
4. **翻译管理机制**：建立可维护的翻译文件结构和更新流程
5. **自动语言检测**：根据浏览器/系统语言自动选择初始语言

## 3. 范围

### 包含
- 前端 i18n 框架集成（i18next 或类似库）
- 创建中文、英文、日文语言包
- 用户服务增加语言偏好字段
- 后端错误消息国际化
- 语言切换 UI 组件
- 语言偏好自动检测逻辑

### 不包含
- 其他语言支持（韩语、西班牙语等，可在后续需求扩展）
- 翻译外包流程管理
- 本地化运营内容（如地区限定活动）

## 4. 详细需求

### 4.1 前端国际化架构

#### 4.1.1 i18n 集成
```javascript
// frontend/game-client/src/i18n/index.js
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: require('./locales/zh-CN.json') },
      'en-US': { translation: require('./locales/en-US.json') },
      'ja-JP': { translation: require('./locales/ja-JP.json') }
    },
    fallbackLng: 'zh-CN',
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage']
    }
  });
```

#### 4.1.2 语言包文件结构
```
frontend/game-client/src/i18n/locales/
├── zh-CN.json  # 简体中文
├── en-US.json  # 英文
└── ja-JP.json  # 日文
```

#### 4.1.3 翻译键命名规范
```json
{
  "common": {
    "confirm": "确认",
    "cancel": "取消",
    "loading": "加载中..."
  },
  "game": {
    "catch": {
      "success": "捕捉成功！",
      "failed": "捕捉失败，精灵逃跑了",
      "throw": "投掷精灵球"
    },
    "gym": {
      "battle": "挑战道馆",
      "defeat": "击败道馆",
      "reward": "获得奖励"
    }
  },
  "error": {
    "network": "网络连接失败",
    "auth": "登录已过期，请重新登录",
    "permission": "没有权限执行此操作"
  }
}
```

### 4.2 语言切换 UI

#### 4.2.1 设置页面组件
```javascript
// frontend/game-client/src/components/LanguageSelector.js
class LanguageSelector {
  render() {
    const languages = [
      { code: 'zh-CN', name: '简体中文', flag: '🇨🇳' },
      { code: 'en-US', name: 'English', flag: '🇺🇸' },
      { code: 'ja-JP', name: '日本語', flag: '🇯🇵' }
    ];
    // 渲染语言选择列表
  }
  
  async changeLanguage(langCode) {
    await i18next.changeLanguage(langCode);
    await this.savePreference(langCode);
    location.reload(); // 刷新页面应用新语言
  }
}
```

### 4.3 后端国际化支持

#### 4.3.1 用户语言偏好字段
```sql
-- database/migrations/add_user_language_preference.sql
ALTER TABLE users ADD COLUMN language_preference VARCHAR(10) DEFAULT 'zh-CN';
```

#### 4.3.2 错误消息国际化中间件
```javascript
// backend/shared/i18nMiddleware.js
const errorMessages = {
  'zh-CN': {
    'AUTH_TOKEN_EXPIRED': '登录已过期，请重新登录',
    'CATCH_OUT_OF_RANGE': '距离精灵太远，请靠近后再试',
    'GYM_COOLDING_DOWN': '道馆冷却中，请稍后再试'
  },
  'en-US': {
    'AUTH_TOKEN_EXPIRED': 'Session expired, please login again',
    'CATCH_OUT_OF_RANGE': 'Too far from Pokemon, please get closer',
    'GYM_COOLDING_DOWN': 'Gym is cooling down, please try again later'
  },
  'ja-JP': {
    'AUTH_TOKEN_EXPIRED': 'ログインの有効期限が切れました',
    'CATCH_OUT_OF_RANGE': 'ポケモンから遠すぎます',
    'GYM_COOLDING_DOWN': 'ジムはクールダウン中です'
  }
};

function i18nMiddleware(req, res, next) {
  const userLang = req.user?.language_preference || req.headers['accept-language'] || 'zh-CN';
  req.t = (key) => errorMessages[userLang]?.[key] || errorMessages['zh-CN'][key] || key;
  next();
}
```

#### 4.3.3 统一错误响应格式
```javascript
// backend/shared/response.js
class APIError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
  
  toJSON(req) {
    return {
      success: false,
      error: {
        code: this.code,
        message: req.t(this.code), // 使用 i18n 翻译
        details: this.details
      }
    };
  }
}
```

### 4.4 语言偏好同步

#### 4.4.1 API 端点
```
PUT /api/user/language
Request: { "language": "en-US" }
Response: { "success": true }
```

#### 4.4.2 前端同步逻辑
```javascript
// 用户切换语言时自动同步到服务器
async function setLanguage(langCode) {
  await i18next.changeLanguage(langCode);
  localStorage.setItem('language', langCode);
  
  if (isLoggedIn()) {
    await fetch('/api/user/language', {
      method: 'PUT',
      body: JSON.stringify({ language: langCode })
    });
  }
}
```

### 4.5 翻译管理工具

#### 4.5.1 翻译文件验证脚本
```javascript
// scripts/validate-i18n.js
const fs = require('fs');
const path = require('path');

const locales = ['zh-CN', 'en-US', 'ja-JP'];
const baseLocale = 'zh-CN';

function validateTranslations() {
  const baseKeys = getKeys(require(`../frontend/game-client/src/i18n/locales/${baseLocale}.json`));
  
  for (const locale of locales) {
    if (locale === baseLocale) continue;
    
    const localeKeys = getKeys(require(`../frontend/game-client/src/i18n/locales/${locale}.json`));
    const missing = baseKeys.filter(k => !localeKeys.includes(k));
    
    if (missing.length > 0) {
      console.error(`[${locale}] Missing translations:`, missing);
      process.exit(1);
    }
  }
  
  console.log('✅ All translations are complete');
}
```

## 5. 验收标准（可测试）

- [ ] 前端支持中文、英文、日文三种语言实时切换，刷新后保持选择
- [ ] 所有用户可见文本（按钮、提示、错误消息）均已提取到语言包
- [ ] 用户服务数据库包含 `language_preference` 字段，默认值 `zh-CN`
- [ ] 后端 API 根据用户语言偏好返回对应语言的错误消息
- [ ] 设置页面包含语言选择器，显示当前语言和国家/地区旗帜
- [ ] 新用户首次访问时，根据浏览器语言自动选择界面语言
- [ ] 语言包文件完整性验证脚本通过（无缺失翻译键）
- [ ] 切换语言后，所有 UI 文本立即更新，无需手动刷新
- [ ] 单元测试覆盖 i18n 工具函数，覆盖率 ≥ 80%
- [ ] 集成测试验证语言切换 API 端点正常工作

## 6. 工作量估算

**L (Large)**

- 前端 i18n 集成和组件改造：2-3 天
- 语言包翻译（中英日三语）：2 天
- 后端国际化中间件和错误消息改造：1-2 天
- 数据库迁移和用户偏好同步：1 天
- 测试和验证：1 天

**总计：7-9 天**

## 7. 优先级理由

**P2** 理由：

1. **市场拓展需求**：项目已达生产可用标准，国际化是拓展海外用户的关键能力
2. **非阻塞核心功能**：当前中文版已完整可用，国际化不影响核心游戏体验
3. **可渐进实施**：先支持三种主流语言，验证效果后再扩展更多语言
4. **高性价比**：一次性投入建立 i18n 架构，后续增加新语言成本低
5. **提升项目成熟度**：国际化是项目专业度的重要指标，有助于提升成熟度评分

虽然优先级为 P2，但这是项目走向国际化的第一步，具有战略意义。
