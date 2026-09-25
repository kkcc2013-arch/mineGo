# REQ-00403: 精灵收藏室与个性化展示系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00403 |
| 标题 | 精灵收藏室与个性化展示系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | pokemon-service、user-service、social-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-07-01 02:00 UTC |

## 需求描述

为资深玩家提供专属的精灵收藏室功能，允许玩家：
1. **收藏管理**：将珍稀精灵、特殊个体值精灵、活动限定精灵添加到收藏室进行展示
2. **个性化布局**：自由排列收藏室内的精灵位置，支持多种展示主题和背景
3. **社交展示**：好友和访客可以查看玩家的收藏室，点赞和评论
4. **收藏成就**：解锁收藏室专属成就和徽章
5. **收藏统计**：展示收藏数量、稀有度分布、图鉴完成度等统计数据

## 技术方案

### 1. 数据模型设计

```sql
-- 收藏室主表
CREATE TABLE collection_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_name VARCHAR(100) DEFAULT 'My Collection',
  theme_id VARCHAR(50) DEFAULT 'default',
  background_id VARCHAR(50) DEFAULT 'classic',
  layout_config JSONB DEFAULT '{}',
  is_public BOOLEAN DEFAULT true,
  visitor_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 收藏室物品表
CREATE TABLE collection_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  position_z INTEGER DEFAULT 0,
  scale FLOAT DEFAULT 1.0,
  rotation FLOAT DEFAULT 0,
  display_mode VARCHAR(20) DEFAULT 'default', -- default, shiny, 3d, card
  sort_order INTEGER DEFAULT 0,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, pokemon_id)
);

-- 收藏室访客记录
CREATE TABLE collection_visitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  visitor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visited_at TIMESTAMPTZ DEFAULT NOW(),
  duration_seconds INTEGER DEFAULT 0,
  UNIQUE(room_id, visitor_id, DATE(visited_at))
);

-- 收藏室点赞表
CREATE TABLE collection_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- 收藏室评论表
CREATE TABLE collection_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_deleted BOOLEAN DEFAULT false
);

-- 主题配置表
CREATE TABLE collection_themes (
  id VARCHAR(50) PRIMARY KEY,
  name_key VARCHAR(100) NOT NULL,
  description_key VARCHAR(200),
  preview_image VARCHAR(255),
  unlock_condition JSONB DEFAULT '{}',
  is_premium BOOLEAN DEFAULT false,
  price_coins INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 背景配置表
CREATE TABLE collection_backgrounds (
  id VARCHAR(50) PRIMARY KEY,
  name_key VARCHAR(100) NOT NULL,
  description_key VARCHAR(200),
  preview_image VARCHAR(255),
  background_image VARCHAR(255),
  unlock_condition JSONB DEFAULT '{}',
  is_premium BOOLEAN DEFAULT false,
  price_coins INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_collection_rooms_user ON collection_rooms(user_id);
CREATE INDEX idx_collection_items_room ON collection_items(room_id);
CREATE INDEX idx_collection_items_pokemon ON collection_items(pokemon_id);
CREATE INDEX idx_collection_visitors_room ON collection_visitors(room_id);
CREATE INDEX idx_collection_likes_room ON collection_likes(room_id);
CREATE INDEX idx_collection_comments_room ON collection_comments(room_id);
```

### 2. pokemon-service 收藏室核心模块

```javascript
// backend/services/pokemon-service/src/modules/CollectionRoom.js
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../shared/logger');

class CollectionRoomManager {
  constructor(db, redis, eventBus) {
    this.db = db;
    this.redis = redis;
    this.eventBus = eventBus;
    
    // 收藏室缓存
    this.cachePrefix = 'collection:room:';
    this.cacheTTL = 300; // 5分钟缓存
  }

  /**
   * 获取或创建用户收藏室
   */
  async getOrCreateRoom(userId) {
    const cacheKey = this.cachePrefix + userId;
    
    // 尝试从缓存获取
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // 查询数据库
    let room = await this.db.query(
      `SELECT cr.*, 
        COUNT(ci.id) as item_count,
        COUNT(CASE WHEN p.is_shiny THEN 1 END) as shiny_count
       FROM collection_rooms cr
       LEFT JOIN collection_items ci ON ci.room_id = cr.id
       LEFT JOIN pokemons p ON p.id = ci.pokemon_id
       WHERE cr.user_id = $1
       GROUP BY cr.id`,
      [userId]
    );

    if (room.rows.length === 0) {
      // 创建默认收藏室
      const createResult = await this.db.query(
        `INSERT INTO collection_rooms (user_id)
         VALUES ($1)
         RETURNING *`,
        [userId]
      );
      room = { rows: [{ ...createResult.rows[0], item_count: 0, shiny_count: 0 }] };
      
      logger.info({ module: 'CollectionRoom', userId }, 'Created new collection room');
    }

    // 缓存结果
    await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(room.rows[0]));
    
    return room.rows[0];
  }

  /**
   * 添加精灵到收藏室
   */
  async addPokemon(userId, pokemonId, position = { x: 0, y: 0 }) {
    // 验证精灵所有权
    const pokemon = await this.db.query(
      `SELECT id, species_id, is_shiny, iv_total FROM pokemons 
       WHERE id = $1 AND owner_id = $2`,
      [pokemonId, userId]
    );

    if (pokemon.rows.length === 0) {
      throw new Error('Pokemon not found or not owned');
    }

    const room = await this.getOrCreateRoom(userId);

    // 检查收藏上限（默认50只）
    const countResult = await this.db.query(
      `SELECT COUNT(*) as count FROM collection_items WHERE room_id = $1`,
      [room.id]
    );

    if (parseInt(countResult.rows[0].count) >= 50) {
      throw new Error('Collection room is full');
    }

    // 添加到收藏室
    const result = await this.db.query(
      `INSERT INTO collection_items (room_id, pokemon_id, position_x, position_y)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [room.id, pokemonId, position.x, position.y]
    );

    // 清除缓存
    await this.redis.del(this.cachePrefix + userId);

    // 发布事件
    await this.eventBus.publish('collection.item.added', {
      userId,
      pokemonId,
      roomId: room.id,
      pokemon: pokemon.rows[0]
    });

    logger.info({
      module: 'CollectionRoom',
      userId,
      pokemonId,
      roomId: room.id
    }, 'Pokemon added to collection room');

    return result.rows[0];
  }

  /**
   * 更新精灵位置
   */
  async updatePosition(userId, pokemonId, position) {
    const room = await this.getOrCreateRoom(userId);

    const result = await this.db.query(
      `UPDATE collection_items 
       SET position_x = $1, position_y = $2, position_z = $3,
           scale = $4, rotation = $5
       WHERE room_id = $6 AND pokemon_id = $7
       RETURNING *`,
      [position.x, position.y, position.z || 0, position.scale || 1.0, position.rotation || 0,
       room.id, pokemonId]
    );

    if (result.rows.length === 0) {
      throw new Error('Item not found in collection');
    }

    await this.redis.del(this.cachePrefix + userId);
    
    return result.rows[0];
  }

  /**
   * 从收藏室移除精灵
   */
  async removePokemon(userId, pokemonId) {
    const room = await this.getOrCreateRoom(userId);

    const result = await this.db.query(
      `DELETE FROM collection_items 
       WHERE room_id = $1 AND pokemon_id = $2
       RETURNING *`,
      [room.id, pokemonId]
    );

    if (result.rows.length === 0) {
      throw new Error('Item not found in collection');
    }

    await this.redis.del(this.cachePrefix + userId);

    await this.eventBus.publish('collection.item.removed', {
      userId,
      pokemonId,
      roomId: room.id
    });

    return { success: true };
  }

  /**
   * 更新收藏室主题
   */
  async updateTheme(userId, themeId) {
    // 验证主题是否可用
    const theme = await this.db.query(
      `SELECT * FROM collection_themes WHERE id = $1`,
      [themeId]
    );

    if (theme.rows.length === 0) {
      throw new Error('Theme not found');
    }

    // 检查解锁条件
    await this.checkUnlockCondition(userId, theme.rows[0]);

    await this.db.query(
      `UPDATE collection_rooms SET theme_id = $1, updated_at = NOW() WHERE user_id = $2`,
      [themeId, userId]
    );

    await this.redis.del(this.cachePrefix + userId);

    return { themeId };
  }

  /**
   * 获取收藏室详情（带物品列表）
   */
  async getRoomDetail(userId, viewerId = null) {
    const room = await this.getOrCreateRoom(userId);

    // 获取收藏物品
    const items = await this.db.query(
      `SELECT ci.*, p.species_id, p.nickname, p.level, p.is_shiny, 
        p.iv_attack, p.iv_defense, p.iv_stamina, p.iv_total,
        ps.name as species_name, ps.types, ps.rarity
       FROM collection_items ci
       JOIN pokemons p ON p.id = ci.pokemon_id
       JOIN pokemon_species ps ON ps.id = p.species_id
       WHERE ci.room_id = $1
       ORDER BY ci.sort_order, ci.added_at DESC`,
      [room.id]
    );

    // 如果有访客，记录访问
    if (viewerId && viewerId !== userId) {
      await this.recordVisit(room.id, viewerId);
    }

    return {
      room,
      items: items.rows,
      isOwner: viewerId === userId
    };
  }

  /**
   * 记录访客访问
   */
  async recordVisit(roomId, visitorId) {
    await this.db.query(
      `INSERT INTO collection_visitors (room_id, visitor_id)
       VALUES ($1, $2)
       ON CONFLICT (room_id, visitor_id, DATE(visited_at)) 
       DO UPDATE SET visited_at = NOW()
       RETURNING *`,
      [roomId, visitorId]
    );

    // 更新访客计数
    await this.db.query(
      `UPDATE collection_rooms SET visitor_count = visitor_count + 1 WHERE id = $1`,
      [roomId]
    );
  }

  /**
   * 点赞收藏室
   */
  async toggleLike(userId, roomId) {
    const existing = await this.db.query(
      `SELECT id FROM collection_likes WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId]
    );

    if (existing.rows.length > 0) {
      // 取消点赞
      await this.db.query(
        `DELETE FROM collection_likes WHERE room_id = $1 AND user_id = $2`,
        [roomId, userId]
      );
      await this.db.query(
        `UPDATE collection_rooms SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1`,
        [roomId]
      );
      return { liked: false };
    } else {
      // 添加点赞
      await this.db.query(
        `INSERT INTO collection_likes (room_id, user_id) VALUES ($1, $2)`,
        [roomId, userId]
      );
      await this.db.query(
        `UPDATE collection_rooms SET like_count = like_count + 1 WHERE id = $1`,
        [roomId]
      );

      // 发布通知
      await this.eventBus.publish('collection.liked', { roomId, userId });
      
      return { liked: true };
    }
  }

  /**
   * 获取收藏室排行榜
   */
  async getLeaderboard(type = 'likes', limit = 100) {
    const orderBy = type === 'likes' ? 'like_count' : 'visitor_count';
    
    const result = await this.db.query(
      `SELECT cr.id, cr.user_id, u.username, cr.room_name, cr.theme_id,
        cr.like_count, cr.visitor_count, COUNT(ci.id) as item_count
       FROM collection_rooms cr
       JOIN users u ON u.id = cr.user_id
       LEFT JOIN collection_items ci ON ci.room_id = cr.id
       WHERE cr.is_public = true
       GROUP BY cr.id, u.id
       ORDER BY ${orderBy} DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }

  /**
   * 检查解锁条件
   */
  async checkUnlockCondition(userId, item) {
    if (!item.unlock_condition || Object.keys(item.unlock_condition).length === 0) {
      return true;
    }

    const condition = item.unlock_condition;

    // 检查图鉴完成度
    if (condition.pokedex_completion) {
      const pokedex = await this.db.query(
        `SELECT COUNT(DISTINCT species_id)::FLOAT / 
          (SELECT COUNT(*) FROM pokemon_species) as completion
         FROM pokemons WHERE owner_id = $1`,
        [userId]
      );
      if (pokedex.rows[0].completion < condition.pokedex_completion) {
        throw new Error('Pokedex completion requirement not met');
      }
    }

    // 检查等级要求
    if (condition.min_level) {
      const user = await this.db.query(
        `SELECT level FROM users WHERE id = $1`, [userId]
      );
      if (user.rows[0].level < condition.min_level) {
        throw new Error('Level requirement not met');
      }
    }

    return true;
  }
}

module.exports = CollectionRoomManager;
```

### 3. API 路由设计

```javascript
// backend/services/pokemon-service/routes/collection.js
const express = require('express');
const router = express.Router();
const CollectionRoomManager = require('../modules/CollectionRoom');
const auth = require('../../../shared/auth');

// 获取用户收藏室
router.get('/room/:userId?', auth.optional, async (req, res) => {
  const targetUserId = req.params.userId || req.user.id;
  const viewerId = req.user?.id;
  
  const room = await collectionManager.getRoomDetail(targetUserId, viewerId);
  
  res.json({
    success: true,
    data: room
  });
});

// 添加精灵到收藏室
router.post('/room/items', auth.required, async (req, res) => {
  const { pokemonId, position } = req.body;
  
  const item = await collectionManager.addPokemon(
    req.user.id,
    pokemonId,
    position
  );
  
  res.json({
    success: true,
    data: item
  });
});

// 更新精灵位置
router.put('/room/items/:pokemonId/position', auth.required, async (req, res) => {
  const { pokemonId } = req.params;
  const position = req.body;
  
  const item = await collectionManager.updatePosition(
    req.user.id,
    pokemonId,
    position
  );
  
  res.json({
    success: true,
    data: item
  });
});

// 移除精灵
router.delete('/room/items/:pokemonId', auth.required, async (req, res) => {
  const { pokemonId } = req.params;
  
  await collectionManager.removePokemon(req.user.id, pokemonId);
  
  res.json({
    success: true
  });
});

// 更新收藏室主题
router.put('/room/theme', auth.required, async (req, res) => {
  const { themeId } = req.body;
  
  await collectionManager.updateTheme(req.user.id, themeId);
  
  res.json({
    success: true
  });
});

// 点赞/取消点赞
router.post('/room/:roomId/like', auth.required, async (req, res) => {
  const { roomId } = req.params;
  
  const result = await collectionManager.toggleLike(req.user.id, roomId);
  
  res.json({
    success: true,
    data: result
  });
});

// 获取排行榜
router.get('/leaderboard', async (req, res) => {
  const { type, limit } = req.query;
  
  const leaderboard = await collectionManager.getLeaderboard(
    type || 'likes',
    parseInt(limit) || 100
  );
  
  res.json({
    success: true,
    data: leaderboard
  });
});

// 获取可用主题列表
router.get('/themes', async (req, res) => {
  const themes = await db.query(
    `SELECT * FROM collection_themes ORDER BY name_key`
  );
  
  res.json({
    success: true,
    data: themes.rows
  });
});

// 获取可用背景列表
router.get('/backgrounds', async (req, res) => {
  const backgrounds = await db.query(
    `SELECT * FROM collection_backgrounds ORDER BY name_key`
  );
  
  res.json({
    success: true,
    data: backgrounds.rows
  });
});

module.exports = router;
```

### 4. 前端收藏室 UI 组件

```javascript
// frontend/game-client/src/components/CollectionRoom.js
import React, { useState, useEffect } from 'react';
import { Grid, DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
import { Sprite, Container, Text, Graphics } from '@inlet/react-pixi';

const CollectionRoom = ({ userId, isOwner = false }) => {
  const [room, setRoom] = useState(null);
  const [items, setItems] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [theme, setTheme] = useState('default');
  
  useEffect(() => {
    fetchCollectionRoom();
  }, [userId]);

  const fetchCollectionRoom = async () => {
    const response = await fetch(`/api/pokemon/collection/room/${userId || ''}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    const data = await response.json();
    
    if (data.success) {
      setRoom(data.data.room);
      setItems(data.data.items);
    }
  };

  const handleDragEnd = async (result) => {
    if (!result.destination || !isOwner) return;
    
    const { source, destination } = result;
    const item = items[source.index];
    
    // 计算新位置
    const newX = destination.x;
    const newY = destination.y;
    
    // 更新位置
    await fetch(`/api/pokemon/collection/room/items/${item.pokemon_id}/position`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify({ x: newX, y: newY })
    });
    
    // 更新本地状态
    const newItems = [...items];
    newItems[source.index] = { ...item, position_x: newX, position_y: newY };
    setItems(newItems);
  };

  return (
    <div className="collection-room">
      {/* 收藏室头部信息 */}
      <div className="room-header">
        <h2>{room?.room_name || 'My Collection'}</h2>
        <div className="room-stats">
          <span className="stat">
            <i className="icon-pokemon" /> {items.length}/50
          </span>
          <span className="stat">
            <i className="icon-star" /> {room?.shiny_count || 0} Shiny
          </span>
          <span className="stat">
            <i className="icon-heart" /> {room?.like_count || 0}
          </span>
          <span className="stat">
            <i className="icon-eye" /> {room?.visitor_count || 0}
          </span>
        </div>
      </div>

      {/* 收藏室画布 */}
      <div className="room-canvas" style={{ backgroundImage: `url(/assets/backgrounds/${room?.background_id || 'classic'}.jpg)` }}>
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="collection">
            {(provided) => (
              <div ref={provided.innerRef} className="items-grid">
                {items.map((item, index) => (
                  <Draggable 
                    key={item.pokemon_id} 
                    draggableId={item.pokemon_id} 
                    index={index}
                    isDragDisabled={!isOwner}
                  >
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                        className={`collection-item ${item.is_shiny ? 'shiny' : ''}`}
                        style={{
                          transform: `translate(${item.position_x}px, ${item.position_y}px) scale(${item.scale})`
                        }}
                        onClick={() => setSelectedItem(item)}
                      >
                        <img
                          src={`/assets/pokemon/${item.species_id}${item.is_shiny ? '-shiny' : ''}.png`}
                          alt={item.species_name}
                          className="pokemon-sprite"
                        />
                        {item.nickname && (
                          <span className="pokemon-nickname">{item.nickname}</span>
                        )}
                      </div>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </div>

      {/* 工具栏（仅所有者可见） */}
      {isOwner && (
        <div className="room-toolbar">
          <button onClick={() => setShowAddModal(true)}>
            <i className="icon-plus" /> Add Pokemon
          </button>
          <button onClick={() => setShowThemeModal(true)}>
            <i className="icon-palette" /> Theme
          </button>
          <button onClick={() => setShowSettingsModal(true)}>
            <i className="icon-settings" /> Settings
          </button>
        </div>
      )}

      {/* 精灵详情弹窗 */}
      {selectedItem && (
        <PokemonDetailModal 
          pokemon={selectedItem} 
          onClose={() => setSelectedItem(null)}
          onRemove={isOwner ? handleRemovePokemon : null}
        />
      )}
    </div>
  );
};

export default CollectionRoom;
```

### 5. 事件处理与通知

```javascript
// backend/services/pokemon-service/src/events/collectionEvents.js
const logger = require('../../../shared/logger');

class CollectionEventHandler {
  constructor(notificationService, achievementService) {
    this.notificationService = notificationService;
    this.achievementService = achievementService;
  }

  /**
   * 处理收藏室点赞事件
   */
  async handleCollectionLiked(event) {
    const { roomId, userId } = event.data;
    
    // 获取收藏室所有者
    const room = await this.db.query(
      `SELECT cr.*, u.username FROM collection_rooms cr 
       JOIN users u ON u.id = cr.user_id WHERE cr.id = $1`,
      [roomId]
    );
    
    if (room.rows.length > 0) {
      const owner = room.rows[0];
      
      // 发送通知给所有者
      await this.notificationService.send({
        userId: owner.user_id,
        type: 'collection_liked',
        title: 'Your collection received a like!',
        body: `${event.likerName} liked your collection room`,
        data: { roomId, likerId: userId }
      });
      
      // 检查成就
      await this.achievementService.checkAndUnlock(
        owner.user_id,
        'collection_likes',
        { likes: owner.like_count + 1 }
      );
    }
  }

  /**
   * 处理精灵添加到收藏室事件
   */
  async handleItemAdded(event) {
    const { userId, pokemon } = event.data;
    
    // 检查收藏成就
    const room = await this.db.query(
      `SELECT COUNT(*) as count FROM collection_items ci
       JOIN collection_rooms cr ON cr.id = ci.room_id
       WHERE cr.user_id = $1`,
      [userId]
    );
    
    const itemCount = parseInt(room.rows[0].count);
    
    // 解锁收藏数量成就
    if (itemCount >= 10) {
      await this.achievementService.unlock(userId, 'collector_bronze');
    }
    if (itemCount >= 25) {
      await this.achievementService.unlock(userId, 'collector_silver');
    }
    if (itemCount >= 50) {
      await this.achievementService.unlock(userId, 'collector_gold');
    }
    
    // 检查闪亮收藏成就
    if (pokemon.is_shiny) {
      const shinyCount = await this.db.query(
        `SELECT COUNT(*) as count FROM collection_items ci
         JOIN pokemons p ON p.id = ci.pokemon_id
         JOIN collection_rooms cr ON cr.id = ci.room_id
         WHERE cr.user_id = $1 AND p.is_shiny = true`,
        [userId]
      );
      
      if (parseInt(shinyCount.rows[0].count) >= 10) {
        await this.achievementService.unlock(userId, 'shiny_collector');
      }
    }
  }
}

module.exports = CollectionEventHandler;
```

## 验收标准

- [ ] 用户可以创建和管理自己的收藏室
- [ ] 支持添加最多 50 只精灵到收藏室
- [ ] 支持拖拽调整精灵位置和大小
- [ ] 支持多种展示主题和背景
- [ ] 访客可以查看公开收藏室
- [ ] 支持点赞和评论功能
- [ ] 收藏室排行榜正常工作
- [ ] 解锁主题的条件校验正确
- [ ] 收藏数量成就正确解锁
- [ ] 缓存机制有效减少数据库查询
- [ ] API 响应时间 < 200ms

## 影响范围

- **新增文件**:
  - `backend/services/pokemon-service/src/modules/CollectionRoom.js`
  - `backend/services/pokemon-service/routes/collection.js`
  - `backend/services/pokemon-service/src/events/collectionEvents.js`
  - `frontend/game-client/src/components/CollectionRoom.js`
  - `frontend/game-client/src/components/CollectionRoomModal.js`
  - `database/migrations/YYYYMMDDHHMMSS_create_collection_tables.sql`

- **修改文件**:
  - `backend/services/pokemon-service/src/index.js` - 注册路由
  - `backend/services/social-service/src/modules/Social.js` - 集成收藏室展示
  - `frontend/game-client/src/App.js` - 添加收藏室路由

## 参考

- Pokemon GO: Buddy Showcase 功能
- Pokémon Home: Box 展示系统
- REQ-00055: 精灵收藏展示系统（基础版）
- REQ-00359: 精灵收藏室系统（原需求）

## 实现记录（2026-09-24）

> E05「成就/称号/资料卡/收藏室」与 E13「消息中心与推送」统一实现：REQ-00076 / 00106 / 00327 / 00359 / 00387 / 00403 与 REQ-00099 / 00261 / 00425 共用同一套游戏事件 outbox、成就引擎与消息中心。
> 状态 `implemented`：代码已全部完成，**未做服务级验证**（2026-09-25 18:30 起规则）。此前迁移 `20260925_130000`、`20260925_131000` 曾在隔离 CI 栈（栈 8）的存量库上执行无失败，user-service 启动后事件消费者、消息分发器、WebSocket 均正常监听；之后新增的迁移 `20260925_132000`、`20260925_133000`、全部接口、前端界面只做了静态检查（`node --check`、`scripts/check-deps.js`、宿主机纯逻辑/内存替身单测），**待验证**。

**共用架构**

- 事件来源：业务表上的触发器把"发生了什么"写入 outbox 表 `achievement_events`（与业务同事务，业务回滚事件也不存在；触发器内部异常只 `RAISE WARNING`，不影响业务）并 `pg_notify('pmg_game_events')`。接入的表：`catch_sessions`（捕捉成功）、`pokestop_spins`、`trainer_level_ups`（升级，覆盖所有加经验路径）、`friendships`/`friends`、`friend_requests`、`friend_gifts`、`pokemon_trades`、`gym_battles`、`raid_participants`、`pvp_battles`、`egg_hatching`、`event_participations`；收藏室的展示/装饰/被点赞由 JS 在同事务写事件。
- 消费：`backend/shared/achievementEngine.js`，user-service 启动时 `LISTEN` 实时处理 + 10 秒兜底扫描 + 每小时清理；pokemon-service 查询成就前按需处理该玩家未处理事件。`FOR UPDATE SKIP LOCKED` 保证多消费者不重复处理；每个事件一个 SAVEPOINT，单事件失败不影响其他事件，失败 5 次后放弃并保留 `last_error`。
- 规则：`backend/shared/achievementRules.js`（事件 → 指标、过滤条件、奖励拆分、事件 → 消息、多语言，纯函数）。
- 消息：`backend/shared/notificationCenter.js`（生成/列表/未读/已读/删除/偏好/广播/分析/清理）、`notificationPolicy.js`（分类、偏好、免打扰、投递计划，纯函数）、`notificationRealtime.js`（`/ws/messages` 与 LISTEN 分发）、`pushProviders.js`（FCM/APNs）。
- 迁移：`database/migrations/20260925_130000__e05_achievement_title_core.sql`（成就/称号收敛 + outbox 触发器）、`20260925_131000__e13_notification_center.sql`（消息中心）、`20260925_132000__e05_collection_room.sql`（收藏室）、`20260925_133000__e05_player_profile.sql`（资料卡）。均 `IF NOT EXISTS`/`ON CONFLICT` 幂等，外键均按 `users.id UUID`；依赖的表（`achievements`、`title_definitions`、`trainer_level_ups`、`notification_templates`、E01 的 `privacy_settings`/`blocked_users` 等）都在更早的迁移中创建（已逐条核对）。
- 测试：单测 `cd backend && node --test tests/unit/achievementRules.test.js tests/unit/achievementEngine.test.js tests/unit/notificationPolicy.test.js tests/unit/notificationCenter.test.js tests/unit/profileRules.test.js tests/unit/collectionRoomRules.test.js tests/unit/securityNotifier.test.js`（53 例，已加入 `test:unit`，宿主机已运行通过；引擎与消息中心用 `tests/unit/helpers/fakeGameDb.js` 内存替身，不依赖数据库）；经网关冒烟 `BASE_URL=… node scripts/smoke-profile-notify.js`（约 97 项，**未运行**）；压测 `node scripts/bench-profile-notify.js`（**未运行**）；前端 `cd frontend/game-client && npx playwright test tests/e2e/profile-notify.spec.js`（Mock 接口，**未运行**）。
- 前端：`frontend/game-client/src/features/profileNotify.js` + `src/features/profile-notify/*`（由 `src/bootstrap/features.js` 注册一行）：底部导航「消息」🔔、「我的」页「成长与收藏」卡片（成就、称号、资料卡、我的收藏室、热门收藏室、收藏家排行、消息与通知设置）。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 用户可以创建和管理自己的收藏室 | ✅ | 与 REQ-00359 同一实现：`GET/PUT /v1/collection-room`（自动创建、名称/主题/背景/公开/网格大小） |
| 支持添加最多 50 只精灵到收藏室 | ✅ | `POST /v1/collection-room/pokemon {pokemonId, x?, y?, displayMode, pedestalType, scale, rotation, label}`（未给坐标时放到第一个空格），`PUT/DELETE /v1/collection-room/pokemon/:pokemonId`；只能展示自己拥有且未放生的精灵，同一只不能重复展示（409）；容量随收藏室等级 20→50（7 级起 50 只，上限 50），精灵被删除/放生时级联移除 |
| 支持拖拽调整精灵位置和大小 | ✅ | 前端编辑器拖动（Pointer Events）+ 缩放按钮/快捷键；`PUT /v1/collection-room/layout {pokemon:[…], decorations:[…]}` 批量保存（整体校验后一次更新，可互换位置）；缩放 0.5~2、旋转、层级 |
| 支持多种展示主题和背景 | ✅ | 主题 8 个、背景 6 个（`GET /v1/collection-room/themes`、`/backgrounds` 带解锁状态与三语名称），自定义背景图（5 级起） |
| 访客可以查看公开收藏室 | ✅ | `GET /v1/collection-room/users/:userId`（对应原设计 `GET /room/:userId`）、`GET /v1/collection-room/:roomId/visit`；未公开 403、被拉黑 403 |
| 支持点赞和评论功能 | ✅ | 点赞见 REQ-00359；评论 `GET/POST /v1/collection-room/:roomId/comments`（≤ 200 字，去除尖括号，每人每房间每天 ≤ 10 条），`DELETE …/comments/:id`（作者或房主，软删除）；被评论生成房主站内消息 |
| 收藏室排行榜正常工作 | ✅ | `GET /v1/collection-room/popular?sort=likes|visitors|level|recent&limit=`（只含公开收藏室、排除封禁用户，Redis 缓存 60 秒） |
| 解锁主题的条件校验正确 | ✅ | 设置主题/背景时服务端校验：非付费项按 `unlock_condition`（收藏室等级 / 指定成就）判断，付费项必须已购买，否则 403；`roomRules.isUnlocked` 单测覆盖 |
| 收藏数量成就正确解锁 | ✅ | 新增收藏成就：开馆大吉（1 只）、铜/银/金牌收藏家（10/25/50 只）、闪光收藏家（10 只闪光）、小有名气/人气展馆（10/100 赞）、布置达人（10 件装饰），由展示/装饰/被点赞事件经成就引擎按"当前实际数量"推进（撤下再展示不会重复累加），奖励装饰与称号"策展人""人气馆主" |
| 缓存机制有效减少数据库查询 | ✅ | 房间详情（房间 + 精灵 + 装饰三次查询）缓存 120 秒，键带房主版本号，任何修改/点赞/留言/首次访问即失效；同一访客当天重复访问不失效缓存；热门排行缓存 60 秒 |
| API 响应时间 < 200ms | ⚠️ | 未实测；`scripts/bench-profile-notify.js` 含访问收藏室接口的 P95 |

- 入口：同 REQ-00359（pokemon-service `/collection-room`，网关 `/v1/collection-room/*`）；收藏统计 `GET /v1/collection-room/stats`（展示数、种类、闪光、最高 CP、稀有度分布、图鉴完成度、近 7 天访客）
- 迁移：`database/migrations/20260925_132000__e05_collection_room.sql`
- 测试：`tests/unit/collectionRoomRules.test.js`（8 例，已通过）；冒烟收藏室 21 项（未运行）
- 偏差：原设计的 `collection_items`（引用不存在的 `pokemons` 表）改为引用 `pokemon_instances`；`collection_visitors`/`collection_likes`/`collection_comments` 对应 `room_visits`/`room_likes`/`room_comments`（与 REQ-00359 合并）；社交服务 `Social.js` 未改动，好友资料页通过 `window.PMG_PROFILE.visitRoom(userId)` 进入收藏室
- 待验证：同 REQ-00359
