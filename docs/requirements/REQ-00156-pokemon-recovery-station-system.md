# REQ-00156: 精灵恢复站系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00156 |
| 标题 | 精灵恢复站系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | location-service、pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-13 09:00 |

## 需求描述

实现完整的精灵恢复站系统，让玩家可以在地图上的特定地点恢复精灵的 HP、PP（技能点数）和状态异常。这是 Pokemon GO 风格游戏中精灵管理的核心功能之一，直接影响玩家的游戏体验和策略规划。

### 核心功能
1. **恢复站分布与发现**
   - 恢复站在地图上的分布（城市、公园、商圈等）
   - 玩家靠近恢复站时自动发现
   - 恢复站状态实时更新（在线/离线/维护）

2. **精灵恢复机制**
   - 恢复全部精灵 HP
   - 恢复全部技能 PP
   - 治愈所有状态异常（中毒、麻痹、烧伤、冻伤、睡眠）
   - 恢复时间与动画效果

3. **恢复站类型与等级**
   - 普通恢复站：基础恢复速度
   - 高级恢复站：快速恢复 + 额外效果
   - 会员恢复站：VIP 专属，全属性加成
   - 活动恢复站：限时活动，特殊奖励

4. **恢复站互动功能**
   - 玩家签到打卡
   - 恢复站照片上传与审核
   - 恢复站评分与评论
   - 恢复站收藏功能

5. **恢复站管理（运营端）**
   - 恢复站位置管理
   - 恢复站状态控制
   - 恢复站数据分析
   - 恢复站推荐算法

### 用户场景
- 玩家完成道馆战斗后，精灵受伤需要恢复
- 玩家长途跋涉后，精灵 HP 降低需要补充
- 玩家参加活动，需要快速恢复状态
- 玩家发现新的恢复站，打卡记录

## 技术方案

### 1. 数据库设计

```sql
-- 恢复站表
CREATE TABLE recovery_stations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('normal', 'advanced', 'premium', 'event')),
    level INT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
    
    -- 恢复配置
    recovery_speed_multiplier DECIMAL(3,2) DEFAULT 1.0,
    bonus_effects JSONB DEFAULT '{}',
    daily_usage_limit INT DEFAULT 0, -- 0表示无限制
    
    -- 状态
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
    last_maintenance_at TIMESTAMP,
    
    -- 元数据
    photo_url VARCHAR(500),
    rating DECIMAL(3,2) DEFAULT 0.0,
    total_check_ins INT DEFAULT 0,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 索引
    INDEX idx_location (location),
    INDEX idx_type (type),
    INDEX idx_status (status)
);

-- 恢复站签到记录表
CREATE TABLE recovery_check_ins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    station_id UUID NOT NULL REFERENCES recovery_stations(id),
    
    -- 恢复详情
    pokemon_recovered INT DEFAULT 0,
    hp_recovered INT DEFAULT 0,
    pp_recovered INT DEFAULT 0,
    status_healed JSONB DEFAULT '{}',
    
    -- 奖励
    bonus_items JSONB DEFAULT '[]',
    bonus_experience INT DEFAULT 0,
    
    -- 时间
    checked_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    recovery_duration_seconds INT,
    
    INDEX idx_user_station (user_id, station_id),
    INDEX idx_checked_in_at (checked_in_at)
);

-- 恢复站照片表
CREATE TABLE recovery_station_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID NOT NULL REFERENCES recovery_stations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    photo_url VARCHAR(500) NOT NULL,
    description TEXT,
    
    -- 审核状态
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP,
    rejection_reason TEXT,
    
    -- 统计
    likes_count INT DEFAULT 0,
    reports_count INT DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_station (station_id),
    INDEX idx_status (status)
);

-- 恢复站评论表
CREATE TABLE recovery_station_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID NOT NULL REFERENCES recovery_stations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    content TEXT,
    
    -- 审核状态
    status VARCHAR(20) DEFAULT 'active',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_station (station_id),
    UNIQUE (station_id, user_id)
);

-- 用户恢复站收藏表
CREATE TABLE user_favorites_recovery_stations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    station_id UUID NOT NULL REFERENCES recovery_stations(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE (user_id, station_id),
    INDEX idx_user (user_id)
);
```

### 2. Location Service - 恢复站发现与查询

```javascript
// backend/services/location-service/src/routes/recoveryStations.js

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const Redis = require('ioredis');
const { authenticate, rateLimiter } = require('../../../shared/middleware');
const { metrics } = require('../../../shared/metrics');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

/**
 * GET /api/v1/recovery-stations/nearby
 * 查询附近恢复站
 */
router.get('/nearby', authenticate, rateLimiter(100, 60), async (req, res) => {
    const { lat, lng, radius = 2000, limit = 20 } = req.query;
    const userId = req.user.id;
    
    if (!lat || !lng) {
        return res.status(400).json({ 
            error: 'MISSING_COORDINATES',
            message: 'Latitude and longitude are required' 
        });
    }
    
    try {
        const startTime = Date.now();
        
        // 尝试从 Redis GEO 缓存获取
        const cacheKey = `recovery:nearby:${lat}:${lng}:${radius}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            metrics.cacheHits.inc({ type: 'recovery_nearby' });
            return res.json(JSON.parse(cached));
        }
        
        // 查询附近恢复站
        const query = `
            SELECT 
                id, name, description, type, level,
                ST_AsGeoJSON(location)::json as location,
                recovery_speed_multiplier,
                bonus_effects,
                daily_usage_limit,
                status,
                rating,
                total_check_ins,
                ST_Distance(location, ST_MakePoint($1, $2)::geography) as distance
            FROM recovery_stations
            WHERE status = 'active'
            AND ST_DWithin(location, ST_MakePoint($1, $2)::geography, $3)
            ORDER BY distance
            LIMIT $4
        `;
        
        const result = await pool.query(query, [
            parseFloat(lng), parseFloat(lat), parseInt(radius), parseInt(limit)
        ]);
        
        const stations = result.rows.map(row => ({
            ...row,
            distance: Math.round(row.distance)
        }));
        
        const response = {
            success: true,
            data: stations,
            count: stations.length,
            center: { lat: parseFloat(lat), lng: parseFloat(lng) },
            radius: parseInt(radius)
        };
        
        // 缓存 5 分钟
        await redis.setex(cacheKey, 300, JSON.stringify(response));
        
        metrics.cacheMisses.inc({ type: 'recovery_nearby' });
        metrics.queryDuration.observe(
            { query: 'recovery_nearby' },
            (Date.now() - startTime) / 1000
        );
        
        res.json(response);
    } catch (error) {
        console.error('Nearby recovery stations query error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to query nearby recovery stations' 
        });
    }
});

/**
 * GET /api/v1/recovery-stations/:id
 * 获取恢复站详情
 */
router.get('/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    
    try {
        const query = `
            SELECT 
                rs.*,
                ST_AsGeoJSON(rs.location)::json as location,
                EXISTS(
                    SELECT 1 FROM user_favorites_recovery_stations 
                    WHERE user_id = $2 AND station_id = rs.id
                ) as is_favorite,
                (
                    SELECT COUNT(*) FROM recovery_check_ins 
                    WHERE user_id = $2 AND station_id = rs.id 
                    AND DATE(checked_in_at) = CURRENT_DATE
                ) as today_check_ins
            FROM recovery_stations rs
            WHERE rs.id = $1
        `;
        
        const result = await pool.query(query, [id, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: 'NOT_FOUND',
                message: 'Recovery station not found' 
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Recovery station detail query error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to get recovery station detail' 
        });
    }
});

/**
 * POST /api/v1/recovery-stations/:id/check-in
 * 恢复站签到
 */
router.post('/:id/check-in', authenticate, rateLimiter(10, 60), async (req, res) => {
    const { id: stationId } = req.params;
    const userId = req.user.id;
    const { lat, lng, pokemon_ids } = req.body;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 验证恢复站存在且激活
        const stationQuery = `
            SELECT * FROM recovery_stations 
            WHERE id = $1 AND status = 'active'
            FOR UPDATE
        `;
        const stationResult = await client.query(stationQuery, [stationId]);
        
        if (stationResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                error: 'NOT_FOUND',
                message: 'Recovery station not found or inactive' 
            });
        }
        
        const station = stationResult.rows[0];
        
        // 验证玩家位置（距离恢复站 100 米内）
        const distanceQuery = `
            SELECT ST_Distance(
                location,
                ST_MakePoint($1, $2)::geography
            ) as distance
            FROM recovery_stations
            WHERE id = $3
        `;
        const distanceResult = await client.query(distanceQuery, [
            parseFloat(lng), parseFloat(lat), stationId
        ]);
        
        const distance = distanceResult.rows[0].distance;
        
        if (distance > 100) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'TOO_FAR',
                message: 'You must be within 100 meters of the recovery station',
                distance: Math.round(distance)
            });
        }
        
        // 检查今日使用次数限制
        if (station.daily_usage_limit > 0) {
            const usageQuery = `
                SELECT COUNT(*) as count
                FROM recovery_check_ins
                WHERE user_id = $1 AND station_id = $2
                AND DATE(checked_in_at) = CURRENT_DATE
            `;
            const usageResult = await client.query(usageQuery, [userId, stationId]);
            
            if (parseInt(usageResult.rows[0].count) >= station.daily_usage_limit) {
                await client.query('ROLLBACK');
                return res.status(429).json({ 
                    error: 'DAILY_LIMIT_EXCEEDED',
                    message: 'Daily usage limit exceeded for this station',
                    limit: station.daily_usage_limit
                });
            }
        }
        
        // 恢复精灵
        const startTime = Date.now();
        let pokemonRecovered = 0;
        let hpRecovered = 0;
        let ppRecovered = 0;
        const statusHealed = {};
        
        if (pokemon_ids && pokemon_ids.length > 0) {
            // 恢复指定精灵
            for (const pokemonId of pokemon_ids) {
                const updateQuery = `
                    UPDATE pokemon
                    SET 
                        current_hp = max_hp,
                        current_pp = max_pp,
                        status_conditions = '[]'::jsonb,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND user_id = $2
                    RETURNING *
                `;
                const result = await client.query(updateQuery, [pokemonId, userId]);
                
                if (result.rows.length > 0) {
                    pokemonRecovered++;
                    hpRecovered += result.rows[0].max_hp;
                    ppRecovered += result.rows[0].max_pp;
                }
            }
        } else {
            // 恢复所有精灵
            const updateQuery = `
                UPDATE pokemon
                SET 
                    current_hp = max_hp,
                    current_pp = max_pp,
                    status_conditions = '[]'::jsonb,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $1
                RETURNING *
            `;
            const result = await client.query(updateQuery, [userId]);
            pokemonRecovered = result.rows.length;
            hpRecovered = result.rows.reduce((sum, p) => sum + p.max_hp, 0);
            ppRecovered = result.rows.reduce((sum, p) => sum + p.max_pp, 0);
        }
        
        // 计算恢复时间（基于精灵数量和恢复站等级）
        const recoveryDuration = Math.ceil(
            (pokemonRecovered * 2) / station.recovery_speed_multiplier
        );
        
        // 计算奖励
        const bonusItems = [];
        let bonusExperience = Math.floor(50 * station.recovery_speed_multiplier);
        
        // 高级恢复站额外奖励
        if (station.type === 'advanced' || station.type === 'premium') {
            bonusExperience = Math.floor(bonusExperience * 1.5);
            bonusItems.push({
                type: 'potion',
                quantity: 1,
                rarity: 'common'
            });
        }
        
        // 创建签到记录
        const checkInQuery = `
            INSERT INTO recovery_check_ins (
                user_id, station_id, pokemon_recovered,
                hp_recovered, pp_recovered, status_healed,
                bonus_items, bonus_experience, recovery_duration_seconds
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `;
        const checkInResult = await client.query(checkInQuery, [
            userId, stationId, pokemonRecovered,
            hpRecovered, ppRecovered, statusHealed,
            JSON.stringify(bonusItems), bonusExperience, recoveryDuration
        ]);
        
        // 更新恢复站统计
        await client.query(`
            UPDATE recovery_stations
            SET total_check_ins = total_check_ins + 1
            WHERE id = $1
        `, [stationId]);
        
        // 添加经验值到用户
        await client.query(`
            UPDATE users
            SET experience = experience + $1
            WHERE id = $2
        `, [bonusExperience, userId]);
        
        // 发送奖励物品
        for (const item of bonusItems) {
            await client.query(`
                INSERT INTO inventory (user_id, item_type, quantity)
                VALUES ($1, $2, $3)
                ON CONFLICT (user_id, item_type)
                DO UPDATE SET quantity = inventory.quantity + $3
            `, [userId, item.type, item.quantity]);
        }
        
        await client.query('COMMIT');
        
        // 发布事件
        const { publishEvent } = require('../../../shared/eventBus');
        await publishEvent('recovery.check_in', {
            userId,
            stationId,
            pokemonRecovered,
            hpRecovered,
            ppRecovered,
            bonusExperience,
            bonusItems,
            timestamp: new Date().toISOString()
        });
        
        // 更新指标
        metrics.checkInsTotal.inc({ station_type: station.type });
        metrics.pokemonRecovered.inc(pokemonRecovered);
        
        res.json({
            success: true,
            data: {
                check_in: checkInResult.rows[0],
                station: {
                    id: station.id,
                    name: station.name,
                    type: station.type
                },
                recovery_summary: {
                    pokemon_recovered: pokemonRecovered,
                    hp_recovered: hpRecovered,
                    pp_recovered: ppRecovered,
                    recovery_duration_seconds: recoveryDuration
                },
                rewards: {
                    experience: bonusExperience,
                    items: bonusItems
                }
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Recovery station check-in error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to check in at recovery station' 
        });
    } finally {
        client.release();
    }
});

/**
 * POST /api/v1/recovery-stations/:id/photos
 * 上传恢复站照片
 */
router.post('/:id/photos', authenticate, rateLimiter(5, 60), async (req, res) => {
    const { id: stationId } = req.params;
    const userId = req.user.id;
    const { photo_url, description } = req.body;
    
    try {
        const query = `
            INSERT INTO recovery_station_photos (
                station_id, user_id, photo_url, description
            ) VALUES ($1, $2, $3, $4)
            RETURNING *
        `;
        
        const result = await pool.query(query, [
            stationId, userId, photo_url, description
        ]);
        
        res.json({
            success: true,
            data: result.rows[0],
            message: 'Photo uploaded successfully, pending review'
        });
    } catch (error) {
        console.error('Photo upload error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to upload photo' 
        });
    }
});

/**
 * POST /api/v1/recovery-stations/:id/favorite
 * 收藏恢复站
 */
router.post('/:id/favorite', authenticate, async (req, res) => {
    const { id: stationId } = req.params;
    const userId = req.user.id;
    
    try {
        const query = `
            INSERT INTO user_favorites_recovery_stations (user_id, station_id)
            VALUES ($1, $2)
            ON CONFLICT (user_id, station_id) DO NOTHING
            RETURNING *
        `;
        
        const result = await pool.query(query, [userId, stationId]);
        
        if (result.rows.length === 0) {
            return res.status(409).json({ 
                error: 'ALREADY_FAVORITED',
                message: 'Recovery station is already in favorites' 
            });
        }
        
        res.json({
            success: true,
            message: 'Recovery station added to favorites'
        });
    } catch (error) {
        console.error('Favorite error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to add to favorites' 
        });
    }
});

/**
 * DELETE /api/v1/recovery-stations/:id/favorite
 * 取消收藏
 */
router.delete('/:id/favorite', authenticate, async (req, res) => {
    const { id: stationId } = req.params;
    const userId = req.user.id;
    
    try {
        const query = `
            DELETE FROM user_favorites_recovery_stations
            WHERE user_id = $1 AND station_id = $2
            RETURNING *
        `;
        
        const result = await pool.query(query, [userId, stationId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: 'NOT_FAVORITED',
                message: 'Recovery station is not in favorites' 
            });
        }
        
        res.json({
            success: true,
            message: 'Recovery station removed from favorites'
        });
    } catch (error) {
        console.error('Unfavorite error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to remove from favorites' 
        });
    }
});

/**
 * GET /api/v1/recovery-stations/favorites
 * 获取收藏的恢复站列表
 */
router.get('/favorites', authenticate, async (req, res) => {
    const userId = req.user.id;
    
    try {
        const query = `
            SELECT 
                rs.*,
                ST_AsGeoJSON(rs.location)::json as location,
                ufrs.created_at as favorited_at
            FROM user_favorites_recovery_stations ufrs
            JOIN recovery_stations rs ON ufrs.station_id = rs.id
            WHERE ufrs.user_id = $1
            ORDER BY ufrs.created_at DESC
        `;
        
        const result = await pool.query(query, [userId]);
        
        res.json({
            success: true,
            data: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('Favorites query error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to get favorites' 
        });
    }
});

/**
 * POST /api/v1/recovery-stations/:id/reviews
 * 添加恢复站评论
 */
router.post('/:id/reviews', authenticate, rateLimiter(3, 60), async (req, res) => {
    const { id: stationId } = req.params;
    const userId = req.user.id;
    const { rating, content } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ 
            error: 'INVALID_RATING',
            message: 'Rating must be between 1 and 5' 
        });
    }
    
    try {
        const query = `
            INSERT INTO recovery_station_reviews (station_id, user_id, rating, content)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (station_id, user_id)
            DO UPDATE SET 
                rating = EXCLUDED.rating,
                content = EXCLUDED.content,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;
        
        const result = await pool.query(query, [stationId, userId, rating, content]);
        
        // 更新恢复站平均评分
        await pool.query(`
            UPDATE recovery_stations
            SET rating = (
                SELECT AVG(rating)::decimal(3,2)
                FROM recovery_station_reviews
                WHERE station_id = $1 AND status = 'active'
            )
            WHERE id = $1
        `, [stationId]);
        
        res.json({
            success: true,
            data: result.rows[0],
            message: 'Review submitted successfully'
        });
    } catch (error) {
        console.error('Review submission error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to submit review' 
        });
    }
});

/**
 * GET /api/v1/recovery-stations/:id/reviews
 * 获取恢复站评论列表
 */
router.get('/:id/reviews', async (req, res) => {
    const { id: stationId } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    
    try {
        const query = `
            SELECT 
                rsr.*,
                u.username,
                u.avatar_url
            FROM recovery_station_reviews rsr
            JOIN users u ON rsr.user_id = u.id
            WHERE rsr.station_id = $1 AND rsr.status = 'active'
            ORDER BY rsr.created_at DESC
            LIMIT $2 OFFSET $3
        `;
        
        const result = await pool.query(query, [
            stationId, parseInt(limit), parseInt(offset)
        ]);
        
        res.json({
            success: true,
            data: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('Reviews query error:', error);
        res.status(500).json({ 
            error: 'INTERNAL_ERROR',
            message: 'Failed to get reviews' 
        });
    }
});

module.exports = router;
```

### 3. Pokemon Service - 精灵恢复逻辑

```javascript
// backend/services/pokemon-service/src/utils/recovery.js

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * 恢复精灵状态
 * @param {string} userId - 用户ID
 * @param {string[]} pokemonIds - 精灵ID列表（可选）
 * @param {Object} options - 恢复选项
 * @returns {Object} 恢复结果
 */
async function recoverPokemon(userId, pokemonIds = null, options = {}) {
    const {
        recoverHP = true,
        recoverPP = true,
        healStatus = true,
        speedMultiplier = 1.0
    } = options;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        let query, params;
        
        if (pokemonIds && pokemonIds.length > 0) {
            // 恢复指定精灵
            query = `
                UPDATE pokemon
                SET 
                    ${recoverHP ? 'current_hp = max_hp,' : ''}
                    ${recoverPP ? 'current_pp = max_pp,' : ''}
                    ${healStatus ? "status_conditions = '[]'::jsonb," : ''}
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ANY($1) AND user_id = $2
                RETURNING *
            `;
            params = [pokemonIds, userId];
        } else {
            // 恢复所有精灵
            query = `
                UPDATE pokemon
                SET 
                    ${recoverHP ? 'current_hp = max_hp,' : ''}
                    ${recoverPP ? 'current_pp = max_pp,' : ''}
                    ${healStatus ? "status_conditions = '[]'::jsonb," : ''}
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $1
                RETURNING *
            `;
            params = [userId];
        }
        
        const result = await client.query(query, params);
        
        await client.query('COMMIT');
        
        return {
            success: true,
            pokemon_recovered: result.rows.length,
            hp_recovered: result.rows.reduce((sum, p) => sum + p.max_hp, 0),
            pp_recovered: result.rows.reduce((sum, p) => sum + p.max_pp, 0),
            pokemon: result.rows
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * 检查精灵是否需要恢复
 * @param {string} pokemonId - 精灵ID
 * @returns {Object} 恢复需求
 */
async function checkRecoveryNeeded(pokemonId) {
    const query = `
        SELECT 
            id,
            current_hp,
            max_hp,
            current_pp,
            max_pp,
            status_conditions,
            CASE 
                WHEN current_hp < max_hp THEN true 
                ELSE false 
            END as needs_hp_recovery,
            CASE 
                WHEN current_pp < max_pp THEN true 
                ELSE false 
            END as needs_pp_recovery,
            CASE 
                WHEN jsonb_array_length(status_conditions) > 0 THEN true 
                ELSE false 
            END as needs_status_heal
        FROM pokemon
        WHERE id = $1
    `;
    
    const result = await pool.query(query, [pokemonId]);
    
    if (result.rows.length === 0) {
        return null;
    }
    
    return result.rows[0];
}

/**
 * 批量检查精灵恢复需求
 * @param {string} userId - 用户ID
 * @returns {Object[]} 恢复需求列表
 */
async function batchCheckRecoveryNeeded(userId) {
    const query = `
        SELECT 
            id,
            nickname,
            pokemon_type,
            current_hp,
            max_hp,
            current_pp,
            max_pp,
            status_conditions,
            CASE 
                WHEN current_hp < max_hp THEN true 
                ELSE false 
            END as needs_hp_recovery,
            CASE 
                WHEN current_pp < max_pp THEN true 
                ELSE false 
            END as needs_pp_recovery,
            CASE 
                WHEN jsonb_array_length(status_conditions) > 0 THEN true 
                ELSE false 
            END as needs_status_heal,
            ROUND((current_hp::decimal / max_hp) * 100, 2) as hp_percentage
        FROM pokemon
        WHERE user_id = $1
        ORDER BY 
            CASE WHEN current_hp < max_hp THEN 0 ELSE 1 END,
            current_hp ASC
    `;
    
    const result = await pool.query(query, [userId]);
    
    return result.rows;
}

module.exports = {
    recoverPokemon,
    checkRecoveryNeeded,
    batchCheckRecoveryNeeded
};
```

### 4. 前端实现 - 恢复站地图组件

```javascript
// game-client/src/components/RecoveryStation/RecoveryStationMap.jsx

import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { Icon } from 'leaflet';
import { useGeolocation } from '../../hooks/useGeolocation';
import { api } from '../../utils/api';
import './RecoveryStationMap.css';

// 恢复站图标
const recoveryStationIcon = new Icon({
    iconUrl: '/icons/recovery-station.png',
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -40]
});

const premiumStationIcon = new Icon({
    iconUrl: '/icons/recovery-station-premium.png',
    iconSize: [48, 48],
    iconAnchor: [24, 48],
    popupAnchor: [0, -48]
});

function RecoveryStationMap() {
    const { position, error } = useGeolocation();
    const [stations, setStations] = useState([]);
    const [selectedStation, setSelectedStation] = useState(null);
    const [loading, setLoading] = useState(true);
    const [radius, setRadius] = useState(2000);
    
    // 获取附近恢复站
    const fetchNearbyStations = useCallback(async () => {
        if (!position) return;
        
        try {
            const response = await api.get('/recovery-stations/nearby', {
                params: {
                    lat: position.lat,
                    lng: position.lng,
                    radius: radius
                }
            });
            
            setStations(response.data.data);
            setLoading(false);
        } catch (error) {
            console.error('Failed to fetch recovery stations:', error);
            setLoading(false);
        }
    }, [position, radius]);
    
    useEffect(() => {
        fetchNearbyStations();
    }, [fetchNearbyStations]);
    
    // 签到恢复站
    const handleCheckIn = async (stationId) => {
        if (!position) {
            alert('无法获取当前位置');
            return;
        }
        
        try {
            const response = await api.post(`/recovery-stations/${stationId}/check-in`, {
                lat: position.lat,
                lng: position.lng
            });
            
            const { data } = response.data;
            
            // 显示恢复结果
            alert(`恢复成功！\n恢复精灵：${data.recovery_summary.pokemon_recovered} 只\n恢复 HP：${data.recovery_summary.hp_recovered}\n恢复 PP：${data.recovery_summary.pp_recovered}\n获得经验：${data.rewards.experience}`);
            
            // 刷新附近恢复站列表
            fetchNearbyStations();
        } catch (error) {
            const errorMsg = error.response?.data?.message || '签到失败';
            alert(errorMsg);
        }
    };
    
    // 收藏恢复站
    const handleFavorite = async (stationId, isFavorite) => {
        try {
            if (isFavorite) {
                await api.delete(`/recovery-stations/${stationId}/favorite`);
            } else {
                await api.post(`/recovery-stations/${stationId}/favorite`);
            }
            
            // 更新本地状态
            setStations(stations.map(s => 
                s.id === stationId 
                    ? { ...s, is_favorite: !isFavorite }
                    : s
            ));
        } catch (error) {
            console.error('Favorite operation failed:', error);
        }
    };
    
    return (
        <div className="recovery-station-container">
            <div className="recovery-station-header">
                <h2>精灵恢复站</h2>
                <div className="radius-selector">
                    <label>搜索半径：</label>
                    <select value={radius} onChange={(e) => setRadius(parseInt(e.target.value))}>
                        <option value={1000}>1 公里</option>
                        <option value={2000}>2 公里</option>
                        <option value={5000}>5 公里</option>
                        <option value={10000}>10 公里</option>
                    </select>
                </div>
            </div>
            
            {loading && <div className="loading">加载中...</div>}
            
            {!loading && stations.length === 0 && (
                <div className="no-stations">附近没有发现恢复站</div>
            )}
            
            <MapContainer
                center={position || [39.9042, 116.4074]}
                zoom={15}
                className="recovery-station-map"
            >
                <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                />
                
                {position && (
                    <Marker position={[position.lat, position.lng]}>
                        <Popup>你的位置</Popup>
                    </Marker>
                )}
                
                {stations.map(station => (
                    <Marker
                        key={station.id}
                        position={[
                            station.location.coordinates[1],
                            station.location.coordinates[0]
                        ]}
                        icon={station.type === 'premium' ? premiumStationIcon : recoveryStationIcon}
                        eventHandlers={{
                            click: () => setSelectedStation(station)
                        }}
                    >
                        <Popup>
                            <div className="station-popup">
                                <h3>{station.name}</h3>
                                <p className="station-type">{getStationTypeLabel(station.type)}</p>
                                <p className="station-distance">{station.distance} 米</p>
                                <div className="station-actions">
                                    <button 
                                        className="check-in-btn"
                                        onClick={() => handleCheckIn(station.id)}
                                        disabled={station.distance > 100}
                                    >
                                        {station.distance > 100 ? '距离过远' : '恢复精灵'}
                                    </button>
                                    <button 
                                        className={`favorite-btn ${station.is_favorite ? 'favorited' : ''}`}
                                        onClick={() => handleFavorite(station.id, station.is_favorite)}
                                    >
                                        {station.is_favorite ? '❤️' : '🤍'}
                                    </button>
                                </div>
                            </div>
                        </Popup>
                    </Marker>
                ))}
            </MapContainer>
            
            {/* 恢复站列表 */}
            <div className="station-list">
                <h3>附近恢复站 ({stations.length})</h3>
                {stations.map(station => (
                    <div 
                        key={station.id} 
                        className={`station-card ${station.type}`}
                        onClick={() => setSelectedStation(station)}
                    >
                        <div className="station-info">
                            <h4>{station.name}</h4>
                            <p className="station-meta">
                                <span className="distance">{station.distance} 米</span>
                                <span className="rating">⭐ {station.rating || '暂无评分'}</span>
                                <span className="type">{getStationTypeLabel(station.type)}</span>
                            </p>
                        </div>
                        <div className="station-stats">
                            <p>累计签到：{station.total_check_ins}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function getStationTypeLabel(type) {
    const labels = {
        normal: '普通恢复站',
        advanced: '高级恢复站',
        premium: '会员恢复站',
        event: '活动恢复站'
    };
    return labels[type] || type;
}

export default RecoveryStationMap;
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics.js 中的恢复站指标

const client = require('prom-client');

// 恢复站签到总数
const checkInsTotal = new client.Counter({
    name: 'recovery_check_ins_total',
    help: 'Total number of recovery station check-ins',
    labelNames: ['station_type', 'station_level']
});

// 恢复精灵总数
const pokemonRecovered = new client.Counter({
    name: 'pokemon_recovered_total',
    help: 'Total number of Pokemon recovered at recovery stations'
});

// 恢复站查询次数
const stationQueries = new client.Counter({
    name: 'recovery_station_queries_total',
    help: 'Total number of recovery station queries',
    labelNames: ['query_type']
});

// 恢复站照片上传数
const photoUploads = new client.Counter({
    name: 'recovery_station_photo_uploads_total',
    help: 'Total number of recovery station photo uploads',
    labelNames: ['status']
});

// 恢复站评论数
const reviewsTotal = new client.Counter({
    name: 'recovery_station_reviews_total',
    help: 'Total number of recovery station reviews'
});

module.exports = {
    checkInsTotal,
    pokemonRecovered,
    stationQueries,
    photoUploads,
    reviewsTotal
};
```

## 验收标准

- [ ] 数据库表创建成功（5张表）
- [ ] 恢复站附近查询 API 正常工作（/api/v1/recovery-stations/nearby）
- [ ] 恢复站详情查询 API 正常工作（/api/v1/recovery-stations/:id）
- [ ] 恢复站签到 API 正常工作（/api/v1/recovery-stations/:id/check-in）
- [ ] 恢复站照片上传 API 正常工作（/api/v1/recovery-stations/:id/photos）
- [ ] 恢复站收藏/取消收藏 API 正常工作
- [ ] 恢复站评论 API 正常工作
- [ ] 精灵恢复逻辑正常（HP、PP、状态异常全部恢复）
- [ ] 位置验证功能正常（100米限制）
- [ ] 每日使用次数限制功能正常
- [ ] Redis 缓存正常工作（附近查询缓存）
- [ ] Prometheus 指标正常收集（5个指标）
- [ ] 前端恢复站地图组件正常显示
- [ ] 前端签到流程正常（位置验证、恢复动画）
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试通过
- [ ] API 文档更新
- [ ] 性能测试通过（附近查询 < 100ms）

## 影响范围

- **新增文件**：
  - `backend/services/location-service/src/routes/recoveryStations.js`
  - `backend/services/pokemon-service/src/utils/recovery.js`
  - `game-client/src/components/RecoveryStation/`（地图组件）
  - `database/migrations/040_create_recovery_stations.sql`
  
- **修改文件**：
  - `backend/services/location-service/src/index.js`（挂载路由）
  - `backend/shared/metrics.js`（新增恢复站指标）
  - `game-client/src/router/index.js`（新增恢复站路由）
  
- **新增 API 端点**：10 个
  - GET /api/v1/recovery-stations/nearby
  - GET /api/v1/recovery-stations/:id
  - POST /api/v1/recovery-stations/:id/check-in
  - POST /api/v1/recovery-stations/:id/photos
  - GET /api/v1/recovery-stations/:id/photos
  - POST /api/v1/recovery-stations/:id/favorite
  - DELETE /api/v1/recovery-stations/:id/favorite
  - GET /api/v1/recovery-stations/favorites
  - POST /api/v1/recovery-stations/:id/reviews
  - GET /api/v1/recovery-stations/:id/reviews

## 参考

- Pokemon GO 恢复站机制
- Pokemon GO Gym 系统
- Pokemon GO PokeStop 系统
- GeoJSON 规范
- Leaflet 地图库文档
- PostGIS GEOGRAPHY 类型文档
