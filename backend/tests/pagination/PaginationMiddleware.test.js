/**
 * 分页中间件单元测试
 * 
 * @module PaginationMiddleware.test
 */

const PaginationMiddleware = require('../shared/pagination/PaginationMiddleware');
const { expect } = require('chai');

describe('PaginationMiddleware', () => {
  let middleware;
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    middleware = new PaginationMiddleware({
      defaultPageSize: 20,
      maxPageSize: 100,
      cursorThreshold: 1000
    });
    
    mockReq = {
      query: {},
      requestId: 'test-req-123',
      path: '/api/test'
    };
    
    mockRes = {
      json: (data) => data
    };
    
    mockNext = () => {};
  });

  describe('parsePaginationParams', () => {
    it('should parse default pagination values', () => {
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination).to.exist;
      expect(mockReq.pagination.page).to.equal(1);
      expect(mockReq.pagination.pageSize).to.equal(20);
      expect(mockReq.pagination.cursor).to.be.null;
      expect(mockReq.pagination.direction).to.equal('next');
    });

    it('should parse custom page values', () => {
      mockReq.query = { page: '5', pageSize: '50' };
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination.page).to.equal(5);
      expect(mockReq.pagination.pageSize).to.equal(50);
      expect(mockReq.pagination.offset).to.equal(200);  // (5-1) * 50
    });

    it('should enforce maxPageSize limit', () => {
      mockReq.query = { pageSize: '150' };
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination.pageSize).to.equal(100);  // capped at max
    });

    it('should handle negative page values', () => {
      mockReq.query = { page: '-1' };
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination.page).to.equal(1);  // defaults to 1
    });

    it('should parse cursor parameter', () => {
      mockReq.query = { cursor: 'eyJpZCI6MTAwfQ==' };
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination.cursor).to.equal('eyJpZCI6MTAwfQ==');
      expect(mockReq.pagination.offset).to.be.undefined;
    });

    it('should parse direction parameter', () => {
      mockReq.query = { direction: 'prev' };
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination.direction).to.equal('prev');
    });

    it('should support parameter aliases', () => {
      mockReq.query = { limit: '30', p: '2' };
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination.pageSize).to.equal(30);
      expect(mockReq.pagination.page).to.equal(2);
    });

    it('should suggest cursor for large offsets', () => {
      mockReq.query = { page: '100', pageSize: '20' };
      middleware.parsePaginationParams(mockReq, mockRes, mockNext);
      
      expect(mockReq.pagination.offset).to.equal(1980);
      expect(mockReq.pagination.cursorSuggested).to.be.true;
    });
  });

  describe('wrapPaginatedResponse', () => {
    it('should wrap response with pagination metadata', () => {
      mockReq.pagination = {
        page: 1,
        pageSize: 20,
        cursor: null
      };
      
      middleware.wrapPaginatedResponse(mockReq, mockRes, mockNext);
      
      const result = mockRes.json({
        success: true,
        data: Array(20).fill({ id: 1 })
      });
      
      expect(result.meta.pagination).to.exist;
      expect(result.meta.pagination.type).to.equal('offset');
      expect(result.meta.pagination.page).to.equal(1);
      expect(result.meta.pagination.pageSize).to.equal(20);
      expect(result.meta.pagination.hasNext).to.be.true;
      expect(result.meta.pagination.hasPrev).to.be.false;
    });

    it('should not wrap non-pagination responses', () => {
      mockReq.pagination = null;
      
      middleware.wrapPaginatedResponse(mockReq, mockRes, mockNext);
      
      const result = mockRes.json({
        success: true,
        data: { id: 1, name: 'test' }
      });
      
      expect(result.meta?.pagination).to.not.exist;
    });

    it('should use paginationResult when set', () => {
      mockReq.pagination = { page: 1, pageSize: 20 };
      mockReq.paginationResult = {
        type: 'cursor',
        hasNext: true,
        hasPrev: false,
        nextCursor: 'abc123',
        prevCursor: null
      };
      
      middleware.wrapPaginatedResponse(mockReq, mockRes, mockNext);
      
      const result = mockRes.json({
        success: true,
        data: Array(20).fill({ id: 1 })
      });
      
      expect(result.meta.pagination.type).to.equal('cursor');
      expect(result.meta.pagination.nextCursor).to.equal('abc123');
    });
  });

  describe('setPaginationResult', () => {
    it('should set pagination result correctly', () => {
      mockReq.pagination = { page: 1, pageSize: 20 };
      
      middleware.setPaginationResult(mockReq, {
        items: Array(20).fill({ id: 1 }),
        total: 100,
        hasNext: true,
        hasPrev: false,
        type: 'offset'
      });
      
      expect(mockReq.paginationResult).to.exist;
      expect(mockReq.paginationResult.total).to.equal(100);
      expect(mockReq.paginationResult.hasNext).to.be.true;
    });
  });

  describe('factory method', () => {
    it('should create middleware instance', () => {
      const result = PaginationMiddleware.create({
        defaultPageSize: 25
      });
      
      expect(result.parseParams).to.be.a('function');
      expect(result.wrapResponse).to.be.a('function');
      expect(result.instance).to.be.instanceOf(PaginationMiddleware);
      expect(result.instance.defaultPageSize).to.equal(25);
    });
  });
});