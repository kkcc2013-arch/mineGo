// shared/risk-engine/rules/transaction-rules.js - Transaction Risk Rules
'use strict';

const TRANSACTION_RULES = {
  // High frequency trading
  HIGH_FREQUENCY: {
    name: '高频交易',
    id: 'TR001',
    condition: (ctx) => ctx.transactionCount > 50 && ctx.timeWindow < 3600,
    score: 30,
    severity: 'HIGH',
    description: '1小时内超过50笔交易'
  },

  // Large amount anomaly
  LARGE_AMOUNT_ANOMALY: {
    name: '大额交易异常',
    id: 'TR002',
    condition: (ctx) => ctx.amount > ctx.avgAmount * 10,
    score: 40,
    severity: 'HIGH',
    description: '交易金额远超历史平均值'
  },

  // Same device multi-account trading
  SAME_DEVICE_TRADE: {
    name: '同设备多账号交易',
    id: 'TR003',
    condition: (ctx) => ctx.sameDeviceTrades > 5,
    score: 50,
    severity: 'CRITICAL',
    description: '同一设备关联多个账号交易'
  },

  // Price manipulation
  PRICE_MANIPULATION: {
    name: '价格操纵嫌疑',
    id: 'TR004',
    condition: (ctx) => {
      if (!ctx.marketAvgPrice) return false;
      const priceDeviation = Math.abs(ctx.price - ctx.marketAvgPrice) / ctx.marketAvgPrice;
      return priceDeviation > 0.5;
    },
    score: 35,
    severity: 'HIGH',
    description: '交易价格偏离市场均价超过50%'
  },

  // Wash trading (related accounts)
  WASH_TRADING: {
    name: '对敲交易嫌疑',
    id: 'TR005',
    condition: (ctx) => ctx.relatedAccounts && ctx.relatedAccounts.includes(ctx.counterpartyId),
    score: 60,
    severity: 'CRITICAL',
    description: '买卖双方为关联账号'
  },

  // New account surge
  NEW_ACCOUNT_SURGE: {
    name: '新账号异常活跃',
    id: 'TR006',
    condition: (ctx) => ctx.accountAge < 7 * 24 * 3600 && ctx.totalTradeValue > 10000,
    score: 45,
    severity: 'HIGH',
    description: '7天内新账号交易额异常'
  },

  // Round number pattern (script behavior)
  ROUND_NUMBER_PATTERN: {
    name: '整数金额模式',
    id: 'TR007',
    condition: (ctx) => ctx.roundAmountRatio > 0.8,
    score: 25,
    severity: 'MEDIUM',
    description: '大量整数金额交易，疑似脚本'
  },

  // Same counterparty concentration
  COUNTERPARTY_CONCENTRATION: {
    name: '交易对象集中',
    id: 'TR008',
    condition: (ctx) => ctx.counterpartyRatio > 0.6,
    score: 30,
    severity: 'HIGH',
    description: '超过60%交易集中于单一对象'
  }
};

// Reward claim rules
const REWARD_RULES = {
  // Repeated claim attempts
  REPEATED_CLAIM: {
    name: '重复领取尝试',
    id: 'RW001',
    condition: (ctx) => ctx.claimAttempts > 3 && ctx.rewardId,
    score: 35,
    severity: 'HIGH',
    description: '同一奖励多次领取尝试'
  },

  // Exploit timing pattern
  EXPLOIT_TIMING: {
    name: '漏洞利用时机',
    id: 'RW002',
    condition: (ctx) => {
      // Claim right after reward creation (exploit window)
      const diff = ctx.claimTime - ctx.rewardCreateTime;
      return diff < 1000 && diff > 0;
    },
    score: 40,
    severity: 'CRITICAL',
    description: '奖励创建后立即领取'
  },

  // Suspicious reward value
  SUSPICIOUS_VALUE: {
    name: '奖励价值异常',
    id: 'RW003',
    condition: (ctx) => ctx.rewardValue > ctx.normalMaxValue * 3,
    score: 50,
    severity: 'CRITICAL',
    description: '奖励价值远超正常范围'
  }
};

// Payment fraud rules
const PAYMENT_RULES = {
  // Multiple payment attempts
  MULTIPLE_PAYMENT_ATTEMPTS: {
    name: '多次支付尝试',
    id: 'PY001',
    condition: (ctx) => ctx.paymentAttempts > 5 && ctx.timeWindow < 600,
    score: 25,
    severity: 'MEDIUM',
    description: '短时间内多次支付尝试'
  },

  // Refund abuse pattern
  REFUND_ABUSE: {
    name: '退款滥用',
    id: 'PY002',
    condition: (ctx) => ctx.refundCount > 3 && ctx.purchaseCount > ctx.refundCount * 2,
    score: 45,
    severity: 'HIGH',
    description: '频繁退款后再次购买'
  },

  // Payment hijacking signature mismatch
  SIGNATURE_MISMATCH: {
    name: '支付签名异常',
    id: 'PY003',
    condition: (ctx) => !ctx.signatureValid,
    score: 60,
    severity: 'CRITICAL',
    description: '支付签名验证失败'
  }
};

/**
 * Evaluate all transaction rules
 */
function evaluateTransactionRules(context) {
  const triggeredRules = [];

  for (const [key, rule] of Object.entries(TRANSACTION_RULES)) {
    try {
      if (rule.condition(context)) {
        triggeredRules.push({
          id: rule.id,
          name: rule.name,
          score: rule.score,
          severity: rule.severity,
          description: rule.description
        });
      }
    } catch (err) {
      // Condition evaluation error, skip
      console.error(`Rule ${key} evaluation error:`, err.message);
    }
  }

  return triggeredRules;
}

/**
 * Evaluate reward rules
 */
function evaluateRewardRules(context) {
  const triggeredRules = [];

  for (const [key, rule] of Object.entries(REWARD_RULES)) {
    try {
      if (rule.condition(context)) {
        triggeredRules.push({
          id: rule.id,
          name: rule.name,
          score: rule.score,
          severity: rule.severity,
          description: rule.description
        });
      }
    } catch (err) {
      console.error(`Rule ${key} evaluation error:`, err.message);
    }
  }

  return triggeredRules;
}

/**
 * Evaluate payment rules
 */
function evaluatePaymentRules(context) {
  const triggeredRules = [];

  for (const [key, rule] of Object.entries(PAYMENT_RULES)) {
    try {
      if (rule.condition(context)) {
        triggeredRules.push({
          id: rule.id,
          name: rule.name,
          score: rule.score,
          severity: rule.severity,
          description: rule.description
        });
      }
    } catch (err) {
      console.error(`Rule ${key} evaluation error:`, err.message);
    }
  }

  return triggeredRules;
}

module.exports = {
  TRANSACTION_RULES,
  REWARD_RULES,
  PAYMENT_RULES,
  evaluateTransactionRules,
  evaluateRewardRules,
  evaluatePaymentRules
};