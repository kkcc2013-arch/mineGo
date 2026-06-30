# REQ-00388: 玩家好友互动增强系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00388 |
| 标题 | 玩家好友互动增强系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、user-service、pokemon-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-30 13:00 UTC |

## 需求描述

实现一个完整的玩家好友互动增强系统，提供好友推荐、互动提醒、亲密度管理、礼物赠送、联合任务等功能，提升玩家社交体验和游戏粘性。

### 核心功能
1. **智能好友推荐**：基于地理位置、游戏活跃度、精灵类型偏好等多维度推荐好友
2. **互动提醒中心**：好友上线提醒、生日提醒、成就解锁提醒、道馆邀请等
3. **好友亲密度系统**：互动频率、礼物赠送、联合战斗等提升亲密度等级
4. **礼物赠送系统**：道具、精灵蛋、金币等礼物赠送，包含包装和祝福语
5. **联合任务系统**：好友组队完成专属任务，获得额外奖励
6. **好友动态流**：查看好友最近的游戏动态、成就、捕捉记录等

## 技术方案

### 1. 数据库设计

```sql
-- 好友关系扩展表
CREATE TABLE friend_relationships (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    intimacy_level INTEGER NOT NULL DEFAULT 1 CHECK(intimacy_level BETWEEN 1 AND 10),
    intimacy_points INTEGER NOT NULL DEFAULT 0,
    last_interaction_at TIMESTAMPTZ,
    favorite BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, friend_id),
    CHECK(user_id != friend_id)
);

CREATE INDEX idx_friend_relationships_user ON friend_relationships(user_id, intimacy_level DESC);
CREATE INDEX idx_friend_relationships_friend ON friend_relationships(friend_id);

-- 好友亲密度等级配置表
CREATE TABLE intimacy_levels (
    level INTEGER PRIMARY KEY CHECK(level BETWEEN 1 AND 10),
    min_points INTEGER NOT NULL,
    max_points INTEGER NOT NULL,
    level_name VARCHAR(50) NOT NULL,
    benefits JSONB NOT NULL DEFAULT '{}',
    badge_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 好友互动记录表
CREATE TABLE friend_interactions (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    interaction_type VARCHAR(50) NOT NULL CHECK(interaction_type IN (
        'gift_send', 'gift_receive', 'battle_together', 'trade', 
        'joint_mission', 'visit_profile', 'like_post', 'send_message'
    )),
    intimacy_points_change INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    interacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (interacted_at);

-- 创建分区索引
CREATE INDEX idx_friend_interactions_user_friend ON friend_interactions(user_id, friend_id, interacted_at DESC);
CREATE INDEX idx_friend_interactions_type ON friend_interactions(interaction_type, interacted_at DESC);

-- 礼物配置表
CREATE TABLE gift_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    gift_type VARCHAR(30) NOT NULL CHECK(gift_type IN ('item', 'pokemon_egg', 'currency', 'special')),
    item_id INTEGER, -- 对应具体道具ID
    rarity VARCHAR(20) NOT NULL DEFAULT 'common',
    wrapping_paper_ids INTEGER[] NOT NULL DEFAULT '{}',
    icon_url TEXT NOT NULL,
    required_intimacy_level INTEGER NOT NULL DEFAULT 1,
    daily_limit INTEGER, -- NULL表示无限制
    is_seasonal BOOLEAN NOT NULL DEFAULT false,
    season_start DATE,
    season_end DATE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 礼物赠送记录表
CREATE TABLE gift_transactions (
    id BIGSERIAL PRIMARY KEY,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gift_type_id INTEGER NOT NULL REFERENCES gift_types(id),
    wrapping_paper_id INTEGER,
    message TEXT CHECK(LENGTH(message) <= 200),
    is_anonymous BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')),
    intimacy_points_awarded INTEGER NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
) PARTITION BY RANGE (sent_at);

CREATE INDEX idx_gift_transactions_sender ON gift_transactions(sender_id, sent_at DESC);
CREATE INDEX idx_gift_transactions_receiver ON gift_transactions(receiver_id, status, sent_at DESC);

-- 联合任务表
CREATE TABLE joint_missions (
    id SERIAL PRIMARY KEY,
    mission_type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    requirements JSONB NOT NULL DEFAULT '{}',
    rewards JSONB NOT NULL DEFAULT '{}',
    required_intimacy_level INTEGER NOT NULL DEFAULT 1,
    time_limit_hours INTEGER,
    difficulty VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK(difficulty IN ('easy', 'medium', 'hard', 'legendary')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 联合任务进度表
CREATE TABLE joint_mission_progress (
    id BIGSERIAL PRIMARY KEY,
    mission_id INTEGER NOT NULL REFERENCES joint_missions(id),
    user1_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    progress_user1 JSONB NOT NULL DEFAULT '{}',
    progress_user2 JSONB NOT NULL DEFAULT '{}',
    combined_progress JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'failed', 'expired')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    UNIQUE(mission_id, user1_id, user2_id)
);

CREATE INDEX idx_joint_mission_progress_users ON joint_mission_progress(user1_id, user2_id, status);
CREATE INDEX idx_joint_mission_progress_status ON joint_mission_progress(status, expires_at);

-- 好友动态表
CREATE TABLE friend_activities (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_type VARCHAR(50) NOT NULL CHECK(activity_type IN (
        'catch_pokemon', 'battle_win', 'gym_conquer', 'achievement_unlock',
        'level_up', 'friend_add', 'gift_receive', 'joint_mission_complete'
    )),
    content JSONB NOT NULL DEFAULT '{}',
    visibility VARCHAR(20) NOT NULL DEFAULT 'friends' CHECK(visibility IN ('public', 'friends', 'private')),
    like_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_friend_activities_user ON friend_activities(user_id, created_at DESC);
CREATE INDEX idx_friend_activities_feed ON friend_activities(activity_type, created_at DESC);

-- 好友推荐表
CREATE TABLE friend_recommendations (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recommended_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recommendation_reason VARCHAR(50) NOT NULL CHECK(recommendation_reason IN (
        'location_nearby', 'similar_level', 'similar_pokemon_types',
        'mutual_friends', 'active_recently', 'joint_gym_interest'
    )),
    score FLOAT NOT NULL DEFAULT 0,
    is_dismissed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    UNIQUE(user_id, recommended_user_id)
);

CREATE INDEX idx_friend_recommendations_user ON friend_recommendations(user_id, is_dismissed, score DESC);

-- 互动提醒表
CREATE TABLE interaction_reminders (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reminder_type VARCHAR(50) NOT NULL CHECK(reminder_type IN (
        'friend_online', 'birthday', 'achievement_unlocked',
        'gym_invite', 'gift_received', 'joint_mission_invite',
        'intimacy_level_up', 'long_time_no_see'
    )),
    related_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    content JSONB NOT NULL DEFAULT '{}',
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_interaction_reminders_user ON interaction_reminders(user_id, is_read, created_at DESC);

-- 初始化亲密度等级配置
INSERT INTO intimacy_levels (level, min_points, max_points, level_name, benefits) VALUES
(1, 0, 99, '陌生人', '{"gift_types": ["basic"]}'::jsonb),
(2, 100, 299, '点头之交', '{"gift_types": ["basic", "standard"]}'::jsonb),
(3, 300, 599, '泛泛之交', '{"joint_missions": true}'::jsonb),
(4, 600, 999, '普通朋友', '{"gift_types": ["basic", "standard", "premium"]}'::jsonb),
(5, 1000, 1499, '好友', '{"bonus_rewards": 1.1}'::jsonb),
(6, 1500, 2199, '好朋友', '{"bonus_rewards": 1.15}'::jsonb),
(7, 2200, 2999, '密友', '{"exclusive_missions": true}'::jsonb),
(8, 3000, 3999, '挚友', '{"bonus_rewards": 1.25}'::jsonb),
(9, 4000, 4999, '知己', '{"special_gifts": true}'::jsonb),
(10, 5000, 999999, '生死之交', '{"all_benefits": true, "bonus_rewards": 1.5}'::jsonb);
```

### 2. social-service 核心实现

```javascript
// backend/services/social-service/routes/friendInteractionRoutes.js
const express = require('express');
const router = express.Router();
const friendInteractionController = require('../controllers/friendInteractionController');
const authMiddleware = require('../../../shared/middleware/auth');
const rateLimiter = require('../../../shared/middleware/rateLimiter');

/**
 * @route POST /api/v1/friends/recommendations
 * @desc 获取好友推荐列表
 * @access Private
 */
router.get('/recommendations',
    authMiddleware,
    rateLimiter('friend_recommendations', 30, 60),
    friendInteractionController.getRecommendations
);

/**
 * @route POST /api/v1/friends/:friendId/gift
 * @desc 发送礼物给好友
 * @access Private
 */
router.post('/:friendId/gift',
    authMiddleware,
    rateLimiter('gift_send', 10, 60),
    friendInteractionController.sendGift
);

/**
 * @route POST /api/v1/friends/gifts/:giftId/respond
 * @desc 接受/拒绝礼物
 * @access Private
 */
router.post('/gifts/:giftId/respond',
    authMiddleware,
    friendInteractionController.respondToGift
);

/**
 * @route GET /api/v1/friends/:friendId/intimacy
 * @desc 获取好友亲密度详情
 * @access Private
 */
router.get('/:friendId/intimacy',
    authMiddleware,
    friendInteractionController.getIntimacy
);

/**
 * @route POST /api/v1/friends/joint-mission/start
 * @desc 发起联合任务
 * @access Private
 */
router.post('/joint-mission/start',
    authMiddleware,
    rateLimiter('joint_mission_start', 5, 60),
    friendInteractionController.startJointMission
);

/**
 * @route GET /api/v1/friends/activities/feed
 * @desc 获取好友动态流
 * @access Private
 */
router.get('/activities/feed',
    authMiddleware,
    friendInteractionController.getActivityFeed
);

/**
 * @route POST /api/v1/friends/:friendId/interact
 * @desc 记录好友互动
 * @access Private
 */
router.post('/:friendId/interact',
    authMiddleware,
    friendInteractionController.recordInteraction
);

/**
 * @route GET /api/v1/friends/reminders
 * @desc 获取互动提醒列表
 * @access Private
 */
router.get('/reminders',
    authMiddleware,
    friendInteractionController.getReminders
);

/**
 * @route GET /api/v1/friends/:friendId/profile
 * @desc 查看好友资料卡
 * @access Private
 */
router.get('/:friendId/profile',
    authMiddleware,
    friendInteractionController.viewFriendProfile
);

module.exports = router;
```

```javascript
// backend/services/social-service/controllers/friendInteractionController.js
const db = require('../../../shared/database/postgres');
const redis = require('../../../shared/database/redis');
const { emitToUser } = require('../../../shared/websocket');
const { validateRequired, sanitizeInput } = require('../../../shared/validators');
const logger = require('../../../shared/logger');

class FriendInteractionController {
    /**
     * 获取好友推荐
     */
    async getRecommendations(req, res) {
        try {
            const userId = req.user.id;
            const limit = parseInt(req.query.limit) || 10;
            
            // 检查缓存
            const cacheKey = `friend_recommendations:${userId}`;
            const cached = await redis.get(cacheKey);
            if (cached) {
                return res.json({ recommendations: JSON.parse(cached) });
            }
            
            // 获取多维度推荐
            const recommendations = await this._calculateRecommendations(userId, limit);
            
            // 缓存1小时
            await redis.setex(cacheKey, 3600, JSON.stringify(recommendations));
            
            res.json({ recommendations });
        } catch (error) {
            logger.error('获取好友推荐失败', { error: error.message, userId: req.user.id });
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取推荐失败' });
        }
    }

    /**
     * 计算好友推荐
     */
    async _calculateRecommendations(userId, limit) {
        const recommendations = [];
        
        // 1. 基于地理位置的推荐
        const locationRecs = await db.query(`
            SELECT 
                u.id, u.username, u.avatar_url, u.level,
                'location_nearby' as reason,
                50 as base_score,
                ST_Distance(u.last_location, current_user.last_location) as distance
            FROM users u
            CROSS JOIN (SELECT last_location FROM users WHERE id = $1) current_user
            WHERE u.id != $1
            AND u.is_active = true
            AND u.privacy_settings->>'location_visible' = 'true'
            AND ST_DWithin(u.last_location, current_user.last_location, 5000)
            AND u.id NOT IN (
                SELECT friend_id FROM friend_relationships WHERE user_id = $1
                UNION
                SELECT user_id FROM friend_relationships WHERE friend_id = $1
                UNION
                SELECT $1
            )
            ORDER BY distance
            LIMIT $2
        `, [userId, Math.ceil(limit / 3)]);
        
        recommendations.push(...locationRecs.rows);
        
        // 2. 基于相似等级的推荐
        const levelRecs = await db.query(`
            SELECT 
                u.id, u.username, u.avatar_url, u.level,
                'similar_level' as reason,
                40 as base_score,
                ABS(u.level - current_user.level) as level_diff
            FROM users u
            CROSS JOIN (SELECT level FROM users WHERE id = $1) current_user
            WHERE u.id != $1
            AND u.is_active = true
            AND ABS(u.level - current_user.level) <= 5
            AND u.id NOT IN (
                SELECT friend_id FROM friend_relationships WHERE user_id = $1
                UNION
                SELECT user_id FROM friend_relationships WHERE friend_id = $1
                UNION
                SELECT $1
            )
            ORDER BY level_diff, u.last_active_at DESC
            LIMIT $2
        `, [userId, Math.ceil(limit / 3)]);
        
        recommendations.push(...levelRecs.rows);
        
        // 3. 基于共同好友的推荐
        const mutualRecs = await db.query(`
            SELECT 
                u.id, u.username, u.avatar_url, u.level,
                'mutual_friends' as reason,
                60 as base_score,
                COUNT(f.friend_id) as mutual_count
            FROM users u
            JOIN friend_relationships f ON f.friend_id = u.id
            WHERE f.user_id IN (
                SELECT friend_id FROM friend_relationships WHERE user_id = $1
            )
            AND u.id != $1
            AND u.is_active = true
            AND u.id NOT IN (
                SELECT friend_id FROM friend_relationships WHERE user_id = $1
                UNION
                SELECT user_id FROM friend_relationships WHERE friend_id = $1
                UNION
                SELECT $1
            )
            GROUP BY u.id
            ORDER BY mutual_count DESC, u.last_active_at DESC
            LIMIT $2
        `, [userId, Math.ceil(limit / 3)]);
        
        recommendations.push(...mutualRecs.rows);
        
        // 去重并按分数排序
        const uniqueRecs = new Map();
        recommendations.forEach(rec => {
            if (!uniqueRecs.has(rec.id)) {
                uniqueRecs.set(rec.id, rec);
            } else {
                // 更新为更高分数
                const existing = uniqueRecs.get(rec.id);
                if (rec.base_score > existing.base_score) {
                    uniqueRecs.set(rec.id, rec);
                }
            }
        });
        
        return Array.from(uniqueRecs.values())
            .sort((a, b) => b.base_score - a.base_score)
            .slice(0, limit)
            .map(rec => ({
                userId: rec.id,
                username: rec.username,
                avatarUrl: rec.avatar_url,
                level: rec.level,
                reason: rec.reason,
                score: rec.base_score,
                metadata: {
                    distance: rec.distance,
                    levelDiff: rec.level_diff,
                    mutualCount: rec.mutual_count
                }
            }));
    }

    /**
     * 发送礼物
     */
    async sendGift(req, res) {
        const client = await db.beginTransaction();
        
        try {
            const senderId = req.user.id;
            const { friendId } = req.params;
            const { giftTypeId, wrappingPaperId, message, isAnonymous } = req.body;
            
            // 验证好友关系
            const friendship = await client.query(`
                SELECT intimacy_level, intimacy_points
                FROM friend_relationships
                WHERE user_id = $1 AND friend_id = $2
            `, [senderId, friendId]);
            
            if (friendship.rows.length === 0) {
                await client.rollback();
                return res.status(404).json({ error: 'NOT_FRIEND', message: '非好友关系' });
            }
            
            // 验证礼物配置
            const giftConfig = await client.query(`
                SELECT * FROM gift_types WHERE id = $1 AND is_active = true
            `, [giftTypeId]);
            
            if (giftConfig.rows.length === 0) {
                await client.rollback();
                return res.status(404).json({ error: 'INVALID_GIFT', message: '礼物不存在' });
            }
            
            const gift = giftConfig.rows[0];
            
            // 检查亲密度要求
            if (friendship.rows[0].intimacy_level < gift.required_intimacy_level) {
                await client.rollback();
                return res.status(403).json({ 
                    error: 'INTIMACY_TOO_LOW', 
                    message: `需要亲密度等级 ${gift.required_intimacy_level}` 
                });
            }
            
            // 检查每日限制
            if (gift.daily_limit) {
                const todayCount = await client.query(`
                    SELECT COUNT(*) FROM gift_transactions
                    WHERE sender_id = $1 AND gift_type_id = $2
                    AND DATE(sent_at) = CURRENT_DATE
                `, [senderId, giftTypeId]);
                
                if (parseInt(todayCount.rows[0].count) >= gift.daily_limit) {
                    await client.rollback();
                    return res.status(429).json({ 
                        error: 'DAILY_LIMIT_REACHED', 
                        message: '今日赠送次数已达上限' 
                    });
                }
            }
            
            // 检查发送者库存
            const hasItem = await this._checkGiftInventory(client, senderId, gift);
            if (!hasItem) {
                await client.rollback();
                return res.status(400).json({ 
                    error: 'INSUFFICIENT_INVENTORY', 
                    message: '库存不足' 
                });
            }
            
            // 计算亲密度奖励
            const intimacyPoints = this._calculateGiftIntimacyPoints(gift.rarity);
            
            // 创建礼物交易记录
            const transaction = await client.query(`
                INSERT INTO gift_transactions 
                (sender_id, receiver_id, gift_type_id, wrapping_paper_id, message, 
                 is_anonymous, intimacy_points_awarded)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [senderId, friendId, giftTypeId, wrappingPaperId, message, isAnonymous || false, intimacyPoints]);
            
            // 扣除发送者库存
            await this._deductGiftInventory(client, senderId, gift);
            
            // 发送实时通知
            const notification = {
                type: 'gift_received',
                giftId: transaction.rows[0].id,
                senderId: isAnonymous ? null : senderId,
                giftName: gift.name,
                message: message,
                intimacyPoints: intimacyPoints
            };
            
            emitToUser(friendId, 'notification', notification);
            
            await client.commit();
            
            // 异步记录互动
            this._recordInteractionAsync(senderId, friendId, 'gift_send', intimacyPoints);
            
            logger.info('礼物发送成功', { 
                senderId, 
                friendId, 
                giftTypeId, 
                intimacyPoints 
            });
            
            res.status(201).json({
                success: true,
                giftTransaction: transaction.rows[0],
                intimacyPoints: intimacyPoints
            });
            
        } catch (error) {
            await client.rollback();
            logger.error('发送礼物失败', { error: error.message, userId: req.user.id });
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '发送礼物失败' });
        }
    }

    /**
     * 响应礼物（接受/拒绝）
     */
    async respondToGift(req, res) {
        const client = await db.beginTransaction();
        
        try {
            const userId = req.user.id;
            const { giftId } = req.params;
            const { action } = req.body; // 'accept' or 'reject'
            
            // 查询礼物交易
            const giftTransaction = await client.query(`
                SELECT gt.*, gt.is_anonymous,
                       u.username as sender_name
                FROM gift_transactions gt
                LEFT JOIN users u ON u.id = gt.sender_id
                WHERE gt.id = $1 AND gt.receiver_id = $2 AND gt.status = 'pending'
            `, [giftId, userId]);
            
            if (giftTransaction.rows.length === 0) {
                await client.rollback();
                return res.status(404).json({ 
                    error: 'GIFT_NOT_FOUND', 
                    message: '礼物不存在或已处理' 
                });
            }
            
            const transaction = giftTransaction.rows[0];
            const newStatus = action === 'accept' ? 'accepted' : 'rejected';
            
            // 更新礼物状态
            await client.query(`
                UPDATE gift_transactions 
                SET status = $1, responded_at = NOW()
                WHERE id = $2
            `, [newStatus, giftId]);
            
            if (action === 'accept') {
                // 增加亲密度
                await client.query(`
                    UPDATE friend_relationships 
                    SET intimacy_points = intimacy_points + $1,
                        intimacy_level = (
                            SELECT level FROM intimacy_levels 
                            WHERE min_points <= intimacy_points + $1 
                            ORDER BY level DESC LIMIT 1
                        ),
                        updated_at = NOW()
                    WHERE user_id = $2 AND friend_id = $3
                `, [transaction.intimacy_points_awarded, transaction.sender_id, userId]);
                
                // 双向更新
                await client.query(`
                    UPDATE friend_relationships 
                    SET intimacy_points = intimacy_points + $1,
                        intimacy_level = (
                            SELECT level FROM intimacy_levels 
                            WHERE min_points <= intimacy_points + $1 
                            ORDER BY level DESC LIMIT 1
                        ),
                        updated_at = NOW()
                    WHERE user_id = $2 AND friend_id = $3
                `, [transaction.intimacy_points_awarded, userId, transaction.sender_id]);
                
                // 添加礼物到接收者库存
                await this._addGiftToInventory(client, userId, transaction);
                
                // 检查亲密度升级
                const newIntimacy = await this._checkIntimacyLevelUp(client, transaction.sender_id, userId);
                if (newIntimacy.levelUp) {
                    emitToUser(transaction.sender_id, 'notification', {
                        type: 'intimacy_level_up',
                        friendId: userId,
                        newLevel: newIntimacy.level
                    });
                    emitToUser(userId, 'notification', {
                        type: 'intimacy_level_up',
                        friendId: transaction.sender_id,
                        newLevel: newIntimacy.level
                    });
                }
            }
            
            await client.commit();
            
            logger.info('礼物响应处理成功', { 
                giftId, 
                userId, 
                action, 
                intimacyPoints: action === 'accept' ? transaction.intimacy_points_awarded : 0 
            });
            
            res.json({
                success: true,
                action: action,
                intimacyPoints: action === 'accept' ? transaction.intimacy_points_awarded : 0
            });
            
        } catch (error) {
            await client.rollback();
            logger.error('响应礼物失败', { error: error.message, userId: req.user.id });
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '响应礼物失败' });
        }
    }

    /**
     * 获取好友亲密度详情
     */
    async getIntimacy(req, res) {
        try {
            const userId = req.user.id;
            const { friendId } = req.params;
            
            const intimacy = await db.query(`
                SELECT 
                    fr.*,
                    il.level_name,
                    il.benefits,
                    il.badge_url,
                    (SELECT COUNT(*) FROM friend_interactions 
                     WHERE (user_id = $1 AND friend_id = $2)
                     AND interacted_at > NOW() - INTERVAL '30 days') as interactions_30d,
                    (SELECT json_agg(row_to_json(fi)) FROM (
                        SELECT interaction_type, COUNT(*) as count
                        FROM friend_interactions
                        WHERE (user_id = $1 AND friend_id = $2)
                        AND interacted_at > NOW() - INTERVAL '30 days'
                        GROUP BY interaction_type
                        ORDER BY count DESC
                    ) fi) as interaction_breakdown
                FROM friend_relationships fr
                JOIN intimacy_levels il ON il.level = fr.intimacy_level
                WHERE fr.user_id = $1 AND fr.friend_id = $2
            `, [userId, friendId]);
            
            if (intimacy.rows.length === 0) {
                return res.status(404).json({ error: 'NOT_FRIEND', message: '非好友关系' });
            }
            
            res.json({ intimacy: intimacy.rows[0] });
        } catch (error) {
            logger.error('获取亲密度失败', { error: error.message, userId: req.user.id });
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取亲密度失败' });
        }
    }

    /**
     * 发起联合任务
     */
    async startJointMission(req, res) {
        const client = await db.beginTransaction();
        
        try {
            const userId = req.user.id;
            const { friendId, missionId } = req.body;
            
            // 验证好友关系和亲密度
            const friendship = await client.query(`
                SELECT intimacy_level FROM friend_relationships
                WHERE user_id = $1 AND friend_id = $2
            `, [userId, friendId]);
            
            if (friendship.rows.length === 0 || friendship.rows[0].intimacy_level < 3) {
                await client.rollback();
                return res.status(403).json({ 
                    error: 'INTIMACY_TOO_LOW', 
                    message: '需要亲密度等级3以上才能发起联合任务' 
                });
            }
            
            // 查询任务配置
            const mission = await client.query(`
                SELECT * FROM joint_missions WHERE id = $1 AND is_active = true
            `, [missionId]);
            
            if (mission.rows.length === 0) {
                await client.rollback();
                return res.status(404).json({ error: 'MISSION_NOT_FOUND', message: '任务不存在' });
            }
            
            // 检查是否已有进行中的任务
            const existingMission = await client.query(`
                SELECT id FROM joint_mission_progress
                WHERE (user1_id = $1 AND user2_id = $2 OR user1_id = $2 AND user2_id = $1)
                AND status = 'in_progress'
            `, [userId, friendId]);
            
            if (existingMission.rows.length > 0) {
                await client.rollback();
                return res.status(409).json({ 
                    error: 'MISSION_IN_PROGRESS', 
                    message: '已有进行中的联合任务' 
                });
            }
            
            // 创建联合任务进度
            const expiresAt = mission.rows[0].time_limit_hours
                ? `NOW() + INTERVAL '${mission.rows[0].time_limit_hours} hours'`
                : 'NULL';
            
            const progress = await client.query(`
                INSERT INTO joint_mission_progress
                (mission_id, user1_id, user2_id, expires_at)
                VALUES ($1, $2, $3, ${expiresAt})
                RETURNING *
            `, [missionId, userId, friendId]);
            
            await client.commit();
            
            // 发送邀请通知
            emitToUser(friendId, 'notification', {
                type: 'joint_mission_invite',
                missionId,
                inviterId: userId,
                missionTitle: mission.rows[0].title
            });
            
            logger.info('联合任务发起成功', { 
                missionId, 
                userId, 
                friendId 
            });
            
            res.status(201).json({
                success: true,
                missionProgress: progress.rows[0],
                missionDetails: mission.rows[0]
            });
            
        } catch (error) {
            await client.rollback();
            logger.error('发起联合任务失败', { error: error.message, userId: req.user.id });
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '发起任务失败' });
        }
    }

    /**
     * 获取好友动态流
     */
    async getActivityFeed(req, res) {
        try {
            const userId = req.user.id;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;
            
            const feed = await db.query(`
                SELECT 
                    fa.*,
                    u.username,
                    u.avatar_url,
                    CASE 
                        WHEN fa.activity_type = 'catch_pokemon' THEN 
                            json_build_object('pokemon_name', fa.content->>'pokemon_name', 'rarity', fa.content->>'rarity')
                        WHEN fa.activity_type = 'achievement_unlock' THEN 
                            json_build_object('achievement_name', fa.content->>'achievement_name', 'rarity', fa.content->>'rarity')
                        ELSE fa.content
                    END as formatted_content
                FROM friend_activities fa
                JOIN users u ON u.id = fa.user_id
                WHERE fa.user_id IN (
                    SELECT friend_id FROM friend_relationships WHERE user_id = $1
                )
                AND fa.visibility IN ('public', 'friends')
                AND fa.created_at > NOW() - INTERVAL '7 days'
                ORDER BY fa.created_at DESC
                LIMIT $2 OFFSET $3
            `, [userId, limit, offset]);
            
            res.json({ 
                activities: feed.rows,
                pagination: {
                    page,
                    limit,
                    hasMore: feed.rows.length === limit
                }
            });
        } catch (error) {
            logger.error('获取好友动态失败', { error: error.message, userId: req.user.id });
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取动态失败' });
        }
    }

    /**
     * 获取互动提醒
     */
    async getReminders(req, res) {
        try {
            const userId = req.user.id;
            const limit = parseInt(req.query.limit) || 20;
            
            const reminders = await db.query(`
                SELECT 
                    ir.*,
                    u.username as related_username,
                    u.avatar_url as related_avatar
                FROM interaction_reminders ir
                LEFT JOIN users u ON u.id = ir.related_user_id
                WHERE ir.user_id = $1
                ORDER BY ir.is_read ASC, ir.created_at DESC
                LIMIT $2
            `, [userId, limit]);
            
            res.json({ reminders: reminders.rows });
        } catch (error) {
            logger.error('获取互动提醒失败', { error: error.message, userId: req.user.id });
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取提醒失败' });
        }
    }

    // ==================== 辅助方法 ====================

    _calculateGiftIntimacyPoints(rarity) {
        const points = {
            'common': 5,
            'uncommon': 10,
            'rare': 20,
            'epic': 50,
            'legendary': 100
        };
        return points[rarity] || 5;
    }

    async _checkGiftInventory(client, userId, gift) {
        if (gift.gift_type === 'currency') {
            const balance = await client.query(`
                SELECT coins FROM users WHERE id = $1
            `, [userId]);
            return balance.rows[0].coins >= gift.metadata.amount;
        }
        
        const inventory = await client.query(`
            SELECT quantity FROM user_items 
            WHERE user_id = $1 AND item_id = $2
        `, [userId, gift.item_id]);
        
        return inventory.rows.length > 0 && inventory.rows[0].quantity > 0;
    }

    async _deductGiftInventory(client, userId, gift) {
        if (gift.gift_type === 'currency') {
            await client.query(`
                UPDATE users SET coins = coins - $1 WHERE id = $2
            `, [gift.metadata.amount, userId]);
        } else {
            await client.query(`
                UPDATE user_items 
                SET quantity = quantity - 1
                WHERE user_id = $1 AND item_id = $2
            `, [userId, gift.item_id]);
        }
    }

    async _addGiftToInventory(client, userId, transaction) {
        const gift = await client.query(`
            SELECT * FROM gift_types WHERE id = $1
        `, [transaction.gift_type_id]);
        
        if (gift.rows[0].gift_type === 'currency') {
            await client.query(`
                UPDATE users SET coins = coins + $1 WHERE id = $2
            `, [gift.rows[0].metadata.amount, userId]);
        } else {
            await client.query(`
                INSERT INTO user_items (user_id, item_id, quantity)
                VALUES ($1, $2, 1)
                ON CONFLICT (user_id, item_id) 
                DO UPDATE SET quantity = user_items.quantity + 1
            `, [userId, gift.rows[0].item_id]);
        }
    }

    async _checkIntimacyLevelUp(client, user1Id, user2Id) {
        const intimacy = await client.query(`
            SELECT intimacy_level, intimacy_points FROM friend_relationships
            WHERE user_id = $1 AND friend_id = $2
        `, [user1Id, user2Id]);
        
        const nextLevel = await client.query(`
            SELECT level FROM intimacy_levels 
            WHERE min_points <= $1 AND level > $2
            ORDER BY level ASC LIMIT 1
        `, [intimacy.rows[0].intimacy_points, intimacy.rows[0].intimacy_level]);
        
        return {
            levelUp: nextLevel.rows.length > 0,
            level: nextLevel.rows.length > 0 ? nextLevel.rows[0].level : intimacy.rows[0].intimacy_level
        };
    }

    _recordInteractionAsync(userId, friendId, interactionType, intimacyPoints) {
        setImmediate(async () => {
            try {
                await db.query(`
                    INSERT INTO friend_interactions 
                    (user_id, friend_id, interaction_type, intimacy_points_change)
                    VALUES ($1, $2, $3, $4)
                `, [userId, friendId, interactionType, intimacyPoints]);
            } catch (error) {
                logger.error('记录互动失败', { error: error.message });
            }
        });
    }
}

module.exports = new FriendInteractionController();
```

### 3. gift-service 礼物管理模块

```javascript
// backend/services/social-service/services/giftService.js
const db = require('../../../shared/database/postgres');
const redis = require('../../../shared/database/redis');
const logger = require('../../../shared/logger');

class GiftService {
    /**
     * 获取可用礼物列表
     */
    async getAvailableGifts(userId, friendId) {
        try {
            // 获取好友亲密度
            const intimacy = await db.query(`
                SELECT intimacy_level FROM friend_relationships
                WHERE user_id = $1 AND friend_id = $2
            `, [userId, friendId]);
            
            const intimacyLevel = intimacy.rows[0]?.intimacy_level || 1;
            
            // 查询可用礼物
            const gifts = await db.query(`
                SELECT 
                    gt.*,
                    CASE 
                        WHEN gt.is_seasonal = true AND (CURRENT_DATE < gt.season_start OR CURRENT_DATE > gt.season_end) 
                        THEN false 
                        ELSE true 
                    END as is_available
                FROM gift_types gt
                WHERE gt.is_active = true
                AND gt.required_intimacy_level <= $1
                ORDER BY gt.rarity, gt.name
            `, [intimacyLevel]);
            
            return gifts.rows.filter(g => g.is_available);
        } catch (error) {
            logger.error('获取可用礼物失败', { error: error.message, userId, friendId });
            throw error;
        }
    }

    /**
     * 获取包装纸列表
     */
    async getWrappingPapers(userId) {
        const cacheKey = `wrapping_papers:${userId}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return JSON.parse(cached);
        }
        
        const papers = await db.query(`
            SELECT id, name, preview_url, rarity, unlock_condition
            FROM wrapping_papers
            WHERE is_active = true
            ORDER BY rarity, name
        `);
        
        await redis.setex(cacheKey, 3600, JSON.stringify(papers.rows));
        return papers.rows;
    }

    /**
     * 获取收到的礼物列表
     */
    async getReceivedGifts(userId, status = 'pending', limit = 20) {
        const gifts = await db.query(`
            SELECT 
                gt.*,
                gt.sender_id,
                CASE WHEN gt.is_anonymous THEN NULL ELSE u.username END as sender_name,
                gft.name as gift_name,
                gft.icon_url,
                wp.preview_url as wrapping_paper_url
            FROM gift_transactions gt
            LEFT JOIN users u ON u.id = gt.sender_id
            JOIN gift_types gft ON gft.id = gt.gift_type_id
            LEFT JOIN wrapping_papers wp ON wp.id = gt.wrapping_paper_id
            WHERE gt.receiver_id = $1 AND gt.status = $2
            ORDER BY gt.sent_at DESC
            LIMIT $3
        `, [userId, status, limit]);
        
        return gifts.rows;
    }

    /**
     * 获取已发送礼物列表
     */
    async getSentGifts(userId, limit = 20) {
        const gifts = await db.query(`
            SELECT 
                gt.*,
                u.username as receiver_name,
                gft.name as gift_name,
                gft.icon_url
            FROM gift_transactions gt
            JOIN users u ON u.id = gt.receiver_id
            JOIN gift_types gft ON gft.id = gt.gift_type_id
            WHERE gt.sender_id = $1
            ORDER BY gt.sent_at DESC
            LIMIT $2
        `, [userId, limit]);
        
        return gifts.rows;
    }
}

module.exports = new GiftService();
```

### 4. intimacy-service 亲密度管理模块

```javascript
// backend/services/social-service/services/intimacyService.js
const db = require('../../../shared/database/postgres');
const redis = require('../../../shared/database/redis');
const { emitToUser } = require('../../../shared/websocket');
const logger = require('../../../shared/logger');

class IntimacyService {
    constructor() {
        this.LEVEL_CACHE_KEY = 'intimacy_levels_config';
    }

    /**
     * 获取等级配置
     */
    async getLevelConfig() {
        const cached = await redis.get(this.LEVEL_CACHE_KEY);
        if (cached) {
            return JSON.parse(cached);
        }
        
        const levels = await db.query(`
            SELECT * FROM intimacy_levels ORDER BY level
        `);
        
        await redis.setex(this.LEVEL_CACHE_KEY, 86400, JSON.stringify(levels.rows));
        return levels.rows;
    }

    /**
     * 计算所需积分
     */
    async calculatePointsForLevel(targetLevel) {
        const levels = await this.getLevelConfig();
        const level = levels.find(l => l.level === targetLevel);
        return level ? level.min_points : 0;
    }

    /**
     * 获取亲密度进度
     */
    async getIntimacyProgress(userId, friendId) {
        const progress = await db.query(`
            SELECT 
                fr.intimacy_level,
                fr.intimacy_points,
                il.min_points as current_level_min,
                il_next.min_points as next_level_min,
                il.level_name,
                il.badge_url
            FROM friend_relationships fr
            JOIN intimacy_levels il ON il.level = fr.intimacy_level
            LEFT JOIN intimacy_levels il_next ON il_next.level = fr.intimacy_level + 1
            WHERE fr.user_id = $1 AND fr.friend_id = $2
        `, [userId, friendId]);
        
        if (progress.rows.length === 0) {
            return null;
        }
        
        const data = progress.rows[0];
        return {
            currentLevel: data.intimacy_level,
            currentPoints: data.intimacy_points,
            levelName: data.level_name,
            badgeUrl: data.badge_url,
            nextLevelPoints: data.next_level_min || data.current_level_min,
            progressPercent: data.next_level_min 
                ? ((data.intimacy_points - data.current_level_min) / (data.next_level_min - data.current_level_min)) * 100
                : 100
        };
    }

    /**
     * 更新亲密度（带锁）
     */
    async updateIntimacy(user1Id, user2Id, pointsChange, reason) {
        const lockKey = `intimacy_lock:${Math.min(user1Id, user2Id)}:${Math.max(user1Id, user2Id)}`;
        const lock = await redis.lock(lockKey, 5000);
        
        if (!lock.acquired) {
            throw new Error('无法获取亲密度更新锁');
        }
        
        try {
            await db.transaction(async (client) => {
                // 更新双向亲密度
                await client.query(`
                    UPDATE friend_relationships 
                    SET intimacy_points = intimacy_points + $1,
                        intimacy_level = (
                            SELECT level FROM intimacy_levels 
                            WHERE min_points <= intimacy_points + $1 
                            ORDER BY level DESC LIMIT 1
                        ),
                        last_interaction_at = NOW(),
                        updated_at = NOW()
                    WHERE (user_id = $2 AND friend_id = $3)
                       OR (user_id = $3 AND friend_id = $2)
                `, [pointsChange, user1Id, user2Id]);
                
                // 记录互动
                await client.query(`
                    INSERT INTO friend_interactions 
                    (user_id, friend_id, interaction_type, intimacy_points_change)
                    VALUES ($1, $2, $3, $4)
                `, [user1Id, user2Id, reason, pointsChange]);
            });
            
            logger.info('亲密度更新成功', { user1Id, user2Id, pointsChange, reason });
            
        } finally {
            await redis.unlock(lock);
        }
    }

    /**
     * 检查并通知等级提升
     */
    async checkLevelUp(userId, friendId) {
        const current = await db.query(`
            SELECT intimacy_level, intimacy_points FROM friend_relationships
            WHERE user_id = $1 AND friend_id = $2
        `, [userId, friendId]);
        
        const previousLevel = await redis.get(`intimacy_level:${userId}:${friendId}`);
        const currentLevel = current.rows[0].intimacy_level;
        
        if (previousLevel && parseInt(previousLevel) < currentLevel) {
            const levelConfig = await this.getLevelConfig();
            const newLevel = levelConfig.find(l => l.level === currentLevel);
            
            // 发送等级提升通知
            emitToUser(userId, 'notification', {
                type: 'intimacy_level_up',
                friendId,
                newLevel: currentLevel,
                levelName: newLevel.level_name,
                benefits: newLevel.benefits
            });
            
            // 更新缓存
            await redis.set(`intimacy_level:${userId}:${friendId}`, currentLevel);
            
            return { levelUp: true, newLevel: currentLevel };
        }
        
        await redis.set(`intimacy_level:${userId}:${friendId}`, currentLevel);
        return { levelUp: false };
    }
}

module.exports = new IntimacyService();
```

### 5. recommendation-service 好友推荐模块

```javascript
// backend/services/social-service/services/recommendationService.js
const db = require('../../../shared/database/postgres');
const redis = require('../../../shared/database/redis');
const logger = require('../../../shared/logger');

class RecommendationService {
    /**
     * 获取综合好友推荐
     */
    async getComprehensiveRecommendations(userId, limit = 10) {
        const cacheKey = `friend_rec:${userId}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return JSON.parse(cached);
        }
        
        const recommendations = [];
        
        // 多维度推荐
        const [
            locationBased,
            levelBased,
            mutualBased,
            typePreferenceBased
        ] = await Promise.all([
            this._getLocationRecommendations(userId, Math.ceil(limit / 4)),
            this._getLevelRecommendations(userId, Math.ceil(limit / 4)),
            this._getMutualFriendRecommendations(userId, Math.ceil(limit / 4)),
            this._getTypePreferenceRecommendations(userId, Math.ceil(limit / 4))
        ]);
        
        recommendations.push(...locationBased, ...levelBased, ...mutualBased, ...typePreferenceBased);
        
        // 去重并排序
        const unique = this._deduplicateAndSort(recommendations);
        
        // 缓存结果
        await redis.setex(cacheKey, 1800, JSON.stringify(unique.slice(0, limit)));
        
        return unique.slice(0, limit);
    }

    async _getLocationRecommendations(userId, limit) {
        try {
            const recs = await db.query(`
                SELECT 
                    u.id,
                    u.username,
                    u.avatar_url,
                    u.level,
                    'location_nearby' as reason,
                    50 as score,
                    ST_Distance(u.last_location, curr.last_location) / 1000 as distance_km
                FROM users u,
                     (SELECT last_location FROM users WHERE id = $1) curr
                WHERE u.id != $1
                AND u.is_active = true
                AND u.privacy_settings->>'location_visible' = 'true'
                AND ST_DWithin(u.last_location, curr.last_location, 10000)
                AND u.id NOT IN (
                    SELECT friend_id FROM friend_relationships WHERE user_id = $1
                    UNION
                    SELECT user_id FROM friend_relationships WHERE friend_id = $1
                )
                ORDER BY distance_km
                LIMIT $2
            `, [userId, limit]);
            
            return recs.rows;
        } catch (error) {
            logger.error('位置推荐失败', { error: error.message, userId });
            return [];
        }
    }

    async _getLevelRecommendations(userId, limit) {
        try {
            const recs = await db.query(`
                SELECT 
                    u.id,
                    u.username,
                    u.avatar_url,
                    u.level,
                    'similar_level' as reason,
                    40 as score,
                    ABS(u.level - curr.level) as level_diff
                FROM users u,
                     (SELECT level FROM users WHERE id = $1) curr
                WHERE u.id != $1
                AND u.is_active = true
                AND ABS(u.level - curr.level) <= 5
                AND u.id NOT IN (
                    SELECT friend_id FROM friend_relationships WHERE user_id = $1
                    UNION
                    SELECT user_id FROM friend_relationships WHERE friend_id = $1
                )
                ORDER BY level_diff, u.last_active_at DESC
                LIMIT $2
            `, [userId, limit]);
            
            return recs.rows;
        } catch (error) {
            logger.error('等级推荐失败', { error: error.message, userId });
            return [];
        }
    }

    async _getMutualFriendRecommendations(userId, limit) {
        try {
            const recs = await db.query(`
                SELECT 
                    u.id,
                    u.username,
                    u.avatar_url,
                    u.level,
                    'mutual_friends' as reason,
                    60 + LEAST(COUNT(f.friend_id) * 5, 30) as score,
                    COUNT(f.friend_id) as mutual_count
                FROM users u
                JOIN friend_relationships f ON f.friend_id = u.id
                WHERE f.user_id IN (
                    SELECT friend_id FROM friend_relationships WHERE user_id = $1
                )
                AND u.id != $1
                AND u.is_active = true
                AND u.id NOT IN (
                    SELECT friend_id FROM friend_relationships WHERE user_id = $1
                    UNION
                    SELECT user_id FROM friend_relationships WHERE friend_id = $1
                )
                GROUP BY u.id
                ORDER BY mutual_count DESC
                LIMIT $2
            `, [userId, limit]);
            
            return recs.rows;
        } catch (error) {
            logger.error('共同好友推荐失败', { error: error.message, userId });
            return [];
        }
    }

    async _getTypePreferenceRecommendations(userId, limit) {
        try {
            const recs = await db.query(`
                SELECT 
                    u.id,
                    u.username,
                    u.avatar_url,
                    u.level,
                    'similar_pokemon_types' as reason,
                    45 as score,
                    COUNT(DISTINCT pt.type_id) as common_types
                FROM users u
                JOIN user_pokemon up ON up.user_id = u.id
                JOIN pokemon_types pt ON pt.pokemon_id = up.pokemon_id
                WHERE pt.type_id IN (
                    SELECT DISTINCT pt2.type_id
                    FROM user_pokemon up2
                    JOIN pokemon_types pt2 ON pt2.pokemon_id = up2.pokemon_id
                    WHERE up2.user_id = $1
                )
                AND u.id != $1
                AND u.is_active = true
                AND u.id NOT IN (
                    SELECT friend_id FROM friend_relationships WHERE user_id = $1
                    UNION
                    SELECT user_id FROM friend_relationships WHERE friend_id = $1
                )
                GROUP BY u.id
                ORDER BY common_types DESC
                LIMIT $2
            `, [userId, limit]);
            
            return recs.rows;
        } catch (error) {
            logger.error('类型偏好推荐失败', { error: error.message, userId });
            return [];
        }
    }

    _deduplicateAndSort(recommendations) {
        const unique = new Map();
        
        recommendations.forEach(rec => {
            if (!unique.has(rec.id)) {
                unique.set(rec.id, rec);
            } else {
                const existing = unique.get(rec.id);
                if (rec.score > existing.score) {
                    unique.set(rec.id, rec);
                }
            }
        });
        
        return Array.from(unique.values())
            .sort((a, b) => b.score - a.score);
    }

    /**
     * 忽略推荐
     */
    async dismissRecommendation(userId, recommendedUserId) {
        try {
            await db.query(`
                UPDATE friend_recommendations
                SET is_dismissed = true
                WHERE user_id = $1 AND recommended_user_id = $2
            `, [userId, recommendedUserId]);
            
            // 清除缓存
            await redis.del(`friend_rec:${userId}`);
        } catch (error) {
            logger.error('忽略推荐失败', { error: error.message, userId, recommendedUserId });
            throw error;
        }
    }
}

module.exports = new RecommendationService();
```

### 6. 游戏客户端实现

```javascript
// frontend/game-client/src/social/FriendInteractionManager.js
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useWebSocket } from '../websocket/WebSocketContext';
import api from '../utils/api';

export const FriendInteractionManager = ({ friendId, onClose }) => {
    const { user } = useAuth();
    const { subscribe } = useWebSocket();
    
    const [intimacy, setIntimacy] = useState(null);
    const [availableGifts, setAvailableGifts] = useState([]);
    const [jointMissions, setJointMissions] = useState([]);
    const [interactions, setInteractions] = useState([]);
    
    useEffect(() => {
        loadIntimacyData();
        loadAvailableGifts();
        loadJointMissions();
        
        // 订阅实时通知
        const unsubscribe = subscribe('notification', handleNotification);
        return unsubscribe;
    }, [friendId]);
    
    const loadIntimacyData = async () => {
        try {
            const response = await api.get(`/friends/${friendId}/intimacy`);
            setIntimacy(response.data.intimacy);
        } catch (error) {
            console.error('加载亲密度失败', error);
        }
    };
    
    const loadAvailableGifts = async () => {
        try {
            const response = await api.get('/gifts/available', {
                params: { friendId }
            });
            setAvailableGifts(response.data.gifts);
        } catch (error) {
            console.error('加载礼物列表失败', error);
        }
    };
    
    const loadJointMissions = async () => {
        try {
            const response = await api.get('/friends/joint-missions/available');
            setJointMissions(response.data.missions);
        } catch (error) {
            console.error('加载联合任务失败', error);
        }
    };
    
    const handleNotification = useCallback((notification) => {
        if (notification.type === 'intimacy_level_up' && notification.friendId === friendId) {
            setIntimacy(prev => ({
                ...prev,
                intimacy_level: notification.newLevel,
                levelName: notification.levelName
            }));
        }
    }, [friendId]);
    
    const sendGift = async (giftId, options = {}) => {
        try {
            const response = await api.post(`/friends/${friendId}/gift`, {
                giftTypeId: giftId,
                ...options
            });
            
            setIntimacy(prev => ({
                ...prev,
                intimacy_points: prev.intimacy_points + response.data.intimacyPoints
            }));
            
            return response.data;
        } catch (error) {
            throw error;
        }
    };
    
    const startJointMission = async (missionId) => {
        try {
            const response = await api.post('/friends/joint-mission/start', {
                friendId,
                missionId
            });
            
            return response.data;
        } catch (error) {
            throw error;
        }
    };
    
    return (
        <div className="friend-interaction-manager">
            {/* 亲密度显示 */}
            {intimacy && (
                <IntimacyDisplay 
                    intimacy={intimacy}
                    onUpgrade={() => loadIntimacyData()}
                />
            )}
            
            {/* 礼物赠送 */}
            <GiftPanel 
                gifts={availableGifts}
                onSend={sendGift}
                friendId={friendId}
            />
            
            {/* 联合任务 */}
            <JointMissionPanel 
                missions={jointMissions}
                onStart={startJointMission}
                friendId={friendId}
            />
        </div>
    );
};

// 亲密度显示组件
const IntimacyDisplay = ({ intimacy }) => {
    const progressPercent = intimacy.nextLevelPoints 
        ? ((intimacy.intimacy_points - intimacy.current_level_min) / 
           (intimacy.nextLevelPoints - intimacy.current_level_min)) * 100
        : 100;
    
    return (
        <div className="intimacy-display">
            <div className="intimacy-header">
                <h3>好友亲密度</h3>
                <span className="intimacy-level">Lv.{intimacy.intimacy_level}</span>
            </div>
            
            <div className="intimacy-badge">
                <img src={intimacy.badge_url} alt={intimacy.levelName} />
                <span>{intimacy.levelName}</span>
            </div>
            
            <div className="intimacy-progress">
                <div className="progress-bar">
                    <div 
                        className="progress-fill"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
                <span className="progress-text">
                    {intimacy.intimacy_points} / {intimacy.nextLevelPoints || '∞'}
                </span>
            </div>
        </div>
    );
};

// 礼物面板组件
const GiftPanel = ({ gifts, onSend, friendId }) => {
    const [selectedGift, setSelectedGift] = useState(null);
    const [message, setMessage] = useState('');
    const [isAnonymous, setIsAnonymous] = useState(false);
    const [sending, setSending] = useState(false);
    
    const handleSend = async () => {
        if (!selectedGift) return;
        
        setSending(true);
        try {
            await onSend(selectedGift.id, {
                message,
                isAnonymous,
                wrappingPaperId: selectedGift.wrappingPaper
            });
            
            setSelectedGift(null);
            setMessage('');
            setIsAnonymous(false);
        } catch (error) {
            alert('发送礼物失败');
        } finally {
            setSending(false);
        }
    };
    
    return (
        <div className="gift-panel">
            <h3>赠送礼物</h3>
            
            <div className="gift-grid">
                {gifts.map(gift => (
                    <div 
                        key={gift.id}
                        className={`gift-item ${selectedGift?.id === gift.id ? 'selected' : ''}`}
                        onClick={() => setSelectedGift(gift)}
                    >
                        <img src={gift.icon_url} alt={gift.name} />
                        <span>{gift.name}</span>
                        <span className="gift-rarity">{gift.rarity}</span>
                    </div>
                ))}
            </div>
            
            {selectedGift && (
                <div className="gift-options">
                    <textarea 
                        placeholder="写下祝福语..."
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        maxLength={200}
                    />
                    
                    <label className="anonymous-toggle">
                        <input 
                            type="checkbox"
                            checked={isAnonymous}
                            onChange={(e) => setIsAnonymous(e.target.checked)}
                        />
                        匿名赠送
                    </label>
                    
                    <button 
                        className="send-btn"
                        onClick={handleSend}
                        disabled={sending}
                    >
                        {sending ? '发送中...' : '发送礼物'}
                    </button>
                </div>
            )}
        </div>
    );
};
```

## 验收标准

- [ ] 好友推荐功能：支持位置、等级、共同好友、类型偏好四维度推荐
- [ ] 礼物赠送功能：支持道具、精灵蛋、货币等多种礼物类型
- [ ] 亲密度系统：10级亲密度体系，互动增加积分，等级解锁特权
- [ ] 联合任务功能：好友组队完成专属任务，获得额外奖励
- [ ] 好友动态流：查看好友游戏动态、成就、捕捉记录
- [ ] 互动提醒：好友上线、生日、成就等实时提醒
- [ ] WebSocket 实时通知：礼物接收、亲密度升级等实时推送
- [ ] 缓存优化：推荐列表、等级配置等数据缓存
- [ ] 数据库索引：所有查询性能 < 100ms
- [ ] 单元测试覆盖率 > 80%

## 影响范围

- backend/services/social-service（新增好友互动路由和控制器）
- backend/services/user-service（好友资料查看）
- backend/services/pokemon-service（类型偏好推荐）
- backend/services/reward-service（联合任务奖励）
- backend/shared（WebSocket通知、缓存工具）
- frontend/game-client/src/social（好友互动UI）
- database/migrations（新增11张表）
- docs/api-spec（新增12个API端点）

## 参考

- 原版 Pokémon GO 好友系统设计
- 社交游戏好友互动最佳实践
- Redis 推荐系统缓存策略
