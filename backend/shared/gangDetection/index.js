/**
 * 团伙检测模块入口
 * REQ-00550: 协同作弊团伙检测系统
 */

'use strict';

const GangDetectionEngine = require('./GangDetectionEngine');
const GangActionEngine = require('./GangActionEngine');

module.exports = {
  GangDetectionEngine,
  GangActionEngine
};