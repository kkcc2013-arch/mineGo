# REQ-00260: 精灵图鉴探索系统与区域收集奖励

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00260 |
| 标题 | 精灵图鉴探索系统与区域收集奖励 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、location-service、reward-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-18 16:00 |

## 需求描述

建立一个深度的精灵图鉴探索系统，让玩家在探索不同地理区域时，能够追踪收集进度并获得区域化奖励。该系统将地理位置、图鉴收集、成就系统结合，增强游戏的探索动力和沉浸感。

### 核心功能
1. **区域图鉴系统** - 将地图划分为不同生态区域，每个区域有独特的精灵分布
2. **探索进度追踪** - 记录玩家在各区域的探索程度和收集进度
3. **区域里程碑奖励** - 达成特定收集目标时发放奖励
4. **稀有度分层** - 区域内精灵按稀有度分类，提供差异化的探索价值
5. **季节性区域变化** - 根据季节动态调整区域精灵分布

## 技术方案

### 1. 数据库设计

```sql
-- 区域定义表
CREATE TABLE exploration_regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  name_i18n JSONB DEFAULT '{}', -- {"en": "Forest Valley", "zh": "森林山谷"}
  description TEXT,
  description_i18n JSONB DEFAULT '{}',
  geo_bounds JSONB NOT NULL, -- {"type": "polygon", "coordinates": [...]}
  region_type VARCHAR(50) NOT NULL, -- forest, desert, ocean, mountain, urban, etc.
  climate VARCHAR(50), -- temperate, tropical, arctic, etc.
  difficulty_level INT DEFAULT 1, -- 1-5
  total_species INT DEFAULT 0,
  icon_url VARCHAR(500),
  banner_url VARCHAR(500),
  is_active BOOLEAN DEFAULT true,
  season_modifiers JSONB DEFAULT '{}', -- {"spring": {"spawn_rate": 1.2}, ...}
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_regions_geo ON exploration_regions USING GIN (geo_bounds);
CREATE INDEX idx_regions_type ON exploration_regions(region_type, is_active);

-- 区域精灵分布表
CREATE TABLE region_pokemon_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id UUID NOT NULL REFERENCES exploration_regions(id) ON DELETE CASCADE,
  pokemon_species_id UUID NOT NULL REFERENCES pokemon_species(id),
  spawn_weight DECIMAL(5,4) DEFAULT 0.01, -- 出现权重 0.0001-1.0000
  rarity_tier VARCHAR(20) NOT NULL, -- common, uncommon, rare, epic, legendary
  spawn_conditions JSONB DEFAULT '{}', -- {"weather": ["sunny", "cloudy"], "time": ["day"]}
  min_level INT DEFAULT 1,
  max_level INT DEFAULT 50,
  is_seasonal BOOLEAN DEFAULT false,
  active_seasons VARCHAR(20)[] DEFAULT '{}', -- ['spring', 'summer', 'fall', 'winter']
  discovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(region_id, pokemon_species_id)
);

CREATE INDEX idx_region_dist_region ON region_pokemon_distributions(region_id);
CREATE INDEX idx_region_dist_species ON region_pokemon_distributions(pokemon_species_id);
CREATE INDEX idx_region_dist_rarity ON region_pokemon_distributions(rarity_tier);

-- 玩家区域探索记录表
CREATE TABLE player_region_explorations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id UUID NOT NULL REFERENCES exploration_regions(id) ON DELETE CASCADE,
  visited_count INT DEFAULT 0,
  first_visit_at TIMESTAMPTZ,
  last_visit_at TIMESTAMPTZ,
  total_catches INT DEFAULT 0,
  unique_species_caught INT DEFAULT 0,
  exploration_percentage DECIMAL(5,2) DEFAULT 0.00,
  stars_earned INT DEFAULT 0, -- 0-5 星评价
  milestones JSONB DEFAULT '{}', -- {"catch_10_species": true, "visit_100_times": true}
  rewards_claimed JSONB DEFAULT '[]', -- [{"milestone": "bronze", "claimed_at": "..."}]
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, region_id)
);

CREATE INDEX idx_player_region_user ON player_region_explorations(user_id);
CREATE INDEX idx_player_region_region ON player_region_explorations(region_id);
CREATE INDEX idx_player_region_progress ON player_region_explorations(exploration_percentage DESC);

-- 玩家区域精灵发现记录表
CREATE TABLE player_region_species_discoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id UUID NOT NULL REFERENCES exploration_regions(id) ON DELETE CASCADE,
  pokemon_species_id UUID NOT NULL REFERENCES pokemon_species(id),
  first_caught_at TIMESTAMPTZ NOT NULL,
  total_caught INT DEFAULT 1,
  best_iv DECIMAL(5,2),
  is_shiny_caught BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, region_id, pokemon_species_id)
);

CREATE INDEX idx_discovery_user_region ON player_region_species_discoveries(user_id, region_id);
CREATE INDEX idx_discovery_species ON player_region_species_discoveries(pokemon_species_id);

-- 区域里程碑定义表
CREATE TABLE region_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id UUID REFERENCES exploration_regions(id) ON DELETE CASCADE, -- NULL = 全局里程碑
  milestone_type VARCHAR(50) NOT NULL, -- bronze, silver, gold, platinum, diamond
  requirement_type VARCHAR(50) NOT NULL, -- species_caught, visits, catches, exploration_percent
  requirement_value INT NOT NULL,
  reward_items JSONB DEFAULT '[]', -- [{"type": "pokeball", "quantity": 10}]
  reward_badge_id UUID REFERENCES badges(id),
  reward_experience INT DEFAULT 0,
  reward_coins INT DEFAULT 0,
  title_i18n JSONB DEFAULT '{}',
  description_i18n JSONB DEFAULT '{}',
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_milestones_region ON region_milestones(region_id);
CREATE INDEX idx_milestones_type ON region_milestones(milestone_type);
```

### 2. 后端服务实现

```javascript
// backend/services/pokemon-service/src/routes/exploration.js

const express = require('express');
const router = express.Router();
const { query, body, param } = require('zod');
const db = require('@pmg/shared/db');
const cache = require('@pmg/shared/cache');
const logger = require('@pmg/shared/logger');
const { emitEvent } = require('@pmg/shared/eventBus');

/**
 * GET /api/pokemon/exploration/regions
 * 获取所有可探索区域列表
 */
router.get('/regions', async (req, res) => {
  try {
    const { lat, lng, radius = 50 } = req.query;
    
    let regions;
    
    if (lat && lng) {
      // 获取用户附近的区域
      regions = await db.query(`
        SELECT 
          r.id, r.name, r.name_i18n, r.description_i18n,
          r.region_type, r.climate, r.difficulty_level,
          r.icon_url, r.total_species,
          ST_Distance(
            ST_MakePoint($2, $1)::geography,
            ST_Centroid(r.geo_bounds::geometry)::geography
          ) / 1000 as distance_km,
          COALESCE(pre.exploration_percentage, 0) as progress,
          COALESCE(pre.stars_earned, 0) as stars
        FROM exploration_regions r
        LEFT JOIN player_region_explorations pre 
          ON r.id = pre.region_id AND pre.user_id = $3
        WHERE r.is_active = true
        ORDER BY distance_km ASC
        LIMIT 20
      `, [parseFloat(lat), parseFloat(lng), req.user.id]);
    } else {
      // 获取所有活跃区域
      regions = await cache.getOrSet(
        `exploration:regions:all`,
        async () => {
          return await db.query(`
            SELECT id, name, name_i18n, description_i18n,
                   region_type, climate, difficulty_level,
                   icon_url, total_species
            FROM exploration_regions
            WHERE is_active = true
            ORDER BY difficulty_level ASC
          `);
        },
        { ttl: 3600 }
      );
    }
    
    res.json({
      success: true,
      data: regions.rows
    });
  } catch (error) {
    logger.error('Failed to fetch regions', { error: error.message });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/pokemon/exploration/regions/:regionId
 * 获取区域详细信息
 */
router.get('/regions/:regionId', async (req, res) => {
  try {
    const { regionId } = req.params;
    
    // 获取区域信息
    const region = await cache.getOrSet(
      `exploration:region:${regionId}`,
      async () => {
        const result = await db.query(`
          SELECT r.*,
                 COUNT(DISTINCT rpd.pokemon_species_id) as available_species,
                 COUNT(CASE WHEN rpd.rarity_tier = 'legendary' THEN 1 END) as legendary_count,
                 COUNT(CASE WHEN rpd.rarity_tier = 'epic' THEN 1 END) as epic_count
          FROM exploration_regions r
          LEFT JOIN region_pokemon_distributions rpd 
            ON r.id = rpd.region_id
          WHERE r.id = $1
          GROUP BY r.id
        `, [regionId]);
        return result.rows[0];
      },
      { ttl: 1800 }
    );
    
    if (!region) {
      return res.status(404).json({ success: false, error: 'REGION_NOT_FOUND' });
    }
    
    // 获取玩家进度
    const progress = await db.query(`
      SELECT * FROM player_region_explorations
      WHERE user_id = $1 AND region_id = $2
    `, [req.user.id, regionId]);
    
    // 获取已发现的精灵
    const discoveries = await db.query(`
      SELECT prsd.*, ps.name, ps.name_i18n, ps.pokedex_number
      FROM player_region_species_discoveries prsd
      JOIN pokemon_species ps ON prsd.pokemon_species_id = ps.id
      WHERE prsd.user_id = $1 AND prsd.region_id = $2
      ORDER BY prsd.first_caught_at DESC
    `, [req.user.id, regionId]);
    
    // 获取里程碑进度
    const milestones = await db.query(`
      SELECT rm.*,
             CASE WHEN prm.id IS NOT NULL THEN true ELSE false END as claimed
      FROM region_milestones rm
      LEFT JOIN player_reward_claims prm 
        ON rm.id = prm.milestone_id AND prm.user_id = $1
      WHERE rm.region_id = $2 OR rm.region_id IS NULL
      ORDER BY rm.display_order ASC
    `, [req.user.id, regionId]);
    
    res.json({
      success: true,
      data: {
        region,
        playerProgress: progress.rows[0] || null,
        discoveries: discoveries.rows,
        milestones: milestones.rows
      }
    });
  } catch (error) {
    logger.error('Failed to fetch region details', { error: error.message });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/pokemon/exploration/regions/:regionId/visit
 * 记录玩家访问区域
 */
router.post('/regions/:regionId/visit', async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { regionId } = req.params;
    const { lat, lng } = req.body;
    
    // 验证用户是否在区域内
    const inRegion = await client.query(`
      SELECT id FROM exploration_regions
      WHERE id = $1 
        AND ST_Contains(
          geo_bounds::geometry,
          ST_MakePoint($3, $2)
        )
    `, [regionId, lng, lat]);
    
    if (inRegion.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'NOT_IN_REGION' 
      });
    }
    
    // 更新或创建探索记录
    const result = await client.query(`
      INSERT INTO player_region_explorations 
        (user_id, region_id, first_visit_at, last_visit_at, visited_count)
      VALUES ($1, $2, NOW(), NOW(), 1)
      ON CONFLICT (user_id, region_id) DO UPDATE SET
        last_visit_at = NOW(),
        visited_count = player_region_explorations.visited_count + 1,
        updated_at = NOW()
      RETURNING *
    `, [req.user.id, regionId]);
    
    // 检查里程碑
    const newMilestones = await checkMilestones(
      client, 
      req.user.id, 
      regionId, 
      result.rows[0]
    );
    
    await client.query('COMMIT');
    
    // 发送事件
    await emitEvent('region.visited', {
      userId: req.user.id,
      regionId,
      visitCount: result.rows[0].visited_count,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      data: {
        exploration: result.rows[0],
        newMilestones
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to record visit', { error: error.message });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/pokemon/exploration/regions/:regionId/claim/:milestoneId
 * 领取里程碑奖励
 */
router.post('/regions/:regionId/claim/:milestoneId', async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { regionId, milestoneId } = req.params;
    
    // 获取里程碑信息
    const milestone = await client.query(`
      SELECT * FROM region_milestones WHERE id = $1
    `, [milestoneId]);
    
    if (milestone.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'MILESTONE_NOT_FOUND' 
      });
    }
    
    // 检查是否已领取
    const claimed = await client.query(`
      SELECT id FROM player_reward_claims
      WHERE user_id = $1 AND milestone_id = $2
    `, [req.user.id, milestoneId]);
    
    if (claimed.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'ALREADY_CLAIMED' 
      });
    });
    
    // 检查是否达成条件
    const progress = await client.query(`
      SELECT * FROM player_region_explorations
      WHERE user_id = $1 AND region_id = $2
    `, [req.user.id, regionId]);
    
    if (!progress.rows[0]) {
      return res.status(400).json({ 
        success: false, 
        error: 'REQUIREMENTS_NOT_MET' 
      });
    }
    
    const playerProgress = progress.rows[0];
    const isMet = checkMilestoneRequirement(milestone.rows[0], playerProgress);
    
    if (!isMet) {
      return res.status(400).json({ 
        success: false, 
        error: 'REQUIREMENTS_NOT_MET' 
      });
    }
    
    // 发放奖励
    const rewards = milestone.rows[0].reward_items;
    await grantRewards(client, req.user.id, rewards);
    
    // 记录领取
    await client.query(`
      INSERT INTO player_reward_claims (user_id, milestone_id, claimed_at)
      VALUES ($1, $2, NOW())
    `, [req.user.id, milestoneId]);
    
    // 更新星星数量
    await client.query(`
      UPDATE player_region_explorations
      SET stars_earned = stars_earned + 1,
          updated_at = NOW()
      WHERE user_id = $1 AND region_id = $2
    `, [req.user.id, regionId]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: {
        rewards,
        milestone: milestone.rows[0]
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to claim milestone', { error: error.message });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/pokemon/exploration/progress
 * 获取玩家全局探索进度统计
 */
router.get('/progress', async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        COUNT(DISTINCT pre.region_id) as regions_visited,
        COUNT(DISTINCT prsd.pokemon_species_id) as total_unique_species,
        SUM(pre.total_catches) as total_catches,
        AVG(pre.exploration_percentage) as avg_exploration,
        SUM(pre.stars_earned) as total_stars,
        COUNT(CASE WHEN pre.exploration_percentage >= 100 THEN 1 END) as completed_regions
      FROM player_region_explorations pre
      LEFT JOIN player_region_species_discoveries prsd 
        ON pre.user_id = prsd.user_id
      WHERE pre.user_id = $1
    `, [req.user.id]);
    
    const recentDiscoveries = await db.query(`
      SELECT ps.name, ps.name_i18n, ps.pokedex_number, 
             prsd.first_caught_at, er.name as region_name
      FROM player_region_species_discoveries prsd
      JOIN pokemon_species ps ON prsd.pokemon_species_id = ps.id
      JOIN exploration_regions er ON prsd.region_id = er.id
      WHERE prsd.user_id = $1
      ORDER BY prsd.first_caught_at DESC
      LIMIT 10
    `, [req.user.id]);
    
    res.json({
      success: true,
      data: {
        stats: stats.rows[0],
        recentDiscoveries: recentDiscoveries.rows
      }
    });
  } catch (error) {
    logger.error('Failed to fetch progress', { error: error.message });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

// 辅助函数
async function checkMilestones(client, userId, regionId, progress) {
  const milestones = await client.query(`
    SELECT rm.*,
           CASE WHEN prm.id IS NOT NULL THEN true ELSE false END as claimed
    FROM region_milestones rm
    LEFT JOIN player_reward_claims prm 
      ON rm.id = prm.milestone_id AND prm.user_id = $1
    WHERE (rm.region_id = $2 OR rm.region_id IS NULL)
      AND prm.id IS NULL
  `, [userId, regionId]);
  
  const newMilestones = [];
  
  for (const milestone of milestones.rows) {
    if (checkMilestoneRequirement(milestone, progress)) {
      newMilestones.push(milestone);
    }
  }
  
  return newMilestones;
}

function checkMilestoneRequirement(milestone, progress) {
  const { requirement_type, requirement_value } = milestone;
  
  switch (requirement_type) {
    case 'species_caught':
      return progress.unique_species_caught >= requirement_value;
    case 'visits':
      return progress.visited_count >= requirement_value;
    case 'catches':
      return progress.total_catches >= requirement_value;
    case 'exploration_percent':
      return progress.exploration_percentage >= requirement_value;
    default:
      return false;
  }
}

async function grantRewards(client, userId, rewards) {
  for (const reward of rewards) {
    switch (reward.type) {
      case 'coins':
        await client.query(`
          UPDATE users SET coins = coins + $2 WHERE id = $1
        `, [userId, reward.quantity]);
        break;
      case 'experience':
        await client.query(`
          UPDATE users SET experience = experience + $2 WHERE id = $1
        `, [userId, reward.quantity]);
        break;
      case 'pokeball':
      case 'potion':
        await client.query(`
          INSERT INTO user_items (user_id, item_type, quantity)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, item_type) DO UPDATE SET
            quantity = user_items.quantity + $3
        `, [userId, reward.type, reward.quantity]);
        break;
    }
  }
}

module.exports = router;
```

### 3. 区域计算服务

```javascript
// backend/services/location-service/src/regionResolver.js

const db = require('@pmg/shared/db');
const cache = require('@pmg/shared/cache');
const logger = require('@pmg/shared/logger');

class RegionResolver {
  constructor() {
    this.regionCache = new Map();
    this.lastRefresh = 0;
    this.cacheTTL = 60000; // 1 minute
  }
  
  /**
   * 根据坐标获取所在区域
   */
  async getRegionByCoords(lat, lng) {
    await this.refreshCacheIfNeeded();
    
    const point = { lat, lng };
    
    for (const [regionId, region] of this.regionCache) {
      if (this.isPointInRegion(point, region)) {
        return region;
      }
    }
    
    return null;
  }
  
  /**
   * 获取附近的区域列表
   */
  async getNearbyRegions(lat, lng, radiusKm = 50) {
    const result = await db.query(`
      SELECT 
        id, name, name_i18n, region_type, climate,
        difficulty_level, icon_url, total_species,
        ST_Distance(
          ST_MakePoint($2, $1)::geography,
          ST_Centroid(geo_bounds::geometry)::geography
        ) / 1000 as distance_km
      FROM exploration_regions
      WHERE is_active = true
        AND ST_DWithin(
          geo_bounds::geography,
          ST_MakePoint($2, $1)::geography,
          $3 * 1000
        )
      ORDER BY distance_km ASC
      LIMIT 10
    `, [lat, lng, radiusKm]);
    
    return result.rows;
  }
  
  /**
   * 判断点是否在区域内
   */
  isPointInRegion(point, region) {
    const bounds = region.geo_bounds;
    
    if (bounds.type === 'polygon') {
      return this.pointInPolygon(point, bounds.coordinates[0]);
    }
    
    if (bounds.type === 'circle') {
      const center = bounds.center;
      const radius = bounds.radius_km;
      const distance = this.haversineDistance(
        point.lat, point.lng,
        center[1], center[0]
      );
      return distance <= radius;
    }
    
    return false;
  }
  
  /**
   * 射线法判断点是否在多边形内
   */
  pointInPolygon(point, polygon) {
    let inside = false;
    const x = point.lng;
    const y = point.lat;
    
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      
      const intersect = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      
      if (intersect) inside = !inside;
    }
    
    return inside;
  }
  
  /**
   * 计算两点间的 Haversine 距离（公里）
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  toRad(deg) {
    return deg * Math.PI / 180;
  }
  
  /**
   * 刷新区域缓存
   */
  async refreshCacheIfNeeded() {
    const now = Date.now();
    if (now - this.lastRefresh > this.cacheTTL) {
      await this.refreshCache();
      this.lastRefresh = now;
    }
  }
  
  async refreshCache() {
    try {
      const result = await db.query(`
        SELECT id, name, name_i18n, region_type, geo_bounds
        FROM exploration_regions
        WHERE is_active = true
      `);
      
      this.regionCache.clear();
      for (const row of result.rows) {
        this.regionCache.set(row.id, row);
      }
      
      logger.info('Region cache refreshed', { 
        count: this.regionCache.size 
      });
    } catch (error) {
      logger.error('Failed to refresh region cache', { 
        error: error.message 
      });
    }
  }
}

module.exports = new RegionResolver();
```

### 4. 前端组件

```javascript
// frontend/game-client/src/components/ExplorationMap.js

import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polygon, Circle } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import { useGeolocation } from '../hooks/useGeolocation';
import { api } from '../services/api';
import './ExplorationMap.css';

export default function ExplorationMap() {
  const { t, i18n } = useTranslation();
  const { position, loading: geoLoading } = useGeolocation();
  const [regions, setRegions] = useState([]);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    if (position) {
      loadNearbyRegions();
    }
  }, [position]);
  
  const loadNearbyRegions = async () => {
    try {
      setLoading(true);
      const response = await api.get('/pokemon/exploration/regions', {
        params: {
          lat: position[0],
          lng: position[1],
          radius: 100
        }
      });
      setRegions(response.data.data);
    } catch (error) {
      console.error('Failed to load regions:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const handleRegionClick = async (region) => {
    try {
      const response = await api.get(
        `/pokemon/exploration/regions/${region.id}`
      );
      setSelectedRegion(response.data.data.region);
      setProgress(response.data.data.playerProgress);
    } catch (error) {
      console.error('Failed to load region details:', error);
    }
  };
  
  const getRegionColor = (region) => {
    const colors = {
      forest: '#228B22',
      desert: '#DAA520',
      ocean: '#1E90FF',
      mountain: '#8B4513',
      urban: '#708090',
      cave: '#2F4F4F',
      swamp: '#556B2F',
      tundra: '#B0C4DE'
    };
    return colors[region.region_type] || '#808080';
  };
  
  const getRarityColor = (rarity) => {
    const colors = {
      common: '#9CA3AF',
      uncommon: '#10B981',
      rare: '#3B82F6',
      epic: '#8B5CF6',
      legendary: '#F59E0B'
    };
    return colors[rarity] || '#9CA3AF';
  };
  
  const formatProgress = (value) => {
    return `${Math.round(value)}%`;
  };
  
  if (geoLoading || loading) {
    return (
      <div className="exploration-loading">
        <div className="spinner"></div>
        <p>{t('exploration.loading')}</p>
      </div>
    );
  }
  
  return (
    <div className="exploration-container">
      <div className="exploration-sidebar">
        <h2>{t('exploration.title')}</h2>
        
        <div className="regions-list">
          {regions.map(region => (
            <div
              key={region.id}
              className={`region-card ${selectedRegion?.id === region.id ? 'active' : ''}`}
              onClick={() => handleRegionClick(region)}
            >
              <div 
                className="region-icon"
                style={{ backgroundColor: getRegionColor(region) }}
              >
                <img src={region.icon_url} alt="" />
              </div>
              
              <div className="region-info">
                <h3>{region.name_i18n[i18n.language] || region.name}</h3>
                <p className="region-type">{t(`exploration.types.${region.region_type}`)}</p>
                <div className="progress-bar">
                  <div 
                    className="progress-fill"
                    style={{ width: `${region.progress || 0}%` }}
                  />
                </div>
                <span className="progress-text">
                  {formatProgress(region.progress || 0)}
                </span>
              </div>
              
              <div className="region-stars">
                {'⭐'.repeat(region.stars || 0)}
              </div>
            </div>
          ))}
        </div>
        
        {selectedRegion && (
          <div className="region-details">
            <h3>{selectedRegion.name_i18n[i18n.language] || selectedRegion.name}</h3>
            
            <div className="region-stats">
              <div className="stat">
                <span className="stat-label">{t('exploration.species')}</span>
                <span className="stat-value">
                  {progress?.unique_species_caught || 0} / {selectedRegion.available_species}
                </span>
              </div>
              
              <div className="stat">
                <span className="stat-label">{t('exploration.visits')}</span>
                <span className="stat-value">{progress?.visited_count || 0}</span>
              </div>
              
              <div className="stat">
                <span className="stat-label">{t('exploration.catches')}</span>
                <span className="stat-value">{progress?.total_catches || 0}</span>
              </div>
            </div>
            
            <button 
              className="explore-button"
              onClick={() => visitRegion(selectedRegion.id)}
            >
              {t('exploration.explore')}
            </button>
          </div>
        )}
      </div>
      
      <div className="exploration-map">
        <MapContainer
          center={position || [0, 0]}
          zoom={14}
          className="map-container"
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="© OpenStreetMap"
          />
          
          {position && (
            <Marker position={position}>
              <Popup>{t('exploration.yourLocation')}</Popup>
            </Marker>
          )}
          
          {regions.map(region => {
            if (region.geo_bounds?.type === 'polygon') {
              return (
                <Polygon
                  key={region.id}
                  positions={region.geo_bounds.coordinates[0].map(c => [c[1], c[0]])}
                  pathOptions={{
                    color: getRegionColor(region),
                    fillOpacity: 0.2
                  }}
                  eventHandlers={{
                    click: () => handleRegionClick(region)
                  }}
                >
                  <Popup>
                    <strong>{region.name_i18n[i18n.language] || region.name}</strong>
                    <br />
                    {formatProgress(region.progress || 0)} {t('exploration.explored')}
                  </Popup>
                </Polygon>
              );
            }
            
            if (region.geo_bounds?.type === 'circle') {
              return (
                <Circle
                  key={region.id}
                  center={[
                    region.geo_bounds.center[1],
                    region.geo_bounds.center[0]
                  ]}
                  radius={region.geo_bounds.radius_km * 1000}
                  pathOptions={{
                    color: getRegionColor(region),
                    fillOpacity: 0.2
                  }}
                  eventHandlers={{
                    click: () => handleRegionClick(region)
                  }}
                >
                  <Popup>
                    <strong>{region.name_i18n[i18n.language] || region.name}</strong>
                    <br />
                    {formatProgress(region.progress || 0)} {t('exploration.explored')}
                  </Popup>
                </Circle>
              );
            }
            
            return null;
          })}
        </MapContainer>
      </div>
    </div>
  );
}
```

### 5. 缓存预热 Job

```javascript
// backend/jobs/explorationCacheWarmer.js

const db = require('@pmg/shared/db');
const cache = require('@pmg/shared/cache');
const logger = require('@pmg/shared/logger');

class ExplorationCacheWarmer {
  async run() {
    logger.info('Starting exploration cache warmer');
    
    try {
      // 预热区域数据
      await this.warmRegions();
      
      // 预热稀有度分布统计
      await this.warmRarityStats();
      
      // 预热热门区域
      await this.warmPopularRegions();
      
      logger.info('Exploration cache warmer completed');
    } catch (error) {
      logger.error('Exploration cache warmer failed', { 
        error: error.message 
      });
    }
  }
  
  async warmRegions() {
    const regions = await db.query(`
      SELECT r.*,
             COUNT(DISTINCT rpd.pokemon_species_id) as available_species
      FROM exploration_regions r
      LEFT JOIN region_pokemon_distributions rpd ON r.id = rpd.region_id
      WHERE r.is_active = true
      GROUP BY r.id
    `);
    
    for (const region of regions.rows) {
      await cache.set(`exploration:region:${region.id}`, region, {
        ttl: 7200 // 2 hours
      });
    }
    
    logger.info('Warmed regions', { count: regions.rows.length });
  }
  
  async warmRarityStats() {
    const stats = await db.query(`
      SELECT 
        region_id,
        rarity_tier,
        COUNT(*) as count
      FROM region_pokemon_distributions
      GROUP BY region_id, rarity_tier
    `);
    
    const grouped = {};
    for (const row of stats.rows) {
      if (!grouped[row.region_id]) {
        grouped[row.region_id] = {};
      }
      grouped[row.region_id][row.rarity_tier] = parseInt(row.count);
    }
    
    for (const [regionId, rarities] of Object.entries(grouped)) {
      await cache.set(`exploration:region:${regionId}:rarities`, rarities, {
        ttl: 3600
      });
    }
    
    logger.info('Warmed rarity stats');
  }
  
  async warmPopularRegions() {
    const popular = await db.query(`
      SELECT r.id, r.name, r.name_i18n,
             COUNT(pre.id) as visitor_count
      FROM exploration_regions r
      LEFT JOIN player_region_explorations pre ON r.id = pre.region_id
      WHERE r.is_active = true
      GROUP BY r.id
      ORDER BY visitor_count DESC
      LIMIT 10
    `);
    
    await cache.set('exploration:regions:popular', popular.rows, {
      ttl: 1800
    });
    
    logger.info('Warmed popular regions');
  }
}

// 作为定时任务运行
if (require.main === module) {
  const warmer = new ExplorationCacheWarmer();
  warmer.run().then(() => process.exit(0));
}

module.exports = ExplorationCacheWarmer;
```

## 验收标准

- [ ] 区域图鉴数据库表已创建并正常工作
- [ ] GET /api/pokemon/exploration/regions 接口返回区域列表
- [ ] GET /api/pokemon/exploration/regions/:id 接口返回区域详情和进度
- [ ] POST /api/pokemon/exploration/regions/:id/visit 接口记录访问
- [ ] POST /api/pokemon/exploration/regions/:id/claim/:milestoneId 接口发放奖励
- [ ] 区域边界判断逻辑正确（支持多边形和圆形）
- [ ] 里程碑达成条件检查正确
- [ ] 奖励发放逻辑正确（金币、经验、道具）
- [ ] 前端地图组件显示区域边界
- [ ] 前端侧边栏显示探索进度
- [ ] 缓存预热 Job 按计划运行
- [ ] 多语言支持正常（区域名称、描述）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证完整流程

## 影响范围

- **数据库**：新增 5 张表（exploration_regions、region_pokemon_distributions、player_region_explorations、player_region_species_discoveries、region_milestones）
- **pokemon-service**：新增 /api/pokemon/exploration 路由
- **location-service**：新增 RegionResolver 服务
- **reward-service**：新增里程碑奖励类型处理
- **user-service**：新增探索相关统计字段
- **game-client**：新增 ExplorationMap 组件
- **缓存**：区域数据缓存预热策略

## 参考

- PostgreSQL PostGIS 地理空间查询文档
- Leaflet.js 地图库文档
- React-Leaflet 组件库
- Haversine 公式计算距离
- 射线法（Ray Casting）多边形判断算法
