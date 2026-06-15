// frontend/game-client/src/components/LazyComponents.js
// Lazy-loaded component wrappers
'use strict';

import { createLazyComponent, lazyLoader } from '../utils/lazyLoad.js';
import { prefetchStrategy } from '../utils/prefetchStrategy.js';

// ── 3D 模型查看器（懒加载）─────────────────────────────────
export const Pokemon3DViewer = createLazyComponent(
  () => import('../3d/Pokemon3DViewer.js'),
  {
    chunkName: 'pokemon-3d-viewer',
    placeholder: `
      <div class="lazy-load-placeholder loading-3d">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载 3D 查看器...</div>
        <div class="lazy-load-progress">
          <div class="lazy-load-progress-bar"></div>
        </div>
      </div>
    `,
    errorComponent: (error) => `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">⚠️</div>
        <div class="lazy-load-error-text">3D 查看器加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    retryDelay: 1000,
    preload: false
  }
);

// ── 战斗场景（懒加载）───────────────────────────────────────
export const BattleScene = createLazyComponent(
  () => import('./BattleScene.js'),
  {
    chunkName: 'battle-scene',
    placeholder: `
      <div class="lazy-load-placeholder loading-battle">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载战斗系统...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">⚔️</div>
        <div class="lazy-load-error-text">战斗系统加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 音效播放器（懒加载）─────────────────────────────────────
export const AudioPlayer = createLazyComponent(
  () => import('../audio/AudioPlayer.js'),
  {
    chunkName: 'audio-player',
    placeholder: null, // 音效不需要占位符
    retryCount: 1,
    preload: false
  }
);

// ── 交易模态框（懒加载）─────────────────────────────────────
export const TradingModal = createLazyComponent(
  () => import('./TradingModal.js'),
  {
    chunkName: 'trading-modal',
    placeholder: `
      <div class="lazy-load-placeholder loading-modal">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载交易系统...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">💱</div>
        <div class="lazy-load-error-text">交易系统加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 排行榜面板（懒加载）─────────────────────────────────────
export const LeaderboardPanel = createLazyComponent(
  () => import('./LeaderboardPanel.js'),
  {
    chunkName: 'leaderboard-panel',
    placeholder: `
      <div class="lazy-load-placeholder loading-leaderboard">
        <div class="skeleton skeleton-circle skeleton-avatar"></div>
        <div class="skeleton skeleton-text long"></div>
        <div class="skeleton skeleton-text medium"></div>
        <div class="skeleton skeleton-text short"></div>
        <div class="loading-text">加载排行榜...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">🏆</div>
        <div class="lazy-load-error-text">排行榜加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 聊天面板（懒加载）───────────────────────────────────────
export const ChatPanel = createLazyComponent(
  () => import('./ChatPanel.js'),
  {
    chunkName: 'chat-panel',
    placeholder: `
      <div class="lazy-load-placeholder loading-chat">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载聊天系统...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">💬</div>
        <div class="lazy-load-error-text">聊天系统加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 道馆详情（懒加载）───────────────────────────────────────
export const GymDetail = createLazyComponent(
  () => import('./GymDetail.js'),
  {
    chunkName: 'gym-detail',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="skeleton skeleton-image"></div>
        <div class="skeleton skeleton-text long"></div>
        <div class="skeleton skeleton-text medium"></div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">🏛️</div>
        <div class="lazy-load-error-text">道馆详情加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 精灵详情（懒加载）───────────────────────────────────────
export const PokemonDetail = createLazyComponent(
  () => import('./PokemonDetail.js'),
  {
    chunkName: 'pokemon-detail',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="skeleton skeleton-circle" style="width: 80px; height: 80px;"></div>
        <div class="skeleton skeleton-text long"></div>
        <div class="skeleton skeleton-text medium"></div>
        <div class="skeleton skeleton-text short"></div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">🎮</div>
        <div class="lazy-load-error-text">精灵详情加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 图鉴面板（懒加载）───────────────────────────────────────
export const PokedexPanel = createLazyComponent(
  () => import('./PokedexPanel.js'),
  {
    chunkName: 'pokedex-panel',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="skeleton skeleton-text long"></div>
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px;">
          <div class="skeleton" style="height: 100px;"></div>
          <div class="skeleton" style="height: 100px;"></div>
          <div class="skeleton" style="height: 100px;"></div>
        </div>
        <div class="loading-text">加载图鉴...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">📖</div>
        <div class="lazy-load-error-text">图鉴加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 商店面板（懒加载）───────────────────────────────────────
export const ShopPanel = createLazyComponent(
  () => import('./ShopPanel.js'),
  {
    chunkName: 'shop-panel',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="skeleton skeleton-text long"></div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 16px;">
          <div class="skeleton skeleton-card">
            <div class="skeleton skeleton-text short"></div>
            <div class="skeleton skeleton-text medium"></div>
          </div>
          <div class="skeleton skeleton-card">
            <div class="skeleton skeleton-text short"></div>
            <div class="skeleton skeleton-text medium"></div>
          </div>
        </div>
        <div class="loading-text">加载商店...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">🛒</div>
        <div class="lazy-load-error-text">商店加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 设置面板（懒加载）───────────────────────────────────────
export const SettingsPanel = createLazyComponent(
  () => import('./SettingsPanel.js'),
  {
    chunkName: 'settings-panel',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="skeleton skeleton-text long"></div>
        <div class="skeleton skeleton-text medium"></div>
        <div class="skeleton skeleton-text short"></div>
        <div class="loading-text">加载设置...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">⚙️</div>
        <div class="lazy-load-error-text">设置加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 1,
    preload: false
  }
);

// ── 背包面板（懒加载）───────────────────────────────────────
export const InventoryPanel = createLazyComponent(
  () => import('./InventoryPanel.js'),
  {
    chunkName: 'inventory-panel',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="skeleton skeleton-text long"></div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px;">
          <div class="skeleton" style="height: 60px;"></div>
          <div class="skeleton" style="height: 60px;"></div>
          <div class="skeleton" style="height: 60px;"></div>
          <div class="skeleton" style="height: 60px;"></div>
        </div>
        <div class="loading-text">加载背包...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">🎒</div>
        <div class="lazy-load-error-text">背包加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 道馆战斗（懒加载）───────────────────────────────────────
export const GymBattle = createLazyComponent(
  () => import('./GymBattle.js'),
  {
    chunkName: 'gym-battle',
    placeholder: `
      <div class="lazy-load-placeholder loading-battle">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载道馆战斗...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">⚔️</div>
        <div class="lazy-load-error-text">道馆战斗加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 支付模态框（懒加载）─────────────────────────────────────
export const PaymentModal = createLazyComponent(
  () => import('./PaymentModal.js'),
  {
    chunkName: 'payment-modal',
    placeholder: `
      <div class="lazy-load-placeholder loading-modal">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载支付...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">💳</div>
        <div class="lazy-load-error-text">支付系统加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 帮助面板（懒加载）───────────────────────────────────────
export const HelpPanel = createLazyComponent(
  () => import('./HelpPanel.js'),
  {
    chunkName: 'help-panel',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载帮助文档...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">❓</div>
        <div class="lazy-load-error-text">帮助文档加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 1,
    preload: false
  }
);

// ── 社交面板（懒加载）───────────────────────────────────────
export const SocialPanel = createLazyComponent(
  () => import('./SocialPanel.js'),
  {
    chunkName: 'social-panel',
    placeholder: `
      <div class="lazy-load-placeholder">
        <div class="skeleton skeleton-text long"></div>
        <div style="display: flex; gap: 10px; margin-top: 12px;">
          <div class="skeleton skeleton-circle skeleton-avatar"></div>
          <div class="skeleton skeleton-circle skeleton-avatar"></div>
          <div class="skeleton skeleton-circle skeleton-avatar"></div>
        </div>
        <div class="loading-text">加载社交...</div>
      </div>
    `,
    errorComponent: `
      <div class="lazy-load-error">
        <div class="lazy-load-error-icon">👥</div>
        <div class="lazy-load-error-text">社交系统加载失败</div>
        <button class="retry-btn">重试</button>
      </div>
    `,
    retryCount: 2,
    preload: false
  }
);

// ── 战斗特效（懒加载）───────────────────────────────────────
export const BattleEffects = createLazyComponent(
  () => import('../effects/BattleEffects.js'),
  {
    chunkName: 'battle-effects',
    placeholder: null,
    retryCount: 1,
    preload: false
  }
);

// ── 导出懒加载工具 ──────────────────────────────────────────
export { lazyLoader, prefetchStrategy };
