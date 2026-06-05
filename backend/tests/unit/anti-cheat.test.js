// tests/unit/anti-cheat.test.js - 反作弊系统单元测试
'use strict';

const assert = require('assert');
const {
  haversineDistance,
  calculateSpeed,
  getSpeedAnomalyLevel,
  getSpeedPenalty,
  SPEED_LIMITS,
  TRUST_SCORE,
  ACTION_LIMITS,
} = require('../../shared/anti-cheat');

// ============================================================
// 距离计算测试
// ============================================================

console.log('\n=== Haversine Distance Tests ===');

// Test 1: 相同点距离为 0
const dist1 = haversineDistance(39.9042, 116.4074, 39.9042, 116.4074);
assert.strictEqual(dist1, 0, 'Same point distance should be 0');
console.log('✓ Same point distance:', dist1, 'm');

// Test 2: 北京到上海（约 1068 km）
const dist2 = haversineDistance(39.9042, 116.4074, 31.2304, 121.4737);
assert.ok(dist2 > 1060000 && dist2 < 1070000, 'Beijing to Shanghai should be ~1068km');
console.log('✓ Beijing to Shanghai distance:', Math.round(dist2 / 1000), 'km');

// Test 3: 100 米距离
const dist3 = haversineDistance(39.9042, 116.4074, 39.9051, 116.4074);
assert.ok(dist3 > 90 && dist3 < 110, '100m distance should be ~100m');
console.log('✓ 100m distance:', Math.round(dist3), 'm');

// Test 4: 跨半球距离（北京到纽约，约 11000 km）
const dist4 = haversineDistance(39.9042, 116.4074, 40.7128, -74.0060);
assert.ok(dist4 > 10900000 && dist4 < 11100000, 'Beijing to NYC should be ~11000km');
console.log('✓ Beijing to NYC distance:', Math.round(dist4 / 1000), 'km');

// ============================================================
// 速度计算测试
// ============================================================

console.log('\n=== Speed Calculation Tests ===');

// Test 5: 步行速度（1m/s）
const speed1 = calculateSpeed(39.9042, 116.4074, 1000, 39.9042 + 0.00001, 116.4074, 2000);
assert.ok(speed1 > 0.5 && speed1 < 2, 'Walking speed should be ~1m/s');
console.log('✓ Walking speed:', Math.round(speed1 * 100) / 100, 'm/s');

// Test 6: 驾车速度（30m/s = 108km/h）
const speed2 = calculateSpeed(39.9042, 116.4074, 1000, 39.9122, 116.4074, 2000); // ~890m in 1s
assert.ok(speed2 > 800, 'Driving speed should be > 800m/s (teleport)');
console.log('✓ Teleport speed:', Math.round(speed2), 'm/s');

// Test 7: 瞬移（距离很大，时间很短）
const speed3 = calculateSpeed(39.9042, 116.4074, 1000, 31.2304, 121.4737, 2000);
assert.ok(speed3 > 500000, 'Teleport should be very high speed');
console.log('✓ Instant teleport speed:', Math.round(speed3), 'm/s');

// Test 8: 静止不动
const speed4 = calculateSpeed(39.9042, 116.4074, 1000, 39.9042, 116.4074, 2000);
assert.strictEqual(speed4, 0, 'Stationary speed should be 0');
console.log('✓ Stationary speed:', speed4, 'm/s');

// ============================================================
// 速度异常级别测试
// ============================================================

console.log('\n=== Speed Anomaly Level Tests ===');

// Test 9: 正常步行
const level1 = getSpeedAnomalyLevel(4);
assert.strictEqual(level1, null, 'Walking speed should be normal');
console.log('✓ Walking (4m/s):', level1 || 'NORMAL');

// Test 10: 快速步行
const level2 = getSpeedAnomalyLevel(6);
assert.strictEqual(level2, 'LOW', 'Fast walking should be LOW');
console.log('✓ Fast walking (6m/s):', level2);

// Test 11: 骑行速度
const level3 = getSpeedAnomalyLevel(20);
assert.strictEqual(level3, 'MEDIUM', 'Biking speed should be MEDIUM');
console.log('✓ Biking (20m/s):', level3);

// Test 12: 驾车速度
const level4 = getSpeedAnomalyLevel(60);
assert.strictEqual(level4, 'HIGH', 'Driving speed should be HIGH');
console.log('✓ Driving (60m/s):', level4);

// Test 13: 瞬移
const level5 = getSpeedAnomalyLevel(300);
assert.strictEqual(level5, 'CRITICAL', 'Teleport should be CRITICAL');
console.log('✓ Teleport (300m/s):', level5);

// ============================================================
// 惩罚分数测试
// ============================================================

console.log('\n=== Speed Penalty Tests ===');

// Test 14: 各级别惩罚
const penalty1 = getSpeedPenalty('LOW');
assert.strictEqual(penalty1, TRUST_SCORE.PENALTY.SPEED_LOW, 'LOW penalty should match');
console.log('✓ LOW penalty:', penalty1);

const penalty2 = getSpeedPenalty('MEDIUM');
assert.strictEqual(penalty2, TRUST_SCORE.PENALTY.SPEED_MEDIUM, 'MEDIUM penalty should match');
console.log('✓ MEDIUM penalty:', penalty2);

const penalty3 = getSpeedPenalty('HIGH');
assert.strictEqual(penalty3, TRUST_SCORE.PENALTY.SPEED_HIGH, 'HIGH penalty should match');
console.log('✓ HIGH penalty:', penalty3);

const penalty4 = getSpeedPenalty('CRITICAL');
assert.strictEqual(penalty4, TRUST_SCORE.PENALTY.SPEED_HIGH * 2, 'CRITICAL penalty should be double HIGH');
console.log('✓ CRITICAL penalty:', penalty4);

// ============================================================
// 配置验证测试
// ============================================================

console.log('\n=== Configuration Tests ===');

// Test 15: 速度阈值合理性
assert.ok(SPEED_LIMITS.WALK < SPEED_LIMITS.BIKE, 'Walk should be slower than bike');
assert.ok(SPEED_LIMITS.BIKE < SPEED_LIMITS.DRIVE, 'Bike should be slower than drive');
assert.ok(SPEED_LIMITS.DRIVE < SPEED_LIMITS.TELEPORT, 'Drive should be slower than teleport');
console.log('✓ Speed limits order:', SPEED_LIMITS);

// Test 16: 可信度分数范围
assert.strictEqual(TRUST_SCORE.INITIAL, 100, 'Initial trust score should be 100');
assert.strictEqual(TRUST_SCORE.MIN, 0, 'Min trust score should be 0');
assert.strictEqual(TRUST_SCORE.MAX, 100, 'Max trust score should be 100');
console.log('✓ Trust score range:', TRUST_SCORE.MIN, '-', TRUST_SCORE.MAX);

// Test 17: 可信度阈值顺序
assert.ok(TRUST_SCORE.THRESHOLD.BANNED < TRUST_SCORE.THRESHOLD.RESTRICTED, 'Banned < Restricted');
assert.ok(TRUST_SCORE.THRESHOLD.RESTRICTED < TRUST_SCORE.THRESHOLD.WARNING, 'Restricted < Warning');
assert.ok(TRUST_SCORE.THRESHOLD.WARNING < TRUST_SCORE.THRESHOLD.NORMAL, 'Warning < Normal');
console.log('✓ Trust thresholds:', TRUST_SCORE.THRESHOLD);

// Test 18: 行为频率限制
assert.ok(ACTION_LIMITS.CATCH.maxPerMinute > 0, 'Catch limit should be positive');
assert.ok(ACTION_LIMITS.CATCH.maxPerHour > ACTION_LIMITS.CATCH.maxPerMinute, 'Hour limit > minute limit');
console.log('✓ Catch limits:', ACTION_LIMITS.CATCH);

// ============================================================
// 边界条件测试
// ============================================================

console.log('\n=== Edge Case Tests ===');

// Test 19: 时间差为 0（防止除零）
const speedZero = calculateSpeed(39.9042, 116.4074, 1000, 39.9042, 116.4074, 1000);
assert.strictEqual(speedZero, 0, 'Same time and location should return 0');
console.log('✓ Same time and location:', speedZero);

// Test 20: 时间差为 0 但距离很大
const speedZeroDist = calculateSpeed(39.9042, 116.4074, 1000, 31.2304, 121.4737, 1000);
assert.strictEqual(speedZeroDist, Infinity, 'Same time but different location should return Infinity');
console.log('✓ Same time, different location:', speedZeroDist);

// Test 21: 负坐标（南半球、西经）
const distNeg = haversineDistance(-33.8688, 151.2093, -22.9068, -43.1729); // 悉尼到里约
assert.ok(distNeg > 12000000 && distNeg < 13000000, 'Sydney to Rio should be ~12500km');
console.log('✓ Sydney to Rio distance:', Math.round(distNeg / 1000), 'km');

// Test 22: 无效速度级别
const penaltyInvalid = getSpeedPenalty('INVALID');
assert.strictEqual(penaltyInvalid, 0, 'Invalid level should return 0 penalty');
console.log('✓ Invalid level penalty:', penaltyInvalid);

// ============================================================
// 总结
// ============================================================

console.log('\n========================================');
console.log('✅ All 22 anti-cheat unit tests passed!');
console.log('========================================\n');
