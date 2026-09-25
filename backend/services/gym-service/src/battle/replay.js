// 战斗回放录制、精彩时刻识别与分享（REQ-00379 / REQ-00469）
//
// 录制：战斗结束时把完整事件流（每回合动作、伤害、连击、状态、换人）连同双方阵容、随机种子
//       序列化为 JSON 并 gzip 压缩存入 battle_replay_records.compressed_data（file_size_bytes 为压缩后大小）。
// 精彩时刻：暴击、效果拔群、击倒、连击、控制、逆转、残血取胜、一穿多、无伤通关 共 9 类。
// 分享：随机 8 位分享码（可设密码/有效期/最大查看次数），生成链接、二维码（SVG）与微信/QQ/Twitter 分享入口；
//       通过分享码查看无需登录（网关公开路由），其余接口需登录。
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { query } = require('../../../../shared/db');
const { BattleError } = require('./engine');
const battleMetrics = require('./metrics');

const REPLAY_VERSION = 2;
const SHARE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };
const HIGHLIGHT_TYPES = ['critical_hit', 'super_effective', 'knockout', 'combo', 'status_control', 'comeback', 'clutch', 'sweep', 'flawless'];

function publicBase() {
  return (process.env.PUBLIC_WEB_URL || 'https://minego.app').replace(/\/$/, '');
}

/** 精彩时刻识别 */
function extractHighlights(state, sum) {
  const out = [];
  const team = state.attacker.team;
  const byId = new Map([...team, ...state.defender.team].map((c) => [c.pokemonId, c]));
  for (const t of state.log) {
    for (const a of t.actions) {
      if (a.type === 'attack' && a.actor === 'attacker' && !a.missed) {
        const target = byId.get(a.targetId);
        const share = target ? a.damage / target.maxHp : 0;
        if (a.isCritical && share >= 0.2) {
          out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'critical_hit', severity: share >= 0.5 ? 'high' : 'medium', title: `${a.name} 会心一击！`, description: `${a.moveName} 造成 ${a.damage} 点伤害` });
        }
        if (a.effectiveness > 1.01 && share >= 0.25) {
          out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'super_effective', severity: 'medium', title: '效果拔群！', description: `${a.name} 的 ${a.moveName} 对 ${target ? target.name : '对手'} 造成 ${a.damage} 点伤害` });
        }
        if (a.combo) {
          out.push({ startTurn: Math.max(1, t.turn - 2), endTurn: t.turn, highlightType: 'combo', severity: a.combo.quality === 'perfect' ? 'high' : 'medium', title: `${a.combo.name}（${a.combo.quality}）`, description: `连击倍率 ×${a.combo.multiplier}，${a.moveName} 造成 ${a.damage} 点伤害` });
        }
      }
      if (a.type === 'status_apply' && a.actor === 'attacker' && ['STUN', 'FREEZE'].includes(a.effect)) {
        out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'status_control', severity: 'low', title: '控制成功', description: a.message });
      }
      if (a.type === 'faint' && a.side === 'defender') {
        out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'knockout', severity: 'medium', title: `击倒 ${a.name}`, description: `第 ${t.turn} 回合击倒对手` });
      }
    }
  }
  if (sum.result === 'win') {
    const fainted = sum.attackersFainted;
    if (team.length >= 2 && fainted >= Math.ceil(team.length / 2)) {
      out.push({ startTurn: 1, endTurn: state.turn, highlightType: 'comeback', severity: 'high', title: '绝境逆转！', description: `倒下 ${fainted} 只精灵后仍赢得胜利` });
    }
    const last = state.attacker.team[state.attacker.active];
    if (last && last.hp > 0 && last.hp / last.maxHp <= 0.15) {
      out.push({ startTurn: state.turn, endTurn: state.turn, highlightType: 'clutch', severity: 'high', title: '残血取胜', description: `${last.name} 仅剩 ${last.hp} HP 拿下胜利` });
    }
    if (fainted === 0 && state.defender.team.length >= 2) {
      out.push({ startTurn: 1, endTurn: state.turn, highlightType: 'flawless', severity: 'high', title: '无伤通关', description: `未倒下任何精灵击败 ${state.defender.team.length} 只对手` });
    }
  }
  for (const c of team) {
    if ((c.knockouts || 0) >= 2) {
      out.push({ startTurn: 1, endTurn: state.turn, highlightType: 'sweep', severity: 'high', title: `${c.name} 一穿${c.knockouts}`, description: `${c.name} 独自击倒 ${c.knockouts} 只对手` });
    }
  }
  const seen = new Set();
  return out
    .filter((h) => { const k = `${h.highlightType}:${h.startTurn}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.startTurn - b.startTurn)
    .slice(0, 12);
}

function teamSnapshot(team) {
  return team.map((c) => ({
    pokemonId: c.pokemonId, ownerId: c.ownerId, speciesId: c.speciesId, name: c.name, types: c.types, cp: c.cp,
    maxHp: c.maxHp, finalHp: c.hp, moves: c.moves.map((m) => ({ id: m.id, name: m.name, type: m.type, category: m.category })),
    damageDealt: c.damageDealt, knockouts: c.knockouts || 0,
  }));
}

function buildPayload(state) {
  return {
    version: REPLAY_VERSION, battleId: state.id, type: state.type, mode: state.mode, weather: state.weather,
    seed: state.seed, startedAt: state.startedAt, endedAt: state.endedAt, result: state.result,
    attackerTeam: teamSnapshot(state.attacker.team), defenderTeam: teamSnapshot(state.defender.team),
    turns: state.log,
  };
}

/**
 * 录制回放（结算后调用）。重复调用同一 battleId 不会重复写入。
 * @returns {{replayId:number, highlights:Array, sizeBytes:number, rawBytes:number}}
 */
async function recordReplay(state, sum, { gymId = null, opponentUserId = null, labels = {} } = {}) {
  const payload = buildPayload(state);
  const raw = Buffer.from(JSON.stringify(payload));
  const gz = zlib.gzipSync(raw, { level: 9 });
  const highlights = extractHighlights(state, sum);
  const participants = [state.userId, opponentUserId].filter(Boolean);
  const species = [...new Set([...state.attacker.team, ...state.defender.team].map((c) => c.speciesId).filter(Boolean))];
  const summary = {
    result: sum.result, turns: sum.turns, durationMs: sum.durationMs, damageDealt: sum.damageDealt, damageTaken: sum.damageTaken,
    defendersDefeated: sum.defendersDefeated.length, defendersTotal: state.defender.team.length,
    combos: sum.combos.length, comboPoints: sum.comboPoints, highlightCount: highlights.length, ...labels,
  };
  const { rows: [rec] } = await query(`
    INSERT INTO battle_replay_records (battle_id, gym_id, battle_type, attacker_user_id, attacker_team, defender_info, result,
       final_turns, duration_ms, event_stream, file_size_bytes, compression, compressed_data, participant_user_ids,
       species_ids, summary, replay_version, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,$10,'gzip',$11,$12::uuid[],$13::smallint[],$14,$15, NOW() + INTERVAL '90 days')
    ON CONFLICT (battle_id) DO NOTHING
    RETURNING id`, [
    state.id, gymId, state.type, state.userId, JSON.stringify(payload.attackerTeam),
    JSON.stringify({ team: payload.defenderTeam, opponentUserId, ...labels }), sum.result, sum.turns, sum.durationMs,
    gz.length, gz, participants, species, JSON.stringify(summary), REPLAY_VERSION,
  ]);
  if (!rec) {
    const { rows: [existing] } = await query('SELECT id FROM battle_replay_records WHERE battle_id = $1', [state.id]);
    return { replayId: existing && existing.id, highlights, sizeBytes: gz.length, rawBytes: raw.length, duplicate: true };
  }
  if (highlights.length) {
    const vals = [];
    const params = [];
    highlights.forEach((h, i) => {
      const b = i * 7;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      params.push(rec.id, h.startTurn, h.endTurn, h.highlightType, h.title.slice(0, 200), h.description, h.severity);
    });
    await query(`INSERT INTO replay_highlights (replay_id, start_turn, end_turn, highlight_type, title, description, severity) VALUES ${vals.join(',')}`, params);
  }
  battleMetrics.replaysRecorded.inc({ type: state.type });
  return { replayId: rec.id, highlights, sizeBytes: gz.length, rawBytes: raw.length };
}

function decodePayload(row) {
  if (row.compressed_data) return JSON.parse(zlib.gunzipSync(row.compressed_data).toString('utf8'));
  return { version: 1, turns: row.event_stream || [] };
}

async function getHighlights(replayId) {
  const { rows } = await query(`SELECT id, start_turn, end_turn, highlight_type, title, description, severity, share_count
      FROM replay_highlights WHERE replay_id = $1
     ORDER BY CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, start_turn`, [replayId]);
  return rows;
}

function toInt(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BattleError('INVALID_ID', '回放 ID 无效', 400);
  return n;
}

function replayView(row, payload, highlights) {
  return {
    replayId: row.id, battleId: row.battle_id, battleType: row.battle_type, result: row.result,
    turns: row.final_turns, durationMs: row.duration_ms, isPublic: row.is_public, summary: row.summary,
    attackerUserId: row.attacker_user_id, attackerNickname: row.attacker_nickname,
    attackerTeam: row.attacker_team, defenderInfo: row.defender_info,
    viewCount: row.view_count, likeCount: row.like_count, shareCount: row.share_count,
    sizeBytes: row.file_size_bytes, compression: row.compression, createdAt: row.created_at,
    highlights, replay: payload,
  };
}

const REPLAY_SELECT = `SELECT r.*, u.nickname AS attacker_nickname FROM battle_replay_records r LEFT JOIN users u ON u.id = r.attacker_user_id`;

/** 按回放 ID 查看（本人或公开回放） */
async function getReplay(replayId, viewerId) {
  const id = toInt(replayId);
  const { rows: [row] } = await query(`${REPLAY_SELECT} WHERE r.id = $1`, [id]);
  if (!row) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在', 404);
  if (!row.is_public && row.attacker_user_id !== viewerId && !(row.participant_user_ids || []).includes(viewerId)) {
    throw new BattleError('REPLAY_PRIVATE', '该回放为私密状态', 403);
  }
  await query('UPDATE battle_replay_records SET view_count = COALESCE(view_count,0) + 1 WHERE id = $1', [id]);
  battleMetrics.replayViews.inc({ via: 'id' });
  return replayView({ ...row, view_count: (row.view_count || 0) + 1 }, decodePayload(row), await getHighlights(id));
}

async function getReplayByBattle(battleId, viewerId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(battleId))) throw new BattleError('INVALID_ID', '战斗 ID 无效', 400);
  const { rows: [row] } = await query('SELECT id FROM battle_replay_records WHERE battle_id = $1', [battleId]);
  if (!row) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在', 404);
  return getReplay(row.id, viewerId);
}

function listRow(r) {
  return {
    replayId: r.id, battleId: r.battle_id, battleType: r.battle_type, result: r.result, turns: r.final_turns,
    durationMs: r.duration_ms, attackerUserId: r.attacker_user_id, attackerNickname: r.attacker_nickname,
    viewCount: r.view_count, likeCount: r.like_count, shareCount: r.share_count, isPublic: r.is_public,
    summary: r.summary, sizeBytes: r.file_size_bytes, createdAt: r.created_at,
  };
}

const LIST_COLS = `r.id, r.battle_id, r.battle_type, r.result, r.final_turns, r.duration_ms, r.attacker_user_id, u.nickname AS attacker_nickname,
  r.view_count, r.like_count, r.share_count, r.is_public, r.summary, r.file_size_bytes, r.created_at`;

async function listMine(userId, { result, limit = 20, offset = 0 } = {}) {
  const params = [userId];
  let where = '($1 = r.attacker_user_id OR $1 = ANY(r.participant_user_ids))';
  if (result && ['win', 'lose', 'forfeit'].includes(result)) { params.push(result); where += ` AND r.result = $${params.length}`; }
  params.push(Math.min(50, Number(limit) || 20), Math.max(0, Number(offset) || 0));
  const { rows } = await query(`SELECT ${LIST_COLS} FROM battle_replay_records r LEFT JOIN users u ON u.id = r.attacker_user_id
     WHERE ${where} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map(listRow);
}

/** 热门榜：按观看数或点赞数排序（仅公开回放） */
async function listHot({ sort = 'views', limit = 20, days = 30 } = {}) {
  const order = sort === 'likes' ? 'r.like_count DESC, r.view_count DESC' : 'r.view_count DESC, r.like_count DESC';
  const { rows } = await query(`SELECT ${LIST_COLS} FROM battle_replay_records r LEFT JOIN users u ON u.id = r.attacker_user_id
     WHERE r.is_public AND r.created_at > NOW() - make_interval(days => $1)
     ORDER BY ${order}, r.id DESC LIMIT $2`, [Math.min(365, Number(days) || 30), Math.min(100, Number(limit) || 20)]);
  return rows.map(listRow);
}

/** 搜索：按玩家（ID/昵称）、精灵种类、战斗类型、结果 */
async function search({ userId, nickname, speciesId, battleType, result, limit = 20, offset = 0 } = {}) {
  const params = [];
  const conds = ['r.is_public'];
  if (userId) { params.push(userId); conds.push(`($${params.length}::uuid = r.attacker_user_id OR $${params.length}::uuid = ANY(r.participant_user_ids))`); }
  if (nickname) { params.push(`%${String(nickname).slice(0, 30).replace(/[%_\\]/g, '\\$&')}%`); conds.push(`u.nickname ILIKE $${params.length}`); }
  if (speciesId) { params.push(Number(speciesId)); conds.push(`$${params.length}::smallint = ANY(r.species_ids)`); }
  if (battleType) { params.push(String(battleType)); conds.push(`r.battle_type = $${params.length}`); }
  if (result) { params.push(String(result)); conds.push(`r.result = $${params.length}`); }
  params.push(Math.min(50, Number(limit) || 20), Math.max(0, Number(offset) || 0));
  const { rows } = await query(`SELECT ${LIST_COLS} FROM battle_replay_records r LEFT JOIN users u ON u.id = r.attacker_user_id
     WHERE ${conds.join(' AND ')} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map(listRow);
}

function genShareCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += SHARE_ALPHABET[b % SHARE_ALPHABET.length];
  return s;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(12).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, h] = stored.split('$');
  const got = crypto.scryptSync(String(pw || ''), salt, 32);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function qrSvg(text) {
  try {
    const QR = require('qrcode');
    return await QR.toString(text, { type: 'svg', margin: 1, width: 240 });
  } catch {
    return null;
  }
}

/** 生成分享链接（本人回放） */
async function createShare(replayId, userId, opts = {}) {
  const id = toInt(replayId);
  const { rows: [row] } = await query('SELECT id, attacker_user_id, participant_user_ids, result, summary FROM battle_replay_records WHERE id = $1', [id]);
  if (!row) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在', 404);
  if (row.attacker_user_id !== userId && !(row.participant_user_ids || []).includes(userId)) throw new BattleError('FORBIDDEN', '只能分享自己的回放', 403);
  const platform = ['wechat', 'qq', 'twitter', 'link', 'community'].includes(opts.platform) ? opts.platform : 'link';
  const maxViews = Math.max(0, Math.min(100000, Number(opts.maxViews) || 0));
  const hours = Number(opts.expiresInHours) || 0;
  const expiresAt = hours > 0 ? new Date(Date.now() + Math.min(hours, 24 * 365) * 3600e3) : null;
  let share;
  for (let i = 0; i < 5 && !share; i++) {
    const code = genShareCode();
    const { rows: [s] } = await query(`INSERT INTO replay_shares (replay_id, share_code, shared_by_user_id, is_public, password_hash, max_views, platform, expires_at, share_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (share_code) DO NOTHING RETURNING *`,
    [id, code, userId, opts.isPublic !== false, opts.password ? hashPassword(opts.password) : null, maxViews, platform, expiresAt,
      `${publicBase()}/replay.html?code=${code}`]);
    share = s;
  }
  if (!share) throw new BattleError('SHARE_FAILED', '生成分享码失败，请重试', 500);
  await query('UPDATE battle_replay_records SET share_count = COALESCE(share_count,0) + 1 WHERE id = $1', [id]);
  const url = share.share_url;
  const s = row.summary || {};
  const text = `我在 mineGo ${row.result === 'win' ? '赢得' : '经历'}了一场 ${s.turns || ''} 回合的精彩对战！`;
  return {
    shareCode: share.share_code, shareUrl: url, platform, isPublic: share.is_public, passwordProtected: !!share.password_hash,
    maxViews: share.max_views, expiresAt: share.expires_at,
    social: {
      twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      qq: `https://connect.qq.com/widget/shareqq/index.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}`,
      wechat: { hint: '微信内扫码或长按识别二维码分享', url },
    },
    qrCodeSvg: await qrSvg(url),
    preview: { title: text, result: row.result, ...s },
  };
}

/** 通过分享码查看（无需登录） */
async function viewShared(code, { password, viewerId } = {}) {
  if (!/^[A-Z0-9]{6,12}$/.test(String(code || ''))) throw new BattleError('INVALID_CODE', '分享码无效', 400);
  const { rows: [s] } = await query('SELECT * FROM replay_shares WHERE share_code = $1', [code]);
  if (!s) throw new BattleError('SHARE_NOT_FOUND', '分享链接不存在', 404);
  if (s.expires_at && new Date(s.expires_at) < new Date()) throw new BattleError('SHARE_EXPIRED', '分享链接已过期', 410);
  if (!s.is_public && s.shared_by_user_id !== viewerId) throw new BattleError('REPLAY_PRIVATE', '该回放为私密状态', 403);
  if (s.password_hash && !verifyPassword(password, s.password_hash)) throw new BattleError('PASSWORD_REQUIRED', '需要正确的访问密码', 401);
  const { rows: [upd] } = await query(`UPDATE replay_shares SET current_views = current_views + 1, last_viewed_at = NOW()
      WHERE id = $1 AND (max_views = 0 OR current_views < max_views) RETURNING current_views`, [s.id]);
  if (!upd) throw new BattleError('VIEW_LIMIT', '该回放已达最大查看次数', 410);
  const { rows: [row] } = await query(`${REPLAY_SELECT} WHERE r.id = $1`, [s.replay_id]);
  if (!row) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在', 404);
  await query('UPDATE battle_replay_records SET view_count = COALESCE(view_count,0) + 1 WHERE id = $1', [row.id]);
  battleMetrics.replayViews.inc({ via: 'share' });
  const view = replayView({ ...row, view_count: (row.view_count || 0) + 1 }, decodePayload(row), await getHighlights(row.id));
  view.share = { code: s.share_code, views: upd.current_views, maxViews: s.max_views, platform: s.platform };
  return view;
}

async function toggleLike(replayId, userId) {
  const id = toInt(replayId);
  const { rows: [row] } = await query('SELECT id, is_public, attacker_user_id FROM battle_replay_records WHERE id = $1', [id]);
  if (!row) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在', 404);
  if (!row.is_public && row.attacker_user_id !== userId) throw new BattleError('REPLAY_PRIVATE', '该回放为私密状态', 403);
  const ins = await query('INSERT INTO replay_likes (replay_id, user_id) VALUES ($1,$2) ON CONFLICT (replay_id, user_id) DO NOTHING RETURNING id', [id, userId]);
  let liked = true;
  if (!ins.rowCount) {
    await query('DELETE FROM replay_likes WHERE replay_id = $1 AND user_id = $2', [id, userId]);
    liked = false;
  }
  const { rows: [c] } = await query(`UPDATE battle_replay_records SET like_count = (SELECT COUNT(*) FROM replay_likes WHERE replay_id = $1)
      WHERE id = $1 RETURNING like_count`, [id]);
  return { liked, likeCount: c.like_count };
}

async function addComment(replayId, userId, text, parentId = null) {
  const id = toInt(replayId);
  const body = String(text || '').trim();
  if (!body || body.length > 500) throw new BattleError('INVALID_COMMENT', '评论需为 1-500 字', 400);
  const { rows: [row] } = await query('SELECT id, is_public, attacker_user_id FROM battle_replay_records WHERE id = $1', [id]);
  if (!row) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在', 404);
  if (!row.is_public && row.attacker_user_id !== userId) throw new BattleError('REPLAY_PRIVATE', '该回放为私密状态', 403);
  const { rows: [c] } = await query(`INSERT INTO replay_comments (replay_id, user_id, comment, parent_comment_id)
      VALUES ($1,$2,$3,(SELECT id FROM replay_comments WHERE id = $4 AND replay_id = $1)) RETURNING id, comment, parent_comment_id, created_at`,
  [id, userId, body, parentId ? Number(parentId) : null]);
  return c;
}

async function listComments(replayId) {
  const id = toInt(replayId);
  const { rows } = await query(`SELECT c.id, c.comment, c.parent_comment_id, c.like_count, c.created_at, u.nickname
      FROM replay_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.replay_id = $1 ORDER BY c.created_at LIMIT 200`, [id]);
  return rows;
}

async function setVisibility(replayId, userId, isPublic) {
  const id = toInt(replayId);
  const { rowCount } = await query('UPDATE battle_replay_records SET is_public = $3 WHERE id = $1 AND attacker_user_id = $2', [id, userId, !!isPublic]);
  if (!rowCount) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在或无权修改', 404);
  return { replayId: id, isPublic: !!isPublic };
}

async function removeReplay(replayId, userId) {
  const id = toInt(replayId);
  const { rowCount } = await query('DELETE FROM battle_replay_records WHERE id = $1 AND attacker_user_id = $2', [id, userId]);
  if (!rowCount) throw new BattleError('REPLAY_NOT_FOUND', '回放不存在或无权删除', 404);
  return { deleted: true };
}

module.exports = {
  HIGHLIGHT_TYPES, extractHighlights, buildPayload, recordReplay, decodePayload, getReplay, getReplayByBattle,
  listMine, listHot, search, createShare, viewShared, toggleLike, addComment, listComments, setVisibility, removeReplay,
  hashPassword, verifyPassword, genShareCode,
};
