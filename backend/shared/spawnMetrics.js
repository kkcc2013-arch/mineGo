// backend/shared/spawnMetrics.js — Prometheus Metrics for Spawn System
'use strict';

const client = require('prom-client');

// Register metrics if not already registered
const register = client.register;

const spawnMetrics = {
  // Active spawns gauge
  activeSpawns: new client.Gauge({
    name: 'spawn_active_total',
    help: 'Current number of active spawns',
    labelNames: ['rarity', 'biome']
  }),
  
  // Spawn creation counter
  spawnCounter: new client.Counter({
    name: 'spawn_created_total',
    help: 'Total number of spawns created',
    labelNames: ['rarity', 'biome', 'geohash_prefix']
  }),
  
  // Despawn counter
  despawnCounter: new client.Counter({
    name: 'spawn_despawn_total',
    help: 'Total number of spawns despawned',
    labelNames: ['reason'] // timeout, captured
  }),
  
  // Capture rate gauge
  captureRate: new client.Gauge({
    name: 'spawn_capture_rate',
    help: 'Capture success rate by rarity',
    labelNames: ['pokemon_rarity']
  }),
  
  // Cell heat gauge
  cellHeat: new client.Gauge({
    name: 'spawn_cell_active_players',
    help: 'Active players in spawn cell',
    labelNames: ['geohash_prefix']
  }),
  
  // Spawn calculation duration histogram
  spawnCalculationDuration: new client.Histogram({
    name: 'spawn_calculation_duration_seconds',
    help: 'Time spent calculating spawns',
    labelNames: ['operation'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  }),
  
  // Heatmap update duration histogram
  heatmapUpdateDuration: new client.Histogram({
    name: 'spawn_heatmap_update_duration_seconds',
    help: 'Time spent updating heatmap',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1]
  }),
  
  // Spawn pool size gauge
  spawnPoolSize: new client.Gauge({
    name: 'spawn_pool_size',
    help: 'Number of pokemon in spawn pool',
    labelNames: ['biome']
  }),
  
  // Event multiplier gauge
  eventMultiplier: new client.Gauge({
    name: 'spawn_event_multiplier',
    help: 'Active event spawn multiplier',
    labelNames: ['event_type', 'geohash_prefix']
  }),
  
  // Player movement counter
  playerMovement: new client.Counter({
    name: 'spawn_player_movement_total',
    help: 'Total player movement events recorded',
    labelNames: ['geohash_prefix']
  })
};

/**
 * Update active spawns gauge
 */
async function updateActiveSpawnsGauge(redis) {
  try {
    const keys = await redis.keys('spawns:active:*');
    
    const counts = {
      common: 0,
      uncommon: 0,
      rare: 0,
      'very-rare': 0,
      legendary: 0
    };
    
    for (const key of keys) {
      const data = await redis.hget(key, 'data');
      if (data) {
        const spawn = JSON.parse(data);
        const rarity = spawn.rarity || 'common';
        counts[rarity] = (counts[rarity] || 0) + 1;
      }
    }
    
    for (const [rarity, count] of Object.entries(counts)) {
      spawnMetrics.activeSpawns.set({ rarity, biome: 'all' }, count);
    }
  } catch (error) {
    console.error('Failed to update active spawns gauge:', error);
  }
}

/**
 * Record capture event
 */
function recordCapture(pokemonRarity, success) {
  // This would be called from catch-service
  spawnMetrics.despawnCounter.inc({ reason: 'captured' });
  
  // Update capture rate (would need more sophisticated tracking)
  // For now, just increment counter
}

/**
 * Get metrics for Prometheus scrape
 */
function getMetrics() {
  return register.metrics();
}

module.exports = {
  ...spawnMetrics,
  updateActiveSpawnsGauge,
  recordCapture,
  getMetrics
};
