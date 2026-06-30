/**
 * REQ-00399: 日夜服务
 */
const logger = require('./logger');

class DayNightService {
  constructor(config = {}) {
    this.sunriseHour = config.sunriseHour || 6;
    this.sunsetHour = config.sunsetHour || 18;
  }
  
  getCurrentPhase(date = new Date()) {
    const hour = date.getHours();
    if (hour >= this.sunriseHour && hour < this.sunsetHour) {
      return 'day';
    } else if (hour >= this.sunsetHour && hour < this.sunriseHour + 24) {
      return 'night';
    }
    return 'dawn';
  }
  
  isDay(date = new Date()) {
    return this.getCurrentPhase(date) === 'day';
  }
  
  isNight(date = new Date()) {
    return this.getCurrentPhase(date) === 'night';
  }
  
  getPhaseBonus(phase) {
    const bonuses = {
      day: { spawnBoost: 1.1, encounterTypes: ['normal', 'rare'] },
      night: { spawnBoost: 1.15, encounterTypes: ['ghost', 'dark'] },
      dawn: { spawnBoost: 1.2, encounterTypes: ['normal', 'dawn'] }
    };
    return bonuses[phase] || bonuses.day;
  }
}

module.exports = {
  DayNightService
};