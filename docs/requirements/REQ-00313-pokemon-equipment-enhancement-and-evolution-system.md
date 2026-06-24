# REQ-00313: 精灵装备强化与进化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00313 |
| 标题 | 精灵装备强化与进化系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-24 07:00 UTC |

## 需求描述

实现精灵装备强化与进化系统，允许玩家通过消耗特定资源来强化精灵装备，提升装备属性和等级。当装备达到特定等级和条件时，可触发装备进化，获得全新外观和更强的属性加成。

### 核心功能

1. **装备强化机制**
   - 装备等级系统（1-20级）
   - 强化消耗资源计算（金币+强化石）
   - 强化成功率系统（带保底机制）
   - 强化失败保护机制（不掉级）

2. **装备进化机制**
   - 进化条件检测（等级、材料、特定精灵）
   - 进化后属性提升计算
   - 进化外观变化与特效展示
   - 进化材料消耗系统

3. **资源管理**
   - 强化石类型系统（普通/高级/稀有/传说）
   - 进化材料获取途径
   - 资源消耗记录与追踪

4. **UI/UX 设计**
   - 强化界面动画与音效
   - 进化仪式特效
   - 成功/失败反馈系统

## 技术方案

### 1. 数据库设计

```sql
-- 装备强化配置表
CREATE TABLE equipment_enhancement_config (
    id SERIAL PRIMARY KEY,
    equipment_type VARCHAR(50) NOT NULL,
    current_level INT NOT NULL,
    target_level INT NOT NULL,
    gold_cost INT NOT NULL,
    stone_type VARCHAR(20) NOT NULL,
    stone_count INT NOT NULL,
    base_success_rate DECIMAL(5,4) NOT NULL,
    guarantee_threshold INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(equipment_type, current_level)
);

-- 装备进化配置表
CREATE TABLE equipment_evolution_config (
    id SERIAL PRIMARY KEY,
    equipment_type VARCHAR(50) NOT NULL,
    evolution_stage INT NOT NULL,
    required_level INT NOT NULL,
    required_materials JSONB NOT NULL,
    stat_boost JSONB NOT NULL,
    new_appearance_id VARCHAR(100),
    special_effect_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(equipment_type, evolution_stage)
);

-- 精灵装备实例表扩展
ALTER TABLE pokemon_equipment ADD COLUMN IF NOT EXISTS 
    enhancement_level INT DEFAULT 1,
    evolution_stage INT DEFAULT 1,
    enhancement_attempts INT DEFAULT 0,
    last_enhancement_at TIMESTAMP;

-- 强化记录表
CREATE TABLE equipment_enhancement_log (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    equipment_id UUID NOT NULL,
    from_level INT NOT NULL,
    to_level INT NOT NULL,
    success BOOLEAN NOT NULL,
    gold_consumed INT NOT NULL,
    stones_consumed JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 进化记录表
CREATE TABLE equipment_evolution_log (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    equipment_id UUID NOT NULL,
    from_stage INT NOT NULL,
    to_stage INT NOT NULL,
    materials_consumed JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引优化
CREATE INDEX idx_enhancement_config_lookup 
    ON equipment_enhancement_config(equipment_type, current_level);
CREATE INDEX idx_evolution_config_lookup 
    ON equipment_evolution_config(equipment_type, evolution_stage);
CREATE INDEX idx_enhancement_log_user 
    ON equipment_enhancement_log(user_id, created_at DESC);
CREATE INDEX idx_equipment_enhancement_level 
    ON pokemon_equipment(enhancement_level, evolution_stage);
```

### 2. 后端服务实现

#### pokemon-service/routes/equipmentEnhancement.js

```javascript
const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const knex = require('../db/knex');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

// 强化装备
router.post('/:equipmentId/enhance', 
    [
        param('equipmentId').isUUID(),
        body('stoneType').isIn(['common', 'advanced', 'rare', 'legendary'])
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { equipmentId } = req.params;
        const { stoneType } = req.body;
        const userId = req.user.id;

        try {
            // 获取装备信息
            const equipment = await knex('pokemon_equipment')
                .where({ id: equipmentId, user_id: userId })
                .first();

            if (!equipment) {
                return res.status(404).json({ error: 'Equipment not found' });
            }

            // 检查最大等级
            if (equipment.enhancement_level >= 20) {
                return res.status(400).json({ error: 'Equipment at max level' });
            }

            // 获取强化配置
            const config = await knex('equipment_enhancement_config')
                .where({
                    equipment_type: equipment.type,
                    current_level: equipment.enhancement_level
                })
                .first();

            if (!config) {
                return res.status(400).json({ error: 'Invalid enhancement config' });
            }

            // 检查资源
            const userResources = await knex('user_resources')
                .where({ user_id: userId })
                .first();

            if (userResources.gold < config.gold_cost) {
                return res.status(400).json({ error: 'Insufficient gold' });
            }

            // 检查强化石数量
            const stoneKey = `${stoneType}_stones`;
            if (userResources[stoneKey] < config.stone_count) {
                return res.status(400).json({ error: 'Insufficient enhancement stones' });
            }

            // 计算成功率
            const attempts = equipment.enhancement_attempts;
            const guaranteedSuccess = attempts >= config.guarantee_threshold;
            const successRate = guaranteedSuccess ? 1 : 
                Math.min(0.95, config.base_success_rate + (attempts * 0.05));

            // 执行强化判定
            const roll = Math.random();
            const success = roll < successRate;

            // 开启事务
            const result = await knex.transaction(async (trx) => {
                // 扣除资源
                await trx('user_resources')
                    .where({ user_id: userId })
                    .update({
                        gold: knex.raw('gold - ?', [config.gold_cost]),
                        [stoneKey]: knex.raw('?? - ?', [stoneKey, config.stone_count])
                    });

                // 更新装备
                const newLevel = success ? 
                    equipment.enhancement_level + 1 : 
                    equipment.enhancement_level;

                await trx('pokemon_equipment')
                    .where({ id: equipmentId })
                    .update({
                        enhancement_level: newLevel,
                        enhancement_attempts: success ? 0 : attempts + 1,
                        last_enhancement_at: knex.fn.now()
                    });

                // 记录日志
                await trx('equipment_enhancement_log').insert({
                    user_id: userId,
                    pokemon_id: equipment.pokemon_id,
                    equipment_id: equipmentId,
                    from_level: equipment.enhancement_level,
                    to_level: newLevel,
                    success,
                    gold_consumed: config.gold_cost,
                    stones_consumed: JSON.stringify({
                        type: stoneType,
                        count: config.stone_count
                    })
                });

                return { success, newLevel };
            });

            // 发布事件
            await redis.publish('equipment:enhanced', JSON.stringify({
                userId,
                equipmentId,
                success: result.success,
                newLevel: result.newLevel,
                timestamp: Date.now()
            }));

            res.json({
                success: result.success,
                newLevel: result.newLevel,
                resourcesConsumed: {
                    gold: config.gold_cost,
                    stones: { type: stoneType, count: config.stone_count }
                },
                nextAttemptBonus: result.success ? 0 : 0.05
            });

        } catch (error) {
            console.error('Enhancement error:', error);
            res.status(500).json({ error: 'Enhancement failed' });
        }
    }
);

// 进化装备
router.post('/:equipmentId/evolve',
    [param('equipmentId').isUUID()],
    async (req, res) => {
        const { equipmentId } = req.params;
        const userId = req.user.id;

        try {
            const equipment = await knex('pokemon_equipment')
                .where({ id: equipmentId, user_id: userId })
                .first();

            if (!equipment) {
                return res.status(404).json({ error: 'Equipment not found' });
            }

            // 获取进化配置
            const nextStage = equipment.evolution_stage + 1;
            const evolutionConfig = await knex('equipment_evolution_config')
                .where({
                    equipment_type: equipment.type,
                    evolution_stage: nextStage
                })
                .first();

            if (!evolutionConfig) {
                return res.status(400).json({ error: 'No evolution available' });
            }

            // 检查等级要求
            if (equipment.enhancement_level < evolutionConfig.required_level) {
                return res.status(400).json({ 
                    error: 'Equipment level insufficient',
                    required: evolutionConfig.required_level,
                    current: equipment.enhancement_level
                });
            }

            // 检查材料
            const userMaterials = await knex('user_materials')
                .where({ user_id: userId })
                .first();

            const requiredMaterials = evolutionConfig.required_materials;
            for (const [material, count] of Object.entries(requiredMaterials)) {
                if (!userMaterials[material] || userMaterials[material] < count) {
                    return res.status(400).json({ 
                        error: 'Insufficient materials',
                        material,
                        required: count,
                        current: userMaterials[material] || 0
                    });
                }
            }

            // 执行进化
            const result = await knex.transaction(async (trx) => {
                // 扣除材料
                const updateData = {};
                for (const [material, count] of Object.entries(requiredMaterials)) {
                    updateData[material] = knex.raw('?? - ?', [material, count]);
                }
                await trx('user_materials')
                    .where({ user_id: userId })
                    .update(updateData);

                // 计算新属性
                const newStats = {};
                for (const [stat, boost] of Object.entries(evolutionConfig.stat_boost)) {
                    newStats[stat] = equipment.stats[stat] + boost;
                }

                // 更新装备
                await trx('pokemon_equipment')
                    .where({ id: equipmentId })
                    .update({
                        evolution_stage: nextStage,
                        stats: JSON.stringify(newStats),
                        appearance_id: evolutionConfig.new_appearance_id,
                        special_effect: evolutionConfig.special_effect_id
                    });

                // 记录日志
                await trx('equipment_evolution_log').insert({
                    user_id: userId,
                    pokemon_id: equipment.pokemon_id,
                    equipment_id: equipmentId,
                    from_stage: equipment.evolution_stage,
                    to_stage: nextStage,
                    materials_consumed: JSON.stringify(requiredMaterials)
                });

                return {
                    evolutionStage: nextStage,
                    newStats,
                    newAppearance: evolutionConfig.new_appearance_id,
                    specialEffect: evolutionConfig.special_effect_id
                };
            });

            // 发布进化事件
            await redis.publish('equipment:evolved', JSON.stringify({
                userId,
                equipmentId,
                evolutionStage: result.evolutionStage,
                timestamp: Date.now()
            }));

            res.json({
                success: true,
                equipment: result
            });

        } catch (error) {
            console.error('Evolution error:', error);
            res.status(500).json({ error: 'Evolution failed' });
        }
    }
);

// 获取装备强化信息
router.get('/:equipmentId/info', async (req, res) => {
    const { equipmentId } = req.params;
    const userId = req.user.id;

    try {
        const equipment = await knex('pokemon_equipment')
            .where({ id: equipmentId, user_id: userId })
            .first();

        if (!equipment) {
            return res.status(404).json({ error: 'Equipment not found' });
        }

        // 获取下一级强化配置
        const nextEnhancement = await knex('equipment_enhancement_config')
            .where({
                equipment_type: equipment.type,
                current_level: equipment.enhancement_level
            })
            .first();

        // 获取进化配置
        const nextEvolution = await knex('equipment_evolution_config')
            .where({
                equipment_type: equipment.type,
                evolution_stage: equipment.evolution_stage + 1
            })
            .first();

        res.json({
            equipment: {
                id: equipment.id,
                type: equipment.type,
                enhancementLevel: equipment.enhancement_level,
                evolutionStage: equipment.evolution_stage,
                stats: equipment.stats,
                enhancementAttempts: equipment.enhancement_attempts
            },
            nextEnhancement: nextEnhancement || null,
            nextEvolution: nextEvolution || null,
            canEnhance: equipment.enhancement_level < 20,
            canEvolve: nextEvolution && 
                equipment.enhancement_level >= nextEvolution.required_level
        });

    } catch (error) {
        console.error('Get equipment info error:', error);
        res.status(500).json({ error: 'Failed to get equipment info' });
    }
});

module.exports = router;
```

### 3. 前端组件实现

#### game-client/src/components/EquipmentEnhancement.jsx

```jsx
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import './EquipmentEnhancement.css';

const EquipmentEnhancement = ({ equipmentId, onClose }) => {
    const { t } = useTranslation();
    const [equipment, setEquipment] = useState(null);
    const [isEnhancing, setIsEnhancing] = useState(false);
    const [result, setResult] = useState(null);
    const [selectedStone, setSelectedStone] = useState('common');

    useEffect(() => {
        fetchEquipmentInfo();
    }, [equipmentId]);

    const fetchEquipmentInfo = async () => {
        const response = await fetch(
            `/api/pokemon/equipment/${equipmentId}/info`,
            { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
        );
        const data = await response.json();
        setEquipment(data);
    };

    const handleEnhance = async () => {
        if (!equipment?.canEnhance || isEnhancing) return;

        setIsEnhancing(true);
        setResult(null);

        try {
            const response = await fetch(
                `/api/pokemon/equipment/${equipmentId}/enhance`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({ stoneType: selectedStone })
                }
            );

            const data = await response.json();
            
            // 播放动画
            setResult(data);
            
            // 延迟刷新数据
            setTimeout(() => {
                fetchEquipmentInfo();
            }, 2000);

        } catch (error) {
            console.error('Enhancement failed:', error);
        } finally {
            setIsEnhancing(false);
        }
    };

    const handleEvolve = async () => {
        if (!equipment?.canEvolve) return;

        setIsEnhancing(true);
        try {
            const response = await fetch(
                `/api/pokemon/equipment/${equipmentId}/evolve`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${localStorage.getItem('token')}`
                    }
                }
            );

            const data = await response.json();
            if (data.success) {
                // 播放进化动画
                setResult({ type: 'evolution', ...data.equipment });
                setTimeout(() => {
                    fetchEquipmentInfo();
                }, 3000);
            }
        } catch (error) {
            console.error('Evolution failed:', error);
        } finally {
            setIsEnhancing(false);
        }
    };

    if (!equipment) return <div className="loading">{t('loading')}</div>;

    return (
        <div className="equipment-enhancement-modal">
            <div className="modal-header">
                <h2>{t('equipment.enhancement.title')}</h2>
                <button className="close-btn" onClick={onClose}>×</button>
            </div>

            <div className="equipment-display">
                <div className="equipment-icon">
                    <img src={equipment.equipment.appearance_id} alt="Equipment" />
                    <div className="level-badge">
                        +{equipment.equipment.enhancementLevel}
                    </div>
                    <div className="evolution-stars">
                        {'★'.repeat(equipment.equipment.evolutionStage)}
                    </div>
                </div>

                <div className="equipment-stats">
                    {Object.entries(equipment.equipment.stats).map(([stat, value]) => (
                        <div key={stat} className="stat-row">
                            <span>{t(`stats.${stat}`)}</span>
                            <span className="stat-value">{value}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* 强化区域 */}
            <div className="enhancement-section">
                <h3>{t('equipment.enhancement.enhance')}</h3>
                
                {equipment.nextEnhancement && (
                    <>
                        <div className="resource-cost">
                            <div className="cost-item">
                                <span>💰</span>
                                <span>{equipment.nextEnhancement.gold_cost}</span>
                            </div>
                            <div className="cost-item">
                                <span>💎</span>
                                <span>{equipment.nextEnhancement.stone_count}x</span>
                            </div>
                        </div>

                        <div className="stone-selector">
                            {['common', 'advanced', 'rare', 'legendary'].map(type => (
                                <button
                                    key={type}
                                    className={`stone-btn ${selectedStone === type ? 'selected' : ''}`}
                                    onClick={() => setSelectedStone(type)}
                                >
                                    {t(`stones.${type}`)}
                                </button>
                            ))}
                        </div>

                        <div className="success-rate">
                            {t('equipment.enhancement.successRate')}: 
                            {Math.round((equipment.nextEnhancement.base_success_rate + 
                                equipment.equipment.enhancementAttempts * 0.05) * 100)}%
                        </div>

                        <button
                            className="enhance-btn"
                            onClick={handleEnhance}
                            disabled={!equipment.canEnhance || isEnhancing}
                        >
                            {isEnhancing ? t('enhancing') : t('equipment.enhancement.enhance')}
                        </button>
                    </>
                )}
            </div>

            {/* 进化区域 */}
            {equipment.nextEvolution && (
                <div className="evolution-section">
                    <h3>{t('equipment.evolution.title')}</h3>
                    
                    <div className="evolution-requirements">
                        <div className={`requirement ${equipment.equipment.enhancementLevel >= equipment.nextEvolution.required_level ? 'met' : ''}`}>
                            {t('equipment.evolution.requiredLevel')}: {equipment.nextEvolution.required_level}
                        </div>
                        
                        {Object.entries(equipment.nextEvolution.required_materials).map(([material, count]) => (
                            <div key={material} className="requirement">
                                {t(`materials.${material}`)}: {count}
                            </div>
                        ))}
                    </div>

                    <div className="evolution-preview">
                        <h4>{t('equipment.evolution.statBoost')}</h4>
                        {Object.entries(equipment.nextEvolution.stat_boost).map(([stat, boost]) => (
                            <div key={stat} className="boost-item">
                                <span>{t(`stats.${stat}`)}</span>
                                <span className="boost-value">+{boost}</span>
                            </div>
                        ))}
                    </div>

                    <button
                        className="evolve-btn"
                        onClick={handleEvolve}
                        disabled={!equipment.canEvolve || isEnhancing}
                    >
                        {t('equipment.evolution.evolve')}
                    </button>
                </div>
            )}

            {/* 结果动画 */}
            <AnimatePresence>
                {result && (
                    <motion.div
                        className={`result-overlay ${result.success || result.type === 'evolution' ? 'success' : 'fail'}`}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 0.5 }}
                    >
                        {result.type === 'evolution' ? (
                            <div className="evolution-animation">
                                <div className="evolution-glow" />
                                <h2>{t('equipment.evolution.success')}</h2>
                                <div className="new-stage">
                                    {'★'.repeat(result.evolutionStage)}
                                </div>
                            </div>
                        ) : (
                            <div className="enhancement-result">
                                <h2>{result.success ? 
                                    t('equipment.enhancement.success') : 
                                    t('equipment.enhancement.failed')}
                                </h2>
                                <div className="level-change">
                                    +{result.newLevel}
                                </div>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default EquipmentEnhancement;
```

### 4. 缓存策略

```javascript
// backend/shared/cache/equipmentCache.js
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

const CACHE_TTL = {
    ENHANCEMENT_CONFIG: 3600, // 1 hour
    EVOLUTION_CONFIG: 3600,
    EQUIPMENT_STATS: 300, // 5 minutes
    USER_EQUIPMENT: 60
};

class EquipmentCache {
    static async getEnhancementConfig(equipmentType, currentLevel) {
        const key = `enhancement:config:${equipmentType}:${currentLevel}`;
        const cached = await redis.get(key);
        
        if (cached) {
            return JSON.parse(cached);
        }
        
        return null;
    }

    static async setEnhancementConfig(equipmentType, currentLevel, config) {
        const key = `enhancement:config:${equipmentType}:${currentLevel}`;
        await redis.setex(key, CACHE_TTL.ENHANCEMENT_CONFIG, JSON.stringify(config));
    }

    static async invalidateUserEquipment(userId, equipmentId) {
        const pattern = `equipment:user:${userId}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
            await redis.del(...keys);
        }
        
        // Also invalidate specific equipment
        await redis.del(`equipment:stats:${equipmentId}`);
    }

    static async getEquipmentStats(equipmentId) {
        const key = `equipment:stats:${equipmentId}`;
        const cached = await redis.get(key);
        
        if (cached) {
            return JSON.parse(cached);
        }
        
        return null;
    }

    static async setEquipmentStats(equipmentId, stats) {
        const key = `equipment:stats:${equipmentId}`;
        await redis.setex(key, CACHE_TTL.EQUIPMENT_STATS, JSON.stringify(stats));
    }
}

module.exports = EquipmentCache;
```

### 5. 事件系统集成

```javascript
// backend/shared/events/equipmentEvents.js
const Kafka = require('kafkajs').Kafka;
const kafka = new Kafka({
    clientId: 'mineGo-equipment-service',
    brokers: process.env.KAFKA_BROKERS.split(',')
});

const producer = kafka.producer();

class EquipmentEvents {
    static async init() {
        await producer.connect();
    }

    static async emitEnhancementEvent(event) {
        await producer.send({
            topic: 'equipment-events',
            messages: [{
                key: event.userId,
                value: JSON.stringify({
                    type: 'EQUIPMENT_ENHANCED',
                    timestamp: Date.now(),
                    payload: {
                        userId: event.userId,
                        equipmentId: event.equipmentId,
                        success: event.success,
                        fromLevel: event.fromLevel,
                        toLevel: event.toLevel,
                        resourcesConsumed: event.resourcesConsumed
                    }
                })
            }]
        });
    }

    static async emitEvolutionEvent(event) {
        await producer.send({
            topic: 'equipment-events',
            messages: [{
                key: event.userId,
                value: JSON.stringify({
                    type: 'EQUIPMENT_EVOLVED',
                    timestamp: Date.now(),
                    payload: {
                        userId: event.userId,
                        equipmentId: event.equipmentId,
                        fromStage: event.fromStage,
                        toStage: event.toStage,
                        newStats: event.newStats,
                        materialsConsumed: event.materialsConsumed
                    }
                })
            }]
        });

        // 发送成就事件
        await producer.send({
            topic: 'achievement-events',
            messages: [{
                key: event.userId,
                value: JSON.stringify({
                    type: 'EQUIPMENT_EVOLUTION',
                    userId: event.userId,
                    evolutionStage: event.toStage,
                    timestamp: Date.now()
                })
            }]
        });
    }
}

module.exports = EquipmentEvents;
```

## 验收标准

- [ ] 玩家可以查看装备当前强化等级和进化阶段
- [ ] 强化装备消耗金币和强化石，成功提升等级或增加保底进度
- [ ] 强化失败时装备不掉级，但增加下次成功率
- [ ] 装备达到特定等级和材料要求后可以进化
- [ ] 进化后装备属性提升，外观和特效发生变化
- [ ] 所有强化和进化操作有完整的日志记录
- [ ] 强化动画和音效正确播放
- [ ] 进化仪式特效震撼且有满足感
- [ ] 弱网环境下操作不丢失数据
- [ ] 缓存策略有效，减少数据库查询压力
- [ ] 事件正确发送到 Kafka，下游服务正确消费

## 影响范围

- **数据库**：新增 `equipment_enhancement_config`、`equipment_evolution_config`、`equipment_enhancement_log`、`equipment_evolution_log` 表，扩展 `pokemon_equipment` 表
- **pokemon-service**：新增装备强化和进化 API 路由
- **reward-service**：处理强化石和进化材料的发放逻辑
- **user-service**：用户资源（金币、材料）管理
- **game-client**：新增装备强化和进化 UI 组件
- **Redis**：新增装备配置和统计数据缓存
- **Kafka**：新增 `equipment-events` topic

## 参考

- [游戏装备强化系统设计最佳实践](https://game-design-patterns.com/equipment-enhancement)
- [概率保底机制数学模型](https://gacha-math.com/pity-system)
- [Pokemon GO CP 计算公式](https://pokemongo.fandom.com/wiki/CP)
- [Framer Motion 动画库文档](https://www.framer.com/motion/)
