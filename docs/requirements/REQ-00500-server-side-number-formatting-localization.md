# REQ-00500：服务端数字格式化本地化与多语言统一系统

- **编号**：REQ-00500
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/numberFormat.js、所有后端服务、gateway/middleware、日志系统、推送通知
- **创建时间**：2026-07-08 09:00 UTC
- **依赖需求**：REQ-00488（游戏文本本地化缓存系统）、REQ-00496（推送通知内容多语言本地化）

## 1. 背景与问题

mineGo 项目前端已有完善的数字格式化本地化系统（`frontend/game-client/src/utils/numberFormat.js`），支持中文、英文、日文三种语言的数字格式化，包括货币、百分比、游戏数值、距离、时间等。然而，**后端完全缺失对应的数字格式化能力**，导致以下问题：

**当前痛点：**

1. **前后端格式化逻辑重复**
   - 前端已实现完整的数字格式化逻辑（千分位、单位转换、货币符号等）
   - 后端 API 返回原始数字，前端每次都需要重新格式化
   - 例如：`{ gold: 100000 }` → 前端需调用 `formatCurrency(100000, 'gold')` 显示为 "10万金币" 或 "100K Gold"

2. **服务端内容缺少本地化**
   - 推送通知、邮件、日志中的数字都是原始格式
   - 例如：推送通知 "You spent 5000 gold" → 应为 "You spent 5K Gold"（英文）或 "您花费了 5,000 金币"（中文）
   - 服务端日志输出 "User gained 1000000 exp" → 应为 "User gained 1M exp"（更易读）

3. **格式化一致性难以保证**
   - 前端格式化配置在 `numberFormatConfig.js`，后端无法复用
   - 若格式化规则变更（如货币符号、单位转换阈值），需同时修改前后端
   - 易出现格式化不一致问题

4. **缺少本地化的 API 响应选项**
   - 某些场景需要服务端直接返回格式化字符串（如邮件模板、推送通知）
   - 当前 API 只返回原始数字，无法满足这些需求

**真实代码现状：**
- 前端：`frontend/game-client/src/utils/numberFormat.js` 已实现 15+ 种格式化方法
- 后端：无对应的 `backend/shared/numberFormat.js`
- 推送通知：REQ-00496 实现了文本本地化，但数字格式化仍依赖字符串拼接
- 日志系统：所有数字都是原始格式，缺乏可读性

**影响范围：**
- 后端 9 个微服务都需要数字格式化能力
- 推送通知、邮件、日志等场景需要统一的格式化输出
- 前后端格式化逻辑维护成本高

## 2. 目标

建立统一的服务端数字格式化本地化系统：

- **服务端格式化核心模块**：复用前端格式化逻辑，实现 `backend/shared/numberFormat.js`
- **统一配置管理**：前后端共享同一份格式化配置，避免重复和不一致
- **API 响应格式化选项**：支持返回格式化字符串或原始数字（通过请求参数控制）
- **日志与通知本地化**：服务端日志、推送通知、邮件中的数字自动本地化格式化
- **性能优化**：格式化结果缓存、批量格式化支持

**可量化目标：**
- 格式化逻辑前后端复用率：100%（配置共享）
- API 支持格式化响应的端点覆盖率：> 80%
- 推送通知中数字格式化准确率：100%
- 服务端日志数字可读性提升：> 90%（抽样评估）

## 3. 范围

**包含：**
- 服务端数字格式化核心模块（`backend/shared/numberFormat.js`）
- 统一配置模块（从 `numberFormatConfig.js` 提取共享配置）
- API 响应格式化中间件
- 日志数字格式化增强
- 推送通知数字格式化集成
- 单元测试与集成测试

**不包含：**
- 前端格式化逻辑重构（保持现有实现）
- 数据库存储格式化结果（仅运行时格式化）
- 客户端多语言翻译（已在 REQ-00488 中实现）

## 4. 详细需求

### 4.1 服务端数字格式化核心模块

创建 `backend/shared/numberFormat.js`，复用前端逻辑：

```javascript
/**
 * 服务端数字格式化本地化模块
 * 与前端 frontend/game-client/src/utils/numberFormat.js 共享配置
 */
'use strict';

const { FORMAT_CONFIGS, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } = require('./numberFormatConfig');

/**
 * ServerNumberFormatter - 统一服务端数字格式化
 */
const ServerNumberFormatter = {
  /**
   * 格式化数字（千分位）
   */
  formatNumber(value, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) return '0';
    
    const config = FORMAT_CONFIGS[locale] || FORMAT_CONFIGS[DEFAULT_LANGUAGE];
    const { precision = 0, compact = false } = options;
    
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    let formatted;
    if (compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { precision });
    } else {
      const fixed = precision > 0 ? absValue.toFixed(precision) : Math.floor(absValue).toString();
      const parts = fixed.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, config.thousandSeparator);
      formatted = parts.join(config.decimalSeparator);
    }
    
    return isNegative ? `-${formatted}` : formatted;
  },

  /**
   * 格式化大数（紧凑表示）
   * zh-CN: 1.2万, 3.5亿
   * en-US: 1.2K, 3.5M, 1.2B
   * ja-JP: 1.2万, 3.5億
   */
  formatCompact(value, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) return '0';
    
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    const config = FORMAT_CONFIGS[locale] || FORMAT_CONFIGS[DEFAULT_LANGUAGE];
    const thresholds = config.compact.thresholds;
    
    let threshold = thresholds.find(t => absValue >= t.value);
    if (!threshold) threshold = thresholds[thresholds.length - 1];
    
    if (threshold.divisor === 1) {
      const formatted = Math.floor(absValue).toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, config.thousandSeparator);
      return isNegative ? `-${formatted}` : formatted;
    }
    
    const scaled = absValue / threshold.divisor;
    const precision = options.precision ?? threshold.precision;
    const formatted = scaled.toFixed(precision);
    const result = parseFloat(formatted).toString() + threshold.unit;
    
    return isNegative ? `-${result}` : result;
  },

  /**
   * 格式化游戏货币（金币、钻石、宝石）
   */
  formatCurrency(value, currency = 'gold', locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) value = 0;
    
    const config = FORMAT_CONFIGS[locale] || FORMAT_CONFIGS[DEFAULT_LANGUAGE];
    const currencyConfig = config.currencies[currency] || config.currencies.gold;
    
    const { compact = true, precision } = options;
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    let formatted;
    if (compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { precision });
    } else {
      formatted = this.formatNumber(absValue, locale, { precision });
    }
    
    const { symbol, position, spacing } = currencyConfig;
    const space = spacing ? ' ' : '';
    
    let result = position === 'prefix' 
      ? `${symbol}${space}${formatted}` 
      : `${formatted}${space}${symbol}`;
    
    return isNegative ? `-${result}` : result;
  },

  /**
   * 格式化百分比
   */
  formatPercent(value, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) return '0%';
    
    const config = FORMAT_CONFIGS[locale] || FORMAT_CONFIGS[DEFAULT_LANGUAGE];
    const { precision = config.percent.precision, normalize = true } = options;
    
    let percentValue = normalize && value <= 1 && value >= 0 ? value * 100 : value;
    percentValue = Math.max(0, Math.min(100, percentValue));
    
    return `${percentValue.toFixed(precision)}${config.percent.suffix}`;
  },

  /**
   * 格式化游戏数值（战斗力、经验、伤害、HP）
   */
  formatGameValue(value, type = 'power', locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) value = 0;
    
    const config = FORMAT_CONFIGS[locale] || FORMAT_CONFIGS[DEFAULT_LANGUAGE];
    const valueConfig = config.gameValues[type];
    
    if (!valueConfig) return this.formatNumber(value, locale, options);
    
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    let formatted;
    if (valueConfig.compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { 
        precision: options.precision ?? valueConfig.precision 
      });
    } else {
      formatted = this.formatNumber(absValue, locale, { 
        precision: options.precision ?? valueConfig.precision 
      });
    }
    
    if (valueConfig.suffix) formatted = `${formatted}${valueConfig.suffix}`;
    
    if (valueConfig.showLabel && valueConfig.label) {
      const space = locale === 'en-US' ? ' ' : '';
      formatted = valueConfig.prefix 
        ? `${valueConfig.label}${formatted}` 
        : `${formatted}${space}${valueConfig.label}`;
    }
    
    return isNegative ? `-${formatted}` : formatted;
  },

  /**
   * 格式化距离（米→公里）
   */
  formatDistance(meters, locale = DEFAULT_LANGUAGE, options = {}) {
    const { precision = 1, unit = 'auto' } = options;
    
    const isNegative = meters < 0;
    const absMeters = Math.abs(meters);
    
    let formatted, unitStr;
    
    if (unit === 'auto') {
      if (absMeters >= 1000) {
        formatted = (absMeters / 1000).toFixed(precision);
        unitStr = locale === 'en-US' ? 'km' : '公里';
      } else {
        formatted = Math.floor(absMeters).toString();
        unitStr = locale === 'en-US' ? 'm' : '米';
      }
    } else if (unit === 'km') {
      formatted = (absMeters / 1000).toFixed(precision);
      unitStr = locale === 'en-US' ? 'km' : '公里';
    } else {
      formatted = Math.floor(absMeters).toString();
      unitStr = locale === 'en-US' ? 'm' : '米';
    }
    
    const result = `${formatted}${locale === 'en-US' ? ' ' : ''}${unitStr}`;
    return isNegative ? `-${result}` : result;
  },

  /**
   * 格式化持续时间（秒→可读格式）
   */
  formatDuration(seconds, locale = DEFAULT_LANGUAGE) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) {
      return locale === 'en-US' ? '0s' : '0秒';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    
    if (locale === 'zh-CN') {
      if (hours > 0) parts.push(`${hours}小时`);
      if (minutes > 0) parts.push(`${minutes}分钟`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);
    } else if (locale === 'en-US') {
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    } else if (locale === 'ja-JP') {
      if (hours > 0) parts.push(`${hours}時間`);
      if (minutes > 0) parts.push(`${minutes}分`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);
    }
    
    return parts.join(locale === 'en-US' ? ' ' : '');
  },

  /**
   * 格式化倒计时（MM:SS 或 HH:MM:SS）
   */
  formatCountdown(seconds, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) seconds = 0;
    
    const { showHours = false } = options;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (showHours || hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  },

  /**
   * 批量格式化（提升性能）
   */
  formatBatch(items, locale = DEFAULT_LANGUAGE) {
    return items.map(item => {
      const { value, type = 'number', ...options } = item;
      
      switch (type) {
        case 'currency':
          return this.formatCurrency(value, options.currency || 'gold', locale, options);
        case 'percent':
          return this.formatPercent(value, locale, options);
        case 'compact':
          return this.formatCompact(value, locale, options);
        case 'gameValue':
          return this.formatGameValue(value, options.valueType || 'power', locale, options);
        case 'distance':
          return this.formatDistance(value, locale, options);
        case 'duration':
          return this.formatDuration(value, locale);
        case 'countdown':
          return this.formatCountdown(value, locale, options);
        default:
          return this.formatNumber(value, locale, options);
      }
    });
  }
};

// 导出便捷函数
const formatNumber = ServerNumberFormatter.formatNumber.bind(ServerNumberFormatter);
const formatCompact = ServerNumberFormatter.formatCompact.bind(ServerNumberFormatter);
const formatCurrency = ServerNumberFormatter.formatCurrency.bind(ServerNumberFormatter);
const formatPercent = ServerNumberFormatter.formatPercent.bind(ServerNumberFormatter);
const formatGameValue = ServerNumberFormatter.formatGameValue.bind(ServerNumberFormatter);
const formatDistance = ServerNumberFormatter.formatDistance.bind(ServerNumberFormatter);
const formatDuration = ServerNumberFormatter.formatDuration.bind(ServerNumberFormatter);
const formatCountdown = ServerNumberFormatter.formatCountdown.bind(ServerNumberFormatter);
const formatBatch = ServerNumberFormatter.formatBatch.bind(ServerNumberFormatter);

module.exports = {
  ServerNumberFormatter,
  formatNumber,
  formatCompact,
  formatCurrency,
  formatPercent,
  formatGameValue,
  formatDistance,
  formatDuration,
  formatCountdown,
  formatBatch,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES
};
```

### 4.2 统一配置模块

创建 `backend/shared/numberFormatConfig.js`（从前端提取共享配置）：

```javascript
/**
 * 数字格式化统一配置
 * 前后端共享，确保格式化一致性
 */
'use strict';

const DEFAULT_LANGUAGE = 'zh-CN';
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];

const FORMAT_CONFIGS = {
  'zh-CN': {
    thousandSeparator: ',',
    decimalSeparator: '.',
    compact: {
      thresholds: [
        { value: 1e12, divisor: 1e8, unit: '亿', precision: 2 },
        { value: 1e8, divisor: 1e8, unit: '亿', precision: 2 },
        { value: 1e4, divisor: 1e4, unit: '万', precision: 1 },
        { value: 1, divisor: 1, unit: '', precision: 0 }
      ]
    },
    currencies: {
      gold: { symbol: '金币', position: 'suffix', spacing: false },
      gems: { symbol: '💎', position: 'prefix', spacing: true },
      diamonds: { symbol: '💎', position: 'prefix', spacing: true }
    },
    percent: { suffix: '%', precision: 1 },
    gameValues: {
      power: { suffix: '', label: 'CP', showLabel: true, prefix: true, precision: 0, compact: true },
      exp: { suffix: '', label: '经验', showLabel: true, prefix: false, precision: 0, compact: true },
      damage: { suffix: '', label: '伤害', showLabel: false, precision: 0, compact: true },
      hp: { suffix: '', label: 'HP', showLabel: true, prefix: true, precision: 0, compact: false },
      level: { suffix: '', label: 'Lv.', showLabel: true, prefix: true, precision: 0, compact: false },
      catchRate: { suffix: '%', label: '', showLabel: false, precision: 1, compact: false }
    }
  },
  'en-US': {
    thousandSeparator: ',',
    decimalSeparator: '.',
    compact: {
      thresholds: [
        { value: 1e12, divisor: 1e9, unit: 'B', precision: 2 },
        { value: 1e9, divisor: 1e9, unit: 'B', precision: 2 },
        { value: 1e6, divisor: 1e6, unit: 'M', precision: 2 },
        { value: 1e3, divisor: 1e3, unit: 'K', precision: 1 },
        { value: 1, divisor: 1, unit: '', precision: 0 }
      ]
    },
    currencies: {
      gold: { symbol: 'Gold', position: 'suffix', spacing: true },
      gems: { symbol: '💎', position: 'prefix', spacing: true },
      diamonds: { symbol: '💎', position: 'prefix', spacing: true }
    },
    percent: { suffix: '%', precision: 1 },
    gameValues: {
      power: { suffix: '', label: 'CP', showLabel: true, prefix: true, precision: 0, compact: true },
      exp: { suffix: '', label: 'XP', showLabel: true, prefix: true, precision: 0, compact: true },
      damage: { suffix: '', label: 'DMG', showLabel: false, precision: 0, compact: true },
      hp: { suffix: '', label: 'HP', showLabel: true, prefix: true, precision: 0, compact: false },
      level: { suffix: '', label: 'Lv.', showLabel: true, prefix: true, precision: 0, compact: false },
      catchRate: { suffix: '%', label: '', showLabel: false, precision: 1, compact: false }
    }
  },
  'ja-JP': {
    thousandSeparator: ',',
    decimalSeparator: '.',
    compact: {
      thresholds: [
        { value: 1e12, divisor: 1e8, unit: '兆', precision: 2 },
        { value: 1e8, divisor: 1e8, unit: '億', precision: 2 },
        { value: 1e4, divisor: 1e4, unit: '万', precision: 1 },
        { value: 1, divisor: 1, unit: '', precision: 0 }
      ]
    },
    currencies: {
      gold: { symbol: 'ゴールド', position: 'suffix', spacing: false },
      gems: { symbol: '💎', position: 'prefix', spacing: true },
      diamonds: { symbol: '💎', position: 'prefix', spacing: true }
    },
    percent: { suffix: '%', precision: 1 },
    gameValues: {
      power: { suffix: '', label: 'CP', showLabel: true, prefix: true, precision: 0, compact: true },
      exp: { suffix: '', label: '経験値', showLabel: true, prefix: false, precision: 0, compact: true },
      damage: { suffix: '', label: 'ダメージ', showLabel: false, precision: 0, compact: true },
      hp: { suffix: '', label: 'HP', showLabel: true, prefix: true, precision: 0, compact: false },
      level: { suffix: '', label: 'Lv.', showLabel: true, prefix: true, precision: 0, compact: false },
      catchRate: { suffix: '%', label: '', showLabel: false, precision: 1, compact: false }
    }
  }
};

module.exports = {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  FORMAT_CONFIGS
};
```

### 4.3 API 响应格式化中间件

创建 `backend/gateway/src/middleware/numberFormatMiddleware.js`：

```javascript
/**
 * API 响应数字格式化中间件
 * 根据 x-format-numbers 请求头自动格式化响应中的数字字段
 */
'use strict';

const { formatCurrency, formatGameValue, formatDistance, formatDuration } = require('../../shared/numberFormat');

/**
 * 数字格式化中间件
 */
function numberFormatMiddleware(req, res, next) {
  // 检查客户端是否请求格式化数字
  const shouldFormat = req.headers['x-format-numbers'] === 'true';
  
  if (!shouldFormat) {
    return next();
  }
  
  // 获取当前语言
  const locale = req.language || 'zh-CN';
  
  // 保存原始 res.json
  const originalJson = res.json.bind(res);
  
  // 重写 res.json
  res.json = function(data) {
    if (data && typeof data === 'object') {
      data = formatResponseNumbers(data, locale);
    }
    return originalJson(data);
  };
  
  next();
}

/**
 * 递归格式化响应中的数字字段
 */
function formatResponseNumbers(obj, locale, depth = 0) {
  if (depth > 10) return obj; // 防止无限递归
  
  if (Array.isArray(obj)) {
    return obj.map(item => formatResponseNumbers(item, locale, depth + 1));
  }
  
  if (obj && typeof obj === 'object') {
    const formatted = { ...obj };
    
    // 根据字段名自动识别数字类型并格式化
    for (const [key, value] of Object.entries(formatted)) {
      if (typeof value === 'number' && !isNaN(value)) {
        // 货币字段
        if (key.includes('gold') || key.includes('Gold')) {
          formatted[`${key}_formatted`] = formatCurrency(value, 'gold', locale);
        }
        else if (key.includes('gem') || key.includes('Gem')) {
          formatted[`${key}_formatted`] = formatCurrency(value, 'gems', locale);
        }
        else if (key.includes('diamond') || key.includes('Diamond')) {
          formatted[`${key}_formatted`] = formatCurrency(value, 'diamonds', locale);
        }
        // 游戏数值字段
        else if (key === 'power' || key === 'cp' || key === 'combatPower') {
          formatted[`${key}_formatted`] = formatGameValue(value, 'power', locale);
        }
        else if (key === 'exp' || key === 'experience') {
          formatted[`${key}_formatted`] = formatGameValue(value, 'exp', locale);
        }
        else if (key === 'damage' || key === 'dmg') {
          formatted[`${key}_formatted`] = formatGameValue(value, 'damage', locale);
        }
        else if (key === 'hp' || key === 'health') {
          formatted[`${key}_formatted`] = formatGameValue(value, 'hp', locale);
        }
        else if (key === 'level' || key === 'lv') {
          formatted[`${key}_formatted`] = formatGameValue(value, 'level', locale);
        }
        else if (key === 'catchRate' || key === 'captureRate') {
          formatted[`${key}_formatted`] = formatGameValue(value, 'catchRate', locale);
        }
        // 距离字段
        else if (key.includes('distance') || key.includes('Distance')) {
          formatted[`${key}_formatted`] = formatDistance(value, locale);
        }
        // 时间字段
        else if (key.includes('duration') || key.includes('Duration')) {
          formatted[`${key}_formatted`] = formatDuration(value, locale);
        }
        else if (key.includes('cooldown') || key.includes('Cooldown')) {
          formatted[`${key}_formatted`] = formatDuration(value, locale);
        }
      }
      // 递归处理嵌套对象
      else if (typeof value === 'object' && value !== null) {
        formatted[key] = formatResponseNumbers(value, locale, depth + 1);
      }
    }
    
    return formatted;
  }
  
  return obj;
}

module.exports = { numberFormatMiddleware, formatResponseNumbers };
```

### 4.4 日志数字格式化增强

创建 `backend/shared/formattedLogger.js`：

```javascript
/**
 * 增强日志格式化工具
 * 自动格式化日志中的数字，提升可读性
 */
'use strict';

const { formatCompact, formatCurrency, formatDuration, formatDistance } = require('./numberFormat');

/**
 * 格式化日志消息中的数字
 */
function formatLogMessage(message, locale = 'en-US') {
  if (typeof message !== 'string') return message;
  
  // 匹配并格式化大数字（> 10000）
  message = message.replace(/\b(\d{5,})\b/g, (match) => {
    const num = parseInt(match);
    return formatCompact(num, locale);
  });
  
  // 匹配货币模式（如 "5000 gold", "10000 gems"）
  message = message.replace(/(\d+)\s+(gold|gems?|diamonds?)/gi, (match, num, currency) => {
    const value = parseInt(num);
    const currencyType = currency.toLowerCase().replace(/s$/, ''); // 去除复数 s
    return formatCurrency(value, currencyType, locale);
  });
  
  // 匹配持续时间（如 "3600 seconds", "1800s"）
  message = message.replace(/(\d+)\s*(seconds?|s)\b/gi, (match, num) => {
    const seconds = parseInt(num);
    return formatDuration(seconds, locale);
  });
  
  // 匹配距离（如 "1500 meters", "2000m"）
  message = message.replace(/(\d+)\s*(meters?|m)\b/gi, (match, num) => {
    const meters = parseInt(num);
    return formatDistance(meters, locale);
  });
  
  return message;
}

/**
 * 创建增强日志器
 */
function createFormattedLogger(logger, locale = 'en-US') {
  return {
    info: (message, ...args) => {
      const formattedMsg = formatLogMessage(message, locale);
      logger.info(formattedMsg, ...args);
    },
    
    warn: (message, ...args) => {
      const formattedMsg = formatLogMessage(message, locale);
      logger.warn(formattedMsg, ...args);
    },
    
    error: (message, ...args) => {
      const formattedMsg = formatLogMessage(message, locale);
      logger.error(formattedMsg, ...args);
    },
    
    debug: (message, ...args) => {
      const formattedMsg = formatLogMessage(message, locale);
      logger.debug(formattedMsg, ...args);
    }
  };
}

module.exports = { formatLogMessage, createFormattedLogger };
```

### 4.5 推送通知集成示例

在 `backend/shared/pushNotificationService.js` 中使用：

```javascript
const { formatCurrency, formatGameValue, formatDuration } = require('./numberFormat');

// 示例：格式化推送通知内容
async function sendRewardNotification(userId, reward, locale = 'zh-CN') {
  const formattedGold = formatCurrency(reward.gold, 'gold', locale);
  const formattedExp = formatGameValue(reward.exp, 'exp', locale);
  
  const message = locale === 'zh-CN' 
    ? `恭喜！您获得了 ${formattedGold} 和 ${formattedExp}`
    : `Congratulations! You earned ${formattedGold} and ${formattedExp}`;
  
  await sendPushNotification(userId, {
    title: locale === 'zh-CN' ? '奖励已发放' : 'Reward Received',
    body: message,
    data: { reward }
  });
}
```

## 5. 验收标准（可测试）

- [ ] 服务端格式化模块实现 15+ 种格式化方法，与前端功能一致
- [ ] 统一配置模块前后端共享，格式化规则一致
- [ ] API 响应格式化中间件支持 `x-format-numbers` 头，自动添加格式化字段
- [ ] 日志格式化工具能自动识别并格式化数字、货币、时间、距离
- [ ] 推送通知集成后数字格式化准确（抽样 50 条通知，准确率 100%）
- [ ] 单元测试覆盖率 > 90%，包含所有语言和数字类型的测试用例
- [ ] 性能测试：批量格式化 1000 个数字耗时 < 50ms
- [ ] 文档：提供使用指南和 API 说明

## 6. 工作量估算

M - 需要实现核心模块、统一配置、中间件、日志工具和测试，预计需要 2-3 天。

## 7. 优先级理由

作为国际化/本地化类需求，这是提升全球用户体验的关键组成部分。服务端数字格式化能力的缺失导致：
1. 前后端逻辑重复，维护成本高
2. 推送通知、邮件、日志等场景的用户体验不佳
3. 格式化一致性难以保证

随着项目全球化运营，统一的服务端数字格式化系统是"国际化标准"的重要组成部分，因此定为 P1。
