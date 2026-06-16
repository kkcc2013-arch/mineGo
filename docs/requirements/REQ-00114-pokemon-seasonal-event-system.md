# REQ-00114: 精灵季节活动系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00114 |
| 标题 | 精灵季节活动系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | location-service、catch-service、pokemon-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-11 14:00 |

## 需求描述

实现基于真实季节（春/夏/秋/冬）的游戏内容动态变化系统，包括：
- 季节专属精灵出现率调整
- 季节限定皮肤与视觉效果
- 季节性活动任务与奖励
- 季节专属道具与资源
- 跨季节过渡动画与公告

提升游戏沉浸感，增加玩家留存率，创造季节性商业机会。

## 技术方案

### 1. 季节配置与规则引擎

```javascript
// backend/shared/seasonalEngine.js

const SEASONS = {
  SPRING: { name: 'spring', months: [3, 4, 5], icon: '🌸', color: '#FFB7C5' },
  SUMMER: { name: 'summer', months: [6, 7, 8], icon: '☀️', color: '#FFD700' },
  AUTUMN: { name: 'autumn', months: [9, 10, 11], icon: '🍂', color: '#FF8C00' },
  WINTER: { name: 'winter', months: [12, 1, 2], icon: '❄️', color: '#87CEEB' }
};

class SeasonalEngine {
  constructor() {
    this.currentSeason = this.detectSeason();
    this.seasonConfig = null;
    this.transitionProgress = 0;
  }

  detectSeason() {
    const month = new Date().getMonth() + 1;
    for (const [key, season] of Object.entries(SEASONS)) {
      if (season.months.includes(month)) {
        return key;
      }
    }
    return 'SPRING';
  }

  async loadSeasonConfig(season) {
    const config = await this.fetchSeasonConfig(season);
    this.seasonConfig = config;
    return config;
  }

  // 计算季节过渡进度（0-1）
  calculateTransitionProgress() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), month, 0).getDate();
    
    // 季节最后15天开始过渡
    const seasonEnd = SEASONS[this.currentSeason].months[2];
    if (month === seasonEnd && day > daysInMonth - 15) {
      return (day - (daysInMonth - 15)) / 15;
    }
    return 0;
  }

  // 获取季节加成
  getSeasonalBonus(pokemonType) {
    const bonuses = {
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
    
    return bonuses[this.currentSeason]?.[pokemonType] || 1.0;
  }

  // 获取季节专属精灵列表
  getSeasonalPokemon() {
    const seasonalPools = {
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
    
    return seasonalPools[this.currentSeason];
  }

  // 获取季节专属任务
  getSeasonalQuests(userId) {
    const quests = {
      SPRING: [
        { id: 'spring_catch_10', name: '春日捕捉', task: '捕捉 10 只草系精灵', reward: { stardust: 500, item: 'lucky_egg' } },
        { id: 'spring_evolve_5', name: '生命绽放', task: '进化 5 只精灵', reward: { xp: 2000, item: 'sun_stone' } },
        { id: 'spring_walk_5km', name: '春游踏青', task: '行走 5 公里', reward: { candy: 10, item: 'incense' } }
      ],
      SUMMER: [
        { id: 'summer_catch_15', name: '夏日炎炎', task: '捕捉 15 只火系精灵', reward: { stardust: 600, item: 'heat_rock' } },
        { id: 'summer_gym_5', name: '沙滩对决', task: '参与 5 次道馆战斗', reward: { xp: 3000, item: 'rare_candy' } },
        { id: 'summer_hatch_3', name: '烈日孵化', task: '孵化 3 个蛋', reward: { stardust: 800, item: 'super_incubator' } }
      ],
      AUTUMN: [
        { id: 'autumn_catch_ghost', name: '幽灵之夜', task: '捕捉 10 只幽灵系精灵', reward: { stardust: 700, item: 'dusk_stone' } },
        { id: 'autumn_trade_3', name: '秋收分享', task: '完成 3 次精灵交易', reward: { xp: 2500, item: 'trade_ticket' } },
        { id: 'autumn_spin_20', name: '落叶寻宝', task: '旋转 20 个 PokéStop', reward: { item: 'pumpkin_berry', qty: 10 } }
      ],
      WINTER: [
        { id: 'winter_catch_ice', name: '冰雪奇缘', task: '捕捉 10 只冰系精灵', reward: { stardust: 800, item: 'glacial_lure' } },
        { id: 'winter_buddy_3', name: '冬日陪伴', task: '与伙伴精灵互动 3 次', reward: { hearts: 3, item: 'poffin' } },
        { id: 'winter_gift_5', name: '冬日礼物', task: '发送 5 份礼物给好友', reward: { xp: 1500, item: 'holiday_box' } }
      ]
    };
    
    return quests[this.currentSeason];
  }
}

module.exports = { SeasonalEngine, SEASONS };
```

### 2. 季节服务集成

```javascript
// backend/services/location-service/src/seasonalSpawn.js

const { SeasonalEngine } = require('../../shared/seasonalEngine');

class SeasonalSpawnManager {
  constructor() {
    this.engine = new SeasonalEngine();
    this.lastSeasonCheck = null;
  }

  async initialize() {
    await this.engine.loadSeasonConfig(this.engine.currentSeason);
    this.scheduleSeasonalRefresh();
  }

  // 应用季节加成到刷新权重
  applySeasonalBonuses(spawnWeights, pokemonTypes) {
    const modifiedWeights = { ...spawnWeights };
    const seasonalPool = this.engine.getSeasonalPokemon();
    
    for (const [pokemonId, weight] of Object.entries(modifiedWeights)) {
      const type = pokemonTypes[pokemonId];
      
      // 1. 类型加成
      const typeBonus = this.engine.getSeasonalBonus(type);
      
      // 2. 季节专属加成
      const spawnBonus = seasonalPool.spawnBonus?.[pokemonId] || 1.0;
      
      // 3. 季节专属精灵池加成
      const inPool = seasonalPool.common.includes(pokemonId) ? 1.5 : 
                     seasonalPool.rare.includes(pokemonId) ? 2.0 : 1.0;
      
      modifiedWeights[pokemonId] = weight * typeBonus * spawnBonus * inPool;
    }
    
    return modifiedWeights;
  }

  // 季节性稀有精灵刷新
  scheduleSeasonalRareSpawn() {
    const seasonalPool = this.engine.getSeasonalPokemon();
    const rarePokemon = seasonalPool.rare;
    
    // 每天 2 次稀有精灵刷新机会
    const scheduleTimes = ['12:00', '18:00'];
    
    for (const time of scheduleTimes) {
      cron.schedule(`${time.split(':')[1]} ${time.split(':')[0]} * * *`, async () => {
        await this.spawnSeasonalRare(rarePokemon);
      });
    }
  }

  async spawnSeasonalRare(rareList) {
    const selected = rareList[Math.floor(Math.random() * rareList.length)];
    const hotspots = await this.getSeasonalHotspots();
    
    for (const spot of hotspots) {
      await this.createSpawnPoint({
        pokemonId: selected,
        location: spot.location,
        duration: 3600, // 1 小时
        isSeasonal: true,
        rarity: 'seasonal_rare'
      });
    }
  }

  // 季节热点位置
  async getSeasonalHotspots() {
    // 春季：公园、花园
    // 夏季：海滩、水上乐园
    // 秋季：森林、墓园
    // 冬季：滑雪场、溜冰场
    const hotspotTypes = {
      SPRING: ['park', 'garden', 'botanical_garden'],
      SUMMER: ['beach', 'water_park', 'swimming_pool'],
      AUTUMN: ['forest', 'cemetery', 'nature_reserve'],
      WINTER: ['ski_resort', 'ice_rink', 'mountain']
    };
    
    const types = hotspotTypes[this.engine.currentSeason];
    return await this.getLocationsByType(types);
  }

  // 季节变化通知
  async broadcastSeasonTransition(newSeason) {
    const messages = {
      SPRING: '🌸 春天来了！草系和虫系精灵出现率提升！',
      SUMMER: '☀️ 夏日炎炎！火系精灵活跃度大增！',
      AUTUMN: '🍂 秋风送爽！幽灵系精灵开始出没！',
      WINTER: '❄️ 寒冬降临！冰系精灵降临！'
    };
    
    await this.sendGlobalNotification({
      type: 'season_transition',
      title: `${SEASONS[newSeason].icon} 季节变化`,
      body: messages[newSeason],
      data: { season: newSeason }
    });
  }
}

module.exports = { SeasonalSpawnManager };
```

### 3. 季节任务与奖励系统

```javascript
// backend/services/reward-service/src/seasonalRewards.js

const { SeasonalEngine } = require('../../shared/seasonalEngine');

class SeasonalRewardManager {
  constructor() {
    this.engine = new SeasonalEngine();
  }

  // 季节专属商店
  getSeasonalShop() {
    const shops = {
      SPRING: {
        items: [
          { id: 'spring_bundle', name: '春日礼包', price: 1480, contents: ['lucky_egg', 'incense', 'sun_stone'] },
          { id: 'flower_crown', name: '花冠头饰', price: 200, type: 'avatar_item' },
          { id: 'spring_bg', name: '樱花背景', price: 100, type: 'background' }
        ],
        discount: { sunday: 20 } // 周日 20% 折扣
      },
      SUMMER: {
        items: [
          { id: 'summer_bundle', name: '夏日礼包', price: 1680, contents: ['super_incubator', 'heat_rock', 'star_piece'] },
          { id: 'sunglasses', name: '太阳镜', price: 150, type: 'avatar_item' },
          { id: 'beach_bg', name: '海滩背景', price: 100, type: 'background' }
        ],
        discount: { weekend: 15 }
      },
      AUTUMN: {
        items: [
          { id: 'autumn_bundle', name: '秋收礼包', price: 1280, contents: ['dusk_stone', 'pumpkin_berry', 'mystery_box'] },
          { id: 'witch_hat', name: '巫师帽', price: 250, type: 'avatar_item' },
          { id: 'forest_bg', name: '秋林背景', price: 100, type: 'background' }
        ],
        discount: { halloween: 30 }
      },
      WINTER: {
        items: [
          { id: 'winter_bundle', name: '冬日礼包', price: 1880, contents: ['glacial_lure', 'poffin', 'rare_candy_xl'] },
          { id: 'santa_hat', name: '圣诞帽', price: 200, type: 'avatar_item' },
          { id: 'snow_bg', name: '雪景背景', price: 100, type: 'background' }
        ],
        discount: { holiday: 40 }
      }
    };
    
    return shops[this.engine.currentSeason];
  }

  // 季节成就系统
  getSeasonalAchievements() {
    const achievements = {
      SPRING: [
        { id: 'spring_master', name: '春之大师', condition: '完成所有春季任务', reward: { badge: 'spring_badge', stardust: 5000 } },
        { id: 'grass_collector', name: '草系收藏家', condition: '捕捉 100 只草系精灵', reward: { medal: 'grass_gold', xp: 10000 } }
      ],
      SUMMER: [
        { id: 'summer_master', name: '夏日英雄', condition: '完成所有夏季任务', reward: { badge: 'summer_badge', stardust: 5000 } },
        { id: 'fire_catcher', name: '火焰捕捉者', condition: '捕捉 100 只火系精灵', reward: { medal: 'fire_gold', xp: 10000 } }
      ],
      AUTUMN: [
        { id: 'autumn_master', name: '秋日神秘家', condition: '完成所有秋季任务', reward: { badge: 'autumn_badge', stardust: 5000 } },
        { id: 'ghost_hunter', name: '幽灵猎人', condition: '捕捉 100 只幽灵系精灵', reward: { medal: 'ghost_gold', xp: 10000 } }
      ],
      WINTER: [
        { id: 'winter_master', name: '冰雪王者', condition: '完成所有冬季任务', reward: { badge: 'winter_badge', stardust: 5000 } },
        { id: 'ice_catcher', name: '冰霜收集者', condition: '捕捉 100 只冰系精灵', reward: { medal: 'ice_gold', xp: 10000 } }
      ]
    };
    
    return achievements[this.engine.currentSeason];
  }

  // 季节进度追踪
  async trackSeasonalProgress(userId, action) {
    const season = this.engine.currentSeason;
    const progress = await this.getSeasonalProgress(userId, season);
    
    progress.actions.push({
      action,
      timestamp: new Date()
    });
    
    await this.updateSeasonalProgress(userId, season, progress);
    
    // 检查季节成就
    await this.checkSeasonalAchievements(userId, progress);
    
    return progress;
  }

  // 季节总结报告
  async generateSeasonReport(userId, season) {
    const data = await this.getUserSeasonData(userId, season);
    
    return {
      season,
      period: this.getSeasonPeriod(season),
      stats: {
        totalCatches: data.catches,
        questsCompleted: data.questsCompleted,
        achievementsUnlocked: data.achievements.length,
        distanceWalked: data.distance,
        gymBattles: data.gymBattles
      },
      highlights: this.getSeasonHighlights(data),
      rewards: await this.calculateSeasonEndRewards(data)
    };
  }
}

module.exports = { SeasonalRewardManager };
```

### 4. 前端季节视觉效果

```javascript
// frontend/game-client/src/effects/SeasonalEffects.js

class SeasonalEffectsManager {
  constructor() {
    this.currentSeason = null;
    this.particles = [];
    this.transitions = {};
  }

  initialize(season) {
    this.currentSeason = season;
    this.setupSeasonalEffects(season);
  }

  setupSeasonalEffects(season) {
    const effects = {
      SPRING: {
        particles: 'sakura', // 樱花飘落
        ambientColor: '#FFB7C5',
        groundOverlay: 'grass_green',
        skyGradient: ['#87CEEB', '#FFB7C5'],
        soundAmbient: 'birds_chirping'
      },
      SUMMER: {
        particles: 'sunbeams', // 阳光光束
        ambientColor: '#FFD700',
        groundOverlay: 'sand_beach',
        skyGradient: ['#FF6B6B', '#FFD700'],
        soundAmbient: 'waves_beach'
      },
      AUTUMN: {
        particles: 'falling_leaves', // 落叶
        ambientColor: '#FF8C00',
        groundOverlay: 'autumn_leaves',
        skyGradient: ['#4A4A4A', '#FF8C00'],
        soundAmbient: 'wind_leaves'
      },
      WINTER: {
        particles: 'snowflakes', // 雪花
        ambientColor: '#87CEEB',
        groundOverlay: 'snow_cover',
        skyGradient: ['#E0E0E0', '#87CEEB'],
        soundAmbient: 'wind_cold'
      }
    };

    const config = effects[season];
    this.applyEffects(config);
  }

  applyEffects(config) {
    // 粒子效果
    this.createParticleSystem(config.particles);
    
    // 环境光照
    this.setAmbientLight(config.ambientColor);
    
    // 地面贴图
    this.setGroundOverlay(config.groundOverlay);
    
    // 天空渐变
    this.setSkyGradient(config.skyGradient);
    
    // 环境音效
    this.playAmbientSound(config.soundAmbient);
  }

  // 樱花粒子系统
  createSakuraParticles() {
    const particleCount = 200;
    
    for (let i = 0; i < particleCount; i++) {
      this.particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight - window.innerHeight,
        size: Math.random() * 10 + 5,
        speedX: Math.random() * 2 - 1,
        speedY: Math.random() * 2 + 1,
        rotation: Math.random() * 360,
        rotationSpeed: Math.random() * 5 - 2.5,
        opacity: Math.random() * 0.5 + 0.5
      });
    }
  }

  // 雪花粒子系统
  createSnowParticles() {
    const particleCount = 300;
    
    for (let i = 0; i < particleCount; i++) {
      this.particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight - window.innerHeight,
        size: Math.random() * 4 + 2,
        speedX: Math.random() * 1 - 0.5,
        speedY: Math.random() * 1.5 + 0.5,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: Math.random() * 0.02,
        opacity: Math.random() * 0.7 + 0.3
      });
    }
  }

  // 季节过渡动画
  transitionToSeason(newSeason, duration = 5000) {
    const oldConfig = this.getCurrentConfig();
    const newConfig = this.getSeasonConfig(newSeason);
    
    // 渐变过渡
    this.animateTransition(oldConfig, newConfig, duration);
    
    // 粒子混合
    this.blendParticles(oldConfig.particles, newConfig.particles, duration);
  }

  render(ctx) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    
    for (const particle of this.particles) {
      this.renderParticle(ctx, particle);
      this.updateParticle(particle);
    }
  }

  renderParticle(ctx, particle) {
    ctx.save();
    ctx.globalAlpha = particle.opacity;
    
    if (this.currentSeason === 'SPRING') {
      // 樱花瓣形状
      this.drawSakuraPetal(ctx, particle);
    } else if (this.currentSeason === 'WINTER') {
      // 雪花形状
      this.drawSnowflake(ctx, particle);
    } else if (this.currentSeason === 'AUTUMN') {
      // 落叶形状
      this.drawLeaf(ctx, particle);
    }
    
    ctx.restore();
  }

  drawSakuraPetal(ctx, particle) {
    ctx.translate(particle.x, particle.y);
    ctx.rotate(particle.rotation * Math.PI / 180);
    
    ctx.fillStyle = '#FFB7C5';
    ctx.beginPath();
    ctx.ellipse(0, 0, particle.size / 2, particle.size, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSnowflake(ctx, particle) {
    ctx.translate(particle.x, particle.y);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(0, 0, particle.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

export { SeasonalEffectsManager };
```

### 5. 数据库迁移

```sql
-- database/migrations/20260611_140000__add_seasonal_system.sql

-- 季节配置表
CREATE TABLE seasonal_configs (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(season, year)
);

-- 季节精灵池
CREATE TABLE seasonal_pokemon_pools (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  pokemon_id INT NOT NULL REFERENCES pokemon(id),
  rarity VARCHAR(20) NOT NULL, -- common, rare, legendary
  spawn_multiplier DECIMAL(5, 2) DEFAULT 1.0,
  is_shiny_boosted BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户季节进度
CREATE TABLE user_seasonal_progress (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  catches INT DEFAULT 0,
  quests_completed INT DEFAULT 0,
  achievements JSONB DEFAULT '[]',
  distance_walked DECIMAL(10, 2) DEFAULT 0,
  gym_battles INT DEFAULT 0,
  special_encounters INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, season, year)
);

-- 季节任务
CREATE TABLE seasonal_quests (
  id SERIAL PRIMARY KEY,
  quest_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  task_type VARCHAR(50) NOT NULL,
  target_value INT NOT NULL,
  rewards JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户季节任务进度
CREATE TABLE user_seasonal_quests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  quest_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  progress INT DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  claimed BOOLEAN DEFAULT false,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, quest_id, season, year)
);

-- 季节商店
CREATE TABLE seasonal_shop_items (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  item_id VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price INT NOT NULL,
  currency VARCHAR(20) DEFAULT 'coins',
  contents JSONB,
  item_type VARCHAR(50), -- avatar_item, background, bundle, consumable
  discount_rules JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户季节商店购买记录
CREATE TABLE user_seasonal_purchases (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  item_id VARCHAR(50) NOT NULL,
  quantity INT DEFAULT 1,
  price_paid INT NOT NULL,
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 季节成就
CREATE TABLE seasonal_achievements (
  id SERIAL PRIMARY KEY,
  achievement_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  condition_type VARCHAR(50) NOT NULL,
  condition_value JSONB NOT NULL,
  rewards JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(achievement_id, season)
);

-- 用户季节成就解锁
CREATE TABLE user_seasonal_achievements (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  achievement_id VARCHAR(50) NOT NULL,
  season VARCHAR(20) NOT NULL,
  year INT NOT NULL,
  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  claimed BOOLEAN DEFAULT false,
  UNIQUE(user_id, achievement_id, season, year)
);

-- 季节热点位置
CREATE TABLE seasonal_hotspots (
  id SERIAL PRIMARY KEY,
  season VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  location_type VARCHAR(50) NOT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  radius INT DEFAULT 100, -- 米
  spawn_boost DECIMAL(5, 2) DEFAULT 1.5,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 季节特殊遭遇
CREATE TABLE seasonal_encounters (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season VARCHAR(20) NOT NULL,
  pokemon_id INT NOT NULL REFERENCES pokemon(id),
  location_lat DECIMAL(10, 8),
  location_lng DECIMAL(11, 8),
  encountered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  caught BOOLEAN DEFAULT false,
  is_shiny BOOLEAN DEFAULT false
);

-- 创建索引
CREATE INDEX idx_seasonal_configs_season_year ON seasonal_configs(season, year);
CREATE INDEX idx_seasonal_pokemon_pools_season ON seasonal_pokemon_pools(season);
CREATE INDEX idx_user_seasonal_progress_user_season ON user_seasonal_progress(user_id, season, year);
CREATE INDEX idx_user_seasonal_quests_user_season ON user_seasonal_quests(user_id, season, year);
CREATE INDEX idx_seasonal_hotspots_season ON seasonal_hotspots(season);
CREATE INDEX idx_seasonal_encounters_user_season ON seasonal_encounters(user_id, season);

-- 插入初始季节任务数据
INSERT INTO seasonal_quests (quest_id, season, name, description, task_type, target_value, rewards) VALUES
('spring_catch_10', 'SPRING', '春日捕捉', '捕捉 10 只草系精灵', 'catch_type', 10, '{"stardust": 500, "item": "lucky_egg"}'),
('spring_evolve_5', 'SPRING', '生命绽放', '进化 5 只精灵', 'evolve', 5, '{"xp": 2000, "item": "sun_stone"}'),
('spring_walk_5km', 'SPRING', '春游踏青', '行走 5 公里', 'walk_distance', 5000, '{"candy": 10, "item": "incense"}'),
('summer_catch_15', 'SUMMER', '夏日炎炎', '捕捉 15 只火系精灵', 'catch_type', 15, '{"stardust": 600, "item": "heat_rock"}'),
('summer_gym_5', 'SUMMER', '沙滩对决', '参与 5 次道馆战斗', 'gym_battle', 5, '{"xp": 3000, "item": "rare_candy"}'),
('summer_hatch_3', 'SUMMER', '烈日孵化', '孵化 3 个蛋', 'hatch_eggs', 3, '{"stardust": 800, "item": "super_incubator"}'),
('autumn_catch_ghost', 'AUTUMN', '幽灵之夜', '捕捉 10 只幽灵系精灵', 'catch_type', 10, '{"stardust": 700, "item": "dusk_stone"}'),
('autumn_trade_3', 'AUTUMN', '秋收分享', '完成 3 次精灵交易', 'trade', 3, '{"xp": 2500, "item": "trade_ticket"}'),
('autumn_spin_20', 'AUTUMN', '落叶寻宝', '旋转 20 个 PokéStop', 'spin_pokestops', 20, '{"item": "pumpkin_berry", "qty": 10}'),
('winter_catch_ice', 'WINTER', '冰雪奇缘', '捕捉 10 只冰系精灵', 'catch_type', 10, '{"stardust": 800, "item": "glacial_lure"}'),
('winter_buddy_3', 'WINTER', '冬日陪伴', '与伙伴精灵互动 3 次', 'buddy_interact', 3, '{"hearts": 3, "item": "poffin"}'),
('winter_gift_5', 'WINTER', '冬日礼物', '发送 5 份礼物给好友', 'send_gifts', 5, '{"xp": 1500, "item": "holiday_box"}');

-- 插入季节成就数据
INSERT INTO seasonal_achievements (achievement_id, season, name, description, condition_type, condition_value, rewards) VALUES
('spring_master', 'SPRING', '春之大师', '完成所有春季任务', 'complete_all_quests', '{}', '{"badge": "spring_badge", "stardust": 5000}'),
('grass_collector', 'SPRING', '草系收藏家', '捕捉 100 只草系精灵', 'catch_type_count', '{"type": "grass", "count": 100}', '{"medal": "grass_gold", "xp": 10000}'),
('summer_master', 'SUMMER', '夏日英雄', '完成所有夏季任务', 'complete_all_quests', '{}', '{"badge": "summer_badge", "stardust": 5000}'),
('fire_catcher', 'SUMMER', '火焰捕捉者', '捕捉 100 只火系精灵', 'catch_type_count', '{"type": "fire", "count": 100}', '{"medal": "fire_gold", "xp": 10000}'),
('autumn_master', 'AUTUMN', '秋日神秘家', '完成所有秋季任务', 'complete_all_quests', '{}', '{"badge": "autumn_badge", "stardust": 5000}'),
('ghost_hunter', 'AUTUMN', '幽灵猎人', '捕捉 100 只幽灵系精灵', 'catch_type_count', '{"type": "ghost", "count": 100}', '{"medal": "ghost_gold", "xp": 10000}'),
('winter_master', 'WINTER', '冰雪王者', '完成所有冬季任务', 'complete_all_quests', '{}', '{"badge": "winter_badge", "stardust": 5000}'),
('ice_catcher', 'WINTER', '冰霜收集者', '捕捉 100 只冰系精灵', 'catch_type_count', '{"type": "ice", "count": 100}', '{"medal": "ice_gold", "xp": 10000}');
```

### 6. API 端点设计

```javascript
// backend/services/reward-service/src/routes/seasonal.js

const express = require('express');
const router = express.Router();
const { SeasonalRewardManager } = require('../seasonalRewards');
const { SeasonalEngine } = require('../../../shared/seasonalEngine');

const seasonalManager = new SeasonalRewardManager();
const seasonalEngine = new SeasonalEngine();

// 获取当前季节信息
router.get('/current', async (req, res) => {
  const season = seasonalEngine.currentSeason;
  const config = await seasonalEngine.loadSeasonConfig(season);
  const transition = seasonalEngine.calculateTransitionProgress();
  
  res.json({
    season,
    config,
    transitionProgress: transition,
    seasonalPokemon: seasonalEngine.getSeasonalPokemon(),
    typeBonuses: {
      grass: seasonalEngine.getSeasonalBonus('grass'),
      fire: seasonalEngine.getSeasonalBonus('fire'),
      water: seasonalEngine.getSeasonalBonus('water'),
      ice: seasonalEngine.getSeasonalBonus('ice')
    }
  });
});

// 获取季节任务
router.get('/quests', async (req, res) => {
  const userId = req.user.id;
  const quests = seasonalEngine.getSeasonalQuests(userId);
  const progress = await seasonalManager.getUserQuestProgress(userId);
  
  res.json({
    quests,
    progress
  });
});

// 领取季节任务奖励
router.post('/quests/:questId/claim', async (req, res) => {
  const { questId } = req.params;
  const userId = req.user.id;
  
  const result = await seasonalManager.claimQuestReward(userId, questId);
  
  res.json(result);
});

// 获取季节商店
router.get('/shop', async (req, res) => {
  const shop = seasonalManager.getSeasonalShop();
  
  res.json(shop);
});

// 购买季节商品
router.post('/shop/:itemId/purchase', async (req, res) => {
  const { itemId } = req.params;
  const userId = req.user.id;
  
  const result = await seasonalManager.purchaseItem(userId, itemId);
  
  res.json(result);
});

// 获取季节成就
router.get('/achievements', async (req, res) => {
  const userId = req.user.id;
  const achievements = seasonalManager.getSeasonalAchievements();
  const userAchievements = await seasonalManager.getUserAchievements(userId);
  
  res.json({
    achievements,
    unlocked: userAchievements
  });
});

// 获取季节进度
router.get('/progress', async (req, res) => {
  const userId = req.user.id;
  const progress = await seasonalManager.getSeasonalProgress(userId);
  
  res.json(progress);
});

// 获取季节总结报告
router.get('/report/:season/:year', async (req, res) => {
  const { season, year } = req.params;
  const userId = req.user.id;
  
  const report = await seasonalManager.generateSeasonReport(userId, season, parseInt(year));
  
  res.json(report);
});

module.exports = router;
```

## 验收标准

- [ ] 季节自动检测正确，支持四个季节切换
- [ ] 季节精灵池配置生效，刷新率按预期调整
- [ ] 类型加成系统工作正常，加成倍数正确
- [ ] 季节任务系统完整，支持进度追踪和奖励领取
- [ ] 季节商店可用，商品购买流程正确
- [ ] 季节成就系统可用，解锁条件正确
- [ ] 前端季节视觉效果渲染正确（樱花/雪花/落叶）
- [ ] 季节过渡动画流畅
- [ ] 季节总结报告生成正确
- [ ] 单元测试覆盖率 > 80%
- [ ] Prometheus 指标暴露（季节玩家数、任务完成率、商店销售额）

## 影响范围

- `backend/shared/seasonalEngine.js` - 季节引擎核心模块（新增）
- `backend/services/location-service/src/seasonalSpawn.js` - 季节刷新管理（新增）
- `backend/services/reward-service/src/seasonalRewards.js` - 季节奖励系统（新增）
- `backend/services/reward-service/src/routes/seasonal.js` - 季节 API 路由（新增）
- `frontend/game-client/src/effects/SeasonalEffects.js` - 季节视觉效果（新增）
- `database/migrations/20260611_140000__add_seasonal_system.sql` - 数据库迁移（新增）
- `backend/tests/unit/seasonal.test.js` - 单元测试（新增）

## 参考

- Pokémon GO Seasonal Events: https://pokemongolive.com/seasons
- Game Seasonal Systems Best Practices
- Particles.js for Web Effects: https://vincentgarreau.com/particles.js/
- Time-based Content Rotation Patterns
