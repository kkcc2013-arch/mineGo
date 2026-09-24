/**
 * REQ-00044: GDPR 数据导出（第 20 条 可携带权）与账号删除（第 17 条 被遗忘权）
 *
 * 设计要点
 * - 所有微服务共用同一个 PostgreSQL，因此"关联服务中的用户数据" = 所有外键引用 users(id) 的表，
 *   外加少量没有外键约束的个人数据表（位置历史、反作弊记录）。表清单在运行时从 pg_constraint 读取，
 *   新增业务表无需改动本模块。
 * - 导出：逐表导出该用户的行（剔除哈希/密钥类列），每表最多 EXPORT_ROW_LIMIT 行。
 * - 删除：申请后进入冷却期（默认 30 天，可撤销），到期由定时任务清理：
 *     NOT NULL 外键列 → 删除行；可空外键列 → 置 NULL（去标识化）；
 *     财务表（orders 等）依法保留，users 行保留为匿名占位（nickname=deleted_xxx，手机号/坐标/头像清空）。
 *   表间还有外键依赖（如交易记录引用精灵实例），因此按多轮 + SAVEPOINT 收敛执行。
 */
'use strict';

const { query, getClient } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { createLogger } = require('../../../../shared/logger');
const fieldCrypto = require('../../../../shared/fieldCrypto');

const logger = createLogger('gdpr-account-data');

const COOLDOWN_DAYS = Number(process.env.GDPR_DELETION_COOLDOWN_DAYS || 30);
const EXPORT_ROW_LIMIT = Number(process.env.GDPR_EXPORT_ROW_LIMIT || 5000);
// 依法保留的财务/结算表（行保留，引用匿名化后的 users 行）
const RETAIN_TABLES = new Set(['orders', 'payment_transactions', 'refunds', 'invoices']);
// 没有外键约束、但含个人数据的表：table -> user 列
const EXTRA_PERSONAL_TABLES = { user_location_history: 'user_id', anti_cheat_records: 'user_id' };
// 导出时剔除的列
const SENSITIVE_COLUMN = /(hash|secret|password|token|encrypted|_key$)/i;

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** 读取所有引用 users(id) 的单列外键：[{table, column, nullable}] */
async function userReferences(client = { query }) {
  const { rows } = await client.query(`
    SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name, NOT a.attnotnull AS nullable
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass AND array_length(c.conkey, 1) = 1
    ORDER BY 1, 2
  `);
  const refs = rows.map((r) => ({ table: r.table_name, column: r.column_name, nullable: r.nullable }));
  for (const [table, column] of Object.entries(EXTRA_PERSONAL_TABLES)) {
    const { rows: [t] } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]);
    if (t && !refs.some((r) => r.table === table && r.column === column)) refs.push({ table, column, nullable: true, extra: true });
  }
  return refs;
}

/** 引用 table 的子表外键（不含 ON DELETE CASCADE，那部分由数据库自行处理） */
async function childRefs(client, table) {
  const { rows } = await client.query(`
    SELECT c.conrelid::regclass::text AS child, a.attname AS child_col, pa.attname AS parent_col,
           NOT a.attnotnull AS nullable
    FROM pg_constraint c
    JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND c.confrelid = $1::regclass
      AND array_length(c.conkey, 1) = 1 AND c.confdeltype <> 'c'
  `, [table]);
  return rows;
}

/**
 * 删除 table 中满足 where 的行；先处理引用这些行的子表（可空列置 NULL，非空列递归删除）。
 * where 中使用 $1（用户 id）。
 */
async function deleteCascade(client, table, where, params, summary, depth = 0) {
  if (depth < 4) {
    for (const ch of await childRefs(client, table)) {
      if (ch.child === table) continue;
      const sub = `SELECT ${ident(ch.parent_col)} FROM ${ident(table)} WHERE ${where}`;
      if (ch.nullable) {
        const { rowCount } = await client.query(
          `UPDATE ${ident(ch.child)} SET ${ident(ch.child_col)} = NULL WHERE ${ident(ch.child_col)} IN (${sub})`, params);
        if (rowCount) summary.nullified[`${ch.child}.${ch.child_col}`] = (summary.nullified[`${ch.child}.${ch.child_col}`] || 0) + rowCount;
      } else {
        await deleteCascade(client, ch.child, `${ident(ch.child_col)} IN (${sub})`, params, summary, depth + 1);
      }
    }
  }
  const { rowCount } = await client.query(`DELETE FROM ${ident(table)} WHERE ${where}`, params);
  if (rowCount) summary.deleted[table] = (summary.deleted[table] || 0) + rowCount;
  return rowCount;
}

function scrub(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!SENSITIVE_COLUMN.test(k)) out[k] = v;
  return out;
}

/**
 * 导出用户的全部个人数据
 */
async function exportUserData(userId) {
  const { rows: [user] } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return null;

  const data = {};
  const truncated = [];
  for (const ref of await userReferences()) {
    try {
      const { rows } = await query(
        `SELECT * FROM ${ident(ref.table)} WHERE ${ident(ref.column)} = $1 LIMIT ${EXPORT_ROW_LIMIT + 1}`, [userId]);
      if (!rows.length) continue;
      if (rows.length > EXPORT_ROW_LIMIT) { rows.length = EXPORT_ROW_LIMIT; truncated.push(ref.table); }
      const key = data[ref.table] ? `${ref.table}.${ref.column}` : ref.table;
      data[key] = rows.map(scrub);
    } catch (err) {
      logger.warn({ table: ref.table, err: err.message }, 'export: table skipped');
    }
  }

  // REQ-00565: 手机号以密文存储，导出给用户本人时解密
  const profile = scrub(user);
  if (profile.phone) {
    try { profile.phone = fieldCrypto.decrypt(profile.phone, 'users.phone'); } catch { profile.phone = null; }
  }

  return {
    format: 'minego-gdpr-export/v1',
    exportedAt: new Date().toISOString(),
    userId,
    profile,
    data,
    truncated,
    notes: '每张表最多导出 ' + EXPORT_ROW_LIMIT + ' 行；如需完整数据请联系客服。哈希/密钥类字段不导出。',
  };
}

/**
 * 发起删除申请（冷却期内可撤销）
 */
async function requestDeletion(userId, reason) {
  const { rows: [existing] } = await query(
    `SELECT * FROM gdpr_deletion_requests WHERE user_id = $1 AND status IN ('PENDING','PROCESSING')`, [userId]);
  if (existing) return { request: existing, created: false };
  const { rows: [created] } = await query(`
    INSERT INTO gdpr_deletion_requests (user_id, reason, scheduled_for)
    VALUES ($1, $2, NOW() + make_interval(days => $3))
    RETURNING *
  `, [userId, reason || null, COOLDOWN_DAYS]);
  return { request: created, created: true };
}

async function cancelDeletion(userId) {
  const { rows: [r] } = await query(`
    UPDATE gdpr_deletion_requests SET status = 'CANCELLED', cancelled_at = NOW()
    WHERE user_id = $1 AND status = 'PENDING'
    RETURNING *
  `, [userId]);
  return r || null;
}

async function getDeletionStatus(userId) {
  const { rows } = await query(`
    SELECT id, status, reason, requested_at, scheduled_for, cancelled_at, completed_at
    FROM gdpr_deletion_requests WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 5
  `, [userId]);
  return rows;
}

/**
 * 执行清理（单个用户，单事务）
 */
async function purgeUser(userId) {
  const client = await getClient();
  const summary = { deleted: {}, nullified: {}, retained: [], failed: {} };
  try {
    await client.query('BEGIN');
    let pending = (await userReferences(client)).filter((r) => r.table !== 'gdpr_deletion_requests');
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      const next = [];
      for (const ref of pending) {
        if (RETAIN_TABLES.has(ref.table)) { summary.retained.push(ref.table); continue; }
        await client.query('SAVEPOINT gdpr_step');
        try {
          if (ref.nullable && !ref.extra) {
            const { rowCount } = await client.query(
              `UPDATE ${ident(ref.table)} SET ${ident(ref.column)} = NULL WHERE ${ident(ref.column)} = $1`, [userId]);
            if (rowCount) summary.nullified[`${ref.table}.${ref.column}`] = rowCount;
          } else {
            await deleteCascade(client, ref.table, `${ident(ref.column)} = $1`, [userId], summary);
          }
          await client.query('RELEASE SAVEPOINT gdpr_step');
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT gdpr_step');
          summary.failed[`${ref.table}.${ref.column}`] = err.message.split('\n')[0];
          next.push(ref);
        }
      }
      if (next.length === pending.length) break; // 无进展
      for (const ref of next) delete summary.failed[`${ref.table}.${ref.column}`];
      pending = next;
    }
    for (const ref of pending) {
      if (!summary.failed[`${ref.table}.${ref.column}`]) summary.failed[`${ref.table}.${ref.column}`] = 'unresolved dependency';
    }

    // users 行匿名化保留（财务记录仍引用它）
    await client.query(`
      UPDATE users SET
        nickname = 'deleted_' || substr(replace(id::text, '-', ''), 1, 12),
        phone = NULL, phone_hash = NULL, avatar_url = NULL,
        last_lat = NULL, last_lng = NULL, team = NULL,
        is_banned = TRUE, ban_reason = 'GDPR_DELETED',
        roles = '{}', deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Redis 中的位置、风控、签到等状态
  try {
    const redis = getRedis();
    await redis.zrem('geo:players', String(userId));
    await redis.del(`player:pos:${userId}`, `anticheat:location:${userId}`, `anticheat:trust:${userId}`, `daily:login:${userId}`);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'purge: redis cleanup failed');
  }
  // 吊销所有会话
  try {
    const { getJwtBlacklist } = require('../../../../shared/JwtBlacklist');
    await getJwtBlacklist().revokeAllTokens(userId, null, 'gdpr_deletion');
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'purge: token revocation failed');
  }
  return summary;
}

/**
 * 处理到期的删除申请（定时任务调用）
 */
async function processDueDeletions({ limit = 20, requestId = null } = {}) {
  const params = requestId ? [requestId] : [limit];
  const { rows } = await query(requestId
    ? `UPDATE gdpr_deletion_requests SET status = 'PROCESSING'
       WHERE id = $1 AND status = 'PENDING' RETURNING id, user_id`
    : `UPDATE gdpr_deletion_requests SET status = 'PROCESSING'
       WHERE id IN (SELECT id FROM gdpr_deletion_requests
                    WHERE status = 'PENDING' AND scheduled_for <= NOW()
                    ORDER BY scheduled_for LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, user_id`, params);
  const results = [];
  for (const r of rows) {
    try {
      const summary = await purgeUser(r.user_id);
      const failed = Object.keys(summary.failed).length > 0;
      await query(`UPDATE gdpr_deletion_requests SET status = $2, completed_at = NOW(), summary = $3, error = $4 WHERE id = $1`,
        [r.id, failed ? 'FAILED' : 'COMPLETED', JSON.stringify(summary), failed ? 'some tables could not be purged' : null]);
      logger.info({ requestId: r.id, userId: r.user_id, failed }, 'GDPR deletion processed');
      results.push({ id: r.id, userId: r.user_id, status: failed ? 'FAILED' : 'COMPLETED', summary });
    } catch (err) {
      await query(`UPDATE gdpr_deletion_requests SET status = 'FAILED', error = $2 WHERE id = $1`, [r.id, err.message]);
      logger.error({ requestId: r.id, err: err.message }, 'GDPR deletion failed');
      results.push({ id: r.id, userId: r.user_id, status: 'FAILED', error: err.message });
    }
  }
  return results;
}

/** 每 10 分钟检查一次到期申请（多实例下 Redis 锁保证单实例执行） */
function startDeletionScheduler(intervalMs = 10 * 60 * 1000) {
  const timer = setInterval(async () => {
    try {
      const ok = await getRedis().set('lock:gdpr:deletion-scheduler', String(process.pid), 'EX', 540, 'NX');
      if (ok) await processDueDeletions();
    } catch (err) {
      logger.error({ err: err.message }, 'GDPR deletion scheduler failed');
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  COOLDOWN_DAYS,
  exportUserData,
  requestDeletion,
  cancelDeletion,
  getDeletionStatus,
  purgeUser,
  processDueDeletions,
  startDeletionScheduler,
  userReferences,
};
