/**
 * Pokemon List A11y - 精灵列表无障碍支持
 * REQ-00503: 游戏客户端屏幕阅读器与 ARIA 无障碍支持
 * 
 * 演示如何在精灵列表中集成 ARIA 支持
 */

import { a11yAnnouncer } from './announcer.js';
import { focusManager } from './focusManager.js';
import ARIAUtils, { ARIARoles } from './ariaUtils.js';

/**
 * 创建无障碍精灵列表
 */
export class A11yPokemonList {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.pokemonList = [];
    this.selectedIndex = -1;
    
    this.init();
  }

  /**
   * 初始化精灵列表结构
   */
  init() {
    // 创建列表容器
    this.listContainer = document.createElement('div');
    ARIAUtils.setRole(this.listContainer, ARIARoles.LIST);
    ARIAUtils.setLabel(this.listContainer, '我的精灵列表');
    this.listContainer.id = 'pokemon-list';
    
    this.container.appendChild(this.listContainer);
  }

  /**
   * 添加精灵到列表（带 ARIA 支持）
   */
  addPokemon(pokemon) {
    this.pokemonList.push(pokemon);
    
    const index = this.pokemonList.length;
    const item = this.createPokemonItem(pokemon, index);
    
    this.listContainer.appendChild(item);
    
    // 更新总数量标签
    ARIAUtils.setLabel(
      this.listContainer,
      `我的精灵列表，共 ${this.pokemonList.length} 只`
    );
    
    return item;
  }

  /**
   * 创建精灵卡片（带完整 ARIA 支持）
   */
  createPokemonItem(pokemon, index) {
    const item = document.createElement('article');
    ARIAUtils.setRole(item, ARIARoles.LISTITEM);
    item.setAttribute('aria-posinset', index.toString());
    item.setAttribute('aria-setsize', this.pokemonList.length.toString());
    item.className = 'pokemon-card';
    item.id = `pokemon-${pokemon.id}`;
    
    // 精灵名称
    const name = document.createElement('h3');
    name.textContent = pokemon.speciesName;
    name.className = 'pokemon-name';
    item.appendChild(name);
    
    // 精灵图片（带 alt 文本）
    const img = document.createElement('img');
    img.src = pokemon.image || `/images/pokemon/${pokemon.speciesId}.png`;
    img.alt = `${pokemon.speciesName} 立绘`;
    img.className = 'pokemon-image';
    item.appendChild(img);
    
    // 状态信息（使用语义化标签）
    const status = document.createElement('p');
    ARIAUtils.setRole(status, 'status');
    status.className = 'pokemon-status';
    status.textContent = `CP ${pokemon.cp}`;
    item.appendChild(status);
    
    // 详细属性（使用 dl 标签）
    if (this.options.showDetails) {
      const details = this.createPokemonDetails(pokemon);
      item.appendChild(details);
    }
    
    // 操作按钮
    const actions = this.createPokemonActions(pokemon, index);
    item.appendChild(actions);
    
    // 键盘导航
    item.setAttribute('tabindex', '0');
    item.addEventListener('keydown', (e) => {
      this.handleItemKeydown(e, index);
    });
    
    // 聚焦时播报
    item.addEventListener('focus', () => {
      this.selectItem(index);
      a11yAnnouncer.announcePokemonFocus(
        pokemon.speciesName,
        pokemon.cp,
        pokemon.currentHp,
        pokemon.maxHp
      );
    });
    
    return item;
  }

  /**
   * 创建精灵详细属性（使用语义化 dl 标签）
   */
  createPokemonDetails(pokemon) {
    const details = document.createElement('dl');
    details.className = 'pokemon-details';
    
    // 生命值
    const hpTerm = document.createElement('dt');
    hpTerm.textContent = '生命值';
    const hpDef = document.createElement('dd');
    hpDef.textContent = `${pokemon.currentHp}/${pokemon.maxHp}`;
    details.appendChild(hpTerm);
    details.appendChild(hpDef);
    
    // 属性
    if (pokemon.types) {
      const typesTerm = document.createElement('dt');
      typesTerm.textContent = '属性';
      const typesDef = document.createElement('dd');
      typesDef.textContent = pokemon.types.join('、');
      details.appendChild(typesTerm);
      details.appendChild(typesDef);
    }
    
    // 技能
    if (pokemon.moves) {
      const movesTerm = document.createElement('dt');
      movesTerm.textContent = '技能';
      const movesDef = document.createElement('dd');
      movesDef.textContent = pokemon.moves.map(m => m.name).join('、');
      details.appendChild(movesTerm);
      details.appendChild(movesDef);
    }
    
    return details;
  }

  /**
   * 创建操作按钮组
   */
  createPokemonActions(pokemon, index) {
    const actions = document.createElement('div');
    ARIAUtils.setRole(actions, 'group');
    ARIAUtils.setLabel(actions, '操作');
    actions.className = 'pokemon-actions';
    
    // 查看详情按钮
    const detailBtn = ARIAUtils.createButton(
      '详情',
      () => this.showPokemonDetail(pokemon),
      { ariaLabel: `查看 ${pokemon.speciesName} 的详细信息` }
    );
    actions.appendChild(detailBtn);
    
    // 选择按钮（用于战斗）
    if (this.options.showSelectButton) {
      const selectBtn = ARIAUtils.createButton(
        '选择',
        () => this.selectPokemon(pokemon),
        { ariaLabel: `选择 ${pokemon.speciesName} 参加战斗` }
      );
      actions.appendChild(selectBtn);
    }
    
    // 交换按钮
    if (this.options.showTradeButton) {
      const tradeBtn = ARIAUtils.createButton(
        '交换',
        () => this.initiateTrade(pokemon),
        { ariaLabel: `发起 ${pokemon.speciesName} 的交换请求` }
      );
      actions.appendChild(tradeBtn);
    }
    
    return actions;
  }

  /**
   * 处理键盘导航
   */
  handleItemKeydown(e, index) {
    const lastIndex = this.pokemonList.length - 1;
    
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (index < lastIndex) {
          this.focusItem(index + 1);
        }
        break;
      
      case 'ArrowUp':
        e.preventDefault();
        if (index > 0) {
          this.focusItem(index - 1);
        }
        break;
      
      case 'Home':
        e.preventDefault();
        this.focusItem(0);
        break;
      
      case 'End':
        e.preventDefault();
        this.focusItem(lastIndex);
        break;
      
      case 'Enter':
        e.preventDefault();
        this.showPokemonDetail(this.pokemonList[index]);
        break;
      
      case 'Delete':
        e.preventDefault();
        // 释放精灵（如果支持）
        if (this.options.allowRelease) {
          this.confirmRelease(this.pokemonList[index]);
        }
        break;
    }
  }

  /**
   * 聚焦到指定项
   */
  focusItem(index) {
    const item = this.listContainer.querySelector(`[aria-posinset="${index}"]`);
    if (item) {
      focusManager.focusElement(item);
    }
  }

  /**
   * 选择精灵项（更新 aria-selected）
   */
  selectItem(index) {
    // 清除之前选中状态
    const items = this.listContainer.querySelectorAll('[aria-posinset]');
    items.forEach(item => ARIAUtils.setSelected(item, false));
    
    // 设置当前选中
    const currentItem = this.listContainer.querySelector(`[aria-posinset="${index}"]`);
    if (currentItem) {
      ARIAUtils.setSelected(currentItem, true);
      this.selectedIndex = index;
    }
  }

  /**
   * 显示精灵详情对话框
   */
  showPokemonDetail(pokemon) {
    const dialog = document.createElement('div');
    ARIAUtils.setRole(dialog, ARIARoles.DIALOG);
    ARIAUtils.setLabel(dialog, `${pokemon.speciesName} 详细信息`);
    dialog.setAttribute('aria-modal', 'true');
    dialog.className = 'pokemon-detail-dialog';
    
    // 标题
    const title = document.createElement('h2');
    title.textContent = pokemon.speciesName;
    dialog.appendChild(title);
    
    // 图片
    const img = document.createElement('img');
    img.src = pokemon.image || `/images/pokemon/${pokemon.speciesId}.png`;
    img.alt = `${pokemon.speciesName} 立绘`;
    img.className = 'pokemon-detail-image';
    dialog.appendChild(img);
    
    // 详细信息
    const details = this.createPokemonDetails(pokemon);
    dialog.appendChild(details);
    
    // 关闭按钮
    const closeBtn = ARIAUtils.createButton(
      '关闭',
      () => this.closeDialog(dialog),
      { ariaLabel: '关闭详情对话框' }
    );
    closeBtn.className = 'dialog-close-btn';
    dialog.appendChild(closeBtn);
    
    document.body.appendChild(dialog);
    
    // 激活焦点陷阱
    focusManager.saveFocus();
    focusManager.trapFocus(dialog, {
      onEscape: () => this.closeDialog(dialog),
      initialFocus: closeBtn
    });
  }

  /**
   * 选择精灵参加战斗
   */
  selectPokemon(pokemon) {
    a11yAnnouncer.announce(`已选择 ${pokemon.speciesName} 参加战斗`);
    
    if (this.options.onSelect) {
      this.options.onSelect(pokemon);
    }
  }

  /**
   * 发起交换请求
   */
  initiateTrade(pokemon) {
    a11yAnnouncer.announce(`发起 ${pokemon.speciesName} 的交换请求`);
    
    if (this.options.onTrade) {
      this.options.onTrade(pokemon);
    }
  }

  /**
   * 确认释放精灵
   */
  confirmRelease(pokemon) {
    const dialog = document.createElement('div');
    ARIAUtils.setRole(dialog, ARIARoles.ALERTDIALOG);
    ARIAUtils.setLabel(dialog, '确认释放精灵');
    dialog.setAttribute('aria-modal', 'true');
    dialog.className = 'confirm-release-dialog';
    
    const title = document.createElement('h2');
    title.textContent = '确认释放';
    dialog.appendChild(title);
    
    const message = document.createElement('p');
    message.textContent = `确定要释放 ${pokemon.speciesName} 吗？此操作不可撤销。`;
    dialog.appendChild(message);
    
    // 确认按钮
    const confirmBtn = ARIAUtils.createButton(
      '确认释放',
      () => {
        this.releasePokemon(pokemon);
        this.closeDialog(dialog);
      },
      { ariaLabel: '确认释放精灵' }
    );
    dialog.appendChild(confirmBtn);
    
    // 取消按钮
    const cancelBtn = ARIAUtils.createButton(
      '取消',
      () => this.closeDialog(dialog),
      { ariaLabel: '取消释放' }
    );
    dialog.appendChild(cancelBtn);
    
    document.body.appendChild(dialog);
    
    focusManager.saveFocus();
    focusManager.trapFocus(dialog, {
      onEscape: () => this.closeDialog(dialog),
      initialFocus: cancelBtn
    });
  }

  /**
   * 释放精灵
   */
  releasePokemon(pokemon) {
    a11yAnnouncer.alert(`已释放 ${pokemon.speciesName}`);
    
    if (this.options.onRelease) {
      this.options.onRelease(pokemon);
    }
  }

  /**
   * 关闭对话框
   */
  closeDialog(dialog) {
    focusManager.releaseTrap();
    dialog.remove();
  }

  /**
   * 清空列表
   */
  clear() {
    this.pokemonList = [];
    this.selectedIndex = -1;
    this.listContainer.innerHTML = '';
    ARIAUtils.setLabel(this.listContainer, '我的精灵列表，共 0 只');
  }

  /**
   * 获取选中精灵
   */
  getSelectedPokemon() {
    if (this.selectedIndex >= 0) {
      return this.pokemonList[this.selectedIndex];
    }
    return null;
  }
}

/**
 * 快速升级现有精灵列表（无需重写组件）
 */
export function upgradePokemonListA11y(listElement) {
  // 设置列表角色
  ARIAUtils.setRole(listElement, ARIARoles.LIST);
  
  // 为每个精灵卡片添加 ARIA
  const cards = listElement.querySelectorAll('.pokemon-card');
  cards.forEach((card, index) => {
    // 列表项角色
    ARIAUtils.setRole(card, ARIARoles.LISTITEM);
    card.setAttribute('aria-posinset', (index + 1).toString());
    card.setAttribute('aria-setsize', cards.length.toString());
    
    // 键盘导航
    card.setAttribute('tabindex', '0');
    
    // 提取精灵信息
    const nameEl = card.querySelector('.pokemon-name');
    const speciesName = nameEl ? nameEl.textContent : '未知精灵';
    
    // 完整标签
    const cpEl = card.querySelector('.pokemon-cp');
    const cp = cpEl ? cpEl.textContent : '';
    ARIAUtils.setLabel(card, `${speciesName}，${cp}`);
    
    // 图片 alt 文本
    const img = card.querySelector('img');
    if (img && !img.alt) {
      img.alt = `${speciesName} 立绘`;
    }
  });
  
  // 设置总数量
  ARIAUtils.setLabel(listElement, `精灵列表，共 ${cards.length} 只`);
  
  console.log('[A11y] Pokemon list upgraded with ARIA support');
}

export default A11yPokemonList;