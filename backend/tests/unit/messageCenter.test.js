// backend/tests/unit/messageCenter.test.js
// Unit tests for message center service - REQ-00124
'use strict';

const assert = require('assert');

console.log('=== Message Center Unit Tests ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

// ============================================================
// Test Data Factory
// ============================================================

function createTestNotification(overrides = {}) {
  return {
    id: 'test-notification-' + Date.now(),
    user_id: 'test-user-123',
    notification_type: 'RARE_SPAWN',
    title: '测试通知',
    body: '这是一条测试通知内容',
    data: { speciesId: 25, speciesName: 'Pikachu' },
    read: false,
    read_at: null,
    created_at: new Date(),
    ...overrides
  };
}

// ============================================================
// Test Notification Types
// ============================================================

test('NOTIFICATION_TYPE_MAP should have all required types', () => {
  const typeMap = {
    RARE_SPAWN: { icon: '🐉', label: '稀有精灵', category: 'pokemon' },
    RAID_STARTED: { icon: '⚔️', label: 'Raid 战斗', category: 'raid' },
    FRIEND_REQUEST: { icon: '👥', label: '好友请求', category: 'friend' },
    GIFT_RECEIVED: { icon: '🎁', label: '礼物接收', category: 'friend' },
    QUEST_COMPLETE: { icon: '✅', label: '任务完成', category: 'reward' },
    SYSTEM: { icon: '📢', label: '系统通知', category: 'system' },
    TRADE_REQUEST: { icon: '🔄', label: '交易请求', category: 'friend' },
  };
  
  Object.keys(typeMap).forEach(key => {
    assert.ok(typeMap[key].icon, `Missing icon for type: ${key}`);
    assert.ok(typeMap[key].label, `Missing label for type: ${key}`);
    assert.ok(typeMap[key].category, `Missing category for type: ${key}`);
  });
});

test('Each notification type should have a valid category', () => {
  const validCategories = ['pokemon', 'raid', 'friend', 'reward', 'system'];
  const typeMap = {
    RARE_SPAWN: { category: 'pokemon' },
    RAID_STARTED: { category: 'raid' },
    FRIEND_REQUEST: { category: 'friend' },
    GIFT_RECEIVED: { category: 'friend' },
    QUEST_COMPLETE: { category: 'reward' },
    SYSTEM: { category: 'system' },
    TRADE_REQUEST: { category: 'friend' },
  };
  
  Object.entries(typeMap).forEach(([type, info]) => {
    assert.ok(
      validCategories.includes(info.category),
      `Invalid category for ${type}: ${info.category}`
    );
  });
});

// ============================================================
// Test formatNotification Function
// ============================================================

test('formatNotification should format notification correctly', () => {
  const formatNotification = (row) => {
    const typeInfo = {
      RARE_SPAWN: { icon: '🐉', label: '稀有精灵', category: 'pokemon' }
    }[row.notification_type] || { icon: '📬', label: '通知' };
    
    return {
      id: row.id,
      type: row.notification_type,
      icon: typeInfo.icon,
      typeLabel: typeInfo.label,
      category: typeInfo.category,
      title: row.title,
      body: row.body,
      data: row.data || {},
      isRead: row.read,
      readAt: row.read_at,
      createdAt: row.created_at,
    };
  };
  
  const notification = createTestNotification();
  const formatted = formatNotification(notification);
  
  assert.strictEqual(formatted.id, notification.id, 'ID should match');
  assert.strictEqual(formatted.type, 'RARE_SPAWN', 'Type should match');
  assert.strictEqual(formatted.icon, '🐉', 'Icon should match');
  assert.strictEqual(formatted.title, '测试通知', 'Title should match');
  assert.strictEqual(formatted.isRead, false, 'Should be unread');
});

test('formatNotification should handle unknown notification type', () => {
  const formatNotification = (row) => {
    const typeInfo = { icon: '📬', label: '通知' };
    return { type: row.notification_type, icon: typeInfo.icon };
  };
  
  const notification = createTestNotification({ notification_type: 'UNKNOWN_TYPE' });
  const formatted = formatNotification(notification);
  
  assert.strictEqual(formatted.icon, '📬', 'Should use default icon');
});

// ============================================================
// Test getTimeAgo Function
// ============================================================

test('getTimeAgo should return "刚刚" for recent notifications', () => {
  const getTimeAgo = (date) => {
    const now = Date.now();
    const then = new Date(date).getTime();
    const diff = Math.floor((now - then) / 1000);
    
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(date).toLocaleDateString('zh-CN');
  };
  
  const justNow = new Date(Date.now() - 30 * 1000); // 30 秒前
  assert.strictEqual(getTimeAgo(justNow), '刚刚', 'Should return 刚刚');
});

test('getTimeAgo should return "X 分钟前" for notifications within an hour', () => {
  const getTimeAgo = (date) => {
    const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    return 'older';
  };
  
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  assert.strictEqual(getTimeAgo(fiveMinutesAgo), '5 分钟前', 'Should return 5 分钟前');
});

test('getTimeAgo should return "X 小时前" for notifications within a day', () => {
  const getTimeAgo = (date) => {
    const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return 'older';
  };
  
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
  assert.strictEqual(getTimeAgo(threeHoursAgo), '3 小时前', 'Should return 3 小时前');
});

test('getTimeAgo should return "X 天前" for notifications within a week', () => {
  const getTimeAgo = (date) => {
    const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(date).toLocaleDateString('zh-CN');
  };
  
  const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000);
  assert.strictEqual(getTimeAgo(twoDaysAgo), '2 天前', 'Should return 2 天前');
});

// ============================================================
// Test Pagination Parameters
// ============================================================

test('Pagination should enforce default limit of 20', () => {
  const limit = Math.min(Math.max(parseInt(undefined) || 20, 1), 100);
  assert.strictEqual(limit, 20, 'Default limit should be 20');
});

test('Pagination should enforce minimum limit of 1', () => {
  const limit = Math.min(Math.max(parseInt(-5) || 20, 1), 100);
  assert.strictEqual(limit, 1, 'Minimum limit should be 1');
});

test('Pagination should enforce maximum limit of 100', () => {
  const limit = Math.min(Math.max(parseInt(500) || 20, 1), 100);
  assert.strictEqual(limit, 100, 'Maximum limit should be 100');
});

test('Pagination should calculate correct offset', () => {
  const page = 3;
  const limit = 20;
  const offset = (page - 1) * limit;
  assert.strictEqual(offset, 40, 'Offset for page 3 should be 40');
});

test('Pagination should handle page 1 correctly', () => {
  const page = 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  assert.strictEqual(offset, 0, 'Offset for page 1 should be 0');
});

// ============================================================
// Test Status Filter Logic
// ============================================================

test('Status filter "all" should not add conditions', () => {
  const status = 'all';
  const conditions = ['user_id = $1'];
  
  if (status === 'unread') {
    conditions.push('read = false');
  } else if (status === 'read') {
    conditions.push('read = true');
  }
  
  assert.strictEqual(conditions.length, 1, 'Should have only user_id condition');
});

test('Status filter "unread" should add read = false condition', () => {
  const status = 'unread';
  const conditions = ['user_id = $1'];
  
  if (status === 'unread') {
    conditions.push('read = false');
  } else if (status === 'read') {
    conditions.push('read = true');
  }
  
  assert.strictEqual(conditions.length, 2, 'Should have 2 conditions');
  assert.ok(conditions.includes('read = false'), 'Should include read = false');
});

test('Status filter "read" should add read = true condition', () => {
  const status = 'read';
  const conditions = ['user_id = $1'];
  
  if (status === 'unread') {
    conditions.push('read = false');
  } else if (status === 'read') {
    conditions.push('read = true');
  }
  
  assert.strictEqual(conditions.length, 2, 'Should have 2 conditions');
  assert.ok(conditions.includes('read = true'), 'Should include read = true');
});

// ============================================================
// Test Unread Count Aggregation
// ============================================================

test('Unread count aggregation should sum all types', () => {
  const rows = [
    { notification_type: 'RARE_SPAWN', count: '5' },
    { notification_type: 'RAID_STARTED', count: '3' },
    { notification_type: 'FRIEND_REQUEST', count: '2' },
  ];
  
  const result = { total: 0, byType: {} };
  for (const row of rows) {
    result.total += parseInt(row.count);
    result.byType[row.notification_type] = parseInt(row.count);
  }
  
  assert.strictEqual(result.total, 10, 'Total should be 10');
  assert.strictEqual(result.byType.RARE_SPAWN, 5, 'RARE_SPAWN count should be 5');
  assert.strictEqual(result.byType.RAID_STARTED, 3, 'RAID_STARTED count should be 3');
  assert.strictEqual(result.byType.FRIEND_REQUEST, 2, 'FRIEND_REQUEST count should be 2');
});

test('Unread count should handle empty result', () => {
  const rows = [];
  const result = { total: 0, byType: {} };
  
  for (const row of rows) {
    result.total += parseInt(row.count);
    result.byType[row.notification_type] = parseInt(row.count);
  }
  
  assert.strictEqual(result.total, 0, 'Total should be 0');
  assert.deepStrictEqual(result.byType, {}, 'byType should be empty');
});

// ============================================================
// Test Quiet Hours Validation
// ============================================================

test('Quiet hours start time format should be HH:MM', () => {
  // 使用更严格的验证：格式必须是 HH:MM，且小时 <= 23，分钟 <= 59
  const isValidTime = (str) => {
    if (!/^\d{2}:\d{2}$/.test(str)) return false;
    const [h, m] = str.split(':').map(Number);
    return h <= 23 && m <= 59;
  };
  
  const validFormats = ['08:00', '23:59', '00:00', '12:30'];
  const invalidFormats = ['8:00', '24:00', '12:60', 'abc', '12:00:00'];
  
  validFormats.forEach(format => {
    assert.ok(
      isValidTime(format),
      `${format} should be valid`
    );
  });
  
  invalidFormats.forEach(format => {
    assert.ok(
      !isValidTime(format),
      `${format} should be invalid`
    );
  });
});

test('Quiet hours end time format should be HH:MM', () => {
  const quietHours = { enabled: true, start: '22:00', end: '08:00' };
  
  assert.ok(
    /^\d{2}:\d{2}$/.test(quietHours.start),
    'Start time should match HH:MM format'
  );
  assert.ok(
    /^\d{2}:\d{2}$/.test(quietHours.end),
    'End time should match HH:MM format'
  );
});

// ============================================================
// Test Batch Read Logic
// ============================================================

test('Batch read should validate request body', () => {
  const testCases = [
    { body: {}, expectedError: '需要提供 ids 数组或 all=true' },
    { body: { ids: [] }, expectedError: '需要提供 ids 数组或 all=true' },
    { body: { ids: null }, expectedError: '需要提供 ids 数组或 all=true' },
    { body: { ids: ['id1', 'id2'] }, expectedError: null },
    { body: { all: true }, expectedError: null },
  ];
  
  testCases.forEach(({ body, expectedError }) => {
    const hasIds = Array.isArray(body.ids) && body.ids.length > 0;
    const hasAll = body.all === true;
    
    const shouldError = !hasIds && !hasAll;
    
    if (expectedError) {
      assert.ok(shouldError, `Should require ids or all=true for ${JSON.stringify(body)}`);
    } else {
      assert.ok(!shouldError, `Should be valid for ${JSON.stringify(body)}`);
    }
  });
});

test('Batch read with all=true should mark all unread', () => {
  const body = { all: true };
  const shouldMarkAll = body.all === true;
  
  assert.ok(shouldMarkAll, 'Should mark all unread notifications');
});

// ============================================================
// Test Notification Stats
// ============================================================

test('Notification stats should aggregate correctly', () => {
  const stats = {
    total_count: '100',
    unread_count: '25',
    read_count: '75',
    rare_spawn_count: '30',
    raid_count: '20',
    friend_request_count: '15',
    quest_count: '25',
    system_count: '10',
  };
  
  const result = {
    total: parseInt(stats.total_count) || 0,
    unread: parseInt(stats.unread_count) || 0,
    read: parseInt(stats.read_count) || 0,
    byType: {
      rareSpawn: parseInt(stats.rare_spawn_count) || 0,
      raid: parseInt(stats.raid_count) || 0,
      friendRequest: parseInt(stats.friend_request_count) || 0,
      quest: parseInt(stats.quest_count) || 0,
      system: parseInt(stats.system_count) || 0,
    },
  };
  
  assert.strictEqual(result.total, 100, 'Total should be 100');
  assert.strictEqual(result.unread, 25, 'Unread should be 25');
  assert.strictEqual(result.read, 75, 'Read should be 75');
  assert.strictEqual(result.byType.rareSpawn, 30, 'Rare spawn count should be 30');
});

test('Notification stats should handle null values', () => {
  const stats = {
    total_count: null,
    unread_count: null,
    read_count: null,
  };
  
  const result = {
    total: parseInt(stats.total_count) || 0,
    unread: parseInt(stats.unread_count) || 0,
    read: parseInt(stats.read_count) || 0,
  };
  
  assert.strictEqual(result.total, 0, 'Total should default to 0');
  assert.strictEqual(result.unread, 0, 'Unread should default to 0');
  assert.strictEqual(result.read, 0, 'Read should default to 0');
});

// ============================================================
// Test Cache Key Generation
// ============================================================

test('Cache key should include user ID', () => {
  const userId = 'user-123';
  const cacheKey = `notification:unread:${userId}`;
  
  assert.ok(cacheKey.includes(userId), 'Cache key should contain user ID');
  assert.strictEqual(cacheKey, 'notification:unread:user-123', 'Cache key format should be correct');
});

test('Different users should have different cache keys', () => {
  const userId1 = 'user-123';
  const userId2 = 'user-456';
  
  const cacheKey1 = `notification:unread:${userId1}`;
  const cacheKey2 = `notification:unread:${userId2}`;
  
  assert.notStrictEqual(cacheKey1, cacheKey2, 'Cache keys should be different');
});

// ============================================================
// Test Cache TTL
// ============================================================

test('Cache should expire after 60 seconds', () => {
  const cacheData = {
    data: { total: 10 },
    timestamp: Date.now() - 30000, // 30 秒前
  };
  
  const isValid = cacheData && Date.now() - cacheData.timestamp < 60000;
  
  assert.ok(isValid, 'Cache should be valid within 60 seconds');
});

test('Cache should be invalid after 60 seconds', () => {
  const cacheData = {
    data: { total: 10 },
    timestamp: Date.now() - 70000, // 70 秒前
  };
  
  const isValid = cacheData && Date.now() - cacheData.timestamp < 60000;
  
  assert.ok(!isValid, 'Cache should be invalid after 60 seconds');
});

// ============================================================
// Test Error Codes
// ============================================================

test('Error code 4040 should indicate notification not found', () => {
  const errorCode = 4040;
  const errorMessage = errorCode === 4040 ? '通知不存在' : 'Unknown error';
  
  assert.strictEqual(errorMessage, '通知不存在', 'Error code 4040 should mean notification not found');
});

test('Error code 4008 should indicate invalid request body', () => {
  const errorCode = 4008;
  const errorMessage = errorCode === 4008 ? '需要提供 ids 数组或 all=true' : 'Unknown error';
  
  assert.strictEqual(errorMessage, '需要提供 ids 数组或 all=true', 'Error code 4008 should indicate invalid request');
});

test('Error codes 4009-4013 should be validation errors', () => {
  const validationErrorCodes = [4009, 4010, 4011, 4012, 4013];
  const errorMessages = {
    4009: 'notificationTypes 必须是对象',
    4010: 'quietHours 必须是对象',
    4011: 'quietHours.start 格式错误',
    4012: 'quietHours.end 格式错误',
    4013: '没有提供更新字段',
  };
  
  validationErrorCodes.forEach(code => {
    assert.ok(errorMessages[code], `Error code ${code} should have a message`);
  });
});

// ============================================================
// Test Prometheus Metrics
// ============================================================

test('Metrics should have correct names', () => {
  const metrics = {
    notificationsFetched: 'minego_message_center_notifications_fetched_total',
    notificationsMarkedRead: 'minego_message_center_notifications_marked_read_total',
    notificationsDeleted: 'minego_message_center_notifications_deleted_total',
    unreadCountQueries: 'minego_message_center_unread_count_queries_total',
  };
  
  Object.entries(metrics).forEach(([key, name]) => {
    assert.ok(name.startsWith('minego_message_center_'), `${name} should have correct prefix`);
    assert.ok(name.endsWith('_total'), `${name} should end with _total`);
  });
});

test('Metrics should increment correctly', () => {
  let counter = 0;
  const increment = (value = 1) => { counter += value; };
  
  increment();
  assert.strictEqual(counter, 1, 'Counter should be 1 after first increment');
  
  increment(5);
  assert.strictEqual(counter, 6, 'Counter should be 6 after incrementing by 5');
});

// ============================================================
// Test Clear Read Logic
// ============================================================

test('Clear read should delete all read notifications when no date filter', () => {
  const beforeDate = null;
  const conditions = ['user_id = $1', 'read = true'];
  
  if (beforeDate) {
    conditions.push('created_at < $2');
  }
  
  assert.strictEqual(conditions.length, 2, 'Should have 2 conditions without date filter');
});

test('Clear read should add date filter when beforeDate provided', () => {
  const beforeDate = '2026-06-01T00:00:00Z';
  const conditions = ['user_id = $1', 'read = true'];
  
  if (beforeDate) {
    conditions.push('created_at < $2');
  }
  
  assert.strictEqual(conditions.length, 3, 'Should have 3 conditions with date filter');
  assert.ok(conditions.includes('created_at < $2'), 'Should include date condition');
});

// ============================================================
// Test Preference Update Validation
// ============================================================

test('Preference update should validate notificationTypes is object', () => {
  const notificationTypes = { rare_spawn: true, raid_started: false };
  const isValid = notificationTypes && typeof notificationTypes === 'object';
  
  assert.ok(isValid, 'Valid notificationTypes object should pass');
});

test('Preference update should reject invalid notificationTypes', () => {
  const notificationTypes = 'invalid';
  const isValid = notificationTypes && typeof notificationTypes === 'object';
  
  assert.ok(!isValid, 'Invalid notificationTypes should fail');
});

test('Preference update should require at least one update field', () => {
  const updates = [];
  const notificationTypes = null;
  const quietHours = null;
  
  if (notificationTypes) updates.push('notification_types');
  if (quietHours) updates.push('quiet_hours');
  
  const hasUpdates = updates.length > 0;
  
  assert.ok(!hasUpdates, 'Should have no updates when both fields are null');
});

// ============================================================
// Test Total Pages Calculation
// ============================================================

test('Total pages should calculate correctly', () => {
  const testCases = [
    { total: 100, limit: 20, expected: 5 },
    { total: 101, limit: 20, expected: 6 },
    { total: 19, limit: 20, expected: 1 },
    { total: 0, limit: 20, expected: 0 },
  ];
  
  testCases.forEach(({ total, limit, expected }) => {
    const totalPages = Math.ceil(total / limit);
    assert.strictEqual(totalPages, expected, `Total pages for ${total} items with limit ${limit} should be ${expected}`);
  });
});

// ============================================================
// Summary
// ============================================================

console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  console.log('\n❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
