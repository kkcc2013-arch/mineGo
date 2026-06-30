# REQ-00384: GDPR 数据主体权利请求管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00384 |
| 标题 | GDPR 数据主体权利请求管理系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、admin-dashboard、backend/jobs、backend/shared、database/migrations |
| 创建时间 | 2026-06-30 10:00 |

## 需求描述

实现完整的 GDPR 数据主体权利请求管理系统，支持用户行使以下数据权利：

### 数据主体权利类型
1. **访问权 (Right to Access)** - 用户可请求获取其所有个人数据的副本
2. **更正权 (Right to Rectification)** - 用户可请求更正不准确的个人数据
3. **删除权 (Right to Erasure/被遗忘权)** - 用户可请求删除其个人数据
4. **限制处理权 (Right to Restriction)** - 用户可请求限制其数据的处理
5. **数据可携带权 (Right to Data Portability)** - 用户可请求以结构化格式导出数据
6. **反对权 (Right to Object)** - 用户可反对特定数据处理活动
7. **自动化决策反对权** - 用户可反对完全自动化决策

### 核心功能要求
- 自助请求提交门户
- 请求状态实时追踪
- 自动身份验证流程
- 请求处理工作流引擎
- 多服务数据聚合与导出
- 数据删除级联处理
- 处理期限监控（GDPR 要求 30 日内响应）
- 审计日志与合规报告

## 技术方案

### 1. 数据库设计

```sql
-- 数据主体请求表
CREATE TABLE data_subject_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    request_type VARCHAR(50) NOT NULL, -- 'access', 'rectification', 'erasure', 'restriction', 'portability', 'object'
    status VARCHAR(30) NOT NULL DEFAULT 'submitted', -- 'submitted', 'verifying', 'processing', 'completed', 'rejected', 'expired'
    priority VARCHAR(20) DEFAULT 'normal', -- 'urgent', 'normal', 'low'
    
    -- 请求详情
    request_details JSONB NOT NULL DEFAULT '{}',
    -- 更正请求：{ "field": "email", "old_value": "x", "new_value": "y" }
    -- 删除请求：{ "scope": "full" | "partial", "reason": "..." }
    -- 导出请求：{ "format": "json" | "csv" | "xml", "include": ["profile", "pokemon", "transactions"] }
    
    -- 身份验证
    verification_method VARCHAR(30), -- 'email', 'document', 'video_call'
    verification_status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'verified', 'failed'
    verification_deadline TIMESTAMP,
    verified_at TIMESTAMP,
    verified_by UUID REFERENCES users(id),
    
    -- 处理信息
    assigned_to UUID REFERENCES users(id), -- 分配的处理人员
    processing_started_at TIMESTAMP,
    processing_completed_at TIMESTAMP,
    deadline TIMESTAMP NOT NULL, -- 法定截止日期（提交后30天）
    
    -- 结果
    result_data JSONB, -- 处理结果
    result_file_url TEXT, -- 导出文件URL
    rejection_reason TEXT,
    
    -- 审计
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT
);

-- 请求处理记录表
CREATE TABLE dsr_processing_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_subject_requests(id),
    action VARCHAR(50) NOT NULL,
    actor_type VARCHAR(20) NOT NULL, -- 'system', 'admin', 'user'
    actor_id UUID,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- 数据删除审计表
CREATE TABLE data_deletion_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_subject_requests(id),
    table_name VARCHAR(100) NOT NULL,
    record_count INTEGER NOT NULL,
    deleted_at TIMESTAMP DEFAULT NOW(),
    deleted_by VARCHAR(50) NOT NULL, -- 'dsr_automation' 或管理员ID
    verification_hash VARCHAR(128) -- 删除操作验证哈希
);

-- 数据导出记录表
CREATE TABLE data_export_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_subject_requests(id),
    export_type VARCHAR(30) NOT NULL, -- 'full', 'partial', 'specific'
    file_format VARCHAR(10) NOT NULL,
    file_url TEXT,
    file_size_bytes BIGINT,
    checksum_sha256 VARCHAR(64),
    expires_at TIMESTAMP, -- 下载链接过期时间
    download_count INTEGER DEFAULT 0,
    last_downloaded_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 数据限制处理标记表
CREATE TABLE data_restriction_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    restriction_type VARCHAR(50) NOT NULL,
    restricted_at TIMESTAMP DEFAULT NOW(),
    request_id UUID REFERENCES data_subject_requests(id),
    reason TEXT,
    is_active BOOLEAN DEFAULT true,
    lifted_at TIMESTAMP,
    lifted_by UUID REFERENCES users(id)
);

-- 索引
CREATE INDEX idx_dsr_user ON data_subject_requests(user_id);
CREATE INDEX idx_dsr_status ON data_subject_requests(status);
CREATE INDEX idx_dsr_deadline ON data_subject_requests(deadline);
CREATE INDEX idx_dsr_type ON data_subject_requests(request_type);
CREATE INDEX idx_dsr_created ON data_subject_requests(created_at DESC);
CREATE INDEX idx_dsr_logs_request ON dsr_processing_logs(request_id);
CREATE INDEX idx_deletion_audit_request ON data_deletion_audit(request_id);
CREATE INDEX idx_restriction_user ON data_restriction_flags(user_id);
```

### 2. user-service DSR 处理模块

```javascript
// backend/services/user/src/routes/dsr.js
const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const auth = require('../../../shared/middleware/auth');
const DsrService = require('../services/DsrService');
const rateLimit = require('express-rate-limit');

// DSR 请求速率限制（每个用户每月最多 5 次请求）
const dsrLimiter = rateLimit({
    windowMs: 30 * 24 * 60 * 60 * 1000, // 30 天
    max: 5,
    message: { error: 'dsr_rate_limit_exceeded', message: '每月最多提交5次数据主体请求' }
});

/**
 * POST /api/v1/dsr/requests
 * 提交数据主体权利请求
 */
router.post('/requests',
    auth.authenticate,
    dsrLimiter,
    [
        body('request_type').isIn(['access', 'rectification', 'erasure', 'restriction', 'portability', 'object']),
        body('request_details').isObject(),
        body('verification_method').optional().isIn(['email', 'document'])
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: 'validation_failed', details: errors.array() });
        }
        
        const { request_type, request_details, verification_method = 'email' } = req.body;
        const userId = req.user.id;
        
        try {
            const request = await DsrService.createRequest({
                userId,
                requestType: request_type,
                requestDetails: request_details,
                verificationMethod: verification_method,
                ipAddress: req.ip,
                userAgent: req.get('user-agent')
            });
            
            // 发送验证邮件
            await DsrService.sendVerificationEmail(request.id);
            
            res.status(201).json({
                request_id: request.id,
                status: request.status,
                deadline: request.deadline,
                verification_required: true,
                verification_method: verification_method
            });
        } catch (error) {
            res.status(500).json({ error: 'request_creation_failed', message: error.message });
        }
    }
);

/**
 * GET /api/v1/dsr/requests
 * 获取用户的数据主体请求列表
 */
router.get('/requests',
    auth.authenticate,
    [
        query('status').optional().isIn(['submitted', 'verifying', 'processing', 'completed', 'rejected', 'expired']),
        query('limit').optional().isInt({ min: 1, max: 50 }),
        query('offset').optional().isInt({ min: 0 })
    ],
    async (req, res) => {
        const { status, limit = 20, offset = 0 } = req.query;
        const userId = req.user.id;
        
        const requests = await DsrService.getUserRequests(userId, { status, limit, offset });
        res.json(requests);
    }
);

/**
 * GET /api/v1/dsr/requests/:requestId
 * 获取请求详情
 */
router.get('/requests/:requestId',
    auth.authenticate,
    [param('requestId').isUUID()],
    async (req, res) => {
        const { requestId } = req.params;
        const userId = req.user.id;
        
        const request = await DsrService.getRequestDetails(requestId, userId);
        if (!request) {
            return res.status(404).json({ error: 'request_not_found' });
        }
        
        res.json(request);
    }
);

/**
 * POST /api/v1/dsr/requests/:requestId/verify
 * 验证请求身份（通过验证码）
 */
router.post('/requests/:requestId/verify',
    auth.authenticate,
    [
        param('requestId').isUUID(),
        body('verification_code').isString().isLength({ min: 6, max: 6 })
    ],
    async (req, res) => {
        const { requestId } = req.params;
        const { verification_code } = req.body;
        const userId = req.user.id;
        
        const result = await DsrService.verifyRequest(requestId, userId, verification_code);
        
        if (result.success) {
            res.json({ message: 'verification_successful', status: 'processing' });
        } else {
            res.status(400).json({ error: 'verification_failed', message: result.message });
        }
    }
);

/**
 * GET /api/v1/dsr/requests/:requestId/download
 * 下载导出的数据文件
 */
router.get('/requests/:requestId/download',
    auth.authenticate,
    [param('requestId').isUUID()],
    async (req, res) => {
        const { requestId } = req.params;
        const userId = req.user.id;
        
        const downloadInfo = await DsrService.getDownloadUrl(requestId, userId);
        
        if (!downloadInfo) {
            return res.status(404).json({ error: 'export_not_ready' });
        }
        
        // 记录下载
        await DsrService.recordDownload(requestId);
        
        res.json({ download_url: downloadInfo.url, expires_at: downloadInfo.expires_at });
    }
);

/**
 * POST /api/v1/dsr/requests/:requestId/cancel
 * 取消请求（仅限 submitted 状态）
 */
router.post('/requests/:requestId/cancel',
    auth.authenticate,
    [param('requestId').isUUID()],
    async (req, res) => {
        const { requestId } = req.params;
        const userId = req.user.id;
        
        const result = await DsrService.cancelRequest(requestId, userId);
        
        if (result.success) {
            res.json({ message: 'request_cancelled', status: 'cancelled' });
        } else {
            res.status(400).json({ error: 'cancel_failed', message: result.message });
        }
    }
);

/**
 * GET /api/v1/dsr/data-preview
 * 预览用户数据概况（帮助用户了解将获得什么数据）
 */
router.get('/data-preview',
    auth.authenticate,
    async (req, res) => {
        const userId = req.user.id;
        const preview = await DsrService.getDataPreview(userId);
        res.json(preview);
    }
);

module.exports = router;
```

### 3. DSR 核心服务实现

```javascript
// backend/services/user/src/services/DsrService.js
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const db = require('../../../shared/database');
const NotificationService = require('./NotificationService');
const DataExportService = require('./DataExportService');
const DataDeletionService = require('./DataDeletionService');

class DsrService {
    /**
     * 创建数据主体请求
     */
    static async createRequest({ userId, requestType, requestDetails, verificationMethod, ipAddress, userAgent }) {
        const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30天法定期限
        
        const request = await db.queryOne(`
            INSERT INTO data_subject_requests 
            (user_id, request_type, request_details, verification_method, deadline, ip_address, user_agent, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted')
            RETURNING *
        `, [userId, requestType, JSON.stringify(requestDetails), verificationMethod, deadline, ipAddress, userAgent]);
        
        // 记录创建日志
        await this.logAction(request.id, 'request_created', 'user', userId, {
            request_type: requestType,
            verification_method: verificationMethod
        });
        
        return request;
    }
    
    /**
     * 发送验证邮件
     */
    static async sendVerificationEmail(requestId) {
        const request = await db.queryOne(`
            SELECT r.*, u.email, u.username
            FROM data_subject_requests r
            JOIN users u ON r.user_id = u.id
            WHERE r.id = $1
        `, [requestId]);
        
        const verificationCode = crypto.randomInt(100000, 999999).toString();
        const codeExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24小时有效
        
        // 存储验证码（使用 Redis）
        await redis.setex(`dsr:verify:${requestId}`, 86400, JSON.stringify({
            code: verificationCode,
            user_id: request.user_id,
            attempts: 0
        }));
        
        await NotificationService.sendEmail(request.email, 'dsr_verification', {
            username: request.username,
            verification_code: verificationCode,
            request_type: this.getRequestTypeName(request.request_type),
            deadline: request.deadline
        });
    }
    
    /**
     * 验证请求
     */
    static async verifyRequest(requestId, userId, verificationCode) {
        const stored = await redis.get(`dsr:verify:${requestId}`);
        
        if (!stored) {
            return { success: false, message: '验证码已过期，请重新请求' };
        }
        
        const verifyData = JSON.parse(stored);
        
        if (verifyData.user_id !== userId) {
            return { success: false, message: '无效的请求' };
        }
        
        if (verifyData.attempts >= 3) {
            return { success: false, message: '验证尝试次数过多，请重新请求' };
        }
        
        if (verifyData.code !== verificationCode) {
            verifyData.attempts++;
            await redis.setex(`dsr:verify:${requestId}`, 86400, JSON.stringify(verifyData));
            return { success: false, message: `验证码错误，剩余 ${3 - verifyData.attempts} 次机会` };
        }
        
        // 验证成功，更新状态并开始处理
        await db.query(`
            UPDATE data_subject_requests 
            SET status = 'processing', 
                verification_status = 'verified',
                verified_at = NOW(),
                processing_started_at = NOW()
            WHERE id = $1
        `, [requestId]);
        
        await this.logAction(requestId, 'request_verified', 'user', userId);
        
        // 触发异步处理
        await this.queueProcessing(requestId);
        
        // 删除验证码
        await redis.del(`dsr:verify:${requestId}`);
        
        return { success: true };
    }
    
    /**
     * 队列处理请求
     */
    static async queueProcessing(requestId) {
        const request = await db.queryOne(
            'SELECT * FROM data_subject_requests WHERE id = $1',
            [requestId]
        );
        
        // 发布到 Kafka 处理队列
        await kafka.publish('dsr-processing', {
            request_id: requestId,
            request_type: request.request_type,
            user_id: request.user_id,
            request_details: request.request_details,
            priority: request.priority
        });
    }
    
    /**
     * 处理访问请求（数据导出）
     */
    static async processAccessRequest(requestId) {
        const request = await db.queryOne(
            'SELECT * FROM data_subject_requests WHERE id = $1',
            [requestId]
        );
        
        // 聚合所有数据
        const userData = await DataExportService.aggregateUserData(request.user_id);
        
        // 生成导出文件
        const exportResult = await DataExportService.generateExport(userData, {
            format: request.request_details.format || 'json',
            requestId
        });
        
        // 更新请求状态
        await db.query(`
            UPDATE data_subject_requests 
            SET status = 'completed',
                processing_completed_at = NOW(),
                result_data = $1,
                result_file_url = $2
            WHERE id = $3
        `, [JSON.stringify({ record_count: userData.totalRecords }), exportResult.url, requestId]);
        
        await this.logAction(requestId, 'request_completed', 'system', null, {
            export_file_size: exportResult.size,
            record_count: userData.totalRecords
        });
        
        // 通知用户
        await NotificationService.sendDsrCompletionNotification(requestId);
    }
    
    /**
     * 处理删除请求
     */
    static async processErasureRequest(requestId) {
        const request = await db.queryOne(
            'SELECT * FROM data_subject_requests WHERE id = $1',
            [requestId]
        );
        
        const scope = request.request_details.scope || 'full';
        
        // 检查是否有删除限制（如正在进行的交易、法律要求保留的数据等）
        const restrictions = await DataDeletionService.checkRestrictions(request.user_id);
        
        if (restrictions.length > 0) {
            await db.query(`
                UPDATE data_subject_requests 
                SET status = 'rejected',
                    rejection_reason = $1,
                    processing_completed_at = NOW()
                WHERE id = $2
            `, [`存在删除限制：${restrictions.join(', ')}`, requestId]);
            
            await this.logAction(requestId, 'request_rejected', 'system', null, { restrictions });
            return;
        }
        
        // 执行级联删除
        const deletionResult = await DataDeletionService.cascadeDelete(request.user_id, {
            requestId,
            scope
        });
        
        // 记录删除审计
        for (const table of deletionResult.deletedTables) {
            await db.query(`
                INSERT INTO data_deletion_audit 
                (request_id, table_name, record_count, deleted_by, verification_hash)
                VALUES ($1, $2, $3, 'dsr_automation', $4)
            `, [requestId, table.tableName, table.count, this.generateDeletionHash(table)]);
        }
        
        // 更新请求状态
        await db.query(`
            UPDATE data_subject_requests 
            SET status = 'completed',
                processing_completed_at = NOW(),
                result_data = $1
            WHERE id = $2
        `, [JSON.stringify(deletionResult.summary), requestId]);
        
        await this.logAction(requestId, 'request_completed', 'system', null, deletionResult.summary);
    }
    
    /**
     * 处理限制处理请求
     */
    static async processRestrictionRequest(requestId) {
        const request = await db.queryOne(
            'SELECT * FROM data_subject_requests WHERE id = $1',
            [requestId]
        );
        
        const restrictionType = request.request_details.restriction_type || 'processing';
        
        // 设置数据限制标记
        await db.query(`
            INSERT INTO data_restriction_flags 
            (user_id, restriction_type, request_id, reason)
            VALUES ($1, $2, $3, $4)
        `, [request.user_id, restrictionType, requestId, request.request_details.reason]);
        
        // 通知相关服务停止处理该用户数据
        await this.broadcastRestriction(request.user_id, restrictionType);
        
        await db.query(`
            UPDATE data_subject_requests 
            SET status = 'completed', processing_completed_at = NOW()
            WHERE id = $1
        `, [requestId]);
        
        await this.logAction(requestId, 'restriction_applied', 'system', null, { restriction_type: restrictionType });
    }
    
    /**
     * 获取数据预览
     */
    static async getDataPreview(userId) {
        const preview = {
            profile: await db.queryOne(
                'SELECT COUNT(*) as count FROM users WHERE id = $1',
                [userId]
            ),
            pokemon: await db.queryOne(
                'SELECT COUNT(*) as count FROM user_pokemon WHERE user_id = $1',
                [userId]
            ),
            transactions: await db.queryOne(
                'SELECT COUNT(*) as count FROM payment_orders WHERE user_id = $1',
                [userId]
            ),
            social: await db.queryOne(
                'SELECT COUNT(*) as count FROM user_friends WHERE user_id = $1 OR friend_id = $1',
                [userId]
            ),
            activities: await db.queryOne(
                'SELECT COUNT(*) as count FROM user_activities WHERE user_id = $1',
                [userId]
            )
        };
        
        return {
            data_categories: preview,
            estimated_export_size: this.estimateExportSize(preview),
            data_retention_periods: await this.getDataRetentionInfo(userId)
        };
    }
    
    /**
     * 记录处理日志
     */
    static async logAction(requestId, action, actorType, actorId, details = {}) {
        await db.query(`
            INSERT INTO dsr_processing_logs 
            (request_id, action, actor_type, actor_id, details)
            VALUES ($1, $2, $3, $4, $5)
        `, [requestId, action, actorType, actorId, JSON.stringify(details)]);
    }
    
    /**
     * 获取请求类型名称
     */
    static getRequestTypeName(type) {
        const names = {
            access: '数据访问请求',
            rectification: '数据更正请求',
            erasure: '数据删除请求',
            restriction: '处理限制请求',
            portability: '数据可携带请求',
            object: '处理反对请求'
        };
        return names[type] || type;
    }
    
    /**
     * 生成删除验证哈希
     */
    static generateDeletionHash(tableInfo) {
        return crypto
            .createHash('sha256')
            .update(`${tableInfo.tableName}:${tableInfo.count}:${Date.now()}`)
            .digest('hex');
    }
}

module.exports = DsrService;
```

### 4. 数据导出服务

```javascript
// backend/services/user/src/services/DataExportService.js
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const { Parser } = require('json2csv');
const archiver = require('archiver');
const PassThrough = require('stream').PassThrough;

class DataExportService {
    /**
     * 聚合用户所有数据
     */
    static async aggregateUserData(userId) {
        const data = {
            personalInfo: await this.getPersonalInfo(userId),
            pokemon: await this.getPokemonData(userId),
            social: await this.getSocialData(userId),
            transactions: await this.getTransactionData(userId),
            activities: await this.getActivityData(userId),
            preferences: await this.getPreferences(userId),
            devices: await this.getDeviceData(userId),
            locations: await this.getLocationData(userId)
        };
        
        data.totalRecords = Object.values(data).reduce((sum, arr) => {
            if (Array.isArray(arr)) return sum + arr.length;
            if (arr && typeof arr === 'object') return sum + 1;
            return sum;
        }, 0);
        
        return data;
    }
    
    static async getPersonalInfo(userId) {
        return await db.queryOne(`
            SELECT id, username, email, display_name, created_at, updated_at, 
                   timezone, language, country
            FROM users WHERE id = $1
        `, [userId]);
    }
    
    static async getPokemonData(userId) {
        return await db.query(`
            SELECT p.*, up.nickname, up.caught_at, up.location_caught, 
                   up.experience, up.level, up.is_favorite
            FROM user_pokemon up
            JOIN pokemon p ON up.pokemon_id = p.id
            WHERE up.user_id = $1
            ORDER BY up.caught_at DESC
        `, [userId]);
    }
    
    static async getSocialData(userId) {
        const friends = await db.query(`
            SELECT u.id, u.username, u.display_name, f.created_at as friends_since
            FROM user_friends f
            JOIN users u ON (CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END) = u.id
            WHERE f.user_id = $1 OR f.friend_id = $1
        `, [userId]);
        
        const guild = await db.queryOne(`
            SELECT g.*, gm.role, gm.joined_at
            FROM guild_members gm
            JOIN guilds g ON gm.guild_id = g.id
            WHERE gm.user_id = $1
        `, [userId]);
        
        return { friends, guild };
    }
    
    static async getTransactionData(userId) {
        return await db.query(`
            SELECT id, order_type, amount, currency, status, 
                   created_at, completed_at, payment_method
            FROM payment_orders 
            WHERE user_id = $1
            ORDER BY created_at DESC
        `, [userId]);
    }
    
    static async getActivityData(userId) {
        return await db.query(`
            SELECT activity_type, details, created_at, ip_address
            FROM user_activities 
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 1000
        `, [userId]);
    }
    
    static async getPreferences(userId) {
        return await db.queryOne(`
            SELECT notification_preferences, privacy_settings, 
                   game_settings, accessibility_settings
            FROM user_preferences WHERE user_id = $1
        `, [userId]);
    }
    
    static async getDeviceData(userId) {
        return await db.query(`
            SELECT device_id, device_type, os, os_version, 
                   app_version, last_used_at, created_at
            FROM user_devices WHERE user_id = $1
        `, [userId]);
    }
    
    static async getLocationData(userId) {
        return await db.query(`
            SELECT latitude, longitude, captured_at, activity_type
            FROM user_location_history 
            WHERE user_id = $1
            ORDER BY captured_at DESC
            LIMIT 500
        `, [userId]);
    }
    
    /**
     * 生成导出文件
     */
    static async generateExport(userData, options) {
        const { format = 'json', requestId } = options;
        const filename = `user_data_export_${requestId}`;
        
        let content, contentType, extension;
        
        if (format === 'json') {
            content = JSON.stringify(userData, null, 2);
            contentType = 'application/json';
            extension = 'json';
        } else if (format === 'csv') {
            // CSV 需要分成多个文件
            return await this.generateCsvZip(userData, filename);
        } else if (format === 'xml') {
            content = this.jsonToXml(userData);
            contentType = 'application/xml';
            extension = 'xml';
        }
        
        // 上传到 S3
        const key = `dsr-exports/${filename}.${extension}`;
        await s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: content,
            ContentType: contentType,
            ServerSideEncryption: 'AES256',
            Metadata: {
                'request-id': requestId,
                'user-id': userData.personalInfo.id,
                'export-date': new Date().toISOString()
            }
        }).promise();
        
        // 生成预签名 URL（7天有效）
        const url = s3.getSignedUrl('getObject', {
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Expires: 7 * 24 * 60 * 60
        });
        
        // 记录导出
        await db.query(`
            INSERT INTO data_export_records 
            (request_id, export_type, file_format, file_url, file_size_bytes, 
             checksum_sha256, expires_at)
            VALUES ($1, 'full', $2, $3, $4, $5, $6)
        `, [
            requestId,
            format,
            url,
            Buffer.byteLength(content),
            this.calculateChecksum(content),
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        ]);
        
        return {
            url,
            size: Buffer.byteLength(content),
            format,
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        };
    }
    
    /**
     * 生成 CSV ZIP 压缩包
     */
    static async generateCsvZip(userData, filename) {
        const zipBuffer = await new Promise((resolve, reject) => {
            const chunks = [];
            const pt = new PassThrough();
            
            pt.on('data', chunk => chunks.push(chunk));
            pt.on('end', () => resolve(Buffer.concat(chunks)));
            pt.on('error', reject);
            
            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(pt);
            
            // 为每个数据类别创建 CSV
            for (const [key, value] of Object.entries(userData)) {
                if (value && (Array.isArray(value) || typeof value === 'object')) {
                    const csv = this.jsonToCsv(Array.isArray(value) ? value : [value]);
                    archive.append(csv, { name: `${key}.csv` });
                }
            }
            
            archive.finalize();
        });
        
        // 上传 ZIP
        const key = `dsr-exports/${filename}.zip`;
        await s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: zipBuffer,
            ContentType: 'application/zip'
        }).promise();
        
        return {
            url: s3.getSignedUrl('getObject', {
                Bucket: process.env.S3_BUCKET,
                Key: key,
                Expires: 7 * 24 * 60 * 60
            }),
            size: zipBuffer.length,
            format: 'zip'
        };
    }
    
    static jsonToCsv(data) {
        if (!data || data.length === 0) return '';
        const parser = new Parser();
        return parser.parse(data);
    }
    
    static jsonToXml(obj, rootName = 'data') {
        // 简化实现，生产环境应使用专业库
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}>`;
        xml += this.objectToXml(obj);
        xml += `</${rootName}>`;
        return xml;
    }
    
    static objectToXml(obj, indent = 1) {
        let xml = '';
        const spaces = '  '.repeat(indent);
        
        for (const [key, value] of Object.entries(obj)) {
            if (value === null || value === undefined) continue;
            
            if (Array.isArray(value)) {
                xml += `\n${spaces}<${key}>`;
                for (const item of value) {
                    xml += `\n${spaces}  <item>`;
                    xml += this.objectToXml(item, indent + 2);
                    xml += `</item>`;
                }
                xml += `\n${spaces}</${key}>`;
            } else if (typeof value === 'object') {
                xml += `\n${spaces}<${key}>`;
                xml += this.objectToXml(value, indent + 1);
                xml += `\n${spaces}</${key}>`;
            } else {
                xml += `\n${spaces}<${key}>${this.escapeXml(value)}</${key}>`;
            }
        }
        
        return xml;
    }
    
    static escapeXml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
    
    static calculateChecksum(content) {
        return crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');
    }
}

module.exports = DataExportService;
```

### 5. 管理后台 DSR 管理

```javascript
// frontend/admin-dashboard/src/pages/DsrManagement.vue
<template>
  <div class="dsr-management">
    <h1>数据主体请求管理</h1>
    
    <!-- 统计概览 -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">{{ stats.pending }}</div>
        <div class="stat-label">待处理</div>
      </div>
      <div class="stat-card urgent">
        <div class="stat-value">{{ stats.urgent }}</div>
        <div class="stat-label">紧急（即将超期）</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.processing }}</div>
        <div class="stat-label">处理中</div>
      </div>
      <div class="stat-card success">
        <div class="stat-value">{{ stats.completed }}</div>
        <div class="stat-label">已完成</div>
      </div>
    </div>
    
    <!-- 筛选和搜索 -->
    <div class="filters">
      <select v-model="filters.status">
        <option value="">所有状态</option>
        <option value="submitted">待验证</option>
        <option value="processing">处理中</option>
        <option value="completed">已完成</option>
        <option value="rejected">已拒绝</option>
      </select>
      
      <select v-model="filters.request_type">
        <option value="">所有类型</option>
        <option value="access">数据访问</option>
        <option value="erasure">数据删除</option>
        <option value="portability">数据导出</option>
        <option value="rectification">数据更正</option>
      </select>
      
      <input type="text" v-model="filters.search" placeholder="搜索用户ID或邮箱...">
      
      <button @click="loadRequests" class="btn-primary">刷新</button>
    </div>
    
    <!-- 请求列表 -->
    <table class="requests-table">
      <thead>
        <tr>
          <th>请求ID</th>
          <th>用户</th>
          <th>类型</th>
          <th>状态</th>
          <th>剩余时间</th>
          <th>创建时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="request in requests" :key="request.id" 
            :class="{ 'urgent-row': isUrgent(request) }">
          <td><code>{{ request.id.slice(0, 8) }}</code></td>
          <td>{{ request.username }}<br><small>{{ request.email }}</small></td>
          <td>
            <span :class="'type-badge ' + request.request_type">
              {{ getTypeName(request.request_type) }}
            </span>
          </td>
          <td>
            <span :class="'status-badge ' + request.status">
              {{ getStatusName(request.status) }}
            </span>
          </td>
          <td :class="{ 'text-danger': isUrgent(request) }">
            {{ getRemainingTime(request.deadline) }}
          </td>
          <td>{{ formatDate(request.created_at) }}</td>
          <td>
            <button @click="viewRequest(request)" class="btn-small">查看</button>
            <button v-if="request.status === 'processing'" 
                    @click="completeRequest(request)" class="btn-small btn-success">
              完成
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    
    <!-- 详情模态框 -->
    <div v-if="selectedRequest" class="modal">
      <div class="modal-content">
        <h2>请求详情</h2>
        <button @click="selectedRequest = null" class="close-btn">&times;</button>
        
        <div class="detail-section">
          <h3>基本信息</h3>
          <div class="detail-grid">
            <div><strong>请求类型：</strong>{{ getTypeName(selectedRequest.request_type) }}</div>
            <div><strong>状态：</strong>{{ getStatusName(selectedRequest.status) }}</div>
            <div><strong>优先级：</strong>{{ selectedRequest.priority }}</div>
            <div><strong>截止日期：</strong>{{ formatDate(selectedRequest.deadline) }}</div>
          </div>
        </div>
        
        <div class="detail-section">
          <h3>请求详情</h3>
          <pre>{{ JSON.stringify(selectedRequest.request_details, null, 2) }}</pre>
        </div>
        
        <div class="detail-section">
          <h3>处理日志</h3>
          <div class="timeline">
            <div v-for="log in logs" :key="log.id" class="timeline-item">
              <div class="timeline-time">{{ formatDate(log.created_at) }}</div>
              <div class="timeline-action">{{ log.action }}</div>
              <div class="timeline-actor">{{ log.actor_type }}: {{ log.actor_id || 'system' }}</div>
            </div>
          </div>
        </div>
        
        <div v-if="selectedRequest.status === 'processing'" class="actions">
          <button @click="approveRequest" class="btn-success">批准并执行</button>
          <button @click="rejectRequest" class="btn-danger">拒绝请求</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, computed } from 'vue';
import axios from 'axios';

export default {
  setup() {
    const requests = ref([]);
    const stats = ref({ pending: 0, urgent: 0, processing: 0, completed: 0 });
    const selectedRequest = ref(null);
    const logs = ref([]);
    
    const filters = ref({
      status: '',
      request_type: '',
      search: ''
    });
    
    const loadRequests = async () => {
      const { data } = await axios.get('/api/admin/dsr/requests', {
        params: filters.value
      });
      requests.value = data.requests;
      stats.value = data.stats;
    };
    
    const viewRequest = async (request) => {
      selectedRequest.value = request;
      const { data } = await axios.get(`/api/admin/dsr/requests/${request.id}/logs`);
      logs.value = data.logs;
    };
    
    const completeRequest = async (request) => {
      await axios.post(`/api/admin/dsr/requests/${request.id}/complete`);
      loadRequests();
    };
    
    const isUrgent = (request) => {
      const remaining = new Date(request.deadline) - new Date();
      return remaining < 7 * 24 * 60 * 60 * 1000; // 少于7天为紧急
    };
    
    const getRemainingTime = (deadline) => {
      const remaining = new Date(deadline) - new Date();
      const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
      if (days < 0) return '已超期';
      if (days === 0) return '今天截止';
      return `${days}天`;
    };
    
    onMounted(loadRequests);
    
    return {
      requests, stats, selectedRequest, logs, filters,
      loadRequests, viewRequest, completeRequest, isUrgent, getRemainingTime,
      getTypeName: (type) => ({ access: '数据访问', erasure: '数据删除', portability: '数据导出' }[type] || type),
      getStatusName: (status) => ({ submitted: '待验证', processing: '处理中', completed: '已完成' }[status] || status),
      formatDate: (date) => new Date(date).toLocaleString()
    };
  }
};
</script>
```

### 6. 后台任务处理

```javascript
// backend/jobs/dsr-processor.js
const { Worker } = require('bullmq');
const DsrService = require('../services/user/src/services/DsrService');

const worker = new Worker('dsr-processing', async job => {
    const { request_id, request_type, user_id, request_details } = job.data;
    
    try {
        await job.updateProgress(10);
        
        switch (request_type) {
            case 'access':
            case 'portability':
                await DsrService.processAccessRequest(request_id);
                break;
                
            case 'erasure':
                await DsrService.processErasureRequest(request_id);
                break;
                
            case 'restriction':
                await DsrService.processRestrictionRequest(request_id);
                break;
                
            case 'rectification':
                await DsrService.processRectificationRequest(request_id);
                break;
                
            case 'object':
                await DsrService.processObjectionRequest(request_id);
                break;
        }
        
        await job.updateProgress(100);
        
    } catch (error) {
        // 记录错误并更新请求状态
        await DsrService.markRequestFailed(request_id, error.message);
        throw error;
    }
}, {
    connection: { host: 'redis', port: 6379 },
    concurrency: 3
});

worker.on('completed', job => {
    console.log(`DSR request ${job.data.request_id} completed`);
});

worker.on('failed', (job, err) => {
    console.error(`DSR request ${job.data.request_id} failed:`, err);
});
```

### 7. 定时任务 - 截止日期监控

```javascript
// backend/jobs/dsr-deadline-monitor.js
const cron = require('node-cron');
const NotificationService = require('../services/user/src/services/NotificationService');

// 每小时检查即将超期的请求
cron.schedule('0 * * * *', async () => {
    const urgentRequests = await db.query(`
        SELECT r.*, u.email, u.username
        FROM data_subject_requests r
        JOIN users u ON r.user_id = u.id
        WHERE r.status IN ('submitted', 'verifying', 'processing')
        AND r.deadline < NOW() + INTERVAL '7 days'
        ORDER BY r.deadline ASC
    `);
    
    for (const request of urgentRequests) {
        const daysRemaining = Math.ceil((new Date(request.deadline) - new Date()) / (24 * 60 * 60 * 1000));
        
        // 通知管理员
        await NotificationService.sendAdminAlert('dsr_deadline_approaching', {
            request_id: request.id,
            request_type: request.request_type,
            username: request.username,
            days_remaining: daysRemaining
        });
        
        // 如果快到截止日期，升级优先级
        if (daysRemaining <= 3) {
            await db.query(
                'UPDATE data_subject_requests SET priority = $1 WHERE id = $2',
                ['urgent', request.id]
            );
        }
    }
});

// 每天检查已超期的请求
cron.schedule('0 9 * * *', async () => {
    const expiredRequests = await db.query(`
        SELECT * FROM data_subject_requests
        WHERE status NOT IN ('completed', 'rejected', 'expired')
        AND deadline < NOW()
    `);
    
    for (const request of expiredRequests) {
        await db.query(`
            UPDATE data_subject_requests 
            SET status = 'expired'
            WHERE id = $1
        `, [request.id]);
        
        // 记录合规违规
        await ComplianceService.recordViolation({
            type: 'gdpr_deadline_missed',
            request_id: request.id,
            user_id: request.user_id,
            deadline: request.deadline,
            actual_completion: new Date()
        });
    }
});
```

## 验收标准

- [ ] 用户可通过游戏内界面提交所有类型的 GDPR 数据主体请求
- [ ] 访问请求：用户可在 30 天内获得完整的个人数据副本（JSON/CSV/XML 格式）
- [ ] 删除请求：用户数据被正确级联删除，保留必要的审计日志
- [ ] 删除请求：已删除数据无法恢复，生成删除验证哈希
- [ ] 数据导出文件加密存储，下载链接 7 天后自动失效
- [ ] 每个请求有完整的处理日志和审计追踪
- [ ] 管理后台可查看、筛选、搜索所有 DSR 请求
- [ ] 系统自动监控截止日期，提前 7 天/3 天/1 天发出告警
- [ ] 超期请求自动标记并记录合规违规
- [ ] 每月生成 DSR 处理报告（平均响应时间、完成率、超期率）
- [ ] 支持批量导出合规报告（供监管机构审计）

## 影响范围

- backend/services/user/src/routes/dsr.js（新增）
- backend/services/user/src/services/DsrService.js（新增）
- backend/services/user/src/services/DataExportService.js（新增）
- backend/services/user/src/services/DataDeletionService.js（新增）
- database/migrations/（新增 5 张表）
- frontend/admin-dashboard/src/pages/DsrManagement.vue（新增）
- gateway/src/routes/dsr.js（路由代理）
- backend/jobs/dsr-processor.js（新增）
- backend/jobs/dsr-deadline-monitor.js（新增）
- backend/shared/compliance/GdprCompliance.js（新增）

## 参考

- [GDPR Article 15 - Right of access](https://gdpr-info.eu/art-15-gdpr/)
- [GDPR Article 17 - Right to erasure](https://gdpr-info.eu/art-17-gdpr/)
- [GDPR Article 20 - Right to data portability](https://gdpr-info.eu/art-20-gdpr/)
- [ICO - Subject Access Request Code of Practice](https://ico.org.uk/for-organisations/guide-to-data-protection/individual-rights/right-of-access/)
