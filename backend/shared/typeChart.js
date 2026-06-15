/**
 * REQ-00146: 属性克制矩阵
 * 创建时间: 2026-06-15 22:10
 * 
 * 18种属性的克制关系矩阵
 * 值: 2.0 = 克制, 0.5 = 被抵抗, 0 = 免疫, 1.0 = 正常
 * 基于 Pokemon 标准属性克制表
 */

const TYPE_CHART = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
};

/**
 * 计算属性克制倍率
 * @param {string} attackType - 攻击技能属性
 * @param {string} defenderType1 - 防御者主属性
 * @param {string|null} defenderType2 - 防御者副属性（可选）
 * @returns {number} 克制倍率 (0-4)
 */
function getTypeMultiplier(attackType, defenderType1, defenderType2 = null) {
  let multiplier = 1.0;
  const chart = TYPE_CHART[attackType];
  
  if (!chart) return 1.0;
  
  // 计算主属性克制
  if (chart[defenderType1] !== undefined) {
    multiplier *= chart[defenderType1];
  }
  
  // 计算副属性克制（复合计算）
  if (defenderType2 && chart[defenderType2] !== undefined) {
    multiplier *= chart[defenderType2];
  }
  
  return multiplier;
}

/**
 * 获取效果描述文本
 * @param {number} multiplier - 克制倍率
 * @returns {string} 效果描述
 */
function getEffectivenessText(multiplier) {
  if (multiplier === 0) return 'immune';
  if (multiplier >= 2) return 'super_effective';
  if (multiplier > 1) return 'very_effective';
  if (multiplier < 0.5) return 'barely_effective';
  if (multiplier < 1) return 'not_very_effective';
  return 'normal';
}

/**
 * 获取所有有效属性列表
 * @returns {string[]}
 */
function getAllTypes() {
  return Object.keys(TYPE_CHART);
}

/**
 * 检查属性是否有效
 * @param {string} type - 属性名
 * @returns {boolean}
 */
function isValidType(type) {
  return type in TYPE_CHART;
}

/**
 * 获取某个属性对所有其他属性的克制关系
 * @param {string} attackType - 攻击属性
 * @returns {Object} 克制关系映射
 */
function getTypeEffectiveness(attackType) {
  return TYPE_CHART[attackType] || {};
}

module.exports = {
  TYPE_CHART,
  getTypeMultiplier,
  getEffectivenessText,
  getAllTypes,
  isValidType,
  getTypeEffectiveness
};
