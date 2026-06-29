// backend/shared/numberFormatConfig.js
// Number formatting configuration for different locales
'use strict';

const FORMAT_CONFIGS = {
  'zh-CN': {
    // 千分号使用西方格式
    thousandSeparator: ',',
    decimalSeparator: '.',
    
    // 大数字缩写规则（中文使用万/亿）
    compact: {
      thresholds: [
        { value: 100000000, unit: '亿', divisor: 100000000, precision: 2 },
        { value: 10000, unit: '万', divisor: 10000, precision: 1 },
        { value: 0, unit: '', divisor: 1, precision: 0 }
      ]
    },
    
    // 货币格式化配置
    currencies: {
      gold: { symbol: '金币', position: 'suffix', spacing: false },
      gems: { symbol: '宝石', position: 'suffix', spacing: false },
      diamonds: { symbol: '钻石', position: 'suffix', spacing: false },
      coins: { symbol: '硬币', position: 'suffix', spacing: false },
      tickets: { symbol: '券', position: 'suffix', spacing: false }
    },
    
    // 游戏数值类型配置
    gameValues: {
      power: { label: '战力', compact: true, precision: 1, showLabel: true },
      exp: { label: '经验', compact: true, precision: 0, showLabel: true },
      damage: { label: '', compact: true, precision: 0, showLabel: false },
      hp: { label: '', compact: false, precision: 0, showLabel: false },
      level: { label: 'Lv.', compact: false, precision: 0, showLabel: true, prefix: true },
      stamina: { label: '', compact: false, precision: 0, showLabel: false },
      catchRate: { label: '', compact: false, precision: 1, suffix: '%', showLabel: false }
    },
    
    // 百分比格式化
    percent: {
      suffix: '%',
      precision: 1
    },
    
    // 货币符号映射（用于显示）
    currencySymbols: {
      CNY: '¥',
      USD: '$',
      JPY: '円'
    }
  },
  
  'en-US': {
    // 千分号使用逗号
    thousandSeparator: ',',
    decimalSeparator: '.',
    
    // 大数字缩写规则（英文使用 K/M/B）
    compact: {
      thresholds: [
        { value: 1000000000, unit: 'B', divisor: 1000000000, precision: 2 },
        { value: 1000000, unit: 'M', divisor: 1000000, precision: 1 },
        { value: 1000, unit: 'K', divisor: 1000, precision: 1 },
        { value: 0, unit: '', divisor: 1, precision: 0 }
      ]
    },
    
    // 货币格式化配置
    currencies: {
      gold: { symbol: 'Gold', position: 'suffix', spacing: true },
      gems: { symbol: 'Gems', position: 'suffix', spacing: true },
      diamonds: { symbol: 'Diamonds', position: 'suffix', spacing: true },
      coins: { symbol: 'Coins', position: 'suffix', spacing: true },
      tickets: { symbol: 'Tickets', position: 'suffix', spacing: true }
    },
    
    // 游戏数值类型配置
    gameValues: {
      power: { label: 'Power', compact: true, precision: 1, showLabel: true },
      exp: { label: 'EXP', compact: true, precision: 0, showLabel: true },
      damage: { label: '', compact: true, precision: 0, showLabel: false },
      hp: { label: 'HP', compact: false, precision: 0, showLabel: true },
      level: { label: 'Lv.', compact: false, precision: 0, showLabel: true, prefix: true },
      stamina: { label: '', compact: false, precision: 0, showLabel: false },
      catchRate: { label: '', compact: false, precision: 1, suffix: '%', showLabel: false }
    },
    
    // 百分比格式化
    percent: {
      suffix: '%',
      precision: 1
    },
    
    // 货币符号映射
    currencySymbols: {
      CNY: '¥',
      USD: '$',
      JPY: '¥'
    }
  },
  
  'ja-JP': {
    // 千分号使用逗号
    thousandSeparator: ',',
    decimalSeparator: '.',
    
    // 大数字缩写规则（日文使用万/億）
    compact: {
      thresholds: [
        { value: 100000000, unit: '億', divisor: 100000000, precision: 2 },
        { value: 10000, unit: '万', divisor: 10000, precision: 1 },
        { value: 0, unit: '', divisor: 1, precision: 0 }
      ]
    },
    
    // 货币格式化配置
    currencies: {
      gold: { symbol: 'ゴールド', position: 'suffix', spacing: false },
      gems: { symbol: 'ジェム', position: 'suffix', spacing: false },
      diamonds: { symbol: 'ダイヤ', position: 'suffix', spacing: false },
      coins: { symbol: 'コイン', position: 'suffix', spacing: false },
      tickets: { symbol: '券', position: 'suffix', spacing: false }
    },
    
    // 游戏数值类型配置
    gameValues: {
      power: { label: '戦力', compact: true, precision: 1, showLabel: true },
      exp: { label: '経験値', compact: true, precision: 0, showLabel: true },
      damage: { label: '', compact: true, precision: 0, showLabel: false },
      hp: { label: 'HP', compact: false, precision: 0, showLabel: true },
      level: { label: 'Lv.', compact: false, precision: 0, showLabel: true, prefix: true },
      stamina: { label: '', compact: false, precision: 0, showLabel: false },
      catchRate: { label: '', compact: false, precision: 1, suffix: '%', showLabel: false }
    },
    
    // 百分比格式化
    percent: {
      suffix: '%',
      precision: 1
    },
    
    // 货币符号映射
    currencySymbols: {
      CNY: '¥',
      USD: '$',
      JPY: '円'
    }
  }
};

// 默认配置（fallback）
const DEFAULT_CONFIG = FORMAT_CONFIGS['zh-CN'];

// 支持的语言列表
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];

// 默认语言
const DEFAULT_LANGUAGE = 'zh-CN';

module.exports = {
  FORMAT_CONFIGS,
  DEFAULT_CONFIG,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE
};