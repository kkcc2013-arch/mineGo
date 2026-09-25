// frontend/game-client/src/bootstrap/growth.js
// Epic E07 精灵成长模块装配：底部导航「精灵」标签 + 精灵页（进化树/成长轨迹/体力/羁绊/觉醒/特训/训练营/培育/传承/合并）
import { GrowthCenter } from '../growth/GrowthCenter.js';

function injectCss() {
  if (document.querySelector('link[data-growth-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../growth/growth.css', import.meta.url).href;
  l.dataset.growthCss = '1';
  document.head.appendChild(l);
}

export async function initGrowth(ctx = {}) {
  const { api, toast } = ctx;
  if (!api || typeof document === 'undefined') return { enabled: [] };
  injectCss();
  const center = new GrowthCenter({ api, toast });
  center.mount();

  const nav = document.getElementById('nav');
  let tab = document.getElementById('tab-growth');
  if (nav && !tab) {
    tab = document.createElement('div');
    tab.className = 'nav-tab';
    tab.id = 'tab-growth';
    tab.dataset.testid = 'nav-growth';
    tab.setAttribute('role', 'link');
    tab.tabIndex = 0;
    tab.innerHTML = '<div class="nav-icon" aria-hidden="true">🐾</div><span>精灵</span>';
    nav.insertBefore(tab, document.getElementById('tab-profile'));
  }

  const orig = window.goScreen;
  if (typeof orig === 'function' && !orig.__growthWrapped) {
    const wrapped = function (id, ...rest) {
      orig(id, ...rest);
      if (tab) tab.classList.toggle('on', id === 'growth');
      if (id === 'growth') {
        const [pokemonId, sub] = rest;
        if (pokemonId) center.open(pokemonId, sub); else center.show();
      }
    };
    wrapped.__growthWrapped = true;
    window.goScreen = wrapped;
  }
  if (tab) tab.addEventListener('click', () => window.goScreen('growth'));

  window.PMG_GROWTH = { center, openPokemon: (id, sub) => window.goScreen('growth', id, sub) };
  return { enabled: ['growth-center'] };
}
