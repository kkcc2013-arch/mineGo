# REQ-00073：玩家对战系统（PVP Duel）

- **编号**：REQ-00073
- **类别**：功能增强
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：social-service、pokemon-service、user-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-10 01:25
- **依赖需求**：REQ-00054（道馆战斗系统）

## 1. 背景与问题

当前系统已实现道馆战斗系统（REQ-00054），但仅支持玩家与 NPC 的对战。缺少玩家之间的实时对战功能（PVP），这是 AR 精灵游戏的核心社交玩法之一。

现有问题：
1. **玩法单一**：玩家只能与 NPC 对战，缺少挑战性和社交互动
2. **竞技缺失**：没有排位系统，无法满足竞技玩家需求
3. **好友互动不足**：好友系统（REQ-00048）缺少深度互动玩法
4. **游戏生命周期短**：缺少 PVP 导致玩家达成图鉴后流失率高

代码现状：
- `backend/services/gym-service/src/battleEngine.js` 已有完整战斗引擎
- 战斗系统支持回合制、属性克制、状态效果
- 缺少 PVP 匹配、实时同步、排位系统

## 2. 目标

实现完整的玩家对战系统：

1. **实时对战**：WebSocket 同步，支持好友对战和随机匹配
2. **匹配系统**：ELO 排位匹配，分段保护
3. **战斗模式**：普通对战、排位赛、好友切磋
4. **奖励系统**：排位奖励、赛季结算
5. **观战功能**：支持好友观战

预期收益：
- 日活用户提升 30%+
- 社交互动频率提升 50%+
- 玩家留存率提升 40%+
- 竞技玩法带动社区活跃

## 3. 范围

- **包含**：
  - PVP 匹配系统（ELO 算法）
  - 实时对战 WebSocket 同步
  - 排位赛系统（段位、积分）
  - 好友对战邀请
  - 战斗回放保存
  - 排行榜
  - 赛季系统
  - 单元测试

- **不包含**：
  - 锦标赛系统（后续需求）
  - 双打/多打（后续需求）
  - 战斗直播（后续需求）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- PVP 对战记录表
CREATE TABLE pvp_battles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id INTEGER NOT NULL REFERENCES users(id),
  defender_id INTEGER NOT NULL REFERENCES users(id),
  battle_type VARCHAR(20) NOT NULL, -- 'friendly' | 'ranked' | 'casual'
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'in_progress' | 'completed' | 'cancelled'
  winner_id INTEGER REFERENCES users(id),
  battle_data JSONB, -- 完整战斗数据
  turns INTEGER DEFAULT 0,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- PVP 排位积分表
CREATE TABLE pvp_rankings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  elo_rating INTEGER NOT NULL DEFAULT 1000,
  tier VARCHAR(20) NOT NULL DEFAULT 'bronze', -- bronze/silver/gold/platinum/diamond/master/grandmaster
  tier_points INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  season_id INTEGER NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- PVP 赛季表
CREATE TABLE pvp_seasons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  rewards JSONB, -- 赛季奖励配置
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- PVP 队伍配置表
CREATE TABLE pvp_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  name VARCHAR(50),
  pokemon_ids INTEGER[] NOT NULL, -- 3 只精灵
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- PVP 战斗回放表
CREATE TABLE pvp_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id UUID NOT NULL REFERENCES pvp_battles(id),
  replay_data JSONB NOT NULL, -- 完整回放数据
  views INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_pvp_battles_attacker ON pvp_battles(attacker_id);
CREATE INDEX idx_pvp_battles_defender ON pvp_battles(defender_id);
CREATE INDEX idx_pvp_battles_status ON pvp_battles(status);
CREATE INDEX idx_pvp_rankings_elo ON pvp_rankings(elo_rating DESC);
CREATE INDEX idx_pvp_rankings_tier ON pvp_rankings(tier);
```

### 4.2 ELO 匹配算法

```javascript
// backend/shared/pvpMatching.js
const { logger } = require('./logger');

/**
 * ELO 排位匹配系统
 */
class PVPMatchingEngine {
  constructor() {
    this.waitingQueue = new Map(); // userId -> { rating, joinedAt, preferences }
    this.matchingInterval = 5000; // 5秒匹配一次
  }
  
  /**
   * 计算 ELO 变化
   */
  calculateEloChange(winnerRating, loserRating, kFactor = 32) {
    const expectedWin = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedLose = 1 - expectedWin;
    
    return {
      winnerChange: Math.round(kFactor * (1 - expectedWin)),
      loserChange: Math.round(kFactor * (0 - expectedLose))
    };
  }
  
  /**
   * 查找匹配对手
   */
  findMatch(userId, rating, preferences = {}) {
    const maxRatingDiff = preferences.maxRatingDiff || 200;
    const maxWaitTime = preferences.maxWaitTime || 60000; // 1分钟
    
    // 清理超时等待者
    this.cleanupWaitingQueue(maxWaitTime);
    
    // 查找最佳匹配
    let bestMatch = null;
    let bestScore = Infinity;
    
    for (const [opponentId, data] of this.waitingQueue) {
      if (opponentId === userId) continue;
      
      const ratingDiff = Math.abs(data.rating - rating);
      if (ratingDiff > maxRatingDiff) continue;
      
      // 评分：rating差异 + 等待时间加成
      const waitBonus = (Date.now() - data.joinedAt) / 1000;
      const score = ratingDiff - waitBonus * 5;
      
      if (score < bestScore) {
        bestScore = score;
        bestMatch = opponentId;
      }
    }
    
    if (bestMatch) {
      this.waitingQueue.delete(bestMatch);
      return bestMatch;
    }
    
    // 加入等待队列
    this.waitingQueue.set(userId, {
      rating,
      joinedAt: Date.now(),
      preferences
    });
    
    return null;
  }
  
  /**
   * 段位计算
   */
  calculateTier(eloRating) {
    if (eloRating >= 2400) return { tier: 'grandmaster', stars: Math.floor((eloRating - 2400) / 50) };
    if (eloRating >= 2000) return { tier: 'master', stars: Math.floor((eloRating - 2000) / 50) };
    if (eloRating >= 1600) return { tier: 'diamond', stars: Math.floor((eloRating - 1600) / 50) };
    if (eloRating >= 1300) return { tier: 'platinum', stars: Math.floor((eloRating - 1300) / 50) };
    if (eloRating >= 1000) return { tier: 'gold', stars: Math.floor((eloRating - 1000) / 50) };
    if (eloRating >= 700) return { tier: 'silver', stars: Math.floor((eloRating - 700) / 50) };
    return { tier: 'bronze', stars: Math.floor(eloRating / 50) };
  }
  
  /**
   * 清理超时等待者
   */
  cleanupWaitingQueue(maxWaitTime) {
    const now = Date.now();
    for (const [userId, data] of this.waitingQueue) {
      if (now - data.joinedAt > maxWaitTime * 2) {
        this.waitingQueue.delete(userId);
      }
    }
  }
}

module.exports = new PVPMatchingEngine();
```

### 4.3 实时对战 WebSocket

```javascript
// backend/services/social-service/src/pvpWebSocket.js
const WebSocket = require('ws');
const { logger } = require('../../../shared/logger');
const pvpMatching = require('../../../shared/pvpMatching');

class PVPBattleRoom {
  constructor(battleId, player1, player2) {
    this.battleId = battleId;
    this.players = new Map([
      [player1.id, { ws: player1.ws, team: player1.team, ready: false }],
      [player2.id, { ws: player2.ws, team: player2.team, ready: false }]
    ]);
    this.currentTurn = player1.id;
    this.turnNumber = 0;
    this.battleLog = [];
  }
  
  /**
   * 处理回合
   */
  handleTurn(playerId, action) {
    const player = this.players.get(playerId);
    const opponentId = [...this.players.keys()].find(id => id !== playerId);
    
    // 验证回合
    if (this.currentTurn !== playerId) {
      this.sendToPlayer(playerId, { type: 'error', message: '不是你的回合' });
      return;
    }
    
    // 记录行动
    this.battleLog.push({
      turn: this.turnNumber,
      player: playerId,
      action
    });
    
    // 广播行动
    this.broadcast({
      type: 'turn_action',
      playerId,
      action,
      turnNumber: this.turnNumber
    });
    
    // 切换回合
    this.currentTurn = opponentId;
    this.turnNumber++;
    
    // 通知对手
    this.sendToPlayer(opponentId, {
      type: 'your_turn',
      turnNumber: this.turnNumber
    });
  }
  
  /**
   * 广播消息
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const [_, player] of this.players) {
      player.ws.send(data);
    }
  }
  
  /**
   * 发送给指定玩家
   */
  sendToPlayer(playerId, message) {
    const player = this.players.get(playerId);
    if (player && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  }
}

module.exports = { PVPBattleRoom };
```

### 4.4 API 端点

```
POST   /api/pvp/match/join        # 加入匹配队列
DELETE /api/pvp/match/leave       # 离开匹配队列
POST   /api/pvp/battle/start      # 开始对战（好友）
POST   /api/pvp/battle/:id/action # 提交回合行动
POST   /api/pvp/battle/:id/surrender # 认输
GET    /api/pvp/ranking           # 获取排位信息
GET    /api/pvp/leaderboard       # 排行榜
GET    /api/pvp/history           # 对战历史
GET    /api/pvp/replay/:id        # 获取回放
POST   /api/pvp/team              # 保存 PVP 队伍
GET    /api/pvp/team              # 获取 PVP 队伍
GET    /api/pvp/season            # 赛季信息
```

### 4.5 段位与奖励

| 段位 | ELO 范围 | 赛季奖励 |
|------|----------|----------|
| Grandmaster | 2400+ | 传说精灵蛋、5000 精币、专属称号 |
| Master | 2000-2399 | 史诗精灵蛋、3000 精币、专属头像框 |
| Diamond | 1600-1999 | 稀有精灵蛋、2000 精币 |
| Platinum | 1300-1599 | 高级精灵球 x10、1000 精币 |
| Gold | 1000-1299 | 高级精灵球 x5、500 精币 |
| Silver | 700-999 | 精灵球 x10、200 精币 |
| Bronze | 0-699 | 精灵球 x5、100 精币 |

## 5. 验收标准（可测试）

- [ ] 玩家可通过匹配系统找到对手
- [ ] 匹配时间 < 60 秒（活跃时段）
- [ ] ELO 计算正确，胜者得分、败者扣分
- [ ] 实时对战延迟 < 100ms
- [ ] 支持 3 种战斗模式（好友/排位/普通）
- [ ] 段位系统正确更新
- [ ] 排行榜实时更新
- [ ] 赛季结算正确发放奖励
- [ ] 战斗回放可观看
- [ ] 单元测试覆盖率 ≥ 85%

## 6. 工作量估算

**XL（Extra Large）**，约 5-7 天

理由：
- 涉及多个服务协调
- WebSocket 实时同步复杂
- ELO 匹配算法需调优
- 排位系统需要完整测试
- 赛季系统需要定时任务

## 7. 优先级理由

**P0 理由**：
1. PVP 是核心玩法，对用户留存至关重要
2. 已有战斗引擎基础（REQ-00054），可复用
3. 竞技玩法是手游标配，缺失影响产品竞争力
4. 社交属性增强，带动好友系统活跃
5. 对"项目可用"贡献：核心功能完整度
