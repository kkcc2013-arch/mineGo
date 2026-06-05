/**
 * 精灵详情页 3D 展示组件
 * 集成 Pokemon3DViewer，支持动作控制和模式切换
 */

import { Pokemon3DViewer } from './Pokemon3DViewer.js';

export class PokemonDetailViewer {
  constructor(options = {}) {
    this._options = {
      containerId: 'pokemon-detail-viewer',
      imageBaseUrl: '/assets/images/pokemon',
      modelBaseUrl: '/assets/3d/pokemon',
      autoDowngrade: true,
      onDowngrade: null,
      ...options
    };

    this._viewer = null;
    this._container = null;
    this._is3DMode = true;
    this._currentPokemon = null;
    this._fallbackImage = null;
  }

  /**
   * 初始化查看器
   */
  init() {
    this._container = document.getElementById(this._options.containerId);
    if (!this._container) {
      console.error('[PokemonDetailViewer] Container not found:', this._options.containerId);
      return false;
    }

    // 创建 UI 结构
    this._createUI();

    // 初始化 3D 查看器
    this._initViewer();

    return true;
  }

  /**
   * 创建 UI 结构
   */
  _createUI() {
    this._container.innerHTML = `
      <div class="pokemon-viewer-wrapper">
        <!-- 3D 渲染区域 -->
        <div class="pokemon-3d-container" id="viewer-3d-container"></div>
        
        <!-- 2D 图片降级区域 -->
        <div class="pokemon-2d-container" id="viewer-2d-container" style="display:none;">
          <img class="pokemon-2d-image" id="viewer-2d-image" alt="Pokemon" />
          <div class="pokemon-2d-placeholder" id="viewer-2d-placeholder"></div>
        </div>
        
        <!-- 控制按钮 -->
        <div class="viewer-controls">
          <div class="action-buttons">
            <button class="action-btn" data-action="attack" title="攻击动作">
              <span class="action-icon">⚔️</span>
              <span class="action-label">攻击</span>
            </button>
            <button class="action-btn" data-action="hit" title="受击动作">
              <span class="action-icon">💥</span>
              <span class="action-label">受击</span>
            </button>
            <button class="action-btn" data-action="celebrate" title="庆祝动作">
              <span class="action-icon">🎉</span>
              <span class="action-label">庆祝</span>
            </button>
          </div>
          
          <div class="mode-toggle">
            <button class="toggle-btn" id="toggle-2d-btn">
              <span class="toggle-icon">🖼️</span>
              <span class="toggle-label">切换 2D</span>
            </button>
            <button class="toggle-btn" id="toggle-3d-btn" style="display:none;">
              <span class="toggle-icon">🎮</span>
              <span class="toggle-label">切换 3D</span>
            </button>
          </div>
        </div>
        
        <!-- 加载状态 -->
        <div class="viewer-loading" id="viewer-loading">
          <div class="spinner"></div>
          <div class="loading-text">加载中...</div>
        </div>
        
        <!-- 提示信息 -->
        <div class="viewer-hint" id="viewer-hint">
          拖拽旋转 · 滚轮缩放
        </div>
      </div>
    `;

    // 添加样式
    this._addStyles();

    // 绑定事件
    this._bindEvents();
  }

  /**
   * 添加样式
   */
  _addStyles() {
    if (document.getElementById('pokemon-detail-viewer-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'pokemon-detail-viewer-styles';
    styles.textContent = `
      .pokemon-viewer-wrapper {
        position: relative;
        width: 100%;
        height: 400px;
        background: linear-gradient(160deg, #0d0f14 0%, #13161e 60%, #0f1520 100%);
        border-radius: 16px;
        overflow: hidden;
      }

      .pokemon-3d-container,
      .pokemon-2d-container {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }

      .pokemon-3d-container canvas {
        width: 100% !important;
        height: 100% !important;
      }

      .pokemon-2d-image {
        width: 100%;
        height: 100%;
        object-fit: contain;
        padding: 40px;
      }

      .pokemon-2d-placeholder {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 120px;
        text-align: center;
        opacity: 0.9;
      }

      .viewer-controls {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        padding: 16px;
        background: linear-gradient(transparent, rgba(13, 15, 20, 0.95));
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }

      .action-buttons {
        display: flex;
        gap: 8px;
      }

      .action-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 10px 16px;
        background: rgba(19, 22, 30, 0.8);
        border: 1px solid #252938;
        border-radius: 12px;
        color: #e8eaf0;
        cursor: pointer;
        transition: all 0.2s;
      }

      .action-btn:hover {
        background: rgba(26, 30, 40, 0.9);
        border-color: #3d8ef8;
        transform: translateY(-2px);
      }

      .action-btn:active {
        transform: translateY(0);
      }

      .action-icon {
        font-size: 20px;
      }

      .action-label {
        font-size: 11px;
        font-weight: 600;
      }

      .mode-toggle {
        display: flex;
        gap: 8px;
      }

      .toggle-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 16px;
        background: rgba(19, 22, 30, 0.8);
        border: 1px solid #252938;
        border-radius: 12px;
        color: #6b7280;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s;
      }

      .toggle-btn:hover {
        background: rgba(26, 30, 40, 0.9);
        color: #e8eaf0;
      }

      .toggle-icon {
        font-size: 16px;
      }

      .viewer-loading {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        z-index: 10;
      }

      .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid #252938;
        border-top-color: #3d8ef8;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .loading-text {
        font-size: 13px;
        color: #6b7280;
        font-weight: 600;
      }

      .viewer-hint {
        position: absolute;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        padding: 6px 16px;
        background: rgba(19, 22, 30, 0.8);
        border: 1px solid #252938;
        border-radius: 20px;
        font-size: 11px;
        color: #6b7280;
        font-weight: 600;
        opacity: 0.8;
        transition: opacity 0.3s;
      }

      .viewer-hint:hover {
        opacity: 1;
      }

      /* 响应式 */
      @media (max-width: 480px) {
        .pokemon-viewer-wrapper {
          height: 350px;
        }

        .action-btn {
          padding: 8px 12px;
        }

        .action-icon {
          font-size: 18px;
        }

        .action-label {
          font-size: 10px;
        }
      }
    `;
    document.head.appendChild(styles);
  }

  /**
   * 绑定事件
   */
  _bindEvents() {
    // 动作按钮
    this._container.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        this.playAction(action);
      });
    });

    // 切换 2D 按钮
    document.getElementById('toggle-2d-btn').addEventListener('click', () => {
      this.switchTo2D();
    });

    // 切换 3D 按钮
    document.getElementById('toggle-3d-btn').addEventListener('click', () => {
      this.switchTo3D();
    });

    // 监听降级事件
    document.getElementById('viewer-3d-container').addEventListener('downgrade', (e) => {
      console.log('[PokemonDetailViewer] Auto downgrade triggered:', e.detail);
      this.switchTo2D(true);
    });
  }

  /**
   * 初始化 3D 查看器
   */
  _initViewer() {
    const container3D = document.getElementById('viewer-3d-container');
    
    try {
      this._viewer = new Pokemon3DViewer(container3D, {
        autoDowngrade: this._options.autoDowngrade
      });
      this._is3DMode = true;
    } catch (error) {
      console.error('[PokemonDetailViewer] Failed to init 3D viewer:', error);
      this.switchTo2D(true);
    }
  }

  /**
   * 显示精灵
   */
  async showPokemon(pokemon) {
    this._currentPokemon = pokemon;
    
    // 显示加载状态
    const loading = document.getElementById('viewer-loading');
    loading.style.display = 'flex';

    try {
      if (this._is3DMode && this._viewer) {
        // 加载 3D 模型
        await this._viewer.loadModel(pokemon.speciesId, pokemon.variant || 'normal');
        
        // 设置稀有特效
        if (pokemon.rarity) {
          this._viewer.setRarityEffect(pokemon.rarity);
        }
      } else {
        // 加载 2D 图片
        this._load2DImage(pokemon);
      }
    } catch (error) {
      console.error('[PokemonDetailViewer] Failed to show pokemon:', error);
      if (this._is3DMode) {
        this.switchTo2D(true);
        this._load2DImage(pokemon);
      }
    } finally {
      loading.style.display = 'none';
    }
  }

  /**
   * 加载 2D 图片
   */
  _load2DImage(pokemon) {
    const imageEl = document.getElementById('viewer-2d-image');
    const placeholder = document.getElementById('viewer-2d-placeholder');

    // 使用 emoji 作为占位符
    const pokemonEmojis = {
      1: '🌱', 2: '🌿', 3: '🍃', // Bulbasaur line
      4: '🔥', 5: '🔥', 6: '🔥', // Charmander line
      7: '💧', 8: '💧', 9: '💧', // Squirtle line
      25: '⚡', // Pikachu
      // 默认 emoji
      default: '🐾'
    };

    const emoji = pokemonEmojis[pokemon.speciesId] || pokemonEmojis.default;
    placeholder.textContent = emoji;

    // 尝试加载图片
    const imageUrl = `${this._options.imageBaseUrl}/${pokemon.speciesId}.png`;
    imageEl.src = imageUrl;
    
    imageEl.onerror = () => {
      imageEl.style.display = 'none';
      placeholder.style.display = 'block';
    };
    
    imageEl.onload = () => {
      imageEl.style.display = 'block';
      placeholder.style.display = 'none';
    };
  }

  /**
   * 播放动作
   */
  playAction(actionName) {
    if (this._is3DMode && this._viewer) {
      this._viewer.playAction(actionName);
    }
  }

  /**
   * 切换到 2D 模式
   */
  switchTo2D(autoSwitched = false) {
    this._is3DMode = false;

    document.getElementById('viewer-3d-container').style.display = 'none';
    document.getElementById('viewer-2d-container').style.display = 'block';
    
    document.getElementById('toggle-2d-btn').style.display = 'none';
    document.getElementById('toggle-3d-btn').style.display = 'flex';
    
    document.getElementById('viewer-hint').style.display = 'none';

    // 禁用动作按钮
    this._container.querySelectorAll('.action-btn').forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = '0.5';
    });

    if (this._currentPokemon) {
      this._load2DImage(this._currentPokemon);
    }

    if (!autoSwitched && this._options.onDowngrade) {
      this._options.onDowngrade({ reason: 'manual' });
    }

    console.log('[PokemonDetailViewer] Switched to 2D mode');
  }

  /**
   * 切换到 3D 模式
   */
  async switchTo3D() {
    // 检查 WebGL 支持
    if (!this._checkWebGLSupport()) {
      alert('您的设备不支持 WebGL，无法使用 3D 模式');
      return;
    }

    this._is3DMode = true;

    document.getElementById('viewer-2d-container').style.display = 'none';
    document.getElementById('viewer-3d-container').style.display = 'block';
    
    document.getElementById('toggle-3d-btn').style.display = 'none';
    document.getElementById('toggle-2d-btn').style.display = 'flex';
    
    document.getElementById('viewer-hint').style.display = 'block';

    // 启用动作按钮
    this._container.querySelectorAll('.action-btn').forEach(btn => {
      btn.disabled = false;
      btn.style.opacity = '1';
    });

    // 重新初始化 3D 查看器
    if (!this._viewer || !this._viewer._isInitialized) {
      this._initViewer();
    }

    // 重新加载当前精灵
    if (this._currentPokemon) {
      await this.showPokemon(this._currentPokemon);
    }

    console.log('[PokemonDetailViewer] Switched to 3D mode');
  }

  /**
   * 检查 WebGL 支持
   */
  _checkWebGLSupport() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      return !!gl;
    } catch (error) {
      return false;
    }
  }

  /**
   * 销毁
   */
  dispose() {
    if (this._viewer) {
      this._viewer.dispose();
      this._viewer = null;
    }
    this._container = null;
    this._currentPokemon = null;
  }
}

export default PokemonDetailViewer;
