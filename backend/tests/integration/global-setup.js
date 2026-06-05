/**
 * 集成测试全局设置
 * 启动 PostgreSQL 和 Redis 测试容器
 */

const { GenericContainer } = require('testcontainers');

module.exports = async function globalSetup() {
  console.log('🚀 Starting test containers...');

  // PostgreSQL 测试容器
  const postgresContainer = await new GenericContainer('postgres:15')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'minego_test'
    })
    .withExposedPorts(5432)
    .start();

  // Redis 测试容器
  const redisContainer = await new GenericContainer('redis:7')
    .withExposedPorts(6379)
    .start();

  // 存储到全局变量
  global.__POSTGRES_CONTAINER__ = postgresContainer;
  global.__REDIS_CONTAINER__ = redisContainer;

  // 设置环境变量
  process.env.TEST_POSTGRES_HOST = postgresContainer.getHost();
  process.env.TEST_POSTGRES_PORT = postgresContainer.getMappedPort(5432);
  process.env.TEST_REDIS_HOST = redisContainer.getHost();
  process.env.TEST_REDIS_PORT = redisContainer.getMappedPort(6379);
  process.env.TEST_DATABASE_URL = `postgresql://test:test@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/minego_test`;
  process.env.TEST_REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  console.log('✅ Test containers started');
  console.log(`   PostgreSQL: ${process.env.TEST_DATABASE_URL}`);
  console.log(`   Redis: ${process.env.TEST_REDIS_URL}`);
};