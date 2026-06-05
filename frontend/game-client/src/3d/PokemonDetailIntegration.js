/**
 * 精灵详情页集成示例
 * 展示如何在现有页面中集成 PokemonDetailViewer
 */

// ============================================
// 方式一：直接嵌入到现有精灵详情页
// ============================================

/**
 * 在精灵详情页添加 3D 查看器
 */
async function showPokemonDetailWith3D(pokemon) {
  // 创建详情页容器
  const detailPage = document.createElement('div');
  detailPage.className = 'pokemon-detail-page';
  detailPage.innerHTML = `
    <div class="detail-header">
      <button class="back-btn" onclick="closeDetail()">←</button>
      <h2>${pokemon.name}</h2>
      <div class="pokemon-meta">
        <span class="cp">CP ${pokemon.cp}</span>
        <span class="rarity">${'⭐'.repeat(pokemon.rarity || 1)}</span>
      </div>
    </div>
    
    <!-- 3D 查看器容器 -->
    <div id="pokemon-detail-viewer"></div>
    
    <div class="detail-info">
      <div class="info-row">
        <span class="label">类型</span>
        <span class="value">${pokemon.types.join(', ')}</span>
      </div>
      <div class="info-row">
        <span class="label">身高</span>
        <span class="value">${pokemon.height} m</span>
      </div>
      <div class="info-row">
        <span class="label">体重</span>
        <span class="value">${pokemon.weight} kg</span>
      </div>
    </div>
    
    <div class="stats-section">
      <h3>能力值</h3>
      <div class="stat-bars">
        <div class="stat-bar">
          <label>攻击</label>
          <div class="bar">
            <div class="fill" style="width: ${pokemon.stats.attack / 3}%"></div>
          </div>
          <span>${pokemon.stats.attack}</span>
        </div>
        <div class="stat-bar">
          <label>防御</label>
          <div class="bar">
            <div class="fill" style="width: ${pokemon.stats.defense / 3}%"></div>
          </div>
          <span>${pokemon.stats.defense}</span>
        </div>
        <div class="stat-bar">
          <label>生命</label>
          <div class="bar">
            <div class="fill" style="width: ${pokemon.stats.hp / 3}%"></div>
          </div>
          <span>${pokemon.stats.hp}</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(detailPage);

  // 初始化 3D 查看器
  const { PokemonDetailViewer } = await import('./src/3d/PokemonDetailViewer.js');
  
  const viewer = new PokemonDetailViewer({
    containerId: 'pokemon-detail-viewer',
    autoDowngrade: true,
    onDowngrade: (e) => {
      console.log('降级到 2D 模式:', e.reason);
    }
  });

  viewer.init();
  
  // 显示精灵
  await viewer.showPokemon({
    speciesId: pokemon.speciesId,
    name: pokemon.name,
    rarity: pokemon.rarity,
    variant: pokemon.isShiny ? 'shiny' : 'normal'
  });

  // 存储查看器引用以便清理
  detailPage._viewer = viewer;
}

/**
 * 关闭详情页
 */
function closeDetail() {
  const detailPage = document.querySelector('.pokemon-detail-page');
  if (detailPage) {
    // 清理 3D 查看器资源
    if (detailPage._viewer) {
      detailPage._viewer.dispose();
    }
    detailPage.remove();
  }
}


// ============================================
// 方式二：作为独立弹窗组件
// ============================================

class PokemonDetailModal {
  constructor() {
    this._viewer = null;
    this._modal = null;
  }

  /**
   * 显示精灵详情弹窗
   */
  async show(pokemon) {
    // 创建弹窗
    this._createModal(pokemon);
    
    // 初始化 3D 查看器
    await this._initViewer();
    
    // 显示精灵
    await this._viewer.showPokemon({
      speciesId: pokemon.speciesId,
      name: pokemon.name,
      rarity: pokemon.rarity,
      variant: pokemon.isShiny ? 'shiny' : 'normal'
    });
  }

  /**
   * 创建弹窗 HTML
   */
  _createModal(pokemon) {
    this._modal = document.createElement('div');
    this._modal.className = 'pokemon-detail-modal';
    this._modal.innerHTML = `
      <div class="modal-backdrop" onclick="pokemonModal.close()"></div>
      <div class="modal-content">
        <div class="modal-header">
          <h2>${pokemon.name}</h2>
          <button class="close-btn" onclick="pokemonModal.close()">✕</button>
        </div>
        <div id="pokemon-detail-viewer"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="pokemonModal.close()">关闭</button>
        </div>
      </div>
    `;

    // 添加样式
    this._addStyles();
    
    document.body.appendChild(this._modal);
    
    // 防止滚动
    document.body.style.overflow = 'hidden';
  }

  /**
   * 添加样式
   */
  _addStyles() {
    if (document.getElementById('pokemon-modal-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'pokemon-modal-styles';
    styles.textContent = `
      .pokemon-detail-modal {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .modal-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
      }

      .modal-content {
        position: relative;
        width: 90%;
        max-width: 500px;
        background: #13161e;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        background: #0d0f14;
        border-bottom: 1px solid #252938;
      }

      .modal-header h2 {
        font-size: 18px;
        font-weight: 700;
        margin: 0;
      }

      .close-btn {
        background: none;
        border: none;
        color: #6b7280;
        font-size: 24px;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
      }

      .modal-footer {
        padding: 16px;
        background: #0d0f14;
        border-top: 1px solid #252938;
      }

      .btn {
        padding: 12px 24px;
        border-radius: 10px;
        border: none;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
      }

      .btn-secondary {
        background: #252938;
        color: #e8eaf0;
        width: 100%;
      }
    `;
    document.head.appendChild(styles);
  }

  /**
   * 初始化 3D 查看器
   */
  async _initViewer() {
    const { PokemonDetailViewer } = await import('./src/3d/PokemonDetailViewer.js');
    
    this._viewer = new PokemonDetailViewer({
      containerId: 'pokemon-detail-viewer',
      autoDowngrade: true
    });

    this._viewer.init();
  }

  /**
   * 关闭弹窗
   */
  close() {
    if (this._viewer) {
      this._viewer.dispose();
      this._viewer = null;
    }

    if (this._modal) {
      this._modal.remove();
      this._modal = null;
    }

    document.body.style.overflow = '';
  }
}

// 创建全局实例
window.pokemonModal = new PokemonDetailModal();


// ============================================
// 方式三：集成到精灵列表项点击事件
// ============================================

/**
 * 修改精灵列表点击事件，添加 3D 预览
 */
async function enhancePokemonList() {
  const { PokemonDetailViewer } = await import('./src/3d/PokemonDetailViewer.js');
  
  // 查找所有精灵卡片
  const pokemonCards = document.querySelectorAll('.entity-card');
  
  pokemonCards.forEach(card => {
    card.addEventListener('click', async () => {
      const pokemonId = card.dataset.pokemonId;
      const speciesId = parseInt(card.dataset.speciesId);
      const name = card.querySelector('.entity-name').textContent;
      const rarity = parseInt(card.dataset.rarity) || 1;
      
      // 创建详情弹窗
      showPokemonDetailWith3D({
        pokemonId,
        speciesId,
        name,
        rarity,
        cp: card.querySelector('.entity-right')?.textContent || '???',
        types: ['未知'],
        height: '0.0',
        weight: '0.0',
        stats: { attack: 0, defense: 0, hp: 0 }
      });
    });
  });
}


// ============================================
// 导出
// ============================================

export {
  showPokemonDetailWith3D,
  closeDetail,
  PokemonDetailModal
};

console.log('[PokemonDetailIntegration] 模块加载完成');
