/**
 * 部署实时推送 Gateway
 * REQ-00492: 部署流水线可视化看板与状态追踪系统
 */

class DeploymentGateway {
  constructor(io) {
    this.io = io;
    this.clients = new Map();
    this.setupHandlers();
  }

  setupHandlers() {
    const namespace = this.io.of('/deployments');
    
    namespace.on('connection', (socket) => {
      console.log(`[DeploymentWS] Client connected: ${socket.id}`);

      // 订阅环境更新
      socket.on('subscribe', (environment) => {
        socket.join(`env:${environment}`);
        socket.environment = environment;
        console.log(`[DeploymentWS] Client ${socket.id} subscribed to ${environment}`);
        
        // 发送欢迎消息
        socket.emit('connected', { 
          message: `Connected to ${environment} deployment updates`,
          environment 
        });
      });

      // 订阅特定部署
      socket.on('watch', (deploymentId) => {
        socket.join(`deployment:${deploymentId}`);
        console.log(`[DeploymentWS] Client ${socket.id} watching deployment ${deploymentId}`);
      });

      // 取消订阅
      socket.on('unsubscribe', (environment) => {
        socket.leave(`env:${environment}`);
        console.log(`[DeploymentWS] Client ${socket.id} unsubscribed from ${environment}`);
      });

      // 请求历史日志
      socket.on('get-logs', async (deploymentId) => {
        const logs = await this._fetchLogs(deploymentId);
        socket.emit('logs', { deploymentId, logs });
      });

      // 心跳
      socket.on('ping', () => {
        socket.emit('pong');
      });

      socket.on('disconnect', () => {
        this.clients.delete(socket.id);
        console.log(`[DeploymentWS] Client disconnected: ${socket.id}`);
      });

      this.clients.set(socket.id, socket);
    });
  }

  /**
   * 广播事件
   */
  broadcast(type, data) {
    const message = { type, timestamp: new Date().toISOString(), ...data };

    // 发送到特定部署房间
    if (data.deploymentId || data.deployment?.deployment_id) {
      const deploymentId = data.deploymentId || data.deployment.deployment_id;
      this.io.of('/deployments')
        .to(`deployment:${deploymentId}`)
        .emit('update', message);
    }
    
    // 发送到环境房间
    if (data.environment || data.deployment?.environment) {
      const env = data.environment || data.deployment.environment;
      this.io.of('/deployments')
        .to(`env:${env}`)
        .emit('update', message);
    }
    
    // 全局广播
    this.io.of('/deployments').emit('global-update', message);
  }

  /**
   * 获取在线客户端数
   */
  getConnectedCount() {
    return this.clients.size;
  }

  /**
   * 获取环境订阅者数量
   */
  getSubscribersCount(environment) {
    const room = this.io.of('/deployments').adapter.rooms.get(`env:${environment}`);
    return room ? room.size : 0;
  }

  /**
   * 模拟获取日志（实际应从存储或流式日志服务获取）
   */
  async _fetchLogs(deploymentId) {
    // 这里应该从实际存储获取日志
    return [
      { time: new Date().toISOString(), level: 'info', message: 'Deployment logs placeholder' }
    ];
  }
}

module.exports = DeploymentGateway;