// frontend/game-client/src/bootstrap/a11y.js
// 无障碍相关模块装配（Epic E21）：由 src/bootstrap/features.js 调用 initAccessibility(ctx)。
// ctx: { api, store, toast, catchEng?, locMgr? }
// 暴露 window.showAccessibilitySettings()（"我的 → 无障碍设置"入口）与 window.PMG_A11Y（运行期状态，供 index.html 与测试读取）。
import { A11yPrefsStore, PACE_VALUES } from '../accessibility/prefs.js';
import { LiveAnnouncer } from '../accessibility/liveAnnouncer.js';
import { SubtitleManager } from '../accessibility/subtitles.js';
import { PaceController } from '../accessibility/pace.js';
import { FlashGuard, runSensitivityTest } from '../accessibility/photosensitive.js';
import { VisualCueManager, CUE_DEFS } from '../accessibility/soundCues.js';
import { DirectionManager } from '../accessibility/textDirection.js';
import { CognitiveAssist } from '../accessibility/cognitive.js';
import { MotorAssist } from '../accessibility/motorAssist.js';
import { ShortcutManager } from '../accessibility/shortcuts.js';
import { GamepadController } from '../accessibility/gamepad.js';
import { VoiceController } from '../accessibility/voiceControl.js';
import { SemanticEnhancer } from '../accessibility/semantics.js';
import { SettingsPanel } from '../accessibility/settingsPanel.js';
import { openDialog, focusableIn, isDialogOpen } from '../accessibility/dialog.js';
import { paletteFor, fixPalette, correctionMatrix, toFeColorMatrix, SIM_MATRICES, typeBadge } from '../accessibility/colorVision.js';
import { describeSpawns, summarizeNearby, spawnLabel, toneForDistance } from '../accessibility/mapSpeech.js';
import { t, currentLang } from '../accessibility/strings.js';
import { hapticManager } from '../haptics/HapticManager.js';

const HC = {
  high: { bg: '#000000', surface: '#000000', surface2: '#0a0a0a', border: '#ffffff', text: '#ffffff', muted: '#ffff66', blue: '#66b3ff', red: '#ff7070', green: '#5dff9b', yellow: '#ffe600', purple: '#e0b0ff' },
  max: { bg: '#000000', surface: '#000000', surface2: '#000000', border: '#ffffff', text: '#ffffff', muted: '#ffffff', blue: '#ffe600', red: '#ff9090', green: '#7dffb0', yellow: '#ffe600', purple: '#ffffff' },
  enhanced: { muted: '#a7afbf', border: '#4a5165' },
};

function injectCss() {
  if (document.getElementById('a11y-css')) return;
  const link = document.createElement('link');
  link.id = 'a11y-css';
  link.rel = 'stylesheet';
  link.href = new URL('../accessibility/a11y.css', import.meta.url).href;
  document.head.appendChild(link);
}

function ensureFilters() {
  let svg = document.getElementById('a11y-filters');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'a11y-filters';
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    svg.innerHTML = '<filter id="a11y-cvd-correct" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix"/></filter>'
      + '<filter id="a11y-cvd-sim" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix"/></filter>';
    document.body.appendChild(svg);
  }
  return svg;
}

export async function initAccessibility(ctx = {}) {
  const { api, toast = window.toast, catchEng = null, locMgr = null } = ctx;
  injectCss();
  const store = new A11yPrefsStore({ api });
  const P = () => store.prefs;
  const lang = () => currentLang();
  const enabled = [];

  // ── 基础服务 ───────────────────────────────────────────
  let pace;
  const subtitles = new SubtitleManager({ getPrefs: P, holdScale: () => (pace ? pace.holdScale() : 1) });
  const announcer = new LiveAnnouncer({ getPrefs: P, onSpeak: (e) => subtitles.show(e.text, { kind: 'speech', eventAt: e.t }) });
  announcer.mount();
  pace = new PaceController({ getPrefs: P, catchEng });
  const flashGuard = new FlashGuard({ getPrefs: P });
  const cues = new VisualCueManager({ getPrefs: P, holdScale: () => pace.holdScale() });
  const direction = new DirectionManager({ getPrefs: P, onChange: (dir) => announcer.announce(dir === 'rtl' ? 'Right-to-left layout' : '', { level: 'info', speak: false }) });
  const cognitive = new CognitiveAssist({ getPrefs: P, setPrefs: (patch) => store.set(patch), announcer });
  const motor = new MotorAssist({ getPrefs: P, announcer, haptics: hapticManager, catchEng, isCompetitive: () => !!pace.competitive });

  const state = { screen: (document.querySelector('.screen.active') || {}).id || 'login', spawn: null, nearby: null, seen: new Set(), firstNearby: true, lastMove: 0, psPrompted: false };
  const activeScreen = () => (document.querySelector('.screen.active') || {}).id;

  // ── 统一事件出口：播报 + 视觉提示 + 字幕 + 提示音 + 震动 ─────────
  function emit(type, { text, speakText, level = 'important', haptic = true, earcon = true, pan = 0 } = {}) {
    const def = CUE_DEFS[type];
    const L = lang();
    cues.show(type, { text, lang: L });
    if (def) {
      subtitles.show(t(def.caption, L), { kind: 'caption' });
      if (earcon && def.earcon && (P().screenReader.spatialAudio || P().motor.audioCue || P().screenReader.speech)) announcer.earcon(def.earcon, { pan });
      if (haptic && def.haptic) hapticManager.vibrate(def.haptic);
    }
    if (speakText) announcer.announce(speakText, { level });
    document.dispatchEvent(new CustomEvent('pmg:a11y-event', { detail: { type, text } }));
  }

  // ── 应用偏好到页面 ─────────────────────────────────────
  let voice;
  function applyAll() {
    const p = P();
    const html = document.documentElement;
    html.classList.toggle('a11y-photosafe', p.photosensitive.enabled);
    html.classList.toggle('a11y-reduce-motion', p.photosensitive.reduceMotion);
    const contrast = p.color.highContrast && p.color.contrast === 'normal' ? 'high' : p.color.contrast;
    html.classList.toggle('a11y-high-contrast', p.color.highContrast || contrast === 'high' || contrast === 'max');
    html.setAttribute('data-a11y-contrast', contrast);
    html.setAttribute('data-a11y-cvd', p.color.mode);
    html.classList.toggle('a11y-shapes', p.color.shapes || p.color.mode === 'achromatopsia');
    // 调色板：色觉模式替换 → 对比度级别覆盖
    // 预设色觉模式自动保证与背景 ≥4.5:1；自定义调色板尊重用户选择（面板内提示并可一键修正）
    let pal = paletteFor(p.color.mode, p.color.palette);
    if (p.color.mode !== 'custom') pal = fixPalette(pal);
    if (contrast === 'high' || contrast === 'max') Object.assign(pal, HC[contrast]);
    else if (contrast === 'enhanced') Object.assign(pal, HC.enhanced);
    const custom = p.color.mode !== 'none' || contrast !== 'normal';
    for (const k of ['bg', 'surface', 'surface2', 'border', 'text', 'muted', 'red', 'blue', 'yellow', 'green', 'purple']) {
      if (custom && pal[k]) html.style.setProperty(`--${k}`, pal[k]); else html.style.removeProperty(`--${k}`);
    }
    // 色彩校准滤镜 / 开发者模拟预览
    const filters = [];
    const svg = ensureFilters();
    if (p.color.filter && ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'].includes(p.color.mode)) {
      svg.querySelector('#a11y-cvd-correct feColorMatrix').setAttribute('values', toFeColorMatrix(correctionMatrix(p.color.mode, p.color.filterStrength)));
      filters.push('url(#a11y-cvd-correct)');
    }
    if (p.color.simulate !== 'none') {
      svg.querySelector('#a11y-cvd-sim feColorMatrix').setAttribute('values', toFeColorMatrix(SIM_MATRICES[p.color.simulate]));
      filters.push('url(#a11y-cvd-sim)');
    }
    document.body.style.filter = filters.join(' ');
    document.body.style.zoom = p.display.uiScale !== 1 ? String(p.display.uiScale) : '';
    // 触觉
    hapticManager.setEnabled(p.haptics.enabled);
    hapticManager.setScalePercent(p.haptics.intensity);
    hapticManager.setScenes(p.haptics.scenes);
    // #toasts 已改由 announcer 转播（带播报级别），避免重复朗读
    const tb = document.getElementById('toasts');
    if (tb) tb.setAttribute('aria-live', 'off');
    pace.apply();
    direction.apply();
    cognitive.apply();
    motor.apply();
    subtitles.applyStyle();
    if (voice) { if (p.voiceControl.enabled) voice.start(); else voice.stop(); }
    renderStatus();
  }

  // ── 状态徽章 ───────────────────────────────────────────
  function renderStatus() {
    let box = document.getElementById('a11y-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'a11y-status';
      box.className = 'a11y-keep-visible';
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', '无障碍状态');
      document.body.appendChild(box);
    }
    const p = P();
    const pills = [];
    const cs = pace.catchScale();
    const us = pace.uiScale();
    if (pace.competitive) pills.push(`<span class="a11y-pill" data-testid="a11y-competitive">🏆 竞技模式：辅助已禁用</span>`);
    else if (cs !== 1 || us !== 1 || p.pace.battle !== 1) pills.push(`<span class="a11y-pill" data-testid="a11y-speed-badge">⏱ ${t('speed_badge', lang(), { x: (p.pace.catch !== 1 ? p.pace.catch : us !== 1 ? us : p.pace.battle).toFixed(2).replace(/0$/, '') })}</span>`);
    if (motor.active()) pills.push('<span class="a11y-pill" data-testid="a11y-motor-badge">✋ 动作辅助</span>');
    if (p.photosensitive.enabled || flashGuard.stopped) {
      pills.push(`<button type="button" class="a11y-pill" data-testid="a11y-emergency-stop" aria-pressed="${flashGuard.stopped}">${flashGuard.stopped ? '▶ 恢复动画' : '⏹ 停止动画'}</button>`);
    }
    box.innerHTML = pills.join('');
    const btn = box.querySelector('[data-testid="a11y-emergency-stop"]');
    if (btn) btn.addEventListener('click', toggleEmergency);
  }

  function toggleEmergency() {
    flashGuard.setStopped(!flashGuard.stopped);
    announcer.announce(t(flashGuard.stopped ? 'anim_stopped' : 'anim_resumed', lang()), { level: 'critical' });
    renderStatus();
  }

  // ── 动作注册表（快捷键 / 手柄 / 语音共用） ───────────────
  const click = (sel) => { const el = document.querySelector(sel); if (!el || el.disabled) return false; el.click(); return true; };
  const onScreen = (id) => activeScreen() === id;
  const scrollActive = (dx, dy) => {
    const el = onScreen('map') ? document.getElementById('map-body') : document.querySelector('.screen.active');
    if (!el) return false;
    el.scrollBy({ left: dx, top: dy, behavior: 'auto' });
    return true;
  };
  const spawnCards = () => [...document.querySelectorAll('#map-body .entity-card[role="button"]')];
  const moveCard = (delta) => {
    if (!onScreen('map')) return false;
    const cards = spawnCards();
    if (!cards.length) return false;
    const i = cards.indexOf(document.activeElement);
    const next = cards[(i + delta + cards.length) % cards.length] || cards[0];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    return true;
  };
  const stepPace = (dir) => {
    const cur = P().pace.ui;
    const i = PACE_VALUES.indexOf(cur);
    const v = PACE_VALUES[Math.max(0, Math.min(PACE_VALUES.length - 1, i + dir))];
    store.set({ pace: { catch: v, ui: v, battle: v, preset: 'custom' } });
    announcer.announce(t('speed_badge', lang(), { x: v }), { level: 'important' });
  };
  const readMap = async () => {
    if (!state.nearby && api) {
      try { onNearby(await api.getNearby(pos().lat, pos().lng, 2000), true); return true; } catch { /* ignore */ }
    }
    const s = summarizeNearby(state.nearby || {}, pos(), lang());
    announcer.announce(s.text, { level: 'important' });
    if (P().screenReader.spatialAudio && s.spawns[0]) {
      announcer.tone(toneForDistance(s.spawns[0].distance), { pan: s.spawns[0].pan, ms: 220 });
    }
    return true;
  };

  const actions = {
    help: { label: '快捷键帮助', run: () => { shortcuts.showHelp(); }, announce: false },
    settings: { label: '打开无障碍设置', run: () => { panel.open(); }, announce: false },
    goMap: { label: '地图', run: () => { if (!document.getElementById('nav')?.classList.contains('show')) return false; window.goScreen('map'); } },
    goProfile: { label: '我的', run: () => { if (!document.getElementById('nav')?.classList.contains('show')) return false; window.goScreen('profile'); } },
    refresh: { label: '刷新地图', run: () => { if (!onScreen('map')) return false; window.goScreen('map'); } },
    nextCard: { label: '下一个地图项目', run: () => moveCard(1), announce: false },
    prevCard: { label: '上一个地图项目', run: () => moveCard(-1), announce: false },
    panUp: { label: '地图向上移动', run: () => scrollActive(0, -120), announce: false },
    panDown: { label: '地图向下移动', run: () => scrollActive(0, 120), announce: false },
    panLeft: { label: '地图向左移动', run: () => scrollActive(-120, 0), announce: false },
    panRight: { label: '地图向右移动', run: () => scrollActive(120, 0), announce: false },
    readMap: { label: '播报附近', run: () => { readMap(); }, announce: false },
    describe: { label: '语音描述精灵', run: () => { describe(); }, announce: false },
    ballPoke: { label: t('balls', 'zh-CN').POKE_BALL, run: () => onScreen('catch') && click('#chip-poke') },
    ballGreat: { label: t('balls', 'zh-CN').GREAT_BALL, run: () => onScreen('catch') && click('#chip-great') },
    ballUltra: { label: t('balls', 'zh-CN').ULTRA_BALL, run: () => onScreen('catch') && click('#chip-ultra') },
    throw: { label: '投球', run: () => onScreen('catch') && click('#throw-btn') },
    flee: { label: '逃跑并返回地图', run: () => { if (!onScreen('catch')) return false; window.exitCatch(); } },
    status: { label: '播报状态', run: () => { announceStatus(); }, announce: false },
    toggleSpeech: { label: '切换语音播报', run: () => { store.set('screenReader.speech', !P().screenReader.speech); announcer.announce(P().screenReader.speech ? '语音播报已开启' : '语音播报已关闭', { level: 'important' }); }, announce: false },
    highContrast: { label: '切换高对比度', run: () => { const on = !P().color.highContrast; store.set({ color: { highContrast: on, contrast: on ? 'high' : 'normal' } }); } },
    slower: { label: '降低游戏速度', run: () => { stepPace(-1); }, announce: false },
    faster: { label: '提高游戏速度', run: () => { stepPace(1); }, announce: false },
    toggleMotor: { label: '切换动作辅助', run: () => { store.set('motor.enabled', !P().motor.enabled); announcer.announce(t(P().motor.enabled ? 'motor_on' : 'motor_off', lang()), { level: 'important' }); }, announce: false },
    toggleVoice: { label: '切换语音控制', run: () => { store.set('voiceControl.enabled', !P().voiceControl.enabled); if (!P().voiceControl.enabled) announcer.announce(t('voice_stopped', lang()), { level: 'important' }); }, announce: false },
    readPage: { label: '朗读当前页面', run: () => { const s = document.querySelector('.screen.active'); if (s) announcer.speak(s.innerText.replace(/\s+/g, ' ').slice(0, 400)); }, announce: false },
    // 仅语音/手柄
    catchNearest: { label: '捕捉最近的精灵', run: () => { if (!onScreen('map')) return false; const c = spawnCards()[0]; if (!c) return false; c.click(); } },
    stopAnimations: { label: '紧急停止动画', run: () => { toggleEmergency(); }, announce: false },
    repeat: { label: '重复播报', run: () => { const last = [...announcer.history].reverse().find((h) => !h.skipped); if (last) announcer.announce(last.message, { level: 'critical' }); }, announce: false },
    stopListening: { label: '关闭语音控制', run: () => { store.set('voiceControl.enabled', false); }, announce: false },
    prevBall: { label: '上一个精灵球', run: () => cycleBall(-1), announce: false },
    nextBall: { label: '下一个精灵球', run: () => cycleBall(1), announce: false },
  };
  const runAction = (id) => { const a = actions[id]; return a ? a.run() !== false : false; };
  function cycleBall(d) {
    if (!onScreen('catch')) return false;
    const chips = [...document.querySelectorAll('.ball-chip')];
    const i = chips.findIndex((c) => c.classList.contains('sel'));
    const next = chips[(i + d + chips.length) % chips.length];
    next.click(); next.focus();
    return true;
  }

  const shortcuts = new ShortcutManager({ getPrefs: P, setPref: (p, v) => store.set(p, v), actions, announcer, onEmergency: toggleEmergency });

  // ── 手柄 ───────────────────────────────────────────────
  const focusScope = () => document.querySelector('.a11y-dialog-backdrop .a11y-dialog') || document.querySelector('#lang-modal > div') || document.querySelector('.screen.active');
  const focusables = () => {
    const scope = focusScope();
    const items = scope ? focusableIn(scope) : [];
    if (!isDialogOpen() && document.getElementById('nav')?.classList.contains('show')) items.push(...focusableIn(document.getElementById('nav')));
    return items;
  };
  const moveFocus = (d) => {
    const items = focusables();
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = items[(i + d + items.length) % items.length];
    next.focus();
    if (next.scrollIntoView) next.scrollIntoView({ block: 'nearest' });
  };
  const gamepad = new GamepadController({
    getPrefs: P, announcer, toast, haptics: hapticManager,
    actions: {
      focusNext: () => moveFocus(1),
      focusPrev: () => moveFocus(-1),
      activate: () => { const el = document.activeElement; if (el && el !== document.body) el.click(); else moveFocus(1); },
      cancel: () => {
        if (isDialogOpen() || document.getElementById('lang-modal')) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const lm = document.getElementById('lang-modal'); if (lm) lm.remove();
        } else if (onScreen('catch')) window.exitCatch();
        else if (onScreen('profile')) window.goScreen('map');
      },
      run: (a) => runAction(a),
      scrollMap: (dx, dy) => scrollActive(dx, dy),
    },
  });

  // ── 语音控制 ───────────────────────────────────────────
  voice = new VoiceController({ getPrefs: P, run: runAction, announcer, lang });

  // ── 设置面板 ───────────────────────────────────────────
  const panel = new SettingsPanel({
    store, announcer,
    services: {
      announcer, flashGuard, shortcuts, gamepad, cues, haptics: hapticManager, cognitive, voice,
      toggleEmergency,
      runSensitivityTest: () => runSensitivityTest({
        announce: (m) => announcer.announce(m, { level: 'info' }),
        onDone: ({ config, results }) => {
          store.set({ photosensitive: { ...config, tested: true }, hearing: config.flashCues === false ? { flash: false } : {} });
          announcer.announce(`测试完成，敏感度：${{ low: '低', medium: '中', high: '高' }[config.sensitivity]}，已应用推荐设置`, { level: 'important' });
          state.psResults = results;
        },
      }),
    },
  });

  // ── 语义化与屏幕切换 ─────────────────────────────────────
  const semantics = new SemanticEnhancer({
    labelSpawn: (spawn) => {
      const s = describeSpawns([spawn], state.nearby ? pos() : pos(), lang())[0];
      return s ? spawnLabel(s, lang()) : null;
    },
    onScreen: (id) => onScreenChange(id),
  });

  function onScreenChange(id) {
    if (id === state.screen) return;
    state.screen = id;
    const html = document.documentElement;
    html.setAttribute('data-a11y-screen', id);
    html.classList.toggle('a11y-nav-shown', !!document.getElementById('nav')?.classList.contains('show'));
    announcer.announce(t('entered', lang(), { screen: t(`screen_${id}`, lang()) }), { level: 'info' });
    cognitive.updateHint(id);
    motor.updateTrajectory();
    if (id !== 'catch') { document.getElementById('a11y-type-badges')?.remove(); document.getElementById('a11y-ps-prompt')?.remove(); }
    // 焦点移到新页面标题，屏幕阅读器用户获得上下文（非对话框场景）
    if (!isDialogOpen()) {
      const screen = document.getElementById(id);
      const h = screen && screen.querySelector('[role="heading"], .catch-headline, .user-name');
      if (h && document.activeElement && (document.activeElement === document.body || !screen.contains(document.activeElement))) {
        if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
        try { h.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    }
  }

  // ── 游戏事件接入 ───────────────────────────────────────
  const pos = () => {
    const p = locMgr && locMgr.currentPosition;
    return p && Number.isFinite(p.lat) ? { lat: p.lat, lng: p.lng } : { lat: 31.2304, lng: 121.4737 };
  };

  function onNearby(data, force = false) {
    if (!data) return;
    state.nearby = data;
    const L = lang();
    const spawns = describeSpawns(data.wildPokemons || data.wild_pokemons || [], pos(), L);
    const fresh = spawns.filter((s) => s.id && !state.seen.has(s.id));
    spawns.forEach((s) => state.seen.add(s.id));
    const sr = P().screenReader;
    if (state.firstNearby || force) {
      state.firstNearby = false;
      if (spawns.length) emit('pokemon:spawn', { text: spawns[0].name, haptic: true });
      if (sr.autoMapSummary && onScreen('map')) announcer.announce(summarizeNearby(data, pos(), L).text, { level: 'info' });
    } else if (fresh.length) {
      const n = fresh[0];
      emit('pokemon:spawn', { text: n.name, speakText: t('spawn_new', L, { name: n.name, dir: n.direction, dist: n.distance }), level: 'important', pan: n.pan });
    } else if (spawns[0] && Date.now() - state.lastMove > 10000 && state.nearest && state.nearest.id === spawns[0].id
      && (Math.abs((state.nearest.distance || 0) - (spawns[0].distance || 0)) >= 20 || state.nearest.direction !== spawns[0].direction)) {
      // 最近精灵方位/距离明显变化时播报（REQ-00337）
      state.lastMove = Date.now();
      announcer.announce(t('spawn_new', L, { name: spawns[0].name, dir: spawns[0].direction, dist: spawns[0].distance }).replace(/^[^：:]+[：:]\s*/, ''), { level: 'info' });
    }
    state.nearest = spawns[0] || null;
    if (sr.spatialAudio && spawns[0] && spawns[0].distance !== null) announcer.tone(toneForDistance(spawns[0].distance), { pan: spawns[0].pan, ms: 180 });
    requestAnimationFrame(() => semantics.enhanceMap());
  }

  if (api) {
    const wrap = (name, after) => {
      const orig = api[name];
      if (typeof orig !== 'function' || orig._a11y) return;
      const fn = async function (...args) {
        const res = await orig.apply(this, args);
        try { after(res, args); } catch (err) { console.warn('[a11y] hook', name, err); }
        return res;
      };
      fn._a11y = true;
      api[name] = fn;
    };
    wrap('getNearby', (res) => onNearby(res));
    wrap('spinPokestop', () => emit('item:pickup', { speakText: t('item_pickup', lang()), level: 'important' }));
    wrap('login', () => { store.pull(); });
    wrap('register', () => { store.pull(); });
  }

  // 进入捕捉：记录目标精灵，播报，属性形状标识，首次高风险场景光敏提示
  if (typeof window.openCatch === 'function' && !window.openCatch._a11y) {
    const orig = window.openCatch;
    window.openCatch = function (encoded) {
      try {
        const spawn = JSON.parse(decodeURIComponent(encoded));
        const s = describeSpawns([spawn], pos(), lang())[0];
        state.spawn = { ...spawn, _desc: s };
        announcer.announce(t('catch_open', lang(), { name: s.name, cp: spawn.cp || '?' }), { level: 'important' });
        if (P().screenReader.spatialAudio && s.distance !== null) announcer.tone(toneForDistance(s.distance), { pan: s.pan, ms: 240 });
        cognitive.remember({ name: s.name, lat: spawn.lat, lng: spawn.lng, kind: 'encounter' });
        setTimeout(() => { showTypeBadges(spawn); maybePromptPhotosensitive(); motor.updateTrajectory(); }, 50);
      } catch { /* ignore */ }
      return orig.apply(this, arguments);
    };
    window.openCatch._a11y = true;
  }

  if (catchEng) {
    catchEng.addEventListener('throwPending', (e) => emit('catch:throw', { haptic: false, earcon: true, text: e.detail && e.detail.throwRating }));
    catchEng.addEventListener('caught', () => {
      emit('catch:success', { haptic: false });
      if (state.spawn) cognitive.remember({ name: state.spawn._desc && state.spawn._desc.name, lat: state.spawn.lat, lng: state.spawn.lng, kind: 'caught' });
      cognitive.warnChange(t('change_warning', lang()), 1800);
    });
    catchEng.addEventListener('fled', () => { emit('catch:fled', { haptic: false }); cognitive.warnChange(t('change_warning', lang()), 1500); });
    catchEng.addEventListener('ballUsed', () => emit('catch:escape', { haptic: false }));
    catchEng.addEventListener('throwMiss', () => announcer.announce(t('catch_miss', lang()), { level: 'important' }));
    catchEng.addEventListener('ballSelected', (e) => {
      const b = t('balls', lang())[e.detail && e.detail.ballType];
      if (b) announcer.announce(t('ball_selected', lang(), { ball: b }), { level: 'info' });
    });
  }

  // toast 转播：错误 → critical/assertive + 警告视觉提示与震动
  const toastBox = document.getElementById('toasts');
  if (toastBox) {
    new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1 || !n.classList.contains('toast')) return;
        const text = n.textContent.trim();
        n.setAttribute('dir', 'auto');
        n.setAttribute('role', n.classList.contains('err') ? 'alert' : 'status');
        if (n.classList.contains('err')) {
          announcer.announce(text, { level: 'critical' });
          emit('warning', { text, earcon: true });
        } else {
          announcer.announce(text, { level: n.classList.contains('ok') ? 'important' : 'info' });
        }
      });
    }).observe(toastBox, { childList: true });
  }

  // 界面点击触觉（无障碍增强）
  document.addEventListener('click', (e) => {
    if (!P().haptics.enhanced) return;
    if (e.target.closest && e.target.closest('button, [role="button"], [role="radio"], [role="link"]')) hapticManager.vibrate('button_press');
  }, true);

  // 地图卡片获得焦点：距离音调 + 空间声像
  document.addEventListener('focusin', (e) => {
    const card = e.target.closest && e.target.closest('.a11y-spawn-card');
    if (!card || !P().screenReader.spatialAudio || !state.nearby) return;
    const spawns = describeSpawns(state.nearby.wildPokemons || [], pos(), lang());
    const s = spawns.find((x) => String(x.id) === card.dataset.spawnId);
    if (s && s.distance !== null) announcer.tone(toneForDistance(s.distance), { pan: s.pan, ms: 150 });
  });

  window.addEventListener('pmg:logout', () => { state.seen.clear(); state.firstNearby = true; state.nearby = null; });

  // 休息 / 疲劳提醒
  const restDialog = (msg) => {
    const d = openDialog({ id: 'a11y-rest', title: '休息提醒', content: `<p>${msg}</p><div class="a11y-row"><button type="button" class="a11y-btn a11y-btn-primary" data-rest="ok">继续游戏</button></div>` });
    d.body.querySelector('[data-rest="ok"]').addEventListener('click', d.close);
    announcer.announce(msg, { level: 'critical' });
  };
  document.addEventListener('pmg:a11y-break', () => restDialog(t('break_reminder', lang())));
  document.addEventListener('pmg:a11y-fatigue', (e) => restDialog(t('fatigue', lang(), { n: e.detail.throws })));

  // ── 语音描述（REQ-00337） ───────────────────────────────
  async function describe() {
    let spawn = null;
    if (onScreen('catch')) spawn = state.spawn;
    else {
      const card = document.activeElement && document.activeElement.closest && document.activeElement.closest('.a11y-spawn-card');
      if (card && state.nearby) spawn = (state.nearby.wildPokemons || []).find((p) => String(p.id) === card.dataset.spawnId);
    }
    if (!spawn) { announcer.announce('请先聚焦一只精灵', { level: 'important' }); return false; }
    const sid = spawn.species_id || spawn.speciesId;
    let text = null;
    if (api && sid) {
      try {
        const d = await api.get(`/pokemon/species/${sid}/voice-description?lang=${encodeURIComponent(lang())}&cp=${Number(spawn.cp) || ''}`);
        text = d && d.text;
        state.lastDescription = d;
      } catch { /* 回退到本地描述 */ }
    }
    if (!text) { const s = describeSpawns([spawn], pos(), lang())[0]; text = spawnLabel(s, lang()); }
    announcer.announce(text, { level: 'critical', priority: 'polite' });
    return true;
  }

  async function showTypeBadges(spawn) {
    if (!(P().color.shapes || P().color.mode !== 'none') || !api) return;
    const sid = spawn.species_id || spawn.speciesId;
    if (!sid) return;
    try {
      const d = await api.get(`/pokemon/species/${sid}/voice-description?lang=${encodeURIComponent(lang())}`);
      const host = document.getElementById('c-cp');
      if (!host || !onScreen('catch')) return;
      document.getElementById('a11y-type-badges')?.remove();
      const box = document.createElement('div');
      box.id = 'a11y-type-badges';
      box.className = 'a11y-type-badges';
      box.setAttribute('aria-label', `属性：${d.types.map((x) => x.label).join('、')}`);
      box.setAttribute('role', 'group');
      for (const ty of d.types) {
        const b = typeBadge(ty.type, lang()) || ty;
        const span = document.createElement('span');
        span.className = 'a11y-type-badge';
        span.dataset.type = ty.type;
        span.textContent = `${b.shape} ${ty.label}`;
        box.appendChild(span);
      }
      host.insertAdjacentElement('afterend', box);
    } catch { /* ignore */ }
  }

  function maybePromptPhotosensitive() {
    const ps = P().photosensitive;
    if (!ps.promptOnRisk || ps.tested || ps.enabled || state.psPrompted || !onScreen('catch')) return;
    state.psPrompted = true;
    const bar = document.createElement('div');
    bar.id = 'a11y-ps-prompt';
    bar.className = 'a11y-keep-visible';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', '光敏安全提示');
    bar.innerHTML = '<span>捕捉场景含动画特效。对闪烁敏感？可先做 30 秒光敏测试。</span><div class="a11y-row">'
      + '<button type="button" class="a11y-btn a11y-btn-sm" data-ps="test">开始测试</button>'
      + '<button type="button" class="a11y-btn a11y-btn-sm" data-ps="safe">直接开启安全模式</button>'
      + '<button type="button" class="a11y-btn a11y-btn-sm" data-ps="never">不再提示</button></div>';
    bar.addEventListener('click', (e) => {
      const act = e.target.getAttribute && e.target.getAttribute('data-ps');
      if (!act) return;
      bar.remove();
      if (act === 'test') panel.services.runSensitivityTest();
      else if (act === 'safe') store.set({ photosensitive: { enabled: true } });
      else store.set('photosensitive.promptOnRisk', false);
    });
    document.body.appendChild(bar);
  }

  function announceStatus() {
    const g = (id) => (document.getElementById(id) || {}).textContent || '0';
    announcer.announce(`${g('map-lvl')}。精灵球 ${g('r-ball')}，精灵币 ${g('r-coin')}，星尘 ${g('r-dust')}。${g('gps-badge').replace('📍', 'GPS ')}`, { level: 'critical' });
  }

  // ── 启动 ───────────────────────────────────────────────
  const start = (name, fn) => { try { fn(); enabled.push(name); } catch (err) { console.warn(`[a11y] ${name} failed`, err); } };
  start('semantics', () => semantics.start());
  start('direction', () => direction.start());
  start('pace', () => pace.start());
  start('flashGuard', () => flashGuard.start());
  start('cognitive', () => cognitive.start());
  start('motor', () => motor.start());
  start('shortcuts', () => shortcuts.start());
  start('gamepad', () => gamepad.start());
  start('settings', () => { window.showAccessibilitySettings = () => panel.open(); });
  applyAll();
  store.addEventListener('change', () => applyAll());
  const html = document.documentElement;
  html.setAttribute('data-a11y-screen', state.screen);
  const nav = document.getElementById('nav');
  if (nav) new MutationObserver(() => html.classList.toggle('a11y-nav-shown', nav.classList.contains('show'))).observe(nav, { attributes: true, attributeFilter: ['class'] });
  html.classList.toggle('a11y-nav-shown', !!(nav && nav.classList.contains('show')));
  if (localStorage.getItem('pmg_access_token')) store.pull();

  window.PMG_A11Y = {
    store, announcer, subtitles, pace, flashGuard, cues, direction, cognitive, motor, shortcuts, gamepad, voice, panel, semantics,
    haptics: hapticManager, actions, runAction, state, emit, describe, toggleEmergency,
    holdScale: () => pace.holdScale(),
    setCompetitive: (kind) => { pace.setCompetitive(kind); motor.apply(); renderStatus(); if (kind) announcer.announce(t('pace_competitive', lang()), { level: 'important' }); },
  };
  enabled.push('announcer', 'subtitles', 'visualCues', 'haptics', 'voiceControl');
  return { enabled, voiceSupported: voice.supported, speechSupported: announcer.speechSupported };
}
