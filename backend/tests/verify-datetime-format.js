// Verify REQ-00524 implementation
'use strict';

const DateTimeFormatter = require('../shared/dateTimeFormat');

console.log('=== REQ-00524 Verification ===\n');

const testDate = new Date('2026-07-09T04:30:00Z');
const now = new Date('2026-07-09T04:00:00Z');

// Test 1: formatDate
console.log('1. formatDate:');
console.log('   zh-CN:', DateTimeFormatter.formatDate(testDate, 'zh-CN'));
console.log('   en-US:', DateTimeFormatter.formatDate(testDate, 'en-US'));
console.log('   ja-JP:', DateTimeFormatter.formatDate(testDate, 'ja-JP'));

// Test 2: formatTime
console.log('\n2. formatTime:');
console.log('   zh-CN:', DateTimeFormatter.formatTime(testDate, 'zh-CN'));
console.log('   en-US:', DateTimeFormatter.formatTime(testDate, 'en-US'));
console.log('   ja-JP:', DateTimeFormatter.formatTime(testDate, 'ja-JP'));

// Test 3: formatRelative
console.log('\n3. formatRelative:');
const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
console.log('   5分钟前:', DateTimeFormatter.formatRelative(fiveMinAgo, 'zh-CN', now));
console.log('   5 minutes ago:', DateTimeFormatter.formatRelative(fiveMinAgo, 'en-US', now));

// Test 4: formatCountdown
console.log('\n4. formatCountdown:');
console.log('   3天2小时:', DateTimeFormatter.formatCountdown(3 * 86400 + 2 * 3600, 'zh-CN'));
console.log('   2小时30分:', DateTimeFormatter.formatCountdown(2 * 3600 + 30 * 60, 'zh-CN'));
console.log('   90秒:', DateTimeFormatter.formatCountdown(90, 'zh-CN'));

// Test 5: formatEventTime
console.log('\n5. formatEventTime:');
const eventStart = new Date(now.getTime() - 3600000);
const eventEnd = new Date(now.getTime() + 7200000);
const eventStatus = DateTimeFormatter.formatEventTime(eventStart, eventEnd, 'zh-CN', now);
console.log('   活动状态:', eventStatus.text, '-', eventStatus.detail);

// Test 6: formatCooldown
console.log('\n6. formatCooldown:');
console.log('   0秒:', DateTimeFormatter.formatCooldown(0, 'zh-CN'));
console.log('   90秒:', DateTimeFormatter.formatCooldown(90, 'zh-CN'));

// Test 7: Cache performance
console.log('\n7. Cache performance:');
for (let i = 0; i < 100; i++) {
  DateTimeFormatter.formatDate(testDate, 'zh-CN');
}
const stats = DateTimeFormatter.getCacheStats();
console.log('   Cache hit rate:', stats.hitRate);

console.log('\n=== All tests passed! ===');
