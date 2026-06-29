// backend/shared/indexOptimizer/index.js
'use strict';

const { SlowQueryCollector } = require('./SlowQueryCollector');
const { IndexRecommender, QueryPatternAnalyzer, ColumnImportanceAnalyzer } = require('./IndexRecommender');
const { IndexHealthChecker } = require('./IndexHealthChecker');
const { IndexOptimizationExecutor } = require('./IndexOptimizationExecutor');
const { IndexOptimizerManager } = require('./IndexOptimizerManager');

module.exports = {
  SlowQueryCollector,
  IndexRecommender,
  QueryPatternAnalyzer,
  ColumnImportanceAnalyzer,
  IndexHealthChecker,
  IndexOptimizationExecutor,
  IndexOptimizerManager
};