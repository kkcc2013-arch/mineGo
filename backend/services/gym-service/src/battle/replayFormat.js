// 回放的纯逻辑（REQ-00379 / REQ-00469）：精彩时刻识别、回放载荷、分享码与分享密码。不依赖数据库，便于单元测试。
'use strict';

const crypto = require('crypto');

const REPLAY_VERSION = 2;
const SHARE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };
const HIGHLIGHT_TYPES = ['critical_hit', 'super_effective', 'knockout', 'combo', 'status_control', 'comeback', 'clutch', 'sweep', 'flawless'];

/** 精彩时刻识别 */
function extractHighlights(state, sum) {
  const out = [];
  const team = state.attacker.team;
  const byId = new Map([...team, ...state.defender.team].map((c) => [c.pokemonId, c]));
  for (const t of state.log) {
    for (const a of t.actions) {
      if (a.type === 'attack' && a.actor === 'attacker' && !a.missed) {
        const target = byId.get(a.targetId);
        const share = target ? a.damage / target.maxHp : 0;
        if (a.isCritical && share >= 0.2) {
          out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'critical_hit', severity: share >= 0.5 ? 'high' : 'medium', title: `${a.name} 会心一击！`, description: `${a.moveName} 造成 ${a.damage} 点伤害` });
        }
        if (a.effectiveness > 1.01 && share >= 0.25) {
          out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'super_effective', severity: 'medium', title: '效果拔群！', description: `${a.name} 的 ${a.moveName} 对 ${target ? target.name : '对手'} 造成 ${a.damage} 点伤害` });
        }
        if (a.combo) {
          out.push({ startTurn: Math.max(1, t.turn - 2), endTurn: t.turn, highlightType: 'combo', severity: a.combo.quality === 'perfect' ? 'high' : 'medium', title: `${a.combo.name}（${a.combo.quality}）`, description: `连击倍率 ×${a.combo.multiplier}，${a.moveName} 造成 ${a.damage} 点伤害` });
        }
      }
      if (a.type === 'status_apply' && a.actor === 'attacker' && ['STUN', 'FREEZE'].includes(a.effect)) {
        out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'status_control', severity: 'low', title: '控制成功', description: a.message });
      }
      if (a.type === 'faint' && a.side === 'defender') {
        out.push({ startTurn: t.turn, endTurn: t.turn, highlightType: 'knockout', severity: 'medium', title: `击倒 ${a.name}`, description: `第 ${t.turn} 回合击倒对手` });
      }
    }
  }
  if (sum.result === 'win') {
    const fainted = sum.attackersFainted;
    if (team.length >= 2 && fainted >= Math.ceil(team.length / 2)) {
      out.push({ startTurn: 1, endTurn: state.turn, highlightType: 'comeback', severity: 'high', title: '绝境逆转！', description: `倒下 ${fainted} 只精灵后仍赢得胜利` });
    }
    const last = state.attacker.team[state.attacker.active];
    if (last && last.hp > 0 && last.hp / last.maxHp <= 0.15) {
      out.push({ startTurn: state.turn, endTurn: state.turn, highlightType: 'clutch', severity: 'high', title: '残血取胜', description: `${last.name} 仅剩 ${last.hp} HP 拿下胜利` });
    }
    if (fainted === 0 && state.defender.team.length >= 2) {
      out.push({ startTurn: 1, endTurn: state.turn, highlightType: 'flawless', severity: 'high', title: '无伤通关', description: `未倒下任何精灵击败 ${state.defender.team.length} 只对手` });
    }
  }
  for (const c of team) {
    if ((c.knockouts || 0) >= 2) {
      out.push({ startTurn: 1, endTurn: state.turn, highlightType: 'sweep', severity: 'high', title: `${c.name} 一穿${c.knockouts}`, description: `${c.name} 独自击倒 ${c.knockouts} 只对手` });
    }
  }
  const seen = new Set();
  return out
    .filter((h) => { const k = `${h.highlightType}:${h.startTurn}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.startTurn - b.startTurn)
    .slice(0, 12);
}

function teamSnapshot(team) {
  return team.map((c) => ({
    pokemonId: c.pokemonId, ownerId: c.ownerId, speciesId: c.speciesId, name: c.name, types: c.types, cp: c.cp,
    maxHp: c.maxHp, finalHp: c.hp, moves: c.moves.map((m) => ({ id: m.id, name: m.name, type: m.type, category: m.category })),
    damageDealt: c.damageDealt, knockouts: c.knockouts || 0,
  }));
}

function buildPayload(state) {
  return {
    version: REPLAY_VERSION, battleId: state.id, type: state.type, mode: state.mode, weather: state.weather,
    seed: state.seed, startedAt: state.startedAt, endedAt: state.endedAt, result: state.result,
    attackerTeam: teamSnapshot(state.attacker.team), defenderTeam: teamSnapshot(state.defender.team),
    turns: state.log,
  };
}

function genShareCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += SHARE_ALPHABET[b % SHARE_ALPHABET.length];
  return s;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(12).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, h] = stored.split('$');
  const got = crypto.scryptSync(String(pw || ''), salt, 32);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { REPLAY_VERSION, HIGHLIGHT_TYPES, extractHighlights, teamSnapshot, buildPayload, genShareCode, hashPassword, verifyPassword };
