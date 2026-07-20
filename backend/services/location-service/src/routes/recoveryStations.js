// REQ-00156: 精灵恢复站系统 - Location Service 路由
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

/**
 * GET /recovery-stations/nearby
 * 查询附近恢复站
 */
router.get('/nearby', requireAuth, async (req, res, next) => {
    const { lat, lng, radius = 2000, limit = 20 } = req.query;
    const userId = req.user.sub;

    if (!lat || !lng) {
        throw new AppError(4001, '经纬度参数缺失', 400);
    }

    try {
        const startTime = Date.now();

        // 尝试从 Redis GEO 缓存获取
        const cacheKey = `recovery:nearby:${lat}:${lng}:${radius}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return res.json(successResp(JSON.parse(cached)));
        }

        // 查询附近恢复站
        const { rows } = await query(`
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
        `, [parseFloat(lng), parseFloat(lat), parseInt(radius), parseInt(limit)]);

        const stations = rows.map(row => ({
            ...row,
            distance: Math.round(row.distance)
        }));

        // 缓存 5 分钟
        await redis.setex(cacheKey, 300, JSON.stringify(stations));

        res.json(successResp({
            stations,
            count: stations.length,
            center: { lat: parseFloat(lat), lng: parseFloat(lng) },
            radius: parseInt(radius)
        }));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /recovery-stations/:id
 * 获取恢复站详情
 */
router.get('/:id', requireAuth, async (req, res, next) => {
    const { id } = req.params;
    const userId = req.user.sub;

    try {
        const { rows } = await query(`
            SELECT 
                rs.*,
                ST_AsGeoJSON(rs.location)::json as location,
                EXISTS(
                    SELECT 1 FROM user_favorites_recovery_stations 
                    WHERE user_id = $2 AND station_id = rs.id
                ) as is_favorite
            FROM recovery_stations rs
            WHERE rs.id = $1
        `, [id, userId]);

        if (rows.length === 0) {
            throw new AppError(4002, '恢复站不存在', 404);
        }

        res.json(successResp(rows[0]));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /recovery-stations/:id/check-in
 * 恢复站签到
 */
router.post('/:id/check-in', requireAuth, async (req, res, next) => {
    const { id: stationId } = req.params;
    const userId = req.user.sub;
    const { lat, lng, pokemon_ids } = req.body;

    try {
        // 验证恢复站存在且激活
        const { rows: [station] } = await query(`
            SELECT * FROM recovery_stations 
            WHERE id = $1 AND status = 'active'
        `, [stationId]);

        if (!station) {
            throw new AppError(4002, '恢复站不存在或未激活', 404);
        }

        // 验证玩家位置（距离恢复站 100 米内）
        const { rows: [{ distance }] } = await query(`
            SELECT ST_Distance(
                location,
                ST_MakePoint($1, $2)::geography
            ) as distance
            FROM recovery_stations
            WHERE id = $3
        `, [parseFloat(lng), parseFloat(lat), stationId]);

        if (distance > 100) {
            throw new AppError(4003, `距离恢复站过远（当前 ${Math.round(distance)} 米，需在 100 米内）`, 400);
        }

        // 检查今日使用次数限制
        if (station.daily_usage_limit > 0) {
            const { rows: [{ count }] } = await query(`
                SELECT COUNT(*)::int as count
                FROM recovery_check_ins
                WHERE user_id = $1 AND station_id = $2
                AND DATE(checked_in_at) = CURRENT_DATE
            `, [userId, stationId]);

            if (count >= station.daily_usage_limit) {
                throw new AppError(4004, `今日使用次数已达上限（${station.daily_usage_limit} 次）`, 429);
            }
        }

        // 恢复精灵
        let pokemonRecovered = 0;
        let hpRecovered = 0;
        let ppRecovered = 0;

        if (pokemon_ids && pokemon_ids.length > 0) {
            // 恢复指定精灵
            const { rows } = await query(`
                UPDATE pokemon_instances
                SET 
                    hp_current = hp_max,
                    updated_at = NOW()
                WHERE id = ANY($1) AND user_id = $2
                RETURNING hp_max
            `, [pokemon_ids, userId]);

            pokemonRecovered = rows.length;
            hpRecovered = rows.reduce((sum, p) => sum + p.hp_max, 0);
        } else {
            // 恢复所有精灵
            const { rows } = await query(`
                UPDATE pokemon_instances
                SET 
                    hp_current = hp_max,
                    updated_at = NOW()
                WHERE user_id = $1
                RETURNING hp_max
            `, [userId]);

            pokemonRecovered = rows.length;
            hpRecovered = rows.reduce((sum, p) => sum + p.hp_max, 0);
        }

        // 计算恢复时间
        const recoveryDuration = Math.ceil(
            (pokemonRecovered * 2) / station.recovery_speed_multiplier
        );

        // 计算奖励
        const bonusItems = [];
        let bonusExperience = Math.floor(50 * station.recovery_speed_multiplier);

        // 高级恢复站额外奖励
        if (station.type === 'advanced' || station.type === 'premium') {
            bonusExperience = Math.floor(bonusExperience * 1.5);
            if (Math.random() < 0.3) {
                bonusItems.push({ type: 'POTION', quantity: 1 });
            }
        }

        // 创建签到记录
        await query(`
            INSERT INTO recovery_check_ins (
                user_id, station_id, pokemon_recovered,
                hp_recovered, pp_recovered, status_healed,
                bonus_items, bonus_experience, recovery_duration_seconds
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [userId, stationId, pokemonRecovered, hpRecovered, ppRecovered, {}, JSON.stringify(bonusItems), bonusExperience, recoveryDuration]);

        // 更新恢复站统计
        await query(`
            UPDATE recovery_stations
            SET total_check_ins = total_check_ins + 1
            WHERE id = $1
        `, [stationId]);

        // 添加经验值
        await query('UPDATE users SET xp = xp + $1 WHERE id = $2', [bonusExperience, userId]);

        res.json(successResp({
            station: {
                id: station.id,
                name: station.name,
                type: station.type
            },
            recovery: {
                pokemon_recovered: pokemonRecovered,
                hp_recovered: hpRecovered,
                pp_recovered: ppRecovered,
                duration_seconds: recoveryDuration
            },
            rewards: {
                experience: bonusExperience,
                items: bonusItems
            }
        }, '恢复成功！'));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /recovery-stations/:id/favorite
 * 收藏恢复站
 */
router.post('/:id/favorite', requireAuth, async (req, res, next) => {
    const { id: stationId } = req.params;
    const userId = req.user.sub;

    try {
        await query(`
            INSERT INTO user_favorites_recovery_stations (user_id, station_id)
            VALUES ($1, $2)
            ON CONFLICT (user_id, station_id) DO NOTHING
        `, [userId, stationId]);

        res.json(successResp(null, '已收藏恢复站'));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /recovery-stations/:id/favorite
 * 取消收藏
 */
router.delete('/:id/favorite', requireAuth, async (req, res, next) => {
    const { id: stationId } = req.params;
    const userId = req.user.sub;

    try {
        const { rowCount } = await query(`
            DELETE FROM user_favorites_recovery_stations
            WHERE user_id = $1 AND station_id = $2
        `, [userId, stationId]);

        if (rowCount === 0) {
            throw new AppError(4005, '未收藏该恢复站', 404);
        }

        res.json(successResp(null, '已取消收藏'));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /recovery-stations/favorites
 * 获取收藏的恢复站列表
 */
router.get('/favorites', requireAuth, async (req, res, next) => {
    const userId = req.user.sub;

    try {
        const { rows } = await query(`
            SELECT 
                rs.*,
                ST_AsGeoJSON(rs.location)::json as location,
                ufrs.created_at as favorited_at
            FROM user_favorites_recovery_stations ufrs
            JOIN recovery_stations rs ON ufrs.station_id = rs.id
            WHERE ufrs.user_id = $1
            ORDER BY ufrs.created_at DESC
        `, [userId]);

        res.json(successResp({ stations: rows, count: rows.length }));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /recovery-stations/:id/reviews
 * 添加恢复站评论
 */
router.post('/:id/reviews', requireAuth, async (req, res, next) => {
    const { id: stationId } = req.params;
    const userId = req.user.sub;
    const { rating, content } = req.body;

    if (!rating || rating < 1 || rating > 5) {
        throw new AppError(4006, '评分必须在 1-5 之间', 400);
    }

    try {
        await query(`
            INSERT INTO recovery_station_reviews (station_id, user_id, rating, content)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (station_id, user_id)
            DO UPDATE SET 
                rating = EXCLUDED.rating,
                content = EXCLUDED.content,
                updated_at = NOW()
        `, [stationId, userId, rating, content]);

        // 更新恢复站平均评分
        await query(`
            UPDATE recovery_stations
            SET rating = (
                SELECT AVG(rating)::decimal(3,2)
                FROM recovery_station_reviews
                WHERE station_id = $1 AND status = 'active'
            )
            WHERE id = $1
        `, [stationId]);

        res.json(successResp(null, '评论成功'));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /recovery-stations/:id/reviews
 * 获取恢复站评论列表
 */
router.get('/:id/reviews', async (req, res, next) => {
    const { id: stationId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    try {
        const { rows } = await query(`
            SELECT 
                rsr.*,
                u.username
            FROM recovery_station_reviews rsr
            JOIN users u ON rsr.user_id = u.id
            WHERE rsr.station_id = $1 AND rsr.status = 'active'
            ORDER BY rsr.created_at DESC
            LIMIT $2 OFFSET $3
        `, [stationId, parseInt(limit), parseInt(offset)]);

        res.json(successResp({ reviews: rows, count: rows.length }));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
