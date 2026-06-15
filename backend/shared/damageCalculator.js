/**
 * REQ-00146: 伤害计算引擎
 * 创建时间: 2026-06-15 22:10
 * 
 * Pokemon GO 风格伤害公式
 * Damage = floor(0.5 * Power * (Attack/Defense) * STAB * Type * Random) + 1
 */

const { getTypeMultiplier, getEffectivenessText } = require('./typeChart');

/**
 * 天气与属性对应关系
 */
const WEATHER_BOOST_MAP = {
  sunny: ['fire', 'grass', 'ground'],
  rainy: ['water', 'electric', 'bug'],
  cloudy: ['fighting', 'poison', 'fairy'],
  windy: ['dragon', 'flying', 'psychic'],
  snowy: ['ice', 'steel'],
  foggy: ['dark', 'ghost'],
  clear: [],
  partly_cloudy: []
};

/**
 * 检查属性是否受天气加成
 * @param {string} type - 属性
 * @param {string} weather - 天气类型
 * @returns {boolean}
 */
function isWeatherBoosted(type, weather) {
  const boosted = WEATHER_BOOST_MAP[weather];
  return boosted ? boosted.includes(type) : false;
}

/**
 * 计算伤害
 * @param {Object} params - 伤害计算参数
 * @returns {Object} 伤害结果
 */
function calculateDamage(params) {
  const {
    power,           // 技能威力
    attack,          // 攻击力
    defense,         // 防御力
    attackType,      // 技能属性
    attackerType1,   // 攻击者属性1
    attackerType2,   // 攻击者属性2 (可选)
    defenderType1,   // 防御者属性1
    defenderType2,   // 防御者属性2 (可选)
    isCharged = false, // 是否为蓄力技能
    weatherBoost = null, // 天气加成类型
    criticalHit = false // 是否暴击
  } = params;

  // 参数验证
  if (!power || !attack || !defense) {
    throw new Error('Missing required damage parameters: power, attack, defense');
  }

  // 默认值处理
  const moveType = attackType || 'normal';
  const attackerType1Value = attackerType1 || 'normal';
  const defenderType1Value = defenderType1 || 'normal';

  // 属性克制倍率
  const typeMultiplier = getTypeMultiplier(moveType, defenderType1Value, defenderType2);

  // 免疫判定
  if (typeMultiplier === 0) {
    return {
      damage: 0,
      effectiveness: 'immune',
      typeMultiplier: 0,
      stab: 1.0,
      weatherMultiplier: 1.0,
      randomFactor: 0,
      isImmune: true,
      isCritical: false,
      isCharged
    };
  }

  // STAB 加成 (同属性加成)
  let stab = 1.0;
  if (moveType === attackerType1Value || moveType === attackerType2) {
    stab = 1.2; // Pokemon GO 使用 1.2x STAB
  }

  // 天气加成
  let weatherMultiplier = 1.0;
  if (weatherBoost && isWeatherBoosted(moveType, weatherBoost)) {
    weatherMultiplier = 1.2;
  }

  // 随机因子 (85%-100%)
  const randomFactor = 0.85 + Math.random() * 0.15;

  // 暴击加成
  const critMultiplier = criticalHit ? 1.5 : 1.0;

  // 伤害公式 (Pokemon GO 风格)
  const baseDamage = 0.5 * power * (attack / defense);
  const rawDamage = baseDamage * stab * typeMultiplier * weatherMultiplier * randomFactor * critMultiplier;
  const damage = Math.max(1, Math.floor(rawDamage) + 1);

  // 效果提示
  const effectiveness = getEffectivenessText(typeMultiplier);

  return {
    damage,
    effectiveness,
    typeMultiplier,
    stab,
    weatherMultiplier,
    randomFactor,
    isImmune: false,
    isCritical: criticalHit,
    isCharged,
    breakdown: {
      baseDamage,
      stabBonus: stab,
      typeBonus: typeMultiplier,
      weatherBonus: weatherMultiplier,
      randomFactor,
      critBonus: critMultiplier
    }
  };
}

/**
 * 批量计算伤害（用于团队战斗）
 * @param {Array} attacks - 攻击参数数组
 * @returns {Array} 伤害结果数组
 */
function calculateDamageBatch(attacks) {
  return attacks.map(attack => calculateDamage(attack));
}

/**
 * 估算平均伤害（不含随机因子）
 * @param {Object} params - 伤害计算参数
 * @returns {Object} 平均伤害结果
 */
function estimateAverageDamage(params) {
  const result = calculateDamage({ ...params, randomFactor: 0.925 }); // 使用中间值
  return {
    minDamage: Math.max(1, Math.floor(result.breakdown.baseDamage * 0.85 * result.stab * result.typeMultiplier * result.weatherMultiplier) + 1),
    maxDamage: Math.max(1, Math.floor(result.breakdown.baseDamage * result.stab * result.typeMultiplier * result.weatherMultiplier) + 1),
    avgDamage: result.damage,
    effectiveness: result.effectiveness,
    typeMultiplier: result.typeMultiplier
  };
}

/**
 * 计算战斗回合数预估
 * @param {number} damage - 每回合伤害
 * @param {number} defenderHp - 防御者HP
 * @param {number} attackDuration - 攻击间隔(ms)
 * @returns {Object} 战斗预估
 */
function estimateBattleDuration(damage, defenderHp, attackDuration = 1000) {
  const turnsToDefeat = Math.ceil(defenderHp / damage);
  const estimatedTimeMs = turnsToDefeat * attackDuration;
  
  return {
    turns: turnsToDefeat,
    estimatedTimeMs,
    estimatedTimeSeconds: Math.ceil(estimatedTimeMs / 1000)
  };
}

module.exports = {
  calculateDamage,
  calculateDamageBatch,
  estimateAverageDamage,
  estimateBattleDuration,
  isWeatherBoosted,
  WEATHER_BOOST_MAP
};
