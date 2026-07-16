// backend/shared/risk-engine/risk-helpers.js - 风控引擎辅助函数
'use strict';

/**
 * 风控引擎辅助函数集合
 * 包含地理计算、统计计算、时间处理等工具函数
 */

/**
 * 计算两点之间的距离（Haversine公式）
 * @param {number} lat1 - 纬度1
 * @param {number} lon1 - 经度1
 * @param {number} lat2 - 纬度2
 * @param {number} lon2 - 经度2
 * @returns {number} 距离（米）
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球半径（米）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 计算移动轨迹的平直度（用于GPS伪造检测）
 * @param {Array} events - 位置事件数组
 * @returns {number} 平直度（0-1，越接近1越平直）
 */
function calculateStraightness(events) {
  if (events.length < 3) return 0;
  
  let totalDeviation = 0;
  let count = 0;
  
  for (let i = 1; i < events.length - 1; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    const next = events[i + 1];
    
    const dist1 = calculateDistance(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
    const dist2 = calculateDistance(curr.latitude, curr.longitude, next.latitude, next.longitude);
    const dist3 = calculateDistance(prev.latitude, prev.longitude, next.latitude, next.longitude);
    
    if (dist1 + dist2 > 0) {
      const deviation = Math.abs(dist3 - dist1 - dist2) / (dist1 + dist2);
      totalDeviation += deviation;
      count++;
    }
  }
  
  return count > 0 ? 1 - (totalDeviation / count) : 0;
}

/**
 * 计算海拔方差（用于GPS伪造检测）
 * @param {Array} events - 位置事件数组
 * @returns {number} 海拔标准差
 */
function calculateAltitudeVariance(events) {
  const altitudes = events
    .filter(e => e.altitude !== undefined && e.altitude !== null)
    .map(e => e.altitude);
  
  if (altitudes.length < 2) return 0;
  
  const mean = altitudes.reduce((a, b) => a + b, 0) / altitudes.length;
  const variance = altitudes.reduce((sum, alt) => sum + Math.pow(alt - mean, 2), 0) / altitudes.length;
  
  return Math.sqrt(variance);
}

/**
 * 计算数值方差
 * @param {Array<number>} values - 数值数组
 * @returns {number} 方差
 */
function calculateVariance(values) {
  if (values.length < 2) return 0;
  
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
}

/**
 * 判断两个时间段是否有重叠
 * @param {Array<number>} times1 - 时间戳数组1
 * @param {Array<number>} times2 - 时间戳数组2
 * @param {number} thresholdMs - 时间阈值（毫秒）
 * @returns {boolean} 是否有重叠
 */
function hasTimeOverlap(times1, times2, thresholdMs) {
  if (times1.length === 0 || times2.length === 0) return false;
  
  const min1 = Math.min(...times1);
  const max1 = Math.max(...times1);
  const min2 = Math.min(...times2);
  const max2 = Math.max(...times2);
  
  return !(max1 + thresholdMs < min2 || max2 + thresholdMs < min1);
}

module.exports = {
  calculateDistance,
  calculateStraightness,
  calculateAltitudeVariance,
  calculateVariance,
  hasTimeOverlap
};