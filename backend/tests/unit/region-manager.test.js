/**
 * 区域管理器单元测试
 * 
 * @requirement REQ-00083
 */

const assert = require('assert');
const { RegionManager } = require('../../shared/RegionManager');

// Mock 数据库和 Redis
const mockPool = {
  query: async (sql, params) => {
    // 模拟区域检测
    if (sql.includes('ST_Contains')) {
      return {
        rows: [{
          code: 'CN',
          name: '中国',
          level: 'country',
          timezone: 'Asia/Shanghai',
          currency: 'CNY',
          language: 'zh-CN',
          compliance_rules: { restricted_pokemon: [] }
        }]
      };
    }
    
    // 模拟精灵权重查询
    if (sql.includes('active_region_pokemon_weights')) {
      return {
        rows: [
          { pokemon_id: 25, spawn_weight: 2.0, is_exclusive: false },
          { pokemon_id: 133, spawn_weight: 1.5, is_exclusive: false }
        ]
      };
    }
    
    // 模拟专属精灵查询
    if (sql.includes('is_exclusive = true')) {
      return {
        rows: [
          { pokemon_id: 311 },
          { pokemon_id: 312 }
        ]
      };
    }
    
    // 模拟活动查询
    if (sql.includes('region_events')) {
      return {
        rows: [{
          event_id: 'spring-festival-2026',
          title: { zh: '春节活动', en: 'Spring Festival' },
          description: {},
          event_type: 'spawn_bonus',
          bonuses: { spawn_multiplier: 2.0, pokemon_ids: [25, 26] },
          start_time: new Date('2026-01-29'),
          end_time: new Date('2026-02-05')
        }]
      };
    }
    
    // 模拟合规规则查询
    if (sql.includes('compliance_rules')) {
      return { rows: [] };
    }
    
    return { rows: [] };
  },
  end: async () => {}
};

const mockRedis = {
  get: async () => null,
  setex: async () => 'OK',
  del: async () => 1,
  quit: async () => 'OK'
};

// 测试套件
async function runTests() {
  console.log('🧪 RegionManager 单元测试\n');
  
  const manager = new RegionManager({
    databaseUrl: 'mock',
    redisUrl: 'mock'
  });
  
  // 替换为 mock
  manager.pool = mockPool;
  manager.redis = mockRedis;
  
  let passed = 0;
  let failed = 0;
  
  // 测试 1: 区域检测
  console.log('Test 1: 区域检测');
  try {
    const region = await manager.detectRegion(39.9, 116.4);
    assert.strictEqual(region.code, 'CN');
    assert.strictEqual(region.name, '中国');
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 测试 2: 获取精灵权重
  console.log('Test 2: 获取精灵权重');
  try {
    const weights = await manager.getPokemonWeights('CN');
    assert(Array.isArray(weights));
    assert.strictEqual(weights.length, 2);
    assert.strictEqual(weights[0].pokemon_id, 25);
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 测试 3: 获取专属精灵
  console.log('Test 3: 获取区域专属精灵');
  try {
    const exclusive = await manager.getExclusivePokemon('CN');
    assert(Array.isArray(exclusive));
    assert.strictEqual(exclusive.length, 2);
    assert.strictEqual(exclusive[0], 311);
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 测试 4: 获取活跃活动
  console.log('Test 4: 获取活跃活动');
  try {
    const events = await manager.getActiveEvents('CN');
    assert(Array.isArray(events));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_id, 'spring-festival-2026');
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 测试 5: 获取完整区域配置
  console.log('Test 5: 获取完整区域配置');
  try {
    const config = await manager.getRegionConfig(39.9, 116.4);
    assert(config.region);
    assert.strictEqual(config.region.code, 'CN');
    assert(Array.isArray(config.spawnModifiers.exclusivePokemon));
    assert(Array.isArray(config.activeEvents));
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 测试 6: 应用合规过滤
  console.log('Test 6: 应用合规过滤');
  try {
    const content = [
      { id: 1, name: 'Pikachu' },
      { id: 2, name: 'Bulbasaur' },
      { id: 3, name: 'Charmander' }
    ];
    
    const filtered = await manager.applyComplianceFilters('CN', 'pokemon', content);
    assert.strictEqual(filtered.length, 3);
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 测试 7: 默认区域
  console.log('Test 7: 获取默认区域');
  try {
    const defaultRegion = manager.getDefaultRegion();
    assert.strictEqual(defaultRegion.code, 'DEFAULT');
    assert.strictEqual(defaultRegion.currency, 'USD');
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 测试 8: 坐标推断国家
  console.log('Test 8: 坐标推断国家');
  try {
    assert.strictEqual(manager.inferCountryFromCoords(35, 105), 'CN');
    assert.strictEqual(manager.inferCountryFromCoords(36, 140), 'JP');
    assert.strictEqual(manager.inferCountryFromCoords(37, 128), 'KR');
    assert.strictEqual(manager.inferCountryFromCoords(40, -100), 'US');
    console.log('  ✅ 通过\n');
    passed++;
  } catch (err) {
    console.log('  ❌ 失败:', err.message, '\n');
    failed++;
  }
  
  // 结果汇总
  console.log('━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  console.log(`📊 总计: ${passed + failed}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━\n');
  
  if (failed > 0) {
    process.exit(1);
  }
}

// 运行测试
runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
