# REQ-00206: 精灵交易税务与手续费系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00206 |
| 标题 | 精灵交易税务与手续费系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、pokemon-service、user-service、payment-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-14 18:00 |

## 需求描述

实现精灵交易过程中的税务与手续费计算系统，包括：

1. **交易手续费机制**：每次精灵交易收取一定比例的手续费（金币或钻石）
2. **税率梯度设计**：根据交易金额/稀有度设置不同税率档次
3. **免税额度**：好友间交易可享受一定免税额度或减免
4. **手续费收入分配**：手续费进入游戏经济池或公会基金
5. **交易记录与税收统计**：完整的交易税收日志和统计报表

该系统是精灵交换市场（REQ-00104）的重要配套功能，用于调控游戏经济平衡，防止通货膨胀和洗钱行为。

## 技术方案

### 1. 数据库设计

```sql
-- 交易税率配置表
CREATE TABLE trade_tax_configs (
  id SERIAL PRIMARY KEY,
  tax_tier VARCHAR(50) NOT NULL,           -- 税率档次：low/medium/high/luxury
  min_value DECIMAL(15,2) NOT NULL,        -- 最低交易价值
  max_value DECIMAL(15,2),                 -- 最高交易价值（NULL表示无上限）
  tax_rate DECIMAL(5,4) NOT NULL,          -- 税率（如 0.0500 表示 5%）
  fixed_fee DECIMAL(15,2) DEFAULT 0,       -- 固定手续费
  currency_type VARCHAR(20) NOT NULL,      -- 货币类型：coins/gems
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 交易税收记录表
CREATE TABLE trade_tax_records (
  id SERIAL PRIMARY KEY,
  trade_id VARCHAR(100) NOT NULL,          -- 关联交易ID
  seller_id INTEGER NOT NULL,              -- 卖家ID
  buyer_id INTEGER NOT NULL,               -- 买家ID
  pokemon_id INTEGER NOT NULL,             -- 精灵ID
  trade_value DECIMAL(15,2) NOT NULL,      -- 交易价值
  tax_tier VARCHAR(50) NOT NULL,           -- 适用税率档次
  tax_rate DECIMAL(5,4) NOT NULL,          -- 实际税率
  tax_amount DECIMAL(15,2) NOT NULL,       -- 税金金额
  fixed_fee DECIMAL(15,2) NOT NULL,        -- 固定手续费
  total_fee DECIMAL(15,2) NOT NULL,        -- 总手续费
  currency_type VARCHAR(20) NOT NULL,      -- 货币类型
  friend_discount DECIMAL(5,4) DEFAULT 0,  -- 好友折扣率
  final_fee DECIMAL(15,2) NOT NULL,        -- 最终手续费
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_seller_id (seller_id),
  INDEX idx_buyer_id (buyer_id),
  INDEX idx_created_at (created_at)
);

-- 好友免税额度表
CREATE TABLE friend_tax_allowances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  friend_id INTEGER NOT NULL,
  daily_allowance DECIMAL(15,2) DEFAULT 1000,  -- 每日免税额度
  used_allowance DECIMAL(15,2) DEFAULT 0,      -- 已使用额度
  reset_date DATE NOT NULL,                    -- 重置日期
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE KEY uk_user_friend (user_id, friend_id),
  INDEX idx_reset_date (reset_date)
);

-- 税收统计汇总表
CREATE TABLE tax_revenue_stats (
  id SERIAL PRIMARY KEY,
  stat_date DATE NOT NULL,
  total_trades INTEGER DEFAULT 0,
  total_trade_value DECIMAL(20,2) DEFAULT 0,
  total_tax_revenue DECIMAL(20,2) DEFAULT 0,
  avg_tax_rate DECIMAL(5,4) DEFAULT 0,
  currency_type VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE KEY uk_date_currency (stat_date, currency_type)
);
```

### 2. 税率计算服务

```javascript
// backend/shared/TaxCalculator.js
class TaxCalculator {
  constructor(db, cache) {
    this.db = db;
    this.cache = cache;
    this.cacheKey = 'trade_tax_configs';
    this.cacheTTL = 300; // 5分钟缓存
  }

  /**
   * 获取税率配置
   */
  async getTaxConfigs() {
    const cached = await this.cache.get(this.cacheKey);
    if (cached) return cached;

    const result = await this.db.query(`
      SELECT * FROM trade_tax_configs 
      WHERE is_active = TRUE 
      ORDER BY min_value ASC
    `);
    
    await this.cache.set(this.cacheKey, result.rows, this.cacheTTL);
    return result.rows;
  }

  /**
   * 计算交易税率档次
   */
  async getTaxTier(tradeValue, currencyType = 'coins') {
    const configs = await this.getTaxConfigs();
    const applicableConfigs = configs.filter(c => c.currency_type === currencyType);
    
    for (const config of applicableConfigs) {
      const minOk = tradeValue >= config.min_value;
      const maxOk = config.max_value === null || tradeValue <= config.max_value;
      if (minOk && maxOk) {
        return config;
      }
    }
    
    // 默认返回最高档次
    return applicableConfigs[applicableConfigs.length - 1];
  }

  /**
   * 计算好友折扣
   */
  async calculateFriendDiscount(sellerId, buyerId, tradeValue, currencyType) {
    // 检查是否为好友
    const friendship = await this.db.query(`
      SELECT friendship_level, friendship_days
      FROM friendships
      WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
        AND status = 'active'
    `, [sellerId, buyerId]);

    if (friendship.rows.length === 0) {
      return { isFriend: false, discountRate: 0, allowanceRemaining: 0 };
    }

    const friend = friendship.rows[0];
    
    // 获取免税额度
    const today = new Date().toISOString().split('T')[0];
    const allowance = await this.db.query(`
      INSERT INTO friend_tax_allowances (user_id, friend_id, reset_date)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, friend_id) 
      DO UPDATE SET 
        used_allowance = CASE WHEN reset_date < $3 THEN 0 ELSE friend_tax_allowances.used_allowance END,
        reset_date = CASE WHEN reset_date < $3 THEN $3 ELSE friend_tax_allowances.reset_date END,
        daily_allowance = CASE WHEN reset_date < $3 THEN 1000 ELSE friend_tax_allowances.daily_allowance END
      RETURNING *
    `, [Math.min(sellerId, buyerId), Math.max(sellerId, buyerId), today]);

    const allowanceRecord = allowance.rows[0];
    const remaining = Math.max(0, allowanceRecord.daily_allowance - allowanceRecord.used_allowance);
    
    // 根据好友等级计算折扣（最高30%）
    const levelDiscount = Math.min(0.30, friend.friendship_level * 0.05);
    
    return {
      isFriend: true,
      friendshipLevel: friend.friendship_level,
      discountRate: levelDiscount,
      allowanceRemaining: remaining
    };
  }

  /**
   * 计算交易税费
   */
  async calculateTax(sellerId, buyerId, tradeValue, currencyType = 'coins') {
    const taxTier = await this.getTaxTier(tradeValue, currencyType);
    const friendInfo = await this.calculateFriendDiscount(sellerId, buyerId, tradeValue, currencyType);

    // 基础税费
    const baseTax = tradeValue * taxTier.tax_rate;
    const fixedFee = taxTier.fixed_fee;
    
    // 应用好友折扣
    let discountedTax = baseTax * (1 - friendInfo.discountRate);
    
    // 应用免税额度
    if (friendInfo.isFriend && friendInfo.allowanceRemaining > 0) {
      const allowanceToUse = Math.min(friendInfo.allowanceRemaining, discountedTax);
      discountedTax -= allowanceToUse;
      
      // 更新已使用额度
      await this.db.query(`
        UPDATE friend_tax_allowances 
        SET used_allowance = used_allowance + $1
        WHERE user_id = $2 AND friend_id = $3
      `, [allowanceToUse, Math.min(sellerId, buyerId), Math.max(sellerId, buyerId)]);
    }

    const totalFee = Math.max(0, discountedTax + fixedFee);

    return {
      tradeValue,
      taxTier: taxTier.tax_tier,
      taxRate: taxTier.tax_rate,
      baseTax,
      fixedFee,
      friendDiscount: friendInfo.discountRate,
      isFriend: friendInfo.isFriend,
      finalFee: totalFee,
      currencyType,
      breakdown: {
        tradeValue,
        percentageTax: baseTax,
        fixedFee,
        friendDiscountAmount: baseTax * friendInfo.discountRate,
        allowanceUsed: friendInfo.isFriend ? Math.min(friendInfo.allowanceRemaining, baseTax) : 0,
        totalFee
      }
    };
  }
}

module.exports = TaxCalculator;
```

### 3. social-service 集成

```javascript
// backend/services/social-service/src/routes/tradeTax.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../../../shared/middleware/auth');
const TaxCalculator = require('../../../shared/TaxCalculator');

// 预览交易税费
router.post('/preview', authenticate, async (req, res) => {
  try {
    const { sellerId, tradeValue, currencyType = 'coins' } = req.body;
    const buyerId = req.user.id;

    if (sellerId === buyerId) {
      return res.status(400).json({ error: 'Cannot trade with yourself' });
    }

    const calculator = new TaxCalculator(req.db, req.cache);
    const taxInfo = await calculator.calculateTax(sellerId, buyerId, tradeValue, currencyType);

    res.json({
      success: true,
      data: taxInfo
    });
  } catch (error) {
    req.logger.error('Tax preview failed', { error: error.message });
    res.status(500).json({ error: 'Failed to calculate tax' });
  }
});

// 记录交易税收
router.post('/record', authenticate, async (req, res) => {
  try {
    const { tradeId, sellerId, buyerId, pokemonId, tradeValue, currencyType = 'coins' } = req.body;

    const calculator = new TaxCalculator(req.db, req.cache);
    const taxInfo = await calculator.calculateTax(sellerId, buyerId, tradeValue, currencyType);

    // 保存税收记录
    await req.db.query(`
      INSERT INTO trade_tax_records (
        trade_id, seller_id, buyer_id, pokemon_id, trade_value,
        tax_tier, tax_rate, tax_amount, fixed_fee, total_fee,
        currency_type, friend_discount, final_fee
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      tradeId, sellerId, buyerId, pokemonId, tradeValue,
      taxInfo.taxTier, taxInfo.taxRate, taxInfo.baseTax, taxInfo.fixedFee,
      taxInfo.totalFee, taxInfo.currencyType, taxInfo.friendDiscount, taxInfo.finalFee
    ]);

    // 扣除卖家手续费
    if (taxInfo.finalFee > 0) {
      await req.db.query(`
        UPDATE user_balances 
        SET ${currencyType} = ${currencyType} - $1
        WHERE user_id = $2
      `, [taxInfo.finalFee, sellerId]);
    }

    // 更新税收统计
    await updateTaxStats(req.db, currencyType, tradeValue, taxInfo.finalFee);

    res.json({
      success: true,
      data: {
        tradeId,
        feeCollected: taxInfo.finalFee
      }
    });
  } catch (error) {
    req.logger.error('Tax record failed', { error: error.message });
    res.status(500).json({ error: 'Failed to record tax' });
  }
});

// 获取税收统计
router.get('/stats', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, currencyType } = req.query;

    const stats = await req.db.query(`
      SELECT 
        stat_date,
        total_trades,
        total_trade_value,
        total_tax_revenue,
        avg_tax_rate
      FROM tax_revenue_stats
      WHERE stat_date BETWEEN $1 AND $2
        AND currency_type = $3
      ORDER BY stat_date DESC
    `, [startDate, endDate, currencyType || 'coins']);

    res.json({
      success: true,
      data: stats.rows
    });
  } catch (error) {
    req.logger.error('Tax stats query failed', { error: error.message });
    res.status(500).json({ error: 'Failed to get tax stats' });
  }
});

// 更新税收统计
async function updateTaxStats(db, currencyType, tradeValue, taxRevenue) {
  const today = new Date().toISOString().split('T')[0];
  
  await db.query(`
    INSERT INTO tax_revenue_stats (stat_date, total_trades, total_trade_value, total_tax_revenue, currency_type)
    VALUES ($1, 1, $2, $3, $4)
    ON CONFLICT (stat_date, currency_type)
    DO UPDATE SET
      total_trades = tax_revenue_stats.total_trades + 1,
      total_trade_value = tax_revenue_stats.total_trade_value + $2,
      total_tax_revenue = tax_revenue_stats.total_tax_revenue + $3,
      avg_tax_rate = (tax_revenue_stats.total_tax_revenue + $3) / NULLIF(tax_revenue_stats.total_trade_value + $2, 0)
  `, [today, tradeValue, taxRevenue, currencyType]);
}

module.exports = router;
```

### 4. 游戏客户端税费预览组件

```javascript
// frontend/game-client/src/components/TradeTaxPreview.js
import React, { useState, useEffect } from 'react';
import { api } from '../api';

export function TradeTaxPreview({ sellerId, tradeValue, currencyType = 'coins', onTaxCalculated }) {
  const [taxInfo, setTaxInfo] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sellerId || !tradeValue) return;
    
    const calculateTax = async () => {
      setLoading(true);
      try {
        const response = await api.post('/social/trade-tax/preview', {
          sellerId,
          tradeValue,
          currencyType
        });
        setTaxInfo(response.data);
        onTaxCalculated?.(response.data);
      } catch (error) {
        console.error('Tax calculation failed:', error);
      } finally {
        setLoading(false);
      }
    };

    const debounceTimer = setTimeout(calculateTax, 300);
    return () => clearTimeout(debounceTimer);
  }, [sellerId, tradeValue, currencyType]);

  if (loading) {
    return <div className="tax-preview loading">计算中...</div>;
  }

  if (!taxInfo) return null;

  return (
    <div className="tax-preview">
      <h4>交易手续费</h4>
      <div className="tax-breakdown">
        <div className="tax-row">
          <span>交易价值</span>
          <span>{taxInfo.breakdown.tradeValue.toLocaleString()} {currencyType}</span>
        </div>
        <div className="tax-row">
          <span>税率档次</span>
          <span>{taxInfo.taxTier} ({(taxInfo.taxRate * 100).toFixed(1)}%)</span>
        </div>
        <div className="tax-row">
          <span>比例税费</span>
          <span>{taxInfo.breakdown.percentageTax.toLocaleString()} {currencyType}</span>
        </div>
        {taxInfo.breakdown.fixedFee > 0 && (
          <div className="tax-row">
            <span>固定手续费</span>
            <span>{taxInfo.breakdown.fixedFee.toLocaleString()} {currencyType}</span>
          </div>
        )}
        {taxInfo.isFriend && (
          <>
            <div className="tax-row discount">
              <span>好友折扣 ({(taxInfo.friendDiscount * 100).toFixed(0)}%)</span>
              <span>-{taxInfo.breakdown.friendDiscountAmount.toLocaleString()} {currencyType}</span>
            </div>
            {taxInfo.breakdown.allowanceUsed > 0 && (
              <div className="tax-row discount">
                <span>免税额度</span>
                <span>-{taxInfo.breakdown.allowanceUsed.toLocaleString()} {currencyType}</span>
              </div>
            )}
          </>
        )}
        <div className="tax-row total">
          <span>实际手续费</span>
          <span>{taxInfo.breakdown.totalFee.toLocaleString()} {currencyType}</span>
        </div>
        <div className="tax-row net">
          <span>卖家实际收入</span>
          <span>{(taxInfo.breakdown.tradeValue - taxInfo.breakdown.totalFee).toLocaleString()} {currencyType}</span>
        </div>
      </div>
    </div>
  );
}
```

## 验收标准

- [ ] 税率配置表创建完成，支持多档次税率设置
- [ ] 交易税费计算逻辑正确，支持按交易价值自动匹配税率档次
- [ ] 好友折扣功能实现，根据好友等级计算折扣率
- [ ] 免税额度功能实现，每日自动重置
- [ ] 税收记录正确保存，包含完整交易信息
- [ ] 手续费从卖家账户正确扣除
- [ ] 税收统计数据自动更新
- [ ] 游戏客户端税费预览组件正确显示明细
- [ ] 单元测试覆盖税费计算核心逻辑
- [ ] API 文档更新完成

## 影响范围

- **social-service**: 新增交易税费相关路由和服务
- **pokemon-service**: 交易流程需要集成税费计算
- **user-service**: 用户余额扣除操作
- **payment-service**: 支付记录需要包含税费信息
- **gateway**: 新增路由代理配置
- **game-client**: 交易界面需要显示税费预览
- **database/migrations**: 新增4张数据表

## 参考

- REQ-00104: 精灵交换市场与竞价拍卖系统
- REQ-00051: 多货币支持与汇率转换系统
- 游戏经济系统设计最佳实践
