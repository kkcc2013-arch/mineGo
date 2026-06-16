/**
 * REQ-00160: 精灵特殊个体值（彩蛋）系统
 * 特殊 IV 徽章组件
 * 
 * 创建时间: 2026-06-16 17:00
 */

'use strict';

// ============================================================
// 特殊 IV 徽章渲染器
// ============================================================

class SpecialIVBadge {
  /**
   * 渲染特殊 IV 徽章
   * @param {Object} pokemon - 精灵数据
   * @param {boolean} pokemon.is_zero_iv - 零 IV 标识
   * @param {boolean} pokemon.is_perfect_iv - 完美 IV 标识
   * @param {boolean} pokemon.is_lucky - 幸运精灵标识
   * @returns {string} HTML 字符串
   */
  static render(pokemon) {
    const badges = [];
    
    // 零 IV 徽章（灰色）
    if (pokemon.is_zero_iv) {
      badges.push(`
        <span class="special-iv-badge zero-iv" title="零值精灵 - 攻击/防御/HP 都是 0，稀有收藏品">
          ⭕ 零值
        </span>
      `);
    }
    
    // 完美 IV 徽章（金色）
    if (pokemon.is_perfect_iv) {
      badges.push(`
        <span class="special-iv-badge perfect-iv" title="完美精灵 - 攻击/防御/HP 都是 15，100% 完美度">
          💎 完美
        </span>
      `);
    }
    
    // 幸运精灵徽章（绿色）
    if (pokemon.is_lucky) {
      badges.push(`
        <span class="special-iv-badge lucky" title="幸运精灵 - 通过好友交换获得，IV 下限 12">
          🍀 幸运
        </span>
      `);
    }
    
    return badges.join('');
  }
  
  /**
   * 渲染 IV 详情（包含特殊标识）
   * @param {Object} pokemon - 精灵数据
   * @returns {string} HTML 字符串
   */
  static renderIVDetail(pokemon) {
    const ivTotal = Math.round(
      ((pokemon.iv_attack || 0) + (pokemon.iv_defense || 0) + (pokemon.iv_hp || 0)) / 45 * 100
    );
    
    const ivClass = ivTotal >= 90 ? 'excellent' : ivTotal >= 80 ? 'great' : ivTotal >= 60 ? 'good' : 'normal';
    
    return `
      <div class="iv-detail">
        <div class="iv-bars">
          <div class="iv-row">
            <span class="iv-label">攻击</span>
            <div class="iv-bar">
              <div class="iv-fill" style="width: ${((pokemon.iv_attack || 0) / 15) * 100}%"></div>
            </div>
            <span class="iv-value">${pokemon.iv_attack || 0}/15</span>
          </div>
          <div class="iv-row">
            <span class="iv-label">防御</span>
            <div class="iv-bar">
              <div class="iv-fill" style="width: ${((pokemon.iv_defense || 0) / 15) * 100}%"></div>
            </div>
            <span class="iv-value">${pokemon.iv_defense || 0}/15</span>
          </div>
          <div class="iv-row">
            <span class="iv-label">HP</span>
            <div class="iv-bar">
              <div class="iv-fill" style="width: ${((pokemon.iv_hp || 0) / 15) * 100}%"></div>
            </div>
            <span class="iv-value">${pokemon.iv_hp || 0}/15</span>
          </div>
        </div>
        <div class="iv-summary">
          <span class="iv-total ${ivClass}">总评: ${ivTotal}%</span>
          ${this.render(pokemon)}
        </div>
      </div>
    `;
  }
  
  /**
   * 渲染特殊 IV 统计卡片
   * @param {Object} stats - 统计数据
   * @returns {string} HTML 字符串
   */
  static renderStatsCard(stats) {
    return `
      <div class="special-iv-stats-card">
        <h3>特殊精灵统计</h3>
        <div class="stats-grid">
          <div class="stat-item zero-iv">
            <span class="stat-icon">⭕</span>
            <span class="stat-label">零值精灵</span>
            <span class="stat-value">${stats.zero_iv_count || 0}</span>
          </div>
          <div class="stat-item perfect-iv">
            <span class="stat-icon">💎</span>
            <span class="stat-label">完美精灵</span>
            <span class="stat-value">${stats.perfect_iv_count || 0}</span>
          </div>
          <div class="stat-item lucky">
            <span class="stat-icon">🍀</span>
            <span class="stat-label">幸运精灵</span>
            <span class="stat-value">${stats.lucky_count || 0}</span>
          </div>
        </div>
        <div class="stats-note">
          <p>💡 零值精灵和完美精灵在捕捉时随机出现</p>
          <p>🍀 幸运精灵通过好友交换获得</p>
        </div>
      </div>
    `;
  }
}

// ============================================================
// CSS 样式（注入到页面）
// ============================================================

const SPECIAL_IV_STYLES = `
.special-iv-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: bold;
  margin: 2px;
  animation: badge-glow 2s ease-in-out infinite;
}

.special-iv-badge.zero-iv {
  background: linear-gradient(135deg, #666 0%, #999 100%);
  color: white;
  border: 1px solid #444;
}

.special-iv-badge.perfect-iv {
  background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%);
  color: #333;
  border: 1px solid #DAA520;
  box-shadow: 0 0 8px rgba(255, 215, 0, 0.5);
}

.special-iv-badge.lucky {
  background: linear-gradient(135deg, #4CAF50 0%, #8BC34A 100%);
  color: white;
  border: 1px solid #388E3C;
  box-shadow: 0 0 8px rgba(76, 175, 80, 0.5);
}

@keyframes badge-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.85; }
}

.iv-detail {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 8px;
  padding: 12px;
  margin: 8px 0;
}

.iv-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.iv-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.iv-label {
  width: 40px;
  font-size: 12px;
  color: #666;
}

.iv-bar {
  flex: 1;
  height: 8px;
  background: #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
}

.iv-fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50 0%, #8BC34A 100%);
  transition: width 0.3s ease;
}

.iv-value {
  width: 40px;
  font-size: 12px;
  text-align: right;
  color: #333;
}

.iv-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
}

.iv-total {
  font-weight: bold;
  font-size: 14px;
}

.iv-total.excellent { color: #4CAF50; }
.iv-total.great { color: #8BC34A; }
.iv-total.good { color: #FFC107; }
.iv-total.normal { color: #9E9E9E; }

.special-iv-stats-card {
  background: white;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.special-iv-stats-card h3 {
  margin: 0 0 12px 0;
  font-size: 16px;
  color: #333;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.02);
}

.stat-item.zero-iv { border-left: 3px solid #666; }
.stat-item.perfect-iv { border-left: 3px solid #FFD700; }
.stat-item.lucky { border-left: 3px solid #4CAF50; }

.stat-icon {
  font-size: 24px;
  margin-bottom: 4px;
}

.stat-label {
  font-size: 11px;
  color: #666;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 18px;
  font-weight: bold;
  color: #333;
}

.stats-note {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
}

.stats-note p {
  margin: 4px 0;
  font-size: 12px;
  color: #666;
}
`;

// 注入样式到页面
function injectSpecialIVStyles() {
  if (document.getElementById('special-iv-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'special-iv-styles';
  style.textContent = SPECIAL_IV_STYLES;
  document.head.appendChild(style);
}

// 自动注入样式
if (typeof document !== 'undefined') {
  injectSpecialIVStyles();
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SpecialIVBadge, injectSpecialIVStyles };
}
