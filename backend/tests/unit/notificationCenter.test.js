'use strict';

// REQ-00099 / REQ-00261 / REQ-00425：消息中心数据访问层（内存数据库替身）
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeGameDb, stubSharedModules } = require('./helpers/fakeGameDb');

stubSharedModules();
const center = require('../../shared/notificationCenter');

const U = '11111111-1111-4111-8111-111111111111';
const TEMPLATES = [
  { template_key: 'event_start', category: 'activity', priority: 'normal', language: 'zh-CN', title_template: '活动开始', body_template: '{{event_name}} 已开始！持续 {{duration}}' },
  { template_key: 'event_start', category: 'activity', priority: 'normal', language: 'en-US', title_template: 'Event Started', body_template: '{{event_name}} has started! Duration: {{duration}}' },
  { template_key: 'event_start', category: 'activity', priority: 'normal', language: 'ja-JP', title_template: 'イベント開始', body_template: '{{event_name}}が始まりました！期間：{{duration}}' },
];

function db() {
  center.resetTemplateCache();
  return new FakeGameDb({ templates: TEMPLATES });
}

test('notify：按模板渲染中文落库、分类取自模板（activity → event）、记录 sent 事件', async () => {
  const d = db();
  const r = await center.notify(d, U, { type: 'event.started', templateKey: 'event_start',
    params: { event_name: '<b>夏日祭</b>', duration: '2h', _i18n: { 'en-US': { event_name: 'Summer Fest' } } }, dedupeKey: 'ev:1' });
  assert.equal(r.created, true);
  const n = d.notifications[0];
  assert.equal(n.category, 'event');
  assert.equal(n.title, '活动开始');
  assert.equal(n.body, 'b夏日祭/b 已开始！持续 2h', '参数里的尖括号被去除');
  assert.equal(d.notificationEvents.length, 1);
});

test('notify：同一去重键只生成一次；缺少类型不生成', async () => {
  const d = db();
  await center.notify(d, U, { type: 'system.announcement', title: 'A', dedupeKey: 'k' });
  const again = await center.notify(d, U, { type: 'system.announcement', title: 'A', dedupeKey: 'k' });
  assert.deepEqual(again, { created: false, reason: 'duplicate' });
  assert.equal((await center.notify(d, U, {})).created, false);
  assert.equal(d.notifications.length, 1);
});

test('notify：玩家关闭的分类不生成，系统类强制生成', async () => {
  const d = db();
  d.prefs[U] = { user_id: U, notification_types: { reward: false, system: false } };
  assert.deepEqual(await center.notify(d, U, { type: 'reward.level_up', category: 'reward', title: 'x' }), { created: false, reason: 'disabled_by_user' });
  assert.equal((await center.notify(d, U, { type: 'system.announcement', category: 'system', title: 'y' })).created, true);
});

test('view：按请求语言重新渲染模板（英文/日文），分类标签本地化', async () => {
  const d = db();
  await center.notify(d, U, { type: 'event.started', templateKey: 'event_start',
    params: { event_name: '夏日祭', duration: '2h', _i18n: { 'en-US': { event_name: 'Summer Fest' } } } });
  const templates = await center.loadTemplates(d);
  const row = d.notifications[0];
  const en = center.view(row, templates, 'en');
  assert.equal(en.title, 'Event Started');
  assert.equal(en.body, 'Summer Fest has started! Duration: 2h');
  assert.equal(en.categoryLabel, 'Events');
  const ja = center.view(row, templates, 'ja-JP');
  assert.equal(ja.body, '夏日祭が始まりました！期間：2h', '没有日文参数时用默认参数');
  assert.equal(center.view(row, templates, 'zh').title, '活动开始');
});

test('参数校验：非法 ID/分类/批量数量返回 400', async () => {
  const d = db();
  await assert.rejects(center.markRead(U, 'not-a-uuid', d), (e) => e.statusCode === 400);
  await assert.rejects(center.remove(U, '1; DROP TABLE x', d), (e) => e.statusCode === 400);
  await assert.rejects(center.batchRead(U, { ids: [] }, d), (e) => e.statusCode === 400);
  await assert.rejects(center.batchRead(U, { category: 'spam' }, d), (e) => e.statusCode === 400);
  await assert.rejects(center.batchDelete(U, new Array(201).fill(U), d), (e) => e.statusCode === 400);
  await assert.rejects(center.list(U, { category: 'spam' }, d), (e) => e.statusCode === 400);
  await assert.rejects(center.clearRead(U, { before: 'yesterday-ish' }, d), (e) => e.statusCode === 400);
});

test('标记已读：不属于自己的消息返回 404', async () => {
  const d = db();
  await assert.rejects(center.markRead(U, '00000000-0000-4000-8000-000000000999', d), (e) => e.statusCode === 404);
});

test('偏好更新：非法请求 400；合法请求写入并返回规范化偏好', async () => {
  const d = db();
  await assert.rejects(center.updatePreferences(U, { quietHours: { start: '99:99' } }, d), (e) => e.statusCode === 400);
  const writes = [];
  const orig = d.query.bind(d);
  d.query = async (sql, params) => {
    if (/user_push_preferences/.test(sql) && /^(INSERT|UPDATE)/.test(sql.trim())) {
      writes.push(sql.replace(/\s+/g, ' ').trim());
      if (/^UPDATE/.test(sql.trim())) d.prefs[U] = { user_id: U, notification_types: JSON.parse(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    return orig(sql, params);
  };
  const prefs = await center.updatePreferences(U, { notificationTypes: { social: false } }, d);
  assert.ok(writes.some((w) => w.includes("notification_types = COALESCE(user_push_preferences.notification_types, '{}'::jsonb) || $2::jsonb")),
    '分类开关与已有值合并');
  assert.equal(prefs.categories.social, false);
});
