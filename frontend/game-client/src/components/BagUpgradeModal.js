// frontend/game-client/src/components/BagUpgradeModal.js
// REQ-00150: 背包容量扩展与购买系统 - 前端组件

'use strict';

import { useState, useEffect } from 'react';
import { apiClient } from '../utils/apiClient';
import { NotificationManager } from './NotificationManager';

/**
 * 背包扩容模态框组件
 */
export function BagUpgradeModal({ category, userGold, userGems, onClose, onSuccess }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchConfigs();
  }, [category]);

  /**
   * 获取扩容配置列表
   */
  const fetchConfigs = async () => {
    try {
      setLoading(true);
      const data = await apiClient.get('/inventory/upgrades');
      const filtered = data.filter(c => !category || c.category === category);
      setConfigs(filtered);
    } catch (err) {
      setError('加载扩容配置失败');
      console.error('Failed to fetch upgrade configs:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 购买背包扩容
   */
  const handlePurchase = async (upgradeId, method) => {
    const config = configs.find(c => c.upgrade_id === upgradeId);
    if (!config) return;

    const cost = method === 'gold' ? config.gold_cost : config.gem_cost;
    const currency = method === 'gold' ? '金币' : '宝石';
    const balance = method === 'gold' ? userGold : userGems;

    // 检查余额
    if (balance < cost) {
      NotificationManager.error(`${currency}不足，需要 ${cost.toLocaleString()} ${currency}`);
      return;
    }

    // 确认购买
    const confirmed = confirm(`确定花费 ${cost.toLocaleString()} ${currency} 购买 +${config.increment} 格背包空间？`);
    if (!confirmed) return;

    try {
      setPurchasing(true);
      const result = await apiClient.post(`/inventory/upgrades/${upgradeId}/purchase`, { method });
      
      NotificationManager.success(`背包扩容成功！+${result.increment} 格空间`);
      
      // 回调成功事件
      if (onSuccess) {
        onSuccess({
          category: result.category,
          increment: result.increment,
          cost: result.cost,
          method: result.method,
          newBalance: result.newBalance
        });
      }
      
      // 重新加载配置
      await fetchConfigs();
      
    } catch (err) {
      const msg = err.message || '购买失败，请重试';
      NotificationManager.error(msg);
      console.error('Failed to purchase upgrade:', err);
    } finally {
      setPurchasing(false);
    }
  };

  /**
   * 渲染价格按钮
   */
  const renderPriceButton = (config, method) => {
    const cost = method === 'gold' ? config.gold_cost : config.gem_cost;
    if (!cost) return null;

    const balance = method === 'gold' ? userGold : userGems;
    const canAfford = balance >= cost;
    const disabled = !config.available || !canAfford || purchasing;

    return (
      <button
        key={method}
        className={`upgrade-btn ${method}`}
        onClick={() => handlePurchase(config.upgrade_id, method)}
        disabled={disabled}
      >
        <span className="currency-icon">
          {method === 'gold' ? '💰' : '💎'}
        </span>
        <span className="cost">{cost.toLocaleString()}</span>
        {!canAfford && <span className="insufficient">(余额不足)</span>}
      </button>
    );
  };

  /**
   * 格式化类别名称
   */
  const formatCategory = (cat) => {
    const categoryNames = {
      base: '基础背包',
      pokeball: '精灵球',
      potion: '药水',
      tm: '技能机器',
      evolution: '进化道具',
      special: '特殊道具'
    };
    return categoryNames[cat] || cat;
  };

  if (loading) {
    return (
      <div className="bag-upgrade-modal">
        <div className="loading">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bag-upgrade-modal">
        <div className="error">{error}</div>
        <button onClick={onClose}>关闭</button>
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      <div className="bag-upgrade-modal">
        <h2>背包扩容</h2>
        <div className="empty">暂无可用的扩容选项</div>
        <button onClick={onClose}>关闭</button>
      </div>
    );
  }

  // 按类别分组
  const groupedConfigs = configs.reduce((acc, config) => {
    if (!acc[config.category]) {
      acc[config.category] = [];
    }
    acc[config.category].push(config);
    return acc;
  }, {});

  return (
    <div className="bag-upgrade-modal">
      <div className="modal-header">
        <h2>🎒 背包扩容</h2>
        <button className="close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="user-balance">
        <span>💰 金币: {userGold.toLocaleString()}</span>
        <span>💎 宝石: {userGems.toLocaleString()}</span>
      </div>

      <div className="upgrade-list">
        {Object.entries(groupedConfigs).map(([cat, items]) => (
          <div key={cat} className="upgrade-category">
            <h3 className="category-title">{formatCategory(cat)}</h3>
            
            {items.map(config => (
              <div key={config.upgrade_id} className="upgrade-item">
                <div className="upgrade-info">
                  <span className="increment">+{config.increment} 格</span>
                  <span className="level-req">
                    Lv.{config.required_level} 解锁
                  </span>
                  <span className="purchase-count">
                    已购: {config.purchased}/{config.max_upgrades}
                  </span>
                </div>

                <div className="upgrade-actions">
                  {!config.available ? (
                    <span className="max-reached">已达上限</span>
                  ) : (
                    <>
                      {renderPriceButton(config, 'gold')}
                      {renderPriceButton(config, 'gem')}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="modal-footer">
        <button className="cancel-btn" onClick={onClose}>关闭</button>
      </div>

      <style>{`
        .bag-upgrade-modal {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 16px;
          padding: 24px;
          max-width: 500px;
          max-height: 80vh;
          overflow-y: auto;
          color: white;
          box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .modal-header h2 {
          margin: 0;
          font-size: 24px;
        }

        .close-btn {
          background: rgba(255,255,255,0.2);
          border: none;
          color: white;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 18px;
        }

        .user-balance {
          display: flex;
          justify-content: space-around;
          background: rgba(255,255,255,0.1);
          padding: 12px;
          border-radius: 8px;
          margin-bottom: 20px;
        }

        .upgrade-category {
          margin-bottom: 20px;
        }

        .category-title {
          font-size: 18px;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 2px solid rgba(255,255,255,0.3);
        }

        .upgrade-item {
          background: rgba(255,255,255,0.15);
          padding: 16px;
          border-radius: 12px;
          margin-bottom: 12px;
        }

        .upgrade-info {
          display: flex;
          justify-content: space-between;
          margin-bottom: 12px;
          font-size: 14px;
        }

        .increment {
          font-size: 18px;
          font-weight: bold;
        }

        .purchase-count {
          color: rgba(255,255,255,0.7);
        }

        .upgrade-actions {
          display: flex;
          gap: 12px;
        }

        .upgrade-btn {
          flex: 1;
          padding: 10px 16px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 14px;
          font-weight: bold;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.3s;
        }

        .upgrade-btn.gold {
          background: linear-gradient(135deg, #f6d365 0%, #fda085 100%);
          color: #333;
        }

        .upgrade-btn.gem {
          background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
          color: #333;
        }

        .upgrade-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .upgrade-btn:not(:disabled):hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }

        .insufficient {
          font-size: 12px;
          opacity: 0.8;
        }

        .max-reached {
          color: rgba(255,255,255,0.5);
          font-style: italic;
        }

        .modal-footer {
          margin-top: 20px;
          text-align: center;
        }

        .cancel-btn {
          background: rgba(255,255,255,0.2);
          color: white;
          border: none;
          padding: 12px 32px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 16px;
        }

        .cancel-btn:hover {
          background: rgba(255,255,255,0.3);
        }

        .loading, .error, .empty {
          text-align: center;
          padding: 40px;
          font-size: 16px;
        }

        .error {
          color: #ff6b6b;
        }
      `}</style>
    </div>
  );
}

export default BagUpgradeModal;
