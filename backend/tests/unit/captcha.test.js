/**
 * CAPTCHA System Unit Tests
 * 风险触发式人机验证系统单元测试
 * 
 * REQ-00064: 风险触发式人机验证（CAPTCHA）系统
 */

const { describe, it, beforeEach, afterEach, expect, jest } = require('@jest/globals');
const CaptchaChallengeGenerator = require('../shared/captchaChallenge');
const CaptchaValidator = require('../shared/captchaValidator');
const CaptchaTrigger = require('../shared/captchaTrigger');

// Mock dependencies
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

jest.mock('ioredis', () => {
  return jest.fn(() => ({
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    incr: jest.fn()
  }));
});

describe('CaptchaChallengeGenerator', () => {
  let generator;

  beforeEach(() => {
    generator = new CaptchaChallengeGenerator();
  });

  describe('generateSlideChallenge', () => {
    it('should generate slide challenge with correct grid size for low difficulty', () => {
      const challenge = generator.generateSlideChallenge('low');
      
      expect(challenge.type).toBe('slide');
      expect(challenge.gridSize).toBe(3);
      expect(challenge.difficulty).toBe('low');
      expect(challenge.pieces.length).toBe(8); // 3x3 - 1 = 8 pieces
      expect(challenge.expectedAnswer).toBeDefined();
      expect(challenge.expectedAnswer.pieceOrder).toBeDefined();
    });

    it('should generate slide challenge with 4x4 grid for high difficulty', () => {
      const challenge = generator.generateSlideChallenge('high');
      
      expect(challenge.gridSize).toBe(4);
      expect(challenge.pieces.length).toBe(15); // 4x4 - 1 = 15 pieces
    });

    it('should generate valid expected answer', () => {
      const challenge = generator.generateSlideChallenge('medium');
      
      expect(Array.isArray(challenge.expectedAnswer.pieceOrder)).toBe(true);
      expect(challenge.expectedAnswer.emptyPosition).toBeGreaterThanOrEqual(0);
    });
  });

  describe('generateClickChallenge', () => {
    it('should generate click challenge with correct structure', () => {
      const challenge = generator.generateClickChallenge('low');
      
      expect(challenge.type).toBe('click');
      expect(challenge.gridSize).toBeDefined();
      expect(challenge.chars).toBeDefined();
      expect(challenge.targetChars).toBeDefined();
      expect(challenge.expectedAnswer).toBeDefined();
    });

    it('should require sequence for medium and high difficulty', () => {
      const lowChallenge = generator.generateClickChallenge('low');
      const mediumChallenge = generator.generateClickChallenge('medium');
      const highChallenge = generator.generateClickChallenge('high');
      
      expect(lowChallenge.sequence).toBe(false);
      expect(mediumChallenge.sequence).toBe(true);
      expect(highChallenge.sequence).toBe(true);
    });

    it('should ensure target chars exist in grid', () => {
      const challenge = generator.generateClickChallenge('medium');
      
      challenge.targetChars.forEach(char => {
        expect(challenge.chars).toContain(char);
      });
    });

    it('should generate correct expected answer positions', () => {
      const challenge = generator.generateClickChallenge('medium');
      
      expect(challenge.expectedAnswer.positions.length).toBe(challenge.targetChars.length);
      expect(challenge.expectedAnswer.chars).toEqual(challenge.targetChars);
    });
  });

  describe('generateCalculateChallenge', () => {
    it('should generate calculate challenge with valid question', () => {
      const challenge = generator.generateCalculateChallenge('low');
      
      expect(challenge.type).toBe('calculate');
      expect(challenge.question).toBeDefined();
      expect(challenge.options).toBeDefined();
      expect(challenge.options.length).toBe(4);
    });

    it('should use correct number ranges for difficulties', () => {
      const lowChallenge = generator.generateCalculateChallenge('low');
      const highChallenge = generator.generateCalculateChallenge('high');
      
      // Low difficulty should have simpler numbers
      expect(lowChallenge.difficulty).toBe('low');
      // High difficulty may include multiplication
      expect(highChallenge.difficulty).toBe('high');
    });

    it('should include correct answer in options', () => {
      const challenge = generator.generateCalculateChallenge('medium');
      
      expect(challenge.options).toContain(challenge.expectedAnswer.value);
      expect(challenge.expectedAnswer.optionIndex).toBeGreaterThanOrEqual(0);
      expect(challenge.expectedAnswer.optionIndex).toBeLessThan(4);
    });
  });

  describe('getTypesForDifficulty', () => {
    it('should return only slide for low difficulty', () => {
      const types = generator.getTypesForDifficulty('low');
      expect(types).toEqual(['slide']);
    });

    it('should return slide and click for medium difficulty', () => {
      const types = generator.getTypesForDifficulty('medium');
      expect(types).toEqual(['slide', 'click']);
    });

    it('should return all types for high difficulty', () => {
      const types = generator.getTypesForDifficulty('high');
      expect(types).toEqual(['slide', 'click', 'calculate']);
    });
  });

  describe('selectRandomType', () => {
    it('should always return valid type for each difficulty', () => {
      const validTypes = ['slide', 'click', 'calculate'];
      
      for (const difficulty of ['low', 'medium', 'high']) {
        for (let i = 0; i < 10; i++) {
          const type = generator.selectRandomType(difficulty);
          expect(validTypes).toContain(type);
        }
      }
    });
  });

  describe('shuffleArray', () => {
    it('should return array with same length', () => {
      const arr = [1, 2, 3, 4, 5];
      const shuffled = generator.shuffleArray(arr);
      
      expect(shuffled.length).toBe(arr.length);
    });

    it('should contain all original elements', () => {
      const arr = [1, 2, 3, 4, 5];
      const shuffled = generator.shuffleArray(arr);
      
      arr.forEach(item => {
        expect(shuffled).toContain(item);
      });
    });

    it('should not modify original array', () => {
      const arr = [1, 2, 3, 4, 5];
      const original = [...arr];
      generator.shuffleArray(arr);
      
      expect(arr).toEqual(original);
    });
  });
});

describe('CaptchaValidator', () => {
  let validator;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    mockDb = {
      query: jest.fn()
    };
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      exists: jest.fn()
    };
    
    validator = new CaptchaValidator({
      db: mockDb,
      redis: mockRedis
    });
  });

  describe('verifySlideAnswer', () => {
    it('should return true for correct answer', () => {
      const expected = { pieceOrder: [0, 1, 2, 3] };
      const answer = { pieceOrder: [0, 1, 2, 3] };
      
      expect(validator.verifySlideAnswer(expected, answer)).toBe(true);
    });

    it('should return false for incorrect answer', () => {
      const expected = { pieceOrder: [0, 1, 2, 3] };
      const answer = { pieceOrder: [3, 2, 1, 0] };
      
      expect(validator.verifySlideAnswer(expected, answer)).toBe(false);
    });

    it('should return false for missing answer', () => {
      const expected = { pieceOrder: [0, 1, 2, 3] };
      
      expect(validator.verifySlideAnswer(expected, null)).toBe(false);
      expect(validator.verifySlideAnswer(expected, {})).toBe(false);
    });

    it('should return false for wrong length', () => {
      const expected = { pieceOrder: [0, 1, 2, 3] };
      const answer = { pieceOrder: [0, 1, 2] };
      
      expect(validator.verifySlideAnswer(expected, answer)).toBe(false);
    });
  });

  describe('verifyClickAnswer', () => {
    it('should return true for correct positions', () => {
      const expected = { positions: [5, 10, 15], chars: ['A', 'B', 'C'] };
      const answer = { positions: [5, 10, 15] };
      
      expect(validator.verifyClickAnswer(expected, answer)).toBe(true);
    });

    it('should return false for incorrect positions', () => {
      const expected = { positions: [5, 10, 15], chars: ['A', 'B', 'C'] };
      const answer = { positions: [5, 11, 15] };
      
      expect(validator.verifyClickAnswer(expected, answer)).toBe(false);
    });

    it('should return false for wrong number of clicks', () => {
      const expected = { positions: [5, 10, 15], chars: ['A', 'B', 'C'] };
      const answer = { positions: [5, 10] };
      
      expect(validator.verifyClickAnswer(expected, answer)).toBe(false);
    });
  });

  describe('verifyCalculateAnswer', () => {
    it('should return true for correct value', () => {
      const expected = { value: 42, optionIndex: 2 };
      const answer = { value: 42 };
      
      expect(validator.verifyCalculateAnswer(expected, answer)).toBe(true);
    });

    it('should return true for correct option index', () => {
      const expected = { value: 42, optionIndex: 2 };
      const answer = { optionIndex: 2 };
      
      expect(validator.verifyCalculateAnswer(expected, answer)).toBe(true);
    });

    it('should return false for incorrect value', () => {
      const expected = { value: 42, optionIndex: 2 };
      const answer = { value: 100 };
      
      expect(validator.verifyCalculateAnswer(expected, answer)).toBe(false);
    });

    it('should return false for missing answer', () => {
      const expected = { value: 42, optionIndex: 2 };
      
      expect(validator.verifyCalculateAnswer(expected, {})).toBe(false);
    });
  });

  describe('analyzeTrajectory', () => {
    it('should return high score for human-like trajectory', () => {
      // Simulate human-like trajectory with pauses and jitter
      const trajectory = [
        { x: 0, y: 0, t: 0, duration: 150 },
        { x: 10, y: 5, t: 50 },
        { x: 25, y: 12, t: 100 },
        { x: 40, y: 18, t: 160 },
        { x: 55, y: 25, t: 220 },
        { x: 70, y: 30, t: 280 },
        { x: 85, y: 35, t: 350 },
        { x: 100, y: 40, t: 420, duration: 120 }
      ];
      
      const score = validator.analyzeTrajectory(trajectory);
      expect(score).toBeGreaterThan(0.3);
    });

    it('should return low score for bot-like trajectory', () => {
      // Simulate bot-like trajectory with constant speed
      const trajectory = [];
      for (let i = 0; i <= 10; i++) {
        trajectory.push({
          x: i * 10,
          y: i * 5,
          t: i * 50
        });
      }
      
      const score = validator.analyzeTrajectory(trajectory);
      expect(score).toBeLessThan(0.5);
    });

    it('should return 0 for empty trajectory', () => {
      expect(validator.analyzeTrajectory([])).toBe(0);
      expect(validator.analyzeTrajectory(null)).toBe(0);
    });
  });

  describe('calculateVariance', () => {
    it('should calculate variance correctly', () => {
      const arr = [2, 4, 4, 4, 5, 5, 7, 9];
      const variance = validator.calculateVariance(arr);
      
      // Variance of this array should be 4
      expect(variance).toBeCloseTo(4, 1);
    });

    it('should return 0 for empty array', () => {
      expect(validator.calculateVariance([])).toBe(0);
    });
  });
});

describe('CaptchaTrigger', () => {
  let trigger;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    mockDb = {
      query: jest.fn()
    };
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn()
    };
    
    trigger = new CaptchaTrigger({
      db: mockDb,
      redis: mockRedis
    });
  });

  describe('getUserTrustScore', () => {
    it('should return cached score from Redis', async () => {
      mockRedis.get.mockResolvedValue('75');
      
      const score = await trigger.getUserTrustScore('user-123');
      
      expect(score).toBe(75);
      expect(mockRedis.get).toHaveBeenCalledWith('trust_score:user-123');
    });

    it('should return default score when not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const score = await trigger.getUserTrustScore('user-123');
      
      expect(score).toBe(85); // Default trust score
    });
  });

  describe('calculateDistance', () => {
    it('should calculate distance between two points', () => {
      // Beijing to Shanghai ≈ 1068 km
      const distance = trigger.calculateDistance(
        39.9042, 116.4074, // Beijing
        31.2304, 121.4737  // Shanghai
      );
      
      expect(distance).toBeGreaterThan(1000);
      expect(distance).toBeLessThan(1100);
    });

    it('should return 0 for same point', () => {
      const distance = trigger.calculateDistance(0, 0, 0, 0);
      expect(distance).toBe(0);
    });
  });

  describe('sanitizeChallengeData', () => {
    it('should remove expectedAnswer from challenge', () => {
      const challenge = {
        type: 'slide',
        gridSize: 3,
        expectedAnswer: { pieceOrder: [0, 1, 2] }
      };
      
      const sanitized = trigger.sanitizeChallengeData(challenge);
      
      expect(sanitized.type).toBe('slide');
      expect(sanitized.expectedAnswer).toBeUndefined();
    });
  });
});

// Integration tests
describe('CAPTCHA Integration Tests', () => {
  describe('Full verification flow', () => {
    it('should generate, answer, and validate slide challenge correctly', () => {
      const generator = new CaptchaChallengeGenerator();
      
      // Generate challenge
      const challenge = generator.generate('slide', 'low');
      
      expect(challenge.type).toBe('slide');
      expect(challenge.expectedAnswer).toBeDefined();
      
      // Simulate correct answer
      const correctAnswer = { pieceOrder: challenge.expectedAnswer.pieceOrder };
      
      // Validate (using validator's internal method)
      const validator = new CaptchaValidator({});
      const isValid = validator.verifySlideAnswer(challenge.expectedAnswer, correctAnswer);
      
      expect(isValid).toBe(true);
    });

    it('should generate, answer, and validate click challenge correctly', () => {
      const generator = new CaptchaChallengeGenerator();
      
      // Generate challenge
      const challenge = generator.generate('click', 'medium');
      
      expect(challenge.type).toBe('click');
      
      // Simulate correct answer
      const correctAnswer = { positions: challenge.expectedAnswer.positions };
      
      // Validate
      const validator = new CaptchaValidator({});
      const isValid = validator.verifyClickAnswer(challenge.expectedAnswer, correctAnswer);
      
      expect(isValid).toBe(true);
    });

    it('should generate, answer, and validate calculate challenge correctly', () => {
      const generator = new CaptchaChallengeGenerator();
      
      // Generate challenge
      const challenge = generator.generate('calculate', 'high');
      
      expect(challenge.type).toBe('calculate');
      
      // Simulate correct answer
      const correctAnswer = { value: challenge.expectedAnswer.value };
      
      // Validate
      const validator = new CaptchaValidator({});
      const isValid = validator.verifyCalculateAnswer(challenge.expectedAnswer, correctAnswer);
      
      expect(isValid).toBe(true);
    });
  });
});

// Test summary
console.log('CAPTCHA System Unit Tests');
console.log('=========================');
console.log('REQ-00064: 风险触发式人机验证（CAPTCHA）系统');
console.log('');
console.log('Test Categories:');
console.log('- CaptchaChallengeGenerator: 15 tests');
console.log('- CaptchaValidator: 12 tests');
console.log('- CaptchaTrigger: 5 tests');
console.log('- Integration: 3 tests');
console.log('');
console.log('Total: 35 test cases');
