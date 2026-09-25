/**
 * 小队规则（REQ-00558）——纯函数，无 I/O
 *
 * 小队（squad）是临时组队：2–20 人，类型 raid/gym/casual，一人同时只在一个小队。
 * 加入策略：invite（仅受邀或持小队码）/ friends（任一成员的好友）/ guild（同公会成员）/ open（任何人）。
 * 队长可踢人、转让、解散、改设置、发起 Raid 集结；任何成员可邀请好友。
 *
 * 语音拓扑（服务端权威，见 selectVoiceMode）：
 *   mesh  —— 语音人数 ≤ 5：全互联，每人与其他人各一条 P2P 连接
 *   floor —— 语音人数 > 5：发言席位（最多 4 人同时发言，自动/按键申请），听众只连接发言者，
 *            发言者连接所有人；没有媒体服务器（MCU/SFU）时用于大队伍，控制每个听众的连接数 ≤ 4
 *   回到 mesh 有滞回：人数降到 ≤ 4 才切回，避免 5↔6 人时来回切换
 */
'use strict';

const SQUAD_TYPES = Object.freeze(['raid', 'gym', 'casual']);
const JOIN_POLICIES = Object.freeze(['invite', 'friends', 'guild', 'open']);
const MIN_CAPACITY = 2;
const MAX_CAPACITY = 20;
const DEFAULT_CAPACITY = Object.freeze({ raid: 20, gym: 6, casual: 5 });
const MESH_MAX = 5;
const MESH_RETURN_AT = 4;
const MAX_SPEAKERS = 4;
const INVITE_TTL_MIN = 15;
const LEADER_REWARD_BONUS = 0.1;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

function cleanName(v) {
  return typeof v === 'string' ? v.replace(CONTROL, '').trim().slice(0, 64) : '';
}

/**
 * 校验创建/修改小队输入 → { value, errors }
 * @param {object} input { name, squadType, maxMembers, joinPolicy, withGuild }
 */
function validateSquadInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const value = {};
  const errors = [];
  if (!partial || src.name !== undefined) {
    const name = cleanName(src.name === undefined ? '我的小队' : src.name);
    if (name.length < 1 || name.length > 20) errors.push('小队名称长度需在 1–20 个字符之间');
    else value.name = name;
  }
  if (!partial || src.squadType !== undefined) {
    const t = src.squadType === undefined ? 'casual' : src.squadType;
    if (!SQUAD_TYPES.includes(t)) errors.push(`squadType 必须是 ${SQUAD_TYPES.join('/')}`);
    else value.squadType = t;
  }
  if (!partial || src.maxMembers !== undefined) {
    const n = src.maxMembers === undefined ? DEFAULT_CAPACITY[value.squadType || 'casual'] : Number(src.maxMembers);
    if (!Number.isInteger(n) || n < MIN_CAPACITY || n > MAX_CAPACITY) errors.push(`maxMembers 必须是 ${MIN_CAPACITY}–${MAX_CAPACITY} 的整数`);
    else value.maxMembers = n;
  }
  if (!partial || src.joinPolicy !== undefined) {
    const p = src.joinPolicy === undefined ? 'invite' : src.joinPolicy;
    if (!JOIN_POLICIES.includes(p)) errors.push(`joinPolicy 必须是 ${JOIN_POLICIES.join('/')}`);
    else value.joinPolicy = p;
  }
  if (src.withGuild !== undefined) {
    if (typeof src.withGuild !== 'boolean') errors.push('withGuild 必须是布尔值');
    else value.withGuild = src.withGuild;
  }
  if (partial && !errors.length && !Object.keys(value).length) errors.push('没有可更新的设置项');
  return { value, errors };
}

/**
 * 能否加入小队
 * @param {object} ctx
 *   squad: { status, max_members, join_policy, guild_id }
 *   memberCount, alreadyInThisSquad, inOtherSquad, blocked（与任一成员互相拉黑）,
 *   hasInvite, viaCode（持有正确小队码）, isFriendOfMember, sameGuild
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
function canJoin(ctx) {
  const { squad } = ctx;
  if (!squad || squad.status === 'disbanded') return { ok: false, code: 'SQUAD_NOT_FOUND', message: '小队不存在或已解散' };
  if (ctx.alreadyInThisSquad) return { ok: false, code: 'ALREADY_MEMBER', message: '你已在该小队中' };
  if (ctx.inOtherSquad) return { ok: false, code: 'IN_OTHER_SQUAD', message: '你已在其他小队中，请先退出' };
  if (ctx.blocked) return { ok: false, code: 'BLOCKED', message: '无法加入该小队' };
  if (ctx.memberCount >= squad.max_members) return { ok: false, code: 'SQUAD_FULL', message: '小队已满' };
  if (ctx.hasInvite || ctx.viaCode) return { ok: true };
  switch (squad.join_policy) {
    case 'open': return { ok: true };
    case 'friends': return ctx.isFriendOfMember ? { ok: true } : { ok: false, code: 'NOT_ALLOWED', message: '该小队仅限成员的好友加入' };
    case 'guild': return ctx.sameGuild ? { ok: true } : { ok: false, code: 'NOT_ALLOWED', message: '该小队仅限同公会成员加入' };
    default: return { ok: false, code: 'INVITE_REQUIRED', message: '该小队需要邀请或小队码才能加入' };
  }
}

const LEADER_ONLY = new Set(['kick', 'transfer', 'disband', 'edit_settings', 'raid_call', 'regenerate_code']);

function canAct(role, action) {
  if (action === 'invite' || action === 'leave' || action === 'share_location') return role === 'leader' || role === 'member';
  if (LEADER_ONLY.has(action)) return role === 'leader';
  throw new Error(`unknown squad action ${action}`);
}

/** 队长离队时的继任者：入队最早的其他成员 */
function nextLeader(members, leaderId) {
  const others = (members || []).filter((m) => m.user_id !== leaderId);
  if (!others.length) return null;
  others.sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at) || String(a.user_id).localeCompare(String(b.user_id)));
  return others[0].user_id;
}

/**
 * 语音模式（带滞回）：人数 > 5 切到 floor；已在 floor 时人数 ≤ 4 才回到 mesh
 * @param {number} participants 语音中的人数
 * @param {'mesh'|'floor'|null} prev 当前模式
 */
function selectVoiceMode(participants, prev = null) {
  const n = Math.max(0, Math.floor(participants || 0));
  if (n > MESH_MAX) return 'floor';
  if (prev === 'floor' && n > MESH_RETURN_AT) return 'floor';
  return 'mesh';
}

/**
 * 单项战斗贡献得分：伤害/治疗每 10 点 1 分，捕捉每只 50 分，道馆占领每分钟 5 分
 */
function contributionScore({ damage = 0, healing = 0, catches = 0, holdSeconds = 0 } = {}) {
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  return Math.floor(n(damage) / 10) + Math.floor(n(healing) / 10) + n(catches) * 50 + Math.floor(n(holdSeconds) / 60) * 5;
}

/**
 * 按贡献分配奖励比例：权重 = max(得分, 1)，队长 ×(1+10%)；比例之和为 1（四舍五入到 4 位后把误差补到最大者）。
 * MVP = 得分最高者（并列取先出现的）。
 * @param {Array<{userId: string, score: number, isLeader?: boolean}>} members
 * @returns {Array<{userId, score, share, isMvp}>}
 */
function allocateRewards(members, { leaderBonus = LEADER_REWARD_BONUS } = {}) {
  const list = (members || []).filter((m) => m && m.userId);
  if (!list.length) return [];
  const weights = list.map((m) => Math.max(1, Math.floor(m.score || 0)) * (m.isLeader ? 1 + leaderBonus : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.round((w / total) * 10000) / 10000);
  const drift = Math.round((1 - shares.reduce((a, b) => a + b, 0)) * 10000) / 10000;
  let maxIdx = 0;
  for (let i = 1; i < shares.length; i++) if (shares[i] > shares[maxIdx]) maxIdx = i;
  shares[maxIdx] = Math.round((shares[maxIdx] + drift) * 10000) / 10000;
  let mvp = 0;
  for (let i = 1; i < list.length; i++) if ((list[i].score || 0) > (list[mvp].score || 0)) mvp = i;
  return list.map((m, i) => ({ userId: m.userId, score: Math.floor(m.score || 0), share: shares[i], isMvp: i === mvp }));
}

/** 奖励池按比例分配为整数（向下取整，余数给比例最大者） */
function splitPool(pool, allocations) {
  const out = {};
  const keys = Object.keys(pool || {}).filter((k) => Number.isFinite(pool[k]) && pool[k] > 0);
  if (!allocations.length) return out;
  let top = 0;
  allocations.forEach((a, i) => { if (a.share > allocations[top].share) top = i; out[a.userId] = {}; });
  for (const k of keys) {
    const total = Math.floor(pool[k]);
    let given = 0;
    allocations.forEach((a) => { const v = Math.floor(total * a.share); out[a.userId][k] = v; given += v; });
    out[allocations[top].userId][k] += total - given;
  }
  return out;
}

/** 由成员战斗得分折算的公会贡献（每 20 分 1 贡献，胜利 +5，至少 1） */
function contributionFromScore(score, outcome) {
  return Math.max(1, Math.floor(Math.max(0, score) / 20) + (outcome === 'won' ? 5 : 0));
}

/** 小队成就（由战绩统计推导，不单独存表） */
const ACHIEVEMENTS = Object.freeze([
  Object.freeze({ id: 'first_victory', name: '初次胜利', test: (s) => s.wins >= 1 }),
  Object.freeze({ id: 'raid_veteran', name: 'Raid 老兵', test: (s) => s.raidWins >= 10 }),
  Object.freeze({ id: 'gym_holder', name: '道馆守护者', test: (s) => s.holdSeconds >= 3600 }),
  Object.freeze({ id: 'full_house', name: '满员出击', test: (s) => s.maxParticipants >= 10 }),
  Object.freeze({ id: 'centurion', name: '百战之师', test: (s) => s.battles >= 100 }),
]);

function achievementsFor(stats) {
  const s = { wins: 0, raidWins: 0, holdSeconds: 0, maxParticipants: 0, battles: 0, ...(stats || {}) };
  return ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, unlocked: !!a.test(s) }));
}

module.exports = {
  SQUAD_TYPES, JOIN_POLICIES, MIN_CAPACITY, MAX_CAPACITY, DEFAULT_CAPACITY, MESH_MAX, MESH_RETURN_AT, MAX_SPEAKERS,
  INVITE_TTL_MIN, LEADER_REWARD_BONUS, ACHIEVEMENTS,
  validateSquadInput, canJoin, canAct, nextLeader, selectVoiceMode,
  contributionScore, allocateRewards, splitPool, contributionFromScore, achievementsFor,
};
