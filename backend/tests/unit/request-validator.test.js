'use strict';
/**
 * 请求参数验证中间件单元测试
 * REQ-00307: API 请求参数验证与响应格式一致性中间件系统
 */

const assert = require('assert');
const { z } = require('zod');
const {
  validateBody,
  validateQuery,
  validateParams,
  validate,
  formatZodErrors
} = require('../../shared/middleware/requestValidator');
const { responseFormatter } = require('../../shared/middleware/responseFormatter');

// Mock Express request/response
function mockReq(overrides = {}) {
  return {
    headers: {},
    id: 'req_test_123',
    path: '/api/test',
    method: 'POST',
    body: {},
    query: {},
    params: {},
    ...overrides
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    locals: {},
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

// 测试套件
describe('requestValidator Middleware', function() {
  
  describe('validateBody', function() {
    
    it('should pass valid body', function(done) {
      const schema = z.object({
        name: z.string(),
        age: z.number()
      });
      
      const req = mockReq({ body: { name: 'test', age: 25 } });
      const res = mockRes();
      
      validateBody(schema)(req, res, (err) => {
        assert.ifError(err);
        assert.strictEqual(req.body.name, 'test');
        assert.strictEqual(req.body.age, 25);
        done();
      });
    });
    
    it('should reject invalid body', function(done) {
      const schema = z.object({
        name: z.string(),
        age: z.number()
      });
      
      const req = mockReq({ body: { name: 123, age: 'invalid' } });
      const res = mockRes();
      
      // 先应用 responseFormatter
      responseFormatter(req, res, () => {
        validateBody(schema)(req, res, (err) => {
          // 不应该调用 next，而是返回错误响应
          assert.strictEqual(res.statusCode, 400);
          assert.strictEqual(res.body.success, false);
          assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
          assert.ok(res.body.error.details.length > 0);
          done();
        });
      });
    });
    
    it('should strip unknown fields by default', function(done) {
      const schema = z.object({
        name: z.string()
      });
      
      const req = mockReq({ body: { name: 'test', extra: 'should be removed' } });
      const res = mockRes();
      
      validateBody(schema)(req, res, (err) => {
        assert.ifError(err);
        assert.strictEqual(req.body.name, 'test');
        assert.strictEqual(req.body.extra, undefined);
        done();
      });
    });
    
    it('should return field-level error details', function(done) {
      const schema = z.object({
        email: z.string().email(),
        age: z.number().min(18)
      });
      
      const req = mockReq({ body: { email: 'invalid', age: 10 } });
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        validateBody(schema)(req, res, () => {
          assert.strictEqual(res.body.error.details.length, 2);
          
          const emailError = res.body.error.details.find(d => d.field === 'email');
          assert.ok(emailError);
          
          const ageError = res.body.error.details.find(d => d.field === 'age');
          assert.ok(ageError);
          
          done();
        });
      });
    });
    
    it('should support custom locale', function(done) {
      const schema = z.object({
        age: z.number().min(18)
      });
      
      const req = mockReq({ body: { age: 10 } });
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        validateBody(schema, { locale: 'en-US' })(req, res, () => {
          assert.ok(res.body.error.details[0].message.includes('must be'));
          done();
        });
      });
    });
  });
  
  describe('validateQuery', function() {
    
    it('should pass valid query params', function(done) {
      const schema = z.object({
        page: z.coerce.number(),
        pageSize: z.coerce.number()
      });
      
      const req = mockReq({ query: { page: '1', pageSize: '20' } });
      const res = mockRes();
      
      validateQuery(schema)(req, res, (err) => {
        assert.ifError(err);
        assert.strictEqual(req.query.page, 1);
        assert.strictEqual(req.query.pageSize, 20);
        done();
      });
    });
    
    it('should reject invalid query params', function(done) {
      const schema = z.object({
        page: z.coerce.number().positive()
      });
      
      const req = mockReq({ query: { page: '-1' } });
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        validateQuery(schema)(req, res, () => {
          assert.strictEqual(res.statusCode, 400);
          assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
          done();
        });
      });
    });
  });
  
  describe('validateParams', function() {
    
    it('should pass valid path params', function(done) {
      const schema = z.object({
        id: z.string().regex(/^[0-9a-f]{24}$/)
      });
      
      const req = mockReq({ params: { id: '507f1f77bcf86cd799439011' } });
      const res = mockRes();
      
      validateParams(schema)(req, res, (err) => {
        assert.ifError(err);
        assert.strictEqual(req.params.id, '507f1f77bcf86cd799439011');
        done();
      });
    });
    
    it('should reject invalid path params', function(done) {
      const schema = z.object({
        id: z.string().regex(/^[0-9a-f]{24}$/, { message: 'Invalid ObjectId' })
      });
      
      const req = mockReq({ params: { id: 'invalid' } });
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        validateParams(schema)(req, res, () => {
          assert.strictEqual(res.statusCode, 400);
          done();
        });
      });
    });
  });
  
  describe('validate (combined)', function() {
    
    it('should validate body, query, and params together', function(done) {
      const schemas = {
        body: z.object({ name: z.string() }),
        query: z.object({ page: z.coerce.number().default(1) }),
        params: z.object({ id: z.string() })
      };
      
      const req = mockReq({
        body: { name: 'test' },
        query: { page: '2' },
        params: { id: '123' }
      });
      const res = mockRes();
      
      const middlewares = validate(schemas);
      
      // 依次执行中间件
      let index = 0;
      function runNext(err) {
        if (err) return done(err);
        if (index < middlewares.length) {
          middlewares[index++](req, res, runNext);
        } else {
          assert.strictEqual(req.body.name, 'test');
          assert.strictEqual(req.query.page, 2);
          assert.strictEqual(req.params.id, '123');
          done();
        }
      }
      runNext();
    });
    
    it('should reject on first validation failure', function(done) {
      const schemas = {
        body: z.object({ name: z.string().min(5) }),
        query: z.object({ page: z.coerce.number() })
      };
      
      const req = mockReq({
        body: { name: 'ab' },
        query: { page: '1' }
      });
      const res = mockRes();
      
      responseFormatter(req, res, () => {
        const middlewares = validate(schemas);
        middlewares[0](req, res, () => {
          assert.strictEqual(res.statusCode, 400);
          done();
        });
      });
    });
  });
  
  describe('formatZodErrors', function() {
    
    it('should format Zod error to details array', function() {
      const schema = z.object({
        name: z.string().min(3),
        email: z.string().email()
      });
      
      const result = schema.safeParse({ name: 'ab', email: 'invalid' });
      
      if (!result.success) {
        const details = formatZodErrors(result.error);
        
        assert.ok(Array.isArray(details));
        assert.strictEqual(details.length, 2);
        
        // 检查结构
        for (const detail of details) {
          assert.ok(detail.field);
          assert.ok(detail.message);
          assert.ok(detail.constraint);
        }
      }
    });
    
    it('should handle nested objects', function() {
      const schema = z.object({
        user: z.object({
          profile: z.object({
            age: z.number().min(18)
          })
        })
      });
      
      const result = schema.safeParse({
        user: { profile: { age: 10 } }
      });
      
      if (!result.success) {
        const details = formatZodErrors(result.error);
        
        assert.strictEqual(details[0].field, 'user.profile.age');
      }
    });
    
    it('should handle arrays', function() {
      const schema = z.object({
        items: z.array(z.number().positive())
      });
      
      const result = schema.safeParse({
        items: [1, -5, 3]
      });
      
      if (!result.success) {
        const details = formatZodErrors(result.error);
        
        assert.ok(details.some(d => d.field === 'items.1'));
      }
    });
  });
});

// 运行测试
console.log('requestValidator tests loaded');

module.exports = { mockReq, mockRes };