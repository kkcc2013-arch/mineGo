# REQ-00355: 精灵进化路径可视化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00355 |
| 标题 | 精灵进化路径可视化系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 04:00 UTC |

## 需求描述

为精灵图鉴和详情页增加进化路径可视化功能，让玩家能够直观地查看精灵的完整进化链、分支进化路径、进化条件、进化后属性预览等信息。该系统需支持多种进化类型（等级进化、道具进化、亲密度进化、时间进化、地点进化、交换进化等），并以交互式树状图形式展示。

### 核心功能

1. **进化树可视化**：以图形化树状结构展示精灵的所有可能进化路径
2. **进化条件显示**：清晰展示每条进化路径所需的具体条件
3. **属性对比预览**：进化前后属性对比，帮助玩家决策
4. **反向追溯**：查看精灵的进化前身和退化路径
5. **特殊进化提示**：标记隐藏进化路径和彩蛋进化条件

## 技术方案

### 1. 数据库设计

```sql
-- 进化链定义表
CREATE TABLE evolution_chains (
    id SERIAL PRIMARY KEY,
    chain_name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 进化节点表（每个精灵作为节点）
CREATE TABLE evolution_nodes (
    id SERIAL PRIMARY KEY,
    chain_id INTEGER REFERENCES evolution_chains(id),
    pokemon_species_id INTEGER NOT NULL,
    node_position JSONB, -- {x: 0, y: 0, level: 1}
    is_root BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 进化路径表（节点之间的连接）
CREATE TABLE evolution_paths (
    id SERIAL PRIMARY KEY,
    from_node_id INTEGER REFERENCES evolution_nodes(id),
    to_node_id INTEGER REFERENCES evolution_nodes(id),
    evolution_type VARCHAR(50) NOT NULL, -- 'level', 'item', 'friendship', 'time', 'location', 'trade', 'special'
    
    -- 进化条件
    conditions JSONB NOT NULL DEFAULT '{}',
    /*
    示例：
    {
        "min_level": 16,
        "item_id": 123,
        "min_friendship": 220,
        "time_range": ["day", "night"],
        "location_ids": [1, 2, 3],
        "held_item_id": 456,
        "trade_required": false,
        "special_conditions": ["know_move_123", "gender_male"],
        "probability": 1.0
    }
    */
    
    -- 进化后属性变化预览
    stat_changes JSONB DEFAULT '{}',
    /*
    示例：
    {
        "hp": 10,
        "attack": 5,
        "defense": 3,
        "speed": 8,
        "types_added": ["flying"],
        "types_removed": [],
        "abilities": ["new_ability_1", "new_ability_2"]
    }
    */
    
    is_hidden BOOLEAN DEFAULT FALSE, -- 隐藏进化路径
    created_at TIMESTAMP DEFAULT NOW()
);

-- 进化条件说明多语言表
CREATE TABLE evolution_condition_descriptions (
    id SERIAL PRIMARY KEY,
    evolution_path_id INTEGER REFERENCES evolution_paths(id),
    language_code VARCHAR(10) NOT NULL,
    description TEXT NOT NULL,
    hint TEXT, -- 提示文本
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(evolution_path_id, language_code)
);

-- 索引
CREATE INDEX idx_evolution_nodes_species ON evolution_nodes(pokemon_species_id);
CREATE INDEX idx_evolution_nodes_chain ON evolution_nodes(chain_id);
CREATE INDEX idx_evolution_paths_from ON evolution_paths(from_node_id);
CREATE INDEX idx_evolution_paths_to ON evolution_paths(to_node_id);
CREATE INDEX idx_evolution_paths_type ON evolution_paths(evolution_type);
```

### 2. 后端服务实现

```javascript
// backend/services/pokemon-service/src/handlers/evolutionHandler.js

const EvolutionHandler = {
    /**
     * 获取精灵进化链
     */
    async getEvolutionChain(req, res) {
        const { speciesId } = req.params;
        
        // 查找精灵所属的进化链
        const node = await db.queryOne(`
            SELECT en.*, ec.chain_name, ec.description
            FROM evolution_nodes en
            JOIN evolution_chains ec ON en.chain_id = ec.id
            WHERE en.pokemon_species_id = $1
        `, [speciesId]);
        
        if (!node) {
            return res.json({
                hasEvolution: false,
                message: '该精灵没有进化路径'
            });
        }
        
        // 获取进化链所有节点和路径
        const [nodes, paths] = await Promise.all([
            db.query(`
                SELECT en.*, ps.name, ps.types, ps.base_stats
                FROM evolution_nodes en
                JOIN pokemon_species ps ON en.pokemon_species_id = ps.id
                WHERE en.chain_id = $1
                ORDER BY en.node_position->>'level', en.id
            `, [node.chain_id]),
            db.query(`
                SELECT ep.*, 
                       fn.pokemon_species_id as from_species,
                       tn.pokemon_species_id as to_species
                FROM evolution_paths ep
                JOIN evolution_nodes fn ON ep.from_node_id = fn.id
                JOIN evolution_nodes tn ON ep.to_node_id = tn.id
                WHERE fn.chain_id = $1
            `, [node.chain_id])
        ]);
        
        // 构建进化树结构
        const evolutionTree = buildEvolutionTree(nodes, paths);
        
        res.json({
            chainId: node.chain_id,
            chainName: node.chain_name,
            currentNode: node.pokemon_species_id,
            tree: evolutionTree,
            nodes: nodes,
            paths: paths.map(p => ({
                ...p,
                conditions: formatConditions(p.conditions, p.evolution_type),
                isAvailable: checkEvolutionAvailability(p.conditions, req.user)
            }))
        });
    },
    
    /**
     * 获取进化预览（属性对比）
     */
    async getEvolutionPreview(req, res) {
        const { pokemonId, targetSpeciesId } = req.params;
        
        // 获取当前精灵数据
        const currentPokemon = await db.queryOne(`
            SELECT p.*, ps.name, ps.types, ps.base_stats
            FROM pokemons p
            JOIN pokemon_species ps ON p.species_id = ps.id
            WHERE p.id = $1 AND p.user_id = $2
        `, [pokemonId, req.user.id]);
        
        if (!currentPokemon) {
            return res.status(404).json({ error: '精灵不存在' });
        }
        
        // 获取进化路径信息
        const evolutionPath = await db.queryOne(`
            SELECT ep.*, tn.pokemon_species_id as to_species
            FROM evolution_paths ep
            JOIN evolution_nodes fn ON ep.from_node_id = fn.id
            JOIN evolution_nodes tn ON ep.to_node_id = tn.id
            WHERE fn.pokemon_species_id = $1 
            AND tn.pokemon_species_id = $2
        `, [currentPokemon.species_id, targetSpeciesId]);
        
        if (!evolutionPath) {
            return res.status(400).json({ error: '无效的进化路径' });
        }
        
        // 获取目标精灵基础属性
        const targetSpecies = await db.queryOne(`
            SELECT * FROM pokemon_species WHERE id = $1
        `, [targetSpeciesId]);
        
        // 计算进化后属性预览
        const previewStats = calculateEvolvedStats(
            currentPokemon,
            targetSpecies,
            evolutionPath.stat_changes
        );
        
        // 属性对比
        const comparison = {
            current: {
                name: currentPokemon.name,
                types: currentPokemon.types,
                stats: currentPokemon.base_stats,
                abilities: currentPokemon.abilities
            },
            evolved: {
                name: targetSpecies.name,
                types: targetSpecies.types,
                stats: previewStats,
                abilities: evolutionPath.stat_changes.abilities || targetSpecies.abilities
            },
            changes: evolutionPath.stat_changes,
            conditions: formatConditions(evolutionPath.conditions, evolutionPath.evolution_type),
            canEvolve: checkEvolutionReady(currentPokemon, evolutionPath.conditions)
        };
        
        res.json(comparison);
    },
    
    /**
     * 执行进化
     */
    async evolve(req, res) {
        const { pokemonId, targetSpeciesId } = req.body;
        
        const client = await db.beginTransaction();
        try {
            // 验证精灵所有权
            const pokemon = await client.queryOne(`
                SELECT * FROM pokemons WHERE id = $1 AND user_id = $2 FOR UPDATE
            `, [pokemonId, req.user.id]);
            
            if (!pokemon) {
                throw new Error('精灵不存在');
            }
            
            // 验证进化条件
            const evolutionPath = await client.queryOne(`
                SELECT ep.*
                FROM evolution_paths ep
                JOIN evolution_nodes fn ON ep.from_node_id = fn.id
                JOIN evolution_nodes tn ON ep.to_node_id = tn.id
                WHERE fn.pokemon_species_id = $1 
                AND tn.pokemon_species_id = $2
            `, [pokemon.species_id, targetSpeciesId]);
            
            if (!evolutionPath || !checkEvolutionReady(pokemon, evolutionPath.conditions)) {
                throw new Error('不满足进化条件');
            }
            
            // 执行进化
            const targetSpecies = await client.queryOne(`
                SELECT * FROM pokemon_species WHERE id = $1
            `, [targetSpeciesId]);
            
            const updatedPokemon = await client.queryOne(`
                UPDATE pokemons 
                SET species_id = $1,
                    base_stats = $2,
                    types = $3,
                    abilities = $4,
                    evolved_at = NOW(),
                    evolution_count = evolution_count + 1,
                    updated_at = NOW()
                WHERE id = $5
                RETURNING *
            `, [
                targetSpeciesId,
                targetSpecies.base_stats,
                targetSpecies.types,
                evolutionPath.stat_changes.abilities || targetSpecies.abilities,
                pokemonId
            ]);
            
            // 记录进化事件
            await client.query(`
                INSERT INTO evolution_history (
                    user_id, pokemon_id, from_species_id, to_species_id,
                    evolution_type, conditions, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
            `, [
                req.user.id, pokemonId, pokemon.species_id, targetSpeciesId,
                evolutionPath.evolution_type, evolutionPath.conditions
            ]);
            
            await client.commit();
            
            // 发布进化事件
            await publishEvent('pokemon.evolved', {
                userId: req.user.id,
                pokemonId: pokemonId,
                fromSpecies: pokemon.species_id,
                toSpecies: targetSpeciesId,
                evolutionType: evolutionPath.evolution_type
            });
            
            res.json({
                success: true,
                pokemon: updatedPokemon,
                evolution: {
                    from: pokemon.species_id,
                    to: targetSpeciesId,
                    type: evolutionPath.evolution_type
                }
            });
            
        } catch (error) {
            await client.rollback();
            throw error;
        }
    },
    
    /**
     * 获取推荐进化路径
     */
    async getRecommendedEvolution(req, res) {
        const { pokemonId } = req.params;
        
        const pokemon = await db.queryOne(`
            SELECT p.*, ps.name, ps.types
            FROM pokemons p
            JOIN pokemon_species ps ON p.species_id = ps.id
            WHERE p.id = $1 AND p.user_id = $2
        `, [pokemonId, req.user.id]);
        
        // 获取所有可能的进化路径
        const evolutionPaths = await db.query(`
            SELECT ep.*, tn.pokemon_species_id as to_species,
                   ps.name as target_name, ps.types as target_types, ps.base_stats as target_stats
            FROM evolution_paths ep
            JOIN evolution_nodes fn ON ep.from_node_id = fn.id
            JOIN evolution_nodes tn ON ep.to_node_id = tn.id
            JOIN pokemon_species ps ON tn.pokemon_species_id = ps.id
            WHERE fn.pokemon_species_id = $1
        `, [pokemon.species_id]);
        
        // 根据玩家偏好推荐
        const recommendations = evolutionPaths.map(path => ({
            ...path,
            priority: calculateEvolutionPriority(pokemon, path),
            readiness: calculateEvolutionReadiness(pokemon, path.conditions)
        })).sort((a, b) => b.priority - a.priority);
        
        res.json({
            pokemon: {
                id: pokemon.id,
                name: pokemon.name,
                speciesId: pokemon.species_id
            },
            recommendations: recommendations,
            hasMultiplePaths: evolutionPaths.length > 1
        });
    }
};

// 辅助函数
function buildEvolutionTree(nodes, paths) {
    const nodeMap = new Map(nodes.map(n => [n.id, { ...n, children: [] }]));
    const roots = [];
    
    paths.forEach(path => {
        const fromNode = nodeMap.get(path.from_node_id);
        const toNode = nodeMap.get(path.to_node_id);
        
        if (fromNode && toNode) {
            fromNode.children.push({
                node: toNode,
                path: path
            });
        }
    });
    
    nodes.forEach(node => {
        if (node.is_root) {
            roots.push(nodeMap.get(node.id));
        }
    });
    
    return roots;
}

function formatConditions(conditions, type) {
    const formatted = [];
    
    if (conditions.min_level) {
        formatted.push(`等级达到 ${conditions.min_level}`);
    }
    if (conditions.item_id) {
        formatted.push(`使用进化石`);
    }
    if (conditions.min_friendship) {
        formatted.push(`亲密度达到 ${conditions.min_friendship}`);
    }
    if (conditions.time_range) {
        formatted.push(`在${conditions.time_range === 'day' ? '白天' : '夜晚'}进化`);
    }
    if (conditions.location_ids) {
        formatted.push(`在特定地点进化`);
    }
    if (conditions.trade_required) {
        formatted.push(`通过交换进化`);
    }
    if (conditions.special_conditions) {
        conditions.special_conditions.forEach(cond => {
            formatted.push(formatSpecialCondition(cond));
        });
    }
    
    return formatted;
}

function checkEvolutionReady(pokemon, conditions) {
    if (conditions.min_level && pokemon.level < conditions.min_level) {
        return false;
    }
    if (conditions.min_friendship && pokemon.friendship < conditions.min_friendship) {
        return false;
    }
    // ... 其他条件检查
    return true;
}

function calculateEvolvedStats(currentPokemon, targetSpecies, statChanges) {
    const stats = { ...targetSpecies.base_stats };
    
    // 应用属性变化
    if (statChanges) {
        Object.entries(statChanges).forEach(([stat, change]) => {
            if (typeof change === 'number') {
                stats[stat] = (stats[stat] || 0) + change;
            }
        });
    }
    
    return stats;
}

module.exports = EvolutionHandler;
```

### 3. 前端可视化组件

```javascript
// frontend/game-client/src/components/EvolutionTree.js

import React, { useState, useEffect } from 'react';
import './EvolutionTree.css';

const EvolutionTree = ({ speciesId, pokemonId }) => {
    const [chainData, setChainData] = useState(null);
    const [selectedPath, setSelectedPath] = useState(null);
    const [previewData, setPreviewData] = useState(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    
    useEffect(() => {
        loadEvolutionChain();
    }, [speciesId]);
    
    const loadEvolutionChain = async () => {
        try {
            const response = await fetch(
                `${API_BASE}/pokemon/evolution-chain/${speciesId}`
            );
            const data = await response.json();
            setChainData(data);
        } catch (error) {
            console.error('加载进化链失败:', error);
        }
    };
    
    const handleNodeClick = async (node) => {
        if (node.pokemon_species_id === speciesId) return;
        
        // 检查是否是可进化目标
        const path = chainData.paths.find(
            p => p.to_species === node.pokemon_species_id
        );
        
        if (path && pokemonId) {
            setSelectedPath(path);
            await loadPreview(node.pokemon_species_id);
        }
    };
    
    const loadPreview = async (targetSpeciesId) => {
        try {
            const response = await fetch(
                `${API_BASE}/pokemon/${pokemonId}/evolution-preview/${targetSpeciesId}`
            );
            const data = await response.json();
            setPreviewData(data);
        } catch (error) {
            console.error('加载预览失败:', error);
        }
    };
    
    const handleEvolve = async () => {
        if (!selectedPath || !pokemonId) return;
        
        try {
            const response = await fetch(`${API_BASE}/pokemon/evolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pokemonId: pokemonId,
                    targetSpeciesId: selectedPath.to_species
                })
            });
            
            const result = await response.json();
            if (result.success) {
                // 播放进化动画
                playEvolutionAnimation(result);
                // 刷新数据
                loadEvolutionChain();
                setPreviewData(null);
                setSelectedPath(null);
            }
        } catch (error) {
            console.error('进化失败:', error);
        }
    };
    
    const renderTreeNode = (node, depth = 0) => {
        const isCurrent = node.pokemon_species_id === speciesId;
        const children = chainData.paths
            .filter(p => p.from_species === node.pokemon_species_id)
            .map(p => chainData.nodes.find(n => n.pokemon_species_id === p.to_species));
        
        return (
            <div 
                key={node.id} 
                className={`evolution-node ${isCurrent ? 'current' : ''}`}
                style={{ 
                    marginLeft: `${depth * 120}px`,
                    animationDelay: `${depth * 0.1}s`
                }}
                onClick={() => handleNodeClick(node)}
            >
                <div className="node-image">
                    <img 
                        src={`/assets/pokemon/${node.pokemon_species_id}.png`}
                        alt={node.name}
                    />
                    {isCurrent && <div className="current-indicator">当前</div>}
                </div>
                <div className="node-info">
                    <span className="node-name">{node.name}</span>
                    <div className="node-types">
                        {node.types.map(type => (
                            <span key={type} className={`type-badge ${type}`}>
                                {type}
                            </span>
                        ))}
                    </div>
                </div>
                
                {/* 渲染子节点 */}
                {children.map(child => (
                    <div key={child.id} className="evolution-branch">
                        {renderEvolutionPath(node, child)}
                        {renderTreeNode(child, depth + 1)}
                    </div>
                ))}
            </div>
        );
    };
    
    const renderEvolutionPath = (fromNode, toNode) => {
        const path = chainData.paths.find(
            p => p.from_species === fromNode.pokemon_species_id && 
                 p.to_species === toNode.pokemon_species_id
        );
        
        return (
            <div className="evolution-arrow">
                <div className="arrow-line"></div>
                <div className="arrow-head">→</div>
                <div className="evolution-condition">
                    {path.conditions.map((cond, i) => (
                        <span key={i} className="condition-badge">
                            {cond}
                        </span>
                    ))}
                </div>
            </div>
        );
    };
    
    const renderPreview = () => {
        if (!previewData) return null;
        
        const { current, evolved, changes, conditions, canEvolve } = previewData;
        
        return (
            <div className="evolution-preview-overlay">
                <div className="evolution-preview">
                    <h2>进化预览</h2>
                    
                    <div className="preview-comparison">
                        <div className="preview-current">
                            <h3>当前形态</h3>
                            <img 
                                src={`/assets/pokemon/${speciesId}.png`}
                                alt={current.name}
                            />
                            <div className="preview-stats">
                                {Object.entries(current.stats).map(([stat, value]) => (
                                    <div key={stat} className="stat-row">
                                        <span className="stat-name">{stat}</span>
                                        <span className="stat-value">{value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        
                        <div className="preview-arrow">
                            <span>→</span>
                        </div>
                        
                        <div className="preview-evolved">
                            <h3>进化后</h3>
                            <img 
                                src={`/assets/pokemon/${selectedPath?.to_species}.png`}
                                alt={evolved.name}
                                className="evolved-preview"
                            />
                            <div className="preview-stats">
                                {Object.entries(evolved.stats).map(([stat, value]) => {
                                    const diff = value - (current.stats[stat] || 0);
                                    return (
                                        <div key={stat} className="stat-row">
                                            <span className="stat-name">{stat}</span>
                                            <span className="stat-value">{value}</span>
                                            <span className={`stat-diff ${diff > 0 ? 'positive' : 'negative'}`}>
                                                {diff > 0 ? '+' : ''}{diff}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                    
                    <div className="evolution-requirements">
                        <h3>进化条件</h3>
                        <ul>
                            {conditions.map((cond, i) => (
                                <li key={i}>{cond}</li>
                            ))}
                        </ul>
                    </div>
                    
                    <div className="preview-actions">
                        <button 
                            className="evolve-button"
                            disabled={!canEvolve}
                            onClick={handleEvolve}
                        >
                            {canEvolve ? '立即进化' : '条件未满足'}
                        </button>
                        <button 
                            className="cancel-button"
                            onClick={() => {
                                setPreviewData(null);
                                setSelectedPath(null);
                            }}
                        >
                            取消
                        </button>
                    </div>
                </div>
            </div>
        );
    };
    
    if (!chainData) {
        return <div className="loading">加载进化链...</div>;
    }
    
    return (
        <div className="evolution-tree-container">
            <div className="tree-header">
                <h2>进化路径</h2>
                <div className="tree-controls">
                    <button onClick={() => setZoom(z => Math.min(z + 0.2, 2))}>
                        放大
                    </button>
                    <button onClick={() => setZoom(z => Math.max(z - 0.2, 0.5))}>
                        缩小
                    </button>
                    <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>
                        重置
                    </button>
                </div>
            </div>
            
            <div 
                className="tree-canvas"
                style={{ 
                    transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)` 
                }}
            >
                {chainData.nodes
                    .filter(n => n.is_root)
                    .map(root => renderTreeNode(root))}
            </div>
            
            {renderPreview()}
        </div>
    );
};

export default EvolutionTree;
```

### 4. CSS 样式

```css
/* EvolutionTree.css */

.evolution-tree-container {
    padding: 20px;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border-radius: 16px;
    min-height: 500px;
}

.tree-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
}

.tree-header h2 {
    color: #fff;
    font-size: 24px;
}

.tree-controls button {
    margin-left: 10px;
    padding: 8px 16px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #fff;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s;
}

.tree-controls button:hover {
    background: rgba(255, 255, 255, 0.2);
}

.tree-canvas {
    overflow: auto;
    transition: transform 0.3s ease;
}

.evolution-node {
    display: flex;
    align-items: center;
    padding: 15px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    margin-bottom: 15px;
    cursor: pointer;
    transition: all 0.3s ease;
    animation: fadeInUp 0.5s ease forwards;
    opacity: 0;
}

.evolution-node:hover {
    background: rgba(255, 255, 255, 0.1);
    transform: translateY(-2px);
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
}

.evolution-node.current {
    border: 2px solid #4ade80;
    background: rgba(74, 222, 128, 0.1);
}

.node-image {
    position: relative;
    width: 80px;
    height: 80px;
}

.node-image img {
    width: 100%;
    height: 100%;
    object-fit: contain;
}

.current-indicator {
    position: absolute;
    bottom: -5px;
    left: 50%;
    transform: translateX(-50%);
    background: #4ade80;
    color: #000;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: bold;
}

.node-info {
    margin-left: 15px;
}

.node-name {
    color: #fff;
    font-size: 16px;
    font-weight: bold;
}

.node-types {
    margin-top: 5px;
}

.type-badge {
    display: inline-block;
    padding: 3px 8px;
    margin-right: 5px;
    border-radius: 4px;
    font-size: 12px;
    text-transform: capitalize;
}

.evolution-branch {
    position: relative;
}

.evolution-arrow {
    position: relative;
    display: flex;
    align-items: center;
    padding: 10px 0;
    margin-left: 50px;
}

.arrow-line {
    width: 40px;
    height: 2px;
    background: linear-gradient(90deg, #6366f1, #8b5cf6);
}

.arrow-head {
    color: #8b5cf6;
    font-size: 20px;
    margin-left: -5px;
}

.evolution-condition {
    position: absolute;
    top: -20px;
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
}

.condition-badge {
    display: inline-block;
    padding: 4px 10px;
    margin: 0 3px;
    background: rgba(139, 92, 246, 0.2);
    border: 1px solid rgba(139, 92, 246, 0.5);
    color: #c4b5fd;
    border-radius: 12px;
    font-size: 11px;
}

/* 进化预览弹窗 */
.evolution-preview-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.evolution-preview {
    background: linear-gradient(135deg, #1e1e2f 0%, #2d2d44 100%);
    border-radius: 20px;
    padding: 30px;
    max-width: 700px;
    width: 90%;
    animation: scaleIn 0.3s ease;
}

.preview-comparison {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 30px 0;
}

.preview-current,
.preview-evolved {
    flex: 1;
    text-align: center;
}

.preview-current h3,
.preview-evolved h3 {
    color: #94a3b8;
    font-size: 14px;
    margin-bottom: 15px;
}

.preview-current img,
.preview-evolved img {
    width: 120px;
    height: 120px;
    object-fit: contain;
}

.evolved-preview {
    animation: glow 2s ease-in-out infinite;
}

@keyframes glow {
    0%, 100% { filter: drop-shadow(0 0 10px rgba(139, 92, 246, 0.5)); }
    50% { filter: drop-shadow(0 0 20px rgba(139, 92, 246, 0.8)); }
}

.preview-arrow {
    font-size: 40px;
    color: #8b5cf6;
    margin: 0 20px;
}

.preview-stats {
    margin-top: 15px;
    text-align: left;
    padding-left: 20px;
}

.stat-row {
    display: flex;
    justify-content: space-between;
    padding: 5px 0;
    color: #fff;
}

.stat-name {
    color: #94a3b8;
    font-size: 14px;
    text-transform: capitalize;
}

.stat-value {
    font-weight: bold;
    margin-left: auto;
}

.stat-diff {
    margin-left: 10px;
    font-size: 12px;
}

.stat-diff.positive {
    color: #4ade80;
}

.stat-diff.negative {
    color: #f87171;
}

.evolution-requirements {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 15px;
    margin: 20px 0;
}

.evolution-requirements h3 {
    color: #94a3b8;
    font-size: 14px;
    margin-bottom: 10px;
}

.evolution-requirements ul {
    list-style: none;
    padding: 0;
}

.evolution-requirements li {
    color: #fff;
    padding: 5px 0;
    padding-left: 20px;
    position: relative;
}

.evolution-requirements li::before {
    content: '✓';
    position: absolute;
    left: 0;
    color: #4ade80;
}

.preview-actions {
    display: flex;
    justify-content: center;
    gap: 15px;
    margin-top: 20px;
}

.evolve-button {
    padding: 12px 40px;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    border: none;
    color: #fff;
    font-size: 16px;
    font-weight: bold;
    border-radius: 25px;
    cursor: pointer;
    transition: all 0.3s;
}

.evolve-button:hover:not(:disabled) {
    transform: scale(1.05);
    box-shadow: 0 5px 20px rgba(99, 102, 241, 0.4);
}

.evolve-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.cancel-button {
    padding: 12px 30px;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #94a3b8;
    border-radius: 25px;
    cursor: pointer;
}

@keyframes fadeInUp {
    from {
        opacity: 0;
        transform: translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes scaleIn {
    from {
        opacity: 0;
        transform: scale(0.9);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}
```

### 5. API 路由

```javascript
// backend/services/pokemon-service/src/routes/evolution.js

const express = require('express');
const router = express.Router();
const EvolutionHandler = require('../handlers/evolutionHandler');
const { authMiddleware } = require('../../../shared/auth');
const { validateRequest } = require('../../../shared/middleware');

// 公开接口
router.get('/chain/:speciesId', EvolutionHandler.getEvolutionChain);

// 需要认证的接口
router.get('/:pokemonId/evolution-preview/:targetSpeciesId', 
    authMiddleware, 
    EvolutionHandler.getEvolutionPreview
);

router.post('/evolve', 
    authMiddleware,
    validateRequest({
        pokemonId: { type: 'string', required: true },
        targetSpeciesId: { type: 'string', required: true }
    }),
    EvolutionHandler.evolve
);

router.get('/:pokemonId/recommended-evolution',
    authMiddleware,
    EvolutionHandler.getRecommendedEvolution
);

module.exports = router;
```

## 验收标准

- [ ] 数据库表结构创建完成，包含进化链、节点、路径表
- [ ] 后端 API 支持获取进化链、进化预览、执行进化操作
- [ ] 前端可视化组件能正确展示进化树结构
- [ ] 进化预览功能正常，属性对比清晰
- [ ] 支持多种进化类型（等级、道具、亲密度、时间、地点、交换、特殊）
- [ ] 进化条件验证逻辑正确
- [ ] 进化动画效果流畅
- [ ] 支持隐藏进化路径的发现提示
- [ ] 支持多语言进化条件描述
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] API 文档完整

## 影响范围

- **数据库**：新增 evolution_chains、evolution_nodes、evolution_paths、evolution_condition_descriptions 表
- **pokemon-service**：新增进化相关 API 端点
- **gateway**：配置进化相关路由
- **game-client**：新增 EvolutionTree 组件
- **后端共享模块**：新增进化条件解析工具函数

## 参考

- [Pokémon Evolution Mechanics](https://bulbapedia.bulbagarden.net/wiki/Evolution)
- [D3.js Tree Visualization](https://github.com/d3/d3-hierarchy/blob/main/README.md#tree)
- [React Flow - Interactive Node Graphs](https://reactflow.dev/)
