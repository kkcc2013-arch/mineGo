# REQ-00361：精灵传承系统与属性遗产机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00361 |
| 标题 | 精灵传承系统与属性遗产机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 09:15 UTC |
| 依赖需求 | REQ-00240 (精灵放生与资源回收系统) |

## 1. 背景与问题

当前精灵放生系统（REQ-00240）仅提供基础资源回收功能，玩家放生精灵时获得糖果和星尘。这导致：

1. **玩家情感价值损失**：精心培育的高IV精灵放生后完全消失，无法保留其"遗产"
2. **培养动力不足**：玩家不愿投入资源培养精灵，因为一旦放生就全部损失
3. **缺少传承感**：无法让优秀精灵的属性传递给后代，缺少代际培养乐趣

本需求实现精灵传承系统，让玩家可以选择将放生精灵的部分属性"传承"给新捕捉的同种类精灵。

## 2. 目标

- 让放生的精灵可以留下"遗产"，提升后续同种类精灵的成长潜力
- 增加精灵培养的长期价值，鼓励玩家投入资源培育精灵
- 提供传承记录和统计，增强游戏的代际培养乐趣
- 通过传承机制增加玩家与精灵的情感连接

## 3. 范围

### 包含
- 传承池数据结构设计
- 放生时选择是否传承的逻辑
- 捕捉时继承传承属性的计算
- 传承记录与统计系统
- 传承道具（传承石）系统
- API 路径实现

### 不包含
- 跨种类传承（如水系精灵传承给火系）
- 技能传承（已有 REQ-00019 技能学习系统）
- 性格传承
- 外观/染色传承

## 4. 详细需求

### 4.1 传承池设计

```sql
-- 传承池表：存储放生精灵留下的遗产
CREATE TABLE pokemon_inheritance_pool (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    species_id VARCHAR(50) NOT NULL,
    source_pokemon_id INTEGER NOT NULL, -- 原放生精灵ID（仅记录，已删除）
    source_nickname VARCHAR(100),
    
    -- 传承属性值（百分比加成，0-100%）
    iv_attack_bonus DECIMAL(5,2) DEFAULT 0,  -- IV攻击加成
    iv_defense_bonus DECIMAL(5,2) DEFAULT 0,
    iv_hp_bonus DECIMAL(5,2) DEFAULT 0,
    
    -- CP继承
    cp_base_bonus INTEGER DEFAULT 0, -- CP基础加成
    
    -- 传承次数
    inheritance_count INTEGER DEFAULT 0,
    
    -- 有效期（传承池会衰减）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
    
    -- 来源信息
    source_level INTEGER,
    source_friendship_level INTEGER,
    
    UNIQUE(user_id, species_id)
);

CREATE INDEX idx_inheritance_pool_user_species ON pokemon_inheritance_pool(user_id, species_id);
CREATE INDEX idx_inheritance_pool_expires ON pokemon_inheritance_pool(expires_at);

-- 传承记录表
CREATE TABLE pokemon_inheritance_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    source_pokemon_id INTEGER NOT NULL,
    target_pokemon_id INTEGER NOT NULL,
    species_id VARCHAR(50) NOT NULL,
    
    -- 实际继承的属性值
    inherited_iv_attack DECIMAL(5,2),
    inherited_iv_defense DECIMAL(5,2),
    inherited_iv_hp DECIMAL(5,2),
    inherited_cp_bonus INTEGER,
    
    -- 传承类型
    inheritance_type VARCHAR(20) DEFAULT 'normal', -- normal, enhanced, perfect
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inheritance_records_user ON pokemon_inheritance_records(user_id);
CREATE INDEX idx_inheritance_records_target ON pokemon_inheritance_records(target_pokemon_id);
```

### 4.2 传承计算公式

```javascript
/**
 * 计算传承属性加成
 * 
 * 基础传承率：基于精灵友谊等级
 * - Lv1-10: 5%
 * - Lv11-20: 10%
 * - Lv21-30: 20%
 * - Lv31-40: 30%
 * - Lv41+: 50%
 * 
 * 传承石加成：使用道具可提升传承率
 * - 普通传承石：+10%
 * - 高级传承石：+20%
 * - 完美传承石：+30%（传承全部属性）
 * 
 * 最终继承值：随机从传承池抽取，上限为传承池值的继承率
 */
function calculateInheritanceBonus(pool, friendshipLevel, itemBonus = 0) {
    // 基础传承率
    const baseRates = {
        10: 0.05,
        20: 0.10,
        30: 0.20,
        40: 0.30,
        50: 0.50
    };
    
    let baseRate = 0.05;
    for (const [level, rate] of Object.entries(baseRates)) {
        if (friendshipLevel <= parseInt(level)) {
            baseRate = rate;
            break;
        }
    }
    
    const finalRate = Math.min(0.80, baseRate + itemBonus);
    
    return {
        ivAttackBonus: Math.round(pool.iv_attack_bonus * finalRate),
        ivDefenseBonus: Math.round(pool.iv_defense_bonus * finalRate),
        ivHpBonus: Math.round(pool.iv_hp_bonus * finalRate),
        cpBonus: Math.round(pool.cp_base_bonus * finalRate),
        rate: finalRate
    };
}
```

### 4.3 传承流程

**放生时选择传承：**

```
POST /pokemon/:id/release
{
    "inherit": true,               // 是否传承
    "inheritanceItem": "legacy_stone_normal" // 可选：传承道具
}
```

**捕捉时自动继承：**

捕捉同种类精灵时，自动检查传承池并应用加成：

```javascript
async function applyInheritanceOnCatch(userId, speciesId, newPokemon) {
    const pool = await getInheritancePool(userId, speciesId);
    
    if (!pool || pool.expires_at < new Date()) {
        return null; // 无传承池或已过期
    }
    
    const bonus = calculateInheritanceBonus(pool, pool.source_friendship_level);
    
    // 应用IV加成（上限为15）
    newPokemon.iv_attack = Math.min(15, newPokemon.iv_attack + bonus.ivAttackBonus);
    newPokemon.iv_defense = Math.min(15, newPokemon.iv_defense + bonus.ivDefenseBonus);
    newPokemon.iv_hp = Math.min(15, newPokemon.iv_hp + bonus.ivHpBonus);
    
    // 应用CP加成
    newPokemon.cp += bonus.cpBonus;
    
    // 更新传承池使用次数
    await updatePoolUsage(pool.id);
    
    // 记录传承
    await recordInheritance(userId, speciesId, bonus);
    
    return bonus;
}
```

### 4.4 传承道具系统

```sql
-- 传承道具定义
INSERT INTO items (id, category, name_zh, name_en, description_zh, description_en, shop_price, is_premium) VALUES
('legacy_stone_normal', 'inheritance', '传承石', 'Legacy Stone', '放生精灵时使用，增加10%传承效率', 'Use when releasing Pokemon to increase inheritance rate by 10%', 100, false),
('legacy_stone_advanced', 'inheritance', '高级传承石', 'Advanced Legacy Stone', '放生精灵时使用，增加20%传承效率', 'Use when releasing Pokemon to increase inheritance rate by 20%', 500, false),
('legacy_stone_perfect', 'inheritance', '完美传承石', 'Perfect Legacy Stone', '放生精灵时使用，传承全部属性', 'Use when releasing Pokemon to inherit all attributes', 1000, true);
```

### 4.5 API 端点设计

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/inheritance/pool` | 获取用户传承池列表 |
| GET | `/inheritance/pool/:speciesId` | 获取特定种类的传承池详情 |
| POST | `/pokemon/:id/release-with-inheritance` | 放生并传承（扩展 REQ-00240） |
| GET | `/inheritance/records` | 获取传承记录历史 |
| GET | `/inheritance/stats` | 获取传承统计 |
| POST | `/inheritance/use-item` | 使用传承道具 |

### 4.6 前端组件

```javascript
// 传承池展示组件
const InheritancePoolViewer = ({ userId }) => {
    // 显示所有传承池
    // 每个池显示：种类、IV加成上限、剩余有效期、已使用次数
    // 支持预览：捕捉该种类精灵可获得的最大继承值
};

// 放生传承选择组件
const ReleaseWithInheritanceDialog = ({ pokemon, onConfirm }) => {
    // 显示精灵当前属性
    // 显示可选择传承的属性
    // 显示传承道具选择
    // 显示预计传承池加成
};
```

## 5. 验收标准

- [ ] 传承池数据库表创建完成
- [ ] 放生时可选择是否传承，传承池正确更新
- [ ] 捕捉时自动检查传承池并应用继承加成
- [ ] IV继承值上限正确（不超过15）
- [ ] CP继承值计算正确
- [ ] 传承池30天后自动过期并衰减
- [ ] 传承道具系统实现完成（3种传承石）
- [ ] API 路径全部实现并返回正确格式
- [ ] 前端传承池展示组件实现
- [ ] 传承记录正确保存并可查询
- [ ] 单元测试覆盖率达到 80%+

## 6. 工作量估算

**L（Large）**

- 数据库设计与迁移：0.5天
- 传承池服务核心逻辑：1天
- 捕捉集成：0.5天
- 放生集成（扩展 REQ-00240）：0.5天
- 道具系统：0.5天
- API 路径：0.5天
- 前端组件：1天
- 测试：0.5天

**总计：约 4.5天**

## 7. 优先级理由

P1 优先级，因为：

1. 直接影响玩家培养精灵的动力，提升长期留存
2. 与已有的放生系统（REQ-00240）形成完整闭环
3. 增加精灵与玩家的情感连接，符合游戏设计目标
4. 实现相对独立，不依赖其他未完成需求
5. 可显著提升玩家满意度和游戏深度

## 实现记录（2026-09-24）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 传承池数据库表创建完成 | ✅ | pokemon_inheritance_pool（玩家 × 家族根物种唯一，UUID 外键）、pokemon_inheritance_records |
| 放生时可选择是否传承，传承池正确更新 | ✅ | `POST /pokemon/:id/release-with-inheritance {inherit, inheritanceItem?}`：空闲/非收藏/未锁定才可放生，软删除（背包计数同步）、返还糖果与星尘；同家族再次放生逐项取大并重置有效期 |
| 捕捉时自动检查传承池并应用继承加成 | ✅ | catch-service 捕捉事务内（保存点，失败不影响捕捉）调用 `shared/pokemonInheritance.applyInheritanceOnCatch`，捕捉响应返回传承明细与最终 IV/CP |
| IV继承值上限正确（不超过15） | ✅ | 单测覆盖 |
| CP继承值计算正确 | ✅ | CP 按 IV 变化比例缩放（与刷怪公式一致）+ CP 加成（放生精灵 CP 的 10% × 传承率 × 衰减） |
| 传承池30天后自动过期并衰减 | ✅ | 线性衰减（1 − 天数/30），过期不再生效，定时任务清理过期池 |
| 传承道具系统实现完成（3种传承石） | ✅ | 传承石 +10%、高级 +20%（上限 80%）、完美传承石传承全部属性；放生时使用或事后 `POST /pokemon/inheritance/use-item`（每池一次） |
| API 路径全部实现并返回正确格式 | ✅ | `/pokemon/inheritance/pool[/:speciesId]`、`/records`、`/stats`、`/use-item`、`/:id/release-with-inheritance`（经网关 /v1/pokemon/*） |
| 前端传承池展示组件实现 | ✅ | 精灵页「传承」页签：放生并传承（选传承石、二次确认）、传承池列表（当前加成、到期日） |
| 传承记录正确保存并可查询 | ✅ | 捕捉继承时写记录 |
| 单元测试覆盖率达到 80%+ | ⚠️ | `tests/unit/growth-inheritance.test.js`；覆盖率未统计 |

- 入口：`routes/inheritance.js` → `inheritanceService.js`；规则 `backend/shared/inheritanceRules.js`；捕捉 `backend/shared/pokemonInheritance.js` ← catch-service
- 迁移：`database/migrations/20260925_180000__pokemon_inheritance.sql`
- 测试：单测 `cd backend && node --test tests/unit/growth-*.test.js`（宿主机已运行：96 项含 E11 战斗单测全部通过）；冒烟 `BASE_URL=<网关> node scripts/smoke-growth.js inheritance`（经网关的集成冒烟，本批未运行，待验证）（含一次真实捕捉；SKIP_CATCH=1 可跳过）
- 待验证：捕捉后 IV/CP 与记录；过期池不再生效
- 说明：原 REQ-00240 的 `/pokemon/release/execute`（routes/release.js 查询 owner_id/iv_total、写 users.gold 等不存在的列）不在本 Epic，未修改，放生传承使用本需求的新接口。所有接口挂在 pokemon-service `/pokemon/*` 下，经网关 `/v1/pokemon/*`（authMiddleware JWT + 用户级限流）访问；`scripts/api-lint.js` 0 error、`scripts/contract-snapshot.js --check` 未审批 0。
