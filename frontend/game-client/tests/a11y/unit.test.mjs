// frontend/game-client/tests/a11y/unit.test.mjs
// Epic E21：无障碍纯逻辑单测（直接 import 真实模块）。运行：node --test frontend/game-client/tests/a11y/
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizePrefs, mergePrefs, toCloudDoc, DEFAULT_PREFS, diffFromDefaults, A11yPrefsStore, STORAGE_KEY } from '../../src/accessibility/prefs.js';
import { contrastRatio, correctionMatrix, toFeColorMatrix, simulate, distinguishability, CVD_PALETTES, BASE_PALETTE, paletteFor, checkPalette, fixPalette, ensureContrast, TYPE_SHAPES, accuracyZone } from '../../src/accessibility/colorVision.js';
import { detectFlashes, maxFlashesPerSecond, isDangerous, safePlaybackRate, flashHz, mapSensitivity } from '../../src/accessibility/photosensitive.js';
import { effectiveCatchScale, PACE_PRESETS, isSlow } from '../../src/accessibility/pace.js';
import { isRtlLang, directionFor, detectTextDirection, detectLangDirection, isolate } from '../../src/accessibility/textDirection.js';
import { applyAimAssist, AIM_COEFFICIENTS, tremorAccept, nearestTarget, motorPreset, trajectoryPath } from '../../src/accessibility/motorAssist.js';
import { detectControllerType, stickToScroll, resolveMapping, DEFAULT_GAMEPAD_MAPPING } from '../../src/accessibility/gamepad.js';
import { parseCommand, COMMANDS } from '../../src/accessibility/voiceControl.js';
import { normalizeKeyEvent, isReserved, validateBinding, resolveBindings, DEFAULT_BINDINGS } from '../../src/accessibility/shortcuts.js';
import { planCue, CUE_DEFS } from '../../src/accessibility/soundCues.js';
import { segmentText, displayDurationMs } from '../../src/accessibility/subtitles.js';
import { recommendSettings } from '../../src/accessibility/cognitive.js';
import { bearingDeg, compass8, distanceMeters, toneForDistance, panForBearing, summarizeNearby, spawnLabel, describeSpawns } from '../../src/accessibility/mapSpeech.js';
import { shouldAnnounce } from '../../src/accessibility/liveAnnouncer.js';
import { t, resolveLang } from '../../src/accessibility/strings.js';

// ── prefs ──
test('prefs：sanitize 夹取越界值、非法枚举回退默认、丢弃未知字段', () => {
  const p = sanitizePrefs({ haptics: { intensity: 999 }, color: { mode: 'rainbow' }, pace: { catch: 0.6 }, evil: 1, motor: { holdMs: 50 } });
  assert.equal(p.haptics.intensity, 200);
  assert.equal(p.color.mode, 'none');
  assert.equal(p.pace.catch, 0.5, '取最近的合法倍率');
  assert.equal(p.motor.holdMs, 100);
  assert.equal(p.evil, undefined);
  assert.deepEqual(sanitizePrefs(null), sanitizePrefs({}));
  assert.equal(sanitizePrefs({}).screenReader.verbosity, 'full');
});

test('prefs：merge 深合并；调色板/绑定整体替换；自定义命令最多 30 条', () => {
  const a = mergePrefs(DEFAULT_PREFS, { color: { palette: { red: '#ff0000', bad: 'x' } }, keyboard: { bindings: { goMap: 'g' } } });
  assert.deepEqual(a.color.palette, { red: '#ff0000' });
  const b = mergePrefs(a, { color: { palette: { blue: '#0000ff' } } });
  assert.deepEqual(b.color.palette, { blue: '#0000ff' });
  assert.equal(b.keyboard.bindings.goMap, 'g');
  const many = Array.from({ length: 40 }, (_, i) => ({ phrase: `p${i}`, action: 'goMap' }));
  assert.equal(mergePrefs(DEFAULT_PREFS, { voiceControl: { customCommands: many } }).voiceControl.customCommands.length, 30);
});

test('prefs：toCloudDoc 默认剔除动作辅助设置（隐私，REQ-00360）', () => {
  const p = mergePrefs(DEFAULT_PREFS, { motor: { enabled: true } });
  assert.equal(toCloudDoc(p).motor, undefined);
  assert.ok(toCloudDoc(mergePrefs(p, { motor: { cloudSync: true } })).motor);
  assert.deepEqual(diffFromDefaults(p), ['motor.enabled']);
});

test('prefs：store 本地持久化与云端拉取（云端较新覆盖本地，本地 motor 保留）', async () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  storage.setItem('pmg_access_token', 'tok');
  const calls = [];
  const api = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET') return { prefs: { color: { mode: 'tritanopia' } }, clientUpdatedAt: new Date(Date.now() + 60000).toISOString() };
      return { version: 3 };
    },
  };
  const s = new A11yPrefsStore({ api, storage });
  s.set('motor.enabled', true, { sync: false });
  assert.ok(JSON.parse(storage.getItem(STORAGE_KEY)).prefs.motor.enabled);
  let changed = 0;
  s.addEventListener('change', () => changed++);
  await s.pull();
  assert.equal(s.get('color.mode'), 'tritanopia');
  assert.equal(s.get('motor.enabled'), true, '云端无 motor 时保留本地');
  assert.equal(changed, 1);
  await s.push();
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/users/me/preferences/a11y');
  assert.equal(put.body.prefs.motor, undefined);
  assert.equal(s.syncState.version, 3);
});

// ── color ──
test('色觉：WCAG 对比度计算', () => {
  assert.equal(Number(contrastRatio('#000000', '#ffffff').toFixed(1)), 21);
  assert.equal(Number(contrastRatio('#777777', '#777777').toFixed(1)), 1);
  assert.ok(contrastRatio(BASE_PALETTE.muted, BASE_PALETTE.bg) >= 4.5, '默认次要文字满足 AA');
});

test('色觉：红/绿色盲下替换调色板使"成功/错误"更易区分', () => {
  for (const type of ['protanopia', 'deuteranopia']) {
    const before = distinguishability(BASE_PALETTE.red, BASE_PALETTE.green, type);
    const p = CVD_PALETTES[type];
    const after = distinguishability(p.red, p.green, type);
    assert.ok(after > before * 1.5, `${type}: ${before.toFixed(0)} → ${after.toFixed(0)}`);
  }
  const tri = CVD_PALETTES.tritanopia;
  assert.ok(distinguishability(tri.blue, tri.green, 'tritanopia') > distinguishability(BASE_PALETTE.blue, BASE_PALETTE.green, 'tritanopia'));
});

test('色觉：校正矩阵（强度 0 为单位阵）与 feColorMatrix 格式', () => {
  const id = correctionMatrix('protanopia', 0);
  assert.deepEqual(id.map((v) => Number(v.toFixed(6))), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const vals = toFeColorMatrix(correctionMatrix('deuteranopia', 1)).split(' ');
  assert.equal(vals.length, 20);
  assert.equal(simulate('#ffffff', 'achromatopsia'), '#ffffff');
});

test('色觉：调色板检查与自动修正至 AA', () => {
  const bad = { ...BASE_PALETTE, muted: '#303030' };
  assert.ok(checkPalette(bad).some((i) => i.key === 'muted'));
  const fixed = fixPalette(bad);
  assert.equal(checkPalette(fixed).length, 0);
  assert.ok(contrastRatio(ensureContrast('#222222', '#000000'), '#000000') >= 4.5);
  for (const mode of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia']) {
    assert.equal(checkPalette(fixPalette(paletteFor(mode))).length, 0, mode);
  }
});

test('色觉：18 种属性形状唯一；准确度分区文字/图案', () => {
  assert.equal(Object.keys(TYPE_SHAPES).length, 18);
  assert.equal(new Set(Object.values(TYPE_SHAPES).map((v) => v[0])).size, 18);
  assert.deepEqual([accuracyZone(20).zone, accuracyZone(50).zone, accuracyZone(90).zone], ['excellent', 'great', 'nice']);
});

// ── photosensitive ──
const wave = (hz, ms, step = 16) => {
  const out = [];
  for (let t = 0; t <= ms; t += step) out.push({ t, luminance: Math.sin((2 * Math.PI * hz * t) / 1000) > 0 ? 0.9 : 0.1 });
  return out;
};
test('光敏：闪烁检测 —— 2Hz 安全，5Hz 危险（>3 次/秒）', () => {
  assert.ok(maxFlashesPerSecond(wave(2, 3000)) <= 3);
  assert.equal(isDangerous(wave(2, 3000)), false);
  assert.ok(maxFlashesPerSecond(wave(5, 3000)) >= 4);
  assert.equal(isDangerous(wave(5, 3000)), true);
  assert.equal(detectFlashes([{ t: 0, luminance: 0.5 }, { t: 16, luminance: 0.52 }]).length, 0, '低于阈值不算闪烁');
});
test('光敏：安全播放速率把频率压到 ≤3Hz', () => {
  assert.equal(safePlaybackRate(100), 0.3);
  assert.equal(safePlaybackRate(1000), 1);
  assert.ok(flashHz(100, safePlaybackRate(100)) <= 3.0001);
});
test('光敏：敏感度测试结果映射', () => {
  assert.equal(mapSensitivity([{ hz: 1, comfortable: false }]).sensitivity, 'high');
  assert.equal(mapSensitivity([{ hz: 1, comfortable: true }, { hz: 2, comfortable: false }]).enabled, true);
  const low = mapSensitivity([1, 2, 3].map((hz) => ({ hz, comfortable: true })));
  assert.equal(low.sensitivity, 'low');
  assert.equal(low.enabled, false);
});

// ── pace ──
test('节奏：预设与捕捉窗口合成（0.5x × 窗口×2 = 0.25）', () => {
  assert.equal(effectiveCatchScale({ catch: 0.5 }, { enabled: true, windowMultiplier: 2 }), 0.25);
  assert.equal(effectiveCatchScale({ catch: 0.5 }, { enabled: false, windowMultiplier: 3 }), 0.5);
  assert.deepEqual(PACE_PRESETS.accessible, { catch: 0.5, battle: 0.5, ui: 0.5 });
  assert.ok(isSlow({ catch: 1, battle: 0.75, ui: 1 }));
});

// ── direction ──
test('RTL：语言检测与文本方向', () => {
  for (const l of ['ar', 'ar-SA', 'he-IL', 'fa', 'ur-PK']) assert.equal(detectLangDirection(l).direction, 'rtl', l);
  for (const l of ['zh-CN', 'en-US', 'ja-JP', '']) assert.equal(directionFor(l), 'ltr', l);
  assert.equal(directionFor('zh-CN', 'rtl'), 'rtl');
  assert.equal(detectTextDirection('مرحبا 123'), 'rtl');
  assert.equal(detectTextDirection('123 皮卡丘'), 'ltr');
  assert.equal(detectTextDirection('1234'), 'neutral');
  assert.ok(isRtlLang('he'));
  assert.equal(isolate('CP 350'), '⁨CP 350⁩');
});

// ── motor ──
test('动作辅助：自动瞄准系数 0.3/0.6/0.85', () => {
  assert.deepEqual([AIM_COEFFICIENTS.low, AIM_COEFFICIENTS.medium, AIM_COEFFICIENTS.high], [0.3, 0.6, 0.85]);
  assert.equal(applyAimAssist(1, 0), 1);
  assert.ok(Math.abs(applyAimAssist(1, 0.85) - (0.2 + 0.8 * 0.15)) < 1e-9);
  assert.ok(applyAimAssist(0.7, 0.6) < 0.7);
});
test('动作辅助：震颤过滤与 100px 目标吸附', () => {
  assert.equal(tremorAccept({ last: 1000, now: 1200, sameTarget: true, strength: 'medium' }), false);
  assert.equal(tremorAccept({ last: 1000, now: 1600, sameTarget: true, strength: 'medium' }), true);
  assert.equal(tremorAccept({ last: 1000, now: 1100, sameTarget: false, strength: 'high' }), true);
  assert.equal(tremorAccept({ last: null, now: 0, sameTarget: false, movedPx: 40, strength: 'low' }), false);
  const rects = [{ x: 0, y: 0, width: 50, height: 50, id: 'a' }, { x: 300, y: 0, width: 50, height: 50, id: 'b' }];
  assert.equal(nearestTarget({ x: 120, y: 20 }, rects).target.id, 'a');
  assert.equal(nearestTarget({ x: 200, y: 20 }, rects, 100).target.id, 'b');
  assert.equal(nearestTarget({ x: 175, y: 300 }, rects), null);
});
test('动作辅助：预设方案与轨迹', () => {
  assert.equal(motorPreset('heavy').aimAssist, 'high');
  assert.equal(motorPreset('tremor').confirmMode, 'hold');
  assert.equal(motorPreset('nope'), null);
  assert.match(trajectoryPath({ x: 0, y: 100 }, { x: 50, y: 0 }).d, /^M 0 100 Q /);
});

// ── gamepad ──
test('手柄：型号识别、摇杆死区、映射覆盖', () => {
  assert.equal(detectControllerType('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)'), 'xbox');
  assert.equal(detectControllerType('DualSense Wireless Controller (Vendor: 054c)'), 'playstation');
  assert.equal(detectControllerType('Pro Controller (Vendor: 057e Product: 2009)'), 'nintendo');
  assert.equal(detectControllerType('Some pad'), 'generic');
  assert.deepEqual(stickToScroll(0.1, -0.1), { dx: 0, dy: 0 });
  assert.ok(stickToScroll(0, 1).dy > 15);
  assert.equal(resolveMapping({ confirm: 1, bogus: 3 }).confirm, 1);
  assert.equal(resolveMapping({}).cancel, DEFAULT_GAMEPAD_MAPPING.cancel);
});

// ── voice ──
test('语音控制：中/英/日命令解析、最长匹配、自定义命令优先', () => {
  assert.equal(parseCommand('打开背包', 'zh-CN').action, 'goProfile');
  assert.equal(parseCommand('请帮我投球', 'zh-CN').action, 'throw');
  assert.equal(parseCommand('Open Map please', 'en-US').action, 'goMap');
  assert.equal(parseCommand('throw the ball', 'en-US').action, 'throw');
  assert.equal(parseCommand('スーパーボール', 'ja-JP').action, 'ballGreat');
  assert.equal(parseCommand('catch nearest', 'zh-CN').action, 'catchNearest', '中文界面也能识别英文命令');
  assert.equal(parseCommand('今天天气不错', 'zh-CN'), null);
  assert.equal(parseCommand('冲鸭', 'zh-CN', [{ phrase: '冲鸭', action: 'throw' }]).source, 'custom');
  assert.ok(Object.keys(COMMANDS).length >= 15);
});

// ── keyboard ──
test('快捷键：≥15 个默认绑定、组合键规范化、保留键与冲突检测', () => {
  assert.ok(Object.keys(DEFAULT_BINDINGS).length >= 15);
  assert.equal(normalizeKeyEvent({ key: '?', shiftKey: true }), '?');
  assert.equal(normalizeKeyEvent({ key: 'M', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+m');
  assert.equal(normalizeKeyEvent({ key: 'ß', altKey: true, code: 'KeyS' }), 'Alt+s');
  assert.equal(normalizeKeyEvent({ key: 'Esc' }), 'Escape');
  assert.ok(isReserved('Ctrl+w'));
  assert.ok(isReserved('ctrl+W'));
  const b = resolveBindings({});
  assert.equal(validateBinding('goMap', 'g', b), null);
  assert.match(validateBinding('goMap', 'p', b), /已被/);
  assert.match(validateBinding('goMap', 'F5', b), /保留/);
  assert.equal(resolveBindings({ goMap: 'g', nope: 'x' }).goMap, 'g');
  const vals = Object.values(DEFAULT_BINDINGS).map((v) => v.toLowerCase());
  assert.equal(new Set(vals).size, vals.length, '默认绑定无重复');
  assert.ok(vals.every((v) => !isReserved(v)), '默认绑定不占用保留键');
});

// ── cues / subtitles ──
test('视觉提示：P0 事件 ≥2 种视觉通道；光敏/减少动画改静态；分类过滤', () => {
  const hearing = { ...DEFAULT_PREFS.hearing, visualCues: true };
  const p0 = Object.keys(CUE_DEFS).filter((k) => CUE_DEFS[k].priority === 'P0');
  assert.ok(p0.length >= 4);
  for (const k of p0) {
    const plan = planCue(k, hearing);
    assert.ok(plan.channels.filter((c) => c !== 'vibrate').length >= 2, k);
    assert.ok(plan.durationMs >= 2000);
  }
  assert.ok(planCue('catch:success', hearing, { photosafe: true }).channels.includes('border-static'));
  assert.equal(planCue('catch:success', { ...hearing, categories: { ...hearing.categories, catch: false } }), null);
  assert.equal(planCue('catch:success', { ...hearing, visualCues: false }), null);
});
test('字幕：分段与显示时长', () => {
  const segs = segmentText('附近有 3 只精灵，最近的是皮卡丘，东北方向约 120 米；2 个补给站，1 个道馆。按 L 可以重复收听附近情况。', 20);
  assert.ok(segs.length >= 3 && segs.every((s) => s.length <= 20));
  assert.equal(segmentText('').length, 0);
  assert.equal(displayDurationMs('短'), 1500);
  assert.ok(displayDurationMs('这是一条较长的字幕文本，需要更多时间阅读才能理解') > 3000);
  assert.equal(displayDurationMs('短', 2), 3000);
});

// ── cognitive ──
test('认知：设置向导根据回答推荐设置', () => {
  const r = recommendSettings({ vision: 'color', hearing: 'yes', motor: 'severe', reading: 'yes', attention: 'yes', photo: 'yes' });
  assert.equal(r.color.mode, 'deuteranopia');
  assert.equal(r.hearing.visualCues, true);
  assert.equal(r.motor.oneTapThrow, true);
  assert.equal(r.cognitive.dyslexiaFont, true);
  assert.equal(r.cognitive.focusMode, true);
  assert.equal(r.photosensitive.enabled, true);
  assert.deepEqual(recommendSettings({}), {});
  assert.equal(mergePrefs(DEFAULT_PREFS, r).pace.catch, 0.5);
});

// ── map speech / announcer / strings ──
test('地图语音：方位、八方向、距离音调、摘要', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0) - 0) < 1);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 1);
  assert.equal(compass8(45, 'zh-CN'), '东北');
  assert.equal(compass8(270, 'en-US'), 'west');
  assert.ok(Math.abs(distanceMeters(31.23, 121.47, 31.24, 121.47) - 1112) < 5);
  assert.ok(toneForDistance(10) > toneForDistance(500));
  assert.equal(panForBearing(90), 1);
  const pos = { lat: 31.23, lng: 121.47 };
  const data = { wildPokemons: [{ id: 'a', species_name: '皮卡丘', cp: 300, lat: 31.231, lng: 121.471 }, { id: 'b', species_name: '小火龙', lat: 31.26, lng: 121.47 }], pokestops: [{}], gyms: [] };
  const s = summarizeNearby(data, pos, 'zh-CN');
  assert.match(s.text, /附近有 2 只精灵，最近的是皮卡丘，东北方向约 \d+ 米；1 个补给站，0 个道馆/);
  assert.match(spawnLabel(describeSpawns(data.wildPokemons, pos)[0]), /皮卡丘，CP 300，东北方向约 \d+ 米/);
  assert.equal(summarizeNearby({}, pos).text, '附近暂无精灵');
});
test('播报级别过滤与多语言文案', () => {
  assert.ok(shouldAnnounce('info', 'full'));
  assert.ok(!shouldAnnounce('info', 'minimal'));
  assert.ok(shouldAnnounce('important', 'minimal'));
  assert.ok(!shouldAnnounce('important', 'critical'));
  assert.ok(shouldAnnounce('critical', 'critical'));
  assert.equal(t('entered', 'en-US', { screen: 'Map' }), 'Map screen');
  assert.equal(resolveLang('ar-SA'), 'en-US');
  assert.equal(t('cap_spawn', 'ko-KR'), '[포켓몬 등장 소리]');
  assert.equal(t('catch_success', 'ko-KR'), 'Caught!', '缺失键回退英文');
});
