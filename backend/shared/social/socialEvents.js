/**
 * 社交实时事件（REQ-00048 / REQ-00326 / REQ-00388）
 *
 * 任一服务通过 Redis 频道 social:events 发布 { userIds, type, payload }，
 * social-service 的 WebSocket 服务（/ws/friends）订阅后推送给在线用户（支持多实例：每个实例只推送本机连接）。
 * 持久化的互动提醒写 interaction_reminders（dedupe_key 去重）后同样推送一条 reminder 事件。
 */
'use strict';

const { createLogger } = require('../logger');

const logger = createLogger('social-events');
const CHANNEL = 'social:events';

let redisFactory = () => require('../redis').getRedis();

/** 测试注入 */
function _setRedisFactory(fn) { redisFactory = fn; }

async function publish(userIds, type, payload = {}) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return 0;
  const msg = JSON.stringify({ userIds: ids, type, payload, ts: new Date().toISOString() });
  try {
    return await redisFactory().publish(CHANNEL, msg);
  } catch (err) {
    logger.warn({ err: err.message, type }, 'social event publish failed');
    return 0;
  }
}

/**
 * 写入一条互动提醒并实时推送
 * @param {{query: Function}} q
 * @param {object} r { userId, type, relatedUserId, content, dedupeKey }
 * @returns {Promise<object|null>} 新提醒；dedupe 命中返回 null
 */
async function createReminder(q, { userId, type, relatedUserId = null, content = {}, dedupeKey = null }) {
  try {
    const { rows } = await q.query(`
      INSERT INTO interaction_reminders (user_id, reminder_type, related_user_id, content, dedupe_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id, reminder_type, related_user_id, content, is_read, created_at`,
    [userId, type, relatedUserId, JSON.stringify(content || {}), dedupeKey]);
    if (!rows.length) return null;
    await publish([userId], 'reminder', rows[0]);
    return rows[0];
  } catch (err) {
    logger.warn({ err: err.message, type, userId }, 'create reminder failed');
    return null;
  }
}

module.exports = { CHANNEL, publish, createReminder, _setRedisFactory };
