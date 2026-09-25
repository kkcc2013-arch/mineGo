/**
 * E02 + E34 纯逻辑单测（不依赖数据库/Redis/第三方包，宿主机可直接运行）：
 *   node --test tests/unit/squad-guild-core.test.js
 * 覆盖：公会权限/等级/输入校验、小队加入规则/语音模式选择/贡献与奖励分配、TURN 凭证、MOS 估算、信令协议校验与节流。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const G = require('../../services/social-service/src/guild/guildRules');
const S = require('../../services/social-service/src/squad/squadRules');
const T = require('../../services/social-service/src/squad/turnCredentials');
const Q = require('../../services/social-service/src/squad/voiceQuality');
const SIG = require('../../services/social-service/src/squad/signaling');

// ── 公会 ────────────────────────────────────────────────────────
test('guild: 职位权限与踢人/任命规则', () => {
  assert.equal(G.can('member', 'chat'), true);
  assert.equal(G.can('member', 'invite'), false);
  assert.equal(G.can('elder', 'review_applications'), true);
  assert.equal(G.can('elder', 'kick'), false);
  assert.equal(G.can('co_leader', 'announce'), true);
  assert.equal(G.can('co_leader', 'disband'), false);
  assert.equal(G.can('leader', 'transfer'), true);
  assert.equal(G.can('novice', 'donate'), true, '旧数据 novice 视同 member');
  assert.throws(() => G.can('leader', 'fly'));

  assert.equal(G.canKick('co_leader', 'elder'), true);
  assert.equal(G.canKick('co_leader', 'co_leader'), false, '不能踢同级');
  assert.equal(G.canKick('leader', 'co_leader'), true);
  assert.equal(G.canKick('elder', 'member'), false, '长老无踢人权限');

  assert.equal(G.canSetRole('leader', 'member', 'co_leader'), true, '只有会长能任命副会长');
  assert.equal(G.canSetRole('co_leader', 'member', 'co_leader'), false);
  assert.equal(G.canSetRole('co_leader', 'member', 'elder'), true);
  assert.equal(G.canSetRole('co_leader', 'elder', 'member'), true);
  assert.equal(G.canSetRole('co_leader', 'co_leader', 'member'), false);
  assert.equal(G.canSetRole('leader', 'member', 'leader'), false, '会长只能通过转让变更');
  assert.equal(G.dailyClaimLimit('member'), 3);
  assert.equal(G.dailyClaimLimit('elder'), 10);
});

test('guild: 等级曲线、成员上限与增益解锁', () => {
  assert.equal(G.levelForExperience(0), 1);
  assert.equal(G.levelForExperience(999), 1);
  assert.equal(G.levelForExperience(1000), 2);
  assert.equal(G.levelForExperience(2999), 2);
  assert.equal(G.levelForExperience(3000), 3);
  assert.equal(G.levelForExperience(45000), 10);
  assert.equal(G.levelForExperience(1e12), 50);
  assert.equal(G.levelForExperience(-5), 1);
  for (let l = 1; l <= 50; l++) assert.equal(G.levelForExperience(G.experienceForLevel(l)), l);
  assert.equal(G.maxMembersForLevel(1), 50);
  assert.equal(G.maxMembersForLevel(10), 68);
  const p = G.levelProgress(2000);
  assert.deepEqual([p.level, p.current, p.next, p.progress], [2, 1000, 3000, 0.5]);
  assert.equal(G.levelProgress(G.experienceForLevel(50)).next, null);
  assert.deepEqual(G.availableBuffs(4), []);
  assert.deepEqual(G.availableBuffs(12).map((b) => b.type), ['catch_bonus', 'xp_bonus']);
  assert.equal(G.contributionForCoins(99), 9);
});

test('guild: 输入校验、聊天清洗、邀请码与每周窗口', () => {
  const ok = G.validateGuildInput({ name: '  星火‮  ', joinType: 'public', minLevel: 3, badgeIcon: '⚡', description: 'hi\u0000' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { name: '星火', joinType: 'public', minLevel: 3, badgeIcon: '⚡', description: 'hi' });
  assert.ok(G.validateGuildInput({ name: 'x' }).errors.length);
  assert.ok(G.validateGuildInput({ name: 'abc', joinType: 'secret' }).errors.length);
  assert.ok(G.validateGuildInput({ name: 'abc', minLevel: 0 }).errors.length);
  assert.ok(G.validateGuildInput({ name: 'abc', badgeIcon: '💩' }).errors.length);
  assert.equal(G.validateGuildInput({ name: 'abc' }).value.badgeIcon, G.BADGE_ICONS[0]);
  assert.deepEqual(G.validateGuildInput({}, { partial: true }).errors, ['没有可更新的设置项']);
  assert.deepEqual(G.validateGuildInput({ description: '新简介' }, { partial: true }).value, { description: '新简介' });

  assert.equal(G.sanitizeChat('  你好\n\n世界  '), '你好 世界');
  assert.equal(G.sanitizeChat('   '), null);
  assert.equal(G.sanitizeChat(42), null);
  assert.equal(G.sanitizeChat('a'.repeat(500)).length, 300);
  assert.equal(G.normalizeInviteCode(' ab12cd '), 'AB12CD');
  assert.equal(G.normalizeInviteCode('ab-12'), null);

  assert.equal(G.weekStart(new Date('2026-09-25T10:00:00Z')), '2026-09-21', '周五 → 本周一');
  assert.equal(G.weekStart(new Date('2026-09-21T00:00:00Z')), '2026-09-21');
  assert.equal(G.weekStart(new Date('2026-09-27T23:59:59Z')), '2026-09-21', '周日仍属本周');
  const tasks = G.weeklyTaskInstances(5, new Date('2026-09-25T10:00:00Z'));
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].startsAt.toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(tasks[0].endsAt.toISOString(), '2026-09-28T00:00:00.000Z');
  assert.equal(tasks.find((t) => t.taskKey === 'weekly_catch').target, 280);
  assert.equal(G.memberTitle('co_leader', '星火'), '〈星火〉副会长');
});

// ── 小队 ────────────────────────────────────────────────────────
test('squad: 输入校验与默认容量', () => {
  const v = S.validateSquadInput({ name: 'Raid 冲冲冲', squadType: 'raid' });
  assert.deepEqual(v.errors, []);
  assert.equal(v.value.maxMembers, 20, 'raid 默认 20 人');
  assert.equal(S.validateSquadInput({}).value.maxMembers, 5);
  assert.ok(S.validateSquadInput({ maxMembers: 21 }).errors.length);
  assert.ok(S.validateSquadInput({ maxMembers: 1 }).errors.length);
  assert.ok(S.validateSquadInput({ squadType: 'pvp' }).errors.length);
  assert.ok(S.validateSquadInput({ joinPolicy: 'anyone' }).errors.length);
  assert.ok(S.validateSquadInput({ name: '' }).errors.length);
  assert.deepEqual(S.validateSquadInput({ maxMembers: 10 }, { partial: true }).value, { maxMembers: 10 });
});

test('squad: 加入规则（满员/拉黑/策略/邀请/小队码）', () => {
  const squad = { status: 'active', max_members: 3, join_policy: 'invite', guild_id: 7 };
  const base = { squad, memberCount: 1 };
  assert.equal(S.canJoin({ ...base }).code, 'INVITE_REQUIRED');
  assert.equal(S.canJoin({ ...base, hasInvite: true }).ok, true);
  assert.equal(S.canJoin({ ...base, viaCode: true }).ok, true);
  assert.equal(S.canJoin({ ...base, viaCode: true, blocked: true }).code, 'BLOCKED');
  assert.equal(S.canJoin({ ...base, memberCount: 3, hasInvite: true }).code, 'SQUAD_FULL');
  assert.equal(S.canJoin({ ...base, inOtherSquad: true, hasInvite: true }).code, 'IN_OTHER_SQUAD');
  assert.equal(S.canJoin({ ...base, alreadyInThisSquad: true }).code, 'ALREADY_MEMBER');
  assert.equal(S.canJoin({ squad: { ...squad, status: 'disbanded' }, memberCount: 0, hasInvite: true }).code, 'SQUAD_NOT_FOUND');
  assert.equal(S.canJoin({ squad: { ...squad, join_policy: 'open' }, memberCount: 1 }).ok, true);
  assert.equal(S.canJoin({ squad: { ...squad, join_policy: 'friends' }, memberCount: 1 }).ok, false);
  assert.equal(S.canJoin({ squad: { ...squad, join_policy: 'friends' }, memberCount: 1, isFriendOfMember: true }).ok, true);
  assert.equal(S.canJoin({ squad: { ...squad, join_policy: 'guild' }, memberCount: 1, sameGuild: true }).ok, true);
  assert.equal(S.canJoin({ squad: { ...squad, join_policy: 'guild' }, memberCount: 1 }).ok, false);
});

test('squad: 权限、继任者', () => {
  assert.equal(S.canAct('member', 'invite'), true);
  assert.equal(S.canAct('member', 'kick'), false);
  assert.equal(S.canAct('leader', 'kick'), true);
  assert.equal(S.canAct('member', 'raid_call'), false);
  assert.equal(S.canAct('member', 'share_location'), true);
  assert.throws(() => S.canAct('leader', 'nuke'));
  const members = [
    { user_id: 'L', joined_at: '2026-09-25T10:00:00Z' },
    { user_id: 'b', joined_at: '2026-09-25T10:05:00Z' },
    { user_id: 'a', joined_at: '2026-09-25T10:02:00Z' },
  ];
  assert.equal(S.nextLeader(members, 'L'), 'a');
  assert.equal(S.nextLeader([{ user_id: 'L', joined_at: 0 }], 'L'), null);
});

test('squad: 语音模式选择（>5 人 floor，滞回到 ≤4 人才回 mesh）', () => {
  assert.equal(S.selectVoiceMode(2), 'mesh');
  assert.equal(S.selectVoiceMode(5), 'mesh');
  assert.equal(S.selectVoiceMode(6), 'floor');
  assert.equal(S.selectVoiceMode(20), 'floor');
  assert.equal(S.selectVoiceMode(5, 'floor'), 'floor', '5 人时保持 floor（滞回）');
  assert.equal(S.selectVoiceMode(4, 'floor'), 'mesh');
  assert.equal(S.selectVoiceMode(5, 'mesh'), 'mesh');
  assert.equal(S.selectVoiceMode(0), 'mesh');
});

test('squad: 贡献得分、奖励分配（比例和为 1、队长加成、MVP）与奖励池拆分', () => {
  assert.equal(S.contributionScore({ damage: 1234, healing: 55, catches: 2, holdSeconds: 600 }), 123 + 5 + 100 + 50);
  assert.equal(S.contributionScore({ damage: -5, catches: 'x' }), 0);
  const alloc = S.allocateRewards([
    { userId: 'a', score: 300, isLeader: true },
    { userId: 'b', score: 600 },
    { userId: 'c', score: 0 },
  ]);
  const sum = alloc.reduce((x, y) => x + y.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `shares sum ${sum}`);
  assert.equal(alloc.find((x) => x.isMvp).userId, 'b');
  const a = alloc.find((x) => x.userId === 'a');
  const c = alloc.find((x) => x.userId === 'c');
  assert.ok(Math.abs(a.share - 330 / 931) < 1e-3, '队长 +10%');
  assert.ok(c.share > 0, '0 分成员保底权重 1');
  assert.deepEqual(S.allocateRewards([]), []);
  const pool = S.splitPool({ xp: 1000, stardust: 7, bogus: -1 }, alloc);
  assert.equal(Object.values(pool).reduce((x, y) => x + y.xp, 0), 1000);
  assert.equal(Object.values(pool).reduce((x, y) => x + y.stardust, 0), 7);
  assert.equal(pool.a.bogus, undefined);
  assert.equal(S.contributionFromScore(0, 'lost'), 1);
  assert.equal(S.contributionFromScore(100, 'won'), 10);
  const ach = S.achievementsFor({ wins: 3, raidWins: 10, battles: 12 });
  assert.equal(ach.find((x) => x.id === 'raid_veteran').unlocked, true);
  assert.equal(ach.find((x) => x.id === 'centurion').unlocked, false);
});

// ── TURN ────────────────────────────────────────────────────────
test('turn: coturn REST API 凭证（HMAC-SHA1）、校验与过期', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);
  const c = T.turnCredentials({ secret: 's3cret', userId: 'u-1', ttlSeconds: 600, now });
  assert.equal(c.username, `${Math.floor(now / 1000) + 600}:u-1`);
  const expected = require('crypto').createHmac('sha1', 's3cret').update(c.username).digest('base64');
  assert.equal(c.credential, expected);
  assert.equal(T.verifyTurnCredentials({ secret: 's3cret', username: c.username, credential: c.credential, now }), true);
  assert.equal(T.verifyTurnCredentials({ secret: 'other', username: c.username, credential: c.credential, now }), false);
  assert.equal(T.verifyTurnCredentials({ secret: 's3cret', username: c.username, credential: c.credential, now: now + 601000 }), false, '过期');
  assert.throws(() => T.turnCredentials({ secret: '', userId: 'u' }));
  assert.throws(() => T.turnCredentials({ secret: 'x', userId: 'a:b' }));
  assert.equal(T.clampTtl(10), 300);
  assert.equal(T.clampTtl(1e9), 86400);
  assert.equal(T.clampTtl('abc'), 3600);
});

test('turn: iceServers 配置（未配置密钥只给 STUN；从 TURN 地址推导 STUN；过滤非法 URL）', () => {
  const env = { TURN_URLS: 'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349?transport=tcp, http://evil', TURN_SECRET: 'k', TURN_TTL_SECONDS: '900' };
  const cfg = T.iceConfigFor('user-1', env, 0);
  assert.equal(cfg.relayAvailable, true);
  assert.equal(cfg.ttl, 900);
  assert.deepEqual(cfg.iceServers[0], { urls: ['stun:turn.example.com:3478'] });
  assert.deepEqual(cfg.iceServers[1].urls, ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp']);
  assert.ok(cfg.iceServers[1].username.endsWith(':user-1'));
  const noSecret = T.iceConfigFor('user-1', { TURN_URLS: env.TURN_URLS, VOICE_STUN_URLS: 'stun:stun.example.org:3478' });
  assert.equal(noSecret.relayAvailable, false);
  assert.deepEqual(noSecret.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  assert.deepEqual(T.iceConfigFor('u', {}).iceServers, []);
});

// ── MOS ─────────────────────────────────────────────────────────
test('voice: E-model MOS 估算单调性与典型值', () => {
  const good = Q.estimateMos({ rttMs: 100, jitterMs: 10, lossPct: 0 });
  assert.ok(good > 4.2 && good <= 4.5, `good=${good}`);
  const lossy = Q.estimateMos({ rttMs: 100, jitterMs: 10, lossPct: 5 });
  assert.ok(lossy > 3.5 && lossy < 3.9, `5% loss=${lossy}`);
  const bad = Q.estimateMos({ rttMs: 800, jitterMs: 80, lossPct: 20 });
  assert.ok(bad < 2.5, `bad=${bad}`);
  assert.ok(Q.estimateMos({ rttMs: 300 }) < Q.estimateMos({ rttMs: 100 }), 'RTT 越大 MOS 越低');
  assert.ok(Q.estimateMos({ lossPct: 2 }) < Q.estimateMos({ lossPct: 1 }));
  assert.equal(Q.mosFromR(0), 1);
  assert.equal(Q.mosFromR(120), 4.5);
  assert.equal(Q.qualityLevel(4.1), 'excellent');
  assert.equal(Q.qualityLevel(3.6), 'good');
  assert.equal(Q.qualityLevel(2.0), 'bad');
});

test('voice: 质量样本校验、服务端重算 MOS、会话汇总与浏览器族', () => {
  assert.equal(Q.validateSample(null), null);
  assert.equal(Q.validateSample({ rttMs: -1, jitterMs: 0, lossPct: 0 }), null);
  assert.equal(Q.validateSample({ rttMs: 50, jitterMs: 5, lossPct: 101 }), null);
  const s = Q.validateSample({ rttMs: 80, jitterMs: 6, lossPct: 1, mos: 4.9, peers: 3.7, mode: 'floor', bitrateKbps: 24 });
  assert.equal(s.mode, 'floor');
  assert.equal(s.peers, 3);
  assert.equal(s.mosClient, 4.9);
  assert.equal(s.mosServer, Q.estimateMos({ rttMs: 80, jitterMs: 6, lossPct: 1 }));
  const agg = new Q.SessionAggregate({ mode: 'mesh', joinedAt: new Date(0) });
  agg.add(s);
  agg.add(Q.validateSample({ rttMs: 120, jitterMs: 10, lossPct: 3 }));
  agg.reconnect(true);
  agg.reconnect(false);
  const sum = agg.summary();
  assert.equal(sum.samples, 2);
  assert.equal(sum.avgRttMs, 100);
  assert.equal(sum.maxRttMs, 120);
  assert.equal(sum.reconnectAttempts, 2);
  assert.equal(sum.reconnectSuccesses, 1);
  assert.ok(sum.minMos <= sum.avgMos);
  assert.equal(new Q.SessionAggregate().summary().avgMos, null);
  assert.equal(Q.browserFamily('Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'chrome');
  assert.equal(Q.browserFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17 Safari/605.1'), 'safari');
  assert.equal(Q.browserFamily('Mozilla/5.0 Gecko/20100101 Firefox/128.0'), 'firefox');
  assert.equal(Q.browserFamily('Mozilla/5.0 Chrome/120 Safari/537 Edg/120'), 'edge');
});

test('voice: 客户端 MOS 与服务端算法一致（frontend/game-client/src/voice/voiceQuality.js）', async () => {
  const fe = await import(pathToFileURL(path.resolve(__dirname, '../../../frontend/game-client/src/voice/voiceQuality.js')).href);
  const vectors = [
    { rttMs: 0, jitterMs: 0, lossPct: 0 }, { rttMs: 100, jitterMs: 10, lossPct: 0 }, { rttMs: 250, jitterMs: 30, lossPct: 2 },
    { rttMs: 400, jitterMs: 50, lossPct: 8 }, { rttMs: 1200, jitterMs: 200, lossPct: 40 }, { rttMs: 60, jitterMs: 3, lossPct: 0.5 },
  ];
  for (const v of vectors) assert.equal(fe.estimateMos(v), Q.estimateMos(v), JSON.stringify(v));
});

// ── 信令协议 ─────────────────────────────────────────────────────
test('signaling: 消息解析（大小/JSON/类型白名单）', () => {
  assert.equal(SIG.parseClientMessage('{"type":"ping"}').ok, true);
  assert.equal(SIG.parseClientMessage(Buffer.from('{"type":"signal"}')).ok, true);
  assert.equal(SIG.parseClientMessage('nope').code, 'BAD_JSON');
  assert.equal(SIG.parseClientMessage('[1]').code, 'BAD_TYPE');
  assert.equal(SIG.parseClientMessage('{"type":"admin"}').code, 'BAD_TYPE');
  assert.equal(SIG.parseClientMessage(JSON.stringify({ type: 'ping', pad: 'x'.repeat(70000) })).code, 'TOO_LARGE');
});

test('signaling: offer/answer/ICE 校验只透传白名单字段', () => {
  const to = 'peerAAAA1234';
  assert.equal(SIG.sanitizeSignal({ to: 'bad id!', description: { type: 'offer', sdp: 'v=0\r\n' } }), null);
  assert.equal(SIG.sanitizeSignal({ to }), null, '没有 description 也没有 candidate');
  assert.equal(SIG.sanitizeSignal({ to, description: { type: 'pranswer', sdp: 'v=0' } }), null);
  assert.equal(SIG.sanitizeSignal({ to, description: { type: 'offer', sdp: 'hello' } }), null);
  assert.equal(SIG.sanitizeSignal({ to, description: { type: 'offer', sdp: `v=0${'a'.repeat(17000)}` } }), null);
  const off = SIG.sanitizeSignal({ to, description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n', extra: 1 }, evil: true });
  assert.deepEqual(off, { to, description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n' } });
  const cand = SIG.sanitizeSignal({ to, candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal(cand.candidate.sdpMid, '0');
  assert.equal(cand.candidate.usernameFragment, null);
  assert.deepEqual(SIG.sanitizeSignal({ to, candidate: null }), { to, candidate: null });
  assert.equal(SIG.sanitizeSignal({ to, candidate: { candidate: 'x', sdpMLineIndex: 99 } }), null);
  assert.equal(SIG.sanitizeSignal({ to, candidate: { candidate: 5 } }), null);
});

test('signaling: 位置清洗（范围、4 位小数）、状态、Raid 集结', () => {
  assert.deepEqual(SIG.sanitizeLocation({ lat: 31.230412, lng: 121.473719, accuracy: 12.6 }), { lat: 31.2304, lng: 121.4737, accuracy: 13 });
  assert.equal(SIG.sanitizeLocation({ lat: 91, lng: 0 }), null);
  assert.equal(SIG.sanitizeLocation({ lat: 'x', lng: 0 }), null);
  assert.equal(SIG.sanitizeLocation({ lat: 1, lng: 2 }).accuracy, null);
  assert.equal(SIG.sanitizeStatus({ status: 'in_battle' }), 'in_battle');
  assert.equal(SIG.sanitizeStatus({ status: 'afk' }), null);
  const raidId = '0a1b2c3d-1111-4222-8333-444455556666';
  assert.deepEqual(SIG.sanitizeRaidCall({ raidId, gymId: 'nope' }), { raidId, gymId: null });
  assert.equal(SIG.sanitizeRaidCall({ raidId: '1' }), null);
});

test('signaling: 位置节流、令牌桶、发言席位（上限/续期/超时）与礼让方', () => {
  const th = new SIG.LocationThrottle(4000);
  assert.equal(th.accept('u', 0), true);
  assert.equal(th.accept('u', 3000), false);
  assert.equal(th.accept('u', 4000), true);
  assert.equal(th.accept('v', 4001), true);
  th.forget('u');
  assert.equal(th.accept('u', 4002), true);

  const tb = new SIG.TokenBucket({ rate: 10, burst: 2 });
  assert.equal(tb.take(0), true);
  assert.equal(tb.take(0), true);
  assert.equal(tb.take(0), false);
  assert.equal(tb.take(100), true, '100ms 回填 1 个令牌');

  const fc = new SIG.FloorControl({ maxSpeakers: 2, holdMs: 1000 });
  assert.equal(fc.request('a', 0).granted, true);
  assert.equal(fc.request('b', 10).granted, true);
  assert.equal(fc.request('c', 20).granted, false, '席位已满');
  assert.equal(fc.request('a', 500).renewed, true);
  assert.deepEqual(fc.expire(1010), ['b'], 'b 超时释放，a 已续期');
  assert.equal(fc.request('c', 1020).granted, true);
  assert.equal(fc.release('a'), true);
  assert.deepEqual(fc.speakers(), ['c']);

  assert.equal(SIG.isPolite('b', 'a'), true);
  assert.equal(SIG.isPolite('a', 'b'), false);
});
