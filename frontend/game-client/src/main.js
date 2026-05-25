// frontend/game-client/src/main.js
// Main game client bootstrap — wires all managers together
'use strict';

import { api }             from './api/client.js';
import { store }           from './game/GameStore.js';
import { LocationManager } from './game/LocationManager.js';
import { CatchEngine }     from './game/CatchEngine.js';
import { RaidManager }     from './game/RaidManager.js';

// ── Managers ─────────────────────────────────────────────────
const locationMgr = new LocationManager(api);
const catchEngine = new CatchEngine(api);
const raidMgr     = new RaidManager(api);

// ── Map refresh interval ──────────────────────────────────────
let mapRefreshTimer = null;
const MAP_REFRESH_MS = 5000;

async function refreshMap() {
  const pos = locationMgr.currentPosition;
  if (!pos || !store.get('isLoggedIn')) return;
  try {
    const nearby = await api.getNearby(pos.lat, pos.lng);
    store.updateMapElements(nearby);
  } catch (err) {
    console.debug('[Map] Refresh failed:', err.message);
  }
}

// ── Location events ───────────────────────────────────────────
locationMgr.addEventListener('position', (ev) => {
  const { lat, lng, accuracy } = ev.detail;
  store.set({ playerLat: lat, playerLng: lng, playerAccuracy: accuracy });
});

locationMgr.addEventListener('nearbyAlert', () => {
  refreshMap(); // Immediate refresh when server detects nearby spawns
});

locationMgr.addEventListener('speedAnomaly', (ev) => {
  const { speedKmh } = ev.detail;
  if (speedKmh > 50) {
    store.addNotification('⚠️ 移动速度过快，游戏功能已暂时限制', 'warning', 5000);
  }
});

locationMgr.addEventListener('error', (ev) => {
  store.addNotification(`📍 ${ev.detail}`, 'error', 6000);
});

// ── Catch events ──────────────────────────────────────────────
catchEngine.addEventListener('sessionStarted', (ev) => {
  store.set({ activeCatch: ev.detail, activeScreen: 'catch' });
});

catchEngine.addEventListener('caught', (ev) => {
  const { rewards, pokemonInstanceId } = ev.detail;
  store.set({ activeCatch: null, activeScreen: 'map' });
  store.addNotification(`🎉 捕获成功！+${rewards.xp} XP / +${rewards.stardust} 星尘`, 'success');
  // Refresh inventory
  api.getInventory().then(inv => store.updateInventory(inv)).catch(()=>{});
});

catchEngine.addEventListener('fled', () => {
  store.set({ activeCatch: null, activeScreen: 'map' });
  store.addNotification('💨 精灵逃脱了！', 'info');
});

catchEngine.addEventListener('abandoned', () => {
  store.set({ activeCatch: null, activeScreen: 'map' });
});

// ── Raid events ───────────────────────────────────────────────
raidMgr.addEventListener('bossDefeated', () => {
  store.addNotification('🏆 Boss 已被击败！准备捕捉！', 'success', 5000);
});

raidMgr.addEventListener('disconnected', (ev) => {
  if (ev.detail.permanent) {
    store.addNotification('⚡ 突破连接断开，请重新加入', 'warning');
  }
});

// ── App initialization ────────────────────────────────────────
async function init() {
  console.log('[PMG] Initializing...');

  // Check existing auth
  const token = localStorage.getItem('pmg_access_token');
  if (token) {
    try {
      const user = await api.getMe();
      store.setUser(user);
      console.log(`[PMG] Logged in as ${user.nickname} (Lv.${user.level})`);
      onLoggedIn();
    } catch {
      // Token expired — go to login
      api.clearTokens?.();
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }
}

function onLoggedIn() {
  // Start location tracking
  locationMgr.start();

  // Start map refresh loop
  refreshMap();
  mapRefreshTimer = setInterval(refreshMap, MAP_REFRESH_MS);

  // Navigate to map
  store.navigate('map');

  // Expiring pokemon cleanup (every 30s)
  setInterval(() => {
    const now = Date.now();
    const fresh = store.get('wildPokemon').filter(p => new Date(p.expires_at).getTime() > now);
    if (fresh.length !== store.get('wildPokemon').length) {
      store.set({ wildPokemon: fresh });
    }
  }, 30000);

  console.log('[PMG] Game ready');
}

function showLoginScreen() {
  store.navigate('login');
  if (mapRefreshTimer) { clearInterval(mapRefreshTimer); mapRefreshTimer = null; }
  locationMgr.stop();
}

// Listen for logout
window.addEventListener('pmg:logout', showLoginScreen);

// ── Expose game API for UI components ─────────────────────────
window.pmgGame = {
  api,
  store,
  locationMgr,
  catchEngine,
  raidMgr,

  // ── Actions ────────────────────────────────────────────
  async tapPokemon(spawnId) {
    const pokemon = store.get('wildPokemon').find(p => p.id === spawnId);
    if (!pokemon) return;
    const pos = locationMgr.currentPosition;
    try {
      await catchEngine.startCatch(spawnId, pos?.lat, pos?.lng);
      store.removePokemon(spawnId); // Remove from map immediately
    } catch (err) {
      store.addNotification(`❌ ${err.message}`, 'error');
    }
  },

  async spinPokestop(stopId) {
    if (!locationMgr.isWithinRange(
      store.get('pokestops').find(s=>s.id===stopId)?.lat,
      store.get('pokestops').find(s=>s.id===stopId)?.lng,
      40
    )) {
      store.addNotification('📍 请靠近补给站再旋转', 'info');
      return;
    }
    try {
      const result = await api.spinPokestop(stopId);
      store.updatePokestopCooldown(stopId);
      const itemSummary = result.items.map(i => `${i.type} ×${i.qty}`).join(', ');
      store.addNotification(`🔵 获得道具：${itemSummary}`, 'success');
      api.getInventory().then(inv => store.updateInventory(inv)).catch(()=>{});
    } catch (err) {
      store.addNotification(`❌ ${err.message}`, 'error');
    }
  },

  async joinRaid(raidId) {
    try {
      await raidMgr.joinRaid(raidId);
      store.navigate('raid');
    } catch (err) {
      store.addNotification(`❌ ${err.message}`, 'error');
    }
  },

  async login(phone, smsCode) {
    const data = await api.login(phone, smsCode);
    const user = await api.getMe();
    store.setUser(user);
    onLoggedIn();
    return data;
  },

  async register(phone, smsCode, nickname) {
    const data = await api.register(phone, smsCode, nickname);
    const user = await api.getMe();
    store.setUser(user);
    onLoggedIn();
    return data;
  },

  logout() {
    api.logout();
    store.setUser(null);
    showLoginScreen();
  },
};

// Boot
init().catch(console.error);
