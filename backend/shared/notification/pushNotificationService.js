// shared/notification/pushNotificationService.js
// 推送通知服务封装 - 供其他模块使用
'use strict';

const NotificationManager = require('./NotificationManager');

// 全局单例实例
let instance = null;

/**
 * 获取 NotificationManager 单例
 */
function getInstance() {
  if (!instance) {
    instance = new NotificationManager();
  }
  return instance;
}

/**
 * 发送推送通知
 * @param {string} userId - 用户ID
 * @param {Object} payload - 推送内容 { title, body, data, type }
 * @param {Object} options - 推送选项
 */
async function sendNotification(userId, payload, options = {}) {
  const manager = getInstance();
  return await manager.send(userId, payload, options);
}

/**
 * 发送交易确认通知
 * @param {string} userId - 用户ID
 * @param {Object} tradeInfo - 交易信息
 */
async function sendTradeConfirmation(userId, tradeInfo) {
  return await sendNotification(userId, {
    type: 'trade_confirmation',
    title: '交易确认',
    body: `您有一笔交易待确认: ${tradeInfo.description || '物品交换'}`,
    data: { tradeId: tradeInfo.tradeId, action: 'confirm' }
  });
}

/**
 * 发送交易完成通知
 * @param {string} userId - 用户ID
 * @param {Object} tradeInfo - 交易信息
 */
async function sendTradeCompleted(userId, tradeInfo) {
  return await sendNotification(userId, {
    type: 'trade_completed',
    title: '交易完成',
    body: `交易已完成: ${tradeInfo.description || '物品交换'}`,
    data: { tradeId: tradeInfo.tradeId }
  });
}

/**
 * 发送交易取消通知
 * @param {string} userId - 用户ID
 * @param {Object} tradeInfo - 交易信息
 */
async function sendTradeCancelled(userId, tradeInfo) {
  return await sendNotification(userId, {
    type: 'trade_cancelled',
    title: '交易取消',
    body: `交易已被取消: ${tradeInfo.description || '物品交换'}`,
    data: { tradeId: tradeInfo.tradeId, reason: tradeInfo.reason }
  });
}

/**
 * 发送安全警告通知
 * @param {string} userId - 用户ID
 * @param {Object} warning - 警告信息
 */
async function sendSecurityWarning(userId, warning) {
  return await sendNotification(userId, {
    type: 'security_warning',
    title: '安全警告',
    body: warning.message,
    data: { riskLevel: warning.riskLevel, details: warning.details },
    priority: 'high'
  }, { ttl: 3600 });
}

module.exports = {
  getInstance,
  sendNotification,
  sendTradeConfirmation,
  sendTradeCompleted,
  sendTradeCancelled,
  sendSecurityWarning
};