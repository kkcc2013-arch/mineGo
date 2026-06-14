# REQ-00210: 精灵亲密度进化计算与提示系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00210 |
| 标题 | 精灵亲密度进化计算与提示系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | pokemon-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-14 21:00 |

## 需求描述

为精灵亲密度进化提供精确的计算引擎和玩家提示系统。部分精灵（如皮卡丘、伊布、吉利蛋等）需要达到特定亲密度才能进化，当前系统缺乏明确的亲密度进度追踪和进化前置条件提示，导致玩家无法有效规划进化路径。

**核心功能**：
1. 亲密度实时计算与追踪
2. 进化前置条件检测与提示
3. 亲密度提升方式推荐
4. 进化预览与属性预测
5. 历史亲密度变化日志

## 技术方案

### 1. 数据库模型扩展

```sql
-- 亲密度记录表
CREATE TABLE pokemon_friendship_logs (
  id SERIAL PRIMARY KEY,
  pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  change_amount INTEGER NOT NULL,        -- 亲密度变化量（正/负）
  source VARCHAR(50) NOT NULL,           -- 变化来源：walk, battle, feed, spa, gift, trade
  context JSONB DEFAULT '{}',            -- 额外上下文信息
  previous_value INTEGER NOT NULL,       -- 变化前值
  new_value INTEGER NOT NULL,            -- 变化后值
  created_at TIMESTAMP DEFAULT NOW()
);

-- 亲密度进化规则表
CREATE TABLE friendship_evolution_rules (
  id SERIAL PRIMARY KEY,
  species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  target_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  required_friendship INTEGER NOT NULL DEFAULT 220,  -- 默认220（标准亲密度进化阈值）
  time_restriction VARCHAR(20),          -- 'day', 'night', null（昼夜限制）
  additional_conditions JSONB DEFAULT '{}', -- 其他条件（如携带道具）
  evolution_method VARCHAR(50) DEFAULT 'level_up'  -- level_up, trade, item
);

CREATE INDEX idx_friendship_logs_pokemon ON pokemon_friendship_logs(pokemon_instance_id, created_at DESC);
CREATE INDEX idx_friendship_rules_species ON friendship_evolution_rules(species_id);

-- 修改 pokemon_instances 表添加亲密度字段
ALTER TABLE pokemon_instances 
ADD COLUMN IF NOT EXISTS friendship INTEGER DEFAULT 70,  -- 默认亲密度70
ADD COLUMN IF NOT EXISTS friendship_updated_at TIMESTAMP DEFAULT NOW();

-- 已有数据初始化亲密度
UPDATE pokemon_instances SET friendship = 70 WHERE friendship IS NULL;
```

### 2. 亲密度计算引擎

```javascript
// pokemon-service/src/friendshipCalculator.js
'use strict';

const FRIENDSHIP_LEVELS = {
  MIN: 0,
  BASE_CAPTURE: 70,           // 捕获时基础值
  BASE_HATCH: 120,            // 孵化时基础值
  BASE_TRADE: 70,             // 交易后基础值
  EVOLUTION_THRESHOLD: 220,   // 标准进化阈值
  MAX: 255
};

const FRIENDSHIP_SOURCES = {
  WALK: { amount: 1, description: '行走1km' },
  BATTLE_WIN: { amount: 1, description: '赢得道馆战斗' },
  BATTLE_RAID: { amount: 3, description: '赢得Raid战斗' },
  FEED_BERRY: { amount: 1, description: '喂食树果' },
  FEED_GOLDEN_BERRY: { amount: 3, description: '喂食金果' },
  SPA_TREATMENT: { amount: 2, description: '温泉护理' },
  GIFT_RECEIVE: { amount: 2, description: '收到好友礼物' },
  TRADE_AWAY: { amount: -20, description: '被交易出去' },
  FAINT: { amount: -1, description: '战斗中濒死' },
  ENERGY_DRINK: { amount: -1, description: '使用能量饮料' }
};

class FriendshipCalculator {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * 获取精灵当前亲密度及等级描述
   */
  async getFriendshipStatus(pokemonId) {
    const { rows: [pokemon] } = await this.db.query(`
      SELECT id, species_id, friendship, friendship_updated_at,
             s.name as species_name
      FROM pokemon_instances pi
      JOIN pokemon_species s ON pi.species_id = s.id
      WHERE pi.id = $1
    `, [pokemonId]);

    if (!pokemon) throw new Error('Pokemon not found');

    const level = this.getFriendshipLevel(pokemon.friendship);
    const progress = this.calculateEvolutionProgress(pokemon);

    return {
      ...pokemon,
      friendshipLevel: level,
      evolutionProgress: progress,
      canEvolve: progress.ready
    };
  }

  /**
   * 亲密度等级描述
   */
  getFriendshipLevel(value) {
    if (value >= 255) return { name: 'best_friends', label: '挚友', color: '#FFD700' };
    if (value >= 220) return { name: 'great_friends', label: '至交', color: '#FF69B4' };
    if (value >= 150) return { name: 'good_friends', label: '好友', color: '#87CEEB' };
    if (value >= 100) return { name: 'friends', label: '朋友', color: '#90EE90' };
    if (value >= 50) return { name: 'buddy', label: '伙伴', color: '#DDA0DD' };
    return { name: 'stranger', label: '陌生', color: '#A9A9A9' };
  }

  /**
   * 计算进化进度
   */
  async calculateEvolutionProgress(pokemon) {
    const { rows: rules } = await this.db.query(`
      SELECT fer.*, ps.name as target_name
      FROM friendship_evolution_rules fer
      JOIN pokemon_species ps ON fer.target_species_id = ps.id
      WHERE fer.species_id = $1
    `, [pokemon.species_id]);

    if (rules.length === 0) {
      return { hasEvolution: false, ready: false };
    }

    // 取第一个适用规则（简化处理，实际可能需要多条件检测）
    const rule = rules[0];
    const percentage = Math.min(100, (pokemon.friendship / rule.required_friendship) * 100);
    const needed = Math.max(0, rule.required_friendship - pokemon.friendship);

    // 检查时间限制
    let timeReady = true;
    let currentTimePeriod = null;
    if (rule.time_restriction) {
      const hour = new Date().getHours();
      currentTimePeriod = (hour >= 6 && hour < 18) ? 'day' : 'night';
      timeReady = rule.time_restriction === currentTimePeriod;
    }

    return {
      hasEvolution: true,
      targetSpecies: rule.target_name,
      requiredFriendship: rule.required_friendship,
      currentFriendship: pokemon.friendship,
      percentage: Math.round(percentage),
      needed: needed,
      ready: pokemon.friendship >= rule.required_friendship && timeReady,
      timeRestriction: rule.time_restriction,
      currentTimePeriod,
      timeReady
    };
  }

  /**
   * 增加亲密度
   */
  async addFriendship(pokemonId, source, amount = null, context = {}) {
    const sourceConfig = FRIENDSHIP_SOURCES[source];
    if (!sourceConfig) throw new Error(`Invalid friendship source: ${source}`);

    const changeAmount = amount !== null ? amount : sourceConfig.amount;

    return await this.db.transaction(async (client) => {
      // 获取当前值
      const { rows: [current] } = await client.query(`
        SELECT friendship FROM pokemon_instances WHERE id = $1 FOR UPDATE
      `, [pokemonId]);

      if (!current) throw new Error('Pokemon not found');

      const previousValue = current.friendship;
      const newValue = Math.max(FRIENDSHIP_LEVELS.MIN, 
                        Math.min(FRIENDSHIP_LEVELS.MAX, previousValue + changeAmount));

      // 更新亲密度
      await client.query(`
        UPDATE pokemon_instances 
        SET friendship = $1, friendship_updated_at = NOW()
        WHERE id = $2
      `, [newValue, pokemonId]);

      // 记录日志
      await client.query(`
        INSERT INTO pokemon_friendship_logs 
        (pokemon_instance_id, change_amount, source, context, previous_value, new_value)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [pokemonId, changeAmount, source, context, previousValue, newValue]);

      // 检查是否触发进化条件
      const evolutionCheck = await this.checkEvolutionTrigger(pokemonId, newValue);

      return {
        previousValue,
        newValue,
        change: changeAmount,
        evolutionReady: evolutionCheck.ready,
        evolutionTarget: evolutionCheck.target
      };
    });
  }

  /**
   * 检查进化触发条件
   */
  async checkEvolutionTrigger(pokemonId, currentFriendship) {
    const { rows: [pokemon] } = await this.db.query(`
      SELECT species_id FROM pokemon_instances WHERE id = $1
    `, [pokemonId]);

    const { rows: rules } = await this.db.query(`
      SELECT * FROM friendship_evolution_rules WHERE species_id = $1
    `, [pokemon.species_id]);

    for (const rule of rules) {
      if (currentFriendship >= rule.required_friendship) {
        // 检查时间限制
        if (rule.time_restriction) {
          const hour = new Date().getHours();
          const currentPeriod = (hour >= 6 && hour < 18) ? 'day' : 'night';
          if (rule.time_restriction !== currentPeriod) continue;
        }

        return { ready: true, target: rule.target_species_id, rule };
      }
    }

    return { ready: false };
  }

  /**
   * 获取亲密度提升建议
   */
  async getFriendshipImprovementSuggestions(pokemonId) {
    const status = await this.getFriendshipStatus(pokemonId);
    
    if (!status.evolutionProgress.hasEvolution) {
      return { suggestions: [], message: '该精灵无法通过亲密度进化' };
    }

    const needed = status.evolutionProgress.needed;
    if (needed <= 0) {
      return { suggestions: [], message: '已达进化条件！' };
    }

    const suggestions = [];

    // 根据需要的亲密度计算最佳提升方式
    if (needed > 0) {
      suggestions.push({
        method: 'walk',
        description: `行走约${Math.ceil(needed)}公里`,
        efficiency: '稳定但较慢',
        estimatedTime: `${Math.ceil(needed / 10)}天（每天10km）`
      });

      suggestions.push({
        method: 'feed_golden_berry',
        description: `喂食约${Math.ceil(needed / 3)}个金果`,
        efficiency: '快速',
        estimatedTime: '即时'
      });

      suggestions.push({
        method: 'raid_battle',
        description: `参加约${Math.ceil(needed / 3)}场Raid战斗`,
        efficiency: '战斗爱好者首选',
        estimatedTime: `${Math.ceil(needed / 3)}场战斗`
      });

      suggestions.push({
        method: 'spa_treatment',
        description: `温泉护理约${Math.ceil(needed / 2)}次`,
        efficiency: '轻松休闲',
        estimatedTime: `${Math.ceil(needed / 2)}次护理`
      });
    }

    return {
      needed,
      suggestions,
      currentFriendship: status.friendship,
      targetFriendship: status.evolutionProgress.requiredFriendship
    };
  }

  /**
   * 获取亲密度历史记录
   */
  async getFriendshipHistory(pokemonId, limit = 20) {
    const { rows } = await this.db.query(`
      SELECT 
        change_amount, source, context, previous_value, new_value, created_at,
        CASE source
          WHEN 'walk' THEN '行走'
          WHEN 'battle_win' THEN '道馆战斗胜利'
          WHEN 'battle_raid' THEN 'Raid战斗'
          WHEN 'feed_berry' THEN '喂食树果'
          WHEN 'feed_golden_berry' THEN '喂食金果'
          WHEN 'spa_treatment' THEN '温泉护理'
          WHEN 'gift_receive' THEN '收到礼物'
          WHEN 'trade_away' THEN '交易'
          WHEN 'faint' THEN '战斗濒死'
          WHEN 'energy_drink' THEN '能量饮料'
          ELSE source
        END as source_label
      FROM pokemon_friendship_logs
      WHERE pokemon_instance_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [pokemonId, limit]);

    return rows;
  }
}

module.exports = {
  FriendshipCalculator,
  FRIENDSHIP_LEVELS,
  FRIENDSHIP_SOURCES
};
```

### 3. API 路由

```javascript
// pokemon-service/src/routes/friendshipEvolution.js
'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, successResp, AppError } = require('../../../shared/auth');
const { FriendshipCalculator } = require('../friendshipCalculator');
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('friendship-evolution');

// 获取精灵亲密度状态
router.get('/:pokemonId/friendship', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.sub;

    // 验证所有权
    const { rows: [pokemon] } = await query(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [pokemonId]
    );

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator({ query: require('../../../shared/db').query }, logger);
    const status = await calculator.getFriendshipStatus(pokemonId);

    res.json(successResp(status));
  } catch (err) {
    next(err);
  }
});

// 获取进化进度和建议
router.get('/:pokemonId/friendship/evolution-progress', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.sub;

    const { rows: [pokemon] } = await query(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [pokemonId]
    );

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator({ query: require('../../../shared/db').query }, logger);
    const suggestions = await calculator.getFriendshipImprovementSuggestions(pokemonId);
    const status = await calculator.getFriendshipStatus(pokemonId);

    res.json(successResp({
      currentFriendship: status.friendship,
      evolutionProgress: status.evolutionProgress,
      suggestions
    }));
  } catch (err) {
    next(err);
  }
});

// 获取亲密度历史
router.get('/:pokemonId/friendship/history', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const { limit = 20 } = req.query;
    const userId = req.user.sub;

    const { rows: [pokemon] } = await query(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [pokemonId]
    );

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator({ query: require('../../../shared/db').query }, logger);
    const history = await calculator.getFriendshipHistory(pokemonId, parseInt(limit));

    res.json(successResp({ history, total: history.length }));
  } catch (err) {
    next(err);
  }
});

// 预览进化结果
router.post('/:pokemonId/friendship/evolution-preview', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.sub;

    const { rows: [pokemon] } = await query(`
      SELECT pi.*, ps.name as species_name, ps.type_primary, ps.type_secondary,
             ps.base_attack, ps.base_defense, ps.base_stamina
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = $1
    `, [pokemonId]);

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator({ query: require('../../../shared/db').query }, logger);
    const status = await calculator.getFriendshipStatus(pokemonId);

    if (!status.evolutionProgress.hasEvolution) {
      throw new AppError(4000, '该精灵无法通过亲密度进化', 400);
    }

    // 获取目标物种信息
    const { rows: [targetSpecies] } = await query(`
      SELECT id, name, type_primary, type_secondary,
             base_attack, base_defense, base_stamina
      FROM pokemon_species WHERE id = $1
    `, [status.evolutionProgress.targetSpecies]);

    // 计算进化后CP预测
    const currentCP = pokemon.cp;
    const estimatedCP = this.estimateEvolvedCP(pokemon, targetSpecies);

    res.json(successResp({
      canEvolve: status.canEvolve,
      currentSpecies: pokemon.species_name,
      targetSpecies: targetSpecies.name,
      currentFriendship: pokemon.friendship,
      requiredFriendship: status.evolutionProgress.requiredFriendship,
      currentCP,
      estimatedCP,
      cpChange: estimatedCP - currentCP,
      typeChange: {
        from: [pokemon.type_primary, pokemon.type_secondary].filter(Boolean),
        to: [targetSpecies.type_primary, targetSpecies.type_secondary].filter(Boolean)
      },
      timeRestriction: status.evolutionProgress.timeRestriction,
      currentTimeReady: status.evolutionProgress.timeReady
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

### 4. 前端组件

```javascript
// game-client/src/components/FriendshipEvolutionPanel.js
'use strict';

class FriendshipEvolutionPanel {
  constructor(options) {
    this.container = options.container;
    this.pokemonId = options.pokemonId;
    this.api = options.api;
    this.state = {
      status: null,
      suggestions: [],
      history: [],
      loading: true
    };
  }

  async load() {
    try {
      this.setState({ loading: true });
      
      const [statusRes, progressRes] = await Promise.all([
        this.api.get(`/pokemon/${this.pokemonId}/friendship`),
        this.api.get(`/pokemon/${this.pokemonId}/friendship/evolution-progress`)
      ]);

      this.setState({
        status: statusRes.data,
        suggestions: progressRes.data.suggestions,
        loading: false
      });

      this.render();
    } catch (err) {
      console.error('Failed to load friendship data:', err);
      this.setState({ loading: false, error: err.message });
      this.render();
    }
  }

  async loadHistory() {
    try {
      const res = await this.api.get(`/pokemon/${this.pokemonId}/friendship/history?limit=10`);
      this.setState({ history: res.data.history });
      this.renderHistoryModal();
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  async showEvolutionPreview() {
    try {
      const res = await this.api.post(`/pokemon/${this.pokemonId}/friendship/evolution-preview`);
      this.renderEvolutionModal(res.data);
    } catch (err) {
      console.error('Failed to load preview:', err);
    }
  }

  render() {
    const { status, suggestions, loading, error } = this.state;

    if (loading) {
      this.container.innerHTML = '<div class="loading-spinner"></div>';
      return;
    }

    if (error) {
      this.container.innerHTML = `<div class="error-message">${error}</div>`;
      return;
    }

    const progress = status?.evolutionProgress || {};
    const level = status?.friendshipLevel || { label: '未知', color: '#999' };

    this.container.innerHTML = `
      <div class="friendship-evolution-panel">
        <div class="friendship-header">
          <h3>亲密度状态</h3>
          <div class="friendship-level" style="background: ${level.color}">
            ${level.label}
          </div>
        </div>

        <div class="friendship-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progress.percentage || 0}%"></div>
          </div>
          <div class="progress-text">
            ${status?.friendship || 0} / ${progress.requiredFriendship || '-'}
          </div>
        </div>

        ${progress.hasEvolution ? `
          <div class="evolution-status ${progress.ready ? 'ready' : ''}">
            <span class="status-icon">${progress.ready ? '✨' : '🔒'}</span>
            <span class="status-text">
              ${progress.ready ? '可进化为 ' + progress.targetSpecies : 
                `距离进化还需 ${progress.needed} 亲密度`}
            </span>
            ${progress.timeRestriction ? `
              <div class="time-restriction ${progress.timeReady ? 'ready' : ''}">
                ${progress.timeRestriction === 'day' ? '☀️ 白天进化' : '🌙 夜晚进化'}
                ${!progress.timeReady ? '（时间未到）' : ''}
              </div>
            ` : ''}
          </div>
          
          <button class="btn-evolution-preview" onclick="this.showEvolutionPreview()">
            预览进化结果
          </button>
        ` : `
          <div class="no-evolution">
            该精灵无法通过亲密度进化
          </div>
        `}

        ${suggestions.suggestions?.length > 0 ? `
          <div class="suggestions-section">
            <h4>💡 提升建议</h4>
            <ul class="suggestion-list">
              ${suggestions.suggestions.map(s => `
                <li class="suggestion-item">
                  <span class="method">${s.description}</span>
                  <span class="efficiency">${s.efficiency}</span>
                  <span class="time">${s.estimatedTime}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        <button class="btn-history" onclick="this.loadHistory()">
          查看历史记录
        </button>
      </div>
    `;
  }

  renderEvolutionModal(data) {
    const modal = document.createElement('div');
    modal.className = 'evolution-modal-overlay';
    modal.innerHTML = `
      <div class="evolution-modal">
        <h2>进化预览</h2>
        
        <div class="evolution-comparison">
          <div class="pokemon-card current">
            <h3>${data.currentSpecies}</h3>
            <div class="cp">CP: ${data.currentCP}</div>
            <div class="types">
              ${data.typeChange.from.map(t => `<span class="type ${t}">${t}</span>`).join('')}
            </div>
          </div>
          
          <div class="arrow">→</div>
          
          <div class="pokemon-card target ${data.canEvolve ? 'glow' : 'locked'}">
            <h3>${data.targetSpecies}</h3>
            <div class="cp">CP: ~${data.estimatedCP} <span class="change">(+${data.cpChange})</span></div>
            <div class="types">
              ${data.typeChange.to.map(t => `<span class="type ${t}">${t}</span>`).join('')}
            </div>
          </div>
        </div>

        ${data.canEvolve ? `
          <button class="btn-evolve">确认进化</button>
        ` : `
          <div class="evolution-locked">
            进化条件未达成
            ${data.timeRestriction && !data.currentTimeReady ? 
              `<br>需要等待${data.timeRestriction === 'day' ? '白天' : '夜晚'}` : ''}
          </div>
        `}

        <button class="btn-close" onclick="this.closest('.evolution-modal-overlay').remove()">关闭</button>
      </div>
    `;
    document.body.appendChild(modal);
  }

  renderHistoryModal() {
    const { history } = this.state;
    const modal = document.createElement('div');
    modal.className = 'history-modal-overlay';
    modal.innerHTML = `
      <div class="history-modal">
        <h2>亲密度历史</h2>
        <ul class="history-list">
          ${history.map(h => `
            <li class="history-item">
              <span class="change ${h.change_amount > 0 ? 'positive' : 'negative'}">
                ${h.change_amount > 0 ? '+' : ''}${h.change_amount}
              </span>
              <span class="source">${h.source_label}</span>
              <span class="values">${h.previous_value} → ${h.new_value}</span>
              <span class="time">${new Date(h.created_at).toLocaleString()}</span>
            </li>
          `).join('')}
        </ul>
        <button class="btn-close" onclick="this.closest('.history-modal-overlay').remove()">关闭</button>
      </div>
    `;
    document.body.appendChild(modal);
  }

  setState(newState) {
    this.state = { ...this.state, ...newState };
  }
}

module.exports = FriendshipEvolutionPanel;
```

### 5. Gateway 路由代理

```javascript
// gateway/src/routes/friendshipEvolution.js (或合并到现有路由)
// 在 pokemon-service 中挂载
app.use('/pokemon', require('./routes/friendshipEvolution'));
```

## 验收标准

- [ ] 数据库表 `pokemon_friendship_logs` 和 `friendship_evolution_rules` 创建成功
- [ ] `pokemon_instances` 表添加 `friendship` 字段，默认值70
- [ ] API `GET /pokemon/:id/friendship` 返回亲密度状态和等级
- [ ] API `GET /pokemon/:id/friendship/evolution-progress` 返回进化进度和提升建议
- [ ] API `GET /pokemon/:id/friendship/history` 返回亲密度变化历史
- [ ] API `POST /pokemon/:id/friendship/evolution-preview` 返回进化预览信息
- [ ] 前端组件 `FriendshipEvolutionPanel` 正确显示亲密度进度条
- [ ] 进化提示在亲密度达标时正确显示"可进化"状态
- [ ] 昼夜限制进化在正确时间段显示可用状态
- [ ] 提升建议根据当前差距计算合理的达成方式
- [ ] 亲密度日志记录所有变化来源

## 影响范围

- `database/migrations/` - 新增迁移文件
- `pokemon-service/src/friendshipCalculator.js` - 新增计算引擎
- `pokemon-service/src/routes/friendshipEvolution.js` - 新增路由
- `pokemon-service/src/index.js` - 路由挂载
- `game-client/src/components/FriendshipEvolutionPanel.js` - 新增前端组件
- `game-client/src/styles/friendship.css` - 样式文件

## 参考

- Pokémon GO 亲密度进化机制
- 皮卡丘、伊布、吉利蛋、皮皮等亲密度进化精灵列表
- 游戏内昼夜系统 (REQ-00102)
