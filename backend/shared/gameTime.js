/**
 * 游戏日（跨服务统一的"今天"）
 *
 * 签到、每日任务、每日上限等按"游戏日"结算。原先签到用 UTC 日期（JS toISOString），每日任务用
 * 数据库 CURRENT_DATE（取决于数据库会话时区），两者在不同时区配置下互相错开一天。
 * 统一由 GAME_TIMEZONE（默认 Asia/Shanghai）决定游戏日边界。
 */
'use strict';

const GAME_TIMEZONE = process.env.GAME_TIMEZONE || 'Asia/Shanghai';

const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    // en-CA 的日期格式即 YYYY-MM-DD
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return formatters.get(tz);
}

/** 某一时刻所在的游戏日 'YYYY-MM-DD' */
function gameDate(at = new Date(), tz = GAME_TIMEZONE) {
  return formatter(tz).format(at instanceof Date ? at : new Date(at));
}

/** 游戏日 'YYYY-MM-DD' 加减天数（纯日历运算，与时区/夏令时无关） */
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 前一个游戏日 */
function previousGameDate(at = new Date(), tz = GAME_TIMEZONE) {
  return addDays(gameDate(at, tz), -1);
}

module.exports = { GAME_TIMEZONE, gameDate, previousGameDate, addDays };
