# REQ-00244：RTL 语言布局自动适配系统

- **编号**：REQ-00244
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/i18n、frontend/game-client/src/styles、gateway、backend/shared/i18n.js
- **创建时间**：2026-06-16 04:00
- **依赖需求**：REQ-00011（多语言国际化支持）

## 1. 背景与问题

mineGo 项目已实现多语言国际化支持（REQ-00011），支持英文、中文等从左到右（LTR）书写的语言。然而，对于阿拉伯语、希伯来语、波斯语、乌尔都语等从右到左（RTL）书写的语言，当前游戏客户端界面存在以下问题：

1. **布局翻转缺失**：UI 元素位置未自动镜像翻转，导致按钮、菜单、图标等排列错误
2. **文本对齐问题**：RTL 文本仍按 LTR 对齐方式显示，影响可读性
3. **图标方向错误**：前进/后退箭头、进度指示器等方向性图标未自动翻转
4. **表格和列表布局**：数据展示方向未适配 RTL 阅读习惯
5. **用户困惑**：RTL 语言用户无法正常使用游戏界面

根据数据统计，全球有超过 6 亿人使用 RTL 语言，覆盖中东、北非等重要市场。缺失 RTL 支持将严重影响这些地区的用户获取和留存。

## 2. 目标

实现游戏客户端 RTL 语言布局自动适配系统，确保阿拉伯语、希伯来语等 RTL 语言用户获得与 LTR 语言用户一致的优质体验。具体目标：

1. **自动检测与切换**：根据用户语言设置自动切换 LTR/RTL 布局模式
2. **UI 镜像翻转**：自动翻转界面元素布局，保持功能一致性
3. **文本正确渲染**：RTL 文本按正确方向和对齐方式显示
4. **图标方向适配**：方向性图标自动翻转，语义清晰
5. **性能无损**：布局切换不增加首屏加载时间

## 3. 范围

**包含**：
- RTL 语言检测与自动布局切换逻辑
- CSS 逻辑属性（`margin-inline-start`、`padding-inline-end` 等）重构
- 方向性图标自动翻转机制
- RTL 专用样式表生成与管理
- 用户语言偏好与布局方向联动
- 关键页面的 RTL 适配（主界面、捕捉界面、道馆界面、背包界面）

**不包含**：
- RTL 语言翻译内容（由 REQ-00137 翻译工作流系统负责）
- 第三方库的 RTL 适配（假设已支持或提供替代方案）
- 服务端 RTL 处理（主要影响客户端展示层）

## 4. 详细需求

### 4.1 RTL 语言检测器

```javascript
// frontend/game-client/src/i18n/rtlDetector.js

const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd'];

export class RTLDetector {
  static isRTL(locale) {
    const langCode = locale.split('-')[0].toLowerCase();
    return RTL_LANGUAGES.includes(langCode);
  }

  static getDirection(locale) {
    return this.isRTL(locale) ? 'rtl' : 'ltr';
  }
}
```

### 4.2 CSS 逻辑属性重构

将物理属性替换为逻辑属性：

| 物理属性 | 逻辑属性 |
|---------|---------|
| `margin-left` | `margin-inline-start` |
| `margin-right` | `margin-inline-end` |
| `padding-left` | `padding-inline-start` |
| `padding-right` | `padding-inline-end` |
| `border-left` | `border-inline-start` |
| `border-right` | `border-inline-end` |
| `float: left` | `float: inline-start` |
| `text-align: left` | `text-align: start` |

### 4.3 方向性图标翻转规则

```javascript
// frontend/game-client/src/i18n/iconFlipRules.js

export const FLIP_ICONS = [
  'arrow-right',      // → 翻转为 ←
  'arrow-left',       // → 翻转为 →
  'chevron-right',    // 右箭头 → 左箭头
  'chevron-left',     // 左箭头 → 右箭头
  'back',             // 返回按钮
  'forward',          // 前进按钮
  'redo',             // 重做
  'undo',             // 撤销
  'reply',            // 回复
  'share',            // 分享
  'menu-toggle',      // 菜单切换
];

export const NO_FLIP_ICONS = [
  'loading-spinner',  // 加载动画不翻转
  'logo',             // Logo 不翻转
  'avatar',           // 头像不翻转
  'pokemon-sprite',   // 精灵图片不翻转
];
```

### 4.4 RTL 样式注入器

```javascript
// frontend/game-client/src/i18n/RTLStyleInjector.js

export class RTLStyleInjector {
  constructor() {
    this.rtlStylesheet = null;
  }

  inject(locale) {
    const direction = RTLDetector.getDirection(locale);
    
    // 设置 HTML dir 属性
    document.documentElement.dir = direction;
    document.documentElement.lang = locale;
    
    // 动态注入 RTL 样式覆盖
    if (direction === 'rtl') {
      this.loadRTLOverrides();
    } else {
      this.removeRTLOverrides();
    }
  }

  loadRTLOverrides() {
    if (!this.rtlStylesheet) {
      this.rtlStylesheet = document.createElement('link');
      this.rtlStylesheet.rel = 'stylesheet';
      this.rtlStylesheet.href = '/styles/rtl-overrides.css';
      document.head.appendChild(this.rtlStylesheet);
    }
  }

  removeRTLOverrides() {
    if (this.rtlStylesheet) {
      this.rtlStylesheet.remove();
      this.rtlStylesheet = null;
    }
  }
}
```

### 4.5 后端语言方向信息接口

```http
GET /api/v1/i18n/locale-info?locale=ar-SA

Response:
{
  "locale": "ar-SA",
  "direction": "rtl",
  "isRTL": true,
  "numberFormat": {
    "decimal": "٫",
    "group": "٬",
    "currency": "ر.س"
  },
  "dateFormat": {
    "short": "dd/MM/yyyy",
    "long": "dd MMMM yyyy"
  }
}
```

### 4.6 关键页面适配检查清单

| 页面 | 适配要点 |
|-----|---------|
| 主界面 | 底部导航栏翻转、地图标记镜像 |
| 捕捉界面 | 捕捉按钮位置、精灵信息面板对齐 |
| 道馆界面 | 挑战按钮、对战日志滚动方向 |
| 背包界面 | 物品列表滚动方向、物品详情面板 |
| 好友列表 | 对话气泡方向、时间戳位置 |
| 设置页面 | 开关控件、选项列表对齐 |

## 5. 验收标准（可测试）

- [ ] **RTL 检测准确**：RTLDetector 正确识别 ar、he、fa、ur 等 RTL 语言，返回 `direction: 'rtl'`
- [ ] **HTML dir 属性正确**：切换到 RTL 语言时，`<html dir="rtl">` 已设置
- [ ] **UI 布局镜像**：主界面、捕捉界面、背包界面等关键页面的 UI 元素布局正确镜像
- [ ] **文本对齐正确**：RTL 文本右对齐显示，阅读方向正确
- [ ] **图标自动翻转**：arrow-right、chevron-right 等方向性图标自动水平翻转
- [ ] **图标不误翻转**：logo、avatar、pokemon-sprite 等图标保持原方向
- [ ] **语言切换流畅**：在 LTR 和 RTL 语言间切换，布局无闪烁或错位
- [ ] **E2E 测试通过**：Playwright 测试覆盖阿拉伯语界面关键操作流程
- [ ] **无性能退化**：首屏加载时间增加不超过 5%
- [ ] **用户验收通过**：邀请 3 名以上 RTL 语言母语用户测试，反馈正面

## 6. 工作量估算

**L（Large）**

- 涉及前端架构级修改，需重构大量 CSS 属性
- 6 个关键页面需逐一适配和测试
- 方向性图标处理需要设计团队配合
- E2E 测试用例编写耗时

预估工时：8-10 人天

## 7. 优先级理由

**P1 理由**：

1. **市场拓展**：RTL 语言覆盖中东、北非等重要市场，缺失支持将严重阻碍用户获取
2. **用户体验**：RTL 用户无法正常使用界面，体验严重受损，可能导致用户流失
3. **国际化完整度**：多语言支持缺少 RTL 适配是不完整的国际化
4. **修复成本**：越晚实现，累积的 UI 代码越多，重构成本越高
5. **合规风险**：部分地区可能对本地化有法规要求

虽然不影响核心功能，但对国际化和市场拓展至关重要，应尽快完成。
