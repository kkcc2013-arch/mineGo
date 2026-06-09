# REQ-00046: 精灵培育系统与遗传机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00046 |
| 标题 | 精灵培育系统与遗传机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service, user-service, social-service, gateway, game-client, database/migrations |
| 创建时间 | 2026-06-09 08:00 |

## 需求描述

实现精灵培育（Breeding）系统，允许玩家通过配对两只精灵培育出具有遗传特性的后代精灵。这是 Pokémon 游戏的核心机制之一，极大增强游戏深度和玩家粘性。

### 核心功能
1. **培育中心**：玩家放置精灵进行培育的虚拟场所
2. **遗传机制**：子代精灵从父母遗传个体值、技能、特性
3. **蛋组系统**：相同蛋组的精灵才能配对繁殖
4. **孵化机制**：通过行走距离孵化精灵蛋
5. **培育记录**：追踪精灵家族谱系和培育历史

### 业务价值
- 增强玩家粘性（培育稀有高个体值精灵）
- 提供长期目标（培育完美精灵）
- 促进社交互动（交换培育精灵）
- 经济系统补充（培育服务、蛋交易）

## 技术方案

### 1. 数据库设计

#### 数据库迁移：`database/pending/20260609_080000__add_breeding_system.sql`

```sql
-- 精灵培育中心表
CREATE TABLE breeding_centers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL DEFAULT '培育中心',
    slots INTEGER NOT NULL DEFAULT 4, -- 培育槽位数量
    upgraded_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 培育配对表
CREATE TABLE breeding_pairs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    center_id UUID NOT NULL REFERENCES breeding_centers(id) ON DELETE CASCADE,
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0 AND slot_index < 10),
    
    -- 父母精灵
    parent1_pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    parent2_pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    
    -- 培育状态
    status VARCHAR(20) NOT NULL DEFAULT 'breeding', -- breeding, ready, collected
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ready_at TIMESTAMP, -- 培育完成时间
    collected_at TIMESTAMP,
    
    -- 预生成后代数据（JSON）
    offspring_data JSONB NOT NULL,
    offspring_id UUID REFERENCES user_pokemon(id) ON DELETE SET NULL,
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(center_id, slot_index),
    CONSTRAINT valid_parents CHECK (parent1_pokemon_id != parent2_pokemon_id)
);

-- 精灵蛋组定义
CREATE TABLE egg_groups (
    id INTEGER PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT
);

-- 精灵物种蛋组关联
CREATE TABLE species_egg_groups (
    species_id INTEGER NOT NULL REFERENCES pokemon_species(id) ON DELETE CASCADE,
    egg_group_id INTEGER NOT NULL REFERENCES egg_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (species_id, egg_group_id)
);

-- 精灵孵化进度表
CREATE TABLE egg_hatching (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    
    -- 孵化进度
    current_steps INTEGER NOT NULL DEFAULT 0,
    required_steps INTEGER NOT NULL,
    
    -- 孵化器加速
    incubator_type VARCHAR(20) NOT NULL DEFAULT 'basic', -- basic, super, infinite
    incubator_uses_remaining INTEGER, -- NULL = 无限使用
    
    -- 孵化状态
    status VARCHAR(20) NOT NULL DEFAULT 'incubating', -- incubating, hatched
    hatched_at TIMESTAMP,
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 精灵谱系表（家族树）
CREATE TABLE pokemon_lineage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 1,
    
    -- 父母信息
    parent1_id UUID REFERENCES user_pokemon(id) ON DELETE SET NULL,
    parent1_species_id INTEGER REFERENCES pokemon_species(id),
    parent1_nickname VARCHAR(50),
    
    parent2_id UUID REFERENCES user_pokemon(id) ON DELETE SET NULL,
    parent2_species_id INTEGER REFERENCES pokemon_species(id),
    parent2_nickname VARCHAR(50),
    
    -- 培育信息
    bred_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    bred_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(pokemon_id)
);

-- 培育历史记录
CREATE TABLE breeding_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 配对信息
    parent1_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    parent2_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    
    -- 后代信息
    offspring_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    offspring_shiny BOOLEAN NOT NULL DEFAULT FALSE,
    offspring_ivs JSONB NOT NULL,
    
    -- 培育时间
    bred_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- 索引优化
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_breeding_centers_user ON breeding_centers(user_id);
CREATE INDEX idx_breeding_pairs_center ON breeding_pairs(center_id);
CREATE INDEX idx_breeding_pairs_status ON breeding_pairs(status, ready_at);
CREATE INDEX idx_egg_hatching_user ON egg_hatching(user_id, status);
CREATE INDEX idx_egg_hatching_status ON egg_hatching(status, current_steps);
CREATE INDEX idx_pokemon_lineage_pokemon ON pokemon_lineage(pokemon_id);
CREATE INDEX idx_pokemon_lineage_parent ON pokemon_lineage(parent1_id, parent2_id);
CREATE INDEX idx_breeding_history_user ON breeding_history(user_id, bred_at DESC);

-- 插入蛋组数据（15个蛋组）
INSERT INTO egg_groups (id, name, description) VALUES
(1, 'Monster', '怪兽型精灵'),
(2, 'Water 1', '水生型精灵 1'),
(3, 'Water 2', '水生型精灵 2'),
(4, 'Water 3', '水生型精灵 3'),
(5, 'Bug', '虫型精灵'),
(6, 'Flying', '飞行型精灵'),
(7, 'Field', '陆上型精灵'),
(8, 'Fairy', '妖精型精灵'),
(9, 'Grass', '植物型精灵'),
(10, 'Human-Like', '人型精灵'),
(11, 'Mineral', '矿物型精灵'),
(12, 'Amorphous', '不定形精灵'),
(13, 'Ditto', '百变怪（可与任何蛋组配对）'),
(14, 'Dragon', '龙型精灵'),
(15, 'Undiscovered', '未知组（无法培育）');

-- 示例：皮卡丘蛋组（Field + Fairy）
INSERT INTO species_egg_groups (species_id, egg_group_id) VALUES
(25, 7), (25, 8); -- 皮卡丘：陆上 + 妖精

-- 百变怪特殊规则：可与任何非未知组精灵配对
INSERT INTO species_egg_groups (species_id, egg_group_id) VALUES
(132, 13); -- 百变怪

COMMENT ON TABLE breeding_pairs IS '精灵培育配对记录';
COMMENT ON TABLE egg_hatching IS '精灵蛋孵化进度追踪';
COMMENT ON TABLE pokemon_lineage IS '精灵家族谱系';
```

### 2. 培育服务核心逻辑

#### 文件：`backend/services/pokemon-service/src/breedingService.js`

```javascript
const { db } = require('../../shared/db');
const { logger, metrics } = require('../../shared');

/**
 * 精灵培育服务
 */
class BreedingService {
  constructor() {
    // 培育时间配置（分钟）
    this.breedingDuration = {
      basic: 30,      // 基础培育时间
      upgraded: 20,   // 升级后培育时间
      premium: 10     // 高级培育时间
    };
    
    // 孵化所需步数
    this.hatchSteps = {
      common: 2560,     // 普通精灵
      uncommon: 3840,   // 较稀有
      rare: 5120,       // 稀有
      legendary: 10240  // 传说
    };
    
    // 遗传概率
    this.inheritanceChances = {
      iv_single: 0.5,     // 单项个体值遗传概率
      iv_three: 0.5,      // 三项遗传概率
      move: 0.6,          // 技能遗传概率
      ability: 0.6,       // 特性遗传概率
      nature: 0.5,        // 性格遗传概率
      ball: 0.5           // 精灵球遗传概率
    };
  }

  /**
   * 检查两只精灵是否可以培育
   */
  async canBreed(parent1Id, parent2Id, userId) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取两只精灵的详细信息
      const pokemon1 = await this.getPokemonWithSpecies(client, parent1Id, userId);
      const pokemon2 = await this.getPokemonWithSpecies(client, parent2Id, userId);
      
      if (!pokemon1 || !pokemon2) {
        return { canBreed: false, reason: '精灵不存在或无权访问' };
      }
      
      // 检查是否为蛋状态
      if (pokemon1.is_egg || pokemon2.is_egg) {
        return { canBreed: false, reason: '精灵蛋无法培育' };
      }
      
      // 检查性别（需要至少一雄一雌，或其中一只为百变怪）
      const gender1 = pokemon1.gender;
      const gender2 = pokemon2.gender;
      
      const isDitto1 = pokemon1.species_id === 132; // 百变怪
      const isDitto2 = pokemon2.species_id === 132;
      
      // 性别检查规则
      if (!isDitto1 && !isDitto2) {
        // 两只都不是百变怪，需要一雄一雌
        if (gender1 === gender2) {
          return { canBreed: false, reason: '需要一雄一雌的精灵配对' };
        }
      } else if (isDitto1 && isDitto2) {
        // 两只都是百变怪，无法培育
        return { canBreed: false, reason: '两只百变怪无法培育' };
      }
      
      // 检查蛋组兼容性
      const eggGroups1 = await this.getEggGroups(client, pokemon1.species_id);
      const eggGroups2 = await this.getEggGroups(client, pokemon2.species_id);
      
      const canBreed = this.checkEggGroupCompatibility(eggGroups1, eggGroups2);
      
      if (!canBreed) {
        return { canBreed: false, reason: '这两只精灵的蛋组不兼容' };
      }
      
      // 检查是否为未知组
      if (eggGroups1.includes(15) || eggGroups2.includes(15)) {
        return { canBreed: false, reason: '该精灵无法培育' };
      }
      
      await client.query('COMMIT');
      
      return {
        canBreed: true,
        parent1: pokemon1,
        parent2: pokemon2,
        eggGroups1,
        eggGroups2
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('检查培育兼容性失败', { error, parent1Id, parent2Id });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 开始培育配对
   */
  async startBreeding(userId, parent1Id, parent2Id, centerId, slotIndex) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 检查培育权限
      const breedCheck = await this.canBreed(parent1Id, parent2Id, userId);
      if (!breedCheck.canBreed) {
        throw new Error(breedCheck.reason);
      }
      
      // 检查培育中心槽位
      const center = await client.query(
        `SELECT * FROM breeding_centers WHERE id = $1 AND user_id = $2`,
        [centerId, userId]
      );
      
      if (center.rows.length === 0) {
        throw new Error('培育中心不存在');
      }
      
      if (slotIndex >= center.rows[0].slots) {
        throw new Error('槽位索引超出范围');
      }
      
      // 检查槽位是否已占用
      const existingPair = await client.query(
        `SELECT id FROM breeding_pairs WHERE center_id = $1 AND slot_index = $2`,
        [centerId, slotIndex]
      );
      
      if (existingPair.rows.length > 0) {
        throw new Error('该槽位已被占用');
      }
      
      // 检查精灵是否正在培育中
      const inBreeding = await client.query(
        `SELECT id FROM breeding_pairs 
         WHERE (parent1_pokemon_id = $1 OR parent1_pokemon_id = $2 
                OR parent2_pokemon_id = $1 OR parent2_pokemon_id = $2)
         AND status IN ('breeding', 'ready')`,
        [parent1Id, parent2Id]
      );
      
      if (inBreeding.rows.length > 0) {
        throw new Error('精灵已在其他配对中培育');
      }
      
      // 生成后代数据
      const offspringData = await this.generateOffspringData(
        breedCheck.parent1, 
        breedCheck.parent2
      );
      
      // 计算培育完成时间
      const duration = this.breedingDuration.basic;
      const readyAt = new Date(Date.now() + duration * 60 * 1000);
      
      // 创建培育配对
      const result = await client.query(
        `INSERT INTO breeding_pairs 
         (center_id, slot_index, parent1_pokemon_id, parent2_pokemon_id, 
          offspring_data, ready_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'breeding')
         RETURNING *`,
        [centerId, slotIndex, parent1Id, parent2Id, 
         JSON.stringify(offspringData), readyAt]
      );
      
      // 锁定精灵（添加培育状态）
      await client.query(
        `UPDATE user_pokemon SET is_breeding = true 
         WHERE id IN ($1, $2)`,
        [parent1Id, parent2Id]
      );
      
      await client.query('COMMIT');
      
      // 记录指标
      metrics.increment('breeding.started');
      metrics.histogram('breeding.duration_minutes', duration);
      
      logger.info('培育配对已创建', {
        userId,
        pairId: result.rows[0].id,
        parent1Id,
        parent2Id,
        readyAt
      });
      
      return {
        pair: result.rows[0],
        readyAt,
        duration
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('开始培育失败', { error, userId, parent1Id, parent2Id });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 生成后代精灵数据
   */
  async generateOffspringData(parent1, parent2) {
    const offspring = {
      species_id: null,
      gender: null,
      ivs: {},
      moves: [],
      ability: null,
      nature: null,
      shiny: false,
      ball_type: null
    };
    
    // 确定物种（子代总是雌性物种，或非百变怪物种）
    const mother = parent1.gender === 'female' ? parent1 : parent2;
    const father = parent1.gender === 'male' ? parent1 : parent2;
    
    // 百变怪特殊处理
    const isDittoParent = parent1.species_id === 132 || parent2.species_id === 132;
    
    if (isDittoParent) {
      // 与百变怪培育，子代为非百变怪物种
      offspring.species_id = parent1.species_id === 132 
        ? parent2.species_id 
        : parent1.species_id;
    } else {
      offspring.species_id = mother.species_id;
    }
    
    // 遗传个体值（3项从父母遗传）
    const parentIVs = [
      { parent: 'parent1', ivs: parent1.ivs },
      { parent: 'parent2', ivs: parent2.ivs }
    ];
    
    const inheritedStats = this.selectInheritedStats(parent1.ivs, parent2.ivs);
    offspring.ivs = inheritedStats.ivs;
    offspring.inherited_from = inheritedStats.from;
    
    // 遗传技能
    offspring.moves = this.inheritMoves(parent1, parent2);
    
    // 遗传特性
    offspring.ability = this.inheritAbility(parent1, parent2);
    
    // 遗传性格
    offspring.nature = this.inheritNature(parent1, parent2);
    
    // 精灵球遗传
    offspring.ball_type = this.inheritBall(mother, father);
    
    // 性别决定
    offspring.gender = await this.determineGender(offspring.species_id);
    
    // 闪光判定（闪光父母提高几率）
    const shinyChance = this.calculateShinyChance(parent1.shiny, parent2.shiny);
    offspring.shiny = Math.random() < shinyChance;
    
    return offspring;
  }

  /**
   * 选择遗传的个体值
   */
  selectInheritedStats(ivs1, ivs2) {
    const stats = ['hp', 'attack', 'defense', 'sp_attack', 'sp_defense', 'speed'];
    const result = {
      ivs: { hp: 0, attack: 0, defense: 0, sp_attack: 0, sp_defense: 0, speed: 0 },
      from: []
    };
    
    // 随机选择3项遗传
    const selectedStats = this.shuffle(stats).slice(0, 3);
    
    for (const stat of selectedStats) {
      const parent = Math.random() < 0.5 ? 1 : 2;
      const parentIVs = parent === 1 ? ivs1 : ivs2;
      
      result.ivs[stat] = parentIVs[stat] || Math.floor(Math.random() * 32);
      result.from.push({ stat, parent: `parent${parent}` });
    }
    
    // 剩余3项随机生成
    for (const stat of stats) {
      if (!selectedStats.includes(stat)) {
        result.ivs[stat] = Math.floor(Math.random() * 32);
      }
    }
    
    return result;
  }

  /**
   * 遗传技能
   */
  inheritMoves(parent1, parent2) {
    const inheritedMoves = [];
    const allMoves = [...parent1.moves || [], ...parent2.moves || []];
    
    // 过滤可遗传技能
    const breedableMoves = allMoves.filter(m => m.is_breedable);
    
    // 随机选择最多4个技能
    const selectedMoves = this.shuffle(breedableMoves).slice(0, 4);
    
    for (const move of selectedMoves) {
      if (Math.random() < this.inheritanceChances.move) {
        inheritedMoves.push({
          move_id: move.move_id,
          inherited_from: move.parent_id
        });
      }
    }
    
    return inheritedMoves;
  }

  /**
   * 遗传特性
   */
  inheritAbility(parent1, parent2) {
    // 60% 遗传母亲的特性
    const mother = parent1.gender === 'female' ? parent1 : parent2;
    const father = parent1.gender === 'male' ? parent1 : parent2;
    
    if (Math.random() < this.inheritanceChances.ability) {
      return mother.ability_id;
    }
    
    return father.ability_id;
  }

  /**
   * 遗传性格
   */
  inheritNature(parent1, parent2) {
    if (Math.random() < this.inheritanceChances.nature) {
      return Math.random() < 0.5 ? parent1.nature_id : parent2.nature_id;
    }
    
    // 随机性格
    return Math.floor(Math.random() * 25) + 1;
  }

  /**
   * 遗传精灵球
   */
  inheritBall(mother, father) {
    if (Math.random() < this.inheritanceChances.ball) {
      return mother.ball_type;
    }
    return 'pokeball'; // 默认普通球
  }

  /**
   * 计算闪光几率
   */
  calculateShinyChance(parent1Shiny, parent2Shiny) {
    const baseChance = 1 / 4096; // 基础闪光率
    
    if (parent1Shiny && parent2Shiny) {
      return baseChance * 4; // 双闪光父母：4倍几率
    } else if (parent1Shiny || parent2Shiny) {
      return baseChance * 2; // 单闪光父母：2倍几率
    }
    
    return baseChance;
  }

  /**
   * 检查蛋组兼容性
   */
  checkEggGroupCompatibility(eggGroups1, eggGroups2) {
    // 百变怪组可以与任何组配对（除了未知组）
    if (eggGroups1.includes(13) && !eggGroups2.includes(15)) return true;
    if (eggGroups2.includes(13) && !eggGroups1.includes(15)) return true;
    
    // 检查是否有共同蛋组
    const commonGroups = eggGroups1.filter(g => eggGroups2.includes(g));
    return commonGroups.length > 0;
  }

  /**
   * 获取精灵蛋组
   */
  async getEggGroups(client, speciesId) {
    const result = await client.query(
      `SELECT egg_group_id FROM species_egg_groups WHERE species_id = $1`,
      [speciesId]
    );
    return result.rows.map(r => r.egg_group_id);
  }

  /**
   * 收集培育完成的精灵蛋
   */
  async collectEgg(userId, pairId) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取培育配对
      const pairResult = await client.query(
        `SELECT * FROM breeding_pairs 
         WHERE id = $1 AND status = 'ready'`,
        [pairId]
      );
      
      if (pairResult.rows.length === 0) {
        throw new Error('培育配对不存在或未完成');
      }
      
      const pair = pairResult.rows[0];
      
      // 创建精灵蛋
      const offspringData = pair.offspring_data;
      const egg = await client.query(
        `INSERT INTO user_pokemon 
         (user_id, species_id, is_egg, ivs, moves, ability_id, nature_id, 
          shiny, ball_type, gender, created_at)
         VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING *`,
        [userId, offspringData.species_id, 
         JSON.stringify(offspringData.ivs),
         JSON.stringify(offspringData.moves),
         offspringData.ability,
         offspringData.nature,
         offspringData.shiny,
         offspringData.ball_type,
         offspringData.gender]
      );
      
      // 创建孵化记录
      const hatchSteps = this.getHatchSteps(offspringData.species_id);
      await client.query(
        `INSERT INTO egg_hatching 
         (user_id, pokemon_id, required_steps, status)
         VALUES ($1, $2, $3, 'incubating')`,
        [userId, egg.rows[0].id, hatchSteps]
      );
      
      // 记录谱系
      await client.query(
        `INSERT INTO pokemon_lineage 
         (pokemon_id, generation, parent1_id, parent1_species_id, 
          parent2_id, parent2_species_id, bred_by_user_id)
         VALUES ($1, 2, $2, $3, $4, $5, $6)`,
        [egg.rows[0].id, pair.parent1_pokemon_id, 
         offspringData.species_id, // 简化处理
         pair.parent2_pokemon_id, 
         offspringData.species_id,
         userId]
      );
      
      // 更新培育配对状态
      await client.query(
        `UPDATE breeding_pairs 
         SET status = 'collected', offspring_id = $1, collected_at = NOW()
         WHERE id = $2`,
        [egg.rows[0].id, pairId]
      );
      
      // 解锁父母精灵
      await client.query(
        `UPDATE user_pokemon SET is_breeding = false 
         WHERE id IN ($1, $2)`,
        [pair.parent1_pokemon_id, pair.parent2_pokemon_id]
      );
      
      // 记录培育历史
      await client.query(
        `INSERT INTO breeding_history 
         (user_id, parent1_species_id, parent2_species_id, 
          offspring_species_id, offspring_shiny, offspring_ivs)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, pair.parent1_pokemon_id, pair.parent2_pokemon_id,
         offspringData.species_id, offspringData.shiny, 
         JSON.stringify(offspringData.ivs)]
      );
      
      await client.query('COMMIT');
      
      metrics.increment('breeding.egg_collected');
      if (offspringData.shiny) {
        metrics.increment('breeding.shiny_born');
      }
      
      logger.info('精灵蛋已收集', {
        userId,
        pairId,
        eggId: egg.rows[0].id,
        species: offspringData.species_id,
        shiny: offspringData.shiny
      });
      
      return {
        egg: egg.rows[0],
        hatchSteps
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 更新孵化进度
   */
  async updateHatchingProgress(userId, steps) {
    const client = await db.connect();
    
    try {
      // 获取正在孵化的蛋
      const eggs = await client.query(
        `SELECT eh.*, up.species_id 
         FROM egg_hatching eh
         JOIN user_pokemon up ON eh.pokemon_id = up.id
         WHERE eh.user_id = $1 AND eh.status = 'incubating'
         ORDER BY eh.created_at ASC`,
        [userId]
      );
      
      const hatched = [];
      
      for (const egg of eggs.rows) {
        const newSteps = egg.current_steps + steps;
        
        if (newSteps >= egg.required_steps) {
          // 孵化完成
          await client.query(
            `UPDATE egg_hatching 
             SET status = 'hatched', current_steps = $1, hatched_at = NOW()
             WHERE id = $2`,
            [newSteps, egg.id]
          );
          
          // 更新精灵状态（不再是蛋）
          await client.query(
            `UPDATE user_pokemon SET is_egg = false WHERE id = $1`,
            [egg.pokemon_id]
          );
          
          hatched.push(egg);
          
          metrics.increment('breeding.egg_hatched');
        } else {
          // 更新进度
          await client.query(
            `UPDATE egg_hatching SET current_steps = $1, updated_at = NOW()
             WHERE id = $2`,
            [newSteps, egg.id]
          );
        }
      }
      
      return {
        updated: eggs.rows.length,
        hatched: hatched.length,
        hatchedEggs: hatched
      };
      
    } finally {
      client.release();
    }
  }

  /**
   * 辅助方法
   */
  shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  getHatchSteps(speciesId) {
    // 根据物种稀有度返回孵化步数
    const rareSpecies = [150, 151, 144, 145, 146]; // 传说精灵
    const uncommonSpecies = [25, 133, 6, 9, 3]; // 稀有精灵
    
    if (rareSpecies.includes(speciesId)) return this.hatchSteps.legendary;
    if (uncommonSpecies.includes(speciesId)) return this.hatchSteps.uncommon;
    return this.hatchSteps.common;
  }

  async determineGender(speciesId) {
    // 简化实现：随机性别
    return Math.random() < 0.5 ? 'male' : 'female';
  }

  async getPokemonWithSpecies(client, pokemonId, userId) {
    const result = await client.query(
      `SELECT up.*, ps.base_happiness, ps.growth_rate
       FROM user_pokemon up
       JOIN pokemon_species ps ON up.species_id = ps.id
       WHERE up.id = $1 AND up.user_id = $2`,
      [pokemonId, userId]
    );
    return result.rows[0];
  }
}

module.exports = new BreedingService();
```

### 3. 培育 API 路由

#### 文件：`backend/services/pokemon-service/src/routes/breeding.js`

```javascript
const express = require('express');
const router = express.Router();
const breedingService = require('../breedingService');
const { authMiddleware } = require('../../../shared/auth');
const { logger, metrics } = require('../../../shared');

/**
 * 获取用户培育中心
 */
router.get('/center', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      `SELECT * FROM breeding_centers WHERE user_id = $1`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      // 自动创建培育中心
      const createResult = await db.query(
        `INSERT INTO breeding_centers (user_id, slots) VALUES ($1, 4) RETURNING *`,
        [userId]
      );
      return res.json({ center: createResult.rows[0] });
    }
    
    res.json({ center: result.rows[0] });
    
  } catch (error) {
    logger.error('获取培育中心失败', { error, userId: req.user.id });
    res.status(500).json({ error: '获取培育中心失败' });
  }
});

/**
 * 检查培育兼容性
 */
router.post('/check-compatibility', authMiddleware, async (req, res) => {
  try {
    const { parent1Id, parent2Id } = req.body;
    const userId = req.user.id;
    
    const result = await breedingService.canBreed(parent1Id, parent2Id, userId);
    
    res.json(result);
    
  } catch (error) {
    logger.error('检查培育兼容性失败', { error, userId: req.user.id });
    res.status(500).json({ error: '检查失败' });
  }
});

/**
 * 开始培育
 */
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const { parent1Id, parent2Id, centerId, slotIndex } = req.body;
    const userId = req.user.id;
    
    const result = await breedingService.startBreeding(
      userId, parent1Id, parent2Id, centerId, slotIndex
    );
    
    res.json({
      success: true,
      pair: result.pair,
      readyAt: result.readyAt,
      duration: result.duration
    });
    
  } catch (error) {
    logger.error('开始培育失败', { error, userId: req.user.id });
    res.status(400).json({ error: error.message });
  }
});

/**
 * 获取培育中的配对
 */
router.get('/pairs', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;
    
    let query = `
      SELECT bp.*, 
             up1.nickname as parent1_nickname, up1.species_id as parent1_species,
             up2.nickname as parent2_nickname, up2.species_id as parent2_species
      FROM breeding_pairs bp
      JOIN breeding_centers bc ON bp.center_id = bc.id
      LEFT JOIN user_pokemon up1 ON bp.parent1_pokemon_id = up1.id
      LEFT JOIN user_pokemon up2 ON bp.parent2_pokemon_id = up2.id
      WHERE bc.user_id = $1
    `;
    
    const params = [userId];
    
    if (status) {
      query += ` AND bp.status = $2`;
      params.push(status);
    }
    
    query += ` ORDER BY bp.created_at DESC`;
    
    const result = await db.query(query, params);
    
    res.json({ pairs: result.rows });
    
  } catch (error) {
    logger.error('获取培育配对失败', { error, userId: req.user.id });
    res.status(500).json({ error: '获取失败' });
  }
});

/**
 * 收集精灵蛋
 */
router.post('/collect/:pairId', authMiddleware, async (req, res) => {
  try {
    const { pairId } = req.params;
    const userId = req.user.id;
    
    const result = await breedingService.collectEgg(userId, pairId);
    
    res.json({
      success: true,
      egg: result.egg,
      hatchSteps: result.hatchSteps
    });
    
  } catch (error) {
    logger.error('收集精灵蛋失败', { error, userId: req.user.id });
    res.status(400).json({ error: error.message });
  }
});

/**
 * 更新孵化进度
 */
router.post('/hatch/update', authMiddleware, async (req, res) => {
  try {
    const { steps } = req.body;
    const userId = req.user.id;
    
    const result = await breedingService.updateHatchingProgress(userId, steps);
    
    res.json({
      success: true,
      updated: result.updated,
      hatched: result.hatched,
      hatchedEggs: result.hatchedEggs
    });
    
  } catch (error) {
    logger.error('更新孵化进度失败', { error, userId: req.user.id });
    res.status(500).json({ error: '更新失败' });
  }
});

/**
 * 获取孵化中的蛋
 */
router.get('/hatching', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      `SELECT eh.*, up.species_id, up.shiny
       FROM egg_hatching eh
       JOIN user_pokemon up ON eh.pokemon_id = up.id
       WHERE eh.user_id = $1 AND eh.status = 'incubating'
       ORDER BY eh.created_at ASC`,
      [userId]
    );
    
    res.json({ eggs: result.rows });
    
  } catch (error) {
    logger.error('获取孵化蛋失败', { error, userId: req.user.id });
    res.status(500).json({ error: '获取失败' });
  }
});

/**
 * 获取精灵谱系
 */
router.get('/lineage/:pokemonId', authMiddleware, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.id;
    
    const result = await db.query(
      `SELECT pl.*, 
             ps1.name as parent1_species_name,
             ps2.name as parent2_species_name
       FROM pokemon_lineage pl
       LEFT JOIN pokemon_species ps1 ON pl.parent1_species_id = ps1.id
       LEFT JOIN pokemon_species ps2 ON pl.parent2_species_id = ps2.id
       WHERE pl.pokemon_id = $1`,
      [pokemonId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '谱系不存在' });
    }
    
    res.json({ lineage: result.rows[0] });
    
  } catch (error) {
    logger.error('获取谱系失败', { error, userId: req.user.id });
    res.status(500).json({ error: '获取失败' });
  }
});

/**
 * 获取培育历史
 */
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;
    
    const result = await db.query(
      `SELECT bh.*,
             ps1.name as parent1_name,
             ps2.name as parent2_name,
             ps3.name as offspring_name
       FROM breeding_history bh
       LEFT JOIN pokemon_species ps1 ON bh.parent1_species_id = ps1.id
       LEFT JOIN pokemon_species ps2 ON bh.parent2_species_id = ps2.id
       LEFT JOIN pokemon_species ps3 ON bh.offspring_species_id = ps3.id
       WHERE bh.user_id = $1
       ORDER BY bh.bred_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    
    res.json({ history: result.rows });
    
  } catch (error) {
    logger.error('获取培育历史失败', { error, userId: req.user.id });
    res.status(500).json({ error: '获取失败' });
  }
});

/**
 * 取消培育
 */
router.post('/cancel/:pairId', authMiddleware, async (req, res) => {
  try {
    const { pairId } = req.params;
    const userId = req.user.id;
    
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取培育配对
      const pairResult = await client.query(
        `SELECT bp.* FROM breeding_pairs bp
         JOIN breeding_centers bc ON bp.center_id = bc.id
         WHERE bp.id = $1 AND bc.user_id = $2 AND bp.status = 'breeding'`,
        [pairId, userId]
      );
      
      if (pairResult.rows.length === 0) {
        throw new Error('培育配对不存在或无法取消');
      }
      
      const pair = pairResult.rows[0];
      
      // 删除培育配对
      await client.query(`DELETE FROM breeding_pairs WHERE id = $1`, [pairId]);
      
      // 解锁精灵
      await client.query(
        `UPDATE user_pokemon SET is_breeding = false 
         WHERE id IN ($1, $2)`,
        [pair.parent1_pokemon_id, pair.parent2_pokemon_id]
      );
      
      await client.query('COMMIT');
      
      metrics.increment('breeding.cancelled');
      
      res.json({ success: true });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    logger.error('取消培育失败', { error, userId: req.user.id });
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
```

### 4. 前端集成

#### 文件：`frontend/game-client/src/breeding/BreedingCenter.js`

```javascript
/**
 * 精灵培育中心前端组件
 */

class BreedingCenter {
  constructor(apiClient) {
    this.api = apiClient;
    this.center = null;
    this.pairs = [];
    this.eggs = [];
  }

  /**
   * 初始化培育中心
   */
  async init() {
    try {
      // 获取培育中心信息
      const centerRes = await this.api.get('/pokemon/breeding/center');
      this.center = centerRes.center;
      
      // 获取培育配对
      const pairsRes = await this.api.get('/pokemon/breeding/pairs');
      this.pairs = pairsRes.pairs;
      
      // 获取孵化中的蛋
      const eggsRes = await this.api.get('/pokemon/breeding/hatching');
      this.eggs = eggsRes.eggs;
      
      this.render();
      this.startPolling();
      
    } catch (error) {
      console.error('初始化培育中心失败', error);
      this.showError('无法加载培育中心');
    }
  }

  /**
   * 检查培育兼容性
   */
  async checkCompatibility(parent1Id, parent2Id) {
    try {
      const result = await this.api.post('/pokemon/breeding/check-compatibility', {
        parent1Id,
        parent2Id
      });
      
      if (result.canBreed) {
        this.showCompatibilityResult(result, 'success');
      } else {
        this.showCompatibilityResult(result, 'error');
      }
      
      return result;
      
    } catch (error) {
      console.error('检查兼容性失败', error);
      return { canBreed: false, reason: '检查失败' };
    }
  }

  /**
   * 开始培育
   */
  async startBreeding(parent1Id, parent2Id, slotIndex) {
    try {
      const result = await this.api.post('/pokemon/breeding/start', {
        parent1Id,
        parent2Id,
        centerId: this.center.id,
        slotIndex
      });
      
      if (result.success) {
        this.showNotification('培育已开始！', 'success');
        this.pairs.push(result.pair);
        this.render();
        
        // 设置提醒
        this.scheduleNotification(result.readyAt, slotIndex);
      }
      
      return result;
      
    } catch (error) {
      console.error('开始培育失败', error);
      this.showNotification(error.message, 'error');
    }
  }

  /**
   * 收集精灵蛋
   */
  async collectEgg(pairId) {
    try {
      const result = await this.api.post(`/pokemon/breeding/collect/${pairId}`);
      
      if (result.success) {
        this.showNotification(`获得精灵蛋！需要行走 ${result.hatchSteps} 步孵化`, 'success');
        
        // 更新列表
        this.pairs = this.pairs.filter(p => p.id !== pairId);
        this.eggs.push(result.egg);
        this.render();
      }
      
      return result;
      
    } catch (error) {
      console.error('收集精灵蛋失败', error);
      this.showNotification(error.message, 'error');
    }
  }

  /**
   * 更新孵化进度（由位置服务调用）
   */
  async updateHatchingProgress(steps) {
    try {
      const result = await this.api.post('/pokemon/breeding/hatch/update', {
        steps
      });
      
      if (result.hatched > 0) {
        this.showNotification(`${result.hatched} 个精灵蛋孵化了！`, 'success');
        
        // 播放孵化动画
        for (const egg of result.hatchedEggs) {
          await this.playHatchAnimation(egg);
        }
        
        this.eggs = this.eggs.filter(e => 
          !result.hatchedEggs.find(h => h.pokemon_id === e.pokemon_id)
        );
        this.render();
      }
      
      return result;
      
    } catch (error) {
      console.error('更新孵化进度失败', error);
    }
  }

  /**
   * 轮询检查培育状态
   */
  startPolling() {
    this.pollInterval = setInterval(async () => {
      try {
        const pairsRes = await this.api.get('/pokemon/breeding/pairs?status=breeding');
        
        // 检查是否有完成的培育
        for (const pair of pairsRes.pairs) {
          if (pair.status === 'ready' && new Date(pair.ready_at) <= new Date()) {
            this.showNotification('培育完成！快去收集精灵蛋吧！', 'info');
            this.playReadySound();
          }
        }
        
        this.pairs = pairsRes.pairs;
        this.updateUI();
        
      } catch (error) {
        console.error('轮询培育状态失败', error);
      }
    }, 60000); // 每分钟检查一次
  }

  /**
   * 渲染 UI
   */
  render() {
    const container = document.getElementById('breeding-center');
    if (!container) return;
    
    container.innerHTML = `
      <div class="breeding-header">
        <h2>培育中心</h2>
        <span class="slots">可用槽位: ${this.center?.slots || 4}</span>
      </div>
      
      <div class="breeding-slots">
        ${this.renderSlots()}
      </div>
      
      <div class="hatching-section">
        <h3>孵化中的蛋 (${this.eggs.length})</h3>
        ${this.renderEggs()}
      </div>
      
      <div class="breeding-history">
        <button onclick="breedingCenter.showHistory()">查看培育历史</button>
      </div>
    `;
  }

  renderSlots() {
    const slots = [];
    const usedSlots = new Map(this.pairs.map(p => [p.slot_index, p]));
    
    for (let i = 0; i < (this.center?.slots || 4); i++) {
      const pair = usedSlots.get(i);
      
      if (pair) {
        slots.push(this.renderActiveSlot(pair));
      } else {
        slots.push(this.renderEmptySlot(i));
      }
    }
    
    return slots.join('');
  }

  renderActiveSlot(pair) {
    const progress = this.calculateProgress(pair);
    const statusClass = pair.status === 'ready' ? 'ready' : 'breeding';
    
    return `
      <div class="slot active ${statusClass}">
        <div class="parents">
          <div class="parent">
            <img src="/assets/pokemon/${pair.parent1_species}.png" />
            <span>${pair.parent1_nickname || '精灵'}</span>
          </div>
          <div class="heart">❤️</div>
          <div class="parent">
            <img src="/assets/pokemon/${pair.parent2_species}.png" />
            <span>${pair.parent2_nickname || '精灵'}</span>
          </div>
        </div>
        
        <div class="progress-bar">
          <div class="progress" style="width: ${progress}%"></div>
        </div>
        
        ${pair.status === 'ready' ? `
          <button class="collect-btn" onclick="breedingCenter.collectEgg('${pair.id}')">
            收集精灵蛋
          </button>
        ` : `
          <button class="cancel-btn" onclick="breedingCenter.cancelBreeding('${pair.id}')">
            取消培育
          </button>
        `}
      </div>
    `;
  }

  renderEmptySlot(index) {
    return `
      <div class="slot empty" onclick="breedingCenter.openPairSelector(${index})">
        <div class="add-icon">+</div>
        <span>添加培育配对</span>
      </div>
    `;
  }

  renderEggs() {
    if (this.eggs.length === 0) {
      return '<p class="no-eggs">暂无孵化中的蛋</p>';
    }
    
    return `
      <div class="eggs-grid">
        ${this.eggs.map(egg => `
          <div class="egg-card">
            <img src="/assets/egg.png" class="egg-image ${egg.shiny ? 'shiny' : ''}" />
            <div class="hatch-progress">
              <div class="progress-bar">
                <div class="progress" style="width: ${(egg.current_steps / egg.required_steps) * 100}%"></div>
              </div>
              <span>${egg.current_steps} / ${egg.required_steps} 步</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  calculateProgress(pair) {
    if (pair.status === 'ready') return 100;
    
    const start = new Date(pair.started_at).getTime();
    const end = new Date(pair.ready_at).getTime();
    const now = Date.now();
    
    return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  }

  /**
   * 辅助方法
   */
  showNotification(message, type = 'info') {
    // 实现通知显示
    console.log(`[${type}] ${message}`);
  }

  showError(message) {
    this.showNotification(message, 'error');
  }

  showCompatibilityResult(result, type) {
    if (type === 'success') {
      this.showNotification('这两只精灵可以培育！', 'success');
    } else {
      this.showNotification(result.reason || '无法培育', 'error');
    }
  }

  playReadySound() {
    // 播放培育完成音效
    const audio = new Audio('/assets/sounds/breeding-ready.mp3');
    audio.play();
  }

  async playHatchAnimation(egg) {
    // 播放孵化动画
    console.log('播放孵化动画', egg);
  }

  scheduleNotification(readyAt, slotIndex) {
    const delay = new Date(readyAt) - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        this.showNotification(`槽位 ${slotIndex + 1} 的培育完成了！`, 'info');
      }, delay);
    }
  }

  updateUI() {
    // 更新 UI 而不重新渲染整个组件
    this.render();
  }

  async showHistory() {
    try {
      const result = await this.api.get('/pokemon/breeding/history');
      // 显示历史记录模态框
      console.log('培育历史', result.history);
    } catch (error) {
      console.error('获取历史失败', error);
    }
  }

  async cancelBreeding(pairId) {
    if (!confirm('确定要取消培育吗？')) return;
    
    try {
      await this.api.post(`/pokemon/breeding/cancel/${pairId}`);
      this.showNotification('培育已取消', 'info');
      this.pairs = this.pairs.filter(p => p.id !== pairId);
      this.render();
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  openPairSelector(slotIndex) {
    // 打开精灵选择器
    console.log('打开配对选择器', slotIndex);
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BreedingCenter;
}
```

## 验收标准

- [ ] 数据库迁移成功执行，包含所有培育相关表
- [ ] 培育兼容性检查正确识别蛋组匹配
- [ ] 开始培育功能可用，精灵正确锁定
- [ ] 遗传机制正确实现（IV、技能、特性、性格、球）
- [ ] 精灵蛋生成逻辑正确，闪光几率符合预期
- [ ] 孵化进度更新功能可用，距离正确计算
- [ ] 精灵蛋孵化后正确转变为精灵
- [ ] 谱系记录完整，可追溯家族树
- [ ] 培育历史记录完整
- [ ] 前端 UI 正确显示培育状态和进度
- [ ] 单元测试覆盖率 > 80%
- [ ] Prometheus 指标正确记录（培育开始、完成、取消、孵化）
- [ ] API 文档完整更新

## 影响范围

### 数据库
- 新增 7 张表：breeding_centers, breeding_pairs, egg_groups, species_egg_groups, egg_hatching, pokemon_lineage, breeding_history
- 修改 user_pokemon 表：添加 is_breeding 字段

### 后端服务
- pokemon-service：新增培育核心逻辑和路由
- user-service：可能需要查询用户培育权限
- social-service：未来可能支持精灵蛋交易

### 前端
- game-client：新增培育中心 UI 组件
- 新增精灵选择器组件
- 新增孵化进度显示

### 配置文件
- 需要配置蛋组数据
- 需要配置孵化步数
- 需要配置遗传概率

## 参考

- [Pokémon Breeding Mechanics](https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9mon_breeding)
- [Egg Groups](https://bulbapedia.bulbagarden.net/wiki/Egg_Group)
- [Individual Values](https://bulbapedia.bulbagarden.net/wiki/Individual_values)
- [Pokémon Go Breeding System](https://pokemongohub.net/post/guide/pokemon-go-breeding-guide/)
