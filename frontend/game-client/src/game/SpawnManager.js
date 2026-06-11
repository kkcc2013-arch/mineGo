// frontend/game-client/src/game/SpawnManager.js — Spawn Manager for Game Client
'use strict';

/**
 * SpawnManager - Manages pokemon spawns on the game map
 */
class SpawnManager {
  constructor(map, options = {}) {
    this.map = map;
    this.options = {
      updateInterval: 10000, // 10 seconds
      defaultRadius: 500, // meters
      iconBaseUrl: '/assets/pokemon',
      ...options
    };
    
    this.activeSpawns = new Map();
    this.spawnMarkers = new Map();
    this.updateTimer = null;
    this.isUpdating = false;
    
    // Bind methods
    this.update = this.update.bind(this);
  }
  
  /**
   * Start periodic updates
   */
  start() {
    if (this.updateTimer) return;
    
    this.update();
    this.updateTimer = setInterval(this.update, this.options.updateInterval);
    
    console.log('[SpawnManager] Started');
  }
  
  /**
   * Stop updates
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    console.log('[SpawnManager] Stopped');
  }
  
  /**
   * Update spawns near current location
   */
  async update() {
    if (this.isUpdating) return;
    this.isUpdating = true;
    
    try {
      const center = this.map.getCenter();
      const spawns = await this.fetchNearbySpawns(
        center.lat, 
        center.lng, 
        this.options.defaultRadius
      );
      
      this.updateSpawnMarkers(spawns);
    } catch (error) {
      console.error('[SpawnManager] Update failed:', error);
    } finally {
      this.isUpdating = false;
    }
  }
  
  /**
   * Fetch nearby spawns from API
   */
  async fetchNearbySpawns(lat, lng, radius = 500) {
    const response = await fetch(
      `/api/location/nearby-spawns?lat=${lat}&lng=${lng}&radius=${radius}`
    );
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    return data.spawns || [];
  }
  
  /**
   * Update spawn markers on map
   */
  updateSpawnMarkers(spawns) {
    // Remove despawned markers
    for (const [id, marker] of this.spawnMarkers) {
      if (!spawns.find(s => s.id === id)) {
        marker.remove();
        this.spawnMarkers.delete(id);
        this.activeSpawns.delete(id);
      }
    }
    
    // Add new spawns
    for (const spawn of spawns) {
      if (!this.spawnMarkers.has(spawn.id)) {
        this.createSpawnMarker(spawn);
      }
    }
    
    console.log(`[SpawnManager] Updated: ${spawns.length} spawns visible`);
  }
  
  /**
   * Create a marker for a spawn
   */
  createSpawnMarker(spawn) {
    // Create icon based on rarity
    const size = this.getIconSize(spawn.rarity);
    const icon = L.icon({
      iconUrl: `${this.options.iconBaseUrl}/${spawn.pokemonId}.png`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      className: `spawn-marker rarity-${spawn.rarity}`
    });
    
    // Create marker
    const marker = L.marker([spawn.location.lat, spawn.location.lng], { icon });
    
    // Add popup with spawn info
    marker.bindPopup(this.createSpawnPopup(spawn));
    
    // Add despawn timer tooltip
    this.addDespawnTimer(marker, spawn);
    
    // Add click handler
    marker.on('click', () => this.onSpawnClick(spawn));
    
    marker.addTo(this.map);
    
    this.spawnMarkers.set(spawn.id, marker);
    this.activeSpawns.set(spawn.id, spawn);
  }
  
  /**
   * Get icon size based on rarity
   */
  getIconSize(rarity) {
    const sizes = {
      'legendary': 48,
      'very-rare': 44,
      'rare': 40,
      'uncommon': 36,
      'common': 32
    };
    return sizes[rarity] || 32;
  }
  
  /**
   * Create popup content for a spawn
   */
  createSpawnPopup(spawn) {
    const remainingTime = this.formatRemainingTime(spawn.despawnAt);
    const rarityLabel = this.getRarityLabel(spawn.rarity);
    
    return `
      <div class="spawn-popup">
        <h3>${spawn.pokemonName || `Pokemon #${spawn.pokemonId}`}</h3>
        <div class="spawn-info">
          <span class="rarity ${spawn.rarity}">${rarityLabel}</span>
          <span class="cp">CP: ${spawn.cp || '???'}</span>
        </div>
        <div class="spawn-timer">
          ⏱️ ${remainingTime}
        </div>
        <button class="catch-button" onclick="window.catchSpawn('${spawn.id}')">
          捕捉
        </button>
      </div>
    `;
  }
  
  /**
   * Add despawn timer to marker
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
    
    marker.bindTooltip('', { permanent: false });
    updateTimer();
  }
  
  /**
   * Format remaining time
   */
  formatRemainingTime(despawnAt) {
    const remaining = new Date(despawnAt) - new Date();
    
    if (remaining <= 0) return '即将消失';
    
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    
    return `${minutes}分${seconds}秒`;
  }
  
  /**
   * Get rarity label
   */
  getRarityLabel(rarity) {
    const labels = {
      'legendary': '传说',
      'very-rare': '极稀有',
      'rare': '稀有',
      'uncommon': '少见',
      'common': '普通'
    };
    return labels[rarity] || '普通';
  }
  
  /**
   * Handle spawn click
   */
  onSpawnClick(spawn) {
    // Emit event or call callback
    if (this.options.onSpawnClick) {
      this.options.onSpawnClick(spawn);
    }
    
    console.log('[SpawnManager] Spawn clicked:', spawn.id, spawn.pokemonName);
  }
  
  /**
   * Get spawn by ID
   */
  getSpawn(spawnId) {
    return this.activeSpawns.get(spawnId);
  }
  
  /**
   * Get all active spawns
   */
  getAllSpawns() {
    return Array.from(this.activeSpawns.values());
  }
  
  /**
   * Clear all spawns
   */
  clear() {
    for (const marker of this.spawnMarkers.values()) {
      marker.remove();
    }
    
    this.spawnMarkers.clear();
    this.activeSpawns.clear();
    
    console.log('[SpawnManager] Cleared all spawns');
  }
  
  /**
   * Highlight spawns of a specific type
   */
  highlightByRarity(rarity) {
    for (const [id, marker] of this.spawnMarkers) {
      const spawn = this.activeSpawns.get(id);
      if (spawn && spawn.rarity === rarity) {
        marker.getElement().classList.add('highlighted');
      } else {
        marker.getElement().classList.remove('highlighted');
      }
    }
  }
  
  /**
   * Filter spawns by criteria
   */
  filter(predicate) {
    for (const [id, marker] of this.spawnMarkers) {
      const spawn = this.activeSpawns.get(id);
      if (spawn && predicate(spawn)) {
        marker.addTo(this.map);
      } else {
        marker.remove();
      }
    }
  }
  
  /**
   * Show all spawns
   */
  showAll() {
    for (const marker of this.spawnMarkers.values()) {
      marker.addTo(this.map);
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const spawns = Array.from(this.activeSpawns.values());
    
    return {
      total: spawns.length,
      byRarity: spawns.reduce((acc, s) => {
        acc[s.rarity] = (acc[s.rarity] || 0) + 1;
        return acc;
      }, {}),
      avgCP: spawns.length > 0 
        ? Math.floor(spawns.reduce((sum, s) => sum + (s.cp || 0), 0) / spawns.length)
        : 0
    };
  }
}

// Export for use in browser
if (typeof window !== 'undefined') {
  window.SpawnManager = SpawnManager;
  
  // Global catch spawn handler
  window.catchSpawn = function(spawnId) {
    const event = new CustomEvent('catchSpawn', { detail: { spawnId } });
    window.dispatchEvent(event);
  };
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpawnManager;
}
