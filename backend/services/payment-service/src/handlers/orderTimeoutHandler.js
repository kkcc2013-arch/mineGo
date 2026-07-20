'use strict';

const { getDelayQueue } = require('../../../../shared/DelayQueue');
const { createLogger } = require('../../../../shared/logger');
const { incrementCounter } = require('../../../../shared/metrics');

const logger = createLogger('order-timeout-handler');

/**
 * Initialize order timeout handler
 * Unpaid orders are cancelled after 30 minutes
 */
async function initOrderTimeoutHandler() {
  const delayQueue = getDelayQueue({ clientId: 'payment-service' });
  
  await delayQueue.registerHandler('order.timeout', async (payload, task) => {
    logger.info({ orderId: payload.orderId }, 'Processing order timeout check');
    
    try {
      // Check and cancel expired order
      const result = await cancelExpiredOrder(payload.orderId);
      
      if (result.cancelled) {
        incrementCounter('payment_orders_timeout_cancelled_total', 1, {
          reason: 'timeout',
        });
        
        logger.info({ 
          orderId: payload.orderId,
          cancelled: true,
        }, 'Expired order cancelled');
      } else {
        logger.info({ 
          orderId: payload.orderId,
          cancelled: false,
          reason: result.reason,
        }, 'Order timeout check - order already processed');
      }
      
    } catch (err) {
      logger.error({ 
        err, 
        orderId: payload.orderId,
      }, 'Failed to process order timeout');
      throw err;
    }
  });
  
  logger.info('Order timeout handler initialized');
}

/**
 * Schedule order timeout check
 * @param {string} orderId - Order ID
 * @param {number} timeoutMs - Timeout in milliseconds (default 30 minutes)
 */
async function scheduleOrderTimeout(orderId, timeoutMs = 30 * 60 * 1000) {
  const delayQueue = getDelayQueue({ clientId: 'payment-service' });
  
  const result = await delayQueue.schedule('order.timeout', {
    orderId,
  }, {
    delay: timeoutMs,        // Default 30 minutes
    priority: 'critical',    // Critical for payment integrity
    maxRetries: 3,           // Limited retries for timeouts
    metadata: {
      scheduledAt: new Date().toISOString(),
      timeoutMs,
    },
  });
  
  logger.info({ 
    orderId, 
    taskId: result.taskId,
    timeoutMs,
  }, 'Order timeout scheduled');
  
  return result;
}

/**
 * Cancel expired order
 * This would integrate with payment-service order management
 */
async function cancelExpiredOrder(orderId) {
  // This is a placeholder - actual implementation would:
  // 1. Check order status in database
  // 2. If still pending, cancel it
  // 3. Release any held inventory/reservations
  // 4. Send notification to user
  
  logger.debug({ orderId }, 'Checking order for timeout cancellation');
  
  // Simulate order check
  // In production, this would call:
  // const order = await orderRepository.findById(orderId);
  // if (order.status === 'pending') {
  //   await orderRepository.update(orderId, { status: 'cancelled', cancelledAt: new Date() });
  //   return { cancelled: true };
  // }
  // return { cancelled: false, reason: 'already_processed' };
  
  return { cancelled: true, orderId };
}

/**
 * Cancel scheduled timeout check
 * Call this when order is paid before timeout
 * @param {string} taskId - Task ID to cancel
 */
async function cancelOrderTimeout(taskId) {
  logger.info({ taskId }, 'Order timeout cancellation requested');
  
  // In production, this would:
  // 1. Remove task from delay queue
  // 2. Update task status in database
}

/**
 * Extend order timeout
 * @param {string} orderId - Order ID
 * @param {number} additionalMs - Additional time in milliseconds
 */
async function extendOrderTimeout(orderId, additionalMs) {
  const delayQueue = getDelayQueue({ clientId: 'payment-service' });
  
  // Schedule new timeout with extended time
  const result = await delayQueue.schedule('order.timeout', {
    orderId,
    extended: true,
  }, {
    delay: additionalMs,
    priority: 'critical',
    maxRetries: 3,
  });
  
  logger.info({ 
    orderId, 
    taskId: result.taskId,
    additionalMs,
  }, 'Order timeout extended');
  
  return result;
}

module.exports = { 
  initOrderTimeoutHandler, 
  scheduleOrderTimeout,
  cancelExpiredOrder,
  cancelOrderTimeout,
  extendOrderTimeout,
};
