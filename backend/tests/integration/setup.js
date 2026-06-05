/**
 * 集成测试环境设置
 * 在每个测试文件前运行
 */

const { Client } = require('pg');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

// 增加测试超时时间
jest.setTimeout(30000);

let pgClient;
let redisClient;

// 测试前初始化数据库和 Redis 连接
beforeAll(async () => {
  // PostgreSQL 连接
  pgClient = new Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await pgClient.connect();

  // Redis 连接
  redisClient = new Redis(process.env.TEST_REDIS_URL);

  // 初始化数据库 schema
  const schemaSql = fs.readFileSync(
    path.join(__dirname, '../../../database/migrations/V1__initial_schema.sql'),
    'utf8'
  );
  
  // 执行 schema（简化处理，跳过错误）
  try {
    await pgClient.query(schemaSql);
  } catch (err) {
    // 忽略表已存在错误
    if (!err.message.includes('already exists')) {
      console.error('Schema init error:', err.message);
    }
  }

  // 保存到全局
  global.__PG_CLIENT__ = pgClient;
  global.__REDIS_CLIENT__ = redisClient;
});

// 每个测试后清理数据
afterEach(async () => {
  if (pgClient) {
    // 清理测试数据
    await pgClient.query('TRUNCATE TABLE users, pokemons, caught_pokemons, gym_battles RESTART IDENTITY CASCADE');
  }
  if (redisClient) {
    // 清理 Redis 缓存
    await redisClient.flushdb();
  }
});

// 测试后关闭连接
afterAll(async () => {
  if (pgClient) {
    await pgClient.end();
  }
  if (redisClient) {
    await redisClient.quit();
  }
});

// 导出测试工具
global.testUtils = {
  getPgClient: () => global.__PG_CLIENT__,
  getRedisClient: () => global.__REDIS_CLIENT__,
};