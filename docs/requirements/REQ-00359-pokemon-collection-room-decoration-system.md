# REQ-00359: 精灵收藏室与个性化装饰系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00359 |
| 标题 | 精灵收藏室与个性化装饰系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 08:00 UTC |

## 需求描述

### 背景
当前精灵收藏展示系统（REQ-00055）已实现基础的精灵展示功能，但缺乏个性化和社交互动元素。玩家希望能够创建独特的收藏空间，展示自己的游戏成就和个性风格，同时与好友分享和互动。

### 目标
设计并实现精灵收藏室（Collection Room）系统，允许玩家创建个性化的展示空间，布置装饰物品，邀请好友访问，增强游戏的社交性和长期留存价值。

### 核心功能
1. **收藏室创建与管理**：玩家创建个人收藏室，设置主题、背景、布局
2. **装饰物品系统**：通过游戏内活动、成就、商店获取装饰物品
3. **精灵展示台**：在收藏室中放置精选精灵，支持动态展示和互动
4. **好友访问系统**：邀请好友参观收藏室，点赞、留言互动
5. **收藏室等级系统**：通过装饰和展示提升收藏室等级，解锁更多功能

## 技术方案

### 1. 数据库设计

#### 收藏室主表
```sql
-- 收藏室主表
CREATE TABLE collection_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_name VARCHAR(100) NOT NULL DEFAULT 'My Collection Room',
    theme VARCHAR(50) DEFAULT 'default', -- classic, forest, ocean, volcano, cyber
    background_image_url TEXT,
    layout_config JSONB DEFAULT '{
        "gridSize": {"width": 10, "height": 8},
        "zones": []
    }'::jsonb,
    level INTEGER DEFAULT 1,
    experience INTEGER DEFAULT 0,
    visitor_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    is_public BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

CREATE INDEX idx_collection_rooms_user ON collection_rooms(user_id);
CREATE INDEX idx_collection_rooms_public ON collection_rooms(is_public) WHERE is_public = true;
CREATE INDEX idx_collection_rooms_visitor_count ON collection_rooms(visitor_count DESC);
```

#### 装饰物品定义表
```sql
-- 装饰物品定义表
CREATE TABLE decoration_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_code VARCHAR(100) UNIQUE NOT NULL, -- 'statue_golden_eevee', 'fountain_crystal', 'banner_victory'
    name_i18n JSONB NOT NULL, -- {"en": "Golden Eevee Statue", "zh-CN": "金色伊布雕像"}
    description_i18n JSONB,
    category VARCHAR(50) NOT NULL, -- furniture, statue, banner, floor, wall, effect
    rarity VARCHAR(20) NOT NULL, -- common, uncommon, rare, epic, legendary
    width INTEGER NOT NULL DEFAULT 1,
    height INTEGER NOT NULL DEFAULT 1,
    image_url TEXT NOT NULL,
    thumbnail_url TEXT,
    animation_url TEXT, -- 动画效果URL（可选）
    interaction_type VARCHAR(50), -- static, rotate, animate, interactive
    unlock_requirements JSONB, -- {"minLevel": 5, "achievementId": "xyz"}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_decoration_items_category ON decoration_items(category);
CREATE INDEX idx_decoration_items_rarity ON decoration_items(rarity);
```

#### 用户装饰物品库存表
```sql
-- 用户装饰物品库存表
CREATE TABLE user_decorations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES decoration_items(id),
    quantity INTEGER DEFAULT 1,
    obtained_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    obtained_from VARCHAR(50), -- shop, achievement, event, gift
    UNIQUE(user_id, item_id)
);

CREATE INDEX idx_user_decorations_user ON user_decorations(user_id);
```

#### 收藏室装饰布局表
```sql
-- 收藏室装饰布局表
CREATE TABLE room_decorations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES decoration_items(id),
    position_x INTEGER NOT NULL,
    position_y INTEGER NOT NULL,
    rotation INTEGER DEFAULT 0, -- 0, 90, 180, 270
    scale DECIMAL(3,2) DEFAULT 1.0,
    z_index INTEGER DEFAULT 0,
    custom_config JSONB, -- 特殊配置，如动画速度、颜色等
    placed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, position_x, position_y)
);

CREATE INDEX idx_room_decorations_room ON room_decorations(room_id);
```

#### 精灵展示台表
```sql
-- 精灵展示台表
CREATE TABLE pokemon_display_pedestals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
    pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id),
    position_x INTEGER NOT NULL,
    position_y INTEGER NOT NULL,
    display_mode VARCHAR(20) DEFAULT 'idle', -- idle, walk, pose, battle
    pedestal_type VARCHAR(50) DEFAULT 'basic', -- basic, bronze, silver, gold, diamond
    animation_speed DECIMAL(3,2) DEFAULT 1.0,
    custom_label VARCHAR(100),
    placed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, pokemon_instance_id)
);

CREATE INDEX idx_pokemon_display_pedestals_room ON pokemon_display_pedestals(room_id);
```

#### 收藏室访问记录表
```sql
-- 收藏室访问记录表
CREATE TABLE room_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
    visitor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visit_duration_seconds INTEGER,
    liked BOOLEAN DEFAULT false,
    comment TEXT,
    visited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_room_visits_room ON room_visits(room_id);
CREATE INDEX idx_room_visits_visitor ON room_visits(visitor_id);
CREATE INDEX idx_room_visits_time ON room_visits(visited_at DESC);
```

### 2. 后端 API 设计

#### 收藏室管理 API
```javascript
// pokemon-service/routes/collectionRoom.js

/**
 * 创建或获取玩家收藏室
 * GET /api/pokemon/collection-room
 */
router.get('/collection-room', auth, async (req, res) => {
  const userId = req.user.id;
  
  let room = await db.collectionRooms.findByUserId(userId);
  
  if (!room) {
    // 首次访问自动创建
    room = await db.collectionRooms.create({
      user_id: userId,
      room_name: `${req.user.username}'s Collection`,
      theme: 'default'
    });
  }
  
  res.json({
    success: true,
    data: room
  });
});

/**
 * 更新收藏室设置
 * PUT /api/pokemon/collection-room
 */
router.put('/collection-room', auth, async (req, res) => {
  const { roomName, theme, backgroundImageUrl, isPublic } = req.body;
  
  const room = await db.collectionRooms.findByUserId(req.user.id);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const updated = await db.collectionRooms.update(room.id, {
    room_name: roomName,
    theme,
    background_image_url: backgroundImageUrl,
    is_public: isPublic,
    updated_at: new Date()
  });
  
  res.json({
    success: true,
    data: updated
  });
});

/**
 * 获取用户装饰物品库存
 * GET /api/pokemon/collection-room/decorations
 */
router.get('/collection-room/decorations', auth, async (req, res) => {
  const decorations = await db.userDecorations.findByUserId(req.user.id);
  
  // 关联物品详情
  const itemsWithDetails = await Promise.all(
    decorations.map(async (d) => {
      const item = await db.decorationItems.findById(d.item_id);
      return { ...d, item };
    })
  );
  
  res.json({
    success: true,
    data: itemsWithDetails
  });
});

/**
 * 放置装饰物品
 * POST /api/pokemon/collection-room/decorations/place
 */
router.post('/collection-room/decorations/place', auth, async (req, res) => {
  const { itemId, positionX, positionY, rotation, scale } = req.body;
  
  const room = await db.collectionRooms.findByUserId(req.user.id);
  const userDecoration = await db.userDecorations.findByUserIdAndItemId(
    req.user.id, itemId
  );
  
  if (!userDecoration || userDecoration.quantity < 1) {
    return res.status(400).json({ error: 'Item not available' });
  }
  
  // 检查位置是否已被占用
  const existing = await db.roomDecorations.findByPosition(room.id, positionX, positionY);
  if (existing) {
    return res.status(400).json({ error: 'Position already occupied' });
  }
  
  // 开启事务
  await db.transaction(async (trx) => {
    // 放置装饰
    await db.roomDecorations.create({
      room_id: room.id,
      item_id: itemId,
      position_x: positionX,
      position_y: positionY,
      rotation,
      scale
    }, trx);
    
    // 扣减库存
    await db.userDecorations.decrementQuantity(
      req.user.id, itemId, 1, trx
    );
  });
  
  res.json({ success: true });
});

/**
 * 移除装饰物品
 * DELETE /api/pokemon/collection-room/decorations/:decorationId
 */
router.delete('/collection-room/decorations/:decorationId', auth, async (req, res) => {
  const { decorationId } = req.params;
  
  const roomDecoration = await db.roomDecorations.findById(decorationId);
  const room = await db.collectionRooms.findById(roomDecoration.room_id);
  
  if (room.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  await db.transaction(async (trx) => {
    // 返还库存
    await db.userDecorations.incrementQuantity(
      req.user.id, roomDecoration.item_id, 1, trx
    );
    
    // 移除装饰
    await db.roomDecorations.delete(decorationId, trx);
  });
  
  res.json({ success: true });
});

/**
 * 放置精灵到展示台
 * POST /api/pokemon/collection-room/pokemon/display
 */
router.post('/collection-room/pokemon/display', auth, async (req, res) => {
  const { pokemonInstanceId, positionX, positionY, displayMode, pedestalType } = req.body;
  
  const room = await db.collectionRooms.findByUserId(req.user.id);
  const pokemon = await db.pokemonInstances.findById(pokemonInstanceId);
  
  if (!pokemon || pokemon.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Pokemon not owned' });
  }
  
  // 检查是否已在展示中
  const existing = await db.pokemonDisplayPedestals.findByPokemonInstanceId(pokemonInstanceId);
  if (existing) {
    return res.status(400).json({ error: 'Pokemon already on display' });
  }
  
  await db.pokemonDisplayPedestals.create({
    room_id: room.id,
    pokemon_instance_id: pokemonInstanceId,
    position_x: positionX,
    position_y: positionY,
    display_mode: displayMode,
    pedestal_type: pedestalType
  });
  
  res.json({ success: true });
});

/**
 * 访问其他玩家收藏室
 * GET /api/pokemon/collection-room/:roomId/visit
 */
router.get('/collection-room/:roomId/visit', auth, async (req, res) => {
  const { roomId } = req.params;
  
  const room = await db.collectionRooms.findById(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  if (!room.is_public && room.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Room is private' });
  }
  
  // 获取完整房间数据
  const decorations = await db.roomDecorations.findByRoomId(roomId);
  const pokemonDisplays = await db.pokemonDisplayPedestals.findByRoomId(roomId);
  const owner = await db.users.findById(room.user_id);
  
  // 记录访问
  if (room.user_id !== req.user.id) {
    await db.roomVisits.create({
      room_id: roomId,
      visitor_id: req.user.id
    });
    
    // 更新访问计数
    await db.collectionRooms.incrementVisitorCount(roomId);
  }
  
  res.json({
    success: true,
    data: {
      room,
      owner: {
        id: owner.id,
        username: owner.username,
        avatar: owner.avatar_url
      },
      decorations: await Promise.all(
        decorations.map(async (d) => {
          const item = await db.decorationItems.findById(d.item_id);
          return { ...d, item };
        })
      ),
      pokemonDisplays: await Promise.all(
        pokemonDisplays.map(async (p) => {
          const pokemon = await db.pokemonInstances.findById(p.pokemon_instance_id);
          return { ...p, pokemon };
        })
      )
    }
  });
});

/**
 * 点赞收藏室
 * POST /api/pokemon/collection-room/:roomId/like
 */
router.post('/collection-room/:roomId/like', auth, async (req, res) => {
  const { roomId } = req.params;
  
  const room = await db.collectionRooms.findById(roomId);
  if (room.user_id === req.user.id) {
    return res.status(400).json({ error: 'Cannot like own room' });
  }
  
  // 检查是否已点赞
  const visit = await db.roomVisits.findLatestByRoomAndVisitor(roomId, req.user.id);
  if (visit && visit.liked) {
    return res.status(400).json({ error: 'Already liked' });
  }
  
  await db.transaction(async (trx) => {
    await db.roomVisits.updateLike(roomId, req.user.id, true, trx);
    await db.collectionRooms.incrementLikeCount(roomId, trx);
  });
  
  // 发送通知给房间所有者
  await notifyService.send(room.user_id, {
    type: 'room_liked',
    data: {
      roomId,
      visitorId: req.user.id,
      visitorName: req.user.username
    }
  });
  
  res.json({ success: true });
});

/**
 * 获取热门收藏室列表
 * GET /api/pokemon/collection-rooms/popular
 */
router.get('/collection-rooms/popular', auth, async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  
  const rooms = await db.collectionRooms.findPopular({
    limit: parseInt(limit),
    offset: parseInt(offset)
  });
  
  const roomsWithDetails = await Promise.all(
    rooms.map(async (room) => {
      const owner = await db.users.findById(room.user_id);
      return {
        ...room,
        owner: {
          id: owner.id,
          username: owner.username,
          avatar: owner.avatar_url
        }
      };
    })
  );
  
  res.json({
    success: true,
    data: roomsWithDetails
  });
});
```

### 3. 前端实现

#### 收藏室编辑器
```javascript
// frontend/game-client/src/collection/CollectionRoomEditor.js

class CollectionRoomEditor {
  constructor(roomData, containerElement) {
    this.room = roomData;
    this.container = containerElement;
    this.gridSize = roomData.layout_config.gridSize;
    this.decorations = roomData.decorations || [];
    this.pokemonDisplays = roomData.pokemonDisplays || [];
    this.inventory = [];
    this.selectedItem = null;
    this.mode = 'view'; // 'view', 'edit', 'decorate'
    
    this.init();
  }
  
  init() {
    this.createGrid();
    this.loadInventory();
    this.setupEventListeners();
    this.render();
  }
  
  createGrid() {
    this.grid = [];
    for (let y = 0; y < this.gridSize.height; y++) {
      this.grid[y] = [];
      for (let x = 0; x < this.gridSize.width; x++) {
        this.grid[y][x] = {
          type: 'empty',
          item: null
        };
      }
    }
    
    // 放置现有装饰
    this.decorations.forEach(dec => {
      this.placeOnGrid(dec.position_x, dec.position_y, 'decoration', dec);
    });
    
    // 放置精灵展示台
    this.pokemonDisplays.forEach(display => {
      this.placeOnGrid(display.position_x, display.position_y, 'pokemon', display);
    });
  }
  
  placeOnGrid(x, y, type, item) {
    const itemData = type === 'decoration' 
      ? item.item 
      : { width: 2, height: 2 }; // 精灵展示台固定大小
    
    for (let dy = 0; dy < itemData.height; dy++) {
      for (let dx = 0; dx < itemData.width; dx++) {
        if (y + dy < this.gridSize.height && x + dx < this.gridSize.width) {
          this.grid[y + dy][x + dx] = {
            type,
            item,
            isOrigin: dx === 0 && dy === 0
          };
        }
      }
    }
  }
  
  async loadInventory() {
    const response = await fetch('/api/pokemon/collection-room/decorations', {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    
    const data = await response.json();
    this.inventory = data.data;
    this.renderInventoryPanel();
  }
  
  setupEventListeners() {
    // 拖拽放置
    this.container.addEventListener('dragover', (e) => {
      e.preventDefault();
      const cell = this.getCellFromEvent(e);
      if (cell && this.canPlace(cell.x, cell.y, this.selectedItem)) {
        this.highlightCell(cell.x, cell.y);
      }
    });
    
    this.container.addEventListener('drop', async (e) => {
      e.preventDefault();
      const cell = this.getCellFromEvent(e);
      if (cell && this.selectedItem) {
        await this.placeDecoration(cell.x, cell.y, this.selectedItem);
      }
    });
    
    // 点击移除
    this.container.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (this.mode !== 'edit') return;
      
      const cell = this.getCellFromEvent(e);
      if (cell && this.grid[cell.y][cell.x].type !== 'empty') {
        await this.removeDecoration(cell.x, cell.y);
      }
    });
  }
  
  async placeDecoration(x, y, item) {
    try {
      const response = await fetch('/api/pokemon/collection-room/decorations/place', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          itemId: item.item_id,
          positionX: x,
          positionY: y,
          rotation: 0,
          scale: 1.0
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.placeOnGrid(x, y, 'decoration', {
          ...item,
          position_x: x,
          position_y: y
        });
        this.render();
        this.showNotification('Decoration placed!', 'success');
      }
    } catch (error) {
      this.showNotification('Failed to place decoration', 'error');
    }
  }
  
  canPlace(x, y, item) {
    const itemData = item.item || item;
    for (let dy = 0; dy < itemData.height; dy++) {
      for (let dx = 0; dx < itemData.width; dx++) {
        const checkX = x + dx;
        const checkY = y + dy;
        
        if (checkX >= this.gridSize.width || checkY >= this.gridSize.height) {
          return false;
        }
        
        if (this.grid[checkY][checkX].type !== 'empty') {
          return false;
        }
      }
    }
    return true;
  }
  
  render() {
    const html = `
      <div class="collection-room-editor">
        <div class="room-header">
          <h2>${this.room.room_name}</h2>
          <div class="room-stats">
            <span class="visitors">👥 ${this.room.visitor_count}</span>
            <span class="likes">❤️ ${this.room.like_count}</span>
            <span class="level">⭐ Lv.${this.room.level}</span>
          </div>
          ${this.mode === 'edit' ? `
            <button class="save-btn">Save Changes</button>
            <button class="cancel-btn">Cancel</button>
          ` : `
            <button class="edit-btn">Edit Room</button>
          `}
        </div>
        
        <div class="room-canvas" style="
          width: ${this.gridSize.width * 60}px;
          height: ${this.gridSize.height * 60}px;
          background-image: url('${this.room.background_image_url || ''}');
          background-size: cover;
        ">
          ${this.renderGrid()}
        </div>
        
        ${this.mode === 'edit' ? `
          <div class="inventory-panel">
            <h3>My Decorations</h3>
            <div class="inventory-grid">
              ${this.inventory.map(item => `
                <div class="inventory-item" 
                     draggable="true" 
                     data-item-id="${item.item_id}"
                     style="background-image: url('${item.item.thumbnail_url}')">
                  <span class="quantity">x${item.quantity}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
    
    this.container.innerHTML = html;
  }
  
  renderGrid() {
    let html = '<div class="grid-overlay">';
    
    for (let y = 0; y < this.gridSize.height; y++) {
      for (let x = 0; x < this.gridSize.width; x++) {
        const cell = this.grid[y][x];
        
        if (cell.isOrigin && cell.type !== 'empty') {
          html += this.renderGridItem(x, y, cell);
        }
      }
    }
    
    html += '</div>';
    return html;
  }
  
  renderGridItem(x, y, cell) {
    if (cell.type === 'decoration') {
      const item = cell.item;
      const itemData = item.item;
      
      return `
        <div class="grid-item decoration" 
             style="
               left: ${x * 60}px;
               top: ${y * 60}px;
               width: ${itemData.width * 60}px;
               height: ${itemData.height * 60}px;
               transform: rotate(${item.rotation || 0}deg) scale(${item.scale || 1});
               background-image: url('${itemData.image_url}');
             "
             data-decoration-id="${item.id}">
        </div>
      `;
    } else if (cell.type === 'pokemon') {
      const display = cell.item;
      
      return `
        <div class="grid-item pokemon-display"
             style="
               left: ${x * 60}px;
               top: ${y * 60}px;
             "
             data-display-id="${display.id}">
          <div class="pedestal ${display.pedestal_type}"></div>
          <div class="pokemon-sprite" 
               style="background-image: url('${this.getPokemonSprite(display.pokemon)}')">
          </div>
          ${display.custom_label ? `<div class="label">${display.custom_label}</div>` : ''}
        </div>
      `;
    }
    
    return '';
  }
  
  getPokemonSprite(pokemon) {
    // 返回精灵的sprite URL
    return `/assets/pokemon/${pokemon.species_id}.png`;
  }
  
  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.remove();
    }, 3000);
  }
}

export default CollectionRoomEditor;
```

#### 收藏室访问组件
```javascript
// frontend/game-client/src/collection/CollectionRoomVisitor.js

class CollectionRoomVisitor {
  constructor(roomId) {
    this.roomId = roomId;
    this.visitStartTime = Date.now();
    this.hasLiked = false;
    
    this.init();
  }
  
  async init() {
    await this.loadRoom();
    this.setupVisitTracking();
  }
  
  async loadRoom() {
    const response = await fetch(`/api/pokemon/collection-room/${this.roomId}/visit`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    
    const data = await response.json();
    this.roomData = data.data;
    this.render();
  }
  
  setupVisitTracking() {
    // 页面卸载时记录访问时长
    window.addEventListener('beforeunload', () => {
      const duration = Math.floor((Date.now() - this.visitStartTime) / 1000);
      this.recordVisitDuration(duration);
    });
  }
  
  async recordVisitDuration(duration) {
    // 使用 sendBeacon 确保请求被发送
    const data = JSON.stringify({
      roomId: this.roomId,
      duration: duration
    });
    
    navigator.sendBeacon('/api/pokemon/collection-room/visit/complete', data);
  }
  
  async likeRoom() {
    if (this.hasLiked) return;
    
    const response = await fetch(`/api/pokemon/collection-room/${this.roomId}/like`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    
    const data = await response.json();
    
    if (data.success) {
      this.hasLiked = true;
      this.updateLikeButton();
      this.showLikeAnimation();
    }
  }
  
  render() {
    const container = document.getElementById('room-container');
    
    container.innerHTML = `
      <div class="collection-room-visitor">
        <div class="room-header">
          <div class="owner-info">
            <img src="${this.roomData.owner.avatar}" class="owner-avatar">
            <span class="owner-name">${this.roomData.owner.username}'s Collection</span>
          </div>
          <div class="room-actions">
            <button class="like-btn ${this.hasLiked ? 'liked' : ''}" 
                    onclick="visitor.likeRoom()">
              ❤️ ${this.roomData.room.like_count}
            </button>
            <button class="share-btn">Share</button>
          </div>
        </div>
        
        <div class="room-content">
          <!-- 渲染房间内容 -->
          <canvas id="room-canvas"></canvas>
        </div>
        
        <div class="room-sidebar">
          <h3>Visitor Comments</h3>
          <div class="comments-list">
            <!-- 评论列表 -->
          </div>
          <textarea class="comment-input" placeholder="Leave a comment..."></textarea>
          <button class="submit-comment">Post</button>
        </div>
      </div>
    `;
  }
  
  showLikeAnimation() {
    const heart = document.createElement('div');
    heart.className = 'floating-heart';
    heart.innerHTML = '❤️';
    document.body.appendChild(heart);
    
    setTimeout(() => heart.remove(), 1000);
  }
}

export default CollectionRoomVisitor;
```

### 4. 装饰物品获取系统

#### 通过成就获取
```javascript
// reward-service/handlers/achievementHandler.js

async function checkAndAwardDecoration(userId, achievementId) {
  const achievement = await db.achievements.findById(achievementId);
  
  // 检查是否有装饰奖励
  if (achievement.decoration_reward) {
    const decorationItem = await db.decorationItems.findByCode(
      achievement.decoration_reward
    );
    
    if (decorationItem) {
      await db.userDecorations.upsert({
        user_id: userId,
        item_id: decorationItem.id,
        quantity: 1,
        obtained_from: 'achievement'
      });
      
      // 发送通知
      await notificationService.send(userId, {
        type: 'decoration_unlocked',
        data: {
          itemName: decorationItem.name_i18n,
          rarity: decorationItem.rarity
        }
      });
    }
  }
}
```

#### 通过商店购买
```javascript
// payment-service/routes/shop.js

router.post('/shop/decorations/:itemId/purchase', auth, async (req, res) => {
  const { itemId } = req.params;
  
  const item = await db.decorationItems.findById(itemId);
  const price = getDecorationPrice(item);
  
  // 检查用户货币余额
  const userBalance = await db.userCurrencies.getBalance(req.user.id, 'coins');
  
  if (userBalance < price) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }
  
  await db.transaction(async (trx) => {
    // 扣款
    await db.userCurrencies.decrement(req.user.id, 'coins', price, trx);
    
    // 发放物品
    await db.userDecorations.upsert({
      user_id: req.user.id,
      item_id: itemId,
      quantity: 1,
      obtained_from: 'shop'
    }, trx);
  });
  
  res.json({ success: true });
});
```

### 5. 收藏室等级系统

```javascript
// pokemon-service/services/roomLevelService.js

class RoomLevelService {
  constructor() {
    this.levelThresholds = [
      0, 100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000
    ];
    
    this.levelRewards = {
      2: { decorationSlots: 15, pedestalSlots: 3 },
      3: { decorationSlots: 20, pedestalSlots: 4, unlockThemes: ['forest'] },
      5: { decorationSlots: 30, pedestalSlots: 5, unlockThemes: ['ocean', 'volcano'] },
      7: { decorationSlots: 40, pedestalSlots: 6, unlockThemes: ['cyber'] },
      10: { decorationSlots: 50, pedestalSlots: 8, unlockThemes: ['legendary'] }
    };
  }
  
  async addExperience(roomId, amount, reason) {
    const room = await db.collectionRooms.findById(roomId);
    const oldLevel = this.calculateLevel(room.experience);
    
    const newExperience = room.experience + amount;
    const newLevel = this.calculateLevel(newExperience);
    
    await db.collectionRooms.update(roomId, {
      experience: newExperience,
      level: newLevel
    });
    
    // 检查是否升级
    if (newLevel > oldLevel) {
      await this.onLevelUp(room.user_id, oldLevel, newLevel);
    }
  }
  
  calculateLevel(experience) {
    for (let i = this.levelThresholds.length - 1; i >= 0; i--) {
      if (experience >= this.levelThresholds[i]) {
        return i + 1;
      }
    }
    return 1;
  }
  
  async onLevelUp(userId, oldLevel, newLevel) {
    // 检查升级奖励
    for (let level = oldLevel + 1; level <= newLevel; level++) {
      const reward = this.levelRewards[level];
      if (reward) {
        await this.grantLevelReward(userId, level, reward);
      }
    }
    
    // 发送升级通知
    await notificationService.send(userId, {
      type: 'room_level_up',
      data: {
        oldLevel,
        newLevel
      }
    });
  }
  
  async grantLevelReward(userId, level, reward) {
    // 解锁新主题
    if (reward.unlockThemes) {
      const room = await db.collectionRooms.findByUserId(userId);
      const unlockedThemes = room.unlocked_themes || ['default'];
      
      await db.collectionRooms.update(room.id, {
        unlocked_themes: [...unlockedThemes, ...reward.unlockThemes]
      });
    }
    
    // 发放装饰奖励
    const levelUpDecoration = await db.decorationItems.findByCode(`level_${level}_reward`);
    if (levelUpDecoration) {
      await db.userDecorations.upsert({
        user_id: userId,
        item_id: levelUpDecoration.id,
        quantity: 1,
        obtained_from: 'level_up'
      });
    }
  }
  
  // 经验值获取来源
  async recordActivity(roomId, activityType) {
    const experienceTable = {
      'decoration_placed': 5,
      'pokemon_displayed': 10,
      'visitor_came': 3,
      'visitor_liked': 15,
      'visitor_commented': 10
    };
    
    const experience = experienceTable[activityType] || 0;
    
    if (experience > 0) {
      await this.addExperience(roomId, experience, activityType);
    }
  }
}

export default new RoomLevelService();
```

## 验收标准

- [ ] 玩家可以创建和管理个人收藏室
- [ ] 收藏室支持至少 5 种主题和自定义背景
- [ ] 玩家可以放置至少 50 种不同稀有度的装饰物品
- [ ] 装饰物品可通过成就、商店、活动等多种途径获取
- [ ] 精灵展示台支持动态展示模式（idle、walk、pose）
- [ ] 玩家可以访问其他玩家的公开收藏室
- [ ] 访问系统记录访问次数和时长
- [ ] 点赞功能正常工作，数据持久化
- [ ] 收藏室等级系统根据活动提供经验值
- [ ] 升级解锁新主题、装饰槽位和奖励
- [ ] 前端编辑器支持拖拽放置装饰物品
- [ ] 前端访问界面显示完整房间内容和互动按钮
- [ ] API 响应时间 < 500ms（P95）
- [ ] 支持国际化（至少 3 种语言）

## 影响范围

### 新增文件
- `backend/services/pokemon/routes/collectionRoom.js` - 收藏室 API 路由
- `backend/services/pokemon/models/CollectionRoom.js` - 数据模型
- `backend/services/pokemon/services/roomLevelService.js` - 等级系统
- `frontend/game-client/src/collection/CollectionRoomEditor.js` - 编辑器组件
- `frontend/game-client/src/collection/CollectionRoomVisitor.js` - 访问组件
- `database/migrations/YYYYMMDD_create_collection_room_tables.sql` - 数据库迁移

### 修改文件
- `backend/services/pokemon/index.js` - 注册新路由
- `backend/services/reward/handlers/achievementHandler.js` - 添加装饰奖励
- `backend/services/payment/routes/shop.js` - 添加装饰商店
- `backend/shared/middleware/auth.js` - 确保鉴权覆盖新 API

### 依赖
- 现有的用户系统、精灵系统、奖励系统
- 支付系统（用于商店购买）
- 通知系统（用于奖励通知）

## 参考

- [Pokemon GO Showcase Feature](https://pokemongolive.com/)
- [Animal Crossing: New Horizons - Room Decoration System](https://www.nintendo.com/games/animal-crossing-new-horizons/)
- [Interior Design Games UX Patterns](https://www.gamasutra.com/)
- [User-Generated Content in Mobile Games](https://www.gamedeveloper.com/)

## 未来扩展

- 收藏室季节挑战与竞赛
- 访客留言系统增强
- 装饰物品合成与升级
- 收藏室截图分享到社交媒体
- AI 自动装饰建议
- 收藏室 3D 视角切换

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
| 玩家可以创建和管理个人收藏室 | ✅ | `GET /v1/collection-room` 首次访问自动创建（一人一个），返回房间、展示精灵、装饰、等级/经验/容量、可用主题与背景；`PUT /v1/collection-room {roomName, themeId, backgroundId, backgroundImageUrl, isPublic, layoutConfig}`（缩小网格时检查已有摆放） |
| 收藏室支持至少 5 种主题和自定义背景 | ✅ | 主题 8 个（默认/经典/森林/海洋/火山/赛博/传说殿堂/樱花庭院），背景 6 个；按收藏室等级解锁或金币购买（`POST /v1/collection-room/themes/:id/purchase`、`/backgrounds/:id/purchase`，只扣一次）；收藏室 5 级起可设置自定义背景图（只允许 https 地址） |
| 玩家可以放置至少 50 种不同稀有度的装饰物品 | ✅ | `decoration_items` 68 种：18 种基础款 × 木质/银色/金色（普通/稀有/史诗）+ 14 种成就/活动/升级奖励（少见/传说），7 个类别，带占格宽高与交互类型；摆放 `POST /v1/collection-room/decorations`，移动/旋转 `PUT …/:id`，收回 `DELETE …/:id`。服务端校验：拥有数量 > 已摆放数、等级要求、装饰位容量、越界、同层占格重叠（地面类单独一层，可铺在精灵/家具下面）、旋转 90/270 宽高互换；修改在锁住收藏室行的事务内完成，并发摆放不会重叠或超额 |
| 装饰物品可通过成就、商店、活动等多种途径获取 | ✅ | 商店：`POST /v1/collection-room/decorations/:itemCode/purchase {quantity}`（金币原子扣减、等级要求）；成就：成就奖励 `decoration`（开馆大吉/铜银金收藏家/闪光收藏家/小有名气/布置达人/精英训练师）由成就引擎完成时发放并通知；活动：活动奖励中 `{"type": "decoration", "item": "<item_code>"}` 在活动完成（领奖）时由成就引擎发放（每个活动每人一次）；升级：收藏室 3/5/7/10 级奖励物品 |
| 精灵展示台支持动态展示模式（idle、walk、pose） | ✅ | `display_mode` idle/walk/pose/battle/shiny/card/3d（闪光模式只对闪光精灵开放），展示台 basic/bronze/silver/gold/diamond（2/4/6/8 级解锁），动画速度、标签、缩放、旋转；前端按模式播放 CSS 动画（尊重"减少动态效果"设置） |
| 玩家可以访问其他玩家的公开收藏室 | ✅ | `GET /v1/collection-room/:roomId/visit`、`GET /v1/collection-room/users/:userId`；未公开的收藏室他人访问 403；被房主拉黑（E01 `blocked_users`）的玩家不能参观/点赞/留言 |
| 访问系统记录访问次数和时长 | ✅ | `room_visits` 每人每天一行（`visit_count` 累加、首次/最近访问时间），访客数每人每天只加一次；`POST /v1/collection-room/:roomId/visit/end {durationSeconds}` 累加时长（单次上限 1 小时），前端关闭参观面板时自动上报；`GET /v1/collection-room/stats` 返回近 7 天访客与时长 |
| 点赞功能正常工作，数据持久化 | ✅ | `POST/DELETE /v1/collection-room/:roomId/like`：`room_likes` 取消只置 inactive，`like_count` 与点赞行在同一事务更新，并发重复点赞只计一次；不能给自己点赞；被点赞生成房主站内消息（去重）、推进"人气"成就 |
| 收藏室等级系统根据活动提供经验值 | ✅ | 阈值 0/100/250/500/1000/2000/4000/8000/15000/30000；经验：摆放装饰 5（每种物品一次）、展示精灵 10（每只一次）、访客到访 3（每人每天一次）、被点赞 15（每人一次）、被留言 10（每人每天一次）。经验流水 `room_exp_log` 以"原因+对象"为主键，反复摆放/取消点赞不能刷经验 |
| 升级解锁新主题、装饰槽位和奖励 | ✅ | 升级时发放等级奖励装饰、发"收藏室升级"消息；容量随等级：展示精灵 20 + 5×(等级-1)（上限 50，兼顾 REQ-00403）、装饰 10 + 5×(等级-1)（上限 60）；主题/背景/装饰/展示台按等级解锁 |
| 前端编辑器支持拖拽放置装饰物品 | ✅ | `src/features/profile-notify/collectionRoom.js`：网格编辑器（Pointer Events 拖动已摆放物、HTML5 拖放从库存放入，触屏可双击/回车放入）、选中后方向键移动、R 旋转、+/- 缩放、Delete 收回、展示模式/展示台/标签编辑、商店与主题页；服务端拒绝时回滚显示 |
| 前端访问界面显示完整房间内容和互动按钮 | ✅ | 参观界面：房间网格（主题配色/背景/精灵/装饰）、点赞/取消、访客数、留言列表与发表；热门收藏室列表 |
| API 响应时间 < 500ms（P95） | ⚠️ | 未实测；房间详情走 Redis 缓存（带房主版本号，变更即失效）；`scripts/bench-profile-notify.js` 含 `GET /v1/collection-room/users/:id` 的 P95 |
| 支持国际化（至少 3 种语言） | ✅ | 装饰、主题、背景名称均为中/英/日（`?lang=` / `X-Language`），收藏室相关消息模板三语 |

- 入口：pokemon-service `src/routes/collectionRoom.js`（挂载 `/collection-room`）、`src/collectionRoom/roomService.js`、`src/collectionRoom/roomRules.js`（纯规则）；网关 `/v1/collection-room/*`（鉴权）
- 迁移：`database/migrations/20260925_132000__e05_collection_room.sql`：`collection_themes`、`collection_backgrounds`、`user_room_unlocks`、`collection_rooms`、`collection_room_pokemon`（展示台）、`decoration_items`（68 种）、`user_decorations`、`room_decorations`、`room_visits`、`room_likes`、`room_comments`、`room_exp_log`
- 测试：`tests/unit/collectionRoomRules.test.js`（8 例，已通过）；冒烟收藏室 21 项（未运行）
- 偏差：REQ-00359 与 REQ-00403 合并为一套表（`pokemon_display_pedestals` 与 `collection_items` 合并为 `collection_room_pokemon`）；装饰商店在 pokemon-service 的收藏室路由下（原方案放 payment-service）；图片地址为占位路径，前端以图标渲染
- 待验证：① 全新库执行迁移 `20260925_132000`（本批次未上库试跑）；② 冒烟收藏室 21 项；③ 编辑器拖拽在触屏设备上的体验
