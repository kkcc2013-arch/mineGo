/**
 * 微服务集成测试运行器
 * 管理测试环境、服务容器、数据库连接等
 */

const { Docker } = require('dockerode');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { Kafka, CompressionTypes } = require('kafkajs');
const path = require('path');
const fs = require('fs').promises;

class IntegrationTestRunner {
  constructor(config = {}) {
    this.config = {
      services: config.services || [],
      timeout: config.timeout || 60000,
      databaseImage: config.databaseImage || 'postgres:15',
      redisImage: config.redisImage || 'redis:7-alpine',
      kafkaImage: config.kafkaImage || 'confluentinc/cp-kafka:7.4.0',
      ...config
    };
    
    this.containers = new Map();
    this.dbPool = null;
    this.redisClient = null;
    this.kafkaProducer = null;
    this.kafkaConsumer = null;
    this.gatewayUrl = null;
    this.serviceUrls = new Map();
    this.docker = new Docker();
    this.testContext = null;
  }

  /**
   * 设置测试环境
   */
  async setup() {
    console.log('[TestRunner] Starting integration test environment setup...');
    
    try {
      // 1. 启动测试数据库容器
      await this.startDatabase();
      console.log('[TestRunner] Database container started');
      
      // 2. 启动 Redis 测试实例
      await this.startRedis();
      console.log('[TestRunner] Redis container started');
      
      // 3. 运行数据库迁移
      await this.runMigrations();
      console.log('[TestRunner] Database migrations completed');
      
      // 4. 清理测试数据
      await this.cleanTestData();
      console.log('[TestRunner] Test data cleaned');
      
      // 5. 设置测试上下文
      this.testContext = {
        dbPool: this.dbPool,
        redisClient: this.redisClient,
        gatewayUrl: this.gatewayUrl,
        serviceUrls: this.serviceUrls
      };
      
      console.log('[TestRunner] Integration test environment ready');
      return this.testContext;
      
    } catch (error) {
      console.error('[TestRunner] Setup failed:', error);
      await this.teardown();
      throw error;
    }
  }

  /**
   * 启动数据库容器
   */
  async startDatabase() {
    const containerName = `minego-test-postgres-${Date.now()}`;
    
    try {
      // 创建 PostgreSQL 容器
      const container = await this.docker.createContainer({
        Image: this.config.databaseImage,
        name: containerName,
        Env: [
          'POSTGRES_USER=test',
          'POSTGRES_PASSWORD=test',
          'POSTGRES_DB=minego_test'
        ],
        HostConfig: {
          PortBindings: { '5432/tcp': [{ HostPort: '0' }] },
          AutoRemove: true
        },
        Healthcheck: {
          Test: ['CMD-SHELL', 'pg_isready -U test -d minego_test'],
          Interval: 5000,
          Timeout: 3000,
          Retries: 10
        }
      });
      
      await container.start();
      this.containers.set('postgres', container);
      
      // 等待容器健康
      await this.waitForContainerHealth(container, 'postgres');
      
      // 获取动态端口
      const inspect = await container.inspect();
      const port = inspect.NetworkSettings.Ports['5432/tcp'][0].HostPort;
      
      // 创建连接池
      this.dbPool = new Pool({
        host: 'localhost',
        port: parseInt(port),
        user: 'test',
        password: 'test',
        database: 'minego_test',
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });
      
      // 测试连接
      await this.dbPool.query('SELECT NOW()');
      console.log(`[TestRunner] Database connected on port ${port}`);
      
      return { host: 'localhost', port };
      
    } catch (error) {
      console.error('[TestRunner] Failed to start database:', error);
      throw error;
    }
  }

  /**
   * 启动 Redis 容器
   */
  async startRedis() {
    const containerName = `minego-test-redis-${Date.now()}`;
    
    try {
      const container = await this.docker.createContainer({
        Image: this.config.redisImage,
        name: containerName,
        HostConfig: {
          PortBindings: { '6379/tcp': [{ HostPort: '0' }] },
          AutoRemove: true
        },
        Healthcheck: {
          Test: ['CMD', 'redis-cli', 'ping'],
          Interval: 5000,
          Timeout: 3000,
          Retries: 10
        }
      });
      
      await container.start();
      this.containers.set('redis', container);
      
      // 等待容器健康
      await this.waitForContainerHealth(container, 'redis');
      
      // 获取动态端口
      const inspect = await container.inspect();
      const port = inspect.NetworkSettings.Ports['6379/tcp'][0].HostPort;
      
      // 创建 Redis 客户端
      this.redisClient = new Redis({
        host: 'localhost',
        port: parseInt(port),
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100
      });
      
      // 测试连接
      await this.redisClient.ping();
      console.log(`[TestRunner] Redis connected on port ${port}`);
      
      return { host: 'localhost', port };
      
    } catch (error) {
      console.error('[TestRunner] Failed to start Redis:', error);
      throw error;
    }
  }

  /**
   * 等待容器健康检查通过
   */
  async waitForContainerHealth(container, name, maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      const inspect = await container.inspect();
      const health = inspect.State.Health;
      
      if (health && health.Status === 'healthy') {
        console.log(`[TestRunner] ${name} container is healthy`);
        return true;
      }
      
      console.log(`[TestRunner] Waiting for ${name} container health... (${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Container ${name} did not become healthy within timeout`);
  }

  /**
   * 运行数据库迁移
   */
  async runMigrations() {
    const migrationsPath = path.join(__dirname, '../../../database/migrations');
    
    try {
      // 检查迁移文件是否存在
      const files = await fs.readdir(migrationsPath);
      const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();
      
      // 查询已执行的迁移
      let executedMigrations = [];
      try {
        const result = await this.dbPool.query(
          'SELECT name FROM schema_migrations ORDER BY name'
        );
        executedMigrations = result.rows.map(r => r.name);
      } catch (e) {
        // 表不存在，创建它
        await this.dbPool.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name VARCHAR(255) PRIMARY KEY,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
      }
      
      // 执行未执行的迁移
      for (const file of sqlFiles) {
        if (!executedMigrations.includes(file)) {
          console.log(`[TestRunner] Running migration: ${file}`);
          
          const migrationSql = await fs.readFile(
            path.join(migrationsPath, file),
            'utf8'
          );
          
          await this.dbPool.query(migrationSql);
          await this.dbPool.query(
            'INSERT INTO schema_migrations (name) VALUES ($1)',
            [file]
          );
        }
      }
      
      console.log('[TestRunner] All migrations executed');
      
    } catch (error) {
      console.error('[TestRunner] Migration failed:', error);
      throw error;
    }
  }

  /**
   * 清理测试数据
   */
  async cleanTestData() {
    const tables = [
      'pokemon',
      'users',
      'items',
      'catch_sessions',
      'battle_sessions',
      'transactions',
      'events',
      'achievements',
      'friendships',
      'guilds',
      'notifications'
    ];
    
    for (const table of tables) {
      try {
        await this.dbPool.query(`TRUNCATE TABLE ${table} CASCADE`);
      } catch (e) {
        // 表不存在，忽略
      }
    }
    
    // 清理 Redis 数据
    if (this.redisClient) {
      await this.redisClient.flushall();
    }
  }

  /**
   * 获取测试上下文
   */
  getContext() {
    return this.testContext;
  }

  /**
   * 创建测试用户并获取访问令牌
   */
  async createTestUser(overrides = {}) {
    const { v4: uuidv4 } = require('uuid');
    const bcrypt = require('bcrypt');
    
    const userId = uuidv4();
    const email = overrides.email || `test-${Date.now()}@example.com`;
    const username = overrides.username || `testuser-${Date.now()}`;
    const passwordHash = await bcrypt.hash('testpass123', 10);
    
    await this.dbPool.query(
      `INSERT INTO users (
        id, email, username, password_hash, level, experience, coins, stardust,
        created_at, last_login_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        email,
        username,
        passwordHash,
        overrides.level || 1,
        overrides.experience || 0,
        overrides.coins || 1000,
        overrides.stardust || 10000,
        new Date(),
        new Date()
      ]
    );
    
    return {
      id: userId,
      email,
      username,
      password: 'testpass123',
      ...overrides
    };
  }

  /**
   * 清理并关闭测试环境
   */
  async teardown() {
    console.log('[TestRunner] Tearing down test environment...');
    
    // 关闭数据库连接池
    if (this.dbPool) {
      try {
        await this.dbPool.end();
        console.log('[TestRunner] Database pool closed');
      } catch (e) {
        console.error('[TestRunner] Failed to close database pool:', e);
      }
    }
    
    // 关闭 Redis 连接
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
        console.log('[TestRunner] Redis client closed');
      } catch (e) {
        console.error('[TestRunner] Failed to close Redis client:', e);
      }
    }
    
    // 停止所有容器
    for (const [name, container] of this.containers) {
      try {
        await container.stop();
        console.log(`[TestRunner] ${name} container stopped`);
      } catch (e) {
        console.error(`[TestRunner] Failed to stop ${name} container:`, e);
      }
    }
    
    this.containers.clear();
    console.log('[TestRunner] Test environment teardown complete');
  }

  /**
   * 获取容器端口
   */
  async getContainerPort(container, internalPort) {
    const inspect = await container.inspect();
    return inspect.NetworkSettings.Ports[`${internalPort}/tcp`]?.[0]?.HostPort;
  }

  /**
   * 等待服务就绪
   */
  async waitForService(url, maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return true;
        }
      } catch (e) {
        // 服务未就绪
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Service at ${url} did not become ready within timeout`);
  }
}

module.exports = IntegrationTestRunner;