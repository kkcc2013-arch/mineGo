/**
 * 精灵刷新管理器
 * 负责地图上精灵的显示、更新和消失
 *
 * @module SpawnManager
 */

class SpawnManager {
  constructor(config) {
    this.map = config.map;
    this.apiClient = config.apiClient;

    // 活跃精灵映射
    this.activeSpawns = new Map();
    this.spawnMarkers = new Map();

    // 更新配置
    this.updateInterval = config.updateInterval || 10000; // 10秒
    this.updateTimer = null;

    // 回调函数
    this.onSpawnClick = config.onSpawnClick || null;
    this.onSpawnAppear = config.onSpawnAppear || null;
    this.onSpawnDisappear = config.onSpawnDisappear || null;

    // 地图引用（L = Leaflet）
    this.L = config.Leaflet || window.L;

    this.logger = config.logger || console;
  }

  /**
   * 启动刷新更新循环
   */
  start() {
    this.stop();
    this.updateTimer = setInterval(() => {
      this.updateNearbySpawns();
    }, this.updateInterval);

    // 立即更新一次
    this.updateNearbySpawns();

    this.logger.info('SpawnManager started');
  }

  /**
   * 停止更新循环
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    this.logger.info('SpawnManager stopped');
  }

  /**
   * 更新附近精灵
   */
  async updateNearbySpawns() {
    if (!this.map) {
      this.logger.warn('Map not initialized');
      return;
    }

    const center = this.map.getCenter();
    const radius = 500; // 500米范围

    try {
      const response = await this.apiClient.get('/api/location/nearby-spawns', {
        params: {
          lat: center.lat,
          lng: center.lng,
          radius
        }
      });

      if (response.data && response.data.success) {
        this.updateSpawnMarkers(response.data.spawns);
      }
    } catch (error) {
      this.logger.error('Failed to fetch nearby spawns:', error);
    }
  }

  /**
   * 更新精灵标记
   */
  updateSpawnMarkers(spawns) {
    if (!spawns) spawns = [];

    const currentIds = new Set(spawns.map(s => s.id));

    // 移除已消失的精灵
    for (const [id, marker] of this.spawnMarkers) {
      if (!currentIds.has(id)) {
        this.removeSpawnMarker(id);
      }
    }

    // 添加新精灵
    for (const spawn of spawns) {
      if (!this.spawnMarkers.has(spawn.id)) {
        this.createSpawnMarker(spawn);
      } else {
        // 更新现有标记
        this.updateSpawnMarker(spawn);
      }
    }

    // 更新活跃精灵列表
    this.activeSpawns.clear();
    spawns.forEach(spawn => {
      this.activeSpawns.set(spawn.id, spawn);
    });
  }

  /**
   * 创建精灵标记
   */
  createSpawnMarker(spawn) {
    if (!this.L) {
      this.logger.warn('Leaflet not available');
      return;
    }

    const icon = this.getPokemonIcon(spawn.pokemonId, spawn.rarity);

    const marker = this.L.marker([spawn.location.lat, spawn.location.lng], {
      icon: icon
    });

    // 添加弹出信息
    const popup = this.createSpawnPopup(spawn);
    marker.bindPopup(popup);

    // 添加消失倒计时工具提示
    marker.bindTooltip('', {
      permanent: false,
      direction: 'top'
    });

    // 点击事件
    marker.on('click', () => {
      if (this.onSpawnClick) {
        this.onSpawnClick(spawn);
      }
    });

    // 添加到地图
    marker.addTo(this.map);

    // 存储引用
    this.spawnMarkers.set(spawn.id, marker);

    // 启动消失倒计时
    this.startDespawnTimer(marker, spawn);

    // 触发回调
    if (this.onSpawnAppear) {
      this.onSpawnAppear(spawn);
    }
  }

  /**
   * 更新精灵标记
   */
  updateSpawnMarker(spawn) {
    const marker = this.spawnMarkers.get(spawn.id);
    if (!marker) return;

    // 更新弹出信息
    const popup = this.createSpawnPopup(spawn);
    marker.setPopupContent(popup);
  }

  /**
   * 移除精灵标记
   */
  removeSpawnMarker(spawnId) {
    const marker = this.spawnMarkers.get(spawnId);
    const spawn = this.activeSpawns.get(spawnId);

    if (marker) {
      marker.remove();
      this.spawnMarkers.delete(spawnId);
    }

    if (spawn && this.onSpawnDisappear) {
      this.onSpawnDisappear(spawn);
    }
  }

  /**
   * 创建精灵弹出信息
   */
  createSpawnPopup(spawn) {
    const despawnTime = this.formatDespawnTime(spawn.despawnAt);

    return `
      <div class="spawn-popup">
        <h3>${spawn.pokemonName}</h3>
        <div class="spawn-info">
          <p><strong>等级:</strong> ${spawn.level || '?'}</p>
          <p><strong>CP:</strong> ${spawn.cp || '?'}</p>
          <p><strong>稀有度:</strong> ${this.formatRarity(spawn.rarity)}</p>
          <p><strong>消失时间:</strong> ${despawnTime}</p>
        </div>
        <button onclick="window.catchPokemon('${spawn.id}')" class="catch-btn">
          捕捉
        </button>
      </div>
    `;
  }

  /**
   * 获取精灵图标
   */
  getPokemonIcon(pokemonId, rarity) {
    const sizes = {
      legendary: 56,
      rare: 44,
      common: 32
    };

    const size = sizes[rarity] || 32;

    return this.L.icon({
      iconUrl: `/assets/pokemon/${pokemonId}.png`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
      className: `spawn-marker rarity-${rarity}`
    });
  }

  /**
   * 启动消失倒计时
   */
  startDespawnTimer(marker, spawn) {
    const updateTimer = () => {
      if (!this.spawnMarkers.has(spawn.id)) {
        return; // 标记已被移除
      }

      const remaining = new Date(spawn.despawnAt) - new Date();

      if (remaining <= 0) {
        this.removeSpawnMarker(spawn.id);
        return;
      }

      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);

      marker.setTooltipContent(
        `${minutes}:${seconds.toString().padStart(2, '0')}`
      );

      // 根据剩余时间改变颜色
      if (remaining < 60000) {
        // 1分钟内，显示警告颜色
        marker.getElement()?.classList.add('despawn-warning');
      }

      setTimeout(updateTimer, 1000);
    };

    updateTimer();
  }

  /**
   * 格式化消失时间
   */
  formatDespawnTime(despawnAt) {
    const remaining = new Date(despawnAt) - new Date();

    if (remaining <= 0) {
      return '即将消失';
    }

    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);

    return `${minutes}分${seconds}秒`;
  }

  /**
   * 格式化稀有度
   */
  formatRarity(rarity) {
    const rarityMap = {
      legendary: '传说',
      rare: '稀有',
      common: '普通'
    };
    return rarityMap[rarity] || rarity;
  }

  /**
   * 获取指定精灵
   */
  getSpawn(spawnId) {
    return this.activeSpawns.get(spawnId);
  }

  /**
   * 获取所有活跃精灵
   */
  getAllSpawns() {
    return Array.from(this.activeSpawns.values());
  }

  /**
   * 获取指定稀有度的精灵
   */
  getSpawnsByRarity(rarity) {
    return Array.from(this.activeSpawns.values())
      .filter(spawn => spawn.rarity === rarity);
  }

  /**
   * 获取最近距离的精灵
   */
  getNearestSpawn(maxDistance = 100) {
    if (!this.map) return null;

    const center = this.map.getCenter();
    let nearest = null;
    let minDistance = Infinity;

    for (const spawn of this.activeSpawns.values()) {
      const distance = this.calculateDistance(
        center.lat, center.lng,
        spawn.location.lat, spawn.location.lng
      );

      if (distance < minDistance && distance <= maxDistance) {
        minDistance = distance;
        nearest = spawn;
      }
    }

    return nearest;
  }

  /**
   * 计算两点距离（米）
   */
  calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // 地球半径（米）
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * 角度转弧度
   */
  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 手动刷新精灵列表
   */
  async refresh() {
    await this.updateNearbySpawns();
  }

  /**
   * 清除所有标记
   */
  clear() {
    for (const [id, marker] of this.spawnMarkers) {
      marker.remove();
    }
    this.spawnMarkers.clear();
    this.activeSpawns.clear();
  }

  /**
   * 销毁
   */
  destroy() {
    this.stop();
    this.clear();
    this.map = null;
  }
}

// 导出模块
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpawnManager;
} else if (typeof window !== 'undefined') {
  window.SpawnManager = SpawnManager;
}
