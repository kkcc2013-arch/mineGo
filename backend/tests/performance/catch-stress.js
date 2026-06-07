import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

/**
 * mineGo API 压力测试 - 精灵捕捉场景
 * 
 * 测试完整捕捉流程：位置上报 → 发现精灵 → 投球捕捉
 */

// 自定义指标
const nearbyQueryLatency = new Trend('pokemon_nearby_latency');
const catchAttemptLatency = new Trend('catch_attempt_latency');
const catchSuccessRate = new Rate('catch_success_rate');
const nearbyQueryErrors = new Rate('nearby_query_errors');
const catchAttemptErrors = new Rate('catch_attempt_errors');

// 测试配置
export const options = {
  scenarios: {
    // 负载测试 - 模拟正常游戏玩家
    normal_gameplay: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '3m', target: 100 },
        { duration: '1m', target: 150 },
        { duration: '30s', target: 50 },
        { duration: '10s', target: 0 }
      ],
      gracefulRampDown: '15s'
    },
    // 压力测试 - 高强度捕捉
    stress_catch: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '2m', target: 300 },
        { duration: '30s', target: 500 },
        { duration: '30s', target: 0 }
      ],
      startTime: '6m',
      gracefulRampDown: '10s'
    }
  },
  thresholds: {
    http_req_duration: ['p(50)<120', 'p(90)<250', 'p(99)<400'],
    http_req_failed: ['rate<0.02'],
    catch_success_rate: ['rate>0.85'],
    nearby_query_errors: ['rate<0.01'],
    catch_attempt_errors: ['rate<0.01']
  }
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 测试用户令牌池（预生成）
const TOKEN_POOL_SIZE = 20;
let tokenPool = [];

// 生成随机 GPS 坐标（北京附近）
function randomBeijingLocation() {
  const lat = 39.9042 + (Math.random() - 0.5) * 0.02;  // ±0.01 度约 1km
  const lng = 116.4074 + (Math.random() - 0.5) * 0.02;
  return { lat, lng };
}

// 模拟随机移动
function moveSlightly(location) {
  const delta = 0.0001; // 约 10 米
  return {
    lat: location.lat + (Math.random() - 0.5) * delta,
    lng: location.lng + (Math.random() - 0.5) * delta
  };
}

// 注册测试用户
function registerTestUser(index) {
  const timestamp = Date.now();
  const payload = JSON.stringify({
    username: `catch_user_${timestamp}_${index}`,
    email: `catch_${timestamp}_${index}@test.minego.local`,
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

// 查询附近精灵
function findNearbyPokemon(token, location) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const startTime = Date.now();
  const res = http.get(
    `${BASE_URL}/api/pokemon/nearby?lat=${location.lat}&lng=${location.lng}&radius=500`,
    params
  );
  nearbyQueryLatency.add(Date.now() - startTime);

  const success = check(res, {
    '附近查询成功': (r) => r.status === 200,
    '返回精灵列表': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.pokemon) || Array.isArray(body.data);
      } catch {
        return false;
      }
    }
  });

  nearbyQueryErrors.add(!success);

  if (success) {
    try {
      const body = JSON.parse(res.body);
      return body.pokemon || body.data || [];
    } catch {
      return [];
    }
  }

  return [];
}

// 尝试捕捉精灵
function catchPokemon(token, pokemonId, location) {
  const payload = JSON.stringify({
    pokemon_id: pokemonId,
    ball_type: Math.random() > 0.7 ? 'ultra' : 'poke',
    throw_quality: Math.random() > 0.5 ? 'excellent' : 'good',
    lat: location.lat,
    lng: location.lng
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/api/catch/attempt`, payload, params);
  catchAttemptLatency.add(Date.now() - startTime);

  const success = check(res, {
    '捕捉请求成功': (r) => r.status === 200,
    '返回捕捉结果': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success !== undefined;
      } catch {
        return false;
      }
    }
  });

  catchAttemptErrors.add(!success);

  if (success) {
    try {
      const body = JSON.parse(res.body);
      catchSuccessRate.add(body.success === true);
      return body;
    } catch {
      catchSuccessRate.add(false);
      return null;
    }
  }

  catchSuccessRate.add(false);
  return null;
}

// 上报位置
function reportLocation(token, location) {
  const payload = JSON.stringify({
    lat: location.lat,
    lng: location.lng,
    accuracy: 10
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  http.post(`${BASE_URL}/api/location/report`, payload, params);
}

export function setup() {
  console.log('开始精灵捕捉压力测试...');
  console.log(`目标服务: ${BASE_URL}`);

  // 检查服务健康状态
  const healthRes = http.get(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error('服务健康检查失败');
  }

  // 预生成测试用户令牌
  console.log(`预生成 ${TOKEN_POOL_SIZE} 个测试用户...`);
  for (let i = 0; i < TOKEN_POOL_SIZE; i++) {
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
  // 从令牌池随机选择
  const token = tokenPool[Math.floor(Math.random() * tokenPool.length)];

  // 初始化位置
  let location = randomBeijingLocation();

  // 模拟游戏循环
  for (let i = 0; i < 3; i++) {
    // 1. 上报位置
    reportLocation(token, location);
    sleep(0.3);

    // 2. 查询附近精灵
    const nearbyPokemon = findNearbyPokemon(token, location);

    if (nearbyPokemon.length > 0) {
      // 3. 尝试捕捉第一个精灵
      const pokemon = nearbyPokemon[0];
      const result = catchPokemon(token, pokemon.id || pokemon.pokemon_id, location);

      if (result && result.success) {
        // 捕捉成功，继续寻找下一个
        sleep(0.5);
      } else {
        // 捕捉失败或逃跑
        sleep(1);
      }
    } else {
      // 附近没有精灵，移动位置
      sleep(0.5);
    }

    // 4. 移动位置
    location = moveSlightly(location);
    sleep(1);
  }
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`精灵捕捉压力测试完成，耗时: ${duration.toFixed(2)} 秒`);
}
