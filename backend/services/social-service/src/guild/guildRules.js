/**
 * 公会规则（REQ-00058）——纯函数，无 I/O，单测直接覆盖
 *
 * 职位：leader（会长）> co_leader（副会长）> elder（长老）> member（成员）；旧数据中的 novice 视同 member。
 * 等级：累计经验 exp 满足 500·L·(L−1) 即达到 L 级（L=2 需 1000，L=10 需 45000，L=50 需 1 225 000），上限 50 级；
 *       成员上限 = 50 + 2·(L−1)。
 * 贡献：捐赠 10 金币 = 1 贡献 = 1 公会经验；小队战斗按成员得分折算（见 squadRules.contributionFromScore）。
 */
'use strict';

const ROLES = Object.freeze(['leader', 'co_leader', 'elder', 'member']);
const RANK = Object.freeze({ leader: 4, co_leader: 3, elder: 2, member: 1, novice: 1 });
const ROLE_LABEL = Object.freeze({ leader: '会长', co_leader: '副会长', elder: '长老', member: '成员', novice: '成员' });
const JOIN_TYPES = Object.freeze(['public', 'apply', 'invite_only']);
const BADGE_ICONS = Object.freeze(['🛡️', '⚔️', '🔥', '💧', '⚡', '🌿', '🌙', '⭐', '🐉', '👑', '🦊', '🌈']);
const MAX_LEVEL = 50;
const CREATE_COST_COINS = 5000;
const MAX_DONATION_COINS = 100000;

/** 每项操作要求的最低职位等级 */
const PERMISSIONS = Object.freeze({
  chat: 1,
  donate: 1,
  claim_items: 1,
  view_applications: 2,
  review_applications: 2,
  invite: 2,
  manage_events: 2,
  kick: 3,
  set_role: 3,
  edit_settings: 3,
  announce: 3,
  activate_buff: 3,
  regenerate_invite_code: 3,
  transfer: 4,
  disband: 4,
});

/** 每日从仓库领取道具的上限（按职位） */
const DAILY_CLAIM_LIMIT = Object.freeze({ 1: 3, 2: 10, 3: 50, 4: 50 });

/** 公会增益目录：解锁等级、效果值、持续时长、消耗公会资金 */
const BUFFS = Object.freeze({
  catch_bonus: Object.freeze({ unlockLevel: 5, value: 0.05, hours: 24, cost: 2000, label: '捕捉成功率 +5%' }),
  xp_bonus: Object.freeze({ unlockLevel: 10, value: 0.10, hours: 24, cost: 3000, label: '经验值 +10%' }),
  stardust_bonus: Object.freeze({ unlockLevel: 15, value: 0.10, hours: 24, cost: 3000, label: '星尘 +10%' }),
  raid_damage_bonus: Object.freeze({ unlockLevel: 20, value: 0.05, hours: 12, cost: 5000, label: 'Raid 伤害 +5%' }),
});

/** 每周公会任务模板（进度由服务端按数据源统计，见 guildService.refreshTaskProgress） */
const WEEKLY_TASKS = Object.freeze([
  Object.freeze({ key: 'weekly_catch', type: 'catch', title: '全员捕捉', description: '本周公会成员合计捕捉精灵', target: (lv) => 200 + 20 * (lv - 1), rewards: { guildExp: 1500, treasury: 1000 } }),
  Object.freeze({ key: 'weekly_raid', type: 'raid', title: '小队 Raid', description: '本周以公会小队身份赢得 Raid', target: (lv) => 3 + Math.floor(lv / 5), rewards: { guildExp: 2000, treasury: 1500 } }),
  Object.freeze({ key: 'weekly_donate', type: 'donate', title: '充实金库', description: '本周成员合计捐赠金币', target: (lv) => 10000 + 1000 * (lv - 1), rewards: { guildExp: 1000, treasury: 0 } }),
  Object.freeze({ key: 'weekly_battle', type: 'battle', title: '并肩作战', description: '本周以公会小队身份赢得战斗（Raid/道馆）', target: (lv) => 10 + lv, rewards: { guildExp: 1200, treasury: 800 } }),
]);

function rankOf(role) {
  return RANK[role] || 0;
}

function can(role, action) {
  const need = PERMISSIONS[action];
  if (!need) throw new Error(`unknown guild action ${action}`);
  return rankOf(role) >= need;
}

/** 只能踢出职位严格低于自己的成员 */
function canKick(actorRole, targetRole) {
  return can(actorRole, 'kick') && rankOf(actorRole) > rankOf(targetRole);
}

/**
 * 设置职位：新职位只能是 co_leader/elder/member；操作者职位须严格高于目标当前职位与新职位
 * （因此只有会长能任命副会长；会长职位只能通过转让变更）
 */
function canSetRole(actorRole, targetRole, newRole) {
  if (!['co_leader', 'elder', 'member'].includes(newRole)) return false;
  if (!can(actorRole, 'set_role')) return false;
  return rankOf(actorRole) > rankOf(targetRole) && rankOf(actorRole) > rankOf(newRole);
}

function dailyClaimLimit(role) {
  return DAILY_CLAIM_LIMIT[rankOf(role)] || 0;
}

function experienceForLevel(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 500 * l * (l - 1);
}

function levelForExperience(exp) {
  const e = Math.max(0, Math.floor(Number(exp) || 0));
  // 解 500·L·(L−1) ≤ e 的最大整数 L
  let l = Math.floor((1 + Math.sqrt(1 + e / 125)) / 2);
  while (l > 1 && experienceForLevel(l) > e) l--;
  while (l < MAX_LEVEL && experienceForLevel(l + 1) <= e) l++;
  return Math.max(1, Math.min(MAX_LEVEL, l));
}

function maxMembersForLevel(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 50 + 2 * (l - 1);
}

/** 等级进度：{ level, exp, current, next, progress(0-1) } */
function levelProgress(exp) {
  const level = levelForExperience(exp);
  const current = experienceForLevel(level);
  const next = level >= MAX_LEVEL ? null : experienceForLevel(level + 1);
  return {
    level,
    exp: Math.max(0, Math.floor(Number(exp) || 0)),
    current,
    next,
    progress: next === null ? 1 : Number(((exp - current) / (next - current)).toFixed(4)),
  };
}

function availableBuffs(level) {
  return Object.entries(BUFFS)
    .filter(([, b]) => level >= b.unlockLevel)
    .map(([type, b]) => ({ type, ...b }));
}

function contributionForCoins(amount) {
  return Math.floor(Math.max(0, amount) / 10);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

/** 去控制字符/双向覆盖字符、首尾空白；超长截断 */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(CONTROL, '').trim().slice(0, max);
}

/**
 * 校验创建/修改公会的输入，返回 { value, errors }
 * @param {object} input
 * @param {{partial?: boolean}} opts  partial=true 用于修改设置（字段可缺省）
 */
function validateGuildInput(input, { partial = false } = {}) {
  const errors = [];
  const value = {};
  const src = input && typeof input === 'object' ? input : {};
  if (!partial || src.name !== undefined) {
    const name = cleanText(src.name, 64);
    if (name.length < 2 || name.length > 24) errors.push('公会名称长度需在 2–24 个字符之间');
    else value.name = name;
  }
  if (src.description !== undefined) {
    value.description = cleanText(src.description, 300);
  }
  if (!partial || src.joinType !== undefined) {
    const jt = src.joinType === undefined ? 'apply' : src.joinType;
    if (!JOIN_TYPES.includes(jt)) errors.push(`joinType 必须是 ${JOIN_TYPES.join('/')}`);
    else value.joinType = jt;
  }
  if (!partial || src.minLevel !== undefined) {
    const ml = src.minLevel === undefined ? 1 : Number(src.minLevel);
    if (!Number.isInteger(ml) || ml < 1 || ml > 50) errors.push('minLevel 必须是 1–50 的整数');
    else value.minLevel = ml;
  }
  if (src.badgeIcon !== undefined) {
    if (!BADGE_ICONS.includes(src.badgeIcon)) errors.push('badgeIcon 不在可选徽章中');
    else value.badgeIcon = src.badgeIcon;
  } else if (!partial) {
    value.badgeIcon = BADGE_ICONS[0];
  }
  if (partial && !errors.length && !Object.keys(value).length) errors.push('没有可更新的设置项');
  return { value, errors };
}

/** 聊天内容：去控制字符、合并连续空白，1–300 字；空内容返回 null */
function sanitizeChat(text) {
  const t = cleanText(typeof text === 'string' ? text.replace(/\s+/g, ' ') : '', 300);
  return t ? t : null;
}

/** 邀请码：大写字母数字 6–12 位；非法返回 null */
function normalizeInviteCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9]{6,12}$/.test(c) ? c : null;
}

/** 周一 00:00（UTC）所在日期 'YYYY-MM-DD'，用于每周贡献懒重置与每周任务窗口 */
function weekStart(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** 本周任务实例（starts_at/ends_at 为 UTC 周一 00:00 起 7 天） */
function weeklyTaskInstances(level, now = new Date()) {
  const start = new Date(`${weekStart(now)}T00:00:00Z`);
  const end = new Date(start.getTime() + 7 * 86400000);
  return WEEKLY_TASKS.map((t) => ({
    taskKey: t.key,
    taskType: t.type,
    title: t.title,
    description: t.description,
    target: t.target(Math.max(1, level || 1)),
    rewards: { ...t.rewards },
    startsAt: start,
    endsAt: end,
  }));
}

/** 成员称号，如「〈星火〉会长」 */
function memberTitle(role, guildName) {
  return `〈${guildName}〉${ROLE_LABEL[role] || ROLE_LABEL.member}`;
}

module.exports = {
  ROLES, RANK, ROLE_LABEL, JOIN_TYPES, BADGE_ICONS, PERMISSIONS, BUFFS, WEEKLY_TASKS, MAX_LEVEL,
  CREATE_COST_COINS, MAX_DONATION_COINS, DAILY_CLAIM_LIMIT,
  rankOf, can, canKick, canSetRole, dailyClaimLimit,
  experienceForLevel, levelForExperience, maxMembersForLevel, levelProgress, availableBuffs, contributionForCoins,
  cleanText, validateGuildInput, sanitizeChat, normalizeInviteCode, weekStart, weeklyTaskInstances, memberTitle,
};
