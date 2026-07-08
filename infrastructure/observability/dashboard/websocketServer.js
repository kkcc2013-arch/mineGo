/**
 * WebSocket 服务器
 * 实时推送监控数据到前端大屏
 */

const http = require('http');
const socketIo = require('socket.io');
const MonitoringAggregator = require('./monitoringAggregator');
const AlertingService = require('./alertingService');

class MonitoringWebSocketServer {
  constructor(config = {}) {
    this.port = config.port || process.env.MONITORING_WS_PORT || 3001;
    this.server = null;
    this.io = null;
    
    // 初始化监控聚合器
    this.aggregator = new MonitoringAggregator(config);
    
    // 初始化告警服务
    this.alertingService = new AlertingService(config.alerting);
    
    // 客户端连接
    this.clients = new Set();
  }

  /**
   * 启动服务器
   */
  start() {
    // 创建 HTTP 服务器
    this.server = http.createServer((req, res) => {
      // 健康检查端点
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          clients: this.clients.size,
          uptime: process.uptime()
        }));
        return;
      }
      
      res.writeHead(404);
      res.end('Not Found');
    });
    
    // 创建 Socket.io 服务器
    this.io = socketIo(this.server, {
      cors: {
        origin: config.corsOrigins || ['http://localhost:3000', 'http://localhost:8080'],
        methods: ['GET', 'POST']
      }
    });
    
    // 监听连接
    this.io.on('connection', (socket) => {
      console.log(`[WebSocket] Client connected: ${socket.id}`);
      this.clients.add(socket.id);
      
      // 发送初始数据
      socket.emit('initial-data', this.aggregator.getAllMetrics());
      
      // 发送告警列表
      socket.emit('alerts', this.alertingService.getAllAlerts());
      
      // 监听告警确认
      socket.on('acknowledge-alert', (alertId) => {
        const success = this.alertingService.acknowledgeAlert(alertId);
        socket.emit('alert-acknowledged', { alertId, success });
        
        if (success) {
          // 广播告警确认
          this.io.emit('alerts', this.alertingService.getAllAlerts());
        }
      });
      
      // 监听断开连接
      socket.on('disconnect', () => {
        console.log(`[WebSocket] Client disconnected: ${socket.id}`);
        this.clients.delete(socket.id);
      });
    });
    
    // 启动监控聚合器
    this.aggregator.start();
    
    // 启动告警服务
    this.alertingService.start(this.aggregator);
    
    // 监听聚合事件并广播
    this.aggregator.on('aggregated', (data) => {
      this.io.emit('metrics-update', data);
    });
    
    // 监听告警事件并广播
    this.alertingService.on('alert', (alert) => {
      this.io.emit('new-alert', alert);
    });
    
    // 启动 HTTP 服务器
    this.server.listen(this.port, () => {
      console.log(`[WebSocket] Server started on port ${this.port}`);
    });
  }

  /**
   * 停止服务器
   */
  stop() {
    // 停止监控聚合器
    this.aggregator.stop();
    
    // 停止告警服务
    this.alertingService.stop();
    
    // 关闭 Socket.io
    if (this.io) {
      this.io.close();
    }
    
    // 关闭 HTTP 服务器
    if (this.server) {
      this.server.close();
    }
    
    console.log('[WebSocket] Server stopped');
  }

  /**
   * 获取服务器状态
   */
  getStatus() {
    return {
      port: this.port,
      clients: this.clients.size,
      aggregatorRunning: this.aggregator.isRunning,
      alertingRunning: this.alertingService.isRunning,
      lastAggregation: this.aggregator.getSLOMetrics().timestamp || null
    };
  }
}

module.exports = MonitoringWebSocketServer;

// 如果直接运行此文件，启动服务器
if (require.main === module) {
  const server = new MonitoringWebSocketServer();
  server.start();
  
  // 优雅关闭
  process.on('SIGTERM', () => {
    server.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    server.stop();
    process.exit(0);
  });
}
