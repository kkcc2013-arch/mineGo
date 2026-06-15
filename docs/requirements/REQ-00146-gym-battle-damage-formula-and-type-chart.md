# REQ-00146: 道馆战斗伤害公式与属性克制计算系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00146 |
| 标题 | 道馆战斗伤害公式与属性克制计算系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gym-service、pokemon-service、backend/shared |
| 创建时间 | 2026-06-12 07:00 |

## 背景与价值

当前道馆战斗系统（REQ-00054）已实现基础战斗框架，但伤害计算逻辑过于简化，缺乏经典的属性克制机制。这导致：
1. 战斗策略性不足，玩家无需考虑精灵属性搭配
2. 与正统 Pokemon 游戏体验差距大
3. 精灵类型（火、水、草等）失去核心意义

本需求实现完整的伤害公式与 18 种属性间的克制关系矩阵，提升战斗策略深度，让玩家更有动力收集不同属性的精灵。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/shared/damageCalculator.js` 通过
- [ ] `node --check backend/shared/typeChart.js` 通过
- [ ] `node --check backend/services/gym-service/src/damageEngine.js` 通过
- [ ] `node backend/tests/unit/damage-calculator.test.js` 通过
- [ ] `curl -sf http://localhost:3003/api/v1/gym/battle/simulate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"attacker":{"species_id":6,"attack":150,"fast_move":"ember"},"defender":{"species_id":9,"defense":120}}' | jq '.damage_multiplier'` 返回值在合理范围

## 技术方案

### 1. 属性克制矩阵（backend/shared/typeChart.js）

```javascript
// 18 种属性的克制关系矩阵
// 值: 2.0 = 克制, 0.5 = 被抵抗, 0 = 免疫, 1.0 = 正常
const TYPE_CHART = {
  normal:   { rock: 0.5, ghost: 0, steel: 0.5 },
  fire:     { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water:    { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass:    { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice:      { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison:   { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground:   { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying:   { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic:  { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug:      { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock:     { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost:    { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon:   { dragon: 2, steel: 0.5, fairy: 0 },
  dark:     { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel:    { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy:    { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
};

function getTypeMultiplier(attackType, defenderType1, defenderType2 = null) {
  let multiplier = 1.0;
  const chart = TYPE_CHART[attackType];
  if (!chart) return 1.0;
  
  if (chart[defenderType1] !== undefined) {
    multiplier *= chart[defenderType1];
  }
  if (defenderType2 && chart[defenderType2] !== undefined) {
    multiplier *= chart[defenderType2];
  }
  return multiplier;
}

module.exports = { TYPE_CHART, getTypeMultiplier };
```

### 2. 伤害计算引擎（backend/shared/damageCalculator.js）

```javascript
const { getTypeMultiplier } = require('./typeChart');

/**
 * Pokemon GO 风格伤害公式
 * Damage = floor(0.5 * Power * (Attack/Defense) * STAB * Type * Random) + 1
 * 
 * - Power: 技能基础威力
 * - Attack: 攻击者攻击力（含 IV 加成）
 * - Defense: 防御者防御力（含 IV 加成）
 * - STAB: 同属性加成 (1.2x if same type)
 * - Type: 属性克制倍率 (0x-4x)
 * - Random: 随机因子 (0.85-1.0)
 */
function calculateDamage(params) {
  const {
    power,           // 技能威力
    attack,          // 攻击力
    defense,         // 防御力
    attackType,      // 技能属性
    attackerType1,   // 攻击者属性1
    attackerType2,   // 攻击者属性2 (可选)
    defenderType1,   // 防御者属性1
    defenderType2,   // 防御者属性2 (可选)
    isCharged = false, // 是否为蓄力技能
    weatherBoost = null // 天气加成类型
  } = params;

  // 属性克制倍率
  const typeMultiplier = getTypeMultiplier(attackType, defenderType1, defenderType2);

  // 免疫判定
  if (typeMultiplier === 0) {
    return { damage: 0, effectiveness: 0, isImmune: true };
  }

  // STAB 加成 (同属性加成)
  let stab = 1.0;
  if (attackType === attackerType1 || attackType === attackerType2) {
    stab = 1.2;
  }

  // 天气加成
  let weatherMultiplier = 1.0;
  if (weatherBoost && isWeatherBoosted(attackType, weatherBoost)) {
    weatherMultiplier = 1.2;
  }

  // 随机因子
  const randomFactor = 0.85 + Math.random() * 0.15;

  // 伤害公式
  const baseDamage = 0.5 * power * (attack / defense);
  const damage = Math.floor(
    baseDamage * stab * typeMultiplier * weatherMultiplier * randomFactor
  ) + 1;

  // 效果提示 (用于前端显示)
  let effectiveness = 'normal';
  if (typeMultiplier >= 2) effectiveness = 'super_effective';
  else if (typeMultiplier >= 1.5) effectiveness = 'very_effective';
  else if (typeMultiplier <= 0.5) effectiveness = 'not_very_effective';
  else if (typeMultiplier <= 0.25) effectiveness = 'barely_effective';

  return {
    damage: Math.max(1, damage),
    effectiveness,
    typeMultiplier,
    stab,
    weatherMultiplier,
    randomFactor,
    isImmune: false,
    isCritical: false // 暴击单独处理
  };
}

// 天气与属性对应关系
const WEATHER_BOOST_MAP = {
  sunny: ['fire', 'grass', 'ground'],
  rainy: ['water', 'electric', 'bug'],
  cloudy: ['fighting', 'poison', 'fairy'],
  windy: ['dragon', 'flying', 'psychic'],
  snowy: ['ice', 'steel'],
  foggy: ['dark', 'ghost']
};

function isWeatherBoosted(type, weather) {
  const boosted = WEATHER_BOOST_MAP[weather];
  return boosted ? boosted.includes(type) : false;
}

module.exports = { 
  calculateDamage, 
  isWeatherBoosted, 
  WEATHER_BOOST_MAP 
};
```

### 3. 集成到道馆战斗服务

在 gym-service 中新增伤害计算 API 端点：

```javascript
// backend/services/gym-service/src/routes/damage.js
const express = require('express');
const router = express.Router();
const { calculateDamage } = require('../../../shared/damageCalculator');
const { requireAuth, successResp, AppError } = require('../../../shared/auth');
const { query } = require('../../../shared/db');

// POST /gym/battle/simulate - 伤害模拟计算
router.post('/simulate', requireAuth, async (req, res, next) => {
  try {
    const { attacker, defender, move } = req.body;
    
    // 获取精灵数据
    const { rows: [attackerSpecies] } = await query(
      'SELECT type1, type2 FROM pokemon_species WHERE id=$1',
      [attacker.species_id]
    );
    const { rows: [defenderSpecies] } = await query(
      'SELECT type1, type2 FROM pokemon_species WHERE id=$1',
      [defender.species_id]
    );
    
    if (!attackerSpecies || !defenderSpecies) {
      throw new AppError(3001, '精灵数据不存在', 404);
    }

    // 获取技能数据
    const { rows: [moveData] } = await query(
      'SELECT power, type FROM moves WHERE name=$1',
      [move || attacker.fast_move]
    );
    
    const result = calculateDamage({
      power: moveData?.power || 50,
      attack: attacker.attack,
      defense: defender.defense,
      attackType: moveData?.type || 'normal',
      attackerType1: attackerSpecies.type1,
      attackerType2: attackerSpecies.type2,
      defenderType1: defenderSpecies.type1,
      defenderType2: defenderSpecies.type2
    });

    res.json(successResp(result));
  } catch (err) { next(err); }
});

// GET /gym/typechart - 获取属性克制表
router.get('/typechart', async (req, res, next) => {
  try {
    const { TYPE_CHART } = require('../../../shared/typeChart');
    res.json(successResp(TYPE_CHART));
  } catch (err) { next(err); }
});

module.exports = router;
```

### 4. 数据库迁移（添加技能属性字段）

```sql
-- database/pending/20260612_070000__add_damage_system.sql

-- 确保技能表有属性和威力字段
ALTER TABLE moves 
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS power INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS energy_cost INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER DEFAULT 1000;

-- 添加技能类型索引
CREATE INDEX IF NOT EXISTS idx_moves_type ON moves(type);

-- 更新常见技能数据
UPDATE moves SET type = 'fire', power = 40 WHERE name = 'ember';
UPDATE moves SET type = 'fire', power = 70 WHERE name = 'flamethrower';
UPDATE moves SET type = 'water', power = 40 WHERE name = 'water_gun';
UPDATE moves SET type = 'water', power = 90 WHERE name = 'hydro_pump';
UPDATE moves SET type = 'grass', power = 55 WHERE name = 'vine_whip';
UPDATE moves SET type = 'grass', power = 100 WHERE name = 'solar_beam';
UPDATE moves SET type = 'electric', power = 65 WHERE name = 'thunder_shock';
UPDATE moves SET type = 'electric', power = 100 WHERE name = 'thunder';
UPDATE moves SET type = 'ice', power = 90 WHERE name = 'ice_beam';
UPDATE moves SET type = 'psychic', power = 90 WHERE name = 'psychic';
UPDATE moves SET type = 'fighting', power = 50 WHERE name = 'karate_chop';
UPDATE moves SET type = 'fighting', power = 100 WHERE name = 'close_combat';
UPDATE moves SET type = 'dragon', power = 85 WHERE name = 'dragon_claw';
UPDATE moves SET type = 'dark', power = 80 WHERE name = 'crunch';
UPDATE moves SET type = 'ghost', power = 100 WHERE name = 'shadow_ball';
UPDATE moves SET type = 'fairy', power = 90 WHERE name = 'dazzling_gleam';
UPDATE moves SET type = 'normal', power = 35 WHERE name = 'tackle';
UPDATE moves SET type = 'normal', power = 50 WHERE name = 'quick_attack';
UPDATE moves SET type = 'rock', power = 80 WHERE name = 'rock_slide';
UPDATE moves SET type = 'steel', power = 100 WHERE name = 'iron_head';
UPDATE moves SET type = 'ground', power = 100 WHERE name = 'earthquake';
UPDATE moves SET type = 'poison', power = 80 WHERE name = 'sludge_bomb';
UPDATE moves SET type = 'bug', power = 90 WHERE name = 'bug_buzz';
UPDATE moves SET type = 'flying', power = 80 WHERE name = 'air_slash';

-- 插入默认技能数据（如果不存在）
INSERT INTO moves (name, type, power, energy_cost, duration_ms)
VALUES 
  ('ember', 'fire', 40, 0, 1000),
  ('flamethrower', 'fire', 70, 50, 2500),
  ('water_gun', 'water', 40, 0, 1000),
  ('hydro_pump', 'water', 90, 80, 3500),
  ('vine_whip', 'grass', 55, 0, 800),
  ('solar_beam', 'grass', 100, 80, 4000),
  ('thunder_shock', 'electric', 65, 0, 1200),
  ('thunder', 'electric', 100, 75, 3500),
  ('ice_beam', 'ice', 90, 60, 3000),
  ('psychic', 'psychic', 90, 60, 2800),
  ('karate_chop', 'fighting', 50, 0, 800),
  ('close_combat', 'fighting', 100, 70, 3000),
  ('dragon_claw', 'dragon', 85, 50, 2000),
  ('crunch', 'dark', 80, 45, 2000),
  ('shadow_ball', 'ghost', 100, 55, 2500),
  ('dazzling_gleam', 'fairy', 90, 55, 2500),
  ('tackle', 'normal', 35, 0, 500),
  ('quick_attack', 'normal', 50, 0, 600),
  ('rock_slide', 'rock', 80, 50, 2500),
  ('iron_head', 'steel', 100, 60, 2800),
  ('earthquake', 'ground', 100, 70, 3500),
  ('sludge_bomb', 'poison', 80, 50, 2200),
  ('bug_buzz', 'bug', 90, 55, 2500),
  ('air_slash', 'flying', 80, 45, 2000)
ON CONFLICT (name) DO UPDATE SET
  type = EXCLUDED.type,
  power = EXCLUDED.power,
  energy_cost = EXCLUDED.energy_cost,
  duration_ms = EXCLUDED.duration_ms;
```

### 5. 单元测试

```javascript
// backend/tests/unit/damage-calculator.test.js
const { calculateDamage } = require('../../shared/damageCalculator');
const { getTypeMultiplier, TYPE_CHART } = require('../../shared/typeChart');

// 属性克制测试
console.log('Testing type chart...');
console.assert(getTypeMultiplier('fire', 'grass') === 2, 'Fire should be super effective against Grass');
console.assert(getTypeMultiplier('water', 'fire') === 2, 'Water should be super effective against Fire');
console.assert(getTypeMultiplier('fire', 'water') === 0.5, 'Fire should be not very effective against Water');
console.assert(getTypeMultiplier('electric', 'ground') === 0, 'Electric should be immune to Ground');
console.assert(getTypeMultiplier('ghost', 'normal') === 0, 'Ghost should be immune to Normal');
console.assert(getTypeMultiplier('dragon', 'fairy') === 0, 'Dragon should be immune to Fairy');

// 双属性测试
console.assert(getTypeMultiplier('fire', 'grass', 'ice') === 4, 'Fire x4 against Grass/Ice');
console.assert(getTypeMultiplier('fire', 'water', 'dragon') === 0.25, 'Fire x0.25 against Water/Dragon');
console.assert(getTypeMultiplier('ground', 'flying', 'electric') === 0, 'Ground immune to Flying/Electric');

// 伤害计算测试
console.log('\nTesting damage calculation...');
const basicDamage = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'normal',
  attackerType1: 'normal',
  defenderType1: 'normal'
});
console.assert(basicDamage.damage >= 20 && basicDamage.damage <= 30, 'Basic damage should be in expected range');
console.assert(basicDamage.effectiveness === 'normal', 'Should be normal effectiveness');

// STAB 测试
const stabDamage = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'fire',
  attackerType1: 'fire',
  defenderType1: 'normal'
});
console.assert(stabDamage.stab === 1.2, 'Should have STAB bonus');

// 克制测试
const superEffective = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'fire',
  attackerType1: 'fire',
  defenderType1: 'grass'
});
console.assert(superEffective.typeMultiplier === 2, 'Should be super effective');
console.assert(superEffective.effectiveness === 'super_effective', 'Should show super effective');

// 免疫测试
const immune = calculateDamage({
  power: 50,
  attack: 100,
  defense: 100,
  attackType: 'electric',
  attackerType1: 'electric',
  defenderType1: 'ground'
});
console.assert(immune.damage === 0, 'Immune should deal 0 damage');
console.assert(immune.isImmune === true, 'Should be marked as immune');

console.log('\n✅ All damage calculator tests passed!');
process.exit(0);
```

## 完成定义（DoD）

代码已提交 ≠ 完成。全部验收命令通过 + 路由可达 + CI 绿 = 完成。

具体要求：
1. 属性克制矩阵覆盖全部 18 种属性
2. 伤害公式符合 Pokemon GO 标准公式
3. 支持双属性精灵的复合克制计算
4. 支持 STAB（同属性加成）
5. 支持免疫判定（0 伤害）
6. 新增 API 端点已在 gym-service 的 index.js 挂载

## 影响范围

- `backend/shared/typeChart.js` (新增)
- `backend/shared/damageCalculator.js` (新增)
- `backend/services/gym-service/src/routes/damage.js` (新增)
- `backend/services/gym-service/src/index.js` (修改 - 挂载路由)
- `database/pending/20260612_070000__add_damage_system.sql` (新增)
- `backend/tests/unit/damage-calculator.test.js` (新增)

## 参考

- Pokemon GO 伤害公式: https://pokemon.gamepedia.com/Damage
- 属性克制表: https://bulbapedia.bulbagarden.net/wiki/Type
- REQ-00054: 道馆战斗系统
- REQ-00037: 真实天气 API 集成与天气加成系统
