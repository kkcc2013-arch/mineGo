/**
 * 分页策略选择器单元测试
 * 
 * @module PaginationStrategySelector.test
 */

const PaginationStrategySelector = require('../shared/pagination/PaginationStrategySelector');
const { PaginationStrategy } = PaginationStrategySelector;
const { expect } = require('chai');

describe('PaginationStrategySelector', () => {
  let selector;

  beforeEach(() => {
    selector = new PaginationStrategySelector({
      offsetThreshold: 1000,
      totalEstimateThreshold: 10000,
      enableEstimation: true
    });
  });

  describe('selectStrategy', () => {
    it('should return cursor strategy when cursor is provided', () => {
      const params = { page: 1, pageSize: 20, cursor: 'abc123' };
      const result = selector.selectStrategy(params);
      
      expect(result.type).to.equal(PaginationStrategy.CURSOR);
      expect(result.calculateTotal).to.be.false;
      expect(result.reason).to.equal('Explicit cursor provided');
    });

    it('should return cursor strategy for large offset', () => {
      const params = { page: 100, pageSize: 20 };
      const result = selector.selectStrategy(params);
      
      expect(result.type).to.equal(PaginationStrategy.CURSOR);
      expect(result.calculateTotal).to.be.false;
      expect(result.performanceWarning).to.exist;
      expect(result.performanceWarning.currentOffset).to.equal(1980);
    });

    it('should return offset strategy for small offset', () => {
      const params = { page: 1, pageSize: 20 };
      const result = selector.selectStrategy(params);
      
      expect(result.type).to.equal(PaginationStrategy.OFFSET);
      expect(result.calculateTotal).to.be.true;
    });

    it('should not calculate total for large estimated total', () => {
      const params = { page: 1, pageSize: 20 };
      const result = selector.selectStrategy(params, 50000);
      
      expect(result.type).to.equal(PaginationStrategy.OFFSET);
      expect(result.calculateTotal).to.be.false;
      expect(result.performanceWarning).to.exist;
      expect(result.performanceWarning.estimatedTotal).to.equal(50000);
    });

    it('should calculate total for normal pagination', () => {
      const params = { page: 2, pageSize: 20 };
      const result = selector.selectStrategy(params, 1000);
      
      expect(result.type).to.equal(PaginationStrategy.OFFSET);
      expect(result.calculateTotal).to.be.true;
      expect(result.suggestion).to.be.null;
    });

    it('should provide suggestion for large offset', () => {
      const params = { page: 60, pageSize: 20 };
      const result = selector.selectStrategy(params);
      
      expect(result.suggestion).to.include('cursor');
    });
  });

  describe('shouldUseCursor', () => {
    it('should return true for large offset', () => {
      const params = { page: 100, pageSize: 20 };
      expect(selector.shouldUseCursor(params)).to.be.true;
    });

    it('should return true when cursor is provided', () => {
      const params = { page: 1, pageSize: 20, cursor: 'abc' };
      expect(selector.shouldUseCursor(params)).to.be.true;
    });

    it('should return false for small offset', () => {
      const params = { page: 1, pageSize: 20 };
      expect(selector.shouldUseCursor(params)).to.be.false;
    });
  });

  describe('getSuggestion', () => {
    it('should return suggestion for large offset', () => {
      const params = { page: 100, pageSize: 20 };
      const suggestion = selector.getSuggestion(params);
      
      expect(suggestion).to.be.a('string');
      expect(suggestion.length).to.be.greaterThan(0);
    });

    it('should return null for normal pagination', () => {
      const params = { page: 1, pageSize: 20 };
      const suggestion = selector.getSuggestion(params);
      
      expect(suggestion).to.be.null;
    });
  });

  describe('configuration options', () => {
    it('should use custom offset threshold', () => {
      const customSelector = new PaginationStrategySelector({
        offsetThreshold: 500
      });
      
      const params = { page: 30, pageSize: 20 };  // offset = 580
      const result = customSelector.selectStrategy(params);
      
      expect(result.type).to.equal(PaginationStrategy.CURSOR);
    });

    it('should use custom total estimate threshold', () => {
      const customSelector = new PaginationStrategySelector({
        totalEstimateThreshold: 5000
      });
      
      const params = { page: 1, pageSize: 20 };
      const result = customSelector.selectStrategy(params, 8000);
      
      expect(result.calculateTotal).to.be.false;
    });

    it('should disable estimation', () => {
      const customSelector = new PaginationStrategySelector({
        enableEstimation: false
      });
      
      // estimateTotal should return null when disabled
      // We can't test actual DB connection here, just verify config
      expect(customSelector.enableEstimation).to.be.false;
    });
  });

  describe('factory method', () => {
    it('should create instance using factory method', () => {
      const instance = PaginationStrategySelector.create({
        offsetThreshold: 2000
      });
      
      expect(instance).to.be.instanceOf(PaginationStrategySelector);
      expect(instance.offsetThreshold).to.equal(2000);
    });
  });

  describe('PaginationStrategy enum', () => {
    it('should have OFFSET strategy', () => {
      expect(PaginationStrategy.OFFSET).to.equal('offset');
    });

    it('should have CURSOR strategy', () => {
      expect(PaginationStrategy.CURSOR).to.equal('cursor');
    });
  });
});