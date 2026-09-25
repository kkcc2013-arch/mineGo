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

// ───────────────────── 体力 / 疲劳（REQ-00172） ─────────────────────
async function staminaOf(id) {
  const { rows: [r] } = await db().query('SELECT current_stamina, last_stamina_update FROM pokemon_instances WHERE id = $1', [id]);
  return r;
}

async function testStamina() {
  const u = await newUser('stm');
  const p = await givePokemon(u.userId, 7);
  const s0 = await call('GET', `/v1/pokemon/${p.id}/stamina`, { token: u.token });
  record('体力：查询 /v1/pokemon/:id/stamina（原 500）', s0.status === 200 && s0.data.currentStamina === 100 && s0.data.fatigueLevel === 'fresh',
    `status=${s0.status} ${JSON.stringify(s0.data && { c: s0.data.currentStamina, f: s0.data.fatigueLevel })}`);
  const cfg = await call('GET', '/v1/pokemon/stamina/config', { token: u.token });
  record('体力：配置（活动消耗/恢复道具/疲劳等级）', cfg.status === 200 && cfg.data.activityCosts.some((c) => c.activityType === 'gym_battle') && cfg.data.recoveryItems.length >= 6,
    `status=${cfg.status}`);

  for (let i = 0; i < 4; i++) await call('POST', `/v1/pokemon/${p.id}/stamina/consume`, { token: u.token, body: { activityType: 'gym_battle' } });
  const tired = await call('GET', `/v1/pokemon/${p.id}/stamina`, { token: u.token });
  record('体力：道馆战斗 4 次（-80）→ 20 体力、疲惫（战斗 ×0.85）', tired.data.currentStamina === 20 && tired.data.fatigueLevel === 'tired' && tired.data.effects.battleBonus === 0.85,
    `stamina=${tired.data.currentStamina} fatigue=${tired.data.fatigueLevel}`);
  await call('POST', `/v1/pokemon/${p.id}/stamina/consume`, { token: u.token, body: { activityType: 'battle_turn' } });
  const ex = await call('GET', `/v1/pokemon/${p.id}/stamina`, { token: u.token });
  record('体力：低于 20% 为精疲力竭（战斗 ×0.6、经验 ×0.8）', ex.data.fatigueLevel === 'exhausted' && ex.data.effects.battleBonus === 0.6 && ex.data.effects.expBonus === 0.8,
    `stamina=${ex.data.currentStamina} fatigue=${ex.data.fatigueLevel}`);
  const over = await call('POST', `/v1/pokemon/${p.id}/stamina/consume`, { token: u.token, body: { activityType: 'gym_battle' } });
  record('体力：不足时拒绝消耗（400 INSUFFICIENT_STAMINA）', over.status === 400 && errName(over) === 'INSUFFICIENT_STAMINA', `status=${over.status} ${errName(over)}`);
  const badAct = await call('POST', `/v1/pokemon/${p.id}/stamina/consume`, { token: u.token, body: { activityType: 'nope' } });
  record('体力：未知活动类型 400', badAct.status === 400, `status=${badAct.status}`);

  // 自然恢复：把上次更新时间拨回 10 分钟 → +10
  await db().query("UPDATE pokemon_instances SET last_stamina_update = NOW() - INTERVAL '10 minutes 20 seconds' WHERE id = $1", [p.id]);
  const nat = await call('GET', `/v1/pokemon/${p.id}/stamina`, { token: u.token });
  record('体力：自然恢复每分钟 1 点（惰性换算）', nat.data.currentStamina === 25, `stamina=${nat.data.currentStamina}`);

  // 恢复道具与冷却
  await giveItem(u.userId, 'STAMINA_POTION_M', 1);
  const potion = await call('POST', `/v1/pokemon/${p.id}/stamina/use-item`, { token: u.token, body: { itemId: 'STAMINA_POTION_M' } });
  record('体力：体力药水(中) +50 并消耗道具', potion.status === 200 && potion.data.staminaAfter === 75 && (await itemQty(u.userId, 'STAMINA_POTION_M')) === 0,
    `status=${potion.status} after=${potion.data && potion.data.staminaAfter}`);
  await giveItem(u.userId, 'STAMINA_ENERGY_DRINK', 2);
  const d1 = await call('POST', `/v1/pokemon/${p.id}/stamina/use-item`, { token: u.token, body: { itemId: 'STAMINA_ENERGY_DRINK' } });
  const d2 = await call('POST', `/v1/pokemon/${p.id}/stamina/use-item`, { token: u.token, body: { itemId: 'STAMINA_ENERGY_DRINK' } });
  record('体力：能量饮料冷却中再次使用被拒（409 ITEM_COOLDOWN，道具不扣）', d1.status === 200 && d2.status === 409 && errName(d2) === 'ITEM_COOLDOWN' && (await itemQty(u.userId, 'STAMINA_ENERGY_DRINK')) === 1,
    `d1=${d1.status} d2=${d2.status} ${errName(d2)}`);
  await giveItem(u.userId, 'STAMINA_POTION_L', 1);
  await call('POST', `/v1/pokemon/${p.id}/stamina/use-item`, { token: u.token, body: { itemId: 'STAMINA_POTION_L' } });
  const full = await call('POST', `/v1/pokemon/${p.id}/stamina/use-item`, { token: u.token, body: { itemId: 'STAMINA_POTION_S' } });
  record('体力：满体力时不允许使用恢复道具', full.status === 400 && errName(full) === 'STAMINA_FULL', `status=${full.status} ${errName(full)}`);

  // 并发消耗不超扣：50 体力，5 个并发道馆战斗（每次 20）→ 只成功 2 次
  const q = await givePokemon(u.userId, 7);
  await db().query('UPDATE pokemon_instances SET current_stamina = 50, last_stamina_update = NOW() WHERE id = $1', [q.id]);
  const conc = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', `/v1/pokemon/${q.id}/stamina/consume`, { token: u.token, body: { activityType: 'gym_battle' } })));
  const left = (await staminaOf(q.id)).current_stamina;
  record('体力：并发消耗只成功到体力用尽（2 次，余 10）', conc.filter((r) => r.status === 200).length === 2 && left === 10, `statuses=${conc.map((r) => r.status)} left=${left}`);

  // 批量查询性能：100 只精灵
  await db().query(
    `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, current_stamina)
     SELECT $1, 1, 500, 80, 80, 5, 5, 5, (g % 100) FROM generate_series(1, 98) g`, [u.userId]);
  const { rows: ids } = await db().query('SELECT id FROM pokemon_instances WHERE user_id = $1 LIMIT 100', [u.userId]);
  const times = [];
  let batch;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    batch = await call('POST', '/v1/pokemon/stamina/batch', { token: u.token, body: { pokemonIds: ids.map((r) => r.id) } });
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  record('体力：批量查询 100 只精灵（经网关，中位数 < 100ms）', batch.status === 200 && batch.data.length === 100 && times[2] < 100, `median=${times[2]}ms all=${times}`);

  // 休息站：站点 100 米内开始休息，休息中不能进化，结束后按时长额外恢复
  const lat = 31.2001 + Math.random() * 0.01;
  const lng = 121.4001 + Math.random() * 0.01;
  const { rows: [st] } = await db().query(
    `INSERT INTO recovery_stations (name, description, location, type, level, recovery_speed_multiplier, status)
     VALUES ('冒烟测试休息站', 'smoke', ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, 'normal', 1, 1.0, 'active') RETURNING id`, [lat, lng]);
  const near = await call('GET', `/v1/pokemon/stamina/rest-stations?lat=${lat}&lng=${lng}&radius=500`, { token: u.token });
  record('体力：附近休息站', near.status === 200 && near.data.some((s) => s.id === st.id), `status=${near.status} count=${near.data && near.data.length}`);
  const noPos = await call('POST', `/v1/pokemon/${q.id}/stamina/rest`, { token: u.token, body: { stationId: st.id } });
  record('体力：未上报位置不能休息', noPos.status === 400, `status=${noPos.status} ${errName(noPos)}`);
  await call('POST', '/v1/location', { token: u.token, body: { lat: lat + 0.0002, lng, accuracy: 10 } });
  const rest = await call('POST', `/v1/pokemon/${q.id}/stamina/rest`, { token: u.token, body: { stationId: st.id } });
  record('体力：在休息站开始休息', rest.status === 200 && rest.data.recoveryPerMinute === 5, `status=${rest.status} ${rest.status !== 200 ? JSON.stringify(rest.body).slice(0, 160) : ''}`);
  const busy = await call('POST', `/v1/pokemon/${q.id}/evolution/execute`, { token: u.token, body: {} });
  record('体力：休息中的精灵不能进化（409）', busy.status === 409, `status=${busy.status}`);
  await db().query("UPDATE rest_records SET started_at = NOW() - INTERVAL '10 minutes' WHERE pokemon_id = $1 AND ended_at IS NULL", [q.id]);
  const end = await call('POST', `/v1/pokemon/${q.id}/stamina/rest/end`, { token: u.token });
  record('体力：结束休息，10 分钟额外恢复 50', end.status === 200 && end.data.minutes === 10 && end.data.recovered === 50 && (await pokemonRow(q.id)).occupied_by === null,
    `status=${end.status} ${JSON.stringify(end.data && { m: end.data.minutes, r: end.data.recovered })}`);
  const hist = await call('GET', `/v1/pokemon/${p.id}/stamina/history`, { token: u.token });
  record('体力：变化记录（消耗/道具）', hist.status === 200 && hist.data.some((h) => h.source === 'item:STAMINA_POTION_M') && hist.data.some((h) => h.activityType === 'gym_battle'), `status=${hist.status}`);
  await db().query('DELETE FROM recovery_stations WHERE id = $1', [st.id]);
}

// ───────────────────── 进化路径可视化（REQ-00355） ─────────────────────
async function testEvolutionTree() {
  const u = await newUser('viz');
  const t = await call('GET', '/v1/pokemon/species/2/evolution-chain', { token: u.token });
  record('进化树：/v1/pokemon/species/2/evolution-chain（原 500）返回整个家族', t.status === 200 && t.data.rootSpeciesId === 1 && t.data.nodes.length === 3 && t.data.edges.length === 2,
    `status=${t.status} nodes=${t.data && t.data.nodes && t.data.nodes.map((n) => n.speciesId)}`);
  record('进化树：节点带阶段与布局坐标、边带条件描述与属性变化', t.data && t.data.nodes.every((n) => n.position && n.stage) && t.data.edges[0].conditionText && t.data.edges[0].statChanges,
    `edge0=${t.data && JSON.stringify(t.data.edges[0]).slice(0, 120)}`);
  const e0 = await call('GET', '/v1/pokemon/species/133/evolution-chain', { token: u.token });
  const hiddenEdges = (e0.data && e0.data.edges || []).filter((e) => e.hidden);
  record('进化树：伊布分支（5 条），隐藏路径未发现时打码并给提示', e0.status === 200 && e0.data.hasBranches && hiddenEdges.length === 2 && hiddenEdges.every((e) => e.to === null && e.hint),
    `edges=${e0.data && e0.data.edges.length} hidden=${hiddenEdges.length}`);
  await db().query(
    `INSERT INTO pokedex_entries (user_id, species_id, seen_count, caught_count, first_caught_at) VALUES ($1, 196, 1, 1, NOW())
     ON CONFLICT (user_id, species_id) DO UPDATE SET caught_count = 1`, [u.userId]);
  const e1 = await call('GET', '/v1/pokemon/species/133/evolution-chain?lang=en', { token: u.token });
  const sun = e1.data && e1.data.edges.find((e) => e.to === 196);
  record('进化树：图鉴已捕获后隐藏路径显形，条件按语言描述', !!sun && /friendship 220\+/.test(sun.conditionText), `edge=${sun && sun.conditionText}`);
  const pre = await call('GET', '/v1/pokemon/species/3/pre-evolutions', { token: u.token });
  record('进化树：反向追溯前身', pre.status === 200 && pre.data.chain.map((c) => c.speciesId).join() === '1,2', `status=${pre.status}`);
  const types = await call('GET', '/v1/pokemon/evolution-types?lang=ja', { token: u.token });
  record('进化树：支持的进化类型（等级/道具/亲密度/时间/地点/交换/特殊）', types.status === 200 && ['level', 'item', 'friendship', 'time', 'location', 'trade', 'special'].every((k) => types.data.some((x) => x.type === k)), `status=${types.status}`);
  const batch = await call('POST', '/v1/pokemon/batch-evolution-chains', { token: u.token, body: { speciesIds: [1, 25, 9999] } });
  record('进化树：批量查询（不存在的物种单独报错）', batch.status === 200 && batch.data['1'].nodes && batch.data['9999'].error, `status=${batch.status}`);

  const p = await givePokemon(u.userId, 1);
  const pv = await call('GET', `/v1/pokemon/${p.id}/evolution-preview/2`, { token: u.token });
  record('进化树：进化前后属性对比预览', pv.status === 200 && pv.data.comparison.cp.after > pv.data.comparison.cp.before && pv.data.canEvolve === false,
    `status=${pv.status} cp=${pv.data && JSON.stringify(pv.data.comparison.cp)}`);
  await setCandy(u.userId, 1, 25);
  const rec = await call('GET', `/v1/pokemon/${p.id}/recommended-evolution`, { token: u.token });
  record('进化树：推荐进化路径', rec.status === 200 && rec.data.recommendation && rec.data.recommendation.toSpeciesId === 2, `status=${rec.status}`);
  const ev = await call('POST', '/v1/pokemon/evolve', { token: u.token, body: { pokemonId: p.id, targetSpeciesId: 2 } });
  record('进化树：POST /v1/pokemon/evolve 执行进化（同一实现）', ev.status === 200 && ev.data.toSpecies.id === 2 && (await candy(u.userId, 1)) === 0, `status=${ev.status}`);
}

// ───────────────────── 羁绊技能（REQ-00151） ─────────────────────
async function testBondSkills() {
  const u = await newUser('bnd');
  const avail = await call('GET', '/v1/pokemon/species/25/bond-skills', { token: u.token });
  record('羁绊：皮卡丘羁绊技能列表（3 槽，解锁 20/50/90）', avail.status === 200 && avail.data.skills.length === 3 && avail.data.skills.map((s) => s.unlockBondLevel).join() === '20,50,90',
    `status=${avail.status} ${avail.data && avail.data.skills.map((s) => s.unlockBondLevel)}`);
  const skillId = (slot) => avail.data.skills.find((s) => s.slot === slot).id;
  const p = await givePokemon(u.userId, 25, { friendship: 50 });
  const setF = (f) => db().query('UPDATE pokemon_instances SET friendship = $2 WHERE id = $1', [p.id, f]);
  const learn = (slot) => call('POST', `/v1/pokemon/${p.id}/bond-skills/${skillId(slot)}/learn`, { token: u.token });

  const low = await learn(1);
  record('羁绊：羁绊等级 19 不能学 1 槽（400 FRIENDSHIP_TOO_LOW）', low.status === 400 && errName(low) === 'FRIENDSHIP_TOO_LOW', `status=${low.status} ${errName(low)}`);
  await setF(51);
  const l1 = await learn(1);
  const l2early = await learn(2);
  record('羁绊：羁绊等级 20 可学 1 槽，2 槽仍锁定', l1.status === 200 && l2early.status === 400, `l1=${l1.status} l2=${l2early.status}`);
  await setF(128);
  const l2 = await learn(2);
  await setF(229);
  const l3early = await learn(3);
  await setF(230);
  const l3 = await learn(3);
  record('羁绊：羁绊等级 50 学 2 槽、90 学 3 槽', l2.status === 200 && l3early.status === 400 && l3.status === 200, `l2=${l2.status} l3(229)=${l3early.status} l3(230)=${l3.status}`);
  const dup = await learn(1);
  record('羁绊：重复学习被拒（409）', dup.status === 409, `status=${dup.status}`);

  const notActive = await call('POST', `/v1/pokemon/${p.id}/bond-skills/${skillId(1)}/use`, { token: u.token, body: {} });
  record('羁绊：未激活的技能不能在战斗中使用', notActive.status === 400 && errName(notActive) === 'NOT_ACTIVE', `status=${notActive.status} ${errName(notActive)}`);
  await call('POST', `/v1/pokemon/${p.id}/bond-skills/${skillId(1)}/activate`, { token: u.token });
  await call('POST', `/v1/pokemon/${p.id}/bond-skills/${skillId(3)}/activate`, { token: u.token });
  const list = await call('GET', `/v1/pokemon/${p.id}/bond-skills`, { token: u.token });
  record('羁绊：最多激活 1 个', list.status === 200 && list.data.skills.filter((s) => s.isActive).length === 1 && list.data.activeSkill.id === skillId(3),
    `active=${list.data && list.data.skills.filter((s) => s.isActive).map((s) => s.slot)}`);
  const used = await call('POST', `/v1/pokemon/${p.id}/bond-skills/${skillId(3)}/use`, { token: u.token, body: { battleId: 'smoke-battle' } });
  record('羁绊：战斗中使用激活的技能（扣 PP、返回效果）', used.status === 200 && used.data.power === 120 && used.data.remainingPp === 4 && used.data.additionalEffects.crit_bonus > 0.9,
    `status=${used.status} ${JSON.stringify(used.data && { p: used.data.power, pp: used.data.remainingPp, fx: used.data.additionalEffects })}`);
  await setF(60);
  const weak = await call('GET', `/v1/pokemon/${p.id}/bond-skills/${skillId(1)}/effect`, { token: u.token });
  await setF(255);
  const strong = await call('GET', `/v1/pokemon/${p.id}/bond-skills/${skillId(1)}/effect`, { token: u.token });
  record('羁绊：威力按亲密度计算（65 + floor(亲密度×0.5)）', weak.data.power === 95 && strong.data.power === 192, `f60=${weak.data && weak.data.power} f255=${strong.data && strong.data.power}`);
  await db().query('UPDATE pokemon_bond_skills SET current_pp = 0 WHERE pokemon_instance_id = $1', [p.id]);
  const noPp = await call('POST', `/v1/pokemon/${p.id}/bond-skills/${skillId(3)}/use`, { token: u.token, body: {} });
  record('羁绊：PP 用完不能使用', noPp.status === 400 && errName(noPp) === 'NO_PP', `status=${noPp.status}`);
  const del = await call('DELETE', `/v1/pokemon/${p.id}/bond-skills/${skillId(1)}`, { token: u.token });
  const re = await learn(1);
  record('羁绊：遗忘后可重新学习', del.status === 200 && re.status === 200, `del=${del.status} relearn=${re.status}`);
  const stats = await call('GET', '/v1/pokemon/bond-skills/stats', { token: u.token });
  record('羁绊：统计', stats.status === 200 && stats.data.summary.totalSkillsLearned === 3 && stats.data.topSkills.length === 1, `status=${stats.status}`);
  const other = await newUser('bnx');
  const steal = await call('POST', `/v1/pokemon/${p.id}/bond-skills/${skillId(1)}/activate`, { token: other.token });
  record('羁绊：不能操作别人的精灵（404）', steal.status === 404, `status=${steal.status}`);
}

// ───────────────────── 训练营（REQ-00370） ─────────────────────
async function testTrainingCamp() {
  const u = await newUser('tcp');
  const T = '/v1/pokemon/training-camp';
  const camps = await call('GET', `${T}/camps`, { token: u.token });
  record('训练营：三类训练营自动开通（经验/技能/亲密度）', camps.status === 200 && ['experience', 'skill', 'friendship'].every((t) => camps.data.some((c) => c.type === t)),
    `status=${camps.status} ${camps.status !== 200 ? JSON.stringify(camps.body).slice(0, 160) : ''}`);
  const campId = (type) => camps.data.find((c) => c.type === type).campId;
  const courses = await call('GET', `${T}/camps/${campId('experience')}/courses`, { token: u.token });
  const course = (name) => courses.data.find((c) => c.name === name);
  record('训练营：课程列表（时长/费用/解锁等级/预期奖励）', courses.status === 200 && course('基础训练') && course('基础训练').cost === null && course('进阶训练').unlocked === false,
    `status=${courses.status}`);

  const p = await givePokemon(u.userId, 1);
  const st = await call('POST', `${T}/start`, { token: u.token, body: { campId: campId('experience'), courseId: course('基础训练').courseId, pokemonId: p.id } });
  record('训练营：开始训练（消耗 15 体力，满体力评级 excellent ×1.2）', st.status === 200 && st.data.rating === 'excellent' && st.data.expectedExp === 120 && st.data.stamina.staminaAfter === 85,
    `status=${st.status} ${st.status !== 200 ? JSON.stringify(st.body).slice(0, 200) : JSON.stringify({ r: st.data.rating, e: st.data.expectedExp })}`);
  const slotId = st.data && st.data.slotId;
  const again = await call('POST', `${T}/start`, { token: u.token, body: { campId: campId('experience'), courseId: course('基础训练').courseId, pokemonId: p.id } });
  const evo = await call('POST', `/v1/pokemon/${p.id}/evolution/execute`, { token: u.token, body: {} });
  record('训练营：训练中的精灵不能再训练/进化（409）', again.status === 409 && evo.status === 409, `again=${again.status} evolve=${evo.status}`);
  const early = await call('POST', `${T}/slots/${slotId}/complete`, { token: u.token });
  const prog = await call('GET', `${T}/slots/${slotId}`, { token: u.token });
  record('训练营：未到时间不能领取；进度精确到分钟', early.status === 400 && errName(early) === 'NOT_READY' && prog.data.remainingMinutes === 30,
    `early=${early.status} remaining=${prog.data && prog.data.remainingMinutes}`);
  const noItem = await call('POST', `${T}/slots/${slotId}/boost`, { token: u.token, body: { itemId: 'TRAINING_TIMER_INSTANT' } });
  await giveItem(u.userId, 'TRAINING_TIMER_INSTANT', 1);
  const boost = await call('POST', `${T}/slots/${slotId}/boost`, { token: u.token, body: { itemId: 'TRAINING_TIMER_INSTANT' } });
  record('训练营：加速道具（无道具 400；立即完成券生效并扣除）', noItem.status === 400 && boost.status === 200 && boost.data.status === 'ready' && (await itemQty(u.userId, 'TRAINING_TIMER_INSTANT')) === 0,
    `noItem=${noItem.status} boost=${boost.status} status=${boost.data && boost.data.status}`);
  const done = await call('POST', `${T}/slots/${slotId}/complete`, { token: u.token });
  const row = await pokemonRow(p.id);
  record('训练营：领取奖励（经验入账、精灵解除占用）', done.status === 200 && done.data.rewards.exp === 120 && row.experience === 120 && row.occupied_by === null,
    `status=${done.status} exp=${done.data && done.data.rewards.exp} pokemonExp=${row.experience}`);
  const twice = await call('POST', `${T}/slots/${slotId}/complete`, { token: u.token });
  record('训练营：重复领取被拒（409）', twice.status === 409, `status=${twice.status}`);

  // 付费课程 / 升级 / 取消不退费
  const locked = await call('POST', `${T}/start`, { token: u.token, body: { campId: campId('experience'), courseId: course('进阶训练').courseId, pokemonId: p.id } });
  const poor = await call('POST', `${T}/camps/${campId('experience')}/upgrade`, { token: u.token });
  await db().query('UPDATE users SET coins = 3000 WHERE id = $1', [u.userId]);
  const up = await call('POST', `${T}/camps/${campId('experience')}/upgrade`, { token: u.token });
  record('训练营：课程等级锁、金币不足不能升级、升级扣 2000 金币并扩容', locked.status === 400 && poor.status === 400 && up.status === 200 && up.data.level === 2 && up.data.capacity === 4,
    `locked=${locked.status} poor=${poor.status} up=${up.status} ${JSON.stringify(up.data)}`);
  const paid = await call('POST', `${T}/start`, { token: u.token, body: { campId: campId('experience'), courseId: course('进阶训练').courseId, pokemonId: p.id } });
  const coins1 = (await db().query('SELECT coins FROM users WHERE id = $1', [u.userId])).rows[0].coins;
  const cancel = await call('POST', `${T}/slots/${paid.data && paid.data.slotId}/cancel`, { token: u.token });
  const coins2 = (await db().query('SELECT coins FROM users WHERE id = $1', [u.userId])).rows[0].coins;
  record('训练营：付费课程扣 500 金币，取消训练不退费并释放精灵', paid.status === 200 && coins1 === 500 && cancel.status === 200 && coins2 === 500 && (await pokemonRow(p.id)).occupied_by === null,
    `paid=${paid.status} coins=${coins1}->${coins2} cancel=${cancel.status}`);

  // 亲密度营
  const fc = await call('GET', `${T}/camps/${campId('friendship')}/courses`, { token: u.token });
  const q = await givePokemon(u.userId, 25, { friendship: 70 });
  const fs = await call('POST', `${T}/start`, { token: u.token, body: { campId: campId('friendship'), courseId: fc.data.find((c) => c.name === '互动训练').courseId, pokemonId: q.id } });
  await db().query("UPDATE training_slots SET ends_at = NOW() - INTERVAL '1 second' WHERE id = $1", [fs.data && fs.data.slotId]);
  const fdone = await call('POST', `${T}/slots/${fs.data && fs.data.slotId}/complete`, { token: u.token });
  record('训练营：亲密度营提升亲密度（5 × 评级 1.2 = 6）', fdone.status === 200 && fdone.data.rewards.friendship.gained === 6 && (await pokemonRow(q.id)).friendship === 76,
    `status=${fdone.status} ${JSON.stringify(fdone.data && fdone.data.rewards)}`);

  // 槽位满
  const full = [];
  for (let i = 0; i < 3; i++) {
    const x = await givePokemon(u.userId, 7);
    full.push(await call('POST', `${T}/start`, { token: u.token, body: { campId: campId('friendship'), courseId: fc.data.find((c) => c.name === '互动训练').courseId, pokemonId: x.id } }));
  }
  const y = await givePokemon(u.userId, 7);
  const over = await call('POST', `${T}/start`, { token: u.token, body: { campId: campId('friendship'), courseId: fc.data.find((c) => c.name === '互动训练').courseId, pokemonId: y.id } });
  record('训练营：槽位满时不能开始（3 槽）', full.every((r) => r.status === 200) && over.status === 409 && errName(over) === 'NO_FREE_SLOT', `statuses=${full.map((r) => r.status)} over=${over.status}`);
  const hist = await call('GET', `${T}/history`, { token: u.token });
  record('训练营：训练报告（历史）', hist.status === 200 && hist.data.items.length === 2, `status=${hist.status} n=${hist.data && hist.data.items.length}`);
}

// ───────────────────── 专项特训（REQ-00612） ─────────────────────
async function testSpecialTraining() {
  const u = await newUser('spt');
  const S = '/v1/pokemon/special-training';
  const fac = await call('GET', `${S}/facilities`, { token: u.token });
  record('特训：场地列表（基础场开放、力量训练场需训练师 5 级）', fac.status === 200 && fac.data.find((f) => f.facilityId === 'basic').unlocked && !fac.data.find((f) => f.facilityId === 'strength_gym').unlocked,
    `status=${fac.status}`);
  const p = await givePokemon(u.userId, 4);
  await db().query("UPDATE pokemon_instances SET fast_move = 'SCRATCH', charge_move = 'FLAMETHROWER' WHERE id = $1", [p.id]);
  const lockedFac = await call('POST', `/v1/pokemon/${p.id}/training/start`, { token: u.token, body: { trainingType: 'attack', facilityId: 'strength_gym' } });
  const noItem = await call('POST', `/v1/pokemon/${p.id}/training/start`, { token: u.token, body: { trainingType: 'attack' } });
  record('特训：场地未解锁 403、缺训练道具 400', lockedFac.status === 403 && noItem.status === 400 && errName(noItem) === 'INSUFFICIENT_ITEMS', `locked=${lockedFac.status} noItem=${noItem.status}`);

  await db().query('UPDATE users SET coins = 1000 WHERE id = $1', [u.userId]);
  const buy = await call('POST', `${S}/items/buy`, { token: u.token, body: { itemId: 'TRAIN_ENERGY_DRINK', quantity: 1 } });
  const notForSale = await call('POST', `${S}/items/buy`, { token: u.token, body: { itemId: 'TRAIN_GOLDEN_APPLE' } });
  record('特训：商店用金币购买训练道具（付费道具不出售）', buy.status === 200 && (await itemQty(u.userId, 'TRAIN_ENERGY_DRINK')) === 1 && notForSale.status === 400,
    `buy=${buy.status} notForSale=${notForSale.status}`);
  await setCandy(u.userId, 4, 300);
  await giveItem(u.userId, 'TRAIN_GOLDEN_APPLE', 1);
  const st = await call('POST', `/v1/pokemon/${p.id}/training/start`, { token: u.token, body: { trainingType: 'attack', useGoldenApple: true } });
  record('特训：开始攻击特训（扣道具/100 糖果/体力，金苹果成功率 100%，精灵显示训练中）',
    st.status === 200 && st.data.successRate === 1 && (await candy(u.userId, 4)) === 200 && (await pokemonRow(p.id)).occupied_by === 'special_training',
    `status=${st.status} ${st.status !== 200 ? JSON.stringify(st.body).slice(0, 200) : ''}`);
  const tid = st.data && st.data.trainingId;
  const early = await call('POST', `/v1/pokemon/${p.id}/training/${tid}/complete`, { token: u.token });
  await giveItem(u.userId, 'TRAINING_ACCELERATOR_1H', 1);
  const acc = await call('POST', `${S}/items/use`, { token: u.token, body: { itemId: 'TRAINING_ACCELERATOR_1H', trainingId: tid } });
  const q1 = await call('GET', `${S}/queue`, { token: u.token });
  record('特训：未到时间不能完成；加速器缩短 1 小时；队列显示', early.status === 400 && acc.status === 200 && acc.data.ready === true && q1.data.slots.used === 1 && q1.data.slots.max === 3,
    `early=${early.status} acc=${acc.status} queue=${JSON.stringify(q1.data && q1.data.slots)}`);
  const done = await call('POST', `/v1/pokemon/${p.id}/training/${tid}/complete`, { token: u.token });
  record('特训：完成后攻击 +1 级、首次训练成就发放 1000 糖果',
    done.status === 200 && done.data.success && done.data.newLevel === 1 && done.data.achievements.some((a) => a.id === 'first_training') && (await candy(u.userId, 4)) === 1200,
    `status=${done.status} ${JSON.stringify(done.data && { lv: done.data.newLevel, ach: done.data.achievements })}`);
  const status = await call('GET', `/v1/pokemon/${p.id}/training`, { token: u.token });
  record('特训：训练状态（属性等级与战斗加成、历史）', status.status === 200 && status.data.attributes.attack.level === 1 && status.data.bonuses.attackPct === 0.02 && status.data.trainingHistory.length === 1,
    `status=${status.status}`);
  await giveItem(u.userId, 'TRAIN_ENERGY_DRINK', 5);
  const cool = await call('POST', `/v1/pokemon/${p.id}/training/start`, { token: u.token, body: { trainingType: 'attack' } });
  record('特训：刚完成的精灵需要冷却 60 分钟', cool.status === 409 && errName(cool) === 'TRAINING_COOLDOWN', `status=${cool.status} ${errName(cool)}`);

  const others = [];
  for (let i = 0; i < 4; i++) others.push(await givePokemon(u.userId, 4));
  const starts = [];
  for (const o of others) starts.push(await call('POST', `/v1/pokemon/${o.id}/training/start`, { token: u.token, body: { trainingType: 'attack' } }));
  record('特训：队列满（3）后不能再开', starts.slice(0, 3).every((r) => r.status === 200) && starts[3].status === 409 && errName(starts[3]) === 'QUEUE_FULL',
    `statuses=${starts.map((r) => r.status)}`);
  const cancel = await call('POST', `/v1/pokemon/${others[0].id}/training/${starts[0].data.trainingId}/cancel`, { token: u.token });
  record('特训：取消后释放精灵（不退还材料）', cancel.status === 200 && (await pokemonRow(others[0].id)).occupied_by === null, `status=${cancel.status}`);

  const sk = await call('POST', `/v1/pokemon/${p.id}/skill/SCRATCH/train`, { token: u.token, body: { dimension: 'power' } });
  await giveItem(u.userId, 'TRAIN_MASTERY_MANUAL', 1);
  const manual = await call('POST', `/v1/pokemon/${p.id}/skill/SCRATCH/train`, { token: u.token, body: { useManual: true } });
  const notKnown = await call('POST', `/v1/pokemon/${p.id}/skill/HYPER_BEAM/train`, { token: u.token, body: { dimension: 'power' } });
  record('特训：技能熟练度（威力 +1 扣 10 糖果；手册 +20 熟练度并解锁特效；未学会的技能不能练）',
    sk.status === 200 && sk.data.mastery.power === 1 && manual.status === 200 && manual.data.mastery.masteryExp === 25 && manual.data.unlockedEffect && notKnown.status === 400,
    `sk=${sk.status} manual=${manual.status} ${JSON.stringify(manual.data && manual.data.mastery)} notKnown=${notKnown.status}`);
  const ach = await call('GET', `${S}/achievements`, { token: u.token });
  record('特训：成就列表', ach.status === 200 && ach.data.find((a) => a.id === 'first_training').achieved, `status=${ach.status}`);
}

// ───────────────────── 觉醒 / 战斗档案 / 成长商店（REQ-00245） ─────────────────────
async function testAwakening() {
  const u = await newUser('awk');
  const p = await givePokemon(u.userId, 25, { level: 20, experience: 8000, friendship: 150 });
  const st0 = await call('GET', `/v1/pokemon/${p.id}/awakening`, { token: u.token });
  const shardCheck = st0.data && st0.data.next.checks.find((c) => c.type === 'item:AWAKENING_SHARD');
  record('觉醒：条件检查（等级/亲密度满足，觉醒碎片不足）', st0.status === 200 && st0.data.stage === 0 && !st0.data.next.met && shardCheck && !shardCheck.met
    && st0.data.next.checks.find((c) => c.type === 'level').met, `status=${st0.status} ${JSON.stringify(st0.data && st0.data.next && st0.data.next.checks.map((c) => [c.type, c.met]))}`);
  const early = await call('POST', `/v1/pokemon/${p.id}/awakening/awaken`, { token: u.token });
  record('觉醒：条件不满足时拒绝（400）', early.status === 400 && errName(early) === 'AWAKENING_CONDITIONS_NOT_MET', `status=${early.status} ${errName(early)}`);

  await db().query('UPDATE users SET coins = 1000, stardust = 5000 WHERE id = $1', [u.userId]);
  const buy = await call('POST', '/v1/pokemon/growth-shop/buy', { token: u.token, body: { itemId: 'AWAKENING_SHARD', quantity: 10 } });
  const shop = await call('GET', '/v1/pokemon/growth-shop/items?category=awakening', { token: u.token });
  record('成长商店：金币购买觉醒碎片 ×10（扣 1000 金币）', buy.status === 200 && (await itemQty(u.userId, 'AWAKENING_SHARD')) === 10 && shop.data.find((i) => i.itemId === 'AWAKENING_SHARD').owned === 10,
    `buy=${buy.status} ${buy.status !== 200 ? JSON.stringify(buy.body).slice(0, 160) : ''}`);
  await setCandy(u.userId, 25, 50);
  const aw = await call('POST', `/v1/pokemon/${p.id}/awakening/awaken`, { token: u.token });
  const row = await pokemonRow(p.id);
  record('觉醒：第 1 阶段觉醒（扣材料/糖果/星尘，抽取 1~2 个潜能，CP 同步加成，光环）',
    aw.status === 200 && aw.data.stage === 1 && aw.data.potentials.length >= 1 && aw.data.potentials.length <= 2 && row.awakening_stage === 1
      && (await itemQty(u.userId, 'AWAKENING_SHARD')) === 0 && (await candy(u.userId, 25)) === 0 && aw.data.aura === 'aura_green' && row.cp === aw.data.cpAfter,
    `status=${aw.status} ${aw.status !== 200 ? JSON.stringify(aw.body).slice(0, 200) : JSON.stringify({ p: aw.data.potentials.map((x) => x.key), cp: [aw.data.cpBefore, aw.data.cpAfter] })}`);
  const noEss = await call('POST', `/v1/pokemon/${p.id}/awakening/reroll`, { token: u.token, body: { stage: 1 } });
  await giveItem(u.userId, 'AWAKENING_ESSENCE', 1);
  await db().query('UPDATE users SET stardust = 1000 WHERE id = $1', [u.userId]);
  const rr = await call('POST', `/v1/pokemon/${p.id}/awakening/reroll`, { token: u.token, body: { stage: 1 } });
  record('觉醒：重洗潜能（无精华 400；消耗 1 精华 + 1000 星尘，下次费用翻倍）', noEss.status === 400 && rr.status === 200 && rr.data.nextCost.items[0].count === 2 && rr.data.nextCost.stardust === 2000,
    `noEss=${noEss.status} rr=${rr.status}`);
  const lv = await call('POST', `/v1/pokemon/${p.id}/awakening/awaken`, { token: u.token });
  record('觉醒：第 2 阶段需要精灵 30 级', lv.status === 400 && /精灵等级/.test(lv.body.error && lv.body.error.message), `status=${lv.status}`);
  const bp = await call('GET', `/v1/pokemon/${p.id}/battle-profile`, { token: u.token });
  record('战斗档案：合成觉醒/特训/疲劳/等级后的战斗属性', bp.status === 200 && bp.data.awakening.stage === 1 && bp.data.stats.attack > 0 && bp.data.stats.levelMultiplier === 1.38 && bp.data.canBattle,
    `status=${bp.status} ${JSON.stringify(bp.data && bp.data.stats)}`);
  const ms = await call('GET', `/v1/pokemon/${p.id}/growth/milestones`, { token: u.token });
  record('觉醒：记入成长里程碑', ms.status === 200 && ms.data.milestones.some((m) => m.type === 'awakening'), `status=${ms.status}`);
  const pots = await call('GET', '/v1/pokemon/awakening/potentials?lang=en', { token: u.token });
  record('觉醒：潜能池多语言', pots.status === 200 && pots.data.some((x) => x.name === 'Power Awakening'), `status=${pots.status}`);
}

// ───────────────────── 培育 / 遗传 / 孵化（REQ-00276） ─────────────────────
async function testBreeding() {
  const u = await newUser('brd');
  const B = '/v1/pokemon/breeding';
  const mother = await givePokemon(u.userId, 1, { iv: [15, 14, 13] });
  const father = await givePokemon(u.userId, 4, { iv: [12, 15, 15] });
  const chk = await call('POST', `${B}/check`, { token: u.token, body: { motherId: mother.id, fatherId: father.id } });
  record('培育：配对检查（怪物蛋组相同，后代为母方家族根，给出时间/费用/遗传概率）',
    chk.status === 200 && chk.data.compatible && chk.data.offspring.speciesId === 1 && chk.data.breedingMinutes > 30 && chk.data.inheritance.ivInheritanceRate === 0.5,
    `status=${chk.status} ${JSON.stringify(chk.data).slice(0, 200)}`);
  const a = await givePokemon(u.userId, 39);
  const b = await givePokemon(u.userId, 74);
  const bad = await call('POST', `${B}/start`, { token: u.token, body: { motherId: a.id, fatherId: b.id } });
  record('培育：蛋组不同不能配对（400 INCOMPATIBLE）', bad.status === 400 && errName(bad) === 'INCOMPATIBLE', `status=${bad.status} ${errName(bad)}`);
  const knot = await call('POST', `${B}/start`, { token: u.token, body: { motherId: mother.id, fatherId: father.id, useDestinyKnot: true } });
  await db().query('UPDATE users SET stardust = 5000 WHERE id = $1', [u.userId]);
  const knot2 = await call('POST', `${B}/start`, { token: u.token, body: { motherId: mother.id, fatherId: father.id, useDestinyKnot: true } });
  record('培育：星尘不足/没有命运红线时拒绝', knot.status === 400 && knot2.status === 400 && errName(knot2) === 'INSUFFICIENT_ITEMS', `a=${knot.status}:${errName(knot)} b=${knot2.status}:${errName(knot2)}`);
  await giveItem(u.userId, 'DESTINY_KNOT', 1);
  const st = await call('POST', `${B}/start`, { token: u.token, body: { motherId: mother.id, fatherId: father.id, useDestinyKnot: true } });
  const busy = await call('POST', `/v1/pokemon/${mother.id}/evolution/execute`, { token: u.token, body: {} });
  record('培育：开始培育（扣星尘与命运红线，父母被占用不能进化）', st.status === 200 && st.data.destinyKnot && (await itemQty(u.userId, 'DESTINY_KNOT')) === 0 && busy.status === 409,
    `status=${st.status} ${st.status !== 200 ? JSON.stringify(st.body).slice(0, 160) : ''} busy=${busy.status}`);
  const pairId = st.data && st.data.pairId;
  const early = await call('POST', `${B}/pairs/${pairId}/collect`, { token: u.token });
  await db().query("UPDATE breeding_pairs SET ready_at = NOW() - INTERVAL '1 second' WHERE id = $1", [pairId]);
  const col = await call('POST', `${B}/pairs/${pairId}/collect`, { token: u.token });
  record('培育：到时领取精灵蛋并释放父母', early.status === 400 && col.status === 200 && col.data.egg.requiredKm === 5 && (await pokemonRow(mother.id)).occupied_by === null,
    `early=${early.status} collect=${col.status} ${JSON.stringify(col.data && col.data.egg)}`);
  const eggId = col.data && col.data.egg.eggId;
  const notYet = await call('POST', `${B}/eggs/${eggId}/hatch`, { token: u.token });
  const inc = await call('POST', `${B}/eggs/${eggId}/incubate`, { token: u.token, body: { incubator: 'basic' } });
  await db().query('UPDATE users SET total_distance_km = total_distance_km + 3 WHERE id = $1', [u.userId]);
  const half = await call('GET', `${B}/eggs`, { token: u.token });
  record('培育：孵化进度按服务端累计行走距离（3/5 km = 60%）', notYet.status === 400 && inc.status === 200 && half.data[0].percent === 60 && !half.data[0].ready,
    `notYet=${notYet.status} inc=${inc.status} ${JSON.stringify(half.data && half.data[0])}`);
  await db().query('UPDATE users SET total_distance_km = total_distance_km + 2 WHERE id = $1', [u.userId]);
  const hatch = await call('POST', `${B}/eggs/${eggId}/hatch`, { token: u.token });
  const baby = hatch.data && await pokemonRow(hatch.data.pokemonId);
  const ivSources = hatch.data ? Object.values(hatch.data.genes.ivs).map((g) => g.from) : [];
  record('培育：孵化出后代（第 1 代、来源 bred、IV 由基因决定并记录来源）',
    hatch.status === 200 && baby.species_id === 1 && baby.generation === 1 && baby.origin === 'bred'
      && baby.iv_attack === hatch.data.ivs.attack && ivSources.every((s) => ['mother', 'father', 'random'].includes(s)),
    `status=${hatch.status} ${JSON.stringify(hatch.data && { ivs: hatch.data.ivs, src: ivSources, mut: hatch.data.genes.mutation })}`);
  const lin = await call('GET', `${B}/lineage/${hatch.data && hatch.data.pokemonId}`, { token: u.token });
  record('培育：血统追踪', lin.status === 200 && lin.data.lineage.mother.pokemonId === mother.id && lin.data.lineage.father.pokemonId === father.id, `status=${lin.status}`);
  const stats = await call('GET', `${B}/stats`, { token: u.token });
  record('培育：统计', stats.status === 200 && stats.data.totalBreeds === 1 && stats.data.totalEggsHatched === 1, `status=${stats.status} ${JSON.stringify(stats.data)}`);
  const again = await call('POST', `${B}/eggs/${eggId}/hatch`, { token: u.token });
  record('培育：同一个蛋不能重复孵化（409）', again.status === 409, `status=${again.status}`);
}

// ───────────────────── 传承（REQ-00361） ─────────────────────
async function testInheritance() {
  const u = await newUser('inh');
  const p = await givePokemon(u.userId, 2, { iv: [15, 15, 15], friendship: 255 });
  const fav = await givePokemon(u.userId, 1, { favorite: true });
  const favR = await call('POST', `/v1/pokemon/${fav.id}/release-with-inheritance`, { token: u.token, body: { inherit: true } });
  record('传承：收藏的精灵不能放生', favR.status === 400 && errName(favR) === 'POKEMON_FAVORITE', `status=${favR.status}`);
  const noStone = await call('POST', `/v1/pokemon/${p.id}/release-with-inheritance`, { token: u.token, body: { inherit: true, inheritanceItem: 'LEGACY_STONE_PERFECT' } });
  record('传承：没有传承石时拒绝', noStone.status === 400 && errName(noStone) === 'INSUFFICIENT_ITEMS', `status=${noStone.status}`);
  const rel = await call('POST', `/v1/pokemon/${p.id}/release-with-inheritance`, { token: u.token, body: { inherit: true } });
  const my = await call('GET', '/v1/pokemon/my?limit=50', { token: u.token });
  record('传承：放生并传承（软删除、返还 1 糖果 + 100 星尘、按家族根写入传承池，亲密度满级传承率 50%）',
    rel.status === 200 && rel.data.pool.speciesId === 1 && rel.data.pool.inheritanceRate === 0.5 && rel.data.pool.pool.ivAttack === 15
      && (await pokemonRow(p.id)).is_released === true && !(my.data.pokemon || []).some((x) => x.id === p.id) && (await candy(u.userId, 1)) === 1,
    `status=${rel.status} ${rel.status !== 200 ? JSON.stringify(rel.body).slice(0, 160) : JSON.stringify(rel.data.pool.currentBonus)}`);
  const pool = await call('GET', '/v1/pokemon/inheritance/pool/2', { token: u.token });
  record('传承：按物种查询传承池（家族共享，30 天有效，当前加成预览）', pool.status === 200 && pool.data.currentBonus.ivAttack === 8 && !pool.data.expired,
    `status=${pool.status} ${JSON.stringify(pool.data && pool.data.currentBonus)}`);
  await giveItem(u.userId, 'LEGACY_STONE_ADVANCED', 2);
  const use1 = await call('POST', '/v1/pokemon/inheritance/use-item', { token: u.token, body: { speciesId: 1, itemId: 'LEGACY_STONE_ADVANCED' } });
  const use2 = await call('POST', '/v1/pokemon/inheritance/use-item', { token: u.token, body: { speciesId: 1, itemId: 'LEGACY_STONE_ADVANCED' } });
  record('传承：对传承池使用高级传承石（+20% 到 70%），每个池只能用一次', use1.status === 200 && use1.data.inheritanceRate === 0.7 && use2.status === 409,
    `use1=${use1.status} rate=${use1.data && use1.data.inheritanceRate} use2=${use2.status}`);
  await db().query("UPDATE pokemon_inheritance_pool SET refreshed_at = NOW() - INTERVAL '31 days', expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1", [u.userId]);
  const expired = await call('GET', '/v1/pokemon/inheritance/pool', { token: u.token });
  record('传承：30 天后传承池过期（列表不再返回）', expired.status === 200 && expired.data.length === 0, `n=${expired.data && expired.data.length}`);

  if (!process.env.SKIP_CATCH) {
    // 为每个家族放生一只满 IV、满亲密度的精灵并用完美传承石 → 捕到任何精灵都会继承
    const { rows: roots } = await db().query('SELECT DISTINCT pokemon_family_root(id) AS r FROM pokemon_species');
    await giveItem(u.userId, 'LEGACY_STONE_PERFECT', roots.length);
    for (const { r } of roots) {
      const x = await givePokemon(u.userId, r, { iv: [15, 15, 15], friendship: 255 });
      await call('POST', `/v1/pokemon/${x.id}/release-with-inheritance`, { token: u.token, body: { inherit: true, inheritanceItem: 'LEGACY_STONE_PERFECT' } });
    }
    const caught = await catchOne(u);
    record('传承：捕捉同家族精灵自动继承（完美传承 → IV 15/15/15，CP 增加）',
      !!caught && caught.inheritance && caught.pokemon.iv.attack === 15 && caught.pokemon.iv.defense === 15 && caught.pokemon.iv.hp === 15 && caught.inheritance.cpAfter > caught.inheritance.cpBefore,
      caught ? JSON.stringify({ inh: caught.inheritance && { r: caught.inheritance.rate, iv: caught.inheritance.ivAfter }, species: caught.pokemon.speciesId }) : '没有捕到');
    const recs = await call('GET', '/v1/pokemon/inheritance/records', { token: u.token });
    const stats = await call('GET', '/v1/pokemon/inheritance/stats', { token: u.token });
    record('传承：传承记录与统计', recs.status === 200 && (!caught || recs.data.items.length === 1) && stats.status === 200 && stats.data.perfectInheritances >= (caught ? 1 : 0),
      `records=${recs.data && recs.data.items.length} stats=${JSON.stringify(stats.data)}`);
  }
}

const SECTIONS = { evolution: testEvolution, experience: testExperience, stamina: testStamina, tree: testEvolutionTree, bond: testBondSkills, camp: testTrainingCamp, special: testSpecialTraining, awakening: testAwakening, breeding: testBreeding, inheritance: testInheritance };

(async () => {
  const want = process.argv.slice(2);
  for (const [name, fn] of Object.entries(SECTIONS)) {
    if (want.length && !want.includes(name)) continue;
    console.log(`\n── ${name} ──`);
    try { await fn(); } catch (err) { record(`${name}：执行异常`, false, err.stack.split('\n').slice(0, 3).join(' | ')); }
  }
  await finish();
})();
