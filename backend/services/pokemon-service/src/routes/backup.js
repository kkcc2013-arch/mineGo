// backend/services/pokemon-service/src/routes/backup.js
'use strict';

/**
 * Pokemon Backup Routes
 * REQ-00129: 精灵数据备份与恢复系统
 */

const express = require('express');
const router = express.Router();
const { query } = require('../../../../shared/db');
const { requireAuth, successResp } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const { 
  getBackupService, 
  BACKUP_TYPES, 
  RESTORE_MODES 
} = require('../../../../shared/pokemonBackupService');

const logger = createLogger('backup-routes');

/**
 * GET /api/pokemon/backup/list
 * 获取用户备份列表
 */
router.get('/list', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit, offset, type, status } = req.query;
    
    const backupService = getBackupService(
      require('../../../../shared/db').getPool(),
      req.app.locals.redis
    );
    
    const result = await backupService.getUserBackups(userId, {
      limit: parseInt(limit) || 20,
      offset: parseInt(offset) || 0,
      type,
      status
    });
    
    res.json(successResp(result));
  } catch (error) {
    logger.error('Failed to list backups', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/pokemon/backup/create
 * 创建手动备份
 */
router.post('/create', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const backupService = getBackupService(
      require('../../../../shared/db').getPool(),
      req.app.locals.redis
    );
    
    const result = await backupService.createBackup(userId, BACKUP_TYPES.MANUAL);
    
    logger.info('Manual backup created', { 
      userId, 
      backupId: result.backup_id,
      pokemonCount: result.pokemon_count
    });
    
    res.status(201).json(successResp({
      backup: result
    }));
  } catch (error) {
    logger.error('Failed to create backup', { 
      userId: req.user?.id,
      error: error.message 
    });
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/pokemon/backup/restore/:backupId
 * 从备份恢复精灵数据
 */
router.post('/restore/:backupId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const backupId = parseInt(req.params.backupId);
    const { restoreMode, conflictResolution, pokemonIds } = req.body;
    
    const backupService = getBackupService(
      require('../../../../shared/db').getPool(),
      req.app.locals.redis
    );
    
    const result = await backupService.restoreFromBackup(userId, backupId, {
      restoreMode: restoreMode || RESTORE_MODES.MERGE,
      conflictResolution: conflictResolution || 'keep_current',
      pokemonIds: pokemonIds || null
    });
    
    logger.info('Restore completed', {
      userId,
      backupId,
      restoredCount: result.restored_count
    });
    
    res.json(successResp({
      restore: result
    }));
  } catch (error) {
    logger.error('Failed to restore backup', {
      userId: req.user?.id,
      backupId: req.params.backupId,
      error: error.message
    });
    res.status(400).json({ error: error.message });
  }
});

/**
 * DELETE /api/pokemon/backup/:backupId
 * 删除备份
 */
router.delete('/:backupId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const backupId = parseInt(req.params.backupId);
    
    const backupService = getBackupService(
      require('../../../../shared/db').getPool(),
      req.app.locals.redis
    );
    
    await backupService.deleteBackup(userId, backupId);
    
    logger.info('Backup deleted', { userId, backupId });
    
    res.json(successResp({ deleted: true }));
  } catch (error) {
    logger.error('Failed to delete backup', {
      userId: req.user?.id,
      backupId: req.params.backupId,
      error: error.message
    });
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/pokemon/backup/export
 * 导出用户数据（GDPR）
 */
router.get('/export', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const format = req.query.format || 'json';
    
    const backupService = getBackupService(
      require('../../../../shared/db').getPool(),
      req.app.locals.redis
    );
    
    const data = await backupService.exportUserData(userId, format);
    
    const filename = `pokemon-backup-${userId}-${Date.now()}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/csv');
    
    logger.info('User data exported', { userId, format });
    
    res.send(data);
  } catch (error) {
    logger.error('Failed to export data', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/pokemon/backup/auto-backup
 * 设置自动备份
 */
router.post('/auto-backup', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { schedule = 'daily' } = req.body;
    
    if (!['daily', 'weekly'].includes(schedule)) {
      return res.status(400).json({ error: 'Invalid schedule. Use "daily" or "weekly".' });
    }
    
    const backupService = getBackupService(
      require('../../../../shared/db').getPool(),
      req.app.locals.redis
    );
    
    const result = await backupService.setupAutoBackup(userId, schedule);
    
    logger.info('Auto backup configured', { userId, schedule });
    
    res.json(successResp(result));
  } catch (error) {
    logger.error('Failed to setup auto backup', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/pokemon/backup/auto-backup
 * 获取自动备份配置
 */
router.get('/auto-backup', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await query(`
      SELECT enabled, schedule, last_run_at, next_run_at
      FROM user_auto_backup_config
      WHERE user_id = $1
    `, [userId]);
    
    if (result.rows.length === 0) {
      return res.json(successResp({
        enabled: false,
        schedule: null,
        last_run_at: null,
        next_run_at: null
      }));
    }
    
    res.json(successResp(result.rows[0]));
  } catch (error) {
    logger.error('Failed to get auto backup config', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/pokemon/backup/auto-backup
 * 禁用自动备份
 */
router.delete('/auto-backup', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    await query(`
      UPDATE user_auto_backup_config
      SET enabled = false
      WHERE user_id = $1
    `, [userId]);
    
    logger.info('Auto backup disabled', { userId });
    
    res.json(successResp({ enabled: false }));
  } catch (error) {
    logger.error('Failed to disable auto backup', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/pokemon/backup/restore-history
 * 获取恢复历史
 */
router.get('/restore-history', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit, offset } = req.query;
    
    const backupService = getBackupService(
      require('../../../../shared/db').getPool(),
      req.app.locals.redis
    );
    
    const history = await backupService.getRestoreHistory(userId, {
      limit: parseInt(limit) || 20,
      offset: parseInt(offset) || 0
    });
    
    res.json(successResp({
      history,
      limit: parseInt(limit) || 20,
      offset: parseInt(offset) || 0
    }));
  } catch (error) {
    logger.error('Failed to get restore history', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/pokemon/backup/quota
 * 获取用户备份配额信息
 */
router.get('/quota', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await query(`
      SELECT 
        max_manual_backups,
        current_manual_backups,
        max_storage_bytes,
        current_storage_bytes,
        last_backup_at,
        last_restore_at
      FROM user_backup_quotas
      WHERE user_id = $1
    `, [userId]);
    
    if (result.rows.length === 0) {
      // 返回默认配额
      return res.json(successResp({
        max_manual_backups: 5,
        current_manual_backups: 0,
        max_storage_bytes: 104857600,
        current_storage_bytes: 0,
        last_backup_at: null,
        last_restore_at: null,
        can_create_backup: true
      }));
    }
    
    const quota = result.rows[0];
    quota.can_create_backup = quota.current_manual_backups < quota.max_manual_backups;
    
    res.json(successResp(quota));
  } catch (error) {
    logger.error('Failed to get backup quota', {
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/pokemon/backup/:backupId
 * 获取备份详情
 */
router.get('/:backupId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const backupId = parseInt(req.params.backupId);
    
    const result = await query(`
      SELECT 
        id, backup_type, backup_status, backup_size_bytes,
        pokemon_count, storage_path, expires_at,
        created_at, completed_at
      FROM pokemon_backup_metadata
      WHERE id = $1 AND user_id = $2
    `, [backupId, userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    
    res.json(successResp(result.rows[0]));
  } catch (error) {
    logger.error('Failed to get backup details', {
      userId: req.user?.id,
      backupId: req.params.backupId,
      error: error.message
    });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
