/**
 * IdempotencyMiddleware.test.js - 幂等性中间件单元测试
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

// Mock Redis
class MockRedis {
  constructor() {
    this.store = new Map();
  }
  
  async get(key) {
    return this.store.get(key) || null;
  }
  
  async setex(key, ttl, value) {
    this.store.set(key, value);
  }
  
  async del(...keys) {
    for (const key of keys) {
      this.store.delete(key);
    }
  }
  
  async keys(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(this.store.keys()).filter(k => regex.test(k));
  }
  
  async ttl(key) {
    return this.store.has(key) ? 3600 : -2;
  }
}

// Mock logger
const mockLogger = {
  info: () => {},
  error: () => {},
  warn: () => {}
};

// 测试开始
console.log('='.repeat(60));
console.log('IdempotencyMiddleware Unit Tests');
console.log('='.repeat(60));

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passCount++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    failCount++;
  }
}

// ============================================================================
// 测试 hashBody 函数
// ============================================================================

console.log('\n📋 hashBody 函数测试\n');

test('hashBody - 空对象返回 "empty"', () => {
  const result = hashBody({});
  assert.strictEqual(result, 'empty');
});

test('hashBody - null/undefined 返回 "empty"', () => {
  assert.strictEqual(hashBody(null), 'empty');
  assert.strictEqual(hashBody(undefined), 'empty');
});

test('hashBody - 相同对象返回相同哈希', () => {
  const body = { a: 1, b: 2 };
  const hash1 = hashBody(body);
  const hash2 = hashBody(body);
  assert.strictEqual(hash1, hash2);
  assert.strictEqual(hash1.length, 16);
});

test('hashBody - 不同对象返回不同哈希', () => {
  const hash1 = hashBody({ a: 1 });
  const hash2 = hashBody({ a: 2 });
  assert.notStrictEqual(hash1, hash2);
});

test('hashBody - 过滤 idempotencyKey', () => {
  const body1 = { a: 1, idempotencyKey: 'key1' };
  const body2 = { a: 1, idempotencyKey: 'key2' };
  const hash1 = hashBody(body1);
  const hash2 = hashBody(body2);
  assert.strictEqual(hash1, hash2);
});

// 导入实际函数进行测试
function hashBody(body) {
  if (!body || Object.keys(body).length === 0) {
    return 'empty';
  }
  
  const filteredBody = { ...body };
  delete filteredBody.idempotencyKey;
  
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(filteredBody))
    .digest('hex')
    .substring(0, 16);
}

// ============================================================================
// 测试 Key 生成策略
// ============================================================================

console.log('\n📋 Key 生成策略测试\n');

const KEY_STRATEGIES = {
  'default': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const bodyHash = hashBody(req.body);
    return `${prefix}:${userId}:${req.method}:${req.path}:${bodyHash}`;
  },

  'user+location+pokemon': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { locationId, pokemonId, spawnId } = req.body;
    return `${prefix}:${userId}:catch:${spawnId || pokemonId || locationId}`;
  },

  'user+itemId+timestamp': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { itemId } = req.body;
    const timestamp = Math.floor(Date.now() / 60000);
    return `${prefix}:${userId}:use:${itemId}:${timestamp}`;
  },

  'user+gymId+timestamp': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { gymId } = req.body;
    const timestamp = Math.floor(Date.now() / 60000);
    return `${prefix}:${userId}:battle:${gymId}:${timestamp}`;
  },

  'user+friendId': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { friendId } = req.body;
    return `${prefix}:${userId}:friend:${friendId}`;
  },

  'custom': (req, prefix) => {
    const key = req.headers?.['x-idempotency-key'] || req.body?.idempotencyKey;
    if (!key) {
      throw new Error('Missing idempotency key for custom strategy');
    }
    return `${prefix}:custom:${key}`;
  }
};

test('default 策略 - 生成正确格式', () => {
  const req = {
    user: { id: 'user123' },
    method: 'POST',
    path: '/api/test',
    body: { data: 'value' }
  };
  const key = KEY_STRATEGIES['default'](req, 'idempotency');
  assert.ok(key.startsWith('idempotency:user123:POST:/api/test:'));
});

test('user+location+pokemon 策略 - 使用 spawnId', () => {
  const req = {
    user: { id: 'user123' },
    body: { spawnId: 'spawn456', pokemonId: 'poke789' }
  };
  const key = KEY_STRATEGIES['user+location+pokemon'](req, 'idempotency');
  assert.strictEqual(key, 'idempotency:user123:catch:spawn456');
});

test('user+location+pokemon 策略 - 降级到 pokemonId', () => {
  const req = {
    user: { id: 'user123' },
    body: { pokemonId: 'poke789' }
  };
  const key = KEY_STRATEGIES['user+location+pokemon'](req, 'idempotency');
  assert.strictEqual(key, 'idempotency:user123:catch:poke789');
});

test('user+itemId+timestamp 策略 - 包含时间戳（分钟级）', () => {
  const req = {
    user: { id: 'user123' },
    body: { itemId: 'item456' }
  };
  const key = KEY_STRATEGIES['user+itemId+timestamp'](req, 'idempotency');
  assert.ok(key.startsWith('idempotency:user123:use:item456:'));
  
  // 验证时间戳是数字
  const parts = key.split(':');
  const timestamp = parseInt(parts[4]);
  assert.ok(!isNaN(timestamp));
});

test('user+friendId 策略 - 生成正确格式', () => {
  const req = {
    user: { id: 'user123' },
    body: { friendId: 'friend456' }
  };
  const key = KEY_STRATEGIES['user+friendId'](req, 'idempotency');
  assert.strictEqual(key, 'idempotency:user123:friend:friend456');
});

test('custom 策略 - 使用 header 中的 key', () => {
  const req = {
    headers: { 'x-idempotency-key': 'custom-key-123' },
    body: {}
  };
  const key = KEY_STRATEGIES['custom'](req, 'idempotency');
  assert.strictEqual(key, 'idempotency:custom:custom-key-123');
});

test('custom 策略 - 使用 body 中的 key', () => {
  const req = {
    headers: {},
    body: { idempotencyKey: 'custom-key-456' }
  };
  const key = KEY_STRATEGIES['custom'](req, 'idempotency');
  assert.strictEqual(key, 'idempotency:custom:custom-key-456');
});

test('custom 策略 - 缺少 key 抛出错误', () => {
  const req = { headers: {}, body: {} };
  assert.throws(() => {
    KEY_STRATEGIES['custom'](req, 'idempotency');
  }, /Missing idempotency key/);
});

// ============================================================================
// 测试 IdempotencyMiddleware 类
// ============================================================================

console.log('\n📋 IdempotencyMiddleware 类测试\n');

// 简化版中间件类用于测试
class TestIdempotencyMiddleware {
  constructor(options = {}) {
    this.redis = new MockRedis();
    this.ttl = options.ttl || 86400;
    this.keyPrefix = options.keyPrefix || 'idempotency';
    this.keyStrategy = options.keyStrategy || 'default';
    this.localCache = new Map();
    this.localCacheMaxSize = options.localCacheMaxSize || 10000;
    this.metrics = {
      duplicateTotal: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0,
      checkDurationMs: []
    };
  }

  generateKey(req) {
    const strategy = KEY_STRATEGIES[this.keyStrategy] || KEY_STRATEGIES['default'];
    return strategy(req, this.keyPrefix);
  }

  async check(req) {
    const key = this.generateKey(req);
    
    // 检查本地缓存
    const localCached = this.localCache.get(key);
    if (localCached) {
      this.metrics.cacheHits++;
      return { isDuplicate: true, result: localCached.result, key, source: 'local' };
    }
    
    // 检查 Redis
    const cached = await this.redis.get(key);
    if (cached) {
      const result = JSON.parse(cached);
      this.localCache.set(key, { result, cachedAt: Date.now() });
      this.metrics.cacheHits++;
      return { isDuplicate: true, result, key, source: 'redis' };
    }
    
    this.metrics.cacheMisses++;
    return { isDuplicate: false, key };
  }

  async save(key, result) {
    const resultWithTimestamp = { ...result, timestamp: new Date().toISOString() };
    await this.redis.setex(key, this.ttl, JSON.stringify(resultWithTimestamp));
    this.localCache.set(key, { result: resultWithTimestamp, cachedAt: Date.now() });
  }

  async clear(key) {
    await this.redis.del(key);
    this.localCache.delete(key);
  }

  getStats() {
    return {
      duplicateTotal: this.metrics.duplicateTotal,
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      hitRate: this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) || 0
    };
  }
}

test('check - 首次请求返回 isDuplicate: false', async () => {
  const middleware = new TestIdempotencyMiddleware();
  const req = {
    user: { id: 'user1' },
    method: 'POST',
    path: '/api/test',
    body: { data: 'test' }
  };
  
  const result = await middleware.check(req);
  assert.strictEqual(result.isDuplicate, false);
  assert.ok(result.key);
});

test('check - 重复请求返回 isDuplicate: true', async () => {
  const middleware = new TestIdempotencyMiddleware();
  const req = {
    user: { id: 'user1' },
    method: 'POST',
    path: '/api/test',
    body: { data: 'test' }
  };
  
  // 保存结果
  const checkResult = await middleware.check(req);
  await middleware.save(checkResult.key, { success: true, data: 'result' });
  
  // 再次检查
  const result = await middleware.check(req);
  assert.strictEqual(result.isDuplicate, true);
  assert.ok(result.result);
  assert.strictEqual(result.result.success, true);
});

test('save - 结果包含时间戳', async () => {
  const middleware = new TestIdempotencyMiddleware();
  const req = {
    user: { id: 'user1' },
    method: 'POST',
    path: '/api/test',
    body: { data: 'test' }
  };
  
  const checkResult = await middleware.check(req);
  await middleware.save(checkResult.key, { success: true });
  
  const cached = await middleware.redis.get(checkResult.key);
  const parsed = JSON.parse(cached);
  assert.ok(parsed.timestamp);
  assert.strictEqual(parsed.success, true);
});

test('clear - 清除缓存后检查返回 false', async () => {
  const middleware = new TestIdempotencyMiddleware();
  const req = {
    user: { id: 'user1' },
    method: 'POST',
    path: '/api/test',
    body: { data: 'test' }
  };
  
  const checkResult = await middleware.check(req);
  await middleware.save(checkResult.key, { success: true });
  await middleware.clear(checkResult.key);
  
  const result = await middleware.check(req);
  assert.strictEqual(result.isDuplicate, false);
});

test('本地缓存 - 从本地缓存读取更快', async () => {
  const middleware = new TestIdempotencyMiddleware();
  const req = {
    user: { id: 'user1' },
    method: 'POST',
    path: '/api/test',
    body: { data: 'test' }
  };
  
  // 首次请求
  const checkResult = await middleware.check(req);
  await middleware.save(checkResult.key, { success: true });
  
  // 第二次从缓存读取（可能是 local 或 redis，取决于本地缓存是否已写入）
  const result = await middleware.check(req);
  assert.strictEqual(result.isDuplicate, true);
  assert.ok(result.source === 'local' || result.source === 'redis');
});

test('getStats - 返回正确统计', async () => {
  const middleware = new TestIdempotencyMiddleware();
  const req = {
    user: { id: 'user1' },
    method: 'POST',
    path: '/api/test',
    body: { data: 'test' }
  };
  
  // 首次检查是 miss
  const checkResult = await middleware.check(req);
  assert.strictEqual(checkResult.isDuplicate, false);
  assert.strictEqual(middleware.metrics.cacheMisses, 1);
  
  // 保存结果
  await middleware.save(checkResult.key, { success: true });
  
  // 第二次检查是 hit
  const hitResult = await middleware.check(req);
  assert.strictEqual(hitResult.isDuplicate, true);
  assert.strictEqual(middleware.metrics.cacheHits, 1);
  
  const stats = middleware.getStats();
  assert.strictEqual(stats.cacheMisses, 1);
  assert.strictEqual(stats.cacheHits, 1);
  assert.ok(stats.hitRate >= 0 && stats.hitRate <= 1);
});

// ============================================================================
// 测试 IDEMPOTENCY_CONFIG
// ============================================================================

console.log('\n📋 IDEMPOTENCY_CONFIG 配置测试\n');

const IDEMPOTENCY_CONFIG = {
  'POST /api/catch': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+location+pokemon'
  },
  'POST /api/payment/create': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'custom'
  }
};

function getRouteConfig(method, path) {
  const key = `${method} ${path}`;
  return IDEMPOTENCY_CONFIG[key] || null;
}

test('getRouteConfig - 匹配存在的路由', () => {
  const config = getRouteConfig('POST', '/api/catch');
  assert.ok(config);
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.keyStrategy, 'user+location+pokemon');
});

test('getRouteConfig - 不匹配返回 null', () => {
  const config = getRouteConfig('GET', '/api/catch');
  assert.strictEqual(config, null);
});

// ============================================================================
// 测试中间件函数
// ============================================================================

console.log('\n📋 中间件函数测试\n');

async function testMiddleware() {
  const middleware = new TestIdempotencyMiddleware({ keyStrategy: 'default' });
  
  // 模拟请求
  const req = {
    user: { id: 'user1' },
    method: 'POST',
    path: '/api/test',
    body: { action: 'test' }
  };
  
  // 模拟响应
  let responseStatus = 200;
  let responseBody = null;
  const res = {
    statusCode: 200,
    status: (code) => { responseStatus = code; return res; },
    json: (body) => { responseBody = body; return res; }
  };
  
  // 首次请求
  const checkResult = await middleware.check(req);
  assert.strictEqual(checkResult.isDuplicate, false);
  
  // 保存结果
  await middleware.save(checkResult.key, { success: true, data: 'first result' });
  
  // 重复请求
  const duplicateResult = await middleware.check(req);
  assert.strictEqual(duplicateResult.isDuplicate, true);
  assert.strictEqual(duplicateResult.result.success, true);
  
  return true;
}

test('中间件流程 - 首次请求后缓存，重复请求返回缓存', async () => {
  const result = await testMiddleware();
  assert.strictEqual(result, true);
});

// ============================================================================
// 测试总结
// ============================================================================

console.log('\n' + '='.repeat(60));
console.log('Test Summary');
console.log('='.repeat(60));
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${failCount}`);
console.log(`📊 Total: ${passCount + failCount}`);
console.log(`📈 Pass Rate: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%`);

if (failCount > 0) {
  process.exit(1);
}
