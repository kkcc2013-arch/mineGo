/**
 * 精灵批量查询 SDK
 * REQ-00145: 精灵详情批量查询优化
 */

/**
 * 批量查询精灵详情
 * @param {Array<string>} ids - 精灵 ID 数组（最多 100 个）
 * @param {Object} options - 查询选项
 * @param {boolean} options.include_moves - 包含技能数据
 * @param {boolean} options.include_evolution - 包含进化数据
 * @param {boolean} options.include_stats - 包含基础属性和 IV
 * @param {boolean} options.include_display_config - 包含展示配置
 * @returns {Promise<Array>} 精灵详情数组
 */
export async function batchGetPokemonDetails(ids, options = {}) {
    if (!ids || ids.length === 0) {
        return { results: [], not_found: [], total: 0 };
    }

    // 验证 ID 数量
    if (ids.length > 100) {
        throw new Error('Batch query limit exceeded: maximum 100 IDs per request');
    }

    try {
        const response = await fetch('/pokemon/batch/details', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                ids: ids,
                options: {
                    include_moves: options.include_moves !== false,
                    include_evolution: options.include_evolution !== false,
                    include_stats: options.include_stats !== false,
                    include_display_config: options.include_display_config || false
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Batch query failed: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.code !== 0) {
            throw new Error(data.error || 'Unknown error');
        }

        return data.data;

    } catch (error) {
        console.error('Batch query error:', error);
        throw error;
    }
}

/**
 * 分块批量查询（支持超过 100 个 ID）
 * @param {Array<string>} ids - 精灵 ID 数组
 * @param {Object} options - 查询选项
 * @param {number} chunkSize - 每块大小（默认 50）
 * @returns {Promise<Array>} 精灵详情数组
 */
export async function batchGetPokemonDetailsChunked(ids, options = {}, chunkSize = 50) {
    if (!ids || ids.length === 0) {
        return [];
    }

    // 分块
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        chunks.push(ids.slice(i, i + chunkSize));
    }

    // 并行查询
    const results = await Promise.all(
        chunks.map(chunk => batchGetPokemonDetails(chunk, options))
    );

    // 合并结果
    return results.flatMap(r => r.results);
}

/**
 * 带缓存的批量查询
 * 本地缓存 5 分钟，减少重复请求
 */
const localCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

export async function batchGetPokemonDetailsWithCache(ids, options = {}) {
    const now = Date.now();
    const results = [];
    const missedIds = [];

    // 检查本地缓存
    for (const id of ids) {
        const cached = localCache.get(id);
        if (cached && now - cached.timestamp < CACHE_TTL) {
            results.push(cached.data);
        } else {
            missedIds.push(id);
        }
    }

    // 查询未命中的
    if (missedIds.length > 0) {
        const freshData = await batchGetPokemonDetailsChunked(missedIds, options);

        // 更新缓存
        for (const pokemon of freshData) {
            localCache.set(pokemon.id, {
                data: pokemon,
                timestamp: now
            });
        }

        results.push(...freshData);
    }

    // 清理过期缓存
    for (const [id, cached] of localCache.entries()) {
        if (now - cached.timestamp > CACHE_TTL) {
            localCache.delete(id);
        }
    }

    return results;
}

/**
 * 批量查询精灵列表页详情
 * 优化精灵列表页加载性能
 */
export async function loadPokemonListDetails(pokemonIds) {
    return batchGetPokemonDetailsWithCache(pokemonIds, {
        include_moves: false, // 列表页不需要技能
        include_evolution: true,
        include_stats: true,
        include_display_config: true
    });
}

/**
 * 批量查询战斗准备详情
 * 包含完整技能和属性信息
 */
export async function loadBattlePreparationDetails(pokemonIds) {
    return batchGetPokemonDetailsWithCache(pokemonIds, {
        include_moves: true,
        include_evolution: false,
        include_stats: true,
        include_display_config: false
    });
}

/**
 * 批量查询交换确认详情
 */
export async function loadTradeConfirmationDetails(pokemonIds) {
    return batchGetPokemonDetailsWithCache(pokemonIds, {
        include_moves: true,
        include_evolution: true,
        include_stats: true,
        include_display_config: true
    });
}

// 清除本地缓存
export function clearPokemonDetailsCache() {
    localCache.clear();
}

// 导出默认函数
export default batchGetPokemonDetails;
