// frontend/game-client/src/features/profile-notify/collectionRoom.js
// REQ-00359 / REQ-00403 精灵收藏室：编辑器（网格 + 拖拽摆放精灵/装饰、旋转、缩放、主题/背景）与访问界面（点赞、留言、访问时长）
//
// 拖拽：Pointer Events（鼠标/触屏通用）。从右侧库存拖到格子 = 摆放；拖动已摆放物 = 移动（放下即 PUT 保存）；
// 键盘：选中物体后方向键移动、R 旋转、Delete 收回、+/- 缩放。服务端做最终校验（占格/越界/容量），失败时回滚显示。
import { http, h, openSheet, emptyState, progressBar } from './core.js';

const CELL = 44;
const MODE_LABEL = { idle: '待机', walk: '走动', pose: '摆姿势', battle: '战斗', shiny: '闪光', card: '卡片', '3d': '3D' };
const PEDESTALS = ['basic', 'bronze', 'silver', 'gold', 'diamond'];
const RARITY_LABEL = { common: '普通', uncommon: '少见', rare: '稀有', epic: '史诗', legendary: '传说' };

function footprint(d) {
  const r = Number(d.rotation) || 0;
  return r === 90 || r === 270 ? { w: d.height || 1, h: d.width || 1 } : { w: d.width || 1, h: d.height || 1 };
}

/** 渲染房间网格（编辑与访问共用） */
function roomGrid(data, { editable, onSelect, onDrop, selectedKey } = {}) {
  const g = data.room.layout.gridSize;
  const pal = data.room.theme.palette || {};
  const grid = h('div', { class: 'pn-room-grid', role: editable ? 'application' : 'img',
    'aria-label': `${data.room.roomName}，${data.pokemon.length} 只精灵，${data.decorations.length} 件装饰`,
    style: { width: `${g.width * CELL}px`, height: `${g.height * CELL}px`,
      background: data.room.background.imageUrl ? `url("${encodeURI(data.room.background.imageUrl)}") center/cover` : (data.room.background.cssGradient || pal.wall || '#FAF7F2'),
      '--floor': pal.floor || '#E8E1D5', '--accent': pal.accent || '#5C6BC0' } });
  const place = (node, x, y, w, hgt) => Object.assign(node.style, { left: `${x * CELL}px`, top: `${y * CELL}px`, width: `${w * CELL}px`, height: `${hgt * CELL}px` });
  for (const d of [...data.decorations].sort((a, b) => (a.category === 'floor' ? -1 : 0) - (b.category === 'floor' ? -1 : 0) || a.zIndex - b.zIndex)) {
    const fp = footprint(d);
    const key = `d:${d.id}`;
    const node = h('div', { class: `pn-room-item deco c-${d.category} r-${d.rarity}${d.interactionType === 'animate' ? ' anim' : ''}${d.interactionType === 'rotate' ? ' spin' : ''}${selectedKey === key ? ' sel' : ''}`,
      tabindex: editable ? '0' : '-1', 'data-key': key, title: d.name, 'aria-label': `${d.name}（${d.x},${d.y}）`,
      style: { transform: `scale(${d.scale || 1})`, zIndex: String(d.category === 'floor' ? 2 : 10 + (d.zIndex || 0)) } }, d.icon || '🪑');
    place(node, d.x, d.y, fp.w, fp.h);
    grid.append(node);
  }
  for (const m of data.pokemon) {
    const key = `p:${m.pokemonId}`;
    const node = h('div', { class: `pn-room-item mon mode-${m.displayMode} ped-${m.pedestalType}${m.isShiny ? ' shiny' : ''}${selectedKey === key ? ' sel' : ''}`,
      tabindex: editable ? '0' : '-1', 'data-key': key, title: `${m.name} CP${m.cp}`, 'aria-label': `${m.name}，CP ${m.cp}${m.isShiny ? '，闪光' : ''}（${m.x},${m.y}）`,
      style: { transform: `scale(${m.scale || 1}) rotate(${m.rotation || 0}deg)`, zIndex: String(20 + (m.z || 0)), animationDuration: `${2 / (m.animationSpeed || 1)}s` } },
    m.spriteUrl ? h('img', { src: m.spriteUrl, alt: '', draggable: 'false' }) : h('span', {}, m.isShiny ? '✨' : '🐾'),
    h('small', {}, m.label || m.name));
    place(node, m.x, m.y, 1, 1);
    grid.append(node);
  }
  if (editable) attachDrag(grid, { onSelect, onDrop });
  return grid;
}

function cellFromEvent(grid, e) {
  const r = grid.getBoundingClientRect();
  return { x: Math.floor((e.clientX - r.left) / CELL), y: Math.floor((e.clientY - r.top) / CELL) };
}

function attachDrag(grid, { onSelect, onDrop }) {
  let drag = null;
  grid.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.pn-room-item');
    if (!item) return;
    onSelect(item.dataset.key);
    const start = cellFromEvent(grid, e);
    drag = { key: item.dataset.key, node: item, start, ox: parseInt(item.style.left, 10), oy: parseInt(item.style.top, 10), sx: e.clientX, sy: e.clientY };
    item.setPointerCapture(e.pointerId);
    item.classList.add('dragging');
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.node.style.left = `${drag.ox + e.clientX - drag.sx}px`;
    drag.node.style.top = `${drag.oy + e.clientY - drag.sy}px`;
  });
  grid.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    d.node.classList.remove('dragging');
    const end = cellFromEvent(grid, e);
    const dx = end.x - d.start.x; const dy = end.y - d.start.y;
    if (dx || dy) onDrop(d.key, { dx, dy });
    else { d.node.style.left = `${d.ox}px`; d.node.style.top = `${d.oy}px`; }
  });
  // 从库存拖入（HTML5 DnD）
  grid.addEventListener('dragover', (e) => e.preventDefault());
  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData('text/plain');
    if (payload) onDrop(payload, { cell: cellFromEvent(grid, e) });
  });
}

export async function openMyRoom({ api, toast }) {
  const sheet = openSheet('我的收藏室', { id: 'collection-room-editor' });
  const state = { data: null, selected: null, inventory: [], mons: [], tab: 'pokemon' };
  const info = h('div', { class: 'pn-card', 'data-testid': 'room-info' });
  const stage = h('div', { class: 'pn-room-stage' });
  const inspector = h('div', { class: 'pn-card', 'aria-live': 'polite' });
  const side = h('div', { class: 'pn-room-side' });
  sheet.body.append(info, h('div', { class: 'pn-room-layout' }, stage, side), inspector,
    h('p', { class: 'pn-hint' }, '拖动精灵或装饰调整位置；从右侧拖入摆放。选中后：方向键移动、R 旋转、+/- 缩放、Delete 收回。'));

  const act = async (fn, ok) => {
    try { const r = await fn(); if (ok && toast) toast(ok, 'ok'); await reload(); return r; }
    catch (e) { if (toast) toast(e.message, 'err'); await reload(); return null; }
  };

  function find(key) {
    const [t, id] = key.split(':');
    return t === 'd' ? state.data.decorations.find((d) => d.id === id) : state.data.pokemon.find((m) => m.pokemonId === id);
  }

  async function moveTo(key, pos) {
    const [t, id] = key.split(':');
    const path = t === 'd' ? `/collection-room/decorations/${id}` : `/collection-room/pokemon/${id}`;
    await act(() => http(api, 'PUT', path, pos));
  }

  async function onDrop(key, { dx, dy, cell }) {
    if (key.startsWith('inv:')) { // 从库存拖入
      const [, kind, id] = key.split(':');
      if (kind === 'mon') await act(() => http(api, 'POST', '/collection-room/pokemon', { pokemonId: id, x: cell.x, y: cell.y }), '已展示');
      else await act(() => http(api, 'POST', '/collection-room/decorations', { itemCode: id, x: cell.x, y: cell.y }), '已摆放');
      return;
    }
    const it = find(key);
    if (it) await moveTo(key, { x: it.x + dx, y: it.y + dy });
  }

  function renderInspector() {
    const key = state.selected;
    const it = key && find(key);
    if (!it) { inspector.replaceChildren(h('small', {}, '点击精灵或装饰进行编辑')); return; }
    const isMon = key.startsWith('p:');
    const controls = [
      h('strong', {}, isMon ? `${it.name} CP${it.cp}` : it.name),
      h('button', { type: 'button', class: 'pn-btn', onclick: () => moveTo(key, { rotation: ((it.rotation || 0) + 90) % 360 }) }, '↻ 旋转'),
      h('button', { type: 'button', class: 'pn-btn', onclick: () => moveTo(key, { scale: Math.min(2, (it.scale || 1) + 0.25) }) }, '＋'),
      h('button', { type: 'button', class: 'pn-btn', onclick: () => moveTo(key, { scale: Math.max(0.5, (it.scale || 1) - 0.25) }) }, '－'),
      h('button', { type: 'button', class: 'pn-btn', 'data-testid': 'room-remove', onclick: () => act(() => http(api, 'DELETE',
        isMon ? `/collection-room/pokemon/${it.pokemonId}` : `/collection-room/decorations/${it.id}`), '已收回') }, '收回'),
    ];
    if (isMon) {
      const mode = h('select', { 'aria-label': '展示模式', onchange: () => moveTo(key, { displayMode: mode.value }) },
        ...Object.entries(MODE_LABEL).map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = it.displayMode === v; return o; }));
      const ped = h('select', { 'aria-label': '展示台', onchange: () => moveTo(key, { pedestalType: ped.value }) },
        ...PEDESTALS.map((v) => { const o = h('option', { value: v }, v); o.selected = it.pedestalType === v; return o; }));
      const label = h('input', { type: 'text', maxlength: '30', class: 'pn-input', value: it.label || '', 'aria-label': '标签',
        onchange: () => moveTo(key, { label: label.value }) });
      controls.push(mode, ped, label);
    }
    inspector.replaceChildren(h('div', { class: 'pn-row' }, ...controls));
  }

  function renderSide() {
    const tabs = h('div', { class: 'pn-tabs', role: 'tablist' },
      ...[['pokemon', '精灵'], ['deco', '装饰'], ['shop', '商店'], ['theme', '主题']].map(([k, l]) => h('button', { type: 'button', role: 'tab',
        class: `pn-tab${state.tab === k ? ' on' : ''}`, 'aria-selected': String(state.tab === k), onclick: () => { state.tab = k; renderSide(); } }, l)));
    const body = h('div', { class: 'pn-room-inv' });
    const displayed = new Set(state.data.pokemon.map((m) => m.pokemonId));
    if (state.tab === 'pokemon') {
      body.append(...state.mons.filter((m) => !displayed.has(m.id)).map((m) => h('div', { class: 'pn-inv-item', draggable: 'true', tabindex: '0',
        ondragstart: (e) => e.dataTransfer.setData('text/plain', `inv:mon:${m.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') act(() => http(api, 'POST', '/collection-room/pokemon', { pokemonId: m.id }), '已展示'); },
        ondblclick: () => act(() => http(api, 'POST', '/collection-room/pokemon', { pokemonId: m.id }), '已展示') },
      `${m.is_shiny ? '✨' : ''}${m.nickname || m.name_zh || m.species_id} CP${m.cp}`)));
    } else if (state.tab === 'deco') {
      body.append(...(state.inventory.length ? state.inventory.map((d) => h('div', { class: `pn-inv-item r-${d.rarity}`, draggable: d.available > 0 ? 'true' : 'false', tabindex: '0',
        ondragstart: (e) => e.dataTransfer.setData('text/plain', `inv:deco:${d.itemCode}`),
        ondblclick: () => d.available > 0 && act(() => http(api, 'POST', '/collection-room/decorations', { itemCode: d.itemCode, x: 0, y: 0 }), '已摆放') },
      `${d.icon || '🪑'} ${d.name} ×${d.available}`)) : [emptyState('还没有装饰，去商店看看')]));
    } else if (state.tab === 'shop') {
      body.append(h('p', { class: 'pn-hint' }, '加载中…'));
      http(api, 'GET', '/collection-room/decorations/catalog').then((items) => {
        body.replaceChildren(...items.filter((i) => i.priceCoins).map((i) => h('div', { class: `pn-inv-item r-${i.rarity}` },
          `${i.icon || ''} ${i.name}（${RARITY_LABEL[i.rarity]}）${i.width}×${i.height} · 💎${i.priceCoins}`,
          h('button', { type: 'button', class: 'pn-btn', onclick: () => act(() => http(api, 'POST', `/collection-room/decorations/${i.itemCode}/purchase`, { quantity: 1 }), `已购买 ${i.name}`) }, '购买'))));
      }).catch((e) => body.replaceChildren(emptyState(e.message)));
    } else {
      body.append(h('p', { class: 'pn-hint' }, '加载中…'));
      Promise.all([http(api, 'GET', '/collection-room/themes'), http(api, 'GET', '/collection-room/backgrounds')]).then(([themes, bgs]) => {
        const row = (kind, t) => h('div', { class: `pn-inv-item${t.unlocked ? '' : ' locked'}` },
          `${t.name}${t.unlocked ? '' : t.isPremium ? ` 💎${t.priceCoins}` : ` 🔒Lv.${(t.unlockCondition || {}).roomLevel || '?'}`}`,
          t.unlocked ? h('button', { type: 'button', class: 'pn-btn', onclick: () => act(() => http(api, 'PUT', '/collection-room', kind === 'theme' ? { themeId: t.id } : { backgroundId: t.id }), '已更换') }, '使用')
            : t.isPremium ? h('button', { type: 'button', class: 'pn-btn', onclick: () => act(() => http(api, 'POST', `/collection-room/${kind === 'theme' ? 'themes' : 'backgrounds'}/${t.id}/purchase`), '已购买') }, '购买') : null);
        const name = h('input', { type: 'text', class: 'pn-input', maxlength: '40', value: state.data.room.roomName, 'aria-label': '收藏室名称' });
        const pub = h('input', { type: 'checkbox', id: 'room-public' }); pub.checked = state.data.room.isPublic;
        body.replaceChildren(h('h4', {}, '主题'), ...themes.map((t) => row('theme', t)), h('h4', {}, '背景'), ...bgs.map((t) => row('background', t)),
          h('h4', {}, '设置'), name, h('label', { for: 'room-public' }, pub, ' 公开给其他玩家'),
          h('button', { type: 'button', class: 'pn-btn primary', onclick: () => act(() => http(api, 'PUT', '/collection-room', { roomName: name.value, isPublic: pub.checked }), '已保存') }, '保存设置'));
      }).catch((e) => body.replaceChildren(emptyState(e.message)));
    }
    side.replaceChildren(tabs, body);
  }

  function render() {
    const d = state.data;
    info.replaceChildren(h('div', { class: 'pn-row' }, h('strong', {}, d.room.roomName), h('span', {}, `Lv.${d.room.level}`),
      h('span', {}, `精灵 ${d.pokemon.length}/${d.room.capacity.pokemon}`), h('span', {}, `装饰 ${d.decorations.length}/${d.room.capacity.decorations}`),
      h('span', {}, `❤ ${d.room.likeCount} · 👣 ${d.room.visitorCount} · 💬 ${d.room.commentCount}`)),
    progressBar(d.room.levelProgress * 100, 100, '收藏室等级进度'),
    h('small', {}, d.room.nextLevelExp ? `经验 ${d.room.experience}/${d.room.nextLevelExp}` : '已满级'));
    const grid = roomGrid(d, { editable: true, selectedKey: state.selected,
      onSelect: (k) => { state.selected = k; renderInspector(); grid.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel')); const n = grid.querySelector(`[data-key="${k}"]`); if (n) n.classList.add('sel'); },
      onDrop });
    grid.addEventListener('keydown', (e) => {
      const k = state.selected; const it = k && find(k);
      if (!it) return;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[e.key]) { e.preventDefault(); moveTo(k, { x: it.x + moves[e.key][0], y: it.y + moves[e.key][1] }); }
      else if (e.key === 'r' || e.key === 'R') moveTo(k, { rotation: ((it.rotation || 0) + 90) % 360 });
      else if (e.key === '+' || e.key === '=') moveTo(k, { scale: Math.min(2, (it.scale || 1) + 0.25) });
      else if (e.key === '-') moveTo(k, { scale: Math.max(0.5, (it.scale || 1) - 0.25) });
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        act(() => http(api, 'DELETE', k.startsWith('p:') ? `/collection-room/pokemon/${it.pokemonId}` : `/collection-room/decorations/${it.id}`), '已收回');
      }
    });
    stage.replaceChildren(grid);
    renderInspector();
    renderSide();
    if (state.selected) { const n = grid.querySelector(`[data-key="${state.selected}"]`); if (n) n.focus(); }
  }

  async function reload() {
    try {
      const [data, inv, mons] = await Promise.all([http(api, 'GET', '/collection-room'), http(api, 'GET', '/collection-room/decorations/inventory'),
        http(api, 'GET', '/pokemon/my?limit=100').catch(() => ({ pokemon: [] }))]);
      Object.assign(state, { data, inventory: inv, mons: Array.isArray(mons) ? mons : (mons.pokemon || []) });
      if (state.selected && !find(state.selected)) state.selected = null;
      render();
    } catch (e) { stage.replaceChildren(emptyState(e.message)); }
  }
  reload();
  return sheet;
}

/** 访问他人收藏室（按玩家 ID 或房间 ID） */
export async function openVisit({ api, toast }, { userId, roomId }) {
  const sheet = openSheet('参观收藏室', { id: 'collection-room-visit', onClose: () => endVisit() });
  const t0 = Date.now();
  let data;
  async function endVisit() {
    if (!data || data.isOwner) return;
    http(api, 'POST', `/collection-room/${data.room.id}/visit/end`, { durationSeconds: Math.round((Date.now() - t0) / 1000) }).catch(() => {});
  }
  try {
    data = await http(api, 'GET', userId ? `/collection-room/users/${encodeURIComponent(userId)}` : `/collection-room/${encodeURIComponent(roomId)}/visit`);
  } catch (e) { sheet.body.append(emptyState(e.message)); return sheet; }
  const likeBtn = h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': 'room-like', 'aria-pressed': String(!!data.likedByMe) });
  const likeCount = h('span', {});
  const renderLike = () => { likeBtn.textContent = data.likedByMe ? '❤ 已赞' : '🤍 点赞'; likeCount.textContent = `❤ ${data.room.likeCount}`; };
  likeBtn.addEventListener('click', async () => {
    try {
      const r = await http(api, data.likedByMe ? 'DELETE' : 'POST', `/collection-room/${data.room.id}/like`);
      data.likedByMe = r.liked; data.room.likeCount = r.likeCount; renderLike();
    } catch (e) { if (toast) toast(e.message, 'err'); }
  });
  renderLike();
  const comments = h('ul', { class: 'pn-comments', 'aria-label': '留言' });
  const renderComments = (list) => comments.replaceChildren(...(list.length ? list.map((c) => h('li', {}, h('strong', {}, c.nickname), `：${c.content}`,
    h('small', {}, ` ${new Date(c.createdAt).toLocaleString()}`))) : [emptyState('还没有留言')]));
  renderComments(data.comments || []);
  const input = h('input', { type: 'text', maxlength: '200', class: 'pn-input', placeholder: '留下你的评价…', 'aria-label': '留言内容', 'data-testid': 'room-comment-input' });
  const send = h('button', { type: 'button', class: 'pn-btn', 'data-testid': 'room-comment-send', onclick: async () => {
    if (!input.value.trim()) return;
    try {
      await http(api, 'POST', `/collection-room/${data.room.id}/comments`, { content: input.value });
      input.value = '';
      renderComments((await http(api, 'GET', `/collection-room/${data.room.id}/comments`)).comments);
    } catch (e) { if (toast) toast(e.message, 'err'); }
  } }, '发送');
  sheet.setTitle(`${data.room.ownerNickname} 的收藏室`);
  sheet.body.append(
    h('div', { class: 'pn-card pn-row' }, h('strong', {}, data.room.roomName), h('span', {}, `Lv.${data.room.level} · ${data.room.theme.name}`),
      likeCount, h('span', {}, `👣 ${data.room.visitorCount}`), data.isOwner ? null : likeBtn),
    h('div', { class: 'pn-room-stage' }, roomGrid(data, { editable: false })),
    h('section', { class: 'pn-card' }, h('h3', {}, '留言'), comments, data.isOwner ? null : h('div', { class: 'pn-row' }, input, send)));
  return sheet;
}

export async function openPopularRooms(ctx) {
  const sheet = openSheet('热门收藏室', { id: 'collection-room-popular' });
  const list = h('ol', { class: 'pn-rank' });
  const sort = h('select', { 'aria-label': '排序', onchange: () => load() },
    h('option', { value: 'likes' }, '最多点赞'), h('option', { value: 'visitors' }, '最多访客'), h('option', { value: 'level' }, '最高等级'), h('option', { value: 'recent' }, '最近更新'));
  sheet.body.append(sort, list);
  async function load() {
    try {
      const rows = await http(ctx.api, 'GET', `/collection-room/popular?sort=${sort.value}`);
      list.replaceChildren(...(rows.length ? rows.map((r) => h('li', {}, h('button', { type: 'button', class: 'pn-link',
        onclick: () => openVisit(ctx, { roomId: r.roomId }) }, `#${r.rank} ${r.roomName}`), ` · ${r.ownerNickname} · Lv.${r.level} · ❤${r.likeCount} · 👣${r.visitorCount} · 🐾${r.pokemonCount}`))
        : [emptyState('还没有公开的收藏室')]));
    } catch (e) { list.replaceChildren(emptyState(e.message)); }
  }
  load();
  return sheet;
}
