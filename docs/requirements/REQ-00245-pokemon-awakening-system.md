# REQ-00245: 精灵觉醒系统与潜能激活

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00245 |
| 标题 | 精灵觉醒系统与潜能激活 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-16 05:00 |

## 需求描述

精灵觉醒系统是一个深度的养成玩法，允许玩家通过特定的条件和材料激活精灵隐藏的潜能，获得额外的属性加成、专属技能或特殊外观。这个系统增加了游戏的策略深度和收集价值。

### 核心功能
1. **觉醒条件系统** - 不同精灵有不同的觉醒条件（等级、亲密度、特定道具、战斗次数等）
2. **潜能激活机制** - 觉醒后随机激活1-3个潜能属性
3. **觉醒材料收集** - 觉醒碎片、觉醒石、精华等道具获取途径
4. **觉醒阶段** - 多阶段觉醒，每个阶段解锁更强的潜能
5. **觉醒外观** - 觉醒后精灵获得特殊光效、粒子特效或形态变化
6. **觉醒技能** - 部分精灵觉醒后获得专属技能

## 技术方案

### 1. 数据库设计

```sql
-- 觉醒配置表
CREATE TABLE awakening_configs (
  id SERIAL PRIMARY KEY,
  pokemon_species_id INTEGER NOT NULL,
  awakening_stage INTEGER NOT NULL DEFAULT 1, -- 觉醒阶段 1-5
  required_level INTEGER NOT NULL DEFAULT 50,
  required_friendship INTEGER DEFAULT 200,
  required_battles INTEGER DEFAULT 100,
  required_materials JSONB NOT NULL, -- [{"item_id": 1, "count": 10}, ...]
  potential_pool JSONB NOT NULL, -- 可激活的潜能池
  guaranteed_potentials INTEGER DEFAULT 1, -- 保底潜能数量
  max_potentials INTEGER DEFAULT 3, -- 最大潜能数量
  skill_unlock_id INTEGER, -- 解锁的技能ID
  appearance_variant_id INTEGER, -- 外观变体ID
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 精灵觉醒记录表
CREATE TABLE pokemon_awakenings (
  id SERIAL PRIMARY KEY,
  pokemon_id INTEGER NOT NULL REFERENCES pokemons(id),
  awakening_stage INTEGER NOT NULL DEFAULT 1,
  activated_potentials JSONB NOT NULL DEFAULT '[]', -- 激活的潜能列表
  awakening_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  consumed_materials JSONB NOT NULL,
  rolled_attempts INTEGER DEFAULT 0, -- 重洗次数
  UNIQUE(pokemon_id, awakening_stage)
);

-- 潜能定义表
CREATE TABLE potentials (
  id SERIAL PRIMARY KEY,
  name_key VARCHAR(100) NOT NULL, -- 国际化key
  description_key VARCHAR(200) NOT NULL,
  potential_type VARCHAR(50) NOT NULL, -- stat_boost, skill_enhance, special_effect
  effect_config JSONB NOT NULL, -- 效果配置
  rarity VARCHAR(20) NOT NULL, -- common, rare, epic, legendary
  weight INTEGER NOT NULL DEFAULT 100, -- 抽取权重
  icon_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 觉醒材料表
CREATE TABLE awakening_materials (
  id SERIAL PRIMARY KEY,
  name_key VARCHAR(100) NOT NULL,
  description_key VARCHAR(200) NOT NULL,
  rarity VARCHAR(20) NOT NULL,
  source_type VARCHAR(50) NOT NULL, -- battle, quest, shop, event
  source_config JSONB,
  icon_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户觉醒材料库存
CREATE TABLE user_awakening_materials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  material_id INTEGER NOT NULL REFERENCES awakening_materials(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, material_id)
);

-- 索引
CREATE INDEX idx_awakening_configs_species ON awakening_configs(pokemon_species_id);
CREATE INDEX idx_pokemon_awakenings_pokemon ON pokemon_awakenings(pokemon_id);
CREATE INDEX idx_potentials_type ON potentials(potential_type);
CREATE INDEX idx_user_materials_user ON user_awakening_materials(user_id);
```

### 2. 觉醒服务核心逻辑

```javascript
// backend/services/pokemon-service/src/awakening/AwakeningService.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { publishEvent } = require('../../../shared/eventBus');

class AwakeningService {
  /**
   * 检查精灵觉醒条件
   */
  async checkAwakeningEligibility(userId, pokemonId, targetStage = null) {
    const pokemon = await prisma.pokemons.findUnique({
      where: { id: pokemonId },
      include: { species: true }
    });

    if (!pokemon || pokemon.user_id !== userId) {
      throw new Error('POKEMON_NOT_FOUND');
    }

    // 获取当前觉醒阶段
    const currentAwakening = await prisma.pokemon_awakenings.findFirst({
      where: { pokemon_id: pokemonId },
      orderBy: { awakening_stage: 'desc' }
    });

    const nextStage = targetStage || (currentAwakening?.awakening_stage || 0) + 1;

    // 获取觉醒配置
    const config = await prisma.awakening_configs.findFirst({
      where: {
        pokemon_species_id: pokemon.species_id,
        awakening_stage: nextStage
      }
    });

    if (!config) {
      return { eligible: false, reason: 'NO_AWAKENING_CONFIG' };
    }

    // 检查各项条件
    const checks = {
      level: pokemon.level >= config.required_level,
      friendship: (pokemon.friendship || 0) >= (config.required_friendship || 0),
      battles: await this.getBattleCount(pokemonId) >= (config.required_battles || 0),
      materials: await this.checkMaterials(userId, config.required_materials)
    };

    const allPassed = Object.values(checks).every(v => v === true);

    return {
      eligible: allPassed,
      currentStage: currentAwakening?.awakening_stage || 0,
      nextStage,
      checks,
      requiredMaterials: config.required_materials
    };
  }

  /**
   * 执行觉醒
   */
  async performAwakening(userId, pokemonId) {
    const eligibility = await this.checkAwakeningEligibility(userId, pokemonId);
    
    if (!eligibility.eligible) {
      throw new Error('AWAKENING_CONDITIONS_NOT_MET');
    }

    const config = await prisma.awakening_configs.findFirst({
      where: {
        pokemon_species_id: (await prisma.pokemons.findUnique({ where: { id: pokemonId } })).species_id,
        awakening_stage: eligibility.nextStage
      }
    });

    // 扣除材料
    await this.consumeMaterials(userId, config.required_materials);

    // 随机激活潜能
    const activatedPotentials = await this.rollPotentials(
      config.potential_pool,
      config.guaranteed_potentials,
      config.max_potentials
    );

    // 记录觉醒
    const awakening = await prisma.pokemon_awakenings.create({
      data: {
        pokemon_id: pokemonId,
        awakening_stage: eligibility.nextStage,
        activated_potentials: activatedPotentials,
        consumed_materials: config.required_materials
      }
    });

    // 更新精灵属性
    await this.applyAwakeningBonuses(pokemonId, activatedPotentials);

    // 解锁技能（如果有）
    if (config.skill_unlock_id) {
      await this.unlockAwakeningSkill(pokemonId, config.skill_unlock_id);
    }

    // 发布觉醒事件
    await publishEvent('pokemon.awakened', {
      userId,
      pokemonId,
      awakeningStage: eligibility.nextStage,
      potentials: activatedPotentials,
      timestamp: new Date()
    });

    return {
      success: true,
      awakening,
      unlockedSkill: config.skill_unlock_id,
      appearanceVariant: config.appearance_variant_id
    };
  }

  /**
   * 随机抽取潜能
   */
  async rollPotentials(potentialPool, guaranteed, maxPotentials) {
    // 按稀有度分层抽取
    const potentials = [];
    const pool = [...potentialPool];
    
    // 保底机制：至少获得 guaranteed 个潜能
    for (let i = 0; i < guaranteed && pool.length > 0; i++) {
      const roll = this.weightedRandom(pool);
      potentials.push(roll);
      // 移除已抽取的潜能
      const idx = pool.findIndex(p => p.id === roll.id);
      if (idx > -1) pool.splice(idx, 1);
    }

    // 额外抽取机会（概率递减）
    let extraChance = 0.3;
    while (potentials.length < maxPotentials && pool.length > 0 && Math.random() < extraChance) {
      const roll = this.weightedRandom(pool);
      potentials.push(roll);
      const idx = pool.findIndex(p => p.id === roll.id);
      if (idx > -1) pool.splice(idx, 1);
      extraChance *= 0.5; // 每次额外机会减半
    }

    return potentials;
  }

  /**
   * 加权随机抽取
   */
  weightedRandom(items) {
    const totalWeight = items.reduce((sum, item) => sum + (item.weight || 100), 0);
    let random = Math.random() * totalWeight;
    
    for (const item of items) {
      random -= (item.weight || 100);
      if (random <= 0) return item;
    }
    
    return items[items.length - 1];
  }

  /**
   * 应用觉醒属性加成
   */
  async applyAwakeningBonuses(pokemonId, potentials) {
    const pokemon = await prisma.pokemons.findUnique({ where: { id: pokemonId } });
    
    let bonusStats = {
      hp: 0, attack: 0, defense: 0,
      sp_attack: 0, sp_defense: 0, speed: 0
    };

    for (const potential of potentials) {
      if (potential.type === 'stat_boost') {
        const stat = potential.effect_config.stat;
        const boost = potential.effect_config.value;
        if (bonusStats[stat] !== undefined) {
          bonusStats[stat] += boost;
        }
      }
    }

    // 更新精灵属性
    await prisma.pokemons.update({
      where: { id: pokemonId },
      data: {
        awakening_bonuses: bonusStats,
        total_hp: pokemon.base_hp + bonusStats.hp,
        total_attack: pokemon.base_attack + bonusStats.attack,
        total_defense: pokemon.base_defense + bonusStats.defense,
        total_sp_attack: pokemon.base_sp_attack + bonusStats.sp_attack,
        total_sp_defense: pokemon.base_sp_defense + bonusStats.sp_defense,
        total_speed: pokemon.base_speed + bonusStats.speed
      }
    });
  }

  /**
   * 重洗潜能
   */
  async rerollPotentials(userId, pokemonId, stage) {
    const awakening = await prisma.pokemon_awakenings.findFirst({
      where: { pokemon_id: pokemonId, awakening_stage: stage }
    });

    if (!awakening) {
      throw new Error('AWAKENING_NOT_FOUND');
    }

    const config = await prisma.awakening_configs.findFirst({
      where: {
        pokemon_species_id: (await prisma.pokemons.findUnique({ where: { id: pokemonId } })).species_id,
        awakening_stage: stage
      }
    });

    // 消耗重洗材料
    const rerollCost = [{ item_id: 'reroll_stone', count: 1 + awakening.rolled_attempts }];
    await this.consumeMaterials(userId, rerollCost);

    // 重新抽取潜能
    const newPotentials = await this.rollPotentials(
      config.potential_pool,
      config.guaranteed_potentials,
      config.max_potentials
    );

    // 更新觉醒记录
    await prisma.pokemon_awakenings.update({
      where: { id: awakening.id },
      data: {
        activated_potentials: newPotentials,
        rolled_attempts: { increment: 1 }
      }
    });

    // 重新应用属性加成
    await this.applyAwakeningBonuses(pokemonId, newPotentials);

    return { success: true, potentials: newPotentials };
  }
}

module.exports = new AwakeningService();
```

### 3. API 路由设计

```javascript
// backend/services/pokemon-service/src/routes/awakening.js

const express = require('express');
const router = express.Router();
const awakeningService = require('../awakening/AwakeningService');
const { authenticate, authorize } = require('../../../shared/middleware/auth');

/**
 * GET /api/pokemon/:pokemonId/awakening/eligibility
 * 检查精灵觉醒条件
 */
router.get('/:pokemonId/awakening/eligibility', authenticate, async (req, res) => {
  try {
    const result = await awakeningService.checkAwakeningEligibility(
      req.user.id,
      parseInt(req.params.pokemonId)
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/pokemon/:pokemonId/awakening
 * 执行觉醒
 */
router.post('/:pokemonId/awakening', authenticate, async (req, res) => {
  try {
    const result = await awakeningService.performAwakening(
      req.user.id,
      parseInt(req.params.pokemonId)
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/pokemon/:pokemonId/awakening/reroll
 * 重洗潜能
 */
router.post('/:pokemonId/awakening/reroll', authenticate, async (req, res) => {
  try {
    const { stage } = req.body;
    const result = await awakeningService.rerollPotentials(
      req.user.id,
      parseInt(req.params.pokemonId),
      stage
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/pokemon/:pokemonId/awakening/history
 * 获取觉醒历史
 */
router.get('/:pokemonId/awakening/history', authenticate, async (req, res) => {
  try {
    const history = await awakeningService.getAwakeningHistory(
      req.user.id,
      parseInt(req.params.pokemonId)
    );
    res.json(history);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/awakening/materials
 * 获取觉醒材料列表
 */
router.get('/awakening/materials', authenticate, async (req, res) => {
  try {
    const materials = await awakeningService.getUserMaterials(req.user.id);
    res.json(materials);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
```

### 4. 前端组件设计

```javascript
// frontend/game-client/src/components/AwakeningPanel.js

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { awakeningApi } from '../api/awakening';
import { ParticleEffect } from '../effects/ParticleEffect';
import './AwakeningPanel.css';

const AwakeningPanel = ({ pokemon, onClose }) => {
  const [eligibility, setEligibility] = useState(null);
  const [awakening, setAwakening] = useState(null);
  const [isAwakening, setIsAwakening] = useState(false);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    loadEligibility();
  }, [pokemon.id]);

  const loadEligibility = async () => {
    try {
      const result = await awakeningApi.checkEligibility(pokemon.id);
      setEligibility(result);
    } catch (error) {
      console.error('Failed to load eligibility:', error);
    }
  };

  const handleAwaken = async () => {
    if (!eligibility?.eligible) return;
    
    setIsAwakening(true);
    try {
      const result = await awakeningApi.performAwakening(pokemon.id);
      setAwakening(result);
      setShowResult(true);
      
      // 播放觉醒动画
      await playAwakeningAnimation();
      
      // 触发庆祝效果
      if (result.potentials.some(p => p.rarity === 'legendary')) {
        ParticleEffect.burst('legendary');
      }
    } catch (error) {
      console.error('Awakening failed:', error);
    } finally {
      setIsAwakening(false);
    }
  };

  const playAwakeningAnimation = () => {
    return new Promise(resolve => {
      setTimeout(resolve, 3000);
    });
  };

  return (
    <div className="awakening-panel">
      <div className="awakening-header">
        <h2>精灵觉醒</h2>
        <span className="current-stage">
          当前阶段: {eligibility?.currentStage || 0}
        </span>
      </div>

      {/* 觉醒条件显示 */}
      <div className="awakening-conditions">
        <h3>觉醒条件</h3>
        <ConditionItem 
          label="等级" 
          current={pokemon.level}
          required={eligibility?.checks?.level ? '✓' : eligibility?.requiredLevel}
          passed={eligibility?.checks?.level}
        />
        <ConditionItem 
          label="亲密度" 
          current={pokemon.friendship}
          required={eligibility?.checks?.friendship ? '✓' : eligibility?.requiredFriendship}
          passed={eligibility?.checks?.friendship}
        />
        <ConditionItem 
          label="战斗次数" 
          current={pokemon.battleCount}
          required={eligibility?.checks?.battles ? '✓' : eligibility?.requiredBattles}
          passed={eligibility?.checks?.battles}
        />
      </div>

      {/* 材料需求 */}
      <div className="awakening-materials">
        <h3>觉醒材料</h3>
        {eligibility?.requiredMaterials?.map((material, idx) => (
          <MaterialItem 
            key={idx}
            material={material}
            hasEnough={eligibility?.checks?.materials}
          />
        ))}
      </div>

      {/* 觉醒按钮 */}
      <button 
        className={`awaken-button ${eligibility?.eligible ? 'active' : 'disabled'}`}
        onClick={handleAwaken}
        disabled={!eligibility?.eligible || isAwakening}
      >
        {isAwakening ? '觉醒中...' : '开始觉醒'}
      </button>

      {/* 觉醒结果 */}
      <AnimatePresence>
        {showResult && awakening && (
          <motion.div 
            className="awakening-result"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
          >
            <h3>觉醒成功!</h3>
            <div className="potentials-gained">
              {awakening.activated_potentials.map((potential, idx) => (
                <PotentialCard 
                  key={idx}
                  potential={potential}
                  isNew
                />
              ))}
            </div>
            {awakening.unlockedSkill && (
              <div className="skill-unlocked">
                解锁专属技能!
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ConditionItem = ({ label, current, required, passed }) => (
  <div className={`condition-item ${passed ? 'passed' : 'failed'}`}>
    <span className="condition-label">{label}</span>
    <span className="condition-value">
      {current} / {required}
    </span>
    <span className="condition-status">
      {passed ? '✓' : '✗'}
    </span>
  </div>
);

const MaterialItem = ({ material, hasEnough }) => (
  <div className={`material-item ${hasEnough ? 'enough' : 'insufficient'}`}>
    <img src={material.icon} alt={material.name} />
    <span>{material.name}</span>
    <span>{material.owned} / {material.required}</span>
  </div>
);

const PotentialCard = ({ potential, isNew }) => (
  <motion.div 
    className={`potential-card ${potential.rarity}`}
    initial={isNew ? { scale: 0, rotate: -180 } : {}}
    animate={{ scale: 1, rotate: 0 }}
  >
    <img src={potential.icon} alt={potential.name} />
    <h4>{potential.name}</h4>
    <p>{potential.description}</p>
    <div className="potential-stats">
      {potential.type === 'stat_boost' && (
        <span>+{potential.effect_config.value} {potential.effect_config.stat}</span>
      )}
    </div>
  </motion.div>
);

export default AwakeningPanel;
```

### 5. 觉醒特效系统

```javascript
// frontend/game-client/src/effects/AwakeningEffect.js

import * as THREE from 'three';

export class AwakeningEffect {
  constructor(scene, pokemonMesh) {
    this.scene = scene;
    this.pokemonMesh = pokemonMesh;
    this.particles = [];
    this.isActive = false;
  }

  async playAwakening(stage) {
    this.isActive = true;
    
    // 阶段1: 聚能
    await this.gatherEnergy();
    
    // 阶段2: 爆发
    await this.burstEffect(stage);
    
    // 阶段3: 光环
    this.applyAwakenedAura(stage);
    
    this.isActive = false;
  }

  async gatherEnergy() {
    const particleCount = 200;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    
    // 从四周向精灵聚集的粒子
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 5 + Math.random() * 3;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.random() * 3;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    const material = new THREE.PointsMaterial({
      color: 0xffd700,
      size: 0.1,
      transparent: true,
      opacity: 0.8
    });
    
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    
    // 聚能动画
    await this.animateGathering(points, 2000);
    
    this.scene.remove(points);
  }

  async burstEffect(stage) {
    const colors = ['#ffd700', '#ff6b6b', '#4ecdc4', '#a855f7'];
    const color = colors[Math.min(stage - 1, colors.length - 1)];
    
    // 环形爆发
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.5, 32),
      new THREE.MeshBasicMaterial({ 
        color: new THREE.Color(color),
        transparent: true,
        side: THREE.DoubleSide
      })
    );
    
    ring.position.copy(this.pokemonMesh.position);
    ring.rotation.x = Math.PI / 2;
    this.scene.add(ring);
    
    // 扩散动画
    await this.animateBurst(ring, 1000);
    
    this.scene.remove(ring);
  }

  applyAwakenedAura(stage) {
    // 持久光环效果
    const auraGeometry = new THREE.SphereGeometry(1.5, 32, 32);
    const auraMaterial = new THREE.MeshBasicMaterial({
      color: this.getAuraColor(stage),
      transparent: true,
      opacity: 0.3,
      side: THREE.BackSide
    });
    
    const aura = new THREE.Mesh(auraGeometry, auraMaterial);
    this.pokemonMesh.add(aura);
    
    // 持续动画
    this.animateAura(aura);
  }

  getAuraColor(stage) {
    const colors = [0xffd700, 0xff6b6b, 0x4ecdc4, 0xa855f7, 0xff1493];
    return colors[Math.min(stage - 1, colors.length - 1)];
  }

  animateGathering(points, duration) {
    return new Promise(resolve => {
      const startTime = Date.now();
      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        const positions = points.geometry.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
          positions[i] *= (1 - progress * 0.05);
          positions[i + 1] *= (1 - progress * 0.05);
          positions[i + 2] *= (1 - progress * 0.05);
        }
        points.geometry.attributes.position.needsUpdate = true;
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };
      animate();
    });
  }

  animateBurst(ring, duration) {
    return new Promise(resolve => {
      const startTime = Date.now();
      const initialScale = 0.1;
      const targetScale = 10;
      
      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeOut = 1 - Math.pow(1 - progress, 3);
        
        const scale = initialScale + (targetScale - initialScale) * easeOut;
        ring.scale.set(scale, scale, scale);
        ring.material.opacity = 1 - progress;
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };
      animate();
    });
  }

  animateAura(aura) {
    const animate = () => {
      if (!this.isActive) return;
      
      aura.scale.setScalar(1 + Math.sin(Date.now() * 0.003) * 0.1);
      aura.material.opacity = 0.2 + Math.sin(Date.now() * 0.002) * 0.1;
      
      requestAnimationFrame(animate);
    };
    animate();
  }
}
```

## 验收标准

- [ ] 数据库迁移脚本成功执行，所有表创建完成
- [ ] 觉醒条件检查 API 正确返回各项条件的满足状态
- [ ] 觉醒执行 API 正确扣除材料并记录觉醒结果
- [ ] 潜能随机抽取系统按权重正确工作
- [ ] 保底机制确保最低潜能数量
- [ ] 属性加成正确应用到精灵战斗属性
- [ ] 觉醒技能解锁功能正常工作
- [ ] 重洗潜能功能正常，消耗递增
- [ ] 前端觉醒面板正确显示所有条件和材料
- [ ] 觉醒动画效果流畅，无卡顿
- [ ] 觉醒后光环特效持续显示
- [ ] 国际化支持所有觉醒相关文本
- [ ] 单元测试覆盖核心逻辑，覆盖率 ≥ 80%

## 影响范围

### 数据库
- 新增表: awakening_configs, pokemon_awakenings, potentials, awakening_materials, user_awakening_materials
- 修改表: pokemons (新增 awakening_bonuses 字段)

### 服务
- pokemon-service: 新增 awakening 路由和 AwakeningService
- reward-service: 新增觉醒材料获取途径
- user-service: 用户觉醒材料库存管理

### 前端
- game-client: 新增 AwakeningPanel、PotentialCard 组件
- 新增觉醒特效系统
- 新增觉醒材料展示界面

### 基础设施
- 新增 Redis 缓存觉醒配置和潜能池
- 新增 Kafka 事件: pokemon.awakened

## 参考

- Pokemon GO: Mega Evolution 机制
- Fate/Grand Order: 灵基再临系统
- 原神: 角色突破机制
- ICU MessageFormat: https://unicode-org.github.io/icu/userguide/format_parse/messages/
