# REQ-00055: 精灵收藏展示系统

- **编号**：REQ-00055
- **类别**：功能增强
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：pokemon-service、social-service、user-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-09 16:35
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目已实现精灵捕捉、培育、交易等核心功能，但缺少一个重要的社交展示功能：**精灵收藏展示**。

现有痛点：
1. **玩家无法展示稀有精灵**：玩家捕捉到闪光精灵或高个体值精灵后，只能在好友列表中静态展示，无法获得社交认可
2. **缺少收藏系统**：玩家没有专门的收藏功能来标记和管理珍贵精灵
3. **社交互动不足**：好友之间缺少点赞、评论等轻量级互动方式
4. **激励机制缺失**：展示稀有精灵没有额外奖励，降低了收集动力

类似游戏（如 Pokemon GO）中，玩家可以设置"伙伴精灵"展示在个人资料页，并且可以收藏多个精灵组成展示队伍。

## 2. 目标

实现完整的精灵收藏展示系统，包括：

1. **收藏功能**：玩家可以标记最多 6 只精灵为"收藏"，收藏精灵在列表中高亮显示
2. **展示页面**：玩家个人资料页展示收藏的精灵，其他玩家可以查看
3. **社交互动**：其他玩家可以为展示的精灵点赞、留下评语
4. **奖励机制**：获得点赞可以获得奖励（金币、经验），激励玩家展示优质精灵
5. **排行榜**：展示"最受喜爱的精灵"排行榜，增加竞争性

预期收益：
- 提升社交互动频率 30%+
- 增加玩家留存率（收集和展示动机）
- 增强社区氛围

## 3. 范围

### 包含
- 收藏精灵管理（添加/移除收藏，最多 6 只）
- 个人资料页展示收藏精灵
- 点赞功能（每天最多点赞 20 次，防刷）
- 评语功能（每天最多 5 条，防刷）
- 点赞奖励系统（金币、经验）
- 精灵受欢迎度排行榜
- Prometheus 指标监控
- 单元测试和集成测试

### 不包含
- 精灵 3D 模型展示（已有 REQ-00027）
- 精灵交易功能（已有 REQ-00018）
- 精灵战斗统计展示（已在 REQ-00054 实现）
- 实时聊天系统（未来需求）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 精灵收藏表
CREATE TABLE pokemon_favorites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_order INTEGER DEFAULT 0 CHECK (display_order >= 0 AND display_order < 6),
    is_showcased BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, display_order),
    UNIQUE(user_id, pokemon_id)
);

-- 精灵点赞表
CREATE TABLE pokemon_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pokemon_id, user_id)
);

-- 精灵评语表
CREATE TABLE pokemon_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment TEXT NOT NULL CHECK (char_length(comment) >= 1 AND char_length(comment) <= 200),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 精灵展示统计表
CREATE TABLE pokemon_showcase_stats (
    pokemon_id UUID PRIMARY KEY REFERENCES pokemon(id) ON DELETE CASCADE,
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    last_liked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户点赞限额表（每日重置）
CREATE TABLE user_like_quotas (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    likes_today INTEGER DEFAULT 0,
    comments_today INTEGER DEFAULT 0,
    last_reset_date DATE DEFAULT CURRENT_DATE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_pokemon_favorites_user ON pokemon_favorites(user_id, display_order);
CREATE INDEX idx_pokemon_likes_pokemon ON pokemon_likes(pokemon_id);
CREATE INDEX idx_pokemon_likes_created ON pokemon_likes(created_at DESC);
CREATE INDEX idx_pokemon_comments_pokemon ON pokemon_comments(pokemon_id, created_at DESC);
CREATE INDEX idx_pokemon_showcase_stats_likes ON pokemon_showcase_stats(like_count DESC);
```

### 4.2 API 设计

#### 收藏管理 API

```
POST /api/pokemon/favorites
请求：{ "pokemonId": "uuid", "displayOrder": 0 }
响应：{ "success": true, "message": "收藏成功" }

DELETE /api/pokemon/favorites/:pokemonId
响应：{ "success": true, "message": "取消收藏成功" }

GET /api/pokemon/favorites
响应：{
  "favorites": [
    {
      "pokemonId": "uuid",
      "species": "Pikachu",
      "level": 50,
      "isShiny": true,
      "iv": 98,
      "likeCount": 42,
      "displayOrder": 0
    }
  ]
}

PUT /api/pokemon/favorites/reorder
请求：{ "orders": [{ "pokemonId": "uuid", "displayOrder": 0 }] }
响应：{ "success": true }
```

#### 点赞评语 API

```
POST /api/pokemon/:pokemonId/like
响应：{ 
  "success": true, 
  "likeCount": 43,
  "reward": { "coins": 5, "experience": 10 }
}

DELETE /api/pokemon/:pokemonId/like
响应：{ "success": true, "likeCount": 42 }

POST /api/pokemon/:pokemonId/comments
请求：{ "comment": "好厉害的闪光皮卡丘！" }
响应：{ 
  "success": true, 
  "commentId": "uuid",
  "reward": { "coins": 2, "experience": 5 }
}

GET /api/pokemon/:pokemonId/comments
响应：{
  "comments": [
    {
      "id": "uuid",
      "userId": "uuid",
      "nickname": "玩家名",
      "comment": "评语内容",
      "createdAt": "2026-06-09T16:35:00Z"
    }
  ],
  "total": 10
}
```

#### 展示页面 API

```
GET /api/users/:userId/showcase
响应：{
  "userId": "uuid",
  "nickname": "玩家名",
  "level": 50,
  "team": "instinct",
  "showcase": [
    {
      "pokemonId": "uuid",
      "species": "Pikachu",
      "level": 50,
      "isShiny": true,
      "iv": 98,
      "likeCount": 42,
      "commentCount": 5,
      "isLikedByMe": false
    }
  ],
  "stats": {
    "totalLikes": 120,
    "totalViews": 1500
  }
}

GET /api/pokemon/showcase/leaderboard
参数：?type=likes&limit=50
响应：{
  "leaderboard": [
    {
      "rank": 1,
      "pokemonId": "uuid",
      "species": "Mewtwo",
      "ownerId": "uuid",
      "ownerNickname": "玩家名",
      "likeCount": 999,
      "isShiny": true,
      "iv": 100
    }
  ]
}
```

### 4.3 前端组件设计

#### 收藏管理界面
- 精灵列表中添加"收藏"按钮（星标图标）
- 收藏的精灵显示金色边框和星标
- 拖拽排序收藏顺序
- 收藏数量限制提示（最多 6 只）

#### 展示页面
- 个人资料页顶部展示收藏精灵
- 网格布局（3x2），每只精灵显示：
  - 精灵图片
  - 等级、个体值、闪光标识
  - 点赞数、评语数
  - 点赞按钮（心形图标）
- 点击精灵查看详情和评语

#### 排行榜页面
- "最受欢迎精灵"榜单
- 筛选器（按属性、闪光、个体值）
- 分页加载

### 4.4 业务规则

1. **收藏限制**：
   - 每位玩家最多收藏 6 只精灵
   - 收藏的精灵必须属于自己的
   - 可以设置展示/隐藏收藏精灵

2. **点赞限制**：
   - 每位玩家每天最多点赞 20 次
   - 每只精灵每位玩家只能点赞一次
   - 取消点赞后不返还点赞次数
   - 不能给自己的精灵点赞

3. **评语限制**：
   - 每位玩家每天最多发表 5 条评语
   - 评语长度 1-200 字符
   - 敏感词过滤
   - 每只精灵每位玩家最多发表 1 条评语

4. **奖励规则**：
   - 被点赞：精灵主人获得 10 金币 + 20 经验
   - 点赞他人：点赞者获得 5 金币 + 10 经验
   - 被评语：精灵主人获得 20 金币 + 40 经验
   - 发表评语：评论者获得 2 金币 + 5 经验

5. **排行榜规则**：
   - 按点赞数降序排列
   - 相同点赞数按评语数排序
   - 每小时更新一次
   - 缓存热门排名（前 100 名）

### 4.5 Prometheus 指标

```javascript
// 收藏相关指标
pokemon_favorite_total{user_id}           // 收藏总数
pokemon_showcase_view_total{pokemon_id}   // 展示页浏览次数

// 点赞相关指标
pokemon_like_total{pokemon_id}            // 点赞总数
pokemon_like_daily_limit_reached_total    // 达到每日点赞上限次数

// 评语相关指标
pokemon_comment_total{pokemon_id}         // 评语总数
pokemon_comment_daily_limit_reached_total // 达到每日评语上限次数

// 奖励相关指标
pokemon_showcase_reward_given_total       // 发放奖励总次数
pokemon_showcase_reward_coins_total       // 发放金币总数
pokemon_showcase_reward_experience_total  // 发放经验总数
```

## 5. 验收标准（可测试）

- [ ] 玩家可以收藏最多 6 只精灵，收藏后在列表中高亮显示
- [ ] 个人资料页正确展示收藏的精灵（按顺序）
- [ ] 其他玩家可以查看展示页并为精灵点赞
- [ ] 点赞成功后双方获得正确奖励（金币、经验）
- [ ] 点赞数达到每日上限后正确拒绝点赞请求
- [ ] 玩家可以发表评语，评语显示在精灵详情页
- [ ] 敏感词评语被正确过滤
- [ ] 排行榜按点赞数正确排序，每小时更新
- [ ] 取消点赞功能正常工作（不返还次数）
- [ ] 所有 API 端点有完整的单元测试
- [ ] 前端 UI 正确显示收藏标识、点赞按钮、评语列表
- [ ] Prometheus 指标正确记录统计数据
- [ ] 数据库索引优化查询性能（< 100ms）

## 6. 工作量估算

**L (Large)**

理由：
- 涉及 3 个微服务（pokemon-service、social-service、user-service）
- 需要创建 5 个数据库表和多个索引
- 需要实现 10+ 个 API 端点
- 需要实现每日限额和奖励系统
- 需要实现排行榜缓存和定时更新
- 需要实现敏感词过滤
- 前端需要多个组件（收藏管理、展示页、排行榜）

预计开发时间：2-3 天

## 7. 优先级理由

**P1 (高优先级)**

理由：
1. **提升社交互动**：展示和点赞是轻量级社交互动，能显著提升用户参与度
2. **增强收集动机**：展示稀有精灵获得点赞奖励，增强玩家收集动力
3. **完善核心功能**：收藏展示是精灵收集游戏的标准功能，弥补功能缺口
4. **提升留存率**：社交展示和互动能有效提升玩家留存
5. **技术可行**：基于现有架构实现，技术风险低

## 8. 相关需求

- REQ-00018: 精灵交易系统（已实现）
- REQ-00027: 精灵详情页 3D 模型展示（已实现）
- REQ-00046: 精灵培育系统（已实现）
- REQ-00048: 精灵好友系统与社交互动增强（已实现）

## 9. 风险评估

### 技术风险（低）
- 基于现有架构实现，技术栈成熟
- 数据库设计简单，无复杂关联

### 性能风险（中）
- 排行榜查询可能成为热点，需要缓存优化
- 点赞计数需要考虑并发，可使用 Redis 计数器

### 安全风险（中）
- 需要防止刷赞、刷评语
- 敏感词过滤需要定期更新词库

## 10. 后续优化方向

1. **点赞特效**：点赞时有动画和音效
2. **评语回复**：支持回复评语，形成对话
3. **展示主题**：不同主题的展示页面风格
4. **成就系统**：达到一定点赞数解锁成就徽章
5. **限时展示**：限时展示活动，获得额外奖励
