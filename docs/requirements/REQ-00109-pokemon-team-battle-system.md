# REQ-00109：精灵团队战斗系统（Team Battle）

- **编号**：REQ-00109
- **类别**：功能增强
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gym-service、pokemon-service、user-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-11 10:25
- **依赖需求**：REQ-00054（道馆战斗系统）、REQ-00073（玩家对战系统）

## 1. 背景与问题

当前 mineGo 已实现单人精灵对战系统（REQ-00054 道馆战斗）和 PVP 单挑系统（REQ-00073 玩家对战），但缺少团队协作战斗玩法。玩家无法组队进行多人协作战斗，限制了游戏的社交性和策略深度。

当前系统的限制：
- 道馆战斗仅支持单人对战 AI 防守方
- PVP Duel 仅支持 1v1 单挑
- 缺少团队协作机制和团队技能组合
- 无法实现多人 Raid Boss 挑战
- 缺少团队战斗奖励分配机制

## 2. 目标

实现完整的精灵团队战斗系统，支持 2-5 人组队协作战斗，提升游戏社交性和策略深度。

预期收益：
- 提升玩家社交互动和协作体验
- 增加游戏策略深度（团队技能组合）
- 提高用户留存率（团队活动）
- 支持多人 Raid Boss 挑战玩法

## 3. 范围

### 包含
- 团队组建和管理系统（队长、邀请、踢出）
- 团队战斗房间和匹配机制
- 团队回合制战斗逻辑（多精灵协同）
- 团队技能连携系统（组合技）
- 团队战斗奖励分配机制
- 团队战斗统计数据
- 团队战斗回放系统

### 不包含
- 公会战系统（已有 REQ-00058 公会系统）
- 锦标赛系统（未来扩展）
- 排位赛系统（未来扩展）

## 4. 详细需求

### 4.1 团队组建系统

**数据库设计**：
```sql
-- 团队表
CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  leader_id INTEGER NOT NULL REFERENCES users(id),
  max_size INTEGER DEFAULT 5 CHECK (max_size BETWEEN 2 AND 5),
  battle_type VARCHAR(20) NOT NULL, -- 'raid', 'pvp_team', 'gym_assault'
  status VARCHAR(20) DEFAULT 'open', -- 'open', 'in_battle', 'closed'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 团队成员表
CREATE TABLE team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_ids INTEGER[] NOT NULL, -- 选择的精灵 ID 列表（最多 6 只）
  ready BOOLEAN DEFAULT false,
  joined_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

-- 团队邀请表
CREATE TABLE team_invitations (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  inviter_id INTEGER NOT NULL REFERENCES users(id),
  invitee_id INTEGER NOT NULL REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', 'rejected', 'expired'
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes',
  created_at TIMESTAMP DEFAULT NOW()
);
```

**API 端点**：
- `POST /api/teams` - 创建团队
- `POST /api/teams/:id/join` - 加入团队
- `POST /api/teams/:id/leave` - 离开团队
- `POST /api/teams/:id/invite` - 邀请玩家
- `POST /api/teams/:id/kick` - 踢出成员
- `POST /api/teams/:id/ready` - 标记准备就绪
- `POST /api/teams/:id/start-battle` - 开始战斗
- `GET /api/teams/:id` - 查询团队详情
- `GET /api/teams/open` - 查询开放团队列表

### 4.2 团队战斗逻辑

**战斗流程**：
1. 所有成员准备就绪后，队长启动战斗
2. 按速度值排序，确定行动顺序（包含所有玩家精灵和敌方精灵）
3. 每个回合，玩家选择技能或道具
4. 团队技能连携判定（满足条件时触发组合技）
5. 战斗结束后，按贡献度分配奖励

**团队技能连携系统**：
```javascript
// 连携技能示例
const COMBO_SKILLS = {
  // 双重攻击：两名玩家同时使用同类型攻击技能
  'double_strike': {
    trigger: { type: 'same_type_attack', count: 2 },
    effect: { damageMultiplier: 1.5, description: '双重打击' }
  },
  // 元素共鸣：三种不同属性技能组合
  'elemental_resonance': {
    trigger: { type: 'different_elements', count: 3 },
    effect: { allDamageBoost: 0.2, duration: 3, description: '元素共鸣' }
  },
  // 守护阵型：两名玩家使用防御技能
  'guardian_formation': {
    trigger: { type: 'defense_skills', count: 2 },
    effect: { teamDefenseBoost: 0.3, duration: 2, description: '守护阵型' }
  },
  // 完美配合：四名玩家连续攻击
  'perfect_coordination': {
    trigger: { type: 'consecutive_attacks', count: 4 },
    effect: { finalDamageMultiplier: 2.0, description: '完美配合' }
  }
};
```

**贡献度计算**：
```javascript
// 玩家贡献度 = 伤害输出 + 治疗量 + 防御贡献 + 连携触发
function calculateContribution(player, battleLog) {
  const damageDealt = battleLog.filter(e => e.attacker === player.id).reduce((sum, e) => sum + e.damage, 0);
  const healing = battleLog.filter(e => e.healer === player.id).reduce((sum, e) => sum + e.healing, 0);
  const defense = battleLog.filter(e => e.defender === player.id).reduce((sum, e) => sum + e.damageBlocked, 0);
  const comboBonus = battleLog.filter(e => e.comboTrigger === player.id).length * 100;
  
  return damageDealt + healing * 0.5 + defense * 0.3 + comboBonus;
}
```

### 4.3 Raid Boss 系统

**Raid Boss 定义**：
```sql
CREATE TABLE raid_bosses (
  id SERIAL PRIMARY KEY,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  cp_multiplier DECIMAL(5,2) NOT NULL, -- CP 倍数
  min_team_size INTEGER DEFAULT 2,
  max_team_size INTEGER DEFAULT 5,
  time_limit INTEGER DEFAULT 300, -- 秒
  rewards JSONB NOT NULL, -- 奖励配置
  active_from TIMESTAMP,
  active_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE raid_battles (
  id SERIAL PRIMARY KEY,
  raid_boss_id INTEGER NOT NULL REFERENCES raid_bosses(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  status VARCHAR(20) DEFAULT 'ongoing', -- 'ongoing', 'won', 'lost'
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  boss_current_hp INTEGER,
  boss_max_hp INTEGER,
  duration_seconds INTEGER
);
```

**Raid Boss API**：
- `GET /api/raids` - 查询当前活跃的 Raid Boss
- `POST /api/raids/:id/challenge` - 挑战 Raid Boss
- `GET /api/raids/:id/leaderboard` - 查询排行榜

### 4.4 团队战斗统计

**数据库表**：
```sql
CREATE TABLE team_battle_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_battles INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_damage BIGINT DEFAULT 0,
  total_healing BIGINT DEFAULT 0,
  combos_triggered INTEGER DEFAULT 0,
  mvp_count INTEGER DEFAULT 0, -- MVP 次数
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 4.5 WebSocket 实时通信

**事件类型**：
```javascript
const TEAM_EVENTS = {
  MEMBER_JOINED: 'team:member_joined',
  MEMBER_LEFT: 'team:member_left',
  MEMBER_READY: 'team:member_ready',
  BATTLE_START: 'team:battle_start',
  TURN_START: 'team:turn_start',
  ACTION_SUBMITTED: 'team:action_submitted',
  COMBO_TRIGGERED: 'team:combo_triggered',
  BATTLE_END: 'team:battle_end'
};
```

## 5. 验收标准（可测试）

- [ ] 玩家可以创建团队并邀请其他玩家加入（2-5人）
- [ ] 团队成员可以标记准备状态，队长可以启动战斗
- [ ] 战斗中所有玩家的精灵按速度值排序行动
- [ ] 满足条件时触发团队连携技能（至少 3 种组合技）
- [ ] 战斗结束后按贡献度分配奖励（误差 < 5%）
- [ ] Raid Boss 战斗支持多人协作，时间限制生效
- [ ] 团队战斗统计数据正确更新
- [ ] WebSocket 实时同步所有成员的战斗状态
- [ ] 战斗回放系统可以重现整个战斗过程
- [ ] 单元测试覆盖率 >= 80%

## 6. 工作量估算

**L（Large）**

理由：
- 需要设计团队管理和匹配系统
- 需要实现复杂的团队战斗逻辑和连携系统
- 需要实现 Raid Boss 系统
- 需要大量的 WebSocket 实时通信
- 预计需要 5-7 个工作日

## 7. 优先级理由

**P1 理由**：
- 团队战斗是核心玩法之一，对用户留存率影响大
- 已有单人战斗系统（REQ-00054）和 PVP 系统（REQ-00073）作为基础
- 实现后可支持多人 Raid Boss 挑战，丰富游戏内容
- 提升游戏社交性和协作体验
