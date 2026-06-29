/**
 * REQ-00086: 精灵特性系统种子数据
 * 包含常见特性定义和精灵特性映射
 */

const abilities = [
  // 被动特性
  {
    id: 'intimidate',
    name_en: 'Intimidate',
    name_zh: '威吓',
    description: '出场时降低对手的攻击。在对战开始时，对手的攻击降低1级。',
    type: 'passive',
    priority: 1,
    is_hidden: false,
    effect_config: {
      type: 'stat_modifier',
      target: 'opponent',
      stat: 'attack',
      stage: -1,
      trigger: 'on_enter'
    }
  },
  {
    id: 'static',
    name_en: 'Static',
    name_zh: '静电',
    description: '接触攻击时有30%几率让对手陷入麻痹状态。',
    type: 'trigger',
    priority: 2,
    is_hidden: false,
    trigger_condition: { type: 'contact_move' },
    effect_config: {
      type: 'status',
      status: 'paralyze',
      probability: 0.3,
      target: 'attacker'
    }
  },
  {
    id: 'blaze',
    name_en: 'Blaze',
    name_zh: '猛火',
    description: 'HP减少时，火属性的招式威力提高。当HP降到1/3以下时，火属性招式的威力变为1.5倍。',
    type: 'trigger',
    priority: 2,
    is_hidden: false,
    trigger_condition: { type: 'hp_threshold', threshold: 0.33 },
    effect_config: {
      type: 'damage_multiplier',
      moveType: 'fire',
      multiplier: 1.5
    }
  },
  {
    id: 'torrent',
    name_en: 'Torrent',
    name_zh: '激流',
    description: 'HP减少时，水属性的招式威力提高。当HP降到1/3以下时，水属性招式的威力变为1.5倍。',
    type: 'trigger',
    priority: 2,
    is_hidden: false,
    trigger_condition: { type: 'hp_threshold', threshold: 0.33 },
    effect_config: {
      type: 'damage_multiplier',
      moveType: 'water',
      multiplier: 1.5
    }
  },
  {
    id: 'overgrow',
    name_en: 'Overgrow',
    name_zh: '茂盛',
    description: 'HP减少时，草属性的招式威力提高。当HP降到1/3以下时，草属性招式的威力变为1.5倍。',
    type: 'trigger',
    priority: 2,
    is_hidden: false,
    trigger_condition: { type: 'hp_threshold', threshold: 0.33 },
    effect_config: {
      type: 'damage_multiplier',
      moveType: 'grass',
      multiplier: 1.5
    }
  },
  {
    id: 'swarm',
    name_en: 'Swarm',
    name_zh: '虫之预感',
    description: 'HP减少时，虫属性的招式威力提高。当HP降到1/3以下时，虫属性招式的威力变为1.5倍。',
    type: 'trigger',
    priority: 2,
    is_hidden: false,
    trigger_condition: { type: 'hp_threshold', threshold: 0.33 },
    effect_config: {
      type: 'damage_multiplier',
      moveType: 'bug',
      multiplier: 1.5
    }
  },

  // 环境特性
  {
    id: 'drizzle',
    name_en: 'Drizzle',
    name_zh: '降雨',
    description: '出场时将天气变为雨天。下雨天气持续5回合。',
    type: 'environment',
    priority: 1,
    is_hidden: false,
    effect_config: {
      type: 'weather_change',
      weather: 'rain',
      duration: 5
    }
  },
  {
    id: 'drought',
    name_en: 'Drought',
    name_zh: '日照',
    description: '出场时将天气变为大晴天。大晴天持续5回合。',
    type: 'environment',
    priority: 1,
    is_hidden: false,
    effect_config: {
      type: 'weather_change',
      weather: 'harsh_sunlight',
      duration: 5
    }
  },
  {
    id: 'sandstream',
    name_en: 'Sand Stream',
    name_zh: '扬沙',
    description: '出场时将天气变为沙暴。沙暴天气持续5回合。',
    type: 'environment',
    priority: 1,
    is_hidden: false,
    effect_config: {
      type: 'weather_change',
      weather: 'sandstorm',
      duration: 5
    }
  },
  {
    id: 'snow-warning',
    name_en: 'Snow Warning',
    name_zh: '降雪',
    description: '出场时将天气变为冰雹。冰雹天气持续5回合。',
    type: 'environment',
    priority: 1,
    is_hidden: false,
    effect_config: {
      type: 'weather_change',
      weather: 'hail',
      duration: 5
    }
  },

  // 免疫特性
  {
    id: 'levitate',
    name_en: 'Levitate',
    name_zh: '漂浮',
    description: '免疫地面属性招式。具有该特性的精灵不会受到地面属性招式的伤害。',
    type: 'immunity',
    priority: 0,
    is_hidden: false,
    effect_config: {
      type: 'immune',
      to: ['ground']
    }
  },
  {
    id: 'water-absorb',
    name_en: 'Water Absorb',
    name_zh: '储水',
    description: '受到水属性招式攻击时，回复HP而不是受到伤害。',
    type: 'immunity',
    priority: 0,
    is_hidden: false,
    effect_config: {
      type: 'absorb',
      moveType: 'water',
      healPercent: 25
    }
  },
  {
    id: 'volt-absorb',
    name_en: 'Volt Absorb',
    name_zh: '蓄电',
    description: '受到电属性招式攻击时，回复HP而不是受到伤害。',
    type: 'immunity',
    priority: 0,
    is_hidden: false,
    effect_config: {
      type: 'absorb',
      moveType: 'electric',
      healPercent: 25
    }
  },
  {
    id: 'flash-fire',
    name_en: 'Flash Fire',
    name_zh: '引火',
    description: '受到火属性招式攻击时，该招式无效，且自己的火属性招式威力提升1.5倍。',
    type: 'immunity',
    priority: 0,
    is_hidden: false,
    effect_config: {
      type: 'immune_boost',
      moveType: 'fire',
      boostStat: 'fire_damage',
      boostMultiplier: 1.5
    }
  },

  // 转换特性
  {
    id: 'protean',
    name_en: 'Protean',
    name_zh: '变幻自如',
    description: '使用招式前，变为与该招式相同的属性。',
    type: 'transformation',
    priority: 0,
    is_hidden: true,
    trigger_condition: { type: 'before_move' },
    effect_config: {
      type: 'type_change',
      changeTo: 'move_type'
    }
  },
  {
    id: 'libero',
    name_en: 'Libero',
    name_zh: '自由者',
    description: '使用招式前，变为与该招式相同的属性。',
    type: 'transformation',
    priority: 0,
    is_hidden: true,
    trigger_condition: { type: 'before_move' },
    effect_config: {
      type: 'type_change',
      changeTo: 'move_type'
    }
  },

  // 其他常见特性
  {
    id: 'sturdy',
    name_en: 'Sturdy',
    name_zh: '结实',
    description: 'HP满时，即使受到致命伤害也能以1HP存活。一击必杀招式无效。',
    type: 'passive',
    priority: 0,
    is_hidden: false,
    effect_config: {
      type: 'survive_ohko',
      minHpPercent: 1
    }
  },
  {
    id: 'guts',
    name_en: 'Guts',
    name_zh: '毅力',
    description: '异常状态时，攻击提升1.5倍。',
    type: 'trigger',
    priority: 1,
    is_hidden: false,
    trigger_condition: { type: 'has_status' },
    effect_config: {
      type: 'stat_boost',
      stat: 'attack',
      multiplier: 1.5
    }
  },
  {
    id: 'speed-boost',
    name_en: 'Speed Boost',
    name_zh: '加速',
    description: '每回合结束时，速度提升1级。',
    type: 'trigger',
    priority: 2,
    is_hidden: true,
    trigger_condition: { type: 'turn_end' },
    effect_config: {
      type: 'stat_stage',
      stat: 'speed',
      stage: 1
    }
  },
  {
    id: 'poison-heal',
    name_en: 'Poison Heal',
    name_zh: '毒性治疗',
    description: '中毒状态时，每回合回复1/8的HP而不是受到伤害。',
    type: 'trigger',
    priority: 1,
    is_hidden: true,
    trigger_condition: { type: 'status', status: 'poison' },
    effect_config: {
      type: 'heal',
      percent: 12.5,
      condition: 'poisoned'
    }
  },

  // 隐藏特性示例
  {
    id: 'lightning-rod',
    name_en: 'Lightning Rod',
    name_zh: '避雷针',
    description: '将对手的电属性招式引向自己，且电属性招式无效，特攻提升1级。',
    type: 'immunity',
    priority: 1,
    is_hidden: true,
    effect_config: {
      type: 'redirect_immune_boost',
      moveType: 'electric',
      boostStat: 'special_attack',
      boostStage: 1
    }
  },
  {
    id: 'hidden-water-bubble',
    name_en: 'Water Bubble',
    name_zh: '水泡',
    description: '水属性招式威力提高1倍，且火属性招式威力减半，不会陷入灼伤状态。',
    type: 'passive',
    priority: 0,
    is_hidden: true,
    effect_config: {
      type: 'multiple',
      effects: [
        { type: 'damage_multiplier', moveType: 'water', multiplier: 2.0 },
        { type: 'damage_reduction', fromType: 'fire', multiplier: 0.5 },
        { type: 'status_immune', statuses: ['burn'] }
      ]
    }
  }
];

// 精灵特性映射
const pokemonAbilities = [
  // 皮卡丘
  { pokemon_species_id: 'pikachu', ability_id: 'static', slot: 1, probability: 0.65 },
  { pokemon_species_id: 'pikachu', ability_id: 'lightning-rod', slot: 3, probability: 1.0 },

  // 小火龙
  { pokemon_species_id: 'charmander', ability_id: 'blaze', slot: 1, probability: 0.875 },
  { pokemon_species_id: 'charmander', ability_id: 'solar-power', slot: 3, probability: 1.0 },

  // 杰尼龟
  { pokemon_species_id: 'squirtle', ability_id: 'torrent', slot: 1, probability: 0.875 },
  { pokemon_species_id: 'squirtle', ability_id: 'rain-dish', slot: 3, probability: 1.0 },

  // 妙蛙种子
  { pokemon_species_id: 'bulbasaur', ability_id: 'overgrow', slot: 1, probability: 0.875 },
  { pokemon_species_id: 'bulbasaur', ability_id: 'chlorophyll', slot: 3, probability: 1.0 },

  // 超梦
  { pokemon_species_id: 'mewtwo', ability_id: 'pressure', slot: 1, probability: 1.0 },
  { pokemon_species_id: 'mewtwo', ability_id: 'unnerve', slot: 3, probability: 1.0 },

  // 快龙
  { pokemon_species_id: 'dragonite', ability_id: 'inner-focus', slot: 1, probability: 0.5 },
  { pokemon_species_id: 'dragonite', ability_id: 'multiscale', slot: 3, probability: 1.0 },

  // 班基拉斯
  { pokemon_species_id: 'tyranitar', ability_id: 'sandstream', slot: 1, probability: 1.0 },
  { pokemon_species_id: 'tyranitar', ability_id: 'unnerve', slot: 3, probability: 1.0 },

  // 暴鲤龙
  { pokemon_species_id: 'gyarados', ability_id: 'intimidate', slot: 1, probability: 1.0 },
  { pokemon_species_id: 'gyarados', ability_id: 'mold-breaker', slot: 3, probability: 1.0 }
];

// 特性道具
const abilityItems = [
  {
    id: 'ability_capsule',
    name_en: 'Ability Capsule',
    name_zh: '特性胶囊',
    description: '可以在精灵的两个普通特性之间切换。',
    item_type: 'ability_capsule',
    rarity: 'rare',
    effect_config: {
      type: 'switch_normal_ability'
    },
    obtained_from: ['shop', 'event_reward', 'rare_drop']
  },
  {
    id: 'ability_patch',
    name_en: 'Ability Patch',
    name_zh: '特性膏药',
    description: '可以解锁精灵的隐藏特性。',
    item_type: 'ability_patch',
    rarity: 'legendary',
    effect_config: {
      type: 'unlock_hidden_ability'
    },
    obtained_from: ['event_reward', 'max_raid', 'legendary_drop']
  }
];

module.exports = {
  abilities,
  pokemonAbilities,
  abilityItems
};
