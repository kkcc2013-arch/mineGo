/**
 * Currency Localizer Index - 模块导出
 * REQ-00550: 游戏内货币本地化显示与智能区域适配系统
 */

'use strict';

const { GameCurrencyLocalizer, GAME_CURRENCIES } = require('./GameCurrencyLocalizer');
const createMagnitudeAbbreviator = require('./MagnitudeAbbreviator');
const { RegionalTaxCalculator, REGIONAL_TAX_CONFIG } = require('./RegionalTaxCalculator');
const { RegionalPricingService, PPP_ADJUSTMENT_FACTORS, PSYCHOLOGICAL_LEVELS } = require('./RegionalPricingService');

module.exports = {
  // 游戏货币本地化
  GameCurrencyLocalizer,
  GAME_CURRENCIES,
  
  // 数量级简写
  createMagnitudeAbbreviator,
  
  // 区域税费计算
  RegionalTaxCalculator,
  REGIONAL_TAX_CONFIG,
  
  // 区域定价
  RegionalPricingService,
  PPP_ADJUSTMENT_FACTORS,
  PSYCHOLOGICAL_LEVELS
};