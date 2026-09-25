// frontend/game-client/src/features/profile-notify/profileCard.js
// REQ-00327 玩家资料页（统计网格、收藏家徽章、图鉴进度、成就展示、精选精灵）+ REQ-00387 资料卡编辑与分享
//   - 编辑：头像框、背景主题、签名、可见性（公开/好友/私密）、徽章（≤6）、精选精灵（3，收藏家 2 级起 5）
//   - 分享：分享链接 + 二维码 + 卡片图片（服务端 SVG，客户端转 PNG 下载）
//   - 查看他人：按玩家 ID 打开（服务端做隐私过滤）；收藏家排行榜
import { http, h, openSheet, progressBar, emptyState } from './core.js';

const VIS_LABEL = { public: '公开', friends: '仅好友', private: '私密' };

function statCell(label, value) {
  return h('div', { class: 'pn-stat' }, h('div', { class: 'pn-stat-v' }, value === undefined || value === null ? '—' : String(value)), h('div', { class: 'pn-stat-l' }, label));
}

function header(p) {
  const pl = p.player || {};
  const style = (pl.theme && pl.theme.style) || {};
  const frame = (pl.frame && pl.frame.style) || {};
  return h('div', { class: 'pn-prof-hero', style: { background: `linear-gradient(135deg, ${style.from || '#3949AB'}, ${style.to || '#1E88E5'})`, color: style.text || '#fff' } },
    h('div', { class: `pn-avatar${frame.glow ? ' glow' : ''}`, style: { borderColor: frame.border || '#fff' }, 'aria-hidden': 'true' }, [...(pl.nickname || '?')][0]),
    h('div', {},
      h('div', { class: 'pn-prof-name' }, pl.nickname || '训练师'),
      pl.title ? h('div', { class: 'pn-title-tag' }, `「${pl.title.name}」`) : null,
      h('div', {}, `Lv.${pl.level || 1}${pl.team ? ` · ${pl.team}` : ''}`),
      pl.collector ? h('div', { class: 'pn-collector', 'data-testid': 'collector-badge' }, `★ ${pl.collector.name}（${pl.collector.score} 分）`) : null));
}

export function renderProfile(p, { onPokemon } = {}) {
  const frag = h('div', { class: 'pn-profile', 'data-testid': 'player-profile' }, header(p));
  if (p.restricted) {
    frag.append(h('p', { class: 'pn-card' }, '🔒 该玩家的资料未公开，只能看到基本信息。'));
    return frag;
  }
  if (p.signature) frag.append(h('p', { class: 'pn-card pn-signature' }, `“${p.signature}”`));
  const c = p.player.collector;
  if (c) {
    frag.append(h('div', { class: 'pn-card' }, h('strong', {}, `收藏家等级 ${c.level} · ${c.name}`),
      c.nextScore ? h('small', {}, ` 距「${c.nextName}」还差 ${c.nextScore - c.score} 分`) : h('small', {}, ' 已达最高等级'),
      progressBar(c.score - c.minScore, (c.nextScore || c.score) - c.minScore || 1, '收藏家等级进度'),
      h('small', { class: 'pn-hint' }, `特权：${c.perks}`)));
  }
  const s = p.stats || {};
  const order = (p.statsLayout && p.statsLayout.order) || ['pokemon', 'battle', 'social', 'exploration'];
  const hidden = new Set((p.statsLayout && p.statsLayout.hidden) || []);
  const sections = {
    pokemon: s.pokemon && ['精灵', [['已捕捉', s.pokemon.totalCaught], ['种类', s.pokemon.uniqueSpecies], ['闪光', s.pokemon.shinyCount],
      ['完美个体', s.pokemon.perfectIV], ['最高 CP', s.pokemon.highestCP], ['最爱', s.pokemon.favoriteSpecies && s.pokemon.favoriteSpecies.name]]],
    battle: s.battle && ['战斗', [['道馆战', s.battle.gymBattles], ['道馆胜', s.battle.gymWins], ['团战', s.battle.raidParticipated],
      ['团战胜', s.battle.raidWins], ['守护道馆', s.battle.currentGymDefenders], ['对战胜', s.battle.pvpWins]]],
    social: s.social && ['社交', [['好友', s.social.friendsCount], ['送礼', s.social.giftsSent], ['收礼', s.social.giftsReceived], ['交易', s.social.tradesCompleted]]],
    exploration: s.exploration && ['探索', [['补给站', s.exploration.pokeStopsVisited], ['行走 km', s.exploration.kmWalked],
      ['探索区域', s.exploration.regionsExplored], ['稀有邂逅', s.exploration.rareEncounters]]],
  };
  for (const key of order) {
    const sec = sections[key];
    if (!sec || hidden.has(key)) continue;
    frag.append(h('section', { class: 'pn-card', 'aria-label': sec[0] }, h('h3', {}, sec[0]),
      h('div', { class: 'pn-stats' }, ...sec[1].filter(([, v]) => v !== undefined).map(([l, v]) => statCell(l, v)))));
  }
  if (p.pokedex) {
    frag.append(h('section', { class: 'pn-card', 'aria-label': '图鉴' }, h('h3', {}, `图鉴 ${p.pokedex.caught}/${p.pokedex.total}`),
      progressBar(p.pokedex.caught, p.pokedex.total, '图鉴完成度'), h('small', {}, `已见 ${p.pokedex.seen} · 完成度 ${Math.round(p.pokedex.completionRate * 100)}%`)));
  }
  if (p.achievements) {
    frag.append(h('section', { class: 'pn-card', 'aria-label': '成就' }, h('h3', {}, `成就 ${p.achievements.unlocked}/${p.achievements.total} · ${p.achievements.points} 点`),
      h('div', { class: 'pn-badges' }, ...(p.badges || []).map((b) => h('span', { class: `pn-badge-item r-${b.rarity}`, title: b.name }, `${b.icon} ${b.name}`))),
      h('ul', { class: 'pn-recent' }, ...(p.achievements.recent || []).map((a) => h('li', {}, `🏆 ${a.name}`)))));
  }
  if (p.featuredPokemon && p.featuredPokemon.length) {
    frag.append(h('section', { class: 'pn-card', 'aria-label': '精选精灵' }, h('h3', {}, '精选精灵'),
      h('div', { class: 'pn-stats' }, ...p.featuredPokemon.map((m) => h('button', { type: 'button', class: 'pn-stat', onclick: () => onPokemon && onPokemon(m) },
        h('div', { class: 'pn-stat-v' }, `${m.isShiny ? '✨' : ''}${m.name}`), h('div', { class: 'pn-stat-l' }, `CP ${m.cp} · IV ${m.ivPercent}%`))))));
  }
  if (p.room) frag.append(h('p', { class: 'pn-card' }, `🏛️ 收藏室 Lv.${p.room.level} · ${p.room.pokemonCount} 只精灵 · ❤ ${p.room.likeCount} · 👣 ${p.room.visitorCount}`));
  if (p.views) frag.append(h('p', { class: 'pn-hint' }, `资料被查看 ${p.views.total} 次（近 7 天 ${p.views.uniqueVisitors7d} 人，分享打开 ${p.views.viaShare} 次）`));
  return frag;
}

export async function openMyProfile({ api, toast }) {
  const sheet = openSheet('我的资料卡', { id: 'my-profile' });
  const content = h('div');
  sheet.body.append(h('div', { class: 'pn-row pn-toolbar' },
    h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': 'profile-edit', onclick: () => openEditor({ api, toast }, reload) }, '✏️ 编辑'),
    h('button', { type: 'button', class: 'pn-btn', 'data-testid': 'profile-share', onclick: () => openShare({ api, toast }) }, '📤 分享'),
    h('button', { type: 'button', class: 'pn-btn', onclick: () => openCollectors({ api }) }, '🏆 收藏家榜'),
    h('button', { type: 'button', class: 'pn-btn', onclick: () => openOther({ api, toast }) }, '🔍 查看玩家')), content);
  async function reload() {
    try { content.replaceChildren(renderProfile(await http(api, 'GET', '/users/me/profile'))); } catch (e) { content.replaceChildren(emptyState(e.message)); }
  }
  reload();
  return sheet;
}

export async function openPlayerProfile({ api }, userId) {
  const sheet = openSheet('玩家资料', { id: 'player-profile' });
  try {
    const p = await http(api, 'GET', `/users/${encodeURIComponent(userId)}/profile`);
    sheet.body.append(renderProfile(p));
    if (!p.restricted) sheet.body.append(h('img', { class: 'pn-card-img', alt: `${p.player.nickname} 的资料卡`, src: '' }));
    const img = sheet.body.querySelector('.pn-card-img');
    if (img) {
      const svg = await http(api, 'GET', `/users/${encodeURIComponent(userId)}/profile/card?format=json`).then((r) => r.svg).catch(() => null);
      if (svg) img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; else img.remove();
    }
  } catch (e) { sheet.body.append(emptyState(e.message)); }
  return sheet;
}

function openOther(ctx) {
  const sheet = openSheet('查看玩家资料', { id: 'find-player' });
  const input = h('input', { type: 'text', placeholder: '玩家 ID', 'aria-label': '玩家 ID', class: 'pn-input' });
  sheet.body.append(h('div', { class: 'pn-row' }, input, h('button', { type: 'button', class: 'pn-btn primary', onclick: () => {
    const id = input.value.trim();
    if (id) { sheet.close(); openPlayerProfile(ctx, id); }
  } }, '查看')), h('p', { class: 'pn-hint' }, '也可以在好友列表、排行榜中点击玩家打开资料。'));
}

async function openEditor({ api, toast }, onSaved) {
  const sheet = openSheet('编辑资料卡', { id: 'profile-editor' });
  let me; let custom; let badges; let mons;
  try {
    [me, custom, badges, mons] = await Promise.all([
      http(api, 'GET', '/users/me/profile'), http(api, 'GET', '/users/me/profile/customization'),
      http(api, 'GET', '/users/me/profile/badges/available'), http(api, 'GET', '/pokemon/my?limit=50').catch(() => [])]);
  } catch (e) { sheet.body.append(emptyState(e.message)); return; }
  const cfg = me.config;
  const pick = (items, selectedId, name) => h('div', { class: 'pn-choices', role: 'radiogroup', 'aria-label': name }, ...items.map((it) => {
    const input = h('input', { type: 'radio', name, value: it.id, disabled: !it.unlocked });
    input.checked = it.id === selectedId;
    const cond = it.unlockCondition || {};
    const lock = it.unlocked ? '' : ` 🔒${cond.minLevel ? ` Lv.${cond.minLevel}` : ''}${cond.collectorLevel ? ` 收藏家${cond.collectorLevel}级` : ''}${cond.achievementId ? ' 成就' : ''}`;
    return h('label', { class: `pn-choice${it.unlocked ? '' : ' locked'}`, style: { borderColor: (it.style && (it.style.border || it.style.from)) || '' } }, input, ` ${it.name}${lock}`);
  }));
  const frames = pick(custom.frames, cfg.avatarFrameId, 'frame');
  const themes = pick(custom.themes, cfg.backgroundThemeId, 'theme');
  const signature = h('input', { type: 'text', maxlength: '100', class: 'pn-input', 'aria-label': '签名', value: me.signature || '', 'data-testid': 'profile-signature' });
  const vis = h('select', { 'aria-label': '可见性', 'data-testid': 'profile-visibility' }, ...Object.entries(VIS_LABEL).map(([v, l]) => {
    const o = h('option', { value: v }, l); o.selected = cfg.visibility === v; return o;
  }));
  const selected = new Set(cfg.selectedBadges);
  const badgeCount = h('small', {});
  const badgeBoxes = badges.map((b) => {
    const cb = h('input', { type: 'checkbox', value: b.id });
    cb.checked = selected.has(b.id);
    cb.addEventListener('change', () => {
      const n = badgeBoxes.filter((x) => x.firstChild.checked).length;
      if (n > custom.maxBadges) { cb.checked = false; if (toast) toast(`最多展示 ${custom.maxBadges} 个徽章`, 'err'); }
      badgeCount.textContent = `${badgeBoxes.filter((x) => x.firstChild.checked).length}/${custom.maxBadges}`;
    });
    return h('label', { class: 'pn-choice' }, cb, ` ${b.name}`);
  });
  badgeCount.textContent = `${selected.size}/${custom.maxBadges}`;
  const monList = Array.isArray(mons) ? mons : (mons.pokemon || mons.items || []);
  const selMons = new Set(cfg.selectedPokemon);
  const monBoxes = monList.slice(0, 50).map((m) => {
    const cb = h('input', { type: 'checkbox', value: m.id });
    cb.checked = selMons.has(m.id);
    cb.addEventListener('change', () => {
      if (monBoxes.filter((x) => x.firstChild.checked).length > custom.featuredLimit) { cb.checked = false; if (toast) toast(`最多 ${custom.featuredLimit} 只精选精灵`, 'err'); }
    });
    return h('label', { class: 'pn-choice' }, cb, ` ${m.nickname || m.name_zh || m.name || m.species_id} CP${m.cp}`);
  });
  const save = h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': 'profile-save', onclick: async () => {
    const val = (group) => { const c = group.querySelector('input:checked'); return c ? c.value : undefined; };
    const body = {
      avatarFrameId: val(frames), backgroundThemeId: val(themes), signature: signature.value, visibility: vis.value,
      selectedBadges: badgeBoxes.filter((x) => x.firstChild.checked).map((x) => x.firstChild.value),
      selectedPokemon: monBoxes.filter((x) => x.firstChild.checked).map((x) => x.firstChild.value),
    };
    try { await http(api, 'PUT', '/users/me/profile', body); if (toast) toast('资料卡已保存', 'ok'); sheet.close(); if (onSaved) onSaved(); }
    catch (e) { if (toast) toast(e.message, 'err'); }
  } }, '保存');
  sheet.body.append(
    h('fieldset', { class: 'pn-card' }, h('legend', {}, '头像框'), frames),
    h('fieldset', { class: 'pn-card' }, h('legend', {}, '背景主题'), themes),
    h('fieldset', { class: 'pn-card' }, h('legend', {}, '签名与可见性'), signature, vis,
      h('p', { class: 'pn-hint' }, '公开：所有人可见（社交与行走数据仅好友可见）；仅好友：陌生人只看到昵称和等级；私密：只有自己可见。')),
    h('fieldset', { class: 'pn-card' }, h('legend', {}, '展示徽章 '), badgeCount, h('div', { class: 'pn-choices' }, ...(badgeBoxes.length ? badgeBoxes : [emptyState('完成成就后可展示徽章')]))),
    h('fieldset', { class: 'pn-card' }, h('legend', {}, `精选精灵（最多 ${custom.featuredLimit} 只）`), h('div', { class: 'pn-choices' }, ...(monBoxes.length ? monBoxes : [emptyState('背包里还没有精灵')]))),
    save);
}

async function svgToPngDataUrl(svg) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: 1200, height: 680 });
  canvas.getContext('2d').drawImage(img, 0, 0, 1200, 680);
  return canvas.toDataURL('image/png');
}

async function openShare({ api, toast }) {
  const sheet = openSheet('分享资料卡', { id: 'profile-share' });
  try {
    const [s, me] = await Promise.all([http(api, 'POST', '/users/me/profile/share'), http(api, 'GET', '/users/me/profile')]);
    const { svg } = await http(api, 'GET', `/users/${me.player.id}/profile/card?format=json`);
    const img = h('img', { class: 'pn-card-img', alt: '我的资料卡', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
    const link = h('input', { type: 'text', readonly: true, class: 'pn-input', value: s.shareUrl, 'aria-label': '分享链接', 'data-testid': 'share-url' });
    sheet.body.append(img,
      h('div', { class: 'pn-row' }, link, h('button', { type: 'button', class: 'pn-btn', onclick: async () => {
        try { await navigator.clipboard.writeText(link.value); if (toast) toast('链接已复制', 'ok'); } catch { link.select(); }
      } }, '复制')),
      s.qrCode ? h('img', { class: 'pn-qr', alt: '分享二维码', src: s.qrCode, 'data-testid': 'share-qr' }) : null,
      h('div', { class: 'pn-row' },
        h('button', { type: 'button', class: 'pn-btn primary', onclick: async () => {
          try {
            const a = h('a', { href: await svgToPngDataUrl(svg), download: 'mineGo-profile.png' });
            document.body.append(a); a.click(); a.remove();
          } catch { if (toast) toast('生成图片失败', 'err'); }
        } }, '保存为图片'),
        navigator.share ? h('button', { type: 'button', class: 'pn-btn', onclick: () => navigator.share({ title: 'mineGo 资料卡', url: s.shareUrl }).catch(() => {}) }, '系统分享') : null),
      s.publicCardAvailable ? null : h('p', { class: 'pn-hint' }, '当前资料不是公开状态，其他人打开链接会看到"未公开"。'));
  } catch (e) { sheet.body.append(emptyState(e.message)); }
}

export async function openCollectors({ api }) {
  const sheet = openSheet('收藏家排行榜', { id: 'collector-leaderboard' });
  try {
    const r = await http(api, 'GET', '/users/leaderboard/collectors?limit=50');
    if (r.me) sheet.body.append(h('p', { class: 'pn-card' }, `我的排名：第 ${r.me.rank} 名 · ${r.me.score} 分 · ${r.me.collector.name}`));
    sheet.body.append(h('ol', { class: 'pn-rank' }, ...r.leaderboard.map((x) => h('li', {},
      h('button', { type: 'button', class: 'pn-link', onclick: () => openPlayerProfile({ api }, x.userId) }, `#${x.rank} ${x.nickname}`),
      x.activeTitle ? h('span', { class: 'pn-title-tag' }, x.activeTitle.name) : null, ` ${x.collector.name} · ${x.score} 分`))));
  } catch (e) { sheet.body.append(emptyState(e.message)); }
}
