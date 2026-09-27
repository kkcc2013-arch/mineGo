# REQ-00326: 精灵好友互动系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00326 |
| 标题 | 精灵好友互动系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
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

## 实现记录（2026-09-24）

> 与 REQ-00048/00228/00377/00388 共用 E01 好友实现。状态 `implemented`：规则调整前已在隔离 CI 栈实测 `smoke-friends`（精灵好友 12 项）
> 与单元测试通过；前端精灵好友界面只做了静态检查，**待验证**。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 精灵可以发送好友申请，对方精灵的主人可接受/拒绝 | ✅ | `POST /v1/pokemon/:pokemonId/friend-request {friendPokemonId, message}`（只能向玩家好友的精灵申请；对方精灵隐藏/拉黑时 404；对方已先申请则直接成为朋友）；`GET /v1/pokemon/friendships/requests`；`PUT /v1/pokemon/friendships/:id/status {action: accept|reject|block}`（仅对方主人可接受/拒绝，任一方可屏蔽） |
| 好友列表正确显示，支持排序和分页 | ✅ | `GET /v1/pokemon/:pokemonId/friends?page&limit&sortBy=intimacy|level|recent`：对方精灵按可见性规则（REQ-00377）展示，含等级、亲密度、下一级阈值、互动次数；主人还能看到五种互动的剩余冷却 |
| 五种互动类型（拜访、送礼、探险、合影、训练）正常工作 | ✅ | `POST /v1/pokemon/friendships/:id/interact {type}`，基础值 10/20/50/5/30 |
| 亲密度计算正确，等级提升准确触发奖励 | ✅ | `shared/social/intimacyCalculator.js`：基础值 × 等级倍率（1.0–4.0）× 加成（同种 ×1.5、属性相合 ×1.2、跨区域捕获地相距 ≥100km ×1.3、3/9 级奖励加成 ×1.1/×1.3）；阈值 0/100/300/600/1000/1500/2100/2800/3600/4500/5500，一次跨多级逐级发奖 |
| 冷却时间正确执行，防止滥用 | ✅ | 拜访 1h、送礼 24h、探险 7 天、合影 2h、训练 12h，按“主人 × 互动类型”独立计时；事务内对好友关系行 `FOR UPDATE`，并发重复点击只成功一次（429 并提示剩余秒数） |
| 好友等级奖励正确发放 | ✅ | 1–10 级奖励（徽章/丝带/亲密度加成/高级礼物/奖章/探险加成/联合训练/王冠/全面加成/灵魂羁绊）为双方精灵各记一条 `pokemon_friendship_rewards`（唯一约束保证幂等），加成类奖励带 7 天有效期并在计算亲密度时生效；详情接口 `GET /v1/pokemon/friendships/:id` 返回已获奖励 |
| 纪念品系统正常工作 | ✅ | 合影必得纪念照（5 级以上稀有）、探险 30% 概率得纪念品、2/5/8 级奖励的丝带/奖章/王冠；`GET /v1/pokemon/friendships/:id/keepsakes` |
| WebSocket 实时通知好友申请和等级提升 | ✅ | pokemon-service 经 Redis 频道 `social:events` 发布 `pokemon_friend_request`、`pokemon_friend_accepted`、`pokemon_friendship_level_up`，由 social-service 的 `/ws/friends` 推送给双方主人，并写提醒中心 |
| 前端UI显示好友关系、互动按钮、亲密度进度条 | ✅ | `FriendsScreen.js`「精灵」页：精灵好友申请审批、每位精灵好友的亲密度进度条与等级、五个互动按钮（冷却中显示剩余时间并禁用）、纪念品、从好友的公开精灵中选择发起申请（未在浏览器中验证） |
| 数据库索引优化查询性能 | ✅ | 精灵对唯一索引 `(LEAST, GREATEST)`、`(pokemon_id,status)`、`(friend_pokemon_id,status)`、`(addressee_user_id,status)`、冷却查询 `(friendship_id, interaction_type, actor_user_id, created_at DESC)`、纪念品 `(friendship_id, created_at DESC)` |
| 单元测试覆盖率 > 80% | ✅ | `node --experimental-test-coverage`：`intimacyCalculator.js` 100% 行、`pokemonPrivacyStore.js` 100%、`pokemonFriendService.js` 79.8% 行（其余为只读列表/申请分支，由冒烟覆盖）；E01 模块合计行覆盖约 90% |
| 集成测试覆盖主流程 | ✅ | `scripts/smoke-friends.js` 经网关：申请 → WebSocket 通知 → 非好友拒绝 → 申请方不能自接 → 接受发奖 → 五种互动 → 冷却 429 → 冷却按主人独立 → 并发互动只成功一次 → 跨阈值升级发奖与推送 → 纪念品 → 列表排序 |

- 入口：pokemon-service `src/routes/pokemonSocial.js`（先于其他 `/pokemon` 子路由挂载）、`src/services/pokemonFriendService.js`；网关沿用 `/v1/pokemon/*`（鉴权）
- 共用模块：`backend/shared/social/intimacyCalculator.js`（亲密度引擎与奖励表）、`socialEvents.js`（实时推送/提醒）
- 迁移：`database/migrations/20260925_100600__e01_friends_social.sql`（`pokemon_friendships`、`pokemon_interactions`、`pokemon_keepsakes`、`pokemon_friendship_rewards`；精灵外键指向 `pokemon_instances(id)` UUID）
- 测试：`cd backend && node --test tests/unit/friend-service.test.js tests/unit/friend-service-db.test.js`；`node scripts/smoke-friends.js`
- 偏差：文档中的 `pokemons` 表实际为 `pokemon_instances`；奖励表（`pokemon_badges/pokemon_inventory/pokemon_boosts/pokemon_unlocks/pokemon_special_abilities`）合并为 `pokemon_friendship_rewards` 一张表，丝带/奖章/王冠落到纪念品；精灵好友以“双方主人为玩家好友”为前提（防止陌生人骚扰）
- 待验证：① 前端精灵页的互动与冷却显示；② 升级推送在两个在线账号间的到达
