# REQ-00160：精灵特殊个体值（彩蛋）系统

- **编号**：REQ-00160
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、catch-service、location-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-13 15:00
- **依赖需求**：无

## 1. 背景与问题

当前精灵捕捉系统中，所有精灵的个体值（IV）都是随机生成的（0-15），缺乏特殊机制的精灵。玩家只能通过运气获得高 IV 精灵，缺少惊喜感和成就感。对比 Pokémon GO 的彩蛋机制：
- **零 IV 精灵**：攻击/防御/HP 都是 0，稀有收藏价值
- **完美 IV 精灵**：攻击/防御/HP 都是 15，100% 完美度
- **幸运精灵**：与好友交换时有几率变成幸运精灵，IV 下限保证

当前代码（`location-service/src/index.js` 第 123-125 行）中 IV 完全随机：
```javascript
const iv_attack  = Math.floor(Math.random() * 16);
const iv_defense = Math.floor(Math.random() * 16);
const iv_hp      = Math.floor(Math.random() * 16);
```

这导致：
1. 缺少彩蛋惊喜机制，玩家体验单调
2. 无法获得特殊收藏品（如零 IV 或完美 IV）
3. 缺少与社交系统联动的幸运精灵机制

## 2. 目标

实现精灵特殊个体值（彩蛋）系统，增加游戏惊喜感和收藏价值：
1. **零 IV 精灵**：极低概率（0.01%）出现零 IV 精灵，带有特殊标识
2. **完美 IV 精灵**：低概率（0.1%）出现完美 IV 精灵，带有特殊标识
3. **幸运精灵**：精灵交换时 5% 几率变成幸运精灵，IV 下限为 12/12/12
4. 前端显示特殊 IV 标识（零值徽章、完美徽章、幸运徽章）

## 3. 范围

- **包含**：
  - 特殊 IV 生成逻辑（零值、完美）
  - 数据库字段扩展（is_zero_iv, is_perfect_iv, is_lucky 已存在）
  - 幸运精灵判定逻辑（交换时触发）
  - 前端显示特殊 IV 标识
  - 图鉴中特殊 IV 统计展示
- **不包含**：
  - 特殊 IV 精灵的战斗加成（保持公平性）
  - 特殊 IV 精灵的交易价值调整

## 4. 详细需求

### 4.1 特殊 IV 生成逻辑

在 `location-service/src/index.js` 的 `spawnPokemonForPoint` 函数中：

```javascript
// 特殊 IV 生成逻辑
const specialRoll = Math.random();
let iv_attack, iv_defense, iv_hp;
let is_zero_iv = false;
let is_perfect_iv = false;

if (specialRoll < 0.0001) { // 0.01% 零 IV
  iv_attack = iv_defense = iv_hp = 0;
  is_zero_iv = true;
} else if (specialRoll < 0.001) { // 0.09% 完美 IV
  iv_attack = iv_defense = iv_hp = 15;
  is_perfect_iv = true;
} else { // 普通生成
  iv_attack  = Math.floor(Math.random() * 16);
  iv_defense = Math.floor(Math.random() * 16);
  iv_hp      = Math.floor(Math.random() * 16);
}
```

### 4.2 幸运精灵交换逻辑

在 `social-service` 的精灵交换路由中，增加幸运判定：

```javascript
// 交换时 5% 几率成为幸运精灵
const isLucky = Math.random() < 0.05;
const ivFloor = isLucky ? 12 : 0; // 幸运精灵 IV 下限为 12

if (isLucky) {
  // 重新计算 IV（不低于 12）
  iv_attack  = Math.max(iv_attack, 12);
  iv_defense = Math.max(iv_defense, 12);
  iv_hp      = Math.max(iv_hp, 12);
  pokemon.is_lucky = true;
}
```

### 4.3 数据库扩展

`pokemon_instances` 表已有 `is_lucky` 字段，需新增：

```sql
ALTER TABLE pokemon_instances 
ADD COLUMN IF NOT EXISTS is_zero_iv BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_perfect_iv BOOLEAN DEFAULT FALSE;

-- 添加索引以支持快速查询
CREATE INDEX IF NOT EXISTS idx_pokemon_zero_iv ON pokemon_instances(is_zero_iv) WHERE is_zero_iv = TRUE;
CREATE INDEX IF NOT EXISTS idx_pokemon_perfect_iv ON pokemon_instances(is_perfect_iv) WHERE is_perfect_iv = TRUE;
```

### 4.4 前端展示

在 `game-client` 的精灵详情页添加特殊标识：
- 零 IV 精灵：显示"⭕ 零值"徽章（灰色）
- 完美 IV 精灵：显示"💎 完美"徽章（金色）
- 幸运精灵：显示"🍀 幸运"徽章（绿色）

### 4.5 图鉴统计

在 `/pokemon/pokedex` 接口中添加特殊 IV 统计：

```javascript
// 返回数据增加
{
  zeroIvCount: 3,      // 零 IV 精灵数量
  perfectIvCount: 5,   // 完美 IV 精灵数量
  luckyCount: 12       // 幸运精灵数量
}
```

## 5. 验收标准（可测试）

- [ ] 零 IV 精灵出现概率约为 0.01%（统计 100000 次生成）
- [ ] 完美 IV 精灵出现概率约为 0.09%（统计 100000 次生成）
- [ ] 精灵交换时 5% 几率变成幸运精灵
- [ ] 幸运精灵 IV 下限为 12/12/12
- [ ] 数据库正确存储 `is_zero_iv`、`is_perfect_iv`、`is_lucky` 标识
- [ ] 前端精灵详情页正确显示特殊 IV 徽章
- [ ] 图鉴页面正确显示特殊 IV 统计数据
- [ ] 单元测试覆盖特殊 IV 生成逻辑
- [ ] 集成测试覆盖幸运精灵交换流程

## 6. 工作量估算

**M（中等）**
- 后端逻辑修改：2 小时
- 数据库迁移：0.5 小时
- 前端展示：2 小时
- 测试编写：1.5 小时
- 总计：约 6 小时

## 7. 优先级理由

该需求属于 P1 优先级：
1. **增强游戏体验**：彩蛋机制是 AR 手游的核心惊喜点
2. **提升收藏价值**：特殊 IV 精灵增加玩家粘性
3. **社交系统联动**：幸运精灵促进玩家交换互动
4. **实现成本低**：基于现有架构，修改量小
5. **对项目可用贡献**：完善核心游戏机制，提升玩家满意度
