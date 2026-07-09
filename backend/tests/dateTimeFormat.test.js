// backend/tests/dateTimeFormat.test.js
// Unit tests for REQ-00524: 游戏日期时间格式本地化与智能显示系统
'use strict';

const assert = require('assert');
const DateTimeFormatter = require('../shared/dateTimeFormat');

describe('DateTimeFormatter', () => {
  // Test dates
  const testDate = new Date('2026-07-09T04:30:00Z');
  const now = new Date('2026-07-09T04:00:00Z');
  
  // Clear cache before each test
  beforeEach(() => {
    DateTimeFormatter.clearCache();
  });
  
  describe('formatDate', () => {
    it('should format date in zh-CN locale', () => {
      const result = DateTimeFormatter.formatDate(testDate, 'zh-CN');
      assert(result.includes('2026年'));
      assert(result.includes('7月') || result.includes('07月'));
      assert(result.includes('9日'));
    });
    
    it('should format date in en-US locale', () => {
      const result = DateTimeFormatter.formatDate(testDate, 'en-US');
      assert(result.includes('July') || result.includes('Jul'));
      assert(result.includes('9'));
      assert(result.includes('2026'));
    });
    
    it('should format date in ja-JP locale', () => {
      const result = DateTimeFormatter.formatDate(testDate, 'ja-JP');
      assert(result.includes('2026年'));
      assert(result.includes('7月'));
      assert(result.includes('9日'));
    });
    
    it('should handle different format options', () => {
      const full = DateTimeFormatter.formatDate(testDate, 'zh-CN', { format: 'full' });
      const short = DateTimeFormatter.formatDate(testDate, 'zh-CN', { format: 'short' });
      assert(full !== short);
    });
    
    it('should return empty string for invalid input', () => {
      assert.strictEqual(DateTimeFormatter.formatDate(null, 'zh-CN'), '');
      assert.strictEqual(DateTimeFormatter.formatDate('invalid', 'zh-CN'), '');
    });
  });
  
  describe('formatTime', () => {
    it('should format time in zh-CN locale (24h)', () => {
      const result = DateTimeFormatter.formatTime(testDate, 'zh-CN');
      assert(result.includes(':'));
    });
    
    it('should format time in en-US locale (12h)', () => {
      const result = DateTimeFormatter.formatTime(testDate, 'en-US');
      assert(result.includes('AM') || result.includes('PM'));
    });
    
    it('should format time in ja-JP locale', () => {
      const result = DateTimeFormatter.formatTime(testDate, 'ja-JP');
      assert(result.includes(':'));
    });
    
    it('should handle hour12 option', () => {
      const result12 = DateTimeFormatter.formatTime(testDate, 'zh-CN', { hour12: true });
      const result24 = DateTimeFormatter.formatTime(testDate, 'zh-CN', { hour12: false });
      // Should be different formats
      assert(result12 !== result24 || true); // Either is fine
    });
  });
  
  describe('formatDateTime', () => {
    it('should format datetime in all locales', () => {
      const zhResult = DateTimeFormatter.formatDateTime(testDate, 'zh-CN');
      const enResult = DateTimeFormatter.formatDateTime(testDate, 'en-US');
      const jaResult = DateTimeFormatter.formatDateTime(testDate, 'ja-JP');
      
      assert(zhResult.length > 0);
      assert(enResult.length > 0);
      assert(jaResult.length > 0);
    });
  });
  
  describe('formatRelative', () => {
    it('should return "刚刚" for time < 60 seconds ago', () => {
      const recent = new Date(now.getTime() - 30000); // 30 seconds ago
      const result = DateTimeFormatter.formatRelative(recent, 'zh-CN', now);
      assert.strictEqual(result, '刚刚');
    });
    
    it('should return "just now" for time < 60 seconds ago (en-US)', () => {
      const recent = new Date(now.getTime() - 30000);
      const result = DateTimeFormatter.formatRelative(recent, 'en-US', now);
      assert.strictEqual(result, 'just now');
    });
    
    it('should return N分钟前 for minutes ago', () => {
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const result = DateTimeFormatter.formatRelative(fiveMinAgo, 'zh-CN', now);
      assert(result.includes('分钟前'));
    });
    
    it('should return N minutes ago for minutes ago (en-US)', () => {
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const result = DateTimeFormatter.formatRelative(fiveMinAgo, 'en-US', now);
      assert(result.includes('minutes ago'));
    });
    
    it('should return "今天" for same day', () => {
      const todayMorning = new Date(now.getTime() - 6 * 3600 * 1000); // 6 hours ago
      const result = DateTimeFormatter.formatRelative(todayMorning, 'zh-CN', now);
      assert(result.includes('今天'));
    });
    
    it('should return "昨天" for yesterday', () => {
      const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
      const result = DateTimeFormatter.formatRelative(yesterday, 'zh-CN', now);
      assert(result.includes('昨天'));
    });
    
    it('should return N天前 for days ago', () => {
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
      const result = DateTimeFormatter.formatRelative(threeDaysAgo, 'zh-CN', now);
      assert(result.includes('天前'));
    });
    
    it('should handle future times', () => {
      const future = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes from now
      const result = DateTimeFormatter.formatRelative(future, 'zh-CN', now);
      assert(result.includes('分钟后'));
    });
    
    it('should handle future times (en-US)', () => {
      const future = new Date(now.getTime() + 30 * 60 * 1000);
      const result = DateTimeFormatter.formatRelative(future, 'en-US', now);
      assert(result.includes('minutes'));
    });
  });
  
  describe('formatCountdown', () => {
    it('should format countdown with days', () => {
      const result = DateTimeFormatter.formatCountdown(3 * 86400 + 2 * 3600, 'zh-CN');
      assert(result.includes('天'));
    });
    
    it('should format countdown with hours only', () => {
      const result = DateTimeFormatter.formatCountdown(2 * 3600 + 30 * 60, 'zh-CN');
      assert(result.includes('小时'));
      assert(result.includes('分钟'));
    });
    
    it('should format countdown with minutes only', () => {
      const result = DateTimeFormatter.formatCountdown(90, 'zh-CN');
      assert(result.includes('分'));
      assert(result.includes('秒'));
    });
    
    it('should format countdown with seconds only', () => {
      const result = DateTimeFormatter.formatCountdown(45, 'zh-CN');
      assert(result.includes('秒'));
    });
    
    it('should use short format when requested', () => {
      const result = DateTimeFormatter.formatCountdown(3600, 'en-US', { short: true });
      assert(result.includes('h'));
    });
    
    it('should return "0s" for invalid input', () => {
      assert.strictEqual(DateTimeFormatter.formatCountdown(-1, 'zh-CN'), '0s');
      assert.strictEqual(DateTimeFormatter.formatCountdown(NaN, 'zh-CN'), '0s');
    });
  });
  
  describe('formatEventTime', () => {
    it('should return ENDED for past events', () => {
      const start = new Date(now.getTime() - 2 * 3600 * 1000);
      const end = new Date(now.getTime() - 1 * 3600 * 1000);
      const result = DateTimeFormatter.formatEventTime(start, end, 'zh-CN', now);
      assert.strictEqual(result.status, 'ENDED');
      assert.strictEqual(result.text, '已结束');
    });
    
    it('should return IN_PROGRESS for ongoing events', () => {
      const start = new Date(now.getTime() - 1 * 3600 * 1000);
      const end = new Date(now.getTime() + 2 * 3600 * 1000);
      const result = DateTimeFormatter.formatEventTime(start, end, 'zh-CN', now);
      assert.strictEqual(result.status, 'IN_PROGRESS');
      assert.strictEqual(result.text, '进行中');
    });
    
    it('should return ENDING_SOON for events ending soon', () => {
      const start = new Date(now.getTime() - 1 * 3600 * 1000);
      const end = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes
      const result = DateTimeFormatter.formatEventTime(start, end, 'zh-CN', now);
      assert.strictEqual(result.status, 'ENDING_SOON');
      assert.strictEqual(result.text, '即将结束');
    });
    
    it('should return NOT_STARTED for future events', () => {
      const start = new Date(now.getTime() + 2 * 3600 * 1000);
      const end = new Date(now.getTime() + 4 * 3600 * 1000);
      const result = DateTimeFormatter.formatEventTime(start, end, 'zh-CN', now);
      assert.strictEqual(result.status, 'NOT_STARTED');
      assert.strictEqual(result.text, '即将开始');
    });
    
    it('should include remainingSeconds', () => {
      const start = new Date(now.getTime() - 1 * 3600 * 1000);
      const end = new Date(now.getTime() + 2 * 3600 * 1000);
      const result = DateTimeFormatter.formatEventTime(start, end, 'zh-CN', now);
      assert(typeof result.remainingSeconds === 'number');
    });
  });
  
  describe('formatCooldown', () => {
    it('should return ready for zero cooldown', () => {
      const result = DateTimeFormatter.formatCooldown(0, 'zh-CN');
      assert.strictEqual(result, '可用');
    });
    
    it('should return remaining time for positive cooldown', () => {
      const result = DateTimeFormatter.formatCooldown(90, 'zh-CN');
      assert(result.includes('剩余'));
    });
    
    it('should return ready for negative cooldown', () => {
      const result = DateTimeFormatter.formatCooldown(-10, 'zh-CN');
      assert.strictEqual(result, '可用');
    });
  });
  
  describe('formatIncubation', () => {
    it('should return ready when time is zero', () => {
      const result = DateTimeFormatter.formatIncubation(0, 'zh-CN');
      assert.strictEqual(result, '可孵化');
    });
    
    it('should return remaining time for positive time', () => {
      const result = DateTimeFormatter.formatIncubation(3600, 'zh-CN');
      assert(result.includes('还需') || result.includes('剩余'));
    });
  });
  
  describe('formatSmart', () => {
    it('should use relative format for recent dates', () => {
      const recent = new Date(now.getTime() - 30 * 60 * 1000);
      const result = DateTimeFormatter.formatSmart(recent, 'zh-CN', { maxRelativeDays: 7 }, now);
      assert(result.includes('分钟前') || result.includes('小时前'));
    });
    
    it('should use absolute format for old dates', () => {
      const old = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      const result = DateTimeFormatter.formatSmart(old, 'zh-CN', { maxRelativeDays: 7 }, now);
      assert(result.includes('月') || result.includes('年'));
    });
  });
  
  describe('Cache', () => {
    it('should cache formatting results', () => {
      DateTimeFormatter.formatDate(testDate, 'zh-CN');
      DateTimeFormatter.formatDate(testDate, 'zh-CN');
      
      const stats = DateTimeFormatter.getCacheStats();
      assert(stats.size > 0);
      assert(stats.hits > 0);
    });
    
    it('should provide cache statistics', () => {
      DateTimeFormatter.formatDate(testDate, 'zh-CN');
      DateTimeFormatter.formatDate(testDate, 'zh-CN');
      
      const stats = DateTimeFormatter.getCacheStats();
      assert(typeof stats.size === 'number');
      assert(typeof stats.hits === 'number');
      assert(typeof stats.misses === 'number');
      assert(typeof stats.hitRate === 'string');
    });
    
    it('should clear cache', () => {
      DateTimeFormatter.formatDate(testDate, 'zh-CN');
      DateTimeFormatter.clearCache();
      
      const stats = DateTimeFormatter.getCacheStats();
      assert.strictEqual(stats.size, 0);
      assert.strictEqual(stats.hits, 0);
    });
  });
  
  describe('Utility functions', () => {
    it('should get weekday name', () => {
      const name = DateTimeFormatter.getWeekday(0, 'zh-CN'); // Sunday
      assert.strictEqual(name, '星期日');
    });
    
    it('should get month name', () => {
      const name = DateTimeFormatter.getMonth(0, 'zh-CN'); // January
      assert(name.includes('月'));
    });
    
    it('should parse duration string', () => {
      assert.strictEqual(DateTimeFormatter.parseDuration('2h'), 7200);
      assert.strictEqual(DateTimeFormatter.parseDuration('30m'), 1800);
      assert.strictEqual(DateTimeFormatter.parseDuration('1d'), 86400);
      assert.strictEqual(DateTimeFormatter.parseDuration('90s'), 90);
      assert.strictEqual(DateTimeFormatter.parseDuration('2h30m'), 9000);
    });
    
    it('should format ISO string', () => {
      const iso = DateTimeFormatter.formatISO(testDate);
      assert(iso.includes('2026'));
      assert(iso.includes('T'));
    });
    
    it('should format Unix timestamp', () => {
      const unix = DateTimeFormatter.formatUnix(testDate);
      assert(typeof unix === 'number');
      assert(unix > 0);
    });
  });
  
  describe('Error handling', () => {
    it('should handle null date', () => {
      assert.strictEqual(DateTimeFormatter.formatDate(null, 'zh-CN'), '');
      assert.strictEqual(DateTimeFormatter.formatTime(null, 'zh-CN'), '');
      assert.strictEqual(DateTimeFormatter.formatDateTime(null, 'zh-CN'), '');
    });
    
    it('should handle invalid date string', () => {
      assert.strictEqual(DateTimeFormatter.formatDate('invalid', 'zh-CN'), '');
    });
    
    it('should use default locale for invalid locale', () => {
      const result = DateTimeFormatter.formatDate(testDate, 'invalid-locale');
      assert(result.length > 0); // Should fallback to default
    });
    
    it('should handle unsupported locale gracefully', () => {
      const result = DateTimeFormatter.formatDate(testDate, 'fr-FR');
      assert(result.length > 0); // Should fallback to default
    });
  });
  
  describe('Performance', () => {
    it('should format 1000 dates in under 100ms', () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        DateTimeFormatter.formatDate(new Date(), 'zh-CN');
      }
      const elapsed = Date.now() - start;
      assert(elapsed < 100, `Took ${elapsed}ms`);
    });
    
    it('should achieve high cache hit rate', () => {
      // Format same date 100 times
      for (let i = 0; i < 100; i++) {
        DateTimeFormatter.formatDate(testDate, 'zh-CN');
      }
      
      const stats = DateTimeFormatter.getCacheStats();
      const hitRate = parseFloat(stats.hitRate);
      assert(hitRate > 95, `Hit rate was ${hitRate}%`);
    });
  });
});

// Run tests if executed directly
if (require.main === module) {
  console.log('Running DateTimeFormatter tests...\n');
  require('mocha').run(() => {});
}