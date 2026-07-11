/**
 * DLQ Admin Controller - 死信队列管理 API
 * REQ-00519: 后端任务队列可靠性增强与死信处理系统
 * 
 * 功能：
 * - 查询 DLQ 任务列表
 * - 查询 DLQ 统计信息
 * - 重试 DLQ 任务
 * - 清空 DLQ
 * - 查询告警历史
 * 
 * @module backend/shared/dlqAdminController
 * @version 1.0.0
 */

'use strict';

const { TaskQueueManager } = require('./TaskQueueManager');
const logger = require('./logger');

/**
 * DLQ Admin Controller
 */
class DLQAdminController {
  constructor(options = {}) {
    this.taskQueueManager = new TaskQueueManager(options);
    this.db = options.db || require('./db');
  }

  /**
   * GET /api/admin/dlq/tasks
   * 获取 DLQ 任务列表
   */
  async getTasks(req, res) {
    try {
      const {
        limit = 50,
        offset = 0,
        type = null,
        status = null,
        sortBy = 'moved_to_dlq_at',
        sortOrder = 'desc'
      } = req.query;

      const tasks = await this.taskQueueManager.getDLQTasksFromDatabase({
        limit: parseInt(limit),
        offset: parseInt(offset),
        type,
        status,
        sortBy,
        sortOrder
      });

      res.json({
        success: true,
        data: tasks,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: tasks.length
        }
      });

    } catch (error) {
      logger.error('Failed to get DLQ tasks', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Failed to get DLQ tasks',
        message: error.message
      });
    }
  }

  /**
   * GET /api/admin/dlq/tasks/:taskId
   * 获取单个 DLQ 任务详情
   */
  async getTask(req, res) {
    try {
      const { taskId } = req.params;

      const task = await this.taskQueueManager.getDLQTaskFromDatabase(taskId);

      if (!task) {
        return res.status(404).json({
          success: false,
          error: 'Task not found',
          taskId
        });
      }

      // 获取执行历史
      const history = await this.getTaskExecutionHistory(taskId);

      res.json({
        success: true,
        data: {
          ...task,
          executionHistory: history
        }
      });

    } catch (error) {
      logger.error('Failed to get DLQ task', {
        taskId: req.params.taskId,
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: 'Failed to get DLQ task',
        message: error.message
      });
    }
  }

  /**
   * GET /api/admin/dlq/stats
   * 获取 DLQ 统计信息
   */
  async getStats(req, res) {
    try {
      const stats = await this.taskQueueManager.getDLQStats();

      // 获取任务执行指标
      const metrics = this.taskQueueManager.getMetrics();

      res.json({
        success: true,
        data: {
          ...stats,
          metrics
        }
      });

    } catch (error) {
      logger.error('Failed to get DLQ stats', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Failed to get DLQ stats',
        message: error.message
      });
    }
  }

  /**
   * POST /api/admin/dlq/tasks/:taskId/retry
   * 重试 DLQ 任务
   */
  async retryTask(req, res) {
    try {
      const { taskId } = req.params;
      const { taskFn } = req.body;

      // 从 DLQ 获取任务
      const task = await this.taskQueueManager.getDLQTaskFromDatabase(taskId);

      if (!task) {
        return res.status(404).json({
          success: false,
          error: 'Task not found in DLQ',
          taskId
        });
      }

      // 记录重试操作
      await this.logDLQOperation({
        operation: 'retry',
        taskId,
        operatedBy: req.user?.id,
        operatedAt: new Date()
      });

      // 执行重试
      const result = await this.taskQueueManager.retryFromDLQ(taskId, taskFn);

      res.json({
        success: result.success,
        data: result,
        message: result.success ? 'Task retry initiated' : 'Task retry failed'
      });

    } catch (error) {
      logger.error('Failed to retry DLQ task', {
        taskId: req.params.taskId,
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: 'Failed to retry task',
        message: error.message
      });
    }
  }

  /**
   * POST /api/admin/dlq/tasks/:taskId/resolve
   * 标记任务为已解决
   */
  async resolveTask(req, res) {
    try {
      const { taskId } = req.params;
      const { note } = req.body;

      const result = await this.db.query(`
        UPDATE dead_letter_queue
        SET 
          status = 'resolved',
          resolved_at = CURRENT_TIMESTAMP,
          resolved_by = $2,
          resolution_note = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE task_id = $1
      `, [taskId, req.user?.id, note]);

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: 'Task not found',
          taskId
        });
      }

      // 记录解决操作
      await this.logDLQOperation({
        operation: 'resolve',
        taskId,
        operatedBy: req.user?.id,
        operatedAt: new Date(),
        note
      });

      res.json({
        success: true,
        message: 'Task marked as resolved',
        taskId
      });

    } catch (error) {
      logger.error('Failed to resolve DLQ task', {
        taskId: req.params.taskId,
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: 'Failed to resolve task',
        message: error.message
      });
    }
  }

  /**
   * POST /api/admin/dlq/clear
   * 清空 DLQ
   */
  async clearDLQ(req, res) {
    try {
      const { type = null, olderThan = null } = req.body;

      const result = await this.taskQueueManager.clearDLQ({ type, olderThan });

      // 记录清空操作
      await this.logDLQOperation({
        operation: 'clear',
        operatedBy: req.user?.id,
        operatedAt: new Date(),
        details: { type, olderThan, clearedCount: result.clearedCount }
      });

      res.json({
        success: true,
        data: result,
        message: `Cleared ${result.clearedCount} tasks from DLQ`
      });

    } catch (error) {
      logger.error('Failed to clear DLQ', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Failed to clear DLQ',
        message: error.message
      });
    }
  }

  /**
   * GET /api/admin/dlq/alerts
   * 获取告警历史
   */
  async getAlerts(req, res) {
    try {
      const { limit = 50, offset = 0, severity = null } = req.query;

      let query = `
        SELECT * FROM dlq_alerts
        WHERE 1=1
      `;
      const params = [];

      if (severity) {
        query += ` AND severity = $${params.length + 1}`;
        params.push(severity);
      }

      query += `
        ORDER BY triggered_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(parseInt(limit), parseInt(offset));

      const result = await this.db.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: result.rows.length
        }
      });

    } catch (error) {
      logger.error('Failed to get DLQ alerts', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Failed to get alerts',
        message: error.message
      });
    }
  }

  /**
   * GET /api/admin/dlq/config
   * 获取任务重试配置
   */
  async getConfig(req, res) {
    try {
      const result = await this.db.query(`
        SELECT * FROM task_retry_config ORDER BY task_type
      `);

      res.json({
        success: true,
        data: result.rows
      });

    } catch (error) {
      logger.error('Failed to get DLQ config', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Failed to get config',
        message: error.message
      });
    }
  }

  /**
   * PUT /api/admin/dlq/config/:taskType
   * 更新任务重试配置
   */
  async updateConfig(req, res) {
    try {
      const { taskType } = req.params;
      const {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        backoffFactor,
        jitterEnabled,
        jitterRange,
        alertThreshold
      } = req.body;

      const result = await this.db.query(`
        UPDATE task_retry_config
        SET
          max_retries = COALESCE($2, max_retries),
          base_delay_ms = COALESCE($3, base_delay_ms),
          max_delay_ms = COALESCE($4, max_delay_ms),
          backoff_factor = COALESCE($5, backoff_factor),
          jitter_enabled = COALESCE($6, jitter_enabled),
          jitter_range = COALESCE($7, jitter_range),
          alert_threshold = COALESCE($8, alert_threshold),
          updated_at = CURRENT_TIMESTAMP
        WHERE task_type = $1
        RETURNING *
      `, [
        taskType,
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        backoffFactor,
        jitterEnabled,
        jitterRange,
        alertThreshold
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Config not found',
          taskType
        });
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Config updated successfully'
      });

    } catch (error) {
      logger.error('Failed to update DLQ config', {
        taskType: req.params.taskType,
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: 'Failed to update config',
        message: error.message
      });
    }
  }

  // ===== 辅助方法 =====

  /**
   * 获取任务执行历史
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Array>} - 历史记录
   */
  async getTaskExecutionHistory(taskId) {
    try {
      const result = await this.db.query(`
        SELECT * FROM task_execution_history
        WHERE task_id = $1
        ORDER BY attempt_number ASC
      `, [taskId]);

      return result.rows;

    } catch (error) {
      logger.error('Failed to get task execution history', {
        taskId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * 记录 DLQ 操作
   * @param {Object} operation - 操作信息
   */
  async logDLQOperation(operation) {
    try {
      await this.db.query(`
        INSERT INTO dlq_operation_log (
          operation, task_id, operated_by, operated_at, details
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        operation.operation,
        operation.taskId || null,
        operation.operatedBy || null,
        operation.operatedAt || new Date(),
        JSON.stringify(operation.details || {})
      ]);

    } catch (error) {
      logger.error('Failed to log DLQ operation', {
        operation,
        error: error.message
      });
    }
  }
}

/**
 * 创建 DLQ Admin Router
 * @param {Object} router - Express Router
 * @param {Object} options - 配置选项
 * @returns {Object} - Router
 */
function createDLQAdminRouter(router, options = {}) {
  const controller = new DLQAdminController(options);

  // 查询接口
  router.get('/api/admin/dlq/tasks', controller.getTasks.bind(controller));
  router.get('/api/admin/dlq/tasks/:taskId', controller.getTask.bind(controller));
  router.get('/api/admin/dlq/stats', controller.getStats.bind(controller));
  router.get('/api/admin/dlq/alerts', controller.getAlerts.bind(controller));
  router.get('/api/admin/dlq/config', controller.getConfig.bind(controller));

  // 操作接口
  router.post('/api/admin/dlq/tasks/:taskId/retry', controller.retryTask.bind(controller));
  router.post('/api/admin/dlq/tasks/:taskId/resolve', controller.resolveTask.bind(controller));
  router.post('/api/admin/dlq/clear', controller.clearDLQ.bind(controller));
  router.put('/api/admin/dlq/config/:taskType', controller.updateConfig.bind(controller));

  return router;
}

module.exports = {
  DLQAdminController,
  createDLQAdminRouter
};