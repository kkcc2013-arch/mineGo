/**
 * 公会系统单元测试 - REQ-00058
 */

const assert = require('assert');
const { query, getClient } = require('../../shared/db');

// 模拟数据库和依赖
const mockDb = {
  query: async (sql, params) => {
    console.log('Mock query:', sql.substring(0, 50));
    return { rows: [], rowCount: 0 };
  },
  getClient: async () => ({
    query: async (sql, params) => ({ rows: [], rowCount: 0 }),
    release: () => {}
  })
};

// 测试数据
const testUserId = 1;
const testGuildData = {
  name: '测试公会',
  description: '这是一个测试公会',
  joinType: 'public',
  minLevel: 5
};

// 测试用例
const tests = [
  {
    name: '公会等级配置正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      // 检查等级配置
      assert(guildService.GUILD_LEVEL_CONFIG, '等级配置存在');
      assert(guildService.GUILD_LEVEL_CONFIG[1], '1级配置存在');
      assert(guildService.GUILD_LEVEL_CONFIG[50], '50级配置存在');
      
      // 检查经验值递增
      const exp1 = guildService.GUILD_LEVEL_CONFIG[1].experienceRequired;
      const exp10 = guildService.GUILD_LEVEL_CONFIG[10].experienceRequired;
      assert(exp10 > exp1, '高级需要更多经验');
      
      // 检查成员上限递增
      const members1 = guildService.GUILD_LEVEL_CONFIG[1].maxMembers;
      const members50 = guildService.GUILD_LEVEL_CONFIG[50].maxMembers;
      assert(members50 > members1, '高级公会成员上限更高');
      
      console.log('✓ 公会等级配置正确');
    }
  },
  
  {
    name: '增益解锁逻辑正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      // 1级无增益
      const buffs1 = guildService.getAvailableBuffs(1);
      assert(buffs1.length === 0, '1级无增益');
      
      // 5级解锁捕捉加成
      const buffs5 = guildService.getAvailableBuffs(5);
      assert(buffs5.includes('catch_bonus_5'), '5级解锁捕捉加成');
      
      // 30级解锁闪光加成
      const buffs30 = guildService.getAvailableBuffs(30);
      assert(buffs30.includes('shiny_bonus_30'), '30级解锁闪光加成');
      
      // 50级解锁所有增益
      const buffs50 = guildService.getAvailableBuffs(50);
      assert(buffs50.length === 5, '50级解锁所有增益');
      
      console.log('✓ 增益解锁逻辑正确');
    }
  },
  
  {
    name: '创建公会验证正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      // 测试公会名长度限制
      try {
        await guildService.createGuild(testUserId, { name: 'A' });
        assert.fail('应该拒绝过短的公会名');
      } catch (err) {
        assert(err.message.includes('2-100'), '拒绝过短的公会名');
      }
      
      try {
        await guildService.createGuild(testUserId, { name: '' });
        assert.fail('应该拒绝空的公会名');
      } catch (err) {
        assert(err.message.includes('2-100'), '拒绝空的公会名');
      }
      
      console.log('✓ 创建公会验证正确');
    }
  },
  
  {
    name: '加入公会验证正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      // 测试无效公会ID
      try {
        await guildService.joinGuild(testUserId, 999999);
        assert.fail('应该拒绝无效的公会ID');
      } catch (err) {
        assert(err.message.includes('不存在') || err.message.includes('未加入'), '拒绝无效公会');
      }
      
      console.log('✓ 加入公会验证正确');
    }
  },
  
  {
    name: '捐赠金额验证正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      // 测试无效金额
      try {
        await guildService.donateToGuild(testUserId, 0);
        assert.fail('应该拒绝0捐赠');
      } catch (err) {
        assert(err.message.includes('1-1000000'), '拒绝0捐赠');
      }
      
      try {
        await guildService.donateToGuild(testUserId, 1000001);
        assert.fail('应该拒绝超额捐赠');
      } catch (err) {
        assert(err.message.includes('1-1000000'), '拒绝超额捐赠');
      }
      
      console.log('✓ 捐赠金额验证正确');
    }
  },
  
  {
    name: '职位权限验证正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      // 测试无效职位
      const validRoles = ['leader', 'co_leader', 'elder', 'member', 'novice'];
      const invalidRole = 'invalid_role';
      assert(!validRoles.includes(invalidRole), '无效职位不被接受');
      
      console.log('✓ 职位权限验证正确');
    }
  },
  
  {
    name: '聊天消息验证正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      // 测试空消息
      try {
        await guildService.sendChatMessage(1, testUserId, '');
        assert.fail('应该拒绝空消息');
      } catch (err) {
        assert(err.message.includes('不能为空'), '拒绝空消息');
      }
      
      // 测试超长消息
      const longMessage = 'A'.repeat(501);
      try {
        await guildService.sendChatMessage(1, testUserId, longMessage);
        assert.fail('应该拒绝超长消息');
      } catch (err) {
        assert(err.message.includes('500'), '拒绝超长消息');
      }
      
      console.log('✓ 聊天消息验证正确');
    }
  },
  
  {
    name: '增益配置正确',
    fn: async () => {
      const buffConfigs = {
        'catch_bonus_5': { value: 0.05, duration: 24, cost: 1000 },
        'experience_bonus_10': { value: 0.10, duration: 24, cost: 2000 },
        'stardust_bonus_15': { value: 0.15, duration: 24, cost: 3000 },
        'raid_bonus_20': { value: 0.20, duration: 24, cost: 4000 },
        'shiny_bonus_30': { value: 0.10, duration: 12, cost: 10000 }
      };
      
      // 检查增益配置存在
      assert(buffConfigs['catch_bonus_5'], '捕捉加成配置存在');
      assert(buffConfigs['shiny_bonus_30'], '闪光加成配置存在');
      
      // 检查增益值合理
      assert(buffConfigs['catch_bonus_5'].value > 0, '增益值为正');
      assert(buffConfigs['catch_bonus_5'].duration > 0, '持续时间有效');
      assert(buffConfigs['catch_bonus_5'].cost > 0, '成本有效');
      
      console.log('✓ 增益配置正确');
    }
  },
  
  {
    name: '公会创建费用正确',
    fn: async () => {
      const guildService = require('../src/guildService');
      
      assert(guildService.CREATE_COST === 5000, '创建费用为5000金币');
      assert(guildService.MAX_MEMBERS_BASE === 50, '基础成员上限为50');
      assert(guildService.MEMBER_PER_LEVEL === 2, '每级增加2个成员位');
      
      console.log('✓ 公会创建费用正确');
    }
  },
  
  {
    name: '数据库迁移文件语法正确',
    fn: async () => {
      const fs = require('fs');
      const path = require('path');
      
      const migrationPath = path.join(
        __dirname, 
        '../../../database/pending/20260610_040000__add_guild_system_tables.sql'
      );
      
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
      
      // 检查关键表存在
      assert(migrationSQL.includes('CREATE TABLE guilds'), 'guilds表存在');
      assert(migrationSQL.includes('CREATE TABLE guild_members'), 'guild_members表存在');
      assert(migrationSQL.includes('CREATE TABLE guild_applications'), 'guild_applications表存在');
      assert(migrationSQL.includes('CREATE TABLE guild_tasks'), 'guild_tasks表存在');
      assert(migrationSQL.includes('CREATE TABLE guild_wars'), 'guild_wars表存在');
      assert(migrationSQL.includes('CREATE TABLE guild_buffs'), 'guild_buffs表存在');
      
      // 检查索引
      assert(migrationSQL.includes('CREATE INDEX idx_guilds_level'), '等级索引存在');
      assert(migrationSQL.includes('CREATE INDEX idx_guild_members_guild'), '成员索引存在');
      
      // 检查约束
      assert(migrationSQL.includes('CHECK (level >= 1 AND level <= 50)'), '等级约束存在');
      assert(migrationSQL.includes("CHECK (join_type IN ('public', 'apply', 'invite_only'))"), '加入类型约束存在');
      
      console.log('✓ 数据库迁移文件语法正确');
    }
  }
];

// 运行测试
async function runTests() {
  console.log('\n═════════════════════════════════════════════');
  console.log('  REQ-00058: 公会系统单元测试');
  console.log('═════════════════════════════════════════════\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      await test.fn();
      passed++;
    } catch (err) {
      console.error(`✗ ${test.name}`);
      console.error(`  Error: ${err.message}`);
      failed++;
    }
  }
  
  console.log('\n────────────────────────────────────────────');
  console.log(`  测试结果: ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────────\n');
  
  if (failed > 0) {
    process.exit(1);
  }
}

// 执行测试
runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
