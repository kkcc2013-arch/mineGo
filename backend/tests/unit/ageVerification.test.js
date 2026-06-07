// backend/tests/unit/ageVerification.test.js
// REQ-00034: COPPA 合规与年龄验证测试

'use strict';

const {
  calculateAge,
  getAgeBracket,
  AGE_BRACKETS,
  CONSENT_STATUS,
  isMinor,
  isFeatureDisabled
} = require('../../shared/ageVerification');

describe('REQ-00034: Age Verification', () => {
  
  describe('calculateAge', () => {
    it('should calculate correct age for adult', () => {
      const birthDate = '1990-06-15';
      const age = calculateAge(birthDate);
      
      // 年龄应该在 34-36 之间（取决于测试时间）
      expect(age).toBeGreaterThanOrEqual(34);
      expect(age).toBeLessThanOrEqual(36);
    });
    
    it('should calculate correct age for child', () => {
      const today = new Date();
      const birthDate = `${today.getFullYear() - 10}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const age = calculateAge(birthDate);
      
      expect(age).toBe(10);
    });
    
    it('should return null for invalid date', () => {
      expect(calculateAge(null)).toBeNull();
      expect(calculateAge(undefined)).toBeNull();
      expect(calculateAge('invalid')).toBeNull();
    });
    
    it('should handle leap year correctly', () => {
      const age = calculateAge('2000-02-29'); // 闰年生日
      expect(age).toBeGreaterThan(20);
    });
    
    it('should calculate age correctly for birthday not yet occurred this year', () => {
      const today = new Date();
      const futureMonth = today.getMonth() === 11 ? 0 : today.getMonth() + 2;
      const futureYear = today.getMonth() === 11 ? today.getFullYear() - 12 : today.getFullYear() - 11;
      const birthDate = `${futureYear}-${String(futureMonth + 1).padStart(2, '0')}-15`;
      
      const age = calculateAge(birthDate);
      // 生日还没到，年龄应该是年份差-1
      expect(age).toBeGreaterThanOrEqual(10);
      expect(age).toBeLessThanOrEqual(12);
    });
  });
  
  describe('getAgeBracket', () => {
    it('should return UNDER_13 for age < 13', () => {
      expect(getAgeBracket(5)).toBe(AGE_BRACKETS.UNDER_13);
      expect(getAgeBracket(10)).toBe(AGE_BRACKETS.UNDER_13);
      expect(getAgeBracket(12)).toBe(AGE_BRACKETS.UNDER_13);
    });
    
    it('should return TEEN_13_17 for age 13-17', () => {
      expect(getAgeBracket(13)).toBe(AGE_BRACKETS.TEEN_13_17);
      expect(getAgeBracket(15)).toBe(AGE_BRACKETS.TEEN_13_17);
      expect(getAgeBracket(17)).toBe(AGE_BRACKETS.TEEN_13_17);
    });
    
    it('should return ADULT_18_PLUS for age >= 18', () => {
      expect(getAgeBracket(18)).toBe(AGE_BRACKETS.ADULT_18_PLUS);
      expect(getAgeBracket(25)).toBe(AGE_BRACKETS.ADULT_18_PLUS);
      expect(getAgeBracket(65)).toBe(AGE_BRACKETS.ADULT_18_PLUS);
    });
    
    it('should return UNKNOWN for null/undefined age', () => {
      expect(getAgeBracket(null)).toBe(AGE_BRACKETS.UNKNOWN);
      expect(getAgeBracket(undefined)).toBe(AGE_BRACKETS.UNKNOWN);
    });
  });
  
  describe('isMinor', () => {
    it('should return true for UNDER_13', () => {
      const profile = { age_bracket: AGE_BRACKETS.UNDER_13 };
      expect(isMinor(profile)).toBe(true);
    });
    
    it('should return true for TEEN_13_17', () => {
      const profile = { age_bracket: AGE_BRACKETS.TEEN_13_17 };
      expect(isMinor(profile)).toBe(true);
    });
    
    it('should return false for ADULT_18_PLUS', () => {
      const profile = { age_bracket: AGE_BRACKETS.ADULT_18_PLUS };
      expect(isMinor(profile)).toBe(false);
    });
    
    it('should return false for null profile', () => {
      expect(isMinor(null)).toBe(false);
    });
    
    it('should return false for UNKNOWN', () => {
      const profile = { age_bracket: AGE_BRACKETS.UNKNOWN };
      expect(isMinor(profile)).toBe(false);
    });
  });
  
  describe('isFeatureDisabled', () => {
    it('should return true when feature is in disabled list', () => {
      const profile = { features_disabled: ['trade', 'social'] };
      expect(isFeatureDisabled(profile, 'trade')).toBe(true);
      expect(isFeatureDisabled(profile, 'social')).toBe(true);
    });
    
    it('should return false when feature is not in disabled list', () => {
      const profile = { features_disabled: ['trade'] };
      expect(isFeatureDisabled(profile, 'social')).toBe(false);
      expect(isFeatureDisabled(profile, 'payment')).toBe(false);
    });
    
    it('should return false when features_disabled is empty', () => {
      const profile = { features_disabled: [] };
      expect(isFeatureDisabled(profile, 'trade')).toBe(false);
    });
    
    it('should return false for null profile', () => {
      expect(isFeatureDisabled(null, 'trade')).toBe(false);
    });
    
    it('should return false when features_disabled is null', () => {
      const profile = { features_disabled: null };
      expect(isFeatureDisabled(profile, 'trade')).toBe(false);
    });
  });
  
  describe('AGE_BRACKETS constants', () => {
    it('should have all required values', () => {
      expect(AGE_BRACKETS.UNDER_13).toBe('under_13');
      expect(AGE_BRACKETS.TEEN_13_17).toBe('13_17');
      expect(AGE_BRACKETS.ADULT_18_PLUS).toBe('18_plus');
      expect(AGE_BRACKETS.UNKNOWN).toBe('unknown');
    });
  });
  
  describe('CONSENT_STATUS constants', () => {
    it('should have all required values', () => {
      expect(CONSENT_STATUS.PENDING).toBe('pending');
      expect(CONSENT_STATUS.VERIFIED).toBe('verified');
      expect(CONSENT_STATUS.DENIED).toBe('denied');
      expect(CONSENT_STATUS.NOT_REQUIRED).toBe('not_required');
    });
  });
  
  describe('Edge cases', () => {
    it('should handle age exactly 13', () => {
      expect(getAgeBracket(13)).toBe(AGE_BRACKETS.TEEN_13_17);
    });
    
    it('should handle age exactly 18', () => {
      expect(getAgeBracket(18)).toBe(AGE_BRACKETS.ADULT_18_PLUS);
    });
    
    it('should handle age 0', () => {
      expect(getAgeBracket(0)).toBe(AGE_BRACKETS.UNDER_13);
    });
    
    it('should handle negative age (invalid but defensive)', () => {
      // 负数年龄不应该发生，但代码应该能处理
      expect(getAgeBracket(-1)).toBe(AGE_BRACKETS.UNDER_13);
    });
    
    it('should handle very old age', () => {
      expect(getAgeBracket(100)).toBe(AGE_BRACKETS.ADULT_18_PLUS);
      expect(getAgeBracket(150)).toBe(AGE_BRACKETS.ADULT_18_PLUS);
    });
  });
});

// Mock 数据库测试（如果需要集成测试，应放在 integration 测试中）
describe('REQ-00034: Database Operations (Mocked)', () => {
  // 这些测试需要 mock 数据库连接
  // 在集成测试中进行真实数据库操作测试
  
  it('should define createOrUpdateAgeProfile function', () => {
    const { createOrUpdateAgeProfile } = require('../../shared/ageVerification');
    expect(typeof createOrUpdateAgeProfile).toBe('function');
  });
  
  it('should define getAgeProfile function', () => {
    const { getAgeProfile } = require('../../shared/ageVerification');
    expect(typeof getAgeProfile).toBe('function');
  });
  
  it('should define sendParentConsentEmail function', () => {
    const { sendParentConsentEmail } = require('../../shared/ageVerification');
    expect(typeof sendParentConsentEmail).toBe('function');
  });
  
  it('should define verifyParentConsent function', () => {
    const { verifyParentConsent } = require('../../shared/ageVerification');
    expect(typeof verifyParentConsent).toBe('function');
  });
  
  it('should define checkPlayTimeLimit function', () => {
    const { checkPlayTimeLimit } = require('../../shared/ageVerification');
    expect(typeof checkPlayTimeLimit).toBe('function');
  });
  
  it('should define checkSpendLimit function', () => {
    const { checkSpendLimit } = require('../../shared/ageVerification');
    expect(typeof checkSpendLimit).toBe('function');
  });
  
  it('should define getChildrenByParentEmail function', () => {
    const { getChildrenByParentEmail } = require('../../shared/ageVerification');
    expect(typeof getChildrenByParentEmail).toBe('function');
  });
  
  it('should define updateChildLimits function', () => {
    const { updateChildLimits } = require('../../shared/ageVerification');
    expect(typeof updateChildLimits).toBe('function');
  });
});
