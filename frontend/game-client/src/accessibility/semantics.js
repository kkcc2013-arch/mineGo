// frontend/game-client/src/accessibility/semantics.js
// REQ-00426 / REQ-00503 / REQ-00162：运行期语义化标注
//   - 标题层级、区域 landmark、装饰性 emoji 对辅助技术隐藏
//   - 带 onclick 的 div 补 role=button + tabindex + Enter/Space 激活
//   - 精灵球单选组 aria-checked 同步 + 方向键漫游；导航栏 aria-current
//   - 地图卡片 aria-label（名称/CP/方向/距离）；投球准确度 progressbar + 文字分区（非颜色标识）
//   - 语言弹窗补 role=dialog、焦点陷阱与 Esc
import { trapFocus } from './dialog.js';
import { accuracyZone } from './colorVision.js';

const NATIVE_FOCUSABLE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;

function heading(el, level) {
  if (!el || el.getAttribute('role') === 'heading') return;
  el.setAttribute('role', 'heading');
  el.setAttribute('aria-level', String(level));
}

export class SemanticEnhancer {
  constructor({ labelSpawn, onScreen } = {}) {
    this.labelSpawn = labelSpawn || (() => null);
    this.onScreen = onScreen || (() => {});
    this._ringTimer = null;
    this._langRelease = null;
  }

  start() {
    this.enhance(document.body);
    this._syncBalls();
    this._syncNav();
    this._ring();
    document.addEventListener('keydown', (e) => this._keyActivate(e));
    const obs = new MutationObserver((muts) => {
      let balls = false;
      let nav = false;
      for (const m of muts) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (n.id === 'lang-modal') this._langModal(n);
            this.enhance(n);
          });
          m.removedNodes.forEach((n) => { if (n.id === 'lang-modal' && this._langRelease) { this._langRelease(); this._langRelease = null; } });
          if (m.target.id === 'map-body') this.enhanceMap();
        } else if (m.type === 'attributes') {
          if (m.target.classList.contains('ball-chip')) balls = true;
          if (m.target.classList.contains('nav-tab')) nav = true;
          if (m.target.classList.contains('screen') && m.target.classList.contains('active') && m.oldValue && !m.oldValue.includes('active')) {
            this.onScreen(m.target.id);
          }
        }
      }
      if (balls) this._syncBalls();
      if (nav) this._syncNav();
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  }

  enhance(root) {
    if (!root || !root.querySelectorAll) return;
    const q = (sel) => (root.matches && root.matches(sel) ? [root] : []).concat([...root.querySelectorAll(sel)]);
    q('.logo-title, .catch-headline, .prof-name').forEach((el) => heading(el, 1));
    q('.sec-title, .inv-header').forEach((el) => heading(el, 2));
    q('.screen').forEach((s) => {
      if (!s.getAttribute('role')) s.setAttribute('role', 'region');
      // 区域名用页面功能名（地图/捕捉/我的），而不是用户名等动态文本
      if (!s.hasAttribute('aria-label')) s.setAttribute('aria-label', { login: '登录', map: '地图', catch: '捕捉', profile: '我的' }[s.id] || s.id);
    });
    q('.entity-icon, .inv-icon, .nav-icon, .avatar-circle, .prof-avatar, .empty-icon, .entity-right').forEach((el) => el.setAttribute('aria-hidden', 'true'));
    // 带 onclick 的非原生可聚焦元素
    q('[onclick]').forEach((el) => {
      if (NATIVE_FOCUSABLE.test(el.tagName)) return;
      if (!el.getAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
    q('.inv-row[onclick] .inv-qty').forEach((el) => { if (el.textContent.trim() === '>') el.setAttribute('aria-hidden', 'true'); });
    // 资源条：emoji 隐藏，补文字名称
    const resNames = { 'resource-pokeball': '精灵球', 'resource-coins': '精灵币', 'resource-stardust': '星尘' };
    q('.res[data-testid]').forEach((el) => {
      if (el.dataset.a11yDone) return;
      el.dataset.a11yDone = '1';
      const first = el.firstChild;
      if (first && first.nodeType === 3 && first.textContent.trim()) {
        const span = document.createElement('span');
        span.setAttribute('aria-hidden', 'true');
        span.textContent = first.textContent;
        el.replaceChild(span, first);
        const sr = document.createElement('span');
        sr.className = 'a11y-sr-only';
        sr.textContent = `${resNames[el.dataset.testid] || ''} `;
        el.insertBefore(sr, span.nextSibling);
      }
    });
    if (root.id === 'map-body' || (root.querySelector && root.querySelector('#map-body'))) this.enhanceMap();
  }

  /** 地图卡片：可聚焦按钮 + 完整无障碍名称 */
  enhanceMap() {
    const body = document.getElementById('map-body');
    if (!body) return;
    body.setAttribute('aria-busy', body.querySelector('.spin') ? 'true' : 'false');
    const spin = body.querySelector('.spin');
    if (spin) { spin.setAttribute('role', 'progressbar'); spin.setAttribute('aria-label', '加载中'); }
    body.querySelectorAll('.entity-card').forEach((card) => {
      const name = card.querySelector('.entity-name')?.textContent.trim() || '';
      const meta = card.querySelector('.entity-meta')?.textContent.trim() || '';
      const right = card.querySelector('.entity-right')?.textContent.replace('›', '').trim() || '';
      const click = card.getAttribute('onclick') || '';
      if (click) {
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
      } else {
        card.setAttribute('role', 'group');
      }
      let label = [name, meta, right].filter(Boolean).join('，');
      const m = click.match(/openCatch\('([^']+)'\)/);
      if (m) {
        try {
          const spawn = JSON.parse(decodeURIComponent(m[1]));
          card.dataset.spawnId = spawn.id;
          card.dataset.speciesId = spawn.species_id || spawn.speciesId || '';
          label = this.labelSpawn({ ...spawn, species_name: spawn.species_name || spawn.speciesName || name }) || label;
        } catch { /* ignore */ }
        card.classList.add('a11y-spawn-card');
      }
      card.setAttribute('aria-label', label);
      // 方向性箭头单独包裹，RTL 下只镜像箭头、不镜像距离数字（REQ-00244 / REQ-00413）
      const r = card.querySelector('.entity-right');
      if (r && !r.querySelector('.a11y-dir-icon') && /›\s*$/.test(r.textContent)) {
        r.textContent = r.textContent.replace(/\s*›\s*$/, ' ');
        const ic = document.createElement('span');
        ic.className = 'a11y-dir-icon';
        ic.setAttribute('aria-hidden', 'true');
        ic.textContent = '›';
        r.appendChild(ic);
      }
    });
  }

  _syncBalls() {
    const chips = [...document.querySelectorAll('.ball-chip')];
    chips.forEach((c) => {
      const on = c.classList.contains('sel');
      c.setAttribute('aria-checked', on ? 'true' : 'false');
      c.setAttribute('tabindex', on ? '0' : '-1');
    });
  }

  _syncNav() {
    document.querySelectorAll('.nav-tab').forEach((t) => {
      if (t.classList.contains('on')) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
  }

  _ring() {
    const bar = document.querySelector('[data-testid="accuracy-bar"]');
    const fill = document.getElementById('ring-fill');
    if (!bar || !fill) return;
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', '投球准确度圈大小（越小越好）');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    let zoneEl = document.getElementById('a11y-ring-zone');
    if (!zoneEl) {
      zoneEl = document.createElement('div');
      zoneEl.id = 'a11y-ring-zone';
      zoneEl.className = 'a11y-ring-zone';
      zoneEl.setAttribute('aria-hidden', 'true');
      bar.insertAdjacentElement('afterend', zoneEl);
    }
    const update = () => {
      if (!document.getElementById('catch')?.classList.contains('active')) return;
      const pct = Math.round(parseFloat(fill.style.width) || 100);
      const z = accuracyZone(pct);
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuetext', `${pct}%，${z.label}`);
      bar.dataset.zone = z.zone;
      zoneEl.textContent = z.label;
      zoneEl.dataset.zone = z.zone;
    };
    this._ringTimer = setInterval(update, 250);
    update();
  }

  /** role=button/link/tab/radio 的非原生元素支持 Enter/Space；单选组与导航栏支持方向键 */
  _keyActivate(e) {
    const el = e.target;
    if (!el || !el.getAttribute || e.defaultPrevented) return;
    const role = el.getAttribute('role');
    if (!role || NATIVE_FOCUSABLE.test(el.tagName)) return;
    if ((e.key === 'Enter' || e.key === ' ') && ['button', 'link', 'tab', 'radio', 'menuitem'].includes(role)) {
      e.preventDefault();
      el.click();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const group = el.closest('[role="radiogroup"], [role="navigation"]');
      if (!group) return;
      const items = [...group.querySelectorAll('[role="radio"], [role="link"], [role="tab"]')];
      const i = items.indexOf(el);
      if (i < 0) return;
      e.preventDefault();
      const rtl = document.documentElement.dir === 'rtl';
      const fwd = e.key === 'ArrowDown' || (e.key === 'ArrowRight') !== rtl;
      const next = items[(i + (fwd ? 1 : -1) + items.length) % items.length];
      next.focus();
      if (role === 'radio') next.click();
    }
  }

  _langModal(modal) {
    const box = modal.firstElementChild;
    if (!box) return;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = box.firstElementChild;
    if (title) { title.id = 'lang-modal-title'; box.setAttribute('aria-labelledby', 'lang-modal-title'); }
    this._langRelease = trapFocus(box, { onEscape: () => modal.remove() });
  }
}
