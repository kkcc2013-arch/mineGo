# REQ-00069: 精灵资源管理系统与动态刷新控制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00069 |
| 标题 | 精灵资源管理系统与动态刷新控制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | location-service、catch-service、backend/shared、game-client、database/migrations |
| 创建时间 | 2026-06-09 23:30 |

## 需求描述

### 背景
当前精灵在地图上的刷新机制较为简单，缺乏精细化控制能力：

1. **刷新密度不均**：热门区域精灵过多导致服务器压力，偏远地区精灵稀少玩家体验差
2. **资源浪费**：精灵刷新后无人捕捉，长期占用内存和计算资源
3. **缺乏动态调整**：无法根据实时玩家数量、时段、活动调整刷新策略
4. **预测性问题**：玩家容易掌握刷新规律，降低游戏探索乐趣
5. **运营工具缺失**：运营人员无法灵活配置特殊活动、区域精灵分布

### 目标
构建完整的精灵资源管理系统，实现：
- 基于热力图的动态刷新密度控制
- 多维度刷新策略（时间、区域、精灵稀有度）
- 实时资源监控与自动扩缩容
- 运营后台配置界面
- 防预测的随机化刷新算法

## 技术方案

### 1. 精灵刷新引擎核心设计

```javascript
// backend/shared/SpawnEngine.js
const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

class SpawnEngine extends EventEmitter {
  constructor(config) {
    super();
    this.redis = config.redis;
    this.db = config.db;
    this.config = config;
    
    // 刷新区域网格 (Geohash 精度 6，约 1.2km x 0.6km)
    this.gridSize = 6;
    
    // 热力图更新间隔
    this.heatmapUpdateInterval = 60000; // 1分钟
    
    // 刷新检查间隔
    this.spawnCheckInterval = 30000; // 30秒
    
    this.startSpawnLoop();
    this.startHeatmapUpdate();
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
    return Math.max(cellConfig.minSpawn || 1, 
                    Math.min(cellConfig.maxSpawn || 10, spawnCount));
  }
  
  /**
   * 时间因子
   * 高峰时段增加刷新，低谷时段减少
   */
  getTimeFactor() {
    const hour = new Date().getHours();
    const timeMultipliers = {
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
    return timeMultipliers[hour] || 1.0;
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
    
    const events = JSON.parse(activeEvents);
    let factor = 1.0;
    
    for (const event of events) {
      if (event.type === 'community_day') factor *= 2.0;
      else if (event.type === 'spotlight_hour') factor *= 1.5;
      else if (event.type === 'raid_hour') factor *= 1.3;
    }
    
    return Math.min(factor, 3.0); // 上限 3 倍
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
    
    // 加权随机选择
    const spawned = [];
    for (let i = 0; i < toSpawn; i++) {
      const pokemon = this.weightedRandomSelect(spawnPool);
      const spawn = await this.createSpawn(pokemon, geohash);
      spawned.push(spawn);
    }
    
    // 广播刷新事件
    this.emit('spawn', { geohash, spawned });
    
    return spawned;
  }
  
  /**
   * 创建精灵刷新实例
   */
  async createSpawn(pokemonTemplate, geohash) {
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
    
    const spawn = {
      id: spawnId,
      pokemonId: pokemonTemplate.id,
      pokemonName: pokemonTemplate.name,
      rarity: pokemonTemplate.rarity,
      location,
      geohash,
      spawnedAt: new Date(),
      despawnAt,
      // 隐藏的稀有度影响捕捉难度
      hiddenRarity: pokemonTemplate.rarity,
      cp: this.calculateCP(pokemonTemplate),
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
    
    // 更新指标
    this.metrics?.spawnCounter.inc({ 
      rarity: pokemonTemplate.rarity 
    });
    
    return spawn;
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
          const spawn = JSON.parse(data);
          await this.removeSpawn(spawn.id, spawn.geohash);
          cleaned++;
        }
      }
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
    await this.redis.srem(`spawns:cell:${geohash}`, spawnId);
    
    // 删除数据
    await this.redis.del(`spawns:active:${spawnId}`);
    
    this.emit('despawn', { spawnId, geohash });
  }
}

module.exports = SpawnEngine;
```

### 2. 热力图收集器

```javascript
// backend/shared/HeatmapCollector.js
class HeatmapCollector {
  constructor(config) {
    this.redis = config.redis;
    this.db = config.db;
  }
  
  /**
   * 更新区域热度
   * 当玩家移动时调用
   */
  async updateCellHeat(geohash, playerId) {
    const key = `heatmap:cell:${geohash}`;
    const now = Date.now();
    
    // 添加玩家到活跃集合
    await this.redis.zadd(key, now, playerId);
    
    // 清理过期玩家（5分钟无活动）
    const expireTime = now - 5 * 60 * 1000;
    await this.redis.zremrangebyscore(key, '-inf', expireTime);
    
    // 获取活跃玩家数
    const activePlayers = await this.redis.zcard(key);
    
    // 存储聚合数据
    await this.redis.hset(
      `heatmap:stats:${geohash}`,
      'activePlayers', activePlayers,
      'lastUpdate', now
    );
    
    return activePlayers;
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
   * 获取全局热力图
   */
  async getGlobalHeatmap() {
    const keys = await this.redis.keys('heatmap:stats:*');
    const heatmap = {};
    
    for (const key of keys) {
      const geohash = key.split(':').pop();
      const stats = await this.redis.hgetall(key);
      heatmap[geohash] = {
        activePlayers: parseInt(stats.activePlayers || 0),
        lastUpdate: parseInt(stats.lastUpdate || 0)
      };
    }
    
    return heatmap;
  }
}

module.exports = HeatmapCollector;
```

### 3. 运营配置管理

```javascript
// backend/services/location-service/src/routes/spawnConfig.js
const express = require('express');
const router = express.Router();

/**
 * 获取区域配置
 */
router.get('/config/cell/:geohash', async (req, res) => {
  const { geohash } = req.params;
  const config = await req.db.query(`
    SELECT * FROM spawn_cell_configs 
    WHERE geohash = $1
  `, [geohash]);
  
  res.json({ success: true, data: config.rows[0] || {} });
});

/**
 * 更新区域配置
 */
router.put('/config/cell/:geohash', adminOnly, async (req, res) => {
  const { geohash } = req.params;
  const {
    baseSpawnCount,
    minSpawn,
    maxSpawn,
    spawnPoolOverride,
    enabled
  } = req.body;
  
  await req.db.query(`
    INSERT INTO spawn_cell_configs 
      (geohash, base_spawn_count, min_spawn, max_spawn, spawn_pool_override, enabled, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (geohash) DO UPDATE SET
      base_spawn_count = $2,
      min_spawn = $3,
      max_spawn = $4,
      spawn_pool_override = $5,
      enabled = $6,
      updated_at = NOW()
  `, [geohash, baseSpawnCount, minSpawn, maxSpawn, spawnPoolOverride, enabled]);
  
  // 清除缓存
  await req.redis.del(`spawn:config:${geohash}`);
  
  res.json({ success: true });
});

/**
 * 创建活动事件
 */
router.post('/events', adminOnly, async (req, res) => {
  const {
    name,
    type,
    startTime,
    endTime,
    affectedAreas,
    spawnMultiplier,
    featuredPokemon
  } = req.body;
  
  const result = await req.db.query(`
    INSERT INTO spawn_events 
      (name, type, start_time, end_time, affected_areas, spawn_multiplier, featured_pokemon)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [name, type, startTime, endTime, affectedAreas, spawnMultiplier, featuredPokemon]);
  
  res.json({ success: true, eventId: result.rows[0].id });
});

/**
 * 获取活动列表
 */
router.get('/events', async (req, res) => {
  const { active } = req.query;
  
  let query = 'SELECT * FROM spawn_events';
  if (active === 'true') {
    query += ' WHERE start_time <= NOW() AND end_time >= NOW()';
  }
  query += ' ORDER BY start_time DESC';
  
  const result = await req.db.query(query);
  res.json({ success: true, data: result.rows });
});

/**
 * 精灵池配置
 */
router.get('/pool/:biome', async (req, res) => {
  const { biome } = req.params;
  
  const result = await req.db.query(`
    SELECT p.*, sp.weight, sp.min_level, sp.max_level
    FROM spawn_pools sp
    JOIN pokemon p ON sp.pokemon_id = p.id
    WHERE sp.biome = $1 AND sp.enabled = true
    ORDER BY sp.weight DESC
  `, [biome]);
  
  res.json({ success: true, data: result.rows });
});

/**
 * 更新精灵池
 */
router.put('/pool/:biome', adminOnly, async (req, res) => {
  const { biome } = req.params;
  const { pokemon } = req.body; // [{ id, weight, minLevel, maxLevel }]
  
  await req.db.query('BEGIN');
  
  for (const p of pokemon) {
    await req.db.query(`
      INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (biome, pokemon_id) DO UPDATE SET
        weight = $3,
        min_level = $4,
        max_level = $5
    `, [biome, p.id, p.weight, p.minLevel, p.maxLevel]);
  }
  
  await req.db.query('COMMIT');
  
  // 清除缓存
  await req.redis.del(`spawn:pool:${biome}`);
  
  res.json({ success: true });
});

module.exports = router;
```

### 4. 数据库迁移

```sql
-- database/pending/20260609_233000__add_spawn_management_system.sql

-- 区域刷新配置表
CREATE TABLE spawn_cell_configs (
  id SERIAL PRIMARY KEY,
  geohash VARCHAR(12) UNIQUE NOT NULL,
  base_spawn_count INTEGER DEFAULT 3,
  min_spawn INTEGER DEFAULT 1,
  max_spawn INTEGER DEFAULT 10,
  spawn_pool_override TEXT, -- JSON: 覆盖默认精灵池
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_spawn_cell_configs_geohash ON spawn_cell_configs(geohash);

-- 刷新事件表
CREATE TABLE spawn_events (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- community_day, spotlight_hour, raid_hour, custom
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  affected_areas TEXT, -- JSON: geohash 列表或 null 表示全局
  spawn_multiplier DECIMAL(3,2) DEFAULT 1.0,
  featured_pokemon INTEGER[], -- 特色精灵 ID 列表
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_spawn_events_time ON spawn_events(start_time, end_time);
CREATE INDEX idx_spawn_events_enabled ON spawn_events(enabled) WHERE enabled = true;

-- 精灵池配置表
CREATE TABLE spawn_pools (
  id SERIAL PRIMARY KEY,
  biome VARCHAR(50) NOT NULL, -- grass, water, forest, urban, mountain, cave
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  weight DECIMAL(5,4) DEFAULT 1.0, -- 刷新权重
  min_level INTEGER DEFAULT 1,
  max_level INTEGER DEFAULT 30,
  weather_boost JSONB, -- 天气加成配置
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(biome, pokemon_id)
);

CREATE INDEX idx_spawn_pools_biome ON spawn_pools(biome);
CREATE INDEX idx_spawn_pools_enabled ON spawn_pools(enabled) WHERE enabled = true;

-- 刷新统计表
CREATE TABLE spawn_statistics (
  id SERIAL PRIMARY KEY,
  geohash VARCHAR(12) NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL,
  total_spawns INTEGER DEFAULT 0,
  spawns_by_rarity JSONB,
  captures INTEGER DEFAULT 0,
  despawns INTEGER DEFAULT 0,
  avg_active_players DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(geohash, date, hour)
);

CREATE INDEX idx_spawn_statistics_geohash_date ON spawn_statistics(geohash, date);

-- 运营操作日志表
CREATE TABLE spawn_admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  action VARCHAR(50) NOT NULL, -- create_event, update_config, manual_spawn
  target_type VARCHAR(50), -- cell, event, pool
  target_id VARCHAR(100),
  changes JSONB,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_spawn_admin_logs_admin ON spawn_admin_logs(admin_id);
CREATE INDEX idx_spawn_admin_logs_created ON spawn_admin_logs(created_at);

-- 插入默认精灵池数据（示例）
INSERT INTO spawn_pools (biome, pokemon_id, weight) VALUES
-- 草地生物群系
('grass', 1, 10.0),   -- 妙蛙种子
('grass', 16, 15.0),  -- 绿毛虫
('grass', 19, 12.0),  -- 小拉达
('grass', 25, 3.0),   -- 皮卡丘（稀有）
('grass', 43, 8.0),   -- 走路草
('grass', 63, 6.0),   -- 凯西

-- 水域生物群系
('water', 7, 8.0),    -- 杰尼龟
('water', 54, 12.0),  -- 哥达鸭
('water', 60, 10.0),  -- 蚊香蝌蚪
('water', 72, 7.0),   -- 玛瑙水母
('water', 86, 5.0),   -- 小海狮
('water', 98, 4.0),   -- 大钳蟹

-- 城市生物群系
('urban', 52, 15.0),  -- 喵喵
('urban', 63, 10.0),  -- 凯西
('urban', 92, 8.0),   -- 鬼斯
('urban', 109, 6.0),  -- 瓦斯弹
('urban', 133, 2.0),  -- 伊布（稀有）

-- 森林生物群系
('forest', 10, 10.0), -- 绿毛虫
('forest', 11, 8.0),  -- 铁甲蛹
('forest', 25, 5.0),  -- 皮卡丘
('forest', 69, 12.0), -- 喇叭芽
('forest', 123, 1.5), -- 飞天螳螂（稀有）

-- 山地生物群系
('mountain', 66, 8.0),  -- 腕力
('mountain', 74, 10.0), -- 小拳石
('mountain', 95, 3.0),  -- 大岩蛇（稀有）
('mountain', 111, 5.0), -- 铁甲犀牛
('mountain', 126, 1.0), -- 鸭嘴火兽（稀有）

-- 洞穴生物群系
('cave', 41, 12.0),   -- 超音蝠
('cave', 46, 8.0),    -- 派拉斯
('cave', 66, 6.0),    -- 腕力
('cave', 74, 10.0),   -- 小拳石
('cave', 88, 4.0);    -- 臭泥

-- 插入默认区域配置（示例热门区域）
INSERT INTO spawn_cell_configs (geohash, base_spawn_count, min_spawn, max_spawn) VALUES
('wm4ez', 5, 3, 12),  -- 示例城市中心区域
('wm4ey', 4, 2, 10),  -- 示例公园区域
('wm4ex', 3, 2, 8);   -- 示例郊区区域

COMMENT ON TABLE spawn_cell_configs IS '区域刷新配置表，控制各区域的精灵刷新策略';
COMMENT ON TABLE spawn_events IS '刷新事件表，管理特殊活动期间的刷新策略';
COMMENT ON TABLE spawn_pools IS '精灵池配置表，定义各生物群系的精灵分布';
COMMENT ON TABLE spawn_statistics IS '刷新统计表，记录历史刷新数据用于分析';
COMMENT ON TABLE spawn_admin_logs IS '运营操作日志表，记录管理员对刷新系统的修改';
```

### 5. Prometheus 指标

```javascript
// backend/shared/spawnMetrics.js
const client = require('prom-client');

const spawnMetrics = {
  // 当前活跃刷新数量
  activeSpawns: new client.Gauge({
    name: 'spawn_active_total',
    help: 'Current number of active spawns',
    labelNames: ['rarity', 'biome']
  }),
  
  // 刷新计数器
  spawnCounter: new client.Counter({
    name: 'spawn_created_total',
    help: 'Total number of spawns created',
    labelNames: ['rarity', 'biome', 'geohash_prefix']
  }),
  
  // 消失计数器
  despawnCounter: new client.Counter({
    name: 'spawn_despawn_total',
    help: 'Total number of spawns despawned',
    labelNames: ['reason'] // timeout, captured
  }),
  
  // 捕捉成功率
  captureRate: new client.Gauge({
    name: 'spawn_capture_rate',
    help: 'Capture success rate',
    labelNames: ['pokemon_rarity']
  }),
  
  // 区域热度
  cellHeat: new client.Gauge({
    name: 'spawn_cell_active_players',
    help: 'Active players in spawn cell',
    labelNames: ['geohash_prefix']
  }),
  
  // 刷新计算延迟
  spawnCalculationDuration: new client.Histogram({
    name: 'spawn_calculation_duration_seconds',
    help: 'Time spent calculating spawns',
    labelNames: ['operation'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  }),
  
  // 热力图更新延迟
  heatmapUpdateDuration: new client.Histogram({
    name: 'spawn_heatmap_update_duration_seconds',
    help: 'Time spent updating heatmap',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1]
  })
};

module.exports = spawnMetrics;
```

### 6. 前端集成

```javascript
// frontend/game-client/src/game/SpawnManager.js
class SpawnManager {
  constructor(map) {
    this.map = map;
    this.activeSpawns = new Map();
    this.spawnMarkers = new Map();
    this.lastUpdate = null;
    this.updateInterval = 10000; // 10秒更新一次
    
    this.startSpawnUpdates();
  }
  
  /**
   * 获取附近精灵
   */
  async fetchNearbySpawns(lat, lng, radius = 500) {
    const response = await fetch(
      `/api/location/nearby-spawns?lat=${lat}&lng=${lng}&radius=${radius}`
    );
    
    if (!response.ok) throw new Error('Failed to fetch spawns');
    
    const data = await response.json();
    return data.spawns;
  }
  
  /**
   * 更新地图上的精灵标记
   */
  updateSpawnMarkers(spawns) {
    // 移除已消失的精灵
    for (const [id, marker] of this.spawnMarkers) {
      if (!spawns.find(s => s.id === id)) {
        marker.remove();
        this.spawnMarkers.delete(id);
        this.activeSpawns.delete(id);
      }
    }
    
    // 添加新精灵
    for (const spawn of spawns) {
      if (!this.spawnMarkers.has(spawn.id)) {
        this.createSpawnMarker(spawn);
      }
    }
  }
  
  /**
   * 创建精灵标记
   */
  createSpawnMarker(spawn) {
    const marker = L.marker([spawn.location.lat, spawn.location.lng], {
      icon: this.getPokemonIcon(spawn.pokemonId, spawn.rarity)
    });
    
    marker.bindPopup(this.createSpawnPopup(spawn));
    marker.addTo(this.map);
    
    // 添加消失倒计时
    this.addDespawnTimer(marker, spawn);
    
    this.spawnMarkers.set(spawn.id, marker);
    this.activeSpawns.set(spawn.id, spawn);
  }
  
  /**
   * 消失倒计时
   */
  addDespawnTimer(marker, spawn) {
    const updateTimer = () => {
      const remaining = new Date(spawn.despawnAt) - new Date();
      if (remaining <= 0) {
        marker.remove();
        this.spawnMarkers.delete(spawn.id);
        this.activeSpawns.delete(spawn.id);
        return;
      }
      
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      marker.setTooltipContent(`${minutes}:${seconds.toString().padStart(2, '0')}`);
      
      setTimeout(updateTimer, 1000);
    };
    
    updateTimer();
  }
  
  /**
   * 获取精灵图标
   */
  getPokemonIcon(pokemonId, rarity) {
    const size = rarity === 'legendary' ? 48 : 
                 rarity === 'rare' ? 40 : 32;
    
    return L.icon({
      iconUrl: `/assets/pokemon/${pokemonId}.png`,
      iconSize: [size, size],
      iconAnchor: [size/2, size/2],
      className: `spawn-marker rarity-${rarity}`
    });
  }
}

module.exports = SpawnManager;
```

## 验收标准

- [ ] 精灵刷新引擎能根据区域热度动态调整刷新数量
- [ ] 热力图收集器能实时追踪各区域活跃玩家数
- [ ] 时间因子正确影响刷新密度（高峰时段比低谷时段多 50%+）
- [ ] 运营配置 API 支持创建/更新/删除刷新事件
- [ ] 精灵池配置支持按生物群系分类管理
- [ ] 刷新统计表能正确记录每小时刷新数据
- [ ] 前端地图正确显示附近精灵及消失倒计时
- [ ] Redis 缓存正确存储活跃刷新，TTL 与消失时间同步
- [ ] Prometheus 指标正确暴露刷新相关数据
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证完整刷新流程

## 影响范围

- **新增文件**：
  - `backend/shared/SpawnEngine.js` - 刷新引擎核心
  - `backend/shared/HeatmapCollector.js` - 热力图收集器
  - `backend/shared/spawnMetrics.js` - Prometheus 指标
  - `backend/services/location-service/src/routes/spawnConfig.js` - 运营配置 API
  - `frontend/game-client/src/game/SpawnManager.js` - 前端刷新管理
  - `database/pending/20260609_233000__add_spawn_management_system.sql` - 数据库迁移

- **修改文件**：
  - `backend/services/location-service/src/index.js` - 集成刷新引擎
  - `backend/services/catch-service/src/index.js` - 捕捉后更新热力图
  - `backend/shared/cacheConfig.js` - 添加刷新数据缓存配置

## 参考

- [Pokemon GO Spawn Mechanics](https://pokemongohub.net/guide/pokemon-go-spawn-mechanics/)
- [Geohash Encoding](https://en.wikipedia.org/wiki/Geohash)
- [Spatial Indexing with Redis GEO](https://redis.io/commands/geoadd)
- [Heat Map Algorithms for Game Balance](https://www.gamedeveloper.com/design/heat-maps-in-game-design)
