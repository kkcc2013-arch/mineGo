// mockService/core/MockServer.js - Mock 服务核心引擎
'use strict';

/**
 * REQ-00546: API Mock 服务与测试隔离系统
 * 
 * MockServer - 轻量级 HTTP/WebSocket Mock 服务器
 * 
 * 特性：
 * - 动态路由配置
 * - 多种响应模式：静态、动态、延迟、错误注入
 * - WebSocket 支持
 * - 请求录制与回放
 * - Prometheus 指标
 */

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createLogger } = require('../../logger');
const metrics = require('../../metrics');

const logger = createLogger('mock-server');

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  port: 9000,
  host: '0.0.0.0',
  mode: 'replay', // 'replay' | 'record' | 'passthrough'
  defaultDelay: 0,
  defaultStatus: 200,
  enableMetrics: true,
  enableCors: true,
  enableLogging: true
};

/**
 * Mock 路由定义
 */
class MockRoute {
  constructor(config) {
    this.method = config.method || 'GET';
    this.path = config.path;
    this.response = config.response;
    this.status = config.status || 200;
    this.delay = config.delay || 0;
    this.headers = config.headers || {};
    this.condition = config.condition; // 条件函数
    this.transform = config.transform; // 响应转换函数
    this.errors = config.errors || []; // 错误注入配置
    this.rate = config.rate || 1; // 命中率（0-1）
  }

  /**
   * 判断是否匹配当前请求
   */
  matches(req) {
    if (req.method !== this.method) return false;
    
    // 支持路径参数匹配
    const pathPattern = this.path.replace(/:[^/]+/g, '[^/]+');
    const regex = new RegExp(`^${pathPattern}$`);
    return regex.test(req.path);
  }

  /**
   * 生成响应
   */
  async generateResponse(req) {
    // 检查条件
    if (this.condition && !await this.condition(req)) {
      return null;
    }

    // 检查命中率
    if (Math.random() > this.rate) {
      return null;
    }

    // 错误注入
    if (this.errors.length > 0 && Math.random() < 0.1) {
      const error = this.errors[Math.floor(Math.random() * this.errors.length)];
      return {
        status: error.status || 500,
        body: error.body || { error: 'Mock error injection' },
        headers: this.headers
      };
    }

    // 生成响应体
    let body;
    if (typeof this.response === 'function') {
      body = await this.response(req);
    } else if (typeof this.response === 'object') {
      body = { ...this.response };
    } else {
      body = this.response;
    }

    // 应用转换
    if (this.transform) {
      body = await this.transform(body, req);
    }

    return {
      status: this.status,
      body,
      headers: this.headers
    };
  }
}

/**
 * Mock 服务器主类
 */
class MockServer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.app = express();
    this.server = null;
    this.wsServer = null;
    this.routes = new Map();
    this.wsHandlers = new Map();
    this.recordings = [];
    this.isRunning = false;
    
    // 统计数据
    this.stats = {
      requests: 0,
      matched: 0,
      unmatched: 0,
      errors: 0,
      wsConnections: 0,
      wsMessages: 0
    };

    this._setupMiddleware();
    this._setupRoutes();
    logger.info({ config: this.config }, 'MockServer initialized');
  }

  /**
   * 设置中间件
   */
  _setupMiddleware() {
    // JSON 解析
    this.app.use(express.json());
    
    // CORS 支持
    if (this.config.enableCors) {
      this.app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        next();
      });
    }

    // 请求日志
    if (this.config.enableLogging) {
      this.app.use((req, res, next) => {
        logger.debug({
          method: req.method,
          path: req.path,
          query: req.query,
          body: req.body
        }, 'Mock request received');
        next();
      });
    }

    // 请求录制
    this.app.use((req, res, next) => {
      const startTime = Date.now();
      
      // 记录响应
      const originalSend = res.send.bind(res);
      res.send = (body) => {
        const duration = Date.now() - startTime;
        
        // 录制请求-响应对
        if (this.config.mode === 'record') {
          this.recordings.push({
            request: {
              method: req.method,
              path: req.path,
              query: req.query,
              headers: req.headers,
              body: req.body
            },
            response: {
              status: res.statusCode,
              body: body,
              headers: res.getHeaders()
            },
            duration,
            timestamp: new Date().toISOString()
          });
        }
        
        // 更新统计
        this.stats.requests++;
        
        // 记录指标
        if (this.config.enableMetrics) {
          metrics.increment('mock.requests.total');
          metrics.histogram('mock.request.duration', duration);
        }
        
        return originalSend(body);
      };
      
      next();
    });
  }

  /**
   * 设置路由处理
   */
  _setupRoutes() {
    // 健康检查
    this.app.get('/mock/health', (req, res) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        routes: this.routes.size,
        wsHandlers: this.wsHandlers.size,
        stats: this.stats
      });
    });

    // 路由管理接口
    this.app.get('/mock/routes', (req, res) => {
      const routes = Array.from(this.routes.values()).map(r => ({
        method: r.method,
        path: r.path,
        status: r.status,
        delay: r.delay
      }));
      res.json({ routes, count: routes.length });
    });

    // 统计接口
    this.app.get('/mock/stats', (req, res) => {
      res.json({
        ...this.stats,
        uptime: process.uptime(),
        mode: this.config.mode,
        recordings: this.recordings.length
      });
    });

    // 重置接口
    this.app.post('/mock/reset', (req, res) => {
      this.routes.clear();
      this.wsHandlers.clear();
      this.recordings = [];
      this.stats.requests = 0;
      this.stats.matched = 0;
      this.stats.unmatched = 0;
      this.stats.errors = 0;
      res.json({ status: 'reset', routes: 0 });
    });

    // Mock 路由匹配（放在最后）
    this.app.use((req, res) => {
      this._handleMockRequest(req, res);
    });
  }

  /**
   * 处理 Mock 请求
   */
  async _handleMockRequest(req, res) {
    // 查找匹配的路由
    const matchedRoute = this._findMatchingRoute(req);
    
    if (!matchedRoute) {
      this.stats.unmatched++;
      
      if (this.config.enableMetrics) {
        metrics.increment('mock.requests.unmatched');
      }
      
      return res.status(404).json({
        error: 'No mock route matched',
        method: req.method,
        path: req.path,
        hint: 'Use registerRoute() to add mock routes'
      });
    }

    this.stats.matched++;
    
    if (this.config.enableMetrics) {
      metrics.increment('mock.requests.matched');
    }

    try {
      // 生成响应
      const response = await matchedRoute.generateResponse(req);
      
      if (!response) {
        return res.status(404).json({
          error: 'Mock route condition not met'
        });
      }

      // 应用延迟
      if (matchedRoute.delay > 0) {
        await this._sleep(matchedRoute.delay);
      }

      // 发送响应
      res.set(response.headers);
      res.status(response.status).json(response.body);
      
    } catch (error) {
      this.stats.errors++;
      logger.error({ error: error.message, stack: error.stack }, 'Mock response generation failed');
      
      res.status(500).json({
        error: 'Mock response generation failed',
        message: error.message
      });
    }
  }

  /**
   * 查找匹配的路由
   */
  _findMatchingRoute(req) {
    for (const route of this.routes.values()) {
      if (route.matches(req)) {
        return route;
      }
    }
    return null;
  }

  /**
   * 注册 Mock 路由
   */
  registerRoute(config) {
    const route = new MockRoute(config);
    const key = `${route.method}:${route.path}`;
    this.routes.set(key, route);
    
    logger.info({ method: route.method, path: route.path }, 'Mock route registered');
    return this;
  }

  /**
   * 批量注册路由
   */
  registerRoutes(routes) {
    routes.forEach(config => this.registerRoute(config));
    return this;
  }

  /**
   * 移除路由
   */
  removeRoute(method, path) {
    const key = `${method}:${path}`;
    const removed = this.routes.delete(key);
    
    if (removed) {
      logger.info({ method, path }, 'Mock route removed');
    }
    
    return removed;
  }

  /**
   * 注册 WebSocket 处理器
   */
  registerWebSocket(path, handler) {
    this.wsHandlers.set(path, handler);
    logger.info({ path }, 'WebSocket handler registered');
    return this;
  }

  /**
   * 启动 Mock 服务器
   */
  async start() {
    if (this.isRunning) {
      logger.warn('MockServer already running');
      return this;
    }

    return new Promise((resolve, reject) => {
      // 创建 HTTP 服务器
      this.server = http.createServer(this.app);
      
      // 创建 WebSocket 服务器
      this.wsServer = new WebSocketServer({ server: this.server });
      
      this.wsServer.on('connection', (ws, req) => {
        this._handleWebSocketConnection(ws, req);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.isRunning = true;
        logger.info({
          port: this.config.port,
          host: this.config.host,
          mode: this.config.mode
        }, 'MockServer started');
        
        if (this.config.enableMetrics) {
          metrics.gauge('mock.server.running', 1);
        }
        
        resolve(this);
      });

      this.server.on('error', (error) => {
        logger.error({ error: error.message }, 'MockServer failed to start');
        reject(error);
      });
    });
  }

  /**
   * 处理 WebSocket 连接
   */
  _handleWebSocketConnection(ws, req) {
    const path = req.url.split('?')[0];
    const handler = this.wsHandlers.get(path);
    
    if (!handler) {
      ws.close(4004, 'No handler for WebSocket path');
      return;
    }

    this.stats.wsConnections++;
    
    ws.on('message', (data) => {
      this.stats.wsMessages++;
      
      if (this.config.enableMetrics) {
        metrics.increment('mock.ws.messages');
      }
      
      handler(ws, data, req);
    });

    ws.on('close', () => {
      this.stats.wsConnections--;
    });

    logger.info({ path }, 'WebSocket connection established');
  }

  /**
   * 停止 Mock 服务器
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    return new Promise((resolve) => {
      if (this.wsServer) {
        this.wsServer.close();
      }
      
      this.server.close(() => {
        this.isRunning = false;
        logger.info('MockServer stopped');
        
        if (this.config.enableMetrics) {
          metrics.gauge('mock.server.running', 0);
        }
        
        resolve();
      });
    });
  }

  /**
   * 获取录制数据
   */
  getRecordings() {
    return [...this.recordings];
  }

  /**
   * 导出录制数据
   */
  exportRecordings() {
    return {
      version: '1.0',
      exported: new Date().toISOString(),
      recordings: this.recordings,
      stats: this.stats
    };
  }

  /**
   * 导入录制数据（用于回放）
   */
  importRecordings(data) {
    if (data.version && data.recordings) {
      this.recordings = data.recordings;
      logger.info({ count: this.recordings.length }, 'Recordings imported');
    }
    return this;
  }

  /**
   * Sleep 工具函数
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      routes: this.routes.size,
      wsHandlers: this.wsHandlers.size,
      recordings: this.recordings.length,
      isRunning: this.isRunning,
      config: this.config
    };
  }
}

module.exports = MockServer;