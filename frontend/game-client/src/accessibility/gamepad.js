// frontend/game-client/src/accessibility/gamepad.js
// REQ-00233：游戏手柄支持（Gamepad API，标准布局）
//   - 连接/断开检测与提示（事件触发即时显示，≤2s）
//   - D-Pad 按 Tab 顺序移动焦点；A/确认 激活；B/取消 关闭弹窗或返回；左摇杆平滑滚动地图；肩键切换精灵球
//   - 识别 Xbox / PlayStation / Nintendo Switch Pro，按键映射可自定义并持久化；振动（vibrationActuator）可关闭
// ⚠️ 真机未验证：CI 中通过模拟 Gamepad 对象与 gamepadconnected 事件测试。

export const GAMEPAD_ACTIONS = ['confirm', 'cancel', 'up', 'down', 'left', 'right', 'throw', 'describe', 'prevBall', 'nextBall', 'settings', 'help'];

// 标准布局按钮索引（https://w3c.github.io/gamepad/#remapping）
export const DEFAULT_GAMEPAD_MAPPING = {
  confirm: 0, cancel: 1, throw: 2, describe: 3, prevBall: 4, nextBall: 5,
  help: 8, settings: 9, up: 12, down: 13, left: 14, right: 15,
};

export const BUTTON_LABELS = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', '↑', '↓', '←', '→', 'Xbox'],
  playstation: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', '↑', '↓', '←', '→', 'PS'],
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'LS', 'RS', '↑', '↓', '←', '→', 'Home'],
  generic: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '↑', '↓', '←', '→', '16'],
};

export function detectControllerType(id) {
  const s = String(id || '').toLowerCase();
  if (/xbox|xinput|045e|microsoft/.test(s)) return 'xbox';
  if (/playstation|dualshock|dualsense|054c|sony|wireless controller/.test(s)) return 'playstation';
  if (/nintendo|switch|pro controller|057e|joy-con/.test(s)) return 'nintendo';
  return 'generic';
}

export const CONTROLLER_NAMES = { xbox: 'Xbox 控制器', playstation: 'PlayStation 控制器', nintendo: 'Nintendo Switch Pro 控制器', generic: '通用手柄' };

/** 摇杆 → 滚动速度（像素/帧），带死区与平方曲线 */
export function stickToScroll(x, y, { deadzone = 0.2, maxSpeed = 18 } = {}) {
  const f = (v) => {
    const a = Math.abs(v);
    if (a < deadzone) return 0;
    const n = (a - deadzone) / (1 - deadzone);
    return Math.sign(v) * Math.round(n * n * maxSpeed * 100) / 100;
  };
  return { dx: f(x), dy: f(y) };
}

export function resolveMapping(overrides = {}) {
  const out = { ...DEFAULT_GAMEPAD_MAPPING };
  for (const [k, v] of Object.entries(overrides || {})) if (GAMEPAD_ACTIONS.includes(k) && Number.isInteger(v)) out[k] = v;
  return out;
}

export class GamepadController {
  /**
   * @param {{ getPrefs, setPref, actions, announcer, toast, haptics }} deps
   *   actions: { focusNext, focusPrev, activate, cancel, run(actionId), scrollMap(dx,dy) }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.pads = new Map(); // index → { id, type, name, prev: [] }
    this.log = [];
    this._raf = null;
    this._capture = null;
    this._repeat = {};
    this._tick = this._tick.bind(this);
  }

  get enabled() { return this.getPrefs().gamepad.enabled; }
  mapping() { return resolveMapping(this.getPrefs().gamepad.mapping); }

  start() {
    window.addEventListener('gamepadconnected', (e) => this._connected(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => this._disconnected(e.gamepad));
    // 页面加载前已连接的手柄
    try { for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) if (gp) this._connected(gp, true); } catch { /* ignore */ }
    if (this.haptics && this.haptics.onVibrate) {
      this.haptics.onVibrate((rec) => this.rumble(rec.scaled));
    }
  }

  _connected(gp, silent = false) {
    if (!gp) return;
    const type = detectControllerType(gp.id);
    const info = { index: gp.index, id: gp.id, type, name: CONTROLLER_NAMES[type], prev: [], connectedAt: performance.now() };
    this.pads.set(gp.index, info);
    this.log.push({ ev: 'connected', type, t: Date.now() });
    document.documentElement.classList.add('a11y-gamepad');
    if (!silent) {
      const msg = `🎮 已连接手柄：${info.name}`;
      if (this.toast) this.toast(msg, 'ok');
      if (this.announcer) this.announcer.announce(msg.replace('🎮 ', ''), { level: 'important' });
    }
    document.dispatchEvent(new CustomEvent('pmg:a11y-gamepad', { detail: { connected: true, ...info } }));
    this._loop();
  }

  _disconnected(gp) {
    if (!gp) return;
    const info = this.pads.get(gp.index);
    this.pads.delete(gp.index);
    this.log.push({ ev: 'disconnected', t: Date.now() });
    if (!this.pads.size) document.documentElement.classList.remove('a11y-gamepad');
    const msg = `🎮 手柄已断开：${info ? info.name : gp.id}`;
    if (this.toast) this.toast(msg, 'err');
    if (this.announcer) this.announcer.announce(msg.replace('🎮 ', ''), { level: 'important' });
    document.dispatchEvent(new CustomEvent('pmg:a11y-gamepad', { detail: { connected: false, index: gp.index } }));
  }

  connectedList() { return [...this.pads.values()].map(({ index, id, type, name }) => ({ index, id, type, name })); }

  _loop() {
    if (this._raf || !this.pads.size) return;
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick() {
    this._raf = null;
    if (!this.pads.size) return;
    let pads = [];
    try { pads = navigator.getGamepads ? [...navigator.getGamepads()] : []; } catch { pads = []; }
    for (const gp of pads) {
      if (!gp) continue;
      const info = this.pads.get(gp.index);
      if (!info) continue;
      try { this.poll(gp, info); } catch (err) { this.log.push({ ev: 'error', msg: String(err), t: Date.now() }); }
    }
    this._loop();
  }

  /** 处理一帧手柄状态（导出供测试直接驱动） */
  poll(gp, info) {
    const now = performance.now();
    const pressed = gp.buttons.map((b) => (typeof b === 'object' ? !!b.pressed : b > 0.5));
    // 自定义映射录制模式：下一次按下的按钮分配给目标动作
    if (this._capture) {
      const idx = pressed.findIndex((p, i) => p && !info.prev[i]);
      if (idx >= 0) { const cb = this._capture; this._capture = null; cb(idx); }
      info.prev = pressed;
      return;
    }
    if (!this.enabled) { info.prev = pressed; return; }
    const map = this.mapping();
    const byButton = {};
    for (const [action, btn] of Object.entries(map)) byButton[btn] = action;
    pressed.forEach((isDown, i) => {
      const was = info.prev[i];
      const action = byButton[i];
      if (!action) return;
      if (isDown && !was) { this._repeat[i] = now + 400; this._fire(action); }
      else if (isDown && was && ['up', 'down', 'left', 'right'].includes(action) && now >= (this._repeat[i] || Infinity)) {
        this._repeat[i] = now + 120; // 按住方向键连发
        this._fire(action);
      }
    });
    info.prev = pressed;
    const axes = gp.axes || [];
    const { dx, dy } = stickToScroll(axes[0] || 0, axes[1] || 0);
    if ((dx || dy) && this.actions.scrollMap) this.actions.scrollMap(dx, dy);
  }

  _fire(action) {
    this.log.push({ ev: 'action', action, t: Date.now() });
    if (this.log.length > 200) this.log.splice(0, 50);
    const a = this.actions;
    switch (action) {
      case 'up': case 'left': a.focusPrev(); break;
      case 'down': case 'right': a.focusNext(); break;
      case 'confirm': a.activate(); break;
      case 'cancel': a.cancel(); break;
      default: a.run(action);
    }
  }

  /** 录制：等待手柄按下一个键 */
  captureNext() {
    return new Promise((resolve) => { this._capture = resolve; this._loop(); });
  }

  rumble(pattern) {
    if (!this.getPrefs().gamepad.vibration || !pattern || !pattern.length) return false;
    let ok = false;
    try {
      for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
        const act = gp && gp.vibrationActuator;
        if (!act || typeof act.playEffect !== 'function') continue;
        const duration = pattern.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0);
        act.playEffect('dual-rumble', { duration: Math.min(1000, duration), strongMagnitude: 0.6, weakMagnitude: 0.4 }).catch(() => {});
        ok = true;
      }
    } catch { /* ignore */ }
    return ok;
  }
}
