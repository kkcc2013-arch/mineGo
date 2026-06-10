# REQ-00074: 玩家排行榜系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00074 |
| 标题 | 玩家排行榜系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、user-service、pokemon-service、gym-service、gateway、game-client、Redis、database/migrations |
| 创建时间 | 2026-06-10 10:00 |

## 需求描述

实现完整的玩家排行榜系统，支持多维度排名、实时更新、赛季机制、奖励发放，提升玩家竞争意识和社交互动。

### 核心功能
1. **多维度排行榜**
   - 捕捉数量榜（总捕捉数、稀有精灵数）
   - 战斗实力榜（道馆胜率、PVP积分）
   - 图鉴完成榜（图鉴完成度、闪光收集数）
   - 公会贡献榜（公会积分、团队活动贡献）

2. **赛季机制**
   - 赛季周期配置（每周/每月/季度）
   - 赛季重置与历史记录
   - 赛季专属称号与奖励

3. **实时排名更新**
   - 捕捉事件触发排名更新
   - 战斗结果实时同步
   - 排名变化通知

4. **社交功能**
   - 好友专属排行榜
   - 附近玩家排名
   - 排名变化动态推送

## 技术方案

### 1. 数据库设计

```sql
-- 排行榜类型枚举
CREATE TYPE leaderboard_type AS ENUM (
  'catch_total',        -- 捕捉总数榜
  'catch_rare',         -- 稀有捕捉榜
  'battle_pvp',         -- PVP积分榜
  'battle_gym',         -- 道馆战斗榜
  'pokedex_completion', -- 图鉴完成榜
  'shiny_collection',   -- 闪光收集榜
  'guild_contribution'  -- 公会贡献榜
);

-- 排行榜主表
CREATE TABLE leaderboards (
  id SERIAL PRIMARY KEY,
  leaderboard_type leaderboard_type NOT NULL,
  season_id INTEGER REFERENCES seasons(id),
  player_id INTEGER REFERENCES users(id),
  score BIGINT NOT NULL DEFAULT 0,
  rank INTEGER,
  previous_rank INTEGER,
  metadata JSONB DEFAULT '{}', -- 额外统计信息
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(leaderboard_type, season_id, player_id)
);

-- 赛季表
CREATE TABLE seasons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  leaderboard_type leaderboard_type NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- active, ended
  rewards JSONB DEFAULT '[]', -- 奖励配置
  created_at TIMESTAMP DEFAULT NOW()
);

-- 排名历史记录
CREATE TABLE leaderboard_history (
  id SERIAL PRIMARY KEY,
  season_id INTEGER REFERENCES seasons(id),
  player_id INTEGER REFERENCES users(id),
  leaderboard_type leaderboard_type NOT NULL,
  final_rank INTEGER NOT NULL,
  final_score BIGINT NOT NULL,
  rewards_claimed BOOLEAN DEFAULT FALSE,
  rewards_claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_leaderboards_type_season ON leaderboards(leaderboard_type, season_id);
CREATE INDEX idx_leaderboards_score ON leaderboards(leaderboard_type, season_id, score DESC);
CREATE INDEX idx_leaderboards_player ON leaderboards(player_id);
CREATE INDEX idx_seasons_active ON seasons(status, end_time);
```

### 2. Redis 排行榜缓存

```javascript
// backend/shared/leaderboardCache.js

const Redis = require('ioredis');
const { promisify } = require('util');

class LeaderboardCache {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  /**
   * 生成排行榜 Redis Key
   */
  getKey(leaderboardType, seasonId) {
    return `leaderboard:${leaderboardType}:season:${seasonId}`;
  }

  /**
   * 更新玩家分数
   */
  async updateScore(leaderboardType, seasonId, playerId, score) {
    const key = this.getKey(leaderboardType, seasonId);
    await this.redis.zadd(key, score, playerId.toString());
    
    // 设置过期时间（赛季结束后 7 天）
    const ttl = 7 * 24 * 60 * 60;
    await this.redis.expire(key, ttl);
    
    // 获取新排名
    const rank = await this.redis.zrevrank(key, playerId.toString());
    return rank + 1; // Redis 排名从 0 开始
  }

  /**
   * 增加玩家分数
   */
  async incrementScore(leaderboardType, seasonId, playerId, increment) {
    const key = this.getKey(leaderboardType, seasonId);
    const newScore = await this.redis.zincrby(key, increment, playerId.toString());
    
    const rank = await this.redis.zrevrank(key, playerId.toString());
    return {
      score: parseInt(newScore),
      rank: rank + 1
    };
  }

  /**
   * 获取玩家排名
   */
  async getPlayerRank(leaderboardType, seasonId, playerId) {
    const key = this.getKey(leaderboardType, seasonId);
    const [rank, score] = await Promise.all([
      this.redis.zrevrank(key, playerId.toString()),
      this.redis.zscore(key, playerId.toString())
    ]);
    
    return {
      rank: rank !== null ? rank + 1 : null,
      score: score ? parseInt(score) : 0
    };
  }

  /**
   * 获取排行榜前 N 名
   */
  async getTopPlayers(leaderboardType, seasonId, limit = 100) {
    const key = this.getKey(leaderboardType, seasonId);
    const results = await this.redis.zrevrange(key, 0, limit - 1, 'WITHSCORES');
    
    const players = [];
    for (let i = 0; i < results.length; i += 2) {
      players.push({
        rank: Math.floor(i / 2) + 1,
        playerId: parseInt(results[i]),
        score: parseInt(results[i + 1])
      });
    }
    
    return players;
  }

  /**
   * 获取玩家附近排名
   */
  async getPlayersAround(leaderboardType, seasonId, playerId, range = 5) {
    const key = this.getKey(leaderboardType, seasonId);
    const playerRank = await this.redis.zrevrank(key, playerId.toString());
    
    if (playerRank === null) return [];
    
    const start = Math.max(0, playerRank - range);
    const end = playerRank + range;
    
    const results = await this.redis.zrevrange(key, start, end, 'WITHSCORES');
    
    const players = [];
    for (let i = 0; i < results.length; i += 2) {
      players.push({
        rank: start + Math.floor(i / 2) + 1,
        playerId: parseInt(results[i]),
        score: parseInt(results[i + 1])
      });
    }
    
    return players;
  }

  /**
   * 批量同步数据库到 Redis
   */
  async syncFromDatabase(leaderboardType, seasonId, players) {
    const key = this.getKey(leaderboardType, seasonId);
    const pipeline = this.redis.pipeline();
    
    for (const player of players) {
      pipeline.zadd(key, player.score, player.playerId.toString());
    }
    
    await pipeline.exec();
    await this.redis.expire(key, 7 * 24 * 60 * 60);
  }
}

module.exports = LeaderboardCache;
```

### 3. 排行榜服务

```javascript
// backend/services/social-service/src/leaderboardService.js

const { Pool } = require('pg');
const LeaderboardCache = require('../../shared/leaderboardCache');
const { getRedisClient } = require('../../shared/redis');
const { publishEvent } = require('../../shared/EventBus');

class LeaderboardService {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.cache = new LeaderboardCache(getRedisClient());
  }

  /**
   * 获取当前赛季
   */
  async getCurrentSeason(leaderboardType) {
    const result = await this.db.query(`
      SELECT * FROM seasons 
      WHERE leaderboard_type = $1 
        AND status = 'active' 
        AND start_time <= NOW() 
        AND end_time > NOW()
      ORDER BY start_time DESC
      LIMIT 1
    `, [leaderboardType]);
    
    return result.rows[0] || null;
  }

  /**
   * 更新玩家分数（捕捉触发）
   */
  async onCatchEvent(userId, rarity) {
    const season = await this.getCurrentSeason('catch_total');
    if (!season) return;

    // 更新捕捉总数榜
    const totalResult = await this.cache.incrementScore(
      'catch_total', 
      season.id, 
      userId, 
      1
    );

    // 更新稀有捕捉榜
    if (rarity === 'rare' || rarity === 'legendary') {
      await this.cache.incrementScore(
        'catch_rare',
        season.id,
        userId,
        rarity === 'legendary' ? 10 : 1
      );
    }

    // 同步到数据库
    await this.syncToDatabase('catch_total', season.id, userId, totalResult.score);

    // 检查排名变化通知
    await this.checkRankChange(userId, 'catch_total', totalResult.rank);
  }

  /**
   * 更新战斗积分
   */
  async onBattleResult(userId, isWin, points) {
    const season = await this.getCurrentSeason('battle_pvp');
    if (!season) return;

    const result = await this.cache.incrementScore(
      'battle_pvp',
      season.id,
      userId,
      isWin ? points : -Math.floor(points * 0.3)
    );

    await this.syncToDatabase('battle_pvp', season.id, userId, result.score);
    await this.checkRankChange(userId, 'battle_pvp', result.rank);
  }

  /**
   * 检查排名变化并通知
   */
  async checkRankChange(userId, leaderboardType, newRank) {
    const key = `rank_change:${leaderboardType}:${userId}`;
    const oldRank = await this.cache.redis.get(key);
    
    if (oldRank && parseInt(oldRank) !== newRank) {
      const change = parseInt(oldRank) - newRank;
      
      if (change > 0 && newRank <= 100) {
        // 排名上升且进入前 100，发送通知
        await publishEvent('leaderboard.rank_up', {
          userId,
          leaderboardType,
          oldRank: parseInt(oldRank),
          newRank,
          change
        });
      }
    }
    
    await this.cache.redis.setex(key, 3600, newRank.toString());
  }

  /**
   * 同步到数据库
   */
  async syncToDatabase(leaderboardType, seasonId, userId, score) {
    await this.db.query(`
      INSERT INTO leaderboards (leaderboard_type, season_id, player_id, score, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (leaderboard_type, season_id, player_id)
      DO UPDATE SET score = $4, updated_at = NOW()
    `, [leaderboardType, seasonId, userId, score]);
  }

  /**
   * 获取排行榜
   */
  async getLeaderboard(leaderboardType, options = {}) {
    const {
      limit = 100,
      aroundPlayer = null,
      seasonId = null
    } = options;

    const season = seasonId 
      ? await this.getSeasonById(seasonId)
      : await this.getCurrentSeason(leaderboardType);

    if (!season) {
      throw new Error('No active season found');
    }

    let players;
    if (aroundPlayer) {
      players = await this.cache.getPlayersAround(
        leaderboardType,
        season.id,
        aroundPlayer,
        5
      );
    } else {
      players = await this.cache.getTopPlayers(
        leaderboardType,
        season.id,
        limit
      );
    }

    // 批量获取玩家信息
    const playerIds = players.map(p => p.playerId);
    const userInfo = await this.getUserInfoBatch(playerIds);

    return {
      season,
      players: players.map(p => ({
        ...p,
        ...userInfo[p.playerId]
      }))
    };
  }

  /**
   * 批量获取用户信息
   */
  async getUserInfoBatch(userIds) {
    if (userIds.length === 0) return {};
    
    const result = await this.db.query(`
      SELECT id, username, avatar, level
      FROM users
      WHERE id = ANY($1)
    `, [userIds]);
    
    const infoMap = {};
    for (const row of result.rows) {
      infoMap[row.id] = {
        username: row.username,
        avatar: row.avatar,
        level: row.level
      };
    }
    
    return infoMap;
  }

  /**
   * 结算赛季
   */
  async settleSeason(seasonId) {
    const season = await this.getSeasonById(seasonId);
    if (!season) throw new Error('Season not found');

    // 获取最终排名
    const topPlayers = await this.cache.getTopPlayers(
      season.leaderboard_type,
      seasonId,
      1000
    );

    // 保存历史记录
    for (const player of topPlayers) {
      await this.db.query(`
        INSERT INTO leaderboard_history 
          (season_id, player_id, leaderboard_type, final_rank, final_score)
        VALUES ($1, $2, $3, $4, $5)
      `, [seasonId, player.playerId, season.leaderboard_type, player.rank, player.score]);
    }

    // 更新赛季状态
    await this.db.query(`
      UPDATE seasons SET status = 'ended' WHERE id = $1
    `, [seasonId]);

    // 发送赛季结算通知
    await publishEvent('leaderboard.season_end', {
      seasonId,
      leaderboardType: season.leaderboard_type,
      topPlayers: topPlayers.slice(0, 100)
    });
  }
}

module.exports = LeaderboardService;
```

### 4. API 路由

```javascript
// backend/services/social-service/src/routes/leaderboard.js

const express = require('express');
const router = express.Router();
const LeaderboardService = require('../leaderboardService');
const { authMiddleware } = require('../../shared/authMiddleware');

const leaderboardService = new LeaderboardService();

/**
 * 获取排行榜
 * GET /api/leaderboard/:type
 */
router.get('/:type', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const { limit, aroundMe, seasonId } = req.query;

    const validTypes = [
      'catch_total', 'catch_rare', 'battle_pvp', 'battle_gym',
      'pokedex_completion', 'shiny_collection', 'guild_contribution'
    ];

    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid leaderboard type' });
    }

    const result = await leaderboardService.getLeaderboard(type, {
      limit: parseInt(limit) || 100,
      aroundPlayer: aroundMe === 'true' ? req.user.id : null,
      seasonId: seasonId ? parseInt(seasonId) : null
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取玩家排名
 * GET /api/leaderboard/:type/rank
 */
router.get('/:type/rank', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const userId = req.user.id;

    const season = await leaderboardService.getCurrentSeason(type);
    if (!season) {
      return res.status(404).json({ error: 'No active season' });
    }

    const rankInfo = await leaderboardService.cache.getPlayerRank(
      type,
      season.id,
      userId
    );

    res.json({
      success: true,
      data: {
        season,
        ...rankInfo
      }
    });
  } catch (error) {
    console.error('Get player rank error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取赛季历史
 * GET /api/leaderboard/:type/seasons
 */
router.get('/:type/seasons', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const { limit = 10 } = req.query;

    const result = await leaderboardService.db.query(`
      SELECT * FROM seasons
      WHERE leaderboard_type = $1
      ORDER BY start_time DESC
      LIMIT $2
    `, [type, parseInt(limit)]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Get seasons error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 领取赛季奖励
 * POST /api/leaderboard/:seasonId/claim
 */
router.post('/:seasonId/claim', authMiddleware, async (req, res) => {
  try {
    const { seasonId } = req.params;
    const userId = req.user.id;

    // 检查是否已领取
    const history = await leaderboardService.db.query(`
      SELECT * FROM leaderboard_history
      WHERE season_id = $1 AND player_id = $2
    `, [seasonId, userId]);

    if (!history.rows[0]) {
      return res.status(404).json({ error: 'No record found for this season' });
    }

    const record = history.rows[0];
    if (record.rewards_claimed) {
      return res.status(400).json({ error: 'Rewards already claimed' });
    }

    // 获取赛季奖励配置
    const season = await leaderboardService.getSeasonById(seasonId);
    const rewards = season.rewards[record.final_rank - 1];

    if (!rewards) {
      return res.status(404).json({ error: 'No rewards for this rank' });
    }

    // 发放奖励
    await publishEvent('leaderboard.claim_rewards', {
      userId,
      rewards,
      seasonId,
      rank: record.final_rank
    });

    // 更新领取状态
    await leaderboardService.db.query(`
      UPDATE leaderboard_history
      SET rewards_claimed = TRUE, rewards_claimed_at = NOW()
      WHERE season_id = $1 AND player_id = $2
    `, [seasonId, userId]);

    res.json({
      success: true,
      data: { rewards, rank: record.final_rank }
    });
  } catch (error) {
    console.error('Claim rewards error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### 5. 前端组件

```javascript
// frontend/game-client/src/components/Leaderboard.js

import { apiClient } from '../api/client';

export class Leaderboard {
  constructor(container) {
    this.container = container;
    this.currentType = 'catch_total';
    this.isLoading = false;
    this.init();
  }

  async init() {
    this.render();
    await this.loadLeaderboard();
  }

  render() {
    this.container.innerHTML = `
      <div class="leaderboard-container">
        <div class="leaderboard-header">
          <h2>🏆 排行榜</h2>
          <div class="leaderboard-tabs">
            <button class="tab-btn active" data-type="catch_total">捕捉榜</button>
            <button class="tab-btn" data-type="battle_pvp">PVP榜</button>
            <button class="tab-btn" data-type="pokedex_completion">图鉴榜</button>
            <button class="tab-btn" data-type="shiny_collection">闪光榜</button>
          </div>
        </div>
        
        <div class="my-rank-card" id="myRank"></div>
        
        <div class="leaderboard-content">
          <div class="top-three" id="topThree"></div>
          <div class="rank-list" id="rankList"></div>
        </div>
        
        <div class="loading-overlay" id="loading" style="display: none;">
          <div class="spinner"></div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  bindEvents() {
    this.container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.currentType = e.target.dataset.type;
        this.loadLeaderboard();
      });
    });
  }

  async loadLeaderboard() {
    if (this.isLoading) return;
    this.isLoading = true;
    this.showLoading(true);

    try {
      const response = await apiClient.get(`/leaderboard/${this.currentType}`, {
        params: { limit: 100, aroundMe: 'true' }
      });

      const { season, players } = response.data.data;
      
      this.renderTopThree(players.slice(0, 3));
      this.renderRankList(players.slice(3));
      await this.renderMyRank();
    } catch (error) {
      console.error('Load leaderboard error:', error);
      this.showError('加载排行榜失败');
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }

  renderTopThree(topPlayers) {
    const container = document.getElementById('topThree');
    
    if (topPlayers.length === 0) {
      container.innerHTML = '<p class="no-data">暂无数据</p>';
      return;
    }

    const medals = ['🥇', '🥈', '🥉'];
    const positions = ['first', 'second', 'third'];

    container.innerHTML = topPlayers.map((player, index) => `
      <div class="top-player ${positions[index]}">
        <div class="medal">${medals[index]}</div>
        <img src="${player.avatar || '/assets/default-avatar.png'}" class="avatar" />
        <div class="username">${player.username}</div>
        <div class="level">Lv.${player.level}</div>
        <div class="score">${this.formatScore(player.score)}</div>
      </div>
    `).join('');
  }

  renderRankList(players) {
    const container = document.getElementById('rankList');
    
    if (players.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <table class="rank-table">
        <thead>
          <tr>
            <th>排名</th>
            <th>玩家</th>
            <th>等级</th>
            <th>分数</th>
          </tr>
        </thead>
        <tbody>
          ${players.map(player => `
            <tr class="rank-row" data-player-id="${player.playerId}">
              <td class="rank">${player.rank}</td>
              <td class="player-info">
                <img src="${player.avatar || '/assets/default-avatar.png'}" class="avatar-small" />
                <span>${player.username}</span>
              </td>
              <td>Lv.${player.level}</td>
              <td class="score">${this.formatScore(player.score)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  async renderMyRank() {
    const container = document.getElementById('myRank');
    
    try {
      const response = await apiClient.get(`/leaderboard/${this.currentType}/rank`);
      const { season, rank, score } = response.data.data;

      if (rank === null) {
        container.innerHTML = '<p class="no-rank">你还未上榜，快去努力吧！</p>';
        return;
      }

      container.innerHTML = `
        <div class="my-rank-info">
          <span class="label">我的排名</span>
          <span class="rank">#${rank}</span>
          <span class="score">${this.formatScore(score)}</span>
          <span class="season-name">${season.name}</span>
        </div>
      `;
    } catch (error) {
      console.error('Load my rank error:', error);
    }
  }

  formatScore(score) {
    if (score >= 1000000) {
      return (score / 1000000).toFixed(1) + 'M';
    } else if (score >= 1000) {
      return (score / 1000).toFixed(1) + 'K';
    }
    return score.toString();
  }

  showLoading(show) {
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
  }

  showError(message) {
    const content = document.querySelector('.leaderboard-content');
    content.innerHTML = `<p class="error">${message}</p>`;
  }
}
```

### 6. 事件监听器

```javascript
// backend/services/social-service/src/handlers/leaderboardHandler.js

const LeaderboardService = require('../leaderboardService');

const leaderboardService = new LeaderboardService();

module.exports = {
  /**
   * 监听捕捉事件
   */
  async handleCatchEvent(event) {
    const { userId, rarity } = event.data;
    await leaderboardService.onCatchEvent(userId, rarity);
  },

  /**
   * 监听战斗结果
   */
  async handleBattleResult(event) {
    const { userId, isWin, points } = event.data;
    await leaderboardService.onBattleResult(userId, isWin, points);
  },

  /**
   * 监听图鉴更新
   */
  async handlePokedexUpdate(event) {
    const { userId, completionRate } = event.data;
    const season = await leaderboardService.getCurrentSeason('pokedex_completion');
    if (!season) return;

    await leaderboardService.cache.updateScore(
      'pokedex_completion',
      season.id,
      userId,
      Math.floor(completionRate * 100)
    );
  },

  /**
   * 监听闪光捕捉
   */
  async handleShinyCatch(event) {
    const { userId } = event.data;
    const season = await leaderboardService.getCurrentSeason('shiny_collection');
    if (!season) return;

    await leaderboardService.cache.incrementScore(
      'shiny_collection',
      season.id,
      userId,
      1
    );
  }
};
```

### 7. 定时任务

```javascript
// backend/services/social-service/src/jobs/leaderboardJobs.js

const cron = require('node-cron');
const LeaderboardService = require('../leaderboardService');

const leaderboardService = new LeaderboardService();

/**
 * 赛季结算任务 - 每小时检查
 */
cron.schedule('0 * * * *', async () => {
  console.log('[Leaderboard] Checking for ended seasons...');
  
  try {
    // 查找已结束但未结算的赛季
    const result = await leaderboardService.db.query(`
      SELECT id FROM seasons
      WHERE status = 'active' AND end_time <= NOW()
    `);

    for (const row of result.rows) {
      console.log(`[Leaderboard] Settling season ${row.id}`);
      await leaderboardService.settleSeason(row.id);
    }
  } catch (error) {
    console.error('[Leaderboard] Season settlement error:', error);
  }
});

/**
 * 数据库同步任务 - 每 5 分钟
 */
cron.schedule('*/5 * * * *', async () => {
  console.log('[Leaderboard] Syncing to database...');
  
  const types = [
    'catch_total', 'catch_rare', 'battle_pvp', 'battle_gym',
    'pokedex_completion', 'shiny_collection', 'guild_contribution'
  ];

  for (const type of types) {
    try {
      const season = await leaderboardService.getCurrentSeason(type);
      if (!season) continue;

      const topPlayers = await leaderboardService.cache.getTopPlayers(type, season.id, 1000);
      
      for (const player of topPlayers) {
        await leaderboardService.syncToDatabase(type, season.id, player.playerId, player.score);
      }
    } catch (error) {
      console.error(`[Leaderboard] Sync error for ${type}:`, error);
    }
  }
});

/**
 * 排名快照任务 - 每天凌晨 2 点
 */
cron.schedule('0 2 * * *', async () => {
  console.log('[Leaderboard] Creating daily rank snapshot...');
  
  // 记录每日排名快照，用于历史对比
  // 实现省略...
});
```

### 8. Prometheus 指标

```javascript
// backend/services/social-service/src/metrics.js

const { Counter, Gauge, Histogram } = require('prom-client');

const leaderboardUpdateTotal = new Counter({
  name: 'leaderboard_update_total',
  help: 'Total leaderboard updates',
  labelNames: ['type']
});

const leaderboardQueryLatency = new Histogram({
  name: 'leaderboard_query_latency_seconds',
  help: 'Leaderboard query latency',
  labelNames: ['type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1]
});

const leaderboardPlayersCount = new Gauge({
  name: 'leaderboard_players_count',
  help: 'Number of players in leaderboard',
  labelNames: ['type', 'season_id']
});

const seasonEndTotal = new Counter({
  name: 'leaderboard_season_end_total',
  help: 'Total seasons ended',
  labelNames: ['type']
});

const rankChangeNotifications = new Counter({
  name: 'leaderboard_rank_change_notifications_total',
  help: 'Total rank change notifications sent',
  labelNames: ['type', 'direction']
});

module.exports = {
  leaderboardUpdateTotal,
  leaderboardQueryLatency,
  leaderboardPlayersCount,
  seasonEndTotal,
  rankChangeNotifications
};
```

## 验收标准

- [ ] 7 种排行榜类型全部实现并正常工作
- [ ] 赛季机制完整，支持创建、结算、历史查询
- [ ] Redis 缓存层正常工作，排名查询延迟 < 50ms
- [ ] 前端排行榜 UI 正常显示，支持 Tab 切换
- [ ] 玩家排名实时更新，捕捉/战斗事件正确触发
- [ ] 排名变化通知正常发送
- [ ] 赛季奖励发放流程正常
- [ ] 数据库定时同步任务正常运行
- [ ] Prometheus 指标正确暴露
- [ ] 单元测试覆盖率 > 80%

## 影响范围

- **新增文件**:
  - `backend/services/social-service/src/leaderboardService.js`
  - `backend/services/social-service/src/routes/leaderboard.js`
  - `backend/services/social-service/src/handlers/leaderboardHandler.js`
  - `backend/services/social-service/src/jobs/leaderboardJobs.js`
  - `backend/services/social-service/src/metrics.js`
  - `backend/shared/leaderboardCache.js`
  - `frontend/game-client/src/components/Leaderboard.js`
  - `frontend/game-client/src/styles/leaderboard.css`
  - `database/migrations/XXXXX_add_leaderboard_system.sql`

- **修改文件**:
  - `backend/services/social-service/src/index.js` (集成路由和任务)
  - `backend/services/catch-service/src/index.js` (发布捕捉事件)
  - `backend/gateway/src/index.js` (路由代理)
  - `frontend/game-client/src/main.js` (集成组件)

## 参考

- Redis Sorted Set 排行榜最佳实践: https://redis.io/topics/data-types#sorted-sets
- 游戏排行榜设计模式: https://www.gamedeveloper.com/design/leaderboards-done-right
- Prometheus 指标最佳实践: https://prometheus.io/docs/practices/naming/
