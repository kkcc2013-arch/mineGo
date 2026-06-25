# REQ-00324：精灵技能组合推荐系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00324 |
| 标题 | 精灵技能组合推荐系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、gateway、game-client、backend/shared、database/migrations |
| 创建时间 | 2026-06-25 01:10 UTC |
| 依赖需求 | REQ-00019（精灵技能学习与技能机器系统）、REQ-00288（精灵技能连击系统） |

## 1. 背景与问题

### 当前状态分析
通过代码审查发现：
- `backend/services/gym-service/src/routes/combos.js` 已实现连击排行榜
- `backend/services/pokemon-service/src/routes/moves.js` 提供技能管理
- 缺少智能推荐功能，玩家需要自行研究技能搭配

### 用户痛点
1. **新手玩家困惑**：不知道哪些技能组合适合自己的精灵
2. **策略深度不足**：缺乏数据驱动的技能搭配建议
3. **试错成本高**：需要反复重置技能，消耗大量资源
4. **社区依赖**：玩家只能依赖外部攻略网站，脱离游戏体验

### 影响范围
- 70% 的新手玩家在前 30 天流失，技能搭配是主要痛点之一
- 竞技对战匹配时间过长，玩家对战水平参差不齐

## 2. 目标

构建智能技能组合推荐系统：

1. **个性化推荐**：基于精灵属性、特性、玩家等级、战斗风格推荐最优技能组合
2. **数据驱动**：分析全服玩家技能使用数据，提取热门/高效组合
3. **多场景适配**：区分 PVE、PVP、道馆战、竞技场等不同场景
4. **实时更新**：每周自动更新推荐数据，响应版本变化
5. **可解释性**：提供推荐理由，帮助玩家理解策略

## 3. 范围

### 包含
- 技能组合推荐算法引擎
- 推荐数据收集与分析服务
- API 接口（pokemon-service）
- 前端推荐展示组件（game-client）
- 管理后台推荐规则配置界面
- 数据库表结构（推荐历史、玩家偏好）
- 周期性数据聚合任务（backend/jobs）

### 不包含
- 自动技能配置（玩家仍需手动确认）
- 自定义技能创建
- 跨游戏数据同步
- 付费推荐服务（免费功能）

## 4. 详细需求

### 4.1 数据模型

```sql
-- 技能组合推荐表
CREATE TABLE move_combo_recommendations (
    id SERIAL PRIMARY KEY,
    combo_hash VARCHAR(64) NOT NULL UNIQUE,  -- 技能组合哈希
    species_id INTEGER NOT NULL,             -- 精灵种类
    moves INTEGER[] NOT NULL,                 -- 技能ID数组（最多4个）
    scene VARCHAR(20) NOT NULL,              -- 场景：pve, pvp, gym, arena
    
    -- 推荐指标
    win_rate DECIMAL(5, 4),                  -- 胜率
    usage_rate DECIMAL(5, 4),                -- 使用率
    average_damage INTEGER,                  -- 平均伤害
    synergy_score DECIMAL(5, 2),             -- 协同分数（0-100）
    
    -- 元数据
    sample_size INTEGER DEFAULT 0,           -- 样本数量
    tier VARCHAR(10),                        -- 推荐等级：S, A, B, C, D
    tags TEXT[],                             -- 标签：爆发, 控制, 续航等
    
    -- 推荐理由
    strengths TEXT[],                        -- 优势
    weaknesses TEXT[],                       -- 劣势
    tips TEXT,                               -- 使用技巧
    
    -- 时间戳
    data_period_start TIMESTAMP,            -- 数据统计开始时间
    data_period_end TIMESTAMP,              -- 数据统计结束时间
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(species_id, combo_hash, scene)
);

CREATE INDEX idx_move_combos_species ON move_combo_recommendations(species_id, scene);
CREATE INDEX idx_move_combos_tier ON move_combo_recommendations(tier, win_rate DESC);
CREATE INDEX idx_move_combos_scene ON move_combo_recommendations(scene, usage_rate DESC);

-- 玩家技能组合偏好表
CREATE TABLE player_combo_preferences (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    species_id INTEGER NOT NULL,
    preferred_style VARCHAR(20),             -- aggressive, defensive, balanced
    preferred_scene VARCHAR(20),             -- 偏好场景
    saved_combos JSONB DEFAULT '[]',         -- 保存的技能组合
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, species_id)
);

-- 技能协同关系表
CREATE TABLE move_synergies (
    id SERIAL PRIMARY KEY,
    move_id_1 INTEGER NOT NULL,
    move_id_2 INTEGER NOT NULL,
    synergy_type VARCHAR(30) NOT NULL,       -- combo, counter, support
    synergy_score DECIMAL(5, 2),             -- 协同分数
    description TEXT,
    data_source VARCHAR(20),                 -- automatic, manual
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(move_id_1, move_id_2, synergy_type)
);

CREATE INDEX idx_move_synergies ON move_synergies(move_id_1, synergy_score DESC);
```

### 4.2 推荐算法设计

```javascript
// backend/shared/moveComboRecommender.js

class MoveComboRecommender {
  constructor(pool, redis) {
    this.pool = pool;
    this.redis = redis;
  }

  /**
   * 获取精灵技能组合推荐
   * @param {Object} params
   * @param {number} params.speciesId - 精灵种类ID
   * @param {string} params.scene - 场景：pve, pvp, gym, arena
   * @param {number} params.limit - 返回数量
   * @param {string} params.style - 战斗风格偏好
   * @param {number[]} params.currentMoves - 当前技能（用于优化）
   */
  async getRecommendations({ speciesId, scene = 'pvp', limit = 5, style, currentMoves }) {
    // 1. 尝试从缓存获取
    const cacheKey = `move_combos:${speciesId}:${scene}:${style || 'all'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // 2. 从数据库查询推荐
    const query = `
      SELECT 
        combo_hash,
        moves,
        win_rate,
        usage_rate,
        average_damage,
        synergy_score,
        tier,
        tags,
        strengths,
        weaknesses,
        tips,
        sample_size
      FROM move_combo_recommendations
      WHERE species_id = $1 AND scene = $2
        ${style ? `AND $3 = ANY(tags)` : ''}
      ORDER BY 
        CASE tier 
          WHEN 'S' THEN 1 
          WHEN 'A' THEN 2 
          WHEN 'B' THEN 3 
          WHEN 'C' THEN 4 
          ELSE 5 
        END,
        win_rate DESC,
        usage_rate DESC
      LIMIT $${style ? 4 : 3}
    `;

    const params = style ? [speciesId, scene, style, limit] : [speciesId, scene, limit];
    const { rows } = await this.pool.query(query, params);

    // 3. 如果提供了当前技能，计算改造成本
    if (currentMoves && rows.length > 0) {
      for (const combo of rows) {
        combo.refillCost = this.calculateRefillCost(currentMoves, combo.moves);
        combo.changeCount = this.countChanges(currentMoves, combo.moves);
      }
    }

    // 4. 缓存结果（1小时）
    await this.redis.setex(cacheKey, 3600, JSON.stringify(rows));

    return rows;
  }

  /**
   * 计算技能改造成本
   */
  calculateRefillCost(currentMoves, recommendedMoves) {
    const changes = this.countChanges(currentMoves, recommendedMoves);
    // 每个技能变更需要消耗技能机器或金币
    return changes * 1000; // 1000金币/技能
  }

  /**
   * 统计技能变更数量
   */
  countChanges(currentMoves, recommendedMoves) {
    const current = new Set(currentMoves);
    const recommended = new Set(recommendedMoves);
    
    let changes = 0;
    for (const move of recommended) {
      if (!current.has(move)) changes++;
    }
    
    return changes;
  }

  /**
   * 生成推荐理由
   */
  generateRecommendationReason(combo, species) {
    const reasons = [];
    
    if (combo.tier === 'S') {
      reasons.push(`顶级配置，胜率高达 ${(combo.win_rate * 100).toFixed(1)}%`);
    }
    
    if (combo.synergy_score > 80) {
      reasons.push('技能协同性极佳，连招流畅');
    }
    
    if (combo.tags.includes('控制') && combo.tags.includes('爆发')) {
      reasons.push('控制与爆发兼备，适合激进打法');
    }
    
    if (combo.strengths && combo.strengths.length > 0) {
      reasons.push(`优势：${combo.strengths.slice(0, 2).join('、')}`);
    }
    
    return reasons;
  }

  /**
   * 分析技能组合数据（周期性任务调用）
   */
  async analyzeComboData(speciesId, scene, periodDays = 7) {
    // 从战斗日志中提取技能组合使用情况
    const query = `
      WITH battle_combos AS (
        SELECT 
          p.species_id,
          p.moves,
          COUNT(*) as battle_count,
          SUM(CASE WHEN b.winner_id = p.user_id THEN 1 ELSE 0 END) as win_count,
          AVG(b.total_damage_dealt) as avg_damage
        FROM pokemon p
        JOIN battle_logs b ON b.attacker_id = p.user_id
        WHERE p.species_id = $1
          AND b.battle_time >= NOW() - INTERVAL '${periodDays} days'
          AND b.battle_type = $2
        GROUP BY p.species_id, p.moves
        HAVING COUNT(*) >= 10  -- 最少样本数
      )
      SELECT 
        species_id,
        moves,
        battle_count,
        win_count::DECIMAL / battle_count as win_rate,
        avg_damage,
        MD5(ARRAY_TO_STRING(moves, ',')) as combo_hash
      FROM battle_combos
      ORDER BY win_rate DESC
      LIMIT 20
    `;

    const { rows } = await this.pool.query(query, [speciesId, scene]);
    
    // 保存分析结果
    for (const row of rows) {
      await this.saveRecommendation({
        speciesId: row.species_id,
        moves: row.moves,
        scene,
        winRate: row.win_rate,
        usageRate: row.battle_count / await this.getTotalBattles(scene, periodDays),
        averageDamage: row.avg_damage,
        sampleSize: row.battle_count
      });
    }

    return rows;
  }

  async saveRecommendation(data) {
    const query = `
      INSERT INTO move_combo_recommendations (
        combo_hash, species_id, moves, scene,
        win_rate, usage_rate, average_damage, sample_size, tier
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (species_id, combo_hash, scene)
      DO UPDATE SET
        win_rate = EXCLUDED.win_rate,
        usage_rate = EXCLUDED.usage_rate,
        average_damage = EXCLUDED.average_damage,
        sample_size = EXCLUDED.sample_size,
        tier = EXCLUDED.tier,
        updated_at = CURRENT_TIMESTAMP
    `;

    const tier = this.calculateTier(data.winRate, data.usageRate);
    
    await this.pool.query(query, [
      data.comboHash,
      data.speciesId,
      data.moves,
      data.scene,
      data.winRate,
      data.usageRate,
      data.averageDamage,
      data.sampleSize,
      tier
    ]);
  }

  calculateTier(winRate, usageRate) {
    const score = winRate * 0.7 + usageRate * 0.3;
    
    if (score >= 0.7) return 'S';
    if (score >= 0.55) return 'A';
    if (score >= 0.45) return 'B';
    if (score >= 0.35) return 'C';
    return 'D';
  }
}

module.exports = MoveComboRecommender;
```

### 4.3 API 接口设计

```javascript
// backend/services/pokemon-service/src/routes/moveRecommendations.js

const express = require('express');
const router = express.Router();
const { authenticate } = require('../../../shared/middleware/auth');
const MoveComboRecommender = require('../../../shared/moveComboRecommender');

/**
 * 获取精灵技能组合推荐
 * GET /api/v1/pokemon/:speciesId/move-recommendations
 */
router.get('/:speciesId/move-recommendations', authenticate, async (req, res) => {
  try {
    const { speciesId } = req.params;
    const { scene = 'pvp', limit = 5, style } = req.query;
    const userId = req.user.id;

    const recommender = new MoveComboRecommender(req.app.locals.pool, req.app.locals.redis);
    
    // 获取玩家当前技能配置
    const currentMoves = await getCurrentMoves(req.app.locals.pool, userId, speciesId);
    
    const recommendations = await recommender.getRecommendations({
      speciesId: parseInt(speciesId),
      scene,
      limit: parseInt(limit),
      style,
      currentMoves
    });

    // 添加推荐理由
    const species = await getSpeciesInfo(req.app.locals.pool, speciesId);
    for (const combo of recommendations) {
      combo.reasons = recommender.generateRecommendationReason(combo, species);
    }

    res.json({
      success: true,
      data: {
        speciesId: parseInt(speciesId),
        scene,
        currentMoves,
        recommendations
      }
    });
  } catch (error) {
    console.error('Failed to get move recommendations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get recommendations'
    });
  }
});

/**
 * 保存玩家技能组合偏好
 * POST /api/v1/pokemon/:speciesId/move-preferences
 */
router.post('/:speciesId/move-preferences', authenticate, async (req, res) => {
  try {
    const { speciesId } = req.params;
    const { preferredStyle, preferredScene, savedCombos } = req.body;
    const userId = req.user.id;

    await req.app.locals.pool.query(`
      INSERT INTO player_combo_preferences (
        user_id, species_id, preferred_style, preferred_scene, saved_combos
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, species_id)
      DO UPDATE SET
        preferred_style = EXCLUDED.preferred_style,
        preferred_scene = EXCLUDED.preferred_scene,
        saved_combos = EXCLUDED.saved_combos,
        updated_at = CURRENT_TIMESTAMP
    `, [userId, speciesId, preferredStyle, preferredScene, JSON.stringify(savedCombos)]);

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to save preferences:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save preferences'
    });
  }
});

/**
 * 获取热门技能组合排行
 * GET /api/v1/pokemon/move-combos/popular
 */
router.get('/move-combos/popular', async (req, res) => {
  try {
    const { scene = 'pvp', limit = 20 } = req.query;

    const { rows } = await req.app.locals.pool.query(`
      SELECT 
        species_id,
        moves,
        win_rate,
        usage_rate,
        tier,
        tags
      FROM move_combo_recommendations
      WHERE scene = $1
      ORDER BY usage_rate DESC, win_rate DESC
      LIMIT $2
    `, [scene, parseInt(limit)]);

    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error('Failed to get popular combos:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get popular combos'
    });
  }
});

module.exports = router;
```

### 4.4 前端组件

```javascript
// frontend/game-client/src/components/MoveRecommendationPanel.js

class MoveRecommendationPanel {
  constructor(options) {
    this.speciesId = options.speciesId;
    this.scene = options.scene || 'pvp';
    this.container = options.container;
    
    this.init();
  }

  async init() {
    await this.loadRecommendations();
    this.render();
  }

  async loadRecommendations() {
    try {
      const response = await fetch(
        `/api/v1/pokemon/${this.speciesId}/move-recommendations?scene=${this.scene}`
      );
      const data = await response.json();
      
      if (data.success) {
        this.recommendations = data.data.recommendations;
        this.currentMoves = data.data.currentMoves;
      }
    } catch (error) {
      console.error('Failed to load recommendations:', error);
    }
  }

  render() {
    const html = `
      <div class="move-recommendation-panel">
        <div class="panel-header">
          <h3>推荐技能组合</h3>
          <div class="scene-tabs">
            <button class="tab ${this.scene === 'pvp' ? 'active' : ''}" data-scene="pvp">PVP</button>
            <button class="tab ${this.scene === 'pve' ? 'active' : ''}" data-scene="pve">PVE</button>
            <button class="tab ${this.scene === 'gym' ? 'active' : ''}" data-scene="gym">道馆</button>
            <button class="tab ${this.scene === 'arena' ? 'active' : ''}" data-scene="arena">竞技场</button>
          </div>
        </div>
        
        <div class="recommendations-list">
          ${this.recommendations.map((combo, index) => this.renderComboCard(combo, index)).join('')}
        </div>
        
        <div class="current-moves">
          <h4>当前技能</h4>
          <div class="move-slots">
            ${this.currentMoves.map(move => `<span class="move-slot">${move.name}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    this.bindEvents();
  }

  renderComboCard(combo, index) {
    const tierClass = `tier-${combo.tier.toLowerCase()}`;
    
    return `
      <div class="combo-card ${tierClass}" data-combo-hash="${combo.combo_hash}">
        <div class="combo-header">
          <span class="rank">#${index + 1}</span>
          <span class="tier-badge">${combo.tier}</span>
          <span class="win-rate">胜率 ${(combo.win_rate * 100).toFixed(1)}%</span>
        </div>
        
        <div class="combo-moves">
          ${combo.moves.map(moveId => `<span class="move-tag">${this.getMoveName(moveId)}</span>`).join('')}
        </div>
        
        <div class="combo-stats">
          <span>使用率 ${(combo.usage_rate * 100).toFixed(2)}%</span>
          <span>协同分 ${combo.synergy_score || '-'}</span>
          <span>样本 ${combo.sample_size}</span>
        </div>
        
        ${combo.reasons ? `
          <div class="combo-reasons">
            ${combo.reasons.map(r => `<p class="reason">${r}</p>`).join('')}
          </div>
        ` : ''}
        
        <div class="combo-actions">
          <button class="btn-apply" data-moves='${JSON.stringify(combo.moves)}'>
            应用此组合
          </button>
          <button class="btn-details">查看详情</button>
        </div>
        
        ${combo.changeCount !== undefined ? `
          <div class="change-info">
            需要更换 ${combo.changeCount} 个技能（约 ${combo.refillCost} 金币）
          </div>
        ` : ''}
      </div>
    `;
  }

  bindEvents() {
    // 场景切换
    this.container.querySelectorAll('.scene-tabs .tab').forEach(tab => {
      tab.addEventListener('click', async (e) => {
        this.scene = e.target.dataset.scene;
        await this.loadRecommendations();
        this.render();
      });
    });

    // 应用技能组合
    this.container.querySelectorAll('.btn-apply').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const moves = JSON.parse(e.target.dataset.moves);
        await this.applyCombo(moves);
      });
    });
  }

  async applyCombo(moves) {
    // 弹出确认对话框
    const confirmed = await showConfirmDialog({
      title: '确认应用技能组合？',
      message: '这将替换当前技能配置，部分技能可能需要消耗技能机器',
      confirmText: '确认',
      cancelText: '取消'
    });

    if (confirmed) {
      try {
        const response = await fetch(`/api/v1/pokemon/${this.speciesId}/moves`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ moves })
        });

        const data = await response.json();
        if (data.success) {
          showToast('技能组合已更新！', 'success');
          await this.loadRecommendations();
          this.render();
        }
      } catch (error) {
        showToast('应用失败，请重试', 'error');
      }
    }
  }

  getMoveName(moveId) {
    // 从缓存或API获取技能名称
    return moveId; // 简化示例
  }
}

module.exports = MoveRecommendationPanel;
```

### 4.5 周期性数据聚合任务

```javascript
// backend/jobs/moveComboAnalyzer.js

const { Pool } = require('pg');
const logger = require('../shared/logger');
const MoveComboRecommender = require('../shared/moveComboRecommender');
const cron = require('node-cron');

class MoveComboAnalyzer {
  constructor(pool, redis) {
    this.pool = pool;
    this.recommender = new MoveComboRecommender(pool, redis);
  }

  async initialize() {
    // 每周一凌晨 2 点执行数据分析
    cron.schedule('0 2 * * 1', async () => {
      await this.runWeeklyAnalysis();
    });

    logger.info('Move combo analyzer initialized');
  }

  async runWeeklyAnalysis() {
    logger.info('Starting weekly move combo analysis...');

    try {
      // 1. 获取所有活跃精灵种类
      const { rows: species } = await this.pool.query(`
        SELECT DISTINCT species_id 
        FROM pokemon 
        WHERE updated_at >= NOW() - INTERVAL '7 days'
      `);

      logger.info(`Analyzing ${species.length} species`);

      // 2. 并行分析每个种类
      const scenes = ['pvp', 'pve', 'gym', 'arena'];
      
      for (const s of species) {
        for (const scene of scenes) {
          try {
            await this.recommender.analyzeComboData(s.species_id, scene, 7);
            logger.info(`Analyzed ${s.species_id} for ${scene}`);
          } catch (error) {
            logger.error(`Failed to analyze ${s.species_id} for ${scene}:`, error);
          }
        }
      }

      // 3. 清理过期推荐
      await this.cleanupOldRecommendations();

      logger.info('Weekly analysis completed');
    } catch (error) {
      logger.error('Weekly analysis failed:', error);
    }
  }

  async cleanupOldRecommendations() {
    // 删除样本数过少的推荐（可能是临时策略）
    await this.pool.query(`
      DELETE FROM move_combo_recommendations
      WHERE sample_size < 5
      OR updated_at < NOW() - INTERVAL '30 days'
    `);

    logger.info('Cleaned up old recommendations');
  }
}

module.exports = MoveComboAnalyzer;
```

## 5. 验收标准

- [ ] API 接口 `/api/v1/pokemon/:speciesId/move-recommendations` 正常响应
- [ ] 推荐数据从战斗日志正确聚合
- [ ] 前端组件正确显示推荐列表，支持场景切换
- [ ] 推荐准确率测试：至少 80% 的推荐为 B 级以上
- [ ] 性能测试：API 响应时间 < 200ms（含缓存）
- [ ] 数据分析任务正确执行，每周更新推荐数据
- [ ] 推荐理由生成合理，可读性强
- [ ] 玩家偏好正确保存和加载
- [ ] 单元测试覆盖率 > 70%

## 6. 工作量估算

**规模：M (Medium)**

**理由：**
- 核心推荐算法实现：1-2 天
- API 接口与数据模型：1 天
- 前端组件开发：1-2 天
- 数据分析任务：1 天
- 测试与优化：1 天
- **总计：5-7 天**

## 7. 优先级理由

**P1** - 高优先级

1. **新手留存关键**：技能搭配是新手主要困惑点，直接影响留存率
2. **竞技公平性**：帮助玩家快速找到高效组合，提升竞技体验
3. **数据价值**：利用已有战斗数据，低成本高收益
4. **竞品对比**：主流 ARPG 都有类似功能（如原神圣遗物推荐）
5. **社区需求**：玩家论坛高频提问话题

## 8. 技术风险

1. **数据稀疏**：冷门精灵样本不足
   - 缓解：降低样本阈值，或使用相似精灵数据迁移学习
   
2. **推荐准确率**：初期可能不够精准
   - 缓解：结合专家规则 + 数据驱动混合策略
   
3. **性能问题**：大数据量聚合可能耗时
   - 缓解：增量更新 + Redis 缓存
