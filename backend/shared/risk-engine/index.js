// shared/risk-engine/index.js - Risk Engine Entry Point
'use strict';

const RiskScorer = require('./risk-scorer');
const {
  TRANSACTION_RULES,
  REWARD_RULES,
  PAYMENT_RULES,
  evaluateTransactionRules,
  evaluateRewardRules,
  evaluatePaymentRules
} = require('./rules/transaction-rules');
const BehaviorAnalyzer = require('./analyzers/behavior-analyzer');

module.exports = {
  RiskScorer,
  BehaviorAnalyzer,
  TRANSACTION_RULES,
  REWARD_RULES,
  PAYMENT_RULES,
  evaluateTransactionRules,
  evaluateRewardRules,
  evaluatePaymentRules
};