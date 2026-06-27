# REQ-00348: 精灵背包智能整理与自动分类系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00348 |
| 标题 | 精灵背包智能整理与自动分类系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-27 06:00 UTC |

## 需求描述

玩家在捕捉大量精灵后，背包管理变得繁琐。本需求实现精灵背包的智能整理与自动分类系统，通过多维度排序规则、智能分组、一键整理等功能，提升玩家的背包管理体验。

### 核心功能

1. **多维度智能排序**
   - 按战斗力排序（默认）
   - 按 CP 值排序
   - 按捕捉时间排序
   - 按类型（火、水、草等）排序
   - 按稀有度排序
   - 按亲密度/羁绊值排序
   - 按进化潜力排序

2. **智能分组与自动分类**
   - 按精灵类型自动分组（火系、水系、草系等 18 种类型）
   - 按用途分组（战斗、培育、收集、交易）
   - 按稀有度分组（普通、稀有、传说、神话）
   - 自定义分组（玩家自定义标签）

3. **一键智能整理**
   - 根据玩家偏好自动排列精灵
   - 智能推荐最优战斗队伍组合
   - 自动清理低价值精灵（需玩家确认）
   - 批量转移功能

4. **背包容量管理**
   - 实时显示背包使用情况
   - 容量预警提示
   - 快速扩容入口

5. **收藏与锁定保护**
   - 精灵收藏标记功能
   - 锁定精灵防止误操作
   - 收藏精灵优先展示

## 技术方案

### 1. 后端排序与分组引擎

```javascript
// backend/services/pokemon-service/src/inventory/InventorySorter.js
class InventorySorter {
  /**
   * 多维度排序引擎
   * @param {Array} pokemonList - 精灵列表
   * @param {Object} sortOptions - 排序选项
   * @returns {Array} 排序后的精灵列表
   */
  sortPokemon(pokemonList, sortOptions) {
    const {
      primarySort = 'combatPower',    // 主排序字段
      secondarySort = 'rarity',        // 次排序字段
      order = 'desc',                  // 排序方向
      filters = {}                     // 过滤条件
    } = sortOptions;

    // 应用过滤条件
    let filtered = this.applyFilters(pokemonList, filters);

    // 多级排序
    const sortFunctions = {
      combatPower: (p) => p.combatPower,
      cp: (p) => p.cp,
      catchTime: (p) => new Date(p.caughtAt).getTime(),
      type: (p) => p.types[0], // 主类型
      rarity: (p) => this.getRarityScore(p),
      bond: (p) => p.bondLevel || 0,
      evolutionPotential: (p) => this.calculateEvolutionPotential(p)
    };

    filtered.sort((a, b) => {
      let comparison = 0;
      
      // 主排序
      const aValue = sortFunctions[primarySort](a);
      const bValue = sortFunctions[primarySort](b);
      comparison = this.compareValues(aValue, bValue, order);
      
      // 主排序相同则使用次排序
      if (comparison === 0) {
        const aSecond = sortFunctions[secondarySort](a);
        const bSecond = sortFunctions[secondarySort](b);
        comparison = this.compareValues(aSecond, bSecond, order);
      }
      
      return comparison;
    });

    return filtered;
  }

  /**
   * 智能分组
   * @param {Array} pokemonList - 精灵列表
   * @param {string} groupBy - 分组维度
   * @returns {Object} 分组后的精灵对象
   */
  groupPokemon(pokemonList, groupBy) {
    const groups = {};

    switch (groupBy) {
      case 'type':
        // 按18种类型分组
        pokemonList.forEach(pokemon => {
          pokemon.types.forEach(type => {
            if (!groups[type]) groups[type] = [];
            groups[type].push(pokemon);
          });
        });
        break;

      case 'purpose':
        // 按用途分组
        pokemonList.forEach(pokemon => {
          const purpose = this.determinePurpose(pokemon);
          if (!groups[purpose]) groups[purpose] = [];
          groups[purpose].push(pokemon);
        });
        break;

      case 'rarity':
        // 按稀有度分组
        const rarityLevels = ['common', 'uncommon', 'rare', 'legendary', 'mythical'];
        rarityLevels.forEach(level => {
          groups[level] = pokemonList.filter(p => p.rarity === level);
        });
        break;

      case 'custom':
        // 自定义分组（从数据库加载用户标签）
        // 由调用方传入用户自定义分组配置
        break;
    }

    return groups;
  }

  /**
   * 判断精灵用途
   */
  determinePurpose(pokemon) {
    if (pokemon.combatPower >= 3000) return 'battle';
    if (pokemon.bondLevel >= 50) return 'bonding';
    if (pokemon.rarity === 'legendary' || pokemon.rarity === 'mythical') return 'collection';
    return 'trading';
  }

  /**
   * 计算稀有度分数
   */
  getRarityScore(pokemon) {
    const scores = {
      'common': 1,
      'uncommon': 2,
      'rare': 3,
      'legendary': 4,
      'mythical': 5
    };
    return scores[pokemon.rarity] || 0;
  }

  /**
   * 计算进化潜力
   */
  calculateEvolutionPotential(pokemon) {
    // 基于进化阶段、IV值、当前等级计算
    const evolutionStageScore = 3 - pokemon.evolutionStage; // 越早阶段潜力越大
    const ivScore = pokemon.ivTotal / 100;
    const levelScore = (100 - pokemon.level) / 100;
    
    return evolutionStageScore * 0.4 + ivScore * 0.3 + levelScore * 0.3;
  }

  compareValues(a, b, order) {
    if (typeof a === 'string' && typeof b === 'string') {
      const comparison = a.localeCompare(b);
      return order === 'desc' ? -comparison : comparison;
    }
    
    if (a < b) return order === 'desc' ? 1 : -1;
    if (a > b) return order === 'desc' ? -1 : 1;
    return 0;
  }

  applyFilters(pokemonList, filters) {
    let filtered = [...pokemonList];
    
    if (filters.type) {
      filtered = filtered.filter(p => p.types.includes(filters.type));
    }
    if (filters.minCP) {
      filtered = filtered.filter(p => p.cp >= filters.minCP);
    }
    if (filters.maxCP) {
      filtered = filtered.filter(p => p.cp <= filters.maxCP);
    }
    if (filters.rarity) {
      filtered = filtered.filter(p => p.rarity === filters.rarity);
    }
    if (filters.isFavorite !== undefined) {
      filtered = filtered.filter(p => p.isFavorite === filters.isFavorite);
    }
    if (filters.isLocked !== undefined) {
      filtered = filtered.filter(p => p.isLocked === filters.isLocked);
    }
    
    return filtered;
  }
}

module.exports = InventorySorter;
```

### 2. 智能整理建议服务

```javascript
// backend/services/pokemon-service/src/inventory/OrganizationAdvisor.js
class OrganizationAdvisor {
  constructor(prisma, cache) {
    this.prisma = prisma;
    this.cache = cache;
    this.sorter = new InventorySorter();
  }

  /**
   * 生成整理建议
   * @param {string} userId - 用户ID
   * @returns {Object} 整理建议
   */
  async generateOrganizationAdvice(userId) {
    // 从缓存或数据库获取用户精灵列表
    const pokemonList = await this.getUserPokemon(userId);
    
    const advice = {
      recommendedSort: await this.recommendSort(userId, pokemonList),
      duplicates: this.findDuplicates(pokemonList),
      lowValuePokemon: this.identifyLowValuePokemon(pokemonList),
      battleTeamRecommendation: await this.recommendBattleTeam(userId, pokemonList),
      storageUsage: this.calculateStorageUsage(pokemonList)
    };

    return advice;
  }

  /**
   * 推荐排序方式
   */
  async recommendSort(userId, pokemonList) {
    // 分析用户行为偏好
    const userPreference = await this.getUserSortPreference(userId);
    
    if (userPreference) {
      return {
        primarySort: userPreference.primarySort,
        secondarySort: userPreference.secondarySort,
        reason: 'based_on_your_preference'
      };
    }

    // 默认推荐
    return {
      primarySort: 'combatPower',
      secondarySort: 'rarity',
      reason: 'recommended_default'
    };
  }

  /**
   * 查找重复精灵
   */
  findDuplicates(pokemonList) {
    const speciesMap = new Map();
    
    pokemonList.forEach(pokemon => {
      const speciesId = pokemon.speciesId;
      if (!speciesMap.has(speciesId)) {
        speciesMap.set(speciesId, []);
      }
      speciesMap.get(speciesId).push(pokemon);
    });

    const duplicates = [];
    speciesMap.forEach((pokemon, speciesId) => {
      if (pokemon.length > 1) {
        // 找出该物种中价值最低的（建议转移）
        const sorted = this.sorter.sortPokemon(pokemon, {
          primarySort: 'combatPower',
          order: 'asc'
        });
        
        duplicates.push({
          speciesId,
          speciesName: pokemon[0].speciesName,
          count: pokemon.length,
          recommendedKeep: sorted[sorted.length - 1], // 保留最强
          recommendedTransfer: sorted.slice(0, -1)    // 建议转移其余
        });
      }
    });

    return duplicates;
  }

  /**
   * 识别低价值精灵
   */
  identifyLowValuePokemon(pokemonList) {
    return pokemonList.filter(pokemon => {
      // 低价值条件：CP < 500 且 不是收藏 且 不是锁定 且 不是传说/神话
      return pokemon.cp < 500 && 
             !pokemon.isFavorite && 
             !pokemon.isLocked &&
             pokemon.rarity !== 'legendary' &&
             pokemon.rarity !== 'mythical';
    });
  }

  /**
   * 推荐战斗队伍
   */
  async recommendBattleTeam(userId, pokemonList) {
    // 获取用户常用战斗队伍
    const recentTeams = await this.getUserRecentTeams(userId);
    
    // 基于精灵属性克制关系推荐最优队伍
    const topPokemon = this.sorter.sortPokemon(pokemonList, {
      primarySort: 'combatPower',
      order: 'desc'
    }).slice(0, 20);

    // TODO: 实现更复杂的战斗队伍推荐算法
    // 考虑：属性克制、技能搭配、队伍平衡等
    
    return {
      recommended: topPokemon.slice(0, 6),
      alternatives: topPokemon.slice(6, 12),
      strategy: 'highest_cp'
    };
  }

  /**
   * 计算存储使用情况
   */
  calculateStorageUsage(pokemonList) {
    const maxStorage = 300; // TODO: 从用户配置获取
    const used = pokemonList.length;
    const percentage = (used / maxStorage) * 100;

    return {
      used,
      max: maxStorage,
      percentage,
      shouldWarn: percentage >= 80,
      shouldAlert: percentage >= 95
    };
  }

  async getUserPokemon(userId) {
    const cacheKey = `user:${userId}:pokemon:list`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const pokemon = await this.prisma.pokemon.findMany({
      where: { userId, isDeleted: false },
      orderBy: { caughtAt: 'desc' }
    });

    await this.cache.set(cacheKey, pokemon, 300); // 缓存5分钟
    return pokemon;
  }

  async getUserSortPreference(userId) {
    return await this.prisma.userPreference.findUnique({
      where: { userId, key: 'inventory_sort' }
    });
  }

  async getUserRecentTeams(userId) {
    return await this.prisma.battleTeam.findMany({
      where: { userId },
      orderBy: { usedAt: 'desc' },
      take: 5
    });
  }
}

module.exports = OrganizationAdvisor;
```

### 3. API 路由设计

```javascript
// backend/services/pokemon-service/src/routes/inventory.js
const express = require('express');
const router = express.Router();
const InventorySorter = require('../inventory/InventorySorter');
const OrganizationAdvisor = require('../inventory/OrganizationAdvisor');

const sorter = new InventorySorter();
const advisor = new OrganizationAdvisor(prisma, cache);

/**
 * GET /api/pokemon/inventory
 * 获取用户精灵列表（支持排序、分组、过滤）
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      sort = 'combatPower',
      order = 'desc',
      groupBy,
      type,
      minCP,
      maxCP,
      rarity,
      isFavorite,
      isLocked,
      page = 1,
      limit = 30
    } = req.query;

    // 获取用户精灵列表
    let pokemonList = await prisma.pokemon.findMany({
      where: {
        userId,
        isDeleted: false
      }
    });

    // 应用排序
    pokemonList = sorter.sortPokemon(pokemonList, {
      primarySort: sort,
      secondarySort: 'rarity',
      order,
      filters: { type, minCP, maxCP, rarity, isFavorite, isLocked }
    });

    // 应用分组
    let response;
    if (groupBy) {
      const groups = sorter.groupPokemon(pokemonList, groupBy);
      response = { grouped: true, groups, total: pokemonList.length };
    } else {
      // 分页
      const startIndex = (page - 1) * limit;
      const paginatedList = pokemonList.slice(startIndex, startIndex + limit);
      
      response = {
        grouped: false,
        pokemon: paginatedList,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: pokemonList.length,
          totalPages: Math.ceil(pokemonList.length / limit)
        }
      };
    }

    res.json({ success: true, data: response });
  } catch (error) {
    logger.error('Failed to get inventory', { error: error.message });
    res.status(500).json({ success: false, error: 'INVENTORY_FETCH_FAILED' });
  }
});

/**
 * GET /api/pokemon/inventory/advice
 * 获取智能整理建议
 */
router.get('/advice', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const advice = await advisor.generateOrganizationAdvice(userId);
    
    res.json({ success: true, data: advice });
  } catch (error) {
    logger.error('Failed to generate organization advice', { error: error.message });
    res.status(500).json({ success: false, error: 'ADVICE_GENERATION_FAILED' });
  }
});

/**
 * POST /api/pokemon/inventory/favorite
 * 设置/取消收藏
 */
router.post('/favorite', authMiddleware, async (req, res) => {
  try {
    const { pokemonId, isFavorite } = req.body;
    const userId = req.user.id;

    const pokemon = await prisma.pokemon.updateMany({
      where: {
        id: pokemonId,
        userId // 确保只能操作自己的精灵
      },
      data: { isFavorite }
    });

    if (pokemon.count === 0) {
      return res.status(404).json({ success: false, error: 'POKEMON_NOT_FOUND' });
    }

    // 清除缓存
    await cache.del(`user:${userId}:pokemon:list`);

    res.json({ success: true, data: { pokemonId, isFavorite } });
  } catch (error) {
    logger.error('Failed to toggle favorite', { error: error.message });
    res.status(500).json({ success: false, error: 'FAVORITE_UPDATE_FAILED' });
  }
});

/**
 * POST /api/pokemon/inventory/lock
 * 锁定/解锁精灵
 */
router.post('/lock', authMiddleware, async (req, res) => {
  try {
    const { pokemonId, isLocked } = req.body;
    const userId = req.user.id;

    const pokemon = await prisma.pokemon.updateMany({
      where: { id: pokemonId, userId },
      data: { isLocked }
    });

    if (pokemon.count === 0) {
      return res.status(404).json({ success: false, error: 'POKEMON_NOT_FOUND' });
    }

    await cache.del(`user:${userId}:pokemon:list`);

    res.json({ success: true, data: { pokemonId, isLocked } });
  } catch (error) {
    logger.error('Failed to toggle lock', { error: error.message });
    res.status(500).json({ success: false, error: 'LOCK_UPDATE_FAILED' });
  }
});

/**
 * POST /api/pokemon/inventory/batch-transfer
 * 批量转移精灵
 */
router.post('/batch-transfer', authMiddleware, async (req, res) => {
  try {
    const { pokemonIds } = req.body;
    const userId = req.user.id;

    // 检查是否有锁定精灵
    const lockedPokemon = await prisma.pokemon.findMany({
      where: {
        id: { in: pokemonIds },
        userId,
        isLocked: true
      }
    });

    if (lockedPokemon.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'LOCKED_POKEMON_CANNOT_TRANSFER',
        lockedIds: lockedPokemon.map(p => p.id)
      });
    }

    // 执行批量转移
    const result = await prisma.pokemon.updateMany({
      where: {
        id: { in: pokemonIds },
        userId,
        isFavorite: false,
        isLocked: false
      },
      data: { isDeleted: true, deletedAt: new Date() }
    });

    // 给用户发放糖果奖励
    const candyReward = result.count * 1; // 每只精灵1个糖果
    await prisma.userCandy.update({
      where: { userId },
      data: { amount: { increment: candyReward } }
    });

    await cache.del(`user:${userId}:pokemon:list`);

    res.json({
      success: true,
      data: {
        transferred: result.count,
        candyEarned: candyReward
      }
    });
  } catch (error) {
    logger.error('Failed to batch transfer', { error: error.message });
    res.status(500).json({ success: false, error: 'BATCH_TRANSFER_FAILED' });
  }
});

module.exports = router;
```

### 4. 数据库迁移

```sql
-- database/migrations/20260627060000_add_inventory_organization_fields.sql

-- 添加背包整理相关字段
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE;
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS custom_tags TEXT[] DEFAULT '{}';
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS sort_priority INTEGER DEFAULT 0;

-- 创建索引优化查询
CREATE INDEX IF NOT EXISTS idx_pokemon_user_favorite 
  ON pokemon(user_id, is_favorite DESC, combat_power DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_pokemon_user_locked 
  ON pokemon(user_id, is_locked DESC, created_at DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_pokemon_user_type 
  ON pokemon(user_id, types[1])
  WHERE is_deleted = FALSE;

-- 用户偏好表
CREATE TABLE IF NOT EXISTS user_inventory_preferences (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL UNIQUE,
  primary_sort VARCHAR(50) DEFAULT 'combatPower',
  secondary_sort VARCHAR(50) DEFAULT 'rarity',
  sort_order VARCHAR(10) DEFAULT 'desc',
  default_group_by VARCHAR(50),
  custom_groups JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_inventory_preferences_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_inventory_preferences_timestamp
  BEFORE UPDATE ON user_inventory_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_inventory_preferences_timestamp();
```

### 5. 前端 UI 组件

```javascript
// frontend/game-client/src/components/InventoryOrganizer.jsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './InventoryOrganizer.css';

const InventoryOrganizer = ({ pokemonList, onOrganize }) => {
  const { t } = useTranslation();
  const [sortBy, setSortBy] = useState('combatPower');
  const [groupBy, setGroupBy] = useState(null);
  const [filterType, setFilterType] = useState(null);
  const [showAdvice, setShowAdvice] = useState(false);
  const [advice, setAdvice] = useState(null);

  const sortOptions = [
    { value: 'combatPower', label: t('sort.cpower') },
    { value: 'cp', label: t('sort.cp') },
    { value: 'catchTime', label: t('sort.catchTime') },
    { value: 'type', label: t('sort.type') },
    { value: 'rarity', label: t('sort.rarity') },
    { value: 'bond', label: t('sort.bond') },
    { value: 'evolutionPotential', label: t('sort.evolutionPotential') }
  ];

  const groupOptions = [
    { value: null, label: t('group.none') },
    { value: 'type', label: t('group.type') },
    { value: 'purpose', label: t('group.purpose') },
    { value: 'rarity', label: t('group.rarity') }
  ];

  const handleGetAdvice = async () => {
    try {
      const response = await fetch('/api/pokemon/inventory/advice', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      setAdvice(data.data);
      setShowAdvice(true);
    } catch (error) {
      console.error('Failed to get advice:', error);
    }
  };

  const handleQuickSort = (sortType) => {
    setSortBy(sortType);
    onOrganize({ sortBy: sortType, groupBy, filterType });
  };

  return (
    <div className="inventory-organizer">
      <div className="organizer-header">
        <h3>{t('inventory.smartOrganization')}</h3>
        <button className="advice-button" onClick={handleGetAdvice}>
          💡 {t('inventory.getAdvice')}
        </button>
      </div>

      <div className="organizer-controls">
        <div className="control-group">
          <label>{t('inventory.sortBy')}</label>
          <select value={sortBy} onChange={(e) => handleQuickSort(e.target.value)}>
            {sortOptions.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>{t('inventory.groupBy')}</label>
          <select value={groupBy || ''} onChange={(e) => {
            const value = e.target.value || null;
            setGroupBy(value);
            onOrganize({ sortBy, groupBy: value, filterType });
          }}>
            {groupOptions.map(opt => (
              <option key={opt.value || 'none'} value={opt.value || ''}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>{t('inventory.filterType')}</label>
          <select value={filterType || ''} onChange={(e) => {
            const value = e.target.value || null;
            setFilterType(value);
            onOrganize({ sortBy, groupBy, filterType: value });
          }}>
            <option value="">{t('type.all')}</option>
            {['fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark', 'fairy', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'normal'].map(type => (
              <option key={type} value={type}>
                {t(`type.${type}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showAdvice && advice && (
        <div className="advice-panel">
          <h4>{t('inventory.organizationAdvice')}</h4>
          
          {advice.storageUsage.shouldWarn && (
            <div className="warning-banner">
              ⚠️ {t('inventory.storageWarning', { 
                used: advice.storageUsage.used, 
                max: advice.storageUsage.max 
              })}
            </div>
          )}

          {advice.duplicates.length > 0 && (
            <div className="advice-section">
              <h5>{t('inventory.duplicatePokemon')}</h5>
              <p>{t('inventory.duplicateCount', { count: advice.duplicates.length })}</p>
              <button className="action-button">
                {t('inventory.reviewDuplicates')}
              </button>
            </div>
          )}

          {advice.lowValuePokemon.length > 0 && (
            <div className="advice-section">
              <h5>{t('inventory.lowValuePokemon')}</h5>
              <p>{t('inventory.lowValueCount', { count: advice.lowValuePokemon.length })}</p>
              <button className="action-button">
                {t('inventory.reviewLowValue')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default InventoryOrganizer;
```

## 验收标准

- [ ] 用户可以通过多种维度（战斗力、CP、时间、类型、稀有度等）对精灵进行排序
- [ ] 用户可以按类型、用途、稀有度等维度对精灵进行分组展示
- [ ] 系统提供智能整理建议，包括重复精灵识别、低价值精灵筛选
- [ ] 用户可以收藏和锁定精灵，防止误操作
- [ ] 用户可以批量转移精灵（排除收藏和锁定的精灵）
- [ ] 背包容量达到 80% 时显示预警，95% 时显示告警
- [ ] 所有排序和分组操作响应时间 < 500ms
- [ ] 支持用户自定义排序偏好并持久化
- [ ] 前端 UI 提供直观的整理控制面板
- [ ] 移动端适配，支持手势滑动操作

## 影响范围

- `backend/services/pokemon-service/src/routes/inventory.js` - 新增路由
- `backend/services/pokemon-service/src/inventory/InventorySorter.js` - 新增排序引擎
- `backend/services/pokemon-service/src/inventory/OrganizationAdvisor.js` - 新增建议服务
- `database/migrations/20260627060000_add_inventory_organization_fields.sql` - 数据库迁移
- `frontend/game-client/src/components/InventoryOrganizer.jsx` - 前端组件
- `frontend/game-client/src/components/InventoryOrganizer.css` - 样式文件
- `gateway/src/config/routes.js` - 路由配置

## 参考

- [Pokemon GO Inventory Management](https://pokemongohub.net/guide/pokemon-go-inventory-management/)
- [Material Design Data Tables](https://material.io/components/data-tables)
- [Ant Design Table Sorting](https://ant.design/components/table-cn/#components-table-demo-head)
