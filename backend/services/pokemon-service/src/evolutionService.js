/**
 * REQ-00065: 精灵进化与成长系统
 * 进化服务核心模块（第1部分：核心功能）
 */

const { query, transaction, getPoolManagerInstance } = require('../../../shared/db');
const { getRedis } = require('../../../shared/redis');
const timePeriodManager = require('../../../shared/TimePeriodManager');
const promClient = require('prom-client');
const { logger } = require('../../shared/logger');

class EvolutionService {
    constructor() {
        this.db = getPoolManagerInstance().getPool(process.env.SERVICE_NAME || 'default');
        this.redis = getRedis();
        
        // 经验值表（各级所需总经验）
        this.experienceTable = this.buildExperienceTable();
        
        // CP 倍率表
        this.cpMultiplierTable = this.buildCPMultiplierTable();
        
        // 进化动画配置
        this.evolutionAnimations = {
            standard: { duration: 3000, particles: 50, sound: 'standard_evolution' },
            special: { duration: 5000, particles: 100, sound: 'special_evolution' },
            legendary: { duration: 8000, particles: 200, sound: 'legendary_evolution' }
        };
        
        // Prometheus 指标
        this.metrics = {
            evolutionCounter: new promClient.Counter({
                name: 'pokemon_evolution_total',
                help: 'Total number of Pokemon evolutions',
                labelNames: ['evolution_type', 'species']
            }),
            evolutionCheckDuration: new promClient.Histogram({
                name: 'evolution_check_duration_seconds',
                help: 'Duration of evolution eligibility checks',
                labelNames: ['evolution_type'],
                buckets: [0.01, 0.05, 0.1, 0.5, 1]
            }),
            experienceGained: new promClient.Counter({
                name: 'pokemon_experience_gained_total',
                help: 'Total experience gained',
                labelNames: ['source']
            }),
            levelUps: new promClient.Counter({
                name: 'pokemon_level_ups_total',
                help: 'Total number of level ups',
                labelNames: ['species']
            })
        };
    }

    /**
     * 构建经验值表（6种成长曲线）
     */
    buildExperienceTable() {
        const tables = {};
        
        // 快速成长 (4/5 * n³)
        tables.fast = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.floor(4 * Math.pow(level, 3) / 5);
        });
        
        // 中速成长 (n³)
        tables.medium_fast = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.pow(level, 3);
        });
        
        // 中慢成长
        tables.medium_slow = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.floor(4/5 * Math.pow(level, 3) - Math.pow(level, 2) + 10 * level - 15);
        });
        
        // 慢速成长 (5/4 * n³)
        tables.slow = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.floor(5 * Math.pow(level, 3) / 4);
        });
        
        // 波动成长
        tables.fluctuating = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            if (level % 2 === 0) {
                const factor = level % 4 === 0 ? 0.5 : 0.75;
                return Math.floor(level * level * level * factor);
            }
            const n = (level % 4 + 1);
            return Math.floor(level * level * level * n / 4);
        });
        
        // 不规则成长
        tables.erratic = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            if (level < 50) {
                return Math.floor(level * level * level * (100 - level) / 50);
            } else if (level < 68) {
                return Math.floor(level * level * level * (150 - level) / 100);
            } else if (level < 98) {
                return Math.floor(level * level * level * Math.floor((1911 - 10 * level) / 3) / 500);
            }
            return Math.floor(level * level * level * (160 - level) / 100);
        });
        
        return tables;
    }

    /**
     * 构建 CP 倍率表
     */
    buildCPMultiplierTable() {
        const multipliers = {};
        for (let level = 1; level <= 100; level++) {
            const halfLevel = Math.floor(level / 2);
            multipliers[level] = 0.094 + (level - 1) * 0.0042 + halfLevel * 0.001;
        }
        return multipliers;
    }

    /**
     * 检查精灵是否可以进化
     */
    async checkEvolutionEligibility(pokemonInstanceId, userId) {
        const startTime = Date.now();
        
        try {
            const pokemonResult = await this.db.query(`
                SELECT pi.*, ps.base_hp, ps.base_attack, ps.base_defense,
                       ps.base_sp_attack, ps.base_sp_defense, ps.base_speed,
                       ps.growth_rate, ps.name as species_name, ps.image_url,
                       ps.types, ps.rarity
                FROM pokemon_instances pi
                JOIN pokemon_species ps ON pi.species_id = ps.id
                WHERE pi.id = $1 AND pi.user_id = $2
            `, [pokemonInstanceId, userId]);
            
            if (pokemonResult.rows.length === 0) {
                return { eligible: false, reason: 'POKEMON_NOT_FOUND' };
            }
            
            const pokemon = pokemonResult.rows[0];
            
            const userResult = await this.db.query(
                'SELECT level FROM users WHERE id = $1',
                [userId]
            );
            
            if (userResult.rows.length === 0) {
                return { eligible: false, reason: 'USER_NOT_FOUND' };
            }
            
            const trainerLevel = userResult.rows[0].level;
            const maxPokemonLevel = Math.floor(trainerLevel + 1.5);
            
            const evolutionPaths = await this.db.query(`
                SELECT er.*, ps.name as to_species_name, ps.image_url as to_image_url,
                       ps.base_hp as to_base_hp, ps.base_attack as to_base_attack,
                       ps.base_defense as to_base_defense, ps.base_sp_attack as to_base_sp_attack,
                       ps.base_sp_defense as to_base_sp_defense, ps.base_speed as to_base_speed,
                       ps.types as to_types, ps.rarity as to_rarity, ei.name as item_name
                FROM evolution_rules er
                JOIN pokemon_species ps ON er.to_species_id = ps.id
                LEFT JOIN evolution_items ei ON er.required_item_id = ei.id
                WHERE er.from_species_id = $1 AND er.is_active = true
                ORDER BY er.branch_priority DESC
            `, [pokemon.species_id]);
            
            if (evolutionPaths.rows.length === 0) {
                return { eligible: false, reason: 'NO_EVOLUTION_AVAILABLE' };
            }
            
            const availableEvolutions = [];
            const pendingEvolutions = [];
            
            for (const path of evolutionPaths.rows) {
                const checkResult = await this.checkEvolutionConditions(pokemon, path, userId);
                
                if (checkResult.canEvolve) {
                    availableEvolutions.push({
                        ...path,
                        preview: await this.calculateEvolutionPreview(pokemon, path),
                        requirements: checkResult.requirements
                    });
                } else {
                    pendingEvolutions.push({
                        ...path,
                        requirements: checkResult.requirements,
                        missingRequirements: checkResult.missingRequirements
                    });
                }
            }
            
            this.metrics.evolutionCheckDuration.observe(
                { evolution_type: 'check' },
                (Date.now() - startTime) / 1000
            );
            
            if (availableEvolutions.length === 0) {
                return { 
                    eligible: false, 
                    reason: 'CONDITIONS_NOT_MET',
                    pokemon,
                    pendingEvolutions,
                    trainerLevel,
                    maxPokemonLevel
                };
            }
            
            return {
                eligible: true,
                pokemon,
                availableEvolutions,
                pendingEvolutions,
                trainerLevel,
                maxPokemonLevel,
                recommendation: this.recommendEvolution(availableEvolutions, pokemon)
            };
            
        } catch (error) {
            logger.error('Evolution eligibility check failed', { 
                error: error.message, 
                pokemonInstanceId, 
                userId 
            });
            throw error;
        }
    }

    /**
     * 检查进化条件
     */
    async checkEvolutionConditions(pokemon, evolutionPath, userId) {
        const result = { 
            canEvolve: false, 
            requirements: {},
            missingRequirements: []
        };
        
        switch (evolutionPath.evolution_type) {
            case 'level':
                const currentLevel = pokemon.level || 1;
                result.requirements = {
                    type: 'level',
                    current: currentLevel,
                    required: evolutionPath.min_level,
                    met: currentLevel >= evolutionPath.min_level
                };
                result.canEvolve = result.requirements.met;
                if (!result.canEvolve) {
                    result.missingRequirements.push({
                        type: 'level',
                        message: `需要等级 ${evolutionPath.min_level}，当前等级 ${currentLevel}`
                    });
                }
                break;
                
            case 'item':
                const itemCheck = await this.db.query(`
                    SELECT ui.quantity, ei.name as item_name
                    FROM user_items ui
                    JOIN evolution_items ei ON ui.item_id = ei.id
                    WHERE ui.user_id = $1 AND ui.item_id = $2 AND ui.quantity > 0
                `, [userId, evolutionPath.required_item_id]);
                
                const hasItem = itemCheck.rows.length > 0;
                result.requirements = {
                    type: 'item',
                    itemId: evolutionPath.required_item_id,
                    itemName: evolutionPath.item_name || itemCheck.rows[0]?.item_name || 'Unknown',
                    met: hasItem,
                    willConsume: evolutionPath.item_consumed !== false,
                    quantityOwned: itemCheck.rows[0]?.quantity || 0
                };
                result.canEvolve = hasItem;
                if (!hasItem) {
                    result.missingRequirements.push({
                        type: 'item',
                        message: `需要 ${result.requirements.itemName}`
                    });
                }
                break;
                
            case 'trade':
                result.requirements = {
                    type: 'trade',
                    met: false,
                    note: '需要在交易过程中完成进化'
                };
                result.missingRequirements.push({
                    type: 'trade',
                    message: '需要与其他玩家交换'
                });
                break;
                
            case 'condition':
                result.requirements = await this.checkComplexConditions(pokemon, evolutionPath.conditions || {}, userId);
                result.canEvolve = result.requirements.met;
                result.missingRequirements = result.requirements.missingRequirements || [];
                break;
                
            default:
                result.missingRequirements.push({
                    type: 'unknown',
                    message: '未知的进化类型'
                });
        }
        
        return result;
    }

    /**
     * 检查复杂进化条件
     */
    async checkComplexConditions(pokemon, conditions, userId) {
        const checkResults = [];
        const allMet = [];
        const missingRequirements = [];
        
        // 检查亲密度
        if (conditions.friendship) {
            const currentFriendship = pokemon.friendship || 70;
            const met = currentFriendship >= conditions.friendship;
            checkResults.push({
                type: 'friendship',
                current: currentFriendship,
                required: conditions.friendship,
                met
            });
            allMet.push(met);
            if (!met) {
                missingRequirements.push({
                    type: 'friendship',
                    message: `需要亲密度 ${conditions.friendship}，当前 ${currentFriendship}`
                });
            }
        }
        
        // 检查时间（白天/黑夜）
        if (conditions.time) {
            const period = await timePeriodManager.getCurrentPeriod();
            const isDay = period.id === 'day' || period.id === 'dawn' || period.id === 'dusk';
            const met = (conditions.time === 'day' && isDay) || (conditions.time === 'night' && !isDay);
            checkResults.push({
                type: 'time',
                required: conditions.time,
                current: isDay ? 'day' : 'night',
                met
            });
            allMet.push(met);
            if (!met) {
                missingRequirements.push({
                    type: 'time',
                    message: `需要在${conditions.time === 'day' ? '白天' : '夜晚'}进行`
                });
            }
        }
        
        // 检查属性条件
        if (conditions.attack_stat_gt_defense) {
            const pokemonAttack = pokemon.attack || 0;
            const pokemonDefense = pokemon.defense || 0;
            const met = pokemonAttack > pokemonDefense;
            checkResults.push({
                type: 'attack_gt_defense',
                current: { attack: pokemonAttack, defense: pokemonDefense },
                met
            });
            allMet.push(met);
            if (!met) {
                missingRequirements.push({
                    type: 'stat',
                    message: `需要攻击力大于防御力`
                });
            }
        }
        
        return {
            type: 'condition',
            checks: checkResults,
            met: allMet.every(m => m),
            missingRequirements
        };
    }

    /**
     * 计算进化后属性
     */
    calculatePostEvolutionStats(pokemon, targetSpecies) {
        const level = pokemon.level || 1;
        const cpMultiplier = this.cpMultiplierTable[level] || 0.5;
        
        const ivHp = pokemon.iv_hp || Math.floor(Math.random() * 16);
        const ivAttack = pokemon.iv_attack || Math.floor(Math.random() * 16);
        const ivDefense = pokemon.iv_defense || Math.floor(Math.random() * 16);
        const ivSpAttack = pokemon.iv_sp_attack || Math.floor(Math.random() * 16);
        const ivSpDefense = pokemon.iv_sp_defense || Math.floor(Math.random() * 16);
        const ivSpeed = pokemon.iv_speed || Math.floor(Math.random() * 16);
        
        const baseHp = targetSpecies.base_hp || 100;
        const baseAttack = targetSpecies.base_attack || 100;
        const baseDefense = targetSpecies.base_defense || 100;
        const baseSpAttack = targetSpecies.base_sp_attack || 100;
        const baseSpDefense = targetSpecies.base_sp_defense || 100;
        const baseSpeed = targetSpecies.base_speed || 100;
        
        const stats = {
            totalHp: Math.floor((baseHp + ivHp) * cpMultiplier),
            attack: Math.floor((baseAttack + ivAttack) * cpMultiplier),
            defense: Math.floor((baseDefense + ivDefense) * cpMultiplier),
            spAttack: Math.floor((baseSpAttack + ivSpAttack) * cpMultiplier),
            spDefense: Math.floor((baseSpDefense + ivSpDefense) * cpMultiplier),
            speed: Math.floor((baseSpeed + ivSpeed) * cpMultiplier),
            ivHp, ivAttack, ivDefense, ivSpAttack, ivSpDefense, ivSpeed
        };
        
        stats.cp = Math.max(10, Math.floor(
            (stats.attack * Math.sqrt(stats.defense) * Math.sqrt(stats.totalHp) * Math.pow(cpMultiplier, 2)) / 10
        ));
        
        return stats;
    }

    /**
     * 计算进化预览
     */
    async calculateEvolutionPreview(pokemon, evolutionPath) {
        const targetSpecies = {
            id: evolutionPath.to_species_id,
            name: evolutionPath.to_species_name,
            image_url: evolutionPath.to_image_url,
            types: evolutionPath.to_types,
            rarity: evolutionPath.to_rarity,
            base_hp: evolutionPath.to_base_hp,
            base_attack: evolutionPath.to_base_attack,
            base_defense: evolutionPath.to_base_defense,
            base_sp_attack: evolutionPath.to_base_sp_attack,
            base_sp_defense: evolutionPath.to_base_sp_defense,
            base_speed: evolutionPath.to_base_speed
        };
        
        const newStats = this.calculatePostEvolutionStats(pokemon, targetSpecies);
        
        const currentStats = {
            hp: pokemon.total_hp || 0,
            attack: pokemon.attack || 0,
            defense: pokemon.defense || 0,
            spAttack: pokemon.sp_attack || 0,
            spDefense: pokemon.sp_defense || 0,
            speed: pokemon.speed || 0,
            cp: pokemon.cp || 0
        };
        
        return {
            targetSpecies: {
                id: targetSpecies.id,
                name: targetSpecies.name,
                imageUrl: targetSpecies.image_url,
                types: targetSpecies.types,
                rarity: targetSpecies.rarity
            },
            currentStats,
            newStats,
            statsChange: {
                hp: newStats.totalHp - currentStats.hp,
                attack: newStats.attack - currentStats.attack,
                defense: newStats.defense - currentStats.defense,
                spAttack: newStats.spAttack - currentStats.spAttack,
                spDefense: newStats.spDefense - currentStats.spDefense,
                speed: newStats.speed - currentStats.speed,
                cp: newStats.cp - currentStats.cp
            },
            evolutionType: evolutionPath.evolution_type
        };
    }

    /**
     * 推荐进化路径
     */
    recommendEvolution(availableEvolutions, pokemon) {
        if (availableEvolutions.length === 0) return null;
        if (availableEvolutions.length === 1) {
            return { recommended: availableEvolutions[0], reason: 'ONLY_ONE_PATH' };
        }
        
        const sorted = [...availableEvolutions].sort((a, b) => {
            const cpGainA = a.preview?.statsChange?.cp || 0;
            const cpGainB = b.preview?.statsChange?.cp || 0;
            
            if (Math.abs(cpGainA - cpGainB) < 50) {
                const rarityOrder = { 'legendary': 3, 'mythical': 2, 'rare': 1, 'common': 0 };
                const rarityA = rarityOrder[a.to_rarity] || 0;
                const rarityB = rarityOrder[b.to_rarity] || 0;
                return rarityB - rarityA;
            }
            
            return cpGainB - cpGainA;
        });
        
        return {
            recommended: sorted[0],
            reason: 'OPTIMAL_CP_AND_RARITY',
            alternatives: sorted.slice(1, 3)
        };
    }

    /**
     * 执行进化
     */
    async performEvolution(pokemonInstanceId, userId, targetSpeciesId, options = {}) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 获取精灵和进化规则（加锁）
            const pokemonResult = await client.query(`
                SELECT pi.*, ps.base_hp, ps.base_attack, ps.base_defense,
                       ps.base_sp_attack, ps.base_sp_defense, ps.base_speed, 
                       ps.growth_rate, ps.name as species_name
                FROM pokemon_instances pi
                JOIN pokemon_species ps ON pi.species_id = ps.id
                WHERE pi.id = $1 AND pi.user_id = $2
                FOR UPDATE
            `, [pokemonInstanceId, userId]);
            
            if (pokemonResult.rows.length === 0) {
                throw new Error('POKEMON_NOT_FOUND');
            }
            
            const pokemon = pokemonResult.rows[0];
            
            // 获取进化规则
            const evolutionRule = await client.query(`
                SELECT er.*, ei.name as item_name
                FROM evolution_rules er
                LEFT JOIN evolution_items ei ON er.required_item_id = ei.id
                WHERE er.from_species_id = $1 AND er.to_species_id = $2 AND er.is_active = true
            `, [pokemon.species_id, targetSpeciesId]);
            
            if (evolutionRule.rows.length === 0) {
                throw new Error('INVALID_EVOLUTION_PATH');
            }
            
            const rule = evolutionRule.rows[0];
            
            // 再次检查条件（防止并发问题）
            const checkResult = await this.checkEvolutionConditions(pokemon, rule, userId);
            if (!checkResult.canEvolve) {
                throw new Error('EVOLUTION_CONDITIONS_NOT_MET');
            }
            
            // 获取目标物种信息
            const targetSpecies = await client.query(
                'SELECT * FROM pokemon_species WHERE id = $1',
                [targetSpeciesId]
            );
            
            if (targetSpecies.rows.length === 0) {
                throw new Error('TARGET_SPECIES_NOT_FOUND');
            }
            
            const target = targetSpecies.rows[0];
            
            // 保存进化前属性快照
            const beforeStats = {
                speciesId: pokemon.species_id,
                speciesName: pokemon.species_name,
                cp: pokemon.cp || 0,
                level: pokemon.level || 1,
                hp: pokemon.total_hp || 0,
                attack: pokemon.attack || 0,
                defense: pokemon.defense || 0,
                spAttack: pokemon.sp_attack || 0,
                spDefense: pokemon.sp_defense || 0,
                speed: pokemon.speed || 0
            };
            
            // 计算进化后属性
            const newStats = this.calculatePostEvolutionStats(pokemon, target);
            
            // 更新精灵实例
            await client.query(`
                UPDATE pokemon_instances SET
                    species_id = $1,
                    cp = $2,
                    total_hp = $3,
                    current_hp = LEAST(COALESCE(current_hp, $3) + $3 - COALESCE($4, 0), $3),
                    attack = $5,
                    defense = $6,
                    sp_attack = $7,
                    sp_defense = $8,
                    speed = $9,
                    updated_at = NOW()
                WHERE id = $10
            `, [
                targetSpeciesId, newStats.cp, newStats.totalHp,
                beforeStats.hp,
                newStats.attack, newStats.defense,
                newStats.spAttack, newStats.spDefense, newStats.speed,
                pokemonInstanceId
            ]);
            
            // 消耗道具（如果是道具进化）
            if (rule.required_item_id && rule.item_consumed !== false) {
                const consumeResult = await client.query(`
                    UPDATE user_items SET quantity = quantity - 1
                    WHERE user_id = $1 AND item_id = $2 AND quantity > 0
                    RETURNING quantity
                `, [userId, rule.required_item_id]);
                
                if (consumeResult.rows.length === 0) {
                    throw new Error('INSUFFICIENT_ITEMS');
                }
            }
            
            // 记录进化历史
            await client.query(`
                INSERT INTO evolution_history (
                    user_id, pokemon_instance_id, from_species_id, to_species_id,
                    evolution_type, used_item_id, before_cp, before_level, before_stats,
                    after_cp, after_level, after_stats
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
                userId, pokemonInstanceId, pokemon.species_id, targetSpeciesId,
                rule.evolution_type, rule.required_item_id,
                beforeStats.cp, beforeStats.level, JSON.stringify(beforeStats),
                newStats.cp, beforeStats.level, JSON.stringify(newStats)
            ]);
            
            // 更新图鉴
            await client.query(`
                INSERT INTO pokedex_entries (user_id, species_id, seen, caught, caught_count)
                VALUES ($1, $2, true, true, 1)
                ON CONFLICT (user_id, species_id) DO UPDATE SET
                    caught = true,
                    caught_count = pokedex_entries.caught_count + 1,
                    updated_at = NOW()
            `, [userId, targetSpeciesId]);
            
            // 给予进化奖励
            const rewards = {
                stardust: 500,
                candy: 1,
                experience: 1000
            };
            
            await client.query(`
                UPDATE users SET
                    stardust = COALESCE(stardust, 0) + $1,
                    experience = COALESCE(experience, 0) + $3
                WHERE id = $2
            `, [rewards.stardust, userId, rewards.experience]);
            
            await client.query('COMMIT');
            
            // 记录 Prometheus 指标
            this.metrics.evolutionCounter.inc({ 
                evolution_type: rule.evolution_type,
                species: target.name 
            });
            
            logger.info('Evolution completed', {
                userId,
                pokemonInstanceId,
                fromSpecies: pokemon.species_id,
                toSpecies: targetSpeciesId,
                evolutionType: rule.evolution_type
            });
            
            // 清除缓存
            await this.redis.del(`pokemon:${pokemonInstanceId}`);
            
            return {
                success: true,
                evolution: {
                    pokemonId: pokemonInstanceId,
                    fromSpecies: {
                        id: pokemon.species_id,
                        name: pokemon.species_name
                    },
                    toSpecies: {
                        id: targetSpeciesId,
                        name: target.name,
                        imageUrl: target.image_url,
                        types: target.types
                    },
                    beforeStats,
                    afterStats: newStats,
                    statsChange: {
                        hp: newStats.totalHp - beforeStats.hp,
                        attack: newStats.attack - beforeStats.attack,
                        defense: newStats.defense - beforeStats.defense,
                        spAttack: newStats.spAttack - beforeStats.spAttack,
                        spDefense: newStats.spDefense - beforeStats.spDefense,
                        speed: newStats.speed - beforeStats.speed,
                        cp: newStats.cp - beforeStats.cp
                    },
                    animation: this.evolutionAnimations[rule.evolution_animation] || this.evolutionAnimations.standard,
                    evolutionType: rule.evolution_type
                },
                rewards
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Evolution failed', { 
                error: error.message, 
                pokemonInstanceId, 
                userId,
                targetSpeciesId 
            });
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 根据经验值计算当前等级
     */
    calculateLevelFromExp(experience, growthRate) {
        const table = this.experienceTable[growthRate] || this.experienceTable.medium_fast;

        for (let level = 100; level >= 1; level--) {
            if (experience >= table[level - 1]) {
                return level;
            }
        }

        return 1;
    }

    /**
     * 获取当前等级所需经验值
     */
    getExpForLevel(level, growthRate) {
        const table = this.experienceTable[growthRate] || this.experienceTable.medium_fast;
        return table[level - 1] || 0;
    }

    /**
     * 添加经验值
     */
    async addExperience(pokemonInstanceId, userId, amount, source, options = {}) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 获取精灵信息（加锁）
            const pokemonResult = await client.query(`
                SELECT pi.*, ps.growth_rate, ps.name as species_name, u.level as trainer_level
                FROM pokemon_instances pi
                JOIN pokemon_species ps ON pi.species_id = ps.id
                JOIN users u ON pi.user_id = u.id
                WHERE pi.id = $1 AND pi.user_id = $2
                FOR UPDATE
            `, [pokemonInstanceId, userId]);
            
            if (pokemonResult.rows.length === 0) {
                throw new Error('POKEMON_NOT_FOUND');
            }
            
            const pokemon = pokemonResult.rows[0];
            const trainerLevel = pokemon.trainer_level || 1;
            const maxPokemonLevel = Math.floor(trainerLevel + 1.5);
            
            // 应用经验值加成
            const bonusMultiplier = options.bonusMultiplier || 1.0;
            const actualAmount = Math.floor(amount * bonusMultiplier);
            
            const oldLevel = pokemon.level || 1;
            const oldExperience = pokemon.experience || 0;
            
            // 计算新经验值
            let newExperience = oldExperience + actualAmount;
            
            // 计算新等级
            let newLevel = this.calculateLevelFromExp(newExperience, pokemon.growth_rate || 'medium_fast');
            
            // 检查是否超过训练师等级限制
            const levelCapped = newLevel > maxPokemonLevel;
            if (levelCapped) {
                newLevel = maxPokemonLevel;
                // 经验值不超过当前等级上限
                const maxExp = this.getExpForLevel(maxPokemonLevel, pokemon.growth_rate || 'medium_fast');
                newExperience = Math.min(newExperience, maxExp);
            }
            
            // 更新精灵
            await client.query(`
                UPDATE pokemon_instances SET
                    experience = $1,
                    level = $2,
                    updated_at = NOW()
                WHERE id = $3
            `, [newExperience, newLevel, pokemonInstanceId]);
            
            // 记录经验日志
            await client.query(`
                INSERT INTO experience_logs (
                    pokemon_instance_id, user_id, source, base_amount,
                    bonus_multiplier, final_amount, before_exp, after_exp, before_level, after_level
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                pokemonInstanceId, userId, source, amount, bonusMultiplier,
                actualAmount, oldExperience, newExperience, oldLevel, newLevel
            ]);
            
            // 如果升级了，重新计算属性
            const levelUp = newLevel > oldLevel;
            if (levelUp) {
                const speciesResult = await client.query(
                    'SELECT * FROM pokemon_species WHERE id = $1',
                    [pokemon.species_id]
                );
                
                if (speciesResult.rows.length > 0) {
                    const species = speciesResult.rows[0];
                    const newStats = this.calculatePostEvolutionStats(
                        { ...pokemon, level: newLevel }, 
                        species
                    );
                    
                    await client.query(`
                        UPDATE pokemon_instances SET
                            cp = $1, total_hp = $2, current_hp = LEAST(current_hp + $2 - $3, $2),
                            attack = $4, defense = $5, sp_attack = $6, sp_defense = $7, speed = $8
                        WHERE id = $9
                    `, [
                        newStats.cp, newStats.totalHp, pokemon.total_hp || 0,
                        newStats.attack, newStats.defense, newStats.spAttack, newStats.spDefense, newStats.speed,
                        pokemonInstanceId
                    ]);
                    
                    // 记录升级
                    this.metrics.levelUps.inc({ species: pokemon.species_name });
                }
            }
            
            await client.query('COMMIT');
            
            // Prometheus 指标
            this.metrics.experienceGained.inc({ source }, actualAmount);
            
            // 清除缓存
            await this.redis.del(`pokemon:${pokemonInstanceId}`);
            
            return {
                success: true,
                pokemonId: pokemonInstanceId,
                oldLevel,
                newLevel,
                levelUp,
                levelCapped,
                oldExperience,
                newExperience,
                gainedExp: actualAmount,
                source,
                bonusMultiplier
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 增加亲密度
     */
    async addFriendship(pokemonInstanceId, userId, changeType, amount = 1) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 获取精灵信息
            const pokemonResult = await client.query(`
                SELECT pi.*, ps.name as species_name
                FROM pokemon_instances pi
                JOIN pokemon_species ps ON pi.species_id = ps.id
                WHERE pi.id = $1 AND pi.user_id = $2
                FOR UPDATE
            `, [pokemonInstanceId, userId]);
            
            if (pokemonResult.rows.length === 0) {
                throw new Error('POKEMON_NOT_FOUND');
            }
            
            const pokemon = pokemonResult.rows[0];
            const oldFriendship = pokemon.friendship || 70;
            
            // 根据类型计算亲密度变化
            let change = 0;
            const changes = {
                walk: 1,           // 行走 1km
                battle: 2,         // 战斗
                gym: 2,            // 道馆训练
                candy: 3,          // 喂食糖果
                berry: 1,          // 喂食树果
                spa: 5,            // 温泉/按摩
                level: 3           // 升级
            };
            
            change = (changes[changeType] || 1) * amount;
            
            // 检查亲密度上限
            const newFriendship = Math.min(255, Math.max(0, oldFriendship + change));
            
            // 更新精灵
            await client.query(`
                UPDATE pokemon_instances SET
                    friendship = $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [newFriendship, pokemonInstanceId]);
            
            // 记录亲密度日志
            await client.query(`
                INSERT INTO friendship_logs (
                    pokemon_instance_id, user_id, change_type, change_amount, before_friendship, after_friendship
                ) VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                pokemonInstanceId, userId, changeType, change, oldFriendship, newFriendship
            ]);
            
            await client.query('COMMIT');
            
            // 清除缓存
            await this.redis.del(`pokemon:${pokemonInstanceId}`);
            
            return {
                success: true,
                pokemonId: pokemonInstanceId,
                oldFriendship,
                newFriendship,
                change,
                changeType,
                // 检查是否达到进化亲密度
                canEvolve: newFriendship >= 220
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = { EvolutionService };
