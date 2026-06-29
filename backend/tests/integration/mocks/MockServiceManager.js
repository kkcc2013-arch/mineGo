/**
 * Mock 服务管理器
 * 用于模拟外部依赖和第三方服务
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

class MockServiceManager {
  constructor() {
    this.mocks = new Map();
    this.servers = new Map();
    this.callHistory = new Map();
    this.defaultResponses = new Map();
  }

  /**
   * 创建 Mock 服务
   */
  createMock(serviceName, port) {
    const app = express();
    app.use(express.json());
    
    const mock = {
      app,
      routes: new Map(),
      middlewares: []
    };
    
    this.mocks.set(serviceName, mock);
    this.callHistory.set(serviceName, []);
    
    // 添加请求日志中间件
    app.use((req, res, next) => {
      const call = {
        id: uuidv4(),
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
        query: req.query,
        params: req.params,
        timestamp: new Date()
      };
      
      const history = this.callHistory.get(serviceName);
      history.push(call);
      
      // 添加响应结束钩子
      const originalEnd = res.end.bind(res);
      res.end = function(chunk, encoding) {
        call.statusCode = res.statusCode;
        call.responseBody = chunk ? chunk.toString() : null;
        originalEnd(chunk, encoding);
      };
      
      next();
    });
    
    return mock;
  }

  /**
   * 设置路由处理器
   */
  setupRoute(serviceName, method, path, handler) {
    const mock = this.mocks.get(serviceName);
    if (!mock) {
      throw new Error(`Mock service '${serviceName}' not found`);
    }
    
    const routeKey = `${method.toUpperCase()} ${path}`;
    mock.routes.set(routeKey, handler);
    
    // 注册路由
    mock.app[method.toLowerCase()](path, async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        console.error(`[MockService] Handler error for ${routeKey}:`, error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
    
    console.log(`[MockService] Route registered: ${routeKey}`);
  }

  /**
   * 设置默认响应
   */
  setDefaultResponse(serviceName, method, path, response, statusCode = 200) {
    const key = `${serviceName}:${method.toUpperCase()} ${path}`;
    this.defaultResponses.set(key, { response, statusCode });
    
    this.setupRoute(serviceName, method, path, (req, res) => {
      res.status(statusCode).json(response);
    });
  }

  /**
   * 启动 Mock 服务
   */
  async startMock(serviceName, port) {
    const mock = this.mocks.get(serviceName);
    if (!mock) {
      throw new Error(`Mock service '${serviceName}' not found`);
    }
    
    return new Promise((resolve, reject) => {
      const server = mock.app.listen(port, () => {
        this.servers.set(serviceName, server);
        console.log(`[MockService] ${serviceName} started on port ${port}`);
        resolve({ serviceName, port });
      });
      
      server.on('error', reject);
    });
  }

  /**
   * 停止 Mock 服务
   */
  async stopMock(serviceName) {
    const server = this.servers.get(serviceName);
    if (!server) {
      return;
    }
    
    return new Promise((resolve) => {
      server.close(() => {
        this.servers.delete(serviceName);
        console.log(`[MockService] ${serviceName} stopped`);
        resolve();
      });
    });
  }

  /**
   * 停止所有 Mock 服务
   */
  async stopAll() {
    const stops = [];
    for (const serviceName of this.servers.keys()) {
      stops.push(this.stopMock(serviceName));
    }
    await Promise.all(stops);
  }

  /**
   * 获取调用历史
   */
  getCallHistory(serviceName) {
    return this.callHistory.get(serviceName) || [];
  }

  /**
   * 获取最后一次调用
   */
  getLastCall(serviceName) {
    const history = this.callHistory.get(serviceName);
    return history && history.length > 0 ? history[history.length - 1] : null;
  }

  /**
   * 验证调用
   */
  verifyCall(serviceName, method, path, options = {}) {
    const history = this.callHistory.get(serviceName) || [];
    
    return history.some(call => {
      if (call.method !== method || call.path !== path) {
        return false;
      }
      
      if (options.body) {
        for (const [key, value] of Object.entries(options.body)) {
          if (call.body[key] !== value) {
            return false;
          }
        }
      }
      
      if (options.query) {
        for (const [key, value] of Object.entries(options.query)) {
          if (call.query[key] !== value) {
            return false;
          }
        }
      }
      
      return true;
    });
  }

  /**
   * 清空调用历史
   */
  resetHistory(serviceName) {
    if (serviceName) {
      this.callHistory.set(serviceName, []);
    } else {
      for (const key of this.callHistory.keys()) {
        this.callHistory.set(key, []);
      }
    }
  }

  /**
   * 重置所有 Mock
   */
  reset() {
    this.mocks.clear();
    this.callHistory.clear();
    this.defaultResponses.clear();
  }
}

/**
 * 创建支付服务 Mock
 */
async function setupPaymentMock(mockManager, port = 3009) {
  mockManager.createMock('payment-service', port);
  
  // Mock 创建支付
  mockManager.setupRoute('payment-service', 'POST', '/api/v1/payments', (req, res) => {
    res.json({
      success: true,
      paymentId: uuidv4(),
      status: 'pending',
      amount: req.body.amount,
      currency: req.body.currency || 'USD',
      createdAt: new Date().toISOString()
    });
  });
  
  // Mock 支付验证
  mockManager.setupRoute('payment-service', 'GET', '/api/v1/payments/:id', (req, res) => {
    res.json({
      success: true,
      payment: {
        id: req.params.id,
        status: 'completed',
        amount: 1000,
        currency: 'USD',
        completedAt: new Date().toISOString()
      }
    });
  });
  
  // Mock 退款
  mockManager.setupRoute('payment-service', 'POST', '/api/v1/payments/:id/refund', (req, res) => {
    res.json({
      success: true,
      refundId: uuidv4(),
      status: 'completed',
      amount: req.body.amount || 1000,
      processedAt: new Date().toISOString()
    });
  });
  
  await mockManager.startMock('payment-service', port);
}

/**
 * 创建位置服务 Mock
 */
async function setupLocationMock(mockManager, port = 3010) {
  mockManager.createMock('location-service', port);
  
  // Mock 附近精灵查询
  mockManager.setupRoute('location-service', 'GET', '/api/v1/nearby', (req, res) => {
    const pokemon = [];
    const count = Math.floor(Math.random() * 5) + 3;
    
    for (let i = 0; i < count; i++) {
      pokemon.push({
        spawnId: uuidv4(),
        speciesId: Math.floor(Math.random() * 151) + 1,
        lat: parseFloat(req.query.lat) + (Math.random() - 0.5) * 0.01,
        lng: parseFloat(req.query.lng) + (Math.random() - 0.5) * 0.01,
        level: Math.floor(Math.random() * 30) + 1,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      });
    }
    
    res.json({
      success: true,
      pokemon,
      radius: parseInt(req.query.radius) || 1000
    });
  });
  
  // Mock 地理围栏验证
  mockManager.setupRoute('location-service', 'POST', '/api/v1/geofence/check', (req, res) => {
    res.json({
      success: true,
      allowed: true,
      region: req.body.region || 'Asia',
      restrictions: []
    });
  });
  
  await mockManager.startMock('location-service', port);
}

/**
 * 创建通知服务 Mock
 */
async function setupNotificationMock(mockManager, port = 3011) {
  mockManager.createMock('notification-service', port);
  
  // Mock 发送推送通知
  mockManager.setupRoute('notification-service', 'POST', '/api/v1/notifications/push', (req, res) => {
    res.json({
      success: true,
      notificationId: uuidv4(),
      status: 'sent',
      sentAt: new Date().toISOString()
    });
  });
  
  // Mock 发送邮件
  mockManager.setupRoute('notification-service', 'POST', '/api/v1/notifications/email', (req, res) => {
    res.json({
      success: true,
      messageId: uuidv4(),
      status: 'queued',
      queuedAt: new Date().toISOString()
    });
  });
  
  await mockManager.startMock('notification-service', port);
}

module.exports = {
  MockServiceManager,
  setupPaymentMock,
  setupLocationMock,
  setupNotificationMock
};