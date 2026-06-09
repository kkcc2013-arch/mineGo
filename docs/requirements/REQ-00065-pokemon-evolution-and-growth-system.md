# REQ-00065: 精灵进化与成长系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00065 |
| 标题 | 精灵进化与成长系统 |
| 类别 | 功能增强 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-09 23:00 |

## 需求描述

实现完整的精灵进化与成长系统，支持多种进化方式（等级进化、道具进化、交换进化、特定条件进化），提供进化预览、进化动画和进化后属性计算。精灵成长系统包括经验值获取、等级提升、属性成长曲线、个体值计算和 CP 计算。

### 核心功能

1. **进化系统**
   - 等级进化：达到指定等级自动触发（如皮卡丘→雷丘）
   - 道具进化：使用进化石触发（如火之石、雷之石）
   - 交换进化：通过交换触发（如豪力→怪力）
   - 条件进化：特定条件触发（如亲密度、时间、地点、天气）
   - 分支进化：满足不同条件可选择不同进化路径

2. **成长系统**
   - 经验值获取：捕捉、战斗、任务、道具
   - 等级上限：玩家等级限制精灵等级上限
   - 属性成长：HP、攻击、防御、特攻、特防、速度
   - CP 计算：基于等级、个体值、种族值

3. **进化 UI**
   - 进化预览：展示进化前后属性对比
   - 进化动画：炫酷的进化特效
   - 进化确认：玩家可选择是否进化

## 技术方案

### 1. 数据库设计

```sql
-- 数据库迁移文件：20260609_230000__add_evolution_and_growth_system.sql

-- ============================================
-- REQ-00065: 精灵进化与成长系统
-- ============================================

-- 进化规则表（定义所有精灵的进化路径）
CREATE TABLE evolution_rules (
    id SERIAL PRIMARY KEY,
    from_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    to_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    evolution_type VARCHAR(30) NOT NULL, -- 'level', 'item', 'trade', 'condition'
    
    -- 等级进化参数
    min_level INTEGER CHECK (evolution_type = 'level' AND min_level IS NOT NULL),
    
    -- 道具进化参数
    required_item_id INTEGER REFERENCES items(id),
    item_consumed BOOLEAN DEFAULT TRUE,
    
    -- 交换进化参数
    requires_trade BOOLEAN DEFAULT FALSE,
    trade_item_id INTEGER REFERENCES items(id), -- 交换时携带的道具
    
    -- 条件进化参数（JSON 格式存储复杂条件）
    conditions JSONB, -- {"friendship": 220, "time": "day", "location": "magnetic_field", "weather": "rain", "moves": [" AncientPower"]}
    
    -- 进化分支（用于分支进化）
    branch_group VARCHAR(50), -- 同一组内的进化路径互斥
    branch_priority INTEGER DEFAULT 0, -- 优先级高的优先触发
    
    -- 进化特效
    evolution_animation VARCHAR(50) DEFAULT 'standard', -- 'standard', 'special', 'legendary'
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(from_species_id, to_species_id)
);

CREATE INDEX idx_evolution_rules_from_species ON evolution_rules(from_species_id);
CREATE INDEX idx_evolution_rules_to_species ON evolution_rules(to_species_id);
CREATE INDEX idx_evolution_rules_type ON evolution_rules(evolution_type);

-- 精灵种族值表（补充基础属性）
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS base_hp INTEGER DEFAULT 100;
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS base_attack INTEGER DEFAULT 100;
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS base_defense INTEGER DEFAULT 100;
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS base_sp_attack INTEGER DEFAULT 100;
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS base_sp_defense INTEGER DEFAULT 100;
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS base_speed INTEGER DEFAULT 100;

-- 经验值成长曲线类型
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS growth_rate VARCHAR(20) DEFAULT 'medium_fast';
-- 'erratic', 'fast', 'medium_fast', 'medium_slow', 'slow', 'fluctuating'

-- 精灵实例表扩展
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS experience INTEGER DEFAULT 0;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS friendship INTEGER DEFAULT 70 CHECK (friendship BETWEEN 0 AND 255);
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS total_hp INTEGER;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS current_hp INTEGER;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS attack INTEGER;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS defense INTEGER;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS sp_attack INTEGER;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS sp_defense INTEGER;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS speed INTEGER;

CREATE INDEX idx_pokemon_instances_experience ON pokemon_instances(experience);
CREATE INDEX idx_pokemon_instances_friendship ON pokemon_instances(friendship);

-- 进化历史记录表
CREATE TABLE evolution_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id),
    from_species_id INTEGER NOT NULL,
    to_species_id INTEGER NOT NULL,
    evolution_type VARCHAR(30) NOT NULL,
    used_item_id INTEGER REFERENCES items(id),
    
    -- 进化前属性快照
    before_cp INTEGER,
    before_level INTEGER,
    before_stats JSONB,
    
    -- 进化后属性
    after_cp INTEGER,
    after_level INTEGER,
    after_stats JSONB,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_evolution_history_user ON evolution_history(user_id);
CREATE INDEX idx_evolution_history_pokemon ON evolution_history(pokemon_instance_id);

-- 经验值来源日志表
CREATE TABLE experience_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    pokemon_instance_id INTEGER REFERENCES pokemon_instances(id),
    source_type VARCHAR(30) NOT NULL, -- 'catch', 'battle', 'task', 'item', 'evolution'
    source_id INTEGER, -- 关联的捕捉/战斗/任务 ID
    experience_gained INTEGER NOT NULL,
    bonus_multiplier DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_experience_logs_user ON experience_logs(user_id);
CREATE INDEX idx_experience_logs_pokemon ON experience_logs(pokemon_instance_id);
CREATE INDEX idx_experience_logs_source ON experience_logs(source_type, source_id);

-- 插入进化规则种子数据（部分示例）
INSERT INTO evolution_rules (from_species_id, to_species_id, evolution_type, min_level, conditions, branch_group, branch_priority) VALUES
-- 皮卡丘 → 雷丘
(25, 26, 'item', NULL, NULL, NULL, 0),

-- 伊布分支进化
(133, 134, 'item', NULL, '{"item_condition": "water_stone"}', 'eevee', 1),
(133, 135, 'item', NULL, '{"item_condition": "thunder_stone"}', 'eevee', 1),
(133, 136, 'item', NULL, '{"item_condition": "fire_stone"}', 'eevee', 1),
(133, 196, 'condition', NULL, '{"friendship": 220, "time": "day"}', 'eevee', 2),
(133, 197, 'condition', NULL, '{"friendship": 220, "time": "night"}', 'eevee', 2),
(133, 470, 'condition', NULL, '{"friendship": 220, "location": "moss_rock"}', 'eevee', 3),
(133, 700, 'condition', NULL, '{"friendship": 220, "location": "ice_rock", "moves": ["Fairy Wind"]}', 'eevee', 3),

-- 御三家进化链
(1, 2, 'level', 16, NULL, NULL, 0),
(2, 3, 'level', 32, NULL, NULL, 0),
(4, 5, 'level', 16, NULL, NULL, 0),
(5, 6, 'level', 32, NULL, NULL, 0),
(7, 8, 'level', 16, NULL, NULL, 0),
(8, 9, 'level', 32, NULL, NULL, 0),

-- 交换进化
(64, 65, 'trade', NULL, NULL, NULL, 0),
(93, 94, 'trade', NULL, NULL, NULL, 0),

-- 特殊条件进化
(296, 297, 'condition', NULL, '{"attack_stat_gt_defense": true}', NULL, 0),
(133, 855, 'condition', NULL, '{"friendship": 160, "moves": ["Charm"]}', 'eevee', 4);

-- 更新部分精灵种族值示例
UPDATE pokemon_species SET 
    base_hp = 45, base_attack = 49, base_defense = 49, 
    base_sp_attack = 65, base_sp_defense = 65, base_speed = 45,
    growth_rate = 'medium_slow'
WHERE id = 1; -- 妙蛙种子

UPDATE pokemon_species SET 
    base_hp = 35, base_attack = 55, base_defense = 40, 
    base_sp_attack = 50, base_sp_defense = 50, base_speed = 90,
    growth_rate = 'medium_fast'
WHERE id = 25; -- 皮卡丘
```

### 2. 进化服务核心模块

```javascript
// backend/services/pokemon-service/src/evolutionService.js

const { Pool } = require('pg');
const Redis = require('ioredis');
const { prometheusMetrics } = require('../../shared/metrics');
const { logger } = require('../../shared/logger');

class EvolutionService {
    constructor() {
        this.db = new Pool({ connectionString: process.env.DATABASE_URL });
        this.redis = new Redis(process.env.REDIS_URL);
        
        // 经验值表（各级所需总经验）
        this.experienceTable = this.buildExperienceTable();
        
        // 进化动画配置
        this.evolutionAnimations = {
            standard: { duration: 3000, particles: 50 },
            special: { duration: 5000, particles: 100 },
            legendary: { duration: 8000, particles: 200 }
        };
    }

    /**
     * 构建经验值表（6种成长曲线）
     */
    buildExperienceTable() {
        const tables = {};
        
        // 快速成长
        tables.fast = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.floor(4 * Math.pow(level, 3) / 5);
        });
        
        // 中速成长（最常见）
        tables.medium_fast = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.pow(level, 3);
        });
        
        // 中慢成长
        tables.medium_slow = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.floor(4/5 * Math.pow(level, 3) - Math.pow(level, 2) + 10 * level - 15);
        });
        
        // 慢速成长
        tables.slow = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            return Math.floor(5 * Math.pow(level, 3) / 4);
        });
        
        // 波动成长
        tables.fluctuating = Array.from({ length: 100 }, (_, i) => {
            const level = i + 1;
            if (level % 2 === 0) {
                return Math.floor(level * level * level * (level % 4 === 0 ? 0.5 : 0.75));
            }
            return Math.floor(level * level * level * (1 - (level % 4) / 4));
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
     * 检查精灵是否可以进化
     */
    async checkEvolutionEligibility(pokemonInstanceId, userId) {
        const startTime = Date.now();
        
        try {
            // 获取精灵实例信息
            const pokemonResult = await this.db.query(`
                SELECT pi.*, ps.base_hp, ps.base_attack, ps.base_defense,
                       ps.base_sp_attack, ps.base_sp_defense, ps.base_speed,
                       ps.growth_rate, ps.name as species_name
                FROM pokemon_instances pi
                JOIN pokemon_species ps ON pi.species_id = ps.id
                WHERE pi.id = $1 AND pi.user_id = $2
            `, [pokemonInstanceId, userId]);
            
            if (pokemonResult.rows.length === 0) {
                return { eligible: false, reason: 'POKEMON_NOT_FOUND' };
            }
            
            const pokemon = pokemonResult.rows[0];
            
            // 检查玩家等级限制
            const userResult = await this.db.query(
                'SELECT level FROM users WHERE id = $1',
                [userId]
            );
            
            if (userResult.rows.length === 0 || userResult.rows[0].level < pokemon.level + 1) {
                return { 
                    eligible: false, 
                    reason: 'TRAINER_LEVEL_TOO_LOW',
                    requiredLevel: pokemon.level + 1
                };
            }
            
            // 获取所有可能的进化路径
            const evolutionPaths = await this.db.query(`
                SELECT er.*, ps.name as to_species_name, ps.image_url as to_image_url
                FROM evolution_rules er
                JOIN pokemon_species ps ON er.to_species_id = ps.id
                WHERE er.from_species_id = $1 AND er.is_active = true
                ORDER BY er.branch_priority DESC
            `, [pokemon.species_id]);
            
            if (evolutionPaths.rows.length === 0) {
                return { eligible: false, reason: 'NO_EVOLUTION_AVAILABLE' };
            }
            
            // 检查每条进化路径的可行性
            const availableEvolutions = [];
            
            for (const path of evolutionPaths.rows) {
                const checkResult = await this.checkEvolutionConditions(pokemon, path, userId);
                if (checkResult.canEvolve) {
                    availableEvolutions.push({
                        ...path,
                        preview: await this.calculateEvolutionPreview(pokemon, path),
                        requirements: checkResult.requirements
                    });
                }
            }
            
            if (availableEvolutions.length === 0) {
                return { 
                    eligible: false, 
                    reason: 'CONDITIONS_NOT_MET',
                    closestEvolution: this.findClosestEvolution(evolutionPaths.rows, pokemon)
                };
            }
            
            prometheusMetrics.evolutionCheckDuration.observe(
                { evolution_type: 'check' },
                (Date.now() - startTime) / 1000
            );
            
            return {
                eligible: true,
                pokemon,
                availableEvolutions,
                recommendation: this.recommendEvolution(availableEvolutions, pokemon)
            };
            
        } catch (error) {
            logger.error('Evolution eligibility check failed', { error, pokemonInstanceId, userId });
            throw error;
        }
    }

    /**
     * 检查进化条件
     */
    async checkEvolutionConditions(pokemon, evolutionPath, userId) {
        const result = { canEvolve: false, requirements: {} };
        
        switch (evolutionPath.evolution_type) {
            case 'level':
                if (pokemon.level >= evolutionPath.min_level) {
                    result.canEvolve = true;
                    result.requirements = {
                        type: 'level',
                        current: pokemon.level,
                        required: evolutionPath.min_level,
                        met: true
                    };
                } else {
                    result.requirements = {
                        type: 'level',
                        current: pokemon.level,
                        required: evolutionPath.min_level,
                        met: false
                    };
                }
                break;
                
            case 'item':
                // 检查玩家是否拥有进化道具
                const itemCheck = await this.db.query(`
                    SELECT quantity FROM user_items
                    WHERE user_id = $1 AND item_id = $2 AND quantity > 0
                `, [userId, evolutionPath.required_item_id]);
                
                result.canEvolve = itemCheck.rows.length > 0;
                result.requirements = {
                    type: 'item',
                    itemId: evolutionPath.required_item_id,
                    met: result.canEvolve,
                    willConsume: evolutionPath.item_consumed
                };
                break;
                
            case 'trade':
                // 交换进化需要先完成交换
                result.canEvolve = false; // 需要在交易流程中处理
                result.requirements = {
                    type: 'trade',
                    met: false,
                    note: 'Requires trading with another player'
                };
                break;
                
            case 'condition':
                const conditions = evolutionPath.conditions || {};
                const checkResults = [];
                
                // 检查亲密度
                if (conditions.friendship) {
                    const met = pokemon.friendship >= conditions.friendship;
                    checkResults.push({
                        type: 'friendship',
                        current: pokemon.friendship,
                        required: conditions.friendship,
                        met
                    });
                }
                
                // 检查时间（白天/黑夜）
                if (conditions.time) {
                    const currentHour = new Date().getHours();
                    const isDay = currentHour >= 6 && currentHour < 18;
                    const met = (conditions.time === 'day' && isDay) || 
                               (conditions.time === 'night' && !isDay);
                    checkResults.push({
                        type: 'time',
                        required: conditions.time,
                        current: isDay ? 'day' : 'night',
                        met
                    });
                }
                
                // 检查地点
                if (conditions.location) {
                    // 需要玩家当前位置信息
                    const locationResult = await this.checkLocationCondition(userId, conditions.location);
                    checkResults.push({
                        type: 'location',
                        required: conditions.location,
                        met: locationResult.met
                    });
                }
                
                // 检查天气
                if (conditions.weather) {
                    const weatherResult = await this.checkWeatherCondition(userId, conditions.weather);
                    checkResults.push({
                        type: 'weather',
                        required: conditions.weather,
                        current: weatherResult.current,
                        met: weatherResult.met
                    });
                }
                
                // 检查招式
                if (conditions.moves) {
                    const moveResult = await this.checkMovesCondition(pokemon.id, conditions.moves);
                    checkResults.push({
                        type: 'moves',
                        required: conditions.moves,
                        met: moveResult.met
                    });
                }
                
                // 检查属性条件（如攻击 > 防御）
                if (conditions.attack_stat_gt_defense) {
                    const met = pokemon.attack > pokemon.defense;
                    checkResults.push({
                        type: 'attack_gt_defense',
                        current: { attack: pokemon.attack, defense: pokemon.defense },
                        met
                    });
                }
                
                result.requirements = {
                    type: 'condition',
                    checks: checkResults,
                    met: checkResults.every(c => c.met)
                };
                result.canEvolve = result.requirements.met;
                break;
        }
        
        return result;
    }

    /**
     * 执行进化
     */
    async performEvolution(pokemonInstanceId, userId, targetSpeciesId, options = {}) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 获取精灵和进化规则
            const pokemonResult = await client.query(`
                SELECT pi.*, ps.base_hp, ps.base_attack, ps.base_defense,
                       ps.base_sp_attack, ps.base_sp_defense, ps.base_speed, ps.growth_rate
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
                SELECT * FROM evolution_rules
                WHERE from_species_id = $1 AND to_species_id = $2 AND is_active = true
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
            
            const target = targetSpecies.rows[0];
            
            // 保存进化前属性快照
            const beforeStats = {
                cp: pokemon.cp,
                level: pokemon.level,
                hp: pokemon.total_hp,
                attack: pokemon.attack,
                defense: pokemon.defense,
                sp_attack: pokemon.sp_attack,
                sp_defense: pokemon.sp_defense,
                speed: pokemon.speed
            };
            
            // 计算进化后属性
            const newStats = this.calculatePostEvolutionStats(pokemon, target);
            
            // 更新精灵实例
            await client.query(`
                UPDATE pokemon_instances SET
                    species_id = $1,
                    cp = $2,
                    total_hp = $3,
                    current_hp = LEAST(current_hp + $4 - $5, $3),
                    attack = $6,
                    defense = $7,
                    sp_attack = $8,
                    sp_defense = $9,
                    speed = $10,
                    updated_at = NOW()
                WHERE id = $11
            `, [
                targetSpeciesId, newStats.cp, newStats.totalHp,
                newStats.totalHp, beforeStats.hp,
                newStats.attack, newStats.defense,
                newStats.spAttack, newStats.spDefense, newStats.speed,
                pokemonInstanceId
            ]);
            
            // 消耗道具（如果是道具进化）
            if (rule.required_item_id && rule.item_consumed) {
                await client.query(`
                    UPDATE user_items SET quantity = quantity - 1
                    WHERE user_id = $1 AND item_id = $2
                `, [userId, rule.required_item_id]);
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
                newStats.cp, pokemon.level, JSON.stringify(newStats)
            ]);
            
            // 发布进化事件
            await this.publishEvolutionEvent(userId, pokemonInstanceId, pokemon.species_id, targetSpeciesId);
            
            // 更新图鉴
            await this.updatePokedex(userId, targetSpeciesId);
            
            // 给予进化奖励
            const rewards = await this.grantEvolutionRewards(userId, targetSpeciesId);
            
            await client.query('COMMIT');
            
            // 记录 Prometheus 指标
            prometheusMetrics.evolutionCounter.inc({ 
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
            
            return {
                success: true,
                evolution: {
                    fromSpecies: pokemon.species_id,
                    toSpecies: targetSpeciesId,
                    beforeStats,
                    afterStats: newStats,
                    animation: this.evolutionAnimations[rule.evolution_animation]
                },
                rewards
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Evolution failed', { error, pokemonInstanceId, userId });
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 计算进化后属性
     */
    calculatePostEvolutionStats(pokemon, targetSpecies) {
        // CP 公式: CP = (攻击 × 防御^0.5 × HP^0.5 × CP倍率^2) / 10
        const level = pokemon.level;
        
        // CP 倍率表（简化版，实际应根据等级查表）
        const cpMultiplier = this.getCPMultiplier(level);
        
        // 计算新属性（基础属性 + 个体值）
        const stats = {
            totalHp: Math.floor((targetSpecies.base_hp + pokemon.iv_hp) * cpMultiplier),
            attack: Math.floor((targetSpecies.base_attack + pokemon.iv_attack) * cpMultiplier),
            defense: Math.floor((targetSpecies.base_defense + pokemon.iv_defense) * cpMultiplier),
            spAttack: Math.floor((targetSpecies.base_sp_attack + pokemon.iv_sp_attack) * cpMultiplier),
            spDefense: Math.floor((targetSpecies.base_sp_defense + pokemon.iv_sp_defense) * cpMultiplier),
            speed: Math.floor((targetSpecies.base_speed + pokemon.iv_speed) * cpMultiplier)
        };
        
        // 计算 CP
        stats.cp = Math.floor(
            (stats.attack * Math.pow(stats.defense, 0.5) * Math.pow(stats.totalHp, 0.5) * Math.pow(cpMultiplier, 2)) / 10
        );
        
        return stats;
    }

    /**
     * 获取 CP 倍率
     */
    getCPMultiplier(level) {
        const multipliers = {
            1: 0.094, 2: 0.135, 3: 0.166, 4: 0.192,
            5: 0.215, 10: 0.290, 15: 0.341, 20: 0.379,
            25: 0.407, 30: 0.424, 35: 0.439, 40: 0.451,
            45: 0.461, 50: 0.470, 55: 0.477, 60: 0.483,
            65: 0.489, 70: 0.493, 75: 0.497, 80: 0.501,
            85: 0.504, 90: 0.507, 95: 0.510, 100: 0.512
        };
        
        return multipliers[level] || 0.512;
    }

    /**
     * 计算进化预览
     */
    async calculateEvolutionPreview(pokemon, evolutionPath) {
        const targetSpecies = await this.db.query(
            'SELECT * FROM pokemon_species WHERE id = $1',
            [evolutionPath.to_species_id]
        );
        
        if (targetSpecies.rows.length === 0) {
            return null;
        }
        
        const target = targetSpecies.rows[0];
        const newStats = this.calculatePostEvolutionStats(pokemon, target);
        
        return {
            targetSpecies: {
                id: target.id,
                name: target.name,
                imageUrl: target.image_url,
                types: target.types
            },
            statsChange: {
                hp: newStats.totalHp - pokemon.total_hp,
                attack: newStats.attack - pokemon.attack,
                defense: newStats.defense - pokemon.defense,
                spAttack: newStats.spAttack - pokemon.sp_attack,
                spDefense: newStats.spDefense - pokemon.sp_defense,
                speed: newStats.speed - pokemon.speed,
                cp: newStats.cp - pokemon.cp
            },
            newStats,
            canLearnNewMoves: await this.getNewMovesAvailable(evolutionPath.to_species_id, pokemon.species_id)
        };
    }

    /**
     * 添加经验值
     */
    async addExperience(pokemonInstanceId, userId, amount, source) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 获取精灵信息
            const pokemonResult = await client.query(`
                SELECT pi.*, ps.growth_rate, u.level as trainer_level
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
            const oldLevel = pokemon.level;
            const oldExp = pokemon.experience;
            const newExp = oldExp + amount;
            
            // 计算新等级
            const newLevel = this.calculateLevelFromExp(newExp, pokemon.growth_rate);
            
            // 检查等级上限（不能超过训练师等级）
            const maxLevel = Math.min(100, pokemon.trainer_level + 1.5);
            const actualNewLevel = Math.min(newLevel, maxLevel);
            
            // 更新经验值和等级
            await client.query(`
                UPDATE pokemon_instances SET
                    experience = $1,
                    level = $2,
                    updated_at = NOW()
                WHERE id = $3
            `, [newExp, actualNewLevel, pokemonInstanceId]);
            
            // 记录经验值日志
            await client.query(`
                INSERT INTO experience_logs (user_id, pokemon_instance_id, source_type, experience_gained)
                VALUES ($1, $2, $3, $4)
            `, [userId, pokemonInstanceId, source, amount]);
            
            // 如果升级了
            let levelUpInfo = null;
            if (actualNewLevel > oldLevel) {
                levelUpInfo = await this.handleLevelUp(client, pokemon, oldLevel, actualNewLevel);
            }
            
            await client.query('COMMIT');
            
            // 更新 Prometheus 指标
            prometheusMetrics.experienceGained.inc({ source }, amount);
            
            return {
                success: true,
                experienceGained: amount,
                newExp,
                levelChange: actualNewLevel - oldLevel,
                levelUpInfo
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 从经验值计算等级
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
     * 处理升级
     */
    async handleLevelUp(client, pokemon, oldLevel, newLevel) {
        // 重新计算属性
        const species = await client.query(
            'SELECT * FROM pokemon_species WHERE id = $1',
            [pokemon.species_id]
        );
        
        const newStats = this.calculatePostEvolutionStats(
            { ...pokemon, level: newLevel },
            species.rows[0]
        );
        
        // 更新属性
        await client.query(`
            UPDATE pokemon_instances SET
                total_hp = $1,
                current_hp = $1,
                attack = $2,
                defense = $3,
                sp_attack = $4,
                sp_defense = $5,
                speed = $6,
                cp = $7
            WHERE id = $8
        `, [
            newStats.totalHp, newStats.attack, newStats.defense,
            newStats.spAttack, newStats.spDefense, newStats.speed,
            newStats.cp, pokemon.id
        ]);
        
        // 检查是否可以学会新招式
        const newMoves = await this.getMovesLearnedAtLevel(pokemon.species_id, oldLevel + 1, newLevel);
        
        // 发布升级事件
        await this.publishLevelUpEvent(pokemon.user_id, pokemon.id, oldLevel, newLevel);
        
        return {
            oldLevel,
            newLevel,
            newStats,
            newMoves,
            cpIncrease: newStats.cp - pokemon.cp
        };
    }

    /**
     * 推荐进化路径
     */
    recommendEvolution(availableEvolutions, pokemon) {
        if (availableEvolutions.length === 1) {
            return {
                recommended: availableEvolutions[0],
                reason: 'ONLY_ONE_PATH'
            };
        }
        
        // 根据 CP 增益和稀有度推荐
        const sorted = [...availableEvolutions].sort((a, b) => {
            const cpGainA = a.preview?.statsChange?.cp || 0;
            const cpGainB = b.preview?.statsChange?.cp || 0;
            return cpGainB - cpGainA;
        });
        
        return {
            recommended: sorted[0],
            reason: 'HIGHEST_CP_GAIN',
            alternatives: sorted.slice(1)
        };
    }

    /**
     * 发布进化事件
     */
    async publishEvolutionEvent(userId, pokemonId, fromSpecies, toSpecies) {
        const { Kafka } = require('kafkajs');
        const kafka = new Kafka({ brokers: [process.env.KAFKA_BROKER] });
        const producer = kafka.producer();
        
        await producer.connect();
        await producer.send({
            topic: 'pokemon.evolution',
            messages: [{
                key: `${userId}-${pokemonId}`,
                value: JSON.stringify({
                    eventType: 'pokemon.evolved',
                    timestamp: Date.now(),
                    data: {
                        userId,
                        pokemonId,
                        fromSpecies,
                        toSpecies
                    }
                })
            }]
        });
        
        await producer.disconnect();
    }

    /**
     * 更新图鉴
     */
    async updatePokedex(userId, speciesId) {
        await this.db.query(`
            INSERT INTO pokedex_entries (user_id, species_id, seen, caught, caught_count)
            VALUES ($1, $2, true, true, 1)
            ON CONFLICT (user_id, species_id) DO UPDATE SET
                caught = true,
                caught_count = pokedex_entries.caught_count + 1,
                updated_at = NOW()
        `, [userId, speciesId]);
    }

    /**
     * 给予进化奖励
     */
    async grantEvolutionRewards(userId, speciesId) {
        // 基础进化奖励
        const rewards = {
            stardust: 500,
            candy: 1,
            experience: 1000
        };
        
        // 稀有精灵额外奖励
        const species = await this.db.query(
            'SELECT rarity FROM pokemon_species WHERE id = $1',
            [speciesId]
        );
        
        if (species.rows[0]?.rarity === 'rare') {
            rewards.stardust *= 2;
            rewards.experience *= 2;
        } else if (species.rows[0]?.rarity === 'legendary') {
            rewards.stardust *= 5;
            rewards.experience *= 5;
        }
        
        // 发放奖励
        await this.db.query(`
            UPDATE users SET
                stardust = stardust + $1,
                experience = experience + $3
            WHERE id = $2
        `, [rewards.stardust, userId, rewards.experience]);
        
        return rewards;
    }
}

// Prometheus 指标定义
const prometheusMetrics = {
    evolutionCounter: new (require('prom-client').Counter)({
        name: 'pokemon_evolution_total',
        help: 'Total number of Pokemon evolutions',
        labelNames: ['evolution_type', 'species']
    }),
    evolutionCheckDuration: new (require('prom-client').Histogram)({
        name: 'evolution_check_duration_seconds',
        help: 'Duration of evolution eligibility checks',
        labelNames: ['evolution_type'],
        buckets: [0.01, 0.05, 0.1, 0.5, 1]
    }),
    experienceGained: new (require('prom-client').Counter)({
        name: 'pokemon_experience_gained_total',
        help: 'Total experience gained',
        labelNames: ['source']
    })
};

module.exports = { EvolutionService };
```

### 3. API 路由

```javascript
// backend/services/pokemon-service/src/routes/evolution.js

const express = require('express');
const router = express.Router();
const { EvolutionService } = require('../evolutionService');
const { auth } = require('../../../shared/middleware/auth');
const { rateLimiter } = require('../../../shared/middleware/rateLimiter');

const evolutionService = new EvolutionService();

/**
 * GET /api/pokemon/:id/evolution/check
 * 检查精灵是否可以进化
 */
router.get('/:id/evolution/check', auth, async (req, res) => {
    try {
        const result = await evolutionService.checkEvolutionEligibility(
            parseInt(req.params.id),
            req.user.id
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/pokemon/:id/evolution/execute
 * 执行进化
 */
router.post('/:id/evolution/execute', auth, rateLimiter({ windowMs: 60000, max: 5 }), async (req, res) => {
    try {
        const { targetSpeciesId, skipAnimation } = req.body;
        
        if (!targetSpeciesId) {
            return res.status(400).json({
                success: false,
                error: 'TARGET_SPECIES_REQUIRED'
            });
        }
        
        const result = await evolutionService.performEvolution(
            parseInt(req.params.id),
            req.user.id,
            targetSpeciesId,
            { skipAnimation }
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/pokemon/:id/experience
 * 添加经验值（内部 API）
 */
router.post('/:id/experience', auth, async (req, res) => {
    try {
        const { amount, source } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_AMOUNT'
            });
        }
        
        const result = await evolutionService.addExperience(
            parseInt(req.params.id),
            req.user.id,
            amount,
            source || 'unknown'
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/pokemon/:id/stats
 * 获取精灵详细属性
 */
router.get('/:id/stats', auth, async (req, res) => {
    try {
        const result = await evolutionService.getPokemonStats(
            parseInt(req.params.id),
            req.user.id
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
```

### 4. 前端进化组件

```javascript
// frontend/game-client/src/components/EvolutionScene.js

class EvolutionScene {
    constructor() {
        this.animationContainer = null;
        this.audioContext = null;
        this.isAnimating = false;
    }

    /**
     * 显示进化预览
     */
    async showEvolutionPreview(pokemon, evolutionData) {
        const modal = document.createElement('div');
        modal.className = 'evolution-preview-modal';
        modal.innerHTML = `
            <div class="evolution-preview-content">
                <h2>Evolution Available!</h2>
                
                <div class="evolution-comparison">
                    <div class="pokemon-before">
                        <img src="${pokemon.imageUrl}" alt="${pokemon.name}">
                        <h3>${pokemon.name}</h3>
                        <div class="stats">
                            <p>CP: ${pokemon.cp}</p>
                            <p>Level: ${pokemon.level}</p>
                        </div>
                    </div>
                    
                    <div class="evolution-arrow">
                        <span class="arrow-icon">→</span>
                    </div>
                    
                    <div class="pokemon-after">
                        <img src="${evolutionData.preview.targetSpecies.imageUrl}" 
                             alt="${evolutionData.preview.targetSpecies.name}"
                             class="silhouette">
                        <h3>???</h3>
                        <div class="stats-preview">
                            <p>CP: ${pokemon.cp + evolutionData.preview.statsChange.cp} 
                               <span class="change positive">(+${evolutionData.preview.statsChange.cp})</span></p>
                        </div>
                    </div>
                </div>
                
                <div class="requirements">
                    ${this.renderRequirements(evolutionData.requirements)}
                </div>
                
                <div class="evolution-buttons">
                    <button class="btn-evolve" data-species="${evolutionData.toSpeciesId}">
                        Evolve Now
                    </button>
                    <button class="btn-cancel">Later</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // 绑定事件
        modal.querySelector('.btn-evolve').addEventListener('click', async () => {
            await this.startEvolution(pokemon, evolutionData);
            modal.remove();
        });
        
        modal.querySelector('.btn-cancel').addEventListener('click', () => {
            modal.remove();
        });
    }

    /**
     * 开始进化动画
     */
    async startEvolution(pokemon, evolutionData) {
        if (this.isAnimating) return;
        this.isAnimating = true;
        
        // 创建进化场景
        const scene = document.createElement('div');
        scene.className = 'evolution-scene';
        scene.innerHTML = `
            <div class="evolution-bg"></div>
            <div class="evolution-pokemon-container">
                <div class="evolution-light-beams"></div>
                <img src="${pokemon.imageUrl}" class="evolution-pokemon from" alt="">
                <img src="${evolutionData.preview.targetSpecies.imageUrl}" 
                     class="evolution-pokemon to hidden" alt="">
                <div class="evolution-particles"></div>
            </div>
            <div class="evolution-text">
                <p class="evolving-text">What? ${pokemon.name} is evolving!</p>
                <p class="evolved-text hidden">Congratulations! Your ${pokemon.name} evolved into ${evolutionData.preview.targetSpecies.name}!</p>
            </div>
            <div class="evolution-progress">
                <div class="progress-bar"></div>
            </div>
        `;
        
        document.body.appendChild(scene);
        
        // 播放音效
        this.playEvolutionSound('start');
        
        // 执行动画序列
        await this.runEvolutionAnimation(scene, evolutionData);
        
        // 调用 API 执行进化
        try {
            const response = await fetch(`/api/pokemon/${pokemon.id}/evolution/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetSpeciesId: evolutionData.toSpeciesId })
            });
            
            const result = await response.json();
            
            if (result.success) {
                // 显示进化结果
                await this.showEvolutionResult(scene, result.data);
                
                // 显示奖励
                if (result.data.rewards) {
                    this.showRewards(result.data.rewards);
                }
            }
        } catch (error) {
            console.error('Evolution failed:', error);
            scene.remove();
        }
        
        this.isAnimating = false;
    }

    /**
     * 运行进化动画
     */
    async runEvolutionAnimation(scene, evolutionData) {
        const animation = evolutionData.animation || { duration: 3000, particles: 50 };
        const fromPokemon = scene.querySelector('.evolution-pokemon.from');
        const toPokemon = scene.querySelector('.evolution-pokemon.to');
        const particles = scene.querySelector('.evolution-particles');
        const progressBar = scene.querySelector('.progress-bar');
        
        // 阶段 1：闪烁（0-30%）
        for (let i = 0; i < 10; i++) {
            fromPokemon.style.filter = `brightness(${1 + Math.random() * 0.5})`;
            await this.sleep(100);
        }
        
        // 阶段 2：光芒爆发（30-60%）
        this.playEvolutionSound('flash');
        await this.createLightBeams(scene);
        
        // 阶段 3：形态转换（60-90%）
        fromPokemon.classList.add('transforming');
        
        // 创建粒子效果
        for (let i = 0; i < animation.particles; i++) {
            this.createParticle(particles);
        }
        
        // 渐变过渡
        await this.sleep(500);
        toPokemon.classList.remove('hidden');
        fromPokemon.style.opacity = '0';
        toPokemon.style.opacity = '1';
        
        this.playEvolutionSound('transform');
        
        // 阶段 4：完成（90-100%）
        await this.sleep(animation.duration * 0.1);
        
        // 更新进度条
        progressBar.style.width = '100%';
    }

    /**
     * 创建粒子
     */
    createParticle(container) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.cssText = `
            left: ${50 + (Math.random() - 0.5) * 100}%;
            top: ${50 + (Math.random() - 0.5) * 100}%;
            animation: particle-${Math.floor(Math.random() * 3)} ${1 + Math.random() * 2}s ease-out forwards;
        `;
        container.appendChild(particle);
        
        setTimeout(() => particle.remove(), 3000);
    }

    /**
     * 播放进化音效
     */
    playEvolutionSound(phase) {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        const sounds = {
            start: { frequency: 440, duration: 0.5 },
            flash: { frequency: 880, duration: 0.3 },
            transform: { frequency: 660, duration: 0.8 },
            complete: { frequency: 523, duration: 1.2 }
        };
        
        const sound = sounds[phase];
        if (!sound) return;
        
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.frequency.value = sound.frequency;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + sound.duration);
        
        oscillator.start();
        oscillator.stop(this.audioContext.currentTime + sound.duration);
    }

    /**
     * 显示进化结果
     */
    async showEvolutionResult(scene, data) {
        const evolvingText = scene.querySelector('.evolving-text');
        const evolvedText = scene.querySelector('.evolved-text');
        
        evolvingText.classList.add('hidden');
        evolvedText.classList.remove('hidden');
        
        this.playEvolutionSound('complete');
        
        // 显示属性变化
        const statsPanel = document.createElement('div');
        statsPanel.className = 'evolution-stats-panel';
        statsPanel.innerHTML = `
            <h3>Stats Change</h3>
            <div class="stats-grid">
                <div class="stat-row">
                    <span>CP</span>
                    <span class="old">${data.evolution.beforeStats.cp}</span>
                    <span class="arrow">→</span>
                    <span class="new">${data.evolution.afterStats.cp}</span>
                    <span class="change">+${data.evolution.statsChange.cp}</span>
                </div>
                <!-- 更多属性... -->
            </div>
        `;
        
        scene.appendChild(statsPanel);
        
        // 等待用户确认
        await new Promise(resolve => {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn-close-evolution';
            closeBtn.textContent = 'Awesome!';
            closeBtn.onclick = () => {
                scene.remove();
                resolve();
            };
            scene.appendChild(closeBtn);
        });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { EvolutionScene };
```

## 验收标准

- [ ] 等级进化正确触发（达到指定等级可进化）
- [ ] 道具进化正确消耗道具并完成进化
- [ ] 交换进化在交易完成时正确触发
- [ ] 条件进化正确检查亲密度、时间、地点、天气等条件
- [ ] 分支进化允许玩家选择进化路径
- [ ] 进化预览正确显示属性变化
- [ ] 进化动画流畅播放，无卡顿
- [ ] 经验值计算正确，符合 6 种成长曲线
- [ ] 等级提升正确计算新属性
- [ ] CP 计算符合官方公式
- [ ] 进化历史记录完整保存
- [ ] 图鉴正确更新新获得的精灵
- [ ] 进化奖励正确发放
- [ ] Prometheus 指标正确记录进化事件
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] API 文档完整更新

## 影响范围

- **数据库**：新增进化规则表、进化历史表、经验值日志表
- **pokemon-service**：新增进化服务和成长服务
- **user-service**：消费进化事件，更新用户统计
- **reward-service**：处理进化奖励发放
- **gateway**：新增进化相关 API 路由
- **game-client**：新增进化场景组件和动画系统

## 参考

- [Pokemon GO CP Formula](https://gamepress.gg/pokemongo/pokemon-stats-advanced)
- [Pokemon Evolution Mechanics](https://bulbapedia.bulbagarden.net/wiki/Evolution)
- [Pokemon Experience Growth](https://bulbapedia.bulbagarden.net/wiki/Experience)
