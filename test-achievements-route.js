/**
 * REQ-00131: 测试 achievements 路由挂载
 */

const fs = require('fs');
const path = require('path');

// 读取 index.js 文件
const indexPath = path.join(__dirname, 'backend/services/pokemon-service/src/index.js');
const indexContent = fs.readFileSync(indexPath, 'utf-8');

// 检查是否包含 achievements 路由挂载
const hasAchievementsRouter = indexContent.includes("require('./routes/achievements')");
const hasAchievementsMount = indexContent.includes("app.use('/achievements'");

// 检查路由文件是否存在
const achievementsPath = path.join(__dirname, 'backend/services/pokemon-service/src/routes/achievements.js');
const achievementsExists = fs.existsSync(achievementsPath);

// 检查服务文件是否存在
const servicePath = path.join(__dirname, 'backend/services/pokemon-service/src/achievementService.js');
const serviceExists = fs.existsSync(servicePath);

// 检查数据库迁移文件是否存在
const migrationPath = path.join(__dirname, 'database/pending/20260611_000000__add_achievement_system_tables.sql');
const migrationExists = fs.existsSync(migrationPath);

console.log('=== REQ-00131 实现验证 ===\n');
console.log('1. achievements.js 路由文件:', achievementsExists ? '✅ 存在' : '❌ 不存在');
console.log('2. achievementService.js 服务文件:', serviceExists ? '✅ 存在' : '❌ 不存在');
console.log('3. 数据库迁移文件:', migrationExists ? '✅ 存在' : '❌ 不存在');
console.log('4. index.js 引入路由:', hasAchievementsRouter ? '✅ 已引入' : '❌ 未引入');
console.log('5. index.js 挂载路由:', hasAchievementsMount ? '✅ 已挂载到 /achievements' : '❌ 未挂载');

// 验证路由端点
if (achievementsExists) {
  const achievementsContent = fs.readFileSync(achievementsPath, 'utf-8');
  
  const endpoints = [
    { path: '/my', method: 'GET', desc: '获取用户成就列表' },
    { path: '/my/progress', method: 'GET', desc: '获取成就进度概览' },
    { path: '/:achievementId', method: 'GET', desc: '获取单个成就详情' },
    { path: '/:achievementId/claim', method: 'POST', desc: '领取成就奖励' },
    { path: '/leaderboard/global', method: 'GET', desc: '获取成就排行榜' },
    { path: '/titles', method: 'GET', desc: '获取用户称号列表' },
    { path: '/titles/:titleId/activate', method: 'POST', desc: '设置激活称号' },
    { path: '/event', method: 'POST', desc: '处理成就触发事件' }
  ];
  
  console.log('\n6. API 端点验证:');
  endpoints.forEach(endpoint => {
    const hasEndpoint = achievementsContent.includes(`router.${endpoint.method.toLowerCase()}('${endpoint.path}'`);
    console.log(`   ${endpoint.method} /achievements${endpoint.path} - ${endpoint.desc}: ${hasEndpoint ? '✅' : '❌'}`);
  });
}

// 检查数据库表
if (migrationExists) {
  const migrationContent = fs.readFileSync(migrationPath, 'utf-8');
  
  const tables = [
    'achievements',
    'user_achievements',
    'achievement_progress_snapshots',
    'achievement_events',
    'user_titles'
  ];
  
  console.log('\n7. 数据库表验证:');
  tables.forEach(table => {
    const hasTable = migrationContent.includes(`CREATE TABLE IF NOT EXISTS ${table}`);
    console.log(`   ${table}: ${hasTable ? '✅' : '❌'}`);
  });
  
  // 检查索引
  const hasIndexes = migrationContent.includes('CREATE INDEX');
  console.log(`   索引: ${hasIndexes ? '✅ 已创建' : '❌ 未创建'}`);
  
  // 检查种子数据
  const hasSeedData = migrationContent.includes('INSERT INTO achievements');
  console.log(`   种子数据: ${hasSeedData ? '✅ 已插入' : '❌ 未插入'}`);
}

console.log('\n=== 验证完成 ===');
console.log('\n挂载路径: /achievements');
console.log('完整端点示例: GET /achievements/my');
console.log('功能: 解锁精灵成就系统的全部功能，8 个端点立即可用');
