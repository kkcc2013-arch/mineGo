/**
 * REQ-00038 集成测试：API 响应过滤集成测试
 */

'use strict';

const assert = require('assert');
const path = require('path');

// 模拟 Express 环境
const express = require('express');
const request = require('supertest');

const { responseFilterMiddleware } = require('../shared/responseFilter');

// ============================================================
// 测试应用
// ============================================================

function createTestApp() {
  const app = express();
  
  // 应用响应过滤中间件
  app.use(responseFilterMiddleware({
    enableAutoFilter: true,
    logSensitiveAccess: false,
  }));
  
  // 模拟认证中间件
  app.use((req, res, next) => {
    req.user = {
      id: 'user-123',
      role: req.headers['x-user-role'] || 'user',
    };
    next();
  });
  
  // 测试路由
  app.get('/api/users/:id', (req, res) => {
    res.json({
      id: req.params.id,
      username: 'player1',
      email: 'test@example.com',
      phone: '+8613812345678',
      password: 'secret123',
      real_name: 'Test User',
      score: 1000,
    });
  });
  
  app.get('/api/payments/:id', (req, res) => {
    res.json({
      id: req.params.id,
      user_id: 'user-123',
      card_number: '1234567890123456',
      cvv: '123',
      amount: 99.99,
      status: 'completed',
      billing_address: 'Shanghai, Pudong District, Road 123',
    });
  });
  
  app.get('/api/pokemon/:id', (req, res) => {
    res.json({
      id: req.params.id,
      name: 'Pikachu',
      iv_values: { attack: 15, defense: 14, stamina: 15 },
      shiny_rate: 0.05,
      location_history: [
        { lat: 31.2304, lng: 121.4737, timestamp: Date.now() },
      ],
    });
  });
  
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });
  
  return app;
}

// ============================================================
// 集成测试
// ============================================================

async function runIntegrationTests() {
  const app = createTestApp();
  
  console.log('Running REQ-00038 integration tests...\n');
  
  let passed = 0;
  let failed = 0;
  
  // 测试 1: 普通用户访问用户信息
  console.log('Test 1: Regular user accessing user info');
  try {
    const response = await request(app)
      .get('/api/users/123')
      .set('X-User-Role', 'user');
    
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.username, 'player1');
    assert.strictEqual(response.body.password, undefined, 'P0 field should be removed');
    assert.ok(response.body.email.includes('***'), 'P1 field should be masked');
    assert.ok(response.body.phone.includes('***'), 'P1 field should be masked');
    assert.strictEqual(response.body.score, 1000, 'Non-sensitive field should be intact');
    
    console.log('  ✓ User info filtered correctly for regular user');
    passed++;
  } catch (err) {
    console.log('  ✗ Failed:', err.message);
    failed++;
  }
  
  // 测试 2: 管理员访问用户信息
  console.log('\nTest 2: Admin accessing user info');
  try {
    const response = await request(app)
      .get('/api/users/123')
      .set('X-User-Role', 'admin');
    
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.password, undefined, 'P0 field should still be removed');
    assert.strictEqual(response.body.email, 'test@example.com', 'P1 field should be visible to admin');
    assert.strictEqual(response.body.phone, '+8613812345678', 'P1 field should be visible to admin');
    
    console.log('  ✓ User info filtered correctly for admin');
    passed++;
  } catch (err) {
    console.log('  ✗ Failed:', err.message);
    failed++;
  }
  
  // 测试 3: 系统角色访问用户信息
  console.log('\nTest 3: System role accessing user info');
  try {
    const response = await request(app)
      .get('/api/users/123')
      .set('X-User-Role', 'system');
    
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.password, 'secret123', 'P0 field should be visible to system');
    assert.strictEqual(response.body.email, 'test@example.com', 'P1 field should be visible to system');
    
    console.log('  ✓ User info shows all fields for system role');
    passed++;
  } catch (err) {
    console.log('  ✗ Failed:', err.message);
    failed++;
  }
  
  // 测试 4: 支付信息过滤
  console.log('\nTest 4: Payment info filtering');
  try {
    const response = await request(app)
      .get('/api/payments/456')
      .set('X-User-Role', 'user');
    
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.card_number, undefined, 'Card number should be removed');
    assert.strictEqual(response.body.cvv, undefined, 'CVV should be removed');
    assert.strictEqual(response.body.amount, 99.99, 'Amount should be intact');
    
    console.log('  ✓ Payment info filtered correctly');
    passed++;
  } catch (err) {
    console.log('  ✗ Failed:', err.message);
    failed++;
  }
  
  // 测试 5: 精灵信息过滤
  console.log('\nTest 5: Pokemon info filtering');
  try {
    const response = await request(app)
      .get('/api/pokemon/789')
      .set('X-User-Role', 'user');
    
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.name, 'Pikachu', 'Name should be intact');
    assert.strictEqual(response.body.shiny_rate, undefined, 'Internal field should be removed');
    
    console.log('  ✓ Pokemon info filtered correctly');
    passed++;
  } catch (err) {
    console.log('  ✗ Failed:', err.message);
    failed++;
  }
  
  // 测试 6: 健康检查不应被过滤
  console.log('\nTest 6: Health check should not be filtered');
  try {
    const response = await request(app)
      .get('/health')
      .set('X-User-Role', 'user');
    
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { status: 'ok' });
    
    console.log('  ✓ Health check bypasses filter');
    passed++;
  } catch (err) {
    console.log('  ✗ Failed:', err.message);
    failed++;
  }
  
  // 总结
  console.log('\n' + '='.repeat(60));
  console.log(`Integration Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  
  return { passed, failed };
}

// ============================================================
// 运行
// ============================================================

if (require.main === module) {
  runIntegrationTests()
    .then(({ failed }) => {
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('Test suite failed:', err);
      process.exit(1);
    });
}

module.exports = { createTestApp, runIntegrationTests };
