'use strict';

// REQ-00099 / REQ-00261 / REQ-00425：消息分类、偏好、免打扰、投递计划（纯函数）
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../../shared/notificationPolicy');

test('类型/模板分类 → 消息分类', () => {
  assert.equal(p.categoryOf('social.friend_request'), 'social');
  assert.equal(p.categoryOf('activity'), 'event');
  assert.equal(p.categoryOf('raid'), 'event');
  assert.equal(p.categoryOf('rare_spawn'), 'pokemon');
  assert.equal(p.categoryOf('reward.level_up'), 'reward');
  assert.equal(p.categoryOf('whatever'), 'system');
});

test('偏好规范化：默认全开；分类开关/具体类型开关/旧键；系统与安全强制开启', () => {
  const d = p.normalizePreferences(null);
  assert.equal(d.categories.social, true); assert.equal(d.push, true); assert.equal(d.quietHours.enabled, false);
  const n = p.normalizePreferences({ notification_types: { social: false, system: false, 'reward.level_up': false, friend_request: false },
    quiet_hours: { enabled: true, start: '23:00', end: '07:00' }, enable_push: false, timezone: 'Asia/Tokyo' });
  assert.equal(n.categories.social, false);
  assert.equal(n.categories.system, true, '系统类强制');
  assert.equal(n.types['reward.level_up'], false);
  assert.equal(n.push, false); assert.equal(n.timezone, 'Asia/Tokyo');
  assert.equal(p.isAllowed(n, { type: 'social.gift_received', category: 'social' }), false);
  assert.equal(p.isAllowed(n, { type: 'reward.level_up', category: 'reward' }), false);
  assert.equal(p.isAllowed(n, { type: 'reward.achievement_unlock', category: 'reward' }), true);
  assert.equal(p.isAllowed(n, { type: 'system.announcement', category: 'system' }), true);
  // 旧键 friend_request=false 也能关闭 social.friend_request
  const legacy = p.normalizePreferences({ notification_types: { friend_request: false } });
  assert.equal(p.isAllowed(legacy, { type: 'social.friend_request', category: 'social' }), false);
});

test('免打扰：跨午夜时段按玩家时区判断；临时静音', () => {
  const prefs = p.normalizePreferences({ quiet_hours: { enabled: true, start: '22:00', end: '08:00' }, timezone: 'Asia/Shanghai' });
  // 2026-09-25T15:30Z = 上海 23:30 → 免打扰；03:00Z = 上海 11:00 → 否；23:00Z = 上海 07:00 → 免打扰
  assert.equal(p.inQuietHours(prefs, new Date('2026-09-25T15:30:00Z')), true);
  assert.equal(p.inQuietHours(prefs, new Date('2026-09-25T03:00:00Z')), false);
  assert.equal(p.inQuietHours(prefs, new Date('2026-09-25T23:00:00Z')), true);
  const day = p.normalizePreferences({ quiet_hours: { enabled: true, start: '12:00', end: '14:00' }, timezone: 'UTC' });
  assert.equal(p.inQuietHours(day, new Date('2026-09-25T13:00:00Z')), true);
  assert.equal(p.inQuietHours(day, new Date('2026-09-25T14:00:00Z')), false);
  const muted = p.normalizePreferences({ mute_until: new Date(Date.now() + 60000) });
  assert.equal(p.inQuietHours(muted), true);
});

test('投递计划：在线走 WebSocket（免打扰静默）；离线按条件推送或降级站内并给出原因', () => {
  const now = new Date('2026-09-25T15:30:00Z'); // 上海 23:30
  const base = p.normalizePreferences({ fcm_token: 't', quiet_hours: { enabled: true, start: '22:00', end: '08:00' }, timezone: 'Asia/Shanghai' });
  let plan = p.planDelivery({ notification: { priority: 'normal' }, prefs: base, online: true, now });
  assert.equal(plan.ws, true); assert.equal(plan.silent, true);
  plan = p.planDelivery({ notification: { priority: 'urgent' }, prefs: base, online: true, now });
  assert.equal(plan.silent, false, '紧急消息不受免打扰');
  plan = p.planDelivery({ notification: { priority: 'high' }, prefs: base, online: false, providers: { fcm: true }, now });
  assert.equal(plan.push, null); assert.deepEqual(plan.reasons, ['quiet_hours']);
  const day = new Date('2026-09-25T03:00:00Z');
  plan = p.planDelivery({ notification: { priority: 'high' }, prefs: base, online: false, providers: { fcm: false, apns: false }, now: day });
  assert.equal(plan.push, null); assert.deepEqual(plan.reasons, ['push_provider_unconfigured']);
  plan = p.planDelivery({ notification: { priority: 'high' }, prefs: base, online: false, providers: { fcm: true }, now: day });
  assert.equal(plan.push, 'fcm');
  plan = p.planDelivery({ notification: { priority: 'high' }, prefs: base, online: false, providers: { fcm: true }, recentPushCount: 6, now: day });
  assert.deepEqual(plan.reasons, ['rate_limited']);
  plan = p.planDelivery({ notification: { priority: 'low' }, prefs: base, online: false, providers: { fcm: true }, now: day });
  assert.deepEqual(plan.reasons, ['low_priority_in_app_only']);
  const noDevice = p.normalizePreferences({});
  plan = p.planDelivery({ notification: { priority: 'high' }, prefs: noDevice, online: false, providers: { fcm: true }, now: day });
  assert.deepEqual(plan.reasons, ['no_device_token']);
  const off = p.normalizePreferences({ enable_push: false, fcm_token: 't' });
  plan = p.planDelivery({ notification: { priority: 'urgent' }, prefs: off, online: false, providers: { fcm: true }, now: day });
  assert.deepEqual(plan.reasons, ['push_disabled']);
  assert.equal(plan.inApp, true, '任何情况下都落站内消息');
});

test('偏好更新校验', () => {
  assert.equal(p.validatePreferencePatch({}).ok, false);
  assert.equal(p.validatePreferencePatch({ quietHours: { enabled: true, start: '25:00' } }).ok, false);
  assert.equal(p.validatePreferencePatch({ notificationTypes: { social: 'no' } }).ok, false);
  assert.equal(p.validatePreferencePatch({ notificationTypes: { 'bad key!': true } }).ok, false);
  assert.equal(p.validatePreferencePatch({ timezone: 'Mars/Base' }).ok, false);
  assert.equal(p.validatePreferencePatch({ channels: ['pigeon'] }).ok, false);
  assert.equal(p.validatePreferencePatch({ muteForMinutes: 99999 }).ok, false);
  const ok = p.validatePreferencePatch({ notificationTypes: { social: false, system: false }, quietHours: { enabled: true, start: '22:00', end: '08:00' },
    enablePush: false, timezone: 'Asia/Tokyo', muteForMinutes: 30, maxPushPerHour: 3, channels: ['websocket', 'fcm', 'fcm'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.notification_types.system, true, '强制类不能关闭');
  assert.equal(ok.value.notification_types.social, false);
  assert.deepEqual(ok.value.preferred_channels, ['websocket', 'fcm']);
  assert.ok(ok.value.mute_until instanceof Date);
  assert.equal(p.validatePreferencePatch({ muteForMinutes: 0 }).value.mute_until, null);
});

test('模板渲染：变量替换并去除尖括号（防通知注入）', () => {
  assert.equal(p.renderTemplate('{{sender_name}} 想和你成为好友', { sender_name: '<script>x</script>' }), 'scriptx/script 想和你成为好友');
  assert.equal(p.renderTemplate('Lv {{ new_level }}', { new_level: 10 }), 'Lv 10');
  assert.equal(p.renderTemplate('{{missing}}!', {}), '!');
  assert.equal(p.sanitizeText('a'.repeat(600)).length, 500);
});

test('偏好视图包含强制分类与设备状态', () => {
  const v = p.preferencesView(p.normalizePreferences({ apns_token: 'x' }));
  assert.deepEqual(v.mandatoryCategories.sort(), ['security', 'system']);
  assert.deepEqual(v.devices, { fcm: false, apns: true });
});
