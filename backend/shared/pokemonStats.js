/**
 * 精灵基础数值（纯函数，与刷怪时 location-service 的 CP 公式一致）
 *   baseCp(species, iv) = max(10, floor((A+ivA) × √(D+ivD) × √(H+ivH) / 10))
 */
'use strict';

function toInt(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function baseCp(species, iv = {}) {
  const a = toInt(species.base_attack) + toInt(iv.attack ?? iv.iv_attack);
  const d = toInt(species.base_defense) + toInt(iv.defense ?? iv.iv_defense);
  const h = toInt(species.base_hp) + toInt(iv.hp ?? iv.iv_hp);
  return Math.max(10, Math.floor((a * Math.sqrt(Math.max(d, 1)) * Math.sqrt(Math.max(h, 1))) / 10));
}

module.exports = { baseCp, toInt };
