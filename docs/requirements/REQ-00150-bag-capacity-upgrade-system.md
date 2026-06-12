# REQ-00150: 背包容量扩展与购买系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00150 |
| 标题 | 背包容量扩展与购买系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、payment-service、gateway、game-client |
| 创建时间 | 2026-06-12 09:00 |

## 需求描述

为精灵背包系统增加容量扩展功能，允许玩家通过金币或宝石购买额外的背包空间。当前背包系统（REQ-00047）已具备基础的容量管理（inventory_capacity 表），但缺少扩容购买机制。

**核心价值**：
- 提升玩家游戏体验，避免背包满导致无法获取新道具
- 增加商业化收入（宝石购买）
- 提供多样化的扩容渠道（金币/宝石/成就/活动）
- 平衡游戏经济（动态定价机制）

## 技术方案

### 1. 数据库设计

新增 2 张表：

```sql
-- 背包扩容配置表
CREATE TABLE bag_upgrade_config (
  upgrade_id VARCHAR(50) PRIMARY KEY,
  category VARCHAR(20) NOT NULL,           -- 'base', 'pokeball', 'potion', 'tm', 'evolution', 'special'
  increment INTEGER NOT NULL,              -- 扩容数量
  gold_cost INTEGER,                       -- 金币价格
  gem_cost INTEGER,                        -- 宝石价格
  required_level INTEGER DEFAULT 1,        -- 所需玩家等级
  max_upgrades INTEGER DEFAULT 10,         -- 最大购买次数
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家背包扩容记录表
CREATE TABLE player_bag_upgrades (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upgrade_id VARCHAR(50) NOT NULL REFERENCES bag_upgrade_config(upgrade_id),
  purchase_method VARCHAR(20) NOT NULL,    -- 'gold', 'gem', 'achievement', 'event', 'free'
  cost_amount INTEGER NOT NULL,            -- 实际花费
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, upgrade_id, purchased_at)
);

CREATE INDEX idx_player_bag_upgrades_user ON player_bag_upgrades(user_id);
CREATE INDEX idx_player_bag_upgrades_method ON player_bag_upgrades(purchase_method);
```

初始配置数据：
```sql
INSERT INTO bag_upgrade_config (upgrade_id, category, increment, gold_cost, gem_cost, required_level, max_upgrades) VALUES
  ('base_50', 'base', 50, 10000, 100, 5, 20),
  ('base_100', 'base', 100, 50000, 500, 10, 10),
  ('pokeball_20', 'pokeball', 20, 5000, 50, 1, 15),
  ('potion_20', 'potion', 20, 5000, 50, 1, 15),
  ('tm_10', 'tm', 10, 8000, 80, 8, 10),
  ('evolution_10', 'evolution', 10, 8000, 80, 8, 10),
  ('special_10', 'special', 10, 10000, 100, 10, 10);
```

### 2. 后端服务实现

**inventoryService.js 扩展**：

```javascript
/**
 * 获取扩容配置列表
 */
async getUpgradeConfigs(userId) {
  const cacheKey = `bag_upgrade_configs:${userId}`;
  const cached = await this.redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  // 获取配置和玩家已购买记录
  const [configs, purchases] = await Promise.all([
    this.db.query(`
      SELECT * FROM bag_upgrade_config 
      WHERE is_active = true 
      ORDER BY category, increment
    `),
    this.db.query(`
      SELECT upgrade_id, COUNT(*) as purchase_count
      FROM player_bag_upgrades
      WHERE user_id = $1
      GROUP BY upgrade_id
    `, [userId])
  ]);
  
  const purchaseMap = new Map(
    purchases.rows.map(r => [r.upgrade_id, parseInt(r.purchase_count)])
  );
  
  // 计算每个配置的可用状态
  const result = configs.rows.map(config => ({
    ...config,
    purchased: purchaseMap.get(config.upgrade_id) || 0,
    available: (purchaseMap.get(config.upgrade_id) || 0) < config.max_upgrades
  }));
  
  await this.redis.setex(cacheKey, 300, JSON.stringify(result));
  return result;
}

/**
 * 购买背包扩容
 */
async purchaseBagUpgrade(userId, upgradeId, method) {
  const client = await this.db.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. 获取配置
    const configResult = await client.query(
      'SELECT * FROM bag_upgrade_config WHERE upgrade_id = $1 AND is_active = true',
      [upgradeId]
    );
    
    if (configResult.rows.length === 0) {
      throw new AppError(404, 'Upgrade config not found');
    }
    
    const config = configResult.rows[0];
    
    // 2. 检查购买次数
    const purchaseCount = await client.query(
      'SELECT COUNT(*) FROM player_bag_upgrades WHERE user_id = $1 AND upgrade_id = $2',
      [userId, upgradeId]
    );
    
    if (parseInt(purchaseCount.rows[0].count) >= config.max_upgrades) {
      throw new AppError(400, 'Maximum upgrades reached');
    }
    
    // 3. 确定价格
    const cost = method === 'gold' ? config.gold_cost : config.gem_cost;
    if (!cost) {
      throw new AppError(400, `Cannot purchase with ${method}`);
    }
    
    // 4. 扣款（调用 user-service 或 payment-service）
    const deductResult = await this.deductCurrency(userId, method, cost);
    if (!deductResult.success) {
      throw new AppError(400, 'Insufficient balance');
    }
    
    // 5. 记录购买
    await client.query(
      'INSERT INTO player_bag_upgrades (user_id, upgrade_id, purchase_method, cost_amount) VALUES ($1, $2, $3, $4)',
      [userId, upgradeId, method, cost]
    );
    
    // 6. 更新容量
    await client.query(
      `UPDATE inventory_capacity 
       SET ${config.category}_slots = ${config.category}_slots + $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2`,
      [config.increment, userId]
    );
    
    await client.query('COMMIT');
    
    // 清除缓存
    await this.redis.del(`${this.cachePrefix}${userId}`);
    await this.redis.del(`bag_upgrade_configs:${userId}`);
    
    // 发布事件
    await this.eventBus.publish('bag.upgrade.purchased', {
      userId,
      upgradeId,
      category: config.category,
      increment: config.increment,
      method,
      cost
    });
    
    this.metrics.bagUpgradesPurchased.inc({ 
      user_id: userId, 
      category: config.category,
      method 
    });
    
    return {
      success: true,
      category: config.category,
      increment: config.increment,
      cost,
      method
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 赠送免费扩容（成就/活动奖励）
 */
async grantFreeUpgrade(userId, upgradeId, reason) {
  const config = await this.db.query(
    'SELECT * FROM bag_upgrade_config WHERE upgrade_id = $1',
    [upgradeId]
  );
  
  if (config.rows.length === 0) {
    throw new AppError(404, 'Upgrade config not found');
  }
  
  const cfg = config.rows[0];
  
  await this.db.query('BEGIN');
  
  try {
    await this.db.query(
      'INSERT INTO player_bag_upgrades (user_id, upgrade_id, purchase_method, cost_amount) VALUES ($1, $2, $3, 0)',
      [userId, upgradeId, reason]
    );
    
    await this.db.query(
      `UPDATE inventory_capacity 
       SET ${cfg.category}_slots = ${cfg.category}_slots + $1
       WHERE user_id = $2`,
      [cfg.increment, userId]
    );
    
    await this.db.query('COMMIT');
    
    await this.redis.del(`${this.cachePrefix}${userId}`);
    
    return { success: true, increment: cfg.increment };
    
  } catch (error) {
    await this.db.query('ROLLBACK');
    throw error;
  }
}
```

### 3. API 路由

**inventory.js 新增端点**：

```javascript
/**
 * GET /api/v1/inventory/upgrades
 * 获取扩容配置列表
 */
router.get('/upgrades', requireAuth, async (req, res, next) => {
  try {
    const configs = await inventoryService.getUpgradeConfigs(req.user.id);
    successResp(res, configs);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/inventory/upgrades/:upgradeId/purchase
 * 购买背包扩容
 */
router.post('/upgrades/:upgradeId/purchase', requireAuth, async (req, res, next) => {
  try {
    const { upgradeId } = req.params;
    const { method } = req.body; // 'gold' | 'gem'
    
    if (!['gold', 'gem'].includes(method)) {
      throw new AppError(400, 'Invalid purchase method');
    }
    
    const result = await inventoryService.purchaseBagUpgrade(
      req.user.id, 
      upgradeId, 
      method
    );
    
    successResp(res, result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/inventory/upgrades/:upgradeId/grant
 * 赠送免费扩容（管理员）
 */
router.post('/upgrades/:upgradeId/grant', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { upgradeId } = req.params;
    const { userId, reason } = req.body;
    
    const result = await inventoryService.grantFreeUpgrade(
      userId, 
      upgradeId, 
      reason
    );
    
    successResp(res, result);
  } catch (error) {
    next(error);
  }
});
```

### 4. 前端实现

**BagUpgradeModal.js**：

```javascript
import React, { useState, useEffect } from 'react';
import { useGameStore } from '../store/GameStore';

export function BagUpgradeModal({ category, onClose }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const { user, showNotification } = useGameStore();
  
  useEffect(() => {
    fetchConfigs();
  }, []);
  
  const fetchConfigs = async () => {
    const res = await fetch('/api/v1/inventory/upgrades');
    const data = await res.json();
    setConfigs(data.data.filter(c => c.category === category));
    setLoading(false);
  };
  
  const handlePurchase = async (upgradeId, method) => {
    try {
      const res = await fetch(`/api/v1/inventory/upgrades/${upgradeId}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method })
      });
      
      const data = await res.json();
      
      if (data.success) {
        showNotification(`背包扩容成功！+${data.data.increment} 格`, 'success');
        onClose();
      } else {
        showNotification(data.message, 'error');
      }
    } catch (error) {
      showNotification('购买失败，请重试', 'error');
    }
  };
  
  if (loading) return <div className="loading">加载中...</div>;
  
  return (
    <div className="bag-upgrade-modal">
      <h2>背包扩容</h2>
      
      {configs.map(config => (
        <div key={config.upgrade_id} className="upgrade-option">
          <div className="upgrade-info">
            <span className="increment">+{config.increment} 格</span>
            <span className="purchased">
              已购买: {config.purchased}/{config.max_upgrades}
            </span>
          </div>
          
          <div className="upgrade-actions">
            {config.gold_cost && (
              <button 
                onClick={() => handlePurchase(config.upgrade_id, 'gold')}
                disabled={!config.available || user.gold < config.gold_cost}
              >
                💰 {config.gold_cost.toLocaleString()}
              </button>
            )}
            
            {config.gem_cost && (
              <button 
                onClick={() => handlePurchase(config.upgrade_id, 'gem')}
                disabled={!config.available || user.gems < config.gem_cost}
              >
                💎 {config.gem_cost}
              </button>
            )}
          </div>
        </div>
      ))}
      
      <button onClick={onClose}>关闭</button>
    </div>
  );
}
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics.js
const bagUpgradesPurchased = new Counter({
  name: 'minego_bag_upgrades_purchased_total',
  help: 'Total bag upgrades purchased',
  labelNames: ['user_id', 'category', 'method']
});

const bagUpgradeRevenue = new Counter({
  name: 'minego_bag_upgrade_revenue_total',
  help: 'Total revenue from bag upgrades',
  labelNames: ['currency', 'amount']
});
```

## 验收标准

- [ ] 数据库迁移文件创建并通过 `node --check`
- [ ] `GET /api/v1/inventory/upgrades` 返回 200，包含所有扩容配置
- [ ] `POST /api/v1/inventory/upgrades/:upgradeId/purchase` 成功购买并扣款
- [ ] 购买后背包容量正确增加
- [ ] 达到最大购买次数时返回 400 错误
- [ ] 余额不足时返回 400 错误
- [ ] 管理员赠送接口需要 `requireAdmin` 中间件
- [ ] 前端 BagUpgradeModal 组件正常渲染
- [ ] 单元测试覆盖核心逻辑（购买、赠送、容量更新）
- [ ] Prometheus 指标正常采集

## 影响范围

- `database/migrations/20260612_090000__add_bag_upgrade_system.sql`（新增）
- `backend/services/pokemon-service/src/inventoryService.js`（扩展）
- `backend/services/pokemon-service/src/routes/inventory.js`（扩展）
- `frontend/game-client/src/components/BagUpgradeModal.js`（新增）
- `backend/shared/metrics.js`（扩展）
- `backend/tests/unit/bag-upgrade.test.js`（新增）

## 参考

- REQ-00047：精灵道具与背包管理系统（基础实现）
- REQ-00051：多货币支持与汇率转换系统（扣款逻辑）
- Pokemon GO 背包扩容机制
