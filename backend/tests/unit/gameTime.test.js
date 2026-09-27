'use strict';
// 游戏日边界：直接测试 shared/gameTime（签到/每日任务统一使用）
const test = require('node:test');
const assert = require('node:assert');
const { gameDate, previousGameDate, addDays } = require('../../shared/gameTime');

test('gameDate：上海时区 16:30Z 已是次日', () => {
  const t = new Date('2026-09-24T16:30:00Z');
  assert.strictEqual(gameDate(t, 'Asia/Shanghai'), '2026-09-25');
  assert.strictEqual(gameDate(t, 'UTC'), '2026-09-24');
});

test('gameDate：上海时区 15:59:59Z 仍是当日', () => {
  assert.strictEqual(gameDate(new Date('2026-09-24T15:59:59Z'), 'Asia/Shanghai'), '2026-09-24');
});

test('previousGameDate 与 addDays 跨月/跨年', () => {
  assert.strictEqual(previousGameDate(new Date('2026-10-01T02:00:00Z'), 'Asia/Shanghai'), '2026-09-30');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDays('2028-03-01', -1), '2028-02-29');
});

test('默认时区来自 GAME_TIMEZONE（未设置时为 Asia/Shanghai）', () => {
  const { GAME_TIMEZONE } = require('../../shared/gameTime');
  assert.strictEqual(GAME_TIMEZONE, process.env.GAME_TIMEZONE || 'Asia/Shanghai');
});
