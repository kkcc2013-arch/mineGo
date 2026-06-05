// backend/gateway/src/routes/admin.js
'use strict';
const express = require('express');
const { getAllStatus, resetCircuitBreaker, resetAllCircuitBreakers } = require('../circuitBreakers');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('gateway:admin');
const router = express.Router();

/**
 * GET /admin/circuit-breakers
 * 
 * Get status of all circuit breakers
 */
router.get('/circuit-breakers', requireAuth, (req, res, next) => {
  try {
    const status = getAllStatus();
    
    // Calculate summary
    const summary = {
      total: Object.keys(status).length,
      open: 0,
      closed: 0,
      halfOpen: 0
    };
    
    for (const [name, cb] of Object.entries(status)) {
      if (cb.state === 'OPEN') summary.open++;
      else if (cb.state === 'CLOSED') summary.closed++;
      else if (cb.state === 'HALF_OPEN') summary.halfOpen++;
    }
    
    res.json(successResp({
      summary,
      circuitBreakers: status,
      timestamp: new Date().toISOString()
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/circuit-breakers/:service
 * 
 * Get status of a specific circuit breaker
 */
router.get('/circuit-breakers/:service', requireAuth, (req, res, next) => {
  try {
    const status = getAllStatus();
    const serviceStatus = status[req.params.service];
    
    if (!serviceStatus) {
      throw new AppError(4041, `Circuit breaker for service '${req.params.service}' not found`, 404);
    }
    
    res.json(successResp(serviceStatus));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/circuit-breakers/:service/reset
 * 
 * Manually reset a circuit breaker
 */
router.post('/circuit-breakers/:service/reset', requireAuth, (req, res, next) => {
  try {
    const serviceName = req.params.service;
    const success = resetCircuitBreaker(serviceName);
    
    if (!success) {
      throw new AppError(4041, `Circuit breaker for service '${serviceName}' not found`, 404);
    }
    
    logger.info({
      service: serviceName,
      userId: req.user.sub
    }, 'Circuit breaker manually reset');
    
    const status = getAllStatus();
    
    res.json(successResp({
      message: `Circuit breaker for '${serviceName}' has been reset`,
      service: serviceName,
      status: status[serviceName]
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/circuit-breakers/reset-all
 * 
 * Reset all circuit breakers
 */
router.post('/circuit-breakers/reset-all', requireAuth, (req, res, next) => {
  try {
    resetAllCircuitBreakers();
    
    logger.info({
      userId: req.user.sub
    }, 'All circuit breakers manually reset');
    
    const status = getAllStatus();
    
    res.json(successResp({
      message: 'All circuit breakers have been reset',
      circuitBreakers: status
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/health
 * 
 * Comprehensive health check including circuit breaker status
 */
router.get('/health', (req, res, next) => {
  try {
    const cbStatus = getAllStatus();
    
    // Determine overall health
    let healthy = true;
    const issues = [];
    
    for (const [name, cb] of Object.entries(cbStatus)) {
      if (cb.state === 'OPEN') {
        healthy = false;
        issues.push({
          service: name,
          issue: 'Circuit breaker is OPEN',
          nextAttemptIn: cb.nextAttemptIn
        });
      }
    }
    
    res.json({
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      circuitBreakers: {
        total: Object.keys(cbStatus).length,
        open: issues.length,
        details: cbStatus
      },
      issues: issues.length > 0 ? issues : undefined
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/stats
 * 
 * Get aggregated statistics across all circuit breakers
 */
router.get('/stats', requireAuth, (req, res, next) => {
  try {
    const status = getAllStatus();
    
    const stats = {
      services: {},
      totals: {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        rejectedCalls: 0
      }
    };
    
    for (const [name, cb] of Object.entries(status)) {
      stats.services[name] = {
        state: cb.state,
        totalCalls: cb.stats.totalCalls,
        successfulCalls: cb.stats.successfulCalls,
        failedCalls: cb.stats.failedCalls,
        rejectedCalls: cb.stats.rejectedCalls,
        successRate: cb.stats.totalCalls > 0 
          ? (cb.stats.successfulCalls / cb.stats.totalCalls * 100).toFixed(2) + '%'
          : 'N/A',
        lastFailure: cb.stats.lastFailure,
        lastSuccess: cb.stats.lastSuccess
      };
      
      stats.totals.totalCalls += cb.stats.totalCalls;
      stats.totals.successfulCalls += cb.stats.successfulCalls;
      stats.totals.failedCalls += cb.stats.failedCalls;
      stats.totals.rejectedCalls += cb.stats.rejectedCalls;
    }
    
    stats.totals.successRate = stats.totals.totalCalls > 0
      ? (stats.totals.successfulCalls / stats.totals.totalCalls * 100).toFixed(2) + '%'
      : 'N/A';
    
    res.json(successResp(stats));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
