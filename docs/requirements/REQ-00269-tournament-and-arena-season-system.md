# REQ-00269: 精灵锦标赛与竞技场赛季系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00269 |
| 标题 | 精灵锦标赛与竞技场赛季系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gym-service、pokemon-service、user-service、reward-service、social-service、gateway、game-client |
| 创建时间 | 2026-06-18 21:05 |

## 需求描述

构建完整的精灵锦标赛与竞技场赛季系统，实现定期赛季重置、段位晋升、锦标赛赛事、赛季奖励和排行榜功能，提升玩家长期留存和竞技参与度。

### 核心功能
1. **赛季系统** - 定期赛季循环（每月/每季），赛季重置与继承规则
2. **段位系统** - 青铜/白银/黄金/铂金/钻石/大师/宗师段位，升降级机制
3. **锦标赛系统** - 定时锦标赛、淘汰赛制、实时对战
4. **赛季奖励** - 段位奖励、排名奖励、参与奖励、里程碑奖励
5. **竞技积分** - 胜利加分、失败扣分、连胜奖励、段位保护

### 业务价值
- 提升玩家长期留存（赛季目标驱动）
- 增强社交竞争动力（排行榜与段位展示）
- 提供稳定内容更新节奏（赛季刷新）
- 创造高价值奖励回收渠道（赛季奖励）

## 技术方案

### 1. 数据库设计

#### 1.1 赛季表 (seasons)
```sql
CREATE TABLE seasons (
  id SERIAL PRIMARY KEY,
  season_number INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'upcoming', -- upcoming, active, ended
  config JSONB DEFAULT '{}', -- 赛季配置
  rewards JSONB DEFAULT '{}', -- 赛季奖励配置
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_seasons_status ON seasons(status);
CREATE INDEX idx_seasons_time ON seasons(start_time, end_time);
```

#### 1.2 玩家段位表 (player_ranks)
```sql
CREATE TABLE player_ranks (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season_id INT NOT NULL REFERENCES seasons(id),
  tier VARCHAR(20) NOT NULL, -- bronze, silver, gold, platinum, diamond, master, grandmaster
  tier_level INT DEFAULT 1, -- 1-5, e.g., Gold III
  rank_points INT DEFAULT 0, -- 竞技积分
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  win_streak INT DEFAULT 0, -- 连胜场次
  max_win_streak INT DEFAULT 0,
  highest_tier VARCHAR(20), -- 本赛季最高段位
  placement_matches INT DEFAULT 0, -- 定位赛场次
  placement_done BOOLEAN DEFAULT FALSE,
  decay_points INT DEFAULT 0, -- 休眠衰减积分
  last_match_at TIMESTAMP,
  promoted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX idx_player_ranks_season ON player_ranks(season_id);
CREATE INDEX idx_player_ranks_user ON player_ranks(user_id);
CREATE INDEX idx_player_ranks_tier ON player_ranks(season_id, tier, rank_points DESC);
```

#### 1.3 锦标赛表 (tournaments)
```sql
CREATE TABLE tournaments (
  id SERIAL PRIMARY KEY,
  season_id INT REFERENCES seasons(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL, -- daily, weekly, monthly, special
  format VARCHAR(50) NOT NULL, -- elimination, swiss, round_robin
  min_tier VARCHAR(20), -- 最低段位限制
  max_participants INT DEFAULT 64,
  current_participants INT DEFAULT 0,
  registration_start TIMESTAMP NOT NULL,
  registration_end TIMESTAMP NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  status VARCHAR(20) DEFAULT 'upcoming', -- upcoming, registration, in_progress, completed, cancelled
  bracket JSONB DEFAULT '{}', -- 对战树
  rewards JSONB DEFAULT '{}', -- 奖励配置
  entry_fee JSONB DEFAULT '{}', -- 报名费用
  rules JSONB DEFAULT '{}', -- 比赛规则
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tournaments_season ON tournaments(season_id);
CREATE INDEX idx_tournaments_status ON tournaments(status);
CREATE INDEX idx_tournaments_time ON tournaments(start_time);
```

#### 1.4 锦标赛参与者表 (tournament_participants)
```sql
CREATE TABLE tournament_participants (
  id SERIAL PRIMARY KEY,
  tournament_id INT NOT NULL REFERENCES tournaments(id),
  user_id INT NOT NULL REFERENCES users(id),
  seed INT, -- 种子排名
  current_round INT DEFAULT 0,
  match_wins INT DEFAULT 0,
  match_losses INT DEFAULT 0,
  eliminated BOOLEAN DEFAULT FALSE,
  final_rank INT,
  prizes_claimed BOOLEAN DEFAULT FALSE,
  registered_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tournament_id, user_id)
);

CREATE INDEX idx_tournament_participants_tournament ON tournament_participants(tournament_id);
CREATE INDEX idx_tournament_participants_user ON tournament_participants(user_id);
```

#### 1.5 对战记录表 (battle_records)
```sql
CREATE TABLE battle_records (
  id SERIAL PRIMARY KEY,
  season_id INT NOT NULL REFERENCES seasons(id),
  tournament_id INT REFERENCES tournaments(id),
  attacker_id INT NOT NULL REFERENCES users(id),
  defender_id INT NOT NULL REFERENCES users(id),
  attacker_pokemon JSONB NOT NULL, -- 参战精灵
  defender_pokemon JSONB NOT NULL,
  result VARCHAR(20) NOT NULL, -- win, lose, draw
  battle_type VARCHAR(50) NOT NULL, -- ranked, tournament, friendly
  rank_points_change INT DEFAULT 0, -- 积分变化
  battle_duration INT, -- 战斗时长（秒）
  battle_data JSONB DEFAULT '{}', -- 战斗详情
  rewards JSONB DEFAULT '{}', -- 奖励
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_battle_records_season ON battle_records(season_id);
CREATE INDEX idx_battle_records_attacker ON battle_records(attacker_id, created_at DESC);
CREATE INDEX idx_battle_records_defender ON battle_records(defender_id, created_at DESC);
CREATE INDEX idx_battle_records_tournament ON battle_records(tournament_id);
```

#### 1.6 赛季奖励发放记录表 (season_rewards)
```sql
CREATE TABLE season_rewards (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season_id INT NOT NULL REFERENCES seasons(id),
  tier VARCHAR(20) NOT NULL,
  final_rank INT,
  rewards JSONB NOT NULL, -- 发放的奖励
  status VARCHAR(20) DEFAULT 'pending', -- pending, claimed
  claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX idx_season_rewards_user ON season_rewards(user_id);
CREATE INDEX idx_season_rewards_season ON season_rewards(season_id);
```

### 2. 后端服务实现

#### 2.1 gym-service 赛季路由 (season.js)
```javascript
const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const SeasonManager = require('../services/SeasonManager');
const RankManager = require('../services/RankManager');
const TournamentManager = require('../services/TournamentManager');
const auth = require('../../../shared/middleware/auth');
const rateLimit = require('../../../shared/middleware/rateLimit');

// 获取当前赛季信息
router.get('/current', async (req, res) => {
  try {
    const season = await SeasonManager.getCurrentSeason();
    if (!season) {
      return res.status(404).json({ error: 'NO_ACTIVE_SEASON', message: '当前没有活跃赛季' });
    }
    
    const timeRemaining = Math.max(0, new Date(season.end_time) - new Date());
    
    res.json({
      season,
      timeRemaining: {
        days: Math.floor(timeRemaining / (1000 * 60 * 60 * 24)),
        hours: Math.floor((timeRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60))
      }
    });
  } catch (error) {
    console.error('Get current season error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取赛季信息失败' });
  }
});

// 获取玩家段位信息
router.get('/rank', auth, async (req, res) => {
  try {
    const { userId } = req.user;
    const season = await SeasonManager.getCurrentSeason();
    
    if (!season) {
      return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
    }
    
    const rank = await RankManager.getPlayerRank(userId, season.id);
    
    res.json({
      rank,
      tierInfo: RankManager.getTierInfo(rank.tier, rank.tier_level),
      progress: RankManager.getProgressToNextTier(rank)
    });
  } catch (error) {
    console.error('Get player rank error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取段位信息失败' });
  }
});

// 获取段位排行榜
router.get('/leaderboard',
  query('tier').optional().isIn(['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster']),
  query('limit').optional().isInt({ min: 10, max: 100 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const season = await SeasonManager.getCurrentSeason();
      if (!season) {
        return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
      }
      
      const { tier, limit = 50 } = req.query;
      const leaderboard = await RankManager.getLeaderboard(season.id, { tier, limit });
      
      res.json({ leaderboard, season: season.id });
    } catch (error) {
      console.error('Get leaderboard error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取排行榜失败' });
    }
  }
);

// 定位赛匹配
router.post('/placement/match',
  auth,
  rateLimit({ windowMs: 60000, max: 3 }),
  async (req, res) => {
    try {
      const { userId } = req.user;
      const season = await SeasonManager.getCurrentSeason();
      
      if (!season) {
        return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
      }
      
      const rank = await RankManager.getPlayerRank(userId, season.id);
      
      if (rank.placement_done) {
        return res.status(400).json({ error: 'PLACEMENT_DONE', message: '定位赛已完成' });
      }
      
      if (rank.placement_matches >= 10) {
        return res.status(400).json({ error: 'PLACEMENT_LIMIT', message: '定位赛次数已达上限' });
      }
      
      // 匹配对手
      const match = await RankManager.findPlacementMatch(userId, rank);
      
      res.json({ match, placementProgress: rank.placement_matches + 1 });
    } catch (error) {
      console.error('Placement match error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: '匹配失败' });
    }
  }
);

// 排位赛匹配
router.post('/ranked/match',
  auth,
  rateLimit({ windowMs: 60000, max: 5 }),
  async (req, res) => {
    try {
      const { userId } = req.user;
      const season = await SeasonManager.getCurrentSeason();
      
      if (!season) {
        return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
      }
      
      const rank = await RankManager.getPlayerRank(userId, season.id);
      
      if (!rank.placement_done) {
        return res.status(400).json({ error: 'PLACEMENT_REQUIRED', message: '请先完成定位赛' });
      }
      
      // 检查段位衰减
      const decayed = await RankManager.checkDecay(userId, season.id);
      if (decayed) {
        return res.status(400).json({ error: 'RANK_DECAYED', message: '段位已衰减，请重新定位' });
      }
      
      // 匹配对手
      const match = await RankManager.findRankedMatch(userId, rank);
      
      res.json({ match, estimatedWaitTime: match.estimatedWaitTime });
    } catch (error) {
      console.error('Ranked match error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: '匹配失败' });
    }
  }
);

// 上报排位赛结果
router.post('/ranked/result',
  auth,
  body('matchId').isUUID(),
  body('result').isIn(['win', 'lose', 'draw']),
  body('battleData').isObject(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { userId } = req.user;
      const { matchId, result, battleData } = req.body;
      
      const rankChange = await RankManager.processMatchResult(userId, matchId, result, battleData);
      
      res.json({
        rankChange,
        newRank: rankChange.newRank,
        tierChanged: rankChange.tierChanged,
        rewards: rankChange.rewards
      });
    } catch (error) {
      console.error('Report ranked result error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: '上报结果失败' });
    }
  }
);

// 获取赛季历史
router.get('/history',
  auth,
  query('limit').optional().isInt({ min: 1, max: 10 }),
  async (req, res) => {
    try {
      const { userId } = req.user;
      const { limit = 5 } = req.query;
      
      const history = await SeasonManager.getSeasonHistory(userId, limit);
      
      res.json({ history });
    } catch (error) {
      console.error('Get season history error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取历史失败' });
    }
  }
);

// 领取赛季奖励
router.post('/rewards/:seasonId/claim',
  auth,
  param('seasonId').isInt(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { userId } = req.user;
      const { seasonId } = req.params;
      
      const rewards = await SeasonManager.claimSeasonRewards(userId, parseInt(seasonId));
      
      res.json({ rewards, claimed: true });
    } catch (error) {
      console.error('Claim season rewards error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: '领取奖励失败' });
    }
  }
);

module.exports = router;
```

#### 2.2 段位管理器 (RankManager.js)
```javascript
const db = require('../../../shared/db');
const redis = require('../../../shared/redis');
const logger = require('../../../shared/logger');

// 段位配置
const TIER_CONFIG = {
  bronze: { name: '青铜', minPoints: 0, maxPoints: 999, level: 1 },
  silver: { name: '白银', minPoints: 1000, maxPoints: 1999, level: 2 },
  gold: { name: '黄金', minPoints: 2000, maxPoints: 2999, level: 3 },
  platinum: { name: '铂金', minPoints: 3000, maxPoints: 3999, level: 4 },
  diamond: { name: '钻石', minPoints: 4000, maxPoints: 4999, level: 5 },
  master: { name: '大师', minPoints: 5000, maxPoints: 6999, level: 6 },
  grandmaster: { name: '宗师', minPoints: 7000, maxPoints: 999999, level: 7 }
};

// 积分配置
const POINTS_CONFIG = {
  win: 25,
  lose: -20,
  draw: 5,
  winStreakBonus: 5, // 每连胜额外加分
  maxWinStreakBonus: 25, // 最大连胜奖励
  placementWinBonus: 50, // 定位赛胜利加分
  decayDays: 7, // 多少天后开始衰减
  decayRate: 10, // 每天衰减积分
  tierProtectionMatches: 3 // 段位保护场次
};

class RankManager {
  // 获取玩家段位
  async getPlayerRank(userId, seasonId) {
    const result = await db.query(
      `SELECT * FROM player_ranks WHERE user_id = $1 AND season_id = $2`,
      [userId, seasonId]
    );
    
    if (result.rows.length === 0) {
      // 创建新玩家段位记录
      return await this.createPlayerRank(userId, seasonId);
    }
    
    return result.rows[0];
  }
  
  // 创建玩家段位记录
  async createPlayerRank(userId, seasonId) {
    const result = await db.query(
      `INSERT INTO player_ranks (user_id, season_id, tier, tier_level, rank_points)
       VALUES ($1, $2, 'bronze', 5, 0)
       RETURNING *`,
      [userId, seasonId]
    );
    
    logger.info('Player rank created', { userId, seasonId });
    return result.rows[0];
  }
  
  // 获取段位信息
  getTierInfo(tier, level) {
    const config = TIER_CONFIG[tier];
    if (!config) return null;
    
    return {
      tier,
      level,
      name: `${config.name}${this.getLevelRoman(level)}`,
      minPoints: config.minPoints,
      maxPoints: config.maxPoints,
      icon: `/assets/tiers/${tier}_${level}.png`,
      color: this.getTierColor(tier)
    };
  }
  
  // 获取升级进度
  getProgressToNextTier(rank) {
    const currentTier = TIER_CONFIG[rank.tier];
    const nextTier = this.getNextTier(rank.tier);
    
    if (!nextTier) {
      // 最高段位
      return { progress: 100, pointsToNext: 0, isMaxTier: true };
    }
    
    const pointsInTier = rank.rank_points - currentTier.minPoints;
    const tierRange = currentTier.maxPoints - currentTier.minPoints + 1;
    const progress = (pointsInTier / tierRange) * 100;
    
    return {
      progress: Math.min(progress, 100),
      pointsToNext: nextTier.minPoints - rank.rank_points,
      nextTier: nextTier.name,
      isMaxTier: false
    };
  }
  
  // 计算段位
  calculateTier(points) {
    for (const [tier, config] of Object.entries(TIER_CONFIG).reverse()) {
      if (points >= config.minPoints) {
        const level = this.calculateTierLevel(points, config);
        return { tier, level };
      }
    }
    return { tier: 'bronze', level: 5 };
  }
  
  // 计算段位等级
  calculateTierLevel(points, tierConfig) {
    const pointsInTier = points - tierConfig.minPoints;
    const rangePerLevel = (tierConfig.maxPoints - tierConfig.minPoints + 1) / 5;
    const level = 5 - Math.floor(pointsInTier / rangePerLevel);
    return Math.max(1, Math.min(5, level));
  }
  
  // 处理比赛结果
  async processMatchResult(userId, matchId, result, battleData) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前赛季
      const seasonResult = await client.query(
        `SELECT * FROM seasons WHERE status = 'active' LIMIT 1`
      );
      
      if (seasonResult.rows.length === 0) {
        throw new Error('No active season');
      }
      
      const season = seasonResult.rows[0];
      
      // 获取玩家段位
      const rankResult = await client.query(
        `SELECT * FROM player_ranks WHERE user_id = $1 AND season_id = $2 FOR UPDATE`,
        [userId, season.id]
      );
      
      let rank = rankResult.rows[0];
      if (!rank) {
        rank = await this.createPlayerRank(userId, season.id);
      }
      
      // 计算积分变化
      let pointsChange = 0;
      let isPlacement = !rank.placement_done && rank.placement_matches < 10;
      
      if (result === 'win') {
        pointsChange = isPlacement 
          ? POINTS_CONFIG.placementWinBonus 
          : POINTS_CONFIG.win;
        
        // 连胜奖励
        if (!isPlacement && rank.win_streak > 0) {
          const streakBonus = Math.min(
            rank.win_streak * POINTS_CONFIG.winStreakBonus,
            POINTS_CONFIG.maxWinStreakBonus
          );
          pointsChange += streakBonus;
        }
      } else if (result === 'lose') {
        pointsChange = isPlacement ? 0 : POINTS_CONFIG.lose;
      } else {
        pointsChange = POINTS_CONFIG.draw;
      }
      
      // 更新段位
      const newPoints = Math.max(0, rank.rank_points + pointsChange);
      const { tier: newTier, level: newLevel } = this.calculateTier(newPoints);
      const tierChanged = newTier !== rank.tier;
      
      // 更新数据库
      const updateResult = await client.query(
        `UPDATE player_ranks 
         SET rank_points = $1,
             tier = $2,
             tier_level = $3,
             wins = wins + CASE WHEN $4 = 'win' THEN 1 ELSE 0 END,
             losses = losses + CASE WHEN $4 = 'lose' THEN 1 ELSE 0 END,
             win_streak = CASE WHEN $4 = 'win' THEN win_streak + 1 ELSE 0 END,
             max_win_streak = GREATEST(max_win_streak, CASE WHEN $4 = 'win' THEN win_streak + 1 ELSE win_streak END),
             placement_matches = placement_matches + CASE WHEN $5 THEN 1 ELSE 0 END,
             placement_done = CASE WHEN $5 AND placement_matches >= 9 THEN true ELSE placement_done END,
             highest_tier = CASE WHEN $6 > (SELECT level FROM (VALUES ${Object.entries(TIER_CONFIG).map(([t, c]) => `('${t}', ${c.level})`).join(',')}) AS t(tier, level) WHERE t.tier = highest_tier) THEN $7 ELSE highest_tier END,
             last_match_at = NOW(),
             updated_at = NOW()
         WHERE user_id = $8 AND season_id = $9
         RETURNING *`,
        [newPoints, newTier, newLevel, result, isPlacement, TIER_CONFIG[newTier].level, newTier, userId, season.id]
      );
      
      // 记录对战
      await client.query(
        `INSERT INTO battle_records 
         (season_id, attacker_id, defender_id, attacker_pokemon, defender_pokemon, 
          result, battle_type, rank_points_change, battle_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'ranked', $7, $8)`,
        [season.id, userId, battleData.opponentId, battleData.attackerPokemon, 
         battleData.defenderPokemon, result, pointsChange, battleData]
      );
      
      // 计算奖励
      const rewards = await this.calculateMatchRewards(result, newTier, tierChanged);
      
      await client.query('COMMIT');
      
      // 更新 Redis 缓存
      await this.updateLeaderboardCache(userId, season.id, newPoints);
      
      logger.info('Match result processed', {
        userId,
        matchId,
        result,
        pointsChange,
        newTier,
        tierChanged
      });
      
      return {
        pointsChange,
        newRank: updateResult.rows[0],
        tierChanged,
        previousTier: rank.tier,
        rewards
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 计算比赛奖励
  async calculateMatchRewards(result, tier, tierChanged) {
    const rewards = {
      coins: 0,
      items: [],
      exp: 0
    };
    
    if (result === 'win') {
      rewards.coins = 50;
      rewards.exp = 100;
      
      // 根据段位增加奖励
      const tierBonus = TIER_CONFIG[tier]?.level || 1;
      rewards.coins += tierBonus * 10;
      rewards.exp += tierBonus * 20;
      
      // 晋级奖励
      if (tierChanged) {
        rewards.items.push({
          type: 'promotion_pack',
          tier: tier,
          quantity: 1
        });
      }
    } else if (result === 'lose') {
      rewards.coins = 10;
      rewards.exp = 20;
    }
    
    return rewards;
  }
  
  // 获取排行榜
  async getLeaderboard(seasonId, options = {}) {
    const { tier, limit = 50 } = options;
    
    let query = `
      SELECT pr.*, u.username, u.avatar_url,
             ROW_NUMBER() OVER (ORDER BY pr.rank_points DESC) as rank
      FROM player_ranks pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.season_id = $1
    `;
    
    const params = [seasonId];
    
    if (tier) {
      query += ` AND pr.tier = $${params.length + 1}`;
      params.push(tier);
    }
    
    query += ` ORDER BY pr.rank_points DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await db.query(query, params);
    
    return result.rows.map(row => ({
      rank: row.rank,
      userId: row.user_id,
      username: row.username,
      avatar: row.avatar_url,
      tier: row.tier,
      tierLevel: row.tier_level,
      rankPoints: row.rank_points,
      wins: row.wins,
      losses: row.losses,
      winRate: row.wins + row.losses > 0 
        ? ((row.wins / (row.wins + row.losses)) * 100).toFixed(1) 
        : 0
    }));
  }
  
  // 检查段位衰减
  async checkDecay(userId, seasonId) {
    const result = await db.query(
      `SELECT * FROM player_ranks 
       WHERE user_id = $1 AND season_id = $2 AND last_match_at < NOW() - INTERVAL '${POINTS_CONFIG.decayDays} days'`,
      [userId, seasonId]
    );
    
    return result.rows.length > 0;
  }
  
  // 应用段位衰减
  async applyDecay(userId, seasonId) {
    const rank = await this.getPlayerRank(userId, seasonId);
    const daysSinceLastMatch = Math.floor(
      (Date.now() - new Date(rank.last_match_at)) / (1000 * 60 * 60 * 24)
    );
    
    if (daysSinceLastMatch <= POINTS_CONFIG.decayDays) {
      return false;
    }
    
    const decayDays = daysSinceLastMatch - POINTS_CONFIG.decayDays;
    const decayPoints = decayDays * POINTS_CONFIG.decayRate;
    const newPoints = Math.max(0, rank.rank_points - decayPoints);
    
    const { tier: newTier, level: newLevel } = this.calculateTier(newPoints);
    
    await db.query(
      `UPDATE player_ranks 
       SET rank_points = $1, tier = $2, tier_level = $3, decay_points = $4, updated_at = NOW()
       WHERE user_id = $5 AND season_id = $6`,
      [newPoints, newTier, newLevel, decayPoints, userId, seasonId]
    );
    
    logger.info('Rank decay applied', { userId, seasonId, decayPoints, newTier });
    
    return true;
  }
  
  // 更新排行榜缓存
  async updateLeaderboardCache(userId, seasonId, points) {
    const key = `leaderboard:season:${seasonId}`;
    await redis.zadd(key, points, userId.toString());
    await redis.expire(key, 3600);
  }
  
  // 获取下一个段位
  getNextTier(currentTier) {
    const tiers = Object.keys(TIER_CONFIG);
    const currentIndex = tiers.indexOf(currentTier);
    if (currentIndex === -1 || currentIndex === tiers.length - 1) {
      return null;
    }
    const nextTierName = tiers[currentIndex + 1];
    return { name: TIER_CONFIG[nextTierName].name, ...TIER_CONFIG[nextTierName] };
  }
  
  // 辅助方法：获取罗马数字
  getLevelRoman(level) {
    const romans = ['I', 'II', 'III', 'IV', 'V'];
    return romans[level - 1] || '';
  }
  
  // 辅助方法：获取段位颜色
  getTierColor(tier) {
    const colors = {
      bronze: '#CD7F32',
      silver: '#C0C0C0',
      gold: '#FFD700',
      platinum: '#E5E4E2',
      diamond: '#B9F2FF',
      master: '#9932CC',
      grandmaster: '#FF4500'
    };
    return colors[tier] || '#808080';
  }
}

module.exports = new RankManager();
```

#### 2.3 锦标赛管理器 (TournamentManager.js)
```javascript
const db = require('../../../shared/db');
const redis = require('../../../shared/redis');
const logger = require('../../../shared/logger');
const { v4: uuidv4 } = require('uuid');

class TournamentManager {
  // 获取可报名的锦标赛列表
  async getAvailableTournaments(options = {}) {
    const { type, limit = 20 } = options;
    
    let query = `
      SELECT t.*, 
             COUNT(tp.id) as current_participants
      FROM tournaments t
      LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
      WHERE t.status IN ('upcoming', 'registration')
        AND t.registration_end > NOW()
      GROUP BY t.id
      ORDER BY t.start_time ASC
      LIMIT $1
    `;
    
    if (type) {
      query = `
        SELECT t.*, 
               COUNT(tp.id) as current_participants
        FROM tournaments t
        LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
        WHERE t.type = $1 AND t.status IN ('upcoming', 'registration')
          AND t.registration_end > NOW()
        GROUP BY t.id
        ORDER BY t.start_time ASC
        LIMIT $2
      `;
    }
    
    const result = await db.query(query, type ? [type, limit] : [limit]);
    
    return result.rows.map(this.formatTournament);
  }
  
  // 报名锦标赛
  async register(userId, tournamentId) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // 检查锦标赛状态
      const tournamentResult = await client.query(
        `SELECT * FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId]
      );
      
      if (tournamentResult.rows.length === 0) {
        throw new Error('TOURNAMENT_NOT_FOUND');
      }
      
      const tournament = tournamentResult.rows[0];
      
      if (tournament.status !== 'registration') {
        throw new Error('REGISTRATION_CLOSED');
      }
      
      if (new Date() > new Date(tournament.registration_end)) {
        throw new Error('REGISTRATION_ENDED');
      }
      
      // 检查是否已报名
      const existingResult = await client.query(
        `SELECT * FROM tournament_participants WHERE tournament_id = $1 AND user_id = $2`,
        [tournamentId, userId]
      );
      
      if (existingResult.rows.length > 0) {
        throw new Error('ALREADY_REGISTERED');
      }
      
      // 检查人数限制
      const countResult = await client.query(
        `SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = $1`,
        [tournamentId]
      );
      
      if (parseInt(countResult.rows[0].count) >= tournament.max_participants) {
        throw new Error('TOURNAMENT_FULL');
      }
      
      // 检查段位限制
      if (tournament.min_tier) {
        const seasonResult = await client.query(
          `SELECT * FROM seasons WHERE status = 'active' LIMIT 1`
        );
        
        if (seasonResult.rows.length > 0) {
          const rankResult = await client.query(
            `SELECT * FROM player_ranks WHERE user_id = $1 AND season_id = $2`,
            [userId, seasonResult.rows[0].id]
          );
          
          if (rankResult.rows.length > 0) {
            const playerTier = rankResult.rows[0].tier;
            const tierLevels = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster'];
            
            if (tierLevels.indexOf(playerTier) < tierLevels.indexOf(tournament.min_tier)) {
              throw new Error('TIER_REQUIREMENT_NOT_MET');
            }
          }
        }
      }
      
      // 扣除报名费
      if (tournament.entry_fee && Object.keys(tournament.entry_fee).length > 0) {
        // 调用支付服务扣费
        // await PaymentService.deduct(userId, tournament.entry_fee);
      }
      
      // 添加参与者
      await client.query(
        `INSERT INTO tournament_participants (tournament_id, user_id, registered_at)
         VALUES ($1, $2, NOW())`,
        [tournamentId, userId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Tournament registration successful', { userId, tournamentId });
      
      return { success: true, tournamentId };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 取消报名
  async unregister(userId, tournamentId) {
    const result = await db.query(
      `DELETE FROM tournament_participants 
       WHERE tournament_id = $1 AND user_id = $2
       RETURNING *`,
      [tournamentId, userId]
    );
    
    if (result.rows.length === 0) {
      throw new Error('NOT_REGISTERED');
    }
    
    logger.info('Tournament unregistration', { userId, tournamentId });
    
    return { success: true };
  }
  
  // 生成对战树
  async generateBracket(tournamentId) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // 获取所有参与者
      const participantsResult = await client.query(
        `SELECT tp.*, u.username, pr.rank_points, pr.tier
         FROM tournament_participants tp
         JOIN users u ON tp.user_id = u.id
         LEFT JOIN player_ranks pr ON tp.user_id = pr.user_id
         WHERE tp.tournament_id = $1
         ORDER BY pr.rank_points DESC NULLS LAST`,
        [tournamentId]
      );
      
      const participants = participantsResult.rows;
      
      if (participants.length < 2) {
        throw new Error('NOT_ENOUGH_PARTICIPANTS');
      }
      
      // 计算需要的轮数
      const rounds = Math.ceil(Math.log2(participants.length));
      const bracketSize = Math.pow(2, rounds);
      
      // 生成淘汰赛树
      const bracket = this.buildEliminationBracket(participants, bracketSize, rounds);
      
      // 保存对战树
      await client.query(
        `UPDATE tournaments SET bracket = $1, status = 'in_progress', updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(bracket), tournamentId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Tournament bracket generated', { tournamentId, participants: participants.length });
      
      return bracket;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 构建淘汰赛树
  buildEliminationBracket(participants, bracketSize, rounds) {
    const bracket = {
      rounds: [],
      participants: participants.length
    };
    
    // 种子分配
    const seeds = participants.map((p, i) => ({
      ...p,
      seed: i + 1
    }));
    
    // 第一轮对阵
    const firstRound = [];
    for (let i = 0; i < bracketSize / 2; i++) {
      const player1 = seeds[i];
      const player2 = seeds[bracketSize - 1 - i] || null;
      
      firstRound.push({
        matchId: uuidv4(),
        round: 1,
        position: i + 1,
        player1: player1 ? {
          id: player1.user_id,
          username: player1.username,
          seed: player1.seed
        } : null,
        player2: player2 ? {
          id: player2.user_id,
          username: player2.username,
          seed: player2.seed
        } : null,
        winner: player2 ? null : player1?.user_id, // 轮空自动晋级
        status: player2 ? 'pending' : 'completed'
      });
    }
    
    bracket.rounds.push({ round: 1, matches: firstRound });
    
    // 后续轮次
    for (let r = 2; r <= rounds; r++) {
      const matchCount = bracketSize / Math.pow(2, r);
      const round = [];
      
      for (let i = 0; i < matchCount; i++) {
        round.push({
          matchId: uuidv4(),
          round: r,
          position: i + 1,
          player1: null,
          player2: null,
          winner: null,
          status: 'pending'
        });
      }
      
      bracket.rounds.push({ round: r, matches: round });
    }
    
    return bracket;
  }
  
  // 上报比赛结果
  async reportMatchResult(tournamentId, matchId, winnerId, battleData) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // 获取锦标赛和对战树
      const tournamentResult = await client.query(
        `SELECT * FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId]
      );
      
      if (tournamentResult.rows.length === 0) {
        throw new Error('TOURNAMENT_NOT_FOUND');
      }
      
      const tournament = tournamentResult.rows[0];
      const bracket = JSON.parse(tournament.bracket);
      
      // 找到比赛并更新结果
      let match = null;
      let matchRoundIndex = -1;
      let matchIndex = -1;
      
      for (let ri = 0; ri < bracket.rounds.length; ri++) {
        const round = bracket.rounds[ri];
        for (let mi = 0; mi < round.matches.length; mi++) {
          if (round.matches[mi].matchId === matchId) {
            match = round.matches[mi];
            matchRoundIndex = ri;
            matchIndex = mi;
            break;
          }
        }
        if (match) break;
      }
      
      if (!match) {
        throw new Error('MATCH_NOT_FOUND');
      }
      
      // 更新比赛结果
      match.winner = winnerId;
      match.status = 'completed';
      match.battleData = battleData;
      match.completedAt = new Date().toISOString();
      
      // 晋级到下一轮
      if (matchRoundIndex < bracket.rounds.length - 1) {
        const nextRound = bracket.rounds[matchRoundIndex + 1];
        const nextMatchIndex = Math.floor(matchIndex / 2);
        const nextMatch = nextRound.matches[nextMatchIndex];
        
        if (matchIndex % 2 === 0) {
          nextMatch.player1 = {
            id: winnerId,
            username: match.player1?.id === winnerId ? match.player1.username : match.player2.username,
            seed: match.player1?.id === winnerId ? match.player1.seed : match.player2.seed
          };
        } else {
          nextMatch.player2 = {
            id: winnerId,
            username: match.player1?.id === winnerId ? match.player1.username : match.player2.username,
            seed: match.player1?.id === winnerId ? match.player1.seed : match.player2.seed
          };
        }
      } else {
        // 锦标赛结束
        bracket.winner = winnerId;
        await this.finalizeTournament(client, tournamentId, winnerId, bracket);
      }
      
      // 保存更新后的对战树
      await client.query(
        `UPDATE tournaments SET bracket = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(bracket), tournamentId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Tournament match result reported', { tournamentId, matchId, winnerId });
      
      return { success: true, bracket };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 结束锦标赛
  async finalizeTournament(client, tournamentId, winnerId, bracket) {
    // 获取所有参与者排名
    const participants = await client.query(
      `SELECT * FROM tournament_participants WHERE tournament_id = $1`,
      [tournamentId]
    );
    
    // 更新参与者排名
    const updates = participants.rows.map(p => {
      let rank = participants.rows.length; // 默认最后一名
      
      if (p.user_id === winnerId) {
        rank = 1;
      } else if (this.isRunnerUp(bracket, p.user_id)) {
        rank = 2;
      } else if (this.isSemiFinalist(bracket, p.user_id)) {
        rank = 3;
      }
      
      return client.query(
        `UPDATE tournament_participants 
         SET final_rank = $1, eliminated = $2
         WHERE tournament_id = $3 AND user_id = $4`,
        [rank, rank < participants.rows.length, tournamentId, p.user_id]
      );
    });
    
    await Promise.all(updates);
    
    // 更新锦标赛状态
    await client.query(
      `UPDATE tournaments SET status = 'completed', end_time = NOW(), updated_at = NOW() WHERE id = $1`,
      [tournamentId]
    );
    
    logger.info('Tournament finalized', { tournamentId, winnerId });
  }
  
  // 辅助方法：格式化锦标赛
  formatTournament(tournament) {
    return {
      id: tournament.id,
      name: tournament.name,
      type: tournament.type,
      format: tournament.format,
      status: tournament.status,
      participants: {
        current: parseInt(tournament.current_participants) || 0,
        max: tournament.max_participants
      },
      registration: {
        start: tournament.registration_start,
        end: tournament.registration_end
      },
      startTime: tournament.start_time,
      minTier: tournament.min_tier,
      rewards: tournament.rewards,
      entryFee: tournament.entry_fee
    };
  }
  
  // 辅助方法：判断是否亚军
  isRunnerUp(bracket, userId) {
    const finalMatch = bracket.rounds[bracket.rounds.length - 1].matches[0];
    if (!finalMatch) return false;
    const loser = finalMatch.winner === finalMatch.player1?.id 
      ? finalMatch.player2 
      : finalMatch.player1;
    return loser?.id === userId;
  }
  
  // 辅助方法：判断是否四强
  isSemiFinalist(bracket, userId) {
    if (bracket.rounds.length < 2) return false;
    const semiFinals = bracket.rounds[bracket.rounds.length - 2].matches;
    return semiFinals.some(m => 
      (m.player1?.id === userId || m.player2?.id === userId) && m.winner !== userId
    );
  }
}

module.exports = new TournamentManager();
```

#### 2.4 赛季管理器 (SeasonManager.js)
```javascript
const db = require('../../../shared/db');
const logger = require('../../../shared/logger');
const cron = require('node-cron');

class SeasonManager {
  constructor() {
    this.initializeCronJobs();
  }
  
  // 初始化定时任务
  initializeCronJobs() {
    // 每小时检查赛季状态
    cron.schedule('0 * * * *', () => this.checkSeasonTransition());
    
    // 每天凌晨3点处理段位衰减
    cron.schedule('0 3 * * *', () => this.processRankDecay());
    
    // 每周一早上6点创建周赛
    cron.schedule('0 6 * * 1', () => this.createWeeklyTournament());
  }
  
  // 获取当前赛季
  async getCurrentSeason() {
    const result = await db.query(
      `SELECT * FROM seasons WHERE status = 'active' ORDER BY start_time DESC LIMIT 1`
    );
    return result.rows[0] || null;
  }
  
  // 创建新赛季
  async createSeason(config) {
    const { name, duration, rewards } = config;
    
    // 结束当前赛季
    await this.endCurrentSeason();
    
    // 创建新赛季
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + duration * 24 * 60 * 60 * 1000);
    
    const result = await db.query(
      `INSERT INTO seasons (season_number, name, start_time, end_time, status, config, rewards)
       SELECT COALESCE(MAX(season_number), 0) + 1, $1, $2, $3, 'active', $4, $5
       FROM seasons
       RETURNING *`,
      [name, startTime, endTime, JSON.stringify(config), JSON.stringify(rewards)]
    );
    
    const season = result.rows[0];
    
    logger.info('New season created', { seasonId: season.id, name: season.name });
    
    // 创建赛季锦标赛
    await this.createSeasonTournaments(season.id);
    
    return season;
  }
  
  // 结束当前赛季
  async endCurrentSeason() {
    const currentSeason = await this.getCurrentSeason();
    
    if (!currentSeason) return;
    
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // 更新赛季状态
      await client.query(
        `UPDATE seasons SET status = 'ended', updated_at = NOW() WHERE id = $1`,
        [currentSeason.id]
      );
      
      // 计算并发放赛季奖励
      await this.distributeSeasonRewards(client, currentSeason.id);
      
      // 重置玩家段位（保留部分积分）
      await this.resetPlayerRanks(client, currentSeason.id);
      
      await client.query('COMMIT');
      
      logger.info('Season ended', { seasonId: currentSeason.id });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 发放赛季奖励
  async distributeSeasonRewards(client, seasonId) {
    // 获取所有玩家最终段位
    const ranks = await client.query(
      `SELECT pr.*, u.username
       FROM player_ranks pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.season_id = $1
       ORDER BY pr.rank_points DESC`,
      [seasonId]
    );
    
    const season = await client.query(
      `SELECT * FROM seasons WHERE id = $1`,
      [seasonId]
    );
    
    const rewards = season.rows[0].rewards || {};
    
    for (let i = 0; i < ranks.rows.length; i++) {
      const rank = ranks.rows[i];
      const finalRank = i + 1;
      
      // 根据段位和排名计算奖励
      const tierRewards = rewards[rank.tier] || {};
      const rankRewards = finalRank <= 100 ? rewards.top100?.[finalRank] || {} : {};
      
      const finalRewards = {
        coins: (tierRewards.coins || 0) + (rankRewards.coins || 0),
        items: [...(tierRewards.items || []), ...(rankRewards.items || [])],
        title: finalRank <= 10 ? `Season ${season.rows[0].season_number} Top ${finalRank}` : null,
        avatarFrame: finalRank <= 100 ? `season_${season.rows[0].season_number}_top${finalRank <= 10 ? '10' : '100'}` : null
      };
      
      await client.query(
        `INSERT INTO season_rewards (user_id, season_id, tier, final_rank, rewards)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, season_id) DO UPDATE SET rewards = $5`,
        [rank.user_id, seasonId, rank.tier, finalRank, JSON.stringify(finalRewards)]
      );
    }
    
    logger.info('Season rewards distributed', { seasonId, playerCount: ranks.rows.length });
  }
  
  // 重置玩家段位
  async resetPlayerRanks(client, seasonId) {
    // 软重置：保留部分积分（最高段位的玩家保留更多）
    await client.query(
      `UPDATE player_ranks 
       SET rank_points = FLOOR(rank_points * 0.25),
           tier = 'bronze',
           tier_level = 5,
           wins = 0,
           losses = 0,
           win_streak = 0,
           placement_done = false,
           placement_matches = 0,
           updated_at = NOW()
       WHERE season_id = $1`,
      [seasonId]
    );
  }
  
  // 检查赛季过渡
  async checkSeasonTransition() {
    const currentSeason = await this.getCurrentSeason();
    
    if (!currentSeason) {
      // 没有活跃赛季，创建新的
      await this.createSeason({
        name: `Season ${await this.getNextSeasonNumber()}`,
        duration: 30, // 30天
        rewards: this.getDefaultRewards()
      });
      return;
    }
    
    // 检查是否到期
    if (new Date() >= new Date(currentSeason.end_time)) {
      await this.endCurrentSeason();
      await this.createSeason({
        name: `Season ${await this.getNextSeasonNumber()}`,
        duration: 30,
        rewards: this.getDefaultRewards()
      });
    }
  }
  
  // 处理段位衰减
  async processRankDecay() {
    const currentSeason = await this.getCurrentSeason();
    if (!currentSeason) return;
    
    // 获取需要衰减的玩家
    const result = await db.query(
      `SELECT user_id FROM player_ranks 
       WHERE season_id = $1 
         AND tier IN ('diamond', 'master', 'grandmaster')
         AND last_match_at < NOW() - INTERVAL '7 days'`,
      [currentSeason.id]
    );
    
    for (const row of result.rows) {
      await RankManager.applyDecay(row.user_id, currentSeason.id);
    }
    
    logger.info('Rank decay processed', { count: result.rows.length });
  }
  
  // 获取下一个赛季编号
  async getNextSeasonNumber() {
    const result = await db.query(
      `SELECT COALESCE(MAX(season_number), 0) + 1 as next FROM seasons`
    );
    return result.rows[0].next;
  }
  
  // 获取默认奖励
  getDefaultRewards() {
    return {
      bronze: { coins: 100, items: [{ type: 'bronze_pack', quantity: 1 }] },
      silver: { coins: 200, items: [{ type: 'silver_pack', quantity: 1 }] },
      gold: { coins: 400, items: [{ type: 'gold_pack', quantity: 1 }] },
      platinum: { coins: 600, items: [{ type: 'platinum_pack', quantity: 1 }] },
      diamond: { coins: 1000, items: [{ type: 'diamond_pack', quantity: 1 }] },
      master: { coins: 2000, items: [{ type: 'master_pack', quantity: 1 }] },
      grandmaster: { coins: 5000, items: [{ type: 'grandmaster_pack', quantity: 1 }] },
      top100: {
        1: { coins: 10000, items: [{ type: 'champion_pack', quantity: 1 }] },
        2: { coins: 8000, items: [{ type: 'runner_up_pack', quantity: 1 }] },
        3: { coins: 6000, items: [{ type: 'third_place_pack', quantity: 1 }] }
      }
    };
  }
  
  // 创建赛季锦标赛
  async createSeasonTournaments(seasonId) {
    const season = await db.query(`SELECT * FROM seasons WHERE id = $1`, [seasonId]);
    const seasonNumber = season.rows[0].season_number;
    
    // 创建每日锦标赛
    await db.query(
      `INSERT INTO tournaments (season_id, name, type, format, max_participants, 
                               registration_start, registration_end, start_time, status, rewards)
       VALUES ($1, $2, 'daily', 'elimination', 32, 
               NOW(), NOW() + INTERVAL '23 hours', NOW() + INTERVAL '24 hours', 'registration', $3)`,
      [seasonId, `Daily Cup #${seasonNumber}`, JSON.stringify({ coins: 500, items: [] })]
    );
    
    logger.info('Season tournaments created', { seasonId });
  }
  
  // 创建周赛
  async createWeeklyTournament() {
    const currentSeason = await this.getCurrentSeason();
    if (!currentSeason) return;
    
    await db.query(
      `INSERT INTO tournaments (season_id, name, type, format, max_participants, min_tier,
                               registration_start, registration_end, start_time, status, rewards)
       VALUES ($1, $2, 'weekly', 'elimination', 64, 'gold',
               NOW(), NOW() + INTERVAL '6 days', NOW() + INTERVAL '7 days', 'registration', $3)`,
      [currentSeason.id, `Weekly Championship`, JSON.stringify({ coins: 2000, items: [{ type: 'rare_pack', quantity: 1 }] })]
    );
    
    logger.info('Weekly tournament created');
  }
  
  // 领取赛季奖励
  async claimSeasonRewards(userId, seasonId) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `SELECT * FROM season_rewards 
         WHERE user_id = $1 AND season_id = $2 AND status = 'pending'
         FOR UPDATE`,
        [userId, seasonId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('NO_REWARDS_TO_CLAIM');
      }
      
      const reward = result.rows[0];
      
      // 发放奖励
      // await RewardService.grant(userId, reward.rewards);
      
      // 更新状态
      await client.query(
        `UPDATE season_rewards SET status = 'claimed', claimed_at = NOW() 
         WHERE user_id = $1 AND season_id = $2`,
        [userId, seasonId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Season rewards claimed', { userId, seasonId });
      
      return reward.rewards;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 获取赛季历史
  async getSeasonHistory(userId, limit = 5) {
    const result = await db.query(
      `SELECT s.*, sr.tier, sr.final_rank, sr.rewards, sr.status as reward_status
       FROM seasons s
       LEFT JOIN season_rewards sr ON s.id = sr.season_id AND sr.user_id = $1
       ORDER BY s.start_time DESC
       LIMIT $2`,
      [userId, limit]
    );
    
    return result.rows;
  }
}

module.exports = new SeasonManager();
```

### 3. 前端游戏客户端实现

#### 3.1 赛季与段位界面组件 (SeasonRank.js)
```javascript
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './SeasonRank.css';

const SeasonRank = ({ userId }) => {
  const { t } = useTranslation();
  const [season, setSeason] = useState(null);
  const [rank, setRank] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [activeTab, setActiveTab] = useState('rank');
  
  useEffect(() => {
    loadSeasonData();
  }, [userId]);
  
  const loadSeasonData = async () => {
    try {
      const [seasonRes, rankRes, leaderboardRes] = await Promise.all([
        fetch('/api/gym/season/current').then(r => r.json()),
        fetch('/api/gym/season/rank', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }).then(r => r.json()),
        fetch('/api/gym/season/leaderboard?limit=50').then(r => r.json())
      ]);
      
      setSeason(seasonRes);
      setRank(rankRes);
      setLeaderboard(leaderboardRes.leaderboard);
    } catch (error) {
      console.error('Failed to load season data:', error);
    }
  };
  
  const renderRankCard = () => {
    if (!rank) return <div className="loading">{t('loading')}</div>;
    
    const { tierInfo, progress } = rank;
    
    return (
      <div className="rank-card">
        <div className="tier-badge" style={{ borderColor: tierInfo.color }}>
          <img src={tierInfo.icon} alt={tierInfo.name} className="tier-icon" />
          <div className="tier-name">{tierInfo.name}</div>
        </div>
        
        <div className="rank-stats">
          <div className="stat-item">
            <span className="stat-label">{t('season.rankPoints')}</span>
            <span className="stat-value">{rank.rank.rank_points}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">{t('season.winRate')}</span>
            <span className="stat-value">
              {rank.rank.wins + rank.rank.losses > 0 
                ? `${((rank.rank.wins / (rank.rank.wins + rank.rank.losses)) * 100).toFixed(1)}%`
                : '-'}
            </span>
          </div>
          <div className="stat-item">
            <span className="stat-label">{t('season.winStreak')}</span>
            <span className="stat-value">{rank.rank.win_streak}</span>
          </div>
        </div>
        
        {!progress.isMaxTier && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress.progress}%` }} />
            <div className="progress-text">
              {progress.pointsToNext} {t('season.pointsToNextTier')}
            </div>
          </div>
        )}
        
        <div className="action-buttons">
          {!rank.rank.placement_done ? (
            <button className="btn-primary" onClick={startPlacement}>
              {t('season.startPlacement')} ({rank.rank.placement_matches}/10)
            </button>
          ) : (
            <button className="btn-primary" onClick={findMatch}>
              {t('season.findMatch')}
            </button>
          )}
        </div>
      </div>
    );
  };
  
  const renderLeaderboard = () => {
    return (
      <div className="leaderboard">
        <table>
          <thead>
            <tr>
              <th>{t('season.rank')}</th>
              <th>{t('season.player')}</th>
              <th>{t('season.tier')}</th>
              <th>{t('season.points')}</th>
              <th>{t('season.winRate')}</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.map((player, index) => (
              <tr key={player.userId} className={player.userId === userId ? 'highlight' : ''}>
                <td className={`rank-${index + 1 <= 3 ? index + 1 : ''}`}>
                  {index + 1}
                </td>
                <td>
                  <img src={player.avatar} alt="" className="avatar" />
                  {player.username}
                </td>
                <td>
                  <span className="tier-badge-small" style={{ color: getTierColor(player.tier) }}>
                    {t(`tier.${player.tier}`)} {player.tierLevel}
                  </span>
                </td>
                <td>{player.rankPoints}</td>
                <td>{player.winRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  
  const renderTournaments = () => {
    return (
      <div className="tournaments">
        <h3>{t('season.upcomingTournaments')}</h3>
        {/* 锦标赛列表 */}
      </div>
    );
  };
  
  return (
    <div className="season-container">
      <div className="season-header">
        <h2>{season?.season?.name}</h2>
        <div className="time-remaining">
          {t('season.timeRemaining')}: {season?.timeRemaining?.days}d {season?.timeRemaining?.hours}h
        </div>
      </div>
      
      <div className="tabs">
        <button 
          className={activeTab === 'rank' ? 'active' : ''} 
          onClick={() => setActiveTab('rank')}
        >
          {t('season.myRank')}
        </button>
        <button 
          className={activeTab === 'leaderboard' ? 'active' : ''} 
          onClick={() => setActiveTab('leaderboard')}
        >
          {t('season.leaderboard')}
        </button>
        <button 
          className={activeTab === 'tournaments' ? 'active' : ''} 
          onClick={() => setActiveTab('tournaments')}
        >
          {t('season.tournaments')}
        </button>
      </div>
      
      <div className="tab-content">
        {activeTab === 'rank' && renderRankCard()}
        {activeTab === 'leaderboard' && renderLeaderboard()}
        {activeTab === 'tournaments' && renderTournaments()}
      </div>
    </div>
  );
};

export default SeasonRank;
```

#### 3.2 锦标赛对战树组件 (TournamentBracket.js)
```javascript
import React, { useState, useEffect } from 'react';
import './TournamentBracket.css';

const TournamentBracket = ({ tournamentId }) => {
  const [bracket, setBracket] = useState(null);
  const [selectedMatch, setSelectedMatch] = useState(null);
  
  useEffect(() => {
    loadBracket();
  }, [tournamentId]);
  
  const loadBracket = async () => {
    try {
      const response = await fetch(`/api/gym/tournament/${tournamentId}/bracket`);
      const data = await response.json();
      setBracket(data.bracket);
    } catch (error) {
      console.error('Failed to load bracket:', error);
    }
  };
  
  const renderMatch = (match, roundIndex, matchIndex) => {
    const isCompleted = match.status === 'completed';
    const isLive = match.status === 'in_progress';
    
    return (
      <div 
        key={match.matchId}
        className={`match ${isCompleted ? 'completed' : ''} ${isLive ? 'live' : ''}`}
        onClick={() => setSelectedMatch(match)}
      >
        <div className={`player ${match.winner === match.player1?.id ? 'winner' : ''}`}>
          <span className="seed">{match.player1?.seed}</span>
          <span className="username">{match.player1?.username || 'TBD'}</span>
        </div>
        <div className="vs">VS</div>
        <div className={`player ${match.winner === match.player2?.id ? 'winner' : ''}`}>
          <span className="seed">{match.player2?.seed}</span>
          <span className="username">{match.player2?.username || 'TBD'}</span>
        </div>
      </div>
    );
  };
  
  const renderRound = (round, roundIndex) => {
    return (
      <div key={round.round} className="round">
        <div className="round-header">
          Round {round.round}
          {round.round === bracket.rounds.length && ' (Final)'}
          {round.round === bracket.rounds.length - 1 && ' (Semi-Finals)'}
          {round.round === bracket.rounds.length - 2 && ' (Quarter-Finals)'}
        </div>
        <div className="matches">
          {round.matches.map((match, matchIndex) => renderMatch(match, roundIndex, matchIndex))}
        </div>
      </div>
    );
  };
  
  if (!bracket) {
    return <div className="loading">Loading bracket...</div>;
  }
  
  return (
    <div className="bracket-container">
      <div className="bracket">
        {bracket.rounds.map((round, index) => renderRound(round, index))}
      </div>
      
      {selectedMatch && (
        <div className="match-details">
          <h3>Match Details</h3>
          {/* 比赛详情 */}
        </div>
      )}
    </div>
  );
};

export default TournamentBracket;
```

### 4. 数据库迁移

```sql
-- Migration: 20260618210500_create_season_system.sql

-- 赛季表
CREATE TABLE seasons (
  id SERIAL PRIMARY KEY,
  season_number INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'upcoming',
  config JSONB DEFAULT '{}',
  rewards JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_seasons_status ON seasons(status);
CREATE INDEX idx_seasons_time ON seasons(start_time, end_time);

-- 玩家段位表
CREATE TABLE player_ranks (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season_id INT NOT NULL REFERENCES seasons(id),
  tier VARCHAR(20) NOT NULL,
  tier_level INT DEFAULT 1,
  rank_points INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  win_streak INT DEFAULT 0,
  max_win_streak INT DEFAULT 0,
  highest_tier VARCHAR(20),
  placement_matches INT DEFAULT 0,
  placement_done BOOLEAN DEFAULT FALSE,
  decay_points INT DEFAULT 0,
  last_match_at TIMESTAMP,
  promoted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX idx_player_ranks_season ON player_ranks(season_id);
CREATE INDEX idx_player_ranks_user ON player_ranks(user_id);
CREATE INDEX idx_player_ranks_tier ON player_ranks(season_id, tier, rank_points DESC);

-- 锦标赛表
CREATE TABLE tournaments (
  id SERIAL PRIMARY KEY,
  season_id INT REFERENCES seasons(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL,
  format VARCHAR(50) NOT NULL,
  min_tier VARCHAR(20),
  max_participants INT DEFAULT 64,
  current_participants INT DEFAULT 0,
  registration_start TIMESTAMP NOT NULL,
  registration_end TIMESTAMP NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  status VARCHAR(20) DEFAULT 'upcoming',
  bracket JSONB DEFAULT '{}',
  rewards JSONB DEFAULT '{}',
  entry_fee JSONB DEFAULT '{}',
  rules JSONB DEFAULT '{}',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tournaments_season ON tournaments(season_id);
CREATE INDEX idx_tournaments_status ON tournaments(status);
CREATE INDEX idx_tournaments_time ON tournaments(start_time);

-- 锦标赛参与者表
CREATE TABLE tournament_participants (
  id SERIAL PRIMARY KEY,
  tournament_id INT NOT NULL REFERENCES tournaments(id),
  user_id INT NOT NULL REFERENCES users(id),
  seed INT,
  current_round INT DEFAULT 0,
  match_wins INT DEFAULT 0,
  match_losses INT DEFAULT 0,
  eliminated BOOLEAN DEFAULT FALSE,
  final_rank INT,
  prizes_claimed BOOLEAN DEFAULT FALSE,
  registered_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tournament_id, user_id)
);

CREATE INDEX idx_tournament_participants_tournament ON tournament_participants(tournament_id);
CREATE INDEX idx_tournament_participants_user ON tournament_participants(user_id);

-- 对战记录表
CREATE TABLE battle_records (
  id SERIAL PRIMARY KEY,
  season_id INT NOT NULL REFERENCES seasons(id),
  tournament_id INT REFERENCES tournaments(id),
  attacker_id INT NOT NULL REFERENCES users(id),
  defender_id INT NOT NULL REFERENCES users(id),
  attacker_pokemon JSONB NOT NULL,
  defender_pokemon JSONB NOT NULL,
  result VARCHAR(20) NOT NULL,
  battle_type VARCHAR(50) NOT NULL,
  rank_points_change INT DEFAULT 0,
  battle_duration INT,
  battle_data JSONB DEFAULT '{}',
  rewards JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_battle_records_season ON battle_records(season_id);
CREATE INDEX idx_battle_records_attacker ON battle_records(attacker_id, created_at DESC);
CREATE INDEX idx_battle_records_defender ON battle_records(defender_id, created_at DESC);
CREATE INDEX idx_battle_records_tournament ON battle_records(tournament_id);

-- 赛季奖励发放记录表
CREATE TABLE season_rewards (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  season_id INT NOT NULL REFERENCES seasons(id),
  tier VARCHAR(20) NOT NULL,
  final_rank INT,
  rewards JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX idx_season_rewards_user ON season_rewards(user_id);
CREATE INDEX idx_season_rewards_season ON season_rewards(season_id);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_seasons_updated_at BEFORE UPDATE ON seasons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_player_ranks_updated_at BEFORE UPDATE ON player_ranks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tournaments_updated_at BEFORE UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## 验收标准

- [ ] 赛季系统可正常创建、启动、结束赛季
- [ ] 玩家段位根据积分自动计算和更新
- [ ] 定位赛（10场）可正常进行并确定初始段位
- [ ] 排位赛匹配系统能匹配相近段位的玩家
- [ ] 连胜奖励机制正常生效
- [ ] 段位升降级逻辑正确执行
- [ ] 锦标赛报名、取消报名功能正常
- [ ] 锦标赛对战树正确生成并可视化
- [ ] 锦标赛比赛结果正确上报和晋级
- [ ] 赛季奖励根据段位和排名正确发放
- [ ] 排行榜数据实时更新
- [ ] 段位衰减机制按时执行
- [ ] 前端赛季界面展示正确
- [ ] 前端对战树可视化清晰
- [ ] 所有API接口响应时间 < 200ms
- [ ] 单元测试覆盖率 > 80%

## 影响范围

### 新增文件
- `backend/services/gym-service/src/routes/season.js` - 赛季路由
- `backend/services/gym-service/src/routes/tournament.js` - 锦标赛路由
- `backend/services/gym-service/src/services/SeasonManager.js` - 赛季管理器
- `backend/services/gym-service/src/services/RankManager.js` - 段位管理器
- `backend/services/gym-service/src/services/TournamentManager.js` - 锦标赛管理器
- `backend/services/gym-service/src/services/Matchmaker.js` - 匹配器
- `database/migrations/20260618210500_create_season_system.sql` - 数据库迁移
- `game-client/src/components/SeasonRank.js` - 赛季段位组件
- `game-client/src/components/TournamentBracket.js` - 对战树组件
- `game-client/src/components/TournamentList.js` - 锦标赛列表组件
- `game-client/src/styles/SeasonRank.css` - 样式文件
- `game-client/src/styles/TournamentBracket.css` - 样式文件

### 修改文件
- `backend/services/gym-service/src/index.js` - 挂载路由
- `backend/services/gym-service/src/routes/index.js` - 导出路由
- `backend/shared/middleware/auth.js` - 可能需要扩展认证
- `game-client/src/i18n/locales/en/translation.json` - 英文翻译
- `game-client/src/i18n/locales/zh/translation.json` - 中文翻译

### 涉及服务
- **gym-service**: 赛季、段位、锦标赛核心逻辑
- **pokemon-service**: 参战精灵数据查询
- **user-service**: 玩家信息查询
- **reward-service**: 奖励发放
- **social-service**: 排行榜社交功能
- **gateway**: API 网关路由
- **game-client**: 前端界面

## 参考

- [Pokémon GO Battle League](https://pokemongolive.com/battle)
- [League of Legends Ranked System](https://www.leagueoflegends.com/en-us/news/game-updates/explaining-ranked/)
- [Overwatch Competitive Play](https://playoverwatch.com/en-us/game/competitive/)
- [PUBG Ranked System](https://www.pubg.com/guides/ranked/)
