# REQ-00351：游戏数字格式本地化系统

- **编号**：REQ-00351
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、gateway、user-service、pokemon-service、payment-service、backend/shared
- **创建时间**：2026-06-27 06:00 UTC
- **依赖需求**：REQ-00011（多语言国际化支持）

## 1. 背景与问题

mineGo 项目已实现多语言国际化支持（REQ-00011），支持中文、英文、日文三种语言。然而，在数字格式化方面存在以下问题：

1. **数字格式不一致**：代码中广泛使用 `toLocaleString()` 方法，但这是浏览器原生方法，在不同语言环境下行为可能不一致，且无法控制具体的格式化规则。

2. **缺少大数字缩写**：游戏场景中常见的数字缩写（如 1000 → 1K/1千/1千）没有统一实现，影响 UI 显示和用户体验。

3. **货币格式混乱**：金币、宝石等虚拟货币在不同语言环境下显示格式不统一（如 ¥1,000 vs $1,000 vs 1,000円）。

4. **百分比格式不统一**：捕捉概率、成功率等百分比数字格式不一致。

5. **游戏数值显示混乱**：精灵战力、经验值、伤害值等游戏特定数字没有统一的格式化规则，影响国际化体验。

例如，当前代码中存在以下问题：
```javascript
// 问题1: 直接使用 toLocaleString，格式不可控
userGold.toLocaleString() // 英文: 1,000 中文: 1,000（应该有千分号差异）

// 问题2: 大数字显示过长
damage.toLocaleString() // 1500000 显示为 "1,500,000"，应显示为 "1.5M"

// 问题3: 货币符号不统一
`${cost.toLocaleString()} ${currency}` // 中文应显示 "1,000金币"，日文应显示 "1,000ゴールド"
```

## 2. 目标

建立统一的数字格式本地化系统，确保：

1. **一致性**：所有数字在不同语言环境下显示格式统一、符合当地习惯。
2. **可读性**：大数字自动缩写，提升 UI 可读性。
3. **可配置**：支持自定义格式化规则，适应不同游戏场景。
4. **高性能**：格式化逻辑高效，支持缓存和预计算。

预期收益：
- 提升国际化用户体验，数字显示符合当地习惯。
- 减少代码重复，统一数字格式化逻辑。
- 提升游戏数值可读性，大数字缩写清晰直观。
- 降低 UI 布局复杂度，数字宽度可控。

## 3. 范围

**包含**：
- 数字格式本地化核心模块（支持中文、英文、日文）
- 大数字智能缩写系统（支持 K/M/B 和 万/亿）
- 货币格式化（金币、宝石、钻石等虚拟货币）
- 百分比格式化（捕捉概率、成功率等）
- 游戏数值格式化（战力、经验值、伤害值等）
- 前端格式化组件和工具函数
- 后端格式化中间件（API 响应数字格式化）
- 配置化格式化规则引擎
- 单元测试覆盖

**不包含**：
- 实时汇率转换（已在 REQ-00051 多货币支持中实现）
- 数字语音播报（属于无障碍功能，需单独需求）
- 复杂数学公式渲染
- 数据可视化图表（属于独立功能模块）

## 4. 详细需求

### 4.1 核心数字格式化模块

创建 `backend/shared/numberFormat.js` 和 `frontend/game-client/src/i18n/numberFormat.js`：

```javascript
// 核心格式化函数
const NumberFormatter = {
  // 格式化普通数字（带千分号）
  formatNumber(value, options = {}) {
    // options: { compact: boolean, precision: number }
    // zh-CN: 123,456 或 12.3万
    // en-US: 123,456 或 123.4K
    // ja-JP: 123,456 或 12.3万
  },
  
  // 格式化货币
  formatCurrency(value, currency, options = {}) {
    // currency: 'gold' | 'gems' | 'diamonds'
    // zh-CN: 1,234金币 或 1.2万金币
    // en-US: 1,234 Gold 或 1.2K Gold
    // ja-JP: 1,234ゴールド 或 1.2万ゴールド
  },
  
  // 格式化百分比
  formatPercent(value, options = {}) {
    // zh-CN: 45.6% 或 四成五
    // en-US: 45.6%
    // ja-JP: 45.6%
  },
  
  // 格式化大数字（智能缩写）
  formatCompact(value, options = {}) {
    // < 1,000: 显示完整数字
    // < 10,000: zh-CN 显示 "1234", en-US 显示 "1.2K"
    // < 1,000,000: zh-CN 显示 "12.3万", en-US 显示 "123.4K"
    // < 100,000,000: zh-CN 显示 "1234万", en-US 显示 "1.2M"
    // >= 100,000,000: zh-CN 显示 "1.2亿", en-US 显示 "123.4M"
  },
  
  // 格式化游戏数值（战力、经验值、伤害值等）
  formatGameValue(value, type, options = {}) {
    // type: 'power' | 'exp' | 'damage' | 'hp' | 'level'
    // 根据类型和语言环境智能选择格式
  }
};
```

### 4.2 语言特定的格式化规则

#### 4.2.1 中文（zh-CN）
- 千分号：使用西方千分号（,）分隔
- 大数字缩写：万（10^4）、亿（10^8）
- 货币符号：后置单位（如 "1,234金币"）
- 百分比：数字 + %（如 "45.6%"）

#### 4.2.2 英文（en-US）
- 千分号：使用逗号（,）分隔
- 大数字缩写：K（10^3）、M（10^6）、B（10^9）
- 货币符号：前置或后置（如 "1,234 Gold"）
- 百分比：数字 + %（如 "45.6%"）

#### 4.2.3 日文（ja-JP）
- 千分号：使用逗号（,）分隔
- 大数字缩写：万（10^4）、億（10^8）
- 货币符号：后置单位（如 "1,234ゴールド"）
- 百分比：数字 + %（如 "45.6%"）

### 4.3 配置化规则引擎

创建 `backend/shared/numberFormatConfig.js`：

```javascript
const FORMAT_CONFIGS = {
  'zh-CN': {
    compact: {
      thresholds: [
        { value: 100000000, unit: '亿', divisor: 100000000, precision: 2 },
        { value: 10000, unit: '万', divisor: 10000, precision: 1 },
        { value: 0, unit: '', divisor: 1, precision: 0 }
      ]
    },
    currencies: {
      gold: { symbol: '金币', position: 'suffix' },
      gems: { symbol: '宝石', position: 'suffix' },
      diamonds: { symbol: '钻石', position: 'suffix' }
    },
    gameValues: {
      power: { label: '战力', compact: true, precision: 1 },
      exp: { label: '经验', compact: true, precision: 0 },
      damage: { compact: true, precision: 0 },
      hp: { compact: false, precision: 0 }
    }
  },
  'en-US': {
    compact: {
      thresholds: [
        { value: 1000000000, unit: 'B', divisor: 1000000000, precision: 2 },
        { value: 1000000, unit: 'M', divisor: 1000000, precision: 1 },
        { value: 1000, unit: 'K', divisor: 1000, precision: 1 },
        { value: 0, unit: '', divisor: 1, precision: 0 }
      ]
    },
    currencies: {
      gold: { symbol: 'Gold', position: 'suffix' },
      gems: { symbol: 'Gems', position: 'suffix' },
      diamonds: { symbol: 'Diamonds', position: 'suffix' }
    }
  },
  'ja-JP': {
    compact: {
      thresholds: [
        { value: 100000000, unit: '億', divisor: 100000000, precision: 2 },
        { value: 10000, unit: '万', divisor: 10000, precision: 1 },
        { value: 0, unit: '', divisor: 1, precision: 0 }
      ]
    },
    currencies: {
      gold: { symbol: 'ゴールド', position: 'suffix' },
      gems: { symbol: 'ジェム', position: 'suffix' },
      diamonds: { symbol: 'ダイヤ', position: 'suffix' }
    }
  }
};
```

### 4.4 前端组件

创建 `frontend/game-client/src/components/FormattedNumber.js`：

```javascript
// React-like 组件
class FormattedNumber {
  static render(value, options = {}) {
    const { type = 'number', currency, compact = false, precision } = options;
    const formatter = NumberFormatter[`format${capitalize(type)}`];
    return formatter(value, { compact, precision, currency });
  }
}

// 使用示例
// <span>${FormattedNumber.render(userGold, { type: 'currency', currency: 'gold', compact: true })}</span>
// 输出: zh-CN "1.2万金币", en-US "12.3K Gold"
```

### 4.5 后端中间件

创建 `backend/shared/middleware/numberFormatMiddleware.js`：

```javascript
// API 响应数字格式化中间件
function numberFormatMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // 根据 Accept-Language 头自动格式化数字字段
    // 可配置哪些字段需要格式化
    return originalJson(formatNumbers(data, req.language));
  };
  next();
}
```

### 4.6 数据库迁移

无需数据库迁移，纯前端和中间件逻辑。

### 4.7 单元测试

创建 `backend/tests/unit/numberFormat.test.js`：

- 测试各语言环境下的数字格式化
- 测试大数字缩写逻辑
- 测试货币格式化
- 测试百分比格式化
- 测试边界值（0、负数、极大值）

## 5. 验收标准（可测试）

- [ ] 创建 `backend/shared/numberFormat.js` 核心模块，支持中/英/日三种语言
- [ ] 实现大数字智能缩写（万/亿 和 K/M/B）
- [ ] 实现货币格式化（金币、宝石、钻石），三种语言显示正确
- [ ] 实现百分比格式化，支持精度控制
- [ ] 实现游戏数值格式化（战力、经验值、伤害值等）
- [ ] 创建前端 `FormattedNumber` 组件，可在所有 UI 中使用
- [ ] 创建后端格式化中间件，API 响应自动格式化数字
- [ ] 重构现有代码，替换所有 `toLocaleString()` 调用
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 在背包、商店、精灵详情、战斗等页面验证数字显示正确

## 6. 工作量估算

**M（中等）**，约 1-2 天

理由：
- 核心逻辑相对简单，主要是格式化规则和配置。
- 需要重构现有代码，替换 `toLocaleString()` 调用，工作量适中。
- 单元测试编写工作量可控。

## 7. 优先级理由

**P1** 理由：

1. **国际化基础**：数字格式化是国际化的重要组成部分，直接影响用户体验。
2. **影响范围广**：游戏 UI 中大量使用数字显示，影响背包、商店、战斗等核心功能。
3. **提升专业性**：统一的数字格式化系统是成熟游戏的标志。
4. **依赖其他功能**：大数字缩写等功能对游戏体验提升明显，应尽早实现。
5. **工作量适中**：可在短时间内完成，快速提升国际化质量。

与项目目标一致性：
- 支持项目全球化部署目标
- 提升多语言用户体验
- 符合"生产可用"标准中的国际化要求
