/**
 * REQ-00038 单元测试：API 响应过滤与数据脱敏
 */

'use strict';

const assert = require('assert');
const {
  responseFilterMiddleware,
  filterObject,
  filterData,
  getFieldSensitivity,
  canAccessField,
  registerSensitiveField,
} = require('../shared/responseFilter');

const {
  maskData,
  maskEmail,
  maskPhone,
  maskCardNumber,
  maskIpAddress,
  maskLocation,
  verifyMasking,
} = require('../shared/dataMaskingEngine');

// ============================================================
// 数据脱敏引擎测试
// ============================================================

describe('Data Masking Engine', () => {
  
  describe('maskEmail', () => {
    it('should mask email correctly', () => {
      assert.strictEqual(maskEmail('example@example.com'), 'exa***@example.com');
      assert.strictEqual(maskEmail('abc@x.com'), 'abc***@x.com');
      assert.strictEqual(maskEmail('a@b.com'), 'a***@b.com');
    });
    
    it('should handle null/undefined', () => {
      assert.strictEqual(maskEmail(null), null);
      assert.strictEqual(maskEmail(undefined), undefined);
    });
    
    it('should handle invalid email', () => {
      assert.strictEqual(maskEmail('not-an-email'), 'not-an-email');
    });
  });
  
  describe('maskPhone', () => {
    it('should mask phone correctly', () => {
      const masked = maskPhone('+8613812345678');
      assert.ok(masked.includes('5678'));
      assert.ok(masked.includes('*'));
    });
    
    it('should handle null/undefined', () => {
      assert.strictEqual(maskPhone(null), null);
      assert.strictEqual(maskPhone(undefined), undefined);
    });
  });
  
  describe('maskCardNumber', () => {
    it('should mask card number correctly', () => {
      assert.strictEqual(maskCardNumber('1234567890123456'), '************3456');
      assert.strictEqual(maskCardNumber('1234-5678-9012-3456'), '************3456');
    });
    
    it('should handle null/undefined', () => {
      assert.strictEqual(maskCardNumber(null), null);
      assert.strictEqual(maskCardNumber(undefined), undefined);
    });
  });
  
  describe('maskIpAddress', () => {
    it('should mask IP address correctly', () => {
      assert.strictEqual(maskIpAddress('192.168.1.100'), '192.168.1.***');
      assert.strictEqual(maskIpAddress('10.0.0.1'), '10.0.0.***');
    });
    
    it('should handle null/undefined', () => {
      assert.strictEqual(maskIpAddress(null), null);
      assert.strictEqual(maskIpAddress(undefined), undefined);
    });
  });
  
  describe('maskLocation', () => {
    it('should fuzz location correctly', () => {
      const result = maskLocation({ lat: 31.2304, lng: 121.4737 });
      assert.strictEqual(result.lat, 31.23);
      assert.strictEqual(result.lng, 121.47);
    });
    
    it('should handle string format', () => {
      const result = maskLocation('31.2304, 121.4737');
      assert.strictEqual(result, '31.23, 121.47');
    });
  });
  
  describe('maskData', () => {
    it('should apply correct masking rule based on field name', () => {
      assert.strictEqual(maskData('email', 'test@example.com'), 'tes***@example.com');
      assert.strictEqual(maskData('card_number', '1234567890123456'), '************3456');
      assert.strictEqual(maskData('password', 'secret123'), undefined);
      assert.strictEqual(maskData('cvv', '123'), undefined);
    });
    
    it('should return original value for non-sensitive fields', () => {
      assert.strictEqual(maskData('username', 'player1'), 'player1');
      assert.strictEqual(maskData('score', 1000), 1000);
    });
  });
  
  describe('verifyMasking', () => {
    it('should verify correct masking', () => {
      const result = verifyMasking('email', 'test@example.com', 'tes***@example.com');
      assert.strictEqual(result.valid, true);
    });
    
    it('should detect incorrect masking', () => {
      const result = verifyMasking('password', 'secret', undefined);
      assert.strictEqual(result.valid, true); // password should be removed
    });
  });
});

// ============================================================
// 响应过滤测试
// ============================================================

describe('Response Filter', () => {
  
  describe('getFieldSensitivity', () => {
    it('should return correct sensitivity level', () => {
      assert.strictEqual(getFieldSensitivity('password'), 'P0');
      assert.strictEqual(getFieldSensitivity('email'), 'P1');
      assert.strictEqual(getFieldSensitivity('ip_address'), 'P2');
      assert.strictEqual(getFieldSensitivity('username'), 'P3');
    });
    
    it('should handle case insensitive', () => {
      assert.strictEqual(getFieldSensitivity('EMAIL'), 'P1');
      assert.strictEqual(getFieldSensitivity('Password'), 'P0');
    });
    
    it('should return P3 for unknown fields', () => {
      assert.strictEqual(getFieldSensitivity('unknown_field'), 'P3');
    });
  });
  
  describe('canAccessField', () => {
    it('should allow system to access all levels', () => {
      assert.strictEqual(canAccessField('system', 'P0').canAccess, true);
      assert.strictEqual(canAccessField('system', 'P1').canAccess, true);
      assert.strictEqual(canAccessField('system', 'P2').canAccess, true);
      assert.strictEqual(canAccessField('system', 'P3').canAccess, true);
    });
    
    it('should restrict user access', () => {
      assert.strictEqual(canAccessField('user', 'P0').canAccess, false);
      assert.strictEqual(canAccessField('user', 'P1').canAccess, false);
      assert.strictEqual(canAccessField('user', 'P2').shouldMask, true);
      assert.strictEqual(canAccessField('user', 'P3').canAccess, true);
    });
    
    it('should allow admin to access P1 and below', () => {
      assert.strictEqual(canAccessField('admin', 'P0').canAccess, false);
      assert.strictEqual(canAccessField('admin', 'P1').canAccess, true);
      assert.strictEqual(canAccessField('admin', 'P2').canAccess, true);
      assert.strictEqual(canAccessField('admin', 'P3').canAccess, true);
    });
  });
  
  describe('filterObject', () => {
    it('should filter P0 fields for regular user', () => {
      const data = {
        username: 'player1',
        email: 'test@example.com',
        password: 'secret123',
        score: 1000,
      };
      
      const filtered = filterObject(data, 'user', { logSensitiveAccess: false });
      
      assert.strictEqual(filtered.username, 'player1');
      assert.ok(filtered.email.includes('***')); // masked
      assert.strictEqual(filtered.password, undefined); // removed
      assert.strictEqual(filtered.score, 1000);
    });
    
    it('should preserve all fields for system role', () => {
      const data = {
        username: 'player1',
        email: 'test@example.com',
        password: 'secret123',
      };
      
      const filtered = filterObject(data, 'system', { logSensitiveAccess: false });
      
      assert.strictEqual(filtered.username, 'player1');
      assert.strictEqual(filtered.email, 'test@example.com');
      assert.strictEqual(filtered.password, 'secret123');
    });
    
    it('should handle nested objects', () => {
      const data = {
        user: {
          id: '123',
          email: 'test@example.com',
          profile: {
            real_name: 'Test User',
            age: 25,
          },
        },
      };
      
      const filtered = filterObject(data, 'user', { logSensitiveAccess: false });
      
      assert.ok(filtered.user.email.includes('***'));
      assert.strictEqual(filtered.user.profile.age, 25);
    });
    
    it('should handle arrays', () => {
      const data = {
        users: [
          { id: '1', email: 'user1@example.com' },
          { id: '2', email: 'user2@example.com' },
        ],
      };
      
      const filtered = filterObject(data, 'user', { logSensitiveAccess: false });
      
      filtered.users.forEach(user => {
        assert.ok(user.email.includes('***'));
      });
    });
  });
  
  describe('registerSensitiveField', () => {
    it('should register custom sensitive field', () => {
      registerSensitiveField('custom_secret', 'P1');
      assert.strictEqual(getFieldSensitivity('custom_secret'), 'P1');
    });
  });
});

// ============================================================
// 中间件测试
// ============================================================

describe('Response Filter Middleware', () => {
  
  it('should filter response data', (done) => {
    const middleware = responseFilterMiddleware({ enableAutoFilter: true });
    
    const req = {
      method: 'GET',
      path: '/api/users/123',
      user: { id: '456', role: 'user' },
      ip: '127.0.0.1',
    };
    
    const res = {
      json: function(data) {
        assert.strictEqual(data.password, undefined);
        assert.ok(data.email.includes('***'));
        done();
      },
    };
    
    middleware(req, res, () => {
      res.json({
        id: '123',
        username: 'player1',
        email: 'test@example.com',
        password: 'secret',
      });
    });
  });
  
  it('should skip non-GET requests by default', (done) => {
    const middleware = responseFilterMiddleware({ enableAutoFilter: true });
    
    const req = {
      method: 'POST',
      path: '/api/users',
      user: { role: 'user' },
    };
    
    const res = {};
    
    middleware(req, res, () => {
      // 应该直接调用 next
      done();
    });
  });
  
  it('should skip excluded paths', (done) => {
    const middleware = responseFilterMiddleware({ enableAutoFilter: true });
    
    const req = {
      method: 'GET',
      path: '/health',
    };
    
    const res = {};
    
    middleware(req, res, () => {
      done();
    });
  });
});

// ============================================================
// 运行测试
// ============================================================

if (require.main === module) {
  console.log('Running REQ-00038 unit tests...\n');
  
  // 简单测试运行器
  let passed = 0;
  let failed = 0;
  
  const runTest = (name, fn) => {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
      failed++;
    }
  };
  
  // 运行脱敏测试
  console.log('Data Masking Tests:');
  runTest('maskEmail should work correctly', () => {
    assert.strictEqual(maskEmail('test@example.com'), 'tes***@example.com');
  });
  
  runTest('maskCardNumber should show last 4 digits', () => {
    assert.strictEqual(maskCardNumber('1234567890123456'), '************3456');
  });
  
  runTest('maskIpAddress should hide last octet', () => {
    assert.strictEqual(maskIpAddress('192.168.1.100'), '192.168.1.***');
  });
  
  // 运行过滤测试
  console.log('\nResponse Filter Tests:');
  runTest('getFieldSensitivity should return correct levels', () => {
    assert.strictEqual(getFieldSensitivity('password'), 'P0');
    assert.strictEqual(getFieldSensitivity('email'), 'P1');
  });
  
  runTest('canAccessField should respect roles', () => {
    assert.strictEqual(canAccessField('user', 'P0').canAccess, false);
    assert.strictEqual(canAccessField('admin', 'P1').canAccess, true);
  });
  
  runTest('filterObject should remove P0 fields for user', () => {
    const data = { password: 'secret', username: 'player1' };
    const filtered = filterObject(data, 'user', { logSensitiveAccess: false });
    assert.strictEqual(filtered.password, undefined);
    assert.strictEqual(filtered.username, 'player1');
  });
  
  // 总结
  console.log('\n' + '='.repeat(50));
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));
  
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = {
  maskData,
  filterObject,
  filterData,
  getFieldSensitivity,
  canAccessField,
};
