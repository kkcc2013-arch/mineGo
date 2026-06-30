/**
 * REQ-00399: 告警管理器
 */
const logger = require('./logger');

class AlertManager {
  constructor(config = {}) {
    this.alertRules = [];
    this.alertHistory = [];
    this.notificationChannel = config.notificationChannel || 'log';
  }
  
  addRule(rule) {
    this.alertRules.push({
      id: rule.id || `rule_${Date.now()}`,
      name: rule.name,
      condition: rule.condition,
      severity: rule.severity || 'warning',
      enabled: true
    });
  }
  
  checkAlerts(metrics) {
    for (const rule of this.alertRules) {
      if (rule.enabled && rule.condition(metrics)) {
        this.triggerAlert(rule, metrics);
      }
    }
  }
  
  triggerAlert(rule, data) {
    const alert = {
      ruleId: rule.id,
      name: rule.name,
      severity: rule.severity,
      data,
      timestamp: new Date().toISOString()
    };
    
    this.alertHistory.push(alert);
    
    if (this.notificationChannel === 'log') {
      logger.warn({
        module: 'AlertManager',
        alert,
        msg: `Alert triggered: ${rule.name}`
      });
    }
    
    return alert;
  }
  
  getAlertHistory(limit = 100) {
    return this.alertHistory.slice(-limit);
  }
}

module.exports = {
  AlertManager
};