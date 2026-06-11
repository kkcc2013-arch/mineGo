// backend/shared/SpawnEngine.js — Pokemon Spawn Management Engine
'use strict';

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const spawnMetrics = require('./spawnMetrics');

const logger = createLogger('spawn-engine');

/**
 * SpawnEngine - Manages dynamic pokemon spawning based on heatmap and events
 */
class SpawnEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.redis = config.redis;
    this.db = config.db;
    this.config = {
      gridSize: 6, // Geohash precision (~1.2km x 0.6km)
      heatmapUpdateInterval: 60000, // 1 minute
      spawnCheckInterval: 30000, // 30 seconds
      defaultDespawnMinutes: { min: 15, max: 60 },
      ...config
    };
    
    this.spawnTimers = new Map();
    this.isRunning = false;
    
    // Metrics
    this.metrics = spawnMetrics;
    
    logger.info('SpawnEngine initialized', { config: this.config });
  }
  
  /**
   * Start spawn loop
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.spawnLoop();
    this.heatmapLoop();
    
    logger.info('SpawnEngine started');
  }
  
  /**
   * Stop spawn loop
   */
  stop() {
    this.isRunning = false;
    
    for (const timer of this.spawnTimers.values()) {
      clearTimeout(timer);
    }
    this.spawnTimers.clear();
    
    logger.info('SpawnEngine stopped');
  }
  
  /**
   * Main spawn loop
   */
  async spawnLoop() {
    while (this.isRunning) {
      try {
        await this.processAllCells();
      } catch (error) {
        logger.error('Spawn loop error', { error: error.message });
      }
      
      await this.sleep(this.config.spawnCheckInterval);
    }
  }
  
  /**
   * Heatmap update loop
   */
  async heatmapLoop() {
    while (this.isRunning) {
      try {
        await this.updateHeatmapStats();
      } catch (error) {
        logger.error('Heatmap update error', { error: error.message });
      }
      
      await this.sleep(this.config.heatmapUpdateInterval);
    }
  }
  
  /**
   * Process all active cells
   */
  async processAllCells() {
    const start = Date.now();
    
    // Get all active cells from heatmap
    const activeCells = await this.getActiveCells();
    
    for (const geohash of activeCells) {
      try {
        await this.processCell(geohash);
      } catch (error) {
        logger.error('Failed to process cell', { geohash, error: error.message });
      }
    }
    
    const duration = (Date.now() - start) / 1000;
    this.metrics.spawnCalculationDuration.observe({ operation: 'process_all_cells' }, duration);
  }
  
  /**
   * Process a single cell
   */
  async processCell(geohash) {
    // Calculate spawn count for this cell
    const spawnCount = await this.calculateSpawnForCell(geohash);
    
    // Get existing spawns
    const existing = await this.getExistingSpawns(geohash);
    
    // Calculate how many to spawn
    const toSpawn = Math.max(0, spawnCount - existing.length);
    
    if (toSpawn <= 0) return [];
    
    logger.debug('Spawning pokemon', { geohash, toSpawn, existing: existing.length });
    
    // Spawn new pokemon
    const spawned = await this.spawnPokemon(geohash, toSpawn);
    
    return spawned;
  }
  
  /**
   * Calculate spawn count for a cell
   */
  async calculateSpawnForCell(geohash) {
    const start = Date.now();
    
    try {
      // Get heatmap data
      const heatmap = await this.getHeatmap(geohash);
      const activePlayers = heatmap.activePlayers || 0;
      
      // Get cell config
      const cellConfig = await this.getCellConfig(geohash);
      
      // Base spawn count
      const baseSpawn = cellConfig.baseSpawnCount || 3;
      
      // Calculate factors
      const timeFactor = this.getTimeFactor();
      const playerFactor = this.getPlayerFactor(activePlayers);
      const eventFactor = await this.getEventFactor(geohash);
      
      // Final spawn count
      const spawnCount = Math.floor(
        baseSpawn * timeFactor * playerFactor * eventFactor
      );
      
      // Apply limits
      const minSpawn = cellConfig.minSpawn || 1;
      const maxSpawn = cellConfig.maxSpawn || 10;
      const result = Math.max(minSpawn, Math.min(maxSpawn, spawnCount));
      
      const duration = (Date.now() - start) / 1000;
      this.metrics.spawnCalculationDuration.observe({ operation: 'calculate' }, duration);
      
      return result;
    } catch (error) {
      logger.error('Failed to calculate spawn count', { geohash, error: error.message });
      return 1; // Default fallback
    }
  }
  
  /**
   * Time factor - higher during peak hours
   */
  getTimeFactor() {
    const hour = new Date().getHours();
    
    const timeMultipliers = {
      // Late night (low activity)
      0: 0.5, 1: 0.4, 2: 0.3, 3: 0.3, 4: 0.4, 5: 0.5,
      // Morning
      6: 0.7, 7: 0.8, 8: 0.9,
      // Working hours
      9: 1.0, 10: 1.0, 11: 1.1, 12: 1.2, 13: 1.1, 14: 1.0,
      // Afternoon
      15: 1.0, 16: 1.1, 17: 1.2,
      // Evening peak
      18: 1.5, 19: 1.6, 20: 1.5, 21: 1.4,
      // Night
      22: 1.2, 23: 0.8
    };
    
    return timeMultipliers[hour] || 1.0;
  }
  
  /**
   * Player activity factor
   */
  getPlayerFactor(activePlayers) {
    if (activePlayers === 0) return 0.3; // Minimum spawns even with no players
    if (activePlayers <= 5) return 1.0;
    if (activePlayers <= 15) return 1.2;
    if (activePlayers <= 30) return 1.4;
    if (activePlayers <= 50) return 1.5;
    return 1.6; // Cap at 1.6x
  }
  
  /**
   * Event factor - check for active events
   */
  async getEventFactor(geohash) {
    try {
      const eventKey = `events:cell:${geohash}`;
      const activeEvents = await this.redis.get(eventKey);
      
      if (!activeEvents) return 1.0;
      
      const events = JSON.parse(activeEvents);
      let factor = 1.0;
      
      for (const event of events) {
        if (event.type === 'community_day') factor *= 2.0;
        else if (event.type === 'spotlight_hour') factor *= 1.5;
        else if (event.type === 'raid_hour') factor *= 1.3;
        else if (event.multiplier) factor *= event.multiplier;
      }
      
      return Math.min(factor, 3.0); // Cap at 3x
    } catch (error) {
      logger.error('Failed to get event factor', { geohash, error: error.message });
      return 1.0;
    }
  }
  
  /**
   * Spawn pokemon in a cell
   */
  async spawnPokemon(geohash, count) {
    if (count <= 0) return [];
    
    const spawnPool = await this.getSpawnPool(geohash);
    
    if (!spawnPool || spawnPool.length === 0) {
      logger.warn('No spawn pool available', { geohash });
      return [];
    }
    
    const spawned = [];
    
    for (let i = 0; i < count; i++) {
      try {
        const pokemon = this.weightedRandomSelect(spawnPool);
        const spawn = await this.createSpawn(pokemon, geohash);
        spawned.push(spawn);
      } catch (error) {
        logger.error('Failed to create spawn', { geohash, error: error.message });
      }
    }
    
    // Emit spawn event
    if (spawned.length > 0) {
      this.emit('spawn', { geohash, spawned });
    }
    
    return spawned;
  }
  
  /**
   * Create a spawn instance
   */
  async createSpawn(pokemonTemplate, geohash) {
    const spawnId = uuidv4();
    const centerCoord = this.geohashToCoord(geohash);
    
    // Random offset (100-300m)
    const offset = this.randomOffset(100, 300);
    const location = {
      lat: centerCoord.lat + offset.lat,
      lng: centerCoord.lng + offset.lng
    };
    
    // Calculate despawn time (15-60 minutes)
    const despawnMinutes = this.config.defaultDespawnMinutes.min + 
      Math.random() * (this.config.defaultDespawnMinutes.max - this.config.defaultDespawnMinutes.min);
    const despawnAt = new Date(Date.now() + despawnMinutes * 60000);
    
    const spawn = {
      id: spawnId,
      pokemonId: pokemonTemplate.id,
      pokemonName: pokemonTemplate.name,
      rarity: pokemonTemplate.rarity || 'common',
      location,
      geohash,
      spawnedAt: new Date().toISOString(),
      despawnAt: despawnAt.toISOString(),
      cp: this.calculateCP(pokemonTemplate),
      iv: this.generateIV(),
      level: pokemonTemplate.minLevel || 1 + Math.floor(Math.random() * 30)
    };
    
    // Store in Redis with TTL
    const ttl = Math.floor((despawnAt.getTime() - Date.now()) / 1000);
    await this.redis.hset(`spawns:active:${spawnId}`, 'data', JSON.stringify(spawn));
    await this.redis.expire(`spawns:active:${spawnId}`, ttl);
    
    // Add to geo index
    await this.redis.geoadd('spawns:geo', location.lng, location.lat, spawnId);
    
    // Add to cell index
    await this.redis.sadd(`spawns:cell:${geohash}`, spawnId);
    
    // Update metrics
    this.metrics.spawnCounter.inc({ 
      rarity: spawn.rarity,
      biome: pokemonTemplate.biome || 'unknown',
      geohash_prefix: geohash.substring(0, 4)
    });
    
    logger.info('Pokemon spawned', { 
      spawnId, 
      pokemonId: spawn.pokemonId, 
      rarity: spawn.rarity,
      geohash 
    });
    
    return spawn;
  }
  
  /**
   * Get existing spawns in a cell
   */
  async getExistingSpawns(geohash) {
    try {
      const spawnIds = await this.redis.smembers(`spawns:cell:${geohash}`);
      const spawns = [];
      
      for (const spawnId of spawnIds) {
        const data = await this.redis.hget(`spawns:active:${spawnId}`, 'data');
        if (data) {
          spawns.push(JSON.parse(data));
        } else {
          // Clean up stale reference
          await this.redis.srem(`spawns:cell:${geohash}`, spawnId);
        }
      }
      
      return spawns;
    } catch (error) {
      logger.error('Failed to get existing spawns', { geohash, error: error.message });
      return [];
    }
  }
  
  /**
   * Get heatmap data for a cell
   */
  async getHeatmap(geohash) {
    try {
      const stats = await this.redis.hgetall(`heatmap:stats:${geohash}`);
      return {
        activePlayers: parseInt(stats.activePlayers || 0),
        lastUpdate: parseInt(stats.lastUpdate || 0)
      };
    } catch (error) {
      logger.error('Failed to get heatmap', { geohash, error: error.message });
      return { activePlayers: 0, lastUpdate: 0 };
    }
  }
  
  /**
   * Get cell configuration
   */
  async getCellConfig(geohash) {
    try {
      // Try cache first
      const cached = await this.redis.get(`spawn:config:${geohash}`);
      if (cached) return JSON.parse(cached);
      
      // Load from database
      if (this.db) {
        const result = await this.db.query(
          'SELECT * FROM spawn_cell_configs WHERE geohash = $1',
          [geohash]
        );
        
        if (result.rows[0]) {
          const config = result.rows[0];
          // Cache for 5 minutes
          await this.redis.setex(
            `spawn:config:${geohash}`,
            300,
            JSON.stringify(config)
          );
          return config;
        }
      }
      
      // Return default config
      return {
        baseSpawnCount: 3,
        minSpawn: 1,
        maxSpawn: 10
      };
    } catch (error) {
      logger.error('Failed to get cell config', { geohash, error: error.message });
      return { baseSpawnCount: 3, minSpawn: 1, maxSpawn: 10 };
    }
  }
  
  /**
   * Get spawn pool for a cell
   */
  async getSpawnPool(geohash) {
    try {
      // Determine biome from geohash (simplified - in real app would use geo data)
      const biome = await this.determineBiome(geohash);
      
      // Try cache
      const cached = await this.redis.get(`spawn:pool:${biome}`);
      if (cached) return JSON.parse(cached);
      
      // Load from database
      if (this.db) {
        const result = await this.db.query(`
          SELECT 
            p.id, p.name, p.rarity, p.base_attack, p.base_defense, p.base_stamina,
            sp.weight, sp.min_level, sp.max_level
          FROM spawn_pools sp
          JOIN pokemon_species p ON sp.pokemon_id = p.id
          WHERE sp.biome = $1 AND sp.enabled = true
          ORDER BY sp.weight DESC
        `, [biome]);
        
        const pool = result.rows.map(row => ({
          id: row.id,
          name: row.name,
          rarity: row.rarity,
          weight: parseFloat(row.weight),
          minLevel: row.min_level,
          maxLevel: row.max_level,
          baseAttack: row.base_attack,
          baseDefense: row.base_defense,
          baseStamina: row.base_stamina,
          biome
        }));
        
        // Cache for 10 minutes
        await this.redis.setex(`spawn:pool:${biome}`, 600, JSON.stringify(pool));
        
        return pool;
      }
      
      // Fallback to basic pool
      return [
        { id: 1, name: 'Bulbasaur', rarity: 'common', weight: 10.0 },
        { id: 4, name: 'Charmander', rarity: 'common', weight: 10.0 },
        { id: 7, name: 'Squirtle', rarity: 'common', weight: 10.0 }
      ];
    } catch (error) {
      logger.error('Failed to get spawn pool', { geohash, error: error.message });
      return [];
    }
  }
  
  /**
   * Determine biome from geohash (simplified)
   */
  async determineBiome(geohash) {
    // In a real implementation, this would check geographic data
    // For now, use a simple hash-based selection
    const biomes = ['grass', 'water', 'urban', 'forest', 'mountain', 'cave'];
    const hash = geohash.charCodeAt(0) % biomes.length;
    return biomes[hash];
  }
  
  /**
   * Get active cells from heatmap
   */
  async getActiveCells() {
    try {
      const keys = await this.redis.keys('heatmap:stats:*');
      return keys.map(key => key.split(':').pop());
    } catch (error) {
      logger.error('Failed to get active cells', { error: error.message });
      return [];
    }
  }
  
  /**
   * Update heatmap statistics
   */
  async updateHeatmapStats() {
    const start = Date.now();
    
    try {
      const keys = await this.redis.keys('heatmap:cell:*');
      
      for (const key of keys) {
        const geohash = key.split(':').pop();
        
        // Count active players
        const activePlayers = await this.redis.zcard(key);
        
        // Store stats
        await this.redis.hset(
          `heatmap:stats:${geohash}`,
          'activePlayers', activePlayers,
          'lastUpdate', Date.now()
        );
        
        // Update metrics
        this.metrics.cellHeat.set({ geohash_prefix: geohash.substring(0, 4) }, activePlayers);
      }
      
      const duration = (Date.now() - start) / 1000;
      this.metrics.heatmapUpdateDuration.observe(duration);
    } catch (error) {
      logger.error('Failed to update heatmap stats', { error: error.message });
    }
  }
  
  /**
   * Remove a spawn
   */
  async removeSpawn(spawnId, geohash) {
    try {
      // Get spawn data before removing
      const data = await this.redis.hget(`spawns:active:${spawnId}`, 'data');
      const spawn = data ? JSON.parse(data) : null;
      
      // Remove from geo index
      await this.redis.zrem('spawns:geo', spawnId);
      
      // Remove from cell index
      if (geohash) {
        await this.redis.srem(`spawns:cell:${geohash}`, spawnId);
      }
      
      // Delete data
      await this.redis.del(`spawns:active:${spawnId}`);
      
      // Update metrics
      this.metrics.despawnCounter.inc({ reason: 'timeout' });
      
      this.emit('despawn', { spawnId, geohash, spawn });
      
      logger.info('Spawn removed', { spawnId, geohash });
    } catch (error) {
      logger.error('Failed to remove spawn', { spawnId, error: error.message });
    }
  }
  
  /**
   * Weighted random selection
   */
  weightedRandomSelect(pool) {
    if (!pool || pool.length === 0) {
      throw new Error('Empty spawn pool');
    }
    
    const totalWeight = pool.reduce((sum, p) => sum + (p.weight || 1), 0);
    let random = Math.random() * totalWeight;
    
    for (const pokemon of pool) {
      random -= (pokemon.weight || 1);
      if (random <= 0) return pokemon;
    }
    
    return pool[pool.length - 1];
  }
  
  /**
   * Calculate CP (Combat Power)
   */
  calculateCP(pokemon) {
    const baseAtk = pokemon.baseAttack || 100;
    const baseDef = pokemon.baseDefense || 100;
    const baseSta = pokemon.baseStamina || 100;
    
    // Simplified CP formula
    const cp = Math.floor(
      (baseAtk * Math.sqrt(baseDef * baseSta)) / 10
    );
    
    return Math.max(10, Math.min(5000, cp));
  }
  
  /**
   * Generate IV (Individual Values)
   */
  generateIV() {
    return {
      attack: Math.floor(Math.random() * 16),
      defense: Math.floor(Math.random() * 16),
      stamina: Math.floor(Math.random() * 16)
    };
  }
  
  /**
   * Convert geohash to coordinates
   */
  geohashToCoord(geohash) {
    // Simplified implementation - use a proper geohash library in production
    // This returns approximate center coordinates
    const baseLat = 0;
    const baseLng = 0;
    const latRange = 180;
    const lngRange = 360;
    
    let latMin = -90, latMax = 90;
    let lngMin = -180, lngMax = 180;
    
    for (let i = 0; i < geohash.length; i++) {
      const c = geohash[i];
      const cd = this.decodeBase32(c);
      
      if (i % 2 === 0) {
        // Longitude
        const mid = (lngMin + lngMax) / 2;
        if ((cd & 16) !== 0) lngMin = mid;
        else lngMax = mid;
        if ((cd & 8) !== 0) lngMin = (lngMin + mid) / 2;
        else lngMax = (lngMax + mid) / 2;
        if ((cd & 4) !== 0) lngMin = (lngMin + mid) / 2;
        else lngMax = (lngMax + mid) / 2;
        if ((cd & 2) !== 0) lngMin = (lngMin + mid) / 2;
        else lngMax = (lngMax + mid) / 2;
        if ((cd & 1) !== 0) lngMin = (lngMin + mid) / 2;
        else lngMax = (lngMax + mid) / 2;
      } else {
        // Latitude
        const mid = (latMin + latMax) / 2;
        if ((cd & 16) !== 0) latMin = mid;
        else latMax = mid;
        if ((cd & 8) !== 0) latMin = (latMin + mid) / 2;
        else latMax = (latMax + mid) / 2;
        if ((cd & 4) !== 0) latMin = (latMin + mid) / 2;
        else latMax = (latMax + mid) / 2;
        if ((cd & 2) !== 0) latMin = (latMin + mid) / 2;
        else latMax = (latMax + mid) / 2;
        if ((cd & 1) !== 0) latMin = (latMin + mid) / 2;
        else latMax = (latMax + mid) / 2;
      }
    }
    
    return {
      lat: (latMin + latMax) / 2,
      lng: (lngMin + lngMax) / 2
    };
  }
  
  /**
   * Decode base32 character
   */
  decodeBase32(c) {
    const CHARSET = '0123456789bcdefghjkmnpqrstuvwxyz';
    return CHARSET.indexOf(c.toLowerCase());
  }
  
  /**
   * Generate random offset in meters
   */
  randomOffset(minMeters, maxMeters) {
    const distance = minMeters + Math.random() * (maxMeters - minMeters);
    const angle = Math.random() * 2 * Math.PI;
    
    // Convert meters to degrees (approximate)
    const latOffset = (distance * Math.cos(angle)) / 111000;
    const lngOffset = (distance * Math.sin(angle)) / (111000 * Math.cos(0));
    
    return {
      lat: latOffset,
      lng: lngOffset
    };
  }
  
  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get spawn by ID
   */
  async getSpawn(spawnId) {
    try {
      const data = await this.redis.hget(`spawns:active:${spawnId}`, 'data');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Failed to get spawn', { spawnId, error: error.message });
      return null;
    }
  }
  
  /**
   * Get nearby spawns
   */
  async getNearbySpawns(lat, lng, radius = 500) {
    try {
      const results = await this.redis.georadius(
        'spawns:geo',
        lng, lat,
        radius, 'm',
        'WITHDIST',
        'COUNT', 50
      );
      
      const spawns = [];
      for (const [spawnId, distance] of results) {
        const data = await this.redis.hget(`spawns:active:${spawnId}`, 'data');
        if (data) {
          const spawn = JSON.parse(data);
          spawn.distance = distance;
          spawns.push(spawn);
        }
      }
      
      return spawns;
    } catch (error) {
      logger.error('Failed to get nearby spawns', { lat, lng, error: error.message });
      return [];
    }
  }
}

module.exports = SpawnEngine;
