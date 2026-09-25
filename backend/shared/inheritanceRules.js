/**
 * 精灵传承规则（REQ-00361，纯函数）
 *
 * 放生时把精灵的"遗产"存入传承池（按玩家 × 家族根物种一行）：
 *   池值 = 放生精灵的 IV（攻/防/HP，0~15）与 CP 加成（放生精灵 CP 的 10%）
 *   传承率由放生精灵的亲密度等级决定（亲密度等级 1~50 = 羁绊等级/2）：≤10 5%、≤20 10%、≤30 20%、≤40 30%、>40 50%；
 *   传承石 +10% / +20%（上限 80%），完美传承石 = 传承全部属性（100%）
 * 同物种再次放生时逐项取较大值、传承率取较高者，有效期重置为 30 天
 * 捕捉同家族精灵时自动继承：IV += round(池值 × 传承率 × 衰减)（上限 15），CP += round(CP 加成 × 传承率 × 衰减)，
 *   衰减 = 1 − 已过天数/30（线性），30 天后过期
 */
'use strict';

const POOL_DAYS = 30;
const MAX_RATE = 0.8;
const STONES = Object.freeze({
  LEGACY_STONE_NORMAL: { bonus: 0.10, type: 'enhanced', name: '传承石' },
  LEGACY_STONE_ADVANCED: { bonus: 0.20, type: 'enhanced', name: '高级传承石' },
  LEGACY_STONE_PERFECT: { perfect: true, type: 'perfect', name: '完美传承石' },
});

function friendshipLevel(friendship) {
  const bond = Math.floor((Math.min(255, Math.max(0, Number(friendship) || 0)) * 100) / 255);
  return Math.max(1, Math.ceil(bond / 2));
}

function baseRate(level) {
  const l = Number(level) || 1;
  if (l <= 10) return 0.05;
  if (l <= 20) return 0.10;
  if (l <= 30) return 0.20;
  if (l <= 40) return 0.30;
  return 0.50;
}

/** 放生时生成的池子 */
function poolFromPokemon(p, stoneId) {
  const stone = stoneId ? STONES[stoneId] : null;
  if (stoneId && !stone) throw new Error(`不是传承道具：${stoneId}`);
  const level = friendshipLevel(p.friendship ?? 70);
  const rate = stone && stone.perfect ? 1 : Math.min(MAX_RATE, baseRate(level) + (stone ? stone.bonus : 0));
  return {
    iv_attack_bonus: Number(p.iv_attack) || 0,
    iv_defense_bonus: Number(p.iv_defense) || 0,
    iv_hp_bonus: Number(p.iv_hp) || 0,
    cp_base_bonus: Math.round((Number(p.cp) || 0) * 0.1),
    inheritance_rate: Math.round(rate * 1000) / 1000,
    source_friendship_level: level,
    source_level: Number(p.level) || 1,
    inheritance_type: stone ? stone.type : 'normal',
  };
}

/** 同物种再次放生：逐项取大 */
function mergePool(old, fresh) {
  if (!old) return fresh;
  const take = (k) => Math.max(Number(old[k]) || 0, Number(fresh[k]) || 0);
  return {
    ...fresh,
    iv_attack_bonus: take('iv_attack_bonus'),
    iv_defense_bonus: take('iv_defense_bonus'),
    iv_hp_bonus: take('iv_hp_bonus'),
    cp_base_bonus: take('cp_base_bonus'),
    inheritance_rate: take('inheritance_rate'),
    inheritance_type: Number(fresh.inheritance_rate) >= Number(old.inheritance_rate) ? fresh.inheritance_type : old.inheritance_type,
  };
}

/** 线性衰减系数（过期为 0） */
function decay(createdAt, now = new Date()) {
  const ageDays = (now - new Date(createdAt)) / 86400000;
  if (ageDays >= POOL_DAYS) return 0;
  return Math.max(0, Math.round((1 - Math.max(0, ageDays) / POOL_DAYS) * 1000) / 1000);
}

/** 捕捉时的继承加成 */
function inheritanceBonus(pool, now = new Date()) {
  const d = decay(pool.refreshed_at || pool.created_at, now);
  const rate = Number(pool.inheritance_rate) * d;
  return {
    ivAttack: Math.round(Number(pool.iv_attack_bonus) * rate),
    ivDefense: Math.round(Number(pool.iv_defense_bonus) * rate),
    ivHp: Math.round(Number(pool.iv_hp_bonus) * rate),
    cpBonus: Math.round(Number(pool.cp_base_bonus) * rate),
    rate: Math.round(rate * 1000) / 1000,
    decay: d,
  };
}

function applyBonus(ivs, bonus) {
  return {
    attack: Math.min(15, (Number(ivs.attack) || 0) + bonus.ivAttack),
    defense: Math.min(15, (Number(ivs.defense) || 0) + bonus.ivDefense),
    hp: Math.min(15, (Number(ivs.hp) || 0) + bonus.ivHp),
  };
}

module.exports = { POOL_DAYS, MAX_RATE, STONES, friendshipLevel, baseRate, poolFromPokemon, mergePool, decay, inheritanceBonus, applyBonus };
