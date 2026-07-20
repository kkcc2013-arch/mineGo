'use strict';

const { logger, metrics } = require('../index');

/**
 * 自适应连接池伸缩控制器
 * 
 * 根据系统负载动态调整最大连接数，提升资源利用率
 */
class AdaptiveConnectionPool {
  constructor(options = {}) {
    this.config = {
      // 基础配置
      minConnections: options.minConnections || 1000,
      maxConnections: options.maxConnections || 20000,
      initialMaxConnections: options.initialMaxConnections || 5000,
      
      // 伸缩参数
      scaleUpThreshold: options.scaleUpThreshold || 0.8, // 利用率 > 80% 扩容
      scaleDownThreshold: options.scaleDownThreshold || 0.3, // 利用率 < 30% 缩容
      scaleUpStep: options.scaleUpStep || 1000, // 每次扩容步长
      scaleDownStep: options.scaleDownStep || 500, // 每次缩容步长
      scaleCooldown: options.scaleCooldown || 300000, // 伸缩冷却时间（5分钟）
      
      // 资源限制
      maxMemoryUsage: options.maxMemoryUsage || 0.8, // 最大内存使用率
      maxCpuUsage: options.maxCpuUsage || 0.7, // 最大CPU使用率
      
      // 监控周期
      monitorInterval: options.monitorInterval || 60000 // 1分钟
    };
    
    // 当前状态
    this.state = {
      currentMax: this.config.initialMaxConnections,
      currentConnections: 0,
      utilization: 0,
      lastScaleTime: 0,
      lastScaleDirection: null,
      scaleHistory: [],
      resourcePressure: 0 // 0-100 资源压力指数
    };
    
    // 资源监控
    this.resourceMonitor = {
      memoryUsage: 0,
      cpuUsage: 0,
      networkBandwidth: 0
    };
    
    this._monitorTask = null;
    this._setupMetrics();
    this._startMonitoring();
    
    logger.info('Adaptive connection pool initialized', {
      min: this.config.minConnections,
      max: this.config.maxConnections,
      initial: this.state.currentMax
    });
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      poolMaxConnections: metrics.gauge('ws_adaptive_pool_max', 'Current max connections limit'),
      poolUtilization: metrics.gauge('ws_adaptive_pool_utilization', 'Pool utilization ratio'),
      scaleEvents: metrics.counter('ws_adaptive_scale_events_total', 'Scale events', ['direction']),
      resourcePressure: metrics.gauge('ws_adaptive_resource_pressure', 'Resource pressure index (0-100)'),
      memoryUsage: metrics.gauge('ws_adaptive_memory_usage', 'System memory usage ratio'),
      cpuUsage: metrics.gauge('ws_adaptive_cpu_usage', 'System CPU usage ratio')
    };
  }

  /**
   * 启动资源监控
   */
  _startMonitoring() {
    this._monitorTask = setInterval(() => {
      this._monitorResources();
      this._evaluateScaling();
    }, this.config.monitorInterval);
  }

  /**
   * 监控系统资源
   */
  _monitorResources() {
    const memUsage = process.memoryUsage();
    const os = require('os');
    const totalMemory = os.totalmem();
    
    // 计算内存使用率
    this.resourceMonitor.memoryUsage = memUsage.heapUsed / totalMemory;
    
    // 计算 CPU 使用率（简化）
    const cpuUsage = process.cpuUsage();
    this.resourceMonitor.cpuUsage = (cpuUsage.user + cpuUsage.system) / 1000000 / this.config.monitorInterval;
    
    // 计算资源压力指数
    this.state.resourcePressure = Math.min(100,
      this.resourceMonitor.memoryUsage * 50 +
      this.resourceMonitor.cpuUsage * 50
    );
    
    // 更新指标
    this.metrics.memoryUsage.set(this.resourceMonitor.memoryUsage);
    this.metrics.cpuUsage.set(this.resourceMonitor.cpuUsage);
    this.metrics.resourcePressure.set(this.state.resourcePressure);
  }

  /**
   * 评估是否需要伸缩
   */
  _evaluateScaling() {
    const { currentConnections, currentMax, lastScaleTime } = this.state;
    const now = Date.now();
    
    // 冷却期内不执行伸缩
    if (now - lastScaleTime < this.config.scaleCooldown) {
      return;
    }
    
    // 计算利用率
    const utilization = currentConnections / currentMax;
    this.state.utilization = utilization;
    
    // 更新指标
    this.metrics.poolUtilization.set(utilization);
    this.metrics.poolMaxConnections.set(currentMax);
    
    // 资源压力过大时，暂停扩容
    if (this.state.resourcePressure > 80) {
      logger.warn('Resource pressure high, scaling paused', {
        pressure: this.state.resourcePressure,
        utilization
      });
      return;
    }
    
    // 扩容判断
    if (utilization > this.config.scaleUpThreshold && currentMax < this.config.maxConnections) {
      this._scaleUp();
    }
    // 缩容判断
    else if (utilization < this.config.scaleDownThreshold && currentMax > this.config.minConnections) {
      this._scaleDown();
    }
  }

  /**
   * 扩容连接池
   */
  _scaleUp() {
    const oldMax = this.state.currentMax;
    const newMax = Math.min(
      this.config.maxConnections,
      oldMax + this.config.scaleUpStep
    );
    
    this.state.currentMax = newMax;
    this.state.lastScaleTime = Date.now();
    this.state.lastScaleDirection = 'up';
    
    this._recordScaleEvent('up', oldMax, newMax);
    
    logger.info('Connection pool scaled up', {
      from: oldMax,
      to: newMax,
      utilization: this.state.utilization
    });
    
    this.metrics.scaleEvents.inc({ direction: 'up' });
    this.metrics.poolMaxConnections.set(newMax);
  }

  /**
   * 缩容连接池
   */
  _scaleDown() {
    const oldMax = this.state.currentMax;
    const newMax = Math.max(
      this.config.minConnections,
      oldMax - this.config.scaleDownStep
    );
    
    this.state.currentMax = newMax;
    this.state.lastScaleTime = Date.now();
    this.state.lastScaleDirection = 'down';
    
    this._recordScaleEvent('down', oldMax, newMax);
    
    logger.info('Connection pool scaled down', {
      from: oldMax,
      to: newMax,
      utilization: this.state.utilization
    });
    
    this.metrics.scaleEvents.inc({ direction: 'down' });
    this.metrics.poolMaxConnections.set(newMax);
  }

  /**
   * 记录伸缩事件
   */
  _recordScaleEvent(direction, from, to) {
    this.state.scaleHistory.push({
      direction,
      from,
      to,
      utilization: this.state.utilization,
      resourcePressure: this.state.resourcePressure,
      timestamp: Date.now()
    });
    
    // 保留最近100条记录
    if (this.state.scaleHistory.length > 100) {
      this.state.scaleHistory.shift();
    }
  }

  /**
   * 更新当前连接数
   */
  updateCurrentConnections(count) {
    this.state.currentConnections = count;
  }

  /**
   * 检查是否允许新连接
   */
  canAcceptConnection() {
    return this.state.currentConnections < this.state.currentMax;
  }

  /**
   * 获取当前最大连接数
   */
  getCurrentMax() {
    return this.state.currentMax;
  }

  /**
   * 获取状态信息
   */
  getStatus() {
    return {
      ...this.state,
      resourceMonitor: this.resourceMonitor,
      config: this.config
    };
  }

  /**
   * 关闭控制器
   */
  close() {
    if (this._monitorTask) {
      clearInterval(this._monitorTask);
      this._monitorTask = null;
    }
    logger.info('Adaptive connection pool closed');
  }
}

module.exports = AdaptiveConnectionPool;
