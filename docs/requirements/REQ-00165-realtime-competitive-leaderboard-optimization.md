# REQ-00165: 实时竞技排行榜优化与热度预测系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00165 |
| 标题 | 实时竞技排行榜优化与热度预测系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、user-service、gym-service、gateway、Redis、backend/shared |
| 创建时间 | 2026-06-13 18:15 |

## 需求描述

当前排行榜系统在高并发场景下存在性能瓶颈，且缺乏对排行榜热度的预测能力。本需求旨在：

1. 优化排行榜查询性能，支持百万级玩家实时排名
2. 实现排行榜热度预测，动态调整缓存策略
3. 支持多维度排行榜（战力、捕捉数、道馆胜率等）
4. 提供排行榜快照与历史趋势分析
5. 减少排行榜更新对数据库的压力

## 技术方案

### 1. Redis Sorted Set 优化架构

```javascript
// backend/shared/leaderboard/OptimizedLeaderboard.js

class OptimizedLeaderboard {
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.options = {
      bucketSize: options.bucketSize || 10000,  // 分桶大小
      cacheExpiry: options.cacheExpiry || 300,   // 缓存过期时间
      maxRetries: options.maxRetries || 3
    };
    this.metrics = new LeaderboardMetrics();
  }

  // 分桶存储优化：避免单个 Sorted Set 过大
  async addToLeaderboard(leaderboardId, userId, score, metadata = {}) {
    const bucketIndex = Math.floor(score / this.options.bucketSize);
    const bucketKey = `lb:${leaderboardId}:bucket:${bucketIndex}`;
    
    const pipeline = this.redis.pipeline();
    
    // 添加到分桶
    pipeline.zadd(bucketKey, score, userId);
    
    // 更新用户元数据
    const metaKey = `lb:${leaderboardId}:meta:${userId}`;
    pipeline.hset(metaKey, {
      score,
      bucket: bucketIndex,
      updatedAt: Date.now(),
      ...metadata
    });
    pipeline.expire(metaKey, 86400 * 30); // 30天过期
    
    // 更新热度计数器
    const heatKey = `lb:${leaderboardId}:heat`;
    pipeline.zincrby(heatKey, 1, userId);
    
    // 发布更新事件
    pipeline.publish('leaderboard:update', JSON.stringify({
      leaderboardId,
      userId,
      score,
      timestamp: Date.now()
    }));
    
    await pipeline.exec();
    
    this.metrics.recordUpdate(leaderboardId);
  }

  // 批量获取排行榜
  async getLeaderboard(leaderboardId, options = {}) {
    const { start = 0, end = 99, withMetadata = true } = options;
    const cacheKey = `lb:${leaderboardId}:cache:${start}-${end}`;
    
    // 尝试从缓存获取
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.metrics.recordCacheHit(leaderboardId);
      return JSON.parse(cached);
    }
    
    // 计算需要查询的分桶范围
    const buckets = await this.getRelevantBuckets(leaderboardId, start, end);
    
    // 并行查询所有分桶
    const pipeline = this.redis.pipeline();
    for (const bucket of buckets) {
      pipeline.zrevrange(`lb:${leaderboardId}:bucket:${bucket}`, 0, -1, 'WITHSCORES');
    }
    
    const results = await pipeline.exec();
    
    // 合并排序结果
    const allEntries = [];
    for (const [err, members] of results) {
      if (!err && members) {
        for (let i = 0; i < members.length; i += 2) {
          allEntries.push({
            userId: members[i],
            score: parseFloat(members[i + 1])
          });
        }
      }
    }
    
    // 排序并切片
    allEntries.sort((a, b) => b.score - a.score);
    const slice = allEntries.slice(start, end + 1);
    
    // 获取元数据
    if (withMetadata && slice.length > 0) {
      const metaPipeline = this.redis.pipeline();
      for (const entry of slice) {
        metaPipeline.hgetall(`lb:${leaderboardId}:meta:${entry.userId}`);
      }
      
      const metaResults = await metaPipeline.exec();
      for (let i = 0; i < slice.length; i++) {
        const [err, meta] = metaResults[i];
        if (!err && meta) {
          slice[i].metadata = meta;
        }
      }
    }
    
    // 缓存结果
    await this.redis.setex(cacheKey, this.options.cacheExpiry, JSON.stringify(slice));
    
    this.metrics.recordCacheMiss(leaderboardId);
    return slice;
  }

  // 获取用户排名（优化版）
  async getUserRank(leaderboardId, userId) {
    // 先获取用户元数据确定分桶
    const meta = await this.redis.hgetall(`lb:${leaderboardId}:meta:${userId}`);
    if (!meta || !meta.bucket) {
      return null;
    }
    
    const bucketKey = `lb:${leaderboardId}:bucket:${meta.bucket}`;
    const bucketRank = await this.redis.zrevrank(bucketKey, userId);
    
    if (bucketRank === null) {
      return null;
    }
    
    // 统计更高分数桶中的用户数
    const totalBuckets = await this.getBucketCount(leaderboardId);
    let usersInHigherBuckets = 0;
    
    for (let i = parseInt(meta.bucket) + 1; i < totalBuckets; i++) {
      const count = await this.redis.zcard(`lb:${leaderboardId}:bucket:${i}`);
      usersInHigherBuckets += count;
    }
    
    return usersInHigherBuckets + bucketRank;
  }

  async getRelevantBuckets(leaderboardId, start, end) {
    // 获取所有分桶键
    const keys = await this.redis.keys(`lb:${leaderboardId}:bucket:*`);
    const buckets = keys.map(k => {
      const match = k.match(/bucket:(\d+)$/);
      return match ? parseInt(match[1]) : 0;
    }).sort((a, b) => b - a); // 降序排序
    
    return buckets;
  }

  async getBucketCount(leaderboardId) {
    const keys = await this.redis.keys(`lb:${leaderboardId}:bucket:*`);
    return keys.length;
  }
}

module.exports = OptimizedLeaderboard;
```

### 2. 热度预测引擎

```javascript
// backend/shared/leaderboard/HeatPredictionEngine.js

class HeatPredictionEngine {
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.options = {
      predictionWindow: options.predictionWindow || 3600000, // 1小时
      minSampleSize: options.minSampleSize || 100,
      modelUpdateInterval: options.modelUpdateInterval || 300000 // 5分钟
    };
    this.models = new Map();
  }

  // 记录访问模式
  async recordAccess(leaderboardId, userId, accessType = 'view') {
    const now = Date.now();
    const hour = new Date(now).getHours();
    const dayOfWeek = new Date(now).getDay();
    
    const key = `lb:heat:${leaderboardId}:access`;
    const pipeline = this.redis.pipeline();
    
    // 按小时记录访问量
    pipeline.hincrby(`${key}:hourly`, hour, 1);
    
    // 按星期记录访问量
    pipeline.hincrby(`${key}:weekly`, dayOfWeek, 1);
    
    // 记录最近访问时间
    pipeline.zadd(`${key}:recent`, now, `${userId}:${accessType}`);
    pipeline.zremrangebyscore(`${key}:recent`, 0, now - 3600000); // 只保留1小时内的
    
    // 访问类型统计
    pipeline.hincrby(`${key}:types`, accessType, 1);
    
    await pipeline.exec();
  }

  // 预测热度
  async predictHeat(leaderboardId) {
    const now = Date.now();
    const hour = new Date(now).getHours();
    const dayOfWeek = new Date(now).getDay();
    
    // 获取历史访问数据
    const [hourlyData, weeklyData, recentAccess] = await Promise.all([
      this.redis.hgetall(`lb:heat:${leaderboardId}:access:hourly`),
      this.redis.hgetall(`lb:heat:${leaderboardId}:access:weekly`),
      this.redis.zcard(`lb:heat:${leaderboardId}:access:recent`)
    ]);
    
    // 计算基础热度
    const currentHourHeat = parseInt(hourlyData[hour] || 0);
    const currentDayHeat = parseInt(weeklyData[dayOfWeek] || 0);
    
    // 计算移动平均
    const hourlyValues = Object.values(hourlyData).map(v => parseInt(v));
    const avgHourly = hourlyValues.reduce((a, b) => a + b, 0) / Math.max(hourlyValues.length, 1);
    
    // 预测算法
    const predictedHeat = {
      current: recentAccess,                    // 当前活跃用户数
      hourlyTrend: currentHourHeat / Math.max(avgHourly, 1),  // 小时趋势
      dailyPattern: currentDayHeat / Math.max(avgHourly * 24, 1), // 日模式
      prediction: 0
    };
    
    // 简单预测模型
    predictedHeat.prediction = 
      recentAccess * 0.4 +                      // 当前活跃度权重
      currentHourHeat * 0.3 +                   // 小时历史权重
      currentDayHeat * 0.3;                     // 日历史权重
    
    // 热度等级分类
    predictedHeat.level = this.classifyHeatLevel(predictedHeat.prediction);
    
    return predictedHeat;
  }

  classifyHeatLevel(score) {
    if (score > 10000) return 'ultra-hot';
    if (score > 5000) return 'hot';
    if (score > 1000) return 'warm';
    if (score > 100) return 'normal';
    return 'cold';
  }

  // 动态调整缓存策略
  async getOptimalCacheStrategy(leaderboardId) {
    const heat = await this.predictHeat(leaderboardId);
    
    const strategies = {
      'ultra-hot': {
        ttl: 60,            // 1分钟缓存
        refreshAhead: true, // 提前刷新
        preload: true,      // 预加载
        maxCacheSize: 1000  // 缓存1000条
      },
      'hot': {
        ttl: 120,
        refreshAhead: true,
        preload: true,
        maxCacheSize: 500
      },
      'warm': {
        ttl: 300,
        refreshAhead: false,
        preload: false,
        maxCacheSize: 200
      },
      'normal': {
        ttl: 600,
        refreshAhead: false,
        preload: false,
        maxCacheSize: 100
      },
      'cold': {
        ttl: 1800,
        refreshAhead: false,
        preload: false,
        maxCacheSize: 50
      }
    };
    
    return {
      heat,
      strategy: strategies[heat.level]
    };
  }

  // 批量预加载热门排行榜
  async preloadHotLeaderboards() {
    // 获取所有排行榜的热度
    const leaderboardKeys = await this.redis.keys('lb:*:heat');
    const preloadTargets = [];
    
    for (const key of leaderboardKeys) {
      const match = key.match(/lb:(.+):heat/);
      if (match) {
        const leaderboardId = match[1];
        const heat = await this.predictHeat(leaderboardId);
        
        if (heat.level === 'ultra-hot' || heat.level === 'hot') {
          preloadTargets.push({
            leaderboardId,
            heat: heat.prediction,
            strategy: await this.getOptimalCacheStrategy(leaderboardId)
          });
        }
      }
    }
    
    // 按热度排序，预加载前N个
    preloadTargets.sort((a, b) => b.heat - a.heat);
    
    return preloadTargets.slice(0, 10);
  }
}

module.exports = HeatPredictionEngine;
```

### 3. 排行榜快照系统

```javascript
// backend/shared/leaderboard/LeaderboardSnapshot.js

class LeaderboardSnapshot {
  constructor(db, redis, options = {}) {
    this.db = db;
    this.redis = redis;
    this.options = {
      retentionDays: options.retentionDays || 90,
      snapshotIntervals: options.snapshotIntervals || ['daily', 'weekly', 'monthly']
    };
  }

  // 创建快照
  async createSnapshot(leaderboardId) {
    const now = new Date();
    const snapshotId = `${leaderboardId}:${now.toISOString().split('T')[0]}`;
    
    // 获取当前排行榜数据
    const leaderboard = new OptimizedLeaderboard(this.redis);
    const topPlayers = await leaderboard.getLeaderboard(leaderboardId, { 
      start: 0, 
      end: 999,
      withMetadata: true 
    });
    
    // 计算统计数据
    const stats = {
      totalPlayers: topPlayers.length,
      avgScore: topPlayers.reduce((sum, p) => sum + p.score, 0) / topPlayers.length,
      maxScore: Math.max(...topPlayers.map(p => p.score)),
      minScore: Math.min(...topPlayers.map(p => p.score)),
      snapshotTime: now
    };
    
    // 存储到数据库
    await this.db.query(`
      INSERT INTO leaderboard_snapshots 
        (snapshot_id, leaderboard_id, snapshot_date, data, stats, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (snapshot_id) DO UPDATE SET
        data = EXCLUDED.data,
        stats = EXCLUDED.stats,
        updated_at = NOW()
    `, [
      snapshotId,
      leaderboardId,
      now.toISOString().split('T')[0],
      JSON.stringify(topPlayers.slice(0, 100)), // 只保存前100名详情
      JSON.stringify(stats),
      now
    ]);
    
    // 清理过期快照
    await this.cleanupOldSnapshots(leaderboardId);
    
    return { snapshotId, stats };
  }

  // 获取历史趋势
  async getHistoryTrend(leaderboardId, userId, days = 30) {
    const result = await this.db.query(`
      SELECT 
        snapshot_date,
        (data->>'rank')::int as rank,
        (data->>'score')::int as score
      FROM leaderboard_snapshots
      CROSS JOIN LATERAL (
        SELECT ordinality - 1 as rank, value
        FROM jsonb_array_elements(data) WITH ORDINALITY
        WHERE value->>'userId' = $2
      ) as user_data
      WHERE leaderboard_id = $1
        AND snapshot_date >= NOW() - INTERVAL '${days} days'
      ORDER BY snapshot_date ASC
    `, [leaderboardId, userId]);
    
    return result.rows;
  }

  // 排名变化分析
  async analyzeRankChanges(leaderboardId, period = 'daily') {
    const snapshots = await this.db.query(`
      SELECT snapshot_date, data
      FROM leaderboard_snapshots
      WHERE leaderboard_id = $1
      ORDER BY snapshot_date DESC
      LIMIT 2
    `, [leaderboardId]);
    
    if (snapshots.rows.length < 2) {
      return { error: 'Insufficient data' };
    }
    
    const [current, previous] = snapshots.rows.map(r => 
      JSON.parse(r.data).map((entry, index) => ({
        ...entry,
        rank: index + 1
      }))
    );
    
    const changes = [];
    const previousMap = new Map(previous.map(p => [p.userId, p]));
    
    for (const player of current) {
      const prev = previousMap.get(player.userId);
      changes.push({
        userId: player.userId,
        currentRank: player.rank,
        previousRank: prev ? prev.rank : null,
        rankChange: prev ? prev.rank - player.rank : 'new',
        scoreChange: prev ? player.score - prev.score : player.score
      });
    }
    
    // 标记最大进步和退步
    changes.sort((a, b) => {
      if (a.rankChange === 'new') return 1;
      if (b.rankChange === 'new') return -1;
      return b.rankChange - a.rankChange;
    });
    
    return {
      topRisers: changes.slice(0, 10),
      topFallers: changes.slice(-10).reverse(),
      newEntries: changes.filter(c => c.rankChange === 'new'),
      totalChanges: changes.filter(c => c.rankChange !== 'new').length
    };
  }

  async cleanupOldSnapshots(leaderboardId) {
    await this.db.query(`
      DELETE FROM leaderboard_snapshots
      WHERE leaderboard_id = $1
        AND created_at < NOW() - INTERVAL '${this.options.retentionDays} days'
    `, [leaderboardId]);
  }
}

module.exports = LeaderboardSnapshot;
```

### 4. 数据库迁移

```sql
-- database/migrations/038_leaderboard_snapshots.sql

CREATE TABLE leaderboard_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_id VARCHAR(255) UNIQUE NOT NULL,
  leaderboard_id VARCHAR(100) NOT NULL,
  snapshot_date DATE NOT NULL,
  data JSONB NOT NULL,
  stats JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_leaderboard_snapshots_lookup 
  ON leaderboard_snapshots(leaderboard_id, snapshot_date DESC);

CREATE INDEX idx_leaderboard_snapshots_date 
  ON leaderboard_snapshots(snapshot_date);

CREATE TABLE leaderboard_access_logs (
  id BIGSERIAL PRIMARY KEY,
  leaderboard_id VARCHAR(100) NOT NULL,
  user_id VARCHAR(100) NOT NULL,
  access_type VARCHAR(50) NOT NULL,
  accessed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_leaderboard_access_logs_leaderboard 
  ON leaderboard_access_logs(leaderboard_id, accessed_at DESC);

-- 分区表（按月）
CREATE TABLE leaderboard_access_logs_partitioned (
  LIKE leaderboard_access_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (accessed_at);

-- 创建最近3个月的分区
CREATE TABLE leaderboard_access_logs_2026_06 
  PARTITION OF leaderboard_access_logs_partitioned
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE leaderboard_access_logs_2026_07 
  PARTITION OF leaderboard_access_logs_partitioned
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE leaderboard_access_logs_2026_08 
  PARTITION OF leaderboard_access_logs_partitioned
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

### 5. social-service 排行榜路由

```javascript
// backend/services/social-service/src/routes/leaderboardOptimized.js

const express = require('express');
const router = express.Router();
const OptimizedLeaderboard = require('../../../shared/leaderboard/OptimizedLeaderboard');
const HeatPredictionEngine = require('../../../shared/leaderboard/HeatPredictionEngine');
const LeaderboardSnapshot = require('../../../shared/leaderboard/LeaderboardSnapshot');

const redis = require('../../../shared/redis');
const db = require('../../../shared/db');

const leaderboard = new OptimizedLeaderboard(redis);
const heatEngine = new HeatPredictionEngine(redis);
const snapshotSystem = new LeaderboardSnapshot(db, redis);

// 获取排行榜（带热度预测）
router.get('/:leaderboardId', async (req, res) => {
  try {
    const { leaderboardId } = req.params;
    const { start = 0, end = 99 } = req.query;
    
    // 记录访问
    await heatEngine.recordAccess(leaderboardId, req.user.id, 'view');
    
    // 获取优化后的缓存策略
    const { heat, strategy } = await heatEngine.getOptimalCacheStrategy(leaderboardId);
    
    // 获取排行榜数据
    const data = await leaderboard.getLeaderboard(leaderboardId, {
      start: parseInt(start),
      end: parseInt(end)
    });
    
    res.json({
      success: true,
      data,
      meta: {
        heat: heat.level,
        cacheStrategy: strategy.ttl
      }
    });
  } catch (error) {
    console.error('Leaderboard fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// 获取用户排名
router.get('/:leaderboardId/rank/:userId', async (req, res) => {
  try {
    const { leaderboardId, userId } = req.params;
    
    const rank = await leaderboard.getUserRank(leaderboardId, userId);
    
    if (rank === null) {
      return res.status(404).json({ error: 'User not in leaderboard' });
    }
    
    res.json({ success: true, rank });
  } catch (error) {
    console.error('Rank fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch rank' });
  }
});

// 获取排名历史趋势
router.get('/:leaderboardId/history/:userId', async (req, res) => {
  try {
    const { leaderboardId, userId } = req.params;
    const { days = 30 } = req.query;
    
    const history = await snapshotSystem.getHistoryTrend(
      leaderboardId, 
      userId, 
      parseInt(days)
    );
    
    res.json({ success: true, history });
  } catch (error) {
    console.error('History fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// 获取排名变化分析
router.get('/:leaderboardId/changes', async (req, res) => {
  try {
    const { leaderboardId } = req.params;
    
    const changes = await snapshotSystem.analyzeRankChanges(leaderboardId);
    
    res.json({ success: true, changes });
  } catch (error) {
    console.error('Changes analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze changes' });
  }
});

// 管理接口：创建快照
router.post('/:leaderboardId/snapshot', async (req, res) => {
  try {
    const { leaderboardId } = req.params;
    
    // 权限检查
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin only' });
    }
    
    const result = await snapshotSystem.createSnapshot(leaderboardId);
    
    res.json({ success: true, snapshot: result });
  } catch (error) {
    console.error('Snapshot creation error:', error);
    res.status(500).json({ error: 'Failed to create snapshot' });
  }
});

module.exports = router;
```

### 6. 定时任务：预加载与快照

```javascript
// backend/jobs/leaderboardTasks.js

const cron = require('node-cron');
const OptimizedLeaderboard = require('../shared/leaderboard/OptimizedLeaderboard');
const HeatPredictionEngine = require('../shared/leaderboard/HeatPredictionEngine');
const LeaderboardSnapshot = require('../shared/leaderboard/LeaderboardSnapshot');

class LeaderboardTaskScheduler {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
    this.heatEngine = new HeatPredictionEngine(redis);
    this.snapshotSystem = new LeaderboardSnapshot(db, redis);
    this.leaderboard = new OptimizedLeaderboard(redis);
  }

  start() {
    // 每5分钟预加载热门排行榜
    cron.schedule('*/5 * * * *', async () => {
      console.log('[Cron] Preloading hot leaderboards...');
      try {
        const targets = await this.heatEngine.preloadHotLeaderboards();
        
        for (const target of targets) {
          await this.leaderboard.getLeaderboard(target.leaderboardId, {
            start: 0,
            end: target.strategy.strategy.maxCacheSize - 1
          });
          console.log(`[Cron] Preloaded ${target.leaderboardId}`);
        }
      } catch (error) {
        console.error('[Cron] Preload error:', error);
      }
    });

    // 每天凌晨创建快照
    cron.schedule('0 0 * * *', async () => {
      console.log('[Cron] Creating daily leaderboard snapshots...');
      try {
        const leaderboardTypes = ['power', 'catches', 'gym_wins', 'battles'];
        
        for (const type of leaderboardTypes) {
          await this.snapshotSystem.createSnapshot(type);
          console.log(`[Cron] Snapshot created for ${type}`);
        }
      } catch (error) {
        console.error('[Cron] Snapshot error:', error);
      }
    });

    // 每小时更新热度模型
    cron.schedule('0 * * * *', async () => {
      console.log('[Cron] Updating heat prediction models...');
      // 训练/更新模型逻辑
    });
  }
}

module.exports = LeaderboardTaskScheduler;
```

## 验收标准

- [ ] 排行榜查询延迟 < 100ms（前100名）
- [ ] 支持百万级玩家排名计算
- [ ] 热度预测准确率 > 80%
- [ ] 缓存命中率 > 90%（热门排行榜）
- [ ] 快照创建成功率 100%
- [ ] 历史趋势数据可追溯 90 天
- [ ] 数据库查询压力降低 70%
- [ ] 内存使用增长 < 20%

## 影响范围

- `backend/shared/leaderboard/` - 新建排行榜优化模块
- `backend/services/social-service/src/routes/` - 排行榜路由
- `database/migrations/` - 快照表和访问日志表
- `backend/jobs/` - 定时任务调度器
- `Redis` - 排行榜数据存储
- `infrastructure/k8s/monitoring/` - 性能监控配置

## 参考

- Redis Sorted Set 性能优化最佳实践
- 时序数据预测算法
- 游戏排行榜系统设计模式
