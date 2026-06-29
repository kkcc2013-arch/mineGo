/**
 * 精灵详情批量查询 API
 * REQ-00145: 精灵详情批量查询优化
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { getClient } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const logger = require('../../../../shared/logger');
const { requireAuth } = require('../../../../shared/auth');
const { incrementCounter, observeHistogram } = require('../../../../shared/metrics');

// 验证模式
const batchQuerySchema = Joi.object({
    ids: Joi.array().items(Joi.string().uuid()).min(1).max(100).required(),
    options: Joi.object({
        include_moves: Joi.boolean().default(true),
        include_evolution: Joi.boolean().default(true),
        include_stats: Joi.boolean().default(true),
        include_display_config: Joi.boolean().default(false)
    }).default({})
});

// Prometheus 指标
const batchQueryDuration = observeHistogram('pokemon_batch_query_duration_seconds', 'Batch query duration', [0.01, 0.05, 0.1, 0.2, 0.5, 1]);
const batchQuerySize = incrementCounter('pokemon_batch_query_size_total', 'Batch query size');

/**
 * 批量查询精灵详情
 * POST /pokemon/batch/details
 */
router.post('/details', requireAuth, async (req, res) => {
    const startTime = Date.now();

    try {
        // 验证输入
        const { error, value } = batchQuerySchema.validate(req.body);
        if (error) {
            return res.status(400).json({ 
                code: 400, 
                error: error.details[0].message 
            });
        }

        const { ids, options } = value;
        const userId = req.user.id;

        // 记录批量查询大小
        batchQuerySize.observe(ids.length);

        // 检查 Redis 缓存
        const cacheResults = await _batchGetFromCache(ids);
        const cachedDetails = cacheResults.filter(r => r !== null);
        const missedIds = ids.filter((id, index) => cacheResults[index] === null);

        logger.info('Batch query cache stats', {
            userId,
            totalIds: ids.length,
            cached: cachedDetails.length,
            missed: missedIds.length
        });

        // 从数据库查询未命中的
        let dbResults = [];
        if (missedIds.length > 0) {
            dbResults = await _batchQueryFromDB(missedIds, userId, options);
            
            // 写入缓存
            await _batchSetToCache(dbResults);
        }

        // 合并结果
        const allResults = [...cachedDetails, ...dbResults];
        const resultById = new Map(allResults.map(p => [p.id, p]));

        // 按请求顺序返回
        const orderedResults = ids.map(id => resultById.get(id)).filter(Boolean);
        const notFoundIds = ids.filter(id => !resultById.has(id));

        // 记录查询时间
        const queryTime = Date.now() - startTime;
        batchQueryDuration.observe(queryTime / 1000);

        logger.info('Batch query completed', {
            userId,
            totalIds: ids.length,
            found: orderedResults.length,
            notFound: notFoundIds.length,
            queryTime
        });

        res.json({
            code: 0,
            data: {
                results: orderedResults,
                not_found: notFoundIds,
                total: orderedResults.length,
                query_time_ms: queryTime,
                cache_hit_rate: ((cachedDetails.length / ids.length) * 100).toFixed(2) + '%'
            }
        });

    } catch (error) {
        logger.error('Batch query error', { error: error.message, stack: error.stack });
        res.status(500).json({ 
            code: 500, 
            error: 'Internal server error' 
        });
    }
});

/**
 * 从缓存批量读取
 */
async function _batchGetFromCache(ids) {
    try {
        const redis = getRedis();
        const cacheKeys = ids.map(id => `pokemon:detail:${id}`);
        const cached = await redis.mget(...cacheKeys);
        
        return cached.map(item => {
            if (item) {
                try {
                    return JSON.parse(item);
                } catch (e) {
                    return null;
                }
            }
            return null;
        });
    } catch (error) {
        logger.error('Batch cache get error', { error: error.message });
        return ids.map(() => null);
    }
}

/**
 * 从数据库批量查询
 */
async function _batchQueryFromDB(ids, userId, options) {
    const client = await getClient();

    try {
        // 批量查询精灵实例
        const pokemonResult = await client.query(
            `SELECT 
                pi.id,
                pi.user_id,
                pi.species_id,
                pi.nickname,
                pi.level,
                pi.experience,
                pi.cp,
                pi.hp,
                pi.max_hp,
                pi.iv_attack,
                pi.iv_defense,
                pi.iv_stamina,
                pi.iv_hp,
                pi.shiny,
                pi.gender,
                pi.friendship,
                pi.nature,
                pi.ability_id,
                pi.created_at,
                ps.name as species_name,
                ps.name_zh,
                ps.name_en,
                ps.type1,
                ps.type2,
                ps.sprite_url,
                ps.base_attack,
                ps.base_defense,
                ps.base_stamina,
                ps.base_hp
            FROM pokemon_instances pi
            JOIN pokemon_species ps ON ps.id = pi.species_id
            WHERE pi.id = ANY($1) AND pi.user_id = $2`,
            [ids, userId]
        );

        if (pokemonResult.rows.length === 0) {
            return [];
        }

        const pokemons = pokemonResult.rows;
        const pokemonIds = pokemons.map(p => p.id);

        // 并行加载关联数据
        const [moves, evolutions, displayConfigs] = await Promise.all([
            options.include_moves ? _batchLoadMoves(client, pokemonIds) : Promise.resolve(new Map()),
            options.include_evolution ? _batchLoadEvolutions(client, pokemons.map(p => p.species_id)) : Promise.resolve(new Map()),
            options.include_display_config ? _batchLoadDisplayConfigs(client, pokemonIds) : Promise.resolve(new Map())
        ]);

        // 组装完整数据
        return pokemons.map(pokemon => {
            const result = {
                id: pokemon.id,
                user_id: pokemon.user_id,
                species_id: pokemon.species_id,
                species_name: pokemon.species_name,
                species_name_zh: pokemon.name_zh,
                species_name_en: pokemon.name_en,
                types: [pokemon.type1, pokemon.type2].filter(Boolean),
                sprite_url: pokemon.sprite_url,
                nickname: pokemon.nickname,
                level: pokemon.level,
                experience: pokemon.experience,
                cp: pokemon.cp,
                hp: pokemon.hp,
                max_hp: pokemon.max_hp,
                shiny: pokemon.shiny,
                gender: pokemon.gender,
                friendship: pokemon.friendship,
                nature: pokemon.nature,
                ability_id: pokemon.ability_id,
                created_at: pokemon.created_at
            };

            // IV 数据
            if (options.include_stats) {
                result.iv = {
                    attack: pokemon.iv_attack,
                    defense: pokemon.iv_defense,
                    stamina: pokemon.iv_stamina,
                    hp: pokemon.iv_hp,
                    total: (pokemon.iv_attack || 0) + (pokemon.iv_defense || 0) + (pokemon.iv_stamina || 0) + (pokemon.iv_hp || 0)
                };

                result.base_stats = {
                    attack: pokemon.base_attack,
                    defense: pokemon.base_defense,
                    stamina: pokemon.base_stamina,
                    hp: pokemon.base_hp
                };
            }

            // 技能数据
            if (options.include_moves) {
                result.moves = moves.get(pokemon.id) || { fast: [], charge: [] };
            }

            // 进化数据
            if (options.include_evolution) {
                result.evolution = evolutions.get(pokemon.species_id) || null;
            }

            // 展示配置
            if (options.include_display_config) {
                result.display_config = displayConfigs.get(pokemon.id) || null;
            }

            return result;
        });

    } finally {
        client.release();
    }
}

/**
 * 批量加载技能
 */
async function _batchLoadMoves(client, pokemonIds) {
    const result = await client.query(
        `SELECT 
            pm.pokemon_instance_id,
            pm.move_id,
            pm.move_type,
            pm.is_selected,
            m.name as move_name,
            m.name_zh,
            m.type,
            m.power,
            m.energy_cost,
            m.duration_ms
        FROM pokemon_moves pm
        JOIN moves m ON m.id = pm.move_id
        WHERE pm.pokemon_instance_id = ANY($1)`,
        [pokemonIds]
    );

    const movesByPokemon = new Map();

    for (const row of result.rows) {
        if (!movesByPokemon.has(row.pokemon_instance_id)) {
            movesByPokemon.set(row.pokemon_instance_id, { fast: [], charge: [] });
        }

        const move = {
            id: row.move_id,
            name: row.move_name,
            name_zh: row.name_zh,
            type: row.type,
            power: row.power,
            energy_cost: row.energy_cost,
            duration_ms: row.duration_ms,
            is_selected: row.is_selected
        };

        if (row.move_type === 'fast') {
            movesByPokemon.get(row.pokemon_instance_id).fast.push(move);
        } else {
            movesByPokemon.get(row.pokemon_instance_id).charge.push(move);
        }
    }

    return movesByPokemon;
}

/**
 * 批量加载进化信息
 */
async function _batchLoadEvolutions(client, speciesIds) {
    const result = await client.query(
        `SELECT 
            id as species_id,
            evolves_to,
            candy_to_evolve,
            evolution_item_required
        FROM pokemon_species
        WHERE id = ANY($1)`,
        [speciesIds]
    );

    const evolutionMap = new Map();

    for (const row of result.rows) {
        if (row.evolves_to) {
            evolutionMap.set(row.species_id, {
                can_evolve: true,
                evolves_to: row.evolves_to,
                candy_cost: row.candy_to_evolve,
                item_required: row.evolution_item_required
            });
        } else {
            evolutionMap.set(row.species_id, {
                can_evolve: false
            });
        }
    }

    return evolutionMap;
}

/**
 * 批量加载展示配置
 */
async function _batchLoadDisplayConfigs(client, pokemonIds) {
    const result = await client.query(
        `SELECT 
            pokemon_id,
            is_favorite,
            show_in_profile,
            custom_pose,
            background_color
        FROM pokemon_display_configs
        WHERE pokemon_id = ANY($1)`,
        [pokemonIds]
    );

    const configMap = new Map();
    for (const row of result.rows) {
        configMap.set(row.pokemon_id, row);
    }

    return configMap;
}

/**
 * 批量写入缓存
 */
async function _batchSetToCache(pokemons) {
    try {
        const redis = getRedis();
        const ttl = 300; // 5 分钟

        const cacheData = [];
        for (const pokemon of pokemons) {
            cacheData.push(`pokemon:detail:${pokemon.id}`);
            cacheData.push(JSON.stringify(pokemon));
        }

        // 使用 mset 批量写入
        if (cacheData.length > 0) {
            await redis.mset(...cacheData);
            
            // 设置过期时间（需要单独设置）
            const pipeline = redis.pipeline();
            for (let i = 0; i < cacheData.length; i += 2) {
                pipeline.expire(cacheData[i], ttl);
            }
            await pipeline.exec();
        }
    } catch (error) {
        logger.error('Batch cache set error', { error: error.message });
    }
}

module.exports = router;
