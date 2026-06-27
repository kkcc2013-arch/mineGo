# REQ-00327：玩家个人资料与数据统计展示系统

- **编号**：REQ-00327
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、pokemon-service、social-service、gateway、game-client、frontend/game-client/src/components、database/migrations
- **创建时间**：2026-06-27 00:42 UTC
- **依赖需求**：REQ-00076（成就系统）、REQ-00056（图鉴完成度）、REQ-00055（收藏展示）

## 1. 背景与问题

当前 mineGo 项目缺乏玩家个人资料页面和游戏数据统计展示功能：

1. **无个人资料入口**：玩家无法查看自己的综合游戏数据，包括捕捉统计、道馆战绩、社交活跃度等核心信息
2. **数据分散难以汇总**：玩家数据分散在各个微服务中（pokemon-service 捕捉数据、gym-service 战斗数据、social-service 社交数据），缺乏统一的聚合展示
3. **社交展示缺失**：好友之间无法查看对方的玩家卡片和游戏成就，降低了社交互动的趣味性
4. **缺少收藏家等级系统**：玩家收集精灵的努力缺乏量化的等级评估和展示

## 2. 目标

构建完整的玩家个人资料与数据统计展示系统，提供：

1. 玩家个人资料页面，展示核心游戏数据统计
2. 玩家收藏家等级系统，基于精灵收集进度和成就
3. 可分享的玩家卡片，支持社交展示
4. 数据可视化展示，包括图表和进度条

## 3. 范围

### 包含：
- user-service 新增玩家资料 API（/users/:id/profile）
- 数据统计聚合服务（捕捉、战斗、社交、探索）
- 收藏家等级计算与展示系统
- game-client 玩家资料页面组件
- 玩家卡片生成与分享功能
- 数据库迁移脚本

### 不包含：
- 第三方社交平台分享（后续扩展）
- 详细战斗回放功能
- 隐私设置（已有 REQ-00228）

## 4. 详细需求

### 4.1 数据聚合服务

在 user-service 中实现 `ProfileStatsService`：

```javascript
// 聚合数据结构
{
  player: {
    id: string,
    nickname: string,
    avatar: string,
    level: number,
    team: string,
    title: string,          // 当前激活称号
    collectorRank: string,  // 收藏家等级
    collectorScore: number
  },
  stats: {
    pokemon: {
      totalCaught: number,
      uniqueSpecies: number,
      shinyCount: number,
      perfectIV: number,      // IV 100% 数量
      highestCP: number,
      favoriteSpecies: string
    },
    battle: {
      gymBattles: number,
      gymWins: number,
      raidParticipated: number,
      raidWins: number,
      currentGymDefenders: number
    },
    social: {
      friendsCount: number,
      giftsSent: number,
      giftsReceived: number,
      tradesCompleted: number
    },
    exploration: {
      pokeStopsVisited: number,
      kmWalked: number,
      regionsExplored: number,
      rareEncounters: number
    }
  },
  achievements: {
    unlocked: number,
    total: number,
    recent: Array<{id, name, unlockedAt}>
  },
  pokedex: {
    seen: number,
    caught: number,
    total: number,
    completionRate: number
  }
}
```

### 4.2 收藏家等级系统

定义收藏家等级与积分规则：

| 等级 | 名称 | 所需积分 | 特权 |
|------|------|----------|------|
| 1 | 初学者 | 0 | 基础资料展示 |
| 2 | 收藏家 | 500 | 展示精灵数量+2 |
| 3 | 资深收藏家 | 2000 | 稀有精灵边框 |
| 4 | 精灵学者 | 5000 | 自定义资料背景 |
| 5 | 传奇收藏家 | 10000 | 专属称号解锁 |

积分来源：
- 精灵种类收集：每新种类 +10 分
- 闪光精灵：每只 +50 分
- 完美 IV：每只 +30 分
- 图鉴完成里程碑：每 10% +100 分
- 成就解锁：根据成就稀有度 +5~50 分

### 4.3 API 设计

```
GET /users/:id/profile
  - 返回玩家完整资料数据
  - 支持隐私过滤（非好友只能看公开数据）

GET /users/:id/profile/card
  - 返回可分享的玩家卡片图片 URL

GET /users/me/stats/summary
  - 返回当前用户统计数据摘要

POST /users/me/profile/title
  - 设置展示称号

GET /leaderboard/collectors
  - 收藏家积分排行榜
```

### 4.4 前端组件

```
frontend/game-client/src/components/
├── PlayerProfile/
│   ├── index.js              # 主页面入口
│   ├── ProfileHeader.js      # 玩家头像、等级、称号
│   ├── CollectorBadge.js     # 收藏家等级徽章
│   ├── StatsGrid.js          # 数据统计网格
│   ├── PokedexProgress.js    # 图鉴进度（复用现有）
│   ├── AchievementShowcase.js # 成就展示
│   ├── PlayerCard.js         # 可分享卡片
│   └── ProfileStats.css      # 样式文件
```

### 4.5 数据库设计

```sql
-- 收藏家积分记录
CREATE TABLE collector_scores (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 1,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  score_breakdown JSONB DEFAULT '{}'
);

-- 资料访问日志
CREATE TABLE profile_views (
  id SERIAL PRIMARY KEY,
  viewer_id UUID REFERENCES users(id),
  profile_user_id UUID REFERENCES users(id),
  viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 5. 验收标准（可测试）

- [ ] GET /users/:id/profile 返回完整玩家资料数据
- [ ] 收藏家等级根据积分规则正确计算
- [ ] 玩家资料页面正确渲染所有统计数据
- [ ] 玩家卡片支持导出为图片格式
- [ ] 非好友用户访问资料时应用隐私过滤
- [ ] 收藏家排行榜正确排序并缓存
- [ ] 资料数据变更后缓存正确更新
- [ ] 前端组件通过单元测试覆盖

## 6. 工作量估算

**L (Large)**

理由：
- 需要跨多个微服务聚合数据（3-4 个服务）
- 前端组件开发较多（6+ 个组件）
- 收藏家等级系统需要设计积分规则和计算逻辑
- 涉及数据库迁移和缓存策略

## 7. 优先级理由

P1 优先级理由：

1. **核心社交体验**：玩家资料是社交互动的基础功能，缺失会严重影响用户粘性
2. **数据价值可视化**：玩家投入的时间和精力需要通过统计数据得到认可和展示
3. **收藏激励**：收藏家等级系统提供持续的游戏目标，增加留存率
4. **成熟度提升**：当前核心功能完整度已达 24/25，此功能将填补个人展示的重要缺口
