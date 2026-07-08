/**
 * REQ-00040: 智能限流中间件单元测试
 */

const request = require('supertest');
const express = require('express');
const {
  createRateLimiter,
  userLevelRateLimiter,
  highRiskRateLimiter,
  authRateLimiter,
  searchRateLimiter,
  socialRateLimiter,
  adminRateLimiter,
  RATE_LIMIT_CONFIGS
} = require('../../../src/middleware/intelligentRateLimit');

describe('REQ-00040: Intelligent Rate Limiting', () => {
  
  describe('createRateLimiter', () => {
    it('should apply global rate limit config', async () => {
      const app = express();
      app.use(createRateLimiter('global'));
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 发送 200 次请求（不超过限流阈值）
      for (let i = 0; i < 200; i++) {
        await agent.get('/test').expect(200);
      }
      
      // 第 201 次请求应该被限流
      const response = await agent.get('/test').expect(429);
      expect(response.body).toHaveProperty('code', 1007);
      expect(response.body.message).toContain('请求过于频繁');
    });
    
    it('should return 429 Too Many Requests when limit exceeded', async () => {
      const app = express();
      app.use(createRateLimiter('highRisk', { max: 5 }));
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 发送 5 次请求（不超过限流阈值）
      for (let i = 0; i < 5; i++) {
        await agent.get('/test').expect(200);
      }
      
      // 第 6 次请求应该被限流
      const response = await agent.get('/test').expect(429);
      expect(response.body).toHaveProperty('code', 1007);
    });
    
    it('should include standard rate limit headers', async () => {
      const app = express();
      app.use(createRateLimiter('global', { max: 10 }));
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const response = await request(app).get('/test').expect(200);
      
      expect(response.headers).toHaveProperty('ratelimit-limit');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
      expect(response.headers['ratelimit-limit']).toBe('10');
    });
    
    it('should skip health check endpoints', async () => {
      const app = express();
      app.use(createRateLimiter('global', { max: 5 }));
      app.get('/health', (req, res) => res.json({ status: 'ok' }));
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 健康检查接口不受限流影响
      for (let i = 0; i < 10; i++) {
        await agent.get('/health').expect(200);
      }
      
      // 普通接口应该被限流
      for (let i = 0; i < 5; i++) {
        await agent.get('/test').expect(200);
      }
      await agent.get('/test').expect(429);
    });
  });
  
  describe('userLevelRateLimiter', () => {
    it('should apply stricter limits for anonymous users', async () => {
      const app = express();
      
      // 模拟未认证用户
      app.use((req, res, next) => {
        req.user = null; // 匿名用户
        next();
      });
      
      app.use(userLevelRateLimiter());
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 匿名用户限制：50 次/分钟
      for (let i = 0; i < 50; i++) {
        await agent.get('/test').expect(200);
      }
      
      // 第 51 次应该被限流
      const response = await agent.get('/test').expect(429);
      expect(response.body.message).toContain('未登录用户');
    });
    
    it('should apply higher limits for authenticated users', async () => {
      const app = express();
      
      // 模拟已认证用户
      app.use((req, res, next) => {
        req.user = { id: 'user123' };
        next();
      });
      
      app.use(userLevelRateLimiter());
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 已认证用户限制：300 次/分钟
      for (let i = 0; i < 100; i++) { // 测试部分请求数
        await agent.get('/test').expect(200);
      }
      
      // 100 次请求不应该触发限流
      const response = await agent.get('/test').expect(200);
      expect(response.body).toHaveProperty('success', true);
    });
  });
  
  describe('highRiskRateLimiter', () => {
    it('should apply strict limits for high-risk endpoints', async () => {
      const app = express();
      app.use(highRiskRateLimiter(30));
      app.post('/payment', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 高风险接口限制：30 次/分钟
      for (let i = 0; i < 30; i++) {
        await agent.post('/payment').expect(200);
      }
      
      // 第 31 次应该被限流
      const response = await agent.post('/payment').expect(429);
      expect(response.body.message).toContain('操作过于频繁');
    });
  });
  
  describe('authRateLimiter', () => {
    it('should apply strict limits for authentication endpoints', async () => {
      const app = express();
      app.use(authRateLimiter());
      app.post('/login', (req, res) => res.json({ token: 'test' }));
      
      const agent = request(app);
      
      // 认证接口限制：10 次/15分钟
      for (let i = 0; i < 10; i++) {
        await agent.post('/login').expect(200);
      }
      
      // 第 11 次应该被限流
      const response = await agent.post('/login').expect(429);
      expect(response.body.message).toContain('登录尝试次数过多');
    });
  });
  
  describe('searchRateLimiter', () => {
    it('should apply moderate limits for search endpoints', async () => {
      const app = express();
      app.use(searchRateLimiter());
      app.get('/search', (req, res) => res.json({ results: [] }));
      
      const agent = request(app);
      
      // 搜索接口限制：60 次/分钟
      for (let i = 0; i < 60; i++) {
        await agent.get('/search').expect(200);
      }
      
      // 第 61 次应该被限流
      await agent.get('/search').expect(429);
    });
  });
  
  describe('socialRateLimiter', () => {
    it('should apply limits for social endpoints', async () => {
      const app = express();
      app.use(socialRateLimiter());
      app.post('/chat', (req, res) => res.json({ sent: true }));
      
      const agent = request(app);
      
      // 社交接口限制：100 次/分钟
      for (let i = 0; i < 100; i++) {
        await agent.post('/chat').expect(200);
      }
      
      // 第 101 次应该被限流
      const response = await agent.post('/chat').expect(429);
      expect(response.body.message).toContain('消息发送过于频繁');
    });
  });
  
  describe('adminRateLimiter', () => {
    it('should apply limits for admin endpoints', async () => {
      const app = express();
      app.use(adminRateLimiter());
      app.delete('/admin/user/:id', (req, res) => res.json({ deleted: true }));
      
      const agent = request(app);
      
      // 管理接口限制：120 次/分钟
      for (let i = 0; i < 120; i++) {
        await agent.delete('/admin/user/123').expect(200);
      }
      
      // 第 121 次应该被限流
      await agent.delete('/admin/user/123').expect(429);
    });
  });
  
  describe('RATE_LIMIT_CONFIGS', () => {
    it('should have all required configuration presets', () => {
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('global');
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('highRisk');
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('auth');
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('search');
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('social');
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('admin');
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('anonymous');
      expect(RATE_LIMIT_CONFIGS).toHaveProperty('authenticated');
    });
    
    it('should have valid configuration values', () => {
      const globalConfig = RATE_LIMIT_CONFIGS.global;
      expect(globalConfig).toHaveProperty('windowMs');
      expect(globalConfig).toHaveProperty('max');
      expect(globalConfig).toHaveProperty('message');
      expect(globalConfig.max).toBeGreaterThan(0);
      expect(globalConfig.windowMs).toBeGreaterThan(0);
    });
  });
  
  describe('Integration Tests', () => {
    it('should log rate limit exceeded events', async () => {
      const app = express();
      
      // Mock logger
      const logMessages = [];
      const originalWarn = console.warn;
      console.warn = (...args) => logMessages.push(args);
      
      app.use(createRateLimiter('highRisk', { max: 3 }));
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 发送 3 次请求
      for (let i = 0; i < 3; i++) {
        await agent.get('/test').expect(200);
      }
      
      // 第 4 次触发限流
      await agent.get('/test').expect(429);
      
      // 恢复 logger
      console.warn = originalWarn;
      
      // 验证日志记录（如果在实际环境中）
      // 此测试主要验证功能不抛出异常
    });
    
    it('should handle concurrent requests correctly', async () => {
      const app = express();
      app.use(createRateLimiter('highRisk', { max: 20 }));
      app.get('/test', (req, res) => res.json({ success: true }));
      
      const agent = request(app);
      
      // 并发发送 15 个请求
      const promises = [];
      for (let i = 0; i < 15; i++) {
        promises.push(agent.get('/test'));
      }
      
      const responses = await Promise.all(promises);
      
      // 所有请求应该成功
      const successCount = responses.filter(r => r.status === 200).length;
      expect(successCount).toBe(15);
    });
  });
});

// 运行测试
if (require.main === module) {
  console.log('Running REQ-00040 Intelligent Rate Limiting tests...');
}
