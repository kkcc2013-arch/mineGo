/**
 * 死信队列管理 API
 * REQ-00519: 提供 admin 界面查询死信任务及手动重试
 */

const express = require('express');
const router = express.Router();
const { getRedisClient } = require('../../shared/redis');
const { createTaskQueue, DeadLetterQueue } = require('../../shared/taskQueue');
const { createLogger } = require('../../shared/logger');
const authMiddleware = require('../middleware/auth');
const adminOnlyMiddleware = require('../middleware/adminOnly');

const logger = createLogger('dlq-api');

// 认证和管理员权限中间件
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

/**
 * 获取 Redis 客户端和 DLQ 实例
 */
function getDLQInstance() {
    const redis = getRedisClient();
    return new DeadLetterQueue(redis);
}

/**
 * GET /api/admin/dlq/stats
 * 获取所有 DLQ 统计信息
 */
router.get('/stats', async (req, res) => {
    try {
        const dlq = getDLQInstance();
        const stats = await dlq.getDLQStats();

        res.json({
            success: true,
            data: stats,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to get DLQ stats', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to get DLQ stats',
            message: error.message
        });
    }
});

/**
 * GET /api/admin/dlq/:taskType
 * 获取指定任务类型的 DLQ 列表
 */
router.get('/:taskType', async (req, res) => {
    try {
        const { taskType } = req.params;
        const { limit = 100, offset = 0 } = req.query;

        const dlq = getDLQInstance();
        const result = await dlq.getDLQItems(taskType, { limit, offset });

        res.json({
            success: true,
            data: result,
            taskType,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to get DLQ items', { 
            taskType: req.params.taskType,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Failed to get DLQ items',
            message: error.message
        });
    }
});

/**
 * GET /api/admin/dlq/:taskType/:taskId
 * 获取单个 DLQ 任务详情
 */
router.get('/:taskType/:taskId', async (req, res) => {
    try {
        const { taskType, taskId } = req.params;
        const dlq = getDLQInstance();
        const result = await dlq.getDLQItems(taskType, { limit: 1000 });

        const task = result.items.find(item => item.id === taskId);

        if (!task) {
            return res.status(404).json({
                success: false,
                error: 'Task not found in DLQ',
                taskId
            });
        }

        res.json({
            success: true,
            data: task,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to get DLQ task detail', { 
            taskType: req.params.taskType,
            taskId: req.params.taskId,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Failed to get DLQ task detail',
            message: error.message
        });
    }
});

/**
 * POST /api/admin/dlq/:taskType/:taskId/retry
 * 重试 DLQ 中的任务
 */
router.post('/:taskType/:taskId/retry', async (req, res) => {
    try {
        const { taskType, taskId } = req.params;
        const redis = getRedisClient();
        const dlq = new DeadLetterQueue(redis);
        const taskQueue = createTaskQueue();

        const result = await dlq.reprocessTask(taskType, taskId, null);

        logger.info('DLQ task retry initiated', {
            taskType,
            taskId,
            userId: req.user?.id
        });

        res.json({
            success: true,
            message: 'Task has been requeued for processing',
            taskId,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to retry DLQ task', { 
            taskType: req.params.taskType,
            taskId: req.params.taskId,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Failed to retry DLQ task',
            message: error.message
        });
    }
});

/**
 * DELETE /api/admin/dlq/:taskType/:taskId
 * 删除 DLQ 中的任务
 */
router.delete('/:taskType/:taskId', async (req, res) => {
    try {
        const { taskType, taskId } = req.params;
        const dlq = getDLQInstance();
        const removed = await dlq.removeFromDLQ(taskType, taskId);

        if (!removed) {
            return res.status(404).json({
                success: false,
                error: 'Task not found in DLQ',
                taskId
            });
        }

        logger.info('DLQ task removed', {
            taskType,
            taskId,
            userId: req.user?.id
        });

        res.json({
            success: true,
            message: 'Task removed from DLQ',
            taskId,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to remove DLQ task', { 
            taskType: req.params.taskType,
            taskId: req.params.taskId,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Failed to remove DLQ task',
            message: error.message
        });
    }
});

/**
 * POST /api/admin/dlq/:taskType/bulk-retry
 * 批量重试 DLQ 中的任务
 */
router.post('/:taskType/bulk-retry', async (req, res) => {
    try {
        const { taskType } = req.params;
        const { limit = 10 } = req.body;

        const redis = getRedisClient();
        const dlq = new DeadLetterQueue(redis);
        const taskQueue = createTaskQueue();
        
        const result = await dlq.getDLQItems(taskType, { limit });
        const retried = [];
        const failed = [];

        for (const item of result.items) {
            try {
                await dlq.reprocessTask(taskType, item.id, null);
                retried.push(item.id);
            } catch (error) {
                failed.push({ id: item.id, error: error.message });
            }
        }

        logger.info('DLQ bulk retry completed', {
            taskType,
            retried: retried.length,
            failed: failed.length,
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                retried,
                failed,
                totalProcessed: result.items.length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to bulk retry DLQ tasks', { 
            taskType: req.params.taskType,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Failed to bulk retry DLQ tasks',
            message: error.message
        });
    }
});

/**
 * DELETE /api/admin/dlq/:taskType
 * 清空指定任务类型的 DLQ
 */
router.delete('/:taskType', async (req, res) => {
    try {
        const { taskType } = req.params;
        const dlq = getDLQInstance();
        const deletedCount = await dlq.clearDLQ(taskType);

        logger.warn('DLQ cleared', {
            taskType,
            deletedCount,
            userId: req.user?.id
        });

        res.json({
            success: true,
            message: `DLQ cleared for ${taskType}`,
            deletedCount,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to clear DLQ', { 
            taskType: req.params.taskType,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Failed to clear DLQ',
            message: error.message
        });
    }
});

/**
 * GET /api/admin/dlq/:taskType/:taskId/error
 * 获取任务的详细错误信息
 */
router.get('/:taskType/:taskId/error', async (req, res) => {
    try {
        const { taskType, taskId } = req.params;
        const dlq = getDLQInstance();
        const result = await dlq.getDLQItems(taskType, { limit: 1000 });

        const task = result.items.find(item => item.id === taskId);

        if (!task) {
            return res.status(404).json({
                success: false,
                error: 'Task not found in DLQ',
                taskId
            });
        }

        res.json({
            success: true,
            data: {
                taskId: task.id,
                taskType: task.taskType,
                error: task.error,
                retryCount: task.retryCount,
                failedAt: task.failedAt,
                taskData: task.taskData
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to get DLQ task error', { 
            taskType: req.params.taskType,
            taskId: req.params.taskId,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Failed to get DLQ task error',
            message: error.message
        });
    }
});

module.exports = router;
