#!/usr/bin/env node
/**
 * Epic E07 精灵成长 —— 经网关的集成冒烟
 *   进化：捕捉后检查/执行、家族糖果、分支/隐藏路径、道具进化、并发不超扣、旧接口委托同一实现
 *   （后续章节随各需求补充：经验/成长轨迹、体力、训练营、特训、觉醒、培育、传承、合并……）
 *
 * 用法：BASE_URL=http://127.0.0.1:18780 node scripts/smoke-growth.js [章节...]
 *   章节名：evolution …（不传则全部）；SKIP_CATCH=1 跳过真实捕捉（其余章节用数据库夹具造精灵）
 * 依赖 scripts/lib/smoke-helpers.js（读 .env 推导 REDIS_URL / DATABASE_URL）
 */
'use strict';

const { record, call, newUser, finish, getDb, sleep } = require('./lib/smoke-helpers');

// ───────────────────────── 夹具 ─────────────────────────
const db = () => getDb();

async function speciesRow(id) {
  const { rows: [s] } = await db().query('SELECT * FROM pokemon_species WHERE id = $1', [id]);
  return s;
}

/** 直接写库造一只精灵（等价于捕捉入库），CP 按刷怪公式 */
async function givePokemon(userId, speciesId, opts = {}) {
  const s = await speciesRow(speciesId);
  const [a, d, h] = opts.iv || [10, 10, 10];
  const cp = opts.cp || Math.max(10, Math.floor(((s.base_attack + a) * Math.sqrt(s.base_defense + d) * Math.sqrt(s.base_hp + h)) / 10));
  const { rows: [p] } = await db().query(
    `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp,
                                    friendship, level, experience, is_favorite, is_shiny)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, cp`,
    [userId, speciesId, cp, Math.floor(cp * 0.8) || 10, a, d, h, opts.friendship ?? 70, opts.level || 1,
      opts.experience || 0, !!opts.favorite, !!opts.shiny]);
  return p;
}

async function setCandy(userId, speciesId, amount) {
  await db().query(
    `INSERT INTO candy_inventory (user_id, species_id, amount) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, species_id) DO UPDATE SET amount = EXCLUDED.amount`, [userId, speciesId, amount]);
}
async function candy(userId, speciesId) {
  const { rows: [c] } = await db().query(
    'SELECT amount FROM candy_inventory WHERE user_id = $1 AND species_id = pokemon_family_root($2)', [userId, speciesId]);
  return c ? Number(c.amount) : 0;
}
async function giveItem(userId, itemId, qty) {
  await db().query(
    `INSERT INTO player_inventory (user_id, item_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, item_id) WHERE slot_index IS NULL DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity`,
    [userId, itemId, qty]);
}
async function itemQty(userId, itemId) {
  const { rows: [r] } = await db().query(
    'SELECT COALESCE(SUM(quantity),0)::int AS q FROM player_inventory WHERE user_id = $1 AND item_id = $2', [userId, itemId]);
  return r.q;
}
async function pokemonRow(id) {
  const { rows: [p] } = await db().query('SELECT * FROM pokemon_instances WHERE id = $1', [id]);
  return p;
}
const errName = (r) => r.body && r.body.error && (r.body.error.name || r.body.error);

// ───────────────────── 真实捕捉（经网关） ─────────────────────
const SEED_CENTERS = [
  { lat: 31.2398, lng: 121.5014 }, { lat: 31.2304, lng: 121.4737 }, { lat: 31.2397, lng: 121.4905 },
  { lat: 31.2269, lng: 121.4918 }, { lat: 31.2198, lng: 121.4631 }, { lat: 31.2350, lng: 121.4800 },
];
const jitter = () => (Math.random() - 0.5) * 0.00004;
const distM = (a, b) => {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/** 走到附近的野生精灵旁捕捉一只，返回 { pokemonInstanceId, pokemon, rewards } 或 null */
async function catchOne(user) {
  const center = SEED_CENTERS[Math.floor(Math.random() * SEED_CENTERS.length)];
  let wild = [];
  for (let i = 0; i < 10 && !wild.length; i++) {
    const nearby = await call('GET', `/v1/map/nearby?lat=${center.lat}&lng=${center.lng}&radius=1000`, { token: user.token });
    wild = (nearby.data && nearby.data.wildPokemons) || [];
    if (!wild.length) await sleep(1500);
  }
  if (!wild.length) return null;
  const RARITY = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4 };
  const first = { lat: Number(wild[0].lat), lng: Number(wild[0].lng) };
  const ordered = wild.slice()
    .sort((a, b) => distM(first, { lat: +a.lat, lng: +a.lng }) - distM(first, { lat: +b.lat, lng: +b.lng }))
    .sort((a, b) => (RARITY[a.rarity] ?? 2) - (RARITY[b.rarity] ?? 2));
  let lastPos = null;
  for (const w of ordered.slice(0, 6)) {
    const pos = { lat: Number(w.lat) + 0.0001 + jitter(), lng: Number(w.lng) + jitter() };
    if (lastPos) {
      const waitMs = Math.ceil(distM(lastPos, pos) / 10) * 1000;
      if (waitMs > 60000) continue;
      await sleep(waitMs);
    }
    const loc = await call('POST', '/v1/location', { token: user.token, body: { ...pos, accuracy: 10 } });
    if (loc.status !== 200) continue;
    lastPos = pos;
    const sess = await call('POST', '/v1/catch/session', { token: user.token, body: { spawnId: w.id, playerLat: pos.lat, playerLng: pos.lng } });
    if (sess.status !== 200) continue;
    for (let i = 0; i < 40; i++) {
      let t = await call('POST', '/v1/catch/throw', { token: user.token, body: { sessionId: sess.data.sessionId, ballType: 'POKE_BALL', throwRating: 'EXCELLENT', isCurve: true } });
      if (t.status === 429 && t.body && t.body.code === 6003) { await sleep(61000); continue; }
      if (t.status !== 200) break;
      if (t.data.result === 'CAUGHT') return t.data;
      if (t.data.result === 'FLED') break;
    }
  }
  return null;
}

// ───────────────────────── 进化 ─────────────────────────
async function testEvolution() {
  const u = await newUser('evo');

  // 1) 真实捕捉后检查/执行进化
  if (!process.env.SKIP_CATCH) {
    const caught = await catchOne(u);
    record('进化：经网关捕捉一只精灵', !!caught, caught ? `species=${caught.pokemon.speciesId} cp=${caught.pokemon.cp}` : '没有捕到');
    if (caught) {
      const id = caught.pokemonInstanceId;
      const ch = await call('GET', `/v1/pokemon/${id}/exp-history`, { token: u.token });
      const catchExp = ch.data && ch.data.items && ch.data.items.find((i) => i.sourceType === 'catch');
      record('经验：捕捉时新精灵获得起始经验（稀有度/等级差/首捕倍率）并记入经验历史',
        caught.rewards.pokemonExp > 0 && !!catchExp && catchExp.expAmount === caught.rewards.pokemonExp,
        `pokemonExp=${caught.rewards.pokemonExp} history=${catchExp && JSON.stringify({ base: catchExp.baseAmount, m: catchExp.multiplier })}`);
      const chk = await call('GET', `/v1/pokemon/${id}/evolution/check`, { token: u.token });
      record('进化：捕捉后 GET /v1/pokemon/:id/evolution/check 返回 200（原 500）', chk.status === 200 && Array.isArray(chk.data && chk.data.options),
        `status=${chk.status} options=${chk.data && chk.data.options && chk.data.options.length} eligible=${chk.data && chk.data.eligible}`);
      const opt = chk.data && chk.data.options && chk.data.options.find((o) => o.toSpeciesId && !o.requirements.item && !o.requirements.friendship);
      if (opt) {
        const need = opt.requirements.candy;
        const have = await candy(u.userId, caught.pokemon.speciesId);
        record('进化：捕捉获得的糖果计入家族（>0）', have > 0, `candy=${have} need=${need}`);
        const short = await call('POST', `/v1/pokemon/${id}/evolution/execute`, { token: u.token, body: {} });
        record('进化：糖果不足时拒绝（400 INSUFFICIENT_CANDY）', have >= need || (short.status === 400 && errName(short) === 'INSUFFICIENT_CANDY'), `status=${short.status} ${errName(short)}`);
        await setCandy(u.userId, caught.pokemon.speciesId, need + 7);
        const ex = await call('POST', `/v1/pokemon/${id}/evolution/execute`, { token: u.token, body: {} });
        const after = await pokemonRow(id);
        record('进化：执行成功，物种变为目标、CP 上升', ex.status === 200 && after.species_id === opt.toSpeciesId && after.cp > caught.pokemon.cp,
          `status=${ex.status} ${ex.status !== 200 ? JSON.stringify(ex.body).slice(0, 160) : `species=${after.species_id} cp ${caught.pokemon.cp}→${after.cp}`}`);
        record('进化：糖果恰好扣除进化所需', (await candy(u.userId, opt.toSpeciesId)) === 7, `left=${await candy(u.userId, opt.toSpeciesId)}`);
        const my = await call('GET', `/v1/pokemon/my/${id}`, { token: u.token });
        record('进化：背包详情显示进化后的物种', my.status === 200 && my.data.species_id === opt.toSpeciesId, `species=${my.data && my.data.species_id}`);
      } else {
        record('进化：捕到的物种无可直接进化路径（跳过执行）', true, `species=${caught.pokemon.speciesId}`);
      }
    }
  }

  // 2) 权限与参数
  const other = await newUser('evx');
  const bulb = await givePokemon(u.userId, 1);
  const bad = await call('GET', '/v1/pokemon/12345/evolution/check', { token: u.token });
  record('进化：非法精灵 ID 返回 400', bad.status === 400, `status=${bad.status}`);
  const notMine = await call('POST', `/v1/pokemon/${bulb.id}/evolution/execute`, { token: other.token, body: {} });
  record('进化：不能进化别人的精灵（404）', notMine.status === 404, `status=${notMine.status}`);
  const anon = await call('GET', `/v1/pokemon/${bulb.id}/evolution/check`);
  record('进化：未登录被拒绝（401）', anon.status === 401, `status=${anon.status}`);

  // 3) 并发：3 只妙蛙种子共用 60 颗糖果（每次 25）→ 只能成功 2 次，不会扣成负数
  const bulbs = [bulb, await givePokemon(u.userId, 1), await givePokemon(u.userId, 1)];
  await setCandy(u.userId, 1, 60);
  const results = await Promise.all(bulbs.map((b) => call('POST', `/v1/pokemon/${b.id}/evolution/execute`, { token: u.token, body: {} })));
  const okCount = results.filter((r) => r.status === 200).length;
  record('进化：并发进化共享糖果只成功 2 次', okCount === 2 && results.filter((r) => r.status === 400 && errName(r) === 'INSUFFICIENT_CANDY').length === 1,
    `statuses=${results.map((r) => `${r.status}${r.status !== 200 ? ':' + errName(r) : ''}`)}`);
  record('进化：并发后糖果余 10（不超扣）', (await candy(u.userId, 1)) === 10, `candy=${await candy(u.userId, 1)}`);

  // 4) 并发：同一只小火龙连点 4 次，糖果只够一次 → 只进化一次
  const charm = await givePokemon(u.userId, 4);
  await setCandy(u.userId, 4, 30);
  const same = await Promise.all([1, 2, 3, 4].map(() => call('POST', `/v1/pokemon/${charm.id}/evolution/execute`, { token: u.token, body: {} })));
  const charmRow = await pokemonRow(charm.id);
  record('进化：同一精灵并发进化只成功一次（其余因糖果不足 400）', same.filter((r) => r.status === 200).length === 1 && same.filter((r) => r.status === 400).length === 3 && charmRow.species_id === 5,
    `statuses=${same.map((r) => r.status)} species=${charmRow.species_id}`);
  record('进化：同一精灵并发后糖果余 5', (await candy(u.userId, 4)) === 5, `candy=${await candy(u.userId, 4)}`);

  // 5) 家族糖果：妙蛙草（2）用种子家族糖果进化为妙蛙花（3）；旧接口 /pokemon/my/:id/evolve 委托同一实现
  const ivy = results.find((r) => r.status === 200).data.pokemonId;
  await setCandy(u.userId, 1, 100);
  const legacy = await call('POST', `/v1/pokemon/my/${ivy}/evolve`, { token: u.token });
  record('进化：旧接口 /v1/pokemon/my/:id/evolve 走同一实现（家族糖果、二段进化）',
    legacy.status === 200 && legacy.data.newSpeciesId === 3 && legacy.data.candyCost === 100 && (await candy(u.userId, 1)) === 0,
    `status=${legacy.status} ${legacy.status !== 200 ? JSON.stringify(legacy.body).slice(0, 160) : `new=${legacy.data.newSpeciesId}`}`);
  const noMore = await call('POST', `/v1/pokemon/${ivy}/evolution/execute`, { token: u.token, body: {} });
  record('进化：最终形态不能再进化（400 NO_EVOLUTION_AVAILABLE）', noMore.status === 400 && errName(noMore) === 'NO_EVOLUTION_AVAILABLE', `status=${noMore.status} ${errName(noMore)}`);

  // 6) 伊布分支：必须指定目标；道具进化消耗道具；隐藏路径显示提示
  const eevee = await givePokemon(u.userId, 133, { friendship: 70 });
  await setCandy(u.userId, 133, 100);
  const eChk = await call('GET', `/v1/pokemon/${eevee.id}/evolution/check`, { token: u.token });
  const eOpts = (eChk.data && eChk.data.options) || [];
  const hidden = eOpts.filter((o) => o.hidden);
  record('进化：伊布有 3 条道具路径 + 2 条隐藏路径', eOpts.length === 5 && hidden.length === 2 && hidden.every((o) => o.toSpeciesId === null && o.hint && o.hint.zh),
    `options=${eOpts.map((o) => o.toSpeciesId)}`);
  const noTarget = await call('POST', `/v1/pokemon/${eevee.id}/evolution/execute`, { token: u.token, body: {} });
  record('进化：多分支未指定目标返回 400 TARGET_REQUIRED', noTarget.status === 400 && errName(noTarget) === 'TARGET_REQUIRED', `status=${noTarget.status} ${errName(noTarget)}`);
  const noStone = await call('POST', `/v1/pokemon/${eevee.id}/evolution/execute`, { token: u.token, body: { targetSpeciesId: 134 } });
  record('进化：缺少水之石返回 400 INSUFFICIENT_ITEMS', noStone.status === 400 && errName(noStone) === 'INSUFFICIENT_ITEMS', `status=${noStone.status} ${errName(noStone)}`);
  await giveItem(u.userId, 'WATER_STONE', 1);
  const water = await call('POST', `/v1/pokemon/${eevee.id}/evolution/execute`, { token: u.token, body: { targetSpeciesId: 134 } });
  record('进化：道具进化为水伊布并消耗水之石', water.status === 200 && water.data.toSpecies.id === 134 && (await itemQty(u.userId, 'WATER_STONE')) === 0 && (await candy(u.userId, 133)) === 75,
    `status=${water.status} stone=${await itemQty(u.userId, 'WATER_STONE')} candy=${await candy(u.userId, 133)}`);

  // 亲密伊布：满足当前时段的隐藏路径可见并可进化（白天→太阳伊布，夜晚→月亮伊布）
  const eevee2 = await givePokemon(u.userId, 133, { friendship: 230 });
  const chk2 = await call('GET', `/v1/pokemon/${eevee2.id}/evolution/check`, { token: u.token });
  const phase = chk2.data && chk2.data.phase;
  const expectTarget = phase === 'day' ? 196 : 197;
  const visible = (chk2.data.options || []).find((o) => o.toSpeciesId === expectTarget);
  record('进化：亲密度达标后当前时段的隐藏路径显形且可进化', !!visible && visible.met, `phase=${phase} target=${expectTarget}`);
  const fe = await call('POST', `/v1/pokemon/${eevee2.id}/evolve`, { token: u.token, body: { targetSpeciesId: expectTarget } });
  record('进化：亲密度进化接口 /v1/pokemon/:id/evolve 委托同一实现', fe.status === 200 && fe.data.toSpecies.id === expectTarget, `status=${fe.status} ${fe.status !== 200 ? JSON.stringify(fe.body).slice(0, 160) : ''}`);

  // 7) 占用中的精灵不能进化；历史可查
  const busy = await givePokemon(u.userId, 7);
  await setCandy(u.userId, 7, 50);
  await db().query("UPDATE pokemon_instances SET occupied_by = 'training_camp' WHERE id = $1", [busy.id]);
  const busyR = await call('POST', `/v1/pokemon/${busy.id}/evolution/execute`, { token: u.token, body: {} });
  record('进化：训练中的精灵不能进化（409 POKEMON_BUSY）', busyR.status === 409 && errName(busyR) === 'POKEMON_BUSY', `status=${busyR.status} ${errName(busyR)}`);
  const hist = await call('GET', '/v1/pokemon/evolution/history', { token: u.token });
  record('进化：进化历史 /v1/pokemon/evolution/history', hist.status === 200 && hist.data.total >= 5, `status=${hist.status} total=${hist.data && hist.data.total}`);
  const ms = await call('GET', `/v1/pokemon/${charm.id}/growth/milestones`, { token: u.token });
  record('成长轨迹：进化记为里程碑', ms.status === 200 && ms.data.milestones.some((m) => m.type === 'evolution' && m.key === 'species:5'), `status=${ms.status}`);
}

// ───────────────────── 经验 / 成长轨迹（REQ-00216 / REQ-00230） ─────────────────────
async function testExperience() {
  const u = await newUser('exp');
  const pika = await givePokemon(u.userId, 25);
  const g0 = await call('GET', `/v1/pokemon/${pika.id}/growth`, { token: u.token });
  record('经验：成长概要 /v1/pokemon/:id/growth', g0.status === 200 && g0.data.level === 1 && g0.data.experience === 0 && g0.data.levelCap === 12,
    `status=${g0.status} level=${g0.data && g0.data.level} cap=${g0.data && g0.data.levelCap}`);

  const noItem = await call('POST', `/v1/pokemon/${pika.id}/experience/use-item`, { token: u.token, body: { itemId: 'EXP_CANDY_S', quantity: 1 } });
  record('经验：没有经验糖果时 400', noItem.status === 400 && errName(noItem) === 'INSUFFICIENT_ITEMS', `status=${noItem.status} ${errName(noItem)}`);
  await giveItem(u.userId, 'EXP_CANDY_S', 3);
  const use = await call('POST', `/v1/pokemon/${pika.id}/experience/use-item`, { token: u.token, body: { itemId: 'EXP_CANDY_S', quantity: 2 } });
  const expectedCp = Math.round(pika.cp * (1 + 0.02 * 11));
  record('经验：使用经验糖果S×2 → +2000 经验、升到 12 级、CP 按等级倍率提升',
    use.status === 200 && use.data.gainedExp === 2000 && use.data.newLevel === 12 && use.data.cpAfter === expectedCp && (await itemQty(u.userId, 'EXP_CANDY_S')) === 1,
    `status=${use.status} gained=${use.data && use.data.gainedExp} level=${use.data && use.data.newLevel} cp=${pika.cp}→${use.data && use.data.cpAfter}`);
  await giveItem(u.userId, 'EXP_CANDY_L', 1);
  const capped = await call('POST', `/v1/pokemon/${pika.id}/experience/use-item`, { token: u.token, body: { itemId: 'EXP_CANDY_L' } });
  record('经验：训练师 1 级时精灵等级上限 12（经验照常累积）', capped.status === 200 && capped.data.newLevel === 12 && capped.data.levelCapped === true && capped.data.newExperience === 22000,
    `status=${capped.status} level=${capped.data && capped.data.newLevel} exp=${capped.data && capped.data.newExperience}`);

  // 加成：幸运蛋 + VIP + 双倍经验活动 叠加
  await giveItem(u.userId, 'LUCKY_EGG', 1);
  const egg = await call('POST', '/v1/pokemon/experience/boosts', { token: u.token, body: { itemId: 'LUCKY_EGG' } });
  record('经验：使用幸运蛋激活 30 分钟 ×2', egg.status === 200 && egg.data.multiplier === 2 && (await itemQty(u.userId, 'LUCKY_EGG')) === 0, `status=${egg.status}`);
  await db().query('UPDATE users SET vip_level = 1 WHERE id = $1', [u.userId]);
  const boosts = await call('GET', '/v1/pokemon/experience/boosts', { token: u.token });
  record('经验：加成查询（幸运蛋 ×2 × VIP ×1.25 叠加）', boosts.status === 200 && boosts.data.boosts.length === 1 && boosts.data.multiplier >= 2.5,
    `status=${boosts.status} multiplier=${boosts.data && boosts.data.multiplier} breakdown=${JSON.stringify(boosts.data && boosts.data.breakdown)}`);
  const perm = await call('POST', '/v1/pokemon/experience/boosts', { token: u.token, body: { itemId: 'EXP_CARD_PERMANENT' } });
  record('经验：没有永久经验卡时 400', perm.status === 400, `status=${perm.status} ${errName(perm)}`);

  // 经验转移：80%
  const buddy = await givePokemon(u.userId, 1);
  const tr = await call('POST', `/v1/pokemon/${pika.id}/experience/transfer`, { token: u.token, body: { targetPokemonId: buddy.id, amount: 1000 } });
  const buddyRow = await pokemonRow(buddy.id);
  const pikaRow = await pokemonRow(pika.id);
  record('经验：转移 1000 → 目标得 800、源扣 1000', tr.status === 200 && tr.data.received === 800 && buddyRow.experience === 800 && pikaRow.experience === 21000,
    `status=${tr.status} buddy=${buddyRow.experience} pika=${pikaRow.experience} ${tr.status !== 200 ? JSON.stringify(tr.body).slice(0, 160) : ''}`);
  const trTooMuch = await call('POST', `/v1/pokemon/${buddy.id}/experience/transfer`, { token: u.token, body: { targetPokemonId: pika.id, amount: 5000 } });
  record('经验：转移超过已有经验被拒绝', trTooMuch.status === 400 && errName(trTooMuch) === 'INSUFFICIENT_EXPERIENCE', `status=${trTooMuch.status} ${errName(trTooMuch)}`);

  // 历史 / 轨迹 / 来源 / 里程碑 / 预测 / 报告 / 统计
  const hist = await call('GET', `/v1/pokemon/${pika.id}/exp-history?limit=10`, { token: u.token });
  const types = (hist.data && hist.data.items || []).map((i) => i.sourceType);
  record('成长轨迹：经验历史记录来源与前后等级', hist.status === 200 && types.includes('item') && types.includes('transfer_out') && hist.data.items[0].levelAfter >= 1,
    `status=${hist.status} types=${types}`);
  const traj = await call('GET', `/v1/pokemon/${pika.id}/growth/trajectory?days=7`, { token: u.token });
  const last = traj.data && traj.data.points && traj.data.points[traj.data.points.length - 1];
  record('成长轨迹：7 天曲线（补齐空白日、今日累计经验）', traj.status === 200 && traj.data.points.length === 7 && last.expGained > 0 && last.cumulativeExp === 21000,
    `status=${traj.status} last=${JSON.stringify(last)}`);
  const src = await call('GET', `/v1/pokemon/${pika.id}/growth/sources`, { token: u.token });
  const pct = src.data ? src.data.sources.reduce((a, s) => a + s.percentage, 0) : 0;
  record('成长轨迹：来源占比合计 100%', src.status === 200 && Math.round(pct) === 100 && src.data.sources[0].source === 'item', `status=${src.status} ${JSON.stringify(src.data && src.data.sources)}`);
  const ms = await call('GET', `/v1/pokemon/${pika.id}/growth/milestones`, { token: u.token });
  const keys = (ms.data && ms.data.milestones || []).map((m) => m.key);
  record('成长轨迹：里程碑（首份经验/5 级/10 级/累计 1 万经验）', ms.status === 200 && ['first', 'level:5', 'level:10', 'exp:10000'].every((k) => keys.includes(k)), `keys=${keys}`);
  const pred = await call('GET', `/v1/pokemon/${buddy.id}/growth/prediction`, { token: u.token });
  record('成长轨迹：升级预测（日均经验、下一级所需天数、置信度）', pred.status === 200 && pred.data.avgDailyExp > 0 && pred.data.nextLevel && pred.data.nextLevel.days > 0 && pred.data.confidence >= 0,
    `status=${pred.status} ${JSON.stringify(pred.data && { avg: pred.data.avgDailyExp, next: pred.data.nextLevel, c: pred.data.confidence })}`);
  const rep = await call('GET', `/v1/pokemon/${pika.id}/growth/report?period=week`, { token: u.token });
  record('成长轨迹：周报告', rep.status === 200 && rep.data.totalExp === 22000 && rep.data.topSource === 'item', `status=${rep.status} total=${rep.data && rep.data.totalExp}`);
  const rep2 = await call('GET', `/v1/pokemon/${pika.id}/growth/report?period=week`, { token: u.token });
  record('成长轨迹：报告命中缓存', rep2.status === 200 && rep2.data.cached === true, `cached=${rep2.data && rep2.data.cached}`);
  const stats = await call('GET', '/v1/pokemon/experience/stats?period=week', { token: u.token });
  record('经验：本人周统计（每日序列 + 来源）', stats.status === 200 && stats.data.daily.length === 7 && stats.data.totalExp >= 22800,
    `status=${stats.status} total=${stats.data && stats.data.totalExp}`);
  const other = await newUser('exo');
  const peek = await call('GET', `/v1/pokemon/${pika.id}/exp-history`, { token: other.token });
  record('成长轨迹：不能查看别人的精灵（404）', peek.status === 404, `status=${peek.status}`);
  const { rows: parts } = await db().query(
    "SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'pokemon_exp_history'::regclass");
  record('成长轨迹：经验历史按月分区（DEFAULT + 当月起 3 个分区）', parts[0].n >= 4, `partitions=${parts[0].n}`);
}

const SECTIONS = { evolution: testEvolution, experience: testExperience };

(async () => {
  const want = process.argv.slice(2);
  for (const [name, fn] of Object.entries(SECTIONS)) {
    if (want.length && !want.includes(name)) continue;
    console.log(`\n── ${name} ──`);
    try { await fn(); } catch (err) { record(`${name}：执行异常`, false, err.stack.split('\n').slice(0, 3).join(' | ')); }
  }
  await finish();
})();
