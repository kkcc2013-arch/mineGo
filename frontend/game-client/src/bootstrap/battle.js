// frontend/game-client/src/bootstrap/battle.js
// E11 战斗与技能模块装配：对战页（道馆/团战/联赛/回放/连击/技能推荐/设置）、底部导航「对战」标签、
// 地图道馆卡片点击进入道馆挑战、战斗帧率控制器（REQ-00325）。
import { FrameRateController } from '../battle/FrameRateController.js';
import { BattleHub } from '../battle/BattleHub.js';

function injectCss() {
  if (document.querySelector('link[data-battle-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../battle/battle.css', import.meta.url).href;
  l.dataset.battleCss = '1';
  document.head.appendChild(l);
}

export async function initBattle(ctx = {}) {
  const { api, toast, locMgr } = ctx;
  if (!api || typeof document === 'undefined') return { enabled: [] };
  injectCss();
  const frc = new FrameRateController({ api });
  frc.loadConfig().catch(() => {});
  const hub = new BattleHub({ api, frc, toast, locMgr });
  hub.mount();

  // 底部导航「对战」
  const nav = document.getElementById('nav');
  let tab = document.getElementById('tab-battle');
  if (nav && !tab) {
    tab = document.createElement('div');
    tab.className = 'nav-tab';
    tab.id = 'tab-battle';
    tab.dataset.testid = 'nav-battle';
    tab.setAttribute('role', 'link');
    tab.tabIndex = 0;
    tab.innerHTML = '<div class="nav-icon" aria-hidden="true">⚔️</div><span>对战</span>';
    nav.insertBefore(tab, document.getElementById('tab-profile'));
  }

  // 包装全局 goScreen：切到对战页时刷新，并维护「对战」标签的选中态
  const orig = window.goScreen;
  if (typeof orig === 'function' && !orig.__battleWrapped) {
    const wrapped = function (id, sub) {
      orig(id);
      if (tab) tab.classList.toggle('on', id === 'battle');
      if (id === 'battle') hub.show(sub);
    };
    wrapped.__battleWrapped = true;
    window.goScreen = wrapped;
  }
  if (tab) tab.addEventListener('click', () => window.goScreen('battle'));

  // 地图道馆卡片（index.html 渲染时带 data-gym-id）→ 道馆挑战
  window.openGym = (gymId) => { window.goScreen('battle', 'gyms'); hub.openGym(gymId); };
  window.openRaid = (raidId) => { window.goScreen('battle', 'raids'); hub.openRaid(raidId); };
  document.addEventListener('click', (e) => {
    const g = e.target.closest && e.target.closest('[data-gym-id]');
    if (g && !g.hasAttribute('onclick')) window.openGym(g.dataset.gymId);
  });

  window.PMG_BATTLE = { hub, frc, openGym: window.openGym, openRaid: window.openRaid, openReplay: (id) => hub.openReplay(id) };
  return { enabled: ['battle-hub', 'frame-rate-controller'], tier: frc.tier };
}
