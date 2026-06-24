# REQ-00314: 服务实例优雅停机与连接排空系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00314 |
| 标题 | 服务实例优雅停机与连接排空系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、infrastructure/k8s |
| 创建时间 | 2026-06-24 08:00 UTC |

## 需求描述

实现服务实例优雅停机与连接排空系统，确保在部署更新、扩缩容或故障恢复时，服务实例能够平滑关闭，不丢失正在处理的请求，不影响用户体验。

### 核心功能

1. **优雅停机流程**
   - 接收 SIGTERM 信号处理
   - 停止接收新请求（从负载均衡器摘除）
   - 等待现有请求完成（带超时）
   - 关闭数据库连接池
   - 关闭 Redis 连接
   - 清理定时器和后台任务
   - 最后关闭 HTTP 服务器

2. **连接排空机制**
   - WebSocket 连接平滑迁移
   - 长连接请求追踪与等待
   - 客户端重连引导
   - 连接健康检查

3. **健康检查集成**
   - Kubernetes readinessProbe 集成
   - 停机时自动标记为不健康
   - 防止新流量进入

4. **监控与告警**
   - 停机事件日志记录
   - 强制关闭告警（超时后仍有请求）
   - 停机耗时统计

## 技术方案

### 1. 优雅停机管理器

```javascript
// backend/shared/gracefulShutdown.js
const Logger = require('./logger');
const EventEmitter = require('events');

class GracefulShutdown extends EventEmitter {
    constructor(options = {}) {
        super();
        this.timeout = options.timeout || 30000; // 30 seconds default
        this.signals = options.signals || ['SIGTERM', 'SIGINT'];
        this.isShuttingDown = false;
        this.activeConnections = new Set();
        this.activeRequests = new Map();
        this.server = null;
        this.connections = [];
        this.shutdownPromise = null;
        
        this.setupSignalHandlers();
    }

    setupSignalHandlers() {
        for (const signal of this.signals) {
            process.on(signal, async () => {
                Logger.info(`Received ${signal}, starting graceful shutdown...`);
                await this.shutdown(signal);
            });
        }
    }

    init(server, options = {}) {
        this.server = server;
        this.dbConnections = options.dbConnections || [];
        this.redisClients = options.redisClients || [];
        this.backgroundJobs = options.backgroundJobs || [];
        this.webSocketServers = options.webSocketServers || [];
        this.healthChecker = options.healthChecker;
        
        // 追踪活跃连接
        server.on('connection', (socket) => {
            this.activeConnections.add(socket);
            socket.on('close', () => {
                this.activeConnections.delete(socket);
            });
        });

        // 追踪活跃请求
        server.on('request', (req, res) => {
            const requestId = req.headers['x-request-id'] || 
                `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            this.activeRequests.set(requestId, {
                url: req.url,
                method: req.method,
                startTime: Date.now()
            });

            res.on('finish', () => {
                this.activeRequests.delete(requestId);
            });
        });
    }

    async shutdown(reason = 'UNKNOWN') {
        if (this.isShuttingDown) {
            Logger.warn('Shutdown already in progress');
            return this.shutdownPromise;
        }

        this.isShuttingDown = true;
        const startTime = Date.now();

        // 标记为不健康
        if (this.healthChecker) {
            this.healthChecker.markUnhealthy('shutting_down');
        }

        this.emit('shutdown:start', { reason, timestamp: startTime });

        this.shutdownPromise = this._executeShutdown(reason, startTime);
        return this.shutdownPromise;
    }

    async _executeShutdown(reason, startTime) {
        try {
            // Phase 1: 停止接收新请求
            Logger.info('Phase 1: Stopping new connections...');
            if (this.healthChecker) {
                await this.healthChecker.markUnhealthy('draining');
            }
            await this._stopAcceptingNewConnections();

            // Phase 2: 等待现有请求完成
            Logger.info('Phase 2: Waiting for active requests to complete...');
            await this._waitForActiveRequests();

            // Phase 3: 关闭 WebSocket 连接
            Logger.info('Phase 3: Closing WebSocket connections...');
            await this._closeWebSockets();

            // Phase 4: 停止后台任务
            Logger.info('Phase 4: Stopping background jobs...');
            await this._stopBackgroundJobs();

            // Phase 5: 关闭数据库连接
            Logger.info('Phase 5: Closing database connections...');
            await this._closeDatabaseConnections();

            // Phase 6: 关闭 Redis 连接
            Logger.info('Phase 6: Closing Redis connections...');
            await this._closeRedisConnections();

            // Phase 7: 关闭 HTTP 服务器
            Logger.info('Phase 7: Closing HTTP server...');
            await this._closeHttpServer();

            const duration = Date.now() - startTime;
            Logger.info(`Graceful shutdown completed in ${duration}ms`);
            
            this.emit('shutdown:complete', { 
                reason, 
                duration,
                timestamp: Date.now()
            });

            process.exit(0);

        } catch (error) {
            Logger.error('Error during shutdown:', error);
            this.emit('shutdown:error', { error, reason });
            
            // 强制退出
            setTimeout(() => {
                Logger.error('Forcing shutdown after timeout');
                process.exit(1);
            }, 5000);
        }
    }

    async _stopAcceptingNewConnections() {
        // 从负载均衡器摘除
        // Kubernetes readiness probe 会自动处理
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    async _waitForActiveRequests() {
        const timeout = this.timeout * 0.5; // Use half of timeout for requests
        
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const activeCount = this.activeRequests.size;
                
                if (activeCount === 0) {
                    clearInterval(checkInterval);
                    Logger.info('All requests completed');
                    resolve();
                    return;
                }

                // 记录仍在处理的请求
                const pending = Array.from(this.activeRequests.entries()).map(([id, req]) => ({
                    id,
                    url: req.url,
                    duration: Date.now() - req.startTime
                }));

                Logger.warn(`Waiting for ${activeCount} requests to complete`, { pending });
            }, 1000);

            // 超时后强制继续
            setTimeout(() => {
                clearInterval(checkInterval);
                const remaining = this.activeRequests.size;
                if (remaining > 0) {
                    Logger.warn(`Timeout reached, ${remaining} requests still pending`);
                    this.emit('shutdown:timeout', { 
                        pendingRequests: remaining 
                    });
                }
                resolve();
            }, timeout);
        });
    }

    async _closeWebSockets() {
        if (!this.webSocketServers || this.webSocketServers.length === 0) {
            return;
        }

        const closePromises = this.webSocketServers.map((wss, index) => {
            return new Promise((resolve) => {
                // 通知客户端即将关闭
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) { // WebSocket.OPEN
                        client.send(JSON.stringify({
                            type: 'server_shutdown',
                            message: 'Server is shutting down, please reconnect',
                            reconnectDelay: 1000
                        }));
                    }
                });

                // 给客户端时间处理
                setTimeout(() => {
                    wss.close((err) => {
                        if (err) {
                            Logger.error(`Error closing WebSocket server ${index}:`, err);
                        } else {
                            Logger.info(`WebSocket server ${index} closed`);
                        }
                        resolve();
                    });
                }, 2000);
            });
        });

        await Promise.all(closePromises);
    }

    async _stopBackgroundJobs() {
        if (!this.backgroundJobs || this.backgroundJobs.length === 0) {
            return;
        }

        const stopPromises = this.backgroundJobs.map(async (job, index) => {
            try {
                if (typeof job.stop === 'function') {
                    await job.stop();
                } else if (typeof job.cancel === 'function') {
                    await job.cancel();
                }
                Logger.info(`Background job ${index} stopped`);
            } catch (error) {
                Logger.error(`Error stopping background job ${index}:`, error);
            }
        });

        await Promise.all(stopPromises);
    }

    async _closeDatabaseConnections() {
        if (!this.dbConnections || this.dbConnections.length === 0) {
            return;
        }

        const closePromises = this.dbConnections.map(async (pool, index) => {
            try {
                await pool.destroy();
                Logger.info(`Database connection ${index} closed`);
            } catch (error) {
                Logger.error(`Error closing database connection ${index}:`, error);
            }
        });

        await Promise.all(closePromises);
    }

    async _closeRedisConnections() {
        if (!this.redisClients || this.redisClients.length === 0) {
            return;
        }

        const closePromises = this.redisClients.map(async (client, index) => {
            try {
                if (typeof client.quit === 'function') {
                    await client.quit();
                } else if (typeof client.disconnect === 'function') {
                    await client.disconnect();
                }
                Logger.info(`Redis connection ${index} closed`);
            } catch (error) {
                Logger.error(`Error closing Redis connection ${index}:`, error);
            }
        });

        await Promise.all(closePromises);
    }

    async _closeHttpServer() {
        if (!this.server) {
            return;
        }

        return new Promise((resolve) => {
            // 关闭所有活跃连接
            for (const socket of this.activeConnections) {
                socket.destroy();
            }
            this.activeConnections.clear();

            this.server.close((err) => {
                if (err) {
                    Logger.error('Error closing HTTP server:', err);
                } else {
                    Logger.info('HTTP server closed');
                }
                resolve();
            });

            // 超时强制关闭
            setTimeout(() => {
                if (this.server.listening) {
                    Logger.warn('Force closing HTTP server after timeout');
                    this.server.closeAllConnections();
                    resolve();
                }
            }, 5000);
        });
    }

    // 中间件：在停机时拒绝新请求
    middleware() {
        return (req, res, next) => {
            if (this.isShuttingDown) {
                res.setHeader('Connection', 'close');
                res.setHeader('Retry-After', '10');
                return res.status(503).json({
                    error: 'Server is shutting down',
                    code: 'SERVICE_UNAVAILABLE',
                    retryAfter: 10
                });
            }
            
            // 追踪请求
            const requestId = req.headers['x-request-id'] || 
                `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            req.requestId = requestId;
            
            next();
        };
    }

    // 获取当前状态
    getStatus() {
        return {
            isShuttingDown: this.isShuttingDown,
            activeConnections: this.activeConnections.size,
            activeRequests: this.activeRequests.size,
            pendingRequests: Array.from(this.activeRequests.entries()).map(([id, req]) => ({
                id,
                url: req.url,
                method: req.method,
                duration: Date.now() - req.startTime
            }))
        };
    }
}

module.exports = GracefulShutdown;
```

### 2. Kubernetes 集成

```yaml
# infrastructure/k8s/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pokemon-service
spec:
  replicas: 3
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
      - name: pokemon-service
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 10"]
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 10
          failureThreshold: 3
```

### 3. 健康检查端点

```javascript
// backend/shared/healthChecker.js
const express = require('express');
const Logger = require('./logger');

class HealthChecker {
    constructor() {
        this.isHealthy = true;
        this.isReady = true;
        this.reason = null;
        this.checks = new Map();
    }

    markUnhealthy(reason) {
        this.isHealthy = false;
        this.isReady = false;
        this.reason = reason;
        Logger.warn(`Health check marked unhealthy: ${reason}`);
    }

    markHealthy() {
        this.isHealthy = true;
        this.isReady = true;
        this.reason = null;
        Logger.info('Health check marked healthy');
    }

    markNotReady(reason) {
        this.isReady = false;
        this.reason = reason;
        Logger.warn(`Readiness check marked not ready: ${reason}`);
    }

    markReady() {
        this.isReady = true;
        this.reason = null;
        Logger.info('Readiness check marked ready');
    }

    registerCheck(name, checkFn) {
        this.checks.set(name, checkFn);
    }

    async runChecks() {
        const results = {};
        let allPassed = true;

        for (const [name, checkFn] of this.checks) {
            try {
                const result = await checkFn();
                results[name] = { status: 'healthy', ...result };
            } catch (error) {
                results[name] = { status: 'unhealthy', error: error.message };
                allPassed = false;
            }
        }

        return { allPassed, results };
    }

    createRouter() {
        const router = express.Router();

        // Liveness probe - 进程是否存活
        router.get('/health/live', (req, res) => {
            if (this.isHealthy) {
                res.status(200).json({ status: 'alive' });
            } else {
                res.status(503).json({ 
                    status: 'unhealthy', 
                    reason: this.reason 
                });
            }
        });

        // Readiness probe - 是否准备好接收流量
        router.get('/health/ready', async (req, res) => {
            if (!this.isReady) {
                return res.status(503).json({ 
                    status: 'not_ready', 
                    reason: this.reason 
                });
            }

            const { allPassed, results } = await this.runChecks();
            
            if (allPassed) {
                res.status(200).json({ 
                    status: 'ready',
                    checks: results
                });
            } else {
                res.status(503).json({ 
                    status: 'degraded',
                    checks: results
                });
            }
        });

        // 详细健康检查
        router.get('/health/detail', async (req, res) => {
            const { allPassed, results } = await this.runChecks();
            
            res.json({
                status: allPassed ? 'healthy' : 'degraded',
                isShuttingDown: !this.isReady && this.reason === 'shutting_down',
                checks: results,
                timestamp: new Date().toISOString()
            });
        });

        return router;
    }
}

module.exports = HealthChecker;
```

### 4. 服务初始化示例

```javascript
// backend/services/pokemon-service/src/index.js
const express = require('express');
const knex = require('./db/knex');
const Redis = require('ioredis');
const GracefulShutdown = require('../../../shared/gracefulShutdown');
const HealthChecker = require('../../../shared/healthChecker');
const Logger = require('../../../shared/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化健康检查器
const healthChecker = new HealthChecker();

// 注册健康检查
healthChecker.registerCheck('database', async () => {
    await knex.raw('SELECT 1');
    return { latency: 0 };
});

healthChecker.registerCheck('redis', async () => {
    const redis = new Redis(process.env.REDIS_URL);
    await redis.ping();
    redis.disconnect();
    return { latency: 0 };
});

// 初始化优雅停机
const shutdownManager = new GracefulShutdown({ timeout: 60000 });

// Redis 客户端
const redisClient = new Redis(process.env.REDIS_URL);

// WebSocket 服务器（如果有）
const WebSocket = require('ws');
const wss = new WebSocket.Server({ noServer: true });

// 后台任务
const backgroundJobs = [
    { stop: () => clearInterval(syncInterval) },
    { stop: () => clearTimeout(timeoutJob) }
];

// 使用中间件
app.use(shutdownManager.middleware());
app.use(healthChecker.createRouter());

// 路由
app.use('/api/pokemon', require('./routes/pokemon'));

// 创建 HTTP 服务器
const server = app.listen(PORT, () => {
    Logger.info(`Pokemon service listening on port ${PORT}`);
    healthChecker.markHealthy();
});

// WebSocket 升级
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// 初始化优雅停机管理器
shutdownManager.init(server, {
    dbConnections: [knex.client.pool],
    redisClients: [redisClient],
    backgroundJobs,
    webSocketServers: [wss],
    healthChecker
});

// 监听停机事件
shutdownManager.on('shutdown:start', (data) => {
    Logger.info('Shutdown started', data);
});

shutdownManager.on('shutdown:complete', (data) => {
    Logger.info('Shutdown completed', data);
});

shutdownManager.on('shutdown:timeout', (data) => {
    Logger.warn('Shutdown timeout reached', data);
});

// 处理未捕获异常
process.on('uncaughtException', (error) => {
    Logger.error('Uncaught exception:', error);
    shutdownManager.shutdown('uncaught_exception');
});

process.on('unhandledRejection', (reason, promise) => {
    Logger.error('Unhandled rejection:', reason);
});

module.exports = app;
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics/shutdownMetrics.js
const client = require('prom-client');

const shutdownMetrics = {
    shutdownTotal: new client.Counter({
        name: 'service_shutdown_total',
        help: 'Total number of service shutdowns',
        labelNames: ['reason', 'status']
    }),

    shutdownDuration: new client.Histogram({
        name: 'service_shutdown_duration_seconds',
        help: 'Duration of graceful shutdown',
        buckets: [1, 5, 10, 20, 30, 60]
    }),

    activeConnectionsAtShutdown: new client.Gauge({
        name: 'service_active_connections_at_shutdown',
        help: 'Number of active connections when shutdown started'
    }),

    activeRequestsAtShutdown: new client.Gauge({
        name: 'service_active_requests_at_shutdown',
        help: 'Number of active requests when shutdown started'
    }),

    forcedShutdownTotal: new client.Counter({
        name: 'service_forced_shutdown_total',
        help: 'Total number of forced shutdowns (timeout)',
        labelNames: ['reason']
    })
};

module.exports = shutdownMetrics;
```

## 验收标准

- [ ] 服务收到 SIGTERM 信号后启动优雅停机流程
- [ ] 停机时健康检查立即返回 503，防止新流量进入
- [ ] 等待所有活跃请求完成（最长等待时间可配置）
- [ ] WebSocket 连接在关闭前通知客户端重新连接
- [ ] 数据库连接池正确关闭，无连接泄漏
- [ ] Redis 连接正确关闭
- [ ] 后台定时任务正确停止
- [ ] 超时后强制关闭并记录告警日志
- [ ] Kubernetes readinessProbe 正确集成
- [ ] 停机事件发送到监控系统
- [ ] 重新部署时零请求丢失
- [ ] 停机耗时在预期范围内（<30秒正常完成）

## 影响范围

- **所有微服务**：集成优雅停机管理器
- **gateway**：停机时正确排空连接
- **backend/shared**：新增 `gracefulShutdown.js`、`healthChecker.js`
- **infrastructure/k8s**：更新 Deployment 配置，添加 preStop hook
- **监控**：新增停机相关 Prometheus 指标
- **Kafka 消费者**：停机时正确提交 offset

## 参考

- [Kubernetes Graceful Shutdown](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- [Node.js Graceful Shutdown](https://blog.risingstack.com/graceful-shutdown-node-js-kubernetes/)
- [AWS ELB Connection Draining](https://docs.aws.amazon.com/elasticloadbalancing/latest/classic/config-conn-drain.html)
- [Nginx Graceful Shutdown](https://nginx.org/en/docs/control.html)
