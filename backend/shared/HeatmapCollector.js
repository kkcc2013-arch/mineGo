// backend/shared/HeatmapCollector.js — Player Activity Heatmap Collector
'use strict';

const { createLogger } = require('./logger');
const spawnMetrics = require('./spawnMetrics');

const logger = createLogger('heatmap-collector');

/**
 * HeatmapCollector - Tracks player activity by geographic area
 */
class HeatmapCollector {
  constructor(config = {}) {
    this.redis = config.redis;
    this.db = config.db;
    this.config = {
      playerExpireTime: 5 * 60 * 1000, // 5 minutes
      statsRetentionDays: 30,
      ...config
    };
    
    this.metrics = spawnMetrics;
  }
  
  /**
   * Update cell heat when player moves
   */
  async updateCellHeat(geohash, playerId) {
    const start = Date.now();
    
    try {
      const key = `heatmap:cell:${geohash}`;
      const now = Date.now();
      
      // Add player to active set with timestamp
      await this.redis.zadd(key, now, playerId);
      
      // Remove expired players (inactive for 5 minutes)
      const expireTime = now - this.config.playerExpireTime;
      await this.redis.zremrangebyscore(key, '-inf', expireTime);
      
      // Get active player count
      const activePlayers = await this.redis.zcard(key);
      
      // Store aggregated stats
      await this.redis.hset(
        `heatmap:stats:${geohash}`,
        'activePlayers', activePlayers,
        'lastUpdate', now
      );
      
      // Update metrics
      this.metrics.cellHeat.set(
        { geohash_prefix: geohash.substring(0, 4) }, 
        activePlayers
      );
      
      const duration = Date.now() - start;
      this.metrics.heatmapUpdateDuration.observe(duration / 1000);
      
      logger.debug('Cell heat updated', { 
        geohash, 
        playerId, 
        activePlayers,
        duration 
      });
      
      return activePlayers;
    } catch (error) {
      logger.error('Failed to update cell heat', { 
        geohash, 
        playerId, 
        error: error.message 
      });
      throw error;
    }
  }
  
  /**
   * Get heatmap for a cell
   */
  async getHeatmap(geohash) {
    try {
      const stats = await this.redis.hgetall(`heatmap:stats:${geohash}`);
      
      return {
        geohash,
        activePlayers: parseInt(stats.activePlayers || 0),
        lastUpdate: parseInt(stats.lastUpdate || 0)
      };
    } catch (error) {
      logger.error('Failed to get heatmap', { geohash, error: error.message });
      return { geohash, activePlayers: 0, lastUpdate: 0 };
    }
  }
  
  /**
   * Get global heatmap
   */
  async getGlobalHeatmap() {
    try {
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
    } catch (error) {
      logger.error('Failed to get global heatmap', { error: error.message });
      return {};
    }
  }
  
  /**
   * Get hot zones (top N most active areas)
   */
  async getHotZones(limit = 10) {
    try {
      const heatmap = await this.getGlobalHeatmap();
      
      const sorted = Object.entries(heatmap)
        .map(([geohash, data]) => ({
          geohash,
          ...data
        }))
        .sort((a, b) => b.activePlayers - a.activePlayers)
        .slice(0, limit);
      
      return sorted;
    } catch (error) {
      logger.error('Failed to get hot zones', { error: error.message });
      return [];
    }
  }
  
  /**
   * Record player movement
   */
  async recordMovement(playerId, lat, lng) {
    try {
      // Calculate geohash from coordinates
      const geohash = this.coordToGeohash(lat, lng, 6);
      
      // Update heatmap
      const activePlayers = await this.updateCellHeat(geohash, playerId);
      
      // Store player's last known location
      await this.redis.geoadd('players:geo', lng, lat, playerId);
      await this.redis.set(`player:location:${playerId}`, JSON.stringify({
        lat,
        lng,
        geohash,
        updatedAt: Date.now()
      }));
      
      // Set expiry on player location (24 hours)
      await this.redis.expire(`player:location:${playerId}`, 86400);
      
      return {
        geohash,
        activePlayers
      };
    } catch (error) {
      logger.error('Failed to record movement', { 
        playerId, 
        lat, 
        lng, 
        error: error.message 
      });
      throw error;
    }
  }
  
  /**
   * Get players in area
   */
  async getPlayersInArea(geohash) {
    try {
      const now = Date.now();
      const expireTime = now - this.config.playerExpireTime;
      
      // Get active players
      const players = await this.redis.zrangebyscore(
        `heatmap:cell:${geohash}`,
        expireTime,
        '+inf'
      );
      
      return players;
    } catch (error) {
      logger.error('Failed to get players in area', { geohash, error: error.message });
      return [];
    }
  }
  
  /**
   * Archive heatmap statistics to database
   */
  async archiveStats() {
    try {
      if (!this.db) {
        logger.warn('Database not available for archiving');
        return;
      }
      
      const now = new Date();
      const date = now.toISOString().split('T')[0];
      const hour = now.getHours();
      
      // Get all cells
      const keys = await this.redis.keys('heatmap:stats:*');
      
      for (const key of keys) {
        const geohash = key.split(':').pop();
        const stats = await this.redis.hgetall(key);
        const activePlayers = parseInt(stats.activePlayers || 0);
        
        // Insert or update statistics
        await this.db.query(`
          INSERT INTO heatmap_statistics 
            (geohash, date, hour, avg_active_players, created_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (geohash, date, hour) DO UPDATE SET
            avg_active_players = $4
        `, [geohash, date, hour, activePlayers]);
      }
      
      logger.info('Heatmap stats archived', { 
        date, 
        hour, 
        cellsArchived: keys.length 
      });
    } catch (error) {
      logger.error('Failed to archive stats', { error: error.message });
    }
  }
  
  /**
   * Clean up old statistics
   */
  async cleanupOldStats() {
    try {
      if (!this.db) return;
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.statsRetentionDays);
      
      const result = await this.db.query(`
        DELETE FROM heatmap_statistics
        WHERE date < $1
      `, [cutoffDate.toISOString().split('T')[0]]);
      
      logger.info('Old stats cleaned up', { 
        deletedRows: result.rowCount,
        cutoffDate 
      });
    } catch (error) {
      logger.error('Failed to cleanup old stats', { error: error.message });
    }
  }
  
  /**
   * Convert coordinates to geohash (simplified)
   */
  coordToGeohash(lat, lng, precision = 6) {
    const CHARSET = '0123456789bcdefghjkmnpqrstuvwxyz';
    let hash = '';
    let latMin = -90, latMax = 90;
    let lngMin = -180, lngMax = 180;
    let bit = 0;
    let ch = 0;
    
    while (hash.length < precision) {
      if (bit % 2 === 0) {
        // Longitude
        const mid = (lngMin + lngMax) / 2;
        if (lng > mid) {
          ch |= 16 >> (bit % 5);
          lngMin = mid;
        } else {
          lngMax = mid;
        }
      } else {
        // Latitude
        const mid = (latMin + latMax) / 2;
        if (lat > mid) {
          ch |= 16 >> (bit % 5);
          latMin = mid;
        } else {
          latMax = mid;
        }
      }
      
      bit++;
      if (bit % 5 === 0) {
        hash += CHARSET[ch];
        ch = 0;
      }
    }
    
    return hash;
  }
  
  /**
   * Get statistics summary
   */
  async getStatsSummary() {
    try {
      const globalHeatmap = await this.getGlobalHeatmap();
      const totalCells = Object.keys(globalHeatmap).length;
      const totalPlayers = Object.values(globalHeatmap)
        .reduce((sum, cell) => sum + cell.activePlayers, 0);
      const avgPlayersPerCell = totalCells > 0 ? totalPlayers / totalCells : 0;
      
      const hotZones = await this.getHotZones(5);
      
      return {
        totalCells,
        totalPlayers,
        avgPlayersPerCell,
        hotZones,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Failed to get stats summary', { error: error.message });
      return {
        totalCells: 0,
        totalPlayers: 0,
        avgPlayersPerCell: 0,
        hotZones: [],
        timestamp: Date.now()
      };
    }
  }
}

module.exports = HeatmapCollector;
