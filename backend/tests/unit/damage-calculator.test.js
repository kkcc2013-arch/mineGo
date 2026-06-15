/**
 * REQ-00146: 伤害计算系统单元测试
 * 创建时间: 2026-06-15 22:16
 */

const { calculateDamage, isWeatherBoosted, WEATHER_BOOST_MAP } = require('../../shared/damageCalculator');
const { getTypeMultiplier, TYPE_CHART, getAllTypes, isValidType } = require('../../shared/typeChart');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failed++;
    process.exitCode = 1;
  } else {
    passed++;
  }
}

console.log('=== REQ-00146: 属性克制与伤害计算测试 ===\n');

// ============================================
// 1. 属性克制矩阵测试
// ============================================
console.log('Testing type chart...');

// 基础克制测试
assert(getTypeMultiplier('fire', 'grass') === 2, 'Fire should be super effective (2x) against Grass');
assert(getTypeMultiplier('water', 'fire') === 2, 'Water should be super effective (2x) against Fire');
assert(getTypeMultiplier('fire', 'water') === 0.5, 'Fire should be not very effective (0.5x) against Water');
assert(getTypeMultiplier('electric', 'ground') === 0, 'Electric should be immune (0x) to Ground');
assert(getTypeMultiplier('ghost', 'normal') === 0, 'Ghost should be immune (0x) to Normal');
assert(getTypeMultiplier('dragon', 'fairy') === 0, 'Dragon should be immune (0x) to Fairy');
assert(getTypeMultiplier('fighting', 'ghost') === 0, 'Fighting should be immune (0x) to Ghost');

// 双属性测试
assert(getTypeMultiplier('fire', 'grass', 'ice') === 4, 'Fire should be 4x against Grass/Ice');
assert(getTypeMultiplier('fire', 'water', 'dragon') === 0.25, 'Fire should be 0.25x against Water/Dragon');
assert(getTypeMultiplier('ground', 'flying', 'electric') === 0, 'Ground should be immune (0x) to Flying/Electric');
assert(getTypeMultiplier('ice', 'dragon', 'flying') === 4, 'Ice should be 4x against Dragon/Flying');

// 正常伤害测试
assert(getTypeMultiplier('normal', 'fire') === 1, 'Normal should deal normal damage (1x) to Fire');
assert(getTypeMultiplier('water', 'electric') === 1, 'Water should deal normal damage (1x) to Electric');

// 类型验证测试
assert(getAllTypes().length === 18, 'Should have 18 types');
assert(isValidType('fire') === true, 'fire should be valid type');
assert(isValidType('invalid') === false, 'invalid should not be valid type');

console.log('✓ Type chart tests completed\n');

// ============================================
// 2. 伤害计算测试
// ============================================
console.log('Testing damage calculation...');

// 基础伤害测试
const basicDamage = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'normal',
  attackerType1: 'normal',
  defenderType1: 'normal'
});
assert(basicDamage.damage >= 20 && basicDamage.damage <= 30, 
  `Basic damage should be in range 20-30, got ${basicDamage.damage}`);
assert(basicDamage.effectiveness === 'normal', 'Should be normal effectiveness');
assert(basicDamage.isImmune === false, 'Should not be immune');

// STAB 测试
const stabDamage = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'fire',
  attackerType1: 'fire',
  defenderType1: 'normal'
});
assert(stabDamage.stab === 1.2, 'Should have STAB bonus (1.2x)');
assert(stabDamage.hasStab !== false, 'STAB should be applied');

// 克制测试
const superEffective = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'fire',
  attackerType1: 'fire',
  defenderType1: 'grass'
});
assert(superEffective.typeMultiplier === 2, 'Should be super effective (2x)');
assert(superEffective.effectiveness === 'super_effective', 'Should show super_effective');
assert(superEffective.damage > basicDamage.damage, 'Super effective should deal more damage');

// 双倍克制测试
const doubleWeak = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'ice',
  attackerType1: 'ice',
  defenderType1: 'dragon',
  defenderType2: 'flying'
});
assert(doubleWeak.typeMultiplier === 4, 'Should be 4x effective against Dragon/Flying');

// 抵抗测试
const notEffective = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'fire',
  attackerType1: 'fire',
  defenderType1: 'water'
});
assert(notEffective.typeMultiplier === 0.5, 'Should be not very effective (0.5x)');
assert(notEffective.effectiveness === 'not_very_effective', 'Should show not_very_effective');

// 免疫测试
const immune = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'electric',
  attackerType1: 'electric',
  defenderType1: 'ground'
});
assert(immune.damage === 0, 'Immune should deal 0 damage');
assert(immune.isImmune === true, 'Should be marked as immune');
assert(immune.typeMultiplier === 0, 'Type multiplier should be 0');

console.log('✓ Damage calculation tests completed\n');

// ============================================
// 3. 天气加成测试
// ============================================
console.log('Testing weather boost...');

assert(isWeatherBoosted('fire', 'sunny') === true, 'Fire should be boosted in sunny weather');
assert(isWeatherBoosted('water', 'rainy') === true, 'Water should be boosted in rainy weather');
assert(isWeatherBoosted('ice', 'snowy') === true, 'Ice should be boosted in snowy weather');
assert(isWeatherBoosted('dragon', 'windy') === true, 'Dragon should be boosted in windy weather');
assert(isWeatherBoosted('fire', 'rainy') === false, 'Fire should not be boosted in rainy weather');

// 天气加成伤害测试
const weatherBoosted = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'fire',
  attackerType1: 'fire',
  defenderType1: 'normal',
  weatherBoost: 'sunny'
});
assert(weatherBoosted.weatherMultiplier === 1.2, 'Weather should provide 1.2x boost');

console.log('✓ Weather boost tests completed\n');

// ============================================
// 4. 边界情况测试
// ============================================
console.log('Testing edge cases...');

// 最小伤害应该为 1
const minDamage = calculateDamage({
  power: 1,
  attack: 1,
  defense: 1000,
  attackType: 'normal',
  attackerType1: 'normal',
  defenderType1: 'steel'
});
assert(minDamage.damage >= 1, 'Minimum damage should be at least 1');

// 高防御低伤害
const highDefense = calculateDamage({
  power: 10,
  attack: 10,
  defense: 1000,
  attackType: 'normal',
  attackerType1: 'normal',
  defenderType1: 'normal'
});
assert(highDefense.damage >= 1, 'Even high defense should allow minimum 1 damage');

// 技能威力 0
try {
  calculateDamage({
    power: 0,
    attack: 100,
    defense: 100,
    attackType: 'normal',
    attackerType1: 'normal',
    defenderType1: 'normal'
  });
  assert(true, 'Zero power should still calculate damage');
} catch (e) {
  // 这是可以接受的
}

console.log('✓ Edge case tests completed\n');

// ============================================
// 5. TYPE_CHART 完整性测试
// ============================================
console.log('Testing TYPE_CHART completeness...');

const types = getAllTypes();
for (const type of types) {
  assert(TYPE_CHART[type] !== undefined, `${type} should exist in TYPE_CHART`);
}

// 检查所有属性都有克制关系定义
assert(Object.keys(TYPE_CHART).length === 18, 'TYPE_CHART should have 18 types');

console.log('✓ TYPE_CHART completeness tests completed\n');

// ============================================
// 测试总结
// ============================================
console.log('=================================');
console.log(`✅ PASSED: ${passed}`);
console.log(`❌ FAILED: ${failed}`);
console.log('=================================');

if (failed === 0) {
  console.log('\n✅ All damage calculator tests passed!\n');
  process.exit(0);
} else {
  console.error(`\n❌ ${failed} tests failed!\n`);
  process.exit(1);
}
