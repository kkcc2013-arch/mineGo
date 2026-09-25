// frontend/game-client/src/battle/BattleClient.js
// E11 战斗相关接口封装（经网关 /v1，统一由 api/client.js 处理鉴权与 token 刷新）
'use strict';

const enc = encodeURIComponent;

export class BattleClient {
  constructor(api) { this.api = api; }

  put(path, body) { return this.api.request('PUT', path, body); }

  // 道馆
  nearbyGyms(lat, lng, radius = 2000) { return this.api.get(`/gyms/nearby?lat=${lat}&lng=${lng}&radius=${radius}`); }
  gym(id) { return this.api.get(`/gyms/${enc(id)}`); }
  defend(gymId, pokemonId) { return this.api.post(`/gyms/${enc(gymId)}/defend`, { pokemonId }); }
  startGymBattle(gymId, pokemonIds) { return this.api.post(`/gyms/${enc(gymId)}/battle/start`, { pokemonIds }); }
  gymHistory() { return this.api.get('/gyms/battles/history'); }

  // 进行中的战斗（道馆 / 联赛通用）
  battle(id) { return this.api.get(`/battle/sessions/${enc(id)}`); }
  turn(id, moveId) { return this.api.post(`/battle/sessions/${enc(id)}/turn`, { moveId }); }
  useAdvice(id) { return this.api.post(`/battle/sessions/${enc(id)}/turn`, { useAdvice: true }); }
  switchTo(id, pokemonId) { return this.api.post(`/battle/sessions/${enc(id)}/switch`, { pokemonId }); }
  combo(id, presetId) { return this.api.post(`/battle/sessions/${enc(id)}/combo`, { presetId }); }
  forfeit(id) { return this.api.post(`/battle/sessions/${enc(id)}/forfeit`); }
  advice(id) { return this.api.get(`/battle/sessions/${enc(id)}/advice`, { timeout: 5000 }); }
  predict(id) { return this.api.get(`/battle/sessions/${enc(id)}/predict`, { timeout: 5000 }); }

  // 团战
  nearbyRaids(lat, lng, radius = 2000) { return this.api.get(`/raids/nearby?lat=${lat}&lng=${lng}&radius=${radius}`); }
  raid(id) { return this.api.get(`/raids/${enc(id)}`); }
  joinRaid(id, pokemonIds) { return this.api.post(`/raids/${enc(id)}/join`, pokemonIds ? { pokemonIds } : {}); }
  raidAttack(id, moveId) { return this.api.post(`/raids/${enc(id)}/attack`, { moveId }); }
  raidResult(id) { return this.api.get(`/raids/${enc(id)}/result`); }

  // 精灵、能量、冷却、装备
  myPokemon(limit = 50) { return this.api.get(`/pokemon/my?sort=cp&order=desc&limit=${limit}`); }
  energy(pokemonId) { return this.api.get(`/battle/pokemon/${enc(pokemonId)}/energy`); }
  cooldowns(pokemonId, mode = 'PVE') { return this.api.get(`/battle/pokemon/${enc(pokemonId)}/cooldowns?mode=${mode}`); }
  mastery(pokemonId) { return this.api.get(`/battle/pokemon/${enc(pokemonId)}/mastery`); }
  equipment() { return this.api.get('/battle/equipment/mine'); }
  equip(itemId, pokemonId) { return this.api.post(`/battle/equipment/${enc(itemId)}/equip`, { pokemonId }); }

  // 连击
  chains() { return this.api.get('/battle/combos'); }
  comboStats() { return this.api.get('/battle/combos/my/stats'); }
  comboLeaderboard() { return this.api.get('/battle/combos/leaderboard'); }
  practice(chainId, steps) { return this.api.post(`/battle/combos/${enc(chainId)}/practice`, { steps }); }
  presets(pokemonId) { return this.api.get(`/battle/combos/presets${pokemonId ? `?pokemonId=${enc(pokemonId)}` : ''}`); }
  createPreset(body) { return this.api.post('/battle/combos/presets', body); }
  deletePreset(id) { return this.api.del(`/battle/combos/presets/${enc(id)}`); }
  comboRecommend(pokemonId) { return this.api.get(`/battle/combos/recommend/${enc(pokemonId)}`); }

  // 技能推荐
  recommendations(speciesId, scenario, style) {
    const q = new URLSearchParams();
    if (scenario) q.set('scenario', scenario);
    if (style) q.set('style', style);
    return this.api.get(`/battle/recommendations/${enc(speciesId)}?${q}`);
  }
  recoPrefs() { return this.api.get('/battle/recommendations/preferences'); }
  saveRecoPrefs(body) { return this.put('/battle/recommendations/preferences', body); }

  // AI
  lineup(body) { return this.api.post('/battle/ai/lineup', body, { timeout: 8000 }); }
  aiPrefs() { return this.api.get('/battle/ai/preferences'); }
  saveAiPrefs(body) { return this.put('/battle/ai/preferences', body); }
  feedback(adviceId, helpful) { return this.api.post('/battle/ai/feedback', { adviceId, helpful }); }
  review(battleId) { return this.api.get(`/battle/ai/review/${enc(battleId)}`); }

  // 回放
  replay(id) { return this.api.get(`/battle/replays/${enc(id)}`); }
  myReplays() { return this.api.get('/battle/replays/mine'); }
  hotReplays(sort = 'views') { return this.api.get(`/battle/replays/hot?sort=${sort}`); }
  searchReplays(params) { return this.api.get(`/battle/replays/search?${new URLSearchParams(params)}`); }
  share(id, body = {}) { return this.api.post(`/battle/replays/${enc(id)}/share`, body); }
  like(id) { return this.api.post(`/battle/replays/${enc(id)}/like`); }
  comment(id, comment) { return this.api.post(`/battle/replays/${enc(id)}/comments`, { comment }); }
  comments(id) { return this.api.get(`/battle/replays/${enc(id)}/comments`); }

  // 联赛
  season() { return this.api.get('/battle/league/season'); }
  leagueMe() { return this.api.get('/battle/league/me'); }
  leagueBoard(level, group) { return this.api.get(`/battle/league/leaderboard?level=${level}&group=${group}`); }
  leagueMatch(pokemonIds) { return this.api.post('/battle/league/match', pokemonIds ? { pokemonIds } : {}, { timeout: 8000 }); }
  leagueMatches() { return this.api.get('/battle/league/matches'); }
  leagueRewards() { return this.api.get('/battle/league/rewards'); }
  claimLeagueReward(id) { return this.api.post(`/battle/league/rewards/${enc(id)}/claim`); }
  setDefenseTeam(pokemonIds) { return this.put('/battle/league/defense-team', { pokemonIds }); }
}

// ── 纯展示辅助（无 DOM 依赖，Node 单测覆盖） ───────────────────

/** 技能按钮状态：冷却 > 能量不足 > 可用 */
export function moveButtonState(move) {
  if (move.cooldownLeft > 0) return { disabled: true, label: `冷却 ${move.cooldownLeft}`, reason: 'cooldown' };
  if (move.category === 'CHARGE' && !move.energyOk) return { disabled: true, label: `需 ${move.energyCost} 能量`, reason: 'energy' };
  return { disabled: false, label: move.category === 'CHARGE' ? `-${move.energyCost}⚡` : `+${move.energyGain}⚡`, reason: null };
}

/** 能量条：百分比 + 各蓄力技能的能量刻度 */
export function energyBarModel(energy, maxEnergy, moves = []) {
  const max = Math.max(1, maxEnergy || 100);
  return {
    pct: Math.max(0, Math.min(100, Math.round(((energy || 0) / max) * 100))),
    ticks: moves.filter((m) => m.category === 'CHARGE' && m.energyCost > 0)
      .map((m) => ({ moveId: m.id, name: m.name, pct: Math.min(100, Math.round((m.energyCost / max) * 100)), ready: energy >= m.energyCost })),
  };
}

export function hpColor(hp, maxHp) {
  const r = maxHp > 0 ? hp / maxHp : 0;
  return r > 0.5 ? 'var(--green)' : r > 0.2 ? 'var(--yellow)' : 'var(--red)';
}

/** 回合事件 → 战斗日志文本 */
export function describeAction(a) {
  switch (a.type) {
    case 'attack':
      if (a.missed) return `${a.name} 的 ${a.moveName} 没有命中`;
      return `${a.name} 使用 ${a.moveName}，造成 ${a.damage} 伤害${a.effectivenessText ? `，${a.effectivenessText}` : ''}${a.isCritical ? '（会心一击）' : ''}${a.combo ? ` 🔗${a.combo.name}×${a.combo.multiplier}` : ''}`;
    case 'faint': return `${a.name} 倒下了`;
    case 'switch': return a.message || `${a.name} 上场`;
    case 'status_apply': case 'skip': case 'confusion': case 'status_tick': return a.message || '';
    case 'forfeit': return '你认输了';
    default: return '';
  }
}

/** 回放播放：按速度计算每回合间隔 */
export function turnIntervalMs(speed) {
  const s = [0.5, 1, 2, 4].includes(Number(speed)) ? Number(speed) : 1;
  return Math.round(1200 / s);
}

export const TEAM_LABEL = { VALOR: '🔴 勇火队', MYSTIC: '🔵 神秘队', INSTINCT: '🟡 本能队', red: '🔴 勇火队', blue: '🔵 神秘队', yellow: '🟡 本能队' };
export const LEAGUE_LABEL = { BRONZE: '青铜', SILVER: '白银', GOLD: '黄金', PLATINUM: '铂金', DIAMOND: '钻石', MASTER: '大师' };

export function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
