// backend/shared/adaptivePoolManager.js
// Adaptive Pool Manager with Auto-scaling and Cost Optimization
'use strict';

const EventEmitter = require('events');
const { createLogger } = require('./logger');
const { poolMetrics } = require('./poolMetrics');

const logger = createLogger('adaptive-pool-manager');

// ============================================================
// AdaptivePoolManager Class
// ============================================================

class AdaptivePoolManager extends EventEmitter {
  constructor(pool, serviceName, options = {}) {
    super();
    
    this.pool = pool;
    this.serviceName = serviceName;
    
    // Configuration
    this.config = {
      minSize: options.minSize || 2,
      maxSize: options.maxSize || 20,
      targetUtilization: options.targetUtilization || 0.7,
      scaleUpThreshold: options.scaleUpThreshold || 0.85,
      scaleDownThreshold: options.scaleDownThreshold || 0.3,
      scaleUpStep: options.scaleUpStep || 3,
      scaleDownStep: options.scaleDownStep || 2,
      evaluationInterval: options.evaluationInterval || 30000,
      stabilizationPeriod: options.stabilizationPeriod || 60000,
      maxIdleTime: options.maxIdleTime || 300000,
      costOptimization: options.costOptimization !== false,
      ...options
    };
    
    // State
    this.currentSize = pool.options?.max || this.config.minSize;
    this.lastScaleTime = 0;
    this.scaleHistory = [];
    this.utilizationHistory = [];
    this.evaluationInterval = null;
    
    // Time-based scaling multipliers
    this.timeMultipliers = [
      { name: 'night', startHour: 0, endHour: 6, multiplier: 0.5 },
      { name: 'morning', startHour: 6, endHour: 12, multiplier: 0.8 },
      { name: 'afternoon', startHour: 12, endHour: 18, multiplier: 1.0 },
      { name: 'evening', startHour: 18, endHour: 24, multiplier: 1.3 }
    ];
    
    this.startEvaluation();
  }
  
  startEvaluation() {
    this.evaluationInterval = setInterval(() => {
      this.evaluateAndAdjust();
    }, this.config.evaluationInterval);
    
    logger.info({
      service: this.serviceName,
      interval: this.config.evaluationInterval
    }, 'Adaptive pool manager started');
  }
  
  async evaluateAndAdjust() {
    const metrics = this.collectPoolMetrics();
    
    // Record utilization history
    this.utilizationHistory.push({
      timestamp: Date.now(),
      utilization: metrics.utilization,
      waiting: metrics.waitingClients,
      total: metrics.totalConnections
    });
    
    // Keep only last 20 samples
    if (this.utilizationHistory.length > 20) {
      this.utilizationHistory.shift();
    }
    
    // Calculate smoothed utilization
    const avgUtilization = this.utilizationHistory.reduce((sum, m) => sum + m.utilization, 0) 
      / this.utilizationHistory.length;
    
    // Decide action
    const action = this.decideAction(metrics, avgUtilization);
    
    if (action) {
      await this.executeAction(action, metrics);
    }
    
    // Cleanup idle connections
    this.cleanupIdleConnections(metrics);
  }
  
  collectPoolMetrics() {
    const pool = this.pool;
    
    return {
      totalConnections: pool.totalCount || 0,
      idleConnections: pool.idleCount || 0,
      waitingClients: pool.waitingCount || 0,
      utilization: pool.totalCount > 0 
        ? (pool.totalCount - pool.idleCount) / pool.totalCount 
        : 0,
      saturation: pool.options?.max > 0
        ? (pool.totalCount - pool.idleCount) / pool.options.max
        : 0
    };
  }
  
  decideAction(metrics, avgUtilization) {
    const now = Date.now();
    
    // Respect stabilization period
    if (now - this.lastScaleTime < this.config.stabilizationPeriod) {
      return null;
    }
    
    // Emergency scale up: waiting clients and high utilization
    if (metrics.waitingClients > 0 && avgUtilization > this.config.scaleUpThreshold) {
      return {
        type: 'scale_up',
        reason: 'waiting_clients',
        urgency: 'high',
        amount: Math.min(
          this.config.scaleUpStep * 2,
          this.config.maxSize - this.currentSize
        )
      };
    }
    
    // Normal scale up: sustained high utilization
    if (avgUtilization > this.config.scaleUpThreshold) {
      return {
        type: 'scale_up',
        reason: 'high_utilization',
        urgency: 'normal',
        amount: Math.min(
          this.config.scaleUpStep,
          this.config.maxSize - this.currentSize
        )
      };
    }
    
    // Scale down: sustained low utilization
    if (avgUtilization < this.config.scaleDownThreshold && 
        this.currentSize > this.config.minSize) {
      
      // Apply time-based multiplier
      const timeMultiplier = this.getTimeMultiplier();
      const adjustedMinSize = Math.ceil(this.config.minSize * timeMultiplier);
      
      if (this.currentSize > adjustedMinSize) {
        return {
          type: 'scale_down',
          reason: 'low_utilization',
          urgency: 'normal',
          amount: Math.min(
            this.config.scaleDownStep,
            this.currentSize - adjustedMinSize
          )
        };
      }
    }
    
    return null;
  }
  
  async executeAction(action, metrics) {
    const oldSize = this.currentSize;
    
    if (action.type === 'scale_up') {
      if (action.amount <= 0) return;
      
      this.currentSize = Math.min(
        this.currentSize + action.amount,
        this.config.maxSize
      );
      
      try {
        await this.resizePool(this.currentSize);
        
        this.lastScaleTime = Date.now();
        this.recordScaleAction(action, oldSize, this.currentSize, metrics);
        
        this.emit('scale_up', {
          from: oldSize,
          to: this.currentSize,
          reason: action.reason,
          metrics
        });
        
        logger.info('Connection pool scaled up', {
          service: this.serviceName,
          from: oldSize,
          to: this.currentSize,
          reason: action.reason,
          urgency: action.urgency
        });
      } catch (error) {
        logger.error('Failed to scale up connection pool', {
          service: this.serviceName,
          error: error.message
        });
      }
    } else if (action.type === 'scale_down') {
      if (action.amount <= 0) return;
      
      this.currentSize = Math.max(
        this.currentSize - action.amount,
        this.config.minSize
      );
      
      try {
        await this.resizePool(this.currentSize);
        
        this.lastScaleTime = Date.now();
        this.recordScaleAction(action, oldSize, this.currentSize, metrics);
        
        this.emit('scale_down', {
          from: oldSize,
          to: this.currentSize,
          reason: action.reason,
          metrics
        });
        
        logger.info('Connection pool scaled down', {
          service: this.serviceName,
          from: oldSize,
          to: this.currentSize,
          reason: action.reason
        });
      } catch (error) {
        logger.error('Failed to scale down connection pool', {
          service: this.serviceName,
          error: error.message
        });
      }
    }
  }
  
  async resizePool(newSize) {
    const pool = this.pool;
    
    // Update pool max size
    if (pool.options) {
      pool.options.max = newSize;
    }
    
    // Pre-warm connections if scaling up
    const currentTotal = pool.totalCount || 0;
    if (newSize > currentTotal) {
      const connections = [];
      for (let i = 0; i < newSize - currentTotal; i++) {
        connections.push(pool.connect().then(client => {
          client.release();
          return true;
        }).catch(() => false));
      }
      await Promise.all(connections);
    }
    
    logger.debug('Pool resized', {
      service: this.serviceName,
      newSize,
      currentTotal
    });
  }
  
  recordScaleAction(action, from, to, metrics) {
    this.scaleHistory.push({
      timestamp: Date.now(),
      action: action.type,
      reason: action.reason,
      from,
      to,
      utilization: metrics.utilization,
      waitingClients: metrics.waitingClients
    });
    
    // Keep last 100 records
    if (this.scaleHistory.length > 100) {
      this.scaleHistory.shift();
    }
  }
  
  cleanupIdleConnections(metrics) {
    // Let pg-pool handle idle timeout via idleTimeoutMillis config
    if (metrics.idleConnections > this.config.minSize) {
      logger.debug('Idle connections available for cleanup', {
        service: this.serviceName,
        idle: metrics.idleConnections,
        minSize: this.config.minSize
      });
    }
  }
  
  getTimeMultiplier() {
    const hour = new Date().getHours();
    
    for (const timeConfig of this.timeMultipliers) {
      if (hour >= timeConfig.startHour && hour < timeConfig.endHour) {
        return timeConfig.multiplier;
      }
    }
    
    return 1.0;
  }
  
  getScaleHistory(limit = 20) {
    return this.scaleHistory.slice(-limit);
  }
  
  getStatus() {
    const metrics = this.collectPoolMetrics();
    const timeMultiplier = this.getTimeMultiplier();
    
    return {
      serviceName: this.serviceName,
      currentSize: this.currentSize,
      minSize: this.config.minSize,
      maxSize: this.config.maxSize,
      targetUtilization: this.config.targetUtilization,
      timeMultiplier,
      adjustedMinSize: Math.ceil(this.config.minSize * timeMultiplier),
      ...metrics,
      lastScaleTime: this.lastScaleTime,
      recentScaleActions: this.getScaleHistory(5),
      avgUtilization: this.utilizationHistory.length > 0
        ? this.utilizationHistory.reduce((sum, m) => sum + m.utilization, 0) / this.utilizationHistory.length
        : 0
    };
  }
  
  // Optimize configuration based on historical data
  optimizeFromHistory(historicalData) {
    if (!historicalData || historicalData.length === 0) return;
    
    const peakUtilization = Math.max(...historicalData.map(m => m.utilization));
    const avgUtilization = historicalData.reduce((sum, m) => sum + m.utilization, 0) 
      / historicalData.length;
    const maxWaiting = Math.max(...historicalData.map(m => m.waiting || 0));
    
    // Adjust thresholds based on observed patterns
    if (peakUtilization > 0.9) {
      this.config.maxSize = Math.min(this.config.maxSize + 5, 30);
      logger.info('Increased max pool size based on peak utilization', {
        service: this.serviceName,
        newMaxSize: this.config.maxSize,
        peakUtilization
      });
    }
    
    if (avgUtilization < 0.3 && this.config.minSize > 2) {
      this.config.minSize = Math.max(this.config.minSize - 1, 2);
      logger.info('Decreased min pool size based on low average utilization', {
        service: this.serviceName,
        newMinSize: this.config.minSize,
        avgUtilization
      });
    }
    
    if (maxWaiting > 5) {
      this.config.scaleUpThreshold = Math.max(this.config.scaleUpThreshold - 0.05, 0.7);
      logger.info('Adjusted scale-up threshold based on waiting clients', {
        service: this.serviceName,
        newThreshold: this.config.scaleUpThreshold,
        maxWaiting
      });
    }
  }
  
  destroy() {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
    }
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = { AdaptivePoolManager };
