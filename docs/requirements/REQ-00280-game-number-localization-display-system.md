# REQ-00280：游戏数值本地化显示系统

- **编号**：REQ-00280
- **类别**：国际化/本地化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client/src/utils、game-client/src/components、backend/shared/i18n.js
- **创建时间**：2026-06-22 04:00
- **依赖需求**：REQ-00011（多语言 i18n 支持）

## 1. 背景与问题

当前游戏客户端在显示大数值时存在以下问题：

1. **直接使用 toLocaleString()**：仅添加千分位分隔符，无法显示语言习惯的单位
   - `12345678.toLocaleString()` → "12,345,678"（所有语言相同）
   
2. **缺少语言特定的数值单位**：
   - 中文习惯：1万、10万、100万、1亿、10亿
   - 英文习惯：10K、100K、1M、10M、100M、1B
   - 日文习惯：1万、10万、100万、1億、10億

3. **游戏数值类型多样**：
   - 经验值（XP）：可能达到数百万
   - 金币/宝石：可能达到数千万
   - 战力（CP）：可能达到数十万
   - 伤害值：可能达到数万
   - 距离：米/千米转换

4. **当前代码问题**：
   ```javascript
   // BagUpgradeModal.js
   <span>💰 金币: {userGold.toLocaleString()}</span>  // 显示 "12,345,678"
   // 应显示 "1234万" (中文) 或 "12.3M" (英文)
   
   // BattleScene.js
   <span>+{battleState.result.rewards.experienceGained}</span>  // 显示原始数字
   // 应显示 "+1.2万" (中文) 或 "+12K" (英文)
   ```

## 2. 目标

构建游戏数值本地化显示系统，实现：

1. **智能数值格式化**：根据数值大小和语言习惯自动选择最佳显示格式
2. **多语言单位支持**：中文（万/亿）、英文（K/M/B）、日文（万/億）
3. **数值类型感知**：经验值、金币、战力、距离等不同类型的格式化策略
4. **配置化阈值**：可配置何时启用紧凑显示（如 >10000 时启用）
5. **动画友好**：支持数值变化动画时的中间值格式化

预期收益：
- 提升数值可读性，减少用户认知负担
- 符合各语言用户的阅读习惯
- UI 空间节省（紧凑显示）
- 提升国际化体验

## 3. 范围

- **包含**：
  - 数值格式化核心引擎：NumberFormatter 类
  - 多语言单位配置：zh-CN、en-US、ja-JP 的单位定义
  - 数值类型枚举：XP、GOLD、GEMS、CP、DAMAGE、DISTANCE、PERCENTAGE
  - 前端工具函数：formatNumber、formatCompact、formatDistance
  - i18n 集成：自动根据当前语言选择格式化策略
  - 单元测试：覆盖各语言、各数值类型的格式化

- **不包含**：
  - 后端 API 返回值格式化（后端返回原始数值）
  - 货币格式化（已有 REQ-00224）
  - 日期时间格式化（已有 REQ-00029）

## 4. 详细需求

### 4.1 数值类型枚举

```javascript
// game-client/src/utils/NumberFormatter.js
export const NumberType = {
  XP: 'xp',           // 经验值：+1.2万
  GOLD: 'gold',       // 金币：1234万
  GEMS: 'gems',       // 宝石：1,234（不紧凑）
  CP: 'cp',           // 战力：12.3K
  DAMAGE: 'damage',   // 伤害：-9999
  DISTANCE: 'distance', // 距离：1.2km
  PERCENTAGE: 'percentage', // 百分比：99.9%
  DEFAULT: 'default'  // 默认：千分位分隔
};
```

### 4.2 语言单位配置

```javascript
// game-client/src/utils/NumberFormatter.js
const COMPACT_UNITS = {
  'zh-CN': [
    { threshold: 1e8, unit: '亿', divisor: 1e8, decimals: 2 },
    { threshold: 1e4, unit: '万', divisor: 1e4, decimals: 1 }
  ],
  'en-US': [
    { threshold: 1e9, unit: 'B', divisor: 1e9, decimals: 1 },
    { threshold: 1e6, unit: 'M', divisor: 1e6, decimals: 1 },
    { threshold: 1e3, unit: 'K', divisor: 1e3, decimals: 1 }
  ],
  'ja-JP': [
    { threshold: 1e8, unit: '億', divisor: 1e8, decimals: 2 },
    { threshold: 1e4, unit: '万', divisor: 1e4, decimals: 1 }
  ]
};

// 宝石不使用紧凑显示
const NO_COMPACT_TYPES = [NumberType.GEMS];
```

### 4.3 核心格式化类

```javascript
// game-client/src/utils/NumberFormatter.js
import { i18n } from '../i18n';

export class NumberFormatter {
  constructor(locale = 'en-US') {
    this.locale = locale;
    this.units = COMPACT_UNITS[locale] || COMPACT_UNITS['en-US'];
  }

  /**
   * 格式化数值
   * @param {number} value - 数值
   * @param {Object} options - 选项
   * @param {NumberType} options.type - 数值类型
   * @param {boolean} options.compact - 是否启用紧凑显示
   * @param {number} options.decimals - 小数位数
   * @param {boolean} options.showSign - 显示正负号
   * @returns {string} 格式化后的字符串
   */
  format(value, options = {}) {
    const {
      type = NumberType.DEFAULT,
      compact = true,
      decimals,
      showSign = false
    } = options;

    // 特殊类型处理
    if (type === NumberType.PERCENTAGE) {
      return this.formatPercentage(value, decimals);
    }
    
    if (type === NumberType.DISTANCE) {
      return this.formatDistance(value);
    }

    // 宝石不紧凑显示
    const useCompact = compact && !NO_COMPACT_TYPES.includes(type);

    // 紧凑显示
    if (useCompact && Math.abs(value) >= 10000) {
      return this.formatCompact(value, decimals);
    }

    // 默认千分位格式化
    return this.formatDefault(value, showSign);
  }

  /**
   * 紧凑格式化（带单位）
   */
  formatCompact(value, forcedDecimals) {
    const absValue = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    
    for (const unitConfig of this.units) {
      if (absValue >= unitConfig.threshold) {
        const compacted = absValue / unitConfig.divisor;
        const decimals = forcedDecimals ?? unitConfig.decimals;
        const formatted = compacted.toFixed(decimals);
        // 移除末尾的 0
        const trimmed = parseFloat(formatted).toString();
        return `${sign}${trimmed}${unitConfig.unit}`;
      }
    }

    return this.formatDefault(value);
  }

  /**
   * 默认格式化（千分位）
   */
  formatDefault(value, showSign = false) {
    const absValue = Math.abs(value);
    const sign = value < 0 ? '-' : (showSign && value > 0 ? '+' : '');
    
    try {
      const formatted = new Intl.NumberFormat(this.locale).format(absValue);
      return `${sign}${formatted}`;
    } catch (err) {
      return `${sign}${absValue.toLocaleString()}`;
    }
  }

  /**
   * 百分比格式化
   */
  formatPercentage(value, decimals = 1) {
    return `${value.toFixed(decimals)}%`;
  }

  /**
   * 距离格式化（米 → 千米）
   */
  formatDistance(meters) {
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    const km = meters / 1000;
    return `${km.toFixed(1)}km`;
  }

  /**
   * 设置语言
   */
  setLocale(locale) {
    this.locale = locale;
    this.units = COMPACT_UNITS[locale] || COMPACT_UNITS['en-US'];
  }
}

// 单例实例
let formatter = new NumberFormatter();

/**
 * 获取当前语言的格式化器
 */
export function getFormatter() {
  const locale = i18n.currentLocale?.() || 'en-US';
  if (formatter.locale !== locale) {
    formatter.setLocale(locale);
  }
  return formatter;
}

/**
 * 快捷函数：格式化数值
 */
export function formatNumber(value, options = {}) {
  return getFormatter().format(value, options);
}

/**
 * 快捷函数：紧凑格式化
 */
export function formatCompact(value, decimals) {
  return getFormatter().formatCompact(value, decimals);
}

/**
 * 快捷函数：距离格式化
 */
export function formatDistance(meters) {
  return getFormatter().formatDistance(meters);
}
```

### 4.4 i18n 集成

```javascript
// game-client/src/i18n/index.js 修改
import { NumberFormatter } from '../utils/NumberFormatter';

// 语言切换时更新格式化器
function setLocale(locale) {
  // ... 现有逻辑
  numberFormatter.setLocale(locale);
}

// 导出格式化器
export const numberFormatter = new NumberFormatter();
```

### 4.5 组件使用示例

```javascript
// BagUpgradeModal.js 修改
import { formatNumber, NumberType } from '../utils/NumberFormatter';

// 修改前
<span>💰 金币: {userGold.toLocaleString()}</span>

// 修改后
<span>💰 金币: {formatNumber(userGold, { type: NumberType.GOLD })}</span>
// 中文显示：💰 金币: 1234万
// 英文显示：💰 金币: 12.3M

// BattleScene.js 修改
<span>+{formatNumber(battleState.result.rewards.experienceGained, { 
  type: NumberType.XP, 
  showSign: true 
})}</span>
// 显示：+1.2万 或 +12K

// PokemonCard.js 修改
<span class="cp">CP: {formatNumber(pokemon.cp, { type: NumberType.CP })}</span>
// 显示：CP: 12.3K

// DistanceDisplay.js 修改
<span>{formatDistance(distance)}m</span>
// 显示：1.2km（大于 1000m 时）
```

### 4.6 单元测试

```javascript
// tests/unit/NumberFormatter.test.js
import { NumberFormatter, formatNumber, NumberType } from '../../src/utils/NumberFormatter';

describe('NumberFormatter', () => {
  describe('zh-CN', () => {
    const formatter = new NumberFormatter('zh-CN');

    test('万单位', () => {
      expect(formatter.format(12345)).toBe('1.2万');
      expect(formatter.format(100000)).toBe('10万');
    });

    test('亿单位', () => {
      expect(formatter.format(123456789)).toBe('1.23亿');
      expect(formatter.format(100000000)).toBe('1亿');
    });

    test('小数值不紧凑', () => {
      expect(formatter.format(9999)).toBe('9,999');
    });
  });

  describe('en-US', () => {
    const formatter = new NumberFormatter('en-US');

    test('K单位', () => {
      expect(formatter.format(12345)).toBe('12.3K');
      expect(formatter.format(1000)).toBe('1K');
    });

    test('M单位', () => {
      expect(formatter.format(1234567)).toBe('1.2M');
    });

    test('B单位', () => {
      expect(formatter.format(1234567890)).toBe('1.2B');
    });
  });

  describe('ja-JP', () => {
    const formatter = new NumberFormatter('ja-JP');

    test('万单位', () => {
      expect(formatter.format(12345)).toBe('1.2万');
    });

    test('億单位', () => {
      expect(formatter.format(123456789)).toBe('1.23億');
    });
  });

  describe('类型感知', () => {
    test('宝石不紧凑', () => {
      const formatter = new NumberFormatter('zh-CN');
      expect(formatter.format(12345, { type: NumberType.GEMS })).toBe('12,345');
    });

    test('百分比', () => {
      const formatter = new NumberFormatter('en-US');
      expect(formatter.format(99.9, { type: NumberType.PERCENTAGE })).toBe('99.9%');
    });

    test('距离', () => {
      const formatter = new NumberFormatter('en-US');
      expect(formatter.formatDistance(500)).toBe('500m');
      expect(formatter.formatDistance(1500)).toBe('1.5km');
    });
  });

  describe('显示符号', () => {
    test('正号', () => {
      const formatter = new NumberFormatter('en-US');
      expect(formatter.format(1234, { showSign: true })).toBe('+1,234');
    });

    test('负号', () => {
      const formatter = new NumberFormatter('en-US');
      expect(formatter.format(-1234)).toBe('-1,234');
    });
  });
});
```

### 4.7 配置选项

```javascript
// game-client/src/config/numberFormat.js
export const NUMBER_FORMAT_CONFIG = {
  // 紧凑显示阈值
  compactThreshold: 10000,
  
  // 各类型的默认小数位数
  decimals: {
    xp: 1,
    gold: 1,
    cp: 1,
    damage: 0
  },
  
  // 是否启用紧凑显示（可由用户在设置中关闭）
  enableCompact: true
};
```

## 5. 验收标准（可测试）

- [ ] 中文格式化：12345 → "1.2万"，123456789 → "1.23亿"
- [ ] 英文格式化：12345 → "12.3K"，1234567 → "1.2M"，1234567890 → "1.2B"
- [ ] 日文格式化：12345 → "1.2万"，123456789 → "1.23億"
- [ ] 小于阈值不紧凑：9999 → "9,999"（中文/英文）
- [ ] 宝石类型不紧凑：12345 宝石 → "12,345"
- [ ] 距离格式化：500m → "500m"，1500m → "1.5km"
- [ ] 百分比格式化：99.9 → "99.9%"
- [ ] 显示符号：+1234 → "+1,234"，-1234 → "-1,234"
- [ ] 语言切换：切换语言后格式化器自动更新
- [ ] 单元测试覆盖率 > 95%

## 6. 工作量估算

**M（Medium）**

理由：
- 核心逻辑简单，主要是配置和映射
- 需要修改多个组件的使用方式
- 需要完整的单元测试覆盖
- 预计 1-2 天完成

## 7. 优先级理由

**P2（中优先级）**

理由：
1. **用户体验提升**：数值可读性直接影响游戏体验
2. **国际化完善**：是 i18n 体系的重要补充
3. **低风险**：纯前端实现，不影响后端逻辑
4. **依赖已满足**：REQ-00011 已完成
5. **成熟度提升**：完善国际化/本地化维度
