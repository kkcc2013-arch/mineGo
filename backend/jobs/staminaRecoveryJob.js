// backend/jobs/staminaRecoveryJob.js
// 精灵体力自然恢复定时任务 - REQ-00172

'use strict';

const { db } = require('../shared/db');
const { createLogger } = require('../shared/logger');
const { staminaService } = require('../services/pokemon-service/src/staminaService');

const logger = createLogger('stamina-recovery-job');

// ============================================================
// 精灵体力自然恢复任务
// ============================================================

class StaminaRecoveryJob {
  
  constructor() {
    this.isRunning = false;
    this.lastRunTime = null;
    this.stats = {
      totalProcessed: 0,
      totalRecovered: 0,
      errors: 0
    };
  }

  /**
   * 执行体力自然恢复
   * 每分钟执行一次
   */
  async run() {
    if (this.isRunning) {
      logger.warn('Stamina recovery job already running, skipping');
      return { success: false, message: 'Job already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info('Starting stamina recovery job');

      // 1. 批量更新所有未满体力的精灵（自然恢复）
      const updateResult = await this.processNaturalRecovery();
      
      // 2. 处理休息站中的精灵恢复
      const restResult = await this.processRestStationRecovery();

      // 3. 更新疲劳等级统计
      await this.updateFatigueStatistics();

      this.lastRunTime = new Date();
      const duration = Date.now() - startTime;

      logger.info({
        duration: `${duration}ms`,
        naturalRecovery: updateResult.rowsUpdated,
        restRecovery: restResult.pokemonRecovered,
        totalRecovered: updateResult.totalRecovered + restResult.totalRecovered
      }, 'Stamina recovery job completed');

      this.stats.totalProcessed += updateResult.rowsUpdated + restResult.pokemonRecovered;
      this.stats.totalRecovered += updateResult.totalRecovered + restResult.totalRecovered;

      return {
        success: true,
        duration,
        naturalRecovery: updateResult,
        restRecovery: restResult
      };

    } catch (error) {
      this.stats.errors++;
      logger.error({ error: error.message }, 'Stamina recovery job failed');
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 处理自然恢复
   */
  async processNaturalRecovery() {
    try {
      // 批量更新所有未满体力的精灵
      const result = await db.raw(`
        UPDATE pokemon 
        SET 
          current_stamina = LEAST(current_stamina + ?, max_stamina),
          fatigue_level = CASE
            WHEN LEAST(current_stamina + ?, max_stamina)::float / max_stamina >= 0.8 THEN 'fresh'
            WHEN LEAST(current_stamina + ?, max_stamina)::float / max_stamina >= 0.5 THEN 'normal'
            WHEN LEAST(current_stamina + ?, max_stamina)::float / max_stamina >= 0.2 THEN 'tired'
            ELSE 'exhausted'
          END,
          last_stamina_update = NOW()
        WHERE current_stamina < max_stamina
        RETURNING id, current_stamina, max_stamina, fatigue_level
      `, [1, 1, 1, 1]); // 每分钟恢复 1 点体力

      const rowsUpdated = result.rowCount || result.rows?.length || 0;
      const totalRecovered = result.rows?.reduce((sum, row) => {
        return sum + Math.min(1, row.max_stamina - (row.current_stamina - 1));
      }, 0) || 0;

      logger.info({ 
        rowsUpdated, 
        totalRecovered 
      }, 'Natural recovery processed');

      return { rowsUpdated, totalRecovered };

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to process natural recovery');
      throw error;
    }
  }

  /**
   * 处理休息站恢复
   */
  async processRestStationRecovery() {
    try {
      // 获取所有正在休息的精灵
      const activeRests = await db('rest_records as rr')
        .join('rest_stations as rs', 'rr.station_id', 'rs.id')
        .join('pokemon as p', 'rr.pokemon_id', 'p.id')
        .where('rr.status', 'active')
        .where('rs.is_active', true)
        .select(
          'rr.id as record_id',
          'rr.pokemon_id',
          'rr.started_at',
          'rr.user_id',
          'rs.recovery_rate',
          'rs.name as station_name',
          'p.current_stamina',
          'p.max_stamina'
        );

      let pokemonRecovered = 0;
      let totalRecovered = 0;

      for (const rest of activeRests) {
        try {
          // 计算从开始到现在应该恢复的体力
          const minutesSinceStart = Math.floor(
            (Date.now() - new Date(rest.started_at)) / 60000
          );

          if (minutesSinceStart <= 0) continue;

          // 每分钟恢复 recovery_rate 点
          const staminaToRecover = Math.min(
            rest.recovery_rate,
            rest.max_stamina - rest.current_stamina
          );

          if (staminaToRecover > 0) {
            await db('pokemon')
              .where({ id: rest.pokemon_id })
              .update({
                current_stamina: db.raw(`LEAST(current_stamina + ?, max_stamina)`, [staminaToRecover]),
                fatigue_level: db.raw(`
                  CASE
                    WHEN LEAST(current_stamina + ?, max_stamina)::float / max_stamina >= 0.8 THEN 'fresh'
                    WHEN LEAST(current_stamina + ?, max_stamina)::float / max_stamina >= 0.5 THEN 'normal'
                    WHEN LEAST(current_stamina + ?, max_stamina)::float / max_stamina >= 0.2 THEN 'tired'
                    ELSE 'exhausted'
                  END
                `, [staminaToRecover, staminaToRecover, staminaToRecover]),
                last_stamina_update: new Date()
              });

            pokemonRecovered++;
            totalRecovered += staminaToRecover;
          }

        } catch (error) {
          logger.error({ 
            error: error.message, 
            recordId: rest.record_id 
          }, 'Failed to process rest recovery for pokemon');
        }
      }

      logger.info({ 
        pokemonRecovered, 
        totalRecovered 
      }, 'Rest station recovery processed');

      return { pokemonRecovered, totalRecovered };

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to process rest station recovery');
      throw error;
    }
  }

  /**
   * 更新疲劳等级统计（用于监控）
   */
  async updateFatigueStatistics() {
    try {
      const stats = await db('pokemon')
        .select('fatigue_level')
        .count('* as count')
        .groupBy('fatigue_level');

      for (const stat of stats) {
        logger.info({
          fatigueLevel: stat.fatigue_level,
          count: parseInt(stat.count, 10)
        }, 'Fatigue level distribution');
      }

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to update fatigue statistics');
    }
  }

  /**
   * 获取任务统计信息
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.stats = {
      totalProcessed: 0,
      totalRecovered: 0,
      errors: 0
    };
  }
}

// ============================================================
// Export
// ============================================================

const staminaRecoveryJob = new StaminaRecoveryJob();

module.exports = {
  StaminaRecoveryJob,
  staminaRecoveryJob
};
