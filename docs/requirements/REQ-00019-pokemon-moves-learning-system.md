# REQ-00019：精灵技能学习与技能机器系统

- **编号**：REQ-00019
- **类别**：功能增强
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：pokemon-service、catch-service、reward-service、game-client、database/migrations
- **创建时间**：2026-06-05 10:00
- **依赖需求**：REQ-00018（精灵交易系统）
- **完成时间**：2026-06-05 18:30

## 1. 背景与问题

当前 pokemon-service 中，精灵实例（pokemon_instances）表包含 `fast_move` 和 `charge_move` 字段，但存在以下问题：

1. **技能固定不变**：捕捉时随机分配技能后，玩家无法更换或学习新技能
2. **缺少技能机器（TM）**：原版游戏中的 TM（Technical Machine）是核心玩法，允许精灵学习新技能
3. **技能池未实现**：pokemon_species 表缺少该种族可学习的技能列表
4. **战斗策略单一**：没有技能搭配策略，降低了游戏的策略深度
5. **奖励系统单调**：缺少 TM 作为高级奖励，降低了 Raid/任务奖励的吸引力

## 2. 目标

实现完整的精灵技能学习系统，包括：

1. 技能池定义：每个精灵种族可学习的快速技能和蓄力技能列表
2. 技能机器（TM）系统：玩家获得 TM 后可让精灵学习新技能
3. 技能更换功能：允许玩家在已学技能中切换
4. 技能遗忘功能：当技能栏满时，需遗忘一个技能才能学习新技能
5. TM 作为奖励：Raid 奖励、成就奖励、补给站掉落

## 3. 范围

- **包含**：
  - 数据库迁移：moves 表、pokemon_moves 表、tm_inventory 表
  - pokemon-service 新增技能相关 API
  - reward-service 集成 TM 奖励
  - game-client 技能管理 UI
  - 技能数据种子（至少 50 个常用技能）

- **不包含**：
  - 技能效果系统（仅存储技能元数据，实际战斗效果由 gym-service 实现）
  - 技能遗传系统（繁殖相关，后续需求）
  - 技能教学 NPC（后续需求）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 技能主表
CREATE TABLE moves (
  id VARCHAR(32) PRIMARY KEY,           -- 'TACKLE', 'THUNDERBOLT', 'HYPER_BEAM'
  name_zh VARCHAR(64) NOT NULL,         -- 中文名：撞击、十万伏特、破坏光线
  name_en VARCHAR(64) NOT NULL,         -- 英文名
  type VARCHAR(16) NOT NULL,            -- 属性：NORMAL, FIRE, WATER, ELECTRIC, etc.
  category VARCHAR(16) NOT NULL,        -- 类别：FAST, CHARGE
  power INT,                            -- 威力（快速技能通常 0-20，蓄力技能 40-200）
  energy_delta INT NOT NULL,            -- 能量变化（快速技能为正，蓄力技能为负）
  duration_ms INT NOT NULL,             -- 施放时间（毫秒）
  cooldown_ms INT NOT NULL,             -- 冷却时间
  dodge_window_ms INT,                  -- 闪避窗口
  accuracy_pct INT DEFAULT 100,         -- 命中率
  crit_chance_pct INT DEFAULT 0,        -- 暴击率
  effect_type VARCHAR(32),              -- 特效类型：STUN, BURN, POISON, etc.
  effect_chance_pct INT,                -- 特效触发概率
  description_zh TEXT,                  -- 技能描述
  is_legacy BOOLEAN DEFAULT false       -- 是否为遗产技能（无法通过 TM 学习）
);

-- 精灵种族可学习技能池
CREATE TABLE pokemon_moves (
  species_id INT NOT NULL REFERENCES pokemon_species(id),
  move_id VARCHAR(32) NOT NULL REFERENCES moves(id),
  learn_method VARCHAR(16) NOT NULL,    -- TM, LEVEL_UP, LEGACY, ELITE
  tm_id VARCHAR(32),                    -- 对应的 TM ID（如果通过 TM 学习）
  PRIMARY KEY (species_id, move_id)
);

-- TM 技能机器表
CREATE TABLE technical_machines (
  id VARCHAR(32) PRIMARY KEY,           -- 'TM01', 'TM02', ... 'TM200'
  move_id VARCHAR(32) NOT NULL REFERENCES moves(id),
  rarity VARCHAR(16) NOT NULL,          -- COMMON, RARE, EPIC, LEGENDARY
  source VARCHAR(64),                   -- 获取来源描述
  is_elite BOOLEAN DEFAULT false        -- 是否为精英 TM（可学习遗产技能）
);

-- 玩家 TM 背包
CREATE TABLE tm_inventory (
  user_id INT NOT NULL REFERENCES users(id),
  tm_id VARCHAR(32) NOT NULL REFERENCES technical_machines(id),
  quantity INT NOT NULL DEFAULT 1,
  obtained_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, tm_id)
);

-- 精灵实例技能栏扩展（修改 pokemon_instances 表）
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS learned_fast_moves TEXT[] DEFAULT '{}';
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS learned_charge_moves TEXT[] DEFAULT '{}';
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS move_reset_count INT DEFAULT 0;
```

### 4.2 API 设计

#### pokemon-service 新增路由

```javascript
// GET /moves - 技能列表查询
// Query: type, category, limit, offset
// Response: { moves: [...], total }

// GET /moves/:id - 技能详情

// GET /pokemon/my/:id/moves - 获取精灵技能栏
// Response: {
//   currentFastMove, currentChargeMove,
//   learnedFastMoves: [...], learnedChargeMoves: [...],
//   availableMoves: [...] // 该种族可学习但未学的技能
// }

// POST /pokemon/my/:id/moves/learn - 学习新技能
// Body: { tmId, moveId, forgetMoveId? }
// 逻辑：
//   1. 验证 TM 是否在背包
//   2. 验证精灵是否可学习该技能
//   3. 如果技能栏满，要求指定遗忘技能
//   4. 扣除 TM，添加技能到已学列表

// POST /pokemon/my/:id/moves/switch - 切换技能
// Body: { fastMoveId?, chargeMoveId? }
// 逻辑：验证技能在已学列表中，更新当前使用技能

// POST /pokemon/my/:id/moves/forget - 遗忘技能
// Body: { moveId }
// 注意：不能遗忘当前正在使用的技能

// GET /pokemon/:speciesId/learnset - 获取种族可学习技能列表

// GET /tm/my - 获取玩家 TM 背包
// Response: { tms: [{ tmId, moveId, moveName, rarity, quantity }] }

// POST /tm/use - 使用 TM（等同于 /pokemon/my/:id/moves/learn）
```

### 4.3 技能分配逻辑（捕捉时）

修改 catch-service 的 `handleCatch` 函数：

```javascript
// 捕捉时随机分配技能
const { rows: learnset } = await query(`
  SELECT move_id, category FROM pokemon_moves
  WHERE species_id = $1 AND learn_method IN ('TM', 'LEVEL_UP')
`, [speciesId]);

const fastMoves = learnset.filter(m => m.category === 'FAST');
const chargeMoves = learnset.filter(m => m.category === 'CHARGE');

const randomFast = fastMoves[Math.floor(Math.random() * fastMoves.length)]?.move_id || 'TACKLE';
const randomCharge = chargeMoves[Math.floor(Math.random() * chargeMoves.length)]?.move_id || 'STRUGGLE';

// 插入时设置初始技能
await client.query(`
  INSERT INTO pokemon_instances (..., fast_move, charge_move, learned_fast_moves, learned_charge_moves)
  VALUES (..., $fast, $charge, ARRAY[$fast], ARRAY[$charge])
`, { fast: randomFast, charge: randomCharge });
```

### 4.4 TM 奖励集成

修改 reward-service：

```javascript
// Raid 奖励池添加 TM
const RAID_TM_REWARDS = {
  1: ['TM01', 'TM05'],              // 1星 Raid：普通 TM
  3: ['TM13', 'TM14', 'TM24'],      // 3星 Raid：稀有 TM
  5: ['TM25', 'TM26', 'TM50'],      // 5星 Raid：史诗 TM
  MEGA: ['TM94', 'TM100', 'ELITE_TM'] // Mega/精英 Raid：传奇/精英 TM
};

// 补给站低概率掉落 TM
if (Math.random() < 0.02) {
  items.push({ type: 'TM', tmId: 'TM01', qty: 1 });
}
```

### 4.5 技能数据种子

至少包含以下常用技能：

**快速技能（Fast Moves）**：
- 撞击（TACKLE）、电光一闪（QUICK_ATTACK）、火花（EMBER）、水枪（WATER_GUN）
- 念力（ZEN_HEADBUTT）、龙息（DRAGON_BREATH）、暗影爪（SHADOW_CLAW）等

**蓄力技能（Charge Moves）**：
- 十万伏特（THUNDERBOLT）、破坏光线（HYPER_BEAM）、喷射火焰（FLAMETHROWER）
- 水炮（HYDRO_PUMP）、精神强念（PSYCHIC）、龙之波动（DRAGON_PULSE）等

### 4.6 前端 UI

game-client 新增技能管理界面：

```javascript
// src/components/PokemonMovesPanel.js
class PokemonMovesPanel {
  // 显示当前技能
  // 显示已学技能列表
  // 显示可学习技能（通过 TM）
  // 技能切换按钮
  // 技能遗忘按钮
  // TM 使用按钮
}
```

## 5. 验收标准（可测试）

- [ ] 数据库迁移成功执行，moves、pokemon_moves、technical_machines、tm_inventory 表创建完成
- [ ] 至少 50 个技能数据种子插入成功
- [ ] GET /moves 返回技能列表，支持按类型/类别筛选
- [ ] GET /pokemon/my/:id/moves 返回精灵技能栏，包含当前技能、已学技能、可学习技能
- [ ] POST /pokemon/my/:id/moves/learn 成功使用 TM 学习新技能
- [ ] POST /pokemon/my/:id/moves/learn 在技能栏满时，要求指定遗忘技能
- [ ] POST /pokemon/my/:id/moves/switch 成功切换已学技能
- [ ] POST /pokemon/my/:id/moves/forget 成功遗忘技能（不能遗忘当前使用技能）
- [ ] 捕捉精灵时自动从技能池随机分配初始技能
- [ ] Raid 奖励包含 TM，正确添加到玩家背包
- [ ] 补给站低概率（2%）掉落 TM
- [ ] GET /tm/my 返回玩家 TM 背包
- [ ] 前端技能管理 UI 可正常显示和操作
- [ ] 单元测试覆盖核心逻辑（技能学习、切换、遗忘）

## 6. 工作量估算

**L（Large）** - 约 3-5 天

理由：
- 数据库设计较复杂（4 张新表 + 修改现有表）
- 需要设计 50+ 技能数据
- 多个 API 端点实现
- 前端 UI 开发
- 与现有系统多处集成（捕捉、奖励、补给站）

## 7. 优先级理由

**P1 理由**：

1. **核心玩法**：技能系统是精灵对战的核心机制，直接影响战斗策略深度
2. **玩家期待**：原版游戏中 TM 系统是重要玩法，玩家会有强烈期待
3. **依赖关系**：多个后续功能（战斗系统优化、PVP 对战）依赖此功能
4. **提升留存**：技能搭配策略增加游戏深度，提升玩家长期留存
5. **商业化价值**：TM 可作为高级奖励，增加 Raid 参与动力

虽然不是 P0（不影响核心捕捉/道馆流程），但对游戏体验提升显著，应优先实现。
