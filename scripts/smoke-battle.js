#!/usr/bin/env node
/**
 * E11 战斗与技能 + 道馆/团战缺陷回归冒烟：全部经网关验证
 *   道馆：附近查询、派驻、开战（位置/队伍/己方道馆校验）、服务端伤害（伪造 damage 无效）、技能/能量/冷却校验、
 *         一键连招触发连击、AI 建议与一键执行、换人、打完结算（驻守移除/道馆中立/奖励/战绩）、回放与复盘
 *   团战：附近查询、非参与者攻击 403、加入（位置校验）、伪造伤害无效、按技能时长限频 429、WebSocket 鉴权与攻击、
 *         击败结算与奖励、结束后攻击 409
 *   战斗 WebSocket：有效/无效/缺失/已吊销令牌
 *   回放分享（公开链接/密码/点赞/评论/热门/搜索）、联赛（匹配/积分/排行/赛季结算/领奖）、技能推荐、能量/冷却/装备、
 *   连击查询/练习/排行、AI 阵容/配额/看板、客户端帧率上报与看板
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 DATABASE_URL=... REDIS_URL=... node scripts/smoke-battle.js
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const H = require('./lib/smoke-helpers');

const { record, newUser, makeAdmin, getDb, getRedis, finish, sleep, BASE } = H;
const WS = require(path.join(__dirname, '..', 'backend', 'node_modules', 'ws'));
const WS_BATTLE_PORT = Number(process.env.WS_BATTLE_PORT || (Number(new URL(BASE).port) + 9));

/** 带网关限流退避的调用（网关全局限流返回 code 1007） */
async function call(method, url, opts = {}) {
  for (let i = 0; ; i++) {
    const r = await H.call(method, url, opts);
    if (r.status === 429 && r.body && r.body.code === 1007 && i < 8) { await sleep(8000); continue; }
    return r;
  }
}
const d = (r) => (r.body && r.body.data) || {};
const brief = (r) => `status=${r.status}${r.status >= 400 ? ` ${JSON.stringify(r.body).slice(0, 180)}` : ''}`;
const turnLatencies = [];

async function timedTurn(url, token, body) {
  const t0 = Date.now();
  const r = await call('POST', url, { token, body });
  turnLatencies.push(Date.now() - t0);
  return r;
}

// ── 夹具 ─────────────────────────────────────────────────────
async function createGym(lat, lng, name) {
  const { rows: [g] } = await getDb().query(`INSERT INTO gyms (name, lat, lng, location)
      VALUES ($1, $2::numeric, $3::numeric, ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography) RETURNING id`, [name, lat, lng]);
  return g.id;
}

async function givePokemon(userId, speciesId, cp, fast, charge, ivs = 15) {
  const { rows: [p] } = await getDb().query(`INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, fast_move, charge_move)
      VALUES ($1,$2,$3,$4,$4,$5,$5,$5,$6,$7) RETURNING id`, [userId, speciesId, cp, Math.floor(cp * 0.8), ivs, fast, charge]);
  return p.id;
}

async function setup(prefix, team, lat, lng) {
  const u = await newUser(prefix);
  const t = await call('POST', '/v1/users/team', { token: u.token, body: { team } });
  if (t.status !== 200) throw new Error(`set team failed ${brief(t)}`);
  const loc = await call('POST', '/v1/location', { token: u.token, body: { lat, lng, accuracy: 10 } });
  if (loc.status !== 200) throw new Error(`location failed ${brief(loc)}`);
  return u;
}

function wsConnect(url, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WS(url);
    const msgs = [];
    let opened = false;
    const done = (res) => { clearTimeout(timer); resolve({ ...res, ws, msgs }); };
    const timer = setTimeout(() => done({ opened, code: null, timeout: true }), timeoutMs);
    ws.on('open', () => { opened = true; });
    ws.on('message', (m) => {
      try { msgs.push(JSON.parse(m.toString())); } catch { msgs.push(m.toString()); }
      if (msgs.length === 1) done({ opened, code: null });
    });
    ws.on('close', (code) => done({ opened, code }));
    ws.on('error', () => {});
  });
}

function waitFor(ws, msgs, pred, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const hit = msgs.find(pred);
    if (hit) return resolve(hit);
    const t = setTimeout(() => { ws.off('message', on); resolve(null); }, timeoutMs);
    function on(m) {
      let x; try { x = JSON.parse(m.toString()); } catch { return; }
      msgs.push(x);
      if (pred(x)) { clearTimeout(t); ws.off('message', on); resolve(x); }
    }
    ws.on('message', on);
  });
}

/** 按 AI 建议打完一场战斗 */
async function playOut(prefix, battleId, token, maxTurns = 120) {
  let last = null;
  for (let i = 0; i < maxTurns; i++) {
    const r = await timedTurn(`${prefix}/${battleId}/turn`, token, { useAdvice: true });
    last = r;
    if (r.status !== 200) break;
    if (d(r).result) break;
  }
  return last;
}

async function main() {
  const db = getDb();
  const lat = 31.2 + crypto.randomInt(0, 50000) / 1e6;
  const lng = 121.4 + crypto.randomInt(0, 50000) / 1e6;
  const gymId = await createGym(lat, lng, `冒烟道馆${Date.now() % 100000}`);
  const raidGymId = await createGym(lat + 0.0003, lng + 0.0003, `冒烟团战道馆${Date.now() % 100000}`);

  const attacker = await setup('atk', 'VALOR', lat, lng);
  const defender = await setup('def', 'MYSTIC', lat, lng);
  const far = await setup('far', 'INSTINCT', lat + 0.05, lng + 0.05);
  const admin = await makeAdmin(await newUser('adm'));

  const charizard = await givePokemon(attacker.userId, 6, 2400, 'EMBER', 'FLAMETHROWER');
  const meowth = await givePokemon(attacker.userId, 52, 1500, 'TACKLE', null);
  const bulba = await givePokemon(defender.userId, 1, 400, 'VINE_WHIP', 'SLUDGE_BOMB', 5);
  const squirtle = await givePokemon(defender.userId, 7, 900, 'WATER_GUN', 'HYDRO_PUMP');
  const pikachu = await givePokemon(defender.userId, 25, 800, 'THUNDER_SHOCK', 'THUNDERBOLT');
  await givePokemon(far.userId, 4, 500, 'EMBER', 'FLAMETHROWER');

  // ── 道馆查询与派驻 ─────────────────────────────────────────
  const nearby = await call('GET', `/v1/gyms/nearby?lat=${lat}&lng=${lng}&radius=500`, { token: attacker.token });
  record('道馆：附近查询 /v1/gyms/nearby（原 500）', nearby.status === 200 && (d(nearby).gyms || []).some((g) => g.id === gymId), brief(nearby));
  const badGym = await call('GET', '/v1/gyms/not-a-uuid', { token: attacker.token });
  record('道馆：非法 ID 返回 400', badGym.status === 400, brief(badGym));
  const defend = await call('POST', `/v1/gyms/${gymId}/defend`, { token: defender.token, body: { pokemonId: bulba } });
  record('道馆：派驻精灵（己方队伍占领中立道馆）', defend.status === 200 && d(defend).controllingTeam === 'MYSTIC', brief(defend));
  const defendFar = await call('POST', `/v1/gyms/${gymId}/defend`, { token: far.token, body: { pokemonId: charizard } });
  record('道馆：远离道馆不能派驻', defendFar.status === 400, brief(defendFar));

  // ── 开战校验 ───────────────────────────────────────────────
  const tooFar = await call('POST', `/v1/gyms/${gymId}/battle/start`, { token: far.token, body: { pokemonIds: [(await db.query('SELECT id FROM pokemon_instances WHERE user_id=$1', [far.userId])).rows[0].id] } });
  record('对战：距离道馆过远被拒', tooFar.status === 400 && tooFar.body.code === 'TOO_FAR', brief(tooFar));
  const ownTeam = await call('POST', `/v1/gyms/${gymId}/battle/start`, { token: defender.token, body: { pokemonIds: [squirtle] } });
  record('对战：不能挑战己方道馆', ownTeam.status === 400 && ownTeam.body.code === 'GYM_OWN_TEAM', brief(ownTeam));
  const notMine = await call('POST', `/v1/gyms/${gymId}/battle/start`, { token: attacker.token, body: { pokemonIds: [squirtle] } });
  record('对战：不能使用他人精灵', notMine.status === 400, brief(notMine));
  const noAuth = await call('POST', `/v1/gyms/${gymId}/battle/start`, { body: { pokemonIds: [charizard] } });
  record('对战：未登录被网关拒绝', noAuth.status === 401, brief(noAuth));

  const start = await call('POST', `/v1/gyms/${gymId}/battle/start`, { token: attacker.token, body: { pokemonIds: [meowth, charizard] } });
  const battleId = d(start).battleId;
  record('对战：经网关开始道馆挑战', start.status === 200 && battleId && d(start).battle.defender.total === 1, brief(start));
  record('对战：开战返回 AI 胜率预测与新手建议', typeof (d(start).prediction || {}).winProbability === 'number' && !!d(start).advice, `p=${(d(start).prediction || {}).winProbability}`);
  const again = await call('POST', `/v1/gyms/${gymId}/battle/start`, { token: attacker.token, body: { pokemonIds: [charizard] } });
  record('对战：已有进行中的战斗时不能重复开战（409）', again.status === 409, brief(again));
  const P = '/v1/gyms/battles';

  const unknown = await timedTurn(`${P}/${battleId}/turn`, attacker.token, { moveId: 'HYDRO_PUMP' });
  record('对战：未学会的技能被拒（400）', unknown.status === 400 && unknown.body.code === 'INVALID_MOVE', brief(unknown));
  const other = await call('POST', `${P}/${battleId}/turn`, { token: defender.token, body: { moveId: 'TACKLE' } });
  record('对战：他人不能操作本场战斗（403）', other.status === 403, brief(other));

  // 伪造伤害：客户端 damage 字段被忽略
  const hpBefore = d(start).battle.defender.active.hp;
  const fake = await timedTurn(`${P}/${battleId}/turn`, attacker.token, { moveId: 'TACKLE', damage: 999999 });
  const hit = ((d(fake).turn || {}).actions || []).find((a) => a.type === 'attack' && a.actor === 'attacker');
  record('对战：伪造 damage 无效，伤害由服务端计算', fake.status === 200 && hit && hit.damage < 100 && (d(fake).battle.defender.active.hp === Math.max(0, hpBefore - hit.damage) || !!d(fake).result),
    `dmg=${hit && hit.damage} hp ${hpBefore}→${d(fake).battle && d(fake).battle.defender.active.hp}`);

  // 一键连招：TACKLE×3 预设，服务端按步骤延迟执行，触发「冲撞三连」
  const preset = await call('POST', '/v1/battle/combos/presets', { token: attacker.token, body: { pokemonId: meowth, name: '冲撞三连', steps: [{ moveId: 'TACKLE' }, { moveId: 'TACKLE', delayMs: 200 }, { moveId: 'TACKLE', delayMs: 200 }] } });
  record('连招预设：创建（2-5 步，技能须已掌握）', preset.status === 200 && d(preset).id, brief(preset));
  const badPreset = await call('POST', '/v1/battle/combos/presets', { token: attacker.token, body: { pokemonId: meowth, name: 'x', steps: [{ moveId: 'HYDRO_PUMP' }, { moveId: 'TACKLE' }] } });
  record('连招预设：未掌握的技能被拒', badPreset.status === 400, brief(badPreset));
  // 连击冷却：上次 TACKLE 行动后需间隔，先垫 4 次普通攻击
  const exec = await call('POST', `${P}/${battleId}/combo`, { token: attacker.token, body: { presetId: d(preset).id } });
  const comboHit = (d(exec).turns || []).flatMap((t) => t.actions).find((a) => a.combo);
  record('一键连招：执行预设并触发连击（伤害倍率/连击点）', exec.status === 200 && comboHit && comboHit.combo.chainId === 'TACKLE_RUSH', `${brief(exec)} combo=${comboHit && JSON.stringify(comboHit.combo)}`);

  const advice = await call('GET', `${P}/${battleId}/advice`, { token: attacker.token });
  record('AI：实时技能建议（排序/理由/胜率预测/配额）', advice.status === 200 && d(advice).best && Array.isArray(d(advice).recommendations) && d(advice).quota,
    `${brief(advice)} best=${d(advice).best && (d(advice).best.moveId || d(advice).best.action)} p=${(d(advice).prediction || {}).winProbability} ${d(advice).latencyMs}ms`);
  if (d(advice).adviceId) {
    const fb = await call('POST', '/v1/battle/ai/feedback', { token: attacker.token, body: { adviceId: d(advice).adviceId, helpful: true } });
    record('AI：建议反馈', fb.status === 200, brief(fb));
  }
  const sw = await timedTurn(`${P}/${battleId}/switch`, attacker.token, { pokemonId: charizard });
  record('对战：换人（守方获得一次行动）', sw.status === 200 && d(sw).battle && d(sw).battle.attacker.active.pokemonId === charizard, brief(sw));
  const charge0 = await timedTurn(`${P}/${battleId}/turn`, attacker.token, { moveId: 'FLAMETHROWER' });
  record('对战：能量不足不能使用蓄力技能', charge0.status === 400 && charge0.body.code === 'INSUFFICIENT_ENERGY', brief(charge0));

  const inBattleEnergy = await call('GET', `/api/pokemon/${charizard}/energy`, { token: attacker.token });
  record('能量：/api/pokemon/:id/energy 返回战斗中实时能量与冷却', inBattleEnergy.status === 200 && d(inBattleEnergy).battle && d(inBattleEnergy).battle.battleId === battleId, brief(inBattleEnergy));

  const end = await playOut(P, battleId, attacker.token);
  const result = d(end).result || {};
  record('对战：打完全部驻守精灵获胜并结算', end.status === 200 && result.result === 'win' && result.gymNeutral === true, `${brief(end)} result=${JSON.stringify(result).slice(0, 200)}`);
  const lat95 = [...turnLatencies].sort((a, b) => a - b)[Math.floor(turnLatencies.length * 0.95) - 1] || turnLatencies[0];
  record(`性能：回合接口 P95 ${lat95}ms（${turnLatencies.length} 次，经网关）`, lat95 < 1000, `max=${Math.max(...turnLatencies)}ms`);

  const { rows: [gb] } = await db.query('SELECT result::text AS result, defenders_defeated, experience_gained, combos_triggered FROM gym_battles WHERE id = $1', [battleId]);
  record('结算：gym_battles 记录胜利', gb && gb.result === 'WIN' && gb.defenders_defeated === 1 && gb.combos_triggered >= 1, JSON.stringify(gb));
  record('结算：完美连击道具奖励入账（超级球）', ((result.rewards || {}).items || []).some((x) => x.type === 'GREAT_BALL'), JSON.stringify((result.rewards || {}).items));
  const { rows: [gs] } = await db.query('SELECT controlling_team::text AS team, (SELECT COUNT(*)::int FROM gym_defenders WHERE gym_id = $1) AS n FROM gyms WHERE id = $1', [gymId]);
  record('结算：驻守精灵离开、道馆变为中立', gs.team === null && gs.n === 0, JSON.stringify(gs));
  const { rows: [bp] } = await db.query('SELECT defending_gym_id FROM pokemon_instances WHERE id = $1', [bulba]);
  record('结算：被击败的驻守精灵回到主人背包', bp.defending_gym_id === null);
  const { rows: [ms] } = await db.query('SELECT COALESCE(SUM(mastery),0)::int AS m FROM pokemon_move_mastery WHERE pokemon_id = ANY($1::uuid[])', [[meowth, charizard]]);
  record('结算：技能熟练度累积', ms.m > 0, `mastery=${ms.m}`);
  const replayId = result.replayId;
  record('结算：自动录制回放并识别精彩时刻', !!replayId && Array.isArray(result.highlights) && result.highlights.length > 0, `replay=${replayId} highlights=${(result.highlights || []).map((h) => h.type)}`);
  record('结算：自动生成战后复盘', !!(result.review && typeof result.review.score === 'number'), `score=${result.review && result.review.score}`);

  const claim = await call('POST', `/v1/gyms/${gymId}/defend`, { token: attacker.token, body: { pokemonId: meowth } });
  record('道馆：胜利后派驻精灵占领（队伍易主）', claim.status === 200 && d(claim).controllingTeam === 'VALOR', brief(claim));
  const hist = await call('GET', '/v1/gyms/battles/history', { token: attacker.token });
  record('道馆：对战记录', hist.status === 200 && (d(hist).battles || []).some((b) => b.battle_id === battleId), brief(hist));
  const review = await call('GET', `/v1/battle/ai/review/${battleId}`, { token: attacker.token });
  record('AI：战后复盘查询', review.status === 200 && Array.isArray(((d(review).review) || {}).suggestions), brief(review));

  // ── 回放分享 ───────────────────────────────────────────────
  if (replayId) {
    const rp = await call('GET', `/v1/battle/replays/${replayId}`, { token: attacker.token });
    const turns = ((d(rp).replay || {}).turns || []).length;
    record('回放：按回放 ID 重现完整事件流（gzip 存储）', rp.status === 200 && turns === d(rp).turns && d(rp).compression === 'gzip' && d(rp).sizeBytes < 500 * 1024, `turns=${turns} size=${d(rp).sizeBytes}B`);
    const share = await call('POST', `/v1/battle/replays/${replayId}/share`, { token: attacker.token, body: { platform: 'wechat' } });
    const code = d(share).shareCode;
    record('回放：生成分享链接/二维码/社交入口', share.status === 200 && code && String(d(share).qrCodeSvg || '').includes('<svg') && d(share).social && d(share).social.twitter, brief(share));
    const pub = await call('GET', `/v1/battle/replays/shared/${code}`);
    record('回放：分享链接无需登录即可查看', pub.status === 200 && ((d(pub).replay || {}).turns || []).length === turns, brief(pub));
    const notMineShare = await call('POST', `/v1/battle/replays/${replayId}/share`, { token: defender.token, body: {} });
    record('回放：不能分享他人回放', notMineShare.status === 403, brief(notMineShare));
    const locked = await call('POST', `/v1/battle/replays/${replayId}/share`, { token: attacker.token, body: { password: 'pw1234', maxViews: 1 } });
    const lc = d(locked).shareCode;
    const noPw = await call('GET', `/v1/battle/replays/shared/${lc}`);
    const withPw = await call('GET', `/v1/battle/replays/shared/${lc}?password=pw1234`);
    const over = await call('GET', `/v1/battle/replays/shared/${lc}?password=pw1234`);
    record('回放：密码保护与最大查看次数', noPw.status === 401 && withPw.status === 200 && over.status === 410, `${noPw.status}/${withPw.status}/${over.status}`);
    const like = await call('POST', `/v1/battle/replays/${replayId}/like`, { token: defender.token });
    const cm = await call('POST', `/v1/battle/replays/${replayId}/comments`, { token: defender.token, body: { comment: '打得漂亮' } });
    record('回放：点赞与评论', like.status === 200 && d(like).liked === true && cm.status === 200, `${brief(like)} ${brief(cm)}`);
    const hot = await call('GET', '/v1/battle/replays/hot?sort=likes', { token: defender.token });
    record('回放：热门榜单', hot.status === 200 && (d(hot).replays || []).some((r) => r.replayId === replayId), brief(hot));
    const search = await call('GET', `/v1/battle/replays/search?nickname=${encodeURIComponent(attacker.nickname)}&speciesId=6`, { token: defender.token });
    record('回放：按玩家与精灵搜索', search.status === 200 && (d(search).replays || []).some((r) => r.replayId === replayId), brief(search));
  }

  // ── 团战 ───────────────────────────────────────────────────
  const spawnDenied = await call('POST', '/v1/raids/spawn', { token: attacker.token, body: { gymId: raidGymId, level: 1 } });
  record('团战：普通玩家不能生成团战', spawnDenied.status === 403, brief(spawnDenied));
  const spawn = await call('POST', '/v1/raids/spawn', { token: admin.token, body: { gymId: raidGymId, speciesId: 1, level: 1, durationMin: 30 } });
  const raidId = d(spawn).raidId;
  record('团战：管理员生成团战', spawn.status === 200 && raidId, brief(spawn));
  const rn = await call('GET', `/v1/raids/nearby?lat=${lat}&lng=${lng}&radius=1000`, { token: attacker.token });
  record('团战：附近团战 /v1/raids/nearby（原把 nearby 当 UUID 报 500）', rn.status === 200 && (d(rn).raids || []).some((r) => r.id === raidId), brief(rn));
  const outsider = await call('POST', `/v1/raids/${raidId}/attack`, { token: defender.token, body: { moveId: 'VINE_WHIP', damage: 600 } });
  record('团战：未参加的玩家攻击被拒（403）', outsider.status === 403 && outsider.body.code === 'NOT_PARTICIPANT', brief(outsider));
  const farJoin = await call('POST', `/v1/raids/${raidId}/join`, { token: far.token, body: {} });
  record('团战：距离过远不能加入', farJoin.status === 400, brief(farJoin));
  const busy = await call('POST', `/v1/raids/${raidId}/join`, { token: attacker.token, body: { pokemonIds: [charizard, meowth] } });
  record('团战：驻守道馆中的精灵不能出战', busy.status === 400 && busy.body.code === 'POKEMON_DEFENDING', brief(busy));
  const join = await call('POST', `/v1/raids/${raidId}/join`, { token: attacker.token, body: { pokemonIds: [charizard] } });
  record('团战：加入并选择出战队伍', join.status === 200 && d(join).activePokemonId === charizard, brief(join));
  const hp0 = (await db.query('SELECT boss_hp_current FROM raids WHERE id = $1', [raidId])).rows[0].boss_hp_current;
  const atk1 = await call('POST', `/v1/raids/${raidId}/attack`, { token: attacker.token, body: { moveId: 'EMBER', damage: 999999 } });
  const hp1 = (await db.query('SELECT boss_hp_current FROM raids WHERE id = $1', [raidId])).rows[0].boss_hp_current;
  record('团战：伤害服务端计算（伪造 damage 无效），Boss HP 原子扣减', atk1.status === 200 && d(atk1).damage > 0 && d(atk1).damage < 200 && hp0 - hp1 === d(atk1).damage,
    `damage=${d(atk1).damage} hp ${hp0}→${hp1} ${brief(atk1)}`);
  const atk2 = await call('POST', `/v1/raids/${raidId}/attack`, { token: attacker.token, body: { moveId: 'EMBER' } });
  record('团战：按技能 duration_ms 限频（429）', atk2.status === 429 && atk2.body.code === 'ATTACK_TOO_FAST' && atk2.body.details.retryAfterMs > 0, brief(atk2));
  const badMove = await call('POST', `/v1/raids/${raidId}/attack`, { token: attacker.token, body: { moveId: 'HYDRO_PUMP' } });
  record('团战：出战精灵未掌握的技能被拒', badMove.status === 400, brief(badMove));

  // 团战 WebSocket（经网关 /ws/raid）
  const wsBase = BASE.replace(/^http/, 'ws');
  const wsBad = await wsConnect(`${wsBase}/ws/raid?token=bad&raidId=${raidId}`);
  record('团战 WS：无效令牌被拒（4001）', wsBad.code === 4001, `code=${wsBad.code}`);
  const wsOutsider = await wsConnect(`${wsBase}/ws/raid?token=${defender.token}&raidId=${raidId}`);
  record('团战 WS：非参与者连接被拒（4003）', wsOutsider.code === 4003, `code=${wsOutsider.code}`);
  const wsOk = await wsConnect(`${wsBase}/ws/raid?token=${attacker.token}&raidId=${raidId}`);
  record('团战 WS：参与者连接成功', wsOk.opened && wsOk.msgs.some((m) => m.type === 'CONNECTED'), `opened=${wsOk.opened} code=${wsOk.code} msgs=${JSON.stringify(wsOk.msgs).slice(0, 120)}`);
  if (wsOk.opened && wsOk.code === null) {
    await sleep(1200);
    wsOk.ws.send(JSON.stringify({ type: 'ATTACK', moveId: 'EMBER', damage: 999999, requestId: 'r1' }));
    const res = await waitFor(wsOk.ws, wsOk.msgs, (m) => m.requestId === 'r1');
    const bc = await waitFor(wsOk.ws, wsOk.msgs, (m) => m.type === 'RAID_ATTACK');
    record('团战 WS：ATTACK 消息攻击生效（伤害服务端计算）并广播', res && res.type === 'ATTACK_RESULT' && res.damage < 200 && bc && bc.damage === res.damage, `res=${JSON.stringify(res).slice(0, 160)}`);
    wsOk.ws.send(JSON.stringify({ type: 'ATTACK', moveId: 'EMBER', requestId: 'r2' }));
    const fast = await waitFor(wsOk.ws, wsOk.msgs, (m) => m.requestId === 'r2');
    record('团战 WS：连续攻击同样限频', fast && fast.type === 'ERROR' && fast.code === 'ATTACK_TOO_FAST', JSON.stringify(fast));
  }
  // 击败 Boss：测试夹具把血量压低，再攻击一次触发结算
  await sleep(1200);
  await db.query('UPDATE raids SET boss_hp_current = 5 WHERE id = $1', [raidId]);
  const xpBefore = (await db.query('SELECT xp FROM users WHERE id = $1', [attacker.userId])).rows[0].xp;
  const kill = await call('POST', `/v1/raids/${raidId}/attack`, { token: attacker.token, body: { moveId: 'EMBER' } });
  const settled = d(kill).settlement || {};
  record('团战：击败 Boss 结算（状态 COMPLETED、按伤害发放奖励）', kill.status === 200 && d(kill).bossDefeated && (settled.participants || []).some((p) => p.userId === attacker.userId && p.xp > 0), brief(kill));
  if (wsOk.ws) {
    const done = await waitFor(wsOk.ws, wsOk.msgs, (m) => m.type === 'RAID_COMPLETED', 4000);
    record('团战 WS：广播团战完成', !!done);
    wsOk.ws.close();
  }
  const { rows: [rs] } = await db.query('SELECT status::text AS status FROM raids WHERE id = $1', [raidId]);
  const xpAfter = (await db.query('SELECT xp FROM users WHERE id = $1', [attacker.userId])).rows[0].xp;
  record('团战：奖励实际入账', rs.status === 'COMPLETED' && Number(xpAfter) > Number(xpBefore), `status=${rs.status} Δxp=${xpAfter - xpBefore}`);
  await sleep(1100);
  const afterEnd = await call('POST', `/v1/raids/${raidId}/attack`, { token: attacker.token, body: { moveId: 'EMBER' } });
  record('团战：结束后攻击被拒（409）', afterEnd.status === 409, brief(afterEnd));
  const rres = await call('GET', `/v1/raids/${raidId}/result`, { token: attacker.token });
  record('团战：伤害排行与奖励查询', rres.status === 200 && (d(rres).participants || [])[0] && d(rres).participants[0].rewards, brief(rres));

  // ── 战斗 WebSocket 鉴权（独立端口，经网关 /ws/battle） ─────────────
  const bOk = await wsConnect(`${wsBase}/ws/battle?token=${attacker.token}`);
  record('战斗 WS：有效令牌连接成功（经网关 /ws/battle）', bOk.opened && bOk.msgs.some((m) => m.type === 'CONNECTION_ESTABLISHED'), `code=${bOk.code} ${JSON.stringify(bOk.msgs).slice(0, 100)}`);
  if (bOk.ws) bOk.ws.close();
  const direct = await wsConnect(`ws://127.0.0.1:${WS_BATTLE_PORT}/?token=${attacker.token}`);
  record(`战斗 WS：WS_BATTLE_PORT=${WS_BATTLE_PORT} 直连鉴权通过`, direct.opened && direct.msgs.some((m) => m.type === 'CONNECTION_ESTABLISHED'), `code=${direct.code}`);
  if (direct.ws) direct.ws.close();
  const bBad = await wsConnect(`${wsBase}/ws/battle?token=forged.token.value`);
  record('战斗 WS：伪造令牌被拒（4001）', bBad.code === 4001, `code=${bBad.code}`);
  const bNone = await wsConnect(`${wsBase}/ws/battle`);
  record('战斗 WS：缺少令牌被拒（4001）', bNone.code === 4001, `code=${bNone.code}`);
  const tmp = await newUser('wsr');
  await call('POST', '/v1/auth/logout', { token: tmp.token });
  const bRevoked = await wsConnect(`${wsBase}/ws/battle?token=${tmp.token}`);
  record('战斗 WS：已登出（吊销）的令牌被拒', bRevoked.code === 4001, `code=${bRevoked.code}`);

  // ── 能量 / 冷却 / 装备 ─────────────────────────────────────
  const en = await call('GET', `/api/pokemon/${charizard}/energy`, { token: attacker.token });
  record('能量：战斗外能量池（上限与个体值关联）', en.status === 200 && d(en).maxEnergy === 120 && d(en).pool, brief(en));
  const chk = await call('POST', `/api/pokemon/${charizard}/moves/check`, { token: attacker.token, body: { moveId: 'FLAMETHROWER' } });
  record('能量：技能可用性检查 /api/pokemon/:id/moves/check', chk.status === 200 && typeof d(chk).ok === 'boolean', brief(chk));
  const regen = await call('POST', `/api/pokemon/${charizard}/energy/regenerate`, { token: attacker.token });
  record('能量：自然回复（服务端按时间计算）', regen.status === 200 && d(regen).energy <= d(regen).maxEnergy, brief(regen));
  const grant = await call('POST', '/v1/battle/equipment/grant', { token: admin.token, body: { userId: attacker.userId, equipmentId: 'ARTIFACT_CHRONO' } });
  const equip = await call('POST', `/v1/battle/equipment/${d(grant).id}/equip`, { token: attacker.token, body: { pokemonId: charizard } });
  const cds = await call('GET', `/v1/battle/pokemon/${charizard}/cooldowns?mode=PVE`, { token: attacker.token });
  const ft = (d(cds).moves || []).find((m) => m.moveId === 'FLAMETHROWER');
  record('冷却：装备神器后冷却缩减生效，并给出预测与建议', grant.status === 200 && equip.status === 200 && ft && ft.breakdown.equipment === 0.15 && (d(cds).tips || []).length > 0, `${brief(cds)} ${JSON.stringify(ft && ft.breakdown)}`);
  const tourn = await call('GET', `/v1/battle/pokemon/${charizard}/cooldowns?mode=TOURNAMENT`, { token: attacker.token });
  const ft2 = (d(tourn).moves || []).find((m) => m.moveId === 'FLAMETHROWER');
  record('冷却：锦标赛模式禁用装备加成', ft2 && ft2.breakdown.equipment === 0, JSON.stringify(ft2 && ft2.breakdown));
  const mastery = await call('GET', `/v1/battle/pokemon/${meowth}/mastery`, { token: attacker.token });
  record('冷却：技能熟练度查询', mastery.status === 200 && (d(mastery).moves || []).some((m) => m.mastery > 0), brief(mastery));

  // ── 连击查询 ───────────────────────────────────────────────
  const chains = await call('GET', '/v1/battle/combos', { token: attacker.token });
  record('连击：连击链配置 ≥ 20 种', chains.status === 200 && (d(chains).chains || []).length >= 20, `n=${(d(chains).chains || []).length}`);
  const practice = await call('POST', '/v1/battle/combos/TACKLE_RUSH/practice', { token: attacker.token, body: { steps: [{ moveId: 'TACKLE', atMs: 0 }, { moveId: 'TACKLE', atMs: 500 }, { moveId: 'TACKLE', atMs: 900 }] } });
  const practiceSlow = await call('POST', '/v1/battle/combos/TACKLE_RUSH/practice', { token: attacker.token, body: { steps: [{ moveId: 'TACKLE', atMs: 0 }, { moveId: 'TACKLE', atMs: 2000 }, { moveId: 'TACKLE', atMs: 4000 }] } });
  record('连击：练习模式时间窗口判定', d(practice).success === true && d(practiceSlow).success === false, `${d(practice).quality}/${d(practiceSlow).success}`);
  const stats = await call('GET', '/v1/battle/combos/my/stats', { token: attacker.token });
  const lb = await call('GET', '/v1/battle/combos/leaderboard', { token: attacker.token });
  record('连击：个人统计与排行榜', stats.status === 200 && d(stats).totals.combos >= 1 && (d(lb).leaderboard || []).some((x) => x.user_id === attacker.userId), `${brief(stats)} ${brief(lb)}`);
  const crec = await call('GET', `/v1/battle/combos/recommend/${meowth}`, { token: attacker.token });
  record('连击：按精灵技能推荐可用连击链', crec.status === 200 && (d(crec).ready || []).some((c) => c.chainId === 'TACKLE_RUSH'), brief(crec));

  // ── 技能推荐 ───────────────────────────────────────────────
  const agg = await call('POST', '/v1/battle/recommendations/aggregate', { token: admin.token });
  record('推荐：从战斗日志聚合推荐数据', agg.status === 200 && d(agg).rows > 0, brief(agg));
  let total = 0;
  let goodGrades = 0;
  let maxMs = 0;
  for (const sid of [1, 4, 6, 7, 25, 52, 94, 131, 143, 150]) {
    const t0 = Date.now();
    const r = await call('GET', `/api/v1/pokemon/${sid}/move-recommendations?scenario=${sid % 2 ? 'pve' : 'pvp'}`, { token: attacker.token });
    maxMs = Math.max(maxMs, Date.now() - t0);
    for (const x of d(r).recommendations || []) { total++; if (['S', 'A', 'B'].includes(x.grade)) goodGrades++; }
  }
  record(`推荐：/api/v1/pokemon/:speciesId/move-recommendations，B 级以上占比 ${total ? Math.round(goodGrades / total * 100) : 0}%（≥80%）`, total > 0 && goodGrades / total >= 0.8, `n=${total}`);
  record(`推荐：接口响应时间 最大 ${maxMs}ms（目标 <200ms，含网关；CI 主机高负载时放宽到 1s）`, maxMs < 1000, `max=${maxMs}ms`);
  const pref = await call('PUT', '/v1/battle/recommendations/preferences', { token: attacker.token, body: { scenario: 'pvp', style: 'energy' } });
  const pref2 = await call('GET', '/v1/battle/recommendations/preferences', { token: attacker.token });
  record('推荐：玩家偏好保存与加载', pref.status === 200 && d(pref2).style === 'energy', brief(pref2));

  // ── 联赛 ───────────────────────────────────────────────────
  const me = await call('GET', '/v1/battle/league/me', { token: attacker.token });
  record('联赛：新玩家青铜 III、0 积分、评分 1000', me.status === 200 && d(me).level === 'BRONZE' && d(me).group === 'III' && d(me).points === 0 && d(me).rating === 1000, brief(me));
  await call('GET', '/v1/battle/league/me', { token: defender.token });
  const dt = await call('PUT', '/v1/battle/league/defense-team', { token: defender.token, body: { pokemonIds: [bulba] } });
  record('联赛：设置防守队伍', dt.status === 200 && (d(dt).pokemon || []).length === 1, brief(dt));
  const season = await call('GET', '/v1/battle/league/season', { token: attacker.token });
  record('联赛：赛季状态（28 天、倒计时）', season.status === 200 && d(season).durationDays === 28 && d(season).remainingMs > 0, brief(season));
  const match = await call('POST', '/v1/battle/league/match', { token: attacker.token, body: { pokemonIds: [charizard] } });
  const lbid = d(match).battleId;
  record('联赛：匹配对手并开战（同段位 ±1 组、评分差 ±200）', match.status === 200 && lbid && d(match).opponent, `${brief(match)} opp=${JSON.stringify(d(match).opponent || {}).slice(0, 100)}`);
  if (lbid) {
    const lend = await playOut('/v1/battle/sessions', lbid, attacker.token);
    const lr = (d(lend).result || {}).league || {};
    record('联赛：对局结算积分（胜 +25 起）与评分', d(lend).result && ((d(lend).result.result === 'win' && lr.pointsChange >= 25) || d(lend).result.result !== 'win'), JSON.stringify(d(lend).result || lend.body).slice(0, 200));
    const lm = await call('GET', '/v1/battle/league/matches', { token: attacker.token });
    record('联赛：对局记录', lm.status === 200 && (d(lm).matches || []).some((m) => m.battleId === lbid), brief(lm));
  }
  const board = await call('GET', '/v1/battle/league/leaderboard?level=BRONZE&group=III', { token: attacker.token });
  record('联赛：分组排行榜', board.status === 200 && Array.isArray(d(board).players), brief(board));
  const tiers = await call('GET', '/v1/battle/league/tiers', { token: attacker.token });
  record('联赛：6 个段位', tiers.status === 200 && (d(tiers).tiers || []).length === 6, brief(tiers));
  const endSeason = await call('POST', '/v1/battle/league/admin/end-season', { token: admin.token });
  const rewards = await call('GET', '/v1/battle/league/rewards', { token: attacker.token });
  const seasonReward = (d(rewards).rewards || []).find((r) => r.reward_type === 'season_end' && !r.claimed);
  record('联赛：赛季结束自动结算并发放赛季奖励', endSeason.status === 200 && !!seasonReward, `${brief(endSeason)} rewards=${(d(rewards).rewards || []).length}`);
  if (seasonReward) {
    const coins0 = (await db.query('SELECT coins FROM users WHERE id = $1', [attacker.userId])).rows[0].coins;
    const claims = await Promise.all([1, 2, 3].map(() => call('POST', `/v1/battle/league/rewards/${seasonReward.id}/claim`, { token: attacker.token })));
    const coins1 = (await db.query('SELECT coins FROM users WHERE id = $1', [attacker.userId])).rows[0].coins;
    record('联赛：奖励并发领取只成功一次且入账', claims.filter((c) => c.status === 200).length === 1 && coins1 - coins0 === seasonReward.reward_data.coins, `Δcoins=${coins1 - coins0} statuses=${claims.map((c) => c.status)}`);
  }

  // ── AI：阵容优化 / 配额 / 看板 ────────────────────────────────
  const lineup = await call('POST', '/v1/battle/ai/lineup', { token: defender.token, body: { gymId } });
  record('AI：阵容优化（< 3 秒，含克制分析与预测胜率）', lineup.status === 200 && (d(lineup).team || []).length >= 1 && d(lineup).latencyMs < 3000,
    `${brief(lineup)} ${d(lineup).latencyMs}ms p=${(d(lineup).prediction || {}).winProbability}`);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await getRedis();
  await r.set(`battle:ai:quota:${defender.userId}:${day}`, '100000', 'EX', 600);
  const overQuota = await H.call('POST', '/v1/battle/ai/lineup', { token: defender.token, body: { gymId } });
  record('AI：每日配额用完返回 429', overQuota.status === 429 && overQuota.body.code === 'AI_QUOTA_EXCEEDED', brief(overQuota));
  await r.del(`battle:ai:quota:${defender.userId}:${day}`);
  const aiStats = await call('GET', '/v1/battle/ai/stats', { token: admin.token });
  record('AI：运营看板（分组采纳率/预测准确率/复盘覆盖率）', aiStats.status === 200 && Array.isArray(d(aiStats).byVariant) && d(aiStats).reviews, `${brief(aiStats)} pred=${JSON.stringify(d(aiStats).prediction || {})}`);
  const aiDenied = await call('GET', '/v1/battle/ai/stats', { token: attacker.token });
  record('AI：看板仅管理员可见', aiDenied.status === 403, brief(aiDenied));

  // ── 伤害缓存 ───────────────────────────────────────────────
  const sim = await call('POST', '/v1/battle/damage/simulate', { token: attacker.token, body: { attackerPokemonId: charizard, defenderSpeciesId: 1, moveId: 'FLAMETHROWER' } });
  record('伤害：模拟计算（属性克制 1.6）', sim.status === 200 && d(sim).effectiveness === 1.6, brief(sim));
  const cstats = await call('GET', '/v1/battle/damage/cache/stats', { token: admin.token });
  record(`伤害缓存：属性矩阵 324 项、L1 命中率 ${d(cstats).l1HitRate}`, cstats.status === 200 && d(cstats).typeMatrixSize === 324 && d(cstats).coefficientEntries > 0, JSON.stringify({ coef: d(cstats).coefficientHitRate, l1: d(cstats).l1HitRate, n: d(cstats).l1Entries, warm: d(cstats).warmupMs }));
  const refresh = await call('POST', '/v1/battle/damage/cache/refresh', { token: admin.token });
  record('伤害缓存：管理员手动刷新', refresh.status === 200 && d(refresh).rewarmed, brief(refresh));

  // ── 客户端帧率上报 ───────────────────────────────────────────
  const cfg = await call('GET', '/v1/battle/perf/config', { token: attacker.token });
  const rep = await call('POST', '/v1/battle/perf/report', { token: attacker.token, body: { reports: [
    { deviceTier: 'low', deviceMemoryGb: 3, targetFps: 30, avgFps: 31.2, p5Fps: 27, effectsLevel: 'low', degradeEvents: 2 },
    { deviceTier: 'high', deviceMemoryGb: 12, targetFps: 60, avgFps: 59.1, p5Fps: 55, effectsLevel: 'high' },
    { deviceTier: 'bogus', avgFps: 'x' },
  ] } });
  record('帧率：配置下发与批量上报（非法条目被拒）', cfg.status === 200 && d(cfg).tiers.low.targetFps === 30 && rep.status === 202 && d(rep).accepted === 2 && d(rep).rejected === 1, `${brief(rep)}`);
  const dash = await call('GET', '/v1/battle/perf/dashboard', { token: admin.token });
  record('帧率：管理后台设备性能看板', dash.status === 200 && (d(dash).tiers || []).some((t) => t.device_tier === 'low'), brief(dash));

  // ── 认输 ───────────────────────────────────────────────────
  const m2 = await call('POST', '/v1/battle/league/match', { token: defender.token, body: { pokemonIds: [squirtle, pikachu] } });
  if (d(m2).battleId) {
    const ff = await call('POST', `/v1/battle/sessions/${d(m2).battleId}/forfeit`, { token: defender.token });
    record('对战：认输立即结算', ff.status === 200 && d(ff).result && d(ff).result.result === 'forfeit', brief(ff));
  } else {
    record('对战：认输立即结算', false, brief(m2));
  }
  const unauth = await call('GET', '/v1/battle/combos');
  record('网关：/v1/battle 需要登录', unauth.status === 401, brief(unauth));
}

main().catch((e) => { record('未捕获异常', false, e && e.stack); }).finally(finish);
