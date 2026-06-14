// backend/shared/pokemonBackupService.js
'use strict';

/**
 * Pokemon Backup Service
 * 精灵数据备份与恢复服务
 * 
 * REQ-00129: 精灵数据备份与恢复系统
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { createLogger } = require('./logger');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const logger = createLogger('pokemon-backup');

// 备份类型
const BACKUP_TYPES = {
  MANUAL: 'manual',
  AUTO_DAILY: 'auto_daily',
  AUTO_WEEKLY: 'auto_weekly',
  MIGRATION: 'migration'
};

// 备份状态
const BACKUP_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired'
};

// 恢复状态
const RESTORE_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// 恢复模式
const RESTORE_MODES = {
  MERGE: 'merge',      // 合并：保留现有，添加备份中没有的
  REPLACE: 'replace',  // 替换：删除现有，恢复备份
  APPEND: 'append'     // 追加：保留现有，添加所有备份
};

// 过期时间配置（毫秒）
const EXPIRY_TIMES = {
  manual: 30 * 24 * 60 * 60 * 1000,      // 30天
  auto_daily: 7 * 24 * 60 * 60 * 1000,   // 7天
  auto_weekly: 30 * 24 * 60 * 60 * 1000, // 30天
  migration: 7 * 24 * 60 * 60 * 1000     // 7天
};

/**
 * Pokemon Backup Service
 */
class PokemonBackupService {
  constructor(db, redis, options = {}) {
    this.db = db;
    this.redis = redis;
    this.storageAdapter = options.storageAdapter || new LocalStorageAdapter();
    this.encryptionEnabled = options.encryptionEnabled !== false;
    this.encryptionKey = options.encryptionKey || process.env.BACKUP_ENCRYPTION_KEY;
    
    // 配额配置
    this.quotaConfig = {
      maxManualBackups: options.maxManualBackups || 5,
      maxStorageBytes: options.maxStorageBytes || 100 * 1024 * 1024 // 100MB
    };
  }

  /**
   * 创建备份
   * @param {number} userId - 用户ID
   * @param {string} backupType - 备份类型
   * @param {object} options - 备份选项
   */
  async createBackup(userId, backupType = BACKUP_TYPES.MANUAL, options = {}) {
    logger.info('Creating backup', { userId, backupType });
    
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 检查配额
      const quotaCheck = await this._checkBackupQuota(client, userId, backupType);
      if (!quotaCheck.allowed) {
        throw new Error(`Backup quota exceeded: ${quotaCheck.reason}`);
      }
      
      // 2. 创建备份元数据
      const metadataResult = await client.query(`
        INSERT INTO pokemon_backup_metadata 
        (user_id, backup_type, backup_status)
        VALUES ($1, $2, $3)
        RETURNING id
      `, [userId, backupType, BACKUP_STATUS.PENDING]);
      
      const backupId = metadataResult.rows[0].id;
      
      // 3. 获取用户所有精灵数据
      const pokemonData = await this._fetchUserPokemonData(client, userId, options);
      
      if (pokemonData.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('No Pokemon data to backup');
      }
      
      // 4. 构建备份数据结构
      const backupPayload = {
        version: '1.0',
        created_at: new Date().toISOString(),
        user_id: userId,
        backup_type: backupType,
        pokemon_count: pokemonData.length,
        pokemon: pokemonData
      };
      
      // 5. 序列化并压缩
      const serialized = JSON.stringify(backupPayload);
      const compressed = await gzip(Buffer.from(serialized));
      
      // 6. 加密（如果启用）
      let finalData = compressed;
      let encryptionKeyId = null;
      
      if (this.encryptionEnabled && this.encryptionKey) {
        const encrypted = this._encryptData(compressed);
        finalData = encrypted.data;
        encryptionKeyId = encrypted.keyId;
      }
      
      // 7. 计算校验和
      const checksum = crypto.createHash('sha256').update(finalData).digest('hex');
      
      // 8. 存储数据
      const storagePath = `backups/${userId}/${backupId}-${Date.now()}.bak`;
      await this.storageAdapter.store(storagePath, finalData);
      
      // 9. 存储备份内容到数据库（用于快速恢复）
      for (const pokemon of pokemonData) {
        await client.query(`
          INSERT INTO pokemon_backup_contents (backup_id, pokemon_instance_id, pokemon_data)
          VALUES ($1, $2, $3)
        `, [backupId, pokemon.instance_id, JSON.stringify(pokemon)]);
      }
      
      // 10. 计算过期时间
      const expiresAt = new Date(Date.now() + (EXPIRY_TIMES[backupType] || EXPIRY_TIMES.manual));
      
      // 11. 更新备份元数据
      await client.query(`
        UPDATE pokemon_backup_metadata
        SET backup_status = $1,
            backup_size_bytes = $2,
            pokemon_count = $3,
            storage_path = $4,
            checksum = $5,
            encryption_key_id = $6,
            expires_at = $7,
            completed_at = CURRENT_TIMESTAMP
        WHERE id = $8
      `, [
        BACKUP_STATUS.COMPLETED,
        finalData.length,
        pokemonData.length,
        storagePath,
        checksum,
        encryptionKeyId,
        expiresAt,
        backupId
      ]);
      
      // 12. 更新配额
      await this._updateBackupQuota(client, userId, finalData.length, backupType);
      
      await client.query('COMMIT');
      
      // 13. 清除缓存
      await this._clearUserBackupCache(userId);
      
      logger.info('Backup created successfully', {
        backupId,
        userId,
        pokemonCount: pokemonData.length,
        sizeBytes: finalData.length
      });
      
      return {
        backup_id: backupId,
        backup_type: backupType,
        pokemon_count: pokemonData.length,
        backup_size_bytes: finalData.length,
        expires_at: expiresAt,
        created_at: new Date().toISOString()
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      logger.error('Backup creation failed', {
        userId,
        backupType,
        error: error.message
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 从备份恢复
   * @param {number} userId - 用户ID
   * @param {number} backupId - 备份ID
   * @param {object} options - 恢复选项
   */
  async restoreFromBackup(userId, backupId, options = {}) {
    const {
      restoreMode = RESTORE_MODES.MERGE,
      conflictResolution = 'keep_current', // 'keep_current', 'use_backup', 'duplicate'
      pokemonIds = null // 如果指定，只恢复这些精灵
    } = options;
    
    logger.info('Starting restore', { userId, backupId, restoreMode });
    
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 验证备份
      const backupCheck = await client.query(`
        SELECT * FROM pokemon_backup_metadata
        WHERE id = $1 AND user_id = $2 AND backup_status = $3
      `, [backupId, userId, BACKUP_STATUS.COMPLETED]);
      
      if (backupCheck.rows.length === 0) {
        throw new Error('Backup not found or not accessible');
      }
      
      const backup = backupCheck.rows[0];
      
      // 2. 检查是否过期
      if (backup.expires_at && new Date(backup.expires_at) < new Date()) {
        throw new Error('Backup has expired');
      }
      
      // 3. 创建恢复记录
      const restoreRecord = await client.query(`
        INSERT INTO pokemon_restore_records
        (user_id, backup_id, restore_type, restore_status, restore_mode)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [userId, backupId, pokemonIds ? 'partial' : 'full', RESTORE_STATUS.PROCESSING, restoreMode]);
      
      const restoreId = restoreRecord.rows[0].id;
      
      // 4. 获取备份数据
      let pokemonData;
      
      // 优先从数据库读取（更快）
      const dbContents = await client.query(`
        SELECT pokemon_data FROM pokemon_backup_contents
        WHERE backup_id = $1
        ${pokemonIds ? 'AND (pokemon_data->>\'instance_id\')::INTEGER = ANY($2)' : ''}
      `, [backupId, pokemonIds]);
      
      if (dbContents.rows.length > 0) {
        pokemonData = dbContents.rows.map(r => r.pokemon_data);
      } else {
        // 从存储读取
        pokemonData = await this._loadBackupFromStorage(backup);
      }
      
      let restoredCount = 0;
      let skippedCount = 0;
      let conflictsResolved = 0;
      const restoreLog = [];
      
      // 5. 处理恢复模式
      if (restoreMode === RESTORE_MODES.REPLACE) {
        // 删除当前所有精灵
        const deleteResult = await client.query(`
          DELETE FROM pokemon_instances WHERE user_id = $1
        `, [userId]);
        restoreLog.push(`Deleted ${deleteResult.rowCount} existing Pokemon (replace mode)`);
      }
      
      // 6. 获取现有精灵ID列表（用于冲突检测）
      const existingPokemon = await client.query(`
        SELECT id FROM pokemon_instances WHERE user_id = $1
      `, [userId]);
      const existingIds = new Set(existingPokemon.rows.map(r => r.id));
      
      // 7. 恢复每个精灵
      for (const pokemon of pokemonData) {
        const result = await this._restoreSinglePokemon(
          client,
          userId,
          pokemon,
          restoreMode,
          conflictResolution,
          existingIds
        );
        
        if (result.restored) {
          restoredCount++;
        } else {
          skippedCount++;
        }
        
        if (result.conflict) {
          conflictsResolved++;
          restoreLog.push(`Conflict for Pokemon ${pokemon.instance_id || pokemon.id}: ${result.resolution}`);
        }
      }
      
      // 8. 更新恢复记录
      await client.query(`
        UPDATE pokemon_restore_records
        SET restore_status = $1,
            restored_pokemon_count = $2,
            skipped_pokemon_count = $3,
            conflicts_resolved = $4,
            restore_log = $5,
            completed_at = CURRENT_TIMESTAMP
        WHERE id = $6
      `, [RESTORE_STATUS.COMPLETED, restoredCount, skippedCount, conflictsResolved, restoreLog.join('\n'), restoreId]);
      
      // 9. 更新配额中的恢复时间
      await client.query(`
        UPDATE user_backup_quotas
        SET last_restore_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
      `, [userId]);
      
      await client.query('COMMIT');
      
      // 10. 清除缓存
      await this._clearUserPokemonCache(userId);
      
      logger.info('Restore completed', {
        restoreId,
        userId,
        backupId,
        restoredCount,
        skippedCount,
        conflictsResolved
      });
      
      return {
        restore_id: restoreId,
        backup_id: backupId,
        restored_count: restoredCount,
        skipped_count: skippedCount,
        conflicts_resolved: conflictsResolved,
        status: RESTORE_STATUS.COMPLETED
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      logger.error('Restore failed', {
        userId,
        backupId,
        error: error.message
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取用户备份列表
   */
  async getUserBackups(userId, options = {}) {
    const { limit = 20, offset = 0, type, status } = options;
    
    let query = `
      SELECT 
        id, backup_type, backup_status, backup_size_bytes,
        pokemon_count, expires_at, created_at, completed_at
      FROM pokemon_backup_metadata
      WHERE user_id = $1
    `;
    
    const params = [userId];
    let paramIndex = 2;
    
    if (type) {
      query += ` AND backup_type = $${paramIndex++}`;
      params.push(type);
    }
    
    if (status) {
      query += ` AND backup_status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);
    
    const result = await this.db.query(query, params);
    
    // 获取总数
    const countResult = await this.db.query(`
      SELECT COUNT(*) as total FROM pokemon_backup_metadata
      WHERE user_id = $1 AND backup_status != $2
    `, [userId, BACKUP_STATUS.EXPIRED]);
    
    return {
      backups: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    };
  }

  /**
   * 删除备份
   */
  async deleteBackup(userId, backupId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 验证所有权
      const check = await client.query(`
        SELECT storage_path FROM pokemon_backup_metadata
        WHERE id = $1 AND user_id = $2
      `, [backupId, userId]);
      
      if (check.rows.length === 0) {
        throw new Error('Backup not found');
      }
      
      const backup = check.rows[0];
      
      // 删除存储文件
      if (backup.storage_path) {
        await this.storageAdapter.delete(backup.storage_path);
      }
      
      // 删除数据库记录（级联删除 pokemon_backup_contents）
      await client.query(`
        DELETE FROM pokemon_backup_metadata WHERE id = $1
      `, [backupId]);
      
      // 更新配额
      await client.query(`
        UPDATE user_backup_quotas
        SET current_manual_backups = GREATEST(0, current_manual_backups - 1)
        WHERE user_id = $1
      `, [userId]);
      
      await client.query('COMMIT');
      
      logger.info('Backup deleted', { userId, backupId });
      
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 导出用户数据（GDPR）
   */
  async exportUserData(userId, format = 'json') {
    // 创建一次性迁移备份
    const backup = await this.createBackup(userId, BACKUP_TYPES.MIGRATION);
    
    // 获取备份数据
    const backupData = await this.db.query(`
      SELECT 
        bm.id, bm.backup_type, bm.pokemon_count, bm.created_at,
        json_agg(bc.pokemon_data) as pokemon_data
      FROM pokemon_backup_metadata bm
      JOIN pokemon_backup_contents bc ON bm.id = bc.backup_id
      WHERE bm.id = $1
      GROUP BY bm.id
    `, [backup.backup_id]);
    
    if (backupData.rows.length === 0) {
      throw new Error('Failed to export user data');
    }
    
    const exportData = backupData.rows[0];
    
    if (format === 'json') {
      return JSON.stringify(exportData, null, 2);
    } else if (format === 'csv') {
      return this._convertToCSV(exportData.pokemon_data);
    }
    
    return exportData;
  }

  /**
   * 设置自动备份
   */
  async setupAutoBackup(userId, schedule = 'daily') {
    await this.db.query(`
      INSERT INTO user_auto_backup_config (user_id, enabled, schedule)
      VALUES ($1, true, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET enabled = true, schedule = $2, updated_at = CURRENT_TIMESTAMP
    `, [userId, schedule]);
    
    // 设置下次运行时间
    const nextRun = this._calculateNextRunTime(schedule);
    await this.db.query(`
      UPDATE user_auto_backup_config SET next_run_at = $1 WHERE user_id = $2
    `, [nextRun, userId]);
    
    return {
      enabled: true,
      schedule,
      next_run_at: nextRun
    };
  }

  /**
   * 获取恢复历史
   */
  async getRestoreHistory(userId, options = {}) {
    const { limit = 20, offset = 0 } = options;
    
    const result = await this.db.query(`
      SELECT 
        r.id, r.backup_id, r.restore_type, r.restore_status, r.restore_mode,
        r.restored_pokemon_count, r.skipped_pokemon_count, r.conflicts_resolved,
        r.created_at, r.completed_at
      FROM pokemon_restore_records r
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);
    
    return result.rows;
  }

  /**
   * 清理过期备份
   */
  async cleanupExpiredBackups(batchSize = 100) {
    const result = await this.db.query(`
      SELECT id, storage_path FROM pokemon_backup_metadata
      WHERE expires_at < CURRENT_TIMESTAMP 
        AND backup_status = $1
      LIMIT $2
    `, [BACKUP_STATUS.COMPLETED, batchSize]);
    
    let cleanedCount = 0;
    
    for (const backup of result.rows) {
      try {
        // 删除存储文件
        if (backup.storage_path) {
          await this.storageAdapter.delete(backup.storage_path);
        }
        
        // 更新状态
        await this.db.query(`
          UPDATE pokemon_backup_metadata
          SET backup_status = $1
          WHERE id = $2
        `, [BACKUP_STATUS.EXPIRED, backup.id]);
        
        cleanedCount++;
      } catch (error) {
        logger.error('Failed to cleanup backup', {
          backupId: backup.id,
          error: error.message
        });
      }
    }
    
    logger.info('Cleaned up expired backups', { count: cleanedCount });
    return { cleaned_count: cleanedCount };
  }

  // ============ 私有方法 ============

  /**
   * 获取用户精灵数据
   */
  async _fetchUserPokemonData(client, userId, options) {
    const result = await client.query(`
      SELECT 
        pi.id as instance_id,
        pi.species_id,
        pi.nickname,
        pi.level,
        pi.experience,
        pi.current_hp,
        pi.stats,
        pi.ivs,
        pi.ability_id,
        pi.nature,
        pi.held_item_id,
        pi.friendship,
        pi.origin_info,
        pi.caught_at,
        pi.created_at,
        ps.name_zh as species_name_zh,
        ps.name_en as species_name_en,
        ps.base_stats,
        ps.types,
        (
          SELECT json_agg(json_build_object(
            'move_id', pm.move_id,
            'current_pp', pm.current_pp,
            'max_pp', pm.max_pp
          ))
          FROM pokemon_moves pm
          WHERE pm.pokemon_instance_id = pi.id
        ) as moves
      FROM pokemon_instances pi
      LEFT JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.user_id = $1
      ORDER BY pi.id
    `, [userId]);
    
    return result.rows;
  }

  /**
   * 恢复单个精灵
   */
  async _restoreSinglePokemon(client, userId, pokemon, restoreMode, conflictResolution, existingIds) {
    const instanceId = pokemon.instance_id || pokemon.id;
    
    // 检查冲突
    const hasConflict = existingIds.has(instanceId);
    
    if (hasConflict) {
      if (conflictResolution === 'keep_current') {
        return { restored: false, conflict: true, resolution: 'kept current' };
      } else if (conflictResolution === 'duplicate') {
        // 创建新记录，不使用原ID
        const insertResult = await client.query(`
          INSERT INTO pokemon_instances (
            user_id, species_id, nickname, level, experience,
            current_hp, stats, ivs, ability_id, nature,
            held_item_id, friendship, origin_info
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
          ) RETURNING id
        `, [
          userId,
          pokemon.species_id,
          pokemon.nickname,
          pokemon.level,
          pokemon.experience,
          pokemon.current_hp,
          pokemon.stats,
          pokemon.ivs,
          pokemon.ability_id,
          pokemon.nature,
          pokemon.held_item_id,
          pokemon.friendship,
          { ...pokemon.origin_info, restored_from_backup: true }
        ]);
        
        // 恢复技能
        if (pokemon.moves && pokemon.moves.length > 0) {
          for (const move of pokemon.moves) {
            await client.query(`
              INSERT INTO pokemon_moves (pokemon_instance_id, move_id, current_pp, max_pp)
              VALUES ($1, $2, $3, $4)
            `, [insertResult.rows[0].id, move.move_id, move.current_pp, move.max_pp]);
          }
        }
        
        return { restored: true, conflict: true, resolution: 'created duplicate' };
      } else if (conflictResolution === 'use_backup') {
        // 更新现有记录
        await client.query(`
          UPDATE pokemon_instances SET
            nickname = $2, level = $3, experience = $4,
            current_hp = $5, stats = $6, ivs = $7,
            ability_id = $8, nature = $9, held_item_id = $10,
            friendship = $11
          WHERE id = $1
        `, [
          instanceId,
          pokemon.nickname,
          pokemon.level,
          pokemon.experience,
          pokemon.current_hp,
          pokemon.stats,
          pokemon.ivs,
          pokemon.ability_id,
          pokemon.nature,
          pokemon.held_item_id,
          pokemon.friendship
        ]);
        
        return { restored: true, conflict: true, resolution: 'updated with backup' };
      }
    }
    
    // 无冲突，直接插入
    try {
      await client.query(`
        INSERT INTO pokemon_instances (
          id, user_id, species_id, nickname, level, experience,
          current_hp, stats, ivs, ability_id, nature,
          held_item_id, friendship, origin_info
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
      `, [
        instanceId,
        userId,
        pokemon.species_id,
        pokemon.nickname,
        pokemon.level,
        pokemon.experience,
        pokemon.current_hp,
        pokemon.stats,
        pokemon.ivs,
        pokemon.ability_id,
        pokemon.nature,
        pokemon.held_item_id,
        pokemon.friendship,
        pokemon.origin_info
      ]);
      
      existingIds.add(instanceId);
      return { restored: true, conflict: false };
    } catch (error) {
      // ID冲突，尝试不带ID插入
      if (error.code === '23505') {
        const insertResult = await client.query(`
          INSERT INTO pokemon_instances (
            user_id, species_id, nickname, level, experience,
            current_hp, stats, ivs, ability_id, nature,
            held_item_id, friendship, origin_info
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
          ) RETURNING id
        `, [
          userId,
          pokemon.species_id,
          pokemon.nickname,
          pokemon.level,
          pokemon.experience,
          pokemon.current_hp,
          pokemon.stats,
          pokemon.ivs,
          pokemon.ability_id,
          pokemon.nature,
          pokemon.held_item_id,
          pokemon.friendship,
          { ...pokemon.origin_info, restored_from_backup: true }
        ]);
        
        existingIds.add(insertResult.rows[0].id);
        return { restored: true, conflict: true, resolution: 'assigned new id' };
      }
      
      throw error;
    }
  }

  /**
   * 检查备份配额
   */
  async _checkBackupQuota(client, userId, backupType) {
    if (backupType !== BACKUP_TYPES.MANUAL) {
      return { allowed: true };
    }
    
    const quota = await client.query(`
      SELECT * FROM user_backup_quotas WHERE user_id = $1
    `, [userId]);
    
    if (quota.rows.length === 0) {
      return { allowed: true };
    }
    
    const q = quota.rows[0];
    
    if (q.current_manual_backups >= q.max_manual_backups) {
      return {
        allowed: false,
        reason: `Maximum manual backups (${q.max_manual_backups}) reached. Please delete an old backup first.`
      };
    }
    
    return { allowed: true };
  }

  /**
   * 更新备份配额
   */
  async _updateBackupQuota(client, userId, sizeBytes, backupType) {
    if (backupType === BACKUP_TYPES.MANUAL) {
      await client.query(`
        INSERT INTO user_backup_quotas (user_id, current_manual_backups, current_storage_bytes, last_backup_at)
        VALUES ($1, 1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id)
        DO UPDATE SET
          current_manual_backups = user_backup_quotas.current_manual_backups + 1,
          current_storage_bytes = user_backup_quotas.current_storage_bytes + $2,
          last_backup_at = CURRENT_TIMESTAMP
      `, [userId, sizeBytes]);
    } else {
      await client.query(`
        INSERT INTO user_backup_quotas (user_id, current_storage_bytes, last_backup_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id)
        DO UPDATE SET
          current_storage_bytes = user_backup_quotas.current_storage_bytes + $2,
          last_backup_at = CURRENT_TIMESTAMP
      `, [userId, sizeBytes]);
    }
  }

  /**
   * 加密数据
   */
  _encryptData(data) {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return {
      data: Buffer.concat([iv, authTag, encrypted]),
      keyId: 'default'
    };
  }

  /**
   * 解密数据
   */
  _decryptData(encryptedData) {
    const iv = encryptedData.slice(0, 16);
    const authTag = encryptedData.slice(16, 32);
    const encrypted = encryptedData.slice(32);
    
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * 从存储加载备份数据
   */
  async _loadBackupFromStorage(backup) {
    const storedData = await this.storageAdapter.load(backup.storage_path);
    
    // 验证校验和
    const checksum = crypto.createHash('sha256').update(storedData).digest('hex');
    if (checksum !== backup.checksum) {
      throw new Error('Backup checksum mismatch - data may be corrupted');
    }
    
    // 解密
    let data = storedData;
    if (backup.encryption_key_id && this.encryptionKey) {
      data = this._decryptData(storedData);
    }
    
    // 解压
    const decompressed = await gunzip(data);
    const backupPayload = JSON.parse(decompressed.toString());
    
    return backupPayload.pokemon;
  }

  /**
   * 计算下次运行时间
   */
  _calculateNextRunTime(schedule) {
    const now = new Date();
    if (schedule === 'daily') {
      // 明天凌晨3点
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(3, 0, 0, 0);
      return next;
    } else if (schedule === 'weekly') {
      // 下周日凌晨3点
      const next = new Date(now);
      next.setDate(next.getDate() + (7 - next.getDay()));
      next.setHours(3, 0, 0, 0);
      return next;
    }
    return now;
  }

  /**
   * 转换为CSV
   */
  _convertToCSV(pokemonData) {
    if (!pokemonData || pokemonData.length === 0) {
      return '';
    }
    
    const headers = ['instance_id', 'species_id', 'nickname', 'level', 'experience', 'nature', 'friendship'];
    const rows = pokemonData.map(p => headers.map(h => p[h] || '').join(','));
    
    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * 清除用户备份缓存
   */
  async _clearUserBackupCache(userId) {
    if (this.redis) {
      await this.redis.del(`backup:list:${userId}`);
      await this.redis.del(`backup:quota:${userId}`);
    }
  }

  /**
   * 清除用户精灵缓存
   */
  async _clearUserPokemonCache(userId) {
    if (this.redis) {
      await this.redis.del(`pokemon:user:${userId}`);
      await this.redis.del(`pokemon:list:${userId}`);
      await this.redis.del(`pokemon:count:${userId}`);
    }
  }
}

/**
 * 本地存储适配器
 */
class LocalStorageAdapter {
  constructor(basePath = './backups') {
    this.basePath = basePath;
  }

  async store(path, data) {
    const fs = require('fs').promises;
    const fullPath = require('path').join(this.basePath, path);
    
    await fs.mkdir(require('path').dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
  }

  async load(path) {
    const fs = require('fs').promises;
    const fullPath = require('path').join(this.basePath, path);
    return fs.readFile(fullPath);
  }

  async delete(path) {
    const fs = require('fs').promises;
    const fullPath = require('path').join(this.basePath, path);
    try {
      await fs.unlink(fullPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// 单例实例
let backupServiceInstance = null;

/**
 * 获取备份服务实例
 */
function getBackupService(db, redis, options) {
  if (!backupServiceInstance) {
    backupServiceInstance = new PokemonBackupService(db, redis, options);
  }
  return backupServiceInstance;
}

module.exports = {
  PokemonBackupService,
  LocalStorageAdapter,
  getBackupService,
  BACKUP_TYPES,
  BACKUP_STATUS,
  RESTORE_STATUS,
  RESTORE_MODES
};
