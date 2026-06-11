# REQ-00129: 精灵数据备份与恢复系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00129 |
| 标题 | 精灵数据备份与恢复系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、database、backend/jobs、gateway |
| 创建时间 | 2026-06-11 21:30 |

## 需求描述

为精灵数据提供完整的备份与恢复机制，支持用户主动备份、自动定时备份、灾难恢复和跨设备数据迁移，确保玩家精灵数据永不丢失。

### 背景
- 精灵是玩家最核心的游戏资产，数据丢失将导致严重的用户流失
- 当前缺乏细粒度的备份机制，仅依赖数据库全量备份
- 玩家换设备、误操作、账号被盗等场景需要数据恢复能力
- GDPR/数据保护法规要求提供数据导出能力

### 目标
1. 支持用户主动创建精灵数据快照备份
2. 自动定时备份玩家精灵数据（每日增量、每周全量）
3. 提供数据恢复功能，支持按时间点恢复
4. 支持跨设备数据迁移和导出
5. 符合 GDPR 数据可携带性要求

## 技术方案

### 1. 数据库表设计

```sql
-- 备份元数据表
CREATE TABLE pokemon_backup_metadata (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    backup_type VARCHAR(20) NOT NULL, -- 'manual', 'auto_daily', 'auto_weekly', 'migration'
    backup_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'expired'
    backup_size_bytes BIGINT,
    pokemon_count INTEGER,
    storage_path VARCHAR(500),
    checksum VARCHAR(64),
    encryption_key_id VARCHAR(100),
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    INDEX idx_user_backups (user_id, created_at DESC),
    INDEX idx_backup_status (backup_status, created_at)
);

-- 备份内容表（存储序列化数据）
CREATE TABLE pokemon_backup_contents (
    id SERIAL PRIMARY KEY,
    backup_id INTEGER NOT NULL REFERENCES pokemon_backup_metadata(id) ON DELETE CASCADE,
    pokemon_id INTEGER NOT NULL,
    pokemon_data JSONB NOT NULL, -- 完整精灵数据快照
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_backup_contents (backup_id)
);

-- 恢复记录表
CREATE TABLE pokemon_restore_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    backup_id INTEGER REFERENCES pokemon_backup_metadata(id),
    restore_type VARCHAR(20) NOT NULL, -- 'full', 'partial', 'point_in_time'
    restore_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    restored_pokemon_count INTEGER,
    conflicts_resolved INTEGER,
    restore_log TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    INDEX idx_user_restores (user_id, created_at DESC),
    INDEX idx_restore_status (restore_status)
);

-- 备份配额表
CREATE TABLE user_backup_quotas (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    max_manual_backups INTEGER DEFAULT 5,
    current_manual_backups INTEGER DEFAULT 0,
    total_backup_bytes BIGINT DEFAULT 0,
    last_backup_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2. 核心备份服务模块

```javascript
// backend/shared/pokemonBackupService.js

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class PokemonBackupService {
    constructor(db, redis, s3Client, encryptionKeyManager) {
        this.db = db;
        this.redis = redis;
        this.s3Client = s3Client;
        this.keyManager = encryptionKeyManager;
    }

    /**
     * 创建用户精灵备份
     * @param {number} userId - 用户ID
     * @param {string} backupType - 备份类型
     * @param {object} options - 备份选项
     */
    async createBackup(userId, backupType = 'manual', options = {}) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 检查配额
            const quotaCheck = await this.checkBackupQuota(userId, backupType);
            if (!quotaCheck.allowed) {
                throw new Error(`Backup quota exceeded: ${quotaCheck.reason}`);
            }
            
            // 创建备份元数据
            const metadataResult = await client.query(`
                INSERT INTO pokemon_backup_metadata 
                (user_id, backup_type, backup_status)
                VALUES ($1, $2, 'pending')
                RETURNING id
            `, [userId, backupType]);
            
            const backupId = metadataResult.rows[0].id;
            
            // 获取用户所有精灵数据
            const pokemonResult = await client.query(`
                SELECT 
                    p.*,
                    json_agg(
                        json_build_object(
                            'skill_id', ps.skill_id,
                            'current_pp', ps.current_pp
                        )
                    ) as skills,
                    json_build_object(
                        'attack_iv', pva.attack_iv,
                        'defense_iv', pva.defense_iv,
                        'stamina_iv', pva.stamina_iv,
                        'level', pva.level
                    ) as iv_data
                FROM pokemons p
                LEFT JOIN pokemon_skills ps ON p.id = ps.pokemon_id
                LEFT JOIN pokemon_iv_attributes pva ON p.id = pva.pokemon_id
                WHERE p.user_id = $1
                GROUP BY p.id, pva.attack_iv, pva.defense_iv, pva.stamina_iv, pva.level
            `, [userId]);
            
            const pokemonList = pokemonResult.rows;
            
            // 序列化并加密数据
            const backupData = {
                version: '1.0',
                created_at: new Date().toISOString(),
                user_id: userId,
                pokemon_count: pokemonList.length,
                pokemon: pokemonList
            };
            
            const serialized = JSON.stringify(backupData);
            const compressed = await gzip(Buffer.from(serialized));
            
            // 加密
            const encryptionKey = await this.keyManager.generateDataKey();
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey.plaintext, iv);
            const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
            const authTag = cipher.getAuthTag();
            
            const encryptedData = Buffer.concat([iv, authTag, encrypted]);
            
            // 计算校验和
            const checksum = crypto.createHash('sha256').update(encryptedData).digest('hex');
            
            // 上传到存储
            const storagePath = `backups/${userId}/${backupId}-${Date.now()}.enc`;
            await this.s3Client.upload({
                Bucket: process.env.BACKUP_BUCKET,
                Key: storagePath,
                Body: encryptedData,
                Metadata: {
                    'user-id': userId.toString(),
                    'backup-id': backupId.toString(),
                    'backup-type': backupType,
                    'pokemon-count': pokemonList.length.toString(),
                    'checksum': checksum
                }
            }).promise();
            
            // 设置过期时间
            const expiresAt = this.calculateExpiryDate(backupType);
            
            // 更新备份元数据
            await client.query(`
                UPDATE pokemon_backup_metadata
                SET backup_status = 'completed',
                    backup_size_bytes = $1,
                    pokemon_count = $2,
                    storage_path = $3,
                    checksum = $4,
                    encryption_key_id = $5,
                    expires_at = $6,
                    completed_at = CURRENT_TIMESTAMP
                WHERE id = $7
            `, [
                encryptedData.length,
                pokemonList.length,
                storagePath,
                checksum,
                encryptionKey.keyId,
                expiresAt,
                backupId
            ]);
            
            // 更新配额
            await this.updateBackupQuota(userId, encryptedData.length, backupType);
            
            await client.query('COMMIT');
            
            // 记录指标
            this.recordBackupMetrics(backupType, pokemonList.length, encryptedData.length);
            
            return {
                backup_id: backupId,
                backup_type: backupType,
                pokemon_count: pokemonList.length,
                backup_size_bytes: encryptedData.length,
                expires_at: expiresAt
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 从备份恢复精灵数据
     * @param {number} userId - 用户ID
     * @param {number} backupId - 备份ID
     * @param {object} options - 恢复选项
     */
    async restoreFromBackup(userId, backupId, options = {}) {
        const { 
            restoreMode = 'merge', // 'merge', 'replace', 'append'
            conflictResolution = 'keep_current' // 'keep_current', 'use_backup', 'rename'
        } = options;
        
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            // 验证备份所有权和状态
            const backupCheck = await client.query(`
                SELECT * FROM pokemon_backup_metadata
                WHERE id = $1 AND user_id = $2 AND backup_status = 'completed'
            `, [backupId, userId]);
            
            if (backupCheck.rows.length === 0) {
                throw new Error('Backup not found or not accessible');
            }
            
            const backup = backupCheck.rows[0];
            
            // 检查过期
            if (backup.expires_at && new Date(backup.expires_at) < new Date()) {
                throw new Error('Backup has expired');
            }
            
            // 创建恢复记录
            const restoreRecord = await client.query(`
                INSERT INTO pokemon_restore_records
                (user_id, backup_id, restore_type, restore_status)
                VALUES ($1, $2, 'full', 'processing')
                RETURNING id
            `, [userId, backupId]);
            
            const restoreId = restoreRecord.rows[0].id;
            
            // 下载并解密备份数据
            const backupData = await this.downloadAndDecryptBackup(backup);
            
            let restoredCount = 0;
            let conflictsResolved = 0;
            const restoreLog = [];
            
            if (restoreMode === 'replace') {
                // 删除当前所有精灵
                await client.query('DELETE FROM pokemons WHERE user_id = $1', [userId]);
                restoreLog.push(`Deleted all current Pokemon for user ${userId}`);
            }
            
            // 恢复精灵数据
            for (const pokemon of backupData.pokemon) {
                const conflictResult = await this.restoreSinglePokemon(
                    client, 
                    userId, 
                    pokemon, 
                    restoreMode, 
                    conflictResolution
                );
                
                if (conflictResult.restored) {
                    restoredCount++;
                }
                if (conflictResult.conflict) {
                    conflictsResolved++;
                    restoreLog.push(`Conflict resolved for Pokemon ${pokemon.id}: ${conflictResult.resolution}`);
                }
            }
            
            // 更新恢复记录
            await client.query(`
                UPDATE pokemon_restore_records
                SET restore_status = 'completed',
                    restored_pokemon_count = $1,
                    conflicts_resolved = $2,
                    restore_log = $3,
                    completed_at = CURRENT_TIMESTAMP
                WHERE id = $4
            `, [restoredCount, conflictsResolved, restoreLog.join('\n'), restoreId]);
            
            await client.query('COMMIT');
            
            // 清除相关缓存
            await this.clearUserPokemonCache(userId);
            
            // 记录指标
            this.recordRestoreMetrics(restoredCount, conflictsResolved);
            
            return {
                restore_id: restoreId,
                restored_count: restoredCount,
                conflicts_resolved: conflictsResolved,
                status: 'completed'
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            
            // 更新恢复记录为失败
            await client.query(`
                UPDATE pokemon_restore_records
                SET restore_status = 'failed',
                    restore_log = $1
                WHERE id = $2
            `, [error.message, restoreRecord.rows[0]?.id]);
            
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 导出精灵数据（GDPR 数据可携带性）
     */
    async exportUserData(userId, format = 'json') {
        // 创建导出备份
        const backup = await this.createBackup(userId, 'migration');
        
        // 获取解密后的数据
        const backupData = await this.downloadAndDecryptBackup(
            await this.db.query(`
                SELECT * FROM pokemon_backup_metadata WHERE id = $1
            `, [backup.backup_id]).then(r => r.rows[0])
        );
        
        if (format === 'json') {
            return JSON.stringify(backupData, null, 2);
        } else if (format === 'csv') {
            return this.convertToCSV(backupData.pokemon);
        }
        
        return backupData;
    }

    /**
     * 获取用户备份列表
     */
    async getUserBackups(userId, options = {}) {
        const { limit = 20, offset = 0, type } = options;
        
        let query = `
            SELECT 
                id, backup_type, backup_status, backup_size_bytes,
                pokemon_count, expires_at, created_at, completed_at
            FROM pokemon_backup_metadata
            WHERE user_id = $1 AND backup_status = 'completed'
        `;
        
        const params = [userId];
        let paramIndex = 2;
        
        if (type) {
            query += ` AND backup_type = $${paramIndex++}`;
            params.push(type);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
        params.push(limit, offset);
        
        const result = await this.db.query(query, params);
        
        // 获取总数
        const countResult = await this.db.query(`
            SELECT COUNT(*) FROM pokemon_backup_metadata
            WHERE user_id = $1 AND backup_status = 'completed'
        `, [userId]);
        
        return {
            backups: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit,
            offset
        };
    }

    /**
     * 设置自动备份
     */
    async setupAutoBackup(userId, schedule = 'daily') {
        const cronExpression = schedule === 'daily' ? '0 3 * * *' : '0 3 * * 0';
        
        await this.redis.hset(`autobackup:${userId}`, {
            enabled: 'true',
            schedule: schedule,
            cron: cronExpression,
            last_run: Date.now()
        });
        
        return { enabled: true, schedule, cron: cronExpression };
    }

    // 私有辅助方法...

    async checkBackupQuota(userId, backupType) {
        if (backupType === 'manual') {
            const quota = await this.db.query(`
                SELECT * FROM user_backup_quotas WHERE user_id = $1
            `, [userId]);
            
            if (quota.rows.length === 0) {
                return { allowed: true };
            }
            
            const q = quota.rows[0];
            if (q.current_manual_backups >= q.max_manual_backups) {
                return { 
                    allowed: false, 
                    reason: `Maximum manual backups (${q.max_manual_backups}) reached` 
                };
            }
        }
        
        return { allowed: true };
    }

    async downloadAndDecryptBackup(backup) {
        // 从 S3 下载
        const s3Object = await this.s3Client.getObject({
            Bucket: process.env.BACKUP_BUCKET,
            Key: backup.storage_path
        }).promise();
        
        const encryptedData = s3Object.Body;
        
        // 验证校验和
        const checksum = crypto.createHash('sha256').update(encryptedData).digest('hex');
        if (checksum !== backup.checksum) {
            throw new Error('Backup checksum mismatch - data may be corrupted');
        }
        
        // 解密
        const encryptionKey = await this.keyManager.getDataKey(backup.encryption_key_id);
        const iv = encryptedData.slice(0, 16);
        const authTag = encryptedData.slice(16, 32);
        const encrypted = encryptedData.slice(32);
        
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
        decipher.setAuthTag(authTag);
        
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        
        // 解压
        const decompressed = await gunzip(decrypted);
        
        return JSON.parse(decompressed.toString());
    }

    calculateExpiryDate(backupType) {
        const now = new Date();
        switch (backupType) {
            case 'manual':
                return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30天
            case 'auto_daily':
                return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7天
            case 'auto_weekly':
                return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30天
            case 'migration':
                return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7天
            default:
                return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        }
    }

    async restoreSinglePokemon(client, userId, pokemon, restoreMode, conflictResolution) {
        // 实现单个精灵恢复逻辑
        // 处理冲突、ID映射等
        // 返回 { restored: boolean, conflict: boolean, resolution: string }
        // ... 省略详细实现
        return { restored: true, conflict: false };
    }

    async updateBackupQuota(userId, sizeBytes, backupType) {
        if (backupType === 'manual') {
            await this.db.query(`
                INSERT INTO user_backup_quotas (user_id, current_manual_backups, total_backup_bytes, last_backup_at)
                VALUES ($1, 1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id)
                DO UPDATE SET
                    current_manual_backups = user_backup_quotas.current_manual_backups + 1,
                    total_backup_bytes = user_backup_quotas.total_backup_bytes + $2,
                    last_backup_at = CURRENT_TIMESTAMP
            `, [userId, sizeBytes]);
        }
    }

    async clearUserPokemonCache(userId) {
        await this.redis.del(`pokemon:user:${userId}`);
        await this.redis.del(`pokemon:count:${userId}`);
    }

    recordBackupMetrics(type, count, size) {
        // Prometheus 指标记录
        const { backupCounter, backupSizeHistogram, backupPokemonGauge } = require('./metrics');
        backupCounter.inc({ type });
        backupSizeHistogram.observe(size);
        backupPokemonGauge.set(count);
    }

    recordRestoreMetrics(restored, conflicts) {
        const { restoreCounter, restoreConflictCounter } = require('./metrics');
        restoreCounter.inc();
        restoreConflictCounter.inc(conflicts);
    }
}

module.exports = PokemonBackupService;
```

### 3. API 路由设计

```javascript
// backend/services/pokemon-service/src/routes/backup.js

const express = require('express');
const router = express.Router();
const PokemonBackupService = require('../../../shared/pokemonBackupService');
const authMiddleware = require('../../../shared/authMiddleware');

// 创建手动备份
router.post('/create', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.user;
        const result = await req.backupService.createBackup(userId, 'manual');
        
        res.status(201).json({
            success: true,
            backup: result
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 获取备份列表
router.get('/list', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.user;
        const { limit, offset, type } = req.query;
        
        const result = await req.backupService.getUserBackups(userId, {
            limit: parseInt(limit) || 20,
            offset: parseInt(offset) || 0,
            type
        });
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 从备份恢复
router.post('/restore/:backupId', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.user;
        const { backupId } = req.params;
        const { restoreMode, conflictResolution } = req.body;
        
        const result = await req.backupService.restoreFromBackup(
            userId, 
            parseInt(backupId),
            { restoreMode, conflictResolution }
        );
        
        res.json({
            success: true,
            restore: result
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 导出数据
router.get('/export', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.user;
        const { format = 'json' } = req.query;
        
        const data = await req.backupService.exportUserData(userId, format);
        
        const filename = `pokemon-backup-${userId}-${Date.now()}.${format}`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/csv');
        
        res.send(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 设置自动备份
router.post('/auto-backup', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.user;
        const { schedule = 'daily' } = req.body;
        
        const result = await req.backupService.setupAutoBackup(userId, schedule);
        
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 删除备份
router.delete('/:backupId', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.user;
        const { backupId } = req.params;
        
        await req.backupService.deleteBackup(userId, parseInt(backupId));
        
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 获取恢复历史
router.get('/restore-history', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.user;
        const { limit = 20, offset = 0 } = req.query;
        
        const result = await req.db.query(`
            SELECT 
                id, backup_id, restore_type, restore_status,
                restored_pokemon_count, conflicts_resolved,
                created_at, completed_at
            FROM pokemon_restore_records
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        `, [userId, parseInt(limit), parseInt(offset)]);
        
        res.json({
            history: result.rows,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
```

### 4. 定时任务 - 自动备份

```javascript
// backend/jobs/autoBackupJob.js

const cron = require('node-cron');
const PokemonBackupService = require('../shared/pokemonBackupService');

class AutoBackupJob {
    constructor(db, redis, s3Client, keyManager) {
        this.db = db;
        this.redis = redis;
        this.backupService = new PokemonBackupService(db, redis, s3Client, keyManager);
    }

    start() {
        // 每日备份 - 凌晨3点
        cron.schedule('0 3 * * *', async () => {
            await this.runDailyBackup();
        });

        // 每周备份 - 周日凌晨3点
        cron.schedule('0 3 * * 0', async () => {
            await this.runWeeklyBackup();
        });

        // 清理过期备份 - 每小时
        cron.schedule('0 * * * *', async () => {
            await this.cleanupExpiredBackups();
        });
    }

    async runDailyBackup() {
        console.log('[AutoBackup] Starting daily backup run...');
        
        // 获取所有启用每日自动备份的用户
        const keys = await this.redis.keys('autobackup:*');
        
        for (const key of keys) {
            const config = await this.redis.hgetall(key);
            
            if (config.enabled === 'true' && config.schedule === 'daily') {
                const userId = parseInt(key.split(':')[1]);
                
                try {
                    await this.backupService.createBackup(userId, 'auto_daily');
                    console.log(`[AutoBackup] Daily backup completed for user ${userId}`);
                } catch (error) {
                    console.error(`[AutoBackup] Daily backup failed for user ${userId}:`, error.message);
                }
            }
        }
    }

    async runWeeklyBackup() {
        console.log('[AutoBackup] Starting weekly backup run...');
        
        const keys = await this.redis.keys('autobackup:*');
        
        for (const key of keys) {
            const config = await this.redis.hgetall(key);
            
            if (config.enabled === 'true' && config.schedule === 'weekly') {
                const userId = parseInt(key.split(':')[1]);
                
                try {
                    await this.backupService.createBackup(userId, 'auto_weekly');
                    console.log(`[AutoBackup] Weekly backup completed for user ${userId}`);
                } catch (error) {
                    console.error(`[AutoBackup] Weekly backup failed for user ${userId}:`, error.message);
                }
            }
        }
    }

    async cleanupExpiredBackups() {
        const result = await this.db.query(`
            SELECT id, storage_path FROM pokemon_backup_metadata
            WHERE expires_at < CURRENT_TIMESTAMP AND backup_status = 'completed'
            LIMIT 100
        `);

        for (const backup of result.rows) {
            try {
                // 删除 S3 存储
                await this.s3Client.deleteObject({
                    Bucket: process.env.BACKUP_BUCKET,
                    Key: backup.storage_path
                }).promise();

                // 更新状态
                await this.db.query(`
                    UPDATE pokemon_backup_metadata
                    SET backup_status = 'expired'
                    WHERE id = $1
                `, [backup.id]);

                console.log(`[AutoBackup] Cleaned up expired backup ${backup.id}`);
            } catch (error) {
                console.error(`[AutoBackup] Failed to cleanup backup ${backup.id}:`, error.message);
            }
        }
    }
}

module.exports = AutoBackupJob;
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics.js (新增备份相关指标)

const backupCounter = new promClient.Counter({
    name: 'pokemon_backup_total',
    help: 'Total number of Pokemon backups created',
    labelNames: ['type']
});

const backupSizeHistogram = new promClient.Histogram({
    name: 'pokemon_backup_size_bytes',
    help: 'Size of Pokemon backups in bytes',
    buckets: [10000, 50000, 100000, 500000, 1000000, 5000000]
});

const backupPokemonGauge = new promClient.Gauge({
    name: 'pokemon_backup_pokemon_count',
    help: 'Number of Pokemon in each backup'
});

const restoreCounter = new promClient.Counter({
    name: 'pokemon_restore_total',
    help: 'Total number of restore operations'
});

const restoreConflictCounter = new promClient.Counter({
    name: 'pokemon_restore_conflicts_total',
    help: 'Total number of conflicts resolved during restores'
});

const backupExpiryGauge = new promClient.Gauge({
    name: 'pokemon_backup_expired_total',
    help: 'Number of expired backups cleaned up'
});
```

### 6. 前端组件

```javascript
// frontend/game-client/src/components/BackupCenter.js

import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';

export function BackupCenter() {
    const [backups, setBackups] = useState([]);
    const [creating, setCreating] = useState(false);
    const [restoring, setRestoring] = useState(null);
    const [autoBackup, setAutoBackup] = useState({ enabled: false, schedule: 'daily' });

    useEffect(() => {
        loadBackups();
        loadAutoBackupSettings();
    }, []);

    const loadBackups = async () => {
        const response = await api.get('/pokemon/backup/list');
        setBackups(response.backups);
    };

    const createBackup = async () => {
        setCreating(true);
        try {
            await api.post('/pokemon/backup/create');
            await loadBackups();
            alert('Backup created successfully!');
        } catch (error) {
            alert(`Backup failed: ${error.message}`);
        } finally {
            setCreating(false);
        }
    };

    const restoreBackup = async (backupId) => {
        if (!confirm('This will restore your Pokemon data. Continue?')) return;
        
        setRestoring(backupId);
        try {
            const result = await api.post(`/pokemon/backup/restore/${backupId}`, {
                restoreMode: 'merge',
                conflictResolution: 'keep_current'
            });
            
            alert(`Restore complete! ${result.restore.restored_count} Pokemon restored.`);
        } catch (error) {
            alert(`Restore failed: ${error.message}`);
        } finally {
            setRestoring(null);
        }
    };

    const exportData = async () => {
        const response = await api.get('/pokemon/backup/export?format=json', {
            responseType: 'blob'
        });
        
        const url = window.URL.createObjectURL(response);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pokemon-backup-${Date.now()}.json`;
        a.click();
    };

    const toggleAutoBackup = async (schedule) => {
        await api.post('/pokemon/backup/auto-backup', { schedule });
        setAutoBackup({ enabled: true, schedule });
    };

    return (
        <div className="backup-center">
            <h2>Pokemon Backup Center</h2>
            
            {/* 创建备份 */}
            <div className="backup-actions">
                <button onClick={createBackup} disabled={creating}>
                    {creating ? 'Creating...' : 'Create Backup'}
                </button>
                <button onClick={exportData}>
                    Export Data (GDPR)
                </button>
            </div>

            {/* 自动备份设置 */}
            <div className="auto-backup-settings">
                <h3>Auto Backup</h3>
                <select 
                    value={autoBackup.schedule}
                    onChange={(e) => toggleAutoBackup(e.target.value)}
                >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                </select>
            </div>

            {/* 备份列表 */}
            <div className="backup-list">
                <h3>Your Backups ({backups.length})</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Pokemon</th>
                            <th>Size</th>
                            <th>Created</th>
                            <th>Expires</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {backups.map(backup => (
                            <tr key={backup.id}>
                                <td>{backup.backup_type}</td>
                                <td>{backup.pokemon_count}</td>
                                <td>{formatBytes(backup.backup_size_bytes)}</td>
                                <td>{new Date(backup.created_at).toLocaleDateString()}</td>
                                <td>{new Date(backup.expires_at).toLocaleDateString()}</td>
                                <td>
                                    <button 
                                        onClick={() => restoreBackup(backup.id)}
                                        disabled={restoring === backup.id}
                                    >
                                        {restoring === backup.id ? 'Restoring...' : 'Restore'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
```

## 验收标准

- [ ] 用户可以手动创建精灵数据备份（最多5个）
- [ ] 备份数据使用 AES-256-GCM 加密存储
- [ ] 支持从备份恢复精灵数据（合并/替换/追加模式）
- [ ] 恢复时能处理ID冲突和重复精灵
- [ ] 用户可以导出数据为 JSON 格式（GDPR合规）
- [ ] 支持每日/每周自动备份设置
- [ ] 过期备份自动清理
- [ ] 备份列表显示备份类型、大小、精灵数量、过期时间
- [ ] 所有备份操作有 Prometheus 指标监控
- [ ] 备份和恢复操作有审计日志
- [ ] 单元测试覆盖核心逻辑（备份创建、恢复、加密解密）
- [ ] 集成测试验证端到端备份恢复流程

## 影响范围

### 新增文件
- `backend/shared/pokemonBackupService.js` - 核心备份服务
- `backend/services/pokemon-service/src/routes/backup.js` - API 路由
- `backend/jobs/autoBackupJob.js` - 定时任务
- `frontend/game-client/src/components/BackupCenter.js` - 前端组件
- `backend/tests/unit/pokemon-backup.test.js` - 单元测试

### 数据库迁移
- `database/pending/20260611_213000__add_pokemon_backup_system.sql` - 4张表

### 修改文件
- `backend/services/pokemon-service/src/index.js` - 挂载备份路由
- `backend/shared/metrics.js` - 新增备份指标
- `frontend/game-client/src/App.js` - 添加备份中心入口

## 参考

- [AWS S3 加密最佳实践](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html)
- [GDPR 数据可携带权](https://gdpr-info.eu/art-20-gdpr/)
- [PostgreSQL 备份策略](https://www.postgresql.org/docs/current/backup.html)
- [AES-GCM 加密规范](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
