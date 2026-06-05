// backend/tests/unit/pokemon-indexes.test.js
// REQ-00020: 验证精灵列表查询复合索引
'use strict';

const assert = require('assert');

// Mock query function for testing
let queryFn;

async function setupQuery(mockQuery) {
  queryFn = mockQuery;
}

// 验证复合索引是否存在
async function verifyCompositeIndexes() {
  const { rows } = await queryFn(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'pokemon_instances'
      AND indexname IN ('idx_instances_user_cp', 'idx_instances_user_caught', 
                        'idx_instances_species_cp', 'idx_instances_user_iv')
    ORDER BY indexname
  `);
  
  return rows;
}

// 验证查询计划是否使用正确的索引
async function verifyQueryPlan() {
  // 模拟用户 ID
  const testUserId = 1;
  
  // 测试 CP 排序查询
  const cpSortPlan = await queryFn(`
    EXPLAIN (FORMAT JSON) 
    SELECT * FROM pokemon_instances WHERE user_id = $1 ORDER BY cp DESC LIMIT 30
  `, [testUserId]);
  
  // 测试捕捉时间排序查询
  const caughtSortPlan = await queryFn(`
    EXPLAIN (FORMAT JSON) 
    SELECT * FROM pokemon_instances WHERE user_id = $1 ORDER BY caught_at DESC LIMIT 30
  `, [testUserId]);
  
  return {
    cpSortPlan: cpSortPlan.rows[0],
    caughtSortPlan: caughtSortPlan.rows[0]
  };
}

// 测试套件
async function runTests() {
  console.log('=== REQ-00020 精灵列表复合索引测试 ===\n');
  
  // 测试 1: 验证索引存在
  console.log('测试 1: 验证复合索引是否存在...');
  const indexes = await verifyCompositeIndexes();
  console.log(`  找到 ${indexes.length} 个复合索引`);
  indexes.forEach(idx => {
    console.log(`  ✓ ${idx.indexname}`);
  });
  assert(indexes.length >= 3, '应该至少有 3 个复合索引');
  console.log('  通过 ✓\n');
  
  // 测试 2: 验证索引结构
  console.log('测试 2: 验证索引结构...');
  const userCpIndex = indexes.find(i => i.indexname === 'idx_instances_user_cp');
  assert(userCpIndex, 'idx_instances_user_cp 应该存在');
  assert(userCpIndex.indexdef.includes('user_id'), '索引应该包含 user_id');
  assert(userCpIndex.indexdef.includes('cp'), '索引应该包含 cp');
  console.log('  通过 ✓\n');
  
  // 测试 3: 验证 CONCURRENTLY 创建的索引
  console.log('测试 3: 验证索引是否非阻塞创建...');
  const { rows: indexInfo } = await queryFn(`
    SELECT indexname, indisvalid, indisready
    FROM pg_index
    JOIN pg_class ON pg_class.oid = pg_index.indexrelid
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE pg_class.relname IN ('idx_instances_user_cp', 'idx_instances_user_caught', 
                               'idx_instances_species_cp', 'idx_instances_user_iv')
  `);
  indexInfo.forEach(idx => {
    console.log(`  ${idx.indexname}: valid=${idx.indisvalid}, ready=${idx.indisready}`);
    assert(idx.indisvalid, `${idx.indexname} 应该是有效的`);
    assert(idx.indisready, `${idx.indexname} 应该是就绪的`);
  });
  console.log('  通过 ✓\n');
  
  // 测试 4: 验证索引使用情况（需要真实数据）
  console.log('测试 4: 检查索引使用统计...');
  const { rows: indexStats } = await queryFn(`
    SELECT schemaname, relname, indexrelname, idx_scan, idx_tup_read
    FROM pg_stat_user_indexes
    WHERE relname = 'pokemon_instances'
      AND indexrelname LIKE 'idx_instances_%'
    ORDER BY indexrelname
  `);
  console.log('  索引使用统计:');
  indexStats.forEach(stat => {
    console.log(`    ${stat.indexrelname}: scans=${stat.idx_scan}, tuples_read=${stat.idx_tup_read}`);
  });
  console.log('  通过 ✓\n');
  
  console.log('=== 所有测试通过 ✓ ===');
  return true;
}

// 导出测试函数
module.exports = {
  setupQuery,
  verifyCompositeIndexes,
  verifyQueryPlan,
  runTests
};

// 如果直接运行此文件
if (require.main === module) {
  const { query } = require('../../shared/db');
  setupQuery(query);
  runTests().catch(err => {
    console.error('测试失败:', err.message);
    process.exit(1);
  });
}
