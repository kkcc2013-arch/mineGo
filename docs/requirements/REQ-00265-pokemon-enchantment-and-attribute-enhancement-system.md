# REQ-00265: 精灵附魔系统与属性强化

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00265 |
| 标题 | 精灵附魔系统与属性强化 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-18 20:00 |

## 需求描述

为精灵引入附魔系统，允许玩家使用特殊道具对精灵进行属性强化和附加效果增益。附魔系统是精灵培养深度的重要扩展，为玩家提供更多养成策略和个性化定制空间。

### 核心功能
1. **附魔类型体系**
   - 元素附魔：火/水/草/电/冰/岩石/飞行等属性攻击强化
   - 防御附魔：物理防御/特殊防御/HP加成
   - 速度附魔：移动速度/攻击速度/闪避率
   - 特效附魔：暴击率/暴击伤害/命中/回复效果
   - 套装附魔：同一类型附魔达到指定数量触发套装效果

2. **附魔材料与道具**
   - 附魔石（初级/中级/高级/稀有/传说）
   - 属性精华（从放生精灵或分解道具获取）
   - 附魔保护符（防止附魔失败掉级）
   - 附魔转移符（将附魔转移到另一个精灵）
   - 套装核心（激活套装效果必需品）

3. **附魔成功率与风险**
   - 不同等级附魔石对应不同成功率
   - 附魔失败可能：无效果/掉级/属性重置（根据保护道具）
   - 幸运值系统：连续失败增加下次成功率
   - VIP/活动期间成功率加成

4. **套装效果系统**
   - 2件套效果：基础属性加成
   - 4件套效果：特殊被动技能/技能强化
   - 6件套效果：稀有主动技能/专属特效
   - 套装组合奖励：不同套装混搭触发额外效果

## 技术方案

### 1. 数据库设计

```sql
-- 精灵附魔表
CREATE TABLE pokemon_enchantments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    enchantment_slot INTEGER NOT NULL CHECK (enchantment_slot BETWEEN 1 AND 6),
    enchantment_type VARCHAR(50) NOT NULL, -- 'fire_attack', 'water_defense', 'speed', etc.
    enchantment_level INTEGER NOT NULL DEFAULT 1 CHECK (enchantment_level BETWEEN 1 AND 10),
    enchantment_quality VARCHAR(20) NOT NULL, -- 'normal', 'rare', 'epic', 'legendary'
    attribute_bonus JSONB NOT NULL, -- {"attack": 15, "fire_damage_percent": 5}
    set_id VARCHAR(50), -- 套装ID
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(pokemon_id, enchantment_slot)
);

CREATE INDEX idx_pokemon_enchantments_pokemon ON pokemon_enchantments(pokemon_id);
CREATE INDEX idx_pokemon_enchantments_set ON pokemon_enchantments(set_id);

-- 附魔模板表
CREATE TABLE enchantment_templates (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    max_level INTEGER NOT NULL DEFAULT 10,
    level_bonuses JSONB NOT NULL, -- {"1": {"attack": 5}, "2": {"attack": 8}, ...}
    set_bonus JSONB, -- 套装效果配置
    icon_url VARCHAR(500),
    rarity VARCHAR(20) NOT NULL
);

-- 附魔历史记录
CREATE TABLE enchantment_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id),
    enchantment_type VARCHAR(50) NOT NULL,
    before_level INTEGER,
    after_level INTEGER,
    success BOOLEAN NOT NULL,
    materials_used JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_enchantment_history_user ON enchantment_history(user_id);
CREATE INDEX idx_enchantment_history_pokemon ON enchantment_history(pokemon_id);

-- 用户附魔材料库存
CREATE TABLE user_enchantment_materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    material_type VARCHAR(50) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, material_type)
);

CREATE INDEX idx_user_enchantment_materials_user ON user_enchantment_materials(user_id);
```

### 2. 附魔服务核心模块

```javascript
// backend/services/pokemon-service/src/enchantment/EnchantmentService.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

class EnchantmentService {
  constructor() {
    this.successRates = {
      normal: { 1: 1.0, 2: 0.9, 3: 0.8, 4: 0.7, 5: 0.6, 6: 0.5, 7: 0.4, 8: 0.3, 9: 0.2, 10: 0.1 },
      rare: { 1: 1.0, 2: 0.95, 3: 0.85, 4: 0.75, 5: 0.65, 6: 0.55, 7: 0.45, 8: 0.35, 9: 0.25, 10: 0.15 },
      epic: { 1: 1.0, 2: 0.97, 3: 0.9, 4: 0.82, 5: 0.72, 6: 0.62, 7: 0.52, 8: 0.42, 9: 0.32, 10: 0.2 },
      legendary: { 1: 1.0, 2: 0.98, 3: 0.95, 4: 0.88, 5: 0.78, 6: 0.68, 7: 0.58, 8: 0.48, 9: 0.38, 10: 0.25 }
    };
    
    this.luckyBonusCap = 0.3; // 幸运值最多增加30%成功率
  }

  /**
   * 执行附魔操作
   */
  async enchantPokemon(userId, pokemonId, slot, enchantmentType, materials, options = {}) {
    const pokemon = await this.validatePokemonOwnership(userId, pokemonId);
    const template = await this.getEnchantmentTemplate(enchantmentType);
    
    // 检查材料是否足够
    await this.validateMaterials(userId, materials);
    
    // 获取当前附魔状态
    const currentEnchant = await prisma.pokemonEnchantments.findUnique({
      where: { pokemon_id_slot: { pokemon_id: pokemonId, enchantment_slot: slot } }
    });
    
    const targetLevel = currentEnchant ? currentEnchant.enchantment_level + 1 : 1;
    
    if (targetLevel > template.max_level) {
      throw new Error('已达到该附魔最高等级');
    }
    
    // 计算成功率
    const baseRate = this.successRates[materials.stoneQuality][targetLevel];
    const luckyBonus = await this.getLuckyBonus(userId, enchantmentType);
    const eventBonus = this.getEventBonus();
    const finalRate = Math.min(baseRate + luckyBonus + eventBonus, 0.99);
    
    // 执行附魔判定
    const success = Math.random() < finalRate;
    
    // 扣除材料
    await this.consumeMaterials(userId, materials);
    
    if (success) {
      // 附魔成功
      const bonus = template.level_bonuses[targetLevel.toString()];
      
      const enchantment = await prisma.pokemonEnchantments.upsert({
        where: { pokemon_id_slot: { pokemon_id: pokemonId, enchantment_slot: slot } },
        update: {
          enchantment_level: targetLevel,
          enchantment_quality: materials.stoneQuality,
          attribute_bonus: bonus,
          updated_at: new Date()
        },
        create: {
          pokemon_id: pokemonId,
          enchantment_slot: slot,
          enchantment_type: enchantmentType,
          enchantment_level: targetLevel,
          enchantment_quality: materials.stoneQuality,
          attribute_bonus: bonus,
          set_id: template.set_bonus?.set_id
        }
      });
      
      // 清空幸运值
      await this.resetLuckyValue(userId, enchantmentType);
      
      // 记录历史
      await this.recordHistory(userId, pokemonId, enchantmentType, 
        currentEnchant?.enchantment_level || 0, targetLevel, true, materials);
      
      // 检查并应用套装效果
      const setEffects = await this.checkAndApplySetEffects(pokemonId);
      
      return {
        success: true,
        enchantment,
        setEffects,
        message: `附魔成功！${enchantmentType} 等级提升至 ${targetLevel}`
      };
    } else {
      // 附魔失败
      let newLevel = currentEnchant?.enchantment_level || 0;
      
      if (!materials.useProtection) {
        // 无保护符，可能掉级
        newLevel = Math.max(0, newLevel - 1);
        
        if (newLevel === 0 && currentEnchant) {
          await prisma.pokemonEnchantments.delete({
            where: { id: currentEnchant.id }
          });
        } else if (currentEnchant) {
          await prisma.pokemonEnchantments.update({
            where: { id: currentEnchant.id },
            data: { enchantment_level: newLevel }
          });
        }
      }
      
      // 增加幸运值
      await this.increaseLuckyValue(userId, enchantmentType);
      
      // 记录历史
      await this.recordHistory(userId, pokemonId, enchantmentType,
        currentEnchant?.enchantment_level || 0, newLevel, false, materials);
      
      return {
        success: false,
        newLevel,
        luckyValue: await this.getLuckyValue(userId, enchantmentType),
        message: `附魔失败${materials.useProtection ? '，等级保护生效' : `，等级降至 ${newLevel}`}`
      };
    }
  }

  /**
   * 检查并应用套装效果
   */
  async checkAndApplySetEffects(pokemonId) {
    const enchantments = await prisma.pokemonEnchantments.findMany({
      where: { pokemon_id: pokemonId }
    });
    
    const setCounts = {};
    for (const e of enchantments) {
      if (e.set_id) {
        setCounts[e.set_id] = (setCounts[e.set_id] || 0) + 1;
      }
    }
    
    const activeSetEffects = [];
    
    for (const [setId, count] of Object.entries(setCounts)) {
      const template = await this.getSetTemplate(setId);
      
      // 检查各档位套装效果
      if (count >= 2 && template.set_bonus['2']) {
        activeSetEffects.push({
          setId,
          tier: 2,
          effect: template.set_bonus['2'],
          active: true
        });
      }
      if (count >= 4 && template.set_bonus['4']) {
        activeSetEffects.push({
          setId,
          tier: 4,
          effect: template.set_bonus['4'],
          active: true
        });
      }
      if (count >= 6 && template.set_bonus['6']) {
        activeSetEffects.push({
          setId,
          tier: 6,
          effect: template.set_bonus['6'],
          active: true
        });
      }
    }
    
    return activeSetEffects;
  }

  /**
   * 转移附魔
   */
  async transferEnchantment(userId, fromPokemonId, toPokemonId, slot, transferToken) {
    // 验证所有权
    await this.validatePokemonOwnership(userId, fromPokemonId);
    await this.validatePokemonOwnership(userId, toPokemonId);
    
    // 验证转移符
    await this.consumeTransferToken(userId, transferToken);
    
    const enchantment = await prisma.pokemonEnchantments.findUnique({
      where: { pokemon_id_slot: { pokemon_id: fromPokemonId, enchantment_slot: slot } }
    });
    
    if (!enchantment) {
      throw new Error('该槽位没有附魔');
    }
    
    // 检查目标槽位
    const targetSlot = await prisma.pokemonEnchantments.findUnique({
      where: { pokemon_id_slot: { pokemon_id: toPokemonId, enchantment_slot: slot } }
    });
    
    if (targetSlot) {
      throw new Error('目标槽位已有附魔，请先移除');
    }
    
    // 执行转移
    await prisma.$transaction([
      prisma.pokemonEnchantments.delete({ where: { id: enchantment.id } }),
      prisma.pokemonEnchantments.create({
        data: {
          pokemon_id: toPokemonId,
          enchantment_slot: slot,
          enchantment_type: enchantment.enchantment_type,
          enchantment_level: enchantment.enchantment_level,
          enchantment_quality: enchantment.enchantment_quality,
          attribute_bonus: enchantment.attribute_bonus,
          set_id: enchantment.set_id
        }
      })
    ]);
    
    return {
      success: true,
      message: `附魔已成功转移至新精灵`
    };
  }

  /**
   * 移除附魔
   */
  async removeEnchantment(userId, pokemonId, slot, returnMaterial = false) {
    await this.validatePokemonOwnership(userId, pokemonId);
    
    const enchantment = await prisma.pokemonEnchantments.findUnique({
      where: { pokemon_id_slot: { pokemon_id: pokemonId, enchantment_slot: slot } }
    });
    
    if (!enchantment) {
      throw new Error('该槽位没有附魔');
    }
    
    await prisma.pokemonEnchantments.delete({
      where: { id: enchantment.id }
    });
    
    // 根据等级返还部分材料
    if (returnMaterial && enchantment.enchantment_level >= 5) {
      const returnAmount = Math.floor(enchantment.enchantment_level * 0.5);
      await this.addMaterial(userId, 'enchantment_essence', returnAmount);
      
      return {
        success: true,
        returnedMaterials: { enchantment_essence: returnAmount }
      };
    }
    
    return { success: true };
  }

  /**
   * 获取精灵完整属性（含附魔加成）
   */
  async getPokemonWithEnchantments(pokemonId) {
    const [pokemon, enchantments] = await Promise.all([
      prisma.pokemons.findUnique({ where: { id: pokemonId } }),
      prisma.pokemonEnchantments.findMany({ where: { pokemon_id: pokemonId } })
    ]);
    
    // 计算附魔加成
    const bonusStats = {
      attack: 0,
      defense: 0,
      special_attack: 0,
      special_defense: 0,
      speed: 0,
      hp: 0,
      crit_rate: 0,
      crit_damage: 0
    };
    
    for (const e of enchantments) {
      const bonus = e.attribute_bonus;
      for (const [key, value] of Object.entries(bonus)) {
        if (bonusStats.hasOwnProperty(key)) {
          bonusStats[key] += value;
        }
      }
    }
    
    const setEffects = await this.checkAndApplySetEffects(pokemonId);
    
    return {
      ...pokemon,
      enchantments,
      bonusStats,
      finalStats: {
        attack: pokemon.attack + bonusStats.attack,
        defense: pokemon.defense + bonusStats.defense,
        special_attack: pokemon.special_attack + bonusStats.special_attack,
        special_defense: pokemon.special_defense + bonusStats.special_defense,
        speed: pokemon.speed + bonusStats.speed,
        hp: pokemon.hp + bonusStats.hp,
        crit_rate: pokemon.crit_rate + bonusStats.crit_rate,
        crit_damage: pokemon.crit_damage + bonusStats.crit_damage
      },
      activeSetEffects: setEffects
    };
  }

  // 私有辅助方法
  async validatePokemonOwnership(userId, pokemonId) {
    const pokemon = await prisma.pokemons.findFirst({
      where: { id: pokemonId, user_id: userId }
    });
    if (!pokemon) throw new Error('精灵不存在或无权操作');
    return pokemon;
  }

  async validateMaterials(userId, materials) {
    for (const [type, amount] of Object.entries(materials)) {
      const inventory = await prisma.userEnchantmentMaterials.findUnique({
        where: { user_id_material_type: { user_id: userId, material_type: type } }
      });
      if (!inventory || inventory.quantity < amount) {
        throw new Error(`材料 ${type} 不足`);
      }
    }
  }

  async consumeMaterials(userId, materials) {
    const updates = [];
    for (const [type, amount] of Object.entries(materials)) {
      if (typeof amount === 'number' && amount > 0) {
        updates.push(
          prisma.userEnchantmentMaterials.update({
            where: { user_id_material_type: { user_id: userId, material_type: type } },
            data: { quantity: { decrement: amount } }
          })
        );
      }
    }
    await Promise.all(updates);
  }

  async getLuckyValue(userId, enchantmentType) {
    const key = `lucky:${userId}:${enchantmentType}`;
    const value = await redis.get(key);
    return parseInt(value || '0');
  }

  async getLuckyBonus(userId, enchantmentType) {
    const luckyValue = await this.getLuckyValue(userId, enchantmentType);
    return Math.min(luckyValue * 0.03, this.luckyBonusCap);
  }

  async increaseLuckyValue(userId, enchantmentType) {
    const key = `lucky:${userId}:${enchantmentType}`;
    await redis.incr(key);
    await redis.expire(key, 86400 * 7); // 7天过期
  }

  async resetLuckyValue(userId, enchantmentType) {
    const key = `lucky:${userId}:${enchantmentType}`;
    await redis.del(key);
  }

  getEventBonus() {
    // 检查当前是否有活动加成
    return 0; // TODO: 从活动系统获取
  }

  async getEnchantmentTemplate(type) {
    return prisma.enchantmentTemplates.findUnique({ where: { id: type } });
  }

  async getSetTemplate(setId) {
    return prisma.enchantmentTemplates.findFirst({ where: { set_id: setId } });
  }

  async recordHistory(userId, pokemonId, type, beforeLevel, afterLevel, success, materials) {
    return prisma.enchantmentHistory.create({
      data: {
        user_id: userId,
        pokemon_id: pokemonId,
        enchantment_type: type,
        before_level: beforeLevel,
        after_level: afterLevel,
        success,
        materials_used: materials
      }
    });
  }
}

module.exports = EnchantmentService;
```

### 3. API 路由

```javascript
// backend/services/pokemon-service/src/routes/enchantment.js

const express = require('express');
const router = express.Router();
const EnchantmentService = require('../enchantment/EnchantmentService');
const { authenticate, validateRequest } = require('../../../shared/middleware');

const enchantmentService = new EnchantmentService();

/**
 * @swagger
 * /pokemon/{pokemonId}/enchant:
 *   post:
 *     summary: 对精灵进行附魔
 *     tags: [Enchantment]
 */
router.post('/:pokemonId/enchant', authenticate, validateRequest({
  params: { pokemonId: 'uuid' },
  body: {
    slot: { type: 'integer', min: 1, max: 6 },
    enchantmentType: 'string',
    materials: {
      stoneType: 'string',
      stoneQuality: 'string',
      stoneCount: { type: 'integer', min: 1 },
      essenceCount: { type: 'integer', min: 0 },
      useProtection: 'boolean'
    }
  }
}), async (req, res) => {
  try {
    const result = await enchantmentService.enchantPokemon(
      req.user.id,
      req.params.pokemonId,
      req.body.slot,
      req.body.enchantmentType,
      req.body.materials
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pokemon/{pokemonId}/enchantments:
 *   get:
 *     summary: 获取精灵附魔信息
 *     tags: [Enchantment]
 */
router.get('/:pokemonId/enchantments', authenticate, async (req, res) => {
  try {
    const result = await enchantmentService.getPokemonWithEnchantments(req.params.pokemonId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pokemon/enchant/transfer:
 *   post:
 *     summary: 转移附魔
 *     tags: [Enchantment]
 */
router.post('/enchant/transfer', authenticate, validateRequest({
  body: {
    fromPokemonId: 'uuid',
    toPokemonId: 'uuid',
    slot: { type: 'integer', min: 1, max: 6 },
    transferTokenId: 'string'
  }
}), async (req, res) => {
  try {
    const result = await enchantmentService.transferEnchantment(
      req.user.id,
      req.body.fromPokemonId,
      req.body.toPokemonId,
      req.body.slot,
      req.body.transferTokenId
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pokemon/{pokemonId}/enchant/{slot}:
 *   delete:
 *     summary: 移除附魔
 *     tags: [Enchantment]
 */
router.delete('/:pokemonId/enchant/:slot', authenticate, async (req, res) => {
  try {
    const result = await enchantmentService.removeEnchantment(
      req.user.id,
      req.params.pokemonId,
      parseInt(req.params.slot),
      req.query.returnMaterial === 'true'
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /enchantment/templates:
 *   get:
 *     summary: 获取所有附魔模板
 *     tags: [Enchantment]
 */
router.get('/enchantment/templates', async (req, res) => {
  const templates = await prisma.enchantmentTemplates.findMany();
  res.json(templates);
});

/**
 * @swagger
 * /user/enchantment-materials:
 *   get:
 *     summary: 获取用户附魔材料库存
 *     tags: [Enchantment]
 */
router.get('/user/enchantment-materials', authenticate, async (req, res) => {
  const materials = await prisma.userEnchantmentMaterials.findMany({
    where: { user_id: req.user.id }
  });
  res.json(materials);
});

/**
 * @swagger
 * /enchantment/history:
 *   get:
 *     summary: 获取附魔历史记录
 *     tags: [Enchantment]
 */
router.get('/enchantment/history', authenticate, async (req, res) => {
  const history = await prisma.enchantmentHistory.findMany({
    where: { user_id: req.user.id },
    orderBy: { created_at: 'desc' },
    take: 50
  });
  res.json(history);
});

module.exports = router;
```

### 4. 前端组件

```javascript
// frontend/game-client/src/components/EnchantmentPanel.js

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './EnchantmentPanel.css';

const EnchantmentPanel = ({ pokemon, onClose }) => {
  const { t } = useTranslation();
  const [selectedSlot, setSelectedSlot] = useState(1);
  const [selectedType, setSelectedType] = useState(null);
  const [materials, setMaterials] = useState({});
  const [enchanting, setEnchanting] = useState(false);
  const [result, setResult] = useState(null);
  
  const enchantmentTypes = [
    { id: 'fire_attack', name: t('enchant.fire'), icon: '🔥' },
    { id: 'water_attack', name: t('enchant.water'), icon: '💧' },
    { id: 'grass_attack', name: t('enchant.grass'), icon: '🌿' },
    { id: 'electric_attack', name: t('enchant.electric'), icon: '⚡' },
    { id: 'physical_defense', name: t('enchant.physicalDef'), icon: '🛡️' },
    { id: 'special_defense', name: t('enchant.specialDef'), icon: '✨' },
    { id: 'speed_boost', name: t('enchant.speed'), icon: '💨' },
    { id: 'crit_enhance', name: t('enchant.crit'), icon: '🎯' }
  ];

  useEffect(() => {
    fetchMaterials();
  }, []);

  const fetchMaterials = async () => {
    const res = await fetch('/api/user/enchantment-materials', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
    });
    const data = await res.json();
    const matMap = {};
    data.forEach(m => matMap[m.material_type] = m.quantity);
    setMaterials(matMap);
  };

  const handleEnchant = async () => {
    setEnchanting(true);
    setResult(null);
    
    try {
      const res = await fetch(`/api/pokemon/${pokemon.id}/enchant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          slot: selectedSlot,
          enchantmentType: selectedType,
          materials: {
            stoneType: `${selectedType}_stone`,
            stoneQuality: 'rare',
            stoneCount: 1,
            essenceCount: 5,
            useProtection: materials.protection_charm > 0
          }
        })
      });
      
      const data = await res.json();
      setResult(data);
      fetchMaterials();
    } catch (error) {
      setResult({ success: false, message: error.message });
    } finally {
      setEnchanting(false);
    }
  };

  const getCurrentEnchant = (slot) => {
    return pokemon.enchantments?.find(e => e.enchantment_slot === slot);
  };

  return (
    <div className="enchantment-panel">
      <div className="enchantment-header">
        <h2>{t('enchant.title')}</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      
      <div className="enchantment-body">
        {/* 附魔槽位 */}
        <div className="slots-container">
          <h3>{t('enchant.slots')}</h3>
          <div className="slots-grid">
            {[1, 2, 3, 4, 5, 6].map(slot => {
              const enchant = getCurrentEnchant(slot);
              return (
                <div
                  key={slot}
                  className={`slot ${selectedSlot === slot ? 'selected' : ''} ${enchant ? 'enchanted' : ''}`}
                  onClick={() => setSelectedSlot(slot)}
                >
                  {enchant ? (
                    <div className="enchant-info">
                      <span className="enchant-icon">
                        {enchantmentTypes.find(t => t.id === enchant.enchantment_type)?.icon}
                      </span>
                      <span className="enchant-level">+{enchant.enchantment_level}</span>
                    </div>
                  ) : (
                    <span className="slot-empty">{slot}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        
        {/* 附魔类型选择 */}
        <div className="types-container">
          <h3>{t('enchant.selectType')}</h3>
          <div className="types-grid">
            {enchantmentTypes.map(type => (
              <div
                key={type.id}
                className={`type-card ${selectedType === type.id ? 'selected' : ''}`}
                onClick={() => setSelectedType(type.id)}
              >
                <span className="type-icon">{type.icon}</span>
                <span className="type-name">{type.name}</span>
              </div>
            ))}
          </div>
        </div>
        
        {/* 材料显示 */}
        <div className="materials-container">
          <h3>{t('enchant.materials')}</h3>
          <div className="materials-list">
            <div className="material-item">
              <span>附魔石</span>
              <span className={materials.enchantment_stone > 0 ? '' : 'insufficient'}>
                {materials.enchantment_stone || 0}
              </span>
            </div>
            <div className="material-item">
              <span>属性精华</span>
              <span className={materials.enchantment_essence >= 5 ? '' : 'insufficient'}>
                {materials.enchantment_essence || 0}
              </span>
            </div>
            <div className="material-item">
              <span>保护符</span>
              <span>{materials.protection_charm || 0}</span>
            </div>
          </div>
        </div>
        
        {/* 操作按钮 */}
        <div className="actions">
          <button
            className="enchant-btn"
            onClick={handleEnchant}
            disabled={!selectedType || enchanting}
          >
            {enchanting ? t('enchant.enchanting') : t('enchant.doEnchant')}
          </button>
        </div>
        
        {/* 结果显示 */}
        {result && (
          <div className={`result ${result.success ? 'success' : 'fail'}`}>
            <p>{result.message}</p>
            {result.setEffects && result.setEffects.length > 0 && (
              <div className="set-effects">
                <h4>{t('enchant.setEffectsActivated')}</h4>
                {result.setEffects.map((effect, idx) => (
                  <div key={idx} className="set-effect">
                    {effect.setId} ({effect.tier}件套)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        
        {/* 当前属性加成 */}
        <div className="bonus-stats">
          <h3>{t('enchant.currentBonus')}</h3>
          <div className="stats-grid">
            {pokemon.bonusStats && Object.entries(pokemon.bonusStats).map(([stat, value]) => (
              value > 0 && (
                <div key={stat} className="stat-item">
                  <span>{t(`stats.${stat}`)}</span>
                  <span className="bonus">+{value}</span>
                </div>
              )
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EnchantmentPanel;
```

### 5. 套装效果配置

```javascript
// backend/services/pokemon-service/src/enchantment/setEffects.js

const SET_EFFECTS = {
  // 火焰套装
  'fire_set': {
    name: '火焰之力',
    icon: '🔥',
    set_bonus: {
      2: {
        fire_damage_percent: 5,
        description: '火属性伤害+5%'
      },
      4: {
        fire_damage_percent: 12,
        burn_chance: 10,
        description: '火属性伤害+12%，攻击有10%几率造成灼烧'
      },
      6: {
        fire_damage_percent: 20,
        burn_chance: 20,
        fire_resistance: 15,
        description: '火属性伤害+20%，灼烧几率+20%，火抗+15%'
      }
    }
  },
  
  // 水流套装
  'water_set': {
    name: '水流守护',
    icon: '💧',
    set_bonus: {
      2: {
        special_defense: 10,
        description: '特防+10'
      },
      4: {
        special_defense: 25,
        heal_on_water_attack: 3,
        description: '特防+25，水属性攻击回复3%HP'
      },
      6: {
        special_defense: 45,
        heal_on_water_attack: 5,
        water_immunity: true,
        description: '特防+45，水属性攻击回复5%HP，免疫水属性伤害'
      }
    }
  },
  
  // 迅捷套装
  'speed_set': {
    name: '迅捷之风',
    icon: '💨',
    set_bonus: {
      2: {
        speed: 15,
        description: '速度+15'
      },
      4: {
        speed: 35,
        dodge_chance: 8,
        description: '速度+35，闪避率+8%'
      },
      6: {
        speed: 60,
        dodge_chance: 15,
        first_strike_guaranteed: true,
        description: '速度+60，闪避率+15%，必定先手'
      }
    }
  },
  
  // 暴击套装
  'crit_set': {
    name: '致命一击',
    icon: '🎯',
    set_bonus: {
      2: {
        crit_rate: 5,
        description: '暴击率+5%'
      },
      4: {
        crit_rate: 12,
        crit_damage: 25,
        description: '暴击率+12%，暴击伤害+25%'
      },
      6: {
        crit_rate: 20,
        crit_damage: 50,
        crit_heal: 10,
        description: '暴击率+20%，暴击伤害+50%，暴击回复10%HP'
      }
    }
  },
  
  // 防御套装
  'defense_set': {
    name: '钢铁壁垒',
    icon: '🛡️',
    set_bonus: {
      2: {
        defense: 15,
        description: '物防+15'
      },
      4: {
        defense: 35,
        damage_reduction: 5,
        description: '物防+35，受到伤害减少5%'
      },
      6: {
        defense: 60,
        damage_reduction: 10,
        shield_on_low_hp: 20,
        description: '物防+60，伤害减少10%，低血量时获得20%护盾'
      }
    }
  }
};

module.exports = SET_EFFECTS;
```

## 验收标准

- [ ] 玩家可对精灵进行附魔操作，成功提升属性
- [ ] 附魔成功率按等级递减，失败有掉级风险
- [ ] 幸运值系统正确工作，连续失败增加成功率
- [ ] 保护符道具正确防止附魔失败掉级
- [ ] 附魔转移功能正常工作，可将附魔转移到另一精灵
- [ ] 套装效果正确激活（2/4/6件套）
- [ ] 套装效果加成正确计算到精灵最终属性
- [ ] 附魔历史记录完整保存
- [ ] 材料库存正确扣除和更新
- [ ] 前端附魔界面完整展示所有信息
- [ ] 附魔材料可通过放生精灵、分解道具获得
- [ ] VIP/活动期间成功率加成正确生效

## 影响范围

- 新增数据库表：pokemon_enchantments、enchantment_templates、enchantment_history、user_enchantment_materials
- 新增服务模块：pokemon-service/src/enchantment/
- 新增API路由：/api/pokemon/:id/enchant、/api/pokemon/:id/enchantments、/api/enchantment/*
- 新增前端组件：EnchantmentPanel.js
- 更新精灵详情页，展示附魔信息
- 更新战斗系统，计算附魔加成属性
- 更新奖励系统，添加附魔材料获取途径

## 参考

- 类似游戏附魔系统设计
- Pokemon GO CP计算与强化机制
- 韩系MMO强化系统成功率和保护机制
