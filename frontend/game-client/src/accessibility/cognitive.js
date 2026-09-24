// frontend/game-client/src/accessibility/cognitive.js
// REQ-00286：认知无障碍（简化模式、阅读辅助、专注模式、记忆辅助、变更预告、设置向导）
import { openDialog } from './dialog.js';

export const WIZARD_QUESTIONS = [
  { id: 'vision', text: '看清屏幕上的文字或颜色是否有困难？', options: [['no', '没有'], ['low', '文字偏小/对比度不够'], ['color', '难以分辨某些颜色'], ['blind', '需要依靠读屏或语音']] },
  { id: 'hearing', text: '是否听不清或听不到游戏声音？', options: [['no', '没有'], ['yes', '是，需要文字或画面提示']] },
  { id: 'motor', text: '点击、快速反应或双手操作是否困难？', options: [['no', '没有'], ['some', '有时手抖或反应较慢'], ['severe', '只能单手或操作很吃力']] },
  { id: 'reading', text: '阅读较长文字是否吃力？', options: [['no', '没有'], ['yes', '是']] },
  { id: 'attention', text: '是否容易被弹窗和动效分散注意力？', options: [['no', '没有'], ['yes', '是']] },
  { id: 'photo', text: '闪烁画面是否会让你不适（如光敏性癫痫）？', options: [['no', '没有'], ['yes', '是']] },
];

/** 根据向导回答推荐设置（返回可直接 merge 进 prefs 的 patch） */
export function recommendSettings(answers = {}) {
  const p = {};
  const set = (sec, obj) => { p[sec] = { ...(p[sec] || {}), ...obj }; };
  if (answers.vision === 'low') { set('color', { contrast: 'high', highContrast: true }); set('display', { uiScale: 1.25 }); }
  if (answers.vision === 'color') set('color', { mode: 'deuteranopia', shapes: true });
  if (answers.vision === 'blind') set('screenReader', { speech: true, verbosity: 'full', spatialAudio: true, readFocus: true });
  if (answers.hearing === 'yes') { set('hearing', { visualCues: true }); set('subtitles', { enabled: true }); set('haptics', { enabled: true, intensity: 150 }); }
  if (answers.motor === 'some') { set('motor', { enabled: true, preset: 'medium', aimAssist: 'medium', windowMultiplier: 2, tremorFilter: 'low', largeTargets: true, targetSnap: true, trajectory: true }); set('pace', { catch: 0.75, preset: 'easy' }); }
  if (answers.motor === 'severe') { set('motor', { enabled: true, preset: 'heavy', aimAssist: 'high', windowMultiplier: 3, oneTapThrow: true, largeTargets: true, targetSnap: true, oneHanded: 'right', tremorFilter: 'medium' }); set('pace', { catch: 0.5, ui: 0.5, preset: 'accessible' }); }
  if (answers.reading === 'yes') set('cognitive', { dyslexiaFont: true, lineHeight: 1.8, letterSpacing: 0.05, readAloud: true });
  if (answers.attention === 'yes') { set('cognitive', { focusMode: true, simplified: true, hints: true, breakReminderMin: 25 }); set('screenReader', { verbosity: 'minimal' }); }
  if (answers.photo === 'yes') set('photosensitive', { enabled: true, reduceMotion: true, maxFlashHz: 1 });
  if (answers.reading === 'yes' || answers.attention === 'yes') set('cognitive', { changeWarnings: true });
  return p;
}

const SCREEN_HINTS = {
  login: '第 1 步：输入手机号；第 2 步：获取并填写验证码；第 3 步：点击登录',
  map: '点击任意精灵卡片开始捕捉；按 L 听附近情况；按 ? 查看快捷键',
  catch: '第 1 步：选择精灵球（1/2/3）；第 2 步：圆圈变小时点击"投球捕捉"（T）',
  profile: '这里可以查看背包和打开无障碍设置',
};

export class CognitiveAssist {
  constructor({ getPrefs, setPrefs, announcer }) {
    this.getPrefs = getPrefs;
    this.setPrefs = setPrefs;
    this.announcer = announcer;
    this.sessionStart = Date.now();
    this._breakTimer = null;
    this.memoryKey = 'pmg_a11y_memory_v1';
  }

  get c() { return this.getPrefs().cognitive; }

  start() {
    document.addEventListener('focusin', (e) => {
      if (!this.c.readAloud && !this.getPrefs().screenReader.readFocus) return;
      const el = e.target;
      const text = el.getAttribute('aria-label') || el.textContent;
      if (text && text.trim()) this.announcer.speak(text.trim().slice(0, 120));
    });
    this.apply();
  }

  apply() {
    const c = this.c;
    const html = document.documentElement;
    html.classList.toggle('a11y-simplified', c.simplified);
    html.classList.toggle('a11y-dyslexia', c.dyslexiaFont);
    html.classList.toggle('a11y-focus-mode', c.focusMode);
    html.classList.toggle('a11y-hints', c.hints);
    html.style.setProperty('--a11y-line-height', String(c.lineHeight));
    html.style.setProperty('--a11y-letter-spacing', `${c.letterSpacing}em`);
    this.updateHint();
    clearInterval(this._breakTimer);
    if (c.breakReminderMin > 0) {
      this._breakTimer = setInterval(() => {
        if (Date.now() - this.sessionStart >= c.breakReminderMin * 60000) {
          this.sessionStart = Date.now();
          document.dispatchEvent(new CustomEvent('pmg:a11y-break'));
        }
      }, 15000);
    }
  }

  /** 上下文提示条（任务分块） */
  updateHint(screenId) {
    let bar = document.getElementById('a11y-hint-bar');
    const id = screenId || (document.querySelector('.screen.active') || {}).id;
    if (!this.c.hints || !SCREEN_HINTS[id]) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'a11y-hint-bar';
      bar.className = 'a11y-hint-bar a11y-keep-visible';
      bar.setAttribute('role', 'note');
      document.body.appendChild(bar);
    }
    bar.textContent = `💡 ${SCREEN_HINTS[id]}`;
  }

  /** 变更前预告（如捕捉结束后自动返回地图） */
  warnChange(msg, ms = 1500) {
    if (!this.c.changeWarnings) return false;
    let el = document.getElementById('a11y-change-warning');
    if (!el) {
      el = document.createElement('div');
      el.id = 'a11y-change-warning';
      el.className = 'a11y-change-warning a11y-keep-visible';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = `⏳ ${msg}`;
    this.announcer.announce(msg, { level: 'important' });
    clearTimeout(this._cw);
    this._cw = setTimeout(() => el.remove(), ms + 500);
    return true;
  }

  /** 位置记忆：记录捕捉/遭遇地点（仅本地） */
  remember(entry) {
    if (!this.c.memory) return;
    try {
      const list = JSON.parse(localStorage.getItem(this.memoryKey) || '[]');
      list.unshift({ ...entry, t: Date.now() });
      localStorage.setItem(this.memoryKey, JSON.stringify(list.slice(0, 20)));
    } catch { /* ignore */ }
  }

  memories() {
    try { return JSON.parse(localStorage.getItem(this.memoryKey) || '[]'); } catch { return []; }
  }

  clearMemories() { try { localStorage.removeItem(this.memoryKey); } catch { /* ignore */ } }

  /** 设置向导：逐题回答 → 推荐设置 → 一键应用 */
  openWizard() {
    const form = document.createElement('form');
    form.className = 'a11y-wizard';
    form.innerHTML = WIZARD_QUESTIONS.map((q) => `
      <fieldset class="a11y-fieldset"><legend>${q.text}</legend>
      ${q.options.map(([v, l], i) => `<label class="a11y-choice"><input type="radio" name="${q.id}" value="${v}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join('')}
      </fieldset>`).join('') + `
      <div class="a11y-row"><button type="submit" class="a11y-btn a11y-btn-primary">应用推荐设置</button></div>`;
    const dlg = openDialog({ id: 'a11y-wizard', title: '无障碍设置向导', content: form });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const answers = Object.fromEntries(new FormData(form).entries());
      const patch = recommendSettings(answers);
      this.setPrefs(patch);
      dlg.close();
      this.announcer.announce('已根据你的回答应用推荐设置', { level: 'important' });
    });
    return dlg;
  }
}
