'use strict';
/**
 * 响应格式化中间件单元测试
 * REQ-00307: API 请求参数验证与响应格式一致性中间件系统
 */

const assert = require('assert');
const { responseFormatter, legacyResponseAdapter } = require('../../shared/middleware/responseFormatter');

// Mock Express request/response
function mockReq() {
  return {
    headers: {},
    id: 'req_test_123',
    path: '/api/test',
    method: 'GET'
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    locals: {},
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    setHeader: function(name, value) {
      this.headers[name] = value;
      return this;
    },
    json: function(data) {
      this.body = data;
      return this;
    },
    send: function() {
      this.body = '';
      return this;
    }
  };
  return res;
}

// 测试套件
describe('responseFormatter Middleware', function() {
  
  describe('apiSuccess', function() {
    it('should return success response with correct format', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiSuccess({ id: 1, name: 'test' });
        
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.success, true);
        assert.deepStrictEqual(res.body.data, { id: 1, name: 'test' });
        assert.ok(res.body.meta.requestId);
        assert.ok(res.body.meta.timestamp);
        assert.ok(res.body.meta.duration >= 0);
        
        done();
      });
    });
    
    it('should return custom status code', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiSuccess({ id: 1 }, { statusCode: 201 });
        
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(res.body.success, true);
        
        done();
      });
    });
    
    it('should include extra metadata', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiSuccess({ id: 1 }, { meta: { version: '1.0' } });
        
        assert.strictEqual(res.body.meta.version, '1.0');
        
        done();
      });
    });
    
    it('should use x-request-id header', function(done) {
      const req = mockReq();
      req.headers['x-request-id'] = 'req_header_123';
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiSuccess({});
        
        assert.strictEqual(res.body.meta.requestId, 'req_header_123');
        
        done();
      });
    });
  });
  
  describe('apiError', function() {
    it('should return error response with correct format', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiError('VALIDATION_ERROR', '参数验证失败', [
          { field: 'name', message: '必填字段' }
        ]);
        
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        assert.strictEqual(res.body.error.message, '参数验证失败');
        assert.deepStrictEqual(res.body.error.details, [
          { field: 'name', message: '必填字段' }
        ]);
        
        done();
      });
    });
    
    it('should return error without details', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiError('NOT_FOUND', '资源不存在');
        
        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.body.error.details, null);
        
        done();
      });
    });
    
    it('should return custom status code', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiError('FORBIDDEN', '无权限', null, { statusCode: 403 });
        
        assert.strictEqual(res.statusCode, 403);
        
        done();
      });
    });
  });
  
  describe('apiPaginated', function() {
    it('should return paginated response with correct format', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiPaginated(
          [{ id: 1 }, { id: 2 }],
          { page: 1, pageSize: 20, total: 50 }
        );
        
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.success, true);
        assert.deepStrictEqual(res.body.data.items, [{ id: 1 }, { id: 2 }]);
        assert.strictEqual(res.body.data.pagination.page, 1);
        assert.strictEqual(res.body.data.pagination.pageSize, 20);
        assert.strictEqual(res.body.data.pagination.total, 50);
        assert.strictEqual(res.body.data.pagination.totalPages, 3);
        assert.strictEqual(res.body.data.pagination.hasNext, true);
        assert.strictEqual(res.body.data.pagination.hasPrev, false);
        
        done();
      });
    });
    
    it('should handle last page correctly', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiPaginated(
          [{ id: 1 }],
          { page: 3, pageSize: 20, total: 50 }
        );
        
        assert.strictEqual(res.body.data.pagination.hasNext, false);
        assert.strictEqual(res.body.data.pagination.hasPrev, true);
        
        done();
      });
    });
  });
  
  describe('apiCreated', function() {
    it('should return created response with status 201', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiCreated({ id: 123 });
        
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.id, 123);
        
        done();
      });
    });
    
    it('should set Location header', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiCreated({ id: 123 }, '/api/pokemon/123');
        
        assert.strictEqual(res.headers['Location'], '/api/pokemon/123');
        
        done();
      });
    });
  });
  
  describe('apiNoContent', function() {
    it('should return 204 status', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiNoContent();
        
        assert.strictEqual(res.statusCode, 204);
        
        done();
      });
    });
  });
  
  describe('apiAccepted', function() {
    it('should return accepted response with status 202', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        res.apiAccepted('task_123', '/api/tasks/123/status');
        
        assert.strictEqual(res.statusCode, 202);
        assert.strictEqual(res.body.data.taskId, 'task_123');
        assert.strictEqual(res.body.data.statusUrl, '/api/tasks/123/status');
        
        done();
      });
    });
  });
  
  describe('legacyResponseAdapter', function() {
    it('should wrap non-standard response', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        legacyResponseAdapter(req, res, () => {
          res.json({ id: 1, name: 'test' });
          
          assert.strictEqual(res.body.success, true);
          assert.deepStrictEqual(res.body.data, { id: 1, name: 'test' });
          
          done();
        });
      });
    });
    
    it('should not wrap already standardized response', function(done) {
      const req = mockReq();
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        legacyResponseAdapter(req, res, () => {
          res.json({
            success: true,
            data: { id: 1 },
            meta: { requestId: 'req_123' }
          });
          
          assert.strictEqual(res.body.success, true);
          assert.deepStrictEqual(res.body.data, { id: 1 });
          
          done();
        });
      });
    });
  });
});

// 运行测试
if (require.main === module) {
  const mocha = require('mocha');
  const runner = new mocha.Runner();
  // 直接运行
}

module.exports = { mockReq, mockRes };