# REQ-00090: 精灵状态效果系统与战斗Buff/Debuff管理

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00090 |
| 标题 | 精灵状态效果系统与战斗Buff/Debuff管理 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gym-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-10 14:00 |

## 需求描述

### 背景
当前道馆战斗系统（REQ-00054）已实现基础状态效果（灼伤、麻痹、冰冻、中毒、剧毒、睡眠、混乱），但缺乏完整的Buff/Debuff管理系统，无法支持更复杂的战斗策略。玩家需要更丰富的状态效果系统来提升战斗深度和策略性。

### 目标
1. 实现完整的状态效果类型系统（25+ 种状态效果）
2. 支持状态效果叠加、刷新、驱散机制
3. 实现状态效果免疫与抗性系统
4. 提供状态效果优先级与互斥规则
5. 支持自定义状态效果扩展

### 功能范围

#### 状态效果分类
1. **控制类状态**
   - 灼伤（Burn）：每回合损失HP，物理攻击降低50%
   - 麻痹（Paralysis）：25%概率无法行动，速度降低50%
   - 冰冻（Freeze）：无法行动，受到火属性攻击时解除
   - 睡眠（Sleep）：1-3回合无法行动，受到伤害时苏醒
   - 混乱（Confusion）：33%概率攻击自己
   - 畏缩（Flinch）：跳过当回合行动

2. **持续伤害类状态**
   - 中毒（Poison）：每回合损失1/8 HP
   - 剧毒（Toxic）：每回合递增伤害（1/16, 2/16, 3/16...）
   - 寄生种子（Leech Seed）：每回合损失1/8 HP，转移给对手
   - 沙尘暴（Sandstorm）：每回合损失1/16 HP（岩石/地面/钢属性免疫）

3. **能力变化类状态（Buff/Debuff）**
   - 攻击力提升/下降（±1-6级，每级±50%）
   - 防御力提升/下降（±1-6级，每级±50%）
   - 特攻提升/下降（±1-6级，每级±50%）
   - 特防提升/下降（±1-6级，每级±50%）
   - 速度提升/下降（±1-6级，每级±50%）
   - 命中率提升/下降（±1-6级，每级±33%）
   - 闪避率提升/下降（±1-6级，每级±33%）
   - 暴击率提升/下降（±1-3级）

4. **场地效果**
   - 天气系统（晴天、雨天、沙尘暴、冰雹）
   - 地形效果（电气场地、草地场地、精神场地、薄雾场地）
   - 障碍物（光墙、反射壁、极光幕）
   - 扎根（Ingrain）：每回合回复1/16 HP，无法交换

5. **特殊状态**
   - 束缚（Bound）：无法交换精灵
   - 诅咒（Curse）：幽灵属性使用时损失1/2 HP，对手每回合损失1/4 HP
   - 祈愿（Wish）：2回合后回复1/2 HP
   - 替身（Substitute）：消耗1/4 HP创建替身
   - 蓄力状态（Charging）：正在蓄力的技能
   - 防御状态（Protect/Detect）：免疫当回合攻击

#### 状态效果机制
1. **叠加规则**
   - 同类状态不可叠加，后施加的覆盖先施加的
   - 能力变化可叠加（±6级上限）
   - 不同来源的持续伤害独立计算

2. **持续时间管理**
   - 回合计数器（1-5回合）
   - 永久状态（直到战斗结束或被驱散）
   - 条件触发解除（特定属性攻击、受到伤害等）

3. **驱散机制**
   - 技能驱散（清除浓雾、治愈铃声等）
   - 道具驱散（解毒药、烧伤药等）
   - 交换精灵清除部分状态
   - 特性驱散（治愈之心等）

4. **免疫与抗性**
   - 属性免疫（火属性免疫灼伤，电属性免疫麻痹等）
   - 特性免疫（漂浮免疫地面技能，厚脂肪免疫火/冰技能等）
   - 道具免疫（光粉增加闪避等）
   - 状态免疫技能（神秘守护、守住等）

## 技术方案

### 1. 状态效果数据模型

```sql
-- database/pending/20260610_140000__add_status_effects_system.sql

-- 状态效果定义表
CREATE TABLE status_effect_definitions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(30) NOT NULL, -- 'control', 'dot', 'stat_change', 'field', 'special'
    description TEXT NOT NULL,
    icon_url VARCHAR(255),
    max_stacks INT DEFAULT 1,
    duration_type VARCHAR(30) NOT NULL, -- 'turns', 'permanent', 'conditional'
    default_duration INT, -- 回合数
    dispellable BOOLEAN DEFAULT true,
    priority INT DEFAULT 0,
    mutually_exclusive_with INT[], -- 互斥状态ID数组
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 状态效果详细效果表
CREATE TABLE status_effect_mechanics (
    id SERIAL PRIMARY KEY,
    status_id INT REFERENCES status_effect_definitions(id) ON DELETE CASCADE,
    mechanic_type VARCHAR(50) NOT NULL, -- 'damage', 'heal', 'stat_mod', 'action_block', 'custom'
    trigger_event VARCHAR(50) NOT NULL, -- 'turn_start', 'turn_end', 'action_attempt', 'damage_received'
    calculation_formula TEXT NOT NULL, -- 公式表达式
    conditions JSONB, -- 触发条件
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 战斗中精灵状态表
CREATE TABLE battle_pokemon_status (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(100) NOT NULL,
    pokemon_instance_id INT NOT NULL,
    status_id INT REFERENCES status_effect_definitions(id),
    source_pokemon_id INT, -- 施加者
    source_move_id INT, -- 施加技能
    current_stacks INT DEFAULT 1,
    remaining_turns INT,
    applied_at_turn INT NOT NULL,
    metadata JSONB, -- 额外数据（如剧毒的累积层数）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(battle_id, pokemon_instance_id, status_id)
);

-- 能力变化记录表
CREATE TABLE battle_stat_changes (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(100) NOT NULL,
    pokemon_instance_id INT NOT NULL,
    stat_type VARCHAR(30) NOT NULL, -- 'attack', 'defense', 'sp_attack', 'sp_defense', 'speed', 'accuracy', 'evasion', 'crit_rate'
    stage INT NOT NULL CHECK (stage >= -6 AND stage <= 6),
    source_status_id INT REFERENCES status_effect_definitions(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(battle_id, pokemon_instance_id, stat_type)
);

-- 属性免疫表
CREATE TABLE type_status_immunities (
    id SERIAL PRIMARY KEY,
    type_id INT NOT NULL,
    status_id INT REFERENCES status_effect_definitions(id),
    immunity_type VARCHAR(30) DEFAULT 'complete', -- 'complete', 'partial'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 特性免疫表
CREATE TABLE ability_status_immunities (
    id SERIAL PRIMARY KEY,
    ability_id INT NOT NULL,
    status_id INT REFERENCES status_effect_definitions(id),
    immunity_type VARCHAR(30) DEFAULT 'complete',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_battle_pokemon_status_battle ON battle_pokemon_status(battle_id);
CREATE INDEX idx_battle_pokemon_status_pokemon ON battle_pokemon_status(pokemon_instance_id);
CREATE INDEX idx_battle_stat_changes_battle ON battle_stat_changes(battle_id);
CREATE INDEX idx_battle_stat_changes_pokemon ON battle_stat_changes(pokemon_instance_id);

-- 初始状态效果数据
INSERT INTO status_effect_definitions (code, name, category, description, max_stacks, duration_type, default_duration, dispellable, priority) VALUES
-- 控制类
('burn', '灼伤', 'control', '每回合损失1/8 HP，物理攻击降低50%', 1, 'turns', NULL, true, 10),
('paralysis', '麻痹', 'control', '25%概率无法行动，速度降低50%', 1, 'turns', NULL, true, 10),
('freeze', '冰冻', 'control', '无法行动，受火属性攻击时20%概率解除', 1, 'turns', NULL, true, 12),
('sleep', '睡眠', 'control', '1-3回合无法行动，受伤害时苏醒', 1, 'turns', 2, true, 15),
('confusion', '混乱', 'control', '33%概率攻击自己', 1, 'turns', 2, true, 5),
('flinch', '畏缩', 'control', '跳过当回合行动', 1, 'turns', 1, false, 20),
('attract', '着迷', 'control', '50%概率无法攻击异性精灵', 1, 'turns', NULL, true, 5),
('disable', '封印', 'control', '封印最后使用的技能4回合', 1, 'turns', 4, true, 8),
('encore', '再来一次', 'control', '连续使用最后技能3回合', 1, 'turns', 3, true, 8),
('torment', '折磨', 'control', '无法连续使用同一技能', 1, 'permanent', NULL, true, 6),
-- 持续伤害类
('poison', '中毒', 'dot', '每回合损失1/8 HP', 1, 'turns', NULL, true, 10),
('toxic', '剧毒', 'dot', '每回合递增伤害（n/16 HP）', 1, 'turns', NULL, true, 10),
('leech_seed', '寄生种子', 'dot', '每回合损失1/8 HP，转移给对手', 1, 'permanent', NULL, true, 7),
('curse_ghost', '诅咒(幽灵)', 'dot', '每回合损失1/4 HP', 1, 'permanent', NULL, false, 9),
('perish_song', '灭亡之歌', 'dot', '3回合后濒死', 1, 'turns', 3, false, 0),
-- 能力变化类
('attack_up', '攻击提升', 'stat_change', '攻击力提升', 6, 'permanent', NULL, true, 3),
('attack_down', '攻击下降', 'stat_change', '攻击力下降', 6, 'permanent', NULL, true, 3),
('defense_up', '防御提升', 'stat_change', '防御力提升', 6, 'permanent', NULL, true, 3),
('defense_down', '防御下降', 'stat_change', '防御力下降', 6, 'permanent', NULL, true, 3),
('sp_attack_up', '特攻提升', 'stat_change', '特攻提升', 6, 'permanent', NULL, true, 3),
('sp_attack_down', '特攻下降', 'stat_change', '特攻下降', 6, 'permanent', NULL, true, 3),
('speed_up', '速度提升', 'stat_change', '速度提升', 6, 'permanent', NULL, true, 3),
('speed_down', '速度下降', 'stat_change', '速度下降', 6, 'permanent', NULL, true, 3),
('accuracy_up', '命中提升', 'stat_change', '命中率提升', 6, 'permanent', NULL, true, 3),
('accuracy_down', '命中下降', 'stat_change', '命中率下降', 6, 'permanent', NULL, true, 3),
('evasion_up', '闪避提升', 'stat_change', '闪避率提升', 6, 'permanent', NULL, true, 3),
('evasion_down', '闪避下降', 'stat_change', '闪避率下降', 6, 'permanent', NULL, true, 3),
('crit_rate_up', '暴击提升', 'stat_change', '暴击率提升', 3, 'permanent', NULL, true, 4),
-- 场地效果
('sunny_day', '大晴天', 'field', '火属性技能伤害+50%，水属性技能伤害-50%', 1, 'turns', 5, false, 1),
('rain_dance', '求雨', 'field', '水属性技能伤害+50%，火属性技能伤害-50%', 1, 'turns', 5, false, 1),
('sandstorm', '沙尘暴', 'field', '岩石/地面/钢免疫，其他属性每回合损失1/16 HP', 1, 'turns', 5, false, 1),
('hail', '冰雹', 'field', '冰属性免疫，其他属性每回合损失1/16 HP', 1, 'turns', 5, false, 1),
('electric_terrain', '电气场地', 'field', '电属性技能伤害+30%，免疫睡眠', 1, 'turns', 5, false, 1),
('grassy_terrain', '草地场地', 'field', '草属性技能伤害+30%，每回合回复1/16 HP', 1, 'turns', 5, false, 1),
('psychic_terrain', '精神场地', 'field', '超能属性技能伤害+30%，免疫先制技能', 1, 'turns', 5, false, 1),
('misty_terrain', '薄雾场地', 'field', '龙属性技能伤害-50%，免疫异常状态', 1, 'turns', 5, false, 1),
-- 防御状态
('protect', '守住', 'special', '免疫当回合所有攻击', 1, 'turns', 1, false, 25),
('detect', '看穿', 'special', '免疫当回合所有攻击', 1, 'turns', 1, false, 25),
('endure', '忍耐', 'special', 'HP降至1时免疫死亡', 1, 'turns', 1, false, 22),
('substitute', '替身', 'special', '消耗1/4 HP创建替身吸收伤害', 1, 'permanent', NULL, true, 15),
('ingrain', '扎根', 'special', '每回合回复1/16 HP，无法交换', 1, 'permanent', NULL, true, 7),
('aquatic_ring', '水之圈', 'special', '每回合回复1/16 HP', 1, 'turns', 5, true, 6),
-- 特殊状态
('bound', '束缚', 'special', '无法交换精灵', 1, 'turns', 4, true, 11),
('charging', '蓄力', 'special', '正在蓄力准备强力技能', 1, 'turns', 1, false, 30),
('recharging', '休息', 'special', '使用强力技能后的休息回合', 1, 'turns', 1, false, 30),
('identify', '识破', 'special', '无视闪避', 1, 'turns', 2, false, 4),
('minimize', '变小', 'special', '闪避提升，受特定技能伤害x2', 1, 'permanent', NULL, true, 3);
```

### 2. 状态效果引擎（backend/services/pokemon-service/src/statusEffectEngine.js）

```javascript
/**
 * 状态效果引擎
 * 管理战斗中所有状态效果的施加、计算、驱散
 */
const { Prisma } = require('@prisma/client');
const { promisify } = require('util');

class StatusEffectEngine {
  constructor(prisma, redis) {
    this.prisma = prisma;
    this.redis = redis;
    this.statusCache = new Map();
    this.mechanicsCache = new Map();
    this.immunityCache = new Map();
  }

  /**
   * 初始化状态效果定义缓存
   */
  async initializeCache() {
    const statuses = await this.prisma.status_effect_definitions.findMany({
      include: {
        mechanics: true,
        mutually_exclusive_with_rel: true
      }
    });

    for (const status of statuses) {
      this.statusCache.set(status.code, status);
    }

    // 加载属性免疫
    const typeImmunities = await this.prisma.type_status_immunities.findMany({
      include: { status: true, type: true }
    });

    for (const immunity of typeImmunities) {
      const key = `${immunity.type_id}_${immunity.status.code}`;
      this.immunityCache.set(key, immunity.immunity_type);
    }

    // 加载特性免疫
    const abilityImmunities = await this.prisma.ability_status_immunities.findMany({
      include: { status: true, ability: true }
    });

    for (const immunity of abilityImmunities) {
      const key = `ability_${immunity.ability_id}_${immunity.status.code}`;
      this.immunityCache.set(key, immunity.immunity_type);
    }
  }

  /**
   * 检查是否可以施加状态效果
   * @param {Object} target - 目标精灵
   * @param {string} statusCode - 状态代码
   * @param {Object} source - 施加者
   * @returns {Object} { canApply: boolean, reason: string }
   */
  async canApplyStatus(target, statusCode, source = null) {
    const statusDef = this.statusCache.get(statusCode);
    if (!statusDef) {
      return { canApply: false, reason: '无效的状态效果' };
    }

    // 检查属性免疫
    const typeImmunityKey = `${target.type_id}_${statusCode}`;
    if (this.immunityCache.has(typeImmunityKey)) {
      return { canApply: false, reason: `${target.type_name}属性免疫${statusDef.name}` };
    }

    // 检查特性免疫
    if (target.ability_id) {
      const abilityImmunityKey = `ability_${target.ability_id}_${statusCode}`;
      if (this.immunityCache.has(abilityImmunityKey)) {
        return { canApply: false, reason: `${target.ability_name}特性免疫${statusDef.name}` };
      }
    }

    // 检查薄雾场地
    const fieldStatus = await this.getFieldEffect(target.battle_id);
    if (fieldStatus?.code === 'misty_terrain' && statusDef.category === 'control') {
      return { canApply: false, reason: '薄雾场地免疫异常状态' };
    }

    // 检查电气场地的睡眠免疫
    if (fieldStatus?.code === 'electric_terrain' && statusCode === 'sleep') {
      return { canApply: false, reason: '电气场地免疫睡眠' };
    }

    // 检查已有状态
    const existingStatuses = await this.getPokemonStatuses(target.instance_id);
    const existing = existingStatuses.find(s => s.code === statusCode);
    if (existing && statusDef.max_stacks === 1) {
      return { canApply: false, reason: '已存在该状态' };
    }

    // 检查互斥状态
    if (statusDef.mutually_exclusive_with?.length > 0) {
      for (const exclusiveId of statusDef.mutually_exclusive_with) {
        const exclusiveStatus = existingStatuses.find(s => s.id === exclusiveId);
        if (exclusiveStatus) {
          return { canApply: false, reason: `与${exclusiveStatus.name}互斥` };
        }
      }
    }

    return { canApply: true };
  }

  /**
   * 施加状态效果
   * @param {string} battleId - 战斗ID
   * @param {number} targetId - 目标精灵实例ID
   * @param {string} statusCode - 状态代码
   * @param {Object} options - 选项
   */
  async applyStatus(battleId, targetId, statusCode, options = {}) {
    const statusDef = this.statusCache.get(statusCode);
    if (!statusDef) {
      throw new Error(`Unknown status effect: ${statusCode}`);
    }

    // 检查是否可施加
    const checkResult = await this.canApplyStatus(
      { instance_id: targetId, battle_id: battleId, ...options.target },
      statusCode,
      options.source
    );

    if (!checkResult.canApply) {
      return { success: false, reason: checkResult.reason };
    }

    // 能力变化类状态特殊处理
    if (statusDef.category === 'stat_change') {
      return await this.applyStatChange(battleId, targetId, statusCode, options.stacks || 1);
    }

    // 计算持续时间
    let duration = statusDef.default_duration;
    if (statusCode === 'sleep') {
      duration = Math.floor(Math.random() * 3) + 1; // 1-3回合
    }
    if (statusCode === 'freeze') {
      duration = null; // 永久直到解除
    }

    // 创建状态记录
    const statusRecord = await this.prisma.battle_pokemon_status.create({
      data: {
        battle_id: battleId,
        pokemon_instance_id: targetId,
        status_id: statusDef.id,
        source_pokemon_id: options.sourcePokemonId,
        source_move_id: options.sourceMoveId,
        current_stacks: 1,
        remaining_turns: duration,
        applied_at_turn: options.currentTurn || 0,
        metadata: options.metadata || {}
      }
    });

    // 记录战斗日志
    await this.logStatusEvent(battleId, 'status_applied', {
      targetId,
      statusCode,
      statusName: statusDef.name,
      duration,
      sourceId: options.sourcePokemonId
    });

    // 缓存到Redis
    await this.cacheStatus(battleId, targetId, statusDef, statusRecord);

    return {
      success: true,
      statusId: statusRecord.id,
      statusCode,
      statusName: statusDef.name,
      duration
    };
  }

  /**
   * 应用能力变化
   */
  async applyStatChange(battleId, targetId, statusCode, stacks) {
    const statusDef = this.statusCache.get(statusCode);
    const statType = statusCode.replace('_up', '').replace('_down', '');
    const stageDelta = statusCode.includes('_up') ? stacks : -stacks;

    // 获取当前变化
    const existing = await this.prisma.battle_stat_changes.findUnique({
      where: {
        battle_id_pokemon_instance_id_stat_type: {
          battle_id: battleId,
          pokemon_instance_id: targetId,
          stat_type: statType
        }
      }
    });

    // 计算新等级（-6到+6）
    const currentStage = existing?.stage || 0;
    const newStage = Math.max(-6, Math.min(6, currentStage + stageDelta));
    const actualDelta = newStage - currentStage;

    if (actualDelta === 0) {
      return { success: false, reason: '能力已达极限' };
    }

    // 更新或创建记录
    await this.prisma.battle_stat_changes.upsert({
      where: {
        battle_id_pokemon_instance_id_stat_type: {
          battle_id: battleId,
          pokemon_instance_id: targetId,
          stat_type: statType
        }
      },
      update: { stage: newStage },
      create: {
        battle_id: battleId,
        pokemon_instance_id: targetId,
        stat_type: statType,
        stage: newStage,
        source_status_id: statusDef.id
      }
    });

    return {
      success: true,
      statType,
      previousStage: currentStage,
      newStage,
      delta: actualDelta,
      message: this.getStatChangeMessage(statType, actualDelta)
    };
  }

  /**
   * 获取能力变化消息
   */
  getStatChangeMessage(statType, delta) {
    const statNames = {
      attack: '攻击',
      defense: '防御',
      sp_attack: '特攻',
      sp_defense: '特防',
      speed: '速度',
      accuracy: '命中',
      evasion: '闪避',
      crit_rate: '暴击'
    };

    const changeLevel = Math.abs(delta);
    const messages = {
      1: ['略微提升了', '略微下降了'],
      2: ['提升了', '下降了'],
      3: ['大幅提升了', '大幅下降了'],
      4: ['急剧提升了', '急剧下降了'],
      5: ['疯狂提升了', '疯狂下降了'],
      6: ['提升到了极限', '下降到了极限']
    };

    const level = Math.min(changeLevel, 6);
    const index = delta > 0 ? 0 : 1;

    return `${statNames[statType]}${messages[level][index]}！`;
  }

  /**
   * 处理回合开始事件
   */
  async onTurnStart(battleId, pokemonId, currentTurn) {
    const results = [];
    const statuses = await this.getPokemonStatuses(pokemonId);

    for (const status of statuses) {
      const mechanics = status.mechanics?.filter(m => m.trigger_event === 'turn_start');

      for (const mechanic of mechanics) {
        const result = await this.executeMechanic(
          battleId,
          pokemonId,
          status,
          mechanic,
          { currentTurn }
        );
        results.push(result);
      }
    }

    return results;
  }

  /**
   * 处理回合结束事件
   */
  async onTurnEnd(battleId, pokemonId, currentTurn) {
    const results = [];
    const statuses = await this.getPokemonStatuses(pokemonId);

    for (const status of statuses) {
      // 执行回合结束机制
      const mechanics = status.mechanics?.filter(m => m.trigger_event === 'turn_end');

      for (const mechanic of mechanics) {
        const result = await this.executeMechanic(
          battleId,
          pokemonId,
          status,
          mechanic,
          { currentTurn }
        );
        results.push(result);
      }

      // 减少持续时间
      if (status.remaining_turns !== null && status.remaining_turns > 0) {
        const newTurns = status.remaining_turns - 1;

        if (newTurns === 0) {
          await this.removeStatus(battleId, pokemonId, status.code);
          results.push({
            type: 'status_expired',
            statusCode: status.code,
            statusName: status.name
          });
        } else {
          await this.prisma.battle_pokemon_status.update({
            where: { id: status.id },
            data: { remaining_turns: newTurns }
          });
        }
      }

      // 冰冻/睡眠随机解除检查
      if (status.code === 'freeze') {
        if (Math.random() < 0.2) { // 20%概率解除
          await this.removeStatus(battleId, pokemonId, 'freeze');
          results.push({
            type: 'status_expired',
            statusCode: 'freeze',
            statusName: '冰冻'
          });
        }
      }

      if (status.code === 'sleep') {
        const sleepTurns = currentTurn - status.applied_at_turn;
        if (sleepTurns >= status.remaining_turns) {
          await this.removeStatus(battleId, pokemonId, 'sleep');
          results.push({
            type: 'status_expired',
            statusCode: 'sleep',
            statusName: '睡眠'
          });
        }
      }
    }

    return results;
  }

  /**
   * 执行状态机制
   */
  async executeMechanic(battleId, pokemonId, status, mechanic, context) {
    const pokemon = await this.getPokemonBattleData(battleId, pokemonId);
    let value = 0;

    switch (mechanic.mechanic_type) {
      case 'damage':
        value = this.calculateDotDamage(pokemon, mechanic, status);
        return {
          type: 'damage',
          statusCode: status.code,
          statusName: status.name,
          value,
          pokemonId
        };

      case 'heal':
        value = this.calculateHeal(pokemon, mechanic, status);
        return {
          type: 'heal',
          statusCode: status.code,
          statusName: status.name,
          value,
          pokemonId
        };

      case 'action_block':
        // 由战斗引擎处理
        return {
          type: 'action_block',
          statusCode: status.code,
          statusName: status.name,
          pokemonId
        };

      default:
        return { type: 'unknown', statusCode: status.code };
    }
  }

  /**
   * 计算持续伤害
   */
  calculateDotDamage(pokemon, mechanic, status) {
    const formula = mechanic.calculation_formula;
    const maxHp = pokemon.max_hp;

    // 替换公式变量
    let damage = formula
      .replace(/MAX_HP/g, maxHp)
      .replace(/CURRENT_HP/g, pokemon.current_hp)
      .replace(/TURN/g, status.applied_at_turn);

    // 特殊处理剧毒累积
    if (status.code === 'toxic') {
      const stacks = (status.metadata?.toxic_stacks || 0) + 1;
      damage = Math.floor(maxHp * stacks / 16);
      // 更新累积层数
      this.prisma.battle_pokemon_status.update({
        where: { id: status.id },
        data: { metadata: { toxic_stacks: stacks } }
      });
    }

    // 安全计算公式
    try {
      damage = Math.floor(eval(damage));
    } catch (e) {
      console.error('Invalid damage formula:', formula);
      damage = 0;
    }

    return Math.max(1, damage);
  }

  /**
   * 计算治疗量
   */
  calculateHeal(pokemon, mechanic, status) {
    const formula = mechanic.calculation_formula;
    const maxHp = pokemon.max_hp;

    let heal = formula.replace(/MAX_HP/g, maxHp);

    try {
      heal = Math.floor(eval(heal));
    } catch (e) {
      console.error('Invalid heal formula:', formula);
      heal = 0;
    }

    return Math.min(heal, maxHp - pokemon.current_hp);
  }

  /**
   * 检查行动是否被阻止
   */
  async checkActionBlocked(battleId, pokemonId, actionType) {
    const statuses = await this.getPokemonStatuses(pokemonId);

    for (const status of statuses) {
      // 睡眠/冰冻完全阻止行动
      if (['sleep', 'freeze'].includes(status.code)) {
        return { blocked: true, reason: `${status.name}状态` };
      }

      // 麻痹25%概率阻止
      if (status.code === 'paralysis') {
        if (Math.random() < 0.25) {
          return { blocked: true, reason: '麻痹发作' };
        }
      }

      // 混乱33%概率自伤
      if (status.code === 'confusion') {
        if (Math.random() < 0.33) {
          return { blocked: true, reason: '混乱', selfDamage: true };
        }
      }

      // 畏缩阻止当回合
      if (status.code === 'flinch') {
        await this.removeStatus(battleId, pokemonId, 'flinch');
        return { blocked: true, reason: '畏缩' };
      }

      // 封印检查
      if (status.code === 'disable' && actionType === 'move') {
        const disabledMoveId = status.metadata?.disabled_move_id;
        if (disabledMoveId === actionType.moveId) {
          return { blocked: true, reason: '技能被封印' };
        }
      }

      // 束缚阻止交换
      if (status.code === 'bound' && actionType === 'switch') {
        return { blocked: true, reason: '被束缚无法交换' };
      }

      // 扎根阻止交换
      if (status.code === 'ingrain' && actionType === 'switch') {
        return { blocked: true, reason: '扎根无法交换' };
      }
    }

    return { blocked: false };
  }

  /**
   * 移除状态效果
   */
  async removeStatus(battleId, pokemonId, statusCode) {
    const statusDef = this.statusCache.get(statusCode);
    if (!statusDef) return false;

    await this.prisma.battle_pokemon_status.deleteMany({
      where: {
        battle_id: battleId,
        pokemon_instance_id: pokemonId,
        status_id: statusDef.id
      }
    });

    // 清除Redis缓存
    await this.redis.del(`status:${battleId}:${pokemonId}:${statusCode}`);

    await this.logStatusEvent(battleId, 'status_removed', {
      targetId: pokemonId,
      statusCode,
      statusName: statusDef.name
    });

    return true;
  }

  /**
   * 驱散状态效果
   */
  async dispelStatuses(battleId, pokemonId, options = {}) {
    const { category, dispellableOnly = true } = options;
    const statuses = await this.getPokemonStatuses(pokemonId);
    const removed = [];

    for (const status of statuses) {
      // 检查是否可驱散
      if (dispellableOnly && !status.dispellable) continue;

      // 检查类别
      if (category && status.category !== category) continue;

      await this.removeStatus(battleId, pokemonId, status.code);
      removed.push(status);
    }

    return removed;
  }

  /**
   * 获取精灵当前状态
   */
  async getPokemonStatuses(pokemonId) {
    // 先查Redis缓存
    const cacheKey = `statuses:pokemon:${pokemonId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const statuses = await this.prisma.battle_pokemon_status.findMany({
      where: { pokemon_instance_id: pokemonId },
      include: {
        status: {
          include: { mechanics: true }
        }
      }
    });

    const result = statuses.map(s => ({
      id: s.id,
      code: s.status.code,
      name: s.status.name,
      category: s.status.category,
      remaining_turns: s.remaining_turns,
      current_stacks: s.current_stacks,
      applied_at_turn: s.applied_at_turn,
      metadata: s.metadata,
      dispellable: s.status.dispellable,
      mechanics: s.status.mechanics
    }));

    // 缓存5秒
    await this.redis.setex(cacheKey, 5, JSON.stringify(result));

    return result;
  }

  /**
   * 获取能力变化
   */
  async getStatChanges(battleId, pokemonId) {
    const changes = await this.prisma.battle_stat_changes.findMany({
      where: {
        battle_id: battleId,
        pokemon_instance_id: pokemonId
      }
    });

    const result = {};
    for (const change of changes) {
      result[change.stat_type] = change.stage;
    }

    return result;
  }

  /**
   * 计算修正后的属性值
   */
  calculateModifiedStats(baseStats, statChanges) {
    const modified = { ...baseStats };

    const statMultipliers = {
      '-6': 0.25, '-5': 0.29, '-4': 0.33, '-3': 0.40, '-2': 0.50, '-1': 0.67,
      '0': 1.00,
      '1': 1.50, '2': 2.00, '3': 2.50, '4': 3.00, '5': 3.50, '6': 4.00
    };

    const accEvaMultipliers = {
      '-6': 0.33, '-5': 0.36, '-4': 0.43, '-3': 0.50, '-2': 0.60, '-1': 0.75,
      '0': 1.00,
      '1': 1.33, '2': 1.67, '3': 2.00, '4': 2.33, '5': 2.67, '6': 3.00
    };

    for (const [stat, stage] of Object.entries(statChanges)) {
      if (['accuracy', 'evasion'].includes(stat)) {
        modified[stat] = Math.floor(baseStats[stat] * accEvaMultipliers[stage.toString()]);
      } else if (stat !== 'crit_rate') {
        modified[stat] = Math.floor(baseStats[stat] * statMultipliers[stage.toString()]);
      }
    }

    return modified;
  }

  /**
   * 获取场地效果
   */
  async getFieldEffect(battleId) {
    const fieldStatuses = await this.prisma.battle_pokemon_status.findMany({
      where: {
        battle_id: battleId,
        status: { category: 'field' }
      },
      include: { status: true },
      orderBy: { applied_at_turn: 'desc' }
    });

    return fieldStatuses[0]?.status || null;
  }

  /**
   * 缓存状态到Redis
   */
  async cacheStatus(battleId, pokemonId, statusDef, record) {
    const key = `status:${battleId}:${pokemonId}:${statusDef.code}`;
    await this.redis.setex(key, 300, JSON.stringify({
      id: record.id,
      code: statusDef.code,
      remaining_turns: record.remaining_turns,
      metadata: record.metadata
    }));
  }

  /**
   * 记录状态事件到战斗日志
   */
  async logStatusEvent(battleId, eventType, data) {
    await this.prisma.battle_log.create({
      data: {
        battle_id: battleId,
        event_type: eventType,
        event_data: data,
        created_at: new Date()
      }
    });
  }

  /**
   * 获取精灵战斗数据
   */
  async getPokemonBattleData(battleId, pokemonId) {
    // 实现从数据库获取精灵数据
    const pokemon = await this.prisma.battle_pokemon.findFirst({
      where: {
        battle_id: battleId,
        instance_id: pokemonId
      }
    });
    return pokemon;
  }
}

module.exports = StatusEffectEngine;
```

### 3. API路由（backend/services/pokemon-service/src/routes/statusEffects.js）

```javascript
/**
 * 状态效果API路由
 */
const express = require('express');
const router = express.Router();
const StatusEffectEngine = require('../statusEffectEngine');
const { authenticate } = require('../../../shared/middleware/auth');
const { rateLimit } = require('../../../shared/middleware/rateLimit');

const statusEngine = new StatusEffectEngine(
  require('@prisma/client').PrismaClient,
  require('../../../shared/redis').getClient()
);

// 初始化缓存
statusEngine.initializeCache().catch(console.error);

/**
 * GET /api/pokemon/status-effects
 * 获取所有状态效果定义
 */
router.get('/definitions', authenticate, async (req, res) => {
  try {
    const { category } = req.query;

    const where = {};
    if (category) {
      where.category = category;
    }

    const statuses = await req.prisma.status_effect_definitions.findMany({
      where,
      include: { mechanics: true },
      orderBy: [{ category: 'asc' }, { priority: 'desc' }]
    });

    res.json({ success: true, data: statuses });
  } catch (error) {
    console.error('Get status definitions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pokemon/status-effects/:battleId/:pokemonId
 * 获取精灵当前状态
 */
router.get('/:battleId/:pokemonId', authenticate, async (req, res) => {
  try {
    const { battleId, pokemonId } = req.params;

    const statuses = await statusEngine.getPokemonStatuses(parseInt(pokemonId));
    const statChanges = await statusEngine.getStatChanges(battleId, parseInt(pokemonId));

    res.json({
      success: true,
      data: {
        statuses,
        statChanges
      }
    });
  } catch (error) {
    console.error('Get pokemon status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/pokemon/status-effects/apply
 * 施加状态效果（管理员/测试用）
 */
router.post('/apply', authenticate, rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    const { battleId, targetId, statusCode, options } = req.body;

    const result = await statusEngine.applyStatus(
      battleId,
      parseInt(targetId),
      statusCode,
      options || {}
    );

    res.json(result);
  } catch (error) {
    console.error('Apply status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/pokemon/status-effects/remove
 * 移除状态效果
 */
router.post('/remove', authenticate, async (req, res) => {
  try {
    const { battleId, pokemonId, statusCode } = req.body;

    const result = await statusEngine.removeStatus(
      battleId,
      parseInt(pokemonId),
      statusCode
    );

    res.json({ success: result });
  } catch (error) {
    console.error('Remove status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/pokemon/status-effects/dispel
 * 驱散状态效果
 */
router.post('/dispel', authenticate, async (req, res) => {
  try {
    const { battleId, pokemonId, category, dispellableOnly } = req.body;

    const removed = await statusEngine.dispelStatuses(
      battleId,
      parseInt(pokemonId),
      { category, dispellableOnly: dispellableOnly !== false }
    );

    res.json({
      success: true,
      removed: removed.map(s => ({ code: s.code, name: s.name }))
    });
  } catch (error) {
    console.error('Dispel statuses error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pokemon/status-effects/field/:battleId
 * 获取场地效果
 */
router.get('/field/:battleId', authenticate, async (req, res) => {
  try {
    const { battleId } = req.params;

    const fieldEffect = await statusEngine.getFieldEffect(battleId);

    res.json({ success: true, data: fieldEffect });
  } catch (error) {
    console.error('Get field effect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/pokemon/status-effects/check-action
 * 检查行动是否被阻止
 */
router.post('/check-action', authenticate, async (req, res) => {
  try {
    const { battleId, pokemonId, actionType } = req.body;

    const result = await statusEngine.checkActionBlocked(
      battleId,
      parseInt(pokemonId),
      actionType
    );

    res.json(result);
  } catch (error) {
    console.error('Check action blocked error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

### 4. 前端状态显示组件（frontend/game-client/src/components/StatusEffectDisplay.js）

```javascript
/**
 * 状态效果显示组件
 */
import React, { useState, useEffect } from 'react';
import './StatusEffectDisplay.css';

const STATUS_ICONS = {
  burn: '🔥',
  paralysis: '⚡',
  freeze: '❄️',
  sleep: '💤',
  confusion: '😵',
  poison: '☠️',
  toxic: '☢️',
  flinch: '😰',
  attract: '💕',
  bound: '⛓️',
  curse_ghost: '👻',
  leech_seed: '🌱',
  protect: '🛡️',
  substitute: '🎭',
  charging: '⚡',
  recharging: '😴'
};

const STAT_CHANGE_ICONS = {
  attack_up: '⚔️↑',
  attack_down: '⚔️↓',
  defense_up: '🛡️↑',
  defense_down: '🛡️↓',
  sp_attack_up: '✨↑',
  sp_attack_down: '✨↓',
  sp_defense_up: '🔮↑',
  sp_defense_down: '🔮↓',
  speed_up: '💨↑',
  speed_down: '💨↓',
  accuracy_up: '🎯↑',
  accuracy_down: '🎯↓',
  evasion_up: '👁️↑',
  evasion_down: '👁️↓',
  crit_rate_up: '💥↑'
};

const CATEGORY_COLORS = {
  control: '#e74c3c',
  dot: '#9b59b6',
  stat_change: '#3498db',
  field: '#2ecc71',
  special: '#f39c12'
};

function StatusEffectDisplay({ pokemonId, battleId, onStatusClick }) {
  const [statuses, setStatuses] = useState([]);
  const [statChanges, setStatChanges] = useState({});
  const [selectedStatus, setSelectedStatus] = useState(null);

  useEffect(() => {
    if (!pokemonId || !battleId) return;

    const fetchStatuses = async () => {
      try {
        const response = await fetch(
          `/api/pokemon/status-effects/${battleId}/${pokemonId}`,
          { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
        );
        const data = await response.json();
        if (data.success) {
          setStatuses(data.data.statuses);
          setStatChanges(data.data.statChanges);
        }
      } catch (error) {
        console.error('Failed to fetch statuses:', error);
      }
    };

    fetchStatuses();
    const interval = setInterval(fetchStatuses, 2000); // 每2秒刷新

    return () => clearInterval(interval);
  }, [pokemonId, battleId]);

  const renderStatusIcon = (status) => {
    const icon = STATUS_ICONS[status.code] || '❓';
    const color = CATEGORY_COLORS[status.category] || '#95a5a6';

    return (
      <div
        key={status.id}
        className={`status-icon ${status.category}`}
        style={{ borderColor: color }}
        onClick={() => {
          setSelectedStatus(status);
          onStatusClick?.(status);
        }}
        title={`${status.name}${status.remaining_turns ? ` (${status.remaining_turns}回合)` : ''}`}
      >
        <span className="icon">{icon}</span>
        {status.remaining_turns && (
          <span className="turns">{status.remaining_turns}</span>
        )}
        {status.current_stacks > 1 && (
          <span className="stacks">×{status.current_stacks}</span>
        )}
      </div>
    );
  };

  const renderStatChange = (stat, stage) => {
    if (stage === 0) return null;

    const isPositive = stage > 0;
    const baseCode = isPositive ? `${stat}_up` : `${stat}_down`;
    const icon = STAT_CHANGE_ICONS[baseCode];

    const level = Math.abs(stage);
    const intensity = Math.min(level, 6) / 6;

    return (
      <div
        key={stat}
        className={`stat-change ${isPositive ? 'positive' : 'negative'}`}
        style={{ opacity: 0.5 + intensity * 0.5 }}
      >
        <span className="stat-icon">{icon}</span>
        <span className="stat-stage">
          {isPositive ? '+' : ''}{stage}
        </span>
      </div>
    );
  };

  const renderStatusDetail = () => {
    if (!selectedStatus) return null;

    return (
      <div className="status-detail-modal" onClick={() => setSelectedStatus(null)}>
        <div className="status-detail-content" onClick={e => e.stopPropagation()}>
          <div className="status-detail-header">
            <span className="status-icon-large">
              {STATUS_ICONS[selectedStatus.code] || '❓'}
            </span>
            <h3>{selectedStatus.name}</h3>
          </div>
          <div className="status-detail-body">
            <p className="category">
              类别: <span style={{ color: CATEGORY_COLORS[selectedStatus.category] }}>
                {getCategoryName(selectedStatus.category)}
              </span>
            </p>
            {selectedStatus.remaining_turns && (
              <p className="duration">
                剩余回合: <strong>{selectedStatus.remaining_turns}</strong>
              </p>
            )}
            <p className="description">{getStatusDescription(selectedStatus.code)}</p>
          </div>
          <button onClick={() => setSelectedStatus(null)}>关闭</button>
        </div>
      </div>
    );
  };

  return (
    <div className="status-effect-display">
      <div className="statuses-container">
        {statuses.map(renderStatusIcon)}
      </div>
      <div className="stat-changes-container">
        {Object.entries(statChanges).map(([stat, stage]) =>
          renderStatChange(stat, stage)
        )}
      </div>
      {renderStatusDetail()}
    </div>
  );
}

function getCategoryName(category) {
  const names = {
    control: '控制',
    dot: '持续伤害',
    stat_change: '能力变化',
    field: '场地效果',
    special: '特殊状态'
  };
  return names[category] || category;
}

function getStatusDescription(code) {
  const descriptions = {
    burn: '每回合损失1/8最大HP，物理攻击伤害降低50%',
    paralysis: '有25%概率无法行动，速度降低50%',
    freeze: '无法行动，受到火属性攻击时有20%概率解除',
    sleep: '无法行动1-3回合，受到伤害时会苏醒',
    confusion: '有33%概率攻击自己，造成自身攻击力40%的伤害',
    poison: '每回合损失1/8最大HP',
    toxic: '每回合损失递增的伤害（1/16, 2/16, 3/16...）',
    flinch: '跳过当回合行动（仅当先制技能触发时）',
    protect: '免疫当回合所有攻击技能',
    substitute: '替身承受伤害，替身消失前本体免疫异常状态'
  };
  return descriptions[code] || '状态效果';
}

export default StatusEffectDisplay;
```

### 5. Prometheus指标（backend/services/pokemon-service/src/statusMetrics.js）

```javascript
/**
 * 状态效果相关Prometheus指标
 */
const promClient = require('prom-client');

const statusMetrics = {
  // 状态效果施加计数
  statusAppliedTotal: new promClient.Counter({
    name: 'pokemon_status_applied_total',
    help: 'Total number of status effects applied',
    labelNames: ['status_code', 'category', 'source']
  }),

  // 状态效果移除计数
  statusRemovedTotal: new promClient.Counter({
    name: 'pokemon_status_removed_total',
    help: 'Total number of status effects removed',
    labelNames: ['status_code', 'reason'] // reason: expired, dispelled, battle_end
  }),

  // 当前活跃状态数
  activeStatusGauge: new promClient.Gauge({
    name: 'pokemon_active_status_count',
    help: 'Current number of active status effects in battles',
    labelNames: ['status_code', 'category']
  }),

  // 状态效果阻止行动次数
  actionBlockedTotal: new promClient.Counter({
    name: 'pokemon_status_action_blocked_total',
    help: 'Total number of actions blocked by status effects',
    labelNames: ['status_code', 'action_type']
  }),

  // 能力变化分布
  statChangeHistogram: new promClient.Histogram({
    name: 'pokemon_stat_change_distribution',
    help: 'Distribution of stat changes',
    labelNames: ['stat_type'],
    buckets: [-6, -4, -2, 0, 2, 4, 6]
  }),

  // 状态效果处理时间
  statusProcessingTime: new promClient.Histogram({
    name: 'pokemon_status_processing_time_seconds',
    help: 'Time spent processing status effects',
    labelNames: ['operation'], // apply, remove, turn_process
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5]
  })
};

module.exports = statusMetrics;
```

## 验收标准

- [ ] 数据库迁移成功执行，创建6个新表
- [ ] 40+ 种状态效果定义正确导入
- [ ] 状态效果施加逻辑正确，包括免疫检查
- [ ] 回合开始/结束的状态效果处理正确
- [ ] 能力变化计算准确（±6级范围）
- [ ] 控制类状态正确阻止行动（睡眠、冰冻、麻痹、混乱、畏缩）
- [ ] 持续伤害计算正确（中毒、剧毒、灼伤、寄生种子）
- [ ] 状态效果驱散功能正常
- [ ] 场地效果系统正常工作
- [ ] 前端状态图标正确显示
- [ ] 状态详情弹窗显示完整信息
- [ ] Prometheus指标正确收集
- [ ] 单元测试覆盖率 > 85%
- [ ] 集成测试覆盖核心场景
- [ ] API文档完整

## 影响范围

- **新增文件**:
  - `database/pending/20260610_140000__add_status_effects_system.sql`
  - `backend/services/pokemon-service/src/statusEffectEngine.js`
  - `backend/services/pokemon-service/src/routes/statusEffects.js`
  - `backend/services/pokemon-service/src/statusMetrics.js`
  - `frontend/game-client/src/components/StatusEffectDisplay.js`
  - `frontend/game-client/src/components/StatusEffectDisplay.css`
  - `backend/tests/unit/status-effects.test.js`

- **修改文件**:
  - `backend/services/gym-service/src/battleEngine.js`（集成状态效果引擎）
  - `backend/services/pokemon-service/src/index.js`（注册路由）
  - `backend/shared/metrics.js`（导出状态效果指标）
  - `frontend/game-client/src/components/BattleScene.js`（集成状态显示）

## 参考

- [Pokémon Status Conditions](https://bulbapedia.bulbagarden.net/wiki/Status_condition)
- [Pokémon Stat Modifiers](https://bulbapedia.bulbagarden.net/wiki/Stat_modifier)
- [Pokémon Terrain Effects](https://bulbapedia.bulbagarden.net/wiki/Terrain)
