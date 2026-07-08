'use strict';

const TestCoverageCollector = require('./TestCoverageCollector');
const IncrementalCoverageAnalyzer = require('./IncrementalCoverageAnalyzer');
const CoverageThresholdChecker = require('./CoverageThresholdChecker');
const CoverageBadgeGenerator = require('./CoverageBadgeGenerator');

module.exports = {
  TestCoverageCollector,
  IncrementalCoverageAnalyzer,
  CoverageThresholdChecker,
  CoverageBadgeGenerator
};