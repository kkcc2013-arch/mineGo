/**
 * mineGo API 压力测试配置
 * 
 * 定义各 API 端点的性能 SLA（服务级别协议）
 */

module.exports = {
  // 测试环境配置
  environments: {
    local: {
      baseUrl: 'http://localhost:8080',
      dbHost: 'localhost',
      redisHost: 'localhost'
    },
    staging: {
      baseUrl: 'http://staging.minego.example.com',
      dbHost: 'staging-db.minego.example.com',
      redisHost: 'staging-redis.minego.example.com'
    }
  },

  // 性能 SLA 定义
  sla: {
    // 用户认证
    'auth/login': {
      throughput: 200,        // req/s
      latencyP50: 50,         // ms
      latencyP90: 100,        // ms
      latencyP99: 150,        // ms
      errorRate: 0.001        // 0.1%
    },
    'auth/register': {
      throughput: 100,
      latencyP50: 80,
      latencyP90: 150,
      latencyP99: 250,
      errorRate: 0.001
    },

    // 精灵捕捉
    'catch/attempt': {
      throughput: 150,
      latencyP50: 100,
      latencyP90: 200,
      latencyP99: 300,
      errorRate: 0.005        // 0.5%
    },
    'pokemon/nearby': {
      throughput: 300,
      latencyP50: 80,
      latencyP90: 150,
      latencyP99: 200,
      errorRate: 0.001
    },
    'pokemon/inventory': {
      throughput: 200,
      latencyP50: 60,
      latencyP90: 120,
      latencyP99: 180,
      errorRate: 0.001
    },

    // 道馆战斗
    'gym/battle': {
      throughput: 100,
      latencyP50: 150,
      latencyP90: 300,
      latencyP99: 400,
      errorRate: 0.005
    },
    'gym/list': {
      throughput: 200,
      latencyP50: 80,
      latencyP90: 150,
      latencyP99: 200,
      errorRate: 0.001
    },

    // 支付
    'payment/create': {
      throughput: 50,
      latencyP50: 200,
      latencyP90: 350,
      latencyP99: 500,
      errorRate: 0.001
    },
    'payment/verify': {
      throughput: 50,
      latencyP50: 150,
      latencyP90: 250,
      latencyP99: 400,
      errorRate: 0.001
    },

    // 社交
    'social/friends': {
      throughput: 200,
      latencyP50: 50,
      latencyP90: 100,
      latencyP99: 150,
      errorRate: 0.001
    },
    'social/add-friend': {
      throughput: 100,
      latencyP50: 100,
      latencyP90: 200,
      latencyP99: 300,
      errorRate: 0.002
    },

    // 奖励
    'reward/daily': {
      throughput: 150,
      latencyP50: 80,
      latencyP90: 150,
      latencyP99: 200,
      errorRate: 0.001
    },
    'reward/claim': {
      throughput: 100,
      latencyP50: 100,
      latencyP90: 200,
      latencyP99: 300,
      errorRate: 0.002
    }
  },

  // 性能回归阈值
  regressionThresholds: {
    latencyIncrease: 0.20,    // P99 延迟增长超过 20% 为回归
    throughputDecrease: 0.15, // 吞吐量下降超过 15% 为回归
    errorRateIncrease: 0.01   // 错误率增长超过 1% 为回归
  },

  // 测试配置
  testConfig: {
    // 负载测试
    load: {
      vus: 100,               // 虚拟用户数
      duration: '5m',         // 持续时间
      rampUp: '30s'           // 爬升时间
    },
    // 压力测试
    stress: {
      stages: [
        { duration: '2m', target: 100 },
        { duration: '5m', target: 500 },
        { duration: '2m', target: 1000 },
        { duration: '2m', target: 0 }
      ]
    },
    // 峰值测试
    spike: {
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 1000 },
        { duration: '30s', target: 100 }
      ]
    },
    // 浸泡测试
    soak: {
      vus: 200,
      duration: '1h'
    }
  }
};
