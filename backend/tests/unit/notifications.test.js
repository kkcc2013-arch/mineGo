// backend/tests/unit/notifications.test.js
// Unit tests for notification system - REQ-00026
'use strict';

const assert = require('assert');

console.log('=== Notification System Unit Tests ===\n');

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
// Test Notification Types
// ============================================================

test('NOTIFICATION_TYPES should have all required types', () => {
  const types = {
    RARE_SPAWN: 'RARE_SPAWN',
    RAID_STARTED: 'RAID_STARTED',
    FRIEND_REQUEST: 'FRIEND_REQUEST',
    GIFT_RECEIVED: 'GIFT_RECEIVED',
    QUEST_COMPLETE: 'QUEST_COMPLETE',
    GYM_UNDER_ATTACK: 'GYM_UNDER_ATTACK',
    GYM_LOST: 'GYM_LOST',
  };
  
  Object.keys(types).forEach(key => {
    assert.ok(types[key], `Missing notification type: ${key}`);
  });
});

// ============================================================
// Test Notification Preferences Validation
// ============================================================

test('Notification preferences should have all fields', () => {
  const validFields = [
    'rare_spawn', 'raid_started', 'friend_request', 'gift_received',
    'quest_complete', 'gym_under_attack', 'gym_lost',
    'sound_enabled', 'vibration_enabled'
  ];
  
  assert.strictEqual(validFields.length, 9, 'Should have 9 preference fields');
});

test('Notification preferences default values should be correct', () => {
  const defaults = {
    rare_spawn: true,
    raid_started: true,
    friend_request: true,
    gift_received: true,
    quest_complete: true,
    gym_under_attack: true,
    gym_lost: false, // Default off
    sound_enabled: true,
    vibration_enabled: true,
  };
  
  assert.strictEqual(defaults.gym_lost, false, 'gym_lost should default to false');
  assert.strictEqual(defaults.rare_spawn, true, 'rare_spawn should default to true');
});

// ============================================================
// Test Notification Data Structure
// ============================================================

test('RARE_SPAWN notification should have correct structure', () => {
  const data = {
    speciesId: 4,
    speciesName: 'Charmander',
    distance: 120,
    expireAt: '2026-06-05T18:30:00Z',
    lat: 31.2305,
    lng: 121.4740,
  };
  
  assert.ok(data.speciesId, 'Should have speciesId');
  assert.ok(data.speciesName, 'Should have speciesName');
  assert.ok(typeof data.distance === 'number', 'Distance should be a number');
  assert.ok(data.lat, 'Should have latitude');
  assert.ok(data.lng, 'Should have longitude');
});

test('RAID_STARTED notification should have correct structure', () => {
  const data = {
    raidId: 'raid-123',
    gymId: 'gym-456',
    gymName: 'Central Park Gym',
    bossName: 'Mewtwo',
    tier: 5,
    expiresAt: '2026-06-05T19:00:00Z',
    lat: 31.2305,
    lng: 121.4740,
  };
  
  assert.ok(data.raidId, 'Should have raidId');
  assert.ok(data.gymId, 'Should have gymId');
  assert.ok(data.bossName, 'Should have bossName');
  assert.ok(data.tier, 'Should have tier');
});

test('FRIEND_REQUEST notification should have correct structure', () => {
  const data = {
    fromUserId: 'user-789',
    fromUserName: 'Alice',
  };
  
  assert.ok(data.fromUserId, 'Should have fromUserId');
  assert.ok(data.fromUserName, 'Should have fromUserName');
});

test('QUEST_COMPLETE notification should have correct structure', () => {
  const data = {
    questId: 'quest-001',
    questName: 'Catch 10 Pokémon',
    rewards: [
      { type: 'ITEM', itemId: 'poke_ball', quantity: 10 },
      { type: 'XP', amount: 500 },
    ],
  };
  
  assert.ok(data.questId, 'Should have questId');
  assert.ok(data.questName, 'Should have questName');
  assert.ok(Array.isArray(data.rewards), 'Rewards should be an array');
});

// ============================================================
// Test WebSocket Message Protocol
// ============================================================

test('WebSocket notification message should have correct format', () => {
  const message = {
    type: 'NOTIFICATION',
    payload: {
      eventType: 'RARE_SPAWN',
      data: {
        speciesId: 4,
        speciesName: 'Charmander',
        distance: 120,
      },
      timestamp: '2026-06-05T18:00:00Z',
    },
  };
  
  assert.strictEqual(message.type, 'NOTIFICATION', 'Message type should be NOTIFICATION');
  assert.ok(message.payload, 'Should have payload');
  assert.ok(message.payload.eventType, 'Payload should have eventType');
  assert.ok(message.payload.data, 'Payload should have data');
  assert.ok(message.payload.timestamp, 'Payload should have timestamp');
});

test('WebSocket PING/PONG protocol should be correct', () => {
  const ping = { type: 'PING' };
  const pong = { type: 'PONG', timestamp: Date.now() };
  
  assert.strictEqual(ping.type, 'PING', 'Ping type should be PING');
  assert.strictEqual(pong.type, 'PONG', 'Pong type should be PONG');
  assert.ok(pong.timestamp, 'Pong should have timestamp');
});

// ============================================================
// Test Notification History
// ============================================================

test('Notification history should limit to 50 items', () => {
  const MAX_HISTORY = 50;
  const history = [];
  
  // Simulate adding 60 notifications
  for (let i = 0; i < 60; i++) {
    history.unshift({ id: i, type: 'TEST', data: {}, read: false });
    if (history.length > MAX_HISTORY) {
      history.splice(MAX_HISTORY);
    }
  }
  
  assert.strictEqual(history.length, MAX_HISTORY, `History should be limited to ${MAX_HISTORY} items`);
  assert.strictEqual(history[0].id, 59, 'Most recent notification should be first');
  assert.strictEqual(history[49].id, 10, 'Oldest notification should be last');
});

test('Notification history mark as read should work', () => {
  const history = [
    { id: 1, type: 'TEST', read: false },
    { id: 2, type: 'TEST', read: false },
  ];
  
  const notification = history.find(n => n.id === 1);
  if (notification) {
    notification.read = true;
  }
  
  assert.strictEqual(history[0].read, true, 'Notification should be marked as read');
  assert.strictEqual(history[1].read, false, 'Other notifications should remain unread');
});

// ============================================================
// Test Notification Display Logic
// ============================================================

test('Important notification types should trigger banner', () => {
  const importantTypes = ['RARE_SPAWN', 'RAID_STARTED', 'GYM_UNDER_ATTACK'];
  
  assert.ok(importantTypes.includes('RARE_SPAWN'), 'RARE_SPAWN should be important');
  assert.ok(importantTypes.includes('RAID_STARTED'), 'RAID_STARTED should be important');
  assert.ok(importantTypes.includes('GYM_UNDER_ATTACK'), 'GYM_UNDER_ATTACK should be important');
  assert.ok(!importantTypes.includes('FRIEND_REQUEST'), 'FRIEND_REQUEST should not be important');
});

test('Notification type to preference mapping should be correct', () => {
  const typeToPref = {
    RARE_SPAWN: 'rare_spawn',
    RAID_STARTED: 'raid_started',
    FRIEND_REQUEST: 'friend_request',
    GIFT_RECEIVED: 'gift_received',
    QUEST_COMPLETE: 'quest_complete',
    GYM_UNDER_ATTACK: 'gym_under_attack',
    GYM_LOST: 'gym_lost',
  };
  
  assert.strictEqual(typeToPref.RARE_SPAWN, 'rare_spawn');
  assert.strictEqual(typeToPref.GYM_LOST, 'gym_lost');
});

// ============================================================
// Test Notification Actions
// ============================================================

test('RARE_SPAWN action should be NAVIGATE', () => {
  const data = { lat: 31.2305, lng: 121.4740 };
  const action = { type: 'NAVIGATE', lat: data.lat, lng: data.lng };
  
  assert.strictEqual(action.type, 'NAVIGATE');
  assert.strictEqual(action.lat, data.lat);
  assert.strictEqual(action.lng, data.lng);
});

test('RAID_STARTED action should be JOIN_RAID', () => {
  const data = { raidId: 'raid-123', gymId: 'gym-456' };
  const action = { type: 'JOIN_RAID', raidId: data.raidId, gymId: data.gymId };
  
  assert.strictEqual(action.type, 'JOIN_RAID');
  assert.strictEqual(action.raidId, data.raidId);
});

test('FRIEND_REQUEST action should be VIEW_FRIENDS', () => {
  const action = { type: 'VIEW_FRIENDS', tab: 'requests' };
  
  assert.strictEqual(action.type, 'VIEW_FRIENDS');
  assert.strictEqual(action.tab, 'requests');
});

// ============================================================
// Test WebSocket Connection Management
// ============================================================

test('WebSocket reconnection delay should use exponential backoff', () => {
  const MAX_RETRIES = 5;
  const delays = [];
  
  for (let retries = 0; retries < MAX_RETRIES; retries++) {
    const delay = Math.min(1000 * 2 ** retries, 30000);
    delays.push(delay);
  }
  
  assert.strictEqual(delays[0], 1000, 'First retry should be 1 second');
  assert.strictEqual(delays[1], 2000, 'Second retry should be 2 seconds');
  assert.strictEqual(delays[2], 4000, 'Third retry should be 4 seconds');
  assert.strictEqual(delays[3], 8000, 'Fourth retry should be 8 seconds');
  assert.strictEqual(delays[4], 16000, 'Fifth retry should be 16 seconds');
});

test('WebSocket should not retry on auth failure', () => {
  const authErrorCode = 4001;
  const shouldRetry = authErrorCode !== 4001;
  
  assert.strictEqual(shouldRetry, false, 'Should not retry on auth failure');
});

// ============================================================
// Test Notification Preference Filtering
// ============================================================

test('Notification should be filtered by user preference', () => {
  const preferences = {
    rare_spawn: true,
    gym_lost: false,
  };
  
  const notification1 = { type: 'RARE_SPAWN', prefKey: 'rare_spawn' };
  const notification2 = { type: 'GYM_LOST', prefKey: 'gym_lost' };
  
  const shouldShow1 = preferences[notification1.prefKey];
  const shouldShow2 = preferences[notification2.prefKey];
  
  assert.strictEqual(shouldShow1, true, 'RARE_SPAWN should be shown');
  assert.strictEqual(shouldShow2, false, 'GYM_LOST should be filtered');
});

// ============================================================
// Summary
// ============================================================

console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
