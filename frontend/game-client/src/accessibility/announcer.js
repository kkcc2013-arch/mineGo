/**
 * A11y Announcer - 屏幕阅读器实时通知系统
 * 提供动态内容变化的语音通知
 */

export class A11yAnnouncer {
  constructor() {
    this.liveRegion = null;
    this.assertiveRegion = null;
    this.init();
  }

  init() {
    // 创建礼貌通知区域（一般状态更新）
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.className = 'sr-only';
    this.liveRegion.id = 'a11y-live-region';
    document.body.appendChild(this.liveRegion);

    // 创建紧急通知区域（重要提醒）
    this.assertiveRegion = document.createElement('div');
    this.assertiveRegion.setAttribute('role', 'alert');
    this.assertiveRegion.setAttribute('aria-live', 'assertive');
    this.assertiveRegion.setAttribute('aria-atomic', 'true');
    this.assertiveRegion.className = 'sr-only';
    this.assertiveRegion.id = 'a11y-alert-region';
    document.body.appendChild(this.assertiveRegion);

    console.log('[A11y] Announcer initialized');
  }

  /**
   * 发送礼貌通知（一般状态更新）
   */
  announce(message) {
    this.liveRegion.textContent = '';
    // 延迟设置，确保屏幕阅读器捕获
    setTimeout(() => {
      this.liveRegion.textContent = message;
    }, 100);
    console.log('[A11y] Announced:', message);
  }

  /**
   * 发送紧急通知（重要提醒）
   */
  alert(message) {
    this.assertiveRegion.textContent = '';
    setTimeout(() => {
      this.assertiveRegion.textContent = message;
    }, 100);
    console.log('[A11y] Alert:', message);
  }

  /**
   * 清除通知
   */
  clear() {
    this.liveRegion.textContent = '';
    this.assertiveRegion.textContent = '';
  }

  /**
   * 游戏事件通知模板
   */
  announcePokemonSpawn(speciesName, distance) {
    this.announce(`附近出现了一只${speciesName}，距离${distance}米`);
  }

  announceCatchSuccess(speciesName, cp) {
    this.announce(`捕捉成功！你获得了一只${speciesName}，CP ${cp}`);
  }

  announceCatchFail(speciesName) {
    this.alert(`${speciesName}逃跑了！`);
  }

  announceItemCollected(itemName, quantity) {
    this.announce(`获得 ${quantity} 个${itemName}`);
  }

  announceLevelUp(newLevel) {
    this.alert(`恭喜升级！你现在是 ${newLevel} 级了`);
  }

  announceGymBattle(won, gymName) {
    if (won) {
      this.announce(`成功占领了 ${gymName} 道馆！`);
    } else {
      this.announce(`在 ${gymName} 道馆战斗失败`);
    }
  }

  announceFriendRequest(username) {
    this.announce(`${username} 向你发送了好友请求`);
  }

  announceTradeComplete(speciesName) {
    this.announce(`交易完成！你收到了${speciesName}`);
  }

  announceLowBattery() {
    this.alert('电量不足，请及时充电');
  }

  announceNetworkError() {
    this.alert('网络连接失败，请检查网络');
  }
}

// 导出单例
export const a11yAnnouncer = new A11yAnnouncer();