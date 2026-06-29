/**
 * REQ-00112: 精灵技能冷却与能量系统 - 能量服务
 * 创建时间: 2026-06-29 20:00 UTC
 */

'use strict';

const { Pool } = require('pg');
const Redis = require('ioredis');
const { createLogger } = require('../../../shared/logger');
const { query } = require('../../../shared/db');

const logger = createLogger('energy-service');
const BATTLE_ENERGY_TTL = 3600; // 1小时
const ENERGY_CACHE_TTL = 300; // 5分钟

class EnergyService {
    constructor() {
        this.redis = null;
        this.initialized = false;
    }

    /**
     * 初始化 Redis 连接
     */
    initRedis() {
        if (!this.redis && process.env.REDIS_URL) {
            this.redis = new Redis(process.env.REDIS_URL);
        }
        this.initialized = true;
    }

    /**
     * 获取 Redis 客户端
     */
    getRedis() {
        if (!this.initialized) {
            this.initRedis();
        }
        return this.redis;
    }

    /**
     * 初始化精灵能量池
     */
    async initializeEnergyPool(pokemonInstanceId, baseMaxEnergy = 100) {
        try {
            // 获取精灵个体值，影响能量上限
            const pokemonResult = await query(
                `SELECT iv_hp, iv_attack, iv_defense, iv_speed, level 
                 FROM pokemon_instances WHERE id = $1`,
                [pokemonInstanceId]
            );

            if (pokemonResult.rows.length === 0) {
                throw new Error('Pokemon not found');
            }

            const ivs = pokemonResult.rows[0];
            
            // 能量上限 = 基础值 + (个体值总和 / 15)
            const maxEnergy = baseMaxEnergy + Math.floor(
                ((ivs.iv_hp || 0) + (ivs.iv_attack || 0) + (ivs.iv_defense || 0)) / 15
            );

            // 能量回复率 = 基础值 + (速度个体值 / 10)
            const energyRegenRate = 10 + Math.floor((ivs.iv_speed || 0) / 10);

            const result = await query(
                `INSERT INTO pokemon_energy (pokemon_instance_id, current_energy, max_energy, energy_regen_rate)
                 VALUES ($1, $2, $2, $3)
                 ON CONFLICT (pokemon_instance_id) DO UPDATE
                 SET max_energy = $2, energy_regen_rate = $3, last_updated = CURRENT_TIMESTAMP
                 RETURNING *`,
                [pokemonInstanceId, maxEnergy, energyRegenRate]
            );

            logger.info('Energy pool initialized', { 
                pokemonInstanceId, 
                maxEnergy, 
                energyRegenRate 
            });

            return result.rows[0];
        } catch (error) {
            logger.error('Failed to initialize energy pool', { 
                error: error.message, 
                pokemonInstanceId 
            });
            throw error;
        }
    }

    /**
     * 获取精灵当前能量
     */
    async getEnergyState(pokemonInstanceId) {
        const redis = this.getRedis();
        
        // 先从 Redis 缓存读取
        if (redis) {
            const cacheKey = `pokemon:energy:${pokemonInstanceId}`;
            const cached = await redis.get(cacheKey);
            
            if (cached) {
                return JSON.parse(cached);
            }
        }

        const result = await query(
            `SELECT * FROM pokemon_energy WHERE pokemon_instance_id = $1`,
            [pokemonInstanceId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const energyState = result.rows[0];
        
        // 缓存 5 分钟
        if (redis) {
            const cacheKey = `pokemon:energy:${pokemonInstanceId}`;
            await redis.setex(cacheKey, ENERGY_CACHE_TTL, JSON.stringify(energyState));
        }
        
        return energyState;
    }

    /**
     * 消耗能量
     */
    async consumeEnergy(pokemonInstanceId, amount) {
        try {
            await query('BEGIN');

            const current = await query(
                `SELECT current_energy, max_energy FROM pokemon_energy 
                 WHERE pokemon_instance_id = $1 FOR UPDATE`,
                [pokemonInstanceId]
            );

            if (current.rows.length === 0) {
                await query('ROLLBACK');
                return {
                    success: false,
                    reason: 'energy_pool_not_found'
                };
            }

            const { current_energy, max_energy } = current.rows[0];

            if (current_energy < amount) {
                await query('ROLLBACK');
                return {
                    success: false,
                    reason: 'insufficient_energy',
                    current: current_energy,
                    required: amount
                };
            }

            const newEnergy = current_energy - amount;

            await query(
                `UPDATE pokemon_energy 
                 SET current_energy = $1, last_updated = CURRENT_TIMESTAMP
                 WHERE pokemon_instance_id = $2`,
                [newEnergy, pokemonInstanceId]
            );

            await query('COMMIT');

            // 更新缓存
            const redis = this.getRedis();
            if (redis) {
                await redis.del(`pokemon:energy:${pokemonInstanceId}`);
            }

            logger.debug('Energy consumed', { 
                pokemonInstanceId, 
                amount, 
                previousEnergy: current_energy, 
                newEnergy 
            });

            return {
                success: true,
                previousEnergy: current_energy,
                currentEnergy: newEnergy,
                consumed: amount
            };
        } catch (error) {
            await query('ROLLBACK');
            logger.error('Failed to consume energy', { 
                error: error.message, 
                pokemonInstanceId 
            });
            throw error;
        }
    }

    /**
     * 回复能量
     */
    async regenerateEnergy(pokemonInstanceId, amount = null) {
        try {
            const energyState = await this.getEnergyState(pokemonInstanceId);
            if (!energyState) {
                // 如果没有能量池，初始化一个
                await this.initializeEnergyPool(pokemonInstanceId);
                return this.regenerateEnergy(pokemonInstanceId, amount);
            }

            const regenAmount = amount || energyState.energy_regen_rate;
            const newEnergy = Math.min(
                energyState.current_energy + regenAmount,
                energyState.max_energy
            );

            await query(
                `UPDATE pokemon_energy 
                 SET current_energy = $1, last_updated = CURRENT_TIMESTAMP
                 WHERE pokemon_instance_id = $2`,
                [newEnergy, pokemonInstanceId]
            );

            // 清除缓存
            const redis = this.getRedis();
            if (redis) {
                await redis.del(`pokemon:energy:${pokemonInstanceId}`);
            }

            logger.debug('Energy regenerated', { 
                pokemonInstanceId, 
                regenerated: newEnergy - energyState.current_energy,
                newEnergy 
            });

            return {
                previousEnergy: energyState.current_energy,
                currentEnergy: newEnergy,
                regenerated: newEnergy - energyState.current_energy
            };
        } catch (error) {
            logger.error('Failed to regenerate energy', { 
                error: error.message, 
                pokemonInstanceId 
            });
            throw error;
        }
    }

    /**
     * 检查技能是否可用（能量和冷却）
     */
    async canUseMove(pokemonInstanceId, moveId, battleId = null) {
        try {
            // 获取技能信息
            const moveResult = await query(
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
        } catch (error) {
            logger.error('Failed to check move availability', { 
                error: error.message, 
                pokemonInstanceId, 
                moveId 
            });
            throw error;
        }
    }

    /**
     * 获取战斗中的能量状态
     */
    async getBattleEnergyState(battleId, pokemonInstanceId) {
        const redis = this.getRedis();
        
        if (redis) {
            const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
            const cached = await redis.get(cacheKey);
            
            if (cached) {
                return JSON.parse(cached);
            }
        }

        const result = await query(
            `SELECT * FROM battle_energy_state 
             WHERE battle_id = $1 AND pokemon_instance_id = $2`,
            [battleId, pokemonInstanceId]
        );

        const state = result.rows[0] || null;
        
        if (state && redis) {
            const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
            await redis.setex(cacheKey, BATTLE_ENERGY_TTL, JSON.stringify(state));
        }

        return state;
    }

    /**
     * 初始化战斗能量状态
     */
    async initializeBattleEnergy(battleId, pokemonInstanceId) {
        try {
            const energyState = await this.getEnergyState(pokemonInstanceId);
            if (!energyState) {
                await this.initializeEnergyPool(pokemonInstanceId);
            }

            const result = await query(
                `INSERT INTO battle_energy_state (battle_id, pokemon_instance_id, current_energy, cooldowns)
                 VALUES ($1, $2, $3, '{}')
                 ON CONFLICT DO NOTHING
                 RETURNING *`,
                [battleId, pokemonInstanceId, energyState?.current_energy || 100]
            );

            const state = result.rows[0];
            
            // 缓存
            const redis = this.getRedis();
            if (state && redis) {
                const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
                await redis.setex(cacheKey, BATTLE_ENERGY_TTL, JSON.stringify(state));
            }

            logger.info('Battle energy initialized', { battleId, pokemonInstanceId });
            return state;
        } catch (error) {
            logger.error('Failed to initialize battle energy', { 
                error: error.message, 
                battleId, 
                pokemonInstanceId 
            });
            throw error;
        }
    }

    /**
     * 更新战斗冷却
     */
    async updateBattleCooldown(battleId, pokemonInstanceId, moveId, cooldownTurns) {
        try {
            const state = await this.getBattleEnergyState(battleId, pokemonInstanceId);
            const cooldowns = state?.cooldowns || {};

            if (cooldownTurns > 0) {
                cooldowns[moveId] = cooldownTurns;
            }

            await query(
                `UPDATE battle_energy_state 
                 SET cooldowns = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE battle_id = $2 AND pokemon_instance_id = $3`,
                [JSON.stringify(cooldowns), battleId, pokemonInstanceId]
            );

            // 更新缓存
            const redis = this.getRedis();
            if (redis) {
                const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
                await redis.del(cacheKey);
            }

            logger.debug('Battle cooldown updated', { 
                battleId, 
                pokemonInstanceId, 
                moveId, 
                cooldownTurns 
            });
        } catch (error) {
            logger.error('Failed to update battle cooldown', { 
                error: error.message, 
                battleId, 
                pokemonInstanceId 
            });
            throw error;
        }
    }

    /**
     * 回合开始 - 减少冷却并回复能量
     */
    async processTurnStart(battleId, pokemonInstanceId) {
        try {
            await query('BEGIN');

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
            await query(
                `UPDATE battle_energy_state 
                 SET current_energy = $1, cooldowns = $2, 
                     turn_number = turn_number + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE battle_id = $3 AND pokemon_instance_id = $4`,
                [newEnergy, JSON.stringify(newCooldowns), battleId, pokemonInstanceId]
            );

            await query('COMMIT');

            // 清除缓存
            const redis = this.getRedis();
            if (redis) {
                const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
                await redis.del(cacheKey);
            }

            logger.debug('Turn start processed', { 
                battleId, 
                pokemonInstanceId,
                energyRegenerated: newEnergy - state.current_energy,
                newEnergy
            });

            return {
                energyRegenerated: newEnergy - state.current_energy,
                currentEnergy: newEnergy,
                cooldownsReduced: newCooldowns
            };
        } catch (error) {
            await query('ROLLBACK');
            logger.error('Failed to process turn start', { 
                error: error.message, 
                battleId, 
                pokemonInstanceId 
            });
            throw error;
        }
    }

    /**
     * 使用技能 - 消耗能量并设置冷却
     */
    async useMove(battleId, pokemonInstanceId, moveId) {
        try {
            const canUse = await this.canUseMove(pokemonInstanceId, moveId, battleId);
            if (!canUse.canUse) {
                return canUse;
            }

            await query('BEGIN');

            const state = await this.getBattleEnergyState(battleId, pokemonInstanceId);
            
            // 消耗能量
            const newEnergy = state.current_energy - canUse.energyCost;

            // 设置冷却
            const newCooldowns = { ...state.cooldowns };
            if (canUse.cooldownTurns > 0) {
                newCooldowns[moveId] = canUse.cooldownTurns;
            }

            // 更新状态
            await query(
                `UPDATE battle_energy_state 
                 SET current_energy = $1, cooldowns = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE battle_id = $3 AND pokemon_instance_id = $4`,
                [newEnergy, JSON.stringify(newCooldowns), battleId, pokemonInstanceId]
            );

            await query('COMMIT');

            // 清除缓存
            const redis = this.getRedis();
            if (redis) {
                const cacheKey = `battle:energy:${battleId}:${pokemonInstanceId}`;
                await redis.del(cacheKey);
            }

            logger.info('Move used with energy system', { 
                battleId, 
                pokemonInstanceId, 
                moveId,
                energyConsumed: canUse.energyCost,
                currentEnergy: newEnergy
            });

            return {
                success: true,
                energyConsumed: canUse.energyCost,
                currentEnergy: newEnergy,
                cooldownSet: canUse.cooldownTurns
            };
        } catch (error) {
            await query('ROLLBACK');
            logger.error('Failed to use move', { 
                error: error.message, 
                battleId, 
                pokemonInstanceId, 
                moveId 
            });
            throw error;
        }
    }

    /**
     * 批量初始化战斗能量状态
     */
    async batchInitializeBattleEnergy(battleId, pokemonInstanceIds) {
        const results = [];
        
        for (const pokemonId of pokemonInstanceIds) {
            try {
                const state = await this.initializeBattleEnergy(battleId, pokemonId);
                results.push({ pokemonId, state, success: true });
            } catch (error) {
                results.push({ pokemonId, error: error.message, success: false });
            }
        }
        
        return results;
    }

    /**
     * 清理战斗能量状态
     */
    async cleanupBattleEnergy(battleId) {
        try {
            const result = await query(
                `DELETE FROM battle_energy_state WHERE battle_id = $1`,
                [battleId]
            );

            const redis = this.getRedis();
            if (redis) {
                // 清除所有相关缓存（使用通配符）
                const pattern = `battle:energy:${battleId}:*`;
                const keys = await redis.keys(pattern);
                if (keys.length > 0) {
                    await redis.del(...keys);
                }
            }

            logger.info('Battle energy cleaned up', { 
                battleId, 
                deletedCount: result.rowCount 
            });

            return result.rowCount;
        } catch (error) {
            logger.error('Failed to cleanup battle energy', { 
                error: error.message, 
                battleId 
            });
            throw error;
        }
    }

    /**
     * 获取技能能量信息
     */
    async getMoveEnergyInfo(moveId) {
        try {
            const result = await query(
                `SELECT id, name, power, cooldown_turns, energy_cost, energy_recover, energy_type 
                 FROM moves WHERE id = $1`,
                [moveId]
            );

            return result.rows[0] || null;
        } catch (error) {
            logger.error('Failed to get move energy info', { 
                error: error.message, 
                moveId 
            });
            throw error;
        }
    }

    /**
     * 批量获取技能能量信息
     */
    async batchGetMoveEnergyInfo(moveIds) {
        if (!moveIds || moveIds.length === 0) return [];
        
        try {
            const result = await query(
                `SELECT id, name, power, cooldown_turns, energy_cost, energy_recover, energy_type 
                 FROM moves WHERE id = ANY($1)`,
                [moveIds]
            );

            return result.rows;
        } catch (error) {
            logger.error('Failed to batch get move energy info', { 
                error: error.message, 
                moveIds 
            });
            throw error;
        }
    }
}

// 导出单例
const energyService = new EnergyService();
module.exports = energyService;
