/**
 * REQ-00399: 季节服务
 */
const logger = require('./logger');

const SEASONS = {
  SPRING: 'spring',
  SUMMER: 'summer',
  AUTUMN: 'autumn',
  WINTER: 'winter'
};

class SeasonService {
  constructor() {
    this.currentSeason = this.calculateSeason(new Date());
  }
  
  calculateSeason(date) {
    const month = date.getMonth();
    if (month >= 2 && month <= 4) return SEASONS.SPRING;
    if (month >= 5 && month <= 7) return SEASONS.SUMMER;
    if (month >= 8 && month <= 10) return SEASONS.AUTUMN;
    return SEASONS.WINTER;
  }
  
  getCurrentSeason() {
    return this.currentSeason;
  }
  
  getSeasonBonuses(season) {
    const bonuses = {
      [SEASONS.SPRING]: { spawnBoost: 1.1, weatherTypes: ['rain', 'sunny'] },
      [SEASONS.SUMMER]: { spawnBoost: 1.2, weatherTypes: ['sunny', 'hot'] },
      [SEASONS.AUTUMN]: { spawnBoost: 1.0, weatherTypes: ['windy', 'rain'] },
      [SEASONS.WINTER]: { spawnBoost: 0.9, weatherTypes: ['snow', 'cold'] }
    };
    return bonuses[season] || bonuses[SEASONS.SPRING];
  }
}

module.exports = {
  SeasonService,
  SEASONS
};