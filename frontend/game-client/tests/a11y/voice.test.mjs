// frontend/game-client/tests/a11y/voice.test.mjs
// REQ-00536：VoiceCommandProcessor（parseCommand）、VoiceController（_onResult）、VoiceFeedback（LiveAnnouncer.speak）各 10+ 用例；
// 另含宏/播报类别/战斗提示等新增逻辑。运行：node --test frontend/game-client/tests/a11y/voice.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand, VoiceController, ACTION_LABELS, COMMANDS } from '../../src/accessibility/voiceControl.js';
import { LiveAnnouncer, shouldAnnounce } from '../../src/accessibility/liveAnnouncer.js';
import { sanitizePrefs, mergePrefs, DEFAULT_PREFS } from '../../src/accessibility/prefs.js';
import { planCue, CUE_DEFS } from '../../src/accessibility/soundCues.js';
import { t } from '../../src/accessibility/strings.js';

// ── VoiceCommandProcessor ─────────────────────────────────────
const P = (text, lang = 'zh-CN', custom = []) => { const r = parseCommand(text, lang, custom); return r && r.action; };
test('processor 01：中文"打开地图"', () => assert.equal(P('打开地图'), 'goMap'));
test('processor 02：中文句中包含命令"帮我投球吧"', () => assert.equal(P('帮我投球吧'), 'throw'));
test('processor 03：最长匹配"捕捉最近的"优先于"捕捉"', () => assert.equal(parseCommand('捕捉最近的', 'zh-CN').phrase, '捕捉最近的'));
test('processor 04：英文大小写与标点', () => assert.equal(P('Throw The Ball!', 'en-US'), 'throw'));
test('processor 05：英文按词匹配（"mapping" 不等于 "map"）', () => assert.equal(P('mapping', 'en-US'), null));
test('processor 06：日文命令', () => { assert.equal(P('設定', 'ja-JP'), 'settings'); assert.equal(P('逃げる', 'ja-JP'), 'flee'); });
test('processor 07：界面语言之外的语言也能识别', () => assert.equal(P('open settings', 'zh-CN'), 'settings'));
test('processor 08：精灵球选择', () => { assert.equal(P('超级球'), 'ballGreat'); assert.equal(P('ultra ball', 'en-US'), 'ballUltra'); });
test('processor 09：未知与空输入', () => { assert.equal(P(''), null); assert.equal(P('   '), null); assert.equal(P('随便说点什么'), null); });
test('processor 10：自定义命令优先且可指向宏', () => {
  assert.equal(parseCommand('冲', 'zh-CN', [{ phrase: '冲', action: 'throw' }]).source, 'custom');
  assert.equal(P('连招一', 'zh-CN', [{ phrase: '连招一', action: 'macro:1' }]), 'macro:1');
  assert.equal(P('坏命令', 'zh-CN', [{ phrase: '坏命令', action: 'rm -rf' }]), null, '非法动作忽略');
});
test('processor 11：命令表覆盖 ≥15 个动作且都有中文标签与三语同义词', () => {
  assert.ok(Object.keys(COMMANDS).length >= 15);
  for (const [a, syn] of Object.entries(COMMANDS)) {
    assert.ok(ACTION_LABELS[a], a);
    assert.ok(syn.zh.length && syn.en.length && syn.ja.length, a);
  }
});

// ── VoiceController ───────────────────────────────────────────
function makeController(overrides = {}) {
  const ran = [];
  const said = [];
  const prefs = mergePrefs(DEFAULT_PREFS, { voiceControl: { enabled: true, ...(overrides.vc || {}) } });
  const vc = new VoiceController({
    getPrefs: () => prefs,
    run: (a) => { ran.push(a); return true; },
    announcer: { announce: (m) => said.push(m) },
    lang: () => 'zh-CN',
    ...(overrides.deps || {}),
  });
  vc.rec = { lang: overrides.recLang || 'zh-CN' };
  return { vc, ran, said };
}
const result = (alts, isFinal = true) => { const r = alts.map(([transcript, confidence]) => ({ transcript, confidence })); r.isFinal = isFinal; return r; };
const event = (...results) => ({ resultIndex: 0, results });

test('controller 01：无 SpeechRecognition 时 supported=false、start 返回 false', () => {
  const { vc } = makeController();
  assert.equal(vc.supported, false);
  assert.equal(vc.start(), false);
});
test('controller 02：识别结果执行对应动作', () => {
  const { vc, ran } = makeController();
  vc._onResult(event(result([['打开背包', 0.9]])));
  assert.deepEqual(ran, ['goProfile']);
});
test('controller 03：记录延迟（毫秒）', () => {
  const { vc } = makeController();
  vc._onResult(event(result([['刷新', 0.9]])));
  const last = vc.log.at(-1);
  assert.equal(last.ev, 'command');
  assert.ok(last.latencyMs >= 0 && last.latencyMs < 500);
});
test('controller 04：低于最小置信度的结果被过滤（噪音）', () => {
  const { vc, ran } = makeController({ vc: { minConfidence: 0.6 } });
  vc._onResult(event(result([['投球', 0.3]])));
  assert.deepEqual(ran, []);
  assert.equal(vc.log.at(-1).ev, 'unknown');
});
test('controller 05：候选中取第一个可解析且达标的', () => {
  const { vc, ran } = makeController();
  vc._onResult(event(result([['偷球', 0.9], ['投球', 0.8]])));
  assert.deepEqual(ran, ['throw']);
});
test('controller 06：非最终结果跳过', () => {
  const { vc, ran } = makeController();
  vc._onResult(event(result([['投球', 0.9]], false)));
  assert.deepEqual(ran, []);
});
test('controller 07：未识别时语音反馈"没有听懂"', () => {
  const { vc, said } = makeController();
  vc._onResult(event(result([['今天吃什么', 0.9]])));
  assert.match(said.at(-1), /没有听懂/);
});
test('controller 08：执行后反馈"已执行：动作名"', () => {
  const { vc, said } = makeController();
  vc._onResult(event(result([['打开设置', 0.9]])));
  assert.equal(said.at(-1), '已执行：打开无障碍设置');
});
test('controller 09：关闭反馈时不播报', () => {
  const { vc, said } = makeController({ vc: { feedback: false } });
  vc._onResult(event(result([['打开设置', 0.9]]), result([['嗯嗯', 0.9]])));
  assert.equal(said.length, 0);
});
test('controller 10：自定义命令来自 customCommands 回调（含宏）', () => {
  const { vc, ran } = makeController({ deps: { customCommands: () => [{ phrase: '一套连招', action: 'macro:2' }] } });
  vc._onResult(event(result([['来一套连招', 0.9]])));
  assert.deepEqual(ran, ['macro:2']);
});
test('controller 11：多个结果依次处理；置信度 0（浏览器未提供）视为可信', () => {
  const { vc, ran } = makeController();
  vc._onResult(event(result([['超级球', 0]]), result([['投球', 0.95]])));
  assert.deepEqual(ran, ['ballGreat', 'throw']);
});
test('controller 12：英文识别语言', () => {
  const { vc, ran } = makeController({ recLang: 'en-US' });
  vc._onResult(event(result([['go back', 0.9]])));
  assert.deepEqual(ran, ['flee']);
});

// ── VoiceFeedback（LiveAnnouncer.speak / 过滤） ────────────────
function announcer(sr = {}, onSpeak) {
  const prefs = mergePrefs(DEFAULT_PREFS, { screenReader: sr });
  return new LiveAnnouncer({ getPrefs: () => prefs, onSpeak });
}
test('feedback 01：Node 环境无 speechSynthesis 时 speechSupported=false', () => assert.equal(announcer().speechSupported, false));
test('feedback 02：speak 记录文本并返回 false（无 TTS 引擎）', () => {
  const a = announcer();
  assert.equal(a.speak('你好'), false);
  assert.equal(a.spoken.at(-1).text, '你好');
});
test('feedback 03：语速/音调/音量取自偏好', () => {
  const a = announcer({ rate: 1.5, pitch: 0.8, volume: 0.4 });
  a.speak('x');
  const e = a.spoken.at(-1);
  assert.deepEqual([e.rate, e.pitch, e.volume], [1.5, 0.8, 0.4]);
});
test('feedback 04：语言解析（ja → ja-JP，ar → en-US 回退）', () => {
  const a = announcer();
  a.speak('x', { lang: 'ja' });
  assert.equal(a.spoken.at(-1).lang, 'ja-JP');
  a.speak('x', { lang: 'ar-SA' });
  assert.equal(a.spoken.at(-1).lang, 'en-US');
});
test('feedback 05：onSpeak 回调（字幕）收到同一文本', () => {
  const got = [];
  const a = announcer({}, (e) => got.push(e.text));
  a.speak('字幕同步');
  assert.deepEqual(got, ['字幕同步']);
});
test('feedback 06：onSpeak 抛错不影响播报', () => {
  const a = announcer({}, () => { throw new Error('boom'); });
  assert.doesNotThrow(() => a.speak('x'));
});
test('feedback 07：spoken 记录上限 100 条', () => {
  const a = announcer();
  for (let i = 0; i < 130; i++) a.speak(`m${i}`);
  assert.equal(a.spoken.length, 100);
  assert.equal(a.spoken[0].text, 'm30');
});
test('feedback 08：播报级别过滤在挂载 DOM 前生效', () => {
  const a = announcer({ verbosity: 'critical' });
  assert.equal(a.announce('普通', { level: 'info' }), false);
  assert.equal(a.history.at(-1).skipped, true);
});
test('feedback 09：播报类别关闭时非 critical 消息被跳过', () => {
  const a = announcer({ categories: { ...DEFAULT_PREFS.screenReader.categories, map: false } });
  assert.equal(a.announce('附近有 3 只精灵', { level: 'important', category: 'map' }), false);
});
test('feedback 10：空消息不播报', () => assert.equal(announcer().announce(''), false));
test('feedback 11：tone 在无 AudioContext 时仍记录（空间音频参数）', () => {
  const a = announcer();
  assert.equal(a.tone(660, { pan: -0.5 }), false);
  assert.deepEqual([a.toneLog.at(-1).freq, a.toneLog.at(-1).pan], [660, -0.5]);
});
test('feedback 12：shouldAnnounce 矩阵', () => {
  assert.deepEqual(['info', 'important', 'critical'].map((l) => shouldAnnounce(l, 'minimal')), [false, true, true]);
});

// ── 宏 / 类别 / 战斗提示 ─────────────────────────────────────
test('prefs：宏最多 9 个、每个最多 8 步、非法步骤被丢弃', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `m${i}`, steps: ['ballGreat', 'throw', 'bad step!', ...Array(10).fill('throw')] }));
  const p = sanitizePrefs({ motor: { macros: many } });
  assert.equal(p.motor.macros.length, 9);
  assert.equal(p.motor.macros[0].steps.length, 8);
  assert.ok(!p.motor.macros[0].steps.includes('bad step!'));
  assert.equal(sanitizePrefs({ motor: { macros: [{ name: '', steps: ['throw'] }, { name: 'x', steps: [] }] } }).motor.macros.length, 0);
});
test('prefs：播报类别默认全开', () => {
  assert.ok(Object.values(DEFAULT_PREFS.screenReader.categories).every(Boolean));
  assert.equal(sanitizePrefs({ screenReader: { categories: { map: false, bogus: false } } }).screenReader.categories.map, false);
});
test('战斗视觉提示：胜负/倒下为 P0（≥2 通道），文案三语齐全', () => {
  const hearing = { ...DEFAULT_PREFS.hearing, visualCues: true };
  for (const k of ['battle:win', 'battle:lose', 'battle:faint']) assert.ok(planCue(k, hearing).channels.length >= 3, k);
  for (const k of Object.keys(CUE_DEFS).filter((x) => x.startsWith('battle:'))) {
    for (const lang of ['zh-CN', 'en-US', 'ja-JP']) {
      assert.ok(t(CUE_DEFS[k].label, lang) && !String(t(CUE_DEFS[k].label, lang)).startsWith('cue_'), `${k} ${lang}`);
      assert.ok(t(CUE_DEFS[k].caption, lang), `${k} caption ${lang}`);
    }
  }
});
