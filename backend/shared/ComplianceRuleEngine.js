// backend/shared/ComplianceRuleEngine.js
// REQ-00495: 合规规则引擎
'use strict';

const { query } = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('compliance-engine');

class ComplianceRuleEngine {
  constructor() {
    this.rulesCache = new Map();
    this.cacheTimeout = 600000; // 10 minutes
  }

  /**
   * 加载地区合规规则
   * @param {string} regionCode - 地区代码（ISO 3166-1 alpha-2）
   * @returns {object} 规则配置
   */
  async loadRegionRules(regionCode) {
    const cached = this.rulesCache.get(regionCode);
    if (cached) {
      return cached;
    }

    try {
      const { rows } = await query(`
        SELECT rule_type, rule_config
        FROM compliance_rules
        WHERE region_code = $1 AND is_active = true
          AND (effective_from IS NULL OR effective_from <= NOW())
      `, [regionCode]);

      const rules = {};
      rows.forEach(row => {
        rules[row.rule_type] = row.rule_config;
      });

      this.rulesCache.set(regionCode, rules);
      setTimeout(() => this.rulesCache.delete(regionCode), this.cacheTimeout);

      return rules;
    } catch (err) {
      logger.error({ err, regionCode }, 'Failed to load compliance rules');
      return {};
    }
  }

  /**
   * 检查支付限制
   * @param {string} userId - 用户 ID
   * @param {string} regionCode - 地区代码
   * @param {number} amount - 支付金额
   * @param {number} userAge - 用户年龄
   * @returns {object} 检查结果
   */
  async checkPaymentLimit(userId, regionCode, amount, userAge) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.payment_limit) {
      return { allowed: true, rules: 'none' };
    }

    const { max_single_amount, max_monthly_amount, age_threshold, currency } = rules.payment_limit;
    
    // 年龄检查
    if (age_threshold && userAge < age_threshold) {
      return {
        allowed: false,
        reason: `age_below_${age_threshold}`,
        maxAmount: max_single_amount || 0,
        message: `未成年人单次支付限额：${max_single_amount || 0} ${currency || 'CNY'}`
      };
    }

    // 单次支付限额
    if (max_single_amount && amount > max_single_amount) {
      return {
        allowed: false,
        reason: 'exceeds_single_limit',
        maxAmount: max_single_amount,
        message: `单次支付超过限额：${max_single_amount} ${currency || 'CNY'}`
      };
    }

    // 月度支付限额检查
    if (max_monthly_amount) {
      try {
        const { rows: [monthly] } = await query(`
          SELECT COALESCE(SUM(amount), 0) as total
          FROM payment_transactions
          WHERE user_id = $1 
            AND created_at >= DATE_TRUNC('month', NOW())
            AND status = 'completed'
        `, [userId]);

        const monthlyTotal = parseFloat(monthly.total) || 0;
        
        if (monthlyTotal + amount > max_monthly_amount) {
          return {
            allowed: false,
            reason: 'exceeds_monthly_limit',
            maxMonthly: max_monthly_amount,
            currentMonthly: monthlyTotal,
            remaining: max_monthly_amount - monthlyTotal,
            message: `本月支付已达限额，剩余：${max_monthly_amount - monthlyTotal} ${currency || 'CNY'}`
          };
        }

        return {
          allowed: true,
          maxSingle: max_single_amount,
          maxMonthly: max_monthly_amount,
          currentMonthly: monthlyTotal,
          remaining: max_monthly_amount - monthlyTotal - amount
        };
      } catch (err) {
        logger.error({ err, userId }, 'Failed to check monthly payment limit');
        // 失败时允许（降级）
        return { allowed: true };
      }
    }

    return { allowed: true };
  }

  /**
   * 检查游玩时间限制（防沉迷）
   * @param {string} userId - 用户 ID
   * @param {string} regionCode - 地区代码
   * @param {number} userAge - 用户年龄
   * @returns {object} 检查结果
   */
  async checkPlaytimeLimit(userId, regionCode, userAge) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.playtime_limit) {
      return { allowed: true, rules: 'none' };
    }

    const { daily_limit_hours, night_restriction, age_threshold } = rules.playtime_limit;
    
    // 成年人无限制
    if (age_threshold && userAge >= age_threshold) {
      return { allowed: true, exempt: 'adult' };
    }

    // 检查夜间禁玩时段
    if (night_restriction) {
      const hour = new Date().getHours();
      const { start_hour, end_hour } = night_restriction;
      
      // 跨午夜时段（如 22:00 - 08:00）
      if (start_hour > end_hour) {
        if (hour >= start_hour || hour < end_hour) {
          return {
            allowed: false,
            reason: 'night_restriction',
            startHour: start_hour,
            endHour: end_hour,
            currentHour: hour,
            message: `夜间禁玩时段：${start_hour}:00 - ${end_hour}:00`
          };
        }
      } else {
        if (hour >= start_hour && hour < end_hour) {
          return {
            allowed: false,
            reason: 'night_restriction',
            startHour: start_hour,
            endHour: end_hour,
            currentHour: hour,
            message: `禁玩时段：${start_hour}:00 - ${end_hour}:00`
          };
        }
      }
    }

    // 检查当日游玩时长
    if (daily_limit_hours) {
      try {
        const { rows: [today] } = await query(`
          SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))/3600), 0) as hours
          FROM play_sessions
          WHERE user_id = $1 
            AND started_at >= CURRENT_DATE
        `, [userId]);

        const hoursPlayed = parseFloat(today.hours) || 0;
        
        if (hoursPlayed >= daily_limit_hours) {
          return {
            allowed: false,
            reason: 'daily_limit_exceeded',
            limitHours: daily_limit_hours,
            hoursPlayed,
            message: `今日游玩时长已达限额：${daily_limit_hours} 小时`
          };
        }

        return {
          allowed: true,
          limitHours: daily_limit_hours,
          hoursPlayed,
          remainingHours: daily_limit_hours - hoursPlayed,
          warning: hoursPlayed >= daily_limit_hours - 0.5
        };
      } catch (err) {
        logger.error({ err, userId }, 'Failed to check daily playtime');
        // 失败时允许（降级）
        return { allowed: true };
      }
    }

    return { allowed: true };
  }

  /**
   * 检查实名认证要求
   * @param {string} userId - 用户 ID
   * @param {string} regionCode - 地区代码
   * @returns {object} 检查结果
   */
  async checkRealNameVerification(userId, regionCode) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.real_name_verification) {
      return { required: false, rules: 'none' };
    }

    const { required, providers } = rules.real_name_verification;
    
    if (!required) {
      return { required: false };
    }

    // 检查用户是否已实名认证
    try {
      const { rows: [user] } = await query(`
        SELECT verified_age, age_verified
        FROM user_compliance_records
        WHERE user_id = $1 AND region_code = $2
      `, [userId, regionCode]);

      if (!user) {
        return {
          required: true,
          verified: false,
          providers,
          message: '需要实名认证才能继续游戏'
        };
      }

      return {
        required: true,
        verified: user.age_verified || false,
        verifiedAge: user.verified_age,
        providers
      };
    } catch (err) {
      logger.error({ err, userId, regionCode }, 'Failed to check real name verification');
      return { required: required, verified: false, providers };
    }
  }

  /**
   * 检查 GDPR 同意要求
   * @param {string} userId - 用户 ID
   * @param {string} regionCode - 地区代码
   * @returns {object} 检查结果
   */
  async checkGDPRConsent(userId, regionCode) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.gdpr_consent) {
      return { required: false, rules: 'none' };
    }

    const { required, consent_age } = rules.gdpr_consent;
    
    if (!required) {
      return { required: false };
    }

    try {
      const { rows: [user] } = await query(`
        SELECT gdpr_consent, consent_version, consent_date, verified_age
        FROM user_compliance_records
        WHERE user_id = $1 AND region_code = $2
      `, [userId, regionCode]);

      if (!user) {
        return {
          required: true,
          consented: false,
          consentAge: consent_age,
          message: `需要GDPR同意（${consent_age}岁以上）`
        };
      }

      return {
        required: true,
        consented: user.gdpr_consent || false,
        consentAge: consent_age,
        consentVersion: user.consent_version,
        consentDate: user.consent_date,
        userAge: user.verified_age
      };
    } catch (err) {
      logger.error({ err, userId, regionCode }, 'Failed to check GDPR consent');
      return { required: required, consented: false, consentAge: consent_age };
    }
  }

  /**
   * 检查 COPPA 合规
   * @param {string} userId - 用户 ID
   * @param {string} regionCode - 地区代码
   * @returns {object} 检查结果
   */
  async checkCOPPACompliance(userId, regionCode) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.coppa_compliance) {
      return { required: false, rules: 'none' };
    }

    const { age_threshold, parental_consent_required } = rules.coppa_compliance;
    
    try {
      const { rows: [user] } = await query(`
        SELECT coppa_consent, verified_age
        FROM user_compliance_records
        WHERE user_id = $1 AND region_code = $2
      `, [userId, regionCode]);

      if (!user) {
        return {
          required: true,
          coppaConsented: false,
          ageThreshold: age_threshold,
          parentalConsentRequired: parental_consent_required,
          message: '需要COPPA合规验证'
        };
      }

      // 用户年龄低于阈值，需要家长同意
      if (user.verified_age && user.verified_age < age_threshold) {
        return {
          required: true,
          coppaConsented: user.coppa_consent || false,
          ageThreshold: age_threshold,
          parentalConsentRequired: true,
          userAge: user.verified_age,
          message: '13岁以下用户需要家长同意'
        };
      }

      return {
        required: true,
        coppaConsented: true,
        ageThreshold: age_threshold,
        parentalConsentRequired: parental_consent_required,
        userAge: user.verified_age
      };
    } catch (err) {
      logger.error({ err, userId, regionCode }, 'Failed to check COPPA compliance');
      return { required: true, coppaConsented: false, ageThreshold: age_threshold };
    }
  }

  /**
   * 检查赌博要素限制（日本）
   * @param {string} userId - 用户 ID
   * @param {string} regionCode - 地区代码
   * @returns {object} 检查结果
   */
  async checkGamblingRestriction(userId, regionCode) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.gambling_restriction) {
      return { required: false, rules: 'none' };
    }

    const { gacha_disclosure, probability_display } = rules.gambling_restriction;
    
    return {
      required: true,
      gachaDisclosure: gacha_disclosure,
      probabilityDisplay: probability_display,
      message: '抽卡概率需公开显示'
    };
  }

  /**
   * 综合规规检查
   * @param {string} userId - 用户 ID
   * @param {string} regionCode - 地区代码
   * @param {object} context - 检查上下文（年龄、支付金额等）
   * @returns {object} 综合检查结果
   */
  async comprehensiveCheck(userId, regionCode, context = {}) {
    const { userAge, paymentAmount } = context;
    
    const results = {
      regionCode,
      userId,
      timestamp: new Date().toISOString(),
      checks: {}
    };

    // 支付限制检查
    if (paymentAmount) {
      results.checks.payment = await this.checkPaymentLimit(userId, regionCode, paymentAmount, userAge);
    }

    // 游玩时间限制检查
    if (userAge) {
      results.checks.playtime = await this.checkPlaytimeLimit(userId, regionCode, userAge);
    }

    // 实名认证检查
    results.checks.realName = await this.checkRealNameVerification(userId, regionCode);

    // GDPR 同意检查
    results.checks.gdpr = await this.checkGDPRConsent(userId, regionCode);

    // COPPA 合规检查
    results.checks.coppa = await this.checkCOPPACompliance(userId, regionCode);

    // 赌博要素检查
    results.checks.gambling = await this.checkGamblingRestriction(userId, regionCode);

    // 计算综合合规状态
    const failedChecks = Object.entries(results.checks)
      .filter(([key, result]) => !result.allowed && result.allowed !== undefined)
      .map(([key]) => key);

    results.compliant = failedChecks.length === 0;
    results.failedChecks = failedChecks;
    
    if (failedChecks.length > 0) {
      results.message = `合规检查失败：${failedChecks.join(', ')}`;
    }

    return results;
  }

  /**
   * 获取地区合规规则汇总
   */
  async getRegionComplianceSummary(regionCode) {
    try {
      const { rows } = await query(`
        SELECT rules, active_rules
        FROM v_region_compliance_summary
        WHERE region_code = $1
      `, [regionCode]);

      if (rows.length === 0) {
        return { regionCode, rules: {}, activeRules: [] };
      }

      return {
        regionCode,
        rules: rows[0].rules,
        activeRules: rows[0].active_rules
      };
    } catch (err) {
      logger.error({ err, regionCode }, 'Failed to get compliance summary');
      return { regionCode, rules: {}, activeRules: [], error: err.message };
    }
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.rulesCache.clear();
    logger.info('Compliance rules cache cleared');
  }
}

// 单例实例
let instance = null;

/**
 * 获取或创建 ComplianceRuleEngine 实例
 */
function getComplianceRuleEngine() {
  if (!instance) {
    instance = new ComplianceRuleEngine();
  }
  return instance;
}

module.exports = {
  ComplianceRuleEngine,
  getComplianceRuleEngine
};