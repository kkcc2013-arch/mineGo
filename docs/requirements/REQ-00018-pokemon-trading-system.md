# REQ-00018：精灵交易系统

- **编号**：REQ-00018
- **类别**：功能增强
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：social-service、pokemon-service、user-service、gateway、game-client
- **创建时间**：2026-06-05 09:50
- **依赖需求**：REQ-00001（Redis GEO 缓存）、REQ-00003（支付安全）

## 1. 背景与问题

mineGo 当前缺少精灵交易功能，用户无法交换精灵：

### 1.1 用户需求

1. **社交互动缺失**：用户希望能与好友交换精灵，增强社交体验
2. **收集困难**：某些精灵稀有，用户希望通过交易获得
3. **价值变现**：用户培养的高价值精灵无法交易
4. **游戏深度不足**：缺少交易系统降低游戏可玩性

### 1.2 竞品分析

| 游戏 | 交易方式 | 限制 | 用户满意度 |
|------|---------|------|-----------|
| Pokémon GO | 好友交易、距离限制 | 星尘消耗、距离限制 | 高 |
| Ingress | 无法交易 | - | 低 |
| Monster Hunter | 自由交易 | 等级限制 | 中 |

**最佳实践**：好友交易 + 距离限制 + 消耗机制

## 2. 目标

实现完整的精灵交易系统：

1. **好友交易**：仅好友间可交易
2. **距离限制**：交易双方需在一定距离内（100 米）
3. **公平机制**：防止一方欺诈，双方确认才完成
4. **消耗机制**：交易消耗星尘，稀有度越高消耗越大
5. **交易历史**：记录所有交易，支持查询
6. **防作弊**：防止刷交易、洗钱等作弊行为

## 3. 范围

### 包含
- 交易请求和确认流程
- 距离验证
- 星尘消耗计算
- 交易历史记录
- 交易限制（每日次数、等级要求）
- 防作弊机制

### 不包含
- 公共市场交易（可在后续需求处理）
- 精灵拍卖
- 跨服交易

## 4. 详细需求

### 4.1 交易流程设计

#### 4.1.1 交易状态机
```
INIT → PENDING → CONFIRMED → COMPLETED
       ↓           ↓
       CANCELLED   CANCELLED
```

#### 4.1.2 交易请求 API
```javascript
// backend/services/social-service/src/routes/trade.js
router.post('/trade/request', authenticate, async (req, res) => {
  const { friendId, myPokemonId, theirPokemonId } = req.body;
  const userId = req.user.id;

  // 1. 验证好友关系
  const isFriend = await checkFriendship(userId, friendId);
  if (!isFriend) {
    return res.status(403).json({ error: 'Can only trade with friends' });
  }

  // 2. 验证精灵所有权
  const myPokemon = await getPokemon(userId, myPokemonId);
  const theirPokemon = await getPokemon(friendId, theirPokemonId);
  
  if (!myPokemon || !theirPokemon) {
    return res.status(404).json({ error: 'Pokemon not found' });
  }

  // 3. 验证距离（通过 Redis GEO）
  const distance = await getUserDistance(userId, friendId);
  if (distance > 100) {
    return res.status(400).json({ 
      error: 'Too far apart',
      distance,
      maxDistance: 100
    });
  }

  // 4. 计算星尘消耗
  const stardustCost = calculateStardustCost(myPokemon, theirPokemon);
  
  // 5. 检查用户星尘余额
  const userStardust = await getUserStardust(userId);
  if (userStardust < stardustCost) {
    return res.status(400).json({ 
      error: 'Insufficient stardust',
      required: stardustCost,
      current: userStardust
    });
  }

  // 6. 创建交易请求
  const trade = await db.query(`
    INSERT INTO trades (
      initiator_id, recipient_id,
      initiator_pokemon_id, recipient_pokemon_id,
      stardust_cost, status, created_at
    ) VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW())
    RETURNING *
  `, [userId, friendId, myPokemonId, theirPokemonId, stardustCost]);

  // 7. 通知好友
  await eventBus.publish('trade.request', {
    tradeId: trade.id,
    from: userId,
    to: friendId,
    pokemon: theirPokemon
  });

  res.json({ success: true, trade });
});
```

### 4.2 星尘消耗计算

#### 4.2.1 消耗公式
```javascript
// backend/services/social-service/src/trade/stardust.js
function calculateStardustCost(pokemon1, pokemon2) {
  // 基础消耗
  const baseCost = 100;
  
  // 稀有度系数
  const rarityMultiplier = (
    getRarityMultiplier(pokemon1.rarity) +
    getRarityMultiplier(pokemon2.rarity)
  ) / 2;
  
  // CP 差异系数（差异越大，消耗越高）
  const cpDiff = Math.abs(pokemon1.cp - pokemon2.cp);
  const cpMultiplier = 1 + (cpDiff / 1000);
  
  // 好友等级折扣
  const friendLevelDiscount = getFriendLevelDiscount(pokemon1.friendLevel);
  
  // 最终消耗
  const cost = Math.floor(
    baseCost * rarityMultiplier * cpMultiplier * friendLevelDiscount
  );
  
  return Math.max(100, cost); // 最低 100 星尘
}

function getRarityMultiplier(rarity) {
  const multipliers = {
    'common': 1.0,
    'uncommon': 1.5,
    'rare': 2.0,
    'epic': 3.0,
    'legendary': 5.0
  };
  return multipliers[rarity] || 1.0;
}

function getFriendLevelDiscount(level) {
  const discounts = {
    'new': 1.0,      // 无折扣
    'good': 0.9,     // 9 折
    'great': 0.8,    // 8 折
    'ultra': 0.7,    // 7 折
    'best': 0.6      // 6 折
  };
  return discounts[level] || 1.0;
}
```

### 4.3 交易确认和完成

#### 4.3.1 交易确认 API
```javascript
// backend/services/social-service/src/routes/trade.js
router.post('/trade/:tradeId/confirm', authenticate, async (req, res) => {
  const { tradeId } = req.params;
  const userId = req.user.id;

  // 1. 获取交易
  const trade = await getTrade(tradeId);
  
  if (!trade) {
    return res.status(404).json({ error: 'Trade not found' });
  }
  
  if (trade.recipient_id !== userId) {
    return res.status(403).json({ error: 'Not your trade' });
  }
  
  if (trade.status !== 'PENDING') {
    return res.status(400).json({ error: 'Trade not pending' });
  }

  // 2. 再次验证距离（防止移动后交易）
  const distance = await getUserDistance(trade.initiator_id, userId);
  if (distance > 100) {
    return res.status(400).json({ error: 'Too far apart' });
  }

  // 3. 锁定交易（防止并发）
  const locked = await lockTrade(tradeId);
  if (!locked) {
    return res.status(409).json({ error: 'Trade being processed' });
  }

  try {
    // 4. 执行交易（事务）
    await db.transaction(async (client) => {
      // 扣除星尘
      await client.query(`
        UPDATE users SET stardust = stardust - $1
        WHERE id = $2
      `, [trade.stardust_cost, trade.initiator_id]);
      
      // 转移精灵
      await client.query(`
        UPDATE user_pokemon SET user_id = $1
        WHERE id = $2
      `, [trade.recipient_id, trade.initiator_pokemon_id]);
      
      await client.query(`
        UPDATE user_pokemon SET user_id = $1
        WHERE id = $2
      `, [trade.initiator_id, trade.recipient_pokemon_id]);
      
      // 更新交易状态
      await client.query(`
        UPDATE trades SET status = 'COMPLETED', completed_at = NOW()
        WHERE id = $1
      `, [tradeId]);
    });

    // 5. 发送通知
    await eventBus.publish('trade.completed', {
      tradeId,
      initiator: trade.initiator_id,
      recipient: trade.recipient_id
    });

    res.json({ success: true, trade });
  } catch (err) {
    // 回滚
    await unlockTrade(tradeId);
    throw err;
  }
});
```

### 4.4 交易限制

#### 4.4.1 每日交易限制
```javascript
// backend/services/social-service/src/trade/limits.js
const TradeLimits = {
  maxDailyTrades: 100,        // 每日最多 100 次交易
  minFriendLevel: 'good',     // 最低好友等级
  minPokemonLevel: 10,        // 精灵最低等级
  cooldownBetweenTrades: 60000 // 同一人交易冷却 1 分钟
};

async function checkTradeLimits(userId, friendId) {
  // 1. 每日交易次数
  const dailyCount = await db.query(`
    SELECT COUNT(*) FROM trades
    WHERE initiator_id = $1
    AND created_at >= CURRENT_DATE
  `, [userId]);
  
  if (dailyCount >= TradeLimits.maxDailyTrades) {
    return { allowed: false, reason: 'Daily trade limit reached' };
  }

  // 2. 好友等级
  const friendship = await getFriendship(userId, friendId);
  if (friendship.level < TradeLimits.minFriendLevel) {
    return { allowed: false, reason: 'Friend level too low' };
  }

  // 3. 冷却时间
  const lastTrade = await db.query(`
    SELECT created_at FROM trades
    WHERE (initiator_id = $1 AND recipient_id = $2)
    OR (initiator_id = $2 AND recipient_id = $1)
    ORDER BY created_at DESC LIMIT 1
  `, [userId, friendId]);
  
  if (lastTrade) {
    const elapsed = Date.now() - lastTrade.created_at.getTime();
    if (elapsed < TradeLimits.cooldownBetweenTrades) {
      return { 
        allowed: false, 
        reason: 'Trade cooldown',
        remaining: TradeLimits.cooldownBetweenTrades - elapsed
      };
    }
  }

  return { allowed: true };
}
```

### 4.5 交易历史

#### 4.5.1 交易历史 API
```javascript
// backend/services/social-service/src/routes/trade.js
router.get('/trade/history', authenticate, async (req, res) => {
  const userId = req.user.id;
  const { limit = 50, offset = 0 } = req.query;

  const trades = await db.query(`
    SELECT 
      t.id,
      t.initiator_id,
      t.recipient_id,
      t.initiator_pokemon_id,
      t.recipient_pokemon_id,
      t.stardust_cost,
      t.status,
      t.created_at,
      t.completed_at,
      u1.username as initiator_name,
      u2.username as recipient_name,
      p1.name as initiator_pokemon_name,
      p2.name as recipient_pokemon_name
    FROM trades t
    JOIN users u1 ON t.initiator_id = u1.id
    JOIN users u2 ON t.recipient_id = u2.id
    JOIN user_pokemon up1 ON t.initiator_pokemon_id = up1.id
    JOIN user_pokemon up2 ON t.recipient_pokemon_id = up2.id
    JOIN pokemon p1 ON up1.pokemon_id = p1.id
    JOIN pokemon p2 ON up2.pokemon_id = p2.id
    WHERE t.initiator_id = $1 OR t.recipient_id = $1
    ORDER BY t.created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);

  res.json(trades.rows);
});
```

### 4.6 防作弊机制

#### 4.6.1 异常交易检测
```javascript
// backend/services/social-service/src/trade/antiCheat.js
async function detectSuspiciousTrade(trade) {
  const flags = [];

  // 1. 价值严重不对等
  const valueDiff = Math.abs(
    getPokemonValue(trade.initiator_pokemon_id) -
    getPokemonValue(trade.recipient_pokemon_id)
  );
  
  if (valueDiff > 10000) {
    flags.push({ type: 'VALUE_IMBALANCE', severity: 'high', valueDiff });
  }

  // 2. 频繁交易同一精灵
  const recentTrades = await getRecentPokemonTrades(trade.initiator_pokemon_id, 7);
  if (recentTrades.length > 3) {
    flags.push({ type: 'FREQUENT_TRADE', severity: 'medium', count: recentTrades.length });
  }

  // 3. 新账号大量交易
  const accountAge = await getAccountAge(trade.initiator_id);
  const totalTrades = await getTotalTrades(trade.initiator_id);
  
  if (accountAge < 7 && totalTrades > 50) {
    flags.push({ type: 'NEW_ACCOUNT_SPAM', severity: 'high' });
  }

  // 4. 记录可疑交易
  if (flags.length > 0) {
    await db.query(`
      INSERT INTO suspicious_trades (trade_id, flags, created_at)
      VALUES ($1, $2, NOW())
    `, [trade.id, JSON.stringify(flags)]);
    
    // 发送告警
    await alertService.send({
      type: 'suspicious_trade',
      tradeId: trade.id,
      flags
    });
  }

  return flags;
}
```

### 4.7 前端实现

#### 4.7.1 交易界面
```javascript
// frontend/game-client/src/components/TradePanel.js
class TradePanel {
  constructor(friendId) {
    this.friendId = friendId;
    this.selectedMyPokemon = null;
    this.selectedTheirPokemon = null;
  }

  async requestTrade() {
    try {
      const response = await fetch('/api/trade/request', {
        method: 'POST',
        body: JSON.stringify({
          friendId: this.friendId,
          myPokemonId: this.selectedMyPokemon.id,
          theirPokemonId: this.selectedTheirPokemon.id
        })
      });

      const data = await response.json();
      
      if (data.success) {
        this.showWaitingConfirmation(data.trade);
      } else {
        this.showError(data.error);
      }
    } catch (err) {
      this.showError('Network error');
    }
  }

  showWaitingConfirmation(trade) {
    // 显示等待确认界面
    // 包含：交易详情、星尘消耗、取消按钮
  }
}
```

## 5. 验收标准（可测试）

- [ ] 好友间可发起交易请求
- [ ] 非好友无法交易
- [ ] 距离 > 100 米无法交易
- [ ] 星尘消耗计算正确（基础 × 稀有度 × CP差异 × 好友折扣）
- [ ] 星尘不足无法交易
- [ ] 交易需双方确认才完成
- [ ] 交易完成后精灵正确转移
- [ ] 每日交易限制生效（最多 100 次）
- [ ] 好友等级限制生效（最低 good）
- [ ] 交易冷却时间生效（同一人 1 分钟）
- [ ] 交易历史可查询
- [ ] 异常交易检测正常（价值不对等、频繁交易）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证完整交易流程
- [ ] 性能测试：交易请求响应 < 500ms

## 6. 工作量估算

**L (Large)**

- 交易流程实现：2 天
- 星尘消耗计算：0.5 天
- 交易限制和冷却：0.5 天
- 防作弊机制：1 天
- 前端界面：1.5 天
- 测试和验证：1 天

**总计：6.5 天**

## 7. 优先级理由

**P1** 理由：

1. **核心社交功能**：交易是精灵游戏的核心社交玩法
2. **用户需求强烈**：用户反馈希望有交易功能
3. **提升留存率**：交易增加用户互动，提升留存
4. **增加游戏深度**：交易策略、价值评估增加可玩性
5. **竞品标配**：主流精灵游戏都有交易功能

这是重要的功能增强，应优先实施。
