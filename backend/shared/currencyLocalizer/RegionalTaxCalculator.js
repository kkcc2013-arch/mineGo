/**
 * Regional Tax Calculator - 区域税费计算器
 * REQ-00550: 游戏内货币本地化显示与智能区域适配系统
 * 
 * 功能：
 * - 计算区域税费（VAT、GST、销售税等）
 * - 生成含税价格显示
 * - 提供税费明细
 * 
 * @module backend/shared/currencyLocalizer/RegionalTaxCalculator
 * @version 1.0.0
 */

'use strict';

/**
 * 区域税率配置
 * 基于真实税率，游戏充值通常归类为数字商品
 */
const REGIONAL_TAX_CONFIG = {
  // 日本：消费税 10%（2019年10月起）
  'JP': {
    taxType: 'JCT',
    taxRate: 0.10,
    displayMode: 'tax_inclusive',
    label: {
      'ja-JP': '（税込）',
      'en-US': '(tax incl.)',
      'zh-CN': '（含税）'
    },
    reducedRate: 0.08,
    digitalRate: 0.10
  },

  // 韩国：增值税 10%
  'KR': {
    taxType: 'VAT',
    taxRate: 0.10,
    displayMode: 'tax_exclusive',
    label: {
      'ko-KR': 'VAT 포함',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },

  // 欧盟国家：VAT（各国不同）
  'DE': {
    taxType: 'VAT',
    taxRate: 0.19,
    displayMode: 'tax_inclusive',
    label: {
      'de-DE': 'inkl. MwSt.',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },
  'FR': {
    taxType: 'VAT',
    taxRate: 0.20,
    displayMode: 'tax_inclusive',
    label: {
      'fr-FR': 'TTC',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },
  'GB': {
    taxType: 'VAT',
    taxRate: 0.20,
    displayMode: 'tax_inclusive',
    label: {
      'en-GB': 'incl. VAT',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },
  'ES': {
    taxType: 'VAT',
    taxRate: 0.21,
    displayMode: 'tax_inclusive',
    label: {
      'es-ES': 'IVA incl.',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },
  'IT': {
    taxType: 'VAT',
    taxRate: 0.22,
    displayMode: 'tax_inclusive',
    label: {
      'it-IT': 'IVA incl.',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },
  'NL': {
    taxType: 'VAT',
    taxRate: 0.21,
    displayMode: 'tax_inclusive',
    label: {
      'nl-NL': 'incl. BTW',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },

  // 美国：无联邦销售税，州税不同
  'US': {
    taxType: 'SALES_TAX',
    taxRate: 0,
    displayMode: 'tax_exclusive',
    stateRates: {
      'CA': 0.0825,
      'NY': 0.08,
      'TX': 0.0625,
      'FL': 0.06,
      'WA': 0.065,
      'IL': 0.0625,
      'PA': 0.06,
      'OH': 0.0575,
      'MI': 0.06,
      'GA': 0.04
    },
    label: {
      'en-US': 'plus tax',
      'zh-CN': '（不含税）'
    }
  },

  // 加拿大：GST + PST
  'CA': {
    taxType: 'GST',
    taxRate: 0.05,
    displayMode: 'tax_exclusive',
    provinceRates: {
      'ON': 0.13,   // HST
      'BC': 0.12,   // GST + PST
      'AB': 0.05,   // GST only
      'QC': 0.14975,// GST + QST
      'MB': 0.12,
      'SK': 0.11
    },
    label: {
      'en-CA': 'plus tax',
      'fr-CA': 'plus taxes',
      'zh-CN': '（不含税）'
    }
  },

  // 中国：数字商品增值税 6%
  'CN': {
    taxType: 'VAT',
    taxRate: 0.06,
    displayMode: 'tax_inclusive',
    label: {
      'zh-CN': '（含税）',
      'en-US': '(tax incl.)'
    }
  },

  // 新加坡：GST 8%（2023年起）
  'SG': {
    taxType: 'GST',
    taxRate: 0.08,
    displayMode: 'tax_inclusive',
    label: {
      'en-SG': 'incl. GST',
      'zh-CN': '（含消费税）'
    }
  },

  // 澳大利亚：GST 10%
  'AU': {
    taxType: 'GST',
    taxRate: 0.10,
    displayMode: 'tax_inclusive',
    label: {
      'en-AU': 'incl. GST',
      'zh-CN': '（含消费税）'
    }
  },

  // 台湾
  'TW': {
    taxType: 'VAT',
    taxRate: 0.05,
    displayMode: 'tax_inclusive',
    label: {
      'zh-TW': '（含稅）',
      'zh-CN': '（含税）'
    }
  },

  // 香港（无增值税）
  'HK': {
    taxType: 'NONE',
    taxRate: 0,
    displayMode: 'tax_exclusive',
    label: {}
  },

  // 巴西
  'BR': {
    taxType: 'ICMS',
    taxRate: 0.18,
    displayMode: 'tax_inclusive',
    label: {
      'pt-BR': 'ICMS incl.',
      'en-US': 'VAT incl.',
      'zh-CN': '（含税）'
    }
  },

  // 印度（GST 18% for digital goods）
  'IN': {
    taxType: 'GST',
    taxRate: 0.18,
    displayMode: 'tax_inclusive',
    label: {
      'en-IN': 'incl. GST',
      'zh-CN': '（含消费税）'
    }
  },

  // 俄罗斯
  'RU': {
    taxType: 'VAT',
    taxRate: 0.20,
    displayMode: 'tax_inclusive',
    label: {
      'ru-RU': 'НДС вкл.',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  },

  // 墨西哥
  'MX': {
    taxType: 'IVA',
    taxRate: 0.16,
    displayMode: 'tax_inclusive',
    label: {
      'es-MX': 'IVA incl.',
      'en-US': 'VAT incl.',
      'zh-CN': '（含增值税）'
    }
  }
};

/**
 * 区域税费计算器
 */
class RegionalTaxCalculator {
  /**
   * 构造函数
   * @param {string} country - 国家代码
   * @param {string} locale - 语言区域代码
   * @param {string|null} state - 州/省代码
   */
  constructor(country, locale = 'en-US', state = null) {
    this.country = country;
    this.locale = locale;
    this.state = state;
    this.config = REGIONAL_TAX_CONFIG[country] || {
      taxType: 'NONE',
      taxRate: 0,
      displayMode: 'tax_exclusive',
      label: {}
    };
  }

  /**
   * 计算含税价格
   * @param {number} basePrice - 基础价格
   * @returns {Object} - 价格信息
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
      label: this.getTaxLabel(),
      taxType: this.config.taxType
    };
  }

  /**
   * 获取有效税率
   * @returns {number} - 税率
   */
  getEffectiveTaxRate() {
    // 美国州税
    if (this.country === 'US' && this.state) {
      return this.config.stateRates?.[this.state] || 0;
    }
    // 加拿大省税
    if (this.country === 'CA' && this.state) {
      return this.config.provinceRates?.[this.state] || this.config.taxRate;
    }
    return this.config.taxRate || 0;
  }

  /**
   * 获取税费标签
   * @returns {string} - 标签
   */
  getTaxLabel() {
    const labels = this.config.label || {};
    return labels[this.locale] || labels['en-US'] || '';
  }

  /**
   * 格式化价格显示
   * @param {number} basePrice - 基础价格
   * @param {Function} formatter - 格式化函数
   * @returns {Object} - 显示信息
   */
  formatPriceDisplay(basePrice, formatter) {
    const taxInfo = this.calculateTaxInclusivePrice(basePrice);

    return {
      displayPrice: formatter(taxInfo.totalPrice),
      basePrice: formatter(taxInfo.basePrice),
      taxAmount: formatter(taxInfo.taxAmount),
      taxLabel: taxInfo.label,
      taxRate: taxInfo.taxRate,
      breakdown: this.getPriceBreakdown(taxInfo)
    };
  }

  /**
   * 获取价格明细
   * @param {Object} taxInfo - 税费信息
   * @returns {Object|null} - 明细
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
        {
          label: `${taxType} (${(taxInfo.taxRate * 100).toFixed(1)}%)`,
          amount: taxInfo.taxAmount
        },
        { label: 'Total', amount: taxInfo.totalPrice, isTotal: true }
      ]
    };
  }

  /**
   * 检查是否需要显示价格明细
   * @returns {boolean} - 是否需要
   */
  shouldShowBreakdown() {
    // 日本、欧洲必须显示含税价格
    return ['JP', 'DE', 'FR', 'GB', 'ES', 'IT', 'NL', 'BR', 'IN', 'RU', 'MX'].includes(this.country);
  }

  /**
   * 获取国家税率信息
   * @returns {Object} - 税率信息
   */
  getTaxInfo() {
    return {
      country: this.country,
      taxType: this.config.taxType,
      taxRate: this.getEffectiveTaxRate(),
      displayMode: this.config.displayMode,
      label: this.getTaxLabel(),
      requiresBreakdown: this.shouldShowBreakdown()
    };
  }

  /**
   * 计算反向税额（从含税价格计算）
   * @param {number} totalPrice - 含税价格
   * @returns {Object} - 价格信息
   */
  calculateTaxFromTotal(totalPrice) {
    const taxRate = this.getEffectiveTaxRate();
    const basePrice = totalPrice / (1 + taxRate);
    const taxAmount = totalPrice - basePrice;

    return {
      basePrice: Math.round(basePrice * 100) / 100,
      taxRate,
      taxAmount: Math.round(taxAmount * 100) / 100,
      totalPrice: Math.round(totalPrice * 100) / 100,
      displayMode: this.config.displayMode,
      label: this.getTaxLabel()
    };
  }
}

module.exports = { RegionalTaxCalculator, REGIONAL_TAX_CONFIG };