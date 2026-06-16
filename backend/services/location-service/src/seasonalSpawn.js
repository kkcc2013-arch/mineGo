/**
 * 季节刷新管理模块
 * 负责季节性精灵刷新和热点位置管理
 */

const { SeasonalEngine, SEASONS } = require('../../shared/seasonalEngine');

class SeasonalSpawnManager {
  constructor(db, redis, eventBus) {
    this.db = db;
    this.redis = redis;
    this.eventBus = eventBus;
    this.engine = new SeasonalEngine();
    this.lastSeasonCheck = null;
  }

  /**
   * 初始化季节刷新系统
   */
  async initialize() {
    await this.engine.loadSeasonConfig(this.engine.currentSeason);
    this.scheduleSeasonalRefresh();
    this.scheduleSeasonalRareSpawn();
    console.log(`[SeasonalSpawnManager] Initialized for season: ${this.engine.currentSeason}`);
  }

  /**
   * 应用季节加成到刷新权重
   */
  applySeasonalBonuses(spawnWeights, pokemonTypes) {
    const modifiedWeights = { ...spawnWeights };

    for (const [pokemonId, weight] of Object.entries(modifiedWeights)) {
      const type = pokemonTypes[pokemonId];
      modifiedWeights[pokemonId] = this.engine.calculateSpawnWeight(pokemonId, type, weight);
    }

    return modifiedWeights;
  }

  /**
   * 获取季节热点位置
   */
  async getSeasonalHotspots(latitude, longitude, radius = 5000) {
    const hotspotTypes = this.engine.getHotspotTypes();

    try {
      const result = await this.db.query(`
        SELECT id, name, latitude, longitude, type,
               ST_Distance(
                 ST_MakePoint($1, $2)::geography,
                 ST_MakePoint(latitude, longitude)::geography
               ) as distance
        FROM locations
        WHERE type = ANY($3)
          AND ST_DWithin(
            ST_MakePoint($1, $2)::geography,
            ST_MakePoint(latitude, longitude)::geography,
            $4
          )
        ORDER BY distance
        LIMIT 20
      `, [longitude, latitude, hotspotTypes, radius]);

      return result.rows;
    } catch (error) {
      console.error('[SeasonalSpawnManager] Error getting hotspots:', error);
      return [];
    }
  }

  /**
   * 在热点位置刷新季节稀有精灵
   */
  async spawnSeasonalRare(hotspots) {
    const seasonalPool = this.engine.getSeasonalPokemon();
    const rarePokemon = seasonalPool.rare;

    if (!rarePokemon || rarePokemon.length === 0) {
      return [];
    }

    const spawns = [];
    const selectedPokemon = rarePokemon[Math.floor(Math.random() * rarePokemon.length)];

    for (const hotspot of hotspots) {
      try {
        const spawn = await this.createSpawnPoint({
          pokemonId: selectedPokemon,
          location: {
            latitude: hotspot.latitude,
            longitude: hotspot.longitude
          },
          duration: 3600, // 1 小时
          isSeasonal: true,
          rarity: 'seasonal_rare'
        });
        spawns.push(spawn);
      } catch (error) {
        console.error('[SeasonalSpawnManager] Error creating spawn:', error);
      }
    }

    return spawns;
  }

  /**
   * 创建刷新点
   */
  async createSpawnPoint(options) {
    const { pokemonId, location, duration, isSeasonal, rarity } = options;
    const expiresAt = new Date(Date.now() + duration * 1000);

    const result = await this.db.query(`
      INSERT INTO spawn_points (
        pokemon_id, latitude, longitude, expires_at,
        is_seasonal, rarity, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `, [pokemonId, location.latitude, location.longitude, expiresAt, isSeasonal, rarity]);

    // 发布刷新事件
    if (this.eventBus) {
      await this.eventBus.publish('spawn.created', {
        spawnId: result.rows[0].id,
        pokemonId,
        location,
        isSeasonal,
        rarity,
        season: this.engine.currentSeason
      });
    }

    return result.rows[0];
  }

  /**
   * 调度季节刷新检查
   */
  scheduleSeasonalRefresh() {
    // 每小时检查季节变化
    setInterval(async () => {
      const newSeason = this.engine.detectSeason();
      if (newSeason !== this.engine.currentSeason) {
        await this.handleSeasonChange(newSeason);
      }
    }, 3600000); // 1 hour
  }

  /**
   * 调度季节稀有精灵刷新
   */
  scheduleSeasonalRareSpawn() {
    // 每天 12:00 和 18:00 刷新稀有精灵
    const scheduleDailySpawn = async () => {
      const now = new Date();
      const hours = now.getHours();

      if (hours === 12 || hours === 18) {
        await this.triggerSeasonalRareSpawn();
      }
    };

    // 每小时检查是否需要刷新
    setInterval(scheduleDailySpawn, 3600000);
  }

  /**
   * 触发季节稀有精灵刷新
   */
  async triggerSeasonalRareSpawn() {
    try {
      // 获取热门区域的热点位置
      const popularAreas = await this.getPopularAreas();
      const hotspots = [];

      for (const area of popularAreas) {
        const areaHotspots = await this.getSeasonalHotspots(
          area.latitude,
          area.longitude,
          10000
        );
        hotspots.push(...areaHotspots.slice(0, 5));
      }

      const spawns = await this.spawnSeasonalRare(hotspots);

      console.log(`[SeasonalSpawnManager] Spawned ${spawns.length} seasonal rare Pokemon`);

      return spawns;
    } catch (error) {
      console.error('[SeasonalSpawnManager] Error in rare spawn trigger:', error);
      return [];
    }
  }

  /**
   * 获取热门区域
   */
  async getPopularAreas() {
    try {
      const result = await this.db.query(`
        SELECT latitude, longitude, COUNT(*) as visit_count
        FROM user_visits
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY latitude, longitude
        ORDER BY visit_count DESC
        LIMIT 10
      `);
      return result.rows;
    } catch (error) {
      console.error('[SeasonalSpawnManager] Error getting popular areas:', error);
      return [];
    }
  }

  /**
   * 处理季节变化
   */
  async handleSeasonChange(newSeason) {
    const oldSeason = this.engine.currentSeason;
    this.engine.currentSeason = newSeason;
    await this.engine.loadSeasonConfig(newSeason);

    // 发布季节变化事件
    if (this.eventBus) {
      await this.eventBus.publish('season.changed', {
        oldSeason,
        newSeason,
        message: this.engine.getTransitionMessage(newSeason),
        timestamp: new Date()
      });
    }

    console.log(`[SeasonalSpawnManager] Season changed: ${oldSeason} -> ${newSeason}`);
  }

  /**
   * 获取季节刷新统计
   */
  async getSeasonalStats(season, year) {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_spawns,
          COUNT(*) FILTER (WHERE is_seasonal) as seasonal_spawns,
          COUNT(*) FILTER (WHERE rarity = 'seasonal_rare') as rare_spawns,
          COUNT(DISTINCT pokemon_id) as unique_pokemon
        FROM spawn_points
        WHERE created_at >= $1 AND created_at < $2
      `, [this.getSeasonStart(season, year), this.getSeasonEnd(season, year)]);

      return result.rows[0];
    } catch (error) {
      console.error('[SeasonalSpawnManager] Error getting stats:', error);
      return null;
    }
  }

  /**
   * 获取季节开始时间
   */
  getSeasonStart(season, year) {
    const seasonMonths = SEASONS[season]?.months || [3, 4, 5];
    return new Date(year, seasonMonths[0] - 1, 1);
  }

  /**
   * 获取季节结束时间
   */
  getSeasonEnd(season, year) {
    const seasonMonths = SEASONS[season]?.months || [3, 4, 5];
    const endMonth = seasonMonths[2];
    return new Date(year, endMonth, 0); // 最后一天
  }
}

module.exports = { SeasonalSpawnManager };
