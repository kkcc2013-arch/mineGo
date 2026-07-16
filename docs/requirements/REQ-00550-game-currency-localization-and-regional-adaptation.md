# REQ-00550：游戏内货币本地化显示与智能区域适配系统

- **编号**：REQ-00550
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/currencyLocalizer、payment-service、user-service、gateway、game-client、admin-dashboard
- **创建时间**：2026-07-16 11:00
- **依赖需求**：REQ-00500（服务端数字格式化本地化，已完成）、REQ-00524（日期时间格式本地化，已完成）

## 1. 背景与问题

mineGo 游戏内存在多种虚拟货币（金币、精币、星辰沙等），当前显示逻辑存在以下问题：

### 1.1 当前问题

1. **货币符号硬编码**：游戏客户端硬编码了货币符号，无法根据地区调整
```javascript
// 当前代码 - 硬编码
function displayCoins(amount) {
  return `${amount} 金币`; // 对日本用户也显示"金币"
}
```

2. **数量级显示不一致**：大额货币在不同地区的简写方式不同
   - 中国：1万、10万、1亿
   - 英语：10K、100K、1M
   - 日本：1万、1億（不是 1M）

3. **货币购买页本地化不足**：充值页面价格显示缺少区域税费信息
   - 日本：需显示含税价格（税込）
   - 欧洲：需显示 VAT 税率
   - 美国：部分州需显示销售税

4. **区域定价策略未实现**：不同地区的定价策略差异
   - 新兴市场可能需要更低的本地定价
   - 发达市场支持溢价定价

### 1.2 代码现状

当前有基础的货币格式化（currencyFormatter.js），但仅支持真实货币：
- 支持美元、欧元、日元等真实货币格式化
- 不支持游戏虚拟货币本地化
- 缺少大额数字智能简写

## 2. 目标

1. **虚拟货币本地化**：所有游戏货币支持多语言本地化显示
2. **智能数量级简写**：根据地区习惯显示大额数字（万/亿 vs K/M/B）
3. **区域税费透明化**：购买页显示含税价格和税费明细
4. **区域定价策略**：支持按地区差异化定价
5. **货币包推荐本地化**：根据用户地区推荐合适的货币包

## 3. 范围

### 包含
- 游戏货币本地化服务：`GameCurrencyLocalizer`
- 数量级智能简写引擎：`MagnitudeAbbreviator`
- 区域税费计算器：`RegionalTaxCalculator`
- 区域定价策略服务：`RegionalPricingService`
- 货币包推荐引擎：`CurrencyPackageRecommender`
- 前端组件集成

### 不包含
- 实际支付处理（已有 payment-service）
- 汇率转换（已有 exchangeRateService）
- 运营活动定价（单独需求）

## 4. 详细需求

### 4.1 游戏货币本地化服务

```javascript
// backend/shared/currencyLocalizer/GameCurrencyLocalizer.js

'use strict';

/**
 * 游戏货币类型定义
 */
const GAME_CURRENCIES = {
  COINS: {
    id: 'coins',
    // 各语言的货币名称
    names: {
      'zh-CN': '金币',
      'en-US': 'Coins',
      'ja-JP': 'コイン',
      'ko-KR': '코인',
      'es-ES': 'Monedas',
      'fr-FR': 'Pièces',
      'de-DE': 'Münzen'
    },
    // 图标位置：prefix 或 suffix
    symbolPosition: 'suffix',
    // 是否使用空格分隔
    spaceSeparator: true,
    // 最小显示精度（小数位数）
    precision: 0
  },
  POKECOINS: {
    id: 'pokecoins',
    names: {
      'zh-CN': '精币',
      'en-US': 'PokéCoins',
      'ja-JP': 'ポケコイン',
      'ko-KR': '포켓코인'
    },
    symbolPosition: 'prefix',
    spaceSeparator: false,
    precision: 0,
    // 精币图标（Unicode）
    symbol: '₽'
  },
  STARDUST: {
    id: 'stardust',
    names: {
      'zh-CN': '星尘',
      'en-US': 'Stardust',
      'ja-JP': 'ほしのすな',
      'ko-KR': '별의모래'
    },
    symbolPosition: 'suffix',
    spaceSeparator: true,
    precision: 0
  },
  CANDY: {
    id: 'candy',
    names: {
      'zh-CN': '糖果',
      'en-US': 'Candy',
      'ja-JP': 'アメ',
      'ko-KR': '사탕'
    },
    symbolPosition: 'suffix',
    spaceSeparator: true,
    precision: 0
  }
};

/**
 * 游戏货币本地化器
 */
class GameCurrencyLocalizer {
  constructor(locale = 'zh-CN') {
    this.locale = locale;
    this.abbreviator = require('./MagnitudeAbbreviator')(locale);
  }

  /**
   * 格式化货币显示
   * @param {number} amount 金额
   * @param {string} currencyType 货币类型
   * @param {Object} options 选项
   */
  format(amount, currencyType, options = {}) {
    const currency = GAME_CURRENCIES[currencyType];
    if (!currency) {
      return String(amount);
    }

    const {
      useAbbreviation = true,      // 是否使用简写
      showFullNumber = false,      // 强制显示完整数字
      showSymbol = true,           // 是否显示货币名称
      minAbbreviationThreshold = 10000  // 超过此值开始简写
    } = options;

    // 获取本地化名称
    const localName = currency.names[this.locale] || currency.names['en-US'];

    // 数字格式化
    let displayAmount;
    if (showFullNumber || !useAbbreviation || amount < minAbbreviationThreshold) {
      displayAmount = this.formatNumber(amount, currency.precision);
    } else {
      displayAmount = this.abbreviator.abbreviate(amount);
    }

    // 组合显示
    if (!showSymbol) {
      return displayAmount;
    }

    if (currency.symbolPosition === 'prefix') {
      const space = currency.spaceSeparator ? ' ' : '';
      const symbol = currency.symbol || localName;
      return `${symbol}${space}${displayAmount}`;
    } else {
      const space = currency.spaceSeparator ? ' ' : '';
      return `${displayAmount}${space}${localName}`;
    }
  }

  /**
   * 格式化数字
   */
  formatNumber(num, precision = 0) {
    return new Intl.NumberFormat(this.locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision
    }).format(num);
  }

  /**
   * 获取货币本地化名称
   */
  getCurrencyName(currencyType) {
    const currency = GAME_CURRENCIES[currencyType];
    return currency?.names[this.locale] || currencyType;
  }

  /**
   * 获取所有货币的本地化信息
   */
  getAllCurrenciesInfo() {
    return Object.entries(GAME_CURRENCIES).map(([key, currency]) => ({
      id: key,
      name: currency.names[this.locale] || currency.names['en-US'],
      symbol: currency.symbol,
      symbolPosition: currency.symbolPosition
    }));
  }

  /**
   * 解析用户输入的货币金额
   */
  parseInput(input, currencyType) {
    const currency = GAME_CURRENCIES[currencyType];
    if (!currency) return null;

    // 移除货币名称和空格
    let cleanInput = input;
    Object.values(currency.names).forEach(name => {
      cleanInput = cleanInput.replace(new RegExp(name, 'g'), '');
    });
    cleanInput = cleanInput.replace(/[¥₽$€£\s,]/g, '');

    // 处理简写
    return this.abbreviator.parseAbbreviated(cleanInput);
  }
}

module.exports = { GameCurrencyLocalizer, GAME_CURRENCIES };
```

### 4.2 数量级智能简写引擎

```javascript
// backend/shared/currencyLocalizer/MagnitudeAbbreviator.js

'use strict';

/**
 * 数量级简写规则 - 按地区分组
 */
const ABBREVIATION_RULES = {
  // 中文区域：万、亿
  'zh-CN': {
    groups: [
      { threshold: 100000000, suffix: '亿', divisor: 100000000 },
      { threshold: 10000, suffix: '万', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  'zh-TW': {
    groups: [
      { threshold: 100000000, suffix: '億', divisor: 100000000 },
      { threshold: 10000, suffix: '萬', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  // 日语区域：万、億（与中文相同逻辑）
  'ja-JP': {
    groups: [
      { threshold: 100000000, suffix: '億', divisor: 100000000 },
      { threshold: 10000, suffix: '万', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  // 韩语区域：万、億
  'ko-KR': {
    groups: [
      { threshold: 100000000, suffix: '억', divisor: 100000000 },
      { threshold: 10000, suffix: '만', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  // 英语区域：K、M、B、T
  'en-US': {
    groups: [
      { threshold: 1000000000000, suffix: 'T', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'B', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  'en-GB': {
    groups: [
      { threshold: 1000000000000, suffix: 'T', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'B', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  // 欧洲区域：通常使用 K、M、Mrd（德语）
  'de-DE': {
    groups: [
      { threshold: 1000000000000, suffix: 'Bio.', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'Mrd.', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'Mio.', divisor: 1000000 },
      { threshold: 1000, suffix: 'Tsd.', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  'fr-FR': {
    groups: [
      { threshold: 1000000000000, suffix: 'tn', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'Md', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'k', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  // 西班牙语区域
  'es-ES': {
    groups: [
      { threshold: 1000000000000, suffix: 'B', divisor: 1000000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  }
};

/**
 * 创建数量级简写器
 */
function createMagnitudeAbbreviator(locale) {
  const rules = ABBREVIATION_RULES[locale] || ABBREVIATION_RULES['en-US'];
  
  return {
    /**
     * 简写数字
     */
    abbreviate(num, precision = rules.defaultPrecision) {
      if (num < 1000) {
        return new Intl.NumberFormat(locale).format(num);
      }

      for (const group of rules.groups) {
        if (num >= group.threshold) {
          const abbreviated = num / group.divisor;
          const formatted = precision > 0 
            ? abbreviated.toFixed(precision).replace(/\.0$/, '')
            : Math.floor(abbreviated);
          return `${formatted}${group.suffix}`;
        }
      }

      return new Intl.NumberFormat(locale).format(num);
    },

    /**
     * 解析简写数字
     */
    parseAbbreviated(str) {
      const cleanStr = str.trim();
      
      // 尝试匹配简写
      for (const group of rules.groups) {
        const suffix = group.suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = cleanStr.match(new RegExp(`^([\\d,.]+)\\s*${suffix}$`, 'i'));
        if (match) {
          const base = parseFloat(match[1].replace(/,/g, ''));
          return base * group.divisor;
        }
      }

      // 尝试解析普通数字
      const numMatch = cleanStr.match(/^[\d,.]+$/);
      if (numMatch) {
        return parseFloat(numMatch[0].replace(/,/g, ''));
      }

      return null;
    },

    /**
     * 获取简写示例
     */
    getExamples() {
      return {
        thousand: this.abbreviate(1234),
        million: this.abbreviate(1234567),
        billion: this.abbreviate(1234567890),
        trillion: this.abbreviate(1234567890123)
      };
    }
  };
}

module.exports = createMagnitudeAbbreviator;
```

### 4.3 区域税费计算器

```javascript
// backend/shared/currencyLocalizer/RegionalTaxCalculator.js

'use strict';

/**
 * 区域税率配置
 * 基于真实税率，游戏充值通常归类为数字商品
 */
const REGIONAL_TAX_CONFIG = {
  // 日本：消费税 10%（2019年10月起）
  'JP': {
    taxType: 'JCT',  // Japanese Consumption Tax
    taxRate: 0.10,
    displayMode: 'tax_inclusive',  // 税込表示（价格含税）
    label: {
      'ja-JP': '（税込）',
      'en-US': '(tax incl.)'
    },
    reducedRate: 0.08,  // 轻减税率（食品饮料）
    digitalRate: 0.10   // 数字商品税率
  },
  
  // 韩国：增值税 10%
  'KR': {
    taxType: 'VAT',
    taxRate: 0.10,
    displayMode: 'tax_exclusive',
    label: {
      'ko-KR': 'VAT 포함',
      'en-US': 'VAT incl.'
    }
  },
  
  // 欧盟国家：VAT（各国不同）
  'DE': {  // 德国
    taxType: 'VAT',
    taxRate: 0.19,
    displayMode: 'tax_inclusive',
    label: { 'de-DE': 'inkl. MwSt.', 'en-US': 'VAT incl.' }
  },
  'FR': {  // 法国
    taxType: 'VAT',
    taxRate: 0.20,
    displayMode: 'tax_inclusive',
    label: { 'fr-FR': 'TTC', 'en-US': 'VAT incl.' }
  },
  'GB': {  // 英国
    taxType: 'VAT',
    taxRate: 0.20,
    displayMode: 'tax_inclusive',
    label: { 'en-GB': 'incl. VAT', 'en-US': 'VAT incl.' }
  },
  'ES': {  // 西班牙
    taxType: 'VAT',
    taxRate: 0.21,
    displayMode: 'tax_inclusive',
    label: { 'es-ES': 'IVA incl.', 'en-US': 'VAT incl.' }
  },
  
  // 美国：无联邦销售税，州税不同（数字商品免税州较多）
  'US': {
    taxType: 'SALES_TAX',
    taxRate: 0,  // 默认为 0，按州计算
    displayMode: 'tax_exclusive',
    stateRates: {
      'CA': 0.0825,  // 加州
      'NY': 0.08,    // 纽约
      'TX': 0.0625,  // 德州
      'FL': 0.06,    // 佛罗里达
      'WA': 0.065    // 华盛顿
    },
    label: { 'en-US': 'plus tax' }
  },
  
  // 中国：数字商品增值税 6%
  'CN': {
    taxType: 'VAT',
    taxRate: 0.06,
    displayMode: 'tax_inclusive',
    label: { 'zh-CN': '（含税）' }
  },
  
  // 新加坡：GST 8%（2023年起）
  'SG': {
    taxType: 'GST',
    taxRate: 0.08,
    displayMode: 'tax_inclusive',
    label: { 'en-US': 'GST incl.' }
  },
  
  // 澳大利亚：GST 10%
  'AU': {
    taxType: 'GST',
    taxRate: 0.10,
    displayMode: 'tax_inclusive',
    label: { 'en-AU': 'incl. GST' }
  }
};

/**
 * 区域税费计算器
 */
class RegionalTaxCalculator {
  constructor(country, locale = 'en-US', state = null) {
    this.country = country;
    this.locale = locale;
    this.state = state;
    this.config = REGIONAL_TAX_CONFIG[country] || {
      taxType: 'NONE',
      taxRate: 0,
      displayMode: 'tax_exclusive'
    };
  }

  /**
   * 计算含税价格
   */
  calculateTaxInclusivePrice(basePrice) {
    const taxRate = this.getEffectiveTaxRate();
    const taxAmount = basePrice * taxRate;
    const totalPrice = basePrice + taxAmount;

    return {
      basePrice,
      taxRate,
      taxAmount: Math.round(taxAmount * 100) / 100,
      totalPrice: Math.round(totalPrice * 100) / 100,
      displayMode: this.config.displayMode,
      label: this.getTaxLabel()
    };
  }

  /**
   * 获取有效税率
   */
  getEffectiveTaxRate() {
    if (this.country === 'US' && this.state) {
      return this.config.stateRates?.[this.state] || 0;
    }
    return this.config.taxRate || 0;
  }

  /**
   * 获取税费标签
   */
  getTaxLabel() {
    const labels = this.config.label || {};
    return labels[this.locale] || labels['en-US'] || '';
  }

  /**
   * 格式化价格显示
   */
  formatPriceDisplay(basePrice, formatter) {
    const taxInfo = this.calculateTaxInclusivePrice(basePrice);
    
    return {
      displayPrice: formatter(taxInfo.totalPrice),
      basePrice: formatter(taxInfo.basePrice),
      taxAmount: formatter(taxInfo.taxAmount),
      taxLabel: taxInfo.label,
      taxRate: taxInfo.taxRate,
      // 额外显示信息
      breakdown: this.getPriceBreakdown(taxInfo)
    };
  }

  /**
   * 获取价格明细
   */
  getPriceBreakdown(taxInfo) {
    if (taxInfo.taxRate === 0) {
      return null;
    }

    const taxType = this.config.taxType;
    
    return {
      taxType,
      taxRate: `${(taxInfo.taxRate * 100).toFixed(1)}%`,
      lines: [
        { label: 'Base Price', amount: taxInfo.basePrice },
        { label: `${taxType} (${(taxInfo.taxRate * 100).toFixed(1)}%)`, amount: taxInfo.taxAmount },
        { label: 'Total', amount: taxInfo.totalPrice, isTotal: true }
      ]
    };
  }

  /**
   * 检查是否需要显示价格明细
   */
  shouldShowBreakdown() {
    // 日本、欧洲必须显示含税价格
    return ['JP', 'DE', 'FR', 'GB', 'ES', 'IT'].includes(this.country);
  }
}

module.exports = { RegionalTaxCalculator, REGIONAL_TAX_CONFIG };
```

### 4.4 区域定价策略服务

```javascript
// backend/shared/currencyLocalizer/RegionalPricingService.js

'use strict';

const { query } = require('../db');
const logger = require('../logger');

/**
 * 区域定价策略
 */
const PRICING_STRATEGIES = {
  // 等价策略：所有地区相同价格（考虑汇率）
  'EQUIVALENT': {
    id: 'equivalent',
    description: 'All regions same price after exchange rate'
  },
  
  // 平价策略：考虑购买力平价（PPP）
  'PPP': {
    id: 'ppp',
    description: 'Purchasing Power Parity adjusted pricing'
  },
  
  // 市场策略：基于市场调研定价
  'MARKET': {
    id: 'market',
    description: 'Market research based pricing'
  }
};

/**
 * PPP 调整系数（相对于美国）
 * 数据来源：World Bank PPP conversion factors
 */
const PPP_ADJUSTMENT_FACTORS = {
  'US': 1.00,
  'JP': 0.85,   // 日元相对强势
  'GB': 0.92,
  'DE': 0.88,
  'FR': 0.87,
  'CN': 0.42,   // 中国购买力较低
  'KR': 0.68,
  'BR': 0.35,   // 巴西
  'IN': 0.21,   // 印度
  'RU': 0.28,
  'AU': 0.92,
  'SG': 0.95,
  'TW': 0.58,
  'HK': 0.75
};

/**
 * 区域定价服务
 */
class RegionalPricingService {
  constructor() {
    this.cache = new Map();
  }

  /**
   * 获取产品区域定价
   */
  async getProductPrice(productId, countryCode, currencyCode) {
    const cacheKey = `${productId}:${countryCode}:${currencyCode}`;
    
    // 检查缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // 1. 检查是否有本地化定价
    const localPrice = await this.getLocalPrice(productId, countryCode, currencyCode);
    if (localPrice) {
      this.cache.set(cacheKey, localPrice);
      return localPrice;
    }

    // 2. 检查是否有 PPP 调整定价
    const pppPrice = await this.getPPPAdjustedPrice(productId, countryCode, currencyCode);
    if (pppPrice) {
      this.cache.set(cacheKey, pppPrice);
      return pppPrice;
    }

    // 3. 使用汇率转换定价
    const convertedPrice = await this.getConvertedPrice(productId, currencyCode);
    this.cache.set(cacheKey, convertedPrice);
    return convertedPrice;
  }

  /**
   * 获取本地化定价
   */
  async getLocalPrice(productId, countryCode, currencyCode) {
    const result = await query(`
      SELECT price, original_price, strategy, created_at
      FROM regional_pricing
      WHERE product_id = $1 
        AND country_code = $2
        AND currency_code = $3
        AND is_active = true
    `, [productId, countryCode, currencyCode]);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        price: parseFloat(row.price),
        originalPrice: row.original_price ? parseFloat(row.original_price) : null,
        strategy: row.strategy || 'local',
        source: 'localized'
      };
    }

    return null;
  }

  /**
   * 获取 PPP 调整定价
   */
  async getPPPAdjustedPrice(productId, countryCode, currencyCode) {
    // 获取基础价格（美元）
    const basePrice = await this.getBasePrice(productId);
    if (!basePrice) return null;

    // 获取 PPP 系数
    const pppFactor = PPP_ADJUSTMENT_FACTORS[countryCode] || 1.0;
    
    // 计算调整后价格
    const adjustedUSDPrice = basePrice * pppFactor;

    // 获取汇率并转换
    const exchangeRate = await this.getExchangeRate('USD', currencyCode);
    const localPrice = adjustedUSDPrice * exchangeRate;

    // 四舍五入到心理价位
    const psychologicalPrice = this.roundToPsychologicalPrice(localPrice, currencyCode);

    return {
      price: psychologicalPrice,
      originalPrice: basePrice * exchangeRate,  // 未调整的原价
      pppAdjustment: pppFactor,
      strategy: 'PPP',
      source: 'ppp_adjusted'
    };
  }

  /**
   * 获取汇率转换定价
   */
  async getConvertedPrice(productId, currencyCode) {
    const basePrice = await this.getBasePrice(productId);
    if (!basePrice) return null;

    if (currencyCode === 'USD') {
      return {
        price: basePrice,
        strategy: 'base',
        source: 'base'
      };
    }

    const exchangeRate = await this.getExchangeRate('USD', currencyCode);
    const localPrice = basePrice * exchangeRate;

    return {
      price: this.roundToPsychologicalPrice(localPrice, currencyCode),
      basePrice,
      exchangeRate,
      strategy: 'converted',
      source: 'exchange_rate'
    };
  }

  /**
   * 获取基础价格（美元）
   */
  async getBasePrice(productId) {
    const result = await query(`
      SELECT base_price_usd
      FROM products
      WHERE id = $1
    `, [productId]);

    if (result.rows.length === 0) return null;
    return parseFloat(result.rows[0].base_price_usd);
  }

  /**
   * 获取汇率
   */
  async getExchangeRate(from, to) {
    const exchangeRateService = require('../exchangeRateService');
    const rates = await exchangeRateService.getRates(from, [to]);
    return rates[to] || 1;
  }

  /**
   * 四舍五入到心理价位
   */
  roundToPsychologicalPrice(price, currencyCode) {
    // 不同货币有不同的心理价位
    const psychologicalLevels = {
      'USD': [0.99, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
      'EUR': [0.99, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
      'JPY': [120, 500, 1000, 1500, 2000, 3000, 5000, 10000],  // 日元不使用 .99
      'CNY': [6, 30, 68, 98, 128, 198, 328, 648],  // 中国手游常见定价
      'KRW': [1100, 5500, 11000, 33000, 55000, 110000]  // 韩元
    };

    const levels = psychologicalLevels[currencyCode] || psychologicalLevels['USD'];
    
    // 找到最接近的心理价位
    for (let i = levels.length - 1; i >= 0; i--) {
      if (price >= levels[i]) {
        return levels[i];
      }
    }

    return levels[0];
  }

  /**
   * 获取货币包推荐
   */
  async getRecommendedPackages(userId, countryCode, currencyCode) {
    // 分析用户历史购买
    const purchaseHistory = await this.analyzePurchaseHistory(userId);
    
    // 获取区域热门包
    const popularPackages = await this.getPopularPackages(countryCode);
    
    // 组合推荐
    return {
      personalized: purchaseHistory.recommendedPackage,
      popular: popularPackages.slice(0, 3),
      bestValue: popularPackages.find(p => p.isBestValue)
    };
  }

  /**
   * 分析购买历史
   */
  async analyzePurchaseHistory(userId) {
    const result = await query(`
      SELECT 
        p.product_id,
        COUNT(*) as purchase_count,
        AVG(p.amount) as avg_amount,
        MAX(p.created_at) as last_purchase
      FROM payments p
      WHERE p.user_id = $1 AND p.status = 'completed'
      GROUP BY p.product_id
      ORDER BY purchase_count DESC
      LIMIT 5
    `, [userId]);

    return {
      history: result.rows,
      recommendedPackage: result.rows[0]?.product_id || null
    };
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache.clear();
  }
}

module.exports = { RegionalPricingService, PPP_ADJUSTMENT_FACTORS };
```

### 4.5 Gateway API 集成

```javascript
// backend/gateway/src/routes/currencyLocalization.js

'use strict';

const express = require('express');
const router = express.Router();
const { GameCurrencyLocalizer, GAME_CURRENCIES } = require('../../../shared/currencyLocalizer/GameCurrencyLocalizer');
const { RegionalTaxCalculator } = require('../../../shared/currencyLocalizer/RegionalTaxCalculator');
const { RegionalPricingService } = require('../../../shared/currencyLocalizer/RegionalPricingService');
const createMagnitudeAbbreviator = require('../../../shared/currencyLocalizer/MagnitudeAbbreviator');
const { requireAuth, successResp, AppError } = require('../../../shared/auth');
const logger = require('../../../shared/logger');

const pricingService = new RegionalPricingService();

/**
 * GET /api/v1/currency/format
 * 格式化游戏货币显示
 */
router.get('/format', async (req, res, next) => {
  try {
    const { amount, currency = 'COINS', locale = 'zh-CN' } = req.query;
    
    if (!amount) {
      throw new AppError(400, 'Amount required');
    }

    const localizer = new GameCurrencyLocalizer(locale);
    const formatted = localizer.format(parseInt(amount), currency, {
      useAbbreviation: true
    });

    res.json(successResp({
      amount: parseInt(amount),
      currency,
      locale,
      formatted,
      fullDisplay: localizer.format(parseInt(amount), currency, {
        useAbbreviation: false
      })
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/abbreviate
 * 数量级简写测试
 */
router.get('/abbreviate', async (req, res, next) => {
  try {
    const { number, locale = 'zh-CN' } = req.query;
    
    if (!number) {
      throw new AppError(400, 'Number required');
    }

    const abbreviator = createMagnitudeAbbreviator(locale);
    const abbreviated = abbreviator.abbreviate(parseInt(number));

    res.json(successResp({
      original: parseInt(number),
      abbreviated,
      locale,
      examples: abbreviator.getExamples()
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/pricing/:productId
 * 获取产品区域定价
 */
router.get('/pricing/:productId', async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { country = 'US', currency = 'USD', state } = req.query;
    
    const pricing = await pricingService.getProductPrice(productId, country, currency);
    const taxCalc = new RegionalTaxCalculator(country, req.headers['accept-language'], state);
    const display = taxCalc.formatPriceDisplay(pricing.price, (p) => 
      new Intl.NumberFormat(req.headers['accept-language'] || 'en-US', {
        style: 'currency',
        currency: currency
      }).format(p)
    );

    res.json(successResp({
      productId,
      ...pricing,
      display,
      showBreakdown: taxCalc.shouldShowBreakdown()
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/info
 * 获取所有游戏货币信息
 */
router.get('/info', async (req, res, next) => {
  try {
    const { locale = 'zh-CN' } = req.query;
    const localizer = new GameCurrencyLocalizer(locale);
    const currencies = localizer.getAllCurrenciesInfo();

    res.json(successResp({
      locale,
      currencies
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/packages/recommend
 * 获取货币包推荐
 */
router.get('/packages/recommend', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { country, currency } = req.query;
    
    const recommendations = await pricingService.getRecommendedPackages(
      userId,
      country || req.user.country || 'US',
      currency || 'USD'
    );

    res.json(successResp(recommendations));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

### 4.6 前端组件示例

```javascript
// frontend/game-client/src/components/CurrencyDisplay.js

import { i18n } from '../i18n/index.js';

/**
 * 游戏货币显示组件
 */
export class CurrencyDisplay {
  constructor(options = {}) {
    this.locale = options.locale || i18n.currentLocale;
    this.currency = options.currency || 'COINS';
  }

  /**
   * 格式化货币显示
   */
  format(amount, options = {}) {
    const localizer = new GameCurrencyLocalizer(this.locale);
    return localizer.format(amount, this.currency, options);
  }

  /**
   * 创建货币显示元素
   */
  render(amount, options = {}) {
    const container = document.createElement('span');
    container.className = 'currency-display';
    
    const formatted = this.format(amount, options);
    container.textContent = formatted;
    
    // 添加悬停提示（完整数字）
    if (amount >= 10000) {
      container.title = this.format(amount, { showFullNumber: true });
    }
    
    return container;
  }
}

/**
 * 价格显示组件（含税费）
 */
export class PriceDisplay {
  constructor(options = {}) {
    this.country = options.country;
    this.locale = options.locale;
  }

  async render(productId) {
    const container = document.createElement('div');
    container.className = 'price-display';
    
    // 获取区域定价
    const response = await fetch(
      `/api/v1/currency/pricing/${productId}?country=${this.country}&locale=${this.locale}`
    );
    const data = await response.json();
    
    if (data.display) {
      // 主价格
      const priceEl = document.createElement('div');
      priceEl.className = 'price-main';
      priceEl.textContent = data.display.displayPrice;
      container.appendChild(priceEl);
      
      // 税费标签
      if (data.display.taxLabel) {
        const labelEl = document.createElement('span');
        labelEl.className = 'tax-label';
        labelEl.textContent = data.display.taxLabel;
        container.appendChild(labelEl);
      }
      
      // 价格明细（日本、欧洲必须显示）
      if (data.showBreakdown && data.display.breakdown) {
        const breakdownEl = document.createElement('div');
        breakdownEl.className = 'price-breakdown';
        data.display.breakdown.lines.forEach(line => {
          const lineEl = document.createElement('div');
          lineEl.className = line.isTotal ? 'breakdown-total' : 'breakdown-line';
          lineEl.textContent = `${line.label}: ${line.amount}`;
          breakdownEl.appendChild(lineEl);
        });
        container.appendChild(breakdownEl);
      }
    }
    
    return container;
  }
}
```

### 4.7 数据库 Schema

```sql
-- 区域定价表
CREATE TABLE regional_pricing (
  id SERIAL PRIMARY KEY,
  product_id VARCHAR(50) NOT NULL,
  country_code CHAR(2) NOT NULL,
  currency_code CHAR(3) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  original_price DECIMAL(10, 2),
  strategy VARCHAR(20) DEFAULT 'local',  -- local, PPP, converted
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(product_id, country_code, currency_code)
);

-- 用户货币偏好表
CREATE TABLE user_currency_preferences (
  user_id VARCHAR(50) PRIMARY KEY,
  preferred_currency CHAR(3),
  display_format VARCHAR(20) DEFAULT 'abbreviated',  -- full, abbreviated
  region VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_regional_pricing_product ON regional_pricing(product_id);
CREATE INDEX idx_regional_pricing_country ON regional_pricing(country_code);
```

## 5. 验收标准（可测试）

- [ ] GameCurrencyLocalizer 支持 4 种游戏货币的中/英/日语本地化显示
- [ ] 中文区域正确显示"万""亿"简写（如 1.2万金币）
- [ ] 英语区域正确显示 K/M/B 简写（如 1.2M Coins）
- [ ] 日语区域正确显示"万""億"简写（如 1.2万コイン）
- [ ] RegionalTaxCalculator 正确计算日本消费税（10%含税显示）
- [ ] 欧洲区域显示 VAT 税率和含税价格
- [ ] 美国、加拿大区域正确计算州税/省税
- [ ] RegionalPricingService 支持 PPP 调整定价（中国、印度等新兴市场）
- [ ] 货币包推荐 API 返回用户个性化推荐
- [ ] Gateway 提供 5 个 RESTful API 端点
- [ ] 前端 CurrencyDisplay 组件正确渲染货币显示
- [ ] 前端 PriceDisplay 组件显示含税价格和税费明细
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L - 大工作量**
- GameCurrencyLocalizer 实现：2 小时
- MagnitudeAbbreviator 实现：2 小时
- RegionalTaxCalculator 实现：2 小时
- RegionalPricingService 实现：3 小时
- Gateway API 集成：2 小时
- 前端组件开发：3 小时
- 数据库 Schema 设计：1 小时
- 单元测试编写：3 小时
- 集成测试：2 小时

总计约 20 小时，需 2.5 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **用户体验提升**：本地化的货币显示让玩家更有亲切感，提升游戏沉浸度
2. **合规要求**：日本、欧洲等地区强制要求显示含税价格
3. **收入优化**：区域定价策略可以提高新兴市场转化率 20-40%
4. **竞品对标**：主流游戏（Pokemon GO、原神）均已实现货币本地化
5. **成熟度评分提升**：完成后"国际化/本地化"维度从当前水平进一步提升

此需求与已完成的数字格式化（REQ-00500）、日期时间格式化（REQ-00524）、复数形式本地化（REQ-00515）形成完整的本地化体系，是游戏全球化运营的基础设施。