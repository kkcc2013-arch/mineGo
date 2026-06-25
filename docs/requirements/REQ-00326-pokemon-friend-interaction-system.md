# REQ-00326: 精灵好友互动系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00326 |
| 标题 | 精灵好友互动系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、social-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-25 02:05 UTC |

## 需求描述

实现精灵之间的好友互动系统，让玩家可以让自己的精灵与其他玩家的精灵建立好友关系，并解锁特殊互动玩法。

**核心功能：**
1. 精灵好友申请与接受机制
2. 精灵好友互动活动（拜访、送礼、共同探险）
3. 好友亲密度系统与解锁奖励
4. 精灵好友合影与纪念品系统
5. 跨区域精灵好友互动加成

**目标：**
- 增强精灵养成深度
- 促进玩家社交互动
- 创造新的玩法循环

## 技术方案

### 1. 数据模型设计

```sql
-- 精灵好友关系表
CREATE TABLE pokemon_friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    friend_pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    friendship_level INT DEFAULT 1 CHECK (friendship_level BETWEEN 1 AND 10),
    intimacy_score INT DEFAULT 0 CHECK (intimacy_score BETWEEN 0 AND 10000),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP,
    last_interaction_at TIMESTAMP,
    interaction_count INT DEFAULT 0,
    UNIQUE(pokemon_id, friend_pokemon_id)
);

-- 精灵互动记录表
CREATE TABLE pokemon_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    friendship_id UUID NOT NULL REFERENCES pokemon_friendships(id) ON DELETE CASCADE,
    interaction_type VARCHAR(50) NOT NULL CHECK (interaction_type IN ('visit', 'gift', 'adventure', 'photo', 'training')),
    interaction_data JSONB DEFAULT '{}',
    intimacy_gained INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_friendship_created (friendship_id, created_at)
);

-- 精灵好友纪念品表
CREATE TABLE pokemon_keepsakes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    friendship_id UUID NOT NULL REFERENCES pokemon_friendships(id) ON DELETE CASCADE,
    keepsake_type VARCHAR(50) NOT NULL,
    keepsake_data JSONB DEFAULT '{}',
    rarity VARCHAR(20) DEFAULT 'common',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2. API 接口设计

```yaml
# 精灵好友申请
POST /api/v1/pokemon/{pokemonId}/friend-request
Request:
  friendPokemonId: UUID
  message: string (optional)
Response:
  friendshipId: UUID
  status: "pending"

# 接受/拒绝好友申请
PUT /api/v1/pokemon/friendships/{friendshipId}/status
Request:
  action: "accept" | "reject" | "block"
Response:
  status: "accepted" | "rejected" | "blocked"

# 获取精灵好友列表
GET /api/v1/pokemon/{pokemonId}/friends
Query:
  page: number
  limit: number
  sortBy: "intimacy" | "level" | "recent"
Response:
  friends: Array<{
    friendshipId: UUID
    friendPokemon: PokemonSummary
    friendshipLevel: number
    intimacyScore: number
    lastInteraction: Date
  }>
  total: number

# 发起互动
POST /api/v1/pokemon/friendships/{friendshipId}/interact
Request:
  type: "visit" | "gift" | "adventure" | "photo" | "training"
  data: object
Response:
  success: boolean
  intimacyGained: number
  rewards: Array<Reward>

# 获取纪念品列表
GET /api/v1/pokemon/friendships/{friendshipId}/keepsakes
Response:
  keepsakes: Array<Keepsake>
```

### 3. 亲密度计算引擎

```javascript
// backend/shared/intimacyCalculator.js

class IntimacyCalculator {
  constructor(config = {}) {
    this.baseInteractionGain = config.baseGain || 10;
    this.levelMultipliers = {
      1: 1.0,
      2: 1.1,
      3: 1.2,
      4: 1.3,
      5: 1.5,
      6: 1.7,
      7: 2.0,
      8: 2.5,
      9: 3.0,
      10: 4.0
    };
    
    this.interactionTypes = {
      visit: { base: 10, cooldown: 3600 },      // 1小时
      gift: { base: 20, cooldown: 86400 },      // 24小时
      adventure: { base: 50, cooldown: 604800 }, // 7天
      photo: { base: 5, cooldown: 7200 },        // 2小时
      training: { base: 30, cooldown: 43200 }    // 12小时
    };
  }

  calculateGain(interactionType, currentLevel, bonuses = {}) {
    const typeConfig = this.interactionTypes[interactionType];
    const base = typeConfig.base;
    const levelMult = this.levelMultipliers[currentLevel] || 1.0;
    
    let total = base * levelMult;
    
    // 应用加成
    if (bonuses.sameSpecies) total *= 1.5;
    if (bonuses.compatibleType) total *= 1.2;
    if (bonuses.eventActive) total *= 2.0;
    
    return Math.floor(total);
  }

  canLevelUp(currentScore, currentLevel) {
    const thresholds = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500, 5500];
    return currentScore >= thresholds[currentLevel];
  }
}

module.exports = IntimacyCalculator;
```

### 4. 好友等级奖励系统

```javascript
// backend/shared/friendshipRewards.js

const FRIENDSHIP_REWARDS = {
  1: { type: 'badge', name: 'new_friends' },
  2: { type: 'item', itemId: 'friendship_ribbon', quantity: 1 },
  3: { type: 'boost', boostType: 'intimacy_gain', value: 1.1 },
  4: { type: 'feature', feature: 'gift_premium_items' },
  5: { type: 'item', itemId: 'friendship_medal', quantity: 1 },
  6: { type: 'boost', boostType: 'adventure_reward', value: 1.2 },
  7: { type: 'feature', feature: 'joint_training' },
  8: { type: 'item', itemId: 'friendship_crown', quantity: 1 },
  9: { type: 'boost', boostType: 'all_friendship_benefits', value: 1.3 },
  10: { type: 'special', feature: 'soul_bond', description: '解锁灵魂羁绊技能' }
};

async function grantLevelReward(friendship, newLevel, db) {
  const reward = FRIENDSHIP_REWARDS[newLevel];
  if (!reward) return null;

  // 根据奖励类型发放
  switch (reward.type) {
    case 'badge':
      await db.query(`
        INSERT INTO pokemon_badges (pokemon_id, badge_name, earned_at)
        VALUES ($1, $2, NOW())
      `, [friendship.pokemon_id, reward.name]);
      break;
      
    case 'item':
      await db.query(`
        INSERT INTO pokemon_inventory (pokemon_id, item_id, quantity)
        VALUES ($1, $2, $3)
        ON CONFLICT (pokemon_id, item_id) 
        DO UPDATE SET quantity = pokemon_inventory.quantity + $3
      `, [friendship.pokemon_id, reward.itemId, reward.quantity]);
      break;
      
    case 'boost':
      await db.query(`
        INSERT INTO pokemon_boosts (pokemon_id, boost_type, multiplier, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
      `, [friendship.pokemon_id, reward.boostType, reward.value]);
      break;
      
    case 'feature':
      await db.query(`
        INSERT INTO pokemon_unlocks (pokemon_id, feature_name, unlocked_at)
        VALUES ($1, $2, NOW())
      `, [friendship.pokemon_id, reward.feature]);
      break;
      
    case 'special':
      await db.query(`
        INSERT INTO pokemon_special_abilities (pokemon_id, ability_name, unlocked_at)
        VALUES ($1, $2, NOW())
      `, [friendship.pokemon_id, reward.feature]);
      break;
  }

  return reward;
}
```

### 5. 前端实现

```javascript
// frontend/game-client/src/pokemon/FriendshipManager.js

class FriendshipManager {
  constructor(api, eventBus) {
    this.api = api;
    this.eventBus = eventBus;
    this.cache = new Map();
  }

  async sendFriendRequest(pokemonId, friendPokemonId, message = '') {
    try {
      const response = await this.api.post(
        `/pokemon/${pokemonId}/friend-request`,
        { friendPokemonId, message }
      );
      
      this.eventBus.emit('friendship:request_sent', {
        pokemonId,
        friendPokemonId,
        friendshipId: response.friendshipId
      });
      
      return response;
    } catch (error) {
      console.error('Failed to send friend request:', error);
      throw error;
    }
  }

  async performInteraction(friendshipId, interactionType, data = {}) {
    // 检查冷却时间
    const lastInteraction = this.getLastInteraction(friendshipId, interactionType);
    const cooldown = this.getCooldown(interactionType);
    
    if (lastInteraction && Date.now() - lastInteraction < cooldown * 1000) {
      const remaining = Math.ceil((cooldown * 1000 - (Date.now() - lastInteraction)) / 1000);
      throw new Error(`Cooldown active: ${remaining}s remaining`);
    }

    const response = await this.api.post(
      `/pokemon/friendships/${friendshipId}/interact`,
      { type: interactionType, data }
    );

    // 更新缓存
    this.updateInteractionCache(friendshipId, interactionType);

    // 触发动画
    if (response.intimacyGained > 0) {
      this.eventBus.emit('friendship:intimacy_gained', {
        friendshipId,
        gained: response.intimacyGained
      });
    }

    return response;
  }

  async checkLevelUp(friendshipId) {
    const friendship = await this.getFriendship(friendshipId);
    const nextLevel = friendship.friendshipLevel + 1;
    
    // 发送等级提升通知
    this.eventBus.emit('friendship:level_up', {
      friendshipId,
      newLevel: nextLevel,
      rewards: FRIENDSHIP_REWARDS[nextLevel]
    });
  }
}

export default FriendshipManager;
```

### 6. WebSocket 实时通知

```javascript
// backend/gateway/ws/friendshipHandler.js

class FriendshipWSHandler {
  constructor(wss, eventBus, cache) {
    this.wss = wss;
    this.eventBus = eventBus;
    this.cache = cache;
    
    this.setupEventListeners();
  }

  setupEventListeners() {
    // 好友申请通知
    this.eventBus.on('friendship:request_received', async (data) => {
      const userId = await this.getPokemonOwnerId(data.friendPokemonId);
      const ws = this.cache.getUserConnection(userId);
      
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'friendship:request',
          data: {
            friendshipId: data.friendshipId,
            fromPokemon: data.fromPokemon,
            message: data.message
          }
        }));
      }
    });

    // 等级提升通知
    this.eventBus.on('friendship:level_up', async (data) => {
      const participants = await this.getFriendshipParticipants(data.friendshipId);
      
      participants.forEach(async ({ userId, pokemonId }) => {
        const ws = this.cache.getUserConnection(userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'friendship:level_up',
            data: {
              pokemonId,
              friendshipId: data.friendshipId,
              newLevel: data.newLevel,
              rewards: data.rewards
            }
          }));
        }
      });
    });
  }
}
```

## 验收标准

- [ ] 精灵可以发送好友申请，对方精灵的主人可接受/拒绝
- [ ] 好友列表正确显示，支持排序和分页
- [ ] 五种互动类型（拜访、送礼、探险、合影、训练）正常工作
- [ ] 亲密度计算正确，等级提升准确触发奖励
- [ ] 冷却时间正确执行，防止滥用
- [ ] 好友等级奖励正确发放
- [ ] 纪念品系统正常工作
- [ ] WebSocket 实时通知好友申请和等级提升
- [ ] 前端UI显示好友关系、互动按钮、亲密度进度条
- [ ] 数据库索引优化查询性能
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试覆盖主流程

## 影响范围

- `database/migrations/` - 新增三张表
- `pokemon-service/` - 精灵好友关系管理
- `social-service/` - 好友申请通知
- `user-service/` - 用户精灵关系验证
- `gateway/` - API 路由和 WebSocket 通知
- `game-client/` - 好友列表UI、互动界面
- `backend/shared/` - 亲密度计算器、奖励系统

## 参考

- Pokemon GO Buddy System
- Animal Crossing Friendship Mechanics
- 类似需求：REQ-00048 精灵好友系统与社交互动增强
