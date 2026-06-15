# REQ-00230: 精灵经验值获取历史与成长轨迹追踪系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00230 |
| 标题 | 精灵经验值获取历史与成长轨迹追踪系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-15 20:00 |

## 需求描述

精灵经验值获取历史与成长轨迹追踪系统用于记录和分析精灵的经验值获取历程，为玩家提供可视化的成长轨迹、经验来源分析、成长趋势预测等功能。该系统让玩家能够深入了解每只精灵的成长历史，增强游戏的养成体验和情感连接。

### 核心功能
1. **经验获取记录**：详细记录每次经验值获取事件（来源、数量、时间、地点）
2. **成长轨迹可视化**：图表展示经验值累计曲线、成长里程碑
3. **经验来源分析**：统计不同来源的经验占比（捕捉、战斗、道具、活动等）
4. **成长预测**：基于历史数据预测进化时间、等级提升时间
5. **成长报告**：生成周期性成长总结报告

### 业务价值
- 增强玩家对精灵的情感连接
- 提供养成策略的数据支持
- 增加游戏深度和可玩性
- 为活动设计提供数据参考

## 技术方案

### 1. 数据库设计

```sql
-- 经验获取历史表
CREATE TABLE pokemon_exp_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- 经验详情
  exp_amount INTEGER NOT NULL CHECK (exp_amount > 0),
  source_type VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'item', 'event', 'quest', 'trade', 'breeding'
  source_id VARCHAR(100), -- 关联的来源ID（如battle_id, item_id, event_id）
  
  -- 上下文信息
  level_before INTEGER NOT NULL,
  level_after INTEGER NOT NULL,
  exp_before INTEGER NOT NULL,
  exp_after INTEGER NOT NULL,
  
  -- 时间空间
  gained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  location_name VARCHAR(200),
  
  -- 元数据
  metadata JSONB DEFAULT '{}', -- 扩展信息（如战斗对手、道具类型等）
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX idx_exp_history_pokemon ON pokemon_exp_history(pokemon_instance_id, gained_at DESC);
CREATE INDEX idx_exp_history_user ON pokemon_exp_history(user_id, gained_at DESC);
CREATE INDEX idx_exp_history_source ON pokemon_exp_history(source_type, gained_at DESC);
CREATE INDEX idx_exp_history_time ON pokemon_exp_history(gained_at DESC);

-- 分区策略（按月分区）
CREATE TABLE pokemon_exp_history_2026_06 PARTITION OF pokemon_exp_history
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- 成长里程碑表
CREATE TABLE pokemon_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- 里程碑类型
  milestone_type VARCHAR(50) NOT NULL, -- 'level_up', 'evolution', 'exp_million', 'battle_hundred'
  milestone_name VARCHAR(200) NOT NULL,
  description TEXT,
  
  -- 达成信息
  achieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot_data JSONB DEFAULT '{}', -- 达成时的快照数据
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(pokemon_instance_id, milestone_type, JSONB_HASH(snapshot_data))
);

CREATE INDEX idx_milestones_pokemon ON pokemon_milestones(pokemon_instance_id, achieved_at DESC);
CREATE INDEX idx_milestones_type ON pokemon_milestones(milestone_type);

-- 成长统计汇总表（每日汇总）
CREATE TABLE pokemon_growth_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat_date DATE NOT NULL,
  
  -- 当日统计
  total_exp_gained INTEGER DEFAULT 0,
  exp_sources JSONB DEFAULT '{}', -- {'catch': 100, 'battle': 500, ...}
  level_ups INTEGER DEFAULT 0,
  battles_count INTEGER DEFAULT 0,
  
  -- 累计快照
  cumulative_exp INTEGER DEFAULT 0,
  current_level INTEGER NOT NULL,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(pokemon_instance_id, stat_date)
);

CREATE INDEX idx_growth_stats_pokemon ON pokemon_growth_stats(pokemon_instance_id, stat_date DESC);
CREATE INDEX idx_growth_stats_date ON pokemon_growth_stats(stat_date DESC);
```

### 2. 后端服务实现

```javascript
// pokemon-service/src/routes/expHistory.js
'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const ExpHistoryService = require('../services/ExpHistoryService');

const logger = createLogger('exp-history');

/**
 * 记录经验获取事件
 */
async function recordExpGain(pokemonInstanceId, userId, expData) {
  try {
    const result = await query(`
      INSERT INTO pokemon_exp_history (
        pokemon_instance_id, user_id, exp_amount, source_type, source_id,
        level_before, level_after, exp_before, exp_after,
        location_lat, location_lng, location_name, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      pokemonInstanceId, userId, expData.amount, expData.sourceType, expData.sourceId,
      expData.levelBefore, expData.levelAfter, expData.expBefore, expData.expAfter,
      expData.locationLat, expData.locationLng, expData.locationName, expData.metadata || {}
    ]);
    
    // 异步更新成长统计
    ExpHistoryService.updateDailyStats(pokemonInstanceId, userId, expData).catch(err => {
      logger.error({ err, pokemonInstanceId }, 'Failed to update daily stats');
    });
    
    return result.rows[0];
  } catch (err) {
    logger.error({ err, pokemonInstanceId }, 'Failed to record exp gain');
    throw err;
  }
}

/**
 * 获取精灵经验历史
 * GET /pokemon/:id/exp-history
 */
router.get('/:id/exp-history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const pokemonId = req.params.id;
    const { 
      limit = 50, 
      offset = 0,
      sourceType,
      startDate,
      endDate 
    } = req.query;
    
    // 验证所有权
    const { rows: [pokemon] } = await query(
      'SELECT id FROM pokemon_instances WHERE id = $1 AND user_id = $2',
      [pokemonId, userId]
    );
    if (!pokemon) {
      throw new AppError(3001, '精灵不存在或无权访问', 404);
    }
    
    const history = await ExpHistoryService.getExpHistory(pokemonId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      sourceType,
      startDate,
      endDate
    });
    
    res.json(successResp(history));
  } catch (err) {
    next(err);
  }
});

/**
 * 获取成长轨迹可视化数据
 * GET /pokemon/:id/growth-trajectory
 */
router.get('/:id/growth-trajectory', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const pokemonId = req.params.id;
    const { period = '30d' } = req.query; // 7d, 30d, 90d, 1y, all
    
    const trajectory = await ExpHistoryService.getGrowthTrajectory(pokemonId, userId, period);
    
    res.json(successResp(trajectory));
  } catch (err) {
    next(err);
  }
});

/**
 * 获取经验来源分析
 * GET /pokemon/:id/exp-sources-analysis
 */
router.get('/:id/exp-sources-analysis', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const pokemonId = req.params.id;
    
    const analysis = await ExpHistoryService.getExpSourcesAnalysis(pokemonId, userId);
    
    res.json(successResp(analysis));
  } catch (err) {
    next(err);
  }
});

/**
 * 获取成长里程碑
 * GET /pokemon/:id/milestones
 */
router.get('/:id/milestones', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const pokemonId = req.params.id;
    
    const milestones = await ExpHistoryService.getMilestones(pokemonId, userId);
    
    res.json(successResp(milestones));
  } catch (err) {
    next(err);
  }
});

/**
 * 获取成长预测
 * GET /pokemon/:id/growth-prediction
 */
router.get('/:id/growth-prediction', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const pokemonId = req.params.id;
    const { targetLevel, targetExp } = req.query;
    
    const prediction = await ExpHistoryService.predictGrowth(
      pokemonId, 
      userId, 
      targetLevel ? parseInt(targetLevel) : null,
      targetExp ? parseInt(targetExp) : null
    );
    
    res.json(successResp(prediction));
  } catch (err) {
    next(err);
  }
});

/**
 * 生成成长报告
 * GET /pokemon/:id/growth-report
 */
router.get('/:id/growth-report', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const pokemonId = req.params.id;
    const { reportType = 'weekly' } = req.query; // daily, weekly, monthly
    
    const report = await ExpHistoryService.generateGrowthReport(pokemonId, userId, reportType);
    
    res.json(successResp(report));
  } catch (err) {
    next(err);
  }
});

module.exports = { router, recordExpGain };
```

### 3. 经验历史服务

```javascript
// pokemon-service/src/services/ExpHistoryService.js
'use strict';
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { getJSON, setJSON } = require('../../../shared/redis');

const logger = createLogger('exp-history-service');

class ExpHistoryService {
  /**
   * 获取经验历史列表
   */
  static async getExpHistory(pokemonId, options = {}) {
    const { limit = 50, offset = 0, sourceType, startDate, endDate } = options;
    
    let sql = `
      SELECT 
        id, exp_amount, source_type, source_id,
        level_before, level_after, exp_before, exp_after,
        gained_at, location_name, metadata
      FROM pokemon_exp_history
      WHERE pokemon_instance_id = $1
    `;
    const params = [pokemonId];
    let paramIndex = 2;
    
    if (sourceType) {
      sql += ` AND source_type = $${paramIndex++}`;
      params.push(sourceType);
    }
    if (startDate) {
      sql += ` AND gained_at >= $${paramIndex++}`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND gained_at <= $${paramIndex++}`;
      params.push(endDate);
    }
    
    sql += ` ORDER BY gained_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);
    
    const { rows } = await query(sql, params);
    
    // 获取总数
    let countSql = 'SELECT COUNT(*)::int as total FROM pokemon_exp_history WHERE pokemon_instance_id = $1';
    const countParams = [pokemonId];
    paramIndex = 2;
    
    if (sourceType) {
      countSql += ` AND source_type = $${paramIndex++}`;
      countParams.push(sourceType);
    }
    if (startDate) {
      countSql += ` AND gained_at >= $${paramIndex++}`;
      countParams.push(startDate);
    }
    if (endDate) {
      countSql += ` AND gained_at <= $${paramIndex++}`;
      countParams.push(endDate);
    }
    
    const { rows: [{ total }] } = await query(countSql, countParams);
    
    return {
      items: rows,
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total
    };
  }
  
  /**
   * 获取成长轨迹（用于可视化）
   */
  static async getGrowthTrajectory(pokemonId, userId, period) {
    // 验证所有权
    await this.verifyOwnership(pokemonId, userId);
    
    // 计算时间范围
    const { startDate, endDate } = this.calculateDateRange(period);
    
    // 获取每日统计数据
    const { rows } = await query(`
      SELECT 
        stat_date,
        total_exp_gained,
        exp_sources,
        level_ups,
        battles_count,
        cumulative_exp,
        current_level
      FROM pokemon_growth_stats
      WHERE pokemon_instance_id = $1
        AND stat_date >= $2
        AND stat_date <= $3
      ORDER BY stat_date ASC
    `, [pokemonId, startDate, endDate]);
    
    // 构建轨迹数据
    const trajectory = {
      period,
      startDate,
      endDate,
      dataPoints: rows.map(row => ({
        date: row.stat_date,
        dailyExp: row.total_exp_gained,
        cumulativeExp: row.cumulative_exp,
        level: row.current_level,
        levelUps: row.level_ups,
        battles: row.battles_count,
        sources: row.exp_sources
      })),
      summary: {
        totalExpGained: rows.reduce((sum, r) => sum + r.total_exp_gained, 0),
        totalLevelUps: rows.reduce((sum, r) => sum + r.level_ups, 0),
        totalBattles: rows.reduce((sum, r) => sum + r.battles_count, 0),
        avgDailyExp: rows.length > 0 
          ? Math.round(rows.reduce((sum, r) => sum + r.total_exp_gained, 0) / rows.length)
          : 0
      }
    };
    
    return trajectory;
  }
  
  /**
   * 获取经验来源分析
   */
  static async getExpSourcesAnalysis(pokemonId, userId) {
    await this.verifyOwnership(pokemonId, userId);
    
    // 尝试从缓存获取
    const cacheKey = `exp:analysis:${pokemonId}`;
    const cached = await getJSON(cacheKey);
    if (cached) return cached;
    
    const { rows } = await query(`
      SELECT 
        source_type,
        COUNT(*)::int as count,
        SUM(exp_amount) as total_exp,
        AVG(exp_amount)::int as avg_exp,
        MAX(exp_amount) as max_exp,
        MIN(exp_amount) as min_exp
      FROM pokemon_exp_history
      WHERE pokemon_instance_id = $1
      GROUP BY source_type
      ORDER BY total_exp DESC
    `, [pokemonId]);
    
    // 计算总计
    const totalExp = rows.reduce((sum, r) => sum + parseInt(r.total_exp), 0);
    
    const analysis = {
      sources: rows.map(r => ({
        type: r.source_type,
        count: r.count,
        totalExp: parseInt(r.total_exp),
        avgExp: r.avg_exp,
        maxExp: r.max_exp,
        minExp: r.min_exp,
        percentage: totalExp > 0 ? Math.round((parseInt(r.total_exp) / totalExp) * 100) : 0
      })),
      totalExp,
      topSource: rows[0]?.source_type || null,
      mostFrequent: rows.sort((a, b) => b.count - a.count)[0]?.source_type || null
    };
    
    // 缓存1小时
    await setJSON(cacheKey, analysis, 3600);
    
    return analysis;
  }
  
  /**
   * 获取成长里程碑
   */
  static async getMilestones(pokemonId, userId) {
    await this.verifyOwnership(pokemonId, userId);
    
    const { rows } = await query(`
      SELECT 
        id, milestone_type, milestone_name, description,
        achieved_at, snapshot_data
      FROM pokemon_milestones
      WHERE pokemon_instance_id = $1
      ORDER BY achieved_at DESC
    `, [pokemonId]);
    
    return {
      total: rows.length,
      milestones: rows
    };
  }
  
  /**
   * 预测成长时间
   */
  static async predictGrowth(pokemonId, userId, targetLevel, targetExp) {
    await this.verifyOwnership(pokemonId, userId);
    
    // 获取当前状态
    const { rows: [pokemon] } = await query(`
      SELECT level, exp, exp_to_next_level, species_id
      FROM pokemon_instances
      WHERE id = $1
    `, [pokemonId]);
    
    if (!pokemon) {
      throw new Error('Pokemon not found');
    }
    
    // 获取最近30天的平均日经验
    const { rows: [stats] } = await query(`
      SELECT 
        AVG(total_exp_gained)::int as avg_daily_exp,
        STDDEV(total_exp_gained)::int as std_daily_exp
      FROM pokemon_growth_stats
      WHERE pokemon_instance_id = $1
        AND stat_date >= CURRENT_DATE - INTERVAL '30 days'
    `, [pokemonId]);
    
    const avgDailyExp = stats?.avg_daily_exp || 100; // 默认值
    
    let targetExpTotal;
    if (targetLevel) {
      // 计算到达目标等级需要的总经验（简化计算）
      const levelDiff = targetLevel - pokemon.level;
      targetExpTotal = levelDiff * 1000; // 实际应根据等级曲线计算
    } else if (targetExp) {
      targetExpTotal = targetExp - pokemon.exp;
    } else {
      // 默认预测下一级
      targetExpTotal = pokemon.exp_to_next_level;
    }
    
    const daysToTarget = avgDailyExp > 0 
      ? Math.ceil(targetExpTotal / avgDailyExp)
      : null;
    
    return {
      currentLevel: pokemon.level,
      currentExp: pokemon.exp,
      targetLevel,
      targetExp: targetExpTotal,
      avgDailyExp,
      estimatedDays: daysToTarget,
      estimatedDate: daysToTarget 
        ? new Date(Date.now() + daysToTarget * 24 * 60 * 60 * 1000).toISOString()
        : null,
      confidence: stats?.std_daily_exp 
        ? Math.max(0, 100 - (stats.std_daily_exp / avgDailyExp) * 50)
        : 50
    };
  }
  
  /**
   * 生成成长报告
   */
  static async generateGrowthReport(pokemonId, userId, reportType) {
    await this.verifyOwnership(pokemonId, userId);
    
    const { startDate, endDate } = this.calculateReportRange(reportType);
    
    // 获取统计数据
    const { rows: stats } = await query(`
      SELECT 
        SUM(total_exp_gained) as total_exp,
        SUM(level_ups) as level_ups,
        SUM(battles_count) as battles,
        COUNT(*) as active_days
      FROM pokemon_growth_stats
      WHERE pokemon_instance_id = $1
        AND stat_date >= $2
        AND stat_date <= $3
    `, [pokemonId, startDate, endDate]);
    
    // 获取里程碑
    const { rows: milestones } = await query(`
      SELECT milestone_type, milestone_name, achieved_at
      FROM pokemon_milestones
      WHERE pokemon_instance_id = $1
        AND achieved_at >= $2
        AND achieved_at <= $3
      ORDER BY achieved_at DESC
    `, [pokemonId, startDate, endDate]);
    
    // 获取经验来源分布
    const sourceAnalysis = await this.getExpSourcesAnalysis(pokemonId, userId);
    
    return {
      reportType,
      period: { start: startDate, end: endDate },
      summary: {
        totalExpGained: parseInt(stats[0]?.total_exp || 0),
        levelUps: parseInt(stats[0]?.level_ups || 0),
        totalBattles: parseInt(stats[0]?.battles || 0),
        activeDays: parseInt(stats[0]?.active_days || 0)
      },
      milestones,
      topSources: sourceAnalysis.sources.slice(0, 5),
      generatedAt: new Date().toISOString()
    };
  }
  
  /**
   * 更新每日统计
   */
  static async updateDailyStats(pokemonId, userId, expData) {
    const today = new Date().toISOString().split('T')[0];
    
    await query(`
      INSERT INTO pokemon_growth_stats (
        pokemon_instance_id, user_id, stat_date,
        total_exp_gained, exp_sources, level_ups,
        cumulative_exp, current_level
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (pokemon_instance_id, stat_date) DO UPDATE SET
        total_exp_gained = pokemon_growth_stats.total_exp_gained + $4,
        exp_sources = pokemon_growth_stats.exp_sources || $5,
        level_ups = pokemon_growth_stats.level_ups + $6,
        cumulative_exp = $7,
        current_level = $8,
        updated_at = NOW()
    `, [
      pokemonId, userId, today,
      expData.amount,
      JSON.stringify({ [expData.sourceType]: expData.amount }),
      expData.levelAfter > expData.levelBefore ? 1 : 0,
      expData.expAfter,
      expData.levelAfter
    ]);
  }
  
  /**
   * 计算日期范围
   */
  static calculateDateRange(period) {
    const now = new Date();
    let startDate, endDate = now.toISOString().split('T')[0];
    
    switch (period) {
      case '7d':
        startDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        break;
      case '30d':
        startDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        break;
      case '90d':
        startDate = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        break;
      case '1y':
        startDate = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        break;
      case 'all':
      default:
        startDate = '2000-01-01';
    }
    
    return { startDate, endDate };
  }
  
  /**
   * 计算报告范围
   */
  static calculateReportRange(reportType) {
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    let startDate;
    
    switch (reportType) {
      case 'daily':
        startDate = endDate;
        break;
      case 'weekly':
        startDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        break;
      case 'monthly':
      default:
        startDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }
    
    return { startDate, endDate };
  }
  
  /**
   * 验证所有权
   */
  static async verifyOwnership(pokemonId, userId) {
    const { rows: [pokemon] } = await query(
      'SELECT id FROM pokemon_instances WHERE id = $1 AND user_id = $2',
      [pokemonId, userId]
    );
    if (!pokemon) {
      throw new Error('Pokemon not found or access denied');
    }
  }
}

module.exports = ExpHistoryService;
```

### 4. 前端组件

```javascript
// game-client/src/components/ExpHistoryPanel.js
'use strict';
import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts';
import './ExpHistoryPanel.css';

const SOURCE_COLORS = {
  catch: '#4CAF50',
  battle: '#F44336',
  item: '#2196F3',
  event: '#FF9800',
  quest: '#9C27B0',
  trade: '#00BCD4',
  breeding: '#E91E63'
};

export function ExpHistoryPanel({ pokemonId }) {
  const [history, setHistory] = useState([]);
  const [trajectory, setTrajectory] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [activeTab, setActiveTab] = useState('trajectory');
  const [period, setPeriod] = useState('30d');
  
  useEffect(() => {
    loadExpData();
  }, [pokemonId, period]);
  
  async function loadExpData() {
    try {
      const [historyRes, trajectoryRes, analysisRes, predictionRes] = await Promise.all([
        fetch(`/api/pokemon/${pokemonId}/exp-history?limit=20`),
        fetch(`/api/pokemon/${pokemonId}/growth-trajectory?period=${period}`),
        fetch(`/api/pokemon/${pokemonId}/exp-sources-analysis`),
        fetch(`/api/pokemon/${pokemonId}/growth-prediction`)
      ]);
      
      const historyData = await historyRes.json();
      const trajectoryData = await trajectoryRes.json();
      const analysisData = await analysisRes.json();
      const predictionData = await predictionRes.json();
      
      setHistory(historyData.data?.items || []);
      setTrajectory(trajectoryData.data);
      setAnalysis(analysisData.data);
      setPrediction(predictionData.data);
    } catch (err) {
      console.error('Failed to load exp data:', err);
    }
  }
  
  return (
    <div className="exp-history-panel">
      <div className="panel-header">
        <h2>成长轨迹</h2>
        <div className="period-selector">
          {['7d', '30d', '90d', '1y'].map(p => (
            <button 
              key={p}
              className={period === p ? 'active' : ''}
              onClick={() => setPeriod(p)}
            >
              {p === '7d' ? '7天' : p === '30d' ? '30天' : p === '90d' ? '90天' : '一年'}
            </button>
          ))}
        </div>
      </div>
      
      <div className="tab-nav">
        <button 
          className={activeTab === 'trajectory' ? 'active' : ''}
          onClick={() => setActiveTab('trajectory')}
        >
          成长曲线
        </button>
        <button 
          className={activeTab === 'sources' ? 'active' : ''}
          onClick={() => setActiveTab('sources')}
        >
          来源分析
        </button>
        <button 
          className={activeTab === 'history' ? 'active' : ''}
          onClick={() => setActiveTab('history')}
        >
          历史记录
        </button>
        <button 
          className={activeTab === 'prediction' ? 'active' : ''}
          onClick={() => setActiveTab('prediction')}
        >
          成长预测
        </button>
      </div>
      
      <div className="tab-content">
        {activeTab === 'trajectory' && trajectory && (
          <div className="trajectory-view">
            <div className="summary-cards">
              <div className="summary-card">
                <div className="value">{trajectory.summary.totalExpGained.toLocaleString()}</div>
                <div className="label">总经验</div>
              </div>
              <div className="summary-card">
                <div className="value">{trajectory.summary.totalLevelUps}</div>
                <div className="label">升级次数</div>
              </div>
              <div className="summary-card">
                <div className="value">{trajectory.summary.avgDailyExp.toLocaleString()}</div>
                <div className="label">日均经验</div>
              </div>
            </div>
            
            <div className="chart-container">
              <LineChart data={trajectory.dataPoints} width={600} height={300}>
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="cumulativeExp" stroke="#8884d8" name="累计经验" />
              </LineChart>
            </div>
          </div>
        )}
        
        {activeTab === 'sources' && analysis && (
          <div className="sources-view">
            <div className="pie-chart-container">
              <PieChart width={300} height={300}>
                <Pie
                  data={analysis.sources}
                  dataKey="totalExp"
                  nameKey="type"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label
                >
                  {analysis.sources.map((entry, index) => (
                    <Cell key={index} fill={SOURCE_COLORS[entry.type] || '#999'} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </div>
            
            <div className="sources-list">
              {analysis.sources.map((source, idx) => (
                <div key={idx} className="source-item">
                  <div className="source-color" style={{ backgroundColor: SOURCE_COLORS[source.type] }} />
                  <div className="source-info">
                    <div className="source-name">{getSourceName(source.type)}</div>
                    <div className="source-stats">
                      {source.totalExp.toLocaleString()} EXP ({source.percentage}%)
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {activeTab === 'history' && (
          <div className="history-list">
            {history.map((item, idx) => (
              <div key={idx} className="history-item">
                <div className="exp-amount">+{item.exp_amount}</div>
                <div className="exp-info">
                  <div className="source-type">{getSourceName(item.source_type)}</div>
                  <div className="exp-location">{item.location_name || '未知地点'}</div>
                </div>
                <div className="exp-time">
                  {new Date(item.gained_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
        
        {activeTab === 'prediction' && prediction && (
          <div className="prediction-view">
            <div className="current-status">
              <div className="status-item">
                <span className="label">当前等级</span>
                <span className="value">Lv.{prediction.currentLevel}</span>
              </div>
              <div className="status-item">
                <span className="label">当前经验</span>
                <span className="value">{prediction.currentExp.toLocaleString()}</span>
              </div>
            </div>
            
            <div className="prediction-card">
              <h3>升级预测</h3>
              <div className="prediction-result">
                <div className="estimated-days">预计 {prediction.estimatedDays} 天</div>
                <div className="estimated-date">
                  到达日期: {prediction.estimatedDate ? new Date(prediction.estimatedDate).toLocaleDateString() : '无法预测'}
                </div>
                <div className="confidence">
                  置信度: {Math.round(prediction.confidence)}%
                </div>
              </div>
            </div>
            
            <div className="avg-exp-info">
              基于最近30天日均经验: {prediction.avgDailyExp.toLocaleString()} EXP
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getSourceName(type) {
  const names = {
    catch: '捕捉',
    battle: '战斗',
    item: '道具',
    event: '活动',
    quest: '任务',
    trade: '交易',
    breeding: '培育'
  };
  return names[type] || type;
}
```

## 验收标准

- [ ] 数据库表创建成功，索引和分区策略正确配置
- [ ] 经验获取事件记录功能正常工作
- [ ] 成长轨迹可视化数据正确计算和返回
- [ ] 经验来源分析准确，百分比计算正确
- [ ] 成长里程碑正确识别和记录
- [ ] 成长预测算法合理，置信度计算有意义
- [ ] 周期性成长报告生成功能正常
- [ ] 前端图表正确展示轨迹和分析数据
- [ ] 缓存策略有效，减少数据库查询
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] API 响应时间 < 200ms（P95）

## 影响范围

- 新增文件：
  - `database/migrations/YYYYMMDD_create_exp_history_tables.sql`
  - `backend/services/pokemon-service/src/routes/expHistory.js`
  - `backend/services/pokemon-service/src/services/ExpHistoryService.js`
  - `frontend/game-client/src/components/ExpHistoryPanel.js`
  - `frontend/game-client/src/components/ExpHistoryPanel.css`
  - `backend/tests/unit/expHistoryService.test.js`

- 修改文件：
  - `backend/services/pokemon-service/src/index.js`（挂载路由）
  - `backend/services/catch-service/src/catchService.js`（集成经验记录）
  - `backend/services/gym-service/src/teamBattleService.js`（集成经验记录）
  - 多个经验获取模块

## 参考

- 相关需求：REQ-00216 精灵经验值动态调整与智能加速系统
- 相关需求：REQ-00065 精灵进化与成长系统
- 技术参考：PostgreSQL 分区表文档
- 可视化库：Recharts (https://recharts.org/)
