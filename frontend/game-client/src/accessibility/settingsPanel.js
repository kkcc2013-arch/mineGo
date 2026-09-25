// frontend/game-client/src/accessibility/settingsPanel.js
// 无障碍设置面板（window.showAccessibilitySettings）：原生表单控件 + 分组 <details>，修改即时生效（实时预览）并自动保存/同步。
// 每个控件带 data-pref="路径"，便于自动化测试与屏幕阅读器（label 关联）。
import { openDialog } from './dialog.js';
import { getPath } from './prefs.js';
import { PACE_PRESETS } from './pace.js';
import { MOTOR_PRESETS } from './motorAssist.js';
import { paletteFor, checkPalette, contrastRatio, fixPalette } from './colorVision.js';
import { DEFAULT_BINDINGS, escapeHtml } from './shortcuts.js';
import { COMMANDS, ACTION_LABELS } from './voiceControl.js';
import { GAMEPAD_ACTIONS, BUTTON_LABELS } from './gamepad.js';

const PACE_OPTS = [[0.25, '0.25x'], [0.5, '0.5x'], [0.75, '0.75x'], [1, '1.0x（标准）'], [1.25, '1.25x'], [1.5, '1.5x'], [2, '2.0x']];
const onOff = (pref, label, help) => ({ type: 'checkbox', pref, label, help });
const sel = (pref, label, options, help) => ({ type: 'select', pref, label, options, help });
const range = (pref, label, min, max, step, unit = '', help) => ({ type: 'range', pref, label, min, max, step, unit, help });

export const SECTIONS = [
  {
    id: 'vision', title: '👁 视觉：对比度、色觉与字体', controls: [
      { ...onOff('color.highContrast', '高对比度模式', '纯色背景、白/黄文字、按钮加粗描边（REQ-00566）'), testid: 'high-contrast-toggle' },
      { type: 'custom', render: 'cvdToggle' },
      sel('color.contrast', '对比度级别', [['normal', '普通'], ['enhanced', '增强'], ['high', '高'], ['max', '最大']]),
      { ...sel('color.mode', '色觉模式（智能颜色替换）', [['none', '标准'], ['protanopia', '红色盲'], ['deuteranopia', '绿色盲'], ['tritanopia', '蓝黄色盲'], ['achromatopsia', '全色盲（灰度 + 图案）'], ['custom', '自定义调色板']]), testid: 'colorblind-type-selector', optionTestid: 'colorblind-type-option' },
      onOff('color.filter', '色彩校准滤镜（daltonize）'),
      range('color.filterStrength', '校准强度', 0, 1, 0.1),
      onOff('color.shapes', '形状/图案标识（属性、准确度分区、提示类型）'),
      { type: 'custom', render: 'palette' },
      range('display.uiScale', '界面缩放', 0.8, 1.6, 0.05, 'x'),
      sel('color.simulate', '开发者：色盲模拟预览', [['none', '关闭'], ['protanopia', '模拟红色盲'], ['deuteranopia', '模拟绿色盲'], ['tritanopia', '模拟蓝黄色盲'], ['achromatopsia', '模拟全色盲']]),
    ],
  },
  {
    id: 'photo', title: '⚡ 光敏安全与动画', controls: [
      onOff('photosensitive.enabled', '光敏安全模式（闪烁 ≤ 3 次/秒，提示改为静态高亮）'),
      sel('photosensitive.maxFlashHz', '最大闪烁频率', [[3, '3 次/秒（WCAG 上限）'], [2, '2 次/秒'], [1, '1 次/秒']]),
      onOff('photosensitive.reduceMotion', '减少动画（停用装饰性动画）'),
      onOff('photosensitive.promptOnRisk', '首次进入高风险场景前提示做敏感度测试'),
      { type: 'button', id: 'ps-test', label: '开始光敏敏感度测试' },
      { type: 'button', id: 'emergency', label: '紧急停止/恢复所有动画（双击 Esc）' },
    ],
  },
  {
    id: 'sr', title: '🔊 屏幕阅读器与语音导航', controls: [
      onOff('screenReader.speech', '语音播报（Web Speech 朗读）'),
      sel('screenReader.verbosity', '播报级别', [['full', '全部事件'], ['minimal', '仅重要事件'], ['critical', '仅关键提示']]),
      range('screenReader.rate', '语速', 0.5, 2, 0.1, 'x'),
      range('screenReader.pitch', '音调', 0.5, 2, 0.1, 'x'),
      range('screenReader.volume', '音量', 0, 1, 0.1),
      onOff('screenReader.spatialAudio', '空间音频定位（精灵方位声像 + 距离音调）'),
      onOff('screenReader.autoMapSummary', '地图刷新时自动播报附近摘要'),
      onOff('screenReader.readFocus', '朗读获得焦点的元素'),
      { type: 'button', id: 'test-speech', label: '试听语音' },
    ],
  },
  {
    id: 'hearing', title: '👂 听觉：视觉提示与字幕', controls: [
      onOff('hearing.visualCues', '音效可视化（图标 + 文字 + 边框提示）'),
      sel('hearing.position', '提示位置', [['top-left', '左上'], ['top-right', '右上'], ['bottom-left', '左下'], ['bottom-right', '右下'], ['center', '中央']]),
      range('hearing.durationMs', '提示显示时长', 2000, 10000, 500, 'ms'),
      onOff('hearing.flash', '高优先级事件边框闪烁（光敏模式下自动改为静态）'),
      sel('hearing.intensity', '提示强度', [['low', '低'], ['medium', '中'], ['high', '高']]),
      onOff('hearing.categories.spawn', '提示：精灵出现'), onOff('hearing.categories.catch', '提示：捕捉结果'),
      onOff('hearing.categories.battle', '提示：战斗'), onOff('hearing.categories.warning', '提示：警告/错误'),
      onOff('hearing.categories.ui', '提示：界面通知'), onOff('hearing.categories.social', '提示：社交消息'),
      onOff('subtitles.enabled', '实时字幕（语音播报与音效）'),
      onOff('subtitles.soundCaptions', '字幕包含音效描述，如 [精灵出现的声音]'),
      sel('subtitles.size', '字幕字号', [['small', '小'], ['medium', '中'], ['large', '大'], ['xlarge', '特大']]),
      sel('subtitles.position', '字幕位置', [['bottom', '底部'], ['top', '顶部']]),
      { type: 'color', pref: 'subtitles.color', label: '字幕颜色' },
      { type: 'button', id: 'test-cue', label: '预览视觉提示' },
    ],
  },
  {
    id: 'haptics', title: '📳 触觉反馈', controls: [
      onOff('haptics.enabled', '启用震动'),
      range('haptics.intensity', '震动强度', 0, 200, 10, '%'),
      onOff('haptics.scenes.catch', '场景：捕捉'), onOff('haptics.scenes.battle', '场景：战斗'), onOff('haptics.scenes.ui', '场景：界面操作'),
      onOff('haptics.scenes.navigation', '场景：导航/附近精灵'), onOff('haptics.scenes.special', '场景：升级/成就/道具'),
      onOff('haptics.enhanced', '无障碍增强（界面点击也震动）'),
      { type: 'custom', render: 'hapticPreview' },
    ],
  },
  {
    id: 'pace', title: '⏱ 游戏节奏', controls: [
      sel('pace.preset', '预设', [['accessible', '无障碍（0.5x）'], ['easy', '轻松（0.75x）'], ['standard', '标准（1.0x）'], ['veteran', '老玩家（1.25x）'], ['custom', '自定义']]),
      sel('pace.catch', '捕捉速度（投掷窗口）', PACE_OPTS),
      sel('pace.battle', '战斗速度（躲避窗口）', PACE_OPTS),
      sel('pace.ui', '界面动画与提示速度', PACE_OPTS),
    ],
  },
  {
    id: 'motor', title: '✋ 动作辅助（设置仅保存在本机）', controls: [
      onOff('motor.enabled', '启用动作辅助（Ctrl+Shift+M）'),
      sel('motor.preset', '预设方案', [['none', '无'], ['light', '轻度'], ['medium', '中度'], ['heavy', '重度'], ['one-handed', '单手'], ['tremor', '手部震颤'], ['slow', '反应较慢'], ['limited-range', '活动范围受限'], ['custom', '自定义']]),
      sel('motor.aimAssist', '自动瞄准', [['off', '关闭'], ['low', '低（0.3）'], ['medium', '中（0.6）'], ['high', '高（0.85）']]),
      sel('motor.windowMultiplier', '捕捉窗口延长', [[1, '×1'], [1.5, '×1.5'], [2, '×2'], [3, '×3']]),
      onOff('motor.oneTapThrow', '一键投掷（自动等待最佳时机）'),
      onOff('motor.trajectory', '投掷轨迹预览'),
      onOff('motor.audioCue', '最佳时机提示音'),
      sel('motor.tremorFilter', '震颤过滤', [['off', '关闭'], ['low', '低'], ['medium', '中'], ['high', '高']]),
      onOff('motor.targetSnap', '目标吸附（100px 内自动选中最近按钮）'),
      sel('motor.confirmMode', '误触防护', [['none', '无'], ['double', '双击确认'], ['hold', '长按激活']]),
      range('motor.holdMs', '长按时长', 0, 3000, 100, 'ms'),
      sel('motor.oneHanded', '单手布局', [['off', '关闭'], ['left', '左手'], ['right', '右手']]),
      onOff('motor.largeTargets', '放大点击区域'),
      range('motor.fatigueThrows', '连续投球提醒（0 为关闭）', 0, 100, 5, '次'),
      onOff('motor.cloudSync', '同步到云端（默认关闭，保护隐私）'),
      { type: 'custom', render: 'motorTest' },
    ],
  },
  {
    id: 'cognitive', title: '🧠 认知与阅读', controls: [
      { type: 'button', id: 'wizard', label: '运行设置向导（根据需要推荐设置）' },
      onOff('cognitive.simplified', '简化模式（隐藏次要信息，放大主要操作）'),
      onOff('cognitive.hints', '步骤提示条'),
      onOff('cognitive.focusMode', '专注模式（只显示重要通知）'),
      onOff('cognitive.changeWarnings', '界面自动切换前预告'),
      onOff('cognitive.dyslexiaFont', '阅读障碍友好字体（OpenDyslexic）'),
      range('cognitive.lineHeight', '行距', 1.2, 2.5, 0.1),
      range('cognitive.letterSpacing', '字间距', 0, 0.3, 0.01, 'em'),
      onOff('cognitive.readAloud', '朗读获得焦点的文字'),
      range('cognitive.breakReminderMin', '休息提醒（分钟，0 为关闭）', 0, 120, 5, '分'),
      onOff('cognitive.memory', '位置记忆（记录最近捕捉地点，仅本机）'),
    ],
  },
  {
    id: 'input', title: '⌨️ 键盘、手柄与语音控制', controls: [
      onOff('keyboard.enabled', '启用单键快捷键'),
      { type: 'custom', render: 'shortcuts' },
      onOff('gamepad.enabled', '启用手柄'),
      onOff('gamepad.vibration', '手柄振动'),
      { type: 'custom', render: 'gamepad' },
      onOff('voiceControl.enabled', '语音控制（Alt+V）'),
      sel('voiceControl.lang', '识别语言', [['auto', '跟随界面'], ['zh-CN', '中文'], ['en-US', 'English'], ['ja-JP', '日本語']]),
      range('voiceControl.minConfidence', '最低识别置信度（噪音过滤）', 0, 1, 0.05),
      onOff('voiceControl.feedback', '执行结果语音反馈'),
      { type: 'custom', render: 'voiceCommands' },
      sel('direction.mode', '文字方向', [['auto', '跟随语言'], ['ltr', '从左到右'], ['rtl', '从右到左']]),
    ],
  },
];

let uid = 0;

function controlHtml(c, prefs) {
  const id = `a11y-c-${++uid}`;
  const v = c.pref ? getPath(prefs, c.pref) : undefined;
  const help = c.help ? `<span class="a11y-help" id="${id}-h">${escapeHtml(c.help)}</span>` : '';
  const desc = (c.help ? ` aria-describedby="${id}-h"` : '') + (c.testid ? ` data-testid="${c.testid}"` : '');
  switch (c.type) {
    case 'checkbox':
      return `<div class="a11y-field a11y-field-check"><input type="checkbox" id="${id}" data-pref="${c.pref}"${v ? ' checked' : ''}${desc}><label for="${id}">${escapeHtml(c.label)}</label>${help}</div>`;
    case 'select':
      return `<div class="a11y-field"><label for="${id}">${escapeHtml(c.label)}</label><select id="${id}" data-pref="${c.pref}"${desc}>${
        c.options.map(([ov, ol]) => `<option value="${ov}"${String(ov) === String(v) ? ' selected' : ''}${c.optionTestid && ov !== 'none' ? ` data-testid="${c.optionTestid}"` : ''}>${escapeHtml(ol)}</option>`).join('')}</select>${help}</div>`;
    case 'range':
      return `<div class="a11y-field"><label for="${id}">${escapeHtml(c.label)}：<output id="${id}-o" for="${id}">${v}${c.unit}</output></label><input type="range" id="${id}" data-pref="${c.pref}" data-unit="${c.unit}" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}"${desc}>${help}</div>`;
    case 'color':
      return `<div class="a11y-field"><label for="${id}">${escapeHtml(c.label)}</label><input type="color" id="${id}" data-pref="${c.pref}" value="${/^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff'}"></div>`;
    case 'button':
      return `<div class="a11y-field"><button type="button" class="a11y-btn" data-action="${c.id}">${escapeHtml(c.label)}</button></div>`;
    case 'custom':
      return `<div class="a11y-custom" data-render="${c.render}"></div>`;
    default: return '';
  }
}

export class SettingsPanel {
  /**
   * @param {{ store, services }} deps  services: { announcer, flashGuard, shortcuts, gamepad, cues, haptics, cognitive, runSensitivityTest, toggleEmergency, voice }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.dlg = null;
  }

  open() {
    if (this.dlg) return this.dlg;
    const prefs = this.store.get();
    const wrap = document.createElement('div');
    wrap.className = 'a11y-settings';
    const sync = this.store.syncState;
    wrap.innerHTML = `
      <p class="a11y-help" id="a11y-settings-desc">修改立即生效并自动保存；登录后同步到云端（动作辅助默认仅保存在本机）。按 Esc 关闭，按 ? 查看快捷键。</p>
      <p class="a11y-sync" data-testid="a11y-sync-state" aria-live="polite">${sync.lastPush ? '已同步到云端' : ''}</p>
      ${SECTIONS.map((s, i) => `<details class="a11y-section" data-section="${s.id}"${i === 0 ? ' open' : ''}><summary><h3 class="a11y-section-title">${escapeHtml(s.title)}</h3></summary>
        <div class="a11y-section-body">${s.controls.map((c) => controlHtml(c, prefs)).join('')}</div></details>`).join('')}
      <div class="a11y-row a11y-footer">
        <button type="button" class="a11y-btn" data-action="reset">恢复默认</button>
        <button type="button" class="a11y-btn a11y-btn-primary" data-action="close">完成</button>
      </div>`;
    this.renderCustom(wrap);
    wrap.addEventListener('change', (e) => {
      // 色盲模式快捷开关：开 = 绿色盲（最常见），关 = 标准
      if (e.target && e.target.dataset && e.target.dataset.testid === 'colorblind-mode-toggle') {
        this.store.set('color.mode', e.target.checked ? (this._lastCvd || 'deuteranopia') : 'none', { source: 'panel' });
        this.refresh();
        return;
      }
      this.onInput(e, true);
    });
    wrap.addEventListener('input', (e) => { if (e.target.type === 'range') this.onInput(e, false); });
    wrap.addEventListener('click', (e) => this.onClick(e));
    this.dlg = openDialog({
      id: 'a11y-settings', title: '无障碍设置', content: wrap, describedBy: 'a11y-settings-desc', className: 'a11y-settings-backdrop', testid: 'accessibility-modal',
      onClose: () => { this.dlg = null; this.store.removeEventListener('change', this._onStore); },
    });
    this.wrap = wrap;
    this._onStore = (ev) => { if (ev.detail.source !== 'panel') this.refresh(); };
    this.store.addEventListener('change', this._onStore);
    this.announcer.announce('无障碍设置已打开', { level: 'info', speak: false });
    return this.dlg;
  }

  close() { if (this.dlg) this.dlg.close(); }

  onInput(e, commit) {
    const el = e.target;
    const pref = el.getAttribute && el.getAttribute('data-pref');
    if (!pref || pref.startsWith('color.palette.')) return; // 调色板颜色由 renderCustom 中的专用处理器写入
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'range') value = Number(el.value);
    else if (el.tagName === 'SELECT') value = /^-?\d+(\.\d+)?$/.test(el.value) ? Number(el.value) : el.value;
    else value = el.value;
    if (el.type === 'range') {
      const o = document.getElementById(`${el.id}-o`);
      if (o) o.textContent = `${value}${el.dataset.unit || ''}`;
    }
    if (!commit && el.type === 'range') { this.store.set(pref, value, { source: 'panel' }); return; }
    const patch = {};
    // 预设联动
    if (pref === 'pace.preset' && PACE_PRESETS[value]) Object.assign(patch, { pace: { ...PACE_PRESETS[value], preset: value } });
    else if (pref === 'motor.preset' && MOTOR_PRESETS[value]) Object.assign(patch, { motor: { ...MOTOR_PRESETS[value], preset: value } });
    else if (pref.startsWith('pace.') && pref !== 'pace.preset') { patch.pace = { [pref.split('.')[1]]: value, preset: 'custom' }; }
    else if (pref === 'color.highContrast') patch.color = { highContrast: value, contrast: value ? 'high' : 'normal' };
    else if (pref === 'color.contrast') patch.color = { contrast: value, highContrast: value === 'high' || value === 'max' };
    if (Object.keys(patch).length) {
      this.store.set(patch, undefined, { source: 'panel' });
      this.refresh();
    } else {
      this.store.set(pref, value, { source: 'panel' });
    }
  }

  /** 从 store 回填所有控件（预设/外部修改后） */
  refresh() {
    if (!this.wrap) return;
    const prefs = this.store.get();
    this.wrap.querySelectorAll('[data-pref]').forEach((el) => {
      const v = getPath(prefs, el.getAttribute('data-pref'));
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.value !== String(v)) el.value = String(v);
      if (el.type === 'range') { const o = document.getElementById(`${el.id}-o`); if (o) o.textContent = `${v}${el.dataset.unit || ''}`; }
    });
    this.renderCustom(this.wrap);
    const s = this.wrap.querySelector('[data-testid="a11y-sync-state"]');
    if (s && this.store.syncState.lastPush) s.textContent = '已同步到云端';
  }

  async onClick(e) {
    const btn = e.target.closest && e.target.closest('[data-action]');
    if (!btn) return;
    const act = btn.getAttribute('data-action');
    const sv = this.services;
    switch (act) {
      case 'close': this.close(); break;
      case 'reset': this.store.reset(); this.refresh(); this.announcer.announce('已恢复默认设置', { level: 'important' }); break;
      case 'ps-test': sv.runSensitivityTest(); break;
      case 'emergency': sv.toggleEmergency(); break;
      case 'test-speech': this.announcer.speak('这是语音播报试听。附近有 3 只精灵。'); break;
      case 'test-cue': sv.cues.show('pokemon:spawn', { text: '预览' }); break;
      case 'wizard': this.close(); sv.cognitive.openWizard(); break;
      case 'haptic': sv.haptics.vibrate(btn.dataset.pattern); break;
      case 'palette-fix': {
        const p = fixPalette(paletteFor('custom', this.store.get('color.palette')));
        const custom = {};
        for (const k of ['red', 'blue', 'yellow', 'green', 'purple', 'text', 'muted']) custom[k] = p[k];
        this.store.set({ color: { mode: 'custom', palette: custom } }, undefined, { source: 'panel' });
        this.refresh();
        break;
      }
      case 'palette-reset': this.store.set({ color: { palette: {} } }, undefined, { source: 'panel' }); this.refresh(); break;
      case 'rebind': {
        const action = btn.dataset.target;
        btn.textContent = '请按下新按键…（Esc 取消）';
        const combo = await sv.shortcuts.captureCombo();
        if (combo) {
          const err = sv.shortcuts.rebind(action, combo);
          this._rebindMsg = err || `已绑定为 ${combo}`;
          this.announcer.announce(this._rebindMsg, { level: 'important' });
        }
        this.renderCustom(this.wrap);
        break;
      }
      case 'shortcuts-reset': this.store.set({ keyboard: { bindings: {} } }, undefined, { source: 'panel' }); this.renderCustom(this.wrap); break;
      case 'gp-map': {
        const action = btn.dataset.target;
        btn.textContent = '请按手柄上的按键…';
        const idx = await sv.gamepad.captureNext();
        this.store.set(`gamepad.mapping`, { ...this.store.get('gamepad.mapping'), [action]: idx }, { source: 'panel' });
        this.renderCustom(this.wrap);
        break;
      }
      case 'vc-add': {
        const phrase = this.wrap.querySelector('#a11y-vc-phrase');
        const action = this.wrap.querySelector('#a11y-vc-action');
        if (phrase && phrase.value.trim()) {
          const list = [...this.store.get('voiceControl.customCommands'), { phrase: phrase.value.trim(), action: action.value }];
          this.store.set('voiceControl.customCommands', list, { source: 'panel' });
          phrase.value = '';
          this.renderCustom(this.wrap);
        }
        break;
      }
      case 'vc-del': {
        const i = Number(btn.dataset.index);
        const list = this.store.get('voiceControl.customCommands').filter((_, j) => j !== i);
        this.store.set('voiceControl.customCommands', list, { source: 'panel' });
        this.renderCustom(this.wrap);
        break;
      }
      case 'motor-test': {
        const out = this.wrap.querySelector('#a11y-motor-test-count');
        out.textContent = String(Number(out.textContent) + 1);
        break;
      }
      case 'mem-clear': sv.cognitive.clearMemories(); this.renderCustom(this.wrap); break;
      default: break;
    }
  }

  renderCustom(root) {
    const prefs = this.store.get();
    const sv = this.services;
    root.querySelectorAll('.a11y-custom').forEach((box) => {
      const kind = box.getAttribute('data-render');
      if (kind === 'cvdToggle') {
        const on = prefs.color.mode !== 'none';
        if (on) this._lastCvd = prefs.color.mode;
        box.innerHTML = `<div class="a11y-field a11y-field-check"><input type="checkbox" id="a11y-cvd-toggle" data-testid="colorblind-mode-toggle"${on ? ' checked' : ''}><label for="a11y-cvd-toggle">色盲模式（快捷开关，类型见下方）</label></div>`;
      } else if (kind === 'palette') {
        const pal = paletteFor(prefs.color.mode === 'custom' ? 'custom' : prefs.color.mode, prefs.color.palette);
        const issues = checkPalette(pal);
        box.innerHTML = `<fieldset class="a11y-fieldset"><legend>自定义调色板（选择"自定义调色板"模式后生效）</legend>
          ${['red', 'green', 'blue', 'yellow', 'purple', 'text', 'muted'].map((k) => {
            const ratio = contrastRatio(pal[k], pal.bg).toFixed(2);
            const ok = ratio >= 4.5;
            return `<div class="a11y-field a11y-palette-row"><label for="a11y-pal-${k}">${{ red: '错误/红', green: '成功/绿', blue: '主色/蓝', yellow: '警告/黄', purple: '紫', text: '正文', muted: '次要文字' }[k]}</label>
              <input type="color" id="a11y-pal-${k}" data-pref="color.palette.${k}" value="${pal[k]}">
              <span class="a11y-contrast ${ok ? 'ok' : 'bad'}" data-testid="contrast-${k}">${ok ? '✔' : '✖'} ${ratio}:1</span></div>`;
          }).join('')}
          <p class="a11y-help" data-testid="palette-issues">${issues.length ? `有 ${issues.length} 项低于 WCAG AA（4.5:1）` : '全部颜色满足 WCAG AA 对比度'}</p>
          <div class="a11y-row"><button type="button" class="a11y-btn" data-action="palette-fix">自动修正对比度</button>
          <button type="button" class="a11y-btn" data-action="palette-reset">恢复默认颜色</button></div></fieldset>`;
      } else if (kind === 'hapticPreview') {
        const pats = [['tap', '点击'], ['catch_success', '捕捉成功'], ['catch_fled', '逃跑'], ['battle_hit', '命中'], ['level_up', '升级'], ['pokemon_spawn_nearby', '附近精灵']];
        box.innerHTML = `<div class="a11y-row" role="group" aria-label="震动预览">${pats.map(([p, l]) => `<button type="button" class="a11y-btn a11y-btn-sm" data-action="haptic" data-pattern="${p}">▶ ${l}</button>`).join('')}</div>
          <p class="a11y-help">设备震动能力：${sv.haptics.getCapability ? sv.haptics.getCapability() : 'unknown'}</p>`;
      } else if (kind === 'shortcuts') {
        const b = sv.shortcuts.bindings();
        box.innerHTML = `<table class="a11y-table"><caption>快捷键（点击"修改"后按下新按键）</caption><thead><tr><th scope="col">功能</th><th scope="col">按键</th><th scope="col">操作</th></tr></thead><tbody>
          ${Object.keys(DEFAULT_BINDINGS).filter((a) => sv.shortcuts.actions[a]).map((a) => `<tr><td>${escapeHtml(sv.shortcuts.actions[a].label)}</td><td><kbd>${escapeHtml(b[a])}</kbd></td>
          <td><button type="button" class="a11y-btn a11y-btn-sm" data-action="rebind" data-target="${a}" aria-label="修改 ${escapeHtml(sv.shortcuts.actions[a].label)} 的快捷键">修改</button></td></tr>`).join('')}
          </tbody></table><p class="a11y-help" data-testid="a11y-rebind-msg">${escapeHtml(this._rebindMsg || '')}</p>
          <button type="button" class="a11y-btn" data-action="shortcuts-reset">恢复默认快捷键</button>`;
      } else if (kind === 'gamepad') {
        const list = sv.gamepad.connectedList();
        const map = sv.gamepad.mapping();
        const type = list[0] ? list[0].type : 'generic';
        const labels = BUTTON_LABELS[type];
        box.innerHTML = `<p data-testid="gamepad-status">${list.length ? list.map((p) => `🎮 已连接：${escapeHtml(p.name)}（${escapeHtml(p.id)}）`).join('<br>') : '未检测到手柄（连接后按任意键唤醒）'}</p>
          <details><summary>按键映射</summary><table class="a11y-table"><thead><tr><th scope="col">动作</th><th scope="col">按键</th><th scope="col">操作</th></tr></thead><tbody>
          ${GAMEPAD_ACTIONS.map((a) => `<tr><td>${a}</td><td>${escapeHtml(labels[map[a]] ?? String(map[a]))}</td><td><button type="button" class="a11y-btn a11y-btn-sm" data-action="gp-map" data-target="${a}" aria-label="重新映射 ${a}">映射</button></td></tr>`).join('')}
          </tbody></table></details>`;
      } else if (kind === 'voiceCommands') {
        const list = prefs.voiceControl.customCommands;
        box.innerHTML = `<fieldset class="a11y-fieldset"><legend>自定义语音命令（${list.length}/30）</legend>
          <p class="a11y-help">${sv.voice.supported ? '本浏览器支持语音识别' : '⚠️ 本浏览器不支持 SpeechRecognition，语音控制不可用'}</p>
          <ul class="a11y-list">${list.map((c, i) => `<li>"${escapeHtml(c.phrase)}" → ${escapeHtml(ACTION_LABELS[c.action] || c.action)} <button type="button" class="a11y-btn a11y-btn-sm" data-action="vc-del" data-index="${i}" aria-label="删除命令 ${escapeHtml(c.phrase)}">删除</button></li>`).join('')}</ul>
          <div class="a11y-field"><label for="a11y-vc-phrase">说法</label><input id="a11y-vc-phrase" type="text" maxlength="40" autocomplete="off"></div>
          <div class="a11y-field"><label for="a11y-vc-action">执行动作</label><select id="a11y-vc-action">${Object.keys(COMMANDS).map((a) => `<option value="${a}">${escapeHtml(ACTION_LABELS[a] || a)}</option>`).join('')}</select></div>
          <button type="button" class="a11y-btn" data-action="vc-add">添加命令</button></fieldset>`;
      } else if (kind === 'motorTest') {
        const mem = sv.cognitive.memories();
        box.innerHTML = `<fieldset class="a11y-fieldset"><legend>实时测试区</legend>
          <p class="a11y-help">用当前的震颤过滤/确认方式点击下方按钮，计数只在被接受的点击时增加。</p>
          <button type="button" class="a11y-btn a11y-motor-test" data-action="motor-test" id="a11y-motor-test-btn">测试按钮</button>
          <span>已接受点击：<output id="a11y-motor-test-count">0</output></span></fieldset>
          ${mem.length ? `<details><summary>最近捕捉地点（${mem.length}）</summary><ul class="a11y-list">${mem.slice(0, 5).map((m) => `<li>${escapeHtml(m.name || '')} · ${new Date(m.t).toLocaleString()}</li>`).join('')}</ul><button type="button" class="a11y-btn a11y-btn-sm" data-action="mem-clear">清除</button></details>` : ''}`;
      }
    });
    // 自定义调色板颜色变化：切到 custom 模式
    root.querySelectorAll('[data-pref^="color.palette."]').forEach((el) => {
      if (el._bound) return;
      el._bound = true;
      el.addEventListener('change', () => {
        const k = el.getAttribute('data-pref').split('.')[2];
        this.store.set({ color: { mode: 'custom', palette: { ...this.store.get('color.palette'), [k]: el.value } } }, undefined, { source: 'panel' });
        this.renderCustom(root);
        const modeSel = root.querySelector('[data-pref="color.mode"]');
        if (modeSel) modeSel.value = 'custom';
      });
    });
  }
}
