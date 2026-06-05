// shared/NotificationWebSocket.js
// Notification WebSocket server module - REQ-00026
'use strict';

const WebSocket = require('ws');
const { verifyAccess } = require('./auth');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('notification-ws');

// User notification rooms: Map<userId, Set<ws>>
const notificationRooms = new Map();

/**
 * Initialize notification WebSocket server
 * @param {http.Server} server - HTTP server
 * @param {string} path - WebSocket path (default: '/ws/notifications')
 */
function initNotificationWS(server, path = '/ws/notifications') {
  const wss = new WebSocket.Server({ server, path });
  
  wss.on('connection', (ws, req) => {
    // Expect ?token=...
    const params = new URL(req.url, 'http://localhost').searchParams;
    const token = params.get('token');
    
    let userId;
    try {
      const payload = verifyAccess(token);
      userId = payload.sub;
    } catch (err) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    
    ws.userId = userId;
    ws.isAlive = true;
    
    // Add to notification room
    if (!notificationRooms.has(userId)) {
      notificationRooms.set(userId, new Set());
    }
    notificationRooms.get(userId).add(ws);
    
    logger.info({ userId, totalConnections: notificationRooms.get(userId).size }, 
      'User connected to notification WebSocket');
    
    // Update metrics
    metrics.websocketConnectionsActive.inc({ 
      service: 'notification-ws', 
      room: `user:${userId}` 
    });
    
    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        } else if (msg.type === 'PONG') {
          ws.isAlive = true;
        }
      } catch (e) {
        logger.error({ err: e }, 'Failed to parse WebSocket message');
      }
    });
    
    // Handle close
    ws.on('close', () => {
      notificationRooms.get(userId)?.delete(ws);
      metrics.websocketConnectionsActive.dec({ 
        service: 'notification-ws', 
        room: `user:${userId}` 
      });
      
      logger.info({ userId, remainingConnections: notificationRooms.get(userId)?.size || 0 },
        'User disconnected from notification WebSocket');
      
      // Clean up empty rooms
      if (notificationRooms.get(userId)?.size === 0) {
        notificationRooms.delete(userId);
      }
    });
    
    // Handle errors
    ws.on('error', (err) => {
      logger.error({ err, userId }, 'Notification WebSocket error');
    });
  });
  
  // Heartbeat check every 30 seconds
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      
      ws.isAlive = false;
      ws.send(JSON.stringify({ type: 'PING' }));
    });
  }, 30000);
  
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });
  
  logger.info(`Notification WebSocket server initialized on ${path}`);
  
  return wss;
}

/**
 * Send notification to a specific user
 * @param {string} userId - User ID
 * @param {Object} notification - Notification payload
 */
function sendNotificationToUser(userId, notification) {
  const room = notificationRooms.get(userId);
  
  if (!room || room.size === 0) {
    logger.debug({ userId }, 'User not connected to notification WebSocket');
    return false;
  }
  
  const message = JSON.stringify({
    type: 'NOTIFICATION',
    payload: notification,
  });
  
  let sent = 0;
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      sent++;
      metrics.websocketMessagesTotal.inc({ 
        service: 'notification-ws', 
        direction: 'out', 
        type: notification.eventType || 'unknown' 
      });
    }
  }
  
  logger.info({ userId, eventType: notification.eventType, sent }, 
    'Notification sent to user WebSocket');
  
  return sent > 0;
}

/**
 * Send notification to multiple users
 * @param {string[]} userIds - Array of user IDs
 * @param {Object} notification - Notification payload
 */
function broadcastNotification(userIds, notification) {
  const results = [];
  
  for (const userId of userIds) {
    results.push({
      userId,
      sent: sendNotificationToUser(userId, notification),
    });
  }
  
  return results;
}

/**
 * Check if user is connected
 * @param {string} userId - User ID
 */
function isUserConnected(userId) {
  return notificationRooms.has(userId) && notificationRooms.get(userId).size > 0;
}

/**
 * Get all connected users
 */
function getConnectedUsers() {
  return Array.from(notificationRooms.keys());
}

/**
 * Get connection count
 */
function getConnectionCount() {
  let count = 0;
  notificationRooms.forEach(room => {
    count += room.size;
  });
  return count;
}

module.exports = {
  initNotificationWS,
  sendNotificationToUser,
  broadcastNotification,
  isUserConnected,
  getConnectedUsers,
  getConnectionCount,
  notificationRooms,
};
