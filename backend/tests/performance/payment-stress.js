import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

/**
 * mineGo API 压力测试 - 支付场景
 * 
 * 测试支付流程：创建订单 → 模拟支付 → 验证
 */

// 自定义指标
const paymentCreateLatency = new Trend('payment_create_latency');
const paymentVerifyLatency = new Trend('payment_verify_latency');
const paymentSuccessRate = new Rate('payment_success_rate');
const paymentCreateErrors = new Rate('payment_create_errors');
const paymentVerifyErrors = new Rate('payment_verify_errors');
const paymentIdempotencyRate = new Rate('payment_idempotency_rate');

// 测试配置
export const options = {
  scenarios: {
    // 支付创建负载
    payment_create_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 50 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 }
      ],
      gracefulRampDown: '10s'
    },
    // 幂等性测试
    idempotency_test: {
      executor: 'per-vu-iterations',
      vus: 10,
      iterations: 5,
      startTime: '6m'
    }
  },
  thresholds: {
    http_req_duration: ['p(50)<200', 'p(90)<350', 'p(99)<500'],
    http_req_failed: ['rate<0.005'],
    payment_success_rate: ['rate>0.95'],
    payment_idempotency_rate: ['rate=1']
  }
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 测试用户令牌池
let tokenPool = [];

// 注册测试用户
function registerTestUser(index) {
  const timestamp = Date.now();
  const payload = JSON.stringify({
    username: `pay_user_${timestamp}_${index}`,
    email: `pay_${timestamp}_${index}@test.minego.local`,
    password: 'TestPass123!@#'
  });

  const res = http.post(`${BASE_URL}/api/auth/register`, payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  if (res.status === 200 || res.status === 201) {
    try {
      const body = JSON.parse(res.body);
      return body.token;
    } catch (e) {
      return null;
    }
  }
  return null;
}

// 创建支付订单
function createPaymentOrder(token, idempotencyKey) {
  const payload = JSON.stringify({
    product_id: 'coins_100',
    amount: 6.00,
    currency: 'CNY',
    payment_method: 'alipay'
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey
    }
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/api/payment/create`, payload, params);
  paymentCreateLatency.add(Date.now() - startTime);

  const success = check(res, {
    '订单创建成功': (r) => r.status === 200 || r.status === 201,
    '返回订单信息': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.order_id !== undefined;
      } catch {
        return false;
      }
    }
  });

  paymentCreateErrors.add(!success);

  if (success) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }

  return null;
}

// 模拟支付回调
function simulatePaymentCallback(token, orderId, transactionId) {
  const payload = JSON.stringify({
    order_id: orderId,
    transaction_id: transactionId,
    status: 'success',
    paid_at: new Date().toISOString()
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const res = http.post(`${BASE_URL}/api/payment/callback`, payload, params);

  return check(res, {
    '回调处理成功': (r) => r.status === 200
  });
}

// 验证订单状态
function verifyOrderStatus(token, orderId) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const startTime = Date.now();
  const res = http.get(`${BASE_URL}/api/payment/order/${orderId}`, params);
  paymentVerifyLatency.add(Date.now() - startTime);

  const success = check(res, {
    '查询订单成功': (r) => r.status === 200,
    '返回订单状态': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status !== undefined;
      } catch {
        return false;
      }
    }
  });

  paymentVerifyErrors.add(!success);

  if (success) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }

  return null;
}

// 查询用户余额
function getUserBalance(token) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const res = http.get(`${BASE_URL}/api/user/balance`, params);

  if (res.status === 200) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }
  return null;
}

export function setup() {
  console.log('开始支付压力测试...');
  console.log(`目标服务: ${BASE_URL}`);

  // 检查服务健康状态
  const healthRes = http.get(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error('服务健康检查失败');
  }

  // 预生成测试用户
  console.log('预生成测试用户...');
  for (let i = 0; i < 20; i++) {
    const token = registerTestUser(i);
    if (token) {
      tokenPool.push(token);
    }
  }

  if (tokenPool.length === 0) {
    throw new Error('无法创建测试用户');
  }

  console.log(`成功创建 ${tokenPool.length} 个测试用户`);
  return { startTime: Date.now() };
}

export default function () {
  const token = tokenPool[Math.floor(Math.random() * tokenPool.length)];

  // 1. 查询当前余额
  const balanceBefore = getUserBalance(token);
  sleep(0.5);

  // 2. 创建支付订单
  const idempotencyKey = `key_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const order = createPaymentOrder(token, idempotencyKey);

  if (!order || !order.order_id) {
    paymentSuccessRate.add(false);
    sleep(1);
    return;
  }

  sleep(0.5);

  // 3. 模拟支付回调
  const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const callbackSuccess = simulatePaymentCallback(token, order.order_id, transactionId);

  if (!callbackSuccess) {
    paymentSuccessRate.add(false);
    sleep(1);
    return;
  }

  sleep(0.5);

  // 4. 验证订单状态
  const orderStatus = verifyOrderStatus(token, order.order_id);

  if (!orderStatus) {
    paymentSuccessRate.add(false);
    sleep(1);
    return;
  }

  // 5. 检查订单状态是否为已支付
  const isPaid = check(orderStatus, {
    '订单已支付': (os) => os.status === 'paid' || os.status === 'success'
  });

  paymentSuccessRate.add(isPaid);

  sleep(1);
}

// 幂等性测试场景
export function idempotency_test() {
  const token = tokenPool[Math.floor(Math.random() * tokenPool.length)];

  // 使用相同的幂等键创建两次订单
  const idempotencyKey = `idem_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  // 第一次创建
  const order1 = createPaymentOrder(token, idempotencyKey);

  sleep(0.5);

  // 第二次创建（应该返回相同订单）
  const order2 = createPaymentOrder(token, idempotencyKey);

  // 验证幂等性：两次应该返回相同的订单 ID
  const idempotent = check({ order1, order2 }, {
    '幂等性验证通过': (o) => {
      if (!o.order1 || !o.order2) return false;
      return o.order1.order_id === o.order2.order_id;
    }
  });

  paymentIdempotencyRate.add(idempotent);
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`支付压力测试完成，耗时: ${duration.toFixed(2)} 秒`);
}
