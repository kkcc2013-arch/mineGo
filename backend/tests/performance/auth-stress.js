import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

/**
 * mineGo API 压力测试 - 认证场景
 * 
 * 测试用户注册、登录、令牌刷新流程
 */

// 自定义指标
const loginErrorRate = new Rate('auth_login_errors');
const loginLatency = new Trend('auth_login_latency');
const registerErrorRate = new Rate('auth_register_errors');
const registerLatency = new Trend('auth_register_latency');
const tokenRefreshErrorRate = new Rate('auth_token_refresh_errors');
const authSuccessRate = new Rate('auth_success_rate');

// 测试配置
export const options = {
  scenarios: {
    // 负载测试
    load_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '1m', target: 50 },
        { duration: '10s', target: 0 }
      ],
      gracefulRampDown: '10s'
    },
    // 峰值测试
    spike_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '30s', target: 300 },
        { duration: '10s', target: 50 },
        { duration: '10s', target: 0 }
      ],
      startTime: '4m',
      gracefulRampDown: '5s'
    }
  },
  thresholds: {
    http_req_duration: ['p(50)<80', 'p(90)<150', 'p(99)<250'],
    http_req_failed: ['rate<0.01'],
    auth_login_errors: ['rate<0.005'],
    auth_register_errors: ['rate<0.01'],
    auth_success_rate: ['rate>0.95']
  }
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 生成随机用户名
function randomUsername() {
  return `user_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

// 生成测试用户凭证
function generateTestCredentials() {
  const timestamp = Date.now();
  return {
    username: `stress_${timestamp}_${Math.random().toString(36).substring(7)}`,
    email: `stress_${timestamp}@test.minego.local`,
    password: 'TestPass123!@#'
  };
}

// 注册用户
function registerUser(credentials) {
  const payload = JSON.stringify({
    username: credentials.username,
    email: credentials.email,
    password: credentials.password
  });

  const params = {
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/api/auth/register`, payload, params);
  const latency = Date.now() - startTime;

  registerLatency.add(latency);

  const success = check(res, {
    '注册成功': (r) => r.status === 201 || r.status === 200,
    '返回 token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.token !== undefined;
      } catch {
        return false;
      }
    }
  });

  registerErrorRate.add(!success);

  if (success) {
    const body = JSON.parse(res.body);
    return body.token;
  }

  return null;
}

// 登录
function loginUser(credentials) {
  const payload = JSON.stringify({
    email: credentials.email,
    password: credentials.password
  });

  const params = {
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/api/auth/login`, payload, params);
  const latency = Date.now() - startTime;

  loginLatency.add(latency);

  const success = check(res, {
    '登录成功': (r) => r.status === 200,
    '返回 token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.token !== undefined;
      } catch {
        return false;
      }
    }
  });

  loginErrorRate.add(!success);

  if (success) {
    const body = JSON.parse(res.body);
    return body.token;
  }

  return null;
}

// 刷新令牌
function refreshToken(token) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const res = http.post(`${BASE_URL}/api/auth/refresh`, null, params);

  const success = check(res, {
    '刷新成功': (r) => r.status === 200,
    '返回新 token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.token !== undefined;
      } catch {
        return false;
      }
    }
  });

  tokenRefreshErrorRate.add(!success);

  if (success) {
    const body = JSON.parse(res.body);
    return body.token;
  }

  return null;
}

// 获取用户信息
function getUserInfo(token) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const res = http.get(`${BASE_URL}/api/user/profile`, params);

  return check(res, {
    '获取用户信息成功': (r) => r.status === 200
  });
}

export default function () {
  // 生成测试凭证
  const credentials = generateTestCredentials();

  // 1. 注册流程
  const registerToken = registerUser(credentials);

  if (!registerToken) {
    authSuccessRate.add(false);
    sleep(1);
    return;
  }

  sleep(0.5);

  // 2. 使用注册返回的 token 获取用户信息
  const infoSuccess = getUserInfo(registerToken);

  if (!infoSuccess) {
    authSuccessRate.add(false);
    sleep(1);
    return;
  }

  sleep(0.5);

  // 3. 登录流程
  const loginToken = loginUser(credentials);

  if (!loginToken) {
    authSuccessRate.add(false);
    sleep(1);
    return;
  }

  sleep(0.5);

  // 4. 刷新令牌
  const newToken = refreshToken(loginToken);

  if (!newToken) {
    authSuccessRate.add(false);
    sleep(1);
    return;
  }

  // 全部流程成功
  authSuccessRate.add(true);

  sleep(1);
}

// 测试前初始化
export function setup() {
  console.log('开始认证压力测试...');
  console.log(`目标服务: ${BASE_URL}`);

  // 检查服务健康状态
  const healthRes = http.get(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error('服务健康检查失败');
  }

  console.log('服务健康检查通过');
  return { startTime: Date.now() };
}

// 测试后清理
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`认证压力测试完成，耗时: ${duration.toFixed(2)} 秒`);
}
