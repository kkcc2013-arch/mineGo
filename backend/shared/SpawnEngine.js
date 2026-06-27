/**
 * 精灵刷新引擎
 * 基于热力图的动态刷新密度控制
 *
 * @module SpawnEngine
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

class SpawnEngine extends EventEmitter {
  constructor(config) {
    super();
    this.redis = config.redis;
    this.db = config.db;
    this.config = config;
    this.metrics = config.metrics || null;

    // 刷新区域网格 (Geohash 精度 6，约 1.2km x 0.6km)
    this.gridSize = config.gridSize || 6;

    // 热力图更新间隔
    this.heatmapUpdateInterval = config.heatmapUpdateInterval || 60000; // 1分钟

    // 刷新检查间隔
    this.spawnCheckInterval = config.spawnCheckInterval || 30000; // 30秒

    // 时间因子配置
    this.timeMultipliers = {
      // 凌晨低谷
      0: 0.5, 1: 0.4, 2: 0.3, 3: 0.3, 4: 0.4, 5: 0.5,
      // 早晨
      6: 0.7, 7: 0.8, 8: 0.9,
      // 工作时间
      9: 1.0, 10: 1.0, 11: 1.1, 12: 1.2, 13: 1.1, 14: 1.0,
      // 下午
      15: 1.0, 16: 1.1, 17: 1.2,
      // 傍晚高峰
      18: 1.5, 19: 1.6, 20: 1.5, 21: 1.4,
      // 夜间
      22: 1.2, 23: 0.8
    };

    this.spawnLoopInterval = null;
    this.heatmapLoopInterval = null;

    this.logger = config.logger || console;
  }

  /**
   * 启动刷新循环
   */
  startSpawnLoop() {
    if (this.spawnLoopInterval) {
      clearInterval(this.spawnLoopInterval);
    }

    this.spawnLoopInterval = setInterval(async () => {
      try {
        await this.processSpawnCycle();
      } catch (error) {
        this.logger.error('Spawn cycle error:', error);
      }
    }, this.spawnCheckInterval);

    this.logger.info('Spawn engine started');
  }

  /**
   * 启动热力图更新循环
   */
  startHeatmapUpdate() {
    if (this.heatmapLoopInterval) {
      clearInterval(this.heatmapLoopInterval);
    }

    this.heatmapLoopInterval = setInterval(async () => {
      try {
        await this.cleanupExpiredSpawns();
      } catch (error) {
        this.logger.error('Heatmap cleanup error:', error);
      }
    }, this.heatmapUpdateInterval);

    this.logger.info('Heatmap cleanup started');
  }

  /**
   * 停止所有循环
   */
  stop() {
    if (this.spawnLoopInterval) {
      clearInterval(this.spawnLoopInterval);
      this.spawnLoopInterval = null;
    }
    if (this.heatmapLoopInterval) {
      clearInterval(this.heatmapLoopInterval);
      this.heatmapLoopInterval = null;
    }
    this.logger.info('Spawn engine stopped');
  }

  /**
   * 处理刷新周期
   */
  async processSpawnCycle() {
    // 获取所有活跃区域
    const activeCells = await this.getActiveCells();

    for (const geohash of activeCells) {
      try {
        const spawnCount = await this.calculateSpawnForCell(geohash);
        await this.spawnPokemon(geohash, spawnCount);
      } catch (error) {
        this.logger.error(`Spawn error for cell ${geohash}:`, error);
      }
    }
  }

  /**
   * 获取活跃区域列表
   */
  async getActiveCells() {
    const pattern = 'heatmap:stats:*';
    const keys = await this.redis.keys(pattern);

    return keys.map(key => {
      const parts = key.split(':');
      return parts[parts.length - 1];
    });
  }

  /**
   * 动态刷新算法
   * 根据区域热度、时间、精灵池计算刷新数量
   */
  async calculateSpawnForCell(geohash) {
    // 获取区域热度（活跃玩家数）
    const heatmap = await this.getHeatmap(geohash);
    const activePlayers = heatmap.activePlayers || 0;

    // 获取区域配置
    const cellConfig = await this.getCellConfig(geohash);

    // 基础刷新数量
    const baseSpawn = cellConfig.baseSpawnCount || 3;

    // 动态调整系数
    const timeFactor = this.getTimeFactor();
    const playerFactor = this.getPlayerFactor(activePlayers);
    const eventFactor = await this.getEventFactor(geohash);

    // 最终刷新数量
    const spawnCount = Math.floor(
      baseSpawn * timeFactor * playerFactor * eventFactor
    );

    // 限制范围
    return Math.max(
      cellConfig.minSpawn || 1,
      Math.min(cellConfig.maxSpawn || 10, spawnCount)
    );
  }

  /**
   * 时间因子
   * 高峰时段增加刷新，低谷时段减少
   */
  getTimeFactor() {
    const hour = new Date().getHours();
    return this.timeMultipliers[hour] || 1.0;
  }

  /**
   * 玩家活跃度因子
   * 玩家越多刷新越多，但有上限避免资源浪费
   */
  getPlayerFactor(activePlayers) {
    if (activePlayers === 0) return 0.3; // 无玩家时保持最低刷新
    if (activePlayers <= 5) return 1.0;
    if (activePlayers <= 15) return 1.2;
    if (activePlayers <= 30) return 1.4;
    if (activePlayers <= 50) return 1.5;
    return 1.6; // 上限
  }

  /**
   * 事件/活动因子
   */
  async getEventFactor(geohash) {
    const activeEvents = await this.redis.get(`events:cell:${geohash}`);
    if (!activeEvents) return 1.0;

    try {
      const events = JSON.parse(activeEvents);
      let factor = 1.0;

      for (const event of events) {
        if (event.type === 'community_day') factor *= 2.0;
        else if (event.type === 'spotlight_hour') factor *= 1.5;
        else if (event.type === 'raid_hour') factor *= 1.3;
        else if (event.spawnMultiplier) factor *= event.spawnMultiplier;
      }

      return Math.min(factor, 3.0); // 上限 3 倍
    } catch (error) {
      this.logger.error('Error parsing events:', error);
      return 1.0;
    }
  }

  /**
   * 获取区域热度
   */
  async getHeatmap(geohash) {
    const stats = await this.redis.hgetall(`heatmap:stats:${geohash}`);
    return {
      activePlayers: parseInt(stats.activePlayers || 0),
      lastUpdate: parseInt(stats.lastUpdate || 0)
    };
  }

  /**
   * 获取区域配置
   */
  async getCellConfig(geohash) {
    // 先查缓存
    const cached = await this.redis.get(`spawn:config:${geohash}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (error) {
        this.logger.error('Error parsing cell config:', error);
      }
    }

    // 查数据库
    const result = await this.db.query(
      'SELECT * FROM spawn_cell_configs WHERE geohash = $1 AND enabled = true',
      [geohash]
    );

    if (result.rows.length > 0) {
      const config = result.rows[0];
      // 缓存 10 分钟
      await this.redis.setex(
        `spawn:config:${geohash}`,
        600,
        JSON.stringify(config)
      );
      return config;
    }

    // 返回默认配置
    return {
      baseSpawnCount: 3,
      minSpawn: 1,
      maxSpawn: 10
    };
  }

  /**
   * 执行精灵刷新
   */
  async spawnPokemon(geohash, count) {
    // 获取当前已存在的精灵
    const existing = await this.getExistingSpawns(geohash);

    // 计算需要刷新的数量
    const toSpawn = Math.max(0, count - existing.length);

    if (toSpawn <= 0) return [];

    // 选择精灵池
    const spawnPool = await this.getSpawnPool(geohash);

    if (!spawnPool || spawnPool.length === 0) {
      this.logger.warn(`No spawn pool for cell ${geohash}`);
      return [];
    }

    // 加权随机选择
    const spawned = [];
    for (let i = 0; i < toSpawn; i++) {
      const pokemon = this.weightedRandomSelect(spawnPool);
      const spawn = await this.createSpawn(pokemon, geohash);
      if (spawn) {
        spawned.push(spawn);
      }
    }

    // 广播刷新事件
    if (spawned.length > 0) {
      this.emit('spawn', { geohash, spawned });

      // 更新指标
      if (this.metrics) {
        for (const spawn of spawned) {
          this.metrics.spawnCounter.inc({
            rarity: spawn.rarity,
            biome: spawn.biome || 'unknown',
            geohash_prefix: geohash.substring(0, 4)
          });
        }
      }
    }

    return spawned;
  }

  /**
   * 获取精灵池
   */
  async getSpawnPool(geohash) {
    // 确定生物群系（基于地理位置特征）
    const biome = await this.determineBiome(geohash);

    // 检查缓存
    const cached = await this.redis.get(`spawn:pool:${biome}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (error) {
        this.logger.error('Error parsing spawn pool:', error);
      }
    }

    // 从数据库加载
    const result = await this.db.query(
      `SELECT
        sp.pokemon_id,
        sp.weight,
        sp.min_level,
        sp.max_level,
        p.name as pokemon_name,
        p.rarity
       FROM spawn_pools sp
       JOIN pokemon p ON sp.pokemon_id = p.id
       WHERE sp.biome = $1 AND sp.enabled = true
       ORDER BY sp.weight DESC`,
      [biome]
    );

    if (result.rows.length === 0) {
      // 使用默认精灵池
      return this.getDefaultSpawnPool();
    }

    const pool = result.rows.map(row => ({
      id: row.pokemon_id,
      name: row.pokemon_name,
      rarity: row.rarity,
      weight: parseFloat(row.weight),
      minLevel: row.min_level,
      maxLevel: row.max_level,
      biome: biome
    }));

    // 缓存 30 分钟
    await this.redis.setex(
      `spawn:pool:${biome}`,
      1800,
      JSON.stringify(pool)
    );

    return pool;
  }

  /**
   * 确定生物群系
   * 简化版本：基于 geohash 前缀随机选择
   */
  async determineBiome(geohash) {
    const biomes = ['grass', 'water', 'urban', 'forest', 'mountain', 'cave'];
    // 使用 geohash 前缀作为种子
    const seed = geohash.charCodeAt(0) % biomes.length;
    return biomes[seed];
  }

  /**
   * 获取默认精灵池
   */
  getDefaultSpawnPool() {
    return [
      { id: 1, name: 'Bulbasaur', rarity: 'common', weight: 10.0, biome: 'grass' },
      { id: 16, name: 'Pidgey', rarity: 'common', weight: 15.0, biome: 'grass' },
      { id: 19, name: 'Rattata', rarity: 'common', weight: 12.0, biome: 'grass' },
      { id: 25, name: 'Pikachu', rarity: 'rare', weight: 3.0, biome: 'grass' },
      { id: 133, name: 'Eevee', rarity: 'rare', weight: 2.0, biome: 'urban' }
    ];
  }

  /**
   * 加权随机选择
   */
  weightedRandomSelect(pool) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;

    for (const pokemon of pool) {
      random -= pokemon.weight;
      if (random <= 0) return pokemon;
    }

    return pool[pool.length - 1];
  }

  /**
   * 创建精灵刷新实例
   */
  async createSpawn(pokemonTemplate, geohash) {
    try {
      const spawnId = uuidv4();
      const centerCoord = this.geohashToCoord(geohash);

      // 随机偏移位置（100-300米范围内）
      const offset = this.randomOffset(100, 300);
      const location = {
        lat: centerCoord.lat + offset.lat,
        lng: centerCoord.lng + offset.lng
      };

      // 计算消失时间（15-60分钟）
      const despawnMinutes = 15 + Math.random() * 45;
      const despawnAt = new Date(Date.now() + despawnMinutes * 60000);

      // 计算等级
      const level = Math.floor(
        (pokemonTemplate.minLevel || 1) +
        Math.random() * ((pokemonTemplate.maxLevel || 30) - (pokemonTemplate.minLevel || 1))
      );

      const spawn = {
        id: spawnId,
        pokemonId: pokemonTemplate.id,
        pokemonName: pokemonTemplate.name,
        rarity: pokemonTemplate.rarity,
        location,
        geohash,
        spawnedAt: new Date(),
        despawnAt,
        level,
        biome: pokemonTemplate.biome,
        cp: this.calculateCP(pokemonTemplate, level),
        iv: this.generateIV(),
        moves: this.assignMoves(pokemonTemplate)
      };

      // 存储到 Redis（带 TTL）
      await this.redis.hset(
        `spawns:active:${spawnId}`,
        'data', JSON.stringify(spawn)
      );
      await this.redis.expireat(
        `spawns:active:${spawnId}`,
        Math.floor(despawnAt.getTime() / 1000)
      );

      // 添加到地理位置索引
      await this.redis.geoadd(
        'spawns:geo',
        location.lng,
        location.lat,
        spawnId
      );

      // 添加到区域索引
      await this.redis.sadd(`spawns:cell:${geohash}`, spawnId);

      return spawn;
    } catch (error) {
      this.logger.error('Error creating spawn:', error);
      return null;
    }
  }

  /**
   * Geohash 转坐标（简化版本）
   */
  geohashToCoord(geohash) {
    // 简化实现：返回大致坐标
    // 实际应使用专业库如 latlon-geohash
    const baseLat = 35.0;
    const baseLng = 139.0;

    // 根据 geohash 长度和字符计算偏移
    const offset = geohash.split('').reduce((acc, char, idx) => {
      const code = char.charCodeAt(0);
      return acc + code * Math.pow(0.1, idx + 1);
    }, 0);

    return {
      lat: baseLat + offset,
      lng: baseLng + offset * 1.2
    };
  }

  /**
   * 随机偏移
   */
  randomOffset(minMeters, maxMeters) {
    const distance = minMeters + Math.random() * (maxMeters - minMeters);
    const angle = Math.random() * 2 * Math.PI;

    // 大约每度 111km
    const degreesPerMeter = 1 / 111000;

    return {
      lat: Math.cos(angle) * distance * degreesPerMeter,
      lng: Math.sin(angle) * distance * degreesPerMeter
    };
  }

  /**
   * 计算 CP
   */
  calculateCP(pokemon, level) {
    // 简化 CP 计算
    const baseCP = pokemon.rarity === 'legendary' ? 2000 :
                   pokemon.rarity === 'rare' ? 1000 : 500;
    return Math.floor(baseCP * (level / 30) * (0.8 + Math.random() * 0.4));
  }

  /**
   * 生成 IV
   */
  generateIV() {
    return {
      attack: Math.floor(Math.random() * 16),
      defense: Math.floor(Math.random() * 16),
      stamina: Math.floor(Math.random() * 16)
    };
  }

  /**
   * 分配技能
   */
  assignMoves(pokemon) {
    // 简化实现
    return {
      fast: 'tackle',
      charged: 'hyper_beam'
    };
  }

  /**
   * 获取已存在的精灵
   */
  async getExistingSpawns(geohash) {
    const spawnIds = await this.redis.smembers(`spawns:cell:${geohash}`);
    const spawns = [];

    for (const spawnId of spawnIds) {
      const data = await this.redis.hget(`spawns:active:${spawnId}`, 'data');
      if (data) {
        try {
          spawns.push(JSON.parse(data));
        } catch (error) {
          this.logger.error('Error parsing spawn data:', error);
        }
      }
    }

    return spawns;
  }

  /**
   * 清理过期刷新
   */
  async cleanupExpiredSpawns() {
    const now = Date.now();
    const pattern = 'spawns:active:*';

    const keys = await this.redis.keys(pattern);
    let cleaned = 0;

    for (const key of keys) {
      const ttl = await this.redis.ttl(key);
      if (ttl <= 0) {
        const data = await this.redis.hget(key, 'data');
        if (data) {
          try {
            const spawn = JSON.parse(data);
            await this.removeSpawn(spawn.id, spawn.geohash);
            cleaned++;

            // 更新指标
            if (this.metrics) {
              this.metrics.despawnCounter.inc({ reason: 'timeout' });
            }
          } catch (error) {
            this.logger.error('Error parsing spawn for cleanup:', error);
          }
        }
      }
    }

    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} expired spawns`);
    }

    return cleaned;
  }

  /**
   * 移除精灵刷新
   */
  async removeSpawn(spawnId, geohash) {
    // 从地理位置索引移除
    await this.redis.zrem('spawns:geo', spawnId);

    // 从区域索引移除
    if (geohash) {
      await this.redis.srem(`spawns:cell:${geohash}`, spawnId);
    }

    // 删除数据
    await this.redis.del(`spawns:active:${spawnId}`);

    this.emit('despawn', { spawnId, geohash });
  }

  /**
   * 手动刷新精灵（运营工具）
   */
  async manualSpawn(geohash, pokemonId, count = 1) {
    const pool = await this.getSpawnPool(geohash);
    const pokemon = pool.find(p => p.id === pokemonId);

    if (!pokemon) {
      throw new Error(`Pokemon ${pokemonId} not in spawn pool`);
    }

    const spawned = [];
    for (let i = 0; i < count; i++) {
      const spawn = await this.createSpawn(pokemon, geohash);
      if (spawn) {
        spawned.push(spawn);
      }
    }

    // 记录操作日志
    await this.logAdminAction({
      action: 'manual_spawn',
      targetType: 'cell',
      targetId: geohash,
      changes: { pokemonId, count }
    });

    return spawned;
  }

  /**
   * 记录管理员操作
   */
  async logAdminAction(log) {
    try {
      await this.db.query(
        `INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
         VALUES ($1, $2, $3, $4, $5)`,
        [log.adminId || 0, log.action, log.targetType, log.targetId, log.changes]
      );
    } catch (error) {
      this.logger.error('Error logging admin action:', error);
    }
  }
}

module.exports = SpawnEngine;
