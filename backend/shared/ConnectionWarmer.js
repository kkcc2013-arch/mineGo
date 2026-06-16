// shared/ConnectionWarmer.js - Connection Pool Warmup and Preheating System
'use strict';

const promClient = require('prom-client');
const { createLogger } = require('./logger');

const logger = createLogger('connection-warmer');

// ============================================================
// Warmer Configuration
// ============================================================

const WARMER_CONFIG = {
  // Warmup schedule
  enableScheduledWarmup: true,
  warmupCheckIntervalMs: 60000,    // Check every minute
  warmupLeadTimeMinutes: 15,       // Warm up 15 minutes before peak
  
  // Peak detection
  peakDetectionWindow: 7,          // Analyze last 7 days
  peakThreshold: 0.7,              // Utilization > 70% considered peak
  minPeakDuration: 30,             // Minimum 30 minutes to be considered peak
  
  // Warmup parameters
  warmupRatePerMinute: 5,          // Create 5 connections per minute
  maxWarmupConnections: 20,        // Maximum connections to pre-create
  warmupQuery: 'SELECT 1',         // Query to initialize connections
  
  // Cooldown
  cooldownAfterWarmupMs: 300000    // 5 minutes cooldown
};

// ============================================================
// Prometheus Metrics
// ============================================================

const metrics = {
  warmupEvents: new promClient.Counter({
    name: 'minego_connection_warmup_events_total',
    help: 'Connection warmup events',
    labelNames: ['service', 'priority', 'trigger'],
    registers: []
  }),

  warmupConnections: new promClient.Gauge({
    name: 'minego_connection_warmup_connections',
    help: 'Connections created during warmup',
    labelNames: ['service', 'priority'],
    registers: []
  }),

  peakHoursDetected: new promClient.Gauge({
    name: 'minego_peak_hours_detected',
    help: 'Peak hours detected',
    labelNames: ['service', 'hour'],
    registers: []
  }),

  warmupSchedule: new promClient.Gauge({
    name: 'minego_warmup_schedule',
    help: 'Scheduled warmup target',
    labelNames: ['service', 'hour'],
    registers: []
  })
};

// ============================================================
// Connection Warmer Class
// ============================================================

class ConnectionWarmer {
  constructor(poolManager, db, config = {}) {
    this.poolManager = poolManager;
    this.db = db;
    this.config = { ...WARMER_CONFIG, ...config };
    
    // Peak schedule
    this.peakSchedule = new Map();
    this.warmupSchedule = new Map();
    
    // State
    this.lastWarmupTime = 0;
    this.isWarmingUp = false;
    this.warmupStats = {
      totalWarmups: 0,
      totalConnectionsCreated: 0,
      lastWarmupHour: null
    };
    
    // Start scheduled warmup
    if (this.config.enableScheduledWarmup) {
      this.scheduleInterval = setInterval(
        () => this.checkAndWarmup(),
        this.config.warmupCheckIntervalMs
      );
      
      // Learn from history on startup
      this.learnFromHistory().catch(err => {
        logger.error({ err }, 'Failed to learn from history');
      });
    }
    
    logger.info('Connection warmer initialized');
  }

  /**
   * Learn peak hours from historical data
   */
  async learnFromHistory() {
    try {
      // Query hourly connection stats from last N days
      const query = `
        SELECT 
          EXTRACT(HOUR FROM created_at) as hour,
          AVG(active_connections) as avg_connections,
          MAX(active_connections) as max_connections,
          AVG(utilization) as avg_utilization,
          COUNT(*) as sample_count
        FROM connection_stats
        WHERE created_at > NOW() - INTERVAL '${this.config.peakDetectionWindow} days'
        GROUP BY hour
        ORDER BY hour
      `;
      
      const result = await this.db.query(query);
      
      if (result.rows.length === 0) {
        logger.warn('No historical data found for peak detection');
        return;
      }
      
      // Identify peak hours
      for (const row of result.rows) {
        const hour = parseInt(row.hour);
        const avgUtilization = parseFloat(row.avg_utilization) || 0;
        const maxConnections = parseInt(row.max_connections) || 0;
        
        // Mark as peak if utilization exceeds threshold
        if (avgUtilization > this.config.peakThreshold) {
          this.peakSchedule.set(hour, {
            avgConnections: parseFloat(row.avg_connections),
            maxConnections,
            avgUtilization,
            isPeak: true
          });
          
          metrics.peakHoursDetected.set(
            { service: 'database', hour: hour.toString() },
            1
          );
          
          logger.info({
            hour,
            avgUtilization: (avgUtilization * 100).toFixed(2) + '%',
            maxConnections
          }, 'Peak hour detected');
        }
      }
      
      // Schedule warmups for peak hours
      this.scheduleWarmups();
      
    } catch (err) {
      logger.error({ err }, 'Failed to learn from history');
    }
  }

  /**
   * Schedule warmups before peak hours
   */
  scheduleWarmups() {
    const now = new Date();
    const currentHour = now.getHours();
    
    for (const [peakHour, peakData] of this.peakSchedule) {
      // Warmup N minutes before peak
      const warmupHour = peakHour - Math.ceil(this.config.warmupLeadTimeMinutes / 60);
      const normalizedWarmupHour = warmupHour < 0 ? warmupHour + 24 : warmupHour;
      
      // Calculate target connections (20% buffer above max)
      const targetConnections = Math.ceil(peakData.maxConnections * 1.2);
      
      this.warmupSchedule.set(normalizedWarmupHour, {
        targetConnections,
        peakHour,
        leadTime: this.config.warmupLeadTimeMinutes
      });
      
      metrics.warmupSchedule.set(
        { service: 'database', hour: normalizedWarmupHour.toString() },
        targetConnections
      );
      
      logger.debug({
        warmupHour: normalizedWarmupHour,
        peakHour,
        targetConnections
      }, 'Warmup scheduled');
    }
  }

  /**
   * Check if warmup is needed and execute
   */
  async checkAndWarmup() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    // Check if current hour is scheduled for warmup
    const schedule = this.warmupSchedule.get(currentHour);
    
    if (!schedule) {
      return;
    }
    
    // Check cooldown
    if (Date.now() - this.lastWarmupTime < this.config.cooldownAfterWarmupMs) {
      return;
    }
    
    // Check if already warming up
    if (this.isWarmingUp) {
      return;
    }
    
    // Perform warmup
    await this.performWarmup(schedule);
  }

  /**
   * Perform connection warmup
   */
  async performWarmup(schedule) {
    this.isWarmingUp = true;
    const startTime = Date.now();
    
    try {
      const { targetConnections, peakHour } = schedule;
      
      // Get current pool stats
      const stats = this.poolManager.getStats();
      const currentConnections = Object.values(stats).reduce(
        (sum, s) => sum + (s.total || 0),
        0
      );
      
      const connectionsNeeded = Math.max(0, targetConnections - currentConnections);
      
      if (connectionsNeeded === 0) {
        logger.debug('No warmup needed, connections sufficient');
        this.isWarmingUp = false;
        return;
      }
      
      // Limit connections to create
      const toCreate = Math.min(
        connectionsNeeded,
        this.config.maxWarmupConnections
      );
      
      logger.info({
        currentConnections,
        targetConnections,
        toCreate,
        peakHour
      }, 'Starting connection warmup');
      
      // Create connections gradually
      let created = 0;
      const intervalMs = 60000 / this.config.warmupRatePerMinute;
      
      for (let i = 0; i < toCreate; i++) {
        try {
          // Execute a simple query to create and initialize connection
          await this.db.query(this.config.warmupQuery);
          created++;
          
          // Small delay between connections
          if (i < toCreate - 1) {
            await this.sleep(intervalMs / toCreate);
          }
        } catch (err) {
          logger.warn({ err, index: i }, 'Failed to create connection during warmup');
        }
      }
      
      // Update stats
      this.warmupStats.totalWarmups++;
      this.warmupStats.totalConnectionsCreated += created;
      this.warmupStats.lastWarmupHour = new Date().getHours();
      this.lastWarmupTime = Date.now();
      
      // Record metrics
      metrics.warmupEvents.inc({
        service: 'database',
        priority: 'NORMAL',
        trigger: 'scheduled'
      });
      
      metrics.warmupConnections.set(
        { service: 'database', priority: 'NORMAL' },
        created
      );
      
      const duration = Date.now() - startTime;
      
      logger.info({
        created,
        target: toCreate,
        duration: (duration / 1000).toFixed(2) + 's',
        peakHour
      }, 'Connection warmup completed');
      
    } catch (err) {
      logger.error({ err }, 'Warmup failed');
    } finally {
      this.isWarmingUp = false;
    }
  }

  /**
   * Manual warmup trigger
   */
  async warmupNow(targetConnections, priority = 'NORMAL') {
    const schedule = {
      targetConnections,
      peakHour: new Date().getHours() + 1
    };
    
    await this.performWarmup(schedule);
    
    metrics.warmupEvents.inc({
      service: 'database',
      priority,
      trigger: 'manual'
    });
  }

  /**
   * Get peak schedule
   */
  getPeakSchedule() {
    return {
      peaks: Object.fromEntries(this.peakSchedule),
      warmups: Object.fromEntries(this.warmupSchedule),
      stats: this.warmupStats
    };
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop warmer
   */
  stop() {
    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
      this.scheduleInterval = null;
    }
    logger.info('Connection warmer stopped');
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  ConnectionWarmer,
  WARMER_CONFIG,
  metrics
};
