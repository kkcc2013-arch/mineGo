/**
 * 玩家资料规则（纯函数，无 I/O）——REQ-00327 / REQ-00387
 *
 * 收藏家积分（REQ-00327 §4.2）：新种类 ×10、闪光 ×50、完美个体值 ×30、图鉴完成每 10% +100、
 *   成就按稀有度 common 5 / rare 15 / epic 30 / legendary 50
 * 收藏家等级：1 初学者 0、2 收藏家 500、3 资深收藏家 2000、4 精灵学者 5000、5 传奇收藏家 10000
 *   特权：2 级精选精灵 3→5 只；3 级稀有头像框；4 级自定义资料背景（学者书房）；5 级专属称号"传奇收藏家"
 * 隐私：owner 全部；被对方拉黑 / private / friends(非好友) → restricted 只含基本信息；public 非好友 → public（隐藏社交明细、
 *   行走距离/探索区域、最近活跃、访客记录）；好友 → full。与 E01 隐私设置合并：可见性取两者更严格的一方，
 *   privacy_settings.achievements_visibility 控制成就/徽章是否展示
 */
'use strict';

const COLLECTOR_LEVELS = Object.freeze([
  { level: 1, minScore: 0, name: { zh: '初学者', en: 'Beginner', ja: 'ビギナー' }, perks: { zh: '基础资料展示', en: 'Basic profile', ja: '基本プロフィール' } },
  { level: 2, minScore: 500, name: { zh: '收藏家', en: 'Collector', ja: 'コレクター' }, perks: { zh: '精选精灵 +2', en: '+2 featured Pokémon', ja: '厳選ポケモン+2' } },
  { level: 3, minScore: 2000, name: { zh: '资深收藏家', en: 'Senior Collector', ja: 'ベテランコレクター' }, perks: { zh: '稀有精灵边框', en: 'Rare avatar frame', ja: 'レアフレーム' } },
  { level: 4, minScore: 5000, name: { zh: '精灵学者', en: 'Pokémon Scholar', ja: 'ポケモン学者' }, perks: { zh: '自定义资料背景', en: 'Custom profile background', ja: 'カスタム背景' } },
  { level: 5, minScore: 10000, name: { zh: '传奇收藏家', en: 'Legendary Collector', ja: '伝説のコレクター' }, perks: { zh: '专属称号解锁', en: 'Exclusive title', ja: '専用称号' } },
]);
const ACHIEVEMENT_RARITY_POINTS = Object.freeze({ common: 5, rare: 15, epic: 30, legendary: 50 });
const MAX_BADGES = 6;
const VISIBILITIES = Object.freeze(['public', 'friends', 'private']);
const STATS_SECTIONS = Object.freeze(['pokemon', 'battle', 'social', 'exploration', 'achievements', 'pokedex']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z0-9_]{2,50}$/;

function short(lang) {
  const l = String(lang || '').toLowerCase();
  return l.startsWith('en') ? 'en' : l.startsWith('ja') ? 'ja' : 'zh';
}

/**
 * @param {{uniqueSpecies:number, shinyCount:number, perfectIvCount:number, pokedexCaught:number, pokedexTotal:number,
 *          achievementsByRarity:Object<string,number>}} s
 */
function computeCollectorScore(s) {
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const species = n(s.uniqueSpecies) * 10;
  const shiny = n(s.shinyCount) * 50;
  const perfect = n(s.perfectIvCount) * 30;
  const total = n(s.pokedexTotal);
  const completionPct = total ? Math.min(100, (n(s.pokedexCaught) / total) * 100) : 0;
  const pokedex = Math.floor(completionPct / 10) * 100;
  let achievements = 0;
  for (const [rarity, count] of Object.entries(s.achievementsByRarity || {})) {
    achievements += (ACHIEVEMENT_RARITY_POINTS[rarity] || 0) * n(count);
  }
  const breakdown = { species, shiny, perfectIv: perfect, pokedexMilestones: pokedex, achievements };
  return { score: species + shiny + perfect + pokedex + achievements, breakdown };
}

function collectorLevel(score, lang) {
  const sc = Math.max(0, Number(score) || 0);
  let cur = COLLECTOR_LEVELS[0];
  for (const l of COLLECTOR_LEVELS) if (sc >= l.minScore) cur = l;
  const next = COLLECTOR_LEVELS.find((l) => l.level === cur.level + 1) || null;
  const k = short(lang);
  return {
    level: cur.level, name: cur.name[k], perks: cur.perks[k], score: sc, minScore: cur.minScore,
    nextScore: next ? next.minScore : null, nextName: next ? next.name[k] : null,
    progress: next ? +((sc - cur.minScore) / (next.minScore - cur.minScore)).toFixed(4) : 1,
  };
}

function featuredPokemonLimit(collectorLvl) { return (Number(collectorLvl) || 1) >= 2 ? 5 : 3; }

/**
 * 解锁条件 {minLevel, collectorLevel, achievementId}
 * @param {{level:number, collectorLevel:number, achievements:Set<string>}} ctx
 */
function meetsUnlock(cond, ctx) {
  const c = cond && typeof cond === 'object' ? cond : {};
  if (c.minLevel && (ctx.level || 1) < Number(c.minLevel)) return false;
  if (c.collectorLevel && (ctx.collectorLevel || 1) < Number(c.collectorLevel)) return false;
  if (c.achievementId && !(ctx.achievements && ctx.achievements.has(c.achievementId))) return false;
  return true;
}

function sanitizeText(s, max) {
  // eslint-disable-next-line no-control-regex
  return String(s == null ? '' : s).replace(/[<>]/g, '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

/**
 * 校验资料卡配置更新
 * @param {object} body
 * @param {{featuredLimit:number}} ctx
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
function validateProfilePatch(body, { featuredLimit = 3 } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.signature !== undefined) {
    const raw = String(b.signature == null ? '' : b.signature);
    if ([...raw].length > 100) return { ok: false, error: '签名最多 100 字' };
    out.signature = sanitizeText(raw, 100);
  }
  if (b.visibility !== undefined) {
    if (!VISIBILITIES.includes(b.visibility)) return { ok: false, error: 'visibility 必须是 public/friends/private' };
    out.visibility = b.visibility;
  }
  if (b.avatarFrameId !== undefined) {
    if (!CODE_RE.test(String(b.avatarFrameId))) return { ok: false, error: 'avatarFrameId 无效' };
    out.avatar_frame_id = String(b.avatarFrameId);
  }
  if (b.backgroundThemeId !== undefined) {
    if (!CODE_RE.test(String(b.backgroundThemeId))) return { ok: false, error: 'backgroundThemeId 无效' };
    out.background_theme_id = String(b.backgroundThemeId);
  }
  if (b.selectedBadges !== undefined) {
    if (!Array.isArray(b.selectedBadges)) return { ok: false, error: 'selectedBadges 必须是数组' };
    const ids = [...new Set(b.selectedBadges.map(String))];
    if (ids.length > MAX_BADGES) return { ok: false, error: `最多展示 ${MAX_BADGES} 个成就徽章` };
    if (ids.some((id) => !CODE_RE.test(id))) return { ok: false, error: 'selectedBadges 含无效成就 ID' };
    out.selected_badges = ids;
  }
  if (b.selectedPokemon !== undefined) {
    if (!Array.isArray(b.selectedPokemon)) return { ok: false, error: 'selectedPokemon 必须是数组' };
    const ids = [...new Set(b.selectedPokemon.map(String))];
    if (ids.length > featuredLimit) return { ok: false, error: `最多展示 ${featuredLimit} 只精选精灵` };
    if (ids.some((id) => !UUID_RE.test(id))) return { ok: false, error: 'selectedPokemon 含无效精灵 ID' };
    out.selected_pokemon = ids;
  }
  if (b.statsLayout !== undefined) {
    const l = b.statsLayout;
    if (!l || typeof l !== 'object' || Array.isArray(l)) return { ok: false, error: 'statsLayout 必须是对象' };
    const order = Array.isArray(l.order) ? l.order.filter((k) => STATS_SECTIONS.includes(k)) : undefined;
    const hidden = Array.isArray(l.hidden) ? l.hidden.filter((k) => STATS_SECTIONS.includes(k)) : undefined;
    out.stats_layout = { ...(order ? { order: [...new Set(order)] } : {}), ...(hidden ? { hidden: [...new Set(hidden)] } : {}) };
  }
  if (!Object.keys(out).length) return { ok: false, error: '没有可更新的字段' };
  return { ok: true, value: out };
}

// E01 隐私设置（privacy_settings.*_visibility，REQ-00228）与资料卡可见性合并：取更严格的一方
const VIS_RANK = { public: 0, friends: 1, close_friends: 1, custom: 1, private: 2, nobody: 2, hidden: 2 };
function mapPrivacyVisibility(v) {
  const r = VIS_RANK[String(v || 'public')];
  return r === undefined ? 'public' : ['public', 'friends', 'private'][r];
}
function stricterVisibility(a, b) {
  const ra = VIS_RANK[mapPrivacyVisibility(a)]; const rb = VIS_RANK[mapPrivacyVisibility(b)];
  return ['public', 'friends', 'private'][Math.max(ra, rb)];
}
/** 成就是否对该查看者可见（privacy_settings.achievements_visibility） */
function achievementsVisible(achievementsVisibility, audience) {
  if (audience === 'owner') return true;
  const v = mapPrivacyVisibility(achievementsVisibility);
  if (v === 'private') return false;
  if (v === 'friends') return audience === 'full';
  return true;
}

/** 查看者身份 → 可见范围 */
function audienceFor({ isOwner, isFriend, visibility, blocked = false }) {
  if (isOwner) return 'owner';
  if (blocked) return 'restricted';
  if (visibility === 'private') return 'restricted';
  if (visibility === 'friends') return isFriend ? 'full' : 'restricted';
  return isFriend ? 'full' : 'public';
}

/**
 * 按可见范围过滤完整资料（不修改入参）
 */
function filterProfile(profile, audience) {
  const p = JSON.parse(JSON.stringify(profile));
  p.audience = audience;
  if (audience === 'owner') return p;
  delete p.views;
  delete p.config;
  if (audience === 'full') return p;
  if (audience === 'restricted') {
    return { audience, restricted: true, player: pick(p.player, ['id', 'nickname', 'avatar', 'level', 'team', 'title', 'frame', 'theme', 'collector']) };
  }
  // public：隐藏社交明细与位置相关统计
  if (p.stats) {
    if (p.stats.social) p.stats.social = { friendsCount: p.stats.social.friendsCount };
    if (p.stats.exploration) p.stats.exploration = { pokeStopsVisited: p.stats.exploration.pokeStopsVisited };
  }
  if (p.player) delete p.player.lastActiveAt;
  if (p.room && !p.room.isPublic) delete p.room;
  return p;
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj && obj[k] !== undefined) o[k] = obj[k];
  return o;
}

// ── 可分享卡片（SVG，服务端生成，客户端可再转 PNG） ───────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
const HEX = /^#[0-9a-f]{3,8}$/i;
const color = (v, d) => (HEX.test(String(v || '')) ? v : d);
const TEAM_COLORS = { VALOR: '#E53935', MYSTIC: '#1E88E5', INSTINCT: '#FDD835' };

/**
 * @param {object} p  filterProfile 之后的资料（public/full/owner）
 * @param {{lang?:string, shareUrl?:string}} opts
 */
function renderCardSvg(p, { lang = 'zh-CN', shareUrl = '' } = {}) {
  const k = short(lang);
  const L = { zh: { lv: '等级', caught: '捕捉', species: '种类', shiny: '闪光', ach: '成就' },
    en: { lv: 'Lv', caught: 'Caught', species: 'Species', shiny: 'Shiny', ach: 'Achievements' },
    ja: { lv: 'Lv', caught: '捕獲', species: '種類', shiny: '色違い', ach: '実績' } }[k];
  const pl = p.player || {};
  const theme = (pl.theme && pl.theme.style) || {};
  const frame = (pl.frame && pl.frame.style) || {};
  const from = color(theme.from, '#3949AB'); const to = color(theme.to, '#1E88E5'); const text = color(theme.text, '#FFFFFF');
  const border = color(frame.border, '#FFFFFF');
  const initial = esc([...(pl.nickname || '?')][0] || '?');
  const st = (p.stats && p.stats.pokemon) || {};
  const ach = p.achievements || {};
  const cells = [
    [L.caught, st.totalCaught], [L.species, st.uniqueSpecies], [L.shiny, st.shinyCount], [L.ach, ach.unlocked],
  ].map(([label, v], i) => `<g transform="translate(${40 + i * 135},230)"><text class="v" x="0" y="0">${esc(v == null ? '-' : v)}</text><text class="l" x="0" y="24">${esc(label)}</text></g>`).join('');
  const badges = (p.badges || []).slice(0, 6).map((b, i) =>
    `<g transform="translate(${260 + i * 52},150)"><circle r="20" fill="rgba(255,255,255,0.18)" stroke="${border}"/><text class="b" y="6">${esc(b.icon || '🏅')}</text></g>`).join('');
  const title = pl.title && pl.title.name ? `<text class="t" x="170" y="118">「${esc(pl.title.name)}」</text>` : '';
  const collector = pl.collector ? `<text class="t" x="170" y="${title ? 142 : 118}">★ ${esc(pl.collector.name)} · ${esc(pl.collector.score)}</text>` : '';
  const team = TEAM_COLORS[pl.team] ? `<circle cx="552" cy="48" r="12" fill="${TEAM_COLORS[pl.team]}" stroke="#fff" stroke-width="2"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340" role="img" aria-label="${esc(pl.nickname)} ${esc(L.lv)} ${esc(pl.level)}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<style>text{font-family:-apple-system,'PingFang SC','Noto Sans CJK SC','Hiragino Sans',sans-serif;fill:${text}}.n{font-size:30px;font-weight:700}.t{font-size:16px;opacity:.9}.v{font-size:28px;font-weight:700}.l{font-size:14px;opacity:.8}.b{font-size:20px;text-anchor:middle}.s{font-size:12px;opacity:.7}.i{font-size:48px;font-weight:700;text-anchor:middle}</style>
<rect width="600" height="340" rx="24" fill="url(#bg)"/>
<circle cx="95" cy="100" r="58" fill="rgba(255,255,255,0.2)" stroke="${border}" stroke-width="6"/>
<text class="i" x="95" y="117">${initial}</text>
<text class="n" x="170" y="84">${esc(pl.nickname)}</text>
<text class="t" x="170" y="52">${esc(L.lv)} ${esc(pl.level)}</text>
${title}${collector}${team}${badges}${cells}
<text class="s" x="40" y="318">${esc(p.signature || '')}</text>
<text class="s" x="560" y="318" text-anchor="end">mineGo${shareUrl ? ` · ${esc(shareUrl)}` : ''}</text>
</svg>`;
}

module.exports = {
  COLLECTOR_LEVELS, ACHIEVEMENT_RARITY_POINTS, MAX_BADGES, VISIBILITIES, STATS_SECTIONS,
  computeCollectorScore, collectorLevel, featuredPokemonLimit, meetsUnlock, validateProfilePatch, audienceFor, filterProfile,
  mapPrivacyVisibility, stricterVisibility, achievementsVisible,
  renderCardSvg, sanitizeText,
};
