/**
 * 集成测试全局清理
 * 停止测试容器
 */

module.exports = async function globalTeardown() {
  console.log('🧹 Cleaning up test containers...');

  if (global.__POSTGRES_CONTAINER__) {
    await global.__POSTGRES_CONTAINER__.stop();
    console.log('   PostgreSQL container stopped');
  }

  if (global.__REDIS_CONTAINER__) {
    await global.__REDIS_CONTAINER__.stop();
    console.log('   Redis container stopped');
  }

  console.log('✅ Test containers cleaned up');
};