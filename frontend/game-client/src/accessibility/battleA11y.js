/**
 * A11y Battle Scene - 无障碍增强版战斗场景
 * REQ-00503: 游戏客户端屏幕阅读器与 ARIA 无障碍支持
 * 
 * 演示如何在战斗场景中集成 ARIA 支持
 */

import { a11yAnnouncer } from './announcer.js';
import { focusManager } from './focusManager.js';
import ARIAUtils, { ARIARoles, ARIAAttributes } from './ariaUtils.js';

/**
 * 创建无障碍战斗场景
 */
export class A11yBattleScene {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.battleState = null;
    
    this.init();
  }

  /**
   * 初始化战斗场景结构
   */
  init() {
    // 创建主容器
    this.battleContainer = document.createElement('div');
    ARIAUtils.setRole(this.battleContainer, ARIARoles.REGION);
    ARIAUtils.setLabel(this.battleContainer, '战斗场景');
    this.battleContainer.id = 'battle-scene';
    
    // 创建标题区域
    this.createHeader();
    
    // 创建实时播报区域
    this.createLiveRegions();
    
    // 创建双方精灵状态区域
    this.createPokemonStatusAreas();
    
    // 创建技能按钮区域
    this.createMoveButtons();
    
    // 创建战斗日志区域
    this.createBattleLog();
    
    this.container.appendChild(this.battleContainer);
  }

  /**
   * 创建标题区域
   */
  createHeader() {
    const header = document.createElement('div');
    ARIAUtils.setRole(header, ARIARoles.REGION);
    ARIAUtils.setLabel(header, '战斗信息');
    
    const title = document.createElement('h2');
    title.textContent = '道馆战斗';
    header.appendChild(title);
    
    this.battleContainer.appendChild(header);
  }

  /**
   * 创建实时播报区域
   */
  createLiveRegions() {
    // 紧急状态播报区域
    this.statusRegion = document.createElement('div');
    ARIAUtils.setRole(this.statusRegion, ARIARoles.ALERT);
    this.statusRegion.setAttribute('aria-live', 'assertive');
    this.statusRegion.setAttribute('aria-atomic', 'true');
    this.statusRegion.className = 'sr-only';
    this.statusRegion.id = 'battle-status-alert';
    this.battleContainer.appendChild(this.statusRegion);
    
    // 常规状态播报区域
    this.logRegion = document.createElement('div');
    ARIAUtils.setRole(this.logRegion, ARIARoles.LOG);
    this.logRegion.setAttribute('aria-live', 'polite');
    this.logRegion.setAttribute('aria-atomic', 'false');
    this.logRegion.setAttribute('aria-relevant', 'additions');
    this.logRegion.className = 'sr-only';
    this.logRegion.id = 'battle-log-live';
    this.battleContainer.appendChild(this.logRegion);
  }

  /**
   * 创建精灵状态区域（带无障碍支持）
   */
  createPokemonStatusAreas() {
    // 敌方精灵状态
    const enemySection = document.createElement('section');
    ARIAUtils.setRole(enemySection, ARIARoles.REGION);
    ARIAUtils.setLabel(enemySection, '敌方精灵');
    
    const enemyName = document.createElement('h3');
    enemyName.id = 'enemy-pokemon-name';
    enemyName.textContent = '敌方精灵';
    enemySection.appendChild(enemyName);
    
    // 敌方血条
    this.enemyHpBar = this.createHealthBar('enemy-hp', '敌方生命值');
    enemySection.appendChild(this.enemyHpBar.container);
    
    this.battleContainer.appendChild(enemySection);
    
    // 我方精灵状态
    const allySection = document.createElement('section');
    ARIAUtils.setRole(allySection, ARIARoles.REGION);
    ARIAUtils.setLabel(allySection, '我方精灵');
    
    const allyName = document.createElement('h3');
    allyName.id = 'ally-pokemon-name';
    allyName.textContent = '我方精灵';
    allySection.appendChild(allyName);
    
    // 我方血条
    this.allyHpBar = this.createHealthBar('ally-hp', '我方生命值');
    allySection.appendChild(this.allyHpBar.container);
    
    this.battleContainer.appendChild(allySection);
  }

  /**
   * 创建生命值条（带 ARIA 支持）
   */
  createHealthBar(id, label) {
    const container = document.createElement('div');
    ARIAUtils.setRole(container, ARIARoles.METER);
    ARIAUtils.setLabel(container, label);
    container.id = id;
    
    // 初始值
    ARIAUtils.setValue(container, 100, 0, 100);
    
    // 可视化血条
    const bar = document.createElement('div');
    bar.className = 'hp-bar';
    bar.innerHTML = '<div class="hp-fill"></div>';
    container.appendChild(bar);
    
    // 数值显示
    const valueText = document.createElement('span');
    valueText.className = 'hp-text';
    valueText.id = `${id}-text`;
    valueText.textContent = '100/100';
    container.appendChild(valueText);
    
    return {
      container,
      bar: bar.querySelector('.hp-fill'),
      text: valueText
    };
  }

  /**
   * 更新生命值（带播报）
   */
  updateHealth(target, current, max, options = {}) {
    const hpBar = target === 'enemy' ? this.enemyHpBar : this.allyHpBar;
    const percentage = Math.round((current / max) * 100);
    
    // 更新 ARIA 值
    ARIAUtils.setValue(hpBar.container, current, 0, max);
    
    // 更新可视化
    hpBar.bar.style.width = `${percentage}%`;
    hpBar.text.textContent = `${current}/${max}`;
    
    // 播报状态
    if (options.announce) {
      const targetName = target === 'enemy' ? '敌方' : '我方';
      a11yAnnouncer.announceBattleState('hp_update', {
        currentHp: current,
        maxHp: max
      });
    }
    
    // 低血量警告
    if (percentage <= 20 && options.warnLow) {
      a11yAnnouncer.alert(`${targetName}生命值不足 20%！`);
    }
  }

  /**
   * 创建技能按钮（带无障碍支持）
   */
  createMoveButtons() {
    const movesSection = document.createElement('section');
    ARIAUtils.setRole(movesSection, ARIARoles.REGION);
    ARIAUtils.setLabel(movesSection, '技能选择');
    
    const heading = document.createElement('h3');
    heading.textContent = '选择技能';
    movesSection.appendChild(heading);
    
    // 按钮容器
    const buttonGroup = document.createElement('div');
    ARIAUtils.setRole(buttonGroup, 'group');
    ARIAUtils.setLabel(buttonGroup, '可用技能');
    
    this.moveButtons = [];
    const moves = ['十万伏特', '电光一闪', '撞击', '铁尾'];
    
    moves.forEach((move, index) => {
      const button = document.createElement('button');
      ARIAUtils.setRole(button, ARIARoles.BUTTON);
      button.className = 'move-button';
      button.setAttribute('data-move-index', index);
      
      // 完整标签（包含技能信息）
      const pp = 20; // 示例 PP 值
      const power = 90; // 示例威力
      ARIAUtils.setLabel(button, `${move}，威力 ${power}，剩余 ${pp} 次`);
      
      button.textContent = move;
      
      // 键盘交互
      button.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.selectMove(index);
        }
      });
      
      button.addEventListener('click', () => {
        this.selectMove(index);
      });
      
      buttonGroup.appendChild(button);
      this.moveButtons.push(button);
    });
    
    movesSection.appendChild(buttonGroup);
    this.battleContainer.appendChild(movesSection);
  }

  /**
   * 选择技能
   */
  selectMove(index) {
    // 更新选中状态
    this.moveButtons.forEach((btn, i) => {
      ARIAUtils.setSelected(btn, i === index);
    });
    
    // 播报选择
    const moveName = this.moveButtons[index].textContent;
    a11yAnnouncer.announce(`已选择：${moveName}`);
    
    // 执行技能（调用回调）
    if (this.options.onMoveSelect) {
      this.options.onMoveSelect(index);
    }
  }

  /**
   * 创建战斗日志（带无障碍支持）
   */
  createBattleLog() {
    const logSection = document.createElement('section');
    ARIAUtils.setRole(logSection, ARIARoles.REGION);
    ARIAUtils.setLabel(logSection, '战斗日志');
    
    const heading = document.createElement('h3');
    heading.textContent = '战斗日志';
    logSection.appendChild(heading);
    
    // 日志列表
    this.logList = document.createElement('div');
    ARIAUtils.setRole(this.logList, ARIARoles.LOG);
    this.logList.setAttribute('aria-live', 'polite');
    this.logList.setAttribute('aria-relevant', 'additions');
    this.logList.id = 'battle-log';
    this.logList.className = 'battle-log';
    
    logSection.appendChild(this.logList);
    this.battleContainer.appendChild(logSection);
  }

  /**
   * 添加战斗日志（带播报）
   */
  addBattleLog(message, priority = 'polite') {
    const entry = document.createElement('div');
    ARIAUtils.setRole(entry, ARIARoles.LISTITEM);
    entry.textContent = message;
    entry.className = 'log-entry';
    
    this.logList.appendChild(entry);
    
    // 自动滚动
    entry.scrollIntoView({ behavior: 'smooth' });
    
    // 播报
    if (priority === 'assertive') {
      a11yAnnouncer.alert(message);
    } else {
      a11yAnnouncer.announce(message);
    }
  }

  /**
   * 设置战斗结果
   */
  setBattleResult(won, rewards = []) {
    const message = won ? '战斗胜利！' : '战斗失败';
    
    this.addBattleLog(message, 'assertive');
    
    if (won && rewards.length > 0) {
      const rewardMessage = `获得：${rewards.map(r => `${r.name} x${r.quantity}`).join('、')}`;
      this.addBattleLog(rewardMessage);
    }
    
    // 创建结果对话框
    this.showResultDialog(won, rewards);
  }

  /**
   * 显示结果对话框（带焦点陷阱）
   */
  showResultDialog(won, rewards) {
    const dialog = document.createElement('div');
    ARIAUtils.setRole(dialog, ARIARoles.ALERTDIALOG);
    ARIAUtils.setLabel(dialog, '战斗结果');
    dialog.setAttribute('aria-modal', 'true');
    dialog.className = 'battle-result-dialog';
    
    // 标题
    const title = document.createElement('h2');
    title.textContent = won ? '胜利！' : '失败';
    dialog.appendChild(title);
    
    // 奖励列表
    if (won && rewards.length > 0) {
      const rewardList = document.createElement('ul');
      rewards.forEach(reward => {
        const item = document.createElement('li');
        item.textContent = `${reward.name} x${reward.quantity}`;
        rewardList.appendChild(item);
      });
      dialog.appendChild(rewardList);
    }
    
    // 确认按钮
    const confirmButton = ARIAUtils.createButton('确定', () => {
      this.closeDialog(dialog);
    }, { ariaLabel: '确认战斗结果' });
    dialog.appendChild(confirmButton);
    
    document.body.appendChild(dialog);
    
    // 激活焦点陷阱
    focusManager.saveFocus();
    focusManager.trapFocus(dialog, {
      onEscape: () => this.closeDialog(dialog),
      initialFocus: confirmButton
    });
  }

  /**
   * 关闭对话框
   */
  closeDialog(dialog) {
    focusManager.releaseTrap();
    dialog.remove();
    
    if (this.options.onBattleEnd) {
      this.options.onBattleEnd();
    }
  }

  /**
   * 销毁战斗场景
   */
  destroy() {
    this.battleContainer.remove();
  }
}

/**
 * 快速升级现有战斗场景（无需重写组件）
 */
export function upgradeBattleSceneA11y(battleElement) {
  // 为现有元素添加 ARIA 属性
  
  // 查找血条并添加 ARIA
  const hpBars = battleElement.querySelectorAll('.hp-bar');
  hpBars.forEach((bar, index) => {
    const isEnemy = index === 0;
    ARIAUtils.setRole(bar, ARIARoles.METER);
    ARIAUtils.setLabel(bar, isEnemy ? '敌方生命值' : '我方生命值');
    
    // 假设血量从 data 属性读取
    const current = parseInt(bar.dataset.current || 100);
    const max = parseInt(bar.dataset.max || 100);
    ARIAUtils.setValue(bar, current, 0, max);
  });
  
  // 为技能按钮添加 ARIA
  const moveButtons = battleElement.querySelectorAll('.move-button');
  moveButtons.forEach((button, index) => {
    ARIAUtils.setRole(button, ARIARoles.BUTTON);
    
    // 完整标签
    const moveName = button.textContent;
    const power = button.dataset.power || '未知';
    const pp = button.dataset.pp || '未知';
    ARIAUtils.setLabel(button, `${moveName}，威力 ${power}，剩余 ${pp} 次`);
    
    // 键盘交互
    button.setAttribute('tabindex', '0');
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        button.click();
      }
    });
  });
  
  // 为战斗日志添加 ARIA
  const battleLog = battleElement.querySelector('.battle-log');
  if (battleLog) {
    ARIAUtils.setRole(battleLog, ARIARoles.LOG);
    battleLog.setAttribute('aria-live', 'polite');
    battleLog.setAttribute('aria-relevant', 'additions');
    ARIAUtils.setLabel(battleLog, '战斗日志');
  }
  
  console.log('[A11y] Battle scene upgraded with ARIA support');
}

export default A11yBattleScene;