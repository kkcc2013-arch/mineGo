/**
 * Request Validator 单元测试
 */

'use strict';

const {
  validateRequest,
  ValidationError,
  ValidatorCompiler,
  ValidatorCache,
  body,
  query,
  headers,
  VALIDATOR_TYPES,
  FORMAT_VALIDATORS
} = require('../../../backend/shared/requestValidator');

describe('RequestValidator', () => {
  describe('ValidatorCache', () => {
    test('should cache compiled validators', () => {
      const cache = new ValidatorCache(100);
      const validator = () => true;
      
      cache.set('test-key', validator);
      expect(cache.get('test-key')).toBe(validator);
    });

    test('should enforce max size with LRU eviction', () => {
      const cache = new ValidatorCache(2);
      
      cache.set('key1', () => 1);
      cache.set('key2', () => 2);
      cache.set('key3', () => 3); // Should evict key1
      
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeDefined();
      expect(cache.get('key3')).toBeDefined();
    });

    test('should clear cache', () => {
      const cache = new ValidatorCache();
      cache.set('key', () => true);
      cache.clear();
      expect(cache.get('key')).toBeUndefined();
    });
  });

  describe('ValidatorCompiler', () => {
    let compiler;

    beforeEach(() => {
      compiler = new ValidatorCompiler();
    });

    test('should compile simple string validation', () => {
      const schema = {
        body: {
          username: { type: 'string', required: true }
        }
      };

      const validator = compiler.compile(schema);
      
      // Valid
      expect(validator({ body: { username: 'john' } })).toBeNull();
      
      // Missing required
      expect(validator({ body: {} })).toHaveLength(1);
      
      // Wrong type
      expect(validator({ body: { username: 123 } })).toHaveLength(1);
    });

    test('should compile number range validation', () => {
      const schema = {
        body: {
          age: { type: 'number', min: 1, max: 120, required: true }
        }
      };

      const validator = compiler.compile(schema);
      
      expect(validator({ body: { age: 25 } })).toBeNull();
      expect(validator({ body: { age: 0 } })).toHaveLength(1);
      expect(validator({ body: { age: 150 } })).toHaveLength(1);
    });

    test('should compile format validation', () => {
      const schema = {
        body: {
          email: { type: 'string', format: 'email', required: true }
        }
      };

      const validator = compiler.compile(schema);
      
      expect(validator({ body: { email: 'test@example.com' } })).toBeNull();
      expect(validator({ body: { email: 'invalid-email' } })).toHaveLength(1);
    });

    test('should compile enum validation', () => {
      const schema = {
        body: {
          status: { enum: ['active', 'inactive'], required: true }
        }
      };

      const validator = compiler.compile(schema);
      
      expect(validator({ body: { status: 'active' } })).toBeNull();
      expect(validator({ body: { status: 'unknown' } })).toHaveLength(1);
    });

    test('should compile pattern validation', () => {
      const schema = {
        body: {
          username: { pattern: /^[a-zA-Z0-9_]+$/, required: true }
        }
      };

      const validator = compiler.compile(schema);
      
      expect(validator({ body: { username: 'john_doe' } })).toBeNull();
      expect(validator({ body: { username: 'john@doe' } })).toHaveLength(1);
    });

    test('should compile array validation', () => {
      const schema = {
        body: {
          tags: { type: 'array', minItems: 1, maxItems: 5 }
        }
      };

      const validator = compiler.compile(schema);
      
      expect(validator({ body: { tags: ['tag1', 'tag2'] } })).toBeNull();
      expect(validator({ body: { tags: [] } })).toHaveLength(1);
      expect(validator({ body: { tags: ['1', '2', '3', '4', '5', '6'] } })).toHaveLength(1);
    });

    test('should compile custom validation', () => {
      const schema = {
        body: {
          password: {
            type: 'string',
            validate: (value) => value.length >= 8,
            customMessage: 'Password must be at least 8 characters'
          }
        }
      };

      const validator = compiler.compile(schema);
      
      expect(validator({ body: { password: 'password123' } })).toBeNull();
      expect(validator({ body: { password: 'short' } })).toHaveLength(1);
    });

    test('should validate multiple locations', () => {
      const schema = {
        body: { name: { type: 'string', required: true } },
        query: { page: { type: 'number', min: 1 } },
        headers: { 'x-api-key': { type: 'string', required: true } }
      };

      const validator = compiler.compile(schema);
      
      expect(validator({
        body: { name: 'test' },
        query: { page: 1 },
        headers: { 'x-api-key': 'abc123' }
      })).toBeNull();
    });
  });

  describe('ValidationError', () => {
    test('should create error with details', () => {
      const errors = [
        { field: 'body.email', code: 'INVALID_FORMAT', message: 'Invalid email', received: 'bad' }
      ];

      const error = new ValidationError(errors);
      expect(error.code).toBe(400001);
      expect(error.errors).toHaveLength(1);
    });

    test('should convert to JSON', () => {
      const errors = [
        { field: 'body.age', code: 'INVALID_RANGE', message: 'Out of range', received: 150 }
      ];

      const error = new ValidationError(errors);
      const json = error.toJSON('req-123');

      expect(json.success).toBe(false);
      expect(json.error.code).toBe(400001);
      expect(json.error.details).toHaveLength(1);
      expect(json.meta.requestId).toBe('req-123');
    });
  });

  describe('validateRequest middleware', () => {
    let mockReq, mockRes, mockNext;

    beforeEach(() => {
      mockReq = {
        body: {},
        query: {},
        params: {},
        headers: {},
        method: 'POST',
        path: '/test',
        ip: '127.0.0.1'
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      };
      mockNext = jest.fn();
    });

    test('should pass valid request', () => {
      const middleware = validateRequest({
        body: { name: { type: 'string', required: true } }
      });

      mockReq.body = { name: 'John' };
      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should reject invalid request', () => {
      const middleware = validateRequest({
        body: { name: { type: 'string', required: true } }
      });

      mockReq.body = {};
      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('should validate query parameters', () => {
      const middleware = validateRequest({
        query: { page: { type: 'number', min: 1 } }
      });

      mockReq.query = { page: 0 };
      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('Chain API', () => {
    test('should build validation schema with body()', () => {
      const schema = body()
        .field('email').isEmail().required()
        .field('age').isInt({ min: 1, max: 120 }).optional()
        .build();

      expect(schema.email).toBeDefined();
      expect(schema.email.type).toBe('string');
      expect(schema.email.format).toBe('email');
      expect(schema.email.required).toBe(true);

      expect(schema.age).toBeDefined();
      expect(schema.age.type).toBe('integer');
    });

    test('should build validation schema with query()', () => {
      const schema = query()
        .field('page').isInt({ min: 1 }).default(1)
        .field('limit').isInt({ min: 1, max: 100 }).default(20)
        .build();

      expect(schema.page).toBeDefined();
      expect(schema.page.type).toBe('integer');
      expect(schema.page.default).toBe(1);
    });

    test('should build validation schema with headers()', () => {
      const schema = headers()
        .field('x-api-key').isString().required()
        .field('x-device-id').isString().required()
        .build();

      expect(schema['x-api-key']).toBeDefined();
      expect(schema['x-api-key'].type).toBe('string');
      expect(schema['x-api-key'].required).toBe(true);
    });

    test('should support isArray()', () => {
      const schema = body()
        .field('tags').isArray({ minItems: 1, maxItems: 10 })
        .build();

      expect(schema.tags.type).toBe('array');
      expect(schema.tags.minItems).toBe(1);
      expect(schema.tags.maxItems).toBe(10);
    });

    test('should support isObjectId()', () => {
      const schema = body()
        .field('id').isObjectId().required()
        .build();

      expect(schema.id.type).toBe('string');
      expect(schema.id.format).toBe('objectId');
    });

    test('should support isUrl() and isUuid()', () => {
      const schema = body()
        .field('url').isUrl()
        .field('uuid').isUuid()
        .build();

      expect(schema.url.format).toBe('url');
      expect(schema.uuid.format).toBe('uuid');
    });
  });

  describe('Format validators', () => {
    test('should validate email format', () => {
      expect(FORMAT_VALIDATORS.email.check('test@example.com')).toBe(true);
      expect(FORMAT_VALIDATORS.email.check('invalid')).toBe(false);
    });

    test('should validate URL format', () => {
      expect(FORMAT_VALIDATORS.url.check('https://example.com')).toBe(true);
      expect(FORMAT_VALIDATORS.url.check('not-a-url')).toBe(false);
    });

    test('should validate UUID format', () => {
      expect(FORMAT_VALIDATORS.uuid.check('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(FORMAT_VALIDATORS.uuid.check('not-uuid')).toBe(false);
    });

    test('should validate ObjectId format', () => {
      expect(FORMAT_VALIDATORS.objectId.check('507f1f77bcf86cd799439011')).toBe(true);
      expect(FORMAT_VALIDATORS.objectId.check('invalid')).toBe(false);
    });

    test('should validate latitude and longitude', () => {
      expect(FORMAT_VALIDATORS.lat.check(45.5)).toBe(true);
      expect(FORMAT_VALIDATORS.lat.check(95)).toBe(false);
      
      expect(FORMAT_VALIDATORS.lng.check(-122.3)).toBe(true);
      expect(FORMAT_VALIDATORS.lng.check(185)).toBe(false);
    });

    test('should validate phone format', () => {
      expect(FORMAT_VALIDATORS.phone.check('13800138000')).toBe(true);
      expect(FORMAT_VALIDATORS.phone.check('+8613800138000')).toBe(true);
      expect(FORMAT_VALIDATORS.phone.check('123')).toBe(false);
    });

    test('should validate IP format', () => {
      expect(FORMAT_VALIDATORS.ip.check('192.168.1.1')).toBe(true);
      expect(FORMAT_VALIDATORS.ip.check('2001:db8::1')).toBe(true);
      expect(FORMAT_VALIDATORS.ip.check('invalid')).toBe(false);
    });
  });

  describe('Validator types', () => {
    test('should validate string type', () => {
      expect(VALIDATOR_TYPES.string.check('hello')).toBe(true);
      expect(VALIDATOR_TYPES.string.check(123)).toBe(false);
    });

    test('should validate number type', () => {
      expect(VALIDATOR_TYPES.number.check(123)).toBe(true);
      expect(VALIDATOR_TYPES.number.check(123.45)).toBe(true);
      expect(VALIDATOR_TYPES.number.check('123')).toBe(false);
      expect(VALIDATOR_TYPES.number.check(NaN)).toBe(false);
    });

    test('should validate integer type', () => {
      expect(VALIDATOR_TYPES.integer.check(123)).toBe(true);
      expect(VALIDATOR_TYPES.integer.check(123.45)).toBe(false);
    });

    test('should validate boolean type', () => {
      expect(VALIDATOR_TYPES.boolean.check(true)).toBe(true);
      expect(VALIDATOR_TYPES.boolean.check(false)).toBe(true);
      expect(VALIDATOR_TYPES.boolean.check(1)).toBe(false);
    });

    test('should validate array type', () => {
      expect(VALIDATOR_TYPES.array.check([1, 2, 3])).toBe(true);
      expect(VALIDATOR_TYPES.array.check('array')).toBe(false);
    });

    test('should validate object type', () => {
      expect(VALIDATOR_TYPES.object.check({ key: 'value' })).toBe(true);
      expect(VALIDATOR_TYPES.object.check([1, 2, 3])).toBe(false);
      expect(VALIDATOR_TYPES.object.check(null)).toBe(false);
    });

    test('should validate date type', () => {
      expect(VALIDATOR_TYPES.date.check(new Date())).toBe(true);
      expect(VALIDATOR_TYPES.date.check('2026-07-20')).toBe(true);
      expect(VALIDATOR_TYPES.date.check('invalid-date')).toBe(false);
    });
  });
});
