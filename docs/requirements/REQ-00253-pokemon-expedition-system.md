# REQ-00253：精灵远征探险系统

- **编号**：REQ-00253
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、location-service、reward-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-16 15:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目已有精灵捕捉、进化、道馆战斗、PVP 对战等核心玩法，但缺乏一种让玩家派遣精灵自动探索获取资源的休闲玩法。这导致：
- 玩家离线时无法获得收益，留存率受影响
- 低 CP 精灵使用价值有限，玩家更倾向于只培养高 CP 精灵
- 缺少长期养成目标，游戏粘性不足

类似《Pokemon GO》的 Buddy Adventure 或《原神》的探索派遣，远征系统能增加游戏的长期留存和精灵养成深度。

## 2. 目标

实现精灵远征探险系统，让玩家可以派遣精灵前往不同区域探险，自动获取资源、道具和经验：
- 提升玩家留存率和日活跃时长
- 增加低 CP 精灵的使用价值和培养动力
- 提供新的资源获取渠道
- 达成 20% 的日活玩家使用远征功能

## 3. 范围

### 包含
- 远征区域定义与解锁机制（基于玩家等级）
- 精灵派遣与队伍组建系统
- 远征时长与奖励计算算法
- 远征状态追踪与实时更新
- 远征完成奖励领取
- 远征历史记录与统计

### 不包含
- 实时战斗场景（远征为自动进行）
- 多人协作远征（后续扩展）
- 远征成就系统（后续扩展）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 远征区域表
CREATE TABLE expedition_zones (
  id SERIAL PRIMARY KEY,
  name_zh VARCHAR(100) NOT NULL,
  name_en VARCHAR(100),
  description_zh TEXT,
  description_en TEXT,
  min_player_level INTEGER NOT NULL DEFAULT 1,
  min_pokemon_cp INTEGER NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  max_team_size INTEGER NOT NULL DEFAULT 3,
  required_types TEXT[], -- 如 ['fire', 'rock'] 类型加成
  reward_pool JSONB NOT NULL, -- {items: [...], stardust_range: [100,500], xp_range: [50,200]}
  rarity TEXT DEFAULT 'common', -- common/rare/epic/legendary
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 玩家远征记录表
CREATE TABLE player_expeditions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  zone_id INTEGER NOT NULL REFERENCES expedition_zones(id),
  pokemon_ids INTEGER[] NOT NULL, -- 派遣的精灵 ID 列表
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active/completed/cancelled
  rewards JSONB, -- 完成后的奖励
  completed_at TIMESTAMPTZ,
  CONSTRAINT valid_pokemon_ids CHECK (array_length(pokemon_ids, 1) BETWEEN 1 AND 6)
);

-- 精灵远征统计表
CREATE TABLE pokemon_expedition_stats (
  pokemon_instance_id INTEGER PRIMARY KEY REFERENCES pokemon_instances(id),
  expedition_count INTEGER DEFAULT 0,
  total_rewards_value INTEGER DEFAULT 0,
  last_expedition_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_player_expeditions_user ON player_expeditions(user_id);
CREATE INDEX idx_player_expeditions_status ON player_expeditions(status);
CREATE INDEX idx_player_expeditions_ends ON player_expeditions(ends_at);
```

### 4.2 API 设计

#### GET /expedition/zones
获取所有可用的远征区域列表

**响应**：
```json
{
  "zones": [
    {
      "id": 1,
      "name": "森林深处",
      "description": "探索神秘森林，收集草药与精灵球",
      "minPlayerLevel": 5,
      "minPokemonCp": 100,
      "durationMinutes": 60,
      "maxTeamSize": 3,
      "requiredTypes": ["grass", "bug"],
      "rarity": "common"
    }
  ]
}
```

#### POST /expedition/start
开始一次远征

**请求**：
```json
{
  "zoneId": 1,
  "pokemonIds": [123, 456, 789]
}
```

**响应**：
```json
{
  "expeditionId": 1,
  "startsAt": "2026-06-16T15:00:00Z",
  "endsAt": "2026-06-16T16:00:00Z",
  "team": [
    {"id": 123, "name": "皮卡丘", "cp": 500}
  ]
}
```

#### GET /expedition/active
获取当前活跃的远征状态

#### POST /expedition/:id/complete
完成远征并领取奖励

#### POST /expedition/:id/cancel
取消进行中的远征（无奖励）

#### GET /expedition/history
获取远征历史记录

### 4.3 奖励计算算法

```javascript
// 奖励计算考虑因素
function calculateExpeditionRewards(zone, team, playerLevel) {
  const baseRewards = zone.reward_pool;
  
  // 1. 队伍 CP 总和加成
  const teamCp = team.reduce((sum, p) => sum + p.cp, 0);
  const cpBonus = Math.min(teamCp / 1000, 0.5); // 最高 50% 加成
  
  // 2. 类型匹配加成
  const typeMatchCount = countTypeMatches(team, zone.required_types);
  const typeBonus = typeMatchCount * 0.1; // 每匹配一个类型 +10%
  
  // 3. 队伍规模加成
  const sizeBonus = (team.length - 1) * 0.05; // 每多一只精灵 +5%
  
  // 4. 玩家等级加成
  const levelBonus = Math.min(playerLevel / 100, 0.3); // 最高 30%
  
  const totalBonus = 1 + cpBonus + typeBonus + sizeBonus + levelBonus;
  
  return {
    items: rollItems(baseRewards.items, totalBonus),
    stardust: rollRange(baseRewards.stardust_range, totalBonus),
    xp: rollRange(baseRewards.xp_range, totalBonus),
    bonusMultiplier: totalBonus
  };
}
```

### 4.4 前端功能

- 远征界面：展示可用区域、队伍选择、奖励预览
- 进行中状态：显示剩余时间、当前状态动画
- 奖励弹窗：远征完成后的奖励展示
- 历史记录：过往远征的统计与回顾

## 5. 验收标准

- [ ] 数据库迁移成功，所有表创建完成
- [ ] GET /expedition/zones 返回区域列表，按等级过滤
- [ ] POST /expedition/start 能成功创建远征，验证精灵状态
- [ ] GET /expedition/active 返回进行中的远征及剩余时间
- [ ] POST /expedition/:id/complete 在远征结束后能领取奖励
- [ ] 奖励计算算法正确应用 CP/类型/规模加成
- [ ] 前端能展示远征界面，选择队伍并开始远征
- [ ] 单元测试覆盖核心逻辑，覆盖率 > 80%

## 6. 工作量估算

**L**（3-5 天）

理由：
- 数据库设计相对简单（3 个表）
- API 逻辑中等复杂度（6 个端点）
- 奖励计算算法需要仔细设计
- 前端需要新页面和动画效果
- 测试用例较多

## 7. 优先级理由

P1 理由：
- 直接影响核心玩法完整度和玩家留存
- 与现有精灵系统深度集成，提升低 CP 精灵价值
- 属于"项目可用"的关键功能之一
- 能显著提升日活和长期留存指标
