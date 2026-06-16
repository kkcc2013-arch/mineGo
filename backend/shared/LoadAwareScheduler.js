// shared/LoadAwareScheduler.js - Database Load-Aware Connection Scheduler
'use strict';

const promClient = require('prom-client');
const { createLogger } = require('./logger');

const logger = createLogger('load-scheduler');

// ============================================================
// Scheduler Configuration
// ============================================================

const SCHEDULER_CONFIG = {
  // Metrics collection interval
  metricsIntervalMs: 10000,  // 10 seconds
  
  // Load score thresholds
  lowLoadThreshold: 30,
  mediumLoadThreshold: 60,
  highLoadThreshold: 80,
  criticalLoadThreshold: 95,
  
  // Load score weights
  weights: {
    connectionUsage: 0.40,    // 40% weight
    waitingQueries: 0.25,     // 25% weight
    queryLatency: 0.20,       // 20% weight
    errorRate: 0.15           // 15% weight
  },
  
  // Scaling actions
  enableAutoScaling: true,
  scaleUpCooldownMs: 60000,   // 1 minute cooldown
  scaleDownCooldownMs: 180000, // 3 minute cooldown
  
  // Prediction
  enablePrediction: true,
  predictionWindowMinutes: 15,
  historyRetentionHours: 168   // 7 days
};

// ============================================================
// Prometheus Metrics
// ============================================================

const metrics = {
  loadScore: new promClient.Gauge({
    name: 'minego_db_load_score',
    help: 'Database load score (0-100)',
    labelNames: ['service'],
    registers: []
  }),

  loadScoreBreakdown: new promClient.Gauge({
    name: 'minego_db_load_score_breakdown',
    help: 'Load score breakdown by component',
    labelNames: ['service', 'component'],
    registers: []
  }),

  schedulerAction: new promClient.Counter({
    name: 'minego_db_scheduler_action_total',
    help: 'Scheduler actions taken',
    labelNames: ['service', 'action'],
    registers: []
  }),

  predictedLoad: new promClient.Gauge({
    name: 'minego_db_predicted_load',
    help: 'Predicted load score',
    labelNames: ['service', 'minutes_ahead'],
    registers: []
  }),

  connectionRecommendation: new promClient.Gauge({
    name: 'minego_db_connection_recommendation',
    help: 'Recommended connection count',
    labelNames: ['service', 'priority'],
    registers: []
  })
};

// ============================================================
// Load-Aware Scheduler Class
// ============================================================

class LoadAwareScheduler {
  constructor(db, config = {}) {
    this.db = db;
    this.config = { ...SCHEDULER_CONFIG, ...config };
    
    // Current metrics
    this.metrics = {
      activeConnections: 0,
      totalConnections: 0,
      waitingQueries: 0,
      avgQueryTime: 0,
      maxQueryTime: 0,
      errorRate: 0,
      transactionsPerSecond: 0
    };
    
    // Historical data for prediction
    this.history = [];
    this.predictions = new Map();
    
    // Scheduler state
    this.lastScaleUpTime = 0;
    this.lastScaleDownTime = 0;
    this.currentLoadScore = 0;
    
    // Start metrics collection
    if (this.config.enableAutoScaling) {
      this.metricsInterval = setInterval(
        () => this.collectAndAnalyze(),
        this.config.metricsIntervalMs
      );
    }
    
    logger.info('Load-aware scheduler initialized');
  }

  /**
   * Collect metrics from database
   */
  async collectMetrics() {
    try {
      // Get connection stats from pg_stat_activity
      const activityQuery = `
        SELECT 
          count(*) FILTER (WHERE state = 'active') as active,
          count(*) FILTER (WHERE state = 'idle') as idle,
          count(*) FILTER (WHERE wait_event IS NOT NULL) as waiting,
          avg(EXTRACT(epoch FROM (now() - query_start))) 
            FILTER (WHERE state = 'active') as avg_query_time,
          max(EXTRACT(epoch FROM (now() - query_start))) 
            FILTER (WHERE state = 'active') as max_query_time
        FROM pg_stat_activity
        WHERE datname = current_database()
      `;
      
      const activityResult = await this.db.query(activityQuery);
      const activity = activityResult.rows[0];
      
      // Get transaction stats from pg_stat_database
      const dbQuery = `
        SELECT 
          xact_commit + xact_rollback as total_transactions,
          tup_returned + tup_fetched as total_tuples
        FROM pg_stat_database
        WHERE datname = current_database()
      `;
      
      const dbResult = await this.db.query(dbQuery);
      const dbStats = dbResult.rows[0] || {};
      
      // Update metrics
      this.metrics = {
        activeConnections: parseInt(activity.active) || 0,
        totalConnections: (parseInt(activity.active) || 0) + (parseInt(activity.idle) || 0),
        waitingQueries: parseInt(activity.waiting) || 0,
        avgQueryTime: parseFloat(activity.avg_query_time) || 0,
        maxQueryTime: parseFloat(activity.max_query_time) || 0,
        transactionsPerSecond: parseInt(dbStats.total_transactions) || 0,
        timestamp: Date.now()
      };
      
      return this.metrics;
    } catch (err) {
      logger.error({ err }, 'Failed to collect metrics');
      return this.metrics;
    }
  }

  /**
   * Calculate load score (0-100)
   */
  calculateLoadScore() {
    const { weights } = this.config;
    const scores = {};
    
    // 1. Connection usage score (0-100)
    const maxConnections = parseInt(process.env.DB_MAX_CONNECTIONS) || 100;
    scores.connectionUsage = Math.min(
      (this.metrics.activeConnections / maxConnections) * 100,
      100
    );
    
    // 2. Waiting queries score (0-100)
    scores.waitingQueries = Math.min(this.metrics.waitingQueries * 5, 100);
    
    // 3. Query latency score (0-100)
    // Normal query time < 100ms, concerning > 1s
    scores.queryLatency = Math.min(
      (this.metrics.avgQueryTime / 1) * 50,
      100
    );
    
    // 4. Error rate score (0-100)
    scores.errorRate = Math.min(this.metrics.errorRate * 100, 100);
    
    // Weighted average
    const loadScore = 
      scores.connectionUsage * weights.connectionUsage +
      scores.waitingQueries * weights.waitingQueries +
      scores.queryLatency * weights.queryLatency +
      scores.errorRate * weights.errorRate;
    
    // Update metrics
    metrics.loadScore.set({ service: 'database' }, loadScore);
    
    for (const [component, score] of Object.entries(scores)) {
      metrics.loadScoreBreakdown.set(
        { service: 'database', component },
        score
      );
    }
    
    this.currentLoadScore = loadScore;
    this.scoreBreakdown = scores;
    
    return { loadScore, breakdown: scores };
  }

  /**
   * Determine load level
   */
  getLoadLevel() {
    const score = this.currentLoadScore;
    const { lowLoadThreshold, mediumLoadThreshold, highLoadThreshold, criticalLoadThreshold } = this.config;
    
    if (score >= criticalLoadThreshold) {
      return 'CRITICAL';
    } else if (score >= highLoadThreshold) {
      return 'HIGH';
    } else if (score >= mediumLoadThreshold) {
      return 'MEDIUM';
    } else if (score >= lowLoadThreshold) {
      return 'LOW';
    } else {
      return 'IDLE';
    }
  }

  /**
   * Should scale up?
   */
  shouldScaleUp() {
    const now = Date.now();
    const cooldownOk = (now - this.lastScaleUpTime) > this.config.scaleUpCooldownMs;
    const loadHigh = this.currentLoadScore > this.config.highLoadThreshold;
    
    return cooldownOk && loadHigh;
  }

  /**
   * Should scale down?
   */
  shouldScaleDown() {
    const now = Date.now();
    const cooldownOk = (now - this.lastScaleDownTime) > this.config.scaleDownCooldownMs;
    const loadLow = this.currentLoadScore < this.config.lowLoadThreshold;
    
    return cooldownOk && loadLow;
  }

  /**
   * Get recommended connection count
   */
  getRecommendedConnections(priority = 'NORMAL') {
    const loadLevel = this.getLoadLevel();
    const baseConnections = {
      CRITICAL: 10,
      HIGH: 15,
      NORMAL: 20,
      LOW: 5
    };
    
    const multipliers = {
      IDLE: 0.5,
      LOW: 0.75,
      MEDIUM: 1.0,
      HIGH: 1.5,
      CRITICAL: 2.0
    };
    
    const base = baseConnections[priority] || 20;
    const multiplier = multipliers[loadLevel] || 1.0;
    
    const recommended = Math.ceil(base * multiplier);
    
    metrics.connectionRecommendation.set(
      { service: 'database', priority },
      recommended
    );
    
    return recommended;
  }

  /**
   * Record metrics to history for prediction
   */
  recordToHistory() {
    this.history.push({
      timestamp: this.metrics.timestamp,
      loadScore: this.currentLoadScore,
      activeConnections: this.metrics.activeConnections,
      waitingQueries: this.metrics.waitingQueries
    });
    
    // Retain only recent history
    const cutoff = Date.now() - (this.config.historyRetentionHours * 3600000);
    this.history = this.history.filter(h => h.timestamp > cutoff);
  }

  /**
   * Predict future load
   */
  predictLoad(minutesAhead = 15) {
    if (!this.config.enablePrediction || this.history.length < 10) {
      return null;
    }
    
    // Simple moving average prediction
    const recentHistory = this.history.slice(-30); // Last 30 data points
    const avgLoad = recentHistory.reduce((sum, h) => sum + h.loadScore, 0) / recentHistory.length;
    
    // Trend detection
    const half = Math.floor(recentHistory.length / 2);
    const firstHalf = recentHistory.slice(0, half);
    const secondHalf = recentHistory.slice(half);
    
    const firstAvg = firstHalf.reduce((sum, h) => sum + h.loadScore, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, h) => sum + h.loadScore, 0) / secondHalf.length;
    
    const trend = (secondAvg - firstAvg) / half; // Trend per data point
    
    // Predict
    const dataPointsAhead = (minutesAhead * 60000) / this.config.metricsIntervalMs;
    const predictedLoad = Math.max(0, Math.min(100, avgLoad + trend * dataPointsAhead));
    
    this.predictions.set(minutesAhead, predictedLoad);
    
    metrics.predictedLoad.set(
      { service: 'database', minutes_ahead: minutesAhead.toString() },
      predictedLoad
    );
    
    return {
      currentLoad: this.currentLoadScore,
      predictedLoad,
      trend: trend > 0.1 ? 'INCREASING' : trend < -0.1 ? 'DECREASING' : 'STABLE',
      confidence: Math.min(recentHistory.length / 30, 1.0)
    };
  }

  /**
   * Collect metrics and analyze
   */
  async collectAndAnalyze() {
    await this.collectMetrics();
    const { loadScore } = this.calculateLoadScore();
    this.recordToHistory();
    
    // Predict future load
    const prediction = this.predictLoad(this.config.predictionWindowMinutes);
    
    // Take action if needed
    if (this.shouldScaleUp()) {
      this.lastScaleUpTime = Date.now();
      metrics.schedulerAction.inc({ service: 'database', action: 'scale_up' });
      
      logger.info({
        loadScore: loadScore.toFixed(2),
        prediction: prediction?.predictedLoad?.toFixed(2)
      }, 'Scheduler triggered scale up');
      
      this.emit('scale-up', { loadScore, prediction });
    }
    
    if (this.shouldScaleDown()) {
      this.lastScaleDownTime = Date.now();
      metrics.schedulerAction.inc({ service: 'database', action: 'scale_down' });
      
      logger.info({
        loadScore: loadScore.toFixed(2)
      }, 'Scheduler triggered scale down');
      
      this.emit('scale-down', { loadScore });
    }
    
    return {
      loadScore,
      loadLevel: this.getLoadLevel(),
      metrics: this.metrics,
      prediction
    };
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      currentLoadScore: this.currentLoadScore,
      loadLevel: this.getLoadLevel(),
      scoreBreakdown: this.scoreBreakdown,
      metrics: this.metrics,
      predictions: Object.fromEntries(this.predictions),
      recommendations: {
        CRITICAL: this.getRecommendedConnections('CRITICAL'),
        HIGH: this.getRecommendedConnections('HIGH'),
        NORMAL: this.getRecommendedConnections('NORMAL'),
        LOW: this.getRecommendedConnections('LOW')
      },
      lastScaleUp: this.lastScaleUpTime,
      lastScaleDown: this.lastScaleDownTime,
      historySize: this.history.length
    };
  }

  /**
   * Simple event emitter
   */
  on(event, handler) {
    if (!this.handlers) this.handlers = {};
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  emit(event, data) {
    if (!this.handlers?.[event]) return;
    for (const handler of this.handlers[event]) {
      handler(data);
    }
  }

  /**
   * Stop scheduler
   */
  stop() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    logger.info('Load-aware scheduler stopped');
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  LoadAwareScheduler,
  SCHEDULER_CONFIG,
  metrics
};
