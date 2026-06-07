import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

/**
 * mineGo API 压力测试 - 道馆战斗场景
 * 
 * 测试道馆战斗流程：查询道馆 → 进入战斗 → 攻击/防御 → 结算
 */

// 自定义指标
const gymListLatency = new Trend('gym_list_latency');
const gymBattleLatency = new Trend('gym_battle_latency');
const battleSuccessRate = new Rate('battle_success_rate');
const gymListErrors = new Rate('gym_list_errors');
const gymBattleErrors = new Rate('gym_battle_errors');

// 测试配置
export const options = {
  scenarios: {
    // 道馆查询负载
    gym_list_load: {
      executor: 'constant-vus',
      vus: 100,
      duration: '3m',
      exec: 'listGyms'
    },
    // 道馆战斗负载
    gym_battle_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 30 },
        { duration: '3m', target: 80 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 }
      ],
      exec: 'battleGym',
      startTime: '3m30s'
    }
  },
  thresholds: {
    http_req_duration: ['p(50)<150', 'p(90)<300', 'p(99)<500'],
    http_req_failed: ['rate<0.02'],
    battle_success_rate: ['rate>0.80'],
    gym_list_errors: ['rate<0.01'],
    gym_battle_errors: ['rate<0.01']
  }
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 测试用户令牌池
let tokenPool = [];

// 生成随机 GPS 坐标（北京附近）
function randomBeijingLocation() {
  const lat = 39.9042 + (Math.random() - 0.5) * 0.05;
  const lng = 116.4074 + (Math.random() - 0.5) * 0.05;
  return { lat, lng };
}

// 注册测试用户
function registerTestUser(index) {
  const timestamp = Date.now();
  const payload = JSON.stringify({
    username: `gym_user_${timestamp}_${index}`,
    email: `gym_${timestamp}_${index}@test.minego.local`,
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

// 查询附近道馆
function findNearbyGyms(token, location) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const startTime = Date.now();
  const res = http.get(
    `${BASE_URL}/api/gym/nearby?lat=${location.lat}&lng=${location.lng}&radius=1000`,
    params
  );
  gymListLatency.add(Date.now() - startTime);

  const success = check(res, {
    '道馆查询成功': (r) => r.status === 200,
    '返回道馆列表': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.gyms) || Array.isArray(body.data);
      } catch {
        return false;
      }
    }
  });

  gymListErrors.add(!success);

  if (success) {
    try {
      const body = JSON.parse(res.body);
      return body.gyms || body.data || [];
    } catch {
      return [];
    }
  }

  return [];
}

// 获取道馆详情
function getGymDetail(token, gymId) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const res = http.get(`${BASE_URL}/api/gym/${gymId}`, params);

  if (res.status === 200) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }
  return null;
}

// 开始道馆战斗
function startBattle(token, gymId, attackerPokemons) {
  const payload = JSON.stringify({
    gym_id: gymId,
    attacker_pokemons: attackerPokemons
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/api/gym/battle/start`, payload, params);

  const success = check(res, {
    '开始战斗成功': (r) => r.status === 200
  });

  if (success) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }
  return null;
}

// 执行战斗回合
function executeBattleRound(token, battleId, actions) {
  const payload = JSON.stringify({
    battle_id: battleId,
    actions: actions
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/api/gym/battle/action`, payload, params);
  gymBattleLatency.add(Date.now() - startTime);

  const success = check(res, {
    '战斗回合成功': (r) => r.status === 200
  });

  gymBattleErrors.add(!success);

  if (success) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }
  return null;
}

// 结束战斗
function endBattle(token, battleId) {
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const res = http.post(`${BASE_URL}/api/gym/battle/${battleId}/end`, null, params);

  const success = check(res, {
    '结束战斗成功': (r) => r.status === 200
  });

  battleSuccessRate.add(success);

  if (success) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }
  return null;
}

export function setup() {
  console.log('开始道馆战斗压力测试...');
  console.log(`目标服务: ${BASE_URL}`);

  // 检查服务健康状态
  const healthRes = http.get(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error('服务健康检查失败');
  }

  // 预生成测试用户
  console.log('预生成测试用户...');
  for (let i = 0; i < 30; i++) {
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

// 道馆查询场景
export function listGyms() {
  const token = tokenPool[Math.floor(Math.random() * tokenPool.length)];
  const location = randomBeijingLocation();

  findNearbyGyms(token, location);
  sleep(2);
}

// 道馆战斗场景
export function battleGym() {
  const token = tokenPool[Math.floor(Math.random() * tokenPool.length)];
  const location = randomBeijingLocation();

  // 1. 查询附近道馆
  const gyms = findNearbyGyms(token, location);

  if (gyms.length === 0) {
    sleep(1);
    return;
  }

  sleep(0.5);

  // 2. 选择一个道馆
  const gym = gyms[0];
  const gymDetail = getGymDetail(token, gym.id || gym.gym_id);

  if (!gymDetail) {
    sleep(1);
    return;
  }

  sleep(0.3);

  // 3. 开始战斗
  const attackerPokemons = [1, 2, 3]; // 模拟精灵 ID
  const battle = startBattle(token, gym.id || gym.gym_id, attackerPokemons);

  if (!battle || !battle.battle_id) {
    sleep(1);
    return;
  }

  // 4. 执行多回合战斗
  for (let round = 0; round < 5; round++) {
    const actions = [
      { type: 'attack', target: 'defender', power: 50 }
    ];

    const result = executeBattleRound(token, battle.battle_id, actions);

    if (!result) {
      break;
    }

    // 检查战斗是否结束
    if (result.battle_ended) {
      break;
    }

    sleep(0.5);
  }

  // 5. 结束战斗
  endBattle(token, battle.battle_id);
  sleep(1);
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`道馆战斗压力测试完成，耗时: ${duration.toFixed(2)} 秒`);
}
