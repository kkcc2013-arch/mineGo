'use strict';

/**
 * 称号管理器 - 管理玩家称号的显示与切换
 * REQ-00106: 玩家称号系统与个性化展示
 */

export class TitleManager {
  constructor(api, gameStore) {
    this.api = api;
    this.gameStore = gameStore;
    this.titles = [];
    this.activeTitle = null;
    this.statBonuses = {};
    this.loading = false;
    this.error = null;
    this.initialized = false;
  }

  /**
   * 初始化称号系统
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      this.loading = true;
      await this.loadTitles();
      this.initialized = true;
    } catch (error) {
      console.error('[TitleManager] Initialize failed:', error);
      this.error = error.message;
    } finally {
      this.loading = false;
    }
  }

  /**
   * 加载用户称号
   */
  async loadTitles() {
    try {
      const response = await this.api.get('/users/me/titles');
      
      if (response.success && response.data) {
        this.titles = response.data.titles || [];
        this.activeTitle = this.titles.find(t => t.isActive) || null;
        
        if (this.activeTitle) {
          this.statBonuses = this.activeTitle.statBonuses || {};
        }
        
        // 更新全局状态
        if (this.gameStore) {
          this.gameStore.setState({
            titles: this.titles,
            activeTitle: this.activeTitle,
            titleBonuses: this.statBonuses
          });
        }
        
        console.log(`[TitleManager] Loaded ${this.titles.length} titles`);
      }
    } catch (error) {
      console.error('[TitleManager] Failed to load titles:', error);
      throw error;
    }
  }

  /**
   * 激活称号
   */
  async activateTitle(titleId) {
    const title = this.titles.find(t => t.titleId === titleId);
    if (!title) {
      throw new Error('Title not found');
    }

    try {
      const response = await this.api.put(`/users/me/titles/${titleId}/activate`);
      
      if (response.success) {
        // 更新本地状态
        this.titles.forEach(t => t.isActive = false);
        title.isActive = true;
        this.activeTitle = title;
        this.statBonuses = title.statBonuses || {};
        
        // 更新全局状态
        if (this.gameStore) {
          this.gameStore.setState({
            activeTitle: this.activeTitle,
            titleBonuses: this.statBonuses
          });
        }
        
        console.log(`[TitleManager] Activated title: ${titleId}`);
        return response.data;
      }
    } catch (error) {
      console.error('[TitleManager] Failed to activate title:', error);
      throw error;
    }
  }

  /**
   * 设置收藏状态
   */
  async setFavorite(titleId, isFavorite = true) {
    const title = this.titles.find(t => t.titleId === titleId);
    if (!title) {
      throw new Error('Title not found');
    }

    try {
      await this.api.put(`/users/me/titles/${titleId}/favorite`, { isFavorite });
      title.isFavorite = isFavorite;
      
      if (this.gameStore) {
        this.gameStore.setState({ titles: this.titles });
      }
      
      return true;
    } catch (error) {
      console.error('[TitleManager] Failed to set favorite:', error);
      throw error;
    }
  }

  /**
   * 获取称号显示名称
   */
  getTitleDisplayName(lang = 'zh') {
    if (!this.activeTitle) return '';
    return this.activeTitle.name[lang] || this.activeTitle.name['en'] || '';
  }

  /**
   * 获取称号图标
   */
  getTitleIcon() {
    if (!this.activeTitle) return null;
    return this.activeTitle.iconUrl;
  }

  /**
   * 获取称号稀有度
   */
  getTitleRarity() {
    if (!this.activeTitle) return null;
    return this.activeTitle.rarity;
  }

  /**
   * 获取称号特效CSS类
   */
  getTitleEffectClass() {
    if (!this.activeTitle || !this.activeTitle.specialEffects) return '';
    
    const rarity = this.activeTitle.rarity;
    const effects = this.activeTitle.specialEffects;
    
    const classes = [`title-${rarity}`];
    
    if (effects.glowColor) {
      classes.push('title-glow');
    }
    if (effects.particles) {
      classes.push('title-particles');
    }
    if (effects.aura) {
      classes.push('title-aura');
    }
    if (effects.sparkle) {
      classes.push('title-sparkle');
    }
    
    return classes.join(' ');
  }

  /**
   * 获取属性加成文本
   */
  getStatBonusText(lang = 'zh') {
    const bonuses = [];
    const texts = {
      zh: {
        catch_rate: '捕捉率',
        exp_bonus: '经验加成',
        battle_power: '战斗力量',
        shiny_rate: '闪光概率'
      },
      en: {
        catch_rate: 'Catch Rate',
        exp_bonus: 'EXP Bonus',
        battle_power: 'Battle Power',
        shiny_rate: 'Shiny Rate'
      }
    };

    for (const [stat, value] of Object.entries(this.statBonuses)) {
      const percentage = Math.round(value * 100);
      const statName = texts[lang]?.[stat] || stat;
      bonuses.push(`${statName} +${percentage}%`);
    }

    return bonuses;
  }

  /**
   * 获取称号数量统计
   */
  getTitleStats() {
    return {
      total: this.titles.length,
      active: this.activeTitle ? 1 : 0,
      favorites: this.titles.filter(t => t.isFavorite).length,
      byRarity: {
        common: this.titles.filter(t => t.rarity === 'common').length,
        rare: this.titles.filter(t => t.rarity === 'rare').length,
        epic: this.titles.filter(t => t.rarity === 'epic').length,
        legendary: this.titles.filter(t => t.rarity === 'legendary').length,
        mythic: this.titles.filter(t => t.rarity === 'mythic').length
      }
    };
  }

  /**
   * 按类别分组称号
   */
  groupByCategory() {
    const groups = {};
    this.titles.forEach(title => {
      if (!groups[title.category]) {
        groups[title.category] = [];
      }
      groups[title.category].push(title);
    });
    return groups;
  }

  /**
   * 按稀有度分组称号
   */
  groupByRarity() {
    const groups = {};
    this.titles.forEach(title => {
      if (!groups[title.rarity]) {
        groups[title.rarity] = [];
      }
      groups[title.rarity].push(title);
    });
    return groups;
  }

  /**
   * 获取类别名称
   */
  getCategoryName(category, lang = 'zh') {
    const names = {
      zh: {
        achievement: '成就称号',
        event: '活动称号',
        rank: '排名称号',
        special: '特殊称号',
        milestone: '里程碑称号'
      },
      en: {
        achievement: 'Achievement Titles',
        event: 'Event Titles',
        rank: 'Rank Titles',
        special: 'Special Titles',
        milestone: 'Milestone Titles'
      }
    };
    return names[lang]?.[category] || category;
  }

  /**
   * 获取稀有度名称
   */
  getRarityName(rarity, lang = 'zh') {
    const names = {
      zh: {
        common: '普通',
        rare: '稀有',
        epic: '史诗',
        legendary: '传说',
        mythic: '神话'
      },
      en: {
        common: 'Common',
        rare: 'Rare',
        epic: 'Epic',
        legendary: 'Legendary',
        mythic: 'Mythic'
      }
    };
    return names[lang]?.[rarity] || rarity;
  }

  /**
   * 渲染称号徽章
   */
  renderTitleBadge(container) {
    if (!this.activeTitle) return;

    const badge = document.createElement('div');
    badge.className = `title-badge ${this.getTitleEffectClass()}`;
    badge.setAttribute('data-title-id', this.activeTitle.titleId);
    
    let badgeContent = '';
    
    if (this.activeTitle.iconUrl) {
      badgeContent += `<img src="${this.activeTitle.iconUrl}" alt="" class="title-icon" loading="lazy" />`;
    }
    
    badgeContent += `<span class="title-name">${this.getTitleDisplayName()}</span>`;
    
    if (Object.keys(this.statBonuses).length > 0) {
      badgeContent += `<span class="title-bonus-indicator" title="${this.getStatBonusText().join(', ')}">+</span>`;
    }
    
    badge.innerHTML = badgeContent;
    
    // 设置发光颜色
    if (this.activeTitle.specialEffects?.glowColor) {
      badge.style.setProperty('--title-glow-color', this.activeTitle.specialEffects.glowColor);
    }
    
    container.appendChild(badge);
  }

  /**
   * 渲染称号选择器
   */
  renderTitleSelector(container) {
    const categories = this.groupByCategory();
    const lang = this.gameStore?.getState()?.language || 'zh';
    
    const selector = document.createElement('div');
    selector.className = 'title-selector';
    
    // 标题栏
    const header = document.createElement('div');
    header.className = 'title-selector-header';
    header.innerHTML = `
      <h2 class="title-selector-title">${lang === 'zh' ? '称号管理' : 'Title Manager'}</h2>
      <div class="title-stats">
        <span class="stat-total">${lang === 'zh' ? '已解锁' : 'Unlocked'}: ${this.titles.length}</span>
      </div>
    `;
    selector.appendChild(header);
    
    // 称号列表
    const list = document.createElement('div');
    list.className = 'title-list';
    
    for (const [category, titles] of Object.entries(categories)) {
      const section = document.createElement('div');
      section.className = 'title-category-section';
      section.innerHTML = `
        <h3 class="category-title">${this.getCategoryName(category, lang)}</h3>
        <div class="title-category-list"></div>
      `;
      
      const categoryList = section.querySelector('.title-category-list');
      titles.forEach(title => {
        const item = this.createTitleItem(title, lang);
        categoryList.appendChild(item);
      });
      
      list.appendChild(section);
    }
    
    selector.appendChild(list);
    container.appendChild(selector);
    
    return selector;
  }

  /**
   * 创建称号项
   */
  createTitleItem(title, lang = 'zh') {
    const item = document.createElement('div');
    item.className = `title-item title-${title.rarity} ${title.isActive ? 'active' : ''} ${title.isFavorite ? 'favorite' : ''}`;
    item.setAttribute('data-title-id', title.titleId);
    
    // 图标
    const iconHtml = title.iconUrl 
      ? `<img src="${title.iconUrl}" alt="" loading="lazy" />`
      : '<div class="placeholder-icon"></div>';
    
    // 稀有度徽章
    const rarityBadge = `<span class="rarity-badge rarity-${title.rarity}">${this.getRarityName(title.rarity, lang)}</span>`;
    
    // 属性加成
    const bonusHtml = Object.keys(title.statBonuses || {}).length > 0
      ? `<div class="title-bonuses">${this.getStatBonusText(lang).join(' | ')}</div>`
      : '';
    
    // 过期时间
    const expiryHtml = title.expiresAt
      ? `<div class="title-expiry">${lang === 'zh' ? '有效期至' : 'Expires'}: ${new Date(title.expiresAt).toLocaleDateString()}</div>`
      : '';
    
    item.innerHTML = `
      <div class="title-icon-wrapper">${iconHtml}</div>
      <div class="title-info">
        <div class="title-name">${title.name[lang] || title.name['en']}</div>
        <div class="title-desc">${title.description[lang] || title.description['en']}</div>
        ${bonusHtml}
        ${expiryHtml}
        <div class="title-meta">
          ${rarityBadge}
          <span class="unlock-time">${lang === 'zh' ? '解锁于' : 'Unlocked'}: ${new Date(title.unlockedAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="title-actions">
        <button class="btn-activate" ${title.isActive ? 'disabled' : ''}>
          ${title.isActive ? (lang === 'zh' ? '使用中' : 'Active') : (lang === 'zh' ? '使用' : 'Use')}
        </button>
        <button class="btn-favorite ${title.isFavorite ? 'favorited' : ''}" title="${lang === 'zh' ? '收藏' : 'Favorite'}">
          ${title.isFavorite ? '★' : '☆'}
        </button>
      </div>
    `;
    
    // 设置发光颜色
    if (title.specialEffects?.glowColor) {
      item.style.setProperty('--title-glow-color', title.specialEffects.glowColor);
    }
    
    // 绑定事件
    const activateBtn = item.querySelector('.btn-activate');
    if (!title.isActive) {
      activateBtn.addEventListener('click', async () => {
        try {
          activateBtn.disabled = true;
          activateBtn.textContent = lang === 'zh' ? '激活中...' : 'Activating...';
          await this.activateTitle(title.titleId);
          this.refreshTitleSelector();
        } catch (error) {
          activateBtn.disabled = false;
          activateBtn.textContent = lang === 'zh' ? '使用' : 'Use';
          console.error('Activate failed:', error);
        }
      });
    }
    
    const favoriteBtn = item.querySelector('.btn-favorite');
    favoriteBtn.addEventListener('click', async () => {
      try {
        await this.setFavorite(title.titleId, !title.isFavorite);
        favoriteBtn.classList.toggle('favorited');
        favoriteBtn.textContent = title.isFavorite ? '★' : '☆';
      } catch (error) {
        console.error('Favorite failed:', error);
      }
    });
    
    return item;
  }

  /**
   * 刷新称号选择器
   */
  refreshTitleSelector() {
    const selector = document.querySelector('.title-selector');
    if (selector) {
      const parent = selector.parentElement;
      selector.remove();
      this.renderTitleSelector(parent);
    }
  }

  /**
   * 应用称号属性加成
   */
  applyStatBonuses(baseStats) {
    if (!this.statBonuses || Object.keys(this.statBonuses).length === 0) {
      return baseStats;
    }
    
    const modifiedStats = { ...baseStats };
    
    for (const [stat, bonus] of Object.entries(this.statBonuses)) {
      if (modifiedStats[stat] !== undefined) {
        modifiedStats[stat] = modifiedStats[stat] * (1 + bonus);
      }
    }
    
    return modifiedStats;
  }

  /**
   * 获取捕捉率加成
   */
  getCatchRateBonus() {
    return this.statBonuses.catch_rate || 0;
  }

  /**
   * 获取经验加成
   */
  getExpBonus() {
    return this.statBonuses.exp_bonus || 0;
  }

  /**
   * 获取战斗力加成
   */
  getBattlePowerBonus() {
    return this.statBonuses.battle_power || 0;
  }

  /**
   * 获取闪光概率加成
   */
  getShinyRateBonus() {
    return this.statBonuses.shiny_rate || 0;
  }
}

export default TitleManager;
