/**
 * REQ-00076: Achievement System Seed Data
 * Created: 2026-06-27 05:00 UTC
 */

const achievements = [
  // 捕捉类成就
  {
    achievement_id: 'first_catch',
    category: 'catch',
    name: { zh: '初次捕捉', en: 'First Catch', ja: '初めての捕獲' },
    description: { zh: '捕捉你的第一只精灵', en: 'Catch your first Pokémon', ja: '最初のポケモンを捕まえる' },
    icon_url: '/assets/achievements/first_catch.png',
    rarity: 'common',
    points: 10,
    is_hidden: false,
    trigger_conditions: { type: 'catch_count', target: 1 },
    rewards: { coins: 100, items: [{ item_id: 'pokeball', count: 10 }] }
  },
  {
    achievement_id: 'catch_master_100',
    category: 'catch',
    name: { zh: '捕捉新手', en: 'Novice Catcher', ja: '捕獲初心者' },
    description: { zh: '捕捉 100 只精灵', en: 'Catch 100 Pokémon', ja: '100匹のポケモンを捕まえる' },
    icon_url: '/assets/achievements/catch_master_100.png',
    rarity: 'common',
    points: 50,
    is_hidden: false,
    trigger_conditions: { type: 'catch_count', target: 100 },
    rewards: { coins: 1000, title: 'catcher_100' },
    prerequisite_achievement_id: 'first_catch'
  },
  {
    achievement_id: 'catch_master_1000',
    category: 'catch',
    name: { zh: '捕捉大师', en: 'Catch Master', ja: '捕獲マスター' },
    description: { zh: '捕捉 1000 只精灵', en: 'Catch 1000 Pokémon', ja: '1000匹のポケモンを捕まえる' },
    icon_url: '/assets/achievements/catch_master_1000.png',
    rarity: 'epic',
    points: 200,
    is_hidden: false,
    trigger_conditions: { type: 'catch_count', target: 1000 },
    rewards: { coins: 10000, items: [{ item_id: 'lucky_egg', count: 5 }], title: 'catcher_1000' },
    prerequisite_achievement_id: 'catch_master_100'
  },
  {
    achievement_id: 'shiny_hunter',
    category: 'catch',
    name: { zh: '闪光猎人', en: 'Shiny Hunter', ja: '色違いハンター' },
    description: { zh: '捕捉第一只闪光精灵', en: 'Catch your first shiny Pokémon', ja: '最初の色違いポケモンを捕まえる' },
    icon_url: '/assets/achievements/shiny_hunter.png',
    rarity: 'rare',
    points: 100,
    is_hidden: false,
    trigger_conditions: { type: 'catch_count', target: 1, filters: { is_shiny: true } },
    rewards: { coins: 5000, title: 'shiny_hunter' }
  },
  {
    achievement_id: 'pokedex_50',
    category: 'catch',
    name: { zh: '图鉴收藏家', en: 'Pokédex Collector', ja: '図鑑コレクター' },
    description: { zh: '收集 50 种精灵', en: 'Collect 50 Pokémon species', ja: '50種のポケモンを集める' },
    icon_url: '/assets/achievements/pokedex_50.png',
    rarity: 'rare',
    points: 150,
    is_hidden: false,
    trigger_conditions: { type: 'catch_species', target: 50 },
    rewards: { coins: 3000, items: [{ item_id: 'incubator', count: 1 }] }
  },
  
  // 战斗类成就
  {
    achievement_id: 'first_battle',
    category: 'battle',
    name: { zh: '初次战斗', en: 'First Battle', ja: '初めてのバトル' },
    description: { zh: '赢得第一场战斗', en: 'Win your first battle', ja: '最初のバトルに勝つ' },
    icon_url: '/assets/achievements/first_battle.png',
    rarity: 'common',
    points: 10,
    is_hidden: false,
    trigger_conditions: { type: 'battle_win', target: 1 },
    rewards: { coins: 100 }
  },
  {
    achievement_id: 'gym_conqueror_10',
    category: 'battle',
    name: { zh: '道馆挑战者', en: 'Gym Challenger', ja: 'ジムチャレンジャー' },
    description: { zh: '攻克 10 座道馆', en: 'Conquer 10 gyms', ja: '10個のジムを攻略する' },
    icon_url: '/assets/achievements/gym_conqueror_10.png',
    rarity: 'rare',
    points: 100,
    is_hidden: false,
    trigger_conditions: { type: 'gym_conquer', target: 10 },
    rewards: { coins: 5000, items: [{ item_id: 'rare_candy', count: 5 }] }
  },
  {
    achievement_id: 'pvp_master_50',
    category: 'battle',
    name: { zh: '对战达人', en: 'PvP Expert', ja: 'PvPエキスパート' },
    description: { zh: '赢得 50 场玩家对战', en: 'Win 50 PvP battles', ja: '50回のPvPバトルに勝つ' },
    icon_url: '/assets/achievements/pvp_master_50.png',
    rarity: 'epic',
    points: 150,
    is_hidden: false,
    trigger_conditions: { type: 'battle_win', target: 50, filters: { battle_type: 'pvp' } },
    rewards: { coins: 8000, items: [{ item_id: 'premium_pass', count: 3 }], title: 'pvp_expert' }
  },
  
  // 培育类成就
  {
    achievement_id: 'first_breed',
    category: 'breed',
    name: { zh: '培育新人', en: 'Novice Breeder', ja: '育成初心者' },
    description: { zh: '培育出第一只精灵', en: 'Breed your first Pokémon', ja: '最初のポケモンを育てる' },
    icon_url: '/assets/achievements/first_breed.png',
    rarity: 'common',
    points: 20,
    is_hidden: false,
    trigger_conditions: { type: 'pokemon_breed', target: 1 },
    rewards: { coins: 200 }
  },
  {
    achievement_id: 'egg_hatcher_10',
    category: 'breed',
    name: { zh: '蛋孵化师', en: 'Egg Hatcher', ja: 'タマゴ孵化師' },
    description: { zh: '孵化 10 个精灵蛋', en: 'Hatch 10 eggs', ja: '10個のタマゴを孵化する' },
    icon_url: '/assets/achievements/egg_hatcher_10.png',
    rarity: 'common',
    points: 30,
    is_hidden: false,
    trigger_conditions: { type: 'egg_hatch', target: 10 },
    rewards: { coins: 500, items: [{ item_id: 'incubator', count: 1 }] }
  },
  {
    achievement_id: 'shiny_breeder',
    category: 'breed',
    name: { zh: '闪光培育师', en: 'Shiny Breeder', ja: '色違い育成師' },
    description: { zh: '培育出一只闪光精灵', en: 'Breed a shiny Pokémon', ja: '色違いポケモンを育てる' },
    icon_url: '/assets/achievements/shiny_breeder.png',
    rarity: 'epic',
    points: 150,
    is_hidden: false,
    trigger_conditions: { type: 'pokemon_breed', target: 1, filters: { is_shiny: true } },
    rewards: { coins: 8000, title: 'shiny_breeder' }
  },
  
  // 社交类成就
  {
    achievement_id: 'first_trade',
    category: 'social',
    name: { zh: '首次交易', en: 'First Trade', ja: '初めての交換' },
    description: { zh: '完成第一次精灵交易', en: 'Complete your first trade', ja: '最初の交換を完了する' },
    icon_url: '/assets/achievements/first_trade.png',
    rarity: 'common',
    points: 15,
    is_hidden: false,
    trigger_conditions: { type: 'trade_count', target: 1 },
    rewards: { coins: 150 }
  },
  {
    achievement_id: 'trade_master_50',
    category: 'social',
    name: { zh: '交易达人', en: 'Trade Master', ja: '交換マスター' },
    description: { zh: '完成 50 次交易', en: 'Complete 50 trades', ja: '50回の交換を完了する' },
    icon_url: '/assets/achievements/trade_master_50.png',
    rarity: 'rare',
    points: 100,
    is_hidden: false,
    trigger_conditions: { type: 'trade_count', target: 50 },
    rewards: { coins: 5000, title: 'trade_master' }
  },
  {
    achievement_id: 'friend_maker_10',
    category: 'social',
    name: { zh: '社交达人', en: 'Social Butterfly', ja: 'ソーシャルマスター' },
    description: { zh: '添加 10 位好友', en: 'Add 10 friends', ja: '10人の友達を追加する' },
    icon_url: '/assets/achievements/friend_maker_10.png',
    rarity: 'common',
    points: 30,
    is_hidden: false,
    trigger_conditions: { type: 'friend_count', target: 10 },
    rewards: { coins: 500, items: [{ item_id: 'gift_box', count: 5 }] }
  },
  
  // 探索类成就
  {
    achievement_id: 'walker_10km',
    category: 'explore',
    name: { zh: '步行者', en: 'Walker', ja: 'ウォーカー' },
    description: { zh: '累计行走 10 公里', en: 'Walk 10 kilometers', ja: '累計10キロ歩く' },
    icon_url: '/assets/achievements/walker_10km.png',
    rarity: 'common',
    points: 20,
    is_hidden: false,
    trigger_conditions: { type: 'distance_traveled', target: 10 },
    rewards: { coins: 300, items: [{ item_id: 'egg_incubator', count: 1 }] }
  },
  {
    achievement_id: 'explorer_100km',
    category: 'explore',
    name: { zh: '探险家', en: 'Explorer', ja: '探検家' },
    description: { zh: '累计行走 100 公里', en: 'Walk 100 kilometers', ja: '累計100キロ歩く' },
    icon_url: '/assets/achievements/explorer_100km.png',
    rarity: 'rare',
    points: 100,
    is_hidden: false,
    trigger_conditions: { type: 'distance_traveled', target: 100 },
    rewards: { coins: 5000, items: [{ item_id: 'super_incubator', count: 2 }], title: 'explorer' }
  },
  {
    achievement_id: 'pokestop_visitor_100',
    category: 'explore',
    name: { zh: '补给站访客', en: 'PokéStop Visitor', ja: 'ポケストップ訪問者' },
    description: { zh: '访问 100 个补给站', en: 'Visit 100 PokéStops', ja: '100個のポケストップを訪問する' },
    icon_url: '/assets/achievements/pokestop_visitor_100.png',
    rarity: 'common',
    points: 40,
    is_hidden: false,
    trigger_conditions: { type: 'pokestop_visit', target: 100 },
    rewards: { coins: 800 }
  },
  
  // 隐藏成就
  {
    achievement_id: 'lucky_encounter',
    category: 'catch',
    name: { zh: '幸运邂逅', en: 'Lucky Encounter', ja: 'ラッキーエンカウント' },
    description: { zh: '???', en: '???', ja: '???' },
    icon_url: '/assets/achievements/lucky_encounter.png',
    rarity: 'legendary',
    points: 200,
    is_hidden: true,
    trigger_conditions: { type: 'lucky_catch', target: 1 },
    rewards: { coins: 15000, items: [{ item_id: 'lucky_pendant', count: 1 }] }
  },
  {
    achievement_id: 'night_owl',
    category: 'explore',
    name: { zh: '夜猫子', en: 'Night Owl', ja: '夜型人間' },
    description: { zh: '???', en: '???', ja: '???' },
    icon_url: '/assets/achievements/night_owl.png',
    rarity: 'rare',
    points: 80,
    is_hidden: true,
    trigger_conditions: { type: 'night_catch', target: 20 },
    rewards: { coins: 3000, title: 'night_owl' }
  }
];

module.exports = achievements;
