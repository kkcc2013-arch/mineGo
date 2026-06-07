import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

/**
 * mineGo API 压力测试 - 综合场景
 * 
 * 模拟真实用户行为：登录 → 查询精灵 → 捕捉 → 道馆 → 社交 → 支付
 */

// 自定义指标
const userJourneyLatency = new Trend('user_journey_latency');
const userJourneySuccess = new Rate('user_journey_success');
const apiErrors = new Rate('api_errors');

// 测试配置
export const options = {
  scenarios: {
    // 用户旅程测试
    user_journey: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '5m', target: 100 },
        { duration: '2m', target: 150 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 0 }
      ],
      gracefulRampDown: '20s'
    }
  },
  thresholds: {
    http_req_duration: ['p(50)<150', 'p(90)<300', 'p(99)<500'],
    http_req_failed: ['rate<0.02'],
    user_journey_success: ['rate>0.85']
  }
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 测试用户池
let tokenPool = [];

// 随机位置
function randomLocation() {
  return {
    lat: 39.9042 + (Math.random() - 0.5) * 0.05,
    lng: 116.4074 + (Math.random() - 0.5) * 0.05
  };
}

// 注册用户
function registerUser(index) {
  const timestamp = Date.now();
  const payload = JSON.stringify({
    username: `journey_${timestamp}_${index}`,
    email: `journey_${timestamp}_${index}@test.minego.local`,
    password: 'TestPass123!@#'
  });

  const res = http.post(`${BASE_URL}/api/auth/register`, payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  if (res.status === 200 || res.status === 201) {
    try {
      return JSON.parse(res.body).token;
    } catch (e) {}
  }
  return null;
}

// API 请求封装
function apiRequest(method, path, token, payload = null) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  let res;
  const startTime = Date.now();

  if (method === 'GET') {
    res = http.get(`${BASE_URL}${path}`, params);
  } else if (method === 'POST') {
    res = http.post(`${BASE_URL}${path}`, payload ? JSON.stringify(payload) : null, params);
  }

  const latency = Date.now() - startTime;
  userJourneyLatency.add(latency);

  const success = check(res, {
    [`${method} ${path} 成功`]: (r) => r.status >= 200 && r.status < 300
  });

  apiErrors.add(!success);

  if (success) {
    try {
      return JSON.parse(res.body);
    } catch {}
  }
  return null;
}

export function setup() {
  console.log('开始综合压力测试...');
  console.log(`目标服务: ${BASE_URL}`);

  const healthRes = http.get(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error('服务健康检查失败');
  }

  console.log('预生成测试用户...');
  for (let i = 0; i < 50; i++) {
    const token = registerUser(i);
    if (token) tokenPool.push(token);
  }

  console.log(`成功创建 ${tokenPool.length} 个测试用户`);
  return { startTime: Date.now() };
}

export default function () {
  const token = tokenPool[Math.floor(Math.random() * tokenPool.length)];
  const location = randomLocation();
  let journeySuccess = true;

  // 1. 用户认证
  const profile = apiRequest('GET', '/api/user/profile', token);
  if (!profile) {
    userJourneySuccess.add(false);
    sleep(1);
    return;
  }
  sleep(0.5);

  // 2. 查询附近精灵
  const nearby = apiRequest('GET', `/api/pokemon/nearby?lat=${location.lat}&lng=${location.lng}&radius=500`, token);
  sleep(0.3);

  // 3. 尝试捕捉
  if (nearby && (nearby.pokemon || nearby.data) && (nearby.pokemon || nearby.data).length > 0) {
    const pokemon = (nearby.pokemon || nearby.data)[0];
    const catchResult = apiRequest('POST', '/api/catch/attempt', token, {
      pokemon_id: pokemon.id || pokemon.pokemon_id,
      ball_type: 'poke',
      throw_quality: 'good',
      lat: location.lat,
      lng: location.lng
    });
    sleep(1);
  }

  // 4. 查询道馆
  const gyms = apiRequest('GET', `/api/gym/nearby?lat=${location.lat}&lng=${location.lng}&radius=1000`, token);
  sleep(0.3);

  // 5. 查询好友
  const friends = apiRequest('GET', '/api/social/friends', token);
  sleep(0.3);

  // 6. 查询每日任务
  const tasks = apiRequest('GET', '/api/reward/daily', token);
  sleep(0.3);

  // 7. 查询用户余额
  const balance = apiRequest('GET', '/api/user/balance', token);
  sleep(0.3);

  // 记录旅程成功率
  userJourneySuccess.add(journeySuccess);
  sleep(2);
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`综合压力测试完成，耗时: ${duration.toFixed(2)} 秒`);
}
