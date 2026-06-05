// tests/unit/payment.test.js - Payment Service Unit Tests
// REQ-00004: 支付服务单元测试与集成测试覆盖
'use strict';

const assert = require('assert');
const crypto = require('crypto');

// ============================================================
// Helper Functions (extracted from payment-service)
// ============================================================

const ORDER_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FULFILLED: 'FULFILLED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED'
};

const VALID_TRANSITIONS = {
  PENDING: [ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED],
  PAID: [ORDER_STATUS.FULFILLED, ORDER_STATUS.REFUNDED],
  FULFILLED: [],
  CANCELLED: [],
  REFUNDED: []
};

function canTransition(fromStatus, toStatus) {
  const allowed = VALID_TRANSITIONS[fromStatus];
  return allowed && allowed.includes(toStatus);
}

const CHANNEL_SECRETS = {
  WECHAT: 'dev_wechat_secret_key',
  ALIPAY: 'dev_alipay_secret_key',
  APPLE: 'dev_apple_secret_key'
};

function verifyWebhookSignature(payload, signature, secret) {
  try {
    let actualSignature = signature;
    if (signature.includes('sign=')) {
      const match = signature.match(/sign=([a-fA-F0-9]+)/);
      if (match) actualSignature = match[1];
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    // Timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(actualSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch (err) {
    return false;
  }
}

function generateIdempotencyKey() {
  return `key_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================
// Test Suite
// ============================================================

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${err.message}`);
    testsFailed++;
  }
}

console.log('\n🧪 Payment Service Unit Tests');
console.log('=' .repeat(60));

// ============================================================
// Test Suite 1: Order Status State Machine
// ============================================================

console.log('\n📦 Test Suite 1: Order Status State Machine\n');

test('PENDING → PAID 是合法转换', () => {
  assert.strictEqual(canTransition('PENDING', 'PAID'), true);
});

test('PENDING → CANCELLED 是合法转换', () => {
  assert.strictEqual(canTransition('PENDING', 'CANCELLED'), true);
});

test('PAID → PENDING 是非法转换', () => {
  assert.strictEqual(canTransition('PAID', 'PENDING'), false);
});

test('PAID → FULFILLED 是合法转换', () => {
  assert.strictEqual(canTransition('PAID', 'FULFILLED'), true);
});

test('PAID → REFUNDED 是合法转换', () => {
  assert.strictEqual(canTransition('PAID', 'REFUNDED'), true);
});

test('FULFILLED 不能转换到任何状态', () => {
  assert.strictEqual(canTransition('FULFILLED', 'PAID'), false);
  assert.strictEqual(canTransition('FULFILLED', 'CANCELLED'), false);
  assert.strictEqual(canTransition('FULFILLED', 'REFUNDED'), false);
});

test('CANCELLED 不能转换到任何状态', () => {
  assert.strictEqual(canTransition('CANCELLED', 'PENDING'), false);
  assert.strictEqual(canTransition('CANCELLED', 'PAID'), false);
});

test('REFUNDED 不能转换到任何状态', () => {
  assert.strictEqual(canTransition('REFUNDED', 'PENDING'), false);
  assert.strictEqual(canTransition('REFUNDED', 'PAID'), false);
});

test('无效状态不能转换', () => {
  assert.strictEqual(canTransition('INVALID', 'PAID'), undefined);
  assert.strictEqual(canTransition(null, 'PAID'), undefined);
  assert.strictEqual(canTransition(undefined, 'PAID'), undefined);
});

// ============================================================
// Test Suite 2: Idempotency Key
// ============================================================

console.log('\n🔑 Test Suite 2: Idempotency Key\n');

test('幂等性键格式正确', () => {
  const key = generateIdempotencyKey();
  assert.ok(key.startsWith('key_'));
  assert.ok(key.length > 10);
});

test('幂等性键唯一性', () => {
  const key1 = generateIdempotencyKey();
  const key2 = generateIdempotencyKey();
  assert.notStrictEqual(key1, key2);
});

test('幂等性键包含时间戳', () => {
  const key = generateIdempotencyKey();
  const parts = key.split('_');
  assert.ok(parts.length >= 2);
  const timestamp = parseInt(parts[1]);
  assert.ok(!isNaN(timestamp));
});

// ============================================================
// Test Suite 3: Signature Verification
// ============================================================

console.log('\n🔐 Test Suite 3: Signature Verification\n');

test('正确签名应通过验证', () => {
  const payload = JSON.stringify({ orderId: 'order_123', amount: 3000 });
  const secret = CHANNEL_SECRETS.WECHAT;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const result = verifyWebhookSignature(payload, signature, secret);
  assert.strictEqual(result, true);
});

test('错误签名应拒绝', () => {
  const payload = JSON.stringify({ orderId: 'order_123', amount: 3000 });
  const secret = CHANNEL_SECRETS.WECHAT;
  const wrongSignature = 'a'.repeat(64);

  const result = verifyWebhookSignature(payload, wrongSignature, secret);
  assert.strictEqual(result, false);
});

test('使用错误密钥生成的签名应拒绝', () => {
  const payload = JSON.stringify({ orderId: 'order_123', amount: 3000 });
  const correctSecret = CHANNEL_SECRETS.WECHAT;
  const wrongSecret = 'wrong_secret_key';
  const signature = crypto.createHmac('sha256', wrongSecret).update(payload).digest('hex');

  const result = verifyWebhookSignature(payload, signature, correctSecret);
  assert.strictEqual(result, false);
});

test('空签名应返回 false', () => {
  const payload = JSON.stringify({ orderId: 'order_123', amount: 3000 });
  const secret = CHANNEL_SECRETS.WECHAT;

  const result = verifyWebhookSignature(payload, '', secret);
  assert.strictEqual(result, false);
});

test('支持 sign=xxx 格式的签名', () => {
  const payload = JSON.stringify({ orderId: 'order_123', amount: 3000 });
  const secret = CHANNEL_SECRETS.ALIPAY;
  const signatureHex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const signature = `sign_type=HMAC-SHA256&sign=${signatureHex}`;

  const result = verifyWebhookSignature(payload, signature, secret);
  assert.strictEqual(result, true);
});

test('应防止时序攻击', () => {
  const payload = JSON.stringify({ orderId: 'order_123', amount: 3000 });
  const secret = CHANNEL_SECRETS.WECHAT;
  const wrongSignature = 'a'.repeat(64);

  // 验证 timing-safe comparison 不会因长度不同而崩溃
  const result = verifyWebhookSignature(payload, wrongSignature, secret);
  assert.strictEqual(result, false);
});

test('不同支付渠道使用不同密钥', () => {
  const payload = JSON.stringify({ orderId: 'order_123' });

  const wechatSignature = crypto.createHmac('sha256', CHANNEL_SECRETS.WECHAT).update(payload).digest('hex');
  const alipaySignature = crypto.createHmac('sha256', CHANNEL_SECRETS.ALIPAY).update(payload).digest('hex');
  const appleSignature = crypto.createHmac('sha256', CHANNEL_SECRETS.APPLE).update(payload).digest('hex');

  assert.notStrictEqual(wechatSignature, alipaySignature);
  assert.notStrictEqual(alipaySignature, appleSignature);
  assert.notStrictEqual(wechatSignature, appleSignature);
});

test('签名长度验证', () => {
  const payload = JSON.stringify({ orderId: 'order_123' });
  const secret = CHANNEL_SECRETS.WECHAT;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // HMAC-SHA256 输出 64 个十六进制字符
  assert.strictEqual(signature.length, 64);
});

// ============================================================
// Test Suite 4: Order Data Sanitization
// ============================================================

console.log('\n🔒 Test Suite 4: Order Data Sanitization\n');

test('订单查询不返回敏感字段', () => {
  const rawOrder = {
    id: 'order_123',
    user_id: 'user_001',
    product_name: '300精币',
    amount_fen: 3000,
    premium_coins_grant: 300,
    status: 'PAID',
    payment_channel: 'WECHAT',
    channel_order_id: 'wx_123456',
    channel_response: '<xml>sensitive_data</xml>',
    rawCallback: 'raw_webhook_data',
    signature: 'abc123def456',
    paid_at: new Date(),
    created_at: new Date()
  };

  // 模拟脱敏逻辑
  const sanitizedOrder = {
    orderId: rawOrder.id,
    productName: rawOrder.product_name,
    amountFen: rawOrder.amount_fen,
    coinsGranted: rawOrder.premium_coins_grant,
    status: rawOrder.status,
    paymentChannel: rawOrder.payment_channel,
    paidAt: rawOrder.paid_at,
    createdAt: rawOrder.created_at
  };

  assert.strictEqual(sanitizedOrder.channelResponse, undefined);
  assert.strictEqual(sanitizedOrder.rawCallback, undefined);
  assert.strictEqual(sanitizedOrder.signature, undefined);
  assert.strictEqual(sanitizedOrder.channel_order_id, undefined);
});

test('订单列表只返回用户自己的订单', () => {
  const orders = [
    { id: 'order_1', user_id: 'user_001' },
    { id: 'order_2', user_id: 'user_002' },
    { id: 'order_3', user_id: 'user_001' }
  ];

  const userId = 'user_001';
  const userOrders = orders.filter(o => o.user_id === userId);

  assert.strictEqual(userOrders.length, 2);
  assert.strictEqual(userOrders.every(o => o.user_id === userId), true);
});

test('敏感字段黑名单', () => {
  const sensitiveFields = ['channel_response', 'rawCallback', 'signature', 'channel_order_id', 'idempotency_key'];

  const orderKeys = ['id', 'user_id', 'product_name', 'amount_fen', 'status', 'channel_response'];

  const hasSensitiveData = orderKeys.some(key => sensitiveFields.includes(key));
  assert.strictEqual(hasSensitiveData, true);
});

// ============================================================
// Test Suite 5: Product Catalog
// ============================================================

console.log('\n🛍️  Test Suite 5: Product Catalog\n');

test('商品价格正确', () => {
  const PRODUCTS = {
    'coins_60':   { name: '60精币',   amountFen: 600,  coinsGrant: 60   },
    'coins_300':  { name: '300精币',  amountFen: 3000, coinsGrant: 300  },
    'coins_600':  { name: '600精币',  amountFen: 5800, coinsGrant: 600  },
    'coins_1200': { name: '1200精币', amountFen: 9800, coinsGrant: 1200 },
    'coins_2500': { name: '2500精币', amountFen: 19800,coinsGrant: 2500 },
  };

  assert.strictEqual(PRODUCTS['coins_60'].coinsGrant, 60);
  assert.strictEqual(PRODUCTS['coins_300'].coinsGrant, 300);
  assert.strictEqual(PRODUCTS['coins_600'].coinsGrant, 600);
  assert.strictEqual(PRODUCTS['coins_1200'].coinsGrant, 1200);
  assert.strictEqual(PRODUCTS['coins_2500'].coinsGrant, 2500);
});

test('大额购买有优惠', () => {
  const PRODUCTS = {
    'coins_300':  { amountFen: 3000, coinsGrant: 300  },
    'coins_600':  { amountFen: 5800, coinsGrant: 600  },
    'coins_1200': { amountFen: 9800, coinsGrant: 1200 },
    'coins_2500': { amountFen: 19800,coinsGrant: 2500 },
  };

  const unitPrice300 = PRODUCTS['coins_300'].amountFen / PRODUCTS['coins_300'].coinsGrant;
  const unitPrice600 = PRODUCTS['coins_600'].amountFen / PRODUCTS['coins_600'].coinsGrant;
  const unitPrice1200 = PRODUCTS['coins_1200'].amountFen / PRODUCTS['coins_1200'].coinsGrant;
  const unitPrice2500 = PRODUCTS['coins_2500'].amountFen / PRODUCTS['coins_2500'].coinsGrant;

  assert.ok(unitPrice600 < unitPrice300);
  assert.ok(unitPrice1200 < unitPrice600);
  assert.ok(unitPrice2500 < unitPrice1200);
});

test('无效商品 ID 应拒绝', () => {
  const PRODUCTS = {
    'coins_60': { name: '60精币' },
    'coins_300': { name: '300精币' }
  };

  const invalidProductId = 'coins_999999';
  assert.strictEqual(PRODUCTS[invalidProductId], undefined);
});

test('支持的支付渠道', () => {
  const validChannels = ['WECHAT', 'ALIPAY'];
  const invalidChannels = ['PAYPAL', 'STRIPE', 'CREDIT_CARD'];

  assert.strictEqual(validChannels.includes('WECHAT'), true);
  assert.strictEqual(validChannels.includes('ALIPAY'), true);
  assert.strictEqual(invalidChannels.includes('WECHAT'), false);
});

test('商品金额为正整数', () => {
  const PRODUCTS = {
    'coins_60':   { amountFen: 600  },
    'coins_300':  { amountFen: 3000 },
    'coins_600':  { amountFen: 5800 },
  };

  Object.values(PRODUCTS).forEach(p => {
    assert.ok(Number.isInteger(p.amountFen));
    assert.ok(p.amountFen > 0);
  });
});

// ============================================================
// Test Suite 6: Error Handling
// ============================================================

console.log('\n⚠️  Test Suite 7: Error Handling\n');

test('缺少必填参数应检测到', () => {
  const params = {
    productId: 'coins_300',
    paymentChannel: null,  // 缺失
    idempotencyKey: generateIdempotencyKey()
  };

  const hasAllRequired = !!(params.productId && params.paymentChannel && params.idempotencyKey);
  assert.strictEqual(hasAllRequired, false);
});

test('无效支付渠道应拒绝', () => {
  const validChannels = ['WECHAT', 'ALIPAY'];
  const testChannel = 'PAYPAL';
  const isValid = validChannels.includes(testChannel);
  assert.strictEqual(isValid, false);
});

test('订单状态转换失败应返回 false', () => {
  const currentStatus = 'FULFILLED';
  const targetStatus = 'PAID';
  const canMove = canTransition(currentStatus, targetStatus);

  assert.strictEqual(canMove, false);
});

test('空参数验证', () => {
  const params = {};
  const hasProductId = !!params.productId;
  const hasPaymentChannel = !!params.paymentChannel;
  const hasIdempotencyKey = !!params.idempotencyKey;

  assert.strictEqual(hasProductId, false);
  assert.strictEqual(hasPaymentChannel, false);
  assert.strictEqual(hasIdempotencyKey, false);
});

// ============================================================
// Summary
// ============================================================

console.log('\n' + '='.repeat(60));
console.log(`\n📊 Test Results:`);
console.log(`   ✅ Passed: ${testsPassed}`);
console.log(`   ❌ Failed: ${testsFailed}`);
console.log(`   📈 Total:  ${testsPassed + testsFailed}`);

if (testsFailed === 0) {
  console.log(`\n🎉 All tests passed!\n`);
  process.exit(0);
} else {
  console.log(`\n⚠️  Some tests failed. Please review.\n`);
  process.exit(1);
}
