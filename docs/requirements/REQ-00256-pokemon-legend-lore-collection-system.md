# REQ-00256: 精灵传说系统与图鉴收集故事

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00256 |
| 标题 | 精灵传说系统与图鉴收集故事 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-16 17:30 |

## 需求描述

为游戏增加深度世界观与收集动力，实现精灵传说系统。每个精灵拥有独特的传说故事、历史背景和稀有发现记录。玩家通过收集、捕捉、培养精灵解锁传说章节，获得沉浸式的游戏体验和额外奖励。

### 核心功能
1. **传说故事库** - 每个精灵物种拥有 1-5 章传说故事
2. **收集解锁机制** - 首次捕捉解锁第一章，后续章节通过条件解锁
3. **稀有发现记录** - 记录玩家首次发现稀有精灵的历史
4. **传说奖励** - 解锁完整传说获得称号、道具、资源奖励
5. **传说分享** - 可分享已解锁的传说故事到社交平台

## 技术方案

### 1. 数据库设计

```sql
-- 传说故事表
CREATE TABLE pokemon_legends (
  id SERIAL PRIMARY KEY,
  species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  chapter INTEGER NOT NULL,
  title_i18n JSONB NOT NULL DEFAULT '{}',      -- {"en": "Title", "zh": "标题"}
  content_i18n JSONB NOT NULL DEFAULT '{}',    -- {"en": "Content...", "zh": "内容..."}
  unlock_condition JSONB NOT NULL DEFAULT '{}', -- {"type": "catch_count", "value": 10}
  reward JSONB NOT NULL DEFAULT '{}',           -- {"coins": 100, "item": "rare_candy"}
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(species_id, chapter)
);

-- 玩家传说解锁记录
CREATE TABLE user_legend_unlocks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  chapter INTEGER NOT NULL,
  unlocked_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, species_id, chapter)
);

-- 稀有发现记录表
CREATE TABLE rare_discoveries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  pokemon_id INTEGER REFERENCES pokemon(id),
  discovery_type VARCHAR(50) NOT NULL, -- 'shiny', 'legendary', 'regional', 'variant'
  location GEOGRAPHY(POINT, 4326),
  discovered_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, species_id, discovery_type)
);

-- 传说完成奖励领取记录
CREATE TABLE legend_reward_claims (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  claimed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, species_id)
);

CREATE INDEX idx_legends_species ON pokemon_legends(species_id);
CREATE INDEX idx_legend_unlocks_user ON user_legend_unlocks(user_id);
CREATE INDEX idx_rare_discoveries_user_type ON rare_discoveries(user_id, discovery_type);
```

### 2. pokemon-service 服务实现

```javascript
// backend/services/pokemon-service/src/routes/legend.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../../../shared/middleware/auth');
const db = require('../../../shared/db');

/**
 * 获取精灵传说故事
 * GET /api/pokemon/:speciesId/legend
 */
router.get('/:speciesId/legend', authenticate, async (req, res) => {
  const { speciesId } = req.params;
  const userId = req.user.id;
  
  try {
    // 获取所有传说章节
    const legends = await db.query(`
      SELECT 
        pl.*,
        CASE WHEN ulu.id IS NOT NULL THEN true ELSE false END as unlocked
      FROM pokemon_legends pl
      LEFT JOIN user_legend_unlocks ulu 
        ON ulu.species_id = pl.species_id 
        AND ulu.chapter = pl.chapter 
        AND ulu.user_id = $2
      WHERE pl.species_id = $1
      ORDER BY pl.chapter ASC
    `, [speciesId, userId]);
    
    // 获取解锁条件进度
    const progress = await getUnlockProgress(userId, speciesId);
    
    // 检查是否已领取完整奖励
    const claimed = await db.query(`
      SELECT * FROM legend_reward_claims 
      WHERE user_id = $1 AND species_id = $2
    `, [userId, speciesId]);
    
    res.json({
      success: true,
      data: {
        legends: legends.rows,
        progress,
        allClaimed: claimed.rows.length > 0
      }
    });
  } catch (error) {
    console.error('Get legend error:', error);
    res.status(500).json({ error: 'Failed to get legend' });
  }
});

/**
 * 解锁传说章节
 * POST /api/pokemon/:speciesId/legend/:chapter/unlock
 */
router.post('/:speciesId/legend/:chapter/unlock', authenticate, async (req, res) => {
  const { speciesId, chapter } = req.params;
  const userId = req.user.id;
  
  try {
    // 获取章节解锁条件
    const legend = await db.query(`
      SELECT * FROM pokemon_legends 
      WHERE species_id = $1 AND chapter = $2
    `, [speciesId, chapter]);
    
    if (legend.rows.length === 0) {
      return res.status(404).json({ error: 'Legend chapter not found' });
    }
    
    // 检查是否已解锁
    const existing = await db.query(`
      SELECT * FROM user_legend_unlocks 
      WHERE user_id = $1 AND species_id = $2 AND chapter = $3
    `, [userId, speciesId, chapter]);
    
    if (existing.rows.length > 0) {
      return res.json({ success: true, message: 'Already unlocked' });
    }
    
    // 验证解锁条件
    const condition = legend.rows[0].unlock_condition;
    const canUnlock = await checkUnlockCondition(userId, speciesId, condition);
    
    if (!canUnlock) {
      return res.status(400).json({ 
        error: 'Unlock condition not met',
        condition 
      });
    }
    
    // 解锁章节
    await db.query(`
      INSERT INTO user_legend_unlocks (user_id, species_id, chapter)
      VALUES ($1, $2, $3)
    `, [userId, speciesId, chapter]);
    
    res.json({ 
      success: true, 
      message: 'Chapter unlocked',
      legend: legend.rows[0]
    });
  } catch (error) {
    console.error('Unlock legend error:', error);
    res.status(500).json({ error: 'Failed to unlock legend' });
  }
});

/**
 * 领取完整传说奖励
 * POST /api/pokemon/:speciesId/legend/claim-reward
 */
router.post('/:speciesId/legend/claim-reward', authenticate, async (req, res) => {
  const { speciesId } = req.params;
  const userId = req.user.id;
  
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // 检查是否所有章节已解锁
    const totalChapters = await client.query(`
      SELECT COUNT(*) as total FROM pokemon_legends WHERE species_id = $1
    `, [speciesId]);
    
    const unlockedChapters = await client.query(`
      SELECT COUNT(*) as unlocked FROM user_legend_unlocks 
      WHERE user_id = $1 AND species_id = $2
    `, [userId, speciesId]);
    
    if (parseInt(unlockedChapters.rows[0].unlocked) < parseInt(totalChapters.rows[0].total)) {
      return res.status(400).json({ error: 'Not all chapters unlocked' });
    }
    
    // 检查是否已领取
    const claimed = await client.query(`
      SELECT * FROM legend_reward_claims 
      WHERE user_id = $1 AND species_id = $2
    `, [userId, speciesId]);
    
    if (claimed.rows.length > 0) {
      return res.status(400).json({ error: 'Reward already claimed' });
    }
    
    // 获取奖励
    const legends = await client.query(`
      SELECT reward FROM pokemon_legends WHERE species_id = $1
    `, [speciesId]);
    
    const totalReward = legends.rows.reduce((acc, l) => {
      const reward = l.reward || {};
      acc.coins = (acc.coins || 0) + (reward.coins || 0);
      acc.items = [...(acc.items || []), ...(reward.items || [])];
      return acc;
    }, {});
    
    // 发放奖励
    await grantReward(client, userId, totalReward);
    
    // 记录领取
    await client.query(`
      INSERT INTO legend_reward_claims (user_id, species_id)
      VALUES ($1, $2)
    `, [userId, speciesId]);
    
    await client.query('COMMIT');
    
    res.json({ 
      success: true, 
      reward: totalReward 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Claim legend reward error:', error);
    res.status(500).json({ error: 'Failed to claim reward' });
  } finally {
    client.release();
  }
});

/**
 * 获取稀有发现记录
 * GET /api/pokemon/discoveries
 */
router.get('/discoveries', authenticate, async (req, res) => {
  const userId = req.user.id;
  const { type, limit = 20, offset = 0 } = req.query;
  
  try {
    let query = `
      SELECT 
        rd.*,
        ps.name_i18n,
        ST_AsGeoJSON(rd.location) as location_geojson
      FROM rare_discoveries rd
      JOIN pokemon_species ps ON ps.id = rd.species_id
      WHERE rd.user_id = $1
    `;
    const params = [userId];
    
    if (type) {
      query += ` AND rd.discovery_type = $${params.length + 1}`;
      params.push(type);
    }
    
    query += ` ORDER BY rd.discovered_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get discoveries error:', error);
    res.status(500).json({ error: 'Failed to get discoveries' });
  }
});

// 解锁条件检查
async function checkUnlockCondition(userId, speciesId, condition) {
  if (!condition || !condition.type) return true;
  
  switch (condition.type) {
    case 'catch_count': {
      const result = await db.query(`
        SELECT COUNT(*) as count FROM pokemon 
        WHERE user_id = $1 AND species_id = $2
      `, [userId, speciesId]);
      return parseInt(result.rows[0].count) >= condition.value;
    }
    case 'friendship_level': {
      const result = await db.query(`
        SELECT MAX(friendship_level) as level FROM pokemon 
        WHERE user_id = $1 AND species_id = $2
      `, [userId, speciesId]);
      return parseInt(result.rows[0].level || 0) >= condition.value;
    }
    case 'win_battles': {
      const result = await db.query(`
        SELECT COUNT(*) as count FROM battle_participants bp
        JOIN battles b ON b.id = bp.battle_id
        WHERE bp.user_id = $1 AND bp.pokemon_species_id = $2 AND b.winner_id = $1
      `, [userId, speciesId]);
      return parseInt(result.rows[0].count) >= condition.value;
    }
    case 'evolve_count': {
      const result = await db.query(`
        SELECT COUNT(*) as count FROM pokemon_evolution_history
        WHERE user_id = $1 AND to_species_id = $2
      `, [userId, speciesId]);
      return parseInt(result.rows[0].count) >= condition.value;
    }
    default:
      return false;
  }
}

// 获取解锁进度
async function getUnlockProgress(userId, speciesId) {
  const conditions = await db.query(`
    SELECT chapter, unlock_condition FROM pokemon_legends 
    WHERE species_id = $1
    ORDER BY chapter
  `, [speciesId]);
  
  const progress = [];
  
  for (const cond of conditions.rows) {
    const condition = cond.unlock_condition;
    if (!condition) continue;
    
    let current = 0;
    let target = condition.value;
    
    switch (condition.type) {
      case 'catch_count': {
        const result = await db.query(`
          SELECT COUNT(*) as count FROM pokemon 
          WHERE user_id = $1 AND species_id = $2
        `, [userId, speciesId]);
        current = parseInt(result.rows[0].count);
        break;
      }
      case 'friendship_level': {
        const result = await db.query(`
          SELECT MAX(friendship_level) as level FROM pokemon 
          WHERE user_id = $1 AND species_id = $2
        `, [userId, speciesId]);
        current = parseInt(result.rows[0].level || 0);
        break;
      }
    }
    
    progress.push({
      chapter: cond.chapter,
      type: condition.type,
      current,
      target,
      percentage: Math.min(100, Math.round((current / target) * 100))
    });
  }
  
  return progress;
}

// 发放奖励
async function grantReward(client, userId, reward) {
  if (reward.coins) {
    await client.query(`
      UPDATE users SET coins = coins + $1 WHERE id = $2
    `, [reward.coins, userId]);
  }
  
  if (reward.items && reward.items.length > 0) {
    for (const item of reward.items) {
      await client.query(`
        INSERT INTO user_items (user_id, item_id, quantity)
        VALUES ($1, $2, 1)
        ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_items.quantity + 1
      `, [userId, item.id]);
    }
  }
}

module.exports = router;
```

### 3. 捕捉时触发传说解锁

```javascript
// backend/services/catch-service/src/handlers/catchHandler.js
async function processCapture(userId, pokemon, location) {
  // ... 现有捕捉逻辑 ...
  
  // 检查并解锁第一章传说
  await unlockFirstLegendChapter(userId, pokemon.species_id);
  
  // 检查是否为稀有发现
  await checkRareDiscovery(userId, pokemon, location);
}

async function unlockFirstLegendChapter(userId, speciesId) {
  try {
    // 检查是否已解锁第一章
    const existing = await db.query(`
      SELECT * FROM user_legend_unlocks 
      WHERE user_id = $1 AND species_id = $2 AND chapter = 1
    `, [userId, speciesId]);
    
    if (existing.rows.length > 0) return;
    
    // 检查是否为该物种首次捕捉
    const catchCount = await db.query(`
      SELECT COUNT(*) as count FROM pokemon 
      WHERE user_id = $1 AND species_id = $2
    `, [userId, speciesId]);
    
    if (parseInt(catchCount.rows[0].count) === 1) {
      // 首次捕捉，解锁第一章
      await db.query(`
        INSERT INTO user_legend_unlocks (user_id, species_id, chapter)
        VALUES ($1, $2, 1)
      `, [userId, speciesId]);
      
      // 发布解锁事件
      await publishEvent('legend.unlocked', {
        userId,
        speciesId,
        chapter: 1,
        reason: 'first_catch'
      });
    }
  } catch (error) {
    console.error('Unlock legend chapter error:', error);
  }
}

async function checkRareDiscovery(userId, pokemon, location) {
  const discoveryTypes = [];
  
  // 检查闪光
  if (pokemon.is_shiny) {
    discoveryTypes.push('shiny');
  }
  
  // 检查传说精灵
  const species = await db.query(`
    SELECT rarity FROM pokemon_species WHERE id = $1
  `, [pokemon.species_id]);
  
  if (species.rows[0]?.rarity === 'legendary') {
    discoveryTypes.push('legendary');
  }
  
  // 检查地区限定
  const regional = await checkRegionalSpecies(pokemon.species_id);
  if (regional) {
    discoveryTypes.push('regional');
  }
  
  // 记录发现
  for (const type of discoveryTypes) {
    await db.query(`
      INSERT INTO rare_discoveries (user_id, species_id, pokemon_id, discovery_type, location)
      VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))
      ON CONFLICT (user_id, species_id, discovery_type) DO NOTHING
    `, [userId, pokemon.species_id, pokemon.id, type, location.lng, location.lat]);
  }
}
```

### 4. game-client 前端组件

```javascript
// frontend/game-client/src/components/LegendViewer.js
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './LegendViewer.css';

export function LegendViewer({ speciesId, onClose }) {
  const { t, i18n } = useTranslation();
  const [legends, setLegends] = useState([]);
  const [progress, setProgress] = useState([]);
  const [selectedChapter, setSelectedChapter] = useState(1);
  const [loading, setLoading] = useState(true);
  const [allClaimed, setAllClaimed] = useState(false);
  
  useEffect(() => {
    loadLegend();
  }, [speciesId]);
  
  const loadLegend = async () => {
    try {
      const response = await fetch(`/api/pokemon/${speciesId}/legend`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      setLegends(data.data.legends);
      setProgress(data.data.progress);
      setAllClaimed(data.data.allClaimed);
    } catch (error) {
      console.error('Load legend error:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const unlockChapter = async (chapter) => {
    try {
      const response = await fetch(`/api/pokemon/${speciesId}/legend/${chapter}/unlock`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      
      if (response.ok) {
        loadLegend();
      }
    } catch (error) {
      console.error('Unlock error:', error);
    }
  };
  
  const claimReward = async () => {
    try {
      const response = await fetch(`/api/pokemon/${speciesId}/legend/claim-reward`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      
      const data = await response.json();
      if (data.success) {
        alert(t('legend.reward_claimed', { reward: JSON.stringify(data.reward) }));
        setAllClaimed(true);
      }
    } catch (error) {
      console.error('Claim error:', error);
    }
  };
  
  const currentLang = i18n.language || 'en';
  const currentLegend = legends.find(l => l.chapter === selectedChapter);
  const currentProgress = progress.find(p => p.chapter === selectedChapter);
  
  if (loading) return <div className="legend-loading">{t('common.loading')}</div>;
  
  return (
    <div className="legend-viewer">
      <div className="legend-header">
        <h2>{t('legend.title')}</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      
      <div className="legend-chapters">
        {legends.map((legend) => (
          <div 
            key={legend.chapter}
            className={`chapter-tab ${legend.unlocked ? 'unlocked' : 'locked'} ${selectedChapter === legend.chapter ? 'active' : ''}`}
            onClick={() => legend.unlocked && setSelectedChapter(legend.chapter)}
          >
            <span className="chapter-number">{legend.chapter}</span>
            {legend.unlocked ? (
              <span className="chapter-icon">📖</span>
            ) : (
              <span className="chapter-icon">🔒</span>
            )}
          </div>
        ))}
      </div>
      
      {currentLegend && (
        <div className="legend-content">
          {currentLegend.unlocked ? (
            <>
              <h3 className="legend-title">
                {currentLegend.title_i18n[currentLang] || currentLegend.title_i18n.en}
              </h3>
              <div className="legend-text">
                {currentLegend.content_i18n[currentLang] || currentLegend.content_i18n.en}
              </div>
            </>
          ) : (
            <div className="chapter-locked">
              <h3>{t('legend.chapter_locked')}</h3>
              {currentProgress && (
                <>
                  <p>{t(`legend.condition.${currentProgress.type}`)}</p>
                  <div className="progress-bar">
                    <div 
                      className="progress-fill" 
                      style={{ width: `${currentProgress.percentage}%` }}
                    />
                  </div>
                  <p className="progress-text">
                    {currentProgress.current} / {currentProgress.target}
                  </p>
                  <button 
                    className="unlock-btn"
                    onClick={() => unlockChapter(selectedChapter)}
                    disabled={currentProgress.current < currentProgress.target}
                  >
                    {t('legend.unlock_chapter')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      
      {legends.every(l => l.unlocked) && !allClaimed && (
        <button className="claim-reward-btn" onClick={claimReward}>
          {t('legend.claim_reward')}
        </button>
      )}
      
      {allClaimed && (
        <div className="reward-claimed">
          ✓ {t('legend.reward_claimed')}
        </div>
      )}
    </div>
  );
}
```

### 5. 初始传说数据种子

```javascript
// database/migrations/20260616_seed_pokemon_legends.js
const legendsData = [
  {
    species_id: 25, // Pikachu
    chapters: [
      {
        chapter: 1,
        title: { en: "The Spark of Beginnings", zh: "初始之火" },
        content: { 
          en: "Long ago, in the forests of Kanto, a small electric mouse was born...", 
          zh: "很久以前，在关都的森林中，一只小小的电鼠诞生了..." 
        },
        unlock_condition: { type: "catch_count", value: 1 },
        reward: { coins: 100 }
      },
      {
        chapter: 2,
        title: { en: "Friendship's Lightning", zh: "友谊的闪电" },
        content: { 
          en: "As trainers bonded with Pikachu, they discovered...", 
          zh: "当训练家与皮卡丘建立羁绊后，他们发现..." 
        },
        unlock_condition: { type: "friendship_level", value: 3 },
        reward: { items: [{ id: "thunder_stone", quantity: 1 }] }
      },
      {
        chapter: 3,
        title: { en: "The Legend of the Red Cheeks", zh: "红脸颊的传说" },
        content: { 
          en: "The red cheeks of Pikachu are said to store electricity...", 
          zh: "据说皮卡丘红色的脸颊中储存着电力..." 
        },
        unlock_condition: { type: "win_battles", value: 50 },
        reward: { coins: 500 }
      }
    ]
  },
  {
    species_id: 150, // Mewtwo
    chapters: [
      {
        chapter: 1,
        title: { en: "Born from Science", zh: "科学之子" },
        content: { 
          en: "Created from the DNA of Mew, Mewtwo emerged...", 
          zh: "由超梦的DNA创造，超梦诞生了..." 
        },
        unlock_condition: { type: "catch_count", value: 1 },
        reward: { coins: 1000 }
      },
      {
        chapter: 2,
        title: { en: "The Quest for Identity", zh: "寻找自我" },
        content: { 
          en: "Mewtwo questioned its existence and purpose...", 
          zh: "超梦质疑自己的存在与目的..." 
        },
        unlock_condition: { type: "friendship_level", value: 5 },
        reward: { items: [{ id: "rare_candy", quantity: 5 }] }
      }
    ]
  }
  // ... 更多精灵传说数据
];

exports.up = async (db) => {
  for (const species of legendsData) {
    for (const chapter of species.chapters) {
      await db.query(`
        INSERT INTO pokemon_legends (species_id, chapter, title_i18n, content_i18n, unlock_condition, reward)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        species.species_id,
        chapter.chapter,
        JSON.stringify(chapter.title),
        JSON.stringify(chapter.content),
        JSON.stringify(chapter.unlock_condition),
        JSON.stringify(chapter.reward)
      ]);
    }
  }
};
```

## 验收标准

- [ ] 数据库表创建成功，索引正确
- [ ] 传说故事 API 正常工作（获取、解锁、领取奖励）
- [ ] 首次捕捉自动解锁第一章传说
- [ ] 稀有发现记录正确保存（闪光、传说、地区限定）
- [ ] 解锁条件验证逻辑正确（捕捉数量、友谊等级、战斗胜利、进化次数）
- [ ] 前端传说查看器组件正常显示
- [ ] 章节锁定/解锁状态正确展示
- [ ] 进度条显示解锁进度
- [ ] 完整传说奖励正确发放
- [ ] 多语言支持正确显示
- [ ] 单元测试覆盖核心逻辑

## 影响范围

- **pokemon-service**: 新增传说路由、解锁逻辑
- **catch-service**: 捕捉时触发传说解锁和稀有发现记录
- **user-service**: 用户资源更新
- **game-client**: 新增传说查看器组件
- **database/migrations**: 新增 4 张表
- **backend/shared**: 可复用的解锁条件检查逻辑

## 参考

- Pokémon 原作图鉴传说故事
- Ingress Portal 故事系统设计
- Pokémon GO 图鉴收集机制
