/**
 * 任务队列可靠性增强与死信处理系统
 * REQ-00519: 实现指数退避重试、死信队列、监控告警
 */

const { getRedisClient } = require('../redis');
const { createLogger } = require('../logger');
const EventEmitter = require('events');

const logger = createLogger('task-queue');

/**
 * 指数退避策略配置
 */
const DEFAULT_RETRY_CONFIG = {
    maxRetries: 5,
    initialDelayMs: 1000,      // 初始延迟 1 秒
    maxDelayMs: 300000,        // 最大延迟 5 分钟
    backoffMultiplier: 2,      // 退避倍数
    jitterMs: 500              // 抖动范围（防止惊群效应）
};

/**
 * 任务类型配置
 */
const TASK_TYPE_CONFIGS = {
    // 推送通知任务
    'push_notification': { maxRetries: 3, initialDelayMs: 2000, maxDelayMs: 60000 },
    // 数据导出任务
    'data_export': { maxRetries: 5, initialDelayMs: 5000, maxDelayMs: 600000 },
    // 数据清理任务
    'data_cleanup': { maxRetries: 3, initialDelayMs: 10000, maxDelayMs: 300000 },
    // 备份任务
    'backup': { maxRetries: 2, initialDelayMs: 60000, maxDelayMs: 1800000 },
    // 邮件发送
    'email_send': { maxRetries: 5, initialDelayMs: 3000, maxDelayMs: 120000 },
    // 默认任务
    'default': DEFAULT_RETRY_CONFIG
};

/**
 * 计算重试延迟（指数退避 + 抖动）
 */
function calculateRetryDelay(retryCount, config) {
    const { initialDelayMs, maxDelayMs, backoffMultiplier, jitterMs } = config;
    
    // 指数退避: delay = initialDelay * (backoffMultiplier ^ retryCount)
    let delay = initialDelayMs * Math.pow(backoffMultiplier, retryCount);
    
    // 限制最大延迟
    delay = Math.min(delay, maxDelayMs);
    
    // 添加随机抖动（防止惊群效应）
    const jitter = Math.floor(Math.random() * jitterMs);
    delay = delay + jitter;
    
    return delay;
}

/**
 * 死信队列管理器
 */
class DeadLetterQueue {
    constructor(redis, options = {}) {
        this.redis = redis;
        this.dlqPrefix = options.dlqPrefix || 'dlq:';
        this.maxDLQSize = options.maxDLQSize || 10000;
        this.retentionDays = options.retentionDays || 30;
    }

    /**
     * 获取指定任务类型的 DLQ 键名
     */
    getDLQKey(taskType) {
        return `${this.dlqPrefix}${taskType}`;
    }

    /**
     * 将失败任务加入死信队列
     */
    async addToDLQ(taskType, taskData, error, retryCount) {
        const dlqKey = this.getDLQKey(taskType);
        const dlqItem = {
            id: taskData.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            taskType,
            taskData,
            error: {
                message: error.message,
                stack: error.stack,
                code: error.code
            },
            retryCount,
            failedAt: new Date().toISOString(),
            originalCreatedAt: taskData.createdAt || new Date().toISOString()
        };

        // 检查 DLQ 大小限制
        const currentSize = await this.redis.llen(dlqKey);
        if (currentSize >= this.maxDLQSize) {
            logger.warn('DLQ size limit reached, removing oldest item', {
                taskType,
                currentSize,
                maxSize: this.maxDLQSize
            });
            await this.redis.rpop(dlqKey);
        }

        // 添加到 DLQ 列表头部
        await this.redis.lpush(dlqKey, JSON.stringify(dlqItem));
        
        // 设置过期时间（自动清理）
        await this.redis.expire(dlqKey, this.retentionDays * 86400);

        logger.warn('Task added to DLQ', {
            taskType,
            taskId: dlqItem.id,
            retryCount,
            errorMessage: error.message
        });

        return dlqItem.id;
    }

    /**
     * 从 DLQ 获取任务列表
     */
    async getDLQItems(taskType, options = {}) {
        const dlqKey = this.getDLQKey(taskType);
        const limit = options.limit || 100;
        const offset = options.offset || 0;

        const items = await this.redis.lrange(dlqKey, offset, offset + limit - 1);
        const total = await this.redis.llen(dlqKey);

        return {
            items: items.map(item => JSON.parse(item)),
            total,
            limit,
            offset
        };
    }

    /**
     * 获取所有任务类型的 DLQ 统计
     */
    async getDLQStats() {
        const stats = {};
        const pattern = `${this.dlqPrefix}*`;
        const keys = await this.redis.keys(pattern);

        for (const key of keys) {
            const taskType = key.replace(this.dlqPrefix, '');
            const size = await this.redis.llen(key);
            
            if (size > 0) {
                stats[taskType] = {
                    size,
                    oldestItem: await this.getOldestItemAge(taskType)
                };
            }
        }

        return stats;
    }

    /**
     * 获取 DLQ 中最旧项目的年龄（秒）
     */
    async getOldestItemAge(taskType) {
        const dlqKey = this.getDLQKey(taskType);
        const items = await this.redis.lrange(dlqKey, -1, -1);
        
        if (items.length === 0) return 0;
        
        const item = JSON.parse(items[0]);
        const oldestTime = new Date(item.failedAt).getTime();
        return Math.floor((Date.now() - oldestTime) / 1000);
    }

    /**
     * 从 DLQ 移除特定任务
     */
    async removeFromDLQ(taskType, taskId) {
        const dlqKey = this.getDLQKey(taskType);
        const items = await this.redis.lrange(dlqKey, 0, -1);

        for (const item of items) {
            const parsed = JSON.parse(item);
            if (parsed.id === taskId) {
                await this.redis.lrem(dlqKey, 1, item);
                logger.info('Task removed from DLQ', { taskType, taskId });
                return true;
            }
        }

        return false;
    }

    /**
     * 重新处理 DLQ 中的任务
     */
    async reprocessTask(taskType, taskId, processor) {
        const dlqKey = this.getDLQKey(taskType);
        const items = await this.redis.lrange(dlqKey, 0, -1);

        for (const item of items) {
            const parsed = JSON.parse(item);
            if (parsed.id === taskId) {
                try {
                    logger.info('Attempting to reprocess DLQ task', {
                        taskType,
                        taskId,
                        originalRetryCount: parsed.retryCount
                    });

                    // 重置重试计数
                    const taskQueue = new TaskQueue(this.redis);
                    await taskQueue.enqueue(parsed.taskType, parsed.taskData, {
                        isReprocess: true,
                        originalDLQId: taskId
                    });

                    // 从 DLQ 移除
                    await this.redis.lrem(dlqKey, 1, item);

                    logger.info('DLQ task reprocessed successfully', { taskType, taskId });
                    return { success: true };
                } catch (error) {
                    logger.error('Failed to reprocess DLQ task', {
                        taskType,
                        taskId,
                        error: error.message
                    });
                    throw error;
                }
            }
        }

        throw new Error(`Task ${taskId} not found in DLQ`);
    }

    /**
     * 清理 DLQ
     */
    async clearDLQ(taskType) {
        const dlqKey = this.getDLQKey(taskType);
        const size = await this.redis.llen(dlqKey);
        await this.redis.del(dlqKey);
        
        logger.info('DLQ cleared', { taskType, deletedItems: size });
        return size;
    }
}

/**
 * 任务队列核心类
 */
class TaskQueue extends EventEmitter {
    constructor(redis, options = {}) {
        super();
        this.redis = redis;
        this.queuePrefix = options.queuePrefix || 'task_queue:';
        this.scheduledQueuePrefix = options.scheduledQueuePrefix || 'scheduled_tasks:';
        this.dlq = new DeadLetterQueue(redis, options.dlqOptions);
        this.processors = new Map();
        this.metrics = {
            processed: 0,
            failed: 0,
            retried: 0,
            dlqAdded: 0
        };
    }

    /**
     * 获取任务队列键名
     */
    getQueueKey(taskType) {
        return `${this.queuePrefix}${taskType}`;
    }

    /**
     * 获取定时任务队列键名
     */
    getScheduledQueueKey(taskType) {
        return `${this.scheduledQueuePrefix}${taskType}`;
    }

    /**
     * 获取任务配置
     */
    getTaskConfig(taskType) {
        return TASK_TYPE_CONFIGS[taskType] || TASK_TYPE_CONFIGS['default'];
    }

    /**
     * 入队任务
     */
    async enqueue(taskType, taskData, options = {}) {
        const task = {
            id: options.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            taskType,
            taskData,
            createdAt: new Date().toISOString(),
            retryCount: 0,
            maxRetries: options.maxRetries || this.getTaskConfig(taskType).maxRetries,
            priority: options.priority || 0,
            scheduledAt: options.scheduledAt || null,
            metadata: options.metadata || {}
        };

        // 如果有调度时间，加入定时队列
        if (task.scheduledAt) {
            const score = new Date(task.scheduledAt).getTime();
            await this.redis.zadd(this.getScheduledQueueKey(taskType), score, JSON.stringify(task));
            this.emit('task:scheduled', task);
        } else {
            // 立即执行，加入队列
            const queueKey = this.getQueueKey(taskType);
            await this.redis.lpush(queueKey, JSON.stringify(task));
            this.emit('task:enqueued', task);
        }

        logger.info('Task enqueued', {
            taskType,
            taskId: task.id,
            scheduledAt: task.scheduledAt
        });

        return task.id;
    }

    /**
     * 出队任务
     */
    async dequeue(taskType, timeout = 5) {
        const queueKey = this.getQueueKey(taskType);
        
        // BRPOP 阻塞式获取任务
        const result = await this.redis.brpop(queueKey, timeout);
        
        if (!result) return null;
        
        const task = JSON.parse(result[1]);
        return task;
    }

    /**
     * 注册任务处理器
     */
    registerProcessor(taskType, processor) {
        this.processors.set(taskType, processor);
        logger.info('Task processor registered', { taskType });
    }

    /**
     * 处理单个任务
     */
    async processTask(task) {
        const { taskType, taskData, retryCount, maxRetries } = task;
        const processor = this.processors.get(taskType);

        if (!processor) {
            logger.error('No processor registered for task type', { taskType });
            throw new Error(`No processor registered for task type: ${taskType}`);
        }

        try {
            // 执行任务
            const result = await processor(taskData, task);
            
            this.metrics.processed++;
            this.emit('task:completed', { task, result });

            logger.info('Task processed successfully', {
                taskType,
                taskId: task.id,
                retryCount
            });

            return { success: true, result };
        } catch (error) {
            logger.error('Task processing failed', {
                taskType,
                taskId: task.id,
                retryCount,
                error: error.message
            });

            // 判断是否需要重试
            if (retryCount < maxRetries) {
                return await this.handleRetry(task, error);
            } else {
                // 达到最大重试次数，加入死信队列
                return await this.handleDLQ(task, error);
            }
        }
    }

    /**
     * 处理重试
     */
    async handleRetry(task, error) {
        const { taskType, retryCount } = task;
        const config = this.getTaskConfig(taskType);
        
        // 计算重试延迟
        const delay = calculateRetryDelay(retryCount, config);
        const scheduledAt = new Date(Date.now() + delay);

        // 更新任务状态
        task.retryCount = retryCount + 1;
        task.lastError = {
            message: error.message,
            stack: error.stack,
            at: new Date().toISOString()
        };
        task.scheduledAt = scheduledAt.toISOString();

        // 加入定时重试队列
        const score = scheduledAt.getTime();
        await this.redis.zadd(this.getScheduledQueueKey(taskType), score, JSON.stringify(task));

        this.metrics.retried++;
        this.emit('task:retry', { task, error, scheduledAt });

        logger.warn('Task scheduled for retry', {
            taskType,
            taskId: task.id,
            retryCount: task.retryCount,
            scheduledAt: scheduledAt.toISOString(),
            delayMs: delay
        });

        return { success: false, retry: true, scheduledAt: scheduledAt.toISOString() };
    }

    /**
     * 处理死信队列
     */
    async handleDLQ(task, error) {
        const { taskType, taskData, retryCount } = task;
        
        // 加入死信队列
        const dlqId = await this.dlq.addToDLQ(taskType, taskData, error, retryCount);

        this.metrics.dlqAdded++;
        this.emit('task:dlq', { task, error, dlqId });

        logger.error('Task moved to DLQ after max retries', {
            taskType,
            taskId: task.id,
            retryCount,
            dlqId
        });

        return { success: false, dlq: true, dlqId };
    }

    /**
     * 启动任务处理循环
     */
    async startProcessing(taskType, options = {}) {
        const concurrency = options.concurrency || 1;
        const pollInterval = options.pollInterval || 1000;

        logger.info('Starting task processing', { taskType, concurrency });

        const workers = [];
        for (let i = 0; i < concurrency; i++) {
            workers.push(this.runWorker(taskType, pollInterval));
        }

        // 启动定时任务检查器
        this.startScheduledTaskChecker(taskType);

        return Promise.all(workers);
    }

    /**
     * 运行工作进程
     */
    async runWorker(taskType, pollInterval) {
        while (true) {
            try {
                const task = await this.dequeue(taskType, 5);
                if (task) {
                    await this.processTask(task);
                } else {
                    // 队列为空，等待一段时间
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
            } catch (error) {
                logger.error('Worker error', { taskType, error: error.message });
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    /**
     * 启动定时任务检查器（处理重试任务）
     */
    startScheduledTaskChecker(taskType) {
        const checkInterval = 5000; // 每 5 秒检查一次

        setInterval(async () => {
            try {
                const scheduledKey = this.getScheduledQueueKey(taskType);
                const now = Date.now();

                // 获取所有到期的任务
                const tasks = await this.redis.zrangebyscore(scheduledKey, 0, now);

                for (const taskStr of tasks) {
                    const task = JSON.parse(taskStr);

                    // 从定时队列移除
                    await this.redis.zrem(scheduledKey, taskStr);

                    // 加入执行队列
                    const queueKey = this.getQueueKey(taskType);
                    await this.redis.lpush(queueKey, JSON.stringify(task));

                    logger.info('Scheduled task ready for processing', {
                        taskType,
                        taskId: task.id,
                        retryCount: task.retryCount
                    });
                }
            } catch (error) {
                logger.error('Scheduled task checker error', {
                    taskType,
                    error: error.message
                });
            }
        }, checkInterval);
    }

    /**
     * 获取队列状态
     */
    async getQueueStats(taskType) {
        const queueKey = this.getQueueKey(taskType);
        const scheduledKey = this.getScheduledQueueKey(taskType);

        const queueSize = await this.redis.llen(queueKey);
        const scheduledSize = await this.redis.zcard(scheduledKey);
        const dlqStats = await this.dlq.getDLQStats();

        return {
            taskType,
            pending: queueSize,
            scheduled: scheduledSize,
            dlq: dlqStats[taskType] || { size: 0 },
            metrics: { ...this.metrics }
        };
    }

    /**
     * 获取所有队列统计
     */
    async getAllQueueStats() {
        const stats = {};
        const pattern = `${this.queuePrefix}*`;
        const keys = await this.redis.keys(pattern);

        for (const key of keys) {
            const taskType = key.replace(this.queuePrefix, '');
            stats[taskType] = await this.getQueueStats(taskType);
        }

        return stats;
    }

    /**
     * 获取 DLQ 实例
     */
    getDLQ() {
        return this.dlq;
    }

    /**
     * 获取指标
     */
    getMetrics() {
        return { ...this.metrics };
    }
}

/**
 * 任务队列监控器
 */
class TaskQueueMonitor {
    constructor(taskQueue, options = {}) {
        this.taskQueue = taskQueue;
        this.redis = taskQueue.redis;
        this.alertThresholds = options.alertThresholds || {
            dlqSize: 100,          // DLQ 超过 100 条告警
            dlqAge: 3600,          // DLQ 中最旧任务超过 1 小时告警
            queueBacklog: 1000,    // 队列积压超过 1000 告警
            errorRate: 0.5         // 错误率超过 50% 告警
        };
        this.prometheus = options.prometheus || null;
        
        this.setupMetrics();
    }

    /**
     * 设置 Prometheus 指标
     */
    setupMetrics() {
        if (!this.prometheus) return;

        const { Counter, Gauge, Histogram } = require('prom-client');

        this.metrics = {
            tasksProcessed: new Counter({
                name: 'task_queue_processed_total',
                help: 'Total number of tasks processed',
                labelNames: ['task_type', 'status']
            }),
            queueSize: new Gauge({
                name: 'task_queue_size',
                help: 'Current queue size',
                labelNames: ['task_type', 'queue_type']
            }),
            dlqSize: new Gauge({
                name: 'task_queue_dlq_size',
                help: 'Dead letter queue size',
                labelNames: ['task_type']
            }),
            retryDelay: new Histogram({
                name: 'task_queue_retry_delay_seconds',
                help: 'Task retry delay in seconds',
                labelNames: ['task_type'],
                buckets: [1, 5, 10, 30, 60, 300, 600, 1800, 3600]
            })
        };
    }

    /**
     * 记录任务处理指标
     */
    recordTaskMetric(taskType, status) {
        if (!this.metrics) return;
        this.metrics.tasksProcessed.inc({ task_type: taskType, status });
    }

    /**
     * 更新队列大小指标
     */
    async updateQueueMetrics(taskType) {
        if (!this.metrics) return;

        const stats = await this.taskQueue.getQueueStats(taskType);

        this.metrics.queueSize.set({ task_type: taskType, queue_type: 'pending' }, stats.pending);
        this.metrics.queueSize.set({ task_type: taskType, queue_type: 'scheduled' }, stats.scheduled);
        this.metrics.dlqSize.set({ task_type: taskType }, stats.dlq.size);
    }

    /**
     * 检查告警条件
     */
    async checkAlerts(taskType) {
        const stats = await this.taskQueue.getQueueStats(taskType);
        const alerts = [];

        // 检查 DLQ 大小
        if (stats.dlq.size >= this.alertThresholds.dlqSize) {
            alerts.push({
                type: 'dlq_size_exceeded',
                severity: 'warning',
                taskType,
                current: stats.dlq.size,
                threshold: this.alertThresholds.dlqSize,
                message: `DLQ size for ${taskType} exceeded threshold: ${stats.dlq.size} >= ${this.alertThresholds.dlqSize}`
            });
        }

        // 检查 DLQ 年龄
        if (stats.dlq.oldestItemAge >= this.alertThresholds.dlqAge) {
            alerts.push({
                type: 'dlq_age_exceeded',
                severity: 'warning',
                taskType,
                currentAge: stats.dlq.oldestItemAge,
                threshold: this.alertThresholds.dlqAge,
                message: `Oldest item in DLQ for ${taskType} exceeded age threshold: ${stats.dlq.oldestItemAge}s >= ${this.alertThresholds.dlqAge}s`
            });
        }

        // 检查队列积压
        if (stats.pending >= this.alertThresholds.queueBacklog) {
            alerts.push({
                type: 'queue_backlog_exceeded',
                severity: 'warning',
                taskType,
                current: stats.pending,
                threshold: this.alertThresholds.queueBacklog,
                message: `Queue backlog for ${taskType} exceeded threshold: ${stats.pending} >= ${this.alertThresholds.queueBacklog}`
            });
        }

        // 发送告警
        if (alerts.length > 0) {
            for (const alert of alerts) {
                logger.warn('Task queue alert', alert);
                this.taskQueue.emit('alert', alert);
            }
        }

        return alerts;
    }

    /**
     * 启动监控
     */
    startMonitoring(taskTypes, intervalMs = 60000) {
        setInterval(async () => {
            for (const taskType of taskTypes) {
                try {
                    await this.updateQueueMetrics(taskType);
                    await this.checkAlerts(taskType);
                } catch (error) {
                    logger.error('Monitoring error', { taskType, error: error.message });
                }
            }
        }, intervalMs);

        logger.info('Task queue monitoring started', { taskTypes, intervalMs });
    }
}

/**
 * 创建任务队列实例
 */
function createTaskQueue(options = {}) {
    const redis = getRedisClient();
    return new TaskQueue(redis, options);
}

/**
 * 初始化预设任务处理器
 */
function initializeDefaultProcessors(taskQueue) {
    // 推送通知处理器
    taskQueue.registerProcessor('push_notification', async (data) => {
        const { getPushNotificationService } = require('../pushNotificationService');
        const pushService = await getPushNotificationService();
        return await pushService.sendPush(data);
    });

    // 数据导出处理器
    taskQueue.registerProcessor('data_export', async (data) => {
        const { exportUserData } = require('../../jobs/dataExportJob');
        return await exportUserData(data);
    });

    // 数据清理处理器
    taskQueue.registerProcessor('data_cleanup', async (data) => {
        const { cleanupOldData } = require('../../jobs/cleanupJobs');
        return await cleanupOldData(data);
    });

    logger.info('Default task processors initialized');
}

module.exports = {
    TaskQueue,
    DeadLetterQueue,
    TaskQueueMonitor,
    createTaskQueue,
    initializeDefaultProcessors,
    calculateRetryDelay,
    DEFAULT_RETRY_CONFIG,
    TASK_TYPE_CONFIGS
};
