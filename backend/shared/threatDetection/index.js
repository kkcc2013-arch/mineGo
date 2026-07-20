'use strict';

/**
 * 威胁检测模块入口
 */

const ThreatDetectionEngine = require('./ThreatDetectionEngine');
const ThreatResponseExecutor = require('./ThreatResponseExecutor');
const ThreatDetectionMiddleware = require('./ThreatDetectionMiddleware');
const FeatureExtractor = require('./FeatureExtractor');

module.exports = {
  ThreatDetectionEngine,
  ThreatResponseExecutor,
  ThreatDetectionMiddleware,
  FeatureExtractor
};