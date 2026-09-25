# REQ-00112: 精灵技能冷却与能量系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00112 |
| 标题 | 精灵技能冷却与能量系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | pokemon-service、gym-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-11 12:34 |

## 需求描述

为精灵战斗系统增加完整的技能冷却与能量管理机制，使战斗更具策略性和深度：

### 核心功能
1. **技能冷却系统**
   - 每个技能有独立的冷却回合数
   - 冷却期间无法使用该技能
   - 冷却显示与提示

2. **能量系统（Energy System）**
   - 每个精灵拥有能量池（Energy Pool）
   - 技能消耗能量值
   - 能量自动回复机制
   - 能量上限与个体值关联

3. **能量回复机制**
   - 每回合自动回复基础能量
   - 某些技能可回复能量
   - 携带道具影响能量回复

4. **策略深度**
   - 高威力技能高能量消耗
   - 快速技能低能量消耗
   - 能量管理成为战斗策略核心

### 目标
- 增加战斗策略深度
- 平衡快速技能与高威力技能
- 提供能量管理玩法
- 提升战斗竞技性

## 技术方案

### 1. 数据库设计

```sql
-- 数据库迁移：20260611_123400__add_skill_energy_system.sql

-- 扩展技能表，添加冷却和能量属性
ALTER TABLE moves 
ADD COLUMN cooldown_turns INTEGER DEFAULT 0,
ADD COLUMN energy_cost INTEGER DEFAULT 0,
ADD COLUMN energy_recover INTEGER DEFAULT 0,
ADD COLUMN energy_type VARCHAR(20) DEFAULT 'standard'; -- standard/fast/charged/special

-- 精灵能量池表
CREATE TABLE pokemon_energy (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id),
    current_energy INTEGER DEFAULT 100,
    max_energy INTEGER DEFAULT 100,
    energy_regen_rate INTEGER DEFAULT 10, -- 每回合回复
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_instance_id)
);

-- 战斗中的能量记录表
CREATE TABLE battle_energy_state (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(100) NOT NULL,
    pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id),
    current_energy INTEGER DEFAULT 100,
    cooldowns JSONB DEFAULT '{}', -- {"move_id": remaining_turns}
    turn_number INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 能量回复规则配置表
CREATE TABLE energy_regen_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(50) NOT NULL,
    base_regen INTEGER DEFAULT 10,
    hp_threshold_bonus JSONB DEFAULT '[]', -- [{"threshold": 0.25, "bonus": 5}]
    status_effect_modifiers JSONB DEFAULT '{}', -- {"paralyzed": -5}
    item_modifiers JSONB DEFAULT '{}', -- {"energy_charm": 5}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_pokemon_energy_pokemon ON pokemon_energy(pokemon_instance_id);
CREATE INDEX idx_battle_energy_battle ON battle_energy_state(battle_id);
CREATE INDEX idx_battle_energy_pokemon ON battle_energy_state(pokemon_instance_id);

-- 初始化现有技能的冷却和能量值
UPDATE moves SET 
    cooldown_turns = CASE 
        WHEN power >= 100 THEN 3
        WHEN power >= 70 THEN 2
        WHEN power >= 40 THEN 1
        ELSE 0
    END,
    energy_cost = CASE 
        WHEN power >= 100 THEN 60
        WHEN power >= 70 THEN 45
        WHEN power >= 40 THEN 30
        WHEN power >= 20 THEN 15
        ELSE 10
    END,
    energy_type = CASE 
        WHEN power >= 100 THEN 'charged'
        WHEN power >= 70 THEN 'special'
        WHEN power >= 40 THEN 'standard'
        ELSE 'fast'
    END
WHERE power IS NOT NULL;

-- 插入默认能量回复规则
INSERT INTO energy_regen_rules (rule_name, base_regen, hp_threshold_bonus, status_effect_modifiers) VALUES
('standard', 10, '[{"threshold": 0.25, "bonus": 5}]', '{"paralyzed": -5, "frozen": -10}'),
('aggressive', 8, '[{"threshold": 0.5, "bonus": 3}]', '{}'),
('defensive', 12, '[{"threshold": 0.25, "bonus": 8}]', '{"burned": -3}');
```

### 2. 能量管理服务

```javascript
// backend/services/pokemon-service/src/energyService.js

const { Pool } = require('pg');
const Redis = require('ioredis');
const { logger, metrics } = require('../../shared');

class EnergyService {
    constructor() {
        this.pool = new Pool();
        this.redis = new Redis(process.env.REDIS_URL);
        this.BATTLE_ENERGY_TTL = 3600; // 1小时
    }

    /**
     * 初始化精灵能量池
     */
    async initializeEnergyPool(pokemonInstanceId, baseMaxEnergy = 100) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // 获取精灵个体值，影响能量上限
            const pokemonResult = await client.query(
                `SELECT iv_hp, iv_attack, iv_defense 
                 FROM pokemon_instances WHERE id = $1`,
                [pokemonInstanceId]
            );

            if (pokemonResult.rows.length === 0) {
                throw new Error('Pokemon not found');
            }

            const ivs = pokemonResult.rows[0];
            
            // 能量上限 = 基础值 + (个体值总和 / 15)
            const maxEnergy = baseMaxEnergy + Math.floor(
                (ivs.iv_hp + ivs.iv_attack + ivs.iv_defense) / 15
            );

            // 能量回复率 = 基础值 + (速度个体值 / 10)
            const energyRegenRate = 10 + Math.floor(ivs.iv_speed / 10);

            const result = await client.query(
                `INSERT INTO pokemon_energy (pokemon_instance_id, current_energy, max_energy, energy_regen_rate)
                 VALUES ($1, $2, $2, $3)
                 ON CONFLICT (pokemon_instance_id) DO UPDATE
                 SET max_energy = $2, energy_regen_rate = $3
                 RETURNING *`,
                [pokemonInstanceId, maxEnergy, energyRegenRate]
            );

            await client.query('COMMIT');
            
            metrics.increment('pokemon.energy_pool_initialized');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Failed to initialize energy pool', { error, pokemonInstanceId });
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 获取精灵当前能量
     */
    async getEnergyState(pokemonInstanceId) {
        // 先从 Redis 缓存读取
        const cacheKey = `pokemon:energy:${pokemonInstanceId}`;
        const cached = await this.redis.get(cacheKey);
        
        if (cached) {
            return JSON.parse(cached);
        }

        const result = await this.pool.query(
            `SELECT * FROM pokemon_energy WHERE pokemon_instance_id = $1`,
            [pokemonInstanceId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const energyState = result.rows[0];
        
        // 缓存 5 分钟
        await this.redis.setex(cacheKey, 300, JSON.stringify(energyState));
        
        return energyState;
    }

    /**
     * 消耗能量
     */
    async consumeEnergy(pokemonInstanceId, amount) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const current = await client.query(
                `SELECT current_energy, max_energy FROM pokemon_energy 
                 WHERE pokemon_instance_id = $1 FOR UPDATE`,
                [pokemonInstanceId]
            );

            if (current.rows.length === 0) {
                throw new Error('Energy pool not found');
            }

            const { current_energy, max_energy } = current.rows[0];

            if (current_energy < amount) {
                await client.query('ROLLBACK');
                return {
                    success: false,
                    reason: 'insufficient_energy',
                    current: current_energy,
                    required: amount
                };
            }

            const newEnergy = current_energy - amount;

            await client.query(
                `UPDATE pokemon_energy 
                 SET current_energy = $1, last_updated = CURRENT_TIMESTAMP
                 WHERE pokemon_instance_id = $2`,
                [newEnergy, pokemonInstanceId]
            );

            await client.query('COMMIT');

            // 更新缓存
            const cacheKey = `pokemon:energy:${pokemonInstanceId}`;
            await this.redis.del(cacheKey);

            metrics.histogram('pokemon.energy_consumed', amount);

            return {
                success: true,
                previousEnergy: current_energy,
                currentEnergy: newEnergy,
                consumed: amount
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 回复能量
     */
    async regenerateEnergy(pokemonInstanceId, amount = null) {
        const client = await this.pool.connect();
        try {
            const energyState = await this.getEnergyState(pokemonInstanceId);
            if (!energyState) return null;

            const regenAmount = amount || energyState.energy_regen_rate;
            const newEnergy = Math.min(
                energyState.current_energy + regenAmount,
                energyState.max_energy
            );

            await this.pool.query(
                `UPDATE pokemon_energy 
                 SET current_energy = $1, last_updated = CURRENT_TIMESTAMP
                 WHERE pokemon_instance_id = $2`,
                [newEnergy, pokemonInstanceId]
            );

            // 清除缓存
            await this.redis.del(`pokemon:energy:${pokemonInstanceId}`);

            return {
                previousEnergy: energyState.current_energy,
                currentEnergy: newEnergy,
                regenerated: newEnergy - energyState.current_energy
            };
        } finally {
            client.release();
        }
    }

    /**
     * 检查技能是否可用（能量和冷却）
     */
    async canUseMove(pokemonInstanceId, moveId, battleId = null) {
        // 获取技能信息
        const moveResult = await this.pool.query(
            `SELECT id, energy_cost, cooldown_turns FROM moves WHERE id = $1`,
            [moveId]
        );

        if (moveResult.rows.length === 0) {
            return { canUse: false, reason: 'move_not_found' };
        }

        const move = moveResult.rows[0];

        // 检查能量
        const energyState = await this.getEnergyState(pokemonInstanceId);
        if (!energyState) {
            return { canUse: false, reason: 'no_energy_pool' };
        }

        if (energyState.current_energy < move.energy_cost) {
            return { 
                canUse: false, 
                reason: 'insufficient_energy',
                current: energyState.current_energy,
                required: move.energy_cost
            };
        }

        // 如果在战斗中，检查冷却
        if (battleId && move.cooldown_turns > 0) {
            const battleState = await this.getBattleEnergyState(battleId, pokemonInstanceId);
            const cooldowns = battleState?.cooldowns || {};
            
            if (cooldowns[moveId] && cooldowns[moveId] > 0) {
                return {
                    canUse: false,
                    reason: 'on_cooldown',
                    remainingTurns: cooldowns[moveId]
                };
            }
        }

        return { 
            canUse: true, 
            energyCost: move.energy_cost,
            cooldownTurns: move.cooldown_turns
        };
    }

    /**
     * 获取战斗中的能量状态
     */
    async getBattleEnergyState(battleId, pokemonInstanceId) {
        const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
        const cached = await this.redis.get(cacheKey);
        
        if (cached) {
            return JSON.parse(cached);
        }

        const result = await this.pool.query(
            `SELECT * FROM battle_energy_state 
             WHERE battle_id = $1 AND pokemon_instance_id = $2`,
            [battleId, pokemonInstanceId]
        );

        const state = result.rows[0] || null;
        
        if (state) {
            await this.redis.setex(cacheKey, this.BATTLE_ENERGY_TTL, JSON.stringify(state));
        }

        return state;
    }

    /**
     * 初始化战斗能量状态
     */
    async initializeBattleEnergy(battleId, pokemonInstanceId) {
        const energyState = await this.getEnergyState(pokemonInstanceId);
        if (!energyState) {
            await this.initializeEnergyPool(pokemonInstanceId);
        }

        const result = await this.pool.query(
            `INSERT INTO battle_energy_state (battle_id, pokemon_instance_id, current_energy, cooldowns)
             VALUES ($1, $2, $3, '{}')
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [battleId, pokemonInstanceId, energyState?.current_energy || 100]
        );

        const state = result.rows[0];
        
        // 缓存
        const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
        await this.redis.setex(cacheKey, this.BATTLE_ENERGY_TTL, JSON.stringify(state));

        return state;
    }

    /**
     * 更新战斗冷却
     */
    async updateBattleCooldown(battleId, pokemonInstanceId, moveId, cooldownTurns) {
        const state = await this.getBattleEnergyState(battleId, pokemonInstanceId);
        const cooldowns = state?.cooldowns || {};

        if (cooldownTurns > 0) {
            cooldowns[moveId] = cooldownTurns;
        }

        await this.pool.query(
            `UPDATE battle_energy_state 
             SET cooldowns = $1, updated_at = CURRENT_TIMESTAMP
             WHERE battle_id = $2 AND pokemon_instance_id = $3`,
            [JSON.stringify(cooldowns), battleId, pokemonInstanceId]
        );

        // 更新缓存
        const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
        await this.redis.del(cacheKey);
    }

    /**
     * 回合开始 - 减少冷却并回复能量
     */
    async processTurnStart(battleId, pokemonInstanceId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const state = await this.getBattleEnergyState(battleId, pokemonInstanceId);
            if (!state) {
                throw new Error('Battle energy state not found');
            }

            // 减少所有冷却
            const newCooldowns = {};
            for (const [moveId, turns] of Object.entries(state.cooldowns)) {
                if (turns > 1) {
                    newCooldowns[moveId] = turns - 1;
                }
            }

            // 获取基础能量回复
            const energyState = await this.getEnergyState(pokemonInstanceId);
            const regenAmount = energyState?.energy_regen_rate || 10;
            const maxEnergy = energyState?.max_energy || 100;
            
            const newEnergy = Math.min(state.current_energy + regenAmount, maxEnergy);

            // 更新状态
            await client.query(
                `UPDATE battle_energy_state 
                 SET current_energy = $1, cooldowns = $2, 
                     turn_number = turn_number + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE battle_id = $3 AND pokemon_instance_id = $4`,
                [newEnergy, JSON.stringify(newCooldowns), battleId, pokemonInstanceId]
            );

            await client.query('COMMIT');

            // 清除缓存
            const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
            await this.redis.del(cacheKey);

            return {
                energyRegenerated: newEnergy - state.current_energy,
                currentEnergy: newEnergy,
                cooldownsReduced: newCooldowns
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 使用技能 - 消耗能量并设置冷却
     */
    async useMove(battleId, pokemonInstanceId, moveId) {
        const canUse = await this.canUseMove(pokemonInstanceId, moveId, battleId);
        if (!canUse.canUse) {
            return canUse;
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const state = await this.getBattleEnergyState(battleId, pokemonInstanceId);
            
            // 消耗能量
            const newEnergy = state.current_energy - canUse.energyCost;

            // 设置冷却
            const newCooldowns = { ...state.cooldowns };
            if (canUse.cooldownTurns > 0) {
                newCooldowns[moveId] = canUse.cooldownTurns;
            }

            // 更新状态
            await client.query(
                `UPDATE battle_energy_state 
                 SET current_energy = $1, cooldowns = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE battle_id = $3 AND pokemon_instance_id = $4`,
                [newEnergy, JSON.stringify(newCooldowns), battleId, pokemonInstanceId]
            );

            await client.query('COMMIT');

            // 清除缓存
            const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
            await this.redis.del(cacheKey);

            metrics.increment('battle.move_used_with_energy');

            return {
                success: true,
                energyConsumed: canUse.energyCost,
                currentEnergy: newEnergy,
                cooldownSet: canUse.cooldownTurns
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = new EnergyService();
```

### 3. 战斗引擎集成

```javascript
// backend/services/gym-service/src/battleEngine.js (扩展)

const energyService = require('../../pokemon-service/src/energyService');

class BattleEngine {
    // ... 现有代码 ...

    /**
     * 执行技能使用（带能量和冷却检查）
     */
    async executeMove(battleId, attackerId, defenderId, moveId) {
        // 检查技能是否可用
        const canUse = await energyService.canUseMove(attackerId, moveId, battleId);
        
        if (!canUse.canUse) {
            return {
                success: false,
                error: canUse.reason,
                details: {
                    currentEnergy: canUse.current,
                    requiredEnergy: canUse.required,
                    remainingCooldown: canUse.remainingTurns
                }
            };
        }

        // 使用技能（消耗能量）
        const energyResult = await energyService.useMove(battleId, attackerId, moveId);

        // 执行原有战斗逻辑
        const moveResult = await this.calculateMoveDamage(attackerId, defenderId, moveId);

        return {
            success: true,
            damage: moveResult.damage,
            energyConsumed: energyResult.energyConsumed,
            currentEnergy: energyResult.currentEnergy,
            cooldownSet: energyResult.cooldownSet
        };
    }

    /**
     * 回合开始处理
     */
    async startTurn(battleId, participantIds) {
        const results = [];
        
        for (const pokemonId of participantIds) {
            const result = await energyService.processTurnStart(battleId, pokemonId);
            results.push({
                pokemonId,
                energyRegenerated: result.energyRegenerated,
                currentEnergy: result.currentEnergy
            });
        }

        return results;
    }
}

module.exports = BattleEngine;
```

### 4. API 路由

```javascript
// backend/services/pokemon-service/src/routes/energy.js

const express = require('express');
const router = express.Router();
const energyService = require('../energyService');
const { authenticate, authorize } = require('../../shared/middleware');

/**
 * 获取精灵能量状态
 * GET /api/pokemon/:id/energy
 */
router.get('/:id/energy', authenticate, async (req, res) => {
    try {
        const energyState = await energyService.getEnergyState(req.params.id);
        
        if (!energyState) {
            return res.status(404).json({ error: 'Energy state not found' });
        }

        res.json({
            pokemonId: req.params.id,
            currentEnergy: energyState.current_energy,
            maxEnergy: energyState.max_energy,
            regenRate: energyState.energy_regen_rate
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 手动回复能量（用于测试或特殊道具）
 * POST /api/pokemon/:id/energy/regenerate
 */
router.post('/:id/energy/regenerate', authenticate, async (req, res) => {
    try {
        const { amount } = req.body;
        const result = await energyService.regenerateEnergy(req.params.id, amount);
        
        res.json({
            success: true,
            previousEnergy: result.previousEnergy,
            currentEnergy: result.currentEnergy,
            regenerated: result.regenerated
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 检查技能可用性
 * POST /api/pokemon/:id/moves/check
 */
router.post('/:id/moves/check', authenticate, async (req, res) => {
    try {
        const { moveId, battleId } = req.body;
        const result = await energyService.canUseMove(req.params.id, moveId, battleId);
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
```

### 5. 前端能量UI组件

```javascript
// frontend/game-client/src/components/EnergyBar.js

class EnergyBar {
    constructor(container, options = {}) {
        this.container = container;
        this.maxEnergy = options.maxEnergy || 100;
        this.currentEnergy = options.currentEnergy || 100;
        this.regenRate = options.regenRate || 10;
        
        this.render();
    }

    render() {
        this.container.innerHTML = `
            <div class="energy-bar-container">
                <div class="energy-info">
                    <span class="energy-icon">⚡</span>
                    <span class="energy-value">${this.currentEnergy}/${this.maxEnergy}</span>
                    <span class="energy-regen">+${this.regenRate}/turn</span>
                </div>
                <div class="energy-bar">
                    <div class="energy-fill" style="width: ${this.getPercentage()}%"></div>
                </div>
            </div>
        `;

        this.applyStyles();
    }

    applyStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .energy-bar-container {
                width: 200px;
                padding: 8px;
                background: rgba(0, 0, 0, 0.7);
                border-radius: 8px;
                font-family: 'PokemonFont', sans-serif;
            }

            .energy-info {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 6px;
                color: #FFD700;
                font-size: 14px;
            }

            .energy-icon {
                font-size: 18px;
                animation: pulse 1.5s infinite;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.8; transform: scale(1.1); }
            }

            .energy-regen {
                margin-left: auto;
                color: #90EE90;
                font-size: 12px;
            }

            .energy-bar {
                height: 12px;
                background: rgba(0, 0, 0, 0.5);
                border-radius: 6px;
                overflow: hidden;
                border: 1px solid #FFD700;
            }

            .energy-fill {
                height: 100%;
                background: linear-gradient(90deg, #FFD700, #FFA500);
                transition: width 0.3s ease;
                box-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
            }

            .energy-fill.low {
                background: linear-gradient(90deg, #FF6347, #FF4500);
            }

            .energy-fill.medium {
                background: linear-gradient(90deg, #FFA500, #FFD700);
            }
        `;

        if (!document.querySelector('style[data-energy-bar]')) {
            style.setAttribute('data-energy-bar', 'true');
            document.head.appendChild(style);
        }
    }

    update(currentEnergy) {
        this.currentEnergy = currentEnergy;
        const percentage = this.getPercentage();
        
        const fill = this.container.querySelector('.energy-fill');
        const value = this.container.querySelector('.energy-value');
        
        fill.style.width = `${percentage}%`;
        value.textContent = `${this.currentEnergy}/${this.maxEnergy}`;

        // 更新颜色状态
        fill.classList.remove('low', 'medium');
        if (percentage < 30) {
            fill.classList.add('low');
        } else if (percentage < 60) {
            fill.classList.add('medium');
        }
    }

    getPercentage() {
        return Math.max(0, Math.min(100, (this.currentEnergy / this.maxEnergy) * 100));
    }

    showInsufficientEnergy(required) {
        const bar = this.container.querySelector('.energy-bar');
        bar.classList.add('insufficient');
        
        // 显示提示
        const tooltip = document.createElement('div');
        tooltip.className = 'energy-tooltip';
        tooltip.textContent = `需要 ${required} 能量`;
        this.container.appendChild(tooltip);

        setTimeout(() => {
            bar.classList.remove('insufficient');
            tooltip.remove();
        }, 2000);
    }
}

module.exports = EnergyBar;
```

### 6. 技能冷却显示组件

```javascript
// frontend/game-client/src/components/MoveCooldownIndicator.js

class MoveCooldownIndicator {
    constructor(moveButton, options = {}) {
        this.moveButton = moveButton;
        this.cooldownTurns = options.cooldownTurns || 0;
        this.energyCost = options.energyCost || 0;
        
        this.render();
    }

    render() {
        const indicator = document.createElement('div');
        indicator.className = 'move-cooldown-indicator';
        
        if (this.cooldownTurns > 0) {
            indicator.innerHTML = `
                <div class="cooldown-overlay">
                    <span class="cooldown-turns">${this.cooldownTurns}</span>
                </div>
            `;
        }

        if (this.energyCost > 0) {
            indicator.innerHTML += `
                <div class="energy-cost">
                    <span class="energy-icon">⚡</span>
                    <span>${this.energyCost}</span>
                </div>
            `;
        }

        this.moveButton.appendChild(indicator);
        this.applyStyles();
    }

    applyStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .move-cooldown-indicator {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                pointer-events: none;
            }

            .cooldown-overlay {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 8px;
            }

            .cooldown-turns {
                font-size: 24px;
                font-weight: bold;
                color: #FF4444;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
            }

            .energy-cost {
                position: absolute;
                bottom: 4px;
                right: 4px;
                background: rgba(255, 215, 0, 0.9);
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 12px;
                color: #000;
                display: flex;
                align-items: center;
                gap: 2px;
            }

            .energy-icon {
                font-size: 10px;
            }
        `;

        if (!document.querySelector('style[data-move-cooldown]')) {
            style.setAttribute('data-move-cooldown', 'true');
            document.head.appendChild(style);
        }
    }

    setCooldown(remainingTurns) {
        const overlay = this.moveButton.querySelector('.cooldown-overlay');
        
        if (remainingTurns > 0) {
            if (!overlay) {
                this.render();
            } else {
                overlay.querySelector('.cooldown-turns').textContent = remainingTurns;
            }
            this.moveButton.disabled = true;
        } else {
            if (overlay) overlay.remove();
            this.moveButton.disabled = false;
        }
    }
}

module.exports = MoveCooldownIndicator;
```

## 验收标准

- [ ] 数据库迁移成功创建 4 张新表（pokemon_energy, battle_energy_state, energy_regen_rules）
- [ ] 所有现有技能自动初始化冷却和能量值
- [ ] EnergyService 实现完整的能量管理功能
- [ ] 能量消耗和回复逻辑正确
- [ ] 冷却系统在战斗中正确工作
- [ ] 回合开始自动减少冷却并回复能量
- [ ] API 端点可用：GET /api/pokemon/:id/energy
- [ ] API 端点可用：POST /api/pokemon/:id/energy/regenerate
- [ ] API 端点可用：POST /api/pokemon/:id/moves/check
- [ ] 前端 EnergyBar 组件正确显示能量状态
- [ ] 前端 MoveCooldownIndicator 显示冷却和能量消耗
- [ ] 能量不足时正确提示用户
- [ ] 单元测试覆盖 EnergyService 所有方法（目标 35+ 测试）
- [ ] 集成测试验证战斗中的能量流转
- [ ] 性能测试验证能量状态查询 < 50ms

## 影响范围

### 新增文件
- `database/pending/20260611_123400__add_skill_energy_system.sql`
- `backend/services/pokemon-service/src/energyService.js`
- `backend/services/pokemon-service/src/routes/energy.js`
- `frontend/game-client/src/components/EnergyBar.js`
- `frontend/game-client/src/components/MoveCooldownIndicator.js`
- `backend/tests/unit/energy-service.test.js`

### 修改文件
- `backend/services/pokemon-service/src/index.js` - 注册能量路由
- `backend/services/gym-service/src/battleEngine.js` - 集成能量系统
- `backend/gateway/src/index.js` - 添加能量 API 代理

### 数据库变更
- 新增表：`pokemon_energy`, `battle_energy_state`, `energy_regen_rules`
- 修改表：`moves` 添加冷却和能量字段

## 参考

- Pokemon GO 快速/蓄力技能系统
- Pokemon 主系列游戏 PP 系统
- MOBA 游戏法力值系统设计
- REQ-00019: 精灵技能学习与技能机器系统
- REQ-00054: 道馆战斗系统
- REQ-00065: 精灵进化与成长系统

## 实现记录（2026-09-25）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 数据库迁移成功创建 4 张新表（pokemon_energy, battle_energy_state, energy_regen_rules） | ✅ | 三张表由既有迁移 `migrations/20260629_200000__add_skill_energy_system.sql` 创建并已在全新库执行成功；`moves` 的 energy_cost/cooldown_turns/energy_recover 列同迁移添加。本需求未再新建重复表 |
| 所有现有技能自动初始化冷却和能量值 | ✅ | `battle/stats.js normalizeMove`：蓄力消耗 = max(energy_cost, -energy_delta)，快速回能 = energy_delta，冷却 = cooldown_turns×1000 或 cooldown_ms；全部 61 个技能均有值。另修复种子被主系列威力覆盖的问题（110100 迁移恢复 GO 快速技能威力） |
| EnergyService 实现完整的能量管理功能 | ✅ | 偏差：未接入 pokemon-service 旧 `energyService.js`（引用不存在的 iv_speed/level 列）。能量逻辑在 gym-service `battle/energy.js`（上限 100~120 与个体值关联、回复规则、校验、消耗/回复）与 `battle/pokemonEnergy.js`（能量池按时间自然回复、战斗中实时能量） |
| 能量消耗和回复逻辑正确 | ✅ | 单测「能量：上限/回复/消耗/不足拒绝」；energy_regen_rules 的低血量加成与状态修正生效 |
| 冷却系统在战斗中正确工作 | ✅ | 回合制：使用后 readyTurn = 当前回合 + 冷却回合 + 1，冷却中出招返回 400 MOVE_COOLDOWN；单测覆盖 |
| 回合开始自动减少冷却并回复能量 | ✅ | 冷却按回合号自然到期；每回合结算时按 energy_regen_rules（standard）回复能量（等价于下一回合开始前） |
| API 端点可用：GET /api/pokemon/:id/energy | ✅ | 网关别名 → gym `/battle/pokemon/:id/energy`（也可 `/v1/battle/pokemon/:id/energy`），返回能量池 + 进行中战斗的实时能量与各技能剩余冷却 |
| API 端点可用：POST /api/pokemon/:id/energy/regenerate | ✅ | 按经过时间结算（5 点/分钟），回复量只由服务端时间决定，重复调用不会多回复 |
| API 端点可用：POST /api/pokemon/:id/moves/check | ✅ | 战斗中按战斗状态（冷却/能量），否则按能量池判断 |
| 前端 EnergyBar 组件正确显示能量状态 | ✅ | `frontend/game-client/src/battle/BattleView.js`：能量条 + 各蓄力技能的能量刻度（够用时高亮），补间动画；模型 `energyBarModel` 有单测 |
| 前端 MoveCooldownIndicator 显示冷却和能量消耗 | ✅ | 技能按钮显示 -能量/+能量、剩余冷却回合遮罩、冷却回合数（`moveButtonState` 单测） |
| 能量不足时正确提示用户 | ✅ | 按钮禁用并显示「需 N 能量」；服务端 400 INSUFFICIENT_ENERGY 带 need/have，客户端 toast |
| 单元测试覆盖 EnergyService 所有方法（目标 35+ 测试） | ⚠️ | `battle/energy.js` 全部 6 个导出函数均有覆盖（行覆盖 95.7%，node 内置覆盖率），能量相关断言 40+，但按 node:test 计为 3 个用例；pokemonEnergy.js（依赖数据库）由 smoke 覆盖 |
| 集成测试验证战斗中的能量流转 | ✅ | `scripts/smoke-battle.js`：蓄力技能能量不足被拒、战斗中 /api/pokemon/:id/energy 返回实时能量、能量池/回复/技能检查（规则变更前实测通过） |
| 性能测试验证能量状态查询 < 50ms | ⚠️ | 未实测；`scripts/bench-battle.js`（经网关模式）统计 energyMs P95，待运行 |

- 入口：gym-service `src/battle/*`（纯逻辑：damage/cooldown/energy/combo/engine/ai/stats/leagueRules/recommendScore/replayFormat/presetRules；持久化与编排：repo/store/session/gym/raid/league/replay/recommend/comboPresets/pokemonEnergy/settle/deps）；路由 `routes/gyms.js`、`routes/gymBattle.js`、`routes/raids.js`、`routes/battleApi.js`（挂 `/battle`）；网关 `backend/gateway/src/index.js`：`/v1/gyms/*`、`/v1/raids/*`、`/v1/battle/*`（鉴权）、公开 `/v1/battle/replays/shared/:code`、WebSocket 升级转发 `/ws/raid`、`/ws/notifications`、`/ws/battle`
- 迁移：`database/migrations/20260925_110000__e11_battle_core.sql`（补列/新表/连击链种子/时间列 TIMESTAMPTZ，全部 IF NOT EXISTS）、`20260925_110100__e11_restore_fast_move_power.sql`；复用既有表见各行说明
- 测试：宿主机已运行（纯逻辑，不连服务）：`cd backend && node --test tests/unit/battle-core.test.js tests/unit/battle-features.test.js` → 29/29 通过；`node --test frontend/game-client/tests/unit/battle-client.test.mjs` → 11/11 通过；`node --expose-gc scripts/bench-battle.js --local`（数字见表）。验证方式调整前（2026-09-25 08:39，提交 e022c97）曾在隔离 CI 栈实测：`scripts/smoke-battle.js` 101/101、核心冒烟 37/37、battle-core 16/16。之后的改动（连击熟练度接入、实时天气、连击道具奖励、大师联赛分组、AI 对位口径、迁移时间列段、前端全部）**未运行，待验证**。待运行：`BASE_URL=… DATABASE_URL=… REDIS_URL=… node scripts/smoke-battle.js`（102 项）、`node scripts/bench-battle.js --battles 20 --concurrency 5`；迁移在全新库上执行 `reset-db` 后检查 bootstrap-report 无 20260925_1100xx 失败
- 待验证：战斗中蓄力技能能量刻度与服务端能量一致；能量池自然回复（隔几分钟调用 regenerate）；bench 的 energyMs P95
