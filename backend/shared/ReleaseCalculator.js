/**
 * REQ-00240: 精灵放生资源计算器
 * 计算精灵放生后返还的资源
 */

const db = require('./db');
const cache = require('./cache');
const logger = require('./logger');

class ReleaseCalculator {
  constructor() {
    this.rules = null;
    this.initialized = false;
  }

  /**
   * 初始化加载规则
   */
  async init() {
    if (this.initialized) return;
    
    try {
      await this.loadRules();
      this.initialized = true;
      
      // 定时刷新规则缓存
      setInterval(() => this.loadRules(), 300000); // 5分钟刷新一次
    } catch (error) {
      logger.error('Failed to initialize ReleaseCalculator', { error: error.message });
    }
  }

  /**
   * 从数据库加载规则
   */
  async loadRules() {
    try {
      const result = await db.query(`
        SELECT * FROM release_resource_rules 
        WHERE is_active = true
      `);
      this.rules = result.rows;
      logger.info('Release rules loaded', { count: this.rules.length });
    } catch (error) {
      logger.error('Failed to load release rules', { error: error.message });
      // 使用默认规则
      this.rules = this.getDefaultRules();
    }
  }

  /**
   * 获取默认规则（数据库不可用时的降级方案）
   */
  getDefaultRules() {
    return [
      { rarity: 'common', level_range: '1-10', iv_range: '0-20', resource_type: 'gold', base_amount: 10, multiplier: 1.0 },
      { rarity: 'common', level_range: '1-10', iv_range: '0-20', resource_type: 'stardust', base_amount: 50, multiplier: 1.0 },
      { rarity: 'uncommon', level_range: '1-10', iv_range: '0-20', resource_type: 'gold', base_amount: 20, multiplier: 1.0 },
      { rarity: 'uncommon', level_range: '1-10', iv_range: '0-20', resource_type: 'stardust', base_amount: 100, multiplier: 1.0 },
      { rarity: 'rare', level_range: '1-10', iv_range: '0-20', resource_type: 'gold', base_amount: 50, multiplier: 1.0 },
      { rarity: 'rare', level_range: '1-10', iv_range: '0-20', resource_type: 'stardust', base_amount: 200, multiplier: 1.0 },
      { rarity: 'epic', level_range: '1-10', iv_range: '0-20', resource_type: 'gold', base_amount: 100, multiplier: 1.0 },
      { rarity: 'epic', level_range: '1-10', iv_range: '0-20', resource_type: 'stardust', base_amount: 500, multiplier: 1.0 },
      { rarity: 'legendary', level_range: '1-10', iv_range: '0-20', resource_type: 'gold', base_amount: 500, multiplier: 1.0 },
      { rarity: 'legendary', level_range: '1-10', iv_range: '0-20', resource_type: 'stardust', base_amount: 2000, multiplier: 1.0 }
    ];
  }

  /**
   * 计算单只精灵放生返还资源
   * @param {Object} pokemon - 精灵信息
   * @returns {Object} 资源映射
   */
  calculateResources(pokemon) {
    const resources = {};
    const rarity = pokemon.rarity || 'common';
    const levelRange = this.getLevelRange(pokemon.level);
    const ivRange = this.getIVRange(pokemon.ivTotal || pokemon.iv_total || 0);

    // 查找匹配的规则
    const matchingRules = this.rules.filter(rule =>
      rule.rarity === rarity &&
      rule.level_range === levelRange &&
      rule.iv_range === ivRange
    );

    for (const rule of matchingRules) {
      let amount = parseFloat(rule.base_amount) * parseFloat(rule.multiplier);
      
      // 闪光精灵双倍奖励
      if (pokemon.isShiny || pokemon.is_shiny) {
        amount *= 2;
      }

      const resourceType = rule.resource_type;
      if (resources[resourceType]) {
        resources[resourceType] += amount;
      } else {
        resources[resourceType] = amount;
      }
    }

    // 四舍五入到整数
    for (const key of Object.keys(resources)) {
      resources[key] = Math.round(resources[key]);
    }

    return resources;
  }

  /**
   * 批量计算资源
   * @param {Array} pokemonList - 精灵列表
   * @returns {Object} 总资源和详情
   */
  calculateBatchResources(pokemonList) {
    const totalResources = {};
    const details = [];

    for (const pokemon of pokemonList) {
      const resources = this.calculateResources(pokemon);
      details.push({
        pokemonId: pokemon.id,
        speciesId: pokemon.species_id || pokemon.speciesId,
        name: pokemon.name,
        resources
      });

      // 累加总资源
      for (const [type, amount] of Object.entries(resources)) {
        if (totalResources[type]) {
          totalResources[type] += amount;
        } else {
          totalResources[type] = amount;
        }
      }
    }

    return { totalResources, details };
  }

  /**
   * 检查是否需要二次确认
   * @param {Object} pokemon - 精灵信息
   * @returns {boolean}
   */
  requiresConfirmation(pokemon) {
    const ivTotal = pokemon.ivTotal || pokemon.iv_total || 0;
    const level = pokemon.level || 1;
    const rarity = pokemon.rarity || 'common';
    const isShiny = pokemon.isShiny || pokemon.is_shiny;

    // 高 IV 值精灵
    if (ivTotal >= 80) return true;
    
    // 稀有精灵
    if (['legendary', 'mythical', 'ultra_beast'].includes(rarity)) {
      return true;
    }
    
    // 闪光精灵
    if (isShiny) return true;
    
    // 高等级精灵
    if (level >= 50) return true;

    return false;
  }

  /**
   * 获取等级范围
   * @param {number} level
   * @returns {string}
   */
  getLevelRange(level) {
    level = Math.max(1, Math.min(50, level || 1));
    if (level <= 10) return '1-10';
    if (level <= 20) return '11-20';
    if (level <= 30) return '21-30';
    if (level <= 40) return '31-40';
    return '41-50';
  }

  /**
   * 获取IV范围
   * @param {number} ivTotal
   * @returns {string}
   */
  getIVRange(ivTotal) {
    ivTotal = Math.max(0, Math.min(100, ivTotal || 0));
    if (ivTotal <= 20) return '0-20';
    if (ivTotal <= 40) return '21-40';
    if (ivTotal <= 60) return '41-60';
    if (ivTotal <= 80) return '61-80';
    return '81-100';
  }

  /**
   * 获取资源类型显示名称
   * @param {string} type
   * @returns {string}
   */
  getResourceTypeName(type) {
    const names = {
      gold: '金币',
      stardust: '星尘',
      candy: '糖果',
      rare_candy: '稀有糖果',
      evolution_stone: '进化石',
      tm_fragment: '技能机碎片'
    };
    return names[type] || type;
  }
}

// 导出单例
const calculator = new ReleaseCalculator();
calculator.init();

module.exports = calculator;
