// tests/integration/RedisPoolManager.integration.test.js - Redis 连接池集成测试
'use strict';

const { getPoolManager, initPool } = require('../../../shared/RedisPoolManager');

// 集成测试需要真实 Redis 连接（使用 docker-compose 启动）
// 运行前确保 Redis 可用：docker-compose up -d redis

describe('RedisPoolManager Integration Tests', () => {
  let manager;

  beforeAll(async () => {
    // 跳过如果没有 Redis
    if (!process.env.REDIS_HOST && !process.env.REDIS_CLUSTER_NODES) {
      console.log('Skipping integration tests - no Redis configured');
      return;
    }

    manager = getPoolManager({ serviceName: 'integration-test' });
    await initPool('default', {
      minConnections: 2,
      maxConnections: 10,
    });
  });

  afterAll(async () => {
    if (manager) {
      await manager.close();
    }
  });

  describe('Real Redis Operations', () => {
    beforeEach(async () => {
      if (!manager) return;
    });

    it('should execute GET command', async () => {
      if (!manager) return;

      const result = await manager.execute('default', 'set', 'test:key', 'value');
      expect(result).toBe('OK');

      const value = await manager.execute('default', 'get', 'test:key');
      expect(value).toBe('value');
    });

    it('should handle SET with TTL', async () => {
      if (!manager) return;

      const result = await manager.execute('default', 'setex', 'test:ttl', 10, 'expires');
      expect(result).toBe('OK');

      const ttl = await manager.execute('default', 'ttl', 'test:ttl');
      expect(ttl).toBeGreaterThan(0);
    });

    it('should handle DEL command', async () => {
      if (!manager) return;

      await manager.execute('default', 'set', 'test:delete', 'value');
      const result = await manager.execute('default', 'del', 'test:delete');
      expect(result).toBe(1);

      const value = await manager.execute('default', 'get', 'test:delete');
      expect(value).toBeNull();
    });
  });

  describe('Connection Pool Operations', () => {
    it('should handle concurrent requests', async () => {
      if (!manager) return;

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(manager.execute('default', 'set', `test:concurrent:${i}`, `value-${i}`));
      }

      const results = await Promise.all(promises);
      expect(results.every((r) => r === 'OK')).toBe(true);
    });

    it('should track pool stats', async () => {
      if (!manager) return;

      const stats = manager.getPoolStats('default');

      expect(stats).toBeDefined();
      expect(stats.name).toBe('default');
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.health).toBeDefined();
    });
  });

  describe('Health Check', () => {
    it('should perform health check', async () => {
      if (!manager) return;

      const health = await manager.healthCheck('default');

      expect(health.status).toBe('healthy');
      expect(health.latency).toBeGreaterThan(0);
    });

    it('should detect connection latency', async () => {
      if (!manager) return;

      // 多次 PING 检测延迟
      for (let i = 0; i < 5; i++) {
        const health = await manager.healthCheck('default');
        expect(health.latency).toBeLessThan(100); // < 100ms
      }
    });
  });

  describe('Leak Detection', () => {
    it('should detect no leaks under normal operation', async () => {
      if (!manager) return;

      const conn = await manager.acquire('default');
      await manager.release(conn, 'default');

      const leaks = manager.detectLeaks('default');
      expect(leaks.length).toBe(0);
    });

    it('should track connection lifecycle', async () => {
      if (!manager) return;

      const stats1 = manager.getPoolStats('default');

      const conn = await manager.acquire('default');
      const stats2 = manager.getPoolStats('default');
      expect(stats2.active).toBe(stats1.active + 1);

      await manager.release(conn, 'default');
      const stats3 = manager.getPoolStats('default');
      expect(stats3.active).toBe(stats1.active);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid command', async () => {
      if (!manager) return;

      await expect(manager.execute('default', 'invalidCommand')).rejects.toThrow();
    });

    it('should handle connection timeout gracefully', async () => {
      if (!manager) return;

      // 创建新池并获取连接
      await initPool('timeout-test', { acquireTimeout: 100 });

      // 尝试超出限制的并发获取
      const promises = [];
      for (let i = 0; i < 25; i++) {
        promises.push(
          manager.acquire('timeout-test').catch((err) => err.message)
        );
      }

      const results = await Promise.all(promises);
      const timeouts = results.filter((r) => r.includes('timeout'));
      expect(timeouts.length).toBeGreaterThan(0);
    }, 10000);
  });
});
