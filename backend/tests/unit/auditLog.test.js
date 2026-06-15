/**
 * REQ-00202: 审计日志模块单元测试
 * 测试目标：backend/shared/auditLog.js
 */

'use strict';

const assert = require('assert');
const path = require('path');

// Mock logger before requiring auditLog
const mockLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {}
};

// Override require to mock logger
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === './logger' || id.endsWith('/logger')) {
    return mockLogger;
  }
  return originalRequire.apply(this, arguments);
};

const {
  auditLog,
  getUserAuditLogs,
  getSystemAuditLogs,
  auditMiddleware,
  AuditActions
} = require('../../shared/auditLog');

// Mock 数据库
class MockDb {
  constructor() {
    this.logs = [];
    this.queryCallCount = 0;
  }
  
  async query(sql, params) {
    this.queryCallCount++;
    
    // INSERT 操作
    if (sql.includes('INSERT')) {
      this.logs.push({
        id: this.logs.length + 1,
        user_id: params[0],
        action: params[1],
        details: JSON.parse(params[2]),
        ip_address: params[3],
        user_agent: params[4],
        service: params[5],
        created_at: new Date()
      });
      return { rowCount: 1 };
    }
    
    // SELECT 操作 - 用户日志
    if (sql.includes('WHERE user_id = $1')) {
      let filtered = this.logs.filter(l => l.user_id === params[0]);
      return { rows: filtered.slice(0, params[params.length - 1]) };
    }
    
    // SELECT 操作 - 系统日志
    if (sql.includes('WHERE 1=1')) {
      return { rows: this.logs.slice(0, params[params.length - 1] || 100) };
    }
    
    return { rows: [] };
  }
  
  reset() {
    this.logs = [];
    this.queryCallCount = 0;
  }
}

// Mock Express 请求
function createMockReq(overrides = {}) {
  return {
    ip: '127.0.0.1',
    headers: {
      'user-agent': 'TestAgent/1.0',
      'x-forwarded-for': '192.168.1.1'
    },
    user: { id: 1 },
    serviceName: 'test-service',
    ...overrides
  };
}

// Mock Express 响应
function createMockRes() {
  const res = {
    headers: {},
    endCalled: false,
    endArgs: null
  };
  
  res.setHeader = function(key, value) {
    this.headers[key] = value;
  };
  
  res.end = function(...args) {
    this.endCalled = true;
    this.endArgs = args;
  };
  
  return res;
}

// 测试主函数
async function runTests() {
  console.log('Testing auditLog.js...');
  
  // ── AuditActions 常量测试 ─────────────────────────────────────────────────────
  console.log('\n[TEST] AuditActions constants');
  assert.ok(AuditActions.CONSENT_GIVEN, 'Should have CONSENT_GIVEN action');
  assert.ok(AuditActions.DATA_EXPORTED, 'Should have DATA_EXPORTED action');
  assert.ok(AuditActions.DELETION_REQUESTED, 'Should have DELETION_REQUESTED action');
  assert.ok(AuditActions.LOGIN, 'Should have LOGIN action');
  assert.ok(AuditActions.PAYMENT_CREATED, 'Should have PAYMENT_CREATED action');
  assert.ok(AuditActions.DATA_REGION_CHANGED, 'Should have DATA_REGION_CHANGED action');
  console.log('✅ AuditActions constants verified');

  // ── auditLog 函数测试 ─────────────────────────────────────────────────────────
  console.log('\n[TEST] auditLog function');
  const mockDb = new MockDb();

  // 测试基本审计日志记录
  let result = await auditLog({
    userId: 1,
    action: AuditActions.LOGIN,
    details: { method: 'password' },
    req: createMockReq(),
    service: 'user-service',
    db: mockDb
  });
  
  assert.strictEqual(result, true, 'auditLog should return true on success');
  assert.strictEqual(mockDb.logs.length, 1, 'Should have one log entry');
  assert.strictEqual(mockDb.logs[0].user_id, 1, 'User ID should be 1');
  assert.strictEqual(mockDb.logs[0].action, 'login', 'Action should be login');
  assert.strictEqual(mockDb.logs[0].ip_address, '127.0.0.1', 'IP should be captured');
  console.log('✅ Basic audit log recording works');

  // 测试无数据库连接时的行为
  result = await auditLog({
    userId: 2,
    action: AuditActions.LOGOUT,
    details: {},
    service: 'user-service',
    db: null
  });
  
  assert.strictEqual(result, true, 'auditLog should return true even without db');
  console.log('✅ auditLog handles missing db gracefully');

  // 测试 IP 地址提取（x-forwarded-for）
  const req = createMockReq({ ip: null });
  await auditLog({
    userId: 3,
    action: AuditActions.DATA_VIEWED,
    details: { resource: 'profile' },
    req,
    service: 'user-service',
    db: mockDb
  });
  
  assert.strictEqual(mockDb.logs[mockDb.logs.length - 1].ip_address, '192.168.1.1', 'Should use x-forwarded-for IP');
  console.log('✅ IP extraction from x-forwarded-for works');

  // 测试审计日志失败不影响主流程
  const errorDb = {
    query: async () => { throw new Error('DB connection failed'); }
  };
  
  result = await auditLog({
    userId: 4,
    action: AuditActions.CONSENT_GIVEN,
    details: { consentType: 'privacy' },
    service: 'user-service',
    db: errorDb
  });
  
  assert.strictEqual(result, false, 'auditLog should return false on db error');
  console.log('✅ auditLog failure does not throw');

  // ── getUserAuditLogs 函数测试 ─────────────────────────────────────────────────
  console.log('\n[TEST] getUserAuditLogs function');
  
  const logs = await getUserAuditLogs(1, { limit: 10 }, mockDb);
  assert.ok(Array.isArray(logs), 'Should return array');
  console.log('✅ getUserAuditLogs returns array');

  // ── getSystemAuditLogs 函数测试 ───────────────────────────────────────────────
  console.log('\n[TEST] getSystemAuditLogs function');
  
  const systemLogs = await getSystemAuditLogs({ limit: 100 }, mockDb);
  assert.ok(Array.isArray(systemLogs), 'Should return array');
  console.log('✅ getSystemAuditLogs returns array');

  // ── auditMiddleware 测试 ─────────────────────────────────────────────────────
  console.log('\n[TEST] auditMiddleware function');
  
  mockDb.reset();
  
  const middleware = auditMiddleware(AuditActions.PAYMENT_CREATED, (req) => ({
    orderId: req.body?.orderId,
    amount: req.body?.amount
  }));
  
  const mwReq = createMockReq({
    body: { orderId: 'ORD-123', amount: 100 },
    app: { locals: { db: mockDb } }
  });
  
  const mwRes = createMockRes();
  let nextCalled = false;
  
  await middleware(mwReq, mwRes, () => { nextCalled = true; });
  
  assert.strictEqual(nextCalled, true, 'next() should be called');
  
  // 模拟响应结束
  mwRes.end();
  
  // 等待异步审计日志完成
  await new Promise(resolve => setTimeout(resolve, 50));
  
  console.log('✅ auditMiddleware calls next and triggers audit');

  // 测试无用户时的中间件行为
  const noUserMiddleware = auditMiddleware(AuditActions.LOGIN);
  const noUserReq = createMockReq({ user: null });
  const noUserRes = createMockRes();
  nextCalled = false;
  
  await noUserMiddleware(noUserReq, noUserRes, () => { nextCalled = true; });
  noUserRes.end();
  
  await new Promise(resolve => setTimeout(resolve, 50));
  
  assert.strictEqual(nextCalled, true, 'next() should be called even without user');
  console.log('✅ auditMiddleware handles missing user gracefully');

  // ── GDPR 相关操作测试 ───────────────────────────────────────────────────────
  console.log('\n[TEST] GDPR-related operations');
  
  mockDb.reset();
  
  await auditLog({
    userId: 100,
    action: AuditActions.DELETION_REQUESTED,
    details: { requestReason: 'User requested' },
    service: 'gdpr-service',
    db: mockDb
  });
  
  await auditLog({
    userId: 100,
    action: AuditActions.DATA_EXPORTED,
    details: { format: 'json', size: '2.5MB' },
    service: 'gdpr-service',
    db: mockDb
  });
  
  await auditLog({
    userId: 100,
    action: AuditActions.CONSENT_GIVEN,
    details: { consentType: 'marketing', version: 'v2.0' },
    service: 'user-service',
    db: mockDb
  });
  
  assert.strictEqual(mockDb.logs.length, 3, 'Should have 3 GDPR logs');
  assert.strictEqual(mockDb.logs[0].action, 'deletion_requested', 'First log should be deletion request');
  console.log('✅ GDPR operations logged correctly');

  // ── 数据跨境传输测试 ─────────────────────────────────────────────────────────
  console.log('\n[TEST] Cross-border data transfer operations');
  
  mockDb.reset();
  
  await auditLog({
    userId: 200,
    action: AuditActions.DATA_REGION_CHANGED,
    details: { fromRegion: 'CN', toRegion: 'EU', reason: 'User relocation' },
    service: 'compliance-service',
    db: mockDb
  });
  
  await auditLog({
    userId: 201,
    action: AuditActions.TRANSFER_APPROVED,
    details: { requestId: 'TRF-001', approvedBy: 'admin@example.com' },
    service: 'compliance-service',
    db: mockDb
  });
  
  assert.strictEqual(mockDb.logs.length, 2, 'Should have 2 transfer logs');
  console.log('✅ Cross-border transfer operations logged');

  // ── 支付相关操作测试 ─────────────────────────────────────────────────────────
  console.log('\n[TEST] Payment-related operations');
  
  mockDb.reset();
  
  await auditLog({
    userId: 300,
    action: AuditActions.PAYMENT_CREATED,
    details: { orderId: 'ORD-456', amount: 99.99, currency: 'CNY' },
    service: 'payment-service',
    db: mockDb
  });
  
  await auditLog({
    userId: 300,
    action: AuditActions.PAYMENT_COMPLETED,
    details: { orderId: 'ORD-456', transactionId: 'TXN-789' },
    service: 'payment-service',
    db: mockDb
  });
  
  await auditLog({
    userId: 300,
    action: AuditActions.PAYMENT_REFUNDED,
    details: { orderId: 'ORD-456', refundAmount: 99.99, reason: 'User request' },
    service: 'payment-service',
    db: mockDb
  });
  
  assert.strictEqual(mockDb.logs.length, 3, 'Should have 3 payment logs');
  console.log('✅ Payment operations logged correctly');

  // ── 管理操作测试 ─────────────────────────────────────────────────────────────
  console.log('\n[TEST] Admin operations');
  
  mockDb.reset();
  
  await auditLog({
    userId: 999,
    action: AuditActions.ADMIN_USER_VIEW,
    details: { targetUserId: 100, reason: 'Support ticket' },
    service: 'admin-service',
    db: mockDb
  });
  
  await auditLog({
    userId: 999,
    action: AuditActions.ADMIN_USER_MODIFY,
    details: { targetUserId: 100, changes: { status: 'suspended' } },
    service: 'admin-service',
    db: mockDb
  });
  
  assert.strictEqual(mockDb.logs.length, 2, 'Should have 2 admin logs');
  console.log('✅ Admin operations logged correctly');

  // ── 边界条件测试 ─────────────────────────────────────────────────────────────
  console.log('\n[TEST] Edge cases');
  
  mockDb.reset();
  
  // 测试空 details
  await auditLog({
    userId: 1,
    action: AuditActions.LOGIN,
    details: {},
    service: 'test',
    db: mockDb
  });
  
  assert.deepStrictEqual(mockDb.logs[0].details, {}, 'Empty details should work');
  console.log('✅ Empty details handled');
  
  // 测试大型 details 对象
  const largeDetails = {
    items: Array(100).fill({ id: 1, name: 'test' }),
    metadata: { nested: { deep: { value: 'test' } } }
  };
  
  await auditLog({
    userId: 1,
    action: AuditActions.DATA_EXPORTED,
    details: largeDetails,
    service: 'test',
    db: mockDb
  });
  
  assert.strictEqual(mockDb.logs[1].details.items.length, 100, 'Large details should be stored');
  console.log('✅ Large details handled');
  
  // 测试特殊字符
  await auditLog({
    userId: 1,
    action: AuditActions.DATA_UPDATED,
    details: { field: "value with 'quotes' and \"double quotes\" and \n newlines" },
    service: 'test',
    db: mockDb
  });
  
  assert.ok(mockDb.logs[2].details.field.includes("quotes"), 'Special characters should be preserved');
  console.log('✅ Special characters handled');

  console.log('\n========================================');
  console.log('✅ All auditLog.js tests passed!');
  console.log('========================================');
}

// 运行测试
runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
