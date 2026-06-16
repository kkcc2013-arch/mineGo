/**
 * 季节引擎核心模块
 * 实现基于真实季节的游戏内容动态变化
 */

const SEASONS = {
  SPRING: { name: 'spring', months: [3, 4, 5], icon: '🌸', color: '#FFB7C5' },
  SUMMER: { name: 'summer', months: [6, 7, 8], icon: '☀️', color: '#FFD700' },
  AUTUMN: { name: 'autumn', months: [9, 10, 11], icon: '🍂', color: '#FF8C00' },
  WINTER: { name: 'winter', months: [12, 1, 2], icon: '❄️', color: '#87CEEB' }
};

const SEASONAL_BONUSES = {
  SPRING: {
    grass: 1.5, bug: 1.3, fairy: 1.2,
    fire: 0.8, ice: 0.7
  },
  SUMMER: {
    fire: 1.5, water: 1.3, bug: 1.2,
    ice: 0.7, rock: 0.8
  },
  AUTUMN: {
    grass: 1.3, ghost: 1.5, dark: 1.2,
    ice: 0.8, fairy: 0.9
  },
  WINTER: {
    ice: 1.5, steel: 1.3, water: 1.2,
    fire: 0.8, grass: 0.7
  }
};

const SEASONAL_POKEMON = {
  SPRING: {
    common: ['bellsprout', 'oddish', 'hoppip', 'budew'],
    rare: ['shaymin', 'celebi', 'cherubi'],
    spawnBonus: { 'bulbasaur': 2.0, 'charmander': 0.5 }
  },
  SUMMER: {
    common: ['charmander', 'growlithe', 'vulpix', 'torchic'],
    rare: ['groudon', 'entei', 'heatran'],
    spawnBonus: { 'squirtle': 2.0, 'snover': 0.3 }
  },
  AUTUMN: {
    common: ['gastly', 'misdreavus', 'pumpkaboo', 'phantump'],
    rare: ['giratina', 'darkrai', 'hoopa'],
    spawnBonus: { 'musharna': 1.8, 'deino': 1.5 }
  },
  WINTER: {
    common: ['snover', 'spheal', 'snorunt', 'cubchoo'],
    rare: ['kyogre', 'articuno', 'suicune'],
    spawnBonus: { 'snover': 2.5, 'lapras': 2.0 }
  }
};

const SEASONAL_QUESTS = {
  SPRING: [
    { id: 'spring_catch_10', name: '春日捕捉', task: '捕捉 10 只草系精灵', taskType: 'catch_type', targetValue: 10, reward: { stardust: 500, item: 'lucky_egg' } },
    { id: 'spring_evolve_5', name: '生命绽放', task: '进化 5 只精灵', taskType: 'evolve', targetValue: 5, reward: { xp: 2000, item: 'sun_stone' } },
    { id: 'spring_walk_5km', name: '春游踏青', task: '行走 5 公里', taskType: 'walk_distance', targetValue: 5000, reward: { candy: 10, item: 'incense' } }
  ],
  SUMMER: [
    { id: 'summer_catch_15', name: '夏日炎炎', task: '捕捉 15 只火系精灵', taskType: 'catch_type', targetValue: 15, reward: { stardust: 600, item: 'heat_rock' } },
    { id: 'summer_gym_5', name: '沙滩对决', task: '参与 5 次道馆战斗', taskType: 'gym_battle', targetValue: 5, reward: { xp: 3000, item: 'rare_candy' } },
    { id: 'summer_hatch_3', name: '烈日孵化', task: '孵化 3 个蛋', taskType: 'hatch_eggs', targetValue: 3, reward: { stardust: 800, item: 'super_incubator' } }
  ],
  AUTUMN: [
    { id: 'autumn_catch_ghost', name: '幽灵之夜', task: '捕捉 10 只幽灵系精灵', taskType: 'catch_type', targetValue: 10, reward: { stardust: 700, item: 'dusk_stone' } },
    { id: 'autumn_trade_3', name: '秋收分享', task: '完成 3 次精灵交易', taskType: 'trade', targetValue: 3, reward: { xp: 2500, item: 'trade_ticket' } },
    { id: 'autumn_spin_20', name: '落叶寻宝', task: '旋转 20 个 PokéStop', taskType: 'spin_pokestops', targetValue: 20, reward: { item: 'pumpkin_berry', qty: 10 } }
  ],
  WINTER: [
    { id: 'winter_catch_ice', name: '冰雪奇缘', task: '捕捉 10 只冰系精灵', taskType: 'catch_type', targetValue: 10, reward: { stardust: 800, item: 'glacial_lure' } },
    { id: 'winter_buddy_3', name: '冬日陪伴', task: '与伙伴精灵互动 3 次', taskType: 'buddy_interact', targetValue: 3, reward: { hearts: 3, item: 'poffin' } },
    { id: 'winter_gift_5', name: '冬日礼物', task: '发送 5 份礼物给好友', taskType: 'send_gifts', targetValue: 5, reward: { xp: 1500, item: 'holiday_box' } }
  ]
};

class SeasonalEngine {
  constructor() {
    this.currentSeason = this.detectSeason();
    this.seasonConfig = null;
    this.transitionProgress = 0;
  }

  /**
   * 根据当前月份检测季节
   */
  detectSeason() {
    const month = new Date().getMonth() + 1;
    for (const [key, season] of Object.entries(SEASONS)) {
      if (season.months.includes(month)) {
        return key;
      }
    }
    return 'SPRING';
  }

  /**
   * 获取季节信息
   */
  getSeasonInfo(seasonKey = this.currentSeason) {
    return SEASONS[seasonKey] || SEASONS.SPRING;
  }

  /**
   * 加载季节配置
   */
  async loadSeasonConfig(season) {
    const config = {
      season: SEASONS[season],
      bonuses: SEASONAL_BONUSES[season],
      pokemon: SEASONAL_POKEMON[season],
      quests: SEASONAL_QUESTS[season]
    };
    this.seasonConfig = config;
    return config;
  }

  /**
   * 计算季节过渡进度（0-1）
   * 季节最后15天开始过渡
   */
  calculateTransitionProgress() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), month, 0).getDate();

    const seasonEnd = SEASONS[this.currentSeason].months[2];
    if (month === seasonEnd && day > daysInMonth - 15) {
      return (day - (daysInMonth - 15)) / 15;
    }
    return 0;
  }

  /**
   * 获取下一个季节
   */
  getNextSeason() {
    const order = ['SPRING', 'SUMMER', 'AUTUMN', 'WINTER'];
    const currentIndex = order.indexOf(this.currentSeason);
    return order[(currentIndex + 1) % 4];
  }

  /**
   * 获取季节类型加成
   */
  getSeasonalBonus(pokemonType) {
    return SEASONAL_BONUSES[this.currentSeason]?.[pokemonType] || 1.0;
  }

  /**
   * 批量获取类型加成
   */
  getTypeBonuses() {
    return SEASONAL_BONUSES[this.currentSeason] || {};
  }

  /**
   * 获取季节专属精灵列表
   */
  getSeasonalPokemon() {
    return SEASONAL_POKEMON[this.currentSeason] || SEASONAL_POKEMON.SPRING;
  }

  /**
   * 获取季节专属任务
   */
  getSeasonalQuests() {
    return SEASONAL_QUESTS[this.currentSeason] || [];
  }

  /**
   * 计算精灵刷新权重
   * @param {string} pokemonId - 精灵ID
   * @param {string} pokemonType - 精灵类型
   * @param {number} baseWeight - 基础权重
   */
  calculateSpawnWeight(pokemonId, pokemonType, baseWeight = 1.0) {
    const seasonalPool = this.getSeasonalPokemon();

    // 1. 类型加成
    const typeBonus = this.getSeasonalBonus(pokemonType);

    // 2. 季节专属加成
    const spawnBonus = seasonalPool.spawnBonus?.[pokemonId] || 1.0;

    // 3. 季节专属精灵池加成
    const inCommonPool = seasonalPool.common.includes(pokemonId);
    const inRarePool = seasonalPool.rare.includes(pokemonId);
    const poolBonus = inRarePool ? 2.0 : (inCommonPool ? 1.5 : 1.0);

    return baseWeight * typeBonus * spawnBonus * poolBonus;
  }

  /**
   * 获取季节热点位置类型
   */
  getHotspotTypes() {
    const hotspotTypes = {
      SPRING: ['park', 'garden', 'botanical_garden'],
      SUMMER: ['beach', 'water_park', 'swimming_pool'],
      AUTUMN: ['forest', 'cemetery', 'nature_reserve'],
      WINTER: ['ski_resort', 'ice_rink', 'mountain']
    };
    return hotspotTypes[this.currentSeason] || hotspotTypes.SPRING;
  }

  /**
   * 获取季节过渡消息
   */
  getTransitionMessage(newSeason) {
    const messages = {
      SPRING: '🌸 春天来了！草系和虫系精灵出现率提升！',
      SUMMER: '☀️ 夏日炎炎！火系精灵活跃度大增！',
      AUTUMN: '🍂 秋风送爽！幽灵系精灵开始出没！',
      WINTER: '❄️ 寒冬降临！冰系精灵降临！'
    };
    return messages[newSeason] || '';
  }

  /**
   * 检查是否在特定季节
   */
  isSeason(season) {
    return this.currentSeason === season;
  }

  /**
   * 获取所有季节定义
   */
  static getAllSeasons() {
    return SEASONS;
  }

  /**
   * 获取所有季节加成
   */
  static getAllBonuses() {
    return SEASONAL_BONUSES;
  }
}

module.exports = {
  SeasonalEngine,
  SEASONS,
  SEASONAL_BONUSES,
  SEASONAL_POKEMON,
  SEASONAL_QUESTS
};
