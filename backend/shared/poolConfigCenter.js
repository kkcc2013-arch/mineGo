// backend/shared/poolConfigCenter.js
// Centralized Pool Configuration Management
'use strict';

const { createLogger } = require('./logger');

const logger = createLogger('pool-config-center');

// ============================================================
// PoolConfigCenter Class
// ============================================================

class PoolConfigCenter {
  constructor() {
    // Service-specific pool configurations
    this.serviceConfigs = new Map();
    
    // Global default configuration
    this.defaultConfig = {
      minSize: 2,
      maxSize: 20,
      targetUtilization: 0.7,
      idleTimeoutMillis: 300000,      // 5 minutes
      connectionTimeoutMillis: 10000,  // 10 seconds
      statement_timeout: 30000,        // 30 seconds
      query_timeout: 30000,            // 30 seconds
      scaleUpThreshold: 0.85,
      scaleDownThreshold: 0.3
    };
    
    // Time-based multipliers for different periods
    this.timeBasedConfigs = [
      {
        name: 'night',
        startHour: 0,
        endHour: 6,
        multiplier: 0.5,
        description: 'Low traffic period'
      },
      {
        name: 'morning',
        startHour: 6,
        endHour: 12,
        multiplier: 0.8,
        description: 'Moderate traffic period'
      },
      {
        name: 'afternoon',
        startHour: 12,
        endHour: 18,
        multiplier: 1.0,
        description: 'Normal traffic period'
      },
      {
        name: 'evening',
        startHour: 18,
        endHour: 24,
        multiplier: 1.2,
        description: 'Peak traffic period'
      }
    ];
    
    // Service priority tiers
    this.priorityTiers = {
      high: { multiplier: 1.3, description: 'Critical services (auth, payment)' },
      medium: { multiplier: 1.0, description: 'Standard services' },
      low: { multiplier: 0.7, description: 'Non-critical services' }
    };
    
    // Initialize default service configs
    this.initializeServiceConfigs();
  }
  
  initializeServiceConfigs() {
    // High priority services
    this.registerService('user-service', {
      priority: 'high',
      minSize: 4,
      maxSize: 25,
      targetUtilization: 0.65
    });
    
    this.registerService('catch-service', {
      priority: 'high',
      minSize: 4,
      maxSize: 25,
      targetUtilization: 0.65
    });
    
    this.registerService('payment-service', {
      priority: 'high',
      minSize: 3,
      maxSize: 20,
      targetUtilization: 0.6
    });
    
    this.registerService('gateway', {
      priority: 'high',
      minSize: 3,
      maxSize: 15,
      targetUtilization: 0.7
    });
    
    // Medium priority services
    this.registerService('location-service', {
      priority: 'medium',
      minSize: 3,
      maxSize: 18,
      targetUtilization: 0.7
    });
    
    this.registerService('pokemon-service', {
      priority: 'medium',
      minSize: 3,
      maxSize: 18,
      targetUtilization: 0.7
    });
    
    this.registerService('gym-service', {
      priority: 'medium',
      minSize: 3,
      maxSize: 18,
      targetUtilization: 0.7
    });
    
    // Low priority services
    this.registerService('reward-service', {
      priority: 'low',
      minSize: 2,
      maxSize: 12,
      targetUtilization: 0.75
    });
    
    this.registerService('social-service', {
      priority: 'low',
      minSize: 2,
      maxSize: 12,
      targetUtilization: 0.75
    });
  }
  
  registerService(serviceName, customConfig = {}) {
    const priority = customConfig.priority || 'medium';
    const priorityConfig = this.priorityTiers[priority] || this.priorityTiers.medium;
    
    const baseConfig = {
      ...this.defaultConfig,
      minSize: customConfig.minSize || this.defaultConfig.minSize,
      maxSize: Math.ceil((customConfig.maxSize || this.defaultConfig.maxSize) * priorityConfig.multiplier),
      targetUtilization: customConfig.targetUtilization || this.defaultConfig.targetUtilization,
      priority,
      priorityMultiplier: priorityConfig.multiplier
    };
    
    this.serviceConfigs.set(serviceName, {
      baseConfig,
      currentConfig: { ...baseConfig },
      lastUpdated: Date.now(),
      historicalData: []
    });
    
    logger.info('Service pool config registered', {
      service: serviceName,
      priority,
      config: baseConfig
    });
  }
  
  getConfig(serviceName) {
    const serviceConfig = this.serviceConfigs.get(serviceName);
    if (!serviceConfig) {
      return this.defaultConfig;
    }
    
    // Apply time-based adjustment
    const timeMultiplier = this.getTimeMultiplier();
    const config = { ...serviceConfig.baseConfig };
    
    config.maxSize = Math.ceil(config.maxSize * timeMultiplier);
    config.minSize = Math.max(
      Math.ceil(config.minSize * timeMultiplier),
      1
    );
    
    return config;
  }
  
  getTimeMultiplier() {
    const hour = new Date().getHours();
    
    for (const timeConfig of this.timeBasedConfigs) {
      if (hour >= timeConfig.startHour && hour < timeConfig.endHour) {
        return timeConfig.multiplier;
      }
    }
    
    return 1.0;
  }
  
  getCurrentPeriod() {
    const hour = new Date().getHours();
    
    for (const timeConfig of this.timeBasedConfigs) {
      if (hour >= timeConfig.startHour && hour < timeConfig.endHour) {
        return timeConfig;
      }
    }
    
    return this.timeBasedConfigs[2]; // Default to afternoon
  }
  
  // Record metrics for optimization
  recordMetrics(serviceName, metrics) {
    const serviceConfig = this.serviceConfigs.get(serviceName);
    if (!serviceConfig) return;
    
    serviceConfig.historicalData.push({
      timestamp: Date.now(),
      ...metrics
    });
    
    // Keep last 1440 samples (24 hours at 1-minute intervals)
    if (serviceConfig.historicalData.length > 1440) {
      serviceConfig.historicalData.shift();
    }
  }
  
  // Optimize configuration based on historical data
  optimizeConfig(serviceName) {
    const serviceConfig = this.serviceConfigs.get(serviceName);
    if (!serviceConfig || serviceConfig.historicalData.length < 60) {
      return null;
    }
    
    const historicalData = serviceConfig.historicalData;
    
    // Analyze patterns
    const peakUtilization = Math.max(...historicalData.map(m => m.utilization || 0));
    const avgUtilization = historicalData.reduce((sum, m) => sum + (m.utilization || 0), 0) 
      / historicalData.length;
    const maxWaitingClients = Math.max(...historicalData.map(m => m.waitingClients || 0));
    
    const optimizedConfig = { ...serviceConfig.baseConfig };
    
    // Peak utilization near limit -> increase max size
    if (peakUtilization > 0.9) {
      optimizedConfig.maxSize = Math.min(
        Math.ceil(optimizedConfig.maxSize * 1.2),
        30
      );
    }
    
    // Low average utilization -> decrease min size
    if (avgUtilization < 0.3) {
      optimizedConfig.minSize = Math.max(
        Math.ceil(optimizedConfig.minSize * 0.7),
        2
      );
    }
    
    // Frequent waiting -> increase baseline
    if (maxWaitingClients > 5) {
      optimizedConfig.minSize = Math.min(
        Math.ceil(optimizedConfig.minSize * 1.3),
        optimizedConfig.maxSize - 2
      );
    }
    
    // Update config
    if (JSON.stringify(optimizedConfig) !== JSON.stringify(serviceConfig.baseConfig)) {
      serviceConfig.baseConfig = optimizedConfig;
      serviceConfig.lastUpdated = Date.now();
      
      logger.info('Pool config optimized', {
        service: serviceName,
        newConfig: optimizedConfig,
        analysis: {
          peakUtilization: (peakUtilization * 100).toFixed(1) + '%',
          avgUtilization: (avgUtilization * 100).toFixed(1) + '%',
          maxWaitingClients,
          samples: historicalData.length
        }
      });
    }
    
    return optimizedConfig;
  }
  
  // Batch update configurations
  updateConfigs(updates) {
    for (const [serviceName, newConfig] of Object.entries(updates)) {
      const serviceConfig = this.serviceConfigs.get(serviceName);
      if (serviceConfig) {
        serviceConfig.baseConfig = {
          ...serviceConfig.baseConfig,
          ...newConfig
        };
        serviceConfig.lastUpdated = Date.now();
        
        logger.info('Pool config updated', {
          service: serviceName,
          updates: newConfig
        });
      }
    }
  }
  
  // Get all services status
  getAllStatus() {
    const status = {};
    const currentPeriod = this.getCurrentPeriod();
    
    for (const [serviceName, config] of this.serviceConfigs) {
      const effectiveConfig = this.getConfig(serviceName);
      status[serviceName] = {
        baseConfig: config.baseConfig,
        effectiveConfig,
        lastUpdated: config.lastUpdated,
        historicalDataPoints: config.historicalData.length,
        currentPeriod: currentPeriod.name,
        timeMultiplier: currentPeriod.multiplier
      };
    }
    
    return {
      services: status,
      globalDefaults: this.defaultConfig,
      currentTime: new Date().toISOString()
    };
  }
  
  // Get optimization recommendations
  getRecommendations() {
    const recommendations = [];
    
    for (const [serviceName, config] of this.serviceConfigs) {
      if (config.historicalData.length < 60) continue;
      
      const optimized = this.optimizeConfig(serviceName);
      if (optimized) {
        recommendations.push({
          service: serviceName,
          type: 'config_optimization',
          changes: {
            minSize: `${config.baseConfig.minSize} → ${optimized.minSize}`,
            maxSize: `${config.baseConfig.maxSize} → ${optimized.maxSize}`
          }
        });
      }
    }
    
    return recommendations;
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let instance = null;

function getPoolConfigCenter() {
  if (!instance) {
    instance = new PoolConfigCenter();
  }
  return instance;
}

// ============================================================
// Exports
// ============================================================

module.exports = { PoolConfigCenter, getPoolConfigCenter };
