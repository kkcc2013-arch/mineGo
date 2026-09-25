// frontend/game-client/tests/unit/battle-client.test.mjs
// E11 前端纯逻辑单测（无需浏览器/依赖）：node --test frontend/game-client/tests/unit/battle-client.test.mjs
//   REQ-00325 设备分级、帧率统计、画质升降级（滞回+冷却）、帧节流
//   REQ-00112 能量条/技能按钮状态；REQ-00379/00469 回放帧构建与倍速
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectDeviceTier, FpsMeter, QualityGovernor, shouldRender, easeOutCubic, TIER_DEFAULTS } from '../../src/battle/FrameRateController.js';
import { moveButtonState, energyBarModel, describeAction, turnIntervalMs, hpColor, escapeHtml } from '../../src/battle/BattleClient.js';
import { buildReplayFrames } from '../../src/battle/ReplayPlayer.js';

test('设备分级：<4GB 低端、4-8GB 中端、>8GB 高端；无内存信息按核数；省流量/减少动效最高中端', () => {
  assert.equal(detectDeviceTier({ deviceMemory: 2 }), 'low');
  assert.equal(detectDeviceTier({ deviceMemory: 4 }), 'mid');
  assert.equal(detectDeviceTier({ deviceMemory: 8 }), 'mid');
  assert.equal(detectDeviceTier({ deviceMemory: 12 }), 'high');
  assert.equal(detectDeviceTier({ hardwareConcurrency: 4 }), 'low');
  assert.equal(detectDeviceTier({ hardwareConcurrency: 6 }), 'mid');
  assert.equal(detectDeviceTier({ hardwareConcurrency: 8 }), 'high');
  assert.equal(detectDeviceTier({}), 'mid');
  assert.equal(detectDeviceTier({ deviceMemory: 16, saveData: true }), 'mid');
  assert.equal(detectDeviceTier({ deviceMemory: 16, reducedMotion: true }), 'mid');
});

test('帧率统计：滑动窗口平均帧率、P5 卡顿帧率、掉帧计数', () => {
  const m = new FpsMeter(2000);
  for (let i = 0; i <= 60; i++) m.record(i * (1000 / 30), 30);
  assert.ok(Math.abs(m.fps() - 30) < 0.5, `fps=${m.fps()}`);
  assert.equal(m.dropped, 0);
  m.record(60 * (1000 / 30) + 200, 30);
  assert.ok(m.dropped >= 4, '200ms 卡顿计为掉帧');
  assert.ok(m.p5Fps() > 25, '单次卡顿不足 5%，P5 仍接近 30');
  const j = new FpsMeter(5000);
  let t = 0;
  for (let i = 0; i < 40; i++) j.record((t += 1000 / 30), 30);
  for (let i = 0; i < 5; i++) j.record((t += 200), 30);
  assert.ok(j.p5Fps() <= 5, `频繁卡顿时 P5 反映卡顿：${j.p5Fps()}`);
  const w = new FpsMeter(1000);
  for (let t = 0; t <= 3000; t += 16) w.record(t, 60);
  assert.ok(w.span <= 1000, '只保留窗口内的帧');
});

test('画质调节：低于目标 85% 先降特效再降帧率，高于 98% 逐级恢复且不超过设备上限；冷却期内不重复调整', () => {
  const g = new QualityGovernor({ tier: 'high', config: TIER_DEFAULTS });
  assert.equal(g.targetFps, 60);
  assert.equal(g.effects, 'high');
  assert.equal(g.evaluate(40, 10_000, 500), null, '统计窗口未满不调整');
  assert.deepEqual(g.evaluate(40, 10_000), { type: 'downgrade', effects: 'medium', targetFps: 60 });
  assert.equal(g.evaluate(40, 12_000), null, '冷却 5 秒内不再调整');
  assert.equal(g.evaluate(40, 16_000).effects, 'low');
  assert.equal(g.evaluate(40, 22_000).targetFps, 45, '特效已最低时降帧率');
  assert.equal(g.evaluate(30, 28_000).targetFps, 30);
  assert.equal(g.evaluate(20, 34_000), null, '已到最低档');
  assert.equal(g.degradeEvents, 4);
  assert.equal(g.evaluate(30, 40_000).targetFps, 45, '恢复：先恢复帧率');
  assert.equal(g.evaluate(45, 46_000).targetFps, 60);
  assert.equal(g.evaluate(60, 52_000).effects, 'medium', '帧率恢复后再恢复特效');
  assert.equal(g.evaluate(60, 58_000).effects, 'high');
  assert.equal(g.evaluate(60, 64_000), null, '不超过设备档位上限');
  const low = new QualityGovernor({ tier: 'low' });
  assert.equal(low.targetFps, 30);
  assert.equal(low.evaluate(30, 10_000), null, '低端机稳定 30FPS 不升档');
  assert.ok(low.particleLimit < new QualityGovernor({ tier: 'high' }).particleLimit);
});

test('帧节流与缓动：按目标帧率跳帧，缓动 0→1 单调', () => {
  assert.equal(shouldRender(16.7, 0, 60), true);
  assert.equal(shouldRender(16.7, 0, 30), false, '30FPS 时跳过一帧');
  assert.equal(shouldRender(33.4, 0, 30), true);
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5);
  assert.equal(easeOutCubic(2), 1);
});

test('技能按钮：冷却优先、能量不足提示、可用时显示能量增减', () => {
  assert.deepEqual(moveButtonState({ category: 'CHARGE', cooldownLeft: 2, energyOk: true, energyCost: 50 }), { disabled: true, label: '冷却 2', reason: 'cooldown' });
  assert.equal(moveButtonState({ category: 'CHARGE', cooldownLeft: 0, energyOk: false, energyCost: 55 }).label, '需 55 能量');
  assert.equal(moveButtonState({ category: 'FAST', cooldownLeft: 0, energyOk: true, energyGain: 8 }).label, '+8⚡');
  assert.equal(moveButtonState({ category: 'CHARGE', cooldownLeft: 0, energyOk: true, energyCost: 55 }).disabled, false);
});

test('能量条：百分比与蓄力技能刻度', () => {
  const m = energyBarModel(60, 120, [{ id: 'A', name: 'A', category: 'CHARGE', energyCost: 55 }, { id: 'B', name: 'B', category: 'CHARGE', energyCost: 100 }, { id: 'F', category: 'FAST', energyGain: 8 }]);
  assert.equal(m.pct, 50);
  assert.equal(m.ticks.length, 2);
  assert.equal(m.ticks[0].ready, true);
  assert.equal(m.ticks[1].ready, false);
  assert.equal(m.ticks[1].pct, 83);
  assert.equal(energyBarModel(500, 100).pct, 100);
  assert.equal(hpColor(10, 100), 'var(--red)');
  assert.equal(hpColor(80, 100), 'var(--green)');
});

test('战斗日志与转义', () => {
  assert.match(describeAction({ type: 'attack', name: '喷火龙', moveName: '喷射火焰', damage: 88, effectivenessText: '效果拔群！', combo: { name: '火花爆燃', multiplier: 1.5 } }), /88.*效果拔群.*火花爆燃×1.5/);
  assert.match(describeAction({ type: 'attack', name: 'A', moveName: 'B', missed: true }), /没有命中/);
  assert.equal(describeAction({ type: 'faint', name: '妙蛙种子' }), '妙蛙种子 倒下了');
  assert.equal(escapeHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
  assert.equal(turnIntervalMs(2), 600);
  assert.equal(turnIntervalMs(4), 300);
  assert.equal(turnIntervalMs(9), 1200, '非法倍速按 1x');
});

test('回放帧：逐回合 HP、换人、击倒，回合末以服务端 HP 为准', () => {
  const replay = {
    attackerTeam: [{ pokemonId: 'a1', name: '喷火龙', speciesId: 6, maxHp: 150 }, { pokemonId: 'a2', name: '喵喵', speciesId: 52, maxHp: 120 }],
    defenderTeam: [{ pokemonId: 'd1', name: '妙蛙种子', speciesId: 1, maxHp: 100 }, { pokemonId: 'd2', name: '杰尼龟', speciesId: 7, maxHp: 110 }],
    turns: [
      { turn: 1, hp: { attacker: 140, defender: 40 }, actions: [
        { type: 'attack', actor: 'attacker', name: '喷火龙', moveName: '喷射火焰', damage: 60, targetId: 'd1', targetHp: 40, targetMaxHp: 100 },
        { type: 'attack', actor: 'defender', name: '妙蛙种子', moveName: '藤鞭', damage: 10, targetId: 'a1', targetHp: 140, targetMaxHp: 150 }] },
      { turn: 2, hp: { attacker: 140, defender: 110 }, actions: [
        { type: 'attack', actor: 'attacker', name: '喷火龙', moveName: '火花', damage: 40, targetId: 'd1', targetHp: 0, targetMaxHp: 100, combo: { name: '双火花', multiplier: 1.3 } },
        { type: 'faint', side: 'defender', name: '妙蛙种子' },
        { type: 'switch', side: 'defender', pokemonId: 'd2', name: '杰尼龟', hp: 110, maxHp: 110 }] },
      { turn: 3, hp: { attacker: 118, defender: 110 }, actions: [
        { type: 'switch', side: 'attacker', pokemonId: 'a2', name: '换上 喵喵' },
        { type: 'attack', actor: 'defender', name: '杰尼龟', moveName: '水枪', damage: 2, targetId: 'a2', targetHp: 118, targetMaxHp: 120 }] },
    ],
  };
  const f = buildReplayFrames(replay);
  assert.equal(f.length, 4);
  assert.deepEqual([f[0].attacker.hp, f[0].defender.hp], [150, 100]);
  assert.equal(f[1].defender.hp, 40);
  assert.equal(f[2].defender.name, '杰尼龟');
  assert.equal(f[2].defender.hp, 110);
  assert.equal(f[2].combo, true);
  assert.equal(f[3].attacker.pokemonId, 'a2');
  assert.equal(f[3].attacker.hp, 118);
  assert.equal(f[1].attacker.hp, 140, '帧是快照，不随后续回合变化');
  assert.ok(f[2].lines.some((l) => l.includes('双火花')));
});
