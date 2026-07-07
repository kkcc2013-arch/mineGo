# REQ-00487：精灵竞技联赛系统

- **编号**：REQ-00487
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、social-service、reward-service、battle-service、frontend/game-client、database/migrations
- **创建时间**：2026-07-07 15:00
- **依赖需求**：REQ-00073（PVP战斗系统）、REQ-00331（数据库索引优化）

## 1. 背景与问题

mineGo 目前实现了 PVP 战斗系统（REQ-00073），玩家可以进行实时对战，但缺乏正式的竞技联赛机制。当前问题：

1. **缺乏正式赛事结构**：玩家对战缺乏联赛等级划分、积分排名和赛季机制，仅依赖简单的排行榜（REQ-00074）
2. **比赛参与度低**：没有联赛分组、晋级/降级机制，玩家对战意愿和持续性不足
3. **奖励体系单一**：战斗奖励不够丰富，缺乏联赛专属奖励、赛季奖励、排名奖励等激励机制
4. **缺少联赛社交属性**：联赛成员互动、战队组织、联赛公告等社交功能缺失

精灵竞技联赛是游戏核心玩法的重要扩展，能够显著提升玩家粘性和对战活跃度。

## 2. 目标

构建完整的精灵竞技联赛系统，实现：

- **联赛分级体系**：创建青铜/白银/黄金/铂金/钻石/大师6个联赛等级，每个等级3个分组（I/II/III）
- **赛季循环机制**：每个赛季28天，赛季末结算奖励、升降级调整
- **积分与排名系统**：胜负积分计算、连胜奖励、连胜保护、真实实力评估算法
- **联赛匹配优化**：基于联赛等级和真实实力评分的智能匹配
- **丰富奖励体系**：联赛积分奖励、赛季排名奖励、晋级奖励、连胜奖励、联赛专属道具
- **联赛社交功能**：联赛公告、联赛排行榜、联赛成员互动、战队联赛功能

## 3. 范围

- **包含**：
  - 联赛等级定义和分组结构设计
  - 赛季时间管理和自动轮换机制
  - 积分计算算法（胜/负/连胜/保护）
  - 真实实力评分算法（类似ELO/Glicko-2）
  - 升降级判定逻辑和执行
  - 联赛匹配算法优化
  - 联赛奖励发放系统
  - 联赛排行榜和成员信息展示
  - 联赛数据库表设计和索引优化
  - API 接口实现（联赛信息、排名、赛季状态、升降级历史）
  - 游戏客户端联赛界面和赛季倒计时

- **不包含**：
  - 现有 PVP 战斗逻辑修改（依赖 REQ-00073）
  - 实时战斗同步机制（已有 WebSocket 系统）
  - 排行榜全局展示（已有 REQ-00074，联赛排行榜为子集）
  - 战队联赛功能（后续需求扩展）

## 4. 详细需求

### 4.1 联赛等级体系

```javascript
const LEAGUE_LEVELS = {
  BRONZE: { name: '青铜联赛', minPoints: 0, maxPoints: 999, groups: ['I', 'II', 'III'], rewards: { seasonEnd: 100, promotion: 50 } },
  SILVER: { name: '白银联赛', minPoints: 1000, maxPoints: 1999, groups: ['I', 'II', 'III'], rewards: { seasonEnd: 200, promotion: 100 } },
  GOLD: { name: '黄金联赛', minPoints: 2000, maxPoints: 2999, groups: ['I', 'II', 'III'], rewards: { seasonEnd: 300, promotion: 150 } },
  PLATINUM: { name: '铂金联赛', minPoints: 3000, maxPoints: 3999, groups: ['I', 'II', 'III'], rewards: { seasonEnd: 500, promotion: 200 } },
  DIAMOND: { name: '钻石联赛', minPoints: 4000, maxPoints: 4999, groups: ['I', 'II', 'III'], rewards: { seasonEnd: 800, promotion: 300 } },
  MASTER: { name: '大师联赛', minPoints: 5000, maxPoints: null, groups: ['I'], rewards: { seasonEnd: 1000, promotion: 0 } }
};
```

- 每个联赛等级包含3个分组（I/II/III），分组III为最低，分组I为最高
- 玩家初始联赛为青铜III
- 联赛积分范围决定当前等级和分组

### 4.2 赛季机制

```javascript
const SEASON_CONFIG = {
  durationDays: 28,  // 赛季持续28天
  breakDays: 2,      // 赛季间隔2天
  startTime: '2026-07-01T00:00:00Z',  // 赛季起始时间
  autoRotate: true   // 自动轮换
};
```

- 赛季开始：所有玩家联赛状态冻结，积分清零或部分继承
- 赛季进行：玩家对战获取积分，升降级动态调整
- 赛季结束：结算排名奖励，执行升降级判定

### 4.3 积分计算算法

```javascript
// 胜利积分
function calculateWinPoints(playerRating, opponentRating, isConsecutiveWin) {
  let basePoints = 25;
  const ratingDiff = opponentRating - playerRating;
  const ratingBonus = Math.max(0, Math.floor(ratingDiff / 100));
  
  // 连胜奖励：每连胜增加5分，上限25分
  const consecutiveBonus = isConsecutiveWin ? Math.min(25, consecutiveWins * 5) : 0;
  
  return basePoints + ratingBonus + consecutiveBonus;
}

// 失败积分
function calculateLossPoints(playerRating, opponentRating, consecutiveWins) {
  let baseLoss = 15;
  
  // 连胜保护：连胜3场以上，失败积分减少50%
  const protectionFactor = consecutiveWins >= 3 ? 0.5 : 1.0;
  
  return Math.floor(baseLoss * protectionFactor);
}

// 真实实力评分（ELO变体）
function updateTrueRating(playerRating, opponentRating, result, kFactor = 32) {
  const expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  const actual = result === 'win' ? 1 : 0;
  return playerRating + kFactor * (actual - expected);
}
```

### 4.4 升降级判定

```javascript
function determinePromotionOrDemotion(playerPoints, currentLeague, currentGroup) {
  const leagueDef = LEAGUE_LEVELS[currentLeague];
  
  // 升级判定：积分达到下一联赛下限
  if (playerPoints >= getNextLeagueMin(currentLeague)) {
    return { action: 'promote', newLeague: getNextLeague(currentLeague), newGroup: 'III' };
  }
  
  // 分组晋升：积分达到当前联赛分组I阈值
  if (currentGroup === 'III' && playerPoints >= leagueDef.minPoints + 333) {
    return { action: 'groupPromote', newGroup: 'II' };
  }
  if (currentGroup === 'II' && playerPoints >= leagueDef.minPoints + 666) {
    return { action: 'groupPromote', newGroup: 'I' };
  }
  
  // 降级判定：积分低于当前联赛下限
  if (playerPoints < leagueDef.minPoints) {
    return { action: 'demote', newLeague: getPreviousLeague(currentLeague), newGroup: 'I' };
  }
  
  return { action: 'stay' };
}
```

### 4.5 联赛匹配优化

```javascript
function findLeagueMatchmaker(playerId, playerLeague, playerRating) {
  // 匹配范围：同联赛 ±1分组，真实评分差 ±200
  const candidates = await db.query(`
    SELECT player_id, league_rating 
    FROM league_members 
    WHERE league_level = $1 
      AND league_group IN ($2, $3, $4)
      AND ABS(league_rating - $5) <= 200
      AND player_id != $6
      AND last_match_time < NOW() - INTERVAL '5 minutes'
    ORDER BY ABS(league_rating - $5) ASC
    LIMIT 20
  `, [playerLeague, playerGroup, getAdjacentGroups(playerGroup), playerRating, playerId]);
  
  return selectBestMatch(candidates);
}
```

### 4.6 联赛奖励系统

```javascript
const SEASON_REWARDS = {
  BRONZE: { coins: 100, items: ['basic_potion'], badge: 'bronze_season_badge' },
  SILVER: { coins: 200, items: ['super_potion', 'revive'], badge: 'silver_season_badge' },
  GOLD: { coins: 300, items: ['rare_candy', 'golden_berries'], badge: 'gold_season_badge' },
  PLATINUM: { coins: 500, items: ['legendary_candy', 'master_ball_fragment'], badge: 'platinum_season_badge' },
  DIAMOND: { coins: 800, items: ['exclusive_skin', 'master_ball'], badge: 'diamond_season_badge' },
  MASTER: { coins: 1000, items: ['legendary_encounter_ticket', 'exclusive_avatar'], badge: 'master_season_badge' }
};

// 联赛分组排名奖励（赛季末）
function distributeSeasonEndRewards(leagueLevel, finalRank) {
  const baseReward = SEASON_REWARDS[leagueLevel];
  const rankMultiplier = Math.max(1.5 - (finalRank / 100), 1.0);
  return {
    coins: Math.floor(baseReward.coins * rankMultiplier),
    items: baseReward.items,
    badge: baseReward.badge
  };
}
```

### 4.7 API 接口设计

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/league/info` | GET | 当前赛季信息、联赛等级列表、赛季倒计时 |
| `/api/league/player/:id` | GET | 玩家联赛信息：等级、分组、积分、真实评分、连胜场次 |
| `/api/league/ranking/:level/:group` | GET | 联赛分组排行榜（前100名） |
| `/api/league/history/:id` | GET | 玩家升降级历史、赛季参赛历史 |
| `/api/league/match/find` | POST | 查找联赛匹配对手 |
| `/api/league/match/result` | POST | 提交联赛对战结果（更新积分） |
| `/api/league/season/status` | GET | 当前赛季状态、剩余天数、结算预告 |
| `/api/league/season/history` | GET | 过去赛季历史列表 |
| `/api/league/rewards/pending` | GET | 待领取联赛奖励列表 |
| `/api/league/rewards/claim` | POST | 领取联赛奖励 |

### 4.8 数据库表设计

```sql
-- 联赛成员表
CREATE TABLE league_members (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  league_level VARCHAR(20) NOT NULL DEFAULT 'BRONZE',
  league_group VARCHAR(10) NOT NULL DEFAULT 'III',
  league_points INTEGER NOT NULL DEFAULT 0,
  league_rating INTEGER NOT NULL DEFAULT 1000,  -- 真实实力评分
  consecutive_wins INTEGER NOT NULL DEFAULT 0,
  season_id INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  last_match_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(player_id, season_id)
);

CREATE INDEX idx_league_members_season ON league_members(season_id, league_level, league_group);
CREATE INDEX idx_league_members_rating ON league_members(season_id, league_rating);
CREATE INDEX idx_league_members_player ON league_members(player_id);

-- 联赛赛季表
CREATE TABLE league_seasons (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  total_players INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_league_seasons_status ON league_seasons(status);

-- 联赛对战记录表
CREATE TABLE league_matches (
  id SERIAL PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES league_seasons(id),
  player1_id INTEGER NOT NULL,
  player2_id INTEGER NOT NULL,
  winner_id INTEGER,
  player1_points_change INTEGER,
  player2_points_change INTEGER,
  match_duration_seconds INTEGER,
  match_time TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_league_matches_season ON league_matches(season_id, match_time);
CREATE INDEX idx_league_matches_player ON league_matches(player1_id, player2_id);

-- 联赛升降级历史表
CREATE TABLE league_history (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  action VARCHAR(20) NOT NULL,  -- 'promote', 'demote', 'groupPromote', 'groupDemote'
  from_level VARCHAR(20),
  from_group VARCHAR(10),
  to_level VARCHAR(20),
  to_group VARCHAR(10),
  points_at_action INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_league_history_player ON league_history(player_id);
CREATE INDEX idx_league_history_season ON league_history(season_id);

-- 联赛奖励记录表
CREATE TABLE league_rewards (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  reward_type VARCHAR(20) NOT NULL,  -- 'seasonEnd', 'promotion', 'consecutiveWin'
  league_level VARCHAR(20) NOT NULL,
  final_rank INTEGER,
  reward_data JSONB NOT NULL,
  claimed BOOLEAN DEFAULT false,
  claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_league_rewards_player ON league_rewards(player_id, season_id);
CREATE INDEX idx_league_rewards_claimed ON league_rewards(player_id, claimed);
```

### 4.9 游戏客户端界面需求

- 联赛信息面板：显示当前联赛等级、分组、积分、真实评分
- 联赛排行榜：分组排行榜展示、个人排名指示
- 赛季倒计时：赛季剩余天数、赛季结束预告
- 联赛对战入口：快速匹配按钮、联赛对战按钮
- 升降级动画：晋级/降级视觉效果、祝贺/提示动画
- 联赛奖励领取：赛季奖励领取界面、奖励展示

## 5. 验收标准（可测试）

- [ ] 联赛等级定义正确，青铜到大师6个等级，每个等级3个分组
- [ ] 玩家初始联赛为青铜III，初始积分0，真实评分1000
- [ ] 赛季28天周期正确，自动轮换，赛季状态查询API正常工作
- [ ] 积分计算正确：胜利25分+评分差奖励+连胜奖励，失败15分（连胜保护）
- [ ] 真实实力评分算法（ELO变体）正确更新评分
- [ ] 升降级判定逻辑正确：积分达标自动晋级/分组晋升，积分不足自动降级
- [ ] 联赛匹配优化：匹配范围限制在同联赛±1分组、评分差±200
- [ ] 联赛排行榜正确展示分组前100名，实时更新
- [ ] 联赛奖励发放正确：赛季末结算、晋级奖励、连胜奖励
- [ ] API接口全部实现：9个接口正常工作，返回正确数据
- [ ] 数据库表结构正确：5个表、索引优化、查询性能良好
- [ ] 游戏客户端联赛界面正常显示：联赛信息、排行榜、赛季倒计时
- [ ] 单元测试覆盖：积分计算、升降级判定、匹配算法、奖励计算等核心逻辑测试覆盖率≥80%

## 6. 工作量估算

**L（Large）**

- 联赛等级体系和赛季机制设计：2天
- 积分计算和真实评分算法实现：2天
- 升降级逻辑和匹配优化：2天
- 奖励系统和API接口实现：2天
- 数据库表设计和索引优化：1天
- 游戏客户端界面实现：3天
- 测试和调优：2天

**总计：约12天**

## 7. 优先级理由

**P1（高优先级）**

精灵竞技联赛是游戏核心玩法的重要扩展，直接影响玩家对战活跃度和粘性。当前 PVP 系统已实现（REQ-00073），但缺乏正式赛事机制导致玩家对战持续性不足。联赛系统能够：

1. **提升玩家粘性**：赛季循环、升降级机制、排名奖励增加玩家长期参与意愿
2. **增强对战活跃度**：联赛匹配优化、积分激励、连胜奖励刺激对战频率
3. **丰富社交属性**：联赛排行榜、联赛成员互动增强社交体验
4. **扩展收入渠道**：联赛专属奖励、赛季奖励可结合付费道具增加收入

对"项目可用"的贡献：完善核心玩法，提升用户体验，增强游戏长期运营能力。