// backend/shared/RiskControlEngine.js - 向后兼容代理文件
// 此文件已被拆分为 risk-engine/ 目录下的多个模块
// 本文件仅作为向后兼容的导出代理

'use strict';

// 重定向到新的模块化实现
const {
  RiskControlEngine,
  ANTI_CHEAT_RULES,
  CONFIG,
  metrics
} = require('./risk-engine');

// 向后兼容导出
module.exports = {
  RiskControlEngine,
  ANTI_CHEAT_RULES,
  CONFIG,
  metrics
};