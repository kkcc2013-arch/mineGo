// tests/unit/jwt-blacklist.test.js - JWT Blacklist Unit Tests
'use strict';

const assert = require('assert');

// Mock Redis client
class MockRedis {
  constructor() {
    this.data = new Map();
    this.sets = new Map();
    this.hashes = new Map();
  }

  async get(key) {
    return this.data.get(key) || null;
  }

  async setex(key, ttl, value) {
    this.data.set(key, value);
    return 'OK';
  }

  async exists(key) {
    return this.data.has(key) ? 1 : 0;
  }

  async del(key) {
    this.data.delete(key);
    return 1;
  }

  async sadd(key, ...members) {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set());
    }
    const set = this.sets.get(key);
    members.forEach(m => set.add(m));
    return members.length;
  }

  async smembers(key) {
    return Array.from(this.sets.get(key) || []);
  }

  async srem(key, ...members) {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    members.forEach(m => {
      if (set.delete(m)) removed++;
    });
    return removed;
  }

  async hset(key, ...args) {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, {});
    }
    const hash = this.hashes.get(key);
    for (let i = 0; i < args.length; i += 2) {
      hash[args[i]] = args[i + 1];
    }
    return 1;
  }

  async hget(key, field) {
    const hash = this.hashes.get(key);
    return hash?.[field] || null;
  }

  async hgetall(key) {
    return this.hashes.get(key) || {};
  }

  async hdel(key, ...fields) {
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let deleted = 0;
    fields.forEach(f => {
      if (delete hash[f]) deleted++;
    });
    return deleted;
  }

  async expire(key, ttl) {
    return 1;
  }

  multi() {
    const self = this;
    const commands = [];
    
    return {
      setex(key, ttl, value) {
        commands.push(['setex', key, ttl, value]);
        return this;
      },
      sadd(key, ...members) {
        commands.push(['sadd', key, ...members]);
        return this;
      },
      hset(key, ...args) {
        commands.push(['hset', key, ...args]);
        return this;
      },
      hdel(key, ...fields) {
        commands.push(['hdel', key, ...fields]);
        return this;
      },
      expire(key, ttl) {
        commands.push(['expire', key, ttl]);
        return this;
      },
      async exec() {
        for (const cmd of commands) {
          const [op, ...args] = cmd;
          if (op === 'setex') {
            await self.setex(args[0], args[1], args[2]);
          } else if (op === 'sadd') {
            await self.sadd(args[0], ...args.slice(1));
          } else if (op === 'hset') {
            await self.hset(args[0], ...args.slice(1));
          } else if (op === 'hdel') {
            await self.hdel(args[0], ...args.slice(1));
          } else if (op === 'expire') {
            await self.expire(args[0], args[1]);
          }
        }
        return commands.map(() => null);
      }
    };
  }

  async scan(cursor, ...args) {
    // Simple implementation for testing
    const keys = Array.from(this.sets.keys());
    if (cursor === '0') {
      return ['0', keys.slice(0, 10)];
    }
    return ['0', []];
  }
}

// Test JwtBlacklist
async function testJwtBlacklist() {
  console.log('Testing JwtBlacklist...\n');
  
  const { JwtBlacklist } = require('../../shared/JwtBlacklist');
  const redis = new MockRedis();
  const blacklist = new JwtBlacklist(redis);
  
  let passed = 0;
  let failed = 0;
  
  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
      failed++;
    }
  }
  
  async function asyncTest(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
      failed++;
    }
  }
  
  // Test 1: isBlacklisted returns false for non-blacklisted token
  await asyncTest('isBlacklisted returns false for non-blacklisted token', async () => {
    const result = await blacklist.isBlacklisted('non-existent-jti');
    assert.strictEqual(result, false);
  });
  
  // Test 2: revokeToken adds token to blacklist
  await asyncTest('revokeToken adds token to blacklist', async () => {
    const jti = 'test-jti-1';
    const userId = 'user-123';
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    
    await blacklist.revokeToken(jti, userId, expiresAt, { reason: 'logout' });
    
    const isBlacklisted = await blacklist.isBlacklisted(jti);
    assert.strictEqual(isBlacklisted, true);
  });
  
  // Test 3: registerSession stores session info
  await asyncTest('registerSession stores session info', async () => {
    const jti = 'test-jti-2';
    const userId = 'user-123';
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    
    await blacklist.registerSession(jti, userId, expiresAt, {
      deviceName: 'iPhone 15',
      deviceType: 'mobile',
      ip: '192.168.1.1'
    });
    
    const sessions = await blacklist.getActiveSessions(userId);
    const session = sessions.find(s => s.jti === jti);
    assert.ok(session);
    assert.strictEqual(session.deviceName, 'iPhone 15');
  });
  
  // Test 4: getActiveSessions returns only active sessions
  await asyncTest('getActiveSessions returns only active sessions', async () => {
    const userId = 'user-456';
    const jti1 = 'active-jti';
    const jti2 = 'blacklisted-jti';
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    
    // Register two sessions
    await blacklist.registerSession(jti1, userId, expiresAt, { deviceName: 'Device 1' });
    await blacklist.registerSession(jti2, userId, expiresAt, { deviceName: 'Device 2' });
    
    // Blacklist one
    await blacklist.revokeToken(jti2, userId, expiresAt, { reason: 'force_logout' });
    
    const sessions = await blacklist.getActiveSessions(userId);
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].jti, jti1);
  });
  
  // Test 5: revokeAllTokens revokes all except current
  await asyncTest('revokeAllTokens revokes all except current', async () => {
    const userId = 'user-789';
    const jti1 = 'token-1';
    const jti2 = 'token-2';
    const jti3 = 'current-token';
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    
    // Register three sessions
    await blacklist.registerSession(jti1, userId, expiresAt, {});
    await blacklist.registerSession(jti2, userId, expiresAt, {});
    await blacklist.registerSession(jti3, userId, expiresAt, {});
    
    // Revoke all except current
    const count = await blacklist.revokeAllTokens(userId, jti3, 'password_change');
    
    assert.strictEqual(count, 2);
    
    // Verify current token is still valid
    const isCurrentBlacklisted = await blacklist.isBlacklisted(jti3);
    assert.strictEqual(isCurrentBlacklisted, false);
    
    // Verify other tokens are blacklisted
    const isJti1Blacklisted = await blacklist.isBlacklisted(jti1);
    const isJti2Blacklisted = await blacklist.isBlacklisted(jti2);
    assert.strictEqual(isJti1Blacklisted, true);
    assert.strictEqual(isJti2Blacklisted, true);
  });
  
  // Test 6: revokeSession revokes specific session
  await asyncTest('revokeSession revokes specific session', async () => {
    const userId = 'user-999';
    const jti = 'session-to-revoke';
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    
    await blacklist.registerSession(jti, userId, expiresAt, { deviceName: 'Test Device' });
    
    await blacklist.revokeSession(jti, userId, 'force_logout');
    
    const isBlacklisted = await blacklist.isBlacklisted(jti);
    assert.strictEqual(isBlacklisted, true);
  });
  
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

// Run tests
testJwtBlacklist()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
